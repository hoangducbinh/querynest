import { expect, it } from "vitest";
import {
  columnDraft,
  columnRestrictions,
  columnTypes,
  type ColumnContext,
} from "./columns";
const context: ColumnContext = {
  tableId: "1",
  schema: "dbo",
  table: "items",
  columns: [
    {
      id: "1:1",
      name: "id",
      dataType: "bigint",
      nullable: false,
      defaultValue: "",
      generated: true,
      primaryKey: true,
      uniqueConstraints: [],
      defaultConstraint: null,
      dependencies: ["Index: PK_items"],
    },
    {
      id: "1:2",
      name: "title",
      dataType: "nvarchar(30)",
      nullable: true,
      defaultValue: "(N'text')",
      generated: false,
      primaryKey: false,
      uniqueConstraints: [],
      defaultConstraint: "DF_title",
      dependencies: [],
    },
  ],
};
it("starts new columns with engine-specific native types", () => {
  expect(columnDraft(undefined, "postgres").dataType).toBe("text");
  expect(columnDraft(undefined, "mssql").dataType).toBe("nvarchar(255)");
  expect(columnTypes("mssql")).toContain("decimal(18,2)");
  expect(columnTypes("postgres")).toContain("jsonb");
});
it("preserves real default expressions and protects generated/key dependencies", () => {
  expect(columnDraft(context.columns[1], "mssql").defaultValue).toBe(
    "(N'text')",
  );
  expect(
    columnRestrictions(context, context.columns[0], "mssql"),
  ).toMatchObject({
    generated: true,
    typeLocked: true,
    dropLocked: true,
    primaryLocked: true,
  });
  expect(
    columnRestrictions(context, context.columns[1], "mssql"),
  ).toMatchObject({
    generated: false,
    typeLocked: false,
    dropLocked: false,
    primaryLocked: true,
  });
  const indexed = {
    ...context.columns[1],
    dependencies: ["Index: title_index"],
  };
  expect(columnRestrictions(context, indexed, "mssql").typeLocked).toBe(true);
  expect(columnRestrictions(context, indexed, "postgres").typeLocked).toBe(
    false,
  );
});
it("keeps the last column and existing primary/unique constraints protected", () => {
  const only = { ...context, columns: [context.columns[1]] };
  expect(columnRestrictions(only, only.columns[0], "postgres").dropLocked).toBe(
    true,
  );
  expect(
    columnRestrictions(
      context,
      { ...context.columns[1], uniqueConstraints: ["u1", "u2"] },
      "mssql",
    ).uniqueLocked,
  ).toBe(true);
});
