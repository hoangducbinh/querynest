import { expect, it } from "vitest";
import { createWorkspace } from "../../test/fixtures";
import { editableResult } from "./editable-result";
import type { SqlResult } from "./execution";
const fixture = () => {
  const schema = createWorkspace().schema;
  schema.tables[0].namespace = "dbo";
  const result = (sql: string): SqlResult => ({
    sql,
    rows: [],
    columns: schema.tables[0].columns.map((c) => c.name),
    status: "OK",
  });
  return { schema, result };
};
it("allows full single-table rows with primary keys, including TOP and quoted names", () => {
  const { schema, result } = fixture();
  for (const sql of [
    "SELECT * FROM dbo.customers",
    "SELECT TOP (100) * FROM [dbo].[customers] WHERE id IN (1,2) ORDER BY id;",
    "SELECT TOP 10 * FROM dbo.customers",
  ])
    expect(editableResult(result(sql), schema, "mssql")?.id).toBe(
      schema.tables[0].id,
    );
});
it("rejects ambiguous or derived results, side-effectful predicates and incomplete originals", () => {
  const { schema, result } = fixture();
  for (const sql of [
    "SELECT DISTINCT * FROM dbo.customers",
    "SELECT id FROM dbo.customers",
    "SELECT * FROM dbo.customers c JOIN orders o ON c.id=o.id",
    "WITH q AS (SELECT * FROM dbo.customers) SELECT * FROM q",
    "SELECT * FROM dbo.customers; DELETE FROM orders",
    "SELECT * FROM dbo.customers WHERE id=nextval('seq')",
    "SELECT * FROM dbo.customers WHERE id IN (SELECT id FROM orders)",
  ])
    expect(editableResult(result(sql), schema, "mssql")).toBeUndefined();
  const partial = result("SELECT * FROM dbo.customers");
  partial.columns.pop();
  expect(editableResult(partial, schema, "mssql")).toBeUndefined();
  const noKey = structuredClone(schema);
  noKey.tables[0].primaryKey = [];
  expect(
    editableResult(result("SELECT * FROM dbo.customers"), noKey, "mssql"),
  ).toBeUndefined();
  const ambiguous = structuredClone(schema);
  ambiguous.tables.push({
    ...ambiguous.tables[0],
    id: "other",
    namespace: "other",
  });
  expect(
    editableResult(result("SELECT * FROM customers"), ambiguous, "mssql"),
  ).toBeUndefined();
});
