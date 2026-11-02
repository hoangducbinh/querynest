# SQL Server performance fixtures

Target: the disposable restored database `AdventureWorksLT2019_Test` in the local
`mssql-test` Docker container. The seed adds only the `StressTest` schema and its
own tables. Existing `SalesLT` data is unchanged. Do not run this against a company
or production database.

Expected contents:

- `StressTest.Customers`: 100,000 synthetic customers.
- `StressTest.BigOrders`: 1,000,000 rows, 20 columns, primary key and an index on
  `(CustomerID, OrderDate)` including status and amount.
- `StressTest.WideRows`: 20,000 rows, 121 columns, including nullable Unicode text,
  dates and decimals.
- `StressTest.Catalog_0001` through `Catalog_3000`: 3 rows and 25 columns each,
  with primary and foreign keys. Together these exercise a large catalog without
  generating billions of rows.

This fixture stresses catalog loading, completion, the sidebar, relationships,
wide grids and result rendering. It does not simulate network latency or place a
million rows in every catalog table. The data volume is intentionally bounded;
actual disk/log usage depends on the SQL Server configuration.

Run from the repository root (requires the container's original
`MSSQL_SA_PASSWORD` environment variable to still match the current password):

```sh
docker cp scripts/sqlserver/stress-seed.sql mssql-test:/tmp/dbplayground-stress-seed.sql
docker exec mssql-test bash -lc 'SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -i /tmp/dbplayground-stress-seed.sql'
```

The seed does not drop, truncate or delete existing data. It skips existing
catalog tables and fills missing order ID ranges, so a completed run can be
repeated. A session application lock prevents overlapping runs of this script.

In the desktop app, select `AdventureWorksLT2019_Test` and explicitly refresh the
schema once after seeding. Search for `StressTest.BigOrders` or
`StressTest.WideRows`. Query examples are in `stress-queries.sql`. Indexed reads
help distinguish client/network overhead from deliberately heavier aggregate
queries. `SET STATISTICS IO/TIME` output is visible in sqlcmd/SSMS; the app may
show only the row result sets.

## Reproduce frontend performance measurements without an application build

```sh
python3 scripts/sqlserver/export-perf.py
npm run dev -- --port 5174 --strictPort
```

Open `http://127.0.0.1:5174/scripts/sqlserver/perf.html`. The exporter reads the
local fixture and writes ignored `perf-catalog.local.json` and
`perf-wide.local.json` snapshots. The page uses the actual catalog, actual first
100 WideRows records, application components, and React's development Profiler.
It never writes edited grid values back to SQL Server. **Open full workspace**
creates a synthetic workspace in that browser origin's IndexedDB; use the
separate port above to keep it apart from your usual dev workspace.

- **Measure catalog and typing helpers** measures mapping, metadata updates,
  source capture, snapshot preparation, and completion across a complete SQL
  string. The helper runs synchronously, so the measurement itself briefly blocks
  the page; this is not a simulated human typing test.
- **Open WideRows** measures the real grid. Edit a cell, use Tab/Shift+Tab across
  viewport boundaries, or resize/scroll. Only visible columns plus overscan are
  mounted; all drafts and clipboard data retain the full column set.
- **Open full workspace** measures the real App/sidebar/editor together.
  **Reset render samples** before typing to exclude initial hydration. Inspect
  `fullApp:update` for React render costs. These are not end-to-end keystroke or
  network latency measurements.
- Profile timings are development measurements and vary with CPU load, browser,
  viewport size and warmup. They are not enforced as flaky time-budget tests.

The ignored native test `mssql::tests::live_sqlserver_stress_performance` measures
connection plus catalog loading, catalog JSON serialization, three indexed
3-row reads, and three 100-row/121-column reads. Run it with the existing
`SQLSERVER_TEST_*` environment variables and Cargo's test runner (`--ignored
--nocapture`). This compiles/runs tests only, not a release application bundle.
It performs reads against `AdventureWorksLT2019_Test` and reports `STRESS_PERF`
JSON without credentials. Debug native timings should not be treated as release
performance or a reproduction of hotspot network conditions.


**Open local Stop check** opens a disposable local workspace with a long cross
join followed by `SELECT 99 AS must_not_run`. Run it, confirm **Stop** appears,
and stop it. The query should report cancellation, skip the second statement,
and allow a fresh `SELECT 42 AS answer` without rebuilding DuckDB. This executes
only in the isolated browser's worker, not in the SQL Server container. The
native `live_sqlserver_driver` integration test also checks that cancellation
interrupts WAITFOR within two seconds and that its request disappears from the
server DMV; the fixture login must have visibility into that DMV. It verifies
that the next query has the same @@SPID, retains temporary tables, and survives
repeated cancellation of streaming results with transaction/session state intact.

**Open connection UX check** uses official Tauri IPC mocks in the browser to
exercise the central connection manager, Stop, tool switching and shared-profile
workspaces. Its command counters are UI checks, not live SQL Server timings; the
native integration test above separately verifies real server cancellation.
