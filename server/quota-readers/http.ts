/**
 * 读取器的 GET 请求：超时有界、响应正文限长；失败只给分类，不把底层报错（可能带请求头）往外传。
 */

export type HttpReply = {
  status: number;
  headers: Headers;
  /** 解析不出 JSON 时为 undefined。 */
  body: unknown;
};

export type HttpFailure = { error: "timeout" | "network" };

const MAX_BODY_BYTES = 1024 * 1024;

export async function getJson(
  url: string,
  headers: Record<string, string>,
  options: { fetch: typeof fetch; timeoutMs: number },
): Promise<HttpReply | HttpFailure> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await options.fetch(url, {
      method: "GET",
      headers,
      signal,
      redirect: "error",
    });
    const text = await response.text();
    let body: unknown;
    if (text.length <= MAX_BODY_BYTES)
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    return { status: response.status, headers: response.headers, body };
  } catch {
    return { error: signal.aborted ? "timeout" : "network" };
  }
}

export const isFailure = (
  reply: HttpReply | HttpFailure,
): reply is HttpFailure => "error" in reply;

/** 连接层失败的中文说法。 */
export const transportReason = (failure: HttpFailure, who: string) =>
  failure.error === "timeout"
    ? `${who} 用量接口超时`
    : `连不上 ${who} 用量接口`;

/** Retry-After：秒数或 HTTP 日期；给出毫秒时刻。 */
export function retryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(now, at) : undefined;
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 数字或数字字符串；非有限数为 undefined。 */
export function numberOf(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** ISO 时间串、无时区的时间串（按 UTC）、秒或毫秒时间戳 → 毫秒时刻。 */
export function timeOf(value: unknown): number | null {
  if (typeof value === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    const text = value.trim();
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
    const at = Date.parse(zoned);
    return Number.isFinite(at) ? at : null;
  }
  const raw = numberOf(value);
  if (raw === undefined) return null;
  return Math.round(Math.abs(raw) < 10_000_000_000 ? raw * 1000 : raw);
}
