import type {
  ColumnDefinition,
  DatabaseSchema,
  TableDefinition,
} from "../../types/schema";
import { type SqlDialect } from "./data-types";
import type { Token } from "./lexer";

/** Shared SQL vocabulary and scope analysis used by completions, lint and hover. */

export const KEYWORDS = [
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

export const MSSQL_KEYWORDS = [
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
];

const lower = (words: string[]) => words.map((word) => word.toLowerCase());

export const RESERVED = new Set(
  lower([
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
  ]),
);

export const MSSQL_RESERVED = new Set([
  ...RESERVED,
  ...lower([
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
  ]),
]);

export interface SqlFunction {
  name: string;
  /** Snippet body inserted after the name, without parentheses. */
  args: string;
  signature: string;
  detail: string;
  dialects?: SqlDialect[];
}
const fn = (
  name: string,
  args: string,
  signature: string,
  detail: string,
  dialects?: SqlDialect[],
): SqlFunction => ({ name, args, signature, detail, dialects });
const DUCK_PG: SqlDialect[] = ["default", "postgres"];
const FUNCTIONS: SqlFunction[] = [
  fn(
    "COUNT",
    "${1:expression}",
    "COUNT(* | expression)",
    "Number of rows or non-NULL values",
  ),
  fn("SUM", "${1:expression}", "SUM(expression)", "Sum of non-NULL values"),
  fn("AVG", "${1:expression}", "AVG(expression)", "Average of non-NULL values"),
  fn("MIN", "${1:expression}", "MIN(expression)", "Smallest value"),
  fn("MAX", "${1:expression}", "MAX(expression)", "Largest value"),
  fn(
    "COALESCE",
    "${1:expression}, ${2:fallback}",
    "COALESCE(value, ...)",
    "First non-NULL argument",
  ),
  fn(
    "NULLIF",
    "${1:value}, ${2:other}",
    "NULLIF(value, other)",
    "NULL when both arguments are equal",
  ),
  fn(
    "CAST",
    "${1:expression} AS ${2:type}",
    "CAST(expression AS type)",
    "Convert a value to another type",
  ),
  fn(
    "ROUND",
    "${1:number}, ${2:0}",
    "ROUND(number, digits)",
    "Round to the given precision",
  ),
  fn("ABS", "${1:number}", "ABS(number)", "Absolute value"),
  fn("CEILING", "${1:number}", "CEILING(number)", "Round up to an integer"),
  fn("FLOOR", "${1:number}", "FLOOR(number)", "Round down to an integer"),
  fn("LOWER", "${1:text}", "LOWER(text)", "Lower-case text"),
  fn("UPPER", "${1:text}", "UPPER(text)", "Upper-case text"),
  fn("TRIM", "${1:text}", "TRIM(text)", "Remove surrounding whitespace"),
  fn("LTRIM", "${1:text}", "LTRIM(text)", "Remove leading whitespace"),
  fn("RTRIM", "${1:text}", "RTRIM(text)", "Remove trailing whitespace"),
  fn(
    "SUBSTRING",
    "${1:text}, ${2:start}, ${3:length}",
    "SUBSTRING(text, start, length)",
    "Part of a string",
  ),
  fn(
    "REPLACE",
    "${1:text}, ${2:from}, ${3:to}",
    "REPLACE(text, from, to)",
    "Replace all occurrences",
  ),
  fn("CONCAT", "${1:a}, ${2:b}", "CONCAT(value, ...)", "Concatenate values"),
  fn(
    "CONCAT_WS",
    "${1:', '}, ${2:a}, ${3:b}",
    "CONCAT_WS(separator, value, ...)",
    "Concatenate with separator",
  ),
  fn(
    "STRING_AGG",
    "${1:expression}, ${2:', '}",
    "STRING_AGG(expression, separator)",
    "Aggregate strings",
  ),
  fn("GREATEST", "${1:a}, ${2:b}", "GREATEST(value, ...)", "Largest argument"),
  fn("LEAST", "${1:a}, ${2:b}", "LEAST(value, ...)", "Smallest argument"),
  fn(
    "ROW_NUMBER",
    ") OVER (ORDER BY ${1:column}",
    "ROW_NUMBER() OVER (...)",
    "Sequential row number in a window",
  ),
  fn(
    "RANK",
    ") OVER (ORDER BY ${1:column}",
    "RANK() OVER (...)",
    "Rank with gaps",
  ),
  fn(
    "DENSE_RANK",
    ") OVER (ORDER BY ${1:column}",
    "DENSE_RANK() OVER (...)",
    "Rank without gaps",
  ),
  fn(
    "NTILE",
    "${1:4}) OVER (ORDER BY ${2:column}",
    "NTILE(buckets) OVER (...)",
    "Bucket number",
  ),
  fn(
    "LAG",
    "${1:column}) OVER (ORDER BY ${2:column}",
    "LAG(value [, offset]) OVER (...)",
    "Value from a previous row",
  ),
  fn(
    "LEAD",
    "${1:column}) OVER (ORDER BY ${2:column}",
    "LEAD(value [, offset]) OVER (...)",
    "Value from a following row",
  ),
  fn(
    "FIRST_VALUE",
    "${1:column}) OVER (ORDER BY ${2:column}",
    "FIRST_VALUE(value) OVER (...)",
    "First value in the window",
  ),
  fn(
    "LAST_VALUE",
    "${1:column}) OVER (ORDER BY ${2:column}",
    "LAST_VALUE(value) OVER (...)",
    "Last value in the window",
  ),
  fn("LENGTH", "${1:text}", "LENGTH(text)", "Number of characters", DUCK_PG),
  fn("NOW", "", "NOW()", "Current timestamp", DUCK_PG),
  fn(
    "DATE_TRUNC",
    "'${1:month}', ${2:timestamp}",
    "DATE_TRUNC(unit, timestamp)",
    "Truncate to a date part",
    DUCK_PG,
  ),
  fn(
    "EXTRACT",
    "${1:YEAR} FROM ${2:timestamp}",
    "EXTRACT(field FROM timestamp)",
    "Get a date part",
    DUCK_PG,
  ),
  fn(
    "ARRAY_AGG",
    "${1:expression}",
    "ARRAY_AGG(expression)",
    "Aggregate values into a list",
    DUCK_PG,
  ),
  fn("RANDOM", "", "RANDOM()", "Random number between 0 and 1", DUCK_PG),
  fn(
    "REGEXP_REPLACE",
    "${1:text}, ${2:pattern}, ${3:replacement}",
    "REGEXP_REPLACE(text, pattern, replacement)",
    "Regular-expression replace",
    DUCK_PG,
  ),
  fn(
    "TO_CHAR",
    "${1:value}, '${2:YYYY-MM-DD}'",
    "TO_CHAR(value, format)",
    "Format a value as text",
    ["postgres"],
  ),
  fn(
    "STRFTIME",
    "${1:timestamp}, '${2:%Y-%m-%d}'",
    "STRFTIME(timestamp, format)",
    "Format a timestamp",
    ["default"],
  ),
  fn(
    "DATE_DIFF",
    "'${1:day}', ${2:start}, ${3:end}",
    "DATE_DIFF(part, start, end)",
    "Difference between dates",
    ["default"],
  ),
  fn(
    "REGEXP_MATCHES",
    "${1:text}, ${2:pattern}",
    "REGEXP_MATCHES(text, pattern)",
    "Whether text matches a pattern",
    ["default"],
  ),
  fn(
    "LIST",
    "${1:expression}",
    "LIST(expression)",
    "Aggregate values into a list",
    ["default"],
  ),
  fn("LEN", "${1:text}", "LEN(text)", "Number of characters", ["mssql"]),
  fn("GETDATE", "", "GETDATE()", "Current date and time", ["mssql"]),
  fn(
    "SYSDATETIME",
    "",
    "SYSDATETIME()",
    "Current date and time (high precision)",
    ["mssql"],
  ),
  fn(
    "DATEADD",
    "${1:day}, ${2:1}, ${3:date}",
    "DATEADD(part, number, date)",
    "Add an interval to a date",
    ["mssql"],
  ),
  fn(
    "DATEDIFF",
    "${1:day}, ${2:start}, ${3:end}",
    "DATEDIFF(part, start, end)",
    "Difference between dates",
    ["mssql"],
  ),
  fn(
    "DATEPART",
    "${1:year}, ${2:date}",
    "DATEPART(part, date)",
    "Get a date part",
    ["mssql"],
  ),
  fn(
    "ISNULL",
    "${1:expression}, ${2:fallback}",
    "ISNULL(expression, fallback)",
    "Replace NULL",
    ["mssql"],
  ),
  fn(
    "IIF",
    "${1:condition}, ${2:whenTrue}, ${3:whenFalse}",
    "IIF(condition, true_value, false_value)",
    "Inline IF",
    ["mssql"],
  ),
  fn(
    "CONVERT",
    "${1:type}, ${2:expression}",
    "CONVERT(type, expression [, style])",
    "Convert a value to another type",
    ["mssql"],
  ),
  fn(
    "TRY_CAST",
    "${1:expression} AS ${2:type}",
    "TRY_CAST(expression AS type)",
    "Convert or NULL on failure",
    ["mssql", "default"],
  ),
  fn(
    "FORMAT",
    "${1:value}, '${2:yyyy-MM-dd}'",
    "FORMAT(value, format)",
    "Format a value as text",
    ["mssql"],
  ),
  fn("NEWID", "", "NEWID()", "New uniqueidentifier", ["mssql"]),
  fn(
    "JSON_VALUE",
    "${1:json}, '${2:$.path}'",
    "JSON_VALUE(json, path)",
    "Scalar from JSON",
    ["mssql"],
  ),
  fn(
    "JSON_EXTRACT",
    "${1:json}, '${2:$.path}'",
    "JSON_EXTRACT(json, path)",
    "Value from JSON",
    ["default"],
  ),
];
const functionCache = new Map<SqlDialect, SqlFunction[]>();
export function sqlFunctions(dialect: SqlDialect): SqlFunction[] {
  let list = functionCache.get(dialect);
  if (!list) {
    list = FUNCTIONS.filter((f) => !f.dialects || f.dialects.includes(dialect));
    functionCache.set(dialect, list);
  }
  return list;
}
/** Optimal string alignment distance, abandoning once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, prev2[j - 2] + 1);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Edits tolerated for a word of this length when guessing a typo. */
export const typoBudget = (length: number) =>
  length < 4 ? 0 : length < 7 ? 1 : 2;

/** Closest candidates (case-insensitive) within the typo budget, best first. */
export function didYouMean(
  word: string,
  candidates: Iterable<string>,
  limit = 3,
): string[] {
  const needle = word.toLowerCase();
  const budget = typoBudget(needle.length);
  if (!budget) return [];
  const scored: { value: string; distance: number }[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    const key = value.toLowerCase();
    if (key === needle || seen.has(key)) continue;
    seen.add(key);
    const distance = editDistance(needle, key, budget);
    if (distance <= budget) scored.push({ value, distance });
  }
  return scored
    .sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map((item) => item.value);
}

/** Prefix or in-order subsequence match anchored at the first character. */
export function fuzzyMatch(label: string, prefix: string): boolean {
  if (!prefix) return true;
  const text = label.toLowerCase();
  if (text.startsWith(prefix)) return true;
  if (text[0] !== prefix[0]) return false;
  let index = 0;
  for (const ch of prefix) {
    index = text.indexOf(ch, index);
    if (index === -1) return false;
    index++;
  }
  return true;
}

export const isIdentifier = (token: Token | undefined): token is Token =>
  !!token && (token.kind === "word" || token.kind === "identifier");
export const isKeyword = (token: Token | undefined, text: string) =>
  token?.kind === "word" && token.text.toUpperCase() === text;
export const sameScope = (a: readonly number[], b: readonly number[]) =>
  a === b || (a.length === b.length && a.every((id, index) => id === b[index]));
export const containsScope = (
  ancestor: readonly number[],
  scope: readonly number[],
) =>
  ancestor.length <= scope.length &&
  ancestor.every((id, index) => id === scope[index]);

export interface Binding {
  alias: string;
  table: TableDefinition;
  scope: readonly number[];
}

/** Matches a (possibly qualified) table reference against the schema. */
export function findTable(
  schema: DatabaseSchema,
  tableToken: Token,
  namespace: string | undefined,
  dialect: SqlDialect,
): TableDefinition | undefined {
  const tableName = tableToken.text;
  return schema.tables.find((table) =>
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
}

const TABLE_HEADS = ["FROM", "JOIN", "UPDATE", "INTO"];
export const isTableHead = (token: Token | undefined) =>
  TABLE_HEADS.some((word) => isKeyword(token, word));

export interface TableReference {
  head: Token;
  /** First token of the (possibly qualified) name. */
  first: Token;
  /** Final name token. */
  name: Token;
  namespace?: string;
  alias?: Token;
  /** Index of the token following the reference. */
  next: number;
  /** Followed by "(" — a table function, not a table. */
  call: boolean;
}

/** Table references in FROM/JOIN/UPDATE/INTO lists, with optional aliases. */
export function tableReferences(tokens: Token[]): TableReference[] {
  const refs: TableReference[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i];
    if (!isTableHead(head)) continue;
    let cursor = i + 1;
    while (cursor < tokens.length) {
      if (
        isKeyword(tokens[cursor], "LATERAL") ||
        isKeyword(tokens[cursor], "ONLY")
      )
        cursor++;
      if (
        !isIdentifier(tokens[cursor]) ||
        !sameScope(tokens[cursor].scope, head.scope)
      )
        break;
      const first = tokens[cursor++];
      let name = first;
      let namespace: string | undefined;
      while (tokens[cursor]?.text === "." && isIdentifier(tokens[cursor + 1])) {
        namespace =
          name.kind === "identifier" ? name.text : name.text.toLowerCase();
        name = tokens[cursor + 1];
        cursor += 2;
      }
      const call = tokens[cursor]?.text === "(";
      const ref: TableReference = {
        head,
        first,
        name,
        namespace,
        next: cursor,
        call,
      };
      refs.push(ref);
      if (call) break;
      if (isKeyword(tokens[cursor], "AS")) cursor++;
      const next = tokens[cursor];
      if (
        isIdentifier(next) &&
        sameScope(next.scope, head.scope) &&
        (next.kind === "identifier" || !RESERVED.has(next.text.toLowerCase()))
      ) {
        ref.alias = next;
        cursor++;
      }
      ref.next = cursor;
      if (
        tokens[cursor]?.text !== "," ||
        !sameScope(tokens[cursor].scope, head.scope)
      )
        break;
      cursor++;
    }
  }
  return refs;
}

const cteColumn = (item: Token[]): string | undefined => {
  const last = item.at(-1);
  if (!isIdentifier(last) || item.length === 0) return;
  if (
    item.length === 1 ||
    item.at(-2)?.text === "." ||
    isKeyword(item.at(-2), "AS")
  )
    return last.text;
  // `expression alias` without AS.
  const before = item.at(-2);
  if (
    before &&
    (before.text === ")" || before.kind === "string" || isIdentifier(before))
  )
    return last.text;
};

/**
 * Common table expressions as pseudo tables. Columns come from an explicit
 * column list or the CTE's top-level select list; `open` means unknown (e.g. `*`).
 */
export function cteTables(
  tokens: Token[],
): (TableDefinition & { open: boolean })[] {
  const result: (TableDefinition & { open: boolean })[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isKeyword(tokens[i], "WITH")) continue;
    let cursor = i + 1;
    if (isKeyword(tokens[cursor], "RECURSIVE")) cursor++;
    while (isIdentifier(tokens[cursor])) {
      const nameToken = tokens[cursor++];
      let explicit: string[] | undefined;
      if (tokens[cursor]?.text === "(") {
        const depth = tokens[cursor].scope.length;
        explicit = [];
        cursor++;
        while (
          cursor < tokens.length &&
          !(
            tokens[cursor].text === ")" && tokens[cursor].scope.length === depth
          )
        ) {
          if (isIdentifier(tokens[cursor])) explicit.push(tokens[cursor].text);
          cursor++;
        }
        cursor++;
      }
      if (!isKeyword(tokens[cursor], "AS")) break;
      cursor++;
      if (isKeyword(tokens[cursor], "MATERIALIZED")) cursor++;
      else if (
        isKeyword(tokens[cursor], "NOT") &&
        isKeyword(tokens[cursor + 1], "MATERIALIZED")
      )
        cursor += 2;
      if (tokens[cursor]?.text !== "(") break;
      const open = tokens[cursor];
      const bodyScope = tokens[cursor + 1]?.scope ?? [];
      cursor++;
      const body: Token[] = [];
      while (
        cursor < tokens.length &&
        !(
          tokens[cursor].text === ")" &&
          tokens[cursor].scope.length === open.scope.length
        )
      ) {
        body.push(tokens[cursor++]);
      }
      cursor++;
      let columns = explicit;
      let unknown = false;
      if (!columns) {
        columns = [];
        const top = body.filter((t) => sameScope(t.scope, bodyScope));
        const select = top.findIndex((t) => isKeyword(t, "SELECT"));
        let item: Token[] = [];
        for (let k = select + 1; select >= 0 && k <= top.length; k++) {
          const token = top[k];
          if (
            !token ||
            token.text === "," ||
            isKeyword(token, "FROM") ||
            isKeyword(token, "UNION")
          ) {
            if (item.some((t) => t.text === "*")) unknown = true;
            else {
              const column = cteColumn(item);
              if (column) columns.push(column);
              else if (item.length) unknown = true;
            }
            item = [];
            if (!token || token.text !== ",") break;
            continue;
          }
          if (isKeyword(token, "DISTINCT") && !item.length) continue;
          item.push(token);
        }
        if (select < 0) unknown = true;
      }
      result.push({
        id: `cte:${nameToken.text}`,
        name: nameToken.text,
        columns: columns.map((name, index): ColumnDefinition => ({
          id: `cte:${nameToken.text}:${index}`,
          name,
          type: "",
          nullable: true,
          unique: false,
          defaultValue: "",
        })),
        primaryKey: [],
        position: { x: 0, y: 0 },
        open: unknown,
      });
      if (tokens[cursor]?.text !== ",") break;
      cursor++;
    }
  }
  return result;
}

/** Tables visible from `scope`, keyed by alias, including CTEs. */
export function bindings(
  tokens: Token[],
  schema: DatabaseSchema,
  scope: readonly number[],
  dialect: SqlDialect,
  ctes: TableDefinition[] = cteTables(tokens),
): Binding[] {
  const result: Binding[] = [];
  for (const ref of tableReferences(tokens)) {
    if (ref.call || !containsScope(ref.head.scope, scope)) continue;
    const table =
      (!ref.namespace &&
        ctes.find(
          (cte) => cte.name.toLowerCase() === ref.name.text.toLowerCase(),
        )) ||
      findTable(schema, ref.name, ref.namespace, dialect);
    if (!table) continue;
    const aliasToken = ref.alias ?? ref.name;
    const alias =
      table.namespace && aliasToken.kind === "word"
        ? aliasToken.text.toLowerCase()
        : aliasToken.text;
    result.push({ alias, table, scope: ref.head.scope });
  }
  const scoped = new Map<string, Binding>();
  for (const binding of result.sort((a, b) => a.scope.length - b.scope.length))
    scoped.set(
      binding.table.namespace ? binding.alias : binding.alias.toLowerCase(),
      binding,
    );
  return [...scoped.values()];
}
