import { tokenize } from "./lexer";
import {
  sqlStatements,
  mssqlBatches,
  resolveBatchResultSqls,
} from "./statements";
export interface SqlResult {
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  status: string;
  error?: boolean;
  messages?: string[];
}
export async function executeSqlBatch(
  sql: string,
  query: (sql: string) => Promise<{
    rows: Record<string, unknown>[];
    columns: string[];
    status?: string;
    messages?: string[];
    resultSets?: {
      rows: Record<string, unknown>[];
      columns: string[];
      status?: string;
      messages?: string[];
    }[];
  }>,
  dialect: "default" | "mssql" = "default",
) {
  const results: SqlResult[] = [];
  for (const statement of dialect === "mssql"
    ? mssqlBatches(sql)
    : sqlStatements(sql)) {
    const start = performance.now();
    try {
      const result = await query(statement.sql);
      const sets = result.resultSets?.length ? result.resultSets : [result];
      const setSqls = resolveBatchResultSqls(
        statement.sql,
        dialect,
        sets.length,
      );
      for (const [index, set] of sets.entries())
        results.push({
          messages:
            index === 0
              ? (result.messages ?? sets.flatMap((item) => item.messages ?? []))
              : undefined,
          sql: setSqls[index] ?? statement.sql.trim(),
          rows: set.rows,
          columns: set.columns,
          status:
            set.status ??
            `${set.rows.length} rows · ${Math.round(performance.now() - start)} ms`,
        });
    } catch (error) {
      let partialCount = 0;
      if (
        error &&
        typeof error === "object" &&
        "resultSets" in error &&
        Array.isArray(error.resultSets)
      ) {
        const validPartials = error.resultSets.filter(
          (
            partial,
          ): partial is {
            columns: string[];
            rows: Record<string, unknown>[];
            truncated?: boolean;
          } =>
            !!partial &&
            Array.isArray(partial.columns) &&
            Array.isArray(partial.rows),
        );
        partialCount = validPartials.length;
        const setSqls = resolveBatchResultSqls(
          statement.sql,
          dialect,
          partialCount + 1,
        );
        for (const [partialIndex, partial] of validPartials.entries()) {
          results.push({
            sql: setSqls[partialIndex] ?? statement.sql.trim(),
            columns: partial.columns,
            rows: partial.rows,
            status: `${partial.rows.length} rows · before error${partial.truncated ? " · truncated" : ""}`,
          });
        }
      }
      const errorSqls =
        partialCount > 0
          ? resolveBatchResultSqls(statement.sql, dialect, partialCount + 1)
          : undefined;
      results.push({
        sql: errorSqls?.[partialCount] ?? statement.sql.trim(),
        rows: [],
        columns: [],
        status:
          error instanceof Error
            ? error.message
            : error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error),
        messages:
          error &&
          typeof error === "object" &&
          "messages" in error &&
          Array.isArray(error.messages)
            ? error.messages.map(String)
            : undefined,
        error: true,
      });
      break;
    }
  }
  return results;
}

/** Conservative invalidation; strings/comments do not imply a schema change. */
export function sqlMayChangeSchema(
  sql: string,
  dialect: "default" | "mssql" = "default",
) {
  return tokenize(sql, dialect).some(
    (token) =>
      token.kind === "word" &&
      /^(CREATE|ALTER|DROP|RENAME|EXEC|EXECUTE|CALL|GRANT|REVOKE)$/i.test(
        token.text,
      ),
  );
}
