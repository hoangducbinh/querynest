import type { WorkspaceDefinition, SqlTab } from "../../types/schema";
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
) {
  workspace.sqlTabs = tabs;
  workspace.activeSqlTabId = active;
  workspace.sql = tabs.find((tab) => tab.id === active)!.sql;
}
