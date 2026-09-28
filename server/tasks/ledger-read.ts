import { taskSecretNames } from "../secrets/store.ts";
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
import { rollupFor, rollups } from "./rollup-ledger.ts";
import { conditions } from "./schedule-ledger.ts";
import { noteView } from "./notes.ts";
import { queued, queueView } from "./queue.ts";
import { CHECK_EVENT_KINDS, checkSummary } from "./check-outcome.ts";

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
  // 总任务（t190）：状态与进度按全部子孙汇总；球在子任务手里，不给持球人。
  const rollup = child_summary ? rollupFor(db, found.id) : null;
  const queue = queueView(db, found.id);
  const secrets = taskSecretNames(db, found.id);
  return {
    ...view(found),
    ...noteView(db, found.id, found.status),
    ...queue,
    holder: rollup
      ? null
      : (holderFor(
          db,
          found,
          queued(db, found.id) ? { reason: queue.queued_reason } : null,
        ) ?? null),
    children: child_summary?.total ?? 0,
    child_summary,
    rollup,
    last_check: lastCheck(db, found.id),
    events,
    ...conditions(db, found.id),
    ...(secrets.length ? { secrets } : {}),
  };
}

/** 最近一次本地检查说成一句话（t204）：过、没过、没跑成（等重跑或基础设施问题）。 */
function lastCheck(db: DatabaseSync, id: number): string | null {
  const row = all<TaskEventRow>(
    db,
    `SELECT * FROM task_events WHERE task_id=? AND kind IN (${CHECK_EVENT_KINDS.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`,
    id,
    ...CHECK_EVENT_KINDS,
  )[0];
  if (!row) return null;
  try {
    const detail: unknown = JSON.parse(row.detail ?? "null");
    return detail && typeof detail === "object"
      ? checkSummary({
          kind: row.kind,
          detail: detail as Record<string, unknown>,
        })
      : null;
  } catch {
    return null;
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
  const page = rows.slice(0, limit);
  const totals = rollups(
    db,
    page.map((row) => row.id),
  );
  const tasks = page.map((row) => ({
    ...listView(row),
    ...noteView(db, row.id, row.status),
    ...queueView(db, row.id),
    rollup: totals.get(row.id) ?? null,
  }));
  return { tasks, next_after: more ? tasks.at(-1)!.ref : null };
}
