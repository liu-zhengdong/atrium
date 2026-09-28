# Atrium 包契约

Go 代码怎么分包、包之间怎么调用、并行开发时各自改哪里。设计依据只有规格（Discussion #496）；本文件只写代码层的约定。

## 并行规则

1. **只改自己的目录**：`internal/<包>/`。需要别的包做什么，调它导出的函数；缺函数就在 PR 里说明，由那个包的负责人补，不要顺手改别人的目录。
2. **接入不改 `cmd/atrium/main.go`**：每个包导出 `Module() app.Module`，模块列表已为全部包排好位置。你只在自己包里填 `Commands`、`Routes`、`Run`。
3. **命令注册在自己包里**：`Commands(t *cli.Table)` 里 `t.Group(...)` 声明自己的组（每组只声明一次），`t.Add(...)` 加命令。`task` 组由 ledger 声明，别的包直接往里加 `task run` 之类，不再声明。
4. **共享文件只有三个**，改时只动自己那一段，合并冲突按段解决：
   - `internal/store/schema.sql`：每张表一段，归属见下表。开发期不做迁移，改表就改这里，本地删库重建。
   - `go.mod` / `go.sum`：依赖只用标准库、`modernc.org/sqlite`、`gopkg.in/yaml.v3`（workers 解析档案时再加）。冲突时 `go mod tidy`。
   - `scripts/smoke.sh`：主路径冒烟，加步骤只往末尾 `stop` 之前追加自己的一段。
5. **快检查**：`.agents/check`（gofmt、vet 与 Windows/Linux 交叉编译、build、全部测试、`--help` 冒烟）。端到端：`scripts/smoke.sh`。单包测试超过 30 秒在 PR 里说明。
6. **开发期不写兜底**：不做自愈、旧写法兼容、自动回滚；出错就返回错误停下。

隔离运行：`ATRIUM_DATA=<临时目录> ATRIUM_PORT=<空闲端口> go run ./cmd/atrium start`，用完同样变量 `stop`。缺省数据目录 `~/.atrium-v2`、端口 4320；不要碰用户在跑的服务与数据目录。

## 包一览

