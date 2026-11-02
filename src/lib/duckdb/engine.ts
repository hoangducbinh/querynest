import { decimalText } from "./decimal";
import { duckValue, snapshotColumn } from "./values";
import * as duckdb from "@duckdb/duckdb-wasm";
import wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { WorkspaceDefinition } from "../../types/schema";
import { generateDDL, orderedTables, quote } from "../ddl/generate";
let connection: duckdb.AsyncDuckDBConnection | undefined;
let database: duckdb.AsyncDuckDB | undefined;
export const normalize = (value: unknown): unknown =>
  typeof value === "bigint"
    ? value.toString()
    : value instanceof Date
      ? value.toISOString()
      : Array.isArray(value)
        ? value.map(normalize)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, normalize(v)]),
            )
          : value;
export { literal } from "./literals";
export async function rebuild(w: WorkspaceDefinition) {
  const ddl = generateDDL(w.schema);
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: wasm, mainWorker: workerUrl },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  if (!bundle.mainWorker)
    throw Error("This browser cannot start the local SQL worker.");
  const next = new duckdb.AsyncDuckDB(
    new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR),
    new Worker(bundle.mainWorker),
  );
  try {
    await next.instantiate(bundle.mainModule);
    const c = await next.connect();
    await c.query("BEGIN TRANSACTION");
    try {
      if (ddl) await c.query(ddl);
      for (const t of orderedTables(w.schema)) {
        for (const row of w.data[t.id] ?? []) {
          if (
            Object.keys(row).some((k) => !t.columns.some((c) => c.name === k))
          )
            throw Error(
              `Saved rows for ${t.name} contain columns removed or renamed in the schema. Export and migrate the saved rows before rebuilding.`,
            );
          await c.query(
            `INSERT INTO ${quote(t.name)} (${t.columns.map((x) => quote(x.name)).join(",")}) VALUES (${t.columns.map((x) => (Object.hasOwn(row, x.name) ? duckValue(x, row[x.name]) : x.defaultValue.trim() || "NULL")).join(",")})`,
          );
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
    await connection?.close();
    await database?.terminate();
    database = next;
    connection = c;
  } catch (e) {
    await next.terminate();
    throw e;
  }
}
export async function query(sql: string) {
  if (!connection) throw Error("Apply the schema to initialize DuckDB first.");
  return queryResult(await connection.query(sql));
}
type ArrowResult = Pick<
  Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>,
  "schema" | "toArray"
>;
function queryResult(result: ArrowResult) {
  return {
    columns: result.schema.fields.map((f) => f.name),
    rows: result.toArray().map((r) => {
      const row = r.toJSON() as Record<string, unknown>;
      for (const field of result.schema.fields) {
        const value = row[field.name];
        const type = field.type.toString();
        if (type.startsWith("Decimal") && ArrayBuffer.isView(value)) {
          row[field.name] = decimalText(
            value as unknown as ArrayLike<number>,
            (field.type as unknown as { scale: number }).scale,
          );
        } else if (
          typeof value === "number" &&
          (type.startsWith("Timestamp") || type.startsWith("Date"))
        ) {
          const date = new Date(value);
          row[field.name] = type.startsWith("Date")
            ? date.toISOString().slice(0, 10)
            : date.toISOString();
        }
      }
      return normalize(row) as Record<string, unknown>;
    }),
  };
}
let activeQuery:
  { connection: duckdb.AsyncDuckDBConnection; cancelled: boolean } | undefined;
export async function queryCancelable(sql: string) {
  if (!connection) throw Error("Apply the schema to initialize DuckDB first.");
  if (activeQuery) throw Error("Another local query is running.");
  const active = { connection, cancelled: false };
  activeQuery = active;
  try {
    // Pending queries yield back to the worker so it can receive cancellation.
    // The synchronous query API blocks worker messages until execution completes.
    const reader = await active.connection.send(sql, false);
    await reader.open();
    // Arrow may clear its schema when the stream auto-closes at EOF.
    const columns = reader.schema.fields.map((field) => field.name);
    const rows: Record<string, unknown>[] = [];
    for await (const batch of reader) {
      if (active.cancelled) throw Error("Query stopped.");
      rows.push(...queryResult(batch).rows);
    }
    if (active.cancelled) throw Error("Query stopped.");
    return { columns, rows };
  } catch (error) {
    if (active.cancelled)
      throw Error("Query stopped. Remaining statements were skipped.");
    throw error;
  } finally {
    if (activeQuery === active) activeQuery = undefined;
  }
}
export async function cancelLocalQuery() {
  const active = activeQuery;
  if (!active) return;
  active.cancelled = true;
  try {
    await active.connection.cancelSent();
  } catch (error) {
    active.cancelled = false;
    throw error;
  }
}

export async function snapshot(w: WorkspaceDefinition) {
  const data: WorkspaceDefinition["data"] = {};
  for (const t of w.schema.tables)
    data[t.id] = (
      await query(
        `SELECT ${t.columns.map(snapshotColumn).join(", ")} FROM ${quote(t.name)}`,
      )
    ).rows;
  return data;
}

// Preparing binds and validates SQL without executing the prepared statement.
export async function withSqlValidator<T>(
  validate: (prepare: (sql: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!database)
    throw Error("SQL validation is unavailable until the database is ready.");
  const c = await database.connect();
  try {
    return await validate(async (sql) => {
      const statement = await c.prepare(sql);
      await statement.close();
    });
  } finally {
    await c.close();
  }
}
