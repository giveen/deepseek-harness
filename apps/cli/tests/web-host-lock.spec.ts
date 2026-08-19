import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireWebHostLock, WEB_HOST_LOCK_FILENAME } from '../src/web-host-lock.ts'

const homes: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** Create one isolated harness home for a lock test. */
async function testHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-host-lock-'))
  homes.push(home)
  return home
}

describe('Web host lock', () => {
  it('rejects a second Web host for the same harness home', async () => {
    const home = await testHome()
    const first = await acquireWebHostLock(home)
    await expect(acquireWebHostLock(home)).rejects.toThrow(/another Web host/)
    await first.release()
    const second = await acquireWebHostLock(home)
    await second.release()
  })

  it('recovers a lock whose owner process no longer exists', async () => {
    const home = await testHome()
    const filename = join(home, WEB_HOST_LOCK_FILENAME)
    await writeFile(filename, JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 })
    const lock = await acquireWebHostLock(home)
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ pid: process.pid })
    await lock.release()
  })

  it('does not release a replacement owner lock', async () => {
    const home = await testHome()
    const first = await acquireWebHostLock(home)
    const filename = join(home, WEB_HOST_LOCK_FILENAME)
    await writeFile(filename, JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 })
    await first.release()
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ pid: 2_147_483_647 })
  })
})
