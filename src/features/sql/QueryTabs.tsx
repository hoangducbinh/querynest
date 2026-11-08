import { reorderTabs, useTabReorder } from "./tab-reorder";
import { useEffect, useRef, useState, startTransition } from "react";
import {
  Code2,
  Plus,
  X,
  Check,
  Pin,
  PinOff,
  Lock,
  LockOpen,
  Pencil,
  Copy,
  Database,
  Server,
  ChevronRight,
  ChevronDown,
  Trash2,
  FolderOpen,
  Download,
} from "lucide-react";
import {
  useHorizontalWheelScroll,
  scrollActiveTabIntoView,
} from "../../lib/ui/use-horizontal-scroll";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { saveSqlFile } from "../../lib/platform/save-file";
import { useStore } from "../schema/store";
import {
  attachDatabase,
  connectionRoot,
  databaseSources,
  ensureSources,
  sourceSessionKey,
  tabSource,
  updateSource,
  workspaceSources,
} from "../connections/sources";
import { listDatabases } from "../connections/databases";
import {
  getSession,
  useSessionRevision,
} from "../connections/sessions";
import { isTauri } from "../postgres/client";
import { setSqlTabs, sqlTabs } from "./tabs";
import type { SqlTab } from "../../types/schema";

interface Props {
  tabs: SqlTab[];
  activeId: string;
  onTabsChange: (tabs: SqlTab[], activeId: string) => void;
  busy: boolean;
  newTabSourceId?: string;
  newTabConnectionName?: string;
  onTabConnectionChange?: (tabId: string, sourceId: string) => void;
  onTabDatabaseChange?: (tabId: string, database: string) => void;
  onDiscoverTabDatabases?: (tabId: string) => void;
  onOpenSqlFile?: (tabId?: string) => void;
  onSaveSqlFile?: (tab?: SqlTab) => void;
}

export async function openSqlFilesIntoTabs(
  tabs: SqlTab[],
  activeId: string,
  targetTabId: string | undefined,
  files: FileList | null,
): Promise<{ tabs: SqlTab[]; activeId: string } | null> {
  if (!files || !files.length) return null;
  const fileArray = Array.from(files);
  const targetId = targetTabId ?? activeId;
  const targetTab = tabs.find((t) => t.id === targetId) ?? tabs[0];
  let currentTabs = [...tabs];
  let nextActiveId = activeId;

  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];
    const text = await file.text();
    const rawBase =
      file.name
        .replace(/\.(sql|txt)$/i, "")
        .trim()
        .replace(/\s+/g, "-") || "query";
    let candidate = `${rawBase}.sql`;
    let num = 2;

    if (i === 0 && targetTab && !targetTab.locked && !targetTab.sql.trim()) {
      while (
        currentTabs.some((t) => t.id !== targetTab.id && t.name === candidate)
      ) {
        candidate = `${rawBase}-${num++}.sql`;
      }
      currentTabs = currentTabs.map((t) =>
        t.id === targetTab.id ? { ...t, name: candidate, sql: text } : t,
      );
      nextActiveId = targetTab.id;
    } else {
      while (currentTabs.some((t) => t.name === candidate)) {
        candidate = `${rawBase}-${num++}.sql`;
      }
      const created: SqlTab = {
        id: crypto.randomUUID(),
        name: candidate,
        sql: text,
        sourceId: targetTab?.sourceId,
      };
      currentTabs.push(created);
      nextActiveId = created.id;
    }
  }

  const ordered = [
    ...currentTabs.filter((item) => item.pinned),
    ...currentTabs.filter((item) => !item.pinned),
  ];
  return { tabs: ordered, activeId: nextActiveId };
}

