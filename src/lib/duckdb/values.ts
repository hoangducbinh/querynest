import type { ColumnDefinition } from "../../types/schema";
import { literal } from "./literals";
import { duckTypeSQL, parseDuckType, type DuckType } from "./types";
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const compound = (type: DuckType) =>
  ["LIST", "ARRAY", "MAP", "STRUCT", "UNION", "VARIANT"].includes(type.name);
export function isCompoundType(type: string) {
  return compound(parseDuckType(type));
}
function encode(expression: string, type: DuckType, depth = 0): string {
  const variable = `__cell_${depth}`;
  let result: string;
  if (type.name === "LIST" || type.name === "ARRAY") {
    result = `to_json(list_transform(${expression}, ${variable} -> ${encode(variable, type.children[0], depth + 1)}))`;
  } else if (type.name === "MAP") {
    result = `to_json(list_transform(map_entries(${expression}), ${variable} -> json_object('key', ${encode(`${variable}.key`, type.children[0], depth + 1)}, 'value', ${encode(`${variable}.value`, type.children[1], depth + 1)})))`;
  } else if (type.name === "STRUCT") {
    result = `json_object(${type.fields.flatMap((field, i) => [literal(field), encode(`(${expression}).${quote(field)}`, type.children[i], depth + 1)]).join(", ")})`;
  } else if (type.name === "UNION") {
    result = `json_object('tag', CAST(union_tag(${expression}) AS VARCHAR), 'value', CASE CAST(union_tag(${expression}) AS VARCHAR) ${type.fields.map((field, i) => `WHEN ${literal(field)} THEN ${encode(`union_extract(${expression}, ${literal(field)})`, type.children[i], depth + 1)}`).join(" ")} END)`;
  } else if (type.name === "VARIANT") {
    result = `json_object('$variantType', variant_typeof(${expression}), '$variantJSON', CAST(CAST(${expression} AS JSON) AS VARCHAR))`;
  } else result = `to_json(CAST(${expression} AS VARCHAR))`;
  return `CASE WHEN ${expression} IS NULL THEN NULL ELSE ${result} END`;
}
// Snapshots use text for exact numbers/binary/time, JSON with string leaves for
// nested values. No executable SQL is stored in a workspace or trusted on import.
export function snapshotColumn(column: ColumnDefinition): string {
  const type = parseDuckType(column.type);
  const expression = quote(column.name);
  if (compound(type))
    return `CAST(${encode(expression, type)} AS VARCHAR) AS ${expression}`;
  if (
    [
      "INTEGER",
      "TINYINT",
      "SMALLINT",
      "UTINYINT",
      "USMALLINT",
      "UINTEGER",
      "DOUBLE",
      "FLOAT",
      "BOOLEAN",
      "VARCHAR",
    ].includes(type.name)
  )
    return expression;
  return `CAST(${expression} AS VARCHAR) AS ${expression}`;
}
function decode(value: unknown, type: DuckType): string {
  if (value === null || value === undefined) return "NULL";
  const sqlType = duckTypeSQL(type);
  const cast = (sql: string) => `CAST(${sql} AS ${sqlType})`;
  if (type.name === "LIST" || type.name === "ARRAY") {
    if (!Array.isArray(value)) throw Error("Enter a JSON array.");
    if (type.name === "ARRAY" && value.length !== type.parameters[0])
      throw Error(`Expected ${type.parameters[0]} array elements.`);
    return cast(
      `[${value.map((item) => decode(item, type.children[0])).join(", ")}]`,
    );
  }
  if (type.name === "MAP") {
    if (
      !Array.isArray(value) ||
      value.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          !Object.hasOwn(entry, "key") ||
          !Object.hasOwn(entry, "value"),
      )
    )
      throw Error('Enter MAP as [{"key":"a","value":"1"}].');
    return cast(
      `map([${value.map((entry) => decode(entry.key, type.children[0])).join(", ")}], [${value.map((entry) => decode(entry.value, type.children[1])).join(", ")}])`,
    );
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (type.name === "STRUCT") {
      if (Object.keys(object).some((field) => !type.fields.includes(field)))
        throw Error("Unknown STRUCT field.");
      return cast(
        `struct_pack(${type.fields.map((field, i) => `${quote(field)} := ${decode(object[field], type.children[i])}`).join(", ")})`,
      );
    }
    if (type.name === "UNION") {
      const member = type.fields.indexOf(String(object.tag));
      if (member < 0 || !Object.hasOwn(object, "value"))
        throw Error('Enter UNION as {"tag":"member","value":...}.');
      return cast(
        `union_value(${quote(type.fields[member])} := ${decode(object.value, type.children[member])})`,
      );
    }
    if (
      type.name === "VARIANT" &&
      typeof object.$variantType === "string" &&
      typeof object.$variantJSON === "string"
    ) {
      JSON.parse(object.$variantJSON);
      const names: Record<string, string> = {
        INT8: "TINYINT",
        INT16: "SMALLINT",
        INT32: "INTEGER",
        INT64: "BIGINT",
        INT128: "HUGEINT",
        UINT8: "UTINYINT",
        UINT16: "USMALLINT",
        UINT32: "UINTEGER",
        UINT64: "UBIGINT",
        UINT128: "UHUGEINT",
      };
      const native = names[object.$variantType] ?? object.$variantType;
      if (
        /^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|BOOLEAN|FLOAT|DOUBLE|VARCHAR|DECIMAL\(\d+,\s*\d+\))$/.test(
          native,
        )
      ) {
        const parsed = duckTypeSQL(parseDuckType(native));
        return cast(
          `from_json(${literal(object.$variantJSON)}, ${literal(JSON.stringify(parsed))})`,
        );
      }
      return cast(`CAST(${literal(object.$variantJSON)} AS JSON)`);
    }
  }
  if (type.name === "VARIANT")
    return cast(`CAST(${literal(JSON.stringify(value))} AS JSON)`);
  if (compound(type))
    throw Error("Enter a valid JSON object for this data type.");
  if (!["string", "number", "boolean"].includes(typeof value))
    throw Error("Enter a scalar value.");
  return cast(literal(value));
}
export function duckValue(column: ColumnDefinition, value: unknown): string {
  const type = parseDuckType(column.type);
  if (compound(type) && typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw Error(`${column.name}: enter valid JSON for ${type.name}.`);
    }
  }
  // Keep existing simple workspaces and their SQL output unchanged.
  if (
    [
      "INTEGER",
      "BIGINT",
      "VARCHAR",
      "DOUBLE",
      "BOOLEAN",
      "DATE",
      "TIMESTAMP",
    ].includes(column.type)
  )
    return literal(value);
  return decode(value, type);
}

