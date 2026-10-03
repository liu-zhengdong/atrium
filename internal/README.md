# Atrium 包契约

Go 代码怎么分包、包之间怎么调用、并行开发时各自改哪里。设计依据只有规格（Discussion #496）；本文件只写代码层的约定。

## 并行规则

1. **只改自己的目录**：`internal/<包>/`。需要别的包做什么，调它导出的函数；缺函数就在 PR 里说明，由那个包的负责人补，不要顺手改别人的目录。
2. **接入不改 `cmd/atrium/main.go`**：每个包导出 `Module() app.Module`，模块列表已为全部包排好位置。你只在自己包里填 `Commands`、`Routes`、`Run`。
3. **命令注册在自己包里**：`Commands(t *cli.Table)` 里 `t.Group(...)` 声明自己的组（每组只声明一次），`t.Add(...)` 加命令。`task` 组由 ledger 声明，别的包直接往里加 `task run` 之类，不再声明。
4. **共享文件只有三个**，改时只动自己那一段，合并冲突按段解决：
   - `internal/store/schema.sql`：每张表一段，归属见下表。表定义只在这里维护。store.Open 仅对已确认的旧 choices CHECK 做保留数据的定向事务升级；未知结构报错停止，不引入通用迁移。
   - `go.mod` / `go.sum`：依赖使用标准库、`modernc.org/sqlite`、`gopkg.in/yaml.v3`（档案）、`github.com/pelletier/go-toml/v2`（执行者工具配置）。冲突时 `go mod tidy`。
   - `scripts/smoke.sh`：主路径冒烟，加步骤只往末尾 `stop` 之前追加自己的一段。
5. **快检查**：`.agents/check`（gofmt、vet 与 Windows/Linux 交叉编译、build、全部测试、`--help` 冒烟）。端到端：`scripts/smoke.sh`。单包测试超过 30 秒在 PR 里说明。
6. **开发期不写兜底**：不做自愈、旧写法兼容、自动回滚；出错就返回错误停下。

隔离运行：`ATRIUM_DATA=<临时目录> go run ./cmd/atrium start`（端口由系统挑，`status` 里看），用完同样变量 `stop`。缺省数据目录 `~/.atrium-v2`（没设 `ATRIUM_PORT` 时听 4320）；不要碰用户在跑的服务与数据目录。

## 包一览

