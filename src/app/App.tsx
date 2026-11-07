import { installRunShortcut } from "./run-shortcut";
import { WorkspaceConnectionControls } from "../features/connections/WorkspaceConnectionControls";
import { SnippetSettings } from "../features/sql/SnippetSettings";
import { useLoadSnippetPreferences } from "../features/sql/snippet-preferences";
import { WindowControls } from "../lib/platform/WindowControls";
import {
  desktopPlatform,
  useDesktopChrome,
} from "../lib/platform/desktop-chrome";
import { ConnectionController } from "../features/connections/ConnectionController";
import { MultiSqlWorkspace } from "../features/connections/MultiSqlWorkspace";
import {
  activateSource,
  attachDatabase,
  attachSource,
  connectionRoot,
  removeSource,
  workspaceSources,
  sourceSessionKey,
  tabSource,
} from "../features/connections/sources";
import { restoreSqlLayout, updatePaneTabs } from "../features/sql/panes";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  invalidateSession,
  requestConnection,
} from "../features/connections/sessions";
import { readDarkAppearance, saveDarkAppearance } from "./appearance";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  SquareTerminal,
  Database,
  Ellipsis,
  Folder,
  FolderOpen,
  KeyRound,
  Link2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  Table2,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { DialogHost, confirmAction } from "../lib/dialogs";
