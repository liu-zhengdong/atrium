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
| `ledger` | 完成 | 任务（仓库或工作地点二选一；都没写的，`task run` 派出去时沿用部门的仓库——部门恰有一个才沿用，纯判定 `DeptRepo`、写入 `UseDeptRepo`；运行时自己派的审阅、周期任务不经这里）、父子、依赖、状态机、就绪、汇总；草稿记的发现带来源（用户纠正／组织发现）与类，来源一行带记录人（派活人）的名字（`org.NameOf`），用户本人验收退回、取消任务时 `Apply` 自动记一条用户纠正（纯判定 `Correction`）；三个目标的数（纠正、认可、复发）由纯函数 `Measure` 算、`ReadGoals` 读，top 与网页今天页共用；`task add/ls/show/set/stop/tree/note/wait`（`task tree` 每件标出能派还是在等谁）（`task stop` 即转受阻，派活循环结束执行者；`task set --status` 不收 blocked） | `tasks` `task_dirs` `task_findings` `task_deps` `task_events` |
| `org` | 完成 | 部门、要点、要点链、验收人（沿树继承）、身份、备忘、技能、资料、凭据、上限表与计数 | `departments` `department_repos` `acceptors` `points` `identities` `memos` `skills` `materials` `choices` `choice_options` `choice_option_orgs` `schedules` `secrets` `limit_notices` |
| `org/leaders` | 完成 | 负责人运行时：唤醒（攒批 30 秒、同一位只起一个、20 分钟上限、连续 2 次没处理完转交上一层）、负责人令牌与统一权限判定、`leader escalate`；拉起经 `leaders.SetLauncher` 由 workers／dispatch 接上 | — |
| `org/agenda` | 完成 | 会生成任务的：选项单（拍板建任务）、周期任务（到点建任务并派发）；与 org 分包是因为要调 ledger（org 被 events 引用，不能再引用 ledger） | 用 org 的 `choices` `choice_options` `choice_option_orgs` `schedules` |
| `events` | 完成 | 事件落库（要处理／知会两级、同一订阅者同一去重键合并）、`events wait/ack`（长轮询、首条后攒批、15 分钟租约）、订阅者「在听」、清理（每小时删掉最后更新超过 7 天的已确认与知会级事件，要处理且没确认的不删） | `events` |
| `dispatch` | 完成 | 派活队列、挑执行者与机器、拉起、退出后重试／换人／续上／交关卡；`task run`（入队前经 `ledger.UseDeptRepo` 补部门的仓库）、`task tell`（捎话）、`task log`；装配 watch、agenda、gates 的入队钩子与 `hosts.AdapterFor` | `queue` |
| `workers` | 完成 | 适配器（7 个内置 + 通用命令行）、档案三层叠加、日志信号判定、拉起记录 `Run`、经过解析 `Trace`（输出 JSON 事件的工具各自的解析挂在适配器 `Driver.read` 上，按执行者的话分段、步骤写成「工具名 路径」，认不出的事件记 `Unknown`；纯文本工具逐行原文）、执行者可用性（「工具+模型@机器」不可用标记：`MarkOf` 由退出信号翻成标记、`Blocked` 给挑执行者与挑机器判）、按拉起统计（`Stats`：每次拉起一个结果——交付、被交回、额度、起不来、其他失败，按「工具+模型」归、强度不单列）；`workers`（列、看档案与每次拉起的明细，只读）、`workers edit`（改档案，`--clear` 解除不可用标记） | `worker_profiles` `worker_marks` |
| `gates` | 完成 | 交付方式（`delivery.go`：pr、local、dir、choice、message 各自的提示词、关卡、落地；local 的关卡与落地在 `local.go`）；查事实、判关卡、审阅（建审阅任务经 `gates.Enqueue` 派出）；等验收与 `task accept/reject`；档案经 `workers.Resolve`；按工作树登记的机器查 git（远程经 `hosts.Ask`），PR 由服务查；与 dispatch 的经历约定见 `gates/records.go` | — |
| `gates/skillcheck` | 完成 | 技能声明的交付检查：技能的 `checks` 写检查名（`article`、`video`），关卡在本机工作目录里查表自己跑（构建与明暗截图；ffprobe、响度、第一帧不空白、联系表），产物放任务目录、结论与路径记进经历；每项有时限，跑不起来（缺工具、工作目录在远程）转受阻；org 保存技能时经 `Validate` 校验名字 | — |
| `merge` | 完成 | pr 交付方式的落地第一段：合入队列、快检查；`task merge`（登记亲手做的 PR、放行受阻的交付；放行的人判不了这个部门的验收时先等验收）；快检查进程经 `watch.Track` 登记 | — |
| `release` | 完成 | pr 交付方式的落地第二段（Atrium 自己的仓库）：有新版本就自升级、平滑重启；等版本、上线冒烟；`update` | — |
| `watch` | 完成 | 持球与期限表（`Rules`）、巡检循环、卡死判定、服务重启后接管；每轮顺带数上限用量（刚到或超了发 `limit.full`）；持球人判定 `HolderOf`；`top` 与 `/api/top`（末行是三个目标的数） | — |
| `hosts` | 完成 | 机器登记、挑机器（`Pick`，避开工具没装、没登录或「工具+模型」在那台标了不可用的机器）、派到远程（`Launch`/`Stop`/`WaitExit`）、问远程只读查询（`Ask`：只读 git 子命令、读工作目录根下的文件）、ssh 隧道、远程代理；`host add/ls [hN]/edit`（edit 含 `--key` 私钥、`--join` 重新接入、`--rm` 移除）；`agent`、`agent install` 在远程机器上照 `host add` 回执跑，不列在帮助里 | `hosts` `host_runs` |
| `quota` | 完成 | 额度读取、多机合并、富余（`Spares`）；只有服务的后台循环去读（本机自带读取到期就读，OpenQuota 每 5 分钟），读数连同 OpenQuota 的都存 `quota_cache`，派活、网页、命令都只取 `Last`；隔离实例（服务与代理都按数据目录不是缺省的算）不读本机登录与 OpenQuota；`quota`（只读）、`quota set`（改给用户留的份额） | `quota_cache` `quota_settings` |
| `web` | 完成 | 只读网页与只读接口；`map`；点了立刻切页：先画上次数据（没有画页头与骨架），nav 与页面数据并行取，推送来了数据没变的一处不重画；执行者页额度是存下的读数（`quota.Last`），后台读到新数经推送随整页重取；今天页末尾一块是三个目标的数；「等你」= 待拍板的选项单 + 等你验收的交付 + 递到你这层的卡住任务 + 上交到秘书还没确认的事；部门页负责人一行点开是负责人抽屉（执行者组合、负责哪些部门、备忘按行分段，地址 `#oN/aN`，数据就用部门页的）；部门页任务按父子排成树（结束的子任务两件以上折成一行，没派的行尾写「等 tN」），任务抽屉给上级、子任务、要等的、在等它的，来源后的负责人名字点开是他的负责人抽屉；任务抽屉的「经过」是执行者真日志按段解析（`workers.ReadTrace`，与 `task log` 同一份解析）；周期任务在部门页（挂上一轮）、今天页「接下来 7 天」和抽屉（最近 5 轮，`agenda.Rounds`）里看得到，多久一轮与 `schedule ls` 共用 `agenda.Cadence`；代为注册一次性的 `import`（实现在 `importer`） | — |
| `importer` | 完成 | 从旧 TS 库只读导入部门、要点、负责人、备忘、技能、资料、档案、机器 | — |
| `secretary` | 完成 | 把事件注入 Claude Code 会话；`secretary bridge`（`--install-hook` 装 SessionStart hook 与 `ATRIUM_AS=secretary`；`--detach` 起好后输出根部门要点、此刻全景与秘书备忘进会话；执行者环境里 `--detach` 静默退出）、`statusline`（状态栏调用，不列在帮助里） | — |

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

