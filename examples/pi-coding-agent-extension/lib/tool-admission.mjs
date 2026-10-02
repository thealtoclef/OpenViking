/**
 * Admission cap for tool results in the provider-facing context.
 *
 * Takeover bounds history by *user turns* (`takeover.keepRecentTurns`), not by
 * tokens, so the retained tail is unbounded: three turns carrying a large
 * `bash`/`read` result still blow the window even though the archived span was
 * replaced by a 3k-token overview. Oversized tool output is the dominant driver
 * of those single-step bursts, so it is projected to a deterministic head/tail
 * excerpt at the entrance to the `context` hook, before takeover runs.
 *
 * The projection is derived from the supplied text on every request and never
 * from the marker it writes, so re-admitting an already-projected result under
 * a smaller window stays correct and idempotent.
 *
 * Only `toolResult` messages are rewritten, and only by constructing new
 * objects; user and assistant messages keep object identity so the `context`
 * hook's entry-id WeakMap and the recall ledger still resolve.
 *
 * Ported from senpi (`core/extensions/builtin/compaction/tool-admission.ts` and
 * the `admitContextToolResults` walker in `orchestration.ts`), MIT © 2025 Mario
 * Zechner / © 2026 Yeongyu Kim and senpi contributors. Adapted to this
 * extension's own token estimator and message shapes.
 */
import { estimateTokens } from "./takeover-core.mjs";

export { estimateTokens };

export const TOOL_ADMISSION_MARKER_PREFIX = "[tool result projected:";

/** Used when neither context usage nor the model reports a window. */
export const DEFAULT_CONTEXT_WINDOW = 200000;

const DEFAULT_CAP_FRACTION = 0.05;
const DEFAULT_MIN_CAP_TOKENS = 8192;
const DEFAULT_MAX_CAP_TOKENS = 50000;
const HEAD_BUDGET_FRACTION = 0.6;
const TAIL_BUDGET_FRACTION = 0.2;
const SHRINK_FACTOR = 0.8;

