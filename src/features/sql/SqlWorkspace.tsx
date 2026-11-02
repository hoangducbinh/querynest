import { DatabasePicker } from "../connections/DatabasePicker";
import { ConnectionPicker } from "../connections/ConnectionPicker";
import { createPortal } from "react-dom";
import { bindNewTabs } from "./tabs";
import {
  initialPane,
  updatePaneTabs,
  splitPane,
  movePaneTab,
  restoreSqlLayout,
} from "./panes";
import { useRef, useState } from "react";
import {
  LoaderCircle,
  PanelBottom,
  Play,
  Square,
  Columns2,
  ArrowLeftRight,
} from "lucide-react";
import type { SqlDialect } from "./data-types";
import type { SqlTab, SqlLayout, DatabaseSchema } from "../../types/schema";
import { QueryTabs } from "./QueryTabs";
import { Button } from "../../components/ui/button";
import { ResultGrid } from "../sample-data/ResultGrid";
import { SqlEditor } from "./Editor";
import type { SqlResult } from "./execution";
import type { SqlDiagnostic } from "./diagnostics";
export interface TabContext {
  connectionRootId?: string;
  database?: string;
  databases?: string[];
  sourceId: string;
  schema: DatabaseSchema;
  dialect: SqlDialect;
  label: string;
  remote: boolean;
}
interface Props {
  connectionHost?: HTMLElement | null;
  connectionOptions?: { id: string; name: string }[];
  newTabSourceId?: string;
  newTabConnectionName?: string;
  autoFocus?: boolean;
  getTabContext?: (tabId: string) => TabContext;
  tabContext?: TabContext;
  onTabConnectionChange?: (tabId: string, sourceId: string) => void;
  onTabDatabaseChange?: (tabId: string, database: string) => void;
  onDiscoverTabDatabases?: (tabId: string) => void;
  validateTab?: (tabId: string, sql: string) => Promise<SqlDiagnostic[]>;
  tabs: SqlTab[];
  activeId: string;
  onTabsChange: (tabs: SqlTab[], activeId: string, layout?: SqlLayout) => void;
  layout?: SqlLayout;
  onLayoutChange: (layout: SqlLayout) => void;
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
  onMoveTab?: () => void;
  splitOpen?: boolean;
  validate?: (sql: string) => Promise<SqlDiagnostic[]>;
  validationSource?: string;
  onCancel?: () => void;
  cancelPending?: boolean;
}
function SqlConnectionControls({
  tabContext,
  connectionOptions,
  busy,
  activeId,
  onTabConnectionChange,
  onTabDatabaseChange,
  onDiscoverTabDatabases,
}: Pick<
  Props,
  | "tabContext"
  | "connectionOptions"
  | "busy"
  | "activeId"
  | "onTabConnectionChange"
  | "onTabDatabaseChange"
  | "onDiscoverTabDatabases"
>) {
  return (
    tabContext &&
    connectionOptions && (
      <>
        <ConnectionPicker
          value={tabContext.connectionRootId ?? tabContext.sourceId}
          disabled={busy}
          onSelect={(id) => onTabConnectionChange?.(activeId, id)}
        />
        <DatabasePicker
          value={tabContext.database ?? "main"}
          databases={tabContext.databases ?? ["main"]}
          disabled={busy || !tabContext.remote}
          onDiscover={() => onDiscoverTabDatabases?.(activeId)}
          onSelect={(database) => onTabDatabaseChange?.(activeId, database)}
        />
      </>
    )
  );
}

function SqlPane({
  connectionHost,
  tabs,
  autoFocus,
  newTabSourceId,
  newTabConnectionName,
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
  cancelPending = false,
  onSplit,
  connectionOptions,
  tabContext,
  onTabConnectionChange,
  onTabDatabaseChange,
  onDiscoverTabDatabases,
  onMoveTab,
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
          newTabConnectionName={
            newTabConnectionName ??
            connectionOptions?.find((source) => source.id === newTabSourceId)
              ?.name
          }
        />
        <div className="row">
          {!connectionHost && (
            <SqlConnectionControls
              tabContext={tabContext}
              connectionOptions={connectionOptions}
              busy={busy}
              activeId={activeId}
              onTabConnectionChange={onTabConnectionChange}
              onTabDatabaseChange={onTabDatabaseChange}
              onDiscoverTabDatabases={onDiscoverTabDatabases}
            />
          )}
          <span
            className="sql-validation-status"
            role="status"
            title={
              validationStatus ||
              `${validationSource ?? "DuckDB"} checks SQL without executing it`
            }
          >
            {validationStatus}
          </span>
          {splitOpen && (
            <Button
              title="Move tab to other pane"
              onClick={onMoveTab}
              disabled={busy}
            >
              <ArrowLeftRight size={14} />
            </Button>
          )}
          <Button
            title={splitOpen ? "Close SQL split" : "Split SQL editor"}
            aria-pressed={!!splitOpen}
            className={splitOpen ? "is-active" : undefined}
            onClick={onSplit}
            disabled={busy}
          >
            <Columns2 size={14} />
          </Button>
          <Button
            title={results ? "Hide results" : "Show results"}
            aria-pressed={results}
            className={results ? "is-active" : undefined}
            onClick={() => setResults(!results)}
          >
            <PanelBottom size={14} />
          </Button>
          {busy && onCancel && (
            <Button
              className="sql-stop-button"
              aria-label="Stop query"
              title="Stop the running query and skip remaining batches"
              disabled={cancelPending}
              onClick={onCancel}
            >
              {cancelPending ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Square size={12} fill="currentColor" />
              )}
              <span aria-live="polite">
                {cancelPending ? "Stopping…" : "Stop"}
              </span>
            </Button>
          )}
          <Button
            title={
              validationSource === "SQL Server"
                ? "Run selected T-SQL or the whole tab. Use GO on its own line to separate batches."
                : "Run selected SQL or the whole tab. Separate SELECT queries with a blank line or semicolon."
            }
            className="sql-run-button"
            aria-label={hasSelection ? "Run selected SQL" : "Run SQL"}
            disabled={disabled}
            onClick={() =>
              onRun(activeId, hasSelection ? selection.sql : value)
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Play size={12} fill="currentColor" strokeWidth={0} />
            )}
            <span>{hasSelection ? "Run selection" : "Run"}</span>
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
            autoFocus={autoFocus}
            schema={tabContext?.schema}
            dialect={tabContext?.dialect}
            validationEnabled={
              !disabled &&
              !tabContext?.remote &&
              !(validate && validationSource !== "DuckDB")
            }
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
    </section>
  );
}

