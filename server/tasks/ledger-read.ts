import { involvedOf, involvedView } from "./also.ts";
import { holderFor } from "./holder-facts.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  all,
  parseTaskRef,
  requireRow,
  view,
  listView,
  LIST_LIMIT,
  LIST_MAX,
  type TaskEventRow,
  type TaskRow,
  usage,
} from "./ledger-model.ts";
import { parentOf, statusOf } from "./ledger-validate.ts";
import { childSummaries } from "./ledger-summary.ts";
import { conditions } from "./schedule-ledger.ts";
import { noteView } from "./notes.ts";
import { idleWaits, queued, queueView } from "./queue.ts";
import { concernsOf } from "./concerns.ts";
import type { InviteHint } from "./concern-gate.ts";

const EVENTS_SHOWN = 50;

/** 只算一次、要时才算（列表里没有排队的任务就不读队列）。 */
export function once<T>(compute: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: compute() }).v;
}

export function getTask(db: DatabaseSync, reference: unknown) {
  const found = requireRow(db, parseTaskRef(reference));
  const events = all<TaskEventRow>(
    db,
    "SELECT * FROM (SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
    found.id,
    EVENTS_SHOWN,
  );
  const child_summary = childSummaries(db, [found.id]).get(found.id) ?? null;
  const concerns = concernsOf(db, found.id);
  const hints = lastHints(db, found.id);
  const queue = queueView(db, found.id);
  return {
    ...view(found),
    ...noteView(db, found.id, found.status),
    ...queue,
    holder: holderFor(
      db,
      found,
      queued(db, found.id) ? { reason: queue.queued_reason } : null,
    ),
    children: child_summary?.total ?? 0,
    child_summary,
    events,
    ...conditions(db, found.id),
    ...(concerns.length ? { concerns } : {}),
    ...(hints.length ? { concern_hints: hints } : {}),
    ...involvedView(involvedOf(db, found)),
  };
}

/** 最近一次交付后按改动范围给的「要不要请某专员」提示。 */
function lastHints(db: DatabaseSync, id: number): InviteHint[] {
  const row = all<TaskEventRow>(
    db,
    "SELECT * FROM task_events WHERE task_id=? AND kind='concern_hints' ORDER BY id DESC LIMIT 1",
    id,
  )[0];
  try {
    const hints = row?.detail ? JSON.parse(row.detail).hints : undefined;
    return Array.isArray(hints) ? hints : [];
  } catch {
    return [];
  }
}

export function listTasks(
  db: DatabaseSync,
  query: {
    parent?: unknown;
    status?: unknown;
    after?: unknown;
    limit?: unknown;
  },
) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (query.parent !== undefined && query.parent !== "") {
    where.push("parent_id=?");
    params.push(parentOf(db, query.parent));
  }
  if (query.status !== undefined && query.status !== "") {
    where.push("status=?");
    params.push(statusOf(query.status));
  }
  if (query.after !== undefined && query.after !== "") {
    where.push("id>?");
    params.push(parseTaskRef(query.after, "after"));
  }
  let limit = LIST_LIMIT;
  if (query.limit !== undefined && query.limit !== "") {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX)
      throw usage(`limit: 应为 1～${LIST_MAX} 的整数`);
  }
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`,
    ...params,
    limit + 1,
  );
  const more = rows.length > limit;
  const ahead = once(() => idleWaits(db));
  const tasks = rows.slice(0, limit).map((row) => ({
    ...listView(row),
    ...noteView(db, row.id, row.status),
    ...queueView(db, row.id, ahead),
  }));
  return { tasks, next_after: more ? tasks.at(-1)!.ref : null };
}
