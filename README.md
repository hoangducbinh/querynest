# Database Design Playground

A desktop SQL and data workspace for PostgreSQL and SQL Server, built with Tauri, React, TypeScript, Monaco, Zustand/Immer and Dexie. Database queries run through native drivers. There is no embedded database engine or browser SQL runtime.

## Run

```sh
npm install
npm run desktop:dev
```

For a packaged desktop application:

```sh
npm run desktop:build
```

The desktop build requires Rust/Cargo and the platform build tools. `npm run dev` starts the browser UI for frontend development; actual database connections require the desktop application.

A new session starts empty. Add a connection from the title bar, enter its settings, and use **Test connection** or **Connect**. SQL and Data share the authenticated session. Each SQL tab keeps its own connection/database; the active SQL tab supplies the database used by Data. Split editors can use different databases.

## Connections

- PostgreSQL uses native SQLx. Certificate and hostname verification are enabled by default. The local SSL option is intended for local test servers without TLS.
- SQL Server uses the native Tiberius TDS driver. Encryption and certificate verification are enabled by default. SQL login works on macOS and Windows; Windows current-account authentication requires Windows. Use explicit TCP host/port; named-instance discovery, SQL Browser and LocalDB are not supported.
- The connection menu provides Connect, Refresh schema, Reconnect, Disconnect and settings. Matching saved-profile settings reuse the native session across SQL, Data, tabs and workspaces. Sessions remain in memory until disconnected or the application closes.
- Passwords and native session handles are never persisted in IndexedDB or session exports. Restarting the application requires authentication again.
- PostgreSQL read-only mode uses server-enforced read-only transactions. SQL Server's query-only guard blocks non-SELECT statements in the app; use a restricted server login for server-enforced permissions.

Connection settings, SQL text, tab bindings, cached catalog metadata, appearance and layout are stored on the device. Legacy session JSON remains importable, including old SQL text. Legacy unassigned tabs require an explicit real connection before execution; they are not automatically assigned to another database. Old local schema/data fields are retained for compatibility and are not executed.

## SQL

- Use **Cmd/Ctrl+Enter** to run the selected text or the active tab. Open/save `.sql` files from the SQL toolbar.
- PostgreSQL statements can be separated by semicolons or blank lines between independent SELECT queries. SQL Server uses `GO` alone on a line to separate batches; semicolons remain within a batch for variables, transactions and procedures. `GO n` repetition is not supported.
- Completion uses the selected database catalog: tables, schemas, aliases, CTE columns, functions and native types. Abbreviations can be configured per workspace or globally.
- Multiple result sets have separate tabs and a stacked view. Results stay in memory and are not exported as part of session JSON. SQL, CSV, TSV and JSON result exports use the grid's export controls.
- **Stop** cancels the running request and skips remaining statements/batches. SQL Server keeps the connection after acknowledged cancellation, including temporary tables and transaction state. Cancellation does not undo committed writes or automatically roll back an explicit transaction. Reconnect resets session-local state.
- BIGINT outside JavaScript's safe range, DECIMAL/NUMERIC and date/time values retain their server representations. SQL NULL remains null; duplicate result column names receive unique display names.

PostgreSQL previews display at most 1,000 rows. SQL Server results display at most 1,000 rows/set, 10,000 rows total and 50 sets. Use filters and server-side limits for large queries. Earlier successful statements remain applied if a later statement fails.

## Data

Data fetches 100 rows per page, uses primary-key ordering where available, and probes for another page without COUNT. Ordering without a primary key is not guaranteed.

For editing, use a read/write connection, unlock the grid, edit cells or paste TSV, then **Apply changes** or **Discard**. Existing rows require a primary key for safe updates/deletes. Native drivers validate values, defaults and constraints transactionally, including optimistic concurrency checks. Add/edit columns through the native column editor; refresh the schema after changes made outside the app.

Query results can be edited when they contain full rows from one table with a primary key. Projections, joins, CTEs and ambiguous targets stay read-only.

## Checks and fixtures

```sh
npm run typecheck
npm run lint
npm test
npm run bundle:check
cargo test --manifest-path src-tauri/Cargo.toml --lib
sh scripts/postgres-qa.sh
```

`bundle:check` builds the frontend and enforces a 1,000 kB initial JavaScript budget and 500 kB per application chunk. Monaco loads separately from the application shell.

The PostgreSQL script starts disposable localhost-only fixtures on ports 55439 and 55440 and runs all four native integration tests. It stops both containers on exit. Use `--keep` to retain successful fixtures for desktop QA, then stop `dbplayground-pg-qa` and `dbplayground-pg-multidb-qa` afterwards.

SQL Server fixture and stress-test instructions are in [scripts/sqlserver/README.md](scripts/sqlserver/README.md). Native live tests cover queries, precision, transactions, read-only behavior, cancellation, grid writes, column changes and independent database contexts. Run them only against disposable test databases.

## Source layout

- `src/features/connections`: profiles, native IPC adapters, retained sessions, database contexts and remote workspace views.
- `src/features/sql`: editor, completion, tokenization, statements, result editing/copying and layout.
- `src/features/sample-data`: shared grid, draft rows, clipboard handling and viewport state; all writes use native database drivers.
- `src/features/schema`: catalog/session definitions, import compatibility and application state.
- `src/lib/platform` and `src/lib/storage`: desktop adapters, file export and device persistence.
- `src-tauri/src`: PostgreSQL and SQL Server drivers, grid transactions and column editing.
- `src/test`: synthetic frontend test fixtures, excluded from the production dependency graph.
