# Atrium 开发规范

## 目标

Atrium 是 AI 组织的运行底座（方向见讨论 [#260](https://github.com/liu-zhengdong/atrium/discussions/260)，规格见 [#496](https://github.com/liu-zhengdong/atrium/discussions/496)）。用户只提目标；固定身份的秘书补成简报，按组织树拆成任务，派给一次性的执行者（编码 CLI + 模型）完成；Atrium 负责任务账本与全局视图、执行者适配、验收关卡、合入与上线、额度调度、事件投递和服务自身的生命周期。

用户是决策者，不是分派者：递到用户面前的是几个解释清楚的方案和各自的代价。规模增长时按组织树分层收敛汇报。用户保有暂停与停止控制；上下级关系和对用户的推断都不增加权限。

## 组成与职责

一个 Go 二进制（`cmd/atrium`），服务、命令行、远程代理都是它。包怎么分、谁调谁、共享文件怎么改见 [internal/README.md](internal/README.md)，改哪个包先读那一节。

| 组成     | 包                                                  | 职责                                                                 |
| -------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| 底座     | `store`、`config`、`api`、`cli`、`app`、`platform`  | SQLite 与短号、数据目录、HTTP 与认证、命令表、模块装配、三平台差异   |
| 服务     | `service`、`pause`                                  | 单实例后台服务、平滑重启、令牌；一键停机                             |
| 任务账本 | `ledger`                                            | 任务树、依赖、状态机（改状态只经 `ledger.Apply`）                    |
| 组织     | `org`、`org/leaders`、`org/agenda`                  | 部门、要点、身份、备忘、技能、资料、凭据、上限；负责人唤醒与权限；选项单、周期任务 |
| 事件     | `events`、`secretary`                               | 事件落库与投递、`events wait/ack`；注入 Claude Code 秘书会话、状态栏 |
| 执行     | `dispatch`、`workers`、`hosts`、`quota`             | 派活队列、挑执行者与机器、适配器与档案、远程代理、额度               |
| 交付     | `gates`、`merge`、`release`、`watch`                | 查事实判关卡与审阅、合入队列、自升级上线、持球与期限、卡死接管       |
| 视图     | `web`                                               | 只读网页与接口（`map`）                                              |
| 导入     | `importer`                                          | 从旧版库一次性只读导入                                               |

## 实现约束

- 新功能放进职责单一的包；状态判定写成纯函数、表驱动测试，IO 与判定分开。
- 开发期不写兜底：不做自愈、旧写法兼容、自动回滚；出错就返回错误停下。
- 进程、shell、路径的平台差异只经 `internal/platform`，不直接写 `/bin/sh`、`kill(-pid)`。
- SQLite 一律参数化查询、事务、有界分页。事实（PR、CI、改动规模）由运行时查，不采信执行者自述。
- 执行者与服务子进程用白名单环境启动，不继承凭据类、身份类变量；派活时声明的凭据（`task run --secret`）在那一刻按名称注入。执行者固定带 `ATRIUM_WORKER=1`，命令行据此拒绝（只读的 `material get` 除外）；负责人进程只加本次唤醒签发的 `ATRIUM_LEADER_TOKEN`。
- 凭据不进日志、提交、PR、issue 或模型提示词。认证在路由匹配后统一做，默认拒绝；路径参数拒绝 `..`、绝对路径与隐藏段。
- 命令行的主要调用者是 Agent：回执最后一行给下一步命令，字段校验以参数名开头，读命令支持 `--json`，异步状态提供等待（`task wait`、`task log --follow`、`events wait`）。`atrium --help` 由命令表生成，README 不抄命令用法。
- 短号全局一致、持久、不复用（`t1`、`o1`、`k1`、`a1`……）。
- 组织（部门、要点、技能）存在 Atrium；仓库只留跟着代码走的约定：本文件、`.agents/README.md`（派活时附给执行者）、`internal/README.md`。

## 验证与协作

- 快检查只有 `.agents/check`（gofmt、vet 与交叉编译、构建、全部测试、`--help` 冒烟）；开发中只跑改动相关的包（`go test ./internal/<包>/`），交付前跑一次 `.agents/check`。合入队列 rebase 后跑同一份。GitHub CI（`ci.yml`）只报不挡；main 坏了先回滚那次合入。
- 主路径端到端：`scripts/smoke.sh`（隔离服务、假执行者、假 gh）。
- 执行者交付停在 PR；关卡、审阅、合入由运行时做。PR 正文写「端到端验证」（隔离实例里跑的命令与输出）和「碰到哪些已有能力」（没有写「无」）。
- 发版：在 main 上推 `vX.Y.Z` 标签，`release.yml` 交叉编译六个平台发到 Release；运行时对自身 `update` + `restart` 后跑只读冒烟，过了记「已上线」。
- 隔离实例：`ATRIUM_DATA=<临时目录> ATRIUM_PORT=<空闲端口> go run ./cmd/atrium start`，用完同样变量 `stop`。不要启停用户在跑的服务（缺省 4320），不读写 `~/.atrium-v2`。
- 不要 `git stash`（所有工作树共用），未完成的改动提交到自己的分支。
- 测试用临时目录、假执行者、假 gh 与本地 bare 仓库；不调真实模型，不读用户主目录，不启真实额度读取。
- issue 只放可以直接动手的事；远期规划放 Discussions（Ideas）。文档、issue、PR、提交用中文。