- `cli.Command{Path, Args, Summary, Detail, Flags, Local, Read, Hidden, Run}`（`Detail` 是只在 `--help` 里显示的长说明）；`Run(c *cli.Ctx)` 里用 `c.Arg`、`c.Str`、`c.Opt`（没给为 nil，PATCH 用）、`c.List`（可重复、逗号拆）、`c.Bool`、`c.Int`、`c.MaxArgs`。
- 经服务完成：`c.Call(method, path, body, &out)`。只有 `Local: true` 的命令（start、serve、status、stop）不经服务。
- 回执：`c.Done(result, 人读文字, 下一步命令)`。人读模式打印文字，最后一行「下一步：…」；`--json` 输出 `{"ok":true,"result":…,"next":…}`。每条命令都支持 `--json`。
- 失败：返回 `*api.Error`（见下）；人读模式打印「错误：…」和可执行时的「修正：…」，`--json` 输出 `{"ok":false,"error":{"code","message","next"?}}`。用法错误退出码 2，其余 1。
- 字段校验的报错以参数名开头：`--title: 不能为空`。
- 每条命令标读写：只读（不改服务、本机与数据）的写 `Read: true`，缺省算写。执行者连着用户的服务（`ATRIUM_WORKER=1` 且数据目录是缺省的那个）时写命令一律拒绝；隔离实例（`ATRIUM_DATA` 指向别处）不拦。
- 值以 `--` 开头时写成 `--名字=值`。

