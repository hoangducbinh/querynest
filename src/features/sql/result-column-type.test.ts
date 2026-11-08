import { describe, expect, it } from "vitest";
import { normalizeSqlColumnType } from "./ResultSetView";

describe("normalizeSqlColumnType", () => {
  it("normalizes internal PostgreSQL types to user-friendly types matching Data tab", () => {
    expect(normalizeSqlColumnType("int4")).toBe("integer");
    expect(normalizeSqlColumnType("INT4")).toBe("integer");
    expect(normalizeSqlColumnType("int8")).toBe("bigint");
    expect(normalizeSqlColumnType("INT8")).toBe("bigint");
    expect(normalizeSqlColumnType("int2")).toBe("smallint");
    expect(normalizeSqlColumnType("bool")).toBe("boolean");
    expect(normalizeSqlColumnType("BOOL")).toBe("boolean");
    expect(normalizeSqlColumnType("float4")).toBe("real");
    expect(normalizeSqlColumnType("float8")).toBe("double precision");
    expect(normalizeSqlColumnType("bpchar")).toBe("char");
    expect(normalizeSqlColumnType("_int4")).toBe("integer[]");
    expect(normalizeSqlColumnType("_text")).toBe("text[]");
  });

  it("preserves standard SQL and detailed types untouched", () => {
    expect(normalizeSqlColumnType("integer")).toBe("integer");
    expect(normalizeSqlColumnType("varchar(255)")).toBe("varchar(255)");
    expect(normalizeSqlColumnType("numeric(20,4)")).toBe("numeric(20,4)");
    expect(normalizeSqlColumnType("timestamp with time zone")).toBe(
      "timestamp with time zone",
    );
    expect(normalizeSqlColumnType("text")).toBe("text");
    expect(normalizeSqlColumnType("date")).toBe("date");
    expect(normalizeSqlColumnType(undefined)).toBeUndefined();
    expect(normalizeSqlColumnType("")).toBeUndefined();
  });
});

