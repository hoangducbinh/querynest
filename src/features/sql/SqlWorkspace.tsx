import { SnippetSettings } from "./SnippetSettings";
import { useRef, useState } from "react";
import {
  LoaderCircle,
  PanelBottom,
  Play,
  Braces,
  Columns2,
  X,
} from "lucide-react";
import type { SqlTab } from "../../types/schema";
import { QueryTabs } from "./QueryTabs";
import { Button } from "../../components/ui/button";
import { ResultGrid } from "../sample-data/ResultGrid";
import { SqlEditor } from "./Editor";
import type { SqlResult } from "./execution";
import type { SqlDiagnostic } from "./diagnostics";
interface Props {
  tabs: SqlTab[];
  activeId: string;
  onTabsChange: (tabs: SqlTab[], activeId: string) => void;
  value: string;
  onChange: (sql: string) => void;
  onRun: (tabId?: string, sql?: string) => void;
  disabled: boolean;
  busy: boolean;
  dark: boolean;
  queryResults?: SqlResult[];
  onSelection: (sql: string, tabId?: string) => void;
  allResults?: Record<string, SqlResult[]>;
  onSplit?: () => void;
  splitOpen?: boolean;
  validate?: (sql: string) => Promise<SqlDiagnostic[]>;
  validationSource?: string;
  onCancel?: () => void;
}
function SqlPane({
  tabs,
  activeId,
  onTabsChange,
  value,
  onChange,
  onRun,
  disabled,
  busy,
  dark,
  queryResults,
  onSelection,
  validate,
  validationSource,
  onCancel,
  onSplit,
  splitOpen,
}: Props) {
  const [selection, setSelection] = useState<{ tab: string; sql: string }>({
    tab: "",
    sql: "",
  });
  const [resultTabs, setResultTabs] = useState<Record<string, number>>({});
  const resultIndex = Math.min(
    resultTabs[activeId] ?? 0,
    Math.max(0, (queryResults?.length ?? 0) - 1),
  );
  const result = queryResults?.[resultIndex];
  const hasSelection = selection.tab === activeId && !!selection.sql.trim();
  const [validationStatus, setValidationStatus] = useState("");
  const [settings, setSettings] = useState(false);
  const [ratio, setRatio] = useState(0.7);
  const [results, setResults] = useState(true);
  const split = useRef<HTMLDivElement>(null);
  return (
    <section
      className="sql-workspace"
      onFocusCapture={() =>
        onSelection(selection.tab === activeId ? selection.sql : "")
      }
    >
      <div className="compact-toolbar">
        <QueryTabs
          tabs={tabs}
          activeId={activeId}
          onTabsChange={onTabsChange}
          busy={busy}
        />
        <div className="row">
          <span
            className="sql-validation-status"
            role="status"
            title={`${validationSource ?? "DuckDB"} checks SQL without executing it`}
          >
            {validationStatus}
          </span>
          <Button
            title={splitOpen ? "Close SQL split" : "Split SQL editor"}
            aria-label={splitOpen ? "Close SQL split" : "Split SQL editor"}
            onClick={onSplit}
            disabled={busy}
          >
            {splitOpen ? <X size={14} /> : <Columns2 size={14} />}
          </Button>
          <Button
            title="Configure SQL abbreviations"
            onClick={() => setSettings(true)}
          >
            <Braces size={14} />
            Abbreviations
          </Button>
          <Button
            title={results ? "Hide results" : "Show results"}
            aria-pressed={results}
            onClick={() => setResults(!results)}
          >
            <PanelBottom size={15} />
          </Button>
          {busy && onCancel && <Button onClick={onCancel}>Cancel query</Button>}
          <Button
            title={
              validationSource === "SQL Server"
                ? "Run selected T-SQL or the whole tab. Use GO on its own line to separate batches."
                : "Run selected SQL or the whole tab. Separate SELECT queries with a blank line or semicolon."
            }
            className="primary"
            disabled={disabled}
            onClick={() =>
              onRun(activeId, hasSelection ? selection.sql : value)
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Play size={13} />
            )}
            {hasSelection ? "Run selection" : "Run"}
            <kbd>⌘ ↵</kbd>
          </Button>
        </div>
      </div>
      <div className="sql-split" ref={split}>
        <div
          className="sql-editor-pane"
          style={{ flex: results ? `0 0 ${ratio * 100}%` : "1 1 100%" }}
        >
          <SqlEditor
            key={activeId}
            validationEnabled={!disabled}
            validate={validate}
            validationSource={validationSource}
            onValidation={setValidationStatus}
            onSelection={(sql) => {
              setSelection({ tab: activeId, sql });
              onSelection(sql);
            }}
            value={value}
            onChange={onChange}
            dark={dark}
          />
        </div>
        {results && (
          <>
            <div
              className="sql-divider"
              role="separator"
              aria-label="Resize SQL editor"
              aria-orientation="horizontal"
              aria-valuemin={20}
              aria-valuemax={85}
              aria-valuenow={Math.round(ratio * 100)}
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const rect = split.current!.getBoundingClientRect();
                setRatio(
                  Math.max(
                    0.2,
                    Math.min(0.85, (e.clientY - rect.top) / rect.height),
                  ),
                );
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setRatio((value) =>
                    Math.max(
                      0.2,
                      Math.min(
                        0.85,
                        value + (e.key === "ArrowUp" ? -0.05 : 0.05),
                      ),
                    ),
                  );
                }
                if (e.key === "Home") {
                  e.preventDefault();
                  setRatio(0.2);
                }
                if (e.key === "End") {
                  e.preventDefault();
                  setRatio(0.85);
                }
              }}
            >
              <span />
            </div>
            <div className="sql-results-pane">
              <div className="results-heading">
                <div className="row" role="tablist" aria-label="Query results">
                  {queryResults?.length ? (
                    queryResults.map((item, index) => (
                      <button
                        role="tab"
                        aria-selected={index === resultIndex}
                        title={item.sql}
                        key={index}
                        onClick={() =>
                          setResultTabs((current) => ({
                            ...current,
                            [activeId]: index,
                          }))
                        }
                      >
                        Result {index + 1}
                        {item.error ? " · Error" : ""}
                      </button>
                    ))
                  ) : (
                    <span>Results</span>
                  )}
                </div>
                <span>
                  {result?.error
                    ? "Query failed · remaining statements skipped"
                    : result?.status || "No results"}
                </span>
              </div>
              {result && (
                <details className="result-query-details" key={result.sql}>
                  <summary>SQL</summary>
                  <pre className="result-query">{result.sql}</pre>
                </details>
              )}
              {result?.error ? (
                <pre className="sheet-error" role="alert">
                  {result.status}
                </pre>
              ) : (
                <ResultGrid
                  rows={result?.rows ?? []}
                  columns={result?.columns ?? []}
                />
              )}
            </div>
          </>
        )}
      </div>
      {settings && <SnippetSettings onClose={() => setSettings(false)} />}
    </section>
  );
}

