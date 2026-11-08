import type { QueryTiming } from "./QueryTimer";
import {
  useEditorZoom,
  zoomEditor,
  setEditorFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
} from "./editor-zoom";
import { QueryResults, type ResultEditing } from "./QueryResults";
import { useSqlTabView } from "./view-state";
import { useStore } from "../schema/store";
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
  ZoomIn,
  ZoomOut,
  LoaderCircle,
  PanelBottom,
  Play,
  Square,
  Columns2,
  ArrowLeftRight,
  FolderOpen,
  Download,
} from "lucide-react";
import type { SqlDialect } from "./data-types";
import type { SqlTab, SqlLayout, DatabaseSchema } from "../../types/schema";
import { QueryTabs, openSqlFilesIntoTabs } from "./QueryTabs";
import { saveSqlFile } from "../../lib/platform/save-file";
import { Button } from "../../components/ui/button";
import { SqlEditor } from "./LazySqlEditor";
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
interface Props extends ResultEditing {
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
  timings?: Record<string, QueryTiming>;
  runningTabId?: string;
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

function SqlPane({
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
  timings,
  runningTabId,
  onSplit,
  connectionOptions,
  tabContext,
  onTabConnectionChange,
  onTabDatabaseChange,
  onDiscoverTabDatabases,
  onMoveTab,
  splitOpen,
  getEditableResult,
  onSaveResult,
  onEditingResult,
}: Props) {
  const isRunning = runningTabId === activeId;
  const fontSize = useEditorZoom((state) => state.fontSize);
  const workspaceId = useStore((state) => state.workspace.id);
  const viewKey = `${workspaceId}:${activeId}`;
  const [view, updateView] = useSqlTabView(viewKey);
  const selection = view.selection;
  const hasSelection = !!selection.trim();
  const [validationStatus, setValidationStatus] = useState("");
  const ratio = view.ratio;
  const results = view.resultsVisible;
  const setResults = (resultsVisible: boolean) =>
    updateView({ resultsVisible });
  const setRatio = (next: number | ((previous: number) => number)) =>
    updateView({ ratio: typeof next === "function" ? next(ratio) : next });
  const split = useRef<HTMLDivElement>(null);
  const sqlFileInput = useRef<HTMLInputElement>(null);
  const openTargetTabId = useRef<string | undefined>(undefined);

  function triggerOpenSqlFile(targetTabId?: string) {
    openTargetTabId.current = targetTabId ?? activeId;
    sqlFileInput.current?.click();
  }

  async function handleOpenSqlFiles(files: FileList | null) {
    const res = await openSqlFilesIntoTabs(
      tabs,
      activeId,
      openTargetTabId.current ?? activeId,
      files,
    );
    if (res) onTabsChange(res.tabs, res.activeId);
  }

  function handleSaveSqlTab(tab?: SqlTab) {
    const target = tab ?? tabs.find((t) => t.id === activeId) ?? tabs[0];
    if (!target) return;
    void saveSqlFile(target.name, target.sql);
  }

  return (
    <section
      className="sql-workspace"
      onFocusCapture={() => onSelection(selection)}
    >
      <input
        ref={sqlFileInput}
        type="file"
        accept=".sql,.txt,application/sql,text/plain"
        multiple
        hidden
        onChange={(e) => {
          void handleOpenSqlFiles(e.target.files);
          e.currentTarget.value = "";
        }}
      />
      <div className="compact-toolbar">
        <QueryTabs
          tabs={tabs}
          activeId={activeId}
          onTabsChange={onTabsChange}
          busy={busy}
          newTabSourceId={newTabSourceId}
          newTabConnectionName={
            newTabConnectionName ??
            connectionOptions?.find((source) => source.id === newTabSourceId)
              ?.name
          }
          onTabConnectionChange={onTabConnectionChange}
          onTabDatabaseChange={onTabDatabaseChange}
          onDiscoverTabDatabases={onDiscoverTabDatabases}
          onOpenSqlFile={triggerOpenSqlFile}
          onSaveSqlFile={handleSaveSqlTab}
        />
        <div className="row sql-toolbar-actions">
          <span
            className="sql-validation-status"
            role="status"
            title={
              validationStatus ||
              `${validationSource ?? "SQL"} checks SQL without executing it`
            }
          >
            {validationStatus}
          </span>
          <div
            className="sql-toolbar-group"
            role="group"
            aria-label="SQL file actions"
          >
            <Button
              className="sql-icon-button"
              title="Open SQL file (.sql)"
              aria-label="Open SQL file"
              disabled={busy}
              onClick={() => triggerOpenSqlFile(activeId)}
            >
              <FolderOpen size={14} />
            </Button>
            <Button
              className="sql-icon-button"
              title="Save active SQL tab (.sql)"
              aria-label="Save SQL file"
              disabled={busy || !tabs.length}
              onClick={() => handleSaveSqlTab()}
            >
              <Download size={14} />
            </Button>
          </div>
          <span className="sql-toolbar-divider" aria-hidden="true" />
          <div
            className="sql-toolbar-group"
            role="group"
            aria-label="SQL view actions"
          >
            <Button
              className="sql-icon-button"
              aria-label="Zoom out SQL code"
              title="Zoom out code (Ctrl/⌘ −)"
              disabled={fontSize <= MIN_EDITOR_FONT_SIZE}
              onClick={() => zoomEditor(-1)}
            >
              <ZoomOut size={14} />
            </Button>
            <Button
              className="sql-zoom-reset"
              aria-label={`SQL code font size ${fontSize}px. Reset zoom`}
              title="Reset code zoom to 14px (Ctrl/⌘ 0)"
              onClick={() => setEditorFontSize(DEFAULT_EDITOR_FONT_SIZE)}
            >
              {fontSize}px
            </Button>
            <Button
              className="sql-icon-button"
              aria-label="Zoom in SQL code"
              title="Zoom in code (Ctrl/⌘ +)"
              disabled={fontSize >= MAX_EDITOR_FONT_SIZE}
              onClick={() => zoomEditor(1)}
            >
              <ZoomIn size={14} />
            </Button>
            {splitOpen && (
              <Button
                className="sql-icon-button"
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
              className={"sql-icon-button" + (splitOpen ? " is-active" : "")}
              onClick={onSplit}
              disabled={busy}
            >
              <Columns2 size={14} />
            </Button>
            <Button
              title={results ? "Hide results" : "Show results"}
              disabled={busy}
              aria-pressed={results}
              className={"sql-icon-button" + (results ? " is-active" : "")}
              onClick={() => setResults(!results)}
            >
              <PanelBottom size={14} />
            </Button>
          </div>
          <span className="sql-toolbar-divider" aria-hidden="true" />
          <div
            className="sql-execution-control"
            role="group"
            aria-label="Query execution"
          >
            <Button
              title={
                isRunning && onCancel
                  ? "Stop the running query and skip remaining batches"
                  : validationSource === "SQL Server"
                    ? "Run selected T-SQL or the whole tab (F5 or Ctrl/⌘+Enter). Use GO on its own line to separate batches."
                    : "Run selected SQL or the whole tab (F5 or Ctrl/⌘+Enter). Separate SELECT queries with a blank line or semicolon."
              }
              className={
                "sql-run-button" +
                (isRunning && onCancel ? " sql-stop-button" : "")
              }
              data-action={isRunning && onCancel ? "stop" : "run"}
              aria-label={isRunning && onCancel ? "Stop query" : "Run SQL"}
              disabled={isRunning ? !onCancel || cancelPending : disabled}
              onClick={() => {
                if (isRunning) {
                  onCancel?.();
                  return;
                }
                if (!results) setResults(true);
                onRun(activeId, hasSelection ? selection : value);
              }}
            >
              {isRunning ? (
                cancelPending || !onCancel ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Square size={12} fill="currentColor" />
                )
              ) : (
                <Play size={12} fill="currentColor" strokeWidth={0} />
              )}
              <span>
                {isRunning && onCancel
                  ? cancelPending
                    ? "Stopping…"
                    : "Stop"
                  : "Run"}
              </span>
            </Button>
          </div>
        </div>
      </div>
      <div className="sql-split" ref={split}>
        <div
          className="sql-editor-pane"
          style={{ flex: results ? `0 0 ${ratio * 100}%` : "1 1 100%" }}
        >
          <SqlEditor
            viewKey={viewKey}
            autoFocus={autoFocus}
            readOnly={!!tabs.find((t) => t.id === activeId)?.locked}
            schema={tabContext?.schema}
            dialect={tabContext?.dialect}
            validationEnabled={!disabled && !busy}
            validate={validate}
            validationSource={validationSource}
            onValidation={setValidationStatus}
            onSelection={(sql) => {
              updateView({ selection: sql });
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
            <QueryResults
              timing={timings?.[activeId]}
              results={queryResults ?? []}
              tabId={activeId}
              viewKey={`sql:${viewKey}:${tabContext?.sourceId ?? "unassigned"}`}
              view={view}
              updateView={updateView}
              busy={busy}
              schema={tabContext?.schema}
              dialect={tabContext?.dialect}
              getEditableResult={getEditableResult}
              onSaveResult={onSaveResult}
              onEditingResult={onEditingResult}
            />
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
      {groups.map((group, index) => {
        const paneTabs = group.ids.flatMap((id) => {
          const tab = props.tabs.find((tab) => tab.id === id);
          return tab ? [tab] : [];
        });
        const tab =
          paneTabs.find((item) => item.id === group.activeId) ?? paneTabs[0];
        if (!tab) return null;
        const isPaneActive = group.ids.includes(props.activeId);
        return (
          <div
            key={index}
            className={
              "sql-pane-container " +
              (isPaneActive ? "is-active" : "")
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
            onPointerDownCapture={() => {
              if (props.busy) return;
              if (!isPaneActive && tab) {
                props.onTabsChange(props.tabs, tab.id);
              }
            }}
            onFocusCapture={() => {
              if (props.busy) return;
              if (!isPaneActive && tab) {
                props.onTabsChange(props.tabs, tab.id);
              }
            }}
          >
            <SqlPane
              {...props}
              tabs={paneTabs}
              autoFocus={focusTabId === tab.id || props.activeId === tab.id}
              tabContext={props.getTabContext?.(tab.id) ?? props.tabContext}
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
