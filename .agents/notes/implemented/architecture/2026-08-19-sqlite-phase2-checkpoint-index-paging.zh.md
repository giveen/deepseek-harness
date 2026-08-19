# Agent Note：SQLite Phase 2 checkpoint、索引与分页基础

状态：已实现

[English](2026-08-19-sqlite-phase2-checkpoint-index-paging.md) | 中文

## 问题

Phase 1 明确了 SQLite 的耐久性与维护选择，但各提供方仍依赖 SQLite 隐含的 WAL 阈值，每个发生变化的 FTS 会话都从第一个文档开始重建，并以一个无界结果集暴露持久化快照。对于小型存储这些选择是正确的，但维护时机和增长成本仍然是隐含的。

## 决策

第一批 Phase 2 继续由现有提供方负责：

- 所有一方 SQLite 提供方都暴露 `walAutocheckpointPages`，默认使用 SQLite 的 1000 页阈值，并限制在 `0..1_000_000`。设为零会关闭自动 checkpoint，但不会启动应用计时器。
- 所有一方 SQLite 提供方都暴露 `checkpoint(mode)`；在已有串行化操作的提供方中由拥有者负责串行化。默认模式是 `passive`；SQLite 返回 `busy`、`log` 和 `checkpointed` 计数，使运维能够区分未完成工作与已完成 checkpoint。
- `SessionPersistence.listSnapshotsPage()` 增加有界快照分页 seam，并为第三方后端提供兼容回退。SQLite 会话后端用 `(created_at DESC, id ASC)` keyset 查询覆盖该方法。SQLite 查询提供方分批读取这些页面，同时保留稳定的前后观察比较。
- SQLite FTS 对账只有在已有索引文档是新观察文档的精确前缀时才追加。修复、重写和第一次实体化仍使用现有的完整替换路径。这样普通实时增长无需重复分词和替换 FTS 行，同时保持非追加变化的正确性。

没有改变 SQLite 布局版本。checkpoint 阈值属于连接配置，持久化分页游标由元数据派生，FTS 增量写入使用现有行和列。

## 考虑过的替代方案

**创建进程计时器运行 checkpoint。** 否决：每个提供方都要再拥有一套生命周期与计时器，计时器也会与 SQLite 原生阈值竞争。当 Host 负责调度时，可以使用零阈值和显式维护调用。

**始终使用 `FULL` checkpoint。** 否决：`PASSIVE` 是管理调用的安全默认值，因为它不会等待读取方或强制 restart。维护窗口允许时，调用方可以请求 `FULL`、`RESTART` 或 `TRUNCATE`。

**不验证前缀就追加所有变化的 FTS 文档。** 否决：修复或重写可能留下旧行并产生重复命中。前缀比较是准入条件；否则继续使用原子替换路径。

**把抽象列表约定改为强制分页方法。** 否决：第三方持久化提供方会立即破坏。基础服务提供有界兼容回退，而 SQLite 拥有高效覆盖实现。

**在这一批中把所有 `DatabaseSync` 操作迁移到 worker thread。** 暂缓：Node 文档将 worker 定位为适合 CPU 密集工作，而该变化需要新的请求协议、worker 生命周期、错误传播和 artifact-plane 构建路径。运维与查询改进可以独立交付，风险更低。

## 后果

运维可以调整 WAL 增长并主动运行 checkpoint，不必依赖未记录的 SQLite 默认值。关闭自动阈值不会自动产生调度；关闭它的 Host 负责维护频率并观察返回计数。持久化观察者收到有界数据库页面，同时保留原有的稳定观察重试语义。普通追加式 FTS 增长只写入新尾部，而修复和重写仍执行完整替换。

`DatabaseSync` 仍是同步的，checkpoint、FTS 事务或查询仍可能阻塞事件循环。多进程所有权和网络文件系统限制不变。Phase 3 为非活跃且无未标记引用的会话增加了由提供方负责的标记与清扫保留；附件、projection 和 worker 隔离仍是独立决策。

## 验证

SQLite 持久化、查询索引和 KV 套件覆盖默认与配置的 WAL 阈值、checkpoint 报告、快照 keyset 分页，以及追加式 FTS 尾部保留。三个聚焦套件合计通过 190 个测试，受影响的包 TypeScript 项目也通过。
