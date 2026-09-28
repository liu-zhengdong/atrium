# server/schedules 约定

周期任务（sN，#404 第 1 步）。总体规范见根目录 `AGENTS.md`。

- 判定是纯函数、穷举测试（`plan.ts`）：周期与钟点写法、第一轮、下一轮（`--at` 按本机日历加整天，跨夏令时同一钟点）、停机补跑（`catchUp` 常数步）、到点做什么（`decide`：等、生成、跳过）、恢复从哪一轮开始。时钟与时区偏移由调用方注入，测试不依赖本机时区。
- 账在 `model.ts`：`schedules` 一条一行，AUTOINCREMENT 保证 sN 不复用，删除只标 `removed_at`；`schedule_runs` 记每轮结果（生成 / 跳过 / 失败），每条只留最近 `RUNS_KEPT` 条。到点查询走部分索引 `schedules_due`，空闲时不碰任务表。
- 执行在 `runtime.ts`：`SchedulePump` 等任务运行时接管完（`TaskRunner.ready`）再巡检；建任务与改下一轮、记一笔在同一事务，派发走 `TaskRunner.run`（挑人、排队、闸门照旧，不另加关卡）。`patrol` 走 `startPatrol`（按节点 uses 场景轮换，巡检进程发现问题直接建修复任务）；`research` 建 `deliver none` 的任务，完成时工作目录写了 `choice.json` 就登记成选项单（`server/choices/settle.ts`，调研任务只在本机跑）。建不出或派发失败：挪到下一轮、记失败、投 `schedule_failed` 给该节点最近的 leader（`partRoute`）。
- 登记时在 SAVEPOINT 里试建一轮再回滚，节点、专员、巡检剧本建不出任务的当场报错，不占任务短号。
- 写接口给用户，以及负责该节点或其上级的 leader（`server/leaders/scope.ts` 的 `schedule` 规则，guard 按周期任务所挂节点判范围），leader 能给自己的部门排巡检、调研。
