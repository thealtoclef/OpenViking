export const RESET_BOUNDARY_ENTRY_TYPE: "reset_boundary";
export function latestResetBoundaryId(entries: readonly unknown[] | undefined): string | null;
export function resetBoundaryChanged(
  lastSeenId: string | null | undefined,
  entries: readonly unknown[] | undefined,
): { id: string | null; changed: boolean };
