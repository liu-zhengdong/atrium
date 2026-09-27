import { existsSync } from "node:fs";
import { availableParallelism, homedir, hostname, totalmem } from "node:os";
import { join } from "node:path";
import { ADAPTERS, findExecutable } from "../tasks/adapters/index.ts";
import { TOOLS, type Tool } from "../tasks/adapters/types.ts";
import { hostLimits } from "../tasks/host-load.ts";
import type { CliState, HostInfo } from "./state.ts";

/**
 * 一台机器的自我介绍（#358）：系统、核数、内存、装了哪些编码 CLI 及是否登录。
 * 服务登记本机（h1）与代理接入远程主机用同一份。只看登录文件在不在，不读内容。
 */

/** 各工具登录后会留下的文件（相对主目录）；看不出来的给空表，判为「未知」。 */
export const LOGIN_FILES: Readonly<Record<Tool, readonly string[]>> = {
  claude: [".claude/.credentials.json", ".claude.json"],
  codex: [".codex/auth.json"],
  opencode: [".local/share/opencode/auth.json"],
  kimi: [],
  grok: [],
  agy: [],
  cursor: [],
};

/**
 * 是否登录：有登录文件算登录；codex 没有文件就是没登录（执行者环境不传 API key）；
 * claude 在 macOS 上可能只在钥匙串里，没有文件时判不出；其余判不出为 null。
 */
export function loggedIn(
  tool: Tool,
  platform: NodeJS.Platform,
  exists: (relative: string) => boolean,
): boolean | null {
  if (LOGIN_FILES[tool].some(exists)) return true;
  if (tool === "codex") return false;
  if (tool === "claude" && platform !== "darwin") return false;
  return null;
}

export function detectClis(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Partial<Record<Tool, CliState>> {
  const home = env.HOME || homedir();
  const clis: Partial<Record<Tool, CliState>> = {};
  for (const tool of TOOLS) {
    if (!findExecutable(ADAPTERS[tool].executable, env.PATH ?? "")) continue;
    clis[tool] = {
      installed: true,
      logged_in: loggedIn(tool, platform, (relative) =>
        existsSync(join(home, relative)),
      ),
    };
  }
  return clis;
}

export function machineInfo(input: {
  dataDir: string;
  version: string;
  env: NodeJS.ProcessEnv;
}): HostInfo {
  const cores = availableParallelism();
  return {
    hostname: hostname(),
    os: process.platform,
    arch: process.arch,
    cpus: cores,
    mem_mb: Math.round(totalmem() / 1024 / 1024),
    node: process.version,
    version: input.version,
    data_dir: input.dataDir,
    clis: detectClis(input.env),
    max_workers: hostLimits(input.env, cores).limits.maxWorkers,
  };
}
