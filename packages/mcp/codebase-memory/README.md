# @deepseek-ai/dsh-codebase-memory

English | [中文](README.zh.md)

Built-in integration for [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp). The package launches the upstream native MCP server through the harness's existing MCP client bridge, exposes its discovered tools to the model, and starts the upstream graph UI for the Web panel.

## Installation and startup

The shared `dsh-base` bundle includes this package and the pinned `codebase-memory-mcp@0.10.8` runtime dependency. Installing the bundle runs the upstream npm postinstall, which downloads or reuses its platform-verified native runtime. A valid existing runtime is reused; package-manager updates replace it according to the upstream package's installer. The harness does not download, replace, or update the executable while a session is running.

The bundled composition starts the server from the installed package wrapper with the current project directory as its working directory. The optional graph UI listens on `127.0.0.1:9749`; the Web bundle reverse-proxies it through the harness so LAN clients do not need direct loopback access to the host.

If the native runtime is unavailable, the MCP client remains in its recoverable reconnect state and the rest of the harness still starts. The model receives the guidance section, but no codebase-memory tools are advertised until discovery succeeds.

## Web panel

This is local-only code intelligence. It is evidence for narrowing a search, not permission to make unsupported claims: an empty or stale graph result must be checked against scope and index freshness. Graph data and generated artifacts are not committed unless the user explicitly requests that.

The Web conversation view adds a **Codebase Memory** tab beside Chat, Trajectory, Files, and Commits. It embeds the upstream graph UI through `/codebase-memory/`, preserving the UI's project, graph, statistics, and control tabs. The harness proxy also rewrites the upstream UI's absolute asset and API paths so it cannot collide with the harness `/api` routes.

The panel is same-origin with the harness and is sandboxed to scripts and same-origin access. The proxy removes only upstream `X-Frame-Options` and CSP `frame-ancestors` directives that would reject the embedded route, while preserving the remaining response policy. If the native UI is unavailable, the panel displays the upstream failure state while ordinary Chat, Trajectory, Files, and Commits remain usable.

## Configuration

The base composition uses these defaults:

| Key | Default | Description |
|---|---|---|
| `cwd` | current process directory | Working directory for the MCP server |
| `ui` | `true` | Start the upstream graph UI |
| `toolCallTimeoutMs` | `60000` | Timeout for one discovered MCP tool call |
| `env` | `{}` | Explicit environment additions passed to the child |

To override the composition, patch the `codebase-memory` row in a profile's `cordis.patch.yml`. The UI port is the upstream protocol constant `9749` and is intentionally not configurable independently of the Web proxy.

## Upstream maintenance

The upstream package is MIT-licensed and is pinned in the bundle dependency graph. To update it, change the dependency version, run the workspace install and build checks, and review the upstream release notes. The running harness intentionally has no self-updater and makes no background version check.

## Build

```sh
pnpm --filter @deepseek-ai/dsh-codebase-memory exec tsc -b
```

## Model Experience

### Discovered codebase-memory tools

#### What the model sees

Each discovered upstream tool appears under a stable harness name such as `mcp__codebase-memory__search_code`, with the upstream description and input schema. The prompt guidance asks the model to use architecture, project-list, structural-search, semantic-search, code-search, call-trace, impact, and index-coverage operations before broad file walking, then verify exact source lines with normal filesystem tools before editing.

#### Token effect

The discovered schemas are included in model requests while the MCP server is available. Structural results are intended to narrow later filesystem reads, reducing the tokens spent opening unrelated files; large graph responses still consume context and should be scoped.

#### KV Cache effect

The codebase-memory prompt guidance and stable tool schemas remain prefix-stable while the discovered tool list is unchanged. Project names, queries, and graph results vary per task and append after that stable prefix.

## Known Limitations and Deferred Work

- The native graph UI is fixed to loopback port `9749`; changing it requires a coordinated upstream and Web-proxy change.
- The graph is a local evidence source. It does not replace exact filesystem reads, tests, or repository checks.
- Resources and prompts from the upstream MCP server are not bridged; discovered tools are the supported MCP capability.
