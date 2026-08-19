# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

官方 Web 品牌插件。它向通用侧边栏标记、侧边栏名称和空白会话 Hero 标记 slot 提供 DeepSeek 鱼形标记与字标。本包由 Web bundle 作为浏览器 client row 组合；不拥有会话或模型状态。

只有在构建选择 `DSH_CLIENT_BUILD_PROFILE=official` 时，client 条目才会注册。这使品牌成为构建期选择：部署可以省略该 row，或提供另一个 slot occupant，而无需修改共享的侧边栏或对话壳。本包的 Host 半侧有意为空；浏览器半侧通过 client module table 加载。

## 模型体验

无，因为本包只改变浏览器呈现，不贡献面向模型的提示词、工具或提供方请求数据。

#### KV Cache 影响

无；本包既不组装也不发送模型请求。

## 已知限制与暂缓事项

- 当前官方 profile 提供固定的 `DeepSeek Harness` 字标；部署专属运行时品牌应使用经过校验的运行时配置机制，而不是读取浏览器环境变量。
- 本包只填充通用品牌 slot。替换侧边栏或对话壳的部署必须提供自己的品牌呈现。
