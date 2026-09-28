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
atrium task tree                                                # 不写根：未完成的顶层任务（每页 30 个，--after 翻页）与最近 10 个已结束的；--all 按短号翻全部顶层
atrium task plan                                                # 在跑、就绪、等待中、卡住；上游交付 PR 的，PR 合入才算满足，合入 Atrium 自身的要等上线
atrium task show t2                                             # 详情与最近事件
atrium task note t2 "端到端已验证" --verdict ok                 # 秘书对上线结果作一句话标注                                 # 处理备注，最新一条显示为当前说明
atrium task set t3 --status blocked                             # 人工修正状态；running 只能由执行者进入
atrium task set t1 --status cancelled --with-children           # 取消总任务并连带取消没结束的子孙（在跑的先停，已完成的不动）
atrium task ls --status todo                                    # 按状态列；--parent、--after 翻页
atrium task done t3                                             # 人工完成，触发下游排期
```

**详述进库**（#355）：`--brief 文件` 在建任务时把内容读进账本（至多 64 KB，超了报错并提示精简），`--brief -` 从标准输入读；派活、审阅、`task show` 都用库里的内容，原文件之后改了或删了都不影响，`brief_path` 只记来源。`task set tN --brief 文件|-` 换详述，`--brief ''` 清空。升级前只存了路径的旧任务，服务启动时按路径回填一次；读不到的记日志、保留路径，派活时报错并提示 `atrium task set tN --brief 文件`。

**总任务**（t190）：任务一旦有子任务就是总任务——不再派给执行者（`task run`、`task pick` 与自动派发都回「tN 是总任务，派它下面的子任务」，已在排队的撤出），交付物对它不生效；它的状态与进度由全部子孙里的叶子推出：有叶子在做（执行者在跑，或交付后在审阅、合入、等上线）→ 在做；否则有失败或卡住的 → 卡住（写出是哪几个）；全部取消 → 取消；其余全部已上线或完成 → 已上线；否则待办／等待中。进度是「已上线或完成的叶子 / 叶子数（不算取消的）」，多层递归按一条有界的递归查询算（至多 5000 个子孙，超出写「+」）。账本里总任务的状态跟着走：全部完成存 `done`、全部取消存 `cancelled`、其余存 `todo`（从不写 `running` / `blocked`），依赖它的下游、`task wait tN`、`task ls --status` 照常认；自己正在跑（拆活的执行者还没退出）的不动，用户取消的不改回来。运行时替父任务建的专员审查、会审意见不算子任务。`task show`、`task tree`、`task ls` 显示汇总状态与进度，如 `t174 [在做 5/12] 离开电脑也能拍板 · 总任务 · 在做 2（t181、t183） · 卡住 1（t185）`；`atrium top` 与状态栏把同一总任务下的行归到一起（状态栏并成一行「▸ t174「离开电脑也能拍板」 5/12 · 在做 t181 …、t183 …」，等你拍板的照旧单列）；全景任务行里总任务可展开看直接子任务。**通知**：叶子的完成、上线等事件照旧投给负责它的 leader；秘书只收总任务级的——没有 leader 管的叶子卡住时收「tN 下的 tM 卡住要你」（`total_stuck`），全部子孙上线或完成时收一条「tN 整体已上线（x/x）」（`total_online`，带各叶子的端到端验证摘要；同一进度只发一次），叶子本身的上线不再另抄秘书。取消总任务时下面还有没结束的子孙会先问一句，带 `--with-children` 才连带取消，回执列出取消了哪些。已有带子任务的父任务升级后按这条规则显示，自身已有的 PR 与交付记录保留作历史、不再派。

**规划任务**（t275）：大总任务先交给一次性执行者规划，leader 只拍板。`atrium task plan-for t197`（或建任务时 `task add 标题 --plan`）在总任务下建一个规划任务（帮手子任务，不让总任务因它变成「有子任务」；不交 PR、不建 worktree、只在本机跑），执行者只读仓库与详述，在工作目录写 `plan.json`：整体思路和至多 30 件子任务（标题、详述要点、先后依赖、大小、建议的专员与执行者、归属部分）。要切小：每件只做一件事，目标是一个执行者半小时左右交付，超过的继续拆；每件必标大小（小／中／大），没写执行者时小的建议快的（`cursor+auto`）、中大的建议强的（`claude+opus:high`），排期自动派这些子任务时先试建议的执行者，派不出去再按候选挑；只有真依赖才写先后，能并行的不硬串。任务完成时运行时校验清单：合格的投「规划待采纳」（`plan_ready`）给负责的 leader，读不到或不合格投 `plan_failed` 写明原因。leader 用 `atrium task adopt-plan t305 --dry-run` 看清单，`atrium task adopt-plan t305` 一条命令采纳：按依赖先后在总任务下批量建子任务（详述带来源，开自动派，就绪的由排期派出；请不动的专员记进详述、不挡采纳；归属部分只能是总任务所在部分或其下），一件建不起来整批不建，同一份只采纳一次；要改就 `--dry-run --json` 存成文件改好后 `--file 清单.json`；不合适 `atrium task reject-plan t305 --note 原因`，再 `plan-for` 重来。选项单拍板建的总任务，运行时自动先派规划任务（只在默认数据目录的服务缺省开，`ATRIUM_AUTO_PLAN=1/0` 显式开关）；规划任务派不出去时投 `plan_failed`。分身里「规划待采纳」算大事，单独一个分身处理，不挡日常事件。

状态：`todo` → `running` → `done` / `failed` / `blocked`，或 `cancelled`。PR 任务过交付关卡后另有 `（审阅中）→ 排队合入 → 合入中 → 已合入 → 已上线` 阶段（已上线只用于 Atrium 自身仓库）。任一上游失败或取消，整条下游链都不会就绪。上游合入的是会自动上线的仓库（Atrium 自身）时，下游等它「已上线」才就绪（新命令上线后才用得上），`task plan` 与状态栏写「等 tN 上线」，上线失败按上游卡住处理；不自动上线的仓库（如 OpenQuota）合入即满足。

## 派活与执行者

执行者 = 工具 + 模型（+ 思考强度），写作 `工具+模型[:强度]`。支持的工具：`claude`、`codex`、`opencode`、`kimi`、`grok`、`agy`、`cursor`（须已装在 PATH 上）。

`agy` 是 Antigravity CLI，一个账号（额度账号 `antigravity`）下有 Gemini、Claude、GPT-OSS 几族模型，`agy models` 列出可选的。缺省模型 `claude-opus-4-6-thinking`。强度按 agy 自己的规矩：gemini 模型名自带强度的直接用（`agy+gemini-3.8-flash-high`），也可写基名加强度（`agy+gemini-3.8-flash:high`，与 `--effort high` 等价）；模型名已带强度再写不同的 `:强度`、或给 `claude-*`、`gpt-oss-*` 写强度（它们不接受 `--effort`），派活时直接报错，不静默丢弃。agy 支持运行中捎话（`--input-format stream-json`，补充排在本轮之后另起一轮）与按会话续上（`--conversation`）。

`cursor` 缺省模型 `auto`（Cursor 自己挑），额度账号 `cursor`（经 OpenQuota 读）；强度写进模型名后缀，`cursor+gpt-5.3-codex:high` 交给 `--model gpt-5.3-codex-high`，`auto` 不能指定强度。新接入没有交付记录，档案没写时按 `trust: unknown`、`max_risk: low`（只接低风险、合入前另派审阅），交付记录攒够后用 `atrium workers edit harness/cursor` 升。

```bash
atrium task add "回复一句话" --deliver none
atrium task pick t4                         # 看候选（只读）：能不能接、账号额度、正忙、交付记录，最上面是推荐与理由
atrium task run t4 --worker claude          # 派给执行者；不写 --worker 按额度挑，--risk 缺省 low
atrium task run t5 --urgent                  # 紧急：走紧急通道（抢占、快车道、10 分钟没进展换人）
atrium task add "修弹窗" --urgent --stopgap "atrium host pause h3; atrium task stop t1,t2" --avoid-host h3  # 先止损再派修复
atrium task run t7 --worker agy             # 还在排队的任务：改派执行者（及 --risk），排队位置不变；新执行者空着就立刻拉起
atrium task set t6 --priority 普通           # 管方面的部分开的任务缺省「闲时」，改成普通照常排
atrium task run t6 --host h2                 # 派到指定的执行机器；不写在能接的主机里挑最空的
atrium task wait t4 --timeout 600           # PR 任务等到合入或卡住；其他任务等到离开 running
atrium task log t4                          # 执行者日志；--follow 跟到结束，--after 字节偏移续读
atrium task stop t4                         # 停执行者或合入队列；合入中会在安全点停下
atrium task merge t4                        # 关卡已通过且带 PR 的受阻任务重新排队合入；专员否决的由负责的 leader 判断后放行
atrium task tell t4 "接口改用 v2"            # 给在跑的执行者捎话；作者按认证身份记为 u1 或 aN
atrium top --once                           # 谁在干活、全景图上两层各块的状态与在跑数，下接排期
atrium top --once --depth 3                 # 全景展开三层（旧写法 --goals-depth 照旧接受）
```

**球在谁手里**：服务给每个未结束任务一个 `holder`（`top --json` 的行、`task show`）——执行者在做（`worker`）、合入流水线（`merge`：审阅、排队合入、合入中、等发版）、排队（`queue`）、leader aN 在处理（`leader`）、秘书（`secretary`）或等你拍板（`user`），附一句经过，如「本地检查没过 · a1 已交回执行者」。判定在 `server/tasks/holder.ts`；`top` 与状态栏按它显示，不再从状态或 PR 自己猜。

`atrium top` 的**全景**段（#322，取代原来的目标段）列出根下两层的各块：状态点（● 有任务在跑、✕ 有任务卡住、○ 空闲）、人话名、子树里在跑／卡住／待办的任务数（按任务的归属部分计，没有归属时按负责节点）和一句「是什么」；`--depth N` 展开至 N 层（1～8），超出行数折叠并提示 `atrium map`。`top --json` 带 `map` 字段（与 `/api/map/tree` 同形），供状态栏读取。

下面是**排期**：就绪的（记账节点、是否 `--auto`、负责人）、依赖链（同一条链按先后缩进，标题给出最长路径）、等待中的（逐项列出在等谁：上游状态、在跑的执行者与已跑时长、上游交付 PR 的合入状态、外部 PR 条件）与因上游失败或取消卡住的；任务行标出归属部分 `oN`（迁移前的旧任务标里程碑 `gN`），总任务不进排期、只作分组标题。就绪、等待中与卡住的件数和状态栏、`task plan` 用同一个函数算（`server/tasks/plan-count.ts`，`/api/tasks/plan` 的 `counts`），口径一致。行数超出折叠并提示 `atrium task plan`，`--json` 带 `plan` 字段。

派活时运行时建 worktree（没有仓库时用任务目录下的 `work/`），把标题、详述（`--brief`）、岗位章程、仓库 `.agents/README.md`、执行者档案正文和通用约束拼成提示词，以白名单环境在独立进程组拉起执行者；服务重启不带走执行者，重启后按 pid 接管或判失败。

**本机减负**（#358）：同时在跑的执行者超过上限（缺省核数的 3/4，`ATRIUM_MAX_WORKERS`），或本机太忙时，新派的活落库排队，有执行者结束或降下来后按入队顺序自动拉起。「太忙」有两条线：主线只看 Atrium 自己起的进程树（执行者及其子进程、本地检查、合入检查）占了几个核，超过核数的 3/4（8 核即 6 核，`ATRIUM_BUSY_CORES`）才暂停，系统进程再忙也不挡；整机 1 分钟负载只留一条保护线（缺省 4×核数，8 核即 32，`ATRIUM_BUSY_LOAD`），防止整台机器已经卡死时还往上加。进程树按平台统计：Linux 读 `/proc`，macOS 用 `ps`，Windows 经 PowerShell 查性能计数器；两次采样之间退出的短命进程（`node --test` 每个测试文件一个子进程）也算上——Linux 按父进程收回的子进程累计，macOS 按整机忙碌时间减去看得见的进程、差额按进出进程里 Atrium 的占比估算。父进程退出后被 1 号进程收养的子孙（后台留下的测试、执行者起的隔离服务）照样算 Atrium 的：Linux 认执行者带的 `ATRIUM_SPAWN` 标记（子孙继承）；macOS 的 `ps` 读不到进程环境，改看这类进程的工作目录是否在某个任务的工作树里、启动时刻是否在任务起止之间（`lsof`）。任务结束 30 分钟后还活着的这类孤儿，巡检时结束并记日志；认不准的不动（Windows 不认、不清理）。`task show` 的排队原因、`atrium top` 抬头与状态栏写清是哪条线：「本机太忙（Atrium 自己占了 6.3 核，超过 6）」「本机太忙（整机负载 35，超过 32）」「本机同时最多跑 N 个执行者」；`top --json` 的 `host` 字段给出负载、Atrium 占的核数、在跑数、上限与 `paused_by`（`own` / `load` / `full`）。已在跑任务的重试、续上不受限。本地检查同时最多跑核数的一半（`ATRIUM_MAX_CHECKS`），其余排队；单次最多 30 分钟（`ATRIUM_CHECK_TIMEOUT_MINUTES`，每台主机按自己的环境设）；执行者与本地检查的环境带 `ATRIUM_TEST_CONCURRENCY`（缺省核数减 1，与 `node --test` 自己的缺省一致），仓库测试脚本据此限并发（本仓库的 `npm test` 传给 `--test-concurrency`）。

**紧急任务**（t113、t215 紧急通道）：`task add … --urgent`、`task set tN --urgent|--no-urgent`、`task run tN --urgent`（派的同时标上）。有紧急任务时全系统先保它：

- **谁能标**：用户、秘书随时可标；leader 可标但必须写原因（`--why …`，建任务、改任务、派活时都认），并知会秘书与用户（`urgent_marked`）；不加审批。`task show` 写明谁标的、为什么。同时进行的紧急任务多于 2 个时，回执、`top` 与状态栏提示「紧急任务有 N 个，太多就等于没有紧急」，不拒绝。
- **先止损**：`--stopgap "atrium host pause h3; atrium task stop t1,t2; atrium host clean h3"`（分号、换行或 && 隔开，atrium 可省；接口也收结构化数组 `[{kind:"host_pause",host:"h3"}]`）。只认这三种动作，不执行任意命令；只有紧急任务能写，leader 不能写（会越过它的权限）。建任务（或 `task set --stopgap` 改写）时立刻逐条执行，结果记进 `stopgap` 事件、回执逐条写 ✓/✗；派修复时还没执行过的先执行。`host clean hN`（也可单独 `atrium host clean hN`）停掉 Atrium 在那台跑的非紧急执行者，再结束最近一天已结束任务仍活着的执行者进程树：本机由服务、远程主机由那台的 `atrium agent` 核对（命令行里是那个工具、启动时刻落在任务建立与结束之间，用户自己开的同名工具不碰），整树结束（Unix 进程组，Windows `taskkill /T /F`）。回执逐条列出任务、pid 与工具，每条记进所属任务的 `leftover_killed` 事件；远程离线或代理太旧时写明没清成。
- **立刻拿到资源（抢占）**：主机满了或太忙、独占工具被占着时，先暂停在跑的闲时任务，没有闲时的再暂停普通任务（同一档先停最晚拉起的），紧急的不暂停；独占工具被普通任务占着就暂停它、等它让出后立刻拉起。被暂停的任务转受阻，记下会话与工作树（`task_preemptions`），`top` 与状态栏写「被紧急 tN 抢占暂停，之后自动续上」；紧急任务都不在跑、启动或排队后自动续上：同一执行者且能续会话（claude）就续原会话，否则把说明写进提示词在原工作树重派。暂停与续上各记 `preempted` / `resumed` 事件（知会级）。
- **挑最快最稳的执行者与主机**：不写 `--worker` 时不看额度富余，按交付记录的一次通过率（记录少的向 0.5 收拢）、通过率差不到 5 个点时看中位耗时、正忙的最后；额度保留、trust / `max_risk`、依赖照旧。主机先挑不用抢占的，同样时本机优先；任务写了 `--avoid-host hN[,hM]` 的主机（派活与本地检查）一律不去，被暂停的主机也不派。
- **快车道**：合入前的检查插到最前立刻跑、不占并发名额，本机是检查基准平台就在本机跑（不去远程传提交、装依赖）；要合入前审阅的，先进合入队列、审阅并行，审阅打回就开一件跟进任务（附审阅意见）投给负责人，合入不受影响；有紧急任务在合入流程里（排队合入、合入中、已合入等上线）时，其他任务的合入先暂停（`merge_paused`，看板写「合入暂停：等紧急 tN 先上线」），正在合入的普通任务在发出 gh 合入前让路、回到排队合入的原位置（`merge_yielded`），紧急的上线后再继续；合入后每 15 秒催一次上线，发版了立即自升级，不等普通任务的合入。
- **盯到底**：紧急任务的执行者连续 10 分钟（`ATRIUM_URGENT_IDLE_MINUTES`）没有进展就按上面的挑人顺序换一个不同工具的执行者，在原工作树接着做（前一位留下的改动保留，提示词说明），不等 20 分钟卡死判定；至多换两次，之后交给普通看门狗。开始、止损、抢占、检查、交付、合入、上线（附端到端验证）、失败、受阻、卡死重试、换人各阶段投一条 `urgent_stage` 给秘书与用户：只有上线、卡住（换人也没进展，报卡死）、止损动作有一条没做成要处理，叫醒秘书并推到手机；其余阶段是知会，进 `events digest` 与状态栏，不叫醒（同一任务未确认的按这两档各合成最新一条）。

只认 `tasks.urgent` 字段，标题以「紧急：」开头的旧任务不自动转换；`task show`、`top`、状态栏与全景任务行显示「紧急」。

**闲时任务**（t136）：归属部分是管方面的部分（安全、性能、体验…，`org_nodes.aspect`）或在它下面的任务，建时缺省「闲时」，其余「普通」；`task add … --priority 闲时|普通` 覆盖，`task set tN --priority …` 随时改（换归属部分时，没被人改过的档位跟着新部分的缺省走）。派发先后是紧急 → 普通 → 闲时：闲时任务只有在没有普通任务在等同一类执行者时才派——同一工具的普通任务在排队，或别的普通任务只是在等本机空位（执行者满或太忙），都让它们先；普通任务在等的是自己那个工具（独占工具正忙、额度用尽）不挡别的工具。巡检自动派发同一轮里先派普通任务、闲时的最后派。已在跑的闲时任务不打断。这只是排序，不是配额，也不加关卡；紧急的闲时任务按紧急算。回执写「闲时：排在普通任务后面，有空闲执行者才派」；`task plan`、`top`、状态栏与全景任务行标「闲时」，排队中的写「等空闲：前面还有 N 件普通任务」（按当下的队列现算）。升级时在途的管方面任务补成闲时。

**捎话**（`task tell`）按工具能力分三档：Claude Code 以 `--input-format stream-json` 拉起、标准输入保持打开，补充作为新的用户消息即时写入，在工具调用边界读入，回显后记为已送达；codex 与 cursor 不能运行中追加，本轮结束后用 `codex exec resume <会话>` / `cursor-agent --resume <会话>` 带着补充续上原会话，关卡按续上后的结果判；其余工具停掉、保留工作树、把补充写进提示词重派。档案 `tell: stdin|resume|restart` 可改成工具支持的其他方式。每条捎话记一条 `tell` 事件（作者、时间、送达方式、是否送达），`task show` 与 `top` 可见；任务不在跑时留到下次拉起写进提示词。

**派活候选**（`task pick tN [--risk …]`，只读）：一行一位候选执行者——能不能接（没装、档案 `max_risk` 低于任务风险、`avoid_jobs` / `avoid_nodes` 避开、额度用尽标记、触及根章程保留份额、`billing=metered`；trust 低于 medium 的注明合入前另派审阅）、账号额度（已用、富余、距重置、扣掉保留份额后还剩多少）、是否正忙（独占工具，派了会排队）、此组合在干活的专员下的交付记录（次数、一次通过率）。最上面是推荐与一句理由（如「推荐 claude+opus：前端专员优先、claude 富余 +54%；codex 富余 −13%」），最后一行是 `atrium task run tN --worker <推荐>`；`--json` 给全部字段。候选顺序：干活的专员的优先执行者（按交付记录调整后的顺序）里能接、不正忙的在前，其余能接的按账号富余从多到少，正忙的独占工具最后；读数超过 10 分钟没刷新（OpenQuota 的旧数，自带读取器同一口径）的账号不算富余、当作没有富余数据排在后面，表格与理由写「旧数（N 小时前）」；专员第 1 选超速（富余为负）而另有能接、不正忙、trust 至少 medium（且够接任务 risk）的候选富余为正且多出 30 个百分点以上时，改推荐那一位（专员候选优先），理由写「后端专员第 1 选 codex+gpt-6-sol:high 超速（codex −17%），改用第 2 选 claude+opus:high（claude +52%）」。理由只对照最多两个相关账号。`task run` 不写 `--worker`（含 `--auto` 自动派）时按同一份顺序挑，回执写「按额度挑了 X，因为…」；写死 `--worker` 且不是推荐的那位时，若另有候选按同一判定（同一个 30 点阈值）更富余，回执加一行提醒（不拦），按推荐写死不提醒。`task add --parent` 建出的子任务回执下一步是 `atrium task pick tN`（顶层任务仍提示拆子任务）。

**执行者档案**存在数据目录的数据库里，每次改动留修订。三层叠加：`harness/<工具>` ← `models/<模型>` ← `combos/<工具>+<模型>`。每份档案是 frontmatter + 正文：frontmatter 是规则（`trust`、`max_risk`、`checks`、`limits`、`model`），叠加时以最具体的一层为准（写了就整项取这一层，能放宽，`checks: []`、`limits: {}` 表示撤销上层的加查与上限；`billing` 任一层是 `metered` 就按 `metered`）；正文原样附进提示词，其中 `## 交付记录` 一段作备注保留、不附进提示词（交付事实以交付记录表为准）。库里没有档案时用内置缺省（适配器的默认模型）。首次启动若 `ATRIUM_WORKERS_DIR`（缺省 `~/Atrium/workers/`，只有默认数据目录才有缺省；另给 `ATRIUM_DATA` 的隔离服务不读主目录，要导入须显式设置）存在，把其中的 `*.md` 导入一次；读不了、名字不合法或超过 64 KB 的单个文件跳过并记日志，其余照常；导入后不再读这个目录。

