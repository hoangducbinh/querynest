import { RowFilter } from "../sample-data/RowFilter";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  FileCode2,
  KeyRound,
  Lock,
  LockOpen,
  Maximize2,
  Plus,
  RotateCcw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
export function columnTypeHint(type: string): string {
  const upper = type.toUpperCase();
  if (upper.includes("JSON")) return "JSON data";
  if (upper.includes("[]") || upper.includes("ARRAY")) return "Array data";
  if (
    upper.includes("BYTEA") ||
    upper.includes("BINARY") ||
    upper.includes("BLOB") ||
    upper.includes("IMAGE")
  )
    return "Binary data";
  if (upper.includes("XML")) return "XML data";
  if (upper.includes("GEOMETRY") || upper.includes("GEOGRAPHY"))
    return "Spatial data";
  return type;
}
import type {
  ColumnDefinition,
  DatabaseSchema,
  TableDefinition,
} from "../../types/schema";
import {
  ColumnResizeHandle,
  fitColumnWidth,
  useColumnWidths,
  useColumnWindow,
} from "../sample-data/column-sizing";
import {
  cellText,
  isChanged,
  makeDraft,
  parseClipboard,
  pasteCells,
  type CellValue,
  type DraftRow,
} from "../sample-data/model";
import {
  gridPosition,
  rememberGridPosition,
  rememberGridView,
} from "../sample-data/view-state";
import type { SqlDialect } from "./data-types";
import type { SqlResult } from "./execution";
import {
  buildCopyAsCsv,
  buildCopyAsInsert,
  buildCopyAsTsv,
  buildCopyAsUpdate,
  inferResultTableTarget,
  isJoinQuery,
} from "./result-sql-copy";

const ROW_HEIGHT = 29;
const COMPACT_ROW_HEIGHT = 25;
const ROW_OVERSCAN = 45;
const ROW_CHUNK = 30;
const VIRTUALIZE_THRESHOLD_LOCKED = 400;
const VIRTUALIZE_THRESHOLD_EDITABLE = 120;
export const STACK_DEFAULT_ROWS = 10;

const valueAt = (row: DraftRow, name: string): CellValue =>
  Object.hasOwn(row.cells, name)
    ? row.cells[name]
    : row.original?.[name] === null
      ? null
      : row.original && Object.hasOwn(row.original, name)
        ? cellText(row.original[name])
        : undefined;

function effectiveRowValues(
  row: DraftRow,
  columns: string[],
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const col of columns) {
    if (Object.hasOwn(row.cells, col) && row.cells[col] !== undefined) {
      record[col] = row.cells[col];
    } else if (row.original && Object.hasOwn(row.original, col)) {
      record[col] = row.original[col];
    } else {
      record[col] = null;
    }
  }
  return record;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to textarea copy fallback
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

interface VisibleColumnItem {
  name: string;
  index: number;
  column?: ColumnDefinition;
  hint?: string;
}

