import { current, isDraft, type Draft } from "immer";
import type {
  WorkspaceDefinition,
  WorkspaceSource,
  SqlTab,
} from "../../types/schema";
import type { ConnectionProfile, RemoteConfig } from "./model";
import { activeSqlTab, sqlTabs, setSqlTabs } from "../sql/tabs";
const clone = <T>(value: T): T =>
  value === undefined
    ? value
    : structuredClone(isDraft(value) ? current<T>(value as Draft<T>) : value);
export const sourceSessionKey = (workspaceId: string, sourceId: string) =>
  `${workspaceId}:source:${sourceId}`;
export function currentSource(w: WorkspaceDefinition): WorkspaceSource {
  return {
    id: w.activeSourceId ?? "primary",
    name: w.sources?.find((s) => s.id === w.activeSourceId)?.name ?? w.name,
    parentSourceId: w.sources?.find((s) => s.id === w.activeSourceId)
      ?.parentSourceId,
    databases: w.sources?.find((s) => s.id === w.activeSourceId)?.databases,
    connectionId: w.connectionId,
    connection: w.mssql
      ? { engine: "mssql", config: w.mssql }
      : w.postgres
        ? { engine: "postgres", config: w.postgres }
        : undefined,
    schema: w.schema,
    data: w.mssql || w.postgres ? {} : w.data,
    diagramPositions: w.diagramPositions,
  };
}
export function workspaceSources(w: WorkspaceDefinition): WorkspaceSource[] {
  const active = currentSource(w);
  return w.sources?.length
    ? w.sources.map((s) => (s.id === active.id ? active : s))
    : [active];
}
export function tabSource(
  w: WorkspaceDefinition,
  tab: SqlTab,
): WorkspaceSource {
  const sources = workspaceSources(w);
  return sources.find((s) => s.id === tab.sourceId) ?? sources[0];
}
export function captureActiveSource(w: WorkspaceDefinition, copy = true) {
  if (!w.sources) return;
  const active = currentSource(isDraft(w) ? current(w) : w);
  w.sources = w.sources.map((s) =>
    s.id === active.id ? (copy ? clone(active) : active) : s,
  );
}
export function activateSource(w: WorkspaceDefinition, sourceId: string) {
  captureActiveSource(w);
  const source = w.sources?.find((s) => s.id === sourceId);
  if (!source) throw Error("Connection was removed from this workspace.");
  w.activeSourceId = source.id;
  w.schema = clone(source.schema);
  w.data = source.connection ? {} : clone(source.data ?? {});
  w.connectionId = source.connectionId;
  w.postgres =
    source.connection?.engine === "postgres"
      ? { ...source.connection.config }
      : undefined;
  w.mssql =
    source.connection?.engine === "mssql"
      ? { ...source.connection.config }
      : undefined;
  w.diagramPositions = clone(source.diagramPositions);
}
export function attachSource(
  w: WorkspaceDefinition,
  profile: ConnectionProfile,
) {
  if (!w.sources) {
    w.sources = [clone(currentSource(isDraft(w) ? current(w) : w))];
    w.activeSourceId = "primary";
    setSqlTabs(
      w,
      sqlTabs(w).map((tab) => ({ ...tab, sourceId: "primary" })),
      w.activeSqlTabId ?? sqlTabs(w)[0].id,
    );
  }
  const existing = w.sources.find((s) => s.connectionId === profile.id);
  if (existing) return existing.id;
  if (w.sources.filter((s) => !s.parentSourceId).length >= 50)
    throw Error("A workspace supports up to 50 connections.");
  const source: WorkspaceSource = {
    id: crypto.randomUUID(),
    name: profile.name,
    connectionId: profile.id,
    connection: clone({
      engine: profile.engine,
      config: profile.config,
    }) as RemoteConfig,
    schema: { tables: [], relationships: [] },
    data: {},
  };
  w.sources.push(source);
  const tabs = sqlTabs(w);
  if (tabs.some((tab) => tab.disconnectedFrom?.profileId === profile.id)) {
    setSqlTabs(
      w,
      tabs.map((tab) => {
        if (tab.disconnectedFrom?.profileId !== profile.id) return tab;
        const { disconnectedFrom, ...rest } = tab;
        return {
          ...rest,
          sourceId: attachDatabase(w, source.id, disconnectedFrom.database),
        };
      }),
      activeSqlTab(w).id,
    );
  }
  return source.id;
}
export function updateSource(
  w: WorkspaceDefinition,
  sourceId: string,
  patch: Partial<WorkspaceSource>,
) {
  const source = w.sources?.find((s) => s.id === sourceId);
  if (!source) throw Error("Connection was removed from this workspace.");
  if (patch.connection && source.parentSourceId) {
    const root = w.sources?.find((s) => s.id === source.parentSourceId);
    if (root?.connection) {
      const rootConfig = clone({
        ...patch.connection,
        config: {
          ...patch.connection.config,
          database: root.connection.config.database,
        },
      }) as RemoteConfig;
      if (JSON.stringify(root.connection) !== JSON.stringify(rootConfig))
        updateSource(w, root.id, { connection: rootConfig });
    }
  }
  const changed =
    patch.connection &&
    JSON.stringify(source.connection) !== JSON.stringify(patch.connection);
  // The active schema/data live on the workspace. Its entry in sources is
  // a snapshot captured on save/switch, just like ordinary local schema edits.
  // Avoid cloning a 75k-column catalog twice during a single refresh.
  const { schema: nextSchema, data: nextData, ...metadata } = patch;
  Object.assign(source, clone(metadata));
  if (w.activeSourceId !== sourceId) {
    if (nextSchema) source.schema = clone(nextSchema);
    if (nextData) source.data = source.connection ? {} : clone(nextData);
  }
  if (changed && !source.parentSourceId) {
    for (const child of w.sources ?? []) {
      if (
        child.parentSourceId !== source.id ||
        !child.connection ||
        !patch.connection
      )
        continue;
      child.connection = clone({
        ...patch.connection,
        config: {
          ...patch.connection.config,
          database: child.connection.config.database,
        },
      }) as RemoteConfig;
      child.schema = { tables: [], relationships: [] };
      if (w.activeSourceId === child.id) {
        w.schema = clone(child.schema);
        w.postgres =
          child.connection.engine === "postgres"
            ? { ...child.connection.config }
            : undefined;
        w.mssql =
          child.connection.engine === "mssql"
            ? { ...child.connection.config }
            : undefined;
      }
    }
    source.databases = undefined;
  }
  if (w.activeSourceId === sourceId) {
    if (patch.schema) w.schema = clone(patch.schema);
    if (patch.data) w.data = source.connection ? {} : clone(patch.data);
    if (patch.connection) {
      w.postgres =
        patch.connection.engine === "postgres"
          ? { ...patch.connection.config }
          : undefined;
      w.mssql =
        patch.connection.engine === "mssql"
          ? { ...patch.connection.config }
          : undefined;
    }
  }
}
export function removeSource(w: WorkspaceDefinition, sourceId: string) {
  ensureSources(w);
  const sources = w.sources!;
  if (!sources.some((source) => source.id === sourceId)) return;
  const removed = new Set(
    sources
      .filter((s) => s.id === sourceId || s.parentSourceId === sourceId)
      .map((s) => s.id),
  );
  let fallback = sources.find((s) => !removed.has(s.id) && !s.connection);
  if (!fallback) {
    fallback = {
      id: crypto.randomUUID(),
      name: w.name,
      schema: { tables: [], relationships: [] },
      data: {},
    };
    sources.push(fallback);
  }
  if (removed.has(w.activeSourceId ?? "primary"))
    activateSource(w, fallback.id);
  const removedSources = sources.filter((s) => removed.has(s.id));
  const root = removedSources.find((s) => s.id === sourceId);
  w.sources = sources.filter((s) => !removed.has(s.id));
  setSqlTabs(
    w,
    sqlTabs(w).map((tab) => {
      const source = removedSources.find(
        (item) => item.id === (tab.sourceId ?? "primary"),
      );
      if (!source) return tab;
      const profileId = root?.connectionId ?? source.connectionId;
      return {
        ...tab,
        sourceId: fallback.id,
        ...(profileId && source.connection
          ? {
              disconnectedFrom: {
                profileId,
                database: source.connection.config.database,
              },
            }
          : {}),
      };
    }),
    w.activeSqlTabId ?? sqlTabs(w)[0].id,
  );
}

