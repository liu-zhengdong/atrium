import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { Problem } from "../problem.ts";
import { LEASE_MS, selfInitiated } from "./event-lease.ts";
import { atomically, ownerOf, taskRef } from "./ledger.ts";

/**
 * 事件队列与投递（#262「事件投递」）。事件先落库，订阅者 ack 前一直保留，服务重启后仍在。
 * 同一订阅者、同一去重键的未 ack 事件合并成一条（计数加一、内容取最新）；
 * 攒批窗口内新到的事件等窗口结束才可取（默认 0，即到即取）。
 * wait 交出的事件进入处理中，租约内不重投；订阅者自己发起的动作不投给他本人（判定见 event-lease.ts）。
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
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(task_inbox)").all() as { name: string }[]
    ).map((column) => column.name),
  );
  if (!columns.has("actor"))
    db.exec("ALTER TABLE task_inbox ADD COLUMN actor TEXT");
  if (!columns.has("delivered_at"))
    db.exec("ALTER TABLE task_inbox ADD COLUMN delivered_at INTEGER");
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
  actor: string | null;
  delivered_at: number | null;
};

export type InboxEvent = {
  id: number;
  subscriber: string;
  task: string | null;
  source: string;
  kind: string;
  key: string;
  /** 发起者；执行者、CI 等自发的为 null。 */
  actor: string | null;
  count: number;
  detail: unknown;
  created_at: number;
  updated_at: number;
  /** 最近一次送达时间；合并新内容后会清空，等待重新送达。 */
  delivered_at: number | null;
  acked_at: number | null;
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
    actor: row.actor,
    count: row.count,
    detail,
    created_at: row.created_at,
    updated_at: row.updated_at,
    delivered_at: row.delivered_at,
    acked_at: row.acked_at,
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
  /** 发起者（如执行 task stop 的订阅者）：与订阅者相同时只记账不投递。 */
  actor?: string;
  detail?: unknown;
};

export const BATCH_LIMIT = 50;
export const WAIT_MAX_SECONDS = 3600;
export const ACK_MAX = 500;
export const LIST_LIMIT = 50;
export const LIST_MAX = 200;

export function listOptions(query: { before?: string; limit?: string }) {
  const positive = (value: string | undefined, name: string, max: number) => {
    if (value === undefined) return undefined;
    if (
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > max
    )
      throw usage(`${name}: 应为 1～${max} 的整数`);
    return Number(value);
  };
  return {
    before: positive(query.before, "before", Number.MAX_SAFE_INTEGER),
    limit: positive(query.limit, "limit", LIST_MAX) ?? LIST_LIMIT,
  };
}

export class EventInbox {
  private readonly emitter = new EventEmitter();
  private readonly lastWait = new Map<string, number>();
  private closed = false;

