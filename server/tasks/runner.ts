import { pickSpecialists } from "./specialist-scope.ts";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { recentAction } from "./action.ts";
import { taskDir } from "./active.ts";
import { ADAPTERS, isTool, TOOLS, type Tool } from "./adapters/index.ts";
import { CI_BATCH, CI_POLL_MS, pollCiOnce } from "./ci-poll.ts";
import { EventInbox } from "./events.ts";
import { Retention } from "./retention.ts";
import { Executors, type Chosen } from "./executors.ts";
import { exec as defaultExec, type Exec } from "./git.ts";
import {
  DEFAULT_OWNER,
  getTask,
  noteTask,
  ownerOf,
  parseTaskRef,
  taskRef,
  updateTask,
  type Task,
} from "./ledger.ts";
import { readLogChunk, readLogTail } from "./log-view.ts";
import {
  admit,
  placement,
  riskRefusal,
  runRequest,
  type RunRequest,
} from "./plan.ts";
import type { PaceEntry } from "./prepare.ts";
import { resolveWorker, type ResolvedWorker } from "./profiles.ts";
import {
  ensureWorkerProfiles,
  importWorkerProfiles,
} from "./worker-profiles.ts";
import {
  dequeue,
  enqueue,
  ensureQueueTable,
  queued,
  queueView,
} from "./queue.ts";
import { idleWaitText, isIdle } from "./priority.ts";
import { clock } from "./quota-holds.ts";
import { QuotaGuard } from "./quota-runtime.ts";
import { recoverRunning } from "./recovery.ts";
import { killTree } from "../platform/index.ts";
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
import { overruleConcerns, settleReviews } from "./concern-runtime.ts";
import { concernNext } from "./concern-gate.ts";
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
import { verifyWorkers } from "./verify.ts";
import {
  isVerifyTask,
  openVerify,
  settleVerifications,
  unsentVerify,
} from "./verify-runtime.ts";
import {
  currentVersion,
  isDefaultData,
  packageRoot,
} from "../service-state.ts";
import { restartInProgress } from "../supervisor.ts";
import { listLeaders } from "../leaders/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { existsSync } from "node:fs";
import { HostLoad, hostView } from "./host-load.ts";
import { OrphanReaper, recognizer, spawnOwner } from "./orphans.ts";
import { sharedLocalChecks } from "./local-check.ts";
import { skipIfBusy } from "./reentry.ts";
import { RemoteHosts } from "../hosts/remote.ts";
import { HostTunnels } from "../hosts/tunnels.ts";
import { sshConnection } from "../hosts/tunnel-plan.ts";
import { servicePort } from "../service-state.ts";
import type { ChildProcess } from "node:child_process";
import type { SshConnection } from "../hosts/tunnel-plan.ts";
import {
  addHost,
  editHostConnection,
  ensureHostTables,
  ensureLocalHost,
  hostRow,
  hostRows,
  hostView as hostRowView,
  removeHost,
  setPaused,
  type HostRow,
  type HostView,
} from "../hosts/model.ts";
import {
  chooseHost,
  connection,
  hostFit,
  hostRef,
  LOCAL_HOST,
  parseHostRef,
  type HostCandidate,
  type HostInfo,
  type HostLoadReport,
  type HostNeed,
} from "../hosts/state.ts";
import { checkRoleText, type CheckCandidate } from "../hosts/check-plan.ts";
import { CheckDispatch } from "../hosts/check-runtime.ts";
import { setHostQuotaSource, type HostQuotaSnapshot } from "../hosts/quota.ts";
import { machineInfo } from "../hosts/info.ts";
import { originRepo } from "./gh-repo.ts";
import { patrolRun } from "./patrol.ts";
import { isTotal, openDescendants, totalRefusal } from "./rollup-ledger.ts";
import { publishTotals } from "./notice.ts";
import { productRound } from "../products/model.ts";
import { pendingChoices } from "../choices/store.ts";
import { UrgentLane } from "./urgent-runtime.ts";
import { storedHosts, urgentIdleMs } from "./urgent.ts";
import { crowded } from "../hosts/state.ts";
import { hasEvent } from "./ledger-model.ts";
import type { Active } from "./active.ts";

/**
 * 派活与等待的运行时（#262）：只做编排与落库。计划、收尾、关卡、看门狗的判定都在各自的纯函数里；
 * 工作区、拉起、事实收集、重启勘察、CI 轮询各在自己的模块。
 */

/** 收件箱与任务事件保留清理的间隔（#t126）：半小时一轮，每轮有界。 */
const RETENTION_SWEEP_MS = 30 * 60_000;

export type RunnerOptions = {
  data: string;
  /** 测试注入假的 SSH 进程；不读取开发者的 SSH 配置。 */
  tunnelSpawn?: (connection: SshConnection) => ChildProcess;
  tunnelStop?: (child: ChildProcess) => void;
  /** 旧版执行者档案目录：首次启动导入一次（#355），之后只读数据库。 */
  workersDir?: string;
  /** 执行者环境的来源（再经白名单过滤）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  pace?: () => Promise<PaceEntry[] | undefined>;
  usagePace?: () => Promise<PaceEntry[] | undefined>;
  /** 测试注入：计数 du，不碰本机真实 du。 */
  diskDu?: (path: string) => Promise<number>;
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
  /**
   * 上线后的端到端验证（t181）：按顺序试的验证执行者组合；缺省读 ATRIUM_VERIFY_WORKERS（逗号分隔），
   * 没写用 opencode+deepseek、cursor+auto。给空数组不派人，只记「无法验证」。
   */
  verify?: { workers?: string[] };
  /** 本机减负（#358）：执行者并发上限、本地检查并发、负载阈值；缺省按服务环境与核数（host-load.ts）。 */
  host?: HostLoad;
  /** 代理长轮询每轮最多挂多久（毫秒）；测试缩短。 */
  agentPollMs?: number;
  /** 派给代理要等结果的指令没人来领多久就报错（毫秒）；测试缩短。 */
  agentPickupMs?: number;
  /** 代理多久没来算离线（测试缩短）；缺省 1 分钟。 */
  agentOnlineMs?: number;
  /** 远程检查进行中多久看一次那台在不在线（测试缩短）。 */
  agentCheckWatchMs?: number;
  /** 紧急任务没有进展多久换执行者（毫秒，t215）；缺省读 ATRIUM_URGENT_IDLE_MINUTES，10 分钟。 */
  urgentIdleMs?: number;
  /** 合入检查没跑成后第几次重跑前等多久（t204）；测试缩短。 */
  checkRerunDelayMs?: (attempt: number) => number;
};

