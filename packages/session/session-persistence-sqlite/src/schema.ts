/**
 * Schema + load-time helpers for the SQLite session-persistence backend: the
 * DDL (a store-identity row, `sessions` metadata, and scalar or packed
 * `events` rows), the database open/configure step, and the last-`turn/end`
 * cut that gives the SQLite backend the SAME crash-tail-on-load semantics as
 * the JSONL backend.
 *
 * @module dsh-session-persistence-sqlite/schema
 */

import { randomUUID } from 'node:crypto'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import type { SessionEvent, SurfaceEventType, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { decodeRow, scanRows as scanPhysicalRows } from './compression.ts'

/**
 * The on-disk schema version. Bumped only on a breaking change to the table
 * layout; orthogonal to a session's own `version` (which versions the EVENT
 * vocabulary, stored per session in the `sessions` row).
 */
export const SCHEMA_VERSION = 17

/** SQLite application id protecting unrelated databases from persistence writes. */
export const SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 0x44534850

/**
 * A row of the `sessions` table — the out-of-log metadata ({@link SessionHeader}).
 * The row's EXISTENCE is the materialization signal: it is written only by the
 * first `append` (lazy materialization), so a created-but-never-appended
 * session has no row and is absent from `list`, mirroring the JSONL
 * backend's "no file until first append".
 */
export interface SessionRow {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  origin: 'subagent' | null
  /** Stable identity assigned when this log is materialized. */
  incarnation: string
  /** Monotonic log-change token incremented in each mutating transaction. */
  revision: number
  delegation_depth: number | null
  agent_preset: string | null
}

/** A durable deletion mark row. */
export interface DeletionMarkRow {
  session_id: string
  marked_at: number
  reason: string | null
}

/** An `events` table row: one `SessionEvent` mapped 1:1 (`data` is JSON text). */
export interface EventRow {
  seq: number
  type: string
  time: number
  /** JSON text or a Zstandard-compressed BLOB. */
  data: string | Uint8Array
  /** Delta-encoded provenance BLOB, or null. */
  source_event_seqs: Uint8Array | string | null
  /** JSON-encoded `SurfaceOp` — how the event entered the surface, or null. */
  surface_op: string | null
  /** `1` iff the event carries the envelope's `ignorable: true` marker, else null. */
  ignorable: number | null
}

/**
 * Journal modes the backend will run under. `wal` is the default and the
 * durability model the persistence ADR records; the rollback-journal modes
 * (`delete`/`truncate`/`persist`) exist for filesystems where WAL's
 * shared-memory files do not work (network mounts). `memory`/`off` are
 * excluded: dropping journal durability silently contradicts what this
 * backend promises.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** SQLite connection durability levels supported by the session backend. */
export type SynchronousMode = 'full' | 'normal'

/** SQLite checkpoint modes accepted by `PRAGMA wal_checkpoint`. */
export type CheckpointMode = 'passive' | 'full' | 'restart' | 'truncate'

/** Default maximum wait for SQLite locks before an operation fails. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/** Maximum configurable SQLite lock wait. */
export const MAX_BUSY_TIMEOUT_MS = 120_000

/** Default WAL automatic-checkpoint threshold in pages. */
export const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1_000

/** Maximum configurable WAL automatic-checkpoint threshold in pages. */
export const MAX_WAL_AUTOCHECKPOINT_PAGES = 1_000_000

/** Default connection durability level. */
export const DEFAULT_SYNCHRONOUS_MODE: SynchronousMode = 'full'

/** Result returned by one WAL checkpoint operation. */
export interface SqliteCheckpointReport {
  /** Requested checkpoint mode. */
  mode: CheckpointMode
  /** Non-zero when SQLite could not complete the requested checkpoint. */
  busy: number
  /** WAL frames remaining after the checkpoint attempt. */
  log: number
  /** WAL frames copied into the database by the checkpoint attempt. */
  checkpointed: number
}

/** Connection options applied before the database is exposed to the backend. */
export interface SqliteOpenOptions {
  /** Maximum lock wait in milliseconds. */
  busyTimeoutMs?: number | undefined
  /** SQLite synchronous level. */
  synchronous?: SynchronousMode | undefined
  /** WAL automatic-checkpoint threshold in pages; zero disables it. */
  walAutocheckpointPages?: number | undefined
}

/** Result of a database integrity diagnostic. */
export interface SqliteIntegrityReport {
  /** Whether both integrity checks reported a clean database. */
  ok: boolean
  /** Results returned by `PRAGMA integrity_check`. */
  integrityCheck: readonly string[]
  /** Rows returned by `PRAGMA foreign_key_check`. */
  foreignKeyViolations: readonly ForeignKeyViolation[]
}

/** One row returned by SQLite's foreign-key diagnostic. */
export interface ForeignKeyViolation {
  table: string
  rowid: number
  parent: string
  fkid: number
}

/**
 * Open the database and apply its schema and pragmas. An empty database with a
 * zero `user_version` is initialized at {@link SCHEMA_VERSION}; a nonempty
 * unversioned database and every other non-current version reject rather than
 * being migrated in place.
 * @param path - the SQLite database file to open (created when absent).
 * @param journalMode - validated journal pragma.
 * @param options - connection timeout, synchronous durability, and WAL checkpoint settings.
 * @returns the open handle with pragmas applied and all three tables ensured.
 */
export function openDatabase(
  path: string,
  journalMode: JournalMode,
  options: SqliteOpenOptions = {},
): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  const synchronous = options.synchronous ?? DEFAULT_SYNCHRONOUS_MODE
  const walAutocheckpointPages = options.walAutocheckpointPages ?? DEFAULT_WAL_AUTOCHECKPOINT_PAGES
  assertOpenOptions(busyTimeoutMs, synchronous, walAutocheckpointPages)
  const db = new DatabaseSync(path, { timeout: busyTimeoutMs })
  try {
    configureDatabase(db, path, journalMode, synchronous, walAutocheckpointPages)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(
  db: DatabaseSync,
  path: string,
  journalMode: JournalMode,
  synchronous: SynchronousMode,
  walAutocheckpointPages: number,
): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA trusted_schema = OFF')
  db.exec('PRAGMA mmap_size = 0')
  let began = false
  try {
    db.exec('BEGIN IMMEDIATE')
    began = true
    // Validate while holding the write lock so no other connection can change
    // schema ownership between inspection and initialization.
    const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count: userObjectCount } = db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    ).get() as { count: number }
    if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
      throw new Error(`session database at "${path}" has an unversioned schema or application identity`)
    }
    if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
      throw new Error(`session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`)
    }
    if (onDisk === SCHEMA_VERSION && applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
      throw new Error(
        `session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`,
      )
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS persistence_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        id               TEXT PRIMARY KEY,
        version          INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        cwd              TEXT,
        parent_session   TEXT,
        seed_length      INTEGER,
        origin           TEXT,
        delegation_depth INTEGER,
        agent_preset    TEXT,
        incarnation      TEXT NOT NULL,
        revision         INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_deletion_marks (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        marked_at  INTEGER NOT NULL,
        reason     TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq               INTEGER NOT NULL,
        type              TEXT NOT NULL,
        time              INTEGER NOT NULL,
        data              ANY NOT NULL,
        source_event_seqs ANY,
        surface_op        TEXT,
        ignorable         INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1)),
        PRIMARY KEY (session_id, seq)
      ) STRICT
    `)
    validateOwnedSchema(db, path)
    db.prepare(
      'INSERT OR IGNORE INTO persistence_state (singleton, store_id) VALUES (1, ?)',
    ).run(randomUUID())
    if (onDisk === 0) {
      db.exec(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    db.exec('COMMIT')
    began = false
  } catch (error: unknown) {
    /* v8 ignore next -- a BEGIN failure leaves no transaction to roll back. */
    if (began) {
      /* v8 ignore next 5 -- preserve the original schema failure if SQLite also refuses rollback. */
      try {
        db.exec('ROLLBACK')
      } catch {
        // The original SQLite failure remains the actionable cause.
      }
    }
    throw error
  }
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  // Apply it only after ownership validation and initialization commit.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  db.exec(`PRAGMA synchronous = ${synchronous.toUpperCase()}`)
  db.exec(`PRAGMA wal_autocheckpoint = ${walAutocheckpointPages}`)
  const trustedSchema = (db.prepare('PRAGMA trusted_schema').get() as { trusted_schema: number }).trusted_schema
  const mmapRow = path === ':memory:' ? undefined : db.prepare('PRAGMA mmap_size').get() as { mmap_size: number } | undefined
  const mmapSize = mmapRow?.mmap_size ?? 0
  const synchronousValue = (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous
  if (trustedSchema !== 0) throw new Error(`session database at "${path}" retained trusted_schema=${trustedSchema}, expected 0`)
  if (mmapSize !== 0) throw new Error(`session database at "${path}" retained mmap_size=${mmapSize}, expected 0`)
  const expectedSynchronous = synchronous === 'full' ? 2 : 1
  if (synchronousValue !== expectedSynchronous) throw new Error(`session database at "${path}" retained synchronous=${synchronousValue}, expected ${expectedSynchronous}`)
}

/**
 * Revalidate application ownership and exact table columns inside a mutation transaction.
 * @param db - open SQLite database with the caller's mutation transaction active.
 * @param path - database path used in ownership diagnostics.
 */
export function validateDatabaseSchema(db: DatabaseSync, path: string): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  if (applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
    throw new Error(`session database application id changed before mutation (expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}, got ${applicationId})`)
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(`session database schema changed before mutation (expected ${SCHEMA_VERSION}, got ${version})`)
  }
  validateOwnedSchema(db, path)
}

function validateOwnedSchema(db: DatabaseSync, path: string): void {
  const objects = db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
    .all() as Array<{ type: string; name: string }>
  const expected = [
    { type: 'table', name: 'events' },
    { type: 'table', name: 'persistence_state' },
    { type: 'table', name: 'session_deletion_marks' },
    { type: 'table', name: 'sessions' },
  ]
  if (JSON.stringify(objects) !== JSON.stringify(expected)) {
    throw new Error(`session database at "${path}" does not contain the required schema objects`)
  }
  const columns: Record<string, readonly string[]> = {
    persistence_state: ['singleton', 'store_id'],
    sessions: ['id', 'version', 'created_at', 'cwd', 'parent_session', 'seed_length', 'origin', 'delegation_depth', 'agent_preset', 'incarnation', 'revision'],
    session_deletion_marks: ['session_id', 'marked_at', 'reason'],
    events: ['session_id', 'seq', 'type', 'time', 'data', 'source_event_seqs', 'surface_op', 'ignorable'],
  }
  for (const [table, expectedColumns] of Object.entries(columns)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
    if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
      throw new Error(`session database at "${path}" does not contain the required schema columns for ${table}`)
    }
  }
}

function assertOpenOptions(
  busyTimeoutMs: number,
  synchronous: SynchronousMode,
  walAutocheckpointPages: number,
): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new TypeError(`busyTimeoutMs must be an integer between 1 and ${MAX_BUSY_TIMEOUT_MS}`)
  }
  const synchronousValue = synchronous as string
  if (synchronousValue !== 'full' && synchronousValue !== 'normal') {
    throw new TypeError(`synchronous must be "full" or "normal", got "${synchronousValue}"`)
  }
  if (
    !Number.isSafeInteger(walAutocheckpointPages)
    || walAutocheckpointPages < 0
    || walAutocheckpointPages > MAX_WAL_AUTOCHECKPOINT_PAGES
  ) {
    throw new TypeError(`walAutocheckpointPages must be an integer between 0 and ${MAX_WAL_AUTOCHECKPOINT_PAGES}`)
  }
}

/**
 * Run one bounded WAL checkpoint on an open database.
 * @param db - open SQLite connection.
 * @param mode - checkpoint strategy.
 * @returns SQLite's checkpoint progress counters.
 */
export function checkpointDatabase(db: DatabaseSync, mode: CheckpointMode = 'passive'): SqliteCheckpointReport {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode.toUpperCase()})`).get() as {
    busy: number
    log: number
    checkpointed: number
  }
  return { mode, busy: row.busy, log: row.log, checkpointed: row.checkpointed }
}

