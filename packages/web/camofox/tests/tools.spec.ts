import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubprocessRuntime, { type SubprocessHandle, type SubprocessSpawnSpec, type SubprocessTerminalHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as Camofox from '../src/index.ts'

const testAgent = { id: 'agent-1', session: { id: 'agent-1' } } as Agent
const testToolSignal = new AbortController().signal

class FakeSubprocessRuntime extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly handles: SubprocessHandle[] = []

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    let finish!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => { finish = resolve })
    const handle: SubprocessHandle = {
      pid: 42,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done,
      terminate: () => { finish({ exitCode: 0, signal: null }) },
      waitForExit: async () => true,
    }
    this.handles.push(handle)
    return handle
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('unused'))
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
  return JSON.parse(init.body) as Record<string, unknown>
}

async function mount(): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  call: (name: string, args: unknown, agent?: Agent, signal?: AbortSignal) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeSubprocessRuntime)
  const fiber = await ctx.plugin(Camofox, { autoStart: false })
  let counter = 0
  const call = (name: string, args: unknown, agent = testAgent, signal = testToolSignal) =>
    ctx.tools.execute({ signal, agent, callId: CallId(`call-${++counter}`), name, arguments: args })
  return { ctx, fiber, call }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('camofox tool registration and guidance', () => {
  it('registers the five tools and explains fresh snapshots and target selection', async () => {
    const { ctx, fiber } = await mount()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
    ])
    expect(ctx.tools.get('browser_navigate')?.timeoutMs).toBe(Camofox.DEFAULT_TIMEOUT_MS)
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(section => section.text).join('\n')
    expect(text).toContain('browser_click accepts exactly one target')
    expect(text).toContain('Refs are page-specific')
    expect(text).toContain('After browser_scroll, snapshot again')
    await fiber.dispose()
  })

  it('rejects invalid deployment timeout values at plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeSubprocessRuntime)
    await expect(ctx.plugin(Camofox, { autoStart: false, timeoutMs: Camofox.MAX_TIMEOUT_MS + 1 }))
      .rejects.toThrow(`timeoutMs must be no greater than ${Camofox.MAX_TIMEOUT_MS}`)
  })

  it('starts the bundled server on the canonical loopback endpoint', async () => {
    const health = vi.fn(async (input: RequestInfo | URL) => {
      expect(requestUrl(input)).toBe('http://127.0.0.1:9377/health')
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', health)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeSubprocessRuntime)
    const fiber = await ctx.plugin(Camofox)
    const subprocess = ctx.subprocess as FakeSubprocessRuntime
    expect(subprocess.specs).toHaveLength(1)
    expect(subprocess.specs[0]?.argv[0]).toBe(process.execPath)
    expect(subprocess.specs[0]).toMatchObject({
      env: { CAMOFOX_PORT: '9377', CAMOFOX_BIND_HOST: '127.0.0.1' },
    })
    expect(health).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('rejects browser operations without an initiating agent', async () => {
    const { ctx, fiber } = await mount()
    const out = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('no-agent'),
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    })
    expect(out.isError).toBe(true)
    expect(out.error?.message).toContain('require an initiating agent')
    await fiber.dispose()
  })
})

describe('camofox wire and execution behavior', () => {
  it('isolates requests by agent and forwards the tool signal', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe('http://127.0.0.1:9377/tabs')
      expect(init?.signal).toBe(testToolSignal)
      expect(requestBody(init)).toEqual({
        url: 'https://example.com/',
        userId: 'agent-1',
        sessionKey: 'dsh-browser',
      })
      return jsonResponse({ tabId: 'tab-1', url: 'https://example.com/', title: 'Example' })
    })
    vi.stubGlobal('fetch', fetch)
    const { fiber, call } = await mount()
    const out = await call('browser_navigate', { url: 'https://example.com' })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({ tabId: 'tab-1', url: 'https://example.com/', title: 'Example' })
    await fiber.dispose()
  })

  it('normalizes snapshot fields and includes the session identity in GET query parameters', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(testToolSignal)
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/tabs/tab-1/snapshot')
      expect(url.searchParams.get('userId')).toBe('agent-1')
      expect(url.searchParams.get('sessionKey')).toBe('dsh-browser')
      return jsonResponse({
        snapshot: '[button e1] Submit',
        url: 'https://example.com/',
        refsCount: 1,
        truncated: false,
        totalChars: 18,
        nextOffset: 999,
      })
    })
    vi.stubGlobal('fetch', fetch)
    const { fiber, call } = await mount()
    const out = await call('browser_snapshot', { tabId: 'tab-1' })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      snapshot: '[button e1] Submit',
      url: 'https://example.com/',
      refsCount: 1,
      truncated: false,
      totalChars: 18,
    })
    await fiber.dispose()
  })

  it('accepts a CSS selector or one fresh ref, but rejects ambiguous click targets', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, selector: 'button.submit' }))
    vi.stubGlobal('fetch', fetch)
    const { fiber, call } = await mount()
    const selected = await call('browser_click', { tabId: 'tab-1', selector: 'button.submit' })
    expect(selected.isError).toBe(false)
    expect(requestBody(fetch.mock.calls[0]?.[1])).toMatchObject({ selector: 'button.submit' })

    const both = await call('browser_click', { tabId: 'tab-1', ref: 'e1', selector: 'button.submit' })
    expect(both.isError).toBe(true)
    expect(both.error?.message).toContain('exactly one')
    expect(fetch).toHaveBeenCalledTimes(1)

    const malformed = await call('browser_click', { tabId: 'tab-1', ref: 'button-1' })
    expect(malformed.isError).toBe(true)
    expect(malformed.error?.message).toContain('latest browser_snapshot')
    await fiber.dispose()
  })

  it('validates wire responses and uses the canonical typed, scrolled result', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(requestUrl(input)).pathname
      if (path.endsWith('/scroll')) {
        expect(requestBody(init)).toMatchObject({ direction: 'down', amount: 700 })
        return jsonResponse({ ok: true, direction: 'down', amount: 700, ignored: 'field' })
      }
      return jsonResponse({ ok: 'yes' })
    })
    vi.stubGlobal('fetch', fetch)
    const { fiber, call } = await mount()
    const out = await call('browser_scroll', { tabId: 'tab-1', direction: 'down', amount: 700 })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({ ok: true, direction: 'down', amount: 700 })

    const invalid = await call('browser_scroll', { tabId: 'tab-1', direction: 'down', amount: 0 })
    expect(invalid.isError).toBe(true)
    expect(invalid.error?.message).toContain('positive safe integer')
    expect(fetch).toHaveBeenCalledTimes(1)

    const badWire = await call('browser_type', { tabId: 'tab-1', ref: 'e1', text: 'x' })
    expect(badWire.isError).toBe(true)
    expect(badWire.error?.message).toContain('invalid ok')
    await fiber.dispose()
  })

  it('reports HTTP failures without treating an error response as a successful value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'tab missing' }, 404)))
    const { fiber, call } = await mount()
    const out = await call('browser_snapshot', { tabId: 'tab-1' })
    expect(out.isError).toBe(true)
    expect(out.error?.message).toContain('/tabs/tab-1/snapshot failed (404)')
    await fiber.dispose()
  })
})
