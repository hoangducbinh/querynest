# Database Design Playground

A local database design and data workspace built with React, TypeScript, Vite, React Flow, Monaco, DuckDB-Wasm, Zustand/Immer and Dexie. No backend, account or AI service. Workers and Wasm are bundled locally.

## Start

```sh
npm install
npm run dev
```

Open the Vite URL. The workspace restores automatically, including its local DuckDB runtime. The initial commerce workspace includes customers, orders and order_items.

## The workspace

The compact interface uses a single 48px toolbar and three top-level tabs: **Data**, **SQL** and **Tests**. **Relations** is available directly above **TABLES** in the sidebar. Decorative headers, breadcrumbs, global footers, explanatory banners and duplicate table tabs have been removed. Dark appearance and the workspace menu remain in the top toolbar. Appearance is saved locally for this browser and restored on reload. Dialogs and popovers share the same theme; text inputs use a thin focus border.

**SQL** opens by default and keeps the shared table sidebar visible and shows the selected table's columns, data types and PK/FK indicators for reference while writing queries. Column rows are read-only in SQL. The editor uses 70% of the remaining height and fills the available width. Drag the separator to resize the editor/results split; the separator also supports arrow keys and Home/End. Use the results toggle to give the editor all available height. The top-left button toggles the shared sidebar consistently across views.

**Create table / Edit table** opens a staged structure editor. Set the table name, then edit columns in a single grid: name, type, primary key, not-null, unique and default. Add a column with the button or Enter in the final column name. The arrows on the row number reorder columns. Primary key numbers show composite key order. Nothing enters the canonical schema until Save/Create. Validation blocks invalid names and relationships. Cancel leaves the original design intact. Deleting columns or a table requires confirmation before committing. Stable column IDs preserve saved values during renames, including swapping names. Full table edits and relationship changes require explicit sync; direct grid column edits apply and sync safely in one action.

### SQL query tabs

Use **+** beside the SQL tab names to open another query. Click a tab to switch; double-click its name to rename it (Enter saves, Escape cancels). **×** closes a tab, with confirmation when it contains SQL. Closing the last tab creates an empty query. Query text, names and the selected tab autosave per workspace and travel with workspace JSON; legacy single-query workspaces open as `query.sql`. Each tab has its own results during the current session. Results are cleared on reload; Run and Cmd/Ctrl+Enter execute the selected SQL text, or the entire active tab when there is no nonempty selection. All tabs share the workspace database.

### Run a selection or multiple statements

Select SQL text to run just that selection with **Run selection** or **Cmd/Ctrl+Enter**. Without a selection, **Run** executes the entire active tab. Separate SELECT/WITH queries with a **blank line** or `;`. A single newline continues the same query. Blank lines inside parentheses, quoted text, comments, CTE definitions or between UNION/EXCEPT/INTERSECT branches do not split queries. DML/DDL statements still require `;` between statements. Statements execute in order and each gets its own **Result 1 / Result 2 / …** tab with SQL text, columns, rows and timing. Quoted/comment semicolons do not split statements. Results remain separate for each SQL editor tab.

Execution stops at the first failed statement, shows that statement's error and preserves earlier results. Later statements are skipped. Runs are not automatically atomic: successful earlier mutations remain applied and are snapshotted even when a later statement fails. Use explicit transactions when needed; after a transaction error, resolve it with ROLLBACK before continuing.

### SQL comment shortcuts

