import { execFile } from "node:child_process";
import { homedir } from "node:os";
import {
  commandInvocation,
  envKey,
  WINDOWS_SYSTEM_ENV,
} from "../platform/index.ts";

export const OPENQUOTA_BIN =
  "/Applications/OpenQuota.app/Contents/MacOS/openquota";

const PACE_TIMEOUT_MS = 10_000;
const PACE_MAX_BUFFER = 1024 * 1024;
const SYSTEM_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "TZ",
] as const;

export type OpenquotaPace =
  | { ok: true; rows: unknown[] }
  | { missing: true }
  | { error: "timeout" | "parse" | "failed" };

export type OpenquotaOptions = {
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function resolveOpenquotaBin(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const given = explicit?.trim();
  if (given) return given;
  const fromEnv = env.ATRIUM_OPENQUOTA_BIN?.trim();
  return fromEnv || OPENQUOTA_BIN;
}

/** 只传系统基本变量；Windows 上按大写比对并另放行平台层列出的系统变量。 */
function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = new Set<string>([
    ...SYSTEM_ENV,
    ...(process.platform === "win32" ? WINDOWS_SYSTEM_ENV : []),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const name = envKey(process.platform, key);
    if (value !== undefined && (keep.has(name) || name.startsWith("LC_")))
      env[name] = value;
  }
  return env;
}

export function parseOpenquotaRows(text: string): unknown[] | undefined {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** 统一读取 OpenQuota；调用方分别决定读取失败时是否降级。 */
export function readOpenquotaPace(
  options: OpenquotaOptions = {},
): Promise<OpenquotaPace> {
  const env = options.env ?? process.env;
  const child = childEnv(env);
  const call = commandInvocation(
    resolveOpenquotaBin(options.bin, env),
    ["pace", "--json"],
    child,
  );
  return new Promise((resolve) => {
    execFile(
      call.command,
      call.args,
      {
        cwd: homedir(),
        timeout: options.timeoutMs ?? PACE_TIMEOUT_MS,
        maxBuffer: PACE_MAX_BUFFER,
        env: child,
        windowsHide: true,
        windowsVerbatimArguments: call.verbatim,
      },
      (error, stdout) => {
        if (error) {
          resolve(
            error.code === "ENOENT"
              ? { missing: true }
              : { error: error.killed ? "timeout" : "failed" },
          );
          return;
        }
        const rows = parseOpenquotaRows(stdout);
        resolve(rows ? { ok: true, rows } : { error: "parse" });
      },
    );
  });
}