export function SqlWorkspace(props: Props) {
  const [focusTabId, setFocusTabId] = useState("");
  const layout = restoreSqlLayout(props.tabs, props.activeId, props.layout);
  const { groups, width } = layout;
  const setWidth = (width: number) =>
    props.onLayoutChange({ ...layout, width });
  const container = useRef<HTMLDivElement>(null);
  const splitOpen = groups.length === 2;
  function toggleSplit() {
    if (splitOpen) {
      props.onLayoutChange({
        ...layout,
        groups: [initialPane(props.tabs, props.activeId)],
      });
      return;
    }
    const next = splitPane(props.tabs, groups[0]);
    props.onTabsChange(
      bindNewTabs(
        next.tabs,
        props.tabs,
        props.newTabSourceId ?? props.getTabContext?.(props.activeId).sourceId,
      ),
      props.activeId,
      {
        ...layout,
        groups: next.groups,
      },
    );
  }
  return (
    <div
      className={"sql-panes " + (splitOpen ? "is-split" : "")}
      ref={container}
    >
      {props.connectionHost &&
        createPortal(
          <div
            className="titlebar-connection-controls"
            role="group"
            aria-label="Active SQL tab database"
            title={`Database for ${props.tabs.find((tab) => tab.id === props.activeId)?.name ?? "active SQL tab"}`}
          >
            <SqlConnectionControls
              {...props}
              tabContext={
                props.getTabContext?.(props.activeId) ?? props.tabContext
              }
            />
          </div>,
          props.connectionHost,
        )}
      {groups.map((group, index) => {
        const paneTabs = group.ids.flatMap((id) => {
          const tab = props.tabs.find((tab) => tab.id === id);
          return tab ? [tab] : [];
        });
        const tab =
          paneTabs.find((item) => item.id === group.activeId) ?? paneTabs[0];
        if (!tab) return null;
        return (
          <div
            key={index}
            className={
              "sql-pane-container " +
              (props.activeId === tab.id ? "is-active" : "")
            }
            role="region"
            aria-label={`SQL pane ${index + 1}`}
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
              tabs={paneTabs}
              autoFocus={focusTabId === tab.id}
              tabContext={props.getTabContext?.(tab.id)}
              validate={
                props.validateTab
                  ? (sql) => props.validateTab!(tab.id, sql)
                  : props.validate
              }
              validationSource={
                props.getTabContext?.(tab.id).label ?? props.validationSource
              }
              activeId={tab.id}
              value={tab.sql}
              splitOpen={splitOpen}
              onSplit={toggleSplit}
              onMoveTab={() => {
                const next = movePaneTab(props.tabs, groups, index);
                props.onTabsChange(
                  bindNewTabs(
                    next.tabs,
                    props.tabs,
                    props.newTabSourceId ??
                      props.getTabContext?.(tab.id).sourceId,
                  ),
                  next.activeId,
                  {
                    ...layout,
                    groups: next.groups,
                  },
                );
                requestAnimationFrame(() => {
                  container.current
                    ?.querySelectorAll(".sql-pane-container")
                    [1 - index]?.querySelector<HTMLElement>(
                      '[role="tab"][aria-selected="true"]',
                    )
                    ?.focus();
                });
              }}
              queryResults={
                props.allResults?.[tab.id] ??
                (tab.id === props.activeId ? props.queryResults : undefined)
              }
              onTabsChange={(tabs, active) => {
                if (!props.tabs.some((tab) => tab.id === active))
                  setFocusTabId(active);
                const next = updatePaneTabs(
                  props.tabs,
                  groups,
                  index,
                  bindNewTabs(
                    tabs,
                    props.tabs,
                    props.newTabSourceId ??
                      props.getTabContext?.(tab.id).sourceId,
                  ),
                  active,
                );
                props.onTabsChange(next.tabs, active, {
                  ...layout,
                  groups: next.groups,
                });
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
                  setWidth(
                    event.key === "Home"
                      ? 25
                      : event.key === "End"
                        ? 75
                        : Math.max(
                            25,
                            Math.min(
                              75,
                              width + (event.key === "ArrowLeft" ? -5 : 5),
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
