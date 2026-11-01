import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import {
  deleteWorkspace,
  saveConnection,
  saveWorkspace,
  storage,
} from "./workspaces";
import { createWorkspace } from "../../features/schema/core";
import { defaultMssqlConfig } from "../../features/connections/model";
beforeEach(async () => {
  await storage.workspaces.clear();
  await storage.connections.clear();
  await storage.deletedWorkspaces.clear();
});
it("deletes an inactive workspace without changing the active one or saved connections", async () => {
  const active = createWorkspace(false),
    other = createWorkspace(false);
  await saveWorkspace(active);
  await saveWorkspace(other);
  await saveConnection({
    id: "server",
    name: "SQL Server",
    engine: "mssql",
    config: defaultMssqlConfig,
    updatedAt: 1,
  });
  const result = await deleteWorkspace(other.id, active.id);
  expect(result.replacement).toBeUndefined();
  expect(result.workspaces.map((w) => w.id)).toEqual([active.id]);
  expect(await storage.workspaces.get(active.id)).toEqual(active);
  expect(await storage.connections.count()).toBe(1);
  expect(await saveWorkspace(other)).toBe(false);
  expect(await storage.workspaces.get(other.id)).toBeUndefined();
});
it("switches away from a deleted active workspace and blocks late autosaves", async () => {
  const active = createWorkspace(false),
    other = { ...createWorkspace(false), sql: "SELECT 42;", updatedAt: 1 };
  await saveWorkspace(active);
  await saveWorkspace(other);
  const result = await deleteWorkspace(active.id, active.id);
  expect(result.replacement?.id).toBe(other.id);
  expect(result.replacement?.sql).toBe("SELECT 42;");
  await Promise.all([
    saveWorkspace(active),
    saveWorkspace({ ...active, name: "late autosave" }),
  ]);
  expect(await storage.workspaces.get(active.id)).toBeUndefined();
  expect(await storage.workspaces.count()).toBe(1);
});
it("replaces the last workspace with a persisted empty local workspace", async () => {
  const active = createWorkspace(false);
  await saveWorkspace(active);
  const result = await deleteWorkspace(active.id, active.id);
  expect(result.replacement?.id).not.toBe(active.id);
  expect(result.replacement?.sql).toBe("");
  expect(result.replacement?.schema.tables).toEqual([]);
  expect(result.replacement?.postgres).toBeUndefined();
  expect(result.replacement?.mssql).toBeUndefined();
  expect(await storage.workspaces.get(result.replacement!.id)).toEqual(
    result.replacement,
  );
});
