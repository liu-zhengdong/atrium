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
atrium task plan                                                # 在跑、就绪、等待中、卡住；上游交付 PR 的，PR 合入才算满足
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
atrium task tell t4 "接口改用 v2"            # 给在跑的执行者捎话；--as 写作者，缺省 u1
atrium top --once                           # 谁在干活、全景图上两层各块的状态与在跑数，下接排期
atrium top --once --depth 3                 # 全景展开三层（旧写法 --goals-depth 照旧接受）
```

`atrium top` 的**全景**段（#322，取代原来的目标段）列出根下两层的各块：状态点（● 有任务在跑、✕ 有任务卡住、○ 空闲）、人话名、子树里在跑／卡住／待办的任务数（按任务的归属部分计，没有归属时按负责节点）和一句「是什么」；`--depth N` 展开至 N 层（1～8），超出行数折叠并提示 `atrium map`。`top --json` 带 `map` 字段（与 `/api/map/tree` 同形），供状态栏读取。

下面是**排期**：就绪的（记账节点、是否 `--auto`、负责人）、依赖链（同一条链按先后缩进，标题给出最长路径）、等待中的（逐项列出在等谁：上游状态、在跑的执行者与已跑时长、上游交付 PR 的合入状态、外部 PR 条件）与因上游失败或取消卡住的；任务行标出归属部分 `oN`（迁移前的旧任务标里程碑 `gN`），只起归类作用的父任务作分组标题。行数超出折叠并提示 `atrium task plan`，`--json` 带 `plan` 字段。

派活时运行时建 worktree（没有仓库时用任务目录下的 `work/`），把标题、详述（`--brief`）、岗位章程、仓库 `.agents/README.md`、执行者档案正文和通用约束拼成提示词，以白名单环境在独立进程组拉起执行者；服务重启不带走执行者，重启后按 pid 接管或判失败。

**捎话**（`task tell`）按工具能力分三档：Claude Code 以 `--input-format stream-json` 拉起、标准输入保持打开，补充作为新的用户消息即时写入，在工具调用边界读入，回显后记为已送达；codex 不能运行中追加，本轮结束后用 `codex exec resume <会话>` 带着补充续上原会话，关卡按续上后的结果判；其余工具停掉、保留工作树、把补充写进提示词重派。档案 `tell: stdin|resume|restart` 可改成工具支持的其他方式。每条捎话记一条 `tell` 事件（作者、时间、送达方式、是否送达），`task show` 与 `top` 可见；任务不在跑时留到下次拉起写进提示词。

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

## 和秘书对话

```bash
atrium chat                 # 缺省打开 opencode 原生界面，接着上次会话；--new 新开，--cwd 指定工作目录
atrium chat --acp           # opencode 改用 Atrium 的 ACP 对话界面；非终端环境自动走 ACP
atrium chat --tool codex    # 用 codex-acp 托管 Codex 秘书会话
atrium chat --acp --allow   # ACP 权限请求自动允许一次（非交互时缺省拒绝）
```

`atrium chat` 按 `--tool` 或 `ATRIUM_SECRETARY_TOOL` 选择秘书工具。opencode 缺省走原生界面：Atrium 启动只监听 127.0.0.1、随机端口和密码的 `opencode serve`，再以 `opencode attach` 打开会话。事件经服务端接口送进同一会话，消息以「【Atrium 事件】」开头，界面弹出「送入事件 #编号」；用户的输入框不受影响。`--acp` 改由 Atrium 以 `opencode acp` 托管；不在终端时也走 ACP。codex 经 `@zed-industries/codex-acp` 使用 ACP；依赖在 `package.json` 和 `package-lock.json` 精确锁定为 `0.16.0`，安装 Atrium 时运行 `npm ci` 安装对应平台二进制。

opencode 两种界面共用 `<ATRIUM_DATA>/secretary/opencode-session.json`，codex 会话编号存在同目录的 `codex-acp.json`；工作目录也一并记录。秘书空闲时，事件按唤醒规则攒批送入；忙时排队、一轮结束后合并送入；连续自动送入 10 次后暂停，等用户发话再继续。送入即记为已送达，秘书处理完用 `atrium events ack` 确认；未确认事件在租约到期后重投。

界面关闭时，服务按相同规则恢复上次会话：codex 执行 `codex exec resume <会话> -`，opencode 执行 `opencode run --session <会话>`，每批处理完即退出。原生界面、ACP 界面与后台恢复共用一把会话锁；有界面时不会另起后台进程。后台恢复只在 `atrium chat` 建过会话后启用，失败会释放事件租约再重试。后台 codex 使用无提示审批与完整文件访问，opencode 使用 `--auto`；秘书仍按原有权限与章程行事。

秘书的 opencode 用独立数据目录（`XDG_DATA_HOME=<ATRIUM_DATA>/secretary/opencode-home`）：每次打开界面或后台恢复前，从用户 opencode 数据目录的 `auth.json` 同步 API key 类条目（`api`、`wellknown`），OAuth 登录（如 openai、xai）不带——提供商的刷新令牌多是一次性的，秘书一刷新，用户自己的登录可能失效；`mcp-auth.json` 在 opencode 里只存 MCP 的 OAuth 状态，同样不带。所用模型的提供商只有 OAuth 登录时，打开界面会提示换用有 API key 的提供商，或在秘书目录里单独登录（`XDG_DATA_HOME=<ATRIUM_DATA>/secretary/opencode-home opencode auth login`，秘书自己的登录不会被同步覆盖）。用户原目录只读不改；配置目录 `~/.config/opencode` 不变，模型、权限与插件设置照常生效。opencode 在同一数据目录并发会死锁，分开后秘书常开也不挡 opencode 执行者（不选互斥：秘书一开就是几个小时，互斥等于期间 opencode 执行者全停）。kimi、Claude Code 后续接入。

## 全景图

同一份数据两张脸：人用网页看，Agent 用命令行读写；改动只走命令行，网页不提供编辑（#322）。

```bash
atrium map                                        # 终端打全景树，并在浏览器打开本机全景网页（一次性登录链接）
atrium map atrium/runtime --json --depth 2        # 一块的人话字段、组成（专员单列）、要点、阶段、在推进的任务、PR 与 issue；与网页同一接口
atrium map context atrium/cli                     # 从根到该块的人话链、组成、现状与本块及上级的要点；--max 字数，缺省 1500
atrium map edit atrium/cli --what 一句话 --uses 场景一 --uses 场景二 --flow 第一步 --now 现状 --next 接下来
atrium map edit atrium/cli --detail 细节.md --reason 补技术细节   # 技术细节即章程正文；给空串清掉一个字段
atrium map add atrium 待办本 --slug ledger --analogy 团队的任务白板 --what 一句话
```

- **网页**：服务自带（`/map`），只听 127.0.0.1、只接受本机连接。`atrium map` 用用户令牌换一个一次性链接（2 分钟内有效、只能用一次），浏览器打开后换成本机会话 cookie（HttpOnly、SameSite=Strict，7 天有效，服务重启后仍有效）；会话只能读全景，写接口和其他接口仍要用户令牌。交互终端里直接打开浏览器，非终端、执行者环境或 `--no-open` 只打印链接。
- **布局**：顶部「现在在推进什么」按归属部分列出在跑与排队的任务（执行者、跑了多久、最近动作）；左边全景树（状态点、在跑数）；右边选中的一块：是什么 → 能用它做什么 → 一件事怎么走完 → 由哪几部分组成 → 要点（人话、为什么、谁定的、守护它的检查，上级要点折叠）→ 现在做到哪与阶段 → 正在推进 → 请了哪些专员 → PR 与 issue → 技术细节（折叠）。窄屏时树收进「全部分块」。
- **实时**：网页订阅 `/api/map/stream`（Server-Sent Events），任务、事件、节点、章程、要点变了推 `changed`，网页只重取并重画变了的区域；另每 30 秒刷新一次执行者的最近动作与时长。
- **派活**：`map context` 的内容自动附进执行者提示词，与「章程要点」同一段、放在最前（任务有归属部分时取归属部分，否则取负责节点）；全景这段不超过 1500 字，按「位置链 > 本块是什么 > 本块要点 > 上级要点 > 上一层是什么 > 现状 > 组成 > 更上层」保留，截了就在末尾给全文命令。
- **权限与修订**：`map edit` 的人话字段（what、uses、flow、alias、analogy、now、next）直接覆盖当前值，不留修订、无需 `--rev`；`--detail` 是章程正文，仍留章程修订，`--rev` 仅用于此。`map add` 的节点创建仍留节点修订，人话字段不留修订。硬边界、份额等组织规矩仍按章程修订。负责部门 leader 或其上级可改（`--as aN`），根只有你能改。

## 组织树

组织、项目、模块、关注点四类节点，短号 `o1`……，也可用路径（如 `atrium/runtime`）。每个节点有 leader、章程与能力卡，每次修改存一版历史；子节点的硬边界只能比父节点更严，显式分配给兄弟的份额之和不得超过父节点的可分配量。根章程只有用户 `u1` 能改，其余由节点 leader 维护（`--as aN`）。

```bash
atrium org import --repo .                        # 预览：根章程 ~/Atrium/charter.md 与仓库 .agents/modules、concerns 下待导入的岗位（导入后仓库里删掉）
atrium org import --repo . --apply                # 写入；重复执行不会重复建
atrium org tree                                   # 节点层级、任务计数、预算份额与约用量
atrium org show atrium/runtime                    # 先讲人话：是什么、能做什么、一件事怎么走完、由哪几部分组成、现状与阶段
atrium org show atrium/runtime --detail           # 再展开细节：章程正文、目标链、硬边界、预算份额、能力卡、手上的任务
atrium org show atrium/runtime --charter --raw > /tmp/章程.md
atrium org edit atrium/runtime --charter /tmp/章程.md --reason 更新目标
atrium org history atrium/runtime                 # 修订；--target charter --rev r2 看字段差异
atrium org add atrium web --kind module --reason 拆模块
atrium task add "改派活" --role atrium/runtime --from atrium/质量   # 任务记到节点；--from 记投任务的关注点
atrium task add "接看板" --part atrium/runtime                      # 任务归属全景图上的哪一部分；task set --part '' 摘下
atrium org link-roles                             # 预览把旧 role 字符串的任务关联到节点；--apply 写入
```

任务的 `--role` 指向组织节点（`o4` 或 `atrium/runtime`），派活时在岗位说明（节点章程正文）后附「章程要点」：本节点与父节点目标、整条链的硬边界（带参数的写最严值）、记账节点，整段不超过 2000 字、边界完整附上。旧写法 `--role runtime` 按任务仓库找挂了该仓库的同名节点；岗位说明只取节点章程，对不上节点时没有岗位说明，不再读仓库文件。`org tree` 显示各节点子树里在做、卡住、待办的任务数。

章程 frontmatter 的 `budget` 分配份额，例如 `budget: { quota: { claude: 30, "*": 10 }, disk: 20, money: 0 }`。`quota` 数值是账号当前周期额度的百分点；具体账号覆盖 `*`。没有显式份额的节点使用父节点未分配给兄弟的共享池。`org show --charter --raw` 可导出并编辑。派活时按账号当前窗口用量估算节点子树的「约用」；份额不足 1 个百分点时换账号，全部不足则将任务置为受阻并通知节点 leader。OpenQuota 数据不可用时记录事件，不按份额拦截。磁盘低于章程下限或节点 worktree 占满磁盘份额时也受阻；档案 `billing: metered` 在钱份额为 0 时不可派。

## 全景图（节点的人话介绍）

组织树每个节点按同一个顺序讲清自己（#322）：**是什么**（一句话，帮谁解决什么问题）→ **能用它做什么**（使用者视角的几个场景）→ **一件事怎么走完**（一条流程）→ **由哪几部分组成**（子节点，各自的人话名与类比，如「待办本——团队的任务白板」）→ **现在做到哪、接下来做什么**（含阶段记录）。技术细节（代码位置、协议、约定）是章程正文，`org show` 默认折叠，`--detail` 才展开。

这些写在章程 frontmatter 里，随章程留修订、按章程权限改（根节点只有你能改）：

```yaml
what: "帮用户把一句话目标变成有人做完、验过的事"
alias: "派活员" # 自己在上层「组成」里的人话名
analogy: "项目经理" # 类比
uses: ["提一句目标，等汇报", "看谁手上有什么"]
flow: ["提目标", "秘书拆任务", "派给执行者", "关卡验收", "汇报"]
now: "命令行跑通闭环"
next: "全景图视图"
stages: # 阶段记录；原目标树的 gN 迁来后 id 沿用 gN
  - id: g5
    result: "节点、章程、边界、份额由机器校验"
    status: achieved # planned / active / achieved / blocked / dropped
    criteria: ["$ npm run check"]
    evidence: ["#287 已合入"]
