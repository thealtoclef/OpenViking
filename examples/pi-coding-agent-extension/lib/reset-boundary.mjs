/**
 * `/clear` detection for hosts that reset the conversation in place.
 *
 * `/clear` keeps the session (same id, same transcript file) and appends a
 * `reset_boundary` marker entry, dropping the conversation before it. No
 * extension lifecycle event fires for it, so the only signal available to an
 * extension is the marker itself. Without this the memory layer keeps one
 * session across the clear: the boundary it froze points at entries the context
 * no longer contains, so trimming silently stops and the new conversation is
 * captured into the old one's memory stream.
 */
export const RESET_BOUNDARY_ENTRY_TYPE = "reset_boundary";

/**
 * The newest `/clear` marker: its entry id and its index in the branch.
 *
 * The index matters as much as the id. Capture and takeover watermark the
 * branch by position, and everything before the marker belongs to the
 * conversation the clear dropped — re-capturing it into the session that
 * follows extracts the same memories a second time. The id is what survives
 * restarts and branch navigation, so it is what a caller remembers between
 * turns.
 */
export function latestResetBoundary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry?.type === RESET_BOUNDARY_ENTRY_TYPE && typeof entry.id === "string" && entry.id) {
      return { id: entry.id, index: i };
    }
  }
  return { id: null, index: -1 };
}

/**
 * Whether a branch carries a `/clear` this instance has not handled yet.
 *
 * `lastSeenId` is `undefined` before the instance has looked at the branch at
 * all. That first look only records the marker: the session was just started
 * against whatever the branch already contained (including a clear that
 * happened before the extension loaded), so acting on it would restart a
 * healthy session. Every later look reports a genuinely new marker.
 */
export function resetBoundaryChanged(lastSeenId, entries) {
  const boundary = latestResetBoundary(entries);
  if (lastSeenId === undefined) return { ...boundary, changed: false };
  return { ...boundary, changed: boundary.id !== null && boundary.id !== lastSeenId };
}
