import type { Command } from "./main.ts";
import { exitCodes } from "./contract.ts";

export const groups: Record<string, string[]> = {
  服务: ["status", "stop", "restart", "update", "auth status", "auth rotate"],
  任务: [
    "quota",
    "top",
    "statusline",
    "task add",
    "task ls",
    "task plan",
    "task show",
    "task tree",
    "task set",
    "task note",
    "task tell",
    "task pick",
    "task run",
    "task done",
    "task stop",
    "task merge",
    "task log",
    "task wait",
    "patrol run",
    "patrol report",
    "patrol findings",
    "patrol decide",
    "schedule add",
    "schedule ls",
    "schedule show",
    "schedule run",
    "schedule pause",
    "schedule resume",
    "schedule rm",
    "review add",
    "review show",
    "review decide",
    "events",
    "events wait",
    "events digest",
    "events ack",
    "chat",
  ],
  推送到手机: [
    "notify",
    "notify token",
    "notify bind",
    "notify set",
    "notify test",
    "notify remove",
  ],
  执行机器: [
    "host ls",
    "host show",
    "host add",
    "host edit",
    "host remove",
    "host pause",
    "host resume",
    "host clean",
    "agent",
  ],
  专员: [
    "specialist ls",
    "specialist show",
    "specialist add",
    "specialist edit",
    "workers",
    "workers show",
    "workers ls",
    "workers edit",
    "workers confirm",
  ],
  全景: ["map", "map context", "map edit", "map add"],
  "目标（迁移后下线）": [
    "goal tree",
    "goal show",
    "goal add",
    "goal edit",
    "goal check",
    "goal done",
    "goal drop",
    "goal adopt",
  ],
  组织: [
    "org tree",
    "org show",
    "org add",
    "org edit",
    "org point-add",
    "org point-edit",
    "org point-rm",
    "org stages",
    "org history",
    "org revert",
    "org import",
    "org link-roles",
    "org migrate-goals",
    "leader ls",
    "leader show",
    "leader add",
    "leader edit",
    "leader escalate",
  ],
  备忘与决定: [
    "memo show",
    "memo edit",
    "decision add",
    "decision ls",
    "decision search",
    "decision supersede",
    "decision unsupersede",
    "decision tag",
    "decision mark",
    "decision settle",
  ],
  资料: [
    "material add",
    "material ls",
    "material show",
    "material get",
    "material archive",
    "material restore",
    "material keep",
    "material stale",
    "material rm",
  ],
  凭据: [
    "secret set",
    "secret ls",
    "secret archive",
    "secret restore",
    "secret keep",
    "secret rm",
  ],
  选项与拍板: [
    "choice ls",
    "choice show",
    "choice pick",
    "choice pass",
    "choice comment",
    "choice add",
    "product add",
    "product ls",
    "product set",
    "product show",
  ],
  技能: [
    "skill ls",
    "skill show",
    "skill add",
    "skill edit",
    "skill history",
    "skill revert",
    "skill bind",
    "skill unbind",
    "skill proposals",
    "skill proposal",
    "skill accept",
    "skill reject",
  ],
};
export function groupOf(name: string) {
  return (
    Object.entries(groups).find(([, members]) => members.includes(name))?.[0] ??
    "服务"
  );
}
export function example(name: string, command: Command) {
  if (name === "task add") return "atrium task add 拆分登录模块 --parent t1";
  if (name === "task set") return "atrium task set t1 --status done";
  if (name === "task pick") return "atrium task pick t1 --risk medium";
  if (name === "task run")
    return "atrium task run t1 --worker codex+gpt-6-sol:high";
  if (name === "patrol run") return "atrium patrol run o4";
  if (name === "schedule add")
    return "atrium schedule add atrium/cli --kind patrol --every 1d --at 09:30";
  if (name === "host add")
    return "atrium host add 书房台式机 --repo liu-zhengdong/atrium --max 4";
  if (name === "host edit")
    return "atrium host edit h2 --ssh user@100.70.239.117 --tunnel 4310:14310";
  if (name === "agent")
    return "atrium agent --server http://host.orb.internal:4310 --token h2-接入码";
  if (name === "patrol report")
    return "atrium patrol report t1 --phenomenon 帮助缺少示例 --step 第一步 --command atrium-guide --expected 有示例 --actual 没有示例 --kind awkward";
  if (name === "patrol decide")
    return "atrium patrol decide f1 --ignore 已有同类改进计划";
  if (name === "events ack") return "atrium events ack 12 13";
  if (name === "notify set")
    return "atrium notify set --quiet 23:00-08:00 --proxy http://127.0.0.1:7890";
  if (name === "review add")
    return "atrium review add 公开仓库 --concerns 前端,后端 --brief 议题.md --issue 322";
  if (name === "review decide")
    return "atrium review decide t1 先不公开，等凭据清理完";
  if (name === "workers edit")
    return "atrium workers edit combos/codex+gpt-6-sol --trust medium --reason 连续五次一次通过";
  if (name === "workers show") return "atrium workers show harness/codex";
  if (name === "map") return "atrium map atrium --depth 2";
  if (name === "map edit")
    return "atrium map edit atrium/cli --what 一句话 --uses 场景一 --uses 场景二 --now 现状";
  if (name === "map add")
    return "atrium map add atrium 待办本 --slug ledger --analogy 团队的任务白板";
  if (name === "org point-add")
    return "atrium org point-add atrium/runtime 不采信执行者自述 --why 事实由运行时查 --by u1（09-27）";
  if (name === "org stages")
    return "atrium org stages atrium --file 阶段.yaml --reason 第二阶段完成";
  if (name === "leader add")
    return "atrium leader add Atrium负责人 --worker claude+opus:high";
  if (name === "leader edit")
    return "atrium leader edit a1 --memo 在等t5合入，合入后上交已上线";
  if (name === "leader escalate")
    return "atrium leader escalate 组织树已上线，端到端：atrium-org-tree显示leader --kind shipped --task t5";
  if (name === "memo edit")
    return "atrium memo edit 在等t5合入，合入后先看线上验证 --as a1";
  if (name === "decision add")
    return "atrium decision add 额度读取不依赖OpenQuota --why 要迁到别的设备 --by u1 --issue 352";
  if (name === "decision supersede")
    return "atrium decision supersede d1 --by d3";
  if (name === "decision unsupersede")
    return "atrium decision unsupersede d1 --why 标错了，d3说的是另一件事";
  if (name === "decision ls") return "atrium decision ls --node o2";
  if (name === "decision search")
    return "atrium decision search 额度 --node o2";
  if (name === "decision tag")
    return "atrium decision tag d3 --node o2 --node o5";
  if (name === "decision mark") return "atrium decision mark d3 --principle";
  if (name === "decision settle")
    return "atrium decision settle d3 --new-point atrium 测试不依赖本机真实环境";
  if (name === "material add")
    return "atrium material add o4 docs/design/t120-tasks --note t120任务视图的设计稿与截图 --for t120";
  if (name === "material ls") return "atrium material ls --node o4";
  if (name === "material get") return "atrium material get m1 --out 资料";
  if (name === "material archive")
    return "atrium material archive m1 --note 已按新设计上线";
  if (name === "material keep")
    return "atrium material keep m1 --note 下一版还要对照";
  if (name === "material stale") return "atrium material stale --node o4";
  if (
    name === "material show" ||
    name === "material restore" ||
    name === "material rm"
  )
    return `atrium ${name} m1`;
  if (name === "choice ls") return "atrium choice ls --open";
  if (name === "choice pick")
    return "atrium choice pick c3 1 3 --note 选项2等额度宽裕再说";
  if (name === "choice pass")
    return "atrium choice pass c3 --note 这周先收尾在做的";
  if (name === "choice show") return "atrium choice show c3";
  if (name === "choice add")
    return "atrium choice add atrium --file 选项单.json --task t42";
  if (name === "choice comment")
    return "atrium choice comment c3 先做看板过滤，合入提速等CI稳了 --prefer 1 --basis f3";
  if (name === "product set")
    return "atrium product set atrium --decider leader";
  if (name === "product show") return "atrium product show atrium";
  if (name === "product add")
    return "atrium product add atrium --every 7d --at 09:30";
  if (name === "product ls") return "atrium product ls";
  if (name === "goal add")
    return "atrium goal add 组织树可用 --parent g1 --node atrium --criteria 条目";
  if (name === "goal check")
    return "atrium goal check g2 --item 2 --pass --note 已合入";
  if (name === "goal drop") return "atrium goal drop g2 --reason 不再需要";
  if (name === "goal adopt") return "atrium goal adopt t21 --parent g1";
  const sample = command.args
    .split("[")[0]!
    .replace(/\S+…/g, "甲")
    .replace(/序号/g, "1")
    .replace(/\btN\b/g, "t1")
    .trim();
  return `atrium ${name}${sample ? ` ${sample}` : ""}`;
}
export function guide(commands: Record<string, Command>) {
  const codes = Object.entries(exitCodes)
    .map(([code, exit]) => `  ${exit}  ${code}`)
    .join("\n");
  const reference = Object.entries(commands)
    .map(
      ([name, command]) =>
        `atrium ${name} ${command.args}`.trimEnd() +
        `\n  ${command.about}\n  示例：${example(name, command)}`,
    )
    .join("\n");
  return `Atrium 命令行说明书\n\n调用约定\n  任务用 t1，组织节点用 o1（旧目标与里程碑 g1 迁为节点阶段记录的 id），用户用 u1，组织节点 leader 用 a1。\n  task/events 的 --as 是事件订阅者名，memo/decision 的 --as 是记录的主人，都缺省 secretary（leader 进程里缺省是自己的 aN）；org/skill/goal/map、workers edit、specialist 的 --as 是改动记在谁名下：u1、secretary（秘书，权限同用户）或某个节点 leader 的 aN，缺省 u1，秘书会话（ATRIUM_AS=secretary）里缺省 secretary；技能修订提议用 p1。\n  所有命令支持 --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。只在 stdout 写一个 JSON 对象，提示在 stderr。\n  文本回执最后一行是「动作：atrium 命令」，没有下一步则省略。\n  退出码与 code：\n  0  成功\n${codes}\n\n常见任务\n  令牌失效：atrium auth rotate（使用当前 ATRIUM_DATA）。\n  数据目录与端口：默认数据 ~/.atrium，用 ATRIUM_DATA 改；前一代数据 ~/.pi/atrium/data 已归档不再使用。端口被另一份数据的 Atrium 占着时回执给出它的数据目录，要用它就设 ATRIUM_DATA=那个目录；被别的程序占着就换 ATRIUM_PORT\n  拆任务看全貌：atrium task add 目标；atrium task add 子任务 --parent t1；atrium task tree t1；人工收尾：atrium task set t2 --status done\n  总任务：有子任务的任务不派给执行者，派它下面的子任务；状态与进度按全部子孙汇总（task show/tree 显示「在做 5/12」）；秘书只收「tN 整体已上线」「tN 下的 tM 卡住」；取消连带子孙：atrium task set t1 --status cancelled --with-children\n  派活前看候选：atrium task pick t2（候选执行者、能不能接、账号额度、正忙、在干活的专员下的交付记录，最上面是推荐与理由）；只看额度：atrium quota；人工解除误判占用：atrium quota --clear claude
  leader 层：atrium leader add 名称 --worker claude+opus 登记，atrium org edit 节点 --leader a1 指派；任务没写 --owner 时事件投给归属部分最近的 leader（事件 routed 写明投给谁、为什么），找不到投秘书；leader 有要处理的事件时攒批 30 秒、起一次性进程处理并确认，连续失败或超时转交秘书；leader 只能动负责的节点及子节点（越权报 leader_scope），只把四类事上交：atrium leader escalate 说明 --kind shipped|cross|beyond|stuck [--task tN]，转交下层的上交加 --event 编号（上面只收一条）；看 leader：atrium leader ls、atrium top
  资料：设计稿、调研报告这类文件挂在节点上（短号 mN）：atrium material add o4 目录 --note 一句话 [--for t120]，存进数据目录（单版至多 20 MB，同一节点同名的再加是新版本，内容没变不加）；派活时提示词只附本节点及上级资料的清单，执行者按需 atrium material get mN（执行者环境也能用，读取记在任务上）；atrium material show mN 看版本与谁读过；清理只归档不删：各部分的周期任务到点时顺带把疑似没用的（被取代，或 90 天没读且关联都结束）投给 leader（material_stale），leader 用 atrium material archive mN --note 原因 或 atrium material keep mN --note 原因（之后不再提）；归档超过一年且大于 10 MB 的投给秘书问用户，用户点头才 atrium material rm mN
  凭据：令牌、密码这类值挂在节点上：atrium secret set o4 TELEGRAM_BOT_TOKEN（值从标准输入读，终端里不回显；名称就是环境变量名），只存不显示（secret ls 只列名称与最近使用）；任务要用就 atrium task add 标题 --part o4 --secret TELEGRAM_BOT_TOKEN（或 task set tN --secret 名称），派活那一刻按归属部分往上找到最近的一个、以同名环境变量注入该执行者（白名单环境之外的唯一例外），提示词只写名称；各部分的周期任务到点时把 90 天没用过的投给 leader（secret_stale），leader 用 atrium secret archive o4 名称 --note 原因 或 atrium secret keep o4 名称 --note 原因；真删只有用户：atrium secret rm o4 名称
  备忘与决定记录：秘书（secretary）与每位 leader 各有一份备忘（atrium memo edit 文本 [--as aN]，覆盖写、至多 2000 字，写在等什么、下次先看什么）；决定记录（atrium decision add 决定 --why 原因 [--by u1] [--node 节点]… [--principle]，追加，短号 dN）用户、秘书、每位 leader 各一份，--by u1 的记进用户那份（u1），秘书和 leader 的只放各自的；新会话或换人接手先跑 atrium memo show [--as aN]，只给摘要：标了原则的全列，再加最近 15 条，整段约 3000 字，放不下的只给一行「另有 N 条」；秘书的含用户的决定，leader 的是自己的加挂在负责部分及上级的（唤醒提示词同样）；全部用 atrium decision ls --node 节点（该节点及上级，谁记的都算）或 atrium decision search 关键词 [--all] 查；整理：补挂节点 decision tag dN --node oN，标原则 decision mark dN --principle，推翻 decision supersede dN --by dM，推翻标错了 decision unsupersede dN --why 原因，已成规矩的沉淀成要点 decision settle dN --point kN 或 --new-point 节点 要点（决定标已沉淀、缺省不再列，要点记来源 dN）；和要点的区别：要点是执行者要守的约束，决定记录是给自己回看的取舍与原因
  产品部：atrium product add atrium [--every 7d] [--worker claude+opus] 在节点下成立产品部（普通部分，管这一块的演进，可设在任意节点下、一个节点一个）：建好部分与人话字段、登记它的 leader、挂一条 research 周期任务；每轮研究的详述由模板现取材料（这一块的全景、决定记录含没选的、选项单、巡检发现、近 30 天失败与被打回的任务、完成与上线），研究者可上网看同类产品，只在工作目录写 choice.json、不写代码不开 PR；任务完成时运行时把它登记成挂在这一块上的选项单（提的人记产品部 leader），出错写进完成事件交产品部 leader 补；atrium schedule run sN 马上跑一轮，atrium product ls 看各产品部
  选项与拍板：产品部调研后提一份选项单（atrium choice add 节点 --file 选项单.json，3–5 个选项，每个写能多做到什么、为什么现在、代价、不做会怎样、依据，另写推荐与理由；短号 cN），建好先投给所属项目的 leader（choice_review），leader 可写意见、补依据、标倾向：atrium choice comment c3 意见 --prefer 1,3 --basis f3；拍板人缺省是用户：投 choice_ready 叫醒秘书，秘书可合并、去重后递给用户，但不删改方向；状态栏与 top 显示「等你拍板：cN 标题（N 个选项）」，全景网页节点页「选项」页签可看可选；用户拍板 atrium choice pick c3 1 3 --note 说明（选中的在该节点下各建一个任务交 leader 拆解），或 atrium choice pass c3 --note 原因（这轮都不要）；没选的连同说明记成该节点最近 leader（没有就是秘书）的决定记录，下一轮产品部读得到；用户可把某个节点的拍板权下放：atrium product set atrium --decider leader（改回 --decider u1，只有用户能改），之后该节点最近的 leader 收 choice_ready 并能 pick/pass，秘书只收知会、状态栏不再显示；atrium product show 节点 看当前拍板人
  看全景：人用网页，atrium map 打开本机全景网页（一次性登录链接、只读（只能拍板选项单）、实时刷新）；Agent 用命令行，atrium map o2 --json 读一块（人话字段、组成、阶段、在跑任务、巡检发现，与网页同一接口），atrium map context o2 是派活时自动附进提示词的全景位置与要点（有长度上限）；改只走命令行：atrium map edit o2 --what 一句话 --uses 场景 --flow 步骤 --now 现状，atrium map add o2 名称 --analogy 类比；专员清单：atrium specialist ls
  体验巡检：atrium patrol run o4 手动巡检一条 uses 场景（逐次轮换）；巡检进程只读全景、帮助和回执，用当前服务与真实数据，不读代码；发现用 atrium patrol report tN 记录，同节点同现象去重；结束后新增发现投给该节点 leader；leader 用 atrium patrol decide fN --task tN 或 --merge tN 或 --ignore 原因；atrium patrol findings o4 与全景可看处理结果
  周期任务：atrium schedule add o4 --kind patrol --every 1d --at 09:30 每天巡检一次；atrium schedule add o2 周报 --every 7d --brief 周报.md 每周在节点下建一件普通任务；到点生成任务并派发（闲时/普通按节点缺省），上一轮还没结束就跳过本轮并记一笔，服务停机错过的只补一轮；atrium schedule run s1 马上跑一轮；atrium schedule ls、show s1 看节奏与最近几轮；pause、resume、rm 停、续、删（sN 不复用）
  全景图：atrium org show o2 先讲人话（是什么、能做什么、一件事怎么走完、由哪几部分组成、现在做到哪），--detail 展开章程正文、硬边界、预算等细节；人话字段写在章程 frontmatter：what、uses、flow、alias（人话名）、analogy（类比）、now、next、stages（阶段记录）；要点（必须守住的设计约束，不留修订）：atrium org point-add atrium/runtime 要点 --why 为什么 --by 'u1 09-27' --check 'tests/x.test.ts 用例名'，atrium org point-edit k1 --check ''，atrium org point-rm k1；已有部分改类型（只切「管方面」标记，留节点修订，project/org 不能改成 aspect，改回 module 前要先清掉适用范围）：atrium org edit 节点 --kind aspect|module；任务归属哪一部分：atrium task add 标题 --part atrium/runtime
  会审：影响面大、不可撤回的决定或疑难事故，atrium review add 议题 --concerns 前端,后端 --brief 议题.md [--issue 号 --repo 仓库 --comment] [--leader 节点]；每位专员并行出意见（最后一行「意见：同意／有条件同意／反对／否决」），收齐后 leader（缺省秘书）汇总一致与冲突、能定的定，专员否决由 leader 判断，碰到用户边界或谈不拢的标「需用户拍板」；结局投 council_decided / council_escalated 事件；atrium task wait t1 等结论，atrium review show t1 看意见与结论，用户拍板后 atrium review decide t1 结论
  干活与请看：atrium task add 标题 --by 前端 --ask 后端（派活附检查要点，交付后建审查子任务按清单审，全部通过才完成；否决或没出结论的交负责的 leader 判断，不认同用 atrium task merge tN 放行；专员的 invite_when 写提示规则，只提示不自动请）
  目标树迁移：atrium org migrate-goals 预览 gN 迁为所在节点的阶段记录、任务按目标回填归属部分，加 --apply 先整库备份再写入；写入后 goal 命令下线，旧写法 --goal gN 按映射落到节点
  看组织：atrium org tree；atrium org show o2；树为空时先 atrium org import --repo 仓库 预览、加 --apply 写入
  新能力的做法（只是做法与默认值，不设关卡）：先试点再铺开——新能力上线后先在一台主机、一两个任务、一个部分上用，跑通再放开，leader 放开前写一句 atrium task note tN 试点结果：在哪试、跑了什么、结果如何；上线即验——合入发版后运行时照 PR「端到端验证」一节派人在真实环境跑（task show 看结论），没过才投给 leader；写清组合——执行者在 PR 正文写「碰到哪些已有能力」一节，列出与哪些已有能力交叉（远程主机、Windows、紧急通道、总任务、技能挂载、合入队列、自升级……）、各验了什么，没碰到写「无」，试点优先挑这些组合
  每类东西放哪（用户纠正了、要立新规矩，先对这张表写到对应位置）：怎么做好一类事的方法与口味（如「字要少、一行一件事」）→ 技能，atrium skill edit 留修订；这类活由谁干、交付什么、用哪些技能、优先执行者 → 专员说明，短、引用技能、不写做法，atrium specialist edit；某一块产品必须守住的（如「常用命令 150 毫秒内」）→ 挂在那一块的要点，atrium org point-add；某个执行者的毛病与叮嘱（如「grok 别往一个文件堆」）→ 执行者档案，atrium workers edit；用户定的目标、底线、预算 → 章程，atrium org edit --charter；当时为什么这么定 → 决定记录，atrium decision add；现在在等什么、下次先看什么 → 备忘，atrium memo edit；跟着代码走的约定 → 仓库 AGENTS.md，走 PR。判断顺序：先问是不是做法或口味（→ 技能），再问是不是某一块的约束（→ 要点），再问是不是某个执行者（→ 档案）；专员说明只写分工
  组织技能：atrium skill add web-design ./web-design --reason 原因；atrium skill bind web-design atrium/web；执行者改了挂载副本会生成提议：atrium skill proposals；atrium skill accept p1
  看谁在干什么：atrium top（默认每 2 秒全屏刷新，q 退出；只打一次用 --once，脚本用 --once --json）
  派活并等结果：atrium task run t2（不写 --worker 与 task pick 同一份排序挑人，回执写理由；写死的执行者额度明显更紧时回执提醒）；急事走紧急通道：atrium task add 标题 --urgent --stopgap "atrium host pause h3; atrium task stop t1,t2" --avoid-host h3，再 atrium task run t2（或 atrium task run t2 --urgent、atrium task set t2 --urgent）：先执行止损动作并记事件；没空位先暂停闲时再普通任务（暂停的记下会话，紧急任务都跑完后自动续上）；不看额度富余，按一次通过率与速度挑人；检查插到最前、审阅与合入并行（审出问题开跟进任务）、其他任务的合入先暂停、合入后立即发版自升级；执行者 10 分钟没进展换人（ATRIUM_URGENT_IDLE_MINUTES 可调）；各阶段推给秘书与用户（只有上线、卡住、止损没做成叫醒秘书并推到手机，其余进 events digest）；leader 标紧急须 --why 写原因并知会用户；同时多于 2 个紧急任务时状态栏提示（额度保留、trust、依赖照旧）；管方面的部分（性能、安全…）开的任务缺省闲时：排在普通任务后面，有空闲执行者才派，排队中写「等空闲：前面还有 N 件普通任务」；要照常排用 atrium task set t2 --priority 普通（建任务时 --priority 闲时|普通）；atrium task run t2 --worker opencode；执行者写作 工具+模型[:强度]，工具有 claude、codex、opencode、kimi、grok、agy（Antigravity：agy 缺省 claude-opus-4-6-thinking，gemini 用带强度的模型名如 agy+gemini-3.8-flash-high 或基名加强度 agy+gemini-3.8-flash:high，claude-*、gpt-oss-* 不收强度；可选模型看 agy models）、cursor（Cursor CLI 的 cursor-agent：缺省 auto，强度写进模型名后缀如 cursor+gpt-5.3-codex:high，auto 不收强度）；atrium task wait t2；atrium task log t2 --follow\n  等事件：atrium events 查看送达与确认状态；atrium events wait --as secretary 只取要处理的事，首条后攒批 30 秒（--settle 可调），--all 取全部；atrium events digest 读知会摘要并自动确认；处理完 atrium events ack 12；取走的事件处理中 15 分钟内不重投（ATRIUM_EVENT_LEASE_MINUTES 可调），到点仍未确认才重投；自己 task stop 引出的事件不投给自己\n  执行机器（远程执行者）：本机是 h1；atrium host add 名称 --repo owner/name 登记一台；加 --ssh user@地址 --key 私钥路径 --tunnel 本机端口:远端端口 让服务自管 ssh -N -R、断线重连，host edit hN 可更新；按回执在那台机器上运行 atrium agent --server 服务地址 --token 接入码，之后可直接 atrium agent；atrium host ls/show 看主机与隧道状态；atrium task run t2 --host h2 派到指定的一台，不写 --host 在能接的主机里挑最空的（远程主机只自动接 --repo 登记过的仓库）；断线期间执行者照跑，重连后补传日志与结果；atrium host pause h2 暂停往那台派活；atrium host clean h2 停掉 Atrium 在那台跑的非紧急执行者，再结束那台上最近一天已结束任务留下的执行者进程树（远程由那台的代理按命令行与启动时刻核对，不碰你自己开的进程；回执逐条列出任务、pid、工具并记进任务事件）\n  重启与升级：atrium restart（随时可做，在跑的执行者由新服务接管，不等空闲）；等结果 atrium restart --wait\n  和秘书对话：atrium chat（缺省 opencode 原生界面，--acp 用 ACP；--tool codex 用 codex-acp）；秘书空闲时事件自动送入，忙时排队；界面关闭后服务恢复原会话处理事件再退出，界面和后台互斥\n  空闲时重启：atrium restart --when-idle；进度看 atrium status\n  报错后怎么办：按候选短号重试，或执行回执里的修正命令。\n\n命令参考（由命令表生成）\n${reference}`;
}
