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
import { holderFacts } from "./holder-facts.ts";
import { holderOf, type Holder } from "./holder.ts";
import { runningHostNames } from "../hosts/model.ts";
import { idleWaits } from "./queue.ts";
import { idleWaitText, isIdle } from "./priority.ts";
import { rollups } from "./rollup-ledger.ts";
import { progressOf } from "./rollup.ts";
import { urgentInMergeFlow } from "./urgent-ledger.ts";
import {
  VERIFY_TOP_SQL,
  verifyParents,
  verifyTopSince,
  verifyViews,
} from "./verify-runtime.ts";
import { verifyHolder, type VerifyView } from "./verify-view.ts";

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
  /** 在远程主机上跑（#358，hN）；本机或没在跑为 null。 */
  host?: string | null;
  host_name?: string | null;
  started_at: number | null;
  ended_at: number | null;
  /** 在队列里时的入队时刻；null 表示不在队列。 */
  queued_at: number | null;
  /** 排队或受阻的原因。 */
  reason: string | null;
  /** 标了紧急（t113）。 */
  urgent: boolean;
  /** 闲时（t136）：排在普通任务后面，有空闲执行者才派；标了紧急的不算。 */
  idle: boolean;
  updated_at: number;
  /** 捎话条数与其中还没送达的（#307）；没有捎话为 null。 */
  tells: { total: number; pending: number } | null;
  /** 请了的专员与本轮结论（#322）；没请为 null。 */
  concerns?: ConcernState[] | null;
  /** 现在球在谁手里（holder.ts）；已结束的为 null。 */
  holder?: Holder | null;
  /** 本地检查正在跑（交付后或合入重跑，#358 第 2 步）：在哪台；没在跑为 null。 */
  checking?: { host: string | null } | null;
  /** 最近的总任务（t190）：父任务的短号、标题与汇总进度；不在总任务下为 null，旧版服务不给。 */
  total?: TopTotal | null;
  /** 上线后的端到端验证（t182）：验证中、没通过、无法验证、通过；没做验证为 null，旧版服务不给。 */
  verify?: VerifyView | null;
  /** 这是上线验证任务：验证的是哪个任务（tN）；不是为 null。 */
  verify_of?: string | null;
};

export type TopTotal = {
  ref: string;
  title: string;
  /** 已上线或完成的叶子 / 叶子数（不算取消的），如「5/12」。 */
  progress: string;
};

/** 在看板上的行按最近的总任务（父任务）分组：一次取父任务标题、一次算汇总。 */
function totalsOf(db: DatabaseSync, rows: readonly TaskRow[]) {
  const parents = [
    ...new Set(
      rows.flatMap((row) =>
        row.parent_id !== null && !row.helper ? [row.parent_id] : [],
      ),
    ),
  ];
  const result = new Map<number, TopTotal>();
  if (!parents.length) return result;
  const summaries = rollups(db, parents);
  for (const parent of all<{ id: number; title: string }>(
    db,
    `SELECT id,title FROM tasks WHERE id IN (${parents.map(() => "?").join(",")})`,
    ...parents,
  )) {
    const rollup = summaries.get(parent.id);
    if (rollup)
      result.set(parent.id, {
        ref: taskRef(parent.id),
        title: parent.title,
        progress: progressOf(rollup),
      });
  }
  return result;
}

const FINISHED_STATUSES = [...FINISHED] as TaskStatus[];

