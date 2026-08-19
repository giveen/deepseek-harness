# Agent Note: Built-in codebase-memory MCP integration

Status: implemented

English | [中文](2026-08-19-codebase-memory-mcp-integration.zh.md)

## Problem

The harness needs local structural code intelligence that the model can use before broad filesystem exploration, without introducing a second MCP lifecycle, a cloud dependency, or an unauthenticated LAN listener. The Web GUI also needs to expose the upstream graph interface beside the existing Chat, Trajectory, Files, and Commits views.

## Decision

The shared bundle owns `@deepseek-ai/dsh-codebase-memory`, which depends on the pinned MIT-licensed `codebase-memory-mcp` npm package. The upstream package's postinstall owns its checksum-verified native runtime and package-manager updates. At runtime the harness launches the installed `bin.js` wrapper through the existing `dsh-mcp-client` stdio bridge, using the current project directory as `cwd`, and publishes discovered tools under the stable `mcp__codebase-memory__*` namespace. Startup remains recoverable: an unavailable binary or MCP handshake enters the bridge's reconnect behavior without preventing the rest of the harness from loading.

The upstream graph UI runs on loopback port `9749`. The Web bundle proxies `/codebase-memory/` to that endpoint and rewrites the upstream UI's absolute `/api`, `/rpc`, and `/assets` paths under the proxy prefix. The conversation view embeds this same-origin route beside Chat, Trajectory, Files, and Commits, while the native listener remains loopback-only.

The model-facing prompt asks for architecture, structural search, semantic search, code search, call-trace, impact, and index-coverage operations before broad file exploration. Results narrow the candidate set; normal filesystem reads remain required to verify exact source lines before editing, and empty results do not establish absence without checking scope and index freshness.

## Consequences

- Installing the shared bundle installs or reuses the upstream platform runtime and allows package-manager upgrades without a running-harness self-updater.
- A single host-owned MCP bridge exposes the upstream tools to the model and removes them cleanly on plugin disposal.
- LAN browsers can use the graph UI through the harness origin without direct access to port `9749`; the proxy returns an explicit unavailable response when the native UI is down.
- The Codebase Memory tab depends on the upstream UI and remains independent of Chat, Trajectory, Files, and Commits when that UI is unavailable.
- The graph is local evidence, not a replacement for exact file reads, tests, or repository checks. Graph artifacts are not committed unless the user explicitly requests them.

## Alternatives considered

**Spawn one server per agent.** Rejected because it duplicates native processes, UI listeners, and graph coordination; one host composition owns the bridge.

**Expose port `9749` on all interfaces.** Rejected because it adds an unauthenticated native listener. The Web server is the shared transport and the native UI stays loopback-only.

**Implement a second graph UI in the client.** Rejected because it forks upstream UI behavior and duplicates its protocol. The panel embeds the maintained upstream UI through a same-origin proxy.

**Download or update the native binary during harness startup.** Rejected because normal startup would become a downloader and could race active sessions. Package-manager and postinstall maintenance remain the update path.
