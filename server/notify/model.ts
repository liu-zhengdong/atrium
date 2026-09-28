import { Problem } from "../problem.ts";
import type { Offset } from "../schedules/plan.ts";
import { oneLine } from "../text-width.ts";

/**
 * 推送到手机（Telegram）的判定：哪些事件要推、推什么字、什么时候发、失败怎么重试、走哪个代理、
 * 设置怎么校验。全是纯函数、穷举测试；凭据文件在 store.ts，发请求在 telegram.ts，调度在 runtime.ts。
 *
 * 只推三类事：选项单等你拍板、上交到用户这层的卡住／越界（含运行时到期代为上交的，overdue.ts）、里程碑上线；
 * 另加秘书没在听、后台又叫不起来时要处理的事没人管（t242）。都照常攒批、守免打扰。
 * 推送只放标题和短号，不放正文（上交说明、选项内容都不带）。
 * 选项单单独成一条「卡片」，带按钮在手机上拍板（选项号 + 选项标题、拍板、都不选），回复卡片附一句说明。
 */

export type PushKind = "choice" | "stuck" | "beyond" | "shipped" | "away";

export const PUSH_LABEL: Record<PushKind, string> = {
  choice: "等你拍板",
  stuck: "卡住了",
  beyond: "越界要你定",
  shipped: "里程碑上线",
  away: "秘书没在听",
};

export type Push = {
  /** 去重键：同一条事件只推一次。 */
  key: string;
  kind: PushKind;
  /** 短号：c2、t171、a3；秘书没在听不挂短号，为空串。 */
  ref: string;
  /** 标题（已压成一行、截短）；没有为空串。 */
  title: string;
};

/** 投给秘书（用户这一层）的事件，只取判定用得到的字段。 */
export type PushEvent = {
  id: number;
  subscriber: string;
  kind: string;
  task: string | null;
  actor: string | null;
  detail: unknown;
};

export const TITLE_MAX = 40;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * 这条事件要不要推、推成什么。只看投给秘书的（上交到用户这层）；taskTitle 由调用方查库给。
 * 过程事件（完成、失败、合入、CI……）一律不推。
 */
export function pushOf(
  event: PushEvent,
  secretary: string,
  taskTitle: (ref: string) => string | null,
): Push | null {
  if (event.subscriber !== secretary) return null;
  const detail = record(event.detail);
  const key = `event:${event.id}`;
  const titled = (kind: PushKind, ref: string, title: string): Push => ({
    key,
    kind,
    ref,
    title: oneLine(title, TITLE_MAX),
  });
  if (event.kind === "choice_ready") {
    const ref = text(detail.choice);
    if (!/^c[1-9]\d*$/.test(ref)) return null;
    return titled("choice", ref, text(detail.title));
  }
  // 运行时到期代为上交到用户这层（overdue.ts 的 escalate）：按卡住推。
  if (event.kind === "overdue")
    return detail.step === "escalate" && event.task
      ? titled("stuck", event.task, text(detail.title))
      : null;
  if (event.kind !== "escalated") return null;
  const kind = text(detail.kind);
  if (kind !== "stuck" && kind !== "beyond" && kind !== "shipped") return null;
  const task = text(detail.task) || event.task || "";
  if (/^t[1-9]\d*$/.test(task))
    return titled(kind, task, taskTitle(task) ?? "");
  // 没挂任务的上交：短号用上交的 leader（aN）。
  const from = text(detail.from) || event.actor || "";
  if (!/^a[1-9]\d*$/.test(from)) return null;
  return titled(kind, from, "");
}

/** 秘书没在听、后台叫不起来（t242）：只说几件没人管，不带事件内容。 */
export function awayPush(input: {
  key: string;
  pending: number;
  reason: string;
}): Push {
  return {
    key: input.key,
    kind: "away",
    ref: "",
    title: oneLine(
      `${input.pending} 件要处理的事没人管，${input.reason}`,
      TITLE_MAX * 2,
    ),
  };
}

/** 一条消息最多列几件，余下的写「还有 N 件」。 */
export const MESSAGE_ITEMS = 15;