| 包 | 状态 | 职责 | 拥有的表 |
|---|---|---|---|
| `cmd/atrium` | 完成 | 入口；模块列表；命令表由各包拼成 | — |
| `store` | 完成 | 打开 SQLite（WAL、外键、忙等、`BEGIN IMMEDIATE`）、建表、发短号 | `ids` |
| `config` | 完成 | 数据目录、端口、服务登记文件、用户令牌文件的位置 | — |
| `api` | 完成 | HTTP 信封、错误码、路由（认证在匹配后统一做，默认拒绝）、客户端 | — |
| `cli` | 完成 | 命令表、参数解析、帮助生成、回执（`Done`）、执行者拦截 | — |
| `app` | 完成 | `Module`、`Env` | — |
| `platform` | 完成 | 进程树结束、存活、shell、PATH 查找、服务与执行者白名单环境、凭据文件权限、会话收件地址（Claude Code 的 socket 与 Pi 的 pi-inbox：读登记与口令、逐条投递并读回执） | — |
| `pause` | 完成 | 一键停机的状态与判定 `Paused` | `pauses` |
| `service` | 完成 | start/serve/status/stop/restart/pause/resume/auth rotate；单实例；令牌 | — |
| `ledger` | 完成 | 任务（仓库或工作地点二选一；都没写的，`task run` 派出去时沿用部门的仓库——部门恰有一个才沿用，纯判定 `DeptRepo`、写入 `UseDeptRepo`；运行时自己派的审阅、定时任务不经这里）、父子、依赖、状态机、临时错误重试（`Transient` 判定、`RetryDelays` 定轮数与间隔，`RetryHold` 到期前让出循环，连续失败按最近一次推进后、按操作计，用尽才转受阻；关卡、dispatch、合入队列的循环共用）、就绪、汇总；草稿记的发现带来源（用户纠正／组织发现）与类，来源一行带记录人（任务分派人）的名字（`org.NameOf`），用户本人验收退回、取消任务时 `Apply` 自动记一条用户纠正（纯判定 `Correction`）；三个目标的数（纠正、认可、复发）由纯函数 `Measure` 算、`ReadGoals` 读，top 与网页今天页共用；`task add/ls/show/set/stop/tree/note/wait`（`task tree` 每件标出能派还是在等谁）（`task stop` 即转受阻，分派任务循环结束执行者；`task set --status` 不收 blocked）；在问用户的话（`task_asks`，待派任务最多一条，`SetAsk` 挂上、`RecordTell` 回话或撤回时清掉、离开待派时 `Apply` 删掉） | `tasks` `task_dirs` `task_findings` `task_asks` `task_deps` `task_events` |
| `org` | 完成 | 部门、要点、要点链、验收人（沿树继承）、身份、备忘、技能、资料、凭据、上限表与计数 | `departments` `department_repos` `acceptors` `points` `identities` `memos` `skills` `materials` `material_files` `material_metering` `choices` `choice_options` `choice_option_orgs` `schedules` `secrets` `limit_notices` |
| `org/leaders` | 完成 | 负责人运行时：唤醒（批量收集 30 秒、同一位只起一个、20 分钟上限、连续 2 次没处理完转交上一层）、负责人令牌与统一权限判定、`leader escalate`（`--kind ask` 把问用户的话挂到任务上并投秘书）；拉起经 `leaders.SetLauncher` 由 workers／dispatch 接上；每次用上执行者组合的唤醒落一条唤醒记录（结果按纯判定 `WakeResult`：全确认算交付、没确认完算其他失败、没拉起来算起不来，服务停下不记；模型与用量由 workers 接上的 `WakeUsage` 从这次的日志段取），记录保留 30 天（`WakeRetention`，唤醒循环每小时 `PruneWakes`），`ReadWakes` 按同一保留期给 `workers --quality` | `leader_wakes` |
| `org/agenda` | 完成 | 会生成任务的：选项单（拍板建任务）、定时任务（到点建任务并派发；按周期反复，或指定那天一次、生成后删掉）；与 org 分包是因为要调 ledger（org 被 events 引用，不能再引用 ledger） | 用 org 的 `choices` `choice_options` `choice_option_orgs` `schedules` |
| `events` | 完成 | 事件落库（要处理／知会两级、同一订阅者同一去重键合并）、`events wait/ack`（长轮询、首条后批量收集、15 分钟租约）、订阅者「在听」、清理（每小时删掉最后更新超过 7 天的已确认与知会级事件，要处理且没确认的不删；未结束任务的到期提醒凭据保留到任务结束后再按保留期清理） | `events` |
| `dispatch` | 完成 | 分派任务队列、挑执行者与机器、拉起（每次签发执行者令牌与认证、权限判定）、退出后重试／换人／继续／进入交付检查；`task run`（入队前经 `ledger.UseDeptRepo` 补部门的仓库）、`task tell`（补充说明；`dispatch.Tell` 是补充说明的唯一送达入口，改说明经 `ledger.Tell` 钩子也走它）、`task log`；装配 watch、agenda、gates 的入队钩子、`ledger.Tell` 与 `hosts.AdapterFor` | `queue` |
| `workers` | 完成 | 适配器（8 个内置 + 通用命令行；pi 的会话文件写在这次运行的记录旁 `pi-sessions/`，不落进用户的 `~/.pi`）、工具目录（`ToolCatalog`：内置适配器与档案中的 cli 命令，主机探测共用）、档案三层叠加、日志信号判定、拉起记录 `Run`、经过解析 `Trace`（输出 JSON 事件的工具各自的解析挂在适配器 `Driver.read` 上，按执行者的话分段、步骤写成「工具名 路径」，认不出的事件记 `Unknown`，执行者退出时 dispatch 按纯判定 `ParseFinding` 记一条「执行者日志解析」类的组织发现草稿，同一工具已有没结束的就不再记；纯文本工具逐行原文）、执行者可用性（「工具+模型@机器」不可用标记：`MarkOf` 由退出信号翻成标记、`SyncProbes` 按机器自检结果记上或解除 `MarkProbe`、`Blocked` 给挑执行者与挑机器判；两者都经 `setMark` 这唯一的写入，新出现一条等人处理（until=0）的标记时同一事务里发要处理的 `worker.down` 投秘书，去重键按目标，判定纯函数 `settle`）、按拉起统计（`Stats`：每次拉起一个结果——交付、被交回、额度、起不来、其他失败，按「工具+模型」归、强度不单列；退出记录带工具在日志开头报的实际模型 `ModelOf`，没写模型跟随工具缺省时看它）；`workers`（列、看档案与每次拉起的明细，只读）、`workers edit`（改档案，`--clear` 解除不可用标记，`--wait-subscription` 把已有标记转成等订阅恢复 `MarkSubscription`：照样挡活、不出登录指引，单独 UPDATE 不经 `setMark`、不发 `worker.down`，退出信号不自动判这一类） | `worker_profiles` `worker_marks` |
| `gates` | 完成 | 交付方式（`delivery.go`：pr、local、dir、choice、message 各自的提示词、交付检查、应用；local 的交付检查与应用在 `local.go`）；查事实、判定交付检查结果、审阅（建审阅任务经 `gates.Enqueue` 派出）；等验收与 `task accept/reject`；档案经 `workers.Resolve`；按工作树登记的机器查 git（远程经 `hosts.Ask`），PR 由服务查；与 dispatch 的经历约定见 `gates/records.go` | — |
| `gates/skillcheck` | 完成 | 技能声明的交付检查：技能的 `checks` 写检查名（`article`、`video`），交付检查在本机工作目录里查表自己跑（构建与明暗截图；ffprobe、响度、第一帧不空白、联系表），产物放任务目录、结论与路径记进经历；每项有时限，跑不起来（缺工具、工作目录在远程）转受阻；org 保存技能时经 `Validate` 校验名字 | — |
| `merge` | 完成 | pr 交付方式的应用第一段：合入队列、快检查、等远端 CI 全绿（没上报 checks 的仓库直合）；`task merge`（登记亲手做的 PR、放行受阻的交付；放行的人判不了这个部门的验收时先等验收）；快检查进程经 `watch.Track` 登记 | — |
| `worktree` | 完成 | 本机与代理共用的 Git 工作树删除、残留分支清理与重建基线选择；交出目录前先确认是这次检出（目录还不存在才建成，已有的只校验：空目录、无 .git、git 顶层不是该目录都停下，不修不补）；协调本机合入与回收的串行锁，不判任务状态，不删除任务日志 | — |
| `release` | 完成 | pr 交付方式的应用第二段（Atrium 自己的仓库）：有新版本就自升级、平滑重启；等版本、上线冒烟；`update` | — |
| `release/selfupdate` | 完成 | 服务与远程代理共用的自升级：版本比较与升不升（纯函数 `Upgrade`、`SelfUpgrade`）、发版仓库（`Repo`）、下载本平台二进制校验 SHA256SUMS 后替换自身（`Install`，旧文件留 `.old`）；不引用别的包 | — |
| `watch` | 完成 | 等待对象与处理时限表（`Rules`）、巡检循环、长时间没进展判定、服务重启后继续跟进；每轮顺带数上限用量（刚到或超了发 `limit.full`）；当前等待对象判定 `HolderOf`（负责人等待取任务实际处理负责人，缺省取部门负责人；验收保留部门设置；待派任务挂着在问用户的话时归用户、不计时），同次等待同级别按既有事件键跨收件人去重、第二级复用负责人上报路由；`top` 与 `/api/top`（末行是三个目标的数） | — |
| `hosts` | 完成 | 机器登记、挑机器（`Pick`，避开工具没装、没登录或「工具+模型」在那台标了不可用的机器；离线算排队等它回来，不拒绝）、派到远程（`Launch`/`Stop`/`WaitExit`）、问远程只读查询（`Ask`：只读 git 子命令、读工作目录根下的文件；机器没在领指令时拉起、查询、回收返回 `app.NotNow`，后台下一轮再试，不转受阻；人还在领指令、或拉起/回收的指令已经领走但到时没回执，仍是失败）、ssh 隧道、远程代理（跟服务同版本：hello 回执带服务的版本，代理旧于服务就经 `selfupdate` 换成同一版本、以非 0 退出由系统服务重起，在跑的执行者照跑、重起后重新跟进；同一版本升失败发一次 `online.failed` 给秘书；隔离与开发版不升）；自检（`probe.go`：本机每 5 秒、代理每分钟检查工具目录变化，变化时提前实测；上线时和之后每 10 分钟按 `workers.ToolCatalog` 对装了的每个工具用执行者环境跑一次 `--version`，拉不起来、非 0 退出、超时经 `workers.SyncProbes` 标「工具@机器」不可用并记输出前几行，跑通自动解除，成功输出作为 CLI 版本随机器信息保存并在 `host ls hN` 显示；判定纯函数 `ProbeFault`）；`host add/ls [hN]/edit`（edit 含 `--key` 私钥、`--join` 重新接入、`--rm` 移除）；`agent`、`agent install` 在远程机器上照 `host add` 回执跑，不列在帮助里；代理与服务共用 `ATRIUM_DATA` / `~/.atrium-v2`，`--data` 可显式指定代理目录；`status` 在当前目录查服务或代理进程 | `hosts` `host_runs` |
| `quota` | 完成 | 额度读取、机器/provider 缓存、展示摘要与富余（`Spares`）；只有服务的后台循环去读（本机自带读取到期就读，OpenQuota 每 5 分钟），读数连同 OpenQuota 的都存 `quota_cache`，网页、命令只取 `Last`；调度经 workers 快照，不消费展示摘要；派活避让与重试节奏只认 magpie（`readMagpie` 读网关 `GET /v1/magpie/quotas`，缺省 `127.0.0.1:3425`，`ATRIUM_MAGPIE_URL` 改；每台机器读自己连得到的那个，读不到即未知；判定 `MagpieSpare`），magpie 读数不进 `Last`；隔离实例（服务与代理都按数据目录不是缺省的算）不读本机登录与 OpenQuota，设了 `ATRIUM_MAGPIE_URL` 才读 magpie；`quota`（只读）、`quota set`（改给用户留的份额） | `quota_cache` `quota_settings` |
| `web` | 完成 | 只读网页与只读接口；`map`；点了立刻切页：先画上次数据（没有画页头与骨架），nav 与页面数据并行取，推送来了数据没变的一处不重画；执行者页额度是存下的读数（`quota.Last`），后台读到新数经推送随整页重取；网页负责人引用按完整 aN 身份键显示「名字（短号）」，未知或已删除的合法 aN 显示「未登记负责人（aN）」；其他身份、部门与机器沿用名字语义（web 的 `identityText` 集中呈现，`loadNames/nav.names` 仍只存名字，`orgIndex.name/nameOf` 语义不改；不解析历史正文）；今天页三块：等你、在做、「今天完成 | 接下来 7 天」页签，三个目标只在标题行右侧写近 7 天一行（累计在 `top`）；长列表（今天完成、部门页的草稿与三天内结束）先摆 5 件、其余折成「还有 N 件」；任务抽屉的步骤条按任务给（没有仓库的只到验收），结束了的不画，事实有值才出现；选项单每项收成标题、能得到什么、代价三行，点开看全文；「等你」= 待拍板的选项单 + 等你验收的交付 + 负责人在问你、等回话的任务 + 递到你这层的卡住任务 + 上报到秘书还没确认的事 + 等人处理的执行者不可用标记（从 `worker_marks` 现读，解除就消失；额度用尽、等订阅恢复（kind=subscription，执行者页写「等订阅恢复」）不算）；部门页负责人一行点开是负责人抽屉（执行者组合、负责哪些部门、备忘按行分段，地址 `#oN/aN`，数据就用部门页的）；部门页任务按父子排成树（结束的子任务两件以上折成一行，没派的行尾写「等 tN」），任务抽屉给上级、子任务、要等的、在等它的，来源后的负责人名字点开是他的负责人抽屉；任务抽屉的「经过」是执行者真日志按段解析（`workers.ReadTrace`，与 `task log` 同一份解析）；定时任务在部门页（挂上一轮）、今天页「接下来 7 天」页签和抽屉（最近 5 轮，`agenda.Rounds`）里看得到，多久一轮与 `schedule ls` 共用 `agenda.Cadence`；部门页资料点开是资料抽屉（能放宽到整个主内容区），原文走 `/ui/material/mN`（带 CSP sandbox，pdf 除外），一条资料是一个文件或一个目录，打开渲染正文，按扩展名一处分派：md（相对图片、链接在这条资料的文件里找）、html（沙箱 iframe，从带键的 `/ui/frame/mN-<键>/<相对路径>` 打开，相对路径只在这条资料里找；只有这个地址对沙箱页面放行跨域读，模块脚本、fetch 才能用）、没有正文的图片集列出缩略图、pdf 与图片（浏览器原生）、其它文本等宽、docx 与 xlsx（`static/lib` 里 embed 的前端库，打开时才加载），其余给下载；代为注册一次性的 `import`（实现在 `importer`） | — |
| `importer` | 完成 | 从旧 TS 库只读导入部门、要点、负责人、备忘、技能、资料、档案、机器 | — |
| `secretary` | 完成 | 把事件注入秘书会话（Claude Code，或 Pi：`--pi` 按 pid／名字／会话 id 前缀指名，经 pi-inbox 投递）；`secretary bridge`（`--install-hook` 装 SessionStart hook 与 `ATRIUM_AS=secretary`；`--detach` 起好后输出根部门要点、此刻全景与秘书备忘进会话；`--stop` 停掉让出收件地址，Pi 里 `/secretary off` 用；同时只有一个 bridge 在听，后起的接手、旧的看到登记换人就退出；执行者令牌调不了事件接口，执行者里起不来）、`statusline`（状态栏调用，不列在帮助里） | — |

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
- 命令行不判权限：连服务用哪枚令牌由环境定——带 `ATRIUM_WORKER_TOKEN`、`ATRIUM_SERVER` 且没设 `ATRIUM_DATA`（执行者）连那个地址用执行者令牌；带 `ATRIUM_LEADER_TOKEN`（负责人）用它；其余读数据目录里的用户令牌。能做什么由服务端按令牌判。
- 值以 `--` 开头时写成 `--名字=值`。