function numberOr(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

/** Normalize the caller's knobs; a config file may carry anything. */
export function admissionOptions(options = {}) {
  const minTokens = Math.max(1, Math.floor(numberOr(options.minTokens, DEFAULT_MIN_CAP_TOKENS)));
  const maxTokens = Math.max(minTokens, Math.floor(numberOr(options.maxTokens, DEFAULT_MAX_CAP_TOKENS)));
  return {
    capFraction: Math.max(0, numberOr(options.capFraction, DEFAULT_CAP_FRACTION)),
    minTokens,
    maxTokens,
  };
}

/** Token budget a single tool result may occupy before it is projected. */
export function resolveToolResultAdmissionCapTokens(contextWindow, options = {}) {
  const { capFraction, minTokens, maxTokens } = admissionOptions(options);
  const window = Math.max(0, numberOr(contextWindow, DEFAULT_CONTEXT_WINDOW));
  return Math.min(maxTokens, Math.max(minTokens, Math.floor(capFraction * window)));
}

function buildExcerpt(text, budgetChars, totalTokens) {
  const headChars = Math.floor(budgetChars * HEAD_BUDGET_FRACTION);
  const tailChars = Math.floor(budgetChars * TAIL_BUDGET_FRACTION);
  const head = text.slice(0, headChars);
  const tail = text.slice(Math.max(headChars, text.length - tailChars));
  const keptTokens = estimateTokens(head) + estimateTokens(tail);
  return `${head}\n${TOOL_ADMISSION_MARKER_PREFIX} kept ${keptTokens} of ~${totalTokens} tokens]\n${tail}`;
}

/**
 * Cap one string at `budgetTokens`. Under-budget text passes through
 * untouched; over-budget text becomes a deterministic head/tail projection.
 */
export function admitToolResultWithinBudget(text, budgetTokens) {
  const value = String(text || "");
  const totalTokens = estimateTokens(value);
  if (totalTokens <= budgetTokens) return { text: value, projected: false };
  if (budgetTokens <= 0) return { text: "", projected: true };

  const charsPerToken = value.length / Math.max(1, totalTokens);
  let budgetChars = Math.floor(budgetTokens * charsPerToken);
  let excerpt = buildExcerpt(value, budgetChars, totalTokens);
  // The marker itself costs tokens, so a first pass sized purely from the
  // char/token ratio can still overshoot; shrink until it fits.
  while (estimateTokens(excerpt) > budgetTokens && budgetChars > 0) {
    budgetChars = Math.floor(budgetChars * SHRINK_FACTOR);
    excerpt = buildExcerpt(value, budgetChars, totalTokens);
  }

  return estimateTokens(excerpt) <= budgetTokens
    ? { text: excerpt, projected: true }
    : { text: "", projected: true };
}

/** Cap one string against the window-derived admission cap. */
export function admitToolResult(text, contextWindow, options = {}) {
  return admitToolResultWithinBudget(text, resolveToolResultAdmissionCapTokens(contextWindow, options));
}

function isToolResult(message) {
  return !!message && typeof message === "object" && message.role === "toolResult";
}

function admitStringContent(message, contextWindow, options) {
  const admitted = admitToolResult(message.content, contextWindow, options);
  if (!admitted.projected) return message;
  return { ...message, content: [{ type: "text", text: admitted.text }] };
}

function admitPartsContent(message, contextWindow, options) {
  const parts = message.content;
  const capTokens = resolveToolResultAdmissionCapTokens(contextWindow, options);
  const partTokens = parts.map((part) => (part?.type === "text" ? estimateTokens(part.text) : 0));
  const totalTextTokens = partTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (totalTextTokens <= capTokens) return message;

  // Parts that individually fit are kept verbatim when their combined size
  // still fits the cap; the oversized ones then share what is left. If even the
  // small parts overflow together, everything is re-budgeted from scratch.
  const preservedTokens = partTokens.reduce((sum, tokens) => sum + (tokens <= capTokens ? tokens : 0), 0);
  const preserveUnderCap = preservedTokens <= capTokens;
  let remainingBudget = preserveUnderCap ? capTokens - preservedTokens : capTokens;
  let remainingOversizedTokens = preserveUnderCap
    ? partTokens.reduce((sum, tokens) => sum + (tokens > capTokens ? tokens : 0), 0)
    : totalTextTokens;

  let projected = false;
  const content = parts.map((part, index) => {
    // Image parts carry no text budget and are never rewritten.
    if (part?.type !== "text") return part;
    const tokens = partTokens[index] ?? 0;
    if (preserveUnderCap && tokens <= capTokens) return part;
    const budget = Math.floor((remainingBudget * tokens) / Math.max(1, remainingOversizedTokens));
    const admitted = admitToolResultWithinBudget(part.text, budget);
    remainingOversizedTokens -= tokens;
    remainingBudget -= estimateTokens(admitted.text);
    if (!admitted.projected) return part;
    projected = true;
    return { ...part, text: admitted.text };
  });

  return projected ? { ...message, content } : message;
}

/**
 * Project oversized tool results across a provider-facing message list.
 *
 * Returns the input array unchanged when nothing was projected, so a disabled
 * or under-cap turn costs one pass and no allocation.
 */
export function admitContextToolResults(messages, contextWindow, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (options.enabled === false) return list;

  let changed = false;
  const admitted = list.map((message) => {
    if (!isToolResult(message)) return message;
    const next =
      typeof message.content === "string"
        ? admitStringContent(message, contextWindow, options)
        : Array.isArray(message.content)
          ? admitPartsContent(message, contextWindow, options)
          : message;
    if (next !== message) changed = true;
    return next;
  });

  return changed ? admitted : list;
}

/** Resolve the window admission should budget against, from a host context. */
export function resolveContextWindow(ctx) {
  const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const fromUsage = Number(usage?.contextWindow);
  if (Number.isFinite(fromUsage) && fromUsage > 0) return fromUsage;
  const fromModel = Number(ctx?.model?.contextWindow);
  if (Number.isFinite(fromModel) && fromModel > 0) return fromModel;
  return DEFAULT_CONTEXT_WINDOW;
}
