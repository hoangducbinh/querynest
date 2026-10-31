import { describe, it, expect } from "vitest";
import { createWorkspace } from "../schema/core";
import {
  columnLetter,
  makeDraft,
  mutationSQL,
  parseCell,
  parseClipboard,
  pasteCells,
} from "./model";
import type { ColumnDefinition } from "../../types/schema";
const column = (
  type: ColumnDefinition["type"],
  nullable = false,
): ColumnDefinition => ({
  id: "c",
  name: "value",
  type,
  nullable,
  unique: false,
  defaultValue: "",
});
describe("spreadsheet data entry", () => {
  it("keeps text as plain text and distinguishes empty text from NULL", () => {
    expect(parseCell("", column("VARCHAR"))).toBe("");
    expect(parseCell(null, column("VARCHAR", true))).toBeNull();
    expect(parseCell("NULL", column("VARCHAR"))).toBe("NULL");
    expect(() => parseCell(null, column("VARCHAR"))).toThrow(/required/);
  });
  it("validates numeric types without losing BIGINT precision", () => {
    expect(parseCell("9223372036854775807", column("BIGINT"))).toBe(
      "9223372036854775807",
    );
    expect(() => parseCell("9223372036854775808", column("BIGINT"))).toThrow(
      /range/,
    );
    expect(() => parseCell("1.5", column("INTEGER"))).toThrow(/whole/);
    expect(() => parseCell("2147483648", column("INTEGER"))).toThrow(/range/);
    expect(() => parseCell("Infinity", column("DOUBLE"))).toThrow(/finite/);
    expect(parseCell("12.25", column("DOUBLE"))).toBe(12.25);
    expect(parseCell("", column("DOUBLE", true))).toBeNull();
  });
  it("checks booleans and real calendar dates", () => {
    expect(parseCell("false", column("BOOLEAN"))).toBe(false);
    expect(parseCell("1", column("BOOLEAN"))).toBe(true);
    expect(() => parseCell("yes", column("BOOLEAN"))).toThrow();
    expect(parseCell("2024-02-29", column("DATE"))).toBe("2024-02-29");
    expect(() => parseCell("2025-02-29", column("DATE"))).toThrow();
    expect(() => parseCell("nonsense", column("TIMESTAMP"))).toThrow();
  });
  it("parses Excel TSV including quoted newlines, tabs and CRLF", () => {
    expect(
      parseClipboard(
        '3\tAlex\talex@example.com\r\n4\t"Jo\tLee"\t"a""b\nc"\r\n',
      ),
    ).toEqual([
      ["3", "Alex", "alex@example.com"],
      ["4", "Jo\tLee", 'a"b\nc'],
    ]);
  });
  it("pastes multiple rows starting at a selected cell without truncating columns", () => {
    const t = createWorkspace().schema.tables[0];
    const rows = pasteCells([makeDraft()], t, 0, 0, [
      ["3", "Alex", "alex@example.com"],
      ["4", "Jo", "jo@example.com"],
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1].cells).toEqual({
      id: "4",
      name: "Jo",
      email: "jo@example.com",
    });
    expect(mutationSQL(t, rows)).toHaveLength(2);
    expect(() => pasteCells(rows, t, 0, 2, [["a", "b"]])).toThrow(
      /more columns/,
    );
  });
  it("does not insert untouched blank rows and uses defaults for untouched cells", () => {
    const t = createWorkspace().schema.tables[0];
    t.columns[2].defaultValue = "'hello@example.com'";
    const row = makeDraft();
    row.cells = { id: "3", name: "O'Brien" };
    expect(mutationSQL(t, [row, makeDraft()])).toEqual([
      `INSERT INTO "customers" ("id", "name") VALUES (3, 'O''Brien')`,
    ]);
  });
  it("requires non-nullable cells on new rows and reports the actual grid row", () => {
    const t = createWorkspace().schema.tables[0];
    const row = makeDraft();
    row.cells = { name: "Alex" };
    expect(() => mutationSQL(t, [makeDraft(), makeDraft(), row])).toThrow(
      /Row 3: id is required/,
    );
  });
  it("addresses updates by the original composite primary key when editing a key", () => {
    const t = createWorkspace().schema.tables[0];
    t.primaryKey = [t.columns[0].id, t.columns[1].id];
    const row = makeDraft({ id: 1, name: "Alex", email: "old" });
    row.cells = { id: "2", email: "new" };
    expect(mutationSQL(t, [row])[0]).toBe(
      `UPDATE "customers" SET "id"=2, "email"='new' WHERE "id" IS NOT DISTINCT FROM 1 AND "name" IS NOT DISTINCT FROM 'Alex'`,
    );
  });
  it("does not update or delete existing rows without a primary key", () => {
    const t = createWorkspace().schema.tables[0];
    t.primaryKey = [];
    const row = makeDraft({ id: 1, name: "Alex", email: "a" });
    row.cells = { name: "Jo" };
    expect(() => mutationSQL(t, [row])).toThrow(/primary key/);
    row.deleted = true;
    expect(() => mutationSQL(t, [row])).toThrow(/primary key/);
    expect(() => pasteCells([makeDraft({ id: 1 })], t, 0, 0, [["2"]])).toThrow(
      /primary key/,
    );
  });
  it("deletes existing rows but discards deleted new rows", () => {
    const t = createWorkspace().schema.tables[0];
    const old = makeDraft({ id: 1 });
    old.deleted = true;
    const draft = makeDraft();
    draft.deleted = true;
    expect(mutationSQL(t, [old, draft])).toEqual([
      'DELETE FROM "customers" WHERE "id" IS NOT DISTINCT FROM 1',
    ]);
  });
  it("supports the explicit clipboard NULL marker and Excel column letters", () => {
    const t = createWorkspace().schema.tables[0];
    expect(
      pasteCells([makeDraft()], t, 0, 0, [["\\N"]])[0].cells.id,
    ).toBeNull();
    expect([0, 25, 26, 51, 52].map(columnLetter)).toEqual([
      "A",
      "Z",
      "AA",
      "AZ",
      "BA",
    ]);
  });
});