```

**要点**是这一块必须守住的设计约束，排在「现在做到哪」之前显示。每条写人话一句、为什么、谁定的，可选守护它的检查（测试文件与用例名，或 `$ ` 命令）。要点单独存储、不留修订记录，权限同章程（根节点只有你能改），短号 `k1`……不复用。`org show --json` 的 `points_chain` 按根 → 本节点列出各层要点，供后续派活附进提示词。

```bash
atrium org point-add atrium/runtime "不采信执行者自述" --why "事实由运行时查" --by "u1 09-27" --check "tests/gates.test.ts 用例名"
atrium org point-edit k1 --check ''     # 改一条；--check '' 去掉检查
atrium org point-rm k1                  # 删掉过时的
```

任务用 `--part 节点` 标归属哪一部分（谁负责），与 `--role`（谁来做、记谁的账）分开记；旧写法 `--goal gN` 按目标的负责节点落到归属部分。

### 目标树迁移

原目标树（`g1`……）迁为所在节点的阶段记录，保留结果、验收标准、状态和证据（达成说明与每条验收的最新判定），另记上级与前置：

```bash
atrium org migrate-goals            # 预览：各节点将迁入哪些阶段、哪些任务按目标回填归属部分
atrium org migrate-goals --apply    # 只有你能执行：先整库备份到 <ATRIUM_DATA>/backups/，再一次写入
```

写入时阶段追加进负责节点的章程（留修订，可 `org revert`），挂在 `gN` 上的任务把归属部分填成该目标的负责节点（已有归属的不改），`goals` 表与任务原来的 `goal_id` 不改不删；重复执行只补新出现的，不重复写。写入后 `goal` 命令整组下线，回执指向该目标迁去的节点（`atrium org show oN`）。迁移前 `goal` 命令照旧可用，用法见 `atrium goal --help`。

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
