import type { FailureRetry, Overview } from "../../shared/schema.ts";
import { time } from "../time.ts";

type Failure = NonNullable<Overview["agents"][number]["failure"]>;

/** 读身份上的重试快照；中间版本可能还没有这个字段。 */
export function retryOf(agent: {
  failure: Failure | null;
}): FailureRetry | null {
  return agent.failure?.retry ?? null;
}

/**
 * 出错后的一行状态：名册、详情抽屉、私聊顶部共用同一句（文案见 review-step0-2.md）。
 * 没有重试快照时返回 null，调用处保持原来的错误摘要。
 */
export function retryStateText(retry: FailureRetry | null): string | null {
  if (!retry) return null;
  switch (retry.state) {
    case "waiting":
      return `出错 · ${time(retry.next_at)} 自动重试（第 ${retry.attempt}/${retry.max} 次）`;
    case "running":
      return `出错 · 正在自动重试（第 ${retry.attempt}/${retry.max} 次）`;
    case "exhausted":
      return `出错 · 已自动重试 ${retry.max} 次，需要处理`;
    case "needs_action":
      return "出错 · 需要处理";
  }
}
