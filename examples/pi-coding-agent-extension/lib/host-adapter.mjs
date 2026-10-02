/**
 * Host capabilities this extension adapts to.
 *
 * `buildContextEntries()` is pi's projected context: the context hook's
 * message list in persisted-entry form. omp exposes only `getBranch()`.
 *
 * The probe is a capability check on purpose. It stays correct for any host
 * that grows or drops the API, instead of matching on a product name.
 */
export function hasContextProjection(sessionManager) {
  return typeof sessionManager?.buildContextEntries === "function";
}

/** True when the host lacks pi's context projection (omp today). */
export function isOmpHost(ctx) {
  return !hasContextProjection(ctx?.sessionManager);
}
