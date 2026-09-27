# server/tasks 约定

任务账本与执行者运行时。总体规范见根目录 `AGENTS.md`。

- 判定与 IO 分开：状态转移（`state.ts`）、就绪（`schedule.ts`）、关卡（`gates.ts`、`delivery-gates.ts`）、看门狗（`watchdog.ts`）、临时错误与思考耗尽（`transient.ts`、`thinking.ts`）、额度信号（`quota-signal.ts`）都是纯函数，穷举测试；落库、拉进程、查 git/gh 放在各自的 `*-runtime.ts`、`facts.ts`、`spawn.ts`、`runner.ts`。
- 新执行者工具：在 `adapters/` 加一份 `Adapter`（数据 + 把提示词、工作目录、模型、强度变成进程调用的纯函数 `build`），登记到 `adapters/index.ts` 与 `TOOLS`；工具不支持的参数报错，不静默丢弃。
- 新关卡：在 `gates.ts` 加判定分支，只吃 `facts.ts` 收集的事实；档案 `checks` 引用它的名字。关卡结论与原因写进任务事件，不采信执行者自述。
- 执行者档案存数据库（`worker-profiles.ts`：`worker_profiles` 当前版、`worker_profile_revisions` 只增修订），`resolveWorker(标识, db)` 读库；三层叠加时规则取更严：`trust`、`max_risk` 取较低，`limits` 取较小，`checks` 取并集。改档案走 `atrium workers edit`（`worker-profile-edit.ts` 校验），不直接写表。旧目录（`ATRIUM_WORKERS_DIR`，默认数据目录时缺省 `~/Atrium/workers`，隔离服务不读主目录）只在首次启动导入一次；测试用 `tests/profile-fixture.ts`。
- 执行者进程：经平台层拉起与结束（`server/platform/`：Unix 独立进程组，Windows 按进程树结束）、白名单环境（`worker-env.ts`，Windows 另放行系统变量）、输出直接写日志文件；服务重启不带走执行者，由 `recovery.ts` 按 pid 接管或判失败。
- 捎话（`task tell`）：判定在 `tell.ts`（送达方式、退出后续上/重派/收尾），账在 `tell-ledger.ts`（task_events kind=tell，送达后原地更新 detail），标准输入写端在 `live-input.ts`，续上与重派在 `tell-runtime.ts`；适配器用 `tell`、`resume`、`sessionOf` 声明能力。
- 请专员（#322）：账在 `concerns.ts`（task_concerns，一位专员一行、本轮审查任务与结论），判定在 `concern-gate.ts`（审查结论、专员关卡合成、`invite_when` 提示、提示词段落），执行在 `concern-runtime.ts`（其余关卡通过后建审查子任务、审查不再跑后记结论并补判父任务）；审查任务自己的结局不单独投递。
- 合入前审阅（`review.ts` 判定、`review-runtime.ts` 编排）：状态只在 `tasks.delivery_stage='reviewing'` 与 `review_task`，巡检从账本续上；审阅结论只认审阅者摘要里最后一个「审阅结论：通过/打回」，打回走合入队列的 `handBack`。专员关卡在前、审阅在后：专员都通过后同样经 `review.admit` 分档。
- 会审（#322）：账在 `councils.ts`（task_councils 议题一行、council_members 每位专员一个意见任务），判定在 `council-gate.ts`（意见立场、汇总解析、结局合成、提示词），编排在 `council-runtime.ts`（意见收齐交 leader 汇总、汇总完成记结论）；议题任务自己的执行者运行就是汇总，意见任务与汇总的完成不单独投递，结局投 `council_decided` / `council_escalated`。议题任务取消时会审转「已关闭」（`council-close.ts`，状态转移同一事务里关；巡检补关老库里卡住的），推进按议题分页走完全部未定会审，不被卡住的挤掉。
- 事件先落库再投递；同一订阅者、同一去重键的未确认事件合并；订阅者自己发起的动作不投给他本人。
- 测试用 `tests/task-fixture.ts` 的假执行者和临时目录，不依赖本机装了哪些 CLI 或 OpenQuota。
- 本机减负（#358）：限额读取与判定在 `host-load.ts`（纯函数，采样在 `HostLoad`）；`TaskRunner.run` 与 `Executors.drain` 拉起前过同一道闸门，满了或太忙落库排队、巡检时按入队顺序拉起；本地检查并发由共享的 `sharedLocalChecks` 上限控制；测试并发经 `worker-env.ts` 注入 `ATRIUM_TEST_CONCURRENCY`。太忙看两条线（t113）：Atrium 进程树占的核数（`server/platform/cpu-plan.ts` 判定、`cpu.ts` 按平台采样，巡检时刷新）与整机负载保护线。
- 紧急（t113）：只认 `tasks.urgent`；闸门（`hostGate` 的 `urgent`）、排队先后（`queueOrder`，执行者队列 `queueHeads` 与合入队列 `NEXT_MERGE` 同一规则）、本地检查排位（`checkPlacement`）都在 `host-load.ts`，其余限制（额度保留、trust / max_risk、依赖）不因紧急放宽。
- 闲时（t136）：只认 `tasks.priority`（normal / idle），建任务时按归属部分缺省（管方面的部分或其下为 idle，`priority.ts` 的 `aspectPart`）；判定（档位、先后 `rank`、闲时能不能派 `idleAhead` / `idleAheadAll`）是 `priority.ts` 的纯函数。派发三处同一规则：`TaskRunner.run`（前面有普通任务在等同一类执行者就排队）、`Executors.drain`（队首紧急 → 普通 → 闲时，闲时的再看 `idleAhead`）、`Scheduler.tick`（同一轮先派普通、闲时的最后）。只改排序，不改关卡；合入队列与本地检查不看闲时。
- 任务详述（#355）：内容存 `tasks.brief`（校验与上限在 `brief.ts`），派活、审阅、会审、`task show` 只读库里的内容；`brief_path` 只记来源。运行时自己生成的详述（审阅、专员审查、会审意见与汇总）用 `clipBrief` 截到上限再存。
- 持球人（#355）：未结束任务「球在谁手里」判定在 `holder.ts`（纯函数、穷举测试），事实在 `holder-facts.ts` 取；`top`、`task show` 与状态栏按它显示，不在命令行里另猜。一句话单行、至多 `HOLDER_WIDTH`；合入交回原因由 `mergeShort` 缩成「类别 + 一句」，原因全文只在单个任务视图的 `holder.detail` 给 `task show`。
- 横跨部分（#373）：管方面的部分与要点适用范围在 `server/org/aspects.ts`（`appliedFrom`、`covers` 纯函数）；任务牵涉的部分账在 `also.ts`（task_also 只存显式 `--also`，自动牵涉每次按要点算）；专员归属与可选范围在 `specialist-scope.ts`（`scopeOf`、`inScope` 纯函数），`--by`/`--ask` 校验、`task pick`、`specialist ls --part` 共用；牵涉知会 `publishInvolved`（notice.ts，info 级不叫醒），被牵涉部分的 leader 只能记备注与捎话（leaders/scope.ts `remarkVerdict`）。
