import { afterEach, expect, it } from "vitest";
import {
  clearWorkspaceResults,
  readSqlResults,
  updateSqlResults,
} from "./result-state";
import type { SqlResult } from "./execution";
const output: SqlResult[] = [
  {
    sql: "SELECT 42",
    rows: [{ answer: 42 }],
    columns: ["answer"],
    status: "1 row",
  },
];
afterEach(() => {
  clearWorkspaceResults("workspace");
  clearWorkspaceResults("other");
});
it("retains results when the SQL view is recreated and isolates query tabs", () => {
  updateSqlResults("workspace", { first: output });
  const beforeLeavingSql = readSqlResults("workspace");
  expect(readSqlResults("other")).toEqual({});
  expect(readSqlResults("workspace")).toBe(beforeLeavingSql);
  updateSqlResults("workspace", (previous) => ({ ...previous, second: [] }));
  expect(readSqlResults("workspace").first).toBe(output);
  expect(readSqlResults("workspace").second).toEqual([]);
});
it("isolates remote database contexts and releases deleted workspace results", () => {
  const databaseA = "workspace:source:primary:database-a";
  const databaseB = "workspace:source:primary:database-b";
  updateSqlResults(databaseA, { first: output });
  updateSqlResults("other", { first: output });
  expect(readSqlResults(databaseB)).toEqual({});
  expect(readSqlResults(databaseA).first).toBe(output);
  clearWorkspaceResults("workspace");
  expect(readSqlResults(databaseA)).toEqual({});
  expect(readSqlResults("other").first).toBe(output);
});
