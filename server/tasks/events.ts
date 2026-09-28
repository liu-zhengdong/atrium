import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { Problem } from "../problem.ts";
import { LEASE_MS, selfInitiated } from "./event-lease.ts";
import {
  eventLevel,
  INFORMATION_KINDS,
  summarizeEvents,
} from "./event-level.ts";
import { atomically, ownerOf, taskRef } from "./ledger.ts";
import type { Presence } from "./secretary-watch.ts";

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
      acked_at INTEGER,
      level TEXT NOT NULL DEFAULT 'action');
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
  // 级别进 SQL（#t126）：知会/要处理是写入时就定下的事实，不用每次读出来再逐行判。
  const freshLevel = !columns.has("level");
  if (freshLevel)
    db.exec(
      "ALTER TABLE task_inbox ADD COLUMN level TEXT NOT NULL DEFAULT 'action'",
    );
  if (freshLevel) backfillLevels(db);
  // 已派人验证的「已上线」改成知会（t182）：此前按要处理存的行回写一次，免得 SQL 与读出的级别不一致。
  // 条件带 level='action'，回写过就不再命中。
  db.exec(
    `UPDATE task_inbox SET level='info' WHERE kind='online' AND level='action' AND json_valid(detail) AND json_type(detail,'$.verifier')='text'`,
  );
  // 逐条语句都要走索引（#t126）：按任务查、按订阅者看最近事件、看某一订阅者上交的记录。
  db.exec(`CREATE INDEX IF NOT EXISTS task_inbox_task ON task_inbox(task_id,id);
    CREATE INDEX IF NOT EXISTS task_inbox_sub_id ON task_inbox(subscriber,id);
    CREATE INDEX IF NOT EXISTS task_inbox_sub_updated ON task_inbox(subscriber,updated_at,id);
    CREATE INDEX IF NOT EXISTS task_inbox_source ON task_inbox(source,id);
    CREATE INDEX IF NOT EXISTS task_inbox_acked ON task_inbox(level,acked_at,id) WHERE acked_at IS NOT NULL;`);
  // 待投递索引带上级别：老的（subscriber,acked_at,id）换成（subscriber,acked_at,level,id），
  // 只取「要处理」时直接在索引里定位，不必先扫出一堆知会再在 JS 里丢。
  const pending = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='task_inbox_pending'",
    )
    .get() as { sql: string | null } | undefined;
  if (pending && !(pending.sql ?? "").includes("level"))
    db.exec("DROP INDEX task_inbox_pending");
  db.exec(
    "CREATE INDEX IF NOT EXISTS task_inbox_pending ON task_inbox(subscriber,acked_at,level,id)",
  );
}