```bash
atrium workers ls
atrium workers show harness/codex
atrium workers edit combos/codex+gpt-6-sol --trust medium --checks pr_exists,finished --reason 连续五次一次通过
atrium workers edit models/grok-4.6 --file grok.md
cat grok.md | atrium workers edit models/grok-4.6 --file -
```

**验收关卡**：执行者退出后，运行时自己查事实（PR、提交、改动规模、CI、issue 评论），按档案 `checks`（`finished`、`pr_exists`、`local_check`、`file_growth`、`claims_verified`、`screenshots`）判定 `done` 或 `blocked`，原因写进任务事件，不采信执行者自述。全量检查一次交付只跑一遍：`local_check` 交给合入队列在 rebase 后跑，交付关卡不重复跑。远端 CI 不挡合入，没有 `ci` 关卡；档案里写了不认识的关卡名（含旧的 `ci`）派活时忽略，`atrium workers show` 给警告。`screenshots` 要求 PR 正文附 Markdown 图片或 GitHub 图片附件链接，所有截图的 HEAD 请求均返回 200。

**检查没跑成不算执行者没过**（t204）：合入队列的全量检查结果分三类——**过**、**没过**（有失败用例且不是基础设施问题）、**没跑成**（主机离线、没派过去、代理没来领、检查进程被杀、检查命令找不到（退出码 127 或 command not found，多是工作树没装依赖）；或超时／失败但失败用例全是仓库登记的时长敏感用例）。时长敏感用例登记在仓库的 `.agents/timing-sensitive`（每行一段用例名或测试文件路径，`#` 开头是注释），运行时从 `origin/<基础分支>` 读，执行者在自己分支里改的不算数；只登记真起后台服务、按墙上时间等待的集成用例。没跑成的不交回执行者、不叫醒 leader：放回队尾，队列暂停一会儿（1、3、5 分钟）再重跑，上一轮没跑成的主机先不派。最多重跑 3 次，仍没跑成才转卡住，原因写「基础设施问题：检查没跑成（已自动重跑 3 次）：…」。等重跑期间状态栏与 `task show` 的「球在谁手里」写「检查没跑成，等重跑（1/3）」，`task show` 的「本地检查」一行写最近一次是过、没过还是没跑成；`merge_check` 事件带 `outcome`（`passed` / `failed` / `not_run`）与 `reruns`，每次重跑记 `merge_check_rerun`。判定在 `server/tasks/check-outcome.ts`。

**卡住 5 分钟就提醒**（t260）：本地检查、合入检查、远程检查的日志 5 分钟（`ATRIUM_QUIET_MINUTES`）没有新输出，记 `merge_check_quiet` 并知会负责的 leader（`check_quiet`，不叫醒），状态栏写「检查 5 分钟没输出：卡在 tests/a.test.ts」；又有输出了状态栏恢复。10 分钟（`ATRIUM_CHECK_STALL_MINUTES`）没有新输出就结束这次检查并分类：日志里已经有失败用例的判**没过**，失败用例照旧交回；没有失败用例的判**没跑成（卡住）**，记下卡在哪个测试文件，按上面的规则自动重跑，卡住的只重跑一次，再卡住转卡住。「卡在哪」取测试运行器的心跳：`npm test`（`tests/run-tests.ts`）某个测试文件 1 分钟没有用例结束就往日志打一行「仍在跑：tests/a.test.ts（已 N 秒）」，之后每分钟再打；这行不算检查有输出。执行者 5 分钟没进展（日志不增长、没有工具调用、工作目录没变化）同样先记 `worker_quiet` 并知会、状态栏写「claude+opus 5 分钟没进展」；原来 20 分钟的卡死判定与紧急任务 10 分钟换人照旧。判定在 `server/tasks/check-quiet.ts`、`worker-quiet.ts`。

**自动合入**：PR 任务过交付关卡后进入持久化的串行合入队列。运行时从仓库 `origin` 核对 PR，rebase 到最新默认分支，在任务 worktree 重跑 `.agents/check`（没有则 `npm run check`），通过后用检查过的头提交执行 `gh pr merge --squash --match-head-commit`；gh 查询与合入都明确带 `-R`。rebase 冲突、本地检查失败或 gh 合入失败会把文件名、失败用例和日志位置写进事件及补充说明，在原工作树与原分支重派原执行者；第三次交回转卡住并通知负责人。合入中断后从账本续上，`atrium task show tN`、`atrium top --once` 和 `atrium org show oN --detail` 可看阶段。远端 CI 仍只供参考，不挡合入。

**合入前审阅**：任务 `--risk high`，或执行者档案 `trust` 低于 `medium`（没写按 `unknown`）时，PR 先进「审阅中」：运行时另建一个 `审阅 tN：…` 任务（`--deliver none`），自动挑一个与原执行者不同工具、不同模型且 `trust` 至少 `medium` 的执行者，按清单只读审代码，最后一行写 `审阅结论：通过` 或 `审阅结论：打回`。通过进合入队列；打回把意见交回原执行者，与冲突、检查失败共用交回次数，第三次转卡住；最后一行结论没按格式写时，运行时先请同一审阅者续上会话补答一次（专员审查、会审意见与汇总同样）；审阅者失败、补答后仍没结论、挑不到人或被停止才转卡住并通知负责人。审阅任务本身不单独投递事件；进审阅时在原任务上发 `review_queued` 事件，带改动规模摘要（文件数、增删行数、改动最多的文件），`atrium task show tN` 可看审阅任务与事件。

**自动上线**：合入的是服务自身仓库（`ATRIUM_UPDATE_REPO`，缺省 `liu-zhengdong/atrium`）的 PR 时，运行时每分钟拉一次标签，等发版工作流打出含该合入提交的版本；版本比运行中的新就执行 `atrium update --to <版本>` 与 `atrium restart`（在跑的执行者由新服务接管），新服务起来后把任务标为「已上线」，给负责人发 `online` 事件「tN 已上线（vX）」并附执行者在 PR 正文里写的「端到端验证」一节（派活时的通用约束要求写这一节）。同一版本只自升级一次：升级或重启失败（含 supervisor 回滚）发 `online_failed`；合入 30 分钟仍未发版发一次 `release_overdue`。自升级缺省只在用默认数据目录（`~/.atrium`）的安装版上开；开发中的 git 检出、测试与另给 `ATRIUM_DATA` 的隔离服务不动全局安装，停在已合入（`ATRIUM_SELF_UPDATE=1` 强制开、`=0` 关）。其他仓库只到已合入。

**上线后验证**（t181）：标记已上线的同时，PR 里有「端到端验证」一节就在原任务下建一个验证子任务（只交摘要、不开 PR、只在本机跑），按 `ATRIUM_VERIFY_WORKERS` 的顺序派便宜执行者（缺省 `opencode+opencode-go/deepseek-v4.1-flash`，没装或拉不起来换 `cursor+auto`），在真实环境照着逐条跑，结果写进工作目录的 `verify.json`。验证任务结束后运行时把结论记进原任务事件 `verified`：每条命令、输出摘要（截断并抹掉疑似令牌、密钥）、是否符合期望、总结论（通过／没通过／无法验证），`task show` 里逐条列出；有一步不符合即没通过，有做不了的步骤即无法验证。PR 里没有这一节只记 `verify_none`，不派人；都派不出去记无法验证。验证执行者的提示词写明硬规矩（凭据不进输出、不读钥匙串与登录文件、不做真实登录、不启真实额度读取、不改仓库公开范围、不花钱、不动个人资料），进程另带 `ATRIUM_VERIFIER=1` 与 `ATRIUM_QUOTA_READERS=off`：命令行只连在跑的服务、不拉起，拒绝启停、重启、升级、`auth`、`chat` 与 `agent`。验证执行者不能在真实环境停别人的活（t239）：命令行给真实服务的请求带验证身份头，服务端对它拒绝止损类写接口——`host clean`、`host pause` / `resume` / 登记 / 移除、停别的任务（停自己可以）、标紧急、写止损动作、连带取消、启停升级服务与轮换令牌，回执「验证任务不能做止损操作，这一步记 unverifiable」；提示词要求这类步骤记 `matched=null` 并说明，能在隔离环境验证的用临时 `ATRIUM_DATA` 与另一个 `ATRIUM_PORT` 起隔离服务、配假执行者去那里跑（验证执行者自己起的隔离实例不受这层限制）。执行者写「端到端验证」时，有破坏性的步骤标注「只在隔离环境」或「需要人工」，验证任务据此不在真实环境跑。`online` 事件照旧附验证步骤，并注明验证任务 `verifier`；派了验证任务的 `online` 只是知会（不叫醒负责人，也不再另投秘书），没派人的（PR 没写这一节、验证任务建不起来）仍要负责人处理。

**验证之后**（t182）：通过就结束，谁也不叫醒。没通过或无法验证时，按原任务的负责人或归属部分找最近的 leader（找不到投秘书；总任务下没有 leader 管的叶子，秘书收「tN 下的 tM 卡住要你」）投一条要处理的事件 `verify_failed` / `verify_unverifiable`，附现象（不符合的步骤在前，每步命令、期望、实际输出摘要，至多 5 步，已抹凭据）和开修复任务的命令；由 leader 决定开修复任务，运行时不自动回滚。`atrium top` 的状态列写「已上线 · 验证中／验证没过／无法验证」（最近动作列写原因、等谁处理或谁已看过，抬头计数「验证中 N · 验证没过 N · 无法验证 N」），没过的在看板上留 24 小时；状态栏写「验证中 · 执行者 用时」或「验证没过 · 等 aN 处理」（事件确认后不再占状态栏），验证任务由原任务那一行代表；`task show` 多一行「上线验证：验证没过（tM）：原因 · 等 aN 处理」。

**新能力先试点**（t236，只是做法与默认值，不设关卡）：问题多出在新能力和已有能力的组合上（远程主机 × 窗口隐藏、紧急 × 负载统计之类），靠测试挡不住，所以三件事连成一套：① 执行者在 PR 正文写「碰到哪些已有能力」一节，列出这次改动与哪些已有能力交叉（远程主机、Windows、紧急通道、总任务、技能挂载、合入队列、自升级……）、各验了什么，没碰到写「无」（派活的通用约束与 `.github/pull_request_template.md` 都带这一节）；② 上线后运行时照「端到端验证」一节在真实环境跑（见上面「上线后验证」）；③ leader 先在小范围用新能力——一台主机、一两个任务、一个部分，优先试 PR 里列出的组合，跑通再放开，放开前在那件任务上写一句 `atrium task note tN "试点结果：在哪试、跑了什么、结果如何"`。leader 唤醒提示词与 `atrium guide` 写了这条做法。

