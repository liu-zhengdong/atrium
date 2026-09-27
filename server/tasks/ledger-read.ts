import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  all,
  parseTaskRef,
  requireRow,
  view,
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
import { queueView } from "./queue.ts";

const EVENTS_SHOWN = 50;

export function getTask(db: DatabaseSync, reference: unknown) {
  const found = requireRow(db, parseTaskRef(reference));
  const events = all<TaskEventRow>(
    db,
    "SELECT * FROM (SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
    found.id,
    EVENTS_SHOWN,
  );
  const child_summary = childSummaries(db, [found.id]).get(found.id) ?? null;
  return {
    ...view(found),
    ...noteView(db, found.id, found.status),
    ...queueView(db, found.id),
    children: child_summary?.total ?? 0,
    child_summary,
    events,
    ...conditions(db, found.id),
  };
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
  const tasks = rows.slice(0, limit).map((row) => ({
    ...view(row),
    ...noteView(db, row.id, row.status),
    ...queueView(db, row.id),
  }));
  return { tasks, next_after: more ? tasks.at(-1)!.ref : null };
}
