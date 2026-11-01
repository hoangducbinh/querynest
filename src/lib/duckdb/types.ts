// Built-in column types for the bundled DuckDB 1.5 runtime.
export const duckTypes = [
  "INTEGER",
  "BIGINT",
  "VARCHAR",
  "DOUBLE",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "TINYINT",
  "SMALLINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "BIGNUM",
  "FLOAT",
  "DECIMAL(18,2)",
  "BIT",
  "BLOB",
  "UUID",
  "JSON",
  "TIME",
  "TIME_NS",
  "GEOMETRY",
  "TIMETZ",
  "TIMESTAMPTZ",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMP_US",
  "INTERVAL",
  "INTEGER[]",
  "INTEGER[3]",
  "MAP(VARCHAR, INTEGER)",
  "STRUCT(name VARCHAR, value INTEGER)",
  "UNION(num INTEGER, text VARCHAR)",
  "ENUM('first', 'second')",
  "VARIANT",
] as const;
const aliases: Record<string, string> = {
  INT: "INTEGER",
  INT16: "SMALLINT",
  INT32: "INTEGER",
  INT64: "BIGINT",
  INT128: "HUGEINT",
  UINT8: "UTINYINT",
  UINT16: "USMALLINT",
  UINT32: "UINTEGER",
  UINT64: "UBIGINT",
  UINT128: "UHUGEINT",
  GUID: "UUID",
  NVARCHAR: "VARCHAR",
  INTEGRAL: "INTEGER",
  ROW: "STRUCT",
  INT4: "INTEGER",
  SIGNED: "INTEGER",
  INT1: "TINYINT",
  INT2: "SMALLINT",
  SHORT: "SMALLINT",
  INT8: "BIGINT",
  LONG: "BIGINT",
  VARINT: "BIGNUM",
  REAL: "FLOAT",
  FLOAT4: "FLOAT",
  FLOAT8: "DOUBLE",
  NUMERIC: "DECIMAL",
  DEC: "DECIMAL",
  BOOL: "BOOLEAN",
  LOGICAL: "BOOLEAN",
  CHAR: "VARCHAR",
  BPCHAR: "VARCHAR",
  TEXT: "VARCHAR",
  STRING: "VARCHAR",
  BYTEA: "BLOB",
  BINARY: "BLOB",
  VARBINARY: "BLOB",
  BITSTRING: "BIT",
  DATETIME: "TIMESTAMP",
};
const scalars = new Set([
  ...duckTypes.filter((type) => /^[A-Z_]+$/.test(type)),
  "DECIMAL",
  "OID",
]);
export interface DuckType {
  name: string;
  children: DuckType[];
  fields: string[];
  parameters: number[];
}
export function parseDuckType(source: string): DuckType {
  if (typeof source !== "string" || source.length > 4096)
    throw Error("Invalid DuckDB data type.");
  const parts =
    source.match(
      /"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*|\d+|[^\s]/g,
    ) ?? [];
  let position = 0;
  const peek = () => parts[position];
  const take = () => parts[position++];
  const expect = (token: string) => {
    if (take() !== token) throw Error(`Expected ${token} in data type.`);
  };
  function type(depth = 0): DuckType {
    if (depth > 32) throw Error("Data types may nest up to 32 levels.");
    const token = take();
    if (!token || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(token))
      throw Error("Choose a valid DuckDB data type.");
    let name = aliases[token.toUpperCase()] ?? token.toUpperCase();
    if (name === "DOUBLE" && peek()?.toUpperCase() === "PRECISION") take();
    if (
      ["TIMESTAMP", "TIME"].includes(name) &&
      ["WITH", "WITHOUT"].includes(peek()?.toUpperCase())
    ) {
      const zone = take().toUpperCase();
      if (take()?.toUpperCase() !== "TIME" || take()?.toUpperCase() !== "ZONE")
        throw Error("Expected TIME ZONE.");
      if (zone === "WITH") name = name === "TIME" ? "TIMETZ" : "TIMESTAMPTZ";
    }
    let result: DuckType = { name, children: [], fields: [], parameters: [] };
    if (["MAP", "STRUCT", "UNION", "ENUM"].includes(name)) {
      expect("(");
      if (name === "MAP") {
        result.children.push(type(depth + 1));
        expect(",");
        result.children.push(type(depth + 1));
      } else {
        do {
          if (result.fields.length) expect(",");
          const field = take();
          if (
            !field ||
            !(name === "ENUM"
              ? /^'(?:[^']|'')*'$/.test(field)
              : /^(?:[A-Za-z_][A-Za-z_0-9]*|"(?:[^"]|"")+")$/.test(field))
          )
            throw Error(`Invalid ${name} member.`);
          const value =
            name === "ENUM"
              ? field.slice(1, -1).replaceAll("''", "'")
              : field.startsWith('"')
                ? field.slice(1, -1).replaceAll('""', '"')
                : field;
          if (
            result.fields.some((previous) =>
              name === "ENUM"
                ? previous === value
                : previous.toLowerCase() === value.toLowerCase(),
            )
          )
            throw Error("Duplicate type member.");
          result.fields.push(value);
          if (name !== "ENUM") result.children.push(type(depth + 1));
        } while (peek() === ",");
      }
      expect(")");
    } else {
      if (!scalars.has(name)) throw Error(`Unsupported DuckDB type: ${token}.`);
      if (peek() === "(") {
        if (!["DECIMAL", "VARCHAR", "BIT"].includes(name))
          throw Error(`${name} does not accept parameters.`);
        take();
        do {
          if (result.parameters.length) expect(",");
          const number = take();
          if (!number || !/^\d+$/.test(number))
            throw Error("Type parameters must be whole numbers.");
          result.parameters.push(Number(number));
        } while (peek() === ",");
        expect(")");
        const [width, scale = 0] = result.parameters;
        if (
          name === "DECIMAL"
            ? result.parameters.length > 2 ||
              width < 1 ||
              width > 38 ||
              scale > width
            : result.parameters.length !== 1 ||
              !Number.isSafeInteger(width) ||
              width < 1
        )
          throw Error("Invalid type length, precision or scale.");
      }
    }
    while (peek() === "[") {
      take();
      const length = peek() === "]" ? undefined : take();
      if (
        length !== undefined &&
        (!/^\d+$/.test(length) ||
          Number(length) < 1 ||
          !Number.isSafeInteger(Number(length)))
      )
        throw Error("Array length must be a positive integer.");
      expect("]");
      result = {
        name: length === undefined ? "LIST" : "ARRAY",
        children: [result],
        fields: [],
        parameters: length ? [Number(length)] : [],
      };
    }
    return result;
  }
  const result = type();
  if (position !== parts.length)
    throw Error("Enter a data type only, without SQL clauses.");
  return result;
}
export function validDuckType(type: string) {
  try {
    parseDuckType(type);
    return true;
  } catch {
    return false;
  }
}
export function duckTypeSQL(type: DuckType): string {
  const { name, children, fields, parameters } = type;
  if (name === "LIST" || name === "ARRAY")
    return `${duckTypeSQL(children[0])}[${parameters[0] ?? ""}]`;
  if (name === "MAP") return `MAP(${children.map(duckTypeSQL).join(", ")})`;
  if (name === "ENUM")
    return `ENUM(${fields.map((field) => "'" + field.replaceAll("'", "''") + "'").join(", ")})`;
  if (name === "STRUCT" || name === "UNION")
    return `${name}(${fields.map((field, index) => '"' + field.replaceAll('"', '""') + '" ' + duckTypeSQL(children[index])).join(", ")})`;
  return name + (parameters.length ? `(${parameters.join(",")})` : "");
}
