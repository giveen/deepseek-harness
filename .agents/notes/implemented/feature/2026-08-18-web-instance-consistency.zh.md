# Agent Note：Web 实例一致性检查

Status: implemented

[English](2026-08-18-web-instance-consistency.md) | 中文

## 问题

Web 组合包可能在 LAN 上公告一个 URL，但 loopback 和 LAN 流量实际到达不同的 Harness 进程，网络命名空间、残留服务器或不同的启动环境都会造成这种情况。会话列表和运行中的 Agent 由单个 Host 进程所有，因此两个有效的 HTTP/WebSocket 连接仍可能显示不同会话；这不是浏览器 origin 分区造成的。

## 决策

`dsh web` 会在启动前取得独占的 `$DSH_HOME/web-host.lock`。如果已有进程持有锁，第二次调用会在挂载第二个 API 表面之前失败；记录的进程已经退出时会自动恢复锁。这会阻止两个正常的 Web 启动静默创建相互独立的会话存储。`host.describe` 还携带不透明的进程生命周期 `instanceId`。Web Loader 结算后，Web runtime 探测它公告的每个 LAN authority，并把响应中的实例 id 与本地 API 返回值比较。如果不一致，就记录包含该 authority 的警告，并说明该地址无法共享会话；探测失败则记录单独的可达性警告。探测是尽力而为的，并受可配置的 `lanInstanceProbeTimeoutMs` 限制。它不会合并进程、自动选择另一个端点，也不会放宽 API 信任栅栏。

现有会话列表仍由 Host 所有，且与 origin 无关。因此，由同一进程服务的 loopback 和 LAN URL 继续共享已附加会话、持久会话和实时事件流。浏览器载体使用 `crypto.getRandomValues()` 而不是仅限安全上下文的 `crypto.randomUUID()` 生成 RPC id，因此普通 HTTP LAN origin 也能完成列表请求与就绪握手。独立进程需要统一的部署和生命周期；它们不是受支持的实时会话共享机制。

## 受信任 LAN 配置

相同的 Host 信任策略现在覆盖 settings 与 credentials 配置面。已声明 LAN authority 可以调用 `settings.describe`/`update`/`replace`/`mutate`、`credentials.describe`/`set`/`unset` 与 `llm.discoverModels`，因此远程操作员可以查看和管理提供方目录及设置页面。宿主原生操作、设置文档打开和 preset 创作仍只限回环。这是明确的可达性授权而不是认证：把 Web 暴露到私有受信网络之外的部署必须在前面放置经过认证的代理。受信任 LAN 页面的浏览器 settings scope 使用 Host 文档，不再静默回退到进程内存储。

## 考虑过的替代方案

**按浏览器 origin 或本地存储划分会话。** 否决：目标是 Host 范围共享，而浏览器存储无法在 `127.0.0.1` 与 LAN 地址之间标识同一个 Host 进程。

**通过 Web 客户端合并不同进程。** 否决：运行中 Agent 所有权、提示路由、事件顺序和文件写入都需要协调服务；静默合并两个 Host 会产生重复执行和分叉日志的风险。

**把 LAN 探测失败当成启动失败。** 否决：服务器自己的网络命名空间可能无法访问该接口，而远程客户端仍然可以访问。警告可以指出部署问题，又不会阻止 loopback 启动。同一 home 的进程锁是独立机制：它表示确定的本地所有权，因此第二次正常 Web 启动必须失败。

## 影响

操作员会收到明确的锁失败或可执行的 LAN 警告，而不是没有解释的空会话列表。锁只记录带 owner-only 权限的进程 PID，实例 id 是不透明值，不携带文件系统路径或用户身份。启动时每个公告的 LAN IPv4 地址执行一次有界的本地请求；不会改变模型可见内容或持久会话数据。

## 测试

Host 响应 schema 让 `instanceId` 在 wire 上保持可选，因此仍向后兼容。锁测试覆盖活动所有者拒绝、已退出所有者恢复以及替换所有者保护。现有 API 与 Web 组合包测试覆盖未改变的传输和启动路径；载体测试在保留 `getRandomValues` 的同时移除 `crypto.randomUUID`，验证 HTTP LAN 兼容性。完整类型检查及针对 Web/API 的测试覆盖新响应字段、诊断和载体行为。
