# server/plans 约定

规划任务（t275）：大总任务先派一次性执行者读代码与详述出子任务清单，负责的 leader 只拍板采纳。总体规范见根目录 `AGENTS.md`。

- 判定与 IO 分开：清单校验与依赖排序、详述模板、每件子任务的详述、归属部分与建议专员能不能用在 `model.ts`（纯函数，穷举测试）；账、读清单文件、采纳与驳回在 `store.ts`；建好就派（与自动派的开关）在 `runtime.ts`；接口在 `routes.ts`。
- 规划任务是总任务下的帮手子任务（`helper=1`，不让总任务因它变成「有子任务」），`deliver: none`、不带 `repo`（不建 worktree），执行者在任务目录的 `work` 下写 `plan.json`，只在本机跑（`runner.ts` 的 `hostNeed`）。执行者没有 Atrium 的访问，只写文件；任务完成时 `settlePlan` 读它、校验后存进 `task_plans`，好了投 `plan_ready`、不合格投 `plan_failed`（`executors.ts` 收尾分支），不挡任务完成、不加关卡。
- 切小（u1 09-28）：每件标大小（小 / 中 / 大，必填），目标一个执行者半小时左右；没写执行者按大小建议（`SIZE_WORKERS`：小的用快的，中大的用强的）。采纳时把大小与建议执行者记进 `plan_children`，排期自动派这些子任务时先用建议的执行者（`runner.ts` 的 `runPlanned`），派不出去再按候选挑。
- 采纳在一个事务里按依赖先后建子任务（`after` 用刚建的短号，开 `auto`，就绪的由排期巡检派出）：归属部分只能是总任务所在部分或其下（跨部分先上交 cross）；建议的专员请不动的记进详述、不挡采纳；一件建不起来整批回滚。同一份只采纳或驳回一次；总任务上同时只有一份没了结的规划。
- 权限：leader 令牌走 `leaders/scope.ts` 的 `plan` 规则（看总任务或规划任务在不在负责范围），分身认领冲突同 `task` 规则；采纳建的子任务记「谁派的」是这位 leader。
- 选项单拍板后的自动派规划只在默认数据目录的服务缺省开（`autoPlanEnabled`，`ATRIUM_AUTO_PLAN` 显式开关，测试用 `createApp({ plans: { auto } })`）；隔离服务照样可以手动 `plan-for`。测试用 `tests/task-fixture.ts` 的假执行者并写死 `--worker`，不挑本机真实的 CLI。
