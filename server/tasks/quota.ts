import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { Problem } from "../problem.ts";

/**
 * 账号额度一览（#267）：服务端读 `openquota pace --json`，按富余降序。
 * 运行时「额度用尽」记录本任务恒为空，留给后续子任务接入。
 */

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

export type QuotaAccount = {
  providerId: string;
  usedPercent: number | null;
  periodElapsedPercent: number | null;
  sparePercent: number | null;
  hoursToReset: number | null;
  shortWindowUsedPercent: number | null;
  refreshedAt: string | null;
  /** 该账号是否被记为额度用尽、至何时；本任务恒为 null。 */
  runtime: string | null;
};

export type QuotaList = { accounts: QuotaAccount[] };

export type QuotaOptions = {
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

function quotaEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SYSTEM_ENV)
    if (base[key] !== undefined) env[key] = base[key];
  for (const [key, value] of Object.entries(base))
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  return env;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function row(item: Record<string, unknown>): QuotaAccount | undefined {
  const providerId = providerIdOf(item.providerId);
  if (!providerId) return undefined;
  return {
    providerId,
    usedPercent: finiteNumber(item.usedPercent),
    periodElapsedPercent: finiteNumber(item.periodElapsedPercent),
    sparePercent: finiteNumber(item.sparePercent),
    hoursToReset: finiteNumber(item.hoursToReset),
    shortWindowUsedPercent: finiteNumber(item.shortWindowUsedPercent),
    refreshedAt: typeof item.refreshedAt === "string" ? item.refreshedAt : null,
    runtime: null,
  };
}

/** 从 openquota pace --json 抽出额度行；非对象或缺少 providerId 的项跳过。 */
export function parseQuotaAccounts(stdout: string): QuotaAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Problem(400, "OpenQuota 输出无法解析", "service_unavailable");
  }
  if (!Array.isArray(data))
    throw new Problem(400, "OpenQuota 输出无法解析", "service_unavailable");
  const accounts: QuotaAccount[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const parsed = row(item as Record<string, unknown>);
    if (parsed) accounts.push(parsed);
  }
  return accounts;
}

/** 按 sparePercent 降序；没有富余数据的排在最后，同富余按账号名。 */
export function sortBySpare(accounts: readonly QuotaAccount[]): QuotaAccount[] {
  return [...accounts].sort((a, b) => {
    if (a.sparePercent === null && b.sparePercent === null)
      return a.providerId.localeCompare(b.providerId);
    if (a.sparePercent === null) return 1;
    if (b.sparePercent === null) return -1;
    return (
      b.sparePercent - a.sparePercent ||
      a.providerId.localeCompare(b.providerId)
    );
  });
}

function paceProblem(error: {
  code?: string | number | null;
  killed?: boolean;
}): Problem {
  if (error.code === "ENOENT")
    return new Problem(404, "未找到 OpenQuota", "not_found");
  if (error.killed)
    return new Problem(400, "读取 OpenQuota 额度超时", "service_unavailable");
  return new Problem(400, "读取 OpenQuota 额度失败", "service_unavailable");
}

function runPace(
  bin: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["pace", "--json"],
      { timeout: timeoutMs, maxBuffer: PACE_MAX_BUFFER, env: quotaEnv(env) },
      (error, stdout) => {
        if (error) reject(paceProblem(error));
        else resolve(stdout);
      },
    );
  });
}

export async function listQuota(
  options: QuotaOptions = {},
): Promise<QuotaList> {
  const env = options.env ?? process.env;
  const bin = resolveOpenquotaBin(options.bin, env);
  const stdout = await runPace(bin, options.timeoutMs ?? PACE_TIMEOUT_MS, env);
  return { accounts: sortBySpare(parseQuotaAccounts(stdout)) };
}

export function registerQuotaRoute(
  app: FastifyInstance,
  options: { bin?: string } = {},
) {
  app.get("/api/quota", () => listQuota({ bin: options.bin }));
}