### HTTP（`internal/api`）

- 网页这类不走 JSON 信封的处理函数用 `r.Raw(pattern, http.HandlerFunc)`，自己认证、默认拒绝。
- 路由：`r.Handle("POST /api/tasks/{id}/notes", func(q *api.Req) (any, error))`，Go 1.22 写法。`r.Public` 只给 `/health` 与 hosts 自己认机器令牌的 `/api/agent/*`。
- 路径里的短号用 `q.Ref("id", "t")` 取，自动拒绝前缀不对、`..`、`t0` 之类。请求体用 `q.Decode(&v)`（拒绝未知字段，上限 1MB）。
- 错误：`api.Usage`（400）、`api.NotFound`（404）、`api.Conflict`（409）、`api.Limit(next, …)`（409，满了必须给怎么腾地方）、`api.Forbidden`（403）、`api.Unavailable`（503，code `restarting`）；`.WithNext("atrium …")` 附修正命令。其他 error 一律 500 `internal`。请求 context 取消（服务停下或重启）自动变成 `restarting`，客户端据此等新服务后重发。
- 身份：`q.Actor{ID, Kind}`。某类身份的统一权限判定用 `r.AddGuard(kind, func(q) error)`（认证后、处理函数前；负责人的在 `org/leaders`，写接口默认拒绝）。用户令牌得到 `u1/user`；带 `X-Atrium-As: secretary`（命令行取自 `ATRIUM_AS`，`secretary bridge --install-hook` 写进秘书目录的项目设置）得到 `secretary/user`：权限同用户，署名是秘书（纯函数 `api.Sign`，其他身份忽略这个头）。负责人令牌由 org 在自己的 `Routes` 里 `r.AddAuth(func(token) (api.Actor, bool))` 接入，按 `Actor.Kind` 在处理函数里判权限。执行者令牌由 dispatch 每次拉起签发（`wt_任务_第几次_签名`，签名以用户令牌为钥匙，不存库；只在这次拉起还在跑时有效，纯判定 `dispatch.WorkerLive`），得到 `tN 执行者/worker`：只读接口（不含事件、服务、令牌）放行，写只许往本任务所在部门加细节资料（新建，或给本部门的细节资料 mN 加一版；纯判定 `dispatch.WorkerRule`、`WorkerMaterialCheck`），其余拒绝。机器令牌不进全局认证：hosts 把 `/api/agent/*` 用 `Public` 注册、在处理函数里自己认，机器令牌只在这组接口有效。

### 存储（`internal/store`）

- 写一律 `db.Tx(ctx, func(tx *sql.Tx) error)`；只读函数收 `store.Querier`（`*sql.DB` 与 `*sql.Tx` 都行），让调用方决定在不在事务里。
- 一律参数化查询；列表查询都带 `LIMIT`。时间是 Unix 毫秒（`store.Now()`）。可空外键列写 `store.Null(s)`。
- 短号：`store.NextID(ctx, tx, "t")` → `t12`，在插入的同一事务里调；前缀 `t o k a c d m h s`，全局持久不复用。用户固定 `u1`，秘书固定 `secretary`（`identities` 表建库时已插入）。

