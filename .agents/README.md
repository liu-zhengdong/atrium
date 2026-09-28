# 在 Atrium 仓库干活

执行者接到 Atrium 的任务时读这里（派活时原样附进提示词）。仓库规范以根目录 `AGENTS.md` 为准；代码约定写在对应目录旁的 `AGENTS.md`（如 `server/tasks/AGENTS.md`、`cli/AGENTS.md`），改哪里读哪里。部门、章程与能力卡由 Atrium 的组织树管理（`atrium org show <节点>`）；全组织专员名单用 `atrium specialist ls` 查看，不在仓库里维护。

- 在任务给的 worktree 里改，不在主目录改；不要 `git stash`（所有 worktree 共用）。
- 4310 上的安装版服务不要启动、停止或重启；不执行不带隔离 `ATRIUM_PORT` / `ATRIUM_DATA` 的 `atrium` 命令（会被执行者防护拒绝）。起隔离服务：`ATRIUM_PORT=<端口> ATRIUM_DATA=<worktree>/.atrium node bin/atrium.mjs --no-open`，用完以同样变量 `stop`。
- 门禁：`npm run check`（类型检查 + 测试）与 `npm run format:check`；本机负载高，测试超时先串行重跑再判断。
- 全量检查由合入队列在 rebase 后跑一次：优先执行任务 worktree 的 `.agents/check`，没有时执行 `package.json` 的 `check` 脚本；交付关卡不再跑。
- 执行者环境带 `ATRIUM_TEST_CONCURRENCY`（测试并发上限），`npm run check` / `npm test`（`tests/run-tests.ts`）会照它限并发；不要换成 `--test-concurrency=0`，也不要绕开脚本直接 `node --test` 跑全部文件。
- 全量检查交付前跑一次即可，别反复跑；改动过程中只跑相关的测试文件（`npm test -- tests/<文件>.test.ts`，同样限并发、不碰真实额度）。几个执行者同时各跑全量会把整机占满。
- 交付停在 PR：提交、推送、开 PR（正文 `Closes #号` 或 `Refs #号`）；不要合入。运行时会在任务 worktree 排队重跑本地检查，远端 CI 不挡合入。
- 只在远端 CI 失败的偶发用例：当场修复，或标记 skip 并开后续任务；不得让它阻挡合入。
- 汇报里的 PR 号、提交号、检查结果必须来自刚执行过的命令输出；没做的写「没做」。
