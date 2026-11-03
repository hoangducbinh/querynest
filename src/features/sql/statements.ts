import { tokenize } from "./lexer";

// A blank line is an optional separator between top-level SELECT/WITH queries.
// Other statement types still require semicolons to avoid changing DML/DDL meaning.
export function sqlStatements(sql: string) {
  const statements: { sql: string; start: number }[] = [];
  const tokens = tokenize(sql);
  let start = 0;
  let queryTokens: typeof tokens = [];
  let previous: (typeof tokens)[number] | undefined;
  const emit = (end: number) => {
    const text = sql.slice(start, end);
    if (queryTokens.length) statements.push({ sql: text, start });
    queryTokens = [];
  };
  for (const [tokenIndex, token] of tokens.entries()) {
    if (token.kind === "comment") continue;
    if (token.kind === "symbol" && token.text === ";") {
      emit(token.start);
      start = token.end;
      previous = undefined;
      continue;
    }
    if (
      previous &&
      token.scope.length === 0 &&
      token.kind === "word" &&
      /^(SELECT|WITH)$/i.test(token.text)
    ) {
      if (/^WITH$/i.test(token.text)) {
        const following = tokens
          .slice(tokenIndex + 1)
          .filter((item) => item.kind !== "comment");
        if (following[0]?.text.toUpperCase() === "RECURSIVE") following.shift();
        const name = following[0];
        const afterName = following[1];
        if (
          !name ||
          !["word", "identifier"].includes(name.kind) ||
          (name.kind === "word" && /^ORDINALITY$/i.test(name.text)) ||
          !(afterName?.text.toUpperCase() === "AS" || afterName?.text === "(")
        ) {
          queryTokens.push(token);
          previous = token;
          continue;
        }
      }
      const top = queryTokens.filter((item) => item.scope.length === 0);
      const first = top[0];
      const main =
        first?.text.toUpperCase() === "WITH"
          ? top.find(
              (item, index) =>
                index > 0 &&
                item.kind === "word" &&
                /^(SELECT|INSERT|UPDATE|DELETE|MERGE)$/i.test(item.text),
            )
          : first;
      let lastSelect = -1,
        lastSet = -1;
      top.forEach((item, index) => {
        if (item.kind !== "word") return;
        if (/^SELECT$/i.test(item.text)) lastSelect = index;
        if (/^(UNION|INTERSECT|EXCEPT)$/i.test(item.text)) lastSet = index;
      });
      const gap = sql.slice(previous.end, token.start);
      const blankOutsideComment = [...gap.matchAll(/\r?\n[ \t]*\r?\n/g)].some(
        (match) => {
          const from = previous!.end + match.index!;
          const to = from + match[0].length;
          return !tokens.some(
            (item) =>
              item.kind === "comment" && item.start < to && item.end > from,
          );
        },
      );
      if (
        first?.kind === "word" &&
        /^(SELECT|WITH)$/i.test(first.text) &&
        main?.kind === "word" &&
        /^SELECT$/i.test(main.text) &&
        lastSelect >= 0 &&
        lastSelect > lastSet &&
        top.length > lastSelect + 1 &&
        blankOutsideComment
      ) {
        emit(token.start);
        start = token.start;
      }
    }
    queryTokens.push(token);
    previous = token;
  }
  emit(sql.length);
  return statements;
}

// SQL Server keeps semicolons inside a batch so variables, procedures and transactions work.
// GO is a client-side batch separator, recognized only alone on a line outside quoted text/comments.
export function mssqlBatches(sql: string) {
  const tokens = tokenize(sql, "mssql");
  const result: { sql: string; start: number }[] = [];
  let start = 0;
  for (const token of tokens) {
    if (
      token.kind !== "word" ||
      token.text.toUpperCase() !== "GO" ||
      token.scope.length
    )
      continue;
    const lineStart = sql.lastIndexOf("\n", token.start - 1) + 1;
    const newline = sql.indexOf("\n", token.end);
    const lineEnd = newline < 0 ? sql.length : newline;
    if (
      sql.slice(lineStart, token.start).trim() ||
      !/^(?:[ \t\r]*)(?:--[^\n]*)?$/.test(sql.slice(token.end, lineEnd))
    )
      continue;
    if (
      tokens.some(
        (t) => t.start >= start && t.end <= lineStart && t.kind !== "comment",
      )
    )
      result.push({ sql: sql.slice(start, lineStart), start });
    start = newline < 0 ? sql.length : newline + 1;
  }
  if (tokens.some((t) => t.start >= start && t.kind !== "comment"))
    result.push({ sql: sql.slice(start), start });
  return result;
}

