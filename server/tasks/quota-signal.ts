/**
 * 额度报文解析（#267 1）：输入执行者进程的退出码与日志末尾，判断是不是「额度用尽」，
 * 能解析时给出恢复时刻，解析不出就明确返回恢复时间未知。纯函数：不读文件、不看系统时钟，
 * now 由调用方传入；只有报文没写时区时才落到本机时区（真实报文都带时区，见测试夹具）。
 */

import { ADAPTERS, type Tool } from "./adapters/index.ts";
import { parseLine } from "./json-log.ts";

export type QuotaVerdict =
  | { exhausted: false }
  | {
      exhausted: true;
      /** openquota 的账号 provider id，与 pickWorker 跳账号用的是同一套键。 */
      provider: string;
      /** 恢复时刻；null 表示报文像额度问题但没给出时间。 */
      resetAt: Date | null;
      reason: string;
    };

export type QuotaInput = {
  /** 退出码：0（正常结束）不判额度；null 表示被信号结束或退出码未知，交给日志定。 */
  exitCode: number | null;
  logTail: string;
  now: Date;
  tool: Tool;
};

/**
 * 看起来是额度/限流的词。前后不能是字母，免得把 `openquota` 这样的工具名算进来；
 * 下划线算分隔，`rate_limit_error`、`insufficient_quota` 也能命中。
 * Cursor 的月度额度用完：`Your usage limits will reset when your monthly cycle ends`、`set a Spend Limit to continue`。
 */
const QUOTA_MARK =
  /(?:usage|session|rate|request|monthly|daily|5[-_\s]?hour)[\s_]+limits?\s+(?:reached|exceeded|hit|exhausted)|exhausted your quota|RESOURCE_EXHAUSTED|hit (?:your|the) [^\n]{0,40}limits?|usage limits? will reset|set (?:a|your) spend(?:ing)? limit|rate_limit_error|(?:insufficient|exceeded|exhausted)[_\s]+quota|quota[_\s]+(?:exceeded|exhausted|limit|depleted)|too many requests|(?:额度|用量|余额)[^\n]{0,20}(?:用尽|不足|超限|达到上限|已满)|(?:用尽|不足|超限)[^\n]{0,20}(?:额度|用量|余额)/i;

/** 整数 429，前后不能有数字或小数点，免得把日期片段、端口号算进去。 */
const HTTP_429 = /(?<![\d.])429(?![\d])/;

/** 只从执行者报错事件或非结构化的最后错误报文取证，绝不扫描助手正文或工具内容。 */
export function quotaErrorText(logTail: string): string {
  let last = "";
  for (const line of logTail.split("\n")) {
    const event = parseLine(line);
    if (!event) {
      // 纯文本适配器的退出前报文；普通叙述、命令名和摘要不是错误。
      if (
        /\b(?:error|failed|limit reached|limit exceeded|hit your .*limit|usage limits? will reset|spend(?:ing)? limit|too many requests|HTTP\/\S+ 429)\b|额度.{0,20}(?:用尽|不足|超限)|余额不足/i.test(
          line,
        )
      )
        last = line;
      else if (last && /\b(?:retry-after|try again in|resets? \d)/i.test(line))
        last += `\n${line}`;
      continue;
    }
    const type = event.type;
    // 正常收尾：claude 的 stop_reason=end_turn；cursor 的 result 没有 stop_reason，看 subtype=success。
    if (
      type === "result" &&
      event.is_error === false &&
      (event.stop_reason === "end_turn" ||
        (event.stop_reason === undefined && event.subtype === "success"))
    ) {
      last = "";
      continue;
    }
    // agy：{event:"result",result:{status,error}}；SUCCESS 之前的报错已经越过去了。
    if (event.event === "result") {
      const result = event.result;
      if (!result || typeof result !== "object") continue;
      const { status, error } = result as Record<string, unknown>;
      if (status === "SUCCESS") last = "";
      else if (typeof error === "string" && error) last = error;
      continue;
    }
    if (type === "rate_limit_event") {
      const info = event.rate_limit_info;
      const status =
        info && typeof info === "object" && "status" in info
          ? info.status
          : undefined;
      if (
        typeof status === "string" &&
        /^(?:rejected|blocked|limited|rate_limited|exceeded|denied)$/i.test(
          status,
        )
      )
        last = `rate limit exceeded: ${status}`;
      continue;
    }
    if (
      type !== "error" &&
      !(
        type === "result" &&
        (event.is_error === true || event.subtype === "error")
      )
    )
      continue;
    const report: string[] = [];
    // 出错的 result 事件正文就是报错（cursor / claude stream-json 的 is_error=true）。
    const result = type === "result" ? event.result : undefined;
    for (const value of [event.error, event.errors, event.message, result]) {
      if (typeof value === "string") report.push(value);
      else if (Array.isArray(value)) {
        for (const item of value)
          if (typeof item === "string") report.push(item);
      } else if (value && typeof value === "object") {
        const error = value as Record<string, unknown>;
        for (const field of ["message", "type", "code"])
          if (typeof error[field] === "string") report.push(error[field]);
      }
    }
    if (report.length) last = report.join("\n");
  }
  return last;
}

/** codex / ChatGPT：`Try again in ~6826 min.` */
const CODEX_MINUTES =
  /try\s+again\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|m)(?![a-z])/i;

