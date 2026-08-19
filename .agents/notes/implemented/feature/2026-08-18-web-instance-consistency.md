# Agent Note: Web instance consistency check

Status: implemented

English | [中文](2026-08-18-web-instance-consistency.zh.md)

## Problem

The Web bundle can advertise a LAN URL while loopback and LAN traffic reach different harness processes, especially when network namespaces, stale servers, or separate launch environments are involved. Session lists and live Agents are owned by one Host process, so two valid HTTP/WebSocket connections can still show different sessions without any browser-origin scoping bug.

## Decision

`dsh web` takes an exclusive `$DSH_HOME/web-host.lock` before booting. A live owner causes the second invocation to fail before it mounts a second API surface; a lock whose recorded process no longer exists is recovered automatically. This prevents two normal Web launches from silently creating independent session stores. `host.describe` also carries an opaque process-lifetime `instanceId`. After the Web Loader settles, the Web runtime probes each LAN authority it advertised and compares that response's instance ID with the local API's. A mismatch emits a warning that names the authority and explains that session sharing is unavailable there; a failed probe emits a separate reachability warning. The probe is best-effort and bounded by the configurable `lanInstanceProbeTimeoutMs` value. It does not merge processes, select a different endpoint, or weaken the API trust fence.

The existing session list remains Host-owned and origin-independent. Loopback and LAN URLs served by one process therefore continue to share attached sessions, persisted sessions, and live event streams. The browser carrier mints RPC ids with `crypto.getRandomValues()` instead of secure-context-only `crypto.randomUUID()`, so ordinary HTTP LAN origins can complete the list and readiness calls. Independent processes require one shared deployment and lifecycle; they are not a supported live-session-sharing mechanism.

## Trusted LAN configuration

The same trusted-host policy now covers the settings and credential configuration plane. `settings.describe`/`update`/`replace`/`mutate`, `credentials.describe`/`set`/`unset`, and `llm.discoverModels` are available from a declared LAN authority so a remote operator can see and manage the provider directory and settings page. Host-native actions, settings-document opening, and preset authoring remain loopback-only. This is an explicit reachability grant rather than authentication: deployments that expose Web beyond a private trusted network must put an authenticated proxy in front of it. Browser settings scopes use the Host document for trusted LAN pages instead of silently falling back to process-local memory.

## Alternatives considered

**Scope sessions by browser origin or local storage.** Rejected because the desired behavior is host-wide sharing, and browser storage cannot identify the same Host process across `127.0.0.1` and a LAN address.

**Merge separate processes through the Web client.** Rejected because live Agent ownership, prompt routing, event ordering, and filesystem writes would need a coordination service; silently merging two Hosts would risk duplicate execution and divergent logs.

**Treat the LAN probe failure as a boot failure.** Rejected because an interface may be intentionally unreachable from the server's own network namespace while remote clients can still reach it. The warning identifies the deployment problem without preventing loopback startup. The same-home process lock is separate: it is deterministic local ownership and therefore fails a second normal Web launch.

## Consequences

An operator receives a clear lock failure or actionable LAN warning instead of an empty-session symptom with no explanation. The lock records only the owner PID with owner-only permissions, and the instance ID is opaque and carries no filesystem path or user identity. Startup performs one bounded local request per advertised LAN IPv4 address; no model-visible or durable session data changes.

## Testing

The host response schema remains backward-compatible because `instanceId` is optional on the wire. Lock tests cover live-owner rejection, dead-owner recovery, and replacement-owner protection. Existing API and Web bundle tests cover the unchanged transport and startup paths; the carrier test also removes `crypto.randomUUID` while retaining `getRandomValues` to verify HTTP LAN compatibility. Full typechecking and focused Web/API tests verify the new response field, diagnostics, and carrier behavior.
