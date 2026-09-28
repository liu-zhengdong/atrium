/**
 * 检查「没进展」检测（t260）：纯函数，穷举测试；读日志与计时在 check-quiet-watch.ts。
 *
 * 本地检查、合入检查、远程检查的日志 warnMs（缺省 5 分钟）没有新输出，发一条提醒（知会负责的 leader，
 * 状态栏显示「检查 5 分钟没输出：卡在 …」）；stallMs（缺省 10 分钟）没有新输出，结束这次检查并分类：
 * - 日志里已经有失败用例 → 没过，失败用例照旧交回（不因为是被结束的就丢掉已查出的失败）；
 * - 没有失败用例 → 没跑成（卡住），记下卡在哪个测试文件，按 t204 自动重跑，卡住的只重跑 MAX_STALL_RERUNS 次。
 *
 * 测试运行器（tests/run-tests.ts）长时间没有用例结束时打印的「仍在跑：<文件>（已 N 秒）」只用来定位，不算输出。
 */

import type { LocalCheck } from "./local-check.ts";

/** 测试运行器心跳行的开头；心跳不算检查有进展。 */
export const STILL_RUNNING = "仍在跑：";

/** 缺省几分钟没输出发提醒、几分钟没输出结束检查。 */
export const QUIET_MINUTES = 5;
export const STALL_MINUTES = 10;

/** 卡住（没有失败用例）的检查最多自动重跑几次；之后转卡住。 */
export const MAX_STALL_RERUNS = 1;

export type QuietLimits = {
  /** 多久没输出发提醒。 */
  warnMs: number;
  /** 多久没输出结束检查；null 不结束（只受总时限）。 */
  stallMs: number | null;
};

const OFF = new Set(["0", "off", "none", "false"]);

/** 分钟数：正数（可带小数），至多一天；写错返回 undefined。 */
function parseMinutes(raw: string | undefined, allowOff: boolean) {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim().toLowerCase();
  if (allowOff && OFF.has(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value <= 24 * 60
    ? Math.round(value * 60_000)
    : undefined;
}

/**
 * 读配置：ATRIUM_QUIET_MINUTES（没输出多久提醒，执行者与检查共用，缺省 5）、
 * ATRIUM_CHECK_STALL_MINUTES（检查没输出多久结束，缺省 10；0 或 off 不结束）。
 * 按主机各自设（代理读它那台的环境）；写错的照缺省并列进 problems。
 */
export function quietLimits(env: NodeJS.ProcessEnv): {
  limits: QuietLimits;
  problems: string[];
} {
  const problems: string[] = [];
  const warn = parseMinutes(env.ATRIUM_QUIET_MINUTES, false);
  if (warn === undefined && env.ATRIUM_QUIET_MINUTES?.trim())
    problems.push(
      `ATRIUM_QUIET_MINUTES=${env.ATRIUM_QUIET_MINUTES} 看不懂，按缺省 ${QUIET_MINUTES} 分钟`,
    );
  const stall = parseMinutes(env.ATRIUM_CHECK_STALL_MINUTES, true);
  if (stall === undefined && env.ATRIUM_CHECK_STALL_MINUTES?.trim())
    problems.push(
      `ATRIUM_CHECK_STALL_MINUTES=${env.ATRIUM_CHECK_STALL_MINUTES} 看不懂，按缺省 ${STALL_MINUTES} 分钟`,
    );
  return {
    limits: {
      warnMs: warn ?? QUIET_MINUTES * 60_000,
      stallMs: stall === undefined ? STALL_MINUTES * 60_000 : stall,
    },
    problems,
  };
}

export type QuietState = {
  /** 最近一次看到输出（检查开始算一次）。 */
  lastOutputAt: number;
  /** 这一段安静里已经提醒过。 */
  warned: boolean;
};

export type QuietStep = "ok" | "warn" | "stall";

/** 这一刻该做什么：到结束线就结束（不论提醒过没有），到提醒线且这段安静还没提醒过就提醒。 */
export function quietStep(
  state: QuietState,
  limits: QuietLimits,
  now: number,
): QuietStep {
  const quiet = now - state.lastOutputAt;
  if (limits.stallMs !== null && quiet >= limits.stallMs) return "stall";
  if (!state.warned && quiet >= limits.warnMs) return "warn";
  return "ok";
}

const HEARTBEAT = /^仍在跑：(.+?)（已 (\d+) 秒）$/;

/**
 * 新读到的一段日志里有没有真输出：心跳行和空行不算。carry 是上次没读完的半行，
 * 返回这次末尾没换行的半行，下次接着拼（免得心跳行被切成两半后半截算成输出）。
 */
export function scanOutput(
  carry: string,
  text: string,
): { output: boolean; carry: string } {
  const lines = (carry + text).split("\n");
  const rest = lines.pop()!;
  const output = lines.some((line) => {
    const trimmed = line.trim();
    return !!trimmed && !trimmed.startsWith(STILL_RUNNING);
  });
  // 没换行的半行：可能是心跳的前半截（「仍在」或「仍在跑：…」）就等下次，其余（进度点、提示符）当场算输出。
  const partial = rest.trim();
  const maybeBeat =
    partial.startsWith(STILL_RUNNING) || STILL_RUNNING.startsWith(partial);
  return {
    output: output || (!!partial && !maybeBeat && text.length > 0),
    carry: rest.slice(-4096),
  };
}

/**
 * 卡在哪：日志末尾那段心跳里跑得最久的测试文件；末尾不是心跳时取最后一行输出（至多 200 字）。没有输出为 null。
 */
export function stuckAt(tail: string): string | null {
  const lines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let best: { file: string; seconds: number } | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const beat = HEARTBEAT.exec(lines[i]!);
    if (!beat) return best?.file ?? lines[i]!.slice(0, 200);
    const seconds = Number(beat[2]);
    if (!best || seconds > best.seconds) best = { file: beat[1]!, seconds };
  }
  return best?.file ?? null;
}

/** 时长说成人话：够一分钟按整分钟往下取，不够按秒。 */
export function quietMinutes(ms: number) {
  return ms >= 60_000
    ? `${Math.floor(ms / 60_000)} 分钟`
    : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

/** 提醒的一句话（状态栏、事件）：「检查 5 分钟没输出：卡在 tests/a.test.ts」。 */
export function quietText(quietMs: number, at: string | null) {
  return `检查 ${quietMinutes(quietMs)}没输出${at ? `：卡在 ${at}` : ""}`;
}

/**
 * 没输出到结束线、被结束的检查怎么记：已查出失败用例的按没过（失败用例照旧交回，由 classifyCheck 判），
 * 没有失败用例的按没跑成（卡住，infra 写明卡在哪）。
 */
export function stalledCheck(input: {
  failedTests: readonly string[];
  at: string | null;
  stallMs: number;
}): Pick<LocalCheck, "status" | "detail" | "infra" | "stalled"> {
  const quiet = `日志 ${quietMinutes(input.stallMs)}没有新输出${input.at ? `，卡在 ${input.at}` : ""}，已结束检查`;
  const stalled = { at: input.at };
  if (input.failedTests.length)
    return {
      status: "failed",
      detail: `${quiet}；结束前已查出失败用例`,
      stalled,
    };
  return {
    status: "timeout",
    detail: quiet,
    infra: `检查卡住：${quiet}`,
    stalled,
  };
}
