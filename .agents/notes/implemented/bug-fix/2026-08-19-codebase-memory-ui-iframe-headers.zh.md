# Agent Note: Allow the codebase-memory graph UI in the harness iframe

Status: implemented

English | [中文](2026-08-19-codebase-memory-ui-iframe-headers.md)

## Problem

上游图形界面可能发送面向顶层页面的 `X-Frame-Options` 或 CSP `frame-ancestors` 指令。Harness 通过同源的沙箱 iframe 提供该界面，但原样转发这些响应头会让 Firefox 拒绝显示 Codebase Memory 面板。

## Decision

Web 代理移除上游的 `X-Frame-Options` 响应头，并仅从上游 Content-Security-Policy 中移除 `frame-ancestors` 指令。其余响应头和 CSP 指令保持不变。该路由继续使用 harness 所有的沙箱 iframe，原生图形服务器仍只监听 loopback。

## Consequences

- Firefox 和其他浏览器可以在会话视图中渲染 `/codebase-memory/` 图形界面。
- 上游界面保留其余 CSP 限制，不会新增第二个网络监听器。
- 由于上游服务器无法知道响应会被挂载到 harness 源下，代理负责这个嵌入例外。

## Alternatives considered

**移除整个 Content-Security-Policy 响应头。** 不采用，因为嵌入例外只需要修改一个指令；移除其他策略会不必要地扩大界面的浏览器执行权限。

**改为新窗口打开图形界面，而不是嵌入。** 不采用，因为该功能需要与 Chat、Trajectory、Files 和 Commits 并列显示，新窗口会失去共享工作区上下文。

**直接暴露 9749 端口并让浏览器打开。** 不采用，因为这会绕过 harness 源，并让未认证的图形服务器超出 loopback 代理边界。
