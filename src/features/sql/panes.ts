import type { SqlTab, SqlLayout } from "../../types/schema";
export type { SqlPaneGroup } from "../../types/schema";
import type { SqlPaneGroup } from "../../types/schema";
export const initialPane = (
  tabs: SqlTab[],
  activeId: string,
): SqlPaneGroup => ({
  ids: tabs.map((tab) => tab.id),
  activeId: tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0].id,
});
export function updatePaneTabs(
  allTabs: SqlTab[],
  groups: SqlPaneGroup[],
  index: number,
  paneTabs: SqlTab[],
  activeId: string,
) {
  const owned = new Set(groups[index].ids);
  const updates = new Map(paneTabs.map((tab) => [tab.id, tab]));
  const tabs = allTabs.flatMap((tab) =>
    owned.has(tab.id)
      ? updates.has(tab.id)
        ? [updates.get(tab.id)!]
        : []
      : [tab],
  );
  const existing = new Set(tabs.map((tab) => tab.id));
  tabs.push(...paneTabs.filter((tab) => !existing.has(tab.id)));
  return {
    tabs,
    groups: groups.map((group, i) =>
      i === index ? initialPane(paneTabs, activeId) : group,
    ),
  };
}
export function splitPane(tabs: SqlTab[], group: SqlPaneGroup) {
  const other = tabs.find((tab) => tab.id !== group.activeId);
  const next = other ?? { id: crypto.randomUUID(), name: "split.sql", sql: "" };
  return {
    tabs: other ? tabs : [...tabs, next],
    groups: [
      { ...group, ids: group.ids.filter((id) => id !== next.id) },
      { ids: [next.id], activeId: next.id },
    ],
  };
}
export function movePaneTab(
  tabs: SqlTab[],
  groups: SqlPaneGroup[],
  index: number,
) {
  const source = groups[index];
  const target = 1 - index;
  const remaining = source.ids.filter((id) => id !== source.activeId);
  let nextTabs = tabs;
  if (!remaining.length) {
    const blank = {
      id: crypto.randomUUID(),
      name: "query.sql",
      sql: "",
      sourceId: tabs.find((tab) => tab.id === source.activeId)?.sourceId,
    };
    nextTabs = [...tabs, blank];
    remaining.push(blank.id);
  }
  return {
    tabs: nextTabs,
    activeId: source.activeId,
    groups: groups.map((group, i) =>
      i === index
        ? { ids: remaining, activeId: remaining[0] }
        : i === target
          ? { ids: [...group.ids, source.activeId], activeId: source.activeId }
          : group,
    ),
  };
}

export function restoreSqlLayout(
  tabs: SqlTab[],
  activeId: string,
  saved?: SqlLayout,
): SqlLayout {
  if (!saved || !Array.isArray(saved.groups))
    return { groups: [initialPane(tabs, activeId)], width: 50 };
  const available = new Set(tabs.map((tab) => tab.id));
  const used = new Set<string>();
  const groups = saved.groups.slice(0, 2).flatMap((group) => {
    if (!group || !Array.isArray(group.ids)) return [];
    const ids = group.ids.filter((id) => {
      if (!available.has(id) || used.has(id)) return false;
      used.add(id);
      return true;
    });
    return ids.length
      ? [
          {
            ids,
            activeId: ids.includes(group.activeId) ? group.activeId : ids[0],
          },
        ]
      : [];
  });
  if (!groups.length) groups.push(initialPane(tabs, activeId));
  else
    groups[0].ids.push(
      ...tabs.filter((tab) => !used.has(tab.id)).map((tab) => tab.id),
    );
  return {
    groups,
    width: Number.isFinite(saved.width)
      ? Math.max(25, Math.min(75, saved.width))
      : 50,
  };
}
export function validSqlLayout(
  value: unknown,
  tabs: SqlTab[],
): value is SqlLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as SqlLayout;
  if (
    !Number.isFinite(layout.width) ||
    layout.width < 25 ||
    layout.width > 75 ||
    !Array.isArray(layout.groups) ||
    layout.groups.length < 1 ||
    layout.groups.length > 2
  )
    return false;
  const ids = new Set<string>();
  for (const group of layout.groups) {
    if (
      !group ||
      !Array.isArray(group.ids) ||
      !group.ids.length ||
      typeof group.activeId !== "string" ||
      !group.ids.includes(group.activeId)
    )
      return false;
    for (const id of group.ids) {
      if (
        typeof id !== "string" ||
        ids.has(id) ||
        !tabs.some((tab) => tab.id === id)
      )
        return false;
      ids.add(id);
    }
  }
  return ids.size === tabs.length;
}
