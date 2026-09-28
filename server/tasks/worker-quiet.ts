import type { WatchLimits, WatchState } from "./watchdog.ts";
import { quietMinutes } from "./check-quiet.ts";

/**
 * 执行者没进展提醒（t260）：纯函数，穷举测试。warnMs（缺省 5 分钟，ATRIUM_QUIET_MINUTES）没有进展信号
 * （日志不增长、没有工具调用与步骤事件、工作目录没变化）先提醒一次：知会负责的 leader，状态栏显示；
 * 又有进展后这段安静结束，下次再安静再提醒。原来的卡死判定（watchdog.ts judge，缺省 20 分钟）与
 * 紧急任务换人（urgent.ts swapDue，10 分钟）照旧；提醒线不早于卡死线时不提醒（到点直接判卡死）。
 */

export type QuietWarn =
  | { kind: "ok" }
  /** stallMs：再这么久没进展就判卡死（还没有过进展按启动时限算）。 */
  | { kind: "warn"; quietMs: number; stallMs: number };

export function workerQuiet(input: {
  state: WatchState;
  limits: WatchLimits;
  warnMs: number;
  /** 这段安静已经提醒过。 */
  warned: boolean;
  /** 已在停（卡死、换人、用户停止）或在催收尾。 */
  stopping: boolean;
  now: number;
}): QuietWarn {
  if (input.warned || input.stopping || input.warnMs <= 0)
    return { kind: "ok" };
  const since = input.state.lastProgressAt ?? input.state.startedAt;
  const stallMs =
    input.state.lastProgressAt === null
      ? input.limits.startupMs
      : input.limits.idleMs;
  if (input.warnMs >= stallMs) return { kind: "ok" };
  const quietMs = input.now - since;
  return quietMs >= input.warnMs
    ? { kind: "warn", quietMs, stallMs }
    : { kind: "ok" };
}

/** 状态栏一句：「claude/opus 5 分钟没进展」。 */
export function workerQuietText(worker: string | null, quietMs: number) {
  return `${worker ?? "执行者"} ${quietMinutes(quietMs)}没进展`;
}

/** 提醒事件的原因：没进展多久、到多久会判卡死。 */
export function workerQuietReason(quietMs: number, stallMs: number) {
  return `执行者 ${quietMinutes(quietMs)}没有进展（没有日志输出、没有工具调用、工作目录没变化）；到 ${quietMinutes(stallMs)}没进展会判卡死`;
}
