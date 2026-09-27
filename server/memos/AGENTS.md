# server/memos 约定

秘书（secretary）与 leader（aN）的备忘和决定记录。总体规范见根目录 `AGENTS.md`。

- 存储在 `store.ts`（`memos`、`decisions` 两张表）：备忘每位一行、覆盖写；leader 的 `leader edit --memo` 也写这里。`org_leaders.memo` 是早先的列，启动时迁过来（`INSERT OR IGNORE`），之后不读不写。
- 判定是纯函数、穷举测试（`decisions.ts`）：字段校验、谁拍板、日期、推翻判定、唤醒附带的条数与字数上限。
- 记录的主人只看 `?as=`（`routes.ts` 的 `ownerOf`）：缺省秘书，aN 须已登记。leader 令牌下 `leaders/guard.ts` 已把 `?as=` 锁成自己，写接口在 `leaders/scope.ts` 登记为 `self`，不另判。
- 决定记录只追加、不删；推翻只改 `superseded_by`，旧的留着可查。和全景「要点」分开：要点给执行者守，决定记录给秘书、leader 自己回看。
