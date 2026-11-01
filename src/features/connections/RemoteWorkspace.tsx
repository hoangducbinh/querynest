import {
  registerOwnedSession,
  retainSession,
  takeSession,
  checkoutConnectionSession,
  type RetainedSession,
} from "./sessions";
import { updateSource } from "./sources";
import { ensureDatabaseSession } from "./databases";
import { RemoteColumnEditor } from "./RemoteColumnEditor";
import type { ColumnContext, ColumnChange } from "./columns";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { RefreshCw, Plug, Unplug } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { TableDefinition, WorkspaceDefinition } from "../../types/schema";
import { useStore } from "../schema/store";
import { Diagram } from "../erd/Diagram";
import { Requirements } from "../test-cases/Requirements";
import { compareResults } from "../test-cases/compare";
import { ResultGrid } from "../sample-data/ResultGrid";
import { Spreadsheet } from "../sample-data/Spreadsheet";
import type { DraftRow } from "../sample-data/model";
import { confirmAction } from "../../lib/dialogs";
import { gridChanges, gridSaveError } from "./grid";
import { SqlWorkspace } from "../sql/SqlWorkspace";
import { activeSqlTab, setSqlTabs, sqlTabs } from "../sql/tabs";
import { executeSqlBatch, type SqlResult } from "../sql/execution";
import { ConnectionDialog } from "../connections/ConnectionDialog";
import { connectRemote, remoteClient } from "../connections/client";
import { engineName, type RemoteConfig } from "../connections/model";
import { storage, saveConnection } from "../../lib/storage/workspaces";
import { catalogSchema, pgError, type PgCatalog } from "../postgres/model";
import { isTauri, type PgQueryResult } from "../postgres/client";
interface Props {
  workspace: WorkspaceDefinition;
  sessionKey?: string;
  mode: "data" | "sql" | "relations" | "tests";
  dark: boolean;
  activeTable?: TableDefinition;
  selected: string;
  onSelect: (id: string) => void;
  runRef: MutableRefObject<() => void>;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
}
export function RemoteWorkspace({
  workspace: w,
  sessionKey = w.id,
  mode,
  dark,
  activeTable,
  selected,
  onSelect,
  runRef,
  onBusy,
  onDirty,
}: Props) {
  const engine = w.mssql ? "mssql" : "postgres";
  const label = engineName(engine);
  const client = remoteClient(engine);
  const currentConfig: RemoteConfig = w.mssql
    ? { engine: "mssql", config: w.mssql }
    : { engine: "postgres", config: w.postgres! };
  const [settings, setSettings] = useState(currentConfig);
  const edit = useStore((s) => s.edit);
  const [sessionId, setSessionId] = useState("");
  const session = useRef("");
  const retained = useRef<RetainedSession | undefined>(undefined);
  useEffect(() => {
    if (!sessionId || !retained.current) return;
    return registerOwnedSession(sessionKey, { ...retained.current, sessionId });
  }, [sessionId, sessionKey]);
  const [version, setVersion] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, SqlResult[]>>({});
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const selection = useRef({ id: "", sql: "" });
  const cancelled = useRef(false);
  const [page, setPage] = useState(0);
  const [gridDirty, setGridDirty] = useState(false);
  const [columnDirty, setColumnDirty] = useState(false);
  const [schemaStale, setSchemaStale] = useState(false);
  const [columnEditor, setColumnEditor] = useState<{
    context: ColumnContext;
    columnId?: string;
    anchor: HTMLButtonElement;
  } | null>(null);
  const reportDirty = useCallback((dirty: boolean) => setGridDirty(dirty), []);
  useEffect(() => {
    onDirty(gridDirty || columnDirty);
    return () => onDirty(false);
  }, [gridDirty, columnDirty, onDirty]);
  async function leaveGrid() {
    return (
      !gridDirty ||
      (await confirmAction("Discard unsaved grid changes and continue?"))
    );
  }
  const [data, setData] = useState<PgQueryResult>();
  const [dataLoading, setDataLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const tableId = activeTable?.id;
  const applyCatalog = useCallback(
    (catalog: PgCatalog) => {
      setSchemaStale(false);
      edit((d) => {
        d.schema = catalogSchema(catalog);
        d.data = {};
      });
    },
    [edit],
  );
  useEffect(() => {
    let stale = false;
    async function prepare() {
      const profile = w.connectionId
        ? await storage.connections.get(w.connectionId)
        : undefined;
      if (stale) return;
      const config =
        profile && profile.engine === engine ? profile : currentConfig;
      setSettings(config);
      if (w.sources && w.activeSourceId) {
        try {
          await ensureDatabaseSession(w, w.activeSourceId);
        } catch {
          /* The connection dialog handles expired sessions. */
        }
      }
      const saved =
        (await checkoutConnectionSession(sessionKey, config)) ??
        (w.sources && w.activeSourceId === "primary"
          ? takeSession(w.id, config)
          : undefined);
      if (stale) {
        if (saved) retainSession(sessionKey, saved);
        return;
      }
      if (saved) {
        session.current = saved.sessionId;
        retained.current = saved;
        try {
          const catalog = await client.refresh(saved.sessionId);
          if (stale) return;
          setSessionId(saved.sessionId);
          setVersion(saved.serverVersion);
          applyCatalog(catalog);
          return;
        } catch (error) {
          if (stale) return;
          session.current = "";
          retained.current = undefined;
          void client.disconnect(saved.sessionId).catch(() => {});
          setError(pgError(error));
        }
      }
      if (!stale) setConnecting(isTauri());
    }
    void prepare().catch((e) => setError(pgError(e)));
    return () => {
      stale = true;
    };
    // Each workspace has an independent session.
  }, []);
  async function openSettings() {
    if (!(await leaveGrid())) return;
    const profile = w.connectionId
      ? await storage.connections.get(w.connectionId)
      : undefined;
    setSettings(profile && profile.engine === engine ? profile : currentConfig);
    setConnecting(true);
  }
  useEffect(
    () => () => {
      if (session.current && retained.current)
        retainSession(sessionKey, {
          ...retained.current,
          sessionId: session.current,
        });
    },
    [],
  );
  useEffect(() => {
    setPage(0);
    setData(undefined);
  }, [tableId]);
  useEffect(() => {
    if (mode !== "data" || !sessionId || !tableId) {
      setDataLoading(false);
      return;
    }
    let stale = false;
    setDataLoading(true);
    setData(undefined);
    setError("");
    void client
      .page(sessionId, tableId, page)
      .then((result) => {
        if (!stale) setData(result);
      })
      .catch((e) => {
        if (!stale) {
          setError(pgError(e));
          if (e && typeof e === "object" && "closed" in e && e.closed) {
            const old = session.current;
            session.current = "";
            setSessionId("");
            void client.disconnect(old).catch(() => {});
          }
        }
      })
      .finally(() => {
        if (!stale) setDataLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [sessionId, tableId, page, mode, refresh]);
  async function task(fn: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    onBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(pgError(e));
    } finally {
      setPending(false);
      onBusy(false);
    }
  }
  async function connect(value: RemoteConfig, password: string) {
    onBusy(true);
    try {
      const result = await connectRemote(value, password);
      try {
        if (w.connectionId) {
          const profile = await storage.connections.get(w.connectionId);
          if (profile)
            await saveConnection({
              ...profile,
              ...value,
              updatedAt: Date.now(),
            });
        }
      } catch (e) {
        await client.disconnect(result.sessionId).catch(() => {});
        throw e;
      }
      const old = session.current;
      session.current = result.sessionId;
      retained.current = {
        sessionId: result.sessionId,
        serverVersion: result.serverVersion,
        config: value,
        disconnect: client.disconnect,
      };
      setSessionId(result.sessionId);
      setVersion(result.serverVersion);
      setResults({});
      setData(undefined);
      setTestResults({});
      setPage(0);
      setSchemaStale(false);
      setColumnEditor(null);
      edit((d) => {
        if (d.sources && d.activeSourceId)
          updateSource(d, d.activeSourceId, {
            connection: value,
            schema: catalogSchema(result.catalog),
          });
        if (value.engine === "postgres") d.postgres = value.config;
        else d.mssql = value.config;
        d.schema = catalogSchema(result.catalog);
        d.data = {};
        if (
          d.name === "PostgreSQL workspace" ||
          d.name === "SQL Server workspace"
        )
          d.name = value.config.database + " · " + label;
      });
      if (old) await client.disconnect(old).catch(() => {});
      setError("");
    } finally {
      onBusy(false);
    }
  }
  async function query(sql: string) {
    if (cancelled.current)
      throw Error("Execution cancelled. Remaining statements were skipped.");
    const start = performance.now();
    try {
      const result = await client.query(sessionId, sql);
      const describe = (set: PgQueryResult) => ({
        ...set,
        status: `${set.columns.length ? set.rows.length + " rows" : engine === "mssql" ? "Completed" : set.affectedRows + " rows affected"}${set.truncated ? " · limited to 1,000 rows" : ""} · ${Math.round(performance.now() - start)} ms`,
      });
      return {
        ...describe(result),
        resultSets: result.resultSets?.map(describe),
      };
    } catch (e) {
      if (e && typeof e === "object" && "closed" in e && e.closed) {
        const old = session.current;
        session.current = "";
        setSessionId("");
        void client.disconnect(old).catch(() => {});
        setError(pgError(e));
      }
      throw Error(pgError(e));
    }
  }
  async function run(tabId?: string, suppliedSql?: string) {
    if (!sessionId || pending) return;
    cancelled.current = false;
    const tab = sqlTabs(w).find((item) => item.id === tabId) ?? activeSqlTab(w);
    const sql =
      suppliedSql ??
      (selection.current.id === tab.id && selection.current.sql.trim()
        ? selection.current.sql
        : tab.sql);
    await task(async () => {
      setResults((current) => ({ ...current, [tab.id]: [] }));
      const output = await executeSqlBatch(
        sql,
        query,
        engine === "mssql" ? "mssql" : "default",
      );
      setResults((current) => ({ ...current, [tab.id]: output }));
      setRefresh((n) => n + 1);
    });
  }
  runRef.current = () => {
    if (mode === "sql") void run();
  };
  const validate = useCallback(
    (sql: string) => remoteClient(engine).validate(sessionId, sql),
    [sessionId, engine],
  );
  async function reloadPage() {
    if (!tableId) throw Error("Choose a table first.");
    const result = await client.page(sessionId, tableId, page);
    setData(result);
    return result.rows;
  }
  async function saveRows(rows: DraftRow[]) {
    if (!tableId) throw Error("Choose a table first.");
    setPending(true);
    onBusy(true);
    setError("");
    try {
      const changes = gridChanges(rows);
      if (!changes.length) return data?.rows ?? [];
      try {
        await client.save(sessionId, tableId, changes);
      } catch (e) {
        throw gridSaveError(e);
      }
      // A successful COMMIT must never be submitted again if refreshing fails.
      try {
        const next = await reloadPage();
        if (!next.length && page > 0) setPage((p) => p - 1);
        return next;
      } catch (e) {
        setData(undefined);
        setError(
          `Changes were saved, but the page could not refresh: ${pgError(e)}. Refresh before editing again.`,
        );
        return [];
      }
    } finally {
      setPending(false);
      onBusy(false);
    }
  }
  async function discardRows() {
    setPending(true);
    onBusy(true);
    setError("");
    try {
      return await reloadPage();
    } catch (e) {
      throw Error(pgError(e));
    } finally {
      setPending(false);
      onBusy(false);
    }
  }
  async function changeDataPage(next: number) {
    if (pending || dataLoading || !(await leaveGrid())) return;
    setPage(next);
  }
  async function refreshData() {
    if (pending || dataLoading || !(await leaveGrid())) return;
    setRefresh((n) => n + 1);
  }
  const readOnlyReason = currentConfig.config.readOnly
    ? `Read-only connection. Open Connection and disable ${engine === "mssql" ? "Query-only guard" : "Read-only connection"} to edit data.`
    : activeTable?.readOnly
      ? "Views and foreign tables are read-only in the grid. Use SQL to change data."
      : undefined;
  async function openColumn(anchor: HTMLButtonElement, columnId?: string) {
    if (
      !tableId ||
      pending ||
      dataLoading ||
      readOnlyReason ||
      schemaStale ||
      !data
    )
      return;
    if (gridDirty) {
      setError("Save or discard row changes before changing columns.");
      return;
    }
    await task(async () => {
      const context = await client.columnContext(sessionId, tableId);
      setColumnEditor({ context, columnId, anchor });
    });
  }
  async function commitColumn(change: ColumnChange) {
    if (!tableId) throw Error("Choose a table first.");
    setPending(true);
    onBusy(true);
    setError("");
    try {
      try {
        await client.changeColumn(sessionId, tableId, change);
      } catch (e) {
        const error = gridSaveError(e);
        if (error.requiresRefresh) {
          setSchemaStale(true);
          setData(undefined);
        }
        throw error;
      }
      // DDL already committed: never leave a retryable draft if refresh fails.
      try {
        applyCatalog(await client.refresh(sessionId));
        setPage(0);
        setRefresh((n) => n + 1);
      } catch (e) {
        setSchemaStale(true);
        setData(undefined);
        setError(
          `Column changes were committed, but metadata refresh failed: ${pgError(e)}. Refresh the schema before editing again.`,
        );
      }
    } finally {
      setPending(false);
      onBusy(false);
    }
  }
  async function runTests(id?: string) {
    if (!sessionId) return;
    cancelled.current = false;
    await task(async () => {
      for (const test of w.tests.filter((t) => !id || t.id === id)) {
        try {
          const expected = JSON.parse(test.expected);
          if (!Array.isArray(expected))
            throw Error("Expected rows must be a JSON array.");
          const actual = await query(test.sql);
          if (
            "resultSets" in actual &&
            Array.isArray(actual.resultSets) &&
            actual.resultSets.length > 1
          )
            throw Error("Tests must return a single result set.");
          if (actual.truncated)
            throw Error("Result exceeds 1,000 rows; narrow this test query.");
          setTestResults((r) => ({
            ...r,
            [test.id]:
              (compareResults(actual.rows, expected, test.ordered)
                ? "PASS"
                : "FAIL") +
              " · " +
              JSON.stringify(actual.rows),
          }));
        } catch (e) {
          setTestResults((r) => ({ ...r, [test.id]: "ERROR · " + pgError(e) }));
        }
      }
    });
  }
  return (
    <section className="pg-workspace">
      <div className="compact-toolbar pg-connection-bar">
        <span className="toolbar-count">
          {label}
          {sessionId
            ? ` ${version} · ${currentConfig.config.database}@${currentConfig.config.host} · ${currentConfig.config.readOnly ? (engine === "mssql" ? "Query-only" : "Read only") : "Read/write"}`
            : " · Disconnected"}
        </span>
        <div className="row">
          <Button
            disabled={!isTauri() || pending || dataLoading}
            onClick={() =>
              void openSettings().catch((e) => setError(pgError(e)))
            }
          >
            <Plug size={13} />
            {sessionId ? "Connection" : "Connect"}
          </Button>
          {sessionId && (
            <>
              <Button
                title="Refresh database schema"
                disabled={pending}
                onClick={() =>
                  void (async () => {
                    if (!(await leaveGrid())) return;
                    await task(async () => {
                      applyCatalog(await client.refresh(sessionId));
                      setRefresh((n) => n + 1);
                    });
                  })()
                }
              >
                <RefreshCw size={13} />
              </Button>
              <Button
                title="Disconnect database"
                disabled={pending || dataLoading}
                onClick={() =>
                  void (async () => {
                    if (!(await leaveGrid())) return;
                    await task(async () => {
                      const old = session.current;
                      session.current = "";
                      setSessionId("");
                      setResults({});
                      setData(undefined);
                      await client.disconnect(old);
                    });
                  })()
                }
              >
                <Unplug size={13} />
              </Button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="sheet-error" role="alert">
          {error}
        </div>
      )}
      {!sessionId ? (
        <div className="empty-state">
          <h2>
            {isTauri()
              ? `Connect to ${label}`
              : "Open this workspace in the desktop app"}
          </h2>
          <p>
            {isTauri()
              ? "Connect to browse tables and run SQL against your database."
              : "Direct database connections are available in the Tauri desktop app. Your local workspaces still work in the browser."}
          </p>
          {isTauri() && (
            <Button
              className="primary"
              onClick={() =>
                void openSettings().catch((e) => setError(pgError(e)))
              }
            >
              Connect
            </Button>
          )}
        </div>
      ) : mode === "sql" ? (
        <SqlWorkspace
          tabs={sqlTabs(w)}
          activeId={activeSqlTab(w).id}
          layout={w.sqlLayout}
          onLayoutChange={(layout) =>
            edit((d) => {
              d.sqlLayout = layout;
            })
          }
          onTabsChange={(tabs, active, layout) =>
            edit((d) => setSqlTabs(d, tabs, active, layout))
          }
          value={activeSqlTab(w).sql}
          onChange={(sql) =>
            edit((d) => {
              const tabs = sqlTabs(d);
              tabs.find((t) => t.id === activeSqlTab(d).id)!.sql = sql;
              setSqlTabs(d, tabs, activeSqlTab(d).id);
            })
          }
          onRun={(tabId, sql) => void run(tabId, sql)}
          disabled={pending}
          busy={pending}
          dark={dark}
          allResults={results}
          queryResults={results[activeSqlTab(w).id]}
          onSelection={(sql, tabId) => {
            selection.current = { id: tabId ?? activeSqlTab(w).id, sql };
          }}
          validate={validate}
          validationSource={label}
          onCancel={() => {
            cancelled.current = true;
            void client
              .cancel(sessionId)
              .then(() => {
                if (engine === "mssql") {
                  session.current = "";
                  setSessionId("");
                  setError(
                    "Query stopped. Reconnect to continue; open transactions are rolled back by SQL Server.",
                  );
                }
              })
              .catch((e) => setError(pgError(e)));
          }}
        />
      ) : mode === "data" ? (
        <div className="pg-data">
          <div className="compact-toolbar">
            <span>
              {activeTable
                ? `${activeTable.namespace}.${activeTable.name}`
                : "Choose a table"}
            </span>
            <div className="row">
              <span className="toolbar-count">
                100 rows/page
                {!activeTable?.primaryKey.length && !readOnlyReason
                  ? " · Insert only — primary key required to edit/delete"
                  : ""}
              </span>
              <Button
                title="Refresh table data"
                disabled={dataLoading || pending}
                onClick={() => void refreshData()}
              >
                <RefreshCw size={13} />
              </Button>
            </div>
          </div>
          {dataLoading ? (
            <div className="empty-state">Loading rows…</div>
          ) : activeTable ? (
            <Spreadsheet
              key={`${sessionId}:${tableId}:${page}:${refresh}`}
              table={activeTable}
              rows={data?.rows ?? []}
              disabled={pending || !data || !!readOnlyReason || schemaStale}
              structureDisabled={
                pending || !data || !!readOnlyReason || schemaStale
              }
              onAddColumn={(anchor) => void openColumn(anchor)}
              onEditColumn={(columnId, anchor) =>
                void openColumn(anchor, columnId)
              }
              onDirty={reportDirty}
              onSave={saveRows}
              onDiscard={discardRows}
              readOnlyReason={readOnlyReason}
              serverPage={{
                index: page,
                hasNext: !!data?.truncated,
                onChange: (next) => void changeDataPage(next),
              }}
            />
          ) : (
            <ResultGrid rows={[]} columns={[]} />
          )}
        </div>
      ) : mode === "relations" ? (
        <div className="design-view">
          <div className="design-workspace">
            <div className="diagram">
              <Diagram select={onSelect} selected={selected} />
            </div>
          </div>
        </div>
      ) : (
        <Requirements
          results={testResults}
          onRun={(id) => void runTests(id)}
          disabled={pending}
        />
      )}
      {columnEditor && (
        <RemoteColumnEditor
          context={columnEditor.context}
          columnId={columnEditor.columnId}
          engine={engine}
          anchor={columnEditor.anchor}
          dark={dark}
          onClose={() => setColumnEditor(null)}
          onCommit={commitColumn}
          onDirty={setColumnDirty}
        />
      )}
      {connecting && isTauri() && (
        <ConnectionDialog
          initial={settings}
          onConnect={connect}
          onClose={() => setConnecting(false)}
        />
      )}
    </section>
  );
}
