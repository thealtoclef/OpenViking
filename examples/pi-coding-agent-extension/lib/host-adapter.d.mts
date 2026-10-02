export function hasContextProjection(sessionManager: { buildContextEntries?: unknown } | undefined): boolean;
export function isOmpHost(ctx: { sessionManager?: { buildContextEntries?: unknown } } | undefined): boolean;
export function isSubagent(ctx: { agent?: { kind?: string } } | undefined): boolean;
