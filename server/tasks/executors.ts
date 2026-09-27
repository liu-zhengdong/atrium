import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { launched, type Active } from "./active.ts";
import { ADAPTERS, type Tool } from "./adapters/index.ts";
import type { EventInbox } from "./events.ts";
import type { Exec } from "./git.ts";
import {
  DEFAULT_OWNER,
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
import { dequeue, enqueue, heads } from "./queue.ts";
import type { QuotaGuard } from "./quota-runtime.ts";
import { diffSize, settle } from "./settle.ts";
import { alive, signalGroup, spawnWorker } from "./spawn.ts";
import type { TaskEvent } from "./state.ts";
import { routeAfterThinking } from "./thinking.ts";
import { attemptsOf, retryAfterThinking } from "./thinking-runtime.ts";
import { retryAfterTransient } from "./transient-runtime.ts";
import type { TaskWaits } from "./waits.ts";
import { judge } from "./watchdog.ts";
import { prepareRun, type LaunchOptions } from "./workspace.ts";
import { collectSkillEdits } from "../skills/collect.ts";

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
  quota: QuotaGuard;
  killGraceMs?: number;
  closed: () => boolean;
  paused: () => boolean;
};

export class Executors {
  readonly active = new Map<number, Active>();
  /** 正在准备（建 worktree、写提示词）的任务及其工具，防止重复派与独占冲突。 */
  readonly launching = new Map<number, Tool | null>();
  /** 退出收尾期间仍可能自动重派；wait 不应把中途状态当作最终结果。 */
  readonly finishing = new Map<number, number>();
  private ticking = false;

  constructor(private readonly ctx: ExecutorContext) {}

  isPaused() {
    return this.ctx.paused();
  }

  isClosed() {
    return this.ctx.closed();
  }

  busy(tool: Tool, except?: number) {
    for (const active of this.active.values())
      if (active.tool === tool && active.id !== except && !active.exited)
        return true;
    for (const [id, launching] of this.launching)
      if (launching === tool && id !== except) return true;
    return false;
  }

  /** 已有任务在跑（或正在启动）的工具，except 除外；自动挑人时据此避开正忙的独占执行者。 */
  busyTools(except?: number) {
    const tools = new Set<Tool>();
    for (const active of this.active.values())
      if (active.id !== except && !active.exited) tools.add(active.tool);
    for (const [id, launching] of this.launching)
      if (launching && id !== except) tools.add(launching);
    return tools;
  }

  publish(
    id: number,
    kind: string,
    detail: Record<string, unknown>,
    actor?: string,
  ) {
    publishTask(this.ctx.inbox, this.ctx.db, id, kind, detail, actor);
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
    if (this.ctx.closed()) throw new Error("服务已关闭");
    const task = getTask(this.ctx.db, id);
    const prepared = await prepareRun(task, chosen, this.ctx.launchOptions);
    if (this.ctx.closed()) throw new Error("服务已关闭");
    const child = await spawnWorker(
      prepared,
      this.ctx.launchOptions.env,
      task.ref,
    );
    const pid = child.pid!;
    if (this.ctx.closed()) {
      signalGroup(pid, "SIGKILL");
      throw new Error("服务已关闭");
    }
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
      task: started,
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
    this.finishing.set(id, (this.finishing.get(id) ?? 0) + 1);
    try {
      const outcome = await settle(
        active,
        exit,
        this.ctx.exec,
        (status, log) => {
          noteTask(this.ctx.db, id, `local_check_${status}`, { log });
          this.ctx.waits.changed(id);
        },
        this.ctx.launchOptions.env,
      );
      if (this.ctx.closed()) return;
      this.collectSkills(active);
      if (getTask(this.ctx.db, id).status !== "running") return;
      const { decision, verdict, facts } = outcome;
      if (outcome.localCheck)
        noteTask(this.ctx.db, id, "local_check", outcome.localCheck);
      const detail = exitDetail(exit);
      if (verdict)
        noteTask(this.ctx.db, id, "gates", {
          worker: active.worker.id,
          passed: verdict.passed,
          awaiting_ci: verdict.awaitingCi,
          results: verdict.results,
          ...(facts ? { diff: diffSize(facts) } : {}),
          ...detail,
        });
      this.advance(id, { kind: decision.event }, outcome.fields, {
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(verdict && !verdict.passed
          ? { gates: verdict.failed.map((r) => r.gate) }
          : {}),
        ...detail,
      });
      const retryContext = {
        db: this.ctx.db,
        launchOptions: this.ctx.launchOptions,
        held: () => this.ctx.quota.held(),
      };
      const published = {
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(decision.publish === "done" && facts
          ? { diff: diffSize(facts) }
          : {}),
        ...(verdict && !verdict.passed ? { gates: verdict.failed } : {}),
      };
      const thinking = routeAfterThinking({
        thinking: outcome.ending?.kind === "thinking",
        stop: active.stop,
        decision,
        verdict,
        attempts:
          outcome.ending?.kind === "thinking"
            ? attemptsOf(retryContext, id)
            : 0,
      });
      if (outcome.quota)
        await this.ctx.quota.exhausted(this, active, outcome.quota);
      else if (decision.retry) await this.retry(active, decision.reason!);
      else if (outcome.transient)
        await retryAfterTransient(
          this,
          retryContext,
          active,
          outcome.transient,
          decision.reason ?? outcome.transient.reason,
        );
      else if (thinking.kind !== "none")
        await retryAfterThinking(
          this,
          retryContext,
          active,
          thinking,
          decision,
          published,
        );
      else
        this.publish(
          id,
          decision.publish,
          published,
          active.stop?.kind === "user" ? active.stop.by : undefined,
        );
    } catch (error) {
      this.failAfterError(id, error);
    } finally {
      // 重试或换执行者重派后，表里已是新的一轮，别删掉。
      if (this.active.get(id) === active) this.active.delete(id);
      const remaining = this.finishing.get(id)! - 1;
      if (remaining) this.finishing.set(id, remaining);
      else this.finishing.delete(id);
      this.ctx.waits.changed(id);
      if (!this.ctx.closed() && !this.ctx.paused())
        void this.drain(active.tool);
    }
  }

