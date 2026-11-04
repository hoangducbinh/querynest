import { didYouMean } from "./language";
import type { SqlDialect } from "./data-types";
import { tokenize } from "./lexer";
import { sqlStatements } from "./statements";
export interface SqlDiagnostic {
  start: number;
  end: number;
  message: string;
  warning?: boolean;
}
export function diagnosticForError(
  sql: string,
  offset: number,
  error: unknown,
): SqlDiagnostic {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).replace(/^Error:\s*/, "");
  const lines = sql.split("\n");
  const location = /LINE (\d+): ([^\n]*)\n([ \t]*)\^/.exec(message);
  let start = 0;
  if (location) {
    const line = Math.min(
      lines.length - 1,
      Math.max(0, Number(location[1]) - 1),
    );
    const prefix = `LINE ${location[1]}: `.length;
    start =
      lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) +
      Math.max(0, location[3].length - prefix);
    start = Math.min(sql.length, start);
  } else if (/syntax error at end of input/i.test(message)) {
    start = sql.trimEnd().length;
  } else {
    const name =
      /(?:Table with name |Referenced column |Referenced table |column |table )"?([^"\s]+)"?/i.exec(
        message,
      )?.[1];
    const token =
      name &&
      tokenize(sql).find(
        (item) =>
          (item.kind === "word" || item.kind === "identifier") &&
          item.text.toLowerCase() === name.toLowerCase(),
      );
    start = token
      ? token.start
      : (tokenize(sql).find((item) => item.kind !== "comment")?.start ?? 0);
  }
  const token = tokenize(sql).find(
    (item) => item.start <= start && item.end > start,
  );
  return {
    start: offset + start,
    end: offset + Math.max(start + 1, token?.end ?? start + 1),
    message,
    warning: /cannot be prepared|not supported.*prepar|can only prepare/i.test(
      message,
    ),
  };
}
export async function validateSql(
  sql: string,
  prepare: (sql: string) => Promise<void>,
): Promise<SqlDiagnostic[]> {
  const diagnostics: SqlDiagnostic[] = [];
  let schemaChanged = false;
  for (const statement of sqlStatements(sql)) {
    try {
      await prepare(statement.sql);
    } catch (error) {
      const diagnostic = diagnosticForError(
        statement.sql,
        statement.start,
        error,
      );
      if (schemaChanged) {
        diagnostic.warning = true;
        diagnostic.message =
          "Checked against the current database; earlier schema changes in this script have not been executed.\n" +
          diagnostic.message;
      }
      diagnostics.push(diagnostic);
    }
    const first = tokenize(statement.sql).find(
      (token) => token.kind !== "comment",
    );
    if (
      first?.kind === "word" &&
      /^(CREATE|ALTER|DROP|ATTACH|DETACH|USE)$/i.test(first.text)
    )
      schemaChanged = true;
  }
  return diagnostics;
}

/** Cheap, database-independent checks while typing; never executes SQL. */
export function editingDiagnostics(
  sql: string,
  dialect: SqlDialect = "default",
): SqlDiagnostic[] {
  const tokens = tokenize(sql, dialect === "mssql" ? "mssql" : "default");
  const diagnostics: SqlDiagnostic[] = [];
  const stack: typeof tokens = [];
  for (const token of tokens) {
    if (!token.closed && token.kind !== "comment") {
      diagnostics.push({
        start: token.start,
        end: token.end,
        message: "Unclosed quoted value or identifier.",
      });
    } else if (
      !token.closed &&
      token.kind === "comment" &&
      token.text.startsWith("/*")
    ) {
      diagnostics.push({
        start: token.start,
        end: token.end,
        message: "Unclosed block comment.",
      });
    }
    if (token.kind !== "symbol") continue;
    if (token.text === "(") stack.push(token);
    else if (token.text === ")" && !stack.pop())
      diagnostics.push({
        start: token.start,
        end: token.end,
        message: "Unexpected closing parenthesis.",
      });
  }
  for (const token of stack)
    diagnostics.push({
      start: token.start,
      end: token.end,
      message: "Missing closing parenthesis.",
    });
  const first = tokens.find((token) => token.kind !== "comment");
  if (first?.kind === "word") {
    const candidates = didYouMean(first.text, [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "CREATE",
      "ALTER",
      "DROP",
      "WITH",
      "EXPLAIN",
    ]);
    if (candidates.length)
      diagnostics.push({
        start: first.start,
        end: first.end,
        warning: true,
        message: `Did you mean ${candidates.join(" or ")}?`,
      });
  }
  return diagnostics;
}
