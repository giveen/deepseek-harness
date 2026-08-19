/**
 * @deepseek-ai/dsh-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * harness-source and web-surface prompt sections, the bash-visible web runtime
 * variable, and the URL line. App command-line values arrive through the
 * `webStartup` service expressions in the bundle patch.
 * @module @deepseek-ai/dsh-web-app
 */

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Runtime service that releases Web rows after bind-dependent values resolve. */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; SSH suppresses it. */
  openBrowser?: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the model-visible surface context (the `app:web-surface` prompt
   * section and the `DSH_WEB_URL` bash variable). A one-shot non-interactive
   * layer can turn it off when its user is not in the GUI, so the
   * orientation text would be false.
   */
  surfaceContext: boolean
  /** Explicit `--trusted-host` authorities from this invocation. */
  trustedHosts: string[]
  /** Maximum time allowed for one advertised-LAN instance probe. */
  lanInstanceProbeTimeoutMs?: number
}

/** Default deadline used when a hand-built test context bypasses schema normalization. */
const DEFAULT_LAN_INSTANCE_PROBE_TIMEOUT_MS = 2_000

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  lanInstanceProbeTimeoutMs: z.natural().min(1).default(2_000),
})

/** Bind-dependent Web values shared by the trust fence and URL display. */
export interface WebRuntimeValues {
  /** LAN IPv4 literals sampled once when the server binds all interfaces. */
  lanAddresses: string[]
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: string[]
}

/** Environment variable naming the canonical local URL of this Web GUI. */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/** Fixed loopback endpoint exposed by the built-in codebase-memory graph UI. */
const CODEBASE_MEMORY_UI_PORT = 9749
/** Harness-local prefix used to proxy the upstream graph UI without a second bind. */
const CODEBASE_MEMORY_UI_PREFIX = '/codebase-memory'

/** Rewrite absolute upstream UI URLs so its iframe stays inside the harness route. */
function rewriteCodebaseMemoryUiText(text: string): string {
  return text.replace(/(["'`(])\/(api|rpc|assets)(?=\/|["'`)])/g, '$1/codebase-memory/$2')
}

/**
 * Adapt upstream response headers for the same-origin embedded panel.
 *
 * The upstream UI is normally opened as a top-level page and may send
 * `X-Frame-Options` or `frame-ancestors` that forbid embedding. The harness
 * already confines this route to its sandboxed same-origin iframe, so remove
 * only those embedding directives and preserve every other CSP directive.
 * @param headers - upstream response headers.
 * @returns headers safe for the harness-owned embedded route.
 */
function embeddedCodebaseMemoryUiHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const adapted: OutgoingHttpHeaders = { ...headers }
  delete adapted['x-frame-options']
  const policy = adapted['content-security-policy']
  if (typeof policy === 'string') {
    const directives = policy.split(';')
      .map(directive => directive.trim())
      .filter(directive => directive.length > 0 && !directive.toLowerCase().startsWith('frame-ancestors'))
    if (directives.length === 0) delete adapted['content-security-policy']
    else adapted['content-security-policy'] = directives.join('; ')
  }
  return adapted
}

/** Proxy the upstream graph UI and its API while keeping the native server loopback-only. */
function proxyCodebaseMemoryUi(req: IncomingMessage, res: ServerResponse): void {
  let requestUrl: URL
  try {
    requestUrl = new URL(req.url ?? '/', 'http://dsh')
  } catch {
    res.writeHead(400)
    res.end('invalid codebase-memory URL')
    return
  }
  const suffix = requestUrl.pathname.slice(CODEBASE_MEMORY_UI_PREFIX.length) || '/'
  const targetPath = `${suffix}${requestUrl.search}`
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: CODEBASE_MEMORY_UI_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${String(CODEBASE_MEMORY_UI_PORT)}`,
      origin: `http://127.0.0.1:${String(CODEBASE_MEMORY_UI_PORT)}`,
      'accept-encoding': 'identity',
    },
  }, (response) => {
    const contentType = response.headers['content-type'] ?? ''
    const rewrite = /(?:text\/html|javascript|text\/css)/i.test(contentType)
    if (!rewrite || req.method === 'HEAD') {
      res.writeHead(response.statusCode ?? 502, embeddedCodebaseMemoryUiHeaders(response.headers))
      response.pipe(res)
      return
    }
    const chunks: string[] = []
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => { chunks.push(chunk) })
    response.on('end', () => {
      const body = Buffer.from(rewriteCodebaseMemoryUiText(chunks.join('')))
      const headers = embeddedCodebaseMemoryUiHeaders(response.headers)
      delete headers['content-length']
      delete headers.etag
      headers['content-length'] = String(body.byteLength)
      res.writeHead(response.statusCode ?? 502, headers)
      res.end(body)
    })
    response.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502)
      res.end(String(error))
    })
  })
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`codebase-memory UI unavailable: ${String(error)}`)
  })
  req.pipe(upstream)
}

