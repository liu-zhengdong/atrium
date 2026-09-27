import { isAbsolute } from "node:path";
import { Problem } from "../../problem.ts";

/**
 * 执行者适配器（#262 B 部分）：每个工具一份数据 + 一个把「提示词、工作目录、模型、思考强度」
 * 变成进程调用的纯函数。这里不拉起进程；拉起、日志、看门狗在「派活与等待」部分实现。
 */

export const TOOLS = ["codex", "opencode", "claude", "grok", "kimi"] as const;
export type Tool = (typeof TOOLS)[number];
export const isTool = (value: unknown): value is Tool =>
  typeof value === "string" && (TOOLS as readonly string[]).includes(value);

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
};

export type Launch = {
  command: string;
  args: string[];
  cwd: string;
  /** 要接到标准输入的文件路径；为空表示标准输入关闭。 */
  stdin?: string;
  /** 工具会把最后一条消息写进这个文件（codex -o）。 */
  resultFile?: string;
  /** 在白名单环境之上额外设置的变量（挂载技能用的 CODEX_HOME 等）。 */
  env?: Record<string, string>;
};

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
  build(input: LaunchInput): Launch;
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
}
