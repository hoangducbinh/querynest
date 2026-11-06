import { tokenize } from "./lexer";
import type { SqlDiagnostic } from "./diagnostics";

/** SQL Server supplies a line, not a character offset. Refine only unambiguous named errors. */
export function locateSqlServerDiagnostic(
  sql: string,
  issue: SqlDiagnostic,
): SqlDiagnostic {
  const offset = Math.max(0, Math.min(sql.length, issue.start));
  const lineStart = offset === 0 ? 0 : sql.lastIndexOf("\n", offset - 1) + 1;
  const newline = sql.indexOf("\n", offset);
  const lineEnd = newline < 0 ? sql.length : newline;
  const tokens = tokenize(sql, "mssql").filter(
    (token) => token.kind !== "comment",
  );
  const name =
    /(?:Invalid column name|Invalid object name|identifier|Incorrect syntax near)\s+['"]([^'"]+)['"]/i.exec(
      issue.message,
    )?.[1];
  if (name) {
    const identifier = name.split(".").at(-1)!;
    const matches = tokens.filter(
      (token) =>
        (token.kind !== "string" ||
          /Incorrect syntax near/i.test(issue.message)) &&
        token.text.toLowerCase() === identifier.toLowerCase(),
    );
    const onLine = matches.filter(
      (token) => token.start >= lineStart && token.start < lineEnd,
    );
    const candidates = onLine.length ? onLine : matches;
    if (candidates.length === 1)
      return { ...issue, start: candidates[0].start, end: candidates[0].end };
  }
  // Do not pretend the first character of the line is the offending token.
  const onLine = tokens.filter(
    (token) => token.start >= lineStart && token.start < lineEnd,
  );
  return {
    ...issue,
    start: onLine[0]?.start ?? offset,
    end: onLine.at(-1)?.end ?? Math.min(sql.length, offset + 1),
    message: `${issue.message}\nSQL Server reported this line; the exact token is unavailable.`,
  };
}