export function sampleDuckValue(column: ColumnDefinition, index = 0): string {
  function sample(type: DuckType): unknown {
    if (type.name === "LIST" || type.name === "ARRAY") {
      const length = type.parameters[0] ?? 2;
      if (length > 1000)
        throw Error(
          "Generate sample data supports arrays of up to 1,000 elements.",
        );
      return Array.from({ length }, () => sample(type.children[0]));
    }
    if (type.name === "MAP")
      return [
        { key: sample(type.children[0]), value: sample(type.children[1]) },
      ];
    if (type.name === "STRUCT")
      return Object.fromEntries(
        type.fields.map((field, i) => [field, sample(type.children[i])]),
      );
    if (type.name === "UNION")
      return { tag: type.fields[0], value: sample(type.children[0]) };
    if (type.name === "VARIANT") return { sample: true };
    if (type.name === "ENUM") return type.fields[0];
    if (type.name === "VARCHAR") return column.name + " sample";
    if (type.name === "BOOLEAN") return true;
    if (type.name === "JSON") return '{"sample":true}';
    if (type.name === "DECIMAL") return "0";
    if (type.name === "BIT") return "1";
    if (type.name === "BLOB") return "\\x01";
    if (type.name === "UUID") return crypto.randomUUID();
    if (type.name === "GEOMETRY") return "POINT (0 0)";
    if (type.name === "INTERVAL") return "1 day";
    if (type.name === "DATE") return "2026-01-01";
    if (type.name.startsWith("TIMESTAMP")) return "2026-01-01 00:00:00+00";
    if (type.name.startsWith("TIME")) return "12:00:00+00";
    return String(index + 1);
  }
  return duckValue(column, sample(parseDuckType(column.type)));
}
export function duckCellHint(type: string): string {
  try {
    const name = parseDuckType(type).name;
    if (name === "MAP") return 'JSON entries: [{"key":"a","value":"1"}]';
    if (name === "UNION") return 'JSON member: {"tag":"member","value":...}';
    if (name === "STRUCT")
      return 'JSON object, e.g. {"name":"Duck"}. Quote large numbers to preserve precision.';
    if (["LIST", "ARRAY"].includes(name))
      return 'JSON array, e.g. ["1","2"]. Quote large numbers to preserve precision.';
    if (name === "VARIANT")
      return "JSON value. Saved values include type metadata.";
    if (name === "BLOB") return "Binary text, e.g. \\x00\\xFF";
    return type;
  } catch {
    return type;
  }
}
