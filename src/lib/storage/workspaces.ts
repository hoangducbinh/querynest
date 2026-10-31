import Dexie, { type EntityTable } from "dexie";
import type { WorkspaceDefinition } from "../../types/schema";
export const storage = new Dexie("database-design-playground") as Dexie & {
  workspaces: EntityTable<WorkspaceDefinition, "id">;
};
storage.version(1).stores({ workspaces: "id,name,updatedAt" });
export const saveWorkspace = (w: WorkspaceDefinition) =>
  storage.workspaces.put(structuredClone(w));
