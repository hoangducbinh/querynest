import type { DatabaseSchema, WorkspaceDefinition } from "../../types/schema";
// View-local layout: never writes table positions back to the workspace.
export function relationPositions(
  schema: DatabaseSchema,
): Map<string, { x: number; y: number }> {
  const parents = new Map(
    schema.tables.map((table) => [table.id, new Set<string>()]),
  );
  const children = new Map(
    schema.tables.map((table) => [table.id, new Set<string>()]),
  );
  for (const relationship of schema.relationships) {
    if (
      relationship.sourceTable === relationship.targetTable ||
      !parents.has(relationship.sourceTable) ||
      !parents.has(relationship.targetTable)
    )
      continue;
    parents.get(relationship.sourceTable)!.add(relationship.targetTable);
    children.get(relationship.targetTable)!.add(relationship.sourceTable);
  }
  const indegree = new Map(
    [...parents].map(([id, values]) => [id, values.size]),
  );
  const rank = new Map(schema.tables.map((table) => [table.id, 0]));
  const queue = schema.tables
    .filter((table) => indegree.get(table.id) === 0)
    .map((table) => table.id);
  const done = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    done.add(id);
    for (const child of children.get(id)!) {
      rank.set(child, Math.max(rank.get(child)!, rank.get(id)! + 1));
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  // Logical cycles remain viewable instead of recursively expanding forever.
  for (const table of schema.tables)
    if (!done.has(table.id)) rank.set(table.id, 0);
  const yOffsets = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const table of schema.tables) {
    const layer = rank.get(table.id)!;
    const y = yOffsets.get(layer) ?? 60;
    positions.set(table.id, { x: 60 + layer * 320, y });
    yOffsets.set(layer, y + table.columns.length * 30 + 120);
  }
  return positions;
}

export function restoredPositions(
  schema: DatabaseSchema,
  saved: WorkspaceDefinition["diagramPositions"],
) {
  const positions = relationPositions(schema);
  for (const table of schema.tables) {
    const position = saved?.[table.id];
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y))
      positions.set(table.id, { ...position });
  }
  return positions;
}
