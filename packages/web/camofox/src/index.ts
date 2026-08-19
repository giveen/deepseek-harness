/**
 * Model-facing browser automation tools backed by camofox-browser.
 *
 * Registers browser_navigate, browser_snapshot, browser_click, browser_type,
 * and browser_scroll tools. The client owns the external HTTP protocol,
 * validates responses at that wire boundary, and isolates browser sessions by
 * the exact calling agent.
 *
 * @module @deepseek-ai/dsh-tool-camofox
 */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'tool-camofox'
/** Services used by the model-facing tools. */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Default camofox-browser endpoint. */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:9377'
/** Default cooperative budget for one browser operation. */
export const DEFAULT_TIMEOUT_MS = 30_000
/** Maximum delay accepted by Node's timer-backed timeout policy. */
export const MAX_TIMEOUT_MS = 2_147_483_647
/** Maximum time spent waiting for the managed server to become healthy. */
export const SERVER_STARTUP_TIMEOUT_MS = 30_000
/** Grace period used when the managed server is disposed. */
export const SERVER_KILL_GRACE_MS = 2_000
/** Maximum retained output for the managed server's diagnostics. */
const SERVER_OUTPUT_MAX_BYTES = 64_000
/** Maximum PNG bytes retained in durable tool presentation metadata. */
const MAX_SCREENSHOT_BYTES = 1_500_000

/** Plugin configuration. */
export interface Config {
  /** camofox-browser server URL. */
  serverUrl?: string
  /** Start and own the bundled camofox-browser server. */
  autoStart?: boolean
  /** Cooperative timeout budget in milliseconds. */
  timeoutMs?: number
}

/** Schemastery configuration for the camofox tool plugin. */
export const Config: z<Config> = z.object({
  serverUrl: z.string().default(DEFAULT_SERVER_URL),
  autoStart: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
})

interface CamofoxTab {
  tabId: string
  url: string
  title?: string
  screenshot?: CamofoxScreenshot
}

interface CamofoxScreenshot {
  data: string
  mimeType: 'image/png'
}

interface CamofoxSnapshot {
  snapshot: string
  url?: string
  refsCount?: number
  truncated?: boolean
  totalChars?: number
  screenshot?: CamofoxScreenshot
}

interface CamofoxClickResult {
  ok: boolean
  ref?: string
  selector?: string
  screenshot?: CamofoxScreenshot
}

interface CamofoxTypeResult {
  ok: boolean
  ref?: string
  text: string
  screenshot?: CamofoxScreenshot
}

interface CamofoxScrollResult {
  ok: boolean
  direction: 'up' | 'down'
  amount: number
  screenshot?: CamofoxScreenshot
}

/** Whether a value is a JSON object returned by the camofox server. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one required string field from a camofox response. */
function requiredString(value: Record<string, unknown>, key: string, path: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`camofox ${path} returned an invalid ${key}`)
  }
  return field
}

/** Read one optional string field from a camofox response. */
function optionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string') throw new Error(`camofox ${path} returned an invalid ${key}`)
  return field
}

/** Read one optional finite number field from a camofox response. */
function optionalNumber(value: Record<string, unknown>, key: string, path: string): number | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new Error(`camofox ${path} returned an invalid ${key}`)
  }
  return field
}

/** Read one optional boolean field from a camofox response. */
function optionalBoolean(value: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'boolean') throw new Error(`camofox ${path} returned an invalid ${key}`)
  return field
}

/** Validate the bounded PNG metadata returned by camofox for the chat panel. */
function optionalScreenshot(value: Record<string, unknown>, key: string, path: string): CamofoxScreenshot | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (!isRecord(field)) throw new Error(`camofox ${path} returned an invalid ${key}`)
  const data = requiredString(field, 'data', `${path}.${key}`)
  const mimeType = requiredString(field, 'mimeType', `${path}.${key}`)
  if (mimeType !== 'image/png') throw new Error(`camofox ${path} returned an unsupported screenshot MIME type`)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    throw new Error(`camofox ${path} returned invalid screenshot data`)
  }
  if (Buffer.from(data, 'base64').byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error(`camofox ${path} returned an oversized screenshot`)
  }
  return { data, mimeType: 'image/png' }
}

/** Read one required boolean field from a camofox response. */
function requiredBoolean(value: Record<string, unknown>, key: string, path: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`camofox ${path} returned an invalid ${key}`)
  return field
}

