import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceDefinition, WorkspaceSource } from "../../types/schema";
import type { PgCatalog } from "../postgres/model";
import {
  connectionRoot,
  databaseSources,
  sourceSessionKey,
  workspaceSources,
} from "./sources";
import {
  NeedsConnection,
  retainSession,
  withConnectionSession,
} from "./sessions";
import { remoteClient } from "./client";

export interface DatabaseConnectionResult {
  sessionId: string;
  serverVersion: string;
  catalog: PgCatalog;
}
const opening = new Map<string, Promise<void>>();
export async function ensureDatabaseSession(
  w: WorkspaceDefinition,
  sourceId: string,
): Promise<void> {
  const source = workspaceSources(w).find((s) => s.id === sourceId);
  if (!source?.connection) return;
  const config = source.connection;
  const key = sourceSessionKey(w.id, sourceId);
  try {
    await withConnectionSession(key, config, async () => {});
    return;
  } catch (error) {
    if (!(error instanceof NeedsConnection)) throw error;
  }
  const pending = opening.get(key);
  if (pending) return pending;
  const promise = (async () => {
    const root = connectionRoot(w, source);
    for (const sibling of databaseSources(w, root.id)) {
      if (sibling.id === source.id || !sibling.connection) continue;
      try {
        const result = await withConnectionSession(
          sourceSessionKey(w.id, sibling.id),
          sibling.connection,
          (session) =>
            invoke<DatabaseConnectionResult>(
              config.engine === "postgres"
                ? "pg_open_database"
                : "ms_open_database",
              {
                sessionId: session.sessionId,
                database: config.config.database,
              },
            ),
        );
        retainSession(key, {
          ...result,
          config,
          disconnect: remoteClient(config.engine).disconnect,
        });
        return;
      } catch (error) {
        if (!(error instanceof NeedsConnection)) throw error;
      }
    }
    throw new NeedsConnection();
  })();
  opening.set(key, promise);
  try {
    await promise;
  } finally {
    if (opening.get(key) === promise) opening.delete(key);
  }
}
export async function withDatabaseSession<T>(
  w: WorkspaceDefinition,
  source: WorkspaceSource,
  fn: Parameters<typeof withConnectionSession<T>>[2],
) {
  if (!source.connection) throw Error("Remote connection required.");
  await ensureDatabaseSession(w, source.id);
  return withConnectionSession(
    sourceSessionKey(w.id, source.id),
    source.connection,
    fn,
  );
}
export async function listDatabases(
  w: WorkspaceDefinition,
  source: WorkspaceSource,
) {
  return withDatabaseSession(w, source, (session) =>
    invoke<string[]>(
      source.connection?.engine === "postgres"
        ? "pg_databases"
        : "ms_databases",
      { sessionId: session.sessionId },
    ),
  );
}
