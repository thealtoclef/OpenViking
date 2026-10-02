export const TOOL_ADMISSION_MARKER_PREFIX: string;
export const DEFAULT_CONTEXT_WINDOW: number;

export interface AdmissionOptions {
  enabled?: boolean;
  capFraction?: number;
  minTokens?: number;
  maxTokens?: number;
}

export interface AdmittedText {
  text: string;
  projected: boolean;
}

/** The slice of a host context admission budgets against. */
export interface ContextWindowSource {
  getContextUsage?: () => { contextWindow?: unknown } | undefined;
  model?: { contextWindow?: unknown } | undefined;
}

export function estimateTokens(text: unknown): number;
export function admissionOptions(options?: AdmissionOptions): {
  capFraction: number;
  minTokens: number;
  maxTokens: number;
};
export function resolveToolResultAdmissionCapTokens(
  contextWindow: unknown,
  options?: AdmissionOptions,
): number;
export function admitToolResultWithinBudget(text: unknown, budgetTokens: number): AdmittedText;
export function admitToolResult(
  text: unknown,
  contextWindow: unknown,
  options?: AdmissionOptions,
): AdmittedText;
export function admitContextToolResults<T>(
  messages: T[],
  contextWindow: unknown,
  options?: AdmissionOptions,
): T[];
export function resolveContextWindow(ctx: ContextWindowSource | undefined): number;
