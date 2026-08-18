# Agent Note: Camofox tool boundaries and browser guidance

Status: implemented

English | [中文](2026-08-18-camofox-tool-boundaries.zh.md)

## Problem

The camofox tools forwarded model arguments to an external browser server with unchecked response casts, a shared hardcoded browser identity, no cancellation signal, and guidance that contradicted the server API by rejecting CSS selectors even though `browser_click` accepted them. A malformed response could become an invalid model result, and unrelated agents could share browser cookies and tabs.

## Decision

The five-tool surface remains `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_scroll`. The plugin now:

- requires an initiating agent and uses that agent's session id as camofox `userId`, with `dsh-browser` as the stable tab-group `sessionKey`;
- forwards `exec.signal` to every HTTP request and attaches one validated cooperative `timeoutMs` budget to each tool;
- validates the configured HTTP(S) server URL, target tab paths, browser URLs, element refs, click target exclusivity, and scroll amounts before network access;
- validates required wire fields and projects only the fields declared by each tool output schema, rejecting malformed JSON and HTTP failures;
- describes the actual interaction sequence: snapshot before refs, refresh refs after navigation or page-changing actions, snapshot after scrolling, and choose exactly one click target.

The client does not expose camofox access credentials or add a model-facing timeout argument. The current client is intended for a loopback camofox server; it does not carry an access-key credential, so exposing the server beyond loopback is deferred.

## Alternatives considered

**Keep one shared `dsh-agent` browser identity.** Rejected because camofox's `userId` is the cookie and storage isolation key; sharing it makes unrelated agent sessions observe and mutate the same browser state.

**Trust the typed JSON response from `fetch().json()`.** Rejected because camofox is an external process and its response is a wire boundary. Required fields are checked and extra protocol fields are discarded before the tool output is validated.

**Remove CSS selectors from `browser_click`.** Rejected because camofox supports both accessibility refs and CSS selectors. The tool keeps both choices and makes the mutually exclusive requirement explicit instead of advertising a false limitation.

**Use a local timeout race that abandons the request.** Rejected because abandoned external work can outlive the tool pipeline. The tool uses the harness signal and the configured cooperative timeout contract so the underlying fetch can observe cancellation.

## Consequences

Browser state is isolated per live agent session, while tabs from that agent share one camofox session group. Direct agentless calls fail closed rather than falling into a shared browser identity. The model receives actionable guidance for stale refs and CSS targeting, and malformed server behavior becomes a structured tool failure instead of an invalid successful value.

When `autoStart` is enabled, the bundled server process is owned and stopped by the plugin; when it is disabled, an external server remains responsible for its own lifecycle. The server remains responsible for authentication, URL policy beyond the tool's HTTP(S) check, and its own handler limits. The plugin does not add tab-close or session-destroy tools; those are deferred until the model-facing lifecycle surface has an owner and a durable cleanup policy. The install and startup decision is recorded in [the bundled-server note](../feature/2026-08-18-camofox-bundled-server.md).

## Testing

`packages/web/camofox/tests/tools.spec.ts` exercises registration and prompt guidance, agentless rejection, identity and signal forwarding, GET query identity, response projection, CSS/ref validation, click exclusivity, scroll validation, malformed wire responses, and HTTP failure handling through the real tool registry. The package typecheck covers the external protocol client and all five output schemas.
