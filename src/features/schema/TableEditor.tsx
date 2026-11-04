import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, KeyRound, Plus, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { dataTypes, type TableDefinition } from "../../types/schema";
import { useStore } from "./store";
import { newColumn, planTableEdit } from "./table-edit";
interface Props {
  initial: TableDefinition;
  isNew: boolean;
  onClose: () => void;
  onSaved: (tableId: string) => void;
  onDeleted: () => void;
}
export function TableEditor({
  initial,
  isNew,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const { workspace, edit } = useStore();
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [error, setError] = useState("");
  const plan = useMemo(
    () => planTableEdit(workspace, draft, isNew),
    [workspace, draft, isNew],
  );
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const patch = (
    columnId: string,
    values: Partial<TableDefinition["columns"][number]>,
  ) =>
    setDraft((table) => ({
      ...table,
      columns: table.columns.map((c) =>
        c.id === columnId ? { ...c, ...values } : c,
      ),
    }));
  async function close() {
    if (changed && !(await confirmAction("Discard unsaved table changes?")))
      return;
    onClose();
  }
  function addColumn() {
    const column = newColumn();
    setDraft((table) => ({ ...table, columns: [...table.columns, column] }));
    requestAnimationFrame(() =>
      document.getElementById(`column-${column.id}`)?.focus(),
    );
  }
  function move(index: number, offset: number) {
    setDraft((table) => {
      const columns = [...table.columns];
      [columns[index], columns[index + offset]] = [
        columns[index + offset],
        columns[index],
      ];
      return { ...table, columns };
    });
  }
  async function save() {
    if (plan.errors.length) {
      setError(plan.errors.join(" "));
      return;
    }
    if (
      (plan.removed.length || plan.removedRelationships.length) &&
      !(await confirmAction(
        `Remove ${plan.removed.map((c) => c.name).join(", ")}${plan.removedRelationships.length ? ` and ${plan.removedRelationships.length} related relationship(s)` : ""}? Saved values for these columns will be removed.`,
      ))
    )
      return;
    edit((w) => {
      w.schema = plan.schema;
      w.data = plan.data;
    });
    onSaved(draft.id);
  }
  async function deleteTable() {
    if (
      !(await confirmAction(
        `Delete table ${initial.name}, its saved rows and relationships?`,
      ))
    )
      return;
    edit((w) => {
      w.schema.tables = w.schema.tables.filter((t) => t.id !== initial.id);
      w.schema.relationships = w.schema.relationships.filter(
        (r) => r.sourceTable !== initial.id && r.targetTable !== initial.id,
      );
      delete w.data[initial.id];
    });
    onDeleted();
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="table-editor-dialog"
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              event.stopPropagation();
              void save();
            }
          }}
        >
          <div className="table-editor-title">
            <Dialog.Title>{isNew ? "Create table" : "Edit table"}</Dialog.Title>
            <Button title="Close table editor" onClick={() => void close()}>
              <X size={16} />
            </Button>
          </div>
          <div className="table-name-field">
            <label htmlFor="table-name">Table name</label>
            <input
              id="table-name"
              autoFocus
              placeholder="e.g. customers"
              value={draft.name}
              onChange={(e) => {
                setDraft({ ...draft, name: e.target.value });
                setError("");
              }}
            />
          </div>
          <div className="column-editor-scroll">
            <table className="column-editor">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Column</th>
                  <th>Type</th>
                  <th title="Primary key">PK</th>
                  <th>Not null</th>
                  <th>Unique</th>
                  <th>Default</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.columns.map((column, index) => (
                  <tr key={column.id}>
                    <td className="column-order">
                      <span>{index + 1}</span>
                      <div>
                        <Button
                          title={`Move ${column.name || "column"} up`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp size={11} />
                        </Button>
                        <Button
                          title={`Move ${column.name || "column"} down`}
                          disabled={index === draft.columns.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown size={11} />
                        </Button>
                      </div>
                    </td>
                    <td>
                      <input
                        id={`column-${column.id}`}
                        aria-label={`Column name ${index + 1}`}
                        value={column.name}
                        placeholder="column_name"
                        onChange={(e) =>
                          patch(column.id, { name: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            index === draft.columns.length - 1
                          ) {
                            e.preventDefault();
                            addColumn();
                          }
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Column type ${index + 1}`}
                        list="sql-table-types"
                        value={column.type}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) =>
                          patch(column.id, { type: e.target.value })
                        }
                      />
                      {index === 0 && (
                        <datalist id="sql-table-types">
                          {dataTypes.map((type) => (
                            <option key={type} value={type} />
                          ))}
                        </datalist>
                      )}
                    </td>
                    <td>
                      <label className="pk-control">
                        <input
                          aria-label={`Primary key ${index + 1}`}
                          type="checkbox"
                          checked={draft.primaryKey.includes(column.id)}
                          onChange={(e) =>
                            setDraft((table) => ({
                              ...table,
                              primaryKey: e.target.checked
                                ? [...table.primaryKey, column.id]
                                : table.primaryKey.filter(
                                    (id) => id !== column.id,
                                  ),
                              columns: table.columns.map((c) =>
                                c.id === column.id && e.target.checked
                                  ? { ...c, nullable: false }
                                  : c,
                              ),
                            }))
                          }
                        />
                        {draft.primaryKey.includes(column.id) && (
                          <small title="Composite primary key order">
                            {draft.primaryKey.indexOf(column.id) + 1}
                          </small>
                        )}
                      </label>
                    </td>
                    <td>
                      <input
                        aria-label={`Not null ${index + 1}`}
                        type="checkbox"
                        checked={
                          !column.nullable ||
                          draft.primaryKey.includes(column.id)
                        }
                        disabled={draft.primaryKey.includes(column.id)}
                        onChange={(e) =>
                          patch(column.id, { nullable: !e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Unique ${index + 1}`}
                        type="checkbox"
                        checked={column.unique}
                        onChange={(e) =>
                          patch(column.id, { unique: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Default value ${index + 1}`}
                        placeholder="—"
                        value={column.defaultValue}
                        onChange={(e) =>
                          patch(column.id, { defaultValue: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <Button
                        title={`Remove column ${index + 1}`}
                        onClick={() =>
                          setDraft((table) => ({
                            ...table,
                            columns: table.columns.filter(
                              (c) => c.id !== column.id,
                            ),
                            primaryKey: table.primaryKey.filter(
                              (id) => id !== column.id,
                            ),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button className="add-column-row" onClick={addColumn}>
              <Plus size={14} />
              Add column
            </Button>
          </div>
          {(error || (changed && plan.errors.length > 0)) && (
            <div className="table-editor-error" role="alert">
              {error || plan.errors.join(" ")}
            </div>
          )}
          <div className="table-editor-actions">
            <div className="row">
              {!isNew && (
                <Button className="danger" onClick={() => void deleteTable()}>
                  <Trash2 size={14} />
                  Delete table
                </Button>
              )}
              <span
                className="key-summary"
                title={draft.primaryKey
                  .map((id) => draft.columns.find((c) => c.id === id)?.name)
                  .join(" → ")}
              >
                <KeyRound size={12} />
                {draft.primaryKey.length > 1
                  ? "Composite key"
                  : draft.primaryKey.length
                    ? "Primary key"
                    : "No primary key"}
              </span>
            </div>
            <div className="row">
              <Button onClick={() => void close()}>Cancel</Button>
              <Button
                className="primary"
                disabled={plan.errors.length > 0}
                onClick={() => void save()}
              >
                {isNew ? "Create table" : "Save changes"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
