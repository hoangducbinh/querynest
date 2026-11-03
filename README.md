> Interface update: the app now opens directly into a saved SQL/Data session. There is no workspace chooser or workspace title in the UI. The first title-bar dropdown handles choosing, searching, editing and removing connections; a submenu beside each connection holds lifecycle and settings actions, while the dedicated New connection icon remains on the title bar. The New connection sheet connects and saves settings in one step. Existing workspace storage and JSON remain compatible; removing the chooser does not delete saved data.

# Database Design Playground

A local database design and data workspace built with React, TypeScript, Vite, Monaco, DuckDB-Wasm, Zustand/Immer and Dexie. No backend, account or AI service. Workers and Wasm are bundled locally.

## Start

```sh
npm install
npm run dev
```

Open the Vite URL. The workspace restores automatically, including its local DuckDB runtime. The initial commerce workspace includes customers, orders and order_items.

## Desktop (Tauri 2)

The same React app can run as a desktop application. The browser version remains available with `npm run dev`; the initial desktop release uses the existing DuckDB-Wasm engine locally. PostgreSQL uses native Rust/SQLx; SQL Server uses the native Tiberius TDS driver. A native DuckDB engine is not implemented; local workspaces continue to use DuckDB-Wasm.

Prerequisites: Node.js/npm, stable Rust/Cargo and the platform build tools. On macOS, Xcode Command Line Tools are sufficient for desktop builds. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run desktop:dev
npm run desktop:check
npm run desktop:build
```

`desktop:dev` starts Vite on `127.0.0.1:5173` and launches the native window. The port is fixed; stop any existing Vite server first. `desktop:build` builds the frontend and produces packages for the current platform (macOS `.app`/`.dmg`, Windows `.exe`/`.msi`) in `src-tauri/target/release/bundle/`. To build only the app, use `npm run desktop:build -- --bundles app`. Rust formatting: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`.

Desktop JSON export uses a native Save dialog and writes only to the path selected there. Import uses the existing file picker. Each browser origin and the packaged desktop app have separate local workspace storage and appearance settings: use JSON export/import to transfer workspaces. Window-close requests wait for saved workspace state and protect unsaved grid drafts. Keep JSON backups for important work.

Build on the target OS (or its GitHub Actions runner). For Windows, install the MSVC build tools, WebView2 and Rust, then use `npm run desktop:build -- --bundles nsis`. Release signing/notarization and distribution are separate from these local builds. The app identifier is `dev.dbplayground.desktop`; keep it stable to retain the same desktop storage location. Keep the bundle product name `Database Design Playground` and executable name `database-design-playground` stable as well, so the existing macOS WebKit storage remains available. IndexedDB keeps the original `database-design-playground` name across branding changes.

The native shell is in `src-tauri`. Frontend platform adapters are isolated in `src/lib/platform`; the web version does not call native APIs. Native capabilities are limited to the main window's close lifecycle and user-selected JSON export. Monaco, DuckDB workers and WASM assets are bundled locally.

## Workspaces and saved connections

Open the first title-bar connection dropdown and choose **New connection** to choose SQL Server or PostgreSQL, enter settings and connect. The app saves the profile and opens a SQL tab directly, without creating or choosing a workspace. Passwords remain in native memory only. Choose existing profiles directly in that same dropdown.

To delete a workspace, choose **Open workspace**, click its trash button, and confirm. This removes only that workspace's local SQL, schema/sample data, tests, layout and settings; server databases and saved connection profiles are not deleted. Export JSON first if you need a backup. Deleting the active workspace switches to the most recently used remaining workspace; deleting the last one creates an empty local workspace. A deletion marker prevents queued autosaves/other windows from silently recreating the deleted ID. Importing a JSON backup creates a new workspace ID.

The first title-bar menu is the connection manager. Each connection has Connect/Refresh and a compact actions menu for settings, reconnect, disconnect and removal. Settings are stored in Dexie; passwords are never saved. Editing settings updates the connection configuration for the next connection; session-local state remains owned by the existing native session until disconnected. Legacy workspace JSON is still accepted.

