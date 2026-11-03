import { tokenize } from "./lexer";
import type { SqlDialect } from "./data-types";
import type { DatabaseSchema } from "../../types/schema";
import type { SqlResult } from "./execution";
// Only a single, full-row SELECT has the original values required by grid-save
// optimistic concurrency checks. Aliases, projections, JOINs and CTEs stay read-only.
function resolveEditableResult(
  result: SqlResult,
  schema: DatabaseSchema,
  dialect: SqlDialect,
) {
  if (result.error || !result.columns.length) return;
  const tokens = tokenize(
    result.sql,
    dialect === "mssql" ? "mssql" : "default",
  ).filter((t) => t.kind !== "comment");
  let i = 0;
  const word = (n: number, value: string) =>
    tokens[n]?.kind === "word" && tokens[n].text.toUpperCase() === value;
  if (!word(i++, "SELECT")) return;
  if (word(i, "TOP")) {
    i++;
    const parens = tokens[i]?.text === "(";
    if (parens) i++;
    const start = i;
    while (/^\d$/.test(tokens[i]?.text ?? "")) i++;
    if (i === start || (parens && tokens[i++]?.text !== ")")) return;
  }
  if (tokens[i++]?.text !== "*" || !word(i++, "FROM")) return;
  const parts: string[] = [];
  for (;;) {
    const token = tokens[i++];
    if (!token || !["word", "identifier"].includes(token.kind) || !token.closed)
      return;
    parts.push(token.text);
    if (tokens[i]?.text !== ".") break;
    i++;
  }
  if (parts.length > 2) return;
  const rest = tokens.slice(i);
  if (
    rest.length &&
    rest[0].text !== ";" &&
    !["WHERE", "ORDER", "LIMIT"].some((w) => word(i, w))
  )
    return;
  if (
    rest.some(
      (t, n) =>
        (t.text === ";" && n !== rest.length - 1) ||
        (t.kind === "word" &&
          /^(SELECT|JOIN|APPLY|UNION|EXCEPT|INTERSECT|INTO|GROUP|HAVING|EXEC|EXECUTE|INSERT|UPDATE|DELETE|MERGE|NEXT|FOR|LOCK)$/i.test(
            t.text,
          )),
    )
  )
    return;
  if (
    rest.some(
      (token, n) =>
        ["word", "identifier"].includes(token.kind) &&
        rest[n + 1]?.text === "(" &&
        token.text.toUpperCase() !== "IN",
    )
  )
    return;
  const candidates = schema.tables.filter(
    (table) =>
      table.name.toLowerCase() === parts.at(-1)!.toLowerCase() &&
      (parts.length === 1 ||
        table.namespace?.toLowerCase() === parts[0].toLowerCase()),
  );
  if (candidates.length !== 1) return;
  const table = candidates[0];
  if (
    table.readOnly ||
    !table.primaryKey.length ||
    table.columns.length !== result.columns.length ||
    table.columns.some((c) => !result.columns.includes(c.name))
  )
    return;
  return table;
}

const cache = new WeakMap<
  SqlResult,
  {
    schema: DatabaseSchema;
    dialect: SqlDialect;
    table: ReturnType<typeof resolveEditableResult>;
  }
>();
export function editableResult(
  result: SqlResult,
  schema: DatabaseSchema,
  dialect: SqlDialect,
) {
  const known = cache.get(result);
  if (known?.schema === schema && known.dialect === dialect) return known.table;
  const table = resolveEditableResult(result, schema, dialect);
  cache.set(result, { schema, dialect, table });
  return table;
}
