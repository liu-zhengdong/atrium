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

端口被占时不拉起服务、不建数据目录：占着的是另一份数据的 Atrium，回执给出它的数据目录（`端口 4310 已被另一份数据的 Atrium 占用：数据在 X；要用它请设 ATRIUM_DATA=X`）；是别的程序则提示换 `ATRIUM_PORT`。前一代聊天运行时的数据目录 `~/.pi/atrium/data` 已归档，新一代不读不写；只有它、还没有 `~/.atrium` 时，启动与 `atrium status` 会提示一句。

## 任务账本

任务用短号 `t1`、`t2`……，可以挂成树、声明依赖；交付物默认是 PR（`--deliver pr`），也可以是 issue 评论（`comment`，须给 `--issue`）或只看退出情况（`none`）。

```bash
atrium task add "上线任务账本" --repo .                         # 顶层任务 t1；--repo 为工作仓库
atrium task add "表与状态机" --parent t1 --deliver none         # 挂到 t1 下
atrium task add "验收" --parent t1 --after t2 --deliver none    # t2 完成后才就绪；加 --auto 就绪即自动派活
atrium task add "改登录页" --brief 详述.md                      # 详述建任务时读入存库；--brief - 从标准输入读
atrium task tree t1                                             # 缩进树：状态、交付物、执行者、PR
atrium task plan                                                # 在跑、就绪、等待中、卡住；上游交付 PR 的，PR 合入才算满足，合入 Atrium 自身的要等上线
atrium task show t2                                             # 详情与最近事件
atrium task note t2 "端到端已验证" --verdict ok                 # 秘书对上线结果作一句话标注                                 # 处理备注，最新一条显示为当前说明
atrium task set t3 --status blocked                             # 人工修正状态；running 只能由执行者进入
atrium task ls --status todo                                    # 按状态列；--parent、--after 翻页
atrium task done t3                                             # 人工完成，触发下游排期
```

**详述进库**（#355）：`--brief 文件` 在建任务时把内容读进账本（至多 64 KB，超了报错并提示精简），`--brief -` 从标准输入读；派活、审阅、`task show` 都用库里的内容，原文件之后改了或删了都不影响，`brief_path` 只记来源。`task set tN --brief 文件|-` 换详述，`--brief ''` 清空。升级前只存了路径的旧任务，服务启动时按路径回填一次；读不到的记日志、保留路径，派活时报错并提示 `atrium task set tN --brief 文件`。

状态：`todo` → `running` → `done` / `failed` / `blocked`，或 `cancelled`。PR 任务过交付关卡后另有 `（审阅中）→ 排队合入 → 合入中 → 已合入 → 已上线` 阶段（已上线只用于 Atrium 自身仓库）。任一上游失败或取消，整条下游链都不会就绪。上游合入的是会自动上线的仓库（Atrium 自身）时，下游等它「已上线」才就绪（新命令上线后才用得上），`task plan` 与状态栏写「等 tN 上线」，上线失败按上游卡住处理；不自动上线的仓库（如 OpenQuota）合入即满足。

## 派活与执行者

执行者 = 工具 + 模型（+ 思考强度），写作 `工具+模型[:强度]`。支持的工具：`claude`、`codex`、`opencode`、`kimi`、`grok`、`agy`、`cursor`（须已装在 PATH 上）。

`agy` 是 Antigravity CLI，一个账号（额度账号 `antigravity`）下有 Gemini、Claude、GPT-OSS 几族模型，`agy models` 列出可选的。缺省模型 `claude-opus-4-6-thinking`。强度按 agy 自己的规矩：gemini 模型名自带强度的直接用（`agy+gemini-3.8-flash-high`），也可写基名加强度（`agy+gemini-3.8-flash:high`，与 `--effort high` 等价）；模型名已带强度再写不同的 `:强度`、或给 `claude-*`、`gpt-oss-*` 写强度（它们不接受 `--effort`），派活时直接报错，不静默丢弃。agy 支持运行中捎话（`--input-format stream-json`，补充排在本轮之后另起一轮）与按会话续上（`--conversation`）。

`cursor` 缺省模型 `auto`（Cursor 自己挑），额度账号 `cursor`（经 OpenQuota 读）；强度写进模型名后缀，`cursor+gpt-5.3-codex:high` 交给 `--model gpt-5.3-codex-high`，`auto` 不能指定强度。新接入没有交付记录，档案没写时按 `trust: unknown`、`max_risk: low`（只接低风险、合入前另派审阅），交付记录攒够后用 `atrium workers edit harness/cursor` 升。

```bash
atrium task add "回复一句话" --deliver none
atrium task pick t4                         # 看候选（只读）：能不能接、账号额度、正忙、交付记录，最上面是推荐与理由
atrium task run t4 --worker claude          # 派给执行者；不写 --worker 按额度挑，--risk 缺省 low
atrium task run t5 --urgent                  # 紧急：跳过本机负载限制，排队插到最前
atrium task run t7 --worker agy             # 还在排队的任务：改派执行者（及 --risk），排队位置不变；新执行者空着就立刻拉起
atrium task set t6 --priority 普通           # 管方面的部分开的任务缺省「闲时」，改成普通照常排
atrium task run t6 --host h2                 # 派到指定的执行机器；不写在能接的主机里挑最空的
atrium task wait t4 --timeout 600           # PR 任务等到合入或卡住；其他任务等到离开 running
atrium task log t4                          # 执行者日志；--follow 跟到结束，--after 字节偏移续读
atrium task stop t4                         # 停执行者或合入队列；合入中会在安全点停下
atrium task merge t4                        # 关卡已通过且带 PR 的受阻任务重新排队合入
atrium task tell t4 "接口改用 v2"            # 给在跑的执行者捎话；作者按认证身份记为 u1 或 aN
atrium top --once                           # 谁在干活、全景图上两层各块的状态与在跑数，下接排期
atrium top --once --depth 3                 # 全景展开三层（旧写法 --goals-depth 照旧接受）
```

**球在谁手里**：服务给每个未结束任务一个 `holder`（`top --json` 的行、`task show`）——执行者在做（`worker`）、合入流水线（`merge`：审阅、排队合入、合入中、等发版）、排队（`queue`）、leader aN 在处理（`leader`）、秘书（`secretary`）或等你拍板（`user`），附一句经过，如「本地检查没过 · a1 已交回执行者」。判定在 `server/tasks/holder.ts`；`top` 与状态栏按它显示，不再从状态或 PR 自己猜。

`atrium top` 的**全景**段（#322，取代原来的目标段）列出根下两层的各块：状态点（● 有任务在跑、✕ 有任务卡住、○ 空闲）、人话名、子树里在跑／卡住／待办的任务数（按任务的归属部分计，没有归属时按负责节点）和一句「是什么」；`--depth N` 展开至 N 层（1～8），超出行数折叠并提示 `atrium map`。`top --json` 带 `map` 字段（与 `/api/map/tree` 同形），供状态栏读取。

下面是**排期**：就绪的（记账节点、是否 `--auto`、负责人）、依赖链（同一条链按先后缩进，标题给出最长路径）、等待中的（逐项列出在等谁：上游状态、在跑的执行者与已跑时长、上游交付 PR 的合入状态、外部 PR 条件）与因上游失败或取消卡住的；任务行标出归属部分 `oN`（迁移前的旧任务标里程碑 `gN`），只起归类作用的父任务作分组标题。行数超出折叠并提示 `atrium task plan`，`--json` 带 `plan` 字段。

