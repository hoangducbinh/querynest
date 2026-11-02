import { describe, expect, it, vi } from "vitest";
import { executeSqlBatch, sqlMayChangeSchema } from "./execution";
describe("multi-statement SQL execution", () => {
  it("runs in order and preserves each result including DML", async () => {
    const query = vi.fn(async (sql: string) => ({
      columns: ["value"],
      rows: [{ value: sql.trim() }],
    }));
    const results = await executeSqlBatch(
      "SELECT 1; UPDATE items SET value = 2; SELECT 2;",
      query,
    );
    expect(query.mock.calls.map(([sql]) => sql.trim())).toEqual([
      "SELECT 1",
      "UPDATE items SET value = 2",
      "SELECT 2",
    ]);
    expect(results).toHaveLength(3);
    expect(results[2].rows).toEqual([{ value: "SELECT 2" }]);
  });
  it("stops at the first error and keeps earlier results", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("bad")) throw Error("Unknown table");
      return { columns: ["x"], rows: [{ x: 1 }] };
    });
    const results = await executeSqlBatch(
      "SELECT 1; SELECT * FROM bad; DELETE FROM items;",
      query,
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBe(true);
    expect(results[1].status).toContain("Unknown table");
  });
  it("keeps semicolons in comments and literals intact and ignores empty scripts", async () => {
    const query = vi.fn(async () => ({ columns: [], rows: [] }));
    expect(await executeSqlBatch("-- hi;\n/* ; */;", query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(
      await executeSqlBatch("SELECT ';'; SELECT $$a;b$$", query),
    ).toHaveLength(2);
  });
  it("runs blank-line separated queries with individual results", async () => {
    const query = vi.fn(async (sql: string) => ({
      columns: ["sql"],
      rows: [{ sql: sql.trim() }],
    }));
    const results = await executeSqlBatch("SELECT 1\n\nSELECT 2", query);
    expect(results.map((item) => item.sql)).toEqual(["SELECT 1", "SELECT 2"]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("schema refresh invalidation", () => {
  it("keeps ordinary reads and row edits off the catalog refresh path", () => {
    for (const sql of [
      "SELECT TOP (3) * FROM dbo.Customer",
      "SELECT 'CREATE TABLE' AS description -- DROP TABLE t",
      "WITH c AS (SELECT 1 AS n) SELECT n FROM c",
      "UPDATE dbo.Customer SET name='ALTER'",
    ])
      expect(sqlMayChangeSchema(sql, "mssql")).toBe(false);
  });
  it("refreshes after DDL and procedures that may change schema", () => {
    for (const sql of [
      "CREATE TABLE t(id int)",
      "SELECT 1; ALTER TABLE t ADD n int",
      "DROP VIEW v",
      "EXEC dbo.ChangeSchema",
      "EXECUTE sp_executesql N'CREATE TABLE t(id int)'",
    ])
      expect(sqlMayChangeSchema(sql, "mssql")).toBe(true);
  });
});

it("skips later GO batches after a stop request", async () => {
  let stopped = false;
  const driver = vi.fn(async () => {
    stopped = true;
    return { columns: ["n"], rows: [{ n: 1 }] };
  });
  const result = await executeSqlBatch(
    "SELECT 1 AS n\nGO\nSELECT 2 AS n",
    async () => {
      if (stopped)
        throw Error("Query stopped. Remaining statements were skipped.");
      return driver();
    },
    "mssql",
  );
  expect(driver).toHaveBeenCalledOnce();
  expect(result.at(-1)?.error).toBe(true);
  expect(result.at(-1)?.status).toContain("Query stopped");
});
