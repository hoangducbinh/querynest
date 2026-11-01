import { describe, expect, it } from "vitest";
import { duckTypes, duckTypeSQL, parseDuckType, validDuckType } from "./types";
import { createWorkspace, parseWorkspace } from "../../features/schema/core";
import { generateDDL } from "../ddl/generate";
import { duckValue, snapshotColumn } from "./values";
import { mutationSQL, parseCell } from "../../features/sample-data/model";
const column = (type: string) => ({
  id: "test",
  name: "value",
  type,
  nullable: true,
  unique: false,
  defaultValue: "",
});
describe("DuckDB column types", () => {
  it.each(duckTypes)("accepts the built-in type template %s", (type) => {
    expect(validDuckType(type)).toBe(true);
    expect(duckTypeSQL(parseDuckType(duckTypeSQL(parseDuckType(type))))).toBe(
      duckTypeSQL(parseDuckType(type)),
    );
  });
  it.each([
    "DECIMAL(39,2)",
    "DECIMAL(0,0)",
    "DECIMAL(5,6)",
    "INTEGER(12)",
    "INTEGER[0]",
    "VARCHAR; DROP TABLE x",
    "INTEGER DEFAULT 1",
    "MAP(VARCHAR)",
    "STRUCT(x INT, X INT)",
    "ENUM('x','x')",
    "INTEGER --comment",
    "INTEGER[] garbage",
    "UNION()",
    "",
  ])("rejects invalid or injected type %s", (type) =>
    expect(validDuckType(type)).toBe(false),
  );
  it("keeps nested and parameterized types across export/import and DDL", () => {
    const w = createWorkspace(false);
    w.schema.tables = [
      {
        id: "t",
        name: "typed",
        columns: [column('STRUCT("a b" DECIMAL(38,10), ids UHUGEINT[3][])')],
        primaryKey: [],
        position: { x: 0, y: 0 },
      },
    ];
    expect(parseWorkspace(JSON.stringify(w))).toEqual(w);
    expect(generateDDL(w.schema)).toContain(
      'STRUCT("a b" DECIMAL(38,10), "ids" UHUGEINT[3][])',
    );
  });
  it("preserves decimal and huge integer text and safely quotes cell input", () => {
    const c = column("DECIMAL(38,8)");
    expect(parseCell("12345678901234567890.12345678", c)).toBe(
      "12345678901234567890.12345678",
    );
    expect(duckValue(c, "12345678901234567890.12345678")).toBe(
      "CAST('12345678901234567890.12345678' AS DECIMAL(38,8))",
    );
    expect(duckValue(column("UUID"), "x'); DROP TABLE t;--")).toBe(
      "CAST('x''); DROP TABLE t;--' AS UUID)",
    );
  });
  it("roundtrips tagged unions and nested exact scalars without executable stored SQL", () => {
    const c = column("UNION(num HUGEINT, text VARCHAR)");
    expect(
      duckValue(
        c,
        '{"tag":"num","value":"170141183460469231731687303715884105727"}',
      ),
    ).toContain(
      "union_value(\"num\" := CAST('170141183460469231731687303715884105727' AS HUGEINT))",
    );
    expect(snapshotColumn(c)).toContain("union_tag");
    expect(() => duckValue(c, '{"tag":"bad","value":1}')).toThrow("UNION");
    expect(() => duckValue(column("INTEGER[2]"), "[1]")).toThrow(
      "2 array elements",
    );
    expect(() => duckValue(column("STRUCT(n INT)"), '{"bad":1}')).toThrow(
      "Unknown STRUCT",
    );
  });
  it("uses the same safe typed values for grid insert/update/delete predicates", () => {
    const c = column("DECIMAL(38,8)");
    const table = {
      id: "t",
      name: "typed",
      columns: [c],
      primaryKey: [c.id],
      position: { x: 0, y: 0 },
    };
    const [sql] = mutationSQL(table, [
      {
        id: "row",
        original: { value: "1.00000000" },
        cells: { value: "2.00000000" },
        deleted: false,
      },
    ]);
    expect(sql).toContain("SET \"value\"=CAST('2.00000000' AS DECIMAL(38,8))");
    expect(sql).toContain(
      "IS NOT DISTINCT FROM CAST('1.00000000' AS DECIMAL(38,8))",
    );
  });
});
