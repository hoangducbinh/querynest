import { expect, it } from "vitest";
import { locateSqlServerDiagnostic } from "./diagnostic-location";

it("locates a named Unicode column instead of the first character of a line", () => {
  const sql = "-- 😀\r\nSELECT [tên_sai] FROM dbo.customers";
  const issue = locateSqlServerDiagnostic(sql, {
    start: 7,
    end: 8,
    message: "Invalid column name 'tên_sai'.",
  });
  expect(sql.slice(issue.start, issue.end)).toBe("[tên_sai]");
});
it("locates syntax and multi-part identifier errors", () => {
  for (const [sql, message, expected] of [
    ["SELECT * FRM customers", "Incorrect syntax near 'FRM'.", "FRM"],
    [
      "SELECT c.missing FROM customers c",
      'The multi-part identifier "c.missing" could not be bound.',
      "missing",
    ],
  ]) {
    const result = locateSqlServerDiagnostic(sql, {
      start: 0,
      end: 1,
      message,
    });
    expect(sql.slice(result.start, result.end)).toBe(expected);
  }
});
it("marks the reported line honestly when a token cannot be located uniquely", () => {
  const sql = "SELECT 1;\n  SELECT missing, missing FROM customers";
  const result = locateSqlServerDiagnostic(sql, {
    start: 10,
    end: 11,
    message: "Invalid column name 'missing'.",
  });
  expect(sql.slice(result.start, result.end)).toBe(
    "SELECT missing, missing FROM customers",
  );
  expect(result.message).toContain("exact token is unavailable");
});
it("does not mistake strings or comments for an invalid column", () => {
  const sql = "SELECT 'missing', missing FROM customers -- missing";
  const result = locateSqlServerDiagnostic(sql, {
    start: 0,
    end: 1,
    message: "Invalid column name 'missing'.",
  });
  expect(result.start).toBe(sql.indexOf(", missing") + 2);
});
