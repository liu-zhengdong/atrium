import type { DatabaseSync } from "node:sqlite";
import { launched, type Active } from "./active.ts";
import type { Tool } from "./adapters/index.ts";
import type { EventInbox } from "./events.ts";
import type { Exec } from "./git.ts";
import {
  advanceTask,
  getTask,
  noteTask,
  taskRef,
  type RunFields,
  type Task,
} from "./ledger.ts";
import { publishTask } from "./notice.ts";
import { exitDetail, type Exit } from "./outcome.ts";
import { resolveWorker, type ResolvedWorker, type Risk } from "./profiles.ts";
import { dequeue, heads } from "./queue.ts";
import { diffSize, settle } from "./settle.ts";
import { alive, signalGroup, spawnWorker } from "./spawn.ts";
import type { TaskEvent } from "./state.ts";
import type { TaskWaits } from "./waits.ts";
import { judge } from "./watchdog.ts";
import { prepareRun, type LaunchOptions } from "./workspace.ts";

/**
 * 服务手里的执行者进程（#262）：拉起、退出收尾（查事实、过关卡、重试）、看门狗巡检、排队拉起。
 * 收尾与看门狗的判定在 outcome.ts / watchdog.ts 的纯函数里，这里只执行并落库。
 */

export type Chosen = { worker: ResolvedWorker; risk: Risk };

export type ExecutorContext = {
  db: DatabaseSync;
  inbox: EventInbox;
  exec: Exec;
  launchOptions: LaunchOptions;
  waits: TaskWaits;
  killGraceMs?: number;
  closed: () => boolean;
};

export class Executors {
  readonly active = new Map<number, Active>();
  /** 正在准备（建 worktree、写提示词）的任务及其工具，防止重复派与独占冲突。 */
  readonly launching = new Map<number, Tool | null>();
  private ticking = false;

  constructor(private readonly ctx: ExecutorContext) {}

  busy(tool: Tool, except?: number) {
    for (const active of this.active.values())
      if (active.tool === tool && active.id !== except && !active.exited)
        return true;
    for (const [id, launching] of this.launching)
      if (launching === tool && id !== except) return true;
    return false;
  }

  publish(id: number, kind: string, detail: Record<string, unknown>) {
    publishTask(this.ctx.inbox, this.ctx.db, id, kind, detail);
  }

  advance(
    id: number,
    event: TaskEvent,
    fields: RunFields = {},
    detail?: unknown,
  ) {
    return advanceTask(this.ctx.db, taskRef(id), event, fields, detail);
  }

  async launch(id: number, chosen: Chosen, retried = false): Promise<Task> {
    const task = getTask(this.ctx.db, id);
    const prepared = await prepareRun(task, chosen, this.ctx.launchOptions);
    const child = await spawnWorker(
      prepared,
      this.ctx.launchOptions.env,
      task.ref,
    );
    const pid = child.pid!;
    let started: Task;
    try {
      started = this.advance(
        id,
        { kind: "start" },
        {
          worker: chosen.worker.id,
          pid,
          worktree: prepared.worktree,
          branch: prepared.branch,
          pr_url: null,
          ci: null,
          result: null,
        },
        {
          worker: chosen.worker.id,
          risk: chosen.risk,
          cwd: prepared.cwd,
          ...(retried ? { retry: true } : {}),
        },
      );
    } catch (error) {
      signalGroup(pid, "SIGKILL");
      throw error;
    }
    const active = launched({
      task,
      pid,
      child,
      prepared,
      retried,
      exec: this.ctx.exec,
      ...chosen,
    });
    this.active.set(id, active);
    child.once(
      "exit",
      (code, signal) => void this.finish(id, { code, signal }),
    );
    await active.probe.baseline();
    this.ctx.waits.changed(id);
    return started;
  }

  // ---- 退出收尾 ----

