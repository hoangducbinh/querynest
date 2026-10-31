import { sqlStatements } from "./statements";
import { describe, it, expect, vi } from "vitest";
import { diagnosticForError, validateSql } from "./diagnostics";
describe("SQL diagnostics", () => {
  it("splits statements without splitting quoted strings, identifiers or comments", () => {
    const sql = `-- ;\nSELECT ';', $$a;b$$, "a;b"; /* ; /* ; */ */ SELECT 2;`;
    const statements = sqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(sql.slice(statements[1].start)).toContain("SELECT 2");
    expect(sqlStatements("-- only comment\n/* x */;")).toEqual([]);
  });
  it("maps DuckDB caret locations into the full script", () => {
    const sql = "\nSELECT * FROM missing_table";
    const result = diagnosticForError(
      sql,
      20,
      new Error(
        "Catalog Error: Table with name missing_table does not exist!\n\nLINE 2: SELECT * FROM missing_table\n                      ^",
      ),
    );
    expect(result.start).toBe(20 + sql.indexOf("missing_table"));
    expect(result.end).toBe(20 + sql.length);
  });
  it("finds named identifiers without caret locations and skips literals", () => {
    const sql = "SELECT 'wrong', wrong FROM customers";
    const result = diagnosticForError(
      sql,
      0,
      'Binder Error: Referenced column "wrong" not found',
    );
    expect(result.start).toBe(sql.indexOf("wrong FROM"));
  });
  it("only prepares statements and collects each error without stopping the next", async () => {
    const prepare = vi.fn(async (sql: string) => {
      if (sql.includes("missing"))
        throw Error("Table with name missing does not exist");
    });
    const result = await validateSql(
      "DELETE FROM customers; SELECT * FROM missing; SELECT 1",
      prepare,
    );
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(
      "DELETE FROM customers; SELECT * FROM ".length,
    );
  });
  it("uses a warning when earlier DDL has not been applied", async () => {
    const result = await validateSql(
      "CREATE TABLE new_table(id INTEGER); SELECT * FROM new_table",
      async (sql) => {
        if (sql.includes("SELECT"))
          throw Error("Table with name new_table does not exist");
      },
    );
    expect(result[0].warning).toBe(true);
    expect(result[0].message).toContain("earlier schema changes");
  });
  it("points incomplete SQL at the end of input", () => {
    const result = diagnosticForError(
      "SELECT * FROM",
      5,
      "Parser Error: syntax error at end of input",
    );
    expect(result.start).toBe(18);
  });
  it("does not split semicolons inside escape-string literals", () => {
    expect(
      sqlStatements(String.raw`SELECT E'can\'t; split'; SELECT 2;`),
    ).toHaveLength(2);
  });
  it("splits top-level SELECT queries at blank lines and preserves offsets", () => {
    const sql =
      "SELECT * FROM customers\n\nSELECT * FROM orders\r\n \r\nSELECT 3; SELECT 4";
    const statements = sqlStatements(sql);
    expect(statements.map((item) => item.sql.trim())).toEqual([
      "SELECT * FROM customers",
      "SELECT * FROM orders",
      "SELECT 3",
      "SELECT 4",
    ]);
    expect(statements[1].start).toBe(sql.indexOf("SELECT * FROM orders"));
  });
  it("keeps multiline queries, subqueries and CTE definitions intact", () => {
    for (const sql of [
      "SELECT *\n\nFROM customers",
      "SELECT * FROM (\n\nSELECT * FROM customers\n\n) c",
      "WITH c AS (\nSELECT * FROM customers\n\n)\n\nSELECT * FROM c",
      "WITH a AS (SELECT 1),\n\nb AS (SELECT 2)\n\nSELECT * FROM a, b",
      "INSERT INTO target\n\nSELECT * FROM source",
      "CREATE TABLE target AS\n\nSELECT * FROM source",
      "SELECT * FROM unnest([1])\n\nWITH ORDINALITY AS t(x, n)",
      "WITH c AS (SELECT 1)\nINSERT INTO target\n\nSELECT * FROM c",
    ])
      expect(sqlStatements(sql)).toHaveLength(1);
    expect(
      sqlStatements("WITH c AS (SELECT 1)\n\nSELECT * FROM c\n\nSELECT 2"),
    ).toHaveLength(2);
  });
  it("does not break UNION, EXCEPT or INTERSECT branches", () => {
    for (const operator of [
      "UNION",
      "UNION ALL",
      "UNION BY NAME",
      "EXCEPT",
      "INTERSECT ALL",
    ])
      expect(sqlStatements(`SELECT 1\n${operator}\n\nSELECT 2`)).toHaveLength(
        1,
      );
  });
  it("ignores blank lines in strings, quoted identifiers and nested comments", () => {
    for (const sql of [
      "SELECT 'a\n\nSELECT b'",
      'SELECT "a\n\nSELECT b"',
      "SELECT $$a\n\nSELECT b$$",
      "SELECT 1 /* a\n\nSELECT b /* c */ */",
      "SELECT 1 /*\n\n*/ SELECT 2",
    ])
      expect(sqlStatements(sql)).toHaveLength(1);
    expect(sqlStatements("SELECT 1\n\n-- next query\nSELECT 2")).toHaveLength(
      2,
    );
    expect(sqlStatements("SELECT 1\nSELECT 2")).toHaveLength(1);
  });
});
