import {
  checkCommon,
  invalid,
  type Adapter,
  type LaunchInput,
} from "./types.ts";

/**
 * cursor-agent（Cursor CLI，`cursor-agent --help` 核对，2026.09.26 实测）：-p/--print 非交互，
 * 不给 prompt 参数时读 stdin；--output-format stream-json 逐条输出事件（system init、user、
 * tool_call started/completed、assistant、收尾 result），作为看门狗的进展信号；--force 放行命令，
 * --trust 免工作区信任询问，--workspace 工作目录。--sandbox disabled 显式关沙箱：worktree 的 .git
 * 在主仓库目录（工作区外），沙箱开着提交会被拦，与其他执行者的全放行一致。
 * 缺省模型 auto（Cursor 自己挑）。强度走模型名后缀（gpt-5.3-codex-high、claude-opus-5-5-low-fast）：
 * 帮助里的方括号覆盖 `模型[effort=high]` 本机账号不认（「Cannot use this model」），不用；auto 没有强度。
 * 捎话：没有输入流参数；本轮结束后用 `--resume <会话>` 带着补充续上（实测记得上一轮内容）。
 * 凭据用本机登录（~/.cursor），不传 --api-key / CURSOR_API_KEY。
 */

/** Cursor 模型名里的强度后缀；-fast 是另一维（快速档），排在强度后面。 */
const EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const SESSION_RE =
  /"type":"system","subtype":"init"[^\n]*?"session_id":"([0-9a-f-]{36})"/;

/**
 * 模型 + 强度 → 交给 --model 的名字（纯函数）：强度插在 -fast 之前，
 * 如 gpt-5.3-codex + high → gpt-5.3-codex-high，claude-opus-5-5-fast + low → claude-opus-5-5-low-fast。
 * auto 或模型名已带强度时再指定强度报错，不静默丢弃。
 */
export function cursorModel(model: string, effort?: string): string {
  if (effort === undefined) return model;
  if (model === "auto")
    throw invalid(
      "cursor 的 auto 由 Cursor 自己挑模型，不能指定思考强度；要指定强度请写具体模型，如 cursor+gpt-5.3-codex:high",
    );
  const fast = model.endsWith("-fast");
  const base = fast ? model.slice(0, -"-fast".length) : model;
  const has = EFFORTS.find((e) => base.endsWith(`-${e}`));
  if (has)
    throw invalid(
      `cursor 的模型名 ${model} 已带强度 ${has}，不要再写 :${effort}`,
    );
  return `${base}-${effort}${fast ? "-fast" : ""}`;
}

function args(input: LaunchInput) {
  const list = [
    "-p",
    "--output-format",
    "stream-json",
    "--force",
    "--trust",
    "--sandbox",
    "disabled",
    "--workspace",
    input.cwd,
  ];
  const model = input.model ?? cursor.defaultModel!;
  list.push("--model", cursorModel(model, input.effort));
  return list;
}

export const cursor: Adapter = {
  tool: "cursor",
  executable: "cursor-agent",
  promptVia: "stdin",
  defaultModel: "auto",
  exclusive: false,
  efforts: EFFORTS,
  quotaProvider: "cursor",
  resumeArgs: ["-p", "--continue"],
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "强度写进模型名后缀（gpt-5.3-codex:high → gpt-5.3-codex-high），auto 不能指定强度",
    "捎话没有输入流，本轮结束后按会话续上",
  ],
  tell: "resume",
  defaultRules: { trust: "unknown", max_risk: "low" },
  checkModel(model, effort) {
    cursorModel(model ?? cursor.defaultModel!, effort);
  },
  build(input) {
    checkCommon(cursor, input);
    return {
      command: cursor.executable,
      args: args(input),
      cwd: input.cwd,
      stdin: input.promptFile,
    };
  },
  resume(input) {
    checkCommon(cursor, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`会话 id 不合法：${input.session}`);
    const list = args(input);
    list.splice(1, 0, "--resume", input.session);
    return {
      command: cursor.executable,
      args: list,
      cwd: input.cwd,
      stdin: input.promptFile,
    };
  },
  sessionOf: (log) => SESSION_RE.exec(log)?.[1],
};
