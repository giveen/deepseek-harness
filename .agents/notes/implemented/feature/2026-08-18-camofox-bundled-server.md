# Agent Note: Camofox bundled server lifecycle

Status: implemented

English | [中文](2026-08-18-camofox-bundled-server.zh.md)

## Problem

The camofox tool package required an independently installed and running browser server, so a unified dsh installation could expose browser tools that had no reachable backend and each deployment had to reproduce the port configuration manually.

## Decision

`@deepseek-ai/dsh-tool-camofox` declares `@askjo/camofox-browser` as a runtime dependency, so the unified package installation carries the server and its Camoufox binary installation hook. Its package-owned postinstall records the installed `@askjo/camofox-browser` and `camoufox-js` versions beside the cache: matching caches are reused, while a version change downloads into a staging directory and atomically replaces the cache only after success. A failed refresh preserves the previous cache and exits successfully with a warning. The base bundle configures one `tool-camofox` row with `autoStart: true` and `http://127.0.0.1:9377`.

When enabled, the plugin starts the package's server entry through `ctx.subprocess`, passes `CAMOFOX_PORT=9377` and `CAMOFOX_BIND_HOST=127.0.0.1`, polls `/health` before completing activation, and owns process teardown through the same subprocess service. Startup fails loud after 30 seconds when the server exits or does not become healthy. The managed endpoint must be HTTP on a loopback host; externally managed deployments may set `autoStart: false` and retain the validated HTTP(S) client configuration.

The five model-facing tools and their protocol surface remain unchanged. The server process uses collected output rather than inherited stdout or stderr, so its structured logs cannot corrupt an ACP or other parent protocol stream.

## Alternatives considered

**Require users to start camofox-browser separately.** Rejected because installation and the shipped base composition would still not establish a usable browser capability, and every launcher would need a separate readiness and port instruction.

**Spawn the server with `node:child_process` inside the tool package.** Rejected because process ownership, cancellation, tree termination, and teardown already belong to the `ctx.subprocess` capability seam.

**Start the server lazily on the first browser call.** Rejected because tool registration would claim a capability whose readiness failure appears only during a model request; activation is the earliest resolvable point for this self-contained requirement.

**Bind the managed server beyond loopback or allow arbitrary URL paths.** Rejected because the client has no access-key credential and the server URL is a host connection, not an HTTP reverse-proxy route; the unified default stays on one explicit loopback port.

## Consequences

A normal first installation may download roughly 300 MB of Camoufox binaries. Repeated installs reuse a cache tied to the upstream package versions, and dependency updates refresh through a staging directory so a blocked update does not destroy a working previous binary. A missing cache remains an actionable startup failure rather than an apparently working browser tool. The managed process lasts exactly as long as the plugin and is included in the subprocess service's tree cleanup.

Profiles that intentionally use a separately supervised or remote server can opt out of ownership with `autoStart: false`; the base profile does not use that escape hatch. The server package's own optional features and credentials remain outside this five-tool surface.

## Testing

`packages/web/camofox/tests/tools.spec.ts` verifies the canonical spawn environment, loopback endpoint health gate, and teardown-owned fake process while the existing wire tests continue to cover the five unchanged tools. `packages/web/camofox/tests/binary-install.spec.ts` verifies cache reuse, version-triggered refresh, and preservation of the old cache after a failed refresh. Package typecheck and the unified build/install checks cover the new runtime dependency and bundle row.