/** Whether this process was launched through SSH, including a forwarded-port session. */
function launchedThroughSsh(ctx: Context): boolean {
  const environment = launchEnvironmentOf(ctx)
  return ['SSH_CONNECTION', 'SSH_TTY'].some((name) => {
    const value = environment.getFrom(name, ['process'])?.value
    return value !== undefined && value !== ''
  })
}

/** Absolute module path for the Web bundle's declared browser opener dependency. */
const OPEN_MODULE_PATH = createRequire(import.meta.url).resolve('open')

/** Small helper program that invokes the maintained platform opener in a scrubbed child. */
const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(process.argv[1])
  const launcher = await open(process.argv[2])
  if (process.platform === 'win32') {
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      const onError = (error) => { launcher.off('close', onClose); reject(error) }
      const onClose = (value) => { launcher.off('error', onError); resolve(value) }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
`

/** Start the default-browser handoff without forwarding credentials or DSH state. */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', OPEN_MODULE_PATH, url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** Hand one ready URL to the operating system's default browser. */
async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      launcher.off('close', onClose)
      reject(error)
    }
    const onClose = (code: number | null): void => {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\\r?\\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/**
 * Resolve one LAN-trust snapshot from the active server bind.
 *
 * Derived entries are port-less IP literals: DNS rebinding needs an
 * attacker-controlled name, while an IP-literal Host is safe on any port and
 * an OS-assigned port is unknowable before bind.
 * @param bindHost - the active webserver bind host.
 * @param extra - explicit `--trusted-host` values, in argument order.
 * @returns the LAN display addresses and invocation-derived fence authorities.
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/**
 * Probe the LAN authorities advertised by this process and warn when one is
 * served by another harness instance. Static files can come from a different
 * process while the page still renders, so this check uses the API's opaque
 * process identity rather than comparing URLs or attached-session counts.
 * @param ctx - context carrying the local API and logger.
 * @param runtime - bound LAN addresses and the configured probe deadline.
 */
async function checkLanInstances(
  ctx: Context,
  runtime: WebRuntimeValues,
  timeoutMs: number,
): Promise<void> {
  const api = ctx.root.get('apiProxy') as ApiProxy | undefined
  if (api === undefined || runtime.lanAddresses.length === 0) return
  const local = await api.host.describe({ rpcId: RpcId(`web-instance-local-${randomUUID()}`), payload: {} })
  if (!local.result.ok || local.result.value.instanceId === undefined) return
  for (const address of runtime.lanAddresses) {
    const authority = `${address}:${String(ctx.webServer.port)}`
    try {
      const response = await fetch(`http://${authority}/api/host.describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: RpcId(`web-instance-remote-${randomUUID()}`),
          method: 'host.describe',
          payload: {},
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const body: unknown = await response.json()
      const remote = (body as {
        result?: { ok?: unknown; value?: { instanceId?: unknown } }
      }).result
      if (remote?.ok !== true || typeof remote.value?.instanceId !== 'string') {
        throw new Error('host.describe returned no instance identity')
      }
      if (remote.value.instanceId !== local.result.value.instanceId) {
        ctx.logger.warn(
          `web-app: LAN authority ${authority} serves a different harness instance; `
          + 'session sharing is unavailable there. Stop the other dsh web process or use this instance\'s URL.',
        )
      }
    } catch (error: unknown) {
      ctx.logger.warn(`web-app: could not verify LAN authority ${authority}: ${String(error)}`)
    }
  }
}

