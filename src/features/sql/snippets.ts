import type { SqlSnippet } from "../../types/schema";
export const DEFAULT_SNIPPETS: SqlSnippet[] = [
  {
    id: "builtin-select",
    prefix: "sel",
    description: "Select rows",
    body: "SELECT ${1:*}\nFROM ${2:table};",
  },
  {
    id: "builtin-count",
    prefix: "cnt",
    description: "Count rows",
    body: "SELECT COUNT(*) AS ${1:count}\nFROM ${2:table};",
  },
  {
    id: "builtin-join",
    prefix: "jn",
    description: "Join a table",
    body: "JOIN ${1:table} ${2:t} ON ${3:left_id} = ${4:right_id}",
  },
];
export function validateSnippets(value: unknown): string[] {
  if (!Array.isArray(value)) return ["SQL abbreviations must be a list."];
  const ids = new Set<string>(),
    prefixes = new Set<string>(),
    errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") {
      errors.push(`Abbreviation ${index + 1} is invalid.`);
      continue;
    }
    const snippet = item as Partial<SqlSnippet>;
    if (typeof snippet.id !== "string" || !snippet.id || ids.has(snippet.id))
      errors.push("Abbreviation IDs must be unique.");
    if (typeof snippet.id === "string") ids.add(snippet.id);
    if (
      typeof snippet.prefix !== "string" ||
      !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(snippet.prefix)
    )
      errors.push(
        `Abbreviation ${index + 1}: use a prefix starting with a letter or underscore, without spaces.`,
      );
    else {
      const key = snippet.prefix.toLowerCase();
      if (prefixes.has(key))
        errors.push(`The prefix "${snippet.prefix}" is already used.`);
      prefixes.add(key);
    }
    if (typeof snippet.body !== "string" || !snippet.body.trim())
      errors.push(`Abbreviation ${index + 1}: enter a SQL expansion.`);
    if (typeof snippet.description !== "string")
      errors.push(`Abbreviation ${index + 1}: invalid description.`);
  }
  return [...new Set(errors)];
}
