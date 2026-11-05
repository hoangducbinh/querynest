import type { WorkspaceDefinition, WorkspaceSource } from "../../types/schema";
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
  getSession,
  findProfileSession,
  profileSessions,
  sameServer,
  replaceSession,
} from "./sessions";
import { remoteClient } from "./client";

const opening = new Map<string, Promise<void>>();
export async function ensureDatabaseSession(
  w: WorkspaceDefinition,
  sourceId: string,
): Promise<void> {
  const source = workspaceSources(w).find((s) => s.id === sourceId);
  if (!source?.connection) return;
  const config = source.connection;
  const key = sourceSessionKey(w.id, sourceId);
  const root = connectionRoot(w, source);
  const profileId = root.connectionId;
  const shared = findProfileSession(profileId, config);
  if (!getSession(key, config) && shared) retainSession(key, shared);
  if (getSession(key, config)) return;
  const pending = opening.get(key);
  if (pending) return pending;
  const promise = (async () => {
    const existing = getSession(key, config, true);
    const entry = [
      existing,
      ...databaseSources(w, root.id).map((sibling) =>
        sibling.connection
          ? getSession(
              sourceSessionKey(w.id, sibling.id),
              sibling.connection,
              true,
            )
          : undefined,
      ),
      ...profileSessions(profileId),
    ].find((candidate) => candidate && sameServer(candidate.config, config));
    if (!entry) throw new NeedsConnection();
    const result = await remoteClient(config.engine).openDatabase(
      entry.sessionId,
      config.config.database,
    );
    const value = {
      ...result,
      config,
      profileId,
      connected: true,
      disconnect: remoteClient(config.engine).disconnect,
    };
    if (existing?.sessionId === entry.sessionId)
      replaceSession(entry.sessionId, value);
    retainSession(key, value);
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
    remoteClient(session.config.engine).databases(session.sessionId),
  );
}

export async function reconnectDatabase(
  w: WorkspaceDefinition,
  source: WorkspaceSource,
) {
  if (!source.connection) return;
  const key = sourceSessionKey(w.id, source.id);
  const existing =
    getSession(key, source.connection, true) ??
    profileSessions(connectionRoot(w, source).connectionId).find((entry) =>
      sameServer(entry.config, source.connection!),
    );
  if (!existing) throw new NeedsConnection();
  const result = await remoteClient(source.connection.engine).openDatabase(
    existing.sessionId,
    source.connection.config.database,
  );
  const value = {
    ...result,
    config: source.connection,
    profileId: connectionRoot(w, source).connectionId,
    connected: true,
    disconnect: remoteClient(source.connection.engine).disconnect,
  };
  if (existing.config.config.database === source.connection.config.database)
    replaceSession(existing.sessionId, value);
  retainSession(key, value);
  return result;
}
