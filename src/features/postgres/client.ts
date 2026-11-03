import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PostgresConfig, PgCatalog } from "./model";
import { pgError } from "./model";
import { tokenize } from "../sql/lexer";
import { sqlStatements } from "../sql/statements";
import type { SqlDiagnostic } from "../sql/diagnostics";
export { isTauri };
export interface PgQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows: number;
  truncated: boolean;
  resultSets?: PgQueryResult[];
  messages?: string[];
}
export const connectPostgres = (config: PostgresConfig, password: string) =>
  invoke<{ sessionId: string; serverVersion: string; catalog: PgCatalog }>(
    "pg_connect",
    { config, password },
  );
export const testPostgresConnection = (
  config: PostgresConfig,
  password: string,
) =>
  invoke<{ serverVersion: string }>("pg_test_connection", { config, password });
export const disconnectPostgres = (sessionId: string) =>
  invoke<void>("pg_disconnect", { sessionId });
export const refreshPostgres = (sessionId: string) =>
  invoke<PgCatalog>("pg_catalog", { sessionId });
export const queryPostgres = (sessionId: string, sql: string) =>
  invoke<PgQueryResult>("pg_query", { sessionId, sql, limit: 1000 });
export const pagePostgres = (
  sessionId: string,
  tableId: string,
  page: number,
) => invoke<PgQueryResult>("pg_table_data", { sessionId, tableId, page });
export const cancelPostgres = (sessionId: string) =>
  invoke<void>("pg_cancel", { sessionId });
export async function validatePostgres(
  sessionId: string,
  sql: string,
): Promise<SqlDiagnostic[]> {
  const issues: SqlDiagnostic[] = [];
  for (const statement of sqlStatements(sql)) {
    try {
      await invoke("pg_validate", { sessionId, sql: statement.sql });
    } catch (error) {
      const e = error as { position?: number; code?: string };
      // PostgreSQL character positions count Unicode code points; Monaco offsets count UTF-16 units.
      const local = e.position
        ? Array.from(statement.sql)
            .slice(0, e.position - 1)
            .join("").length
        : statement.sql.search(/\S/);
      const token = tokenize(statement.sql).find(
        (token) => token.start <= local && token.end > local,
      );
      issues.push({
        start: statement.start + Math.max(0, local),
        end:
          statement.start + Math.max(Math.max(0, local) + 1, token?.end ?? 0),
        message: pgError(error),
        warning: !e.code || e.code === "0A000",
      });
    }
  }
  return issues;
}