**看门狗与自愈**：日志、工作区、结构化事件长时间没有进展判卡死；供应商或网络临时错误先同一执行者重试、再换人重派；思考耗尽单次输出直接换人；额度用尽的账号打标记，到点前不再派。

## 执行机器（远程执行者）

服务仍是唯一的账本与调度中心，执行者可以跑在任何接入的机器上（#358 第 1 步）：用户自己的其他电脑、云主机、本机的 Linux 虚拟机都行，只要装了 Node 24+ 与 Atrium、能连到服务。本机固定是 `h1`，接入的主机依次是 `h2`、`h3`…（短号持久、移除后不复用）。

```bash
atrium host add 书房台式机 --repo liu-zhengdong/atrium --max 4   # 登记并拿一次性接入码（30 分钟内有效）
atrium host edit h3 --ssh cpcli@100.70.239.117 --tunnel 4310:14310  # ggb：服务自管反向 SSH 隧道
# 在那台机器上（服务地址换成它连得到的：SSH 转发、内网穿透、VPN；OrbStack 虚拟机用 http://host.orb.internal:4310）：
atrium agent --server http://127.0.0.1:4310 --token h2-接入码         # 前台常驻；之后重启只要 --server
atrium host ls                        # 各台状态（在线、离线、待接入）、系统与核数、编码 CLI 及是否登录、在跑几件
atrium host show h2                   # 一台的详情与在跑的任务
atrium host show h3                   # SSH 隧道状态、最近错误、远端代理服务地址
atrium task run t6 --host h2          # 派到 h2；atrium task wait / task log --follow 在本机照看
atrium host pause h2                  # 暂停往 h2 派新活（在跑的照跑）；host resume h2 恢复；本机也可以 pause h1
atrium host clean h2                  # 止损：停掉 Atrium 在 h2 跑的非紧急执行者，再结束那台上已结束任务留下的执行者进程树（逐条列出）
atrium host remove h2                 # 令牌作废，那台的代理随即停下；有在跑的任务时拒绝
```

带 `--ssh` 的主机由 Atrium 服务拉起 `ssh -N -R`，隧道断开后自动重连，服务关闭时结束子进程；`--tunnel` 写本机服务端口:远端监听端口。接入命令里的 `--server` 自动使用远端监听端口。代理首次接入后记住服务地址，以后可直接运行 `atrium agent`。ggb（h3）上线后先用 `host show h3` 确认隧道与代理在线，再停用旧的 Mac launchd 隧道。

- **代理主动连服务**：`atrium agent` 用长轮询领指令，远程机器不用开入站端口；服务只听本机 `127.0.0.1`，跨机器可用 Atrium 自管 SSH 隧道，也可用已有的转发、穿透或 VPN（明文 HTTP 跨公网时代理会提示改用 HTTPS 或 SSH 转发）。接入码只能用一次，换成这台主机专用的令牌，存在那台机器的 `~/.atrium-agent/agent.json`（`0600`，`ATRIUM_AGENT_DATA` 可改目录）；令牌只能领派给这台的指令、上报这台的日志与结果，碰不到任务账本、组织和别的主机。
- **在那台机器上干活**：服务写好提示词、算好路径，代理在自己的数据目录里克隆仓库（用那台机器上的 git 凭据）、按同一规则建工作树、按同一份适配器拉起执行者，环境同样走白名单并带 `ATRIUM_WORKER=1` 与按那台核数算的 `ATRIUM_TEST_CONCURRENCY`。编码 CLI 的登录留在那台机器上，不经服务传输。组织技能随拉起指令带过去（内容与修订号），代理在那台的任务目录里按同一套规则挂载（Windows 上建不了软链时目录用 junction、文件用硬链接），提示词里的技能路径是那台的；执行者改了副本，代理随退出把改过的传回，服务照常生成修订提议。代理版本旧或挂载出错时照样拉起，记 `skills_skipped` 并在 `task run` 回执写「组织技能没挂上：原因」；自动挑主机时要带技能的活优先派到能挂的主机。
- **事实与关卡不变**：日志按字节偏移传回本机任务目录，`task log`、`top`、看门狗照旧读它；改动规模、提交在那台的工作树里查（经代理，git 只接受查询与清理用的子命令），PR 与 CI 仍由服务查 GitHub。合入队列在本机按 PR 头另建一个工作树来 rebase、重跑检查、合入，合入后连同那台上的工作树一起清掉。
- **断线与重启**：断线期间执行者照跑，日志与退出记在那台机器上，重连后补传；服务重启后先按账本接管远程的这一轮，代理自动重连，对账时补报重启期间的结束、结束账本已不认的进程。代理自己重启也不带走执行者，按运行记录接着看。主机离线时不判卡死；这时 `task stop` 先在账本收尾，重连后代理结束那个进程。
- **本地检查派到空闲主机**（#358 第 2 步）：合入队列 rebase 后的检查，在本机也是候选的前提下按负载挑一台：远程要在线、没暂停、`--repo` 登记过这个仓库、与仓库的检查基准同平台、检查没超那台的并发（代理按那台核数报 `ATRIUM_MAX_CHECKS` 的缺省）；本机有空位、每核负载不比最空的远程高出 0.5 以上就留在本机（省掉传提交、装依赖）。派过去的是提交，不是工作树：代理在自己的克隆里 fetch 基础分支，服务把本机有、远端还没有的提交（rebase 后的提交）打成 git bundle 带过去（凭据留在那台，不经服务），代理把自己的检查工作树（每个克隆几份，依赖留着下次用）切到这个提交，`package-lock.json` 变了就 `npm ci`，再跑同一套 `.agents/check` / `npm run check`。本机工作树有没提交的改动时只在本机检查。检查日志按字节偏移续传回本机任务目录（断线后补齐再交结果）；结果、日志路径、在哪台跑的（`host`）、检查的提交（`commit`）记进 `merge_check` 事件，`task show`、`top` 在检查进行中写「合入中：在 h2 上重跑本地检查」。那台离线超过 1 分钟、超时或取不到提交时，记一条 `merge_check_moved`，换一台或回本机重跑；服务不再等的检查由代理停下，晚到的结果对不上已丢掉的指令，不会算第二次。合入本身仍在本机，关卡判断不变。检查基准平台缺省是本机 h1 的平台，仓库可在 `.agents/check-platform` 写 `darwin` / `linux` / `win32` 另配；别的平台的主机照常接执行者的活，但不跑把关检查（它们专有的偶发失败不该把任务交回执行者），那些平台的全量结果由远端 CI 记录作参考，`atrium host show hN` 的「把关检查」一行写明这台跑不跑。
- **挑主机**：指定 `--host` 只看那台（离线、暂停、没装或没登录这个 CLI 时拒绝并说原因，满了或太忙就钉在那台排队）。不指定时在能接的主机里挑最空的，一样空本机优先；远程主机只自动接 `--repo` 登记过的仓库（`*` 全部；不登记只自动接没有仓库的活），体验巡检只在本机跑。独占工具与执行者上限按主机分开算。`task pick` 列出推荐的执行者在各台能不能跑、自动派会去哪台；`top` 的执行者列带主机短号，并多一行各台状态。

## 每类东西放哪

用户纠正了、要立新规矩，先对这张表写到对应位置；Agent 看同一张表：`atrium guide`「每类东西放哪」。

| 这句话说的是                                   | 放在                               | 例子                         |
| ---------------------------------------------- | ---------------------------------- | ---------------------------- |
| 怎么做好一类事：方法、口味                     | 技能（随纠正留修订）               | 字要少、一行一件事           |
| 这类活由谁干：交付什么、用哪些技能、优先执行者 | 专员说明（短，引用技能，不写做法） | 前端：先出设计稿、交付附截图 |
| 某一块产品必须守住什么                         | 要点（挂在那一块）                 | 常用命令 150 毫秒内          |
| 某个执行者的毛病与叮嘱                         | 执行者档案                         | grok 别往一个文件堆          |
| 用户定的目标、底线、预算                       | 章程                               | 留 20% 额度、不花钱          |
| 当时为什么这么定                               | 决定记录                           | 负责人按功能块配             |
| 现在在等什么、下次先看什么                     | 备忘                               | 等 t201 上线重跑检查         |
| 跟着代码走的约定                               | 仓库 `AGENTS.md`                   | 状态判断写纯函数             |

判断顺序：先问是不是做法或口味（→ 技能），再问是不是某一块的约束（→ 要点），再问是不是某个执行者（→ 档案）；专员说明只写分工。

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
atrium quota                  # 各账号按富余从多到少（旧数排后并标「旧数（N 小时前）」），标出来源、读不到的原因和额度用尽待恢复的；--json 给脚本
atrium quota --clear claude   # 人工解除运行时的额度占用（误判时用），记事件并立即派发排队任务
```

**多台主机合并**（#358 第 2 步）：每台主机的代理用同一套自带读取器读那台登录的 CLI 额度，每 5 分钟（及每次连上时）上报；只传额度数字、套餐名与账号指纹（账号 id 的 sha256 前 16 位，不含令牌与账号 id 本身），凭据不出那台机器。服务按账号指纹合并：同一账号在几台都登录只算一份、取最新读数；本机读不到而别的主机读到时用它并注明「读自 h2」；两台登录的是不同账号时，本机那个算数，说明里写明另一个没算进来。`atrium quota` 与挑执行者都用合并后的结果，表格多一列「主机」写这个账号的 CLI 能在哪几台用（在线、没暂停、装了且没判为未登录；`--json` 的 `hosts`、`from`）。

额度由 Atrium 自己读（「来源」列写「自带」）：服务进程读各工具本机已登录的凭据，调供应商的用量接口，只读、不刷新对方凭据；同一账号成功缓存 5 分钟、失败 1 分钟，限流按 Retry-After 推迟，读不到时 6 小时内沿用上次读数并注明。目前覆盖 Claude Code、Codex、OpenCode Go：

| 账号     | macOS                                                                   | Linux                                                                      | Windows                                   |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| claude   | 钥匙串「Claude Code-credentials」，再退回 `~/.claude/.credentials.json` | `~/.claude/.credentials.json`、`$XDG_CONFIG_HOME/claude/.credentials.json` | `%USERPROFILE%\.claude\.credentials.json` |
| codex    | `~/.config/codex/auth.json`、`~/.codex/auth.json`（`CODEX_HOME` 覆盖）  | 同左                                                                       | 同左（`%USERPROFILE%` 下）                |
| opencode | `~/.local/share/opencode/auth.json` 的 `opencode-go`                    | `$XDG_DATA_HOME/opencode/auth.json`，缺省同左                              | 同左（`%USERPROFILE%` 下）                |

自带还没覆盖的账号（kimi、grok、antigravity 等），本机装了 [OpenQuota](https://github.com/liu-zhengdong/OpenQuota) 就用它补（`openquota pace --json`，`ATRIUM_OPENQUOTA_BIN` 可改路径），自带读不到的账号也先用它补并注明；都没有就显示「没有额度数据」，挑执行者退回档案顺序与运行时的额度用尽标记。给用户留的份额只读组织树：派活按任务所在节点章程链中最严的 `quota_reserve_percent` 保留每个账号的用户额度，根章程没写时缺省 20%；`atrium quota` 表格下一行写明份额与出自哪份章程（`--json` 的 `reserve`）。旧的 `~/Atrium/charter.md` 不再读取：用默认数据目录的服务首次启动时（隔离服务只认显式的 `ATRIUM_LEGACY_DIR`），若根节点缺某项预算（`quota_reserve_percent`、`money`）而旧章程 frontmatter 的 `budget` 里有，就导入一次写进根章程（留修订），之后改预算用 `atrium org edit o1 --charter`。章程文件的 `budget` 仍可用旧写法（`quota_reserve_percent: 20`、`money: 0`），写入时折成对应的边界参数；磁盘下限（`disk_min_free_gb`）不再使用，旧写法里写了会丢掉，库里留着的旧条目照读不报错、也不拦派活。

## Claude Code 状态栏

```bash
atrium statusline     # 一屏概况：未结束任务各在谁手里、leader 在处理什么、秘书未处理事件、接下来就绪与等待的数目
```

末行是下一步命令（`--json` 的 `next` 同一条）：有等你的任务给 `atrium task show tN`，有就绪的给 `atrium task plan`，其余给 `atrium top`。

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
atrium leader escalate "看过，同意" --kind shipped --event 589 --as a1        # 转交下层 a2 上交给自己的 #589，附一句意见
atrium org stages atrium --file 阶段.yaml --reason 推进     # 只改节点的阶段记录，其余章程不动
```

- **投给谁**：任务没写 `--owner` 时，从任务的归属部分（`--part`，旧任务的归属节点次之，都没写沿父任务往上找）向上找最近的、已登记的 leader；找不到投秘书。事件的 `routed` 写明投给谁、为什么。写了 `--owner`（包括 `--owner secretary`）就按负责人投。过程事件（合入、退回等知会）也投给 leader，但只有「要处理」的才唤醒它。
- **按事唤醒**：leader 有要处理的事件时，攒批 30 秒（`ATRIUM_LEADER_BATCH_SECONDS` 可调），用登记的执行者组合起一次性进程（单次上限 20 分钟，`ATRIUM_LEADER_TIMEOUT_MINUTES` 可调）。只有默认数据目录的服务缺省唤醒；另给 `ATRIUM_DATA` 的隔离服务（压测、验收）库里有 leader 也不起真进程、不耗额度，事件留在收件箱，要唤醒设 `ATRIUM_LEADER_WAKE=1`（`=0` 在默认目录也关）。提示词附该节点的全景上下文（与 `map context` 同一段）、备忘、这批事件、过程摘要、可用命令、权限边界与上交规则；处理完 `events ack` 后退出。退出非零或没确认完算失败，释放事件稍后重试；连续 2 次失败或超时，把没确认的事件转交上一层（秘书）。处理期间同一任务又有新结果合并进来的，下次唤醒再送，不随旧内容一起确认。
- **分身**（t275）：同一位 leader 可同时有几个唤醒（分身），缺省至多 3 个，`atrium leader edit a1 --clones N` 改（1～8，1 就是从前的一次一个）。每个分身认领一件事或一棵任务树：任务事件按所属的最近总任务分组（自己是总任务就是自己，否则是父任务；专员审查、规划这类帮手跟父任务走），同一组同一时刻只归一个分身，组被占着的新事件等它结束再送。日常事件（上线、交回、卡住……）合成一个分身；大事（规划待采纳、会审结论）一棵树一个分身；两边各给对方留一个位置，日常事件不再被大事挡住。分身动别的分身认领的任务（重派、停、改、捎话）服务端回冲突，记备注不拦。备忘多分身共用：有别的分身在跑时 `memo edit` 只写自己认领那件事的分段，不互相覆盖；只剩一个分身时它写的就是合并后的全文（清掉它开始时已看到的分段，之后别人新写的留着）。`leader show`、`atrium top`、状态栏显示「a1 正在处理 2 件：t197 规划待采纳；t84 上线」，`GET /api/leaders/a1` 的 `clones` 列出各分身认领了什么。
- **权限**（服务端按每次唤醒签发的 leader 令牌判定，不靠提示词）：可以在负责的节点及子节点建任务（不写 `--part` 默认记到负责的节点）、派活、重派、捎话、停、记备注、请专员与会审，任务牵涉到自己负责的部分时记备注与捎话，改这些节点的要点、阶段与全景人话字段，给这些节点排周期任务（`schedule add/pause/resume/run/rm`），写自己的备忘，给子节点指派下层 leader，确认投给自己的事件。不可以动别的部分的任务、改章程与边界预算、建节点、拍板会审、改技能与额度、登记 leader，也不能启动、停止、重启或升级服务；越权返回中文说明并提示 `atrium leader escalate …`。
- **上交**只有四类：`shipped` 已上线（里程碑完成，须带 `--task`，说明里附端到端验证）、`cross` 需要别的部分配合、`beyond` 越过权限／预算／硬边界、`stuck` 搞不定（卡住多次、拿不定）。生成一条投给上一层 leader（没有就秘书）的「要处理」事件 `escalated`，带 `--task` 时任务上也记一笔。转交下层 leader 投给自己的上交时不另起一条：`--event` 给那条的编号（不给时按同任务、同类型认最近一条，未确认或确认不到 6 小时的），上一层收到的仍是一条，`from`、`reason` 是下层原文，`forwarded` 逐层记「谁看过、一句意见」；原事件替转交人确认掉，唤醒收尾时不会再转交一次。
- **连续性**存在 Atrium：节点要点、阶段、交付记录与 leader 的备忘和决定记录，不靠进程上下文。`org tree`、`map --json`（`leader_state`；`lead` 是这一块归谁管，含从上级继承的）、`atrium top` 显示每个节点的 leader 与最近一次唤醒、在处理什么（人话，如「t84 上线」）。
- **看得到**：全景网页每块标题下有「负责人」一行（名字与在处理什么，点开是负责人页），顶栏在它处理时写「Atrium 负责人在处理」；leader 建的任务在任务行注明「Atrium 负责人派的」，备注作者给名字（`task ls/show` 显示「Atrium 负责人（a1）」，接口字段 `note_by_name`）。状态栏读 `GET /api/leaders` 的 `busy`：`[{ref, name, doing, clones, since}]`，只列正在处理的 leader（`clones` 是同时在跑的分身数），空闲为空数组。

