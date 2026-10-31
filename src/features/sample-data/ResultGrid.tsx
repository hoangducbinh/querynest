import { Terminal } from "lucide-react";

export function ResultGrid({
  rows,
  columns,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
}) {
  return (
    <div className="grid-scroll">
      {columns.length ? (
        <table>
          <thead>
            <tr>
              <th>#</th>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                {columns.map((c) => (
                  <td key={c}>
                    {r[c] === null ? <em>NULL</em> : String(r[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="results-empty">
          <Terminal size={22} />
          <p>Run a query to explore your data</p>
          <small>Results stay in your browser.</small>
        </div>
      )}
    </div>
  );
}
