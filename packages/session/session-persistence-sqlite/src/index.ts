/**
 * SQLite durable session-persistence backend. It maps each session header and
 * event to rows, and delegates write-path orchestration to
 * {@link PersistenceCoordinator}. It has no independent per-session artifact,
 * so its locator returns `undefined`.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator,
  type PersistenceBackend, type SessionLocation, type SessionPersistenceSnapshot,
  type SessionPersistenceSnapshotPage, type SessionInspection,
  type SessionDeletionMark, type SessionDeletionMarkResult, type SessionDeletionSweepResult,
  SESSION_PERSISTENCE_DEFAULT_PAGE_LIMIT, SESSION_PERSISTENCE_MAX_PAGE_LIMIT,
  SESSION_PERSISTENCE_DEFAULT_SWEEP_LIMIT, SESSION_PERSISTENCE_MAX_SWEEP_LIMIT,
  type SessionPersistenceRevision as PersistenceRevision,
  type StoredPrefix, type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId, SessionHeader, SessionPreparation } from '@deepseek-ai/dsh-session'
import {
  type JournalMode, type SynchronousMode, type CheckpointMode,
  openDatabase, validateDatabaseSchema, rowToMeta, type EventRow, type SessionRow,
  type DeletionMarkRow,
  backupDatabase, checkpointDatabase, checkDatabaseIntegrity, type SqliteCheckpointReport, type SqliteIntegrityReport,
  DEFAULT_BUSY_TIMEOUT_MS, MAX_BUSY_TIMEOUT_MS, DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
  MAX_WAL_AUTOCHECKPOINT_PAGES, DEFAULT_SYNCHRONOUS_MODE,
} from './schema.ts'
import { bindRecord, decodeRow, scanRows as scanPhysicalRows } from './compression.ts'
import { packChunkRuns } from './codec.ts'


export {
  SCHEMA_VERSION,
  checkpointDatabase,
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
  DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
  MAX_WAL_AUTOCHECKPOINT_PAGES,
  DEFAULT_SYNCHRONOUS_MODE,
  type CheckpointMode,
  type SynchronousMode,
  type ForeignKeyViolation,
  type SqliteCheckpointReport,
  type SqliteIntegrityReport,
} from './schema.ts'

/** Build the source-qualified revision shared by full and lightweight reads. */
function sqliteRevision(storeIdentity: string, row: SessionRow): PersistenceRevision {
  return SessionPersistenceRevision(
    `${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
  )
}

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity when another principal can replace the database entry in its parent
 * directory.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests). On filesystems with POSIX modes,
   * missing directories and databases are created owner-only; existing path
   * modes are preserved. Filesystem setup errors other than an existing database
   * fail initialization. The backend does not protect confidentiality or
   * integrity when another principal can replace the database entry in its
   * parent directory.
   */
  path: string
  /**
   * SQLite `journal_mode` pragma. `wal` (the default) is the recorded
   * durability model; pick a rollback-journal mode (`delete`/`truncate`/
   * `persist`) on filesystems where WAL's shared-memory files do not work
   * (network mounts). See {@link JournalMode}.
   */
  journalMode?: JournalMode
  /** SQLite connection lock wait in milliseconds. */
  busyTimeoutMs?: number
  /** SQLite synchronous durability level; `full` is the default. */
  synchronous?: SynchronousMode
  /** WAL automatic-checkpoint threshold in pages; zero disables it. */
  walAutocheckpointPages?: number
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/**
 * The SQLite persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the seq to delete from.
 */
export class SqliteSessionPersistence extends SessionPersistence implements PersistenceBackend<number> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    busyTimeoutMs: z.number().step(1).min(1).max(MAX_BUSY_TIMEOUT_MS).default(DEFAULT_BUSY_TIMEOUT_MS),
    synchronous: z.union(['full', 'normal'] as const).default(DEFAULT_SYNCHRONOUS_MODE),
    walAutocheckpointPages: z.number().step(1).min(0).max(MAX_WAL_AUTOCHECKPOINT_PAGES)
      .default(DEFAULT_WAL_AUTOCHECKPOINT_PAGES),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  /**
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows cordis `Service.name` (set to `'sessionPersistence'` by the base);
   * see the JSONL backend for why this does not affect service resolution.
   */
  override readonly name = 'session-persistence-sqlite'

  private db!: DatabaseSync
  private storeIdentity!: string
  private ready: Promise<void>
  private coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic wrappers may construct the backend without Schemastery normalization.
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    // Open asynchronously so directory creation does not block plugin apply;
    // every storage hook awaits the same readiness promise.
    this.ready = this.openDb(config.path, (config as Required<Config>).journalMode, {
      busyTimeoutMs: config.busyTimeoutMs,
      synchronous: config.synchronous,
      walAutocheckpointPages: config.walAutocheckpointPages,
    })
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  private async openDb(
    path: string,
    journalMode: JournalMode,
    options: {
      busyTimeoutMs?: number | undefined
      synchronous?: SynchronousMode | undefined
      walAutocheckpointPages?: number | undefined
    },
  ): Promise<void> {
    const actual = path === ':memory:' ? path : resolve(path)
    if (actual !== ':memory:') {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
      await createDatabaseFile(actual)
    }
    this.db = openDatabase(actual, journalMode, options)
    try {
      const row = this.db.prepare(
        'SELECT store_id FROM persistence_state WHERE singleton = 1',
      ).get() as { store_id: string } | undefined
      /* v8 ignore next -- openDatabase inserts the singleton before returning. */
      if (row === undefined) {
        throw new Error(`session database at "${actual}" has no store identity`)
      }
      if (row.store_id.length === 0) {
        throw new Error(`session database at "${actual}" has no valid store identity`)
      }
      if (actual !== ':memory:') {
        const identity = statSync(actual, { bigint: true })
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${row.store_id}`
      } else {
        this.storeIdentity = `memory:store:${row.store_id}`
      }
    } catch (error: unknown) {
      this.db.close()
      throw error
    }
  }

  // --- SessionPersistence service API (delegated to the coordinator) ---

  /** SQLite has one database, not an independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  // --- PersistenceBackend hooks (the SQLite storage primitives) ---

  /** Read a stored prefix by id (ids are globally unique — no scope to scan). */
  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    return this.readPrefix(id, signal)
  }

  /** Read one row's revision without loading its events. */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    return row === undefined ? undefined : sqliteRevision(this.storeIdentity, row)
  }

  /**
   * Seek-capable suffix read: SQL selects `seq >= fromSeq` directly, so the
   * read scales with the suffix, not the log. Torn rows past the preserved
   * region are dropped, never repaired (non-mutating read).
   */
  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    this.db.exec('BEGIN')
    let snapshot: { row: SessionRow; eventRows: EventRow[] } | undefined
    try {
      const row = this.rowFor(id)
      if (row !== undefined) {
        const eventRows = this.db
          .prepare('SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq')
          .all(id, Math.max(0, fromSeq - 1_023)) as unknown as EventRow[]
        snapshot = { row, eventRows }
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      /* v8 ignore start -- synchronous read failures only need transaction cleanup before propagation. */
      this.db.exec('ROLLBACK')
      throw error
      /* v8 ignore stop */
    }
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const { row, eventRows } = snapshot
    const base = eventRows[0]?.seq ?? fromSeq
    const { preserved } = scanPhysicalRows(eventRows, base)
    return { meta: rowToMeta(row), events: preserved.filter(event => event.seq >= fromSeq) }
  }

  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the seq from which a never-committed tail must be deleted
   * (`scanRows` already returns it as `number | undefined`).
   */
  private async readPrefix(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    this.db.exec('BEGIN')
    let snapshot: { row: SessionRow; eventRows: EventRow[] } | undefined
    try {
      const row = this.rowFor(id)
      if (row !== undefined) {
        const eventRows = this.db
          .prepare('SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable FROM events WHERE session_id = ? ORDER BY seq')
          .all(id) as unknown as EventRow[]
        snapshot = { row, eventRows }
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      /* v8 ignore start -- synchronous read failures only need transaction cleanup before propagation. */
      this.db.exec('ROLLBACK')
      throw error
      /* v8 ignore stop */
    }
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const { row, eventRows } = snapshot
    const { preserved, tornFrom } = scanPhysicalRows(eventRows)
    return {
      meta: rowToMeta(row),
      events: preserved,
      revision: sqliteRevision(this.storeIdentity, row),
      ...tornFrom !== undefined ? { tornMarker: tornFrom } : {},
    }
  }

  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every event, or roll back entirely. The transaction is the
   * atomicity + durability boundary, so a mid-batch failure (a UNIQUE violation
   * on a duplicated seq) leaves the stored log untouched.
   */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ready
    const insertEvent = this.db.prepare(
      'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      validateDatabaseSchema(this.db, this.config.path)
      if (this.isMarked(meta.id)) {
        throw new Error(`session "${meta.id}" is marked for deletion and cannot accept new events`)
      }
      const tailRows = this.db.prepare(
        'SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
      ).all(meta.id) as unknown as EventRow[]
      const last = tailRows[0] === undefined ? undefined : decodeRow(tailRows[0]).at(-1)
      const expected = last === undefined ? 0 : last.seq + 1
      if (events[0]?.seq !== expected) {
        throw new Error(`session ${meta.id} append starts at seq ${events[0]?.seq}, stored next seq is ${expected}`)
      }
      if (!isMaterialized) this.writeRow(meta)
      for (const record of packChunkRuns(events)) {
        const bound = bindRecord(record)
        insertEvent.run(meta.id, bound.seq, bound.type, bound.time, bound.data, bound.sourceEventSeqs, bound.surfaceOp, bound.ignorable)
      }
      this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`) and INSERT the synthetic `closers`. After COMMIT the stored rows
   * == the balanced log.
   */
  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    await this.ready
    this.db.exec('BEGIN IMMEDIATE')
    try {
      validateDatabaseSchema(this.db, this.config.path)
      const currentRows = this.db
        .prepare('SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable FROM events WHERE session_id = ? ORDER BY seq')
        .all(meta.id) as unknown as EventRow[]
      const current = scanPhysicalRows(currentRows)
      if (tornMarker !== undefined && current.tornFrom !== tornMarker) {
        throw new Error(`session ${meta.id} repair is stale: physical tail no longer starts at seq ${tornMarker}`)
      }
      if (tornMarker === undefined && current.tornFrom !== undefined) {
        throw new Error(`session ${meta.id} repair omitted current torn tail at seq ${current.tornFrom}`)
      }
      if (tornMarker !== undefined) {
        this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(meta.id, tornMarker)
      }
      if (closers.length > 0) {
        const expected = current.preserved.at(-1)?.seq === undefined ? 0 : (current.preserved.at(-1) as SessionEvent).seq + 1
        if (closers[0]?.seq !== expected) {
          throw new Error(`session ${meta.id} repair is stale: closer starts at seq ${closers[0]?.seq}, stored next seq is ${expected}`)
        }
        const insertEvent = this.db.prepare(
          'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        for (const event of closers) {
          const bound = bindRecord(event)
          insertEvent.run(meta.id, bound.seq, bound.type, bound.time, bound.data, bound.sourceEventSeqs, bound.surfaceOp, bound.ignorable)
        }
      }
      if (tornMarker !== undefined || closers.length > 0) {
        this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      // The DELETE+INSERT cannot collide (a row at a closer's seq is preserved or
      // deleted as torn first); this rolls back a DB-level failure (disk full,
      // etc.), unreachable in test.
      /* v8 ignore start */
      this.db.exec('ROLLBACK')
      throw error
      /* v8 ignore stop */
    }
  }

  /** List unmarked materialized sessions' metadata. */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const rows = this.db
      .prepare(`
        SELECT * FROM sessions
        WHERE NOT EXISTS (SELECT 1 FROM session_deletion_marks WHERE session_id = sessions.id)
      `)
      .all() as unknown as SessionRow[]
    signal?.throwIfAborted()
    return rows.map(rowToMeta)
  }

  /**
   * Mark existing, non-live sessions for a later mark-and-sweep deletion.
   * @param ids - session ids to mark; duplicates are reported once.
   * @param reason - optional bounded maintenance reason.
   * @returns the idempotent mark result.
   */
  override async markForDeletion(
    ids: readonly SessionId[],
    reason?: string,
  ): Promise<SessionDeletionMarkResult> {
    if (reason !== undefined && reason.length > 256) {
      throw new TypeError('deletion mark reason must be at most 256 characters')
    }
    const uniqueIds = [...new Set(ids)]
    await this.ready
    const marked: SessionId[] = []
    const alreadyMarked: SessionId[] = []
    const missing: SessionId[] = []
    const skippedLive: SessionId[] = []
    const markedAt = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of uniqueIds) {
        const exists = this.db.prepare('SELECT 1 AS present FROM sessions WHERE id = ?').get(id) as { present: number } | undefined
        if (exists === undefined) {
          missing.push(id)
          continue
        }
        if (this.ctx.sessions.get(id) !== undefined) {
          skippedLive.push(id)
          continue
        }
        const existing = this.db.prepare(
          'SELECT 1 AS present FROM session_deletion_marks WHERE session_id = ?',
        ).get(id) as { present: number } | undefined
        if (existing !== undefined) {
          alreadyMarked.push(id)
          continue
        }
        this.db.prepare(
          'INSERT INTO session_deletion_marks (session_id, marked_at, reason) VALUES (?, ?, ?)',
        ).run(id, markedAt, reason ?? null)
        marked.push(id)
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { marked, alreadyMarked, missing, skippedLive }
  }

  /** List durable deletion marks in mark order. */
  override async listDeletionMarks(): Promise<SessionDeletionMark[]> {
    await this.ready
    const rows = this.db.prepare(
      'SELECT session_id, marked_at, reason FROM session_deletion_marks ORDER BY marked_at, session_id',
    ).all() as unknown as DeletionMarkRow[]
    return rows.map(row => ({
      id: row.session_id as SessionId,
      markedAt: row.marked_at,
      ...row.reason !== null ? { reason: row.reason } : {},
    }))
  }

  /**
   * Delete marked sessions that are not live and are not named by an unmarked
   * child. Deletion cascades to event rows and the mark in one transaction.
   * @param limit - maximum number of marks considered in this pass.
   * @returns deleted ids and the reasons protected marks remain.
   */
  override async sweepMarked(
    limit: number = SESSION_PERSISTENCE_DEFAULT_SWEEP_LIMIT,
  ): Promise<SessionDeletionSweepResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_PERSISTENCE_MAX_SWEEP_LIMIT) {
      throw new TypeError(`deletion sweep limit must be an integer between 1 and ${SESSION_PERSISTENCE_MAX_SWEEP_LIMIT}`)
    }
    await this.ready
    const deleted: SessionId[] = []
    const skippedLive: SessionId[] = []
    const skippedReferenced: SessionId[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db.prepare(
        'SELECT session_id FROM session_deletion_marks ORDER BY marked_at, session_id LIMIT ?',
      ).all(limit) as Array<{ session_id: string }>
      for (const row of rows) {
        const id = row.session_id as SessionId
        if (this.ctx.sessions.get(id) !== undefined) {
          skippedLive.push(id)
          continue
        }
        const child = this.db.prepare(`
          SELECT child.id
          FROM sessions AS child
          WHERE child.parent_session = ?
            AND NOT EXISTS (
              SELECT 1 FROM session_deletion_marks AS child_mark
              WHERE child_mark.session_id = child.id
            )
          LIMIT 1
        `).get(id) as { id: string } | undefined
        if (child !== undefined) {
          skippedReferenced.push(id)
          continue
        }
        this.db.prepare(
          'DELETE FROM sessions WHERE id = ? AND EXISTS (SELECT 1 FROM session_deletion_marks WHERE session_id = ?)',
        ).run(id, id)
        deleted.push(id)
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
    for (const id of deleted) this.coordinator.forgetDeleted(id)
    const { remaining } = this.db.prepare(
      'SELECT COUNT(*) AS remaining FROM session_deletion_marks',
    ).get() as { remaining: number }
    return { deleted, skippedLive, skippedReferenced, remaining }
  }

  /**
   * Check SQLite structural and foreign-key integrity without changing the log.
   * @returns the raw SQLite diagnostic rows and an aggregate status.
   */
  async checkIntegrity(): Promise<SqliteIntegrityReport> {
    await this.ready
    return checkDatabaseIntegrity(this.db)
  }

  /**
   * Create a consistent online backup of this database.
   * @param destination - destination SQLite path; an existing file is replaced.
   * @returns the number of pages copied by SQLite.
   */
  async backup(destination: string): Promise<number> {
    await this.ready
    const actual = resolve(destination)
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
    return backupDatabase(this.db, actual)
  }

  /**
   * Run one serialized WAL checkpoint for operational maintenance.
   * @param mode - checkpoint strategy; passive is the default non-blocking choice.
   * @returns SQLite checkpoint progress counters.
   */
  async checkpoint(mode: CheckpointMode = 'passive'): Promise<SqliteCheckpointReport> {
    await this.ready
    return checkpointDatabase(this.db, mode)
  }

  /** List metadata with a source-qualified monotonic revision per session. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE NOT EXISTS (SELECT 1 FROM session_deletion_marks WHERE session_id = sessions.id)
    `).all() as unknown as SessionRow[]
    signal?.throwIfAborted()
    return rows.map(row => ({
      header: rowToMeta(row),
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
      ),
    }))
  }

  /**
   * List metadata using a bounded SQLite keyset query.
   * @param limit - maximum number of snapshots to return.
   * @param cursor - opaque cursor from the previous page.
   * @param signal - optional cancellation for backend listing work.
   * @returns one bounded snapshot page ordered by newest creation time then id.
   */
  override async listSnapshotsPage(
    limit: number = SESSION_PERSISTENCE_DEFAULT_PAGE_LIMIT,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshotPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_PERSISTENCE_MAX_PAGE_LIMIT) {
      throw new TypeError(`persistence snapshot page limit must be an integer between 1 and ${SESSION_PERSISTENCE_MAX_PAGE_LIMIT}`)
    }
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const position = cursor === undefined ? undefined : decodeSnapshotCursor(cursor)
    const rows = position === undefined
      ? this.db.prepare(`
        SELECT * FROM sessions
        WHERE NOT EXISTS (SELECT 1 FROM session_deletion_marks WHERE session_id = sessions.id)
        ORDER BY created_at DESC, id ASC LIMIT ?
      `).all(limit + 1)
      : this.db.prepare(`
        SELECT * FROM sessions
        WHERE NOT EXISTS (SELECT 1 FROM session_deletion_marks WHERE session_id = sessions.id)
          AND (created_at < ? OR (created_at = ? AND id > ?))
        ORDER BY created_at DESC, id ASC
        LIMIT ?
      `).all(position.createdAt, position.createdAt, position.id, limit + 1)
    const pageRows = rows as unknown as SessionRow[]
    signal?.throwIfAborted()
    const hasMore = pageRows.length > limit
    const visibleRows = hasMore ? pageRows.slice(0, limit) : pageRows
    const last = visibleRows.at(-1)
    return {
      snapshots: visibleRows.map(row => ({
        header: rowToMeta(row),
        revision: SessionPersistenceRevision(
          `${this.storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
        ),
      })),
      ...hasMore && last !== undefined ? { nextCursor: encodeSnapshotCursor(last) } : {},
    }
  }

  /** Close the database handle (awaited by the coordinator's dispose, post-drain). */
  async close(): Promise<void> {
    await this.ready
    this.db.close()
  }

  // --- row helpers ---

  /** Fetch an unmarked session row, or undefined if absent or marked. */
  private rowFor(id: SessionId): SessionRow | undefined {
    return this.db.prepare(`
      SELECT * FROM sessions
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM session_deletion_marks WHERE session_id = sessions.id)
    `).get(id) as unknown as SessionRow | undefined
  }

  /** Whether a session is durably marked and therefore closed to new appends. */
  private isMarked(id: SessionId): boolean {
    return this.db.prepare(
      'SELECT 1 AS present FROM session_deletion_marks WHERE session_id = ?',
    ).get(id) !== undefined
  }

  /**
   * Insert-or-replace a session's metadata row. The only caller is the first
   * materializing `appendBatch`, so writing the row IS the materialization (its
   * existence is the signal `list` reads).
   */
  private writeRow(meta: SessionHeader): void {
    this.db.prepare(`
      INSERT INTO sessions
        (id, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        created_at = excluded.created_at,
        cwd = excluded.cwd,
        parent_session = excluded.parent_session,
        seed_length = excluded.seed_length,
        origin = excluded.origin,
        delegation_depth = excluded.delegation_depth,
        agent_preset = excluded.agent_preset
    `).run(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.seedLength ?? null,
      meta.origin ?? null,
      meta.delegationDepth ?? null,
      meta.agentPreset ?? null,
      randomUUID(),
    )
  }
}

interface SnapshotCursor {
  createdAt: number
  id: string
}

function encodeSnapshotCursor(row: SessionRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), 'utf8').toString('base64url')
}

function decodeSnapshotCursor(cursor: string): SnapshotCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SnapshotCursor>
    if (
      typeof value.createdAt !== 'number'
      || !Number.isSafeInteger(value.createdAt)
      || value.createdAt < 0
      || typeof value.id !== 'string'
      || value.id.length === 0
    ) throw new Error('invalid cursor fields')
    return { createdAt: value.createdAt, id: value.id }
  } catch (error: unknown) {
    throw new TypeError('persistence snapshot cursor is invalid', { cause: error })
  }
}

export default SqliteSessionPersistence
