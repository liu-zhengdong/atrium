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
    "task run",
    "task stop",
    "task merge",
    "task deliver",
    "task log",
    "task wait",
    "schedule add",
    "schedule ls",
    "schedule run",
    "schedule rm",
    "events",
    "events wait",
    "events ack",
    "chat",
    "secretary bridge",
  ],
  推送到手机: ["notify", "notify set"],
  执行机器: [
    "host ls",
    "host show",
    "host add",
    "host edit",
    "host remove",
    "host clean",
    "agent",
    "agent install",
  ],
  专员: [
    "specialist ls",
    "specialist add",
    "specialist edit",
    "workers",
    "workers edit",
  ],
  全景: ["map", "map context", "map edit"],
  组织: [
    "org tree",
    "org show",
    "org add",
    "org edit",
    "org point-add",
    "org point-edit",
    "org limits",
    "leader ls",
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
    "material keep",
    "material rm",
  ],
  凭据: [
    "secret set",
    "secret ls",
    "secret archive",
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
  技能: ["skill ls", "skill show", "skill add", "skill edit"],
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
  if (name === "workers") return "atrium workers harness/codex";
  if (name === "map") return "atrium map atrium --depth 2";
  if (name === "map edit")
    return "atrium map edit atrium/cli --what 一句话 --uses 场景一 --uses 场景二 --now 现状";
  if (name === "org add")
    return "atrium org add atrium ledger --name 待办本 --analogy 团队的任务白板";
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
  if (name === "material show" || name === "material rm")
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
/**
 * `atrium guide`：写给 Agent 的调用约定、退出码、每类东西放哪与主路径。
 * 命令用法只在 --help（由命令表生成），这里不重复。
 */
export function guide() {
  const codes = Object.entries(exitCodes)
    .map(([code, exit]) => `  ${exit}  ${code}`)
    .join("\n");
  return `Atrium 命令行说明书（写给 Agent）

调用约定
  命令用法只在 --help：atrium --help 列出全部命令，atrium <命令> --help 看一条的用法与示例。
  短号全局一致、不复用：任务 t1、部门 o1、要点 k1、决定 d1、选项单 c1、资料 m1、周期任务 s1、专员 r1、用户 u1、leader a1、执行机器 h1。部门也可写路径，如 atrium/web。
  --as：task/events 是事件订阅者，memo 是备忘的主人（缺省 secretary，leader 进程里缺省自己）；org/skill/map、pause/resume、workers edit、specialist 是改动记在谁名下（u1、secretary 或 aN，缺省 u1，秘书会话里缺省 secretary）。
  --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。stdout 只写一个 JSON 对象，提示在 stderr。
  文本回执最后一行是「动作：atrium 命令」；报错后按候选短号重试，或执行回执里的修正命令。
  异步状态用等待，不轮询：atrium task wait、atrium task log --follow、atrium events wait。
  执行者进程（带 ATRIUM_WORKER=1）不能操作服务，只能 atrium material get 取资料。

退出码与 code
  0  成功
${codes}

每类东西放哪
  规矩（用户的原则、口味、取舍、要守的约束）→ 要点：atrium org point-add 部门 要点 --why 为什么 --by 'u1 09-28' [--pos N]；挂在部门上按树往下继承，跨几个部门的放共同上级，同一部门越靠前越重要、冲突时靠前的优先。派活与 leader 唤醒只附归属部门链上的要点（atrium map context 部门）。
  做法与口味 → 技能（atrium skill edit）。
  谁干、交付什么、挂哪些技能 → 专员（只记分工）。
  工具与模型本身的事实 → 执行者档案（atrium workers edit）。
  给你留的额度、花费上限 → atrium org limits。
  用户拍板的事与原因 → 决定记录（atrium decision add；给人回看，不附进提示词）。
  处理过程 → 任务备注（atrium task note）；当前在等什么 → 备忘（atrium memo edit）。
  文件、设计稿 → 资料（atrium material add）；令牌、密码 → 凭据（atrium secret set，值不显示）。
  跟着代码走的约定 → 仓库 AGENTS.md。

主路径
  服务：只由 atrium（或 atrium start）启动，别的命令在服务没在跑时报错；例外：status 只报未运行、stop 幂等、restart 照样执行（没在跑就直接拉起，在跑的执行者由新服务接管）；数据默认 ~/.atrium（ATRIUM_DATA 改），端口 ATRIUM_PORT；令牌失效 atrium auth rotate。
  一键停机：atrium pause [--part 部门|--host hN] [--why 原因] 停下一切自主动作（派活、周期任务、唤醒、合入、发版）；atrium resume 恢复。
  拆任务派活：atrium task add 标题 [--parent t1] [--part 部门] [--by 专员] [--priority 紧急|修复|普通|闲时]；atrium task run t2 入队（一个队列，按优先级与入队先后拉起）；atrium task wait t2。有子任务的是总任务，状态按子孙汇总。
  额度：派活前看候选：atrium task run t2 --dry-run；只看额度：atrium quota；人工解除误判占用：atrium quota --clear claude。
  看谁在干什么：atrium top（脚本用 --once --json）；Claude Code 状态栏用 atrium statusline。
  等事件：atrium events wait --as secretary 只取要处理的事（攒批 30 秒）；处理完 atrium events ack 12。
  交付：执行者停在 PR；交付前在隔离实例跑端到端验证，把命令与输出贴进 PR「端到端验证」一节；运行时关卡查事实，高风险或低信任的 PR 合入前由另一个模型审阅；合入队列串行合入；自升级上线后只跑只读冒烟（status、task ls、--help）。
  持球与期限：每件没结束的事都有持球人，到期先叫醒持球人，再到期往上交；状态栏与 top 写「N 分钟没动」。
  leader：事件投给归属部门最近的 leader，它按事唤醒处理、以动作收尾；只把四类事上交：atrium leader escalate 说明 --kind shipped|cross|beyond|stuck。
  全景：人用 atrium map 打开本机网页（只读，只能拍板选项单）；Agent 用 atrium map 部门 --json，改人话字段用 atrium map edit。
  选项与拍板：调研写出选项单（atrium choice add 部门 --file 选项单.json），叫醒秘书递给用户；只有用户拍板（atrium choice pick / pass）。
  秘书：Claude Code 做秘书时 atrium secretary bridge --install-hook；也可 atrium chat（opencode / codex）。`;
}
