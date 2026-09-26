import { Problem } from "../server/problem.ts";
import { setTimeout as delay } from "node:timers/promises";

export function sequence(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Problem(400, `${flag} 必须是非负整数序号`);
  return Number(value);
}

export function readBounds(after?: string, before?: string) {
  if (after !== undefined && before !== undefined)
    throw new Problem(400, "--after 和 --before 不能同时使用");
  const a = sequence(after, "--after");
  const b = sequence(before, "--before");
  if (b === 0) throw new Problem(400, "--before 必须大于 0");
  return a !== undefined
    ? `?after=${a}`
    : b !== undefined
      ? `?before=${b}`
      : "";
}

export function waitOptions(after?: string, timeout?: string, idle = false) {
  if (idle && after !== undefined)
    throw new Problem(400, "--idle 不能与 --after 同时使用");
  const cursor = sequence(after, "--after");
  const seconds = timeout === undefined ? 300 : sequence(timeout, "--timeout");
  if (!seconds || seconds > 3600)
    throw new Problem(400, "--timeout 必须在 1 到 3600 秒之间");
  return { cursor, seconds };
}

export const nextMessage = (
  verb: "等新消息" | "继续等",
  ref: string,
  id: number,
) => `${verb}：atrium wait ${ref} --after ${id}`;
export const nextTrace = (ref: string) => `查看轨迹：atrium trace ${ref}`;

/**
 * 等待并自动重连：服务关闭时返回 restarting，断连时抛 service_unavailable，
 * 两种都带同一个游标与剩余秒数接着等；总时长以 --timeout 为准，
 * 耗尽后按服务不可用退出（5），next 给能直接执行的续等命令。
 * 响应头带回服务端解析出的游标时，收到头就记下：
 * body 中途断开重连不漏消息，耗尽时续等命令也带得上 --after。
 */
export async function reconnectingWait<T>(config: {
  seconds: number;
  cursor?: number;
  request: (
    timeout: number,
    cursor: number | undefined,
    observe: (after: number) => void,
  ) => Promise<T>;
  restarting: (result: T) => boolean;
  nextCursor?: (result: T) => number | undefined;
  resume: (cursor: number | undefined) => string;
}): Promise<T> {
  const deadline = Date.now() + config.seconds * 1000;
  let cursor = config.cursor;
  let announced = false;
  const left = () => Math.ceil((deadline - Date.now()) / 1000);
  const giveUp = () =>
    new Problem(
      503,
      `服务在 ${config.seconds} 秒内没有恢复`,
      "service_unavailable",
      undefined,
      config.resume(cursor),
    );
  const notice = () => {
    if (announced) return;
    announced = true;
    console.error(`服务重启或断开，继续等剩余 ${Math.max(left(), 0)} 秒`);
  };
  for (;;) {
    const remaining = left();
    if (remaining <= 0) throw giveUp();
    let result: T;
    try {
      result = await config.request(Math.max(remaining, 1), cursor, (after) => {
        cursor = after;
      });
    } catch (error) {
      if (!(error instanceof Problem && error.code === "service_unavailable"))
        throw error;
      if (left() <= 0) throw giveUp();
      notice();
      await delay(500);
      continue;
    }
    if (!config.restarting(result)) return result;
    cursor = config.nextCursor?.(result) ?? cursor;
    if (left() <= 0) throw giveUp();
    notice();
  }
}
