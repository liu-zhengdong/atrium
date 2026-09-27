# Atrium · 中庭

**Atrium 是 AI 组织的运行底座。** 用户只提目标；秘书把目标补成简报，按组织树拆成任务，派给一次性的执行者（编码 CLI + 模型，如 `codex+gpt-6-sol:high`）去做。Atrium 负责其余的部分：任务账本与全局视图、执行者适配器、运行时自己查事实的验收关卡、按额度挑人、事件投递，以及服务自身的平滑重启和升级。方向说明见讨论 [#260](https://github.com/liu-zhengdong/atrium/discussions/260)。

前一代「Pi 长期身份 + 聊天空间」已归档到分支 `legacy/chat-runtime`（标签 `legacy-chat-runtime`）；需要旧版可用 `atrium update --to 0.1.30`。旧数据库里的聊天、身份、账号表保留不动，新版本不读不写。

## 安装与启动

需要 Node.js 24+。正式安装从 GitHub 标签打包安装，与 `atrium update` 走同一条路径（把 `x` 换成已发布的补丁号）：

```bash
git clone --depth 1 --branch v0.1.x https://github.com/liu-zhengdong/atrium.git /tmp/atrium-src
cd /tmp/atrium-src && npm pack && npm install -g ./atrium-0.1.x.tgz
```

之后在任意目录：

```bash
atrium               # 启动或复用后台服务，输出地址、PID 与数据目录
atrium status        # 服务状态、地址、数据与日志位置
atrium auth status   # 本机用户认证状态（不启动服务）
atrium stop          # 停止服务，保留数据；在跑的执行者不受影响，下次启动时接管
atrium --help        # 全部命令
atrium guide         # 调用约定、退出码与命令参考（给 Agent 读）
```

服务默认只监听本机 `127.0.0.1:4310`，同一数据目录只运行一份；除启动、`status`、`stop`、`auth status` 外，命令都经服务完成，服务不在就自动拉起。后台日志在数据目录的 `service.log`。

## 任务账本

任务用短号 `t1`、`t2`……，可以挂成树、声明依赖；交付物默认是 PR（`--deliver pr`），也可以是 issue 评论（`comment`，须给 `--issue`）或只看退出情况（`none`）。

```bash
atrium task add "上线任务账本" --repo .                         # 顶层任务 t1；--repo 为工作仓库
atrium task add "表与状态机" --parent t1 --deliver none         # 挂到 t1 下
atrium task add "验收" --parent t1 --after t2 --deliver none    # t2 完成后才就绪；加 --auto 就绪即自动派活
atrium task tree t1                                             # 缩进树：状态、交付物、执行者、PR
atrium task plan                                                # 在跑、就绪、等待中、卡住
atrium task show t2                                             # 详情与最近事件
atrium task note t2 "等上游接口"                                 # 处理备注，最新一条显示为当前说明
atrium task set t3 --status blocked                             # 人工修正状态；running 只能由执行者进入
atrium task ls --status todo                                    # 按状态列；--parent、--after 翻页
atrium task done t3                                             # 人工完成，触发下游排期
```

状态：`todo` → `running` → `done` / `failed` / `blocked`，或 `cancelled`。任一上游失败或取消，整条下游链都不会就绪。

## 派活与执行者

执行者 = 工具 + 模型（+ 思考强度），写作 `工具+模型[:强度]`。支持的工具：`claude`、`codex`、`opencode`、`kimi`、`grok`（须已装在 PATH 上）。

```bash
atrium task add "回复一句话" --deliver none
atrium task run t4 --worker claude          # 派给执行者；不写 --worker 按额度挑，--risk 缺省 low
atrium task wait t4 --timeout 600           # 等到离开 running 或超时
atrium task log t4                          # 执行者日志；--follow 跟到结束，--after 字节偏移续读
atrium task stop t4                         # 仍在跑时停掉执行者（排队中的移出队列）；已结束的报错并给出 task show
atrium top --once                           # 谁在干活：在跑、排队、受阻与刚结束的任务
```

派活时运行时建 worktree（没有仓库时用任务目录下的 `work/`），把标题、详述（`--brief`）、岗位章程、仓库 `.agents/README.md`、执行者档案正文和通用约束拼成提示词，以白名单环境在独立进程组拉起执行者；服务重启不带走执行者，重启后按 pid 接管或判失败。

**执行者档案**在 `~/Atrium/workers/`（`ATRIUM_WORKERS_DIR` 可改），三层叠加：`harness/<工具>.md` ← `models/<模型>.md` ← `combos/<工具>+<模型>.md`。frontmatter 是规则（`trust`、`max_risk`、`checks`、`limits`、`model`），叠加时取更严；正文原样附进提示词。

**验收关卡**：执行者退出后，运行时自己查事实（PR、提交、改动规模、CI、issue 评论），按档案 `checks`（`finished`、`pr_exists`、`ci`、`file_growth`、`claims_verified`）判定 `done` 或 `blocked`，原因写进任务事件，不采信执行者自述。

**看门狗与自愈**：日志、工作区、结构化事件长时间没有进展判卡死；供应商或网络临时错误先同一执行者重试、再换人重派；思考耗尽单次输出直接换人；额度用尽的账号打标记，到点前不再派。

## 额度

```bash
atrium quota                  # 各账号按富余从多到少，标出额度用尽待恢复的；--json 给脚本
atrium quota --clear claude   # 人工解除运行时的额度占用（误判时用），记事件并立即派发排队任务
```

额度来自 [OpenQuota](https://github.com/liu-zhengdong/OpenQuota)（`openquota pace --json`，`ATRIUM_OPENQUOTA_BIN` 可改路径）。组织树根章程导入后，派活按任务所在节点章程链中最严的 `quota_reserve_percent` 保留每个账号的用户额度；导入前仍读 `~/Atrium/charter.md`，缺省 20%。

## 事件

任务完成、失败、受阻、卡死和 CI 结果先落库，订阅者取走、确认后才算处理完；服务重启后仍在。

```bash
atrium events                     # 查看最近事件的送达与确认状态；--before 翻页
atrium events wait --timeout 5    # 取未确认的事件，没有就等；缺省订阅者 secretary
atrium events ack 1               # 确认已处理（编号见 events wait）
```

同一订阅者、同一去重键的未确认事件合并成一条；取走的事件 15 分钟内不重投（`ATRIUM_EVENT_LEASE_MINUTES` 可调），到点仍未确认才重投；自己 `task stop` 引出的事件不投给自己。

## 组织树

组织、项目、模块、关注点四类节点，短号 `o1`……，也可用路径（如 `atrium/runtime`）。每个节点有 leader、章程与能力卡，每次修改存一版历史；子节点的硬边界只能比父节点更严，显式分配给兄弟的份额之和不得超过父节点的可分配量。根章程只有用户 `u1` 能改，其余由节点 leader 维护（`--as aN`）。

```bash
atrium org import --repo .                        # 预览：根章程 ~/Atrium/charter.md 与仓库 .agents/modules、concerns 下待导入的岗位（导入后仓库里删掉）
atrium org import --repo . --apply                # 写入；重复执行不会重复建
atrium org tree                                   # 节点层级、任务计数和显式预算份额
atrium org show atrium/runtime                    # 目标链、硬边界、预算份额、章程与能力卡
atrium org show atrium/runtime --charter --raw > /tmp/章程.md
atrium org edit atrium/runtime --charter /tmp/章程.md --reason 更新目标
atrium org history atrium/runtime                 # 修订；--target charter --rev r2 看字段差异
atrium org add atrium web --kind module --reason 拆模块
atrium task add "改派活" --role atrium/runtime --from atrium/质量   # 任务记到节点；--from 记投任务的关注点
atrium org link-roles                             # 预览把旧 role 字符串的任务关联到节点；--apply 写入
```

任务的 `--role` 指向组织节点（`o4` 或 `atrium/runtime`），派活时在岗位说明（节点章程正文）后附「章程要点」：本节点与父节点目标、整条链的硬边界（带参数的写最严值）、记账节点，整段不超过 2000 字、边界完整附上。旧写法 `--role runtime` 按任务仓库找挂了该仓库的同名节点；岗位说明只取节点章程，对不上节点时没有岗位说明，不再读仓库文件。`org tree` 显示各节点子树里在做、卡住、待办的任务数。

章程 frontmatter 的 `budget` 分配份额，例如 `budget: { quota: { claude: 30, "*": 10 }, disk: 20, money: 0 }`。`quota` 数值是账号当前周期额度的百分点；具体账号覆盖 `*`。没有显式份额的节点使用父节点未分配给兄弟的共享池。`org show --charter --raw` 可导出并编辑。当前只显示份额，不统计节点用量或按份额拦截派活；这两项在第 5 步实现。

## 组织技能

技能是组织资产，存在 Atrium：SKILL.md 与附属文件（最多 32 个、合计 256 KB），frontmatter 的 `name` 与 slug 一致、`description` 必填；每次修改存一版历史，可回退。你、技能 owner 节点或其祖先的 leader 能改；绑定看被绑节点的 leader 权限。

```bash
atrium skill add web-design ./web-design --owner atrium/web --reason 前端约定
atrium skill bind web-design atrium/web          # 派到该节点及子节点的任务都带上
atrium skill show web-design --out /tmp/wd       # 导出，改完写回
atrium skill edit web-design /tmp/wd --rev r1 --reason "用户纠正：按钮间距" --source PR 链接
atrium skill proposals                           # 执行者改了挂载副本生成的待审提议
atrium skill proposal p1                         # 看差异
atrium skill accept p1                           # 写成新修订；skill history web-design 查来源
```

派活时生效集合 = 节点链上绑定的 ∪ 执行者档案 `skills: [slug…]`（总是带）∪ `skills_for: { atrium/web: [slug…] }`（做该节点或其子节点的活时带），去重，每次最多 8 个；档案 `avoid_nodes: [atrium/web]` 让自动挑人避开。技能拷进任务目录，只对这次运行生效，不写用户全局配置、不写仓库工作树：Claude Code 用 `--plugin-dir <任务目录>/skills-plugin`，codex 用 `CODEX_HOME=<任务目录>/codex-home`（登录、配置、AGENTS.md、rules、plugins 和用户自己的 codex 技能软链回 `~/.codex`），opencode 用 `OPENCODE_CONFIG_DIR=<任务目录>/opencode`，其他工具只在提示词里给简介和 SKILL.md 路径。

执行者可以直接改挂载的副本，并把原因写进任务目录的 `skill-notes.md`。收尾时比对副本与挂载时的修订，有差异就生成修订提议（`p1`），记在任务上并通知任务负责人。`skill accept` 写成新修订，作者记任务号、审核人另记；基于的版本已被别的修订更新时按文件三方合并，冲突就拒绝，用 `skill proposal p1 --out 目录` 导出、手工合并后 `skill edit <slug> 目录 --proposal p1 --reason …` 写回。

## 重启与升级

```bash
atrium restart                             # 随时平滑重启，不等空闲；--wait 等结果
atrium update                              # 安装最新 GitHub 标签；--to 0.1.30 指定版本，也可回退
```

`atrium update` 只安装，之后执行 `atrium restart` 才生效。重启随时可做：在跑的执行者各自是独立进程组，不中断，新服务按 pid 接管；重启窗口内退出的由接管后补做收尾（日志、关卡、事件不丢），接管后退出拿不到退出码时按日志收尾结构判正常结束还是出错。重启期间的 `task run`、`task add` 等命令等新服务就绪再发，不排队、不报错。旧版的 `--when-idle` 只打印提示后直接重启，遗留的待空闲重启记录在启动时丢弃。重启时旧服务排空、新服务通过健康检查后才接手；新版本起不来就自动装回原版本并重启，经过记在数据目录的 `supervisor.log`。版本降级须确保数据库迁移与上一版兼容。

每次 main 合入由 CI 加补丁号、打标签并以 PR 标题作版本摘要。

## 命令行约定

命令行的主要调用者是 Agent，完整约定见 `atrium guide`：

- 所有命令支持 `--json`：成功 `{"ok":true,"result":…,"next":…}`，失败 `{"ok":false,"error":{"code","message","candidates"?},"next":…}`；stdout 只写一个 JSON 对象。
- 文本回执最后一行给下一步命令；报错只在修正明确可执行时给出修正命令。
- 执行者进程带 `ATRIUM_WORKER=1`，此时命令行拒绝连接用户的服务，只能显式使用隔离的 `ATRIUM_DATA` 与 `ATRIUM_PORT`。

## 配置与数据

| 环境变量                       | 用途                                                       |
| ------------------------------ | ---------------------------------------------------------- |
| `ATRIUM_PORT`                  | 新启动服务的端口，默认 `4310`；已有服务沿用原端口          |
| `ATRIUM_DATA`                  | 数据目录，默认 `~/.pi/atrium/data/`                        |
| `ATRIUM_WORKERS_DIR`           | 执行者档案目录，默认 `~/Atrium/workers`                    |
| `ATRIUM_OPENQUOTA_BIN`         | OpenQuota 可执行文件，默认 `/Applications/OpenQuota.app/…` |
| `ATRIUM_EVENT_LEASE_MINUTES`   | 取走的事件多久未确认就重投，默认 15                        |
| `ATRIUM_EVENT_BATCH_SECONDS`   | 事件攒批窗口，默认 0（到即取）                             |
| `ATRIUM_QUOTA_UNKNOWN_MINUTES` | 额度用尽但不知道何时恢复时，标记多少分钟，默认 60          |
| `ATRIUM_UPDATE_REPO`           | `atrium update` 的来源，默认 `github:liu-zhengdong/atrium` |

数据目录保存业务数据库、任务目录（worktree 之外的提示词与日志）、用户令牌 `user-token` 与服务登记 `service.sqlite`（均为 `0600`）。服务与执行者只继承白名单环境变量，不继承 `*_API_KEY`、`*_TOKEN` 等凭据；执行者的模型凭据走各 CLI 自己的配置目录。令牌丢失或需要作废时运行 `atrium auth rotate`。凭据、数据库与登记文件不要提交或分享。

## 开发与验证

```bash
npm ci
npm run check          # 类型检查与全部测试
npm run format:check
```

开发时从仓库入口起隔离服务，不碰 4310 上的安装版：

```bash
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium node bin/atrium.mjs
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium node bin/atrium.mjs stop
```

| 目录             | 职责                                                         |
| ---------------- | ------------------------------------------------------------ |
| `bin/`、`cli/`   | 命令入口与各命令实现                                         |
| `server/`        | 服务生命周期、单实例登记、用户认证、重启监督与升级           |
| `server/tasks/`  | 任务账本、执行者适配器与档案、派活、关卡、看门狗、额度、事件 |
| `server/org/`    | 组织树：节点、章程、能力卡、硬边界、修订                     |
| `server/skills/` | 组织技能：修订、绑定、派活挂载、回收提议与三方合并           |
| `tests/`         | 纯函数与接口测试；派活用假执行者和临时仓库                   |

仓库规范见 [AGENTS.md](AGENTS.md)；代码约定写在对应目录的 `AGENTS.md`。
