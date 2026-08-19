# Agent Note：跨平台规范化发布 manifest 路径

Status: implemented

[English](2026-08-19-release-bump-path-normalization.md) | 中文

## 问题

发布 bump 规划器会把 `path.join()` 生成的 manifest 路径传给比较逻辑和 Git pathspec。在 Windows 上这些路径包含反斜杠，而发布族发现逻辑与仓库相对路径使用 `/`。路径格式不一致可能导致规划器漏掉可发布 manifest，或向 `git add` 传入依赖平台的路径。

## 决策

无论宿主平台是什么，发布 bump 规划中的所有仓库相对 manifest 路径都使用 `/`。文件系统读取仍会在最终 I/O 调用处通过 `path.join()` 处理这些路径。规划器对 dsh 与 vendored manifest 都使用规范化形式，因此比较逻辑和 Git 操作使用同一种表示。

## 曾考虑的替代方案

- 始终保留宿主平台分隔符：拒绝，因为仓库相对路径还会与使用 `/` 的 glob 和 Git pathspec 值比较。
- 只在 `git add` 前规范化：拒绝，因为比较逻辑可能在 Git 操作前就已经产生分歧。
- 在规划中保存绝对路径：拒绝，因为发布规划与日志需要稳定的仓库相对路径，绝对路径也不是可移植的 Git pathspec。

## 后果

发布 bump 规划在 POSIX 和 Windows 宿主机上保持确定性。文件系统写入路径在最终 I/O 调用处仍使用宿主机格式，而日志标签、比较逻辑和 Git 参数保持仓库相对形式。

## 测试

发布族测试验证 Windows 风格的包目录会转换为使用 `/` 的 `package.json` 路径。现有发布族与 payload 测试继续覆盖相关规划行为。
