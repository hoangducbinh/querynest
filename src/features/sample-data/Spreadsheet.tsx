import {
  gridPosition,
  rememberGridPosition,
  rememberGridView,
} from "./view-state";
import {
  ColumnResizeHandle,
  fitColumnWidth,
  useColumnWidths,
  useColumnWindow,
} from "./column-sizing";
import { columnTypeHint } from "../sql/ResultSetView";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  CopyPlus,
  Download,
  FileCode2,
  KeyRound,
  Lock,
  LockOpen,
  Maximize2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { ColumnDefinition, TableDefinition } from "../../types/schema";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { saveExportFile } from "../../lib/platform/save-file";
import {
  buildCopyAsCsv,
  buildCopyAsInsert,
  buildCopyAsTsv,
  buildCopyAsUpdate,
} from "../sql/result-sql-copy";
import type { SqlDialect } from "../sql/data-types";
import {
  cellText,
  isChanged,
  makeDraft,
  parseClipboard,
  pasteCells,
  type CellValue,
  type DraftRow,
} from "./model";

const PAGE_SIZE = 100;

interface SortState {
  colId: string;
  dir: "asc" | "desc";
}

const initialDrafts = (rows: Record<string, unknown>[]) =>
  rows.map((row) => makeDraft(row));

const valueAt = (row: DraftRow, name: string): CellValue =>
  Object.hasOwn(row.cells, name)
    ? row.cells[name]
    : row.original?.[name] === null
      ? null
      : row.original && Object.hasOwn(row.original, name)
        ? cellText(row.original[name])
        : undefined;

const isPopulatedRow = (row: DraftRow): boolean =>
  Boolean(row.original) || isChanged(row);

function effectiveRowValue(row: DraftRow, col: ColumnDefinition): unknown {
  if (Object.hasOwn(row.cells, col.name)) {
    const edited = row.cells[col.name];
    if (edited === null || edited === undefined) return null;
    if (col.type === "BOOLEAN") {
      const lower = edited.trim().toLowerCase();
      if (lower === "true" || lower === "1") return true;
      if (lower === "false" || lower === "0") return false;
    }
    if (
      (col.type === "INTEGER" ||
        col.type === "BIGINT" ||
        col.type === "FLOAT" ||
        col.type === "DECIMAL") &&
      edited.trim() !== "" &&
      !Number.isNaN(Number(edited))
    ) {
      return Number(edited);
    }
    return edited;
  }
  if (row.original && Object.hasOwn(row.original, col.name)) {
    return row.original[col.name];
  }
  return null;
}

