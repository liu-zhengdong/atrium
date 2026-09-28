import { setTimeout as delay } from "node:timers/promises";
import type { InboxEvent } from "../server/tasks/events.ts";
import { decideWake, nextWakeCount } from "../server/tasks/wake-rule.ts";
import type {
  AcpConnection,
  AcpUpdate,
  PermissionOutcome,
  PermissionRequest,
  StopReason,
} from "../server/acp/client.ts";
import { wakePrompt } from "../server/tasks/wake-prompt.ts";
export { wakePrompt } from "../server/tasks/wake-prompt.ts";

/**
 * ACP 托管的秘书会话（#307 第 2 步）：Atrium 持有会话，用户消息与待处理事件都作为新一轮送入。
 * 一轮进行中不送（ACP 一轮内不能追加消息）：事件留在队列，一轮结束后按唤醒规则（wake-rule.ts）
 * 攒批合并送入；用户消息优先于事件，用户发起一轮时连续唤醒次数清零。
 * 送入前向服务登记送达（deliver），秘书处理完自己 `atrium events ack`；没确认的租约到期后重投。
 */

export type EventSource = {
  /** 只看不取；没有就等，超时返回空。 */
  peek(timeoutSeconds: number, signal: AbortSignal): Promise<InboxEvent[]>;
  /** 登记送达，返回实际登记的事件（已被别处取走或确认的略过）。 */
  deliver(ids: number[]): Promise<InboxEvent[]>;
};

export type ChatView = {
  /** Agent 回复的流式片段。 */
  text(chunk: string): void;
  thought(chunk: string): void;
  tool(title: string, status: string): void;
  /** 送入会话的事件：界面据此标出本轮送入了哪些事件。 */
  wake(events: InboxEvent[]): void;
  notice(message: string): void;
  turnEnd(stopReason: StopReason | "failed"): void;
  permission(request: PermissionRequest): Promise<PermissionOutcome>;
};

export type SessionStore = {
  load(): string | undefined;
  save(sessionId: string): void;
};

export const PEEK_SECONDS = 240;
export const DEFAULT_BATCH_MS = 2000;
export const DEFAULT_MAX_WAKEUPS = 10;

type Connection = Pick<AcpConnection, "request" | "notify" | "close">;

export class SecretaryChat {
  private sessionId = "";
  private replaying = false;
  private busy = false;
  private closed = false;
  private ending = false;
  private wakeCount = 0;
  private readonly queue: string[] = [];
  private readonly waiters = new Set<() => void>();
  private peekAbort: AbortController | null = null;
  private exitReason: string | null = null;
  private readonly tools = new Map<string, string>();
  private readonly now: () => number;
  private readonly batchMs: number;
  private readonly maxWakeups: number;

  constructor(
    private readonly options: {
      connection: Connection;
      source: EventSource;
      view: ChatView;
      store: SessionStore;
      cwd: string;
      /** 可恢复上次会话（Agent 声明了 loadSession）。 */
      fresh?: boolean;
      batchMs?: number;
      maxWakeups?: number;
      now?: () => number;
      initialWakeCount?: number;
      onWakeCountChange?: (count: number) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.maxWakeups = options.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
    this.wakeCount = options.initialWakeCount ?? 0;
  }

  get session() {
    return this.sessionId;
  }

  get running() {
    return this.busy;
  }

  /** 连接层回调：流式更新交给界面；恢复会话时的历史回放不重复显示。 */
  update(sessionId: string, update: AcpUpdate) {
    if (this.replaying || (this.sessionId && sessionId !== this.sessionId))
      return;
    const content = update.content as { type?: string; text?: string };
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (content?.type === "text" && content.text)
          this.options.view.text(content.text);
        return;
      case "agent_thought_chunk":
        if (content?.type === "text" && content.text)
          this.options.view.thought(content.text);
        return;
      case "tool_call":
      case "tool_call_update": {
        const id = String(update.toolCallId ?? "");
        const title =
          typeof update.title === "string" && update.title
            ? update.title
            : (this.tools.get(id) ?? "工具");
        this.tools.set(id, title);
        const status = typeof update.status === "string" ? update.status : "";
        if (update.sessionUpdate === "tool_call" || status)
          this.options.view.tool(title, status || "pending");
        return;
      }
    }
  }

  permission(request: PermissionRequest) {
    return this.options.view.permission(request);
  }

  /** Agent 进程退出：结束循环，run() 带原因返回。 */
  exit(reason: string) {
    if (!this.closed) this.exitReason = reason;
    this.closed = true;
    this.poke();
  }

