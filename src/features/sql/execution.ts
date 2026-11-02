import { tokenize } from "./lexer";
import { sqlStatements, mssqlBatches } from "./statements";
export interface SqlResult {
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  status: string;
  error?: boolean;
}
export async function executeSqlBatch(
  sql: string,
  query: (sql: string) => Promise<{
    rows: Record<string, unknown>[];
    columns: string[];
    status?: string;
    resultSets?: {
      rows: Record<string, unknown>[];
      columns: string[];
      status?: string;
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
      for (const set of result.resultSets?.length
        ? result.resultSets
        : [result])
        results.push({
          sql: statement.sql.trim(),
          rows: set.rows,
          columns: set.columns,
          status:
            set.status ??
            `${set.rows.length} rows · ${Math.round(performance.now() - start)} ms`,
        });
    } catch (error) {
      results.push({
        sql: statement.sql.trim(),
        rows: [],
        columns: [],
        status: String(error),
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
