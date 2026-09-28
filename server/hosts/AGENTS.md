# server/hosts 与 server/agent 约定

执行机器与远程代理（#358）。总体规范见根目录 `AGENTS.md`，派活运行时的约定见 `server/tasks/AGENTS.md`。

- 判定与 IO 分开：连接状态、能不能接（`hostFit`）、挑主机（`chooseHost`）、远程目录布局、日志续传（`logAccept`）、重连对账（`reconcile`）在 `state.ts`；代理照不照做一条指令在 `server/agent/plan.ts`。都是纯函数，穷举测试（`tests/hosts-pure.test.ts`）。
- 账在 `model.ts`：`hosts` 一台一行（本机固定 h1，移除只打标记、短号不复用），`host_runs` 记远程任务当前这一轮（主机、轮号、那台上的克隆与工作树、日志收到哪个字节）。接入码与主机令牌只存哈希。
- 服务与代理的往来只有 `protocol.ts` 里的几种：代理长轮询领 `launch` / `stop` / `exec`（只读 git）/ `check`，另发请求传日志、报退出。认证在 `routes.ts` 的 onRequest（读请求体之前）：接入认 `Authorization: Bearer h<N>-…` 接入码，其余认主机令牌；这些路由在 `auth-policy.ts` 标为 `agent`，不看 Host（代理经转发连进来）。
- 代理这一侧复用本机派活的代码：建工作树 `tasks/git.ts ensureWorktree`、算调用 `tasks/workspace.ts buildLaunch`、拉起 `tasks/spawn.ts spawnWorker`、白名单环境 `tasks/worker-env.ts`、本地检查 `tasks/local-check.ts`；平台差异照旧只调 `server/platform/`。服务派来的路径必须落在代理数据目录里，git 只接受查询与清理用的子命令。
- 本地检查派到空闲主机（#358 第 2 步）：挑哪台是 `check-plan.ts` 的纯函数（`chooseCheckHost`，本机也是候选、按每核负载与检查占用比；只挑与仓库检查基准同平台的主机，基准由 `checkBaseline` 定：仓库 `.agents/check-platform`，缺省本机平台，t201），取候选、在本机工作树里取提交与 bundle、派给代理、没跑成换一台或回本机在 `check-runtime.ts`（`CheckDispatch`，合入队列 rebase 后的检查用它）。代理这一侧在 `server/agent/check.ts`：同一克隆上的 git 操作排成一串，检查工作树按号复用、`npm ci` 按锁文件哈希跳过。检查日志经 `/api/agent/check-log` 按指令 id 与字节偏移续传，回执带日志总长，服务没收全就让代理先补传；服务不再等的检查在长轮询回答的 `cancel` 里，代理据此停下。回执 `infra` 表示那台没跑成（换地方重跑），不是检查不过。
- 额度多主机合并（#358 第 2 步）：代理定时经 `/api/agent/quota` 上报自带读取器的读数（额度数字、套餐、账号指纹），服务只留每台最近一次（内存，重连即重报）；任务运行时把主机账与读数登记为 `quota.ts` 的来源，`tasks/quota-source.ts` 读额度时取来，按 `quota-readers/merge.ts mergeHostReadings` 合并。
- 测试用同机起的代理（数据目录分开）与假执行者（`tests/hosts.test.ts`），不依赖真实远程机器。