| 包 | 状态 | 职责 | 拥有的表 |
|---|---|---|---|
| `cmd/atrium` | 完成 | 入口；模块列表；命令表由各包拼成 | — |
| `store` | 完成 | 打开 SQLite（WAL、外键、忙等、`BEGIN IMMEDIATE`）、建表、发短号 | `ids` |
| `config` | 完成 | 数据目录、端口、服务登记文件、用户令牌文件的位置 | — |
| `api` | 完成 | HTTP 信封、错误码、路由（认证在匹配后统一做，默认拒绝）、客户端 | — |
| `cli` | 完成 | 命令表、参数解析、帮助生成、回执（`Done`）、执行者拦截 | — |
| `app` | 完成 | `Module`、`Env` | — |
| `platform` | 完成 | 进程树结束、存活、shell、PATH 查找、服务与执行者白名单环境 | — |
| `pause` | 完成 | 一键停机的状态与判定 `Paused` | `pauses` |
| `service` | 完成 | start/serve/status/stop/restart/pause/resume/auth rotate；单实例；令牌 | — |
| `ledger` | 完成 | 任务、父子、依赖、状态机、就绪、汇总；`task add/ls/show/set/stop/tree/plan/note/wait`（`task stop` 即转受阻，派活循环结束执行者；`task set --status` 不收 blocked） | `tasks` `task_deps` `task_events` |
| `org` | 完成 | 部门、要点、要点链、身份、备忘、技能、资料、决定、凭据、上限表与计数 | `departments` `department_repos` `points` `identities` `memos` `skills` `materials` `choices` `choice_options` `decisions` `schedules` `secrets` |
| `org/leaders` | 完成 | 负责人运行时：唤醒（攒批 30 秒、同一位只起一个、20 分钟上限、连续 2 次没处理完转交上一层）、负责人令牌与统一权限判定、`leader escalate`；拉起经 `leaders.SetLauncher` 由 workers／dispatch 接上 | — |
| `org/agenda` | 完成 | 会生成任务的：选项单（拍板建任务）、周期任务（到点建任务并派发）；与 org 分包是因为要调 ledger（org 被 events 引用，不能再引用 ledger） | 用 org 的 `choices` `choice_options` `schedules` |
| `events` | 完成 | 事件落库（要处理／知会两级、同一订阅者同一去重键合并）、`events wait/ack`（长轮询、首条后攒批、15 分钟租约）、订阅者「在听」 | `events` |
| `dispatch` | 完成 | 派活队列、挑执行者与机器、拉起、退出后重试／换人／续上／交关卡；`task run`、`task tell`（捎话）、`task log`；装配 watch、agenda、gates 的入队钩子与 `hosts.AdapterFor` | `queue` |
| `workers` | 完成 | 适配器（7 个内置 + 通用命令行）、档案三层叠加、日志信号判定、拉起记录 `Run`、经过解析 `Trace`（claude、codex 按执行者的话分段，其余逐行原文）；`workers`（列、看、改档案） | `worker_profiles` |
| `gates` | 完成 | 查事实、判关卡、审阅（建审阅任务经 `gates.Enqueue` 派出）；档案经 `workers.Resolve`；没有仓库的任务判过时 `agenda.Settle` 登记 choice.json；与 dispatch 的经历约定见 `gates/records.go` | — |
| `merge` | 完成 | 合入队列、快检查；`task merge`（登记亲手做的 PR、放行受阻的交付）；快检查进程经 `watch.Track` 登记 | — |
| `release` | 完成 | 等版本、自升级、平滑重启、上线冒烟；`update` | — |
| `watch` | 完成 | 持球与期限表（`Rules`）、巡检循环、卡死判定、服务重启后接管；持球人判定 `HolderOf`；`top` 与 `/api/top` | — |
| `hosts` | 完成 | 机器登记、挑机器（`Pick`）、派到远程（`Launch`/`Stop`/`WaitExit`）、ssh 隧道、远程代理；`host add/ls [hN]/edit`（edit 含 `--key` 私钥、`--join` 重新接入、`--rm` 移除）；`agent`、`agent install` 在远程机器上照 `host add` 回执跑，不列在帮助里 | `hosts` `host_runs` |
| `quota` | 完成 | 额度读取、多机合并、富余（`Spares`）、用尽标记（`SetHold`）；`quota` | `quota_cache` `quota_holds` `quota_settings` |
| `web` | 完成 | 只读网页与只读接口；`map`；「等你」= 待拍板的选项单 + 递到你这层的卡住任务 + 上交到秘书还没确认的事；任务抽屉的「经过」是执行者真日志按段解析（`workers.ReadTrace`，与 `task log` 同一份解析）；代为注册一次性的 `import`（实现在 `importer`） | — |
| `importer` | 完成 | 从旧 TS 库只读导入部门、要点、决定、负责人、备忘、技能、资料、档案、机器 | — |
| `secretary` | 完成 | 把事件注入 Claude Code 会话；`secretary bridge`、`statusline`（状态栏调用，不列在帮助里） | — |

## 共同约定

### 模块（`internal/app`）

```go
type Env struct {
    DB    *store.DB
    Paths config.Paths
    Port  int
    Log   *slog.Logger
    Pause *pause.Store
}
type Module struct {
    Name     string
    Commands func(t *cli.Table)                       // 命令行进程里调用，没有 Env
    Routes   func(r *api.Router, env *Env)            // 服务进程里调用
    Run      func(ctx context.Context, env *Env) error // 后台循环；ctx 取消时返回；返回错误服务停下
}
```

### 命令（`internal/cli`）

