import { beforeEach, describe, it, expect, vi } from "vitest";
import { createWorkspace } from "../schema/core";
import { makeDraft } from "./model";
const mocked = vi.hoisted(() => ({ query: vi.fn(), snapshot: vi.fn() }));
vi.mock("../../lib/duckdb/engine", () => mocked);
import { saveGridChanges } from "./mutations";
beforeEach(() => {
  vi.resetAllMocks();
  mocked.query.mockResolvedValue({ columns: [], rows: [] });
  mocked.snapshot.mockResolvedValue({});
});
describe("grid save transactions", () => {
  it("saves all rows in one transaction and snapshots before committing", async () => {
    const w = createWorkspace();
    const row = makeDraft();
    row.cells = { id: "3", name: "Jo", email: "jo@example.com" };
    await saveGridChanges(w, w.schema.tables[0], [row]);
    expect(mocked.query.mock.calls.map((c) => c[0])).toEqual([
      "BEGIN TRANSACTION",
      `INSERT INTO "customers" ("id", "name", "email") VALUES (3, 'Jo', 'jo@example.com')`,
      "COMMIT",
    ]);
    expect(mocked.snapshot).toHaveBeenCalledWith(w);
    expect(mocked.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.query.mock.invocationCallOrder[2],
    );
  });
  it("rolls back constraint failures without returning a misleading saved state", async () => {
    const w = createWorkspace();
    const a = makeDraft();
    a.cells = { id: "3", name: "Jo", email: "a" };
    const b = makeDraft();
    b.cells = { id: "3", name: "Duplicate", email: "b" };
    mocked.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Error("Duplicate primary key"));
    await expect(
      saveGridChanges(w, w.schema.tables[0], [a, b]),
    ).rejects.toThrow(/Duplicate/);
    expect(mocked.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocked.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocked.snapshot).not.toHaveBeenCalled();
  });
  it("validates every cell before starting a transaction", async () => {
    const w = createWorkspace();
    const row = makeDraft();
    row.cells = { id: "invalid" };
    await expect(saveGridChanges(w, w.schema.tables[0], [row])).rejects.toThrow(
      /whole number/,
    );
    expect(mocked.query).not.toHaveBeenCalled();
  });
});
