import type { FrontValue } from "../workers/frontmatter.ts";
import { secretNameProblem } from "../../secrets/model.ts";
import { ENDPOINT_APIS, type EndpointApi } from "./types.ts";

/**
 * 通用命令行执行者的档案写法（t271）：`harness/<名字>` 里写 `protocol: cli` 与命令模板，不写代码就能接一个新工具。
 * 这里只把档案规则解析成 CliSpec 并列出毛病（纯函数）；按它拉起在 cli.ts，判结局在 cli-outcome.ts。
 *
 * 档案键：
 * - command：PATH 上的命令名（不带路径）。
 * - args：参数模板，元素里可用占位 {prompt}、{prompt_file}、{cwd}、{model}、{effort}、{base_url}；
 *   整个元素写 {model_args}、{effort_args}、{endpoint_args} 时换成对应的参数组，这次没给模型、强度、端点就整组省掉。
 *   没有 {prompt} 也没有 {prompt_file} 时提示词从标准输入给。
 * - model_args、effort_args、endpoint_args：上面三个参数组（如 [-m, "{model}"]）。
 * - efforts：接受的思考强度；不写表示不接受。
 * - output：text（缺省）或 jsonl；done_match、error_match：逐行匹配的正则，命中 error_match 算出错，
 *   写了 done_match 却没命中算没做完就退出。
 * - env：额外环境变量模板（值可用 {model}、{base_url}；缺值的那一项不设）；会写进日志抬头，不要放密钥。
 * - endpoint_apis：能接的端点接口种类（缺省 openai）；key_env：工具从哪个环境变量读端点密钥（缺省用凭据名）。
 * - exclusive：同一时刻只跑一个；quota_provider：额度账号名（缺省用工具名）。
 */

const CLI_PROTOCOL = "cli";

/** 工具名：小写字母开头，只含小写字母、数字、连字符；也是 harness 档案名与执行者标识的头。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

const PLACEHOLDERS = [
  "prompt",
  "prompt_file",
  "cwd",
  "model",
  "effort",
  "base_url",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export const GROUPS = ["model_args", "effort_args", "endpoint_args"] as const;
export type Group = (typeof GROUPS)[number];

/** 只在 env 模板里能用的占位：提示词、工作目录这类不进环境。 */
const ENV_PLACEHOLDERS: readonly Placeholder[] = ["model", "base_url"];

export type CliSpec = {
  command: string;
  args: string[];
  groups: Record<Group, string[]>;
  efforts?: string[];
  output: "text" | "jsonl";
  done?: string;
  error?: string;
  env: Record<string, string>;
  endpointApis: EndpointApi[];
  keyEnv?: string;
  exclusive: boolean;
  quotaProvider: string;
  /** 提示词怎么给：参数里的正文、参数里的文件路径、标准输入。 */
  promptVia: "arg" | "file" | "stdin";
};

const TOKEN_RE = /\{([a-z_]+)\}/g;

/** 模板里用到的占位名（含不认识的）。 */
export const tokensOf = (text: string) =>
  [...text.matchAll(TOKEN_RE)].map((m) => m[1]!);

const list = (value: FrontValue | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

function strings(
  key: string,
  value: FrontValue | undefined,
  problems: string[],
): string[] | undefined {
  const items = list(value);
  if (!items) return undefined;
  if (
    items.some((item) => typeof item !== "string" && typeof item !== "number")
  )
    problems.push(`${key} 须是文字数组，占位要加引号，如 [-m, "{model}"]`);
  return items
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map(String);
}

function regex(key: string, value: FrontValue | undefined, problems: string[]) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) {
    problems.push(`${key} 须是非空正则`);
    return undefined;
  }
  try {
    new RegExp(value);
  } catch (error) {
    problems.push(`${key} 不是合法正则：${(error as Error).message}`);
    return undefined;
  }
  return value;
}

/**
 * 把档案规则解析成通用命令行执行者（纯函数）。name 是工具名（harness 档案名）。
 * 有毛病时 spec 为 undefined，problems 逐条说明（用档案键名与中文）。
 */
