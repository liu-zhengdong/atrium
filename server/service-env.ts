/**
 * 起服务进程（startService、startSupervisor）与独立运行器（runner start）唯一传入的环境白名单（#213）。
 *
 * 只保留三类必需变量：
 * - 系统基本：PATH/HOME 等，node、git、日志与文件操作依赖；
 * - 代理网络：HTTP(S)_PROXY 等，用户靠代理访问模型；NODE_EXTRA_CA_CERTS/SSL_CERT_FILE 随代理出网；
 * - 隔离与测试：ATRIUM_*（端口、数据目录、Pi home 等配置）、NPM_CONFIG_PREFIX（更新装进独立
 *   prefix、不污染全局）、PI_ACP_DIR（副本的 ACP 目录）、NODE_TEST_CONTEXT（见下）。
 *
 * 其余一律不传：身份只用分配的账号、凭据只用库里的（#150、#213）——不传 *_API_KEY、*_TOKEN、
 * ANTHROPIC_、CLAUDE_、OPENAI_ 前缀变量、SSH_AUTH_SOCK、HERDR_*，以及除 PI_ACP_DIR 之外的 PI_*。
 * 不加任何绕过白名单的测试开关；测试与运行配置走上面已列出的变量。
 * Windows 上变量名不分大小写，按大写比对与落键，另放行平台层列出的系统变量（SystemRoot、PATHEXT 等）。
 */

import { envKey, WINDOWS_SYSTEM_ENV, type Platform } from "./platform/plan.ts";

/** 服务进程运行、读日志与起子进程所需的系统变量。 */
const SYSTEM = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  "XDG_DATA_HOME",
]);

/** 出网：模型与 npm 都可能依赖代理与自定义证书。 */
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

/** 隔离（独立 prefix、独立 ACP 目录）与测试标记。 */
const ISOLATION = new Set([
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "PI_ACP_DIR",
  // node:test 子进程标记：让测试里缺 piHome 的服务拒绝写入 ~/.pi（不注入任何值）。
  "NODE_TEST_CONTEXT",
]);

const WINDOWS = new Set<string>(WINDOWS_SYSTEM_ENV);

function allowed(key: string, platform: Platform) {
  const name = envKey(platform, key);
  return (
    SYSTEM.has(name) ||
    NETWORK.has(name) ||
    ISOLATION.has(name) ||
    name.startsWith("ATRIUM_") ||
    name.startsWith("LC_") ||
    (platform === "win32" && WINDOWS.has(name))
  );
}

/** 被丢弃的凭据/身份类变量名（只匹配名字，不读取值）。 */
function droppedSensitiveNames(keys: Iterable<string>): string[] {
  return [...keys]
    .filter(
      (key) =>
        /^(ANTHROPIC|CLAUDE|OPENAI|GH|GITHUB|HERDR|PI)_/.test(key) ||
        /_(API_KEY|TOKEN)$/.test(key) ||
        key === "SSH_AUTH_SOCK",
    )
    .sort();
}

/**
 * 过滤出服务进程的环境；`droppedSensitive` 是被丢掉的凭据/身份类变量名，
 * 供 start/restart 回执打印（只报名字，不打印值）。
 */
export function serviceEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): {
  env: NodeJS.ProcessEnv;
  droppedSensitive: string[];
} {
  const env: NodeJS.ProcessEnv = {};
  const keys = Object.keys(base);
  for (const key of keys) {
    const value = base[key];
    if (value !== undefined && allowed(key, platform))
      env[envKey(platform, key)] = value;
  }
  return {
    env,
    droppedSensitive: droppedSensitiveNames(
      keys.filter((k) => !allowed(k, platform)),
    ),
  };
}

/** start/restart 回执：一行变量名，说明服务与执行者不继承它们；不打印值。 */
export function reportDroppedIdentity(names: readonly string[]) {
  if (!names.length) return;
  console.error(
    `已忽略身份/凭据环境变量：${names.join(", ")}；服务与执行者不继承这些变量。`,
  );
}
