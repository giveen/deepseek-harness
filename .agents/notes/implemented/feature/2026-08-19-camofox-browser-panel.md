# Agent Note: Camofox browser activity panel

Status: implemented

English | [中文](2026-08-19-camofox-browser-panel.zh.md)

## Problem

Camofox browser calls exposed accessibility text and action receipts, but the Web chat gave no visual indication of the page state the agent was inspecting.

## Decision

Each successful camofox operation makes a best-effort request to the server screenshot endpoint, validates the PNG response, and retains at most 1.5 MB in the tool output's presentation metadata. The action's model-facing text remains unchanged, so screenshots do not consume model context or alter the tool workflow. The metadata is included in the durable tool-result event and is available when the Host recomputes the tool result view during history replay.

The client registers a `browser` result view in the provider-neutral Tool presentation vocabulary. `ui-tool` maps that view to a keyed row for all five camofox tools and opens a bounded `BrowserBlock` panel when a capture is present. The panel renders a data URL containing only host-validated `image/png` bytes, uses an internally scrolling viewport, and is reused by the details renderer. A capture failure is optional presentation loss: the browser action and its text result still settle normally.

## Alternatives considered

**Embed the live page in an iframe.** Rejected because it would require an authenticated page proxy or stream, would expose browser state to a second request surface, and would not replay from the session log.

**Put the screenshot in the model-facing result content.** Rejected because the user requested visual client feedback, not extra model context; durable presentation metadata preserves the distinction.

**Create a separate global browser window.** Rejected because the Web client must work for LAN sessions and a browser window would escape the chat layout and Host authorization model.

## Consequences

The browser row provides visual follow-along after each successful operation while preserving text-only model behavior and session replay. A large, malformed, unsupported, or unavailable screenshot cannot block browsing. The panel is a captured view rather than live control; interactions continue through the model-facing camofox tools.

## Testing

Camofox tool tests cover screenshot capture, PNG metadata, snapshot query inclusion, and action behavior when optional capture fails. UI-tool integration coverage verifies keyed browser-row dispatch, automatic panel opening, and the screenshot data URL. Typechecking covers the provider-neutral presentation union, UI primitive, camofox package, and tool renderer.
