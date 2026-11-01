import { it, expect, vi } from "vitest";
import { mssqlBatches } from "./statements";
import { executeSqlBatch } from "./execution";
it("keeps T-SQL variables and procedural semicolons in the same batch", () => {
  const sql =
    "DECLARE @n int = 1;\nSELECT @n; SELECT 2;\nGO -- next batch\nSELECT 3;";
  expect(mssqlBatches(sql).map((b) => b.sql.trim())).toEqual([
    "DECLARE @n int = 1;\nSELECT @n; SELECT 2;",
    "SELECT 3;",
  ]);
});
it("does not split GO inside comments, quoted identifiers or strings", () => {
  const sql =
    "SELECT N'hello\nGO\nworld' AS [a;go]]name];\n/*\nGO\n*/\nSELECT [GO] FROM t; -- GO\nGO\nSELECT 2;";
  const batches = mssqlBatches(sql);
  expect(batches).toHaveLength(2);
  expect(batches[1].sql.trim()).toBe("SELECT 2;");
  expect(sql.slice(batches[1].start)).toBe(batches[1].sql);
});
it("shows each result set and stops after a failed SQL Server batch", async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("bad")) throw Error("Invalid object name");
    return {
      columns: [],
      rows: [],
      resultSets: [
        { columns: ["a"], rows: [{ a: 1 }] },
        { columns: ["b"], rows: [] },
      ],
    };
  });
  const result = await executeSqlBatch(
    "SELECT 1; SELECT 2;\nGO\nbad\nGO\nSELECT 3;",
    query,
    "mssql",
  );
  expect(query).toHaveBeenCalledTimes(2);
  expect(result).toHaveLength(3);
  expect(result[1].columns).toEqual(["b"]);
  expect(result[2].error).toBe(true);
});