派活时运行时建 worktree（没有仓库时用任务目录下的 `work/`），把标题、详述（`--brief`）、岗位章程、仓库 `.agents/README.md`、执行者档案正文和通用约束拼成提示词，以白名单环境在独立进程组拉起执行者；服务重启不带走执行者，重启后按 pid 接管或判失败。

**本机减负**（#358）：同时在跑的执行者超过上限（缺省核数的 3/4，`ATRIUM_MAX_WORKERS`），或本机太忙时，新派的活落库排队，有执行者结束或降下来后按入队顺序自动拉起。「太忙」有两条线：主线只看 Atrium 自己起的进程树（执行者及其子进程、本地检查、合入检查）占了几个核，超过核数的 3/4（8 核即 6 核，`ATRIUM_BUSY_CORES`）才暂停，系统进程再忙也不挡；整机 1 分钟负载只留一条保护线（缺省 4×核数，8 核即 32，`ATRIUM_BUSY_LOAD`），防止整台机器已经卡死时还往上加。进程树按平台统计：Linux 读 `/proc`，macOS 用 `ps`，Windows 经 PowerShell 查性能计数器。`task show` 的排队原因、`atrium top` 抬头与状态栏写清是哪条线：「本机太忙（Atrium 自己占了 6.3 核，超过 6）」「本机太忙（整机负载 35，超过 32）」「本机同时最多跑 N 个执行者」；`top --json` 的 `host` 字段给出负载、Atrium 占的核数、在跑数、上限与 `paused_by`（`own` / `load` / `full`）。已在跑任务的重试、续上不受限。本地检查同时最多跑核数的 1/4（`ATRIUM_MAX_CHECKS`），其余排队；执行者与本地检查的环境带 `ATRIUM_TEST_CONCURRENCY`（缺省核数的 1/4），仓库测试脚本据此限并发（本仓库的 `npm test` 传给 `--test-concurrency`）。

**紧急任务**（t113）：`task add … --urgent`、`task set tN --urgent|--no-urgent`、`task run tN --urgent`（派的同时标上）；秘书与 leader 都可以标。标了紧急的跳过上面两条太忙的线和执行者上限，在排队、排期就绪组里排最前；本地检查（包括合入队列的检查）立刻跑、不占并发名额，合入队列里也排在普通任务前面。其余限制照旧：额度保留份额、执行者 trust / `max_risk`、依赖。已在排队的任务标上紧急后立刻拉起。回执写「紧急：跳过本机负载限制」，`task show`、`top`、状态栏与全景任务行显示「紧急」。只认这个字段，标题以「紧急：」开头的旧任务不自动转换。

**闲时任务**（t136）：归属部分是管方面的部分（安全、性能、体验…，`org_nodes.aspect`）或在它下面的任务，建时缺省「闲时」，其余「普通」；`task add … --priority 闲时|普通` 覆盖，`task set tN --priority …` 随时改（换归属部分时，没被人改过的档位跟着新部分的缺省走）。派发先后是紧急 → 普通 → 闲时：闲时任务只有在没有普通任务在等同一类执行者时才派——同一工具的普通任务在排队，或别的普通任务只是在等本机空位（执行者满或太忙），都让它们先；普通任务在等的是自己那个工具（独占工具正忙、额度用尽）不挡别的工具。巡检自动派发同一轮里先派普通任务、闲时的最后派。已在跑的闲时任务不打断。这只是排序，不是配额，也不加关卡；紧急的闲时任务按紧急算。回执写「闲时：排在普通任务后面，有空闲执行者才派」；`task plan`、`top`、状态栏与全景任务行标「闲时」，排队中的写「等空闲：前面还有 N 件普通任务」（按当下的队列现算）。升级时在途的管方面任务补成闲时。

**捎话**（`task tell`）按工具能力分三档：Claude Code 以 `--input-format stream-json` 拉起、标准输入保持打开，补充作为新的用户消息即时写入，在工具调用边界读入，回显后记为已送达；codex 与 cursor 不能运行中追加，本轮结束后用 `codex exec resume <会话>` / `cursor-agent --resume <会话>` 带着补充续上原会话，关卡按续上后的结果判；其余工具停掉、保留工作树、把补充写进提示词重派。档案 `tell: stdin|resume|restart` 可改成工具支持的其他方式。每条捎话记一条 `tell` 事件（作者、时间、送达方式、是否送达），`task show` 与 `top` 可见；任务不在跑时留到下次拉起写进提示词。

**派活候选**（`task pick tN [--risk …]`，只读）：一行一位候选执行者——能不能接（没装、档案 `max_risk` 低于任务风险、`avoid_jobs` / `avoid_nodes` 避开、额度用尽标记、触及根章程保留份额、`billing=metered`；trust 低于 medium 的注明合入前另派审阅）、账号额度（已用、富余、距重置、扣掉保留份额后还剩多少）、是否正忙（独占工具，派了会排队）、此组合在干活的专员下的交付记录（次数、一次通过率）。最上面是推荐与一句理由（如「推荐 claude+opus：前端专员优先、claude 富余 +54%；codex 富余 −13%」），最后一行是 `atrium task run tN --worker <推荐>`；`--json` 给全部字段。候选顺序：干活的专员的优先执行者（按交付记录调整后的顺序）里能接、不正忙的在前，其余能接的按账号富余从多到少，正忙的独占工具最后；专员第 1 选超速（富余为负）而另有能接、不正忙、trust 至少 medium（且够接任务 risk）的候选富余为正且多出 30 个百分点以上时，改推荐那一位（专员候选优先），理由写「后端专员第 1 选 codex+gpt-6-sol:high 超速（codex −17%），改用第 2 选 claude+opus:high（claude +52%）」。理由只对照最多两个相关账号。`task run` 不写 `--worker`（含 `--auto` 自动派）时按同一份顺序挑，回执写「按额度挑了 X，因为…」；写死 `--worker` 且不是推荐的那位时，若另有候选按同一判定（同一个 30 点阈值）更富余，回执加一行提醒（不拦），按推荐写死不提醒。`task add --parent` 建出的子任务回执下一步是 `atrium task pick tN`（顶层任务仍提示拆子任务）。

**执行者档案**存在数据目录的数据库里，每次改动留修订。三层叠加：`harness/<工具>` ← `models/<模型>` ← `combos/<工具>+<模型>`。每份档案是 frontmatter + 正文：frontmatter 是规则（`trust`、`max_risk`、`checks`、`limits`、`model`），叠加时取更严；正文原样附进提示词，其中 `## 交付记录` 一段作备注保留、不附进提示词（交付事实以交付记录表为准）。库里没有档案时用内置缺省（适配器的默认模型）。首次启动若 `ATRIUM_WORKERS_DIR`（缺省 `~/Atrium/workers/`，只有默认数据目录才有缺省；另给 `ATRIUM_DATA` 的隔离服务不读主目录，要导入须显式设置）存在，把其中的 `*.md` 导入一次；读不了、名字不合法或超过 64 KB 的单个文件跳过并记日志，其余照常；导入后不再读这个目录。

```bash
atrium workers ls
atrium workers show harness/codex
atrium workers edit combos/codex+gpt-6-sol --trust medium --checks pr_exists,finished --reason 连续五次一次通过
atrium workers edit models/grok-4.6 --file grok.md
cat grok.md | atrium workers edit models/grok-4.6 --file -
```

