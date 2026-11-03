import { editableResult } from "../sql/editable-result";
import { saveGridChanges } from "../sample-data/mutations";
import { saveQueryResult } from "./save-query-result";
import { useSqlResults } from "../sql/result-state";
import {
  listDatabases,
  withDatabaseSession,
  ensureDatabaseSession,
} from "./databases";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { WorkspaceDefinition, WorkspaceSource } from "../../types/schema";
import { useStore } from "../schema/store";
import { SqlWorkspace } from "../sql/SqlWorkspace";
import { activeSqlTab, sqlTabs, setSqlTabs } from "../sql/tabs";
import {
  executeSqlBatch,
  sqlMayChangeSchema,
  type SqlResult,
} from "../sql/execution";
import { validateSql } from "../sql/diagnostics";
import {
  queryCancelable,
  cancelLocalQuery,
  rebuild,
  snapshot,
  withSqlValidator,
} from "../../lib/duckdb/engine";
import { catalogSchema, pgError } from "../postgres/model";
import { isTauri } from "../postgres/client";
import { remoteClient } from "./client";
import { engineName } from "./model";
import {
  NeedsConnection,
  useSessionRevision,
  markConnectionUnavailable,
  requestConnection,
  getSession,
} from "./sessions";
import {
  attachDatabase,
  syncActiveSqlSource,
  connectionRoot,
  databaseSources,
  sourceSessionKey,
  tabSource,
  updateSource,
  workspaceSources,
} from "./sources";
export function MultiSqlWorkspace({
  workspace: w,
  connectionHost,
  dark,
  busy,
  onBusy,
  runRef,
}: {
  workspace: WorkspaceDefinition;
  connectionHost?: HTMLElement | null;
  dark: boolean;
  busy: boolean;
  onBusy: (value: boolean) => void;
  runRef: MutableRefObject<() => void>;
}) {
  const edit = useStore((state) => state.edit);
  const [results, setResults, resultContexts] = useSqlResults(w.id);
  const [error, setError] = useState("");
  const revision = useSessionRevision();
  const selection = useRef({ tabId: "", sql: "" });
  const running = useRef(false);
  const executionId = useRef(0);
  const [queryRunning, setQueryRunning] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const cancelled = useRef(false);
  const localReady = useRef("");
  const localStarting = useRef<Promise<void> | null>(null);
  const resultContext = (source: WorkspaceSource) =>
    JSON.stringify([source.id, source.connection]);
  const activeRun = useRef<{
    source: WorkspaceSource;
    sessionId: string;
  } | null>(null);
  const sources = workspaceSources(w);
  const activeSource = tabSource(w, activeSqlTab(w));
  const activeSourceId = activeSource.id;
  useEffect(() => {
    if (activeSourceId !== w.activeSourceId)
      edit((draft) => syncActiveSqlSource(draft));
  }, [activeSourceId, w.activeSourceId, edit]);
  const activeConnectionSignature = JSON.stringify(activeSource.connection);
  useEffect(() => {
    if (!activeSource.connection || !isTauri()) return;
    const source = activeSource;
    let stale = false;
    void ensureDatabaseSession(w, source.id)
      .then(() => {
        const cached = getSession(
          sourceSessionKey(w.id, source.id),
          source.connection!,
        )?.catalog;
        if (
          !stale &&
          cached &&
          !source.schema.tables.length &&
          useStore.getState().workspace.id === w.id
        )
          edit((draft) => {
            if (draft.sources?.some((item) => item.id === source.id))
              updateSource(draft, source.id, { schema: catalogSchema(cached) });
          });
      })
      .catch((error) => {
        if (!stale && !(error instanceof NeedsConnection))
          setError(pgError(error));
      });
    return () => {
      stale = true;
    };
  }, [w.id, activeSourceId, activeConnectionSignature]);
  function sourceFor(tabId: string) {
    const tab = sqlTabs(w).find((tab) => tab.id === tabId);
    if (!tab) throw Error("SQL tab was closed.");
    return tabSource(w, tab);
  }
  async function ensureLocal(source: WorkspaceSource) {
    const signature = JSON.stringify([w.id, source.id, source.schema]);
    if (localStarting.current) await localStarting.current;
    if (localReady.current === signature) return;
    const starting = rebuild({
      ...w,
      schema: source.schema,
      data: source.data ?? {},
      postgres: undefined,
      mssql: undefined,
    });
    localStarting.current = starting;
    try {
      await starting;
      localReady.current = signature;
    } finally {
      if (localStarting.current === starting) localStarting.current = null;
    }
  }
  async function run(tabId = activeSqlTab(w).id, suppliedSql?: string) {
    if (busy || running.current) return;
    const tab = sqlTabs(w).find((tab) => tab.id === tabId);
    if (!tab) return;
    const source = sourceFor(tabId);
    const text =
      suppliedSql ??
      (selection.current.tabId === tab.id && selection.current.sql.trim()
        ? selection.current.sql
        : tab.sql);
    if (!text.trim()) return;
    running.current = true;
    executionId.current++;
    cancelled.current = false;
    setQueryRunning(true);
    setCancelPending(false);
    onBusy(true);
    setError("");
    try {
      setResults((previous) => ({ ...previous, [tab.id]: [] }));
      let output: SqlResult[];
      if (source.connection) {
        if (!isTauri())
          throw Error(
            "Open the desktop app to use PostgreSQL and SQL Server connections.",
          );
        const config = source.connection;
        const client = remoteClient(config.engine);
        output = await withDatabaseSession(w, source, async (session) => {
          if (cancelled.current) throw Error("Query stopped before execution.");
          activeRun.current = { source, sessionId: session.sessionId };
          const value = await executeSqlBatch(
            text,
            async (sql) => {
              if (cancelled.current)
                throw Error(
                  "Execution cancelled. Remaining statements were skipped.",
                );
              const start = performance.now();
              const result = await client
                .query(session.sessionId, sql)
                .catch((error) => {
                  if (
                    error &&
                    typeof error === "object" &&
                    "closed" in error &&
                    error.closed
                  )
                    markConnectionUnavailable(
                      sourceSessionKey(w.id, source.id),
                    );
                  throw error;
                });
              const describe = (set: typeof result) => ({
                ...set,
                status: `${set.columns.length ? set.rows.length + " rows" : "Completed"}${set.truncated ? " · limited to 1,000 rows" : ""} · ${Math.round(performance.now() - start)} ms`,
              });
              return {
                ...describe(result),
                resultSets: result.resultSets?.map(describe),
              };
            },
            config.engine === "mssql" ? "mssql" : "default",
          );
          setQueryRunning(false);
          if (
            !cancelled.current &&
            sqlMayChangeSchema(
              text,
              config.engine === "mssql" ? "mssql" : "default",
            )
          )
            try {
              const schema = catalogSchema(
                await client.refresh(session.sessionId),
              );
              edit((draft) => updateSource(draft, source.id, { schema }));
            } catch {
              setError(
                "SQL completed. Refresh the connection schema before editing data if the schema changed.",
              );
            }
          return value;
        });
      } else {
        await ensureLocal(source);
        output = await executeSqlBatch(text, async (sql) => {
          if (cancelled.current)
            throw Error("Query stopped. Remaining statements were skipped.");
          return queryCancelable(sql);
        });
        setQueryRunning(false);
        const data = await snapshot({ ...w, schema: source.schema });
        edit((draft) => updateSource(draft, source.id, { data }));
      }
      resultContexts[tab.id] = resultContext(source);
      setResults((previous) => ({ ...previous, [tab.id]: output }));
    } catch (e) {
      if (e instanceof NeedsConnection) requestConnection(w.id, source.id);
      else setError(pgError(e));
    } finally {
      activeRun.current = null;
      running.current = false;
      setQueryRunning(false);
      setCancelPending(false);
      onBusy(false);
    }
  }
  runRef.current = () => {
    void run();
  };
  return (
    <section className="multi-sql-workspace">
      {error && (
        <div className="sheet-error" role="alert">
          {error}
        </div>
      )}
      <SqlWorkspace
        connectionHost={connectionHost}
        tabs={sqlTabs(w)}
        activeId={activeSqlTab(w).id}
        layout={w.sqlLayout}
        onLayoutChange={(layout) =>
          edit((draft) => {
            draft.sqlLayout = layout;
          })
        }
        onTabsChange={(tabs, active, layout) =>
          edit((draft) => {
            setSqlTabs(draft, tabs, active, layout);
            syncActiveSqlSource(draft);
          })
        }
        value={activeSqlTab(w).sql}
        onChange={() => {}}
        onRun={(tabId, sql) => void run(tabId, sql)}
        disabled={busy}
        busy={busy}
        dark={dark}
        onEditingResult={onBusy}
        getEditableResult={(tabId, result) => {
          const source = sourceFor(tabId);
          if (source.connection?.config.readOnly) return undefined;
          return editableResult(
            result,
            source.schema,
            source.connection?.engine ?? "default",
          );
        }}
        onSaveResult={async (tabId, result, drafts, index) => {
          const source = sourceFor(tabId);
          let rows: Record<string, unknown>[];
          if (source.connection) {
            rows = await saveQueryResult(w, source, result, drafts);
          } else {
            const table = editableResult(result, source.schema, "default");
            if (!table)
              throw Error(
                "Only full rows from a single table with a primary key can be edited.",
              );
            await ensureLocal(source);
            const data = await saveGridChanges(
              { ...w, schema: source.schema, data: source.data ?? {} },
              table,
              drafts,
            );
            edit((draft) => updateSource(draft, source.id, { data }));
            rows = (await queryCancelable(result.sql)).rows;
          }
          setResults((previous) => ({
            ...previous,
            [tabId]: previous[tabId].map((item, position) =>
              position === index
                ? { ...item, rows, status: `${rows.length} rows · updated` }
                : item,
            ),
          }));
          return rows;
        }}
        allResults={Object.fromEntries(
          Object.entries(results).filter(([tabId]) => {
            const tab = sqlTabs(w).find((tab) => tab.id === tabId);
            return (
              tab && resultContexts[tabId] === resultContext(tabSource(w, tab))
            );
          }),
        )}
        onSelection={(sql, tabId) => {
          selection.current = { tabId: tabId ?? activeSqlTab(w).id, sql };
        }}
        newTabSourceId={w.activeSourceId ?? sources[0].id}
        newTabConnectionName={(() => {
          const source =
            sources.find((s) => s.id === w.activeSourceId) ?? sources[0];
          return source.connection
            ? connectionRoot(w, source).name +
                " / " +
                source.connection.config.database
            : "Local DuckDB";
        })()}
        connectionOptions={sources
          .filter((source) => !source.parentSourceId)
          .map((source) => ({
            id: source.id,
            name: source.connection ? source.name : "Local DuckDB",
          }))}
        getTabContext={(tabId) => {
          const source = sourceFor(tabId);
          return {
            connectionRootId: connectionRoot(w, source).id,
            database: source.connection?.config.database,
            databases: source.connection
              ? [
                  ...new Set([
                    source.connection.config.database,
                    ...(connectionRoot(w, source).databases ?? []),
                    ...databaseSources(w, connectionRoot(w, source).id).flatMap(
                      (s) =>
                        s.connection ? [s.connection.config.database] : [],
                    ),
                  ]),
                ].sort((a, b) => a.localeCompare(b))
              : undefined,
            sourceId: source.id,
            schema: source.schema,
            dialect:
              source.connection?.engine === "mssql"
                ? "mssql"
                : source.connection
                  ? "postgres"
                  : "default",
            label: source.connection
              ? engineName(source.connection.engine)
              : "DuckDB",
            remote: !!source.connection,
          };
        }}
        onDiscoverTabDatabases={(tabId) => {
          const source = sourceFor(tabId);
          const root = connectionRoot(w, source);
          if (!root.connection || root.databases) return;
          void listDatabases(w, source)
            .then((databases) => {
              if (useStore.getState().workspace.id === w.id)
                edit((draft) => updateSource(draft, root.id, { databases }));
            })
            .catch((e) => {
              if (e instanceof NeedsConnection)
                requestConnection(w.id, source.id);
              else setError(pgError(e));
            });
        }}
        onTabDatabaseChange={(tabId, database) => {
          setResults((previous) => {
            const next = { ...previous };
            delete next[tabId];
            return next;
          });
          const source = sourceFor(tabId);
          const root = connectionRoot(w, source);
          selection.current = { tabId, sql: "" };
          edit((draft) => {
            const sourceId = attachDatabase(draft, root.id, database);
            setSqlTabs(
              draft,
              sqlTabs(draft).map((tab) =>
                tab.id === tabId ? { ...tab, sourceId } : tab,
              ),
              tabId,
            );
            syncActiveSqlSource(draft);
          });
          const current = useStore.getState().workspace;
          const target = tabSource(
            current,
            sqlTabs(current).find((tab) => tab.id === tabId)!,
          );
          void withDatabaseSession(current, target, (session) =>
            remoteClient(target.connection!.engine).refresh(session.sessionId),
          )
            .then((catalog) => {
              if (useStore.getState().workspace.id === w.id)
                edit((draft) =>
                  updateSource(draft, target.id, {
                    schema: catalogSchema(catalog),
                  }),
                );
            })
            .catch((e) => {
              if (e instanceof NeedsConnection)
                requestConnection(w.id, target.id);
              else setError(pgError(e));
            });
        }}
        onTabConnectionChange={(tabId, sourceId) => {
          selection.current = { tabId, sql: "" };
          setResults((previous) => {
            const next = { ...previous };
            delete next[tabId];
            return next;
          });
          edit((draft) => {
            setSqlTabs(
              draft,
              sqlTabs(draft).map((tab) =>
                tab.id === tabId ? { ...tab, sourceId } : tab,
              ),
              tabId,
            );
            syncActiveSqlSource(draft);
          });
        }}
        validationSource={String(revision)}
        validateTab={async (tabId, sql) => {
          const source = sourceFor(tabId);
          if (source.connection) {
            const config = source.connection;
            if (!isTauri()) return [];
            return withDatabaseSession(w, source, (session) =>
              remoteClient(config.engine).validate(session.sessionId, sql),
            );
          }
          if (running.current) return [];
          await ensureLocal(source);
          return withSqlValidator((prepare) => validateSql(sql, prepare));
        }}
        cancelPending={cancelPending}
        onCancel={
          queryRunning
            ? () => {
                if (cancelled.current) return;
                cancelled.current = true;
                setCancelPending(true);
                const requestId = executionId.current;
                const active = activeRun.current;
                if (!active?.source.connection) {
                  void cancelLocalQuery().catch((error) => {
                    if (executionId.current !== requestId || !running.current)
                      return;
                    cancelled.current = false;
                    setError(pgError(error));
                    setCancelPending(false);
                  });
                  return;
                }
                const config = active.source.connection;
                void remoteClient(config.engine)
                  .cancel(active.sessionId)
                  .catch((error) => {
                    if (executionId.current !== requestId || !running.current)
                      return;
                    setError(pgError(error));
                    setCancelPending(false);
                    // Permit retry if the transport rejected the cancellation request.
                    cancelled.current = false;
                  });
              }
            : undefined
        }
      />
    </section>
  );
}
