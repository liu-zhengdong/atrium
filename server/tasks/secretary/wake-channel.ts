import type { InboxEvent } from "../events/events.ts";

/** 工具适配器接入点；本步只定义契约，不绑定 ACP、TUI 或恢复会话。 */
export type WakeDelivery = {
  subscriber: string;
  events: readonly InboxEvent[];
  /** 首次为 1；失败后以相同事件和递增次数重试。 */
  attempt: number;
};

export type WakeDeliveryResult =
  | { status: "delivered" }
  | {
      status: "failed";
      reason: string;
      /** null 表示不可重试；否则运行时在该延迟后再次调用 deliver。 */
      retryAfterMs: number | null;
    };

export interface WakeChannel {
  /** 送入会话成功只代表送达；秘书处理后仍须单独确认事件。 */
  deliver(input: WakeDelivery): Promise<WakeDeliveryResult>;
}