function draftToRecord(
  row: DraftRow,
  columns: ColumnDefinition[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    out[col.name] = effectiveRowValue(row, col);
  }
  return out;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const numA = Number(a);
  const numB = Number(b);
  if (
    String(a).trim() !== "" &&
    String(b).trim() !== "" &&
    !Number.isNaN(numA) &&
    !Number.isNaN(numB)
  ) {
    return numA - numB;
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

interface Props {
  viewKey?: string;
  table: TableDefinition;
  rows: Record<string, unknown>[];
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (rows: DraftRow[]) => Promise<Record<string, unknown>[]>;
  onAddColumn?: (anchor: HTMLButtonElement) => void;
  onEditColumn?: (columnId: string, anchor: HTMLButtonElement) => void;
  serverPage?: {
    index: number;
    hasNext: boolean;
    onChange: (page: number) => void;
  };
  readOnlyReason?: string;
  onDiscard?: () => Promise<Record<string, unknown>[]>;
  structureDisabled: boolean;
  dialect?: SqlDialect;
  stackHeader?: {
    collapsed: boolean;
    onToggleCollapse: () => void;
    onMaximize: () => void;
    onClose?: () => void;
  };
}

export function Spreadsheet({
  viewKey,
  table,
  rows,
  disabled,
  onDirty,
  onSave,
  onAddColumn,
  onEditColumn,
  structureDisabled,
  serverPage,
  readOnlyReason,
  onDiscard,
  dialect = "default",
  stackHeader,
}: Props) {
  const [drafts, setDrafts] = useState<DraftRow[]>(() => initialDrafts(rows));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const canUnlock = !readOnlyReason;
  const editable = canUnlock && isUnlocked;
  const [filter, setFilter] = useState(() =>
    viewKey ? gridPosition(viewKey).filter : "",
  );
  const [filterCol, setFilterCol] = useState<string>("*");
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(() =>
    viewKey ? gridPosition(viewKey).page : 0,
  );
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    rowIndex: number;
    colIndex: number;
  } | null>(null);

  const lastSelectedIndexRef = useRef<number | null>(null);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (viewKey) rememberGridView(viewKey, page, filter);
  }, [viewKey, page, filter]);

  useEffect(() => {
    setSort(null);
    setFilterCol("*");
    setIsUnlocked(false);
  }, [table.id, table.namespace]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!copyMenuOpen && !exportMenuOpen && !contextMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        copyMenuOpen &&
        copyMenuRef.current &&
        target &&
        !copyMenuRef.current.contains(target)
      ) {
        setCopyMenuOpen(false);
      }
      if (
        exportMenuOpen &&
        exportMenuRef.current &&
        target &&
        !exportMenuRef.current.contains(target)
      ) {
        setExportMenuOpen(false);
      }
      if (
        contextMenu &&
        contextMenuRef.current &&
        target &&
        !contextMenuRef.current.contains(target)
      ) {
        setContextMenu(null);
      }
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setCopyMenuOpen(false);
        setExportMenuOpen(false);
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [copyMenuOpen, exportMenuOpen, contextMenu]);

  const root = useRef<HTMLDivElement>(null);
  const sizing = useColumnWidths(
    `data:${table.namespace ?? ""}:${table.id}:${table.name}`,
    table.columns.map((column) => column.id),
  );
  const defaultWidths = useMemo(
    () =>
      table.columns.map((column) =>
        fitColumnWidth(
          column.name,
          rows.slice(0, 100).map((row) => row[column.name]),
          280,
        ),
      ),
    [table.columns, rows],
  );
  const cellHints = useMemo(
    () =>
      table.columns.map((column) =>
        columnTypeHint(column.nativeType ?? column.type),
      ),
    [table.columns],
  );
  const widths = table.columns.map((column, index) =>
    sizing.width(column.id, defaultWidths[index]),
  );
  const columnViewport = useColumnWindow(
    widths,
    38,
    viewKey ? gridPosition(viewKey) : undefined,
  );
  const visibleColumns = useMemo(
    () =>
      table.columns
        .slice(columnViewport.start, columnViewport.end)
        .map((column, offset) => ({
          column,
          index: columnViewport.start + offset,
        })),
    [table.columns, columnViewport.start, columnViewport.end],
  );
  const previousRows = useRef(rows);
  const dirty = drafts.some(isChanged);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const changes = drafts.filter(isChanged);
  const added = changes.filter((r) => !r.original && !r.deleted).length;
  const changed = changes.filter((r) => r.original && !r.deleted).length;
  const removed = changes.filter((r) => r.original && r.deleted).length;

  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);

  useEffect(() => {
    if (rows === previousRows.current) return;
    previousRows.current = rows;
    if (!dirtyRef.current) {
      setDrafts(initialDrafts(rows));
      setSelected(new Set());
    }
  }, [rows]);

  useLayoutEffect(() => {
    if (focus) {
      const input = root.current?.querySelector<HTMLInputElement>(
        `input[data-row="${focus.row}"][data-col="${focus.col}"]`,
      );
      if (!input) {
        const viewport = columnViewport.ref.current;
        if (viewport) {
          const left =
            38 +
            widths.slice(0, focus.col).reduce((sum, width) => sum + width, 0);
          viewport.scrollLeft = Math.max(0, left - 38);
        }
        return;
      }
      input.focus();
      input.select();
      setFocus(null);
    }
  }, [focus, drafts, columnViewport.start, columnViewport.end]);

  const qualifiedTableName = useMemo(
    () => (table.namespace ? `${table.namespace}.${table.name}` : table.name),
    [table.namespace, table.name],
  );

  const allColumnNames = useMemo(
    () => table.columns.map((col) => col.name),
    [table.columns],
  );

  function update(row: number, col: number, value: CellValue) {
    const column = table.columns[col];
    if (
      !editable ||
      disabled ||
      saving ||
      !column ||
      column.generated ||
      column.readOnly ||
      (drafts[row]?.original && !table.primaryKey.length)
    )
      return;
    setError("");
    setNotice("");
    setDrafts((current) =>
      current.map((r, i) =>
        i === row
          ? { ...r, cells: { ...r.cells, [table.columns[col].name]: value } }
          : r,
      ),
    );
  }

  function addRow() {
    if (!editable || disabled || saving || readOnlyReason) return;
    const newRow = {
      ...makeDraft(),
      insert: Boolean(serverPage),
    };
    const row = drafts.length;
    setDrafts((current) => [...current, newRow]);
    setFilter("");
    const column = table.columns.findIndex((c) => !c.generated && !c.readOnly);
    const col = Math.max(0, column);
    setActive({ row, col });
    setFocus({ row, col });
  }

  function duplicateRows(explicitRowIndices?: number[]) {
    if (!editable || disabled || saving || readOnlyReason) return;
    const sourceRows: DraftRow[] = explicitRowIndices?.length
      ? explicitRowIndices
          .map((idx) => drafts[idx])
          .filter((r): r is DraftRow => Boolean(r))
      : selected.size > 0
        ? drafts.filter((r) => selected.has(r.id))
        : drafts[active.row]
          ? [drafts[active.row]]
          : [];

    if (!sourceRows.length) return;

    const pkSet = new Set(table.primaryKey);
    const clonedDrafts: DraftRow[] = sourceRows.map((src) => {
      const cells: Record<string, CellValue> = {};
      for (const col of table.columns) {
        if (col.generated || col.readOnly) continue;
        if (
          (pkSet.has(col.id) || pkSet.has(col.name)) &&
          Boolean(col.defaultValue)
        ) {
          continue;
        }
        const val = valueAt(src, col.name);
        if (val !== undefined) {
          cells[col.name] = val;
        }
      }
      return {
        ...makeDraft(),
        cells,
        insert: Boolean(serverPage),
      };
    });

    const firstInsertedIndex = drafts.length;
    setDrafts((current) => [...current, ...clonedDrafts]);

    const firstEditableCol = Math.max(
      0,
      table.columns.findIndex((c) => !c.generated && !c.readOnly),
    );
    setActive({ row: firstInsertedIndex, col: firstEditableCol });
    setFocus({ row: firstInsertedIndex, col: firstEditableCol });
    setNotice(
      `Duplicated ${clonedDrafts.length} row${clonedDrafts.length === 1 ? "" : "s"}`,
    );
  }

  function navigate(row: number, col: number) {
    if (col < 0) {
      row--;
      col = table.columns.length - 1;
    }
    if (col >= table.columns.length) {
      row++;
      col = 0;
    }
    if (row < 0 || row >= drafts.length) return;
    const target = drafts[row];
    if (target?.original) {
      const position = matchingSaved.findIndex(
        ({ row: item }) => item.id === target.id,
      );
      if (position >= 0) setPage(Math.floor(position / PAGE_SIZE));
    }
    setActive({ row, col });
    setFocus({ row, col });
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void save();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      e.stopPropagation();
      duplicateRows([r]);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(r + (e.shiftKey ? -1 : 1), c);
    }
    if (e.key === "Tab") {
      e.preventDefault();
      navigate(r, c + (e.shiftKey ? -1 : 1));
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      navigate(r + (e.key === "ArrowDown" ? 1 : -1), c);
    }
    if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      navigate(r, c - 1);
    }
    if (
      e.key === "ArrowRight" &&
      e.currentTarget.selectionStart === e.currentTarget.value.length
    ) {
      e.preventDefault();
      navigate(r, c + 1);
    }
    if (e.key === "Backspace" && e.altKey) {
      e.preventDefault();
      update(r, c, null);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDrafts((current) =>
        current.map((row, i) => {
          if (i !== r) return row;
          const cells = { ...row.cells };
          delete cells[table.columns[c].name];
          return { ...row, cells };
        }),
      );
    }
  }

  async function save() {
    if (disabled || saving || !dirty || requiresRefresh) return;
    if (
      removed &&
      !(await confirmAction(
        `Delete ${removed} selected row${removed === 1 ? "" : "s"} and save the other changes?`,
      ))
    )
      return;
    setSaving(true);
    setError("");
    try {
      const next = await onSave(drafts);
      setDrafts(initialDrafts(next));
      setSelected(new Set());
      setNotice("Changes saved");
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        "requiresRefresh" in e &&
        e.requiresRefresh
      )
        setRequiresRefresh(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function discardChanges() {
    if (!dirty || saving) return;
    if (await confirmAction("Discard unsaved cell changes?")) {
      setSaving(true);
      try {
        const next = onDiscard ? await onDiscard() : rows;
        setDrafts(initialDrafts(next));
        setSelected(new Set());
        setError("");
        setNotice("");
        setRequiresRefresh(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }
  }

  function deleteSelected(explicitRowIds?: Set<string>) {
    if (!editable || disabled || saving || readOnlyReason) return;
    const targetIds =
      explicitRowIds && explicitRowIds.size > 0
        ? explicitRowIds
        : selected.size > 0
          ? selected
          : drafts[active.row]
            ? new Set([drafts[active.row].id])
            : new Set<string>();
    if (!targetIds.size) return;
    if (
      !table.primaryKey.length &&
      drafts.some((r) => targetIds.has(r.id) && r.original)
    ) {
      return;
    }
    setDrafts((current) =>
      current.flatMap((row) =>
        !targetIds.has(row.id)
          ? [row]
          : row.original
            ? [{ ...row, deleted: !row.deleted }]
            : [],
      ),
    );
    setSelected(new Set());
    setError("");
  }

  const hasActiveFilter = filter.trim().length > 0;

  const matching = useMemo(() => {
    const indexed = drafts.map((row, index) => ({ row, index }));
    const query = filter.toLowerCase();
    const filtered = indexed.filter(({ row }) => {
      if (!hasActiveFilter) return true;
      if (!row.original || Object.keys(row.cells).length > 0) return true;
      if (filterCol !== "*") {
        const col = table.columns.find((c) => c.name === filterCol);
        if (!col) return true;
        const val = effectiveRowValue(row, col);
        const text = val === null || val === undefined ? "null" : cellText(val);
        return text.toLowerCase().includes(query);
      }
      return table.columns.some((c) =>
        cellText(effectiveRowValue(row, c)).toLowerCase().includes(query),
      );
    });

    if (!sort) return filtered;
    const sortCol = table.columns.find((c) => c.id === sort.colId);
    if (!sortCol) return filtered;

    const dirMultiplier = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const valA = effectiveRowValue(a.row, sortCol);
      const valB = effectiveRowValue(b.row, sortCol);
      const cmp = compareValues(valA, valB);
      return cmp !== 0 ? cmp * dirMultiplier : a.index - b.index;
    });
  }, [drafts, hasActiveFilter, filter, filterCol, sort, table.columns]);

  const matchingSaved = useMemo(
    () => matching.filter(({ row }) => !!row.original),
    [matching],
  );
  const matchingPopulated = useMemo(
    () => matching.filter(({ row }) => !row.deleted),
    [matching],
  );

  const pageCount = Math.max(1, Math.ceil(matchingSaved.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const displayedSaved = useMemo(
    () =>
      new Set(
        matchingSaved
          .slice(pageStart, pageStart + PAGE_SIZE)
          .map(({ row }) => row.id),
      ),
    [matchingSaved, pageStart],
  );
  const visible = useMemo(
    () =>
      matching.filter(
        ({ row }) =>
          (!readOnlyReason || !!row.original) &&
          (!row.original || displayedSaved.has(row.id)),
      ),
    [matching, readOnlyReason, displayedSaved],
  );
  const visiblePopulated = useMemo(
    () => visible.filter(({ row }) => !row.deleted),
    [visible],
  );

  function toggleSort(colId: string) {
    setSort((current) => {
      if (!current || current.colId !== colId) return { colId, dir: "asc" };
      if (current.dir === "asc") return { colId, dir: "desc" };
      return null;
    });
  }

  function changePage(next: number) {
    setPage(next);
    const first = matchingSaved[next * PAGE_SIZE];
    if (first) setActive({ row: first.index, col: 0 });
    root.current?.querySelector(".sheet-grid-scroll")?.scrollTo({ top: 0 });
  }

  function getTargetDraftRows(explicitRowIndex?: number): DraftRow[] {
    if (
      explicitRowIndex !== undefined &&
      drafts[explicitRowIndex] &&
      !selected.has(drafts[explicitRowIndex].id)
    ) {
      const target = drafts[explicitRowIndex];
      return !target.deleted ? [target] : [];
    }
    if (selected.size > 0) {
      return matchingPopulated
        .map(({ row }) => row)
        .filter((row) => selected.has(row.id));
    }
    if (drafts[active.row] && !drafts[active.row].deleted) {
      return [drafts[active.row]];
    }
    return visiblePopulated.map(({ row }) => row);
  }

  function getExportDraftRows(): DraftRow[] {
    if (selected.size > 0) {
      return matchingPopulated
        .map(({ row }) => row)
        .filter((row) => selected.has(row.id));
    }
    return matchingPopulated.map(({ row }) => row);
  }

  async function handleCopyAsInsert(explicitRowIndex?: number) {
    const targetDrafts = getTargetDraftRows(explicitRowIndex);
    if (!targetDrafts.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, table.columns));
    const sqlText = buildCopyAsInsert({
      table,
      columns: allColumnNames,
      rows: records,
      dialect,
    });
    await copyTextToClipboard(sqlText);
    setNotice(
      `Copied ${records.length} row${records.length === 1 ? "" : "s"} as INSERT`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsUpdate(explicitRowIndex?: number) {
    const targetDrafts = getTargetDraftRows(explicitRowIndex);
    if (!targetDrafts.length) return;
    const updateRows = targetDrafts.map((r) => ({
      current: draftToRecord(r, table.columns),
      original: r.original,
    }));
    const sqlText = buildCopyAsUpdate({
      table,
      columns: allColumnNames,
      rows: updateRows,
      dialect,
    });
    await copyTextToClipboard(sqlText);
    setNotice(
      `Copied ${updateRows.length} row${updateRows.length === 1 ? "" : "s"} as UPDATE`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsCsv(explicitRowIndex?: number) {
    const targetDrafts = getTargetDraftRows(explicitRowIndex);
    if (!targetDrafts.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, table.columns));
    const csvText = buildCopyAsCsv(allColumnNames, records);
    await copyTextToClipboard(csvText);
    setNotice(
      `Copied ${records.length} row${records.length === 1 ? "" : "s"} as CSV`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsTsv(explicitRowIndex?: number) {
    const targetDrafts = getTargetDraftRows(explicitRowIndex);
    if (!targetDrafts.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, table.columns));
    const tsvText = buildCopyAsTsv(allColumnNames, records);
    await copyTextToClipboard(tsvText);
    setNotice(
      `Copied ${records.length} row${records.length === 1 ? "" : "s"} as TSV`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsJson(explicitRowIndex?: number) {
    const targetDrafts = getTargetDraftRows(explicitRowIndex);
    if (!targetDrafts.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, table.columns));
    const jsonText = JSON.stringify(records, null, 2);
    await copyTextToClipboard(jsonText);
    setNotice(
      `Copied ${records.length} row${records.length === 1 ? "" : "s"} as JSON`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyCellValue(rowIdx = active.row, colIdx = active.col) {
    const row = drafts[rowIdx];
    const col = table.columns[colIdx];
    if (!row || !col) return;
    const val = valueAt(row, col.name);
    await copyTextToClipboard(val === null || val === undefined ? "NULL" : val);
    setNotice(`Copied ${col.name}`);
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleExport(format: "sql" | "csv" | "json") {
    const targetDrafts = getExportDraftRows();
    if (!targetDrafts.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, table.columns));
    let contents = "";
    if (format === "sql") {
      contents = buildCopyAsInsert({
        table,
        columns: allColumnNames,
        rows: records,
        dialect,
      });
    } else if (format === "csv") {
      contents = buildCopyAsCsv(allColumnNames, records);
    } else {
      contents = JSON.stringify(records, null, 2);
    }
    setExportMenuOpen(false);
    setContextMenu(null);
    const saved = await saveExportFile(table.name, format, contents);
    if (saved) {
      setNotice(
        `Exported ${records.length} row${records.length === 1 ? "" : "s"} as .${format}`,
      );
    }
  }

  function handleFilterByCell(rowIdx: number, colIdx: number) {
    const row = drafts[rowIdx];
    const col = table.columns[colIdx];
    if (!row || !col) return;
    const val = effectiveRowValue(row, col);
    setFilterCol(col.name);
    setFilter(val === null || val === undefined ? "NULL" : cellText(val));
    setPage(0);
    setContextMenu(null);
  }

  function paste(
    event: ClipboardEvent<HTMLInputElement>,
    row: number,
    column: number,
  ) {
    if (!editable || disabled || saving || readOnlyReason || requiresRefresh) {
      event.preventDefault();
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!/[\t\r\n]/.test(text)) return;
    event.preventDefault();
    try {
      setDrafts((current) => {
        const pasted = pasteCells(
          current,
          table,
          row,
          column,
          parseClipboard(text),
        );
        if (
          pasted.length > current.length &&
          !pasted.at(-1)?.original &&
          !isChanged(pasted.at(-1)!)
        ) {
          pasted.pop();
        }
        return pasted;
      });
      setError("");
      setNotice("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleRowSelect(
    rowId: string,
    rowIndex: number,
    checked: boolean,
    shiftKey = false,
  ) {
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelectedIndexRef.current !== null) {
        const visibleIndices = visible.map((item) => item.index);
        const posA = visibleIndices.indexOf(lastSelectedIndexRef.current);
        const posB = visibleIndices.indexOf(rowIndex);
        if (posA >= 0 && posB >= 0) {
          const [startPos, endPos] =
            posA <= posB ? [posA, posB] : [posB, posA];
          for (let i = startPos; i <= endPos; i++) {
            const item = visible[i];
            if (item && isPopulatedRow(item.row)) {
              if (checked) next.add(item.row.id);
              else next.delete(item.row.id);
            }
          }
          lastSelectedIndexRef.current = rowIndex;
          return next;
        }
      }
      if (checked) next.add(rowId);
      else next.delete(rowId);
      lastSelectedIndexRef.current = rowIndex;
      return next;
    });
  }

  function openContextMenu(
    event: ReactMouseEvent,
    rowIndex: number,
    colIndex: number,
  ) {
    event.preventDefault();
    const safeCol = Math.max(0, colIndex);
    setActive({ row: rowIndex, col: safeCol });
    const row = drafts[rowIndex];
    if (row && !selected.has(row.id)) {
      setSelected(new Set([row.id]));
      lastSelectedIndexRef.current = rowIndex;
    }
    const menuWidth = 225;
    const menuHeight = 340;
    const x = Math.min(
      event.clientX,
      Math.max(12, window.innerWidth - menuWidth - 12),
    );
    const y = Math.min(
      event.clientY,
      Math.max(12, window.innerHeight - menuHeight - 12),
    );
    setContextMenu({ x, y, rowIndex, colIndex: safeCol });
  }

  const cellHandlers = useRef<CellHandlers>({
    update,
    handleKey,
    paste,
    focus: () => {},
    select: () => {},
    contextMenu: () => {},
  });
  cellHandlers.current = {
    select: handleRowSelect,
    update,
    handleKey,
    paste,
    focus: (row, col) =>
      setActive((old) =>
        old.row === row && old.col === col ? old : { row, col },
      ),
    contextMenu: openContextMenu,
  };

  const selectedRow = drafts[active.row];
  const activeColumn = table.columns[active.col];
  const activeVisiblePosition = visiblePopulated.findIndex(
    ({ index }) => index === active.row,
  );
  const canMovePrev = activeVisiblePosition > 0;
  const canMoveNext =
    activeVisiblePosition >= 0 &&
    activeVisiblePosition < visiblePopulated.length - 1;

  function jumpToVisibleRow(pos: number) {
    const target = visiblePopulated[pos];
    if (!target) return;
    setActive((old) => ({ row: target.index, col: old.col }));
    setFocus({ row: target.index, col: active.col });
  }

  const canDeleteActiveOrSelected =
    editable &&
    !disabled &&
    !saving &&
    !readOnlyReason &&
    (selected.size > 0
      ? table.primaryKey.length > 0 ||
        !drafts.some((r) => selected.has(r.id) && r.original)
      : Boolean(
          selectedRow && (table.primaryKey.length > 0 || !selectedRow.original),
        ));

  const canSetNullActiveCell =
    editable &&
    !disabled &&
    !saving &&
    !readOnlyReason &&
    Boolean(selectedRow) &&
    !selectedRow?.deleted &&
    (table.primaryKey.length > 0 || !selectedRow?.original) &&
    !activeColumn?.generated &&
    !activeColumn?.readOnly;

  const targetCopyCount = selected.size
    ? selected.size
    : selectedRow && !selectedRow.deleted
      ? 1
      : visiblePopulated.length;

  return (
    <div
      className={`spreadsheet${stackHeader ? " is-stacked-sheet" : ""}`}
      ref={root}
    >
      {stackHeader && (
        <header className="stack-block-header">
          <button
            type="button"
            className="stack-header-toggle"
            aria-expanded={!stackHeader.collapsed}
            onClick={stackHeader.onToggleCollapse}
          >
            {stackHeader.collapsed ? (
              <ChevronRight size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
            <strong>{qualifiedTableName}</strong>
            <span className="stack-row-badge">
              {matchingPopulated.length} row
              {matchingPopulated.length === 1 ? "" : "s"}
            </span>
          </button>
          <div className="stack-header-spacer" />
          <div className="stack-header-actions">
            <Button
              data-icon-only="true"
              title={`Open ${qualifiedTableName} in single tab view`}
              aria-label={`Focus ${qualifiedTableName}`}
              onClick={stackHeader.onMaximize}
            >
              <Maximize2 size={11} />
            </Button>
            {stackHeader.onClose && (
              <Button
                data-icon-only="true"
                title={`Close ${qualifiedTableName}`}
                aria-label={`Close ${qualifiedTableName}`}
                onClick={stackHeader.onClose}
              >
                <X size={11} />
              </Button>
            )}
          </div>
        </header>
      )}
      {!stackHeader?.collapsed && (
        <>
          {readOnlyReason && (
            <div className="sheet-readonly-notice">{readOnlyReason}</div>
          )}
      {error && (
        <div className="sheet-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss grid error">
            ×
          </button>
        </div>
      )}
      <div
        className="sheet-grid-scroll"
        tabIndex={0}
        aria-label="Table data"
        ref={columnViewport.ref}
        onScroll={(event) => {
          if (viewKey)
            rememberGridPosition(
              viewKey,
              event.currentTarget.scrollTop,
              event.currentTarget.scrollLeft,
            );
        }}
      >
        <table
          className={
            "sheet-grid" +
            (!editable ? " is-locked" : "") +
            (stackHeader ? " is-compact" : "")
          }
          aria-label={`${table.name} data grid`}
          style={{ width: 38 + widths.reduce((sum, width) => sum + width, 0) }}
        >
          <colgroup>
            <col style={{ width: 38 }} />
            {table.columns.map((column, index) => (
              <col key={column.id} style={{ width: widths[index] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="row-gutter" title="Select all rows">
                <label>
                  <input
                    type="checkbox"
                    aria-label="Select visible rows"
                    checked={
                      visible.length > 0 &&
                      visible.every(({ row }) => selected.has(row.id))
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(visible.map(({ row }) => row.id))
                          : new Set(),
                      )
                    }
                  />
                  <span>#</span>
                </label>
              </th>
              {columnViewport.start > 0 && (
                <th
                  className="column-spacer"
                  colSpan={columnViewport.start}
                  aria-hidden="true"
                />
              )}
              {visibleColumns.map(({ column: c, index: i }) => {
                const isSorted = sort?.colId === c.id;
                const colMeta = [
                  c.nativeType ?? c.type.toLowerCase(),
                  table.primaryKey.includes(c.id) ? "primary key" : null,
                  c.generated ? "generated" : null,
                  c.readOnly ? "read only" : null,
                  !c.nullable ? "required" : "nullable",
                  editable && !structureDisabled
                    ? "Double-click to edit column"
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <th
                    key={c.id}
                    className={[
                      active.col === i ? "column-active" : "",
                      isSorted ? "column-sorted" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="column-header-cell">
                      <button
                        className="column-header-trigger"
                        title={`${c.name} · ${colMeta}`}
                        disabled={structureDisabled || saving}
                        data-column-id={c.id}
                        onDoubleClick={(event) => {
                          if (editable)
                            onEditColumn?.(c.id, event.currentTarget);
                        }}
                        onKeyDown={(event) => {
                          if (
                            editable &&
                            (event.key === "Enter" || event.key === " ")
                          ) {
                            event.preventDefault();
                            onEditColumn?.(c.id, event.currentTarget);
                          }
                        }}
                      >
                        <div className="sheet-column-name">
                          {table.primaryKey.includes(c.id) && (
                            <KeyRound size={11} className="gold" />
                          )}
                          <span className="column-name-label">{c.name}</span>
                          <span className="sheet-col-type-inline">
                            {c.nativeType ?? c.type.toLowerCase()}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={`column-sort-btn${isSorted ? " is-active" : ""}`}
                        aria-label={`Sort by ${c.name}`}
                        title={
                          isSorted
                            ? sort.dir === "asc"
                              ? `Sorted ascending by ${c.name} (click for descending)`
                              : `Sorted descending by ${c.name} (click to clear sort)`
                            : `Sort by ${c.name}`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSort(c.id);
                        }}
                      >
                        {isSorted ? (
                          sort.dir === "asc" ? (
                            <ArrowUp size={11} />
                          ) : (
                            <ArrowDown size={11} />
                          )
                        ) : (
                          <ArrowUpDown size={11} />
                        )}
                      </button>
                    </div>
                    <ColumnResizeHandle
                      name={c.name}
                      width={widths[i]}
                      onResize={(width, persist) =>
                        sizing.resize(c.id, width, persist)
                      }
                      onAutoFit={() =>
                        sizing.resize(
                          c.id,
                          fitColumnWidth(
                            c.name,
                            drafts.slice(0, 100).map((row) => valueAt(row, c.name)),
                          ),
                        )
                      }
                    />
                  </th>
                );
              })}
              {columnViewport.end < table.columns.length && (
                <th
                  className="column-spacer"
                  colSpan={table.columns.length - columnViewport.end}
                  aria-hidden="true"
                />
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, index: r }) => (
              <GridRow
                key={row.id}
                row={row}
                rowIndex={r}
                selected={selected.has(row.id)}
                activeCol={active.row === r ? active.col : -1}
                visibleColumns={visibleColumns}
                start={columnViewport.start}
                end={columnViewport.end}
                columnCount={table.columns.length}
                hasPrimaryKey={!!table.primaryKey.length}
                pageIndex={serverPage?.index ?? 0}
                disabled={disabled || saving}
                locked={!editable}
                cellHints={cellHints}
                handlers={cellHandlers}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Unified Navicat-style Bottom Action & Navigation Bar (hidden in compact stack mode) */}
      {!stackHeader && (
      <div className="result-navicat-bar sheet-bottom-bar">
        <div className="row result-nav-group">
          <Button
            data-icon-only="true"
            title="First row"
            aria-label="First row"
            disabled={!canMovePrev}
            onClick={() => jumpToVisibleRow(0)}
          >
            <ChevronFirst size={13} />
          </Button>
          <Button
            data-icon-only="true"
            title="Previous row"
            aria-label="Previous row"
            disabled={!canMovePrev}
            onClick={() => jumpToVisibleRow(activeVisiblePosition - 1)}
          >
            <ChevronLeft size={13} />
          </Button>
          <span className="result-record-indicator">
            {visiblePopulated.length > 0 && activeVisiblePosition >= 0
              ? `${activeVisiblePosition + 1} / ${visiblePopulated.length}`
              : `0 / ${visiblePopulated.length}`}
          </span>
          <Button
            data-icon-only="true"
            title="Next row"
            aria-label="Next row"
            disabled={!canMoveNext}
            onClick={() => jumpToVisibleRow(activeVisiblePosition + 1)}
          >
            <ChevronRight size={13} />
          </Button>
          <Button
            data-icon-only="true"
            title="Last row"
            aria-label="Last row"
            disabled={!canMoveNext}
            onClick={() => jumpToVisibleRow(visiblePopulated.length - 1)}
          >
            <ChevronLast size={13} />
          </Button>
        </div>

        <div className="divider" />

        {editable ? (
          <div className="row result-edit-group">
            <Button
              data-icon-only="true"
              className="result-lock-toggle is-unlocked"
              title={
                dirty
                  ? "Apply or discard changes before locking"
                  : "Lock editing"
              }
              aria-label="Lock editing"
              disabled={dirty || saving}
              onClick={() => setIsUnlocked(false)}
            >
              <LockOpen size={12} />
            </Button>
            <Button
              data-icon-only="true"
              title="Add row"
              aria-label="Add row"
              disabled={disabled || saving}
              onClick={addRow}
            >
              <Plus size={13} />
            </Button>
            <Button
              data-icon-only="true"
              title="Duplicate row (Cmd/Ctrl+D)"
              aria-label="Duplicate row"
              disabled={disabled || saving || (!selected.size && !selectedRow)}
              onClick={() => duplicateRows()}
            >
              <CopyPlus size={13} />
            </Button>
            <Button
              data-icon-only="true"
              title="Delete selected/active row"
              aria-label="Delete row"
              disabled={!canDeleteActiveOrSelected}
              onClick={() => deleteSelected()}
            >
              <Trash2 size={13} />
            </Button>
            <Button
              title="Set active cell to NULL (Option+Backspace)"
              disabled={!canSetNullActiveCell}
              onClick={() => update(active.row, active.col, null)}
            >
              NULL
            </Button>
            {onAddColumn && (
              <Button
                data-add-column
                title="Add column"
                aria-label="Add column"
                disabled={saving || structureDisabled}
                onClick={(event) => onAddColumn(event.currentTarget)}
              >
                <Columns3 size={12} />
                Column
              </Button>
            )}
            <Button
              className={dirty ? "primary" : ""}
              title="Apply changes (Cmd/Ctrl+S)"
              aria-label="Apply changes"
              disabled={disabled || saving || !dirty || requiresRefresh}
              onClick={() => void save()}
            >
              <Check size={13} />
              Apply
              {dirty && <span className="button-count">{changes.length}</span>}
            </Button>
            <Button
              data-icon-only="true"
              title="Discard changes"
              aria-label="Discard changes"
              disabled={!dirty || saving}
              onClick={() => void discardChanges()}
            >
              <RotateCcw size={13} />
            </Button>
          </div>
        ) : canUnlock ? (
          <Button
            data-icon-only="true"
            className="result-lock-toggle is-locked"
            title={`Click to unlock editing (${qualifiedTableName})`}
            aria-label="Unlock editing"
            disabled={disabled || saving}
            onClick={() => setIsUnlocked(true)}
          >
            <Lock size={12} />
          </Button>
        ) : (
          <span
            className="result-readonly-pill"
            title={readOnlyReason}
            aria-label="Read-only table"
          >
            <Lock size={12} />
          </span>
        )}

        <div className="divider" />

        <div className="row result-copy-group">
          <Button
            title={`Copy ${selected.size ? `${selected.size} selected` : "active"} row(s) as SQL INSERT`}
            disabled={!visiblePopulated.length}
            onClick={() => void handleCopyAsInsert()}
          >
            <FileCode2 size={13} />
            Copy as INSERT
          </Button>
          <Button
            title={`Copy ${selected.size ? `${selected.size} selected` : "active"} row(s) as SQL UPDATE`}
            disabled={!visiblePopulated.length}
            onClick={() => void handleCopyAsUpdate()}
          >
            <FileCode2 size={13} />
            Copy as UPDATE
          </Button>
          <div className="result-copy-dropdown" ref={copyMenuRef}>
            <Button
              data-icon-only="true"
              title="More copy formats"
              aria-label="More copy formats"
              disabled={!visiblePopulated.length}
              onClick={() => {
                setCopyMenuOpen((v) => !v);
                setExportMenuOpen(false);
              }}
            >
              <Copy size={12} />
            </Button>
            {copyMenuOpen && (
              <div className="result-floating-menu" role="menu">
                <div className="result-menu-label">
                  {selected.size
                    ? `${selected.size} selected row(s)`
                    : `${targetCopyCount} row(s) · ${qualifiedTableName}`}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsInsert()}
                >
                  <span>Copy as INSERT</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsUpdate()}
                >
                  <span>Copy as UPDATE</span>
                </button>
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyCellValue()}
                >
                  <span>Copy Cell Value</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsCsv()}
                >
                  <span>Copy as CSV</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsTsv()}
                >
                  <span>Copy as TSV (Tab-separated)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsJson()}
                >
                  <span>Copy as JSON</span>
                </button>
              </div>
            )}
          </div>

          <div className="result-copy-dropdown" ref={exportMenuRef}>
            <Button
              data-icon-only="true"
              title="Export rows to file (.sql, .csv, .json)"
              aria-label="Export data"
              disabled={!matchingPopulated.length}
              onClick={() => {
                setExportMenuOpen((v) => !v);
                setCopyMenuOpen(false);
              }}
            >
              <Download size={12} />
            </Button>
            {exportMenuOpen && (
              <div className="result-floating-menu" role="menu">
                <div className="result-menu-label">
                  Export{" "}
                  {selected.size
                    ? `${selected.size} selected row(s)`
                    : `${matchingPopulated.length} row(s)`}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExport("sql")}
                >
                  <span>Export as SQL (.sql)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExport("csv")}
                >
                  <span>Export as CSV (.csv)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExport("json")}
                >
                  <span>Export as JSON (.json)</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="result-bar-spacer" />

        <div className="row sheet-status-right">
          {dirty ? (
            <span className="result-status-summary">
              <span className="status-dot amber" />
              {[
                added ? `${added} new` : null,
                changed ? `${changed} edited` : null,
                removed ? `${removed} deleted` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : notice ? (
            <span className="result-status-summary is-notice">
              <Check size={12} />
              {notice}
            </span>
          ) : null}

          <div className="sheet-search result-row-filter">
            <Search size={12} />
            {filterCol !== "*" && (
              <span className="filter-col-pill" title={`Filtering column ${filterCol}`}>
                {filterCol}:
              </span>
            )}
            <input
              aria-label={serverPage ? "Filter loaded rows" : "Filter rows"}
              placeholder={serverPage ? "Filter page…" : "Filter rows…"}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            />
            {(hasActiveFilter || filterCol !== "*") && (
              <button
                type="button"
                className="filter-clear"
                aria-label="Clear filter"
                title="Clear filter"
                onClick={() => {
                  setFilter("");
                  setFilterCol("*");
                  setPage(0);
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>

          {serverPage ? (
            <span className="row sheet-pagination-group">
              <Button
                data-icon-only="true"
                aria-label="Previous page"
                title="Previous page"
                disabled={saving || !serverPage.index}
                onClick={() => serverPage.onChange(serverPage.index - 1)}
              >
                <ChevronLeft size={12} />
              </Button>
              <span aria-live="polite">Page {serverPage.index + 1}</span>
              <Button
                data-icon-only="true"
                aria-label="Next page"
                title="Next page"
                disabled={saving || !serverPage.hasNext}
                onClick={() => serverPage.onChange(serverPage.index + 1)}
              >
                <ChevronRight size={12} />
              </Button>
            </span>
          ) : pageCount > 1 ? (
            <span className="row sheet-pagination-group">
              <Button
                data-icon-only="true"
                aria-label="Previous page"
                title="Previous page"
                disabled={disabled || saving || currentPage === 0}
                onClick={() => changePage(currentPage - 1)}
              >
                <ChevronLeft size={12} />
              </Button>
              <span aria-live="polite">
                {currentPage + 1}/{pageCount}
              </span>
              <Button
                data-icon-only="true"
                aria-label="Next page"
                title="Next page"
                disabled={disabled || saving || currentPage + 1 >= pageCount}
                onClick={() => changePage(currentPage + 1)}
              >
                <ChevronRight size={12} />
              </Button>
            </span>
          ) : null}
        </div>
      </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="result-floating-menu result-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <div className="result-menu-label">
            {selected.size > 1
              ? `${selected.size} rows selected`
              : `Row ${contextMenu.rowIndex + 1}`}
            {` · ${qualifiedTableName}`}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopyAsInsert(contextMenu.rowIndex)}
          >
            <span>Copy as INSERT</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopyAsUpdate(contextMenu.rowIndex)}
          >
            <span>Copy as UPDATE</span>
          </button>
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void handleCopyCellValue(
                contextMenu.rowIndex,
                contextMenu.colIndex,
              )
            }
          >
            <span>Copy Cell Value</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopyAsCsv(contextMenu.rowIndex)}
          >
            <span>Copy Row(s) as CSV</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopyAsTsv(contextMenu.rowIndex)}
          >
            <span>Copy Row(s) as TSV</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopyAsJson(contextMenu.rowIndex)}
          >
            <span>Copy Row(s) as JSON</span>
          </button>
          {table.columns[contextMenu.colIndex] && (
            <>
              <hr />
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  handleFilterByCell(contextMenu.rowIndex, contextMenu.colIndex)
                }
              >
                <span>
                  Filter by Cell Value (
                  {table.columns[contextMenu.colIndex].name})
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSort({
                    colId: table.columns[contextMenu.colIndex].id,
                    dir: "asc",
                  });
                  setContextMenu(null);
                }}
              >
                <span>
                  Sort Ascending ({table.columns[contextMenu.colIndex].name})
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSort({
                    colId: table.columns[contextMenu.colIndex].id,
                    dir: "desc",
                  });
                  setContextMenu(null);
                }}
              >
                <span>
                  Sort Descending ({table.columns[contextMenu.colIndex].name})
                </span>
              </button>
              {sort && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSort(null);
                    setContextMenu(null);
                  }}
                >
                  <span>Clear Sort</span>
                </button>
              )}
            </>
          )}
          {editable && !disabled ? (
            <>
              <hr />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  duplicateRows(
                    selected.size > 0 ? undefined : [contextMenu.rowIndex],
                  );
                  setContextMenu(null);
                }}
              >
                <span>Duplicate Row(s)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  update(contextMenu.rowIndex, contextMenu.colIndex, null);
                  setContextMenu(null);
                }}
              >
                <span>Set NULL</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  addRow();
                  setContextMenu(null);
                }}
              >
                <span>Add Row</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger-item"
                onClick={() => {
                  const row = drafts[contextMenu.rowIndex];
                  deleteSelected(
                    selected.size > 0
                      ? selected
                      : row
                        ? new Set([row.id])
                        : undefined,
                  );
                  setContextMenu(null);
                }}
              >
                <span>Delete Row(s)</span>
              </button>
            </>
          ) : canUnlock && !disabled ? (
            <>
              <hr />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsUnlocked(true);
                  setContextMenu(null);
                }}
              >
                <span>Unlock Editing</span>
              </button>
            </>
          ) : null}
        </div>
      )}
        </>
      )}
    </div>
  );
}

