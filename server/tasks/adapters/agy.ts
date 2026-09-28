import {
  checkCommon,
  invalid,
  type Adapter,
  type LaunchInput,
} from "./types.ts";

/**
 * Antigravity CLI（agy 1.2.12，`agy --help` 与实跑核对）：-p/--print 非交互单次运行、--model、
 * --effort（low/medium/high/max）、--dangerously-skip-permissions 全放行、--disable-slash-commands
 * 不把以 / 开头的提示词当斜杠命令；工作目录由进程 cwd 决定。
 * --output-format stream-json 每步打一行 `{"event":"step_update",…}`（工具调用、助手文本片段），
 * 收尾一行 `{"event":"result","result":{status:"SUCCESS"|"ERROR",response,error,usage}}`，出错退出码 1。
 * 提示词：-p 要带值，读不了提示词文件；非捎话时走 `--print=<提示词>`（等号形式，以 - 开头的提示词也不会被当成参数）。
 * 捎话：--input-format stream-json 让标准输入成为消息流，每行 `{"event":"user","message":{"role":"user","content":…}}`
 * 是一轮；运行中写入的消息排在本轮之后另起一轮（09-28 实测：两个 result，读到 EOF 才退出）。
 * 续上：--conversation <会话 id>，会话 id 取 init 事件的 conversation_id。
 */

const SESSION_RE = /"event":"init","conversation_id":"([0-9a-f-]{36})"/;

/** 模型名自带强度的后缀（gemini-3.8-flash-high、gpt-oss-120b-medium）。 */
const BUILT_IN_EFFORT = /-(low|medium|high)$/;
/** 不接受 --effort 的模型族：思考强度含在模型里（agy 报 `--effort is not supported for model`）。 */
const NO_EFFORT = /^(?:claude-|gpt-oss-)/;

/**
 * 模型与思考强度 → agy 参数（纯函数）。
 * - 模型名带强度（gemini-3.8-flash-high）：不写强度或写同一档都只传 --model；写别的档报错（agy 报 conflicts）。
 * - claude-*、gpt-oss-*：不接受 --effort，写了强度报错，不静默丢弃。
 * - 其余（gemini-3.8-flash 这样的基名）：强度照传 --effort；基名不写强度时 agy 自己报 requires --effort。
 */
export function agyModelArgs(model?: string, effort?: string): string[] {
  if (!model) {
    if (effort)
      throw invalid(
        "agy 写思考强度时须同时写模型，如 agy+gemini-3.8-flash:high",
      );
    return [];
  }
  if (!effort) return ["--model", model];
  const built = BUILT_IN_EFFORT.exec(model)?.[1];
  if (built) {
    if (built === effort) return ["--model", model];
    throw invalid(
      `agy 的模型 ${model} 已带强度 ${built}，与 :${effort} 冲突；换强度请改模型名（如 ${model.replace(BUILT_IN_EFFORT, `-${effort}`)}）或写基名加强度`,
    );
  }
  if (NO_EFFORT.test(model))
    throw invalid(
      `agy 的 ${model} 不接受思考强度（强度含在模型里），去掉 :${effort}`,
    );
  return ["--model", model, "--effort", effort];
}

function args(input: LaunchInput, session?: string) {
  const list = input.live
    ? ["-p", "", "--input-format", "stream-json"]
    : [`--print=${input.prompt}`];
  list.push(
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
  );
  if (session) list.push("--conversation", session);
  list.push(...agyModelArgs(input.model, input.effort));
  return list;
}

export const agy: Adapter = {
  tool: "agy",
  executable: "agy",
  promptVia: "arg",
  defaultModel: "claude-opus-4-6-thinking",
  exclusive: false,
  efforts: ["low", "medium", "high", "max"],
  quotaProvider: "antigravity",
  resumeArgs: ["--continue"],
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "claude-* 与 gpt-oss-* 模型不接受思考强度；gemini 用带强度的模型名或基名加 :强度",
    "额度按模型分桶（Gemini、Claude 各一份），用尽标记按整个 antigravity 账号记",
  ],
  tell: "stdin",
  checkModel(model, effort) {
    agyModelArgs(model, effort);
  },
  build(input) {
    checkCommon(agy, input);
    return launch(input);
  },
  resume(input) {
    checkCommon(agy, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`会话 id 不合法：${input.session}`);
    return launch(input, input.session);
  },
  sessionOf: (log) => SESSION_RE.exec(log)?.[1],
};

function launch(input: LaunchInput, session?: string) {
  return {
    command: agy.executable,
    args: args(input, session),
    cwd: input.cwd,
    ...(input.live
      ? {
          stdin: input.promptFile,
          input: "stream-json" as const,
          inputDialect: "agy" as const,
        }
      : {}),
  };
}
