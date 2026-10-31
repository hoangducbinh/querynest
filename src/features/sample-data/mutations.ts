import type { TableDefinition, WorkspaceDefinition } from "../../types/schema";
import { query, snapshot } from "../../lib/duckdb/engine";
import { mutationSQL, type DraftRow } from "./model";
export async function saveGridChanges(
  workspace: WorkspaceDefinition,
  table: TableDefinition,
  rows: DraftRow[],
) {
  const statements = mutationSQL(table, rows);
  if (!statements.length) return workspace.data;
  await query("BEGIN TRANSACTION");
  let data: WorkspaceDefinition["data"];
  try {
    for (const statement of statements) await query(statement);
    data = await snapshot(workspace);
    await query("COMMIT");
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
  return data;
}
