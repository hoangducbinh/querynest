import type { ColumnDefinition, TableDefinition } from "../../types/schema";
import { quote } from "../../lib/ddl/generate";
import { literal } from "../../lib/duckdb/literals";
export type CellValue = string | null | undefined;
export interface DraftRow {
  id: string;
  original?: Record<string, unknown>;
  cells: Record<string, CellValue>;
  deleted: boolean;
}
export function cellText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
export const makeDraft = (row?: Record<string, unknown>): DraftRow => ({
  id: crypto.randomUUID(),
  original: row,
  cells: {},
  deleted: false,
});
export const isChanged = (row: DraftRow) =>
  row.deleted || Object.keys(row.cells).length > 0;
export function parseCell(value: CellValue, column: ColumnDefinition): unknown {
  if (value === undefined) return undefined;
  if (value === null || (value === "" && column.type !== "VARCHAR")) {
    if (!column.nullable) throw Error(`${column.name} is required.`);
    return null;
  }
  if (column.type === "VARCHAR") return value;
  if (column.type === "INTEGER" || column.type === "BIGINT") {
    if (!/^[+-]?\d+$/.test(value.trim()))
      throw Error(`${column.name} must be a whole number.`);
    const number = BigInt(value.trim());
    const min =
      column.type === "INTEGER" ? -2147483648n : -9223372036854775808n;
    const max = column.type === "INTEGER" ? 2147483647n : 9223372036854775807n;
    if (number < min || number > max)
      throw Error(`${column.name} is outside the ${column.type} range.`);
    return column.type === "BIGINT" ? number.toString() : Number(number);
  }
  if (column.type === "DOUBLE") {
    if (!value.trim() || !Number.isFinite(Number(value)))
      throw Error(`${column.name} must be a finite number.`);
    return Number(value);
  }
  if (column.type === "BOOLEAN") {
    if (!/^(true|false|1|0)$/i.test(value.trim()))
      throw Error(`${column.name} must be true or false.`);
    return /^(true|1)$/i.test(value.trim());
  }
  if (column.type === "DATE") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw Error(`${column.name} must be a valid YYYY-MM-DD date.`);
    return value;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw Error(`${column.name} must be a valid timestamp.`);
  return value;
}
export function rowPredicate(
  table: TableDefinition,
  original: Record<string, unknown>,
): string {
  if (!table.primaryKey.length)
    throw Error("Add a primary key to edit or delete existing rows safely.");
  return table.primaryKey
    .map((id) => {
      const column = table.columns.find((c) => c.id === id)!;
      if (
        !Object.hasOwn(original, column.name) ||
        original[column.name] === null
      )
        throw Error(
          "The original primary key is missing. Refresh the table before editing.",
        );
      return `${quote(column.name)} IS NOT DISTINCT FROM ${literal(original[column.name])}`;
    })
    .join(" AND ");
}
export function mutationSQL(
  table: TableDefinition,
  rows: DraftRow[],
): string[] {
  return rows.flatMap((row, index) => {
    if (!isChanged(row)) return [];
    if (row.deleted)
      return row.original
        ? [
            `DELETE FROM ${quote(table.name)} WHERE ${rowPredicate(table, row.original)}`,
          ]
        : [];
    const cells = table.columns
      .filter(
        (c) =>
          Object.hasOwn(row.cells, c.name) && row.cells[c.name] !== undefined,
      )
      .map((c) => {
        try {
          return [c.name, parseCell(row.cells[c.name], c)] as const;
        } catch (e) {
          throw Error(
            `Row ${index + 1}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    if (row.original) {
      if (!cells.length) return [];
      return [
        `UPDATE ${quote(table.name)} SET ${cells.map(([name, value]) => `${quote(name)}=${literal(value)}`).join(", ")} WHERE ${rowPredicate(table, row.original)}`,
      ];
    }
    for (const column of table.columns) {
      if (
        !cells.some(([name]) => name === column.name) &&
        (!column.nullable || table.primaryKey.includes(column.id)) &&
        !column.defaultValue.trim()
      )
        throw Error(`Row ${index + 1}: ${column.name} is required.`);
    }
    return [
      cells.length
        ? `INSERT INTO ${quote(table.name)} (${cells.map(([name]) => quote(name)).join(", ")}) VALUES (${cells.map(([, value]) => literal(value)).join(", ")})`
        : `INSERT INTO ${quote(table.name)} DEFAULT VALUES`,
    ];
  });
}
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
      next[i].cells[table.columns[startCol + c].name] =
        value === "\\N" ? null : value;
    });
  });
  if (next.length && isChanged(next.at(-1)!)) next.push(makeDraft());
  return next;
}