- `cli.Command{Path, Args, Summary, Flags, Local, WorkerOK, Hidden, Run}`；`Run(c *cli.Ctx)` 里用 `c.Arg`、`c.Str`、`c.Opt`（没给为 nil，PATCH 用）、`c.List`（可重复、逗号拆）、`c.Bool`、`c.Int`、`c.MaxArgs`。
- 经服务完成：`c.Call(method, path, body, &out)`。只有 `Local: true` 的命令（start、serve、status、stop）不经服务。
- 回执：`c.Done(result, 人读文字, 下一步命令)`。人读模式打印文字，最后一行「下一步：…」；`--json` 输出 `{"ok":true,"result":…,"next":…}`。每条命令都支持 `--json`。
- 失败：返回 `*api.Error`（见下）；人读模式打印「错误：…」和可执行时的「修正：…」，`--json` 输出 `{"ok":false,"error":{"code","message","next"?}}`。用法错误退出码 2，其余 1。
- 字段校验的报错以参数名开头：`--title: 不能为空`。
- `ATRIUM_WORKER=1` 时命令一律拒绝，`WorkerOK: true` 的除外（第二波只给只读的 `material get` 开）。
- 值以 `--` 开头时写成 `--名字=值`。

### HTTP（`internal/api`）

- 网页这类不走 JSON 信封的处理函数用 `r.Raw(pattern, http.HandlerFunc)`，自己认证、默认拒绝。
- 路由：`r.Handle("POST /api/tasks/{id}/notes", func(q *api.Req) (any, error))`，Go 1.22 写法。`r.Public` 只给 `/health` 与 hosts 自己认机器令牌的 `/api/agent/*`。
- 路径里的短号用 `q.Ref("id", "t")` 取，自动拒绝前缀不对、`..`、`t0` 之类。请求体用 `q.Decode(&v)`（拒绝未知字段，上限 1MB）。
- 错误：`api.Usage`（400）、`api.NotFound`（404）、`api.Conflict`（409）、`api.Limit(next, …)`（409，满了必须给怎么腾地方）、`api.Forbidden`（403）、`api.Unavailable`（503，code `restarting`）；`.WithNext("atrium …")` 附修正命令。其他 error 一律 500 `internal`。请求 context 取消（服务停下或重启）自动变成 `restarting`，客户端据此等新服务后重发。
- 身份：`q.Actor{ID, Kind}`。某类身份的统一权限判定用 `r.AddGuard(kind, func(q) error)`（认证后、处理函数前；负责人的在 `org/leaders`，写接口默认拒绝）。用户令牌得到 `u1/user`。负责人令牌由 org 在自己的 `Routes` 里 `r.AddAuth(func(token) (api.Actor, bool))` 接入，按 `Actor.Kind` 在处理函数里判权限。机器令牌不进全局认证：hosts 把 `/api/agent/*` 用 `Public` 注册、在处理函数里自己认，机器令牌只在这组接口有效。

### 存储（`internal/store`）

- 写一律 `db.Tx(ctx, func(tx *sql.Tx) error)`；只读函数收 `store.Querier`（`*sql.DB` 与 `*sql.Tx` 都行），让调用方决定在不在事务里。
- 一律参数化查询；列表查询都带 `LIMIT`。时间是 Unix 毫秒（`store.Now()`）。可空外键列写 `store.Null(s)`。
- 短号：`store.NextID(ctx, tx, "t")` → `t12`，在插入的同一事务里调；前缀 `t o k a c d m h s`，全局持久不复用。用户固定 `u1`，秘书固定 `secretary`（`identities` 表建库时已插入）。

### 任务状态（`internal/ledger`）

- 状态 `todo queued running done failed blocked cancelled`；交付阶段 `stage`：`"" gate review merge_queue merged released`（交付中状态保持 `running`）。
- **改状态只经 `ledger.Apply(ctx, db, id, ledger.Event{Kind: …}, actor, note)`**，判定在纯函数 `ledger.Transition`。事件种类与谁发：