### 任务状态（`internal/ledger`）

- 状态 `draft todo queued running done failed blocked cancelled`（`draft` 草稿：不分派任务、不计时、不进巡检；要有部门，按部门计上限表 `drafts`，满了提醒该部门负责人）；交付阶段 `stage`（交付中状态保持 `running`）：核心只有 `"" gate review accept`（交付检查、审阅、等验收），其余都是交付方式的应用步骤（`Stage.Landing()`），核心不认先后。pr 的应用步骤 `merge_queue merged released` 由 merge、release 经 `Land` 推进；名字放在 ledger 是因为 watch、web 引用不到 gates。
- 交付方式（gates）不存库，按事实选（纯函数 `pick`）：有仓库但工作树相对基线没有改动（没有新提交也没有未提交的文件，`Facts.Changed`）→ message（装工具、调研这类不改代码的活不要 PR）；仓库是本机路径且 origin 不是 GitHub（没有 origin 也算）→ local（在本机查提交，验收后串行合进本机主分支、删任务工作树与分支，冲突交回）；其余有仓库 → pr；只有工作地点（`task add --dir`，本机文件夹，存在 `task_dirs`）→ dir（执行者在原地干、只派本机，没有应用；同一文件夹的并行由负责人安排，运行时不隔离、不回退）；都没有 → message，工作目录根有 `choice.json` → choice。message 与 dir 没有改动可查，交付检查只凭执行者这一轮最后一行的交付结论判（`ParseEnding`，提示词给审阅任务以外的活都附这条要求）：`交付结论：完成` 才过；`没做成`、`未完成`、`受阻`（含停下等人定）或没写都转受阻交处理人，不交回重跑；审阅任务不看这一行，交付检查改读审阅结论（`reviewEnding`，与原任务同一个 `ParseReview`）：读不出（含这一轮回复为空）交回审阅者重审，按交回计次，原任务继续等审阅、不转受阻。pr 交付在档案 checks 之外另有准入（`admit.go`）：PR 是草稿，或这一轮最后一行是「没做成」「未完成」「受阻」，都不通过，交回并写明怎么改（把 PR 转 ready 或修完再交）。每次拉起后的交付检查，以及进合入队列前（验收通过、审阅通过、`task merge`）都重新查当前 PR 和这一轮回复，不沿用上次的结论。交付检查、审阅过了之后，有应用的（pr、local、choice）遇到部门的验收人（`org.Acceptor`，沿树继承，缺省 `auto`）是 `leader`／`user` 时停在 `accept`，否则直接应用；没有应用的（dir、message，`Delivery.land` 为 nil）验收拦不住什么，直接完成。
- **改状态只经 `ledger.Apply(ctx, db, id, ledger.Event{Kind: …}, actor, note)`**，判定在纯函数 `ledger.Transition`。事件种类与谁发：

| Kind | 从 → 到 | 谁调 |
|---|---|---|
| `Enqueue` | todo/failed/blocked → queued | dispatch（`task run`，同一事务写 `queue` 行；依赖没完成的也进，分派任务循环等依赖都完成才拉起，依赖失败或取消转受阻；还有没结束的子任务的父任务拒派，报错给该派的子任务） |
| `Start` | queued → running | dispatch（进程已拉起） |
| `ExitOK` / `ExitFail` | running → running/gate ／ failed | dispatch 或 watch |
| `GatePass{NeedReview, AcceptBy, Land}` | gate → review ／ accept ／ 应用步骤 ／ done | gates |
| `ReviewPass{AcceptBy, Land}` | review（running 或 blocked）→ accept ／ 应用步骤 ／ done | gates（审阅阶段受阻后审阅任务重跑出了结论，照结论接着走；`Bounce`、`Block` 同样收 blocked/review） |
| `Accept{Land}` | accept → 应用步骤 ／ done | gates（`task accept`） |
| `Bounce` | gate/review/accept/应用中 → queued；第 3 次 → blocked | gates（含 `task reject`）、merge（次数由 Apply 从经历里数） |
| `Land{Land, Final}` | 应用中 → 下一步（running）／ done | merge（合入）、release（上线） |
| `Deliver{AcceptBy, Land}` | todo/failed/blocked → running/accept ／ running/应用步骤（交回次数重算） | merge（`task merge`） |
| `Block` / `Cancel` / `Set{To}` | 见 `state.go` | watch、命令行 |

- 其他写入：`ledger.SetFacts`（执行者、机器、PR）、`ledger.Record(ctx, q, id, kind, actor, body)`（交付检查结论、交回原因等经历）。
- 读取：`Get`、`List`、`Deps`、`Subtree`、`History`、`Ready`（纯）、`Plan`（纯）、`Summarize/Rollup`（纯）。
- 等变化：`ledger.Changed()` 返回一个本进程任何任务写入后就关闭的通道（先取通道再读库）。dispatch 的循环用它，不要定时空转。

### 事件（`internal/events`）

- `events.Emit(ctx, q, events.Event{Kind, Task, Dept, Target, Body, By})`：在引起它的写事务里调用。`By` 是引起它的身份：投递对象就是它时不投（自己做的事不再告诉自己；ledger 的任务事件填操作人）。种类常量写在 `events.go`。
- 级别与去重键缺省按种类取（`events/model.go`）：任务失败、受阻、等验收、非用户本人做的完成、`overdue` 与 `limit.full` 要处理；应用中间步骤（如已合入等发版）与用户本人（u1）做的完成、验收通过只知会（ledger 在正文 `by` 填操作人）；同一投递对象同一任务的 `task.status`、`task.assigned` 还没取走时各自合并成最新一条（级别也随最新的，被取代的要处理不再叫人）。`Target` 留空时 events 包调 `org.Recipient(ctx, q, dept)` 取投递对象（部门往上最近负责人，没有投 `secretary`）。落到 `secretary` 的要处理只收四类（纯函数 `events.SecretaryAct`：等用户拍板、卡住升级——含负责人接不住转来的 `task.assigned`、超时未动、需转告用户），其余（如完成回执、cross 上报）`Emit` 时降为知会；`events.Retarget` 转给秘书时只对本次转交的这几条按同一判定降级，旧库里还没确认的由服务启动时的 `events.Reclassify` 全量收拾；降为知会的上报在网页今天页折起的「上报回执」里可查；积压与注入随之只数这四类；负责人收的不变。`leader.escalate` 的 cross 级别由 `leaders.EscalateLevel` 定：挂未完成任务的是要处理（叫醒上一层负责人），不挂或已完成、已上线的是知会。上限提醒的「同一件事只提醒一次」（ack 之后、重启之后、超限期间都不重发）不靠事件去重，见 `limit_notices`。
- 任务事件：ledger 在状态变化、应用推进一步（`Land`，如已合入等发版）与转入等验收时经 `events.EmitTask(ctx, q, owner, assigner, e)` 发 `task.status`，只投要动手的那一位（纯函数 `events.Route`）。任务分派人是 `task add` 时的身份（定时任务记建定时任务的人），处理人是 `task add --owner`、缺省任务分派人，两者记在 `created` 经历里；`task set --owner` 改处理人记一条 `edited` 经历，以最近一次为准（`ledger.PartiesOf`，`task show` 显示）。负责人自己引起的结果（完成、已合入、上线、失败、受阻）按 `LevelOf` 的级别投任务分派人：u1、秘书投 `secretary`，其他负责人投本人，任务分派人为空或就是处理人不投。其余结果按 `LevelOf` 的级别投处理人：aN 投自己；u1、秘书派的与运行时建的（审阅任务）投部门负责人，没有负责人投 `secretary`；运行时建的只有失败、受阻要处理。过程（入队、拉起、交回一次、取消）不投。等验收（正文带 `accept_by`）要处理地投验收人：`user` 投秘书，`leader` 投部门负责人（没有投秘书）。
- 交给负责人的任务：处理人是负责人 aN（不是任务分派人）、任务待派、没有仓库与工作地点（纯函数 `ledger.Assignee`）。任务新进入这个样子时——`task add --owner aN`、`task set --owner aN`、草稿转待派——经同一段 `handOver` 给这位负责人发要处理的 `task.assigned`，唤醒它在下面拆子任务、分派任务、审核，子任务都结束后由它收尾（没有单独的「目标」概念，就是一件父任务；进度由子任务汇总）；没写部门落到它负责的那个部门，写了的要在它管辖内（否则拒绝：交过去它动不了）。交出去之后的补充说明（`task tell`）经 `ledger.RecordTell` 在同一事务里随 `task.assigned` 发给这位负责人（正文带 `tell`）；`task set --detail` 改了有人在做的任务（纯函数 `ledger.Taken`：交给负责人拆着的，或执行者在跑、还没交付的）后当一次补充说明走 `dispatch.Tell`，负责人本人操作的不投。选项单拍板建的任务按这个方式交给选项所属部门（`choice_option_orgs`，没写是出选项单的部门）往上最近的负责人。

