# Atrium 岗位说明

执行者接到 Atrium 的任务时读这里。仓库规范以根目录 `AGENTS.md` 为准；这里只放「在这个仓库干活」的要点和模块地图，按需读对应的模块与专员说明。

## 干活的基本做法

- 在任务给的 worktree 里改，不在主目录改；不要 `git stash`（所有 worktree 共用）。
- 4310 上的安装版服务不要启动、停止或重启；不执行不带隔离 `ATRIUM_PORT` / `ATRIUM_DATA` 的 `atrium` 命令（会自动拉起 4310）。起隔离服务：`env -i HOME=$HOME USER=$USER PATH=$PATH LANG=zh_CN.UTF-8 ATRIUM_PORT=<端口> ATRIUM_DATA=<worktree>/.atrium node bin/atrium.mjs --no-open`，用完同样变量 `stop`。
- 门禁：`npm run check`（构建 + 测试）；本机负载高，测试超时先串行重跑再判断。
- 交付停在 PR：提交、推送、开 PR（正文 `Closes #号` 或 `Refs #号`），等远端 CI；不要合入。
- 汇报里的 PR 号、提交号、CI 结果必须来自刚执行过的命令输出；没做的写「没做」。

## 模块地图

| 模块                            | 说明                                               |
| ------------------------------- | -------------------------------------------------- |
| [runtime](modules/runtime.md)   | 服务进程、任务账本与执行者运行时、身份运行时与投递 |
| [cli](modules/cli.md)           | `atrium` 命令行（与服务同一套数据和身份）          |
| [accounts](modules/accounts.md) | 模型账号、供应商列表、分配                         |
| [web](modules/web.md)           | Web 界面（当前搁置，只修阻塞性问题）               |

## 专员（关注点）

| 专员                     | 什么时候读                                   |
| ------------------------ | -------------------------------------------- |
| [质量](concerns/质量.md) | 每个任务交付前                               |
| [安全](concerns/安全.md) | 改到认证、凭据、路由、文件路径、子进程环境时 |
