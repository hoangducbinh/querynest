import type { WorkspaceDefinition, WorkspaceSource } from "../../types/schema";
import type { SqlResult } from "../sql/execution";
import type { DraftRow } from "../sample-data/model";
import { editableResult } from "../sql/editable-result";
import { withDatabaseSession } from "./databases";
import { remoteClient } from "./client";
import { gridChanges, gridSaveError } from "./grid";
import { invalidateTable } from "./table-state";
import { sourceSessionKey } from "./sources";
export async function saveQueryResult(
  workspace: WorkspaceDefinition,
  source: WorkspaceSource,
  result: SqlResult,
  drafts: DraftRow[],
) {
  const config = source.connection;
  if (!config || config.config.readOnly)
    throw Error("This connection is read-only.");
  const table = editableResult(result, source.schema, config.engine);
  if (!table)
    throw Error(
      "Only full rows from a single table with a primary key can be edited.",
    );
  return withDatabaseSession(workspace, source, async (session) => {
    const client = remoteClient(config.engine);
    const changes = gridChanges(drafts);
    if (!changes.length) return result.rows;
    try {
      await client.save(session.sessionId, table.id, changes);
    } catch (error) {
      throw gridSaveError(error);
    } finally {
      invalidateTable(
        `${session.sessionId}:${sourceSessionKey(workspace.id, source.id)}`,
        table.id,
      );
    }
    try {
      return (await client.query(session.sessionId, result.sql)).rows;
    } catch {
      throw Object.assign(
        new Error(
          "Changes were saved, but the result could not reload. Run the SELECT again before editing. Do not submit these changes again.",
        ),
        { requiresRefresh: true },
      );
    }
  });
}
