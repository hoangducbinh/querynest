import { gridPosition, rememberGridPosition } from "./view-state";
import { useMemo } from "react";
import {
  ColumnResizeHandle,
  fitColumnWidth,
  useColumnWidths,
  useColumnWindow,
} from "./column-sizing";
import { cellText } from "./model";
import { Terminal } from "lucide-react";

export function ResultGrid({
  viewKey,
  rows,
  columns,
}: {
  viewKey?: string;
  rows: Record<string, unknown>[];
  columns: string[];
}) {
  const sizing = useColumnWidths(`results:${JSON.stringify(columns)}`, columns);
  const defaultWidths = useMemo(
    () =>
      columns.map((name) =>
        fitColumnWidth(
          name,
          rows.map((row) => row[name]),
          280,
        ),
      ),
    [columns, rows],
  );
  const widths = columns.map((name, index) =>
    sizing.width(name, defaultWidths[index]),
  );
  const viewport = useColumnWindow(
    widths,
    48,
    viewKey ? gridPosition(viewKey) : undefined,
  );
  const visibleColumns = columns.slice(viewport.start, viewport.end);
  return (
    <div
      className="grid-scroll"
      ref={viewport.ref}
      tabIndex={0}
      aria-label="Query result data"
      onScroll={(event) => {
        if (viewKey)
          rememberGridPosition(
            viewKey,
            event.currentTarget.scrollTop,
            event.currentTarget.scrollLeft,
          );
      }}
    >
      {columns.length ? (
        <table
          className="resizable-results"
          style={{ width: 48 + widths.reduce((sum, width) => sum + width, 0) }}
        >
          <colgroup>
            <col style={{ width: 48 }} />
            {columns.map((name, index) => (
              <col key={name} style={{ width: widths[index] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              {viewport.start > 0 && (
                <th
                  className="column-spacer"
                  colSpan={viewport.start}
                  aria-hidden="true"
                />
              )}
              {visibleColumns.map((c, offset) => (
                <th key={c} title={c}>
                  <span className="result-column-name">{c}</span>
                  <ColumnResizeHandle
                    name={c}
                    width={widths[viewport.start + offset]}
                    onResize={(width, persist) =>
                      sizing.resize(c, width, persist)
                    }
                    onAutoFit={() =>
                      sizing.resize(
                        c,
                        fitColumnWidth(
                          c,
                          rows.map((row) => row[c]),
                        ),
                      )
                    }
                  />
                </th>
              ))}
              {viewport.end < columns.length && (
                <th
                  className="column-spacer"
                  colSpan={columns.length - viewport.end}
                  aria-hidden="true"
                />
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                {viewport.start > 0 && (
                  <td
                    className="column-spacer"
                    colSpan={viewport.start}
                    aria-hidden="true"
                  />
                )}
                {visibleColumns.map((c) => (
                  <td key={c} title={r[c] === null ? "NULL" : cellText(r[c])}>
                    {r[c] === null ? <em>NULL</em> : cellText(r[c])}
                  </td>
                ))}
                {viewport.end < columns.length && (
                  <td
                    className="column-spacer"
                    colSpan={columns.length - viewport.end}
                    aria-hidden="true"
                  />
                )}
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
