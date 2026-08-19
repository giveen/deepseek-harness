# Agent Note: Web 就绪、官方品牌与 client 产物 profile

Status: implemented

[English](2026-08-19-upstream-web-startup-branding-artifact-profiles.md) | 中文

## Problem

Web 命令过去会在自身 runtime 激活后立即打印 URL，因此 supervisor 或浏览器收到 URL 时，兄弟 Loader 行仍可能失败。浏览器 shell 还直接拥有官方标记和字标，使部署无法通过 client 扩展模型替换品牌。最后，Vite 与动态加载的 client bundle 没有共同记录来证明当前产物由哪些公开构建值生成。

## Decision

Web runtime 会等待 Loader 结算后再打印 URL 或打开默认浏览器。`--no-open` 禁用该交接；SSH 启动会自动抑制它；启动器失败只产生警告，服务器继续运行。传给操作系统打开器的子进程环境会移除不需要的 URL 相关状态。

侧边栏和空白会话 Hero 的品牌位置是通用 slot。只有 `official` client 构建 profile 才由 `ui-brand-official` 填充这些位置，因此共享壳不再拥有部署专属的品牌 occupant。

根构建包装脚本为 Vite 和 tsdown 解析同一份精确的 `DSH_CLIENT_*` 环境。`build:official` 选择随附的官方 profile；每次完整构建都会记录公开值，并记录覆盖 Web 与动态 client 产物的确定性摘要。release 打包会校验记录存在、匹配官方 profile，且仍然匹配产物字节。

## Alternatives considered

否决从 CLI 或通用 HTTP 服务器打开浏览器，因为它们都不同时拥有操作系统分配的端口和完整 Loader 就绪点。否决等待终端确认，因为这会破坏受监督启动和桌面启动；`--no-open` 是明确的无人值守退出方式。否决把官方品牌保留在共享壳中，因为部署专属呈现应属于可替换的 client slot occupant。否决只记录 Vite 产物，因为动态插件 bundle 独立加载，必须共享公开构建值和完整性校验。

## Consequences

服务器专用和 SSH Web 启动不再调用桌面打开器。打开器失败不会使 Web 进程失败。自定义部署可以替换官方品牌 row，而无需修改通用 shell 组件；无品牌或非官方构建则保留 shell fallback。

局部库构建或前端构建不会刷新记录，release 消费方会拒绝缺少或过期的记录。构建记录描述生成字节和源码 revision，因此被 gitignore；它不是源代码管理的 release 输入。
