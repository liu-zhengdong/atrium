/**
 * 执行者进程的环境白名单（#262，沿用 #213 服务环境白名单的思路）。
 *
 * 只传系统基本变量与代理出网变量；执行者自己的凭据走它们各自的配置目录（HOME 下）。
 * 一律不传：ATRIUM_*（执行者不该连到派它的服务的隔离数据）、HERDR_*（opencode 的 herdr 插件会用
 * 继承来的窗格号连 herdr，卡在 init）、CLAUDECODE / CLAUDE_CODE_*（嵌套会话标记）、PI_*、
 * NODE_TEST_CONTEXT，以及 *_API_KEY、*_TOKEN 等凭据。白名单外的名字不看值、直接丢弃。
 */

const SYSTEM = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  "TERM",
]);

const NETWORK = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);

export function workerAllowed(key: string) {
  return SYSTEM.has(key) || NETWORK.has(key) || key.startsWith("LC_");
}

export function workerEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && workerAllowed(key)) env[key] = value;
  // 非交互运行：不要分页器，不要颜色码污染日志。
  env.NO_COLOR = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}
