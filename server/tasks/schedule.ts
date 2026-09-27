import type { DatabaseSync } from "node:sqlite";
import { advanceTask, getTask, noteTask, type Task } from "./ledger.ts";
import { all, taskRef, usage, view, type TaskRow } from "./ledger-model.ts";
import { conditions } from "./schedule-ledger.ts";
import type { EventInbox } from "./events.ts";
import type { Exec } from "./git.ts";
import { dequeue, queued, queueView } from "./queue.ts";
import { noteView } from "./notes.ts";
import {
  dependencyOf,
  refreshUpstreamPrs,
  type Dependency,
} from "./schedule-upstream.ts";
import { planDetails, type PlanDetail } from "./plan-view.ts";
import { taskRoute } from "../leaders/subscriber.ts";

export type ScheduleGroup = "running" | "ready" | "waiting" | "blocked";
export type PlanItem = {
  task: Task;
  group: ScheduleGroup;
  waiting_for: string[];
  reason: string | null;
};

/** 上游 done 且交付 PR 时，PR 合入才算满足；PR 关闭未合入与上游失败一样卡住下游。 */
function upstreamProblem(dep: Dependency): string | null {
  if (dep.status === "failed" || dep.status === "cancelled")
    return `${dep.ref} [${dep.status}]`;
  if (dep.status === "done" && dep.pr?.state === "closed")
    return `${dep.ref} 的 PR #${dep.pr.number} 已关闭未合入`;
  return null;
}

function upstreamWait(dep: Dependency): string | null {
  if (dep.status !== "done") return `${dep.ref} [${dep.status}]`;
  if (!dep.pr || dep.pr.state === "merged" || dep.pr.state === "closed")
    return null;
  const note = dep.pr.error
    ? `（查询失败：${dep.pr.error}）`
    : dep.pr.state === null
      ? "（尚未查询）"
      : "";
  return `${dep.ref} 的 PR #${dep.pr.number} 合入${note}`;
}

/** 状态判定不碰 IO；任一上游失败或取消时，整条任务链都不能就绪。 */
export function classify(
  status: TaskRow["status"],
  dependencies: Dependency[],
  prs: { ref: string; merged: boolean }[],
  reason: string | null = null,
): Pick<PlanItem, "group" | "waiting_for" | "reason"> {
  if (status === "running")
    return { group: "running", waiting_for: [], reason: null };
  const failed = dependencies
    .map(upstreamProblem)
    .filter((text): text is string => text !== null);
  const waiting = [
    ...dependencies
      .map(upstreamWait)
      .filter((text): text is string => text !== null),
    ...prs.filter((pr) => !pr.merged).map((pr) => `${pr.ref} 未合入`),
  ];
  if (failed.length)
    return {
      group: "blocked",
      waiting_for: waiting,
      reason: `上游 ${failed.join("、")}`,
    };
  if (status === "blocked" && !reason?.startsWith("上游 "))
    return {
      group: "blocked",
      waiting_for: waiting,
      reason: reason ?? "任务受阻",
    };
  if (status === "failed")
    return {
      group: "blocked",
      waiting_for: waiting,
      reason: reason ?? "任务失败",
    };
  if (waiting.length)
    return { group: "waiting", waiting_for: waiting, reason: null };
  return { group: "ready", waiting_for: [], reason: null };
}

export function planItem(db: DatabaseSync, row: TaskRow): PlanItem {
  const deps = conditions(db, row.id);
  const tasks = deps.after.map((ref) => dependencyOf(db, Number(ref.slice(1))));
  const prs = deps.after_pr.map((pr) => ({
    ref: `${pr.repo}#${pr.number}${pr.error ? `（查询失败：${pr.error}）` : ""}`,
    merged: pr.merged,
  }));
  return {
    task: {
      ...view(row),
      ...noteView(db, row.id, row.status),
      ...queueView(db, row.id),
    },
    ...classify(row.status, tasks, prs, row.schedule_reason),
  };
}

export function taskPlan(db: DatabaseSync, after = 0, limit = 200) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw usage("plan: after 应为非负整数，limit 应为 1～500");
  const rows = all<TaskRow>(
    db,
    "SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') ORDER BY id LIMIT ?",
    after,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const details = planDetails(db, page);
  // 细节是只读附加字段（top 的排期段用）；分组判定仍只看 planItem。
  const items: (PlanItem & PlanDetail)[] = page.map((row) => ({
    ...planItem(db, row),
    ...details.get(row.id)!,
  }));
  return {
    groups: {
      running: items.filter((item) => item.group === "running"),
      ready: items.filter((item) => item.group === "ready"),
      waiting: items.filter((item) => item.group === "waiting"),
      blocked: items.filter((item) => item.group === "blocked"),
    },
    next_after: rows.length > limit ? taskRef(rows[limit - 1]!.id) : null,
  };
}

