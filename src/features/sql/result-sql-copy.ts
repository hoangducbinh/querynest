import type {
  ColumnDefinition,
  DatabaseSchema,
  TableDefinition,
} from "../../types/schema";
import type { SqlDialect } from "./data-types";
import { tokenize } from "./lexer";

export interface ResultTableTarget {
  namespace?: string;
  tableName: string;
  table?: TableDefinition;
}

export function quoteSqlIdentifier(
  name: string,
  dialect: SqlDialect = "default",
): string {
  if (dialect === "mssql") {
    return `[${name.replaceAll("]", "]]")}]`;
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function formatSqlTableRef(
  target: { namespace?: string; tableName: string },
  dialect: SqlDialect = "default",
): string {
  const tablePart = quoteSqlIdentifier(target.tableName, dialect);
  return target.namespace
    ? `${quoteSqlIdentifier(target.namespace, dialect)}.${tablePart}`
    : tablePart;
}

type NonCommentToken = ReturnType<typeof tokenize>[number];

function readTableParts(
  tokens: NonCommentToken[],
  startCursor: number,
): { parts: string[]; nextCursor: number } {
  const parts: string[] = [];
  let cursor = startCursor;
  while (cursor < tokens.length) {
    const part = tokens[cursor];
    if (!part || !["word", "identifier"].includes(part.kind) || !part.closed) {
      break;
    }
    parts.push(part.text);
    if (tokens[cursor + 1]?.text !== ".") {
      cursor++;
      break;
    }
    if (tokens[cursor + 2]?.text === ".") {
      // SQL Server db..table default schema syntax
      cursor += 3;
    } else {
      cursor += 2;
    }
  }
  return { parts, nextCursor: cursor };
}

function readOptionalAlias(
  tokens: NonCommentToken[],
  cursor: number,
): string | undefined {
  let idx = cursor;
  if (
    tokens[idx]?.kind === "word" &&
    tokens[idx].text.toUpperCase() === "AS"
  ) {
    idx++;
  }
  const candidate = tokens[idx];
  if (!candidate || !["word", "identifier"].includes(candidate.kind)) {
    return undefined;
  }
  if (
    candidate.kind === "word" &&
    /^(WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|ON|USING|GROUP|ORDER|LIMIT|OFFSET|HAVING|UNION|INTERSECT|EXCEPT|WINDOW|FOR|OPTION|WITH|SET|VALUES|OUTPUT|RETURNING)$/i.test(
      candidate.text,
    )
  ) {
    return undefined;
  }
  return candidate.text;
}

function findMatchingCloseParen(
  tokens: NonCommentToken[],
  openIdx: number,
): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].text === "(") depth++;
    else if (tokens[i].text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function inferFromTokens(
  tokens: NonCommentToken[],
  schema: DatabaseSchema | undefined,
  cteMap: Map<string, NonCommentToken[]>,
  visitedCtes: Set<string>,
): ResultTableTarget | undefined {
  if (!tokens.length) return undefined;

  let cursor = 0;
  // Parse leading WITH CTE definitions at depth 0
  if (
    tokens[0]?.kind === "word" &&
    tokens[0].text.toUpperCase() === "WITH"
  ) {
    cursor = 1;
    if (
      tokens[cursor]?.kind === "word" &&
      tokens[cursor].text.toUpperCase() === "RECURSIVE"
    ) {
      cursor++;
    }
    while (cursor < tokens.length) {
      const cteNameTok = tokens[cursor];
      if (
        !cteNameTok ||
        !["word", "identifier"].includes(cteNameTok.kind)
      ) {
        break;
      }
      const cteName = cteNameTok.text.toLowerCase();
      cursor++;
      if (tokens[cursor]?.text === "(") {
        const closeCols = findMatchingCloseParen(tokens, cursor);
        if (closeCols < 0) break;
        cursor = closeCols + 1;
      }
      if (
        tokens[cursor]?.kind !== "word" ||
        tokens[cursor].text.toUpperCase() !== "AS" ||
        tokens[cursor + 1]?.text !== "("
      ) {
        break;
      }
      const openBody = cursor + 1;
      const closeBody = findMatchingCloseParen(tokens, openBody);
      if (closeBody < 0) break;
      cteMap.set(cteName, tokens.slice(openBody + 1, closeBody));
      cursor = closeBody + 1;
      if (tokens[cursor]?.text === ",") {
        cursor++;
        continue;
      }
      break;
    }
  }

  const bodyTokens = tokens.slice(cursor);
  if (!bodyTokens.length) return undefined;

  // Handle INSERT INTO <table> or UPDATE <table>
  const firstWord =
    bodyTokens[0]?.kind === "word" ? bodyTokens[0].text.toUpperCase() : "";
  if (firstWord === "INSERT") {
    const startIdx =
      bodyTokens[1]?.kind === "word" &&
      bodyTokens[1].text.toUpperCase() === "INTO"
        ? 2
        : 1;
    const { parts } = readTableParts(bodyTokens, startIdx);
    if (parts.length >= 1 && parts.length <= 4) {
      return resolvePartsToTarget(parts, schema);
    }
  } else if (firstWord === "UPDATE") {
    const { parts } = readTableParts(bodyTokens, 1);
    if (parts.length >= 1 && parts.length <= 4) {
      return resolvePartsToTarget(parts, schema);
    }
  }

  // Check if SELECT starts with <alias>.* (e.g. SELECT b.* FROM TableA a JOIN TableB b)
  let starPrefix: string | undefined;
  if (firstWord === "SELECT") {
    let selIdx = 1;
    if (
      bodyTokens[selIdx]?.kind === "word" &&
      /^(DISTINCT|ALL)$/i.test(bodyTokens[selIdx].text)
    ) {
      selIdx++;
    }
    if (
      bodyTokens[selIdx]?.kind === "word" &&
      bodyTokens[selIdx].text.toUpperCase() === "TOP"
    ) {
      selIdx++;
      if (bodyTokens[selIdx]?.text === "(") {
        const closeTop = findMatchingCloseParen(bodyTokens, selIdx);
        selIdx = closeTop >= 0 ? closeTop + 1 : selIdx + 1;
      } else {
        selIdx++;
      }
    }
    if (
      bodyTokens[selIdx] &&
      ["word", "identifier"].includes(bodyTokens[selIdx].kind) &&
      bodyTokens[selIdx + 1]?.text === "." &&
      bodyTokens[selIdx + 2]?.text === "*"
    ) {
      starPrefix = bodyTokens[selIdx].text.toLowerCase();
    }
  }

  const tableCandidates: {
    parts: string[];
    alias?: string;
    subqueryTokens?: NonCommentToken[];
  }[] = [];

  let depth = 0;
  for (let i = 0; i < bodyTokens.length; i++) {
    const token = bodyTokens[i];
    if (token.text === "(") {
      depth++;
      continue;
    }
    if (token.text === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || token.kind !== "word") continue;

    const upper = token.text.toUpperCase();
    const prevWord =
      bodyTokens[i - 1]?.kind === "word"
        ? bodyTokens[i - 1].text.toUpperCase()
        : "";

    if (upper === "FROM" && prevWord !== "DISTINCT") {
      if (bodyTokens[i + 1]?.text === "(") {
        const closeSub = findMatchingCloseParen(bodyTokens, i + 1);
        if (closeSub > i + 1) {
          const alias = readOptionalAlias(bodyTokens, closeSub + 1);
          tableCandidates.push({
            parts: [],
            alias,
            subqueryTokens: bodyTokens.slice(i + 2, closeSub),
          });
        }
        continue;
      }
      const { parts, nextCursor } = readTableParts(bodyTokens, i + 1);
      if (parts.length >= 1 && parts.length <= 4) {
        const alias = readOptionalAlias(bodyTokens, nextCursor);
        tableCandidates.push({ parts, alias });
      }
    } else if (upper === "JOIN") {
      const { parts, nextCursor } = readTableParts(bodyTokens, i + 1);
      if (parts.length >= 1 && parts.length <= 4) {
        const alias = readOptionalAlias(bodyTokens, nextCursor);
        tableCandidates.push({ parts, alias });
      }
    }
  }

  if (starPrefix && tableCandidates.length > 1) {
    const matchedByAlias = tableCandidates.find(
      (c) =>
        c.alias?.toLowerCase() === starPrefix ||
        c.parts.at(-1)?.toLowerCase() === starPrefix,
    );
    if (matchedByAlias && matchedByAlias.parts.length >= 1) {
      return resolveCandidate(
        matchedByAlias.parts,
        schema,
        cteMap,
        visitedCtes,
      );
    }
  }

  for (const candidate of tableCandidates) {
    if (candidate.subqueryTokens) {
      const subTarget = inferFromTokens(
        candidate.subqueryTokens,
        schema,
        cteMap,
        visitedCtes,
      );
      if (subTarget?.tableName) return subTarget;
      continue;
    }
    if (candidate.parts.length >= 1) {
      const resolved = resolveCandidate(
        candidate.parts,
        schema,
        cteMap,
        visitedCtes,
      );
      if (resolved) return resolved;
    }
  }

  return undefined;
}

function resolveCandidate(
  parts: string[],
  schema: DatabaseSchema | undefined,
  cteMap: Map<string, NonCommentToken[]>,
  visitedCtes: Set<string>,
): ResultTableTarget | undefined {
  if (parts.length === 1) {
    const lower = parts[0].toLowerCase();
    if (cteMap.has(lower)) {
      if (visitedCtes.has(lower)) return undefined;
      visitedCtes.add(lower);
      return inferFromTokens(cteMap.get(lower)!, schema, cteMap, visitedCtes);
    }
  }
  return resolvePartsToTarget(parts, schema);
}

function resolvePartsToTarget(
  parts: string[],
  schema: DatabaseSchema | undefined,
): ResultTableTarget {
  const tableName = parts.at(-1)!;
  const namespace = parts.length >= 2 ? parts.at(-2) : undefined;
  const matched = findMatchingTable(schema, tableName, namespace);
  if (matched) {
    return {
      namespace: matched.namespace ?? namespace,
      tableName: matched.name,
      table: matched,
    };
  }
  return { namespace, tableName };
}

export function inferResultTableTarget(
  sql: string,
  schema?: DatabaseSchema,
  dialect: SqlDialect = "default",
  fallbackTable = "table_name",
): ResultTableTarget {
  const tokens = tokenize(
    sql ?? "",
    dialect === "mssql" ? "mssql" : "default",
  ).filter((t) => t.kind !== "comment");

  const resolved = inferFromTokens(
    tokens,
    schema,
    new Map(),
    new Set(),
  );
  return resolved ?? { tableName: fallbackTable };
}

function findMatchingTable(
  schema: DatabaseSchema | undefined,
  tableName: string,
  namespace?: string,
): TableDefinition | undefined {
  if (!schema) return undefined;
  const exact = schema.tables.filter(
    (table) =>
      table.name.toLowerCase() === tableName.toLowerCase() &&
      (!namespace || table.namespace?.toLowerCase() === namespace.toLowerCase()),
  );
  if (exact.length === 1) return exact[0];
  if (namespace) {
    const byNameOnly = schema.tables.filter(
      (table) =>
        !table.namespace &&
        table.name.toLowerCase() === tableName.toLowerCase(),
    );
    if (byNameOnly.length === 1) return byNameOnly[0];
  }
  return undefined;
}

export function formatSqlLiteral(
  value: unknown,
  dialect: SqlDialect = "default",
  column?: ColumnDefinition,
): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return dialect === "mssql"
      ? value
        ? "1"
        : "0"
      : value
        ? "TRUE"
        : "FALSE";
  }
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
  }
  const text = String(value);
  if (column) {
    const trimmed = text.trim();
    const upperType = column.type.toUpperCase();
    if (
      (upperType === "INTEGER" ||
        upperType === "BIGINT" ||
        upperType === "DOUBLE" ||
        upperType.startsWith("DECIMAL") ||
        upperType.startsWith("NUMERIC")) &&
      /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)
    ) {
      return trimmed;
    }
    if (upperType === "BOOLEAN" && /^(true|false|1|0)$/i.test(trimmed)) {
      const boolVal = /^(true|1)$/i.test(trimmed);
      return dialect === "mssql"
        ? boolVal
          ? "1"
          : "0"
        : boolVal
          ? "TRUE"
          : "FALSE";
    }
  }
  return `'${text.replaceAll("'", "''")}'`;
}

