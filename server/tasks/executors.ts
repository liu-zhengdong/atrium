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
  patchRunFields,
  taskRef,
  type RunFields,
  type Task,
} from "./ledger.ts";
import { publishTask } from "./notice.ts";
import { exitDetail, type Exit } from "./outcome.ts";
import { resolveWorker, type ResolvedWorker, type Risk } from "./profiles.ts";
import { dequeue, heads } from "./queue.ts";
import type { QuotaGuard } from "./quota-runtime.ts";
import { diffSize, logTail, settle } from "./settle.ts";
import { alive, signalGroup, spawnWorker } from "./spawn.ts";
import type { TaskEvent } from "./state.ts";
import { routeAfterThinking } from "./thinking.ts";
import { attemptsOf, retryAfterThinking } from "./thinking-runtime.ts";
import { retryAfterTransient } from "./transient-runtime.ts";
import type { TaskWaits } from "./waits.ts";
import { finalClaudeResult, judge } from "./watchdog.ts";
import {
  prepareRun,
  type LaunchOptions,
  type Prepared,
  type ResumeWith,
} from "./workspace.ts";
import { LiveInput } from "./live-input.ts";
import { markDelivered, markEchoed } from "./tell-ledger.ts";
import { followUpTells } from "./tell-runtime.ts";
import type { ChildProcess } from "node:child_process";
import { collectSkillEdits } from "../skills/collect.ts";
import { beginUsage, endUsage } from "./usage.ts";
import { readPace, type PaceEntry } from "./prepare.ts";
import { DiskBudget } from "./disk-budget.ts";
import { chooseWorker } from "./worker-choice.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";
import { BudgetProblem } from "./budget-problem.ts";

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
  disk: DiskBudget;
  killGraceMs?: number;
  closed: () => boolean;
  onAccepted?: (id: number) => boolean;
};

export class Executors {
  readonly active = new Map<number, Active>();
  /** 正在准备（建 worktree、写提示词）的任务及其工具，防止重复派与独占冲突。 */
  readonly launching = new Map<number, Tool | null>();
  /** 退出收尾期间仍可能自动重派；wait 不应把中途状态当作最终结果。 */
  readonly finishing = new Map<number, number>();
  private ticking = false;

  constructor(private readonly ctx: ExecutorContext) {}

