import type { Command } from "./main.ts";
import { exitCodes } from "./contract.ts";

export const groups: Record<string, string[]> = {
  服务: [
    "start",
    "status",
    "stop",
    "restart",
    "update",
    "pause",
    "resume",
    "auth status",
    "auth rotate",
  ],
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
    "task deliver",
    "task log",
    "task wait",
    "schedule add",
    "schedule ls",
    "schedule show",
    "schedule run",
    "schedule rm",
    "events",
    "events wait",
    "events digest",
    "events ack",
    "chat",
    "secretary bridge",
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
    "host clean",
    "agent",
    "agent install",
    "agent status",
    "agent uninstall",
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
  ],
  全景: ["map", "map context", "map edit", "map add"],
  组织: [
    "org tree",
    "org show",
    "org add",
    "org edit",
    "org point-add",
    "org point-edit",
    "org point-rm",
    "org history",
    "org limits",
    "leader ls",
    "leader show",
    "leader add",
    "leader edit",
    "leader escalate",
  ],
  备忘与决定: ["memo show", "memo edit", "decision add", "decision ls"],
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
  if (name === "task deliver")
    return "atrium task deliver t1 --pr https://github.com/acme/demo/pull/7";
  if (name === "task pick") return "atrium task pick t1 --risk medium";
  if (name === "task run")
    return "atrium task run t1 --worker codex+gpt-6-sol:high";
  if (name === "schedule add")
    return "atrium schedule add atrium/cli --kind patrol --every 1d --at 09:30";
  if (name === "host add")
    return "atrium host add 书房台式机 --repo liu-zhengdong/atrium --max 4";
  if (name === "host edit")
    return "atrium host edit h2 --ssh user@100.70.239.117 --tunnel 4310:14310";
  if (name === "agent")
    return "atrium agent --server http://host.orb.internal:4310 --token h2-接入码";
  if (name === "agent install")
    return "atrium agent install --server http://127.0.0.1:14310 --token h3-接入码";
  if (name === "events ack") return "atrium events ack 12 13";
  if (name === "notify set")
    return "atrium notify set --quiet 23:00-08:00 --proxy http://127.0.0.1:7890";
  if (name === "pause") return "atrium pause --why 先停下看看全局 --stop";
  if (name === "resume") return "atrium resume --host h3";
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
  if (name === "org point-edit") return "atrium org point-edit k27 --pos 1";
  if (name === "org limits")
    return "atrium org limits --quota-reserve 20 --money-max 0";
  if (name === "leader add")
    return "atrium leader add Atrium负责人 --worker claude+opus:high";
  if (name === "leader edit")
    return "atrium leader edit a1 --memo 在等t5合入，合入后上交已上线";
  if (name === "leader escalate")
    return "atrium leader escalate 组织树阶段达成 --kind shipped --task t5";
  if (name === "memo edit") return "atrium memo edit 在等t5合入 --as a1";
  if (name === "decision add")
    return "atrium decision add 额度读取不依赖OpenQuota --why 要迁到别的设备 --issue 352";
  if (name === "decision ls") return "atrium decision ls 额度 --node o2";
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
  const sample = command.args
    .split("[")[0]!
    .replace(/\S+…/g, "甲")
    .replace(/序号/g, "1")
    .replace(/\btN\b/g, "t1")
    .trim();
  return `atrium ${name}${sample ? ` ${sample}` : ""}`;
}
/** 命令参考里的一条（用法、说明、示例）：`atrium guide` 与 README 的命令参考共用。 */
export function referenceEntry(name: string, command: Command) {
  return (
    `atrium ${name} ${command.args}`.trimEnd() +
    `\n  ${command.about}\n  示例：${example(name, command)}`
  );
}
export function guide(commands: Record<string, Command>) {
  const codes = Object.entries(exitCodes)
    .map(([code, exit]) => `  ${exit}  ${code}`)
    .join("\n");
  const reference = Object.entries(commands)
    .map(([name, command]) => referenceEntry(name, command))
    .join("\n");
  return `Atrium 命令行说明书

调用约定
  短号：任务 t1、组织部分 o1、要点 k1、决定 d1、选项单 c1、资料 m1、周期任务 s1、用户 u1、leader a1、执行机器 h1。
  --as：task/events 是事件订阅者，memo 是备忘的主人（缺省 secretary，leader 进程里缺省自己）；org/skill/map、pause/resume、workers edit、specialist 是改动记在谁名下（u1、secretary 或 aN，缺省 u1，秘书会话里缺省 secretary）。
  所有命令支持 --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。只在 stdout 写一个 JSON 对象，提示在 stderr。文本回执最后一行是「动作：atrium 命令」。
  退出码与 code：
  0  成功
${codes}

常见任务
  服务：只由 atrium（或 atrium start）启动，别的命令在服务没在跑时报错；atrium restart 随时可做（在跑的执行者由新服务接管）；数据默认 ~/.atrium（ATRIUM_DATA 改），端口 ATRIUM_PORT；令牌失效 atrium auth rotate。
  一键停机：atrium pause [--part 部分|--host hN] [--why 原因] [--stop] 停下一切自主动作（派活、周期任务、leader 与后台秘书唤醒、合入、发版）；atrium resume 恢复。
  规矩（用户的判断）只放一处——要点：atrium org point-add 部分 要点 --why 为什么 --by 'u1 09-28' [--pos N]；挂在部分上、按树往下继承，跨几块的放共同上级；同一部分按 --pos 排序，越靠前越重要、冲突时靠前的优先（组织根上的几条就是全组织的原则）。派活与 leader 唤醒只附归属部分链上的要点（atrium map context 部分 看到的那一段）。其余地方各管各的：做法与口味 → 技能（atrium skill edit）；谁干、交付什么、挂哪些技能 → 专员（只记分工）；工具与模型本身的事实 → 执行者档案；给你留的额度、花费上限 → atrium org limits；用户拍板的事与原因 → 决定记录（atrium decision add，给人回看，不附进提示词）；处理过程 → 任务备注（atrium task note）；当前在等什么 → 备忘（atrium memo edit）；跟着代码走的约定 → 仓库 AGENTS.md。
  拆任务派活：atrium task add 标题 [--parent t1] [--part 部分] [--by 专员] [--priority 紧急|修复|普通|闲时]；atrium task pick t2 看候选；atrium task run t2 [--worker 工具+模型[:强度]] 入队（一个队列，按优先级与入队先后拉起）；atrium task wait t2；atrium task log t2 --follow；atrium task tree t1。有子任务的是总任务，状态按子孙汇总。
  交付：执行者停在 PR；交付前在隔离实例跑端到端验证，把命令与输出贴进 PR「端到端验证」一节，高风险或低信任的 PR 合入前由另一个模型审阅核对；关卡过了进合入队列串行合入；自升级上线后只跑只读冒烟（status、task ls、--help），没过记上线失败。
  看谁在干什么：atrium top（每 2 秒刷新，q 退出；--once 只打一次，脚本用 --once --json）；Claude Code 状态栏用 atrium statusline。
  等事件：atrium events wait --as secretary 只取要处理的事（攒批 30 秒）；处理完 atrium events ack 12；atrium events digest 读知会摘要。
  持球与期限：每件没结束的事都有持球人，到期发 overdue 事件（执行者卡死结束进程、受阻任务在 leader 手里 30 分钟叫醒、再 30 分钟上交），状态栏与 top 写「N 分钟没动」。
  leader：atrium leader add 名称 --worker claude+opus 登记，atrium org edit 部分 --leader a1 指派；事件投给归属部分最近的 leader，它按事唤醒处理、以动作收尾；只把四类事上交：atrium leader escalate 说明 --kind shipped|cross|beyond|stuck。
  全景：人用 atrium map 打开本机网页（只读，只能拍板选项单）；Agent 用 atrium map 部分 --json；改人话字段 atrium map edit 部分 --what 一句话 --uses 场景 --now 现状 [--stages 文件]，加一块 atrium map add 父部分 名称。
  周期任务：atrium schedule add 部分 [标题] --every 7d [--kind task|patrol|research] [--brief 文件]；patrol 按 uses 场景做体验巡检，发现直接建修复任务（同标题没结束的会被拒）；research 只调研，工作目录写了 choice.json 就登记成选项单。
  选项与拍板：选项单（atrium choice add 部分 --file 选项单.json）叫醒秘书递给用户，leader 可 atrium choice comment 写意见；只有用户拍板：atrium choice pick c3 1 3 --note 说明（选中的建任务）或 atrium choice pass c3 --note 原因（没选的记成决定）。
  执行机器：atrium host add 名称 --repo owner/name 登记，按回执在那台运行 atrium agent install；atrium task run t2 --host h2 指定派到哪台。
  秘书：atrium chat（opencode / codex）；Claude Code 做秘书时 atrium secretary bridge --install-hook。
  报错后：按候选短号重试，或执行回执里的修正命令。

命令参考（由命令表生成）
${reference}`;
}
