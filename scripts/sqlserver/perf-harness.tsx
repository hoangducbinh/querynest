import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { isTauri } from "@tauri-apps/api/core";
import { ResultGrid } from "../../src/features/sample-data/ResultGrid";
import App from "../../src/app/App";
import { setSqlTabs, sqlTabs } from "../../src/features/sql/tabs";
import { storage, workspaceSnapshot } from "../../src/lib/storage/workspaces";
import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { produce } from "immer";
import { catalogSchema } from "../../src/features/postgres/model";
import { createWorkspace } from "../../src/features/schema/core";
import { defaultRemoteConfig } from "../../src/features/connections/model";
import {
  attachSource,
  activateSource,
  updateSource,
  captureActiveSource,
  ensureSources,
} from "../../src/features/connections/sources";
import { sqlCompletions } from "../../src/features/sql/completions";
import { Spreadsheet } from "../../src/features/sample-data/Spreadsheet";
import { SqlEditor } from "../../src/features/sql/Editor";
import "../../src/styles.css";

const catalog = await fetch("./perf-catalog.local.json").then((r) => r.json());
const rows = await fetch("./perf-wide.local.json").then((r) => r.json());
const schema = catalogSchema(catalog);
const wide = schema.tables.find(
  (t) => t.namespace === "StressTest" && t.name === "WideRows",
)!;
const metrics: Record<string, unknown> = {
  tables: schema.tables.length,
  columns: schema.tables.reduce((n, t) => n + t.columns.length, 0),
  wideColumns: wide.columns.length,
};
const samples: Record<string, number[]> = {};
const write = () => {
  const output = document.getElementById("metrics");
  if (output) output.textContent = JSON.stringify(metrics, null, 2);
};
function time(name: string, fn: () => unknown, count = 5) {
  const durations: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    fn();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  metrics[name] = {
    medianMs: +durations[Math.floor(count / 2)].toFixed(2),
    maxMs: +durations.at(-1)!.toFixed(2),
  };
}
function benchmark() {
  time("catalogMapping", () => catalogSchema(catalog));
  const base = createWorkspace(false);
  const config = defaultRemoteConfig("mssql");
  config.config.database = "AdventureWorksLT2019_Test";
  const id = attachSource(base, {
    ...config,
    id: "perf",
    name: "StressTest",
    updatedAt: 0,
  });
  const w = produce(base, (draft) => {
    updateSource(draft, id, { schema });
    activateSource(draft, id);
  });
  time("metadataUpdate", () =>
    produce(w, (draft) => updateSource(draft, id, { schema })),
  );
  time("captureSource", () =>
    produce(w, (draft) => captureActiveSource(draft)),
  );
  time("saveSnapshotPreparation", () => {
    workspaceSnapshot(w);
  });
  const text =
    "SELECT TOP (3) w.Amount001, w.Label001 FROM StressTest.WideRows w WHERE w.RowID = 42";
  time(
    "completionAllKeystrokes",
    () => {
      for (let i = 1; i <= text.length; i++)
        sqlCompletions(text.slice(0, i), i, schema, [], "mssql");
    },
    10,
  );
  write();
}
const profile: React.ProfilerOnRenderCallback = (id, phase, duration) => {
  const name = `${id}:${phase}`;
  const values = samples[name] ?? (samples[name] = []);
  values.push(duration);
  metrics[name] = {
    commits: values.length,
    lastMs: +duration.toFixed(2),
    maxMs: +Math.max(...values).toFixed(2),
    medianMs: +[...values]
      .sort((a, b) => a - b)
      [Math.floor(values.length / 2)].toFixed(2),
  };
  requestAnimationFrame(write);
};
const mockResultRows = structuredClone(rows) as Record<string, unknown>[];
let nativeMockInstalled = false;
const mockWaiters = new Map<
  string,
  { reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();
let mockSessionNumber = 0;
function installConnectionMocks() {
  if (nativeMockInstalled) return;
  if (isTauri() && !nativeMockInstalled)
    throw Error("Use the connection mock harness in a separate browser only.");
  nativeMockInstalled = true;
  Object.defineProperty(window, "isTauri", { value: true, configurable: true });
  mockWindows("main");
  mockIPC(
    (command, payload) => {
      const args = (payload ?? {}) as {
        sessionId?: string;
        sql?: string;
        database?: string;
        tableId?: string;
        changes?: {
          original?: Record<string, unknown>;
          cells: Record<string, string | null>;
          deleted: boolean;
        }[];
      };
      const counts = (metrics.mockCommands ??= {}) as Record<string, number>;
      counts[command] = (counts[command] ?? 0) + 1;
      requestAnimationFrame(write);
      if (command === "ms_connect" || command === "ms_open_database")
        return {
          sessionId: `mock-session-${++mockSessionNumber}`,
          serverVersion: "16 mock",
          catalog,
        };
      if (command === "ms_catalog") return catalog;
      if (command === "ms_test_connection") return { serverVersion: "16 mock" };
      if (command === "ms_databases")
        return ["master", "AdventureWorksLT2019_Test"];
      if (command === "ms_validate") return [];
      if (command === "ms_table_data") {
        metrics.lastGridSession = args.sessionId;
        return {
          columns: wide.columns.map((column) => column.name),
          rows: args.tableId === wide.id ? mockResultRows : [],
          affectedRows: 0,
          truncated: false,
        };
      }
      if (command === "ms_save_grid") {
        for (const change of args.changes ?? []) {
          const index = change.original
            ? mockResultRows.findIndex(
                (row) =>
                  JSON.stringify(row) === JSON.stringify(change.original),
              )
            : -1;
          if (change.deleted) {
            if (index >= 0) mockResultRows.splice(index, 1);
            continue;
          }
          if (index >= 0)
            for (const [name, value] of Object.entries(change.cells)) {
              mockResultRows[index][name] =
                value !== null &&
                typeof mockResultRows[index][name] === "number"
                  ? Number(value)
                  : value;
            }
        }
        return args.changes?.length ?? 0;
      }
      if (command === "ms_query") {
        metrics.lastQuerySession = args.sessionId;
        if (/WAITFOR/i.test(args.sql ?? ""))
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              mockWaiters.delete(args.sessionId!);
              resolve({
                columns: ["spid"],
                rows: [{ spid: 77 }],
                affectedRows: 0,
                truncated: false,
              });
            }, 15000);
            mockWaiters.set(args.sessionId!, { reject, timer });
          });
        if (/StressTest\.WideRows/i.test(args.sql ?? ""))
          return {
            columns: wide.columns.map((column) => column.name),
            rows: mockResultRows,
            messages: ["Fixture server output", "(100 rows affected)"],
            affectedRows: 0,
            truncated: false,
          };
        return {
          columns: ["spid"],
          rows: [{ spid: 77 }],
          affectedRows: 0,
          truncated: false,
        };
      }
      if (command === "ms_cancel") {
        const pending = mockWaiters.get(args.sessionId!);
        if (pending) {
          clearTimeout(pending.timer);
          mockWaiters.delete(args.sessionId!);
          pending.reject({
            message: "Query stopped. Connection kept open.",
            closed: false,
          });
        }
      }
      return undefined;
    },
    { shouldMockEvents: true },
  );
}