  private async pace() {
    try {
      return await (this.ctx.launchOptions.usagePace ?? readPace)();
    } catch {
      return undefined;
    }
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
    await this.ctx.disk.check(task.node_id, task.repo);
    const prepared = await prepareRun(task, chosen, this.ctx.launchOptions);
    const usagePace = await this.pace();
    if (this.ctx.closed()) throw new Error("服务已关闭");
    const { child, offset } = await spawnWorker(
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
    markDelivered(this.ctx.db, id, prepared.tellIds, "prompt");
    await this.track(
      started,
      chosen,
      prepared,
      child,
      offset,
      retried,
      usagePace,
    );
    return started;
  }

  /**
   * 同一轮里换进程（#307 捎话）：带着补充续上原会话（resume），或保留工作树带着补充重派（未给 resume）。
   * 任务保持 running，只换 pid；关卡按新进程退出后的结果判。
   */
  async relaunch(prev: Active, resume?: ResumeWith & { ids: number[] }) {
    if (this.ctx.closed()) throw new Error("服务已关闭");
    const id = prev.id;
    const task = getTask(this.ctx.db, id);
    const chosen = { worker: prev.worker, risk: prev.risk };
    const prepared = await prepareRun(
      task,
      chosen,
      this.ctx.launchOptions,
      resume,
    );
    const usagePace = await this.pace();
    if (this.ctx.closed()) throw new Error("服务已关闭");
    const { child, offset } = await spawnWorker(
      prepared,
      this.ctx.launchOptions.env,
      task.ref,
      !!resume,
    );
    const pid = child.pid!;
    const ids = resume ? resume.ids : prepared.tellIds;
    const updated = patchRunFields(
      this.ctx.db,
      id,
      { pid },
      resume ? "tell_resumed" : "tell_restarted",
      { pid, worker: prev.worker.id, tells: ids.length },
    );
    markDelivered(this.ctx.db, id, ids, resume ? "resume" : "restart");
    await this.track(
      updated,
      chosen,
      prepared,
      child,
      offset,
      prev.retried,
      usagePace,
    );
  }

  private async track(
    task: Task,
    chosen: Chosen,
    prepared: Prepared,
    child: ChildProcess,
    offset: number,
    retried: boolean,
    usagePace: PaceEntry[] | undefined,
  ) {
    const id = task.id;
    const active = launched({
      task,
      pid: child.pid!,
      child,
      prepared,
      retried,
      exec: this.ctx.exec,
      ...chosen,
    });
    if (prepared.launch.input === "stream-json" && child.stdin)
      active.live = new LiveInput(
        child.stdin,
        prepared.logFile,
        offset,
        (uuid) => markEchoed(this.ctx.db, id, uuid),
      );
    this.active.set(id, active);
    beginUsage(
      this.ctx.db,
      id,
      ADAPTERS[chosen.worker.tool].quotaProvider,
      usagePace,
    );
    child.once(
      "exit",
      (code, signal) => void this.finish(id, { code, signal }),
    );
    await active.probe.baseline();
    this.ctx.waits.changed(id);
  }

  // ---- 退出收尾 ----

  async finish(id: number, exit: Exit) {
    const active = this.active.get(id);
    if (!active || active.exited) return;
    active.exited = true;
    this.finishing.set(id, (this.finishing.get(id) ?? 0) + 1);
    try {
      if (active.finalizing?.forced) {
        noteTask(this.ctx.db, id, "final_result_exit", {
          ...exitDetail(exit),
          result: active.finalizing.result,
        });
        // 终止信号只用于催退。按日志中的最终 result 判本轮结局，事实与关卡照常检查。
        exit = "unknown";
      }
      endUsage(
        this.ctx.db,
        id,
        ADAPTERS[active.tool].quotaProvider,
        await this.pace(),
      );
      if (await followUpTells(this, this.ctx.db, active, exit)) return;
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
      else if (decision.publish === "done" && this.ctx.onAccepted?.(id)) {
        this.publish(id, "merge_queued", published);
      } else
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
      if (!this.ctx.closed()) void this.drain(active.tool);
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
        if (active.stop || active.finalizing) continue;
        const { signals } = await active.probe.poll();
        if (signals.length) active.state.lastProgressAt = Date.now();
        const verdict = judge(active.state, active.limits, Date.now());
        if (verdict.kind === "ok") continue;
        if (active.tool === "claude") {
          const result = await logTail(active.logFile, 1024 * 1024)
            .then(finalClaudeResult)
            .catch(() => undefined);
          if (result) {
            active.finalizing = { result, forced: false };
            noteTask(this.ctx.db, active.id, "finalizing", {
              reason: "最终 result 已输出，执行者仍未退出，催促收尾",
              result,
            });
            if (active.live?.open) {
              active.live.end();
              setTimeout(
                () => this.forceFinalExit(active),
                this.ctx.killGraceMs ?? 10_000,
              ).unref();
            } else this.forceFinalExit(active);
            continue;
          }
        }
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

  private forceFinalExit(active: Active) {
    if (active.exited || !active.finalizing || active.finalizing.forced) return;
    active.finalizing.forced = true;
    signalGroup(active.pid, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) signalGroup(active.pid, "SIGKILL");
    }, this.ctx.killGraceMs ?? 10_000).unref();
  }

  kill(active: Active) {
    signalGroup(active.pid, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) signalGroup(active.pid, "SIGKILL");
    }, this.ctx.killGraceMs ?? 10_000).unref();
  }

  /** 拉起排队中的任务：每个工具的队首，前提是独占工具空闲、账号额度标记已解除；返回出队几个。 */
  async drain(tool?: Tool) {
    if (this.ctx.closed()) return 0;
    const held = this.ctx.quota.held();
    let moved = 0;
    for (const entry of heads(this.ctx.db, tool)) {
      const entryTool = entry.tool as Tool;
      if (this.ctx.closed() || held.has(ADAPTERS[entryTool].quotaProvider))
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
        const task = getTask(this.ctx.db, entry.task_id);
        await chooseWorker(
          { worker: worker.id, risk: entry.risk as Risk },
          this.ctx.launchOptions,
          held,
          { chain: taskAvoidChain(this.ctx.db, task) },
        );
        await this.launch(entry.task_id, { worker, risk: entry.risk as Risk });
      } catch (error) {
        if (this.ctx.closed()) return moved;
        const reason = `排队后拉起失败：${error instanceof Error ? error.message : String(error)}`;
        try {
          // 因额度排队的任务本来就受阻，转移会被拒；照样记下并投递。
          if (getTask(this.ctx.db, entry.task_id).status === "blocked")
            noteTask(this.ctx.db, entry.task_id, "launch_failed", { reason });
          else this.advance(entry.task_id, { kind: "block" }, {}, { reason });
          this.publish(entry.task_id, "blocked", {
            reason,
            ...(error instanceof BudgetProblem ? { source: "budget" } : {}),
          });
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
}
