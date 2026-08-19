# Agent Note: Per-model image capability setting

Status: implemented

English | [中文](2026-08-19-per-model-image-capability.zh.md)

## Problem

OpenAI-compatible local servers can serve vision models without advertising their multimodal capability through the model directory endpoint. The adapter correctly refuses image messages for models that do not declare `image`, but the Models page gave users no way to make a deliberate per-model declaration.

## Decision

The model editors expose a per-row **Supports image input** checkbox inside each model's advanced settings. Enabling it stores `input: [text, image]`; disabling it stores `input: [text]`. The setting is available in the pi-ai model editor used by hand-declared and local OpenAI-compatible routes, and the existing adapter capability gate remains unchanged. The direct DeepSeek editor does not expose it because that adapter remains text-only.

The control writes an explicit text-only list when disabled rather than deleting the field. This keeps a model-level choice authoritative when a route later receives a `[text, image]` fallback, while preserving the existing model-resolution precedence and durable settings format.

## Consequences

- A local llama.cpp-compatible vision model can be enabled from Settings → Models without hand-editing `settings.yaml`.
- The declaration is scoped to one pi-ai model, so text-only and vision models can share a provider route safely.
- The endpoint is not probed for truth; an incorrect declaration can still be rejected by the provider.
- Existing models remain text-only unless their stored `input` already includes `image` or the user enables the control.

## Alternatives considered

**Infer vision support from `mmproj`, model names, or local server flags.** Rejected because the Harness does not own the server process and cannot reliably identify the model selected by an OpenAI-compatible endpoint.

**Enable image input for every model on a local route.** Rejected because one route can serve mixed text and vision models, and over-claiming causes a durable image request to reach an endpoint that cannot process it.

**Require direct `settings.yaml` editing.** Rejected because the capability is model-facing behavior and the settings UI already owns the model catalog; hiding the field made the supported adapter contract undiscoverable.
