import { afterEach, expect, it, vi } from "vitest";
import type { PgQueryResult } from "../postgres/client";
import {
  tableState,
  cachedTablePage,
  loadTablePage,
  invalidateTable,
  releaseTableSession,
} from "./table-state";
const result = (id: number): PgQueryResult => ({
  rows: [{ id }],
  columns: ["id"],
  affectedRows: 0,
  truncated: false,
});
afterEach(() => {
  releaseTableSession("test");
  releaseTableSession("other");
});
it("reuses opened table pages and retains each table's selected page independently", async () => {
  const load = vi.fn(async () => result(1));
  await loadTablePage("test:source", "a", 2, "schema", load);
  tableState("test:source", "a").page = 2;
  await loadTablePage("test:source", "b", 0, "schema", load);
  await loadTablePage("test:source", "a", 2, "schema", load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(tableState("test:source", "a").page).toBe(2);
  expect(tableState("test:source", "b").page).toBe(0);
  expect(cachedTablePage("other:source", "a", 2, "schema")).toBeUndefined();
});
it("refresh invalidates only that table and prevents older requests from replacing refreshed rows", async () => {
  let finish!: (data: PgQueryResult) => void;
  const old = loadTablePage(
    "test:source",
    "a",
    0,
    "schema",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(loadTablePage("test:source", "a", 0, "schema", vi.fn())).toBe(old);
  await Promise.resolve();
  await loadTablePage("test:source", "b", 0, "schema", async () => result(2));
  invalidateTable("test:source", "a");
  await loadTablePage("test:source", "a", 0, "schema", async () => result(3));
  finish(result(1));
  await old;
  expect(cachedTablePage("test:source", "a", 0, "schema")?.rows).toEqual([
    { id: 3 },
  ]);
  expect(cachedTablePage("test:source", "b", 0, "schema")?.rows).toEqual([
    { id: 2 },
  ]);
});
it("changed schema cannot reuse an in-flight page from the previous structure", async () => {
  let finish!: (data: PgQueryResult) => void;
  const old = loadTablePage(
    "test:source",
    "a",
    0,
    "old",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  await loadTablePage("test:source", "a", 0, "new", async () => result(4));
  finish(result(1));
  await old;
  expect(cachedTablePage("test:source", "a", 0, "new")?.rows).toEqual([
    { id: 4 },
  ]);
  releaseTableSession("test");
  expect(cachedTablePage("test:source", "a", 0, "new")).toBeUndefined();
});
