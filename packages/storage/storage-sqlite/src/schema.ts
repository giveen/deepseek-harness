/**
 * Schema + open-time helpers for the SQLite storage backend: the physical
 * layout version, the database open/configure sequence (permissions, pragmas,
 * version stamp/reject), and the unit metadata tables. Unit record tables are
 * created per descriptor in `unit.ts`.
 * @module @deepseek-ai/dsh-storage-sqlite/schema
 */

import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'

/**
 * The on-disk physical layout version, stored in `PRAGMA user_version`.
 * Orthogonal to each unit's own `version` (stamped per unit in the `units`
 * row). Bumped only on a breaking change to the table layout; any other
 * stamped version rejects — this unreleased format has no migrations.
 */
export const STORAGE_SQLITE_SCHEMA_VERSION = 1

/**
 * Journal modes the backend will run under. `wal` is the default; the
 * rollback-journal modes (`delete`/`truncate`/`persist`) exist for
 * filesystems where WAL's shared-memory files do not work (network mounts).
 * `memory`/`off` are excluded: dropping journal durability silently
 * contradicts the durability clause of the KV backend contract.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** SQLite connection durability levels supported by the KV backend. */
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

/** Connection options applied before the backend is exposed. */
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

/* jscpd:ignore-start -- deliberately mirrors the session-persistence-sqlite /
   session-query-sqlite open sequence; this group is the third user, and the
   shared medium helper is deferred to the log-facet migration so the session
   packages stay untouched this phase (see the domain KV storage Agent Note's
   reuse audit). */
/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity when another principal can replace the database entry in its
 * parent directory.
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
 * Open the database and apply its schema and pragmas. Missing directories and
 * database files are created owner-only (`:memory:` skips filesystem setup).
 * A zero `user_version` is stamped with {@link STORAGE_SQLITE_SCHEMA_VERSION};
 * every other non-current version rejects rather than being migrated in place.
 * @param path - the SQLite database file to open, or `:memory:`.
 * @param journalMode - validated journal pragma.
 * @param options - connection timeout and synchronous durability settings.
 * @returns the open handle with pragmas applied and the unit metadata tables ensured.
 */
export async function openDatabase(
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
  const db = new DatabaseSync(actual, { timeout: busyTimeoutMs })
  try {
    configureDatabase(db, actual, journalMode, synchronous, walAutocheckpointPages)
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
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  db.exec(`PRAGMA synchronous = ${synchronous.toUpperCase()}`)
  db.exec(`PRAGMA wal_autocheckpoint = ${walAutocheckpointPages}`)
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
    throw new StorageError(
      'version-mismatch',
      `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (${STORAGE_SQLITE_SCHEMA_VERSION})`,
    )
  }
  /* jscpd:ignore-end */
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) {
    // Stamp fresh databases LAST: the stamp asserts the layout is complete,
    // so a failure above must leave the medium unstamped (a re-open after
    // the obstruction is cleared retries materialization from scratch).
    db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
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
  const actual = resolve(destination)
  await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
  await createDatabaseFile(actual)
  return sqliteBackup(db, actual)
}

/**
 * Physical table name for one validated unit/table pair.
 * @param unit - validated unit name.
 * @param table - validated table name.
 * @returns the quoted-safe physical identifier stem.
 */
export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}
