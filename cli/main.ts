import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { dataDirectory, serviceUrl } from "../server/service-state.ts";
import { commandAgent } from "../shared/command-agent.ts";
import { pad, width } from "./format.ts";
import { agentCommands } from "./agents.ts";
import { chatCommands } from "./chats.ts";
import { accountCommands } from "./accounts.ts";
import { authCommands } from "./auth.ts";
import { runnerCommands } from "./runners.ts";
import { connectCommand } from "./connect.ts";
import { pluginCommands } from "./plugins.ts";
import { resourceCommands } from "./resources.ts";
import { taskCommands } from "./tasks.ts";
import { workerGuard } from "./worker-guard.ts";
import { eventCommands } from "./events.ts";
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
  args: "[--wait] [--timeout <秒>] [--agent-timeout <毫秒>]",
  about: "平滑重启 Atrium 服务，等待当前回合结束并自动回滚失败",
  options: {
    wait: { type: "boolean", default: false },
    timeout: { type: "string" },
    data: { type: "string" },
    "probe-agent": { type: "string" },
    "agent-timeout": { type: "string" },
  },
  positionals: [0, 0],
  run: async ({ values }) => {
    const { restart } = await import("./restart.ts");
    await restart(
      values as {
        wait?: boolean;
        timeout?: string;
        data?: string;
        "probe-agent"?: string;
        "agent-timeout"?: string;
      },
    );
    return 0;
  },
};

export const commands: Record<string, Command> = {
  ...agentCommands,
  ...chatCommands,
  connect: connectCommand,
  ...accountCommands,
  ...authCommands,
  ...runnerCommands,
  ...pluginCommands,
  ...resourceCommands,
  ...taskCommands,
  ...eventCommands,
  update: updateCommand,
  restart: restartCommand,
};
const service: [usage: string, about: string][] = [
  ["atrium", "启动或复用后台服务，打开 Web"],
  ["atrium --no-open", "启动或复用服务，仅输出地址"],
  ["atrium open", "生成一次性登录链接并打开 Web；--print 仅打印链接"],
  ["atrium status", "查看服务状态、地址和数据目录"],
  ["atrium stop", "停止服务及其托管的 Agent，保留数据"],
  ["atrium restart", "平滑重启服务，保持运行状态并自动回滚失败"],
  ["atrium update", "检查并更新 Atrium 版本；--to 指定目标版本"],
];
const usage = "用法：atrium [命令] …；atrium --help 列出全部命令";

export function help(): string {
  const widest = Math.max(...service.map(([line]) => width(line)));
  return [
    "你是 Agent 的话，先读 atrium guide。",
    "",
    "服务",
    ...service.map(([line, about]) => `  ${pad(line, widest)}  ${about}`),
    ...["身份", "聊天", "任务", "账号与凭据", "插件技能与规则"].flatMap(
      (group) => [
        "",
        group,
        ...Object.entries(commands)
          .filter(([name]) => groupOf(name) === group)
          .map(
            ([name, command]) =>
              `  atrium ${name} ${command.args}  ${command.about}`,
          ),
      ],
    ),
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
      // 执行者环境：除帮助外一律先过防护，拒绝时不会拉起服务、不碰默认数据目录。
      if (
        !["--help", "-h", "help", "guide"].includes(name ?? "") &&
        !rest.includes("--help")
      )
        workerGuard();
      if (name === undefined || name === "--no-open") {
        if (rest.filter((part) => part !== "--json").length)
          throw new Problem(400, usage, "usage");
        const { startService, openWeb, canOpenBrowser, noBrowserHint } =
          await import("../server/service.ts");
        const data = dataDirectory();
        const record = await startService(data);
        console.log(
          `Atrium → ${serviceUrl(record)}\n服务已就绪 · PID ${record.pid}\n数据：${data}`,
        );
        if (name === undefined) {
          const { loginLink } = await import("./auth.ts");
          const url = await loginLink(data, record);
          if (canOpenBrowser(process.stdin, process.stdout))
            await openWeb(record, url);
          else console.log(noBrowserHint(url));
        }
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
        name === "account" ||
        name === "auth" ||
        name === "runner" ||
        name === "adapters" ||
        name === "plugin" ||
        name === "skill" ||
        name === "task" ||
        name === "events"
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
        throw new Problem(
          400,
          `用法：atrium ${subcommand} ${command.args}\n${optionError(error)}\n示例：${example(subcommand, command)}`,
          "usage",
        );
      }
      const [min, max] = command.positionals;
      if (parsed.positionals.length < min || parsed.positionals.length > max) {
        if (subcommand === "unassign" && parsed.positionals.length === 1) {
          const { connect } = await import("./service.ts");
          const credentials = await (
            await connect(true)
          ).get<{
            ref: string;
            assigned: { provider: string }[];
          }>(`/credentials/${encodeURIComponent(parsed.positionals[0]!)}`);
          if (credentials.assigned.length === 1)
            usageNext = `atrium unassign ${commandAgent(parsed.positionals[0]!, credentials.ref)} ${credentials.assigned[0]!.provider}`;
        }
        throw new Problem(
          400,
          `用法：atrium ${subcommand} ${command.args}${usageNext ? "" : `\n示例：${example(subcommand, command)}`}`,
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
  if (
    [
      "stop",
      "delete",
      "disband",
      "account remove",
      "unassign",
      "kick",
    ].includes(name)
  )
    return null;
  if (name === "update") return "生效：atrium restart";
  if (name === "restart") return "查看状态：atrium status";
  if (name === "assign") return "看分配：atrium accounts";
  if (name === "status") return "查看身份：atrium list";
  if (name === "list") return "查看会话：atrium chats";
  if (name === "chats") return "查看身份：atrium list";
  return null;
}