export function parseCliSpec(
  name: string,
  rules: Record<string, FrontValue | undefined>,
): { spec?: CliSpec; problems: string[] } {
  const problems: string[] = [];
  if (!TOOL_NAME_RE.test(name))
    problems.push(
      `工具名 ${name} 不合法：小写字母开头，只含小写字母、数字、连字符，至多 40 个字符`,
    );
  if (rules.protocol !== CLI_PROTOCOL)
    problems.push(
      `protocol 只能是 ${CLI_PROTOCOL}（通用命令行执行者）${rules.protocol === "acp" ? "；ACP 执行者还没接入" : ""}`,
    );
  const command = rules.command;
  if (typeof command !== "string" || !command.trim())
    problems.push("command 须写 PATH 上的命令名，如 mytool");
  else if (/[\\/\s]/.test(command) || command.startsWith("-"))
    problems.push(
      `command 只写命令名，不带路径、空白或参数（${command}）；参数写在 args`,
    );
  const args = strings("args", rules.args, problems) ?? [];
  const groups = Object.fromEntries(
    GROUPS.map((group) => [
      group,
      strings(group, rules[group], problems) ?? [],
    ]),
  ) as Record<Group, string[]>;
  // 占位只认已知的；整组标记只能单独占一个 args 元素。
  const used = new Set<string>();
  for (const [where, items] of [
    ["args", args],
    ...GROUPS.map((group) => [group, groups[group]] as const),
  ] as const)
    for (const item of items) {
      for (const token of tokensOf(item)) {
        if ((GROUPS as readonly string[]).includes(token)) {
          if (where !== "args" || item !== `{${token}}`)
            problems.push(`{${token}} 只能在 args 里单独占一项`);
        } else if (!(PLACEHOLDERS as readonly string[]).includes(token))
          problems.push(
            `${where} 里的 {${token}} 不是占位，可用 ${[...PLACEHOLDERS, ...GROUPS].map((p) => `{${p}}`).join("、")}`,
          );
        used.add(token);
      }
    }
  for (const group of GROUPS)
    if (groups[group].length && !used.has(group))
      problems.push(`写了 ${group}，但 args 里没有 {${group}} 标出放在哪`);
  const efforts = strings("efforts", rules.efforts, problems);
  if (efforts?.some((effort) => !/^[a-z]+$/.test(effort)))
    problems.push("efforts 里的强度须是小写字母，如 [low, medium, high]");
  if (efforts?.length && !used.has("effort"))
    problems.push("写了 efforts，但 args 里没用 {effort} 或 {effort_args}");
  if (!efforts?.length && used.has("effort"))
    problems.push("用了 {effort}，但没写 efforts（接受哪些强度）");
  const output = rules.output ?? "text";
  if (output !== "text" && output !== "jsonl")
    problems.push("output 只能是 text 或 jsonl");
  const done = regex("done_match", rules.done_match, problems);
  const error = regex("error_match", rules.error_match, problems);
  const env: Record<string, string> = {};
  const envValue = rules.env;
  if (envValue !== undefined) {
    if (!envValue || typeof envValue !== "object" || Array.isArray(envValue))
      problems.push('env 须写成 {变量名: "值"}');
    else
      for (const [key, value] of Object.entries(envValue)) {
        const bad = secretNameProblem(key);
        if (bad) problems.push(`env.${key}：${bad}`);
        else if (typeof value !== "string" && typeof value !== "number")
          problems.push(`env.${key} 的值须是文字`);
        else {
          const text = String(value);
          const extra = tokensOf(text).filter(
            (token) => !ENV_PLACEHOLDERS.includes(token as Placeholder),
          );
          if (extra.length)
            problems.push(
              `env.${key} 里只能用 {model}、{base_url}，不能用 ${extra.map((t) => `{${t}}`).join("、")}`,
            );
          for (const token of tokensOf(text)) used.add(token);
          env[key] = text;
        }
      }
  }
  const apis = strings("endpoint_apis", rules.endpoint_apis, problems);
  const endpointApis = (apis ?? ["openai"]).filter(
    (api): api is EndpointApi => {
      const ok = (ENDPOINT_APIS as readonly string[]).includes(api);
      if (!ok)
        problems.push(
          `endpoint_apis 里的 ${api} 不认识，可用 ${ENDPOINT_APIS.join("、")}`,
        );
      return ok;
    },
  );
  const keyEnv = rules.key_env;
  if (keyEnv !== undefined) {
    const bad =
      typeof keyEnv === "string" ? secretNameProblem(keyEnv) : "须是变量名";
    if (bad) problems.push(`key_env：${bad}`);
  }
  if (keyEnv !== undefined && !used.has("base_url"))
    problems.push("写了 key_env，但 args、env 里都没用 {base_url}，接不了端点");
  const exclusive = rules.exclusive ?? false;
  if (typeof exclusive !== "boolean")
    problems.push("exclusive 只能是 true 或 false");
  const quota = rules.quota_provider ?? name;
  if (typeof quota !== "string" || !/^[\w.-]+$/.test(quota))
    problems.push("quota_provider 须是账号名，如 mytool");
  if (used.has("prompt") && used.has("prompt_file"))
    problems.push("{prompt} 与 {prompt_file} 只用一个");
  if (problems.length) return { problems };
  return {
    problems,
    spec: {
      command: command as string,
      args,
      groups,
      ...(efforts?.length ? { efforts } : {}),
      output: output as CliSpec["output"],
      ...(done ? { done } : {}),
      ...(error ? { error } : {}),
      env,
      endpointApis: used.has("base_url") ? endpointApis : [],
      ...(typeof keyEnv === "string" ? { keyEnv } : {}),
      exclusive: exclusive as boolean,
      quotaProvider: quota as string,
      promptVia: used.has("prompt")
        ? "arg"
        : used.has("prompt_file")
          ? "file"
          : "stdin",
    },
  };
}
