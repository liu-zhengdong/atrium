import type { ExitDecision, Stop } from "./outcome.ts";
import { retryAttempts, type EventLike } from "./transient.ts";

/**
 * 思考耗尽单次输出后的去向（#262）：纯函数。模型一轮里把单次输出全用在思考上、正文为 0，
 * 同一执行者重跑多半还是这样，所以直接换一个执行者重跑一次；再耗尽或换过去仍没交付就留在受阻。
 */

export type ThinkingRoute =
  { kind: "none" } | { kind: "switch" } | { kind: "give_up"; why: string };

export function routeAfterThinking(input: {
  /** 最后一步是思考耗尽单次输出（json-log.ts）。 */
  thinking: boolean;
  stop?: Stop;
  decision: ExitDecision;
  /** 这一轮派活里已因思考耗尽换过几次执行者。 */
  attempts: number;
}): ThinkingRoute {
  const { decision } = input;
  if (!input.thinking || input.stop) return { kind: "none" };
  // 关卡过了：交付已在，最后一步耗尽不影响。
  if (decision.publish === "done") return { kind: "none" };
  if (input.attempts >= 1)
    return { kind: "give_up", why: "思考耗尽后已换过一次执行者" };
  return { kind: "switch" };
}

export const thinkingAttempts = (events: readonly EventLike[]) =>
  retryAttempts(events, "thinking_retry");
