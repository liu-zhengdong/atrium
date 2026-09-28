import { checkCommon, type Adapter } from "./types.ts";

/**
 * grok（`grok --help` 核对）：-p/--single 单轮提示词、-m 模型、--always-approve 自动批准、
 * --cwd 工作目录、--reasoning-effort 思考强度。另有 --prompt-file，未实测，先沿用已验证的 -p。
 */
export const grok: Adapter = {
  tool: "grok",
  executable: "grok",
  promptVia: "arg",
  defaultModel: "grok-4.6",
  exclusive: false,
  efforts: ["low", "medium", "high"],
  quotaProvider: "grok",
  resumeArgs: ["--continue"],
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["grok-4.6 易把逻辑堆进一个文件，验收查 file_growth"],
  tell: "restart",
  build(input) {
    checkCommon(grok, input);
    const args = ["-p", input.prompt];
    if (input.model) args.push("-m", input.model);
    if (input.effort) args.push("--reasoning-effort", input.effort);
    args.push("--always-approve", "--cwd", input.cwd);
    return { command: grok.executable, args, cwd: input.cwd };
  },
};