## 备忘与决定记录

秘书（`secretary`）和每位 leader 在 Atrium 里各有一份备忘；决定记录用户（`u1`）、秘书、每位 leader 各一份。换机器、换秘书都接得上；记多了也不撑爆上下文：默认只给摘要，全部按节点或关键词查。

```bash
atrium memo show                                   # 备忘与决定摘要（新会话、换人接手先跑这一条）；--as a1 看 leader 的，--as u1 看用户的
atrium memo edit "在等 t97 上线，先看合入队列"        # 覆盖写，上限 2000 字；--file 文件；--as a1 写 leader 的；leader 有别的分身在跑时只写自己那一段
atrium decision add "额度读取不依赖 OpenQuota" --why "要迁到别的设备" --by u1 --issue 352   # 追加，得到 dN；--by u1 记进用户那份
atrium decision add "…" --why "…" --by u1 --date 2026-09-26 --task t80 --node atrium --node o5   # 补记旧决定、关联任务与一个或多个节点
atrium decision add "中文；汇报要短" --why "…" --by u1 --node o1 --principle   # 标为原则：摘要里总列出
atrium decision ls --node o3 [--all]               # 挂在 o3 及其上级的决定（谁记的都算）；不给 --node 列 --as 那一份
atrium decision search 额度 [--node o3] [--all]      # 按关键词查（决定与原因里，空格隔开的词须全部命中）
atrium decision tag d7 --node o3                   # 给已有决定补挂节点（可多次 --node）
atrium decision mark d7 --principle                # 标为原则；--normal 改回普通
atrium decision supersede d1 --by d3               # d1 标为已推翻、指向 d3（也可在 add 时 --supersedes d1）
atrium decision unsupersede d1 --why "标错了"       # 推翻标错了：恢复为有效，记一笔谁撤销的、为什么
atrium decision settle d7 --new-point o3 "测试不依赖本机真实环境"   # 已成规矩的沉淀成要点；或 --point k4 指向已有的
```

- **备忘**写当前状态（在等什么、下次先看什么），每次覆盖；leader 的 `leader edit --memo` 与 `memo edit --as aN` 写同一份。**决定记录**写取舍与原因，只追加：每条有日期、谁拍板（`--by u1`／`secretary`／`aN`，缺省是记录的主人）、决定、原因，可选关联 issue、一个或多个节点、任务；推翻时指向新决定，旧的留着可查。短号 `dN` 全局持久、不复用。
- **记进谁那份**：用户拍板的（`--by u1`）进用户那份（`u1`），秘书和 leader 的记录只放各自的决定；早先记在秘书那份的「u1 定」启动时迁到用户那份，短号不变。leader 转记用户拍板的、没给 `--node` 时自动挂它负责的部分。
- **摘要**（`memo show`、leader 唤醒提示词、全景网页）：标了原则的全列，再加最近 15 条，整段约 3000 字，放不下的只给一行「另有 N 条，用 decision ls --node / decision search 查」。秘书的摘要含用户的决定；leader 的是自己的，加挂在它负责的部分（含下级）及上级节点上的。已推翻、已沉淀成要点的不进摘要，`--all` 查得到。
- **沉淀成要点**：已成规矩的决定用 `decision settle` 挂成要点（要点的权限照旧，根节点只有用户能改）；决定标「已沉淀到 kN」、缺省列表不再显示，要点记来源 `dN`。
- **整理**：leader 例行巡检时提示词里有一条「顺带看本部分的决定：能合并的合并、被取代的标推翻、已成规矩的沉淀为要点」，只是提示，不是关卡。
- 和全景「要点」的区别：要点是执行者要守的产品约束，派活时附进提示词；决定记录是用户、秘书、leader 回看的「为什么这么定」，不附给执行者。
- `--as` 是记录的主人，缺省秘书；leader 进程里缺省是自己，且服务端只许读写自己的（`?as=` 锁定），整理（`tag`、`mark`、`settle`、`unsupersede`）也只能动自己那份。
- 全景网页：组织根属性行的「秘书」「你的决定」点进秘书页（`/map#secretary`）与用户页（`/map#u1`）；负责人页（`/map#a1`）在备忘旁有「决定记录」页签；有决定挂在本块或上级的块页多一个「决定」页签。都只显示摘要，切「全部」可往下翻、按关键词查，只读。

## 资料

各部分自己的资料（设计稿、调研报告……）挂在组织节点上，存进数据目录，不再只躺在任务工作树里。短号 `mN` 全局持久、不复用。

```bash
atrium material add o4 docs/design/t120-tasks --note "t120 任务视图的设计稿" --for t120   # 挂文件或目录；--name 改名，--supersedes mN 标旧的被取代
atrium material add o4 docs/design/t120-tasks        # 同一节点同名的再加：新版本 v2（内容没变不加），旧版留着
atrium material ls [--node o4] [--archived]          # 短号、名称、一句话、版本、大小、最近谁读过
atrium material show m1                              # 版本、关联、谁读过、清理线索
atrium material get m1 [--out 目录] [--version 1]     # 取到目录下（按名称落盘，已存在就报错）
atrium material archive m1 --note "已按新设计上线"     # 只归档不删：不进清单和提示词，可 restore
atrium material keep m1 --note "下一版还要对照"        # 线索说疑似没用、决定留下：写原因，之后不再提
atrium material stale [--node o4]                    # 疑似没用的；看全部时另列可以真删的
atrium material rm m1                                # 真删（只有用户）
```

- **大小**：单个版本至多 20 MB、500 个文件，超了先压缩或把大文件放到网盘、仓库，只在 `--note` 写链接。隐藏文件（以 `.` 开头）不收并在回执里说明；目录里指向目录外的软链接直接报错。路径拒绝 `..`、绝对路径、隐藏段。
- **派活**：`map context`（派活附进提示词的那段）只附本节点及上级资料的清单（短号、名称、一句话，近的在前、至多 8 条），归档的、被取代的不列；执行者按需 `atrium material get mN`。这是执行者环境里唯一能对用户服务用的命令：只读、不拉起服务，读取记在任务上（运行时给执行者注入 `ATRIUM_TASK`）。
- **清理线索**：各部分的周期任务（`schedule`）到点建出一轮时顺带看这一块的资料，疑似没用的（被新资料取代，或 90 天没人读且 `--for` 关联的任务、要点、决定都已结束）列成一条 `material_stale` 投给这一块最近的 leader；leader 用 `archive`（可恢复）或 `keep --note 原因`（之后不再提）定，没定的隔 30 天再提。归档超过一年且全部版本大于 10 MB 的列成 `material_purge` 投给秘书问用户，只问一次；用户点头才 `material rm`。
- **权限**：leader 能在负责的部分里加、归档、恢复、留下，哪儿的资料都能取，不能真删。
- 全景网页节点页有资料时多一个「资料」页签（只看；取与归档走命令行）。

## 凭据

各部分自己的令牌、密码（机器人 token、某个接口的 key……）挂在组织节点上，按「节点 + 名称」找，名称就是注入执行者时的环境变量名。值只存不显示。

```bash
atrium secret set o4 TELEGRAM_BOT_TOKEN              # 值从标准输入读：终端里不回显；也可 < 文件 或管道；同一节点同名的覆盖
atrium secret ls [--node o4] [--archived]            # 名称、节点、设于、最近使用（时间与任务）、清理线索；不显示值
atrium task add 发通知 --part o4 --secret TELEGRAM_BOT_TOKEN   # 任务声明要用（多个用逗号）；已有任务 task set tN --secret 名称
atrium secret archive o4 TELEGRAM_BOT_TOKEN --note "换了新号"   # 只归档不删：派活不再注入，可 restore
atrium secret keep o4 TELEGRAM_BOT_TOKEN --note "年底续费要用"  # 线索说疑似没用、决定留下：写原因，之后不再提
atrium secret rm o4 TELEGRAM_BOT_TOKEN               # 真删（只有用户）
```

- **存哪**：值在数据目录 `secrets/`（目录 0700、文件 0600），库里只有名称、时间与谁设的；不进日志、事件、提示词、网页，没有读值的接口与命令。
- **名称**：大写字母开头、只含大写字母数字下划线（三平台一致）；执行者环境本来就有的系统变量（`PATH`、`HOME`……）、运行时自己设的与会改变程序加载方式的前缀（`ATRIUM_`、`NODE_`、`GIT_`、`LD_`、`DYLD_`……）不许用。值至多 16 KB，更大的挂成资料。
- **派活**：任务 `--secret` 声明的，派活那一刻按任务归属部分往上找（同名取最近一层、归档的不算），以同名环境变量注入该执行者——白名单环境之外的唯一例外，按名称逐个放行；远程主机随拉起指令带给代理，服务与代理都只放内存。建任务、改声明时就查一遍，找不到报错并给 `secret set` 命令；派活时缺了或已归档就不拉起。提示词只写「可用的凭据」名称与挂在哪，叮嘱执行者不打印、不写进文件与回复。执行者自己打印出来的 Atrium 管不住，所以声明要用才给。
- **清理线索**：各部分的周期任务到点时顺带把这一块 90 天没用过的（从没用过按设值时间算）列成一条 `secret_stale` 投给这一块最近的 leader；leader 用 `archive` 或 `keep --note 原因` 定，没定的隔 30 天再提。
- **权限**：leader 能在负责的部分里设值、归档、恢复、留下，不能真删；执行者环境里 `secret` 命令一律拒绝。

## 产品部

产品部管一块东西的演进：定期调研、提一份选项单给用户拍板，只调研和提选项，不自己立项、不写代码。它不是组织级唯一的，可以设在任何节点下（每个节点一个），两个项目都要演进就各设一个，各管各的。

```bash
atrium product add atrium --every 7d --at 09:30    # 在 atrium 下成立产品部：建部分、登记 leader、挂每周一轮的研究
atrium product ls                                  # 各产品部：管哪一块、leader、研究节奏与下一轮
atrium schedule run s3                             # 不等到点，马上跑一轮研究
```

- **一条命令建好**：在节点下建一块普通部分（人话字段写好它管的是这一块的演进）、登记它的 leader（`--worker` 不给时沿用往上最近的 leader 的执行者）、挂一条 `--kind research` 的周期任务（缺省每周，`--every`、`--at` 可改；以后用 `schedule pause/resume/rm` 管）。
- **每轮研究**：任务详述按模板现取材料——这一块的全景（是什么、能做什么、怎么走完、组成、现状、接下来）、最近的选项单（还在等拍板的不重复提）、有效的决定记录（含上一轮没选的「这轮不做 X」）、巡检发现、近 30 天失败或被打回的任务、完成与上线的任务；研究者可以上网看同类产品与社区动向，只在工作目录写 `choice.json`，不写代码、不开 PR。研究任务只在本机跑。
- **收尾**：研究任务完成时运行时读 `choice.json`，登记成挂在这一块上的选项单（提的人记产品部 leader，出自这件任务），照下面「选项与拍板」的规则叫醒秘书或 leader；文件缺了或不合格不挡任务完成，错误和修补命令写进完成事件交给产品部 leader。

## 选项与拍板

产品部调查后把「这一块下一步做什么」写成一份选项单（`cN`，全局持久、不复用）挂在它要演进的节点上：3–5 个选项，每个写能多做到什么、为什么现在、代价、不做会怎样、依据（巡检发现 fN、失败任务 tN、决定 dN、外部链接），再加产品部推荐与理由。用户只做选择。

```bash
atrium choice ls --open                            # 等你拍板的在前、新的在前；--node atrium 只看这一块及下层
atrium choice show c3                              # 全文：每个选项的五项与依据，产品部推荐与理由
atrium choice pick c3 1 3 --note 选项2等额度宽裕再说   # 选中的在该节点下各建一个任务，没选的记成决定记录
atrium choice pass c3 --note 这周先收尾在做的         # 这轮都不要：每个选项连同原因记成决定记录
atrium choice add atrium --file 选项单.json --task t42  # 产品部提选项单（JSON：title、options、recommend、why）
atrium choice comment c3 先做看板过滤 --prefer 1 --basis f3   # 项目 leader、秘书写意见、标倾向、补依据（--basis 可写多次）
atrium product set atrium --decider leader         # 把这个节点（及没另设的下层）的拍板权下放给该节点的 leader；--decider u1 收回
atrium product show atrium                         # 看这个节点上的选项单现在由谁拍板
```

- **拍板**：选中的选项在该节点下各建一个任务，详述是选项全文、产品部推荐、拍板说明和各方意见，照常投给该节点最近的 leader 拆解；没选的每个记一条决定记录「这轮不做「X」（c3 选项 2）」，原因是拍板说明（没写就写明没写），主人是该节点最近的 leader（没有就是秘书），下一轮产品部读得到，情况没变就不再提。拍过板的不能再改。
- **谁拍板**：缺省是用户。用户可以用 `product set 节点 --decider leader` 把某个节点的拍板权下放：最近一个写了设置的节点说了算（下层写 `u1` 可以挡住上层的下放），拍板人是选项单所在节点往上最近的已登记 leader，找不到 leader 时仍由用户拍板。只有用户能改设置；不会自动下放。下放后用户仍然可以直接拍板。
- **谁能做什么**：秘书和 leader 能提（leader 令牌只能挂在自己负责的部分、下层或上一层——产品部管的是上一层的演进），也能在同样范围内写意见；拍板：用户令牌，或本机全景网页会话发起的同源请求（带 Origin），或拍板权已下放给的那位 leader，其他 leader 令牌拒绝。
- **通知与展示**：提好后项目 leader（选项单所在节点最近的 leader）收 `choice_review`，去写意见、补依据、标倾向，但不能拍板。拍板人是用户时，秘书收 `choice_ready` 被叫醒；已下放时改由那位 leader 收 `choice_ready`，秘书只收知会 `choice_notice`，状态栏和网页入口不算这份。有人写意见时秘书收知会 `choice_comment`。拍板后，秘书和 leader 那条都改成知会 `choice_decided`，不再叫醒。`atrium top` 与状态栏在第一行下面单出一行「等你拍板：c3 Atrium 下一步（4 个选项）」；全景网页组织根页顶部有「等你拍板：N」入口，节点页有「选项」页签（本节点与下层产品部的，等拍板的在前），勾选后可直接在网页上拍板。

## 推送到手机（Telegram）

不在电脑前时，三类事推到手机上的 Telegram：选项单等你拍板、上交到你这层（秘书）的卡住或越界（含会审要你拍板）、里程碑上线；另外紧急任务上线、卡住（换人也没进展）、止损没做成也推（如「【紧急任务卡住】t5 修线上」），同一任务同一阶段只推一次，开始、交付、检查、合入这些知会阶段不推。过程事件（派活、完成、失败、合入、CI）不推；推送只带类别、短号和标题（如「【等你拍板】c2 Atrium 下一步」），不带上交说明、选项内容等正文。

```bash
pbpaste | atrium notify token        # 先在 Telegram 找 @BotFather 建机器人；token 从标准输入给（Windows：Get-Clipboard | atrium notify token）
atrium notify bind                   # 在手机上点回执里的链接或给机器人发绑定码，收到就绑定这个私聊；默认等 120 秒
atrium notify test                   # 立刻发一条测试消息
atrium notify set --quiet 23:00-08:00 --batch 60 --proxy http://127.0.0.1:7890
atrium notify                        # 状态：机器人、是否绑定、免打扰、攒批、代理、待发与最近失败
atrium notify set --off              # 关掉（清空待发）；--on 打开；atrium notify remove 删掉 token 与绑定
```

