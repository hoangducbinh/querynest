import type { TableDefinition } from "../../types/schema";
export type CellValue = string | null | undefined;
export interface DraftRow {
  id: string;
  original?: Record<string, unknown>;
  cells: Record<string, CellValue>;
  deleted: boolean;
  insert?: boolean;
}
export function cellText(value: unknown): string {
  return value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
export const makeDraft = (row?: Record<string, unknown>): DraftRow => ({
  id: crypto.randomUUID(),
  original: row,
  cells: {},
  deleted: false,
});
export const isChanged = (row: DraftRow) =>
  !!row.insert || row.deleted || Object.keys(row.cells).length > 0;
// Excel/Sheets TSV includes quoted tabs, newlines and doubled quotes.
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [[]];
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || value === "")) {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "\t" || c === "\n" || c === "\r")) {
      rows.at(-1)!.push(value);
      value = "";
      if (c !== "\t") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        rows.push([]);
      }
    } else value += c;
  }
  rows.at(-1)!.push(value);
  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === "")
    rows.pop();
  return rows;
}
export function columnLetter(index: number): string {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
export function pasteCells(
  rows: DraftRow[],
  table: TableDefinition,
  startRow: number,
  startCol: number,
  values: string[][],
): DraftRow[] {
  if (
    startCol + Math.max(...values.map((r) => r.length)) >
    table.columns.length
  )
    throw Error(
      "The pasted data has more columns than this table. Select a different starting cell.",
    );
  if (values.length > 10000) throw Error("Paste up to 10,000 rows at a time.");
  const next = rows.map((r) => ({ ...r, cells: { ...r.cells } }));
  values.forEach((row, r) => {
    const i = startRow + r;
    while (next.length <= i) next.push(makeDraft());
    if (next[i].deleted)
      throw Error("Restore deleted rows before pasting over them.");
    if (next[i].original && !table.primaryKey.length)
      throw Error(
        "A primary key is required to edit existing rows. Paste into a new row instead.",
      );
    row.forEach((value, c) => {
      const column = table.columns[startCol + c];
      if (column.generated || column.readOnly)
        throw Error(
          `${column.name} is generated or read-only. Paste into editable columns instead.`,
        );
      next[i].cells[column.name] = value === "\\N" ? null : value;
    });
  });
  if (next.length && isChanged(next.at(-1)!)) next.push(makeDraft());
  return next;
}
