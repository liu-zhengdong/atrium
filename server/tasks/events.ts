import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { Problem } from "../problem.ts";
import { ownerOf, taskRef } from "./ledger.ts";

/**
 * 事件队列与投递（#262「事件投递」）。事件先落库，订阅者 ack 前一直保留，服务重启后仍在。
 * 同一订阅者、同一去重键的未 ack 事件合并成一条（计数加一、内容取最新）；
 * 攒批窗口内新到的事件等窗口结束才可取（默认 0，即到即取）。
 * 在线判断的钩子：订阅者挂着 wait 就算在线；「无人在线时后台起秘书」留给 #193。
 */

export function ensureEventTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber TEXT NOT NULL,
      task_id INTEGER,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      detail TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ready_at INTEGER NOT NULL,
      acked_at INTEGER);
    CREATE INDEX IF NOT EXISTS task_inbox_pending ON task_inbox(subscriber,acked_at,id);
    CREATE INDEX IF NOT EXISTS task_inbox_key ON task_inbox(subscriber,dedupe_key,acked_at);`);
}

type InboxRow = {
  id: number;
  subscriber: string;
  task_id: number | null;
  source: string;
  kind: string;
  dedupe_key: string;
  detail: string | null;
  count: number;
  created_at: number;
  updated_at: number;
  ready_at: number;
  acked_at: number | null;
};

export type InboxEvent = {
  id: number;
  subscriber: string;
  task: string | null;
  source: string;
  kind: string;
  key: string;
  count: number;
  detail: unknown;
  created_at: number;
  updated_at: number;
};

const view = (row: InboxRow): InboxEvent => {
  let detail: unknown = row.detail;
  try {
    detail = row.detail === null ? null : JSON.parse(row.detail);
  } catch {
    detail = row.detail;
  }
  return {
    id: row.id,
    subscriber: row.subscriber,
    task: row.task_id === null ? null : taskRef(row.task_id),
    source: row.source,
    kind: row.kind,
    key: row.dedupe_key,
    count: row.count,
    detail,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

export type Publish = {
  subscriber: string;
  taskId?: number;
  /** 事件来源：runner（执行者进程）、ci（CI 轮询）、recovery（重启自愈）等。 */
  source: string;
  kind: string;
  /** 去重键：同一订阅者未 ack 的同键事件合并。 */
  key: string;
  detail?: unknown;
};

export const BATCH_LIMIT = 50;
export const WAIT_MAX_SECONDS = 3600;
export const ACK_MAX = 500;

export class EventInbox {
  private readonly emitter = new EventEmitter();
  private readonly lastWait = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly batchMs = 0,
    private readonly now: () => number = Date.now,
  ) {
    ensureEventTables(db);
    this.emitter.setMaxListeners(0);
  }

  publish(event: Publish): InboxEvent {
    const now = this.now();
    const subscriber = ownerOf(event.subscriber, "subscriber");
    const detail =
      event.detail === undefined ? null : JSON.stringify(event.detail);
    const existing = this.db
      .prepare(
        "SELECT * FROM task_inbox WHERE subscriber=? AND dedupe_key=? AND acked_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(subscriber, event.key) as InboxRow | undefined;
    let id: number;
    if (existing) {
      this.db
        .prepare(
          "UPDATE task_inbox SET kind=?,source=?,detail=?,count=count+1,updated_at=? WHERE id=?",
        )
        .run(event.kind, event.source, detail, now, existing.id);
      id = existing.id;
    } else {
      const inserted = this.db
        .prepare(
          "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,detail,created_at,updated_at,ready_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          subscriber,
          event.taskId ?? null,
          event.source,
          event.kind,
          event.key,
          detail,
          now,
          now,
          now + this.batchMs,
        );
      id = Number(inserted.lastInsertRowid);
    }
    const row = this.db
      .prepare("SELECT * FROM task_inbox WHERE id=?")
      .get(id) as InboxRow;
    this.emitter.emit(subscriber);
    if (this.batchMs > 0)
      setTimeout(() => this.emitter.emit(subscriber), this.batchMs + 5).unref();
    return view(row);
  }

  /** 未 ack 且已过攒批窗口的事件，按编号升序，每批最多 50 条。 */
  pending(subscriber: string, limit = BATCH_LIMIT): InboxEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND ready_at<=? ORDER BY id LIMIT ?",
        )
        .all(subscriber, this.now(), limit) as InboxRow[]
    ).map(view);
  }

  /** 有可取事件立即返回；否则等到有事件、超时或服务关闭。 */
  async wait(
    subscriber: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<{
    events: InboxEvent[];
    timed_out: boolean;
    restarting?: boolean;
  }> {
    const who = ownerOf(subscriber, "as");
    this.lastWait.set(who, this.now());
    const ready = this.pending(who);
    if (ready.length || timeoutSeconds <= 0 || this.closed)
      return { events: ready, timed_out: !ready.length };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (restarting = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.off(who, check);
        this.emitter.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        this.lastWait.set(who, this.now());
        const events = this.pending(who);
        resolve({
          events,
          timed_out: !events.length,
          ...(restarting ? { restarting: true } : {}),
        });
      };
      const check = () => {
        if (this.pending(who, 1).length) finish();
      };
      const closing = () => finish(true);
      const aborted = () => finish();
      const timer = setTimeout(() => finish(), timeoutSeconds * 1000);
      this.emitter.on(who, check);
      this.emitter.on("close", closing);
      signal?.addEventListener("abort", aborted);
    });
  }

  ack(ids: readonly number[]) {
    const now = this.now();
    const acked: number[] = [];
    const missing: number[] = [];
    for (const id of ids) {
      const result = this.db
        .prepare(
          "UPDATE task_inbox SET acked_at=? WHERE id=? AND acked_at IS NULL",
        )
        .run(now, id);
      if (result.changes) acked.push(id);
      else missing.push(id);
    }
    return { acked, missing };
  }

  /** 订阅者最近一次挂着 wait 的时间：#193 据此判断在线，无人在线时再后台唤醒。 */
  lastWaitAt(subscriber: string) {
    return this.lastWait.get(subscriber);
  }

  close() {
    this.closed = true;
    this.emitter.emit("close");
  }
}

// ---- 入口校验 ----

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

export function waitSeconds(value: unknown): number {
  if (value === undefined || value === "") return 300;
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || Number(text) > WAIT_MAX_SECONDS)
    throw usage(`timeout: 应为 0～${WAIT_MAX_SECONDS} 的整数秒`);
  return Number(text);
}

export function ackIds(body: unknown): number[] {
  const ids =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { ids?: unknown }).ids
      : undefined;
  if (!Array.isArray(ids) || !ids.length)
    throw usage("ids: 至少给一个事件编号", "atrium events wait");
  if (ids.length > ACK_MAX) throw usage(`ids: 一次最多 ${ACK_MAX} 个`);
  return [
    ...new Set(
      ids.map((value) => {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id <= 0 || String(value).trim() === "")
          throw usage(`ids: 事件编号应为正整数（收到：${String(value)}）`);
        return id;
      }),
    ),
  ];
}
