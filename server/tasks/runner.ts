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
import type { ResolvedWorker } from "./profiles.ts";
import {
  ensureWorkerProfiles,
  importWorkerProfiles,
} from "./worker-profiles.ts";
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
import { pickFor } from "./pick-runtime.ts";
import { writtenNotice, type RunPick } from "./pick.ts";
import { isRisk } from "./profiles.ts";
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
import { settleCouncils } from "./council-runtime.ts";
import {
  councilRow,
  councilView,
  createCouncil,
  decideCouncil,
  STAGE_LABEL,
} from "./councils.ts";
import {
  cliDeploy,
  lastRestartError,
  OnlineWatch,
  type DeployResult,
} from "./online-runtime.ts";
import { selfRepoFlag, selfUpdateEnabled } from "./online.ts";
import {
  currentVersion,
  dataDirectory,
  packageRoot,
} from "../service-state.ts";
import { restartInProgress } from "../supervisor.ts";
import { listLeaders } from "../leaders/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { existsSync } from "node:fs";

/**
 * 派活与等待的运行时（#262）：只做编排与落库。计划、收尾、关卡、看门狗的判定都在各自的纯函数里；
 * 工作区、拉起、事实收集、重启勘察、CI 轮询各在自己的模块。
 */

export type RunnerOptions = {
  data: string;
  /** 旧版执行者档案目录：首次启动导入一次（#355），之后只读数据库。 */
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
  /** 测试可缩短 PR 推送后 GitHub 头视图的等待窗口。 */
  mergeHeadWaitMs?: number;
  /** 事件攒批窗口（毫秒），缺省 0。 */
  batchMs?: number;
  /** 事件交出后的处理中租约（毫秒），缺省 15 分钟；超时仍未 ack 才重投。 */
  leaseMs?: number;
  /** 停止信号发出后多久强杀。 */
  killGraceMs?: number;
  /** 额度报文没给恢复时间时，账号标记保留多久（毫秒）；缺省 1 小时。 */
  quotaUnknownMs?: number;
  /** 自动上线（#325）；缺省按 ATRIUM_UPDATE_REPO、ATRIUM_SELF_UPDATE、本包是否 git 检出与是否默认数据目录决定。 */
  online?: {
    /** 服务自身仓库（`-R` 写法）；合入它的 PR 才自动上线。 */
    selfRepo?: string | null;
    selfUpdate?: boolean;
    version?: () => string;
    deploy?: (version: string) => Promise<DeployResult>;
    pollMs?: number;
  };
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
  private readonly online: OnlineWatch;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly background = new Set<Promise<void>>();
  private readonly exec: Exec;
  private readonly launchOptions: LaunchOptions;
  private closed = false;
  private polling = false;
  /** 会审推进在跑时再来的请求只记一笔，跑完再补一轮，免得重复拉起汇总。 */
  private councilSettling: Promise<void> | null = null;
  private councilAgain = false;
  /** 看板上把日志里的绝对路径缩成相对路径用的工作目录，按任务记一份。 */
  private recovered = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: RunnerOptions,
  ) {
    ensureQueueTable(db);
    ensureWorkerProfiles(db);
    importWorkerProfiles(db, options.workersDir);
    this.inbox = new EventInbox(db, {
      batchMs: options.batchMs,
      leaseMs: options.leaseMs,
    });
    this.exec = options.exec ?? defaultExec;
    const sourceEnv = options.env ?? process.env;
    this.launchOptions = {
      db,
      data: options.data,
      env: workerEnvironment(sourceEnv),
      patrolServiceEnv: {
        ...(sourceEnv.ATRIUM_DATA
          ? { ATRIUM_DATA: sourceEnv.ATRIUM_DATA }
          : {}),
        ...(sourceEnv.ATRIUM_PORT
          ? { ATRIUM_PORT: sourceEnv.ATRIUM_PORT }
          : {}),
      },
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
      // 在收尾的 finally 之后再推进，免得刚结束的任务还算在收尾里。
      councils: {
        settle: () =>
          setImmediate(() =>
            this.settleCouncils().catch((error) =>
              console.error("会审推进失败：", error),
            ),
          ),
      },
    });
    this.merge = new MergeQueue(db, {
      data: options.data,
      env: this.launchOptions.env,
      run: this.exec,
      prHeadWaitMs: options.mergeHeadWaitMs,
      changed: (id) => this.waits.changed(id),
      cleaned: async (id) => {
        await this.cleanup.cleanup(id);
      },
      publish: (id, kind, detail, actor) =>
        this.x.publish(id, kind, detail, actor),
      selfRepo:
        options.online?.selfRepo !== undefined
          ? options.online.selfRepo
          : selfRepoFlag(
              process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium",
            ),
      onMerged: () => this.online.kick(),
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
    this.online = new OnlineWatch(db, {
      run: this.exec,
      version: options.online?.version ?? currentVersion,
      selfUpdate:
        options.online?.selfUpdate ??
        selfUpdateEnabled(process.env.ATRIUM_SELF_UPDATE, {
          gitCheckout: existsSync(join(packageRoot, ".git")),
          defaultData: options.data === dataDirectory({}),
        }),
      selfRepo:
        options.online?.selfRepo !== undefined
          ? options.online.selfRepo
          : selfRepoFlag(
              process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium",
            ),
      busy: () =>
        !!this.db
          .prepare("SELECT 1 FROM tasks WHERE delivery_stage='merging' LIMIT 1")
          .get() || !!restartInProgress(options.data),
      deploy: options.online?.deploy ?? cliDeploy(options.data),
      restartError: (version) => lastRestartError(options.data, version),
      publish: (id, kind, detail) => this.x.publish(id, kind, detail),
      changed: (id) => this.waits.changed(id),
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
        const job = fn()
          .catch((error) => console.error("任务运行时：", error))
          .finally(() => this.background.delete(job));
        this.background.add(job);
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
      if (!this.closed && this.recovered) await this.settleCouncils();
      if (!this.closed && this.recovered) this.review.kick();
      if (!this.closed && this.recovered) this.merge.kick();
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    every(this.options.online?.pollMs ?? 60_000, async () => {
      if (!this.closed && this.recovered) this.online.kick();
    });
    const recovery = this.recover()
      .then(async () => {
        this.recovered = true;
        if (!this.closed) await this.scheduler.tick();
        if (!this.closed) this.review.kick();
        if (!this.closed) this.merge.kick();
        if (!this.closed) this.online.kick();
      })
      .catch((error) => console.error("任务运行时自愈失败：", error))
      .finally(() => this.background.delete(recovery));
    this.background.add(recovery);
  }

  /** 执行者进程不随服务退出：它们在独立进程组里，重启后按 pid 接管。 */
  async close() {
    this.closed = true;
    const mergeClosing = this.merge.close();
    this.review.close();
    this.online.close();
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.background]);
    // 与服务退出时一样关掉即时捎话的写端：执行者处理完本轮后自己退出，重启后按 pid 接管。
    for (const active of this.x.active.values()) void active.live?.finish();
    this.inbox.close();
    this.waits.close();
    await mergeClosing;
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

  /** 派活候选一览（只读）：候选执行者、额度、专员与交付记录，推荐与理由；与 run 自动挑人同一份排序。 */
  async pick(reference: unknown, risk: unknown) {
    const task = getTask(this.db, parseTaskRef(reference));
    if (risk !== undefined && risk !== "" && !isRisk(risk))
      throw new Problem(400, "risk: 只能是 low、medium、high", "usage");
    const pace = await (this.launchOptions.pace ?? readPace)().catch(
      () => undefined,
    );
    const view = await pickFor(task, isRisk(risk) ? risk : "low", {
      db: this.db,
      launchOptions: this.launchOptions,
      pace,
      held: this.quota.held(),
      busy: this.x.busyTools(task.id),
    });
    return { task: task.ref, ...view };
  }

  async run(reference: unknown, body: unknown) {
    const request = runRequest(body);
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    const council = councilRow(this.db, id);
    if (council && council.stage !== "summarizing")
      throw new Problem(
        409,
        council.stage === "opinions"
          ? `${task.ref} 是会审议题，还在等专员意见；意见收齐后自动交 leader 汇总`
          : `${task.ref} 会审${STAGE_LABEL[council.stage]}；要重议另发起会审`,
        "conflict",
        undefined,
        `atrium review show ${task.ref}`,
      );
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
    let pick: RunPick;
    try {
      await this.disk.check(task.node_id, task.repo);
      const pace = await (this.launchOptions.pace ?? readPace)().catch(
        () => undefined,
      );
      if (!pace)
        noteTask(this.db, id, "budget_unknown", {
          reason: "额度数据不可用，份额不拦截",
        });
      const chain = taskAvoidChain(this.db, task);
      const avoid = {
        busy: this.x.busyTools(id),
        chain,
        jobRef: task.job_ref ?? undefined,
      };
      const options = { ...this.launchOptions, pace: async () => pace };
      const held = this.quota.held();
      // 与 task pick 同一份候选排序：专员优先、再按额度富余；写死执行者时据此提醒更富余的候选。
      const view = await pickFor(task, request.risk ?? "low", {
        db: this.db,
        launchOptions: this.launchOptions,
        pace,
        held,
        busy: avoid.busy,
      });
      chosen = await chooseWorker(
        !request.worker && view.recommended
          ? { ...request, worker: view.recommended }
          : request,
        options,
        held,
        avoid,
      );
      pick = request.worker
        ? {
            worker: chosen.worker.id,
            auto: false,
            reason: null,
            notice: writtenNotice(
              view,
              { worker: chosen.worker.id, tool: chosen.worker.tool },
              task.ref,
            ),
          }
        : {
            worker: chosen.worker.id,
            auto: true,
            reason: view.reason,
            notice: null,
          };
    } catch (error) {
      this.x.launching.delete(id);
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    }
    const tool = chosen.worker.tool;
    if (chosen.waitUntil !== undefined) {
      this.x.launching.delete(id);
      return {
        ...this.enqueue(
          task,
          chosen,
          `${ADAPTERS[tool].quotaProvider} 额度用尽，等到 ${clock(chosen.waitUntil)} 恢复后自动拉起`,
        ),
        pick,
      };
    }
    if (
      placement(ADAPTERS[tool].exclusive, this.x.busy(tool, id)) === "queue"
    ) {
      this.x.launching.delete(id);
      return {
        ...this.enqueue(
          task,
          chosen,
          `${tool} 同一时刻只跑一个，前一个结束后自动拉起`,
        ),
        pick,
      };
    }
    this.x.launching.set(id, tool);
    try {
      return { task: await this.x.launch(id, chosen), queued: false, pick };
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
    return recoverRunning(this.x, this.db, {
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

  requeueMerge(reference: unknown) {
    return { task: this.merge.requeue(parseTaskRef(reference)) };
  }

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
  tell(reference: unknown, body: unknown, actor?: string) {
    const result = tellTask(this.x, this.db, reference, body, actor);
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

  // ---- 会审（#322 第 3 步） ----

  /** 发起会审：建议题与各专员的意见任务，并行拉起；拉不起的标受阻，汇总时算没出意见。 */
  async addCouncil(body: unknown) {
    const { council, opinions } = createCouncil(
      this.db,
      this.options.data,
      body,
    );
    await Promise.all(opinions.map((ref) => this.dispatchCouncil(ref)));
    // 全部拉不起时意见已齐，直接进汇总。
    await this.settleCouncils();
    return councilView(this.db, council.ref);
  }

  council(reference: unknown) {
    return councilView(this.db, reference);
  }

  /** 用户对上交的会审拍板。 */
  decideCouncil(reference: unknown, body: unknown, actor: string) {
    const view = decideCouncil(this.db, reference, body, actor);
    this.x.publish(
      Number(view.ref.slice(1)),
      "council_decided",
      {
        conclusion: view.conclusion,
        by: actor,
        next: `atrium review show ${view.ref}`,
      },
      actor,
    );
    this.waits.changed(Number(view.ref.slice(1)));
    return view;
  }

  /** 拉起会审里的任务（专员意见或 leader 汇总）；拉不起的标受阻并写原因。 */
  private async dispatchCouncil(ref: string) {
    try {
      await this.run(ref, {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const task = getTask(this.db, ref);
      if (task.status === "todo")
        this.x.advance(
          task.id,
          { kind: "block" },
          {},
          { reason: `会审任务拉不起来：${reason}` },
        );
      this.waits.changed(task.id);
    }
  }

  /** 推进会审：意见收齐交 leader 汇总；汇总完成记结论，已定或需用户拍板都投给负责人。 */
  settleCouncils(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.councilSettling) {
      this.councilAgain = true;
      return this.councilSettling;
    }
    const run = async () => {
      do {
        this.councilAgain = false;
        const busy = (id: number) =>
          this.x.active.has(id) ||
          this.x.launching.has(id) ||
          this.x.finishing.has(id) ||
          !!queued(this.db, id);
        const progress = settleCouncils(this.db, this.options.data, busy);
        for (const decision of progress.decided) {
          const { id, outcome, opinions } = decision;
          const ref = taskRef(id);
          this.x.publish(id, `council_${outcome.kind}`, {
            conclusion: outcome.conclusion,
            opinions: opinions.map((o) => ({
              concern: o.ref,
              name: o.name,
              stance: o.stance,
            })),
            ...(outcome.escalate.length ? { escalate: outcome.escalate } : {}),
            next:
              outcome.kind === "escalated"
                ? `需用户拍板：atrium review show ${ref}；拍板后 atrium review decide ${ref} 结论`
                : `atrium review show ${ref}`,
          });
          this.waits.changed(id);
        }
        for (const ref of progress.dispatch) {
          if (this.closed) return;
          await this.dispatchCouncil(ref);
        }
      } while (this.councilAgain && !this.closed);
    };
    // 在 finally 里清锁：没有要等的动作时 run() 同步跑完，不能在赋值前就清掉。
    const settling = run().finally(() => {
      if (this.councilSettling === settling) this.councilSettling = null;
    });
    this.councilSettling = settling;
    return settling;
  }

  /** 会审议题在专员出意见、leader 汇总到记下结论之前都算没结束。 */
  private councilPending(id: number, task: Task) {
    const council = councilRow(this.db, id);
    if (!council || task.status === "cancelled") return false;
    if (council.stage === "opinions") return true;
    return (
      council.stage === "summarizing" &&
      (task.status === "todo" ||
        task.status === "running" ||
        task.status === "done")
    );
  }

  private pending(id: number, task: Task) {
    return (
      task.status === "running" ||
      task.delivery_stage === "reviewing" ||
      task.delivery_stage === "merge_queued" ||
      task.delivery_stage === "merging" ||
      this.merge.isReturning(id) ||
      (task.status === "blocked" && awaitingReview(this.db, id)) ||
      this.councilPending(id, task) ||
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
    // leader 层：每位 leader 负责什么、最近一次唤醒、在处理什么、还有几件要处理的事。没有 leader 时不给。
    const leaders = hasOrg(this.db)
      ? listLeaders(this.db).leaders.map((l) => ({
          ref: l.ref,
          name: l.name,
          nodes: l.nodes.map((n) => n.ref),
          wake: l.wake,
          events: this.inbox.countPending(l.ref),
        }))
      : [];
    return {
      now,
      recent_ms: RECENT_MS,
      subscriber: who,
      counts: {
        ...countRows(rows),
        events: this.inbox.countPending(who),
      },
      ...(leaders.length ? { leaders } : {}),
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