| Kind | 从 → 到 | 谁调 |
|---|---|---|
| `Enqueue` | todo/failed/blocked → queued | dispatch（`task run`，同一事务写 `queue` 行） |
| `Start` | queued → running | dispatch（进程已拉起） |
| `ExitOK` / `ExitFail` | running → running/gate ／ failed | dispatch 或 watch |
| `GatePass{NeedReview, NoMerge}` | gate → review ／ merge_queue ／ done | gates |
| `ReviewPass{NoMerge}` | review → merge_queue ／ done | gates |
| `Bounce` | gate/review/merge_queue → queued；第 3 次 → blocked | gates、merge（次数由 Apply 从经历里数） |
| `Merged{NeedRelease}` | merge_queue → done/merged ／ running/merged | merge |
| `Released` | merged → done/released | release |
| `Deliver` | todo/failed/blocked → running/merge_queue（交回次数重算） | merge（`task merge`） |
| `Block` / `Cancel` / `Set{To}` | 见 `state.go` | watch、命令行 |

- 其他写入：`ledger.SetFacts`（执行者、机器、PR）、`ledger.Record(ctx, q, id, kind, actor, body)`（关卡结论、交回原因等经历）。
- 读取：`Get`、`List`、`Deps`、`Subtree`、`History`、`Ready`（纯）、`Plan`（纯）、`Summarize/Rollup`（纯）。
- 等变化：`ledger.Changed()` 返回一个本进程任何任务写入后就关闭的通道（先取通道再读库）。dispatch 的循环用它，不要定时空转。

### 事件（`internal/events`）

- `events.Emit(ctx, q, events.Event{Kind, Task, Dept, Target, Body})`：在引起它的写事务里调用。种类常量写在 `events.go`（已有 `TaskStatus`、`Overdue`）。
- 级别与去重键缺省按种类取（`events/model.go`）：任务转 failed、blocked 与 `overdue` 要处理，其余知会；同一任务的 `task.status` 合并成最新一条。`Target` 留空时 events 包调 `org.Recipient(ctx, q, dept)` 取投递对象（部门往上最近负责人，没有投 `secretary`）。
- 任务事件：ledger 在状态变化与转入已合入时经 `events.EmitTask(ctx, q, owner, e)` 发 `task.status`，按处理人分发（纯函数 `events.Route`）。派活人是 `task add` 时的身份（周期任务记建周期任务的人），处理人是 `task add --owner`、缺省派活人，两者记在 `created` 经历里（`ledger.PartiesOf`，`task show` 显示）。结果（完成、已合入、上线、失败、受阻）要处理地投处理人：u1 与秘书投 `secretary`，aN 投自己；运行时建的（审阅任务）投部门负责人、没有投秘书，只有失败、受阻要处理。负责人不是收结果的那位时另收知会；过程（入队、拉起、交回一次、取消）只知会负责人。

### 一键停机（`internal/pause`）

- 每次自主动作（派活、唤醒、周期任务、合入、发版）前：
  `paused, err := env.Pause.Paused(ctx, pause.Scope{Orgs: org.Ancestors(...), Host: "hN"})`。
- 纯判定 `pause.Paused(active, scope)`：全局、链上任一部门、所在机器任一暂停即停。

### 组织（`internal/org`）