  async finish(id: number, exit: Exit) {
    const active = this.active.get(id);
    if (!active || active.exited) return;
    active.exited = true;
    let relaunched = false;
    try {
      const outcome = await settle(active, exit, this.ctx.exec);
      if (getTask(this.ctx.db, id).status !== "running") return;
      const { decision, verdict, facts } = outcome;
      const detail = exitDetail(exit);
      if (verdict && facts)
        noteTask(this.ctx.db, id, "gates", {
          worker: active.worker.id,
          passed: verdict.passed,
          awaiting_ci: verdict.awaitingCi,
          results: verdict.results,
          diff: diffSize(facts),
          ...detail,
        });
      this.advance(id, { kind: decision.event }, outcome.fields, {
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(verdict && !verdict.passed
          ? { gates: verdict.failed.map((r) => r.gate) }
          : {}),
        ...detail,
      });
      if (decision.retry) {
        relaunched = true;
        await this.retry(active, decision.reason!);
      } else
        this.publish(id, decision.publish, {
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.publish === "done" && facts
            ? { diff: diffSize(facts) }
            : {}),
          ...(verdict && !verdict.passed ? { gates: verdict.failed } : {}),
        });
    } catch (error) {
      this.failAfterError(id, error);
    } finally {
      if (!relaunched) this.active.delete(id);
      this.ctx.waits.changed(id);
      if (!this.ctx.closed()) void this.drain(active.tool);
    }
  }

  private async retry(active: Active, reason: string) {
    this.publish(active.id, "stalled", { reason, retry: true });
    this.active.delete(active.id);
    try {
      await this.launch(
        active.id,
        { worker: active.worker, risk: active.risk },
        true,
      );
    } catch (error) {
      const why = `卡死后重试拉起失败：${error instanceof Error ? error.message : String(error)}`;
      noteTask(this.ctx.db, active.id, "retry_failed", { reason: why });
      this.publish(active.id, "failed", { reason: why });
    }
  }

  private failAfterError(id: number, error: unknown) {
    console.error(`任务 ${taskRef(id)} 收尾失败：`, error);
    try {
      if (getTask(this.ctx.db, id).status !== "running") return;
      const reason = `收尾出错：${error instanceof Error ? error.message : String(error)}`;
      this.advance(id, { kind: "exit_fail" }, {}, { reason });
      this.publish(id, "failed", { reason });
    } catch {
      // 数据库已关闭（服务正在停），重启自愈会接手。
    }
  }

  // ---- 看门狗、重启自愈、排队、CI ----

  async tick() {
    if (this.ticking || this.ctx.closed()) return;
    this.ticking = true;
    try {
      for (const active of [...this.active.values()]) {
        if (active.exited) continue;
        if (!active.child && !alive(active.pid)) {
          void this.finish(active.id, "unknown");
          continue;
        }
        if (active.stop) continue;
        const { signals } = await active.probe.poll();
        if (signals.length) active.state.lastProgressAt = Date.now();
        const verdict = judge(active.state, active.limits, Date.now());
        if (verdict.kind === "ok") continue;
        active.stop = verdict;
        noteTask(this.ctx.db, active.id, verdict.kind, {
          reason: verdict.reason,
        });
        this.kill(active);
      }
    } finally {
      this.ticking = false;
    }
  }

  kill(active: Active) {
    signalGroup(active.pid, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) signalGroup(active.pid, "SIGKILL");
    }, this.ctx.killGraceMs ?? 10_000).unref();
  }

  /** 拉起排队中的任务：每个工具的队首，前提是该工具空闲。 */
  async drain(tool?: Tool) {
    for (const entry of heads(this.ctx.db, tool)) {
      const entryTool = entry.tool as Tool;
      if (this.ctx.closed() || this.busy(entryTool)) continue;
      dequeue(this.ctx.db, entry.task_id);
      this.launching.set(entry.task_id, entryTool);
      try {
        const worker = await resolveWorker(
          entry.worker,
          this.ctx.launchOptions.workersDir,
        );
        await this.launch(entry.task_id, { worker, risk: entry.risk as Risk });
      } catch (error) {
        const reason = `排队后拉起失败：${error instanceof Error ? error.message : String(error)}`;
        try {
          this.advance(entry.task_id, { kind: "block" }, {}, { reason });
          this.publish(entry.task_id, "blocked", { reason });
        } catch {
          noteTask(this.ctx.db, entry.task_id, "launch_failed", { reason });
        }
      } finally {
        this.launching.delete(entry.task_id);
        this.ctx.waits.changed(entry.task_id);
      }
    }
  }
}
