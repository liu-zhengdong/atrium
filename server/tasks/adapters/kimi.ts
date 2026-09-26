import { DEFAULT_WATCHDOG, checkCommon, type Adapter } from "./types.ts";

/**
 * kimi（`kimi --help` 核对）：-p/--prompt 非交互单次运行、-m 模型别名（缺省用 config.toml 的
 * default_model）；没有思考强度参数。不能加 -y/--yolo 或 --auto；工作目录由进程 cwd 决定。
 */
export const kimi: Adapter = {
  tool: "kimi",
  executable: "kimi",
  promptVia: "arg",
  defaultModel: undefined,
  exclusive: false,
  efforts: undefined,
  quotaProvider: "kimi",
  resumeArgs: ["--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: [
    "只用 -p，不加 -y/--auto",
    "退出时可能有内部报错但活已干完，以实际产物为准",
  ],
  build(input) {
    checkCommon(kimi, input);
    const args = ["-p", input.prompt];
    if (input.model) args.push("-m", input.model);
    return { command: kimi.executable, args, cwd: input.cwd };
  },
};
