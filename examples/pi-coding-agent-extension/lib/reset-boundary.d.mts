export const RESET_BOUNDARY_ENTRY_TYPE: "reset_boundary";
export interface ResetBoundary {
  /** Entry id of the newest marker, or null when the branch has none. */
  id: string | null;
  /** Index of that marker in the branch, or -1 when there is none. */
  index: number;
}
export function latestResetBoundary(entries: readonly unknown[] | undefined): ResetBoundary;
export function resetBoundaryChanged(
  lastSeenId: string | null | undefined,
  entries: readonly unknown[] | undefined,
): ResetBoundary & { changed: boolean };
