import { installRunShortcut } from "./run-shortcut";
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
  databaseSources,
  ensureSources,
  updateSource,
  syncActiveSqlSource,
} from "../features/connections/sources";
import { listDatabases, ensureDatabaseSession } from "../features/connections/databases";
import { catalogSchema } from "../features/postgres/model";
import { isTauri } from "@tauri-apps/api/core";
import { restoreSqlLayout, updatePaneTabs } from "../features/sql/panes";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  invalidateSession,
  requestConnection,
  getSession,
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
  Eye,
  Code2,
  Loader2,
  RotateCw,
  Copy,
  FileCode,
  Play,
  Plus,
  Pencil,
  Trash2,
  Download,
  HardDrive,
  Server,
  Layers,
  Plug,
  Unplug,
} from "lucide-react";
import { saveExportFile } from "../lib/platform/save-file";
import { Button } from "../components/ui/button";
import { DialogHost, confirmAction } from "../lib/dialogs";
import { useStore } from "../features/schema/store";
import { id } from "../features/schema/core";
import { activeSqlTab, sqlTabs, setSqlTabs } from "../features/sql/tabs";
import { RemoteWorkspace } from "../features/connections/RemoteWorkspace";
import type { ConnectionProfile } from "../features/connections/model";
import { useDesktopClose } from "../lib/platform/use-desktop-close";
import { saveWorkspace, saveConnection, storage } from "../lib/storage/workspaces";
import type { TableDefinition, FunctionDefinition, WorkspaceSource, SqlTab } from "../types/schema";
type Mode = "data" | "sql";
const modes = [
  { id: "data", label: "Data", icon: Database },
  { id: "sql", label: "SQL", icon: SquareTerminal },
] as const;

const CONNECTION_COLORS = [
  { label: "None (Default)", color: undefined },
  { label: "Red (Production)", color: "#ef4444" },
  { label: "Orange (Staging)", color: "#f97316" },
  { label: "Amber (Warning)", color: "#f59e0b" },
  { label: "Green (Development)", color: "#10b981" },
  { label: "Teal (Testing)", color: "#14b8a6" },
  { label: "Blue (Local)", color: "#3b82f6" },
  { label: "Purple (Analytics)", color: "#8b5cf6" },
  { label: "Pink (Sandbox)", color: "#ec4899" },
] as const;

interface SidebarContextMenuState {
  x: number;
  y: number;
  type:
  | "connection"
  | "database"
  | "schemas_header"
  | "schema"
  | "table"
  | "view"
  | "function"
  | "folder"
  | "empty_area";
  connectionRootId?: string;
  connectionName?: string;
  databaseName?: string;
  schemaKey?: string;
  schemaName?: string;
  category?: "tables" | "views" | "functions";
  categoryCount?: number;
  table?: TableDefinition;
  view?: TableDefinition;
  func?: FunctionDefinition;
}

