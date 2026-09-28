import { Problem } from "../problem.ts";

/**
 * 周期任务（sN）的时间判定：纯函数，穷举测试。
 * 时刻都是 UTC 毫秒；`--at` 按服务本机时区的钟点，时区偏移由调用方给（`offset(ms)` 返回分钟，东八区为 480），
 * 夏令时切换当天也落在同一个钟点。
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const EVERY_MIN = HOUR;
const EVERY_MAX = 366 * DAY;

/** 本机时区偏移（分钟，东正西负）；与 Date#getTimezoneOffset 符号相反。 */
export type Offset = (ms: number) => number;
export const localOffset: Offset = (ms) => -new Date(ms).getTimezoneOffset();

export const KINDS = ["task", "patrol", "research"] as const;
export type ScheduleKind = (typeof KINDS)[number];
export const isKind = (value: unknown): value is ScheduleKind =>
  typeof value === "string" && (KINDS as readonly string[]).includes(value);

const UNITS: Record<string, number> = {
  m: MINUTE,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
};

/** `--every`：7d、1d、12h、2w、90m；至少 1 小时，至多 366 天。 */
export function parseEvery(text: unknown): number {
  const match =
    typeof text === "string"
      ? /^([1-9]\d{0,5})([mhdw])$/.exec(text.trim())
      : null;
  const ms = match ? Number(match[1]) * UNITS[match[2]!]! : NaN;
  if (!match || ms < EVERY_MIN || ms > EVERY_MAX)
    throw new Problem(
      400,
      "--every: 写成 7d、1d、12h、2w 这样，至少 1h、至多 366d",
      "usage",
    );
  return ms;
}

/** 周期的写法（与 --every 同一套）：整天、整小时，否则分钟。 */
export function everyText(ms: number) {
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  return `${Math.round(ms / MINUTE)}m`;
}

/** `--at HH:MM`（本机钟点）→ 当天第几分钟；只有整天的周期能定钟点。 */
export function parseAt(text: unknown, every: number): number {
  const match =
    typeof text === "string" ? /^(\d{1,2}):(\d{2})$/.exec(text.trim()) : null;
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59)
    throw new Problem(400, "--at: 写成 09:30 这样的本机钟点", "usage");
  if (every % DAY !== 0)
    throw new Problem(
      400,
      "--at: 只有整天的周期（如 --every 1d、7d）能定钟点",
      "usage",
    );
  return hour * 60 + minute;
}

export const atText = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** 本机钟点（按偏移平移后的毫秒）换回 UTC：先按近似时刻取偏移，再按该偏移换算。 */
function toUtc(local: number, offset: Offset) {
  const guess = local - offset(local) * MINUTE;
  return local - offset(guess) * MINUTE;
}
const toLocal = (ms: number, offset: Offset) => ms + offset(ms) * MINUTE;

/** 添加时的第一轮：没定钟点的一个周期后；定了钟点的是下一个到来的该钟点（今天没过就是今天）。 */
export function firstDue(
  now: number,
  every: number,
  at: number | null,
  offset: Offset = localOffset,
): number {
  if (at === null) return now + every;
  const day = Math.floor(toLocal(now, offset) / DAY) * DAY;
  const today = toUtc(day + at * MINUTE, offset);
  return today > now ? today : toUtc(day + DAY + at * MINUTE, offset);
}

/** 一轮之后的下一轮；定了钟点的按本机日历加整天，跨夏令时仍是同一钟点。 */
export function following(
  due: number,
  every: number,
  at: number | null,
  offset: Offset = localOffset,
): number {
  if (at === null) return due + every;
  const day = Math.floor(toLocal(due, offset) / DAY) * DAY;
  return toUtc(day + every + at * MINUTE, offset);
}

/**
 * 从 due 往后数，now 及以前一共到了几轮、下一轮在什么时候。
 * 先按周期整除跳到 now 附近，再逐轮校正，停机很久也是常数步。
 */
export function catchUp(
  due: number,
  every: number,
  at: number | null,
  now: number,
  offset: Offset = localOffset,
): { slots: number; next: number } {
  if (due > now) return { slots: 0, next: due };
  let slots = 1;
  let next = following(due, every, at, offset);
  const jump = Math.floor((now - next) / every) - 1;
  if (jump > 0) {
    // 夏令时让一轮最多差一小时，先跳到 now 前一两轮再逐轮走。
    const start =
      at === null
        ? next + jump * every
        : following(next, jump * every, at, offset);
    slots += jump;
    next = start;
  }
  while (next <= now) {
    slots++;
    next = following(next, every, at, offset);
  }
  return { slots, next };
}

export type Clock = {
  next_at: number;
  every_ms: number;
  at_minute: number | null;
};

export type Decision =
  /** 没到点或已删除。 */
  | { kind: "wait" }
  /** 到点：生成一轮；missed 是停机错过、不再补的轮数。 */
  | { kind: "run"; next_at: number; missed: number }
  /** 到点但上一轮还没结束：本轮跳过，记一笔。 */
  | { kind: "skip"; next_at: number; missed: number; open: string };

/**
 * 巡检时一条周期任务该做什么。停机错过好几轮只补一轮；上一轮（todo / running / blocked）没结束就跳过。
 */
export function decide(
  schedule: Clock & { removed: boolean },
  /** 上一轮还没结束的任务短号；没有或已结束为 null。 */
  open: string | null,
  now: number,
  offset: Offset = localOffset,
): Decision {
  if (schedule.removed || schedule.next_at > now) return { kind: "wait" };
  const { slots, next } = catchUp(
    schedule.next_at,
    schedule.every_ms,
    schedule.at_minute,
    now,
    offset,
  );
  const missed = slots - 1;
  return open
    ? { kind: "skip", next_at: next, missed, open }
    : { kind: "run", next_at: next, missed };
}

/** 上一轮算没结束的状态。 */
const OPEN_STATUSES = ["todo", "running", "blocked"] as const;
export const isOpen = (status: string) =>
  (OPEN_STATUSES as readonly string[]).includes(status);

/** 生成任务标题里的本机日期，如 09-28。 */
export function dayLabel(now: number, offset: Offset = localOffset) {
  const local = new Date(toLocal(now, offset));
  return `${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}
