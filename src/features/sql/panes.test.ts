import { describe, expect, it } from "vitest";
import { initialPane, movePaneTab, splitPane, updatePaneTabs } from "./panes";
const tabs = [
  { id: "a", name: "a.sql", sql: "SELECT 1" },
  { id: "b", name: "b.sql", sql: "SELECT 2" },
  { id: "c", name: "c.sql", sql: "SELECT 3" },
];
describe("independent SQL pane tabs", () => {
  it("assigns each existing tab to exactly one pane", () => {
    const split = splitPane(tabs, initialPane(tabs, "a"));
    expect(split.groups).toEqual([
      { ids: ["a", "c"], activeId: "a" },
      { ids: ["b"], activeId: "b" },
    ]);
    expect(split.tabs).toEqual(tabs);
  });
  it("creates a separate empty tab when splitting a single tab", () => {
    const split = splitPane([tabs[0]], initialPane([tabs[0]], "a"));
    expect(split.tabs).toHaveLength(2);
    expect(split.groups[0].ids).toEqual(["a"]);
    expect(split.groups[1].ids).not.toContain("a");
    expect(split.tabs[1].sql).toBe("");
  });
  it("closing the last right tab leaves left tabs and SQL untouched", () => {
    const split = splitPane(tabs, initialPane(tabs, "a"));
    const blank = { id: "right-new", name: "query.sql", sql: "" };
    const next = updatePaneTabs(split.tabs, split.groups, 1, [blank], blank.id);
    expect(next.tabs).toEqual([tabs[0], tabs[2], blank]);
    expect(next.groups[0]).toEqual(split.groups[0]);
  });
  it("adding, editing, renaming or closing a left tab preserves the right group", () => {
    const split = splitPane(tabs, initialPane(tabs, "a"));
    const edited = { ...tabs[0], name: "renamed.sql", sql: "SELECT 42" };
    const added = { id: "d", name: "new.sql", sql: "SELECT 4" };
    const next = updatePaneTabs(
      split.tabs,
      split.groups,
      0,
      [edited, added],
      added.id,
    );
    expect(next.tabs.find((tab) => tab.id === "b")).toEqual(tabs[1]);
    expect(next.groups[1]).toEqual(split.groups[1]);
    expect(next.tabs.find((tab) => tab.id === "c")).toBeUndefined();
    expect(next.tabs.find((tab) => tab.id === "a")).toEqual(edited);
  });
  it("moves a tab with its identity and SQL, replacing an empty source with a blank tab", () => {
    const split = splitPane(tabs, initialPane(tabs, "a"));
    const next = movePaneTab(split.tabs, split.groups, 1);
    expect(next.groups[0].ids).toEqual(["a", "c", "b"]);
    expect(next.groups[0].activeId).toBe("b");
    expect(next.groups[1].ids).toHaveLength(1);
    expect(next.groups[1].ids).not.toContain("b");
    expect(next.tabs.find((tab) => tab.id === "b")).toEqual(tabs[1]);
    const ids = next.groups.flatMap((group) => group.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(next.tabs.map((tab) => tab.id)));
  });
  it("merging panes preserves all remaining tabs and the selected query", () => {
    const split = splitPane(tabs, initialPane(tabs, "a"));
    const merged = initialPane(split.tabs, "b");
    expect(merged).toEqual({ ids: ["a", "b", "c"], activeId: "b" });
  });
});
