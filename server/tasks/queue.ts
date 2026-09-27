import type { DatabaseSync } from "node:sqlite";
import { ADAPTERS, type Tool } from "./adapters/index.ts";
import { queueOrder } from "./host-load.ts";
import { idleAheadAll, idleWaitText, isIdle } from "./priority.ts";

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
 * 排队中的任务为什么排队（task ls / show / plan 显示用）：闲时任务前面还有普通任务在等同一类执行者时，
 * 写「等空闲：前面还有 N 件普通任务」（按当下的队列现算）；其余取最近一条 queued 事件的 reason；
 * 不在队列里为 null，事件缺失或写坏时给通用说法。ahead 是 `idleWaits` 的结果，列表类调用方算一次传进来。
 */
export function queueView(
  db: DatabaseSync,
  taskId: number,
  ahead?: () => ReadonlyMap<number, number>,
): { queued_reason: string | null } {
  if (!queued(db, taskId)) return { queued_reason: null };
  const idle = (ahead ?? (() => idleWaits(db)))().get(taskId);
  if (idle) return { queued_reason: idleWaitText(idle) };
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

export type QueueHead = QueueEntry & { urgent: boolean; idle: boolean };

/**
 * 每个工具的队首，按拉起先后排好：紧急 → 普通 → 闲时，同一档按入队先后（host-load.ts queueOrder）。
 * 纯函数；drain 按这个顺序过闸门，普通任务被挡住时后面不会还有紧急的，闲时的排在最后。
 */
export function queueHeads(entries: readonly QueueHead[]): QueueHead[] {
  const order = (a: QueueHead, b: QueueHead) =>
    queueOrder(
      { urgent: a.urgent, idle: a.idle, at: a.queued_at, id: a.task_id },
      { urgent: b.urgent, idle: b.idle, at: b.queued_at, id: b.task_id },
    );
  const first = new Map<string, QueueHead>();
  for (const entry of [...entries].sort(order))
    if (!first.has(entry.tool)) first.set(entry.tool, entry);
  return [...first.values()].sort(order);
}

/** 一轮最多看多少条排队（按紧急、普通、闲时与入队先后取，队首一定在里面）。 */
const QUEUE_SCAN = 1000;

type ScanRow = QueueEntry & { urgent: number; priority: string | null };

function scan(db: DatabaseSync, tool?: string) {
  const rows = db
    .prepare(
      `SELECT q.*,COALESCE(t.urgent,0) AS urgent,t.priority AS priority FROM task_queue q LEFT JOIN tasks t ON t.id=q.task_id${tool ? " WHERE q.tool=?" : ""}
        ORDER BY COALESCE(t.urgent,0) DESC,(t.priority='idle' AND COALESCE(t.urgent,0)=0),q.queued_at,q.task_id LIMIT ${QUEUE_SCAN}`,
    )
    .all(...(tool ? [tool] : [])) as ScanRow[];
  return rows.map((row) => ({
    task_id: row.task_id,
    tool: row.tool,
    worker: row.worker,
    risk: row.risk,
    queued_at: row.queued_at,
    urgent: row.urgent === 1,
    idle: isIdle(row),
  }));
}

/** 某工具下一个该跑的；不给工具时返回每个工具的队首（紧急的在前、闲时的在后）。 */
export function heads(db: DatabaseSync, tool?: string): QueueHead[] {
  return queueHeads(scan(db, tool));
}

/** 在排队的普通（含紧急）任务各用哪个工具；闲时任务派不派据此判断（priority.ts idleAhead）。 */
export function queuedNormals(db: DatabaseSync, except?: number) {
  return scan(db).filter((row) => !row.idle && row.task_id !== except);
}

/** 独占工具的普通任务多半在等那个工具空出来，看板上不算挡着别的工具（运行时按真实忙闲判断）。 */
const exclusiveTool = (tool: string) =>
  !!(ADAPTERS as Record<string, { exclusive?: boolean } | undefined>)[
    tool as Tool
  ]?.exclusive;

/** 队列里每件闲时任务前面还有几件普通任务（看板与列表显示用，一次查询、线性计算）。 */
export function idleWaits(db: DatabaseSync): Map<number, number> {
  return idleAheadAll(scan(db), exclusiveTool);
}
