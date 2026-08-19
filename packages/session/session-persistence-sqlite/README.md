# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

A SQLite durable session-persistence backend — a second `SessionPersistence` provider ([session persistence](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)) satisfying the same contract as `dsh-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over `node:sqlite` rows instead of file bytes.

`locate(meta)` returns `undefined`: all sessions share one database, so there is no honest independent per-session transcript path.

## Storage model

Each `SessionEvent` maps 1:1 onto a row in an `events` table `(session_id, seq, type, time, data, source_event_seqs, surface_op)` — `data` is the event payload as JSON text, so the row shape is the event verbatim (including `assistant/chunk`, keeping `seq` contiguous). The two `TEXT` columns `source_event_seqs` and `surface_op` are nullable; they store the event's optional surface-metadata fields (see [session surface](../../../.agents/notes/implemented/architecture/2026-06-18-session-surface.md)). Out-of-log metadata (`SessionHeader`), a per-materialization incarnation id, and a monotonic per-log revision live in a `sessions` row; `createdAt` is a non-negative safe integer stored in a strict `INTEGER` column. A singleton state row carries the immutable store id. A `sessions` row is written only by the first `append` — its existence is the lazy-materialization signal (`list` reports exactly the sessions that have a row). Deletion marks live in `session_deletion_marks`; they are durable maintenance state, not session events, and are removed with their session by the foreign-key cascade.

The repository's Node range supports unflagged `node:sqlite`. The database enables foreign keys, waits up to the configured `busyTimeoutMs` for a lock (default `5000` ms), and uses the configured journal mode (`wal` by default; use a rollback mode where WAL shared-memory files are unsuitable). Connections use `synchronous=FULL` by default; `synchronous=NORMAL` is an explicit throughput/durability trade-off for deployments that choose it. SQLite's native WAL auto-checkpoint threshold is explicit as `walAutocheckpointPages` (default `1000` pages); setting it to `0` disables automatic checkpoints for an operator-owned maintenance schedule. `PRAGMA application_id` identifies the canonical persistence database, and `PRAGMA user_version` stores its layout version. A fresh database must have no application identity or user-defined schema objects; initialization creates every table and stamps both pragmas in one transaction. Non-pristine unversioned databases, foreign application identities, and every non-current version reject before journal-mode mutation because this unreleased format has no migrations.

On filesystems with POSIX modes, the backend requests mode `0700` for missing directories and exclusively creates a missing database with mode `0600` before SQLite opens it; the process umask may further restrict both. New WAL, shared-memory, and persistent rollback-journal sidecars receive the database's resulting owner-only mode. Existing directories, database files, and sidecars keep their modes; filesystem setup errors other than an existing database fail initialization. These defaults prevent incidental exposure through a permissive process umask, but do not protect database confidentiality or integrity when another principal can replace the database entry in its parent directory.

## Contract semantics over rows

- **Append = a transaction.** `append` runs `BEGIN`/`COMMIT` around the batch: it materializes the `sessions` row (if still lazy) and INSERTs every event, asserting the contiguous-seq contract first (the first event's `seq` must equal the stored next-seq). A mid-batch failure (a UNIQUE violation on a duplicated seq) rolls back entirely, so the stored log and the in-memory cursor stay consistent. (`load()` already balanced the stored log, so `append` never has to repair a crash tail.)
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session has no `sessions` row, so it is absent from `list()` (which reports exactly the sessions that have a row).
- **Interrupted-turn close on load.** `load()` implements the shared [crash-recovery contract](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md): preserve the valid interrupted turn, append its synthetic closing events in one transaction, and remove only a torn tail row. Committed parse errors or sequence gaps make the session unloadable. Because recovery mutates stored rows, the next append starts from a balanced log and accurate cursor.
- **Non-mutating inspection.** `inspect()` returns an immutable balanced logical view and may synthesize recovery closers in memory, without deleting a torn tail row, appending recovery rows, or changing the lightweight revision.
- **Lightweight revisions.** `listSnapshots(signal?)` combines the immutable store and database-file identity, a per-materialization incarnation id, and a per-session counter incremented in each mutating transaction. A full-prefix read captures that revision and its event rows in one read transaction, while `readStoredRevision()` queries only the session row to validate retained preparations. This keeps unchanged observations stable without parsing event rows and distinguishes independent stores and recreated same-id logs. It checks cancellation before and after shared readiness and the synchronous metadata query; the query itself is non-preemptible.
- **Mark-and-sweep retention.** `markForDeletion(ids, reason?)` durably records idempotent marks for materialized, cold sessions. Marked sessions disappear from normal listing and reject new appends. `sweepMarked(limit?)` deletes only cold marks whose sessions have no unmarked children; foreign-key cascades remove their events and marks. Live sessions and referenced parents remain marked for a later pass. Attachment files and other projections are not collected by this operation.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
  busyTimeoutMs?: number   // SQLite lock wait; 1..120000 ms, default 5000
  synchronous?: 'full' | 'normal'   // connection durability; default 'full'
  walAutocheckpointPages?: number   // WAL auto-checkpoint threshold; 0..1000000, default 1000
  preparedSessionCacheSize?: number   // positive integer; default 5
  writeBatchMaxDelayMs?: number   // positive integer; default 200; maximum 2_147_483_647
}
```