### 一键停机（`internal/pause`）

- 每次自主动作（分派任务、唤醒、定时任务、合入、发版）前：
  `paused, err := env.Pause.Paused(ctx, pause.Scope{Orgs: org.Ancestors(...), Host: "hN"})`。
- 纯判定 `pause.Paused(active, scope)`：全局、链上任一部门、所在机器任一暂停即停。

### 组织（`internal/org`）

- `org.Ancestors(ctx, q, "oN")` → 顶层到本部门的链；`org.Chain(ctx, q, "oN")` → 要点链（顶层在前，同部门按 pos）；`org.ChainLine(p)` → 分派任务附的一行「k3（o1）规矩——为什么」。
- 用户全局原则：`org.Principles()` 现读服务主机 `~/AGENTS.md`，原文拼成一节（文件不存在为空）；执行者（含审阅者）、负责人、秘书的提示词都从这里取，排在部门要点之前。测试把 `HOME`／`USERPROFILE` 指向临时目录。
- 技能索引：`org.SkillIndex(org.Skills(…), except)` 把全部技能拼成一节（名字、一句话，入口 `org.SkillHowTo` 写一次），读的人在哪台机器上都用 `atrium skill ls <名字>` 自取，提示词里不给服务机路径；执行者、负责人、秘书的提示词都附。执行者提示词里 `except` 是任务挂上的技能（它另有「按这份做法干」一节，索引不重复）。
- 上限表在 `org/limits.go`（`Limits`：会增长的东西 → 上限 → 满了找谁 → 怎么办）；满了一律 `org.Full(key, dept, used)`，计数 `org.Counts(ctx, q, dept)`（网页「6/7」，接口 `GET /api/limits?node=oN`）。
- 上限只挡写入，不截读取：读路径按技术上限 `org.ReadCap`（1000）查，超了报错而不是少给；超了业务上限的（导入的旧数据）照样全部返回，给人看的地方用 `org.Tally`／`org.Over` 标「超限 8/7」，要点链用 `org.PointsOver` 在分派任务与负责人提示词里加一行。
- 巡检每轮 `org.ScanNotices` 对照 `limit_notices`：刚到或超了且未提醒则 watch 发 `limit.full`（要处理）；部门负责人投 `org.Recipient`，秘书、用户及其余投秘书。回到上限以内才删已提醒，再超再发。判定纯函数 `org.DecideNotice`。
- 分派任务（dispatch）：`org.GetSkill` 取优先执行者 `Workers`、交付要查 `Checks`、要的凭据 `Secrets`；`org.SecretEnv(ctx, db, data, task.Org, names)` → 注入执行者的凭据（按部门往上找，找不到报错带修正命令）。
- 负责人唤醒：`org.Overview(ctx, q, data, dept)` 总览全文；`org.Materials(…, MaterialFilter{Org})` 细节清单。
- 删部门（`org edit oN --delete [--into oM]`，`org/delete.go`）：存了部门编号的每张表都登记在那里——并入时挪走（`deptMovables`）、挡着要人先处理（`deptBlockers`）或随部门删掉（`DeleteDept` 的语句表）三者之一。新加这类表时同时登记，否则删部门会留下悬空引用。
- 权限：`org.CheckReach(ctx, q, actor, dept)`（用户都行；负责人只到自己部门及下属）；`org.CheckUser(actor, 做什么)`（拍板、凭据只有用户）。
- 交付检查（gates）：没有仓库也没有工作地点的任务读工作目录根的 `choice.json`（远程经代理），交付检查用 `agenda.ParseChoice` 核对（不合法按交付检查未通过交回），应用时 `agenda.Settle(ctx, db, data, task, raw)` 登记成选项单。它与 CLI 经 `AddChoice` 在分配短号、写单和发事件前共用依据校验；每项须有 `mN/相对路径`，使用实例资料目录，经与 `material ls` 相同的 `Material.ReadFile` 读取实际文件，不只查元数据。
- 验收人：`org.Acceptor(ctx, q, dept)` → `auto`／`leader`／`user` 与设它的部门；`org.MayAccept(actor, who)`：用户与秘书都能判，负责人不能代用户验收。
- 负责人的执行者组合与 `task run --worker` 同一种写法；登记时经 `org.CheckWorker`（workers 接上的 `Resolve`）核对。
- dispatch 装配时设 `agenda.Enqueue = func(ctx, env, task, actor) error`（即 task run）；定时任务每轮建任务后调它。挑机器时经 `agenda.LocalOnly(ctx, q, task)` 判这一轮能不能派远程（体验巡检要开只读网页，只派本机）。

### 分派任务与执行者（`internal/dispatch`、`internal/workers`）

