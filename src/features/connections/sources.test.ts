import { defaultPostgresConfig } from "../postgres/model";
import { describe, expect, it } from "vitest";
import { produce } from "immer";
import "fake-indexeddb/auto";
import { createWorkspace, parseWorkspace } from "../schema/core";
import { defaultRemoteConfig, type ConnectionProfile } from "./model";
import {
  attachDatabase,
  syncActiveSqlSource,
  connectionRoot,
  activateSource,
  attachSource,
  captureActiveSource,
  removeSource,
  tabSource,
  updateSource,
  workspaceSources,
} from "./sources";
import { sqlTabs, setSqlTabs, bindNewTabs } from "../sql/tabs";
import {
  storage,
  saveWorkspace,
  workspaceSnapshot,
} from "../../lib/storage/workspaces";
const pg = {
  engine: "postgres",
  config: { ...defaultPostgresConfig },
  id: "pg",
  name: "Analytics PG",
  updatedAt: 1,
} satisfies ConnectionProfile;
const ms: ConnectionProfile = {
  ...defaultRemoteConfig("mssql"),
  id: "ms",
  name: "Warehouse SQL Server",
  updatedAt: 1,
};
describe("workspace connections and tab routing", () => {
  it("migrates legacy local workspaces without changing SQL, schema, rows or split groups", () => {
    const w = createWorkspace();
    const old = structuredClone(w);
    const original = sqlTabs(w)[0];
    setSqlTabs(
      w,
      [original, { id: "right", name: "right.sql", sql: "SELECT 2" }],
      original.id,
      {
        width: 61,
        groups: [
          { ids: [original.id], activeId: original.id },
          { ids: ["right"], activeId: "right" },
        ],
      },
    );
    const layout = structuredClone(w.sqlLayout);
    const next = produce(w, (draft) => {
      const id = attachSource(draft, pg);
      activateSource(draft, id);
    });
    expect(next.sources?.[0].schema).toEqual(old.schema);
    expect(next.sources?.[0].data).toEqual(old.data);
    expect(sqlTabs(next).map((tab) => tab.sourceId)).toEqual([
      "primary",
      "primary",
    ]);
    expect(sqlTabs(next)[0].sql).toBe(original.sql);
    expect(next.sqlLayout).toEqual(layout);
    expect(next.schema.tables).toEqual([]);
    expect(next.postgres).toBeDefined();
  });
  it("routes individual tabs and keeps catalogs and local rows independent", () => {
    const w = createWorkspace();
    const localData = structuredClone(w.data);
    const a = attachSource(w, pg);
    const b = attachSource(w, ms);
    const tabs = [
      { id: "p", name: "p.sql", sql: "SELECT 1", sourceId: a },
      { id: "m", name: "m.sql", sql: "SELECT 2", sourceId: b },
      { id: "l", name: "l.sql", sql: "SELECT 3", sourceId: "primary" },
    ];
    setSqlTabs(w, tabs, "p");
    activateSource(w, a);
    updateSource(w, a, { schema: { tables: [], relationships: [] } });
    expect(tabSource(w, tabs[0]).connection?.engine).toBe("postgres");
    expect(tabSource(w, tabs[1]).connection?.engine).toBe("mssql");
    expect(tabSource(w, tabs[2]).data).toEqual(localData);
    activateSource(w, "primary");
    expect(w.data).toEqual(localData);
    expect(w.postgres).toBeUndefined();
    expect(tabSource(w, tabs[0]).connection?.engine).toBe("postgres");
  });
  it("deduplicates attached profiles and preserves SQL when removing a connection", () => {
    const w = createWorkspace(false);
    const a = attachSource(w, pg);
    expect(attachSource(w, pg)).toBe(a);
    expect(workspaceSources(w)).toHaveLength(2);
    setSqlTabs(
      w,
      [{ id: "tab", name: "query", sql: "SELECT important", sourceId: a }],
      "tab",
    );
    activateSource(w, a);
    removeSource(w, a);
    expect(w.activeSourceId).toBe("primary");
    expect(sqlTabs(w)[0]).toEqual({
      id: "tab",
      name: "query",
      sql: "SELECT important",
      sourceId: "primary",
    });
    expect(() => removeSource(w, "primary")).toThrow("at least one");
  });
  it("persists active catalogs and per-tab connection assignments through storage and JSON", async () => {
    const w = createWorkspace();
    const a = attachSource(w, pg);
    attachSource(w, ms);
    activateSource(w, a);
    setSqlTabs(
      w,
      [{ id: "remote", name: "r.sql", sql: "SELECT 1", sourceId: a }],
      "remote",
    );
    await saveWorkspace(w);
    const restored = parseWorkspace(
      JSON.stringify(await storage.workspaces.get(w.id)),
    );
    expect(restored.sources).toHaveLength(3);
    expect(restored.activeSourceId).toBe(a);
    expect(tabSource(restored, sqlTabs(restored)[0]).connection?.engine).toBe(
      "postgres",
    );
    await storage.workspaces.delete(w.id);
  });
  it("strips credentials and remote rows from imported connection contexts", () => {
    const w = createWorkspace(false);
    const a = attachSource(w, pg);
    activateSource(w, a);
    captureActiveSource(w);
    const raw = JSON.parse(JSON.stringify(w));
    raw.sources[1].connection.config.password = "never-save";
    raw.sources[1].data = { secret: [{ value: 1 }] };
    raw.sources[1].password = "never-save";
    const parsed = parseWorkspace(JSON.stringify(raw));
    expect(JSON.stringify(parsed)).not.toContain("never-save");
    expect(parsed.sources?.[1].data).toEqual({});
  });
  it("rejects missing active connections, duplicate IDs and dangling SQL tab assignments", () => {
    const w = createWorkspace(false);
    attachSource(w, pg);
    captureActiveSource(w);
    for (const patch of [
      { activeSourceId: "missing" },
      { sources: [w.sources![0], w.sources![0]] },
      {
        sqlTabs: [{ id: "bad", name: "bad", sql: "", sourceId: "missing" }],
        activeSqlTabId: "bad",
      },
    ])
      expect(() =>
        parseWorkspace(JSON.stringify({ ...w, ...patch })),
      ).toThrow();
  });
});

