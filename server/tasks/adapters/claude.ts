import { DEFAULT_WATCHDOG, checkCommon, type Adapter } from "./types.ts";

/**
 * claude -p（`claude --help` 核对）：-p/--print 非交互、--permission-mode bypassPermissions
 * 跳过权限确认、--model、--effort（low/medium/high/xhigh/max）；不给 prompt 参数时读 stdin。
 */
export const claude: Adapter = {
  tool: "claude",
  executable: "claude",
  promptVia: "stdin",
  defaultModel: "opus",
  exclusive: false,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  quotaProvider: "claude",
  resumeArgs: ["-p", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["工作目录由进程 cwd 决定，没有 --cwd 参数"],
  build(input) {
    checkCommon(claude, input);
    const args = ["-p", "--permission-mode", "bypassPermissions"];
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);
    return {
      command: claude.executable,
      args,
      cwd: input.cwd,
      stdin: input.promptFile,
    };
  },
};
