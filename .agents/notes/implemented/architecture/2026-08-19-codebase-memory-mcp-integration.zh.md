# Agent Note: 内置 codebase-memory MCP 集成

Status: implemented

[English](2026-08-19-codebase-memory-mcp-integration.md) | 中文

## Problem

Harness 需要本地结构化代码智能，让模型在大范围探索文件前先缩小范围，同时不能引入第二套 MCP 生命周期、云端依赖或未认证的局域网监听器。Web GUI 还需要在现有 Chat、Trajectory、Files 和 Commits 视图旁边显示上游图形界面。

## Decision

共享 bundle 拥有 `@deepseek-ai/dsh-codebase-memory`，该包依赖固定版本且采用 MIT 许可的 `codebase-memory-mcp` npm 包。上游包的 postinstall 负责校验原生运行时，并由包管理器负责更新。运行时通过现有 `dsh-mcp-client` stdio 桥接启动已安装的 `bin.js` wrapper，使用当前项目目录作为 `cwd`，并以稳定的 `mcp__codebase-memory__*` 命名空间发布发现的工具。启动保持可恢复：二进制文件或 MCP 握手不可用时进入桥接器的重连行为，不会阻止 harness 其余部分加载。

上游图形界面在 loopback 端口 `9749` 运行。Web bundle 将 `/codebase-memory/` 代理到该端点，并把上游界面的绝对 `/api`、`/rpc` 和 `/assets` 路径重写到代理前缀下。会话视图通过同源路由在 Chat、Trajectory、Files 和 Commits 旁边嵌入该界面，同时原生监听器仍只绑定 loopback。

面向模型的提示词要求在大范围探索文件前先使用架构、结构搜索、语义搜索、代码搜索、调用追踪、影响分析和索引覆盖率操作。结果用于缩小候选范围；编辑前仍必须用普通文件读取核对准确的源代码行，空结果也不能在未检查范围和索引新鲜度时证明不存在。

## Consequences

- 安装共享 bundle 时会安装或复用上游平台运行时，并允许包管理器升级，不需要运行中的 harness 自更新。
- 一个由 Host 拥有的 MCP 桥接器向模型提供上游工具，并在插件释放时统一移除这些工具。
- 局域网浏览器可以通过 harness 来源访问图形界面，不需要直接访问 `9749`；原生界面不可用时，代理会返回明确的不可用响应。
- Codebase Memory 标签依赖上游界面；界面不可用时，Chat、Trajectory、Files 和 Commits 仍可独立使用。
- 图数据是本地证据来源，不取代准确的文件读取、测试或仓库检查。除非用户明确要求，不提交图数据 artifact。

## Alternatives considered

**为每个 agent 启动一个服务器。** 否决，因为这会重复原生进程、UI 监听器和图协调；由一个 Host 组合统一拥有桥接。

**让端口 `9749` 监听所有网卡。** 否决，因为这会增加未认证的原生监听器。Web 服务器负责共享传输，原生 UI 保持 loopback-only。

**在客户端实现第二套图形界面。** 否决，因为这会分叉上游 UI 行为并重复协议。面板通过同源代理嵌入维护中的上游界面。

**在 harness 启动时下载或更新原生二进制。** 否决，因为普通启动会变成下载器，并可能与活动会话竞争。更新仍由包管理器和 postinstall 负责。
