import type { ColumnContext, ColumnChange } from "./columns";
import type { GridChange } from "./grid";
import { mssqlBatches } from "../sql/statements";
import { invoke } from "@tauri-apps/api/core";
import {
  connectPostgres,
  testPostgresConnection,
  disconnectPostgres,
  queryPostgres,
  pagePostgres,
  refreshPostgres,
  cancelPostgres,
  validatePostgres,
  type PgQueryResult,
} from "../postgres/client";
import type { PgCatalog } from "../postgres/model";
import type { RemoteConfig } from "./model";
import type { SqlDiagnostic } from "../sql/diagnostics";
export const remoteClient = (engine: RemoteConfig["engine"]) =>
  engine === "postgres"
    ? {
        columnContext: (sessionId: string, tableId: string) =>
          invoke<ColumnContext>("pg_column_context", { sessionId, tableId }),
        changeColumn: (
          sessionId: string,
          tableId: string,
          change: ColumnChange,
        ) => invoke<void>("pg_change_column", { sessionId, tableId, change }),
        save: (sessionId: string, tableId: string, changes: GridChange[]) =>
          invoke<number>("pg_save_grid", { sessionId, tableId, changes }),
        disconnect: disconnectPostgres,
        query: queryPostgres,
        page: pagePostgres,
        refresh: refreshPostgres,
        cancel: cancelPostgres,
        validate: validatePostgres,
      }
    : {
        columnContext: (sessionId: string, tableId: string) =>
          invoke<ColumnContext>("ms_column_context", { sessionId, tableId }),
        changeColumn: (
          sessionId: string,
          tableId: string,
          change: ColumnChange,
        ) => invoke<void>("ms_change_column", { sessionId, tableId, change }),
        save: (sessionId: string, tableId: string, changes: GridChange[]) =>
          invoke<number>("ms_save_grid", { sessionId, tableId, changes }),
        disconnect: (sessionId: string) =>
          invoke<void>("ms_disconnect", { sessionId }),
        query: (sessionId: string, sql: string) =>
          invoke<PgQueryResult & { resultSets?: PgQueryResult[] }>("ms_query", {
            sessionId,
            sql,
          }),
        page: (sessionId: string, tableId: string, page: number) =>
          invoke<PgQueryResult>("ms_table_data", { sessionId, tableId, page }),
        refresh: (sessionId: string) =>
          invoke<PgCatalog>("ms_catalog", { sessionId }),
        cancel: (sessionId: string) => invoke<void>("ms_cancel", { sessionId }),
        validate: async (sessionId: string, sql: string) => {
          const issues: SqlDiagnostic[] = [];
          for (const batch of mssqlBatches(sql)) {
            const found = await invoke<SqlDiagnostic[]>("ms_validate", {
              sessionId,
              sql: batch.sql,
            });
            issues.push(
              ...found.map((issue) => ({
                ...issue,
                start: issue.start + batch.start,
                end: issue.end + batch.start,
              })),
            );
          }
          return issues;
        },
      };
export function testRemoteConnection(value: RemoteConfig, password: string) {
  return value.engine === "postgres"
    ? testPostgresConnection(value.config, password)
    : invoke<{ serverVersion: string }>("ms_test_connection", {
        config: value.config,
        password,
      });
}
export function connectRemote(value: RemoteConfig, password: string) {
  return value.engine === "postgres"
    ? connectPostgres(value.config, password)
    : invoke<{ sessionId: string; serverVersion: string; catalog: PgCatalog }>(
        "ms_connect",
        { config: value.config, password },
      );
}
