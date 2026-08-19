# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

可选启用的 SQLite `SessionPersistence` 提供方：第二个提供方（见[会话持久化](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)），使用 schema-17 物理行并满足与 `dsh-session-persistence-jsonl` 相同的约定。符合条件的 assistant 分片连续段会被打包，大型 payload 会选择性使用 Zstandard 压缩，来源数组使用 delta varint 编码；所有读取都会恢复完全一致的逻辑 `SessionEvent[]`。

`locate(meta)` 返回 `undefined`：所有会话共享一个数据库，因此不存在真实、独立的逐会话 transcript（文本记录）路径。

## 存储模型

Schema 17 保留 `events(session_id, seq)` 物理索引。标量行存储一个逻辑事件。连续且属于同一块的文本、推理和工具调用 delta 使用物理标签 `text-chunks`、`reasoning-chunks` 和 `tool-call-chunks`；打包行存储首个序列／时间与共享 payload，最多表示 1,024 个事件及 1 MiB 未压缩 UTF-8 数据。打包行使用 `ignorable=0` 作为判别值并保持 surface 字段为空；标量行仅在逻辑事件可忽略时使用 `ignorable=1`，因此未来的可忽略事件可以安全复用存储标签名称。未知字段、surface 元数据、缺口、不兼容的分片身份和不安全时间戳仍保持标量。可为空的 `surface_op` 存储可选接口元数据（见[会话接口](../../../.agents/notes/implemented/architecture/2026-06-18-session-surface.md)）；`source_event_seqs` 作为完整的 delta 编码 BLOB 存储。读取会在返回事件前展开物理行。日志外元数据（`SessionHeader`）、每实体化 incarnation id 和每日志单调修订位于 `sessions` 行；`createdAt` 是存储在 strict `INTEGER` 列中的非负安全整数。单例状态行携带不可变存储 id。`sessions` 行只由第一次 `append` 写入，其存在性是延迟实体化信号（`list` 精确报告有行的会话）。删除标记存放在 `session_deletion_marks` 中；它是持久化维护状态而不是会话事件，删除会话时由外键级联一并移除。

仓库支持的 Node 范围可不加 flag 使用 `node:sqlite`。数据库启用外键，在锁竞争时最多等待配置的 `busyTimeoutMs`（默认 `5000` ms），并使用已配置 journal mode（默认 `wal`；WAL 共享内存文件不适用时使用 rollback mode）。连接默认使用 `synchronous=FULL`；`synchronous=NORMAL` 是部署明确选择的吞吐／耐久性取舍。SQLite 的 WAL 自动 checkpoint 阈值通过 `walAutocheckpointPages` 显式配置（默认 `1000` 页）；设为 `0` 会关闭自动 checkpoint，交由运维维护计划负责。`PRAGMA application_id` 标识规范持久化数据库，`PRAGMA user_version` 存储布局版本。新数据库必须没有 application identity 或用户定义 schema 对象；初始化在一个事务中创建全部表并盖上两个 pragma。非 pristine 无版本数据库、外部 application identity 和所有非当前版本在 journal-mode 变更前均会被拒绝，因为该未发布格式无迁移。

在具有 POSIX mode 的文件系统上，后端为缺失目录请求 mode `0700`，并在 SQLite 打开前以 mode `0600` 排他创建缺失数据库；进程 umask 可进一步限制两者。新 WAL、共享内存和持久 rollback-journal sidecar 获得数据库最终的仅所有者 mode。现有目录、数据库文件和 sidecar 保留原 mode；除已存在数据库外的文件系统设置错误会使初始化失败。这些默认值防止宽松进程 umask 造成的意外暴露，但当其他 principal 能替换父目录中的数据库条目时，不保护数据库机密性或完整性。

## 行上的约定语义

- **Append = 事务。**`append` 围绕批次运行 `BEGIN`/`COMMIT`：它实体化 `sessions` 行（如果仍未实体化），并 INSERT 每个事件，首先断言连续 seq 约定（第一个事件 `seq` 必须等于已存储 next-seq）。批次中失败（重复 seq 上的 UNIQUE 违规）会完全回滚，使已存储日志和内存游标保持一致。（`load()` 已平衡已存储日志，因此 `append` 不必修复崩溃尾部。）
- **延迟实体化。**`create()` 只在内存记录意图，第一次 `append` 前不写行。已创建但从未 append 的会话没有 `sessions` 行，因此不在 `list()` 中（它精确报告有行的会话）。
- **在 load 时关闭中断轮次。**`load()` 实现共享[崩溃恢复约定](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)：保留有效中断轮次，在一个事务中追加合成关闭事件，并只移除撕裂尾部行。已提交解析错误或序列缺口使会话无法加载。恢复会变更已存储行，因此下一次 append 从平衡日志和准确游标开始。
- **非修改式检查。**`inspect()` 返回不可变、平衡的逻辑视图，并可在内存中合成恢复 closer，但不会删除撕裂尾部行、追加恢复行或更改轻量修订。
- **轻量修订。**`listSnapshots(signal?)` 组合不可变存储与数据库文件身份、每实体化 incarnation id，以及在每个变更事务中递增的每会话计数器。完整前缀读取在同一个读事务中捕获该 revision 及其事件行，`readStoredRevision()` 则只查询 session 行来校验保留的 preparation。它在不解析事件行的情况下保持未变观察稳定，并区分独立存储和重建的同 id 日志。它在共享就绪和同步元数据查询前后检查取消；查询本身不可抢占。
- **标记与清扫保留。**`markForDeletion(ids, reason?)` 为已实体化且非活跃的会话持久记录幂等标记。标记会话从普通列表中消失，并拒绝新的 append。`sweepMarked(limit?)` 只删除非活跃且没有未标记 child 的标记会话；外键级联会删除其事件和标记。活跃会话及仍被引用的 parent 会保留标记，等待后续批次。此操作不会收集附件文件或其他 projection。

