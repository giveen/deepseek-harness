# Agent Note: Camofox tool boundaries and browser guidance

Status: implemented

[English](2026-08-18-camofox-tool-boundaries.md) | 中文

## Problem

camofox 工具此前会把模型参数直接转发给外部浏览器服务，未验证响应就进行类型断言，所有请求使用共享的硬编码浏览器身份，也没有转发取消信号；同时，`browser_click` 虽然接受 CSS 选择器，提示却错误地禁止选择器。格式错误的响应可能变成无效的模型结果，不同 agent 也可能共享浏览器 cookie 和标签页。

## Decision

五个工具的表面保持为 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type` 和 `browser_scroll`。插件现在：

- 要求调用具有发起中的 agent，并使用该 agent 的 session id 作为 camofox `userId`，使用稳定的 `dsh-browser` 作为标签页分组的 `sessionKey`；
- 将 `exec.signal` 转发到每个 HTTP 请求，并为每个工具附加一个经过验证的协作式 `timeoutMs` 预算；
- 在访问网络前验证 HTTP(S) 服务地址、标签页路径、浏览器 URL、元素引用、点击目标的互斥性和滚动距离；
- 验证必需的 wire 字段，并且只投影每个工具输出 schema 声明的字段；格式错误的 JSON 和 HTTP 错误都会被拒绝；
- 描述真实的交互顺序：使用引用前先获取快照，导航或改变页面后刷新引用，滚动后获取快照，并在点击时二选一提供目标。

客户端不会暴露 camofox 访问凭据，也不会添加模型可见的超时参数。当前客户端面向回环地址上的 camofox 服务；客户端不携带访问密钥凭据，因此暴露到回环地址之外的部署继续推迟。

## Alternatives considered

**继续使用共享的 `dsh-agent` 浏览器身份。** 否决，因为 camofox 的 `userId` 是 cookie 和存储的隔离键；共享它会让无关的 agent session 观察和修改同一浏览器状态。

**信任 `fetch().json()` 的类型化响应。** 否决，因为 camofox 是外部进程，其响应属于 wire 边界。插件会检查必需字段，并在工具输出验证前丢弃额外的协议字段。

**从 `browser_click` 中移除 CSS 选择器。** 否决，因为 camofox 同时支持可访问性引用和 CSS 选择器。工具保留两种选择，并明确要求二选一，而不是发布错误限制。

**使用本地超时竞争并放弃请求。** 否决，因为被放弃的外部工作可能在工具流水线结束后继续运行。工具使用 harness signal 和协作式超时契约，让底层 fetch 能够观察取消。

## Consequences

浏览器状态按存活的 agent session 隔离，同一 agent 的标签页共享一个 camofox session 分组。没有 agent 的直接调用会安全失败，而不会退回到共享浏览器身份。模型会收到关于引用过期和 CSS 定位的可执行指导；服务端行为格式错误时会得到结构化工具失败，而不是无效的成功值。

启用 `autoStart` 时，内置服务进程由插件负责并在卸载时停止；禁用时，外部服务仍负责自己的生命周期。服务仍负责认证、超出工具 HTTP(S) 检查范围的 URL 策略以及自身的处理器限制。插件没有新增关闭标签页或销毁会话的工具；在拥有者和持久化清理策略明确之前，这些能力继续推迟。安装和启动决策记录在[内置服务说明](../feature/2026-08-18-camofox-bundled-server.md)中。

## Testing

`packages/web/camofox/tests/tools.spec.ts` 通过真实工具注册表覆盖注册与提示、无 agent 拒绝、身份和 signal 转发、GET 查询身份、响应投影、CSS/引用验证、点击目标互斥、滚动验证、wire 响应错误和 HTTP 失败。包级 typecheck 覆盖外部协议客户端和五个工具的输出 schema。
