import type { DatabaseSchema, DataType } from "../../types/schema";
export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: "verify-full" | "require" | "disable";
  readOnly: boolean;
}
export const defaultPostgresConfig: PostgresConfig = {
  host: "localhost",
  port: 5432,
  database: "postgres",
  user: "postgres",
  sslMode: "verify-full",
  readOnly: true,
};
export function parsePostgresConfig(value: unknown): PostgresConfig {
  if (!value || typeof value !== "object")
    throw Error("Invalid PostgreSQL connection.");
  const c = value as Record<string, unknown>;
  if (
    ![c.host, c.database, c.user].every(
      (v) => typeof v === "string" && v.trim(),
    ) ||
    !Number.isInteger(c.port) ||
    Number(c.port) < 1 ||
    Number(c.port) > 65535 ||
    !["verify-full", "require", "disable"].includes(String(c.sslMode)) ||
    typeof c.readOnly !== "boolean"
  )
    throw Error("Invalid PostgreSQL connection settings.");
  return {
    host: c.host as string,
    port: c.port as number,
    database: c.database as string,
    user: c.user as string,
    sslMode: c.sslMode as PostgresConfig["sslMode"],
    readOnly: c.readOnly,
  };
}
export interface CatalogTable {
  id: string;
  schema: string;
  name: string;
  kind: string;
  columns: {
    id: string;
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    generated?: boolean;
    readOnly?: boolean;
    defaultValue?: string;
  }[];
}
export interface CatalogFunction {
  id: string;
  schema: string;
  name: string;
  kind?: string;
  resultType?: string;
  arguments?: string;
  definition?: string;
}
export interface PgCatalog {
  schemas?: string[];
  tables: CatalogTable[];
  relationships: {
    id: string;
    sourceTable: string;
    targetTable: string;
    sourceColumns: string[];
    targetColumns: string[];
  }[];
  functions?: CatalogFunction[];
}
function mappedType(type: string): DataType {
  if (/^(tinyint|smallint|integer|int)$/.test(type)) return "INTEGER";
  if (type === "bigint") return "BIGINT";
  if (/^(numeric|decimal|real|double|float|money|smallmoney)/.test(type))
    return "DOUBLE";
  if (type === "boolean" || type === "bit") return "BOOLEAN";
  if (type === "date") return "DATE";
  if (/^(timestamp|datetime|smalldatetime)/.test(type)) return "TIMESTAMP";
  return "VARCHAR";
}
export function catalogSchema(catalog: PgCatalog): DatabaseSchema {
  const ids = new Set((catalog.tables || []).map((t) => t.id));
  return {
    schemas: catalog.schemas || [],
    tables: (catalog.tables || []).map((t, index) => ({
      id: t.id,
      name: t.name,
      namespace: t.schema,
      kind: ["v", "m", "V"].includes(t.kind?.trim() || "")
        ? ("view" as const)
        : ("table" as const),
      readOnly: !["r", "p", "U", "U "].includes(t.kind),
      columns: (t.columns || []).map((c) => ({
        id: c.id,
        name: c.name,
        type: mappedType(c.type),
        nativeType: c.type,
        nullable: c.nullable,
        unique: false,
        generated: c.generated ?? false,
        readOnly: (c.readOnly ?? false) || (c.generated ?? false),
        defaultValue: c.defaultValue || (c.generated ? "Generated" : ""),
      })),
      primaryKey: (t.columns || []).filter((c) => c.primaryKey).map((c) => c.id),
      position: { x: (index % 3) * 330, y: Math.floor(index / 3) * 300 },
    })),
    relationships: (catalog.relationships || [])
      .filter((r) => ids.has(r.sourceTable) && ids.has(r.targetTable))
      .map((r) => ({ ...r, kind: "physical" as const })),
    functions: (catalog.functions || []).map((f) => ({
      id: f.id,
      name: f.name,
      namespace: f.schema,
      kind: f.kind,
      resultType: f.resultType,
      arguments: f.arguments,
      definition: f.definition,
    })),
  };
}
export function pgError(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}
