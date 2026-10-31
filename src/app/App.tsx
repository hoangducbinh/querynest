import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readDarkAppearance, saveDarkAppearance } from "./appearance";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  ChevronDown,
  Code2,
  Database,
  Download,
  Ellipsis,
  FlaskConical,
  FolderOpen,
  KeyRound,
  Waypoints,
  Link2,
  Moon,
  PanelLeftClose,
  Plus,
  Redo2,
  RefreshCw,
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
import {
  createWorkspace,
  id,
  parseWorkspace,
  validateSchema,
} from "../features/schema/core";
import { Diagram } from "../features/erd/Diagram";
import { TableEditor } from "../features/schema/TableEditor";
import { newTable } from "../features/schema/table-edit";
import { RelationshipManager } from "../features/schema/RelationshipManager";
import { ColumnEditor } from "../features/schema/ColumnEditor";
import { RelationshipDetails } from "../features/erd/RelationshipDetails";
import { planTableEdit } from "../features/schema/table-edit";
import { activeSqlTab, sqlTabs, setSqlTabs } from "../features/sql/tabs";
import { executeSqlBatch, type SqlResult } from "../features/sql/execution";
import { SqlWorkspace } from "../features/sql/SqlWorkspace";

import { Spreadsheet } from "../features/sample-data/Spreadsheet";
import { saveGridChanges } from "../features/sample-data/mutations";
import type { DraftRow } from "../features/sample-data/model";
import { Requirements } from "../features/test-cases/Requirements";
import { compareResults } from "../features/test-cases/compare";
import { generateDDL, orderedTables, quote } from "../lib/ddl/generate";
import { literal, query, rebuild, snapshot } from "../lib/duckdb/engine";
import { saveWorkspace, storage } from "../lib/storage/workspaces";
import type { TableDefinition, WorkspaceDefinition } from "../types/schema";
type Mode = "data" | "relations" | "sql" | "tests";
const modes = [
  { id: "data", label: "Data", icon: Table2 },
  { id: "sql", label: "SQL", icon: Code2 },
  { id: "tests", label: "Tests", icon: FlaskConical },
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
  const { workspace: w, edit, load, undo, redo, past, future } = useStore();
  const [mode, setMode] = useState<Mode>("sql");
  const [selected, setSelected] = useState("");
  const [dataTable, setDataTable] = useState("");
  const [search, setSearch] = useState("");
  const [left, setLeft] = useState(true);
  const [tableEditor, setTableEditor] = useState<{
    table: TableDefinition;
    isNew: boolean;
  } | null>(null);
  const [columnEditor, setColumnEditor] = useState<{
    tableId: string;
    columnId?: string;
    anchor: HTMLButtonElement;
  } | null>(null);
  const [relationshipsTable, setRelationshipsTable] = useState<string | null>(
    null,
  );
  const [dark, setDark] = useState(readDarkAppearance);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
    saveDarkAppearance(dark);
  }, [dark]);
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState("");
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("Opening workspace…");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [queryResults, setQueryResults] = useState<Record<string, SqlResult[]>>(
    {},
  );
  const sqlSelection = useRef({ tabId: "", sql: "" });

  const [open, setOpen] = useState(false);
  const [ddl, setDdl] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const searchInput = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const runRef = useRef<() => void>(() => {});
  const schemaSignature = signature(w);
  const stale = runtime !== schemaSignature;
  const activeTable =
    w.schema.tables.find((t) => t.id === dataTable) || w.schema.tables[0];
  const errors = validateSchema(w.schema);
  const selectedRelationship = w.schema.relationships.find(
    (r) => r.id === selected,
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
    const timer = setTimeout(() => {
      saveWorkspace(w)
        .then(() => setSaved("Saved on this device"))
        .catch((e) => {
          setSaved("Save failed");
          setMessage(String(e));
          setError(true);
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [w, ready]);
  // Reconstruct a workspace once on open; later design changes require an explicit sync.
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setBusy(true);
    setRuntime("");
    setQueryResults({});
    setTestResults({});
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
  }, [ready, w.id]);
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
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
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
      !(await confirmAction(
        "You have unsaved cells. Discard these changes and continue?",
      ))
    )
      return false;
    return true;
  }
  async function changeMode(next: Mode) {
    if (next === mode || !(await leaveDraft())) return;
    setMode(next);
  }
  async function chooseTable(tableId: string) {
    if (tableId === activeTable?.id && mode !== "relations") return;
    if (!(await leaveDraft())) return;
    setDataTable(tableId);
    setSelected(tableId);
    if (mode === "relations") setMode("data");
  }
  function inspect(entityId: string) {
    setSelected(entityId);
    if (w.schema.tables.some((t) => t.id === entityId)) setDataTable(entityId);
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
  async function run() {
    if (stale || busy) return;
    await task(async () => {
      const tab = activeSqlTab(w);
      const selected =
        sqlSelection.current.tabId === tab.id ? sqlSelection.current.sql : "";
      const results = await executeSqlBatch(
        selected.trim() ? selected : tab.sql,
        query,
      );
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
  }
  runRef.current = () => {
    if (mode === "sql") void run();
  };
  async function saveRows(rows: DraftRow[]) {
    if (stale || busy || !activeTable)
      throw Error("Wait for the database to be ready before saving.");
    setBusy(true);
    try {
      const data = await saveGridChanges(w, activeTable, rows);
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
      return data[activeTable.id] ?? [];
    } finally {
      setBusy(false);
    }
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
  async function newWorkspace() {
    if (
      !(await leaveDraft()) ||
      !(await confirmAction(
        "Create a new workspace? The current workspace will be saved.",
      ))
    )
      return;
    await task(async () => {
      await saveWorkspace(w);
      load(createWorkspace(false));
      setSelected("");
      setDataTable("");
      setMode("data");
    });
  }
  async function openWorkspaces() {
    if (!(await leaveDraft())) return;
    await task(async () => {
      await saveWorkspace(w);
      setWorkspaces(
        await storage.workspaces.orderBy("updatedAt").reverse().toArray(),
      );
      setOpen(true);
    });
  }
  function exportWorkspace() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(w, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = w.name + ".json";
    link.click();
    URL.revokeObjectURL(url);
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
            return column.type === "VARCHAR"
              ? literal(column.name + " sample")
              : column.type === "BOOLEAN"
                ? "TRUE"
                : column.type === "DATE"
                  ? "DATE '2026-01-01'"
                  : column.type === "TIMESTAMP"
                    ? "TIMESTAMP '2026-01-01 00:00:00'"
                    : String(index + 1);
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
  async function runTests(testId?: string) {
    if (stale || busy) return;
    await task(async () => {
      for (const test of w.tests.filter(
        (test) => !testId || test.id === testId,
      )) {
        try {
          const expected = JSON.parse(test.expected);
          if (!Array.isArray(expected))
            throw Error("Expected rows must be a JSON array.");
          const actual = (await query(test.sql)).rows;
          setTestResults((results) => ({
            ...results,
            [test.id]:
              (compareResults(actual, expected, test.ordered)
                ? "PASS"
                : "FAIL") +
              " · " +
              JSON.stringify(actual),
          }));
        } catch (error) {
          setTestResults((results) => ({
            ...results,
            [test.id]: "ERROR · " + String(error),
          }));
        }
      }
    });
  }
  return (
    <div className={"app " + (dark ? "dark" : "")}>
      <DialogHost />
      <header className="app-header">
        <div className="brand">
          <Button
            title={left ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setLeft(!left)}
          >
            <PanelLeftClose size={16} />
          </Button>
          <div className="brand-icon">
            <Database size={21} />
          </div>
          <input
            aria-label="Workspace name"
            value={w.name}
            disabled={busy}
            onChange={(e) =>
              edit((d) => {
                d.name = e.target.value;
              })
            }
          />
        </div>
        <nav className="mode-switch" aria-label="Workspace mode">
          {modes.map((item) => (
            <button
              key={item.id}
              aria-current={
                mode === item.id || (item.id === "data" && mode === "relations")
                  ? "page"
                  : undefined
              }
              onClick={() => void changeMode(item.id)}
            >
              <item.icon size={15} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="header-actions">
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
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
          <details
            className="workspace-menu"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button"))
                e.currentTarget.removeAttribute("open");
            }}
          >
            <summary aria-label="Workspace actions">
              <Ellipsis size={19} />
            </summary>
            <div>
              <Button disabled={busy} onClick={() => void newWorkspace()}>
                <Plus size={15} />
                New workspace
              </Button>
              <Button disabled={busy} onClick={() => void openWorkspaces()}>
                <FolderOpen size={15} />
                Open workspace
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await leaveDraft()) file.current?.click();
                }}
              >
                <Upload size={15} />
                Import JSON
              </Button>
              <Button
                onClick={() => {
                  try {
                    generateDDL(w.schema);
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
                Export workspace
              </Button>
              <hr />
              <Button disabled={!past.length || busy || dirty} onClick={undo}>
                <Undo2 size={15} />
                Undo design change
              </Button>
              <Button disabled={!future.length || busy || dirty} onClick={redo}>
                <Redo2 size={15} />
                Redo design change
              </Button>
            </div>
          </details>
        </div>
      </header>
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
            setSelected("");
            setDataTable("");
          });
        }}
      />
      <div className="workspace">
        {left && (
          <aside className="explorer">
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
            <button
              className={
                "sidebar-relations " + (mode === "relations" ? "active" : "")
              }
              aria-current={mode === "relations" ? "page" : undefined}
              onClick={() => void changeMode("relations")}
            >
              <Waypoints size={16} />
              <span>Relations</span>
              <small>{w.schema.relationships.length}</small>
            </button>
            <div className="section-heading">
              <span>TABLES</span>
              <span>{w.schema.tables.length}</span>
              <Button
                title="Create table"
                disabled={busy}
                style={mode === "relations" ? { display: "none" } : undefined}
                onClick={() => void addTable()}
              >
                <Plus size={15} />
              </Button>
            </div>
            <div className="table-list">
              {w.schema.tables
                .filter((t) =>
                  t.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((table) => (
                  <div key={table.id}>
                    <button
                      className={
                        "tree-table " +
                        (mode !== "relations" && activeTable?.id === table.id
                          ? "active"
                          : "")
                      }
                      onClick={() => void chooseTable(table.id)}
                      onDoubleClick={() => {
                        if (mode === "data") void editTable(table.id);
                      }}
                    >
                      <span className="table-icon">
                        <Table2 size={17} />
                      </span>
                      <span className="table-label">
                        <strong>{table.name}</strong>
                      </span>
                      <ChevronDown size={12} />
                    </button>
                    {(mode === "data" || mode === "sql") &&
                      activeTable?.id === table.id && (
                        <div className="tree-columns">
                          {table.columns.map((c) => (
                            <button
                              key={c.id}
                              disabled={mode === "sql"}
                              title={`${table.name}.${c.name} · ${c.type}${table.primaryKey.includes(c.id) ? " · Primary key" : ""}${!c.nullable ? " · Required" : ""}`}
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
                              <code>{c.type.toLowerCase()}</code>
                            </button>
                          ))}
                        </div>
                      )}
                  </div>
                ))}
              {!w.schema.tables.length && (
                <p className="sidebar-empty">Your tables will appear here.</p>
              )}
              {search &&
                !w.schema.tables.some((t) =>
                  t.name.toLowerCase().includes(search.toLowerCase()),
                ) && <p className="sidebar-empty">No matching tables.</p>}
            </div>
          </aside>
        )}
        <main className={"main-view mode-" + mode}>
          {stale && !busy && mode !== "relations" && (
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
                <div className="compact-toolbar">
                  <div className="row">
                    <Table2 size={14} />
                    <select
                      className="table-selector"
                      aria-label="Selected table"
                      value={activeTable.id}
                      onChange={(e) => void chooseTable(e.target.value)}
                    >
                      {w.schema.tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {table.name}
                        </option>
                      ))}
                    </select>
                    <span className="toolbar-count">
                      {(w.data[activeTable.id] ?? []).length} rows
                    </span>
                  </div>
                  <div className="row">
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        if (await leaveDraft())
                          setRelationshipsTable(activeTable.id);
                      }}
                    >
                      <Link2 size={14} />
                      Relationships
                    </Button>
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
                <Spreadsheet
                  key={w.id + activeTable.id + schemaSignature}
                  table={activeTable}
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
          ) : mode === "relations" ? (
            <div className="design-view">
              <div className="design-workspace">
                <div className="compact-toolbar">
                  <span className="toolbar-count">
                    {w.schema.tables.length} tables ·{" "}
                    {w.schema.relationships.length} relationships
                  </span>
                  <span className="toolbar-count">Drag tables to arrange</span>
                </div>
                <div className="diagram">
                  <Diagram select={inspect} selected={selected} />
                </div>
              </div>
              {selectedRelationship && (
                <aside className="property-panel">
                  <div className="panel-title">
                    <span>Relationship</span>
                    <Button
                      title="Close relationship details"
                      onClick={() => setSelected("")}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                  <RelationshipDetails
                    schema={w.schema}
                    relationship={selectedRelationship}
                  />
                </aside>
              )}
            </div>
          ) : mode === "sql" ? (
            <SqlWorkspace
              key={w.id}
              tabs={sqlTabs(w)}
              activeId={activeSqlTab(w).id}
              onTabsChange={(tabs, active) =>
                edit((d) => {
                  setSqlTabs(d, tabs, active);
                })
              }
              value={activeSqlTab(w).sql}
              onChange={(sql) =>
                edit((d) => {
                  const tabs = sqlTabs(d);
                  tabs.find((tab) => tab.id === activeSqlTab(d).id)!.sql = sql;
                  setSqlTabs(d, tabs, activeSqlTab(d).id);
                })
              }
              onRun={() => void run()}
              disabled={busy || stale}
              busy={busy}
              dark={dark}
              queryResults={queryResults[activeSqlTab(w).id]}
              onSelection={(sql) => {
                sqlSelection.current = { tabId: activeSqlTab(w).id, sql };
              }}
            />
          ) : (
            <Requirements
              results={testResults}
              onRun={(testId) => void runTests(testId)}
              disabled={busy || stale}
            />
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
      {relationshipsTable &&
        w.schema.tables.some((t) => t.id === relationshipsTable) && (
          <RelationshipManager
            table={w.schema.tables.find((t) => t.id === relationshipsTable)!}
            onClose={() => setRelationshipsTable(null)}
          />
        )}
      {tableEditor && (
        <TableEditor
          key={tableEditor.table.id}
          initial={tableEditor.table}
          isNew={tableEditor.isNew}
          onClose={() => setTableEditor(null)}
          onSaved={(tableId) => {
            setSelected(tableId);
            setDataTable(tableId);
            setTableEditor(null);
          }}
          onDeleted={() => {
            setSelected("");
            setDataTable("");
            setTableEditor(null);
          }}
        />
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>Your workspaces</Dialog.Title>
            <Dialog.Description>
              Saved privately in this browser.
            </Dialog.Description>
            {workspaces.map((item) => (
              <Button
                className="workspace-option"
                key={item.id}
                onClick={() => {
                  load(item);
                  setSelected("");
                  setDataTable("");
                  setOpen(false);
                }}
              >
                <span>
                  <Database size={18} />
                  {item.name}
                </span>
                <small>{new Date(item.updatedAt).toLocaleDateString()}</small>
              </Button>
            ))}
            <Dialog.Close asChild>
              <Button>Done</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={ddl} onOpenChange={setDdl}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>Your schema, in SQL.</Dialog.Title>
            <Dialog.Description>
              DuckDB DDL generated from the current design. Logical
              relationships are visual only.
            </Dialog.Description>
            <pre>
              {(() => {
                try {
                  return generateDDL(w.schema);
                } catch (e) {
                  return String(e);
                }
              })()}
            </pre>
            <Dialog.Close asChild>
              <Button>Done</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
