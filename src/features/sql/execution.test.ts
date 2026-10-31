import { describe, expect, it, vi } from "vitest";
import { executeSqlBatch } from "./execution";
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
