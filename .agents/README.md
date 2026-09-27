# 在 Atrium 仓库干活

执行者接到 Atrium 的任务时读这里（派活时原样附进提示词）。仓库规范以根目录 `AGENTS.md` 为准；代码约定写在对应目录旁的 `AGENTS.md`（如 `server/tasks/AGENTS.md`、`cli/AGENTS.md`），改哪里读哪里。部门、专员、章程与能力卡由 Atrium 的组织树管理（`atrium org show <节点>`），不在仓库里维护。

- 在任务给的 worktree 里改，不在主目录改；不要 `git stash`（所有 worktree 共用）。
- 4310 上的安装版服务不要启动、停止或重启；不执行不带隔离 `ATRIUM_PORT` / `ATRIUM_DATA` 的 `atrium` 命令（会被执行者防护拒绝）。起隔离服务：`ATRIUM_PORT=<端口> ATRIUM_DATA=<worktree>/.atrium node bin/atrium.mjs`，用完以同样变量 `stop`。
- 门禁：`npm run check`（类型检查 + 测试）与 `npm run format:check`；本机负载高，测试超时先串行重跑再判断。
- 交付停在 PR：提交、推送、开 PR（正文 `Closes #号` 或 `Refs #号`）；不要合入。
- 汇报里的 PR 号、提交号、检查结果必须来自刚执行过的命令输出；没做的写「没做」。
