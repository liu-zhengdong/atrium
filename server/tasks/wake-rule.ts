/** 秘书唤醒判定。调用方只传尚未确认且需要送入会话的事件。 */
export type WakeEvent = { id: number; queuedAt: number };

export type WakeInput = {
  events: readonly WakeEvent[];
  now: number;
  batchMs: number;
  /** 会话可接收消息，且当前一轮已经结束，才算空闲。 */
  sessionReady: boolean;
  turnRunning: boolean;
  /** 自上次用户主动发起一轮以来，成功送入秘书会话的次数。 */
  consecutiveWakeups: number;
  maxConsecutiveWakeups: number;
};

export type WakeDecision =
  | { kind: "empty" }
  | { kind: "batching"; readyAt: number }
  | { kind: "unavailable" }
  | { kind: "busy" }
  | { kind: "limit" }
  | { kind: "send"; eventIds: number[] };

/** 攒批窗口从最早一条待送事件起算；忙时继续攒，空闲后一次送入。 */
export function decideWake(input: WakeInput): WakeDecision {
  if (!input.events.length) return { kind: "empty" };
  const readyAt =
    input.events.reduce(
      (earliest, event) => Math.min(earliest, event.queuedAt),
      Number.POSITIVE_INFINITY,
    ) + input.batchMs;
  if (input.now < readyAt) return { kind: "batching", readyAt };
  if (!input.sessionReady) return { kind: "unavailable" };
  if (input.turnRunning) return { kind: "busy" };
  if (input.consecutiveWakeups >= input.maxConsecutiveWakeups)
    return { kind: "limit" };
  return {
    kind: "send",
    eventIds: [...new Set(input.events.map((event) => event.id))].sort(
      (a, b) => a - b,
    ),
  };
}

/** 失败与重试不耗连续唤醒次数；用户主动发起新一轮时清零。 */
export function nextWakeCount(
  count: number,
  action: "delivered" | "failed" | "user_turn",
): number {
  if (action === "user_turn") return 0;
  return action === "delivered" ? count + 1 : count;
}