- 执行者标识 `工具[+模型][:强度]`；`workers.Resolve(ctx, q, id)` → 三层叠加后的规则（trust、max_risk、checks、model、端点、计费、用量字段）与正文。交付检查、审阅判执行者用它，不直接读 `worker_profiles`。
- 计费规则只在档案：`billing: metered | subscription`；`prices` 含 `currency`（三位大写货币代码）、`input`、`output`、`cache_read`、`cache_write`（每百万 token 单价，可缺项；价格整项覆盖）。计费方式可以在 harness，模型单价在 models，组合差异在 combos。未设置方式的工具金额标「计费方式未设置」，不归到按量或订阅。
- 自动选择先满足 auto、安装/登录/在线、信任、风险、任务要求与额度条件；近期不稳的候选仍排后（`Shaky`：近 5 次启动失败至少 2 次）。合格者先沿用技能偏好、档案 `prefer`（用户的临时调度偏好，`--unset prefer` 解除）与富余排序，再在同一 `prefer` 组内以 `workers.Cheaper` 辅助调整：只有四类单价完整、计费明确的免费/订阅可比较；同币种每一项不贵且至少一项便宜才前移，不猜 token 比例或换汇。未知价格保持原位置，auto=false 不启用，非免费的 metered 不自动分派。价格由当前生效档案维护，不抓计费页、不从模型名或零金额猜免费；现有字段没有窗口有效期，不自动识别限时免费。
- 共用可用性入口：`workers.LoadAvailability(ctx, env)` 只取 `quota.Cached`、既有 marks 与 Reserve；`CheckResolved(r, host)` 纯判定已证实失败组合/机器。工具/模型组合与实际 CLI provider 分开；没有 magpie 绑定的组合额度保持未知，不按 Finger、provider 或套餐名扩大标记。`quota.Last/mergeHosts/Spares` 仅展示摘要，自动选人不消费；未知不证明可用或不同套餐，也不据此全 provider 封禁。t865 在 Launcher 注入侧复用入口与 `dispatch.Pick/NeedTrust`，org 不反向依赖 workers，本轮不接负责人 wake。OpenQuota 与各厂商读取只供展示，不喂避让。
- 用量：内置工具由各自 reader 解析到 `Trace.Usage`；通用命令行执行者在档案写 `usage`（事件 `type` 与点分字段路径），`ExtractUsage` 从日志取读数，不按工具写特判。普通输入不包含缓存读写，输出包含推理 token（工具已包含的不重复计）；工具的 input 含缓存读的（OpenAI 口径，如 trae）在 `usage` 写 `input_includes_cache_read: true`，取数时扣掉。dispatch 在退出经历 `workers.Exit.Usage` 保存当次读数与结算结果；工具非零金额优先，零金额视为没报。工具不报时按单价估算能算的类别：读不到 token、或有 token 没单价的类别记进 `Usage.Missing`，显示「估算，未含…」；token 与单价都没有的类别当作这个执行者没有；一类都算不进不估算；缺读数为 null，不按字数推 token。订阅显示「折合」、按量显示「花费」，按方式与货币分别统计近 `StatWindow` 次有结果拉起的合计、中位和有效读数次数；无金额只显示 token。跨货币只在结算时折一次：非 USD 花费与档案 `prices` 同币种且写了 `prices.usd_rate`（1 单位折合多少 USD）时，`Charge` 把折出的 USD 存进 `Usage.USD`，改汇率不动历史；`Usage.InUSD()` 给 USD 金额（USD 花费即 `Cost`），`workers --quality` 的每次交付花费只用它，有一次折不了就是未知。不自动回填历史。kimi 的 stream-json 不带用量：执行者退出后由拉起它的那台机器（dispatch 本机、hosts 代理）调 `workers.AfterExit`，合计它会话目录里各 agent `wire.jsonl` 的 `usage.record`，以一行 `atrium.usage` 追加到本次日志末尾（读不到也追加一行写明原因），此后结算、重算、远程续传都只读日志。Claude 续接花费扣同会话前次日志累计值，基线缺失则工具花费读不到。展示只读保存的退出结果，不因改档案或日志自动重算；改了 `usage` 或单价要补算历史，用 `workers edit --recount tN`（`workers.Recount`：按当前档案从日志重算，覆盖这件任务各退出记录里的结算结果，每次记一条 `recount` 经历留下旧值；日志不在就报错不动）。
- 拉起记录：任务经历 kind `launch`（`workers.Run`：第几次、缘由、执行者、机器、pid、工作目录、日志、风险）；`workers.LastRun` 读。另按 gates 的约定记 `risk`（入队）、`worktree`（拉起）、`result`（退出，最后回复），并 `watch.Track`。退出时（含 watch 转失败后的 `Requeue`）记 `exit`（`workers.Exit`：这次拉起的结果，`workers.OutcomeOf` 按退出信号判）；`workers.Stats` 从 launch、exit、exit_ok／exit_fail、bounce 数每次拉起的结果（之后被交回的记被交回）。
- 日志信号：`workers.Tail` 读日志末尾的整行（从中间读起时丢掉开头的半行，`LogTail.Cut` 记前面还有内容）；`workers.Classify(退出码, 执行者, 日志尾, 现在)` 按报文认额度用尽／思考耗尽／起不来（没登录、缺运行环境、工具版本过旧）／模型名无效，报文取执行者最后一条出错事件（grok 的报文在 `errors` 数组里）（之后的非 JSON 收尾噪音不算），没有出错事件才取最后的非 JSON 报错行；其余出错退出不按措辞分、按行为判：一步没做（按 `Trace` 数不出一段，且日志没被截断）的算零步骤出错退出，做过事或数不出步骤的算临时错误。继续跟进拿不到退出码的，日志最后是报错收尾才判。`Adapter.Ended` 判收尾（带判出结局的那一行）；`workers.WatchSignal` 给 watch，进程在跑时也会被问，只从那一行收尾事件认额度，其余报错收尾是 error（重试由 dispatch 在退出后按次数判）。
- 额度共同入口：`workers.ResolveExecution` 在实际解析/启动边界提供本轮不可变 `Resolved.QuotaBinding`（组合、机器、magpie provider），不落库；只有档案端点就是 magpie 网关（`quota.ViaMagpie`：与 `ATRIUM_MAGPIE_URL` 或缺省 `127.0.0.1:3425` 协议、主机、端口相同）且模型写成 magpie 路由名 `<provider>/<model>` 才绑定（`MagpieBinding`，provider 取第一段），直连组合保持 nil、额度未知。`LoadAvailability/CheckResolved(r, host, tokens...)` 共用 marks 与 `quota.MagpieSpare`：10 分钟内该机器的成功读数里，provider 下每个账号都有窗口已用 ≥ 100−Reserve 且未到重置才停派；`dispatch.CheckExecution` 在实际启动前重查。magpie 不给 token 分母，`task run --tokens N` 目前没有可比的数，只是未知。额度失败的报文没写恢复时刻时，取 magpie 将满窗口的重置时刻（`Availability.QuotaReset`）；期限只复制给同机器同 provider 的成员（`SamePool`），不解除旧 mark；adopt 没有旧绑定事实，保持组合/机器范围。t865 在 Launcher 注入侧复用 workers 入口与 SamePool，不要求 org 依赖 workers，本任务不改负责人 wake。
- 静默判定：`workers.Silent(trace, delivered)` 要求已收尾、四类 usage 完整为零、无动作/回复/未知输出/已核实产出；零 usage 或 usage 缺失本身不是 quota 证据。dispatch 读取整份 Trace，并仅在疑似空转时有界检查本机工作目录的新写入文件（最多 500 项，读不全视为未知，不判无产出）；远程以日志动作/回复及本次拉起后运行时登记的 PR 为依据，旧 PR 不算本轮产出。Classify 判不出时先看 `workers.ReportedSignal(trace.Error, 现在)`：执行者在消息里报了错、之后没被正常回复盖过（`Trace.Error`，读整份日志得到，如 pi 撞 429 仍以 `agent_settled` 收尾、退出码 0），按 Classify 同一套报文规则认出额度用尽／起不来／模型名无效的直接定性，不看产出扫描（扫描触顶不能否定明确报错）；认不出或没报文的才走静默判定，空转记 nostart；无本轮绑定证据的缓存不能作为 quota 证据。退出码非 0 的额度报文由 Classify 判定。正常零读数有动作/产出不受影响。
- 退出后 dispatch 自己收尾：正常 → `ExitOK`（进入交付检查）；临时错误原执行者重试 1 次，再换人；思考耗尽、额度用尽、起不来、模型名无效、零步骤出错退出直接换人。换人统一至多 2 次（watch 的 `Requeue` 也沿用这轮计数），无候选、无法拉起或额度/启动故障换够后转受阻。`MarkOf` 与 `SetMark` 沿用原标记保留期：额度按恢复时刻、未知按 4 小时；零步骤与静默空转 4 小时；起不来与模型错误等人处理。标记不因重试解除或刷新成新一轮。已试过的组合通常避开；额度失败交给组合/机器 marks 判，另一机器仍可尝试同一组合，但不宣称其账号或套餐不同。标记没有故障时的身份事实，不能自动认定换账号后可解除。有补充说明按工具续接或重派；其余 `ExitFail`。任务被停、进入关卡或已有新一轮时只补退出用量，不重新派活。
- 隔离实例（`config.Paths.Isolated`：数据目录不是缺省的那个）不自己拉起本机真实的模型进程：自动挑执行者（没写 `--worker`，含定时任务、审阅、换人）时内置工具一律不挑，只挑通用命令行执行者；写死 `--worker` 不拦（测试把假 `claude` 放进 PATH 就靠它）。负责人唤醒同理（`ATRIUM_LEADER_WAKE=1` 才开）。
- 别的包要重新派：`dispatch.Enqueue(ctx, env, id, Options{…}, actor)`（即 task run，写队列行与 risk）；watch 经 `Hooks.Requeue`、定时任务经 `agenda.Enqueue`、审阅任务经 `gates.Enqueue`，都在 dispatch 的 Routes 里接上。交回（`gates.Bounce`）只转 queued、不写队列行：dispatch 对没有队列行的 queued 任务沿用上次拉起的执行者、机器（工作目录在那里；接不了就等或转受阻，不换机）、风险与凭据。
- 远程：`workers.Request` 是纯数据，代理拿到后填 `Dir`，把提示词写到自己的任务目录并填本机的 `PromptFile`，经 `workers.LocalTools` 补上本机才知道的工具，再用 `workers.Build(tool, req)` 算出同样的调用；本机拉起同样先过 `LocalTools`。
- 工作树回收：dispatch 生命周期循环统一判 `Reclaimable`，`done`、`cancelled` 在执行者退出后回收；退回、受阻、可直接重派的 `failed` 保留。启动与后续循环按同一规则分页补清全部机器的工作树登记，离线代理上线后再清；回收成功记 `worktree_reclaimed`，不重复处理。回收运行时创建的仓库工作树和本地 `task-tN` 分支，任务临时目录 `tasks/tN/tmp` 同步回收（包括只读文件）；无仓库任务也回收临时目录，工作内容、prompt、run 日志及指定的工作地点保留。重开经原创建入口重建：已推送的任务分支还在就从它继续，否则从默认基线重新开始；终态里未提交、未推送的改动随工作树删除。merge 与 gates 的应用交付结果只负责合入，不再自行清理。早期缺 `host` 的 worktree、launch 按本机登记处理，仍核对本实例任务目录与分支归属；回收开始前重查任务是否仍为可回收终态；缺目录、无效登记或归属不符只记 `loop_error` 并保留目录，不改变任务状态（包括扫描或回收期间重排的新轮次）。沿用 `ledger.EachTask` 的错误去重，单件错误不停止服务、不重复重试。

