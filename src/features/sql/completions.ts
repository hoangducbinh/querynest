import type {
  DatabaseSchema,
  SqlSnippet,
  TableDefinition,
} from "../../types/schema";
import { sqlDataTypes, type SqlDialect } from "./data-types";
import { quote } from "../../lib/ddl/generate";
import { tokenize, type Token } from "./lexer";
const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "ON",
  "AS",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "WITH",
  "DISTINCT",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS NULL",
  "IS NOT NULL",
  "BETWEEN",
  "LIKE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "UNION ALL",
  "EXISTS",
  "RETURNING",
  "QUALIFY",
];
const RESERVED = new Set(
  [
    ...KEYWORDS.flatMap((keyword) => keyword.split(" ")),
    "BY",
    "OUTER",
    "USING",
    "NATURAL",
    "WINDOW",
    "OVER",
    "PARTITION",
    "EXCEPT",
    "INTERSECT",
    "FETCH",
    "ONLY",
    "LATERAL",
    "TABLESAMPLE",
    "PIVOT",
    "UNPIVOT",
    "PRIMARY",
    "KEY",
    "UNIQUE",
    "DEFAULT",
    "CONSTRAINT",
    "REFERENCES",
    "NULL",
    "TRUE",
    "FALSE",
    "USER",
  ].map((word) => word.toLowerCase()),
);
const MSSQL_RESERVED = new Set([
  ...RESERVED,
  ...[
    "ASC",
    "DESC",
    "CHECK",
    "INDEX",
    "IDENTITY",
    "DATABASE",
    "SCHEMA",
    "TOP",
    "GO",
    "EXEC",
    "PROCEDURE",
    "TRIGGER",
    "VIEW",
    "TRANSACTION",
    "COMMIT",
    "ROLLBACK",
  ].map((word) => word.toLowerCase()),
]);
const sqlName = (name: string) =>
  /^[_a-z][_a-z0-9]*$/.test(name) && !RESERVED.has(name.toLowerCase())
    ? name
    : quote(name);
const identifier = (token: Token | undefined): token is Token =>
  !!token && (token.kind === "word" || token.kind === "identifier");
const keyword = (token: Token | undefined, text: string) =>
  token?.kind === "word" && token.text.toUpperCase() === text;
