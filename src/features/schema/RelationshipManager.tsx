import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link2, Plus, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { useStore } from "./store";
import { id } from "./core";
import { RelationshipProperties } from "./RelationshipProperties";
import type {
  RelationshipDefinition,
  TableDefinition,
} from "../../types/schema";
export function RelationshipManager({
  table,
  onClose,
}: {
  table: TableDefinition;
  onClose: () => void;
}) {
  const workspace = useStore((s) => s.workspace);
  const related = workspace.schema.relationships.filter(
    (r) => r.sourceTable === table.id || r.targetTable === table.id,
  );
  const [selected, setSelected] = useState(related[0]?.id ?? "");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<RelationshipDefinition | null>(null);
  const current = draft ?? related.find((r) => r.id === selected);
  function create() {
    const target =
      workspace.schema.tables.find((t) => t.id !== table.id) ?? table;
    const sourceColumn =
      table.columns.find((c) => !table.primaryKey.includes(c.id)) ??
      table.columns[0];
    const targetColumn =
      target.columns.find((c) => target.primaryKey.includes(c.id)) ??
      target.columns[0];
    setDraft({
      id: id(),
      sourceTable: table.id,
      sourceColumns: [sourceColumn.id],
      targetTable: target.id,
      targetColumns: [targetColumn.id],
      kind: target.id === table.id ? "logical" : "physical",
    });
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="relationship-manager-dialog"
          aria-describedby={undefined}
        >
          <div className="table-editor-title">
            <Dialog.Title>Relationships · {table.name}</Dialog.Title>
            <Button title="Close relationships" onClick={onClose}>
              <X size={15} />
            </Button>
          </div>
          <div className="relationship-manager-toolbar">
            <select
              aria-label="Select relationship"
              value={draft ? "new" : selected}
              onChange={(e) => {
                setDraft(null);
                setSelected(e.target.value);
              }}
            >
              {!related.length && <option value="">No relationships</option>}
              {draft && <option value="new">New relationship</option>}
              {related.map((r) => (
                <option key={r.id} value={r.id}>
                  {
                    workspace.schema.tables.find((t) => t.id === r.sourceTable)
                      ?.name
                  }{" "}
                  →{" "}
                  {
                    workspace.schema.tables.find((t) => t.id === r.targetTable)
                      ?.name
                  }{" "}
                  (
                  {r.sourceColumns
                    .map(
                      (id) =>
                        workspace.schema.tables
                          .find((t) => t.id === r.sourceTable)
                          ?.columns.find((c) => c.id === id)?.name,
                    )
                    .join(", ")}
                  )
                </option>
              ))}
            </select>
            <Button title="New relationship" onClick={create}>
              <Plus size={15} />
            </Button>
          </div>
          {error && (
            <div className="table-editor-error" role="alert">
              {error}
            </div>
          )}
          {current ? (
            <RelationshipProperties
              key={JSON.stringify(current)}
              relationship={current}
              isNew={!!draft}
              onError={setError}
              onDone={() => {
                setDraft(null);
                onClose();
              }}
            />
          ) : (
            <div className="relationship-manager-empty">
              <Link2 size={22} />
              <span>No relationships for this table.</span>
              <Button onClick={create}>
                <Plus size={14} />
                New relationship
              </Button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