#### 接入一个执行者

接入时逐项核对，工具能拉起不等于已经接齐：

- **拉起与模型**：在 `workers/adapter.go` 接适配器，或用 `workers/cli.go` 的 `protocol: cli` 档案，核对提示词、模型、强度、端点与凭据环境的传递（叠加与模型映射在 `workers/resolve.go`）。工具没有端点参数、要配置文件才能接时，`Build` 把文件放进 `Launch.Files`（路径在提示词文件旁），本机、远程、负责人唤醒拉起前都经 `Launch.WriteFiles` 写出（pi 的端点扩展见 `workers/pi_endpoint.go`）。档案端点是本机回环地址的组合只派本机（`Resolved.LocalOnly`，`dispatch.hostNeed` 用）。
- **完成与日志**：核对 `workers/signals.go` 的 `Ended` 与 `workers/cli.go` 的完成匹配，并在 `workers/tracers.go`、`workers/trace.go` 验证 JSON 事件解析或纯文本原文，日志样本放 `workers/testdata/`。
- **可用性**：用没登录、额度用尽、模型名无效的日志样本验证 `workers/signals.go` 的 `Classify` 与 `workers/marks.go` 的 `MarkOf`，确认失败能分类并挡住后续分派任务。
- **额度**：`workers.Resolved.Account()` 只给展示的来源类别，不证明账号/共享池。`quota.Cached` 保留每机器/provider 的成功与最近失败读数，成功刷新替换本机旧行，失败不改成功 Finger/ReadAt，机器移除经 `quota.DropHost` 清理；旧指纹键只随正常刷新清理，不能复原已丢关系。既有预算 500 行按机器×provider 核算，每对最多成功/失败两行（250 对满配）；第 501 行写入回滚、读取明确报错，不返回静默截断。OpenQuota 失败保留旧行的原 refreshedAt；pace exit=0 有 stderr 诊断也不认整轮成功，空输出、损坏字段或超限整轮拒绝。magpie 读数（`Reading.Plans`）只存套餐、窗口已用百分比与重置时刻，不存账号名与余额；余额类套餐、带 error 的套餐与不限量窗口跳过，字段坏了或超过 64 套餐/窗口、1 MiB 整份拒绝。新接的执行者想参与避让，档案 `endpoint` 指向 magpie 网关、`model` 写 magpie 的路由名（`<provider>/<model>`）。
- **远程能力**：确认 `workers/tools.go` 的 `ToolCatalog` 包含命令，`hosts/agent.go` 能取得目录并经 `hosts/probe.go` 上报可用性，登录判定在 `hosts/info.go`。
- Claude、Codex 始终带 chrome-devtools MCP，由 MCP 启动 Chrome，使用默认专用资料目录 `~/.cache/chrome-devtools-mcp/chrome-profile`。macOS 可用 `open -na "Google Chrome" --args --user-data-dir="$HOME/.cache/chrome-devtools-mcp/chrome-profile"` 在该目录登录一次，关闭这个专用 Chrome 后再交给执行者；登录可与使用同目录的个人 MCP 共用。MCP 入口以非阻塞文件锁保留专用目录，其他会话立即用 `--isolated` 临时资料目录（没有登录状态），不排队。锁随 MCP 入口进程退出自动释放，服务重启不释放仍活着的会话。Unix 上手动 Chrome 的存活 `SingletonLock` 同样视为占用；Windows 不检测手动 Chrome 的占用，登录后须关闭专用 Chrome。其他执行者仍读个人 MCP 配置。
- **工具集**：执行者会话的工具由 Atrium 给出，不继承用户个人配置中的 MCP；要什么在适配器里显式带上，并在 `workers/computeruse.go` 开头的说明里写清带了什么、各做什么。
- **补充说明与并发**：核对 `workers/adapter.go` 的 `Tell`、会话续接与 `Exclusive`（通用命令行档案在 `workers/cli.go`），确认 `dispatch/actions.go` 的补充说明和 `dispatch/pick.go` 的并发约束适用。
- **自动挑人**：在档案明确 `auto`、`trust`、`max_risk`，用 `workers/profile.go`、`workers/refusal.go` 与 `dispatch/select.go` 核对是否参与自动挑人及能接的风险。

