import type { FrontValue } from "../frontmatter.ts";
import { isBuiltinTool } from "./types.ts";

/**
 * 只靠档案接入的 ACP 工具（#418 第 1 项）：工具层档案 `harness/<名字>` 写 `protocol: acp` 与启动命令，
 * 运行时经 ACP 桥（server/acp/bridge.ts）驱动它。这里只把档案字段解析、校验成配置，并把配置展开成
 * 工具的命令行；纯函数，不碰进程与数据库。
 *
 * 档案字段（frontmatter，行内写法）：
 * - protocol: acp（必填）
 * - command: 可执行文件名（PATH 上找）或绝对路径（必填）
 * - args: [acp]（可选）启动参数，可含 {cwd}
 * - model_args: [--model, "{model}"]（可选）有模型时追加；没写就经 ACP 的会话配置选模型，工具不支持时派活报错
 * - efforts: [low, high]（可选）支持的思考强度；没写表示不接受思考强度
 * - effort_args: [--effort, "{effort}"]（可选）有思考强度时追加；没写就经 ACP 的会话配置（thought_level）传
 * - permissions: allow | reject（可选，缺省 allow）权限请求自动批准或拒绝
 * - exclusive: true（可选）同一时刻只跑一个
 * - quota: 额度账号 id（可选，缺省是工具名；没有读数的账号不影响派活）
 */

