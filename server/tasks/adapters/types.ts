import { isAbsolute } from "node:path";
import { Problem } from "../../problem.ts";
import type { Risk, Trust } from "../profiles.ts";

/**
 * 执行者适配器（#262 B 部分）：每个工具一份数据 + 一个把「提示词、工作目录、模型、思考强度」
 * 变成进程调用的纯函数。这里不拉起进程；拉起、日志、看门狗在「派活与等待」部分实现。
 */

/** 内置工具（手写适配器）；档案登记的通用执行者（harness/<名字> 写 protocol）另见 index.ts 的登记表。 */
export const TOOLS = [
  "codex",
  "opencode",
  "claude",
  "grok",
  "kimi",
  "agy",
  "cursor",
] as const;
export type BuiltinTool = (typeof TOOLS)[number];
export const isBuiltinTool = (value: unknown): value is BuiltinTool =>
  typeof value === "string" && (TOOLS as readonly string[]).includes(value);
/** 执行者工具名：内置工具，或档案登记的通用执行者名（t271）。 */
export type Tool = string;

export type LaunchInput = {
  /** 提示词文件的绝对路径；走 stdin 的工具由拉起方把它接到标准输入。 */
  promptFile: string;
  /** 提示词正文；走参数的工具直接放进 argv，须与 promptFile 内容一致。 */
  prompt: string;
  /** 执行者的工作目录（通常是任务 worktree）。 */
  cwd: string;
  /** 交给工具的模型 id（档案里的 model 优先于执行者标识里的模型名）。 */
  model?: string;
  /** 思考强度；工具不支持时报错，不静默丢弃。 */
  effort?: string;
  /** 执行者最后一条消息写到哪里（只有 codex 支持 -o）；缺省放在提示词文件旁。 */
  resultFile?: string;
  /** 运行中能即时送入捎话（tell: "stdin"）时，标准输入改成保持打开的消息流。 */
  live?: boolean;
  /** 档案写了自定义模型端点（t271）：按工具各自的方式交给它；工具不支持时报错。 */
  endpoint?: LaunchEndpoint;
};

/**
 * 自定义模型端点的接口种类（t271）：openai 为 OpenAI 兼容的 Chat Completions（/chat/completions），
 * responses 为 OpenAI Responses（/responses），anthropic 为 Anthropic Messages 兼容网关。
 */
export const ENDPOINT_APIS = ["openai", "responses", "anthropic"] as const;
export type EndpointApi = (typeof ENDPOINT_APIS)[number];

/** 交给适配器的端点：地址、接口种类、密钥在哪个环境变量（值由运行时按凭据名注入，不经参数与日志）。 */
export type LaunchEndpoint = {
  base_url: string;
  api: EndpointApi;
  /** 密钥所在的环境变量名；端点不要密钥时为 undefined。 */
  keyEnv?: string;
};

/** 工具怎么接自定义端点：支持哪些接口种类，密钥要放进哪个环境变量（不写就用凭据名本身）。 */
export type EndpointSupport = {
  apis: readonly EndpointApi[];
  keyEnv?: string;
};

/** 通用命令行执行者按档案判结局的规则（t271）：输出格式、结束标记、出错标记（逐行匹配的正则原文）。 */
export type OutputRules = {
  output: "text" | "jsonl";
  done?: string;
  error?: string;
};

/** 按会话续上：提示词文件与正文是这次要补充的话。 */
export type ResumeInput = LaunchInput & { session: string };

export type Launch = {
  command: string;
  args: string[];
  cwd: string;
  /** 要接到标准输入的文件路径；为空表示标准输入关闭。 */
  stdin?: string;
  /**
   * stream-json：标准输入改成管道，拉起方先把 stdin 文件的内容作为第一条用户消息写入并保持打开，
   * 运行中的捎话作为新的用户消息写入（live-input.ts）。
   */
  input?: "stream-json";
  /** 消息流的格式：claude 为 `{type:"user",…}`（缺省），agy 为 `{event:"user",…}`（live-input.ts）。 */
  inputDialect?: InputDialect;
  /** 工具会把最后一条消息写进这个文件（codex -o）。 */
  resultFile?: string;
  /** 在白名单环境之上额外设置的变量（挂载技能用的 CODEX_HOME 等）。 */
  env?: Record<string, string>;
};

export type InputDialect = "claude" | "agy";

/**
 * 运行中捎话（atrium task tell）怎么送到（#307）：
 * stdin：即时写入标准输入，在工具调用边界读入；resume：本轮结束后按会话续上；restart：停掉带着补充重派。
 */
export const TELL_MODES = ["stdin", "resume", "restart"] as const;
export type TellMode = (typeof TELL_MODES)[number];

/** 进展信号来源：看门狗据此判断执行者是否卡死（#262「执行者卡死检测」，下一部分实现）。 */
/** json_events：工具在标准输出里逐步打出结构化事件（如 opencode --format json）。 */
export type ProgressSignal =
  "log_growth" | "worktree_change" | "steps" | "json_events";