Browser mode can manage settings and use local playgrounds; actual network connections require the desktop app. The connection form offers **Test connection** before opening a session. Each workspace switch closes its old native session; passwords must be entered again for SQL login.

## PostgreSQL workspaces (desktop)

1. Open **New workspace → PostgreSQL**, save the connection settings, then choose **Open workspace** on its connection card.
2. Enter host, port, database, user and password. SSL defaults to certificate/hostname verification; use the local connection option only for a trusted local database without TLS.
   Use **Test connection** to verify login and catalog access without opening a workspace session; the temporary connection closes after the check.

3. **Read-only connection** is enabled by default. Connect to read schema, columns, native PostgreSQL types and foreign-key relationships.
4. **SQL** supports multiple query tabs, selected-text execution, separate batch results, table/column/alias completion and PostgreSQL diagnostics. **Stop** cancels the current PostgreSQL query and stops the remaining batch.
5. **Data** loads 100 rows/page and supports spreadsheet editing in read/write connections. It uses primary-key order where available, physical row order for ordinary tables without keys, and a next-page probe instead of an expensive COUNT. View ordering without a primary key is not guaranteed; concurrent changes can shift offset-based pages. Reconnect with read-only disabled to insert, update and delete directly in the grid (or use SQL).

Connections are owned by the application and retained in memory across tools, query tabs and workspaces. Matching saved-profile settings reuse the same native session, with no inactivity expiry or workspace-count eviction. Returning reuses cached schema metadata; use **Refresh schema** after external schema changes. The global **Connections** center manages Connect, Reconnect and Disconnect. Removing a workspace releases its references; saved-profile sessions remain available until explicitly disconnected or the app closes. Passwords and native session handles are never saved to disk. Restarting the app requires authentication again.

Settings, SQL text and cached schema metadata are saved per workspace. Passwords and live session IDs are kept only in memory; reconnect after reopening the app. Query result rows are not snapshotted into workspace storage or JSON exports. Import strips unknown connection fields and remote row data. Browser workspaces and remote workspaces remain separate; PostgreSQL requires the desktop app.

Read-only queries run inside a server-enforced read-only transaction and are rolled back after each execution. SELECT/WITH/VALUES/TABLE previews use a server cursor to fetch at most 1,001 rows, displaying at most 1,000. Other results are also limited to 1,000 displayed rows. In read/write mode, statements fully execute; results beyond the display cap are drained without storing them. Earlier successful writes remain applied if a later batch statement fails. Explicit BEGIN/COMMIT/ROLLBACK are supported on the dedicated read/write session. Default statement timeout is 60 seconds and lock timeout is 5 seconds.

BIGINT values outside JavaScript's safe integer range, NUMERIC/DECIMAL, arrays, JSON and timestamps are returned as PostgreSQL text to preserve precision/format. Ordinary integers, finite floats and booleans retain JSON types; SQL NULL stays null. Use explicit SQL casts when another representation is needed. Duplicate result column names receive unique display names.

Diagnostics prepare statements without executing them, on a separate connection. Uncommitted schema changes and custom session settings may not be reflected in live diagnostics. A non-default PostgreSQL port is supported; SSH tunneling, custom CA/client-certificate pickers are not included in this connection release.

Rust unit tests: `cargo test --manifest-path src-tauri/Cargo.toml`. The ignored `live_postgres_driver` integration test requires the disposable fixture described in `scripts/postgres-qa.sh` and should never target a production database.

### Shared connection across tools

The active SQL tab selects the workspace's connection/database for Data. Other SQL tabs keep their own contexts. Switching tools reuses the same in-memory session rather than asking for a password again. Connection status and lifecycle actions are centralized in **Connections**. Data restores the exact source configuration used by SQL; a saved profile's default database does not replace that selection. If no authenticated session remains, use Connect in the global center. Stopping SQL Server queries keeps the session available. Restarting the app or explicitly disconnecting requires authentication again.

## SQL Server workspaces (desktop)

Choose **New workspace → SQL Server** (or add a profile from **Connections**). Set host, explicit TCP port (default 1433), database (default `master`) and authentication. **SQL Server login** works on both macOS and Windows. **Windows · current account** uses SSPI in the Windows build and needs no saved password; on macOS it reports that Windows is required. Named-instance discovery, SQL Browser, SQL LocalDB, domain/password impersonation and SSH tunnels are not included: use the actual host and TCP port.

