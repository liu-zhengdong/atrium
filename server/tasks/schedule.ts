import type { DatabaseSync } from "node:sqlite";
import { advanceTask, getTask, noteTask, type Task } from "./ledger.ts";
import { all, listView, taskRef, usage, type TaskRow } from "./ledger-model.ts";
import { conditions, conditionsOfMany } from "./schedule-ledger.ts";
import type { EventInbox } from "./events.ts";
import type { Exec, Run } from "./git.ts";
import { dequeue, idleWaits, queued, queueView } from "./queue.ts";
import { once } from "./ledger-read.ts";
import { isIdle, rank } from "./priority.ts";
import { noteView } from "./notes.ts";
import {
  dependencyOf,
  dependencyOfMany,
  type Dependency,
} from "./schedule-upstream.ts";
import { refreshDueSchedulePrs } from "./schedule-refresh.ts";
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

/** 能否自动派发：todo、开了 auto、还没派过，且不是未分派的秘书 none 任务。 */
function canAutoDispatch(
  row: Pick<
    TaskRow,
    "status" | "auto" | "auto_dispatched" | "owner" | "deliver"
  >,
): boolean {
  return (
    row.status === "todo" &&
    row.auto === 1 &&
    row.auto_dispatched === 0 &&
    !((row.owner ?? "secretary") === "secretary" && row.deliver === "none")
  );
}

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

/**
 * 巡检一页的排期判定：依赖条件按页批量取（k23），判定不碰库。
 * 判定后某条任务状态变了（受阻/恢复），用 setStatus 同步给同为上游的后续候选。
 */
export function pagePlan(
  db: DatabaseSync,
  rows: Pick<TaskRow, "id" | "status" | "schedule_reason">[],
) {
  const conditions = conditionsOfMany(
    db,
    rows.map((row) => row.id),
  );
  const afterIds = new Set<number>();
  for (const condition of conditions.values())
    for (const ref of condition.after) afterIds.add(Number(ref.slice(1)));
  const deps = dependencyOfMany(db, [...afterIds]);
  return {
    classify(
      row: Pick<TaskRow, "id" | "status" | "schedule_reason">,
    ): Pick<PlanItem, "group" | "waiting_for" | "reason"> {
      const condition = conditions.get(row.id)!;
      const tasks = condition.after.map((ref) =>
        deps.get(Number(ref.slice(1)))!,
      );
      const prs = condition.after_pr.map((pr) => ({
        ref: `${pr.repo}#${pr.number}${pr.error ? `（查询失败：${pr.error}）` : ""}`,
        merged: pr.merged,
      }));
      return classify(row.status, tasks, prs, row.schedule_reason);
    },
    setStatus(id: number, status: TaskRow["status"]) {
      const dep = deps.get(id);
      if (dep) dep.status = status;
    },
  };
}

/** plan 一页未结束的任务；同样走部分索引 tasks_open（t154）。 */
export const PLAN_PAGE_SQL =
  "SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') ORDER BY id LIMIT ?";

export function taskPlan(db: DatabaseSync, after = 0, limit = 200) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw usage("plan: after 应为非负整数，limit 应为 1～500");
  const rows = all<TaskRow>(db, PLAN_PAGE_SQL, after, limit + 1);
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

const planRank = (task: Pick<TaskRow, "urgent" | "priority">) =>
  rank({ urgent: task.urgent === 1, idle: isIdle(task) });

/** 巡检候选只用这几列。 */
type CandidateRow = Pick<
  TaskRow,
  | "id"
  | "status"
  | "schedule_state"
  | "schedule_reason"
  | "auto"
  | "auto_dispatched"
  | "owner"
  | "deliver"
>;

/**
 * 巡检候选：未结束且开了自动、有排期状态或有依赖的任务，每页 200 条。
 * 条件里的 `status NOT IN ('done','cancelled')` 与部分索引 tasks_open 的定义一字不差，
 * 查询才用得上它（见 ledger-schema.ts）。
 */
export const CANDIDATES_SQL = `SELECT id,status,schedule_state,schedule_reason,auto,auto_dispatched,owner,deliver FROM tasks
  WHERE id>? AND status NOT IN ('done','cancelled')
    AND (auto=1 OR schedule_state IS NOT NULL
      OR EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=tasks.id)
      OR EXISTS(SELECT 1 FROM task_pr_dependencies WHERE task_id=tasks.id))
  ORDER BY id LIMIT 200`;

export class Scheduler {
  private busy = false;
  private stopped = false;
  private readonly abort = new AbortController();
  /** 带中止信号的执行器：关服务时 gh / git 子进程被终止，巡检立即收手。 */
  private readonly exec: Exec;

  constructor(
    private readonly db: DatabaseSync,
    private readonly inbox: EventInbox,
    private readonly run: (ref: string) => Promise<unknown>,
    exec: Exec,
  ) {
    this.exec = (command, args, options = {}) =>
      abortable(
        exec(command, args, { ...options, signal: this.abort.signal }),
        this.abort.signal,
      );
  }

  /** 关闭巡检：中止在跑的 gh / git，tick 尽快返回。 */
  close() {
    this.stopped = true;
    this.abort.abort();
  }

