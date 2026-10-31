import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { createWorkspace, parseWorkspace } from "../schema/core";
import { activeSqlTab, sqlTabs, setSqlTabs } from "./tabs";
import { saveWorkspace, storage } from "../../lib/storage/workspaces";
describe("SQL tabs", () => {
  it("preserves legacy SQL and supports independent queries and selection", () => {
    const w = createWorkspace();
    const original = w.sql;
    const first = activeSqlTab(w);
    expect(first.sql).toBe(original);
    const next = { id: "second", name: "analysis.sql", sql: "SELECT 2;" };
    setSqlTabs(w, [...sqlTabs(w), next], next.id);
    expect(w.sql).toBe(next.sql);
    expect(activeSqlTab(w)).toEqual(next);
    setSqlTabs(w, sqlTabs(w), first.id);
    expect(w.sql).toBe(original);
  });
  it("roundtrips multiple tabs and selected tab through storage and JSON", async () => {
    const w = createWorkspace();
    setSqlTabs(
      w,
      [...sqlTabs(w), { id: "second", name: "Empty.sql", sql: "" }],
      "second",
    );
    await saveWorkspace(w);
    const loaded = (await storage.workspaces.get(w.id))!;
    expect(activeSqlTab(parseWorkspace(JSON.stringify(loaded))).id).toBe(
      "second",
    );
    expect(sqlTabs(loaded)).toEqual(w.sqlTabs);
    await storage.workspaces.delete(w.id);
  });
  it("rejects invalid imported tabs and selection", () => {
    const w = createWorkspace();
    for (const sqlTabs of [
      [],
      [null],
      [{ id: "a", name: " ", sql: "" }],
      [
        { id: "a", name: "a", sql: "" },
        { id: "a", name: "b", sql: "" },
      ],
    ])
      expect(() => parseWorkspace(JSON.stringify({ ...w, sqlTabs }))).toThrow(
        /SQL tabs/,
      );
    expect(() =>
      parseWorkspace(
        JSON.stringify({
          ...w,
          sqlTabs: sqlTabs(w),
          activeSqlTabId: "missing",
        }),
      ),
    ).toThrow(/active SQL tab/);
  });
});