Encryption and certificate verification are enabled by default. For a local development server with a self-signed certificate, explicitly select **Trust server certificate**. On Windows, enable SQL Server TCP/IP and check the actual instance port; SQL login requires server-side SQL authentication to be enabled. Windows authentication requires the Windows account to have permission on that instance/database. See [Microsoft TCP/IP setup](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/enable-or-disable-a-server-network-protocol) and [authentication modes](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/change-server-authentication-mode).

- Tables, views, native types, primary keys and composite foreign keys populate the shared sidebar. **Refresh schema** after DDL.
- SQL supports selected text, multiple result sets, bracket-quoted name completion and T-SQL keywords. Use **GO alone on a line** between batches; semicolons stay inside each batch so DECLARE variables, stored procedure definitions and transactions keep their normal T-SQL scope. `GO n` repetition is not supported. Results are capped at 1,000 rows/set, 10,000 rows total and 50 sets; the driver still drains the complete response. Use `TOP`/filters for large queries. Commands without row results show **Completed** rather than an invented affected-row count.
- **Data** fetches 100 rows/page via OFFSET/FETCH plus a next-page probe. Primary-key ordering is used where available; tables/views without a key have no guaranteed page order. Use the spreadsheet in read/write mode to edit ordinary tables, or write using SQL.
- BIGINT beyond the JavaScript safe range, DECIMAL/NUMERIC and date/time values use strings; binary uses hex. SQL NULL remains null.
- Live diagnostics use `sp_describe_first_result_set` on a separate connection without running user text. Procedures, temp tables, dynamic SQL, session settings and uncommitted schema changes may not be describable; those failures show warnings. SQL Server usually supplies a line, not an exact character position.
- **Query-only guard** conservatively parses batches and blocks non-SELECT statements, SELECT INTO, sequence advancement and external-access clauses. This is an app guard, not a SQL Server permission boundary: use a restricted read-only login for server-enforced protection. Complex T-SQL unsupported by the parser must use a restricted account with the guard disabled.
- Connection timeout is 12 seconds; queries have a 60-second timeout and 5-second lock timeout. **Stop** sends TDS ATTENTION and drains the server acknowledgement before reusing the same socket. Temporary tables, session settings and open transactions remain available; stopping does not automatically roll back an open transaction. Execution timeouts use the same cancellation path. If cancellation cannot be acknowledged within five seconds, the broken socket is closed. **Reconnect** explicitly creates a new physical session and therefore resets session-local state. Previously committed statements remain committed; cancellation cannot undo them. Explicit BEGIN TRANSACTION/COMMIT/ROLLBACK otherwise use the pinned session.

### Editing PostgreSQL and SQL Server data

Turn off **Read-only connection** (PostgreSQL) or **Query-only guard** (SQL Server), reconnect, then choose a table in **Data**. The grid uses the same cell editor as local DuckDB: type into cells, paste TSV from Excel, add rows, select/delete rows, Set NULL, and **Save changes** or **Discard**. Use **Add column** beside Add row, or click a column header to open its native column editor.

- Values remain text until the server converts them. Empty text stays empty; use **Set NULL**, Alt+Backspace or the clipboard `\N` marker for SQL NULL. Leaving a new-row cell untouched uses the database default/NULL. **Add row** can create a DEFAULT VALUES draft even when every column is generated or has a default.
- Identity, computed/generated, rowversion and unsupported SQL Server column types are read-only. Ordinary tables without a primary key allow inserts only. Views, materialized views and foreign tables stay read-only in the grid. SQL permissions are always enforced by the server.
- Save accepts up to 500 changed rows, with a 1 MB limit per edited cell, in one dedicated transaction. All validation/constraint failures roll back the batch and retain drafts. Grid transactions never commit a manual transaction opened in the SQL tab. Grid pages show committed data on separate connections; uncommitted SQL changes are not included.
- Update/delete uses the original full primary key (including composite keys), then checks the full current row against its loaded snapshot under lock. Conflicting or missing rows abort the batch: discard and reload rather than overwrite concurrent changes. PostgreSQL locks edited rows; SQL Server uses a short exclusive table lock for the bounded save to protect both snapshot checks and writes. Busy tables can hit the five-second lock timeout.
- Generated values are reloaded after saving. Inserts may sort onto another page. Pagination remains server-side, 100 rows/page; filtering searches only the loaded page. Changing pages, table, mode, connection or workspace checks for unsaved drafts. Native window-close and browser unload guards include remote drafts.
- A save and its refresh are separate: if COMMIT succeeded but refreshing failed, drafts are cleared and the UI reports that data was saved. If COMMIT cannot be confirmed, Save stays disabled until drafts are discarded and data is refreshed, preventing accidental duplicate submissions.

