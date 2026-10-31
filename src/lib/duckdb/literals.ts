export const literal = (value: unknown): string =>
  value === null || value === undefined
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : typeof value === "boolean"
        ? value
          ? "TRUE"
          : "FALSE"
        : "'" + String(value).replaceAll("'", "''") + "'";
