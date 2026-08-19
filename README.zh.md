# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开源的 coding agent 运行时与 Web 工作区。它将模型提供方、工具、持久会话、权限、工作区和用户界面组合为一个可配置的应用。

一切都是插件。[Cordis](https://github.com/cordiverse/cordis) 提供组合模型：插件向同一个运行时贡献服务、事件、工具、提示词段、存储和可撤销 effect。你可以直接使用随附的 profile，替换提供方，添加工具，或从同一批包组合出更小的应用。

## 开发者预览

DeepSeek Harness 目前处于活跃的开发者预览阶段。不同版本之间可能改变功能、配置和磁盘格式。请通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 报告失败、令人困惑的行为和安装或使用上的阻碍。

## 提供的能力

| 界面 | 用途 |
|---|---|
| **Web 工作区** | 在浏览器中运行 coding session，选择工作区，附加图片，查看对话，浏览工作区文件，查看可展开的 Git 提交历史，以及管理提供方和应用设置。 |
| **Agent 工具** | 读取和编辑文件、搜索工作区、运行 Bash 或 PowerShell、使用持久终端、请求审批、创建计划、安排任务、委派 subagent，以及运行有界 workflow。 |
| **Web 访问** | 搜索和抓取 Web，或使用受管的 Camofox 浏览器工具进行导航、获取可访问性快照、点击、输入和滚动。成功的浏览器操作可以在聊天中显示有界截图。 |
| **模型** | 使用原生 DeepSeek 适配器、已安装的提供方目录，或自定义的 OpenAI 兼容及其他受支持端点。模型的输入能力（包括图片输入）按模型声明。 |
| **会话** | 以权威事件日志支持回放、持久标题、搜索、导出、遥测、fork、归档和恢复。SQLite 查询和存储后端提供有界读取、全文搜索、完整性检查、在线备份和标记-清扫式保留。 |
| **自动化** | 运行一次性 headless 任务，通过 ACP 或 JSON-RPC 暴露 agent，或从其他程序调用随附的 Python SDK。 |
| **扩展** | 添加 Cordis 插件和 profile bundle，无需修改 agent loop。包文档与[能力 seam 文档](docs/capability-seams.md)介绍受支持的扩展点。 |

## 运行

### 使用已发布的 CLI

安装 Node.js 22.19+ 或 24+，然后通过 `npx` 运行 Web profile：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI 并打印访问地址。默认地址为 `http://127.0.0.1:3080`。Web profile 首次使用时会初始化自己的 profile 目录，并将机器本地设置、凭据、profile 和会话数据存放在当前 Harness home 下。

### 从源码运行

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack enable
pnpm install
pnpm run build:official
pnpm dsh web
```

新检出以及需要更新构建包或前端时，都应运行可复现官方 profile 构建的 `pnpm run build:official`。`pnpm run build` 会保留显式提供的 `DSH_CLIENT_*` 值，用于自定义 client 产物。完整构建会记录选定的公开 client 环境和生成的 Web、动态 client 产物摘要；release 打包会拒绝缺少或过期的记录。源码运行使用检出中的 TypeScript 入口；已安装的 CLI 使用已发布的构建产物。启动命令所在目录是默认工作区根目录。

### 配置模型

在 Web UI 中打开**设置 → 模型**并保存提供方凭据。随附配置支持 DeepSeek 提供方、OpenAI 和 Anthropic 等目录提供方，以及用于自托管或 OpenAI 兼容网关的自定义提供方。自定义提供方需要基础 URL、协议、凭据和至少一个模型。

无人值守运行可以将凭据放在环境变量或根目录下被 Git 忽略的 `.env` 中：

```sh
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

[模型配置指南](docs/user/guide/providers.md)介绍提供方目录、自定义路由、模型选择、图片输入声明和提供方专用认证。不要提交凭据。

### 选择工作区并开始会话

1. 打开 Web UI，并进入**设置 → 模型**。
2. 添加或选择要让 agent 使用的项目目录。
3. 创建会话，选择模型和权限 preset，然后发送任务。
4. 使用**文件**查看工作区树，或使用**提交**浏览可展开的 Git 提交消息。
5. 只有所选模型声明支持图片输入时，才能附加图片；图片和提示词会渲染在对话中，并作为持久会话内容保留。

默认的 `workspace-write` 权限 preset 允许修改工作区和临时目录；审批与沙箱插件会守护有影响的操作。完整运行流程请查看 [Web UI 指南](docs/user/guide/index.md) 和 [CLI 参考](apps/cli/reference/README.md)。

### 在局域网提供 Web UI

要让可信网络中的另一台设备访问 Web UI：

```sh
dsh web --host 0.0.0.0 --port 3080
```

对于浏览器应当接受的具名主机或端口，使用 `--trusted-host <authority>`：

```sh
dsh web --host 0.0.0.0 --port 3080 --trusted-host workstation.example.test
```

随附组合会接受回环地址和机器公布的 LAN 地址。一个 Web 进程拥有实时会话存储，因此由同一进程提供的回环和 LAN URL 会看到相同的会话。使用另一个 Harness home 启动第二个 Web 进程不会合并会话；Web 启动器使用 home 锁，并会警告公布的实例不一致。

HTTP 面没有内置用户认证或 TLS。仅本机使用时绑定 `127.0.0.1`；局域网部署应放在可信网络和已认证的 TLS 反向代理之后。不要将未经认证的 `0.0.0.0` 监听器暴露到公共互联网。

## 使用 Camofox 进行浏览器自动化

Web profile 包含 `@deepseek-ai/dsh-tool-camofox`。安装时，其必需的 `@askjo/camofox-browser` 依赖会下载 Camoufox 浏览器二进制文件，首次安装约 300 MB。已有兼容浏览器缓存会复用；版本变化会以幂等方式刷新缓存；刷新失败会保留旧缓存并给出警告。

Web profile 启动时，dsh 会在 `http://127.0.0.1:9377` 拥有一个回环 Camofox 服务，等待其 `/health` 端点，然后在 dsh 进程退出时一并停止。浏览器工具包括 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type` 和 `browser_scroll`。使用元素 ref 前先获取最新快照；导航、改变页面的操作或滚动后也要重新获取快照。Web 客户端会在对应的工具行内显示最近一次成功的有界截图；截图属于展示元数据，不会加入模型上下文。

如果环境中已经提供兼容的 Camoufox 可执行文件，可以跳过二进制下载：

```sh
CAMOFOX_SKIP_DOWNLOAD=1
CAMOUFOX_EXECUTABLE=/absolute/path/to/camoufox
```

Camofox 默认只监听回环地址，也没有 access-key 认证。除非本地使用，否则不要将 `9377` 端口暴露出去。配置、限制和工具语义见 [Camofox 包 README](packages/web/camofox/README.md)。

## 其他入口模式

| 命令 | 用途 |
|---|---|
| `dsh web` | 启动浏览器 Web 工作区。 |
| `dsh --profile headless "run the tests"` | 创建一个全新的持久化会话，打印最终 assistant 回复并退出。 |
| `dsh --profile <name>` | 启动位于 `$DSH_HOME/profiles/<name>` 下的指定 profile。 |
| `dsh plugin --profile <name> add <package>` | 将插件安装到 profile，并激活其声明的 bundle 层。 |
| `pnpm run demo:acp` | 启动检入仓库的 ACP 自动化示例。 |
| `python examples/jsonrpc-agent/minimal.py ...` | 使用随附的 JSON-RPC runtime 运行 Python SDK 示例。 |

启动器 flag 必须写在 profile 参数之前。使用 `dsh --profile web --help` 或 `dsh web --help` 查看 Web flag，使用 `dsh --help` 查看启动器帮助。使用 `--dump-default-config` 或 `--dump-config` 可以在不启动 profile 的情况下查看配置。

[Headless 示例](examples/headless-agent/README.md)、[ACP 示例](examples/acp-agent/README.md)、[Python SDK 教程](docs/user/guide/python-sdk.md)和 [CLI 参考](apps/cli/reference/README.md)分别介绍各入口的可运行细节。

## 数据、隐私与恢复

会话从追加式事件日志派生。日志是模型历史、UI 回放、fork、导出、标题和查询投影的数据源；发送给模型的任何内容都能从持久会话事件重建。Web profile 默认使用 JSONL 保存会话 artifact，并使用内存 SQLite 查询索引。其他组合可以选择 SQLite 持久化和存储后端，为持久关系索引提供完整性诊断、在线备份、分页和有界标记-清扫式删除。

提供方凭据以凭据引用而不是返回值存储。本地凭据提供方将文档保存在 Harness home 中，不会把解析后的凭据写入模型环境。但工具仍以本地用户身份运行，因此文件系统权限和当前沙箱策略依然重要。只有在部署接受可能包含的数据时才启用遥测；显式启用的遥测可能包含消息文本、工具参数与结果以及工作区路径。

[持久化子系统参考](docs/subsystems/persistence.md)、[存储子系统参考](docs/subsystems/storage.md)、[测试策略](docs/testing.md)和 [CLI 行为参考](apps/cli/reference/README.md)负责详细的格式、生命周期、安全和恢复约定。

## 架构与定制

修改 `packages/` 前请阅读[架构指南](docs/architecture.md)。其中介绍 profile、bundle、session 与 agent loop、事件域、能力 seam，以及新行为应当挂载到文档化插件扩展点这一规则。

最常用的定制路径包括：

- 按照 [LLM 适配器指南](docs/cookbook/adding-an-llm-adapter.md)添加模型适配器。
- 按照[工具指南](docs/cookbook/adding-a-tool.md)添加面向模型的工具。
- 按照[会话节点指南](docs/cookbook/adding-a-conversation-node.md)添加浏览器对话界面。
- 按照[包指南](docs/cookbook/adding-a-package.md)添加包。
- 使用 `cordis.patch.yml` 修改 profile；所有配置字段见自动生成的[配置目录](docs/config-catalog.md)。
- 在 [packages/README.md](packages/README.md) 浏览包族，并查看自动生成的[模块图](docs/module-graph.md)。

一个能力只有在其 Service Definition、Provider 和 Consumer 三个角色一起设计时才完整。扩展插件依赖定义而不是具体提供方，因此可以通过组合交换本地和远程实现。

## 开发与验证

前置条件和源码构建布局见[开发指南](docs/development.md)。常用仓库命令如下：

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run doc-sync
pnpm run build:official
```

请运行覆盖改动范围的最小检查。`pnpm run doc-sync` 会验证 Markdown 链接和换行、双语配对、生成目录、源等价类型代码块以及文档预算。`pnpm run check:all` 运行完整的本地门禁集合。可用时，实机 API 测试使用 `DEEPSEEK_API_KEY`；没有该变量时会自行跳过。不要提交密钥或包含秘密的生成产物。

## 社区与支持

- 在 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提问和报告 bug。
- 使用 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题浏览或发布插件。
- 加入 [DeepSeek Harness Discord 社区](https://discord.gg/Ycq5dCaS4)。
- 提交改动前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；项目仍处于早期开发阶段，部分领域暂不一定接受外部 pull request。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
