import { parseEvents, type JsonEvent } from "../logs/json-log.ts";

/**
 * 供应商或网络临时错误（#262）：从执行者日志识别证书校验、连接重置、fetch failed、过载、5xx，
 * 任务不直接判失败，先同一执行者重试一次、再按档案换执行者重派一次。纯函数。
 * 与额度用尽（quota-signal.ts）、权限被拒与长度用尽（json-log.ts）分开判定：调用方先判那几种。
 */

export type TransientHit = {
  /** 任务事件与失败原因里用的简述：「供应商或网络临时错误：<类别>」。 */
  reason: string;
  /** 报文证据：出错事件的正文或日志原行，压成一行并截断。 */
  evidence: string;
};

export type TransientInput = {
  /** 退出码：0 不判（跑完了就按关卡收尾）；null（被信号结束或退出码未知）也不判。 */
  exitCode: number | null;
  logTail: string;
  /** 适配器是否输出结构化事件（opencode --format json、claude / agy stream-json）。 */
  json: boolean;
};

const MARKS: readonly [RegExp, string][] = [
  [
    /certificate verif|unable to (?:get|verify) (?:local issuer )?certificate|self[- ]signed certificate|\bCERT_[A-Z_]+\b|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
    "证书校验出错",
  ],
  [
    /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|AI_AGAIN|NOTFOUND|NETUNREACH|HOSTUNREACH)\b|socket hang up|connection (?:reset|refused)|stream disconnected|network error/i,
    "网络连接出错",
  ],
  [/fetch failed/i, "网络请求失败"],
  [/overloaded/i, "供应商过载"],
  [
    /\b(?:HTTP|status(?:\s*code)?|error\s*code)\s*[:=]?\s*5\d\d\b|\b5\d\d\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout/i,
    "供应商服务端错误（5xx）",
  ],
];

/** 文本日志只看最后这么多行非空行：更早的是执行者读到的文件、命令输出，里面也会有这些词。 */
const TAIL_LINES = 12;
const EVIDENCE_MAX = 200;

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonEvent)
    : undefined;

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > EVIDENCE_MAX ? `${line.slice(0, EVIDENCE_MAX)}…` : line;
};

function classify(text: string) {
  return MARKS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * 出错事件的正文：opencode `{type:"error",error:{name,data:{message}}}`；
 * claude stream-json `{type:"result",is_error:true,result}`；
 * agy stream-json `{event:"result",result:{status:"ERROR",error}}`。其他事件返回 undefined。
 */
export function errorText(event: JsonEvent): string | undefined {
  if (event.event === "result") {
    const result = object(event.result);
    if (!result || result.status === "SUCCESS") return undefined;
    const parts = [result.status, result.error].filter(
      (part): part is string => typeof part === "string" && !!part,
    );
    return parts.length ? parts.join(": ") : undefined;
  }
  if (event.type === "error") {
    const error = object(event.error);
    const parts = [
      error?.name,
      object(error?.data)?.message,
      error?.message,
      typeof event.error === "string" ? event.error : undefined,
      event.message,
    ].filter((part): part is string => typeof part === "string" && !!part);
    return parts.length ? parts.join(": ") : undefined;
  }
  if (event.type === "result" && event.is_error === true) {
    const parts = [event.subtype, event.result].filter(
      (part): part is string => typeof part === "string" && !!part,
    );
    return parts.length ? parts.join(": ") : undefined;
  }
  return undefined;
}

/** 最后一个出错事件；它不是临时错误、或之后有一轮成功（agy 的 SUCCESS result）就不再往前找（更早的错误执行者已经越过去了）。 */
function fromEvents(text: string): TransientHit | undefined {
  const events = parseEvents(text);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.event === "result" && object(event.result)?.status === "SUCCESS")
      return undefined;
    const body = errorText(event);
    if (body === undefined) continue;
    const kind = classify(body);
    return kind ? hit(kind, body) : undefined;
  }
  return undefined;
}

/** 日志末尾的非 JSON 行（结构化日志里是混进来的 stderr）。 */
function fromLines(text: string): TransientHit | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("{"))
    .slice(-TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const kind = classify(lines[i]!);
    if (kind) return hit(kind, lines[i]!);
  }
  return undefined;
}

const hit = (kind: string, evidence: string): TransientHit => ({
  reason: `供应商或网络临时错误：${kind}`,
  evidence: oneLine(evidence),
});

/** 非 0 退出时看日志：结构化日志先看出错事件，再看末尾的非 JSON 行；文本日志只看末尾几行。 */
export function detectTransient({
  exitCode,
  logTail,
  json,
}: TransientInput): TransientHit | undefined {
  if (exitCode === 0 || exitCode === null) return undefined;
  return (json ? fromEvents(logTail) : undefined) ?? fromLines(logTail);
}

export type TransientRoute =
  | { kind: "same"; attempt: number }
  | { kind: "switch"; attempt: number }
  | { kind: "fail"; why: string };

/**
 * 临时错误后的去向：这一轮派活里第一次 → 同一执行者重试；第二次 → 换一个执行者重派；
 * 再失败或档案关掉了（retry_on_transient: false）→ 失败，等人处理。
 */
export function routeAfterTransient(input: {
  allowed: boolean;
  attempts: number;
}): TransientRoute {
  if (!input.allowed)
    return { kind: "fail", why: "档案不允许临时错误后自动重试" };
  if (input.attempts === 0) return { kind: "same", attempt: 1 };
  if (input.attempts === 1) return { kind: "switch", attempt: 2 };
  return { kind: "fail", why: "临时错误已重试过同一执行者并换过执行者" };
}

export type EventLike = { kind: string; detail: string | null };

const startDetail = (event: EventLike) => {
  try {
    return object(object(JSON.parse(event.detail ?? "null"))?.detail);
  } catch {
    return undefined;
  }
};

/**
 * 这一轮派活里已因临时错误重试了几次：从最后一次非重试的拉起（人工或排队派活，start 事件不带 retry）
 * 往后数 transient_retry 事件；人工再派一次就重新计数。
 */
export function transientAttempts(events: readonly EventLike[]): number {
  return retryAttempts(events, "transient_retry");
}

/** 同上，数的是指定种类的重派事件（思考耗尽后的 thinking_retry 也按这个数）。 */
export function retryAttempts(
  events: readonly EventLike[],
  kind: string,
): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === kind) count++;
    else if (event.kind === "start" && !startDetail(event)?.retry) break;
  }
  return count;
}
