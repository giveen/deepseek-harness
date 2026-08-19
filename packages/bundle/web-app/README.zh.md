# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：设置 coding persona，插入 Web 宿主行（webserver、API 网关、workspace、投影缓存、存储）、浏览器插件名录与始终挂载的客户端插件重载链（[`dsh-client-hmr`](../../client/hmr/README.md)，在重建 watcher 改写客户端 bundle 之前保持空闲），并挂载本包的 `web-runtime` 粘合插件（配置为 `{printUrl, surfaceContext, trustedHosts, lanInstanceProbeTimeoutMs}`）。该插件通过 `@deepseek-ai/dsh-web-frontend` 的 exports 解析已构建的前端 dist，只采样一次依赖 bind 的 LAN 地址用于 URL 显示与 Web runtime 诊断，提供 `webRuntime` 快照，并挂载 [`frontend-static`](../../host/frontend-static/README.md) 回退席位所有者；connection 插件会独立从相同的非内部 IPv4 地址为 `/api` 信任栅栏推导 authority，在 `surfaceContext` 为 true 时注册 Harness 源码与 Web 表层提示词段落，以及 bash 可见的 `DSH_WEB_URL` 运行时变量，并在 `printUrl` 为 true 时等自身的 Loader 配置树结算后再打印 `dsh web:` URL 行，避免兄弟行失败时公告一个已失效的应用。CLI 会在启动此 profile 前取得独占的 `$DSH_HOME/web-host.lock`，因此使用同一会话 home 的第二个 Web 进程会在暴露分叉的会话存储前失败；已退出进程留下的锁会自动恢复。就绪后，它还会探测每个公告的 LAN authority；如果该地址实际服务的是另一个不透明 Web 实例，就记录警告，在用户把空的会话列表误判为会话共享失败前指出问题。本组合包还持有应用命令行：普通 `web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.md)），解析 `--host`、`--port`、可重复的 `--trusted-host` 以及应用自己的 `--help`，再提供 `webStartup`。它接受 `--host 0.0.0.0` 以服务 LAN，并在绑定后为相应的 IPv4 地址推导信任 authority。由 flag 配置的行会注入该服务，并在惰性配置中直接读取它，因此参数解析完成前不会有任何东西绑定端口，`dsh --profile web --help` 也不会启动服务器。[`dsh-headless`](../headless/README.md) 是同一 base 之上的同级表层，不挂载本组合包。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致。
- **会话共享要求一个 Web 实例**：会话列表由 Host 所有，因此由不同进程或不同 `$DSH_HOME` 提供的 loopback 与 LAN URL 不能共享运行中的 Agent。CLI 锁会阻止两个使用同一 `$DSH_HOME` 的 `dsh web` 进程；启动后的 LAN 实例探测会警告外部启动或配置不同的实例，但不会合并相互独立的进程。
