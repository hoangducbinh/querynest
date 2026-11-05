import "fake-indexeddb/auto";
import Dexie from "dexie";
import { it, expect } from "vitest";
import { storage } from "./workspaces";
import { createWorkspace } from "../../test/fixtures";
import { defaultPostgresConfig } from "../../features/postgres/model";
it("upgrades old PostgreSQL workspaces without losing SQL or layout", async () => {
  storage.close();
  await Dexie.delete(storage.name);
  const old = new Dexie(storage.name);
  old.version(1).stores({ workspaces: "id,name,updatedAt" });
  const workspace = {
    ...createWorkspace(false),
    postgres: defaultPostgresConfig,
    sql: "SELECT 42;",
    diagramPositions: { table: { x: 3, y: 4 } },
  };
  await old.table("workspaces").put(workspace);
  old.close();
  await storage.open();
  const loaded = await storage.workspaces.get(workspace.id);
  const profile = await storage.connections.get(`workspace:${workspace.id}`);
  expect(loaded?.sql).toBe("SELECT 42;");
  expect(loaded?.diagramPositions).toEqual(workspace.diagramPositions);
  expect(loaded?.connectionId).toBe(profile?.id);
  expect(profile?.config).toEqual(defaultPostgresConfig);
  expect(profile?.name).toBe(workspace.name);
});
