/** SQLite schema for the disposable session full-text read model. */

import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Current derived-index schema version. Incompatible versions reset in place. */
export const SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8

/** SQLite application id protecting unrelated databases from derived resets. */
export const SESSION_QUERY_SQLITE_APPLICATION_ID = 0x44534851

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** SQLite connection durability levels supported by the derived index. */
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

/** Connection options applied before the index is exposed. */
export interface SqliteOpenOptions {
  /** Maximum lock wait in milliseconds. */
  busyTimeoutMs?: number
  /** SQLite synchronous level. */
  synchronous?: SynchronousMode
  /** WAL automatic-checkpoint threshold in pages; zero disables it. */
  walAutocheckpointPages?: number
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

const DERIVED_USER_TABLES = new Set([
  'search_state',
  'persisted_sessions',
  'persisted_docs',
  'persisted_docs_data',
  'persisted_docs_idx',
  'persisted_docs_content',
  'persisted_docs_docsize',
  'persisted_docs_config',
])

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open, validate, and initialize persistent and connection-local schemas.
 * @param path - dedicated derived-index path or `:memory:`; missing filesystem paths are created owner-only.
 * @param journalMode - validated SQLite journal mode.
 * @param options - connection timeout and synchronous durability settings.
 * @returns initialized database handle owned by the search service.
 */
export async function openSearchDatabase(
  path: string,
  journalMode: JournalMode,
  options: SqliteOpenOptions = {},
): Promise<DatabaseSync> {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  const synchronous = options.synchronous ?? DEFAULT_SYNCHRONOUS_MODE
  const walAutocheckpointPages = options.walAutocheckpointPages ?? DEFAULT_WAL_AUTOCHECKPOINT_PAGES
  assertOpenOptions(busyTimeoutMs, synchronous, walAutocheckpointPages)
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual, { timeout: busyTimeoutMs })
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const userTables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== SESSION_QUERY_SQLITE_APPLICATION_ID) {
      throw new Error(`session-search database at "${actual}" belongs to another application`)
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new Error(`session-search database at "${actual}" is not an empty or recognized derived index`)
    }
    if (applicationId === SESSION_QUERY_SQLITE_APPLICATION_ID) {
      assertDerivedUserTables(actual, userTables)
      if (version !== SESSION_QUERY_SQLITE_SCHEMA_VERSION) resetDerivedSchema(db, userTables)
    }
    // Apply mutating pragmas only after refusing foreign or canonical files.
    // journalMode is a validated closed union, not caller-controlled SQL.
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    db.exec(`PRAGMA synchronous = ${synchronous.toUpperCase()}`)
    db.exec(`PRAGMA wal_autocheckpoint = ${walAutocheckpointPages}`)
    ensurePersistentSchema(db)
    ensureTemporarySchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

/**
 * Run SQLite's structural and foreign-key diagnostics on an open connection.
 * @param db - open database handle.
 * @returns diagnostic rows without mutating the index.
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
 * Back up an open derived index through SQLite's online backup API.
 * @param db - open source database handle.
 * @param destination - destination database path.
 * @returns the number of copied pages.
 */
export async function backupDatabase(db: DatabaseSync, destination: string): Promise<number> {
  const actual = resolve(destination)
  await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
  await createDatabaseFile(actual)
  const { backup } = await import('node:sqlite')
  return backup(db, actual)
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

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function assertDerivedUserTables(path: string, userTables: readonly string[]): void {
  const unknownTables = userTables.filter(name => !DERIVED_USER_TABLES.has(name))
  if (unknownTables.length > 0) {
    throw new Error(
      `session-search database at "${path}" has unrecognized user tables: ${unknownTables.join(', ')}`,
    )
  }
}

function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[]): void {
  for (const name of userTables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`)
  }
  db.exec('PRAGMA user_version = 0')
}

function ensurePersistentSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_state (
      singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `)
  db.exec('INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS persisted_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      revision       TEXT NOT NULL,
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
  db.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION}`)
}

function ensureTemporarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS live_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      fingerprint    TEXT NOT NULL,
      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.live_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