### HTTP（`internal/api`）

- 网页这类不走 JSON 信封的处理函数用 `r.Raw(pattern, http.HandlerFunc)`，自己认证、默认拒绝。
- 路由：`r.Handle("POST /api/tasks/{id}/notes", func(q *api.Req) (any, error))`，Go 1.22 写法。`r.Public` 只给 `/health` 与 hosts 自己认机器令牌的 `/api/agent/*`。
- 路径里的短号用 `q.Ref("id", "t")` 取，自动拒绝前缀不对、`..`、`t0` 之类。请求体用 `q.Decode(&v)`（拒绝未知字段，上限 1MB）。
- 错误：`api.Usage`（400）、`api.NotFound`（404）、`api.Conflict`（409）、`api.Limit(next, …)`（409，满了必须给怎么腾地方）、`api.Forbidden`（403）、`api.Unavailable`（503，code `restarting`）；`.WithNext("atrium …")` 附修正命令。其他 error 一律 500 `internal`。请求 context 取消（服务停下或重启）自动变成 `restarting`，客户端据此等新服务后重发。
- 身份：`q.Actor{ID, Kind}`。某类身份的统一权限判定用 `r.AddGuard(kind, func(q) error)`（认证后、处理函数前；负责人的在 `org/leaders`，写接口默认拒绝）。用户令牌得到 `u1/user`；带 `X-Atrium-As: secretary`（命令行取自 `ATRIUM_AS`，`secretary bridge --install-hook` 写进秘书目录的项目设置）得到 `secretary/user`：权限同用户，署名是秘书（纯函数 `api.Sign`，其他身份忽略这个头）。负责人令牌由 org 在自己的 `Routes` 里 `r.AddAuth(func(token) (api.Actor, bool))` 接入，按 `Actor.Kind` 在处理函数里判权限。机器令牌不进全局认证：hosts 把 `/api/agent/*` 用 `Public` 注册、在处理函数里自己认，机器令牌只在这组接口有效。

### 存储（`internal/store`）

- 写一律 `db.Tx(ctx, func(tx *sql.Tx) error)`；只读函数收 `store.Querier`（`*sql.DB` 与 `*sql.Tx` 都行），让调用方决定在不在事务里。
- 一律参数化查询；列表查询都带 `LIMIT`。时间是 Unix 毫秒（`store.Now()`）。可空外键列写 `store.Null(s)`。
- 短号：`store.NextID(ctx, tx, "t")` → `t12`，在插入的同一事务里调；前缀 `t o k a c d m h s`，全局持久不复用。用户固定 `u1`，秘书固定 `secretary`（`identities` 表建库时已插入）。

### 任务状态（`internal/ledger`）

