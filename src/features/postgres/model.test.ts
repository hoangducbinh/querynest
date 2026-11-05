import { describe, expect, it } from "vitest";
import {
  catalogSchema,
  defaultPostgresConfig,
  parsePostgresConfig,
} from "./model";
import { parseWorkspace } from "../schema/core";
import { createWorkspace } from "../../test/fixtures";
import { sqlCompletions } from "../sql/completions";
describe("PostgreSQL workspace metadata", () => {
  it("whitelists connection fields and never imports passwords or remote rows", () => {
    const w = createWorkspace(false);
    const value = parseWorkspace(
      JSON.stringify({
        ...w,
        postgres: {
          ...defaultPostgresConfig,
          password: "secret",
          sessionId: "temporary",
        },
        data: { remote: [{ private: "row" }] },
      }),
    );
    expect(value.postgres).toEqual(defaultPostgresConfig);
    expect(JSON.stringify(value)).not.toContain("secret");
    expect(value.data).toEqual({});
    expect(() =>
      parsePostgresConfig({ ...defaultPostgresConfig, port: 70000 }),
    ).toThrow();
    expect(() =>
      parsePostgresConfig({ ...defaultPostgresConfig, sslMode: "unknown" }),
    ).toThrow();
  });
  it("retains native types and schema-qualified table identity", () => {
    const schema = catalogSchema({
      tables: [
        {
          id: "1",
          schema: "public",
          name: "items",
          kind: "r",
          columns: [
            {
              id: "1:1",
              name: "id",
              type: "bigint",
              nullable: false,
              primaryKey: true,
            },
          ],
        },
        {
          id: "2",
          schema: "sales",
          name: "items",
          kind: "r",
          columns: [
            {
              id: "2:1",
              name: "price",
              type: "numeric(20,4)",
              nullable: true,
              primaryKey: false,
            },
          ],
        },
      ],
      relationships: [],
    });
    expect(schema.tables[1].columns[0].nativeType).toBe("numeric(20,4)");
    const sql = "SELECT i. FROM sales.items i";
    const columns = sqlCompletions(
      sql,
      sql.indexOf(". ") + 1,
      schema,
      [],
    ).suggestions;
    expect(columns.map((c) => c.label)).toEqual(["price"]);
    const tables = sqlCompletions("SELECT * FROM ", 14, schema, []).suggestions;
    expect(
      tables.filter((t) => t.kind === "table").map((t) => t.insertText),
    ).toEqual(["public.items", "sales.items"]);
    expect(
      sqlCompletions("SELECT * FROM sales.", 20, schema, []).suggestions.map(
        (t) => t.insertText,
      ),
    ).toEqual(["items"]);
  });
  it("quotes mixed-case PostgreSQL identifiers and matches quoted aliases", () => {
    const schema = catalogSchema({
      tables: [
        {
          id: "1",
          schema: "Sales",
          name: "Items",
          kind: "r",
          columns: [
            {
              id: "c",
              name: "DisplayName",
              type: "text",
              nullable: true,
              primaryKey: false,
            },
          ],
        },
      ],
      relationships: [],
    });
    expect(
      sqlCompletions("SELECT * FROM ", 14, schema, []).suggestions[0]
        .insertText,
    ).toBe('"Sales"."Items"');
    const sql = 'SELECT i. FROM "Sales"."Items" i';
    expect(sqlCompletions(sql, 9, schema, []).suggestions[0].insertText).toBe(
      '"DisplayName"',
    );
  });
});