**验收关卡**：执行者退出后，运行时自己查事实（PR、提交、改动规模、CI、issue 评论），按档案 `checks`（`finished`、`pr_exists`、`local_check`、`ci`、`file_growth`、`claims_verified`、`screenshots`）判定 `done` 或 `blocked`，原因写进任务事件，不采信执行者自述。`screenshots` 要求 PR 正文附 Markdown 图片或 GitHub 图片附件链接，所有截图的 HEAD 请求均返回 200。

**自动合入**：PR 任务过交付关卡后进入持久化的串行合入队列。运行时从仓库 `origin` 核对 PR，rebase 到最新默认分支，在任务 worktree 重跑 `.agents/check`（没有则 `npm run check`），通过后用检查过的头提交执行 `gh pr merge --squash --match-head-commit`；gh 查询与合入都明确带 `-R`。rebase 冲突、本地检查失败或 gh 合入失败会把文件名、失败用例和日志位置写进事件及补充说明，在原工作树与原分支重派原执行者；第三次交回转卡住并通知负责人。合入中断后从账本续上，`atrium task show tN`、`atrium top --once` 和 `atrium org show oN --detail` 可看阶段。远端 CI 仍只供参考，不挡合入。

**合入前审阅**：任务 `--risk high`，或执行者档案 `trust` 低于 `medium`（没写按 `unknown`）时，PR 先进「审阅中」：运行时另建一个 `审阅 tN：…` 任务（`--deliver none`），自动挑一个与原执行者不同工具、不同模型且 `trust` 至少 `medium` 的执行者，按清单只读审代码，最后一行写 `审阅结论：通过` 或 `审阅结论：打回`。通过进合入队列；打回把意见交回原执行者，与冲突、检查失败共用交回次数，第三次转卡住；审阅者失败、没写结论、挑不到人或被停止都转卡住并通知负责人。审阅任务本身不单独投递事件；进审阅时在原任务上发 `review_queued` 事件，带改动规模摘要（文件数、增删行数、改动最多的文件），`atrium task show tN` 可看审阅任务与事件。

**自动上线**：合入的是服务自身仓库（`ATRIUM_UPDATE_REPO`，缺省 `liu-zhengdong/atrium`）的 PR 时，运行时每分钟拉一次标签，等发版工作流打出含该合入提交的版本；版本比运行中的新就执行 `atrium update --to <版本>` 与 `atrium restart`（在跑的执行者由新服务接管），新服务起来后把任务标为「已上线」，给负责人发 `online` 事件「tN 已上线（vX）」并附执行者在 PR 正文里写的「端到端验证」一节（派活时的通用约束要求写这一节）。同一版本只自升级一次：升级或重启失败（含 supervisor 回滚）发 `online_failed`；合入 30 分钟仍未发版发一次 `release_overdue`。自升级缺省只在用默认数据目录（`~/.atrium`）的安装版上开；开发中的 git 检出、测试与另给 `ATRIUM_DATA` 的隔离服务不动全局安装，停在已合入（`ATRIUM_SELF_UPDATE=1` 强制开、`=0` 关）。其他仓库只到已合入。

**看门狗与自愈**：日志、工作区、结构化事件长时间没有进展判卡死；供应商或网络临时错误先同一执行者重试、再换人重派；思考耗尽单次输出直接换人；额度用尽的账号打标记，到点前不再派。

## 执行机器（远程执行者）

服务仍是唯一的账本与调度中心，执行者可以跑在任何接入的机器上（#358 第 1 步）：用户自己的其他电脑、云主机、本机的 Linux 虚拟机都行，只要装了 Node 24+ 与 Atrium、能连到服务。本机固定是 `h1`，接入的主机依次是 `h2`、`h3`…（短号持久、移除后不复用）。

```bash
atrium host add 书房台式机 --repo liu-zhengdong/atrium --max 4   # 登记并拿一次性接入码（30 分钟内有效）
# 在那台机器上（服务地址换成它连得到的：SSH 转发、内网穿透、VPN；OrbStack 虚拟机用 http://host.orb.internal:4310）：
atrium agent --server http://127.0.0.1:4310 --token h2-接入码         # 前台常驻；之后重启只要 --server
atrium host ls                        # 各台状态（在线、离线、待接入）、系统与核数、编码 CLI 及是否登录、在跑几件
atrium host show h2                   # 一台的详情与在跑的任务
atrium task run t6 --host h2          # 派到 h2；atrium task wait / task log --follow 在本机照看
atrium host pause h2                  # 暂停往 h2 派新活（在跑的照跑）；host resume h2 恢复；本机也可以 pause h1
atrium host remove h2                 # 令牌作废，那台的代理随即停下；有在跑的任务时拒绝
```

- **代理主动连服务**：`atrium agent` 用长轮询领指令，远程机器不用开入站端口；服务只听本机 `127.0.0.1`，跨机器怎么通由用户自己的转发、穿透或 VPN 解决（明文 HTTP 跨公网时代理会提示改用 HTTPS 或 SSH 转发）。接入码只能用一次，换成这台主机专用的令牌，存在那台机器的 `~/.atrium-agent/agent.json`（`0600`，`ATRIUM_AGENT_DATA` 可改目录）；令牌只能领派给这台的指令、上报这台的日志与结果，碰不到任务账本、组织和别的主机。
- **在那台机器上干活**：服务写好提示词、算好路径，代理在自己的数据目录里克隆仓库（用那台机器上的 git 凭据）、按同一规则建工作树、按同一份适配器拉起执行者，环境同样走白名单并带 `ATRIUM_WORKER=1` 与按那台核数算的 `ATRIUM_TEST_CONCURRENCY`。编码 CLI 的登录留在那台机器上，不经服务传输；组织技能暂不挂载到远程（事件 `skills_skipped`）。
- **事实与关卡不变**：日志按字节偏移传回本机任务目录，`task log`、`top`、看门狗照旧读它；改动规模、提交、本地检查在那台的工作树里查与跑（经代理，git 只接受查询与清理用的子命令），PR 与 CI 仍由服务查 GitHub。合入队列在本机按 PR 头另建一个工作树来 rebase、重跑检查、合入，合入后连同那台上的工作树一起清掉。
- **断线与重启**：断线期间执行者照跑，日志与退出记在那台机器上，重连后补传；服务重启后先按账本接管远程的这一轮，代理自动重连，对账时补报重启期间的结束、结束账本已不认的进程。代理自己重启也不带走执行者，按运行记录接着看。主机离线时不判卡死；这时 `task stop` 先在账本收尾，重连后代理结束那个进程。
- **挑主机**：指定 `--host` 只看那台（离线、暂停、没装或没登录这个 CLI 时拒绝并说原因，满了或太忙就钉在那台排队）。不指定时在能接的主机里挑最空的，一样空本机优先；远程主机只自动接 `--repo` 登记过的仓库（`*` 全部；不登记只自动接没有仓库的活），体验巡检只在本机跑。独占工具与执行者上限按主机分开算。`task pick` 列出推荐的执行者在各台能不能跑、自动派会去哪台；`top` 的执行者列带主机短号，并多一行各台状态。

## 专员与执行者评价表