/** 老库补级别：知会类型直接按集合标 info；ready 的自愈知会要看 detail。 */
function backfillLevels(db: DatabaseSync) {
  const kinds = [...INFORMATION_KINDS];
  const marks = kinds.map(() => "?").join(",");
  db.prepare(`UPDATE task_inbox SET level='info' WHERE kind IN (${marks})`).run(
    ...kinds,
  );
  const ready = db
    .prepare("SELECT id,detail FROM task_inbox WHERE kind='ready'")
    .all() as { id: number; detail: string | null }[];
  const mark = db.prepare("UPDATE task_inbox SET level=? WHERE id=?");
  for (const row of ready) {
    let detail: unknown = null;
    try {
      detail = row.detail === null ? null : JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
    if (eventLevel("ready", detail) === "info") mark.run("info", row.id);
  }
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
  level: string | null;
};

export type InboxEvent = {
  id: number;
  subscriber: string;
  task: string | null;
  source: string;
  kind: string;
  level: "action" | "info";
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
    // 写入时已定级别；老行没有级别时按内容判，保证读出来的语义不变。
    level: row.level === "info" ? "info" : eventLevel(row.kind, detail),
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
  /** 此刻挂着 wait 的连接数（按订阅者）；唤醒通道自己的 peek 不算。 */
  private readonly waiting = new Map<string, number>();
  private readonly startedAt: number;
  /** 经注入在听的（t243）：订阅者 → 来源与有效期；bridge 定时续报，过期即不在听。 */
  private readonly heard = new Map<string, Listener>();
  private readonly observers: ((event: InboxEvent) => void)[] = [];
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
    this.startedAt = this.now();
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
    const level = eventLevel(event.kind, event.detail);
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
          "UPDATE task_inbox SET kind=?,source=?,actor=?,detail=?,level=?,count=count+1,updated_at=?,delivered_at=NULL WHERE id=?",
        )
        .run(event.kind, event.source, actor, detail, level, now, existing.id);
      id = existing.id;
    } else {
      const inserted = this.db
        .prepare(
          "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,actor,detail,level,created_at,updated_at,ready_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          subscriber,
          event.taskId ?? null,
          event.source,
          event.kind,
          event.key,
          actor,
          detail,
          level,
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
    const published = view(row);
    for (const observer of this.observers)
      try {
        observer(published);
      } catch (error) {
        console.warn(`事件观察者出错（不影响投递）：${String(error)}`);
      }
    this.emitter.emit(subscriber);
    if (this.batchMs > 0)
      setTimeout(() => this.emitter.emit(subscriber), this.batchMs + 5).unref();
    return published;
  }

  /** 事件落库（且不是订阅者自己发起的）后同步回调，如推送到手机（server/notify/）；回调出错只记日志。 */
  observe(observer: (event: InboxEvent) => void) {
    this.observers.push(observer);
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
  pending(subscriber: string, limit = BATCH_LIMIT, all = false): InboxEvent[] {
    const now = this.now();
    const result: InboxEvent[] = [];
    let after = 0;
    const level = all ? "" : " AND level='action'";
    while (result.length < limit) {
      const rows = this.db
        .prepare(
          `SELECT * FROM task_inbox WHERE subscriber=? AND id>? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND ready_at<=? AND (delivered_at IS NULL OR delivered_at<=?)${level} ORDER BY id LIMIT 200`,
        )
        .all(subscriber, after, now, now - this.leaseMs) as InboxRow[];
      for (const row of rows) {
        after = row.id;
        result.push(view(row));
        if (result.length === limit) break;
      }
      if (rows.length < 200) break;
    }
    return result;
  }

  /**
   * 未处理事件条数（#262 `atrium top` 的汇总行）：条件与 pending 一致，只数不取。
   * 计数封顶 cap，攒批窗口未到的事件也算未处理。
   */
  countPending(subscriber: string, cap = BATCH_LIMIT) {
    return this.pending(subscriber, cap).length;
  }

  /** 取一批交给订阅者，并从现在起算处理中租约。 */
  private take(subscriber: string, all = false): InboxEvent[] {
    return atomically(this.db, () => {
      const events = this.pending(subscriber, BATCH_LIMIT, all);
      const mark = this.db.prepare(
        "UPDATE task_inbox SET delivered_at=? WHERE id=?",
      );
      const now = this.now();
      for (const event of events) mark.run(now, event.id);
      return events.map((event) => ({ ...event, delivered_at: now }));
    });
  }

  /** 最早到期的处理中租约还有多久（毫秒）；没有处理中的返回 undefined。 */
  private nextLeaseIn(subscriber: string, all = false) {
    let offset = 0;
    const level = all ? "" : " AND level='action'";
    while (true) {
      const rows = this.db
        .prepare(
          `SELECT * FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND delivered_at IS NOT NULL AND (actor IS NULL OR actor<>subscriber)${level} ORDER BY delivered_at,id LIMIT 200 OFFSET ?`,
        )
        .all(subscriber, offset) as InboxRow[];
      const row = rows[0];
      if (row)
        return Math.max(0, row.delivered_at! + this.leaseMs - this.now());
      if (rows.length < 200) return undefined;
      offset += rows.length;
    }
  }

  /**
   * 只把仍可投递的指定事件记为已送达（唤醒通道送入会话前调用），返回实际标记的事件；
   * 已确认、处理中或不属于该订阅者的编号略过。之后与 wait 取走的一样走处理中租约。
   */
  deliver(subscriber: string, ids: readonly number[]): InboxEvent[] {
    const who = ownerOf(subscriber, "as");
    const wanted = new Set(ids);
    return atomically(this.db, () => {
      const events = this.pending(who, BATCH_LIMIT).filter((event) =>
        wanted.has(event.id),
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

  /** 服务重启后收回上次唤醒没确认完的处理中租约，免得等满租约才重投。 */
  releaseAll(subscriber: string) {
    const who = ownerOf(subscriber, "as");
    this.db
      .prepare(
        "UPDATE task_inbox SET delivered_at=NULL WHERE subscriber=? AND acked_at IS NULL AND delivered_at IS NOT NULL",
      )
      .run(who);
    this.emitter.emit(who);
  }

  /** 事件编号各自的订阅者；不存在的编号不出现在结果里。 */
  subscribersOf(ids: readonly number[]): Map<number, string> {
    const map = new Map<number, string>();
    const get = this.db.prepare("SELECT subscriber FROM task_inbox WHERE id=?");
    for (const id of ids) {
      const row = get.get(id) as { subscriber: string } | undefined;
      if (row) map.set(id, row.subscriber);
    }
    return map;
  }

  /**
   * 送达后内容又被合并更新过的事件（处理期间同一任务又有新结果）：已确认的重新打开、收回租约，
   * 让新内容再投一次，免得「确认旧内容」顺带吞掉新结果。返回内容变过的编号。
   */
  reopenChanged(subscriber: string, events: readonly InboxEvent[]): number[] {
    const who = ownerOf(subscriber, "as");
    const read = this.db.prepare(
      "SELECT updated_at FROM task_inbox WHERE subscriber=? AND id=?",
    );
    const reopen = this.db.prepare(
      "UPDATE task_inbox SET acked_at=NULL,delivered_at=NULL WHERE subscriber=? AND id=?",
    );
    const changed = atomically(this.db, () =>
      events.flatMap((event) => {
        const row = read.get(who, event.id) as
          { updated_at: number } | undefined;
        if (!row || row.updated_at <= event.updated_at) return [];
        reopen.run(who, event.id);
        return [event.id];
      }),
    );
    if (changed.length) this.emitter.emit(who);
    return changed;
  }

  /** 这批事件里还没确认的编号。 */
  unacked(ids: readonly number[]): number[] {
    const get = this.db.prepare("SELECT acked_at FROM task_inbox WHERE id=?");
    return ids.filter((id) => {
      const row = get.get(id) as { acked_at: number | null } | undefined;
      return row !== undefined && row.acked_at === null;
    });
  }

  /**
   * 有可取事件立即返回；否则等到有事件、超时或服务关闭。
   * peek 只看不取：不记送达、不起租约，供唤醒通道判断空闲后再 deliver。
   */
  async wait(
    subscriber: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    options: {
      peek?: boolean;
      trackOnline?: boolean;
      all?: boolean;
      settleSeconds?: number;
    } = {},
  ): Promise<{
    events: InboxEvent[];
    timed_out: boolean;
    restarting?: boolean;
  }> {
    const who = ownerOf(subscriber, "as");
    if (options.trackOnline !== false) this.lastWait.set(who, this.now());
    const all = options.all === true;
    const settleMs = (options.settleSeconds ?? 0) * 1000;
    const take = () =>
      options.peek ? this.pending(who, BATCH_LIMIT, all) : this.take(who, all);
    const ready = this.pending(who, 1, all);
    if (
      (ready.length && (settleMs === 0 || timeoutSeconds <= 0)) ||
      (!ready.length && timeoutSeconds <= 0) ||
      this.closed
    )
      return {
        events: take(),
        timed_out: !ready.length,
        ...(this.closed ? { restarting: true } : {}),
      };
    const track = options.trackOnline !== false;
    if (track) this.waiting.set(who, (this.waiting.get(who) ?? 0) + 1);
    return new Promise((resolve) => {
      let settled = false;
      let collecting = Boolean(ready.length);
      let settleTimer: NodeJS.Timeout | undefined;
      if (collecting) settleTimer = setTimeout(() => finish(), settleMs);
      const finish = (restarting = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(lease);
        clearTimeout(settleTimer);
        this.emitter.off(who, check);
        this.emitter.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        if (track) {
          this.lastWait.set(who, this.now());
          const left = (this.waiting.get(who) ?? 1) - 1;
          if (left > 0) this.waiting.set(who, left);
          else this.waiting.delete(who);
        }
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
        const leaseIn = this.nextLeaseIn(who, all);
        lease =
          leaseIn !== undefined && leaseIn < timeoutSeconds * 1000
            ? setTimeout(check, leaseIn + 5)
            : undefined;
      };
      const check = () => {
        if (this.pending(who, 1, all).length) {
          if (settleMs === 0) finish();
          else if (!collecting) {
            collecting = true;
            settleTimer = setTimeout(() => finish(), settleMs);
          }
        } else arm();
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

  /** 读取知会摘要与确认在同一事务中，避免读过却重复出现在下次摘要。 */
  digest(subscriber: string, since?: number) {
    const who = ownerOf(subscriber, "as");
    return atomically(this.db, () => {
      const events: InboxEvent[] = [];
      let after = 0;
      while (true) {
        const rows = this.db
          .prepare(
            "SELECT * FROM task_inbox WHERE subscriber=? AND id>? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND level='info' AND updated_at>=? ORDER BY id LIMIT 200",
          )
          .all(who, after, since ?? 0) as InboxRow[];
        for (const row of rows) {
          after = row.id;
          events.push(view(row));
        }
        if (rows.length < 200) break;
      }
      const mark = this.db.prepare(
        "UPDATE task_inbox SET acked_at=? WHERE id=? AND acked_at IS NULL",
      );
      for (const event of events) mark.run(this.now(), event.id);
      return { items: summarizeEvents(events), acknowledged: events.length };
    });
  }

  /**
   * 订阅者在不在听（t242）：此刻有没有连接挂着 wait 或经注入在听（t243），最近一次在听是什么时候；
   * 服务重启后还没人来 wait 的，从服务起来算。后台唤醒与状态栏据此判断。
   */
  presence(subscriber: string): Presence {
    const who = ownerOf(subscriber, "as");
    return {
      waiting:
        (this.waiting.get(who) ?? 0) > 0 || this.listener(who) !== undefined,
      last_seen: this.lastWait.get(who) ?? this.startedAt,
    };
  }

  /**
   * 订阅者经别的通道在听（t243 `atrium secretary bridge`：Claude Code 会话，经注入）：
   * 有效期内算在听，后台兜底不另起秘书；续报即延期，stop 立即作废。
   */
  listen(subscriber: string, input: ListenInput): Listener | null {
    const who = ownerOf(subscriber, "as");
    if (input.stop) {
      this.heard.delete(who);
      return null;
    }
    const now = this.now();
    const listener = {
      via: input.via,
      since: this.listener(who)?.since ?? now,
      until: now + input.ttl_seconds * 1000,
    };
    this.heard.set(who, listener);
    this.lastWait.set(who, now);
    return listener;
  }

  /** 此刻经注入在听的；没有或已过期为 undefined。 */
  listener(subscriber: string): Listener | undefined {
    const who = ownerOf(subscriber, "as");
    const listener = this.heard.get(who);
    if (listener && listener.until > this.now()) return listener;
    if (listener) this.heard.delete(who);
    return undefined;
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

export function settleSeconds(value: unknown): number {
  if (value === undefined) return 30;
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || Number(value) > 300)
    throw usage("settle: 应为 0～300 的整数秒");
  return Number(value);
}

export function sinceTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    throw usage("since: 应为带时区的 ISO 时间，如 2026-09-27T10:00:00+08:00");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw usage("since: 应为带时区的 ISO 时间，如 2026-09-27T10:00:00+08:00");
  return parsed;
}

export type ListenInput =
  { stop: true } | { stop?: false; via: string; ttl_seconds: number };
export type Listener = { via: string; since: number; until: number };

/** 报「在听」的请求体：via 说明经什么在听（至多 80 字），ttl_seconds 10～600；stop 为 true 表示不听了。 */
export function listenInput(body: unknown): ListenInput {
  const fields =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (fields.stop === true) return { stop: true };
  if (fields.stop !== undefined && fields.stop !== false)
    throw usage("stop: 应为 true 或 false");
  const via = typeof fields.via === "string" ? fields.via.trim() : "";
  if (!via || via.length > 80 || /[\r\n]/.test(via))
    throw usage("via: 写经什么在听，一行、至多 80 字");
  const ttl = fields.ttl_seconds;
  if (
    typeof ttl !== "number" ||
    !Number.isInteger(ttl) ||
    ttl < 10 ||
    ttl > 600
  )
    throw usage("ttl_seconds: 应为 10～600 的整数秒");
  return { via, ttl_seconds: ttl };
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