/**
 * Run SQLite's structural and foreign-key diagnostics on an open connection.
 * @param db - open database handle.
 * @returns diagnostic rows without mutating the database.
 */
export function checkDatabaseIntegrity(db: DatabaseSync): SqliteIntegrityReport {
  const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  const integrityCheck = integrityRows.map(row => row.integrity_check)
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown as ForeignKeyViolation[]
  return {
    ok: integrityCheck.length === 1 && integrityCheck[0] === 'ok' && foreignKeyViolations.length === 0,
    integrityCheck,
    foreignKeyViolations,
  }
}

/**
 * Back up an open database through SQLite's online backup API.
 * @param db - open source database handle.
 * @param destination - destination database path.
 * @returns the number of copied pages.
 */
export async function backupDatabase(db: DatabaseSync, destination: string): Promise<number> {
  return sqliteBackup(db, destination)
}

/**
 * Reconstruct the {@link SessionHeader} from a `sessions` row.
 * @param row - the `sessions` table row.
 * @returns the header, `NULL` columns mapped to omitted optional fields.
 */
export function rowToMeta(row: SessionRow): SessionHeader {
  if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) {
    throw new Error('stored session createdAt must be a non-negative safe integer')
  }
  return {
    version: row.version,
    id: row.id as SessionId,
    createdAt: row.created_at,
    ...row.cwd !== null ? { cwd: row.cwd } : {},
    ...row.parent_session !== null ? { parentSession: row.parent_session as SessionId } : {},
    ...row.seed_length !== null ? { seedLength: row.seed_length } : {},
    ...row.origin !== null ? { origin: row.origin } : {},
    ...row.delegation_depth !== null ? { delegationDepth: row.delegation_depth } : {},
    ...row.agent_preset !== null ? { agentPreset: row.agent_preset } : {},
  }
}