export function connectionRoot(
  w: WorkspaceDefinition,
  source: WorkspaceSource,
) {
  return (
    workspaceSources(w).find(
      (s) => s.id === (source.parentSourceId ?? source.id),
    ) ?? source
  );
}
export function databaseSources(w: WorkspaceDefinition, rootId: string) {
  return workspaceSources(w).filter(
    (s) => s.id === rootId || s.parentSourceId === rootId,
  );
}
export function ensureSources(w: WorkspaceDefinition) {
  if (w.sources) return;
  const source = clone(currentSource(isDraft(w) ? current(w) : w));
  w.sources = [source];
  w.activeSourceId = source.id;
  setSqlTabs(
    w,
    sqlTabs(w).map((tab) => ({ ...tab, sourceId: source.id })),
    w.activeSqlTabId ?? sqlTabs(w)[0].id,
  );
}
export function attachDatabase(
  w: WorkspaceDefinition,
  rootId: string,
  database: string,
): string {
  ensureSources(w);
  captureActiveSource(w);
  const root = w.sources!.find((s) => s.id === rootId && !s.parentSourceId);
  if (!root?.connection) throw Error("Remote connection not found.");
  if (!database || database.includes("\0"))
    throw Error("Invalid database name.");
  const existing = w.sources!.find(
    (s) =>
      (s.id === rootId || s.parentSourceId === rootId) &&
      s.connection?.config.database === database,
  );
  if (existing) return existing.id;
  if (w.sources!.length >= 1000)
    throw Error("A workspace supports up to 1,000 database contexts.");
  const child: WorkspaceSource = {
    id: crypto.randomUUID(),
    parentSourceId: rootId,
    name: root.name,
    connection: clone({
      ...root.connection,
      config: { ...root.connection.config, database },
    }) as RemoteConfig,
    schema: { tables: [], relationships: [] },
    data: {},
  };
  w.sources!.push(child);
  return child.id;
}

/** Keep Data on the database selected by the active SQL tab. */
export function syncActiveSqlSource(w: WorkspaceDefinition) {
  if (!w.sources) return;
  const source = tabSource(w, activeSqlTab(w));
  if (source.id !== w.activeSourceId) activateSource(w, source.id);
}