### Editing remote columns

In a read/write PostgreSQL or SQL Server workspace, open **Data → Add column**, or click an existing column header. The popover supports name, native data type (including length/precision/scale), Required/nullable, SQL default expression, single-column Unique, and adding a primary key when the table has none. Save/discard pending row edits before editing the schema. Changes apply directly to the selected table, followed by automatic schema/grid refresh.

DDL uses a dedicated transaction with a 60-second execution timeout and a short lock timeout; it does not commit transactions from the SQL tab. Fresh metadata is compared against the editor snapshot under a table lock to reject stale edits. Types are allowlisted, names quoted, and defaults must parse as one expression without additional statements. Existing collations and SQL Server default-constraint names are preserved when relevant. Adding a default applies it to existing rows on both engines (SQL Server uses WITH VALUES); changing an existing default affects future rows. NOT NULL, uniqueness and type conversions are validated by the database; failures roll back the whole change.

Identity/computed/generated settings are read-only, with renaming supported. The last column cannot be deleted. Drop is disabled for columns used by primary/foreign keys, check/unique constraints or indexes; remove/manage those dependencies explicitly in SQL first. There is no CASCADE or automatic index/key rebuild in the editor. Existing/composite primary keys and custom types/casts (including PostgreSQL USING expressions) remain SQL operations. SQL Server indexed/constrained column types must be managed in SQL. SQL Server renames do not rewrite text in dependent views or procedures. Deleting an eligible column requires confirmation and removes its values permanently.

If COMMIT cannot be confirmed, the editor blocks retry until it is closed and schema refreshed. If DDL committed but the metadata refresh failed, the editor closes and the grid stays disabled until schema refresh, preventing duplicate ADD/DROP attempts.

The ignored integration tests `live_postgres_columns` and `live_sqlserver_columns` create isolated `columns_qa_*` schemas and remove them afterward. They cover add/backfill, rename, type/nullable/default changes, uniqueness failures and rollback, dropping columns with defaults, stale-schema rejection, protected keys/indexes, identity renames, adding a primary key, and collation/default-constraint preservation. The PostgreSQL fixture runs its test automatically; SQL Server uses the `SQLSERVER_TEST_*` variables below and `cargo test --manifest-path src-tauri/Cargo.toml live_sqlserver_columns -- --ignored`.

`live_postgres_grid` and `live_sqlserver_grid` cover exact decimals/large IDs, defaults, generated values, composite-key updates, NULL/empty text, full-batch rollback, stale/deleted rows, keyless inserts and read-only protection. The PostgreSQL fixture script runs both PostgreSQL integration tests. The SQL Server grid test creates and removes a unique `grid_qa_*` schema in the configured **development** database; it needs CREATE SCHEMA/TABLE/VIEW permissions. Run it with the same `SQLSERVER_TEST_*` variables below and `cargo test --manifest-path src-tauri/Cargo.toml live_sqlserver_grid -- --ignored`.

### Build and try on Windows

Copy/clone the project onto Windows, install Node.js, Rust (MSVC), Visual Studio C++ build tools and WebView2 following [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows). From the project root:

```powershell
npm ci
npm run desktop:dev
# Or create an installer:
npm run desktop:build -- --bundles nsis
```

The installer is under `src-tauri/target/release/bundle/nsis/`. macOS cannot produce or run this Windows installer through the normal local build. Before distribution, validate on the actual Windows/SQL Server setup: Test connection with SQL login and Windows authentication, schema refresh, multi-result queries, table pagination, BEGIN/ROLLBACK, cancel/reconnect and relaunch (password must be blank).

