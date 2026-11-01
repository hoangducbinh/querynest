import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Database, Pencil, Search, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { WorkspaceDefinition } from "../../types/schema";
import {
  connectionRoot,
  databaseSources,
  workspaceSources,
} from "../connections/sources";
import { engineName } from "../connections/model";

export function WorkspaceBrowser({
  items,
  currentId,
  busy,
  onOpen,
  onDelete,
  onRename,
  onClose,
}: {
  items: WorkspaceDefinition[];
  currentId: string;
  busy: boolean;
  onOpen: (workspace: WorkspaceDefinition) => void;
  onDelete: (workspace: WorkspaceDefinition) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(currentId);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const visible = items.filter((item) => {
    const text = [
      item.name,
      ...workspaceSources(item).flatMap((source) => [
        source.name,
        source.connection?.engine,
        source.connection?.config.database,
        source.connection?.config.host,
      ]),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return text.includes(search.trim().toLocaleLowerCase());
  });
  const item = visible.find((item) => item.id === selected) ?? visible[0];
  const sources = item ? workspaceSources(item) : [];
  const roots = sources.filter((source) => !source.parentSourceId);
  const active = item
    ? (sources.find(
        (source) => source.id === (item.activeSourceId ?? "primary"),
      ) ?? sources[0])
    : undefined;
  const engines = [
    ...new Set(
      roots.map((source) =>
        source.connection ? engineName(source.connection.engine) : "DuckDB",
      ),
    ),
  ];
  const time = (value: number) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  async function rename() {
    if (!item || !name.trim() || name.trim().length > 120) return;
    setError("");
    try {
      await onRename(item.id, name.trim());
      setRenaming(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  function select(id: string) {
    setSelected(id);
    setRenaming(false);
    setError("");
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="workspace-browser">
          <div className="workspace-browser-heading">
            <div>
              <Dialog.Title>Workspaces</Dialog.Title>
              <Dialog.Description>
                {items.length} saved on this device
              </Dialog.Description>
            </div>
            <Button
              aria-label="Close workspaces"
              title="Close workspaces"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>
          <div className="workspace-browser-body">
            <aside className="workspace-browser-list">
              <label className="workspace-browser-search">
                <Search size={14} />
                <input
                  autoFocus
                  aria-label="Search workspaces"
                  placeholder="Search workspaces…"
                  value={search}
                  disabled={busy}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setRenaming(false);
                    setError("");
                  }}
                />
              </label>
              <div
                className="workspace-browser-items"
                aria-label="Saved workspaces"
              >
                {visible.map((workspace) => {
                  const types = [
                    ...new Set(
                      workspaceSources(workspace).map((source) =>
                        source.connection
                          ? engineName(source.connection.engine)
                          : "DuckDB",
                      ),
                    ),
                  ];
                  return (
                    <button
                      key={workspace.id}
                      className={
                        "workspace-browser-item " +
                        (workspace.id === item?.id ? "active" : "")
                      }
                      aria-pressed={workspace.id === item?.id}
                      disabled={busy}
                      onClick={() => select(workspace.id)}
                      onDoubleClick={() => onOpen(workspace)}
                    >
                      <Database size={16} />
                      <span>
                        <strong title={workspace.name}>{workspace.name}</strong>
                        <small>{types.join(" · ")}</small>
                      </span>
                      {workspace.id === currentId && (
                        <Check size={13} aria-label="Current workspace" />
                      )}
                    </button>
                  );
                })}
                {!visible.length && (
                  <div className="workspace-browser-empty">
                    No matching workspaces
                  </div>
                )}
              </div>
            </aside>
            <section
              className="workspace-browser-details"
              aria-label="Workspace details"
            >
              {item ? (
                <>
                  <div className="workspace-browser-name">
                    {renaming ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void rename();
                        }}
                      >
                        <label htmlFor="workspace-rename">Workspace name</label>
                        <input
                          id="workspace-rename"
                          autoFocus
                          maxLength={120}
                          value={name}
                          disabled={busy}
                          onChange={(event) => setName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              setRenaming(false);
                            }
                          }}
                        />
                        <div className="row">
                          <span>{name.length}/120</span>
                          <Button
                            type="button"
                            disabled={busy}
                            onClick={() => setRenaming(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            className="primary"
                            disabled={busy || !name.trim()}
                          >
                            Save name
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <h3>{item.name}</h3>
                        <Button
                          title="Rename workspace"
                          aria-label="Rename workspace"
                          disabled={busy}
                          onClick={() => {
                            setName(item.name);
                            setRenaming(true);
                            setError("");
                          }}
                        >
                          <Pencil size={14} />
                        </Button>
                      </>
                    )}
                    {item.id === currentId && !renaming && (
                      <span className="workspace-current-badge">Current</span>
                    )}
                  </div>
                  {error && (
                    <div className="workspace-browser-error" role="alert">
                      {error}
                    </div>
                  )}
                  <p className="workspace-browser-types">
                    {engines.join(" · ")}
                  </p>
                  <dl className="workspace-browser-summary">
                    <div>
                      <dt>Connections</dt>
                      <dd>{roots.length}</dd>
                    </div>
                    <div>
                      <dt>Saved tables</dt>
                      <dd>
                        {sources.reduce(
                          (count, source) =>
                            count + source.schema.tables.length,
                          0,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>SQL tabs</dt>
                      <dd>{item.sqlTabs?.length ?? 1}</dd>
                    </div>
                    <div>
                      <dt>Tests</dt>
                      <dd>{item.tests.length}</dd>
                    </div>
                  </dl>
                  <dl className="workspace-browser-meta">
                    <div>
                      <dt>Updated</dt>
                      <dd>{time(item.updatedAt)}</dd>
                    </div>
                    <div>
                      <dt>Last selected</dt>
                      <dd>
                        {active?.connection
                          ? connectionRoot(item, active).name +
                            " / " +
                            active.connection.config.database
                          : "Local DuckDB / main"}
                      </dd>
                    </div>
                    <div>
                      <dt>SQL layout</dt>
                      <dd>
                        {item.sqlLayout?.groups.length === 2
                          ? "Split · 2 panes"
                          : "Single pane"}
                      </dd>
                    </div>
                  </dl>
                  <div className="workspace-browser-connections">
                    {roots.map((root) => {
                      const databases = [
                        ...new Set(
                          [
                            root.connection?.config.database,
                            ...(root.databases ?? []),
                            ...databaseSources(item, root.id).map(
                              (source) => source.connection?.config.database,
                            ),
                          ].filter((name): name is string => !!name),
                        ),
                      ];
                      return (
                        <article key={root.id}>
                          <div className="workspace-browser-connection-title">
                            <Database size={14} />
                            <strong>
                              {root.connection ? root.name : "Local DuckDB"}
                            </strong>
                            <span>
                              {root.connection
                                ? engineName(root.connection.engine)
                                : "DuckDB"}
                            </span>
                          </div>
                          {root.connection ? (
                            <>
                              <p>
                                {root.connection.config.host}:
                                {root.connection.config.port} ·{" "}
                                {root.connection.config.user ||
                                  "Windows authentication"}
                              </p>
                              <p>
                                {root.connection.config.readOnly
                                  ? root.connection.engine === "mssql"
                                    ? "Query-only"
                                    : "Read-only"
                                  : "Read/write"}
                              </p>
                              <div className="workspace-browser-databases">
                                {databases.map((database) => (
                                  <span
                                    key={database}
                                    title={database}
                                    className={
                                      active?.connection?.config.database ===
                                        database &&
                                      connectionRoot(item, active).id ===
                                        root.id
                                        ? "active"
                                        : ""
                                    }
                                  >
                                    {database}
                                  </span>
                                ))}
                              </div>
                            </>
                          ) : (
                            <p>
                              main · {root.schema.tables.length} saved tables
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="workspace-browser-empty">
                  Choose a workspace to see its details.
                </div>
              )}
            </section>
          </div>
          <div className="workspace-browser-footer">
            <Button
              className="danger"
              disabled={busy || !item || renaming}
              onClick={() => item && onDelete(item)}
            >
              <Trash2 size={14} />
              Delete workspace
            </Button>
            <div className="row">
              <Button disabled={busy} onClick={onClose}>
                Done
              </Button>
              <Button
                className="primary"
                disabled={busy || !item || item.id === currentId || renaming}
                onClick={() => item && onOpen(item)}
              >
                {item?.id === currentId
                  ? "Current workspace"
                  : "Open workspace"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
