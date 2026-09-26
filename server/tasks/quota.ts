import type { FastifyInstance } from "fastify";
import { Problem } from "../problem.ts";
import {
  parseOpenquotaRows,
  readOpenquotaPace,
  type OpenquotaOptions,
} from "./openquota.ts";

/**
 * 账号额度一览（#267）：服务端读 `openquota pace --json`，按富余降序。
 * 运行时「额度用尽」记录本任务恒为空，留给后续子任务接入。
 */

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
  const data = parseOpenquotaRows(stdout);
  if (!data)
    throw new Problem(400, "OpenQuota 输出无法解析", "service_unavailable");
  return parseQuotaRows(data);
}

function parseQuotaRows(data: unknown[]): QuotaAccount[] {
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

export async function listQuota(
  options: OpenquotaOptions = {},
): Promise<QuotaList> {
  const result = await readOpenquotaPace(options);
  if ("missing" in result)
    throw new Problem(404, "未找到 OpenQuota", "not_found");
  if ("error" in result) {
    const message = {
      timeout: "读取 OpenQuota 额度超时",
      parse: "OpenQuota 输出无法解析",
      failed: "读取 OpenQuota 额度失败",
    }[result.error];
    throw new Problem(400, message, "service_unavailable");
  }
  return { accounts: sortBySpare(parseQuotaRows(result.rows)) };
}

export function registerQuotaRoute(
  app: FastifyInstance,
  options: { bin?: string } = {},
) {
  app.get("/api/quota", () => listQuota({ bin: options.bin }));
}
