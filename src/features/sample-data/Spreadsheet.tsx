import { RowFilter } from "./RowFilter";
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
import { columnTypeHint, STACK_DEFAULT_ROWS } from "../sql/ResultSetView";
import { createPortal } from "react-dom";
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
const SHEET_ROW_HEIGHT = 29;
const SHEET_ROW_OVERSCAN = 45;
const SHEET_ROW_CHUNK = 30;
const SHEET_VIRTUALIZE_THRESHOLD_LOCKED = 400;
const SHEET_VIRTUALIZE_THRESHOLD_EDITABLE = 120;

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
    rowLimit?: number;
    onRowLimitChange?: (limit: number | undefined) => void;
  };
}

export const Spreadsheet = memo(function Spreadsheet({
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
  const rangeAnchorRef = useRef<{ rowPos: number; col: number } | null>(null);
  const isDraggingRangeRef = useRef(false);
  const [cellRange, setCellRange] = useState<{
    startRowPos: number;
    endRowPos: number;
    startCol: number;
    endCol: number;
  } | null>(null);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stopDrag = () => {
      isDraggingRangeRef.current = false;
    };
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  useEffect(() => {
    if (viewKey) rememberGridView(viewKey, page, filter);
  }, [viewKey, page, filter]);

  useEffect(() => {
    setSort(null);
    setFilterCol("*");
    setIsUnlocked(false);
    setCellRange(null);
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
    const handleAnyScroll = (event: Event) => {
      if (
        contextMenu &&
        contextMenuRef.current &&
        event.target instanceof Node &&
        contextMenuRef.current.contains(event.target)
      ) {
        return;
      }
      setContextMenu(null);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleAnyScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleAnyScroll, true);
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
  const changes = useMemo(() => drafts.filter(isChanged), [drafts]);
  const dirty = changes.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const added = useMemo(
    () => changes.filter((r) => !r.original && !r.deleted).length,
    [changes],
  );
  const changed = useMemo(
    () => changes.filter((r) => r.original && !r.deleted).length,
    [changes],
  );
  const removed = useMemo(
    () => changes.filter((r) => r.original && r.deleted).length,
    [changes],
  );

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
  const effectiveStackLimit = stackHeader?.rowLimit ?? STACK_DEFAULT_ROWS;
  const selectableRowCount = stackHeader
    ? Math.min(visible.length, Math.max(1, effectiveStackLimit))
    : visible.length;
  const normalizedRange = useMemo(() => {
    if (
      selected.size > 0 ||
      !cellRange ||
      !selectableRowCount ||
      !table.columns.length
    ) {
      return null;
    }
    const maxRowIdx = selectableRowCount - 1;
    const maxColIdx = table.columns.length - 1;
    const minRowPos = Math.max(
      0,
      Math.min(maxRowIdx, Math.min(cellRange.startRowPos, cellRange.endRowPos)),
    );
    const maxRowPos = Math.max(
      0,
      Math.min(maxRowIdx, Math.max(cellRange.startRowPos, cellRange.endRowPos)),
    );
    const minCol = Math.max(
      0,
      Math.min(maxColIdx, Math.min(cellRange.startCol, cellRange.endCol)),
    );
    const maxCol = Math.max(
      0,
      Math.min(maxColIdx, Math.max(cellRange.startCol, cellRange.endCol)),
    );
    const rowCount = maxRowPos - minRowPos + 1;
    const colCount = maxCol - minCol + 1;
    return {
      minRowPos,
      maxRowPos,
      minCol,
      maxCol,
      rowCount,
      colCount,
      cellCount: rowCount * colCount,
    };
  }, [selected.size, cellRange, selectableRowCount, table.columns.length]);
  const hasActiveRange = Boolean(
    normalizedRange && normalizedRange.cellCount > 1,
  );
  const sheetVirtualizeThreshold = editable
    ? SHEET_VIRTUALIZE_THRESHOLD_EDITABLE
    : SHEET_VIRTUALIZE_THRESHOLD_LOCKED;
  const shouldVirtualizeRows =
    !stackHeader && visible.length > sheetVirtualizeThreshold;

  const [rowRange, setRowRange] = useState(() => {
    const initialTop = viewKey ? gridPosition(viewKey).top : 0;
    const rawStart = Math.max(
      0,
      Math.floor(initialTop / SHEET_ROW_HEIGHT) - SHEET_ROW_OVERSCAN,
    );
    const start = Math.floor(rawStart / SHEET_ROW_CHUNK) * SHEET_ROW_CHUNK;
    const end = start + SHEET_ROW_OVERSCAN * 2 + SHEET_ROW_CHUNK * 2;
    return { start, end };
  });

  useLayoutEffect(() => {
    if (!shouldVirtualizeRows) return;
    const element = columnViewport.ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = element.scrollTop;
      const height = Math.max(element.clientHeight || 420, 240);
      const rawStart = Math.max(
        0,
        Math.floor(top / SHEET_ROW_HEIGHT) - SHEET_ROW_OVERSCAN,
      );
      const start = Math.floor(rawStart / SHEET_ROW_CHUNK) * SHEET_ROW_CHUNK;
      const rawEnd =
        Math.ceil((top + height) / SHEET_ROW_HEIGHT) + SHEET_ROW_OVERSCAN;
      const end = Math.ceil(rawEnd / SHEET_ROW_CHUNK) * SHEET_ROW_CHUNK;
      setRowRange((old) =>
        old.start === start && old.end === end ? old : { start, end },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", schedule);
    };
  }, [shouldVirtualizeRows]);

  const rowStart = shouldVirtualizeRows
    ? Math.min(rowRange.start, Math.max(0, visible.length - 1))
    : 0;
  const rowEnd = shouldVirtualizeRows
    ? Math.min(visible.length, Math.max(rowStart + 1, rowRange.end))
    : visible.length;
  const renderedRows = useMemo(
    () =>
      stackHeader
        ? visible.slice(0, Math.max(1, effectiveStackLimit))
        : shouldVirtualizeRows
          ? visible.slice(rowStart, rowEnd)
          : visible,
    [
      stackHeader,
      visible,
      effectiveStackLimit,
      shouldVirtualizeRows,
      rowStart,
      rowEnd,
    ],
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
    if (selected.size > 0) {
      return matchingPopulated
        .map(({ row }) => row)
        .filter((row) => selected.has(row.id));
    }
    if (explicitRowIndex !== undefined && drafts[explicitRowIndex]) {
      const target = drafts[explicitRowIndex];
      return !target.deleted ? [target] : [];
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

  function resolveCopyScope(
    explicitRowIndex?: number,
    allRows = false,
  ): {
    draftRows: DraftRow[];
    cols: ColumnDefinition[];
    colNames: string[];
    isRange: boolean;
  } {
    if (allRows) {
      return {
        draftRows: visiblePopulated.map(({ row }) => row),
        cols: table.columns,
        colNames: allColumnNames,
        isRange: false,
      };
    }
    if (hasActiveRange && normalizedRange) {
      const rangeRows = visible
        .slice(normalizedRange.minRowPos, normalizedRange.maxRowPos + 1)
        .map(({ row }) => row)
        .filter((r) => !r.deleted && isPopulatedRow(r));
      const rangeCols = table.columns.slice(
        normalizedRange.minCol,
        normalizedRange.maxCol + 1,
      );
      return {
        draftRows: rangeRows,
        cols: rangeCols,
        colNames: rangeCols.map((c) => c.name),
        isRange: true,
      };
    }
    if (selected.size > 0) {
      return {
        draftRows: getTargetDraftRows(explicitRowIndex),
        cols: table.columns,
        colNames: allColumnNames,
        isRange: false,
      };
    }
    const targetRowIdx =
      explicitRowIndex !== undefined
        ? explicitRowIndex
        : contextMenu
          ? contextMenu.rowIndex
          : active.row;
    const targetColIdx = Math.max(
      0,
      Math.min(
        table.columns.length - 1,
        contextMenu ? contextMenu.colIndex : active.col,
      ),
    );
    const targetCol = table.columns[targetColIdx];
    const targetRows = getTargetDraftRows(targetRowIdx);
    if (targetCol && targetRows.length === 1) {
      return {
        draftRows: targetRows,
        cols: [targetCol],
        colNames: [targetCol.name],
        isRange: true,
      };
    }
    return {
      draftRows: targetRows,
      cols: table.columns,
      colNames: allColumnNames,
      isRange: false,
    };
  }

  function setNullTargetCells(
    fallbackRow = active.row,
    fallbackCol = active.col,
  ) {
    if (!editable || disabled || saving || readOnlyReason) return;
    if (hasActiveRange && normalizedRange) {
      const targetRowIndices = new Set(
        visible
          .slice(normalizedRange.minRowPos, normalizedRange.maxRowPos + 1)
          .map(({ index }) => index),
      );
      const targetCols = table.columns
        .slice(normalizedRange.minCol, normalizedRange.maxCol + 1)
        .filter((col) => !col.generated && !col.readOnly && col.nullable);
      if (!targetRowIndices.size || !targetCols.length) return;
      setError("");
      setNotice("");
      setDrafts((current) =>
        current.map((r, idx) => {
          if (!targetRowIndices.has(idx) || r.deleted) return r;
          if (r.original && !table.primaryKey.length) return r;
          const nextCells = { ...r.cells };
          for (const col of targetCols) {
            nextCells[col.name] = null;
          }
          return { ...r, cells: nextCells };
        }),
      );
      return;
    }
    update(fallbackRow, fallbackCol, null);
  }

  async function handleCopyAsInsert(explicitRowIndex?: number) {
    const { draftRows: targetDrafts, cols, colNames, isRange } =
      resolveCopyScope(explicitRowIndex, false);
    if (!targetDrafts.length || !colNames.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, cols));
    const sqlText = buildCopyAsInsert({
      table,
      columns: colNames,
      rows: records,
      dialect,
    });
    await copyTextToClipboard(sqlText);
    setNotice(
      isRange
        ? `Copied ${records.length}×${colNames.length} as INSERT`
        : `Copied ${records.length} row${records.length === 1 ? "" : "s"} as INSERT`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsUpdate(explicitRowIndex?: number) {
    const { draftRows: targetDrafts, colNames, isRange } = resolveCopyScope(
      explicitRowIndex,
      false,
    );
    if (!targetDrafts.length || !colNames.length) return;
    const updateRows = targetDrafts.map((r) => ({
      current: draftToRecord(r, table.columns),
      original: r.original,
    }));
    const sqlText = buildCopyAsUpdate({
      table,
      columns: allColumnNames,
      setColumns: isRange ? colNames : undefined,
      rows: updateRows,
      dialect,
    });
    await copyTextToClipboard(sqlText);
    setNotice(
      isRange
        ? `Copied ${updateRows.length}×${colNames.length} as UPDATE`
        : `Copied ${updateRows.length} row${updateRows.length === 1 ? "" : "s"} as UPDATE`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsCsv(explicitRowIndex?: number) {
    const { draftRows: targetDrafts, cols, colNames, isRange } =
      resolveCopyScope(explicitRowIndex, false);
    if (!targetDrafts.length || !colNames.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, cols));
    const csvText = buildCopyAsCsv(colNames, records);
    await copyTextToClipboard(csvText);
    setNotice(
      isRange
        ? `Copied ${records.length}×${colNames.length} as CSV`
        : `Copied ${records.length} row${records.length === 1 ? "" : "s"} as CSV`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsTsv(
    explicitRowIndex?: number,
    includeHeader = false,
  ) {
    const { draftRows: targetDrafts, cols, colNames, isRange } =
      resolveCopyScope(explicitRowIndex, false);
    if (!targetDrafts.length || !colNames.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, cols));
    const tsvText = buildCopyAsTsv(colNames, records, includeHeader);
    await copyTextToClipboard(tsvText);
    setNotice(
      isRange
        ? `Copied ${records.length}×${colNames.length}${includeHeader ? " with header" : " as TSV"}`
        : `Copied ${records.length} row${records.length === 1 ? "" : "s"}${includeHeader ? " with header" : " as TSV"}`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyWithHeader(
    explicitRowIndex?: number,
    allRows = false,
  ) {
    const { draftRows: targetDrafts, cols, colNames, isRange } =
      resolveCopyScope(explicitRowIndex, allRows);
    if (!targetDrafts.length || !colNames.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, cols));
    const tsvText = buildCopyAsTsv(colNames, records, true);
    await copyTextToClipboard(tsvText);
    setNotice(
      isRange
        ? `Copied ${records.length}×${colNames.length} with header`
        : `Copied ${records.length} row${records.length === 1 ? "" : "s"} with header`,
    );
    setCopyMenuOpen(false);
    setContextMenu(null);
  }

  async function handleCopyAsJson(explicitRowIndex?: number) {
    const { draftRows: targetDrafts, cols, colNames, isRange } =
      resolveCopyScope(explicitRowIndex, false);
    if (!targetDrafts.length || !colNames.length) return;
    const records = targetDrafts.map((r) => draftToRecord(r, cols));
    const jsonText = JSON.stringify(records, null, 2);
    await copyTextToClipboard(jsonText);
    setNotice(
      isRange
        ? `Copied ${records.length}×${colNames.length} as JSON`
        : `Copied ${records.length} row${records.length === 1 ? "" : "s"} as JSON`,
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
    additive = true,
  ) {
    setCellRange(null);
    const anchorIndex = lastSelectedIndexRef.current ?? active.row;
    setSelected((current) => {
      const next = new Set(additive ? current : []);
      if (shiftKey && anchorIndex !== null && anchorIndex !== undefined) {
        const visibleIndices = visible.map((item) => item.index);
        const posA = visibleIndices.indexOf(anchorIndex);
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
          return next;
        }
      }
      if (checked) next.add(rowId);
      else next.delete(rowId);
      lastSelectedIndexRef.current = rowIndex;
      return next;
    });
  }

  function handleCellMouseDown(
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) {
    if (event.button !== 0) return;
    const row = drafts[rowIndex];
    if ((event.metaKey || event.ctrlKey) && row && isPopulatedRow(row)) {
      event.preventDefault();
      setCellRange(null);
      handleRowSelect(row.id, rowIndex, !selected.has(row.id), false, true);
      setActive((old) =>
        old.row === rowIndex && old.col === colIndex
          ? old
          : { row: rowIndex, col: colIndex },
      );
      return;
    }
    if (selected.size > 0) {
      event.preventDefault();
      isDraggingRangeRef.current = false;
      setCellRange(null);
      return;
    }
    if (event.shiftKey && row) {
      event.preventDefault();
      const fallbackPos = visible.findIndex(
        ({ index }) => index === active.row,
      );
      const anchor = rangeAnchorRef.current ?? {
        rowPos: fallbackPos >= 0 ? fallbackPos : visiblePos,
        col: active.col,
      };
      rangeAnchorRef.current = anchor;
      isDraggingRangeRef.current = true;
      setCellRange({
        startRowPos: anchor.rowPos,
        endRowPos: visiblePos,
        startCol: anchor.col,
        endCol: colIndex,
      });
      setActive((old) =>
        old.row === rowIndex && old.col === colIndex
          ? old
          : { row: rowIndex, col: colIndex },
      );
      return;
    }
    rangeAnchorRef.current = { rowPos: visiblePos, col: colIndex };
    lastSelectedIndexRef.current = rowIndex;
    isDraggingRangeRef.current = true;
    setCellRange(null);
    setActive((old) =>
      old.row === rowIndex && old.col === colIndex
        ? old
        : { row: rowIndex, col: colIndex },
    );
  }

  function handleCellMouseEnter(
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) {
    if (
      selected.size > 0 ||
      !isDraggingRangeRef.current ||
      (event.buttons & 1) !== 1
    ) {
      return;
    }
    const anchor = rangeAnchorRef.current;
    if (!anchor) return;
    if (anchor.rowPos === visiblePos && anchor.col === colIndex) {
      setCellRange(null);
      return;
    }
    window.getSelection()?.removeAllRanges();
    if (
      document.activeElement instanceof HTMLInputElement &&
      root.current?.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    setCellRange((prev) =>
      prev &&
      prev.startRowPos === anchor.rowPos &&
      prev.endRowPos === visiblePos &&
      prev.startCol === anchor.col &&
      prev.endCol === colIndex
        ? prev
        : {
            startRowPos: anchor.rowPos,
            endRowPos: visiblePos,
            startCol: anchor.col,
            endCol: colIndex,
          },
    );
    setActive((old) =>
      old.row === rowIndex && old.col === colIndex
        ? old
        : { row: rowIndex, col: colIndex },
    );
  }

  function openContextMenu(
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) {
    event.preventDefault();
    const isGutter = colIndex < 0;
    const safeCol = isGutter ? Math.max(0, active.col) : Math.max(0, colIndex);
    const row = drafts[rowIndex];
    const insideRange =
      !isGutter &&
      hasActiveRange &&
      normalizedRange !== null &&
      visiblePos >= normalizedRange.minRowPos &&
      visiblePos <= normalizedRange.maxRowPos &&
      safeCol >= normalizedRange.minCol &&
      safeCol <= normalizedRange.maxCol;

    if (selected.size > 0) {
      setCellRange(null);
    } else if (isGutter) {
      setCellRange(null);
      rangeAnchorRef.current = { rowPos: visiblePos, col: safeCol };
      setActive({ row: rowIndex, col: safeCol });
      if (row) {
        setSelected(new Set([row.id]));
        lastSelectedIndexRef.current = rowIndex;
      }
    } else if (!insideRange) {
      setCellRange(null);
      rangeAnchorRef.current = { rowPos: visiblePos, col: safeCol };
      setActive({ row: rowIndex, col: safeCol });
      lastSelectedIndexRef.current = rowIndex;
    }
    const menuWidth = 235;
    const menuHeight = 360;
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
    cellMouseDown: () => {},
    cellMouseEnter: () => {},
    select: () => {},
    contextMenu: () => {},
  });
  cellHandlers.current = {
    select: handleRowSelect,
    update,
    handleKey,
    paste,
    focus: (row, col) => {
      if (selected.size > 0) return;
      lastSelectedIndexRef.current = row;
      setActive((old) =>
        old.row === row && old.col === col ? old : { row, col },
      );
    },
    cellMouseDown: handleCellMouseDown,
    cellMouseEnter: handleCellMouseEnter,
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

  const targetCopyCount =
    hasActiveRange && normalizedRange
      ? normalizedRange.rowCount
      : selected.size
        ? selected.size
        : selectedRow && !selectedRow.deleted
          ? 1
          : visiblePopulated.length;
  const scopeBadge =
    hasActiveRange && normalizedRange
      ? `${normalizedRange.rowCount}×${normalizedRange.colCount}`
      : selected.size > 1
        ? `${selected.size}`
        : "";
  const scopeDescription =
    hasActiveRange && normalizedRange
      ? `${normalizedRange.rowCount} row${normalizedRange.rowCount === 1 ? "" : "s"} × ${normalizedRange.colCount} col${normalizedRange.colCount === 1 ? "" : "s"} · ${qualifiedTableName}`
      : selected.size > 0
        ? `${selected.size} row${selected.size === 1 ? "" : "s"} selected · ${qualifiedTableName}`
        : contextMenu
          ? `Row ${contextMenu.rowIndex + 1} · ${table.columns[contextMenu.colIndex]?.name ?? qualifiedTableName}`
          : `${targetCopyCount} row(s) · ${qualifiedTableName}`;

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
              {!stackHeader.collapsed &&
              renderedRows.length < matchingPopulated.length
                ? `${renderedRows.length} / ${matchingPopulated.length} rows`
                : `${matchingPopulated.length} row${matchingPopulated.length === 1 ? "" : "s"}`}
            </span>
          </button>
          <div className="stack-header-spacer" />
          {(selected.size > 0 || hasActiveRange) && (
            <span className="stack-selection-pill">
              <span>
                {hasActiveRange && normalizedRange
                  ? `${normalizedRange.rowCount}×${normalizedRange.colCount} selected`
                  : `${selected.size} row${selected.size === 1 ? "" : "s"} selected`}
              </span>
              <button
                type="button"
                aria-label="Clear selection"
                title="Clear selection"
                onClick={() => {
                  setSelected(new Set());
                  setCellRange(null);
                }}
              >
                <X size={10} />
              </button>
            </span>
          )}
          {notice && (
            <span className="result-status-summary is-notice" role="status">
              <Check size={11} />
              {notice}
            </span>
          )}
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
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "c"
          ) {
            if (
              document.activeElement instanceof HTMLInputElement &&
              document.activeElement.selectionStart !==
                document.activeElement.selectionEnd
            ) {
              return;
            }
            if (hasActiveRange || selected.size > 0 || !editable) {
              event.preventDefault();
              if (event.shiftKey) {
                void handleCopyWithHeader(undefined, false);
              } else if (hasActiveRange || selected.size > 0) {
                void handleCopyAsTsv(undefined, false);
              } else {
                void handleCopyCellValue(active.row, active.col);
              }
            }
          } else if (event.key === "Escape" && cellRange) {
            setCellRange(null);
          }
        }}
        onScroll={(event) => {
          if (contextMenu) setContextMenu(null);
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
            (stackHeader ? " is-compact" : "") +
            (selected.size > 0 ? " has-row-selection" : "") +
            (hasActiveRange ? " has-range-selection" : "")
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
                      selected.size > 0 &&
                      (stackHeader ? renderedRows : visible).length > 0 &&
                      (stackHeader ? renderedRows : visible).every(({ row }) =>
                        selected.has(row.id),
                      )
                    }
                    onChange={(e) => {
                      setCellRange(null);
                      const targetList = stackHeader ? renderedRows : visible;
                      setSelected(
                        e.target.checked
                          ? new Set(targetList.map(({ row }) => row.id))
                          : new Set(),
                      );
                    }}
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

                const colInRange =
                  hasActiveRange &&
                  normalizedRange !== null &&
                  i >= normalizedRange.minCol &&
                  i <= normalizedRange.maxCol;

                return (
                  <th
                    key={c.id}
                    className={[
                      selected.size === 0 &&
                      !hasActiveRange &&
                      active.col === i
                        ? "column-active"
                        : "",
                      colInRange ? "column-in-range" : "",
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
                        onClick={(event) => {
                          if (!visible.length) return;
                          if (selected.size > 0) {
                            setActive((old) => ({ ...old, col: i }));
                            return;
                          }
                          const startCol =
                            event.shiftKey && rangeAnchorRef.current
                              ? rangeAnchorRef.current.col
                              : i;
                          if (!event.shiftKey || !rangeAnchorRef.current) {
                            rangeAnchorRef.current = { rowPos: 0, col: i };
                          }
                          setCellRange({
                            startRowPos: 0,
                            endRowPos: selectableRowCount - 1,
                            startCol,
                            endCol: i,
                          });
                          setActive((old) => ({ ...old, col: i }));
                        }}
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
            {!stackHeader && rowStart > 0 && (
              <tr
                className="result-row-spacer"
                style={{ height: rowStart * SHEET_ROW_HEIGHT }}
                aria-hidden="true"
              >
                <td colSpan={1 + table.columns.length} />
              </tr>
            )}
            {renderedRows.map(({ row, index: r }, offset) => {
              const visiblePos = stackHeader ? offset : rowStart + offset;
              const rowInRange =
                hasActiveRange &&
                normalizedRange !== null &&
                visiblePos >= normalizedRange.minRowPos &&
                visiblePos <= normalizedRange.maxRowPos;
              return (
                <GridRow
                  key={row.id}
                  row={row}
                  rowIndex={r}
                  visiblePos={visiblePos}
                  selected={selected.has(row.id)}
                  inRangeRow={rowInRange}
                  rangeMinCol={
                    rowInRange && normalizedRange ? normalizedRange.minCol : -1
                  }
                  rangeMaxCol={
                    rowInRange && normalizedRange ? normalizedRange.maxCol : -1
                  }
                  isRangeTop={
                    rowInRange &&
                    normalizedRange !== null &&
                    visiblePos === normalizedRange.minRowPos
                  }
                  isRangeBottom={
                    rowInRange &&
                    normalizedRange !== null &&
                    visiblePos === normalizedRange.maxRowPos
                  }
                  activeCol={
                    selected.size > 0 || hasActiveRange
                      ? -1
                      : active.row === r
                        ? active.col
                        : -1
                  }
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
              );
            })}
            {!stackHeader && rowEnd < visible.length && (
              <tr
                className="result-row-spacer"
                style={{
                  height: (visible.length - rowEnd) * SHEET_ROW_HEIGHT,
                }}
                aria-hidden="true"
              >
                <td colSpan={1 + table.columns.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {stackHeader && visible.length > STACK_DEFAULT_ROWS && (
        <footer className="stack-block-footer">
          <span className="stack-footer-summary">
            Showing {renderedRows.length} of {visible.length} rows
          </span>
          <div className="stack-footer-actions">
            {renderedRows.length < visible.length && (
              <>
                <button
                  type="button"
                  className="stack-footer-btn"
                  onClick={() =>
                    stackHeader.onRowLimitChange?.(
                      Math.min(visible.length, renderedRows.length + 20),
                    )
                  }
                >
                  Show more (+
                  {Math.min(20, visible.length - renderedRows.length)})
                </button>
                {visible.length - renderedRows.length > 20 && (
                  <button
                    type="button"
                    className="stack-footer-btn"
                    onClick={() =>
                      stackHeader.onRowLimitChange?.(visible.length)
                    }
                  >
                    Show all ({visible.length})
                  </button>
                )}
              </>
            )}
            {renderedRows.length > STACK_DEFAULT_ROWS && (
              <button
                type="button"
                className="stack-footer-btn"
                onClick={() => stackHeader.onRowLimitChange?.(undefined)}
              >
                Show less
              </button>
            )}
          </div>
        </footer>
      )}

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
            {hasActiveRange && normalizedRange
              ? ` · ${normalizedRange.rowCount}×${normalizedRange.colCount} selected`
              : selected.size > 1
                ? ` · ${selected.size} selected`
                : ""}
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
              title="Set active cell or selected range to NULL (Option+Backspace)"
              disabled={!hasActiveRange && !canSetNullActiveCell}
              onClick={() => setNullTargetCells(active.row, active.col)}
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
                <div className="result-menu-label">{scopeDescription}</div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsInsert()}
                >
                  <span>
                    Copy as INSERT{scopeBadge ? ` (${scopeBadge})` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsUpdate()}
                >
                  <span>
                    Copy as UPDATE{scopeBadge ? ` (${scopeBadge})` : ""}
                  </span>
                </button>
                <hr />
                {hasActiveRange ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleCopyAsTsv(undefined, false)}
                  >
                    <span>Copy Selected Cells ({scopeBadge})</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleCopyCellValue()}
                  >
                    <span>Copy Cell Value</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyWithHeader()}
                >
                  <span>
                    Copy with Header{scopeBadge ? ` (${scopeBadge})` : ""}
                  </span>
                </button>
                {visiblePopulated.length > 1 && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleCopyWithHeader(undefined, true)}
                  >
                    <span>
                      Copy All with Header ({visiblePopulated.length})
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsCsv()}
                >
                  <span>Copy as CSV{scopeBadge ? ` (${scopeBadge})` : ""}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsTsv(undefined, false)}
                >
                  <span>Copy as TSV (Tab-separated)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyAsJson()}
                >
                  <span>
                    Copy as JSON{scopeBadge ? ` (${scopeBadge})` : ""}
                  </span>
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

          <RowFilter active={hasActiveFilter || filterCol !== "*"}>
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
          </RowFilter>

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
      {contextMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={contextMenuRef}
            className="result-floating-menu result-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <div className="result-menu-label">{scopeDescription}</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCopyAsInsert(contextMenu.rowIndex)}
            >
              <span>Copy as INSERT{scopeBadge ? ` (${scopeBadge})` : ""}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCopyAsUpdate(contextMenu.rowIndex)}
            >
              <span>Copy as UPDATE{scopeBadge ? ` (${scopeBadge})` : ""}</span>
            </button>
            <hr />
            {hasActiveRange ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleCopyAsTsv(contextMenu.rowIndex, false)}
              >
                <span>Copy Selected Cells ({scopeBadge})</span>
              </button>
            ) : (
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
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                void handleCopyWithHeader(contextMenu.rowIndex, false)
              }
            >
              <span>
                Copy with Header{scopeBadge ? ` (${scopeBadge})` : ""}
              </span>
            </button>
            {visiblePopulated.length > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  void handleCopyWithHeader(contextMenu.rowIndex, true)
                }
              >
                <span>Copy All with Header ({visiblePopulated.length})</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCopyAsCsv(contextMenu.rowIndex)}
            >
              <span>
                Copy {hasActiveRange ? `Selection (${scopeBadge})` : "Row(s)"} as CSV
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCopyAsTsv(contextMenu.rowIndex, false)}
            >
              <span>
                Copy {hasActiveRange ? `Selection (${scopeBadge})` : "Row(s)"} as TSV
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCopyAsJson(contextMenu.rowIndex)}
            >
              <span>
                Copy {hasActiveRange ? `Selection (${scopeBadge})` : "Row(s)"} as JSON
              </span>
            </button>
            {table.columns[contextMenu.colIndex] && (
              <>
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    handleFilterByCell(
                      contextMenu.rowIndex,
                      contextMenu.colIndex,
                    )
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
                      hasActiveRange && normalizedRange
                        ? visible
                            .slice(
                              normalizedRange.minRowPos,
                              normalizedRange.maxRowPos + 1,
                            )
                            .map(({ index }) => index)
                        : selected.size > 0
                          ? undefined
                          : [contextMenu.rowIndex],
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
                    setNullTargetCells(
                      contextMenu.rowIndex,
                      contextMenu.colIndex,
                    );
                    setContextMenu(null);
                  }}
                >
                  <span>Set NULL{scopeBadge ? ` (${scopeBadge})` : ""}</span>
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
                      hasActiveRange && normalizedRange
                        ? new Set(
                            visible
                              .slice(
                                normalizedRange.minRowPos,
                                normalizedRange.maxRowPos + 1,
                              )
                              .map(({ row: item }) => item.id),
                          )
                        : selected.size > 0
                          ? selected
                          : row
                            ? new Set([row.id])
                            : undefined,
                    );
                    setCellRange(null);
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
          </div>,
          document.body,
        )}
        </>
      )}
    </div>
  );
});

