import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Bookmark, Pencil, Plug, Search, Trash2 } from "lucide-react";
import { storage } from "../../lib/storage/workspaces";
import type { WorkspaceDefinition } from "../../types/schema";
import type { ConnectionProfile } from "./model";
import { requestConnection } from "./sessions";
import { workspaceSources } from "./sources";

export function SavedConnections({
  workspace,
  disabled,
}: {
  workspace: WorkspaceDefinition;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const attached = new Set(
    workspaceSources(workspace).map((source) => source.connectionId),
  );
  const needle = search.trim().toLowerCase();
  const available = profiles?.filter((profile) => !attached.has(profile.id));
  const visible = available?.filter((profile) =>
    `${profile.name} ${profile.config.host} ${profile.config.database}`
      .toLowerCase()
      .includes(needle),
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void storage.connections.orderBy("name").toArray().then(
      (items) => {
        if (!cancelled) setProfiles(items);
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, workspace.id]);

  function act(id: string, action: "attach" | "edit" | "delete-profile") {
    setOpen(false);
    requestConnection(workspace.id, id, action);
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setProfiles(undefined);
          setSearch("");
          setError("");
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className="sidebar-icon-button" title="Saved connections" aria-label="Saved connections" disabled={disabled}>
          <Bookmark className="sidebar-glyph" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="connection-menu saved-connections"
          aria-label="Saved connections"
          sideOffset={5}
          collisionPadding={8}
          align="end"
        >
          <div className="connection-menu-search">
            <Search size={13} aria-hidden="true" />
            <input
              aria-label="Search saved connections"
              placeholder="Search saved connections"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="connection-menu-list">
            {visible?.map((profile) => (
              <div className="connection-menu-row" key={profile.id}>
                <button
                  type="button"
                  className="connection-menu-item connection-menu-choice"
                  onClick={() => act(profile.id, "attach")}
                  title={`Connect to ${profile.name}`}
                >
                  <Plug size={13} aria-hidden="true" />
                  <span className="saved-connection-label">
                    <strong>{profile.name}</strong>
                    <small>{profile.config.host} / {profile.config.database}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar-icon-button"
                  title={`Edit ${profile.name}`}
                  aria-label={`Edit ${profile.name}`}
                  onClick={() => act(profile.id, "edit")}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="sidebar-icon-button"
                  title={`Delete saved settings for ${profile.name}`}
                  aria-label={`Delete saved settings for ${profile.name}`}
                  onClick={() => act(profile.id, "delete-profile")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {error ? (
              <p role="alert" className="connection-menu-error">{error}</p>
            ) : !visible?.length ? (
              <p role="status" className="saved-connections-empty">
                {!profiles
                  ? "Loading saved connections…"
                  : !available?.length
                    ? "No saved connections outside this workspace."
                    : "No matching saved connections."}
              </p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
