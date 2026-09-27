import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  all,
  taskRef,
  type TaskEventRow,
  type TaskRow,
} from "./ledger-model.ts";
import { FINISHED, type TaskStatus } from "./state.ts";
import { noteView, type NoteView } from "./notes.ts";
import { tellCounts } from "./tell-ledger.ts";
import { concernStates } from "./concerns.ts";
import type { ConcernState } from "./concern-gate.ts";

/**
 * 进行中任务的实时视图（#262 `atrium top`）：在跑、排队、受阻，加上最近 RECENT_MS 内结束的，
 * 不列历史。取行是有界的；筛选后的次序是纯函数，方便单独验。
 */

/** 结束后还在视图里停留多久：10 分钟。 */
export const RECENT_MS = 10 * 60_000;
/** 一次最多多少行（连同日志尾部读取都是有界的）。 */
export const TOP_MAX = 50;

export type TopRow = NoteView & {
  ref: string;
  title: string;
  /** 账本里的状态。 */
  status: TaskStatus;
  delivery_stage?: TaskRow["delivery_stage"];
  merge_queued_at?: number | null;
  worker: string | null;
  started_at: number | null;
  ended_at: number | null;
  /** 在队列里时的入队时刻；null 表示不在队列。 */
  queued_at: number | null;
  /** 排队或受阻的原因。 */
  reason: string | null;
  updated_at: number;
  /** 捎话条数与其中还没送达的（#307）；没有捎话为 null。 */
  tells: { total: number; pending: number } | null;
  /** 请了的专员与本轮结论（#322）；没请为 null。 */
  concerns?: ConcernState[] | null;
};

const FINISHED_STATUSES = [...FINISHED] as TaskStatus[];

