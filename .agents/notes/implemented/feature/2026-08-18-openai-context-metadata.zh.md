# Agent Note: OpenAI 兼容上下文元数据动态解析

Status: implemented

[English](2026-08-18-openai-context-metadata.md) | 中文

## Problem

pi-ai 适配器只从配置或已安装 catalog 一次性解析模型上下文容量。OpenAI 标准模型列表经常不公布容量，而本地 OpenAI 兼容服务器会使用 `max_model_len` 或 `num_ctx` 等不同别名。因此，通用回退值可能让压缩太晚发生，或让本地部署的上下文计量不准确。

## Decision

显式配置了 `baseURL` 的 OpenAI 兼容路由在精确模型解析时，以及可配置的 `contextMetadataRefreshMs` 间隔到期后，从 `/models` 端点刷新上下文元数据，默认间隔为五分钟。第一次解析承担路由的启动发现；并发解析共享同一次进行中的探测。适配器接受标准的 `context_window` 与 `context_length` 字段，也接受常见本地别名：`max_context_length`、`max_model_len`、`max_model_length`、`num_ctx`、`n_ctx`、`context_size`、`max_seq_len` 和 `max_sequence_length`。

元数据优先级是显式模型 `contextWindow`、端点刷新值、已安装 catalog 容量，最后是 `defaultContextWindow`。如果成功探测却没有可用容量，则保留后面的层级。如果探测失败，则保留上一次成功的路由值，再使用后面的层级；适配器发出警告，但不会让本来有效的模型请求失败。精确模型元数据、请求上下文计量、压缩压力与提供方溢出分类使用同一个有效容量。

settings 文档仍负责路由服务的模型 id 列表。刷新只改变容量元数据，不会增加、删除或静默启用模型。将刷新间隔设为零是每次精确模型解析都探测的显式选择。

## Alternatives considered

**永远保留一个配置或 catalog 容量。** 拒绝，因为本地服务器可能以小于模型 catalog 容量的运行时上下文启动；如果端点已经公布了值，用户不应必须手动修正它。

**不缓存而在每个请求前探测。** 拒绝，因为 `/models` 是路由元数据，不是请求数据；每请求网络流量会增加延迟，并让临时元数据故障成为每次调用的一部分。

**增加独立的 vLLM、Ollama 和 LM Studio 提供方。** 拒绝，因为这些部署已经使用 OpenAI 兼容路由，适配器可以消费它们的元数据扩展而不绑定厂商专用端点。完全不公布容量的服务器仍使用显式配置回退。

**把探测失败视为模型硬失败。** 拒绝，因为上下文发现是辅助信息；保留上一次已知值或配置容量，可以让模型请求与压缩策略在本地服务器恢复期间继续运行。

## Consequences

如果 `/models` 响应包含被识别的字段，本地部署可以自动报告其有效上下文。缓存按路由和端点隔离；配置变化创建新的适配器 profile 快照，之前的请求仍使用自己捕获的快照。标准 OpenAI API 仍然受支持：只有模型 id 的列表会回退到 catalog 或配置容量。运行时上下文发生变化的服务器会在下一次 TTL 刷新时被观察到，而不是立即反映。

## Testing

pi-ai 发现测试覆盖本地容量别名。适配器测试覆盖刷新的上下文元数据、共享路由缓存和显式容量绕过探测。包级类型检查与 lint 覆盖新的配置和刷新路径。
