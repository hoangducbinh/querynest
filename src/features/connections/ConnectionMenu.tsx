import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { WorkspaceDefinition, WorkspaceSource } from "../../types/schema";
import { useStore } from "../schema/store";
import { ConnectionDialog } from "./ConnectionDialog";
import { connectRemote, remoteClient } from "./client";
import { listDatabases, withDatabaseSession } from "./databases";
import { NeedsConnection, retainSession } from "./sessions";
import {
  connectionRoot,
  ensureSources,
  sourceSessionKey,
  updateSource,
  workspaceSources,
} from "./sources";
import { catalogSchema, pgError } from "../postgres/model";

export function ConnectionMenu({
  workspace,
  busy,
  onAdd,
  onManage,
  onRemove,
  onBeforeAction,
  onError,
  onConnected,
}: {
  workspace: WorkspaceDefinition;
  busy: boolean;
  onAdd: () => void;
  onManage: () => void;
  onRemove: (id: string) => void;
  onBeforeAction: () => Promise<boolean>;
  onError: (error: unknown) => void;
  onConnected: () => void;
}) {
  const sources = workspaceSources(workspace);
  const active =
    sources.find((s) => s.id === (workspace.activeSourceId ?? "primary")) ??
    sources[0];
  const root = connectionRoot(workspace, active);
  const [pending, setPending] = useState(false);
  const [login, setLogin] = useState<WorkspaceSource | null>(null);
  async function refresh(source: WorkspaceSource) {
    if (!source.connection || !(await onBeforeAction())) return;
    setPending(true);
    try {
      const databases = await listDatabases(workspace, source);
      const catalog = await withDatabaseSession(workspace, source, (session) =>
        remoteClient(source.connection!.engine).refresh(session.sessionId),
      );
      if (useStore.getState().workspace.id !== workspace.id) return;
      useStore.getState().edit((w) => {
        ensureSources(w);
        updateSource(w, connectionRoot(w, source).id, { databases });
        updateSource(w, source.id, { schema: catalogSchema(catalog) });
      });
    } catch (error) {
      if (error instanceof NeedsConnection) setLogin(source);
      else onError(pgError(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button
            className="titlebar-manage-connections"
            title="Connection actions"
            aria-label="Connection actions"
            disabled={busy || pending}
          >
            <Settings2 size={14} />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="connection-actions-menu"
            align="start"
            sideOffset={6}
          >
            <span className="connection-actions-title">
              {root.connection ? root.name : "Local DuckDB"}
            </span>
            <Popover.Close asChild>
              <Button onClick={onAdd}>
                <Plus size={13} />
                Add connection
              </Button>
            </Popover.Close>
            <Popover.Close asChild>
              <Button onClick={onManage}>
                <Settings2 size={13} />
                Manage connections
              </Button>
            </Popover.Close>
            {active.connection && (
              <Popover.Close asChild>
                <Button onClick={() => void refresh(active)}>
                  <RefreshCw size={13} />
                  Refresh databases & tables
                </Button>
              </Popover.Close>
            )}
            {sources.filter((s) => !s.parentSourceId).length > 1 && (
              <Popover.Close asChild>
                <Button
                  className="connection-remove-action"
                  onClick={() => onRemove(root.id)}
                >
                  <Trash2 size={13} />
                  Remove from workspace
                </Button>
              </Popover.Close>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {login?.connection && (
        <ConnectionDialog
          initial={login.connection}
          onClose={() => setLogin(null)}
          onConnect={async (config, password) => {
            const result = await connectRemote(config, password);
            try {
              if (useStore.getState().workspace.id !== workspace.id)
                throw Error("Workspace changed. Try again.");
              useStore.getState().edit((w) => {
                ensureSources(w);
                updateSource(w, login.id, {
                  connection: config,
                  schema: catalogSchema(result.catalog),
                });
              });
              retainSession(sourceSessionKey(workspace.id, login.id), {
                sessionId: result.sessionId,
                serverVersion: result.serverVersion,
                config,
                disconnect: remoteClient(config.engine).disconnect,
              });
            } catch (error) {
              await remoteClient(config.engine)
                .disconnect(result.sessionId)
                .catch(() => {});
              throw error;
            }
            await refresh(
              workspaceSources(useStore.getState().workspace).find(
                (s) => s.id === login.id,
              )!,
            );
            onConnected();
          }}
        />
      )}
    </>
  );
}