interface CellHandlers {
  select: (
    id: string,
    rowIndex: number,
    checked: boolean,
    shiftKey?: boolean,
  ) => void;
  update: (row: number, col: number, value: string) => void;
  handleKey: (
    event: KeyboardEvent<HTMLInputElement>,
    row: number,
    col: number,
  ) => void;
  paste: (
    event: ClipboardEvent<HTMLInputElement>,
    row: number,
    col: number,
  ) => void;
  focus: (row: number, col: number) => void;
  contextMenu: (
    event: ReactMouseEvent,
    rowIndex: number,
    colIndex: number,
  ) => void;
}

const GridCell = memo(function GridCell({
  column,
  rowIndex,
  columnIndex,
  value,
  hint,
  isActive,
  changed,
  placeholder,
  disabled,
  readOnly,
  handlers,
}: {
  column: ColumnDefinition;
  rowIndex: number;
  columnIndex: number;
  value: CellValue;
  hint: string;
  isActive: boolean;
  changed: boolean;
  placeholder: string;
  disabled: boolean;
  readOnly: boolean;
  handlers: RefObject<CellHandlers>;
}) {
  return (
    <td
      className={[
        isActive ? "cell-active" : "",
        changed ? "cell-changed" : "",
        value === null ? "cell-null" : "",
      ].join(" ")}
      onContextMenu={(event) =>
        handlers.current.contextMenu(event, rowIndex, columnIndex)
      }
    >
      <input
        aria-label={`${column.name}, row ${rowIndex + 1}`}
        title={`${value === null ? "NULL" : (value ?? "")}\n${hint}`}
        data-row={rowIndex}
        data-col={columnIndex}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => handlers.current.focus(rowIndex, columnIndex)}
        onChange={(event) =>
          handlers.current.update(rowIndex, columnIndex, event.target.value)
        }
        onKeyDown={(event) =>
          handlers.current.handleKey(event, rowIndex, columnIndex)
        }
        onPaste={(event) =>
          handlers.current.paste(event, rowIndex, columnIndex)
        }
      />
    </td>
  );
});