- **凭据**：token 只存在数据目录的 `telegram.json`（`0600`，代理密码也在这里），不进数据库、日志、事件、提示词，不碰钥匙串；状态与报错里都不显示。token 只从标准输入读，不收命令行参数（免得进 shell 历史）。
- **攒批与免打扰**：同一窗口（缺省 60 秒）内的多件合成一条，一条最多列 15 件；免打扰时段（本机钟点，可跨午夜）里攒着，时段结束合成一条发；紧急任务的推送也一样，不绕过免打扰（夜里要收紧急推送就把免打扰关掉：`atrium notify set --quiet off`）。排队期间已拍板的选项单不再推。
- **代理**：`--proxy` 单独配的 HTTP 代理优先（只支持 `http://`，走 CONNECT 隧道），没配就走服务环境里的 `HTTPS_PROXY`/`ALL_PROXY`（遵守 `NO_PROXY`）；改了系统代理要 `atrium restart` 才生效。
- **失败**：网络、超时、429、5xx 退避重试（30 秒起翻倍，429 按 Telegram 给的等待时间），满 5 次放弃；token 错、机器人被拉黑这类不重试。失败写进服务日志，请求地址里的 token 抹掉。
- 只有用户能改设置，leader 令牌只能读状态。

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

同一份数据两张脸：人用网页看，Agent 用命令行读写；改动只走命令行，网页不提供编辑（#322），唯一例外是用户拍板选项单。

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
atrium map draft ~/code/openquota --node openquota  # 从本机仓库起草这一块的全景初稿（一次性执行者只读仓库）
atrium map apply t12 --dry-run                     # 看初稿和写进节点会改哪些字段；不带 --dry-run 才写进去
atrium patrol run atrium/cli                       # 手动巡检一条 uses 场景；下一次轮换到下一条
atrium patrol findings atrium/cli                  # 看发现及 leader 的处理结果
atrium schedule add atrium/cli --kind patrol --every 1d --at 09:30  # 每天 09:30 巡检一次
atrium schedule add atrium 周报 --every 7d --brief 周报.md          # 每周在节点下建一件普通任务
atrium schedule run s1                             # 马上跑一轮，不改下次时间
atrium schedule ls --node atrium                   # 列该节点及下层的周期任务；show s1 看最近几轮
atrium schedule pause s1                           # 暂停；resume 续上（暂停期间不补），rm 删除（sN 不复用）
```

体验巡检以当前用户环境使用安装版服务与默认数据目录；隔离服务启动时显式设置的 `ATRIUM_DATA`、`ATRIUM_PORT` 会传给巡检进程。巡检只看全景人话字段、帮助与命令回执，不读代码。巡检进程用 `atrium patrol report tN --phenomenon 现象 --step 步骤 --command 命令 --expected 预期 --actual 实际 --kind broken|awkward` 记发现；同节点同现象去重，已忽略的也不再报。任务结束后新增发现投给节点 leader，leader 开任务后用 `atrium patrol decide fN --task tN` 关联，或用 `--merge tN` 并入已有任务，或用 `--ignore 原因` 记下忽略理由。全景节点的「巡检发现」页签与 `map --json` 都显示处理结果。

周期任务（`schedule`，短号 `s1`…，全局持久不复用）：到点在该节点下生成一件普通任务并按 `task run` 同一条路派发（不写 `--worker` 就按 `task pick` 挑人；闲时/普通按节点缺省）。`--every` 写 `7d`、`1d`、`12h`、`2w`（至少 1 小时）；`--at 09:30` 定本机钟点，只用于整天的周期，不写就从添加时算起一个周期后第一轮。`--kind task`（缺省）建普通任务，可带 `--brief`、`--by`；`--kind patrol` 生成与 `patrol run` 同样的体验巡检（按 uses 轮换，节点没有 uses 时添加即报错）；`--kind research` 只调研、不交 PR。上一轮（todo / running / blocked）还没结束就跳过本轮并记一笔；服务停机错过好几轮只补一轮；建不出任务或派发失败记在 `schedule show` 的最近几轮里，并以 `schedule_failed` 事件投给该节点最近的 leader（找不到投秘书）。用户与负责该节点或其上级的 leader 都能增删改（leader 给自己的部分排巡检、调研），别的部分的周期任务 leader 只读。

- **网页**：服务自带（`/map`），只听 127.0.0.1、只接受本机连接。`atrium map` 用用户令牌换一个一次性链接（2 分钟内有效、只能用一次），浏览器打开后换成本机会话 cookie（HttpOnly、SameSite=Strict，7 天有效，服务重启后仍有效）；会话只能读全景（外加同源页面拍板选项单），写接口和其他接口仍要用户令牌。交互终端里直接打开浏览器，非终端、执行者环境或 `--no-open` 只打印链接。
- **布局**：一块一页。顶栏是面包屑（从根到当前块，可点回上层）和「在做 N 件」——数字是当前部分含其子部分的在跑数，专员页与执行者页显示全组织的「全组织在做 N 件」；下面是小字类别（组织／部分／管方面的部分／专员）、人话名与介绍。组织节点展示组成部分、任务、专员、要点与巡检发现（现象、步骤与命令、预期与实际、处理结果）。任务默认只看进行中，可切「全部」；「最近在做」一列里执行者写的 http(s) 链接（如 PR 地址）点得开，新标签页打开。
- **横跨部分**（#373）：组成部分里管方面的部分（如安全）名字旁标「管方面」，它的页头类别写「管方面的部分」、属性行「适用于」列出缺省适用的部分（没写为「整个 Atrium」），要点下一行小字写各自的适用范围。其他部分的「要点」页签另列别处适用于这里的要点，来自写成「安全 · 适用于网页」。任务行标题下写「也牵涉安全、命令行」（自动牵涉的悬停说明）；牵涉某部分却归别处的任务也列在那一部分的任务页签里，标题下写「归网页」。
- **专员按层**：部分页的「专员」页签只列属于这一块的专员，上级的、全组织的、牵涉部分的折成一行「还能请：全组织的 前端、后端」，点开（`/map#o4/roles/all`）一起列并在名字下注明属于哪儿；组织根列全组织共用的，属于各部分的折成末尾一行。专员页属性行多一项「属于」。
- **组织根**：页签是 **组成部分／负责人／专员／技能／执行者／要点／巡检发现**。负责人（负责哪几块、现在在处理什么或空闲、执行者，整行点进负责人页）。专员是全组织共用的名单，记录工作说明、技能、优先执行者、交付要求、审查目标与清单；技能显示用途、挂在哪位专员或部分、最近一次修订。执行者按组合 × 干活的专员统计交付次数、一次通过率（80% 以上绿、50% 以上黄、更低橙，少于 5 次标「数据少」）、平均打回、一般用时、出事与信任；右上角可按专员筛选。上方浅黄条显示 `atrium workers` 的升降建议，写「等秘书确认」，网页不给按钮，确认走 `atrium workers confirm`。
- **专员页**（`/map#r1`）：面包屑「全部 / 专员 / 前端」，属性行是优先派给、交付要求、技能；页签是任务（带进行中／全部）、谁做得好、技能。**执行者页**（`/map#w/claude+opus:high`）：属性行是信任、交付次数与一次通过、接过的专员；页签是交付记录（任务、专员、结果、用时、经过——事故、验收没过的原因、合入退回，冲突注明不算它的）与观察（执行者档案里带日期的记录，如「（2026-09-27 你纠正：……）」；冒号前没写人的算秘书记的）。**负责人页**（`/map#a1`）：属性行是负责哪几块（可点）、现在（在处理什么、几点开始；空闲时给上次处理的事）、执行者；页签是备忘（它记着的在等什么、下次先看什么）、处理过的事（投给它的要处理事件：任务、什么事、说明、结果——等它处理／在处理／处理完／转交上级）与上交（类型、任务、说明、交给谁、对方看没看）。找不到专员、执行者或负责人时，页面说明原因并给回到最上层的链接。
- **地址**：当前页、页签与筛选写在地址里（如 `/map#o2/tasks/all`、`/map#o1/workers/r1`、`/map#r1/workers`），刷新与前进后退回到原处；窄屏（≤ 720px）表格降为卡片式行，不横向滚动。
- **实时**：网页订阅 `/api/map/stream`（Server-Sent Events）。全服务一份变更检测（版本号，不扫全表），变了给所有打开的页推 `changed`，网页只重取并重画变了的区域；组织根首屏不取执行者统计，画完再补。另每 30 秒刷新一次执行者的最近动作与时长。
- **派活**：`map context` 的内容自动附进执行者提示词，与「章程要点」同一段、放在最前（任务有归属部分时取归属部分，否则取负责节点）；归属链之外再附「牵涉部分的要点」：任务 `--also` 牵涉的部分的要点，以及管方面的部分里适用于归属部分的要点（自动牵涉），每条注明来源（如「安全 · 适用于网页」）。全景这段不超过 1500 字，按「位置链 > 本块是什么 > 本块要点 > 上级要点与牵涉部分的要点 > 上一层是什么 > 现状 > 组成 > 更上层」保留，截了就在末尾给全文命令。提示词只附本任务用到的专员（干活的与请来看的）。
- **管方面的部分**（#373）：除了管东西的部分（命令行、网页、派活），还有管方面的部分（安全，以后可能有性能、体验），它们的要点横跨多个部分。`map add … --kind aspect` 建，已有部分可用 `org edit … --kind aspect|module` 改类型（只切「管方面」标记，留节点修订；project/org 不能改成 aspect；改回 module 前要先清掉要点与部分的适用范围，否则报错并列出命令），`map edit … --applies` 写它的要点缺省适用于哪些部分，单条要点可用 `org point-add/point-edit --applies` 覆盖；都不写即适用于整个上级。`map --json` 给 `aspect`、`applies` 与本块适用的别处要点 `points_applied`。
- **从仓库起草**（t186）：`map draft 仓库路径` 先由运行时只读地取 README 开头、两层目录（隐藏文件与 `.env`、密钥、证书、名字带 secret/credential 的文件不列）、最近 20 条提交和去掉内嵌凭据的 origin，排进详述，再按 `task run` 同一条路派一次性执行者（不交 PR、不建 worktree、只在本机跑）。执行者只读仓库、可用 `gh issue list` 看开着的 issue，在自己的工作目录写 `overview.json`（name、alias、analogy、what、uses、flow、parts）；任务完成时运行时读它、校验后存下，完成事件带 `draft: ready` 与下一步，读不到或不合格带 `draft_error`，不挡任务完成。`map apply tN --dry-run` 给你看初稿和写进节点会改哪些字段；确认后 `map apply tN --node 节点` 才写人话字段（没给的不动，组成部分留给建节点），同一份初稿只写一次，权限同 `map edit`。起草与写入只给用户令牌。
- **权限与修订**：`map edit` 的人话字段（what、uses、flow、alias、analogy、now、next、when）直接覆盖当前值，不留修订、无需 `--rev`；`--detail` 是章程正文，仍留章程修订，`--rev` 仅用于此。`map add` 的节点创建仍留节点修订，人话字段不留修订。硬边界、份额等组织规矩仍按章程修订。负责部门 leader 或其上级可改（`--as aN`），根只有你能改。

## 组织树

组织、项目、模块三类节点，短号 `o1`……，也可用路径（如 `atrium/runtime`）。每个节点有 leader、章程与能力卡，每次修改存一版历史；子节点的硬边界只能比父节点更严，显式分配给兄弟的份额之和不得超过父节点的可分配量。根章程只有用户 `u1` 能改（秘书拿用户令牌替用户改，`--as secretary`，修订如实记秘书），其余由节点 leader 维护（`--as aN`）。

**修订署名**：章程、节点、要点、全景、技能、专员、执行者档案、任务备注与捎话的修订与事件记在 `--as` 名下：`u1` 是用户本人，`secretary` 是秘书（权限同用户，只是如实署名），`aN` 是节点 leader。`atrium chat` 起的秘书会话与服务后台恢复的秘书进程带 `ATRIUM_AS=secretary`，这些命令缺省就带 `--as secretary`；在别处当秘书（如 Claude Code 会话）时设同样的环境变量或显式写 `--as secretary`。只有用户本人操作才记 `u1`。

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

章程 frontmatter 的 `budget` 分配份额，例如 `budget: { quota: { claude: 30, "*": 10 }, disk: 20, money: 0 }`。`quota` 数值是账号当前周期额度的百分点；具体账号覆盖 `*`。没有显式份额的节点使用父节点未分配给兄弟的共享池。`org show --charter --raw` 可导出并编辑。派活时按账号当前窗口用量估算节点子树的「约用」；份额不足 1 个百分点时换账号，全部不足则将任务置为受阻并通知节点 leader。OpenQuota 数据不可用时记录事件，不按份额拦截。节点 worktree 占满磁盘份额时也受阻（本机磁盘可用量不设下限，已合入或取消的任务工作树由运行时定期清掉）；档案 `billing: metered` 在钱份额为 0 时不可派。

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

`--ask` 至多请五位，执行中不能改，本轮交付后按各专员的 `review_goal`、`review_points` 与 `review_bottom` 派一次性审查任务；全部通过才完成；有否决或没出结论的留在受阻，交负责这件事的 leader（找不到交秘书）判断：认同就捎话重派，不认同就写明理由后 `atrium task merge tN` 放行（没有 PR 的用 `task done`），和专员谈不拢才上交。`task wait` 等到审查结论才返回。专员的 `invite_when` 可按关键词或路径提示是否该请，只提示、不自动请。`atrium specialist show rN` 可查看清单。

### 会审

影响面大、不可撤回的决定（公开仓库、归档旧代码、大版本）或疑难事故，由 leader 发起会审：`atrium review add 议题 --concerns 前端,后端 [--brief 议题.md] [--issue 号] [--leader 节点]`。

1. **议题**：建一个议题任务「会审：议题」（记在 `--leader` 节点上，缺省由秘书主持），每位受邀专员一个意见子任务（按专员清单、只交摘要），详述写明议题原文、关联 issue、全部受邀专员，以及该专员的章程目标、要点与底线。
2. **并行出意见**：意见任务同时派出，各是一个一次性执行者；摘要最后一行写立场：`意见：同意`、`意见：有条件同意：条件`、`意见：反对：原因` 或 `意见：否决：越过的底线`。失败、受阻或没写立场的算「没出意见」。
3. **leader 汇总**：意见都不再跑后，运行时把各方意见原文写进议题任务的详述（`council-summary.md`），拉起议题任务本身做汇总：写「一致」「冲突」两段，能定的自己定，碰到用户定的边界或谈不拢的每条写一行 `需用户拍板：…`，最后一行 `结论：…`。
4. **结局**：运行时读汇总记在议题上。专员否决由 leader 汇总时判断（认同就调整结论，不认同写明理由），谈不拢才标需用户拍板；汇总没写结论的先请 leader 补答一次。leader 标了需用户拍板、补答后仍没写结论、或专员都没出意见的转「需用户拍板」，投 `council_escalated`；其余转「已定」，投 `council_decided`。意见任务与汇总自己的完成不单独投递。`atrium task wait t9` 等到结局才返回。
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

派活时生效集合 = 节点链上绑定的 ∪ 执行者档案 `skills: [slug…]`（总是带）∪ `skills_for: { atrium/web: [slug…] }`（做该节点或其子节点的活时带），去重，每次最多 8 个；档案 `avoid_nodes: [atrium/web]` 让自动挑人避开。技能拷进任务目录，只对这次运行生效，不写用户全局配置、不写仓库工作树：Claude Code 用 `--plugin-dir <任务目录>/skills-plugin`，codex 用 `CODEX_HOME=<任务目录>/codex-home`（登录、配置、AGENTS.md、rules、plugins 和用户自己的 codex 技能软链回 `~/.codex`），opencode 用 `OPENCODE_CONFIG_DIR=<任务目录>/opencode`，其他工具只在提示词里给简介和 SKILL.md 路径。派到远程主机的由那台的代理用同一套规则挂在它的任务目录里（见「执行机器」）。

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

## 命令参考

全部命令的用法、说明与示例，和 `atrium --help`、`atrium guide` 出自同一份命令表（`cli/main.ts`，分组与示例在 `cli/guide.ts`）。下面标记之间的内容由 `npm run docs` 生成，改了命令重新跑一遍即可，不要手改；`npm run check` 会核对它和命令表是否一致。

<!-- 命令参考开始：由命令表生成，改命令后跑 npm run docs，不要手改这一段 -->

