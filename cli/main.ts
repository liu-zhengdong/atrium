import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { dataDirectory, serviceUrl } from "../server/service-state.ts";
import { pad, width } from "./format.ts";
import { authCommands } from "./auth.ts";
import { workerCommands } from "./workers.ts";
import { roleCommands } from "./roles.ts";
import { taskCommands } from "./tasks.ts";
import { orgCommands } from "./org.ts";
import { goalCommands } from "./goals.ts";
import { skillCommands } from "./skills.ts";
import { topCommand } from "./top.ts";
import { statuslineCommand } from "./statusline.ts";
import { quotaCommands } from "./quota.ts";
import {
  leaderCommandGuard,
  verifierCommandGuard,
  workerGuard,
  workerReadable,
} from "./worker-guard.ts";
import { eventCommands } from "./events.ts";
import { chatCommand } from "./chat.ts";
import { mapCommands } from "./map.ts";
import { draftCommands } from "./drafts.ts";
import { reviewCommands } from "./reviews.ts";
import { leaderCommands } from "./leaders.ts";
import { patrolCommands } from "./patrol.ts";
import { scheduleCommands } from "./schedules.ts";
import { memoCommands } from "./memos.ts";
import { materialCommands } from "./materials.ts";
import { secretCommands } from "./secrets.ts";
import { choiceCommands } from "./choices.ts";
import { productCommands } from "./products.ts";
import { agentCommand, agentServiceCommands, hostCommands } from "./hosts.ts";
import { notifyCommands } from "./notify.ts";
import { closest, Problem } from "../server/problem.ts";
import { commandOnly, failure, withContext, type Context } from "./contract.ts";
import { example, groupOf, guide } from "./guide.ts";
import { cliErrorMessage, optionError } from "./error-message.ts";

export type Values = Record<
  string,
  string | boolean | (string | boolean)[] | undefined
>;
export type Input = { positionals: string[]; values: Values; json: boolean };
export type Command = {
  /** 用法里跟在命令名后面的部分，如「名称 [模型]」。 */
  args: string;
  about: string;
  options?: ParseArgsOptionsConfig;
  /** 位置参数个数的下限与上限。 */
  positionals: [min: number, max: number];
  /** 返回退出码；不返回视为 0。 */
  run(input: Input): Promise<number | void>;
};

export const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
export const strs = (values: Values, key: string) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};

const updateCommand: Command = {
  args: "[--to <版本>] [--repo <仓库>]",
  about: "检查并更新 Atrium 版本，安装新版本并展示改动摘要",
  options: {
    to: { type: "string" },
    repo: { type: "string" },
  },
  positionals: [0, 0],
  run: async ({ values }) => {
    const { update } = await import("./update.ts");
    await update(values as { to?: string; repo?: string });
    return 0;
  },
};

const restartCommand: Command = {
  args: "[--wait] [--timeout <秒>]",
  about: "平滑重启 Atrium 服务，随时可做：在跑的执行者不中断，由新服务接管",
  options: {
    wait: { type: "boolean", default: false },
    "when-idle": { type: "boolean", default: false },
    timeout: { type: "string" },
    data: { type: "string" },
  },
  positionals: [0, 0],
  run: async ({ values }) => {
    const { restart } = await import("./restart.ts");
    await restart(
      values as {
        wait?: boolean;
        "when-idle"?: boolean;
        timeout?: string;
        data?: string;
      },
    );
    return 0;
  },
};

export const commands: Record<string, Command> = {
  ...authCommands,
  // 看板放在任务组最前：先看谁在干活，再看单个任务。
  top: topCommand,
  statusline: statuslineCommand,
  ...taskCommands,
  ...roleCommands,
  ...workerCommands,
  ...reviewCommands,
  ...mapCommands,
  ...draftCommands,
  ...orgCommands,
  ...leaderCommands,
  ...patrolCommands,
  ...scheduleCommands,
  ...memoCommands,
  ...materialCommands,
  ...secretCommands,
  ...choiceCommands,
  ...productCommands,
  ...goalCommands,
  ...skillCommands,
  ...quotaCommands,
  ...eventCommands,
  ...notifyCommands,
  ...hostCommands,
  agent: agentCommand,
  ...agentServiceCommands,
  chat: chatCommand,
  update: updateCommand,
  restart: restartCommand,
};
export const service: [usage: string, about: string][] = [
  ["atrium", "启动或复用后台服务，输出地址"],
  ["atrium status", "查看服务状态、地址和数据目录"],
  ["atrium stop", "停止服务，保留数据；在跑的执行者由下次启动接管"],
  ["atrium restart", "平滑重启服务；在跑的执行者由新服务接管，不等空闲"],
  ["atrium update", "检查并更新 Atrium 版本；--to 指定目标版本"],
  ["atrium auth status", "查看本机用户认证状态（不启动服务）"],
  ["atrium auth rotate", "轮换用户令牌"],
];
const usage = "用法：atrium [命令] …；atrium --help 列出全部命令";