The ignored Rust integration test uses only session-local temp tables; point it at a development SQL Server with CREATE TABLE rights in tempdb, not production:

```powershell
$env:SQLSERVER_TEST_HOST = '127.0.0.1'
$env:SQLSERVER_TEST_DATABASE = 'master'
$env:SQLSERVER_TEST_AUTH = 'windows'
# For a trusted local self-signed test server only:
$env:SQLSERVER_TEST_TRUST_CERT = 'true'
cargo test --manifest-path src-tauri/Cargo.toml live_sqlserver_driver -- --ignored
```

For SQL login, use `SQLSERVER_TEST_AUTH=sql`, `SQLSERVER_TEST_USER` and `SQLSERVER_TEST_PASSWORD` in your local environment. Optional port override: `SQLSERVER_TEST_PORT`. SQL Server integration and Windows compilation require those external environments; unit tests on macOS do not replace them.

## The workspace

The compact interface uses a single compact toolbar and two title bar modes: **Data** and **SQL**. Relations and Tests have been removed; legacy workspace fields remain import-compatible. Decorative headers, breadcrumbs, global footers, explanatory banners and duplicate table tabs have been removed. Dark appearance and the workspace menu remain in the top toolbar. Appearance is saved locally for this browser and restored on reload. Dialogs and popovers share the same theme; text inputs use a thin focus border.

**SQL** opens by default and keeps the shared table sidebar visible and shows the selected table's columns, data types and PK/FK indicators for reference while writing queries. Column rows are read-only in SQL. The editor uses 70% of the remaining height and fills the available width. Drag the separator to resize the editor/results split; the separator also supports arrow keys and Home/End. Use the results toggle to give the editor all available height. The top-left button toggles the shared sidebar consistently across views.

**Create table / Edit table** opens a staged structure editor. Set the table name, then edit columns in a single grid: name, type, primary key, not-null, unique and default. Add a column with the button or Enter in the final column name. The arrows on the row number reorder columns. Primary key numbers show composite key order. Nothing enters the canonical schema until Save/Create. Validation blocks invalid names and relationships. Cancel leaves the original design intact. Deleting columns or a table requires confirmation before committing. Stable column IDs preserve saved values during renames, including swapping names. Full table edits and relationship changes require explicit sync; direct grid column edits apply and sync safely in one action.

### SQL query tabs

Use **+** beside the SQL tab names to open another query. Click a tab to switch; double-click its name to rename it (Enter saves, Escape cancels). **×** closes a tab, with confirmation when it contains SQL. Closing the last tab creates an empty query. Query text, names and the selected tab autosave per workspace and travel with workspace JSON; legacy single-query workspaces open as `query.sql`. Each tab has its own results during the current session, retained when switching between SQL, Data and workspaces. Results are cleared on reload; Run and Cmd/Ctrl+Enter execute the selected SQL text, or the entire active tab when there is no nonempty selection. All tabs share the workspace database. Use the **Split SQL editor** toolbar icon to open two panes side by side. Each pane owns a separate list of tabs and displays its selected tab's results. Adding, renaming or closing a tab affects only its pane. Existing tabs are distributed between panes when splitting; use **Move current tab to other split** to move a query and its results without copying it. If only one tab exists, splitting creates an empty `split.sql` tab. Drag the divider to resize (or focus it and use Left/Right, Home/End). Run and Cmd/Ctrl+Enter target the focused pane; executions share the same database session and run one at a time. **Close SQL split** keeps the tabs and returns to one pane. Split state, divider width, pane tab order and the selected tab in each pane autosave per workspace. Switching views/workspaces or relaunching the app restores that layout; it also travels with workspace JSON. Workspaces saved before this feature open in one pane.

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

Open the title bar **⋯ → SQL abbreviations** to edit expansions. Choose **This workspace** or **All workspaces · global defaults**, toggle abbreviations, then click **Apply** (⌘/Ctrl+S) without closing the dialog. Workspaces inherit global defaults unless customized; global Apply preserves overrides unless **Replace workspace overrides too** is checked and confirmed. Workspace settings travel with exported JSON; global defaults are saved locally. Defaults are `sel`, `cnt` and `jn`; `${1:column}` creates editable tab stops.

