import type { DatabaseSync } from "node:sqlite";

/**
 * 合入队列从任务事件里读的事实：上次 rebase 到哪个提交。走 task_events_kind(task_id,kind,id)，有界。
 */

const parse = (detail: string | null): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(detail ?? "null");
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * 合入队列最近一次 rebase 出的提交（执行者最近一次开始之后；之后执行者再动过工作树就不算）。
 * 工作树的提交与 PR 头不一致时，只有它等于这个才说明是合入队列自己 rebase 的。损坏记录不可信，返回空串。
 */
export function lastRebased(db: DatabaseSync, id: number): string {
  const row = db
    .prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='merge_rebased' AND id>(SELECT COALESCE(MAX(id),0) FROM task_events WHERE task_id=? AND kind='start') ORDER BY id DESC LIMIT 1",
    )
    .get(id, id) as { detail: string | null } | undefined;
  const head = parse(row?.detail ?? null)?.head;
  return typeof head === "string" ? head : "";
}
