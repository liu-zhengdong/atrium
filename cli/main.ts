import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { dataDirectory, serviceUrl } from "../server/service-state.ts";
import { pad, width } from "./format.ts";
import { agentCommands } from "./agents.ts";
import { chatCommands } from "./chats.ts";
import { accountCommands } from "./accounts.ts";
import { connectCommand } from "./connect.ts";
import { pluginCommands } from "./plugins.ts";
import { resourceCommands } from "./resources.ts";
import { closest, Problem } from "../server/problem.ts";
import { failure, withContext, type Context } from "./contract.ts";
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

export const commands: Record<string, Command> = {
  ...agentCommands,
  ...chatCommands,
  connect: connectCommand,
  ...accountCommands,
  ...pluginCommands,
  ...resourceCommands,
};
const service: [usage: string, about: string][] = [
  ["atrium", "启动或复用后台服务，打开 Web"],
  ["atrium --no-open", "启动或复用服务，仅输出地址"],
  ["atrium status", "查看服务状态、地址和数据目录"],
  ["atrium stop", "停止服务及其托管的 Agent，保留数据"],
];
const usage = "用法：atrium [命令] …；atrium --help 列出全部命令";

export function help(): string {
  const widest = Math.max(...service.map(([line]) => width(line)));
  return [
    "你是 Agent 的话，先读 atrium guide。",
    "",
    "服务",
    ...service.map(([line, about]) => `  ${pad(line, widest)}  ${about}`),
    ...["身份", "聊天", "账号与凭据", "插件技能与规则"].flatMap((group) => [
      "",
      group,
      ...Object.entries(commands)
        .filter(([name]) => groupOf(name) === group)
        .map(
          ([name, command]) =>
            `  atrium ${name} ${command.args}  ${command.about}`,
        ),
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
    let usageNext: string | undefined;
    try {
      if (name === undefined || name === "--no-open") {
        if (rest.filter((part) => part !== "--json").length)
          throw new Problem(400, usage, "usage");
        const { startService, openWeb } = await import("../server/service.ts");
        const data = dataDirectory();
        const record = await startService(data);
        console.log(
          `Atrium → ${serviceUrl(record)}\n服务已就绪 · PID ${record.pid}\n数据：${data}\n停止：atrium stop`,
        );
        if (name === undefined) await openWeb(record);
        return 0;
      }
      if (["--help", "-h", "help"].includes(name)) {
        console.log(help());
        return 0;
      }
      // 不带名称的 status / stop 说的是服务本身；带名称的是某个身份。
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
      subcommand =
        name === "account" || name === "plugin" || name === "skill"
          ? `${name} ${rest.shift() ?? ""}`.trim()
          : name;
      const command = commands[subcommand];
      if (subcommand === "account login")
        throw new Problem(400, "已由 atrium connect 代替", "usage");
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
        usageNext = example(subcommand, command);
        throw new Problem(
          400,
          `用法：atrium ${subcommand} ${command.args}\n${optionError(error)}\n示例：${usageNext}`,
          "usage",
        );
      }
      const [min, max] = command.positionals;
      if (parsed.positionals.length < min || parsed.positionals.length > max) {
        usageNext = example(subcommand, command);
        throw new Problem(
          400,
          `用法：atrium ${subcommand} ${command.args}\n示例：${usageNext}`.trimEnd(),
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
      const result = failure(error, usageNext);
      result.message = cliErrorMessage(result.message, commands[subcommand]);
      if (subcommand === "account login") result.next = "atrium connect --help";
      if (!commands[subcommand] && result.candidates?.[0])
        result.next = `atrium ${result.candidates[0].ref} --help`;
      if (
        subcommand === "model" &&
        result.code === "model_not_found" &&
        result.candidates?.[0] &&
        rest[0]
      )
        result.next = `atrium model ${rest[0]} ${result.candidates[0].ref}`;
      if (json) {
        state.lines = [];
        originalLog(
          JSON.stringify({
            ok: false,
            error: {
              code: result.code,
              message: result.message,
              ...(result.candidates ? { candidates: result.candidates } : {}),
            },
            next: commandOnly(result.next),
          }),
        );
      } else {
        console.error(result.message);
        if (commands[subcommand] && result.candidates?.length)
          console.error(
            `最接近的：${result.candidates.map(({ name, ref }) => `${name}（${ref}）`).join("、")}`,
          );
        if (result.next) console.error(`修正：${result.next}`);
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
  if (["stop", "delete", "account remove", "unassign", "kick"].includes(name))
    return null;
  if (name === "assign") return "看分配：atrium accounts";
  if (name === "status") return "查看身份：atrium list";
  if (name === "list") return "查看会话：atrium chats";
  if (name === "chats") return "查看身份：atrium list";
  return null;
}
function commandOnly(next: string | null): string | null {
  return next?.slice(next.indexOf("atrium ")) ?? null;
}
