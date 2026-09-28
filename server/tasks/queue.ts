import type { DatabaseSync } from "node:sqlite";
import { priorityOf, rankSql, type Priority } from "./priority.ts";

/**
 * 派活队列：想跑的任务一律落库排进这里（状态保持 todo），只有 `Executors.drain` 按「优先级、入队先后」取出拉起；
 * `TaskRunner.run` 与排期巡检只负责入队。落库是为了服务重启后接着排。
 */

export type QueueEntry = {
  task_id: number;
  tool: string;
  worker: string;
  risk: string;
  queued_at: number;
  /** 用户用 --host 指定的主机（#358）；自动挑的为 null，空出来时再挑。 */
  host_id?: number | null;
};

export function ensureQueueTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_queue (
      task_id INTEGER PRIMARY KEY,
      tool TEXT NOT NULL,
      worker TEXT NOT NULL,
      risk TEXT NOT NULL,
      queued_at INTEGER NOT NULL)`);
  const columns = db.prepare("PRAGMA table_info(task_queue)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "host_id"))
    db.exec("ALTER TABLE task_queue ADD COLUMN host_id INTEGER");
}

/** 入队；已在队里的换执行者与钉住的主机，入队时刻不变。 */
export function enqueue(db: DatabaseSync, entry: QueueEntry) {
  db.prepare(
    "INSERT INTO task_queue(task_id,tool,worker,risk,queued_at,host_id) VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET tool=excluded.tool,worker=excluded.worker,risk=excluded.risk,host_id=excluded.host_id",
  ).run(
    entry.task_id,
    entry.tool,
    entry.worker,
    entry.risk,
    entry.queued_at,
    entry.host_id ?? null,
  );
}

export function dequeue(db: DatabaseSync, taskId: number) {
  return (
    db.prepare("DELETE FROM task_queue WHERE task_id=?").run(taskId).changes > 0
  );
}

export function queued(db: DatabaseSync, taskId: number) {
  return db.prepare("SELECT * FROM task_queue WHERE task_id=?").get(taskId) as
    QueueEntry | undefined;
}

/**
 * 排队中的任务为什么排队（task ls / show / plan 显示用）：取最近一条 queued 事件的 reason；
 * 不在队列里为 null，事件缺失或写坏时给通用说法。
 */
export function queueView(
  db: DatabaseSync,
  taskId: number,
): { queued_reason: string | null } {
  if (!queued(db, taskId)) return { queued_reason: null };
  const row = db
    .prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='queued' ORDER BY id DESC LIMIT 1",
    )
    .get(taskId) as { detail: string | null } | undefined;
  try {
    const reason = (JSON.parse(row?.detail ?? "null") as { reason?: unknown })
      ?.reason;
    if (typeof reason === "string" && reason.trim())
      return { queued_reason: reason.trim() };
  } catch {
    // 历史上写坏的事件不该让列表失败。
  }
  return { queued_reason: "等待执行者可用后自动拉起" };
}

export type QueueItem = QueueEntry & { priority: Priority };

/** 一轮最多看多少条排队。 */
const QUEUE_SCAN = 1000;

/** 排着的任务，按拉起先后排好：优先级（紧急、修复、普通、闲时），同一档按入队先后，再按任务号。 */
export function pending(db: DatabaseSync): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT q.*,t.prio AS prio FROM task_queue q LEFT JOIN tasks t ON t.id=q.task_id
        ORDER BY ${rankSql("t.prio")},q.queued_at,q.task_id LIMIT ${QUEUE_SCAN}`,
    )
    .all() as (QueueEntry & { prio: string | null })[];
  return rows.map(({ prio, ...row }) => ({
    ...row,
    // 用户 --host 钉住的主机：drain 只往那台派。
    host_id: row.host_id ?? null,
    priority: priorityOf(prio),
  }));
}
