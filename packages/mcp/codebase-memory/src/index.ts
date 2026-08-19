/**
 * Built-in codebase-memory MCP integration. The npm package owns the verified
 * native runtime; this plugin launches its stdio MCP server, exposes its tools
 * through the existing MCP bridge, and gives the model a stable discovery-first
 * operating policy.
 *
 * @module @deepseek-ai/dsh-codebase-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'codebase-memory'
/** Services used by the MCP bridge and model guidance. */
export const inject = ['tools', 'systemPrompt']

/** Native graph UI port owned by codebase-memory-mcp. */
export const DEFAULT_UI_PORT = 9749
/** MCP tool-call timeout used for structural queries and indexing. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Plugin configuration. */
export interface Config {
  /** Project directory sent as the native MCP server's working directory. */
  cwd?: string
  /** Start the graph UI alongside the MCP server. */
  ui?: boolean
  /** Per-tool-call timeout for discovered MCP tools. */
  toolCallTimeoutMs?: number
  /** Additional environment passed to the native runtime. */
  env?: Record<string, string>
}

/** Schemastery configuration for the built-in integration. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(''),
  ui: z.boolean().default(true),
  toolCallTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  env: z.dict(String).default({}),
})

/** Model-facing guidance for using structural code intelligence before broad file search. */
function codebaseMemoryPrompt(): string {
  return 'Use the codebase-memory MCP tools frequently when working on source code. '
    + 'Before broad grep, directory walking, or opening many files, use the available architecture, project-list, structural-search, semantic-search, code-search, call-trace, impact, and index-coverage tools to identify the smallest relevant set of files and symbols. '
    + 'Use graph evidence to locate definitions, callers, imports, routes, and affected symbols, then open the exact source lines with the normal filesystem tools before editing. '
    + 'After edits, use the change-impact or index-coverage tools when available to check affected relationships; do not treat an empty result as proof that code is unused until the query scope and index freshness are verified. '
    + 'The codebase-memory tools are local and read-only unless a tool description explicitly says otherwise; never upload source code or add generated graph artifacts to a commit without the user asking.'
}

/** Resolve the installed npm wrapper path without relying on PATH or shell lookup. */
function executablePath(): string {
  return fileURLToPath(import.meta.resolve('codebase-memory-mcp/bin.js'))
}

/**
 * Mount the native codebase-memory MCP server and its model guidance.
 *
 * Startup and binary failures remain recoverable: the MCP bridge logs the
 * failure and reconnects without failing the entire harness composition. The
 * npm dependency's postinstall owns verified binary download and package-level
 * updates; this runtime never downloads or replaces an executable.
 *
 * @param ctx - Cordis context carrying the tool and system-prompt registries.
 * @param config - validated integration configuration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const ui = config.ui ?? true
  const cwd = config.cwd === undefined || config.cwd === '' ? process.cwd() : config.cwd
  const args = ui ? ['--ui=true', `--port=${String(DEFAULT_UI_PORT)}`] : []

  ctx.systemPrompt.section({
    name: 'mcp:codebase-memory',
    order: 104,
    text: codebaseMemoryPrompt(),
  })

  await applyMcpClient(ctx, {
    transport: 'stdio',
    serverName: 'codebase-memory',
    command: process.execPath,
    args: [executablePath(), ...args],
    env: config.env ?? {},
    cwd,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  })
}