/** 在跑、受阻、在队列里，或最近刚结束的；至多 limit + 1 行（多出来那行只用来判断截断）。 */
export function selectRows(
  db: DatabaseSync,
  now: number,
  recentMs = RECENT_MS,
  limit = TOP_MAX,
) {
  const params: SQLInputValue[] = [
    verifyTopSince(now),
    ...FINISHED_STATUSES,
    now - recentMs,
  ];
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM tasks
      WHERE status IN ('running','blocked')
         OR delivery_stage IN ('reviewing','merge_queued','merging')
         OR (delivery_stage='merged' AND online_wait=1)
         OR id IN (SELECT task_id FROM task_councils WHERE stage='escalated')
         OR id IN (SELECT task_id FROM task_queue)
         OR id IN (${VERIFY_TOP_SQL})
         OR (status IN (${FINISHED_STATUSES.map(() => "?").join(",")})
             AND updated_at >= ?)
      ORDER BY id
      LIMIT ?`,
    ...params,
    limit + 1,
  );
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** 上线验证没通过或无法验证（t182）：和受阻的排在一起。 */
const verifyTrouble = (row: TopRow) =>
  row.verify?.state === "failed" || row.verify?.state === "unverifiable";

/** 视图里的次序：在跑（跑得久的在前）、排队（入队顺序）、受阻与验证没过（新在前）、刚结束（新在前）。 */
export function sortRows(rows: TopRow[]): TopRow[] {
  const group = (row: TopRow) =>
    verifyTrouble(row)
      ? 2
      : row.queued_at !== null
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
    verifyTrouble(row)
      ? -(row.verify?.decided_at ?? row.updated_at)
      : group(row) === 3
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
  // 闲时任务在等什么按当下的队列现算（一次查询）；没有排队的就不读。
  const ahead = queue.size ? idleWaits(db) : new Map<number, number>();
  const tells = tellCounts(db, ids);
  const concerns = concernStates(db, ids);
  const inbox = !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_inbox'",
    )
    .get();
  const totals = totalsOf(db, selected.rows);
  const hosts = runningHostNames(
    db,
    selected.rows.map((row) => (row.status === "running" ? row.host_id : null)),
    now,
  );
  // 紧急任务在合入流程里时普通任务的合入暂停（t215）：一次查出，各行共用。
  const urgentFlow = urgentInMergeFlow(db);
  // 上线验证（t182）：已上线的原任务的验证状态、哪些行是验证任务，各一次查出。
  const verifies = verifyViews(
    db,
    selected.rows
      .filter((row) => row.delivery_stage === "online")
      .map((row) => row.id),
  );
  const verifyOf = verifyParents(
    db,
    selected.rows.filter((row) => row.helper).map((row) => row.id),
  );
  const rows: TopRow[] = selected.rows.map((row) => {
    const history = events.get(row.id) ?? [];
    const waiting = queue.get(row.id);
    const idleAhead = waiting ? ahead.get(row.id) : undefined;
    const queuedReason = idleAhead
      ? idleWaitText(idleAhead)
      : reasonOf(history, "queued");
    return {
      ref: taskRef(row.id),
      title: row.title,
      status: row.status,
      delivery_stage: row.delivery_stage,
      merge_queued_at: row.merge_queued_at,
      // 排队的任务账本里还没有执行者，用队列里记的那个。
      worker: row.worker ?? waiting?.worker ?? null,
      host:
        row.status === "running" && row.host_id != null && row.host_id !== 1
          ? `h${row.host_id}`
          : null,
      host_name:
        row.status === "running" ? (hosts.get(row.host_id ?? 0) ?? null) : null,
      started_at: row.started_at,
      ended_at: row.ended_at,
      updated_at: row.updated_at,
      queued_at: waiting?.queued_at ?? null,
      urgent: row.urgent === 1,
      idle: isIdle(row),
      reason:
        queuedReason ??
        // 专员关卡的结论晚于受阻事件：否决或没出结论的原因以它为准。
        (latestOf(history, "concern_gate", "block") === "concern_gate" &&
        row.status === "blocked"
          ? reasonOf(history, "concern_gate")
          : reasonOf(history, "block")),
      tells: tells.get(row.id) ?? null,
      concerns: concerns.get(row.id) ?? null,
      total:
        row.parent_id !== null && !row.helper
          ? (totals.get(row.parent_id) ?? null)
          : null,
      verify: verifies.get(row.id) ?? null,
      verify_of: verifyOf.get(row.id) ?? null,
      ...(() => {
        const facts = holderFacts(
          db,
          row,
          waiting ? { reason: queuedReason } : null,
          { inbox, urgentFlow },
          hosts,
        );
        return {
          // 已上线的任务在验证上的持球人（验证执行者、收到没通过事件的负责人）。
          holder: holderOf(facts) ?? verifyHolder(verifies.get(row.id) ?? null),
          checking: facts.checking ?? null,
        };
      })(),
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
  online?: number;
  /** 上线后的端到端验证（t182）：验证中、没通过、无法验证的原任务；不再算进 online。 */
  verifying?: number;
  verify_failed?: number;
  unverifiable?: number;
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
    else if (row.verify?.state === "running")
      counts.verifying = (counts.verifying ?? 0) + 1;
    else if (row.verify?.state === "failed")
      counts.verify_failed = (counts.verify_failed ?? 0) + 1;
    else if (row.verify?.state === "unverifiable")
      counts.unverifiable = (counts.unverifiable ?? 0) + 1;
    else if (row.delivery_stage === "online")
      counts.online = (counts.online ?? 0) + 1;
    else if (row.status === "running") counts.running++;
    else if (row.status === "blocked") {
      if (row.processing) counts.processing++;
      // 被紧急任务抢占暂停的（t215）运行时会自己续上，算排队，不算卡住。
      else if (row.holder?.kind === "queue") counts.queued++;
      else counts.blocked++;
    } else if (row.status !== "todo") counts[row.status]++;
  return counts;
}
