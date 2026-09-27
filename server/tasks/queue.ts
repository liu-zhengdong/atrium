import type { DatabaseSync } from "node:sqlite";

/**
 * 独占执行者的排队（#262「并发限制」）：适配器 exclusive=true 时同一工具同一时刻只跑一个，
 * 其余落库排队（状态保持 todo），前一个退出后按入队顺序拉起。落库是为了服务重启后接着排。
 */

export type QueueEntry = {
  task_id: number;
  tool: string;
  worker: string;
  risk: string;
  queued_at: number;
};

export function ensureQueueTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_queue (
      task_id INTEGER PRIMARY KEY,
      tool TEXT NOT NULL,
      worker TEXT NOT NULL,
      risk TEXT NOT NULL,
      queued_at INTEGER NOT NULL)`);
}

export function enqueue(db: DatabaseSync, entry: QueueEntry) {
  db.prepare(
    "INSERT INTO task_queue(task_id,tool,worker,risk,queued_at) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET tool=excluded.tool,worker=excluded.worker,risk=excluded.risk",
  ).run(entry.task_id, entry.tool, entry.worker, entry.risk, entry.queued_at);
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

/** 某工具下一个该跑的；不给工具时返回每个工具的队首。 */
export function heads(db: DatabaseSync, tool?: string): QueueEntry[] {
  return (
    tool
      ? db
          .prepare(
            "SELECT * FROM task_queue WHERE tool=? ORDER BY queued_at,task_id LIMIT 1",
          )
          .all(tool)
      : db
          .prepare(
            "SELECT q.* FROM task_queue q WHERE NOT EXISTS (SELECT 1 FROM task_queue p WHERE p.tool=q.tool AND (p.queued_at<q.queued_at OR (p.queued_at=q.queued_at AND p.task_id<q.task_id))) ORDER BY queued_at",
          )
          .all()
  ) as QueueEntry[];
}
