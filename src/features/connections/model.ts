import {
  parsePostgresConfig,
  defaultPostgresConfig,
  type PostgresConfig,
} from "../postgres/model";
export interface MssqlConfig {
  auth: "sql" | "windows";
  host: string;
  port: number;
  database: string;
  user: string;
  encrypt: boolean;
  trustCertificate: boolean;
  readOnly: boolean;
}
export type RemoteConfig =
  | { engine: "postgres"; config: PostgresConfig }
  | { engine: "mssql"; config: MssqlConfig };
export type ConnectionProfile = RemoteConfig & {
  id: string;
  name: string;
  updatedAt: number;
};
export const engineName = (engine: RemoteConfig["engine"]) =>
  engine === "postgres" ? "PostgreSQL" : "SQL Server";
export const defaultMssqlConfig: MssqlConfig = {
  auth: "sql",
  host: "localhost",
  port: 1433,
  database: "master",
  user: "sa",
  encrypt: true,
  trustCertificate: false,
  readOnly: true,
};
export function defaultRemoteConfig(
  engine: RemoteConfig["engine"],
): RemoteConfig {
  return engine === "postgres"
    ? { engine, config: { ...defaultPostgresConfig } }
    : { engine, config: { ...defaultMssqlConfig } };
}
export function parseMssqlConfig(value: unknown): MssqlConfig {
  if (!value || typeof value !== "object")
    throw Error("Invalid SQL Server connection.");
  const c = value as Record<string, unknown>;
  if (
    ![c.host, c.database].every((v) => typeof v === "string" && v.trim()) ||
    !(c.auth === undefined || c.auth === "sql" || c.auth === "windows") ||
    (c.auth !== "windows" && (typeof c.user !== "string" || !c.user.trim())) ||
    !Number.isInteger(c.port) ||
    Number(c.port) < 1 ||
    Number(c.port) > 65535 ||
    ![c.encrypt, c.trustCertificate, c.readOnly].every(
      (v) => typeof v === "boolean",
    )
  )
    throw Error("Host, database, user and a valid port are required.");
  return {
    auth: c.auth === "windows" ? "windows" : "sql",
    host: (c.host as string).trim(),
    port: c.port as number,
    database: (c.database as string).trim(),
    user: c.auth === "windows" ? "" : (c.user as string).trim(),
    encrypt: c.encrypt as boolean,
    trustCertificate: c.trustCertificate as boolean,
    readOnly: c.readOnly as boolean,
  };
}
export function parseRemoteConfig(value: RemoteConfig): RemoteConfig {
  if (value.engine === "postgres")
    return { engine: "postgres", config: parsePostgresConfig(value.config) };
  if (value.engine === "mssql")
    return { engine: "mssql", config: parseMssqlConfig(value.config) };
  throw Error("Unsupported database engine.");
}
export function parseProfile(value: ConnectionProfile): ConnectionProfile {
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Number.isFinite(value.updatedAt)
  )
    throw Error("Invalid connection profile.");
  return {
    ...parseRemoteConfig(value),
    id: value.id,
    name: value.name.trim(),
    updatedAt: value.updatedAt,
  };
}
