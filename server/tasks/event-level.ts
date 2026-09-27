/** 事件分级只依赖事件内容；未知类型保持要处理，避免新事件被静默吞掉。 */
export type EventLevel = "action" | "info";

/**
 * 知会级事件类型；级别要写进 task_inbox.level 供 SQL 过滤（#t126），
 * 这里的集合是数据迁移回填时的来源，新事件在写入时就带上级别。
 */
export const INFORMATION_KINDS: ReadonlySet<string> = new Set([
  "merge_queued",
  "merge_returned",
  "merge_retry",
  "merge_rebased",
  "merge_started",
  "merge_check",
  "local_check_started",
  "local_check_running",
  "merged",
  "review_queued",
  "review_passed",
  "quota_switched",
  "quota_queued",
  "quota_cleared",
  "quota_restored",
  "transient_retry",
  "thinking_retry",
  "ci_success",
  "ci_pending",
  "patrol_finished",
  // 牵涉知会（#373）：让被牵涉部分的 leader 知道，不叫醒。
  "involved",
]);

export function eventLevel(kind: string, detail?: unknown): EventLevel {
  if (kind === "ready") {
    const data = detail as { auto?: unknown; unassigned?: unknown } | null;
    return data?.auto === true && data.unassigned !== true ? "info" : "action";
  }
  return INFORMATION_KINDS.has(kind) ? "info" : "action";
}

export type DigestItem = {
  task: string | null;
  summary: string;
  ids: number[];
};

/** 同一任务的过程事件压成一句话，保留不同任务的边界。 */
export function summarizeEvents(
  events: readonly {
    id: number;
    task: string | null;
    kind: string;
    count: number;
  }[],
): DigestItem[] {
  const groups = new Map<string, (typeof events)[number][]>();
  for (const event of events) {
    const key = event.task ?? `#${event.id}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups].map(([key, rows]) => {
    const returns = rows
      .filter((row) => row.kind === "merge_returned")
      .reduce((sum, row) => sum + row.count, 0);
    const kinds = new Set(rows.map((row) => row.kind));
    const progress: string[] = [];
    if (kinds.has("merge_queued")) progress.push("排队合入");
    if (kinds.has("merge_rebased")) progress.push("已 rebase");
    if (kinds.has("merge_check") || kinds.has("local_check_started"))
      progress.push("本地检查");
    const summary = kinds.has("merged")
      ? `${returns ? `退回 ${returns} 次后` : ""}合入`
      : [returns ? `退回 ${returns} 次` : "", ...progress]
          .filter(Boolean)
          .join("，") || [...kinds].join("、");
    return {
      task: rows[0]!.task,
      summary: `${key}：${summary}`,
      ids: rows.map((row) => row.id),
    };
  });
}
