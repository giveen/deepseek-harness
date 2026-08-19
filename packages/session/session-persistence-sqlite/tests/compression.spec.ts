import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import { MAX_PACKED_DATA_BYTES, MAX_PACKED_ROW_MEMBERS, packChunkRuns, decodeStorageRecord } from '../src/codec.ts'
import { bindRecord, decodeRow, scanRows, ZSTD_DATA_THRESHOLD_BYTES } from '../src/compression.ts'
import type { EventRow } from '../src/schema.ts'

function chunk(seq: number, text = `token-${seq}`): SessionEvent {
  return {
    type: 'assistant/chunk', seq, time: 1_000 + seq,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  }
}
function row(record: SessionEvent): EventRow {
  const bound = bindRecord(record)
  return {
    seq: bound.seq,
    type: bound.type,
    time: bound.time,
    data: bound.data,
    source_event_seqs: bound.sourceEventSeqs,
    surface_op: bound.surfaceOp,
    ignorable: bound.ignorable,
  }
}

describe('SQLite schema-17 physical codec', () => {
  it('packs and restores a compatible chunk run without changing logical events', () => {
    const events = Array.from({ length: 100 }, (_, index) => chunk(index))
    const records = packChunkRuns(events)
    expect(records).toHaveLength(1)
    expect(records[0]?.type).toBe('text-chunks')
    expect(scanRows(records.map(record => row(record as SessionEvent)))).toEqual({ preserved: events })
    expect(records.flatMap(decodeStorageRecord)).toEqual(events)
  })

  it('partitions long and oversized runs within physical limits', () => {
    const long = Array.from({ length: MAX_PACKED_ROW_MEMBERS + 3 }, (_, index) => chunk(index))
    expect(packChunkRuns(long)).toHaveLength(2)
    const large = Array.from({ length: 4 }, (_, index) => chunk(index, 'x'.repeat(300_000)))
    const records = packChunkRuns(large)
    expect(records.length).toBeGreaterThan(1)
    for (const record of records) {
      if (record.type.endsWith('-chunks')) expect(Buffer.byteLength(JSON.stringify(record.data))).toBeLessThanOrEqual(MAX_PACKED_DATA_BYTES)
    }
    expect(records.flatMap(decodeStorageRecord)).toEqual(large)
  })

  it('packs reasoning and tool-call runs without losing their identities', () => {
    const reasoning: SessionEvent[] = Array.from({ length: 3 }, (_, index) => ({
      type: 'assistant/chunk', seq: index, time: 1_000 + index,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: `reason-${index}` } },
    }))
    const toolCalls: SessionEvent[] = Array.from({ length: 3 }, (_, index) => ({
      type: 'assistant/chunk', seq: index + 3, time: 1_003 + index,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'lookup', argumentsDelta: `{"part":${index}}` },
      },
    }))
    const events = [...reasoning, ...toolCalls]
    const records = packChunkRuns(events)
    expect(records.map(record => record.type)).toEqual(['reasoning-chunks', 'tool-call-chunks'])
    expect(records.flatMap(decodeStorageRecord)).toEqual(events)
  })

  it('selectively compresses large scalar payloads and round-trips provenance', () => {
    const sources = Array.from({ length: 2_000 }, (_, index) => index % 2 === 0 ? index + 10 : index)
    const event = {
      type: 'assistant/message', seq: 2_010, time: 1,
      data: { text: 'x'.repeat(ZSTD_DATA_THRESHOLD_BYTES * 2) },
      sourceEventSeqs: sources,
      surfaceOp: 'append',
    } as unknown as SessionEvent
    const bound = bindRecord(event)
    expect(bound.data).toBeInstanceOf(Uint8Array)
    expect(bound.sourceEventSeqs).toBeInstanceOf(Uint8Array)
    expect(decodeRow(row(event))).toEqual([event])
    expect(typeof bindRecord({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }).data).toBe('string')
  })

  it('keeps storage-tag collisions scalar for ignorable logical events', () => {
    const logical = { type: 'text-chunks', seq: 0, time: 1, data: { future: true }, ignorable: true } as unknown as SessionEvent
    expect(decodeRow(row(logical))).toEqual([logical])
  })

  it('rejects malformed packed rows and treats a malformed tail as removable', () => {
    const malformed: EventRow = {
      seq: 0, type: 'text-chunks', time: 1,
      data: JSON.stringify({ turn: 1, step: 1, index: 0, dt: [], texts: ['a', 'b'] }),
      source_event_seqs: null, surface_op: null, ignorable: 0,
    }
    expect(() => decodeRow(malformed)).toThrow(/malformed text-chunks storage row/)
    expect(scanRows([malformed])).toEqual({ preserved: [], tornFrom: 0 })
  })
})
