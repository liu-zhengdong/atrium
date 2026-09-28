# server/memos 约定

用户（u1）、秘书（secretary）与 leader（aN）的备忘和决定记录。总体规范见根目录 `AGENTS.md`。

- 存储在 `store.ts`（`memos`、`decisions`、挂节点的 `decision_nodes`、改动记录 `decision_changes`）：备忘每位一行、覆盖写；leader 的 `leader edit --memo` 也写这里。`org_leaders.memo` 是早先的列，启动时迁过来（`INSERT OR IGNORE`），之后不读不写。
- `decisions.node_id` 是早先的单节点列，启动时搬进 `decision_nodes` 后不再读写；秘书那份里 `decided_by='u1'` 的启动时迁到用户那份（`owner='u1'`），新记的由 `recordOf` 直接归过去。
- 判定是纯函数、穷举测试：字段校验、谁拍板、记进谁那份、推翻判定（`decisions.ts`）；摘要选取与字数上限、谁看哪些节点（`digest.ts`）；整理的权限与状态（`curate.ts`）。
- 给人看的地方（`memo show`、唤醒提示词、网页）一律走 `digest.ts` 的摘要，不整份列出；全部走有界分页的 `listDecisions`（按份、按节点及上级、按关键词）。
- 记录的主人只看 `?as=`（`routes.ts` 的 `ownerOf`）：缺省秘书，u1 是用户那份，aN 须已登记。整理接口按短号找决定，leader 令牌只能整理自己那份（`curate.ts` 的 `manageVerdict`）。leader 令牌下 `leaders/guard.ts` 已把 `?as=` 锁成自己，写接口在 `leaders/scope.ts` 登记为 `self`，不另判。
- 决定记录只追加、不删；推翻只改 `superseded_by`，撤销推翻记进 `decision_changes`；沉淀成要点只标 `settled_point`，要点记来源。和全景「要点」分开：要点给执行者守，决定记录给秘书、leader 自己回看。
