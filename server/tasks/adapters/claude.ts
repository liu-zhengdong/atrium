import { DEFAULT_WATCHDOG, checkCommon, type Adapter } from "./types.ts";

/**
 * claude -p（`claude --help` 核对）：-p/--print 非交互、--permission-mode bypassPermissions
 * 跳过权限确认、--model、--effort（low/medium/high/xhigh/max）；不给 prompt 参数时读 stdin。
 * 纯文本输出要到最后才打印，看门狗会把长时间读代码误判成卡死；所以用
 * --output-format stream-json（-p 下须配 --verbose）逐轮输出事件，作为进展信号。
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
  progressSignals: ["json_events", "worktree_change"],
  notes: ["工作目录由进程 cwd 决定，没有 --cwd 参数"],
  build(input) {
    checkCommon(claude, input);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ];
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
