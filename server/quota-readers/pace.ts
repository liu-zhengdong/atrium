import type { QuotaWindow } from "./types.ts";

/**
 * 把额度窗口折成与 `openquota pace --json` 同结构的一行（纯函数）。口径照搬 OpenQuota
 * （src-tauri/src/cli.rs 的 build_row、pacing.rs 的 project），下游 quota、挑执行者、预算判定不用改：
 * - 对比窗口：名字含 week 的百分比窗口里最长的；没有就所有百分比窗口里最长的；
 * - 短窗：名字含 session 的；没有就 6 小时以内最短的；
 * - 周期进度只在「用量有意义」时给：用光、零用量、没有重置时刻、窗口刚开始、
 *   预计用不完且已用不足 5% 都留空，富余随之留空。
 */

export type PaceRow = {
  providerId: string;
  plan: string | null;
  windowId: string | null;
  windowLabel: string | null;
  usedPercent: number | null;
  periodElapsedPercent: number | null;
  sparePercent: number | null;
  hoursToReset: number | null;
  shortWindowId: string | null;
  shortWindowUsedPercent: number | null;
  refreshedAt: string;
  refreshedHoursAgo: number;
  stale: boolean;
};

const SHORT_WINDOW_MAX_PERIOD_SECONDS = 6 * 60 * 60;
/** OpenQuota 面板把超过 10 分钟的读数标为旧数据。 */
export const STALE_AFTER_MS = 10 * 60_000;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** 保留一位小数；与 Rust f64::round 一样远离零取整，并去掉 -0。 */
export function round1(value: number): number {
  const scaled = value * 10;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return rounded / 10 + 0;
}

/** 周期已过去的百分比；用量信号不足时为 null。 */
export function periodElapsedPercent(
  window: QuotaWindow,
  now: number,
): number | null {
  const used = clampPercent(window.usedPercent);
  if (Math.round(100 - used) <= 0) return null;
  if (used <= 0) return null;
  if (window.resetsAt === null) return null;
  if (window.periodSeconds === 0 || window.resetsAt <= now) return null;
  const startsAt = window.resetsAt - window.periodSeconds * 1000;
  const elapsedSeconds = Math.max(0, now - startsAt) / 1000;
  const progress = Math.min(
    1,
    Math.max(0, elapsedSeconds / window.periodSeconds),
  );
  if (elapsedSeconds < Math.max(window.periodSeconds * 0.01, 60)) return null;
  const projected = used / progress;
  if (projected <= 90) return progress * 100;
  if (used < 5) return null;
  return progress * 100;
}

const named = (window: QuotaWindow, needle: string) =>
  window.id.toLowerCase().includes(needle) ||
  window.label.toLowerCase().includes(needle);

/** 最长的窗口；等长取先出现的。 */
function longest(windows: readonly QuotaWindow[]): QuotaWindow | undefined {
  return windows.reduce<QuotaWindow | undefined>(
    (best, window) =>
      !best || window.periodSeconds > best.periodSeconds ? window : best,
    undefined,
  );
}

export function comparisonWindow(
  windows: readonly QuotaWindow[],
): QuotaWindow | undefined {
  const weekly = windows.filter((window) => named(window, "week"));
  return longest(weekly.length ? weekly : windows);
}

export function shortWindow(
  windows: readonly QuotaWindow[],
): QuotaWindow | undefined {
  const session = windows.find((window) => named(window, "session"));
  if (session) return session;
  return windows
    .filter(
      (window) =>
        window.periodSeconds > 0 &&
        window.periodSeconds <= SHORT_WINDOW_MAX_PERIOD_SECONDS,
    )
    .reduce<QuotaWindow | undefined>(
      (best, window) =>
        !best || window.periodSeconds < best.periodSeconds ? window : best,
      undefined,
    );
}

/** 两个时刻之间的小时数（按整秒截断，与 OpenQuota 一致）。 */
function hoursBetween(start: number, end: number): number {
  return Math.trunc((end - start) / 1000) / 3600;
}

/** 与 OpenQuota 相同的秒级 UTC 时间串。 */
export function isoSeconds(at: number): string {
  return new Date(Math.floor(at / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

export function paceRow(input: {
  providerId: string;
  plan: string | null;
  windows: readonly QuotaWindow[];
  refreshedAt: number;
  now: number;
}): PaceRow {
  const { windows, now } = input;
  const comparison = comparisonWindow(windows);
  const short = shortWindow(windows);
  const elapsed = comparison ? periodElapsedPercent(comparison, now) : null;
  return {
    providerId: input.providerId,
    plan: input.plan,
    windowId: comparison?.id ?? null,
    windowLabel: comparison?.label ?? null,
    usedPercent: comparison
      ? round1(clampPercent(comparison.usedPercent))
      : null,
    periodElapsedPercent: elapsed === null ? null : round1(elapsed),
    sparePercent:
      comparison && elapsed !== null
        ? round1(elapsed - clampPercent(comparison.usedPercent))
        : null,
    hoursToReset:
      comparison?.resetsAt != null
        ? round1(hoursBetween(now, comparison.resetsAt))
        : null,
    shortWindowId: short?.id ?? null,
    shortWindowUsedPercent: short
      ? round1(clampPercent(short.usedPercent))
      : null,
    refreshedAt: isoSeconds(input.refreshedAt),
    refreshedHoursAgo: round1(
      Math.max(0, hoursBetween(input.refreshedAt, now)),
    ),
    stale: now - input.refreshedAt >= STALE_AFTER_MS,
  };
}
