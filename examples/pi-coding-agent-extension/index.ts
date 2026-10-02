/**
 * Pi OpenViking Extension
 *
 * Integrates pi with an OpenViking context database for persistent,
 * cross-session memory. Syncs conversation turns to OV, recalls
 * relevant memories on each prompt, and commits sessions for long-term
 * memory extraction.
 *
 * Design informed by: OpenClaw (synchronous recall), Claude Code plugin
 * (most mature, production-hardened), Hermes (anti-pattern: stale prefetch).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCaptureEnabled } from "./shared/capture-utils.mjs";
import { createLogger } from "./shared/debug-log.mjs";
import { EXTENSION_VERSION, loadConfig, buildBridgeProxyConfig, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { RecallManager } from "./recall.js";
import { RecallLedger } from "./lib/recall-ledger.mjs";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { isBypassed } from "./shared/session-model.mjs";
import { guardVikingUriToolCall, noticeVikingUriToolResult } from "./lib/uri-guard-adapter.mjs";
import { appendSystemPrompt } from "./lib/system-prompt.mjs";
import { resolveContextMessageIds } from "./lib/context-message-ids.mjs";
import { isOmpHost } from "./lib/host-adapter.mjs";
import { resetBoundaryChanged } from "./lib/reset-boundary.mjs";
import { admitContextToolResults, resolveContextWindow } from "./lib/tool-admission.mjs";
import type { TakeoverMessage } from "./lib/takeover-core.mjs";
import { createMcpBridge, DEFAULT_HANDSHAKE_BUDGET_MS } from "./lib/mcp-bridge.mjs";
import { registerMcpTools } from "./tools.js";
import { createTakeoverManager } from "./takeover.js";
import { HANDLER_BUDGET_MS, describeSkip } from "./lib/takeover-core.mjs";

/** This extension's directory, published for the experimental fork's probe. */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Recall budget under a host with a context-handler watchdog (omp kills at 30s).
 * Leaves 5s of headroom so a slow search fails open rather than being killed
 * mid-flight and taking the turn with it.
 */
