import type {
  DatabaseSchema,
  SqlSnippet,
  TableDefinition,
} from "../../types/schema";
import { sqlDataTypes, type SqlDialect } from "./data-types";
import { quote } from "../../lib/sql/identifiers";
import { tokenize } from "./lexer";
import {
  KEYWORDS,
  MSSQL_KEYWORDS,
  RESERVED,
  MSSQL_RESERVED,
  isIdentifier as identifier,
  isKeyword as keyword,
  sameScope,
  containsScope,
  bindings,
  cteTables,
  sqlFunctions,
  fuzzyMatch,
} from "./language";
const sqlName = (name: string) =>
  /^[_a-z][_a-z0-9]*$/.test(name) && !RESERVED.has(name.toLowerCase())
    ? name
    : quote(name);
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
  let scope: readonly number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.start >= offset) break;
    scope =
      token.text === "("
        ? (tokens[index + 1]?.scope ?? token.scope)
        : token.scope;
  }
  const ctes = cteTables(tokens);
  const refs = bindings(tokens, schema, scope, dialect, ctes);
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
      `${dialect === "mssql" ? "SQL Server" : dialect === "postgres" ? "PostgreSQL" : "SQL"} data type`,
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
        (item) => !prefix || fuzzyMatch(item.label, prefix),
      ),
    };
  let suggestions: SqlSuggestion[] = [];
  const columns = (
    table: TableDefinition,
    qualifier?: string,
  ): SqlSuggestion[] =>
    table.columns
      .filter((column) => !prefix || fuzzyMatch(column.name, prefix))
      .map((column) => ({
        label: column.name,
        description: qualifier ?? table.name,
        detail: `${column.nativeType ?? column.type}${table.primaryKey.includes(column.id) ? " · PK" : ""}${column.nullable ? " · nullable" : ""} — ${table.name}.${column.name}`,
        insertText:
          (qualifier ? name(qualifier) + "." : "") + name(column.name),
        kind: "column",
        sortText: "1_" + column.name,
      }));
  const tables = (namespace?: string) =>
    [...ctes, ...schema.tables]
      .filter(
        (table) =>
          (!prefix || fuzzyMatch(table.name, prefix)) &&
          (!namespace ||
            (dialect === "mssql"
              ? table.namespace?.toLowerCase() === namespace.toLowerCase()
              : table.namespace === namespace)),
      )
      .slice(0, 500)
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
          : schema.tables.length <= 200
            ? schema.tables.flatMap((table) => columns(table, table.name))
            : []),
        ...(dialect === "mssql" ? MSSQL_KEYWORDS : KEYWORDS).map((word) => ({
          label: word,
          detail: "SQL keyword",
          insertText: word,
          kind: "keyword" as const,
          sortText: "4_" + word,
        })),
        ...sqlFunctions(dialect).map((fn) => ({
          label: fn.name,
          detail: `${fn.signature} — ${fn.detail}`,
          insertText: `${fn.name}(${fn.args})`,
          kind: "function" as const,
          snippet: true,
          sortText: "3_" + fn.name,
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
    suggestions: suggestions
      .filter((item) => !prefix || fuzzyMatch(item.label, prefix))
      .slice(0, 500),
  };
}