export const PROTOCOLS = ["acp"] as const;
export const PERMISSION_POLICIES = ["allow", "reject"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

export type AcpToolSpec = {
  name: string;
  command: string;
  args: string[];
  modelArgs?: string[];
  efforts?: string[];
  effortArgs?: string[];
  permissions: PermissionPolicy;
  exclusive: boolean;
  quota: string;
};

/** 新工具名：小写字母开头，字母、数字与 -；不能含执行者标识里的 + 与 :。 */
export const CUSTOM_TOOL_RE = /^[a-z][a-z0-9-]{0,39}$/;
const EFFORT_RE = /^[a-z]+$/;
const QUOTA_RE = /^[\w.-]{1,60}$/;
const ARG_MAX = 1000;
/** 绝对路径（Unix 或 Windows 盘符）；只有它允许含空格（如 C:\Program Files\…）。 */
const ABSOLUTE_RE = /^(\/|[A-Za-z]:[\\/])/;

/** 工具层档案里只有接入新工具时才用的键；内置工具的档案写了这些键要报出来。 */
export const SPEC_KEYS = [
  "protocol",
  "command",
  "args",
  "model_args",
  "efforts",
  "effort_args",
  "permissions",
  "exclusive",
  "quota",
] as const;

function stringList(
  value: FrontValue | undefined,
  key: string,
  problems: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (
    !list.every(
      (item): item is string | number =>
        (typeof item === "string" && item.length <= ARG_MAX) ||
        typeof item === "number",
    )
  ) {
    problems.push(`${key} 须是一行文字的列表，如 [acp]`);
    return undefined;
  }
  return list.map(String);
}

/**
 * 工具层档案（harness/<名字>）的接入字段有什么问题（纯函数）。
 * 内置工具不许改协议；新工具必须写 protocol 与 command。返回配置与问题，问题为空才可用配置。
 */
export function parseToolSpec(
  name: string,
  rules: Record<string, FrontValue | undefined>,
): { spec?: AcpToolSpec; problems: string[] } {
  const problems: string[] = [];
  if (isBuiltinTool(name)) {
    const written = SPEC_KEYS.filter((key) => rules[key] !== undefined);
    if (written.length)
      problems.push(
        `${name} 是内置工具，不能写 ${written.join("、")}；要经 ACP 接入同一个工具，另起名字，如 harness/${name}-acp`,
      );
    return { problems };
  }
  if (!CUSTOM_TOOL_RE.test(name))
    problems.push(
      "新工具名须是小写字母开头，只含小写字母、数字与 -，最长 40 个字",
    );
  if (rules.protocol === undefined) {
    problems.push(
      `工具层档案 ${name} 不是内置工具：接入新工具须写 protocol: acp 与 command（可执行文件名）`,
    );
    return { problems };
  }
  if (!(PROTOCOLS as readonly FrontValue[]).includes(rules.protocol))
    problems.push(`protocol 只能是 ${PROTOCOLS.join("、")}`);
  const command = rules.command;
  if (
    typeof command !== "string" ||
    !command.trim() ||
    /[\0\r\n]/.test(command) ||
    (/\s/.test(command) && !ABSOLUTE_RE.test(command))
  )
    problems.push(
      "command 须是可执行文件名或绝对路径（文件名不含空格，参数写进 args）",
    );
  const args = stringList(rules.args, "args", problems) ?? [];
  const modelArgs = stringList(rules.model_args, "model_args", problems);
  if (modelArgs && !modelArgs.some((arg) => arg.includes("{model}")))
    problems.push('model_args 里须有 {model} 占位，如 [--model, "{model}"]');
  const efforts = stringList(rules.efforts, "efforts", problems);
  if (efforts && (!efforts.length || !efforts.every((e) => EFFORT_RE.test(e))))
    problems.push("efforts 须是小写字母的思考强度列表，如 [low, high]");
  const effortArgs = stringList(rules.effort_args, "effort_args", problems);
  if (effortArgs && !effortArgs.some((arg) => arg.includes("{effort}")))
    problems.push(
      'effort_args 里须有 {effort} 占位，如 [--effort, "{effort}"]',
    );
  if (effortArgs && !efforts)
    problems.push("写了 effort_args 就要用 efforts 列出支持的思考强度");
  const permissions = rules.permissions ?? "allow";
  if (!(PERMISSION_POLICIES as readonly FrontValue[]).includes(permissions))
    problems.push(`permissions 只能是 ${PERMISSION_POLICIES.join("、")}`);
  const exclusive = rules.exclusive ?? false;
  if (typeof exclusive !== "boolean")
    problems.push("exclusive 只能是 true 或 false");
  const quota = rules.quota ?? name;
  if (typeof quota !== "string" || !QUOTA_RE.test(quota))
    problems.push("quota 须是额度账号 id（字母、数字、. _ -）");
  for (const [key, list] of [
    ["args", args],
    ["model_args", modelArgs],
    ["effort_args", effortArgs],
  ] as const)
    if (list?.some((arg) => /[\0\r\n]/.test(arg)))
      problems.push(`${key} 的每一项须是一行文字`);
  if (problems.length) return { problems };
  return {
    spec: {
      name,
      command: command as string,
      args,
      ...(modelArgs ? { modelArgs } : {}),
      ...(efforts ? { efforts } : {}),
      ...(effortArgs ? { effortArgs } : {}),
      permissions: permissions as PermissionPolicy,
      exclusive: exclusive as boolean,
      quota: quota as string,
    },
    problems,
  };
}

const fill = (args: readonly string[], slots: Record<string, string>) =>
  args.map((arg) =>
    arg.replace(/\{(cwd|model|effort)\}/g, (all, key: string) =>
      key in slots ? slots[key]! : all,
    ),
  );

/**
 * 工具本身的命令行（纯函数）：args 展开 {cwd}；有模型且写了 model_args 时追加，思考强度同理。
 * 返回哪些要交给桥经 ACP 会话配置去设（没写对应 *_args 的）。
 */
export function agentCommand(
  spec: AcpToolSpec,
  input: { cwd: string; model?: string; effort?: string },
) {
  const slots: Record<string, string> = { cwd: input.cwd };
  if (input.model !== undefined) slots.model = input.model;
  if (input.effort !== undefined) slots.effort = input.effort;
  const args = fill(spec.args, slots);
  if (input.model !== undefined && spec.modelArgs)
    args.push(...fill(spec.modelArgs, slots));
  if (input.effort !== undefined && spec.effortArgs)
    args.push(...fill(spec.effortArgs, slots));
  return {
    command: spec.command,
    args,
    viaSession: {
      ...(input.model !== undefined && !spec.modelArgs
        ? { model: input.model }
        : {}),
      ...(input.effort !== undefined && !spec.effortArgs
        ? { effort: input.effort }
        : {}),
    },
  };
}
