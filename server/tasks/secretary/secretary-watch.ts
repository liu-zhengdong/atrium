import { DUE } from "../watch/overdue.ts";

/**
 * 秘书在不在听、没人听时后台叫醒（t242）：纯函数，命令行静态引入，不引重模块。
 * 服务按 EventInbox.presence 记谁挂着 `events wait`；后台兜底（secretary-fallback.ts）按 watchDecision 行事，
 * 状态栏与 top 按 secretaryText 显示。时限是 overdue.ts 表里秘书那一行：到期后台叫醒，叫不起来推给用户。
 */

/** 没有秘书在听、要处理的事件又摆了这么久，就在后台叫醒一次秘书。 */
export const UNATTENDED_MS = DUE.secretary.ms;

export type Presence = {
  /** 此刻有连接挂着 wait（秘书会话、atrium chat 界面）。 */
  waiting: boolean;
  /** 最近一次在听的时刻；服务重启后还没人来的，从服务起来算。 */
  last_seen: number;
};

export type WatchInput = {
  now: number;
  presence: Presence;
  /** 最早一条未处理「要处理」事件的入队时刻；没有为 null。 */
  oldest: number | null;
  graceMs: number;
  /** 有能在后台接着的秘书会话（atrium chat 开过的 opencode / codex）。 */
  session: boolean;
  /** 后台连续叫醒已到上限（中间没有用户自己发起的一轮）。 */
  limit: boolean;
  /** 上次后台叫醒没成功时，下次再试的时刻；没失败过为 null。 */
  retryAt: number | null;
};

export type WatchDecision =
  | { kind: "quiet" }
  | { kind: "listening" }
  | { kind: "wait"; at: number }
  | { kind: "wake" }
  | { kind: "unreachable"; reason: string };

export const NO_SESSION =
  "没有能在后台接着的秘书会话（用 atrium chat 开过 opencode 或 codex 秘书才有）";
export const WAKE_FAILED = "后台叫醒秘书没成功";

/**
 * 有要处理的事件、没有秘书在听，且从「最后一次在听」和「最早一条事件入队」两者较晚的那刻起
 * 满 graceMs，才叫醒；叫不起来（没会话、连续叫醒到上限、上次失败还没到重试时刻）给出原因。
 */
export function watchDecision(input: WatchInput): WatchDecision {
  if (input.oldest === null) return { kind: "quiet" };
  if (input.presence.waiting) return { kind: "listening" };
  const due = Math.max(input.presence.last_seen, input.oldest) + input.graceMs;
  if (input.now < due) return { kind: "wait", at: due };
  if (!input.session) return { kind: "unreachable", reason: NO_SESSION };
  if (input.limit)
    return {
      kind: "unreachable",
      reason: "后台已连续叫醒秘书多次，等你回来开一轮",
    };
  if (input.retryAt !== null && input.now < input.retryAt)
    return { kind: "unreachable", reason: WAKE_FAILED };
  return { kind: "wake" };
}

/** top / 状态栏里的秘书状态（服务算好给出）。 */
export type SecretaryView = {
  listening: boolean;
  /** 没在听多久（毫秒）；在听为 null。 */
  away_ms: number | null;
  /** 未处理的要处理事件条数。 */
  pending: number;
  /** 后台正叫醒秘书处理。 */
  waking: boolean;
  /** 有要处理的事件没人听已满时限（该叫醒了）。 */
  overdue: boolean;
  /** 叫不起来的原因；没有为 null。 */
  unreachable: string | null;
};

export function secretaryView(input: {
  now: number;
  presence: Presence;
  pending: number;
  oldest: number | null;
  graceMs: number;
  waking: boolean;
  unreachable: string | null;
}): SecretaryView {
  const listening = input.presence.waiting;
  return {
    listening,
    away_ms: listening
      ? null
      : Math.max(0, input.now - input.presence.last_seen),
    pending: input.pending,
    waking: input.waking,
    overdue:
      !listening &&
      input.pending > 0 &&
      input.oldest !== null &&
      input.now >=
        Math.max(input.presence.last_seen, input.oldest) + input.graceMs,
    unreachable: input.unreachable,
  };
}

export type SecretaryTone = "ok" | "warn" | "alarm";

/**
 * 一句话：「秘书在听」／「秘书没在听 N 分钟 · 未处理 M」，后台处理中与叫不起来另说。
 * 语气：在听或没事为 ok；有事没人听为 warn；没人管已满时限或叫不起来为 alarm（标红）。
 */
export function secretaryText(view: SecretaryView): {
  text: string;
  tone: SecretaryTone;
} {
  const pending = view.pending ? ` · 未处理 ${view.pending}` : "";
  if (view.waking) return { text: `秘书后台处理中${pending}`, tone: "ok" };
  if (view.listening) return { text: `秘书在听${pending}`, tone: "ok" };
  const minutes = Math.floor((view.away_ms ?? 0) / 60_000);
  const away = `秘书没在听${minutes ? ` ${minutes} 分钟` : ""}`;
  if (!view.pending) return { text: away, tone: "ok" };
  if (view.unreachable)
    return {
      text: `${away}${pending} · 叫不起来：${view.unreachable}`,
      tone: "alarm",
    };
  return { text: `${away}${pending}`, tone: view.overdue ? "alarm" : "warn" };
}
