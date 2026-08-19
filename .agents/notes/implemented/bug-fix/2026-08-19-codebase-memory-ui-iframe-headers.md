# Agent Note: Allow the codebase-memory graph UI in the harness iframe

Status: implemented

English | [中文](2026-08-19-codebase-memory-ui-iframe-headers.zh.md)

## Problem

The upstream graph UI can send `X-Frame-Options` or a CSP `frame-ancestors` directive intended for top-level use. The harness serves that UI through a same-origin sandboxed iframe, but forwarding those headers unchanged makes Firefox refuse to display the Codebase Memory panel.

## Decision

The Web proxy removes the upstream `X-Frame-Options` header and removes only the `frame-ancestors` directive from the upstream Content-Security-Policy. All other response headers and CSP directives remain unchanged. The route continues to use the harness-owned sandboxed iframe and the native graph server remains loopback-only.

## Consequences

- Firefox and other browsers can render the graph UI at `/codebase-memory/` inside the conversation view.
- The upstream UI keeps its remaining CSP restrictions and is not exposed as a second network listener.
- The proxy owns the embedding exception because the upstream server cannot know that its response is being mounted under the harness origin.

## Alternatives considered

**Remove the entire Content-Security-Policy header.** Rejected because the embedding exception only requires changing one directive; removing unrelated policy would unnecessarily widen the UI's browser execution policy.

**Open the graph UI in a new window instead of embedding it.** Rejected because the feature is intended to sit beside Chat, Trajectory, Files, and Commits and would lose the shared workspace context.

**Expose port 9749 directly and let the browser open it.** Rejected because it would bypass the harness origin and expose the unauthenticated graph server beyond the loopback proxy boundary.
