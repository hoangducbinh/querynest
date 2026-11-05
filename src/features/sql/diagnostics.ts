import { didYouMean } from "./language";
import type { SqlDialect } from "./data-types";
import { tokenize } from "./lexer";
export interface SqlDiagnostic {
  start: number;
  end: number;
  message: string;
  warning?: boolean;
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