export function SqlWorkspace(props: Props) {
  const [paneIds, setPaneIds] = useState([props.activeId, ""]);
  const [width, setWidth] = useState(50);
  const container = useRef<HTMLDivElement>(null);
  const splitOpen = !!paneIds[1];
  function toggleSplit() {
    if (splitOpen) {
      const active = paneIds.find((id) => id === props.activeId) ?? paneIds[0];
      setPaneIds([active, ""]);
      return;
    }
    const other = props.tabs.find((tab) => tab.id !== paneIds[0]);
    const next = other ?? {
      id: crypto.randomUUID(),
      name: "split.sql",
      sql: "",
    };
    if (!other) props.onTabsChange([...props.tabs, next], props.activeId);
    setPaneIds([paneIds[0], next.id]);
  }
  return (
    <div
      className={"sql-panes " + (splitOpen ? "is-split" : "")}
      ref={container}
    >
      {paneIds.filter(Boolean).map((id, index) => {
        const tab =
          props.tabs.find((item) => item.id === id) ??
          props.tabs.find((item) => item.id === props.activeId) ??
          props.tabs[0];
        return (
          <div
            key={index}
            className="sql-pane-container"
            style={{
              flex: splitOpen
                ? index === 0
                  ? `0 0 ${width}%`
                  : "1 1 0"
                : "1 1 0",
            }}
            onFocusCapture={() => {
              if (props.activeId !== tab.id)
                props.onTabsChange(props.tabs, tab.id);
            }}
          >
            <SqlPane
              {...props}
              activeId={tab.id}
              value={tab.sql}
              splitOpen={splitOpen}
              onSplit={toggleSplit}
              queryResults={
                props.allResults?.[tab.id] ??
                (tab.id === props.activeId ? props.queryResults : undefined)
              }
              onTabsChange={(tabs, active) => {
                setPaneIds((ids) =>
                  ids.map((value, i) => (i === index ? active : value)),
                );
                props.onTabsChange(tabs, active);
              }}
              onChange={(sql) =>
                props.onTabsChange(
                  props.tabs.map((item) =>
                    item.id === tab.id ? { ...item, sql } : item,
                  ),
                  tab.id,
                )
              }
              onSelection={(sql) => props.onSelection(sql, tab.id)}
            />
            {splitOpen && index === 0 && (
              <div
                className="sql-pane-divider"
                role="separator"
                aria-label="Resize SQL split"
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(width)}
                tabIndex={0}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId))
                    return;
                  const rect = container.current!.getBoundingClientRect();
                  setWidth(
                    Math.max(
                      25,
                      Math.min(
                        75,
                        ((event.clientX - rect.left) / rect.width) * 100,
                      ),
                    ),
                  );
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  setWidth((value) =>
                    event.key === "Home"
                      ? 25
                      : event.key === "End"
                        ? 75
                        : Math.max(
                            25,
                            Math.min(
                              75,
                              value + (event.key === "ArrowLeft" ? -5 : 5),
                            ),
                          ),
                  );
                }}
              >
                <span />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
