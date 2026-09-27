import type { DatabaseSync } from "node:sqlite";
import { advanceTask, getTask, noteTask, type Task } from "./ledger.ts";
import { all, listView, taskRef, usage, type TaskRow } from "./ledger-model.ts";
import { conditions } from "./schedule-ledger.ts";
import type { EventInbox } from "./events.ts";
import type { Exec } from "./git.ts";
import { dequeue, idleWaits, queued, queueView } from "./queue.ts";
import { once } from "./ledger-read.ts";
import { isIdle, rank } from "./priority.ts";
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

export type UpstreamCondition =
  | { kind: "met" }
  | { kind: "wait"; text: string }
  | { kind: "blocked"; text: string };

/**
 * 一个上游是否满足（纯函数）：上游 done 且交付 PR 时 PR 合入才算；合入服务自身仓库、
 * 要自动上线的，上线才算（t130，下游要用新命令）；PR 关闭未合入、上线失败与上游失败一样卡住下游。
 */
export function upstreamCondition(dep: Dependency): UpstreamCondition {
  if (dep.status === "failed" || dep.status === "cancelled")
    return { kind: "blocked", text: `${dep.ref} [${dep.status}]` };
  if (dep.status !== "done")
    return { kind: "wait", text: `${dep.ref} [${dep.status}]` };
  if (dep.release === "online") return { kind: "met" };
  if (dep.release === "failed")
    return { kind: "blocked", text: `${dep.ref} 上线失败` };
  if (dep.release === "waiting")
    return { kind: "wait", text: `${dep.ref} 上线` };
  if (!dep.pr) return { kind: "met" };
  if (dep.pr.state === "closed")
    return {
      kind: "blocked",
      text: `${dep.ref} 的 PR #${dep.pr.number} 已关闭未合入`,
    };
  // 运行时还在合入时 gh 可能已显示合入，但要不要等上线得等它记完账再说。
  if (dep.pr.state === "merged" && dep.release !== "merging")
    return { kind: "met" };
  const note = dep.pr.error
    ? `（查询失败：${dep.pr.error}）`
    : dep.pr.state === null
      ? "（尚未查询）"
      : "";
  return {
    kind: "wait",
    text: `${dep.ref} 的 PR #${dep.pr.number} 合入${note}`,
  };
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
  const checks = dependencies.map(upstreamCondition);
  const failed = checks.flatMap((c) => (c.kind === "blocked" ? [c.text] : []));
  const waiting = [
    ...checks.flatMap((c) => (c.kind === "wait" ? [c.text] : [])),
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

/** 读账本里的依赖事实再判定；不查 gh，PR 状态用排期器缓存的结果。 */
export function scheduleOf(
  db: DatabaseSync,
  row: Pick<TaskRow, "id" | "status" | "schedule_reason">,
) {
  const deps = conditions(db, row.id);
  const tasks = deps.after.map((ref) => dependencyOf(db, Number(ref.slice(1))));
  const prs = deps.after_pr.map((pr) => ({
    ref: `${pr.repo}#${pr.number}${pr.error ? `（查询失败：${pr.error}）` : ""}`,
    merged: pr.merged,
  }));
  return classify(row.status, tasks, prs, row.schedule_reason);
}

export function planItem(
  db: DatabaseSync,
  row: TaskRow,
  ahead?: () => ReadonlyMap<number, number>,
): PlanItem {
  return {
    task: {
      ...listView(row),
      ...noteView(db, row.id, row.status),
      ...queueView(db, row.id, ahead),
    },
    ...scheduleOf(db, row),
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
  const ahead = once(() => idleWaits(db));
  // 细节是只读附加字段（top 的排期段用）；分组判定仍只看 planItem。
  const items: (PlanItem & PlanDetail)[] = page.map((row) => ({
    ...planItem(db, row, ahead),
    ...details.get(row.id)!,
  }));
  return {
    groups: {
      running: items.filter((item) => item.group === "running"),
      // 紧急的排最前（t113），闲时的排最后（t136），同一档照短号。
      ready: items
        .filter((item) => item.group === "ready")
        .sort((a, b) => planRank(a.task) - planRank(b.task)),
      waiting: items.filter((item) => item.group === "waiting"),
      blocked: items.filter((item) => item.group === "blocked"),
    },
    next_after: rows.length > limit ? taskRef(rows[limit - 1]!.id) : null,
  };
}

const NO_AHEAD = () => new Map<number, number>();

const planRank = (task: Pick<TaskRow, "urgent" | "priority">) =>
  rank({ urgent: task.urgent === 1, idle: isIdle(task) });

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
      const later: number[] = [];
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
          const item = planItem(
            this.db,
            {
              ...row,
              ...(this.db
                .prepare(
                  "SELECT status,schedule_state,schedule_reason FROM tasks WHERE id=?",
                )
                .get(row.id) as TaskRow),
            },
            // 巡检只看分组，不用排队原因；免得每条排队任务都读一遍队列。
            NO_AHEAD,
          );
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
            // 闲时的等这一轮普通任务都派完（拉起或排进队列）再派，派时由 run 看前面还有没有普通任务在等。
            if (isIdle(fresh)) later.push(row.id);
            else await this.dispatch(row.id);
          }
        }
        if (rows.length < 200) break;
      }
      for (const id of later) await this.dispatch(id);
    } finally {
      this.busy = false;
    }
  }

  /** 自动派发一件就绪任务；已在排队的只记下派过，派不出去的标受阻并投递。 */
  private async dispatch(id: number) {
    const fresh = getTask(this.db, id);
    if (fresh.status !== "todo" || fresh.auto_dispatched !== 0) return;
    if (queued(this.db, id)) {
      this.db.prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?").run(id);
      return;
    }
    try {
      await this.run(fresh.ref);
      this.db.prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?").run(id);
    } catch (error) {
      const reason = `自动派发失败：${error instanceof Error ? error.message : String(error)}`;
      advanceTask(this.db, id, { kind: "block" }, {}, { reason });
      this.db
        .prepare(
          "UPDATE tasks SET schedule_state='blocked',schedule_reason=? WHERE id=?",
        )
        .run(reason, id);
      this.publish(id, "blocked", reason, []);
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
