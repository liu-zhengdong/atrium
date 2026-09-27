# server/tasks 约定

任务账本与执行者运行时。总体规范见根目录 `AGENTS.md`。

- 判定与 IO 分开：状态转移（`state.ts`）、就绪（`schedule.ts`）、关卡（`gates.ts`、`delivery-gates.ts`）、看门狗（`watchdog.ts`）、临时错误与思考耗尽（`transient.ts`、`thinking.ts`）、额度信号（`quota-signal.ts`）都是纯函数，穷举测试；落库、拉进程、查 git/gh 放在各自的 `*-runtime.ts`、`facts.ts`、`spawn.ts`、`runner.ts`。
- 新执行者工具：在 `adapters/` 加一份 `Adapter`（数据 + 把提示词、工作目录、模型、强度变成进程调用的纯函数 `build`），登记到 `adapters/index.ts` 与 `TOOLS`；工具不支持的参数报错，不静默丢弃。
- 新关卡：在 `gates.ts` 加判定分支，只吃 `facts.ts` 收集的事实；档案 `checks` 引用它的名字。关卡结论与原因写进任务事件，不采信执行者自述。
- 执行者档案存数据库（`worker-profiles.ts`：`worker_profiles` 当前版、`worker_profile_revisions` 只增修订），`resolveWorker(标识, db)` 读库；三层叠加时规则取更严：`trust`、`max_risk` 取较低，`limits` 取较小，`checks` 取并集。改档案走 `atrium workers edit`（`worker-profile-edit.ts` 校验），不直接写表。旧目录（`ATRIUM_WORKERS_DIR` 或 `~/Atrium/workers`）只在首次启动导入一次；测试用 `tests/profile-fixture.ts`。
- 执行者进程：独立进程组、白名单环境（`worker-env.ts`）、输出直接写日志文件；服务重启不带走执行者，由 `recovery.ts` 按 pid 接管或判失败。
- 捎话（`task tell`）：判定在 `tell.ts`（送达方式、退出后续上/重派/收尾），账在 `tell-ledger.ts`（task_events kind=tell，送达后原地更新 detail），标准输入写端在 `live-input.ts`，续上与重派在 `tell-runtime.ts`；适配器用 `tell`、`resume`、`sessionOf` 声明能力。
- 请专员（#322）：账在 `concerns.ts`（task_concerns，一位专员一行、本轮审查任务与结论），判定在 `concern-gate.ts`（审查结论、专员关卡合成、`invite_when` 提示、提示词段落），执行在 `concern-runtime.ts`（其余关卡通过后建审查子任务、审查不再跑后记结论并补判父任务）；审查任务自己的结局不单独投递。
- 合入前审阅（`review.ts` 判定、`review-runtime.ts` 编排）：状态只在 `tasks.delivery_stage='reviewing'` 与 `review_task`，巡检从账本续上；审阅结论只认审阅者摘要里最后一个「审阅结论：通过/打回」，打回走合入队列的 `handBack`。专员关卡在前、审阅在后：专员都通过后同样经 `review.admit` 分档。
- 会审（#322）：账在 `councils.ts`（task_councils 议题一行、council_members 每位专员一个意见任务），判定在 `council-gate.ts`（意见立场、汇总解析、结局合成、提示词），编排在 `council-runtime.ts`（意见收齐交 leader 汇总、汇总完成记结论）；议题任务自己的执行者运行就是汇总，意见任务与汇总的完成不单独投递，结局投 `council_decided` / `council_escalated`。
- 事件先落库再投递；同一订阅者、同一去重键的未确认事件合并；订阅者自己发起的动作不投给他本人。
- 测试用 `tests/task-fixture.ts` 的假执行者和临时目录，不依赖本机装了哪些 CLI 或 OpenQuota。
