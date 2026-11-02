import {
  ColumnResizeHandle,
  fitColumnWidth,
  useColumnWidths,
  useColumnWindow,
} from "./column-sizing";
import { duckCellHint } from "../../lib/duckdb/values";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type RefObject,
} from "react";
import {
  Check,
  ChevronDown,
  KeyRound,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import type { ColumnDefinition, TableDefinition } from "../../types/schema";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import {
  cellText,
  columnLetter,
  isChanged,
  makeDraft,
  parseClipboard,
  pasteCells,
  type CellValue,
  type DraftRow,
} from "./model";
const PAGE_SIZE = 100;
const initialDrafts = (rows: Record<string, unknown>[]) => [
  ...rows.map((row) => makeDraft(row)),
  ...Array.from({ length: Math.max(1, 12 - rows.length) }, () => makeDraft()),
];
const valueAt = (row: DraftRow, name: string): CellValue =>
  Object.hasOwn(row.cells, name)
    ? row.cells[name]
    : row.original?.[name] === null
      ? null
      : row.original && Object.hasOwn(row.original, name)
        ? cellText(row.original[name])
        : undefined;
interface Props {
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
}
export function Spreadsheet({
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
}: Props) {
  const [drafts, setDrafts] = useState<DraftRow[]>(() => initialDrafts(rows));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
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
          rows.map((row) => row[column.name]),
          280,
        ),
      ),
    [table.columns, rows],
  );
  const cellHints = useMemo(
    () =>
      table.columns.map((column) =>
        duckCellHint(column.nativeType ?? column.type),
      ),
    [table.columns],
  );
  const widths = table.columns.map((column, index) =>
    sizing.width(column.id, defaultWidths[index]),
  );
  const columnViewport = useColumnWindow(widths);
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
            40 +
            widths.slice(0, focus.col).reduce((sum, width) => sum + width, 0);
          viewport.scrollLeft = Math.max(0, left - 40);
        }
        return;
      }
      input.focus();
      input.select();
      setFocus(null);
    }
  }, [focus, drafts, columnViewport.start, columnViewport.end]);
  function update(row: number, col: number, value: CellValue) {
    const column = table.columns[col];
    if (
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
    setDrafts((current) => {
      const next = current.map((r, i) =>
        i === row
          ? { ...r, cells: { ...r.cells, [table.columns[col].name]: value } }
          : r,
      );
      if (row === next.length - 1) next.push(makeDraft());
      return next;
    });
  }
  function addRow() {
    const firstBlank = drafts.findIndex(
      (row) => !row.original && !isChanged(row),
    );
    const row = firstBlank < 0 ? drafts.length : firstBlank;
    if (firstBlank < 0) setDrafts((current) => [...current, makeDraft()]);
    setFilter("");
    if (serverPage)
      setDrafts((current) =>
        current.map((item, index) =>
          index === row ? { ...item, insert: true } : item,
        ),
      );
    const column = table.columns.findIndex((c) => !c.generated && !c.readOnly);
    setFocus({ row, col: Math.max(0, column) });
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
    if (row < 0) return;
    if (row >= drafts.length) setDrafts((current) => [...current, makeDraft()]);
    const target = drafts[row];
    if (target?.original) {
      const position = matchingSaved.findIndex(
        ({ row: item }) => item.id === target.id,
      );
      if (position >= 0) setPage(Math.floor(position / PAGE_SIZE));
    }
    setFocus({ row: Math.min(row, drafts.length), col });
  }
  function handleKey(e: KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void save();
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
  function deleteSelected() {
    if (!selected.size) return;
    setDrafts((current) => {
      const next = current.flatMap((row) =>
        !selected.has(row.id)
          ? [row]
          : row.original
            ? [{ ...row, deleted: !row.deleted }]
            : [],
      );
      if (!next.length || next.at(-1)?.original || isChanged(next.at(-1)!))
        next.push(makeDraft());
      return next;
    });
    setSelected(new Set());
    setError("");
  }
  const matching = drafts
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !filter ||
        Object.keys(row.cells).length > 0 ||
        !row.original ||
        table.columns.some((c) =>
          cellText(row.original?.[c.name])
            .toLowerCase()
            .includes(filter.toLowerCase()),
        ),
    );
  const matchingSaved = matching.filter(({ row }) => !!row.original);
  const pageCount = Math.max(1, Math.ceil(matchingSaved.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const displayedSaved = new Set(
    matchingSaved
      .slice(pageStart, pageStart + PAGE_SIZE)
      .map(({ row }) => row.id),
  );
  const visible = matching.filter(
    ({ row }) =>
      (!readOnlyReason || !!row.original) &&
      (!row.original || displayedSaved.has(row.id)),
  );
  function changePage(next: number) {
    setPage(next);
    const first = matchingSaved[next * PAGE_SIZE];
    if (first) setActive({ row: first.index, col: 0 });
    root.current?.querySelector(".sheet-grid-scroll")?.scrollTo({ top: 0 });
  }
  function paste(
    event: ClipboardEvent<HTMLInputElement>,
    row: number,
    column: number,
  ) {
    if (disabled || saving || readOnlyReason || requiresRefresh) {
      event.preventDefault();
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!/[\t\r\n]/.test(text)) return;
    event.preventDefault();
    try {
      setDrafts((current) =>
        pasteCells(current, table, row, column, parseClipboard(text)),
      );
      setError("");
      setNotice("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  const cellHandlers = useRef<CellHandlers>({
    update,
    handleKey,
    paste,
    focus: () => {},
    select: () => {},
  });
  cellHandlers.current = {
    select: (id, checked) =>
      setSelected((current) => {
        const next = new Set(current);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      }),
    update,
    handleKey,
    paste,
    focus: (row, col) =>
      setActive((old) =>
        old.row === row && old.col === col ? old : { row, col },
      ),
  };
  const selectedRow = drafts[active.row];
  const activeColumn = table.columns[active.col];
  return (
    <div className="spreadsheet" ref={root}>
      <div className="sheet-toolbar">
        <div className="row">
          <Button disabled={disabled || saving} onClick={addRow}>
            <Plus size={15} />
            Add row
          </Button>
          {onAddColumn && (
            <Button
              data-add-column
              disabled={structureDisabled || saving}
              onClick={(event) => onAddColumn(event.currentTarget)}
            >
              <Plus size={15} />
              Add column
            </Button>
          )}
          <Button
            title="Delete selected rows"
            disabled={
              disabled ||
              saving ||
              !selected.size ||
              (!table.primaryKey.length &&
                drafts.some((r) => selected.has(r.id) && r.original))
            }
            onClick={deleteSelected}
          >
            <Trash2 size={15} />
            <span>
              {selected.size ? `Delete (${selected.size})` : "Delete"}
            </span>
          </Button>
          <div className="divider" />
          <Button
            disabled={
              disabled ||
              saving ||
              !selectedRow ||
              selectedRow.deleted ||
              (!table.primaryKey.length && !!selectedRow.original) ||
              !!activeColumn?.generated ||
              !!activeColumn?.readOnly
            }
            onClick={() => update(active.row, active.col, null)}
          >
            Set NULL
          </Button>
        </div>
        <div className="row">
          <div className="sheet-search">
            <Search size={14} />
            <input
              aria-label={serverPage ? "Filter loaded rows" : "Filter rows"}
              placeholder={serverPage ? "Filter this page" : "Filter rows"}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <Button
            title="Discard draft changes"
            disabled={!dirty || saving}
            onClick={async () => {
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
            }}
          >
            <RotateCcw size={14} />
          </Button>
          <Button
            className="primary"
            disabled={disabled || saving || !dirty || requiresRefresh}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" /> : <Check size={15} />}Save
            changes
            {dirty && <span className="button-count">{changes.length}</span>}
          </Button>
        </div>
      </div>
      <div className="formula-bar">
        <span className="cell-address">
          {columnLetter(active.col)}
          {active.row + 1}
          <ChevronDown size={10} />
        </span>
        <span className="formula-fx">ƒx</span>
        <span className="formula-value">
          {selectedRow && activeColumn ? (
            valueAt(selectedRow, activeColumn.name) === null ? (
              <em>NULL</em>
            ) : (
              (valueAt(selectedRow, activeColumn.name) ?? (
                <span className="muted">Enter a value…</span>
              ))
            )
          ) : (
            ""
          )}
        </span>
        <span className="formula-type">
          {activeColumn?.nativeType ?? activeColumn?.type.toLowerCase()}
        </span>
      </div>
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
      <div className="sheet-grid-scroll" ref={columnViewport.ref}>
        <table
          className="sheet-grid"
          aria-label={`${table.name} data grid`}
          style={{ width: 40 + widths.reduce((sum, width) => sum + width, 0) }}
        >
          <colgroup>
            <col style={{ width: 40 }} />
            {table.columns.map((column, index) => (
              <col key={column.id} style={{ width: widths[index] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="row-gutter">
                <input
                  type="checkbox"
                  aria-label="Select visible rows"
                  checked={
                    visible.some(({ row }) => !!row.original) &&
                    visible
                      .filter(({ row }) => row.original)
                      .every(({ row }) => selected.has(row.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Set(
                            visible
                              .filter(
                                ({ row }) => row.original || isChanged(row),
                              )
                              .map(({ row }) => row.id),
                          )
                        : new Set(),
                    )
                  }
                />
              </th>
              {columnViewport.start > 0 && (
                <th
                  className="column-spacer"
                  colSpan={columnViewport.start}
                  aria-hidden="true"
                />
              )}
              {visibleColumns.map(({ column: c, index: i }) => (
                <th
                  key={c.id}
                  className={active.col === i ? "column-active" : ""}
                >
                  <button
                    className="column-header-trigger"
                    title={
                      structureDisabled
                        ? `${c.name} · ${c.nativeType ?? c.type}`
                        : `Double-click to edit column ${c.name}`
                    }
                    disabled={structureDisabled || saving}
                    data-column-id={c.id}
                    onDoubleClick={(event) =>
                      onEditColumn?.(c.id, event.currentTarget)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onEditColumn?.(c.id, event.currentTarget);
                      }
                    }}
                  >
                    <span className="column-letter">{columnLetter(i)}</span>
                    <div className="sheet-column-name">
                      {table.primaryKey.includes(c.id) ? (
                        <KeyRound size={12} />
                      ) : (
                        <span className="column-type-icon">
                          {c.type === "VARCHAR"
                            ? "Aa"
                            : c.type === "BOOLEAN"
                              ? "◐"
                              : "#"}
                        </span>
                      )}
                      <span className="column-name-label">{c.name}</span>
                      {!structureDisabled && <ChevronDown size={11} />}
                    </div>
                    <span className="sheet-column-type">
                      {c.nativeType ?? c.type.toLowerCase()}
                      {c.generated
                        ? " · generated"
                        : c.readOnly
                          ? " · read only"
                          : table.primaryKey.includes(c.id)
                            ? " · primary key"
                            : c.nullable
                              ? " · nullable"
                              : " · required"}
                    </span>
                  </button>
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
                          drafts.map((row) => valueAt(row, c.name)),
                        ),
                      )
                    }
                  />
                </th>
              ))}
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
                cellHints={cellHints}
                handlers={cellHandlers}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="sheet-status">
        <span className="row">
          {dirty ? (
            <>
              <span className="status-dot amber" />
              {[
                added ? `${added} new` : null,
                changed ? `${changed} edited` : null,
                removed ? `${removed} deleted` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              <span className="muted">Unsaved</span>
            </>
          ) : (
            <>
              <Check size={13} />
              {notice || "All changes saved"}
            </>
          )}
        </span>
        {serverPage ? (
          <span>
            {rows.length ? serverPage.index * PAGE_SIZE + 1 : 0}–
            {serverPage.index * PAGE_SIZE + rows.length} rows
            <Button
              aria-label="Previous page"
              disabled={saving || !serverPage.index}
              onClick={() => serverPage.onChange(serverPage.index - 1)}
            >
              Previous
            </Button>
            <span aria-live="polite">Page {serverPage.index + 1}</span>
            <Button
              aria-label="Next page"
              disabled={saving || !serverPage.hasNext}
              onClick={() => serverPage.onChange(serverPage.index + 1)}
            >
              Next
            </Button>
            <span className="status-separator">·</span>
            {table.columns.length} columns
          </span>
        ) : (
          <span>
            {matchingSaved.length ? pageStart + 1 : 0}–
            {Math.min(pageStart + PAGE_SIZE, matchingSaved.length)} /{" "}
            {matchingSaved.length} rows
            <Button
              aria-label="Previous page"
              disabled={disabled || saving || currentPage === 0}
              onClick={() => changePage(currentPage - 1)}
            >
              Previous
            </Button>
            <span aria-live="polite">
              Page {currentPage + 1} of {pageCount}
            </span>
            <Button
              aria-label="Next page"
              disabled={disabled || saving || currentPage + 1 >= pageCount}
              onClick={() => changePage(currentPage + 1)}
            >
              Next
            </Button>
            <span className="status-separator">·</span>
            {table.columns.length} columns
          </span>
        )}
      </div>
    </div>
  );
}

interface CellHandlers {
  select: (id: string, checked: boolean) => void;
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
}
// A keystroke updates one cell, rather than re-rendering every visible input.
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
      <th className="row-gutter">
        <label>
          <input
            type="checkbox"
            aria-label={`Select row ${r + 1}`}
            checked={selected}
            onChange={(e) => handlers.current.select(row.id, e.target.checked)}
          />
          <span>{r + 1 + (row.original ? pageIndex * PAGE_SIZE : 0)}</span>
          {!row.original && <Plus size={11} />}
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
