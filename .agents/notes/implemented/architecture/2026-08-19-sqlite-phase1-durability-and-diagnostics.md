# Agent Note: SQLite Phase 1 durability and maintenance foundations

Status: implemented

English | [中文](2026-08-19-sqlite-phase1-durability-and-diagnostics.zh.md)

## Problem

The SQLite session, query-index, and KV backends opened `DatabaseSync` connections without an explicit busy timeout or synchronous level. A competing writer therefore failed immediately, while the durability setting depended on SQLite's connection default. Session suffix reads also selected metadata and events in separate statements, and operators had no backend-owned integrity or online-backup entry point.

## Decision

All three first-party SQLite backends now accept the same connection policy:

- `busyTimeoutMs` defaults to `5000` and is bounded to `1..120000`.
- `synchronous` defaults to `full`; `normal` is available only as an explicit deployment choice.
- The validated timeout is passed to Node's `DatabaseSync` constructor, which installs SQLite's native busy handler. No JavaScript sleep loop or unbounded retry was added.
- The synchronous level is applied with `PRAGMA synchronous` after journal-mode selection. It is connection-local and does not alter a canonical session database when used by the disposable query index.

Session SQLite suffix reads now capture the metadata row and selected event rows in one read transaction. Full prefix reads already used a transaction; this keeps the seek path from mixing a session header from one point in time with events from another.

The session-persistence, query-index, and KV backends expose host-side `checkIntegrity()` methods backed by SQLite's `integrity_check` and `foreign_key_check` pragmas. Session persistence, the query index, and KV storage also expose `backup(destination)` through Node's Online Backup API. Backups are maintenance operations, replace an existing destination, and do not become model-visible tools or session events.

Retention and deletion are now provided by the Phase 3 SQLite mark-and-sweep operation. It durably marks cold sessions and deletes only marked sessions without unmarked children, while query projections, attachments, exports, and external-client visibility remain separate ownership decisions; a raw `DELETE FROM sessions` API remains intentionally unavailable.

## Alternatives considered

**Rely on SQLite defaults.** Rejected: the durability and lock behavior would vary with the runtime and remain invisible in deployment configuration.

**Retry locked operations in JavaScript.** Rejected: SQLite's native busy timeout provides bounded lock handling without duplicate transaction logic or retrying an operation whose transaction outcome is unclear.

**Copy the database file for backups.** Rejected: SQLite's Online Backup API is designed to create a consistent image while the source is in use; direct file copies are unsafe with active WAL state.

**Add deletion in Phase 1.** Rejected until the ownership and reference policy is defined.

## Consequences

Local writes tolerate short lock contention and fail explicitly after the configured bound. `FULL` makes the durability choice visible and conservative by default, while `NORMAL` lets a deployment choose the documented WAL trade-off. The connection remains synchronous, so long transactions and integrity checks can still block the event loop. Online backups and integrity checks provide operational recovery signals but do not provide encryption, multi-process coordination, or a retention policy.

No schema version changed because the database layout did not change; the additions are connection configuration and maintenance methods.

## Verification

The SQLite persistence, query-index, and KV suites cover default `FULL`, explicit `NORMAL`, native busy-timeout configuration, clean integrity diagnostics, online backups, and copied data. The persistence suite also covers the transactional seek read path. Repository typecheck, lint, package invariants, and documentation gates remain required after these changes.