/** 一条命令的条目：atrium --help 与命令组的 --help 共用同一份。 */
function entry(name: string, command: Command): string {
  return `  atrium ${name} ${command.args}  ${command.about}`;
}

/** 命令组（task、events 这类带子命令的名字）：命令名以 `<组> ` 开头。 */
function membersOf(group: string): [string, Command][] {
  return Object.entries(commands).filter(([name]) =>
    name.startsWith(`${group} `),
  );
}

/**
 * 命令组的帮助：列出该组全部子命令与一句话说明。
 * 组名本身也是一个命令时（`atrium map`、`atrium events`），先讲这个裸命令怎么用、有哪些选项，
 * 再列子命令——否则「atrium map --help」只看到子命令，不知道直接敲 `atrium map o4` 会打开全景网页。
 */
export function groupHelp(group: string): string {
  const bare = commands[group];
  const usage = bare
    ? [`用法：atrium ${group} ${bare.args}`, `      atrium ${group} <子命令> …`]
    : [`用法：atrium ${group} <子命令> …`];
  return [
    ...usage,
    "",
    ...(bare ? [entry(group, bare)] : []),
    ...membersOf(group).map(([name, command]) => entry(name, command)),
    "",
    `命令详情：atrium ${group} <子命令> --help；全部命令：atrium --help；调用约定：atrium guide`,
  ].join("\n");
}