/** Validate the tab id before it becomes a URL path segment. */
function tabPath(tabId: string): string {
  if (tabId.length === 0 || tabId.length > 256 || /[\u0000-\u001f\u007f/\\?#]/.test(tabId)) {
    throw new Error('tabId must be a non-empty URL-safe string')
  }
  return encodeURIComponent(tabId)
}

/** Validate the element reference format emitted by camofox snapshots. */
function elementRef(ref: string): string {
  if (!/^e[1-9]\d{0,8}$/.test(ref)) throw new Error('ref must be an element reference from the latest browser_snapshot')
  return ref
}

/** The parsed endpoint used by the client and, when enabled, its managed server. */
interface CamofoxEndpoint {
  baseUrl: string
  hostname: string
  port: number
  protocol: 'http:' | 'https:'
}

/** Validate the configured server URL and remove its trailing slash. */
function parseServerUrl(serverUrl: string): CamofoxEndpoint {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    throw new Error('tool-camofox: serverUrl must be a valid HTTP(S) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('tool-camofox: serverUrl must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('tool-camofox: serverUrl must not contain credentials')
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('tool-camofox: serverUrl must not contain a path, query, or fragment')
  }
  const port = parsed.port === '' ? (parsed.protocol === 'http:' ? 80 : 443) : Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('tool-camofox: serverUrl must use a valid TCP port')
  }
  return {
    baseUrl: parsed.href.replace(/\/$/, ''),
    hostname: parsed.hostname,
    port,
    protocol: parsed.protocol,
  }
}

/** Whether an endpoint can be safely owned by the local managed server. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Build the managed camofox-browser process specification. */
function serverSpawnSpec(endpoint: CamofoxEndpoint): SubprocessSpawnSpec {
  if (endpoint.protocol !== 'http:' || !isLoopbackHost(endpoint.hostname)) {
    throw new Error('tool-camofox: autoStart requires an HTTP loopback serverUrl')
  }
  const entry = fileURLToPath(import.meta.resolve('@askjo/camofox-browser'))
  return {
    argv: [process.execPath, entry],
    cwd: process.cwd(),
    env: {
      CAMOFOX_PORT: String(endpoint.port),
      CAMOFOX_BIND_HOST: endpoint.hostname === 'localhost' ? '127.0.0.1' : endpoint.hostname,
    },
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: SERVER_OUTPUT_MAX_BYTES },
      stderr: { maxBytes: SERVER_OUTPUT_MAX_BYTES },
    },
    graceMs: SERVER_KILL_GRACE_MS,
  }
}

/** Wait for the managed server's health endpoint or its early process exit. */
async function waitForServer(
  endpoint: CamofoxEndpoint,
  handle: SubprocessHandle,
  signal: AbortSignal,
): Promise<void> {
  const healthUrl = `${endpoint.baseUrl}/health`
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS
  const earlyExit = handle.done.then((outcome) => {
    throw new Error(`camofox-browser exited before becoming healthy (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`)
  })
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) })
        if (response.ok) return
      } catch (error) {
        if (signal.aborted) throw error
      }
      await Promise.race([
        new Promise<void>(resolve => setTimeout(resolve, 250)),
        earlyExit,
      ])
    }
  } finally {
    // `earlyExit` is attached to handle.done for the whole wait, so an early
    // process exit cannot become an unhandled rejection after a health timeout.
    void earlyExit.catch(() => {})
  }
  throw new Error(`camofox-browser did not become healthy at ${healthUrl} within ${SERVER_STARTUP_TIMEOUT_MS}ms`)
}

/** Start the bundled server and wait until its HTTP endpoint accepts requests. */
async function startServer(ctx: Context, endpoint: CamofoxEndpoint, signal: AbortSignal): Promise<SubprocessHandle> {
  const handle = ctx.subprocess.spawn(serverSpawnSpec(endpoint))
  try {
    await waitForServer(endpoint, handle, signal)
    return handle
  } catch (error) {
    handle.terminate()
    await handle.done.catch(() => {})
    await handle.waitForExit()
    throw error
  }
}

/** Register the managed server's teardown with the plugin lifecycle. */
function ownServer(ctx: Context, handle: SubprocessHandle): void {
  ctx.effect(() => async () => {
    handle.terminate()
    await handle.done.catch(() => {})
    await handle.waitForExit()
  }, 'tool-camofox: managed server')
}

/** Validate a cooperative browser timeout. */
function timeoutMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('tool-camofox: timeoutMs must be a positive safe integer')
  }
  if (value > MAX_TIMEOUT_MS) {
    throw new Error(`tool-camofox: timeoutMs must be no greater than ${MAX_TIMEOUT_MS}`)
  }
}