- `org.Ancestors(ctx, q, "oN")` → 顶层到本部门的链；`org.Chain(ctx, q, "oN")` → 要点链（顶层在前，同部门按 pos）；`org.ChainLine(p)` → 派活附的一行「k3（o1）规矩——为什么」。
- 上限表在 `org/limits.go`（`Limits`：会增长的东西 → 上限 → 满了找谁 → 怎么办）；满了一律 `org.Full(key, dept, used)`，计数 `org.Counts(ctx, q, dept)`（网页「6/7」，接口 `GET /api/limits?node=oN`）。
- 上限只挡写入，不截读取：读路径按技术上限 `org.ReadCap`（1000）查，超了报错而不是少给；超了业务上限的（导入的旧数据）照样全部返回，给人看的地方用 `org.Tally`／`org.Over` 标「超限 8/7」，要点链用 `org.PointsOver` 在派活与负责人提示词里加一行。
- 派活（dispatch）：`org.SkillPaths(ctx, q, data, task.Skill)` → 提示词附的 SKILL.md 路径；`org.GetSkill` 取优先执行者 `Workers`、交付要查 `Checks`、要的凭据 `Secrets`；`org.SecretEnv(ctx, db, data, task.Org, names)` → 注入执行者的凭据（按部门往上找，找不到报错带修正命令）。
- 负责人唤醒：`org.Overview(ctx, q, data, dept)` 总览全文；`org.Materials(…, MaterialFilter{Org})` 细节清单；`org.Decisions(…, DecisionFilter{Org})` 有效决定。
- 权限：`org.CheckReach(ctx, q, actor, dept)`（用户都行；负责人只到自己部门及下属）；`org.CheckUser(actor, 做什么)`（拍板、决定、凭据只有用户）。
- 关卡（gates）：没有仓库的任务判过时调 `agenda.Settle(ctx, db, task, workdir)`，工作目录根有 `choice.json` 就登记成选项单（不合法返回 usage 错误，按关卡不过交回）。
- 负责人的执行者组合与 `task run --worker` 同一种写法；登记时经 `org.CheckWorker`（workers 接上的 `Resolve`）核对。
- dispatch 装配时设 `agenda.Enqueue = func(ctx, env, task, actor) error`（即 task run）；周期任务每轮建任务后调它。

### 派活与执行者（`internal/dispatch`、`internal/workers`）

- 执行者标识 `工具[+模型][:强度]`；`workers.Resolve(ctx, q, id)` → 三层叠加后的规则（trust、max_risk、checks、limits、model、端点）与正文。关卡、审阅判执行者用它，不直接读 `worker_profiles`。
- 拉起记录：任务经历 kind `launch`（`workers.Run`：第几次、缘由、执行者、机器、pid、工作目录、日志、风险）；`workers.LastRun` 读。另按 gates 的约定记 `risk`（入队）、`worktree`（拉起）、`result`（退出，最后回复），并 `watch.Track`。
- 日志信号：`workers.Classify(退出码, 日志尾, 现在)` → 额度用尽／临时错误／思考耗尽；`Adapter.Ended` 判收尾；`workers.WatchSignal` 给 watch。
- 退出后 dispatch 自己收尾：正常 → `ExitOK`（进关卡）；临时错误同一执行者重试 1 次、再换人；额度用尽、思考耗尽换人（至多 2 次）；有没送到的捎话按工具续上会话或重派；其余 `ExitFail`。任务已不在 running/""（watch 或人先收了尾）就不动。
- 别的包要重新派：`dispatch.Enqueue(ctx, env, id, Options{…}, actor)`（即 task run，写队列行与 risk）；watch 经 `Hooks.Requeue`、周期任务经 `agenda.Enqueue`、审阅任务经 `gates.Enqueue`，都在 dispatch 的 Routes 里接上。交回（`gates.Bounce`）只转 queued、不写队列行：dispatch 对没有队列行的 queued 任务沿用上次拉起的执行者、风险与凭据。
- 远程：`workers.Request` 是纯数据，代理拿到后填 `Dir`、`PromptFile`，用 `workers.Build(tool, req)` 算出同样的调用。

### 子进程（`internal/platform`）

