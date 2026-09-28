import type { InboxEvent } from "../events/events.ts";

/**
 * `atrium secretary bridge` 的判定（t243）：纯函数，IO 在 `cli/secretary-bridge.ts`。
 * bridge 挂 `events wait` 取秘书要处理的事件（取走有租约，没确认的到期重投），送进 Claude Code 会话；
 * 同一事件（编号 + 更新时刻）送过就不再送，送过满 remindMs 仍没确认、又被重投回来的再提醒一次。
 */

/** 缺省：送过 30 分钟还没确认的再提醒一次。 */
export const REMIND_MS = 30 * 60_000;
/** 向服务报「在听」的间隔与有效期：有效期内没再报就算不在听。 */
export const LISTEN_EVERY_MS = 30_000;
export const LISTEN_TTL_SECONDS = 90;
/** 报「在听」时写的来源。 */
export const BRIDGE_VIA = "claude-code 会话，经注入";
/** 送过的记录上限：超出丢最早的（被丢的再回来按新事件送一次）。 */
export const SENT_LIMIT = 1000;

/** 送过的事件：编号 → 送出时的更新时刻与送出时刻。 */
export type Sent = Map<number, { updated_at: number; sent_at: number }>;

export type BridgeBatch = {
  /** 第一次送的（新事件，或合并了新发生的）。 */
  fresh: InboxEvent[];
  /** 送过满 remindMs 还没确认的。 */
  remind: InboxEvent[];
};

/** 这批取到的事件里哪些要送、哪些是再提醒；送过又不到时候的略过（取走即续租，不会马上再回来）。 */
export function planBatch(
  sent: Sent,
  events: readonly InboxEvent[],
  now: number,
  remindMs = REMIND_MS,
): BridgeBatch {
  const fresh: InboxEvent[] = [];
  const remind: InboxEvent[] = [];
  for (const event of events) {
    if (event.acked_at !== null) continue;
    const before = sent.get(event.id);
    if (!before || before.updated_at !== event.updated_at) fresh.push(event);
    else if (now - before.sent_at >= remindMs) remind.push(event);
  }
  return { fresh, remind };
}

/** 送进会话后记下；超过上限丢最早送的。 */
export function recordSent(
  sent: Sent,
  events: readonly InboxEvent[],
  now: number,
  limit = SENT_LIMIT,
) {
  for (const event of events) {
    sent.delete(event.id);
    sent.set(event.id, { updated_at: event.updated_at, sent_at: now });
  }
  for (const id of sent.keys()) {
    if (sent.size <= limit) break;
    sent.delete(id);
  }
}

const detailOf = (event: InboxEvent) =>
  (event.detail ?? {}) as Record<string, unknown>;

/** 一行摘要：#编号 任务 类型 标题（合并次数）· 原因，按字符截断。 */
export function bridgeLine(event: InboxEvent): string {
  const detail = detailOf(event);
  const text = (key: string, max: number) =>
    typeof detail[key] === "string"
      ? (detail[key] as string).split("\n", 1)[0]!.slice(0, max)
      : "";
  const reason = text("message", 160) || text("reason", 160);
  return [
    `#${event.id}`,
    event.task ?? "",
    event.kind,
    text("title", 40),
    event.count > 1 ? `（合并 ${event.count} 次）` : "",
    text("pr_url", 200),
    reason ? `· ${reason}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * 送进会话的一条消息：以「【Atrium 事件】」开头，逐条一行摘要，末尾写看详情与处理完怎么确认。
 * 再提醒的单列一段，写明送过多久了。
 */
export function bridgePrompt(batch: BridgeBatch, remindMs = REMIND_MS) {
  const all = [...batch.fresh, ...batch.remind];
  const ids = all.map((event) => event.id);
  const tasks = [
    ...new Set(all.flatMap((event) => (event.task ? [event.task] : []))),
  ];
  const minutes = Math.round(remindMs / 60_000);
  return [
    batch.fresh.length
      ? `【Atrium 事件】${batch.fresh.length} 条要处理的事件（编号 ${batch.fresh.map((event) => event.id).join("、")}）：`
      : `【Atrium 事件】提醒：${batch.remind.length} 条事件送过 ${minutes} 分钟还没确认：`,
    ...batch.fresh.map((event) => `- ${bridgeLine(event)}`),
    ...(batch.fresh.length && batch.remind.length
      ? [`送过 ${minutes} 分钟还没确认：`]
      : []),
    ...batch.remind.map((event) => `- ${bridgeLine(event)}`),
    "",
    tasks.length
      ? `看详情：${tasks.map((task) => `atrium task show ${task}`).join("；")}；全部：atrium events`
      : "看详情：atrium events",
    `处理完确认：atrium events ack ${ids.join(" ")}`,
  ].join("\n");
}

/** 收件 socket 的两行：先认证，再一条用户消息（JSON 各占一行）。 */
export function inboxLines(token: string, text: string): [string, string] {
  return [
    JSON.stringify({ type: "auth", token }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    }),
  ];
}

/** 数据目录里登记的 bridge（`secretary/bridge.json`）：同一时刻只有一个 bridge 往秘书会话送。 */
export type BridgeRecord = { pid: number; socket: string; started_at: number };

/**
 * 起 bridge 前看登记：同一会话的已在跑就不再起；别的会话的还在跑，新会话接手
 * （旧的在下一轮看到登记换了人就退出）；没有或已退出就直接起。
 */
export function bridgeClaim(
  current: BridgeRecord | null,
  socket: string,
  alive: (pid: number) => boolean,
): "running" | "takeover" | "start" {
  if (!current || !alive(current.pid)) return "start";
  return current.socket === socket ? "running" : "takeover";
}

/** 从文件内容读登记；坏的当没有。 */
export function parseBridgeRecord(text: string | null): BridgeRecord | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<BridgeRecord>;
    return Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.socket === "string" &&
      typeof value.started_at === "number"
      ? (value as BridgeRecord)
      : null;
  } catch {
    return null;
  }
}
