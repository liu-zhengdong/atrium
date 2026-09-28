import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { recentAction } from "./logs/action.ts";
import { taskDir } from "./dispatch/active.ts";
import {
  ADAPTERS,
  isTool,
  toolNames,
  TOOLS,
  type Tool,
} from "./adapters/index.ts";
import { CI_BATCH, CI_POLL_MS, pollCiOnce } from "./gates/ci-poll.ts";
import { EventInbox } from "./events/events.ts";
import { Retention } from "./events/retention.ts";
import { Executors, type Chosen } from "./dispatch/executors.ts";
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
} from "./ledger/ledger.ts";
import { readLogChunk, readLogTail } from "./logs/log-view.ts";
import {
  admit,
  riskRefusal,
  runRequest,
  type RunRequest,
} from "./dispatch/plan.ts";
import type { PaceEntry } from "./dispatch/prepare.ts";
import { resolveWorker, type ResolvedWorker } from "./workers/profiles.ts";
import { loadCustomTools } from "./workers/custom-tools.ts";
import {
  ensureWorkerProfiles,
  importWorkerProfiles,
} from "./workers/worker-profiles.ts";
import {
  dequeue,
  enqueue,
  ensureQueueTable,
  queued,
  queueView,
} from "./dispatch/queue.ts";
import { clock } from "./quota/quota-holds.ts";
import { QuotaGuard } from "./quota/quota-runtime.ts";
import { recoverRunning } from "./dispatch/recovery.ts";
import { killTree } from "../platform/index.ts";
import { countRows, priorityCounts, RECENT_MS, topRows } from "./top.ts";
import { TaskWaits } from "./dispatch/waits.ts";
import { chooseWorker, type Choice } from "./dispatch/worker-choice.ts";
import { workerEnvironment } from "./dispatch/worker-env.ts";
import { Scheduler, scheduleOf } from "./ledger/schedule.ts";
import { schedulePrExec } from "./ledger/schedule-pr.ts";
import { pickSkills, type LaunchOptions } from "./dispatch/workspace.ts";
import { pickFor } from "./dispatch/pick-runtime.ts";
import { writtenNotice, type RunPick } from "./dispatch/pick.ts";
import { isRisk } from "./workers/profiles.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";
import { tellTask } from "./dispatch/tell-runtime.ts";
import { BudgetProblem } from "./quota/budget-problem.ts";
import { readPace } from "./dispatch/prepare.ts";
import { MergeQueue } from "./merge/merge-runtime.ts";
import { WorktreeCleanup } from "./merge/worktree-cleanup.ts";
import { ReviewGate, taskRisk } from "./gates/review-runtime.ts";
import { reviewerRefusal } from "./gates/review.ts";
import {
  cliDeploy,
  cliSmoke,
  lastRestartError,
  OnlineWatch,
  type DeployResult,
} from "./merge/online-runtime.ts";
import { selfRepoFlag, selfUpdateEnabled } from "./merge/online.ts";
import {
  currentVersion,
  isDefaultData,
  packageRoot,
} from "../service-state.ts";
import { restartInProgress } from "../supervisor.ts";
import { listLeaders } from "../leaders/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { existsSync } from "node:fs";
import { HostLoad, hostView } from "./dispatch/host-load.ts";
import { OrphanReaper, recognizer, spawnOwner } from "./dispatch/orphans.ts";
import { cleanHost, reapLeftovers } from "./dispatch/leftovers-reap.ts";
import { patrolOverdue } from "./watch/overdue-runtime.ts";
import type { StopNote } from "./dispatch/leftovers-reap.ts";
import { storedHosts } from "../hosts/state.ts";
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
import { setHostQuotaSource, type HostQuotaSnapshot } from "../hosts/quota.ts";
import { machineInfo } from "../hosts/info.ts";
import { originRepo } from "./gh-repo.ts";
import { patrolRun } from "./patrol.ts";
import {
  isTotal,
  openDescendants,
  totalRefusal,
} from "./ledger/rollup-ledger.ts";
import { publishTotals } from "./events/notice.ts";
import { researchRound } from "../schedules/model.ts";
import { pendingChoices } from "../choices/store.ts";
import { hasRoom } from "../hosts/state.ts";
import { registerDelivery } from "./gates/register-delivery-runtime.ts";
import { secretaryView, UNATTENDED_MS } from "./secretary/secretary-watch.ts";
import {
  clearPause,
  globalPause,
  hostPaused,
  listPauses,
  partPause,
  pauseText,
  resumeCommand,
  setPause,
  taskPause,
} from "../pause.ts";
import { nodeByAddress } from "../org/model.ts";

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
    smoke?: () => Promise<DeployResult>;
    pollMs?: number;
  };
  /** 本机减负（#358）：执行者并发上限、本地检查并发、负载阈值；缺省按服务环境与核数（host-load.ts）。 */
  host?: HostLoad;
  /** 代理长轮询每轮最多挂多久（毫秒）；测试缩短。 */
  agentPollMs?: number;
  /** 派给代理要等结果的指令没人来领多久就报错（毫秒）；测试缩短。 */
  agentPickupMs?: number;
  /** 代理多久没来算离线（测试缩短）；缺省 1 分钟。 */
  agentOnlineMs?: number;
  /** 合入检查没跑成后第几次重跑前等多久（t204）；测试缩短。 */
  checkRerunDelayMs?: (attempt: number) => number;
  /** 检查多久没输出就结束、多久看一次日志；缺省按 overdue.ts 检查一行，测试缩短。 */
  check?: { stallMs?: number; pollMs?: number };
};

