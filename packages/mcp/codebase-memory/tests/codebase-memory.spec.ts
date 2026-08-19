import { describe, expect, it, vi } from 'vitest'
import { apply, DEFAULT_UI_PORT } from '../src/index.ts'

const applyMcpClient = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: applyMcpClient }))

describe('codebase-memory integration', () => {
  it('starts the installed wrapper with the graph UI and publishes model guidance', async () => {
    const section = vi.fn()
    const ctx = { systemPrompt: { section } } as never

    await apply(ctx)

    const sectionCall = section.mock.calls[0]?.[0] as { name?: unknown; order?: unknown; text?: unknown }
    expect(sectionCall.name).toBe('mcp:codebase-memory')
    expect(sectionCall.order).toBe(104)
    expect(sectionCall.text).toEqual(expect.any(String))
    expect(sectionCall.text as string).toContain('Use the codebase-memory MCP tools frequently')
    expect(applyMcpClient).toHaveBeenCalledWith(ctx, expect.objectContaining({
      transport: 'stdio',
      serverName: 'codebase-memory',
      command: process.execPath,
      args: [expect.stringMatching(/codebase-memory-mcp[/\\]bin\.js$/), '--ui=true', `--port=${String(DEFAULT_UI_PORT)}`],
      cwd: process.cwd(),
      failOnStartupError: false,
    }))
  })

  it('allows the graph UI to be disabled without changing the MCP server identity', async () => {
    applyMcpClient.mockClear()
    const ctx = { systemPrompt: { section: vi.fn() } } as never

    await apply(ctx, { cwd: '/workspace/project', ui: false, env: { CBM_AUTO_WATCH: 'false' } })

    expect(applyMcpClient).toHaveBeenCalledWith(ctx, expect.objectContaining({
      serverName: 'codebase-memory',
      args: [expect.stringMatching(/codebase-memory-mcp[/\\]bin\.js$/)],
      cwd: '/workspace/project',
      env: { CBM_AUTO_WATCH: 'false' },
    }))
  })
})