it("new SQL tabs use the sidebar connection while existing tabs keep their own", () => {
  const w = createWorkspace();
  const pgId = attachSource(w, pg);
  const msId = attachSource(w, ms);
  const existing = [
    { id: "old", name: "sql-server.sql", sql: "SELECT 1", sourceId: msId },
  ];
  setSqlTabs(w, existing, "old");
  activateSource(w, pgId);
  const created = { id: "new", name: "query.sql", sql: "" };
  const next = bindNewTabs([...existing, created], existing, w.activeSourceId);
  expect(tabSource(w, next[0]).connection?.engine).toBe("mssql");
  expect(tabSource(w, next[1]).connection?.engine).toBe("postgres");
  expect(next[0].sql).toBe("SELECT 1");
  activateSource(w, "primary");
  const local = bindNewTabs(
    [...next, { id: "local", name: "local.sql", sql: "" }],
    next,
    w.activeSourceId,
  );
  expect(tabSource(w, local[2]).connection).toBeUndefined();
  expect(local[1].sourceId).toBe(pgId);
});

describe("databases under one connection", () => {
  it("keeps distinct database schemas and tab bindings through save and reload", () => {
    const w = createWorkspace(false);
    const root = attachSource(w, pg);
    const child = attachDatabase(w, root, 'analytics " second');
    expect(attachDatabase(w, root, 'analytics " second')).toBe(child);
    expect(
      connectionRoot(
        w,
        w.sources!.find((s) => s.id === child)!,
      ).id,
    ).toBe(root);
    const schema = structuredClone(w.schema);
    updateSource(w, child, { schema });
    setSqlTabs(
      w,
      [
        { id: "a", name: "a.sql", sql: "SELECT 1", sourceId: root },
        { id: "b", name: "b.sql", sql: "SELECT 2", sourceId: child },
      ],
      "b",
    );
    activateSource(w, child);
    captureActiveSource(w);
    const restored = parseWorkspace(JSON.stringify(w));
    expect(
      tabSource(restored, sqlTabs(restored)[0]).connection?.config.database,
    ).toBe(pg.config.database);
    expect(
      tabSource(restored, sqlTabs(restored)[1]).connection?.config.database,
    ).toBe('analytics " second');
    expect(restored.sources!.find((s) => s.id === child)?.parentSourceId).toBe(
      root,
    );
    expect(restored.schema).toEqual(schema);
    expect(restored.postgres?.database).toBe('analytics " second');
  });
  it("migrates legacy single-connection workspaces without rebinding SQL to another database", () => {
    const w = createWorkspace(false);
    w.postgres = pg.config;
    const original = sqlTabs(w)[0];
    const child = attachDatabase(w, "primary", "other");
    expect(sqlTabs(w)[0].id).toBe(original.id);
    expect(sqlTabs(w)[0].sourceId).toBe("primary");
    expect(
      w.sources!.find((s) => s.id === child)?.connection?.config.database,
    ).toBe("other");
    expect(w.postgres?.database).toBe(pg.config.database);
  });
  it("applies server settings across a connection while preserving each database", () => {
    const w = createWorkspace(false);
    const root = attachSource(w, pg);
    const child = attachDatabase(w, root, "other");
    activateSource(w, child);
    updateSource(w, root, {
      connection: { ...pg, config: { ...pg.config, host: "other-host" } },
    });
    expect(w.postgres?.host).toBe("other-host");
    expect(w.postgres?.database).toBe("other");
    updateSource(w, child, {
      connection: {
        engine: "postgres",
        config: { ...pg.config, host: "third-host", database: "other" },
      },
    });
    expect(w.sources!.find((s) => s.id === root)?.connection?.config.host).toBe(
      "third-host",
    );
    expect(() => parseWorkspace(JSON.stringify(w))).not.toThrow();
  });
  it("removes a connection and its databases together without deleting tab text", () => {
    const w = createWorkspace(false);
    const root = attachSource(w, pg);
    const child = attachDatabase(w, root, "other");
    activateSource(w, child);
    setSqlTabs(
      w,
      [{ id: "a", name: "a", sql: "SELECT 1", sourceId: child }],
      "a",
    );
    removeSource(w, root);
    expect(w.sources).toHaveLength(1);
    expect(sqlTabs(w)[0]).toMatchObject({
      sourceId: "primary",
      sql: "SELECT 1",
    });
    expect(() => parseWorkspace(JSON.stringify(w))).not.toThrow();
  });
  it("rejects orphaned, nested and cross-server database references", () => {
    const w = createWorkspace(false);
    const root = attachSource(w, pg);
    const child = attachDatabase(w, root, "other");
    for (const parent of ["missing", child, "primary"]) {
      const raw = structuredClone(w);
      raw.sources!.find((s) => s.id === child)!.parentSourceId = parent;
      expect(() => parseWorkspace(JSON.stringify(raw))).toThrow();
    }
    const raw = structuredClone(w);
    raw.sources!.find((s) => s.id === child)!.connection = {
      engine: "postgres",
      config: { ...pg.config, host: "unrelated" },
    };
    expect(() => parseWorkspace(JSON.stringify(raw))).toThrow();
  });
});