- 状态 `draft todo queued running done failed blocked cancelled`（`draft` 草稿：不派活、不计时、不进巡检，上限表 `drafts`）；交付阶段 `stage`（交付中状态保持 `running`）：核心只有 `"" gate review accept`（关卡、审阅、等验收），其余都是交付方式的落地步骤（`Stage.Landing()`），核心不认先后。pr 的落地步骤 `merge_queue merged released` 由 merge、release 经 `Land` 推进；名字放在 ledger 是因为 watch、web 引用不到 gates。
- 交付方式（gates）不存库，按事实选（纯函数 `pick`）：仓库是本机路径且 origin 不是 GitHub（没有 origin 也算）→ local（在本机查提交，验收后串行合进本机主分支、删任务工作树与分支，冲突交回）；其余有仓库 → pr；只有工作地点（`task add --dir`，本机文件夹，存在 `task_dirs`）→ dir（执行者在原地干、只派本机，关卡看正常收尾，没有落地；同一文件夹的并行由负责人安排，运行时不隔离、不回退）；都没有 → message，工作目录根有 `choice.json` → choice。关卡、审阅过了之后，有落地的（pr、local、choice）遇到部门的验收人（`org.Acceptor`，沿树继承，缺省 `auto`）是 `leader`／`user` 时停在 `accept`，否则直接落地；没有落地的（dir、message，`Delivery.land` 为 nil）验收拦不住什么，直接完成。
- **改状态只经 `ledger.Apply(ctx, db, id, ledger.Event{Kind: …}, actor, note)`**，判定在纯函数 `ledger.Transition`。事件种类与谁发：

| Kind | 从 → 到 | 谁调 |
|---|---|---|
| `Enqueue` | todo/failed/blocked → queued | dispatch（`task run`，同一事务写 `queue` 行；依赖没完成的也进，派活循环等依赖都完成才拉起，依赖失败或取消转受阻；还有没结束的子任务的父任务拒派，报错给该派的子任务） |
| `Start` | queued → running | dispatch（进程已拉起） |
| `ExitOK` / `ExitFail` | running → running/gate ／ failed | dispatch 或 watch |
| `GatePass{NeedReview, AcceptBy, Land}` | gate → review ／ accept ／ 落地步骤 ／ done | gates |
| `ReviewPass{AcceptBy, Land}` | review（running 或 blocked）→ accept ／ 落地步骤 ／ done | gates（审阅阶段受阻后审阅任务重跑出了结论，照结论接着走；`Bounce`、`Block` 同样收 blocked/review） |
| `Accept{Land}` | accept → 落地步骤 ／ done | gates（`task accept`） |
| `Bounce` | gate/review/accept/落地中 → queued；第 3 次 → blocked | gates（含 `task reject`）、merge（次数由 Apply 从经历里数） |
| `Land{Land, Final}` | 落地中 → 下一步（running）／ done | merge（合入）、release（上线） |
| `Deliver{AcceptBy, Land}` | todo/failed/blocked → running/accept ／ running/落地步骤（交回次数重算） | merge（`task merge`） |
| `Block` / `Cancel` / `Set{To}` | 见 `state.go` | watch、命令行 |

- 其他写入：`ledger.SetFacts`（执行者、机器、PR）、`ledger.Record(ctx, q, id, kind, actor, body)`（关卡结论、交回原因等经历）。
- 读取：`Get`、`List`、`Deps`、`Subtree`、`History`、`Ready`（纯）、`Plan`（纯）、`Summarize/Rollup`（纯）。
- 等变化：`ledger.Changed()` 返回一个本进程任何任务写入后就关闭的通道（先取通道再读库）。dispatch 的循环用它，不要定时空转。

### 事件（`internal/events`）

