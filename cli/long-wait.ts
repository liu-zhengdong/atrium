import { Problem } from "../server/problem.ts";
import { reconnectingWait } from "./wait-options.ts";

/** 单次请求最多挂 240 秒：fetch 默认 300 秒收不到响应头就断开。 */
const CHUNK_SECONDS = 240;
export const WAIT_MAX_SECONDS = 3600;

/** --timeout：0～3600 的整数秒，缺省 300；0 表示只看一眼不等。 */
export function waitSeconds(value: string | undefined) {
  if (value === undefined) return 300;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > WAIT_MAX_SECONDS)
    throw new Problem(
      400,
      `--timeout 应为 0～${WAIT_MAX_SECONDS} 的整数秒（收到：${value}）`,
      "usage",
    );
  return Number(value);
}

/**
 * 服务端长轮询：总时长按 --timeout，分段请求；服务重启或断连时带剩余时间续等。
 */
export async function longWait<
  T extends { timed_out: boolean; restarting?: boolean },
>(
  seconds: number,
  request: (timeout: number) => Promise<T>,
  resume: () => string,
): Promise<T> {
  if (seconds === 0) return request(0);
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const result = await reconnectingWait<T>({
      seconds: left,
      request: (timeout) => request(Math.min(timeout, CHUNK_SECONDS)),
      restarting: (value) => value.restarting === true,
      resume,
    });
    if (!result.timed_out || Date.now() >= deadline - 500) return result;
  }
}
