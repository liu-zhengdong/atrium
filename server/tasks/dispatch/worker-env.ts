import { availableParallelism } from "node:os";
import { hostLimits } from "./host-load.ts";

/**
 * 执行者进程的环境白名单（#262，沿用 #213 服务环境白名单的思路）。
 *
 * 只传系统基本变量与代理出网变量；执行者自己的凭据走它们各自的配置目录（HOME 下）。
 * 一律不传：ATRIUM_*（执行者不该连到派它的服务的隔离数据）、HERDR_*（opencode 的 herdr 插件会用
 * 继承来的窗格号连 herdr，卡在 init）、CLAUDECODE / CLAUDE_CODE_*（嵌套会话标记）、PI_*、
 * NODE_TEST_CONTEXT，以及 *_API_KEY、*_TOKEN 等凭据。白名单外的名字不看值、直接丢弃。
 * 固定加上 ATRIUM_WORKER=1：命令行据此拒绝操作用户的 Atrium 服务。
 * 另注入 ATRIUM_TEST_CONCURRENCY（#358）：测试并发上限，仓库的测试脚本据此限并发，
 * 免得每个 worktree 各占满全部核；来源环境里设了合法值就沿用，否则按核数给缺省。
 * Windows 上变量名不分大小写，按大写比对与落键，另放行平台层列出的系统变量（SystemRoot、PATHEXT 等）。
 */

import {
  envKey,
  WINDOWS_SYSTEM_ENV,
  type Platform,
} from "../../platform/plan.ts";

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

const WINDOWS = new Set<string>(WINDOWS_SYSTEM_ENV);

export function workerAllowed(
  key: string,
  platform: Platform = process.platform,
) {
  const name = envKey(platform, key);
  return (
    SYSTEM.has(name) ||
    NETWORK.has(name) ||
    name.startsWith("LC_") ||
    (platform === "win32" && WINDOWS.has(name))
  );
}

export function workerEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && workerAllowed(key, platform))
      env[envKey(platform, key)] = value;
  // 非交互运行：不要分页器，不要颜色码污染日志。
  env.NO_COLOR = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GH_PROMPT_DISABLED = "1";
  // 命令行见到这个标记就拒绝操作用户的 Atrium 服务（cli/worker-guard.ts）。
  env.ATRIUM_WORKER = "1";
  env.ATRIUM_TEST_CONCURRENCY = String(
    hostLimits(base, availableParallelism()).limits.testConcurrency,
  );
  return env;
}