/**
 * Reconstruct one logical {@link SessionEvent} from an `events` row. Packed
 * rows are rejected here because callers that need physical expansion use
 * {@link decodeRow} through {@link scanRows}.
 * @param row - the `events` table row; scalar data and surface columns hold JSON text.
 * @returns the reconstructed event; throws when a row is packed or a JSON column
 *   fails to parse ({@link scanRows} treats that as a hole in the tail).
 */
export function rowToEvent(row: EventRow): SessionEvent {
  if (typeof row.source_event_seqs === 'string') {
    return {
      type: row.type as SessionEvent['type'],
      seq: row.seq,
      time: row.time,
      data: JSON.parse(row.data as string) as SessionEvent['data'],
      sourceEventSeqs: JSON.parse(row.source_event_seqs) as number[],
      ...row.surface_op !== null ? { surfaceOp: JSON.parse(row.surface_op) as SessionEvent<SurfaceEventType>['surfaceOp'] } : {},
      ...row.ignorable === 1 ? { ignorable: true as const } : {},
    } as SessionEvent
  }
  const events = decodeRow(row)
  if (events.length !== 1) throw new Error(`physical row at seq ${row.seq} represents ${events.length} events`)
  return events[0] as SessionEvent
}

/**
 * Find the preserved prefix of ordered event rows. Fully written rows in an
 * interrupted final turn remain in the prefix. The first unparsable row or seq
 * gap after the last `turn/end` marks a tolerated torn tail; the same hole in
 * the committed region rejects.
 *
 * @param rows - one session's event rows, ordered by seq ascending.
 * @param base - the seq the first row is expected to carry; `0` for a whole
 *   log, the requested `fromSeq` for a suffix read (`loadStoredFrom`).
 * @returns the preserved event prefix, plus `tornFrom` — the seq the physical
 *   delete starts at — when a torn tail exists.
 */
