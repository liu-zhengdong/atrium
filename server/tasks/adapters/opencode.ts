import { DEFAULT_WATCHDOG, checkCommon, type Adapter } from "./types.ts";

/**
 * opencode run（`opencode run --help` 核对）：message 为位置参数、-m provider/model、
 * --variant 为模型变体（厂商自定的思考强度）。不加 --auto：权限按用户的 opencode 配置放行。
 * 非交互时访问工作目录外会被拒，所以进程 cwd 就是工作目录。
 */
export const opencode: Adapter = {
  tool: "opencode",
  executable: "opencode",
  promptVia: "arg",
  defaultModel: "opencode/space-bunny-free",
  // 09-26 一次卡在初始化一小时，疑似与另一个 opencode 争用 ~/.local/share/opencode/opencode.db。
  exclusive: true,
  efforts: ["minimal", "low", "medium", "high", "max"],
  quotaProvider: "opencode",
  resumeArgs: ["run", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change", "steps"],
  notes: [
    "cwd 必须是工作目录，目录外访问会被拒",
    "同一时刻只跑一个",
    "常停在提交前，验收查 finished",
  ],
  build(input) {
    checkCommon(opencode, input);
    const args = ["run"];
    if (input.model) args.push("-m", input.model);
    if (input.effort) args.push("--variant", input.effort);
    // 以 -- 结束选项，防止以 - 开头的提示词被当成参数。
    args.push("--", input.prompt);
    return { command: opencode.executable, args, cwd: input.cwd };
  },
};
