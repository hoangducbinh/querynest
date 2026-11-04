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
import {
  invalidateSession,
  requestConnection,
} from "../features/connections/sessions";
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
  Search,
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
import { generateDDL } from "../lib/ddl/generate";
import { RemoteWorkspace } from "../features/connections/RemoteWorkspace";
import type { ConnectionProfile } from "../features/connections/model";
import { saveJsonFile } from "../lib/platform/save-file";
import { useDesktopClose } from "../lib/platform/use-desktop-close";
import {
  saveWorkspace,
  workspaceSnapshot,
  storage,
} from "../lib/storage/workspaces";
import type { TableDefinition } from "../types/schema";
type Mode = "data" | "sql";
const modes = [
  { id: "data", label: "Data", icon: Table2 },
  { id: "sql", label: "SQL", icon: Code2 },
] as const;
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
    () => {
      const needle = search.toLowerCase();
      return w.schema.tables.filter((table) =>
        `${table.namespace ?? ""}.${table.name}`.toLowerCase().includes(needle),
      );
    },
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
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("Opening workspace…");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const remoteRun = useRef<() => void>(() => {});

  const remote = !!(w.postgres || w.mssql);
  const [ddl, setDdl] = useState(false);
  const [ddlSql, setDdlSql] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const runRef = useRef<() => void>(() => {});
  const tablesById = useMemo(
    () => new Map(w.schema.tables.map((table) => [table.id, table])),
    [w.schema.tables],
  );
  const activeTable = tablesById.get(dataTable) ?? w.schema.tables[0];
  const [openDataTableIds, setOpenDataTableIds] = useState<string[]>([]);
  const [dataLayout, setDataLayout] = useState<"tabs" | "stack">("tabs");
  useEffect(() => {
    setOpenDataTableIds([]);
  }, [w.id, w.activeSourceId]);
  useEffect(() => {
    if (!activeTable) return;
    setOpenDataTableIds((prev) =>
      prev.includes(activeTable.id) ? prev : [...prev, activeTable.id],
    );
  }, [activeTable?.id]);
  const openDataTables = useMemo(() => {
    const valid = openDataTableIds
      .map((tid) => tablesById.get(tid))
      .filter((t): t is TableDefinition => Boolean(t));
    if (!valid.length && activeTable) return [activeTable];
    return valid;
  }, [openDataTableIds, tablesById, activeTable]);
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
  runRef.current = () => {
    if (mode === "sql" && (remote || w.sources)) {
      remoteRun.current();
    }
  };
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
    edit((workspace) => {
      workspace.schema = plan.schema;
    });
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
        `SQL tabs keep their text and switch to “${fallback.name}”. Server data and saved connection settings stay available.`,
        {
          title: `Remove “${source.name}”?`,
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
                "status-dot " + (errors.length ? "amber" : "")
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
            <div className="empty-slate">
              <Database size={32} className="accent" />
              <h2>No database connected</h2>
              <p>
                Connect to a PostgreSQL or SQL Server database to explore tables, view data, and run SQL queries.
              </p>
              <Button
                className="primary"
                onClick={() =>
                  requestConnection(
                    w.id,
                    w.activeSourceId ?? "primary",
                    "new",
                  )
                }
              >
                Add connection
              </Button>
            </div>
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
