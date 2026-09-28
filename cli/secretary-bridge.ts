import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  postLines,
  probeEndpoint,
  type EndpointResult,
} from "../server/platform/endpoint.ts";
import type { InboxEvent } from "../server/tasks/events/events.ts";
import {
  BRIDGE_VIA,
  LISTEN_EVERY_MS,
  LISTEN_TTL_SECONDS,
  REMIND_MS,
  bridgePrompt,
  inboxLines,
  parseBridgeRecord,
  planBatch,
  recordSent,
  type BridgeRecord,
  type Sent,
} from "../server/tasks/secretary/bridge-plan.ts";

/**
 * `atrium secretary bridge` 的常驻循环（t243）：挂 `events wait` 取秘书要处理的事件，
 * 拼成一条经 Claude Code 会话收件 socket 送进会话；定时向服务报「在听」，会话没了就退出。
 * 不确认事件（秘书处理完自己 ack）。判定在 `server/tasks/secretary/bridge-plan.ts`。
 */

export type BridgeSource = {
  /** 取一批要处理的事件（取走即起租约）；没有就等，超时返回空。 */
  wait(timeoutSeconds: number, signal: AbortSignal): Promise<InboxEvent[]>;
  /** 报「在听」；stop 表示不听了。 */
  listen(
    input: { via: string; ttl_seconds: number } | { stop: true },
  ): Promise<void>;
};

export type BridgeOptions = {
  endpoint: string;
  token: string;
  source: BridgeSource;
  remindMs?: number;
  listenEveryMs?: number;
  /** 一次 wait 最多挂多久；到点探一下会话还在不在。 */
  waitSeconds?: number;
  retryMs?: number;
  now?: () => number;
  /** 还是不是登记的那个 bridge；别的会话接手后返回 false。 */
  owner?: () => boolean;
  log?: (line: string) => void;
  post?: (endpoint: string, lines: string[]) => Promise<EndpointResult>;
  probe?: (endpoint: string) => Promise<EndpointResult>;
};

export class SecretaryBridge {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly sent: Sent = new Map();
  private listenFailed = false;

  constructor(private readonly options: BridgeOptions) {}

  close() {
    this.closed = true;
    this.abort.abort();
  }

  /** 跑到会话没了、被别的会话接手或 close；返回退出原因。 */
  async run(): Promise<string> {
    const log = this.options.log ?? (() => {});
    const now = this.options.now ?? Date.now;
    const post = this.options.post ?? postLines;
    const probe = this.options.probe ?? probeEndpoint;
    const remindMs = this.options.remindMs ?? REMIND_MS;
    await this.heartbeat();
    const timer = setInterval(
      () => void this.heartbeat(),
      this.options.listenEveryMs ?? LISTEN_EVERY_MS,
    );
    try {
      while (!this.closed) {
        if (this.options.owner && !this.options.owner())
          return "另一个秘书会话的 bridge 已接手";
        const alive = await probe(this.options.endpoint);
        if (!alive.ok && alive.gone) return "会话已关闭（收件地址不在了）";
        let events: InboxEvent[];
        try {
          events = await this.options.source.wait(
            this.options.waitSeconds ?? 60,
            this.abort.signal,
          );
        } catch (error) {
          if (this.closed) break;
          log(`取事件失败，稍后重试：${message(error)}`);
          await this.pause();
          continue;
        }
        if (this.closed) break;
        const batch = planBatch(this.sent, events, now(), remindMs);
        const all = [...batch.fresh, ...batch.remind];
        if (!all.length) continue;
        const result = await post(
          this.options.endpoint,
          inboxLines(this.options.token, bridgePrompt(batch, remindMs)),
        );
        if (result.ok) {
          recordSent(this.sent, all, now());
          log(
            `送入 ${all.map((event) => `#${event.id}`).join(" ")}${batch.remind.length ? `（其中再提醒 ${batch.remind.map((event) => `#${event.id}`).join(" ")}）` : ""}`,
          );
          continue;
        }
        if (result.gone) return "会话已关闭（收件地址不在了）";
        // 没送进去：事件已取走、租约到期后会重投，那时按新事件再送。
        log(`送入会话失败，稍后重试：${result.message}`);
        await this.pause();
      }
      return "已停止";
    } finally {
      clearInterval(timer);
      await this.options.source.listen({ stop: true }).catch(() => {});
    }
  }

  private async heartbeat() {
    if (this.closed) return;
    try {
      await this.options.source.listen({
        via: BRIDGE_VIA,
        ttl_seconds: LISTEN_TTL_SECONDS,
      });
      if (this.listenFailed) this.options.log?.("已重新向服务报「在听」");
      this.listenFailed = false;
    } catch (error) {
      if (!this.listenFailed)
        this.options.log?.(`向服务报「在听」失败：${message(error)}`);
      this.listenFailed = true;
    }
  }

  private async pause() {
    try {
      await delay(this.options.retryMs ?? 5000, undefined, {
        signal: this.abort.signal,
      });
    } catch {
      // close 打断。
    }
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// ---- 登记（数据目录 secretary/bridge.json）----

export const bridgeFile = (data: string) =>
  join(data, "secretary", "bridge.json");
export const bridgeLog = (data: string) =>
  join(data, "secretary", "bridge.log");

export function readBridge(data: string): BridgeRecord | null {
  try {
    return parseBridgeRecord(readFileSync(bridgeFile(data), "utf8"));
  } catch {
    return null;
  }
}

export function writeBridge(data: string, record: BridgeRecord) {
  mkdirSync(join(data, "secretary"), { recursive: true, mode: 0o700 });
  writeFileSync(bridgeFile(data), JSON.stringify(record), { mode: 0o600 });
}

/** 登记还是自己时才删，别的会话接手后留给它。 */
export function releaseBridge(data: string, pid: number) {
  if (readBridge(data)?.pid === pid) rmSync(bridgeFile(data), { force: true });
}

/** 服务那头：秘书的事件与「在听」接口。 */
export function serviceSource(
  api: import("./service.ts").Client,
  subscriber = "secretary",
): BridgeSource {
  return {
    wait: async (timeout, signal) =>
      (
        await api.get<{ events: InboxEvent[] }>(
          `/events/wait?${new URLSearchParams({ as: subscriber, timeout: String(timeout) })}`,
          undefined,
          signal,
        )
      ).events,
    listen: async (input) => {
      await api.post(`/events/listen?as=${subscriber}`, input);
    },
  };
}