export class TaskRunner {
  readonly inbox: EventInbox;
  private readonly x: Executors;
  private readonly waits: TaskWaits;
  private readonly quota: QuotaGuard;
  private readonly scheduler: Scheduler;
  private readonly retention: Retention;
  private readonly disk: DiskBudget;
  private readonly cleanup: WorktreeCleanup;
  private readonly merge: MergeQueue;
  private readonly review: ReviewGate;
  private readonly online: OnlineWatch;
  private readonly host: HostLoad;
  /** 任务早已结束还活着的执行者子孙（t203）。 */
  private readonly orphans: OrphanReaper;
  /** 远程主机的代理连接（#358 第 1 步）。 */
  readonly remote: RemoteHosts;
  private readonly tunnels: HostTunnels;
  /** 合入队列的重跑检查派到哪台跑（#358 第 2 步）。 */
  readonly checks: CheckDispatch;
  /** 紧急通道（t215）：止损、抢占、续上。 */
  readonly lane: UrgentLane;
  /** 紧急任务等上线时，上次催上线观察的时刻。 */
  private urgentOnlineAt = 0;
  /** 额度多主机合并的来源（quota-source 经 hosts/quota.ts 取）。 */
  private readonly quotaSource = () => this.hostQuota();
  /** 任务仓库路径 → owner/name（挑远程主机时对仓库白名单）；解析不出为 null。 */
  private readonly repoKeys = new Map<string, string | null>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly background = new Set<Promise<void>>();
  private readonly exec: Exec;
  private readonly launchOptions: LaunchOptions;
  private closed = false;
  private polling = false;
  /** 会审推进在跑时再来的请求只记一笔，跑完再补一轮，免得重复拉起汇总。 */
  private councilSettling: Promise<void> | null = null;
  private councilAgain = false;
  /** 上线验证的执行者，按顺序试。 */
  private readonly verifyWorkers: string[];
  /** 看板上把日志里的绝对路径缩成相对路径用的工作目录，按任务记一份。 */
  private recovered = false;
  /** 上次遗留的在跑任务接管完了没有（周期任务等它再判上一轮）。 */
  get ready() {
    return this.recovered && !this.closed;
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: RunnerOptions,
  ) {
    ensureQueueTable(db);
    ensureWorkerProfiles(db);
    importWorkerProfiles(db, options.workersDir);
    // 本机限额只看服务自己的环境（不是给执行者的 options.env）。
    const owner = spawnOwner(options.data);
    this.host =
      options.host ?? HostLoad.fromEnv(process.env, recognizer(db, owner));
    this.orphans = new OrphanReaper(db, owner, killTree);
    sharedLocalChecks.limit = this.host.limits.maxChecks;
    sharedLocalChecks.timeoutMs = this.host.limits.checkTimeoutMs;
    // 执行机器（#358）：本机登记为 h1；远程主机由代理接入。
    ensureHostTables(db);
    ensureLocalHost(
      db,
      machineInfo({
        dataDir: options.data,
        version: currentVersion(),
        env: options.env ?? process.env,
      }),
    );
    this.tunnels = new HostTunnels(db, options.tunnelSpawn, options.tunnelStop);
    this.remote = new RemoteHosts(db, options.data, {
      pollMs: options.agentPollMs,
      pickupMs: options.agentPickupMs,
      onlineMs: options.agentOnlineMs,
      checkWatchMs: options.agentCheckWatchMs,
    });
    this.checks = new CheckDispatch({
      remote: this.remote,
      candidates: () => this.checkCandidates(),
      run: options.exec ?? defaultExec,
    });
    setHostQuotaSource(this.quotaSource);
    this.inbox = new EventInbox(db, {
      batchMs: options.batchMs,
      leaseMs: options.leaseMs,
    });
    this.retention = new Retention(db);
    this.exec = options.exec ?? defaultExec;
    const sourceEnv = options.env ?? process.env;
    if (options.verify?.workers) this.verifyWorkers = options.verify.workers;
    else {
      const parsed = verifyWorkers(process.env.ATRIUM_VERIFY_WORKERS);
      if (parsed.invalid.length)
        console.error(
          `ATRIUM_VERIFY_WORKERS 里有写错的执行者组合，已跳过：${parsed.invalid.join("、")}`,
        );
      this.verifyWorkers = parsed.workers;
    }
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
    };
    this.cleanup = new WorktreeCleanup(
      db,
      this.exec,
      (id) =>
        this.x?.active.has(id) ||
        this.x?.launching.has(id) ||
        this.x?.finishing.has(id),
      Date.now,
      this.remote,
    );
    this.disk = new DiskBudget(db, options.diskDu);
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
      hostGate: (urgent) => this.host.gate(this.x.inFlight(), urgent),
      remote: this.remote,
      placement: {
        need: (id, tool, urgent) => this.hostNeed(id, tool, urgent),
        choose: (need, pinned) => this.chooseHostFor(need, pinned),
        installed: (host) => this.remoteInstalled(host),
      },
      makeRoom: (id, tool, host) => this.lane.makeRoom(id, tool, host),
      swapChoice: (active) => this.swapChoice(active),
      urgentIdleMs: options.urgentIdleMs ?? urgentIdle(),
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
      verify: {
        settle: () =>
          setImmediate(() =>
            this.settleVerifications().catch((error) =>
              console.error("上线验证记结论失败：", error),
            ),
          ),
      },
    });
    this.lane = new UrgentLane(db, {
      x: this.x,
      inbox: this.inbox,
      exec: this.exec,
      stop: (ref) => this.stop(ref),
      pauseHost: (host) => void this.pauseHost(`h${host}`, true),
      run: (ref, body) => this.run(ref, body),
      crowded: (host, except) => this.crowdedHost(host, except),
      changed: (id) => this.waits.changed(id),
      closed: () => this.closed,
    });
    this.merge = new MergeQueue(db, {
      data: options.data,
      env: this.launchOptions.env,
      run: this.exec,
      prHeadWaitMs: options.mergeHeadWaitMs,
      checks: this.checks,
      ...(options.checkRerunDelayMs
        ? { rerunDelayMs: options.checkRerunDelayMs }
        : {}),
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
          defaultData: isDefaultData(options.data),
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
      // 紧急的（t215）只等别的紧急任务合入与正在进行的重启；普通任务的合入已让路。
      urgentBusy: () =>
        !!this.db
          .prepare(
            "SELECT 1 FROM tasks WHERE delivery_stage='merging' AND urgent=1 LIMIT 1",
          )
          .get() || !!restartInProgress(options.data),
      deploy: options.online?.deploy ?? cliDeploy(options.data),
      restartError: (version) => lastRestartError(options.data, version),
      publish: (id, kind, detail) => this.x.publish(id, kind, detail),
      changed: (id) => this.waits.changed(id),
      verify: {
        open: (id, steps, version) =>
          openVerify(this.db, { taskId: id, version, steps }),
        dispatch: (refs) => {
          const job = this.dispatchVerify(refs)
            .catch((error) => console.error("上线验证派发失败：", error))
            .finally(() => this.background.delete(job));
          this.background.add(job);
        },
      },
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
      const guarded = skipIfBusy(fn);
      const timer = setInterval(() => {
        const job = guarded()
          .catch((error) => console.error("任务运行时：", error))
          .finally(() => this.background.delete(job));
        this.background.add(job);
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.options.tickMs ?? 5000, async () => {
      await this.x.tick();
      // Atrium 进程树占了几个核（t113）：接管来的执行者父进程已不是服务，单独给。
      if (!this.closed)
        await this.host.refresh(
          [...this.x.active.values()]
            // 远程主机上的执行者不在本机，pid 对不上本机进程。
            .filter(
              (active) =>
                !active.child && !active.exited && active.host === undefined,
            )
            .map((active) => active.pid),
        );
      if (!this.closed) this.orphans.sweep(this.host.orphans());
      if (!this.closed) await this.cleanup.finished();
      if (!this.closed) await this.disk.refresh();
      if (!this.closed) await this.quota.releaseExpired(this.x);
      if (!this.closed && this.recovered) await this.scheduler.tick();
      // 因本机满或太忙排队的，负载降下来后在这里拉起。
      if (!this.closed && this.recovered) await this.x.drain();
      // 紧急通道清空后续上被抢占的任务（t215）。
      if (!this.closed && this.recovered) await this.lane.resume();
      if (!this.closed && this.recovered) this.kickUrgentOnline();
      if (!this.closed && this.recovered) await this.settleReviews();
      if (!this.closed && this.recovered) await this.settleCouncils();
      if (!this.closed && this.recovered) await this.settleVerifications();
      if (!this.closed && this.recovered) this.review.kick();
      if (!this.closed && this.recovered) this.merge.kick();
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    every(this.options.online?.pollMs ?? 60_000, async () => {
      if (!this.closed && this.recovered) this.online.kick();
    });
    // 保留上限（#t126）：低频清理收件箱已确认知会与过期任务事件，不占常用路径。
    every(RETENTION_SWEEP_MS, async () => {
      if (!this.closed) this.retention.sweep();
    });
    const recovery = this.recover()
      .then(async () => {
        this.recovered = true;
        if (!this.closed) await this.scheduler.tick();
        if (!this.closed) this.review.kick();
        if (!this.closed) this.merge.kick();
        if (!this.closed) this.online.kick();
        // 保留清理失败不该挡住自愈后的派活，单独兜住。
        if (!this.closed)
          try {
            this.retention.sweep();
          } catch (error) {
            console.error("保留清理失败：", error);
          }
      })
      .catch((error) => console.error("任务运行时自愈失败：", error))
      .finally(() => this.background.delete(recovery));
    this.background.add(recovery);
  }

  /** 执行者进程不随服务退出：它们在独立进程组里，重启后按 pid 接管。 */
  async close() {
    this.closed = true;
    this.tunnels.close();
    // 先让巡检收手：中止在跑的 gh / git，别等子进程超时（t122）。
    this.scheduler.close();
    // 先唤醒 HTTP 长轮询及内部事件消费者；后台工作可能仍在等事件。
    this.inbox.close();
    this.waits.close();
    this.remote.close();
    setHostQuotaSource(null, this.quotaSource);
    const mergeClosing = this.merge.close();
    this.review.close();
    this.online.close();
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.background]);
    // 与服务退出时一样关掉即时捎话的写端：执行者处理完本轮后自己退出，重启后按 pid 接管。
    for (const active of this.x.active.values()) void active.live?.finish();
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
    if (isTotal(this.db, task.id)) throw totalRefusal(task.ref);
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
    return {
      task: task.ref,
      ...view,
      specialists: pickSpecialists(this.db, task),
      ...(this.hasRemoteHosts()
        ? { hosts: await this.hostPicks(task, view.recommended) }
        : {}),
    };
  }

  /** actor：以 leader 令牌派的（aN），标紧急时记下是谁。 */
  async run(reference: unknown, body: unknown, actor?: string) {
    const request = runRequest(body);
    const id = parseTaskRef(reference);
    // --urgent 派的同时标上紧急（t113）；已经在排队的，标上后立刻按紧急再排一轮（带 --worker 的走下面的改派）。
    if (request.urgent && !request.worker && queued(this.db, id)) {
      this.markUrgent(id, request.why, actor);
      await this.urgentQueued(id);
      return { task: getTask(this.db, id), queued: !!queued(this.db, id) };
    }
    let task = getTask(this.db, id);
    if (isTotal(this.db, id)) throw totalRefusal(task.ref);
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
    if (!admission.ok && !admission.reassign)
      throw new Problem(
        409,
        `${task.ref}：${admission.reason}`,
        "conflict",
        undefined,
        `atrium task show ${task.ref}`,
      );
    if (admission.reassign) {
      // 排队中的任务：带 --worker 改派执行者；不带则维持现状并说明。
      if (!request.worker) {
        const entry = queued(this.db, id);
        throw new Problem(
          409,
          `${task.ref}：已在排队（${entry?.worker ?? "原执行者"}，${queueView(this.db, id).queued_reason ?? "等待执行者可用后自动拉起"}），排队不变；要改派请带 --worker`,
          "conflict",
          undefined,
          `atrium task run ${task.ref} --worker <工具+模型>`,
        );
      }
      if (request.urgent && task.urgent !== 1)
        task = this.markUrgent(id, request.why, actor);
      return this.reassignQueued(task, request);
    }
    if (request.urgent && task.urgent !== 1)
      task = this.markUrgent(id, request.why, actor);
    // 先止损（t215）：紧急任务写了止损动作还没执行过的，派修复前先执行、记事件。
    if (task.urgent === 1 && task.stopgap && !hasEvent(this.db, id, "stopgap"))
      await this.lane.stopgap(id);
    // 指定的远程主机：按那台上报的已装工具挑执行者（#358）。
    const pinned =
      request.host === undefined ? null : this.pinnedHost(request.host);
    const remoteTools =
      pinned !== null && pinned !== LOCAL_HOST
        ? this.remoteInstalled(pinned)
        : undefined;
    this.x.launching.set(id, null);
    let chosen: Choice;
    let pick: RunPick;
    try {
      await this.disk.check(task.node_id);
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
        ...(remoteTools ? { installed: remoteTools } : {}),
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
      const recommended =
        view.recommended &&
        (!remoteTools || remoteTools[toolOf(view.recommended) ?? "codex"])
          ? view.recommended
          : null;
      chosen = await chooseWorker(
        !request.worker && recommended
          ? { ...request, worker: recommended }
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
          pinned,
        ),
        pick,
      };
    }
    // 闲时（t136）：前面还有普通任务在等同一类执行者就先排着，由 drain 按紧急、普通、闲时的先后拉起。
    const ahead = isIdle(task) ? this.x.idleAhead(tool, id) : 0;
    if (ahead) {
      this.x.launching.delete(id);
      return { ...this.enqueue(task, chosen, idleWaitText(ahead)), pick };
    }
    // 挑主机（#358）：指定了只看那台（接不了拒绝、满了排队）；没指定在能接的主机里挑最空的。
    // 本机减负：都满或太忙就落库排队，空出来后由 drain 按入队顺序拉起；紧急的不看负载与上限（t113）。
    let need: HostNeed;
    try {
      need = await this.hostNeed(id, tool, task.urgent === 1);
    } catch (error) {
      this.x.launching.delete(id);
      throw error;
    }
    const choice = this.chooseHostFor(need, pinned, id);
    if (choice.kind === "refuse") {
      this.x.launching.delete(id);
      throw new Problem(
        409,
        `${task.ref} 派不到 ${hostRef(pinned ?? LOCAL_HOST)}：${choice.reason}`,
        "conflict",
        undefined,
        pinned === null
          ? "atrium host ls"
          : `atrium host show ${hostRef(pinned)}`,
      );
    }
    if (choice.kind === "queue") {
      this.x.launching.delete(id);
      return {
        ...this.enqueue(task, chosen, choice.reason, choice.host),
        pick,
      };
    }
    const host = choice.host;
    // 紧急的（t215）：没空位就先暂停闲时（再普通）任务；独占工具被占着就暂停占着的，等它让出后由 drain 拉起。
    if (task.urgent === 1 && this.lane.makeRoom(id, tool, host).wait) {
      this.x.launching.delete(id);
      return {
        ...this.enqueue(
          task,
          chosen,
          `紧急：等 ${tool} 让出来（占着它的已在暂停），让出后立刻拉起`,
          pinned,
        ),
        pick,
      };
    }
    if (
      placement(ADAPTERS[tool].exclusive, this.x.busy(tool, id, host)) ===
      "queue"
    ) {
      this.x.launching.delete(id);
      return {
        ...this.enqueue(
          task,
          chosen,
          `${tool} 同一时刻只跑一个，前一个结束后自动拉起`,
          pinned,
        ),
        pick,
      };
    }
    this.x.claim(id, tool, host);
    try {
      return {
        task: await this.x.launch(id, { ...chosen, host }),
        queued: false,
        pick,
      };
    } catch (error) {
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    } finally {
      this.x.release(id);
    }
  }

  // ---- 执行机器（#358） ----

  /** task pick 的主机一栏：推荐的执行者在各台能不能跑、为什么，自动派会去哪台。 */
  private async hostPicks(task: Task, worker: string | null) {
    const tool = toolOf(worker);
    if (!tool) return [];
    const need = await this.hostNeed(task.id, tool, task.urgent === 1);
    const candidates = this.hostCandidates(task.id);
    const choice = chooseHost(candidates, need);
    const views = new Map(this.hosts().hosts.map((view) => [view.ref, view]));
    return candidates.map((candidate) => {
      const fit = hostFit(candidate, need, false);
      const view = views.get(hostRef(candidate.id));
      return {
        ref: hostRef(candidate.id),
        name: view?.name ?? "",
        status: view?.status ?? "",
        running: candidate.running,
        max: view?.max ?? candidate.max,
        fit: fit.ok ? "ok" : fit.kind,
        reason: fit.ok ? null : fit.reason,
        chosen: choice.kind === "run" && choice.host === candidate.id,
      };
    });
  }

  /** 用户指定的主机：须是登记过、没移除的。 */
  private pinnedHost(reference: string) {
    const id = parseHostRef(reference, "--host");
    const row = hostRow(this.db, id);
    if (row.removed_at !== null)
      throw new Problem(
        409,
        `${hostRef(id)} 已移除`,
        "conflict",
        undefined,
        "atrium host ls",
      );
    return id;
  }

  private hasRemoteHosts() {
    return !!this.db
      .prepare(
        "SELECT 1 FROM hosts WHERE kind='remote' AND removed_at IS NULL AND token_hash IS NOT NULL LIMIT 1",
      )
      .get();
  }

  /** 远程主机上报的已装、没判为未登录的工具。 */
  private remoteInstalled(host: number): Partial<Record<Tool, string>> {
    const clis = parseJson<HostInfo>(hostRow(this.db, host).info)?.clis ?? {};
    const installed: Partial<Record<Tool, string>> = {};
    for (const tool of TOOLS)
      if (clis[tool]?.installed && clis[tool]?.logged_in !== false)
        installed[tool] = ADAPTERS[tool].executable;
    return installed;
  }

  /** 这件活要什么样的主机：工具、仓库（owner/name）、是否紧急、能不能去远程。 */
  private async hostNeed(
    id: number,
    tool: Tool,
    urgent: boolean,
  ): Promise<HostNeed> {
    const task = getTask(this.db, id);
    const localOnly = patrolRun(this.db, id)
      ? "体验巡检要连回本机服务"
      : isVerifyTask(this.db, id)
        ? "上线验证要在本机真实环境跑"
        : productRound(this.db, id)
          ? "产品部研究的选项单文件要留在本机"
          : null;
    let repo: string | null = null;
    if (task.repo) {
      // 没有接入的远程主机时不查仓库，省一次 git。
      if (!this.repoKeys.has(task.repo) && this.hasRemoteHosts()) {
        const origin = await originRepo(task.repo, this.exec);
        this.repoKeys.set(
          task.repo,
          "error" in origin ? null : `${origin.repo.owner}/${origin.repo.name}`,
        );
      }
      repo = this.repoKeys.get(task.repo) ?? "?";
    }
    return {
      tool,
      repo,
      urgent,
      localOnly,
      avoid: storedHosts(task.avoid_hosts),
    };
  }

  /** 某台主机此刻满了或太忙（不算 except 这件）：本机看闸门，远程看代理上报与上限。 */
  private crowdedHost(host: number, except: number) {
    if (host === LOCAL_HOST)
      return !this.host.gate(this.x.inFlight(except), false).ok;
    const candidate = this.hostCandidates(except).find((c) => c.id === host);
    return !!candidate && crowded(candidate);
  }

  /**
   * 紧急任务换人（t215）：按紧急的挑人顺序（一次通过率、速度、正忙）找一个不同工具、不正忙、能接的执行者；
   * 额度用尽或都不能接的返回原因。
   */
  private async swapChoice(active: Active): Promise<Chosen | { note: string }> {
    try {
      const task = getTask(this.db, active.id);
      const pace = await (this.launchOptions.pace ?? readPace)().catch(
        () => undefined,
      );
      const held = this.quota.held();
      const busy = this.x.busyTools(active.id);
      const view = await pickFor(task, active.risk, {
        db: this.db,
        launchOptions: this.launchOptions,
        pace,
        held,
        busy,
      });
      const next = view.candidates.find(
        (c) => c.eligible && !c.busy && c.tool !== active.tool,
      );
      if (!next) return { note: "没有别的执行者能接" };
      const choice = await chooseWorker(
        { worker: next.worker, risk: active.risk },
        { ...this.launchOptions, pace: async () => pace },
        held,
        {
          busy,
          exclude: new Set([active.tool]),
          chain: taskAvoidChain(this.db, task),
        },
      );
      if (choice.waitUntil !== undefined)
        return { note: `${choice.worker.id} 额度用尽` };
      return { worker: choice.worker, risk: active.risk };
    } catch (error) {
      return {
        note: `挑不到能换的执行者：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 紧急任务已合入在等上线（t215）：15 秒催一次上线观察，不等每分钟一轮。 */
  private kickUrgentOnline() {
    const now = Date.now();
    if (now - this.urgentOnlineAt < 15_000) return;
    const waiting = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE urgent=1 AND delivery_stage='merged' AND online_wait=1 LIMIT 1",
      )
      .get();
    if (!waiting) return;
    this.urgentOnlineAt = now;
    this.online.kick();
  }

  /** 各主机此刻的情况（本机按闸门，远程按代理上报与服务手里在跑的）。 */
  private hostCandidates(except?: number): HostCandidate[] {
    const now = Date.now();
    return hostRows(this.db).map((row): HostCandidate => {
      const running = this.x.inFlight(except, row.id);
      if (row.kind === "local") {
        const gate = this.host.gate(running, false);
        return {
          id: row.id,
          kind: "local",
          connection: "local",
          paused: row.paused === 1,
          clis: null,
          repos: ["*"],
          running,
          // 上限已在闸门里判过（满了就是 busy）；这里只用来比谁更空。
          max: this.host.limits.maxWorkers,
          busy: gate.ok ? null : gate.reason,
        };
      }
      const info = parseJson<HostInfo>(row.info);
      const load = parseJson<HostLoadReport>(row.load);
      return {
        id: row.id,
        kind: "remote",
        connection: connection({
          kind: "remote",
          joined: row.token_hash !== null,
          joinExpiresAt: row.join_expires_at,
          lastSeenAt: row.last_seen_at,
          polling: this.remote.polling(row.id),
          now,
          onlineMs: this.remote.onlineMs,
        }),
        paused: row.paused === 1,
        clis: info?.clis ?? {},
        repos: parseJson<string[]>(row.repos) ?? [],
        running,
        max: row.max_running ?? info?.max_workers ?? null,
        busy: load?.busy ?? null,
      };
    });
  }

  /** 各主机此刻能不能接检查（本机按共享检查队列与负载，远程按代理上报与服务派过去还没回来的）。 */
  private checkCandidates(): CheckCandidate[] {
    const now = Date.now();
    return hostRows(this.db).map((row): CheckCandidate => {
      if (row.kind === "local") {
        const size = sharedLocalChecks.size;
        const gate = this.host.gate(0, false);
        return {
          id: row.id,
          kind: "local",
          connection: "local",
          paused: row.paused === 1,
          platform: process.platform,
          repos: ["*"],
          cpus: this.host.limits.cores,
          load: this.host.load(),
          running: size.running + size.waiting,
          max: sharedLocalChecks.limit,
          busy: gate.ok ? null : gate.reason,
        };
      }
      const info = parseJson<HostInfo>(row.info);
      const load = parseJson<HostLoadReport>(row.load);
      return {
        id: row.id,
        kind: "remote",
        connection: connection({
          kind: "remote",
          joined: row.token_hash !== null,
          joinExpiresAt: row.join_expires_at,
          lastSeenAt: row.last_seen_at,
          polling: this.remote.polling(row.id),
          now,
          onlineMs: this.remote.onlineMs,
        }),
        paused: row.paused === 1,
        platform: info?.os ?? null,
        repos: parseJson<string[]>(row.repos) ?? [],
        cpus: info?.cpus ?? 1,
        load: load?.load ?? 0,
        running: this.remote.checksOn(row.id),
        // 旧版代理不报 max_checks，也不认按提交检查：不派给它。
        max: info?.max_checks ?? 0,
        busy: load?.busy ?? null,
      };
    });
  }

  /** 各主机的额度读数与各 CLI 能在哪几台用（额度多主机合并，#358 第 2 步）。 */
  private hostQuota(): HostQuotaSnapshot {
    const now = Date.now();
    const usable: { host: string; tools: Tool[] }[] = [];
    let local = hostRef(LOCAL_HOST);
    for (const row of hostRows(this.db)) {
      if (row.kind === "local") local = hostRef(row.id);
      const online =
        row.kind === "local" ||
        connection({
          kind: "remote",
          joined: row.token_hash !== null,
          joinExpiresAt: row.join_expires_at,
          lastSeenAt: row.last_seen_at,
          polling: this.remote.polling(row.id),
          now,
          onlineMs: this.remote.onlineMs,
        }) === "online";
      if (!online || row.paused === 1) continue;
      const clis = parseJson<HostInfo>(row.info)?.clis ?? {};
      usable.push({
        host: hostRef(row.id),
        tools: TOOLS.filter(
          (tool) => clis[tool]?.installed && clis[tool]?.logged_in !== false,
        ),
      });
    }
    return {
      local,
      usable,
      reports: this.remote.quotaReports().map((report) => ({
        host: hostRef(report.host),
        readings: report.readings,
      })),
    };
  }

  private chooseHostFor(
    need: HostNeed,
    pinned: number | null,
    except?: number,
  ) {
    return chooseHost(this.hostCandidates(except), need, pinned ?? undefined);
  }

  private viewOf(row: HostRow): HostView {
    const running = this.x.inFlight(undefined, row.id);
    const view = hostRowView(row, {
      polling: this.remote.polling(row.id),
      onlineMs: this.remote.onlineMs,
      running,
      localMax: this.host.limits.maxWorkers,
      tunnel: this.tunnels.status(row.id),
    });
    // 把关检查只在本机平台（缺省的检查基准）的主机上跑（t201）；仓库另配基准的按仓库判。
    view.checks = checkRoleText(
      row.kind,
      row.kind === "local" ? process.platform : (view.info?.os ?? null),
      process.platform,
    );
    if (row.kind !== "local") return view;
    const gate = this.host.gate(running, false);
    return {
      ...view,
      load: {
        load: Math.round(this.host.load() * 100) / 100,
        running,
        busy: gate.ok ? null : gate.reason,
      },
    };
  }

  hosts(all = false) {
    return { hosts: hostRows(this.db, all).map((row) => this.viewOf(row)) };
  }

  hostDetail(reference: unknown) {
    const id = parseHostRef(reference, "主机");
    const view = this.viewOf(hostRow(this.db, id));
    const tasks = this.db
      .prepare(
        `SELECT id,title,status FROM tasks WHERE status='running' AND ${id === LOCAL_HOST ? "(host_id IS NULL OR host_id=?)" : "host_id=?"} ORDER BY id LIMIT 200`,
      )
      .all(id) as { id: number; title: string; status: string }[];
    return {
      ...view,
      tasks: tasks.map((task) => ({ ...task, ref: taskRef(task.id) })),
    };
  }

  addHost(body: unknown) {
    const input = (body ?? {}) as {
      name?: unknown;
      max?: unknown;
      repos?: unknown;
      ssh?: unknown;
      key?: unknown;
      tunnel?: unknown;
    };
    if (typeof input.name !== "string")
      throw new Problem(400, "名称：必填", "usage");
    const repos = input.repos === undefined ? [] : input.repos;
    if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== "string"))
      throw new Problem(400, "--repo 应为 owner/name 或 *", "usage");
    const ssh = sshConnection(input, servicePort());
    const { id, code } = addHost(this.db, {
      name: input.name,
      max: input.max as number | undefined,
      repos: repos as string[],
      ssh,
    });
    this.tunnels.refresh(hostRow(this.db, id));
    return { host: this.viewOf(hostRow(this.db, id)), code };
  }

  editHost(reference: unknown, body: unknown) {
    const id = parseHostRef(reference, "主机");
    const input = (body ?? {}) as {
      ssh?: unknown;
      key?: unknown;
      tunnel?: unknown;
    };
    const existing = hostRow(this.db, id);
    const ssh = sshConnection(
      {
        ssh: input.ssh ?? existing.ssh_target ?? undefined,
        key: input.key ?? existing.ssh_key ?? undefined,
        tunnel:
          input.tunnel ??
          (existing.tunnel_local_port && existing.tunnel_remote_port
            ? `${existing.tunnel_local_port}:${existing.tunnel_remote_port}`
            : undefined),
      },
      servicePort(),
    );
    if (!ssh) throw new Problem(400, "--ssh 必填", "usage");
    editHostConnection(this.db, id, ssh);
    this.tunnels.refresh(hostRow(this.db, id));
    return { host: this.viewOf(hostRow(this.db, id)) };
  }

  removeHost(reference: unknown) {
    const id = parseHostRef(reference, "主机");
    removeHost(this.db, id);
    this.tunnels.remove(id);
    return { host: this.viewOf(hostRow(this.db, id)) };
  }

  pauseHost(reference: unknown, paused: boolean) {
    const id = parseHostRef(reference, "主机");
    setPaused(this.db, id, paused);
    // 恢复接活：排着的可能能拉起了。
    if (!paused && !this.closed && this.recovered) void this.x.drain();
    return { host: this.viewOf(hostRow(this.db, id)) };
  }

  /** 清理主机上 Atrium 拉起的残留进程（t215 `host clean`，止损动作同一实现）。 */
  async cleanHost(reference: unknown) {
    const id = parseHostRef(reference, "主机");
    hostRow(this.db, id);
    const detail = await this.lane.clean(id);
    return { host: this.viewOf(hostRow(this.db, id)), detail };
  }

  /** 排队中的任务刚标上紧急：立刻按紧急再排一轮，不等下次巡检。 */
  async urgentQueued(id: number) {
    if (!this.closed && this.recovered && queued(this.db, id))
      await this.x.drain();
  }

  private markUrgent(id: number, why?: string, by?: string) {
    const task = updateTask(
      this.db,
      id,
      { urgent: true, ...(why ? { why } : {}) },
      Date.now(),
      { by },
    );
    this.waits.changed(id);
    return getTask(this.db, task.id);
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

  /** host：钉在哪台主机上排（用户指定的）；自动挑的不钉。 */
  private enqueue(
    task: Task,
    chosen: Chosen,
    reason: string,
    host: number | null = null,
  ) {
    enqueue(this.db, {
      task_id: task.id,
      tool: chosen.worker.tool,
      worker: chosen.worker.id,
      risk: chosen.risk,
      queued_at: Date.now(),
      host_id: host,
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
      ...(host !== null ? { host: hostRef(host) } : {}),
    });
    this.waits.changed(task.id);
    return { task: getTask(this.db, task.id), queued: true };
  }

  /**
   * 排队中的任务改派执行者（t139）：换掉排队记录里的执行者（及 risk），排队位置（queued_at）不变；
   * 原因按新执行者重算，随即排一轮：新执行者空着就直接拉起。已经在跑的不走这里。
   */
  private async reassignQueued(task: Task, request: RunRequest) {
    const prev = queued(this.db, task.id);
    // 并发下可能刚好被拉起。
    if (!prev)
      throw new Problem(
        409,
        `${task.ref}：刚被拉起，不在排队了`,
        "conflict",
        undefined,
        `atrium task show ${task.ref}`,
      );
    const worker = await resolveWorker(request.worker!, this.db);
    const risk = request.risk ?? prev.risk;
    if (isRisk(risk)) {
      const refusal = riskRefusal(
        worker.id,
        worker.profile.rules.max_risk,
        risk,
      );
      if (refusal) throw new Problem(400, refusal, "usage");
    }
    // 指定的主机：带 --host 换成新的，否则保留原排队记录里的（#358）。
    const host =
      request.host === undefined
        ? (prev.host_id ?? null)
        : this.pinnedHost(request.host);
    const adapter = ADAPTERS[worker.tool];
    const gate = this.host.gate(this.x.inFlight(task.id), task.urgent === 1);
    const reason = this.quota.held().has(adapter.quotaProvider)
      ? `${adapter.quotaProvider} 额度用尽，恢复后自动拉起`
      : adapter.exclusive &&
          this.x.busy(worker.tool, task.id, host ?? LOCAL_HOST)
        ? `${worker.tool} 同一时刻只跑一个，前一个结束后自动拉起`
        : gate.ok
          ? "等待执行者可用后自动拉起"
          : gate.reason;
    enqueue(this.db, {
      task_id: task.id,
      tool: worker.tool,
      worker: worker.id,
      risk,
      queued_at: prev.queued_at,
      host_id: host,
    });
    noteTask(this.db, task.id, "queued", {
      worker: worker.id,
      reassigned_from: prev.worker,
      reason,
      ...(host !== null ? { host: hostRef(host) } : {}),
    });
    this.waits.changed(task.id);
    await this.urgentQueued(task.id);
    const still = !!queued(this.db, task.id);
    return {
      task: getTask(this.db, task.id),
      queued: still,
      reassigned: {
        worker: worker.id,
        from: prev.worker,
        reason: still ? queueView(this.db, task.id).queued_reason : null,
      },
    };
  }

  /** 服务重启自愈：进程已不在的置 failed；还在的按 pid 接管；再把排队的拉起来。 */
  recover() {
    return recoverRunning(this.x, this.db, {
      data: this.options.data,
      exec: this.exec,
      changed: (id) => this.waits.changed(id),
      remote: this.remote,
    }).finally(() => {
      // 远程主机的代理从此可以对账、补报退出。
      this.x.ready = true;
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

  /** 重新排队合入；受阻在专员否决（或没出结论）上的，由负责的 leader 判断后放行，照专员通过后的路走审阅或合入。 */
  async requeueMerge(reference: unknown, by = DEFAULT_OWNER) {
    const id = parseTaskRef(reference);
    const overruled = overruleConcerns(this.db, id, by);
    if (!overruled) return { task: this.merge.requeue(id) };
    const admitted = await this.review.admit(id);
    this.x.publish(
      id,
      admitted ? admitted.kind : "done",
      {
        ...(admitted ? admitted.detail : {}),
        reason: (admitted && admitted.detail?.reason) || overruled.reason,
        concerns: overruled.concerns,
        overruled: true,
      },
      by,
    );
    this.waits.changed(id);
    return { task: getTask(this.db, id) };
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
        ...(active.host !== undefined ? { host: hostRef(active.host) } : {}),
        ...(by ? { by } : {}),
      });
      this.x.kill(active);
      // 远程主机离线：停止指令等它连上才送到。账本先按人工停止收尾，重连对账时代理会结束那个进程。
      if (active.host !== undefined && !this.remote.online(active.host))
        void this.x.finish(id, "unknown");
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
    // 远程主机上的进程不在本机，不能按 pid 结束（重连对账时代理会结束账本不认的进程）。
    if (task.pid && (task.host_id ?? LOCAL_HOST) === LOCAL_HOST)
      killTree(task.pid, "SIGTERM");
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

  /**
   * 总任务连带取消（t190）：总任务已先标取消，这里把未结束的子孙逐个取消；在跑的先停再取消，已上线、已完成的不动。
   * 返回取消了哪些、其中哪些是停掉在跑的。
   */
  async cancelDescendants(id: number, actor?: string) {
    const cancelled: string[] = [];
    const stopped: string[] = [];
    for (const child of openDescendants(this.db, id)) {
      const ref = taskRef(child.id);
      if (child.status === "running") {
        try {
          const stop = await this.stop(ref, actor);
          if (stop.stopping) await this.wait(ref, 15);
          stopped.push(ref);
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
        }
      }
      if (queued(this.db, child.id)) dequeue(this.db, child.id);
      const now = getTask(this.db, child.id);
      if (now.status === "done" || now.status === "cancelled") continue;
      updateTask(this.db, ref, { status: "cancelled" });
      await this.cleanupCancelled(child.id);
      this.waits.changed(child.id);
      cancelled.push(ref);
    }
    this.changedTotals(id);
    return { cancelled, stopped };
  }

  /** 人工改了某个任务之后：上面的总任务补一次整体上线判断，并叫醒等它们的 task wait。 */
  changedTotals(id: number) {
    for (const total of publishTotals(this.inbox, this.db, id))
      this.waits.changed(total);
    this.waits.changed(id);
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
          : {
              next: concernNext(
                taskRef(parent),
                getTask(this.db, parent).deliver === "pr",
              ),
            }),
      });
      this.waits.changed(parent);
    }
  }

  // ---- 上线后的端到端验证（t181） ----

  /** 派验证任务：按配置的顺序试执行者，没装或拉不起来换下一个；都不行记「无法验证」。 */
  private async dispatchVerify(refs: string[]) {
    for (const ref of refs) {
      if (this.closed) return;
      const reasons: string[] = [];
      let sent = false;
      for (const worker of this.verifyWorkers) {
        if (this.closed) return;
        try {
          await this.run(ref, { worker, risk: "low" });
          sent = true;
          break;
        } catch (error) {
          reasons.push(
            `${worker}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (sent) continue;
      const outcome = unsentVerify(
        this.db,
        ref,
        reasons.join("；") || "没有配置验证执行者（ATRIUM_VERIFY_WORKERS）",
      );
      this.waits.changed(getTask(this.db, ref).id);
      if (outcome) this.waits.changed(outcome.task);
    }
  }

  /** 验证任务不再跑后把结论记进原任务；停在待办的（派发中途服务重启）重派。 */
  async settleVerifications() {
    if (this.closed) return;
    const busy = (id: number) =>
      this.x.active.has(id) ||
      this.x.launching.has(id) ||
      this.x.finishing.has(id);
    const { outcomes, stranded } = settleVerifications(
      this.db,
      this.options.data,
      busy,
    );
    for (const outcome of outcomes) this.waits.changed(outcome.task);
    if (stranded.length) await this.dispatchVerify(stranded);
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
      // 总任务（t190）：等到子孙全部结束（账本里跟着汇总改成 done / cancelled）。
      (task.status !== "done" &&
        task.status !== "cancelled" &&
        isTotal(this.db, id)) ||
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
    const choices = pendingChoices(this.db);
    return {
      now,
      recent_ms: RECENT_MS,
      subscriber: who,
      // 等用户拍板的选项单（产品部）；没有时不给。
      ...(choices.open ? { choices } : {}),
      counts: {
        ...countRows(rows),
        events: this.inbox.countPending(who),
      },
      ...(leaders.length ? { leaders } : {}),
      host: this.hostView(),
      // 紧急通道（t215）：进行中的紧急任务与「太多就等于没有紧急」的提示；没有时不给。
      ...(() => {
        const lane = this.lane.crowdView();
        return lane.count ? { urgent: lane } : {};
      })(),
      // 接入过远程主机才列主机一行（#358）。
      ...(this.hasRemoteHosts()
        ? {
            hosts: this.hosts().hosts.map((h) => ({
              ref: h.ref,
              name: h.name,
              status: h.status,
              running: h.running,
              max: h.max,
            })),
          }
        : {}),
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

  /** 本机负载与限额（#358）：`top` 抬头显示「本机太忙，排队中」用。 */
  hostView() {
    return hostView({
      limits: this.host.limits,
      load: this.host.load(),
      own: this.host.own(),
      running: this.x.inFlight(),
      checks: sharedLocalChecks.size,
    });
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

/** 紧急任务没有进展多久换人：读服务环境，写错的照缺省并记日志。 */
function urgentIdle() {
  const { ms, problem } = urgentIdleMs(process.env);
  if (problem) console.error(`紧急通道配置：${problem}`);
  return ms;
}

const parseJson = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** 执行者标识 `工具+模型[:强度]` 里的工具；取不出就不是已知工具，按未知日志处理。 */
const toolOf = (worker: string | null): Tool | undefined => {
  const head = worker?.split(/[+:]/, 1)[0]?.trim();
  return isTool(head) ? head : undefined;
};
