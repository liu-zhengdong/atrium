import type { DatabaseSync } from "node:sqlite";
import { atomically } from "../ledger/ledger.ts";

/**
 * 账号额度标记（#267 2）：执行者报额度用尽后，按 openquota 的 provider 记「用尽至何时」，
 * 到期前派活避开该账号，到点由运行时解除。每个函数显式接收数据库连接，全部参数化查询；
 * 判定（到期时刻、原因文本、哪些账号还被标记、收尾去向）是纯函数。
 */

/** 报文里解析不出恢复时间时，标记默认保留 1 小时，免得账号永远被避开。 */
export const DEFAULT_UNKNOWN_HOLD_MS = 60 * 60 * 1000;

export type QuotaHold = {
  provider: string;
  /** 到期时刻（毫秒）；NULL 只可能来自手工写入，按 since + 默认时长算到期。 */
  until: number | null;
  reason: string | null;
  since: number;
};

export function ensureQuotaHoldTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS quota_holds (
      provider TEXT PRIMARY KEY,
      until INTEGER NULL,
      reason TEXT,
      since INTEGER NOT NULL)`);
}

// ---- 纯函数 ----

/** 标记到期时刻：报文给了恢复时间就用它，否则 now + 兜底时长。 */
export function holdUntil(
  resetAt: Date | null,
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
) {
  const at = resetAt?.getTime();
  return at !== undefined && Number.isFinite(at) ? at : now + unknownMs;
}

/** 某条标记实际的到期时刻。 */
export const expiresAt = (
  hold: QuotaHold,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
) => hold.until ?? hold.since + unknownMs;

const pad = (value: number) => String(value).padStart(2, "0");

/** 本机时区的「YYYY-MM-DD HH:mm」。 */
export function clock(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 任务受阻原因：「额度用尽：<provider>，预计 <时刻> 恢复」或「……，恢复时间未知」。 */
export function quotaReason(provider: string, resetAt: Date | null) {
  return resetAt
    ? `额度用尽：${provider}，预计 ${clock(resetAt.getTime())} 恢复`
    : `额度用尽：${provider}，恢复时间未知`;
}

/** 还没到期的标记：provider → 到期时刻。 */
export function heldProviders(
  holds: readonly QuotaHold[],
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
): Map<string, number> {
  const held = new Map<string, number>();
  for (const hold of holds) {
    const until = expiresAt(hold, unknownMs);
    if (until > now) held.set(hold.provider, until);
  }
  return held;
}

/** 已到期、该解除的标记。 */
export function expiredHolds(
  holds: readonly QuotaHold[],
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
) {
  return holds.filter((hold) => expiresAt(hold, unknownMs) <= now);
}

export type QuotaRoute = { kind: "switch" } | { kind: "blocked"; why: string };

/**
 * 额度用尽后任务的去向：档案允许且这个任务还没换过执行者，就换一个未被标记的执行者重派一次
 * （都被标记时由调用方转为排队）；否则留在受阻，等人处理。
 */
export function routeAfterQuota(input: {
  switchAllowed: boolean;
  switched: boolean;
}): QuotaRoute {
  if (!input.switchAllowed)
    return { kind: "blocked", why: "档案不允许额度用尽时换执行者" };
  if (input.switched)
    return { kind: "blocked", why: "本任务已因额度换过一次执行者" };
  return { kind: "switch" };
}

// ---- 落库 ----

export function listHolds(db: DatabaseSync): QuotaHold[] {
  return db
    .prepare("SELECT * FROM quota_holds ORDER BY provider LIMIT 100")
    .all() as QuotaHold[];
}

/**
 * 记下「账号额度用尽至 until」。已有未到期标记时只把到期时刻往后推，返回 fresh=false，
 * 调用方据此不重复发事件；没有或已到期时新记一条，fresh=true。
 */
export function placeHold(
  db: DatabaseSync,
  hold: { provider: string; until: number; reason: string },
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
): { fresh: boolean; until: number } {
  return atomically(db, () => {
    const existing = db
      .prepare("SELECT * FROM quota_holds WHERE provider=?")
      .get(hold.provider) as QuotaHold | undefined;
    const live = existing && expiresAt(existing, unknownMs) > now;
    const until = live
      ? Math.max(expiresAt(existing, unknownMs), hold.until)
      : hold.until;
    db.prepare(
      "INSERT INTO quota_holds(provider,until,reason,since) VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET until=excluded.until,reason=excluded.reason,since=excluded.since",
    ).run(hold.provider, until, hold.reason, live ? existing.since : now);
    return { fresh: !live, until };
  });
}

/** 解除标记；只删仍然到期的那条，免得删掉解除前一刻刚续上的标记。 */
export function releaseHold(
  db: DatabaseSync,
  provider: string,
  now: number,
  unknownMs = DEFAULT_UNKNOWN_HOLD_MS,
) {
  return (
    db
      .prepare(
        "DELETE FROM quota_holds WHERE provider=? AND COALESCE(until, since+?)<=?",
      )
      .run(provider, unknownMs, now).changes > 0
  );
}

/** 人工解除：按 provider 精确删除，返回原标记以便记审计事件。 */
export function clearHold(
  db: DatabaseSync,
  provider: string,
): QuotaHold | undefined {
  return atomically(db, () => {
    const hold = db
      .prepare("SELECT * FROM quota_holds WHERE provider=?")
      .get(provider) as QuotaHold | undefined;
    if (hold)
      db.prepare("DELETE FROM quota_holds WHERE provider=?").run(provider);
    return hold;
  });
}
