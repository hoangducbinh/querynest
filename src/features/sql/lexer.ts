export interface Token {
  kind: "word" | "identifier" | "string" | "comment" | "symbol";
  text: string;
  start: number;
  end: number;
  scope: number[];
  closed: boolean;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const scope: number[] = [];
  let group = 0,
    i = 0;
  const push = (
    kind: Token["kind"],
    start: number,
    text: string,
    closed = true,
  ) => tokens.push({ kind, start, end: i, text, scope: [...scope], closed });
  while (i < sql.length) {
    const start = i,
      c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      push("comment", start, sql.slice(start, i), false);
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      let nesting = 1;
      while (i < sql.length && nesting) {
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
    if (c === "'" || c === '"') {
      const delimiter = c;
      let text = "",
        closed = false;
      i++;
      const escapedString =
        delimiter === "'" &&
        /e/i.test(sql[start - 1] ?? "") &&
        (start < 2 || !/[_a-zA-Z0-9$]/.test(sql[start - 2]));
      while (i < sql.length) {
        if (escapedString && sql[i] === "\\") {
          text += sql.slice(i, i + 2);
          i = Math.min(sql.length, i + 2);
        } else if (sql[i] === delimiter) {
          if (sql[i + 1] === delimiter) {
            text += delimiter;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else text += sql[i++];
      }
      push(c === '"' ? "identifier" : "string", start, text, closed);
      continue;
    }
    if (c === "$") {
      const match = /^\$(?:[_a-zA-Z][_a-zA-Z0-9]*)?\$/.exec(sql.slice(i));
      if (match) {
        const delimiter = match[0];
        i += delimiter.length;
        const end = sql.indexOf(delimiter, i);
        i = end === -1 ? sql.length : end + delimiter.length;
        push("string", start, sql.slice(start, i), end !== -1);
        continue;
      }
    }
    if (/[_a-zA-Z\u0080-\uffff]/.test(c)) {
      i++;
      while (i < sql.length && /[_a-zA-Z0-9$\u0080-\uffff]/.test(sql[i])) i++;
      push("word", start, sql.slice(start, i));
      continue;
    }
    i++;
    if (c === ")") scope.pop();
    push("symbol", start, c);
    if (c === "(") scope.push(++group);
  }
  return tokens;
}
