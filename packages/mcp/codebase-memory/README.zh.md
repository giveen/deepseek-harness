# @deepseek-ai/dsh-codebase-memory

[English](README.md) | 中文

这是 [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 的内置集成。该包通过 harness 现有的 MCP 客户端桥接启动上游原生 MCP 服务器，将发现的工具提供给模型，并为 Web 面板启动上游图形界面。

## 安装与启动

共享的 `dsh-base` bundle 包含此包以及固定版本的 `codebase-memory-mcp@0.10.8` 运行时依赖。安装 bundle 时会运行上游 npm postinstall，下载或复用受平台验证的原生运行时。有效的既有运行时会被复用；通过包管理器更新时由上游安装器负责替换。harness 不会在会话运行期间下载、替换或更新可执行文件。

内置组合会使用已安装包的 wrapper 启动服务器，并将当前项目目录作为工作目录。可选图形界面监听 `127.0.0.1:9749`；Web bundle 通过 harness 反向代理它，因此局域网客户端不需要直接访问主机的 loopback 地址。

如果原生运行时不可用，MCP 客户端会进入可恢复的重连状态，harness 的其余部分仍会启动。模型仍会收到指导文本，但只有发现成功后才会公布 codebase-memory 工具。

## Web 面板

Web 会话视图新增 **Codebase Memory** 标签，与 Chat、Trajectory、Files 和 Commits 并列。它通过 `/codebase-memory/` 嵌入上游图形界面，保留上游的项目、图、统计和控制标签。harness 代理会重写上游界面的绝对资源和 API 路径，避免与 harness 的 `/api` 路由冲突。

该面板与 harness 同源，并限制 iframe 仅使用脚本和同源访问。代理只移除会拒绝嵌入路由的上游 `X-Frame-Options` 和 CSP `frame-ancestors` 指令，同时保留其余响应策略。如果原生界面不可用，面板会显示上游的失败状态，而 Chat、Trajectory、Files 和 Commits 仍可使用。

## 配置

base 组合使用以下默认值：

| 键 | 默认值 | 说明 |
|---|---|---|
| `cwd` | 当前进程目录 | MCP 服务器的工作目录 |
| `ui` | `true` | 启动上游图形界面 |
| `toolCallTimeoutMs` | `60000` | 单次发现工具调用的超时 |
| `env` | `{}` | 传递给子进程的显式环境增量 |

如需覆盖组合，请在 profile 的 `cordis.patch.yml` 中修改 `codebase-memory` 行。图形界面端口是上游协议常量 `9749`，不能独立于 Web 代理配置。

## 上游维护

上游包采用 MIT 许可证，并固定在 bundle 依赖图中。升级时请修改依赖版本，运行 workspace 安装与构建检查，并审阅上游 release notes。运行中的 harness 不包含自更新器，也不会后台检查版本。

## 构建

```sh
pnpm --filter @deepseek-ai/dsh-codebase-memory exec tsc -b
```

## 模型体验

### 发现的 codebase-memory 工具

#### 模型看到的内容

每个发现的上游工具都会以稳定的 harness 名称出现，例如 `mcp__codebase-memory__search_code`，并带有上游描述和输入 schema。提示词指导模型在大范围遍历文件前，先使用架构、项目列表、结构搜索、语义搜索、代码搜索、调用追踪、影响分析和索引覆盖率操作缩小范围，然后在编辑前使用普通文件工具核对准确的源代码行。

#### Token 影响

MCP 服务器可用时，发现的 schema 会包含在模型请求中。结构化结果用于缩小后续文件读取范围，减少打开无关文件的 token；大型图结果仍会占用上下文，因此应限制查询范围。

#### KV Cache 影响

只要发现的工具列表不变，codebase-memory 的提示指导和稳定工具 schema 就保持前缀稳定。项目名、查询和图结果会随任务变化，并追加在稳定前缀之后。

这是一种只在本地运行的代码智能。它用于缩小搜索范围，不代表可以作出未经证实的结论：空结果或过期图数据必须结合查询范围和索引新鲜度进行核对。除非用户明确要求，不要提交图数据或生成的 artifact。

## 已知限制与后续工作

- 原生图形界面固定使用 loopback 端口 `9749`；修改它需要协调上游和 Web 代理。
- 图数据是本地证据来源，不取代准确的文件读取、测试或仓库检查。
- 上游 MCP 的 Resources 和 Prompts 尚未桥接；当前支持的 MCP 能力是发现的工具。