### 服务

```text
atrium
  启动或复用后台服务，输出地址

atrium status
  查看服务状态、地址和数据目录

atrium stop
  停止服务，保留数据；在跑的执行者由下次启动接管

atrium restart [--wait] [--timeout <秒>]
  平滑重启 Atrium 服务，随时可做：在跑的执行者不中断，由新服务接管
  示例：atrium restart

atrium update [--to <版本>] [--repo <仓库>]
  检查并更新 Atrium 版本，安装新版本并展示改动摘要
  示例：atrium update

atrium auth status
  查看当前本机用户身份、认证状态和连接的服务（不启动服务）
  示例：atrium auth status

atrium auth rotate
  轮换用户令牌；令牌丢失时凭本机实例控制凭据恢复
  示例：atrium auth rotate
```

### 任务

```text
atrium quota [--clear <账号>] [--json]
  列出账号额度；--clear 人工解除运行时占用并立即重派排队任务
  示例：atrium quota

atrium top [--once] [--json] [--interval 秒] [--width 列] [--depth N] [--as 订阅者]
  实时看谁在干活、全景图上两层各块的状态与在跑数，以及排期；--depth 展开全景层数；缺省每 2 秒刷新，q 或 Ctrl-C 退出
  示例：atrium top

atrium statusline [--json]
  Claude Code 状态栏：等你拍板的选项单、未结束任务各在谁手里（执行者、合入、leader、秘书、等你）、leader 在处理什么、未处理事件；服务不在只显示未运行，不拉起
  示例：atrium statusline

atrium task add 标题 [--parent tN] [--plan] [--part 节点] [--also 部分[,部分]] [--secret 名称[,名称]] [--by 专员] [--ask 专员[,专员]] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--urgent [--why 原因] [--stopgap 止损动作]] [--avoid-host hN[,hM]] [--priority 闲时|普通] [--from 节点] [--repo 路径] [--brief 文件|-] [--owner 订阅者] [--deliver pr|comment|none] [--issue 号]
  建任务；--plan 表示这是准备拆的总任务：建好就先派一个规划任务读代码与详述、出子任务清单（不改代码），清单好了负责的 leader 用 task adopt-plan 采纳；--by 指定干活的专员（派活附技能与交付关卡），--ask 请专员按清单审（可多位）；--part 写归属部分（负责与汇报只在这一处），--also 写还牵涉的部分（派活附它们的要点、可请它们的专员、知会它们的 leader；管方面的要点适用于归属部分的自动牵涉），--secret 写要用的凭据名称（先 atrium secret set 节点 名称；派活那一刻按归属部分往上找、以同名环境变量注入执行者，提示词只写名称），--from 写投任务的节点，--brief 附任务详述 md（建任务时读入存库，至多 64 KB；- 从标准输入读）；--urgent 标紧急，走紧急通道（没空位先暂停闲时再普通任务、按一次通过率与速度挑人、检查与合入插到最前、审阅不挡合入、合入后立即发版、10 分钟没进展换人；leader 标须 --why 写原因，并知会用户）；--stopgap 写先执行的止损动作（atrium host pause hN; atrium task stop tN,tM; atrium host clean hN，建好就执行并记事件）；--avoid-host 派活与检查避开这些主机；--priority 闲时|普通（不写按归属部分：管方面的部分缺省闲时，排在普通任务后面、有空闲执行者才派）；旧 --job、--concern、--role 暂可用
  示例：atrium task add 拆分登录模块 --parent t1

atrium task plan-for tN [--worker 工具+模型[:强度]]
  给总任务派规划任务：一次性执行者读代码与详述，写出子任务清单（标题、详述要点、先后依赖、大小、建议的专员与执行者、归属部分；每件约半小时交付，小的建议快的执行者、中大的建议强的），不改代码、不开 PR；清单好了负责的 leader 收到「规划待采纳」。选项单拍板建的总任务运行时已自动派；已有没了结的规划时报冲突
  示例：atrium task plan-for t197

atrium task adopt-plan tM [--dry-run] [--file 清单.json]
  采纳规划：按清单在总任务下批量建子任务（详述带来源、大小、建议的专员、先后依赖，开自动派），就绪的由排期自动派出、先试规划建议的执行者；--dry-run 只看清单不建；--file 用改过的清单（格式同 --dry-run --json 的 content，整份回执也认）；tM 给总任务时取它最近的规划；一件建不起来整批不建；同一份只采纳一次
  示例：atrium task adopt-plan t305 --dry-run

atrium task reject-plan tM --note 原因
  驳回规划：写明原因（下次规划照着改）；要重来再 task plan-for 总任务，可先 task tell 捎话补充
  示例：atrium task reject-plan t305 --note 拆得太碎，按模块合成三件

atrium task ls [--status S] [--parent tN] [--after tN]
  列任务，按短号升序，每页 200 条
  示例：atrium task ls

atrium task plan [--after tN]
  按在跑、就绪、等待中、卡住列出待办及依赖；--json 给脚本
  示例：atrium task plan

atrium task show tN
  看任务详情与最近事件
  示例：atrium task show t1

atrium task tree [tN] [--all] [--after tN] [--limit N]
  缩进树：短号、状态、标题、交付物、执行者、PR；不写 tN 列未完成的顶层任务（每页 30 个）与最近 10 个已结束的，--all 按短号翻全部顶层
  示例：atrium task tree

atrium task set tN [--status S] [--with-children] [--pr URL] [--by 专员|''] [--ask 专员[,专员]|''] [--from 节点|''] [--part 节点|''] [--also 部分[,部分]|''] [--secret 名称[,名称]|''] [--brief 文件|-|''] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--urgent|--no-urgent] [--why 原因] [--stopgap 止损动作|''] [--avoid-host hN[,hM]|''] [--priority 闲时|普通]
  人工修正状态（todo、done、failed、blocked、cancelled）；也可补登 PR 或改标题、干活或请来看的专员、归属部分、牵涉部分、要用的凭据（--secret，下一轮拉起按新的注入）、详述、交付物、依赖、自动派发、紧急（--urgent 走紧急通道，排队中的立刻按紧急重排；leader 标须 --why；--stopgap 写了就立刻执行；--avoid-host 派活与检查避开这些主机）和优先级（--priority 闲时 排在普通任务后面、有空闲执行者才派；普通照常排；在跑的不打断）；取消总任务时 --with-children 连带取消没结束的子孙（在跑的先停，已上线、已完成的不动）
  示例：atrium task set t1 --status done

atrium task note tN 文字 [--as 身份] [--verdict ok|fixed|rejected]
  追加处理备注（最多 300 字）；最新一条显示为当前说明
  示例：atrium task note t1 文字

atrium task tell tN 文字 [--as 身份] [--verdict ok|fixed|rejected]
  给在跑的执行者捎话：Claude Code 即时送入，codex 本轮结束后续上会话，其余停掉带着补充重派；不在跑的下次拉起时写进提示词
  示例：atrium task tell t1 文字

atrium task pick tN [--risk low|medium|high]
  看派活候选（只读，不派）：候选执行者能不能接、账号额度、是否正忙、在干活的专员下的交付记录，给出推荐与理由；--risk 缺省 low
  示例：atrium task pick t1 --risk medium

atrium task run tN [--worker 工具+模型[:强度]] [--risk low|medium|high] [--host hN] [--urgent [--why 原因]]
  派给执行者（服务持有进程）；不写 --worker 按额度挑（紧急任务按一次通过率与速度挑），--risk 缺省 low；--host 派到指定的执行机器（不写在能接的主机里挑最空的）；--urgent 同时标紧急走紧急通道：没空位先暂停闲时再普通任务，写了止损动作先执行（额度保留、trust、依赖照旧；leader 标须 --why）
  示例：atrium task run t1 --worker codex+gpt-6-sol:high

atrium task done tN
  人工完成任务；等同 task set tN --status done
  示例：atrium task done t1

atrium task stop tN [--as 订阅者]
  停掉执行者或合入队列；由此产生的事件不投给发起者本人（缺省 secretary）
  示例：atrium task stop t1

atrium task merge tN [--as 订阅者]
  将关卡已通过、带 PR 的受阻合入任务重新排队；受阻在专员否决或没出结论上的，负责的 leader 看过理由不认同时用它放行
  示例：atrium task merge t1

atrium task log tN [--follow] [--after 字节]
  看执行者日志；--follow 跟到任务结束，--after 从上次的字节偏移续读
  示例：atrium task log t1

atrium task wait tN [--timeout 秒]
  等任务结束（PR 任务等合入或卡住）或超时；缺省 300 秒
  示例：atrium task wait t1

atrium patrol run 节点 [--worker 工具+模型[:强度]]
  手动巡检节点：从 uses 轮换一条场景，在当前真实环境启动体验巡检任务
  示例：atrium patrol run o4

atrium patrol report 巡检任务 --phenomenon 现象 --step 步骤 --command 命令 --expected 预期 --actual 实际 --kind broken|awkward
  记录巡检发现；同节点同一现象只记一次，已忽略的现象不再报
  示例：atrium patrol report t1 --phenomenon 帮助缺少示例 --step 第一步 --command atrium-guide --expected 有示例 --actual 没有示例 --kind awkward

atrium patrol findings 节点
  查看节点上的巡检发现与 leader 处理结果
  示例：atrium patrol findings 节点

atrium patrol decide 发现 (--task tN | --merge tN | --ignore 原因)
  leader 处理发现：开任务后关联、并入已有任务，或忽略并写原因
  示例：atrium patrol decide f1 --ignore 已有同类改进计划

atrium schedule add 节点 [标题] --every 7d|1d|12h [--at 09:00] [--kind task|patrol|research] [--brief 文件|-] [--by 专员] [--worker 工具+模型[:强度]]
  周期任务：到点在节点下生成一件普通任务并派发（闲时/普通按节点缺省）；上一轮没结束就跳过本轮并记一笔，服务停机错过的只补一轮；--at 本机钟点（只用于整天的周期）；--kind patrol 生成与 patrol run 同样的体验巡检（标题可省），research 只调研不交 PR
  示例：atrium schedule add atrium/cli --kind patrol --every 1d --at 09:30

atrium schedule ls [--node 节点] [--all] [--after sN]
  列周期任务：--node 只看该节点及下层，--all 连已删除的一起列；每页至多 200 条
  示例：atrium schedule ls

atrium schedule show sN
  看周期任务：节奏、下次时间、详述与最近几轮（生成、跳过、失败）
  示例：atrium schedule show sN

atrium schedule run sN
  马上跑一轮（不改下次时间）；上一轮没结束时不起
  示例：atrium schedule run sN

atrium schedule pause sN
  暂停周期任务：到点不再生成
  示例：atrium schedule pause sN

atrium schedule resume sN
  恢复周期任务：暂停期间的轮次不补，从下一个到点开始
  示例：atrium schedule resume sN

atrium schedule rm sN
  删除周期任务：不再生成，已生成的任务照常；sN 不复用
  示例：atrium schedule rm sN

atrium review add 议题 --concerns 专员[,专员] [--brief 文件|-] [--issue 号] [--leader 节点] [--repo 路径] [--comment] [--part 节点] [--owner 订阅者]
  发起会审：并行给每位受邀专员派一个一次性执行者按各自章程与清单出意见，收齐后 leader（--leader 节点，缺省秘书）汇总一致与冲突、能定的定，碰到用户边界或谈不拢的标「需用户拍板」投事件；结论记在议题上，--comment 同步为 --issue 的评论
  示例：atrium review add 公开仓库 --concerns 前端,后端 --brief 议题.md --issue 322

atrium review show tN [--brief]
  看会审：各方意见（立场与原文）、汇总的一致与冲突、结论、需用户拍板的事；--brief 只列立场不带原文
  示例：atrium review show t1

atrium review decide tN 结论 [--as 拍板人]
  记下对会审的拍板（多用于「需用户拍板」的会审）：阶段转已定，原上交事项保留；--as 缺省 u1
  示例：atrium review decide t1 先不公开，等凭据清理完

atrium events [--as 订阅者] [--before 编号] [--limit 条数]
  查看事件的送达与确认状态，缺省显示 secretary 最近 50 条
  示例：atrium events

atrium events wait [--as 订阅者] [--timeout 秒] [--settle 秒] [--all]
  缺省只取要处理事件，首条后最多攒批 30 秒；--all 包括过程知会；取走后 15 分钟内不重投
  示例：atrium events wait

atrium events digest [--as 订阅者] [--since 时间]
  按任务合并尚未确认的知会事件；读取后自动确认；--since 使用带时区的 ISO 时间
  示例：atrium events digest

atrium events ack 编号…
  确认事件已处理（编号见 events wait）；确认后不再投递，未确认的处理中租约到期后重投
  示例：atrium events ack 12 13

atrium chat [--tool opencode|codex] [--cwd 目录] [--new] [--acp] [--allow]
  和秘书对话；opencode 缺省开原生界面（--acp 用 ACP），codex 经 ACP；空闲时自动送入事件，界面关闭后由服务恢复原会话处理
  示例：atrium chat
```

### 推送到手机

```text
atrium notify
  看推送到手机（Telegram）的状态：机器人、是否绑定、免打扰、攒批、代理、待发与最近一次失败；不显示 token
  示例：atrium notify

atrium notify token
  从标准输入读 @BotFather 给的 bot token（如 pbpaste | atrium notify token），核对后存进 Atrium 自己的凭据文件（0600，不进钥匙串），给出绑定码；换 token 要重新绑定
  示例：atrium notify token

atrium notify bind [--timeout 秒]
  等你给机器人发绑定码（缺省等 120 秒，最多 3600），收到就绑定这个私聊并回一条「已绑定」；没收到退出码 124，可再跑一次
  示例：atrium notify bind

atrium notify set [--quiet 23:00-08:00|off] [--batch 秒] [--proxy http://主机:端口|off] [--on|--off]
  改推送设置：免打扰时段（本机钟点，期间攒着、结束后合成一条发）、攒批窗口（缺省 60 秒内多条合一条）、单独的 HTTP 代理（不配就走系统 HTTPS_PROXY）、开关（关掉清空待发）
  示例：atrium notify set --quiet 23:00-08:00 --proxy http://127.0.0.1:7890

atrium notify test
  立刻发一条测试消息（不攒批、不看免打扰），看推送通不通
  示例：atrium notify test

atrium notify remove
  删掉存的 bot token 与绑定（免打扰等设置保留），待发的清空；机器人本身到 @BotFather 删
  示例：atrium notify remove
```

### 执行机器

```text
atrium host ls [--all]
  列出执行机器：本机 h1 与接入的远程主机，状态、编码 CLI、在跑几件、自动派哪些仓库；--all 连已移除的
  示例：atrium host ls

atrium host show hN
  看一台执行机器：系统、编码 CLI、负载、跑不跑把关检查、最近心跳、在跑的任务
  示例：atrium host show hN

atrium host add 名称 [--repo owner/name|*]… [--max 数量] [--ssh user@地址] [--key 私钥路径] [--tunnel 本机端口:远端端口]
  登记一台远程执行机器，给出一次性接入码（30 分钟内有效）与在那台机器上要运行的 atrium agent 命令；--repo 登记自动派活时能接的仓库（* 全部；不写只自动接没有仓库的活，--host 指定时不受限），--max 同时最多跑几件（缺省按那台的核数）
  示例：atrium host add 书房台式机 --repo liu-zhengdong/atrium --max 4

atrium host edit hN [--ssh user@地址] [--key 私钥路径] [--tunnel 本机端口:远端端口]
  更新远程主机的 SSH 连接和 Atrium 自管隧道；未写的字段沿用原值
  示例：atrium host edit h2 --ssh user@100.70.239.117 --tunnel 4310:14310

atrium host remove hN
  移除远程执行机器：令牌作废，短号保留不复用；上面还有在跑的任务时拒绝
  示例：atrium host remove hN

atrium host pause hN
  暂停往这台派新活（在跑的照跑）；本机 h1 也可以暂停，让活只去远程
  示例：atrium host pause hN

atrium host resume hN
  恢复往这台派活；排着的活会按顺序拉起
  示例：atrium host resume hN

atrium host clean hN
  止损：清理这台上 Atrium 拉起的残留进程——停掉在那台跑的非紧急执行者，再结束最近一天已结束任务仍活着的执行者进程树（远程由那台的代理核对并结束；按命令行与启动时刻核对，不碰你自己开的进程），逐条列出并记进任务事件；常和 host pause 一起写进紧急任务的 --stopgap
  示例：atrium host clean hN

atrium agent [--server <服务地址>] [--token <接入码>]
  在远程机器上运行：接入 Atrium 服务并领派给这台的活（前台常驻，Ctrl-C 停；执行者不随它退出，再起来接着看）；首次用 host add 给的接入码，之后只要 --server。数据在 ~/.atrium-agent（ATRIUM_AGENT_DATA 可改）
  示例：atrium agent --server http://host.orb.internal:4310 --token h2-接入码
```