const OMP_CONTEXT_DEADLINE_MS = 25000;

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  if (!config.enabled) return;
  // Shared key (`shared/config-schema.mjs`), already honoured by opencode: the
  // MCP tool surface is off, while recall, sync and takeover carry on.
  const mcpEnabled = (config as any).mcpEnabled !== false;

  // Installed as an extension rather than a package, so pi does not scan
  // skills/ on its own. The skills teach the MCP tools, so they follow them.
  if (mcpEnabled) {
    pi.on("resources_discover", async () => ({ skillPaths: [join(EXTENSION_DIR, "skills")] }));
  }

  // Env overrides

  // --- Initialize modules ---
  const client = new OVClient(config);
  const sync = new SyncManager(client, config);
  const recall = new RecallManager(
    client,
    config,
    () => sync.sessionId,
    // The ledger keeps request prefixes byte-stable for provider prompt
    // caches (#4137); it is per pi session and opened once the id is known.
    config.recallLedger ? new RecallLedger() : null,
  );
  const logger = createLogger("pi", {
    debug: Boolean(config.debugLogPath),
    debugLogPath: config.debugLogPath,
  });
  const takeover = createTakeoverManager({
    pi, client, sync, config,
    log: (message: string) => logger.log("takeover", message),
  });

  // Re-read credentials before connecting or invoking a tool.
  const bridge = mcpEnabled
    ? createMcpBridge({
      readConfig: () => buildBridgeProxyConfig(loadConfig(cwd)),
      // No "memory" in the name: every plugin identity is moving to plain
      // `openviking`, and a new identifier starts out on the new spelling.
      clientInfo: { name: "openviking-pi", version: EXTENSION_VERSION },
    })
    : null;

  // Session state
  let connected = false;
  let bypassed = false;
  let profileBlock = "";
  let archiveOverview = "";
  let toolsReady = false;
  let toolsRegistered = false;
  let closed = false;
  const marker = { dir: EXTENSION_DIR };
  const toolNames: string[] = [];
  let toolFailureNotified = false;
  let compacted = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  /** Host session this instance's state belongs to; null before the first start. */
  let sessionOwnerId: string | null = null;
  /** The newest `/clear` marker this instance has handled; undefined until first observed. */
  let seenResetBoundaryId: string | null | undefined;
  /** Session-id suffix for the post-`/clear` conversation, until the next switch. */
  let clearGeneration = "";

  /**
   * Drop the conversation this instance was tracking.
   *
   * Order matters: the sync watermark first, because takeover's persisted state
   * reads the live watermark when it writes the reset, and a stale watermark
   * would be restored onto the new conversation.
   */
  const resetSessionState = (reason: string): void => {
    started = false;
    startPromise = null;
    profileBlock = "";
    archiveOverview = "";
    compacted = false;
    sync.reset();
    recall.reset();
    takeover.resetSession(reason);
    sessionOwnerId = null;
    // A new conversation has not been observed yet, so its first look at the
    // branch records rather than acts.
    seenResetBoundaryId = undefined;
    clearGeneration = "";
  };

  /**
   * Commit whatever the conversation being left behind had synced but not
   * committed. Every completed turn was already synced by `turn_end`, so this
   * only covers the tail; a failure is logged and never blocks the switch.
   */
  const flushCurrent = async (ctx: unknown): Promise<void> => {
    if (!connected || bypassed) return;
    try {
      await sync.commitIfNeeded();
      if (config.takeoverEnabled) await takeover.shutdown();
    } catch (error) {
      logger.logError("session_flush", error);
    }
  };

  /**
   * Take a finished handshake: register what the server listed, or report the
   * failure once.
   *
   * The tool list is never refreshed later in the session. pi has no
   * `unregisterTool`, and adding or removing a tool mid-session rewrites the
   * system prompt's tool section, which invalidates the provider's cached
   * prefix. A server that gained or lost a tool takes effect in the next pi
   * session.
   */
  const adoptBridgeTools = (
    ctx: any,
    state: { connected: boolean; error: string | null },
  ): void => {
    if (!bridge || closed || toolsRegistered) return;
    if (state.connected) {
      toolNames.push(...registerMcpTools(pi, bridge));
      toolsRegistered = true;
      toolsReady = toolNames.length > 0;
      logger.log("mcp_tools", { registered: toolNames.length });
      return;
    }
    // A dead, unauthorized or MCP-less server costs the session its tools and
    // nothing else, so it is said once and not repeated every turn.
    if (toolFailureNotified) return;
    toolFailureNotified = true;
    if (config.logLevel === "silent") return;
    ctx?.ui?.notify?.(
      `OpenViking: no tools this session — ${state.error || "handshake failed"}${rootKeyHint(state.error)}`,
      "warning",
    );
  };

  /** The `/viking` line about the tool surface: a count, or the last failure. */
  const toolsStatusLine = (): string => {
    if (!bridge) return "tools: disabled by mcpEnabled";
    if (toolNames.length) return `tools: ${toolNames.length}`;
    const error = bridge.state.error;
    if (!error) return "tools: none (handshake not finished)";
    return `tools: none — ${error}${rootKeyHint(error)}`;
  };

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started || closed) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      // Bypass check
      if (isBypassed(config, { cwd: process.cwd() })) {
        bypassed = true;
        started = true;
        return;
      }

      // Health check
      connected = await client.health();
      if (closed) return;
      if (!connected) {
        if (config.logLevel === "info") {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        return;
      }

      // What the experimental fork probes to stand down. Set as soon as the
      // session is live, independently of any tool: a /mcp 401/403 leaves this
      // extension with zero tools while it still writes the OpenViking session,
      // and that is exactly the case the fork must not join.
      (globalThis as any).__OPENVIKING_PI_EXTENSION__ = marker;

      // Discover tools alongside REST startup; failure leaves REST available.
      const handshake = bridge ? bridge.connect(DEFAULT_HANDSHAKE_BUDGET_MS) : null;

      // Ensure OV session
      const piSessionId = ctx.sessionManager.getSessionId();
      const ok = await sync.ensureSession(piSessionId, clearGeneration);
      if (!ok) {
        if (config.logLevel !== "silent") {
          ctx.ui.notify("OpenViking: failed to create session", "error");
        }
        return;
      }
      // Keyed by the OpenViking session id, so a `/clear` gets its own ledger
      // along with its own memory stream: replaying the dropped conversation's
      // injected blocks onto the new one would push the provider prefix apart.
      recall.openLedger(sync.sessionId ?? piSessionId);

      // Restore takeover state — sync watermark, pending archive and capture
      // gap — before replaying any queued messages, so recovery and replay
      // cannot disagree about what has been delivered (plan §4).
      //
      // A `/clear` is the exception: its conversation was just reset, and the
      // newest entry the branch still holds is the reset we persisted. Reading
      // it back can race the append, so the fresh state is authoritative and
      // restore is skipped rather than re-read.
      const branch = typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
      if (config.takeoverEnabled && !clearGeneration) {
        takeover.restore(branch);
        sync.restoreWatermark(takeover.state.syncedEntryCount);
      }

      await sync.replayPending();
      if (config.takeoverEnabled && sync.droppedCount > 0) {
        takeover.recordCaptureGap();
      }

      // Profile injection
      profileBlock = await buildSessionProfileBlock(client, config);

      if (!config.takeoverEnabled && config.resumeArchiveInject && sync.sessionId) {
        // Resume rehydration — fetch archive overview if session was previously committed.
        archiveOverview = await fetchArchiveOverview(client, sync.sessionId, config);
      }

      // Join the handshake and publish whatever the server listed (also needed
      // for pi -c continuations, which never fire session_start).
      if (handshake) adoptBridgeTools(ctx, await handshake);
      if (closed) return;
      updateStatus(ctx, connected, 0, sync.sessionId, config, takeover.state, toolsReady);

      started = true;
      sessionOwnerId = piSessionId;
      if (config.logLevel === "info") {
        ctx.ui.notify(`OpenViking connected (${piSessionId.slice(0, 8)}...)`, "info");
      }
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  };

  // --- session_before_switch ---
  //
  // omp emits this before it moves to another conversation, while the current
  // one is still intact — the only chance to commit it. pi does not emit it at
  // all (it tears the runtime down and re-emits session_start instead), so this
  // is a no-op there. Never fatal: a failed commit must not block the switch.
  pi.on("session_before_switch", async (_event, ctx) => {
    await flushCurrent(ctx);
  });

  // --- session_switch ---
  //
  // omp emits this after the switch, on the same extension runner, with the
  // SessionManager already mutated in place to the new conversation. Without
  // this the new conversation is captured into the old OpenViking session and
  // the dropped one's boundary, watermark and ledger leak into it. pi has no
  // such event; its path is the session_start safety net below.
  pi.on("session_switch", async (_event, ctx) => {
    resetSessionState("switch");
    await start(ctx);
  });

  // --- session_start ---
  pi.on("session_start", async (event, ctx) => {
    // A host that rebuilds its runtime per conversation re-emits this event
    // instead of session_switch. A changed id means the state in flight belongs
    // to a conversation that is no longer current, so drop it before starting.
    const sessionId = String(ctx?.sessionManager?.getSessionId?.() ?? "");
    if (sessionOwnerId && sessionId && sessionOwnerId !== sessionId) {
      resetSessionState("session_start");
    }

    // Fire-and-forget: the OV chain (health check, session ensure, profile
    // build) costs ~2s against the remote server; blocking session_start on it
    // delays every pi startup. start() is memoized via startPromise, so
    // before_agent_start awaits the same in-flight chain before the first
    // provider request — the first turn still gets profile + recall.
    void start(ctx).catch((error) => {
      logger.logError("session_start", error);
    });
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (event, ctx) => {
    const deadline = Date.now() + HANDLER_BUDGET_MS;
    // Read before awaiting, because this is what separates the retry below
    // from the attempt start() makes: on the turn that runs the startup chain
    // this is false, and from the next turn on it is true. Testing `started`
    // after the await would be true on turn one as well, and the retry would
    // fire a second handshake in the same turn — a real one, since the bridge
    // clears its in-flight promise as soon as a failed attempt settles. That
    // costs the first turn a second handshake budget before recall is even
    // queued, for an answer start() already has.
    const wasStarted = started;

    // `/clear` keeps the session (same id, same transcript) and appends a reset
    // marker; no lifecycle event fires for it. Without this the boundary points
    // at entries the context no longer holds, so takeover silently stops
    // trimming, and the cleared conversation is captured into the session it
    // just dropped.
    const branch = typeof ctx.sessionManager.getBranch === "function"
      ? ctx.sessionManager.getBranch()
      : [];
    const boundary = resetBoundaryChanged(seenResetBoundaryId, branch);
    if (boundary.changed) {
      await flushCurrent(ctx);
      resetSessionState("clear");
      clearGeneration = boundary.id;
    }
    seenResetBoundaryId = boundary.id;

    // session_start doesn't fire for pi -c continuations.
    await start(ctx);

    // Retry the handshake when the session is live but toolless — a server
    // started after pi, or a credential fixed mid-session. `bridge` is null
    // exactly when `mcpEnabled` is false, and a bypassed directory or a failed
    // health check never gets here: bypass means this directory does not touch
    // OpenViking at all. `connect()` re-handshakes only after a failure; after
    // a success it hands back the state it already has.
    if (bridge && wasStarted && connected && !bypassed && !closed && !toolsRegistered) {
      adoptBridgeTools(ctx, await bridge.connect(DEFAULT_HANDSHAKE_BUDGET_MS));
      updateStatus(ctx, connected, 0, sync.sessionId, config, takeover.state, toolsReady);
    }

    if (!connected || bypassed || closed) return;

    // A summary that finished since the last turn — or in the last `pi -p`
    // process — trims this prompt's request already.
    if (config.takeoverEnabled) {
      await takeover.resumePending(() => ctx.sessionManager.getBranch(), { deadline });
    }

    // Queue recall for the context hook. Pi renders the user message before
    // that hook, so recall latency does not delay the message appearing.
    recall.queueSearch(event.prompt);

    // Compose system prompt additions
    const parts: string[] = [];
    if (profileBlock) parts.push(profileBlock);
    if (!config.takeoverEnabled && config.resumeArchiveInject && archiveOverview && (compacted || archiveOverview.trim())) {
      parts.push(archiveOverview);
    }
    // Generated from what actually registered, so it can never name a tool the
    // server does not have. Omitted entirely when the handshake produced none,
    // which keeps the prefix free of a promise nothing can keep.
    if (toolNames.length) {
      parts.push(`OpenViking tools (use these for viking:// URIs): ${toolNames.join(", ")}.`);
    }

    const additions = parts.join("\n\n");
    if (!additions) return;

    return {
      systemPrompt: appendSystemPrompt(event.systemPrompt, additions),
    };
  });

  // --- context ---
  pi.on("context", async (event, ctx) => {
    if (!connected || bypassed) return;

    // Keep recall synchronous with the provider request so the current prompt
    // still receives current-query memory, without blocking user-message UI.
    // omp kills a context handler at 30s, so its recall gets a shorter budget
    // and fails open before the watchdog instead of taking the turn with it.
    await recall.searchPending(isOmpHost(ctx) ? OMP_CONTEXT_DEADLINE_MS : undefined);

    // Takeover bounds history by user turns, not tokens, so one oversized tool
    // result inside the retained tail can still overflow the window even
    // though the archived span was replaced by an overview. Project those
    // results first; only toolResult messages are rewritten, so the identity
    // mapping below is unaffected.
    const admitted = admitContextToolResults(event.messages, resolveContextWindow(ctx), {
      enabled: config.toolAdmissionEnabled,
      capFraction: config.toolAdmissionCapFraction,
      minTokens: config.toolAdmissionMinTokens,
      maxTokens: config.toolAdmissionMaxTokens,
    });

    // The entry IDs let the recall ledger replay an injected block onto the
    // historical message it was sent with, keeping the provider prompt-prefix
    // cache stable. The mapping differs per host (projected context on pi, raw
    // branch on omp), so it lives in one helper.
    const sessionManager = ctx.sessionManager;
    const messageIds = resolveContextMessageIds(admitted, sessionManager);

    // Takeover's boundary is a branch entry id; it maps it onto these messages
    // through pi's context projection of the branch.
    const afterTakeover = config.takeoverEnabled
      ? takeover.transformContext(
          asTakeoverMessages(admitted),
          typeof sessionManager?.getBranch === "function" ? sessionManager.getBranch() : [],
        )
      : admitted;
    const messages = recall.injectRecall(
      afterTakeover,
      (message) => messageIds.get(message) ?? null,
    );
    return { messages };
  });

  // --- tool_call ---
  pi.on("tool_call", async (event, _ctx) => {
    const decision = guardVikingUriToolCall(event);
    if (!decision) return;
    return decision;
  });

  // --- tool_result ---
  pi.on("tool_result", async (event, _ctx) => {
    const notice = noticeVikingUriToolResult(event);
    if (!notice) return;
    return notice;
  });

  // --- turn_end ---
  pi.on("turn_end", async (event, ctx) => {
    if (!connected || bypassed || !isCaptureEnabled(config)) return;

    // The host's 30s cap covers this whole handler, sync included.
    const deadline = Date.now() + HANDLER_BUDGET_MS;
    const branch = ctx.sessionManager.getBranch();
    const result = await sync.syncBranch(branch);
    logger.log("turn_end", { added: result.added, tokens: result.tokens });
    if (result.permanentFailures > 0) takeover.recordCaptureGap();
    // The branch is what the boundary is frozen against and re-confirmed on, so
    // takeover needs it, not just the token delta.
    await takeover.onTurnSynced(result.tokens, () => ctx.sessionManager.getBranch(), { deadline });
    updateStatus(ctx, connected, result.added, sync.sessionId, config, takeover.state, toolsReady);
  });

  // --- session_before_compact ---
  pi.on("session_before_compact", async (event, ctx) => {
    if (!connected || bypassed) return;

    if (config.takeoverEnabled) {
      const deadline = Date.now() + HANDLER_BUDGET_MS;
      const prep = (event as any)?.preparation ?? {};
      // Native compaction syncs the latest branch, archives all captured
      // history and reuses pi's own firstKeptEntryId, so hand it the branch.
      return await takeover.handleBeforeCompact({
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore ?? 0,
        signal: (event as any)?.signal,
      }, () => ctx.sessionManager.getBranch(), { deadline });
    }

    const archiveId = await sync.commit();
    compacted = true;

    // Cache archive overview for rehydration after compaction
    if (config.resumeArchiveInject && archiveId && sync.sessionId) {
      archiveOverview = await fetchArchiveOverview(
        client, sync.sessionId, config,
      );
    }
    // Return nothing → pi proceeds with default compaction
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    closed = true;
    if ((globalThis as any).__OPENVIKING_PI_EXTENSION__ === marker) {
      delete (globalThis as any).__OPENVIKING_PI_EXTENSION__;
    }
    // Release MCP requests without preventing the final REST commit.
    if (bridge) {
      try {
        await bridge.close();
      } catch (error) {
        logger.logError("session_shutdown", error);
      }
    }

    if (!connected || bypassed) return;

    await sync.shutdown();
    if (config.takeoverEnabled) {
      await takeover.shutdown();
    } else {
      await sync.commit();
    }
  });

  // --- agent_end ---
  pi.on("agent_end", async (_event, _ctx) => {
    recall.invalidate();
  });

  // ================================================================
  // Commands
  // ================================================================

  pi.registerCommand("viking", {
    description: "OpenViking status and manual operations. Use 'commit' to force a sync.",
    handler: async (args, ctx) => {
      // A host can install the extension into a session that is already
      // running, so `session_start` was delivered before this extension
      // existed and will not arrive again. Starting here is what makes
      // `/viking` usable on that install instead of reporting "not connected"
      // until the next session. start() is memoized, so a normal session pays
      // nothing for it.
      await start(ctx);
      if (!connected) {
        ctx.ui.notify("OpenViking: not connected", "warning");
        return;
      }

      if (args?.trim() === "commit") {
        await sync.shutdown();
        const commitResult = config.takeoverEnabled ? null : await sync.commit();
        // Manual commit freezes and confirms the boundary against the current
        // branch, exactly like the automatic path.
        // A `skipped` result archived nothing; it is not a successful commit.
        const skipped = commitResult?.status === "skipped";
        const ok = config.takeoverEnabled
          ? await takeover.commitAndAdvance(() => ctx.sessionManager.getBranch())
          : commitResult !== null && !skipped;
        if (!ok && config.takeoverEnabled && takeover.state.pendingArchive) {
          ctx.ui.notify(
            "OpenViking: committed; the context is trimmed once the archive summary is ready",
            "info",
          );
        } else if (ok) {
          ctx.ui.notify(
            "OpenViking: committed successfully" +
              (commitResult?.trace_id ? ` (trace_id=${commitResult.trace_id})` : ""),
            "info",
          );
        } else {
          // Say why: a bare "commit failed" left users with nothing to act on.
          const reason = config.takeoverEnabled
            ? takeover.lastFailure
            : skipped
              ? describeSkip(String(commitResult?.reason || ""))
              : sync.lastCommitError;
          logger.log("commit", { ok: false, manual: true, reason: reason || "unknown" });
          if (reason.startsWith("nothing")) {
            // Not an error: the server already holds this history.
            ctx.ui.notify(`OpenViking: ${reason}`, "warning");
          } else {
            ctx.ui.notify(`OpenViking: commit failed${reason ? ` — ${reason}` : ""}`, "error");
          }
        }
        return;
      }

      // Status
      const sid = sync.sessionId ?? "none";
      const t = takeover.state;
      const takeoverInfo = config.takeoverEnabled
        ? ` | takeover: ${t.coveredUserTurns}/${t.lastSeenUserTurns} turns archived, ~${t.pendingTokens} tokens pending`
        : "";
      ctx.ui.notify(
        `OpenViking: ${connected ? "connected" : "disconnected"} | session: ${sid.slice(0, 12)}...`
          + `${takeoverInfo} | ${toolsStatusLine()}`,
        "info",
      );
    },
  });
}

