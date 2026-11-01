export type SqlDialect = "default" | "postgres" | "mssql";
export interface TypeCompletion {
  label: string;
  body?: string;
  detail?: string;
}
const plain = (names: string) => names.split("|").map((label) => ({ label }));
const shared = plain(
  "BIGINT|INTEGER|SMALLINT|BOOLEAN|DATE|DOUBLE PRECISION|REAL|TEXT|UUID|JSON|INTERVAL|TIME|TIMESTAMP|VARCHAR",
);
export const sqlDataTypes = (dialect: SqlDialect): TypeCompletion[] => {
  if (dialect === "mssql")
    return [
      ...plain(
        "BIGINT|INT|INTEGER|SMALLINT|TINYINT|BIT|MONEY|SMALLMONEY|FLOAT|REAL|DATE|DATETIME|SMALLDATETIME|UNIQUEIDENTIFIER|XML|SQL_VARIANT|ROWVERSION|TIMESTAMP|HIERARCHYID|GEOMETRY|GEOGRAPHY|SYSNAME|NTEXT|TEXT|IMAGE",
      ),
      ...["NVARCHAR", "VARCHAR", "VARBINARY"].flatMap((label) => [
        { label, body: `${label}(\${1:255})` },
        { label: `${label}(MAX)` },
      ]),
      ...["NCHAR", "CHAR", "BINARY"].map((label) => ({
        label,
        body: `${label}(\${1:255})`,
      })),
      ...["DECIMAL", "NUMERIC"].map((label) => ({
        label,
        body: `${label}(\${1:18},\${2:2})`,
      })),
      ...["DATETIME2", "DATETIMEOFFSET", "TIME"].map((label) => ({
        label,
        body: `${label}(\${1:7})`,
      })),
      {
        label: "JSON",
        detail: "SQL Server 2025+; availability depends on the server",
      },
      {
        label: "VECTOR",
        body: "VECTOR(${1:1536})",
        detail: "SQL Server 2025+; availability depends on the server",
      },
    ];
  if (dialect === "postgres")
    return [
      ...shared,
      ...plain(
        "INT|INT2|INT4|INT8|FLOAT4|FLOAT8|BOOL|CHARACTER|CHARACTER VARYING|CHAR|NAME|BYTEA|SERIAL|SMALLSERIAL|BIGSERIAL|JSONB|JSONPATH|XML|INET|CIDR|MACADDR|MACADDR8|POINT|LINE|LSEG|BOX|PATH|POLYGON|CIRCLE|MONEY|TSVECTOR|TSQUERY|INT4RANGE|INT8RANGE|NUMRANGE|TSRANGE|TSTZRANGE|DATERANGE|INT4MULTIRANGE|INT8MULTIRANGE|NUMMULTIRANGE|TSMULTIRANGE|TSTZMULTIRANGE|DATEMULTIRANGE|OID|REGCLASS|REGTYPE|PG_LSN|PG_SNAPSHOT|XID|XID8|CID|TID",
      ),
      { label: "NUMERIC", body: "NUMERIC(${1:18},${2:2})" },
      { label: "DECIMAL", body: "DECIMAL(${1:18},${2:2})" },
      { label: "TIMESTAMPTZ" },
      { label: "TIMESTAMP WITH TIME ZONE" },
      { label: "TIMESTAMP WITHOUT TIME ZONE" },
      { label: "TIMETZ" },
      { label: "TIME WITH TIME ZONE" },
      { label: "TIME WITHOUT TIME ZONE" },
      { label: "BIT", body: "BIT(${1:1})" },
      { label: "BIT VARYING", body: "BIT VARYING(${1:8})" },
      { label: "VARBIT", body: "VARBIT(${1:8})" },
      { label: "ARRAY", body: "${1:INTEGER}[]", detail: "Array column" },
    ];
  return [
    ...shared,
    ...plain(
      "TINYINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|BIGNUM|VARINT|FLOAT|DOUBLE|BIT|BITSTRING|BLOB|BYTEA|BINARY|VARBINARY|CHAR|BPCHAR|STRING|BOOL|LOGICAL|INT|INT1|INT2|INT4|INT8|SHORT|LONG|SIGNED|FLOAT4|FLOAT8|DATETIME|TIMESTAMPTZ|TIMETZ|TIME WITH TIME ZONE|TIME WITHOUT TIME ZONE|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITHOUT TIME ZONE|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS|TIMESTAMP_US|TIME_NS|GEOMETRY|VARIANT",
    ),
    { label: "DECIMAL", body: "DECIMAL(${1:18},${2:2})" },
    { label: "NUMERIC", body: "NUMERIC(${1:18},${2:2})" },
    { label: "LIST", body: "${1:INTEGER}[]", detail: "Variable-length list" },
    {
      label: "ARRAY",
      body: "${1:INTEGER}[${2:3}]",
      detail: "Fixed-length array",
    },
    { label: "MAP", body: "MAP(${1:VARCHAR}, ${2:INTEGER})" },
    {
      label: "STRUCT",
      body: "STRUCT(${1:name} ${2:VARCHAR}, ${3:value} ${4:INTEGER})",
    },
    {
      label: "UNION",
      body: "UNION(${1:num} ${2:INTEGER}, ${3:text} ${4:VARCHAR})",
    },
    { label: "ENUM", body: "ENUM('${1:first}', '${2:second}')" },
  ];
};
