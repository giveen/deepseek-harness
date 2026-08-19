# Agent Note：Workspace 文件与提交查看器

Status: implemented

[English](2026-08-19-workspace-file-commit-viewer.md) | 中文

## 问题

当前选中的 Workspace 可以提供 Session 分组和目录选择，但对话中没有直接查看选定目录或其 Git 历史的入口。操作员必须离开 Harness，才能确认文件或检查生成 Workspace 的变更。

## 决策

Workspace 插件通过 `conversation.view` 添加两个位于 Chat 和 Trajectory 旁的标签：**文件**与**提交**。文件视图为当前 Session 关联的 Workspace 加载由 Host 管理的递归列表，在客户端展开目录，并通过现有 Host 打开器交回文件路径。提交视图按最新优先加载分页结果，在原位展开每条提交的完整消息，并使用最后一条提交 id 作为游标请求更早页面。

Host 负责文件系统与 Git 检查。它从 registry 根据 Workspace id 解析根目录，而不是接受任意客户端路径；文件树排除 `.git` 与 `node_modules`，不跟随目录符号链接，并限制深度和条目数量；Git 使用不带 shell 的 `execFile('git', args)` 读取。目录缺失或没有 Git 仓库时，视图显示内联错误，不会使对话失败或修改 Workspace。

视图绑定当前 Session，并在 Session 或 Workspace 基线改变后重新解析。文件条目只在现有 Host 打开路径交接中携带绝对路径；相对路径是显示身份。提交消息是 Host 计算后的文本，不会进入模型可见内容。

## 考虑过的替代方案

**把文件树放入侧边栏。** 否决：请求的交互应与对话的 Chat 和 Trajectory 上下文并列，而侧边栏已经负责 Workspace／Session 导航。

**向通用文件系统端点发送任意客户端路径。** 否决：Host registry 已经知道授权的 Workspace 根目录；接受路径会扩大 API，并让客户端承担遍历策略。

**持续流式传输 Git 历史。** 否决：提交历史是分页且由用户按需检查的数据。一个有界 unary 页面足够，也不需要第二条实时流。

## 影响

用户无需离开对话即可检查活动 Workspace，并能在 Host 应用中打开文件。大型仓库仍受边界限制，没有 Git 的 Workspace 仍可使用；更早历史只在用户请求时加载。该功能依赖现有 connection、Workspace registry、conversation view slot 和原生打开器；没有 Workspace 的部署显示本地化空状态。

## 测试

针对 UI 的测试覆盖目录展开、文件打开、提交消息展开以及按游标加载更早页面。Host Workspace API 与进程内载体测试覆盖新增方法路由和 schema。类型检查覆盖浏览器与 Host contract 面。
