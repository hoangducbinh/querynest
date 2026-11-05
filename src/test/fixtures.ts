import { id } from "../features/schema/core";
import type {
  WorkspaceDefinition,
  RelationshipDefinition,
} from "../types/schema";
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
