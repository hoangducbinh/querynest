export interface RemoteColumnInfo {
  id: string;
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string;
  generated: boolean;
  primaryKey: boolean;
  uniqueConstraints: string[];
  defaultConstraint: string | null;
  collation?: string | null;
  dependencies: string[];
}
export interface ColumnContext {
  tableId: string;
  schema: string;
  table: string;
  columns: RemoteColumnInfo[];
}
export interface RemoteColumnDraft {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string;
  unique: boolean;
  primaryKey: boolean;
}
export interface ColumnChange {
  action: "add" | "alter" | "drop";
  columnId?: string;
  column?: RemoteColumnDraft;
  expected: ColumnContext;
}
export const columnDraft = (
  column?: RemoteColumnInfo,
  engine: "postgres" | "mssql" = "postgres",
): RemoteColumnDraft => ({
  name: column?.name ?? "",
  dataType: column?.dataType ?? (engine === "mssql" ? "nvarchar(255)" : "text"),
  nullable: column?.nullable ?? true,
  defaultValue: column?.defaultValue ?? "",
  unique: !!column?.uniqueConstraints.length,
  primaryKey: column?.primaryKey ?? false,
});
export const columnTypes = (engine: "postgres" | "mssql") =>
  engine === "postgres"
    ? [
        "text",
        "varchar(255)",
        "integer",
        "bigint",
        "numeric(18,2)",
        "real",
        "double precision",
        "boolean",
        "date",
        "timestamp",
        "timestamp with time zone",
        "time",
        "uuid",
        "jsonb",
        "json",
        "bytea",
      ]
    : [
        "nvarchar(255)",
        "nvarchar(max)",
        "varchar(255)",
        "int",
        "bigint",
        "smallint",
        "tinyint",
        "decimal(18,2)",
        "float",
        "bit",
        "date",
        "datetime2(7)",
        "datetimeoffset(7)",
        "time(7)",
        "uniqueidentifier",
        "varbinary(max)",
        "xml",
      ];
export function columnRestrictions(
  context: ColumnContext,
  initial: RemoteColumnInfo | undefined,
  engine: "postgres" | "mssql",
) {
  return {
    generated: !!initial?.generated,
    typeLocked:
      !!initial?.generated ||
      (engine === "mssql" && !!initial?.dependencies.length),
    primaryLocked:
      !!initial?.generated ||
      !!initial?.primaryKey ||
      context.columns.some((c) => c.primaryKey && c.id !== initial?.id),
    uniqueLocked:
      !!initial?.generated || (initial?.uniqueConstraints.length ?? 0) > 1,
    dropLocked:
      context.columns.length <= 1 ||
      !!initial?.primaryKey ||
      !!initial?.dependencies.length ||
      !!initial?.uniqueConstraints.length,
  };
}