function functionKindBadge(kind?: string) {
  if (!kind) return "FN";
  const k = kind.toLowerCase();
  if (k.includes("proc")) return "PROC";
  if (k.includes("agg")) return "AGG";
  if (k.includes("inline")) return "ITF";
  if (k.includes("table")) return "TF";
  if (k.includes("win")) return "WIN";
  return "FN";
}

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
  }, [mode]);

  const [dataTable, setDataTable] = useState("");
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const [openedSchemas, setOpenedSchemas] = useState<Record<string, boolean>>({});
  const [loadingSchemas, setLoadingSchemas] = useState<Record<string, boolean>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [sidebarMenu, setSidebarMenu] = useState<SidebarContextMenuState | null>(null);
  const sidebarMenuRef = useRef<HTMLDivElement>(null);
  const tableList = useRef<HTMLDivElement>(null);

  const [openConnections, setOpenConnections] = useState<Record<string, boolean>>({});
  const [closedConnections, setClosedConnections] = useState<Record<string, boolean>>({});
  const [collapsedConnections, setCollapsedConnections] = useState<Record<string, boolean>>({});
  const [openDatabases, setOpenDatabases] = useState<Record<string, boolean>>({});
  const [loadingDatabases, setLoadingDatabases] = useState<Record<string, boolean>>({});

  const sources = workspaceSources(w);
  const connectionRoots = useMemo(
    () => sources.filter((s) => Boolean(s.connection && !s.parentSourceId)),
    [sources],
  );

  const isConnectionOpen = (rootId: string) => {
    if (closedConnections[rootId]) return false;
    if (openConnections[rootId] !== undefined) return openConnections[rootId];
    const source = sources.find((s) => s.id === rootId);
    if (source?.connection) {
      const session = getSession(sourceSessionKey(w.id, rootId), source.connection);
      return Boolean(session);
    }
    return false;
  };

  const isConnectionExpanded = (rootId: string) => {
    if (!isConnectionOpen(rootId)) return false;
    if (needle) return true;
    return !collapsedConnections[rootId];
  };

  const handleCreateNewConnection = () => {
    requestConnection(w.id, "new", "new");
  };
  const activeSource =
    sources.find((s) => s.id === (w.activeSourceId ?? "primary")) ?? sources[0];
  const root = connectionRoot(w, activeSource);
  const hasActiveConnection = Boolean(activeSource.connection);
  const isConnectionAccessible = Boolean(hasActiveConnection && isConnectionOpen(root.id));
  const currentDb =
    activeSource.connection?.config.database ||
    (w.mssql?.database ?? w.postgres?.database ?? "database");

  const getDatabasesForRoot = (rootItem: WorkspaceSource): string[] => {
    const initialDb = rootItem.connection?.config.database;
    const dbList = [
      ...(rootItem.databases ?? []),
      ...(initialDb ? [initialDb] : []),
      ...databaseSources(w, rootItem.id).flatMap((s) =>
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
  };

  const connectionName =
    root.name ||
    (activeSource.connection
      ? `${activeSource.connection.engine === "mssql" ? "SQL Server" : "PostgreSQL"} (${activeSource.connection.config.host})`
      : "Database Server");

  const discoverDatabasesForRoot = async (
    rootItem: WorkspaceSource,
    force = false,
  ) => {
    if (!rootItem.connection || (!force && rootItem.databases) || !isTauri())
      return;
    try {
      const rawNames = await listDatabases(w, rootItem);
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
      edit((draft) => {
        ensureSources(draft);
        updateSource(draft, rootItem.id, { databases: names });
      });
    } catch {
      // background discovery silent
    }
  };

  useEffect(() => {
    for (const r of connectionRoots) {
      if (r.connection && isConnectionOpen(r.id)) {
        void discoverDatabasesForRoot(r);
      }
    }
  }, [w.id, connectionRoots, openConnections, closedConnections]);

  const handleDatabaseClick = async (rootId: string, dbName: string) => {
    const isCurrent =
      root.id === rootId && dbName.toLowerCase() === currentDb.toLowerCase();
    const key = `${rootId}:${dbName}`;
    if (isCurrent) {
      setOpenDatabases((prev) => {
        const currentlyOpen = prev[key] !== undefined ? prev[key] : true;
        return { ...prev, [key]: !currentlyOpen };
      });
    } else {
      setLoadingDatabases((prev) => ({ ...prev, [key]: true }));
      try {
        await selectWorkspaceDatabase(rootId, dbName);
        setOpenDatabases((prev) => ({ ...prev, [key]: true }));
      } finally {
        setLoadingDatabases((prev) => ({ ...prev, [key]: false }));
      }
    }
  };

  const isDbOpen = (rootId: string, dbName: string) => {
    if (needle) return true;
    const key = `${rootId}:${dbName}`;
    if (openDatabases[key] !== undefined) return openDatabases[key];
    return root.id === rootId && dbName.toLowerCase() === currentDb.toLowerCase();
  };

  const handleCloseConnection = (rootId: string) => {
    const targetRoot = connectionRoots.find((r) => r.id === rootId) ?? root;
    const name = targetRoot.name || "Connection";
    setClosedConnections((prev) => ({ ...prev, [rootId]: true }));
    setOpenConnections((prev) => ({ ...prev, [rootId]: false }));
    for (const item of workspaceSources(w).filter(
      (s) => s.id === rootId || s.parentSourceId === rootId,
    )) {
      invalidateSession(sourceSessionKey(w.id, item.id));
    }
    setMessage(`Connection "${name}" closed`);
    setError(false);
  };

  const handleOpenConnection = (rootId: string) => {
    setCollapsedConnections((prev) => ({ ...prev, [rootId]: false }));
    requestConnection(w.id, rootId, "login");
  };

  const handleSetConnectionColor = (rootId: string, color?: string) => {
    edit((draft) => {
      ensureSources(draft);
      updateSource(draft, rootId, { color });
      for (const s of draft.sources ?? []) {
        if (s.parentSourceId === rootId) {
          s.color = color;
        }
      }
    });
    const source = sources.find((s) => s.id === rootId);
    if (source?.connectionId) {
      void storage.connections.get(source.connectionId).then((profile) => {
        if (profile) {
          void saveConnection({ ...profile, color, updatedAt: Date.now() });
        }
      });
    }
    const targetRoot = connectionRoots.find((r) => r.id === rootId) ?? root;
    const name = targetRoot.name || "Connection";
    setMessage(color ? `Set color for "${name}"` : `Cleared color for "${name}"`);
    setError(false);
  };

  function generateNewDatabaseTemplate(isMssql: boolean): string {
    return isMssql
      ? `-- Create New Database\nCREATE DATABASE [NewDatabase];\nGO\n`
      : `-- Create New Database\nCREATE DATABASE "new_database";\n`;
  }

  function generateNewSchemaTemplate(dbName: string, isMssql: boolean): string {
    return isMssql
      ? `-- Create New Schema in [${dbName}]\nUSE [${dbName}];\nGO\n\nCREATE SCHEMA [NewSchema] AUTHORIZATION [dbo];\nGO\n`
      : `-- Create New Schema in "${dbName}"\nCREATE SCHEMA "new_schema";\n`;
  }

  function generateDropDatabaseScript(
    dbName: string,
    isMssql: boolean,
  ): string {
    return isMssql
      ? `-- CAUTION: Irreversible drop database\nALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nGO\nDROP DATABASE [${dbName}];\nGO\n`
      : `-- CAUTION: Irreversible drop database\nDROP DATABASE IF EXISTS "${dbName}";\n`;
  }

  useEffect(() => {
    tableList.current?.scrollTo({ top: 0 });
  }, [search, w.id, w.activeSourceId]);

  const defaultSchema = w.mssql ? "dbo" : "public";

  const { schemaGroups, totalObjectsCount } = useMemo(() => {
    if (!w.postgres && !w.mssql) {
      return { schemaGroups: [], totalObjectsCount: 0 };
    }

    const map = new Map<
      string,
      {
        tables: TableDefinition[];
        views: TableDefinition[];
        functions: FunctionDefinition[];
      }
    >();

    const getGroup = (schema: string) => {
      let g = map.get(schema);
      if (!g) {
        g = { tables: [], views: [], functions: [] };
        map.set(schema, g);
      }
      return g;
    };

    // Ensure all discovered schemas from database catalog exist
    if (w.schema.schemas) {
      for (const s of w.schema.schemas) {
        getGroup(s);
      }
    }
    getGroup(defaultSchema);

    let totalObjects = 0;

    for (const table of w.schema.tables) {
      const schemaName = table.namespace || defaultSchema;
      const isView = table.kind === "view";
      const full = `${schemaName}.${table.name}`.toLowerCase();
      const matchesSearch =
        !needle ||
        full.includes(needle) ||
        table.name.toLowerCase().includes(needle) ||
        table.columns.some((c) => c.name.toLowerCase().includes(needle));

      if (matchesSearch) {
        const group = getGroup(schemaName);
        if (isView) {
          group.views.push(table);
        } else {
          group.tables.push(table);
        }
        totalObjects++;
      }
    }

    const functions = w.schema.functions ?? [];
    for (const fn of functions) {
      const schemaName = fn.namespace || defaultSchema;
      const full = `${schemaName}.${fn.name}`.toLowerCase();
      const matchesSearch =
        !needle ||
        full.includes(needle) ||
        fn.name.toLowerCase().includes(needle) ||
        (fn.arguments && fn.arguments.toLowerCase().includes(needle)) ||
        (fn.kind && fn.kind.toLowerCase().includes(needle));

      if (matchesSearch) {
        const group = getGroup(schemaName);
        group.functions.push(fn);
        totalObjects++;
      }
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

    const groups = sortedSchemas
      .map((name) => {
        const g = map.get(name)!;
        return {
          name,
          tables: g.tables.sort((a, b) => a.name.localeCompare(b.name)),
          views: g.views.sort((a, b) => a.name.localeCompare(b.name)),
          functions: g.functions.sort((a, b) => a.name.localeCompare(b.name)),
          total: g.tables.length + g.views.length + g.functions.length,
        };
      })
      .filter((g) => g.total > 0 || !needle);

    return {
      schemaGroups: groups,
      totalObjectsCount: totalObjects,
    };
  }, [w.schema.schemas, w.schema.tables, w.schema.functions, w.postgres, w.mssql, needle, defaultSchema]);

  function isSchemaOpen(schemaKey: string, schemaName: string): boolean {
    if (needle) return true;
    if (openedSchemas[schemaKey] !== undefined) return openedSchemas[schemaKey];
    return schemaName.toLowerCase() === defaultSchema.toLowerCase();
  }

  function toggleSchema(schemaKey: string, schemaName: string) {
    const currentlyOpen = isSchemaOpen(schemaKey, schemaName);
    if (currentlyOpen) {
      setOpenedSchemas((prev) => ({ ...prev, [schemaKey]: false }));
    } else {
      setLoadingSchemas((prev) => ({ ...prev, [schemaKey]: true }));
      setTimeout(() => {
        setLoadingSchemas((prev) => ({ ...prev, [schemaKey]: false }));
        setOpenedSchemas((prev) => ({ ...prev, [schemaKey]: true }));
      }, 160);
    }
  }

  function refreshSchema(schemaKey: string, schemaName: string) {
    setLoadingSchemas((prev) => ({ ...prev, [schemaKey]: true }));
    setTimeout(() => {
      setLoadingSchemas((prev) => ({ ...prev, [schemaKey]: false }));
      setOpenedSchemas((prev) => ({ ...prev, [schemaKey]: true }));
      setMessage(`Schema "${schemaName}" is up to date`);
      setError(false);
    }, 250);
  }

  function isFolderOpen(
    schemaKey: string,
    category: "tables" | "views" | "functions",
    count: number,
  ): boolean {
    if (needle) return count > 0;
    const key = `${schemaKey}:${category}`;
    if (openFolders[key] !== undefined) return openFolders[key];
    return category !== "functions" && count > 0;
  }

  function toggleFolder(
    schemaKey: string,
    category: "tables" | "views" | "functions",
    count: number,
  ) {
    const key = `${schemaKey}:${category}`;
    setOpenFolders((prev) => {
      const currentlyOpen =
        prev[key] !== undefined
          ? prev[key]
          : category !== "functions" && count > 0;
      return { ...prev, [key]: !currentlyOpen };
    });
  }

  function handleFunctionClick(fn: FunctionDefinition) {
    const schemaPrefix = fn.namespace ? `${fn.namespace}.` : "";
    const isProc = fn.kind === "procedure";
    const argStr = fn.arguments ? `/* ${fn.arguments} */` : "";
    const invocation = isProc
      ? w.mssql
        ? `EXEC ${schemaPrefix}${fn.name} ${argStr};`
        : `CALL ${schemaPrefix}${fn.name}(${argStr});`
      : `SELECT ${schemaPrefix}${fn.name}(${argStr});`;

    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(invocation)
        .then(() => {
          setMessage(`Copied: ${invocation}`);
          setError(false);
        })
        .catch(() => {
          setMessage(invocation);
          setError(false);
        });
    } else {
      setMessage(invocation);
      setError(false);
    }

    if (mode === "sql") {
      edit((draft) => {
        const active = activeSqlTab(draft);
        const currentSql = active.sql.trim();
        const newSql = currentSql ? `${currentSql}\n\n${invocation}` : invocation;
        setSqlTabs(
          draft,
          sqlTabs(draft).map((tab) =>
            tab.id === active.id ? { ...tab, sql: newSql } : tab,
          ),
          active.id,
        );
      });
    }
  }

  const [expandedTables, setExpandedTables] = useState<string[]>([]);
  const [left, setLeft] = useState(true);
  const [connectionRevision, setConnectionRevision] = useState(0);
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
  const [, setSaved] = useState("Opening workspace…");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const remoteRun = useRef<() => void>(() => { });

  useEffect(() => {
    if (!sidebarMenu) return;
    const handleDown = (e: MouseEvent) => {
      if (
        sidebarMenuRef.current &&
        !sidebarMenuRef.current.contains(e.target as Node)
      ) {
        setSidebarMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarMenu(null);
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [sidebarMenu]);

  function copyText(text: string, label: string) {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setMessage(
            `Copied ${label}: ${text.length > 35 ? text.slice(0, 32) + "..." : text}`,
          );
          setError(false);
        })
        .catch(() => {
          setMessage(`Copied ${label}`);
          setError(false);
        });
    } else {
      setMessage(`Copied ${label}`);
      setError(false);
    }
  }

  function openSqlWithQuery(
    query: string,
    tabName?: string,
    target?: string | { rootId?: string; database?: string; sourceId?: string },
  ) {
    edit((draft) => {
      ensureSources(draft);
      const tabs = sqlTabs(draft);
      const active = activeSqlTab(draft);
      const name = tabName ?? `query-${tabs.length + 1}.sql`;
      let boundSourceId = w.activeSourceId;
      if (typeof target === "string") {
        boundSourceId = target;
      } else if (target) {
        if (target.rootId && target.database) {
          boundSourceId = attachDatabase(draft, target.rootId, target.database);
        } else if (target.sourceId) {
          boundSourceId = target.sourceId;
        } else if (target.rootId) {
          boundSourceId = target.rootId;
        }
      }

      const newTab: SqlTab = {
        id: id(),
        name,
        sql: query,
        sourceId: boundSourceId,
      };
      const layout = restoreSqlLayout(tabs, active.id, draft.sqlLayout);
      const index = Math.max(
        0,
        layout.groups.findIndex((group) => group.ids.includes(active.id)),
      );
      const owned = layout.groups[index].ids
        .map((tabId) => tabs.find((t) => t.id === tabId)!)
        .filter(Boolean);
      const next = updatePaneTabs(
        tabs,
        layout.groups,
        index,
        [...owned, newTab],
        newTab.id,
      );
      setSqlTabs(draft, next.tabs, newTab.id, {
        ...layout,
        groups: next.groups,
      });
      syncActiveSqlSource(draft);
    });
    setMode("sql");
  }

  function openFunctionCode(
    fn: FunctionDefinition,
    target?: string | { rootId?: string; database?: string; sourceId?: string },
  ) {
    const schemaPrefix = fn.namespace ? `${fn.namespace}.` : "";
    const tabName = `${fn.name}.sql`;

    if (fn.definition && fn.definition.trim()) {
      openSqlWithQuery(fn.definition.trim(), tabName, target);
      setMessage(`Opened code for ${schemaPrefix}${fn.name}`);
      setError(false);
      return;
    }

    // Fallback if catalog definition is not yet cached in current session
    const fallbackQuery = w.mssql
      ? `-- Source code for [${fn.namespace ?? "dbo"}].[${fn.name}]\nEXEC sp_helptext '[${fn.namespace ?? "dbo"}].[${fn.name}]';\nGO\n\n-- Alternative via system catalog:\n-- SELECT OBJECT_DEFINITION(OBJECT_ID('[${fn.namespace ?? "dbo"}].[${fn.name}]')) AS [Definition];\n-- GO\n`
      : `-- Source code for "${fn.namespace ?? "public"}"."${fn.name}"\nSELECT pg_get_functiondef('${fn.namespace ?? "public"}.${fn.name}'::regproc);\n`;

    openSqlWithQuery(fallbackQuery, tabName, target);
    setMessage(`Retrieving code for ${schemaPrefix}${fn.name}`);
    setError(false);
  }

  function generateTableDdl(table: TableDefinition, isMssql: boolean): string {
    const qName = table.namespace
      ? isMssql
        ? `[${table.namespace}].[${table.name}]`
        : `"${table.namespace}"."${table.name}"`
      : isMssql
        ? `[${table.name}]`
        : `"${table.name}"`;

    const pkColIds = new Set(table.primaryKey);
    const pkCols = table.columns.filter((c) => pkColIds.has(c.id));

    const colLines = table.columns.map((c) => {
      const colName = isMssql ? `[${c.name}]` : `"${c.name}"`;
      const colType = c.nativeType ?? c.type;
      const nullability = c.nullable ? "NULL" : "NOT NULL";
      const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : "";
      return `  ${colName} ${colType} ${nullability}${def}`;
    });

    if (pkCols.length > 0) {
      const pkList = pkCols
        .map((c) => (isMssql ? `[${c.name}]` : `"${c.name}"`))
        .join(", ");
      const pkConstraintName = isMssql
        ? `[PK_${table.name}]`
        : `"pk_${table.name}"`;
      colLines.push(`  CONSTRAINT ${pkConstraintName} PRIMARY KEY (${pkList})`);
    }

    return isMssql
      ? `-- DDL Script for Table ${qName}\nSET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\n\nCREATE TABLE ${qName} (\n${colLines.join(",\n")}\n);\nGO\n`
      : `-- DDL Script for Table ${qName}\nCREATE TABLE ${qName} (\n${colLines.join(",\n")}\n);\n`;
  }

  function generateNewTableTemplate(
    schemaName: string,
    isMssql: boolean,
  ): string {
    return isMssql
      ? `-- Create New Table in [${schemaName}]\nCREATE TABLE [${schemaName}].[NewTable] (\n  [Id] INT IDENTITY(1,1) NOT NULL,\n  [Name] NVARCHAR(100) NOT NULL,\n  [CreatedAt] DATETIME2 NOT NULL DEFAULT GETDATE(),\n  CONSTRAINT [PK_NewTable] PRIMARY KEY ([Id])\n);\nGO\n`
      : `-- Create New Table in "${schemaName}"\nCREATE TABLE "${schemaName}"."new_table" (\n  "id" SERIAL PRIMARY KEY,\n  "name" VARCHAR(100) NOT NULL,\n  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n`;
  }

  function generateNewViewTemplate(
    schemaName: string,
    isMssql: boolean,
  ): string {
    return isMssql
      ? `-- Create New View in [${schemaName}]\nCREATE VIEW [${schemaName}].[v_NewView] AS\nSELECT\n  1 AS [Id],\n  'Sample' AS [Name];\nGO\n`
      : `-- Create New View in "${schemaName}"\nCREATE VIEW "${schemaName}"."v_new_view" AS\nSELECT\n  1 AS id,\n  'Sample' AS name;\n`;
  }

  function generateNewFunctionTemplate(
    schemaName: string,
    isMssql: boolean,
  ): string {
    return isMssql
      ? `-- Create Stored Procedure in [${schemaName}]\nCREATE PROCEDURE [${schemaName}].[usp_NewProcedure]\n  @Param1 INT = 0,\n  @Param2 NVARCHAR(50) = NULL\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SELECT @Param1 AS [Result];\nEND;\nGO\n`
      : `-- Create Function in "${schemaName}"\nCREATE OR REPLACE FUNCTION "${schemaName}"."new_function"(p_param1 INT DEFAULT 0)\nRETURNS INT AS $$\nBEGIN\n  RETURN p_param1 + 1;\nEND;\n$$ LANGUAGE plpgsql;\n`;
  }

  function generateAlterTableTemplate(
    table: TableDefinition,
    isMssql: boolean,
  ): string {
    const qName = table.namespace
      ? isMssql
        ? `[${table.namespace}].[${table.name}]`
        : `"${table.namespace}"."${table.name}"`
      : isMssql
        ? `[${table.name}]`
        : `"${table.name}"`;
    return isMssql
      ? `-- Alter Table ${qName}\n-- 1. Add new column:\nALTER TABLE ${qName} ADD [NewColumn] NVARCHAR(100) NULL;\nGO\n\n-- 2. Modify existing column:\n-- ALTER TABLE ${qName} ALTER COLUMN [ExistingColumn] NVARCHAR(200) NOT NULL;\n-- GO\n\n-- 3. Drop column:\n-- ALTER TABLE ${qName} DROP COLUMN [ObsoleteColumn];\n-- GO\n`
      : `-- Alter Table ${qName}\n-- 1. Add new column:\nALTER TABLE ${qName} ADD COLUMN "new_column" VARCHAR(100);\n\n-- 2. Modify existing column type:\n-- ALTER TABLE ${qName} ALTER COLUMN "existing_column" TYPE VARCHAR(200);\n\n-- 3. Drop column:\n-- ALTER TABLE ${qName} DROP COLUMN "obsolete_column";\n`;
  }

  function generateDropTableScript(
    table: TableDefinition,
    isMssql: boolean,
  ): string {
    const qName = table.namespace
      ? isMssql
        ? `[${table.namespace}].[${table.name}]`
        : `"${table.namespace}"."${table.name}"`
      : isMssql
        ? `[${table.name}]`
        : `"${table.name}"`;
    return isMssql
      ? `-- CAUTION: Irreversible drop table\nDROP TABLE ${qName};\nGO\n`
      : `-- CAUTION: Irreversible drop table\nDROP TABLE ${qName};\n`;
  }

  function generateViewDdl(view: TableDefinition, isMssql: boolean): string {
    const qName = view.namespace
      ? isMssql
        ? `[${view.namespace}].[${view.name}]`
        : `"${view.namespace}"."${view.name}"`
      : isMssql
        ? `[${view.name}]`
        : `"${view.name}"`;
    const cols = view.columns
      .map((c) => (isMssql ? `  [${c.name}]` : `  "${c.name}"`))
      .join(",\n");
    return isMssql
      ? `-- DDL Script for View ${qName}\nCREATE OR ALTER VIEW ${qName} AS\nSELECT\n${cols}\nFROM /* source_table */;\nGO\n`
      : `-- DDL Script for View ${qName}\nCREATE OR REPLACE VIEW ${qName} AS\nSELECT\n${cols}\nFROM /* source_table */;\n`;
  }

  function generateDropViewScript(
    view: TableDefinition,
    isMssql: boolean,
  ): string {
    const qName = view.namespace
      ? isMssql
        ? `[${view.namespace}].[${view.name}]`
        : `"${view.namespace}"."${view.name}"`
      : isMssql
        ? `[${view.name}]`
        : `"${view.name}"`;
    return isMssql
      ? `-- CAUTION: Irreversible drop view\nDROP VIEW ${qName};\nGO\n`
      : `-- CAUTION: Irreversible drop view\nDROP VIEW ${qName};\n`;
  }

  function generateAlterFuncScript(
    fn: FunctionDefinition,
    isMssql: boolean,
  ): string {
    if (fn.definition && fn.definition.trim()) {
      return fn.definition.trim();
    }
    const schemaPrefix = fn.namespace
      ? isMssql
        ? `[${fn.namespace}].`
        : `"${fn.namespace}".`
      : "";
    const fnName = isMssql ? `[${fn.name}]` : `"${fn.name}"`;
    const isProc = fn.kind === "procedure";
    return isMssql
      ? isProc
        ? `-- Modify Stored Procedure\nCREATE OR ALTER PROCEDURE ${schemaPrefix}${fnName}\n  /* ${fn.arguments ?? ""} */\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- Procedure body\nEND;\nGO\n`
        : `-- Modify Function\nCREATE OR ALTER FUNCTION ${schemaPrefix}${fnName}\n  (/* ${fn.arguments ?? ""} */)\nRETURNS ${fn.resultType ?? "INT"}\nAS\nBEGIN\n  -- Function body\n  RETURN 1;\nEND;\nGO\n`
      : isProc
        ? `-- Modify Procedure\nCREATE OR REPLACE PROCEDURE ${schemaPrefix}${fnName}(${fn.arguments ?? ""})\nAS $$\nBEGIN\n  -- Routine body\nEND;\n$$ LANGUAGE plpgsql;\n`
        : `-- Modify Function\nCREATE OR REPLACE FUNCTION ${schemaPrefix}${fnName}(${fn.arguments ?? ""})\nRETURNS ${fn.resultType ?? "VOID"} AS $$\nBEGIN\n  -- Routine body\nEND;\n$$ LANGUAGE plpgsql;\n`;
  }

  function generateDropFuncScript(
    fn: FunctionDefinition,
    isMssql: boolean,
  ): string {
    const schemaPrefix = fn.namespace
      ? isMssql
        ? `[${fn.namespace}].`
        : `"${fn.namespace}".`
      : "";
    const fnName = isMssql ? `[${fn.name}]` : `"${fn.name}"`;
    const isProc = fn.kind === "procedure";
    const dropType = isProc ? "PROCEDURE" : "FUNCTION";
    return isMssql
      ? `-- CAUTION: Drop routine\nDROP ${dropType} ${schemaPrefix}${fnName};\nGO\n`
      : `-- CAUTION: Drop routine\nDROP ${dropType} IF EXISTS ${schemaPrefix}${fnName};\n`;
  }

  function generateSchemaBackupDdl(
    schemaName: string,
    isMssql: boolean,
    groupTables: TableDefinition[],
    groupViews: TableDefinition[],
    groupFunctions: FunctionDefinition[],
  ): string {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const engineName = isMssql ? "Microsoft SQL Server" : "PostgreSQL";
    const header = [
      `-- ==========================================================`,
      `-- DATABASE SCHEMA BACKUP SCRIPT`,
      `-- Engine   : ${engineName}`,
      `-- Schema   : ${schemaName}`,
      `-- Created  : ${timestamp}`,
      `-- Objects  : ${groupTables.length} Tables, ${groupViews.length} Views, ${groupFunctions.length} Routines`,
      `-- ==========================================================`,
      "",
    ];

    if (isMssql) {
      const db = w.mssql?.database || "master";
      header.push(`USE [${db}];`, "GO", "");
    }

    const sections: string[] = [header.join("\n")];

    if (groupTables.length > 0) {
      sections.push(
        `-- ----------------------------------------------------------\n-- TABLES DDL (${groupTables.length})\n-- ----------------------------------------------------------\n`,
      );
      for (const table of groupTables) {
        sections.push(generateTableDdl(table, isMssql));
      }
    }

    if (groupViews.length > 0) {
      sections.push(
        `-- ----------------------------------------------------------\n-- VIEWS DDL (${groupViews.length})\n-- ----------------------------------------------------------\n`,
      );
      for (const view of groupViews) {
        sections.push(generateViewDdl(view, isMssql));
      }
    }

    if (groupFunctions.length > 0) {
      sections.push(
        `-- ----------------------------------------------------------\n-- ROUTINES DDL (${groupFunctions.length})\n-- ----------------------------------------------------------\n`,
      );
      for (const fn of groupFunctions) {
        sections.push(generateAlterFuncScript(fn, isMssql));
      }
    }

    return sections.join("\n\n");
  }

  function generateMssqlDatabaseBackupScript(databaseName: string): string {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return [
      `-- ==========================================================`,
      `-- SQL SERVER NATIVE DATABASE BACKUP SCRIPT`,
      `-- Database : [${databaseName}]`,
      `-- Date     : ${new Date().toLocaleString()}`,
      `-- ==========================================================`,
      "",
      `DECLARE @BackupPath NVARCHAR(500);`,
      `-- Specify your server backup directory:`,
      `SET @BackupPath = N'C:\\Backup\\${databaseName}_${dateStr}.bak';`,
      "",
      `BACKUP DATABASE [${databaseName}]`,
      `TO DISK = @BackupPath`,
      `WITH`,
      `  FORMAT,`,
      `  INIT,`,
      `  MEDIANAME = N'${databaseName}BackupMedia',`,
      `  NAME = N'Full Backup of ${databaseName}',`,
      `  SKIP,`,
      `  NOREWIND,`,
      `  NOUNLOAD,`,
      `  STATS = 10,`,
      `  CHECKSUM;`,
      `GO`,
      "",
      `-- Verify backup integrity:`,
      `RESTORE VERIFYONLY FROM DISK = @BackupPath;`,
      `GO`,
    ].join("\n");
  }

  function generatePostgresBackupScript(
    databaseName: string,
    schemaName?: string,
  ): string {
    const schemaArg = schemaName ? ` -n "${schemaName}"` : "";
    return [
      `-- ==========================================================`,
      `-- POSTGRESQL BACKUP SCRIPT / REFERENCE`,
      `-- Database : "${databaseName}"`,
      schemaName ? `-- Schema   : "${schemaName}"` : "",
      `-- Date     : ${new Date().toLocaleString()}`,
      `-- ==========================================================`,
      "",
      `-- Terminal command for Custom Archive backup (.dump):`,
      `-- pg_dump -U postgres -d "${databaseName}"${schemaArg} -F c -b -v -f "${databaseName}_${schemaName ?? "all"}_backup.dump"`,
      "",
      `-- Terminal command for Plain SQL script backup (.sql):`,
      `-- pg_dump -U postgres -d "${databaseName}"${schemaArg} --clean --if-exists > "${databaseName}_${schemaName ?? "all"}_backup.sql"`,
      "",
      `-- Active database check:`,
      `SELECT current_database(), current_schema(), version();`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function generateTableDataBackupTemplate(
    table: TableDefinition,
    isMssql: boolean,
  ): string {
    const qName = table.namespace
      ? isMssql
        ? `[${table.namespace}].[${table.name}]`
        : `"${table.namespace}"."${table.name}"`
      : isMssql
        ? `[${table.name}]`
        : `"${table.name}"`;
    const cols = table.columns
      .map((c) => (isMssql ? `[${c.name}]` : `"${c.name}"`))
      .join(", ");
    const placeholders = table.columns
      .map((c) => `/* ${c.name}: ${c.nativeType ?? c.type} */ NULL`)
      .join(", ");
    return isMssql
      ? `-- Backup / Restore Data for Table ${qName}\nSET IDENTITY_INSERT ${qName} ON;\nGO\n\nINSERT INTO ${qName} (${cols})\nVALUES\n  (${placeholders});\nGO\n\nSET IDENTITY_INSERT ${qName} OFF;\nGO\n`
      : `-- Backup / Restore Data for Table ${qName}\nINSERT INTO ${qName} (${cols})\nVALUES\n  (${placeholders});\n`;
  }

  const remote = !!(w.postgres || w.mssql);
  const searchInput = useRef<HTMLInputElement>(null);
  const runRef = useRef<() => void>(() => { });
  const tablesById = useMemo(
    () => new Map(w.schema.tables.map((table) => [table.id, table])),
    [w.schema.tables],
  );
  const [closedAllDataTables, setClosedAllDataTables] = useState(false);
  const [openDataTableIds, setOpenDataTableIds] = useState<string[]>([]);
  const activeTable = closedAllDataTables
    ? undefined
    : (tablesById.get(dataTable) ??
      (openDataTableIds.length
        ? tablesById.get(openDataTableIds[0])
        : (!closedAllDataTables && !openDataTableIds.length && !dataTable && !ready
          ? w.schema.tables[0]
          : undefined)));
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
          const isSidebar =
            vHost.classList.contains("table-list") ||
            vHost.classList.contains("tree-columns");
          const cornerGap = hActive && hHost === vHost ? 8 : 0;
          const topGap = isSidebar ? 4 : 0;
          const bottomGap = isSidebar ? 4 : 0;
          const trackHeight = Math.max(
            20,
            Math.round(rect.height - cornerGap - topGap - bottomGap),
          );
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
          const xOffset = isSidebar ? 7 : 8;
          vTrack.style.transform = `translate3d(${Math.round(rect.right - xOffset)}px, ${Math.round(rect.top + topGap)}px, 0)`;
          vTrack.style.height = `${trackHeight}px`;
          vSlider.style.height = `${thumbHeight}px`;
          vSlider.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
          vTrack.classList.toggle("is-sidebar", isSidebar);
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
    if (tableId === activeTable?.id && !closedAllDataTables) return;
    if (!(await leaveDraft())) return;
    setClosedAllDataTables(false);
    setDataTable(tableId);
    setOpenDataTableIds((prev) =>
      prev.includes(tableId) ? prev : [...prev, tableId],
    );
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
    setDataTable(tableId);
    setOpenDataTableIds((items) =>
      items.includes(tableId) ? items : [...items, tableId],
    );
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
      ensureSources(draft);
      activateSource(draft, sourceId);
    });
    setDataTable("");
    setSearch("");
    return true;
  }
  async function selectWorkspaceDatabase(rootId: string, database: string) {
    if (!(await leaveDraft())) return;
    let targetSourceId = "";
    edit((draft) => {
      ensureSources(draft);
      const sourceId = attachDatabase(draft, rootId, database);
      targetSourceId = sourceId;
      activateSource(draft, sourceId);
    });
    setDataTable("");
    setSearch("");
    if (targetSourceId && isTauri()) {
      try {
        const current = useStore.getState().workspace;
        await ensureDatabaseSession(current, targetSourceId);
        const source = current.sources?.find((s) => s.id === targetSourceId);
        if (source?.connection) {
          const cached = getSession(
            sourceSessionKey(current.id, source.id),
            source.connection,
          )?.catalog;
          if (cached && !source.schema?.tables?.length) {
            edit((draft) => {
              if (draft.sources?.some((s) => s.id === targetSourceId)) {
                updateSource(draft, targetSourceId, {
                  schema: catalogSchema(cached),
                });
              }
            });
          }
        }
      } catch (err) {
        console.warn("Failed to load schema for database", err);
      }
    }
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
  async function detachWorkspaceConnection(sourceId: string) {
    if (isConnectionOpen(sourceId)) {
      setMessage("Please close the connection before deleting it.");
      setError(true);
      return;
    }
    const targetRoot = connectionRoots.find((r) => r.id === sourceId) ?? root;
    const targetName = targetRoot.name || connectionName;
    const confirmed = await confirmAction(
      `Are you sure you want to delete connection "${targetName}" from the workspace?`,
      {
        title: "Delete Connection",
        confirmLabel: "Delete",
        destructive: true,
      },
    );
    if (!confirmed) return;
    for (const item of workspaceSources(w).filter(
      (s) => s.id === sourceId || s.parentSourceId === sourceId,
    ))
      invalidateSession(sourceSessionKey(w.id, item.id));
    edit((draft) => removeSource(draft, sourceId));
    setClosedConnections((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    setOpenConnections((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    setMessage(`Connection "${targetName}" deleted successfully.`);
    setError(false);
    setDataTable("");
    setSearch("");
  }
  const renderSchemaGroups = () => {
    return (
      schemaGroups.map((group) => {
        const schemaKey = `${w.id}:${w.activeSourceId ?? "primary"}:${group.name}`;
        const isOpen = isSchemaOpen(schemaKey, group.name);
        const isLoading = Boolean(loadingSchemas[schemaKey]);
        return (
          <div
            key={group.name}
            className={`tree-schema-group ${isOpen ? "is-open" : "is-closed"}`}
          >
            <div
              className="tree-schema-header-row"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const x = Math.min(e.clientX, window.innerWidth - 220);
                const y = Math.min(e.clientY, window.innerHeight - 280);
                setSidebarMenu({
                  x,
                  y,
                  type: "schema",
                  schemaKey,
                  schemaName: group.name,
                });
              }}
            >
              <button
                type="button"
                className="tree-schema-header"
                onClick={() => toggleSchema(schemaKey, group.name)}
                title={`Schema ${group.name} · ${isOpen ? "Opened (click to collapse)" : "Closed (click to load & open)"}`}
                aria-expanded={isOpen}
              >
                <span className="tree-schema-arrow">
                  {isLoading ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : isOpen ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </span>
                <span className={`tree-schema-icon ${isOpen ? "is-opened" : ""}`}>
                  <Layers size={13.5} />
                  {isOpen && <span className="schema-status-dot" />}
                </span>
                <span className="tree-schema-label">
                  <strong>{group.name}</strong>
                </span>
                {isOpen && group.total > 0 && (
                  <span
                    className="tree-schema-count"
                    title={`${group.total} objects in schema`}
                  >
                    {group.total}
                  </span>
                )}
              </button>
              {isOpen && (
                <button
                  type="button"
                  className="tree-schema-action-btn"
                  title={`Refresh schema ${group.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    refreshSchema(schemaKey, group.name);
                  }}
                >
                  <RotateCw
                    size={11}
                    className={isLoading ? "animate-spin" : ""}
                  />
                </button>
              )}
            </div>

            {isOpen && (
              <div className="tree-schema-content">
                {/* TABLES FOLDER */}
                {(group.tables.length > 0 || (!needle && group.name === defaultSchema)) && (
                  <div className="tree-category-folder">
                    <button
                      type="button"
                      className="tree-category-header"
                      onClick={() => toggleFolder(schemaKey, "tables", group.tables.length)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const x = Math.min(e.clientX, window.innerWidth - 220);
                        const y = Math.min(e.clientY, window.innerHeight - 280);
                        setSidebarMenu({
                          x,
                          y,
                          type: "folder",
                          schemaKey,
                          schemaName: group.name,
                          category: "tables",
                          categoryCount: group.tables.length,
                        });
                      }}
                      aria-expanded={isFolderOpen(schemaKey, "tables", group.tables.length)}
                      title={`Tables in ${group.name} (${group.tables.length})`}
                    >
                      <span className="tree-category-arrow">
                        {isFolderOpen(schemaKey, "tables", group.tables.length) ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                      </span>
                      <span className="tree-category-icon">
                        <Table2 size={13} />
                      </span>
                      <span className="tree-category-label">Tables</span>
                      <span className="tree-category-count">{group.tables.length}</span>
                    </button>
                    {isFolderOpen(schemaKey, "tables", group.tables.length) && (
                      <div className="tree-category-items">
                        {group.tables.length === 0 ? (
                          <div className="tree-empty-category">No tables</div>
                        ) : (
                          group.tables.map((table) => (
                            <div key={table.id}>
                              <div
                                className={
                                  "tree-table-row" +
                                  (activeTable?.id === table.id ? " is-active" : "")
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const x = Math.min(e.clientX, window.innerWidth - 220);
                                  const y = Math.min(e.clientY, window.innerHeight - 280);
                                  setSidebarMenu({
                                    x,
                                    y,
                                    type: "table",
                                    table,
                                  });
                                }}
                              >
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
                                    <Table2 size={14} />
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
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* VIEWS FOLDER */}
                {(group.views.length > 0 || (!needle && group.name === defaultSchema)) && (
                  <div className="tree-category-folder">
                    <button
                      type="button"
                      className="tree-category-header"
                      onClick={() => toggleFolder(schemaKey, "views", group.views.length)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const x = Math.min(e.clientX, window.innerWidth - 220);
                        const y = Math.min(e.clientY, window.innerHeight - 280);
                        setSidebarMenu({
                          x,
                          y,
                          type: "folder",
                          schemaKey,
                          schemaName: group.name,
                          category: "views",
                          categoryCount: group.views.length,
                        });
                      }}
                      aria-expanded={isFolderOpen(schemaKey, "views", group.views.length)}
                      title={`Views in ${group.name} (${group.views.length})`}
                    >
                      <span className="tree-category-arrow">
                        {isFolderOpen(schemaKey, "views", group.views.length) ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                      </span>
                      <span className="tree-category-icon tree-view-icon">
                        <Eye size={13} />
                      </span>
                      <span className="tree-category-label">Views</span>
                      <span className="tree-category-count">{group.views.length}</span>
                    </button>
                    {isFolderOpen(schemaKey, "views", group.views.length) && (
                      <div className="tree-category-items">
                        {group.views.length === 0 ? (
                          <div className="tree-empty-category">No views</div>
                        ) : (
                          group.views.map((view) => (
                            <div key={view.id}>
                              <div
                                className={
                                  "tree-table-row tree-view-row" +
                                  (activeTable?.id === view.id ? " is-active" : "")
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const x = Math.min(e.clientX, window.innerWidth - 220);
                                  const y = Math.min(e.clientY, window.innerHeight - 280);
                                  setSidebarMenu({
                                    x,
                                    y,
                                    type: "view",
                                    view,
                                  });
                                }}
                              >
                                <button
                                  className={
                                    "tree-table " +
                                    (activeTable?.id === view.id ? "active" : "")
                                  }
                                  title={
                                    mode === "sql"
                                      ? `Click to toggle columns · Double-click to open Data (${view.namespace ? view.namespace + "." : ""}${view.name})`
                                      : `Select view · Double-click to open Data (${view.namespace ? view.namespace + "." : ""}${view.name})`
                                  }
                                  aria-expanded={
                                    mode === "sql"
                                      ? expandedTables.includes(
                                        tableExpansionKey(view.id),
                                      )
                                      : undefined
                                  }
                                  onClick={(event) => {
                                    if (event.detail > 1) return;
                                    if (mode === "sql")
                                      toggleTableColumns(view.id);
                                    else void chooseTable(view.id);
                                  }}
                                  onDoubleClick={() =>
                                    void openTableData(view.id)
                                  }
                                >
                                  <span className="table-icon view-icon">
                                    <Eye size={14} />
                                  </span>
                                  <span className="table-label">
                                    <strong>{view.name}</strong>
                                  </span>
                                </button>
                                <Button
                                  className="table-columns-toggle"
                                  title={`Toggle columns · ${view.name}`}
                                  aria-label={`Toggle columns · ${view.name}`}
                                  aria-expanded={expandedTables.includes(
                                    tableExpansionKey(view.id),
                                  )}
                                  onClick={async () => {
                                    if (mode !== "sql") {
                                      if (!(await leaveDraft())) return;
                                      setDataTable(view.id);
                                    }
                                    toggleTableColumns(view.id);
                                  }}
                                >
                                  {expandedTables.includes(
                                    tableExpansionKey(view.id),
                                  ) ? (
                                    <ChevronDown size={12} />
                                  ) : (
                                    <ChevronRight size={12} />
                                  )}
                                </Button>
                              </div>
                              {expandedTables.includes(
                                tableExpansionKey(view.id),
                              ) && (
                                  <div className="tree-columns">
                                    {view.columns.map((c) => (
                                      <button
                                        key={c.id}
                                        disabled
                                        title={`${view.namespace ? view.namespace + "." : ""}${view.name}.${c.name} · ${c.nativeType ?? c.type}`}
                                      >
                                        <span className="column-dot" />
                                        <span>{c.name}</span>
                                        <code>
                                          {c.nativeType ?? c.type.toLowerCase()}
                                        </code>
                                      </button>
                                    ))}
                                  </div>
                                )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* FUNCTIONS FOLDER */}
                {(group.functions.length > 0 || (!needle && group.name === defaultSchema)) && (
                  <div className="tree-category-folder">
                    <button
                      type="button"
                      className="tree-category-header"
                      onClick={() => toggleFolder(schemaKey, "functions", group.functions.length)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const x = Math.min(e.clientX, window.innerWidth - 220);
                        const y = Math.min(e.clientY, window.innerHeight - 280);
                        setSidebarMenu({
                          x,
                          y,
                          type: "folder",
                          schemaKey,
                          schemaName: group.name,
                          category: "functions",
                          categoryCount: group.functions.length,
                        });
                      }}
                      aria-expanded={isFolderOpen(schemaKey, "functions", group.functions.length)}
                      title={`Functions in ${group.name} (${group.functions.length})`}
                    >
                      <span className="tree-category-arrow">
                        {isFolderOpen(schemaKey, "functions", group.functions.length) ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                      </span>
                      <span className="tree-category-icon tree-func-folder-icon">
                        <Code2 size={13} />
                      </span>
                      <span className="tree-category-label">Functions</span>
                      <span className="tree-category-count">{group.functions.length}</span>
                    </button>
                    {isFolderOpen(schemaKey, "functions", group.functions.length) && (
                      <div className="tree-category-items">
                        {group.functions.length === 0 ? (
                          <div className="tree-empty-category">No functions</div>
                        ) : (
                          group.functions.map((fn) => {
                            const badge = functionKindBadge(fn.kind);
                            const fullSig = `${fn.namespace ? fn.namespace + "." : ""}${fn.name}(${fn.arguments ?? ""})${fn.resultType ? " : " + fn.resultType : ""}`;
                            return (
                              <div
                                key={fn.id}
                                className="tree-func-row"
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const x = Math.min(e.clientX, window.innerWidth - 220);
                                  const y = Math.min(e.clientY, window.innerHeight - 280);
                                  setSidebarMenu({
                                    x,
                                    y,
                                    type: "function",
                                    func: fn,
                                  });
                                }}
                              >
                                <button
                                  type="button"
                                  className="tree-func-button"
                                  title={`Click / Double-click to view code & definition (${fullSig})`}
                                  onClick={() => openFunctionCode(fn)}
                                >
                                  <span
                                    className={
                                      "tree-func-icon" +
                                      (fn.kind === "procedure" ? " is-proc" : "")
                                    }
                                  >
                                    {fn.kind === "procedure" ? (
                                      <Braces size={13} />
                                    ) : (
                                      <Code2 size={13} />
                                    )}
                                  </span>
                                  <span className="tree-func-label">
                                    <strong>{fn.name}</strong>
                                  </span>
                                  <span
                                    className="tree-func-badge"
                                    title={fn.kind ?? "function"}
                                  >
                                    {badge}
                                  </span>
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })
    );
  };

  const activeInfo = useMemo(() => {
    if (mode === "sql") {
      const tab = activeSqlTab(w);
      const source = tab ? tabSource(w, tab) : activeSource;
      const rootSource = connectionRoot(w, source);
      const connName =
        rootSource.name ||
        (source.connection
          ? source.connection.engine === "mssql"
            ? "SQL Server"
            : "PostgreSQL"
          : "");
      const dbName = source.connection?.config.database;
      const subtitleParts = [connName, dbName].filter(Boolean);
      const title = tab?.name || "query.sql";
      return {
        icon: <SquareTerminal size={13} />,
        title,
        subtitle: subtitleParts.length ? `· ${subtitleParts.join(" / ")}` : undefined,
        color: rootSource.color,
        tooltip: tab
          ? `SQL: ${tab.name}${subtitleParts.length ? ` (${subtitleParts.join(" / ")})` : ""}`
          : "SQL Editor",
      };
    } else {
      const rootSource = connectionRoot(w, activeSource);
      const connName =
        rootSource.name ||
        (activeSource.connection
          ? activeSource.connection.engine === "mssql"
            ? "SQL Server"
            : "PostgreSQL"
          : "");
      const dbName = currentDb;
      const subtitleParts = [connName, dbName].filter(Boolean);
      const tableName = activeTable
        ? `${activeTable.namespace ? activeTable.namespace + "." : ""}${activeTable.name}`
        : "";
      const title =
        tableName ||
        (hasActiveConnection
          ? subtitleParts.join(" / ") || "Connected"
          : "Data View");
      return {
        icon: activeTable ? <Table2 size={13} /> : <Database size={13} />,
        title,
        subtitle:
          tableName && subtitleParts.length
            ? `· ${subtitleParts.join(" / ")}`
            : undefined,
        color: rootSource.color,
        tooltip: tableName
          ? `Table: ${tableName}${subtitleParts.length ? ` (${subtitleParts.join(" / ")})` : ""}`
          : "Data View",
      };
    }
  }, [
    mode,
    w,
    activeSource,
    currentDb,
    activeTable,
    hasActiveConnection,
  ]);

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
        <div className="titlebar-left brand" data-tauri-drag-region>
          <ConnectionController
            onAttach={addWorkspaceConnection}
            workspace={w}
            busy={busy}
            onDisconnect={detachWorkspaceConnection}
            onBeforeAction={leaveDraft}
            onConnected={async (sourceId) => {
              if (sourceId) {
                setClosedConnections((prev) => ({ ...prev, [sourceId]: false }));
                setOpenConnections((prev) => ({ ...prev, [sourceId]: true }));
              }
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
          <div
            className="titlebar-active-info"
            title={activeInfo.tooltip}
            data-tauri-drag-region
          >
            {activeInfo.color && (
              <span
                className="titlebar-active-color-dot"
                style={{ backgroundColor: activeInfo.color }}
                aria-hidden="true"
              />
            )}
            <span className="titlebar-active-icon" aria-hidden="true">
              {activeInfo.icon}
            </span>
            <span className="titlebar-active-title">
              {activeInfo.title}
            </span>
            {activeInfo.subtitle && (
              <span className="titlebar-active-subtitle">
                {activeInfo.subtitle}
              </span>
            )}
          </div>
        </div>
        <div className="titlebar-right" data-tauri-drag-region>
          <nav className="mode-switch" aria-label="View" data-tauri-drag-region>
            {modes.map((item) => {
              const isActive = mode === item.id;
              return (
                <button
                  key={item.id}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => void changeMode(item.id)}
                >
                  <item.icon size={13} aria-hidden="true" />
                  <span>{item.label}</span>
                  {isActive && (
                    <span className="mode-active-dot" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </nav>
          <div className="header-actions" data-tauri-drag-region>
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
        </div>
      </header>
      {platform === "windows" && <WindowControls />}
      <div className="workspace" ref={workspaceRef}>
        {left && (
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
              <span>EXPLORER</span>
              <button
                type="button"
                className="tree-new-schema-btn"
                style={{ marginLeft: "auto" }}
                title="New Connection..."
                onClick={handleCreateNewConnection}
              >
                <Plus size={12} />
              </button>
            </div>
            <div
              className="table-list"
              ref={tableList}
              onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest(".tree-connection-header-row, .tree-database-header-row, .tree-schema-header-row, .tree-table-row, .tree-view-row, .tree-func-row, .tree-category-header")) {
                  return;
                }
                e.preventDefault();
                const x = Math.min(e.clientX, window.innerWidth - 220);
                const y = Math.min(e.clientY, window.innerHeight - 280);
                setSidebarMenu({
                  x,
                  y,
                  type: "empty_area",
                });
              }}
            >
              {connectionRoots.length > 0 ? (
                connectionRoots.map((connRoot) => {
                  const connOpen = isConnectionOpen(connRoot.id);
                  const connExpanded = isConnectionExpanded(connRoot.id);
                  const connDatabases = getDatabasesForRoot(connRoot);
                  const connName =
                    connRoot.name ||
                    (connRoot.connection
                      ? `${connRoot.connection.engine === "mssql" ? "SQL Server" : "PostgreSQL"} (${connRoot.connection.config.host})`
                      : "Database Server");
                  const isConnActive = root.id === connRoot.id;

                  return (
                    <div key={connRoot.id} className="tree-connection-group">
                      <div
                        className={`tree-connection-header-row ${connOpen ? "is-open" : "is-closed"} ${isConnActive ? "is-active-root" : ""}`}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const x = Math.min(e.clientX, window.innerWidth - 220);
                          const y = Math.min(e.clientY, window.innerHeight - 280);
                          setSidebarMenu({
                            x,
                            y,
                            type: "connection",
                            connectionRootId: connRoot.id,
                            connectionName: connName,
                          });
                        }}
                      >
                        <button
                          type="button"
                          className="tree-connection-header"
                          onClick={() => {
                            if (!connOpen) return;
                            setCollapsedConnections((prev) => ({
                              ...prev,
                              [connRoot.id]: !prev[connRoot.id],
                            }));
                          }}
                          onDoubleClick={() => {
                            if (!connOpen) {
                              handleOpenConnection(connRoot.id);
                            }
                          }}
                          title={
                            connOpen
                              ? `Connection: ${connName} · ${connExpanded ? "Expanded (click to collapse)" : "Collapsed (click to expand)"}`
                              : `Connection: ${connName} · Closed (double-click or right-click to enter password & reconnect)`
                          }
                          aria-expanded={connExpanded}
                        >
                          {connOpen ? (
                            <span className="tree-schema-arrow">
                              {connExpanded ? (
                                <ChevronDown size={12} />
                              ) : (
                                <ChevronRight size={12} />
                              )}
                            </span>
                          ) : (
                            <span className="tree-schema-arrow-placeholder" />
                          )}
                          <span
                            className={`tree-connection-icon ${connOpen ? "is-open" : "is-closed"}`}
                          >
                            <Server size={13.5} />
                            {connOpen && <span className="schema-status-dot" />}
                          </span>
                          <span className="tree-connection-label">
                            <strong>{connName}</strong>
                          </span>
                          {connRoot.color && (
                            <span
                              className="tree-connection-color-dot"
                              style={{ backgroundColor: connRoot.color }}
                              title={`Connection color: ${connRoot.color}`}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </div>

                      {connOpen && connExpanded && (
                        <div className="tree-connection-content">
                          {connDatabases.map((dbName) => {
                            const isCurrent =
                              isConnActive && dbName.toLowerCase() === currentDb.toLowerCase();
                            const isOpen = isDbOpen(connRoot.id, dbName);
                            const isLoading = Boolean(
                              loadingDatabases[`${connRoot.id}:${dbName}`],
                            );

                            return (
                              <div key={dbName} className="tree-database-group">
                                <div
                                  className={`tree-database-header-row ${isCurrent ? "is-active" : ""}`}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const x = Math.min(e.clientX, window.innerWidth - 220);
                                    const y = Math.min(e.clientY, window.innerHeight - 280);
                                    setSidebarMenu({
                                      x,
                                      y,
                                      type: "database",
                                      connectionRootId: connRoot.id,
                                      databaseName: dbName,
                                    });
                                  }}
                                >
                                  <button
                                    type="button"
                                    className={`tree-database-header ${isCurrent ? "is-active" : ""}`}
                                    onClick={() => void handleDatabaseClick(connRoot.id, dbName)}
                                    title={`Database: ${dbName}${isCurrent ? " (active)" : " (click to switch & explore)"}`}
                                    aria-expanded={isOpen}
                                  >
                                    <span className="tree-schema-arrow">
                                      {isLoading ? (
                                        <Loader2 size={11} className="animate-spin" />
                                      ) : isOpen ? (
                                        <ChevronDown size={11} />
                                      ) : (
                                        <ChevronRight size={11} />
                                      )}
                                    </span>
                                    <span className={`tree-database-icon ${isCurrent ? "is-active" : ""}`}>
                                      <Database size={13} />
                                      {isCurrent && <span className="schema-status-dot" />}
                                    </span>
                                    <span className="tree-database-label">
                                      <strong>{dbName}</strong>
                                    </span>
                                  </button>
                                </div>

                                {isOpen && isCurrent && (
                                  <div className="tree-database-content">
                                    <div
                                      className="tree-schemas-section-header"
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const x = Math.min(e.clientX, window.innerWidth - 220);
                                        const y = Math.min(e.clientY, window.innerHeight - 280);
                                        setSidebarMenu({
                                          x,
                                          y,
                                          type: "schemas_header",
                                        });
                                      }}
                                    >
                                      <span>SCHEMAS ({schemaGroups.length})</span>
                                    </div>
                                    {renderSchemaGroups()}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="sidebar-no-connection">
                  <div className="sidebar-no-connection-icon">
                    <Server size={22} />
                  </div>
                  <p className="sidebar-no-connection-title">No connections</p>
                  <p className="sidebar-no-connection-desc">
                    Connect to a SQL Server or PostgreSQL database.
                  </p>
                  <button
                    type="button"
                    className="sidebar-new-connection-btn"
                    onClick={handleCreateNewConnection}
                  >
                    <Plus size={13} />
                    <span>New Connection</span>
                  </button>
                  {w.schema.tables.length > 0 && renderSchemaGroups()}
                </div>
              )}
              {needle && totalObjectsCount === 0 && (
                <p className="sidebar-empty">No matching objects.</p>
              )}
            </div>
            {sidebarMenu && (
              <div
                ref={sidebarMenuRef}
                className="sidebar-context-menu"
                style={{ left: sidebarMenu.x, top: sidebarMenu.y }}
                role="menu"
              >
                {sidebarMenu.type === "empty_area" && (
                  <>
                    <div className="sidebar-context-header">
                      <strong>Explorer</strong>
                      <small>Connections</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarMenu(null);
                        handleCreateNewConnection();
                      }}
                    >
                      <Plus size={13} />
                      <span>New Connection...</span>
                    </button>
                  </>
                )}
                {sidebarMenu.type === "connection" && (() => {
                  const targetRootId = sidebarMenu.connectionRootId || root.id;
                  const targetRoot = connectionRoots.find((r) => r.id === targetRootId) ?? root;
                  const targetName = sidebarMenu.connectionName || targetRoot.name || "Server Connection";
                  const isMssql = targetRoot.connection?.engine === "mssql";
                  const isOpen = isConnectionOpen(targetRoot.id);

                  return (
                    <>
                      <div className="sidebar-context-header">
                        <strong>{targetName}</strong>
                        <small>Server Connection</small>
                      </div>
                      {isOpen ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setSidebarMenu(null);
                              openSqlWithQuery(
                                generateNewDatabaseTemplate(isMssql),
                                "new-database.sql",
                                { rootId: targetRoot.id },
                              );
                            }}
                          >
                            <Plus size={13} />
                            <span>New Database...</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSidebarMenu(null);
                              void discoverDatabasesForRoot(targetRoot, true);
                            }}
                          >
                            <RotateCw size={13} />
                            <span>Refresh Databases</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSidebarMenu(null);
                              openSqlWithQuery(
                                "",
                                "query.sql",
                                { rootId: targetRoot.id },
                              );
                            }}
                          >
                            <SquareTerminal size={13} />
                            <span>New Query in Server</span>
                          </button>
                          <div className="sidebar-context-divider" />
                          <button
                            type="button"
                            onClick={() => {
                              setSidebarMenu(null);
                              handleCloseConnection(targetRoot.id);
                            }}
                          >
                            <Unplug size={13} />
                            <span>Close Connection</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setSidebarMenu(null);
                              handleOpenConnection(targetRoot.id);
                            }}
                          >
                            <Plug size={13} />
                            <span>Open Connection</span>
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              setSidebarMenu(null);
                              void detachWorkspaceConnection(targetRoot.id);
                            }}
                          >
                            <Trash2 size={13} />
                            <span>Delete Connection</span>
                          </button>
                        </>
                      )}
                      <div className="sidebar-context-divider" />
                      <div className="sidebar-color-picker-section">
                        <div className="sidebar-color-picker-header">
                          <span>Connection Color</span>
                        </div>
                        <div className="sidebar-color-palette">
                          {CONNECTION_COLORS.map((c) => {
                            const isSelected =
                              (!c.color && !targetRoot.color) || c.color === targetRoot.color;
                            return (
                              <button
                                key={c.label}
                                type="button"
                                className={`sidebar-color-dot ${!c.color ? "is-none" : ""} ${isSelected ? "is-selected" : ""}`}
                                style={c.color ? { backgroundColor: c.color } : undefined}
                                title={c.label}
                                onClick={() => {
                                  setSidebarMenu(null);
                                  handleSetConnectionColor(targetRoot.id, c.color);
                                }}
                              >
                                {!c.color && <span>✕</span>}
                              </button>
                            );
                          })}
                          <label className="sidebar-color-custom-btn" title="Custom color...">
                            <input
                              type="color"
                              value={targetRoot.color || "#3b82f6"}
                              onChange={(e) => {
                                setSidebarMenu(null);
                                handleSetConnectionColor(targetRoot.id, e.target.value);
                              }}
                            />
                          </label>
                        </div>
                      </div>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(targetName, "Connection Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Connection Name</span>
                      </button>
                    </>
                  );
                })()}

                {sidebarMenu.type === "database" && sidebarMenu.databaseName && (() => {
                  const dbName = sidebarMenu.databaseName;
                  const targetRootId = sidebarMenu.connectionRootId || root.id;
                  const targetRoot = connectionRoots.find((r) => r.id === targetRootId) ?? root;
                  const isCurrent =
                    root.id === targetRootId &&
                    dbName.toLowerCase() === currentDb.toLowerCase();
                  const isMssql = targetRoot.connection?.engine === "mssql";
                  return (
                    <>
                      <div className="sidebar-context-header">
                        <strong>{dbName}</strong>
                        <small>Database {isCurrent ? "(Active)" : ""}</small>
                      </div>
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => {
                            setSidebarMenu(null);
                            void handleDatabaseClick(targetRoot.id, dbName);
                          }}
                        >
                          <Database size={13} />
                          <span>Switch to Database</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateNewSchemaTemplate(dbName, isMssql),
                            `new-schema-${dbName}.sql`,
                            { rootId: targetRoot.id, database: dbName },
                          );
                        }}
                      >
                        <Plus size={13} />
                        <span>New Schema in Database...</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            "",
                            `${dbName}.sql`,
                            { rootId: targetRoot.id, database: dbName },
                          );
                        }}
                      >
                        <SquareTerminal size={13} />
                        <span>New Query in Database</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      {isMssql ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSidebarMenu(null);
                            openSqlWithQuery(
                              generateMssqlDatabaseBackupScript(dbName),
                              `backup-${dbName}.sql`,
                              { rootId: targetRoot.id, database: dbName },
                            );
                          }}
                        >
                          <HardDrive size={13} />
                          <span>Backup Database (.bak Script)...</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSidebarMenu(null);
                            openSqlWithQuery(
                              generatePostgresBackupScript(dbName),
                              `backup-${dbName}.sql`,
                              { rootId: targetRoot.id, database: dbName },
                            );
                          }}
                        >
                          <HardDrive size={13} />
                          <span>Backup Database (pg_dump Script)...</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateDropDatabaseScript(dbName, Boolean(w.mssql)),
                            `drop-${dbName}.sql`,
                            { rootId: targetRoot.id, database: dbName },
                          );
                        }}
                      >
                        <Trash2 size={13} />
                        <span>Drop Database (Script)...</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(dbName, "Database Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Database Name</span>
                      </button>
                    </>
                  );
                })()}

                {sidebarMenu.type === "schemas_header" && (
                  <>
                    <div className="sidebar-context-header">
                      <strong>Schemas</strong>
                      <small>Catalog ({schemaGroups.length})</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          generateNewSchemaTemplate(currentDb, Boolean(w.mssql)),
                          `new-schema-${currentDb}.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <Plus size={13} />
                      <span>New Schema...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarMenu(null);
                        for (const g of schemaGroups) {
                          const key = `${w.id}:${w.activeSourceId ?? "primary"}:${g.name}`;
                          refreshSchema(key, g.name);
                        }
                      }}
                    >
                      <RotateCw size={13} />
                      <span>Refresh All Schemas</span>
                    </button>
                  </>
                )}

                {sidebarMenu.type === "schema" && (
                  <>
                    <div className="sidebar-context-header">
                      <strong>{sidebarMenu.schemaName}</strong>
                      <small>Schema</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const key = sidebarMenu.schemaKey!;
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        toggleSchema(key, name);
                      }}
                    >
                      {isSchemaOpen(sidebarMenu.schemaKey!, sidebarMenu.schemaName!) ? (
                        <>
                          <ChevronRight size={13} />
                          <span>Collapse Schema</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown size={13} />
                          <span>Open Schema</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const key = sidebarMenu.schemaKey!;
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        refreshSchema(key, name);
                      }}
                    >
                      <RotateCw size={13} />
                      <span>Refresh Schema</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          w.mssql
                            ? `USE [${currentDb}];\nGO\n\n-- Query in schema [${name}]\n`
                            : `SET search_path TO "${name}", public;\n\n`,
                          `${name}-query.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <SquareTerminal size={13} />
                      <span>New Query in Schema</span>
                    </button>
                    <div className="sidebar-context-divider" />
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          generateNewTableTemplate(name, Boolean(w.mssql)),
                          `new-table-${name}.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <Plus size={13} />
                      <span>New Table...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          generateNewSchemaTemplate(currentDb, Boolean(w.mssql)),
                          `new-schema-${currentDb}.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <Plus size={13} />
                      <span>New Schema...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          generateNewViewTemplate(name, Boolean(w.mssql)),
                          `new-view-${name}.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <Plus size={13} />
                      <span>New View...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          generateNewFunctionTemplate(name, Boolean(w.mssql)),
                          `new-routine-${name}.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <Plus size={13} />
                      <span>New Function / Procedure...</span>
                    </button>
                    <div className="sidebar-context-divider" />
                    <button
                      type="button"
                      onClick={async () => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        const group = schemaGroups.find((g) => g.name === name);
                        const ddl = generateSchemaBackupDdl(
                          name,
                          Boolean(w.mssql),
                          group ? group.tables : [],
                          group ? group.views : [],
                          group ? group.functions : [],
                        );
                        const dateStr = new Date().toISOString().slice(0, 10);
                        const ok = await saveExportFile(
                          `${name}_backup_${dateStr}`,
                          "sql",
                          ddl,
                        );
                        if (ok) {
                          setMessage(`Schema "${name}" backup exported successfully`);
                          setError(false);
                        }
                      }}
                    >
                      <Download size={13} />
                      <span>Backup Schema to SQL File...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        const group = schemaGroups.find((g) => g.name === name);
                        const ddl = generateSchemaBackupDdl(
                          name,
                          Boolean(w.mssql),
                          group ? group.tables : [],
                          group ? group.views : [],
                          group ? group.functions : [],
                        );
                        openSqlWithQuery(ddl, `${name}-backup.sql`, {
                          rootId: root.id,
                          database: currentDb,
                        });
                      }}
                    >
                      <HardDrive size={13} />
                      <span>Backup Schema (SQL Script)...</span>
                    </button>
                    {w.mssql && (
                      <button
                        type="button"
                        onClick={() => {
                          const db = w.mssql?.database || "database";
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateMssqlDatabaseBackupScript(db),
                            `backup-${db}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <HardDrive size={13} />
                        <span>Backup Database (.bak Script)...</span>
                      </button>
                    )}
                    {w.postgres && (
                      <button
                        type="button"
                        onClick={() => {
                          const db = w.postgres?.database || "database";
                          const name = sidebarMenu.schemaName;
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generatePostgresBackupScript(db, name),
                            `backup-${db}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <HardDrive size={13} />
                        <span>Backup Database (pg_dump Script)...</span>
                      </button>
                    )}
                    <div className="sidebar-context-divider" />
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        copyText(name, "Schema Name");
                      }}
                    >
                      <Copy size={13} />
                      <span>Copy Schema Name</span>
                    </button>
                  </>
                )}

                {sidebarMenu.type === "folder" && (
                  <>
                    <div className="sidebar-context-header">
                      <strong>
                        {sidebarMenu.schemaName} / {sidebarMenu.category}
                      </strong>
                      <small>Category Folder</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const key = sidebarMenu.schemaKey!;
                        const cat = sidebarMenu.category!;
                        const count = sidebarMenu.categoryCount ?? 0;
                        setSidebarMenu(null);
                        toggleFolder(key, cat, count);
                      }}
                    >
                      {isFolderOpen(
                        sidebarMenu.schemaKey!,
                        sidebarMenu.category!,
                        sidebarMenu.categoryCount ?? 0,
                      ) ? (
                        <>
                          <ChevronRight size={13} />
                          <span>Collapse Folder</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown size={13} />
                          <span>Expand Folder</span>
                        </>
                      )}
                    </button>
                    {sidebarMenu.category === "tables" && (
                      <button
                        type="button"
                        onClick={() => {
                          const name = sidebarMenu.schemaName!;
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateNewTableTemplate(name, Boolean(w.mssql)),
                            `new-table-${name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Plus size={13} />
                        <span>New Table...</span>
                      </button>
                    )}
                    {sidebarMenu.category === "views" && (
                      <button
                        type="button"
                        onClick={() => {
                          const name = sidebarMenu.schemaName!;
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateNewViewTemplate(name, Boolean(w.mssql)),
                            `new-view-${name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Plus size={13} />
                        <span>New View...</span>
                      </button>
                    )}
                    {sidebarMenu.category === "functions" && (
                      <button
                        type="button"
                        onClick={() => {
                          const name = sidebarMenu.schemaName!;
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateNewFunctionTemplate(name, Boolean(w.mssql)),
                            `new-routine-${name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Plus size={13} />
                        <span>New Function / Procedure...</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const key = sidebarMenu.schemaKey!;
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        refreshSchema(key, name);
                      }}
                    >
                      <RotateCw size={13} />
                      <span>Refresh</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const name = sidebarMenu.schemaName!;
                        setSidebarMenu(null);
                        openSqlWithQuery(
                          w.mssql
                            ? `USE [${currentDb}];\nGO\n\n-- Query in schema [${name}]\n`
                            : `SET search_path TO "${name}", public;\n\n`,
                          `${name}-query.sql`,
                          { rootId: root.id, database: currentDb },
                        );
                      }}
                    >
                      <SquareTerminal size={13} />
                      <span>New Query</span>
                    </button>
                  </>
                )}

                {sidebarMenu.type === "table" && sidebarMenu.table && (() => {
                  const t = sidebarMenu.table;
                  const qName = t.namespace
                    ? w.mssql
                      ? `[${t.namespace}].[${t.name}]`
                      : `"${t.namespace}"."${t.name}"`
                    : w.mssql
                      ? `[${t.name}]`
                      : `"${t.name}"`;
                  const selectQuery = w.mssql
                    ? `SELECT TOP 1000 *\nFROM ${qName};`
                    : `SELECT *\nFROM ${qName}\nLIMIT 1000;`;
                  const colList = t.columns
                    .map((c) => (w.mssql ? `[${c.name}]` : `"${c.name}"`))
                    .join(", ");
                  return (
                    <>
                      <div className="sidebar-context-header">
                        <strong>{t.name}</strong>
                        <small>Table · {t.namespace ?? "default"}</small>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          void openTableData(t.id);
                        }}
                      >
                        <Table2 size={13} />
                        <span>Open Table Data</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(selectQuery, `${t.name}.sql`, {
                            rootId: root.id,
                            database: currentDb,
                          });
                        }}
                      >
                        <Play size={13} />
                        <span>Select Top 1000 Rows</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateTableDdl(t, Boolean(w.mssql)),
                            `${t.name}-ddl.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <FileCode size={13} />
                        <span>Design / View Table DDL</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateAlterTableTemplate(t, Boolean(w.mssql)),
                            `alter-${t.name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Pencil size={13} />
                        <span>Alter Table (DDL Script)...</span>
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateDropTableScript(t, Boolean(w.mssql)),
                            `drop-${t.name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Trash2 size={13} />
                        <span>Drop Table (Script)...</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={async () => {
                          setSidebarMenu(null);
                          const ddl = generateTableDdl(t, Boolean(w.mssql));
                          const dateStr = new Date().toISOString().slice(0, 10);
                          const ok = await saveExportFile(
                            `${t.name}_backup_${dateStr}`,
                            "sql",
                            ddl,
                          );
                          if (ok) {
                            setMessage(
                              `Table "${t.name}" backup exported successfully`,
                            );
                            setError(false);
                          }
                        }}
                      >
                        <Download size={13} />
                        <span>Backup Table to SQL File...</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateTableDataBackupTemplate(
                              t,
                              Boolean(w.mssql),
                            ),
                            `backup-data-${t.name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <HardDrive size={13} />
                        <span>Backup Table Data (INSERT Script)...</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(t.name, "Table Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Table Name</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(qName, "Full Qualified Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Qualified Name</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(colList, "Column Names");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Column Names</span>
                      </button>
                    </>
                  );
                })()}

                {sidebarMenu.type === "view" && sidebarMenu.view && (() => {
                  const v = sidebarMenu.view;
                  const qName = v.namespace
                    ? w.mssql
                      ? `[${v.namespace}].[${v.name}]`
                      : `"${v.namespace}"."${v.name}"`
                    : w.mssql
                      ? `[${v.name}]`
                      : `"${v.name}"`;
                  const selectQuery = w.mssql
                    ? `SELECT TOP 1000 *\nFROM ${qName};`
                    : `SELECT *\nFROM ${qName}\nLIMIT 1000;`;
                  const colList = v.columns
                    .map((c) => (w.mssql ? `[${c.name}]` : `"${c.name}"`))
                    .join(", ");
                  return (
                    <>
                      <div className="sidebar-context-header">
                        <strong>{v.name}</strong>
                        <small>View · {v.namespace ?? "default"}</small>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          void openTableData(v.id);
                        }}
                      >
                        <Eye size={13} />
                        <span>Open View Data</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(selectQuery, `${v.name}.sql`, {
                            rootId: root.id,
                            database: currentDb,
                          });
                        }}
                      >
                        <Play size={13} />
                        <span>Select Top 1000 Rows</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateViewDdl(v, Boolean(w.mssql)),
                            `${v.name}-ddl.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <FileCode size={13} />
                        <span>Design / View View DDL</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateViewDdl(v, Boolean(w.mssql)),
                            `alter-${v.name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Pencil size={13} />
                        <span>Alter View (DDL Script)...</span>
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateDropViewScript(v, Boolean(w.mssql)),
                            `drop-${v.name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Trash2 size={13} />
                        <span>Drop View (Script)...</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(v.name, "View Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy View Name</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(qName, "Full Qualified Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Qualified Name</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(colList, "Column Names");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Column Names</span>
                      </button>
                    </>
                  );
                })()}

                {sidebarMenu.type === "function" && sidebarMenu.func && (() => {
                  const fn = sidebarMenu.func;
                  const schemaPrefix = fn.namespace ? `${fn.namespace}.` : "";
                  const isProc = fn.kind === "procedure";
                  const argStr = fn.arguments ? `/* ${fn.arguments} */` : "";
                  const invocation = isProc
                    ? w.mssql
                      ? `EXEC ${schemaPrefix}${fn.name} ${argStr};`
                      : `CALL ${schemaPrefix}${fn.name}(${argStr});`
                    : `SELECT ${schemaPrefix}${fn.name}(${argStr});`;
                  const fullSig = `${schemaPrefix}${fn.name}(${fn.arguments ?? ""})${fn.resultType ? " : " + fn.resultType : ""}`;
                  return (
                    <>
                      <div className="sidebar-context-header">
                        <strong>{fn.name}</strong>
                        <small>
                          {fn.kind ?? "function"} · {fn.namespace ?? "default"}
                        </small>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openFunctionCode(fn, {
                            rootId: root.id,
                            database: currentDb,
                          });
                        }}
                      >
                        <FileCode size={13} />
                        <span>View / Design Function Code</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            invocation,
                            `${fn.name}-call.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Play size={13} />
                        <span>Call / Execute Snippet</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          handleFunctionClick(fn);
                        }}
                      >
                        <SquareTerminal size={13} />
                        <span>Insert Call Snippet into Active Tab</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          openFunctionCode(fn, {
                            rootId: root.id,
                            database: currentDb,
                          });
                        }}
                      >
                        <Pencil size={13} />
                        <span>Alter Routine (Script)...</span>
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setSidebarMenu(null);
                          openSqlWithQuery(
                            generateDropFuncScript(fn, Boolean(w.mssql)),
                            `drop-${fn.name}.sql`,
                            { rootId: root.id, database: currentDb },
                          );
                        }}
                      >
                        <Trash2 size={13} />
                        <span>Drop Routine (Script)...</span>
                      </button>
                      <div className="sidebar-context-divider" />
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(fn.name, "Function Name");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Function Name</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(fullSig, "Signature");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Signature</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarMenu(null);
                          copyText(invocation, "Call Statement");
                        }}
                      >
                        <Copy size={13} />
                        <span>Copy Call Statement</span>
                      </button>
                    </>
                  );
                })()}
              </div>
            )}
          </aside>
        )}
        {left && (
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
          {isConnectionAccessible && mode === "sql" ? (
            <MultiSqlWorkspace
              key={w.id}
              workspace={w}
              dark={dark}
              busy={busy}
              onBusy={setBusy}
              runRef={remoteRun}
            />
          ) : isConnectionAccessible ? (
            <RemoteWorkspace
              key={
                w.id +
                connectionRevision +
                (w.activeSourceId ?? "") +
                JSON.stringify(w.postgres ?? w.mssql ?? activeSource.connection?.config)
              }
              sessionKey={
                w.activeSourceId
                  ? sourceSessionKey(w.id, w.activeSourceId)
                  : w.id
              }
              workspace={
                !w.postgres && !w.mssql && activeSource.connection
                  ? {
                    ...w,
                    postgres:
                      activeSource.connection.engine === "postgres"
                        ? activeSource.connection.config
                        : undefined,
                    mssql:
                      activeSource.connection.engine === "mssql"
                        ? activeSource.connection.config
                        : undefined,
                  }
                  : w
              }
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
              <h2 id="connection-empty-title">
                {hasActiveConnection && !isConnectionOpen(root.id)
                  ? `Connect to ${connectionName}`
                  : "Connect to a database"}
              </h2>
              <p>
                {hasActiveConnection && !isConnectionOpen(root.id)
                  ? `Connection "${connectionName}" is closed. Open connection to use SQL and Data.`
                  : "Add a PostgreSQL or SQL Server connection to browse tables and run queries."}
              </p>
              {hasActiveConnection && !isConnectionOpen(root.id) ? (
                <Button
                  className="button-primary"
                  onClick={() => handleOpenConnection(root.id)}
                >
                  <Plug size={14} />
                  <span>Open Connection</span>
                </Button>
              ) : (
                <Button
                  className="button-primary"
                  onClick={handleCreateNewConnection}
                >
                  <Plus size={14} />
                  <span>New Connection</span>
                </Button>
              )}
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