interface ResultRowHandlers {
  onGutterClick: (
    event: ReactMouseEvent,
    rowId: string,
    visiblePos: number,
    rowIndex: number,
  ) => void;
  onCheckboxChange: (
    checked: boolean,
    rowId: string,
    visiblePos: number,
  ) => void;
  onCellMouseDown: (
    event: ReactMouseEvent,
    rowId: string,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
  onCellMouseEnter: (
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
  onContextMenu: (
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
  onCellFocus: (rowIndex: number, colIndex: number) => void;
  onCellChange: (rowIndex: number, colIndex: number, value: string) => void;
  onCellKeyDown: (
    event: KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number,
  ) => void;
  onCellPaste: (
    event: ClipboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number,
  ) => void;
  canEditCell: (rowIndex: number, colIndex: number) => boolean;
}

const ResultTableRow = memo(function ResultTableRow({
  row,
  rowIndex: r,
  visiblePos,
  isRowSelected,
  inRangeRow,
  rangeMinCol,
  rangeMaxCol,
  isRangeTop,
  isRangeBottom,
  activeCol,
  editable,
  disabled,
  saving,
  visibleColumns,
  colStart,
  colEnd,
  totalColumns,
  handlers,
}: {
  row: DraftRow;
  rowIndex: number;
  visiblePos: number;
  isRowSelected: boolean;
  inRangeRow: boolean;
  rangeMinCol: number;
  rangeMaxCol: number;
  isRangeTop: boolean;
  isRangeBottom: boolean;
  activeCol: number;
  editable: boolean;
  disabled: boolean;
  saving: boolean;
  visibleColumns: VisibleColumnItem[];
  colStart: number;
  colEnd: number;
  totalColumns: number;
  handlers: RefObject<ResultRowHandlers>;
}) {
  const isRowActive = activeCol >= 0;
  const rowClass = [
    isRowSelected ? "row-selected" : "",
    inRangeRow ? "row-in-range" : "",
    isRowActive ? "row-active" : "",
    row.deleted ? "row-deleted" : "",
    !row.original ? "row-new" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr className={rowClass || undefined}>
      <td
        className="result-row-gutter muted"
        onContextMenu={(e) =>
          handlers.current.onContextMenu(e, visiblePos, r, -1)
        }
        onClick={(e) => {
          if ((e.target as HTMLElement).tagName === "INPUT") return;
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            e.preventDefault();
            handlers.current.onGutterClick(e, row.id, visiblePos, r);
          }
        }}
      >
        <label>
          <input
            type="checkbox"
            aria-label={`Select row ${r + 1}`}
            checked={isRowSelected}
            onChange={(e) => {
              const nativeEvt = e.nativeEvent as MouseEvent;
              if (nativeEvt.shiftKey) {
                handlers.current.onGutterClick(
                  {
                    shiftKey: true,
                    metaKey: nativeEvt.metaKey,
                    ctrlKey: nativeEvt.ctrlKey,
                  } as ReactMouseEvent,
                  row.id,
                  visiblePos,
                  r,
                );
                return;
              }
              handlers.current.onCheckboxChange(
                e.target.checked,
                row.id,
                visiblePos,
              );
            }}
          />
          <span>{r + 1}</span>
        </label>
      </td>
      {colStart > 0 && (
        <td
          className="column-spacer"
          colSpan={colStart}
          aria-hidden="true"
        />
      )}
      {visibleColumns.map(({ name: c, index: colIdx, hint }) => {
        const edited =
          Object.hasOwn(row.cells, c) && row.cells[c] !== undefined;
        const val = valueAt(row, c);
        const isNull = val === null;
        const cellEditable =
          editable && handlers.current.canEditCell(r, colIdx);
        const inCellRange =
          inRangeRow && colIdx >= rangeMinCol && colIdx <= rangeMaxCol;

        return (
          <td
            key={c}
            className={[
              edited ? "cell-changed" : "",
              isNull ? "cell-null" : "",
              activeCol === colIdx ? "cell-active" : "",
              inCellRange ? "cell-in-range" : "",
              inCellRange && isRangeTop ? "range-top" : "",
              inCellRange && isRangeBottom ? "range-bottom" : "",
              inCellRange && colIdx === rangeMinCol ? "range-left" : "",
              inCellRange && colIdx === rangeMaxCol ? "range-right" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={isNull ? "NULL" : (val ?? "")}
            onMouseDown={(e) =>
              handlers.current.onCellMouseDown(e, row.id, visiblePos, r, colIdx)
            }
            onMouseEnter={(e) =>
              handlers.current.onCellMouseEnter(e, visiblePos, r, colIdx)
            }
            onContextMenu={(e) =>
              handlers.current.onContextMenu(e, visiblePos, r, colIdx)
            }
          >
            {editable ? (
              <input
                data-row={r}
                data-col={colIdx}
                aria-label={`${c} row ${r + 1}`}
                readOnly={!cellEditable}
                disabled={disabled || saving}
                value={val ?? ""}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  isNull ? "NULL" : !row.original ? hint : ""
                }
                onFocus={() => handlers.current.onCellFocus(r, colIdx)}
                onChange={(e) =>
                  handlers.current.onCellChange(r, colIdx, e.target.value)
                }
                onKeyDown={(e) =>
                  handlers.current.onCellKeyDown(e, r, colIdx)
                }
                onPaste={(e) => handlers.current.onCellPaste(e, r, colIdx)}
              />
            ) : isNull ? (
              <em>NULL</em>
            ) : (
              val
            )}
          </td>
        );
      })}
      {colEnd < totalColumns && (
        <td
          className="column-spacer"
          colSpan={totalColumns - colEnd}
          aria-hidden="true"
        />
      )}
    </tr>
  );
});

export interface StackBlockHeaderProps {
  index: number;
  label: string;
  sql: string;
  onToggleCollapse: () => void;
  onExpandToTab: () => void;
  rowLimit?: number;
  onRowLimitChange?: (limit: number | undefined) => void;
}

export interface ResultSetViewProps {
  viewKey?: string;
  result: SqlResult;
  table?: TableDefinition;
  schema?: DatabaseSchema;
  dialect?: SqlDialect;
  disabled?: boolean;
  onDirty?: (dirty: boolean) => void;
  onSave?: (drafts: DraftRow[]) => Promise<Record<string, unknown>[]>;
  stackHeader?: StackBlockHeaderProps;
}

export const ResultSetView = memo(function ResultSetView({
  viewKey,
  result,
  table,
  schema,
  dialect = "default",
  disabled = false,
  onDirty,
  onSave,
  stackHeader,
}: ResultSetViewProps) {
  const compact = Boolean(stackHeader);
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const columns = result.columns;
  const canUnlock = !compact && !!table && !!onSave;
  const [isUnlocked, setIsUnlocked] = useState(false);
  const editable = canUnlock && isUnlocked;
  const inferredTarget = useMemo(
    () => inferResultTableTarget(result.sql, schema, dialect),
    [result.sql, schema, dialect],
  );
  const isJoin = useMemo(
    () => isJoinQuery(result.sql, dialect),
    [result.sql, dialect],
  );
  const metadataTable = table ?? (isJoin ? undefined : inferredTarget.table);
  const columnMap = useMemo(
    () =>
      new Map<string, ColumnDefinition>(
        (metadataTable?.columns ?? []).map((col) => [col.name, col]),
      ),
    [metadataTable],
  );
  const pkColumnNames = useMemo(
    () =>
      new Set(
        (metadataTable?.primaryKey ?? [])
          .map((pkId) => metadataTable?.columns.find((c) => c.id === pkId)?.name)
          .filter((name): name is string => !!name),
      ),
    [metadataTable],
  );

  const [drafts, setDrafts] = useState<DraftRow[]>(() =>
    result.rows.map((row) => makeDraft(row)),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedRowRef = useRef<number | null>(null);
  const rangeAnchorRef = useRef<{ rowPos: number; col: number } | null>(null);
  const isDraggingRangeRef = useRef(false);
  const [cellRange, setCellRange] = useState<{
    startRowPos: number;
    endRowPos: number;
    startCol: number;
    endCol: number;
  } | null>(null);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [focusCell, setFocusCell] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [filter, setFilter] = useState(() =>
    viewKey ? gridPosition(viewKey).filter : "",
  );
  const [saving, setSaving] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    rowIndex: number;
    colIndex: number;
  } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const previousRowsRef = useRef(result.rows);

  const changes = useMemo(() => drafts.filter(isChanged), [drafts]);
  const dirty = changes.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const { addedCount, editedCount, deletedCount } = useMemo(() => {
    let added = 0;
    let edited = 0;
    let deleted = 0;
    for (const r of changes) {
      if (!r.original && !r.deleted) added++;
      else if (r.original && !r.deleted) edited++;
      else if (r.original && r.deleted) deleted++;
    }
    return { addedCount: added, editedCount: edited, deletedCount: deleted };
  }, [changes]);

  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);

  useEffect(() => {
    if (viewKey) rememberGridView(viewKey, 0, filter);
  }, [viewKey, filter]);

  useEffect(() => {
    if (result.rows === previousRowsRef.current) return;
    previousRowsRef.current = result.rows;
    if (!dirtyRef.current) {
      setDrafts(result.rows.map((row) => makeDraft(row)));
      setSelected(new Set());
      setCellRange(null);
      setRequiresRefresh(false);
      setIsUnlocked(false);
    }
  }, [result.rows]);

  useEffect(() => {
    const stopDrag = () => {
      isDraggingRangeRef.current = false;
    };
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!contextMenu && !copyMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(".result-context-menu") ||
        target?.closest(".result-copy-dropdown")
      )
        return;
      setContextMenu(null);
      setCopyMenuOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setCopyMenuOpen(false);
      }
    };
    const handleAnyScroll = () => {
      setContextMenu(null);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleAnyScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleAnyScroll, true);
    };
  }, [contextMenu, copyMenuOpen]);

  const sizing = useColumnWidths(
    `results:${JSON.stringify(columns)}`,
    columns,
  );
  const sampleRows = useMemo(() => result.rows.slice(0, 100), [result.rows]);
  const defaultWidths = useMemo(
    () =>
      columns.map((name) =>
        fitColumnWidth(
          name,
          sampleRows.map((row) => row[name]),
          280,
        ),
      ),
    [columns, sampleRows],
  );
  const widths = columns.map((name, index) =>
    sizing.width(name, defaultWidths[index]),
  );
  const gutterWidth = compact ? 34 : 38;
  const initialPos = viewKey ? gridPosition(viewKey) : undefined;
  const viewport = useColumnWindow(widths, gutterWidth, initialPos);

  const visibleColumns = useMemo<VisibleColumnItem[]>(
    () =>
      columns
        .slice(viewport.start, viewport.end)
        .map((name, offset) => {
          const column = columnMap.get(name);
          return {
            name,
            index: viewport.start + offset,
            column,
            hint: column
              ? columnTypeHint(column.nativeType ?? column.type)
              : undefined,
          };
        }),
    [columns, viewport.start, viewport.end, columnMap],
  );

  const visibleRows = useMemo(
    () =>
      drafts
        .map((row, index) => ({ row, index }))
        .filter(
          ({ row }) =>
            compact ||
            !filter ||
            Object.keys(row.cells).length > 0 ||
            !row.original ||
            columns.some((col) =>
              cellText(row.original?.[col])
                .toLowerCase()
                .includes(filter.toLowerCase()),
            ),
        ),
    [drafts, compact, filter, columns],
  );

  const effectiveStackLimit = stackHeader?.rowLimit ?? STACK_DEFAULT_ROWS;
  const selectableRowCount = compact
    ? Math.min(visibleRows.length, Math.max(1, effectiveStackLimit))
    : visibleRows.length;

  const normalizedRange = useMemo(() => {
    if (
      selected.size > 0 ||
      !cellRange ||
      !selectableRowCount ||
      !columns.length
    ) {
      return null;
    }
    const maxRowIdx = selectableRowCount - 1;
    const maxColIdx = columns.length - 1;
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
  }, [selected.size, cellRange, selectableRowCount, columns.length]);

  const hasActiveRange = Boolean(
    normalizedRange && normalizedRange.cellCount > 1,
  );

  const virtualizeThreshold = editable
    ? VIRTUALIZE_THRESHOLD_EDITABLE
    : VIRTUALIZE_THRESHOLD_LOCKED;
  const shouldVirtualizeRows =
    !compact && visibleRows.length > virtualizeThreshold;

  const [rowRange, setRowRange] = useState(() => {
    const initialTop = initialPos?.top ?? 0;
    const rawStart = Math.max(
      0,
      Math.floor(initialTop / rowHeight) - ROW_OVERSCAN,
    );
    const start = Math.floor(rawStart / ROW_CHUNK) * ROW_CHUNK;
    const end = start + ROW_OVERSCAN * 2 + ROW_CHUNK * 2;
    return { start, end };
  });

  useLayoutEffect(() => {
    if (!shouldVirtualizeRows) return;
    const element = viewport.ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = element.scrollTop;
      const height = Math.max(element.clientHeight || 360, 220);
      const rawStart = Math.max(0, Math.floor(top / rowHeight) - ROW_OVERSCAN);
      const start = Math.floor(rawStart / ROW_CHUNK) * ROW_CHUNK;
      const rawEnd = Math.ceil((top + height) / rowHeight) + ROW_OVERSCAN;
      const end = Math.ceil(rawEnd / ROW_CHUNK) * ROW_CHUNK;
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
  }, [shouldVirtualizeRows, rowHeight]);

  const rowStart = shouldVirtualizeRows
    ? Math.min(rowRange.start, Math.max(0, visibleRows.length - 1))
    : 0;
  const rowEnd = shouldVirtualizeRows
    ? Math.min(visibleRows.length, Math.max(rowStart + 1, rowRange.end))
    : visibleRows.length;
  const windowedRows = useMemo(
    () =>
      compact
        ? visibleRows.slice(0, Math.max(1, effectiveStackLimit))
        : shouldVirtualizeRows
          ? visibleRows.slice(rowStart, rowEnd)
          : visibleRows,
    [
      compact,
      effectiveStackLimit,
      shouldVirtualizeRows,
      visibleRows,
      rowStart,
      rowEnd,
    ],
  );

  function scrollVisiblePosIntoView(visiblePos: number) {
    const container = viewport.ref.current;
    if (!container || visiblePos < 0) return;
    const rowTop = visiblePos * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewTop = container.scrollTop;
    const viewHeight = Math.max(0, container.clientHeight - (compact ? 25 : 30));
    if (viewHeight <= 0) return;
    if (rowTop < viewTop) {
      container.scrollTop = rowTop;
    } else if (rowBottom > viewTop + viewHeight) {
      container.scrollTop = Math.max(0, rowBottom - viewHeight);
    }
  }

  useLayoutEffect(() => {
    if (!focusCell) return;
    const visiblePos = visibleRows.findIndex(
      ({ index }) => index === focusCell.row,
    );
    if (visiblePos >= 0) {
      scrollVisiblePosIntoView(visiblePos);
    }
    const input = rootRef.current?.querySelector<HTMLInputElement>(
      `input[data-row="${focusCell.row}"][data-col="${focusCell.col}"]`,
    );
    if (!input) {
      const container = viewport.ref.current;
      if (container) {
        const left =
          gutterWidth +
          widths.slice(0, focusCell.col).reduce((sum, w) => sum + w, 0);
        container.scrollLeft = Math.max(0, left - gutterWidth);
      }
      return;
    }
    input.focus();
    input.select();
    setFocusCell(null);
  }, [focusCell, drafts, viewport.start, viewport.end, rowStart, rowEnd]);

  // Keep active.row within bounds
  const clampedActiveRow = drafts.length
    ? Math.min(Math.max(0, active.row), drafts.length - 1)
    : 0;
  const activeDraft = drafts[clampedActiveRow];
  const activeColumnName = columns[active.col] ?? columns[0];
  const activeColDef = activeColumnName
    ? columnMap.get(activeColumnName)
    : undefined;

  function canEditCell(rowIndex: number, colIndex: number): boolean {
    if (!editable || disabled || saving || requiresRefresh) return false;
    const row = drafts[rowIndex];
    if (!row || row.deleted) return false;
    if (row.original && !table!.primaryKey.length) return false;
    const colName = columns[colIndex];
    const colDef = colName ? columnMap.get(colName) : undefined;
    if (colDef?.generated || colDef?.readOnly) return false;
    return true;
  }

  function updateCell(rowIndex: number, colIndex: number, value: CellValue) {
    if (!canEditCell(rowIndex, colIndex)) return;
    const colName = columns[colIndex];
    if (!colName) return;
    setError("");
    setNotice("");
    setDrafts((current) =>
      current.map((row, idx) =>
        idx === rowIndex
          ? { ...row, cells: { ...row.cells, [colName]: value } }
          : row,
      ),
    );
  }

  function addRow() {
    if (!editable || disabled || saving || requiresRefresh) return;
    const nextRow = { ...makeDraft(), insert: true };
    const newIndex = drafts.length;
    setDrafts((current) => [...current, nextRow]);
    setFilter("");
    const firstEditableCol = columns.findIndex((name) => {
      const col = columnMap.get(name);
      return !col?.generated && !col?.readOnly;
    });
    const col = Math.max(0, firstEditableCol);
    setActive({ row: newIndex, col });
    setSelected(new Set([nextRow.id]));
    setFocusCell({ row: newIndex, col });
  }

  function deleteTargetRows() {
    if (!editable || disabled || saving || requiresRefresh) return;
    const targetIds =
      hasActiveRange && normalizedRange
        ? new Set(
            visibleRows
              .slice(normalizedRange.minRowPos, normalizedRange.maxRowPos + 1)
              .map(({ row }) => row.id),
          )
        : selected.size > 0
          ? selected
          : activeDraft
            ? new Set([activeDraft.id])
            : new Set<string>();
    if (!targetIds.size) return;
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
    setCellRange(null);
    setError("");
  }

  function setNullTargetCells(fallbackRow = clampedActiveRow, fallbackCol = active.col) {
    if (!editable || disabled || saving || requiresRefresh) return;
    if (hasActiveRange && normalizedRange) {
      const targetRowIndices = new Set(
        visibleRows
          .slice(normalizedRange.minRowPos, normalizedRange.maxRowPos + 1)
          .map(({ index }) => index),
      );
      const targetColNames = columns
        .slice(normalizedRange.minCol, normalizedRange.maxCol + 1)
        .filter((colName) => {
          const colDef = columnMap.get(colName);
          return !colDef?.generated && !colDef?.readOnly && colDef?.nullable !== false;
        });
      if (!targetRowIndices.size || !targetColNames.length) return;
      setError("");
      setNotice("");
      setDrafts((current) =>
        current.map((row, idx) => {
          if (!targetRowIndices.has(idx) || row.deleted) return row;
          if (row.original && !table?.primaryKey.length) return row;
          const nextCells = { ...row.cells };
          for (const colName of targetColNames) {
            nextCells[colName] = null;
          }
          return { ...row, cells: nextCells };
        }),
      );
      return;
    }
    updateCell(fallbackRow, fallbackCol, null);
  }

  async function saveChanges() {
    if (!editable || !onSave || disabled || saving || !dirty || requiresRefresh)
      return;
    if (
      deletedCount > 0 &&
      !(await confirmAction(
        `Delete ${deletedCount} row${deletedCount === 1 ? "" : "s"} and apply the other changes?`,
      ))
    )
      return;
    setSaving(true);
    setError("");
    try {
      const nextRows = await onSave(drafts);
      setDrafts(nextRows.map((r) => makeDraft(r)));
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
    if (!(await confirmAction("Discard unsaved result changes?"))) return;
    setDrafts(result.rows.map((r) => makeDraft(r)));
    setSelected(new Set());
    setError("");
    setNotice("Changes discarded");
    setRequiresRefresh(false);
  }

  function navigateCell(row: number, col: number) {
    if (!columns.length) return;
    if (col < 0) {
      row--;
      col = columns.length - 1;
    } else if (col >= columns.length) {
      row++;
      col = 0;
    }
    if (row < 0 || row >= drafts.length) return;
    setActive({ row, col });
    setFocusCell({ row, col });
  }

  function handleCellKey(
    e: KeyboardEvent<HTMLInputElement>,
    r: number,
    c: number,
  ) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void saveChanges();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      navigateCell(r + (e.shiftKey ? -1 : 1), c);
    } else if (e.key === "Tab") {
      e.preventDefault();
      navigateCell(r, c + (e.shiftKey ? -1 : 1));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      navigateCell(r + (e.key === "ArrowDown" ? 1 : -1), c);
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      navigateCell(r, c - 1);
    } else if (
      e.key === "ArrowRight" &&
      e.currentTarget.selectionStart === e.currentTarget.value.length
    ) {
      e.preventDefault();
      navigateCell(r, c + 1);
    } else if (e.key === "Backspace" && e.altKey) {
      e.preventDefault();
      updateCell(r, c, null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      const colName = columns[c];
      setDrafts((current) =>
        current.map((row, idx) => {
          if (idx !== r) return row;
          const cells = { ...row.cells };
          delete cells[colName];
          return { ...row, cells };
        }),
      );
    }
  }

  function handlePaste(
    event: ClipboardEvent<HTMLInputElement>,
    row: number,
    col: number,
  ) {
    if (!editable || !table || disabled || saving || requiresRefresh) return;
    const text = event.clipboardData.getData("text/plain");
    if (!/[\t\r\n]/.test(text)) return;
    event.preventDefault();
    try {
      const pasted = pasteCells(
        drafts,
        table,
        row,
        col,
        parseClipboard(text),
      );
      if (
        pasted.length > drafts.length &&
        !pasted.at(-1)?.original &&
        !isChanged(pasted.at(-1)!)
      ) {
        pasted.pop();
      }
      setDrafts(pasted);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function resolveCopyScope(allRows = false): {
    rows: DraftRow[];
    cols: string[];
    isRange: boolean;
  } {
    if (allRows) {
      return {
        rows: visibleRows.map(({ row }) => row).filter((r) => !r.deleted),
        cols: columns,
        isRange: false,
      };
    }
    if (hasActiveRange && normalizedRange) {
      return {
        rows: visibleRows
          .slice(normalizedRange.minRowPos, normalizedRange.maxRowPos + 1)
          .map(({ row }) => row)
          .filter((r) => !r.deleted),
        cols: columns.slice(normalizedRange.minCol, normalizedRange.maxCol + 1),
        isRange: true,
      };
    }
    if (selected.size > 0) {
      const chosen = drafts.filter((r) => selected.has(r.id) && !r.deleted);
      if (chosen.length > 0) {
        return { rows: chosen, cols: columns, isRange: false };
      }
    }
    const targetRowIdx = contextMenu ? contextMenu.rowIndex : clampedActiveRow;
    const targetColIdx = Math.max(
      0,
      Math.min(
        columns.length - 1,
        contextMenu ? contextMenu.colIndex : active.col,
      ),
    );
    const targetDraft = drafts[targetRowIdx] ?? activeDraft;
    const targetCol = columns[targetColIdx];
    if (targetDraft && !targetDraft.deleted && targetCol) {
      return { rows: [targetDraft], cols: [targetCol], isRange: true };
    }
    return { rows: [], cols: columns, isRange: false };
  }

  async function handleCopyAsInsert(allRows = false) {
    if (isJoin) return;
    const { rows: targetDrafts, cols: targetCols, isRange } =
      resolveCopyScope(allRows);
    if (!targetDrafts.length || !targetCols.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, targetCols));
    const sqlText = buildCopyAsInsert({
      columns: targetCols,
      rows,
      sql: result.sql,
      schema,
      table: metadataTable,
      dialect,
    });
    if (!sqlText) return;
    await copyTextToClipboard(sqlText);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      isRange
        ? `Copied ${rows.length}×${targetCols.length} as INSERT`
        : `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as INSERT`,
    );
  }

  async function handleCopyAsUpdate(allRows = false) {
    if (isJoin) return;
    const { rows: targetDrafts, cols: targetCols, isRange } =
      resolveCopyScope(allRows);
    if (!targetDrafts.length || !targetCols.length) return;
    const rows = targetDrafts.map((d) => ({
      current: effectiveRowValues(d, columns),
      original: d.original,
    }));
    const sqlText = buildCopyAsUpdate({
      columns,
      setColumns: isRange ? targetCols : undefined,
      rows,
      sql: result.sql,
      schema,
      table: metadataTable,
      dialect,
    });
    if (!sqlText) return;
    await copyTextToClipboard(sqlText);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      isRange
        ? `Copied ${rows.length}×${targetCols.length} as UPDATE`
        : `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as UPDATE`,
    );
  }

  async function handleCopyWithHeader(allRows = false) {
    const { rows: targetDrafts, cols: targetCols, isRange } =
      resolveCopyScope(allRows);
    if (!targetDrafts.length || !targetCols.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, targetCols));
    const tsv = buildCopyAsTsv(targetCols, rows, true);
    await copyTextToClipboard(tsv);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      isRange
        ? `Copied ${rows.length}×${targetCols.length} with header`
        : `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} with header`,
    );
  }

  async function handleCopyAsTsv(allRows = false, includeHeader = false) {
    const { rows: targetDrafts, cols: targetCols, isRange } =
      resolveCopyScope(allRows);
    if (!targetDrafts.length || !targetCols.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, targetCols));
    const tsv = buildCopyAsTsv(targetCols, rows, includeHeader);
    await copyTextToClipboard(tsv);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      isRange
        ? `Copied ${rows.length}×${targetCols.length} as TSV`
        : `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as TSV`,
    );
  }

  async function handleCopyAsCsv(allRows = false, includeHeader = true) {
    const { rows: targetDrafts, cols: targetCols, isRange } =
      resolveCopyScope(allRows);
    if (!targetDrafts.length || !targetCols.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, targetCols));
    const csv = buildCopyAsCsv(targetCols, rows, includeHeader);
    await copyTextToClipboard(csv);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      isRange
        ? `Copied ${rows.length}×${targetCols.length} as CSV`
        : `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as CSV`,
    );
  }

  async function handleCopyAsJson(allRows = false) {
    const { rows: targetDrafts, cols: targetCols, isRange } =
      resolveCopyScope(allRows);
    if (!targetDrafts.length || !targetCols.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, targetCols));
    await copyTextToClipboard(JSON.stringify(rows, null, 2));
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      isRange
        ? `Copied ${rows.length}×${targetCols.length} as JSON`
        : `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as JSON`,
    );
  }

  async function handleCopyCellValue(rowIndex: number, colIndex: number) {
    const row = drafts[rowIndex];
    const colName = columns[colIndex];
    if (!row || !colName) return;
    const val = effectiveRowValues(row, columns)[colName];
    const text = val === null || val === undefined ? "NULL" : cellText(val);
    await copyTextToClipboard(text);
    setContextMenu(null);
    setNotice(`Copied ${colName}`);
  }

  function handleRowSelectClick(
    event: ReactMouseEvent,
    rowId: string,
    visiblePos: number,
    rowIndex: number,
  ) {
    setCellRange(null);
    const fallbackAnchor = visibleRows.findIndex(
      ({ index }) => index === clampedActiveRow,
    );
    const anchorPos =
      lastClickedRowRef.current ??
      (fallbackAnchor >= 0 ? fallbackAnchor : null);
    setActive((prev) =>
      prev.row === rowIndex ? prev : { row: rowIndex, col: prev.col },
    );
    if (event.shiftKey && anchorPos !== null) {
      const start = Math.min(anchorPos, visiblePos);
      const end = Math.max(anchorPos, visiblePos);
      const rangeIds = visibleRows
        .slice(start, end + 1)
        .map(({ row }) => row.id);
      setSelected((prev) => {
        const next = new Set(event.metaKey || event.ctrlKey ? prev : []);
        for (const id of rangeIds) next.add(id);
        return next;
      });
      return;
    }
    lastClickedRowRef.current = visiblePos;
    if (event.metaKey || event.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      });
    } else {
      setSelected(new Set([rowId]));
    }
  }

  function handleCellMouseDown(
    event: ReactMouseEvent,
    rowId: string,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      setCellRange(null);
      handleRowSelectClick(event, rowId, visiblePos, rowIndex);
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
    if (event.shiftKey) {
      event.preventDefault();
      const fallbackPos = visibleRows.findIndex(
        ({ index }) => index === clampedActiveRow,
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
    lastClickedRowRef.current = visiblePos;
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
      rootRef.current?.contains(document.activeElement)
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

  function openRowContextMenu(
    event: ReactMouseEvent,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) {
    event.preventDefault();
    const row = drafts[rowIndex];
    if (!row) return;
    const isGutter = colIndex < 0;
    const safeCol = isGutter ? Math.max(0, active.col) : Math.max(0, colIndex);
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
      setSelected(new Set([row.id]));
    } else if (!insideRange) {
      setCellRange(null);
      rangeAnchorRef.current = { rowPos: visiblePos, col: safeCol };
      setActive({ row: rowIndex, col: safeCol });
    }
    const menuWidth = 235;
    const menuHeight = editable ? 330 : 265;
    const x = Math.min(
      event.clientX,
      Math.max(8, window.innerWidth - menuWidth - 8),
    );
    const y = Math.min(
      event.clientY,
      Math.max(8, window.innerHeight - menuHeight - 8),
    );
    setContextMenu({ x, y, rowIndex, colIndex: safeCol });
  }

  const rowHandlersRef = useRef<ResultRowHandlers>({
    onGutterClick: handleRowSelectClick,
    onCheckboxChange: () => { },
    onCellMouseDown: handleCellMouseDown,
    onCellMouseEnter: handleCellMouseEnter,
    onContextMenu: openRowContextMenu,
    onCellFocus: () => { },
    onCellChange: updateCell,
    onCellKeyDown: handleCellKey,
    onCellPaste: handlePaste,
    canEditCell,
  });

  rowHandlersRef.current = {
    onGutterClick: handleRowSelectClick,
    onCheckboxChange: (checked, rowId, visiblePos) => {
      setCellRange(null);
      lastClickedRowRef.current = visiblePos;
      setSelected((prev) => {
        const next = new Set(prev);
        if (checked) next.add(rowId);
        else next.delete(rowId);
        return next;
      });
    },
    onCellMouseDown: handleCellMouseDown,
    onCellMouseEnter: handleCellMouseEnter,
    onContextMenu: openRowContextMenu,
    onCellFocus: (rowIndex, colIndex) => {
      if (selected.size > 0) return;
      setActive((old) =>
        old.row === rowIndex && old.col === colIndex
          ? old
          : { row: rowIndex, col: colIndex },
      );
    },
    onCellChange: updateCell,
    onCellKeyDown: handleCellKey,
    onCellPaste: handlePaste,
    canEditCell,
  };

  // Record navigation in visible rows
  const activeVisiblePos = useMemo(
    () => visibleRows.findIndex(({ index }) => index === clampedActiveRow),
    [visibleRows, clampedActiveRow],
  );
  function goToVisibleRow(targetVisiblePos: number) {
    if (!visibleRows.length) return;
    const clamped = Math.min(
      Math.max(0, targetVisiblePos),
      visibleRows.length - 1,
    );
    const target = visibleRows[clamped];
    if (target) {
      setActive((prev) => ({ row: target.index, col: prev.col }));
      setSelected(new Set([target.row.id]));
      scrollVisiblePosIntoView(clamped);
    }
  }

  if (!columns.length) {
    return (
      <div className="grid-scroll" tabIndex={0} aria-label="Query result data">
        <div className="results-empty">
          <Terminal size={22} />
          <p>Run a query to explore your data</p>
          <small>Results stay in your browser.</small>
        </div>
      </div>
    );
  }

  const targetCopyCount =
    hasActiveRange && normalizedRange
      ? normalizedRange.rowCount
      : selected.size > 0
        ? selected.size
        : drafts.length > 0
          ? 1
          : 0;
  const scopeBadge =
    hasActiveRange && normalizedRange
      ? `${normalizedRange.rowCount}×${normalizedRange.colCount}`
      : selected.size > 1
        ? `${selected.size}`
        : "";
  const scopeDescription =
    hasActiveRange && normalizedRange
      ? `${normalizedRange.rowCount} row${normalizedRange.rowCount === 1 ? "" : "s"} × ${normalizedRange.colCount} col${normalizedRange.colCount === 1 ? "" : "s"} selected`
      : selected.size > 0
        ? `${selected.size} selected row${selected.size === 1 ? "" : "s"}`
        : contextMenu
          ? `Row #${contextMenu.rowIndex + 1} · ${columns[contextMenu.colIndex] ?? ""}`
          : `Row #${clampedActiveRow + 1}`;

  return (
    <div
      className={`result-set-view${compact ? " is-compact-stack" : ""}`}
      ref={rootRef}
    >
      {stackHeader && (
        <header className="stack-block-header">
          <button
            type="button"
            className="stack-header-toggle"
            title={`${stackHeader.sql}\nClick to collapse`}
            aria-expanded={true}
            onClick={stackHeader.onToggleCollapse}
          >
            <ChevronDown size={12} />
            <strong>{stackHeader.label}</strong>
            <span className="stack-row-badge">
              {windowedRows.length < visibleRows.length
                ? `${windowedRows.length} / ${visibleRows.length} rows`
                : `${visibleRows.length} row${visibleRows.length === 1 ? "" : "s"}`}
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
              title="Open in single tab view"
              aria-label="Open in single tab view"
              onClick={stackHeader.onExpandToTab}
            >
              <Maximize2 size={11} />
            </Button>
          </div>
        </header>
      )}

      {error && (
        <div className="sheet-error" role="alert">
          <span>{error}</span>
          <button
            onClick={() => setError("")}
            aria-label="Dismiss result error"
          >
            ×
          </button>
        </div>
      )}

      <div
        className="grid-scroll result-grid-editable"
        ref={viewport.ref}
        tabIndex={0}
        aria-label="Query result data"
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
                void handleCopyWithHeader(false);
              } else if (hasActiveRange || selected.size > 0) {
                void handleCopyAsTsv(false, false);
              } else {
                void handleCopyCellValue(clampedActiveRow, active.col);
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
            "resizable-results navicat-result-table" +
            (editable ? " is-editable" : "") +
            (compact ? " is-compact" : "") +
            (selected.size > 0 ? " has-row-selection" : "") +
            (hasActiveRange ? " has-range-selection" : "")
          }
          style={{
            width: gutterWidth + widths.reduce((sum, w) => sum + w, 0),
          }}
        >
          <colgroup>
            <col style={{ width: gutterWidth }} />
            {columns.map((name, index) => (
              <col key={name} style={{ width: widths[index] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                className="result-row-gutter"
                title="Select all rows"
              >
                <label>
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    title="Select all rows"
                    checked={
                      selected.size > 0 &&
                      (compact ? windowedRows : visibleRows).length > 0 &&
                      (compact ? windowedRows : visibleRows).every(({ row }) =>
                        selected.has(row.id),
                      )
                    }
                    onChange={(e) => {
                      setCellRange(null);
                      const targetList = compact ? windowedRows : visibleRows;
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
              {viewport.start > 0 && (
                <th
                  className="column-spacer"
                  colSpan={viewport.start}
                  aria-hidden="true"
                />
              )}
              {visibleColumns.map(({ name, index, column }) => {
                const colInRange =
                  hasActiveRange &&
                  normalizedRange !== null &&
                  index >= normalizedRange.minCol &&
                  index <= normalizedRange.maxCol;
                return (
                  <th
                    key={name}
                    title={
                      column
                        ? `${name} · ${column.nativeType ?? column.type} (Click to select column)`
                        : `${name} (Click to select column)`
                    }
                    className={[
                      selected.size === 0 &&
                      !hasActiveRange &&
                      active.col === index
                        ? "column-active"
                        : "",
                      colInRange ? "column-in-range" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={(e) => {
                      if (
                        (e.target as HTMLElement).closest(
                          ".column-resize-handle",
                        ) ||
                        !visibleRows.length
                      ) {
                        return;
                      }
                      if (selected.size > 0) {
                        setActive((old) => ({ ...old, col: index }));
                        return;
                      }
                      const startCol =
                        e.shiftKey && rangeAnchorRef.current
                          ? rangeAnchorRef.current.col
                          : index;
                      if (!e.shiftKey || !rangeAnchorRef.current) {
                        rangeAnchorRef.current = { rowPos: 0, col: index };
                      }
                      setCellRange({
                        startRowPos: 0,
                        endRowPos: selectableRowCount - 1,
                        startCol,
                        endCol: index,
                      });
                      setActive((old) => ({ ...old, col: index }));
                    }}
                  >
                    <span className="result-column-name">
                      {pkColumnNames.has(name) && (
                        <KeyRound size={11} className="gold" />
                      )}
                      <span>{name}</span>
                    </span>
                    <ColumnResizeHandle
                      name={name}
                      width={widths[index]}
                      onResize={(width, persist) =>
                        sizing.resize(name, width, persist)
                      }
                      onAutoFit={() =>
                        sizing.resize(
                          name,
                          fitColumnWidth(
                            name,
                            drafts
                              .slice(0, 100)
                              .map(
                                (row) => effectiveRowValues(row, columns)[name],
                              ),
                          ),
                        )
                      }
                    />
                  </th>
                );
              })}
              {viewport.end < columns.length && (
                <th
                  className="column-spacer"
                  colSpan={columns.length - viewport.end}
                  aria-hidden="true"
                />
              )}
            </tr>
          </thead>
          <tbody>
            {!compact && rowStart > 0 && (
              <tr
                className="result-row-spacer"
                style={{ height: rowStart * rowHeight }}
                aria-hidden="true"
              >
                <td colSpan={1 + columns.length} />
              </tr>
            )}
            {windowedRows.map(({ row, index: r }, offset) => {
              const visiblePos = rowStart + offset;
              const rowInRange =
                hasActiveRange &&
                normalizedRange !== null &&
                visiblePos >= normalizedRange.minRowPos &&
                visiblePos <= normalizedRange.maxRowPos;
              return (
                <ResultTableRow
                  key={row.id}
                  row={row}
                  rowIndex={r}
                  visiblePos={visiblePos}
                  isRowSelected={selected.has(row.id)}
                  inRangeRow={rowInRange}
                  rangeMinCol={rowInRange && normalizedRange ? normalizedRange.minCol : -1}
                  rangeMaxCol={rowInRange && normalizedRange ? normalizedRange.maxCol : -1}
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
                      : clampedActiveRow === r
                        ? active.col
                        : -1
                  }
                  editable={editable}
                  disabled={disabled}
                  saving={saving}
                  visibleColumns={visibleColumns}
                  colStart={viewport.start}
                  colEnd={viewport.end}
                  totalColumns={columns.length}
                  handlers={rowHandlersRef}
                />
              );
            })}
            {!compact && rowEnd < visibleRows.length && (
              <tr
                className="result-row-spacer"
                style={{ height: (visibleRows.length - rowEnd) * rowHeight }}
                aria-hidden="true"
              >
                <td colSpan={1 + columns.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {compact && stackHeader && visibleRows.length > STACK_DEFAULT_ROWS && (
        <footer className="stack-block-footer">
          <span className="stack-footer-summary">
            Showing {windowedRows.length} of {visibleRows.length} rows
          </span>
          <div className="stack-footer-actions">
            {windowedRows.length < visibleRows.length && (
              <>
                <button
                  type="button"
                  className="stack-footer-btn"
                  onClick={() =>
                    stackHeader.onRowLimitChange?.(
                      Math.min(visibleRows.length, windowedRows.length + 20),
                    )
                  }
                >
                  Show more (+
                  {Math.min(20, visibleRows.length - windowedRows.length)})
                </button>
                {visibleRows.length - windowedRows.length > 20 && (
                  <button
                    type="button"
                    className="stack-footer-btn"
                    onClick={() =>
                      stackHeader.onRowLimitChange?.(visibleRows.length)
                    }
                  >
                    Show all ({visibleRows.length})
                  </button>
                )}
              </>
            )}
            {windowedRows.length > STACK_DEFAULT_ROWS && (
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

      {!compact && (
        <div
          className="result-navicat-bar"
          role="toolbar"
          aria-label="Result tools"
        >
          <div className="row result-nav-group">
            <Button
              title="First record"
              aria-label="First record"
              disabled={!visibleRows.length || activeVisiblePos <= 0}
              onClick={() => goToVisibleRow(0)}
            >
              <ChevronsLeft size={13} />
            </Button>
            <Button
              title="Previous record"
              aria-label="Previous record"
              disabled={!visibleRows.length || activeVisiblePos <= 0}
              onClick={() => goToVisibleRow(activeVisiblePos - 1)}
            >
              <ChevronLeft size={13} />
            </Button>
            <span className="result-record-indicator" aria-live="polite">
              {visibleRows.length
                ? `${activeVisiblePos >= 0 ? activeVisiblePos + 1 : 1} / ${visibleRows.length}`
                : "0 / 0"}
              {hasActiveRange && normalizedRange
                ? ` · ${normalizedRange.rowCount}×${normalizedRange.colCount} selected`
                : selected.size > 1
                  ? ` · ${selected.size} selected`
                  : ""}
            </span>
            <Button
              title="Next record"
              aria-label="Next record"
              disabled={
                !visibleRows.length || activeVisiblePos + 1 >= visibleRows.length
              }
              onClick={() => goToVisibleRow(activeVisiblePos + 1)}
            >
              <ChevronRight size={13} />
            </Button>
            <Button
              title="Last record"
              aria-label="Last record"
              disabled={
                !visibleRows.length || activeVisiblePos + 1 >= visibleRows.length
              }
              onClick={() => goToVisibleRow(visibleRows.length - 1)}
            >
              <ChevronsRight size={13} />
            </Button>
          </div>

          <div className="divider" />

          {editable ? (
            <div className="row result-edit-group">
              <Button
                data-icon-only="true"
                className="is-active"
                title={
                  dirty
                    ? "Apply or discard changes before locking"
                    : `Editing unlocked (${table?.name}) · Click to lock`
                }
                aria-label="Lock editing"
                disabled={dirty || saving}
                onClick={() => setIsUnlocked(false)}
              >
                <LockOpen size={12} />
              </Button>
              <Button
                title="Add record"
                aria-label="Add record"
                disabled={disabled || saving || requiresRefresh}
                onClick={addRow}
              >
                <Plus size={13} />
              </Button>
              <Button
                title="Delete selected record(s)"
                aria-label="Delete record"
                disabled={
                  disabled ||
                  saving ||
                  requiresRefresh ||
                  (!selected.size && !activeDraft)
                }
                onClick={deleteTargetRows}
              >
                <Trash2 size={13} />
              </Button>
              <Button
                title="Set active cell or selected range to NULL (Alt+Backspace)"
                disabled={
                  !hasActiveRange &&
                  (!canEditCell(clampedActiveRow, active.col) ||
                    (activeColDef ? !activeColDef.nullable : false))
                }
                onClick={() => setNullTargetCells(clampedActiveRow, active.col)}
              >
                NULL
              </Button>
              <Button
                className={dirty ? "primary" : undefined}
                title="Apply changes (⌘S)"
                aria-label="Apply changes"
                disabled={disabled || saving || !dirty || requiresRefresh}
                onClick={() => void saveChanges()}
              >
                {saving ? <span className="spinner" /> : <Check size={13} />}
                <span>Apply</span>
                {dirty && <span className="button-count">{changes.length}</span>}
              </Button>
              <Button
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
              title={`Locked (${table?.name}) · Click to unlock inline editing`}
              aria-label="Unlock editing"
              disabled={disabled || saving}
              onClick={() => setIsUnlocked(true)}
            >
              <Lock size={12} />
            </Button>
          ) : (
            <span
              className="result-readonly-pill"
              aria-label="Read-only result"
              title="Read-only · Run SELECT * FROM <table> on a single table with a primary key to edit rows inline"
            >
              <Lock size={12} />
            </span>
          )}

          <div className="divider" />

          <div className="row result-copy-group">
            <Button
              title={
                isJoin
                  ? "Copy as INSERT is disabled for JOIN query results"
                  : `Copy ${scopeDescription} as INSERT statement`
              }
              disabled={!targetCopyCount || isJoin}
              onClick={() => void handleCopyAsInsert(false)}
            >
              <FileCode2 size={13} />
              <span>
                Copy as INSERT
                {scopeBadge && !isJoin ? ` (${scopeBadge})` : ""}
              </span>
            </Button>
            <Button
              title={
                isJoin
                  ? "Copy as UPDATE is disabled for JOIN query results"
                  : `Copy ${scopeDescription} as UPDATE statement`
              }
              disabled={!targetCopyCount || isJoin}
              onClick={() => void handleCopyAsUpdate(false)}
            >
              <Copy size={13} />
              <span>
                Copy as UPDATE
                {scopeBadge && !isJoin ? ` (${scopeBadge})` : ""}
              </span>
            </Button>
            <div className="result-copy-dropdown">
              <Button
                title="More copy formats"
                aria-label="More copy formats"
                aria-expanded={copyMenuOpen}
                disabled={!drafts.length}
                onClick={() => setCopyMenuOpen((open) => !open)}
              >
                <ChevronDown size={12} />
              </Button>
              {copyMenuOpen && (
                <div className="result-floating-menu" role="menu">
                  <div className="result-menu-label">{scopeDescription}</div>
                  {hasActiveRange && (
                    <button
                      role="menuitem"
                      onClick={() => void handleCopyAsTsv(false, false)}
                    >
                      Copy Selected Cells ({scopeBadge})
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => void handleCopyWithHeader(false)}
                  >
                    Copy with Header{scopeBadge ? ` (${scopeBadge})` : ""}
                  </button>
                  {!isJoin && (
                    <>
                      <button
                        role="menuitem"
                        onClick={() => void handleCopyAsInsert(false)}
                      >
                        Copy as INSERT{scopeBadge ? ` (${scopeBadge})` : ""}
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => void handleCopyAsUpdate(false)}
                      >
                        Copy as UPDATE{scopeBadge ? ` (${scopeBadge})` : ""}
                      </button>
                    </>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => void handleCopyAsCsv(false, true)}
                  >
                    Copy as CSV{scopeBadge ? ` (${scopeBadge})` : ""}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => void handleCopyAsTsv(false, false)}
                  >
                    Copy as TSV (Tab-separated)
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => void handleCopyAsJson(false)}
                  >
                    Copy as JSON{scopeBadge ? ` (${scopeBadge})` : ""}
                  </button>
                  {visibleRows.length > 1 && (
                    <>
                      <hr />
                      <div className="result-menu-label">
                        All {visibleRows.length} rows
                      </div>
                      <button
                        role="menuitem"
                        onClick={() => void handleCopyWithHeader(true)}
                      >
                        Copy All with Header ({visibleRows.length})
                      </button>
                      {!isJoin && (
                        <>
                          <button
                            role="menuitem"
                            onClick={() => void handleCopyAsInsert(true)}
                          >
                            Copy All as INSERT ({visibleRows.length})
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => void handleCopyAsUpdate(true)}
                          >
                            Copy All as UPDATE ({visibleRows.length})
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="result-bar-spacer" />

          {dirty ? (
            <span className="result-status-summary">
              <span className="status-dot amber" />
              {[
                addedCount ? `${addedCount} new` : null,
                editedCount ? `${editedCount} edited` : null,
                deletedCount ? `${deletedCount} deleted` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : notice ? (
            <span className="result-status-summary is-notice" role="status">
              <Check size={12} />
              {notice}
            </span>
          ) : null}

          <RowFilter active={!!filter}>
            <input
              aria-label="Filter result rows"
              placeholder="Filter rows…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                className="filter-clear"
                aria-label="Clear row filter"
                onClick={() => setFilter("")}
              >
                <X size={11} />
              </button>
            )}
          </RowFilter>
        </div>
      )}

      {contextMenu &&
        createPortal(
          <div
            className="result-context-menu result-floating-menu"
            role="menu"
            aria-label="Row actions"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="result-menu-label">{scopeDescription}</div>
            {hasActiveRange ? (
              <button
                role="menuitem"
                onClick={() => void handleCopyAsTsv(false, false)}
              >
                Copy Selected Cells ({scopeBadge})
              </button>
            ) : (
              <button
                role="menuitem"
                onClick={() =>
                  void handleCopyCellValue(
                    contextMenu.rowIndex,
                    contextMenu.colIndex,
                  )
                }
              >
                Copy Cell Value
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => void handleCopyWithHeader(false)}
            >
              Copy with Header{scopeBadge ? ` (${scopeBadge})` : ""}
            </button>
            {visibleRows.length > 1 && (
              <button
                role="menuitem"
                onClick={() => void handleCopyWithHeader(true)}
              >
                Copy All with Header ({visibleRows.length})
              </button>
            )}
            {!isJoin && (
              <>
                <hr />
                <button
                  role="menuitem"
                  onClick={() => void handleCopyAsInsert(false)}
                >
                  Copy as INSERT{scopeBadge ? ` (${scopeBadge})` : ""}
                </button>
                <button
                  role="menuitem"
                  onClick={() => void handleCopyAsUpdate(false)}
                >
                  Copy as UPDATE{scopeBadge ? ` (${scopeBadge})` : ""}
                </button>
              </>
            )}
            <hr />
            <button
              role="menuitem"
              onClick={() => void handleCopyAsCsv(false, true)}
            >
              Copy {hasActiveRange ? `Selection (${scopeBadge})` : `Row${selected.size > 1 ? "s" : ""}`} as CSV
            </button>
            <button
              role="menuitem"
              onClick={() => void handleCopyAsTsv(false, false)}
            >
              Copy {hasActiveRange ? `Selection (${scopeBadge})` : `Row${selected.size > 1 ? "s" : ""}`} as TSV
            </button>
            <button
              role="menuitem"
              onClick={() => void handleCopyAsJson(false)}
            >
              Copy {hasActiveRange ? `Selection (${scopeBadge})` : `Row${selected.size > 1 ? "s" : ""}`} as JSON
            </button>
            {editable && (
              <>
                <hr />
                <button
                  role="menuitem"
                  disabled={
                    !hasActiveRange &&
                    (!canEditCell(contextMenu.rowIndex, contextMenu.colIndex) ||
                      columnMap.get(columns[contextMenu.colIndex])?.nullable ===
                        false)
                  }
                  onClick={() => {
                    setNullTargetCells(
                      contextMenu.rowIndex,
                      contextMenu.colIndex,
                    );
                    setContextMenu(null);
                  }}
                >
                  Set NULL{scopeBadge ? ` (${scopeBadge})` : ""}
                </button>
                <button
                  role="menuitem"
                  disabled={disabled || saving || requiresRefresh}
                  onClick={() => {
                    addRow();
                    setContextMenu(null);
                  }}
                >
                  Add Record
                </button>
                <button
                  role="menuitem"
                  className="danger-item"
                  disabled={disabled || saving || requiresRefresh}
                  onClick={() => {
                    deleteTargetRows();
                    setContextMenu(null);
                  }}
                >
                  Delete Record
                  {hasActiveRange && normalizedRange
                    ? normalizedRange.rowCount > 1
                      ? `s (${normalizedRange.rowCount})`
                      : ""
                    : selected.size > 1
                      ? `s (${selected.size})`
                      : ""}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
});
