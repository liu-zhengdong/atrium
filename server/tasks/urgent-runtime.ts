import type { DatabaseSync } from "node:sqlite";
import { ADAPTERS, isTool } from "./adapters/index.ts";
import type { EventInbox } from "./events.ts";
import type { Executors } from "./executors.ts";
import { getTask, noteTask } from "./ledger.ts";
import { all, taskRef } from "./ledger-model.ts";
import { publishTask, publishUrgentStage } from "./notice.ts";
import { queued } from "./queue.ts";
import {
  killLine,
  LEFTOVER_LIMIT,
  LEFTOVER_MS,
  leftoverTargets,
  type LeftoverKill,
  type LeftoverRow,
  type LeftoverTarget,
} from "./leftovers.ts";
import { LOCAL_HOST } from "../hosts/state.ts";
import {
  crowdWarning,
  preemptPlan,
  resumePlan,
  stopgapText,
  storedStopgap,
  type StopgapAction,
} from "./urgent.ts";
import {
  closePreemption,
  openPreemptions,
  openUrgent,
} from "./urgent-ledger.ts";
import { SECRETARY } from "../leaders/route.ts";

/**
 * 紧急通道的执行（t215）：止损、抢占腾位置、清空后续上、标紧急的知会。判定都在 urgent.ts 的纯函数里，
 * 这里只取事实、调运行时的动作（停任务、暂停主机、派活）并落账。
 */

/** host clean 的结果（t217）：停掉了哪些在跑的、结束了哪些残留进程树；远程没清成时 unreached 写原因。 */
export type CleanResult = {
  host: string;
  stopped: string[];
  killed: { task: string; pid: number; tool: string }[];
  /** 核对了几个候选进程。 */
  checked: number;
  unreached?: string;
  detail: string;
};