  /** 建立会话：先试恢复上次的，失败就新建。 */
  async start(agent: { loadSession: boolean }) {
    const { connection, store, cwd } = this.options;
    const previous = this.options.fresh ? undefined : store.load();
    if (previous && agent.loadSession) {
      this.replaying = true;
      try {
        await connection.request("session/load", {
          sessionId: previous,
          cwd,
          mcpServers: [],
        });
        this.sessionId = previous;
      } catch {
        // 会话已不在（被删或换了数据目录）：新建。
      } finally {
        this.replaying = false;
      }
    }
    if (!this.sessionId) {
      const created = await connection.request<{ sessionId: string }>(
        "session/new",
        { cwd, mcpServers: [] },
      );
      this.sessionId = created.sessionId;
    }
    store.save(this.sessionId);
    return { resumed: this.sessionId === previous };
  }

  /** 用户消息：空闲时立即开一轮，忙时排在本轮之后。 */
  say(text: string) {
    this.queue.push(text);
    this.poke();
  }

  /** 取消进行中的一轮；返回是否有可取消的。 */
  cancel() {
    if (!this.busy) return false;
    this.options.connection.notify("session/cancel", {
      sessionId: this.sessionId,
    });
    return true;
  }

  /** 输入结束：排队的消息送完、当前一轮结束后退出。 */
  end() {
    this.ending = true;
    this.poke();
  }

  close() {
    this.closed = true;
    this.poke();
    this.options.connection.close();
  }

  /** 主循环：用户消息优先；空闲时按唤醒规则把事件送入。返回 Agent 退出原因（正常结束为 null）。 */
  async run(): Promise<string | null> {
    let limited = false;
    while (!this.closed) {
      const message = this.queue.shift();
      if (message !== undefined) {
        this.wakeCount = nextWakeCount(this.wakeCount, "user_turn");
        this.options.onWakeCountChange?.(this.wakeCount);
        limited = false;
        await this.turn(message);
        continue;
      }
      if (this.ending) break;
      const events = await this.peek();
      if (events === null) continue;
      const decision = decideWake({
        events: events.map((event) => ({
          id: event.id,
          queuedAt: event.updated_at,
        })),
        now: this.now(),
        batchMs: this.batchMs,
        sessionReady: true,
        turnRunning: this.busy,
        consecutiveWakeups: this.wakeCount,
        maxConsecutiveWakeups: this.maxWakeups,
      });
      if (decision.kind === "batching") {
        await Promise.race([
          delay(Math.max(0, decision.readyAt - this.now())),
          this.poked(),
        ]);
      } else if (decision.kind === "limit") {
        if (!limited)
          this.options.view.notice(
            `已连续自动送入 ${this.maxWakeups} 次事件，暂停自动送入；你发话后继续（待处理：atrium events）`,
          );
        limited = true;
        await this.poked();
      } else if (decision.kind === "send") {
        let delivered: InboxEvent[];
        try {
          delivered = await this.options.source.deliver(decision.eventIds);
        } catch (error) {
          this.options.view.notice(`登记送达失败：${message_(error)}`);
          await Promise.race([delay(5000), this.poked()]);
          continue;
        }
        if (!delivered.length) continue;
        this.options.view.wake(delivered);
        const ok = await this.turn(wakePrompt(delivered));
        this.wakeCount = nextWakeCount(
          this.wakeCount,
          ok ? "delivered" : "failed",
        );
        this.options.onWakeCountChange?.(this.wakeCount);
      }
    }
    this.peekAbort?.abort();
    return this.exitReason;
  }

  /** 等事件；用户发话或关闭时中止并返回 null。 */
  private async peek(): Promise<InboxEvent[] | null> {
    const abort = new AbortController();
    this.peekAbort = abort;
    const poked = this.poked().then(() => {
      abort.abort();
      return null;
    });
    const looked = this.options.source
      .peek(PEEK_SECONDS, abort.signal)
      .catch(async (error: unknown) => {
        if (abort.signal.aborted) return null;
        this.options.view.notice(`取事件失败，稍后重试：${message_(error)}`);
        await Promise.race([delay(5000), poked]);
        return null;
      });
    const result = await Promise.race([looked, poked]);
    abort.abort();
    return result;
  }

  /** 唤醒等待中的主循环（用户发话、输入结束、关闭）。 */
  private poke() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private poked() {
    return new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  private async turn(text: string) {
    this.busy = true;
    try {
      const result = await this.options.connection.request<{
        stopReason: StopReason;
      }>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.options.view.turnEnd(result.stopReason);
      return true;
    } catch (error) {
      if (!this.closed)
        this.options.view.notice(`本轮失败：${message_(error)}`);
      this.options.view.turnEnd("failed");
      return false;
    } finally {
      this.busy = false;
    }
  }
}

const message_ = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
