import { beforeEach, expect, it, vi } from "vitest";
import { createWorkspace } from "../../test/fixtures";
import { currentSource } from "./sources";
import { defaultMssqlConfig } from "./model";
import { makeDraft } from "../sample-data/model";
import { saveQueryResult } from "./save-query-result";
const mocks = vi.hoisted(() => ({ save: vi.fn(), query: vi.fn() }));
vi.mock("./client", () => ({ remoteClient: () => mocks }));
vi.mock("./databases", () => ({
  withDatabaseSession: (
    _w: unknown,
    _s: unknown,
    callback: (session: { sessionId: string }) => unknown,
  ) => callback({ sessionId: "qa" }),
}));
beforeEach(() => {
  mocks.save.mockReset().mockResolvedValue(1);
  mocks.query.mockReset();
});
function fixture() {
  const w = createWorkspace();
  w.mssql = { ...defaultMssqlConfig, readOnly: false };
  const table = w.schema.tables[0];
  table.namespace = "dbo";
  const original = Object.fromEntries(
    table.columns.map((c, i) => [c.name, i === 0 ? 1 : "old"]),
  );
  const draft = makeDraft(original);
  draft.cells[table.columns[1].name] = "new";
  return {
    w,
    result: {
      sql: `SELECT * FROM dbo.${table.name}`,
      rows: [original],
      columns: table.columns.map((c) => c.name),
      status: "OK",
    },
    draft,
  };
}
it("saves through the existing primary-key/concurrency path, then reloads only the read query", async () => {
  const { w, result, draft } = fixture();
  mocks.query.mockResolvedValue({ rows: [{ id: 1 }] });
  expect(await saveQueryResult(w, currentSource(w), result, [draft])).toEqual([
    { id: 1 },
  ]);
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.save.mock.calls[0][2][0].original).toEqual(result.rows[0]);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith("qa", result.sql);
});
it("prevents retrying a committed write when result refresh fails", async () => {
  const { w, result, draft } = fixture();
  mocks.query.mockRejectedValue(Error("network"));
  await expect(
    saveQueryResult(w, currentSource(w), result, [draft]),
  ).rejects.toMatchObject({ requiresRefresh: true });
  expect(mocks.save).toHaveBeenCalledOnce();
});
it("does not write projections, joins or read-only connections", async () => {
  const { w, result, draft } = fixture();
  w.mssql!.readOnly = true;
  await expect(
    saveQueryResult(w, currentSource(w), result, [draft]),
  ).rejects.toThrow("read-only");
  w.mssql!.readOnly = false;
  await expect(
    saveQueryResult(
      w,
      currentSource(w),
      { ...result, sql: "SELECT * FROM dbo.customers JOIN orders ON 1=1" },
      [draft],
    ),
  ).rejects.toThrow("single table");
  expect(mocks.save).not.toHaveBeenCalled();
});
