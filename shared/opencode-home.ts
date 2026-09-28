import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { oauthOnly, planAuthFile, type Skipped } from "./opencode-auth.ts";

/** 从用户 opencode 数据目录按条目同步过来的凭据文件（只带 API key 类，见 opencode-auth.ts）。 */
export const AUTH_FILES = ["auth.json", "mcp-auth.json"] as const;

/** 秘书数据目录里记「上次从用户那边同步了哪些条目」的文件。 */
const SYNCED = "atrium-synced.json";

/** 秘书 opencode 的 XDG_DATA_HOME。 */
export function secretaryOpencodeHome(data: string) {
  return join(data, "secretary", "opencode-home");
}

/** 用户自己的 opencode 数据目录（opencode 按 XDG 规范取 `$XDG_DATA_HOME/opencode`）。 */
export function userOpencodeData(env: NodeJS.ProcessEnv = process.env) {
  return join(
    resolve(env.XDG_DATA_HOME || join(homedir(), ".local", "share")),
    "opencode",
  );
}

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

function readSynced(path: string): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(readText(path) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const result: Record<string, string[]> = {};
    for (const [file, names] of Object.entries(value))
      if (Array.isArray(names))
        result[file] = names.filter((name) => typeof name === "string");
    return result;
  } catch {
    return {};
  }
}

export type HomeReport = {
  /** 内容有变、重写了的文件。 */
  written: string[];
  /** 秘书用不上的提供商（用户那边只有 OAuth）。 */
  oauthOnly: string[];
  /** 没带过来的 MCP 登录。 */
  mcpSkipped: Skipped[];
  problems: string[];
};

/**
 * 备好秘书的数据目录：按条目从用户那边同步 API key 类凭据，OAuth 不带（opencode-auth.ts）。
 * 用户目录只读；秘书那份坏了挪到 `.bad-<时间>` 再重建。两边指向同一目录时什么都不做。
 */
export function prepareOpencodeHome(home: string, source: string): HomeReport {
  const report: HomeReport = {
    written: [],
    oauthOnly: [],
    mcpSkipped: [],
    problems: [],
  };
  const target = join(home, "opencode");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (real(target) === real(source)) return report;
  const syncedPath = join(home, SYNCED);
  const synced = readSynced(syncedPath);
  const next: Record<string, string[]> = {};
  for (const name of AUTH_FILES) {
    const to = join(target, name);
    let from: string | undefined;
    try {
      from = readText(join(source, name));
    } catch (error) {
      report.problems.push(
        `读不了用户的 opencode ${name}（${(error as NodeJS.ErrnoException).code ?? "未知错误"}），这次不同步`,
      );
      next[name] = synced[name] ?? [];
      continue;
    }
    const current = readText(to);
    const plan = planAuthFile(name, from, current, synced[name]);
    report.problems.push(...plan.problems);
    next[name] = plan.synced;
    if (name === "auth.json") report.oauthOnly = oauthOnly(plan);
    else report.mcpSkipped = plan.skipped;
    if (plan.content === undefined || plan.content === current) continue;
    if (current !== undefined && plan.problems.length)
      renameSync(to, `${to}.bad-${Date.now()}`);
    writeFileSync(`${to}.tmp`, plan.content, { mode: 0o600 });
    chmodSync(`${to}.tmp`, 0o600);
    renameSync(`${to}.tmp`, to);
    report.written.push(name);
  }
  writeFileSync(syncedPath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return report;
}

/**
 * 拉起 serve 与 attach 的环境：在去掉 HERDR_* 等的基础上（见 server/acp/client.ts agentEnvironment）
 * 换成秘书的数据目录；有密码时服务端要求 basic 认证，attach 从同名环境变量读，不进命令行参数。
 */
export function opencodeEnvironment(
  base: NodeJS.ProcessEnv,
  options: { home: string; password?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, XDG_DATA_HOME: options.home };
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  if (options.password) env.OPENCODE_SERVER_PASSWORD = options.password;
  return env;
}
