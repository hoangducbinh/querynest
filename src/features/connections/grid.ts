import { isChanged, type DraftRow } from "../sample-data/model";
import { pgError } from "../postgres/model";
export interface GridChange {
  original?: Record<string, unknown>;
  cells: Record<string, string | null>;
  deleted: boolean;
}
export function gridChanges(rows: DraftRow[]): GridChange[] {
  const changes = rows
    .filter(isChanged)
    .filter((row) => row.original || !row.deleted)
    .map((row) => ({
      original: row.original,
      cells: row.deleted
        ? {}
        : (Object.fromEntries(
            Object.entries(row.cells).filter(
              ([, value]) => value !== undefined,
            ),
          ) as Record<string, string | null>),
      deleted: row.deleted,
    }));
  if (changes.length > 500)
    throw Error("Save up to 500 changed rows at a time.");
  return changes;
}
export function gridSaveError(
  error: unknown,
): Error & { requiresRefresh?: boolean } {
  return Object.assign(new Error(pgError(error)), {
    requiresRefresh: !!(
      error &&
      typeof error === "object" &&
      "uncertain" in error &&
      error.uncertain
    ),
  });
}
