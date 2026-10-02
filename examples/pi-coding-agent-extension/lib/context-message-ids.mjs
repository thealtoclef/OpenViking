function readUserMessage(value) {
  if (!value || typeof value !== "object" || value.role !== "user" || !("content" in value)) return null;
  return value;
}

function messageKey(message) {
  let content;
  try {
    content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  } catch {
    content = String(message.content);
  }
  return `${typeof message.timestamp === "number" ? message.timestamp : ""}:${content}`;
}

function userEntryIds(entries) {
  return entries
    .filter((entry) => entry?.type === "message" && readUserMessage(entry.message))
    .map((entry) => entry.id)
    .filter((id) => typeof id === "string");
}

/**
 * Associates context-hook user-message objects with persisted session entry ids.
 *
 * Pi exposes `buildContextEntries()`, whose projection is exactly the context
 * hook's message list, so the nth user message matches the nth user entry.
 * omp exposes only `getBranch()` — the raw branch, not the projected context —
 * so the ids are recovered by content instead. Without this the recall ledger
 * gets no ids under omp and stops replaying injected blocks onto history,
 * which costs the provider prompt cache the exact bytes it saw last turn.
 */
export function resolveContextMessageIds(messages, sessionManager) {
  const contextEntries = sessionManager?.buildContextEntries;
  if (typeof contextEntries === "function") {
    const ids = userEntryIds(contextEntries.call(sessionManager));
    const resolved = new WeakMap();
    let index = 0;
    for (const message of messages) {
      if (!readUserMessage(message)) continue;
      const id = ids[index++];
      if (id) resolved.set(message, id);
    }
    return resolved;
  }

  const branch = typeof sessionManager?.getBranch === "function" ? sessionManager.getBranch() : [];
  const idsByMessage = new Map();
  for (const entry of branch) {
    const message = entry?.type === "message" ? readUserMessage(entry.message) : null;
    if (!message || typeof entry.id !== "string") continue;
    const key = messageKey(message);
    const ids = idsByMessage.get(key) ?? [];
    ids.push(entry.id);
    idsByMessage.set(key, ids);
  }

  const resolved = new WeakMap();
  for (const message of messages) {
    const userMessage = readUserMessage(message);
    if (!userMessage) continue;
    const id = idsByMessage.get(messageKey(userMessage))?.shift();
    if (id) resolved.set(message, id);
  }
  return resolved;
}