/**
 * Scan legacy scalar rows for source-level fixtures that predate schema 17.
 * @param rows - legacy rows ordered by sequence.
 * @param base - sequence expected at the first row.
 * @returns the preserved prefix and optional tail marker.
 */
function scanRowsLegacy(rows: readonly EventRow[], base = 0): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
  interface Parsed { ok: boolean; event?: SessionEvent }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row) }
    } catch {
      return { ok: false }
    }
  })

  // The last index that is a valid `turn/end` — holes through a closed turn
  // are always committed corruption.
  let lastTurnEnd = -1
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.type === 'turn/end') { lastTurnEnd = i; break }
  }

  // Preserve the contiguous prefix, including a complete interrupted turn;
  // holes through the last committed boundary throw, while later holes stop.
  const preserved: SessionEvent[] = []
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i]
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: unparsable committed event at seq ${rows[i]?.seq}`)
      break // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`)
      break // gap after the last turn/end — torn tail, stop
    }
    preserved.push(p.event)
  }

  // Any rows past the preserved prefix are a never-committed torn tail; their
  // first seq is the deletion point for load's physical repair.
  return preserved.length < rows.length ? { preserved, tornFrom: base + preserved.length } : { preserved }
}

/**
 * Scan physical rows with packed-row expansion and crash-tail semantics.
 * @param rows - physical rows ordered by their first logical sequence.
 * @param base - sequence expected at the first selected row.
 * @returns the preserved prefix and optional physical tail marker.
 */
export function scanRows(rows: readonly EventRow[], base = 0): { preserved: SessionEvent[]; tornFrom?: number } {
  const legacy = rows.every(row => typeof row.data === 'string' && (row.source_event_seqs === null || typeof row.source_event_seqs === 'string') && row.ignorable !== 0)
  return legacy ? scanRowsLegacy(rows, base) : scanPhysicalRows(rows, base)
}
