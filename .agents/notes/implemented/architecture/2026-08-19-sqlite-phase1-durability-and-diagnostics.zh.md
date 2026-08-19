# Agent Note：SQLite 第一阶段耐久性与维护基础

Status: implemented

[English](2026-08-19-sqlite-phase1-durability-and-diagnostics.md) | 中文

## 问题

SQLite 会话、查询索引和 KV 后端创建 `DatabaseSync` 连接时没有明确设置 busy timeout 或 synchronous 级别。因此遇到竞争写入时会立即失败，而耐久性设置依赖 SQLite 的连接默认值。会话后缀读取还会用分开的语句选择元数据和事件，运维方也没有后端自己的完整性检查或在线备份入口。

## 决策

三个第一方 SQLite 后端现在接受相同的连接策略：

- `busyTimeoutMs` 默认 `5000`，有效范围为 `1..120000`。
- `synchronous` 默认 `full`；只有部署明确选择时才使用 `normal`。
- 验证后的 timeout 传给 Node 的 `DatabaseSync` 构造函数，由 SQLite 安装原生 busy handler。不增加 JavaScript sleep 循环或无界重试。
- 在选择 journal mode 后使用 `PRAGMA synchronous`。该设置只作用于当前连接；用于可丢弃查询索引时不会改变规范会话数据库。

SQLite 会话后端的后缀读取现在在一个读事务中捕获元数据行和选定的事件行。完整前缀读取原本就使用事务；这样 seek 路径也不会把一个时间点的会话 header 与另一个时间点的事件混合起来。

会话持久化、查询索引和 KV 后端提供 Host 侧的 `checkIntegrity()`，其底层使用 SQLite 的 `integrity_check` 和 `foreign_key_check` pragma。三者也提供通过 Node Online Backup API 实现的 `backup(destination)`。备份是维护操作，会替换已有目标文件，不会变成模型可见工具或会话事件。

保留和删除现在由 Phase 3 SQLite 标记与清扫操作提供。它会为非活跃会话持久记录标记，并且只删除没有未标记 child 的标记会话；查询 projection、附件、导出物和外部客户端可见性仍是独立的所有权决策，因此仍刻意不提供原始 `DELETE FROM sessions` API。

## 考虑过的替代方案

**依赖 SQLite 默认值。** 拒绝：耐久性和锁行为会随运行时变化，并且部署配置不可见。

**在 JavaScript 中重试锁定操作。** 拒绝：SQLite 原生 busy timeout 已提供有界锁处理，不需要复制事务逻辑，也不会在事务结果不明确时重试。

**复制数据库文件进行备份。** 拒绝：SQLite Online Backup API 专门用于在源库使用期间生成一致映像；活动 WAL 状态下直接复制文件并不安全。

**在第一阶段加入删除。** 拒绝，直到明确所有权和引用策略。

## 影响

本地写入可以容忍短暂锁竞争，并在超过配置上限后明确失败。`FULL` 使耐久性选择可见，并默认采用保守设置；`NORMAL` 允许部署选择文档化的 WAL 取舍。连接仍然是同步的，因此较长事务和完整性检查仍可能阻塞事件循环。在线备份和完整性检查提供运维恢复信号，但不提供加密、多进程协调或保留策略。

由于数据库布局没有变化，schema version 不变；新增内容是连接配置和维护方法。

## 验证

SQLite 持久化、查询索引和 KV 测试覆盖默认 `FULL`、明确的 `NORMAL`、原生 busy timeout 配置、干净完整性诊断、在线备份和备份数据。持久化测试还覆盖事务化 seek 读取路径。完成这些变更后仍需通过仓库 typecheck、lint、package invariant 和文档 gates。
