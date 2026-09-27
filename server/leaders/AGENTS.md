# server/leaders 约定

leader 层：按部分分层汇报，秘书只收要上交的事。总体规范见根目录 `AGENTS.md`。

- 判定是纯函数、穷举测试：投给谁（`route.ts`）、权限边界（`scope.ts`，路由 → 规则 → 作用范围）、唤醒收尾与上交输入与提示词（`wake.ts`）；读库拼事实在 `subscriber.ts`、`guard.ts`，拉进程在 `runtime.ts`。
- 登记在 `org_leaders`（`model.ts`）：aN 短号不复用，新号取登记过的与节点引用过的最大号加一；负责哪些节点只看 `org_nodes.leader`，不另存。指派 aN 前须登记（`org/routes.ts`）。
- 事件：任务没写负责人才按归属部分找 leader（`part_id` → `node_id` → 父任务），只认已登记的 aN，根上的 `u1` 不算；事件 `detail.routed` 写投给谁、为什么。改投递的地方只经 `taskRoute`，不要各处再写 `owner ?? secretary`。
- 权限：leader 令牌每次唤醒签发、只存内存哈希、结束即作废；`guard.ts` 在 onRequest 认令牌、按 `leaderRule` 判路由并锁定 `?as=`，在 preHandler 按作用范围判请求体。新加写接口默认拒绝，要给 leader 用就在 `scope.ts` 的规则表登记并补判定与测试。
- 唤醒：巡检循环按 `wake-rule.ts` 的攒批判定，同一 leader 同时只起一个；结束按 `afterWake` 处理完、释放重试或转交上一层；处理期间内容又被合并更新的事件重新打开（`reopenChanged`），不算失败。服务关闭时停掉在跑的 leader 进程并释放事件，重启后把没收尾的唤醒记失败、收回租约。
- 测试用内存服务与注入的假 leader 进程（`leaders.run`），不依赖本机装了哪些 CLI。