/** Model-visible orientation and acceptance boundary for sessions created through `dsh web`. */
function webSurfacePrompt(webUrl: string): string {
  const updateContract = 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('web-app: webServer service missing while resolving Web runtime')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/** Dist location is workspace knowledge of this bundle: resolved through the frontend package exports, not configured. */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only on a checkout without a built dist; the test tree builds it */
    throw new Error('web-app: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/** Test hooks for the built dist resolver and native browser handoff. */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
  browserOpenerModulePath: string
  rewriteCodebaseMemoryUiText: (text: string) => string
  embeddedCodebaseMemoryUiHeaders: (headers: IncomingHttpHeaders) => OutgoingHttpHeaders
} = {
  resolveDistIndex,
  openBrowser,
  browserOpenerModulePath: OPEN_MODULE_PATH,
  rewriteCodebaseMemoryUiText,
  embeddedCodebaseMemoryUiHeaders,
}

/**
 * Mount the Web runtime: dist serving, surface prompt, the bash runtime
 * variable, and the URL line.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  const handoffBrowser = config.openBrowser !== false && !launchedThroughSsh(ctx)
  // The connection row is a sibling, not a child, so a service provided on
  // this row's context would be invisible to it. Publish the bind snapshot in
  // the shared root scope and attach that root disposer to this row's fiber;
  // the service remains available for the row's lifetime and is retracted with
  // it rather than leaking across reloads.
  const releaseRuntime = ctx.root.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.effect(() => releaseRuntime, 'web-runtime: shared bind snapshot')
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  // The native graph UI stays loopback-only; this same-origin prefix makes it
  // available to the Web client, including LAN clients, without exposing a
  // second unauthenticated listener. Text assets are rewritten because the
  // upstream bundle uses absolute /api, /rpc, and /assets URLs.
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: CODEBASE_MEMORY_UI_PREFIX, handler: proxyCodebaseMemoryUi }),
    'web-runtime: codebase-memory UI proxy',
  )
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, SOURCE_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: -98,
        text: () => webSurfacePrompt(localWebUrl(promptCtx)),
      })
    })
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Canonical local URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) }),
      })
    })
  }
  if (config.printUrl || handoffBrowser) {
    // The URL line and browser handoff are readiness signals: supervisors and
    // browsers must not observe a partially mounted Loader tree. Await Loader
    // settlement first; a hand-built tree without a Loader prints at once.
    const printUrl = (): void => {
      // Reuse the exact LAN snapshot provided to the /api trust fence.
      const lanCandidate = runtime.lanAddresses[0]
      const port = ctx.webServer.port
      const webUrl = localWebUrl(ctx)
      if (config.printUrl) {
        console.log(`dsh web: ${webUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate}:${String(port)})`}`)
      }
      if (handoffBrowser) {
        void internals.openBrowser(webUrl).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`web-app: could not open the default browser because ${reason}; visit ${webUrl} manually`)
        })
      }
    }

    // This row's own activation can precede a sibling failure. The app owns
    // readiness by waiting for its Loader tree, or prints at once in a
    // hand-built context without Loader.
    const settled = ctx.get('loader')?.await()
    const ready = (): void => {
      // The tree can be disposed while the boot was in flight (early
      // SIGTERM); a URL line for a dead server would only mislead, and
      // reading the torn-down port would turn a clean shutdown into a crash.
      if (ctx.get('webServer') === undefined) return
      printUrl()
      void checkLanInstances(
        ctx,
        runtime,
        config.lanInstanceProbeTimeoutMs ?? DEFAULT_LAN_INSTANCE_PROBE_TIMEOUT_MS,
      )
    }
    if (settled === undefined) ready()
    else {
      void settled.then(ready, () => {
        // Loader reports a failed boot; this row stays quiet.
      })
    }
  }
}
