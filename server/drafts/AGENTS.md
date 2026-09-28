# server/drafts 约定

从仓库起草全景初稿（t186）。总体规范见根目录 `AGENTS.md`。

- 判定与 IO 分开：凭据文件名、详述模板、初稿校验、写入前后对比在 `plan.ts`（纯函数，穷举测试）；读 README、目录、提交在 `materials.ts`；账与写入在 `store.ts`。
- 目标仓库只读：材料用文件读取与 `git --no-optional-locks` 的读命令，不跟仓库里的软链接，不列隐藏与像凭据的文件，文字过 `redact`、origin 去掉内嵌凭据再进提示词。起草任务 `deliver: none`、不带 `repo`（不建 worktree），执行者在任务目录的 `work` 下写 `overview.json`，只在本机跑。
- 执行者没有 Atrium 的访问，只写文件；任务完成时 `settleDraft` 读它、校验后存进 `overview_drafts`，结果并进完成事件。读不到或不合格不挡任务完成、不加关卡。
- 初稿只在用户确认（`map apply`，不带 `--dry-run`）后才写进节点，走 `map edit` 同一条权限与校验；只写人话字段，组成部分不写字段，留给建节点。同一份初稿只写一次。
