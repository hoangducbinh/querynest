import { describe, expect, it } from "vitest";
import { sqlCompletions } from "./completions";
import { createWorkspace } from "../../test/fixtures";
import type { SqlDialect } from "./data-types";
const schema = createWorkspace().schema;
const complete = (marked: string, dialect: SqlDialect) =>
  sqlCompletions(
    marked.replace("|", ""),
    marked.indexOf("|"),
    schema,
    [],
    dialect,
  ).suggestions;
describe("database-specific type suggestions", () => {
  it.each<SqlDialect>(["default", "postgres", "mssql"])(
    "suggests types in CREATE TABLE, ALTER ADD and CAST for %s",
    (dialect) => {
      for (const sql of [
        "CREATE TABLE t (id |)",
        "ALTER TABLE t ADD amount |",
        "SELECT CAST(1 AS |)",
      ]) {
        const result = complete(sql, dialect);
        expect(result.length).toBeGreaterThan(20);
        expect(result.every((item) => item.kind === "type")).toBe(true);
      }
    },
  );
  it("inserts NVARCHAR length and MAX on SQL Server, including DECLARE and CONVERT", () => {
    for (const sql of [
      "CREATE TABLE t (name nv|)",
      "DECLARE @name nv|",
      "SELECT CONVERT(nv|, 1)",
    ]) {
      const result = complete(sql, "mssql");
      expect(result.find((item) => item.label === "NVARCHAR")?.insertText).toBe(
        "NVARCHAR(${1:255})",
      );
      expect(
        result.find((item) => item.label === "NVARCHAR(MAX)")?.insertText,
      ).toBe("NVARCHAR(MAX)");
    }
  });
  it("keeps PostgreSQL and SQL Server native types distinct", () => {
    expect(
      complete("SELECT 1::json|", "postgres").map((item) => item.label),
    ).toContain("JSONB");
    expect(
      complete("SELECT CAST(1 AS |)", "default").map((item) => item.label),
    ).toContain("JSONB");
    expect(
      complete("SELECT CAST(1 AS |)", "mssql").map((item) => item.label),
    ).not.toContain("BOOLEAN");
    expect(
      complete("SELECT CAST(1 AS |)", "postgres").map((item) => item.label),
    ).not.toContain("VARIANT");
  });
  it("does not duplicate existing parentheses or show types in comments, strings or table names", () => {
    expect(
      complete("CREATE TABLE t (n dec|(18,2))", "default").find(
        (item) => item.label === "DECIMAL",
      )?.insertText,
    ).toBe("DECIMAL");
    for (const sql of ["-- nv|", "SELECT 'nv|'"])
      expect(complete(sql, "mssql")).toEqual([]);
    expect(
      complete("SELECT * FROM nv|", "mssql").some(
        (item) => item.kind === "type",
      ),
    ).toBe(false);
  });
});
