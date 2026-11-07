import { reorderTabs, useTabReorder } from "../sql/tab-reorder";
import { useQueryTimings } from "../sql/QueryTimer";
import { STACK_DEFAULT_ROWS } from "../sql/ResultSetView";
import { updateSqlTabView } from "../sql/view-state";
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
import * as Popover from "@radix-ui/react-popover";
import {
  Check,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  Rows3,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import type { TableDefinition, WorkspaceDefinition } from "../../types/schema";
import { useStore } from "../schema/store";
import { EmptyResults } from "../sample-data/EmptyResults";
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
  onReorderTables?: (ids: string[]) => void;
  onCloseTable?: (tableId: string) => void;
  onCloseTables?: (remainingIds: string[], nextActiveId?: string) => void;
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
  onCloseTables,
  onReorderTables,
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
  const queryTimings = useQueryTimings();
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
  const [stackTableRowLimits, setStackTableRowLimits] = useState<
    Record<string, number>
  >({});
  const stackResizeDrag = useRef<{
    tableId: string;
    startY: number;
    startRows: number;
  } | null>(null);
  const dataBlockRefs = useRef<Record<string, HTMLElement | null>>({});
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

  const dataTablistStripRef = useRef<HTMLDivElement>(null);
  const dataTabContextMenuRef = useRef<HTMLDivElement>(null);
  const [dataStripWidth, setDataStripWidth] = useState(0);
  const [dataOverflowOpen, setDataOverflowOpen] = useState(false);
  const [dataTabSearch, setDataTabSearch] = useState("");
  const [pinnedTableIds, setPinnedTableIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [dataTabContextMenu, setDataTabContextMenu] = useState<{
    tableId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!dataTabContextMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        dataTabContextMenuRef.current &&
        !dataTabContextMenuRef.current.contains(e.target as Node)
      ) {
        setDataTabContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDataTabContextMenu(null);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dataTabContextMenu]);

  function applyCloseTables(remainingIds: string[], nextActiveId?: string) {
    setDataTabContextMenu(null);
    if (onCloseTables) {
      onCloseTables(remainingIds, nextActiveId);
      return;
    }
    onReorderTables?.(remainingIds);
    if (nextActiveId && remainingIds.includes(nextActiveId)) {
      onSelectTable?.(nextActiveId);
    } else if (
      activeTable &&
      !remainingIds.includes(activeTable.id) &&
      remainingIds.length > 0
    ) {
      onSelectTable?.(remainingIds[remainingIds.length - 1]);
    }
  }

  function togglePinDataTable(tblId: string) {
    setDataTabContextMenu(null);
    const nextPinned = new Set(pinnedTableIds);
    if (nextPinned.has(tblId)) nextPinned.delete(tblId);
    else nextPinned.add(tblId);
    setPinnedTableIds(nextPinned);
    if (onReorderTables) {
      const ordered = [
        ...openTables.filter((t) => nextPinned.has(t.id)),
        ...openTables.filter((t) => !nextPinned.has(t.id)),
      ];
      onReorderTables(ordered.map((t) => t.id));
    }
  }

  useEffect(() => {
    const el = dataTablistStripRef.current;
    if (!el) return;
    if (el.clientWidth > 0) {
      setDataStripWidth(el.clientWidth);
    }
    const obs = new ResizeObserver(([entry]) => {
      setDataStripWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [mode]);

  const dataTabDrag = useTabReorder(
    !pending && !!onReorderTables,
    (source, target, side) => {
      const ordered = reorderTabs(openTables, source, target, side);
      if (ordered !== openTables)
        onReorderTables?.(ordered.map((table) => table.id));
    },
    (source, target) => pinnedTableIds.has(source) === pinnedTableIds.has(target),
  );
  const availableForDataTabs =
    dataStripWidth > 0 ? Math.max(120, dataStripWidth - 40) : 400;
  const dataTableCapacity = Math.max(1, Math.floor(availableForDataTabs / 150));
  const hasDataTableOverflow = openTables.length > dataTableCapacity;

  const visibleTables = useMemo(() => {
    if (!hasDataTableOverflow) return openTables;
    const count = Math.max(1, dataTableCapacity);
    const list = openTables
      .filter(
        (tbl, idx) =>
          idx < count ||
          tbl.id === activeTable?.id ||
          pinnedTableIds.has(tbl.id),
      )
      .slice(0, count);
    if (activeTable && !list.some((tbl) => tbl.id === activeTable.id)) {
      list[list.length - 1] = activeTable;
    }
    return list;
  }, [
    openTables,
    dataTableCapacity,
    hasDataTableOverflow,
    activeTable,
    pinnedTableIds,
  ]);
  const contextDataTable = dataTabContextMenu
    ? openTables.find((t) => t.id === dataTabContextMenu.tableId)
    : undefined;
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
    queryTimings.start(tab.id);
    updateSqlTabView(`${w.id}:${tab.id}`, { resultsVisible: true });
    try {
      await task(async () => {
        const output = await executeSqlBatch(
          sql,
          query,
          engine === "mssql" ? "mssql" : "default",
        );
        setResults((current) => ({ ...current, [tab.id]: output }));
        setRefresh((n) => n + 1);
      });
    } finally {
      queryTimings.finish(tab.id);
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
          runningTabId={queryTimings.runningTabId}
          timings={queryTimings.timings}
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
              <div ref={dataTablistStripRef} className="data-tables-left-strip">
                <div
                  className="data-table-tabs"
                  role="tablist"
                  aria-label="Open tables"
                >
                  {visibleTables.map((tbl) => {
                    const isCurrent =
                      dataLayout === "tabs" && tbl.id === activeTable?.id;
                    const isPinned = pinnedTableIds.has(tbl.id);
                    const fullTableName = tbl.namespace
                      ? `${tbl.namespace}.${tbl.name}`
                      : tbl.name;
                    return (
                      <div
                        key={tbl.id}
                        className={`data-table-tab${isCurrent ? " is-active" : ""}${isPinned ? " is-pinned" : ""}`}
                        data-tab-id={tbl.id}
                        {...dataTabDrag(tbl.id)}
                        onAuxClick={(event) => {
                          if (
                            event.button === 1 &&
                            !pending &&
                            !isPinned &&
                            onCloseTable
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            onCloseTable(tbl.id);
                          }
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (pending) return;
                          const x = Math.min(
                            event.clientX,
                            window.innerWidth - 235,
                          );
                          const y = Math.min(
                            event.clientY,
                            window.innerHeight - 220,
                          );
                          setDataTabContextMenu({
                            tableId: tbl.id,
                            x: Math.max(8, x),
                            y: Math.max(8, y),
                          });
                        }}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={isCurrent}
                          className="data-table-tab-btn"
                          title={`${fullTableName}${isPinned ? " · Pinned" : ""}\nRight-click for tab options · Middle-click to close`}
                          onClick={() => {
                            onSelectTable?.(tbl.id);
                            if (dataLayout === "stack") {
                              setCollapsedStackTables((prev) => {
                                if (!prev.has(tbl.id)) return prev;
                                const next = new Set(prev);
                                next.delete(tbl.id);
                                return next;
                              });
                              requestAnimationFrame(() => {
                                dataBlockRefs.current[tbl.id]?.scrollIntoView({
                                  block: "nearest",
                                });
                              });
                            }
                          }}
                        >
                          {isPinned ? (
                            <Pin size={12} className="sql-tab-pin" />
                          ) : (
                            <Table2 size={12} />
                          )}
                          <span className="data-table-tab-name">
                            {fullTableName}
                          </span>
                        </button>
                        {!isPinned && onCloseTable && (
                          <button
                            type="button"
                            className="data-table-tab-close"
                            title={`Close ${tbl.name}`}
                            aria-label={`Close ${tbl.name}`}
                            disabled={pending}
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

                {hasDataTableOverflow && (
                  <Popover.Root
                    open={dataOverflowOpen}
                    onOpenChange={(value) => {
                      setDataOverflowOpen(value);
                      if (!value) setDataTabSearch("");
                    }}
                  >
                    <Popover.Trigger asChild>
                      <button
                        type="button"
                        className="data-tab-overflow-btn"
                        aria-label="More open tables"
                        title={`All open tables (${openTables.length})`}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        className="sql-tab-menu data-tab-overflow-menu"
                        sideOffset={6}
                        align="start"
                        onOpenAutoFocus={(e) => e.preventDefault()}
                      >
                        <input
                          aria-label="Find open table"
                          placeholder="Find a table…"
                          value={dataTabSearch}
                          onChange={(e) => setDataTabSearch(e.target.value)}
                        />
                        <div className="sql-tab-menu-list">
                          {openTables
                            .filter((tbl) => {
                              const name = tbl.namespace
                                ? `${tbl.namespace}.${tbl.name}`
                                : tbl.name;
                              return name
                                .toLowerCase()
                                .includes(dataTabSearch.toLowerCase());
                            })
                            .map((tbl) => {
                              const isCurrent =
                                dataLayout === "tabs" &&
                                tbl.id === activeTable?.id;
                              const isPinned = pinnedTableIds.has(tbl.id);
                              const tableName = tbl.namespace
                                ? `${tbl.namespace}.${tbl.name}`
                                : tbl.name;
                              return (
                                <div
                                  key={tbl.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    width: "100%",
                                  }}
                                >
                                  <button
                                    type="button"
                                    style={{ flex: 1, minWidth: 0 }}
                                    onClick={() => {
                                      onSelectTable?.(tbl.id);
                                      if (dataLayout === "stack") {
                                        setCollapsedStackTables((prev) => {
                                          if (!prev.has(tbl.id)) return prev;
                                          const next = new Set(prev);
                                          next.delete(tbl.id);
                                          return next;
                                        });
                                        requestAnimationFrame(() => {
                                          dataBlockRefs.current[
                                            tbl.id
                                          ]?.scrollIntoView({
                                            block: "nearest",
                                          });
                                        });
                                      }
                                      setDataOverflowOpen(false);
                                      setDataTabSearch("");
                                    }}
                                  >
                                    {isPinned ? (
                                      <Pin size={13} className="sql-tab-pin" />
                                    ) : (
                                      <Table2 size={13} />
                                    )}
                                    <span className="sql-tab-menu-item-info">
                                      <span>{tableName}</span>
                                      <small>
                                        {tbl.columns?.length ?? 0} columns
                                      </small>
                                    </span>
                                    {isCurrent && <Check size={14} />}
                                  </button>
                                  {!isPinned && onCloseTable && (
                                    <button
                                      type="button"
                                      className="sql-tab-close"
                                      title={`Close ${tbl.name}`}
                                      aria-label={`Close ${tbl.name}`}
                                      style={{
                                        width: 22,
                                        height: 22,
                                        padding: 3,
                                        flexShrink: 0,
                                      }}
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
                          {!openTables.some((tbl) => {
                            const name = tbl.namespace
                              ? `${tbl.namespace}.${tbl.name}`
                              : tbl.name;
                            return name
                              .toLowerCase()
                              .includes(dataTabSearch.toLowerCase());
                          }) && (
                            <span className="snippet-status">
                              No matching tables
                            </span>
                          )}
                        </div>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                )}

                {dataTabContextMenu && contextDataTable && (
                  <div
                    ref={dataTabContextMenuRef}
                    className="result-floating-menu result-context-menu sql-tab-context-menu"
                    role="menu"
                    aria-label={`Options for ${contextDataTable.name}`}
                    style={{
                      left: dataTabContextMenu.x,
                      top: dataTabContextMenu.y,
                    }}
                  >
                    <div className="sql-tab-context-header">
                      <div className="sql-tab-context-title-row">
                        <strong>
                          {contextDataTable.namespace
                            ? `${contextDataTable.namespace}.${contextDataTable.name}`
                            : contextDataTable.name}
                        </strong>
                        <span className="sql-tab-badges">
                          {pinnedTableIds.has(contextDataTable.id) && (
                            <span className="sql-tab-pinned-badge">Pinned</span>
                          )}
                        </span>
                      </div>
                      <small>
                        {contextDataTable.columns?.length ?? 0} columns · {label}
                      </small>
                    </div>
                    <hr />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => togglePinDataTable(contextDataTable.id)}
                    >
                      <span className="sql-tab-ctx-item">
                        {pinnedTableIds.has(contextDataTable.id) ? (
                          <PinOff size={12} />
                        ) : (
                          <Pin size={12} />
                        )}
                        <span>
                          {pinnedTableIds.has(contextDataTable.id)
                            ? "Unpin tab"
                            : "Pin to start"}
                        </span>
                      </span>
                    </button>
                    <hr />
                    <button
                      type="button"
                      role="menuitem"
                      disabled={
                        openTables.filter(
                          (t) =>
                            t.id !== contextDataTable.id &&
                            !pinnedTableIds.has(t.id),
                        ).length === 0
                      }
                      onClick={() => {
                        const remaining = openTables
                          .filter(
                            (t) =>
                              t.id === contextDataTable.id ||
                              pinnedTableIds.has(t.id),
                          )
                          .map((t) => t.id);
                        applyCloseTables(remaining, contextDataTable.id);
                      }}
                    >
                      <span className="sql-tab-ctx-item">
                        <Trash2 size={12} />
                        <span>Close other tabs</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={(() => {
                        const idx = openTables.findIndex(
                          (t) => t.id === contextDataTable.id,
                        );
                        return (
                          idx < 0 ||
                          openTables
                            .slice(idx + 1)
                            .filter((t) => !pinnedTableIds.has(t.id)).length ===
                            0
                        );
                      })()}
                      onClick={() => {
                        const idx = openTables.findIndex(
                          (t) => t.id === contextDataTable.id,
                        );
                        if (idx < 0) return;
                        const remaining = openTables
                          .filter(
                            (t, i) => i <= idx || pinnedTableIds.has(t.id),
                          )
                          .map((t) => t.id);
                        const nextActive =
                          activeTable && remaining.includes(activeTable.id)
                            ? activeTable.id
                            : contextDataTable.id;
                        applyCloseTables(remaining, nextActive);
                      }}
                    >
                      <span className="sql-tab-ctx-item">
                        <Trash2 size={12} />
                        <span>Close tabs to the right</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={
                        openTables.filter((t) => !pinnedTableIds.has(t.id))
                          .length === 0
                      }
                      onClick={() => {
                        const remaining = openTables
                          .filter((t) => pinnedTableIds.has(t.id))
                          .map((t) => t.id);
                        applyCloseTables(remaining, remaining[0]);
                      }}
                    >
                      <span className="sql-tab-ctx-item">
                        <Trash2 size={12} />
                        <span>Close all tabs</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger-item"
                      disabled={pinnedTableIds.has(contextDataTable.id)}
                      title={
                        pinnedTableIds.has(contextDataTable.id)
                          ? "Unpin this tab before closing"
                          : undefined
                      }
                      onClick={() => {
                        setDataTabContextMenu(null);
                        onCloseTable?.(contextDataTable.id);
                      }}
                    >
                      <span className="sql-tab-ctx-item">
                        <X size={12} />
                        <span>Close tab</span>
                      </span>
                    </button>
                  </div>
                )}
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
                const rowLimit =
                  stackTableRowLimits[tbl.id] ?? STACK_DEFAULT_ROWS;
                const displayedRows = Math.min(
                  Math.max(tblRows.length, 1),
                  rowLimit,
                );
                return (
                  <section
                    key={tbl.id}
                    ref={(el) => {
                      dataBlockRefs.current[tbl.id] = el;
                    }}
                    className="sql-result-block data-stack-block"
                    data-collapsed={isCollapsed}
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
                        rowLimit,
                        onRowLimitChange: (next) =>
                          setStackTableRowLimits((prev) => {
                            if (next === undefined) {
                              if (!(tbl.id in prev)) return prev;
                              const copy = { ...prev };
                              delete copy[tbl.id];
                              return copy;
                            }
                            return prev[tbl.id] === next
                              ? prev
                              : { ...prev, [tbl.id]: next };
                          }),
                      }}
                    />
                    {!isCollapsed && tblRows.length > 3 && (
                      <div
                        className="stack-block-resizer"
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label={`Resize ${tbl.name} visible rows`}
                        title="Drag to show more or fewer rows · Double-click to reset"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                          stackResizeDrag.current = {
                            tableId: tbl.id,
                            startY: event.clientY,
                            startRows: displayedRows,
                          };
                        }}
                        onPointerMove={(event) => {
                          const activeDrag = stackResizeDrag.current;
                          if (!activeDrag || activeDrag.tableId !== tbl.id)
                            return;
                          const deltaRows = Math.round(
                            (event.clientY - activeDrag.startY) / 25,
                          );
                          const nextRows = Math.max(
                            3,
                            Math.min(
                              tblRows.length,
                              activeDrag.startRows + deltaRows,
                            ),
                          );
                          setStackTableRowLimits((prev) =>
                            prev[tbl.id] === nextRows
                              ? prev
                              : { ...prev, [tbl.id]: nextRows },
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
                          setStackTableRowLimits((prev) => {
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
            <EmptyResults />
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