When SQL tabs exceed the available width, use **⋯** beside the new-tab button to search and switch between tabs. Each split pane keeps its own tab list; the active tab stays visible.

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
- **SQL** provides Monaco editing and query results. **Cmd/Ctrl+Enter** runs SQL. SELECT, JOIN, aggregation, CTE and DuckDB-supported DML/DDL run in the browser. Successful queries snapshot canonical tables for persistence. Runtime DDL does not update the ERD; incompatible metadata requires rebuilding.
- **Cmd/Ctrl+K** focuses table search. Workspaces autosave to IndexedDB; use JSON export for backups and transfer between origins/devices.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests cover schema validation, ordered DDL, IndexedDB roundtrips, history operations, safe runtime reconstruction, typed spreadsheet values, Excel TSV parsing, composite row identity, atomic save/rollback behavior, staged table editing with stable-ID data migrations. Browser QA covers direct entry, multi-row paste, keyboard save, table switching and foreign-key error recovery.

## Architecture and limits

`src/types` defines the canonical engine-independent schema. Features are in `src/features/{schema,erd,sql,sample-data,test-cases}`. Grid parsing and SQL planning are separate from the grid component; transaction execution is in `sample-data/mutations.ts`. DDL, DuckDB and storage live in `src/lib`. SQL tokenization and statement boundaries are isolated in `sql/lexer.ts` and `sql/statements.ts`; completion, diagnostics and execution share that lexical layer. `QueryTabs.tsx` handles query tab controls independently of the editor/results layout. TypeScript rejects unused locals and parameters.