export function help(): string {
  const widest = Math.max(...service.map(([line]) => width(line)));
  return [
    "你是 Agent 的话，先读 atrium guide。",
    "",
    "服务",
    ...service.map(([line, about]) => `  ${pad(line, widest)}  ${about}`),
    ...[
      "任务",
      "执行机器",
      "专员",
      "全景",
      "目标",
      "组织",
      "备忘与决定",
      "资料",
      "选项与拍板",
    ].flatMap((group) => [
      "",
      group,
      ...Object.entries(commands)
        .filter(([name]) => groupOf(name) === group)
        .map(([name, command]) => entry(name, command)),
    ]),
    "",
    "命令详情：atrium <命令> --help；调用约定：atrium guide",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const json = argv.includes("--json");
  const state: Context = { lines: [] };
  const originalLog = console.log;
  if (json)
    console.log = (...args: unknown[]) => {
      state.lines.push(args.join(" "));
    };
  return withContext(state, async () => {
    let code = 0;
    let failed = false;
    let subcommand = name ?? "";
    try {
      // 执行者环境：除帮助外一律先过防护，拒绝时不会拉起服务、不碰默认数据目录。
      if (
        !["--help", "-h", "help", "guide"].includes(name ?? "") &&
        !rest.includes("--help")
      ) {
        if (!workerReadable(name, rest)) workerGuard();
        leaderCommandGuard(name);
        verifierCommandGuard(name);
      }
      if (name === undefined || name === "--no-open") {
        if (rest.filter((part) => part !== "--json").length)
          throw new Problem(400, usage, "usage");
        // --no-open 是没有 Web 之前的写法，照旧接受，行为相同。
        const { startService } = await import("../server/service.ts");
        const data = dataDirectory();
        const record = await startService(data);
        console.log(
          `Atrium → ${serviceUrl(record)}\n服务已就绪 · PID ${record.pid}\n数据：${data}`,
        );
        return 0;
      }
      if (["--help", "-h", "help"].includes(name)) {
        console.log(help());
        return 0;
      }
      if (
        (name === "status" || name === "stop") &&
        rest.every((arg) => arg === "--json")
      ) {
        const { serviceStatus, stopService } =
          await import("../server/service.ts");
        await (name === "status" ? serviceStatus : stopService)(
          dataDirectory(),
        );
        return 0;
      }
      if (name === "guide") {
        console.log(guide(commands));
        return 0;
      }
      // 命令组可同时有同名命令（events 列表）；带位置参数时解析子命令。
      if (
        name !== undefined &&
        membersOf(name).length &&
        (commands[name] === undefined ||
          (rest[0] !== undefined && !rest[0].startsWith("-")) ||
          (rest.length > 0 &&
            rest.every((arg) => arg === "--help" || arg === "-h")))
      ) {
        const words = rest.filter((arg) => !arg.startsWith("-"));
        const plain = rest.every(
          (arg) => arg === "--json" || arg === "--help" || arg === "-h",
        );
        if (!words.length && plain) {
          console.log(groupHelp(name));
          subcommand = "--help";
          return 0;
        }
        const word = words[0];
        // 同名命令带位置参数（atrium map o4）：第一个词不是子命令时交给同名命令。
        const own =
          word !== undefined &&
          commands[`${name} ${word}`] === undefined &&
          (commands[name]?.positionals[1] ?? 0) > 0;
        subcommand =
          word === undefined || own
            ? name
            : `${name} ${rest.splice(rest.indexOf(word), 1)[0]}`;
      } else subcommand = name ?? "";
      const command = commands[subcommand];
      if (!command) {
        const candidate = closest(
          subcommand,
          Object.keys(commands).map((ref) => ({ ref, name: ref })),
        )[0];
        throw new Problem(
          400,
          `不认识的命令：${subcommand}${candidate ? `。最接近的：${candidate.ref}` : ""}`,
          "usage",
          candidate ? [{ ref: candidate.ref, name: candidate.ref }] : undefined,
        );
      }
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(
          `用法：atrium ${subcommand} ${command.args}\n${command.about}\n示例：${example(subcommand, command)}\n相关命令：atrium guide`,
        );
        subcommand = "--help";
        return 0;
      }
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            json: { type: "boolean", default: false },
            ...command.options,
          },
          allowPositionals: true,
          strict: true,
        });
      } catch (error) {
        throw new Problem(
          400,
          `用法：atrium ${subcommand} ${command.args}\n${optionError(error)}\n示例：${example(subcommand, command)}`,
          "usage",
        );
      }
      const [min, max] = command.positionals;
      if (parsed.positionals.length < min || parsed.positionals.length > max) {
        throw new Problem(
          400,
          `用法：atrium ${subcommand} ${command.args}\n示例：${example(subcommand, command)}`,
          "usage",
        );
      }
      code =
        (await command.run({
          positionals: parsed.positionals,
          values: parsed.values as Values,
          json: parsed.values.json === true,
        })) ?? 0;
      if (code === 124)
        throw new Problem(408, state.lines.at(-1) ?? "等待超时", "timeout");
      return code;
    } catch (error) {
      failed = true;
      const result = failure(error);
      result.message = cliErrorMessage(result.message, commands[subcommand]);
      if (!commands[subcommand] && result.candidates?.[0])
        result.next = `atrium ${result.candidates[0].ref} --help`;
      if (json) {
        state.lines = [];
        originalLog(
          JSON.stringify({
            ok: false,
            error: {
              code: result.code,
              message:
                result.code === "confirmation_required"
                  ? result.message.split("\n", 1)[0]
                  : result.message,
              ...(result.candidates ? { candidates: result.candidates } : {}),
            },
            next: commandOnly(result.next),
          }),
        );
      } else {
        console.error(result.message);
        if (commands[subcommand] && result.candidates?.length)
          console.error(
            `最接近的：${result.candidates.map(({ name, ref }) => `${name === ref.split("/").at(-1) ? ref : `${name}（${ref}）`}`).join("、")}`,
          );
        if (result.next && result.code !== "confirmation_required")
          console.error(`修正：${result.next}`);
      }
      return result.exit;
    } finally {
      console.log = originalLog;
      if (json && !failed) {
        // Existing commands may print their own JSON; prefer the final API response.
        const next = state.next ?? defaultNext(subcommand);
        originalLog(
          JSON.stringify({
            ok: true,
            result: state.result ?? state.lines.at(-1) ?? null,
            next: commandOnly(next),
          }),
        );
      } else if (
        !json &&
        !failed &&
        !["--help", "-h", "help", "guide"].includes(subcommand)
      ) {
        const next = state.next ?? defaultNext(subcommand);
        if (next) originalLog(next);
      }
    }
  });
}
function defaultNext(name: string): string | null {
  if (name === "" || name === "--no-open") return "停止：atrium stop";
  if (name === "update") return "生效：atrium restart";
  if (name === "restart") return "查看状态：atrium status";
  if (name === "status") return "看任务：atrium top";
  return null;
}
