import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, Columns3, Plus, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import {
  columnDraft,
  columnRestrictions,
  columnTypes,
  type ColumnContext,
  type ColumnChange,
  type RemoteColumnDraft,
} from "./columns";
export function RemoteColumnEditor({
  context,
  columnId,
  engine,
  anchor,
  dark,
  onClose,
  onCommit,
  onDirty,
}: {
  context: ColumnContext;
  columnId?: string;
  engine: "postgres" | "mssql";
  anchor: HTMLButtonElement;
  dark: boolean;
  onClose: () => void;
  onCommit: (change: ColumnChange) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const initial = context.columns.find((c) => c.id === columnId);
  const [draft, setDraft] = useState(() => columnDraft(initial, engine));
  const [advanced, setAdvanced] = useState(!!initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const changed =
    JSON.stringify(draft) !== JSON.stringify(columnDraft(initial, engine));
  const restrictions = columnRestrictions(context, initial, engine);
  useEffect(() => {
    onDirty(changed);
    return () => onDirty(false);
  }, [changed, onDirty]);
  function patch(value: Partial<RemoteColumnDraft>) {
    setDraft((d) => ({ ...d, ...value }));
    setError("");
  }
  async function close() {
    if (inFlight.current) return;
    if (changed && !(await confirmAction("Discard unsaved column settings?")))
      return;
    onClose();
  }
  async function apply(drop = false) {
    if (inFlight.current || requiresRefresh) return;
    if (
      drop &&
      (!initial ||
        restrictions.dropLocked ||
        !(await confirmAction(
          `Delete column “${initial.name}” from ${context.schema}.${context.table} and all values stored in it? This cannot be undone in the app.`,
        )))
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      await onCommit({
        action: drop ? "drop" : initial ? "alter" : "add",
        columnId: initial?.id,
        column: drop ? undefined : draft,
        expected: context,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (
        e &&
        typeof e === "object" &&
        "requiresRefresh" in e &&
        e.requiresRefresh
      )
        setRequiresRefresh(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog.Root
      open
      modal
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`column-popover ${dark ? "dark" : ""}`}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
            nameRef.current?.select();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => {
              (anchor.isConnected
                ? anchor
                : document.querySelector<HTMLButtonElement>("[data-add-column]")
              )?.focus();
            });
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            void close();
          }}
          onInteractOutside={(e) => {
            if (inFlight.current) e.preventDefault();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              e.stopPropagation();
              if (changed) void apply();
            }
          }}
        >
          <div className="column-popover-heading">
            <span className="column-popover-icon">
              <Columns3 size={16} />
            </span>
            <Dialog.Title>
              {initial ? "Edit column" : "Add column"}
            </Dialog.Title>
            <span className="column-popover-table">
              {context.schema}.{context.table}
            </span>
            <Button
              title="Close column editor"
              disabled={saving}
              onClick={() => void close()}
            >
              <X size={14} />
            </Button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apply();
            }}
          >
            <div className="column-popover-fields">
              <label htmlFor="remote-column-name">Column name</label>
              <input
                id="remote-column-name"
                ref={nameRef}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. created_at"
                disabled={saving}
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
              <label htmlFor="remote-column-type">Data type</label>
              <input
                id="remote-column-type"
                list="remote-column-types"
                autoComplete="off"
                spellCheck={false}
                disabled={saving || restrictions.typeLocked}
                value={draft.dataType}
                onChange={(e) => patch({ dataType: e.target.value })}
              />
              <datalist id="remote-column-types">
                {columnTypes(engine).map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
              <button
                type="button"
                className="column-options-toggle"
                disabled={saving}
                aria-expanded={advanced}
                onClick={() => setAdvanced(!advanced)}
              >
                <ChevronDown size={13} />
                {advanced ? "Fewer options" : "More options"}
              </button>
              {advanced && (
                <div className="column-advanced-options">
                  <label htmlFor="remote-column-default">
                    Default value <span>SQL expression</span>
                  </label>
                  <input
                    id="remote-column-default"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      engine === "mssql"
                        ? "e.g. 0, N'text', GETDATE()"
                        : "e.g. 0, 'text', now()"
                    }
                    disabled={saving || restrictions.generated}
                    value={draft.defaultValue}
                    onChange={(e) => patch({ defaultValue: e.target.value })}
                  />
                  <div className="column-option-checks">
                    <label>
                      <input
                        type="checkbox"
                        checked={!draft.nullable}
                        disabled={
                          saving || restrictions.generated || draft.primaryKey
                        }
                        onChange={(e) => patch({ nullable: !e.target.checked })}
                      />
                      Required
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.unique}
                        disabled={saving || restrictions.uniqueLocked}
                        onChange={(e) => patch({ unique: e.target.checked })}
                      />
                      Unique
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.primaryKey}
                        disabled={saving || restrictions.primaryLocked}
                        onChange={(e) =>
                          patch({
                            primaryKey: e.target.checked,
                            ...(e.target.checked ? { nullable: false } : {}),
                          })
                        }
                      />
                      Primary key
                    </label>
                  </div>
                </div>
              )}
              {restrictions.generated && (
                <p className="remote-column-note">
                  Identity/generated settings are read-only here. Use SQL to
                  change generation settings.
                </p>
              )}
              {!restrictions.generated &&
                engine === "mssql" &&
                !!initial?.dependencies.length && (
                  <p className="remote-column-note">
                    Type changes require managing the column’s
                    indexes/constraints in SQL.
                  </p>
                )}
              {initial && restrictions.dropLocked && (
                <p className="remote-column-note">
                  {context.columns.length <= 1
                    ? "Keep at least one column."
                    : "Remove dependent constraints/indexes in SQL before deleting this column."}
                </p>
              )}
              {engine === "mssql" && initial && draft.name !== initial.name && (
                <p className="remote-column-note">
                  Renaming does not rewrite SQL in views or stored procedures.
                </p>
              )}
              {error && (
                <div className="column-popover-error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="column-popover-actions">
              {initial && (
                <Button
                  title="Delete column"
                  className="column-delete"
                  disabled={
                    saving || restrictions.dropLocked || requiresRefresh
                  }
                  onClick={() => void apply(true)}
                >
                  <Trash2 size={14} />
                </Button>
              )}
              <Button disabled={saving} onClick={() => void close()}>
                Cancel
              </Button>
              <Button
                className="primary"
                type="submit"
                disabled={
                  saving ||
                  !changed ||
                  !draft.name.trim() ||
                  !draft.dataType.trim() ||
                  requiresRefresh
                }
              >
                {saving ? (
                  <span className="spinner" />
                ) : (
                  !initial && <Plus size={13} />
                )}
                {saving ? "Applying…" : initial ? "Save column" : "Add column"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
