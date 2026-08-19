# Agent Note: SQLite schema 17 packed physical rows

Status: implemented

English | [中文](2026-08-19-sqlite-schema-17-packed-rows.zh.md)

## Problem

The SQLite backend stored every logical session event as a separate JSON-text row. High-frequency assistant chunks therefore paid row, JSON, and provenance overhead without changing the logical session contract. A physical rewrite must reduce that overhead without exposing storage tags to session consumers or weakening crash recovery and retention behavior.

## Decision

Schema 17 keeps the logical `SessionEvent[]` unchanged and packs only exact consecutive assistant text, reasoning, and tool-call delta runs. Physical tags identify packed rows; each row stores the first sequence and timestamp, bounded shared payload arrays, and timestamp deltas. Runs are limited to 1,024 logical events and 1 MiB uncompressed UTF-8 data. Scalar events remain scalar when they carry unknown fields, surface metadata, incompatible identities, gaps, unsafe timestamps, or an ignorable marker.

Payloads below 4 KiB remain SQLite text. Larger payloads use Zstandard level 3 only when the compressed BLOB is smaller. `sourceEventSeqs` remains complete and ordered, encoded as an unsigned first varint followed by ZigZag signed deltas. Decoding validates byte, sequence, timestamp, field, and varint limits before producing logical events.

Appending uses `BEGIN IMMEDIATE`, validates the logical physical tail under the write lock, packs only the new batch, and never rewrites earlier rows. Reads expand packed rows before coordinator validation. Suffix reads inspect the bounded predecessor span needed to include a request that begins inside a packed row. Recovery deletes a malformed physical tail from its physical first sequence and inserts synthetic closers transactionally; committed physical corruption remains an error.

The fork's `session_deletion_marks` table, list filtering, live-session protection, referenced-child protection, revision tracking, diagnostics, backups, and configurable journal/checkpoint settings remain part of schema 17. Existing schema versions are rejected; there is no implicit schema-16 migration.

## Alternatives considered

Keeping one JSON-text row per event was rejected because it retains avoidable physical row and provenance overhead for high-frequency chunks. Rewriting all prior rows during each append was rejected because it increases WAL traffic and makes crash recovery depend on a growing rewrite. An automatic schema-16 migration was rejected because interruption recovery, backup verification, disk-space requirements, and logical equivalence need a separately owned migration project. A generic compression layer was rejected because the SQLite schema must own its tags, limits, and decoder validation.

## Consequences

Long assistant streams use fewer physical rows and preserve exact logical chunks, timestamps, tool-call fragments, provenance, and ignorable events. Physical SQL readers must understand the packed tags or use the provider. Packed runs split at write-batch boundaries, so compression ratio depends on batching. `DatabaseSync`, compression, and decompression remain synchronous and can block the event loop.

Operators must back up or export schema-16 databases before switching to this build. The provider fails closed on foreign schemas, malformed packed rows, stale append tails, invalid provenance, and oversized packed data rather than guessing at recovery.

## Verification

Codec and compression tests cover packing, partitioning, Zstandard selection, provenance round trips, storage-tag collisions, malformed rows, and removable tails. Differential integration coverage compares the restored logical log and suffixes with the append input and observes the physical packed-row count. The existing SQLite contract, retention, repair, backup, and integrity suites remain green.