/** 在跑、受阻、在队列里，或最近刚结束的；至多 limit + 1 行（多出来那行只用来判断截断）。 */
export function selectRows(
  db: DatabaseSync,
  now: number,
  recentMs = RECENT_MS,
  limit = TOP_MAX,
) {
  const params: SQLInputValue[] = [...FINISHED_STATUSES, now - recentMs];
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM tasks
      WHERE status IN ('running','blocked')
         OR delivery_stage IN ('reviewing','merge_queued','merging')
         OR id IN (SELECT task_id FROM task_queue)
         OR (status IN (${FINISHED_STATUSES.map(() => "?").join(",")})
             AND updated_at >= ?)
      ORDER BY id
      LIMIT ?`,
    ...params,
    limit + 1,
  );
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** 视图里的次序：在跑（跑得久的在前）、排队（入队顺序）、受阻（新在前）、刚结束（新在前）。 */
export function sortRows(rows: TopRow[]): TopRow[] {
  const group = (row: TopRow) =>
    row.queued_at !== null
      ? 1
      : row.delivery_stage === "merging" || row.delivery_stage === "reviewing"
        ? 0
        : row.status === "running"
          ? 0
          : row.delivery_stage === "merge_queued"
            ? 1
            : row.status === "blocked"
              ? 2
              : 3;
  const at = (row: TopRow) =>
    group(row) === 3
      ? -(row.delivery_stage === "merged" || row.delivery_stage === "online"
          ? row.updated_at
          : (row.ended_at ?? row.updated_at))
      : (row.queued_at ??
        row.merge_queued_at ??
        row.started_at ??
        row.updated_at);
  return [...rows].sort((a, b) => group(a) - group(b) || at(a) - at(b));
}

/**
 * 某类事件的 detail 里的 reason；没有或写坏了返回 null。
 * noteTask 记的事件（queued、stop_requested）把 reason 放在顶层，
 * 状态转移记的（block、exit_fail）包在 detail 里，两种形状都认。
 */
export function reasonOf(events: TaskEventRow[], kind: string) {
  const detail = events.findLast((event) => event.kind === kind)?.detail;
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as {
      reason?: unknown;
      detail?: { reason?: unknown } | null;
    };
    for (const value of [
      parsed.reason,
      parsed.detail && typeof parsed.detail === "object"
        ? parsed.detail.reason
        : undefined,
    ])
      if (typeof value === "string" && value.trim()) return value.trim();
    return null;
  } catch {
    // 历史上写坏的 detail 不该让整个看板失败。
    return null;
  }
}

/** 两类事件里哪一类更新（按自增 id）；都没有为 null。 */
function latestOf(events: TaskEventRow[], a: string, b: string) {
  const idOf = (kind: string) =>
    events.findLast((event) => event.kind === kind)?.id ?? 0;
  const [x, y] = [idOf(a), idOf(b)];
  return x === 0 && y === 0 ? null : x > y ? a : b;
}

/** 看板的每一行：账本字段 + 排队时刻与执行者 + 排队或受阻的原因。 */
export function topRows(
  db: DatabaseSync,
  now: number,
  recentMs = RECENT_MS,
  limit = TOP_MAX,
) {
  const selected = selectRows(db, now, recentMs, limit);
  const queue = new Map<number, { queued_at: number; worker: string | null }>();
  for (const entry of all<{
    task_id: number;
    queued_at: number;
    worker: string | null;
  }>(db, "SELECT task_id,queued_at,worker FROM task_queue"))
    queue.set(entry.task_id, {
      queued_at: entry.queued_at,
      worker: entry.worker,
    });
  const events = new Map<number, TaskEventRow[]>();
  const ids = selected.rows.map((row) => row.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    // 每个任务只留最近一条 queued 与 block；索引是 (task_id,id)，倒序取完再正序攒回去。
    for (const event of all<TaskEventRow>(
      db,
      `SELECT * FROM task_events WHERE task_id IN (${marks}) AND kind IN ('queued','block','concern_gate')
        ORDER BY task_id, id DESC`,
      ...ids,
    )) {
      const history = events.get(event.task_id) ?? [];
      if (!history.some((item) => item.kind === event.kind))
        history.push(event);
      events.set(event.task_id, history);
    }
  }
  const tells = tellCounts(db, ids);
  const concerns = concernStates(db, ids);
  const rows: TopRow[] = selected.rows.map((row) => {
    const history = events.get(row.id) ?? [];
    const waiting = queue.get(row.id);
    return {
      ref: taskRef(row.id),
      title: row.title,
      status: row.status,
      delivery_stage: row.delivery_stage,
      merge_queued_at: row.merge_queued_at,
      // 排队的任务账本里还没有执行者，用队列里记的那个。
      worker: row.worker ?? waiting?.worker ?? null,
      started_at: row.started_at,
      ended_at: row.ended_at,
      updated_at: row.updated_at,
      queued_at: waiting?.queued_at ?? null,
      reason:
        reasonOf(history, "queued") ??
        // 专员关卡的结论晚于受阻事件：否决或没出结论的原因以它为准。
        (latestOf(history, "concern_gate", "block") === "concern_gate" &&
        row.status === "blocked"
          ? reasonOf(history, "concern_gate")
          : reasonOf(history, "block")),
      tells: tells.get(row.id) ?? null,
      concerns: concerns.get(row.id) ?? null,
      ...noteView(db, row.id, row.status),
    };
  });
  return { rows: sortRows(rows), truncated: selected.truncated };
}

export type TopCounts = {
  running: number;
  queued: number;
  reviewing?: number;
  merge_queued?: number;
  merging?: number;
  merged?: number;
  blocked: number;
  processing: number;
  done: number;
  failed: number;
  cancelled: number;
};

/** 汇总用的计数：在途的三类与刚结束的三类；不在队列里的 todo 不会被选中，不计数。 */
export function countRows(rows: TopRow[]): TopCounts {
  const counts: TopCounts = {
    running: 0,
    queued: 0,
    blocked: 0,
    processing: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows)
    if (row.queued_at !== null) counts.queued++;
    else if (row.delivery_stage === "reviewing")
      counts.reviewing = (counts.reviewing ?? 0) + 1;
    else if (row.delivery_stage === "merge_queued")
      counts.merge_queued = (counts.merge_queued ?? 0) + 1;
    else if (row.delivery_stage === "merging")
      counts.merging = (counts.merging ?? 0) + 1;
    else if (row.delivery_stage === "merged")
      counts.merged = (counts.merged ?? 0) + 1;
    else if (row.status === "running") counts.running++;
    else if (row.status === "blocked") {
      if (row.processing) counts.processing++;
      else counts.blocked++;
    } else if (row.status !== "todo") counts[row.status]++;
  return counts;
}
