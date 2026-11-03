import { DatabasePicker } from "./DatabasePicker";
import { ConnectionPicker } from "./ConnectionPicker";
import type { WorkspaceDefinition } from "../../types/schema";
import { useStore } from "../schema/store";
import {
  connectionRoot,
  databaseSources,
  ensureSources,
  updateSource,
  workspaceSources,
} from "./sources";
import { listDatabases } from "./databases";
import { NeedsConnection } from "./sessions";
import { isTauri } from "../postgres/client";

export function WorkspaceConnectionControls({
  workspace,
  busy,
  onSelect,
  onDatabaseChange,
  onError,
}: {
  workspace: WorkspaceDefinition;
  busy: boolean;
  onSelect: (sourceId: string) => Promise<boolean>;
  onDatabaseChange: (rootId: string, database: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const sources = workspaceSources(workspace);
  const active =
    sources.find(
      (source) => source.id === (workspace.activeSourceId ?? "primary"),
    ) ?? sources[0];
  const root = connectionRoot(workspace, active);
  const databases = active.connection
    ? [
        ...new Set([
          active.connection.config.database,
          ...(root.databases ?? []),
          ...databaseSources(workspace, root.id).flatMap((source) =>
            source.connection ? [source.connection.config.database] : [],
          ),
        ]),
      ].sort((a, b) => a.localeCompare(b))
    : ["main"];
  async function discover() {
    if (!active.connection || root.databases || !isTauri()) return;
    try {
      const names = await listDatabases(workspace, active);
      if (useStore.getState().workspace.id === workspace.id)
        useStore.getState().edit((w) => {
          ensureSources(w);
          updateSource(w, root.id, { databases: names });
        });
    } catch (error) {
      if (!(error instanceof NeedsConnection)) onError(error);
    }
  }
  return (
    <div
      className="titlebar-connection-controls"
      role="group"
      aria-label="Database"
    >
      <ConnectionPicker
        value={root.id}
        disabled={busy}
        onSelect={(id) => onSelect(id).catch(onError)}
      />
      <DatabasePicker
        value={active.connection?.config.database ?? "main"}
        databases={databases}
        disabled={busy || !active.connection}
        onDiscover={discover}
        onSelect={(database) =>
          onDatabaseChange(root.id, database).catch(onError)
        }
      />
    </div>
  );
}
