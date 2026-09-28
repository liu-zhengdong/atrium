import type { DatabaseSync } from "node:sqlite";
import type { CheckClass } from "./check-outcome.ts";
import type { Precheck } from "./merge-precheck-plan.ts";

/**
 * 合入队列从任务事件里读的几样事实（t254）：上次 rebase 到哪个提交、这次排队以来的提前检查。
 * 每个查询走 task_events_kind(task_id,kind,id)，有界。
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

/** 这次排队（最近一条 merge_queued）之后的事件 id 下界。 */
const SINCE_QUEUED =
  "(SELECT COALESCE(MAX(id),0) FROM task_events WHERE task_id=? AND kind='merge_queued')";

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

/** 提前检查的完整记录：判定用的三项，加上写进 merge_check 事件、交回原因用的检查结果。 */
export type PrecheckRecord = Precheck & { detail: Record<string, unknown> };

const OUTCOMES = new Set<CheckClass>(["passed", "failed", "not_run"]);

/** 这次排队以来最近一次提前检查；没有或记录写坏为 null。 */
export function latestPrecheck(
  db: DatabaseSync,
  id: number,
): PrecheckRecord | null {
  const row = db
    .prepare(
      `SELECT detail FROM task_events WHERE task_id=? AND kind='merge_prechecked' AND id>${SINCE_QUEUED} ORDER BY id DESC LIMIT 1`,
    )
    .get(id, id) as { detail: string | null } | undefined;
  const detail = parse(row?.detail ?? null);
  if (!detail) return null;
  const { head, base, outcome } = detail;
  if (
    typeof head !== "string" ||
    typeof base !== "string" ||
    !OUTCOMES.has(outcome as CheckClass)
  )
    return null;
  return { head, base, outcome: outcome as CheckClass, detail };
}

/** 这批任务里这次排队以来已经提前检查过（有结果或跳过）的。 */
export function prechecked(
  db: DatabaseSync,
  ids: readonly number[],
): Set<number> {
  if (!ids.length) return new Set();
  const rows = db
    .prepare(
      `SELECT DISTINCT e.task_id AS id FROM task_events e
        WHERE e.task_id IN (${ids.map(() => "?").join(",")})
          AND e.kind IN ('merge_prechecked','merge_precheck_skipped')
          AND e.id>(SELECT COALESCE(MAX(q.id),0) FROM task_events q WHERE q.task_id=e.task_id AND q.kind='merge_queued')`,
    )
    .all(...ids) as { id: number }[];
  return new Set(rows.map((row) => row.id));
}