/** 攒成一条消息：第一行说几件事，每件一行「【类别】短号 标题」。 */
export function messageText(items: readonly Omit<Push, "key">[]): string {
  const shown = items.slice(0, MESSAGE_ITEMS);
  const lines = shown.map(
    (item) =>
      `【${PUSH_LABEL[item.kind]}】${[item.ref, item.title].filter(Boolean).join(" ")}`,
  );
  const rest = items.length - shown.length;
  return [
    items.length === 1 ? "Atrium：1 件事" : `Atrium：${items.length} 件事`,
    ...lines,
    ...(rest > 0 ? [`还有 ${rest} 件，atrium top 查看`] : []),
  ].join("\n");
}

// ---- 在 Telegram 里拍板选项单 ----

/** 卡片上用得到的选项单字段（只有标题和选项标题，不带选项正文）。 */
export type CardChoice = {
  ref: string;
  title: string;
  status: "open" | "picked" | "passed";
  options: readonly { seq: number; title: string; task: string | null }[];
};

/** 草稿：点过的选项和回复的说明，拍板时一起带上。 */
export type CardDraft = { picks: readonly number[]; note: string | null };

export const BUTTON_TITLE_MAX = 28;
const NOTE_SHOWN = 60;

export type Button = { text: string; callback_data: string };

const choiceId = (ref: string) => ref.slice(1);

/**
 * 卡片的按钮：每个选项一行（点过的前面打勾），最后一行「拍板」「都不选」。
 * 回调数据 c:<选项单号>:<选项号|ok|no>，不超过 Telegram 的 64 字节。
 */
export function cardKeyboard(choice: CardChoice, draft: CardDraft): Button[][] {
  const id = choiceId(choice.ref);
  const picked = [...draft.picks].sort((a, b) => a - b);
  return [
    ...choice.options.map((o) => [
      {
        text: `${picked.includes(o.seq) ? "✅ " : ""}${o.seq}. ${oneLine(o.title, BUTTON_TITLE_MAX)}`,
        callback_data: `c:${id}:${o.seq}`,
      },
    ]),
    [
      {
        text: picked.length ? `拍板（选 ${picked.join("、")}）` : "拍板",
        callback_data: `c:${id}:ok`,
      },
      { text: "都不选", callback_data: `c:${id}:no` },
    ],
  ];
}

/** 等拍板的卡片文字：类别、短号、标题，怎么操作，看全文去哪；不放选项正文。 */
export function cardText(choice: CardChoice, draft: CardDraft): string {
  return [
    `【${PUSH_LABEL.choice}】${choice.ref} ${oneLine(choice.title, TITLE_MAX)}`.trimEnd(),
    "点要做的选项（可多选），再点「拍板」；这轮都不要点「都不选」。",
    draft.note
      ? `说明：${oneLine(draft.note, NOTE_SHOWN)}（再回复一条可改）`
      : "回复这条消息写一句说明，拍板时一起带上。",
    `全文：电脑上 atrium choice show ${choice.ref}，或 atrium map 打开全景网页`,
  ].join("\n");
}

/** 拍过板的卡片文字（按钮撤掉）：选了哪些、建了哪些任务，或这轮都不要。 */
export function decidedCardText(choice: CardChoice, note: string | null) {
  const picked = choice.options.filter((o) => o.task !== null);
  return [
    `【已拍板】${choice.ref} ${oneLine(choice.title, TITLE_MAX)}`.trimEnd(),
    choice.status === "picked"
      ? `选了 ${picked.map((o) => o.seq).join("、")}，建了 ${picked.map((o) => o.task).join("、")}`
      : "这轮都不要",
    ...(note ? [`说明：${oneLine(note, NOTE_SHOWN)}`] : []),
  ].join("\n");
}

export type CardAction =
  | { kind: "toggle"; choice: string; seq: number }
  | { kind: "pick"; choice: string }
  | { kind: "pass"; choice: string };

/** 按钮的回调数据 → 动作；不是卡片按钮的（伪造、别的版本）为 null。 */
export function parseCallback(data: unknown): CardAction | null {
  const match =
    typeof data === "string"
      ? /^c:([1-9]\d{0,15}):([1-9]\d?|ok|no)$/.exec(data)
      : null;
  if (!match) return null;
  const choice = `c${match[1]}`;
  if (match[2] === "ok") return { kind: "pick", choice };
  if (match[2] === "no") return { kind: "pass", choice };
  return { kind: "toggle", choice, seq: Number(match[2]) };
}

