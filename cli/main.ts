import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { dataDirectory, serviceUrl } from "../server/service-state.ts";
import { pad, width } from "./format.ts";
import { agentCommands } from "./agents.ts";
import { chatCommands } from "./chats.ts";
import { accountCommands } from "./accounts.ts";
import { connectCommand } from "./connect.ts";
import { pluginCommands } from "./plugins.ts";
import { resourceCommands } from "./resources.ts";

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

const commands: Record<string, Command> = {
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
  const lines = [
    ...service,
    ...Object.entries(commands).map(([name, command]): [string, string] => [
      `atrium ${name} ${command.args}`.trimEnd(),
      command.about,
    ]),
  ];
  const widest = Math.max(...lines.map(([line]) => width(line)));
  return [
    ...lines.map(([line, about]) => `${pad(line, widest)}  ${about}`),
    "",
    "名称处也可以用短号（a1、c1）或 ID；读命令加 --json 原样输出接口结果。",
    "除 run 外的命令都经中庭服务完成，服务没在跑会自动在后台拉起。",
    "关闭浏览器或终端不停止后台服务；stop 不终止外部 Pi TUI。ATRIUM_DATA / PI_ACP_DIR 须与服务一致。",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  try {
    if (name === undefined || name === "--no-open") {
      if (rest.length) throw new Error(usage);
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
    if ((name === "status" || name === "stop") && !rest.length) {
      const { serviceStatus, stopService } =
        await import("../server/service.ts");
      await (name === "status" ? serviceStatus : stopService)(dataDirectory());
      return 0;
    }
    const subcommand =
      name === "account" || name === "plugin" || name === "skill"
        ? `${name} ${rest.shift() ?? ""}`.trim()
        : name;
    const command = commands[subcommand];
    if (subcommand === "account login")
      throw new Error("已由 atrium connect 代替");
    if (!command) throw new Error(`不认识的命令：${subcommand}\n${usage}`);
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
      throw new Error(
        `用法：atrium ${subcommand} ${command.args}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const [min, max] = command.positionals;
    if (parsed.positionals.length < min || parsed.positionals.length > max)
      throw new Error(`用法：atrium ${subcommand} ${command.args}`.trimEnd());
    const code = await command.run({
      positionals: parsed.positionals,
      values: parsed.values as Values,
      json: parsed.values.json === true,
    });
    return code ?? 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