  private readonly batchMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    options: { batchMs?: number; leaseMs?: number; now?: () => number } = {},
  ) {
    this.batchMs = options.batchMs ?? 0;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.now = options.now ?? Date.now;
    ensureEventTables(db);
    this.emitter.setMaxListeners(0);
  }

  publish(event: Publish): InboxEvent {
    const now = this.now();
    const subscriber = ownerOf(event.subscriber, "subscriber");
    const actor = event.actor === undefined ? null : ownerOf(event.actor, "as");
    const self = selfInitiated(subscriber, actor);
    const detail =
      event.detail === undefined ? null : JSON.stringify(event.detail);
    // 自己发起的只和自己发起的合并，免得盖掉一条还没投出去的别人的事件。
    const existing = this.db
      .prepare(
        `SELECT * FROM task_inbox WHERE subscriber=? AND dedupe_key=? AND acked_at IS NULL AND ${
          self ? "actor=?" : "(actor IS NULL OR actor<>?)"
        } ORDER BY id DESC LIMIT 1`,
      )
      .get(subscriber, event.key, subscriber) as InboxRow | undefined;
    let id: number;
    if (existing) {
      // 内容更新了就是新消息：清掉处理中租约，重新投递。
      this.db
        .prepare(
          "UPDATE task_inbox SET kind=?,source=?,actor=?,detail=?,count=count+1,updated_at=?,delivered_at=NULL WHERE id=?",
        )
        .run(event.kind, event.source, actor, detail, now, existing.id);
      id = existing.id;
    } else {
      const inserted = this.db
        .prepare(
          "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,actor,detail,created_at,updated_at,ready_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          subscriber,
          event.taskId ?? null,
          event.source,
          event.kind,
          event.key,
          actor,
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
    if (self) return view(row);
    this.emitter.emit(subscriber);
    if (this.batchMs > 0)
      setTimeout(() => this.emitter.emit(subscriber), this.batchMs + 5).unref();
    return view(row);
  }

  /** 最近事件，含已送达与已确认记录；按编号倒序、有界分页。 */
  list(subscriber: string, options: { before?: number; limit: number }) {
    const who = ownerOf(subscriber, "as");
    const rows = this.db
      .prepare(
        "SELECT * FROM task_inbox WHERE subscriber=? AND id<? ORDER BY id DESC LIMIT ?",
      )
      .all(
        who,
        options.before ?? Number.MAX_SAFE_INTEGER,
        options.limit + 1,
      ) as InboxRow[];
    const page = rows.slice(0, options.limit);
    return {
      events: page.map(view),
      next_before: rows.length > options.limit ? page.at(-1)!.id : null,
    };
  }

  /** 可投递的事件（条件与 event-lease.ts 的 deliverable 一致），按编号升序，每批最多 50 条；只看不交。 */
  pending(subscriber: string, limit = BATCH_LIMIT): InboxEvent[] {
    const now = this.now();
    return (
      this.db
        .prepare(
          "SELECT * FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND ready_at<=? AND (delivered_at IS NULL OR delivered_at<=?) ORDER BY id LIMIT ?",
        )
        .all(subscriber, now, now - this.leaseMs, limit) as InboxRow[]
    ).map(view);
  }

  /**
   * 未处理事件条数（#262 `atrium top` 的汇总行）：条件与 pending 一致，只数不取。
   * 计数封顶 cap，攒批窗口未到的事件也算未处理。
   */
  countPending(subscriber: string, cap = BATCH_LIMIT) {
    const now = this.now();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM (SELECT 1 FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND ready_at<=? AND (delivered_at IS NULL OR delivered_at<=?) LIMIT ?)",
      )
      .get(subscriber, now, now - this.leaseMs, cap) as { n: number };
    return row.n;
  }

  /** 取一批交给订阅者，并从现在起算处理中租约。 */
  private take(subscriber: string): InboxEvent[] {
    return atomically(this.db, () => {
      const events = this.pending(subscriber);
      const mark = this.db.prepare(
        "UPDATE task_inbox SET delivered_at=? WHERE id=?",
      );
      const now = this.now();
      for (const event of events) mark.run(now, event.id);
      return events.map((event) => ({ ...event, delivered_at: now }));
    });
  }

  /** 最早到期的处理中租约还有多久（毫秒）；没有处理中的返回 undefined。 */
  private nextLeaseIn(subscriber: string) {
    const row = this.db
      .prepare(
        "SELECT MIN(delivered_at) AS at FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND delivered_at IS NOT NULL AND (actor IS NULL OR actor<>subscriber)",
      )
      .get(subscriber) as { at: number | null };
    return row.at === null
      ? undefined
      : Math.max(0, row.at + this.leaseMs - this.now());
  }

  /**
   * 只把仍可投递的指定事件记为已送达（唤醒通道送入会话前调用），返回实际标记的事件；
   * 已确认、处理中或不属于该订阅者的编号略过。之后与 wait 取走的一样走处理中租约。
   */
  deliver(subscriber: string, ids: readonly number[]): InboxEvent[] {
    const who = ownerOf(subscriber, "as");
    const wanted = new Set(ids);
    return atomically(this.db, () => {
      const events = this.pending(who, Number.MAX_SAFE_INTEGER).filter(
        (event) => wanted.has(event.id),
      );
      const mark = this.db.prepare(
        "UPDATE task_inbox SET delivered_at=? WHERE id=?",
      );
      const now = this.now();
      for (const event of events) mark.run(now, event.id);
      return events.map((event) => ({ ...event, delivered_at: now }));
    });
  }

  /** A failed one-shot wake can relinquish its lease without touching newer merges or acknowledgements. */
  release(subscriber: string, events: readonly InboxEvent[]) {
    const who = ownerOf(subscriber, "as");
    const clear = this.db.prepare(
      "UPDATE task_inbox SET delivered_at=NULL WHERE subscriber=? AND id=? AND acked_at IS NULL AND delivered_at=? AND updated_at=?",
    );
    atomically(this.db, () => {
      for (const event of events)
        if (event.delivered_at !== null)
          clear.run(who, event.id, event.delivered_at, event.updated_at);
    });
    this.emitter.emit(who);
  }

  /**
   * 有可取事件立即返回；否则等到有事件、超时或服务关闭。
   * peek 只看不取：不记送达、不起租约，供唤醒通道判断空闲后再 deliver。
   */
  async wait(
    subscriber: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    options: { peek?: boolean; trackOnline?: boolean } = {},
  ): Promise<{
    events: InboxEvent[];
    timed_out: boolean;
    restarting?: boolean;
  }> {
    const who = ownerOf(subscriber, "as");
    if (options.trackOnline !== false) this.lastWait.set(who, this.now());
    const take = () => (options.peek ? this.pending(who) : this.take(who));
    const ready = take();
    if (ready.length || timeoutSeconds <= 0 || this.closed)
      return {
        events: ready,
        timed_out: !ready.length,
        ...(this.closed ? { restarting: true } : {}),
      };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (restarting = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(lease);
        this.emitter.off(who, check);
        this.emitter.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        if (options.trackOnline !== false) this.lastWait.set(who, this.now());
        const events = take();
        resolve({
          events,
          timed_out: !events.length,
          ...(restarting ? { restarting: true } : {}),
        });
      };
      let lease: NodeJS.Timeout | undefined;
      // 租约到期的事件要重投：到点醒来查一次，没查到就等下一个到期的。
      const arm = () => {
        clearTimeout(lease);
        const leaseIn = this.nextLeaseIn(who);
        lease =
          leaseIn !== undefined && leaseIn < timeoutSeconds * 1000
            ? setTimeout(check, leaseIn + 5)
            : undefined;
      };
      const check = () => {
        if (this.pending(who, 1).length) finish();
        else arm();
      };
      const closing = () => finish(true);
      const aborted = () => finish();
      const timer = setTimeout(() => finish(), timeoutSeconds * 1000);
      arm();
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