- `events.Emit(ctx, q, events.Event{Kind, Task, Dept, Target, Body, By})`：在引起它的写事务里调用。`By` 是引起它的身份：投递对象就是它时不投（自己做的事不再告诉自己；ledger 的任务事件填操作人）。种类常量写在 `events.go`。
- 级别与去重键缺省按种类取（`events/model.go`）：任务失败、受阻、等验收、非用户本人做的完成、`overdue` 与 `limit.full` 要处理；落地中间步骤（如已合入等发版）与用户本人（u1）做的完成、验收通过只知会（ledger 在正文 `by` 填操作人）；同一投递对象同一任务的 `task.status` 还没取走时合并成最新一条（级别也随最新的，被取代的要处理不再叫人）。`Target` 留空时 events 包调 `org.Recipient(ctx, q, dept)` 取投递对象（部门往上最近负责人，没有投 `secretary`）。上限提醒的「同一件事只提醒一次」（ack 之后、重启之后、超限期间都不重发）不靠事件去重，见 `limit_notices`。
- 任务事件：ledger 在状态变化、落地推进一步（`Land`，如已合入等发版）与转入等验收时经 `events.EmitTask(ctx, q, owner, e)` 发 `task.status`，只投要动手的那一位（纯函数 `events.Route`）。派活人是 `task add` 时的身份（周期任务记建周期任务的人），处理人是 `task add --owner`、缺省派活人，两者记在 `created` 经历里；`task set --owner` 改处理人记一条 `edited` 经历，以最近一次为准（`ledger.PartiesOf`，`task show` 显示）。结果（完成、已合入、上线、失败、受阻）按 `LevelOf` 的级别投处理人：aN 投自己；u1、秘书派的与运行时建的（审阅任务）投部门负责人（由它收父任务、决定是否上交，秘书从上交收到），没有负责人投 `secretary`；运行时建的只有失败、受阻要处理。过程（入队、拉起、交回一次、取消）不投。等验收（正文带 `accept_by`）要处理地投验收人：`user` 投秘书，`leader` 投部门负责人（没有投秘书）。
- 交给负责人的任务：处理人是负责人 aN（不是派活人）、任务待派、没有仓库与工作地点（纯函数 `ledger.Assignee`）。任务新进入这个样子时——`task add --owner aN`、`task set --owner aN`、草稿转待派——经同一段 `handOver` 给这位负责人发要处理的 `task.assigned`，唤醒它在下面拆子任务、派活、审核，子任务都结束后由它收尾（没有单独的「目标」概念，就是一件父任务；进度由子任务汇总）；没写部门落到它负责的那个部门，写了的要在它管辖内（否则拒绝：交过去它动不了）。选项单拍板建的任务按这个方式交给选项所属部门（`choice_option_orgs`，没写是出选项单的部门）往上最近的负责人。

### 一键停机（`internal/pause`）

- 每次自主动作（派活、唤醒、周期任务、合入、发版）前：
  `paused, err := env.Pause.Paused(ctx, pause.Scope{Orgs: org.Ancestors(...), Host: "hN"})`。
- 纯判定 `pause.Paused(active, scope)`：全局、链上任一部门、所在机器任一暂停即停。

### 组织（`internal/org`）

- `org.Ancestors(ctx, q, "oN")` → 顶层到本部门的链；`org.Chain(ctx, q, "oN")` → 要点链（顶层在前，同部门按 pos）；`org.ChainLine(p)` → 派活附的一行「k3（o1）规矩——为什么」。
- 上限表在 `org/limits.go`（`Limits`：会增长的东西 → 上限 → 满了找谁 → 怎么办）；满了一律 `org.Full(key, dept, used)`，计数 `org.Counts(ctx, q, dept)`（网页「6/7」，接口 `GET /api/limits?node=oN`）。
- 上限只挡写入，不截读取：读路径按技术上限 `org.ReadCap`（1000）查，超了报错而不是少给；超了业务上限的（导入的旧数据）照样全部返回，给人看的地方用 `org.Tally`／`org.Over` 标「超限 8/7」，要点链用 `org.PointsOver` 在派活与负责人提示词里加一行。
- 巡检每轮 `org.ScanNotices` 对照 `limit_notices`：刚到或超了且未提醒则 watch 发 `limit.full`（要处理）；部门负责人投 `org.Recipient`，秘书、用户及其余投秘书。回到上限以内才删已提醒，再超再发。判定纯函数 `org.DecideNotice`。
- 派活（dispatch）：`org.SkillPaths(ctx, q, data, task.Skill)` → 提示词附的 SKILL.md 路径；`org.GetSkill` 取优先执行者 `Workers`、交付要查 `Checks`、要的凭据 `Secrets`；`org.SecretEnv(ctx, db, data, task.Org, names)` → 注入执行者的凭据（按部门往上找，找不到报错带修正命令）。
- 负责人唤醒：`org.Overview(ctx, q, data, dept)` 总览全文；`org.Materials(…, MaterialFilter{Org})` 细节清单。
- 权限：`org.CheckReach(ctx, q, actor, dept)`（用户都行；负责人只到自己部门及下属）；`org.CheckUser(actor, 做什么)`（拍板、凭据只有用户）。
- 关卡（gates）：没有仓库也没有工作地点的任务读工作目录根的 `choice.json`（远程经代理），关卡用 `agenda.ParseChoice` 核对（不合法按关卡不过交回），落地时 `agenda.Settle(ctx, db, task, raw)` 登记成选项单。
- 验收人：`org.Acceptor(ctx, q, dept)` → `auto`／`leader`／`user` 与设它的部门；`org.MayAccept(actor, who)`：用户与秘书都能判，负责人不能代用户验收。
- 负责人的执行者组合与 `task run --worker` 同一种写法；登记时经 `org.CheckWorker`（workers 接上的 `Resolve`）核对。
- dispatch 装配时设 `agenda.Enqueue = func(ctx, env, task, actor) error`（即 task run）；周期任务每轮建任务后调它。

