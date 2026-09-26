import { dirname, join } from "node:path";
import { DEFAULT_WATCHDOG, checkCommon, type Adapter } from "./types.ts";

/**
 * codex exec（`codex exec --help` 核对）：-C 工作根目录、-s 沙箱、-m 模型、
 * -o/--output-last-message 最后一条消息文件；PROMPT 为 `-` 时从 stdin 读提示词。
 * 思考强度走配置覆盖 `-c model_reasoning_effort="<强度>"`。
 */
export const codex: Adapter = {
  tool: "codex",
  executable: "codex",
  promptVia: "stdin",
  defaultModel: "gpt-6-sol",
  exclusive: false,
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  quotaProvider: "codex",
  resumeArgs: ["exec", "resume", "--last"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["提示词走 stdin（PROMPT 写 -），避免参数长度上限"],
  build(input) {
    checkCommon(codex, input);
    const resultFile =
      input.resultFile ?? join(dirname(input.promptFile), "last-message.md");
    const args = ["exec", "-C", input.cwd, "-s", "danger-full-access"];
    if (input.model) args.push("-m", input.model);
    if (input.effort)
      args.push("-c", `model_reasoning_effort="${input.effort}"`);
    args.push("-o", resultFile, "-");
    return {
      command: codex.executable,
      args,
      cwd: input.cwd,
      stdin: input.promptFile,
      resultFile,
    };
  },
};
