import { recordNext } from "./contract.ts";
import { printJson } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { Problem } from "../server/problem.ts";
import { pauseText, type Pause } from "../server/pause.ts";
import { defaultActor } from "./worker-guard.ts";

/** 一键停机的命令行（server/pause.ts）：只经 HTTP 调服务。 */

const client = async () => (await import("./service.ts")).connect();
const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;

/** --part 节点、--host hN 两个只能给一个；都不给是全局。 */
function scopeOf(values: Values) {
  const part = str(values, "part");
  const host = str(values, "host");
  if (part !== undefined && host !== undefined)
    throw new Problem(400, "--part 与 --host 只能给一个", "usage");
  if (host !== undefined && !/^h[1-9][0-9]{0,8}$/.test(host.trim()))
    throw new Problem(
      400,
      `--host 应为主机短号，如 h2（收到：${host}）`,
      "usage",
    );
  return {
    ...(part !== undefined ? { part } : {}),
    ...(host !== undefined ? { host: host.trim() } : {}),
  };
}

/** 记在谁名下：秘书会话记 secretary，否则 u1。 */
const asQuery = () => {
  const who = defaultActor();
  return who ? `?${new URLSearchParams({ as: who })}` : "";
};

/** 状态、看板用：有暂停时一行一条。 */
export const pauseLines = (pauses: readonly Pause[] | undefined) =>
  (pauses ?? []).map(pauseText);

const scopeWords = (values: Values) => {
  const part = str(values, "part");
  const host = str(values, "host");
  return part !== undefined
    ? ` --part ${part}`
    : host !== undefined
      ? ` --host ${host}`
      : "";
};

export const pauseCommands: Record<string, Command> = {
  pause: {
    args: "[--part 节点|--host hN] [--why 原因] [--stop]",
    about:
      "一键停机：停下一切自主动作——不派活（自动派发、排队拉起、重试换人）、不生成周期任务、不叫醒 leader 与后台秘书、合入与上线不推进；事件照常落库但不投给等待的人。在跑的执行者缺省跑完不接新的，--stop 一并停掉。--part 只停那一块（派活、周期任务、合入、leader），--host 只是不往那台派活与检查",
    options: {
      part: { type: "string" },
      host: { type: "string" },
      why: { type: "string" },
      stop: { type: "boolean" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const why = str(values, "why");
      const result = await (
        await client()
      ).post<{ pause: Pause; changed: boolean; stopped: string[] }>(
        `/pause${asQuery()}`,
        {
          ...scopeOf(values),
          ...(why !== undefined ? { why } : {}),
          ...(values.stop === true ? { stop: true } : {}),
        },
      );
      if (json) printJson(result);
      else
        console.log(
          [
            result.changed
              ? pauseText(result.pause)
              : `本来就暂停着：${pauseText(result.pause)}`,
            result.stopped.length
              ? `一并停掉：${result.stopped.join("、")}`
              : values.stop === true
                ? "没有在跑的要停"
                : "在跑的执行者照跑，跑完不接新的；要一并停掉加 --stop",
          ].join("\n"),
        );
      recordNext(`恢复：atrium resume${scopeWords(values)}`);
    },
  },
  resume: {
    args: "[--part 节点|--host hN]",
    about:
      "恢复 atrium pause 停下的（不写范围是全局）：排着的按顺序拉起，到点的周期任务只补一轮，攒下的事件照常叫醒 leader 与秘书",
    options: { part: { type: "string" }, host: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (
        await client()
      ).post<{ resumed: Pause | null; pauses: Pause[] }>(
        `/resume${asQuery()}`,
        scopeOf(values),
      );
      if (json) printJson(result);
      else
        console.log(
          [
            result.resumed
              ? `已恢复；原来是 ${pauseText(result.resumed)}`
              : "这一范围本来就没暂停",
            ...pauseLines(result.pauses).map((line) => `仍在暂停：${line}`),
          ].join("\n"),
        );
      recordNext("看谁在干活：atrium top");
    },
  },
};
