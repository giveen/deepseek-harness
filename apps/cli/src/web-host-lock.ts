/**
 * Single-process ownership for the Web profile. One `$DSH_HOME` owns one live
 * Web host because attached agents and session persistence are process-local;
 * a second Web process must fail before it mounts a second API surface.
 * @module @deepseek-ai/dsh/web-host-lock
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable lock filename inside the active harness home. */
export const WEB_HOST_LOCK_FILENAME = 'web-host.lock'

/** On-disk owner record for the active Web host. */
interface WebHostLockRecord {
  pid: number
}

/** A held Web-host ownership lock. */
export interface WebHostLock {
  /** Release this process's lock, without deleting a replacement owner lock. */
  release(): Promise<void>
}

/** Whether a filesystem error means the lock is absent. */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether a process id currently identifies a live process. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH'
  }
}

/** Read and validate the existing lock owner without exposing arbitrary file contents. */
async function readOwner(filename: string): Promise<WebHostLockRecord> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (isNotFound(error)) throw error
    throw new Error(`dsh web: cannot read ${filename}; remove it only after confirming no Web host is running`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)
    || typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error(`dsh web: ${filename} is invalid; remove it only after confirming no Web host is running`)
  }
  return { pid: parsed.pid }
}

/**
 * Acquire the Web-host lock for one harness home.
 *
 * A live owner fails loudly. A lock left by a process that no longer exists is
 * removed and retried, which makes SIGKILL recovery automatic without ever
 * deleting a lock held by a live process.
 * @param dshHome - harness home whose sessions this Web process serves.
 * @returns a disposer for the acquired ownership.
 */
export async function acquireWebHostLock(dshHome = resolveDshHome()): Promise<WebHostLock> {
  const filename = join(resolve(dshHome), WEB_HOST_LOCK_FILENAME)
  await mkdir(resolve(dshHome), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      await writeFile(filename, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
      let released = false
      return {
        async release(): Promise<void> {
          if (released) return
          released = true
          try {
            const owner = await readOwner(filename)
            if (owner.pid === process.pid) await rm(filename, { force: true })
          } catch (error) {
            if (!isNotFound(error)) throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
      let owner: WebHostLockRecord
      try {
        owner = await readOwner(filename)
      } catch (readError) {
        if (isNotFound(readError)) continue
        throw readError
      }
      if (processIsAlive(owner.pid)) {
        throw new Error(
          `dsh web: another Web host (pid ${String(owner.pid)}) already owns ${filename}; `
          + 'use that host for both loopback and LAN session access',
        )
      }
      await rm(filename, { force: true })
    }
  }
}
