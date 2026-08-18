# @deepseek-ai/dsh-tool-camofox

[English](README.md) | 中文

由 [camofox-browser](https://github.com/jo-inc/camofox-browser) 支持的 DeepSeek Harness agent 浏览器自动化工具。每个 agent 使用隔离的 camofox 用户会话；浏览器调用必须有发起中的 agent，并将工具取消信号转发给服务端。

## 安装与启动

本包将 `@askjo/camofox-browser` 作为必需的运行时依赖。安装钩子会获取 Camoufox 浏览器二进制文件（首次安装约 300 MB）。dsh 包增加了幂等的安装后检查：已有缓存会直接复用；已安装的 camofox-browser 或 camoufox-js 版本发生变化时，会先把新二进制下载到暂存目录，成功后才替换现有缓存。刷新失败会保留旧缓存，并只发出警告，不会使安装失败。内置 dsh 组合会自动在 `127.0.0.1:9377` 启动服务，等待 `/health` 就绪，并在 dsh 进程结束时停止服务。只有在通过 `CAMOUFOX_EXECUTABLE` 提供兼容的外部 Camoufox 可执行文件时，才应设置 `CAMOFOX_SKIP_DOWNLOAD=1`。

该服务不会与无关进程共享：dsh 负责管理这个回环进程，工具连接到同一个标准的 `http://127.0.0.1:9377` 地址。

## 前置条件

- [camofox-browser](https://github.com/jo-inc/camofox-browser) 支持的平台及其 Camoufox 二进制文件

## 工具

| 工具 | 描述 |
|---|---|
| `browser_navigate` | 打开 HTTP(S) 标签页并返回 `tabId`。 |
| `browser_snapshot` | 获取最新的可访问性树和页面专属元素引用。 |
| `browser_click` | 使用当前引用或 CSS 选择器点击一个元素。 |
| `browser_type` | 使用当前快照引用在输入框中输入文本。 |
| `browser_scroll` | 向上或向下滚动页面。 |

使用引用前先调用 `browser_snapshot`。导航或改变页面的操作后引用可能失效；下一次使用引用前要重新获取快照。滚动后也要重新获取快照，以检查新显示的元素。`browser_click` 必须在 `ref` 和 `selector` 中二选一，不能同时提供；`browser_type` 只接受引用。

## 集成

在 profile 的 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: tool-camofox
      name: '@deepseek-ai/dsh-tool-camofox'
      config:
        autoStart: true
        serverUrl: 'http://127.0.0.1:9377'
```

## 配置

| 配置键 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `serverUrl` | `string` | `http://127.0.0.1:9377` | 不含嵌入凭据的 HTTP(S) camofox-browser 服务地址。 |
| `autoStart` | `boolean` | `true` | 启动并管理内置服务；要求使用 HTTP 回环地址。 |
| `timeoutMs` | `number` | `30000` | 每次浏览器工具调用的协作式超时预算，不能超过 `2147483647`。 |

## 运行行为

启用 `autoStart: true` 时，如果内置服务无法启动，或在 30 秒内没有对 `/health` 作出响应，插件激活会失败。插件负责管理该进程，并在卸载时等待它停止。插件会在把结果返回给模型前验证 camofox JSON 响应；格式错误的响应和 HTTP 错误都会被拒绝。它使用调用 agent 的会话 id 作为 `userId`，并以 `sessionKey: dsh-browser` 将该 agent 的标签页分组；不同 agent 不共享浏览器 cookie。当前客户端面向回环地址上的 camofox 服务；由于插件尚未携带访问密钥凭据，不要把服务暴露到回环地址之外。二进制刷新失败不会使安装失败，但启动时仍会通过受管服务的就绪检查报告缺失或不可用的浏览器。

模型可见的工具不暴露浏览器凭据、访问密钥或超时参数。`timeoutMs` 是部署策略，会附加到工具定义；工具会把取消信号转发到每个请求。

## 构建

```sh
pnpm --filter @deepseek-ai/dsh-tool-camofox exec tsc -b
```

## Model Experience

### 浏览器交互

#### What the model sees

模型会收到五个工具：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type` 和 `browser_scroll`。导航结果提供 `tabId`；快照提供页面专属的 `e5` 等引用；点击接受一个当前引用或 CSS 选择器；输入接受当前引用；滚动返回方向和距离。提示会要求模型在使用引用前，以及导航、改变页面的操作或滚动后重新获取快照。

#### Token effect

可访问性快照比原始页面 HTML 小得多，但每个快照仍会以模型可见文本进入会话。模型只应在需要当前引用或新显示内容时获取快照，避免重复未改变的快照。

#### KV Cache effect

工具 schema 和操作指导在调用之间保持稳定，而 tab id、URL、快照、引用和操作结果会按 session 变化。因此重复的浏览器操作会复用稳定的工具前缀，但会把变化的页面状态追加到请求上下文中。
