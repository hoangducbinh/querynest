import type {
  ColumnDefinition,
  TableDefinition,
  WorkspaceDefinition,
} from "../../types/schema";
import { id, validateSchema } from "./core";
export function newColumn(name = ""): ColumnDefinition {
  return {
    id: id(),
    name,
    type: "VARCHAR",
    nullable: true,
    unique: false,
    defaultValue: "",
  };
}
export function newTable(workspace: WorkspaceDefinition): TableDefinition {
  const column = {
    ...newColumn("id"),
    type: "INTEGER" as const,
    nullable: false,
  };
  return {
    id: id(),
    name: "",
    columns: [column],
    primaryKey: [column.id],
    position: { x: 100 + workspace.schema.tables.length * 280, y: 140 },
  };
}
export function planTableEdit(
  workspace: WorkspaceDefinition,
  draft: TableDefinition,
  isNew: boolean,
) {
  const original = workspace.schema.tables.find((t) => t.id === draft.id);
  if (!isNew && !original) throw Error("This table no longer exists.");
  if (isNew && original) throw Error("This table already exists.");
  const table = {
    ...structuredClone(draft),
    name: draft.name.trim(),
    columns: draft.columns.map((column) => ({
      ...column,
      name: column.name.trim(),
      nullable: draft.primaryKey.includes(column.id) ? false : column.nullable,
    })),
  };
  const removed =
    original?.columns.filter(
      (c) => !table.columns.some((next) => next.id === c.id),
    ) ?? [];
  const removedIds = new Set(removed.map((c) => c.id));
  const removedRelationships = workspace.schema.relationships.filter(
    (r) =>
      (r.sourceTable === table.id &&
        r.sourceColumns.some((c) => removedIds.has(c))) ||
      (r.targetTable === table.id &&
        r.targetColumns.some((c) => removedIds.has(c))),
  );
  const relationships = workspace.schema.relationships.filter(
    (r) => !removedRelationships.some((removed) => removed.id === r.id),
  );
  const schema = {
    tables: isNew
      ? [...workspace.schema.tables, table]
      : workspace.schema.tables.map((t) => (t.id === table.id ? table : t)),
    relationships,
  };
  const errors = validateSchema(schema);
  const data = { ...workspace.data };
  // Stable column IDs make renames safe; additions keep defaults untouched.
  if (original)
    data[table.id] = (workspace.data[table.id] ?? []).map((row) => {
      const result: Record<string, unknown> = {};
      for (const column of table.columns) {
        const previous = original.columns.find((c) => c.id === column.id);
        if (previous && Object.hasOwn(row, previous.name))
          result[column.name] = row[previous.name];
      }
      // Runtime-only columns must not be silently lost in a visual edit.
      for (const key of Object.keys(row)) {
        if (!original.columns.some((c) => c.name === key)) {
          if (table.columns.some((c) => c.name === key))
            errors.push(
              `Saved rows contain an unmapped column "${key}". Export and reconcile the data before editing.`,
            );
          else result[key] = row[key];
        }
      }
      return result;
    });
  return {
    schema,
    data,
    table,
    removed,
    removedRelationships,
    errors: [...new Set(errors)],
  };
}
