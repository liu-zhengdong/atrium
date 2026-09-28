/**
 * 检查到期（overdue.ts 表里检查那一行）：纯函数，穷举测试；读日志与计时在 check-quiet-watch.ts。
 *
 * 检查日志 DUE.check.ms（10 分钟）没有新输出，结束这次检查并分类：
 * - 日志里已经有失败用例 → 没过，失败用例照旧交回（不因为是被结束的就丢掉已查出的失败）；
 * - 没有失败用例 → 没跑成（卡住），记下卡在哪个测试文件，按 t204 自动重跑，卡住的只重跑 MAX_STALL_RERUNS 次。
 *
 * 测试运行器（tests/run-tests.ts）长时间没有用例结束时打印的「仍在跑：<文件>（已 N 秒）」只用来定位，不算输出。
 */

import type { LocalCheck } from "./local-check.ts";
import { spanText } from "../watch/overdue.ts";

/** 测试运行器心跳行的开头；心跳不算检查有进展。 */
export const STILL_RUNNING = "仍在跑：";

/** 卡住（没有失败用例）的检查最多自动重跑几次；之后转卡住。 */
export const MAX_STALL_RERUNS = 1;

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

/**
 * 没输出到结束线、被结束的检查怎么记：已查出失败用例的按没过（失败用例照旧交回，由 classifyCheck 判），
 * 没有失败用例的按没跑成（卡住，infra 写明卡在哪）。
 */
export function stalledCheck(input: {
  failedTests: readonly string[];
  at: string | null;
  stallMs: number;
}): Pick<LocalCheck, "status" | "detail" | "infra" | "stalled"> {
  const quiet = `日志 ${spanText(input.stallMs) || `${Math.round(input.stallMs / 1000)} 秒`}没有新输出${input.at ? `，卡在 ${input.at}` : ""}，已结束检查`;
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
