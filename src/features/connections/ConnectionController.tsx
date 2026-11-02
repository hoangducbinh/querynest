import { DatabasePlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { useEffect, useState } from "react";
import type { WorkspaceDefinition, WorkspaceSource } from "../../types/schema";
import { useStore } from "../schema/store";
import { ConnectionDialog } from "./ConnectionDialog";
import { connectRemote, remoteClient } from "./client";
import {
  listDatabases,
  withDatabaseSession,
  ensureDatabaseSession,
  reconnectDatabase,
} from "./databases";
import {
  NeedsConnection,
  retainSession,
  getSession,
  useSessionRevision,
  useConnectionRequest,
  disconnectProfile,
  consumeConnectionRequest,
  requestConnection,
} from "./sessions";
import {
  connectionRoot,
  databaseSources,
  ensureSources,
  sourceSessionKey,
  updateSource,
  workspaceSources,
} from "./sources";
import { storage, saveConnection } from "../../lib/storage/workspaces";
import { catalogSchema, pgError } from "../postgres/model";
import {
  defaultRemoteConfig,
  type ConnectionProfile,
  type RemoteConfig,
} from "./model";
import { isTauri } from "../postgres/client";

// Single entry point for authentication and connection lifecycle. Tool views
// request this center instead of mounting their own connection dialogs.
export function ConnectionController({
  workspace,
  busy,
  onRemove,
  onBeforeAction,
  onError,
  onConnected,
  onAttach,
}: {
  workspace: WorkspaceDefinition;
  busy: boolean;
  onRemove: (id: string) => void;
  onBeforeAction: () => Promise<boolean>;
  onError: (error: unknown) => void;
  onConnected: () => void;
  onAttach: (profile: ConnectionProfile) => Promise<unknown>;
}) {
  useSessionRevision();
  const request = useConnectionRequest();
  const [pending, setPending] = useState("");
  const [editing, setEditing] = useState<
    (RemoteConfig & { id?: string; name?: string }) | null
  >(null);
  const [login, setLogin] = useState<WorkspaceSource | null>(null);
  const blocked = busy || !!pending;
  async function perform(
    source: WorkspaceSource,
    action: "connect" | "refresh" | "reconnect" | "disconnect",
  ) {
    if (!source.connection || blocked || !(await onBeforeAction())) return;
    if (!isTauri()) {
      onError("Open the desktop app to connect to a database.");
      return;
    }
    setPending(source.id);
    try {
      if (action === "disconnect") {
        const root = connectionRoot(workspace, source);
        disconnectProfile(
          root.connectionId,
          databaseSources(workspace, root.id).map((s) =>
            sourceSessionKey(workspace.id, s.id),
          ),
        );
        onConnected();
        return;
      }
      let catalog;
      if (action === "reconnect")
        catalog = (await reconnectDatabase(workspace, source))?.catalog;
      else {
        await ensureDatabaseSession(workspace, source.id);
        if (!source.schema.tables.length)
          catalog = getSession(
            sourceSessionKey(workspace.id, source.id),
            source.connection,
          )?.catalog;
        if (action === "refresh") {
          const databases = await listDatabases(workspace, source);
          catalog = await withDatabaseSession(workspace, source, (session) =>
            remoteClient(source.connection!.engine).refresh(session.sessionId),
          );
          if (useStore.getState().workspace.id === workspace.id)
            useStore.getState().edit((draft) => {
              ensureSources(draft);
              updateSource(draft, connectionRoot(draft, source).id, {
                databases,
              });
            });
        }
      }
      if (catalog && useStore.getState().workspace.id === workspace.id)
        useStore.getState().edit((draft) => {
          ensureSources(draft);
          updateSource(draft, source.id, { schema: catalogSchema(catalog) });
        });
      onConnected();
    } catch (e) {
      if (e instanceof NeedsConnection) {
        setLogin(source);
      } else {
        onError(pgError(e));
      }
    } finally {
      setPending("");
    }
  }
  useEffect(() => {
    if (!request || busy || pending) return;
    consumeConnectionRequest(request.id);
    if (request.workspaceId !== workspace.id) return;
    const source = workspaceSources(workspace).find(
      (s) => s.id === request.sourceId,
    );
    void (async () => {
      if (request.action === "new") {
        if (await onBeforeAction()) setEditing(defaultRemoteConfig("mssql"));
      } else if (request.action === "edit") {
        if (!(await onBeforeAction())) return;
        const profile =
          (await storage.connections.get(
            source?.connectionId ?? request.sourceId,
          )) ??
          (source?.connection
            ? {
                ...source.connection,
                id: source.connectionId ?? crypto.randomUUID(),
                name: source.name,
              }
            : null);
        if (profile) setEditing(profile);
      } else if (request.action === "attach") {
        const profile = await storage.connections.get(request.sourceId);
        if (!profile || (await onAttach(profile)) === false) return;
        const current = useStore.getState().workspace;
        const attached = workspaceSources(current).find(
          (s) => s.connectionId === profile.id,
        );
        if (attached) requestConnection(current.id, attached.id);
      } else if (request.action === "remove") {
        if (source) onRemove(source.id);
      } else if (request.action === "delete-profile") {
        if (
          await confirmAction(
            "Only the saved settings will be deleted. Server data and active sessions stay available.",
            {
              title: "Delete connection settings?",
              confirmLabel: "Delete",
              destructive: true,
            },
          )
        )
          await storage.connections.delete(request.sourceId);
      } else if (source?.connection) {
        await perform(source, request.action);
      }
    })().catch((error) => onError(pgError(error)));
  }, [request?.id, busy, pending]);
  return (
    <>
      <Button
        title="New connection"
        disabled={busy || !!pending}
        onClick={() =>
          requestConnection(
            workspace.id,
            workspace.activeSourceId ?? "primary",
            "new",
          )
        }
      >
        <DatabasePlus size={14} />
      </Button>
      {editing && (
        <ConnectionDialog
          initial={editing}
          initialName={editing.name}
          profileMode={!!editing.id}
          allowEngineChange={!editing.id}
          onClose={() => {
            setEditing(null);
          }}
          onConnect={async (config, password, name) => {
            const profile = {
              ...config,
              id: editing.id ?? crypto.randomUUID(),
              name,
              updatedAt: Date.now(),
            } as ConnectionProfile;
            if (editing.id) {
              await saveConnection(profile);
              useStore.getState().edit((draft) => {
                ensureSources(draft);
                for (const source of workspaceSources(draft)) {
                  if (source.connectionId !== profile.id) continue;
                  const connection = {
                    ...config,
                    config: {
                      ...config.config,
                      database: source.parentSourceId
                        ? (source.connection?.config.database ??
                          config.config.database)
                        : config.config.database,
                    },
                  } as RemoteConfig;
                  const changed =
                    JSON.stringify(source.connection) !==
                    JSON.stringify(connection);
                  updateSource(draft, source.id, {
                    name: source.parentSourceId ? source.name : profile.name,
                    connection,
                    ...(changed
                      ? { schema: { tables: [], relationships: [] } }
                      : {}),
                  });
                }
              });
            } else {
              const result = await connectRemote(config, password);
              try {
                if (useStore.getState().workspace.id !== workspace.id)
                  throw Error("Session changed. Try again.");
                await saveConnection(profile);
                if ((await onAttach(profile)) === false)
                  throw Error("Connection was not added.");
                const current = useStore.getState().workspace;
                const source = workspaceSources(current).find(
                  (s) => s.connectionId === profile.id,
                );
                if (!source) throw Error("Connection was not added.");
                retainSession(sourceSessionKey(current.id, source.id), {
                  ...result,
                  config,
                  profileId: profile.id,
                  disconnect: remoteClient(config.engine).disconnect,
                });
                useStore.getState().edit((draft) =>
                  updateSource(draft, source.id, {
                    schema: catalogSchema(result.catalog),
                  }),
                );
                onConnected();
              } catch (error) {
                await remoteClient(config.engine)
                  .disconnect(result.sessionId)
                  .catch(() => {});
                throw error;
              }
            }
          }}
        />
      )}
      {login?.connection && (
        <ConnectionDialog
          initial={login.connection}
          initialName={login.name}
          onClose={() => {
            setLogin(null);
          }}
          onConnect={async (config, password) => {
            const result = await connectRemote(config, password);
            try {
              if (useStore.getState().workspace.id !== workspace.id)
                throw Error("Session changed. Try again.");
              const root = connectionRoot(workspace, login);
              if (root.connectionId) {
                const profile = await storage.connections.get(
                  root.connectionId,
                );
                if (profile)
                  await saveConnection({
                    ...profile,
                    ...config,
                    config: {
                      ...config.config,
                      database: profile.config.database,
                    },
                    updatedAt: Date.now(),
                  } as typeof profile);
              }
              useStore.getState().edit((draft) => {
                ensureSources(draft);
                updateSource(draft, login.id, {
                  connection: config,
                  schema: catalogSchema(result.catalog),
                });
              });
              retainSession(sourceSessionKey(workspace.id, login.id), {
                sessionId: result.sessionId,
                serverVersion: result.serverVersion,
                catalog: result.catalog,
                config,
                profileId: root.connectionId,
                disconnect: remoteClient(config.engine).disconnect,
              });
              onConnected();
            } catch (e) {
              await remoteClient(config.engine)
                .disconnect(result.sessionId)
                .catch(() => {});
              throw e;
            }
          }}
        />
      )}
    </>
  );
}
