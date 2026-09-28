import { setTimeout as delay } from "node:timers/promises";
import type { InboxEvent } from "../server/tasks/events/events.ts";
import {
  decideWake,
  nextWakeCount,
} from "../server/tasks/secretary/wake-rule.ts";
import type { OpencodeMessage } from "./opencode-serve.ts";
import {
  DEFAULT_BATCH_MS,
  DEFAULT_MAX_WAKEUPS,
  PEEK_SECONDS,
  wakePrompt,
  type EventSource,
} from "./secretary-chat.ts";

/**
 * opencode 原生界面的秘书会话（#307 第 3 步）：会话在 `opencode serve` 里，用户在 `opencode attach`
 * 的界面里对话；Atrium 不持有界面，只经服务端接口按唤醒规则（wake-rule.ts）往同一会话送事件。
 * 送入走会话接口（prompt_async），不碰界面的输入框，用户正在输入的内容不受影响；
 * 秘书忙时（服务端报 busy）事件留在队列，一轮结束后合并送入。送入的消息以「【Atrium 事件】」开头，
 * 会话里其余用户消息算用户发起的一轮，连续唤醒次数清零。
 */

export type ServeSession = {
  status(): Promise<"idle" | "busy">;
  prompt(text: string): Promise<void>;
  /** 最近的消息（新的在后）。 */
  messages(limit: number): Promise<OpencodeMessage[]>;
  /** 界面提示；失败不影响送入。 */
  toast(message: string, variant: "info" | "warning"): Promise<void>;
};

export const WAKE_PREFIX = "【Atrium 事件】";
/** 送出后等服务端报 busy 的最长时间：prompt_async 立即返回，一轮要稍后才开始。 */
export const TURN_START_MS = 5000;

/** 自 since 以来有没有用户自己发的消息（送入的事件消息不算）。 */
export function userTurnSince(
  messages: readonly OpencodeMessage[],
  since: number,
): boolean {
  return messages.some(
    (message) =>
      message.info.role === "user" &&
      (message.info.time?.created ?? 0) > since &&
      !message.parts.some(
        (part) => part.type === "text" && part.text?.startsWith(WAKE_PREFIX),
      ),
  );
}

export class ServeWaker {
  private closed = false;
  private wakeCount: number;
  private lastWakeAt = 0;
  private readonly waiters = new Set<() => void>();
  private peekAbort: AbortController | null = null;
  private readonly now: () => number;
  private readonly batchMs: number;
  private readonly maxWakeups: number;
  private readonly pollMs: number;

  constructor(
    private readonly options: {
      session: ServeSession;
      source: EventSource;
      /** 送入后回调（测试与日志用）。 */
      delivered?: (events: InboxEvent[]) => void;
      batchMs?: number;
      maxWakeups?: number;
      pollMs?: number;
      now?: () => number;
      initialWakeCount?: number;
      onWakeCountChange?: (count: number) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.maxWakeups = options.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
    this.pollMs = options.pollMs ?? 1000;
    this.wakeCount = options.initialWakeCount ?? 0;
    if (this.wakeCount > 0) this.lastWakeAt = this.now();
  }

  close() {
    this.closed = true;
    this.peekAbort?.abort();
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async run() {
    let limited = false;
    let unavailable = false;
    while (!this.closed) {
      const events = await this.peek();
      if (!events?.length) continue;
      let running: boolean;
      try {
        if (this.wakeCount > 0) {
          const recent = await this.options.session.messages(20);
          if (userTurnSince(recent, this.lastWakeAt)) {
            this.wakeCount = nextWakeCount(this.wakeCount, "user_turn");
            this.options.onWakeCountChange?.(this.wakeCount);
            limited = false;
          }
        }
        running = (await this.options.session.status()) === "busy";
        unavailable = false;
      } catch {
        if (!unavailable)
          this.toast("连不上秘书的 opencode 服务，事件暂不送入", "warning");
        unavailable = true;
        await this.sleep(5000);
        continue;
      }
      const decision = decideWake({
        events: events.map((event) => ({
          id: event.id,
          queuedAt: event.updated_at,
        })),
        now: this.now(),
        batchMs: this.batchMs,
        sessionReady: true,
        turnRunning: running,
        consecutiveWakeups: this.wakeCount,
        maxConsecutiveWakeups: this.maxWakeups,
      });
      if (decision.kind === "batching")
        await this.sleep(Math.max(0, decision.readyAt - this.now()));
      else if (decision.kind === "busy") await this.sleep(this.pollMs);
      else if (decision.kind === "limit") {
        if (!limited)
          this.toast(
            `已连续自动送入 ${this.maxWakeups} 次事件，暂停自动送入；你发话后继续`,
            "warning",
          );
        limited = true;
        await this.sleep(this.pollMs * 2);
      } else if (decision.kind === "send") await this.send(decision.eventIds);
    }
    this.peekAbort?.abort();
  }

  private async send(ids: number[]) {
    let delivered: InboxEvent[];
    try {
      delivered = await this.options.source.deliver(ids);
    } catch {
      await this.sleep(5000);
      return;
    }
    if (!delivered.length) return;
    try {
      await this.options.session.prompt(wakePrompt(delivered));
    } catch {
      // 登记了送达但没送进去：租约到期后重投；这里不耗连续次数。
      this.toast("事件送入秘书会话失败，稍后重投", "warning");
      await this.sleep(5000);
      return;
    }
    this.lastWakeAt = this.now();
    this.wakeCount = nextWakeCount(this.wakeCount, "delivered");
    this.options.onWakeCountChange?.(this.wakeCount);
    this.toast(
      `送入事件 ${delivered.map((event) => `#${event.id}`).join(" ")}`,
      "info",
    );
    this.options.delivered?.(delivered);
    await this.started(this.lastWakeAt);
  }

  /**
   * prompt_async 立即返回，一轮稍后才开始：等到服务端报 busy 或已经答完，再回主循环判忙闲，
   * 免得这段空档里把新事件当空闲另起一轮（最多等 TURN_START_MS）。
   */
  private async started(since: number) {
    const deadline = this.now() + TURN_START_MS;
    while (!this.closed && this.now() < deadline) {
      try {
        if ((await this.options.session.status()) === "busy") return;
        const last = (await this.options.session.messages(1)).at(-1);
        if (
          last?.info.role === "assistant" &&
          (last.info.time?.created ?? 0) >= since
        )
          return;
      } catch {
        return;
      }
      await this.sleep(this.pollMs);
    }
  }

  private toast(message: string, variant: "info" | "warning") {
    void this.options.session.toast(message, variant).catch(() => {});
  }

  /** 等事件；关闭时中止并返回 null。 */
  private async peek(): Promise<InboxEvent[] | null> {
    const abort = new AbortController();
    this.peekAbort = abort;
    try {
      return await this.options.source.peek(PEEK_SECONDS, abort.signal);
    } catch {
      if (!this.closed) await this.sleep(5000);
      return null;
    } finally {
      this.peekAbort = null;
    }
  }

  private async sleep(ms: number) {
    if (this.closed) return;
    let wake = () => {};
    const woken = new Promise<void>((resolve) => (wake = resolve));
    this.waiters.add(wake);
    const abort = new AbortController();
    try {
      await Promise.race([
        delay(ms, undefined, { signal: abort.signal }).catch(() => {}),
        woken,
      ]);
    } finally {
      abort.abort();
      this.waiters.delete(wake);
    }
  }
}
