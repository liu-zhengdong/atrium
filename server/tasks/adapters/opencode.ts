import { DEFAULT_WATCHDOG, checkCommon, type Adapter } from "./types.ts";

/**
 * opencode run（`opencode run --help` 核对）：message 为位置参数、-m provider/model、
 * --variant 为模型变体（厂商自定的思考强度）。加 --auto：非交互时任何一次权限被拒 opencode 都会
 * 直接结束运行（09-27 实测：读 ~/.gitconfig 被拒后零提交退出），与其他执行者的全放行一致；
 * 敏感路径由用户 opencode 配置里的 deny 规则兜底（--auto 不覆盖明确拒绝）。
 * 非交互时访问工作目录外会被拒，所以进程 cwd 就是工作目录。
 * --format json 每步实时输出 step_start / tool_use / step_finish 事件，作为看门狗的进展信号。
 * 拉起时环境里不能带 HERDR_*：herdr 状态插件会用继承来的窗格号连 herdr，卡在 init、零步骤。
 */
export const opencode: Adapter = {
  tool: "opencode",
  executable: "opencode",
  promptVia: "arg",
  defaultModel: "opencode-go/mimo-v2.6-flash",
  // 同一数据目录并发会死锁或 SQLITE_BUSY（上游 anomalyco/opencode#29395、#21215）。
  exclusive: true,
  efforts: ["minimal", "low", "medium", "high", "max"],
  quotaProvider: "opencode",
  skillMount: "opencode-config",
  resumeArgs: ["run", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "cwd 必须是工作目录，目录外访问会被拒",
    "同一时刻只跑一个",
    "拉起环境去掉 HERDR_*，否则卡在 init",
    "常停在提交前，验收查 finished",
  ],
  build(input) {
    checkCommon(opencode, input);
    const args = ["run", "--format", "json", "--auto"];
    if (input.model) args.push("-m", input.model);
    if (input.effort) args.push("--variant", input.effort);
    // 以 -- 结束选项，防止以 - 开头的提示词被当成参数。
    args.push("--", input.prompt);
    return { command: opencode.executable, args, cwd: input.cwd };
  },
};
