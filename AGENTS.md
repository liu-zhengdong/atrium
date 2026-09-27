# Atrium 开发规范

## 目标与职责

Atrium 是 AI 组织的运行底座（方向见讨论 [#260](https://github.com/liu-zhengdong/atrium/discussions/260)）。用户只提目标；固定身份的秘书补成简报，按组织树拆成任务，派给一次性的执行者（编码 CLI + 模型）完成；Atrium 负责任务账本与全局视图、执行者适配器、验收关卡、额度调度、事件投递和服务自身的生命周期。前一代「Pi 长期身份 + 聊天空间」已归档到分支 `legacy/chat-runtime`（标签 `legacy-chat-runtime`），main 不再包含聊天、Web、Pi 身份与模型账号代码。

用户是决策者，不是分派者：下一步做什么由秘书调查、判断后提出，递到用户面前的是几个已经解释清楚的方案和各自的代价。规模增长时按组织树分层收敛汇报，不增加直接向用户汇报的人数。用户保有暂停与停止控制；上下级关系和对用户的推断都不增加权限。

## 组成与职责

| 部分     | 位置                                                                             | 职责                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 服务     | `server/main.ts`、`service*.ts`、`supervisor.ts`、`app.ts`                       | 单实例后台服务、平滑重启与排空、升级失败回滚；只注册服务、任务、组织、额度、事件路由                                                                               |
| 任务账本 | `server/tasks/ledger*.ts`、`state.ts`、`schedule*.ts`                            | 任务树、依赖、状态机（todo / running / done / failed / blocked / cancelled）、就绪判定与自动派发                                                                   |
| 执行者   | `server/tasks/adapters/`、`profiles.ts`、`prepare.ts`、`spawn.ts`、`runner.ts`   | 适配器（claude、codex、opencode、kimi、grok）把「工具 + 模型 + 强度」翻成进程调用；档案（`~/Atrium/workers/`）决定能接什么活、附什么叮嘱、加查什么                 |
| 验收关卡 | `server/tasks/gates.ts`、`facts.ts`、`delivery-gates.ts`、`ci-*.ts`              | 运行时自己查事实（PR、提交、改动规模、CI、评论），按档案 `checks` 判过或不过；不采信执行者自述                                                                     |
| 看门狗   | `watchdog.ts`、`transient*.ts`、`thinking*.ts`、`quota-signal.ts`、`recovery.ts` | 卡死检测、供应商临时错误重试、思考耗尽换人、额度用尽标记、服务重启后接管或判失败                                                                                   |
| 额度     | `server/tasks/quota*.ts`、`openquota.ts`、`budget.ts`                            | 读 OpenQuota 的余量，按富余挑执行者；根章程 `budget.quota_reserve_percent` 给用户留的份额不派                                                                      |
| 事件     | `server/tasks/events.ts`、`event-lease.ts`                                       | 任务完成、失败、受阻、卡死、CI 结果先落库，订阅者 `events wait` 取、`events ack` 确认；租约内不重投                                                                |
| 组织树   | `server/org/`                                                                    | 节点（组织、项目、模块、关注点）、leader、章程与能力卡、硬边界、修订历史；子节点硬边界只能收紧；全景图人话字段（`overview.ts`）、要点（`points.ts`）与任务归属部分 |
| 目标树   | `server/goals/`                                                                  | 旧目标树与迁移：`org migrate-goals` 把 gN 迁为节点章程里的阶段记录、任务回填归属部分，写入后 goal 接口下线（#322）                                                 |
| 全景图   | `server/map/`、`cli/map.ts`                                                      | 全景只读视图（网页与 `map --json` 同一接口）、`map context` 派活附带、`map edit/add`；网页由服务托管（`server/map/web/`，不引入构建链），一次性链接换本机只读会话  |
| 命令行   | `cli/`、`bin/atrium.mjs`                                                         | 统一入口；除启动、`status`、`stop`、`auth status` 外都经服务完成                                                                                                   |

## 实现约束

- 新功能放进职责单一的新模块（参照 `server/tasks/`、`server/org/`）；状态判定写成纯函数、穷举测试，IO 与判定分开。
- 持久化加载与启动路径按产品自愈：单条坏记录挪开并记日志，其余照常启动。旧运行时留下的表不读不写，也不因它们存在而报错。
- SQLite 一律参数化查询、事务、有界分页。事实（PR、CI、改动规模）由运行时查，不从执行者输出里采信。
- 执行者与服务子进程用白名单环境启动（`server/service-env.ts`、`server/tasks/worker-env.ts`），不继承凭据类（`*_API_KEY`、`*_TOKEN`）、身份类（`CLAUDE_CODE_*`、`PI_*`）与 `HERDR_*`；执行者固定带 `ATRIUM_WORKER=1`，命令行据此拒绝操作用户的服务。
- 凭据不进日志、提交、PR、issue 或模型提示词；报错回显的令牌要抹掉。认证放在路由匹配后的统一入口，默认拒绝；路径参数拒绝 `..`、绝对路径、隐藏段和指向目录外的软链接。
- 命令行的主要调用者是 Agent：成功回执最后一行给下一步命令，只有修正明确可执行时才提示修正，字段校验用参数名和中文；读命令支持 `--json`；异步状态提供等待与增量读取（`task wait`、`task log --follow`、`events wait`），不让调用方轮询。新命令接入 `cli/main.ts` 的命令表，`atrium --help` 与 `atrium guide` 由命令表生成，README 同步。
- 用户短号 `u1`，任务 `t1`，目标与里程碑 `g1`（迁移后作节点阶段记录的 id），组织节点 `o1`，要点 `k1`，节点 leader `a1`；短号全局一致、持久、不复用。
- 组织（部门、专员、章程、能力卡）存在 Atrium，改动留修订历史；仓库只留跟着代码走的约定：本文件、`.agents/README.md`（派活时附给执行者）和代码目录旁的 `AGENTS.md`。

## 验证与协作

- `npm run check` 执行类型检查与全部测试；`npm run format:check` 检查格式。本机负载高时测试超时先串行重跑再判断。
- 执行者交付停在 PR；运行时关卡按执行者档案的 `checks` 判定（`finished`、`pr_exists`、`ci`、`file_growth`、`claims_verified`），结论写进任务事件。远端 CI 结果记入账本供参考，不挡合入；通过关卡的 PR 在运行时合入队列串行 rebase、重跑本地检查并按检查过的提交合入，冲突或检查失败交回原执行者，超过两次转卡住。高风险审阅与自动上线分别留在后续步骤。
- 交付须从全局命令走通主要路径（`atrium` → `task add/run/wait` → `org tree` → `quota` → `events wait` → `restart`（在跑执行者由新服务接管）→ `update`），不以命令已安装或分别启动各组件替代。校验与权限至少实测一份破坏输入。
- 开发中的改动在自己的 worktree 验收：4310 上跑的是安装版服务，不要启动、停止或重启它，也不要把全局 `atrium` npm link 到仓库。隔离服务用 `ATRIUM_PORT=<端口> ATRIUM_DATA=<worktree>/.atrium node bin/atrium.mjs`，用完以同样变量 `stop`。合入并发版后用 `atrium update` 走安装后路径。
- 多个执行者共用同一个仓库，`git stash` 在所有 worktree 间共用；不要用 stash，未完成的改动提交到自己的分支。
- 测试显式使用临时目录与假执行者，不依赖开发者主目录中的档案、章程或 OpenQuota。凭据、数据库和服务登记文件不提交。
- issue 只放可以直接动手的事；远期规划、还需要想的内容放 GitHub Discussions（Ideas 分类）。文档、issue、PR 使用中文。
