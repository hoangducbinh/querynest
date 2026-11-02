import { useSqlResults } from "../sql/result-state";
import {
  useConnectionSession,
  requestConnection,
  markConnectionUnavailable,
  NeedsConnection,
} from "./sessions";
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
import { RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { TableDefinition, WorkspaceDefinition } from "../../types/schema";
import { useStore } from "../schema/store";
import { ResultGrid } from "../sample-data/ResultGrid";
import { Spreadsheet } from "../sample-data/Spreadsheet";
import type { DraftRow } from "../sample-data/model";
import { confirmAction } from "../../lib/dialogs";
import { gridChanges, gridSaveError } from "./grid";
import { SqlWorkspace } from "../sql/SqlWorkspace";
import { activeSqlTab, setSqlTabs, sqlTabs } from "../sql/tabs";
import { executeSqlBatch } from "../sql/execution";
import { remoteClient } from "../connections/client";
import { engineName, type RemoteConfig } from "../connections/model";
import { catalogSchema, pgError, type PgCatalog } from "../postgres/model";
import { isTauri, type PgQueryResult } from "../postgres/client";
interface Props {
  workspace: WorkspaceDefinition;
  sessionKey?: string;
  mode: "data" | "sql";
  dark: boolean;
  activeTable?: TableDefinition;
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
  const shared = useConnectionSession(sessionKey, currentConfig);
  const edit = useStore((state) => state.edit);
  const [sessionId, setSessionId] = useState(shared?.sessionId ?? "");
  const session = useRef(shared?.sessionId ?? "");
  const [restoring, setRestoring] = useState(false);
  const [pending, setPending] = useState(false);
  const [queryRunning, setQueryRunning] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useSqlResults(
    `${w.id}:source:${sessionKey}:${JSON.stringify(currentConfig)}`,
  );
  const selection = useRef({ id: "", sql: "" });
  const cancelled = useRef(false);
  const sqlRunning = useRef(false);
  const executionId = useRef(0);
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
    session.current = shared?.sessionId ?? "";
    setSessionId(session.current);
    setRestoring(false);
    if (!shared) {
      if (w.sources && w.activeSourceId)
        void ensureDatabaseSession(w, w.activeSourceId).catch((error) => {
          if (!stale && !(error instanceof NeedsConnection))
            setError(pgError(error));
        });
    } else if (!w.schema.tables.length) {
      setRestoring(true);
      void (
        shared.catalog
          ? Promise.resolve(shared.catalog)
          : client.refresh(shared.sessionId)
      )
        .then((catalog) => {
          if (!stale) applyCatalog(catalog);
        })
        .catch((error) => {
          if (!stale) setError(pgError(error));
        })
        .finally(() => {
          if (!stale) setRestoring(false);
        });
    }
    return () => {
      stale = true;
    };
  }, [shared, sessionKey]);
  const requestConnect = () =>
    requestConnection(w.id, w.activeSourceId ?? "primary");
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
            session.current = "";
            setSessionId("");
            markConnectionUnavailable(sessionKey);
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
        session.current = "";
        setSessionId("");
        markConnectionUnavailable(sessionKey);
        setError(pgError(e));
      }
      throw Error(pgError(e));
    }
  }
  async function run(tabId?: string, suppliedSql?: string) {
    if (!sessionId || pending || sqlRunning.current) return;
    sqlRunning.current = true;
    cancelled.current = false;
    executionId.current++;
    setQueryRunning(true);
    setCancelPending(false);
    const tab = sqlTabs(w).find((item) => item.id === tabId) ?? activeSqlTab(w);
    const sql =
      suppliedSql ??
      (selection.current.id === tab.id && selection.current.sql.trim()
        ? selection.current.sql
        : tab.sql);
    try {
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
    } finally {
      sqlRunning.current = false;
      setQueryRunning(false);
      setCancelPending(false);
    }
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
  return (
    <section className="pg-workspace">
      {error && (
        <div className="sheet-error" role="alert">
          {error}
        </div>
      )}
      {restoring ? (
        <div className="empty-state" role="status">
          Restoring shared connection…
        </div>
      ) : !sessionId ? (
        <div className="empty-state">
          <h2>
            {isTauri()
              ? `Connect to ${label}`
              : "Open this workspace in the desktop app"}
          </h2>
          <p>
            {isTauri()
              ? "Connect once to use SQL and Data in this workspace."
              : "Direct database connections are available in the Tauri desktop app. Your local workspaces still work in the browser."}
          </p>
          {isTauri() && (
            <Button className="primary" onClick={() => requestConnect()}>
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
          cancelPending={cancelPending}
          onCancel={
            queryRunning
              ? () => {
                  if (cancelled.current) return;
                  cancelled.current = true;
                  setCancelPending(true);
                  const requestId = executionId.current;
                  void client.cancel(sessionId).catch((e) => {
                    if (executionId.current !== requestId) return;
                    setError(pgError(e));
                    setCancelPending(false);
                    cancelled.current = false;
                  });
                }
              : undefined
          }
        />
      ) : (
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
    </section>
  );
}