it("uses the active SQL database in Data and Relations while preserving other tab contexts", () => {
  const w = createWorkspace();
  const root = attachSource(w, ms);
  const child = attachDatabase(w, root, "AdventureWorksLT2019_Test");
  const first = { ...sqlTabs(w)[0], sourceId: root };
  const second = {
    id: "adventure",
    name: "test.sql",
    sql: "SELECT 1",
    sourceId: child,
  };
  setSqlTabs(w, [first, second], second.id);
  syncActiveSqlSource(w);
  expect(w.activeSourceId).toBe(child);
  expect(w.mssql?.database).toBe("AdventureWorksLT2019_Test");
  expect(w.connectionId).toBeUndefined();
  setSqlTabs(w, sqlTabs(w), first.id);
  syncActiveSqlSource(w);
  expect(w.activeSourceId).toBe(root);
  expect(w.mssql?.database).toBe(ms.config.database);
  expect(tabSource(w, second).connection?.config.database).toBe(
    "AdventureWorksLT2019_Test",
  );
});

it("keeps refreshed active metadata isolated and captures it on save/export and source switches", () => {
  const w = createWorkspace(false);
  const id = attachSource(w, ms);
  activateSource(w, id);
  const schema = structuredClone(createWorkspace().schema);
  const next = produce(w, (draft) => updateSource(draft, id, { schema }));
  expect(
    workspaceSources(next).find((source) => source.id === id)?.schema,
  ).toEqual(schema);
  const saved = workspaceSnapshot(next);
  expect(saved.sources?.find((source) => source.id === id)?.schema).toEqual(
    schema,
  );
  expect(parseWorkspace(JSON.stringify(saved)).schema).toEqual(schema);
  schema.tables[0].name = "external mutation";
  expect(next.schema.tables[0].name).not.toBe("external mutation");
  const switched = produce(next, (draft) => activateSource(draft, "primary"));
  const returned = produce(switched, (draft) => activateSource(draft, id));
  expect(returned.schema).toEqual(next.schema);
  expect(next.schema.tables.length).toBeGreaterThan(0);
});

it("detaches snapshots of mutable inputs while sharing only frozen catalog state", () => {
  const mutable = createWorkspace();
  const snapshot = workspaceSnapshot(mutable);
  mutable.schema.tables[0].name = "changed after save";
  expect(snapshot.schema.tables[0].name).not.toBe("changed after save");
  const frozen = produce(createWorkspace(), (draft) => {
    draft.sql = "SELECT 42";
  });
  const immutableSnapshot = workspaceSnapshot(frozen);
  expect(immutableSnapshot.schema).toBe(frozen.schema);
  expect(immutableSnapshot).not.toBe(frozen);
});
