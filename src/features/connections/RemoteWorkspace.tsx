import { editableResult } from "../sql/editable-result";
import { saveQueryResult } from "./save-query-result";
import { currentSource } from "./sources";
import {
  cachedTablePage,
  loadTablePage,
  invalidateTable,
  tableState,
} from "./table-state";
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
  useMemo,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { LoaderCircle, RefreshCw, Rows3, Table2, X } from "lucide-react";
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
const EMPTY_ROWS: Record<string, unknown>[] = [];
interface Props {
  workspace: WorkspaceDefinition;
  sessionKey?: string;
  mode: "data" | "sql";
  dark: boolean;
  activeTable?: TableDefinition;
  openTables?: TableDefinition[];
  dataLayout?: "tabs" | "stack";
  onDataLayoutChange?: (layout: "tabs" | "stack") => void;
  onSelectTable?: (tableId: string) => void;
  onCloseTable?: (tableId: string) => void;
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
  openTables = activeTable ? [activeTable] : [],
  dataLayout = "tabs",
  onDataLayoutChange,
  onSelectTable,
  onCloseTable,
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
  const tableId = activeTable?.id;
  const cacheScope = `${sessionId}:${sessionKey}`;
  const [, setPageRevision] = useState(0);
  const page = tableId ? tableState(cacheScope, tableId).page : 0;
  const tableSignature = useMemo(
    () => JSON.stringify(activeTable),
    [activeTable],
  );
  function setPage(next: number | ((previous: number) => number)) {
    if (!tableId) return;
    const state = tableState(cacheScope, tableId);
    state.page = typeof next === "function" ? next(state.page) : next;
    setPageRevision((revision) => revision + 1);
  }
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
  const [collapsedStackTables, setCollapsedStackTables] = useState<Set<string>>(
    () => new Set(),
  );
  const [stackTableHeights, setStackTableHeights] = useState<
    Record<string, number>
  >({});
  const stackResizeDrag = useRef<{
    tableId: string;
    startY: number;
    startHeight: number;
  } | null>(null);
  useEffect(() => {
    if (
      mode !== "data" ||
      dataLayout !== "stack" ||
      !sessionId ||
      openTables.length <= 1
    ) {
      return;
    }
    let stale = false;
    for (const tbl of openTables) {
      const tblPage = tableState(cacheScope, tbl.id).page;
      const sig = JSON.stringify(tbl);
      if (!cachedTablePage(cacheScope, tbl.id, tblPage, sig)) {
        void loadTablePage(cacheScope, tbl.id, tblPage, sig, () =>
          client.page(sessionId, tbl.id, tblPage),
        )
          .then(() => {
            if (!stale) setPageRevision((r) => r + 1);
          })
          .catch(() => {});
      }
    }
    return () => {
      stale = true;
    };
  }, [mode, dataLayout, sessionId, cacheScope, openTables, refresh]);
  const [displayed, setDisplayed] = useState<{
    sessionId: string;
    table: TableDefinition;
    page: number;
    result: PgQueryResult;
    refresh: number;
  }>();
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!dataLoading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 150);
    return () => clearTimeout(timer);
  }, [dataLoading]);
  const cached = tableId
    ? cachedTablePage(cacheScope, tableId, page, tableSignature)
    : undefined;
  const visible =
    cached && activeTable
      ? {
          sessionId,
          table: activeTable,
          page,
          result: cached,
          refresh: tableState(cacheScope, tableId!).generation,
        }
      : displayed?.sessionId === sessionId
        ? displayed
        : undefined;
  const gridTable = visible?.table ?? activeTable;
  const gridPage = visible?.page ?? page;
  const gridReady =
    !!visible &&
    visible.table.id === tableId &&
    visible.page === page &&
    visible.result === data &&
    !dataLoading;
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
    if (mode !== "data" || !sessionId || !tableId) {
      setDataLoading(false);
      return;
    }
    let stale = false;
    const existing = cachedTablePage(cacheScope, tableId, page, tableSignature);
    if (existing) {
      setData(existing);
      setDisplayed({
        sessionId,
        table: activeTable!,
        page,
        result: existing,
        refresh: tableState(cacheScope, tableId).generation,
      });
      setDataLoading(false);
      setError("");
      return;
    }
    setDataLoading(true);
    setData(undefined);
    setError("");
    void loadTablePage(cacheScope, tableId, page, tableSignature, () =>
      client.page(sessionId, tableId, page),
    )
      .then((result) => {
        if (!stale) {
          setData(result);
          setDisplayed({
            sessionId,
            table: activeTable!,
            page,
            result,
            refresh: tableState(cacheScope, tableId).generation,
          });
        }
      })
      .catch((e) => {
        if (!stale) {
          setError(`Could not load ${activeTable?.name}: ${pgError(e)}`);
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
  }, [sessionId, tableId, page, mode, refresh, tableSignature]);
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
      throw Object.assign(new Error(pgError(e)), {
        resultSets:
          e && typeof e === "object" && "resultSets" in e
            ? e.resultSets
            : undefined,
        messages:
          e && typeof e === "object" && "messages" in e
            ? e.messages
            : undefined,
      });
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
    invalidateTable(cacheScope, tableId);
    const result = await loadTablePage(
      cacheScope,
      tableId,
      page,
      tableSignature,
      () => client.page(sessionId, tableId, page),
    );
    setData(result);
    setDisplayed({
      sessionId,
      table: activeTable!,
      page,
      result,
      refresh: tableState(cacheScope, tableId).generation,
    });
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
    if (tableId) invalidateTable(cacheScope, tableId);
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
      invalidateTable(cacheScope, tableId);
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
          tabContext={{
            sourceId: sessionKey,
            schema: w.schema,
            dialect: engine === "mssql" ? "mssql" : "postgres",
            label,
            remote: true,
          }}
          onEditingResult={onBusy}
          getEditableResult={(_tabId, result) =>
            currentConfig.config.readOnly
              ? undefined
              : editableResult(result, w.schema, engine)
          }
          onSaveResult={async (tabId, result, drafts, index) => {
            const rows = await saveQueryResult(
              w,
              currentSource(w),
              result,
              drafts,
            );
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
        <div className="pg-data" aria-busy={dataLoading}>
          <div className="compact-toolbar data-tables-toolbar">
            {openTables.length > 0 ? (
              <div
                className="data-table-tabs"
                role="tablist"
                aria-label="Open tables"
              >
                {openTables.map((tbl) => {
                  const isCurrent =
                    dataLayout === "tabs" && tbl.id === activeTable?.id;
                  return (
                    <div
                      key={tbl.id}
                      className={`data-table-tab${isCurrent ? " is-active" : ""}`}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isCurrent}
                        className="data-table-tab-btn"
                        onClick={() => {
                          onSelectTable?.(tbl.id);
                          if (dataLayout === "stack") {
                            setCollapsedStackTables((prev) => {
                              if (!prev.has(tbl.id)) return prev;
                              const next = new Set(prev);
                              next.delete(tbl.id);
                              return next;
                            });
                          }
                        }}
                      >
                        <Table2 size={12} />
                        <span className="data-table-tab-name">
                          {tbl.namespace
                            ? `${tbl.namespace}.${tbl.name}`
                            : tbl.name}
                        </span>
                      </button>
                      {openTables.length > 1 && onCloseTable && (
                        <button
                          type="button"
                          className="data-table-tab-close"
                          title={`Close ${tbl.name}`}
                          aria-label={`Close ${tbl.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseTable(tbl.id);
                          }}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <span>
                {gridTable
                  ? `${gridTable.namespace ? gridTable.namespace + "." : ""}${gridTable.name}`
                  : "Choose a table"}
              </span>
            )}
            <div className="row">
              {openTables.length > 1 && onDataLayoutChange && (
                <Button
                  className={dataLayout === "stack" ? "is-active" : undefined}
                  aria-pressed={dataLayout === "stack"}
                  title={
                    dataLayout === "stack"
                      ? "Switch to single table tab view"
                      : "Stack open tables vertically"
                  }
                  onClick={() =>
                    onDataLayoutChange(
                      dataLayout === "stack" ? "tabs" : "stack",
                    )
                  }
                >
                  <Rows3 size={12} />
                  <span>Stack</span>
                </Button>
              )}
              {showLoading && (
                <span className="table-loading-status" role="status">
                  <LoaderCircle className="spin" size={12} />
                  Loading {activeTable?.name}…
                </span>
              )}
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
          {dataLayout === "stack" && openTables.length > 1 ? (
            <div className="sql-all-results data-stack-container">
              {openTables.map((tbl) => {
                const tblPage = tableState(cacheScope, tbl.id).page;
                const tblCached = cachedTablePage(
                  cacheScope,
                  tbl.id,
                  tblPage,
                  JSON.stringify(tbl),
                );
                const tblRows = tblCached?.rows ?? EMPTY_ROWS;
                const isCollapsed = collapsedStackTables.has(tbl.id);
                const visibleRowCount = Math.min(
                  Math.max(tblRows.length, 1),
                  6,
                );
                const defaultHeight = 24 + 26 + visibleRowCount * 25 + 8;
                const blockHeight =
                  stackTableHeights[tbl.id] ?? defaultHeight;
                return (
                  <section
                    key={tbl.id}
                    className="sql-result-block data-stack-block"
                    data-collapsed={isCollapsed}
                    style={!isCollapsed ? { height: blockHeight } : undefined}
                  >
                    <Spreadsheet
                      key={`${sessionId}:${tbl.id}:${tblPage}:${tableState(cacheScope, tbl.id).generation}`}
                      table={tbl}
                      dialect={engine === "mssql" ? "mssql" : "postgres"}
                      viewKey={`${cacheScope}:${tbl.id}:${tblPage}`}
                      rows={tblRows}
                      disabled={
                        pending ||
                        !tblCached ||
                        !!readOnlyReason ||
                        schemaStale ||
                        !!tbl.readOnly
                      }
                      structureDisabled={
                        pending ||
                        !tblCached ||
                        !!readOnlyReason ||
                        schemaStale ||
                        !!tbl.readOnly
                      }
                      onDirty={reportDirty}
                      onSave={async (rows) => {
                        const changes = gridChanges(rows);
                        if (!changes.length) return tblRows;
                        await client.save(sessionId, tbl.id, changes);
                        invalidateTable(cacheScope, tbl.id);
                        const next = await loadTablePage(
                          cacheScope,
                          tbl.id,
                          tblPage,
                          JSON.stringify(tbl),
                          () => client.page(sessionId, tbl.id, tblPage),
                        );
                        setPageRevision((r) => r + 1);
                        return next.rows;
                      }}
                      readOnlyReason={readOnlyReason}
                      serverPage={{
                        index: tblPage,
                        hasNext: !!tblCached?.truncated,
                        onChange: (next) => {
                          tableState(cacheScope, tbl.id).page = next;
                          setPageRevision((r) => r + 1);
                        },
                      }}
                      stackHeader={{
                        collapsed: isCollapsed,
                        onToggleCollapse: () =>
                          setCollapsedStackTables((prev) => {
                            const next = new Set(prev);
                            if (next.has(tbl.id)) next.delete(tbl.id);
                            else next.add(tbl.id);
                            return next;
                          }),
                        onMaximize: () => {
                          onSelectTable?.(tbl.id);
                          onDataLayoutChange?.("tabs");
                        },
                        onClose:
                          openTables.length > 1 && onCloseTable
                            ? () => onCloseTable(tbl.id)
                            : undefined,
                      }}
                    />
                    {!isCollapsed && (
                      <div
                        className="stack-block-resizer"
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label={`Resize ${tbl.name} height`}
                        title="Drag to adjust table height · Double-click to reset"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                          stackResizeDrag.current = {
                            tableId: tbl.id,
                            startY: event.clientY,
                            startHeight: blockHeight,
                          };
                        }}
                        onPointerMove={(event) => {
                          const activeDrag = stackResizeDrag.current;
                          if (
                            !activeDrag ||
                            activeDrag.tableId !== tbl.id
                          )
                            return;
                          const nextHeight = Math.max(
                            84,
                            Math.min(
                              900,
                              Math.round(
                                activeDrag.startHeight +
                                  (event.clientY - activeDrag.startY),
                              ),
                            ),
                          );
                          setStackTableHeights((prev) =>
                            prev[tbl.id] === nextHeight
                              ? prev
                              : { ...prev, [tbl.id]: nextHeight },
                          );
                        }}
                        onPointerUp={(event) => {
                          if (
                            event.currentTarget.hasPointerCapture(
                              event.pointerId,
                            )
                          ) {
                            event.currentTarget.releasePointerCapture(
                              event.pointerId,
                            );
                          }
                          stackResizeDrag.current = null;
                        }}
                        onPointerCancel={() => {
                          stackResizeDrag.current = null;
                        }}
                        onDoubleClick={() => {
                          setStackTableHeights((prev) => {
                            if (!(tbl.id in prev)) return prev;
                            const next = { ...prev };
                            delete next[tbl.id];
                            return next;
                          });
                        }}
                      />
                    )}
                  </section>
                );
              })}
            </div>
          ) : gridTable ? (
            <Spreadsheet
              key={`${sessionId}:${gridTable.id}:${gridPage}:${visible?.refresh ?? refresh}`}
              table={gridTable}
              dialect={engine === "mssql" ? "mssql" : "postgres"}
              viewKey={`${cacheScope}:${gridTable.id}:${gridPage}`}
              rows={visible?.result.rows ?? EMPTY_ROWS}
              disabled={
                pending || !gridReady || !!readOnlyReason || schemaStale
              }
              structureDisabled={
                pending || !gridReady || !!readOnlyReason || schemaStale
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
                index: gridPage,
                hasNext: !!visible?.result.truncated,
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
