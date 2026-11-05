import { captureActiveSource } from "../../features/connections/sources";
import { createWorkspace } from "../../features/schema/core";
import {
  parseProfile,
  type ConnectionProfile,
} from "../../features/connections/model";
import Dexie, { type EntityTable } from "dexie";
import type {
  WorkspaceDefinition,
  SqlAbbreviationSettings,
} from "../../types/schema";
// Keep the storage identity stable across product renames and app updates.
export const storage = new Dexie("database-design-playground") as Dexie & {
  workspaces: EntityTable<WorkspaceDefinition, "id">;
  connections: EntityTable<ConnectionProfile, "id">;
  deletedWorkspaces: EntityTable<{ id: string }, "id">;
  settings: EntityTable<SqlAbbreviationSettings & { id: string }, "id">;
};
storage.version(1).stores({ workspaces: "id,name,updatedAt" });
storage
  .version(2)
  .stores({
    workspaces: "id,name,updatedAt",
    connections: "id,name,engine,updatedAt",
  })
  .upgrade(async (tx) => {
    const workspaces = (await tx
      .table("workspaces")
      .toArray()) as WorkspaceDefinition[];
    for (const workspace of workspaces) {
      if (!workspace.postgres) continue;
      const connectionId = `workspace:${workspace.id}`;
      await tx.table("connections").put(
        parseProfile({
          engine: "postgres",
          config: workspace.postgres,
          id: connectionId,
          name: workspace.name,
          updatedAt: workspace.updatedAt,
        }),
      );
      await tx.table("workspaces").update(workspace.id, { connectionId });
    }
  });
storage.version(3).stores({
  workspaces: "id,name,updatedAt",
  connections: "id,name,engine,updatedAt",
  deletedWorkspaces: "id",
});
storage.version(4).stores({
  workspaces: "id,name,updatedAt",
  connections: "id,name,engine,updatedAt",
  deletedWorkspaces: "id",
  settings: "id",
});
export const saveConnection = (profile: ConnectionProfile) =>
  storage.connections.put(parseProfile(profile));
export function workspaceSnapshot(w: WorkspaceDefinition) {
  // Immer state is deeply frozen. A shallow envelope is sufficient until
  // IndexedDB performs its own structured clone; mutable imports keep a copy.
  const snapshot = Object.isFrozen(w) ? { ...w } : structuredClone(w);
  // This object is already detached from live state: do not clone the active
  // catalog a second time just to serialize it to IndexedDB.
  captureActiveSource(snapshot, false);
  return snapshot;
}
export const saveWorkspace = (w: WorkspaceDefinition) => {
  const snapshot = workspaceSnapshot(w);
  return storage.transaction(
    "rw",
    storage.workspaces,
    storage.deletedWorkspaces,
    async () => {
      if (await storage.deletedWorkspaces.get(snapshot.id)) return false;
      await storage.workspaces.put(snapshot);
      return true;
    },
  );
};
export async function deleteWorkspace(id: string, activeId: string) {
  return storage.transaction(
    "rw",
    storage.workspaces,
    storage.deletedWorkspaces,
    async () => {
      // A queued autosave (or another window) must not recreate a deleted workspace.
      await storage.deletedWorkspaces.put({ id });
      await storage.workspaces.delete(id);
      let replacement: WorkspaceDefinition | undefined;
      if (id === activeId) {
        replacement = await storage.workspaces.orderBy("updatedAt").last();
        if (!replacement) {
          replacement = createWorkspace();
          replacement.sql = "";
        }
        replacement = { ...replacement, updatedAt: Date.now() };
        await storage.workspaces.put(replacement);
      }
      const workspaces = await storage.workspaces
        .orderBy("updatedAt")
        .reverse()
        .toArray();
      return { replacement, workspaces };
    },
  );
}
