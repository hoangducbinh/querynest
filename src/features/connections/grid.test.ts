import { it, expect } from "vitest";
import { gridChanges, gridSaveError } from "./grid";
import { makeDraft, pasteCells, isChanged } from "../sample-data/model";
import { createWorkspace } from "../schema/core";
import { catalogSchema } from "../postgres/model";
it("keeps exact remote values and differentiates NULL, empty and defaults", () => {
  const old = makeDraft({
    id: "9007199254740993",
    amount: "1234567890.12345678",
    name: "old",
  });
  old.cells = { name: "", amount: "0.12345678", missing: undefined };
  const next = makeDraft();
  next.cells = { name: null };
  const defaults = makeDraft();
  defaults.insert = true;
  const deletedNew = makeDraft();
  deletedNew.deleted = true;
  const result = gridChanges([old, next, defaults, makeDraft(), deletedNew]);
  expect(result).toHaveLength(3);
  expect(result[0].original?.id).toBe("9007199254740993");
  expect(result[0].cells).toEqual({ name: "", amount: "0.12345678" });
  expect(result[1].cells).toEqual({ name: null });
  expect(result[2].cells).toEqual({});
  expect(isChanged(defaults)).toBe(true);
});
it("blocks paste into generated/read-only columns without changing existing drafts", () => {
  const table = createWorkspace().schema.tables[0];
  table.columns[0].generated = true;
  const rows = [makeDraft()];
  expect(() => pasteCells(rows, table, 0, 0, [["1", "a"]])).toThrow(
    /generated/,
  );
  expect(rows[0].cells).toEqual({});
  expect(pasteCells(rows, table, 0, 1, [["a"]])[0].cells.name).toBe("a");
});
it("exposes generated values/defaults and read-only views from remote metadata", () => {
  const schema = catalogSchema({
    tables: [
      {
        id: "t",
        schema: "dbo",
        name: "items",
        kind: "U ",
        columns: [
          {
            id: "c",
            name: "id",
            type: "bigint",
            nullable: false,
            primaryKey: true,
            generated: true,
          },
          {
            id: "n",
            name: "name",
            type: "nvarchar(20)",
            nullable: true,
            primaryKey: false,
            defaultValue: "DEFAULT",
          },
        ],
      },
      { id: "v", schema: "dbo", name: "view", kind: "V", columns: [] },
    ],
    relationships: [],
  });
  expect(schema.tables[0].readOnly).toBe(false);
  expect(schema.tables[0].columns[0].readOnly).toBe(true);
  expect(schema.tables[0].columns[0].defaultValue).toBe("Generated");
  expect(schema.tables[0].columns[1].defaultValue).toBe("DEFAULT");
  expect(schema.tables[1].readOnly).toBe(true);
});
it("requires a refresh after an unconfirmed commit and caps grid saves", () => {
  expect(
    gridSaveError({ message: "Unknown outcome", uncertain: true })
      .requiresRefresh,
  ).toBe(true);
  expect(
    gridSaveError({ message: "Constraint violation" }).requiresRefresh,
  ).toBe(false);
  expect(() =>
    gridChanges(
      Array.from({ length: 501 }, () => ({ ...makeDraft(), insert: true })),
    ),
  ).toThrow(/500/);
});
