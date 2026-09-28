import { overdueInfo } from "../watch/overdue.ts";

/** 事件分级只依赖事件内容；未知类型保持要处理，避免新事件被静默吞掉。 */
export type EventLevel = "action" | "info";

/**
 * 知会级事件类型；级别要写进 task_inbox.level 供 SQL 过滤（#t126），
 * 这里的集合是数据迁移回填时的来源，新事件在写入时就带上级别。
 *
 * 改这个集合时必须同时补一次迁移，把库里已有行按新集合重算 level 回写：
 * 回填只在补列那一次做，之后 `view()` 只把 `level='info'` 当真，`level='action'`
 * 的旧行一律按当前集合/内容重算；不迁移就会让库里存的级别与 SQL 过滤、读出的 level 不一致。
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
  // 已上线：端到端验证在合入前做过，上线后只读冒烟没过另记 online_failed；库里旧行在 ensureEventTables 回写。
  "online",
  "quota_switched",
  "quota_queued",
  "quota_cleared",
  "quota_restored",
  "transient_retry",
  "thinking_retry",
  "ci_success",
  "ci_pending",
  // 选项单拍板了（合并掉还没处理的 choice_ready / choice_review，不必再为它醒）；
  // 拍板权已下放给 leader 时秘书收到的新选项单；有人给选项单写了意见。
  // 新增类型，库里没有旧行要按新集合重算，不需要迁移。
  "choice_decided",
  "choice_comment",
]);

export function eventLevel(kind: string, detail?: unknown): EventLevel {
  // 到期（overdue.ts）：执行者、检查到期由运行时自己处理，只作知会；叫醒 leader、上交、发版超时要处理。
  if (kind === "overdue") return overdueInfo(detail) ? "info" : "action";
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
    detail?: unknown;
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
