import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  parseOpenquotaRows,
  readOpenquotaPace,
  type OpenquotaOptions,
} from "./openquota.ts";
import {
  clock,
  DEFAULT_UNKNOWN_HOLD_MS,
  ensureQuotaHoldTable,
  expiresAt,
  listHolds,
  type QuotaHold,
} from "./quota-holds.ts";

/**
 * 账号额度一览（#267）：服务端读 `openquota pace --json`，按富余降序。
 * 「运行时记录」列取自额度用尽标记（quota-holds 的未到期行），没有标记就留空；
 * 表格给一句话，--json 另给 until / reason 供程序判断。
 */

/** 某账号的额度用尽标记：until 是标记到期时刻（到点账号恢复可派），reason 是判定依据。 */
export type QuotaAccountHold = { until: number; reason: string | null };

/** 一个账号的运行时记录：表格一格文案 + 配套结构化字段。 */
export type QuotaRuntime = { note: string; hold: QuotaAccountHold };

export type QuotaAccount = {
  providerId: string;
  usedPercent: number | null;
  periodElapsedPercent: number | null;
  sparePercent: number | null;
  hoursToReset: number | null;
  shortWindowUsedPercent: number | null;
  refreshedAt: string | null;
  /** 未到期标记的文案（预计恢复时刻 / 恢复时间未知）；没有标记为 null。 */
  runtime: string | null;
  /** 同一标记的结构化形式，--json 消费；没有标记为 null。 */
  hold: QuotaAccountHold | null;
};

export type QuotaList = { accounts: QuotaAccount[] };

/**
 * 恢复时间未知时 quotaReason 写的收尾语（见 quota-holds.ts）。until 为空只可能来自手工写入，
 * 一律按恢复时间未知呈现，不把兜底到期时刻说成恢复时刻。
 */
const UNKNOWN_RESTORE = /恢复时间未知/;

/** 一条标记的运行时记录；没有标记、已到期都返回 null。 */
export function holdRuntime(
  hold: QuotaHold | undefined,
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
): QuotaRuntime | null {
  if (!hold) return null;
  const until = expiresAt(hold, unknownMs);
  if (until <= now) return null;
  return {
    note:
      hold.until === null || UNKNOWN_RESTORE.test(hold.reason ?? "")
        ? "额度用尽，恢复时间未知"
        : `额度用尽，预计 ${clock(hold.until)} 恢复`,
    hold: { until, reason: hold.reason },
  };
}

/** provider → 运行时记录，只留未到期的标记。 */
export function holdRuntimes(
  holds: readonly QuotaHold[],
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
): Map<string, QuotaRuntime> {
  const runtimes = new Map<string, QuotaRuntime>();
  for (const hold of holds) {
    const runtime = holdRuntime(hold, now, unknownMs);
    if (runtime) runtimes.set(hold.provider, runtime);
  }
  return runtimes;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function row(
  item: Record<string, unknown>,
  runtimes: ReadonlyMap<string, QuotaRuntime> = new Map(),
): QuotaAccount | undefined {
  const providerId = providerIdOf(item.providerId);
  if (!providerId) return undefined;
  const runtime = runtimes.get(providerId);
  return {
    providerId,
    usedPercent: finiteNumber(item.usedPercent),
    periodElapsedPercent: finiteNumber(item.periodElapsedPercent),
    sparePercent: finiteNumber(item.sparePercent),
    hoursToReset: finiteNumber(item.hoursToReset),
    shortWindowUsedPercent: finiteNumber(item.shortWindowUsedPercent),
    refreshedAt: typeof item.refreshedAt === "string" ? item.refreshedAt : null,
    runtime: runtime?.note ?? null,
    hold: runtime?.hold ?? null,
  };
}

/** 从 openquota pace --json 抽出额度行；非对象或缺少 providerId 的项跳过。 */
export function parseQuotaAccounts(
  stdout: string,
  runtimes?: ReadonlyMap<string, QuotaRuntime>,
): QuotaAccount[] {
  const data = parseOpenquotaRows(stdout);
  if (!data)
    throw new Problem(400, "OpenQuota 输出无法解析", "service_unavailable");
  return parseQuotaRows(data, runtimes);
}

function parseQuotaRows(
  data: unknown[],
  runtimes?: ReadonlyMap<string, QuotaRuntime>,
): QuotaAccount[] {
  const accounts: QuotaAccount[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const parsed = row(item as Record<string, unknown>, runtimes);
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

export type QuotaListOptions = OpenquotaOptions & {
  /** 额度标记所在的库；没有它（例如未启用任务运行时）就只有额度数据。 */
  db?: DatabaseSync;
  /** 判定标记是否到期的时刻；缺省系统时间。 */
  now?: number;
  /** until 为空的标记按 since + 多久算到期；缺省 1 小时。 */
  unknownMs?: number;
};

export async function listQuota(
  options: QuotaListOptions = {},
): Promise<QuotaList> {
  const { db, now = Date.now(), unknownMs, ...openquota } = options;
  const result = await readOpenquotaPace(openquota);
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
  const runtimes = db
    ? holdRuntimes(listHolds(db), now, unknownMs)
    : new Map<string, QuotaRuntime>();
  return { accounts: sortBySpare(parseQuotaRows(result.rows, runtimes)) };
}

export function registerQuotaRoute(
  app: FastifyInstance,
  options: { bin?: string; db?: DatabaseSync } = {},
) {
  // 任务运行时没启用时额度标记表可能还不存在，读之前先确保它在。
  if (options.db) ensureQuotaHoldTable(options.db);
  app.get("/api/quota", () => listQuota({ bin: options.bin, db: options.db }));
}