专员不挂在组织树上，但有归属（#373）：不写 `--part` 是全组织共用的（前端、后端），写了就属于那一部分（安全专员属于安全）。一个任务能请的专员 = 归属链上各层的 + 牵涉部分的 + 全组织的；`--by`、`--ask` 与 `task pick` 都按这个范围，请不到时报错并列出能请的。`specialist ls` 缺省只列全组织的，`--part 部分` 列这一部分能请的（本部分的在前，上级与全组织的折成一行「另有 全组织的 前端、后端」），`--all` 展开。任务用 `--by` 指定一位干活的专员，派活会附专员说明与技能；用 `--ask` 请至多五位专员按清单审查。专员的优先执行者在额度、风险和档案约束内选择；评价表按执行者 × 干活的专员统计，已有 rN 短号与交付记录保留。

```bash
atrium specialist add 前端 --description "界面设计与实现" --body ./frontend-role.md --preferred claude+opus:high --checks screenshots --skills visual-design,design-dialogue
atrium specialist show 前端
atrium specialist edit r1 --preferred claude+opus:high,codex+gpt-6-sol:high
atrium specialist ls --json
atrium specialist add 安全专员 --part atrium/security --description "查凭据与权限" --body ./security-role.md
atrium specialist ls --part atrium/web     # 网页能请的：本部分的列表，继承的折成一行；--all 展开
atrium task add "改页面" --by 前端 --ask 后端 --part atrium/runtime
atrium task set t1 --by 后端
atrium workers --specialist 前端
atrium workers show claude+opus:high
atrium workers confirm claude+opus:high --specialist 前端 --action tighten
```

`workers` 展示组合 × 干活的专员，并上卷到模型与工具；少于五次标「数据少」。建议只读，确认后才写组合档案（库里，留修订）。交付明细保留事实、缺失值与旧任务回填标记；`task note --verdict ok|fixed|rejected` 记录秘书的上线验证或用户纠正。

## 额度

```bash
atrium quota                  # 各账号按富余从多到少，标出来源、读不到的原因和额度用尽待恢复的；--json 给脚本
atrium quota --clear claude   # 人工解除运行时的额度占用（误判时用），记事件并立即派发排队任务
```

额度由 Atrium 自己读（「来源」列写「自带」）：服务进程读各工具本机已登录的凭据，调供应商的用量接口，只读、不刷新对方凭据；同一账号成功缓存 5 分钟、失败 1 分钟，限流按 Retry-After 推迟，读不到时 6 小时内沿用上次读数并注明。目前覆盖 Claude Code、Codex、OpenCode Go：

| 账号     | macOS                                                                   | Linux                                                                      | Windows                                   |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| claude   | 钥匙串「Claude Code-credentials」，再退回 `~/.claude/.credentials.json` | `~/.claude/.credentials.json`、`$XDG_CONFIG_HOME/claude/.credentials.json` | `%USERPROFILE%\.claude\.credentials.json` |
| codex    | `~/.config/codex/auth.json`、`~/.codex/auth.json`（`CODEX_HOME` 覆盖）  | 同左                                                                       | 同左（`%USERPROFILE%` 下）                |
| opencode | `~/.local/share/opencode/auth.json` 的 `opencode-go`                    | `$XDG_DATA_HOME/opencode/auth.json`，缺省同左                              | 同左（`%USERPROFILE%` 下）                |