### 派活与执行者（`internal/dispatch`、`internal/workers`）

- 执行者标识 `工具[+模型][:强度]`；`workers.Resolve(ctx, q, id)` → 三层叠加后的规则（trust、max_risk、checks、limits、model、端点）与正文。关卡、审阅判执行者用它，不直接读 `worker_profiles`。
- 拉起记录：任务经历 kind `launch`（`workers.Run`：第几次、缘由、执行者、机器、pid、工作目录、日志、风险）；`workers.LastRun` 读。另按 gates 的约定记 `risk`（入队）、`worktree`（拉起）、`result`（退出，最后回复），并 `watch.Track`。退出时（含 watch 转失败后的 `Requeue`）记 `exit`（`workers.Exit`：这次拉起的结果，`workers.OutcomeOf` 按退出信号判）；`workers.Stats` 从 launch、exit、exit_ok／exit_fail、bounce 数每次拉起的结果（之后被交回的记被交回）。
- 日志信号：`workers.Classify(退出码, 日志尾, 现在)` → 额度用尽／临时错误／思考耗尽／起不来（没登录、缺运行环境）／模型名无效；`Adapter.Ended` 判收尾；`workers.WatchSignal` 给 watch。
- 退出后 dispatch 自己收尾：正常 → `ExitOK`（进关卡）；临时错误同一执行者重试 1 次、再换人；思考耗尽换人（至多 2 次，换上的执行者在上一轮那台接不了就另挑机器）；额度用尽、起不来（没登录、缺运行环境，标整个「工具@机器」）、模型名无效经 `workers.MarkOf` 把「工具+模型@机器」标成不可用（额度到恢复时刻，读不出按 4 小时；其余等人 `workers edit --clear`），转失败后重新排队——本机的挑执行者时避开，各台的挑机器时避开；「工具+模型」近 5 次拉起里启动失败（额度、起不来、其他）≥2 次的，挑执行者时排到能接的后面（纯函数 `Shaky`，只排序不排除，`--dry-run` 的推荐理由写出来）；有没送到的捎话按工具续上会话或重派；其余 `ExitFail`。任务已不在 running/""（watch 或人先收了尾）就不动。
- 隔离实例（`config.Paths.Isolated`：数据目录不是缺省的那个）不自己拉起本机真实的模型进程：自动挑执行者（没写 `--worker`，含周期任务、审阅、换人）时内置工具一律不挑，只挑通用命令行执行者；写死 `--worker` 不拦（测试把假 `claude` 放进 PATH 就靠它）。负责人唤醒同理（`ATRIUM_LEADER_WAKE=1` 才开）。
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
release  ─→ service 的 restart 接口、ledger.Apply(Land)、events.Emit(OnlineFailed)
watch    ─→ ledger.Get/Apply、events.Emit(Overdue, LimitFull)、org、platform.KillTree
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

- `task add` 的回执已给出下一步 `atrium task run tN`，`task show`/`task tree` 也会指向它：dispatch 必须提供 `task run`。
- 状态变化只能经 `ledger.Apply`；需要新的事件种类就在 PR 里提，由 ledger 加进 `Transition` 与表驱动测试，不要直接 `UPDATE tasks SET status`。
- 命令总数规格上限 60，`cmd/atrium/main_test.go` 会数；`Hidden` 的（serve、agent、agent install、import、statusline）不计数，由帮助末尾一行点名。
- 负责人令牌的权限表按路由模式判（`leaders.RuleFor`）；`cmd/atrium/routes_test.go` 装上全部模块的真实路由逐条核对，新加写接口要在那张表里写明负责人能不能调。
- 命令组名已占用：`task`、`org`、`point`、`auth`。其余按规格：`leader`、`memo`、`choice`、`skill`、`material`、`schedule`、`secret`（org）、`events`（events）、`host`、`agent`（hosts）、`workers`（workers）、`quota`（quota）、`secretary`（secretary）。单词命令：`top`（watch）、`statusline`（secretary）、`map`、`update`。