export class Scheduler {
  private busy = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly inbox: EventInbox,
    private readonly run: (ref: string) => Promise<unknown>,
    private readonly exec: Exec,
  ) {}

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      // 有界扫描；游标循环覆盖任意规模账本。
      let after = 0;
      for (;;) {
        const rows = all<TaskRow>(
          this.db,
          `SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') AND (auto=1 OR schedule_state IS NOT NULL OR EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=tasks.id) OR EXISTS(SELECT 1 FROM task_pr_dependencies WHERE task_id=tasks.id)) ORDER BY id LIMIT 200`,
          after,
        );
        if (!rows.length) break;
        for (const row of rows) {
          after = row.id;
          await this.refreshPrs(row.id, now);
          await refreshUpstreamPrs(this.db, row.id, now, this.exec);
          const item = planItem(this.db, {
            ...row,
            ...(this.db
              .prepare(
                "SELECT status,schedule_state,schedule_reason FROM tasks WHERE id=?",
              )
              .get(row.id) as TaskRow),
          });
          const state =
            item.group === "waiting"
              ? "waiting"
              : item.group === "blocked"
                ? "blocked"
                : item.group === "ready"
                  ? "ready"
                  : null;
          if (
            !state ||
            (row.status === "blocked" && row.schedule_state !== "blocked")
          )
            continue;
          if (
            state !== row.schedule_state ||
            item.reason !== row.schedule_reason
          ) {
            if (state === "blocked") dequeue(this.db, row.id);
            if (state === "blocked" && row.status === "todo")
              advanceTask(
                this.db,
                row.id,
                { kind: "block" },
                {},
                { reason: item.reason },
              );
            if (
              state !== "blocked" &&
              row.status === "blocked" &&
              row.schedule_state === "blocked"
            )
              advanceTask(
                this.db,
                row.id,
                { kind: "manual_set", to: "todo" },
                {},
                "依赖恢复",
              );
            this.db
              .prepare(
                "UPDATE tasks SET schedule_state=?,schedule_reason=?,updated_at=? WHERE id=?",
              )
              .run(state, item.reason, now, row.id);
            noteTask(this.db, row.id, `schedule_${state}`, {
              waiting_for: item.waiting_for,
              reason: item.reason,
            });
            if (state === "ready" || state === "blocked")
              this.publish(row.id, state, item.reason, item.waiting_for);
          }
          const fresh = getTask(this.db, row.id);
          if (
            state === "ready" &&
            fresh.status === "todo" &&
            fresh.auto === 1 &&
            fresh.auto_dispatched === 0 &&
            !(
              (fresh.owner ?? "secretary") === "secretary" &&
              fresh.deliver === "none"
            )
          ) {
            if (queued(this.db, row.id)) {
              this.db
                .prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?")
                .run(row.id);
              continue;
            }
            try {
              await this.run(fresh.ref);
              this.db
                .prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?")
                .run(row.id);
            } catch (error) {
              const reason = `自动派发失败：${error instanceof Error ? error.message : String(error)}`;
              advanceTask(this.db, row.id, { kind: "block" }, {}, { reason });
              this.db
                .prepare(
                  "UPDATE tasks SET schedule_state='blocked',schedule_reason=? WHERE id=?",
                )
                .run(reason, row.id);
              this.publish(row.id, "blocked", reason, []);
            }
          }
        }
        if (rows.length < 200) break;
      }
    } finally {
      this.busy = false;
    }
  }

  private async refreshPrs(id: number, now: number) {
    const prs = all<{ repo: string; number: number }>(
      this.db,
      "SELECT repo,number FROM task_pr_dependencies WHERE task_id=? AND merged=0 AND (checked_at IS NULL OR checked_at<?) ORDER BY repo,number LIMIT 20",
      id,
      now - 60_000,
    );
    for (const pr of prs) {
      const result = await this.exec(
        "gh",
        ["pr", "view", String(pr.number), "-R", pr.repo, "--json", "mergedAt"],
        { timeoutMs: 15_000 },
      );
      let merged = false;
      let error: string | null = null;
      try {
        if (!result.ok) throw new Error(result.stderr.trim() || "gh 查询失败");
        merged = !!JSON.parse(result.stdout).mergedAt;
      } catch (cause) {
        error =
          cause instanceof Error ? cause.message.slice(0, 300) : String(cause);
      }
      this.db
        .prepare(
          "UPDATE task_pr_dependencies SET merged=?,checked_at=?,error=? WHERE task_id=? AND repo=? AND number=?",
        )
        .run(merged ? 1 : 0, now, error, id, pr.repo, pr.number);
    }
  }

  private publish(
    id: number,
    kind: string,
    reason: string | null,
    waiting: string[],
  ) {
    const task = getTask(this.db, id);
    const route = taskRoute(this.db, task);
    this.inbox.publish({
      subscriber: route.subscriber,
      taskId: id,
      source: "schedule",
      kind,
      key: `${task.ref}:schedule:${kind}`,
      detail: {
        title: task.title,
        reason,
        waiting_for: waiting,
        auto: task.auto === 1,
        unassigned:
          (task.owner ?? "secretary") === "secretary" &&
          task.deliver === "none",
        routed: { to: route.subscriber, why: route.why },
      },
    });
  }
}
