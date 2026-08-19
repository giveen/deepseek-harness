# Agent Note: SQLite Phase 2 checkpoint, index, and paging foundations

Status: implemented

English | [中文](2026-08-19-sqlite-phase2-checkpoint-index-paging.zh.md)

## Problem

Phase 1 made SQLite durability and maintenance choices explicit, but the providers still relied on SQLite's implicit WAL threshold, rebuilt every changed FTS session from its first document, and exposed persistence snapshots as one unbounded result set. Those choices were correct for small stores but made maintenance timing and growth costs implicit.

## Decision

The first Phase 2 slice keeps ownership in the existing providers:

- All first-party SQLite providers expose `walAutocheckpointPages`, defaulting to SQLite's 1000-page threshold and bounded to `0..1_000_000`. Zero disables automatic checkpoints without starting an application timer.
- All first-party SQLite providers expose `checkpoint(mode)`, serialized by the owning service where the provider already serializes operations. `passive` is the default; SQLite returns `busy`, `log`, and `checkpointed` counters so an operator can distinguish incomplete work from a clean checkpoint.
- `SessionPersistence.listSnapshotsPage()` adds a bounded snapshot-page seam with a compatibility fallback for third-party backends. The SQLite session backend overrides it with a `(created_at DESC, id ASC)` keyset query. The SQLite query provider consumes pages while preserving its stable before/after observation comparison.
- SQLite FTS reconciliation appends only when the existing indexed documents are an exact prefix of the newly observed documents. Repairs, rewrites, and first materialization use the existing full replacement path. This preserves correctness for non-append changes while avoiding repeated tokenization and FTS row replacement for ordinary live growth.

No SQLite layout version changed. The checkpoint threshold is connection configuration, persistence page cursors are derived from metadata, and FTS incremental writes use existing rows and columns.

## Alternatives considered

**Create a process timer for checkpoints.** Rejected: every provider would own another lifecycle and timer, and timers would compete with SQLite's native threshold. A zero threshold plus an explicit maintenance call is available when the host owns scheduling.

**Always use `FULL` checkpoints.** Rejected: `PASSIVE` is the safe default for an administrative call because it does not wait for readers or force a restart. Callers can request `FULL`, `RESTART`, or `TRUNCATE` when their maintenance window permits it.

**Append every changed FTS document without prefix verification.** Rejected: a repair or rewrite could leave stale rows and duplicate search hits. Prefix comparison is the admission condition; otherwise the atomic replacement path remains authoritative.

**Replace the abstract listing contract with a required page method.** Rejected: third-party persistence providers would break immediately. The base service supplies a bounded compatibility fallback, while SQLite owns the efficient override.

**Move every DatabaseSync operation to a worker thread in this slice.** Deferred: Node documents workers as useful for CPU-intensive work, while this change would require a new request protocol, worker lifecycle, error propagation, and artifact-plane build path. The operational/query improvements are independently useful and lower risk.

## Consequences

Operators can tune WAL growth and invoke checkpoints without relying on an undocumented SQLite default. A disabled automatic threshold is intentionally not self-scheduling; the host that disables it owns the maintenance cadence and observes the returned counters. Persistence observers receive bounded database pages and retain the existing stable-observation retry semantics. Ordinary append-only FTS growth writes only the new tail, while repair and rewrite cases remain full replacements.

`DatabaseSync` remains synchronous and can still block the event loop during a checkpoint, FTS transaction, or query. Multi-process ownership and network-filesystem restrictions remain unchanged. Phase 3 adds provider-owned mark-and-sweep retention for cold, unreferenced sessions; attachment, projection, and worker isolation remain separate decisions.

## Verification

The SQLite persistence, query-index, and KV suites cover the default and configured WAL thresholds, checkpoint reports, snapshot keyset paging, and append-only FTS tail preservation. The three focused suites pass 190 tests together, and the affected package TypeScript projects pass after the changes.
