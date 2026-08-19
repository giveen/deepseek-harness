# Agent Note: Dynamic OpenAI-compatible context metadata

Status: implemented

English | [中文](2026-08-18-openai-context-metadata.zh.md)

## Problem

The pi-ai adapter resolved a model's context capacity once from configuration or its installed catalog. OpenAI's standard model listing often omits capacity, and local OpenAI-compatible servers expose different aliases such as `max_model_len` or `num_ctx`. A generic fallback could therefore make compaction run too late or report an inaccurate context meter for a local deployment.

## Decision

OpenAI-compatible routes with an explicitly configured `baseURL` refresh context metadata from their `/models` endpoint when an exact model is resolved and after a configurable `contextMetadataRefreshMs` interval, defaulting to five minutes. The first lookup supplies startup discovery for a route; concurrent lookups share one in-flight probe. The adapter accepts standard `context_window` and `context_length` fields plus common local aliases: `max_context_length`, `max_model_len`, `max_model_length`, `num_ctx`, `n_ctx`, `context_size`, `max_seq_len`, and `max_sequence_length`.

Metadata precedence is explicit model `contextWindow`, refreshed endpoint metadata, installed catalog capacity, then `defaultContextWindow`. A successful probe that has no usable capacity preserves the lower layers. A failed probe preserves the last successful route value and then the lower layers; it emits a warning but does not fail an otherwise valid model request. The same effective capacity is used by exact-model metadata, request context accounting, compaction pressure, and provider overflow classification.

The settings document continues to own the served model-id list. Refresh only changes capacity metadata and never adds, removes, or silently activates a model. A zero refresh interval is an explicit opt-in to probe every exact-model resolution.

## Alternatives considered

**Keep one configured or catalog capacity forever.** Rejected because local servers can be started with a smaller runtime context than the model's catalog capacity, and users should not have to manually correct a value that the endpoint discloses.

**Probe every request without caching.** Rejected because `/models` is route metadata, not request data; per-request network traffic would add latency and make a temporary metadata outage part of every call.

**Add separate vLLM, Ollama, and LM Studio providers.** Rejected because these deployments already speak the OpenAI-compatible route and their metadata extensions can be consumed without coupling the adapter to vendor-specific endpoints. Servers that expose no capacity still retain the explicit configuration fallback.

**Treat a failed probe as a hard model failure.** Rejected because context discovery is advisory and a last known or configured capacity lets the model request and compaction policy continue while the local server recovers.

## Consequences

Local deployments can report their effective context automatically when their `/models` response includes a recognized field. The cache is route-and-endpoint scoped, and configuration changes create a new adapter profile snapshot while prior requests keep their captured snapshot. The standard OpenAI API remains supported: listings with only model ids simply fall through to catalog or configured capacity. A server whose configured runtime context changes is observed on the next TTL refresh, not instantaneously.

## Testing

The pi-ai discovery tests cover local capacity aliases. Adapter tests cover refreshed context metadata, shared route caching, and explicit capacity bypassing the probe. Package typechecking and linting cover the new configuration and refresh path.
