import { urgentAlert } from "./urgent.ts";

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
  // 选项单拍板了（合并掉还没处理的 choice_ready / choice_review，不必再为它醒）；
  // 拍板权已下放给 leader 时秘书收到的新选项单；有人给选项单写了意见。
  // 新增类型，库里没有旧行要按新集合重算，不需要迁移。
  "choice_decided",
  "choice_notice",
  "choice_comment",
  // 紧急通道（t215）：被抢占暂停、续上、换人、合入让路与暂停、标了紧急的知会；紧急任务自己的阶段另投 urgent_stage（级别见 eventLevel）。
  // 新增类型，库里没有旧行要按新集合重算，不需要迁移。
  "preempted",
  "resumed",
  "urgent_swap",
  "urgent_marked",
  "merge_paused",
  "merge_yielded",
  // 没进展提醒（t260）：检查日志、执行者 5 分钟没输出，知会负责的 leader；卡死、没过另有事件叫醒。
  // 新增类型，库里没有旧行要按新集合重算，不需要迁移。
  "check_quiet",
  "worker_quiet",
]);

/**
 * 已派人做上线验证的「已上线」只是知会（t182）：通过就结束，没通过、无法验证另投 verify_* 叫醒负责人。
 * 没有验证任务的（PR 没写端到端验证、验证任务建不起来）仍要处理：负责人得自己验证。
 * 这条按内容判，库里此前的行在 ensureEventTables 里补一次回写。
 */
export const isVerifiedOnline = (kind: string, detail?: unknown) =>
  kind === "online" &&
  typeof (detail as { verifier?: unknown } | null | undefined)?.verifier ===
    "string";

export function eventLevel(kind: string, detail?: unknown): EventLevel {
  if (isVerifiedOnline(kind, detail)) return "info";
  // 紧急任务的阶段（t219）：只有上线、卡住、止损失败要处理，其余是知会。
  // 已存的 urgent_stage 行由 events.ts 的 relevelUrgent 按这条规则重算。
  if (kind === "urgent_stage") {
    const data = (detail ?? {}) as Record<string, unknown>;
    return typeof data.event === "string" && urgentAlert(data.event, data)
      ? "action"
      : "info";
  }
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
    // 紧急任务的知会阶段（t219）：说到了哪一步。
    const stage = rows
      .filter((row) => row.kind === "urgent_stage")
      .map((row) => (row.detail as { stage?: unknown } | null)?.stage)
      .findLast((value) => typeof value === "string");
    if (stage) progress.push(`紧急·${stage}`);
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