/** 点一下选项：没选的选上、选了的取消，结果从小到大。 */
export function togglePick(picks: readonly number[], seq: number): number[] {
  return picks.includes(seq)
    ? picks.filter((n) => n !== seq)
    : [...picks, seq].sort((a, b) => a - b);
}

/** 收到的更新里判定用得到的字段。 */
export type Incoming = {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number };
    reply_to_message?: { message_id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
  };
};

/**
 * 更新从哪来：只认绑定的那个私聊（聊天 id 与发送人都是它）；其他来源一律忽略。
 * 返回 bound（可以处理）、foreign（别人发的，记日志）、skip（与操作无关的更新，如频道、编辑）。
 */
export function sourceOf(
  update: Incoming,
  chat: number,
): { kind: "bound" | "skip" } | { kind: "foreign"; chat: number | null } {
  const query = update.callback_query;
  if (query) {
    const from = query.from?.id;
    const at = query.message?.chat?.id;
    return from === chat && at === chat
      ? { kind: "bound" }
      : { kind: "foreign", chat: typeof at === "number" ? at : (from ?? null) };
  }
  const message = update.message;
  if (!message) return { kind: "skip" };
  const at = message.chat?.id;
  if (
    at === chat &&
    message.chat?.type === "private" &&
    message.from?.id === chat
  )
    return { kind: "bound" };
  return { kind: "foreign", chat: typeof at === "number" ? at : null };
}

/**
 * 一句回复附给哪份选项单：回复了某张卡片就是那份；回复了别的消息（含已拍板撤掉的卡片）不猜；
 * 没用回复时只有一份等拍板的卡片才归它，多份让用户用回复指明，没有就说没有。
 * reply：没回复为 null，回复了卡片为 { card: 选项单 }，回复了别的为 { card: null }。
 */
export function noteTarget(
  reply: { card: string | null } | null,
  open: readonly string[],
):
  | { kind: "choice"; choice: string }
  | { kind: "not_card" }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" } {
  if (reply)
    return reply.card
      ? { kind: "choice", choice: reply.card }
      : { kind: "not_card" };
  if (open.length === 1) return { kind: "choice", choice: open[0]! };
  return open.length
    ? { kind: "ambiguous", count: open.length }
    : { kind: "none" };
}

/** 回给用户的话：说明记在哪、为什么没记。 */
export function noteReply(
  target: ReturnType<typeof noteTarget>,
): string | null {
  if (target.kind === "choice") return null;
  if (target.kind === "not_card")
    return "这条不是等你拍板的卡片（或已经拍过板），说明没记下；回复要附说明的那张卡片。";
  if (target.kind === "ambiguous")
    return `有 ${target.count} 份等你拍板，说明没记下；回复要附说明的那张卡片。`;
  return "现在没有等你拍板的选项单，说明没记下。";
}

/** 发来的不是说明（命令、贴图等）时回的提示。 */
export const CHAT_HELP =
  "这里只收拍板：在「等你拍板」的卡片上点选项再点「拍板」，或点「都不选」；回复卡片写一句说明。看全文用电脑上的 atrium。";

