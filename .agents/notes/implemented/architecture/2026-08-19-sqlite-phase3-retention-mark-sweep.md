# Agent Note: SQLite Phase 3 retention mark-and-sweep

Status: implemented

English | [中文](2026-08-19-sqlite-phase3-retention-mark-sweep.zh.md)

## Problem

Phase 1 deliberately left session deletion open because a raw delete could remove durable history while forks, live sessions, query projections, attachments, exports, or other clients still depend on it. The SQLite backend now needs bounded retention without turning cleanup into an implicit background job or deleting artifacts whose ownership it cannot prove.

## Decision

The session-persistence service exposes provider-optional `markForDeletion(ids, reason?)`, `listDeletionMarks()`, and bounded `sweepMarked(limit?)` operations. The inherited service defaults reject these operations explicitly, so providers that cannot persist deletion state do not silently claim retention support.

The SQLite provider stores marks in a `session_deletion_marks` table and increments the schema version from `15` to `16`. Marking is transactional and idempotent: missing ids, already-marked ids, and ids currently bound to a live `Session` are reported separately. A marked session is excluded from normal `list`, snapshot, page, and load-source reads, and new appends fail. A mark reason is optional and capped at 256 characters.

A sweep considers at most the requested bounded limit in deterministic mark order. It deletes a marked session only when it is not live and no materialized child has an unmarked `parent_session` reference. SQLite foreign-key cascades remove the session's events and deletion mark in the same transaction. Protected marks remain for a later sweep, and the result reports deleted, live-protected, referenced-protected, and remaining counts. After a commit, the provider invalidates coordinator state for each deleted id so a later session with the same id can be created without reusing a deleted cursor or preparation.

The operation owns only the SQLite session row, its event rows, and its deletion mark. It does not remove attachment files, query-index rows, exports, or other projections. Those consumers need explicit reconciliation and ownership hooks before their data can be collected.

## Alternatives considered

**Delete sessions directly by id.** Rejected: an unconditional delete would bypass live-session protection, fork lineage, and an operator-visible maintenance state.

**Delete immediately when a mark is created.** Rejected: mark-and-sweep separates policy selection from bounded destructive work, allows operators to inspect marks, and gives live or referenced sessions a safe retry path.

**Delete marked parents even when an unmarked child exists.** Rejected: a child retains a durable lineage reference to its parent; deleting the parent would make that reference unresolved and could remove history needed to understand the fork.

**Garbage-collect attachments and projections in the session provider.** Rejected: the provider has no authoritative enumeration or ownership protocol for those stores, so deleting their data would be unsafe.

**Run an automatic retention timer.** Deferred: scheduling, policy selection, cross-process coordination, and user-facing visibility need a host-owned lifecycle. The shipped API is explicit and bounded rather than an unowned background job.

## Consequences

SQLite deployments can mark and sweep old sessions without an unbounded delete transaction or silent disappearance from the maintenance surface. Marked sessions stop receiving writes and disappear from ordinary reconciliation, which makes deletion intent visible while preventing new durable work from racing the sweep. Fork parents may remain marked until all unmarked children are also marked.

The SQLite schema is intentionally rejected by older or newer builds rather than migrated. Non-SQLite persistence providers retain the existing session data because the default service methods fail instead of pretending to support deletion. Attachment, projection, export, multi-process, and external-client retention semantics remain follow-on work.

## Verification

The SQLite persistence suite covers idempotent marks, missing and live ids, marked-session visibility, child-reference protection, cascading deletion, bounded sweeps, reason validation, and schema version `16`. Repository typecheck, lint, package invariants, translation pairing, documentation sync, and focused SQLite tests remain required after this change.