  /** 执行者改了挂载的技能副本：生成修订提议，通知任务负责人（事件里带技能 owner 与其 leader）。 */
  private collectSkills(active: Active) {
    try {
      const { proposals, problems } = collectSkillEdits(
        this.ctx.db,
        active.id,
        dirname(active.logFile),
      );
      if (problems.length)
        noteTask(this.ctx.db, active.id, "skill_proposal_skipped", {
          problems,
        });
      if (!proposals.length) return;
      const task = getTask(this.ctx.db, active.id);
      for (const p of proposals) {
        noteTask(this.ctx.db, active.id, "skill_proposal", p);
        this.ctx.inbox.publish({
          subscriber: task.owner ?? DEFAULT_OWNER,
          taskId: active.id,
          source: "runner",
          kind: "skill_proposal",
          key: `${task.ref}:skill:${p.proposal}`,
          detail: {
            title: task.title,
            ...p,
            next: `atrium skill proposal ${p.proposal}`,
          },
        });
      }
    } catch (error) {
      console.error(`任务 ${taskRef(active.id)} 回收技能改动失败：`, error);
    }
  }

  private async retry(active: Active, reason: string) {
    if (this.ctx.closed()) return;
    this.publish(active.id, "stalled", { reason, retry: true });
    this.active.delete(active.id);
    if (this.ctx.paused()) {
      this.advance(
        active.id,
        { kind: "manual_set", to: "todo" },
        {},
        "等待重启后重派",
      );
      this.park(active.id, active.worker.id, active.tool, active.risk);
      return;
    }
    try {
      await this.launch(
        active.id,
        { worker: active.worker, risk: active.risk },
        true,
      );
    } catch (error) {
      if (this.ctx.closed()) return;
      const why = `卡死后重试拉起失败：${error instanceof Error ? error.message : String(error)}`;
      noteTask(this.ctx.db, active.id, "retry_failed", { reason: why });
      this.publish(active.id, "failed", { reason: why });
    }
  }

  private failAfterError(id: number, error: unknown) {
    if (this.ctx.closed()) return;
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

  /** 拉起排队中的任务：每个工具的队首，前提是独占工具空闲、账号额度标记已解除；返回出队几个。 */
  async drain(tool?: Tool) {
    if (this.ctx.closed() || this.ctx.paused()) return 0;
    const held = this.ctx.quota.held();
    let moved = 0;
    for (const entry of heads(this.ctx.db, tool)) {
      const entryTool = entry.tool as Tool;
      if (
        this.ctx.closed() ||
        this.ctx.paused() ||
        held.has(ADAPTERS[entryTool].quotaProvider)
      )
        continue;
      if (ADAPTERS[entryTool].exclusive && this.busy(entryTool)) continue;
      dequeue(this.ctx.db, entry.task_id);
      moved++;
      this.launching.set(entry.task_id, entryTool);
      try {
        const worker = await resolveWorker(
          entry.worker,
          this.ctx.launchOptions.workersDir,
        );
        if (this.ctx.closed()) return moved;
        await this.launch(entry.task_id, { worker, risk: entry.risk as Risk });
      } catch (error) {
        if (this.ctx.closed()) return moved;
        const reason = `排队后拉起失败：${error instanceof Error ? error.message : String(error)}`;
        try {
          // 因额度排队的任务本来就受阻，转移会被拒；照样记下并投递。
          if (getTask(this.ctx.db, entry.task_id).status === "blocked")
            noteTask(this.ctx.db, entry.task_id, "launch_failed", { reason });
          else this.advance(entry.task_id, { kind: "block" }, {}, { reason });
          this.publish(entry.task_id, "blocked", { reason });
        } catch {
          if (!this.ctx.closed())
            noteTask(this.ctx.db, entry.task_id, "launch_failed", { reason });
        }
      } finally {
        this.launching.delete(entry.task_id);
        this.ctx.waits.changed(entry.task_id);
      }
    }
    return moved;
  }

  private park(id: number, worker: string, tool: Tool, risk: Risk) {
    enqueue(this.ctx.db, {
      task_id: id,
      worker,
      tool,
      risk,
      queued_at: Date.now(),
    });
    noteTask(this.ctx.db, id, "queued", {
      worker,
      reason: "等待重启；重启完成后自动派发",
    });
    this.ctx.waits.changed(id);
  }
}
