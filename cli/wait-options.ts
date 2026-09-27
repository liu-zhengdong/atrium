import { Problem } from "../server/problem.ts";
import { setTimeout as delay } from "node:timers/promises";

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