export function resolveWhereColumns(
  columns: string[],
  table?: TableDefinition,
): string[] {
  if (!columns.length) return [];
  if (table && table.primaryKey.length > 0) {
    const pkNames = table.primaryKey
      .map((pkId) => table.columns.find((c) => c.id === pkId)?.name)
      .filter((name): name is string => !!name && columns.includes(name));
    if (pkNames.length > 0) return pkNames;
  }
  const idCol = columns.find((col) => col.toLowerCase() === "id");
  if (idCol) return [idCol];
  return [columns[0]];
}

export function buildCopyAsInsert(options: {
  columns: string[];
  rows: Record<string, unknown>[];
  sql?: string;
  schema?: DatabaseSchema;
  table?: TableDefinition;
  dialect?: SqlDialect;
}): string {
  const {
    columns,
    rows,
    sql = "",
    schema,
    table,
    dialect = "default",
  } = options;
  if (!columns.length || !rows.length) return "";
  const inferred = inferResultTableTarget(sql, schema, dialect);
  const resolvedTable = table ?? inferred.table;
  const tableRef = formatSqlTableRef(
    resolvedTable
      ? { namespace: resolvedTable.namespace, tableName: resolvedTable.name }
      : inferred,
    dialect,
  );
  const colList = columns
    .map((col) => quoteSqlIdentifier(col, dialect))
    .join(", ");
  const colDefs = new Map(
    (resolvedTable?.columns ?? []).map((col) => [col.name, col]),
  );

  return rows
    .map((row) => {
      const values = columns
        .map((col) => formatSqlLiteral(row[col], dialect, colDefs.get(col)))
        .join(", ");
      return `INSERT INTO ${tableRef} (${colList}) VALUES (${values});`;
    })
    .join("\n");
}

