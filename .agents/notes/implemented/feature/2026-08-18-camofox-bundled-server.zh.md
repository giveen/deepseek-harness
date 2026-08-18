# Agent Note: Camofox bundled server lifecycle

Status: implemented

[English](2026-08-18-camofox-bundled-server.md) | 中文

## Problem

camofox 工具包此前要求用户独立安装并运行浏览器服务，因此统一安装的 dsh 可能提供一个没有可达后端的浏览器工具能力，每个部署也都必须手动重复端口配置。

## Decision

`@deepseek-ai/dsh-tool-camofox` 将 `@askjo/camofox-browser` 声明为运行时依赖，因此统一包安装会携带该服务及其 Camoufox 二进制安装钩子。包自身的安装后脚本会在缓存旁记录已安装的 `@askjo/camofox-browser` 和 `camoufox-js` 版本：版本匹配时复用缓存；版本变化时先下载到暂存目录，成功后才原子替换缓存。刷新失败会保留旧缓存，并带警告成功退出。基础 bundle 配置一个 `autoStart: true` 的 `tool-camofox` 行，并使用 `http://127.0.0.1:9377`。

启用后，插件通过 `ctx.subprocess` 启动该包的服务入口，传入 `CAMOFOX_PORT=9377` 和 `CAMOFOX_BIND_HOST=127.0.0.1`，在激活完成前轮询 `/health`，并通过同一个 subprocess 服务管理进程清理。服务退出或在 30 秒内没有就绪时，启动会明确失败。受管理的端点必须是回环主机上的 HTTP 地址；由外部进程管理的部署可以设置 `autoStart: false`，继续使用经过验证的 HTTP(S) 客户端配置。

五个模型可见工具及其协议表面保持不变。服务进程使用收集模式处理输出，而不是继承 stdout 或 stderr，因此结构化日志不会破坏 ACP 或其他父进程协议流。

## Alternatives considered

**要求用户单独启动 camofox-browser。** 否决，因为安装和已发布的基础组合仍然不能建立可用的浏览器能力，每个启动器还必须提供独立的就绪检查和端口说明。

**在工具包内使用 `node:child_process` 启动服务。** 否决，因为进程所有权、取消、进程树终止和清理已经属于 `ctx.subprocess` 能力接缝。

**第一次浏览器调用时延迟启动服务。** 否决，因为工具注册会声明一个只有模型请求发生时才暴露就绪失败的能力；对于自包含要求，激活是最早可以解析的时点。

**让受管理服务绑定到回环之外，或允许任意 URL 路径。** 否决，因为客户端没有访问密钥凭据，服务地址是主机连接而不是 HTTP 反向代理路径；统一默认值保持为一个明确的回环端口。

## Consequences

首次普通安装可能下载约 300 MB 的 Camoufox 二进制文件。重复安装会复用与上游包版本绑定的缓存；依赖更新会通过暂存目录刷新，因此被阻止的更新不会破坏仍可工作的旧二进制文件。缺失缓存仍会变成可操作的启动失败，而不是看起来正常但不可用的浏览器工具。受管理进程与插件生命周期完全一致，并纳入 subprocess 服务的进程树清理。

有意使用独立监管服务或远程服务的 profile 可以通过 `autoStart: false` 放弃进程所有权；基础 profile 不使用这个退出路径。服务包自己的可选功能和凭据仍不属于这五个工具的表面。

## Testing

`packages/web/camofox/tests/tools.spec.ts` 验证标准启动环境、回环端点就绪门控以及由清理流程管理的模拟进程；现有 wire 测试继续覆盖未改变的五个工具。`packages/web/camofox/tests/binary-install.spec.ts` 验证缓存复用、版本触发的刷新，以及刷新失败后旧缓存的保留。包级 typecheck 和统一构建/安装检查覆盖新增的运行时依赖及 bundle 行。
