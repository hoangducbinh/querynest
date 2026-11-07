import { expect, it } from "vitest";
import { createWorkspace } from "../../test/fixtures";
import {
  buildCopyAsCsv,
  buildCopyAsInsert,
  buildCopyAsUpdate,
  inferResultTableTarget,
  isJoinQuery,
} from "./result-sql-copy";

it("infers table targets from SELECT queries across dialects and resolves schema tables", () => {
  const schema = createWorkspace().schema;
  const table = schema.tables[0];
  table.namespace = "dbo";

  const target = inferResultTableTarget(
    `SELECT TOP 10 [id], [email] FROM [dbo].[${table.name}] WHERE [id] > 0`,
    schema,
    "mssql",
  );
  expect(target.namespace).toBe("dbo");
  expect(target.tableName).toBe(table.name);
  expect(target.table?.id).toBe(table.id);

  const fallback = inferResultTableTarget("SELECT 1 AS a, 'hello' AS b");
  expect(fallback.tableName).toBe("table_name");

  // Resolves through CTEs, derived subqueries, and alias.* joins
  expect(
    inferResultTableTarget(
      "WITH active_u AS (SELECT * FROM dbo.users WHERE active = 1) SELECT * FROM active_u",
      undefined,
      "mssql",
      "",
    ).tableName,
  ).toBe("users");

  expect(
    inferResultTableTarget(
      "SELECT * FROM (SELECT * FROM public.orders) sub",
      undefined,
      "postgres",
      "",
    ).tableName,
  ).toBe("orders");

  expect(
    inferResultTableTarget(
      "SELECT o.* FROM users u JOIN orders o ON u.id = o.user_id",
      undefined,
      "default",
      "",
    ).tableName,
  ).toBe("orders");
});

it("generates INSERT statements with dialect-appropriate identifier quoting and literals", () => {
  const columns = ["id", "name", "active", "notes"];
  const rows = [
    { id: 1, name: "Alice's Co", active: true, notes: null },
    { id: 2, name: "Bob", active: false, notes: "VIP" },
  ];

  expect(
    buildCopyAsInsert({
      columns,
      rows,
      sql: "SELECT * FROM public.users",
      dialect: "postgres",
    }),
  ).toBe(
    [
      `INSERT INTO "public"."users" ("id", "name", "active", "notes") VALUES (1, 'Alice''s Co', TRUE, NULL);`,
      `INSERT INTO "public"."users" ("id", "name", "active", "notes") VALUES (2, 'Bob', FALSE, 'VIP');`,
    ].join("\n"),
  );

  expect(
    buildCopyAsInsert({
      columns,
      rows: [rows[0]],
      sql: "SELECT * FROM [dbo].[users]",
      dialect: "mssql",
    }),
  ).toBe(
    `INSERT INTO [dbo].[users] ([id], [name], [active], [notes]) VALUES (1, 'Alice''s Co', 1, NULL);`,
  );
});

it("generates UPDATE statements using schema primary keys, edited cells, and IS NULL predicates", () => {
  const schema = createWorkspace().schema;
  const table = schema.tables[0];
  table.namespace = "public";
  const pkCol = table.columns.find((c) => c.id === table.primaryKey[0])!.name;
  const otherCol = table.columns.find((c) => c.id !== table.primaryKey[0])!.name;

  // Unedited row: updates non-PK columns and filters by PK in WHERE
  expect(
    buildCopyAsUpdate({
      columns: [pkCol, otherCol],
      rows: [{ current: { [pkCol]: 42, [otherCol]: "updated@example.com" } }],
      sql: `SELECT ${pkCol}, ${otherCol} FROM public.${table.name}`,
      schema,
      dialect: "postgres",
    }),
  ).toBe(
    `UPDATE "public"."${table.name}" SET "${otherCol}" = 'updated@example.com' WHERE "${pkCol}" = 42;`,
  );

  // Edited draft row: SET only includes changed columns, WHERE uses original PK value
  expect(
    buildCopyAsUpdate({
      columns: [pkCol, otherCol],
      rows: [
        {
          original: { [pkCol]: 10, [otherCol]: "old" },
          current: { [pkCol]: 10, [otherCol]: "new" },
        },
      ],
      table,
      dialect: "default",
    }),
  ).toBe(
    `UPDATE "public"."${table.name}" SET "${otherCol}" = 'new' WHERE "${pkCol}" = 10;`,
  );

  // NULL key handling in WHERE clause
  expect(
    buildCopyAsUpdate({
      columns: ["code", "label"],
      rows: [{ current: { code: null, label: "Pending" } }],
      sql: "SELECT code, label FROM statuses",
      dialect: "default",
    }),
  ).toBe(`UPDATE "statuses" SET "label" = 'Pending' WHERE "code" IS NULL;`);
});

it("formats CSV rows with RFC 4180 quoting for commas, quotes, and newlines", () => {
  expect(
    buildCopyAsCsv(
      ["id", "title", "note"],
      [
        { id: 1, title: 'Hello, "World"', note: null },
        { id: 2, title: "Plain", note: "Line 1\nLine 2" },
      ],
    ),
  ).toBe('id,title,note\n1,"Hello, ""World""",\n2,Plain,"Line 1\nLine 2"');
});

it("blocks INSERT and UPDATE generation for JOIN query results to prevent multi-table write risks", () => {
  const joinSql =
    "SELECT u.id AS user_id, u.name, o.id AS order_id, o.total FROM public.users u JOIN public.orders o ON o.user_id = u.id";
  const commaJoinSql =
    "SELECT u.id, o.total FROM public.users u, public.orders o WHERE o.user_id = u.id";
  const cteJoinSql =
    "WITH joined AS (SELECT u.id, o.total FROM users u LEFT JOIN orders o ON o.user_id = u.id) SELECT * FROM joined";
  const singleTableSql =
    "SELECT * FROM public.users WHERE id IN (SELECT user_id FROM public.orders)";

  expect(isJoinQuery(joinSql, "postgres")).toBe(true);
  expect(isJoinQuery(commaJoinSql, "postgres")).toBe(true);
  expect(isJoinQuery(cteJoinSql, "postgres")).toBe(true);
  expect(isJoinQuery(singleTableSql, "postgres")).toBe(false);

  const row = { user_id: 7, name: "Alice", order_id: 105, total: 250 };
  expect(
    buildCopyAsInsert({
      columns: ["user_id", "name", "order_id", "total"],
      rows: [row],
      sql: joinSql,
      dialect: "postgres",
    }),
  ).toBe("");

  expect(
    buildCopyAsUpdate({
      columns: ["user_id", "name", "order_id", "total"],
      rows: [{ current: row }],
      sql: joinSql,
      dialect: "postgres",
    }),
  ).toBe("");
});