// ---- 免打扰与攒批 ----

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** 免打扰时段，本机钟点的分钟数；start > end 表示跨午夜。 */
export type Quiet = { start: number; end: number };

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseQuiet(value: unknown): Quiet | null {
  if (value === null || value === "" || value === "off" || value === "none")
    return null;
  const parts = typeof value === "string" ? value.trim().split("-") : [];
  const [a, b] = parts.map((part) => CLOCK.exec(part.trim()));
  if (parts.length !== 2 || !a || !b)
    throw usage(
      "--quiet: 免打扰时段应为 23:00-08:00 这样的「开始-结束」钟点，关掉写 off",
    );
  const start = Number(a[1]) * 60 + Number(a[2]);
  const end = Number(b[1]) * 60 + Number(b[2]);
  if (start === end) throw usage("--quiet: 开始和结束不能是同一时刻");
  return { start, end };
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const quietText = (quiet: Quiet | null) =>
  quiet ? `${clock(quiet.start)}-${clock(quiet.end)}` : "off";

/** 本机钟点（从当天零点起的分钟）。 */
const minuteOfDay = (ms: number, offset: Offset) =>
  Math.floor(((((ms + offset(ms) * MINUTE) % DAY) + DAY) % DAY) / MINUTE);

export function inQuiet(ms: number, quiet: Quiet | null, offset: Offset) {
  if (!quiet) return false;
  const m = minuteOfDay(ms, offset);
  return quiet.start < quiet.end
    ? m >= quiet.start && m < quiet.end
    : m >= quiet.start || m < quiet.end;
}

/** 在免打扰时段里时，时段结束的时刻；不在时段里原样返回。 */
export function quietEnd(ms: number, quiet: Quiet | null, offset: Offset) {
  if (!inQuiet(ms, quiet, offset)) return ms;
  const m = minuteOfDay(ms, offset);
  const wait = (((quiet!.end - m) % 1440) + 1440) % 1440;
  // 对齐到整分钟：从当前分钟的开头起算。
  const start = ms - (ms % MINUTE);
  let at = start + wait * MINUTE;
  // 夏令时切换当天可能差一小时，往后挪到真正出了时段为止（最多两小时）。
  for (let i = 0; i < 120 && inQuiet(at, quiet, offset); i++) at += MINUTE;
  return at;
}

/**
 * 这一批什么时候发：最早一条排队后等满攒批窗口；落在免打扰时段就推到时段结束；
 * 上次失败了还要等到重试时刻。
 */
export function sendAt(input: {
  oldest: number;
  batchMs: number;
  quiet: Quiet | null;
  offset: Offset;
  retryAt: number | null;
}) {
  const ready = Math.max(input.oldest + input.batchMs, input.retryAt ?? 0);
  return quietEnd(ready, input.quiet, input.offset);
}

// ---- 失败重试 ----

export const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * MINUTE;

export type SendFailure = {
  /** Telegram 回的 HTTP 状态；网络不通、超时为 null。 */
  status: number | null;
  /** 429 时 Telegram 给的等待秒数。 */
  retryAfter?: number;
  message: string;
};

export type AfterFailure =
  | { kind: "retry"; attempts: number; at: number }
  | { kind: "give_up"; attempts: number };

/**
 * 发送失败后：凭据或会话错了（400/401/403/404）重试也没用，直接放弃；
 * 其余（网络、超时、429、5xx）按 30 秒起翻倍退避、封顶 30 分钟，满 5 次放弃。
 */
export function afterFailure(
  failure: SendFailure,
  attempts: number,
  now: number,
): AfterFailure {
  const next = attempts + 1;
  const permanent =
    failure.status !== null &&
    failure.status !== 429 &&
    failure.status >= 400 &&
    failure.status < 500;
  if (permanent || next >= MAX_ATTEMPTS)
    return { kind: "give_up", attempts: next };
  const backoff = Math.min(RETRY_BASE_MS * 2 ** (next - 1), RETRY_MAX_MS);
  const asked =
    failure.retryAfter && failure.retryAfter > 0
      ? Math.min(failure.retryAfter * 1000, RETRY_MAX_MS)
      : 0;
  return { kind: "retry", attempts: next, at: now + Math.max(backoff, asked) };
}

// ---- 代理 ----

/** 目标地址该走哪个代理：Atrium 配置里单独配的优先，其次系统代理（按目标协议取），NO_PROXY 命中的直连。 */
export function proxyFor(
  target: URL,
  configured: string | null,
  env: Record<string, string | undefined>,
): URL | null {
  if (configured) return new URL(configured);
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const raw =
    target.protocol === "https:"
      ? pick("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")
      : pick("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY");
  if (!raw || bypassed(target, pick("no_proxy", "NO_PROXY") ?? "")) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  // 只会走 HTTP CONNECT 代理；socks 之类的系统代理当没配，由调用方提示改用 --proxy。
  return url.protocol === "http:" ? url : null;
}

/** NO_PROXY：逗号或空格分隔，* 全部直连，.example.com / example.com 匹配域名及子域，可带端口。 */
export function bypassed(target: URL, noProxy: string) {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const [name, only] = entry.toLowerCase().split(/:(?=\d+$)/);
      if (only && only !== port) return false;
      const domain = name!.replace(/^\*?\./, "");
      return host === domain || host.endsWith(`.${domain}`);
    });
}