const GridRow = memo(function GridRow({
  row,
  rowIndex: r,
  selected,
  activeCol,
  visibleColumns,
  start,
  end,
  columnCount,
  hasPrimaryKey,
  pageIndex,
  disabled,
  locked,
  cellHints,
  handlers,
}: {
  row: DraftRow;
  rowIndex: number;
  selected: boolean;
  activeCol: number;
  visibleColumns: { column: ColumnDefinition; index: number }[];
  start: number;
  end: number;
  columnCount: number;
  hasPrimaryKey: boolean;
  pageIndex: number;
  disabled: boolean;
  locked: boolean;
  cellHints: string[];
  handlers: RefObject<CellHandlers>;
}) {
  return (
    <tr
      className={[
        row.deleted ? "row-deleted" : "",
        !row.original ? "row-new" : "",
        selected ? "row-selected" : "",
      ].join(" ")}
    >
      <th
        className="row-gutter"
        onContextMenu={(event) => handlers.current.contextMenu(event, r, 0)}
      >
        <label
          onClick={(e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
              e.preventDefault();
              handlers.current.select(row.id, r, !selected, e.shiftKey);
            }
          }}
        >
          <input
            type="checkbox"
            aria-label={`Select row ${r + 1}`}
            checked={selected}
            onChange={(e) =>
              handlers.current.select(
                row.id,
                r,
                e.target.checked,
                (e.nativeEvent as MouseEvent).shiftKey,
              )
            }
          />
          <span>{r + 1 + (row.original ? pageIndex * PAGE_SIZE : 0)}</span>
        </label>
      </th>
      {start > 0 && (
        <td className="column-spacer" colSpan={start} aria-hidden="true" />
      )}
      {visibleColumns.map(({ column, index: c }) => {
        const value = valueAt(row, column.name);
        return (
          <GridCell
            key={column.id}
            column={column}
            rowIndex={r}
            columnIndex={c}
            value={value}
            hint={cellHints[c]}
            isActive={activeCol === c}
            changed={Object.hasOwn(row.cells, column.name)}
            placeholder={
              value === null
                ? "NULL"
                : !row.original
                  ? column.generated
                    ? "Generated"
                    : column.defaultValue
                      ? "Default"
                      : column.nullable
                        ? "NULL"
                        : ""
                  : ""
            }
            disabled={!!(disabled || row.deleted)}
            readOnly={
              locked ||
              !!column.generated ||
              !!column.readOnly ||
              (!!row.original && !hasPrimaryKey)
            }
            handlers={handlers}
          />
        );
      })}
      {end < columnCount && (
        <td
          className="column-spacer"
          colSpan={columnCount - end}
          aria-hidden="true"
        />
      )}
    </tr>
  );
});