### 子进程（`internal/platform`）

- 子进程只经 `platform.Start(platform.Spec{Path, Args, Dir, Env, Stdout, Stderr, Detached, ManagedTree})` 拉起；`Env` 必填。任务执行者用 `platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()), tempDir)`，`tempDir` 是会话临时目录（本机或代理任务目录下的 `tmp`；负责人是 `leaders/<身份>/tmp`，每次唤醒先清空），统一覆盖 `TMPDIR`、`TMP`、`TEMP`；自检不传临时目录。执行者环境带 `ATRIUM_WORKER=1`，不继承其他 `ATRIUM_*` 与凭据；任务声明的凭据在其后逐个注入，再加 `ATRIUM_SERVER`、`ATRIUM_WORKER_TOKEN`，并经 `platform.SelfOnPath` 把服务（远程是代理）这个二进制排进 PATH 最前。服务与执行者保留环境中的 `GOFLAGS`；`WorkerEnv` 统一追加 `-trimpath`，让本机、远程执行者与合入检查的 Go 编译跨工作树复用缓存。
- 执行者、负责人和自检一律 `ManagedTree: true, Detached: true`：Windows Job 使用 kill-on-close，主体持有不继承的 Job 句柄；服务重启不影响它；结束用 `platform.KillTree(pid)`。拉起后必须 `Wait`（Unix 不 Wait 会留僵尸，`Alive` 会一直报活）。执行者、负责人和自检用 `platform.WaitSession(cmd, tempDir)` 等（自检目录为空）：主体退出后结束原进程组／Job，再结束命令行或环境引用会话临时目录的残留进程（含另开进程组、会话的）；重启后只按 pid 跟进的路径在看到退出后调 `platform.EndSession(pid, tempDir)`。
- 找程序用 `platform.LookPath(name, env)`（按子进程环境的 PATH/PATHEXT；`platform.EnvMap` 在 Windows 上把变量名落成大写）；shell 用 `platform.Shell(cmd)`。Windows 上找到的 `.cmd`/`.bat`（npm 装的 claude.cmd 等）由 `Start` 经 `cmd.exe /d /s /c` 拉起，参数带换行会报错。
- 凭据类文件（用户令牌、`agent.json` 与代理运行记录、部门凭据）只经 `platform.WritePrivateFile` 写：临时文件先收紧成只有本人可读（Windows 为受保护的 DACL，只留本人、SYSTEM、管理员），再改名替换；所在目录用 `platform.PrivateDir`。

### 服务（`internal/service`）

- `atrium`/`start` 拉起 `atrium serve`（服务白名单环境、独立会话、日志写数据目录 `service.log`），等 `/health` 回同一 pid。登记文件 `service.json`（pid、端口、版本）；同一数据目录只允许一个活着的服务。
- `restart`：旧进程拉起新进程（带 `ATRIUM_REPLACE_PID`，新进程等端口放开），再打断长轮询、排空在途请求后退出。`release` 包升级后调 `POST /api/service/restart` 即可。
- 用户令牌：数据目录 `token`（只有本人可读）；`auth rotate` 换新立即生效。

## 谁调谁

```
cmd/atrium ─→ service（serve 装载全部 Module）
各包 Commands ─→ cli ─HTTP→ api.Router ─→ 各包 Routes
dispatch ─→ ledger.Apply/SetFacts、org.Chain/GetSkill/SecretEnv、workers、gates（经历约定）、watch.Track、hosts、quota、pause、platform.Start
gates    ─→ ledger.Apply/Record（查 PR 用 gh，经 platform）
merge    ─→ ledger.Apply、platform（git、gh、快检查）
release  ─→ service 的 restart 接口、ledger.Apply(Land)、events.Emit(OnlineFailed)
release、hosts ─→ release/selfupdate（版本判定、下载替换；hosts 引不到 release：release 经 gates 引 hosts）
watch    ─→ ledger.Get/Apply、events.Emit(Overdue, LimitFull)、org、platform.KillTree
dispatch、merge ─→ watch.Track（拉起执行者或检查后登记 pid、日志、工作树）
dispatch ─→ watch.Use(Hooks{Requeue})：卡住、额度用尽或思考耗尽时重新入队（可换人、标额度）
workers  ─→ watch.Use(Hooks{Signal})：从日志尾部读思考耗尽、额度用尽与收尾；leaders.SetLauncher：负责人唤醒按执行者组合拉起；leaders.WakeUsage、ReadWakes：唤醒的用量与质量统计
events   ─→ org（投递对象 org.Recipient）
org/leaders ─→ org、events（Emit、Retarget）、ledger、platform、worktree.RemoveTemp（清会话临时目录）；workers／dispatch 调 leaders.SetLauncher 接上拉起
secretary、web ─→ 只读：ledger、org、events
ledger   ─→ events.Emit
```

依赖只能朝下：`ledger`、`org`、`events` 不引用 dispatch 及之后的包；有环就是分包错了，停下来在 PR 里提。

## 给第二波的注意

- `task add` 的回执已给出下一步 `atrium task run tN`，`task show`/`task tree` 也会指向它：dispatch 必须提供 `task run`。
- 状态变化只能经 `ledger.Apply`；需要新的事件种类就在 PR 里提，由 ledger 加进 `Transition` 与表驱动测试，不要直接 `UPDATE tasks SET status`。
- 命令总数上限 61（选项单增加独立的作废动作，不能用用户拍板代替，t856 将原上限增加一条），`cmd/atrium/main_test.go` 会数；`Hidden` 的（serve、agent、agent install、import、statusline）不计数，由帮助末尾一行点名。
- 负责人令牌的权限表按路由模式判（`leaders.RuleFor`）；`cmd/atrium/routes_test.go` 装上全部模块的真实路由逐条核对，新加写接口要在那张表里写明负责人能不能调；同一处核对执行者令牌的写接口只有加资料。
- 命令组名已占用：`task`、`org`、`point`、`auth`。其余按规格：`leader`、`memo`、`choice`、`skill`、`material`、`schedule`、`secret`（org）、`events`（events）、`host`、`agent`（hosts）、`workers`（workers）、`quota`（quota）、`secretary`（secretary）。单词命令：`top`（watch）、`statusline`（secretary）、`map`、`update`。
