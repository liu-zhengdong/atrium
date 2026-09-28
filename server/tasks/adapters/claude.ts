import {
  DEFAULT_WATCHDOG,
  checkCommon,
  invalid,
  type Adapter,
  type LaunchInput,
} from "./types.ts";

/**
 * claude -p（`claude --help` 核对）：-p/--print 非交互、--permission-mode bypassPermissions
 * 跳过权限确认、--model、--effort（low/medium/high/xhigh/max）；不给 prompt 参数时读 stdin。
 * 纯文本输出要到最后才打印，看门狗会把长时间读代码误判成卡死；所以用
 * --output-format stream-json（-p 下须配 --verbose）逐轮输出事件，作为进展信号。
 * 捎话（#307）：--input-format stream-json 让标准输入成为消息流，运行中写入的用户消息在工具调用边界读入
 * （2.1.283 实测：同一轮里读入，只出一个 result）；--replay-user-messages 把读入的消息带 isReplay 回显到日志，
 * 据此确认送达。标准输入读到 EOF 后处理完已读入的消息就退出，与读提示词文件时一样。
 */
const SESSION_RE =
  /"type":"system","subtype":"init"[^\n]*?"session_id":"([0-9a-f-]{36})"/;

function args(input: LaunchInput) {
  const list = ["-p", "--output-format", "stream-json", "--verbose"];
  if (input.live)
    list.push("--input-format", "stream-json", "--replay-user-messages");
  list.push("--permission-mode", "bypassPermissions");
  if (input.model) list.push("--model", input.model);
  if (input.effort) list.push("--effort", input.effort);
  return list;
}

const endpointEnv = (input: LaunchInput) =>
  input.endpoint
    ? { env: { ANTHROPIC_BASE_URL: input.endpoint.base_url } }
    : {};

export const claude: Adapter = {
  tool: "claude",
  executable: "claude",
  promptVia: "stdin",
  defaultModel: "opus",
  exclusive: false,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  quotaProvider: "claude",
  skillMount: "claude-plugin",
  resumeArgs: ["-p", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: ["工作目录由进程 cwd 决定，没有 --cwd 参数"],
  tell: "stdin",
  // Anthropic 兼容网关（t271）：地址走 ANTHROPIC_BASE_URL，密钥由运行时注入成 ANTHROPIC_AUTH_TOKEN。
  endpoints: { apis: ["anthropic"], keyEnv: "ANTHROPIC_AUTH_TOKEN" },
  build(input) {
    checkCommon(claude, input);
    return {
      command: claude.executable,
      args: args(input),
      cwd: input.cwd,
      stdin: input.promptFile,
      ...(input.live ? { input: "stream-json" as const } : {}),
      ...endpointEnv(input),
    };
  },
  resume(input) {
    checkCommon(claude, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`会话 id 不合法：${input.session}`);
    const list = args(input);
    list.splice(1, 0, "--resume", input.session);
    return {
      command: claude.executable,
      args: list,
      cwd: input.cwd,
      stdin: input.promptFile,
      ...(input.live ? { input: "stream-json" as const } : {}),
      ...endpointEnv(input),
    };
  },
  sessionOf: (log) => SESSION_RE.exec(log)?.[1],
};
