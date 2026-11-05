import { describe, it, expect } from "vitest";
import { createWorkspace } from "../../test/fixtures";
import { sqlCompletions } from "./completions";
import { DEFAULT_SNIPPETS } from "./snippets";
const schema = createWorkspace().schema;
function complete(marked: string, current = schema) {
  const offset = marked.indexOf("|");
  return sqlCompletions(
    marked.replace("|", ""),
    offset,
    current,
    DEFAULT_SNIPPETS,
  );
}
describe("schema-aware SQL completion", () => {
  it("suggests tables after FROM and JOIN with a partially typed name", () => {
    const result = complete("SELECT * FROM cu|");
    expect(result.suggestions.map((s) => s.label)).toEqual(["customers"]);
    expect(result.suggestions[0].kind).toBe("table");
    expect(
      complete("SELECT * FROM customers c JOIN ord|").suggestions.map(
        (s) => s.label,
      ),
    ).toContain("orders");
  });
  it("resolves aliases declared after the cursor and restricts dotted completion to their columns", () => {
    const result = complete(
      "SELECT c.| FROM customers AS c JOIN orders o ON o.customer_id=c.id",
    );
    expect(result.suggestions.map((s) => s.label)).toEqual([
      "id",
      "name",
      "email",
    ]);
    expect(result.suggestions.some((s) => s.label === "total")).toBe(false);
    expect(result.suggestions[0].insertText).toBe("id");
  });
  it("replaces the complete current word without overwriting the qualifier", () => {
    const marked = "SELECT c.na|me FROM customers c";
    const result = complete(marked);
    expect(result.suggestions.map((s) => s.label)).toEqual(["name"]);
    expect(marked.replace("|", "").slice(result.start, result.end)).toBe(
      "name",
    );
  });
  it("supports table qualifiers and the main namespace", () => {
    expect(
      complete("SELECT orders.| FROM orders").suggestions.map((s) => s.label),
    ).toEqual(["id", "customer_id", "total"]);
    expect(
      complete("SELECT * FROM main.|").suggestions.every(
        (s) => s.kind === "table",
      ),
    ).toBe(true);
    expect(
      complete("SELECT main.customers.| FROM main.customers").suggestions.map(
        (s) => s.label,
      ),
    ).toContain("email");
  });
  it("qualifies ambiguous columns across joins and self joins", () => {
    const result = complete(
      "SELECT i| FROM customers c JOIN orders o ON c.id=o.customer_id",
    );
    expect(
      result.suggestions
        .filter((s) => s.label === "id")
        .map((s) => s.insertText),
    ).toEqual(["c.id", "o.id"]);
    const self = complete(
      "SELECT i| FROM customers c JOIN customers parent ON c.id=parent.id",
    );
    expect(
      self.suggestions.filter((s) => s.label === "id").map((s) => s.insertText),
    ).toEqual(["c.id", "parent.id"]);
  });
  it("handles comma-separated FROM tables", () => {
    const result = complete(
      "SELECT o.| FROM customers c, orders o WHERE c.id=o.customer_id",
    );
    expect(result.suggestions.map((s) => s.label)).toEqual([
      "id",
      "customer_id",
      "total",
    ]);
    expect(
      complete("SELECT * FROM customers c, ord|").suggestions.map(
        (s) => s.label,
      ),
    ).toContain("orders");
  });
  it("never leaks aliases across SQL statements", () => {
    expect(
      complete("SELECT * FROM customers c; SELECT c.| FROM orders o")
        .suggestions,
    ).toEqual([]);
    expect(
      complete("SELECT ';' AS value; SELECT o.| FROM orders o").suggestions.map(
        (s) => s.label,
      ),
    ).toContain("total");
  });
  it("supports correlated outer aliases but not aliases from sibling subqueries", () => {
    expect(
      complete(
        "SELECT c.id FROM customers c WHERE EXISTS (SELECT c.| FROM orders o)",
      ).suggestions.map((s) => s.label),
    ).toContain("email");
    expect(
      complete(
        "SELECT (SELECT c.id FROM customers c), (SELECT c.| FROM orders o)",
      ).suggestions,
    ).toEqual([]);
  });
  it("suppresses completions in strings, dollar strings, line and nested block comments", () => {
    for (const sql of [
      "SELECT 'cu|stomers'",
      "SELECT $$cu|stomers$$",
      "SELECT $body$cu|stomers$body$",
      "-- SELECT cu|",
      "/* outer /* nested */ cu| */",
    ])
      expect(complete(sql).suggestions).toEqual([]);
  });
  it("ignores fake FROM clauses in comments and strings", () => {
    expect(
      complete(
        "SELECT c.|, 'FROM customers c' FROM orders o -- FROM customers c",
      ).suggestions,
    ).toEqual([]);
  });
  it("quotes unusual names safely and does not consume the rest of an unclosed identifier", () => {
    const custom = createWorkspace().schema;
    custom.tables[0].name = "order details";
    custom.tables[0].columns[1].name = 'full"name';
    const result = complete('SELECT od.| FROM "order details" od', custom);
    expect(
      result.suggestions.find((s) => s.label === 'full"name')?.insertText,
    ).toBe('"full""name"');
    const pending = complete('SELECT * FROM "order d| WHERE id=1', custom);
    expect(pending.end).toBe(pending.start + '"order d'.length);
    expect(pending.suggestions[0].insertText).toBe('"order details"');
  });
  it("provides keyword, function and configurable snippet suggestions", () => {
    expect(
      complete("SEL|").suggestions.some(
        (s) => s.kind === "snippet" && s.label === "sel",
      ),
    ).toBe(true);
    expect(
      complete("SU|").suggestions.find((s) => s.label === "SUM")?.insertText,
    ).toBe("SUM(${1:expression})");
    const result = sqlCompletions("quick", 5, schema, [
      {
        id: "x",
        prefix: "quick",
        description: "All customers",
        body: "SELECT * FROM customers;",
      },
    ]);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        label: "quick",
        insertText: "SELECT * FROM customers;",
        snippet: true,
      }),
    ]);
  });
});