// ================================================================
// Helper Functions
// ================================================================

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path, init, options) => client.fetchJSON(path, init, options),
      config.profileTokenBudget,
      config.peerId,
      config,
    );
    if (!profile?.block) return "";
    return [
      '<openviking-context source="session-start">',
      profile.block,
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

/** Fetch archive overview for rehydration using the session context API. */
async function fetchArchiveOverview(
  client: OVClient, sessionId: string, config: OVConfig,
): Promise<string> {
  try {
    const ctx = await client.getSessionContext(sessionId, config.resumeContextBudget);
    if (!ctx || !ctx.latest_archive_overview) return "";

    return [
      '<openviking-context source="session-archive">',
      "<session-archive>",
      ctx.latest_archive_overview,
      "</session-archive>",
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * The extra line for a failed handshake that a root key explains.
 *
 * A root key authenticates fine and is then refused on `/mcp`, so the HTTP
 * status is the only clue, and without this the operator sees a 403 with no
 * way to act on it.
 */
function rootKeyHint(error: string | null): string {
  return error && /\b403\b/.test(error)
    ? "\nA root key cannot reach /mcp — use a user or admin key."
    : "";
}

function updateStatus(
  ctx: any,
  connected: boolean,
  added: number,
  sessionId: string | null,
  config: OVConfig,
  takeoverState?: { pendingTokens?: number; coveredUserTurns?: number },
  toolsReady?: boolean,
): void {
  const setter = ctx?.ui?.setStatus;
  if (typeof setter !== "function") return;
  const threshold = config.takeoverEnabled
    ? config.takeoverTokenThreshold
    : config.commitTokenThreshold;
  const pending = config.takeoverEnabled && takeoverState
    ? ` · ctx ${takeoverState.coveredUserTurns ?? 0} · ~${takeoverState.pendingTokens ?? 0}/${threshold}`
    : ` · ✎ ${threshold}`;
  // Only worth a segment when tools were expected and are missing: `OV ✓` with
  // no tools is a working session whose OpenViking tools failed, and
  // `mcpEnabled: false` asked for that and is not a fault.
  const tools = connected && (config as any).mcpEnabled !== false && !toolsReady
    ? " · tools ✗"
    : "";
  const status = `${connected ? "OV ✓" : "OV ✗"}${tools} · ↩${added}${pending} · ${sessionId ? sessionId.slice(0, 12) : "none"}`;
  try {
    setter("openviking", status);
  } catch {
    // Best effort; pi API shape may vary across fast-moving versions.
  }
}

/**
 * The host's context messages in the loose shape the takeover transform takes.
 *
 * `TakeoverCore` predates the host typings and consumes a structural
 * `TakeoverMessage`; the host's own array is passed through, never copied, so
 * message identity (and the recall ledger's WeakMap) survives the boundary.
 */
function asTakeoverMessages(messages: readonly object[]): TakeoverMessage[] {
  return messages as TakeoverMessage[];
}