export type LaneDeps = {
  x: Executors;
  inbox: EventInbox;
  /** 停一个任务（在跑的结束进程树，排队的移出队列）。 */
  stop: (ref: string) => unknown;
  /** 本机的残留进程：核对并结束（reapLeftovers）。 */
  reapLocal: (targets: readonly LeftoverTarget[]) => Promise<LeftoverKill[]>;
  /** 远程主机上的残留进程由那台的代理核对并结束（RemoteHosts.clean）。 */
  remote: {
    clean(
      host: number,
      targets: readonly LeftoverTarget[],
    ): Promise<LeftoverKill[]>;
  };
  /** 暂停往某台主机派活。 */
  pauseHost: (host: number) => void;
  /** 派一个任务（续上被暂停的）。 */
  run: (ref: string, body: Record<string, unknown>) => Promise<unknown>;
  /** 某台主机此刻是不是满了或太忙（不算 except 这件）。 */
  crowded: (host: number, except: number) => boolean;
  changed: (id: number) => void;
  closed: () => boolean;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class UrgentLane {
  private resuming = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: LaneDeps,
  ) {}

  /**
   * 紧急任务要在 host 上用 tool 时腾位置：按 preemptPlan 暂停闲时（再普通）任务。
   * wait 为 true 表示要等被暂停的让出独占工具。
   */
  makeRoom(id: number, tool: string, host: number): { wait: boolean } {
    const { x } = this.deps;
    const plan = preemptPlan({
      self: id,
      host,
      tool,
      exclusive: isTool(tool) && !!ADAPTERS[tool].exclusive,
      crowded: this.deps.crowded(host, id),
      running: x.slots(),
    });
    for (const victim of plan.victims)
      if (x.pause(victim.id, id, victim.why)) {
        const detail = {
          task: taskRef(victim.id),
          why: victim.why,
          reason: `暂停 ${taskRef(victim.id)}（${victim.why === "exclusive" ? "让出独占执行者" : "让出执行者名额"}）`,
        };
        noteTask(this.db, id, "preempting", detail);
        publishUrgentStage(this.deps.inbox, this.db, id, "preempting", detail);
      }
    return { wait: plan.wait };
  }

  /** 紧急通道忙不忙：紧急任务在跑、正在启动或在排队的件数。 */
  urgentBusy(): number {
    const launching = [...this.deps.x.launching.keys()];
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE urgent=1 AND (status='running'
           OR id IN (SELECT task_id FROM task_queue)${launching.length ? ` OR id IN (${launching.map(() => "?").join(",")})` : ""})`,
      )
      .get(...launching) as { n: number };
    return row.n;
  }

  /** 紧急通道清空后续上被暂停的任务（巡检调用）；续不上的记一笔并知会负责人。 */
  async resume() {
    if (this.resuming || this.deps.closed()) return;
    this.resuming = true;
    try {
      const open = openPreemptions(this.db);
      if (!open.length) return;
      const { x } = this.deps;
      const ids = open.map((entry) => entry.task_id);
      const status = new Map(
        all<{ id: number; status: string }>(
          this.db,
          `SELECT id,status FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
          ...ids,
        ).map((row) => [row.id, row.status]),
      );
      const plan = resumePlan({
        urgentBusy: this.urgentBusy(),
        paused: open.map((entry) => ({
          task: entry.task_id,
          status: status.get(entry.task_id) ?? "cancelled",
          moving:
            x.active.has(entry.task_id) ||
            x.launching.has(entry.task_id) ||
            !!queued(this.db, entry.task_id),
        })),
      });
      const now = Date.now();
      for (const id of plan.drop) closePreemption(this.db, id, now);
      const byId = new Map(open.map((entry) => [entry.task_id, entry]));
      for (const id of plan.resume) {
        if (this.deps.closed()) return;
        const entry = byId.get(id)!;
        try {
          await this.deps.run(taskRef(id), {
            worker: entry.worker,
            risk: entry.risk,
            // 远程主机上的接着回那台（工作树在那边）；本机的照常挑。
            ...(entry.host_id !== null && entry.host_id !== LOCAL_HOST
              ? { host: `h${entry.host_id}` }
              : {}),
          });
        } catch (error) {
          closePreemption(this.db, id, Date.now());
          const reason = `被紧急任务 t${entry.by_task} 抢占后续上失败：${message(error)}`;
          noteTask(this.db, id, "resume_failed", { reason });
          publishTask(this.deps.inbox, this.db, id, "blocked", {
            reason,
            next: `atrium task run ${taskRef(id)}`,
          });
        }
        this.deps.changed(id);
      }
    } finally {
      this.resuming = false;
    }
  }

  /**
   * 先止损（t215）：按任务上写的止损动作逐条执行（暂停主机、停任务、清理残留进程），结果记进 stopgap 事件并推送；
   * 单条失败不挡后面的。没写止损动作返回 null。
   */
  async stopgap(id: number) {
    const task = getTask(this.db, id);
    const actions = storedStopgap(task.stopgap);
    if (!actions.length) return null;
    const results: { action: string; ok: boolean; detail: string }[] = [];
    for (const action of actions) {
      try {
        results.push({
          action: stopgapText(action),
          ok: true,
          detail: await this.apply(action, id),
        });
      } catch (error) {
        results.push({
          action: stopgapText(action),
          ok: false,
          detail: message(error),
        });
      }
    }
    noteTask(this.db, id, "stopgap", { actions: results });
    const failed = results.filter((item) => !item.ok).length;
    publishUrgentStage(this.deps.inbox, this.db, id, "stopgap", {
      reason: results
        .map((item) => `${item.action} ${item.ok ? "✓" : "✗"} ${item.detail}`)
        .join("；")
        .slice(0, 240),
      actions: results,
      ...(failed ? { failed } : {}),
    });
    this.deps.changed(id);
    return results;
  }

  private async apply(action: StopgapAction, self: number): Promise<string> {
    switch (action.kind) {
      case "host_pause":
        this.deps.pauseHost(action.host);
        return `已暂停往 h${action.host} 派活`;
      case "task_stop": {
        const done: string[] = [];
        const skipped: string[] = [];
        for (const id of action.tasks) {
          if (id === self) {
            skipped.push(`${taskRef(id)} 是本任务`);
            continue;
          }
          try {
            this.deps.stop(taskRef(id));
            done.push(taskRef(id));
          } catch (error) {
            skipped.push(`${taskRef(id)}：${message(error)}`);
          }
        }
        if (!done.length) throw new Error(skipped.join("；") || "没有要停的");
        return `已停 ${done.join("、")}${skipped.length ? `；${skipped.join("；")}` : ""}`;
      }
      case "host_clean": {
        const result = await this.clean(action.host, self);
        // 远程没清成、也没停掉什么：这一步算没做成。
        if (result.unreached && !result.stopped.length)
          throw new Error(result.detail);
        return result.detail;
      }
    }
  }

  /**
   * 清理某台主机上 Atrium 拉起的残留进程：停掉在那台跑的非紧急执行者；再结束最近一天里已结束任务
   * 仍活着的执行者进程树（t217：本机由服务、远程由那台的代理按 leftovers.ts 同一判定核对工具与启动时刻，
   * 平台层 killTree 整树结束）。结束的逐条记进所属任务的 leftover_killed 事件。
   */
  async clean(host: number, self = 0): Promise<CleanResult> {
    const { x } = this.deps;
    const stopped: string[] = [];
    for (const slot of x.slots())
      if (
        slot.host === host &&
        slot.id !== self &&
        !slot.urgent &&
        !slot.stopping
      ) {
        try {
          this.deps.stop(taskRef(slot.id));
          stopped.push(taskRef(slot.id));
        } catch {
          // 刚结束或正在启动：下一条照做。
        }
      }
    const rows = all<LeftoverRow>(
      this.db,
      `SELECT id,pid,worker,status,created_at,ended_at,updated_at FROM tasks
         WHERE pid IS NOT NULL AND status<>'running'
           AND ${host === LOCAL_HOST ? "(host_id IS NULL OR host_id=?)" : "host_id=?"}
           AND updated_at>=? ORDER BY updated_at DESC LIMIT ?`,
      host,
      Date.now() - LEFTOVER_MS,
      LEFTOVER_LIMIT * 2,
    );
    const targets = leftoverTargets(rows, {
      now: Date.now(),
      active: new Set(x.active.keys()),
    });
    let killed: LeftoverKill[] = [];
    let unreached: string | undefined;
    if (targets.length)
      try {
        killed =
          host === LOCAL_HOST
            ? await this.deps.reapLocal(targets)
            : await this.deps.remote.clean(host, targets);
      } catch (error) {
        unreached = message(error);
      }
    const ref = `h${host}`;
    for (const kill of killed)
      noteTask(this.db, kill.task, "leftover_killed", {
        host: ref,
        pid: kill.pid,
        tool: kill.tool,
        ...(self ? { by: taskRef(self) } : {}),
      });
    const parts = [
      `停掉 ${stopped.length} 个在跑的执行者${stopped.length ? `（${stopped.join("、")}）` : ""}`,
      unreached
        ? `残留进程没清：${unreached}`
        : `结束 ${killed.length} 个残留进程树${killed.length ? `：${killed.map(killLine).join("；")}` : ""}`,
    ];
    return {
      host: ref,
      stopped,
      killed: killed.map((kill) => ({ ...kill, task: taskRef(kill.task) })),
      checked: targets.length,
      ...(unreached ? { unreached } : {}),
      detail: `${ref}：${parts.join("，")}`,
    };
  }

  /** leader 标了紧急（t215）：知会秘书与用户，写明谁标的、为什么。 */
  notifyMarked(id: number, leader: string, why: string | null) {
    const task = getTask(this.db, id);
    noteTask(this.db, id, "urgent_marked", { by: leader, why });
    const crowd = this.crowd();
    for (const subscriber of [SECRETARY, "u1"])
      this.deps.inbox.publish({
        subscriber,
        taskId: id,
        source: "urgent",
        kind: "urgent_marked",
        key: `${task.ref}:urgent_marked`,
        actor: leader,
        detail: {
          title: task.title,
          by: leader,
          why,
          reason: `${leader} 把 ${task.ref} 标为紧急：${why ?? "没写原因"}`,
          ...(crowd ? { warning: crowd } : {}),
          next: `atrium task show ${task.ref}`,
        },
      });
  }

  /** 进行中的紧急任务与「太多」提示。 */
  crowdView() {
    const ids = openUrgent(this.db);
    return {
      count: ids.length,
      refs: ids.map(taskRef),
      warning: crowdWarning(ids.length),
    };
  }

  crowd() {
    return crowdWarning(openUrgent(this.db).length);
  }
}
