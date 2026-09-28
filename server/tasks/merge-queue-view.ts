import type { DatabaseSync } from "node:sqlite";
import {
  ETA_SAMPLES,
  ETA_WINDOW_MS,
  mergeEta,
  type MergeQueueView,
} from "./merge-eta.ts";

/**
 * 合入队列的长度与预计还要多久（t254，`top` 与状态栏用）：估算在 merge-eta.ts。
 * 三条有界查询：队列件数走 tasks_merge_queue；最近合入的任务按 id 倒序取一段（tasks_delivery_stage），
 * 它们的开始合入与已合入事件走 task_events_kind。
 */

/** 最近合入的任务往回看多少个（按任务号；取够 ETA_SAMPLES 个近期样本足够）。 */
const RECENT_TASKS = ETA_SAMPLES * 3;

export function mergeQueueView(
  db: DatabaseSync,
  now = Date.now(),
): MergeQueueView | null {
  const counts = db
    .prepare(
      "SELECT delivery_stage AS stage,COUNT(*) AS n FROM tasks WHERE delivery_stage IN ('merge_queued','merging') AND status='done' GROUP BY delivery_stage",
    )
    .all() as { stage: string; n: number }[];
  const waiting = counts.find((c) => c.stage === "merge_queued")?.n ?? 0;
  const mergingIds = counts.some((c) => c.stage === "merging")
    ? (
        db
          .prepare(
            "SELECT id FROM tasks WHERE delivery_stage='merging' AND status='done' ORDER BY id LIMIT 1",
          )
          .all() as { id: number }[]
      ).map((row) => row.id)
    : [];
  if (!waiting && !mergingIds.length) return null;
  const recent = (
    db
      .prepare(
        "SELECT id FROM tasks WHERE delivery_stage IN ('merged','online') ORDER BY id DESC LIMIT ?",
      )
      .all(RECENT_TASKS) as { id: number }[]
  ).map((row) => row.id);
  const ids = [...recent, ...mergingIds];
  const events = db
    .prepare(
      `SELECT task_id,kind,at FROM task_events WHERE task_id IN (${ids.map(() => "?").join(",")}) AND kind IN ('merge_started','merged') ORDER BY task_id,id`,
    )
    .all(...ids) as { task_id: number; kind: string; at: number }[];
  // 每个任务：最后一次开始合入，与它之后的已合入。
  const spans = new Map<number, { started?: number; merged?: number }>();
  for (const event of events) {
    const span = spans.get(event.task_id) ?? {};
    if (event.kind === "merge_started") {
      span.started = event.at;
      span.merged = undefined;
    } else if (span.started !== undefined) span.merged = event.at;
    spans.set(event.task_id, span);
  }
  const samples = recent
    .flatMap((id) => {
      const span = spans.get(id);
      return span?.started !== undefined &&
        span.merged !== undefined &&
        span.merged >= now - ETA_WINDOW_MS
        ? [{ at: span.merged, ms: span.merged - span.started }]
        : [];
    })
    .sort((a, b) => b.at - a.at)
    .map((sample) => sample.ms);
  const started = mergingIds.length
    ? spans.get(mergingIds[0]!)?.started
    : undefined;
  return mergeEta({
    waiting,
    merging: mergingIds.length
      ? { elapsed_ms: started !== undefined ? now - started : 0 }
      : null,
    samples,
  });
}