## 配置（schemastery）

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
  busyTimeoutMs?: number   // SQLite lock wait; 1..120000 ms, default 5000
  synchronous?: 'full' | 'normal'   // connection durability; default 'full'
  walAutocheckpointPages?: number   // WAL auto-checkpoint threshold; 0..1000000, default 1000
  preparedSessionCacheSize?: number   // positive integer; default 5
  writeBatchMaxDelayMs?: number   // positive integer; default 200; maximum 2_147_483_647
}
```

## 写入路径

与 JSONL 后端一样，插件将每个冻结的 `session/event` 复制到对应活动会话的 controller 中。第一个待处理事件会开启配置的固定批处理窗口，后续事件会加入但不会重置截止时间。每个持久批次运行 `BEGIN IMMEDIATE`、验证物理尾部，只打包新追加的兼容事件，插入物理记录并只递增一次 revision；不会改写既有行。`session/flush` 会取消等待并排空当前与待处理批次。Controller 会持久化一次 fork 种子，并保留写入游标，使恢复操作绝不重新 append 已存储事件；它还会在 apply 时为活动会话设置初始状态，因为 HMR（热模块替换）不回放 `session/created`。dispose（资源释放）会在关闭数据库前排空每个保留的 controller。

## 诊断与备份

`SqliteSessionPersistence.checkIntegrity()` 运行 SQLite 的 `integrity_check` 和 `foreign_key_check` pragma，并返回原始结果及 `ok` 状态。`SqliteSessionPersistence.backup(destination)` 使用 Node 的在线备份 API，因此 SQLite 复制一致数据库映像时源库仍可使用；已有目标文件会被替换。`SqliteSessionPersistence.checkpoint(mode?)` 默认运行串行化的 `PASSIVE` checkpoint，并返回 SQLite 的 `busy`、`log` 和 `checkpointed` 计数。`listSnapshotsPage(limit, cursor?, signal?)` 按创建时间降序、id 升序提供有界 keyset 分页。`markForDeletion`、`listDeletionMarks` 和 `sweepMarked` 是明确的 Host 保留操作；它们不会发出会话事件，也不会成为模型可见工具。

## 模型体验

### 恢复的对话历史

#### 模型看到的内容

SQLite 存储不会向当前请求提供提示词或 schema。加载会恢复与 JSONL 相同的呈现历史，并保留之前的 header 用于重建；新 loop 组合当前 envelope。恢复会用 `TOOL_NOT_STARTED` 平衡没有已持久化调用的 assistant 请求；已有持久化调用但无结果时则变为 `TOOL_OUTCOME_UNKNOWN`，它要求模型只重试只读或幂等工作，并验证可能的副作用或询问用户。行元数据和原始分片不会成为消息。

#### Token 影响

SQLite 存储不会增加当前请求的 token 用量。恢复会还原已保留的历史，并产生当前 envelope 以及每个中断调用所附、以引用形式呈现的修复结果文本所产生的 token 开销。

#### KV Cache 影响

SQLite 存储不修改当前请求前缀。只有重建历史、当前 envelope 和模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果会追加到末尾。

## 已知限制与暂缓事项

- **`DatabaseSync` 是同步的**：每个 append 事务和诊断语句在整个期间阻塞事件循环；对本地存储可接受，对繁忙多会话服务器是吞吐上限。
- **锁处理是有界的，不是无限等待**：连接最多等待 `busyTimeoutMs`，之后失败；调用方仍需在合适的生命周期边界暴露持久化失败并重试，而不是隐藏无限争用。
- **默认 `synchronous=FULL` 并不保证整个主机的断电安全**：文件系统、设备和操作系统故障语义不属于进程约定。只有部署明确选择时才使用 `NORMAL`。
- **只有 pristine 新数据库或当前自有 schema-17 `SCHEMA_VERSION` 才能打开**：无版本 schema 对象、外部 application identity 和所有其他 schema 版本被拒绝，而不是迁移（未发布软件，无持久用户数据需要保留）。
- **标记与清扫不会收集所有依赖工件**：SQLite 提供方会保护活跃会话及未标记 child 引用，然后只在会话行、删除标记和事件行之间执行级联删除。查询索引、附件、导出物和其他 projection 仍需要各自的对账或所有权钩子，之后才能安全收集。
- **TODO：** 该后端直接调用 `node:sqlite`。如果采用 Cordis 数据库服务（`cordis/db` / `@cordisjs` SQL driver 插件），应改为通过该服务路由，而不在此直接持有 `DatabaseSync`；约定接口（`SessionPersistence`）不会变，只更换存储驱动。
