import { createWorkspace } from "../../features/schema/core";
import {
  parseProfile,
  type ConnectionProfile,
} from "../../features/connections/model";
import Dexie, { type EntityTable } from "dexie";
import type { WorkspaceDefinition } from "../../types/schema";
export const storage = new Dexie("database-design-playground") as Dexie & {
  workspaces: EntityTable<WorkspaceDefinition, "id">;
  connections: EntityTable<ConnectionProfile, "id">;
  deletedWorkspaces: EntityTable<{ id: string }, "id">;
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
export const saveConnection = (profile: ConnectionProfile) =>
  storage.connections.put(parseProfile(profile));
export const saveWorkspace = (w: WorkspaceDefinition) => {
  const snapshot = structuredClone(w);
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
          replacement = createWorkspace(false);
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
