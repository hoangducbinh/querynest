import { duckTypeSQL, parseDuckType } from "../duckdb/types";
import type { DatabaseSchema, TableDefinition } from "../../types/schema";
import { validateSchema } from "../../features/schema/core";
export const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function orderedTables(s: DatabaseSchema): TableDefinition[] {
  const result: TableDefinition[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(t: TableDefinition) {
    if (done.has(t.id)) return;
    if (visiting.has(t.id))
      throw Error(
        "Cyclic physical foreign keys are unsupported. Use logical relationships to break the cycle.",
      );
    visiting.add(t.id);
    s.relationships
      .filter((r) => r.kind === "physical" && r.sourceTable === t.id)
      .forEach((r) => visit(s.tables.find((x) => x.id === r.targetTable)!));
    visiting.delete(t.id);
    done.add(t.id);
    result.push(t);
  }
  s.tables.forEach(visit);
  return result;
}
export function generateDDL(s: DatabaseSchema): string {
  const errors = validateSchema(s);
  if (errors.length) throw Error(errors.join("\n"));
  return orderedTables(s)
    .map((t) => {
      const defs = t.columns.map(
        (c) =>
          `${quote(c.name)} ${duckTypeSQL(parseDuckType(c.type))}${!c.nullable ? " NOT NULL" : ""}${c.unique ? " UNIQUE" : ""}${c.defaultValue.trim() ? " DEFAULT " + c.defaultValue : ""}`,
      );
      if (t.primaryKey.length)
        defs.push(
          `PRIMARY KEY (${t.primaryKey.map((k) => quote(t.columns.find((c) => c.id === k)!.name)).join(", ")})`,
        );
      s.relationships
        .filter((r) => r.kind === "physical" && r.sourceTable === t.id)
        .forEach((r) => {
          const target = s.tables.find((x) => x.id === r.targetTable)!;
          defs.push(
            `FOREIGN KEY (${r.sourceColumns.map((k) => quote(t.columns.find((c) => c.id === k)!.name)).join(", ")}) REFERENCES ${quote(target.name)} (${r.targetColumns.map((k) => quote(target.columns.find((c) => c.id === k)!.name)).join(", ")})`,
          );
        });
      return `CREATE TABLE ${quote(t.name)} (\n  ${defs.join(",\n  ")}\n);`;
    })
    .join("\n\n");
}
