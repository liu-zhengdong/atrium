import type { Command } from "./main.ts";
import { exitCodes } from "./contract.ts";

export const groups: Record<string, string[]> = {
  服务: ["status", "stop", "restart", "update", "open", "auth rotate"],
  身份: [
    "list",
    "show",
    "create",
    "start",
    "new-session",
    "retry",
    "delete",
    "config",
    "profile",
    "model",
    "trace",
    "runtimes",
    "attach",
    "promote",
    "run",
  ],
  聊天: [
    "chats",
    "read",
    "wait",
    "send",
    "group",
    "invite",
    "kick",
    "disband",
    "box",
    "notify",
    "search",
    "user",
  ],
  任务: [
    "quota",
    "top",
    "task add",
    "task ls",
    "task show",
    "task tree",
    "task set",
    "task run",
    "task stop",
    "task log",
    "task wait",
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
  ],
  账号与凭据: [
    "connect",
    "accounts",
    "account add",
    "account check",
    "assign",
    "unassign",
    "adapters url",
    "runner list",
    "runner start",
    "runner drain",
    "runner resume",
    "runner bind",
    "runner migrate",
    "runner unbind",
    "runner reclaim",
    "runner issue",
    "runner rotate",
    "runner revoke",
  ],
  插件技能与规则: [],
};
export function groupOf(name: string) {
  return (
    Object.entries(groups).find(([, members]) => members.includes(name))?.[0] ??
    (name.startsWith("account") ? "账号与凭据" : "插件技能与规则")
  );
}
export function example(name: string, command: Command) {
  if (name === "model") return "atrium model 甲 deepseek/deepseek-v4-pro";
  if (name === "task add") return "atrium task add 拆分登录模块 --parent t1";
  if (name === "task set") return "atrium task set t1 --status done";
  if (name === "task run")
    return "atrium task run t1 --worker codex+gpt-6-sol:high";
  if (name === "events ack") return "atrium events ack 12 13";
  const sample = command.args
    .split("[")[0]!
    .replace(/\S+…/g, "甲")
    .replace(/(会话\|身份|名称|身份|群名|会话|Agent)/g, "甲")
    .replace(/账号/g, "k1")
    .replace(/provider\/id\[:思考强度\]/g, "deepseek/deepseek-flash")
    .replace(/provider/g, "deepseek")
    .replace(/正文|消息/g, "你好")
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
  return `Atrium 命令行说明书\n\n调用约定\n  身份用 a1，会话用 c1，用户用 u1，任务用 t1；名称也可用，重名时用短号。\n  --as 指定发言身份；默认以用户身份发言。\n  除交互式 run 外，所有命令支持 --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。只在 stdout 写一个 JSON 对象，提示在 stderr。\n  文本回执最后一行是「动作：atrium 命令」，没有下一步则省略。\n  退出码与 code：\n  0  成功\n${codes}\n\n常见任务\n  Web 登录：atrium open；无图形界面或验收脚本用 ATRIUM_DATA=… ATRIUM_PORT=… atrium open --print 取 60 秒一次性链接，不要贴进 PR 或日志。\n  令牌失效：atrium auth rotate（使用当前 ATRIUM_DATA；同时废止全部 Web 会话）。\n  外部推送：atrium adapters url a1 显示窄权限接收地址；--rotate 轮换，--revoke 撤销。\n  发消息并等回复：atrium send a1 正文；回执中的 atrium wait c1 --after 1 可直接复制。\n  读新消息：atrium read c1 --after 1\n  建群并邀请：atrium group 项目群 甲；atrium invite c2 乙\n  拆任务看全貌：atrium task add 目标；atrium task add 子任务 --parent t1；atrium task tree t1；人工收尾：atrium task set t2 --status done\n  派活前看额度：atrium quota
  看谁在干什么：atrium top（默认每 2 秒全屏刷新，q 退出；只打一次用 --once，脚本用 --once --json）
  派活并等结果：atrium task run t2 --worker opencode；atrium task wait t2；atrium task log t2 --follow\n  等事件：atrium events wait --as secretary；处理完 atrium events ack 12；取走的事件处理中 15 分钟内不重投（ATRIUM_EVENT_LEASE_MINUTES 可调），到点仍未确认才重投；自己 task stop 引出的事件不投给自己\n  看身份在做什么：atrium trace 甲；旧会话受损时：atrium new-session 甲\n  报错后怎么办：按候选短号重试，或执行回执里的修正命令。\n\n命令参考（由命令表生成）\n${reference}`;
}
