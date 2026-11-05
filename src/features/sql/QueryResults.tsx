import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  Rows3,
  ChevronDown,
  ChevronRight,
  Database,
  Maximize2,
  Table2,
  Terminal,
  MoreHorizontal,
  Check,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { EmptyResults } from "../sample-data/EmptyResults";
import type { DraftRow } from "../sample-data/model";
import type { DatabaseSchema, TableDefinition } from "../../types/schema";
import type { SqlDialect } from "./data-types";
import type { SqlResult } from "./execution";
import { inferResultTableTarget } from "./result-sql-copy";
import { ResultSetView, type StackBlockHeaderProps } from "./ResultSetView";
import type { SqlTabView } from "./view-state";

export interface ResultEditing {
  getEditableResult?: (
    tabId: string,
    result: SqlResult,
  ) => TableDefinition | undefined;
  onSaveResult?: (
    tabId: string,
    result: SqlResult,
    drafts: DraftRow[],
    index: number,
  ) => Promise<Record<string, unknown>[]>;
  onEditingResult?: (editing: boolean) => void;
}

function computeStackBlockHeight(result: SqlResult): number {
  if (result.error || !result.columns.length) return 76;
  const visibleRowCount = Math.min(Math.max(result.rows.length, 1), 6);
  // 26px block header + 26px table head + rows * 25px + 6px scrollbar/border allowance
  return 26 + 26 + visibleRowCount * 25 + 6;
}