自带还没覆盖的账号（kimi、grok、antigravity 等），本机装了 [OpenQuota](https://github.com/liu-zhengdong/OpenQuota) 就用它补（`openquota pace --json`，`ATRIUM_OPENQUOTA_BIN` 可改路径），自带读不到的账号也先用它补并注明；都没有就显示「没有额度数据」，挑执行者退回档案顺序与运行时的额度用尽标记。给用户留的份额只读组织树：派活按任务所在节点章程链中最严的 `quota_reserve_percent` 保留每个账号的用户额度，根章程没写时缺省 20%；`atrium quota` 表格下一行写明份额与出自哪份章程（`--json` 的 `reserve`）。旧的 `~/Atrium/charter.md` 不再读取：用默认数据目录的服务首次启动时（隔离服务只认显式的 `ATRIUM_LEGACY_DIR`），若根节点缺某项预算（`quota_reserve_percent`、`disk_min_free_gb`、`money`）而旧章程 frontmatter 的 `budget` 里有，就导入一次写进根章程（留修订），之后改预算用 `atrium org edit o1 --charter`。

## Claude Code 状态栏

```bash
atrium statusline     # 一屏概况：未结束任务各在谁手里、leader 在处理什么、秘书未处理事件、接下来就绪与等待的数目
```

在 `~/.claude/settings.json` 里配置：

```json
{ "statusLine": { "type": "command", "command": "atrium statusline" } }
```

服务不在只显示「Atrium 未运行」，不拉起服务；只有真的在等你拍板的任务用醒目红色写「等你」。全局装好的 `atrium` 就够，不再需要 `~/Atrium/tools/` 下的 `statusline.py` 与 `org` 包装脚本；数据目录不是默认的 `~/.atrium` 时在命令前带上 `ATRIUM_DATA=…`。

## 事件

事件先落库：失败、卡住、卡死、待派任务、需要秘书确认的事和已上线属于要处理；合入队列及自动派发等过程属于知会。订阅者取走要处理事件、确认后才算处理完；服务重启后仍在。

```bash
atrium events                     # 查看最近事件的送达与确认状态；--before 翻页
atrium events wait --timeout 5    # 只取要处理事件；首条后攒批最多 30 秒，--settle 可调
atrium events wait --all           # 连同知会一起取
atrium events digest --since 2026-09-27T00:00:00+08:00  # 按任务合并知会，读后自动确认
atrium events ack 1               # 确认已处理（编号见 events wait）
```

同一订阅者、同一去重键的未确认事件合并成一条；取走的事件 15 分钟内不重投（`ATRIUM_EVENT_LEASE_MINUTES` 可调），到点仍未确认才重投；自己 `task stop` 引出的事件不投给自己。

## Leader：按部分分层汇报

用户只和秘书对话；秘书建任务、派活，但任务的过程事件交给任务所属部分的 leader，不直接到秘书。leader 是登记在 Atrium 的固定身份（`a1`……），按事唤醒、无常驻会话，只把四类事上交秘书。

```bash
atrium leader add Atrium负责人 --worker claude+opus:high   # 登记（名称、被唤醒时用的执行者组合）；--id aN 认领节点上已引用的号
atrium org edit atrium --leader a1 --reason 试点           # 指派；指派没登记的 aN 会被拒
atrium leader ls                                          # 每位负责什么、最近一次唤醒在处理什么
atrium leader show a1                                     # 连同备忘
atrium leader edit a1 --memo "在等 t5 合入"                # 备忘（覆盖写，上限 2000 字，超了先精简；与 memo edit --as a1 同一份）
atrium leader escalate "t5 已上线；端到端：…" --kind shipped --task t5 --as a1   # 上交（leader 进程里缺省以自己的身份）
atrium org stages atrium --file 阶段.yaml --reason 推进     # 只改节点的阶段记录，其余章程不动
```

- **投给谁**：任务没写 `--owner` 时，从任务的归属部分（`--part`，旧任务的归属节点次之，都没写沿父任务往上找）向上找最近的、已登记的 leader；找不到投秘书。事件的 `routed` 写明投给谁、为什么。写了 `--owner`（包括 `--owner secretary`）就按负责人投。过程事件（合入、退回等知会）也投给 leader，但只有「要处理」的才唤醒它。
- **按事唤醒**：leader 有要处理的事件时，攒批 30 秒（`ATRIUM_LEADER_BATCH_SECONDS` 可调），用登记的执行者组合起一个一次性进程（同一 leader 同时只起一个，单次上限 20 分钟，`ATRIUM_LEADER_TIMEOUT_MINUTES` 可调）。只有默认数据目录的服务缺省唤醒；另给 `ATRIUM_DATA` 的隔离服务（压测、验收）库里有 leader 也不起真进程、不耗额度，事件留在收件箱，要唤醒设 `ATRIUM_LEADER_WAKE=1`（`=0` 在默认目录也关）。提示词附该节点的全景上下文（与 `map context` 同一段）、备忘、这批事件、过程摘要、可用命令、权限边界与上交规则；处理完 `events ack` 后退出。退出非零或没确认完算失败，释放事件稍后重试；连续 2 次失败或超时，把没确认的事件转交上一层（秘书）。处理期间同一任务又有新结果合并进来的，下次唤醒再送，不随旧内容一起确认。
- **权限**（服务端按每次唤醒签发的 leader 令牌判定，不靠提示词）：可以在负责的节点及子节点建任务（不写 `--part` 默认记到负责的节点）、派活、重派、捎话、停、记备注、请专员与会审，任务牵涉到自己负责的部分时记备注与捎话，改这些节点的要点、阶段与全景人话字段，写自己的备忘，给子节点指派下层 leader，确认投给自己的事件。不可以动别的部分的任务、改章程与边界预算、建节点、拍板会审、改技能与额度、登记 leader，也不能启动、停止、重启或升级服务；越权返回中文说明并提示 `atrium leader escalate …`。
- **上交**只有四类：`shipped` 已上线（里程碑完成，须带 `--task`，说明里附端到端验证）、`cross` 需要别的部分配合、`beyond` 越过权限／预算／硬边界、`stuck` 搞不定（卡住多次、拿不定）。生成一条投给上一层 leader（没有就秘书）的「要处理」事件 `escalated`，带 `--task` 时任务上也记一笔。
- **连续性**存在 Atrium：节点要点、阶段、交付记录与 leader 的备忘和决定记录，不靠进程上下文。`org tree`、`map --json`（`leader_state`；`lead` 是这一块归谁管，含从上级继承的）、`atrium top` 显示每个节点的 leader 与最近一次唤醒、在处理什么（人话，如「t84 上线」）。
- **看得到**：全景网页每块标题下有「负责人」一行（名字与在处理什么，点开是负责人页），顶栏在它处理时写「Atrium 负责人在处理」；leader 建的任务在任务行注明「Atrium 负责人派的」，备注作者给名字（`task ls/show` 显示「Atrium 负责人（a1）」，接口字段 `note_by_name`）。状态栏读 `GET /api/leaders` 的 `busy`：`[{ref, name, doing, since}]`，只列正在处理的 leader，空闲为空数组。

## 备忘与决定记录

秘书（`secretary`）和每位 leader 在 Atrium 里各有一份备忘和一份决定记录，换机器、换秘书都接得上。

```bash
atrium memo show                                   # 秘书的备忘与全部有效决定（新会话、换人接手先跑这一条）；--as a1 看 leader 的
atrium memo edit "在等 t97 上线，先看合入队列"        # 覆盖写，上限 2000 字；--file 文件；--as a1 写 leader 的
atrium decision add "额度读取不依赖 OpenQuota" --why "要迁到别的设备" --by u1 --issue 352   # 追加，得到 dN
atrium decision add "…" --why "…" --by u1 --date 2026-09-26 --task t80 --node atrium    # 补记旧决定、关联任务与节点
atrium decision supersede d1 --by d3               # d1 标为已推翻、指向 d3（也可在 add 时 --supersedes d1）
atrium decision ls [--all] [--before dN] [--limit 条数]   # 日期新的在前；缺省只列有效的，--all 连已推翻的
```

- **备忘**写当前状态（在等什么、下次先看什么），每次覆盖；leader 的 `leader edit --memo` 与 `memo edit --as aN` 写同一份。**决定记录**写取舍与原因，只追加：每条有日期、谁拍板（`--by u1`／`secretary`／`aN`，缺省是记录的主人）、决定、原因，可选关联 issue、节点、任务；推翻时指向新决定，旧的留着可查。短号 `dN` 全局持久、不复用。
- 和全景「要点」的区别：要点是执行者要守的产品约束，派活时附进提示词；决定记录是秘书、leader 给自己回看的「为什么这么定」，不附给执行者。
- `--as` 是记录的主人，缺省秘书；leader 进程里缺省是自己，且服务端只许读写自己的（`?as=` 锁定）。leader 唤醒时提示词附自己的备忘和最近有效的决定（至多 10 条、约 2000 字，放不下的给 `decision ls` 命令）。
- 全景网页：组织根属性行的「秘书」点进秘书页（`/map#secretary`），页签是备忘与决定记录；负责人页（`/map#a1`）在备忘旁多一个「决定记录」页签。决定记录可切有效／全部，只读。

## 和秘书对话

```bash
atrium chat                 # 缺省打开 opencode 原生界面，接着上次会话；--new 新开，--cwd 指定工作目录
atrium chat --acp           # opencode 改用 Atrium 的 ACP 对话界面；非终端环境自动走 ACP
atrium chat --tool codex    # 用 codex-acp 托管 Codex 秘书会话
atrium chat --acp --allow   # ACP 权限请求自动允许一次（非交互时缺省拒绝）
```

`atrium chat` 按 `--tool` 或 `ATRIUM_SECRETARY_TOOL` 选择秘书工具。opencode 缺省走原生界面：Atrium 启动只监听 127.0.0.1、随机端口和密码的 `opencode serve`，再以 `opencode attach` 打开会话。事件经服务端接口送进同一会话，消息以「【Atrium 事件】」开头，界面弹出「送入事件 #编号」；用户的输入框不受影响。`--acp` 改由 Atrium 以 `opencode acp` 托管；不在终端时也走 ACP。codex 经 `@zed-industries/codex-acp` 使用 ACP；依赖在 `package.json` 和 `package-lock.json` 精确锁定为 `0.16.0`，安装 Atrium 时运行 `npm ci` 安装对应平台二进制。

opencode 两种界面共用 `<ATRIUM_DATA>/secretary/opencode-session.json`，codex 会话编号存在同目录的 `codex-acp.json`；工作目录也一并记录。秘书空闲时，要处理事件按唤醒规则攒批送入；忙时排队、一轮结束后合并送入；连续自动送入 10 次后暂停，等用户发话再继续。送入即记为已送达，秘书处理完用 `atrium events ack` 确认；未确认事件在租约到期后重投。

界面关闭时，服务按相同规则恢复上次会话：codex 执行 `codex exec resume <会话> -`，opencode 执行 `opencode run --session <会话>`，每批处理完即退出。原生界面、ACP 界面与后台恢复共用一把会话锁；有界面时不会另起后台进程。后台恢复只在 `atrium chat` 建过会话后启用，失败会释放事件租约再重试。后台 codex 使用无提示审批与完整文件访问，opencode 使用 `--auto`；秘书仍按原有权限与章程行事。

秘书的 opencode 用独立数据目录（`XDG_DATA_HOME=<ATRIUM_DATA>/secretary/opencode-home`）：每次打开界面或后台恢复前，从用户 opencode 数据目录的 `auth.json` 同步 API key 类条目（`api`、`wellknown`），OAuth 登录（如 openai、xai）不带——提供商的刷新令牌多是一次性的，秘书一刷新，用户自己的登录可能失效；`mcp-auth.json` 在 opencode 里只存 MCP 的 OAuth 状态，同样不带。所用模型的提供商只有 OAuth 登录时，打开界面会提示换用有 API key 的提供商，或在秘书目录里单独登录（`XDG_DATA_HOME=<ATRIUM_DATA>/secretary/opencode-home opencode auth login`，秘书自己的登录不会被同步覆盖）。用户原目录只读不改；配置目录 `~/.config/opencode` 不变，模型、权限与插件设置照常生效。opencode 在同一数据目录并发会死锁，分开后秘书常开也不挡 opencode 执行者（不选互斥：秘书一开就是几个小时，互斥等于期间 opencode 执行者全停）。kimi、Claude Code 后续接入。

## 全景图

同一份数据两张脸：人用网页看，Agent 用命令行读写；改动只走命令行，网页不提供编辑（#322）。

```bash
atrium map                                        # 终端打全景树，并在浏览器打开本机全景网页（一次性登录链接）
atrium map atrium/runtime --json --depth 2        # 一块的人话字段、组成、要点（含下层 points_below）、阶段、任务、PR 与 issue；与网页同一接口
atrium map context atrium/cli                     # 从根到该块的人话链、组成、现状与本块及上级的要点，加适用于它的管方面要点；--also 部分 附牵涉部分的；--max 字数，缺省 1500
atrium map edit atrium/cli --what 一句话 --uses 场景一 --uses 场景二 --flow 第一步 --now 现状 --next 接下来
atrium map edit atrium/cli --detail 细节.md --reason 补技术细节   # 技术细节即章程正文；给空串清掉一个字段
atrium map add atrium 待办本 --slug ledger --analogy 团队的任务白板 --what 一句话
atrium map add atrium 安全 --slug security --kind aspect     # 管方面的部分：要点横跨多个部分
atrium map edit atrium/security --applies atrium/web,atrium/cli  # 它的要点缺省适用于哪些部分；空串改回整个上级
atrium org edit atrium/perf --kind aspect --reason 横向看性能   # 已有部分改成管方面；改回 module 前要先清掉适用范围
atrium patrol run atrium/cli                       # 手动巡检一条 uses 场景；下一次轮换到下一条
atrium patrol findings atrium/cli                  # 看发现及 leader 的处理结果
```

体验巡检以当前用户环境使用安装版服务与默认数据目录；隔离服务启动时显式设置的 `ATRIUM_DATA`、`ATRIUM_PORT` 会传给巡检进程。巡检只看全景人话字段、帮助与命令回执，不读代码。巡检进程用 `atrium patrol report tN --phenomenon 现象 --step 步骤 --command 命令 --expected 预期 --actual 实际 --kind broken|awkward` 记发现；同节点同现象去重，已忽略的也不再报。任务结束后新增发现投给节点 leader，leader 开任务后用 `atrium patrol decide fN --task tN` 关联，或用 `--merge tN` 并入已有任务，或用 `--ignore 原因` 记下忽略理由。全景节点的「巡检发现」页签与 `map --json` 都显示处理结果。本步只支持手动触发。

- **网页**：服务自带（`/map`），只听 127.0.0.1、只接受本机连接。`atrium map` 用用户令牌换一个一次性链接（2 分钟内有效、只能用一次），浏览器打开后换成本机会话 cookie（HttpOnly、SameSite=Strict，7 天有效，服务重启后仍有效）；会话只能读全景，写接口和其他接口仍要用户令牌。交互终端里直接打开浏览器，非终端、执行者环境或 `--no-open` 只打印链接。
- **布局**：一块一页。顶栏是面包屑（从根到当前块，可点回上层）和「在做 N 件」——数字是当前部分含其子部分的在跑数，专员页与执行者页显示全组织的「全组织在做 N 件」；下面是小字类别（组织／部分／管方面的部分／专员）、人话名与介绍。组织节点展示组成部分、任务、专员、原则与巡检发现（现象、步骤与命令、预期与实际、处理结果）。任务默认只看进行中，可切「全部」；「最近在做」一列里执行者写的 http(s) 链接（如 PR 地址）点得开，新标签页打开。
- **横跨部分**（#373）：组成部分里管方面的部分（如安全）名字旁标「管方面」，它的页头类别写「管方面的部分」、属性行「适用于」列出缺省适用的部分（没写为「整个 Atrium」），原则下一行小字写各自的适用范围。其他部分的「原则」页签另列别处适用于这里的要点，来自写成「安全 · 适用于网页」。任务行标题下写「也牵涉安全、命令行」（自动牵涉的悬停说明）；牵涉某部分却归别处的任务也列在那一部分的任务页签里，标题下写「归网页」。
- **专员按层**：部分页的「专员」页签只列属于这一块的专员，上级的、全组织的、牵涉部分的折成一行「还能请：全组织的 前端、后端」，点开（`/map#o4/roles/all`）一起列并在名字下注明属于哪儿；组织根列全组织共用的，属于各部分的折成末尾一行。专员页属性行多一项「属于」。
- **组织根**：页签是 **组成部分／负责人／专员／技能／执行者／原则／巡检发现**。负责人（负责哪几块、现在在处理什么或空闲、执行者，整行点进负责人页）。专员是全组织共用的名单，记录工作说明、技能、优先执行者、交付要求、审查目标与清单；技能显示用途、挂在哪位专员或部分、最近一次修订。执行者按组合 × 干活的专员统计交付次数、一次通过率（80% 以上绿、50% 以上黄、更低橙，少于 5 次标「数据少」）、平均打回、一般用时、出事与信任；右上角可按专员筛选。上方浅黄条显示 `atrium workers` 的升降建议，写「等秘书确认」，网页不给按钮，确认走 `atrium workers confirm`。
- **专员页**（`/map#r1`）：面包屑「全部 / 专员 / 前端」，属性行是优先派给、交付要求、技能；页签是任务（带进行中／全部）、谁做得好、技能。**执行者页**（`/map#w/claude+opus:high`）：属性行是信任、交付次数与一次通过、接过的专员；页签是交付记录（任务、专员、结果、用时、经过——事故、验收没过的原因、合入退回，冲突注明不算它的）与观察（执行者档案里带日期的记录，如「（2026-09-27 你纠正：……）」；冒号前没写人的算秘书记的）。**负责人页**（`/map#a1`）：属性行是负责哪几块（可点）、现在（在处理什么、几点开始；空闲时给上次处理的事）、执行者；页签是备忘（它记着的在等什么、下次先看什么）、处理过的事（投给它的要处理事件：任务、什么事、说明、结果——等它处理／在处理／处理完／转交上级）与上交（类型、任务、说明、交给谁、对方看没看）。找不到专员、执行者或负责人时，页面说明原因并给回到最上层的链接。
- **地址**：当前页、页签与筛选写在地址里（如 `/map#o2/tasks/all`、`/map#o1/workers/r1`、`/map#r1/workers`），刷新与前进后退回到原处；窄屏（≤ 720px）表格降为卡片式行，不横向滚动。
- **实时**：网页订阅 `/api/map/stream`（Server-Sent Events）。全服务一份变更检测（版本号，不扫全表），变了给所有打开的页推 `changed`，网页只重取并重画变了的区域；组织根首屏不取执行者统计，画完再补。另每 30 秒刷新一次执行者的最近动作与时长。
- **派活**：`map context` 的内容自动附进执行者提示词，与「章程要点」同一段、放在最前（任务有归属部分时取归属部分，否则取负责节点）；归属链之外再附「牵涉部分的要点」：任务 `--also` 牵涉的部分的要点，以及管方面的部分里适用于归属部分的要点（自动牵涉），每条注明来源（如「安全 · 适用于网页」）。全景这段不超过 1500 字，按「位置链 > 本块是什么 > 本块要点 > 上级要点与牵涉部分的要点 > 上一层是什么 > 现状 > 组成 > 更上层」保留，截了就在末尾给全文命令。提示词只附本任务用到的专员（干活的与请来看的）。
- **管方面的部分**（#373）：除了管东西的部分（命令行、网页、派活），还有管方面的部分（安全，以后可能有性能、体验），它们的要点横跨多个部分。`map add … --kind aspect` 建，已有部分可用 `org edit … --kind aspect|module` 改类型（只切「管方面」标记，留节点修订；project/org 不能改成 aspect；改回 module 前要先清掉要点与部分的适用范围，否则报错并列出命令），`map edit … --applies` 写它的要点缺省适用于哪些部分，单条要点可用 `org point-add/point-edit --applies` 覆盖；都不写即适用于整个上级。`map --json` 给 `aspect`、`applies` 与本块适用的别处要点 `points_applied`。
- **权限与修订**：`map edit` 的人话字段（what、uses、flow、alias、analogy、now、next、when）直接覆盖当前值，不留修订、无需 `--rev`；`--detail` 是章程正文，仍留章程修订，`--rev` 仅用于此。`map add` 的节点创建仍留节点修订，人话字段不留修订。硬边界、份额等组织规矩仍按章程修订。负责部门 leader 或其上级可改（`--as aN`），根只有你能改。

## 组织树

组织、项目、模块三类节点，短号 `o1`……，也可用路径（如 `atrium/runtime`）。每个节点有 leader、章程与能力卡，每次修改存一版历史；子节点的硬边界只能比父节点更严，显式分配给兄弟的份额之和不得超过父节点的可分配量。根章程只有用户 `u1` 能改，其余由节点 leader 维护（`--as aN`）。

```bash
atrium org import --repo .                        # 预览：根章程 ~/Atrium/charter.md（隔离数据目录须给出路径）与仓库 .agents/modules 下待导入的模块（导入后仓库里删掉）
atrium org import --repo . --apply                # 写入；重复执行不会重复建
atrium org tree                                   # 节点层级、任务计数、预算份额与约用量
atrium org show atrium/runtime                    # 先讲人话：是什么、能做什么、一件事怎么走完、由哪几部分组成、现状与阶段
atrium org show atrium/runtime --detail           # 再展开细节：章程正文、目标链、硬边界、预算份额、能力卡、手上的任务
atrium org show atrium/runtime --charter --raw > /tmp/章程.md
atrium org edit atrium/runtime --charter /tmp/章程.md --reason 更新目标
atrium org history atrium/runtime                 # 修订；--target charter --rev r2 看字段差异
atrium org add atrium web --kind module --reason 拆模块
atrium task add "改派活" --by 后端 --part atrium/runtime  # 干活的专员与归属部分
atrium task add "接看板" --part atrium/runtime                      # 任务归属全景图上的哪一部分；task set --part '' 摘下
atrium task add "改登录页" --part atrium/web --also atrium/cli      # 还牵涉命令行；task set --also '' 摘下
atrium task add "改登录日志" --by 后端 --ask 前端         # 请前端来看；task set --ask '' 清空
atrium review add "公开仓库" --concerns 前端,后端 --brief 议题.md   # 会审：专员并行出意见，leader 汇总一致与冲突、能定的定；--issue 号 --repo 仓库 --comment 同步为 issue 评论
atrium review show t9                              # 各方意见（立场与原文）、一致与冲突、结论、需用户拍板的事
atrium review decide t9 "先清理凭据，下周公开"          # 记下用户对上交事项的拍板（--as 缺省 u1）
atrium org link-roles                             # 预览把旧 role 字符串的任务关联到节点；--apply 写入
```

任务用 `--part 节点` 记录归属部分；旧 `--role` 组织节点写法暂时接受并提示改用 `--part`。旧 `--job` 与 `--concern` 也暂时接受，分别提示 `--by` 与 `--ask`。启动时旧关注点迁入专员清单；o6 安全、o7 质量是撤销的示例节点，原要点移到 o2 Atrium。

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
atrium org point-add atrium/security "网页不回显令牌" --why "泄露收不回" --by "u1 09-27" --applies atrium/web  # 管方面的部分：这条适用于哪些部分
atrium org point-edit k1 --check ''     # 改一条；--check '' 去掉检查，--applies '' 改回跟随部分
atrium org point-rm k1                  # 删掉过时的
```

任务用 `--part 节点` 标归属哪一部分（谁负责），用 `--by 专员` 指定干活的专员（谁做、附什么技能），用 `--ask 专员[,专员]` 请专员来看。

任务**归**一个部分（负责与汇报只有一处），可以用 `--also 部分[,部分]` **牵涉**至多五个部分；管方面的部分有要点适用于归属部分时自动牵涉，不用写（`task show` 标「自动」）。牵涉带来三件事：派活附被牵涉部分的要点（注明来源）；能请被牵涉部分的专员；被牵涉部分最近的 leader 收到一条 `involved` 知会（不叫醒，下次唤醒时看到），它可以在任务上写备注或捎话，但不能派、停、改；要否决走会审。几位专员一起干默认是一个执行者兼带几方面的技能与检查清单，真要分头干再拆子任务。

### 任务请专员

`--ask` 至多请五位，执行中不能改，本轮交付后按各专员的 `review_goal`、`review_points` 与 `review_bottom` 派一次性审查任务；全部通过才完成，任一否决或没出结论会卡住并通知负责人。`task wait` 等到审查结论才返回。专员的 `invite_when` 可按关键词或路径提示是否该请，只提示、不自动请。`atrium specialist show rN` 可查看清单。

### 会审

影响面大、不可撤回的决定（公开仓库、归档旧代码、大版本）或疑难事故，由 leader 发起会审：`atrium review add 议题 --concerns 前端,后端 [--brief 议题.md] [--issue 号] [--leader 节点]`。

1. **议题**：建一个议题任务「会审：议题」（记在 `--leader` 节点上，缺省由秘书主持），每位受邀专员一个意见子任务（按专员清单、只交摘要），详述写明议题原文、关联 issue、全部受邀专员，以及该专员的章程目标、要点与底线。
2. **并行出意见**：意见任务同时派出，各是一个一次性执行者；摘要最后一行写立场：`意见：同意`、`意见：有条件同意：条件`、`意见：反对：原因` 或 `意见：否决：越过的底线`。失败、受阻或没写立场的算「没出意见」。
3. **leader 汇总**：意见都不再跑后，运行时把各方意见原文写进议题任务的详述（`council-summary.md`），拉起议题任务本身做汇总：写「一致」「冲突」两段，能定的自己定，碰到用户定的边界或谈不拢的每条写一行 `需用户拍板：…`，最后一行 `结论：…`。
4. **结局**：运行时读汇总记在议题上。leader 标了需用户拍板、没写结论、专员都没出意见、或有专员以底线否决而 leader 没上交的，一律转「需用户拍板」（专员否决不能由 leader 自行推翻），投 `council_escalated`；其余转「已定」，投 `council_decided`。意见任务与汇总自己的完成不单独投递。`atrium task wait t9` 等到结局才返回。
5. **记录与拍板**：`atrium review show t9` 看意见与结论；用户拍板后 `atrium review decide t9 结论` 记下（留拍板人，原上交事项保留）。`--comment`（需 `--issue` 与 `--repo`）让汇总任务把结论发成 issue 评论，由评论关卡查实。

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
- leader 进程带 `ATRIUM_LEADER`、`ATRIUM_LEADER_TOKEN`（本次唤醒签发、结束即作废）与 `ATRIUM_LEADER_URL`，命令行据此以 aN 身份直连服务，`events`、`task stop` 的 `--as` 缺省是自己；权限由服务端判定。

## 配置与数据

| 环境变量                        | 用途                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `ATRIUM_PORT`                   | 新启动服务的端口，默认 `4310`；已有服务沿用原端口                                        |
| `ATRIUM_DATA`                   | 数据目录，默认 `~/.atrium/`                                                              |
| `ATRIUM_WORKERS_DIR`            | 旧版执行者档案目录，首次启动导入一次，默认 `~/Atrium/workers`（隔离服务无默认）          |
| `ATRIUM_LEGACY_DIR`             | 旧状态目录，默认 `~/Atrium`（隔离服务无默认）；启动时从这里导入一次根章程预算            |
| `ATRIUM_OPENQUOTA_BIN`          | OpenQuota 可执行文件，默认 `/Applications/OpenQuota.app/…`                               |
| `ATRIUM_QUOTA_READERS`          | 设为 `off` 关掉自带额度读取，只用 OpenQuota                                              |
| `ATRIUM_EVENT_LEASE_MINUTES`    | 取走的事件多久未确认就重投，默认 15                                                      |
| `ATRIUM_EVENT_BATCH_SECONDS`    | 事件攒批窗口，默认 0（到即取）                                                           |
| `ATRIUM_QUOTA_UNKNOWN_MINUTES`  | 额度用尽但不知道何时恢复时，标记多少分钟，默认 60                                        |
| `ATRIUM_LEADER_BATCH_SECONDS`   | leader 唤醒前的攒批窗口，默认 30                                                         |
| `ATRIUM_LEADER_TIMEOUT_MINUTES` | leader 单次唤醒的上限，超时转交上一层，默认 20                                           |
| `ATRIUM_LEADER_WAKE`            | `1` 让隔离服务也唤醒 leader，`0` 关掉；默认只在默认数据目录唤醒                          |
| `ATRIUM_UPDATE_REPO`            | `atrium update` 的来源，默认 `github:liu-zhengdong/atrium`                               |
| `ATRIUM_MAX_WORKERS`            | 本机同时在跑的执行者上限，默认核数的 3/4（至少 2）；`0` 不限                             |
| `ATRIUM_BUSY_CORES`             | Atrium 进程树占用超过几个核暂停派新活，默认核数的 3/4；`0` 不看                          |
| `ATRIUM_BUSY_LOAD`              | 整机 1 分钟负载保护线，超过暂停派新活，默认 4×核数；`0` 不看负载                         |
| `ATRIUM_MAX_CHECKS`             | 本地检查同时跑几个，默认核数的 1/4（至少 1）                                             |
| `ATRIUM_TEST_CONCURRENCY`       | 注入执行者与本地检查的测试并发，默认核数的 1/4（至少 1）                                 |
| `ATRIUM_AGENT_DATA`             | 远程主机上 `atrium agent` 的数据目录（令牌、仓库、工作树、日志），默认 `~/.atrium-agent` |

Atrium 的状态都在数据目录的数据库里（任务详述、组织树与章程预算等），换机器带走数据目录即可；旧状态的导入每类只做一次，记在 `state_imports` 表，重复启动不重复导入。数据目录保存业务数据库、任务目录（worktree 之外的提示词与日志）、用户令牌 `user-token` 与服务登记 `service.sqlite`（均为 `0600`）。服务与执行者只继承白名单环境变量，不继承 `*_API_KEY`、`*_TOKEN` 等凭据；执行者的模型凭据走各 CLI 自己的配置目录。令牌丢失或需要作废时运行 `atrium auth rotate`。凭据、数据库与登记文件不要提交或分享。

## 开发与验证

```bash
npm ci
npm run check          # 类型检查与全部测试
npm run format:check
```

装好的包直接加载发版时编译的 `dist/`（esbuild 把 `cli/`、`server/`、`shared/` 编成 JS，发版流程把它提交到版本标签上，`main` 不含 `dist/`），不在每次启动时编译 TypeScript，服务也没有常驻的 esbuild 子进程；仓库里（有 `.git`）照旧用 tsx 跑源码。`npm run dist` 在本地编译，`npm pack` 前会自动编译；`npm run bench:cli` 编译后起隔离服务，量 `atrium --help`、`status`、`task ls` 的启动耗时（中位数超过 150 毫秒失败，`ATRIUM_BENCH_LIMIT_MS` 可放宽）。

`npm run e2e` 走一遍主路径端到端（`scripts/e2e-main-path.mjs`，macOS、Linux、Windows 共用，CI 三平台各跑一遍）：`npm pack` 后装进临时 prefix，在临时 HOME、隔离数据目录与空闲端口上，用假 Claude Code 走 `atrium` → `task add/run/wait` → `org tree` → `quota` → `events wait` → `restart`（在跑的执行者由新服务按 pid 接管、收尾按日志判完成）→ `stop`，每步有断言，失败时打印哪一步、命令输出、服务日志与执行日志末尾，并保留临时目录。`--tarball 包.tgz` 装已打好的包（如拷进 Linux 虚拟机跑），`--bin` 用已装好的包。派活要求工作仓库所在磁盘至少空 15 GB，`/tmp` 是小 tmpfs 的机器设 `TMPDIR` 指向大盘。

开发时从仓库入口起隔离服务，不碰 4310 上的安装版：

```bash
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium node bin/atrium.mjs
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium node bin/atrium.mjs stop
```

| 目录              | 职责                                                         |
| ----------------- | ------------------------------------------------------------ |
| `bin/`、`cli/`    | 命令入口与各命令实现                                         |
| `server/`         | 服务生命周期、单实例登记、用户认证、重启监督与升级           |
| `server/tasks/`   | 任务账本、执行者适配器与档案、派活、关卡、看门狗、额度、事件 |
| `server/org/`     | 组织树：节点、章程、能力卡、硬边界、修订                     |
| `server/imports/` | 启动时把旧状态（任务详述、根章程预算）导入数据库，幂等       |
| `server/skills/`  | 组织技能：修订、绑定、派活挂载、回收提议与三方合并           |
| `tests/`          | 纯函数与接口测试；派活用假执行者和临时仓库                   |

仓库规范见 [AGENTS.md](AGENTS.md)；代码约定写在对应目录的 `AGENTS.md`。
