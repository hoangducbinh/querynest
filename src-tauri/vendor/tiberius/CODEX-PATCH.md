# Local Tiberius 0.12.3 patch

Based on the unmodified crates.io 0.12.3 source, retaining its MIT/Apache licenses.
The application patches this exact version with Cargo's `[patch.crates-io]`.

Added `CancelHandle` and `Client::cancellation_handle()` for query-scoped TDS
ATTENTION. A request is armed immediately before query execution. `cancel()`
sets a flag and wakes the existing packet reader. `Connection::poll_next` injects
the empty ATTENTION packet through the negotiated TLS/TDS transport, only after
the original request has finished sending. The original token decoder remains
alive: callers must never drop it during cancellation and attempt to reuse the
same wire stream. EOF is withheld until a DONE_ATTN token is parsed, preserving
ENVCHANGE and transaction descriptor processing. Idle cancellation is ignored.

The app waits for the original query to drain and the attention acknowledgement.
A failed transport or a five-second acknowledgement timeout invalidates the wire
session; a normal acknowledged cancellation keeps its physical session. The
native authentication context remains available for explicit recovery.

Protocol references:
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/dc28579f-49b1-4a78-9c5f-63fbda002d2e
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/f8aa004e-bf76-4f94-bd5b-39597a888146

Regression coverage in `mssql::tests::live_sqlserver_driver` cancels WAITFOR and
streaming result sets repeatedly, verifies no remaining server request, and
checks unchanged SPID, local temporary table, CONTEXT_INFO and open transaction.