export function QueryResults({
  results,
  tabId,
  viewKey,
  view,
  updateView,
  busy,
  schema,
  dialect,
  getEditableResult,
  onSaveResult,
  onEditingResult,
}: ResultEditing & {
  results: SqlResult[];
  tabId: string;
  viewKey: string;
  view: SqlTabView;
  updateView: (patch: Partial<SqlTabView>) => void;
  busy: boolean;
  schema?: DatabaseSchema;
  dialect?: SqlDialect;
}) {
  const [dirtySet, setDirtySet] = useState<Set<number>>(new Set());
  const [stackHeights, setStackHeights] = useState<Record<number, number>>({});
  const stackResizeDrag = useRef<{
    index: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const hasDirty = dirtySet.size > 0;
  const editingRef = useRef(false);
  const onEditingRef = useRef(onEditingResult);
  onEditingRef.current = onEditingResult;
  const getEditableRef = useRef(getEditableResult);
  getEditableRef.current = getEditableResult;
  const blockRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (editingRef.current !== hasDirty) {
      editingRef.current = hasDirty;
      onEditingRef.current?.(hasDirty);
    }
  }, [hasDirty]);

  useEffect(
    () => () => {
      if (editingRef.current) onEditingRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    setDirtySet(new Set());
    setStackHeights({});
    if (results.length && results.every((result) => !result.columns.length)) {
      updateView({ resultsMode: "messages" });
    } else if (
      results.some((result) => result.columns.length > 0) &&
      view.resultsMode === "messages"
    ) {
      updateView({ resultsMode: "tabs" });
    }
  }, [results]);

  const selected = Math.min(view.resultIndex, Math.max(0, results.length - 1));
  const mode =
    view.resultsMode === "all" && results.length <= 1
      ? "tabs"
      : view.resultsMode;
  const hasError = results.some((r) => r.error);

  const updateResultDirty = useCallback((index: number, isDirty: boolean) => {
    setDirtySet((prev) => {
      if (prev.has(index) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(index);
      else next.delete(index);
      return next;
    });
  }, []);

  const resultMeta = useMemo(
    () =>
      results.map((result, index) => {
        const editableTable = getEditableRef.current?.(tabId, result);
        const inferred = inferResultTableTarget(
          result.sql,
          schema,
          dialect,
          "",
        );
        const tableName = editableTable?.name ?? inferred.tableName;
        const tableSuffix = tableName ? ` · ${tableName}` : "";
        const label = `Result ${index + 1}${tableSuffix}${result.error ? " · Error" : ""}`;
        const shortLabel = tableName
          ? `#${index + 1} ${tableName}`
          : `Result ${index + 1}`;
        return {
          editableTable,
          label,
          shortLabel,
        };
      }),
    [results, tabId, schema, dialect],
  );

  function renderResultContent(
    result: SqlResult,
    index: number,
    stackHeader?: StackBlockHeaderProps,
  ) {
    if (result.error) {
      return (
        <pre className="sheet-error" role="alert">
          {result.status}
        </pre>
      );
    }
    if (!result.columns.length) {
      return <div className="query-completed">{result.status}</div>;
    }
    const table = resultMeta[index]?.editableTable;
    return (
      <ResultSetView
        viewKey={`${viewKey}:result:${index}`}
        result={result}
        table={table}
        schema={schema}
        dialect={dialect}
        disabled={busy && !hasDirty}
        onDirty={(isDirty) => updateResultDirty(index, isDirty)}
        onSave={
          table && onSaveResult
            ? (drafts) => onSaveResult(tabId, result, drafts, index)
            : undefined
        }
        stackHeader={stackHeader}
      />
    );
  }

  function editableBadge(index: number) {
    const table = resultMeta[index]?.editableTable;
    if (!table || !onSaveResult) return null;
    return (
      <span
        className="result-editable-badge"
        title={`Editable table: ${table.namespace ? table.namespace + "." : ""}${table.name}`}
      >
        <Database size={11} />
        <span>
          {table.namespace ? `${table.namespace}.` : ""}
          {table.name}
        </span>
      </span>
    );
  }

  function selectResultTab(index: number) {
    if (mode === "all") {
      const expanded = view.expandedResults.includes(index)
        ? view.expandedResults
        : [...view.expandedResults, index];
      updateView({ resultIndex: index, expandedResults: expanded });
      requestAnimationFrame(() => {
        blockRefs.current[index]?.scrollIntoView({
          block: "nearest",
        });
      });
      return;
    }
    updateView({ resultsMode: "tabs", resultIndex: index });
  }

  function toggleBlockCollapse(index: number) {
    updateView({
      resultIndex: index,
      expandedResults: view.expandedResults.includes(index)
        ? view.expandedResults.filter((i) => i !== index)
        : [...view.expandedResults, index],
    });
  }

  function toggleStackedView() {
    if (mode === "all") {
      updateView({ resultsMode: "tabs" });
    } else {
      const allIndices = results.map((_, idx) => idx);
      updateView({
        resultsMode: "all",
        expandedResults: view.expandedResults.length
          ? view.expandedResults
          : allIndices,
      });
    }
  }

  const tablistStripRef = useRef<HTMLDivElement>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    const el = tablistStripRef.current;
    if (!el) return;
    if (el.clientWidth > 0) {
      setStripWidth(el.clientWidth);
    }
    const obs = new ResizeObserver(([entry]) => {
      setStripWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const availableForTabs =
    stripWidth > 0 ? Math.max(120, stripWidth - 150) : 400;
  const resultCapacity = Math.max(1, Math.floor(availableForTabs / 150));
  const hasResultOverflow = results.length > resultCapacity;

  const visibleResults = useMemo(() => {
    if (!hasResultOverflow) {
      return results.map((result, index) => ({ result, index }));
    }
    const count = Math.max(1, resultCapacity);
    const list: { result: SqlResult; index: number }[] = [];
    for (let i = 0; i < count && i < results.length; i++) {
      list.push({ result: results[i], index: i });
    }
    if (mode !== "messages" && !list.some((item) => item.index === selected)) {
      if (selected >= 0 && selected < results.length) {
        list[list.length - 1] = { result: results[selected], index: selected };
      }
    }
    return list;
  }, [results, resultCapacity, hasResultOverflow, selected, mode]);

  return (
    <div className="sql-results-pane">
      <div className="query-output-toolbar unified-results-toolbar">
        <div ref={tablistStripRef} className="unified-results-left-strip">
          <div
            className="unified-results-tabs"
            role="tablist"
            aria-label="Query results"
          >
            {results.length ? (
              visibleResults.map(({ result, index }) => (
                <button
                  role="tab"
                  key={index}
                  aria-selected={mode !== "messages" && index === selected}
                  className={result.error ? "is-error-tab" : undefined}
                  title={result.sql}
                  disabled={
                    hasDirty && (mode === "messages" || index !== selected)
                  }
                  onClick={() => selectResultTab(index)}
                >
                  <Table2 size={12} />
                  <span>
                    {mode === "all"
                      ? (resultMeta[index]?.shortLabel ?? `Result ${index + 1}`)
                      : (resultMeta[index]?.label ?? `Result ${index + 1}`)}
                  </span>
                </button>
              ))
            ) : (
              <button
                role="tab"
                aria-selected={mode !== "messages"}
                disabled={hasDirty}
                onClick={() => updateView({ resultsMode: "tabs" })}
              >
                <Table2 size={12} />
                <span>Results</span>
              </button>
            )}
          </div>

          {hasResultOverflow && (
            <Popover.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className="results-tab-overflow-btn"
                  aria-label="More query results"
                  title={`All results (${results.length})`}
                >
                  <MoreHorizontal size={14} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="sql-tab-menu results-tab-overflow-menu"
                  sideOffset={6}
                  align="start"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <div className="sql-tab-menu-list">
                    {results.map((result, index) => {
                      const isCurrent =
                        mode !== "messages" && index === selected;
                      return (
                        <button
                          key={index}
                          disabled={hasDirty && !isCurrent}
                          onClick={() => {
                            selectResultTab(index);
                            setOverflowOpen(false);
                          }}
                        >
                          <Table2 size={13} />
                          <span className="sql-tab-menu-item-info">
                            <span>
                              {resultMeta[index]?.label ??
                                `Result ${index + 1}`}
                            </span>
                            {result.sql && (
                              <small>{result.sql.slice(0, 50)}</small>
                            )}
                          </span>
                          {result.error && <span className="status-dot red" />}
                          {isCurrent && <Check size={14} />}
                        </button>
                      );
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}

          <button
            role="tab"
            aria-selected={mode === "messages"}
            className={
              "unified-messages-tab" + (hasError ? " is-error-tab" : "")
            }
            disabled={hasDirty}
            onClick={() => updateView({ resultsMode: "messages" })}
          >
            <Terminal size={12} />
            <span>Messages</span>
            {hasError && <span className="status-dot amber" />}
          </button>
        </div>

        <div className="query-output-meta">
          {hasDirty ? (
            <span className="muted">
              Apply or discard changes before switching
            </span>
          ) : mode === "tabs" && results[selected] ? (
            <>
              {editableBadge(selected)}
              <span className="muted">{results[selected].status}</span>
            </>
          ) : mode === "all" ? (
            <span className="muted">
              {results.filter((r) => r.columns.length).length} sets
            </span>
          ) : (
            <span className="muted">
              {results.length
                ? `${results.length} statement${results.length === 1 ? "" : "s"}`
                : "No results"}
            </span>
          )}

          {results.length > 1 && (
            <Button
              className={mode === "all" ? "is-active" : undefined}
              aria-pressed={mode === "all"}
              disabled={hasDirty}
              title={
                mode === "all"
                  ? "Switch to single tab view"
                  : "Stack all result sets vertically"
              }
              onClick={toggleStackedView}
            >
              <Rows3 size={12} />
              <span>Stack</span>
            </Button>
          )}
        </div>
      </div>

      {mode === "messages" ? (
        <pre
          className="query-messages"
          tabIndex={0}
          aria-label="Query messages"
        >
          {results.length
            ? results
                .map((result, index) =>
                  [
                    `[${index + 1}] ${result.error ? "Error: " : ""}${result.status}`,
                    ...(result.messages ?? []),
                  ].join("\n"),
                )
                .join("\n\n")
            : "No messages. Run a query to view server output."}
        </pre>
      ) : mode === "all" ? (
        <div className="sql-all-results">
          {results.map((result, index) => {
            const isExpanded = view.expandedResults.includes(index);
            const hasTabularGrid = !result.error && result.columns.length > 0;
            const blockLabel =
              resultMeta[index]?.label ?? `Result ${index + 1}`;
            const defaultHeight = computeStackBlockHeight(result);
            const blockHeight = stackHeights[index] ?? defaultHeight;

            return (
              <section
                ref={(el) => {
                  blockRefs.current[index] = el;
                }}
                className="sql-result-block"
                style={isExpanded ? { height: blockHeight } : undefined}
                key={index}
                data-collapsed={!isExpanded}
              >
                {isExpanded && hasTabularGrid ? (
                  renderResultContent(result, index, {
                    index,
                    label: blockLabel,
                    sql: result.sql,
                    onToggleCollapse: () => toggleBlockCollapse(index),
                    onExpandToTab: () =>
                      updateView({ resultsMode: "tabs", resultIndex: index }),
                  })
                ) : (
                  <>
                    <header className="stack-block-header">
                      <button
                        type="button"
                        className="stack-header-toggle"
                        title={`${result.sql}\nClick to ${isExpanded ? "collapse" : "expand"}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleBlockCollapse(index)}
                      >
                        {isExpanded ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                        <strong>{blockLabel}</strong>
                        <span className="stack-row-badge">
                          {result.columns.length
                            ? `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`
                            : result.status}
                        </span>
                      </button>
                      <div className="stack-header-spacer" />
                      <div className="stack-header-actions">
                        <Button
                          data-icon-only="true"
                          title="Open in single tab view"
                          aria-label="Open in single tab view"
                          onClick={() =>
                            updateView({
                              resultsMode: "tabs",
                              resultIndex: index,
                            })
                          }
                        >
                          <Maximize2 size={11} />
                        </Button>
                      </div>
                    </header>
                    {isExpanded && renderResultContent(result, index)}
                  </>
                )}
                {isExpanded && (
                  <div
                    className="stack-block-resizer"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`Resize ${blockLabel} height`}
                    title="Drag to adjust result height · Double-click to reset"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      stackResizeDrag.current = {
                        index,
                        startY: event.clientY,
                        startHeight: blockHeight,
                      };
                    }}
                    onPointerMove={(event) => {
                      const activeDrag = stackResizeDrag.current;
                      if (!activeDrag || activeDrag.index !== index) return;
                      const nextHeight = Math.max(
                        76,
                        Math.min(
                          900,
                          Math.round(
                            activeDrag.startHeight +
                              (event.clientY - activeDrag.startY),
                          ),
                        ),
                      );
                      setStackHeights((prev) =>
                        prev[index] === nextHeight
                          ? prev
                          : { ...prev, [index]: nextHeight },
                      );
                    }}
                    onPointerUp={(event) => {
                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      ) {
                        event.currentTarget.releasePointerCapture(
                          event.pointerId,
                        );
                      }
                      stackResizeDrag.current = null;
                    }}
                    onPointerCancel={() => {
                      stackResizeDrag.current = null;
                    }}
                    onDoubleClick={() => {
                      setStackHeights((prev) => {
                        if (!(index in prev)) return prev;
                        const next = { ...prev };
                        delete next[index];
                        return next;
                      });
                    }}
                  />
                )}
              </section>
            );
          })}
          {!results.length && <EmptyResults />}
        </div>
      ) : (
        <div className="sql-single-result" key={`${viewKey}:${selected}`}>
          {results[selected] ? (
            renderResultContent(results[selected], selected)
          ) : (
            <EmptyResults />
          )}
        </div>
      )}
    </div>
  );
}