interface CellHandlers {
  select: (
    id: string,
    rowIndex: number,
    checked: boolean,
    shiftKey?: boolean,
    additive?: boolean,
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
  cellMouseDown: (
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
  cellMouseEnter: (
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
  contextMenu: (
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
}

const GridCell = memo(function GridCell({
  column,
  rowIndex,
  visiblePos,
  columnIndex,
  value,
  hint,
  isActive,
  inCellRange,
  isRangeTop,
  isRangeBottom,
  isRangeLeft,
  isRangeRight,
  changed,
  placeholder,
  disabled,
  locked,
  readOnly,
  handlers,
}: {
  column: ColumnDefinition;
  rowIndex: number;
  visiblePos: number;
  columnIndex: number;
  value: CellValue;
  hint: string;
  isActive: boolean;
  inCellRange: boolean;
  isRangeTop: boolean;
  isRangeBottom: boolean;
  isRangeLeft: boolean;
  isRangeRight: boolean;
  changed: boolean;
  placeholder: string;
  disabled: boolean;
  locked: boolean;
  readOnly: boolean;
  handlers: RefObject<CellHandlers>;
}) {
  return (
    <td
      className={[
        isActive ? "cell-active" : "",
        inCellRange ? "cell-in-range" : "",
        inCellRange && isRangeTop ? "range-top" : "",
        inCellRange && isRangeBottom ? "range-bottom" : "",
        inCellRange && isRangeLeft ? "range-left" : "",
        inCellRange && isRangeRight ? "range-right" : "",
        changed ? "cell-changed" : "",
        value === null ? "cell-null" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={value === null ? "NULL" : (value ?? "")}
      onMouseDown={(event) =>
        handlers.current.cellMouseDown(event, visiblePos, rowIndex, columnIndex)
      }
      onMouseEnter={(event) =>
        handlers.current.cellMouseEnter(
          event,
          visiblePos,
          rowIndex,
          columnIndex,
        )
      }
      onContextMenu={(event) =>
        handlers.current.contextMenu(event, visiblePos, rowIndex, columnIndex)
      }
    >
      {locked ? (
        value === null ? (
          <em>NULL</em>
        ) : (
          value ?? ""
        )
      ) : (
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
      )}
    </td>
  );
});

const GridRow = memo(function GridRow({
  row,
  rowIndex: r,
  visiblePos,
  selected,
  inRangeRow,
  rangeMinCol,
  rangeMaxCol,
  isRangeTop,
  isRangeBottom,
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
  visiblePos: number;
  selected: boolean;
  inRangeRow: boolean;
  rangeMinCol: number;
  rangeMaxCol: number;
  isRangeTop: boolean;
  isRangeBottom: boolean;
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
        inRangeRow ? "row-in-range" : "",
      ].join(" ")}
    >
      <th
        className="row-gutter"
        onContextMenu={(event) =>
          handlers.current.contextMenu(event, visiblePos, r, -1)
        }
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
        const inCellRange =
          inRangeRow && c >= rangeMinCol && c <= rangeMaxCol;
        return (
          <GridCell
            key={column.id}
            column={column}
            rowIndex={r}
            visiblePos={visiblePos}
            columnIndex={c}
            value={value}
            hint={cellHints[c]}
            isActive={activeCol === c}
            inCellRange={inCellRange}
            isRangeTop={inCellRange && isRangeTop}
            isRangeBottom={inCellRange && isRangeBottom}
            isRangeLeft={inCellRange && c === rangeMinCol}
            isRangeRight={inCellRange && c === rangeMaxCol}
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
            locked={locked}
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