/**
 * HTTP client for one exact camofox user/session pair. Every request carries
 * the identity supplied by the tool execution, and every request observes the
 * tool's cancellation signal.
 */
class CamofoxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userId: string,
    private readonly sessionKey: string,
  ) {}

  private async post(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, userId: this.userId, sessionKey: this.sessionKey }),
      signal,
    })
    return this.read(response, path)
  }

  private async get(path: string, signal: AbortSignal, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`)
    url.searchParams.set('userId', this.userId)
    url.searchParams.set('sessionKey', this.sessionKey)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await fetch(url, { signal })
    return this.read(response, path)
  }

  /** Capture one viewport PNG without making visualization failures fail the browser action. */
  private async screenshot(tabId: string, signal: AbortSignal): Promise<CamofoxScreenshot> {
    const path = `/tabs/${tabPath(tabId)}/screenshot`
    const url = new URL(`${this.baseUrl}${path}`)
    url.searchParams.set('userId', this.userId)
    url.searchParams.set('sessionKey', this.sessionKey)
    const response = await fetch(url, { signal })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`camofox ${path} failed (${response.status})${text.length > 0 ? `: ${text.slice(0, 500)}` : ''}`)
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    if (mimeType !== 'image/png') throw new Error(`camofox ${path} returned an unsupported screenshot MIME type`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error(`camofox ${path} returned an oversized screenshot`)
    return { data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }
  }

  /** Keep browser actions successful when the optional visual capture is unavailable. */
  private async visual(tabId: string, signal: AbortSignal): Promise<{ screenshot?: CamofoxScreenshot }> {
    try {
      return { screenshot: await this.screenshot(tabId, signal) }
    } catch {
      return {}
    }
  }

  private async read(response: Response, path: string): Promise<Record<string, unknown>> {
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text
      throw new Error(`camofox ${path} failed (${response.status})${detail.length > 0 ? `: ${detail}` : ''}`)
    }
    let value: unknown
    try {
      value = await response.json()
    } catch (error: unknown) {
      throw new Error(`camofox ${path} returned invalid JSON: ${String(error)}`)
    }
    if (!isRecord(value)) throw new Error(`camofox ${path} returned a non-object response`)
    return value
  }

  async createTab(url: string, signal: AbortSignal): Promise<CamofoxTab> {
    const value = await this.post('/tabs', { url }, signal)
    const tabId = requiredString(value, 'tabId', 'POST /tabs')
    const returnedUrl = requiredString(value, 'url', 'POST /tabs')
    const title = optionalString(value, 'title', 'POST /tabs')
    const visual = await this.visual(tabId, signal)
    return {
      tabId,
      url: returnedUrl,
      ...title === undefined ? {} : { title },
      ...visual,
    }
  }

  async snapshot(tabId: string, signal: AbortSignal): Promise<CamofoxSnapshot> {
    const path = `/tabs/${tabPath(tabId)}/snapshot`
    const value = await this.get(path, signal, { includeScreenshot: 'true' })
    const snapshot = requiredString(value, 'snapshot', `GET ${path}`)
    const url = optionalString(value, 'url', `GET ${path}`)
    const refsCount = optionalNumber(value, 'refsCount', `GET ${path}`)
    const truncated = optionalBoolean(value, 'truncated', `GET ${path}`)
    const totalChars = optionalNumber(value, 'totalChars', `GET ${path}`)
    const screenshot = optionalScreenshot(value, 'screenshot', `GET ${path}`)
    return {
      snapshot,
      ...url === undefined ? {} : { url },
      ...refsCount === undefined ? {} : { refsCount },
      ...truncated === undefined ? {} : { truncated },
      ...totalChars === undefined ? {} : { totalChars },
      ...screenshot === undefined ? {} : { screenshot },
    }
  }

  async click(tabId: string, target: { ref: string } | { selector: string }, signal: AbortSignal): Promise<CamofoxClickResult> {
    const path = `/tabs/${tabPath(tabId)}/click`
    const value = await this.post(path, target, signal)
    const ref = optionalString(value, 'ref', `POST ${path}`)
    const selector = optionalString(value, 'selector', `POST ${path}`)
    return {
      ok: requiredBoolean(value, 'ok', `POST ${path}`),
      ...ref === undefined ? {} : { ref },
      ...selector === undefined ? {} : { selector },
      ...await this.visual(tabId, signal),
    }
  }

  async type(tabId: string, ref: string, text: string, pressEnter: boolean, signal: AbortSignal): Promise<CamofoxTypeResult> {
    const path = `/tabs/${tabPath(tabId)}/type`
    const value = await this.post(path, { ref, text, pressEnter }, signal)
    const returnedRef = optionalString(value, 'ref', `POST ${path}`)
    return {
      ok: requiredBoolean(value, 'ok', `POST ${path}`),
      ...returnedRef === undefined ? {} : { ref: returnedRef },
      text: requiredString(value, 'text', `POST ${path}`),
      ...await this.visual(tabId, signal),
    }
  }

  async scroll(tabId: string, direction: 'up' | 'down', amount: number | undefined, signal: AbortSignal): Promise<CamofoxScrollResult> {
    const path = `/tabs/${tabPath(tabId)}/scroll`
    const value = await this.post(path, {
      direction,
      ...amount === undefined ? {} : { amount },
    }, signal)
    const returnedDirection = requiredString(value, 'direction', `POST ${path}`)
    if (returnedDirection !== direction) throw new Error(`camofox ${path} returned a mismatched direction`)
    const returnedAmount = optionalNumber(value, 'amount', `POST ${path}`)
    if (returnedAmount === undefined || !Number.isSafeInteger(returnedAmount) || returnedAmount < 1) {
      throw new Error(`camofox ${path} returned an invalid amount`)
    }
    return {
      ok: requiredBoolean(value, 'ok', `POST ${path}`),
      direction,
      amount: returnedAmount,
      ...await this.visual(tabId, signal),
    }
  }
}

/** Return the exact session identity for one model call. */
function identityFor(agent: Agent): { userId: string; sessionKey: string } {
  const id = String(agent.session.id)
  return { userId: id, sessionKey: 'dsh-browser' }
}

/** Return a client bound to one execution's agent and this plugin's endpoint. */
function clientFor(serverUrl: string, agent: Agent): CamofoxClient {
  const identity = identityFor(agent)
  return new CamofoxClient(serverUrl, identity.userId, identity.sessionKey)
}

/** Require agent ownership before touching external browser state. */
function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('camofox browser tools require an initiating agent')
  return agent
}

/** Validate model-side click arguments and enforce exactly one targeting method. */
function clickTarget(args: { ref?: string; selector?: string }): { ref: string } | { selector: string } {
  const hasRef = args.ref !== undefined
  const hasSelector = args.selector !== undefined
  if (hasRef === hasSelector) throw new Error('provide exactly one of ref or selector')
  if (hasRef) return { ref: elementRef(args.ref as string) }
  const selector = args.selector as string
  if (selector.trim().length === 0) throw new Error('selector must be a non-empty CSS selector')
  return { selector }
}

/** Validate a tab id and return it unchanged for the client path guard. */
function validateTabId(tabId: string): string {
  tabPath(tabId)
  return tabId
}

/** Validate a positive scroll amount when the model supplies one. */
function validateScrollAmount(amount: number | undefined): void {
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 1)) {
    throw new Error('amount must be a positive safe integer when supplied')
  }
}

/** Extract one validated screenshot from a tool value or its durable metadata. */
function screenshotFrom(value: unknown): CamofoxScreenshot | undefined {
  if (!isRecord(value)) return undefined
  return optionalScreenshot(value, 'screenshot', 'tool result')
}

/** Keep screenshot bytes in presentation metadata while leaving model text unchanged. */
function browserPresentationMeta(_args: unknown, value: JsonValue): JsonValue {
  const screenshot = screenshotFrom(value)
  return screenshot === undefined ? null : {
    screenshot: { data: screenshot.data, mimeType: screenshot.mimeType },
  }
}

/** Project the metadata-backed screenshot into the browser-specific UI card. */
function browserPresentResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
  const screenshot = screenshotFrom(result.meta)
  return screenshot === undefined ? undefined : { card: 'browser', screenshot }
}

/** Optional screenshot property shared by all camofox output schemas. */
const SCREENSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: { type: 'string', required: true },
    mimeType: { type: 'string', required: true },
  },
} as const

/** Register the camofox tools and their model-facing operating guidance. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const endpoint = parseServerUrl(config.serverUrl ?? DEFAULT_SERVER_URL)
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  timeoutMs(timeout)

  if (config.autoStart ?? true) {
    const setupAbort = new AbortController()
    const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) setupAbort.abort(new Error('tool-camofox setup disposed'))
    })
    try {
      ownServer(ctx, await startServer(ctx, endpoint, setupAbort.signal))
    } finally {
      stopSetupCancellation()
    }
  }

  ctx.systemPrompt.section({
    name: 'tool:camofox',
    order: 106,
    text: 'Use browser_navigate to open an HTTP(S) URL, then browser_snapshot before any interaction. '
      + 'browser_click accepts exactly one target: a ref such as "e5" from the latest snapshot or a CSS selector; '
      + 'browser_type requires a ref from the latest snapshot. Refs are page-specific: after navigation or a page-changing action, snapshot again before using a ref. '
      + 'After browser_scroll, snapshot again to inspect newly visible elements. Keep the tabId returned by browser_navigate for all later calls.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open an isolated browser tab and navigate to an HTTP(S) URL. Returns a tabId for subsequent operations.',
    parameters: {
      url: { type: 'string', required: true, description: 'HTTP(S) URL to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string' },
          screenshot: SCREENSHOT_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Opened tab ${value.tabId}${value.title ? ': ' + value.title : ''}\n${value.url}`,
      }],
      presentationMeta: browserPresentationMeta,
    },
    presentResult: browserPresentResult,
    timeoutMs: timeout,
    async execute(args, exec) {
      let url: URL
      try {
        url = new URL(args.url)
      } catch {
        throw new Error('url must be a valid HTTP(S) URL')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must use http or https')
      if (url.username !== '' || url.password !== '') throw new Error('url must not contain credentials')
      const agent = requireAgent(exec.agent)
      return clientFor(endpoint.baseUrl, agent).createTab(url.toString(), exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Get the latest accessibility snapshot for a tab. Returns the element refs available to browser_click and browser_type.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'The tab ID from browser_navigate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot: { type: 'string', required: true },
          url: { type: 'string' },
          refsCount: { type: 'number' },
          truncated: { type: 'boolean' },
          totalChars: { type: 'number' },
          screenshot: SCREENSHOT_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.snapshot }],
      presentationMeta: browserPresentationMeta,
    },
    presentResult: browserPresentResult,
    timeoutMs: timeout,
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      return clientFor(endpoint.baseUrl, agent).snapshot(validateTabId(args.tabId), exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click one element using either a ref from the latest browser_snapshot or a CSS selector. Do not provide both.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'The tab ID.' },
      ref: { type: 'string', description: 'Element ref from the latest browser_snapshot, for example "e5".' },
      selector: { type: 'string', description: 'CSS selector alternative to ref.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ref: { type: 'string' },
          selector: { type: 'string' },
          screenshot: SCREENSHOT_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Clicked ${value.ref ?? value.selector ?? 'element'}` : 'Click failed',
      }],
      presentationMeta: browserPresentationMeta,
    },
    presentResult: browserPresentResult,
    timeoutMs: timeout,
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      return clientFor(endpoint.baseUrl, agent).click(validateTabId(args.tabId), clickTarget(args), exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an input using a ref from the latest browser_snapshot, not a CSS selector.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'The tab ID.' },
      ref: { type: 'string', required: true, description: 'Input element ref from the latest browser_snapshot.' },
      text: { type: 'string', required: true, description: 'Text to type; an empty string clears the field.' },
      pressEnter: { type: 'boolean', description: 'Press Enter after typing (default: false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ref: { type: 'string' },
          text: { type: 'string', required: true },
          screenshot: SCREENSHOT_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Typed "${value.text}" into ${value.ref ?? 'input'}` : 'Type failed',
      }],
      presentationMeta: browserPresentationMeta,
    },
    presentResult: browserPresentResult,
    timeoutMs: timeout,
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      return clientFor(endpoint.baseUrl, agent).type(
        validateTabId(args.tabId),
        elementRef(args.ref),
        args.text,
        args.pressEnter ?? false,
        exec.signal,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll a tab up or down, then use browser_snapshot to inspect the new viewport.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'The tab ID.' },
      direction: {
        type: 'string',
        required: true,
        enum: ['up', 'down'],
        description: 'Scroll direction.',
      },
      amount: { type: 'number', description: 'Positive scroll amount in pixels; omit to use camofox-browser default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          direction: { type: 'string', required: true, enum: ['up', 'down'] },
          amount: { type: 'number', required: true },
          screenshot: SCREENSHOT_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Scrolled ${value.direction} ${value.amount}px` : 'Scroll failed',
      }],
      presentationMeta: browserPresentationMeta,
    },
    presentResult: browserPresentResult,
    timeoutMs: timeout,
    async execute(args, exec) {
      validateScrollAmount(args.amount)
      const agent = requireAgent(exec.agent)
      return clientFor(endpoint.baseUrl, agent).scroll(validateTabId(args.tabId), args.direction, args.amount, exec.signal)
    },
  }))
}
