import { useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Columns3, Plus, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import {
  dataTypes,
  type ColumnDefinition,
  type TableDefinition,
  type WorkspaceDefinition,
} from "../../types/schema";
import { newColumn, planTableEdit } from "./table-edit";
interface Props {
  workspace: WorkspaceDefinition;
  table: TableDefinition;
  columnId?: string;
  anchor: HTMLButtonElement;
  dark: boolean;
  onClose: () => void;
  onCommit: (plan: ReturnType<typeof planTableEdit>) => Promise<void>;
}
export function ColumnEditor({
  workspace,
  table,
  columnId,
  anchor,
  dark,
  onClose,
  onCommit,
}: Props) {
  const initial = table.columns.find((column) => column.id === columnId);
  const [column, setColumn] = useState<ColumnDefinition>(() =>
    initial ? { ...initial } : newColumn(),
  );
  const [primary, setPrimary] = useState(
    !!initial && table.primaryKey.includes(initial.id),
  );
  const [advanced, setAdvanced] = useState(!!initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const saved = useRef(false);
  const inFlight = useRef(false);
  const virtualAnchor = useMemo(
    () => ({
      current: { getBoundingClientRect: () => anchor.getBoundingClientRect() },
    }),
    [anchor],
  );
  const changed =
    JSON.stringify(column) !==
      JSON.stringify(initial ?? newColumnBaseline(column.id)) ||
    primary !== (!!initial && table.primaryKey.includes(initial.id));
  const plan = useMemo(() => {
    const draft = structuredClone(table);
    draft.columns = initial
      ? draft.columns.map((c) => (c.id === initial.id ? column : c))
      : [...draft.columns, column];
    draft.primaryKey = primary
      ? draft.primaryKey.includes(column.id)
        ? draft.primaryKey
        : [...draft.primaryKey, column.id]
      : draft.primaryKey.filter((id) => id !== column.id);
    return planTableEdit(workspace, draft, false);
  }, [workspace, table, initial, column, primary]);
  const patch = (values: Partial<ColumnDefinition>) => {
    setColumn((current) => ({ ...current, ...values }));
    setError("");
  };
  async function close() {
    if (inFlight.current) return;
    if (changed && !(await confirmAction("Discard unsaved column changes?")))
      return;
    onClose();
  }
  async function commit() {
    if (inFlight.current) return;
    if (plan.errors.length) {
      setError(plan.errors.join(" "));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      await onCommit(plan);
      saved.current = true;
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  async function remove() {
    if (
      !initial ||
      inFlight.current ||
      !(await confirmAction(
        `Delete ${initial.name} and its saved values? Relationships using this column will also be removed.`,
      ))
    )
      return;
    const draft = structuredClone(table);
    draft.columns = draft.columns.filter((c) => c.id !== initial.id);
    draft.primaryKey = draft.primaryKey.filter((id) => id !== initial.id);
    const next = planTableEdit(workspace, draft, false);
    if (next.errors.length) {
      setError(next.errors.join(" "));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      await onCommit(next);
      saved.current = true;
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  const issue = error || (column.name.trim() ? plan.errors.join(" ") : "");
  return (
    <Popover.Root
      open
      modal
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <Popover.Anchor virtualRef={virtualAnchor} />
      <Popover.Portal>
        <Popover.Content
          className={"column-popover " + (dark ? "dark" : "")}
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          avoidCollisions
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameInput.current?.focus();
            nameInput.current?.select();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              const currentColumn = saved.current
                ? document.querySelector<HTMLButtonElement>(
                    `[data-column-id="${column.id}"]`,
                  )
                : null;
              (
                currentColumn ??
                (anchor.isConnected
                  ? anchor
                  : document.querySelector<HTMLButtonElement>(
                      "[data-add-column]",
                    ))
              )?.focus();
            });
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            void close();
          }}
          onInteractOutside={(event) => {
            if (inFlight.current) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              event.stopPropagation();
              void commit();
            }
          }}
        >
          <div className="column-popover-heading">
            <span className="column-popover-icon">
              <Columns3 size={16} />
            </span>
            <Popover.Title>
              {initial ? "Edit column" : "Add column"}
            </Popover.Title>
            <span className="column-popover-table">{table.name}</span>
            <Button
              title="Close column editor"
              disabled={saving}
              onClick={() => void close()}
            >
              <X size={14} />
            </Button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void commit();
            }}
          >
            <div className="column-popover-fields">
              <label htmlFor="column-name">Column name</label>
              <input
                id="column-name"
                ref={nameInput}
                required
                placeholder="e.g. created_at"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
                value={column.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
              <label htmlFor="column-type">Data type</label>
              <input
                id="column-type"
                list="duckdb-column-types"
                disabled={saving}
                value={column.type}
                spellCheck={false}
                autoComplete="off"
                placeholder="e.g. DECIMAL(18,2), INTEGER[]"
                onChange={(event) => patch({ type: event.target.value })}
              />
              <datalist id="duckdb-column-types">
                {dataTypes.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
              <button
                type="button"
                className="column-options-toggle"
                aria-expanded={advanced}
                aria-controls="column-advanced-options"
                disabled={saving}
                onClick={() => setAdvanced(!advanced)}
              >
                <ChevronDown size={13} />
                {advanced ? "Fewer options" : "More options"}
              </button>
              {advanced && (
                <div
                  className="column-advanced-options"
                  id="column-advanced-options"
                >
                  <label htmlFor="column-default">
                    Default value <span>SQL expression</span>
                  </label>
                  <input
                    id="column-default"
                    placeholder="No default"
                    disabled={saving}
                    value={column.defaultValue}
                    onChange={(event) =>
                      patch({ defaultValue: event.target.value })
                    }
                  />
                  <div className="column-option-checks">
                    <label>
                      <input
                        type="checkbox"
                        disabled={saving || primary}
                        checked={!column.nullable || primary}
                        onChange={(event) =>
                          patch({ nullable: !event.target.checked })
                        }
                      />
                      Required
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        disabled={saving}
                        checked={column.unique}
                        onChange={(event) =>
                          patch({ unique: event.target.checked })
                        }
                      />
                      Unique
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        disabled={saving}
                        checked={primary}
                        onChange={(event) => {
                          setPrimary(event.target.checked);
                          setError("");
                          if (event.target.checked) patch({ nullable: false });
                        }}
                      />
                      Primary key
                    </label>
                  </div>
                </div>
              )}
              {issue && (
                <div className="column-popover-error" role="alert">
                  {issue}
                </div>
              )}
            </div>
            <div className="column-popover-actions">
              {initial && (
                <Button
                  title="Delete column"
                  className="column-delete"
                  disabled={saving}
                  onClick={() => void remove()}
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
                disabled={saving || plan.errors.length > 0}
              >
                {saving ? (
                  <span className="spinner" />
                ) : (
                  !initial && <Plus size={13} />
                )}
                {saving
                  ? initial
                    ? "Saving…"
                    : "Adding…"
                  : initial
                    ? "Save column"
                    : "Add column"}
                {!saving && <kbd>↵</kbd>}
              </Button>
            </div>
          </form>
          <Popover.Arrow
            className="column-popover-arrow"
            width={12}
            height={6}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
function newColumnBaseline(id: string): ColumnDefinition {
  return {
    id,
    name: "",
    type: "VARCHAR",
    nullable: true,
    unique: false,
    defaultValue: "",
  };
}
