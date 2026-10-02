export function resolveContextMessageIds(
  messages: readonly object[],
  sessionManager: {
    buildContextEntries?: () => unknown[];
    getBranch?: () => unknown[];
  } | undefined,
): WeakMap<object, string>;
