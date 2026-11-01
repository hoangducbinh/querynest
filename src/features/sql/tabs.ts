import { restoreSqlLayout } from "./panes";
import type {
  WorkspaceDefinition,
  SqlTab,
  SqlLayout,
} from "../../types/schema";
export function sqlTabs(workspace: WorkspaceDefinition): SqlTab[] {
  return workspace.sqlTabs?.length
    ? workspace.sqlTabs
    : [{ id: "legacy-query", name: "query.sql", sql: workspace.sql }];
}
export function activeSqlTab(workspace: WorkspaceDefinition): SqlTab {
  const tabs = sqlTabs(workspace);
  return tabs.find((tab) => tab.id === workspace.activeSqlTabId) ?? tabs[0];
}
export function setSqlTabs(
  workspace: WorkspaceDefinition,
  tabs: SqlTab[],
  active: string,
  layout?: SqlLayout,
) {
  if (layout || workspace.sqlLayout)
    workspace.sqlLayout = restoreSqlLayout(
      tabs,
      active,
      layout ?? workspace.sqlLayout,
    );
  workspace.sqlTabs = tabs;
  workspace.activeSqlTabId = active;
  workspace.sql = tabs.find((tab) => tab.id === active)!.sql;
}

/** Bind only newly created tabs; existing queries keep their own connections. */
export function bindNewTabs(
  tabs: SqlTab[],
  existing: SqlTab[],
  sourceId?: string,
): SqlTab[] {
  if (!sourceId) return tabs;
  const ids = new Set(existing.map((tab) => tab.id));
  return tabs.map((tab) => (ids.has(tab.id) ? tab : { ...tab, sourceId }));
}