import { useStore } from "../features/schema/store";
import { id } from "../features/schema/core";
import { activeSqlTab, sqlTabs, setSqlTabs } from "../features/sql/tabs";
import { RemoteWorkspace } from "../features/connections/RemoteWorkspace";
import type { ConnectionProfile } from "../features/connections/model";
import { useDesktopClose } from "../lib/platform/use-desktop-close";
import { saveWorkspace, storage } from "../lib/storage/workspaces";
import type { TableDefinition } from "../types/schema";
type Mode = "data" | "sql";
const modes = [
  { id: "data", label: "Data", icon: Database },
  { id: "sql", label: "SQL", icon: SquareTerminal },
] as const;
export default function App() {
  useLoadSnippetPreferences();
  const [abbreviations, setAbbreviations] = useState(false);
  const { workspace: w, edit, load } = useStore();
  const [mode, setMode] = useState<Mode>("sql");
  useLayoutEffect(() => {
    if (mode !== "sql" || !w.sources) return;
    const source = tabSource(w, activeSqlTab(w));
    if (source.id !== w.activeSourceId)
      edit((draft) => activateSource(draft, source.id));
  }, [mode, w, edit]);

  const [dataTable, setDataTable] = useState("");
  const [search, setSearch] = useState("");
  const [collapsedSchemas, setCollapsedSchemas] = useState<string[]>([]);
  const tableList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tableList.current?.scrollTo({ top: 0 });
  }, [search, w.id, w.activeSourceId]);

  const filteredTables = useMemo(() => {
    if (!w.postgres && !w.mssql) return [];
    const needle = search.trim().toLowerCase();
    const defaultSchema = w.mssql ? "dbo" : "public";
    return w.schema.tables.filter((table) => {
      const schemaName = table.namespace || defaultSchema;
      const full = `${schemaName}.${table.name}`.toLowerCase();
      return (
        !needle ||
        full.includes(needle) ||
        table.name.toLowerCase().includes(needle)
      );
    });
  }, [w.schema.tables, w.postgres, w.mssql, search]);

  const schemaGroups = useMemo(() => {
    if (!filteredTables.length) return [];
    const defaultSchema = w.mssql ? "dbo" : "public";
    const map = new Map<string, TableDefinition[]>();
    for (const table of filteredTables) {
      const schemaName = table.namespace || defaultSchema;
      const list = map.get(schemaName) ?? [];
      list.push(table);
      map.set(schemaName, list);
    }
    const sortedSchemas = Array.from(map.keys()).sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const isDefaultA = aLower === "public" || aLower === "dbo";
      const isDefaultB = bLower === "public" || bLower === "dbo";
      if (isDefaultA && !isDefaultB) return -1;
      if (!isDefaultA && isDefaultB) return 1;
      return a.localeCompare(b);
    });
    return sortedSchemas.map((name) => ({
      name,
      tables: (map.get(name) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
  }, [filteredTables, w.mssql]);

  function toggleSchema(schemaKey: string) {
    setCollapsedSchemas((prev) =>
      prev.includes(schemaKey)
        ? prev.filter((k) => k !== schemaKey)
        : [...prev, schemaKey],
    );
  }
  const [expandedTables, setExpandedTables] = useState<string[]>([]);
  const [left, setLeft] = useState(true);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connectionHost, setConnectionHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [sidebarWidth, setSidebarWidth] = useState(190);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeSidebar = (width: number) => {
    const available = workspaceRef.current?.clientWidth ?? 1000;
    setSidebarWidth(Math.max(160, Math.min(480, available - 420, width)));
  };
  const platform = desktopPlatform();
  const [dark, setDark] = useState(readDarkAppearance);
  useDesktopChrome(dark);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
    saveDarkAppearance(dark);
  }, [dark]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("Opening workspace…");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const remoteRun = useRef<() => void>(() => {});

  const remote = !!(w.postgres || w.mssql);
  const hasConnection = workspaceSources(w).some((source) => source.connection);
  const searchInput = useRef<HTMLInputElement>(null);
  const runRef = useRef<() => void>(() => {});
  const tablesById = useMemo(
    () => new Map(w.schema.tables.map((table) => [table.id, table])),
    [w.schema.tables],
  );
  const [closedAllDataTables, setClosedAllDataTables] = useState(false);
  const activeTable = closedAllDataTables
    ? undefined
    : (tablesById.get(dataTable) ?? w.schema.tables[0]);
  const [openDataTableIds, setOpenDataTableIds] = useState<string[]>([]);
  const [dataLayout, setDataLayout] = useState<"tabs" | "stack">("tabs");
  useEffect(() => {
    setOpenDataTableIds([]);
    setClosedAllDataTables(false);
  }, [w.id, w.activeSourceId]);
  useEffect(() => {
    if (!activeTable) return;
    setOpenDataTableIds((prev) =>
      prev.includes(activeTable.id) ? prev : [...prev, activeTable.id],
    );
  }, [activeTable?.id]);
  const openDataTables = useMemo(() => {
    const valid = openDataTableIds
      .map((tid) => tablesById.get(tid))
      .filter((t): t is TableDefinition => Boolean(t));
    if (!valid.length && activeTable && !closedAllDataTables)
      return [activeTable];
    return valid;
  }, [openDataTableIds, tablesById, activeTable, closedAllDataTables]);
  useEffect(() => {
    let active = true;
    storage.workspaces
      .orderBy("updatedAt")
      .last()
      .then((value) => {
        if (active) {
          if (value) load(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) {
          setSaved("Storage unavailable");
          setMessage(String(e));
          setError(true);
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const timer = setTimeout(() => {
      saveWorkspace(w)
        .then((ok) => {
          if (active)
            setSaved(ok ? "Saved on this device" : "Workspace deleted");
        })
        .catch((e) => {
          if (!active) return;
          setSaved("Save failed");
          setMessage(String(e));
          setError(true);
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [w, ready]);

  useEffect(() => {
    const SCROLLABLE_SELECTOR =
      ".sheet-grid-scroll, .grid-scroll, .sql-all-results, .data-stack-container, .query-messages, .table-list, .tree-columns, .sql-tab-menu-list, .sql-tab-ctx-sublist, .connection-menu-list, .snippet-list, .snippet-settings-body, .connection-fields, .modal, .sql-editor-pane";

    const vTrack = document.createElement("div");
    vTrack.className = "vscode-scrollbar vscode-scrollbar-v";
    vTrack.setAttribute("aria-hidden", "true");
    const vSlider = document.createElement("div");
    vSlider.className = "vscode-scrollbar-slider";
    vTrack.appendChild(vSlider);

    const hTrack = document.createElement("div");
    hTrack.className = "vscode-scrollbar vscode-scrollbar-h";
    hTrack.setAttribute("aria-hidden", "true");
    const hSlider = document.createElement("div");
    hSlider.className = "vscode-scrollbar-slider";
    hTrack.appendChild(hSlider);

    document.body.appendChild(vTrack);
    document.body.appendChild(hTrack);

    let lastPointerTarget: EventTarget | null = null;
    let lastWheelTarget: EventTarget | null = null;
    let pendingTarget: EventTarget | null = null;
    let pointerRaf = 0;
    let syncRaf = 0;
    let vHost: HTMLElement | null = null;
    let hHost: HTMLElement | null = null;
    let monacoPane: HTMLElement | null = null;

    let vMetrics = { trackSize: 0, thumbSize: 0, maxScroll: 0 };
    let hMetrics = { trackSize: 0, thumbSize: 0, maxScroll: 0 };

    let dragState: {
      axis: "v" | "h";
      host: HTMLElement;
      startPointer: number;
      startScroll: number;
      maxScroll: number;
      maxThumbOffset: number;
    } | null = null;

    const hasVerticalOverflow = (
      host: HTMLElement | null,
    ): host is HTMLElement => {
      if (!host || !host.isConnected) return false;
      if (host.scrollHeight <= host.clientHeight + 2) return false;
      const overflowY = window.getComputedStyle(host).overflowY;
      return (
        overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay"
      );
    };

    const hasHorizontalOverflow = (
      host: HTMLElement | null,
    ): host is HTMLElement => {
      if (!host || !host.isConnected) return false;
      if (host.scrollWidth <= host.clientWidth + 4) return false;
      const overflowX = window.getComputedStyle(host).overflowX;
      if (
        overflowX !== "auto" &&
        overflowX !== "scroll" &&
        overflowX !== "overlay"
      ) {
        return false;
      }
      if (
        host.classList.contains("grid-scroll") ||
        host.classList.contains("sheet-grid-scroll")
      ) {
        const table = host.firstElementChild as HTMLElement | null;
        const explicitWidth = table?.style.width
          ? Number.parseFloat(table.style.width)
          : 0;
        if (explicitWidth > 0 && explicitWidth <= host.clientWidth + 4) {
          return false;
        }
      }
      return true;
    };

    const syncScrollbars = () => {
      syncRaf = 0;

      const vActive = hasVerticalOverflow(vHost);
      const hActive = hasHorizontalOverflow(hHost);

      if (vActive && vHost) {
        const rect = vHost.getBoundingClientRect();
        if (rect.height > 20 && rect.width > 20) {
          const cornerGap = hActive && hHost === vHost ? 8 : 0;
          const trackHeight = Math.max(20, Math.round(rect.height - cornerGap));
          const scrollHeight = vHost.scrollHeight;
          const clientHeight = vHost.clientHeight;
          const maxScroll = Math.max(1, scrollHeight - clientHeight);
          const thumbHeight = Math.max(
            24,
            Math.min(
              trackHeight,
              Math.round((clientHeight / scrollHeight) * trackHeight),
            ),
          );
          const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
          const thumbTop = Math.min(
            maxThumbTop,
            Math.max(0, Math.round((vHost.scrollTop / maxScroll) * maxThumbTop)),
          );
          vMetrics = {
            trackSize: trackHeight,
            thumbSize: thumbHeight,
            maxScroll,
          };
          vTrack.style.transform = `translate3d(${Math.round(rect.right - 8)}px, ${Math.round(rect.top)}px, 0)`;
          vTrack.style.height = `${trackHeight}px`;
          vSlider.style.height = `${thumbHeight}px`;
          vSlider.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
          vTrack.classList.add("is-visible");
        } else {
          vTrack.classList.remove("is-visible");
        }
      } else {
        vTrack.classList.remove("is-visible");
      }

      if (hActive && hHost) {
        const rect = hHost.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          const cornerGap = vActive && vHost === hHost ? 8 : 0;
          const trackWidth = Math.max(20, Math.round(rect.width - cornerGap));
          const scrollWidth = hHost.scrollWidth;
          const clientWidth = hHost.clientWidth;
          const maxScroll = Math.max(1, scrollWidth - clientWidth);
          const thumbWidth = Math.max(
            24,
            Math.min(
              trackWidth,
              Math.round((clientWidth / scrollWidth) * trackWidth),
            ),
          );
          const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
          const thumbLeft = Math.min(
            maxThumbLeft,
            Math.max(
              0,
              Math.round((hHost.scrollLeft / maxScroll) * maxThumbLeft),
            ),
          );
          hMetrics = {
            trackSize: trackWidth,
            thumbSize: thumbWidth,
            maxScroll,
          };
          hTrack.style.transform = `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.bottom - 8)}px, 0)`;
          hTrack.style.width = `${trackWidth}px`;
          hSlider.style.width = `${thumbWidth}px`;
          hSlider.style.transform = `translate3d(${thumbLeft}px, 0, 0)`;
          hTrack.classList.add("is-visible");
        } else {
          hTrack.classList.remove("is-visible");
        }
      } else {
        hTrack.classList.remove("is-visible");
      }
    };

    const scheduleSync = () => {
      if (!syncRaf) {
        syncRaf = requestAnimationFrame(syncScrollbars);
      }
    };

    const resizeObserver = new ResizeObserver(scheduleSync);

    const setHosts = (
      nextV: HTMLElement | null,
      nextH: HTMLElement | null,
      nextMonaco: HTMLElement | null,
    ) => {
      if (monacoPane !== nextMonaco) {
        monacoPane?.classList.remove("is-scroll-visible");
        monacoPane = nextMonaco;
        monacoPane?.classList.add("is-scroll-visible");
      }
      if (vHost === nextV && hHost === nextH) return;
      resizeObserver.disconnect();
      vHost = nextV;
      hHost = nextH;
      if (vHost) resizeObserver.observe(vHost);
      if (hHost && hHost !== vHost) resizeObserver.observe(hHost);
      syncScrollbars();
    };

    const applyRegion = (rawTarget: EventTarget | null) => {
      if (dragState) return;
      const el = rawTarget instanceof Element ? rawTarget : null;
      if (!el) {
        setHosts(null, null, null);
        return;
      }
      if (el.closest(".vscode-scrollbar")) {
        return;
      }
      const matched = el.closest(SCROLLABLE_SELECTOR) as HTMLElement | null;
      if (!matched) {
        setHosts(null, null, null);
        return;
      }
      if (matched.classList.contains("sql-editor-pane")) {
        setHosts(null, null, matched);
        return;
      }
      const outerStack = matched.parentElement?.closest(
        ".sql-all-results, .data-stack-container",
      ) as HTMLElement | null;
      if (outerStack) {
        setHosts(outerStack, matched, null);
        return;
      }
      if (matched.matches(".sql-all-results, .data-stack-container")) {
        const block = el.closest(".sql-result-block, .data-stack-block");
        const innerGrid =
          (block?.querySelector(
            ".grid-scroll, .sheet-grid-scroll",
          ) as HTMLElement | null) ?? null;
        setHosts(matched, innerGrid, null);
        return;
      }
      setHosts(matched, matched, null);
    };

    const clearAll = () => {
      if (dragState) return;
      if (pointerRaf) {
        cancelAnimationFrame(pointerRaf);
        pointerRaf = 0;
      }
      if (syncRaf) {
        cancelAnimationFrame(syncRaf);
        syncRaf = 0;
      }
      lastPointerTarget = null;
      lastWheelTarget = null;
      pendingTarget = null;
      setHosts(null, null, null);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (dragState) {
        const delta =
          (dragState.axis === "v" ? e.clientY : e.clientX) -
          dragState.startPointer;
        const nextScroll =
          dragState.startScroll +
          (delta / Math.max(1, dragState.maxThumbOffset)) *
            dragState.maxScroll;
        if (dragState.axis === "v") {
          dragState.host.scrollTop = nextScroll;
        } else {
          dragState.host.scrollLeft = nextScroll;
        }
        scheduleSync();
        return;
      }
      if (e.target === lastPointerTarget) return;
      lastPointerTarget = e.target;
      pendingTarget = e.target;
      if (!pointerRaf) {
        pointerRaf = requestAnimationFrame(() => {
          pointerRaf = 0;
          applyRegion(pendingTarget);
        });
      }
    };

    const stopDrag = (e: PointerEvent) => {
      if (!dragState) return;
      dragState = null;
      vTrack.classList.remove("is-dragging");
      hTrack.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing-column");
      const hovered = document.elementFromPoint(e.clientX, e.clientY);
      applyRegion(hovered);
    };

    const handleVPointerDown = (e: PointerEvent) => {
      if (!vHost || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target === vSlider) {
        dragState = {
          axis: "v",
          host: vHost,
          startPointer: e.clientY,
          startScroll: vHost.scrollTop,
          maxScroll: vMetrics.maxScroll,
          maxThumbOffset: Math.max(1, vMetrics.trackSize - vMetrics.thumbSize),
        };
        vTrack.classList.add("is-dragging");
      } else {
        const sliderRect = vSlider.getBoundingClientRect();
        const dir = e.clientY < sliderRect.top ? -1 : 1;
        vHost.scrollTop += dir * Math.max(60, vHost.clientHeight * 0.85);
        scheduleSync();
      }
    };

    const handleHPointerDown = (e: PointerEvent) => {
      if (!hHost || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target === hSlider) {
        dragState = {
          axis: "h",
          host: hHost,
          startPointer: e.clientX,
          startScroll: hHost.scrollLeft,
          maxScroll: hMetrics.maxScroll,
          maxThumbOffset: Math.max(1, hMetrics.trackSize - hMetrics.thumbSize),
        };
        hTrack.classList.add("is-dragging");
      } else {
        const sliderRect = hSlider.getBoundingClientRect();
        const dir = e.clientX < sliderRect.left ? -1 : 1;
        hHost.scrollLeft += dir * Math.max(60, hHost.clientWidth * 0.85);
        scheduleSync();
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.target !== lastWheelTarget || (!vHost && !hHost && !monacoPane)) {
        lastWheelTarget = e.target;
        applyRegion(e.target);
      } else {
        scheduleSync();
      }
    };

    const handleScroll = (e: Event) => {
      if (e.target !== vHost && e.target !== hHost) {
        const target = e.target instanceof Element ? e.target : null;
        if (target && !target.closest(".sql-editor-pane")) {
          applyRegion(target);
          return;
        }
      }
      scheduleSync();
    };

    vTrack.addEventListener("pointerdown", handleVPointerDown);
    hTrack.addEventListener("pointerdown", handleHPointerDown);
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    window.addEventListener("pointerup", stopDrag, { passive: true });
    window.addEventListener("pointercancel", stopDrag, { passive: true });
    window.addEventListener("wheel", handleWheel, { passive: true });
    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", scheduleSync, { passive: true });
    document.documentElement.addEventListener("mouseleave", clearAll, {
      passive: true,
    });
    window.addEventListener("blur", clearAll);
    return () => {
      vTrack.removeEventListener("pointerdown", handleVPointerDown);
      hTrack.removeEventListener("pointerdown", handleHPointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", scheduleSync);
      document.documentElement.removeEventListener("mouseleave", clearAll);
      window.removeEventListener("blur", clearAll);
      resizeObserver.disconnect();
      clearAll();
      vTrack.remove();
      hTrack.remove();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLeft(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runRef.current();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "s" &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        void saveWorkspace(useStore.getState().workspace)
          .then(() => setSaved("Saved on this device"))
          .catch((e) => {
            setMessage(String(e));
            setError(true);
          });
      }
    };
    const removeRunShortcut = installRunShortcut(window, document);
    const blockNativeContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("contextmenu", blockNativeContextMenu);
    return () => {
      removeRunShortcut();
      window.removeEventListener("keydown", handler);
      window.removeEventListener("contextmenu", blockNativeContextMenu);
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!message || error) return;
    const timer = setTimeout(() => setMessage(""), 3000);
    return () => clearTimeout(timer);
  }, [message, error]);
  async function leaveDraft() {
    if (busy) return false;
    if (
      dirty &&
      !(await confirmAction("Your unsaved changes will be lost.", {
        title: "Discard changes?",
        confirmLabel: "Discard",
        destructive: true,
      }))
    )
      return false;
    return true;
  }
  useDesktopClose(
    async () => {
      if (!ready || !(await leaveDraft())) return false;
      await saveWorkspace(w);
      return true;
    },
    (error) => {
      setMessage(String(error));
      setError(true);
    },
  );
  async function changeMode(next: Mode) {
    if (next === mode || !(await leaveDraft())) return;
    setMode(next);
  }
  async function chooseTable(tableId: string) {
    setClosedAllDataTables(false);
    setOpenDataTableIds((prev) =>
      prev.includes(tableId) ? prev : [...prev, tableId],
    );
    if (tableId === activeTable?.id) return;
    if (!(await leaveDraft())) return;
    setDataTable(tableId);
  }
  function tableExpansionKey(tableId: string) {
    return `${w.id}:${w.activeSourceId ?? "primary"}:${tableId}`;
  }
  function toggleTableColumns(tableId: string) {
    const key = tableExpansionKey(tableId);
    setExpandedTables((items) =>
      items.includes(key)
        ? items.filter((item) => item !== key)
        : [...items, key],
    );
  }
  async function openTableData(tableId: string) {
    if (!(await leaveDraft())) return;
    setClosedAllDataTables(false);
    setOpenDataTableIds((items) =>
      items.includes(tableId) ? items : [...items, tableId],
    );
    setDataTable(tableId);
    const key = tableExpansionKey(tableId);
    setExpandedTables((items) =>
      items.includes(key) ? items : [...items, key],
    );
    setMode("data");
  }
  async function closeDataTable(tableId: string) {
    if (tableId === activeTable?.id && !(await leaveDraft())) return;
    const idx = openDataTables.findIndex((t) => t.id === tableId);
    const remaining = openDataTables.filter((t) => t.id !== tableId);
    setOpenDataTableIds(remaining.map((t) => t.id));
    if (!remaining.length) {
      setDataTable("");
      setClosedAllDataTables(true);
    } else if (tableId === activeTable?.id) {
      setDataTable(remaining[Math.max(0, idx - 1)].id);
    }
  }
  async function closeDataTablesBatch(
    remainingIds: string[],
    nextActiveId?: string,
  ) {
    const activeRemoved =
      activeTable &&
      (!remainingIds.includes(activeTable.id) ||
        (nextActiveId && nextActiveId !== activeTable.id));
    if (activeRemoved && !(await leaveDraft())) return;
    setOpenDataTableIds(remainingIds);
    if (!remainingIds.length) {
      setDataTable("");
      setClosedAllDataTables(true);
    } else {
      setClosedAllDataTables(false);
      const targetId =
        nextActiveId && remainingIds.includes(nextActiveId)
          ? nextActiveId
          : activeTable && remainingIds.includes(activeTable.id)
            ? activeTable.id
            : remainingIds[remainingIds.length - 1];
      setDataTable(targetId);
    }
  }
  runRef.current = () => {
    if (mode === "sql" && (remote || w.sources)) {
      remoteRun.current();
    }
  };
  async function selectConnection(sourceId: string) {
    if (sourceId === (w.activeSourceId ?? "primary")) return true;
    if (!(await leaveDraft())) return false;
    edit((draft) => {
      activateSource(draft, sourceId);
      if (mode === "sql") {
        const active = activeSqlTab(draft).id;
        setSqlTabs(
          draft,
          sqlTabs(draft).map((tab) =>
            tab.id === active
              ? { ...tab, sourceId, disconnectedFrom: undefined }
              : tab,
          ),
          active,
        );
      }
    });
    setDataTable("");
    setSearch("");
    return true;
  }
  async function selectWorkspaceDatabase(rootId: string, database: string) {
    if (!(await leaveDraft())) return;
    edit((draft) => {
      const sourceId = attachDatabase(draft, rootId, database);
      if (mode === "sql") {
        const active = activeSqlTab(draft).id;
        setSqlTabs(
          draft,
          sqlTabs(draft).map((tab) =>
            tab.id === active
              ? { ...tab, sourceId, disconnectedFrom: undefined }
              : tab,
          ),
          active,
        );
      } else activateSource(draft, sourceId);
    });
    setDataTable("");
    setSearch("");
  }
  async function addWorkspaceConnection(profile?: ConnectionProfile) {
    if (!profile || !(await leaveDraft())) return false;
    edit((draft) => {
      const sourceId = attachSource(draft, profile);
      activateSource(draft, sourceId);
      const tabs = sqlTabs(draft);
      const active = activeSqlTab(draft).id;
      const belongsToConnection = (tab: (typeof tabs)[number]) =>
        connectionRoot(draft, tabSource(draft, tab)).id === sourceId;
      const existing =
        tabs.find((tab) => tab.id === active && belongsToConnection(tab)) ??
        tabs.find(belongsToConnection);
      if (existing) {
        activateSource(draft, tabSource(draft, existing).id);
        setSqlTabs(draft, tabs, existing.id);
        return;
      }
      const tab = { id: id(), name: profile.name + ".sql", sql: "", sourceId };
      const layout = restoreSqlLayout(tabs, active, draft.sqlLayout);
      const index = Math.max(
        0,
        layout.groups.findIndex((group) => group.ids.includes(active)),
      );
      const owned = layout.groups[index].ids.map((tabId) =>
        tabs.find((tab) => tab.id === tabId)!,
      );
      const next = updatePaneTabs(
        tabs,
        layout.groups,
        index,
        [...owned, tab],
        tab.id,
      );
      setSqlTabs(draft, next.tabs, tab.id, { ...layout, groups: next.groups });
    });
    setMode("sql");
    setDataTable("");
    setSearch("");
  }
  function detachWorkspaceConnection(sourceId: string) {
    for (const item of workspaceSources(w).filter(
      (s) => s.id === sourceId || s.parentSourceId === sourceId,
    ))
      invalidateSession(sourceSessionKey(w.id, item.id));
    edit((draft) => removeSource(draft, sourceId));
    setDataTable("");
    setSearch("");
  }
  return (
    <div
      className={
        "app " +
        (busy ? "is-working " : "") +
        (dark ? "dark " : "") +
        (platform !== "web" ? `desktop desktop-${platform}` : "")
      }
    >
      <DialogHost />
      {abbreviations && (
        <SnippetSettings key={w.id} onClose={() => setAbbreviations(false)} />
      )}
      <header className="app-header" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <div className="titlebar-connection-host" ref={setConnectionHost}>
            {!(mode === "sql" && hasConnection && w.sources) && (
              <WorkspaceConnectionControls
                workspace={w}
                busy={busy}
                onSelect={selectConnection}
                onDatabaseChange={selectWorkspaceDatabase}
                onError={(error) => {
                  setMessage(String(error));
                  setError(true);
                }}
              />
            )}
          </div>
          <ConnectionController
            onAttach={addWorkspaceConnection}
            workspace={w}
            busy={busy}
            onDisconnect={detachWorkspaceConnection}
            onBeforeAction={leaveDraft}
            onConnected={async (sourceId) => {
              const current = useStore.getState().workspace;
              const active = workspaceSources(current).find(
                (source) => source.id === current.activeSourceId,
              );
              if (
                sourceId &&
                (!active || connectionRoot(current, active).id !== sourceId)
              )
                await selectConnection(sourceId);
              setConnectionRevision((revision) => revision + 1);
            }}
            onError={(error) => {
              setMessage(String(error));
              setError(true);
            }}
          />
        </div>
        <nav className="mode-switch" aria-label="View" data-tauri-drag-region>
          {modes.map((item) => (
            <button
              key={item.id}
              aria-current={mode === item.id ? "page" : undefined}
              onClick={() => void changeMode(item.id)}
            >
              <item.icon size={13} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="header-actions" data-tauri-drag-region>
          <span
            className="save-indicator"
            title={saved}
            aria-label={busy ? "Working" : saved}
          >
            <span className="status-dot" />
          </span>
          {hasConnection && (
            <Button
              title={left ? "Hide sidebar" : "Show sidebar"}
              aria-expanded={left}
              aria-controls="table-explorer"
              onClick={() => setLeft((visible) => !visible)}
            >
              {left ? (
                <PanelLeftClose size={15} />
              ) : (
                <PanelLeftOpen size={15} />
              )}
            </Button>
          )}
          <Button
            title={dark ? "Light appearance" : "Dark appearance"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
          <details
            className="workspace-menu"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button"))
                e.currentTarget.removeAttribute("open");
            }}
          >
            <summary aria-label="App settings">
              <Ellipsis size={17} />
            </summary>
            <div>
              <Button onClick={() => setAbbreviations(true)}>
                <Braces size={15} />
                SQL abbreviations
              </Button>
            </div>
          </details>
        </div>
      </header>
      {platform === "windows" && <WindowControls />}
      <div className="workspace" ref={workspaceRef}>
        {left && hasConnection && (
          <aside
            id="table-explorer"
            className="explorer"
            style={{ width: sidebarWidth }}
          >
            <div className="search">
              <Search size={15} />
              <input
                ref={searchInput}
                aria-label="Search tables"
                placeholder="Search tables"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>⌘ K</kbd>
            </div>
            <div className="section-heading">
              <span>SCHEMAS</span>
              <span
                title={
                  remote
                    ? `${schemaGroups.length} schema${schemaGroups.length === 1 ? "" : "s"} · ${filteredTables.length} table${filteredTables.length === 1 ? "" : "s"}`
                    : undefined
                }
              >
                {remote
                  ? `${schemaGroups.length} · ${filteredTables.length}`
                  : 0}
              </span>
            </div>
            <div className="table-list" ref={tableList}>
              {schemaGroups.map((group) => {
                const schemaKey = `${w.id}:${w.activeSourceId ?? "primary"}:${group.name}`;
                const isCollapsed =
                  !search.trim() && collapsedSchemas.includes(schemaKey);
                return (
                  <div key={group.name} className="tree-schema-group">
                    <button
                      type="button"
                      className="tree-schema-header"
                      onClick={() => toggleSchema(schemaKey)}
                      title={`Schema ${group.name} (${group.tables.length} table${group.tables.length === 1 ? "" : "s"})`}
                      aria-expanded={!isCollapsed}
                    >
                      <span className="tree-schema-arrow">
                        {isCollapsed ? (
                          <ChevronRight size={12} />
                        ) : (
                          <ChevronDown size={12} />
                        )}
                      </span>
                      <span className="tree-schema-icon">
                        {isCollapsed ? (
                          <Folder size={14} />
                        ) : (
                          <FolderOpen size={14} />
                        )}
                      </span>
                      <span className="tree-schema-label">
                        <strong>{group.name}</strong>
                      </span>
                      <span className="tree-schema-count">
                        {group.tables.length}
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="tree-schema-tables">
                        {group.tables.map((table) => (
                          <div key={table.id}>
                            <div className="tree-table-row">
                              <button
                                className={
                                  "tree-table " +
                                  (activeTable?.id === table.id ? "active" : "")
                                }
                                title={
                                  mode === "sql"
                                    ? `Click to toggle columns · Double-click to open Data (${table.namespace ? table.namespace + "." : ""}${table.name})`
                                    : `Select table · Double-click to open Data (${table.namespace ? table.namespace + "." : ""}${table.name})`
                                }
                                aria-expanded={
                                  mode === "sql"
                                    ? expandedTables.includes(
                                        tableExpansionKey(table.id),
                                      )
                                    : undefined
                                }
                                onClick={(event) => {
                                  if (event.detail > 1) return;
                                  if (mode === "sql")
                                    toggleTableColumns(table.id);
                                  else void chooseTable(table.id);
                                }}
                                onDoubleClick={() =>
                                  void openTableData(table.id)
                                }
                              >
                                <span className="table-icon">
                                  <Table2 size={16} />
                                </span>
                                <span className="table-label">
                                  <strong>{table.name}</strong>
                                </span>
                              </button>
                              <Button
                                className="table-columns-toggle"
                                title={`Toggle columns · ${table.name}`}
                                aria-label={`Toggle columns · ${table.name}`}
                                aria-expanded={expandedTables.includes(
                                  tableExpansionKey(table.id),
                                )}
                                onClick={async () => {
                                  if (mode !== "sql") {
                                    if (!(await leaveDraft())) return;
                                    setDataTable(table.id);
                                  }
                                  toggleTableColumns(table.id);
                                }}
                              >
                                {expandedTables.includes(
                                  tableExpansionKey(table.id),
                                ) ? (
                                  <ChevronDown size={12} />
                                ) : (
                                  <ChevronRight size={12} />
                                )}
                              </Button>
                            </div>
                            {expandedTables.includes(
                              tableExpansionKey(table.id),
                            ) && (
                              <div className="tree-columns">
                                {table.columns.map((c) => (
                                  <button
                                    key={c.id}
                                    disabled
                                    title={`${table.namespace ? table.namespace + "." : ""}${table.name}.${c.name} · ${c.nativeType ?? c.type}${table.primaryKey.includes(c.id) ? " · Primary key" : ""}${!c.nullable ? " · Required" : ""}`}
                                  >
                                    {table.primaryKey.includes(c.id) ? (
                                      <KeyRound size={11} className="gold" />
                                    ) : w.schema.relationships.some((r) =>
                                        r.sourceColumns.includes(c.id),
                                      ) ? (
                                      <Link2 size={11} className="blue" />
                                    ) : (
                                      <span className="column-dot" />
                                    )}
                                    <span>{c.name}</span>
                                    <code>
                                      {c.nativeType ?? c.type.toLowerCase()}
                                    </code>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!w.schema.tables.length && (
                <p className="sidebar-empty">Your tables will appear here.</p>
              )}
              {search && !filteredTables.length && (
                <p className="sidebar-empty">No matching tables.</p>
              )}
            </div>
          </aside>
        )}
        {left && hasConnection && (
          <div
            className="sidebar-divider"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={160}
            aria-valuemax={480}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              resizeSidebar(
                event.clientX -
                  workspaceRef.current!.getBoundingClientRect().left,
              );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              resizeSidebar(
                event.key === "Home"
                  ? 160
                  : event.key === "End"
                    ? 480
                    : sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16),
              );
            }}
          />
        )}
        <main className={"main-view mode-" + mode}>
          {hasConnection && w.sources && mode === "sql" ? (
            <MultiSqlWorkspace
              connectionHost={connectionHost}
              key={w.id}
              workspace={w}
              dark={dark}
              busy={busy}
              onBusy={setBusy}
              runRef={remoteRun}
            />
          ) : remote ? (
            <RemoteWorkspace
              key={
                w.id +
                connectionRevision +
                (w.activeSourceId ?? "") +
                JSON.stringify(w.postgres ?? w.mssql)
              }
              sessionKey={
                w.activeSourceId
                  ? sourceSessionKey(w.id, w.activeSourceId)
                  : w.id
              }
              workspace={w}
              mode={mode}
              dark={dark}
              activeTable={activeTable}
              openTables={openDataTables}
              dataLayout={dataLayout}
              onDataLayoutChange={setDataLayout}
              onSelectTable={(id) => void chooseTable(id)}
              onReorderTables={setOpenDataTableIds}
              onCloseTable={(id) => void closeDataTable(id)}
              onCloseTables={(ids, nextActive) =>
                void closeDataTablesBatch(ids, nextActive)
              }
              runRef={remoteRun}
              onBusy={setBusy}
              onDirty={setDirty}
            />
          ) : (
            <section
              className="connection-empty"
              aria-labelledby="connection-empty-title"
            >
              <div className="connection-empty-mark" aria-hidden="true">
                <Database size={25} />
              </div>
              <h2 id="connection-empty-title">Connect to a database</h2>
              <p>
                Add a PostgreSQL or SQL Server connection to browse tables and
                run queries.
              </p>
              <Button
                variant="primary"
                onClick={() =>
                  requestConnection(w.id, w.activeSourceId ?? "primary", "new")
                }
              >
                Add connection
              </Button>
            </section>
          )}
        </main>
      </div>
      {message && (
        <div
          className={"notification " + (error ? "notification-error" : "")}
          role={error ? "alert" : "status"}
        >
          {error ? <Terminal size={16} /> : <Check size={16} />}
          <span>{message}</span>
          <Button title="Dismiss notification" onClick={() => setMessage("")}>
            <X size={15} />
          </Button>
        </div>
      )}
    </div>
  );
}