  async tick(now = Date.now()) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      // 有界扫描；游标循环覆盖任意规模账本。
      let after = 0;
      const later: number[] = [];
      for (;;) {
        if (this.stopped) return;
        // 走部分索引 tasks_open：只碰未结束的任务，已完成的再多也不扫（t154）；
        // 只取判定与派发要的列，不读详述、结果这些大字段。
        const rows = all<CandidateRow>(this.db, CANDIDATES_SQL, after);
        if (!rows.length) break;
        after = rows[rows.length - 1]!.id;
        // gh / git 只在每页开始时批量跑一次，不放进逐候选循环；共享的上游只查一次。
        await refreshDueSchedulePrs(
          this.db,
          rows.map((row) => row.id),
          now,
          this.exec,
          () => this.stopped,
        );
        // gh / git 期间任务可能已被启动、取消或改了排期：按页重读这几列再判定，
        // 不用页首的旧行推进状态（否则会把已启动的任务误标受阻，t134）。
        // 一条 IN 查询，仍是每页常数条。
        const live = new Map(
          all<
            Pick<
              TaskRow,
              "id" | "status" | "schedule_state" | "schedule_reason"
            >
          >(
            this.db,
            `SELECT id,status,schedule_state,schedule_reason FROM tasks WHERE id IN (${rows
              .map(() => "?")
              .join(",")})`,
            ...rows.map((row) => row.id),
          ).map((row) => [row.id, row]),
        );
        for (const row of rows) {
          const current = live.get(row.id);
          if (!current) continue;
          row.status = current.status;
          row.schedule_state = current.schedule_state;
          row.schedule_reason = current.schedule_reason;
        }
        const page = pagePlan(this.db, rows);
        for (const row of rows) {
          if (this.stopped) return;
          const item = page.classify(row);
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
            if (state === "blocked" && row.status === "todo") {
              advanceTask(
                this.db,
                row.id,
                { kind: "block" },
                {},
                { reason: item.reason },
              );
              page.setStatus(row.id, "blocked");
            }
            if (
              state !== "blocked" &&
              row.status === "blocked" &&
              row.schedule_state === "blocked"
            ) {
              advanceTask(
                this.db,
                row.id,
                { kind: "manual_set", to: "todo" },
                {},
                "依赖恢复",
              );
              page.setStatus(row.id, "todo");
            }
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
          if (state !== "ready") continue;
          // 先用本页行（状态已重读）过滤，只有可能派发的才再读库确认（k23）：
          // 稳态下已派过的候选不再逐条查库，一轮语句数不随候选数增长（t134）。
          if (!canAutoDispatch(row)) continue;
          // 只取派发判定要的几列；getTask 会顺带查备注、排队、专员与组织（k23，别为没用的字段查库）。
          const fresh = this.db
            .prepare(
              "SELECT status,auto,auto_dispatched,owner,deliver,urgent,priority FROM tasks WHERE id=?",
            )
            .get(row.id) as Pick<
            TaskRow,
            | "status"
            | "auto"
            | "auto_dispatched"
            | "owner"
            | "deliver"
            | "urgent"
            | "priority"
          >;
          if (!canAutoDispatch(fresh)) continue;
          // 闲时的等这一轮普通任务都派完（拉起或排进队列）再派，派时由 run 看前面还有没有普通任务在等。
          if (isIdle(fresh)) later.push(row.id);
          else if (!(await this.dispatch(row.id)))
            page.setStatus(row.id, "blocked");
        }
        if (rows.length < 200) break;
      }
      for (const id of later) {
        if (this.stopped) return;
        await this.dispatch(id);
      }
    } finally {
      this.busy = false;
    }
  }

  /** 自动派发一件就绪任务；已在排队的只记下派过，派不出去的标受阻并投递（返回 false）。 */
  private async dispatch(id: number) {
    // 只取派发判定要的几列（k23）；闲时任务在本轮末尾才派，期间可能已被启动或取消。
    const fresh = this.db
      .prepare(
        "SELECT status,auto,auto_dispatched,owner,deliver FROM tasks WHERE id=?",
      )
      .get(id) as Pick<
      TaskRow,
      "status" | "auto" | "auto_dispatched" | "owner" | "deliver"
    >;
    if (!canAutoDispatch(fresh)) return true;
    if (queued(this.db, id)) {
      this.db.prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?").run(id);
      return true;
    }
    try {
      await this.run(taskRef(id));
      this.db.prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?").run(id);
      return true;
    } catch (error) {
      const reason = `自动派发失败：${error instanceof Error ? error.message : String(error)}`;
      advanceTask(this.db, id, { kind: "block" }, {}, { reason });
      this.db
        .prepare(
          "UPDATE tasks SET schedule_state='blocked',schedule_reason=? WHERE id=?",
        )
        .run(reason, id);
      this.publish(id, "blocked", reason, []);
      return false;
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

const cancelled: Run = { ok: false, stdout: "", stderr: "已取消" };

/** 中止信号一响就用「已取消」收手，不等子进程超时，保证关服务 1 秒内返回。 */
function abortable(promise: Promise<Run>, signal: AbortSignal): Promise<Run> {
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise<Run>((resolve) => {
    const finish = (result: Run) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(cancelled);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(finish, () => finish(cancelled));
  });
}
