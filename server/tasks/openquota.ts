import { execFile } from "node:child_process";

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

function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SYSTEM_ENV)
    if (base[key] !== undefined) env[key] = base[key];
  for (const [key, value] of Object.entries(base))
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
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
  return new Promise((resolve) => {
    execFile(
      resolveOpenquotaBin(options.bin, env),
      ["pace", "--json"],
      {
        timeout: options.timeoutMs ?? PACE_TIMEOUT_MS,
        maxBuffer: PACE_MAX_BUFFER,
        env: childEnv(env),
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
