export interface Token {
  kind: "word" | "identifier" | "string" | "comment" | "symbol";
  text: string;
  start: number;
  end: number;
  /** Parenthesis group ids enclosing the token. Shared between tokens; treat as read-only. */
  scope: readonly number[];
  closed: boolean;
}

const SPACE = /\s/;
const DOLLAR_TAG = /\$(?:[_a-zA-Z][_a-zA-Z0-9]*)?\$/y;

const isWordStart = (code: number) =>
  code === 95 || // _
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code >= 0x80;
const isWordPart = (code: number) =>
  isWordStart(code) || (code >= 48 && code <= 57) || code === 36; // 0-9 $
const isSpace = (code: number) =>
  code === 32 ||
  (code >= 9 && code <= 13) ||
  (code > 127 && SPACE.test(String.fromCharCode(code)));

/** Tokens for the last few inputs; editor features (completions, lint, hover) re-tokenize the same text. */
const cache = new Map<string, Token[]>();
const CACHE_SIZE = 4;

export function tokenize(
  sql: string,
  dialect: "default" | "mssql" = "default",
): Token[] {
  const key = dialect + "\u0000" + sql;
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tokens = scan(sql, dialect);
  cache.set(key, tokens);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return tokens;
}

function scan(sql: string, dialect: "default" | "mssql"): Token[] {
  const tokens: Token[] = [];
  const stack: number[] = [];
  // Snapshot reused by every token until the parenthesis depth changes.
  let scope: readonly number[] = [];
  let group = 0,
    i = 0;
  const length = sql.length;
  const push = (
    kind: Token["kind"],
    start: number,
    text: string,
    closed = true,
  ) => tokens.push({ kind, start, end: i, text, scope, closed });
  while (i < length) {
    const start = i,
      code = sql.charCodeAt(i),
      c = sql[i];
    if (isSpace(code)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i + 2);
      i = newline === -1 ? length : newline;
      push("comment", start, sql.slice(start, i), false);
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      let nesting = 1;
      while (i < length && nesting) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          nesting++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          nesting--;
          i += 2;
        } else i++;
      }
      push("comment", start, sql.slice(start, i), nesting === 0);
      continue;
    }
    if (c === "[" && dialect === "mssql") {
      let text = "",
        closed = false;
      i++;
      while (i < length) {
        const close = sql.indexOf("]", i);
        if (close === -1) {
          text += sql.slice(i);
          i = length;
          break;
        }
        text += sql.slice(i, close);
        if (sql[close + 1] === "]") {
          text += "]";
          i = close + 2;
        } else {
          i = close + 1;
          closed = true;
          break;
        }
      }
      push("identifier", start, text, closed);
      continue;
    }
    if (c === "'" || c === '"') {
      const delimiter = c;
      let text = "",
        closed = false;
      i++;
      const escapedString =
        delimiter === "'" &&
        /e/i.test(sql[start - 1] ?? "") &&
        (start < 2 || !isWordPart(sql.charCodeAt(start - 2)));
      while (i < length) {
        if (escapedString && sql[i] === "\\") {
          text += sql.slice(i, i + 2);
          i = Math.min(length, i + 2);
        } else if (sql[i] === delimiter) {
          if (sql[i + 1] === delimiter) {
            text += delimiter;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          // Copy the run of ordinary characters in one slice.
          let next = sql.indexOf(delimiter, i);
          if (next === -1) next = length;
          if (escapedString) {
            const slash = sql.indexOf("\\", i);
            if (slash !== -1 && slash < next) next = slash;
          }
          text += sql.slice(i, next);
          i = next;
        }
      }
      push(c === '"' ? "identifier" : "string", start, text, closed);
      continue;
    }
    if (c === "$") {
      DOLLAR_TAG.lastIndex = i;
      const match = DOLLAR_TAG.exec(sql);
      if (match) {
        const delimiter = match[0];
        i += delimiter.length;
        const end = sql.indexOf(delimiter, i);
        i = end === -1 ? length : end + delimiter.length;
        push("string", start, sql.slice(start, i), end !== -1);
        continue;
      }
    }
    if (isWordStart(code)) {
      i++;
      while (i < length && isWordPart(sql.charCodeAt(i))) i++;
      push("word", start, sql.slice(start, i));
      continue;
    }
    i++;
    if (c === ")" && stack.length) {
      stack.pop();
      scope = stack.slice();
    }
    push("symbol", start, c);
    if (c === "(") {
      stack.push(++group);
      scope = stack.slice();
    }
  }
  return tokens;
}
