import type { MssqlConfig } from "../features/connections/model";
import type { PostgresConfig } from "../features/postgres/model";
export { duckTypes as dataTypes } from "../lib/duckdb/types";
export type DataType = string;
export interface ColumnDefinition {
  generated?: boolean;
  readOnly?: boolean;
  nativeType?: string;
  id: string;
  name: string;
  type: DataType;
  nullable: boolean;
  unique: boolean;
  defaultValue: string;
}
export interface TableDefinition {
  readOnly?: boolean;
  namespace?: string;
  id: string;
  name: string;
  columns: ColumnDefinition[];
  primaryKey: string[];
  position: { x: number; y: number };
}
export interface RelationshipDefinition {
  id: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  kind: "physical" | "logical";
}
export interface DatabaseSchema {
  tables: TableDefinition[];
  relationships: RelationshipDefinition[];
}
export interface TestCase {
  id: string;
  name: string;
  description: string;
  sql: string;
  expected: string;
  ordered: boolean;
}
export interface SqlSnippet {
  id: string;
  prefix: string;
  description: string;
  body: string;
}
export interface SqlTab {
  id: string;
  name: string;
  sql: string;
}
export interface WorkspaceDefinition {
  version: 1;
  id: string;
  name: string;
  schema: DatabaseSchema;
  sql: string;
  data: Record<string, Record<string, unknown>[]>;
  tests: TestCase[];
  sqlTabs?: SqlTab[];
  activeSqlTabId?: string;
  sqlSnippets?: SqlSnippet[];
  postgres?: PostgresConfig;
  mssql?: MssqlConfig;
  connectionId?: string;
  diagramPositions?: Record<string, { x: number; y: number }>;
  updatedAt: number;
}
