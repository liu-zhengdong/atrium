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
    "task run",
    "task done",
    "task stop",
    "task log",
    "task wait",
    "events",
    "events wait",
    "events ack",
  ],
  组织: [
    "org tree",
    "org show",
    "org add",
    "org edit",
    "org history",
    "org revert",
    "org import",
    "org link-roles",
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
  if (name === "task run")
    return "atrium task run t1 --worker codex+gpt-6-sol:high";
  if (name === "events ack") return "atrium events ack 12 13";
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
  return `Atrium 命令行说明书\n\n调用约定\n  任务用 t1，组织节点用 o1，用户用 u1，组织节点 leader 用 a1。\n  task/events 的 --as 是事件订阅者名，缺省 secretary；org/skill 的 --as 是 u1 或某个节点 leader 的 aN，缺省 u1；技能修订提议用 p1。\n  所有命令支持 --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。只在 stdout 写一个 JSON 对象，提示在 stderr。\n  文本回执最后一行是「动作：atrium 命令」，没有下一步则省略。\n  退出码与 code：\n  0  成功\n${codes}\n\n常见任务\n  令牌失效：atrium auth rotate（使用当前 ATRIUM_DATA）。\n  拆任务看全貌：atrium task add 目标；atrium task add 子任务 --parent t1；atrium task tree t1；人工收尾：atrium task set t2 --status done\n  派活前看额度：atrium quota；人工解除误判占用：atrium quota --clear claude
  看组织：atrium org tree；atrium org show o2；树为空时先 atrium org import --repo 仓库 预览、加 --apply 写入
  组织技能：atrium skill add web-design ./web-design --reason 原因；atrium skill bind web-design atrium/web；执行者改了挂载副本会生成提议：atrium skill proposals；atrium skill accept p1
  看谁在干什么：atrium top（默认每 2 秒全屏刷新，q 退出；只打一次用 --once，脚本用 --once --json）
  派活并等结果：atrium task run t2 --worker opencode；atrium task wait t2；atrium task log t2 --follow\n  等事件：atrium events 查看送达与确认状态；atrium events wait --as secretary；处理完 atrium events ack 12；取走的事件处理中 15 分钟内不重投（ATRIUM_EVENT_LEASE_MINUTES 可调），到点仍未确认才重投；自己 task stop 引出的事件不投给自己\n  重启与升级：atrium restart（随时可做，在跑的执行者由新服务接管，不等空闲）；等结果 atrium restart --wait\n  报错后怎么办：按候选短号重试，或执行回执里的修正命令。\n\n命令参考（由命令表生成）\n${reference}`;
}