function isCteStart(
  tokens: ReturnType<typeof tokenize>,
  withIndex: number,
): boolean {
  const following = tokens
    .slice(withIndex + 1)
    .filter((item) => item.kind !== "comment");
  if (following[0]?.text.toUpperCase() === "RECURSIVE") following.shift();
  const name = following[0];
  if (
    !name ||
    !["word", "identifier"].includes(name.kind) ||
    (name.kind === "word" &&
      /^(ORDINALITY|TIES|CHECK|NOCHECK|NOLOCK|ROWLOCK|UPDLOCK|HOLDLOCK|READPAST|NOWAIT|TABLOCK|TABLOCKX|PAGLOCK|XLOCK|FORCESEEK|FORCESCAN)$/i.test(
        name.text,
      ))
  ) {
    return false;
  }
  const afterName = following[1];
  if (!afterName) return false;
  if (afterName.text.toUpperCase() === "AS") {
    return following[2]?.text === "(";
  }
  if (afterName.text === "(") {
    const closeIdx = following.findIndex(
      (t, idx) => idx > 1 && t.text === ")" && t.scope.length === name.scope.length,
    );
    return (
      closeIdx > 1 &&
      following[closeIdx + 1]?.text.toUpperCase() === "AS" &&
      following[closeIdx + 2]?.text === "("
    );
  }
  return false;
}

/**
 * Splits a batch (including T-SQL batches with semicolon-less or semicolon-separated statements)
 * into individual statement strings so each result set maps to its own query.
 */
export function batchStatements(
  sql: string,
  dialect: "default" | "mssql" = "default",
): string[] {
  const tokens = tokenize(sql, dialect);
  const statements: string[] = [];
  let start = 0;
  let topTokens: typeof tokens = [];

  const emit = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (topTokens.length && text) statements.push(text);
    topTokens = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "comment") continue;
    if (token.scope.length === 0 && token.kind === "symbol" && token.text === ";") {
      emit(token.start);
      start = token.end;
      continue;
    }

    if (token.scope.length === 0 && token.kind === "word" && topTokens.length > 0) {
      const upper = token.text.toUpperCase();
      const firstUpper = topTokens[0]?.text.toUpperCase() ?? "";
      const prevTop = topTokens.at(-1);
      const prevUpper = prevTop?.kind === "word" ? prevTop.text.toUpperCase() : "";

      if (upper === "SELECT") {
        const isSetContinuation = /^(UNION|INTERSECT|EXCEPT|ALL|DISTINCT|INTO|AS|FOR|RETURN)$/i.test(
          prevUpper,
        );
        const isFirstSelectOfCte =
          firstUpper === "WITH" &&
          !topTokens.some(
            (t, idx) =>
              idx > 0 &&
              t.kind === "word" &&
              /^(SELECT|INSERT|UPDATE|DELETE|MERGE)$/i.test(t.text),
          );
        const isInsertSelect =
          firstUpper === "INSERT" &&
          !topTokens.some(
            (t) =>
              t.kind === "word" &&
              /^(SELECT|VALUES|EXEC|EXECUTE|DEFAULT)$/i.test(t.text),
          );
        if (!isSetContinuation && !isFirstSelectOfCte && !isInsertSelect) {
          emit(token.start);
          start = token.start;
        }
      } else if (upper === "WITH" && isCteStart(tokens, i)) {
        emit(token.start);
        start = token.start;
      } else if (
        (upper === "EXEC" || upper === "EXECUTE") &&
        firstUpper !== "INSERT" &&
        !/^(INSERT|INTO)$/i.test(prevUpper)
      ) {
        emit(token.start);
        start = token.start;
      } else if (
        /^(DECLARE|USE|PRINT|TRUNCATE)$/i.test(upper) &&
        prevTop &&
        sql.slice(prevTop.end, token.start).includes("\n")
      ) {
        emit(token.start);
        start = token.start;
      }
    }

    if (token.scope.length === 0) {
      topTokens.push(token);
    }
  }

  emit(sql.length);
  return statements;
}

export function isResultProducingStatement(
  sql: string,
  dialect: "default" | "mssql" = "default",
): boolean {
  const topWords = tokenize(sql, dialect).filter(
    (t) => t.kind === "word" && t.scope.length === 0,
  );
  if (!topWords.length) return false;
  const first = topWords[0].text.toUpperCase();
  if (
    /^(SELECT|WITH|EXEC|EXECUTE|CALL|VALUES|TABLE|SHOW|DESCRIBE|EXPLAIN|PRAGMA)$/i.test(
      first,
    )
  ) {
    return true;
  }
  if (/^(INSERT|UPDATE|DELETE|MERGE)$/i.test(first)) {
    return topWords.some((w) => /^(OUTPUT|RETURNING)$/i.test(w.text));
  }
  return false;
}

export function resolveBatchResultSqls(
  batchSql: string,
  dialect: "default" | "mssql" = "default",
  setCount: number,
): string[] {
  const trimmed = batchSql.trim();
  if (setCount <= 0) return [];
  const allStmts = batchStatements(batchSql, dialect);
  if (allStmts.length <= 1) {
    return Array.from({ length: setCount }, () => allStmts[0] ?? trimmed);
  }
  const queryStmts = allStmts.filter((s) =>
    isResultProducingStatement(s, dialect),
  );
  if (queryStmts.length === setCount) {
    return queryStmts;
  }
  if (allStmts.length === setCount) {
    return allStmts;
  }
  if (queryStmts.length > 0) {
    return Array.from(
      { length: setCount },
      (_, idx) => queryStmts[idx] ?? allStmts[idx] ?? trimmed,
    );
  }
  return Array.from(
    { length: setCount },
    (_, idx) => allStmts[idx] ?? trimmed,
  );
}