- 子进程只经 `platform.Start(platform.Spec{Path, Args, Dir, Env, Stdout, Stderr, Detached})` 拉起；`Env` 必填。执行者用 `platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))`（带 `ATRIUM_WORKER=1`，不带 `ATRIUM_*` 与凭据），任务声明的凭据在其后逐个注入。
- 执行者一律 `Detached: true`：服务重启不影响它；结束用 `platform.KillTree(pid)`。拉起后必须 `Wait`（Unix 不 Wait 会留僵尸，`Alive` 会一直报活）。
- 找程序用 `platform.LookPath(name, env)`（按子进程环境的 PATH/PATHEXT；`platform.EnvMap` 在 Windows 上把变量名落成大写）；shell 用 `platform.Shell(cmd)`。Windows 上找到的 `.cmd`/`.bat`（npm 装的 claude.cmd 等）由 `Start` 经 `cmd.exe /d /s /c` 拉起，参数带换行会报错。

### 服务（`internal/service`）

- `atrium`/`start` 拉起 `atrium serve`（服务白名单环境、独立会话、日志写数据目录 `service.log`），等 `/health` 回同一 pid。登记文件 `service.json`（pid、端口、版本）；同一数据目录只允许一个活着的服务。
- `restart`：旧进程拉起新进程（带 `ATRIUM_REPLACE_PID`，新进程等端口放开），再打断长轮询、排空在途请求后退出。`release` 包升级后调 `POST /api/service/restart` 即可。
- 用户令牌：数据目录 `token`（0600）；`auth rotate` 换新立即生效。

## 谁调谁

```
cmd/atrium ─→ service（serve 装载全部 Module）
各包 Commands ─→ cli ─HTTP→ api.Router ─→ 各包 Routes
dispatch ─→ ledger.Apply/SetFacts、org.Chain/GetSkill/SecretEnv、workers、gates（经历约定）、watch.Track、hosts、quota、pause、platform.Start
gates    ─→ ledger.Apply/Record（查 PR 用 gh，经 platform）
merge    ─→ ledger.Apply、platform（git、gh、快检查）
release  ─→ service 的 restart 接口、ledger.Apply(Released)
watch    ─→ ledger.Get/Apply、events.Emit(Overdue)、org、platform.KillTree
dispatch、merge ─→ watch.Track（拉起执行者或检查后登记 pid、日志、工作树）
dispatch ─→ watch.Use(Hooks{Requeue})：卡住或临时错误时重新入队（可换人、标额度）
workers  ─→ watch.Use(Hooks{Signal})：从日志尾部读临时错误、思考耗尽、额度用尽；leaders.SetLauncher：负责人唤醒按执行者组合拉起
events   ─→ org（投递对象 org.Recipient）
org/leaders ─→ org、events（Emit、Retarget）、ledger、platform；workers／dispatch 调 leaders.SetLauncher 接上拉起
secretary、web ─→ 只读：ledger、org、events
ledger   ─→ events.Emit
```

依赖只能朝下：`ledger`、`org`、`events` 不引用 dispatch 及之后的包；有环就是分包错了，停下来在 PR 里提。

## 给第二波的注意

- `task add` 的回执已给出下一步 `atrium task run tN`，`task show`/`task plan` 也会指向它：dispatch 必须提供 `task run`。
- 状态变化只能经 `ledger.Apply`；需要新的事件种类就在 PR 里提，由 ledger 加进 `Transition` 与表驱动测试，不要直接 `UPDATE tasks SET status`。
- 命令总数规格上限 60，`cmd/atrium/main_test.go` 会数；`Hidden` 的（serve、agent、agent install、import、statusline）不计数，由帮助末尾一行点名。
- 负责人令牌的权限表按路由模式判（`leaders.RuleFor`）；`cmd/atrium/routes_test.go` 装上全部模块的真实路由逐条核对，新加写接口要在那张表里写明负责人能不能调。
- 命令组名已占用：`task`、`org`、`point`、`auth`。其余按规格：`leader`、`memo`、`choice`、`decision`、`skill`、`material`、`schedule`、`secret`（org）、`events`（events）、`host`、`agent`（hosts）、`workers`（workers）、`secretary`（secretary）。单词命令：`top`（watch）、`statusline`（secretary）、`quota`、`map`、`update`。