export type Adapter = {
  tool: Tool;
  /** PATH 上的可执行文件名。 */
  executable: string;
  /** 提示词怎么交给工具。 */
  promptVia: "arg" | "stdin";
  /** 提示词走参数时的字节上限（留足环境变量与其余参数的余量）；走 stdin 时为 undefined。 */
  maxPromptBytes?: number;
  /** 执行者标识和档案都没写模型时用的模型；undefined 表示交给工具自己的配置。 */
  defaultModel?: string;
  /** 同一时刻只跑一个（派活时排队）。 */
  exclusive: boolean;
  /** 支持的思考强度；undefined 表示工具不接受思考强度参数。 */
  efforts?: readonly string[];
  /** openquota pace 里对应的账号 provider id；同一账号下的模型共享额度。 */
  quotaProvider: string;
  /** 支持继续上次会话的参数（打回重做时用）；undefined 表示不支持。 */
  resumeArgs?: readonly string[];
  /** 预留给看门狗：启动后多久无进展判卡死、运行中多久无进展判受阻（分钟）。 */
  watchdog: { startupMinutes: number; idleMinutes: number };
  progressSignals: readonly ProgressSignal[];
  /** 派活时怎么把组织技能交给它（server/skills/mount.ts）；undefined 表示只在提示词里给路径。 */
  skillMount?: "claude-plugin" | "codex-home" | "opencode-config";
  /** 已知的坑，给人看，也会进 PR/档案对照。 */
  notes: readonly string[];
  /** 捎话的缺省送达方式；档案 `tell` 可改成本工具支持的其他方式。 */
  tell: TellMode;
  /** 能接的自定义模型端点；undefined 表示不支持（档案写了端点时报错说明）。 */
  endpoints?: EndpointSupport;
  /** 通用命令行执行者的结局规则；手写适配器按各自日志结构判（adopted-exit.ts、json-log.ts）。 */
  outputRules?: OutputRules;
  /** 模型与思考强度搭不搭（派活前、排队前先查，免得排到时才报错）；不合法抛 400。 */
  checkModel?(model: string | undefined, effort: string | undefined): void;
  /** 档案（三层叠加后）没写时的规则缺省：新接入、还没有交付记录的工具先压低，按交付记录再在档案里升。 */
  defaultRules?: Readonly<{ trust?: Trust; max_risk?: Risk }>;
  build(input: LaunchInput): Launch;
  /** 带着补充续上原会话；undefined 表示不支持按会话续上。 */
  resume?(input: ResumeInput): Launch;
  /** 从日志开头取会话 id（续上时用）；取不到返回 undefined。 */
  sessionOf?(log: string): string | undefined;
};

/** macOS ARG_MAX 为 1 MiB（getconf ARG_MAX），argv 与环境共用；单个参数保守取 256 KiB。 */
export const ARG_PROMPT_MAX_BYTES = 256 * 1024;

export const DEFAULT_WATCHDOG = { startupMinutes: 3, idleMinutes: 20 };

/** 输入不合法：接口层转成 400。 */
export const invalid = (message: string) => new Problem(400, message);

export function checkArgPrompt(adapter: Adapter, prompt: string) {
  if (!prompt.trim()) throw invalid("提示词为空");
  const limit = adapter.maxPromptBytes ?? ARG_PROMPT_MAX_BYTES;
  const size = Buffer.byteLength(prompt, "utf8");
  if (size > limit)
    throw invalid(
      `${adapter.tool} 的提示词走命令行参数，${size} 字节超过上限 ${limit}`,
    );
}

export function checkEffort(adapter: Adapter, effort: string | undefined) {
  if (effort === undefined) return;
  if (!adapter.efforts) throw invalid(`${adapter.tool} 不支持指定思考强度`);
  if (!adapter.efforts.includes(effort))
    throw invalid(
      `${adapter.tool} 的思考强度只能是 ${adapter.efforts.join("、")}`,
    );
}

/** 各工具共用的输入检查：工作目录与提示词文件须为绝对路径，模型 id 不含空白。 */
export function checkCommon(adapter: Adapter, input: LaunchInput) {
  if (!isAbsolute(input.cwd)) throw invalid("工作目录须为绝对路径");
  if (!isAbsolute(input.promptFile)) throw invalid("提示词文件须为绝对路径");
  if (input.model !== undefined && !/^[\w.:/@+-]+$/.test(input.model))
    throw invalid(`模型 id 不合法：${input.model}`);
  checkEffort(adapter, input.effort);
  if (adapter.promptVia === "arg") checkArgPrompt(adapter, input.prompt);
  if (input.endpoint) checkEndpoint(adapter, input.endpoint.api);
}

/** 工具能不能接这种端点；不能就说清楚能接的有哪些（纯函数，档案校验与拉起共用）。 */
export function endpointProblem(
  adapter: Adapter,
  api: EndpointApi,
): string | null {
  const apis = adapter.endpoints?.apis ?? [];
  if (apis.includes(api)) return null;
  if (!apis.length)
    return `${adapter.tool} 不支持自定义模型端点；能接的内置工具：opencode（openai、anthropic）、codex（responses）、claude（anthropic），其他工具用通用命令行执行者（protocol: cli）接`;
  return `${adapter.tool} 只能接 ${apis.join("、")} 接口的端点，这个端点是 ${api}${adapter.tool === "codex" && api === "openai" ? "（codex 已不支持 Chat Completions，OpenAI 兼容端点请用 opencode 或通用命令行执行者）" : ""}`;
}

export function checkEndpoint(adapter: Adapter, api: EndpointApi) {
  const problem = endpointProblem(adapter, api);
  if (problem) throw invalid(problem);
}
