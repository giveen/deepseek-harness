# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它，因此原生能力消费者不会保留已经断线的判断。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部：`/api` Host fence 与 WebSocket upgrade 会直接使用它，其他客户端插件则消费派生的 `ctx.connection.isLoopback` 状态。node 半侧的 `/api` 路由让宿主原生操作（`host.pickDirectory`、`host.openPath` 与 `settings.openDocument`）及 agent（智能体） preset 创作（`agentPreset.read`/`copy`/`openDocument`/`remove`）仍只限回环：这些方法会作用于宿主桌面或改变部署可运行的名单。完整配置面——`settings.describe`/`update`/`replace`/`mutate`、`credentials.describe`/`set`/`unset` 与 `llm.discoverModels`——遵循已声明的 `trustedHosts` 策略，因此受信任的 LAN authority 可以像回环页面一样查看和管理相同的提供方、设置与凭据。API 合约仍保证机密值只写入不读出，模型发现也会继续校验调用方草拟的端点。`agentPreset.list` 与 `agentPreset.select` 保持普通可达：名单只携带 id 与信任级别，而选择一个 preset 并不比 `session.create` 自带的 `agentPreset` 多给任何能力，何况默认 preset 本就带着 bash。`trustedHosts` 是 DNS rebinding 栅栏而不是认证；需要用户认证的部署必须在 Web 前放置经过认证的代理。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

## HTTP LAN 浏览器兼容性

浏览器载体使用 `crypto.getRandomValues()` 而不是 `crypto.randomUUID()` 生成 RPC 关联 id。后者在普通 HTTP LAN origin 上不可用，前者在此场景可用；因此无需 HTTPS，`http://<lan-address>:<port>` 仍可执行会话列表、就绪握手和其他 unary 调用。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：connection 插件从全接口 Web 服务器绑定推导非内部 LAN IPv4 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。受信任的 authority 可以使用完整的 settings／credential 配置面，包括脱敏读取和写入；宿主原生操作与 preset 创作仍只限回环。`trustedHosts` 是可达性策略而不是认证；需要用户认证的部署必须在 Web 前放置经过认证的代理。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
