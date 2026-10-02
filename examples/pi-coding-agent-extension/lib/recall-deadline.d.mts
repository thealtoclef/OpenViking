export function capRecallTimeout(
  options: { timeoutMs?: number; actorPeerId?: string } | undefined,
  maxTimeoutMs: number | undefined,
): { timeoutMs?: number; actorPeerId?: string } | undefined;