DuckDB selects a compatible single-threaded Wasm bundle, preferring native exception handling where available. This follows the official [browser instantiation pattern](https://duckdb.org/docs/current/clients/wasm/instantiation). COOP/COEP headers are unnecessary. Browser memory and storage quotas apply. The grid supports pasting up to 10,000 rows at a time and is not virtualized; large datasets are outside this MVP's scope.

The MVP does not support cascading referential actions, cyclic physical foreign keys, physical self references, automatic SQL-to-diagram synchronization, formulas, merged cells, range selection or automatic type-changing data migrations. Logical relationships do not enforce constraints. Column defaults are DuckDB SQL expressions. Each successful grid transaction snapshots the canonical tables. Cell changes are saved explicitly; this is intentional to support complete rows and atomic multi-row validation.

Production dependencies audit clean with the DOMPurify override. The full audit currently reports moderate development-tool findings in ESLint's minimatch dependency chain.


### DuckDB column types and SQL type completion

Local column and table editors accept editable type definitions, with suggestions for the bundled DuckDB 1.5 runtime: signed/unsigned integers through 128 bits, BIGNUM, FLOAT/DOUBLE, DECIMAL precision/scale, Unicode VARCHAR, BIT/BLOB, UUID/JSON, date/time and timestamp resolutions/zones, INTERVAL, GEOMETRY, ENUM, LIST/ARRAY, MAP, STRUCT, UNION and VARIANT. Enter definitions such as `DECIMAL(38,8)`, `INTEGER[3]`, `STRUCT(name VARCHAR, scores INTEGER[])` or `ENUM('draft','ready')`. A bounded type parser validates definitions before DDL generation; DuckDB then validates runtime constraints during sync or column Save. Existing workspace JSON remains compatible.

The Data grid keeps exact wide numbers/decimals as text. Nested values use JSON with string leaves to preserve precision: lists `["1","2"]`, structs `{"n":"12345678901234567890"}`, maps `[{"key":"a","value":"1"}]` and unions `{"tag":"num","value":"42"}`. VARIANT snapshots include `$variantType` and `$variantJSON`; ordinary JSON values can also be entered. Hover a cell for its input format. Save and rebuild share the same validated conversion path. Large numbers inside JSON should be quoted. Custom named types and extension-defined types beyond these built-ins are managed through SQL.

SQL autocomplete uses the current workspace engine. Type suggestions are prioritized in CREATE TABLE column declarations, ALTER TABLE ADD/ALTER TYPE, CAST/TRY_CAST, PostgreSQL `::`, and SQL Server DECLARE/CONVERT. Press Ctrl+Space to open suggestions and Tab to accept. Parameterized types insert editable snippet fields, e.g. SQL Server `NVARCHAR(255)`/`NVARCHAR(MAX)` and `DECIMAL(18,2)`. Version-specific SQL Server types carry an availability note; the connected server determines whether they can be used.


### Multiple connections in one workspace

Connection management lives in the title bar’s **Connection actions** menu: add/attach a profile, manage saved profiles, refresh databases and tables, or remove the selected connection from the workspace. The title bar selectors choose the current connection and database. The sidebar contains only that database’s tables and column details; it follows the active SQL tab when switching split panes. Expand the arrow beside a table to inspect columns. Discovery respects server permissions, and removing a connection never deletes server databases.

The title bar shows **Connection** and **Database** selectors in every mode. Data uses the database selected for the workspace; SQL uses the active SQL tab’s own context. DuckDB shows its local `main` database. With split editors, focus a pane to show and change that pane’s active tab context; switching the title bar selectors does not retarget other tabs. Changing a SQL tab’s title bar selectors does not retarget other tabs. Split panes may query different PostgreSQL/SQL Server databases, or local DuckDB, while keeping independent tabs/results. Autocomplete, type suggestions and diagnostics use the selected tab's connection catalog and dialect. New tabs use the current title bar connection and database. The + button's tooltip names that connection and focuses the new editor for immediate typing. The connection/database binding is saved alongside SQL text and split layout, including in JSON exports. Old single-connection workspaces keep working and migrate when a connection or another database is opened.

Use the global **Connections** center to connect, refresh schema, reconnect or disconnect. The first Run on a disconnected database requests authentication there; after connecting, press Run again. SQL, Data and other tools borrow the same application-owned session for matching saved-profile settings. Opening another database reuses native authentication to create an independent database session without changing another tab’s SQL context. Read-only settings remain isolated. Transport recovery can reuse authentication held in native memory, but failed SQL is never replayed automatically. Closing the app requires authenticating again.

Removing a remote connection from a workspace keeps its SQL text and explicitly reassigns those tabs to the named remaining connection; it does not delete server data or the reusable profile. Removing Local DuckDB removes its local saved tables/rows after confirmation. Remote Data CRUD/column editing uses the database selected in the title bar. SQL execution remains one operation at a time; there are no automatic cross-server joins or distributed transactions. SQL Server version-specific types still require a supporting server version.


### Desktop chrome and connection form

On macOS the compact 38 px workspace toolbar occupies the native title bar and retains system window controls. On Windows a platform-specific configuration removes the extra native caption and uses a 36 px toolbar with minimize, maximize/restore and close controls. Close requests still pass through autosave and unsaved-change guards. Workspace switching is available through **⋯ → Open workspace**, keeping the title bar free of a separate workspace dropdown. Empty toolbar space is draggable; interactive controls remain clickable. Workspace names are read-only in the title bar, with a bounded width and an ellipsis for long names; hover to read the full name. **⋯ → Hide/Show sidebar** toggles the explorer. Linux retains native window decorations. The saved light/dark preference is applied both to the web interface and the native window theme/background at startup and whenever toggled.

Connection settings use a compact form with paired host/port and user/password fields. The query/read-only switch stays visible. **Security** expands SSL/TLS controls; its summary shows the current policy without changing it. Test connection, error/success feedback, keyboard submission and all existing PostgreSQL/SQL Server authentication settings remain available. Title-bar changes require restarting `npm run desktop:dev` (or rebuilding the desktop app), because they change the native window configuration.

Split SQL panes use one compact tab/tool row. **⋯** opens split, move-tab and result-visibility actions; Run keeps its full label and keyboard hint, including in split mode. Narrow panes wrap their toolbar when needed instead of shrinking Run. The focused pane has a subtle toolbar highlight, and the divider remains draggable.


### Browse saved workspaces

Use **⋯ → Open workspace** to search by workspace, connection, database or host. Select a workspace to inspect all attached connections, server endpoints, database names, read/write settings, saved table counts, SQL tabs, tests, the last selected database, split layout and update time before opening it. The current workspace is marked explicitly. Rename a workspace here (up to 120 characters); long existing names remain fully visible in the detail pane. Deletion keeps the existing confirmation and does not delete server databases. Table counts and database names describe saved metadata, not a live server inventory.

### Large remote catalogs and slow networks

Ordinary SQL reads and row edits reuse cached metadata; SQL execution refreshes the full catalog only for potential DDL/procedure batches. Use Refresh for external schema changes. Switching from SQL to Data also reuses cached schema. Remote SQL is checked when executed; typing does not send background validation requests to the server. Autocomplete limits suggestions to 500 and, for catalogs over 200 tables, offers columns from referenced tables/aliases instead of enumerating every column in the database. The sidebar shows 50 tables per page; search covers the full catalog and resets to the first page.

Initial connection still loads the full catalog. These client optimizations do not change query plans, server execution time, network latency, or result-draining semantics. Further work for very large deployments should measure those costs independently and introduce lazy per-table metadata.


Large-catalog follow-up: schema DDL generation runs only when opening its dialog,
not on hidden-dialog renders. Metadata cloning unwraps Immer snapshots before
copying; active source snapshots are reconciled on save/export/switch. Immutable
workspace state uses a shallow save envelope until IndexedDB copies it. Wide
Data and SQL result grids mount only columns near the horizontal viewport, cache
initial width/type calculations, and keep full row drafts for edits/paste. Grid
cells are memoized so ordinary keystrokes do not rerender every input. A local
Vite/React Profiler harness and native read-only benchmark are documented in
`scripts/sqlserver/README.md`; neither requires a desktop release build.


While SQL is running, the toolbar shows **Stop** immediately, including while a
workspace source is preparing its session. **Stopping…** prevents duplicate stop
requests. Stopping skips subsequent SQL statements/GO batches. Remote queries
use the native cancellation path; SQL Server sends TDS ATTENTION and waits for
acknowledgement while retaining its connection, and PostgreSQL sends a server
cancellation request.
Previously committed writes are not undone by stopping. Local DuckDB SQL uses
pending queries so the worker can receive cancellation and remain usable for a
subsequent query. Grid saves/schema edits are separate operations and do not show
the SQL Stop button.

### build exe on Macbook
PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH" \
RUSTFLAGS="-C target-feature=+crt-static" \
npm run desktop:build -- \
  --runner "$HOME/.cargo/bin/cargo-xwin" \
  --target x86_64-pc-windows-msvc \
  --bundles nsis \
  --config '{"build":{"windows":{"staticVCRuntime":false}}}'
Data keeps loaded table pages, each table’s selected page, filter and horizontal/vertical scroll in memory for the current native session. Revisiting tables or returning from SQL reuses those pages without a network read. Refresh reloads the selected table; saving rows or changing its structure invalidates that table’s cached pages. Disconnect/reconnect releases the old session cache. Restarting the app clears the in-memory cache.

SQL tabs also retain Monaco cursor/selections and horizontal/vertical editor scroll, selected result set and result-grid scroll, editor/results divider and results visibility in runtime memory. Switching to Data or moving between query tabs restores these views without rerunning SQL. Reloading the app clears this runtime view state.

SQL output has three views: Results (one grid), All results (stacked independently scrollable/resizable grids), and Messages. SQL Server PRINT/informational tokens and affected-row counts are collected with completed batches; errors keep messages and grids returned before the failure. Server output is bounded to 1,000 messages per request, with an explicit truncation notice. All results initially expands two grids; additional grids are collapsed to avoid rendering every result at once.

Edit rows is available for a single full-row SELECT from an unambiguous physical table with a primary key, on a writable remote connection. TOP and simple WHERE/ORDER BY clauses are supported; joins, CTEs, projections, aggregates and function predicates remain read-only. Saving uses the same native transaction and original-row concurrency checks as Data, invalidates that table’s page cache, and reloads only the verified read query. If a committed write cannot refresh its result, editing is blocked until the query is run again; writes are never automatically replayed. Finish editing before switching tools or SQL tabs.
