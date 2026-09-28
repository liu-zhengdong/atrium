import type { DatabaseSync } from "node:sqlite";
import { TASK_STATUSES, type TaskStatus } from "./state.ts";
import { all } from "./ledger-model.ts";

/** Counts of immediate children; the parent's own status is independent. */
export type ChildSummary = { total: number } & Record<TaskStatus, number>;

export function emptyChildSummary(): ChildSummary {
  return {
    total: 0,
    todo: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
}

type CountRow = { parent_id: number; status: TaskStatus; count: number };

/** One bounded aggregate query per batch, including children omitted by tree truncation. */
export function childSummaries(db: DatabaseSync, parentIds: number[]) {
  const summaries = new Map<number, ChildSummary>();
  for (let offset = 0; offset < parentIds.length; offset += 400) {
    const ids = parentIds.slice(offset, offset + 400);
    const rows = all<CountRow>(
      db,
      `SELECT parent_id, status, COUNT(*) AS count FROM tasks
       WHERE parent_id IN (${ids.map(() => "?").join(",")})
       GROUP BY parent_id, status`,
      ...ids,
    );
    for (const { parent_id, status, count } of rows) {
      const summary = summaries.get(parent_id) ?? emptyChildSummary();
      summary[status] += count;
      summary.total += count;
      summaries.set(parent_id, summary);
    }
  }
  return summaries;
}

export const CHILD_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "待办",
  running: "进行中",
  done: "完成",
  failed: "失败",
  blocked: "受阻",
  cancelled: "取消",
};

export function formatChildSummary(summary: ChildSummary): string {
  return TASK_STATUSES.filter((status) => summary[status] > 0)
    .map(
      (status) =>
        `${CHILD_STATUS_LABELS[status]} ${summary[status]}/${summary.total}`,
    )
    .join(" · ");
}