**Cmd/Ctrl+/** toggles `/* … */` around the selection. **Shift+Alt+A** (Option on macOS) toggles `--` on the current line or selected lines. Press the same shortcut again to uncomment. Monaco also provides Cmd/Ctrl+K, Cmd/Ctrl+C to add line comments and Cmd/Ctrl+K, Cmd/Ctrl+U to remove them.

### Live SQL diagnostics

After a short typing pause, DuckDB prepares each statement on a separate connection to check syntax, table/column names, aliases and ambiguous references. Errors are underlined; hover over them to see DuckDB's explanation and suggestions. The toolbar reports the issue count. Diagnostics clear when corrected and refresh when the database becomes ready or a query finishes. Validation never executes the prepared statements, and pauses while the database is busy or requires sync. Query results still require **Run**.

Checks use the current runtime database. Earlier DDL in a script is not applied during validation; errors after schema-changing statements are warnings with that context. Statements unsupported by DuckDB's prepare API cannot be fully checked. Runtime data/constraint failures still appear only when executing. Results from older edits or closed tabs are discarded.

### SQL suggestions and abbreviations

SQL suggests canonical table and column names as you type, including alias-qualified columns such as `c.` and joined columns with their table context. Press **Ctrl+Space** to request suggestions and **Tab/Enter** to accept. Suggestions skip strings and comments. This is lightweight schema-aware completion; CTE and derived-table projection inference is not supported.

Open **SQL → Abbreviations** to add, edit or delete prefixes and their SQL expansions. Defaults are `sel`, `cnt` and `jn`. Use `${1:column}` for editable tab stops and Tab to move between them. Changes save per workspace, persist after reload and travel with workspace JSON. Removing every abbreviation disables the defaults; **Reset defaults** restores them.

### Enter data like a spreadsheet

1. Open **Data** and choose a table from the sidebar or the compact table selector.
   Data uses pages of 100 saved rows, with **Previous / Next**, the current page and the displayed row range. Filtering searches all locally stored rows and returns to page 1. Unsaved edits and new row drafts survive page changes. Bulk selection applies to visible rows. Pagination limits rendered grid rows; the local workspace still holds the complete dataset.

2. Click a cell to edit it directly. Type in an empty row to insert a record. **Add row** focuses the first available empty row.
3. Paste tab-separated cells from Excel or Google Sheets, starting at the active cell. Quoted multiline TSV is supported. A paste that exceeds the table width is rejected instead of truncated.
4. Use **Tab / Shift+Tab** to move between cells, **Enter / Shift+Enter** to move between rows, and arrow keys to navigate. Left/right arrows move to another cell when the text caret is at the boundary. **Escape** reverts the current cell.
5. Click **Save changes** or press **Cmd/Ctrl+S** while a grid cell is focused. All changed rows are validated and saved in one transaction. A failed row or constraint rolls back the entire batch and preserves the drafts.
6. Check row numbers to select rows, then **Delete** to stage their deletion. The actual deletion requires confirmation when saving. The reset button discards drafts.

Untouched cells in new rows use column defaults or NULL. Blank text is an empty string. Blank numeric/date cells become NULL only when allowed. **Set NULL** or **Alt+Backspace** explicitly writes NULL. In pasted TSV, `\N` represents NULL. Integer and BIGINT ranges, booleans and calendar dates are checked before SQL execution; BIGINT precision is preserved.

A primary key is required to edit/delete existing rows safely. New records can be inserted into a table without a primary key. Updates locate rows by their original primary key, including composite keys. Unsaved changes are protected when switching modes, tables or workspaces, and by a browser unload warning. Cell drafts are temporary until saved; a forced browser/process shutdown cannot preserve them.

### Design, query, validate

- **Data** combines record entry, schema editing and relationship management. Use **Add column**, immediately beside **Add row** in the grid toolbar, to add a column; click any existing column header to edit its name, type, primary key, nullability, unique constraint or default. The column editor is an anchored popover with name/type first, friendly type labels, and a **More options** disclosure for defaults and constraints. Press Enter or Cmd/Ctrl+S to submit. Focus returns to the created/edited column; unsaved changes are protected when dismissing. There is no extra add-column grid gutter. Direct column edits rebuild an isolated runtime and restore saved rows before committing the canonical schema. Defaults are populated immediately. Failures preserve the existing table and keep the column draft open.
- **Relationships** in the Data toolbar manages outgoing and incoming mappings, including physical foreign keys, logical relationships and ordered composite keys. Full **Edit table** still handles batch column changes, reordering and table creation. Those staged changes require **Sync database**. Column renames migrate saved values by stable ID; deletion confirms removal of saved values and affected relationships.
- **Relations** lives above **TABLES** in the sidebar. Drag tables to arrange the diagram, pan/zoom, fit the view, select a table to highlight related edges, or select a relationship to inspect its mapping. Layout autosaves separately from the canonical schema, restores after reload, supports undo/redo and travels with workspace JSON. **Auto arrange** restores a dependency-based layout and fits the view. Moving a table does not require SQL runtime synchronization. Schema and relationship edits remain in Data; creating/reconnecting edges and deleting schema objects from the canvas are disabled. Click a table in the sidebar to return to its Data grid.
- **SQL** provides Monaco editing and query results. **Cmd/Ctrl+Enter** runs SQL. SELECT, JOIN, aggregation, CTE and DuckDB-supported DML/DDL run in the browser. Successful queries snapshot canonical tables for persistence. Runtime DDL does not update the ERD; incompatible metadata requires rebuilding.
- **Tests** runs individual SQL requirement checks or all saved checks. Use **New test** to enter a requirement, SQL and expected JSON rows. Row order is optional, NULL differs from missing values, and numeric serialization is normalized. Definitions persist; actual results are shown after each run.
- **Cmd/Ctrl+K** focuses table search. Workspaces autosave to IndexedDB; use JSON export for backups and transfer between origins/devices.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests cover schema validation, ordered DDL, IndexedDB roundtrips, history operations, deterministic comparisons, safe runtime reconstruction, typed spreadsheet values, Excel TSV parsing, composite row identity, atomic save/rollback behavior, staged table editing with stable-ID data migrations, automatic relationship layout, and saved diagram positions with IndexedDB/JSON roundtrips. Browser QA covers direct entry, multi-row paste, keyboard save, table switching and foreign-key error recovery.

## Architecture and limits

`src/types` defines the canonical engine-independent schema. Features are in `src/features/{schema,erd,sql,sample-data,test-cases}`. Grid parsing and SQL planning are separate from the grid component; transaction execution is in `sample-data/mutations.ts`. DDL, DuckDB and storage live in `src/lib`. SQL tokenization and statement boundaries are isolated in `sql/lexer.ts` and `sql/statements.ts`; completion, diagnostics and execution share that lexical layer. `QueryTabs.tsx` handles query tab controls independently of the editor/results layout. TypeScript rejects unused locals and parameters.

DuckDB selects a compatible single-threaded Wasm bundle, preferring native exception handling where available. This follows the official [browser instantiation pattern](https://duckdb.org/docs/current/clients/wasm/instantiation). COOP/COEP headers are unnecessary. Browser memory and storage quotas apply. The grid supports pasting up to 10,000 rows at a time and is not virtualized; large datasets are outside this MVP's scope.

The MVP does not support cascading referential actions, cyclic physical foreign keys, physical self references, automatic SQL-to-diagram synchronization, formulas, merged cells, range selection or automatic type-changing data migrations. Logical relationships do not enforce constraints. Column defaults are DuckDB SQL expressions. Each successful grid transaction snapshots the canonical tables. Cell changes are saved explicitly; this is intentional to support complete rows and atomic multi-row validation.

Production dependencies audit clean with the DOMPurify override. The full audit currently reports moderate development-tool findings in ESLint's minimatch dependency chain.