### 专员

```text
atrium specialist ls [--part 部分] [--all] [--json]
  列出专员：缺省只列全组织共用的；--part 列这一部分能请的（本部分的在前，上级、牵涉部分与全组织的折成一行）；--all 展开全部
  示例：atrium specialist ls

atrium specialist show 专员 [--json]
  查看专员、岗位说明、优先执行者、交付关卡与技能
  示例：atrium specialist show 专员

atrium specialist add 名称 --description 文字 --body 文件 [--part 部分] [--preferred 列表] [--checks 列表] [--skills 列表] [--review-goal 目标] [--review-points JSON文件] [--review-bottom 列表] [--invite-when 列表]
  创建专员；--part 写它属于哪一部分（如安全专员属于安全，只有归属链或牵涉到那一部分的任务能请），不写即全组织共用；列表用逗号分隔，正文从文件读取
  示例：atrium specialist add 名称 --description 文字 --body 文件

atrium specialist edit 专员 [--name 名称] [--description 文字] [--body 文件] [--part 部分|''] [--preferred 列表] [--checks 列表] [--skills 列表] [--review-goal 目标] [--review-points JSON文件] [--review-bottom 列表] [--invite-when 列表]
  修订专员，保留历史；--part '' 改回全组织共用
  示例：atrium specialist edit 专员

atrium workers [--specialist 专员] [--json]
  按执行者组合、模型、工具与干活的专员查看交付事实
  示例：atrium workers

atrium workers show 工具+模型[:强度]|层/名 [--json]
  查看执行者的交付明细与三层叠加档案；给 层/名（如 harness/codex）时看这份档案原文与修订
  示例：atrium workers show harness/codex

atrium workers ls [--json]
  列出库里的执行者档案（工具 / 模型 / 组合三层）
  示例：atrium workers ls

atrium workers edit 层/名 (--file 文件|- | --trust 等级 | --max-risk 风险 | --model 模型 | --checks a,b | --set 键=值 | --unset 键) [--reason 原因] [--as secretary]
  改库里的一份执行者档案并留修订；层是 harness、models、combos，档案不存在就新建。--file - 从标准输入读整份（frontmatter + 正文）
  示例：atrium workers edit combos/codex+gpt-6-sol --trust medium --reason 连续五次一次通过

atrium workers confirm 工具+模型[:强度] --specialist 专员 --action relax|tighten|avoid_specialist
  秘书确认统计建议后写入组合档案
  示例：atrium workers confirm 工具+模型
```

### 全景

```text
atrium map [节点] [--depth N] [--no-open] [--json]
  看全景：终端打全景树并打开本机网页（一次性登录链接）；--json 返回节点人话字段、组成、阶段与在跑任务（与网页同一接口）
  示例：atrium map atrium --depth 2

atrium map context 节点 [--also 部分[,部分]] [--max 字数]
  给出从根到该节点的人话链、组成、现状与本节点及上级的要点，再加适用于本节点的管方面要点与 --also 牵涉部分的要点（注明来源，有长度上限）；派活时自动附进执行者提示词
  示例：atrium map context 节点

atrium map edit 节点 [--what 一句话] [--uses 场景]… [--flow 步骤]… [--alias 人话名] [--analogy 类比] [--now 现状] [--next 接下来] [--applies 部分[,部分]] [--detail 文件] [--rev rN] [--reason 原因] [--as aN]
  改一块的人话字段，直接覆盖且不留修订；--applies 只用于管方面的部分，写它的要点缺省适用于哪些部分（空串改回整个上级）；--detail 文件改章程正文并留修订（--rev 仅用于此）；给空串清掉；负责部门 leader 或其上级可改，根只有你能改
  示例：atrium map edit atrium/cli --what 一句话 --uses 场景一 --uses 场景二 --now 现状

atrium map add 父节点 名称 [--analogy 类比] [--alias 人话名] [--what 一句话] [--slug 路径名] [--kind aspect] [--reason 原因] [--as aN]
  在父节点下加一块（组成部分），可同时写人话名、类比与一句是什么；名称不能直接当路径名时给 --slug；--kind aspect 建管方面的部分（如安全，要点横跨多个部分，用 map edit --applies 或 org point-add --applies 写适用范围）
  示例：atrium map add atrium 待办本 --slug ledger --analogy 团队的任务白板

atrium map draft 仓库路径 [--node 节点] [--worker 工具+模型[:强度]]
  从本机仓库起草一块的全景初稿：运行时先读 README、两层目录与最近提交（跳过隐藏与像凭据的文件），派一次性执行者只读仓库、看开着的 issue，写出是什么、能做什么、怎么走完、由哪几部分组成；不改仓库、不推送。初稿先给你看（map apply --dry-run），确认才写进组织树；--node 是要写到的节点
  示例：atrium map draft ~/code/openquota --node openquota

atrium map apply 起草任务 [--node 节点] [--dry-run]
  看或确认全景初稿：--dry-run 只打出初稿和写进节点会改哪些字段；不带就把人话名、类比、是什么、能做什么、怎么走完写进 --node（缺省是起草时给的节点），没给的字段不动，组成部分留给建节点；同一份初稿只写一次
  示例：atrium map apply t12 --dry-run
```

### 目标（迁移后下线）

```text
atrium goal tree [gN] [--depth N]
  看目标树：各层状态、负责部门、前置和挂着的任务；给 gN 只看那一棵（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal tree

atrium goal show gN
  看目标或里程碑：结果、验收标准、状态、负责部门、前置、下层与挂着的任务（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal show gN

atrium goal add 结果 [--parent gN] [--node 节点] [--criteria 条目]… [--after gN[,gM]] [--due 日期] [--repo 路径] [--status planned|active] [--as aN]
  建顶层目标（不给 --parent，只有你能建）或里程碑；--node 负责部门（缺省同上层），--criteria 可多次给，以 `$ ` 开头的条目是命令，由运行时在 --repo 仓库里跑（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal add 组织树可用 --parent g1 --node atrium --criteria 条目

atrium goal edit gN [--result 结果] [--criteria 条目]… [--node 节点] [--parent gN] [--after gN[,gM]|''] [--due 日期|''] [--repo 路径|''] [--status planned|active|blocked] [--note 说明] [--as aN]
  改目标或里程碑；--criteria 整组替换（给一次空串清空），--after 整组替换；不留修订记录（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal edit gN

atrium goal check gN [--item N] [--pass|--fail --note 证据] [--timeout 秒] [--as aN]
  判定验收标准：不给 --pass/--fail 时运行时在隔离的临时 worktree 里跑命令条目（`$ ` 开头；给 --item 只跑那条），退出码 0 为满足；写不成命令的条目用 --item N --pass|--fail --note 证据 人工判（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal check g2 --item 2 --pass --note 已合入

atrium goal done gN [--note 证据] [--as aN]
  标为达成（前置须都已达成）；--note 记达成证据（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal done gN

atrium goal drop gN --reason 原因 [--as aN]
  放弃目标或里程碑（要写原因；下层与挂着的任务须先收尾）；改回用 goal edit --status（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal drop g2 --reason 不再需要

atrium goal adopt tN --parent gN [--node 节点] [--apply] [--as aN]
  把只起归类作用的父任务迁为里程碑：子任务挂上并上移一层，父任务标取消（默认只预览）（atrium org migrate-goals --apply 后下线，改看 atrium org show 节点）
  示例：atrium goal adopt t21 --parent g1
```

### 组织

```text
atrium org tree
  查看组织树
  示例：atrium org tree

atrium org show 节点 [--detail] [--charter|--card --raw]
  看节点：先讲人话（是什么、能做什么、怎么走完、由哪几部分组成、现状与阶段），--detail 展开章程正文、硬边界、预算、能力卡等技术细节
  示例：atrium org show 节点

atrium org add 父节点 slug [--kind 类型] [--name 名称] [--reason 原因] [--repo 路径] [--leader u1|aN]
  添加组织节点
  示例：atrium org add 父节点 slug

atrium org edit 节点 [--charter 文件|--card 文件|--name 名称] [--slug 路径名] [--leader aN|none] [--parent 节点] [--repo 路径] [--kind aspect|module] [--archive] [--rev rN] [--reason 原因]
  编辑节点、章程或能力卡；--kind aspect 改成管方面的部分，--kind module 改回普通部分（改回前要先清掉要点与部分的适用范围）
  示例：atrium org edit 节点

atrium org point-add 节点 要点 --why 为什么 --by 谁定的 [--check 检查] [--applies 部分[,部分]] [--as aN]
  给节点加一条要点（这一块必须守住的设计约束）：人话一句、为什么、谁定的（如 u1 09-27），可选守护它的检查（测试文件与用例名，或 $ 命令）；管方面的部分可用 --applies 写这条适用于哪些部分（不写跟随部分，缺省整个上级）；不留修订记录
  示例：atrium org point-add atrium/runtime 不采信执行者自述 --why 事实由运行时查 --by u1（09-27）

atrium org point-edit kN [--text 要点] [--why 为什么] [--by 谁定的] [--check 检查|''] [--applies 部分[,部分]|''] [--as aN]
  改一条要点；--check '' 去掉检查，--applies '' 改回跟随部分的适用范围
  示例：atrium org point-edit kN

atrium org point-rm kN [--as aN]
  删掉一条过时的要点（不留修订记录）
  示例：atrium org point-rm kN

atrium org stages 节点 --file 文件 --reason 原因 [--as aN]
  改节点的阶段记录（章程里的 stages），其余字段、正文、边界与预算不动，留章程修订；文件是 YAML 或 JSON 的阶段列表（也可写成 stages: 列表）；leader 可改自己负责的节点及子节点
  示例：atrium org stages atrium --file 阶段.yaml --reason 第二阶段完成

atrium org history 节点 [--target node|charter|card] [--rev rN] [--before rN] [--after rN] [--limit N]
  查看修订历史与字段差异
  示例：atrium org history 节点

atrium org revert 节点 [--charter|--card] [--to rN] [--reason 原因]
  恢复旧内容并追加新修订
  示例：atrium org revert 节点

atrium org import [章程文件] [--repo 仓库] [--apply]
  预览或导入根章程与岗位节点
  示例：atrium org import

atrium org link-roles [--apply]
  把旧 role 字符串的任务关联到组织节点（默认只预览）
  示例：atrium org link-roles

atrium org migrate-goals [--apply]
  把目标树（gN）迁为所在节点的阶段记录、任务按目标回填归属部分；默认只预览，--apply 先备份再写入，之后 goal 命令下线
  示例：atrium org migrate-goals

atrium leader ls
  列出 leader：负责的节点、执行者组合、最近一次唤醒在处理什么；节点上引用了但没登记的单列
  示例：atrium leader ls

atrium leader show aN
  看一位 leader：负责的节点、执行者组合、最近一次唤醒与备忘
  示例：atrium leader show aN

atrium leader add 名称 --worker 工具+模型[:强度] [--memo 文本] [--id aN] [--clones N]
  登记 leader（固定身份，按事唤醒时用 --worker 的执行者组合起一次性进程）；--id 认领节点上已引用但没登记的 aN；--clones 是同时至多几个分身（缺省 3，1～8；日常事件一个分身，大事一件一个）；再用 org edit 节点 --leader aN 指派
  示例：atrium leader add Atrium负责人 --worker claude+opus:high

atrium leader edit aN [--name 名称] [--worker 工具+模型[:强度]] [--clones N] [--memo 文本|--memo-file 文件]
  改 leader 的名称、执行者组合、分身并发上限（--clones，1～8）或备忘（覆盖写，有长度上限，超了先精简）；leader 自己只能改自己的备忘
  示例：atrium leader edit a1 --memo 在等t5合入，合入后上交已上线

atrium leader escalate 说明 --kind shipped|cross|beyond|stuck [--task tN] [--event 编号] [--as aN]
  leader 上交给上一层（秘书或上层 leader），生成一条「要处理」事件；只有四类：shipped 已上线、cross 需要别的部分配合、beyond 越过权限／预算／硬边界、stuck 搞不定；shipped 要带 --task 并在说明里附端到端验证。转交下层 leader 的上交时用 --event 给那条事件的编号、说明写你的意见（同任务同类型的会自动认作转交），上面只收一条。leader 进程里缺省以自己的身份上交
  示例：atrium leader escalate 组织树已上线，端到端：atrium-org-tree显示leader --kind shipped --task t5
```

### 备忘与决定

```text
atrium memo show [--as secretary|u1|aN]
  看备忘与决定摘要（新会话、换人接手先跑这一条）：标了原则的全列，再加最近 15 条，超过字数上限的只给一行「另有 N 条」；秘书的含用户的决定，leader 的只取自己部分及上级的；缺省秘书，leader 进程里缺省自己
  示例：atrium memo show

atrium memo edit [文本] [--file 文件] [--as secretary|aN]
  覆盖写备忘：在等什么、下次先看什么这类当前状态（有长度上限，超了先精简）；取舍与原因记进 decision add。leader 有几个分身同时在跑时只写自己认领那件事的分段，不覆盖别的分身；只剩一个分身时它写的就是合并后的全文
  示例：atrium memo edit 在等t5合入，合入后先看线上验证 --as a1

atrium decision add 决定 --why 原因 [--by u1|secretary|aN] [--date 日期] [--issue 号] [--node 节点]… [--task tN] [--supersedes dN] [--principle] [--as secretary|aN]
  追加一条决定记录（谁拍板、决定、原因，可关联 issue、一个或多个节点、任务）；--by 缺省是记录的主人，--by u1 的记进用户那份；补记旧决定用 --date；--supersedes 同时把旧决定标为已推翻；--principle 标为原则（摘要里总列出）
  示例：atrium decision add 额度读取不依赖OpenQuota --why 要迁到别的设备 --by u1 --issue 352

atrium decision ls [--as secretary|u1|aN] [--node 节点] [--all] [--before dN] [--limit 条数]
  列决定记录，日期新的在前；缺省列 --as 那一份，--node 列挂在该节点及其上级的（谁记的都算）；缺省只列有效的，--all 连已推翻、已沉淀的一起列；--before 接着上一页往下
  示例：atrium decision ls --node o2

atrium decision search 关键词 [--node 节点] [--as secretary|u1|aN] [--all] [--before dN] [--limit 条数]
  按关键词查决定（决定与原因里都算，空格隔开的几个词须全部命中）；缺省查所有人的有效决定，--node 只查挂在该节点及其上级的，--as 只查那一份，--all 连已推翻、已沉淀的
  示例：atrium decision search 额度 --node o2

atrium decision supersede dN --by dM [--as secretary|aN]
  把旧决定 dN 标为已推翻、指向新决定 dM（两条须在同一份记录里且都还有效）；之后 decision ls 缺省不再列 dN
  示例：atrium decision supersede d1 --by d3

atrium decision unsupersede dN --why 原因 [--as secretary|u1|aN]
  推翻标错了时撤销：dN 恢复为有效，记一笔谁撤销的、为什么、原先被哪条推翻
  示例：atrium decision unsupersede d1 --why 标错了，d3说的是另一件事

atrium decision tag dN --node 节点… [--as secretary|aN]
  给已有决定补挂节点（--node 可给多次，已挂的不重复）；挂上后 decision ls --node 与该部分 leader 的摘要里都能看到
  示例：atrium decision tag d3 --node o2 --node o5

atrium decision mark dN --principle|--normal [--as secretary|aN]
  标为原则（--principle，摘要里总列出）或改回普通决定（--normal）
  示例：atrium decision mark d3 --principle

atrium decision settle dN (--point kN | --new-point 节点 要点) [--why 为什么] [--by 谁定的] [--as secretary|aN]
  已成规矩的决定沉淀成要点：--point 指向已有的要点，或 --new-point 在节点上新建一条（为什么缺省用决定的原因，谁定的缺省拍板人与日期）；决定标「已沉淀到 kN」、缺省列表与摘要不再显示，要点记来源 dN
  示例：atrium decision settle d3 --new-point atrium 测试不依赖本机真实环境
```

### 资料

