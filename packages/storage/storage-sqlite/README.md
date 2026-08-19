# @deepseek-ai/dsh-storage-sqlite

English | [中文](README.zh.md)

SQLite backend for the [storage hub](../storage/README.md): registers as backend `sqlite`, serving the `kv` facet over one `node:sqlite` database file (or `:memory:`). Design and trade-offs: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Storage model

Document-per-row: each unit table becomes a physical `"u_<unit>_<table>" (key TEXT PRIMARY KEY, value TEXT)` STRICT table whose `value` is the record's JSON text, so one key updates one row (the reason to route a high-churn domain here instead of the JSON backend). Unit identity lives in two metadata tables — `units` stamps each unit's format version at first open and rejects a differing descriptor with `version-mismatch`; `unit_globals` holds each unit's global singleton row. The physical layout version lives in `PRAGMA user_version`; any other stamped value rejects (unreleased format, no migrations). Unit and table names are validated against the hub's `UNIT_NAME_RE` before they reach DDL, so no external input is ever interpolated into SQL identifiers.

Every write primitive is a single prepared statement — SQLite's per-statement atomicity satisfies the KV contract without explicit transactions, and write ordering stays the caller's responsibility (the domain layer's write chain). The connection waits up to `busyTimeoutMs` (default `5000` ms) for locks and uses `synchronous=FULL` by default; `synchronous=NORMAL` is an explicit deployment trade-off. SQLite's WAL auto-checkpoint threshold is explicit as `walAutocheckpointPages` (default `1000` pages), and `0` delegates checkpoint timing to host maintenance. Missing directories and database files are created owner-only (`0o700`/`0o600`), matching the session-persistence SQLite backend.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
  busyTimeoutMs?: number   // SQLite lock wait; 1..120000 ms, default 5000
  synchronous?: 'full' | 'normal'   // connection durability; default 'full'
  walAutocheckpointPages?: number   // WAL auto-checkpoint threshold; 0..1000000, default 1000
}
```

## Diagnostics and backups

`SqliteStorageBackend.checkIntegrity()` runs SQLite's `integrity_check` and `foreign_key_check` pragmas. `SqliteStorageBackend.backup(destination)` uses the online backup API and replaces an existing destination with a consistent database image. `SqliteStorageBackend.checkpoint(mode?)` runs a bounded `PASSIVE` checkpoint by default and returns SQLite's progress counters. These are host-side maintenance APIs and return no model-visible data.

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data (workspace records, future session sidecar metadata) behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- **`DatabaseSync` is synchronous** — each write and diagnostic blocks the event loop for its duration; acceptable at domain-data scale.
- **Lock handling is bounded** — another connection holding a write transaction can block for at most `busyTimeoutMs`, then the operation fails; the backend does not retry it.
- **Only the current `STORAGE_SQLITE_SCHEMA_VERSION` opens** — any other stamped version is rejected rather than migrated (pre-release stance).
- **Checkpoint scheduling is host-owned when disabled** — `walAutocheckpointPages: 0` disables SQLite's automatic threshold but does not create a replacement timer; callers must invoke `checkpoint()` during an owned maintenance window.
- **`openDatabase` duplicates the session-persistence SQLite open sequence** — extraction into a shared media layer is deferred to the planned session-backend migration (see the Agent Note's reuse audit).
