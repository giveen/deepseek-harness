# @deepseek-ai/dsh-tool-camofox

English | [中文](README.zh.md)

Browser automation tools for the DeepSeek Harness agent, backed by [camofox-browser](https://github.com/jo-inc/camofox-browser). Each agent gets an isolated camofox user session; browser calls require an initiating agent and forward tool cancellation to the server.

## Installation and startup

`@askjo/camofox-browser` is a required runtime dependency of this package. Its install hook fetches the Camoufox browser binary (about 300 MB on the first install). The dsh package adds an idempotent postinstall check: an existing cache is reused, while a change to the installed camofox-browser or camoufox-js version refreshes the binary into a staging directory and swaps it in only after a successful download. A failed refresh keeps the previous cache and lets installation continue with a warning. The bundled dsh composition starts the server automatically on `127.0.0.1:9377`, waits for `/health`, and stops it with the dsh process. Set `CAMOFOX_SKIP_DOWNLOAD=1` only when you provide a compatible external Camoufox executable through `CAMOUFOX_EXECUTABLE`.

The server is not shared with an unrelated process: dsh owns this loopback process and the tools connect to the same canonical `http://127.0.0.1:9377` endpoint.

## Prerequisites

- A platform supported by [camofox-browser](https://github.com/jo-inc/camofox-browser) and its Camoufox binary

## Tools

| Tool | Description |
|---|---|
| `browser_navigate` | Open an HTTP(S) tab and return its `tabId` |
| `browser_snapshot` | Get the latest accessibility tree and page-specific element refs |
| `browser_click` | Click exactly one element by a current ref or CSS selector |
| `browser_type` | Type text into an input by a current snapshot ref |
| `browser_scroll` | Scroll the page up or down |

Call `browser_snapshot` before using a ref. Refs can become stale after navigation or a page-changing action; snapshot again before the next ref interaction. After scrolling, snapshot again to inspect newly visible elements. `browser_click` supports either `ref` or `selector`, but not both. `browser_type` accepts refs only.

## Integration

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: tool-camofox
      name: '@deepseek-ai/dsh-tool-camofox'
      config:
        autoStart: true
        serverUrl: 'http://127.0.0.1:9377'
```

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `serverUrl` | `string` | `http://127.0.0.1:9377` | HTTP(S) camofox-browser server URL without embedded credentials |
| `autoStart` | `boolean` | `true` | Start and own the bundled server; requires an HTTP loopback URL |
| `timeoutMs` | `number` | `30000` | Cooperative timeout budget for each browser tool call; must be at most `2147483647` |

## Runtime behavior

With `autoStart: true`, plugin activation fails if the bundled server cannot start or does not answer `/health` within 30 seconds. The plugin owns that process and waits for it to stop during teardown. The plugin validates camofox JSON responses before returning them to the model and rejects malformed responses or HTTP failures. It sends `userId` from the calling agent's session id and groups that agent's tabs under `sessionKey: dsh-browser`; it does not share browser cookies between agents. The current client is intended for a loopback camofox server; do not expose the server beyond loopback because this plugin does not yet carry an access-key credential. Binary refresh failures are non-fatal during installation, but startup still reports a missing or unusable browser through the managed server readiness path.

The model-facing tools expose no browser credentials, access key, or timeout argument. `timeoutMs` is deployment policy attached to the tool definition, and the tool forwards its cancellation signal to every request.

## Build

```sh
pnpm --filter @deepseek-ai/dsh-tool-camofox exec tsc -b
```

## Model Experience

### Browser interactions

#### What the model sees

The model receives five tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_scroll`. A navigation result supplies a `tabId`; a snapshot supplies page-specific refs such as `e5`; click accepts one current ref or CSS selector; type accepts a current ref; and scroll returns a direction and amount. The prompt instructs the model to snapshot before ref use and after navigation, page-changing actions, or scrolling.

#### Token effect

Accessibility snapshots are substantially smaller than raw page HTML, but each snapshot still enters the conversation as model-visible text. The model should snapshot only when it needs current refs or newly visible content and should avoid repeating unchanged snapshots.

#### KV Cache effect

The tool schemas and operating guidance stay stable across calls, while tab ids, URLs, snapshots, refs, and action results vary per session. Repeated browser actions therefore reuse the stable tool prefix but append changing page state to the request context.