/** --proxy：只接受 http:// 代理（本机 Clash 之类的 HTTP 端口）；off 清掉，回到系统代理。 */
export function parseProxy(value: unknown): string | null {
  if (value === null || value === "" || value === "off" || value === "none")
    return null;
  let url: URL | null = null;
  try {
    url = typeof value === "string" ? new URL(value.trim()) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "http:" || !url.hostname)
    throw usage(
      "--proxy: 应为 http://主机:端口 形式的 HTTP 代理（如 http://127.0.0.1:7890），不用单独代理写 off",
    );
  if (url.pathname !== "/" || url.search || url.hash)
    throw usage("--proxy: 只写 http://主机:端口，不带路径");
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
    : "";
  return `http://${auth}${url.host}`;
}

/** 展示代理时抹掉用户名密码。 */
export function proxyText(proxy: string | null) {
  if (!proxy) return null;
  try {
    const url = new URL(proxy);
    return url.username ? `http://***@${url.host}` : url.origin;
  } catch {
    return "***";
  }
}

// ---- 设置与凭据 ----

export const BATCH_DEFAULT_SECONDS = 60;
export const BATCH_MAX_SECONDS = 3600;

export function parseBatch(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > BATCH_MAX_SECONDS)
    throw usage(
      `--batch: 攒批窗口应为 0～${BATCH_MAX_SECONDS} 的整数秒（0 表示到了就发）`,
    );
  return Number(raw);
}

export type Settings = {
  enabled: boolean;
  quiet: Quiet | null;
  batch_seconds: number;
  proxy: string | null;
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  quiet: null,
  batch_seconds: BATCH_DEFAULT_SECONDS,
  proxy: null,
};

/** 改设置的请求体：只改给了的字段。 */
export function settingsPatch(body: unknown): Partial<Settings> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  const input = body as Record<string, unknown>;
  const names: Record<string, string> = {
    enabled: "--on/--off",
    quiet: "--quiet",
    batch_seconds: "--batch",
    proxy: "--proxy",
  };
  for (const key of Object.keys(input))
    if (!(key in names)) throw usage(`${key}: 是未知字段`);
  const patch: Partial<Settings> = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw usage("--on/--off: 应为开或关");
    patch.enabled = input.enabled;
  }
  if (input.quiet !== undefined) patch.quiet = parseQuiet(input.quiet);
  if (input.batch_seconds !== undefined)
    patch.batch_seconds = parseBatch(input.batch_seconds);
  if (input.proxy !== undefined) patch.proxy = parseProxy(input.proxy);
  if (!Object.keys(patch).length)
    throw usage(
      "至少给一项：--quiet 23:00-08:00、--batch 秒、--proxy http://主机:端口、--on 或 --off",
      "atrium notify set --quiet 23:00-08:00",
    );
  return patch;
}

const TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{30,80}$/;

/** bot token 的格式（@BotFather 给的「数字:字母串」）；报错不回显内容。 */
export function parseToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token)
    throw usage(
      "标准输入是空的：把 @BotFather 给的 bot token 从管道传进来，如 pbpaste | atrium notify --token",
    );
  if (!TOKEN.test(token))
    throw usage(
      "标准输入不像 bot token（应为 @BotFather 给的「数字:字母串」，只放这一行）",
    );
  return token;
}

/** 绑定码有效期。 */
export const BIND_TTL_MS = 30 * MINUTE;

/** 用户发给机器人的消息里有没有这次的绑定码（深链是「/start 码」，手打也行）。 */
export function bindMatch(message: string, code: string) {
  return message
    .trim()
    .split(/\s+/)
    .some((word) => word === code);
}

// ---- 脱敏 ----

const TOKEN_ANYWHERE = /(?<!\d)\d{5,20}:[A-Za-z0-9_-]{30,}/g;

/** 抹掉文本里的 bot token（请求 URL 里带着 /bot<token>/），写日志、回错误前都要过一遍。 */
export function scrub(message: string, token?: string | null) {
  let out = token ? message.split(token).join("***") : message;
  out = out.replace(TOKEN_ANYWHERE, "***");
  return out.replace(/\/bot[^/\s]+\//g, "/bot***/");
}

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);