export function buildCopyAsUpdate(options: {
  columns: string[];
  rows: {
    current: Record<string, unknown>;
    original?: Record<string, unknown>;
  }[];
  sql?: string;
  schema?: DatabaseSchema;
  table?: TableDefinition;
  dialect?: SqlDialect;
}): string {
  const {
    columns,
    rows,
    sql = "",
    schema,
    table,
    dialect = "default",
  } = options;
  if (!columns.length || !rows.length) return "";
  const inferred = inferResultTableTarget(sql, schema, dialect);
  const resolvedTable = table ?? inferred.table;
  const tableRef = formatSqlTableRef(
    resolvedTable
      ? { namespace: resolvedTable.namespace, tableName: resolvedTable.name }
      : inferred,
    dialect,
  );
  const whereColumns = resolveWhereColumns(columns, resolvedTable);
  const whereSet = new Set(whereColumns);
  const nonKeyColumns = columns.filter((col) => !whereSet.has(col));
  const defaultSetColumns = nonKeyColumns.length > 0 ? nonKeyColumns : columns;
  const colDefs = new Map(
    (resolvedTable?.columns ?? []).map((col) => [col.name, col]),
  );

  return rows
    .map(({ current, original }) => {
      const changedColumns = original
        ? columns.filter((col) => !Object.is(current[col], original[col]))
        : [];
      const setColumns =
        changedColumns.length > 0 ? changedColumns : defaultSetColumns;
      const setClause = setColumns
        .map(
          (col) =>
            `${quoteSqlIdentifier(col, dialect)} = ${formatSqlLiteral(current[col], dialect, colDefs.get(col))}`,
        )
        .join(", ");
      const whereSource = original ?? current;
      const whereClause = whereColumns
        .map((col) => {
          const val = whereSource[col];
          if (val === null || val === undefined) {
            return `${quoteSqlIdentifier(col, dialect)} IS NULL`;
          }
          return `${quoteSqlIdentifier(col, dialect)} = ${formatSqlLiteral(val, dialect, colDefs.get(col))}`;
        })
        .join(" AND ");
      return `UPDATE ${tableRef} SET ${setClause} WHERE ${whereClause};`;
    })
    .join("\n");
}

export function buildCopyAsTsv(
  columns: string[],
  rows: Record<string, unknown>[],
  includeHeader = true,
): string {
  const formatCell = (val: unknown) => {
    if (val === null || val === undefined) return "NULL";
    const text = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (/[\t\r\n"]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };
  const lines = rows.map((row) =>
    columns.map((col) => formatCell(row[col])).join("\t"),
  );
  return includeHeader ? [columns.join("\t"), ...lines].join("\n") : lines.join("\n");
}

export function buildCopyAsCsv(
  columns: string[],
  rows: Record<string, unknown>[],
  includeHeader = true,
): string {
  const formatCsvCell = (val: unknown) => {
    if (val === null || val === undefined) return "";
    const text = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };
  const header = columns.map((col) => formatCsvCell(col)).join(",");
  const lines = rows.map((row) =>
    columns.map((col) => formatCsvCell(row[col])).join(","),
  );
  return includeHeader ? [header, ...lines].join("\n") : lines.join("\n");
}


