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
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { duckCellHint } from "../../lib/duckdb/values";
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
  buildCopyAsInsert,
  buildCopyAsTsv,
  buildCopyAsUpdate,
  inferResultTableTarget,
} from "./result-sql-copy";

const ROW_HEIGHT = 29;
const COMPACT_ROW_HEIGHT = 25;
const ROW_OVERSCAN = 10;
const VIRTUALIZE_THRESHOLD = 40;

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
  onCellClick: (
    event: ReactMouseEvent,
    rowId: string,
    visiblePos: number,
    rowIndex: number,
    colIndex: number,
  ) => void;
  onContextMenu: (
    event: ReactMouseEvent,
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
  activeCol,
  editable,
  compact,
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
  activeCol: number;
  editable: boolean;
  compact: boolean;
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
    isRowActive ? "row-active" : "",
    row.deleted ? "row-deleted" : "",
    !row.original ? "row-new" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr
      className={rowClass || undefined}
      onContextMenu={(e) =>
        handlers.current.onContextMenu(e, r, Math.max(0, activeCol))
      }
    >
      <td
        className="result-row-gutter muted"
        onClick={(e) => {
          if ((e.target as HTMLElement).tagName === "INPUT") return;
          if (e.shiftKey || e.metaKey || e.ctrlKey || compact) {
            e.preventDefault();
            handlers.current.onGutterClick(e, row.id, visiblePos, r);
          }
        }}
      >
        {compact ? (
          <span>{r + 1}</span>
        ) : (
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
        )}
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

        return (
          <td
            key={c}
            className={[
              edited ? "cell-changed" : "",
              isNull ? "cell-null" : "",
              activeCol === colIdx ? "cell-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={isNull ? "NULL" : (val ?? "")}
            onClick={(e) =>
              handlers.current.onCellClick(e, row.id, visiblePos, r, colIdx)
            }
            onContextMenu={(e) =>
              handlers.current.onContextMenu(e, r, colIdx)
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

export function ResultSetView({
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
  const metadataTable = table ?? inferredTarget.table;
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

  const dirty = drafts.some(isChanged);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const changes = useMemo(() => drafts.filter(isChanged), [drafts]);
  const addedCount = changes.filter((r) => !r.original && !r.deleted).length;
  const editedCount = changes.filter((r) => r.original && !r.deleted).length;
  const deletedCount = changes.filter((r) => r.original && r.deleted).length;

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
      setRequiresRefresh(false);
      setIsUnlocked(false);
    }
  }, [result.rows]);

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
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
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

  const [rowViewport, setRowViewport] = useState({
    top: initialPos?.top ?? 0,
    height: 360,
  });

  useLayoutEffect(() => {
    const element = viewport.ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = element.scrollTop;
      const height = element.clientHeight || 360;
      setRowViewport((old) =>
        Math.abs(old.top - top) < 12 && Math.abs(old.height - height) < 8
          ? old
          : { top, height },
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
  }, [ columns.length ]);

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
              ? duckCellHint(column.nativeType ?? column.type)
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

  const shouldVirtualizeRows = visibleRows.length > VIRTUALIZE_THRESHOLD;
  const rowStart = shouldVirtualizeRows
    ? Math.max(0, Math.floor(rowViewport.top / rowHeight) - ROW_OVERSCAN)
    : 0;
  const rowEnd = shouldVirtualizeRows
    ? Math.min(
        visibleRows.length,
        Math.ceil(
          (rowViewport.top + Math.max(rowViewport.height, 220)) / rowHeight,
        ) + ROW_OVERSCAN,
      )
    : visibleRows.length;
  const windowedRows = useMemo(
    () =>
      shouldVirtualizeRows
        ? visibleRows.slice(rowStart, rowEnd)
        : visibleRows,
    [shouldVirtualizeRows, visibleRows, rowStart, rowEnd],
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
      selected.size > 0
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
    setError("");
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

  function resolveCopyRows(allRows = false): DraftRow[] {
    if (allRows) {
      return visibleRows.map(({ row }) => row).filter((r) => !r.deleted);
    }
    if (selected.size > 0) {
      const chosen = drafts.filter((r) => selected.has(r.id) && !r.deleted);
      if (chosen.length > 0) return chosen;
    }
    if (activeDraft && !activeDraft.deleted) {
      return [activeDraft];
    }
    return [];
  }

  async function handleCopyAsInsert(allRows = false) {
    const targetDrafts = resolveCopyRows(allRows);
    if (!targetDrafts.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, columns));
    const sqlText = buildCopyAsInsert({
      columns,
      rows,
      sql: result.sql,
      schema,
      table: metadataTable,
      dialect,
    });
    await copyTextToClipboard(sqlText);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as INSERT`,
    );
  }

  async function handleCopyAsUpdate(allRows = false) {
    const targetDrafts = resolveCopyRows(allRows);
    if (!targetDrafts.length) return;
    const rows = targetDrafts.map((d) => ({
      current: effectiveRowValues(d, columns),
      original: d.original,
    }));
    const sqlText = buildCopyAsUpdate({
      columns,
      rows,
      sql: result.sql,
      schema,
      table: metadataTable,
      dialect,
    });
    await copyTextToClipboard(sqlText);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as UPDATE`,
    );
  }

  async function handleCopyAsTsv(allRows = false) {
    const targetDrafts = resolveCopyRows(allRows);
    if (!targetDrafts.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, columns));
    const tsv = buildCopyAsTsv(columns, rows, true);
    await copyTextToClipboard(tsv);
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as TSV`,
    );
  }

  async function handleCopyAsJson(allRows = false) {
    const targetDrafts = resolveCopyRows(allRows);
    if (!targetDrafts.length) return;
    const rows = targetDrafts.map((d) => effectiveRowValues(d, columns));
    await copyTextToClipboard(JSON.stringify(rows, null, 2));
    setCopyMenuOpen(false);
    setContextMenu(null);
    setNotice(
      `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as JSON`,
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
    setActive((prev) =>
      prev.row === rowIndex ? prev : { row: rowIndex, col: prev.col },
    );
    if (event.shiftKey && lastClickedRowRef.current !== null) {
      const start = Math.min(lastClickedRowRef.current, visiblePos);
      const end = Math.max(lastClickedRowRef.current, visiblePos);
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

  function openRowContextMenu(
    event: ReactMouseEvent,
    rowIndex: number,
    colIndex: number,
  ) {
    event.preventDefault();
    const row = drafts[rowIndex];
    if (!row) return;
    setActive({ row: rowIndex, col: Math.max(0, colIndex) });
    if (!selected.has(row.id)) {
      setSelected(new Set([row.id]));
    }
    const menuWidth = 220;
    const menuHeight = editable ? 260 : 195;
    const x = Math.min(
      event.clientX,
      Math.max(8, window.innerWidth - menuWidth - 8),
    );
    const y = Math.min(
      event.clientY,
      Math.max(8, window.innerHeight - menuHeight - 8),
    );
    setContextMenu({ x, y, rowIndex, colIndex: Math.max(0, colIndex) });
  }

  const rowHandlersRef = useRef<ResultRowHandlers>({
    onGutterClick: handleRowSelectClick,
    onCheckboxChange: () => {},
    onCellClick: () => {},
    onContextMenu: openRowContextMenu,
    onCellFocus: () => {},
    onCellChange: updateCell,
    onCellKeyDown: handleCellKey,
    onCellPaste: handlePaste,
    canEditCell,
  });

  rowHandlersRef.current = {
    onGutterClick: handleRowSelectClick,
    onCheckboxChange: (checked, rowId, visiblePos) => {
      lastClickedRowRef.current = visiblePos;
      setSelected((prev) => {
        const next = new Set(prev);
        if (checked) next.add(rowId);
        else next.delete(rowId);
        return next;
      });
    },
    onCellClick: (event, rowId, visiblePos, rowIndex, colIndex) => {
      setActive((old) =>
        old.row === rowIndex && old.col === colIndex
          ? old
          : { row: rowIndex, col: colIndex },
      );
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        handleRowSelectClick(event, rowId, visiblePos, rowIndex);
      }
    },
    onContextMenu: openRowContextMenu,
    onCellFocus: (rowIndex, colIndex) =>
      setActive((old) =>
        old.row === rowIndex && old.col === colIndex
          ? old
          : { row: rowIndex, col: colIndex },
      ),
    onCellChange: updateCell,
    onCellKeyDown: handleCellKey,
    onCellPaste: handlePaste,
    canEditCell,
  };

  // Record navigation in visible rows
  const activeVisiblePos = visibleRows.findIndex(
    ({ index }) => index === clampedActiveRow,
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
    selected.size > 0 ? selected.size : drafts.length > 0 ? 1 : 0;

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
              {drafts.length} row{drafts.length === 1 ? "" : "s"}
            </span>
          </button>

          <div className="stack-header-spacer" />

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
            (compact ? " is-compact" : "")
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
                onClick={
                  compact
                    ? () =>
                        setSelected((prev) =>
                          prev.size === visibleRows.length
                            ? new Set()
                            : new Set(visibleRows.map(({ row }) => row.id)),
                        )
                    : undefined
                }
              >
                {compact ? (
                  <span>#</span>
                ) : (
                  <label>
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      title="Select all rows"
                      checked={
                        visibleRows.length > 0 &&
                        visibleRows.every(({ row }) => selected.has(row.id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? new Set(visibleRows.map(({ row }) => row.id))
                            : new Set(),
                        )
                      }
                    />
                    <span>#</span>
                  </label>
                )}
              </th>
              {viewport.start > 0 && (
                <th
                  className="column-spacer"
                  colSpan={viewport.start}
                  aria-hidden="true"
                />
              )}
              {visibleColumns.map(({ name, index, column }) => (
                <th
                  key={name}
                  title={
                    column
                      ? `${name} · ${column.nativeType ?? column.type}`
                      : name
                  }
                  className={active.col === index ? "column-active" : ""}
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
                            .map((row) => effectiveRowValues(row, columns)[name]),
                        ),
                      )
                    }
                  />
                </th>
              ))}
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
            {rowStart > 0 && (
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
              return (
                <ResultTableRow
                  key={row.id}
                  row={row}
                  rowIndex={r}
                  visiblePos={visiblePos}
                  isRowSelected={selected.has(row.id)}
                  activeCol={clampedActiveRow === r ? active.col : -1}
                  editable={editable}
                  compact={compact}
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
            {rowEnd < visibleRows.length && (
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
            {selected.size > 1 ? ` · ${selected.size} selected` : ""}
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
              title="Set active cell to NULL (Alt+Backspace)"
              disabled={
                !canEditCell(clampedActiveRow, active.col) ||
                (activeColDef ? !activeColDef.nullable : false)
              }
              onClick={() => updateCell(clampedActiveRow, active.col, null)}
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
            title={`Copy ${selected.size > 0 ? `${selected.size} selected row(s)` : "current row"} as INSERT statement`}
            disabled={!targetCopyCount}
            onClick={() => void handleCopyAsInsert(false)}
          >
            <FileCode2 size={13} />
            <span>
              Copy as INSERT
              {selected.size > 1 ? ` (${selected.size})` : ""}
            </span>
          </Button>
          <Button
            title={`Copy ${selected.size > 0 ? `${selected.size} selected row(s)` : "current row"} as UPDATE statement`}
            disabled={!targetCopyCount}
            onClick={() => void handleCopyAsUpdate(false)}
          >
            <Copy size={13} />
            <span>
              Copy as UPDATE
              {selected.size > 1 ? ` (${selected.size})` : ""}
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
                <div className="result-menu-label">
                  {selected.size > 0
                    ? `${selected.size} selected row${selected.size === 1 ? "" : "s"}`
                    : `Row #${clampedActiveRow + 1}`}
                </div>
                <button
                  role="menuitem"
                  onClick={() => void handleCopyAsInsert(false)}
                >
                  Copy as INSERT
                </button>
                <button
                  role="menuitem"
                  onClick={() => void handleCopyAsUpdate(false)}
                >
                  Copy as UPDATE
                </button>
                <button
                  role="menuitem"
                  onClick={() => void handleCopyAsTsv(false)}
                >
                  Copy as TSV (Tab-separated)
                </button>
                <button
                  role="menuitem"
                  onClick={() => void handleCopyAsJson(false)}
                >
                  Copy as JSON
                </button>
                {visibleRows.length > 1 && (
                  <>
                    <hr />
                    <div className="result-menu-label">
                      All {visibleRows.length} rows
                    </div>
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

        <div className="sheet-search result-row-filter">
          <Search size={12} />
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
        </div>
      </div>
      )}

      {contextMenu && (
        <div
          className="result-context-menu result-floating-menu"
          role="menu"
          aria-label="Row actions"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="result-menu-label">
            {selected.size > 1
              ? `${selected.size} selected rows`
              : `Row #${contextMenu.rowIndex + 1} · ${columns[contextMenu.colIndex] ?? ""}`}
          </div>
          <button
            role="menuitem"
            onClick={() => void handleCopyAsInsert(false)}
          >
            Copy as INSERT
            {selected.size > 1 ? ` (${selected.size} rows)` : ""}
          </button>
          <button
            role="menuitem"
            onClick={() => void handleCopyAsUpdate(false)}
          >
            Copy as UPDATE
            {selected.size > 1 ? ` (${selected.size} rows)` : ""}
          </button>
          <hr />
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
          <button role="menuitem" onClick={() => void handleCopyAsTsv(false)}>
            Copy Row{selected.size > 1 ? "s" : ""} as TSV
          </button>
          <button role="menuitem" onClick={() => void handleCopyAsJson(false)}>
            Copy Row{selected.size > 1 ? "s" : ""} as JSON
          </button>
          {editable && (
            <>
              <hr />
              <button
                role="menuitem"
                disabled={
                  !canEditCell(contextMenu.rowIndex, contextMenu.colIndex) ||
                  columnMap.get(columns[contextMenu.colIndex])?.nullable ===
                    false
                }
                onClick={() => {
                  updateCell(contextMenu.rowIndex, contextMenu.colIndex, null);
                  setContextMenu(null);
                }}
              >
                Set NULL
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
                Delete Record{selected.size > 1 ? "s" : ""}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