```text
atrium material add 节点 文件|目录 --note 一句话 [--name 名称] [--supersedes mN] [--for t1,k1,d1]
  把文件或目录作为资料挂到节点上（存进数据目录，单版至多 20 MB，隐藏文件不收）；同一节点同名的再加就是新版本；--supersedes 标旧资料被取代，--for 关联任务、要点或决定（清理线索看它们是否结束）
  示例：atrium material add o4 docs/design/t120-tasks --note t120任务视图的设计稿与截图 --for t120

atrium material ls [--node 节点] [--archived] [--before mN] [--limit 条数]
  列资料（新的在前）：短号、名称、一句话、节点、版本、大小、最近谁读过；缺省不含归档的，--archived 只列归档的
  示例：atrium material ls --node o4

atrium material show mN
  看一份资料：说明、状态、版本、关联、谁读过、清理线索
  示例：atrium material show m1

atrium material get mN [--out 目录] [--version 版本]
  取资料到 --out 目录（缺省当前目录）下，按名称落成文件或目录，已存在就报错；缺省当前版本；执行者在任务里也能用（读取记在任务上）
  示例：atrium material get m1 --out 资料

atrium material archive mN [--note 原因]
  归档资料：不进清单和派活提示词、清理线索也不再提，文件留着可恢复（只归档不删）
  示例：atrium material archive m1 --note 已按新设计上线

atrium material restore mN [--note 原因]
  恢复归档的资料，重新进清单和派活提示词
  示例：atrium material restore m1

atrium material keep mN --note 原因
  清理线索说疑似没用、但决定留下：写一句原因，之后清理线索不再提它
  示例：atrium material keep m1 --note 下一版还要对照

atrium material stale [--node 节点]
  清理线索：疑似没用的资料（被取代，或 90 天没读且关联都结束；由这一块的 leader 定归档还是留）；看全部时另列归档超过一年且大于 10 MB、可以真删的（要用户点头）
  示例：atrium material stale --node o4

atrium material rm mN
  真删资料（库里的记录与全部版本的文件，删了找不回来）；只有用户能删，平时用不上就 archive
  示例：atrium material rm m1
```

### 凭据

```text
atrium secret set 节点 名称
  设凭据（令牌、密码）：值从标准输入读（终端里不回显；也可 < 文件 或管道），名称就是注入执行者的环境变量名（如 TELEGRAM_BOT_TOKEN）；同一节点同名的覆盖，已归档的顺带恢复；只存不显示
  示例：atrium secret set 节点 名称

atrium secret ls [--node 节点] [--archived] [--before 号] [--limit 条数]
  列凭据（新设的在前）：名称、节点、设于、最近使用（时间与任务）、清理线索；不显示值；缺省不含归档的，--archived 只列归档的
  示例：atrium secret ls

atrium secret archive 节点 名称 [--note 原因]
  归档凭据：派活不再注入（声明了它的任务派不出去）、清理线索也不再提，值留着可恢复（只归档不删）
  示例：atrium secret archive 节点 名称

atrium secret restore 节点 名称 [--note 原因]
  恢复归档的凭据，派活时重新注入
  示例：atrium secret restore 节点 名称

atrium secret keep 节点 名称 --note 原因
  清理线索说疑似没用（90 天没用过）、但决定留下：写一句原因，之后清理线索不再提它
  示例：atrium secret keep 节点 名称 --note 原因

atrium secret rm 节点 名称
  真删凭据（记录与值一起删，找不回来）；只有用户能删，平时用不上就 archive
  示例：atrium secret rm 节点 名称
```

### 选项与拍板

```text
atrium choice ls [--node 节点] [--open] [--before cN] [--limit 份数]
  列选项单，等拍板的在前、新的在前；--node 只看这一块及下层（产品部），--open 只看等拍板的
  示例：atrium choice ls --open

atrium choice show cN
  看一份选项单全文：每个选项能多做到什么、为什么现在、代价、不做会怎样、依据，产品部的推荐与理由，拍过板的写明建了哪些任务、记了哪些决定
  示例：atrium choice show c3

atrium choice pick cN 选项号… [--note 说明]
  拍板要做哪几个：选中的在该节点下各建一个任务（带选项全文作详述，交该节点 leader 拆解），没选的连同说明记成该节点的决定记录（这轮不做 X：原因）；拍板人缺省是用户，atrium product set 下放后该节点的 leader 也能拍
  示例：atrium choice pick c3 1 3 --note 选项2等额度宽裕再说

atrium choice pass cN [--note 原因]
  这轮都不要：每个选项连同原因记成该节点的决定记录，下一轮产品部读得到，情况没变不重复提
  示例：atrium choice pass c3 --note 这周先收尾在做的

atrium choice comment cN 意见 [--prefer 选项号[,选项号]] [--basis 依据]…
  给等拍板的选项单写意见（项目 leader、秘书）：可标倾向哪几个、补依据（fN、tN、dN、链接，可写多次）；拍板人看选项单时一起看到，选中的任务详述也带上
  示例：atrium choice comment c3 先做看板过滤，合入提速等CI稳了 --prefer 1 --basis f3

atrium choice add 节点 --file 选项单.json|- [--task tN]
  产品部提一份选项单挂在节点上（它要演进的那一块），建好叫醒秘书递给用户；文件是 JSON：{"title":"标题","options":[{"title","gain":"能多做到什么","why_now":"为什么现在","cost":"代价：多少活、占哪些额度","skip":"不做会怎样","basis":["f3","t120","d4","链接"]}…3–5 个],"recommend":[选项号],"why":"推荐理由"}；--task 记产出它的研究任务
  示例：atrium choice add atrium --file 选项单.json --task t42

atrium product add 节点 [--name 名称] [--every 7d] [--at 时刻] [--worker 工具+模型[:强度]]
  在节点下成立产品部（普通部分，管这一块的演进）：一条命令建好部分与人话字段、登记它的 leader、挂一个 research 周期任务（缺省每周）；每轮研究读这一块的全景、决定记录、巡检发现、失败与上线记录，可上网看同类产品，产出一份选项单等用户拍板，不写代码、不开 PR；--worker 同时定 leader 与研究用的执行者，不给时 leader 沿用上级 leader 的、研究按档案挑
  示例：atrium product add atrium --every 7d --at 09:30

atrium product ls [--node 节点]
  列出产品部：管哪一块、leader、周期研究的节奏与下一轮、上一轮任务；--node 只看设在这个节点下的
  示例：atrium product ls

atrium product set 节点 --decider leader|u1
  设谁拍板这个节点（及没另设的下层）上的选项单：u1 用户拍板（缺省），leader 下放给该节点最近的 leader——之后 leader 能 choice pick/pass，用户只收知会；只有用户能改
  示例：atrium product set atrium --decider leader

atrium product show 节点
  看这个节点上的选项单由谁拍板：本节点的设置（没设就沿用上层，都没设是用户）与实际拍板人
  示例：atrium product show atrium
```

### 技能

```text
atrium skill ls [--all]
  列出组织技能（--all 含已归档）
  示例：atrium skill ls

atrium skill show slug [--out 目录]
  查看技能内容与绑定；--out 导出文件以便修改
  示例：atrium skill show slug

atrium skill add slug 目录或SKILL.md [--description 简介] [--name 名称] [--owner 节点] [--source 出处] [--reason 原因]
  新建组织技能（owner 默认组织根节点）
  示例：atrium skill add slug 目录或SKILL.md

atrium skill edit slug [目录或SKILL.md] [--name 名称] [--owner 节点] [--archive|--restore] [--rev rN] [--proposal pN] [--source 出处] [--reason 原因]
  修改技能并追加修订；用户纠正写 --reason 用户纠正… --source 出处
  示例：atrium skill edit slug

atrium skill history slug [--rev rN] [--before rN] [--limit N]
  查看技能修订与来源；--rev 看该修订的差异
  示例：atrium skill history slug

atrium skill revert slug --to rN [--reason 原因]
  恢复旧修订的内容并追加新修订
  示例：atrium skill revert slug --to rN

atrium skill bind slug 节点
  把技能挂到节点：派到该节点及子节点的任务都带上
  示例：atrium skill bind slug 节点

atrium skill unbind slug 节点
  从节点上取下技能
  示例：atrium skill unbind slug 节点

atrium skill proposals [--status pending|accepted|rejected|all] [--limit N]
  列出执行者改技能生成的修订提议（默认待审）
  示例：atrium skill proposals

atrium skill proposal pN [--out 目录]
  查看一个修订提议的差异；--out 导出提议内容以便手工合并
  示例：atrium skill proposal pN

atrium skill accept pN [--reason 原因]
  采纳修订提议：写成新修订（基于旧版本时三方合并）
  示例：atrium skill accept pN

atrium skill reject pN [--reason 原因]
  驳回修订提议
  示例：atrium skill reject pN
```

### 其他

```text
atrium role ls [--part 部分] [--all] [--json]
  列出专员：缺省只列全组织共用的；--part 列这一部分能请的（本部分的在前，上级、牵涉部分与全组织的折成一行）；--all 展开全部（旧写法；改用 atrium specialist ls）
  示例：atrium role ls

atrium role show 专员 [--json]
  查看专员、岗位说明、优先执行者、交付关卡与技能（旧写法；改用 atrium specialist show）
  示例：atrium role show 专员

atrium role add 名称 --description 文字 --body 文件 [--part 部分] [--preferred 列表] [--checks 列表] [--skills 列表] [--review-goal 目标] [--review-points JSON文件] [--review-bottom 列表] [--invite-when 列表]
  创建专员；--part 写它属于哪一部分（如安全专员属于安全，只有归属链或牵涉到那一部分的任务能请），不写即全组织共用；列表用逗号分隔，正文从文件读取（旧写法；改用 atrium specialist add）
  示例：atrium role add 名称 --description 文字 --body 文件

atrium role edit 专员 [--name 名称] [--description 文字] [--body 文件] [--part 部分|''] [--preferred 列表] [--checks 列表] [--skills 列表] [--review-goal 目标] [--review-points JSON文件] [--review-bottom 列表] [--invite-when 列表]
  修订专员，保留历史；--part '' 改回全组织共用（旧写法；改用 atrium specialist edit）
  示例：atrium role edit 专员
```

<!-- 命令参考结束 -->

## 配置与数据

| 环境变量                        | 用途                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ATRIUM_PORT`                   | 新启动服务的端口，默认 `4310`；已有服务沿用原端口                                                       |
| `ATRIUM_DATA`                   | 数据目录，默认 `~/.atrium/`                                                                             |
| `ATRIUM_WORKERS_DIR`            | 旧版执行者档案目录，首次启动导入一次，默认 `~/Atrium/workers`（隔离服务无默认）                         |
| `ATRIUM_LEGACY_DIR`             | 旧状态目录，默认 `~/Atrium`（隔离服务无默认）；启动时从这里导入一次根章程预算                           |
| `ATRIUM_OPENQUOTA_BIN`          | OpenQuota 可执行文件，默认 `/Applications/OpenQuota.app/…`                                              |
| `ATRIUM_QUOTA_READERS`          | 设为 `off` 关掉自带额度读取，只用 OpenQuota                                                             |
| `ATRIUM_EVENT_LEASE_MINUTES`    | 取走的事件多久未确认就重投，默认 15                                                                     |
| `ATRIUM_EVENT_BATCH_SECONDS`    | 事件攒批窗口，默认 0（到即取）                                                                          |
| `ATRIUM_QUOTA_UNKNOWN_MINUTES`  | 额度用尽但不知道何时恢复时，标记多少分钟，默认 60                                                       |
| `ATRIUM_LEADER_BATCH_SECONDS`   | leader 唤醒前的攒批窗口，默认 30                                                                        |
| `ATRIUM_LEADER_TIMEOUT_MINUTES` | leader 单次唤醒的上限，超时转交上一层，默认 20                                                          |
| `ATRIUM_LEADER_WAKE`            | `1` 让隔离服务也唤醒 leader，`0` 关掉；默认只在默认数据目录唤醒                                         |
| `ATRIUM_AUTO_PLAN`              | `1` 让隔离服务也在选项单拍板后自动派规划任务，`0` 关掉；默认只在默认数据目录自动派                      |
| `ATRIUM_UPDATE_REPO`            | `atrium update` 的来源，默认 `github:liu-zhengdong/atrium`                                              |
| `ATRIUM_VERIFY_WORKERS`         | 上线后验证的执行者组合，逗号分隔、按顺序试，默认 `opencode+opencode-go/deepseek-v4.1-flash,cursor+auto` |
| `ATRIUM_MAX_WORKERS`            | 本机同时在跑的执行者上限，默认核数的 3/4（至少 2）；`0` 不限                                            |
| `ATRIUM_BUSY_CORES`             | Atrium 进程树占用超过几个核暂停派新活，默认核数的 3/4；`0` 不看                                         |
| `ATRIUM_BUSY_LOAD`              | 整机 1 分钟负载保护线，超过暂停派新活，默认 4×核数；`0` 不看负载                                        |
| `ATRIUM_MAX_CHECKS`             | 本地检查同时跑几个，默认核数的一半（至少 1）                                                            |
| `ATRIUM_CHECK_TIMEOUT_MINUTES`  | 一次本地检查最多跑几分钟，默认 30；远程主机由代理按它那台的环境设                                       |
| `ATRIUM_QUIET_MINUTES`          | 执行者或检查日志多久没进展发提醒（知会负责的 leader、状态栏显示），默认 5                               |
| `ATRIUM_CHECK_STALL_MINUTES`    | 检查日志多久没新输出就结束这次检查并分类，默认 10；`0` 不结束；远程主机由代理按它那台的环境设           |
| `ATRIUM_TEST_CONCURRENCY`       | 注入执行者与本地检查的测试并发，默认核数减 1（至少 1）                                                  |
| `ATRIUM_AGENT_DATA`             | 远程主机上 `atrium agent` 的数据目录（令牌、仓库、工作树、日志），默认 `~/.atrium-agent`                |
| `ATRIUM_TELEGRAM_API`           | 推送用的 Telegram 接口地址，默认 `https://api.telegram.org`（隔离验收时指向本地假接口）                 |

Atrium 的状态都在数据目录的数据库里（任务详述、组织树与章程预算等），换机器带走数据目录即可；旧状态的导入每类只做一次，记在 `state_imports` 表，重复启动不重复导入。数据目录保存业务数据库、任务目录（worktree 之外的提示词与日志）、用户令牌 `user-token` 与服务登记 `service.sqlite`（均为 `0600`）。服务与执行者只继承白名单环境变量，不继承 `*_API_KEY`、`*_TOKEN` 等凭据；执行者的模型凭据走各 CLI 自己的配置目录。令牌丢失或需要作废时运行 `atrium auth rotate`。凭据、数据库与登记文件不要提交或分享。

## 开发与验证

```bash
npm ci
npm run build                               # 类型检查
npm test -- tests/a.test.ts tests/b.test.ts # 只跑列出的测试文件（同样限并发）
npm test -- --changed                       # 只跑与 origin/main 相比改动文件相关的测试
npm run check                               # 类型检查与全部测试（运行时的本地检查跑这个）
npm run format:check
```

执行者开发中和交付前都只跑类型检查和相关测试；全量（`npm run check`）只由运行时跑。`--changed` 按文件名（`ledger.ts` → `ledger.test.ts`、`ledger-*.test.ts`）和测试文件的直接 import 粗匹配，改了测试辅助文件（如 `tests/fake-bin.ts`）会带上所有引用它的测试；没匹配到测试的代码文件会列出来，按需补上文件名。其余 `-` 开头的参数（如 `--test-name-pattern=…`）原样交给 `node --test`。

装好的包直接加载发版时编译的 `dist/`（esbuild 把 `cli/`、`server/`、`shared/` 编成 JS，发版流程把它提交到版本标签上，`main` 不含 `dist/`），不在每次启动时编译 TypeScript，服务也没有常驻的 esbuild 子进程；仓库里（有 `.git`）照旧用 tsx 跑源码。`npm run dist` 在本地编译，`npm pack` 前会自动编译；`npm run bench:cli` 编译后起隔离服务，量 `atrium --help`、`status`、`task ls` 的启动耗时（中位数超过 150 毫秒失败，`ATRIUM_BENCH_LIMIT_MS` 可放宽）；`npm run bench:cli -- --decisions 1500` 先造 1500 条假决定，量 `memo show`、`decision ls --node`、`decision search`。量启动耗时要用编译产物：仓库里直接 `node bin/atrium.mjs` 走 tsx 现场编译，光 `--help` 就要 140 毫秒上下。

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
