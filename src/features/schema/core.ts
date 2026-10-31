import { validateSnippets } from "../sql/snippets";
import {
  dataTypes,
  type DatabaseSchema,
  type RelationshipDefinition,
  type WorkspaceDefinition,
} from "../../types/schema";
export const id = () => crypto.randomUUID();
export function validateRelationship(
  s: DatabaseSchema,
  r: RelationshipDefinition,
): string | undefined {
  const a = s.tables.find((t) => t.id === r.sourceTable),
    b = s.tables.find((t) => t.id === r.targetTable);
  if (!a || !b) return "Both tables must exist.";
  if (
    !r.sourceColumns.length ||
    r.sourceColumns.length !== r.targetColumns.length
  )
    return "Map the same number of columns in order.";
  if (
    new Set(r.sourceColumns).size !== r.sourceColumns.length ||
    new Set(r.targetColumns).size !== r.targetColumns.length
  )
    return "Columns cannot be repeated.";
  for (let i = 0; i < r.sourceColumns.length; i++) {
    const x = a.columns.find((c) => c.id === r.sourceColumns[i]),
      y = b.columns.find((c) => c.id === r.targetColumns[i]);
    if (!x || !y) return "Referenced columns must exist.";
    if (x.type !== y.type) return "Related columns must have matching types.";
  }
  if (
    r.kind === "physical" &&
    !(
      JSON.stringify(b.primaryKey) === JSON.stringify(r.targetColumns) ||
      (r.targetColumns.length === 1 &&
        b.columns.some((c) => c.id === r.targetColumns[0] && c.unique))
    )
  )
    return "Physical foreign keys must reference a primary or unique key in the same order.";
  if (r.kind === "physical" && r.sourceTable === r.targetTable)
    return "Use a logical relationship for self references in this MVP.";
  return undefined;
}
export function validateSchema(s: DatabaseSchema): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const entity of [
    ...s.tables,
    ...s.tables.flatMap((t) => t.columns),
    ...s.relationships,
  ]) {
    if (!entity.id || ids.has(entity.id))
      errors.push("Schema IDs must be nonempty and globally unique.");
    ids.add(entity.id);
  }
  for (const t of s.tables) {
    if (!t.name.trim() || names.has(t.name.toLowerCase()))
      errors.push("Table names must be nonempty and unique.");
    names.add(t.name.toLowerCase());
    const cols = new Set<string>();
    if (!t.columns.length) errors.push(`${t.name}: add at least one column.`);
    for (const c of t.columns) {
      if (!c.name.trim() || cols.has(c.name.toLowerCase()))
        errors.push(`${t.name}: column names must be nonempty and unique.`);
      cols.add(c.name.toLowerCase());
      if (!dataTypes.includes(c.type)) errors.push("Unsupported data type.");
    }
    if (t.primaryKey.some((k) => !t.columns.some((c) => c.id === k)))
      errors.push("Invalid primary key.");
  }
  for (const r of s.relationships) {
    const e = validateRelationship(s, r);
    if (e) errors.push(e);
  }
  return errors;
}
export function parseWorkspace(text: string): WorkspaceDefinition {
  const w = JSON.parse(text) as WorkspaceDefinition;
  if (
    !w ||
    w.version !== 1 ||
    typeof w.id !== "string" ||
    typeof w.name !== "string" ||
    !Array.isArray(w.schema?.tables) ||
    !Array.isArray(w.schema?.relationships) ||
    typeof w.sql !== "string" ||
    !w.data ||
    !Array.isArray(w.tests)
  )
    throw Error("Invalid workspace format.");
  if (
    w.schema.tables.some(
      (t) =>
        !t ||
        typeof t.id !== "string" ||
        typeof t.name !== "string" ||
        !Array.isArray(t.columns) ||
        !Array.isArray(t.primaryKey) ||
        !t.primaryKey.every((k) => typeof k === "string") ||
        !Number.isFinite(t.position?.x) ||
        !Number.isFinite(t.position?.y) ||
        t.columns.some(
          (c) =>
            !c ||
            typeof c.id !== "string" ||
            typeof c.name !== "string" ||
            typeof c.nullable !== "boolean" ||
            typeof c.unique !== "boolean" ||
            typeof c.defaultValue !== "string",
        ),
    ) ||
    w.schema.relationships.some(
      (r) =>
        !r ||
        typeof r.id !== "string" ||
        typeof r.sourceTable !== "string" ||
        typeof r.targetTable !== "string" ||
        !Array.isArray(r.sourceColumns) ||
        !Array.isArray(r.targetColumns) ||
        !["physical", "logical"].includes(r.kind),
    ) ||
    w.tests.some(
      (t) =>
        !t ||
        typeof t.id !== "string" ||
        typeof t.name !== "string" ||
        typeof t.description !== "string" ||
        typeof t.sql !== "string" ||
        typeof t.expected !== "string" ||
        typeof t.ordered !== "boolean",
    ) ||
    Array.isArray(w.data) ||
    typeof w.data !== "object" ||
    Object.values(w.data).some(
      (rows) =>
        !Array.isArray(rows) ||
        rows.some(
          (row) => !row || typeof row !== "object" || Array.isArray(row),
        ),
    )
  )
    throw Error("Invalid workspace structure.");
  if (
    w.diagramPositions !== undefined &&
    (!w.diagramPositions ||
      typeof w.diagramPositions !== "object" ||
      Array.isArray(w.diagramPositions) ||
      Object.values(w.diagramPositions).some(
        (position) =>
          !position ||
          !Number.isFinite(position.x) ||
          !Number.isFinite(position.y),
      ))
  )
    throw Error("Invalid diagram positions.");
  if (w.sqlTabs !== undefined) {
    if (
      !Array.isArray(w.sqlTabs) ||
      !w.sqlTabs.length ||
      w.sqlTabs.some(
        (tab) =>
          !tab ||
          typeof tab.id !== "string" ||
          !tab.id ||
          typeof tab.name !== "string" ||
          !tab.name.trim() ||
          typeof tab.sql !== "string",
      ) ||
      new Set(w.sqlTabs.map((tab) => tab.id)).size !== w.sqlTabs.length
    )
      throw Error("Invalid SQL tabs.");
    if (
      w.activeSqlTabId !== undefined &&
      !w.sqlTabs.some((tab) => tab.id === w.activeSqlTabId)
    )
      throw Error("Invalid active SQL tab.");
  }
  if (w.sqlSnippets !== undefined) {
    const snippetErrors = validateSnippets(w.sqlSnippets);
    if (snippetErrors.length) throw Error(snippetErrors.join(" "));
  }
  const errors = validateSchema(w.schema);
  if (errors.length) throw Error(errors.join("\n"));
  return w;
}
export function createWorkspace(demo = true): WorkspaceDefinition {
  const tables = demo
    ? ["customers", "orders", "order_items"].map((name, i) => ({
        id: id(),
        name,
        position: { x: 80 + i * 330, y: 90 + (i === 1 ? 60 : 0) },
        columns: (i === 0
          ? [
              ["id", "INTEGER"],
              ["name", "VARCHAR"],
              ["email", "VARCHAR"],
            ]
          : i === 1
            ? [
                ["id", "INTEGER"],
                ["customer_id", "INTEGER"],
                ["total", "DOUBLE"],
              ]
            : [
                ["id", "INTEGER"],
                ["order_id", "INTEGER"],
                ["product", "VARCHAR"],
                ["quantity", "INTEGER"],
              ]
        ).map(([name, type]) => ({
          id: id(),
          name,
          type: type as "INTEGER" | "VARCHAR" | "DOUBLE",
          nullable: false,
          unique: false,
          defaultValue: "",
        })),
        primaryKey: [] as string[],
      }))
    : [];
  tables.forEach((t) => (t.primaryKey = [t.columns[0].id]));
  const relationships: RelationshipDefinition[] = tables
    .slice(1)
    .map((t, i) => ({
      id: id(),
      sourceTable: t.id,
      sourceColumns: [t.columns[1].id],
      targetTable: tables[i].id,
      targetColumns: [tables[i].columns[0].id],
      kind: "physical",
    }));
  return {
    version: 1,
    id: id(),
    name: demo ? "Commerce sandbox" : "Untitled workspace",
    schema: { tables, relationships },
    sql: "SELECT c.name, COUNT(o.id) AS orders, SUM(o.total) AS revenue\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nORDER BY revenue DESC;",
    data: demo
      ? Object.fromEntries(
          tables.map((t, i) => [
            t.id,
            i === 0
              ? [
                  { id: 1, name: "Alex Morgan", email: "alex@example.com" },
                  { id: 2, name: "Jordan Lee", email: "jordan@example.com" },
                ]
              : i === 1
                ? [
                    { id: 1, customer_id: 1, total: 149.5 },
                    { id: 2, customer_id: 1, total: 79 },
                    { id: 3, customer_id: 2, total: 225 },
                  ]
                : [
                    {
                      id: 1,
                      order_id: 1,
                      product: "Mechanical keyboard",
                      quantity: 1,
                    },
                  ],
          ]),
        )
      : {},
    tests: [],
    updatedAt: Date.now(),
  };
}
