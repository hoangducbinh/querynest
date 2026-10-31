import type {
  DatabaseSchema,
  SqlSnippet,
  TableDefinition,
} from "../../types/schema";
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
const sqlName = (name: string) =>
  /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name) && !RESERVED.has(name.toLowerCase())
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
      let tableName = tokens[cursor++].text;
      while (tokens[cursor]?.text === "." && identifier(tokens[cursor + 1])) {
        tableName = tokens[cursor + 1].text;
        cursor += 2;
      }
      const table = schema.tables.find(
        (table) => table.name.toLowerCase() === tableName.toLowerCase(),
      );
      if (tokens[cursor]?.text === "(") break;
      if (keyword(tokens[cursor], "AS")) cursor++;
      let alias = tableName;
      const next = tokens[cursor];
      if (
        identifier(next) &&
        sameScope(next.scope, head.scope) &&
        (next.kind === "identifier" || !RESERVED.has(next.text.toLowerCase()))
      )
        alias = tokens[cursor++].text;
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
    scoped.set(binding.alias.toLowerCase(), binding);
  return [...scoped.values()];
}
export interface SqlSuggestion {
  label: string;
  detail: string;
  description?: string;
  insertText: string;
  kind: "table" | "column" | "keyword" | "function" | "snippet";
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
): SqlCompletions {
  offset = Math.max(0, Math.min(offset, sql.length));
  const all = tokenize(sql);
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
    .replace(/^"/, "")
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
  const refs = bindings(tokens, schema, scope);
  let suggestions: SqlSuggestion[] = [];
  const columns = (
    table: TableDefinition,
    qualifier?: string,
  ): SqlSuggestion[] =>
    table.columns.map((column) => ({
      label: column.name,
      description: qualifier ?? table.name,
      detail: `${column.type}${table.primaryKey.includes(column.id) ? " · PK" : ""}${column.nullable ? " · nullable" : ""} — ${table.name}.${column.name}`,
      insertText:
        (qualifier ? sqlName(qualifier) + "." : "") + sqlName(column.name),
      kind: "column",
      sortText: "1_" + column.name,
    }));
  const tables = () =>
    schema.tables.map((table) => ({
      label: table.name,
      description: "table",
      detail: `${table.columns.length} columns`,
      insertText: sqlName(table.name),
      kind: "table" as const,
      sortText: "2_" + table.name,
    }));
  const qualifier =
    previous?.text === "." && identifier(before.at(-2))
      ? before.at(-2)!.text
      : undefined;
  if (qualifier) {
    const binding = refs.find(
      (ref) => ref.alias.toLowerCase() === qualifier.toLowerCase(),
    );
    const table =
      binding?.table ??
      schema.tables.find(
        (table) => table.name.toLowerCase() === qualifier.toLowerCase(),
      );
    suggestions = table
      ? columns(table)
      : qualifier.toLowerCase() === "main"
        ? tables()
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
        ...KEYWORDS.map((word) => ({
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
