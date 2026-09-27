import { dirname, join } from "node:path";
import {
  DEFAULT_WATCHDOG,
  checkCommon,
  invalid,
  type Adapter,
} from "./types.ts";

/**
 * codex exec（`codex exec --help` 核对）：-C 工作根目录、-s 沙箱、-m 模型、
 * -o/--output-last-message 最后一条消息文件；PROMPT 为 `-` 时从 stdin 读提示词。
 * 思考强度走配置覆盖 `-c model_reasoning_effort="<强度>"`。
 * 捎话（#307）：exec 运行中不能追加消息；本轮结束后用 `codex exec resume <会话> -` 带着补充续上原会话。
 * resume 没有 -C、-s：工作目录取进程 cwd，沙箱走配置覆盖 `-c sandbox_mode=...`。会话 id 取日志抬头的
 * `session id: <uuid>`；不用 --last，免得续上同一 CODEX_HOME 下别的任务的会话。
 */
export const codex: Adapter = {
  tool: "codex",
  executable: "codex",
  promptVia: "stdin",
  defaultModel: "gpt-6-sol",
  exclusive: false,
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  quotaProvider: "codex",
  skillMount: "codex-home",
  resumeArgs: ["exec", "resume", "--last"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["提示词走 stdin（PROMPT 写 -），避免参数长度上限"],
  tell: "resume",
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
  resume(input) {
    checkCommon(codex, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`会话 id 不合法：${input.session}`);
    const resultFile =
      input.resultFile ?? join(dirname(input.promptFile), "last-message.md");
    const args = ["exec", "resume", "-c", 'sandbox_mode="danger-full-access"'];
    if (input.model) args.push("-m", input.model);
    if (input.effort)
      args.push("-c", `model_reasoning_effort="${input.effort}"`);
    args.push("-o", resultFile, input.session, "-");
    return {
      command: codex.executable,
      args,
      cwd: input.cwd,
      stdin: input.promptFile,
      resultFile,
    };
  },
  sessionOf: (log) => /^session id: ([0-9a-f-]{36})$/m.exec(log)?.[1],
};
