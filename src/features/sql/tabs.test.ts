import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { parseWorkspace } from "../schema/core";
import { createWorkspace } from "../../test/fixtures";
import { activeSqlTab, sqlTabs, setSqlTabs, bindNewTabs } from "./tabs";
import { restoreSqlLayout } from "./panes";
import type { SqlLayout } from "../../types/schema";
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

describe("saved SQL pane layout", () => {
  const tabs = [
    { id: "a", name: "left.sql", sql: "SELECT 1" },
    { id: "b", name: "right.sql", sql: "SELECT 2" },
    { id: "c", name: "other.sql", sql: "SELECT 3" },
  ];
  const layout: SqlLayout = {
    width: 62,
    groups: [
      { ids: ["c", "a"], activeId: "a" },
      { ids: ["b"], activeId: "b" },
    ],
  };
  it("roundtrips split, width, tab order and selections independently per workspace", async () => {
    const first = createWorkspace(false);
    const second = createWorkspace(false);
    setSqlTabs(first, tabs, "b", layout);
    setSqlTabs(second, tabs, "c", {
      width: 38,
      groups: [
        { ids: ["a"], activeId: "a" },
        { ids: ["b", "c"], activeId: "c" },
      ],
    });
    await saveWorkspace(first);
    await saveWorkspace(second);
    const restoredFirst = parseWorkspace(
      JSON.stringify(await storage.workspaces.get(first.id)),
    );
    const restoredSecond = parseWorkspace(
      JSON.stringify(await storage.workspaces.get(second.id)),
    );
    expect(
      restoreSqlLayout(
        sqlTabs(restoredFirst),
        activeSqlTab(restoredFirst).id,
        restoredFirst.sqlLayout,
      ),
    ).toEqual(layout);
    expect(restoredSecond.sqlLayout).toEqual(second.sqlLayout);
    expect(activeSqlTab(restoredFirst).id).toBe("b");
    await storage.workspaces.bulkDelete([first.id, second.id]);
  });
  it("keeps groups when editing SQL or changing the focused pane", () => {
    const w = createWorkspace(false);
    setSqlTabs(w, tabs, "b", layout);
    setSqlTabs(
      w,
      tabs.map((tab) => (tab.id === "a" ? { ...tab, sql: "SELECT 42" } : tab)),
      "a",
    );
    expect(w.sqlLayout).toEqual(layout);
    expect(w.sql).toBe("SELECT 42");
  });
  it("persists closing split as one group without discarding width or tabs", () => {
    const w = createWorkspace(false);
    const merged = {
      width: 62,
      groups: [{ ids: ["a", "b", "c"], activeId: "b" }],
    };
    setSqlTabs(w, tabs, "b", merged);
    expect(parseWorkspace(JSON.stringify(w)).sqlLayout).toEqual(merged);
  });
  it("opens old workspaces in one pane and repairs stale stored references safely", () => {
    expect(restoreSqlLayout(tabs, "b")).toEqual({
      width: 50,
      groups: [{ ids: ["a", "b", "c"], activeId: "b" }],
    });
    expect(
      restoreSqlLayout(tabs, "a", {
        width: 99,
        groups: [
          { ids: ["missing", "a"], activeId: "missing" },
          { ids: ["a", "b"], activeId: "b" },
        ],
      }),
    ).toEqual({
      width: 75,
      groups: [
        { ids: ["a", "c"], activeId: "a" },
        { ids: ["b"], activeId: "b" },
      ],
    });
  });
  it("rejects malformed imported layouts and hidden or duplicate tab ownership", () => {
    const w = createWorkspace(false);
    setSqlTabs(w, tabs, "b", layout);
    for (const invalid of [
      null,
      {},
      { width: NaN, groups: layout.groups },
      { ...layout, width: 80 },
      { ...layout, groups: [] },
      { ...layout, groups: [{ ids: ["a", "b"], activeId: "a" }] },
      {
        ...layout,
        groups: [
          { ids: ["a", "b"], activeId: "a" },
          { ids: ["b", "c"], activeId: "c" },
        ],
      },
      { ...layout, groups: [{ ids: ["a", "b", "c"], activeId: "missing" }] },
    ]) {
      expect(() =>
        parseWorkspace(JSON.stringify({ ...w, sqlLayout: invalid })),
      ).toThrow("SQL split layout");
    }
  });
});

it("applies the new-tab connection only to created tab IDs, including replacement tabs", () => {
  const old = {
    id: "old",
    name: "old.sql",
    sql: "SELECT 1",
    sourceId: "first",
  };
  const edited = { ...old, sql: "SELECT 42" };
  const replacement = {
    id: "new",
    name: "query.sql",
    sql: "",
  };
  expect(bindNewTabs([edited, replacement], [old], "sidebar")).toEqual([
    edited,
    { ...replacement, sourceId: "sidebar" },
  ]);
  expect(bindNewTabs([edited, replacement], [old])).toEqual([
    edited,
    replacement,
  ]);
});

it("keeps the original connection when duplicating a tab on another server", () => {
  const active = { id: "active", name: "active.sql", sql: "", sourceId: "a" };
  const copy = { id: "copy", name: "copy.sql", sql: "SELECT 1", sourceId: "b" };
  expect(bindNewTabs([active, copy], [active], active.sourceId)).toEqual([
    active,
    copy,
  ]);
});
