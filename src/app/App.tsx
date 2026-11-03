import { useSqlResults } from "../features/sql/result-state";
import { WorkspaceConnectionControls } from "../features/connections/WorkspaceConnectionControls";
import { SnippetSettings } from "../features/sql/SnippetSettings";
import { useLoadSnippetPreferences } from "../features/sql/snippet-preferences";
import { WindowControls } from "../lib/platform/WindowControls";
import {
  desktopPlatform,
  useDesktopChrome,
} from "../lib/platform/desktop-chrome";
import { ConnectionController } from "../features/connections/ConnectionController";
import { MultiSqlWorkspace } from "../features/connections/MultiSqlWorkspace";
import {
  activateSource,
  attachDatabase,
  attachSource,
  removeSource,
  workspaceSources,
  sourceSessionKey,
  tabSource,
} from "../features/connections/sources";
import { restoreSqlLayout, updatePaneTabs } from "../features/sql/panes";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sampleDuckValue } from "../lib/duckdb/values";
import { invalidateSession } from "../features/connections/sessions";
import { readDarkAppearance, saveDarkAppearance } from "./appearance";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Database,
  Download,
  Ellipsis,
  KeyRound,
  Link2,
  Moon,
  PanelLeftClose,
  Plus,
  Redo2,
  RefreshCw,
  Rows3,
  Search,
  Settings2,
  Sun,
  Table2,
  Terminal,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { DialogHost, confirmAction } from "../lib/dialogs";
import { useStore } from "../features/schema/store";
import { id, parseWorkspace, validateSchema } from "../features/schema/core";
import { TableEditor } from "../features/schema/TableEditor";
import { newTable } from "../features/schema/table-edit";
import { ColumnEditor } from "../features/schema/ColumnEditor";
import { planTableEdit } from "../features/schema/table-edit";
import { activeSqlTab, sqlTabs, setSqlTabs } from "../features/sql/tabs";
import { editableResult } from "../features/sql/editable-result";
import { executeSqlBatch } from "../features/sql/execution";
import { SqlWorkspace } from "../features/sql/SqlWorkspace";