function Harness() {
  const [view, setView] = useState("none");
  const [sql, setSql] = useState("SELECT TOP (3) * FROM StressTest.WideRows");
  async function openApp() {
    const base = createWorkspace(false);
    base.id = "stress-perf-workspace";
    const config = defaultRemoteConfig("mssql");
    config.config.database = "AdventureWorksLT2019_Test";
    const id = attachSource(base, {
      ...config,
      id: "perf",
      name: "StressTest",
      updatedAt: Date.now(),
    });
    const w = produce(base, (draft) => {
      updateSource(draft, id, { schema });
      activateSource(draft, id);
      setSqlTabs(
        draft,
        sqlTabs(draft).map((tab) => ({ ...tab, sourceId: id })),
        sqlTabs(draft)[0].id,
      );
      draft.name = "StressTest isolated benchmark";
    });
    await storage.workspaces.put(workspaceSnapshot(w));
    setView("app");
  }
  async function openConnectionUX(secondary = false) {
    setView("none");
    installConnectionMocks();
    const profile = {
      ...defaultRemoteConfig("mssql"),
      id: "perf-center-profile",
      name: "SQL Server QA (mock)",
      updatedAt: Date.now(),
    };
    profile.config.database = "AdventureWorksLT2019_Test";
    profile.config.user = "sa";
    profile.config.readOnly = false;
    await storage.connections.put(profile);
    const w = createWorkspace(false);
    w.id = secondary ? "connection-ux-secondary" : "connection-ux-main";
    w.name = secondary
      ? "Shared connection workspace B"
      : "Connection center QA";
    const id = attachSource(w, profile);
    updateSource(w, id, { schema });
    activateSource(w, id);
    const tabs = sqlTabs(w).map((tab) => ({
      ...tab,
      sourceId: id,
      sql: "WAITFOR DELAY '00:00:15'; SELECT @@SPID AS spid;",
    }));
    setSqlTabs(w, tabs, tabs[0].id);
    await storage.workspaces.put(workspaceSnapshot(w));
    setView("app");
  }
  async function openLocalStopCheck() {
    setView("none");
    const w = createWorkspace(false);
    w.id = "stress-perf-local-stop";
    w.name = "Local query cancellation check";
    ensureSources(w);
    const tabs = sqlTabs(w).map((tab) => ({
      ...tab,
      sql: "SELECT sum(a.i * b.i) AS total FROM range(1000000) a(i) CROSS JOIN range(1000000) b(i);\n\nSELECT 99 AS must_not_run;",
    }));
    setSqlTabs(w, tabs, tabs[0].id);
    await storage.workspaces.put(workspaceSnapshot(w));
    setView("app");
  }
  return (
    <div className="app" style={{ height: "100vh" }}>
      <div style={{ padding: 12, display: "flex", gap: 10 }}>
        <button onClick={benchmark}>Measure catalog and typing helpers</button>
        <button onClick={() => setView("grid")}>Open WideRows</button>
        <button onClick={() => setView("sql")}>Open SQL editor</button>
        <button onClick={() => setView("results")}>Open SQL results</button>
      </div>
      <button onClick={openApp}>Open full workspace</button>
      <button onClick={openLocalStopCheck}>Open local Stop check</button>
      <button onClick={() => void openConnectionUX()}>
        Open connection UX check
      </button>
      <button onClick={() => void openConnectionUX(true)}>
        Open second connection workspace
      </button>
      <button
        onClick={() => {
          for (const key of Object.keys(samples)) {
            delete samples[key];
            delete metrics[key];
          }
          write();
        }}
      >
        Reset render samples
      </button>
      <pre
        id="metrics"
        style={{
          margin: 0,
          padding: 10,
          fontSize: 11,
          maxHeight: 210,
          overflow: "auto",
          flexShrink: 0,
        }}
      />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {view === "app" && (
          <Profiler id="fullApp" onRender={profile}>
            <App />
          </Profiler>
        )}
        {view === "results" && (
          <Profiler id="wideResults" onRender={profile}>
            <ResultGrid
              rows={rows}
              columns={wide.columns.map((column) => column.name)}
            />
          </Profiler>
        )}
        {view === "grid" && (
          <Profiler id="wideGrid" onRender={profile}>
            <Spreadsheet
              table={wide}
              rows={rows}
              disabled={false}
              structureDisabled={false}
              onDirty={() => {}}
              onSave={async () => rows}
            />
          </Profiler>
        )}
        {view === "sql" && (
          <Profiler id="editor" onRender={profile}>
            <SqlEditor
              schema={schema}
              dialect="mssql"
              value={sql}
              onChange={setSql}
              validationEnabled={false}
            />
          </Profiler>
        )}
      </div>
    </div>
  );
}
const root =
  import.meta.hot?.data.reactRoot ??
  createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.reactRoot = root;
root.render(<Harness />);
requestAnimationFrame(write);