## Write path

Like the JSONL backend, the plugin copies each frozen `session/event` into one controller per live session. The first pending event starts the configured fixed batching window, and later events join without resetting it. Expiry starts one transaction; events admitted during that write form a separately bounded follow-up batch. `session/flush` cancels the wait and drains current and pending batches. The controller persists a fork's seed once, keeps a write cursor so resume never re-appends stored events, and seeds live sessions on apply because HMR does not replay `session/created`. Dispose drains every retained controller before closing the database. Every event remains a separate SQLite row; batching only groups more INSERTs into one transaction and revision increment.

## Diagnostics and backups

`SqliteSessionPersistence.checkIntegrity()` runs SQLite's `integrity_check` and `foreign_key_check` pragmas and returns the raw findings plus `ok`. `SqliteSessionPersistence.backup(destination)` uses Node's online backup API, so the source remains usable while SQLite copies a consistent database image; it replaces an existing destination. `SqliteSessionPersistence.checkpoint(mode?)` runs a serialized `PASSIVE` checkpoint by default and returns SQLite's `busy`, `log`, and `checkpointed` counters. `listSnapshotsPage(limit, cursor?, signal?)` provides bounded keyset pages ordered by `createdAt` descending and id ascending. `markForDeletion`, `listDeletionMarks`, and `sweepMarked` are explicit host-side retention operations; they do not emit session events or become model-visible tools.

## Model Experience

### Resumed conversation history

#### What the model sees

SQLite storage contributes no live prompt or schema. Loading restores the same surface history as JSONL and preserves prior headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Row metadata and raw chunks are not messages.

#### Token effect

Zero live-request tokens. Resume restores retained history and pays the current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

SQLite storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

- **`DatabaseSync` is synchronous** — every append transaction and diagnostic statement blocks the event loop for its duration; acceptable for local stores, a throughput ceiling for busy multi-session servers.
- **Lock handling is bounded, not infinite** — the connection waits up to `busyTimeoutMs`, then fails; callers still need to surface a durable-write failure and retry at an appropriate lifecycle boundary rather than hiding indefinite contention.
- **`synchronous=FULL` is the default, not a power-loss guarantee for the whole host** — filesystem, device, and operating-system failure semantics remain outside the process contract. `NORMAL` is available only as an explicit deployment choice.
- **Only a pristine new database or the current owned `SCHEMA_VERSION` opens** — unversioned schema objects, foreign application identities, and every other schema version are rejected rather than migrated (unreleased software; no persisted user data to preserve).
- **Mark-and-sweep does not collect every dependent artifact** — the SQLite provider protects live sessions and unmarked child references, then cascades deletion only across the session row, deletion mark, and event rows. Query indexes, attachments, exports, and other projections require their own reconciliation or ownership hooks before they can be collected safely.
- **TODO:** this backend talks to `node:sqlite` directly. If a cordis database service (`cordis/db` / a `@cordisjs` SQL driver plugin) is adopted, route through that instead of holding a raw `DatabaseSync` here — the contract surface (`SessionPersistence`) would not change, only the storage driver.
