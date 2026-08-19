# @deepseek-ai/dsh-storage-sqlite

[English](README.md) | 中文

[存储中心](../storage/README.md)的 SQLite 后端：注册为后端 `sqlite`，通过一个数据库提供 `kv` facet；该数据库由 `node:sqlite` 操作，可以是单个文件，也可以是 `:memory:`。设计与取舍见[领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

## 存储模型

每行一个文档：每个单元表都会成为一个物理 STRICT 表 `"u_<unit>_<table>" (key TEXT PRIMARY KEY, value TEXT)`，其中 `value` 是记录的 JSON 文本，因此一个 key 只更新一行（高频变更领域路由到这里而非 JSON 后端的原因）。单元标识位于两个元数据表中：`units` 在单元首次打开时标记其格式版本，描述符不同时以 `version-mismatch` 拒绝；`unit_globals` 保存每个单元的全局单例行。物理布局版本位于 `PRAGMA user_version`；其他任何标记值都会被拒绝（未发布格式，不迁移）。单元名和表名在进入 DDL 之前依据中心的 `UNIT_NAME_RE` 进行验证，因此不会把外部输入插值到 SQL 标识符中。

每个写入原语都是一条预处理语句：SQLite 的逐语句原子性无需显式事务即可满足 KV 约定，写入顺序仍由调用方负责（领域层写入链）。连接在锁竞争时最多等待 `busyTimeoutMs`（默认 `5000` ms），默认使用 `synchronous=FULL`；`synchronous=NORMAL` 是部署明确选择的取舍。SQLite 的 WAL 自动 checkpoint 阈值通过 `walAutocheckpointPages` 显式配置（默认 `1000` 页），设为 `0` 时由 Host 维护决定 checkpoint 时机。缺失目录和数据库文件会以仅所有者可访问的权限创建（`0o700`／`0o600`），与会话持久化 SQLite 后端一致。

## 配置（schemastery）

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
  busyTimeoutMs?: number   // SQLite lock wait; 1..120000 ms, default 5000
  synchronous?: 'full' | 'normal'   // connection durability; default 'full'
  walAutocheckpointPages?: number   // WAL auto-checkpoint threshold; 0..1000000, default 1000
}
```

## 诊断与备份

`SqliteStorageBackend.checkIntegrity()` 运行 SQLite 的 `integrity_check` 和 `foreign_key_check` pragma。`SqliteStorageBackend.backup(destination)` 使用在线备份 API，以一致的数据库映像替换已有目标文件。`SqliteStorageBackend.checkpoint(mode?)` 默认运行有界的 `PASSIVE` checkpoint，并返回 SQLite 的进度计数。这些是 Host 维护 API，不返回模型可见数据。

## 模型体验

### 已存领域记录

#### 模型看到的内容

无。该后端不贡献提示词、工具或 schema；它在 `ctx.storage` 后面持久化非会话领域数据（工作区记录、未来的会话伴随元数据），只供主机侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：该后端从不触碰实时请求前缀。

## 已知限制与暂缓事项

- **`DatabaseSync` 是同步的**：每次写入和诊断会在其持续期间阻塞事件循环；在领域数据规模下可以接受。
- **锁处理有界**：另一个连接持有写事务时，操作最多等待 `busyTimeoutMs`，然后失败；后端不会重试。
- **只打开当前的 `STORAGE_SQLITE_SCHEMA_VERSION`**：其他任何已标记版本都会被拒绝而不是迁移（预发布立场）。
- **关闭自动 checkpoint 后由 Host 负责调度**：`walAutocheckpointPages: 0` 关闭 SQLite 自动阈值，但不会创建替代计时器；调用方必须在自有维护窗口调用 `checkpoint()`。
- **`openDatabase` 重复了会话持久化 SQLite 的打开顺序**：提取到共享介质层的工作暂缓至计划的会话后端迁移（见 Agent Note 的复用审计）。
