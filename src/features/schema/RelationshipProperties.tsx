import { confirmAction } from "../../lib/dialogs";
import { useState } from "react";
import type { RelationshipDefinition } from "../../types/schema";
import { useStore } from "./store";
import { validateRelationship } from "./core";
import { Button } from "../../components/ui/button";
export function RelationshipProperties({
  relationship,
  onError,
  isNew = false,
  onDone,
}: {
  relationship: RelationshipDefinition;
  onError: (message: string) => void;
  isNew?: boolean;
  onDone?: () => void;
}) {
  const { workspace, edit } = useStore();
  const [draft, setDraft] = useState(relationship);
  const a = workspace.schema.tables.find((t) => t.id === draft.sourceTable)!;
  const b = workspace.schema.tables.find((t) => t.id === draft.targetTable)!;
  const error = validateRelationship(workspace.schema, draft);
  return (
    <div className="properties">
      {isNew && (
        <label>
          Referenced table
          <select
            value={draft.targetTable}
            onChange={(event) => {
              const target = workspace.schema.tables.find(
                (t) => t.id === event.target.value,
              )!;
              setDraft({
                ...draft,
                targetTable: target.id,
                targetColumns: draft.sourceColumns.map(
                  () => target.columns[0]?.id ?? "",
                ),
              });
            }}
          >
            {workspace.schema.tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>
        {a.name} → {b.name}
      </p>
      <label>
        Constraint type
        <select
          value={draft.kind}
          onChange={(e) =>
            setDraft({ ...draft, kind: e.target.value as typeof draft.kind })
          }
        >
          <option value="physical">Physical foreign key</option>
          <option value="logical">Logical relationship</option>
        </select>
      </label>
      {draft.sourceColumns.map((column, index) => (
        <div key={index} className="column-card">
          <label>
            Source column
            <select
              value={column}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  sourceColumns: draft.sourceColumns.map((x, i) =>
                    i === index ? e.target.value : x,
                  ),
                })
              }
            >
              {a.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Referenced column
            <select
              value={draft.targetColumns[index]}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  targetColumns: draft.targetColumns.map((x, i) =>
                    i === index ? e.target.value : x,
                  ),
                })
              }
            >
              {b.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={draft.sourceColumns.length === 1}
            onClick={() =>
              setDraft({
                ...draft,
                sourceColumns: draft.sourceColumns.filter(
                  (_, i) => i !== index,
                ),
                targetColumns: draft.targetColumns.filter(
                  (_, i) => i !== index,
                ),
              })
            }
          >
            Remove pair
          </Button>
        </div>
      ))}
      <Button
        onClick={() =>
          setDraft({
            ...draft,
            sourceColumns: [...draft.sourceColumns, a.columns[0].id],
            targetColumns: [...draft.targetColumns, b.columns[0].id],
          })
        }
      >
        Add column pair
      </Button>
      <p className="error">{error}</p>
      <Button
        className="primary full"
        disabled={!!error}
        onClick={async () => {
          const issue = validateRelationship(workspace.schema, draft);
          if (issue) {
            onError(issue);
            return;
          }
          edit((w) => {
            if (isNew) w.schema.relationships.push(draft);
            else
              Object.assign(
                w.schema.relationships.find((r) => r.id === draft.id)!,
                draft,
              );
          });
          onDone?.();
        }}
      >
        {isNew ? "Create relationship" : "Save relationship"}
      </Button>
      {!isNew && (
        <Button
          className="danger full"
          onClick={async () => {
            if (!(await confirmAction("Delete this relationship?"))) return;
            edit((w) => {
              w.schema.relationships = w.schema.relationships.filter(
                (r) => r.id !== draft.id,
              );
            });
            onDone?.();
          }}
        >
          Delete relationship
        </Button>
      )}
    </div>
  );
}
