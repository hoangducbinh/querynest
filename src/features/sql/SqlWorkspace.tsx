import { SnippetSettings } from "./SnippetSettings";
import { useRef, useState } from "react";
import { LoaderCircle, PanelBottom, Play, Braces } from "lucide-react";
import type { SqlTab } from "../../types/schema";
import { QueryTabs } from "./QueryTabs";
import { Button } from "../../components/ui/button";
import { ResultGrid } from "../sample-data/ResultGrid";
import { SqlEditor } from "./Editor";
import type { SqlResult } from "./execution";
interface Props {
  tabs: SqlTab[];
  activeId: string;
  onTabsChange: (tabs: SqlTab[], activeId: string) => void;
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  disabled: boolean;
  busy: boolean;
  dark: boolean;
  queryResults?: SqlResult[];
  onSelection: (sql: string) => void;
}
export function SqlWorkspace({
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
    <section className="sql-workspace">
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
            title="DuckDB checks SQL without executing it"
          >
            {validationStatus}
          </span>
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
          <Button
            title="Run selected SQL or the whole tab. Separate SELECT queries with a blank line or semicolon."
            className="primary"
            disabled={disabled}
            onClick={onRun}
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
              {result && <pre className="result-query">{result.sql}</pre>}
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
