/**
 * Merge this extension's system-prompt additions into the host's prompt.
 *
 * Pi hands `before_agent_start` a single string; omp hands an array of parts.
 * `prompt + "\n\n" + additions` on an array coerces it to a comma-joined
 * string, silently flattening every part into one — and the host then stores
 * what it expected to keep as separate parts. Append instead and let each host
 * join its own way.
 *
 * Callers skip the empty `additions` case, so this stays a pure merge.
 */
export function appendSystemPrompt(prompt, additions) {
  return Array.isArray(prompt) ? [...prompt, additions] : `${prompt}\n\n${additions}`;
}
