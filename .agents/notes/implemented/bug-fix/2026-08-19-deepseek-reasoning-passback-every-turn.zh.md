# Agent Note: DeepSeek reasoning passback on every reasoned turn

状态：已实现

[English](2026-08-19-deepseek-reasoning-passback-every-turn.md) | 中文

## Problem

`dsh-llm-deepseek` 只在同时携带工具调用的 assistant 轮次上回放 `reasoning_content`。DeepSeek 要求思考模式的这些轮次携带该字段，并会在其他轮次忽略它；但本适配器也服务于可能通过对回放推理文本取哈希来恢复上游思考签名的 OpenAI 兼容端点。因此，省略普通作答轮次的推理可能使重建出的对话产生分叉。

## Decision

`serializeAssistant` 对每个内容携带推理的 assistant 轮次都发出 `reasoning_content`，与是否有工具调用无关。没有推理块时仍不发送该字段，因此非思考轮次保持不变。

回放文本与提供方流完全一致：转换器会把一次响应的推理通道累积为一个推理块，序列化时拼接它不会改变内容。

## Alternatives considered

- 配置开关可以让部署在 token 和兼容性之间选择，但设置错误会静默地使会话无法重建。
- 根据 `baseURL` 推断行为不可靠，因为主机名无法说明部署是否会转发到其他厂商。
- 无法单独持久化签名，因为 DeepSeek chat-completions 协议没有暴露签名字段。

## Consequences

每个不带工具调用但含推理的轮次都会把推理文本带入后续请求。文本在原位置保持稳定，因此后续组装前缀仍是确定的，未改变的前缀之后可以继续复用缓存。

`WireAssistantMessage.reasoning_content` 记录了两种端点行为，包 README 说明了回传规则及其 token 影响。

## Testing

`tests/serialize.spec.ts` 覆盖带工具调用和不带工具调用的推理、纯推理轮次以及不含推理的轮次。最后一种仍不会发送 `reasoning_content`。
