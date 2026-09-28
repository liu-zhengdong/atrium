# server/leaders 约定

leader 层：按部分分层汇报，秘书只收要上交的事。总体规范见根目录 `AGENTS.md`。

- 判定是纯函数、穷举测试：投给谁（`route.ts`）、权限边界（`scope.ts`，路由 → 规则 → 作用范围）、唤醒收尾与上交输入与提示词（`wake.ts`）；读库拼事实在 `subscriber.ts`、`guard.ts`，拉进程在 `runtime.ts`。
- 登记在 `org_leaders`（`model.ts`）：aN 短号不复用，新号取登记过的与节点引用过的最大号加一；负责哪些节点只看 `org_nodes.leader`，不另存。指派 aN 前须登记（`org/routes.ts`）。
- 事件：任务没写负责人才按归属部分找 leader（`part_id` → `node_id` → 父任务），只认已登记的 aN，根上的 `u1` 不算；事件 `detail.routed` 写投给谁、为什么。改投递的地方只经 `taskRoute`，不要各处再写 `owner ?? secretary`。
- 转交：上层 leader 转交下层投给它的上交时不另起一条（判定 `forwardOf`、内容 `escalationDetail`，在 `route.ts`）：沿用原事件去重键投给再上一层，`from`、`reason` 留下层原文，`forwarded` 逐层追加意见，并替它确认原事件，免得唤醒收尾时再转交一份。
- 权限：leader 令牌每次唤醒签发、只存内存哈希、结束即作废；`guard.ts` 在 onRequest 认令牌、按 `leaderRule` 判路由并锁定 `?as=`，在 preHandler 按作用范围判请求体。新加写接口默认拒绝，要给 leader 用就在 `scope.ts` 的规则表登记并补判定与测试。
- 分身（t275）：同一 leader 可同时有几个唤醒，判定在 `clones.ts`（纯函数：分组 `groupOf`、这一轮起哪些 `planClones`、认领冲突 `claimVerdict`、状态一句 `busyLine`、备忘写到哪 `memoTarget`），组的事实在 `clone-facts.ts`（批量查，帮手跟父任务走），在跑的分身记在 `leader_clones`（`wakes.ts`，结束即删，`org_leaders.wake_*` 汇总）。令牌按分身签发（`tokens.ts` 记认领的组与开始时刻），`guard.ts` 拦下动别的分身认领的任务（409），备忘经 `memos/parts.ts` 分段或合并。上限存 `org_leaders.max_clones`（空为缺省 3），只有用户能改。
- 唤醒：巡检循环按 `planClones` 攒批（各候选按自己最早的一条算），日常一个分身、大事一组一个；结束按 `afterWake` 处理完、释放重试或转交上一层；处理期间内容又被合并更新的事件重新打开（`reopenChanged`），不算失败。服务关闭时停掉在跑的 leader 进程并释放事件，重启后把没收尾的唤醒记失败、收回租约。真进程唤醒只在默认数据目录的服务缺省开（`leaderWakeEnabled`，`ATRIUM_LEADER_WAKE` 显式开关）；隔离服务不起真 leader，测试注入 `run` 照常唤醒。
- 测试用内存服务与注入的假 leader 进程（`leaders.run`），不依赖本机装了哪些 CLI。