import { Spreadsheet } from "../features/sample-data/Spreadsheet";
import { saveGridChanges } from "../features/sample-data/mutations";
import type { DraftRow } from "../features/sample-data/model";
import { generateDDL, orderedTables, quote } from "../lib/ddl/generate";
import {
  query,
  queryCancelable,
  cancelLocalQuery,
  rebuild,
  snapshot,
} from "../lib/duckdb/engine";
import { RemoteWorkspace } from "../features/connections/RemoteWorkspace";
import type { ConnectionProfile } from "../features/connections/model";
import { saveJsonFile } from "../lib/platform/save-file";
import { useDesktopClose } from "../lib/platform/use-desktop-close";
import {
  saveWorkspace,
  workspaceSnapshot,
  storage,
} from "../lib/storage/workspaces";
import type { TableDefinition, WorkspaceDefinition } from "../types/schema";
type Mode = "data" | "sql";
const modes = [
  { id: "data", label: "Data", icon: Table2 },
  { id: "sql", label: "SQL", icon: Code2 },
] as const;
const EMPTY_ROWS: Record<string, unknown>[] = [];
function signature(w: WorkspaceDefinition) {
  return JSON.stringify({
    ...w.schema,
    tables: w.schema.tables.map((t) => ({
      id: t.id,
      name: t.name,
      columns: t.columns,
      primaryKey: t.primaryKey,
    })),
  });
}
export default function App() {
  useLoadSnippetPreferences();
  const [abbreviations, setAbbreviations] = useState(false);
  const { workspace: w, edit, load, undo, redo, past, future } = useStore();
  const [mode, setMode] = useState<Mode>("sql");
  useLayoutEffect(() => {
    if (mode !== "sql" || !w.sources) return;
    const source = tabSource(w, activeSqlTab(w));
    if (source.id !== w.activeSourceId)
      edit((draft) => activateSource(draft, source.id));
  }, [mode, w, edit]);

  const [dataTable, setDataTable] = useState("");
  const [search, setSearch] = useState("");
  const [tablePage, setTablePage] = useState(0);
  const tableList = useRef<HTMLDivElement>(null);
  useEffect(() => setTablePage(0), [search, w.id, w.activeSourceId]);
  useEffect(() => {
    tableList.current?.scrollTo({ top: 0 });
  }, [tablePage, search, w.id, w.activeSourceId]);
  const filteredTables = useMemo(
    () =>
      w.schema.tables.filter((table) =>
        `${table.namespace ?? ""}.${table.name}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [w.schema.tables, search],
  );
  const tablePageCount = Math.max(1, Math.ceil(filteredTables.length / 50));
  const currentTablePage = Math.min(tablePage, tablePageCount - 1);
  const [expandedTables, setExpandedTables] = useState<string[]>([]);
  const [left, setLeft] = useState(true);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connectionHost, setConnectionHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [sidebarWidth, setSidebarWidth] = useState(190);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeSidebar = (width: number) => {
    const available = workspaceRef.current?.clientWidth ?? 1000;
    setSidebarWidth(Math.max(160, Math.min(480, available - 420, width)));
  };
  const [tableEditor, setTableEditor] = useState<{
    table: TableDefinition;
    isNew: boolean;
  } | null>(null);
  const [columnEditor, setColumnEditor] = useState<{
    tableId: string;
    columnId?: string;
    anchor: HTMLButtonElement;
  } | null>(null);
  const platform = desktopPlatform();
  const [dark, setDark] = useState(readDarkAppearance);
  useDesktopChrome(dark);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
    saveDarkAppearance(dark);
  }, [dark]);
  const [busy, setBusy] = useState(false);
  const [localQueryRunning, setLocalQueryRunning] = useState(false);
  const [localCancelPending, setLocalCancelPending] = useState(false);
  const localCancelled = useRef(false);
  const localRunActive = useRef(false);
  const localExecutionId = useRef(0);
  const [runtime, setRuntime] = useState("");
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("Opening workspace…");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [queryResults, setQueryResults] = useSqlResults(w.id);
  const remoteRun = useRef<() => void>(() => {});
  const sqlSelection = useRef({ tabId: "", sql: "" });

  const remote = !!(w.postgres || w.mssql);
  const [ddl, setDdl] = useState(false);
  const [ddlSql, setDdlSql] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const runRef = useRef<() => void>(() => {});
  const schemaSignature = useMemo(
    () => (remote ? "" : signature(w)),
    [remote, w.schema],
  );
  const stale = !remote && runtime !== schemaSignature;
  const activeTable =
    w.schema.tables.find((t) => t.id === dataTable) || w.schema.tables[0];
  const [openDataTableIds, setOpenDataTableIds] = useState<string[]>([]);
  const [dataLayout, setDataLayout] = useState<"tabs" | "stack">("tabs");
  const [collapsedDataTables, setCollapsedDataTables] = useState<Set<string>>(
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
    setOpenDataTableIds([]);
    setCollapsedDataTables(new Set());
    setStackTableHeights({});
  }, [w.id, w.activeSourceId]);
  useEffect(() => {
    if (!activeTable) return;
    setOpenDataTableIds((prev) =>
      prev.includes(activeTable.id) ? prev : [...prev, activeTable.id],
    );
  }, [activeTable?.id]);
  const openDataTables = useMemo(() => {
    const valid = openDataTableIds
      .map((tid) => w.schema.tables.find((t) => t.id === tid))
      .filter((t): t is TableDefinition => Boolean(t));
    if (!valid.length && activeTable) return [activeTable];
    return valid;
  }, [openDataTableIds, w.schema.tables, activeTable]);
  const errors = useMemo(
    () => (remote ? [] : validateSchema(w.schema)),
    [remote, w.schema],
  );
  useEffect(() => {
    let active = true;
    storage.workspaces
      .orderBy("updatedAt")
      .last()
      .then((value) => {
        if (active) {
          if (value) load(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) {
          setSaved("Storage unavailable");
          setMessage(String(e));
          setError(true);
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    if (!ready) return;
    setSaved("Saving…");
    let active = true;
    const timer = setTimeout(() => {
      saveWorkspace(w)
        .then((saved) => {
          if (active)
            setSaved(saved ? "Saved on this device" : "Workspace deleted");
        })
        .catch((e) => {
          if (!active) return;
          setSaved("Save failed");
          setMessage(String(e));
          setError(true);
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [w, ready]);
  // Reconstruct a workspace once on open; later design changes require an explicit sync.
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setBusy(true);
    setRuntime("");
    if (remote || (w.sources && mode === "sql")) {
      setBusy(false);
      return;
    }
    rebuild(w)
      .then(() => {
        if (active) setRuntime(signature(w));
      })
      .catch((e) => {
        if (active) {
          setMessage(e instanceof Error ? e.message : String(e));
          setError(true);
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // The workspace id is the boundary; edits must not implicitly rebuild the runtime.
  }, [ready, w.id, w.activeSourceId, !!w.sources && mode === "sql"]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLeft(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runRef.current();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "s" &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        void saveWorkspace(useStore.getState().workspace)
          .then(() => setSaved("Saved on this device"))
          .catch((e) => {
            setMessage(String(e));
            setError(true);
          });
      }
    };
    const blockNativeContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("contextmenu", blockNativeContextMenu);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("contextmenu", blockNativeContextMenu);
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!message || error) return;
    const timer = setTimeout(() => setMessage(""), 3000);
    return () => clearTimeout(timer);
  }, [message, error]);
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function leaveDraft() {
    if (busy) return false;
    if (
      dirty &&
      !(await confirmAction("Your unsaved changes will be lost.", {
        title: "Discard changes?",
        confirmLabel: "Discard",
        destructive: true,
      }))
    )
      return false;
    return true;
  }
  useDesktopClose(
    async () => {
      if (!ready || !(await leaveDraft())) return false;
      await saveWorkspace(w);
      return true;
    },
    (error) => {
      setMessage(String(error));
      setError(true);
    },
  );
  async function changeMode(next: Mode) {
    if (next === mode || !(await leaveDraft())) return;
    setMode(next);
  }
  async function chooseTable(tableId: string) {
    setOpenDataTableIds((prev) =>
      prev.includes(tableId) ? prev : [...prev, tableId],
    );
    if (tableId === activeTable?.id) return;
    if (!(await leaveDraft())) return;
    setDataTable(tableId);
  }
  async function closeDataTable(tableId: string) {
    if (openDataTables.length <= 1) return;
    if (tableId === activeTable?.id && !(await leaveDraft())) return;
    const remaining = openDataTables.filter((t) => t.id !== tableId);
    setOpenDataTableIds(remaining.map((t) => t.id));
    if (tableId === activeTable?.id && remaining.length > 0) {
      setDataTable(remaining[remaining.length - 1].id);
    }
  }
  async function apply() {
    if (busy) return;
    if (
      runtime &&
      !(await confirmAction(
        "Sync the design with your local database? Saved rows will be restored. Incompatible changes will be rejected without replacing the current database.",
      ))
    )
      return;
    await task(async () => {
      await rebuild(w);
      setRuntime(schemaSignature);
      setMessage("Your database is up to date.");
    });
  }
  async function run(tabId?: string, sql?: string) {
    if (stale || busy || localRunActive.current) return;
    localRunActive.current = true;
    localExecutionId.current++;
    localCancelled.current = false;
    setLocalQueryRunning(true);
    setLocalCancelPending(false);
    try {
      await task(async () => {
        const tab =
          sqlTabs(w).find((item) => item.id === tabId) ?? activeSqlTab(w);
        const selected =
          sql ??
          (sqlSelection.current.tabId === tab.id
            ? sqlSelection.current.sql
            : "");
        const results = await executeSqlBatch(
          selected.trim() ? selected : tab.sql,
          async (text) => {
            if (localCancelled.current)
              throw Error("Query stopped. Remaining statements were skipped.");
            return queryCancelable(text);
          },
        );
        setLocalQueryRunning(false);
        if (!results.length) return;
        setQueryResults((previous) => ({ ...previous, [tab.id]: results }));
        try {
          const data = await snapshot(w);
          edit((d) => {
            d.data = data;
          });
        } catch (e) {
          setRuntime("");
          throw Error(
            "SQL ran, but its schema no longer matches the design. Rebuild to restore the visual schema. " +
              String(e),
          );
        }
      });
    } finally {
      localRunActive.current = false;
      setLocalQueryRunning(false);
      setLocalCancelPending(false);
    }
  }
  runRef.current = () => {
    if (mode === "sql") {
      if (remote || w.sources) remoteRun.current();
      else void run();
    }
  };
  async function saveRowsForTable(
    targetTable: TableDefinition,
    rows: DraftRow[],
  ) {
    if (stale || busy)
      throw Error("Wait for the database to be ready before saving.");
    setBusy(true);
    try {
      const data = await saveGridChanges(w, targetTable, rows);
      edit((d) => {
        d.data = data;
      });
      try {
        await saveWorkspace({ ...w, data, updatedAt: Date.now() });
      } catch (e) {
        setMessage(
          "Rows saved in DuckDB, but browser persistence failed: " + String(e),
        );
        setError(true);
      }
      return data[targetTable.id] ?? [];
    } finally {
      setBusy(false);
    }
  }
  async function saveRows(rows: DraftRow[]) {
    if (!activeTable)
      throw Error("Wait for the database to be ready before saving.");
    return saveRowsForTable(activeTable, rows);
  }
  async function addTable() {
    if (!(await leaveDraft())) return;
    setTableEditor({ table: newTable(w), isNew: true });
  }
  async function editTable(tableId: string) {
    if (!(await leaveDraft())) return;
    const table = w.schema.tables.find((t) => t.id === tableId);
    if (table) setTableEditor({ table: structuredClone(table), isNew: false });
  }
  async function openColumn(
    tableId: string,
    columnId: string | undefined,
    anchor: HTMLButtonElement,
  ) {
    if (!(await leaveDraft())) return;
    setColumnEditor({ tableId, columnId, anchor });
  }
  async function commitColumn(plan: ReturnType<typeof planTableEdit>) {
    if (busy) throw Error("The database is busy. Try again.");
    if (plan.errors.length) throw Error(plan.errors.join(" "));
    const candidate = {
      ...w,
      schema: plan.schema,
      data: plan.data,
      updatedAt: Date.now(),
    };
    setBusy(true);
    setMessage("");
    let swapped = false;
    try {
      await rebuild(candidate);
      swapped = true;
      const data = await snapshot(candidate);
      edit((workspace) => {
        workspace.schema = plan.schema;
        workspace.data = data;
      });
      setRuntime(signature(candidate));
    } catch (error) {
      if (swapped) setRuntime("");
      throw error;
    } finally {
      setBusy(false);
    }
  }
  async function selectConnection(sourceId: string) {
    if (sourceId === (w.activeSourceId ?? "primary")) return true;
    if (!(await leaveDraft())) return false;
    edit((draft) => {
      activateSource(draft, sourceId);
      if (mode === "sql") {
        const active = activeSqlTab(draft).id;
        setSqlTabs(
          draft,
          sqlTabs(draft).map((tab) =>
            tab.id === active ? { ...tab, sourceId } : tab,
          ),
          active,
        );
      }
    });
    setDataTable("");
    setSearch("");
    return true;
  }
  async function selectWorkspaceDatabase(rootId: string, database: string) {
    if (!(await leaveDraft())) return;
    edit((draft) => {
      const sourceId = attachDatabase(draft, rootId, database);
      if (mode === "sql") {
        const active = activeSqlTab(draft).id;
        setSqlTabs(
          draft,
          sqlTabs(draft).map((tab) =>
            tab.id === active ? { ...tab, sourceId } : tab,
          ),
          active,
        );
      } else activateSource(draft, sourceId);
    });
    setDataTable("");
    setSearch("");
  }
  async function addWorkspaceConnection(profile?: ConnectionProfile) {
    if (!profile || !(await leaveDraft())) return false;
    edit((draft) => {
      const sourceId = attachSource(draft, profile);
      activateSource(draft, sourceId);
      const tabs = sqlTabs(draft);
      const active = activeSqlTab(draft).id;
      const existing = tabs.find((tab) => tab.sourceId === sourceId);
      if (existing) {
        setSqlTabs(draft, tabs, existing.id);
        return;
      }
      const tab = { id: id(), name: profile.name + ".sql", sql: "", sourceId };
      const layout = restoreSqlLayout(tabs, active, draft.sqlLayout);
      const index = Math.max(
        0,
        layout.groups.findIndex((group) => group.ids.includes(active)),
      );
      const owned = layout.groups[index].ids.map((tabId) =>
        tabs.find((tab) => tab.id === tabId)!,
      );
      const next = updatePaneTabs(
        tabs,
        layout.groups,
        index,
        [...owned, tab],
        tab.id,
      );
      setSqlTabs(draft, next.tabs, tab.id, { ...layout, groups: next.groups });
    });
    setMode("sql");
    setDataTable("");
    setSearch("");
  }
  async function removeWorkspaceConnection(sourceId: string) {
    if (!(await leaveDraft())) return;
    const source = workspaceSources(w).find((source) => source.id === sourceId);
    const fallback = workspaceSources(w).find(
      (source) => source.id !== sourceId && source.parentSourceId !== sourceId,
    );
    if (
      !source ||
      !fallback ||
      !(await confirmAction(
        `SQL tabs keep their text and switch to “${fallback.connection ? fallback.name : "Local DuckDB"}”. ${source.connection ? "Server data and saved connection settings stay available." : "Local tables and rows will be removed. Export the session first to keep a copy."}`,
        {
          title: `Remove “${source.connection ? source.name : "Local DuckDB"}”?`,
          confirmLabel: "Remove",
          destructive: true,
        },
      ))
    )
      return;
    for (const item of workspaceSources(w).filter(
      (s) => s.id === sourceId || s.parentSourceId === sourceId,
    ))
      invalidateSession(sourceSessionKey(w.id, item.id));
    edit((draft) => removeSource(draft, sourceId));
    setDataTable("");
    setSearch("");
  }
  async function exportWorkspace() {
    await task(() =>
      saveJsonFile(w.name, JSON.stringify(workspaceSnapshot(w), null, 2)),
    );
  }
  async function generateData() {
    if (stale || busy || dirty) return;
    await task(async () => {
      await query("BEGIN TRANSACTION");
      try {
        for (const table of orderedTables(w.schema)) {
          if (
            (await query(`SELECT * FROM ${quote(table.name)} LIMIT 1`)).rows
              .length
          )
            continue;
          const values = table.columns.map((column, index) => {
            const r = w.schema.relationships.find(
              (r) =>
                r.kind === "physical" &&
                r.sourceTable === table.id &&
                r.sourceColumns.includes(column.id),
            );
            if (r) {
              const target = w.schema.tables.find(
                (t) => t.id === r.targetTable,
              )!;
              return `(SELECT ${quote(target.columns.find((c) => c.id === r.targetColumns[r.sourceColumns.indexOf(column.id)])!.name)} FROM ${quote(target.name)} LIMIT 1)`;
            }
            return sampleDuckValue(column, index);
          });
          await query(
            `INSERT INTO ${quote(table.name)} VALUES (${values.join(",")})`,
          );
        }
        const data = await snapshot(w);
        await query("COMMIT");
        edit((d) => {
          d.data = data;
        });
        setMessage("Sample records added to empty tables.");
      } catch (e) {
        await query("ROLLBACK");
        throw e;
      }
    });
  }
  return (
    <div
      className={
        "app " +
        (dark ? "dark " : "") +
        (platform !== "web" ? `desktop desktop-${platform}` : "")
      }
    >
      <DialogHost />
      {abbreviations && (
        <SnippetSettings key={w.id} onClose={() => setAbbreviations(false)} />
      )}
      <header className="app-header" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <div className="titlebar-connection-host" ref={setConnectionHost}>
            {!(mode === "sql" && w.sources) && (
              <WorkspaceConnectionControls
                workspace={w}
                busy={busy}
                onSelect={selectConnection}
                onDatabaseChange={selectWorkspaceDatabase}
                onError={(error) => {
                  setMessage(String(error));
                  setError(true);
                }}
              />
            )}
          </div>
          <ConnectionController
            onAttach={addWorkspaceConnection}
            workspace={w}
            busy={busy}
            onRemove={(sourceId) => void removeWorkspaceConnection(sourceId)}
            onBeforeAction={leaveDraft}
            onConnected={() =>
              setConnectionRevision((revision) => revision + 1)
            }
            onError={(error) => {
              setMessage(String(error));
              setError(true);
            }}
          />
        </div>
        <nav className="mode-switch" aria-label="View" data-tauri-drag-region>
          {modes.map((item) => (
            <button
              key={item.id}
              aria-current={mode === item.id ? "page" : undefined}
              onClick={() => void changeMode(item.id)}
            >
              <item.icon size={15} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="header-actions" data-tauri-drag-region>
          <span
            className="save-indicator"
            title={`${saved}${errors.length ? ` · ${errors.length} schema issues` : ""}`}
            aria-label={busy ? "Working" : saved}
          >
            <span
              className={
                "status-dot " + (stale || errors.length ? "amber" : "")
              }
            />
          </span>
          <Button
            title={dark ? "Light appearance" : "Dark appearance"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
          <details
            className="workspace-menu"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button"))
                e.currentTarget.removeAttribute("open");
            }}
          >
            <summary aria-label="App settings">
              <Ellipsis size={17} />
            </summary>
            <div>
              <Button onClick={() => setLeft(!left)} aria-pressed={!left}>
                <PanelLeftClose size={15} />
                {left ? "Hide sidebar" : "Show sidebar"}
              </Button>
              <Button onClick={() => setAbbreviations(true)}>
                <Braces size={15} />
                SQL abbreviations
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await leaveDraft()) file.current?.click();
                }}
              >
                <Upload size={15} />
                Import session
              </Button>
              <Button
                disabled={remote}
                onClick={() => {
                  try {
                    setDdlSql(generateDDL(w.schema));
                    setDdl(true);
                  } catch (error) {
                    setMessage(String(error));
                    setError(true);
                  }
                }}
              >
                <Code2 size={15} />
                View schema SQL
              </Button>
              <Button onClick={exportWorkspace}>
                <Download size={15} />
                Export session
              </Button>
              <hr />
              <Button
                disabled={remote || !past.length || busy || dirty}
                onClick={undo}
              >
                <Undo2 size={15} />
                Undo design change
              </Button>
              <Button
                disabled={remote || !future.length || busy || dirty}
                onClick={redo}
              >
                <Redo2 size={15} />
                Redo design change
              </Button>
            </div>
          </details>
        </div>
      </header>
      {platform === "windows" && <WindowControls />}
      <input
        ref={file}
        type="file"
        accept=".json"
        hidden
        onChange={async (e) => {
          const selectedFile = e.target.files?.[0];
          e.target.value = "";
          if (!selectedFile) return;
          await task(async () => {
            const imported = parseWorkspace(await selectedFile.text());
            imported.id = id();
            await saveWorkspace(w);
            load(imported);
            setDataTable("");
          });
        }}
      />
      <div className="workspace" ref={workspaceRef}>
        {left && (
          <aside className="explorer" style={{ width: sidebarWidth }}>
            <div className="search">
              <Search size={15} />
              <input
                ref={searchInput}
                aria-label="Search tables"
                placeholder="Search tables"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>⌘ K</kbd>
            </div>
            <div className="section-heading">
              <span>TABLES</span>
              <span>{w.schema.tables.length}</span>
              {!remote && (
                <Button
                  title="Create table"
                  disabled={busy}
                  onClick={() => void addTable()}
                >
                  <Plus size={14} />
                </Button>
              )}
            </div>
            <div className="table-list" ref={tableList}>
              {filteredTables
                .slice(currentTablePage * 50, (currentTablePage + 1) * 50)
                .map((table) => (
                  <div key={table.id}>
                    <div className="tree-table-row">
                      <button
                        className={
                          "tree-table " +
                          (activeTable?.id === table.id ? "active" : "")
                        }
                        onClick={() => void chooseTable(table.id)}
                        onDoubleClick={() => {
                          if (mode === "data" && !remote)
                            void editTable(table.id);
                        }}
                      >
                        <span className="table-icon">
                          <Table2 size={17} />
                        </span>
                        <span className="table-label">
                          <strong>
                            {table.namespace ? table.namespace + "." : ""}
                            {table.name}
                          </strong>
                        </span>
                      </button>
                      <Button
                        className="table-columns-toggle"
                        title={`Toggle columns · ${table.name}`}
                        aria-label={`Toggle columns · ${table.name}`}
                        aria-expanded={expandedTables.includes(
                          w.id +
                            ":" +
                            (w.activeSourceId ?? "primary") +
                            ":" +
                            table.id,
                        )}
                        onClick={async () => {
                          const key =
                            w.id +
                            ":" +
                            (w.activeSourceId ?? "primary") +
                            ":" +
                            table.id;
                          if (!(await leaveDraft())) return;
                          setDataTable(table.id);
                          setExpandedTables((items) =>
                            items.includes(key)
                              ? items.filter((item) => item !== key)
                              : [...items, key],
                          );
                        }}
                      >
                        {expandedTables.includes(
                          w.id +
                            ":" +
                            (w.activeSourceId ?? "primary") +
                            ":" +
                            table.id,
                        ) ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                      </Button>
                    </div>
                    {activeTable?.id === table.id &&
                      expandedTables.includes(
                        w.id +
                          ":" +
                          (w.activeSourceId ?? "primary") +
                          ":" +
                          table.id,
                      ) && (
                        <div className="tree-columns">
                          {table.columns.map((c) => (
                            <button
                              key={c.id}
                              disabled={mode !== "data" || remote}
                              title={`${table.name}.${c.name} · ${c.nativeType ?? c.type}${table.primaryKey.includes(c.id) ? " · Primary key" : ""}${!c.nullable ? " · Required" : ""}`}
                              onClick={(event) =>
                                void openColumn(
                                  table.id,
                                  c.id,
                                  event.currentTarget,
                                )
                              }
                            >
                              {table.primaryKey.includes(c.id) ? (
                                <KeyRound size={11} className="gold" />
                              ) : w.schema.relationships.some((r) =>
                                  r.sourceColumns.includes(c.id),
                                ) ? (
                                <Link2 size={11} className="blue" />
                              ) : (
                                <span className="column-dot" />
                              )}
                              <span>{c.name}</span>
                              <code>
                                {c.nativeType ?? c.type.toLowerCase()}
                              </code>
                            </button>
                          ))}
                        </div>
                      )}
                  </div>
                ))}
              {!w.schema.tables.length && (
                <p className="sidebar-empty">Your tables will appear here.</p>
              )}
              {search && !filteredTables.length && (
                <p className="sidebar-empty">No matching tables.</p>
              )}
            </div>
            {filteredTables.length > 50 && (
              <nav className="table-pagination" aria-label="Table pages">
                <Button
                  title="Previous table page"
                  disabled={currentTablePage === 0}
                  onClick={() => setTablePage(currentTablePage - 1)}
                >
                  <ChevronLeft size={13} />
                </Button>
                <span
                  role="status"
                  title={`${filteredTables.length} tables · 50 per page`}
                >
                  {currentTablePage * 50 + 1}–
                  {Math.min((currentTablePage + 1) * 50, filteredTables.length)}{" "}
                  <span className="muted">/ {filteredTables.length}</span>
                </span>
                <Button
                  title="Next table page"
                  disabled={currentTablePage + 1 >= tablePageCount}
                  onClick={() => setTablePage(currentTablePage + 1)}
                >
                  <ChevronRight size={13} />
                </Button>
              </nav>
            )}
          </aside>
        )}
        {left && (
          <div
            className="sidebar-divider"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={160}
            aria-valuemax={480}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              resizeSidebar(
                event.clientX -
                  workspaceRef.current!.getBoundingClientRect().left,
              );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              resizeSidebar(
                event.key === "Home"
                  ? 160
                  : event.key === "End"
                    ? 480
                    : sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16),
              );
            }}
          />
        )}
        <main className={"main-view mode-" + mode}>
          {w.sources && mode === "sql" ? (
            <MultiSqlWorkspace
              connectionHost={connectionHost}
              key={w.id}
              workspace={w}
              dark={dark}
              busy={busy}
              onBusy={setBusy}
              runRef={remoteRun}
            />
          ) : remote ? (
            <RemoteWorkspace
              key={
                w.id +
                connectionRevision +
                (w.activeSourceId ?? "") +
                JSON.stringify(w.postgres ?? w.mssql)
              }
              sessionKey={
                w.activeSourceId
                  ? sourceSessionKey(w.id, w.activeSourceId)
                  : w.id
              }
              workspace={w}
              mode={mode}
              dark={dark}
              activeTable={activeTable}
              openTables={openDataTables}
              dataLayout={dataLayout}
              onDataLayoutChange={setDataLayout}
              onSelectTable={(id) => void chooseTable(id)}
              onCloseTable={(id) => void closeDataTable(id)}
              runRef={remoteRun}
              onBusy={setBusy}
              onDirty={setDirty}
            />
          ) : (
            <>
              {stale && !busy && (
                <div className="sync-banner">
                  <RefreshCw size={13} />
                  <span>Schema changes pending</span>
                  <Button disabled={dirty} onClick={() => void apply()}>
                    Sync database
                  </Button>
                </div>
              )}
              {mode === "data" ? (
                activeTable ? (
                  <section className="data-view">
                    <div className="compact-toolbar data-tables-toolbar">
                      <div
                        className="data-table-tabs"
                        role="tablist"
                        aria-label="Open tables"
                      >
                        {openDataTables.map((table) => {
                          const isCurrent =
                            dataLayout === "tabs" &&
                            table.id === activeTable.id;
                          return (
                            <div
                              key={table.id}
                              className={`data-table-tab${isCurrent ? " is-active" : ""}`}
                            >
                              <button
                                type="button"
                                role="tab"
                                aria-selected={isCurrent}
                                className="data-table-tab-btn"
                                onClick={() => {
                                  void chooseTable(table.id);
                                  if (dataLayout === "stack") {
                                    setCollapsedDataTables((prev) => {
                                      if (!prev.has(table.id)) return prev;
                                      const next = new Set(prev);
                                      next.delete(table.id);
                                      return next;
                                    });
                                  }
                                }}
                              >
                                <Table2 size={12} />
                                <span className="data-table-tab-name">
                                  {table.namespace
                                    ? `${table.namespace}.${table.name}`
                                    : table.name}
                                </span>
                                <span className="data-table-tab-count">
                                  {(w.data[table.id] ?? []).length}
                                </span>
                              </button>
                              {openDataTables.length > 1 && (
                                <button
                                  type="button"
                                  className="data-table-tab-close"
                                  title={`Close ${table.name}`}
                                  aria-label={`Close ${table.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void closeDataTable(table.id);
                                  }}
                                >
                                  <X size={11} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="row">
                        {openDataTables.length > 1 && (
                          <Button
                            className={
                              dataLayout === "stack" ? "is-active" : undefined
                            }
                            aria-pressed={dataLayout === "stack"}
                            title={
                              dataLayout === "stack"
                                ? "Switch to single table tab view"
                                : "Stack open tables vertically"
                            }
                            onClick={() =>
                              setDataLayout((cur) =>
                                cur === "stack" ? "tabs" : "stack",
                              )
                            }
                          >
                            <Rows3 size={12} />
                            <span>Stack</span>
                          </Button>
                        )}
                        <Button
                          disabled={busy || stale || dirty}
                          onClick={() => void generateData()}
                        >
                          Sample data
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => void editTable(activeTable.id)}
                        >
                          <Settings2 size={14} />
                          Edit table
                        </Button>
                      </div>
                    </div>
                    {dataLayout === "stack" && openDataTables.length > 1 ? (
                      <div className="sql-all-results data-stack-container">
                        {openDataTables.map((table) => {
                          const tableRows = w.data[table.id] ?? EMPTY_ROWS;
                          const isCollapsed = collapsedDataTables.has(table.id);
                          const visibleRowCount = Math.min(
                            Math.max(tableRows.length, 1),
                            6,
                          );
                          const defaultHeight =
                            24 + 26 + visibleRowCount * 25 + 8;
                          const blockHeight =
                            stackTableHeights[table.id] ?? defaultHeight;
                          return (
                            <section
                              key={table.id}
                              className="sql-result-block data-stack-block"
                              data-collapsed={isCollapsed}
                              style={
                                !isCollapsed
                                  ? { height: blockHeight }
                                  : undefined
                              }
                            >
                              <Spreadsheet
                                key={w.id + table.id + schemaSignature}
                                table={table}
                                viewKey={`local:${w.id}:${w.activeSourceId ?? "primary"}:${table.id}`}
                                rows={tableRows}
                                disabled={busy || stale}
                                onDirty={setDirty}
                                onSave={(rows) => saveRowsForTable(table, rows)}
                                onAddColumn={(anchor) =>
                                  void openColumn(table.id, undefined, anchor)
                                }
                                onEditColumn={(columnId, anchor) =>
                                  void openColumn(table.id, columnId, anchor)
                                }
                                structureDisabled={busy}
                                stackHeader={{
                                  collapsed: isCollapsed,
                                  onToggleCollapse: () =>
                                    setCollapsedDataTables((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(table.id))
                                        next.delete(table.id);
                                      else next.add(table.id);
                                      return next;
                                    }),
                                  onMaximize: () => {
                                    void chooseTable(table.id);
                                    setDataLayout("tabs");
                                  },
                                  onClose:
                                    openDataTables.length > 1
                                      ? () => void closeDataTable(table.id)
                                      : undefined,
                                }}
                              />
                              {!isCollapsed && (
                                <div
                                  className="stack-block-resizer"
                                  role="separator"
                                  aria-orientation="horizontal"
                                  aria-label={`Resize ${table.name} height`}
                                  title="Drag to adjust table height · Double-click to reset"
                                  onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.currentTarget.setPointerCapture(
                                      event.pointerId,
                                    );
                                    stackResizeDrag.current = {
                                      tableId: table.id,
                                      startY: event.clientY,
                                      startHeight: blockHeight,
                                    };
                                  }}
                                  onPointerMove={(event) => {
                                    const activeDrag = stackResizeDrag.current;
                                    if (
                                      !activeDrag ||
                                      activeDrag.tableId !== table.id
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
                                      prev[table.id] === nextHeight
                                        ? prev
                                        : { ...prev, [table.id]: nextHeight },
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
                                      if (!(table.id in prev)) return prev;
                                      const next = { ...prev };
                                      delete next[table.id];
                                      return next;
                                    });
                                  }}
                                />
                              )}
                            </section>
                          );
                        })}
                      </div>
                    ) : (
                      <Spreadsheet
                        key={w.id + activeTable.id + schemaSignature}
                        table={activeTable}
                        viewKey={`local:${w.id}:${w.activeSourceId ?? "primary"}:${activeTable.id}`}
                        rows={w.data[activeTable.id] ?? EMPTY_ROWS}
                        disabled={busy || stale}
                        onDirty={setDirty}
                        onSave={saveRows}
                        onAddColumn={(anchor) =>
                          void openColumn(activeTable.id, undefined, anchor)
                        }
                        onEditColumn={(columnId, anchor) =>
                          void openColumn(activeTable.id, columnId, anchor)
                        }
                        structureDisabled={busy}
                      />
                    )}
                  </section>
                ) : (
                  <div className="empty-state">
                    <Database size={32} />
                    <h2>No tables yet</h2>
                    <Button
                      className="primary"
                      disabled={busy}
                      onClick={() => void addTable()}
                    >
                      <Plus size={14} />
                      Create table
                    </Button>
                  </div>
                )
              ) : (
                <SqlWorkspace
                  key={w.id}
                  tabs={sqlTabs(w)}
                  activeId={activeSqlTab(w).id}
                  layout={w.sqlLayout}
                  onLayoutChange={(layout) =>
                    edit((d) => {
                      d.sqlLayout = layout;
                    })
                  }
                  onTabsChange={(tabs, active, layout) =>
                    edit((d) => {
                      setSqlTabs(d, tabs, active, layout);
                    })
                  }
                  value={activeSqlTab(w).sql}
                  onChange={(sql) =>
                    edit((d) => {
                      const tabs = sqlTabs(d);
                      tabs.find((tab) => tab.id === activeSqlTab(d).id)!.sql =
                        sql;
                      setSqlTabs(d, tabs, activeSqlTab(d).id);
                    })
                  }
                  cancelPending={localCancelPending}
                  onCancel={
                    localQueryRunning
                      ? () => {
                          if (localCancelled.current) return;
                          localCancelled.current = true;
                          setLocalCancelPending(true);
                          const requestId = localExecutionId.current;
                          void cancelLocalQuery().catch((error) => {
                            if (
                              requestId !== localExecutionId.current ||
                              !localRunActive.current
                            )
                              return;
                            localCancelled.current = false;
                            setMessage(String(error));
                            setError(true);
                            setLocalCancelPending(false);
                          });
                        }
                      : undefined
                  }
                  onRun={(tabId, sql) => void run(tabId, sql)}
                  disabled={busy || stale}
                  busy={busy}
                  dark={dark}
                  tabContext={{
                    sourceId: "local",
                    schema: w.schema,
                    dialect: "default",
                    label: "DuckDB",
                    remote: false,
                  }}
                  onEditingResult={setDirty}
                  getEditableResult={(_tabId, result) =>
                    stale ? undefined : editableResult(result, w.schema, "default")
                  }
                  onSaveResult={async (tabId, result, drafts, index) => {
                    const table = editableResult(result, w.schema, "default");
                    if (!table)
                      throw Error(
                        "Only full rows from a single table with a primary key can be edited.",
                      );
                    const data = await saveGridChanges(w, table, drafts);
                    edit((d) => {
                      d.data = data;
                    });
                    const rows = (await query(result.sql)).rows;
                    setQueryResults((previous) => ({
                      ...previous,
                      [tabId]: (previous[tabId] ?? []).map((item, position) =>
                        position === index
                          ? { ...item, rows, status: `${rows.length} rows · updated` }
                          : item,
                      ),
                    }));
                    return rows;
                  }}
                  allResults={queryResults}
                  queryResults={queryResults[activeSqlTab(w).id]}
                  onSelection={(sql, tabId) => {
                    sqlSelection.current = {
                      tabId: tabId ?? activeSqlTab(w).id,
                      sql,
                    };
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>
      {message && (
        <div
          className={"notification " + (error ? "notification-error" : "")}
          role={error ? "alert" : "status"}
        >
          {error ? <Terminal size={16} /> : <Check size={16} />}
          <span>{message}</span>
          <Button title="Dismiss notification" onClick={() => setMessage("")}>
            <X size={15} />
          </Button>
        </div>
      )}
      {columnEditor &&
        w.schema.tables.some((t) => t.id === columnEditor.tableId) && (
          <ColumnEditor
            key={columnEditor.tableId + (columnEditor.columnId ?? "new")}
            workspace={w}
            table={w.schema.tables.find((t) => t.id === columnEditor.tableId)!}
            columnId={columnEditor.columnId}
            anchor={columnEditor.anchor}
            dark={dark}
            onClose={() => setColumnEditor(null)}
            onCommit={commitColumn}
          />
        )}
      {tableEditor && (
        <TableEditor
          key={tableEditor.table.id}
          initial={tableEditor.table}
          isNew={tableEditor.isNew}
          onClose={() => setTableEditor(null)}
          onSaved={(tableId) => {
            setDataTable(tableId);
            setTableEditor(null);
          }}
          onDeleted={() => {
            setDataTable("");
            setTableEditor(null);
          }}
        />
      )}
      <Dialog.Root open={ddl} onOpenChange={setDdl}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>Your schema, in SQL.</Dialog.Title>
            <Dialog.Description>
              DuckDB DDL generated from the current design. Logical
              relationships are visual only.
            </Dialog.Description>
            <pre>{ddlSql}</pre>
            <Dialog.Close asChild>
              <Button>Done</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