describe("concise SQL Server identifiers", () => {
  const current = structuredClone(schema);
  current.tables[0].namespace = "dbo";
  current.tables[0].name = "Customers";
  const suggest = (sql: string) =>
    sqlCompletions(sql, sql.length, current, [], "mssql").suggestions;
  it("inserts plain table and column names without dbo or brackets", () => {
    expect(suggest("SELECT * FROM Cust")[0].insertText).toBe("Customers");
    expect(suggest("SELECT * FROM dbo.Cust")[0].insertText).toBe("Customers");
    const sql = "SELECT c. FROM Customers c";
    expect(
      sqlCompletions(sql, 9, current, [], "mssql").suggestions[0].insertText,
    ).toBe("id");
  });
  it("keeps non-default schemas and required identifier escaping", () => {
    const custom = structuredClone(current);
    custom.tables[0].namespace = "sales";
    custom.tables[0].name = "Order Details";
    expect(
      sqlCompletions("SELECT * FROM ", 14, custom, [], "mssql").suggestions[0]
        .insertText,
    ).toBe("sales.[Order Details]");
    custom.tables[0].namespace = "dbo";
    custom.tables[0].name = "Order";
    expect(
      sqlCompletions("SELECT * FROM ", 14, custom, [], "mssql").suggestions[0]
        .insertText,
    ).toBe("[Order]");
    custom.tables[0].name = "a]b";
    expect(
      sqlCompletions("SELECT * FROM ", 14, custom, [], "mssql").suggestions[0]
        .insertText,
    ).toBe("[a]]b]");
  });
});

it("bounds suggestions on a 3,000-table catalog and resolves columns only for referenced tables", () => {
  const large = {
    relationships: [],
    tables: Array.from({ length: 3000 }, (_, index) => ({
      ...schema.tables[0],
      id: `table-${index}`,
      name: `table_${index}`,
      namespace: "dbo",
      columns: Array.from({ length: 50 }, (_, column) => ({
        ...schema.tables[0].columns[0],
        id: `${index}-${column}`,
        name: `field_${column}`,
      })),
    })),
  };
  const sql = "SELECT ";
  const unbound = sqlCompletions(sql, sql.length, large, [], "mssql");
  expect(unbound.suggestions.length).toBeLessThanOrEqual(500);
  expect(unbound.suggestions.some((item) => item.kind === "column")).toBe(
    false,
  );
  const query = "SELECT t. FROM dbo.table_2999 t";
  const bound = sqlCompletions(
    query,
    query.indexOf(".") + 1,
    large,
    [],
    "mssql",
  );
  expect(
    bound.suggestions.filter((item) => item.kind === "column"),
  ).toHaveLength(50);
  const filtered = "SELECT * FROM table_2999";
  expect(
    sqlCompletions(
      filtered,
      filtered.length,
      large,
      [],
      "mssql",
    ).suggestions.map((item) => item.label),
  ).toEqual(["table_2999"]);
});

it("completes explicit and inferred CTE columns", () => {
  expect(
    complete(
      "WITH recent AS (SELECT id, total AS amount FROM orders) SELECT r.| FROM recent r",
    ).suggestions.map((item) => item.label),
  ).toEqual(["id", "amount"]);
  expect(
    complete(
      "WITH recent(customer, amount) AS (SELECT customer_id, total FROM orders) SELECT r.| FROM recent r",
    ).suggestions.map((item) => item.label),
  ).toEqual(["customer", "amount"]);
});

it("supports abbreviated column prefixes and dialect-specific functions", () => {
  expect(
    complete("SELECT o.ci| FROM orders o").suggestions.map(
      (item) => item.label,
    ),
  ).toContain("customer_id");
  const sql = "SELECT GETD";
  expect(
    sqlCompletions(sql, sql.length, schema, [], "mssql").suggestions.find(
      (item) => item.label === "GETDATE",
    )?.insertText,
  ).toBe("GETDATE()");
  expect(
    sqlCompletions(sql, sql.length, schema, [], "postgres").suggestions.map(
      (item) => item.label,
    ),
  ).not.toContain("GETDATE");
});
