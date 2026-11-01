import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Database, Plus, Pencil, Trash2, X, HardDrive } from "lucide-react";
import { Button } from "../../components/ui/button";
import { isTauri } from "../postgres/client";
import { pgError } from "../postgres/model";
import { storage, saveConnection } from "../../lib/storage/workspaces";
import {
  defaultRemoteConfig,
  engineName,
  type ConnectionProfile,
  type RemoteConfig,
} from "./model";
import { ConnectionDialog } from "./ConnectionDialog";
export function WorkspaceManager({
  mode,
  onCreate,
  onClose,
}: {
  mode: "create" | "connections" | "attach";
  onCreate: (
    profile?: ConnectionProfile,
    name?: string,
  ) => Promise<boolean | void>;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [editing, setEditing] = useState<
    (RemoteConfig & { id?: string; name?: string }) | null
  >(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState("");
  const refresh = () =>
    storage.connections.orderBy("name").toArray().then(setProfiles);
  useEffect(() => {
    void refresh().catch((e) => setError(pgError(e)));
  }, []);
  async function create(profile?: ConnectionProfile) {
    setBusy(true);
    setError("");
    try {
      const created = await onCreate(profile, name.trim());
      if (created !== false) onClose();
    } catch (e) {
      setError(pgError(e));
    } finally {
      setBusy(false);
    }
  }
  if (editing)
    return (
      <ConnectionDialog
        initial={editing}
        initialName={editing.name}
        profileMode
        onClose={() => setEditing(null)}
        onConnect={async (value, _password, label) => {
          await saveConnection({
            ...value,
            id: editing.id || crypto.randomUUID(),
            name: label,
            updatedAt: Date.now(),
          });
          await refresh();
        }}
      />
    );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal connection-manager"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="row">
            <Dialog.Title>
              {mode === "create"
                ? "New workspace"
                : mode === "attach"
                  ? "Add connection"
                  : "Connections"}
            </Dialog.Title>
            <Button
              title="Close workspace manager"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>
          <Dialog.Description>
            {mode === "create"
              ? "Work locally or open a saved database connection."
              : "Reusable settings on this device. Passwords stay in memory."}
          </Dialog.Description>
          {mode === "create" && (
            <>
              <label className="workspace-name-label">
                Workspace name
                <input
                  value={name}
                  placeholder="Use connection name"
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                />
              </label>
              <Button
                className="local-workspace-card"
                disabled={busy}
                onClick={() => void create()}
              >
                <HardDrive size={22} />
                <span>
                  <strong>Local playground</strong>
                  <small>DuckDB · design tables and edit sample data</small>
                </span>
                <Plus size={17} />
              </Button>
            </>
          )}
          <div className="connection-list-heading">
            <strong>Saved connections</strong>
            <input
              aria-label="Search connections"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="connection-list">
            {profiles
              .filter((p) =>
                `${p.name} ${p.config.host} ${p.config.database}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((profile) => (
                <div className="connection-card" key={profile.id}>
                  <Database size={20} />
                  <div className="connection-card-info">
                    <strong>{profile.name}</strong>
                    <small>
                      {engineName(profile.engine)} · {profile.config.host}:
                      {profile.config.port} / {profile.config.database}
                    </small>
                    <small>
                      {profile.engine === "mssql" &&
                      profile.config.auth === "windows"
                        ? "Windows account"
                        : profile.config.user}{" "}
                      ·{" "}
                      {profile.config.readOnly
                        ? profile.engine === "mssql"
                          ? "Query-only"
                          : "Read only"
                        : "Read/write"}
                    </small>
                  </div>
                  {deleting === profile.id ? (
                    <>
                      <span className="connection-hint">
                        Remove saved settings?
                      </span>
                      <Button
                        disabled={busy}
                        className="danger"
                        onClick={async () => {
                          try {
                            await storage.connections.delete(profile.id);
                            setDeleting("");
                            await refresh();
                          } catch (e) {
                            setError(pgError(e));
                          }
                        }}
                      >
                        Remove
                      </Button>
                      <Button onClick={() => setDeleting("")}>Keep</Button>
                    </>
                  ) : (
                    <>
                      <Button
                        title={`Edit ${profile.name}`}
                        disabled={busy}
                        onClick={() => setEditing(profile)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        title={`Remove ${profile.name}`}
                        disabled={busy}
                        onClick={() => setDeleting(profile.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                      <Button
                        disabled={busy || !isTauri()}
                        onClick={() => void create(profile)}
                      >
                        {mode === "attach"
                          ? "Add to workspace"
                          : "Open workspace"}
                      </Button>
                    </>
                  )}
                </div>
              ))}
            {!profiles.length && (
              <p className="connection-hint">
                No saved connections yet. Add PostgreSQL or SQL Server below.
              </p>
            )}
          </div>
          {!isTauri() && (
            <p className="connection-hint">
              Open the desktop app to connect to a database.
            </p>
          )}
          {error && (
            <p role="alert" className="pg-error">
              {error}
            </p>
          )}
          <div className="connection-manager-footer">
            <Button
              disabled={busy}
              onClick={() => setEditing(defaultRemoteConfig("postgres"))}
            >
              <Plus size={14} />
              PostgreSQL
            </Button>
            <Button
              disabled={busy}
              onClick={() => setEditing(defaultRemoteConfig("mssql"))}
            >
              <Plus size={14} />
              SQL Server
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
