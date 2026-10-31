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