export class TaskRunner {
  readonly inbox: EventInbox;
  private readonly x: Executors;
  private readonly waits: TaskWaits;
  private readonly quota: QuotaGuard;
  private readonly scheduler: Scheduler;
  private readonly retention: Retention;
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
  /** 上次按 overdue.ts 巡检 leader 手里与等发版的任务的时刻。 */
  private overdueAt = 0;
  /** 秘书后台兜底的状态（t242，app.ts 接上）：top 与状态栏据此说秘书在不在听。 */
  secretaryWatch:
    | (() => { graceMs: number; waking: boolean; unreachable: string | null })
    | undefined;
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
  /** 看板上把日志里的绝对路径缩成相对路径用的工作目录，按任务记一份。 */
  private recovered = false;
  /** 重启自愈（接管在跑的执行者）；派活回执前先等它，免得还没接管就按空的在跑数超额拉起。 */
  private recovering: Promise<void> | null = null;
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
    loadCustomTools(db);
    // 本机限额只看服务自己的环境（不是给执行者的 options.env）。
    const owner = spawnOwner(options.data);
    this.host =
      options.host ?? HostLoad.fromEnv(process.env, recognizer(db, owner));
    this.orphans = new OrphanReaper(db, owner, killTree);
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
    });
    setHostQuotaSource(this.quotaSource);
    this.inbox = new EventInbox(db, {
      batchMs: options.batchMs,
      leaseMs: options.leaseMs,
    });
    this.retention = new Retention(db);
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
      killGraceMs: options.killGraceMs,
      closed: () => this.closed,
      paused: (id) => {
        const pause = taskPause(this.db, id);
        return pause ? pauseText(pause) : null;
      },
      onAccepted: (id) => this.review.admit(id),
      hostGate: (urgent) => this.host.gate(this.x.inFlight(), urgent),
      remote: this.remote,
      placement: {
        need: (id, tool) => this.hostNeed(id, tool),
        choose: (need, pinned) => this.chooseHostFor(need, pinned),
        paused: (host) => hostPaused(this.db, host),
        room: () => hasRoom(this.hostCandidates()),
        installed: (host) => this.remoteInstalled(host),
      },
    });
    this.merge = new MergeQueue(db, {
      data: options.data,
      env: this.launchOptions.env,
      run: this.exec,
      prHeadWaitMs: options.mergeHeadWaitMs,
      checkTimeoutMs: this.host.limits.checkTimeoutMs,
      checkStallMs: options.check?.stallMs,
      quietPollMs: options.check?.pollMs,
      ...(options.checkRerunDelayMs
        ? { rerunDelayMs: options.checkRerunDelayMs }
        : {}),
      changed: (id) => this.waits.changed(id),
      paused: (id) => !!taskPause(this.db, id),
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
      paused: (id) => !!taskPause(this.db, id),
      handBack: (task, reason) => this.merge.handBack(task, reason),
      changed: (id) => this.waits.changed(id),
      publish: (id, kind, detail, actor) =>
        this.x.publish(id, kind, detail, actor),
    });
    const selfUpdate =
      options.online?.selfUpdate ??
      selfUpdateEnabled(process.env.ATRIUM_SELF_UPDATE, {
        gitCheckout: existsSync(join(packageRoot, ".git")),
        defaultData: isDefaultData(options.data),
      });
    this.online = new OnlineWatch(db, {
      run: this.exec,
      version: options.online?.version ?? currentVersion,
      selfUpdate,
      selfRepo:
        options.online?.selfRepo !== undefined
          ? options.online.selfRepo
          : selfRepoFlag(
              process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium",
            ),
      // 全局暂停时不发版、不自升级。
      busy: () =>
        !!globalPause(this.db) ||
        !!this.db
          .prepare("SELECT 1 FROM tasks WHERE delivery_stage='merging' LIMIT 1")
          .get() ||
        !!restartInProgress(options.data),
      deploy: options.online?.deploy ?? cliDeploy(options.data),
      // 上线后的只读冒烟只在自升级的安装版上跑；测试与隔离服务注入或不跑。
      smoke:
        options.online?.smoke ??
        (selfUpdate ? cliSmoke(options.data) : undefined),
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
      // 全局暂停（server/pause.ts）：只留看门狗，不清理、不派活、不推进合入与验证。
      if (globalPause(this.db)) return;
      if (!this.closed) this.orphans.sweep(this.host.orphans());
      if (!this.closed) await this.cleanup.finished();
      if (!this.closed) await this.quota.releaseExpired(this.x);
      if (!this.closed && this.recovered) await this.scheduler.tick();
      // 因本机满或太忙排队的，负载降下来后在这里拉起。
      if (!this.closed && this.recovered) await this.x.drain();
      // 持球与期限（overdue.ts）：leader 手里与等发版的，一分钟巡检一次。
      if (!this.closed && this.recovered) this.patrolOverdue();
      if (!this.closed && this.recovered) this.review.kick();
      if (!this.closed && this.recovered) this.merge.kick();
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    every(this.options.online?.pollMs ?? 60_000, async () => {
      if (!this.closed && this.recovered && !globalPause(this.db))
        this.online.kick();
    });
    // 保留上限（#t126）：低频清理收件箱已确认知会与过期任务事件，不占常用路径。
    every(RETENTION_SWEEP_MS, async () => {
      if (!this.closed) this.retention.sweep();
    });
    this.recovering = this.recover();
    const recovery = this.recovering
      .then(async () => {
        this.recovered = true;
        // 全局暂停着（server/pause.ts）就先不派、不推进，恢复时再补。
        if (!this.closed && !globalPause(this.db)) {
          await this.scheduler.tick();
          this.review.kick();
          this.merge.kick();
          this.online.kick();
        }
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
      ...(this.hasRemoteHosts()
        ? { hosts: await this.hostPicks(task, view.recommended) }
        : {}),
    };
  }

  /**
   * 派活：校验、挑好执行者后入队，再排一轮；只有 drain 拉起执行者（按优先级、入队先后）。
   * 已在排队的带 --worker 或 --host 改派执行者或主机，排队位置不变。
   */
  async run(reference: unknown, body: unknown) {
    const request = runRequest(body);
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    if (isTotal(this.db, id)) throw totalRefusal(task.ref);
    // 只看上游（t227）：任务自己失败或受阻不挡重派（能不能重派由下面的 admit 按状态判），
    // 免得失败后排期标了 blocked 的要先 task set --status todo。
    const schedule = scheduleOf(this.db, {
      id,
      status: "todo",
      schedule_reason: null,
    });
    if (schedule.group === "waiting" || schedule.group === "blocked")
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
      // 排队中的任务：带 --worker 改派执行者、带 --host 改派主机（t229）；都不带则维持现状并说明。
      if (!request.worker && request.host === undefined) {
        const entry = queued(this.db, id);
        throw new Problem(
          409,
          `${task.ref}：已在排队（${entry?.worker ?? "原执行者"}，${queueView(this.db, id).queued_reason ?? "等待执行者可用后自动拉起"}），排队不变；要改派请带 --worker 或 --host`,
          "conflict",
          undefined,
          `atrium task run ${task.ref} --worker <工具+模型>`,
        );
      }
      return this.reassignQueued(task, request);
    }
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
      const pace = await (this.launchOptions.pace ?? readPace)().catch(
        () => undefined,
      );
      if (!pace)
        noteTask(this.db, id, "budget_unknown", {
          reason: "额度数据不可用，不按额度拦截",
        });
      const avoid = {
        busy: this.x.busyTools(id),
        chain: taskAvoidChain(this.db, task),
        jobRef: task.job_ref ?? undefined,
        ...(remoteTools ? { installed: remoteTools } : {}),
      };
      const held = this.quota.held();
      // 与 task run --dry-run 同一份候选排序：专员优先、再按额度富余；写死执行者时据此提醒更富余的候选。
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
        { ...this.launchOptions, pace: async () => pace },
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
      // 指定的主机接不了（离线、暂停、没装这个工具、写了避开）直接拒绝；满了照样排队。
      if (pinned !== null) {
        const choice = this.chooseHostFor(
          await this.hostNeed(id, chosen.worker.tool),
          pinned,
          id,
        );
        if (choice.kind === "refuse")
          throw new Problem(
            409,
            `${task.ref} 派不到 ${hostRef(pinned)}：${choice.reason}`,
            "conflict",
            undefined,
            `atrium host show ${hostRef(pinned)}`,
          );
      }
    } catch (error) {
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    } finally {
      this.x.launching.delete(id);
    }
    this.enqueue(task, chosen, pinned);
    try {
      await this.drainQueued(id, true);
    } catch (error) {
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    }
    const still = !!queued(this.db, id);
    if (still) {
      noteTask(this.db, id, "queued", {
        worker: chosen.worker.id,
        reason: await this.waitReason(id, chosen.worker.tool, pinned),
        ...(pinned !== null ? { host: hostRef(pinned) } : {}),
      });
      this.waits.changed(id);
    }
    return { task: getTask(this.db, id), queued: still, pick };
  }

  /**
   * 排队中的任务：立刻排一轮，不等下次巡检。owner：派活的人在等回执，这件拉起失败时把错误抛回
   * （任务留在待办，不转受阻）。
   */
  async drainQueued(id: number, owner = false) {
    if (owner) await this.recovering?.catch(() => undefined);
    if (!this.closed && (this.recovered || owner) && queued(this.db, id))
      await this.x.drain(owner ? id : undefined);
  }

  /** 持球与期限（overdue.ts）：leader 手里与等发版的任务一分钟巡检一次。 */
  private patrolOverdue() {
    const now = Date.now();
    if (now - this.overdueAt < 60_000) return;
    this.overdueAt = now;
    try {
      patrolOverdue(this.db, this.inbox, now);
    } catch (error) {
      console.error("到期巡检失败；稍后重试：", error);
    }
  }

  /** 排队时写给人看的原因：暂停、额度用尽、主机满或太忙、独占工具正忙，都不是时写通用的一句。 */
  private async waitReason(id: number, tool: Tool, pinned: number | null) {
    const pause = taskPause(this.db, id);
    if (pause) return `${pauseText(pause)}；恢复：${resumeCommand(pause)}`;
    const adapter = ADAPTERS[tool];
    const until = this.quota.held().get(adapter.quotaProvider);
    if (until !== undefined)
      return `${adapter.quotaProvider} 额度用尽，等到 ${clock(until)} 恢复后自动拉起`;
    const choice = this.chooseHostFor(
      await this.hostNeed(id, tool),
      pinned,
      id,
    );
    if (choice.kind !== "run") return choice.reason;
    if (adapter.exclusive && this.x.busy(tool, id, choice.host))
      return `${tool} 同一时刻只跑一个，前一个结束后自动拉起`;
    return "等待执行者可用后自动拉起";
  }

  // ---- 执行机器（#358） ----

  /** task run --dry-run 的主机一栏：推荐的执行者在各台能不能跑、为什么，自动派会去哪台。 */
  private async hostPicks(task: Task, worker: string | null) {
    const tool = toolOf(worker);
    if (!tool) return [];
    const need = await this.hostNeed(task.id, tool);
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
        reason: !fit.ok
          ? fit.reason
          : need.skills && candidate.skills === false
            ? "代理版本旧，挂不了组织技能（优先派到别的主机）"
            : null,
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

  /** 这件活要什么样的主机：工具、仓库（owner/name）、是否紧急（跳过负载限制）、能不能去远程。 */
  private async hostNeed(id: number, tool: Tool): Promise<HostNeed> {
    const task = getTask(this.db, id);
    const localOnly = patrolRun(this.db, id)
      ? "体验巡检要连回本机服务"
      : researchRound(this.db, id)
        ? "调研的选项单文件要留在本机"
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
      urgent: task.priority === "urgent",
      localOnly,
      avoid: storedHosts(task.avoid_hosts),
      // 要带组织技能的优先派到能挂的主机（t232）；只有本机时不用算。
      ...(localOnly === null &&
      this.hasRemoteHosts() &&
      pickSkills(this.db, task).skills.length
        ? { skills: true }
        : {}),
    };
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
          paused: hostPaused(this.db, row.id),
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
      const max = row.max_running ?? info?.max_workers ?? null;
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
        paused: hostPaused(this.db, row.id),
        clis: info?.clis ?? {},
        repos: parseJson<string[]>(row.repos) ?? [],
        running,
        max,
        busy: load?.busy ?? null,
        skills: info?.skills === true,
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
      if (!online || hostPaused(this.db, row.id)) continue;
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
      paused: hostPaused(this.db, row.id),
      onlineMs: this.remote.onlineMs,
      running,
      localMax: this.host.limits.maxWorkers,
      tunnel: this.tunnels.status(row.id),
    });
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

  // ---- 一键停机（server/pause.ts） ----

  /** 请求里的范围：--part 节点、--host hN，都不给是全局。 */
  private pauseScope(body: unknown) {
    const input = (body ?? {}) as { part?: unknown; host?: unknown };
    if (input.part !== undefined && input.host !== undefined)
      throw new Problem(400, "--part 与 --host 只能给一个", "usage");
    if (typeof input.part === "string" && input.part.trim()) {
      const node = nodeByAddress(this.db, input.part.trim());
      return { scope: `o${node.id}`, part: node.id, host: null };
    }
    if (typeof input.host === "string" && input.host.trim()) {
      const host = parseHostRef(input.host.trim(), "--host");
      if (hostRow(this.db, host).removed_at !== null)
        throw new Problem(409, `${hostRef(host)} 已移除`, "conflict");
      return { scope: hostRef(host), part: null, host };
    }
    return { scope: "all", part: null, host: null };
  }

  pauses() {
    return { pauses: listPauses(this.db) };
  }

  /** 暂停；stop=true 时把范围里在跑的执行者一并停掉（缺省让它们跑完、不接新的）。 */
  pause(body: unknown, by: string) {
    const input = (body ?? {}) as { why?: unknown; stop?: unknown };
    const why =
      typeof input.why === "string" && input.why.trim()
        ? input.why.trim().slice(0, 300)
        : null;
    const target = this.pauseScope(body);
    const { pause, changed } = setPause(this.db, target.scope, by, why);
    if (changed) console.log(`${pauseText(pause)} 由 ${by} 暂停`);
    const stopped: string[] = [];
    if (input.stop === true)
      for (const [id, active] of [...this.x.active]) {
        const inScope =
          target.host !== null
            ? (active.host ?? LOCAL_HOST) === target.host
            : target.part !== null
              ? this.inPart(id, target.part)
              : true;
        if (!inScope) continue;
        this.stop(taskRef(id), by, {
          by,
          reason: `暂停时一并停掉：${pauseText(pause)}`,
        });
        stopped.push(taskRef(id));
      }
    return { pause, changed, stopped };
  }

  resume(body: unknown, by: string) {
    const { scope } = this.pauseScope(body);
    const resumed = clearPause(this.db, scope);
    if (resumed) {
      console.log(`${pauseText(resumed)} 由 ${by} 恢复`);
      // 排着的按顺序拉起，合入、审阅、上线接着走。
      if (!this.closed && this.recovered)
        void this.x
          .drain()
          .then(() => {
            this.review.kick();
            this.merge.kick();
            this.online.kick();
          })
          .catch((error) => console.error("恢复后拉起失败：", error));
    }
    return { resumed, pauses: listPauses(this.db) };
  }

  /** 任务的归属部门（旧任务看 node_id）在不在 node 这一块里。 */
  private inPart(id: number, node: number) {
    const task = getTask(this.db, id);
    const part = task.part_id ?? task.node_id;
    if (part === null) return false;
    const found = partPause(this.db, part);
    return found?.scope === `o${node}`;
  }

  /** 清理主机（t217 `host clean`）：判定与记账在 leftovers-reap.ts 的 cleanHost。 */
  async cleanHost(reference: unknown, by?: string) {
    const host = parseHostRef(reference, "主机");
    hostRow(this.db, host);
    const result = await cleanHost(this.db, host, {
      running: [...this.x.active.values()]
        .filter((active) => !active.exited && !active.stop)
        .map((active) => ({ id: active.id, host: active.host ?? LOCAL_HOST })),
      active: new Set(this.x.active.keys()),
      stop: (ref, note) => this.stop(ref, by, note),
      reapLocal: (targets) => reapLeftovers(targets, { exec: this.exec }),
      remote: (at, targets) => this.remote.clean(at, targets),
      by,
    });
    return { ...result, host: this.viewOf(hostRow(this.db, host)) };
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
      next: "等窗口重置",
    });
    this.waits.changed(task.id);
    return { task: getTask(this.db, task.id), queued: false };
  }

  /** host：钉在哪台主机上排（用户指定的）；自动挑的不钉。 */
  /** 入队（状态回到待办）；排队原因等排过一轮、确实还在排时再记（run 里）。 */
  private enqueue(task: Task, chosen: Chosen, host: number | null) {
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
    this.waits.changed(task.id);
  }

  /**
   * 排队中的任务改派（t139 执行者、t229 主机）：换掉排队记录里的执行者（及 risk）或钉住的主机，排队位置（queued_at）不变；
   * 指定的主机接不了（离线、暂停、没装这个工具、写了避开）拒绝、排队不变；原因按新执行者与主机此刻的空位重算，
   * 随即排一轮：空着就直接拉起。已经在跑的不走这里。
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
    const worker = await resolveWorker(request.worker ?? prev.worker, this.db);
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
    const choice = this.chooseHostFor(
      await this.hostNeed(task.id, worker.tool),
      host,
      task.id,
    );
    if (choice.kind === "refuse")
      throw new Problem(
        409,
        `${task.ref} 改派不到 ${hostRef(host ?? LOCAL_HOST)}：${choice.reason}，排队不变`,
        "conflict",
        undefined,
        host === null ? "atrium host ls" : `atrium host show ${hostRef(host)}`,
      );
    const reason = await this.waitReason(task.id, worker.tool, host);
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
      ...(worker.id !== prev.worker ? { reassigned_from: prev.worker } : {}),
      reason,
      ...(host !== null ? { host: hostRef(host) } : {}),
      ...(host !== (prev.host_id ?? null)
        ? {
            host_from:
              prev.host_id === null || prev.host_id === undefined
                ? null
                : hostRef(prev.host_id),
          }
        : {}),
    });
    this.waits.changed(task.id);
    await this.drainQueued(task.id);
    const still = !!queued(this.db, task.id);
    return {
      task: getTask(this.db, task.id),
      queued: still,
      reassigned: {
        worker: worker.id,
        from: prev.worker,
        host: host === null ? null : hostRef(host),
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
    while (exclude.size <= toolNames().length) {
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

  /** 秘书、leader 亲自做完的活登记 PR 与工作树（t257），直接进合入队列（按优先级排）。 */
  async deliver(reference: unknown, body: unknown, by = DEFAULT_OWNER) {
    const task = await registerDelivery(this.db, reference, body, {
      run: this.exec,
      busy: (id) =>
        this.x.active.has(id) ||
        this.x.launching.has(id) ||
        this.x.finishing.has(id),
      by,
    });
    this.merge.enqueue(task.id);
    this.changedTotals(task.id);
    return { task: getTask(this.db, task.id) };
  }

  /** 重新排队合入。 */
  requeueMerge(reference: unknown) {
    return { task: this.merge.requeue(parseTaskRef(reference)) };
  }

  /**
   * by：发起停止的订阅者，由此产生的事件不投给他本人。note：停止事件里记的发起者与缘由（t239），
   * 给了就以它为准（host clean、暂停时一并停掉），不影响投递；没给记 by。
   */
  stop(reference: unknown, by?: string, note?: StopNote) {
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    const mergeStop = this.review.stop(id, by) ?? this.merge.stop(id, by);
    if (mergeStop)
      return { task: getTask(this.db, id), stopping: mergeStop.stopping };
    const who = note?.by ?? by;
    if (dequeue(this.db, id)) {
      noteTask(this.db, id, "unqueued", {
        reason: "人工停止，移出队列",
        ...(who ? { by: who } : {}),
      });
      this.waits.changed(id);
      return { task: getTask(this.db, id), stopping: false };
    }
    const active = this.x.active.get(id);
    if (active && !active.exited) {
      active.stop = { kind: "user", ...(by ? { by } : {}) };
      noteTask(this.db, id, "stop_requested", {
        pid: active.pid,
        ...(active.host !== undefined ? { host: hostRef(active.host) } : {}),
        ...(who ? { by: who } : {}),
        ...(note ? { reason: note.reason } : {}),
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

  /** 秘书在不在听、未处理几件、后台是否在叫醒或叫不起来（t242）。 */
  private secretaryState(now: number) {
    const events = this.inbox.pending(DEFAULT_OWNER);
    const watch = this.secretaryWatch?.();
    return secretaryView({
      now,
      presence: this.inbox.presence(DEFAULT_OWNER),
      pending: events.length,
      oldest: events.length
        ? Math.min(...events.map((event) => event.updated_at))
        : null,
      graceMs: watch?.graceMs ?? UNATTENDED_MS,
      waking: watch?.waking ?? false,
      unreachable: watch?.unreachable ?? null,
    });
  }

  /**
   * 进行中任务的实时视图（#262 `atrium top`）：在跑、排队、受阻与刚结束的，
   * 每行带日志尾部解析出的最近一个动作与日志最后写入时刻。只读，日志最多读尾部固定字节数。
   * 解析不出动作时 action 为 null，但 log_at 照给，命令行据此说「日志 N 秒前有输出」。
   */
  async top(input: { as?: string; now?: number } = {}) {
    const now = input.now ?? Date.now();
    const who = input.as ? ownerOf(input.as, "as") : DEFAULT_OWNER;
    // 在跑的执行者最近一次有进展的时刻（看门狗采样的，overdue.ts 执行者一行的起算点）。
    const { rows, truncated } = topRows(
      this.db,
      now,
      undefined,
      undefined,
      (id) => {
        const active = this.x.active.get(id);
        return active && !active.exited
          ? (active.state.lastProgressAt ?? active.state.startedAt)
          : undefined;
      },
    );
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
      // 等用户拍板的选项单；没有时不给。
      ...(choices.open ? { choices } : {}),
      counts: {
        ...countRows(rows),
        events: this.inbox.countPending(who),
      },
      // 秘书在不在听（t242）：看秘书的收件箱时给。
      ...(who === DEFAULT_OWNER ? { secretary: this.secretaryState(now) } : {}),
      // 一键停机（server/pause.ts）：暂停着的逐条给，看板与状态栏醒目显示。
      pauses: listPauses(this.db),
      // 在途任务按优先级计数：头部「紧急 K · 修复 M · 普通 N · 闲时 I」。
      priorities: priorityCounts(this.db),
      ...(leaders.length ? { leaders } : {}),
      host: this.hostView(),
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
