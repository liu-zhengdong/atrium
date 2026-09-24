import type { Command } from "./main.ts";
import { exitCodes } from "./contract.ts";

export const groups: Record<string, string[]> = {
  服务: ["status", "stop"],
  身份: [
    "list",
    "show",
    "create",
    "start",
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
    "update",
    "restart",
  ],
  聊天: [
    "chats",
    "read",
    "wait",
    "send",
    "group",
    "invite",
    "kick",
    "box",
    "notify",
    "search",
    "user",
  ],
  账号与凭据: ["connect", "accounts", "assign", "unassign"],
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
  const sample = command.args
    .split("[")[0]!
    .replace(/\S+…/g, "甲")
    .replace(/(会话\|身份|名称|身份|群名|会话|Agent)/g, "甲")
    .replace(/账号/g, "k1")
    .replace(/provider\/id\[:思考强度\]/g, "deepseek/deepseek-flash")
    .replace(/provider/g, "deepseek")
    .replace(/正文|消息/g, "你好")
    .replace(/序号/g, "1")
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
  return `Atrium 命令行说明书\n\n调用约定\n  身份用 a1，会话用 c1，用户用 u1；名称也可用，重名时用短号。\n  --as 指定发言身份；默认以用户身份发言。\n  除交互式 run 外，所有命令支持 --json：成功 {"ok":true,"result":接口结果,"next":下一步命令或null}；失败 {"ok":false,"error":{"code","message","candidates"?},"next":修正命令或null}。只在 stdout 写一个 JSON 对象，提示在 stderr。\n  文本回执最后一行是「动作：atrium 命令」，没有下一步则省略。\n  退出码与 code：\n  0  成功\n${codes}\n\n常见任务\n  发消息并等回复：atrium send a1 正文；回执中的 atrium wait c1 --after 1 可直接复制。\n  读新消息：atrium read c1 --after 1\n  建群并邀请：atrium group 项目群 甲；atrium invite c2 乙\n  看身份在做什么：atrium trace 甲\n  报错后怎么办：按候选短号重试，或执行回执里的修正命令。\n\n命令参考（由命令表生成）\n${reference}`;
}
