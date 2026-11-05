import { useEffect, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Pencil,
  Plus,
  Search,
  Trash2,
  Plug,
  Unplug,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { useStore } from "../schema/store";
import { storage } from "../../lib/storage/workspaces";
import type { ConnectionProfile } from "./model";
import { workspaceSources, sourceSessionKey } from "./sources";
import {
  getSession,
  profileSessions,
  requestConnection,
  sameServer,
  useSessionRevision,
} from "./sessions";

export function ConnectionPicker({
  value,
  disabled,
  onSelect,
}: {
  value: string;
  disabled: boolean;
  onSelect: (id: string) => void | Promise<unknown>;
}) {
  const workspace = useStore((state) => state.workspace);
  useSessionRevision();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [error, setError] = useState("");
  const sources = workspaceSources(workspace).filter(
    (source) => source.connection && !source.parentSourceId,
  );
  const active =
    workspaceSources(workspace).find((source) => source.id === value) ??
    sources[0] ??
    workspaceSources(workspace)[0];
  const current = workspaceSources(workspace).find(
    (source) => source.id === workspace.activeSourceId,
  );
  const connected = (source: typeof active) =>
    !!source.connection &&
    (!!getSession(
      sourceSessionKey(workspace.id, source.id),
      source.connection,
    ) ||
      profileSessions(source.connectionId).some(
        (entry) =>
          entry.connected !== false &&
          sameServer(entry.config, source.connection!),
      ));
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setSearch("");
    setError("");
    void storage.connections
      .orderBy("name")
      .toArray()
      .then((items) => {
        if (!stale) setProfiles(items);
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [open]);
  function action(id: string, type: Parameters<typeof requestConnection>[2]) {
    setOpen(false);
    requestConnection(workspace.id, id, type);
  }
  const matches = (text: string) =>
    text.toLowerCase().includes(search.toLowerCase());
  const visible = sources.filter((s) =>
    matches(`${s.name} ${s.connection?.config.host ?? ""}`),
  );
  const unattached = profiles.filter(
    (p) => !sources.some((s) => s.connectionId === p.id),
  );
  const saved = unattached.filter((p) => matches(`${p.name} ${p.config.host}`));
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <Button
          className="connection-picker-trigger"
          aria-label="Connection"
          disabled={disabled}
          title={
            active.connection
              ? `${active.name} · ${active.connection.config.host} · ${connected(active) ? "Connected" : "Disconnected"}`
              : "Select connection"
          }
        >
          <Database size={13} />
          <span>{active.connection ? active.name : "Select connection"}</span>
          <ChevronDown size={11} />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="connection-menu"
          sideOffset={5}
          align="start"
          collisionPadding={8}
          aria-label="Connections"
        >
          {sources.length + unattached.length > 8 && (
            <div className="connection-menu-search">
              <Search size={12} />
              <input
                aria-label="Search connections"
                placeholder="Search…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" && event.key !== "Tab")
                    event.stopPropagation();
                }}
              />
            </div>
          )}
          <div className="connection-menu-list">
            {visible.map((source) => {
              const name = source.name;
              const target =
                current?.parentSourceId === source.id ? current : source;
              const ready = connected(source);
              return (
                <div className="connection-menu-row" key={source.id}>
                  <Menu.Item
                    className="connection-menu-item connection-menu-choice"
                    title={
                      source.connection
                        ? `${source.connection.config.host} · ${ready ? "Connected" : "Disconnected"}`
                        : source.name
                    }
                    onSelect={(event) => {
                      if (source.id === active.id) return;
                      event.preventDefault();
                      void Promise.resolve(onSelect(source.id))
                        .then((ok) => {
                          if (ok !== false) setOpen(false);
                        })
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    <span className="connection-menu-check">
                      {source.id === active.id && <Check size={12} />}
                    </span>
                    <span className="connection-menu-name">{name}</span>
                    {source.connection && ready && (
                      <span
                        className="connection-menu-dot"
                        aria-label="Connected"
                      />
                    )}
                  </Menu.Item>
                  {(source.connection || sources.length > 1) && (
                    <Menu.Sub>
                      <Menu.SubTrigger
                        className="connection-menu-item connection-menu-more"
                        aria-label={`Actions for ${name}`}
                      >
                        <ChevronRight size={11} />
                      </Menu.SubTrigger>
                      <Menu.Portal>
                        <Menu.SubContent
                          className="connection-menu connection-menu-sub"
                          sideOffset={3}
                          collisionPadding={8}
                          aria-label={`Actions for ${name}`}
                        >
                          <Menu.Label className="connection-menu-label">
                            {name}
                          </Menu.Label>
                          {source.connection && (
                            <>
                              <Menu.Item
                                className="connection-menu-item"
                                onSelect={() =>
                                  action(
                                    target.id,
                                    ready ? "disconnect" : "connect",
                                  )
                                }
                              >
                                {ready ? (
                                  <Unplug size={13} />
                                ) : (
                                  <Plug size={13} />
                                )}
                                {ready ? "Disconnect" : "Connect"}
                              </Menu.Item>
                              {ready && (
                                <>
                                  <Menu.Item
                                    className="connection-menu-item"
                                    onSelect={() =>
                                      action(target.id, "refresh")
                                    }
                                  >
                                    <RefreshCw size={13} />
                                    Refresh schema
                                  </Menu.Item>
                                  <Menu.Item
                                    className="connection-menu-item"
                                    onSelect={() =>
                                      action(target.id, "reconnect")
                                    }
                                  >
                                    <RotateCw size={13} />
                                    Reconnect
                                  </Menu.Item>
                                </>
                              )}
                              <Menu.Item
                                className="connection-menu-item"
                                onSelect={() => action(source.id, "edit")}
                              >
                                <Pencil size={13} />
                                Connection settings…
                              </Menu.Item>
                            </>
                          )}
                          {sources.length > 1 && (
                            <>
                              <Menu.Separator className="connection-menu-separator" />
                              <Menu.Item
                                className="connection-menu-item"
                                onSelect={() => action(source.id, "remove")}
                              >
                                <Trash2 size={13} />
                                Remove from session
                              </Menu.Item>
                            </>
                          )}
                        </Menu.SubContent>
                      </Menu.Portal>
                    </Menu.Sub>
                  )}
                </div>
              );
            })}
            {!!saved.length && (
              <>
                <Menu.Separator className="connection-menu-separator" />
                <Menu.Label className="connection-menu-label">
                  Saved connections
                </Menu.Label>
              </>
            )}
            {saved.map((profile) => (
              <div className="connection-menu-row" key={profile.id}>
                <Menu.Item
                  className="connection-menu-item connection-menu-choice"
                  title={profile.config.host}
                  onSelect={() => action(profile.id, "attach")}
                >
                  <span className="connection-menu-check" />
                  <span className="connection-menu-name">{profile.name}</span>
                </Menu.Item>
                <Menu.Sub>
                  <Menu.SubTrigger
                    className="connection-menu-item connection-menu-more"
                    aria-label={`Actions for ${profile.name}`}
                  >
                    <ChevronRight size={11} />
                  </Menu.SubTrigger>
                  <Menu.Portal>
                    <Menu.SubContent
                      className="connection-menu connection-menu-sub"
                      sideOffset={3}
                      collisionPadding={8}
                      aria-label={`Actions for ${profile.name}`}
                    >
                      <Menu.Item
                        className="connection-menu-item"
                        onSelect={() => action(profile.id, "edit")}
                      >
                        <Pencil size={13} />
                        Connection settings…
                      </Menu.Item>
                      <Menu.Separator className="connection-menu-separator" />
                      <Menu.Item
                        className="connection-menu-item"
                        onSelect={() => action(profile.id, "delete-profile")}
                      >
                        <Trash2 size={13} />
                        Delete saved settings…
                      </Menu.Item>
                    </Menu.SubContent>
                  </Menu.Portal>
                </Menu.Sub>
              </div>
            ))}
            {!visible.length && !saved.length && (
              <div className="connection-menu-label">
                No matching connections
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="connection-menu-error">
              {error}
            </p>
          )}
          <Menu.Separator className="connection-menu-separator" />
          <Menu.Item
            className="connection-menu-item"
            onSelect={() => action(active.id, "new")}
          >
            <Plus size={13} />
            New connection…
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
