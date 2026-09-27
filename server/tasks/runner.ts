import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { recentAction } from "./action.ts";
import { taskDir } from "./active.ts";
import { ADAPTERS, isTool, TOOLS, type Tool } from "./adapters/index.ts";
import { CI_BATCH, CI_POLL_MS, pollCiOnce } from "./ci-poll.ts";
import { EventInbox } from "./events.ts";
import { Executors, type Chosen } from "./executors.ts";
import { exec as defaultExec, type Exec } from "./git.ts";
import {
  DEFAULT_OWNER,
  getTask,
  noteTask,
  ownerOf,
  parseTaskRef,
  taskRef,
  type Task,
} from "./ledger.ts";
import { readLogChunk, readLogTail } from "./log-view.ts";
import { admit, placement, runRequest } from "./plan.ts";
import type { PaceEntry } from "./prepare.ts";
import { DEFAULT_WORKERS_DIR, type ResolvedWorker } from "./profiles.ts";
import { dequeue, enqueue, ensureQueueTable, queued } from "./queue.ts";
import { clock } from "./quota-holds.ts";
import { QuotaGuard } from "./quota-runtime.ts";
import { recoverRunning } from "./recovery.ts";
import { signalGroup } from "./spawn.ts";
import { countRows, RECENT_MS, topRows } from "./top.ts";
import { TaskWaits } from "./waits.ts";
import { chooseWorker, type Choice } from "./worker-choice.ts";
import { workerEnvironment } from "./worker-env.ts";
import { Scheduler, planItem } from "./schedule.ts";
import { requireRow } from "./ledger-model.ts";
import { schedulePrExec } from "./schedule-pr.ts";
import type { LaunchOptions } from "./workspace.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";
import { tellTask } from "./tell-runtime.ts";
import { DiskBudget } from "./disk-budget.ts";
import { BudgetProblem } from "./budget-problem.ts";
import { readPace } from "./prepare.ts";
import { MergeQueue } from "./merge-runtime.ts";
import { settleReviews } from "./concern-runtime.ts";
import { awaitingReview } from "./concerns.ts";
import { WorktreeCleanup } from "./worktree-cleanup.ts";
import { ReviewGate, taskRisk } from "./review-runtime.ts";
import { reviewerRefusal } from "./review.ts";

/**
 * 派活与等待的运行时（#262）：只做编排与落库。计划、收尾、关卡、看门狗的判定都在各自的纯函数里；
 * 工作区、拉起、事实收集、重启勘察、CI 轮询各在自己的模块。
 */

export type RunnerOptions = {
  data: string;
  workersDir?: string;
  /** 执行者环境的来源（再经白名单过滤）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  pace?: () => Promise<PaceEntry[] | undefined>;
  usagePace?: () => Promise<PaceEntry[] | undefined>;
  diskFreeGb?: (path: string) => Promise<number>;
  charterPath?: string;
  tickMs?: number;
  ciPollMs?: number;
  ciBatch?: number;
  /** 事件攒批窗口（毫秒），缺省 0。 */
  batchMs?: number;
  /** 事件交出后的处理中租约（毫秒），缺省 15 分钟；超时仍未 ack 才重投。 */
  leaseMs?: number;
  /** 停止信号发出后多久强杀。 */
  killGraceMs?: number;
  /** 额度报文没给恢复时间时，账号标记保留多久（毫秒）；缺省 1 小时。 */
  quotaUnknownMs?: number;
};

