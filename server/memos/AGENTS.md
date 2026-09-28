# server/memos 约定

秘书（secretary）与 leader（aN）的备忘，和用户拍板的决定记录。总体规范见根目录 `AGENTS.md`。

- 存储在 `store.ts`（`memos`、`decisions`、挂节点的 `decision_nodes`）：备忘每位一行、覆盖写；leader 的 `leader edit --memo` 也写这里。`org_leaders.memo` 是早先的列，启动时迁过来（`INSERT OR IGNORE`），之后不读不写；`decisions.node_id` 是早先的单节点列，启动时搬进 `decision_nodes` 后不再读写。旧库的 `principle`、`settled_*` 列与 `decision_changes` 表不读不写（原则决定已由 `server/imports/rules.ts` 一次并进要点）。
- 决定记录只记用户拍板的事与原因（新记的一律 `owner='u1'`、`decided_by='u1'`），给人回看，不附进任何提示词；要守的规矩写成要点，leader、秘书的处理过程写任务备注。只有用户令牌能记（leader 规则表没登记，默认拒绝）。
- 判定是纯函数、穷举测试（`decisions.ts`）：字段校验、日期、挂节点、检索词。列表走有界分页的 `listDecisions`（按节点及上级、按关键词）。
- 只追加、不删；推翻只改 `superseded_by`（`decision add --supersedes`）。
- 备忘的主人只看 `?as=`（`routes.ts` 的 `ownerOf`）：缺省秘书，u1 是用户，aN 须已登记；leader 令牌下 `leaders/guard.ts` 已把 `?as=` 锁成自己。