const sameScope = (a: number[], b: number[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);
const containsScope = (ancestor: number[], scope: number[]) =>
  ancestor.length <= scope.length &&
  ancestor.every((id, index) => id === scope[index]);

interface Binding {
  alias: string;
  table: TableDefinition;
  scope: number[];
}
function bindings(
  tokens: Token[],
  schema: DatabaseSchema,
  scope: number[],
  dialect: SqlDialect,
): Binding[] {
  const result: Binding[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i];
    if (
      !["FROM", "JOIN", "UPDATE", "INTO"].some((word) => keyword(head, word)) ||
      !containsScope(head.scope, scope)
    )
      continue;
    let cursor = i + 1;
    while (cursor < tokens.length) {
      if (keyword(tokens[cursor], "LATERAL") || keyword(tokens[cursor], "ONLY"))
        cursor++;
      if (
        !identifier(tokens[cursor]) ||
        !sameScope(tokens[cursor].scope, head.scope)
      )
        break;
      let namespace: string | undefined;
      let tableToken = tokens[cursor++];
      let tableName = tableToken.text;
      while (tokens[cursor]?.text === "." && identifier(tokens[cursor + 1])) {
        namespace =
          tableToken.kind === "identifier"
            ? tableName
            : tableName.toLowerCase();
        tableToken = tokens[cursor + 1];
        tableName = tableToken.text;
        cursor += 2;
      }
      const table = schema.tables.find((table) =>
        table.namespace && dialect !== "mssql"
          ? table.name ===
              (tableToken.kind === "identifier"
                ? tableName
                : tableName.toLowerCase()) &&
            (!namespace || table.namespace === namespace)
          : table.name.toLowerCase() === tableName.toLowerCase() &&
            (!namespace ||
              table.namespace?.toLowerCase() === namespace.toLowerCase()),
      );
      if (tokens[cursor]?.text === "(") break;
      if (keyword(tokens[cursor], "AS")) cursor++;
      let alias =
        table?.namespace && tableToken.kind === "word"
          ? tableName.toLowerCase()
          : tableName;
      const next = tokens[cursor];
      if (
        identifier(next) &&
        sameScope(next.scope, head.scope) &&
        (next.kind === "identifier" || !RESERVED.has(next.text.toLowerCase()))
      ) {
        const token = tokens[cursor++];
        alias =
          table?.namespace && token.kind === "word"
            ? token.text.toLowerCase()
            : token.text;
      }
      if (table) result.push({ alias, table, scope: head.scope });
      if (
        tokens[cursor]?.text !== "," ||
        !sameScope(tokens[cursor].scope, head.scope)
      )
        break;
      cursor++;
    }
  }
  const scoped = new Map<string, Binding>();
  for (const binding of result.sort((a, b) => a.scope.length - b.scope.length))
    scoped.set(
      binding.table.namespace ? binding.alias : binding.alias.toLowerCase(),
      binding,
    );
  return [...scoped.values()];
}
export interface SqlSuggestion {
  label: string;
  detail: string;
  description?: string;
  insertText: string;
  kind: "table" | "column" | "keyword" | "function" | "snippet" | "type";
  snippet?: boolean;
  sortText: string;
}
export interface SqlCompletions {
  start: number;
  end: number;
  suggestions: SqlSuggestion[];
}
/** Best-effort editing context only. Never used to execute SQL or mutate the canonical schema. */
export function sqlCompletions(
  sql: string,
  offset: number,
  schema: DatabaseSchema,
  snippets: SqlSnippet[],
  dialect: SqlDialect = "default",
): SqlCompletions {
  offset = Math.max(0, Math.min(offset, sql.length));
  const all = tokenize(sql, dialect === "mssql" ? "mssql" : "default");
  const name = (value: string) =>
    dialect === "mssql"
      ? /^[a-z_][a-z0-9_]*$/i.test(value) &&
        !MSSQL_RESERVED.has(value.toLowerCase())
        ? value
        : `[${value.replaceAll("]", "]]")}]`
      : sqlName(value);
  const blocked = all.some(
    (token) =>
      (token.kind === "comment" || token.kind === "string") &&
      offset > token.start &&
      (offset < token.end || (offset === token.end && !token.closed)),
  );
  const empty: SqlCompletions = { start: offset, end: offset, suggestions: [] };
  if (blocked) return empty;
  let begin = 0,
    end = sql.length;
  for (const token of all) {
    if (token.kind === "symbol" && token.text === ";") {
      if (token.start < offset) begin = token.end;
      else {
        end = token.start;
        break;
      }
    }
  }
  const tokens = all.filter(
    (token) =>
      token.start >= begin && token.start < end && token.kind !== "comment",
  );
  const current = tokens.find(
    (token) =>
      identifier(token) && token.start <= offset && offset <= token.end,
  );
  const start = current?.start ?? offset,
    replaceEnd =
      current?.kind === "identifier" && !current.closed
        ? offset
        : (current?.end ?? offset);
  const prefix = sql
    .slice(start, offset)
    .replace(dialect === "mssql" ? /^\[/ : /^"/, "")
    .replaceAll('""', '"')
    .toLowerCase();
  const before = tokens.filter((token) => token.end <= start);
  const previous = before.at(-1);
  let scope: number[] = [];
  for (const token of tokens) {
    if (token.start >= offset) break;
    scope =
      token.text === "("
        ? (tokens.find((next) => next.start >= token.end)?.scope ?? token.scope)
        : token.scope;
  }
  const refs = bindings(tokens, schema, scope, dialect);
  const opening = [...before]
    .reverse()
    .find(
      (token) =>
        token.text === "(" &&
        token.scope.length === scope.length - 1 &&
        containsScope(token.scope, scope),
    );
  const functionName = opening
    ? before[before.indexOf(opening) - 1]?.text.toUpperCase()
    : "";
  const ddl = before.some(
    (token, index) =>
      ["CREATE", "ALTER"].includes(token.text.toUpperCase()) &&
      keyword(before[index + 1], "TABLE"),
  );
  const tail = before
    .slice(-5)
    .map((token) => token.text.toUpperCase())
    .join(" ");
  const typeContext =
    (previous?.text === ":" && before.at(-2)?.text === ":") ||
    (keyword(previous, "AS") &&
      ["CAST", "TRY_CAST", "SAFE_CAST"].includes(functionName ?? "")) ||
    (previous?.text === "(" &&
      ["CONVERT", "TRY_CONVERT"].includes(functionName ?? "")) ||
    (ddl &&
      identifier(previous) &&
      (["(", ","].includes(before.at(-2)?.text ?? "") ||
        /(?:ADD|COLUMN) [^ ]+$/.test(tail) ||
        keyword(previous, "TYPE"))) ||
    (dialect === "mssql" && /(?:DECLARE|,) @ [^ ]+$/.test(tail));
  const types: SqlSuggestion[] = sqlDataTypes(dialect).map((item) => ({
    label: item.label,
    description: "data type",
    detail:
      item.detail ??
      `${dialect === "mssql" ? "SQL Server" : dialect === "postgres" ? "PostgreSQL" : "DuckDB"} data type`,
    insertText: sql.slice(replaceEnd).trimStart().startsWith("(")
      ? item.label
      : (item.body ?? item.label),
    kind: "type",
    snippet: !!item.body && !sql.slice(replaceEnd).trimStart().startsWith("("),
    sortText: "0_type_" + item.label,
  }));
  if (typeContext)
    return {
      start,
      end: replaceEnd,
      suggestions: types.filter(
        (item) => !prefix || item.label.toLowerCase().startsWith(prefix),
      ),
    };
  let suggestions: SqlSuggestion[] = [];
  const columns = (
    table: TableDefinition,
    qualifier?: string,
  ): SqlSuggestion[] =>
    table.columns.map((column) => ({
      label: column.name,
      description: qualifier ?? table.name,
      detail: `${column.nativeType ?? column.type}${table.primaryKey.includes(column.id) ? " · PK" : ""}${column.nullable ? " · nullable" : ""} — ${table.name}.${column.name}`,
      insertText: (qualifier ? name(qualifier) + "." : "") + name(column.name),
      kind: "column",
      sortText: "1_" + column.name,
    }));
  const tables = (namespace?: string) =>
    schema.tables
      .filter(
        (table) =>
          !namespace ||
          (dialect === "mssql"
            ? table.namespace?.toLowerCase() === namespace.toLowerCase()
            : table.namespace === namespace),
      )
      .map((table) => ({
        label: table.name,
        description: table.namespace ?? "table",
        detail: `${table.columns.length} columns`,
        insertText:
          table.namespace &&
          !(dialect === "mssql" && table.namespace.toLowerCase() === "dbo")
            ? `${name(table.namespace)}.${name(table.name)}`
            : name(table.name),
        kind: "table" as const,
        sortText: "2_" + table.name,
      }));
  const qualifier =
    previous?.text === "." && identifier(before.at(-2))
      ? before.at(-2)!.text
      : undefined;
  if (qualifier) {
    const normalizedQualifier =
      before.at(-2)?.kind === "identifier"
        ? qualifier
        : qualifier.toLowerCase();
    const binding = refs.find((ref) =>
      ref.table.namespace && dialect !== "mssql"
        ? ref.alias === normalizedQualifier
        : ref.alias.toLowerCase() === qualifier.toLowerCase(),
    );
    const table =
      binding?.table ??
      schema.tables.find((table) =>
        table.namespace && dialect !== "mssql"
          ? table.name === normalizedQualifier
          : table.name.toLowerCase() === qualifier.toLowerCase(),
      );
    suggestions = table
      ? columns(table)
      : qualifier.toLowerCase() === "main" ||
          schema.tables.some((table) =>
            dialect === "mssql"
              ? table.namespace?.toLowerCase() ===
                normalizedQualifier.toLowerCase()
              : table.namespace === normalizedQualifier,
          )
        ? tables(
            qualifier.toLowerCase() === "main"
              ? undefined
              : normalizedQualifier,
          ).map((item) => ({ ...item, insertText: name(item.label) }))
        : [];
  } else {
    const tableContext =
      ["FROM", "JOIN", "UPDATE", "INTO"].some((word) =>
        keyword(previous, word),
      ) ||
      (previous?.text === "," &&
        before.some(
          (token) =>
            keyword(token, "FROM") && sameScope(token.scope, previous.scope),
        ) &&
        !before.some(
          (token) =>
            ["WHERE", "GROUP", "ORDER", "HAVING", "SELECT"].some((word) =>
              keyword(token, word),
            ) &&
            token.start >
              Math.max(
                ...before
                  .filter((token) => keyword(token, "FROM"))
                  .map((token) => token.start),
              ),
        ));
    suggestions = tables();
    if (!tableContext) {
      suggestions.push(
        ...(refs.length
          ? refs.flatMap((ref) =>
              columns(ref.table, refs.length > 1 ? ref.alias : undefined),
            )
          : schema.tables.flatMap((table) => columns(table, table.name))),
        ...(dialect === "mssql"
          ? [
              ...KEYWORDS.filter(
                (word) => !["LIMIT", "RETURNING", "QUALIFY"].includes(word),
              ),
              "TOP",
              "FETCH NEXT",
              "ROWS ONLY",
              "GO",
              "BEGIN TRANSACTION",
              "COMMIT",
              "ROLLBACK",
              "DECLARE",
            ]
          : KEYWORDS
        ).map((word) => ({
          label: word,
          detail: "SQL keyword",
          insertText: word,
          kind: "keyword" as const,
          sortText: "4_" + word,
        })),
        ...["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE"].map((name) => ({
          label: name,
          detail: "SQL function",
          insertText: `${name}(\${1:expression})`,
          kind: "function" as const,
          snippet: true,
          sortText: "3_" + name,
        })),
      );
    }
    if (!tableContext && prefix) suggestions.push(...types);
    suggestions.push(
      ...snippets.map((snippet) => ({
        label: snippet.prefix,
        description: "abbreviation",
        detail: snippet.description || "SQL abbreviation",
        insertText: snippet.body,
        kind: "snippet" as const,
        snippet: true,
        sortText: "0_" + snippet.prefix,
      })),
    );
  }
  return {
    start,
    end: replaceEnd,
    suggestions: suggestions.filter(
      (item) => !prefix || item.label.toLowerCase().startsWith(prefix),
    ),
  };
}