export class TaskRunner {
  readonly inbox: EventInbox;
  private readonly x: Executors;
  private readonly waits: TaskWaits;
  private readonly quota: QuotaGuard;
  private readonly scheduler: Scheduler;
  private readonly disk: DiskBudget;
  private readonly cleanup: WorktreeCleanup;
  private readonly merge: MergeQueue;
  private readonly review: ReviewGate;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly exec: Exec;
  private readonly launchOptions: LaunchOptions;
  private closed = false;
  private polling = false;
  /** 看板上把日志里的绝对路径缩成相对路径用的工作目录，按任务记一份。 */
  private recovered = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: RunnerOptions,
  ) {
    ensureQueueTable(db);
    this.inbox = new EventInbox(db, {
      batchMs: options.batchMs,
      leaseMs: options.leaseMs,
    });
    this.exec = options.exec ?? defaultExec;
    this.launchOptions = {
      db,
      data: options.data,
      workersDir: options.workersDir ?? DEFAULT_WORKERS_DIR,
      env: workerEnvironment(options.env ?? process.env),
      run: this.exec,
      pace: options.pace,
      usagePace: options.usagePace,
      charterPath: options.charterPath,
    };
    this.cleanup = new WorktreeCleanup(
      db,
      this.exec,
      (id) =>
        this.x?.active.has(id) ||
        this.x?.launching.has(id) ||
        this.x?.finishing.has(id),
    );
    this.disk = new DiskBudget(
      db,
      options.data,
      options.diskFreeGb,
      this.cleanup,
    );
    this.waits = new TaskWaits(
      (id) => this.settled(id),
      (id) => getTask(this.db, id),
    );
    this.quota = new QuotaGuard({
      db,
      inbox: this.inbox,
      launchOptions: this.launchOptions,
      unknownMs: options.quotaUnknownMs,
    });
    this.x = new Executors({
      db,
      inbox: this.inbox,
      exec: this.exec,
      launchOptions: this.launchOptions,
      waits: this.waits,
      quota: this.quota,
      disk: this.disk,
      killGraceMs: options.killGraceMs,
      closed: () => this.closed,
      onAccepted: (id) => this.review.admit(id),
      reviews: {
        dispatch: (ref) => this.run(ref, {}),
        settle: () => void this.settleReviews(),
      },
    });
    this.merge = new MergeQueue(db, {
      data: options.data,
      env: this.launchOptions.env,
      run: this.exec,
      changed: (id) => this.waits.changed(id),
      cleaned: async (id) => {
        await this.cleanup.cleanup(id);
      },
      publish: (id, kind, detail, actor) =>
        this.x.publish(id, kind, detail, actor),
      returned: async (task) => {
        if (this.closed || !task.worker) return;
        await this.run(task.ref, {
          worker: task.worker,
          risk: taskRisk(this.db, task.id),
        });
      },
    });
    this.review = new ReviewGate(db, {
      data: options.data,
      workersDir: this.launchOptions.workersDir,
      run: this.exec,
      pickReviewer: (original) => this.pickReviewer(original),
      launch: (ref, worker) => this.run(ref, { worker, risk: "low" }),
      inFlight: (id) => this.pending(id, getTask(this.db, id)),
      stopTask: (ref, by) => void this.stop(ref, by),
      enqueue: (id) => this.merge.enqueue(id),
      handBack: (task, reason) => this.merge.handBack(task, reason),
      changed: (id) => this.waits.changed(id),
      publish: (id, kind, detail, actor) =>
        this.x.publish(id, kind, detail, actor),
    });
    this.scheduler = new Scheduler(
      db,
      this.inbox,
      (ref) => this.run(ref, {}),
      options.exec ?? schedulePrExec,
    );
  }

  async cleanupCancelled(id: number) {
    try {
      await this.cleanup.cleanup(id);
    } catch (error) {
      console.error(`t${id} 工作树清理失败：`, error);
    }
  }

  clearQuota(provider: string) {
    return this.quota.clear(this.x, provider);
  }

  /** 启动看门狗（顺带解除到期的额度标记）与 CI 轮询，并在后台自愈上次遗留的运行中任务（不阻塞启动）。 */
  start() {
    const every = (ms: number, fn: () => Promise<void>) => {
      const timer = setInterval(() => {
        void fn().catch((error) => console.error("任务运行时：", error));
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.options.tickMs ?? 5000, async () => {
      await this.x.tick();
      if (!this.closed) await this.cleanup.finished();
      if (!this.closed) await this.disk.refresh();
      if (!this.closed) await this.quota.releaseExpired(this.x);
      if (!this.closed && this.recovered) await this.scheduler.tick();
      if (!this.closed && this.recovered) await this.settleReviews();
      if (!this.closed && this.recovered) this.review.kick();
      if (!this.closed && this.recovered) this.merge.kick();
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    void this.recover()
      .then(async () => {
        this.recovered = true;
        if (!this.closed) await this.scheduler.tick();
        if (!this.closed) this.review.kick();
        if (!this.closed) this.merge.kick();
      })
      .catch((error) => console.error("任务运行时自愈失败：", error));
  }

  /** 执行者进程不随服务退出：它们在独立进程组里，重启后按 pid 接管。 */
  close() {
    this.closed = true;
    this.merge.close();
    this.review.close();
    for (const timer of this.timers) clearInterval(timer);
    // 与服务退出时一样关掉即时捎话的写端：执行者处理完本轮后自己退出，重启后按 pid 接管。
    for (const active of this.x.active.values()) void active.live?.finish();
    this.inbox.close();
    this.waits.close();
  }

  /** Count the ledger and in-flight launches, including work recovered after a service crash. */
  runningTaskRefs(): string[] {
    const query = this.db.prepare(
      "SELECT id FROM tasks WHERE status='running' AND id>? ORDER BY id LIMIT 200",
    );
    const rows: { id: number }[] = [];
    let after = 0;
    for (;;) {
      const page = query.all(after) as { id: number }[];
      rows.push(...page);
      if (page.length < 200) break;
      after = page.at(-1)!.id;
    }
    return [
      ...new Set([...rows.map(({ id }) => id), ...this.x.launching.keys()]),
    ]
      .sort((a, b) => a - b)
      .map((id) => `t${id}`);
  }

  // ---- 派活 ----

  async run(reference: unknown, body: unknown) {
    const request = runRequest(body);
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    const schedule = planItem(this.db, requireRow(this.db, id));
    if (
      schedule.group === "waiting" ||
      (schedule.group === "blocked" && task.schedule_state === "blocked")
    )
      throw new Problem(
        409,
        `${task.ref} 依赖未就绪：${schedule.reason ?? schedule.waiting_for.join("、")}`,
        "conflict",
        undefined,
        "atrium task plan",
      );
    const admission = admit({
      status: task.status,
      running: this.x.active.has(id) || this.x.launching.has(id),
      queued: !!queued(this.db, id),
    });
    if (!admission.ok)
      throw new Problem(
        409,
        `${task.ref}：${admission.reason}`,
        "conflict",
        undefined,
        `atrium task show ${task.ref}`,
      );
    this.x.launching.set(id, null);
    let chosen: Choice;
    try {
      await this.disk.check(task.node_id, task.repo);
      const pace = await (this.launchOptions.pace ?? readPace)().catch(
        () => undefined,
      );
      if (!pace)
        noteTask(this.db, id, "budget_unknown", {
          reason: "额度数据不可用，份额不拦截",
        });
      chosen = await chooseWorker(
        request,
        { ...this.launchOptions, pace: async () => pace },
        this.quota.held(),
        { busy: this.x.busyTools(id), chain: taskAvoidChain(this.db, task) },
      );
    } catch (error) {
      this.x.launching.delete(id);
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    }
    const tool = chosen.worker.tool;
    if (chosen.waitUntil !== undefined) {
      this.x.launching.delete(id);
      return this.enqueue(
        task,
        chosen,
        `${ADAPTERS[tool].quotaProvider} 额度用尽，等到 ${clock(chosen.waitUntil)} 恢复后自动拉起`,
      );
    }
    if (
      placement(ADAPTERS[tool].exclusive, this.x.busy(tool, id)) === "queue"
    ) {
      this.x.launching.delete(id);
      return this.enqueue(
        task,
        chosen,
        `${tool} 同一时刻只跑一个，前一个结束后自动拉起`,
      );
    }
    this.x.launching.set(id, tool);
    try {
      return { task: await this.x.launch(id, chosen), queued: false };
    } catch (error) {
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    } finally {
      this.x.launching.delete(id);
    }
  }

  private blockBudget(task: Task, reason: string) {
    noteTask(this.db, task.id, "budget_blocked", { reason });
    this.x.advance(
      task.id,
      task.status === "todo"
        ? { kind: "block" }
        : { kind: "manual_set", to: "blocked" },
      {},
      { reason },
    );
    this.x.publish(task.id, "blocked", {
      reason,
      source: "budget",
      next: "等窗口重置或请上层调整份额",
    });
    this.waits.changed(task.id);
    return { task: getTask(this.db, task.id), queued: false };
  }

  private enqueue(task: Task, chosen: Chosen, reason: string) {
    enqueue(this.db, {
      task_id: task.id,
      tool: chosen.worker.tool,
      worker: chosen.worker.id,
      risk: chosen.risk,
      queued_at: Date.now(),
    });
    if (task.status !== "todo")
      this.x.advance(
        task.id,
        { kind: "manual_set", to: "todo" },
        {},
        "排队重派",
      );
    noteTask(this.db, task.id, "queued", {
      worker: chosen.worker.id,
      reason,
    });
    this.waits.changed(task.id);
    return { task: getTask(this.db, task.id), queued: true };
  }

  /** 服务重启自愈：进程已不在的置 failed；还在的按 pid 接管；再把排队的拉起来。 */
  recover() {
    return recoverRunning(this.x, this.db, this.launchOptions.workersDir, {
      data: this.options.data,
      exec: this.exec,
      changed: (id) => this.waits.changed(id),
    });
  }

  async pollCi() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      for (const outcome of await pollCiOnce(
        this.db,
        this.options.ciBatch ?? CI_BATCH,
        this.exec,
      )) {
        this.x.publish(outcome.task.id, `ci_${outcome.ci ?? "none"}`, {
          source: "ci",
          ...(outcome.detail ? { reason: outcome.detail } : {}),
          ...(outcome.accepted ? { accepted: true } : {}),
        });
        if (outcome.accepted && outcome.task.deliver === "pr")
          await this.review.admit(outcome.task.id);
        this.waits.changed(outcome.task.id);
      }
    } finally {
      this.polling = false;
    }
  }

  /** 审阅者：自动挑人，跳过原执行者的工具、同模型与 trust 不足 medium 的，直到挑到或无人可挑。 */
  private async pickReviewer(original: ResolvedWorker | undefined) {
    const exclude = new Set<Tool>(original ? [original.tool] : []);
    const refusals: string[] = [];
    while (exclude.size <= TOOLS.length) {
      let choice: Choice;
      try {
        choice = await chooseWorker(
          { risk: "low" },
          this.launchOptions,
          this.quota.held(),
          { exclude },
        );
      } catch (error) {
        // 排除过的工具在挑人函数里按「临时错误换人」措辞，不照抄，免得误导。
        refusals.push(
          refusals.length
            ? "其余执行者都不可用"
            : error instanceof Error
              ? error.message
              : String(error),
        );
        break;
      }
      const refusal = reviewerRefusal(
        { tool: original?.tool ?? "", model: original?.cliModel },
        {
          tool: choice.worker.tool,
          model: choice.worker.cliModel,
          trust: choice.worker.profile.rules.trust,
        },
      );
      if (!refusal) return choice.worker.id;
      refusals.push(refusal);
      exclude.add(choice.worker.tool);
    }
    throw new Error(refusals.join("；"));
  }

  // ---- 停止、日志、等待 ----

  /** by：发起停止的订阅者，由此产生的事件不投给他本人。 */
  stop(reference: unknown, by?: string) {
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    const mergeStop = this.review.stop(id, by) ?? this.merge.stop(id, by);
    if (mergeStop)
      return { task: getTask(this.db, id), stopping: mergeStop.stopping };
    if (dequeue(this.db, id)) {
      noteTask(this.db, id, "unqueued", { reason: "人工停止，移出队列" });
      this.waits.changed(id);
      return { task: getTask(this.db, id), stopping: false };
    }
    const active = this.x.active.get(id);
    if (active && !active.exited) {
      active.stop = { kind: "user", ...(by ? { by } : {}) };
      noteTask(this.db, id, "stop_requested", {
        pid: active.pid,
        ...(by ? { by } : {}),
      });
      this.x.kill(active);
      return { task: getTask(this.db, id), stopping: true };
    }
    if (this.x.launching.has(id))
      throw new Problem(409, `${task.ref} 正在启动，稍后再停`, "conflict");
    if (task.status !== "running")
      throw new Problem(
        409,
        `${task.ref} 不在运行（当前 ${task.status}）`,
        "conflict",
        undefined,
        `atrium task show ${task.ref}`,
      );
    // 账本说在跑、服务却没有掌握这个进程：直接收尾，免得一直挂着。
    if (task.pid) signalGroup(task.pid, "SIGTERM");
    const stopped = this.x.advance(
      id,
      { kind: "exit_fail" },
      {},
      { reason: "人工停止（服务未掌握该进程）" },
    );
    this.x.publish(id, "failed", { reason: "人工停止" }, by);
    this.waits.changed(id);
    return { task: stopped, stopping: false };
  }

  /** 给在跑的执行者捎话（#307）；不在跑的留到下次拉起时写进提示词。 */
  tell(reference: unknown, body: unknown) {
    const result = tellTask(this.x, this.db, reference, body);
    this.waits.changed(result.task.id);
    return result;
  }

  /** 专员关卡补判（#322）：审查任务不再跑后记结论，父任务全部出结论时补判通过或留在受阻并投递。 */
  async settleReviews() {
    if (this.closed) return;
    const busy = (id: number) =>
      this.x.active.has(id) ||
      this.x.launching.has(id) ||
      this.x.finishing.has(id) ||
      !!queued(this.db, id);
    for (const resolution of settleReviews(this.db, busy)) {
      const { parent, outcome, concerns } = resolution;
      // 专员关卡通过后再按风险去审阅或合入队列。
      const admitted = resolution.accepted && (await this.review.admit(parent));
      const kind = admitted
        ? admitted.kind
        : resolution.accepted
          ? "done"
          : "blocked";
      this.x.publish(parent, kind, {
        ...(admitted ? admitted.detail : {}),
        reason: (admitted && admitted.detail?.reason) || outcome.reason,
        concerns,
        ...(outcome.kind === "vetoed" ? { vetoed: true } : {}),
        ...(resolution.accepted
          ? {}
          : { next: `atrium task show ${taskRef(parent)}` }),
      });
      this.waits.changed(parent);
    }
  }

  private pending(id: number, task: Task) {
    return (
      task.status === "running" ||
      task.delivery_stage === "reviewing" ||
      task.delivery_stage === "merge_queued" ||
      task.delivery_stage === "merging" ||
      this.merge.isReturning(id) ||
      (task.status === "blocked" && awaitingReview(this.db, id)) ||
      !!queued(this.db, id) ||
      this.x.launching.has(id) ||
      this.x.finishing.has(id)
    );
  }

  async log(reference: unknown, after: unknown) {
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    const offset = after === undefined || after === "" ? 0 : Number(after);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Problem(400, "after: 应为非负整数字节偏移", "usage");
    const chunk = await readLogChunk(
      join(taskDir(this.options.data, id), "log"),
      offset,
    );
    return { ...chunk, running: this.pending(id, task), status: task.status };
  }

  /**
   * 进行中任务的实时视图（#262 `atrium top`）：在跑、排队、受阻与刚结束的，
   * 每行带日志尾部解析出的最近一个动作与日志最后写入时刻。只读，日志最多读尾部固定字节数。
   * 解析不出动作时 action 为 null，但 log_at 照给，命令行据此说「日志 N 秒前有输出」。
   */
  async top(input: { as?: string; now?: number } = {}) {
    const now = input.now ?? Date.now();
    const who = input.as ? ownerOf(input.as, "as") : DEFAULT_OWNER;
    const { rows, truncated } = topRows(this.db, now);
    const logs = await Promise.all(
      rows.map((row) => {
        const id = Number(row.ref.slice(1));
        return readLogTail(join(taskDir(this.options.data, id), "log"));
      }),
    );
    return {
      now,
      recent_ms: RECENT_MS,
      subscriber: who,
      counts: {
        ...countRows(rows),
        events: this.inbox.countPending(who),
      },
      rows: rows.map((row, index) => {
        const action = recentAction({
          tool: toolOf(row.worker),
          tail: logs[index]!.text,
        });
        return {
          ...row,
          log_at: logs[index]!.at,
          action: action ? { text: action.text, kind: action.kind } : null,
        };
      }),
      truncated,
    };
  }

  private settled(id: number) {
    const task = getTask(this.db, id);
    return this.pending(id, task) ? null : task;
  }

  /** 任务离开 running（且不在排队、不在启动）或超时返回。 */
  wait(reference: unknown, seconds: number, signal?: AbortSignal) {
    const id = parseTaskRef(reference);
    const now = this.settled(id);
    if (now || seconds <= 0 || this.closed)
      return Promise.resolve({
        task: now ?? getTask(this.db, id),
        timed_out: !now,
      });
    return this.waits.wait(id, seconds, signal);
  }
}

/** 执行者标识 `工具+模型[:强度]` 里的工具；取不出就不是已知工具，按未知日志处理。 */
const toolOf = (worker: string | null): Tool | undefined => {
  const head = worker?.split(/[+:]/, 1)[0]?.trim();
  return isTool(head) ? head : undefined;
};
