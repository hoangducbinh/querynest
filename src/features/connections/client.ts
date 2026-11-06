import { locateSqlServerDiagnostic } from "../sql/diagnostic-location";
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
export interface RemoteConnectionResult {
  sessionId: string;
  serverVersion: string;
  catalog: PgCatalog;
}
const postgresClient = {
  databases: (sessionId: string) =>
    invoke<string[]>("pg_databases", { sessionId }),
  openDatabase: (sessionId: string, database: string) =>
    invoke<RemoteConnectionResult>("pg_open_database", { sessionId, database }),
  columnContext: (sessionId: string, tableId: string) =>
    invoke<ColumnContext>("pg_column_context", { sessionId, tableId }),
  changeColumn: (sessionId: string, tableId: string, change: ColumnChange) =>
    invoke<void>("pg_change_column", { sessionId, tableId, change }),
  save: (sessionId: string, tableId: string, changes: GridChange[]) =>
    invoke<number>("pg_save_grid", { sessionId, tableId, changes }),
  disconnect: disconnectPostgres,
  query: queryPostgres,
  page: pagePostgres,
  refresh: refreshPostgres,
  cancel: cancelPostgres,
  validate: validatePostgres,
};
const mssqlClient = {
  databases: (sessionId: string) =>
    invoke<string[]>("ms_databases", { sessionId }),
  openDatabase: (sessionId: string, database: string) =>
    invoke<RemoteConnectionResult>("ms_open_database", { sessionId, database }),
  columnContext: (sessionId: string, tableId: string) =>
    invoke<ColumnContext>("ms_column_context", { sessionId, tableId }),
  changeColumn: (sessionId: string, tableId: string, change: ColumnChange) =>
    invoke<void>("ms_change_column", { sessionId, tableId, change }),
  save: (sessionId: string, tableId: string, changes: GridChange[]) =>
    invoke<number>("ms_save_grid", { sessionId, tableId, changes }),
  disconnect: (sessionId: string) =>
    invoke<void>("ms_disconnect", { sessionId }),
  query: (sessionId: string, sql: string) =>
    invoke<PgQueryResult>("ms_query", {
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
        ...found.map((issue) => {
          const located = locateSqlServerDiagnostic(batch.sql, issue);
          return {
            ...located,
            start: located.start + batch.start,
            end: located.end + batch.start,
          };
        }),
      );
    }
    return issues;
  },
};
// Stateless adapters can be shared by all views and retained sessions.
export const remoteClient = (engine: RemoteConfig["engine"]) =>
  engine === "postgres" ? postgresClient : mssqlClient;

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
