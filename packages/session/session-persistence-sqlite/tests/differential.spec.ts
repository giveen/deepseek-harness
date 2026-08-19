import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

function chunk(seq: number): SessionEvent {
  return {
    type: 'assistant/chunk', seq, time: 1_000 + seq,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `token-${seq}` } },
  }
}
function log(): SessionEvent[] {
  const chunks = Array.from({ length: 100 }, (_, index) => chunk(index + 2))
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ...chunks,
    { type: 'step/end', seq: 102, time: 1_102, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 103, time: 1_103, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('SQLite packed-row differential behavior', () => {
  it('preserves the logical log and seeks inside a packed row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-differential-'))
    directories.push(directory)
    const path = join(directory, 'sessions.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path })
    const id = 'differential' as Parameters<typeof ctx.sessionPersistence.create>[0]['id']
    const meta = { id, version: 0, createdAt: 1 }
    const events = log()
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(id, events)
    expect((await ctx.sessionPersistence.inspect(id)).events).toEqual(events)
    for (const fromSeq of [0, 2, 25, 101, 104]) {
      expect((await ctx.sessionPersistence.readFrom(id, fromSeq)).events).toEqual(events.filter(event => event.seq >= fromSeq))
    }
    await fiber.dispose()

    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(db.prepare("SELECT type, COUNT(*) AS count FROM events WHERE type LIKE '%-chunks' GROUP BY type").all())
        .toEqual([{ type: 'text-chunks', count: 1 }])
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 5 })
    } finally {
      db.close()
    }
  })
})
