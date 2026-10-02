/**
 * The client's own default request timeout, mirrored here so a capped request
 * lands on the same value the shared recall layer would get by leaving it
 * unset (`createOvHttp` passes `defaultTimeoutMs: 10000`).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/**
 * Cap a recall request's timeout without dropping the rest of its options.
 *
 * The shared recall layer hands this wrapper `{ timeoutMs, actorPeerId }`. A
 * wrapper that forwarded `timeoutMs` as a bare number discarded the actor
 * peer, so the legacy-peer retry searched the wrong space — the bug this
 * replaces. Spread the options and override only the timeout.
 *
 * `maxTimeoutMs === undefined` leaves the request untouched, so pi's behavior
 * is exactly what the client would have done on its own.
 */
export function capRecallTimeout(options, maxTimeoutMs) {
  if (maxTimeoutMs === undefined) return options;
  const requested = Number(options?.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
  return { ...options, timeoutMs: Math.min(requested, maxTimeoutMs) };
}