/** Claude：`resets 3:50pm (Asia/Shanghai)`、`resets 15:50`、`reset 3pm`。 */
const RESET_AT = /\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;

/** 通用 HTTP：`Retry-After: 120` 或 `retry-after: Sun, 27 Sep 2026 20:00:00 GMT`。 */
const RETRY_AFTER = /\bretry-after\s*:\s*([^\r\n]+)/i;

const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

type Timed = { resetAt: Date; label: string; index: number };

/** 报文里写的时间与时区；无效时区退回本机时区。 */
function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** 某个时刻在指定时区的挂钟时间。 */
function zoneWall(date: Date, zone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const num = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second"),
  };
}

/** 指定时刻在指定时区的偏移（毫秒）。 */
function zoneOffset(ts: number, zone: string): number {
  const w = zoneWall(new Date(ts), zone);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - Math.floor(ts / 1000) * 1000;
}

/** 把「按 UTC 解读的挂钟毫秒」换算回真实时刻；先猜再校一遍，跨 DST 也落在正确一侧。 */
function wallToUtc(wallMs: number, zone: string): Date {
  let ts = wallMs - zoneOffset(wallMs, zone);
  ts = wallMs - zoneOffset(ts, zone);
  return new Date(ts);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** codex：`Try again in ~6826 min.` → now + N 分钟。 */
function fromMinutes(text: string, now: Date): Timed | undefined {
  const match = CODEX_MINUTES.exec(text);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return {
    resetAt: new Date(now.getTime() + minutes * 60_000),
    label: `额度报文：约 ${match[1]} 分钟后恢复`,
    index: match.index,
  };
}

/**
 * Claude：`resets 3:50pm (Asia/Shanghai)` → 当天该时区的 15:50；已经过去或正好相等就取次日
 * （宁可推到次日，也不给出一个已经过去的时刻）。时区缺省用本机时区。
 */
function fromResetTime(text: string, now: Date): Timed | undefined {
  for (const match of text.matchAll(RESET_AT)) {
    const hourText = match[1];
    if (!hourText) continue;
    const minuteText = match[2];
    const ampm = match[3] ? match[3].toLowerCase() : "";
    // 只有分钟或 am/pm 才是时间：`reset 5 times` 这种不算。
    if (!minuteText && !ampm) continue;
    const minute = minuteText ? Number(minuteText) : 0;
    if (minute > 59) continue;
    let hour = Number(hourText);
    if (ampm) {
      if (hour < 1 || hour > 12) continue;
      if (ampm === "pm" && hour !== 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
    } else if (hour > 23) continue;
    const after = text.slice(match.index + match[0].length);
    const zone =
      validZone(/^\s*\(([^()]{2,64})\)/.exec(after)?.[1]) ?? SYSTEM_ZONE;
    const wall = zoneWall(now, zone);
    let target = Date.UTC(wall.year, wall.month - 1, wall.day, hour, minute);
    const today = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
    );
    if (target <= today) target += 86_400_000;
    return {
      resetAt: wallToUtc(target, zone),
      label: `额度报文：${zone} ${pad2(hour)}:${pad2(minute)} 恢复`,
      index: match.index,
    };
  }
  return undefined;
}

/** 通用 HTTP：`Retry-After: <秒>` 或 `retry-after: <HTTP 日期>`。读不懂就当没有时间。 */
function fromRetryAfter(text: string, now: Date): Timed | undefined {
  const match = RETRY_AFTER.exec(text);
  if (!match) return undefined;
  const value = match[1].trim();
  const label = `限流响应：Retry-After ${value.slice(0, 60)}`;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return undefined;
    return {
      resetAt: new Date(now.getTime() + seconds * 1000),
      label,
      index: match.index,
    };
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  return { resetAt: new Date(ts), label, index: match.index };
}

/** 取匹配所在的一行当证据，压掉换行并截断，别把整段日志塞进 reason。 */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  let end = text.indexOf("\n", index);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 160);
}

const withLine = (text: string, index: number, label: string) => {
  const line = lineAt(text, index);
  return line ? `${label}（${line}）` : label;
};

/**
 * 判定：退出码 0（正常结束）直接不判；其余看日志——像额度/限流（额度词或 429）才继续，
 * 恢复时间按「codex 分钟 → Claude 时刻 → Retry-After」的顺序取第一个能解析的。
 */
export function detectQuotaExhausted({
  exitCode,
  logTail,
  now,
  tool,
}: QuotaInput): QuotaVerdict {
  if (exitCode === 0) return { exhausted: false };
  const text = quotaErrorText(logTail);
  const marked = QUOTA_MARK.test(text);
  const http429 = HTTP_429.test(text);
  if (!marked && !http429) return { exhausted: false };
  const provider = ADAPTERS[tool].quotaProvider;
  const timed =
    fromMinutes(text, now) ??
    fromResetTime(text, now) ??
    fromRetryAfter(text, now);
  if (timed)
    return {
      exhausted: true,
      provider,
      resetAt: timed.resetAt,
      reason: withLine(text, timed.index, timed.label),
    };
  const index = QUOTA_MARK.exec(text)?.index ?? HTTP_429.exec(text)?.index ?? 0;
  return {
    exhausted: true,
    provider,
    resetAt: null,
    reason: withLine(
      text,
      index,
      http429
        ? "HTTP 429 限流，但没有解析出恢复时间"
        : "日志像是额度用尽，但没有解析出恢复时间",
    ),
  };
}
