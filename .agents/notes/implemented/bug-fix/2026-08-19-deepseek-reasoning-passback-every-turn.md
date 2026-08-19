# Agent Note: DeepSeek reasoning passback on every reasoned turn

Status: implemented

English | [中文](2026-08-19-deepseek-reasoning-passback-every-turn.zh.md)

## Problem

`dsh-llm-deepseek` replayed `reasoning_content` only on assistant turns that also carried tool calls. DeepSeek requires the field on those thinking-mode turns and ignores it elsewhere, but this adapter also serves OpenAI-compatible endpoints that may recover an upstream thinking signature by hashing replayed reasoning text. Omitting a plain answer's reasoning could therefore make the reconstructed conversation diverge.

## Decision

`serializeAssistant` emits `reasoning_content` for every assistant turn whose content carried reasoning, independent of tool calls. An absent reasoning block still emits no field, so non-thinking turns remain unchanged.

The replayed text is byte-exact with the provider stream: the translator accumulates one response's reasoning channel into one reasoning block, and serialization joins that block without changing it.

## Alternatives considered

- A configuration switch would let a deployment trade tokens for compatibility, but a wrong setting would silently make a session unreconstructable.
- Inferring the behavior from `baseURL` is unreliable because a host does not reveal whether a deployment forwards to another vendor.
- Persisting a separate signature is not possible because the DeepSeek chat-completions protocol exposes no signature field.

## Consequences

Every reasoned tool-call-free turn now contributes its reasoning text to later requests. The text is stable at its position, so later assembled prefixes remain deterministic and cache reuse can continue after the unchanged prefix.

`WireAssistantMessage.reasoning_content` documents both endpoint behaviors, and the package README describes the passback and token implications.

## Testing

`tests/serialize.spec.ts` covers reasoning with and without tool calls, reasoning-only turns, and turns without reasoning. The latter continue to omit `reasoning_content`.
