# server/hosts 与 server/agent 约定

执行机器与远程代理（#358）。总体规范见根目录 `AGENTS.md`，派活运行时的约定见 `server/tasks/AGENTS.md`。

- 判定与 IO 分开：连接状态、能不能接（`hostFit`）、挑主机（`chooseHost`）、远程目录布局、日志续传（`logAccept`）、重连对账（`reconcile`）在 `state.ts`；代理照不照做一条指令在 `server/agent/plan.ts`。都是纯函数，穷举测试（`tests/hosts-pure.test.ts`）。
- 账在 `model.ts`：`hosts` 一台一行（本机固定 h1，移除只打标记、短号不复用），`host_runs` 记远程任务当前这一轮（主机、轮号、那台上的克隆与工作树、日志收到哪个字节）。接入码与主机令牌只存哈希。
- 服务与代理的往来只有 `protocol.ts` 里的几种：代理长轮询领 `launch` / `stop` / `exec`（只读 git）/ `check`，另发请求传日志、报退出。认证在 `routes.ts` 的 onRequest（读请求体之前）：接入认 `Authorization: Bearer h<N>-…` 接入码，其余认主机令牌；这些路由在 `auth-policy.ts` 标为 `agent`，不看 Host（代理经转发连进来）。
- 代理这一侧复用本机派活的代码：建工作树 `tasks/git.ts ensureWorktree`、算调用 `tasks/workspace.ts buildLaunch`、拉起 `tasks/spawn.ts spawnWorker`、白名单环境 `tasks/worker-env.ts`、本地检查 `tasks/local-check.ts`；平台差异照旧只调 `server/platform/`。服务派来的路径必须落在代理数据目录里，git 只接受查询与清理用的子命令。
- 测试用同机起的代理（数据目录分开）与假执行者（`tests/hosts.test.ts`），不依赖真实远程机器。
