import type { Command } from "./main.ts";
import { exitCodes } from "./contract.ts";

export const groups: Record<string, string[]> = {
  服务: ["status", "stop", "restart", "update", "auth status", "auth rotate"],
  任务: [
    "quota",
    "top",
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
    "review add",
    "review show",
    "review decide",
    "events",
    "events wait",
    "events digest",
    "events ack",
    "chat",
  ],
  角色: [
    "role ls",
    "role show",
    "role add",
    "role edit",
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
  if (name === "patrol report")
    return "atrium patrol report t1 --phenomenon 帮助缺少示例 --step 第一步 --command atrium-guide --expected 有示例 --actual 没有示例 --kind awkward";
  if (name === "patrol decide")
    return "atrium patrol decide f1 --ignore 已有同类改进计划";
  if (name === "events ack") return "atrium events ack 12 13";
  if (name === "review add")
    return "atrium review add 公开仓库 --concerns 安全,质量 --brief 议题.md --issue 322";
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
  return `Atrium 命令行说明书\n\n调用约定\n  任务用 t1，组织节点用 o1（旧目标与里程碑 g1 迁为节点阶段记录的 id），用户用 u1，组织节点 leader 用 a1。\n  task/events 的 --as 是事件订阅者名，缺省 secretary（leader 进程里缺省是自己的 aN）；org/skill/goal 的 --as 是 u1 或某个节点 leader 的 aN，缺省 u1；技能修订提议用 p1。\n  所有命令支持 --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。只在 stdout 写一个 JSON 对象，提示在 stderr。\n  文本回执最后一行是「动作：atrium 命令」，没有下一步则省略。\n  退出码与 code：\n  0  成功\n${codes}\n\n常见任务\n  令牌失效：atrium auth rotate（使用当前 ATRIUM_DATA）。\n  数据目录与端口：默认数据 ~/.atrium，用 ATRIUM_DATA 改；前一代数据 ~/.pi/atrium/data 已归档不再使用。端口被另一份数据的 Atrium 占着时回执给出它的数据目录，要用它就设 ATRIUM_DATA=那个目录；被别的程序占着就换 ATRIUM_PORT\n  拆任务看全貌：atrium task add 目标；atrium task add 子任务 --parent t1；atrium task tree t1；人工收尾：atrium task set t2 --status done\n  派活前看候选：atrium task pick t2（候选执行者、能不能接、账号额度、正忙、在干活的专员下的交付记录，最上面是推荐与理由）；只看额度：atrium quota；人工解除误判占用：atrium quota --clear claude
  leader 层：atrium leader add 名称 --worker claude+opus 登记，atrium org edit 节点 --leader a1 指派；任务没写 --owner 时事件投给归属部分最近的 leader（事件 routed 写明投给谁、为什么），找不到投秘书；leader 有要处理的事件时攒批 30 秒、起一次性进程处理并确认，连续失败或超时转交秘书；leader 只能动负责的节点及子节点（越权报 leader_scope），只把四类事上交：atrium leader escalate 说明 --kind shipped|cross|beyond|stuck [--task tN]；看 leader：atrium leader ls、atrium top
  看全景：人用网页，atrium map 打开本机全景网页（一次性登录链接、只读、实时刷新）；Agent 用命令行，atrium map o2 --json 读一块（人话字段、组成、阶段、在跑任务、专员，与网页同一接口），atrium map context o2 是派活时自动附进提示词的全景位置与要点（有长度上限）；改只走命令行：atrium map edit o2 --what 一句话 --uses 场景 --flow 步骤 --now 现状，atrium map add o2 名称 --analogy 类比；专员什么时候请来：atrium map edit 专员 --when 一句话
  体验巡检：atrium patrol run o4 手动巡检一条 uses 场景（逐次轮换）；巡检进程只读全景、帮助和回执，用当前服务与真实数据，不读代码；发现用 atrium patrol report tN 记录，同节点同现象去重；结束后新增发现投给该节点 leader；leader 用 atrium patrol decide fN --task tN 或 --merge tN 或 --ignore 原因；atrium patrol findings o4 与全景可看处理结果
  全景图：atrium org show o2 先讲人话（是什么、能做什么、一件事怎么走完、由哪几部分组成、现在做到哪），--detail 展开章程正文、硬边界、预算等细节；人话字段写在章程 frontmatter：what、uses、flow、alias（人话名）、analogy（类比）、now、next、stages（阶段记录）；要点（必须守住的设计约束，不留修订）：atrium org point-add atrium/runtime 要点 --why 为什么 --by 'u1 09-27' --check 'tests/x.test.ts 用例名'，atrium org point-edit k1 --check ''，atrium org point-rm k1；任务归属哪一部分：atrium task add 标题 --part atrium/runtime
  会审：影响面大、不可撤回的决定或疑难事故，atrium review add 议题 --concerns 安全,质量 --brief 议题.md [--issue 号 --repo 仓库 --comment] [--leader 节点]；每位专员并行出意见（最后一行「意见：同意／有条件同意／反对／否决」），收齐后 leader（缺省秘书）汇总一致与冲突、能定的定，碰到用户边界、谈不拢或有专员以底线否决的标「需用户拍板」；结局投 council_decided / council_escalated 事件；atrium task wait t1 等结论，atrium review show t1 看意见与结论，用户拍板后 atrium review decide t1 结论
  请专员：atrium task add 标题 --concern 安全,质量（派活附检查要点，交付后建审查子任务按清单审，全部通过才完成、任一否决即卡住并写原因；关注点章程 invite_when 写提示规则，只提示不自动请）
  目标树迁移：atrium org migrate-goals 预览 gN 迁为所在节点的阶段记录、任务按目标回填归属部分，加 --apply 先整库备份再写入；写入后 goal 命令下线，旧写法 --goal gN 按映射落到节点
  看组织：atrium org tree；atrium org show o2；树为空时先 atrium org import --repo 仓库 预览、加 --apply 写入
  组织技能：atrium skill add web-design ./web-design --reason 原因；atrium skill bind web-design atrium/web；执行者改了挂载副本会生成提议：atrium skill proposals；atrium skill accept p1
  看谁在干什么：atrium top（默认每 2 秒全屏刷新，q 退出；只打一次用 --once，脚本用 --once --json）
  派活并等结果：atrium task run t2（不写 --worker 与 task pick 同一份排序挑人，回执写理由；写死的执行者额度明显更紧时回执提醒）；atrium task run t2 --worker opencode；atrium task wait t2；atrium task log t2 --follow\n  等事件：atrium events 查看送达与确认状态；atrium events wait --as secretary 只取要处理的事，首条后攒批 30 秒（--settle 可调），--all 取全部；atrium events digest 读知会摘要并自动确认；处理完 atrium events ack 12；取走的事件处理中 15 分钟内不重投（ATRIUM_EVENT_LEASE_MINUTES 可调），到点仍未确认才重投；自己 task stop 引出的事件不投给自己\n  重启与升级：atrium restart（随时可做，在跑的执行者由新服务接管，不等空闲）；等结果 atrium restart --wait\n  和秘书对话：atrium chat（缺省 opencode 原生界面，--acp 用 ACP；--tool codex 用 codex-acp）；秘书空闲时事件自动送入，忙时排队；界面关闭后服务恢复原会话处理事件再退出，界面和后台互斥\n  空闲时重启：atrium restart --when-idle；进度看 atrium status\n  报错后怎么办：按候选短号重试，或执行回执里的修正命令。\n\n命令参考（由命令表生成）\n${reference}`;
}
