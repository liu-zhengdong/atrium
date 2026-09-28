# 在 Atrium 仓库干活

执行者接到 Atrium 的任务时读这里（派活时原样附进提示词）。仓库规范以根目录 `AGENTS.md` 为准；代码约定写在对应目录旁的 `AGENTS.md`（如 `server/tasks/AGENTS.md`、`cli/AGENTS.md`），改哪里读哪里。组织树、要点（规矩）与专员由 Atrium 管理（`atrium org show <部分>`、`atrium specialist ls`），不在仓库里维护。

- 在任务给的 worktree 里改，不在主目录改；不要 `git stash`（所有 worktree 共用）。
- 4310 上的安装版服务不要启动、停止或重启；不执行不带隔离 `ATRIUM_PORT` / `ATRIUM_DATA` 的 `atrium` 命令（会被执行者防护拒绝）。起隔离服务：`ATRIUM_PORT=<端口> ATRIUM_DATA=<worktree>/.atrium node bin/atrium.mjs --no-open`，用完以同样变量 `stop`。
- 测试：不要自己跑全量（`npm run check`、不带参数的 `npm test`），全量只由运行时跑。几个执行者同时各跑全量会把整机占满。
  - 开发中和交付前都只跑 `npm run build`（类型检查）、改动相关的测试与 `npm run format:check`。相关测试：`npm test -- tests/a.test.ts tests/b.test.ts` 只跑列出的文件，`npm test -- --changed` 跑与 `origin/main` 相比改动文件相关的测试（按文件名与直接 import 粗匹配，没匹配到的会列出来，自己补上文件名）。
  - 只解 rebase 冲突：跑类型检查和冲突文件相关的测试即可。
  - 测试超时：先看是不是机器太忙，单独重跑超时的那个文件确认。
- 合入检查由合入队列在 rebase 后跑一次，只跑快检查：`.agents/check`（类型检查 + 格式 + `npm test -- --changed` 改动相关的测试 + 固定跑 `tests/service.test.ts`（真实后台服务路径，约 50 秒；按改动挑测试挑不中这类经子进程跑 CLI 的用例，09-28 t232 的 task run 崩溃就是这样漏的）+ `atrium --help` 启动冒烟）；发版不再重跑任何检查，只打包合入时检查过的提交；全量测试不在合入时跑，由 check.yml 在每次推送时跑作体检，挂了就找出是哪次合入弄坏的并开紧急修复（用户 09-28 定，d128）。交付关卡不再跑。主机离线、检查命令找不到（退出码 127，没装依赖）、超时、日志 10 分钟没新输出且还没有失败用例（卡住，只重跑一次）或只挂在 `.agents/timing-sensitive` 登记的时长敏感用例上算「检查没跑成」，运行时自动重跑，不交回你；这个文件从基础分支读，不要为了过关卡往里加用例。
- 检查日志 10 分钟没新输出会被结束：之前已查出的失败用例照样交回你；日志里的「仍在跑：tests/a.test.ts（已 N 秒）」指出哪个测试文件挂住了，先查它有没有没收尾的 Promise、没关的服务或定时器。
- 执行者环境带 `ATRIUM_TEST_CONCURRENCY`（测试并发上限），`npm run check` / `npm test`（`tests/run-tests.ts`）会照它限并发；不要换成 `--test-concurrency=0`，也不要绕开脚本直接 `node --test` 跑全部文件。
- 交付停在 PR：提交、推送、开 PR（正文 `Closes #号` 或 `Refs #号`）；不要合入。运行时会在任务 worktree 排队重跑本地检查，远端 CI 不挡合入。
- 只在远端 CI 失败的偶发用例：当场修复，或标记 skip 并开后续任务；不得让它阻挡合入。
- 汇报里的 PR 号、提交号、检查结果必须来自刚执行过的命令输出；没做的写「没做」。
- 端到端验证在交付前、在隔离实例里跑（见上面起隔离服务的写法），命令与输出原样贴进 PR「端到端验证」一节；不碰 4310 上的服务与用户的电脑。
