function stable(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return String(Number(v));
  if (Array.isArray(v)) return v.map(stable);
  if (typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stable(x)]),
    );
  return v;
}
export function compareResults(
  actual: unknown[],
  expected: unknown[],
  ordered: boolean,
) {
  const a = actual.map((v) => JSON.stringify(stable(v))),
    b = expected.map((v) => JSON.stringify(stable(v)));
  if (!ordered) {
    a.sort();
    b.sort();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