export function QueryTabs({
  tabs,
  activeId,
  onTabsChange,
  busy,
  newTabSourceId,
  newTabConnectionName,
  onTabConnectionChange,
  onTabDatabaseChange,
  onDiscoverTabDatabases,
  onOpenSqlFile,
  onSaveSqlFile,
}: Props) {
  const workspace = useStore((state) => state.workspace);
  const editWorkspace = useStore((state) => state.edit);
  useSessionRevision();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabName, setTabName] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
    section: "none" | "connection" | "database";
  } | null>(null);
  const [dbFilter, setDbFilter] = useState("");
  const sqlFileInput = useRef<HTMLInputElement>(null);
  const openTargetTabId = useRef<string | null>(null);
  const [optimisticActiveId, setOptimisticActiveId] = useState<string | null>(null);

  useEffect(() => {
    setOptimisticActiveId(null);
  }, [activeId]);

  const currentActiveId =
    optimisticActiveId && tabs.some((t) => t.id === optimisticActiveId)
      ? optimisticActiveId
      : activeId;

  useHorizontalWheelScroll(container);

  useEffect(() => {
    scrollActiveTabIntoView(container.current, `[data-tab-id="${currentActiveId}"]`);
  }, [currentActiveId]);

  const selectTab = (targetId: string) => {
    if (targetId === currentActiveId) return;
    setOptimisticActiveId(targetId);
    scrollActiveTabIntoView(container.current, `[data-tab-id="${targetId}"]`);
    startTransition(() => {
      onTabsChange(tabs, targetId);
    });
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const allSources = workspaceSources(workspace);
  const rootSources = allSources.filter(
    (s) => s.connection && !s.parentSourceId,
  );

  function getTabContextInfo(tab: SqlTab, includeDatabases = false) {
    const source = tabSource(workspace, tab);
    const root = connectionRoot(workspace, source);
    const connName = source.connection ? root.name : "No connection";
    const connFullName = connName;
    const dbName = source.connection?.config.database ?? "";
    const databases =
      includeDatabases && source.connection
        ? (() => {
            const initialDb = root.connection?.config.database;
            const dbList = [
              ...(root.databases ?? []),
              ...(initialDb ? [initialDb] : []),
              ...databaseSources(workspace, root.id).flatMap((s) =>
                s.connection ? [s.connection.config.database] : [],
              ),
            ];
            const seen = new Set<string>();
            const result: string[] = [];
            for (const db of dbList) {
              if (!db) continue;
              const key = db.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                result.push(db);
              }
            }
            return result.sort((a, b) => a.localeCompare(b));
          })()
        : [];
    return {
      source,
      root,
      connName,
      connFullName,
      dbName,
      databases,
      isRemote: !!source.connection,
    };
  }

  function isRootConnected(root: (typeof rootSources)[number]) {
    return (
      !root.connection ||
      !!getSession(sourceSessionKey(workspace.id, root.id), root.connection)
    );
  }

  function discoverForTab(tab: SqlTab) {
    if (onDiscoverTabDatabases) {
      onDiscoverTabDatabases(tab.id);
      return;
    }
    const { source, root } = getTabContextInfo(tab);
    if (!source.connection || root.databases || !isTauri()) return;
    void listDatabases(workspace, source)
      .then((rawNames) => {
        const seen = new Set<string>();
        const names: string[] = [];
        for (const name of rawNames) {
          if (!name) continue;
          const key = name.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            names.push(name);
          }
        }
        if (useStore.getState().workspace.id === workspace.id) {
          editWorkspace((draft) => {
            ensureSources(draft);
            updateSource(draft, root.id, { databases: names });
          });
        }
      })
      .catch(() => {});
  }

  function handleChangeTabConnection(tabId: string, targetRootId: string) {
    if (onTabConnectionChange) {
      onTabConnectionChange(tabId, targetRootId);
    } else {
      editWorkspace((draft) => {
        ensureSources(draft);
        const currentTabs = sqlTabs(draft);
        setSqlTabs(
          draft,
          currentTabs.map((t) =>
            t.id === tabId
              ? { ...t, sourceId: targetRootId, disconnectedFrom: undefined }
              : t,
          ),
          tabId,
        );
      });
    }
    setContextMenu(null);
  }

  function handleChangeTabDatabase(tabId: string, database: string) {
    const targetTab = tabs.find((t) => t.id === tabId);
    if (!targetTab) return;
    if (onTabDatabaseChange) {
      onTabDatabaseChange(tabId, database);
    } else {
      editWorkspace((draft) => {
        ensureSources(draft);
        const src = tabSource(draft, targetTab);
        const root = connectionRoot(draft, src);
        const sourceId = attachDatabase(draft, root.id, database);
        const currentTabs = sqlTabs(draft);
        setSqlTabs(
          draft,
          currentTabs.map((t) =>
            t.id === tabId
              ? { ...t, sourceId, disconnectedFrom: undefined }
              : t,
          ),
          tabId,
        );
      });
    }
    setContextMenu(null);
  }

  function togglePinTab(tab: SqlTab) {
    const nextPinned = !tab.pinned;
    const updated = tabs.map((item) =>
      item.id === tab.id ? { ...item, pinned: nextPinned } : item,
    );
    const ordered = [
      ...updated.filter((item) => item.pinned),
      ...updated.filter((item) => !item.pinned),
    ];
    onTabsChange(ordered, activeId);
    setContextMenu(null);
  }

  function toggleLockTab(tab: SqlTab) {
    const updated = tabs.map((item) =>
      item.id === tab.id ? { ...item, locked: !tab.locked } : item,
    );
    onTabsChange(updated, activeId);
    setContextMenu(null);
  }

  function duplicateTab(tab: SqlTab) {
    const base = tab.name.replace(/\.sql$/i, "");
    let number = 1;
    let candidate = `${base}-copy.sql`;
    while (tabs.some((item) => item.name === candidate)) {
      number++;
      candidate = `${base}-copy-${number}.sql`;
    }
    const copy: SqlTab = {
      id: crypto.randomUUID(),
      name: candidate,
      sql: tab.sql,
      sourceId: tab.sourceId,
    };
    const idx = tabs.findIndex((item) => item.id === tab.id);
    const next = [...tabs];
    next.splice(idx + 1, 0, copy);
    const ordered = [
      ...next.filter((item) => item.pinned),
      ...next.filter((item) => !item.pinned),
    ];
    onTabsChange(ordered, copy.id);
    setContextMenu(null);
  }

  function triggerOpenSqlFile(targetTabId?: string) {
    setContextMenu(null);
    if (onOpenSqlFile) {
      onOpenSqlFile(targetTabId ?? activeId);
      return;
    }
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

  async function handleSaveSqlTab(tab?: SqlTab) {
    const target = tab ?? tabs.find((t) => t.id === activeId) ?? tabs[0];
    setContextMenu(null);
    if (!target) return;
    if (onSaveSqlFile) {
      onSaveSqlFile(target);
      return;
    }
    await saveSqlFile(target.name, target.sql);
  }

  async function closeTab(tab: SqlTab) {
    setContextMenu(null);
    if (tab.pinned || tab.locked) return;
    if (
      tab.sql.trim() &&
      !(await confirmAction(
        `The SQL in “${tab.name}” will be removed from this session.`,
        {
          title: "Close query?",
          confirmLabel: "Close query",
          destructive: true,
        },
      ))
    )
      return;
    const remaining = tabs.filter((item) => item.id !== tab.id);
    if (!remaining.length) {
      const next = {
        id: crypto.randomUUID(),
        name: "query.sql",
        sql: "",
      };
      onTabsChange([next], next.id);
    } else
      onTabsChange(
        remaining,
        activeId === tab.id
          ? remaining[
              Math.max(0, tabs.findIndex((item) => item.id === tab.id) - 1)
            ].id
          : activeId,
      );
  }

  async function closeOtherTabs(keepTab: SqlTab) {
    setContextMenu(null);
    const toClose = tabs.filter(
      (item) => item.id !== keepTab.id && !item.pinned && !item.locked,
    );
    if (!toClose.length) return;
    if (
      toClose.some((item) => item.sql.trim()) &&
      !(await confirmAction(
        `Close ${toClose.length} other unlocked/unpinned tab${toClose.length === 1 ? "" : "s"}? Unsaved SQL in those tabs will be removed.`,
        {
          title: "Close other tabs?",
          confirmLabel: "Close others",
          destructive: true,
        },
      ))
    )
      return;
    const remaining = tabs.filter(
      (item) => item.id === keepTab.id || item.pinned || item.locked,
    );
    onTabsChange(remaining, keepTab.id);
  }

  async function closeTabsToRight(fromTab: SqlTab) {
    setContextMenu(null);
    const idx = tabs.findIndex((item) => item.id === fromTab.id);
    if (idx < 0) return;
    const toClose = tabs
      .slice(idx + 1)
      .filter((item) => !item.pinned && !item.locked);
    if (!toClose.length) return;
    if (
      toClose.some((item) => item.sql.trim()) &&
      !(await confirmAction(
        `Close ${toClose.length} unlocked/unpinned tab${toClose.length === 1 ? "" : "s"} to the right? Unsaved SQL in those tabs will be removed.`,
        {
          title: "Close tabs to the right?",
          confirmLabel: "Close to right",
          destructive: true,
        },
      ))
    )
      return;
    const remaining = tabs.filter(
      (item, i) => i <= idx || item.pinned || item.locked,
    );
    const nextActive = remaining.some((t) => t.id === activeId)
      ? activeId
      : fromTab.id;
    onTabsChange(remaining, nextActive);
  }

  const tabDrag = useTabReorder(
    !busy,
    (source, target, side) => {
      const ordered = reorderTabs(tabs, source, target, side);
      if (ordered !== tabs) onTabsChange(ordered, activeId);
    },
    (source, target) =>
      !!tabs.find((tab) => tab.id === source)?.pinned ===
      !!tabs.find((tab) => tab.id === target)?.pinned,
  );
  const contextTab = contextMenu
    ? tabs.find((t) => t.id === contextMenu.tabId)
    : undefined;
  const contextInfo = contextTab ? getTabContextInfo(contextTab, true) : undefined;

  return (
    <div className="sql-tabs-left-strip">
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
      <div
        ref={container}
        className="sql-tabs"
        role="tablist"
        aria-label="SQL queries"
      >
        {tabs.map((tab) => {
          const info = getTabContextInfo(tab);
          const isActive = tab.id === currentActiveId;
          const source = tabSource(workspace, tab);
          const root = connectionRoot(workspace, source);
          const tabColor = root.color;
          return (
            <div
              className={
                "sql-tab" +
                (isActive ? " active" : "") +
                (tab.pinned ? " is-pinned" : "") +
                (tab.locked ? " is-locked" : "")
              }
              key={tab.id}
              data-tab-id={tab.id}
              data-connection-color={tabColor ? "true" : undefined}
              style={
                tabColor
                  ? ({
                      "--conn-color": tabColor,
                      borderTop: `2px solid ${tabColor}`,
                    } as React.CSSProperties)
                  : undefined
              }
            {...tabDrag(tab.id, renaming !== tab.id)}
            onAuxClick={(event) => {
              if (
                event.button === 1 &&
                !busy &&
                !tab.pinned &&
                !tab.locked
              ) {
                event.preventDefault();
                event.stopPropagation();
                void closeTab(tab);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (busy) return;
              setDbFilter("");
              discoverForTab(tab);
              const x = Math.min(event.clientX, window.innerWidth - 240);
              const y = Math.min(event.clientY, window.innerHeight - 310);
              setContextMenu({
                tabId: tab.id,
                x: Math.max(8, x),
                y: Math.max(8, y),
                section: "none",
              });
            }}
          >
            {renaming === tab.id ? (
              <input
                aria-label="SQL tab name"
                autoFocus
                value={tabName}
                onChange={(e) => setTabName(e.target.value)}
                onBlur={() => {
                  if (tabName.trim())
                    onTabsChange(
                      tabs.map((item) =>
                        item.id === tab.id
                          ? { ...item, name: tabName.trim() }
                          : item,
                      ),
                      activeId,
                    );
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <button
                role="tab"
                disabled={busy}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(event) => {
                  if (
                    busy ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const index = tabs.findIndex((item) => item.id === tab.id);
                  const next =
                    tabs[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : (index +
                              (event.key === "ArrowRight"
                                ? 1
                                : tabs.length - 1)) %
                            tabs.length
                    ];
                  selectTab(next.id);
                  requestAnimationFrame(() => {
                    const button = Array.from(
                      container.current?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      ) ?? [],
                    ).find(
                      (item) =>
                        item.closest<HTMLElement>("[data-tab-id]")?.dataset
                          .tabId === next.id,
                    );
                    button?.focus();
                  });
                }}
                title={`${tab.name} · ${info.connFullName}${info.dbName ? " / " + info.dbName : ""}${tab.locked ? " · Locked" : ""}${tab.pinned ? " · Pinned" : ""}\n${tab.locked ? "Right-click to unlock or manage tab" : "Double-click to rename · Right-click for tab options"}`}
                onClick={() => selectTab(tab.id)}
                onDoubleClick={() => {
                  if (busy || tab.locked) return;
                  setTabName(tab.name);
                  setRenaming(tab.id);
                }}
              >
                {tab.pinned ? (
                  <Pin size={12} className="sql-tab-pin" />
                ) : tab.locked ? (
                  <Lock size={12} className="sql-tab-lock" />
                ) : (
                  <Code2 size={13} />
                )}
                <span className="sql-tab-label-group">
                  <span className="sql-tab-title">
                    <span>{tab.name}</span>
                    {tab.pinned && tab.locked && (
                      <Lock size={10} className="sql-tab-lock-inline" />
                    )}
                  </span>
                  <small className="sql-tab-context">
                    {info.connName}
                    {info.dbName ? " · " + info.dbName : ""}
                  </small>
                </span>
              </button>
            )}
            {!tab.pinned && !tab.locked && (
              <button
                className="sql-tab-close"
                aria-label={`Close ${tab.name}`}
                tabIndex={isActive ? 0 : -1}
                disabled={busy}
                onClick={() => void closeTab(tab)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      </div>
      <Button
        className="sql-icon-button sql-new-tab-button"
        title={
          newTabConnectionName
            ? `New SQL tab · ${newTabConnectionName}`
            : "New SQL tab"
        }
        disabled={busy}
        aria-label="New SQL tab"
        onClick={() => {
          let number = 1;
          while (tabs.some((tab) => tab.name === `query-${number}.sql`))
            number++;
          const activeTab = tabs.find((tab) => tab.id === currentActiveId);
          const next = {
            id: crypto.randomUUID(),
            name: `query-${number}.sql`,
            sql: "",
            sourceId: newTabSourceId ?? activeTab?.sourceId,
          };
          onTabsChange([...tabs, next], next.id);
        }}
      >
        <Plus size={14} />
      </Button>

      {contextMenu && contextTab && contextInfo && (
        <div
          ref={contextMenuRef}
          className="result-floating-menu result-context-menu sql-tab-context-menu"
          role="menu"
          aria-label={`Options for ${contextTab.name}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="sql-tab-context-header">
            <div className="sql-tab-context-title-row">
              <strong>{contextTab.name}</strong>
              <span className="sql-tab-badges">
                {contextTab.locked && (
                  <span className="sql-tab-locked-badge">Locked</span>
                )}
                {contextTab.pinned && (
                  <span className="sql-tab-pinned-badge">Pinned</span>
                )}
              </span>
            </div>
            <small>
              {contextInfo.connFullName} · {contextInfo.dbName}
            </small>
          </div>
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => triggerOpenSqlFile(contextTab.id)}
          >
            <span className="sql-tab-ctx-item">
              <FolderOpen size={12} />
              <span>Open SQL file…</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSaveSqlTab(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              <Download size={12} />
              <span>Save SQL file…</span>
            </span>
          </button>
          <hr />
          <button
            type="button"
            role="menuitem"
            disabled={!!contextTab.locked}
            title={
              contextTab.locked ? "Unlock editing before renaming" : undefined
            }
            onClick={() => {
              if (contextTab.locked) return;
              setTabName(contextTab.name);
              setRenaming(contextTab.id);
              setContextMenu(null);
            }}
          >
            <span className="sql-tab-ctx-item">
              <Pencil size={12} />
              <span>Rename tab…</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => togglePinTab(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              {contextTab.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              <span>{contextTab.pinned ? "Unpin tab" : "Pin to start"}</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => toggleLockTab(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              {contextTab.locked ? <LockOpen size={12} /> : <Lock size={12} />}
              <span>
                {contextTab.locked ? "Unlock editing" : "Lock editing"}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => duplicateTab(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              <Copy size={12} />
              <span>Duplicate tab</span>
            </span>
          </button>

          <hr />

          <button
            type="button"
            role="menuitem"
            aria-expanded={contextMenu.section === "connection"}
            onClick={() =>
              setContextMenu((prev) =>
                prev
                  ? {
                      ...prev,
                      section:
                        prev.section === "connection" ? "none" : "connection",
                    }
                  : null,
              )
            }
          >
            <span className="sql-tab-ctx-item">
              <Server size={12} />
              <span>Connection</span>
            </span>
            <span className="sql-tab-ctx-value">
              <span>{contextInfo.connName}</span>
              {contextMenu.section === "connection" ? (
                <ChevronDown size={11} />
              ) : (
                <ChevronRight size={11} />
              )}
            </span>
          </button>
          {contextMenu.section === "connection" && (
            <div className="sql-tab-ctx-sublist" role="group">
              {rootSources.map((src) => {
                const label = src.name || "Database";
                const isSelected = src.id === contextInfo.root.id;
                const ready = isRootConnected(src);
                return (
                  <button
                    key={src.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={isSelected ? "is-selected" : undefined}
                    onClick={() =>
                      handleChangeTabConnection(contextTab.id, src.id)
                    }
                  >
                    <span className="sql-tab-ctx-check">
                      {isSelected && <Check size={11} />}
                    </span>
                    <span className="sql-tab-ctx-subname">{label}</span>
                    {src.connection && ready && (
                      <span className="connection-menu-dot" title="Connected" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            disabled={!contextInfo.isRemote}
            aria-expanded={contextMenu.section === "database"}
            title={
              contextInfo.isRemote
                ? "Switch database for this SQL tab"
                : "Select database"
            }
            onClick={() => {
              if (!contextInfo.isRemote) return;
              discoverForTab(contextTab);
              setContextMenu((prev) =>
                prev
                  ? {
                      ...prev,
                      section:
                        prev.section === "database" ? "none" : "database",
                    }
                  : null,
              );
            }}
          >
            <span className="sql-tab-ctx-item">
              <Database size={12} />
              <span>Database</span>
            </span>
            <span className="sql-tab-ctx-value">
              <span>{contextInfo.dbName}</span>
              {contextInfo.isRemote &&
                (contextMenu.section === "database" ? (
                  <ChevronDown size={11} />
                ) : (
                  <ChevronRight size={11} />
                ))}
            </span>
          </button>
          {contextMenu.section === "database" && contextInfo.isRemote && (
            <div className="sql-tab-ctx-sublist" role="group">
              {contextInfo.databases.length > 6 && (
                <div className="sql-tab-ctx-search">
                  <input
                    aria-label="Filter databases"
                    placeholder="Filter databases…"
                    value={dbFilter}
                    onChange={(e) => setDbFilter(e.target.value)}
                  />
                </div>
              )}
              {contextInfo.databases
                .filter((db) =>
                  db.toLowerCase().includes(dbFilter.toLowerCase()),
                )
                .map((db) => {
                  const isSelected = db === contextInfo.dbName;
                  return (
                    <button
                      key={db}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      className={isSelected ? "is-selected" : undefined}
                      onClick={() => handleChangeTabDatabase(contextTab.id, db)}
                    >
                      <span className="sql-tab-ctx-check">
                        {isSelected && <Check size={11} />}
                      </span>
                      <span className="sql-tab-ctx-subname">{db}</span>
                    </button>
                  );
                })}
            </div>
          )}

          <hr />

          <button
            type="button"
            role="menuitem"
            disabled={
              tabs.filter(
                (t) => t.id !== contextTab.id && !t.pinned && !t.locked,
              ).length === 0
            }
            onClick={() => void closeOtherTabs(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              <Trash2 size={12} />
              <span>Close other tabs</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={(() => {
              const idx = tabs.findIndex((t) => t.id === contextTab.id);
              return (
                idx < 0 ||
                tabs
                  .slice(idx + 1)
                  .filter((t) => !t.pinned && !t.locked).length === 0
              );
            })()}
            onClick={() => void closeTabsToRight(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              <Trash2 size={12} />
              <span>Close tabs to the right</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-item"
            disabled={!!contextTab.pinned || !!contextTab.locked}
            title={
              contextTab.pinned || contextTab.locked
                ? "Unpin and unlock this tab before closing"
                : undefined
            }
            onClick={() => void closeTab(contextTab)}
          >
            <span className="sql-tab-ctx-item">
              <X size={12} />
              <span>Close tab</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
