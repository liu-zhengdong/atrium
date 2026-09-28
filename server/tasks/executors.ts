import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { launched, type Active } from "./active.ts";
import { ADAPTERS, type Tool } from "./adapters/index.ts";
import type { EventInbox } from "./events.ts";
import type { Exec } from "./git.ts";
import {
  advanceTask,
  getTask,
  noteTask,
  patchRunFields,
  taskRef,
  type RunFields,
  type Task,
} from "./ledger.ts";
import { publishTask, publishUrgentStage } from "./notice.ts";
import { exitDetail, type Exit } from "./outcome.ts";
import { resolveWorker, type ResolvedWorker, type Risk } from "./profiles.ts";
import { dequeue, heads, queuedNormals } from "./queue.ts";
import { idleAhead } from "./priority.ts";
import type { QuotaGuard } from "./quota-runtime.ts";
import { diffSize, logTail, settle } from "./settle.ts";
import { killTree } from "../platform/index.ts";
import { alive, spawnWorker } from "./spawn.ts";
import { finishPatrol, patrolRun } from "./patrol.ts";
import { VERIFIER_FLAG } from "./verify.ts";
import { isVerifyTask } from "./verify-runtime.ts";
import { settleRound } from "../products/settle.ts";
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
import { addTell, markDelivered, markEchoed } from "./tell-ledger.ts";
import { followUpTells, readHead } from "./tell-runtime.ts";
import { askConclusion } from "./conclusion-runtime.ts";
import { randomUUID } from "node:crypto";
import { all, atomically } from "./ledger-model.ts";
import {
  pausedText,
  resumeNote,
  swapDue,
  swapNote,
  type RunningSlot,
} from "./urgent.ts";
import {
  closePreemption,
  openPreemption,
  recordPreemption,
} from "./urgent-ledger.ts";
import type { Stop } from "./outcome.ts";
import type { ChildProcess } from "node:child_process";
import { collectSkillEdits } from "../skills/collect.ts";
import { beginUsage, endUsage } from "./usage.ts";
import { readPace, type PaceEntry } from "./prepare.ts";
import { DiskBudget } from "./disk-budget.ts";
import { chooseWorker } from "./worker-choice.ts";
import { jobMismatch } from "./job-mismatch.ts";
import { activeJobChecks } from "./delivery-records.ts";
import { publishWorkerAdvice } from "./workers-report.ts";
import { getJobRole } from "./job-roles.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";
import { BudgetProblem } from "./budget-problem.ts";
import { withSecrets } from "../secrets/model.ts";
import { markSecretsUsed, taskSecretValues } from "../secrets/store.ts";
import {
  blockUnsent,
  invitedFor,
  isReviewTask,
  openReviews,
} from "./concern-runtime.ts";
import { fileHints } from "./concerns.ts";
import { hintText, needsReview } from "./concern-gate.ts";
import { isCouncilTask, isOpinionTask } from "./councils.ts";
import { taskRoute } from "../leaders/subscriber.ts";
import type { HostGate } from "./host-load.ts";
import type { RemoteHosts } from "../hosts/remote.ts";
import { nextRun } from "../hosts/model.ts";
import {
  hostRef,
  LOCAL_HOST,
  type HostChoice,
  type HostNeed,
} from "../hosts/state.ts";
import type { Assignment } from "../hosts/protocol.ts";
import { SPAWN_ENV, spawnMark, spawnOwner } from "./orphans.ts";

/**
 * 服务手里的执行者进程（#262）：拉起、退出收尾（查事实、过关卡、重试）、看门狗巡检、排队拉起。
 * 收尾与看门狗的判定在 outcome.ts / watchdog.ts 的纯函数里，这里只执行并落库。
 */

/** host：派到哪台远程主机（#358）；不给或是本机就在本机跑。 */
export type Chosen = { worker: ResolvedWorker; risk: Risk; host?: number };

/** 挑主机（#358）：need 要查仓库（异步），choose 在占位前同步判定，免得两轮拉起抢同一个空位。 */
export type Placement = {
  need(taskId: number, tool: Tool, urgent: boolean): Promise<HostNeed>;
  choose(need: HostNeed, pinned: number | null): HostChoice;
  /** 远程主机上报的已装且没判为未登录的工具（挑执行者时代替本机 PATH）。 */
  installed(host: number): Partial<Record<Tool, string>>;
};

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
  /** 交付关卡通过后的去向（审阅或合入队列）；返回要发的事件，false 表示照常发 done。 */
  onAccepted?: (
    id: number,
  ) => Promise<{ kind: string; detail?: Record<string, unknown> } | false>;
  /** 专员关卡（#322）：拉起审查任务；审查任务结束后立即补判父任务（否则等下一轮巡检）。 */
  reviews?: {
    dispatch: (ref: string) => Promise<unknown>;
    settle: () => void;
  };
  /** 会审（#322）：专员意见或 leader 汇总结束后推进会审（否则等下一轮巡检）。 */
  councils?: { settle: () => void };
  /** 上线验证（t181）：验证任务结束后立即把结论记进原任务（否则等下一轮巡检）。 */
  verify?: { settle: () => void };
  /** 本机还能不能再拉起一个执行者（#358 并发上限与负载）；缺省不限。 */
  /** 本机闸门（#358）；紧急任务传 urgent，跳过负载与执行者上限。 */
  hostGate?: (urgent: boolean) => HostGate;
  /** 远程主机的代理连接（#358 第 1 步）；没有时只在本机跑。 */
  remote?: RemoteHosts;
  /** 排队拉起时挑主机；没有时只看本机闸门。 */
  placement?: Placement;
  /**
   * 紧急通道（t215）：紧急任务要在 host 上用 tool 时腾位置（按 urgent.ts preemptPlan 暂停别的任务）；
   * wait 为 true 表示要等被暂停的让出独占工具，先别拉起。
   */
  makeRoom?: (id: number, tool: Tool, host: number) => { wait: boolean };
  /** 紧急任务没有进展时换谁（t215）；没得换给原因。 */
  swapChoice?: (active: Active) => Promise<Chosen | { note: string }>;
  /** 紧急任务没有进展多久换人（毫秒）；缺省不换。 */
  urgentIdleMs?: number;
};

export class Executors {
  readonly active = new Map<number, Active>();
  /** 正在准备（建 worktree、写提示词）的任务及其工具，防止重复派与独占冲突。 */
  readonly launching = new Map<number, Tool | null>();
  /** 退出收尾期间仍可能自动重派；wait 不应把中途状态当作最终结果。 */
  readonly finishing = new Map<number, number>();
  /** 正在往远程主机拉起的任务与主机号；不在这里的按本机算。 */
  readonly launchHosts = new Map<number, number>();
  /** 紧急任务换人（t215）：停下后由谁接着做。 */
  private readonly swapTargets = new Map<number, Chosen>();
  private ticking = false;

  constructor(private readonly ctx: ExecutorContext) {
    ctx.remote?.attach({
      ready: () => this.ready,
      exited: (task, run, exit) => this.remoteExited(task, run, exit),
      lost: (task, reason) => this.remoteLost(task, reason),
      reconnected: (host) => {
        for (const active of this.active.values())
          if (active.host === host) active.state.lastProgressAt = Date.now();
      },
    });
  }

  /** 服务重启自愈做完后置 true：之前代理的对账与退出上报先等等。 */
  ready = false;

  /** 占位：正在拉起（host 是远程主机时记下，本机并发与独占按主机分开算）。 */
  claim(id: number, tool: Tool | null, host?: number) {
    this.launching.set(id, tool);
    if (this.remoteHost(host)) this.launchHosts.set(id, host!);
    else this.launchHosts.delete(id);
  }

  release(id: number) {
    this.launching.delete(id);
    this.launchHosts.delete(id);
  }

  /** 是远程主机（不是本机 h1）。 */
  remoteHost(host: number | undefined): host is number {
    return host !== undefined && host !== LOCAL_HOST;
  }

  private hostOf(active: Active) {
    return active.host ?? LOCAL_HOST;
  }

  /** 查事实、探进展用的命令：远程任务的 git 在那台机器上跑。 */
  execFor(active: Active) {
    return active.host !== undefined && this.ctx.remote
      ? this.ctx.remote.exec(active.host)
      : this.ctx.exec;
  }

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

  /** 这台主机（缺省本机）上这个工具是否正忙；独占工具按主机各跑一个。 */
  busy(tool: Tool, except?: number, host: number = LOCAL_HOST) {
    for (const active of this.active.values())
      if (
        active.tool === tool &&
        active.id !== except &&
        !active.exited &&
        this.hostOf(active) === host
      )
        return true;
    for (const [id, launching] of this.launching)
      if (
        launching === tool &&
        id !== except &&
        (this.launchHosts.get(id) ?? LOCAL_HOST) === host
      )
        return true;
    return false;
  }

  /** 这台主机（缺省本机）上在跑（未退出）与正在启动的执行者个数，except 除外；并发上限按它算。 */
  inFlight(except?: number, host: number = LOCAL_HOST) {
    const ids = new Set<number>();
    for (const active of this.active.values())
      if (!active.exited && this.hostOf(active) === host) ids.add(active.id);
    for (const id of this.launching.keys())
      if ((this.launchHosts.get(id) ?? LOCAL_HOST) === host) ids.add(id);
    ids.delete(except ?? -1);
    return ids.size;
  }

  /** 本机已有任务在跑（或正在启动）的工具，except 除外；自动挑人时据此避开正忙的独占执行者。 */
  busyTools(except?: number) {
    const tools = new Set<Tool>();
    for (const active of this.active.values())
      if (
        active.id !== except &&
        !active.exited &&
        this.hostOf(active) === LOCAL_HOST
      )
        tools.add(active.tool);
    for (const [id, launching] of this.launching)
      if (launching && id !== except && !this.launchHosts.has(id))
        tools.add(launching);
    return tools;
  }

  /**
   * 闲时任务（t136）要用 tool 时，前面还有几件普通任务在等同一类执行者：同一工具的，或只在等本机空位的；
   * 在等自己那个工具（独占工具正忙、额度用尽）的不算。0 表示可以派。
   */
  idleAhead(tool: Tool, except?: number) {
    const held = this.ctx.quota.held();
    return idleAhead(tool, queuedNormals(this.ctx.db, except), (other) => {
      const adapter = ADAPTERS[other as Tool];
      if (!adapter) return false;
      return (
        held.has(adapter.quotaProvider) ||
        (!!adapter.exclusive && this.busy(other as Tool))
      );
    });
  }

  /**
   * 紧急通道的抢占（t215）：停下这个执行者，收尾时记下会话、转受阻，紧急通道清空后续上。
   * 已在停、正在收尾或还在启动的不动；返回是否发出了暂停。
   */
  pause(id: number, by: number, why: "exclusive" | "slot") {
    const active = this.active.get(id);
    if (!active || active.exited || active.stop || active.finalizing)
      return false;
    active.stop = { kind: "preempt", by, why };
    noteTask(this.ctx.db, id, "stop_requested", {
      pid: active.pid,
      ...(active.host !== undefined ? { host: hostRef(active.host) } : {}),
      by: `t${by}`,
      reason: pausedText(by, why),
    });
    this.kill(active);
    this.ctx.waits.changed(id);
    return true;
  }

  /** 各主机上在跑与正在启动的执行者（抢占判定用）：一次查询取紧急、闲时与拉起时刻。 */
  slots(): RunningSlot[] {
    const entries = new Map<
      number,
      { tool: string; host: number; stopping: boolean; startedAt: number }
    >();
    for (const active of this.active.values())
      if (!active.exited)
        entries.set(active.id, {
          tool: active.tool,
          host: this.hostOf(active),
          stopping: !!active.stop || !!active.finalizing,
          startedAt: active.startedAt,
        });
    for (const [id, tool] of this.launching)
      if (!entries.has(id))
        entries.set(id, {
          tool: tool ?? "",
          host: this.launchHosts.get(id) ?? LOCAL_HOST,
          // 还在启动的停不下来：不选它，但照样占位。
          stopping: true,
          startedAt: Date.now(),
        });
    if (!entries.size) return [];
    const ids = [...entries.keys()];
    const flags = new Map(
      all<{ id: number; urgent: number; priority: string | null }>(
        this.ctx.db,
        `SELECT id,urgent,priority FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      ).map((row) => [row.id, row]),
    );
    return ids.map((id) => {
      const entry = entries.get(id)!;
      const row = flags.get(id);
      return {
        id,
        ...entry,
        urgent: row?.urgent === 1,
        idle: row?.priority === "idle" && row.urgent !== 1,
      };
    });
  }

  /** 在跑的紧急任务与各自换过几次执行者（一次查询，巡检用）。 */
  private urgentRunning() {
    return new Map(
      all<{ id: number; swaps: number }>(
        this.ctx.db,
        `SELECT t.id,(SELECT COUNT(*) FROM task_events e WHERE e.task_id=t.id AND e.kind='urgent_swap') AS swaps
          FROM tasks t WHERE t.urgent=1 AND t.status='running' LIMIT 50`,
      ).map((row) => [row.id, row.swaps]),
    );
  }

  publish(
    id: number,
    kind: string,
    detail: Record<string, unknown>,
    actor?: string,
  ) {
    // 上面的总任务状态可能跟着变了（t190）：等它们的 task wait 也醒一下。
    for (const total of publishTask(
      this.ctx.inbox,
      this.ctx.db,
      id,
      kind,
      detail,
      actor,
    ))
      this.ctx.waits.changed(total);
  }

  advance(
    id: number,
    event: TaskEvent,
    fields: RunFields = {},
    detail?: unknown,
  ) {
    return advanceTask(this.ctx.db, taskRef(id), event, fields, detail);
  }

  /**
   * 本机执行者的环境：白名单环境加上 Atrium 标记（t203，子孙继承；父进程退出后被收养的也认得出，
   * 任务早已结束还活着的巡检时清掉）。巡检与上线验证要连回本机服务，去掉执行者防护标记、带上服务的
   * 数据目录与端口；巡检会重启服务，另去掉 Atrium 标记。上线验证另带 ATRIUM_VERIFIER（命令行拒绝启停、
   * 升级服务，给真实服务的请求带验证身份，服务端拒绝止损类操作）与真实服务的数据目录并关掉自带额度读取（t181）。
   */
  private runEnv(id: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...this.ctx.launchOptions.env,
      [SPAWN_ENV]: spawnMark(spawnOwner(this.ctx.launchOptions.data), id),
    };
    const verify = isVerifyTask(this.ctx.db, id);
    const patrol = !verify && patrolRun(this.ctx.db, id);
    if (verify || patrol) {
      delete env.ATRIUM_WORKER;
      Object.assign(env, this.ctx.launchOptions.patrolServiceEnv);
    }
    if (patrol) delete env[SPAWN_ENV];
    if (verify) {
      env[VERIFIER_FLAG] = "1";
      // 真实服务的数据目录（t239）：命令行据此分辨验证执行者连的是真实服务还是自己起的隔离实例。
      env.ATRIUM_VERIFIER_DATA = this.ctx.launchOptions.data;
      env.ATRIUM_QUOTA_READERS = "off";
    }
    return env;
  }

  /** 本机执行者这一轮的环境：执行者 material get 时据 ATRIUM_TASK 把读取记在这件任务上（t192），另按名称加上声明的凭据（t194）。 */
  private taskEnv(
    task: Task,
    secrets: ReturnType<Executors["secrets"]>,
  ): NodeJS.ProcessEnv {
    return withSecrets(
      { ...this.runEnv(task.id), ATRIUM_TASK: task.ref },
      secrets?.env,
    );
  }

  /**
   * 任务声明的凭据（t194）：拉起前按名称取值，缺了就报错不拉起；没声明为 null。
   * 值只进这一次拉起的环境（本机）或指令（远程，只在内存里），不落日志与事件。
   */
  private secrets(task: Task) {
    return taskSecretValues(this.ctx.db, this.ctx.launchOptions.data, task);
  }

  /** 拉起成功后记下用过（清理线索看最后使用时间），事件里只有名称。 */
  private secretsUsed(
    id: number,
    secrets: ReturnType<Executors["secrets"]>,
    host?: number,
  ) {
    if (!secrets) return;
    markSecretsUsed(this.ctx.db, secrets.ids, id);
    noteTask(this.ctx.db, id, "secrets_injected", {
      names: secrets.used.map((s) => s.name),
      ...(host !== undefined ? { host: hostRef(host) } : {}),
    });
  }

  async launch(id: number, chosen: Chosen, retried = false): Promise<Task> {
    if (this.ctx.closed()) throw new Error("服务已关闭");
    // 被紧急任务抢占暂停过的（t215）：同一执行者且日志里有会话就续上，否则把说明写进提示词、在原工作树重派。
    const paused = openPreemption(this.ctx.db, id);
    const resume =
      paused &&
      paused.session &&
      paused.worker === chosen.worker.id &&
      !this.remoteHost(chosen.host) &&
      ADAPTERS[chosen.worker.tool].resume
        ? { session: paused.session, text: resumeNote(paused.by_task, true) }
        : undefined;
    if (paused && !resume)
      addTell(this.ctx.db, id, {
        text: resumeNote(paused.by_task, false),
        by: "secretary",
        uuid: randomUUID(),
        route: "next_run",
      });
    if (this.remoteHost(chosen.host)) {
      const started = await this.launchRemote(
        id,
        { ...chosen, host: chosen.host },
        retried,
      );
      if (paused) this.resumed(id, paused.by_task, false, chosen);
      return started;
    }
    const task = getTask(this.ctx.db, id);
    const secrets = this.secrets(task);
    await this.ctx.disk.check(task.node_id);
    const prepared = await prepareRun(
      task,
      chosen,
      this.ctx.launchOptions,
      resume,
    );
    const usagePace = await this.pace();
    if (this.ctx.closed()) throw new Error("服务已关闭");
    // 执行者 material get 时据 ATRIUM_TASK 把读取记在这件任务上（t192）。
    const { child, offset } = await spawnWorker(
      prepared,
      this.taskEnv(task, secrets),
      task.ref,
    );
    const pid = child.pid!;
    this.secretsUsed(id, secrets);
    if (this.ctx.closed()) {
      killTree(pid, "SIGKILL");
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
          host_id: null,
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
      killTree(pid, "SIGKILL");
      throw error;
    }
    markDelivered(this.ctx.db, id, prepared.tellIds, "prompt");
    if (paused) this.resumed(id, paused.by_task, !!resume, chosen);
    publishUrgentStage(
      this.ctx.inbox,
      this.ctx.db,
      id,
      "start",
      { worker: chosen.worker.id },
      started,
    );
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

  /** 被抢占的任务续上了（t215）：关掉暂停记录、记事件并知会。 */
  private resumed(id: number, by: number, session: boolean, chosen: Chosen) {
    closePreemption(this.ctx.db, id, Date.now());
    const detail = {
      by: `t${by}`,
      worker: chosen.worker.id,
      how: session ? "续上原会话" : "在原工作树重派",
    };
    noteTask(this.ctx.db, id, "resumed", detail);
    this.publish(id, "resumed", {
      ...detail,
      reason: `紧急通道清空，${detail.how}（${chosen.worker.id}）`,
    });
  }

  /**
   * 同一轮里换进程（#307 捎话）：带着补充续上原会话（resume），或保留工作树带着补充重派（未给 resume）。
   * 任务保持 running，只换 pid；关卡按新进程退出后的结果判。
   */
  async relaunch(prev: Active, resume?: ResumeWith & { ids: number[] }) {
    if (this.ctx.closed()) throw new Error("服务已关闭");
    if (prev.host !== undefined) {
      await this.launchRemote(
        prev.id,
        { worker: prev.worker, risk: prev.risk, host: prev.host },
        prev.retried,
        { prev, resume },
      );
      return;
    }
    const id = prev.id;
    const task = getTask(this.ctx.db, id);
    const secrets = this.secrets(task);
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
      this.taskEnv(task, secrets),
      task.ref,
      !!resume,
    );
    const pid = child.pid!;
    this.secretsUsed(id, secrets);
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

  /**
   * 派到远程主机（#358）：本机写好提示词、算好那台机器上的路径，交给代理建工作树并拉起；
   * 拿到回执（pid）后与本机拉起一样记账、开始看门狗。retake 是捎话续上或重派（任务保持 running，只换 pid）。
   */
  private async launchRemote(
    id: number,
    chosen: Chosen & { host: number },
    retried: boolean,
    retake?: { prev: Active; resume?: ResumeWith & { ids: number[] } },
  ): Promise<Task> {
    const remote = this.ctx.remote;
    if (!remote) throw new Error("服务没有接上远程主机");
    const { host } = chosen;
    const task = getTask(this.ctx.db, id);
    const secrets = this.secrets(task);
    const prepared = await prepareRun(
      task,
      chosen,
      this.ctx.launchOptions,
      retake?.resume,
      { host, ...remote.site(host) },
    );
    const usagePace = await this.pace();
    if (this.ctx.closed()) throw new Error("服务已关闭");
    const plan = prepared.remote!;
    const run = nextRun(this.ctx.db, id);
    const assignment: Assignment = {
      task: id,
      ref: task.ref,
      run,
      worker: chosen.worker.id,
      tool: chosen.worker.tool,
      ...(chosen.worker.cliModel ? { model: chosen.worker.cliModel } : {}),
      ...(chosen.worker.effort ? { effort: chosen.worker.effort } : {}),
      prompt: plan.prompt,
      ...(plan.resume ? { resume: plan.resume } : {}),
      dir: plan.dir,
      cwd: prepared.cwd,
      ...(plan.repo ? { repo: plan.repo } : {}),
      ...(secrets ? { secrets: secrets.env } : {}),
    };
    const ack = await remote.launch(host, assignment);
    this.secretsUsed(id, secrets, host);
    prepared.launch = { ...ack.launch };
    const stop = () => remote.stop(host, id, run, "SIGKILL");
    if (this.ctx.closed()) {
      stop();
      throw new Error("服务已关闭");
    }
    let started: Task;
    try {
      if (retake) {
        const ids = retake.resume ? retake.resume.ids : prepared.tellIds;
        started = patchRunFields(
          this.ctx.db,
          id,
          { pid: ack.pid },
          retake.resume ? "tell_resumed" : "tell_restarted",
          {
            pid: ack.pid,
            host: hostRef(host),
            worker: chosen.worker.id,
            tells: ids.length,
          },
        );
        markDelivered(
          this.ctx.db,
          id,
          ids,
          retake.resume ? "resume" : "restart",
        );
      } else {
        started = this.advance(
          id,
          { kind: "start" },
          {
            worker: chosen.worker.id,
            pid: ack.pid,
            host_id: host,
            worktree: prepared.worktree,
            branch: prepared.branch,
            pr_url: null,
            ci: null,
            result: null,
          },
          {
            worker: chosen.worker.id,
            risk: chosen.risk,
            host: hostRef(host),
            cwd: prepared.cwd,
            ...(retried ? { retry: true } : {}),
          },
        );
        markDelivered(this.ctx.db, id, prepared.tellIds, "prompt");
        publishUrgentStage(
          this.ctx.inbox,
          this.ctx.db,
          id,
          "start",
          { worker: chosen.worker.id, host: hostRef(host) },
          started,
        );
      }
    } catch (error) {
      stop();
      throw error;
    }
    await this.track(
      started,
      chosen,
      prepared,
      undefined,
      0,
      retried,
      usagePace,
      { host, run, pid: ack.pid },
    );
    return started;
  }

  /** 代理报告远程某一轮退出。 */
  private remoteExited(
    id: number,
    run: number,
    exit: Exit,
  ): "done" | "retry" | "ignored" {
    const active = this.active.get(id);
    if (active && active.host !== undefined && active.run === run) {
      if (!active.exited) void this.finish(id, exit);
      return "done";
    }
    // 回执刚到、还没记上账（含收尾里续上会话、卡死重试的新一轮）：让代理过一会儿再报。
    if (this.launching.has(id) || this.finishing.has(id)) return "retry";
    return "ignored";
  }

  /** 代理不知道这一轮：按退出情况不明收尾（日志与交付事实照常查）。 */
  private remoteLost(id: number, reason: string) {
    const active = this.active.get(id);
    if (!active || active.exited) return;
    noteTask(this.ctx.db, id, "host_run_lost", {
      host: hostRef(active.host ?? LOCAL_HOST),
      reason,
    });
    void this.finish(id, "unknown");
  }

  private async track(
    task: Task,
    chosen: Chosen,
    prepared: Prepared,
    child: ChildProcess | undefined,
    offset: number,
    retried: boolean,
    usagePace: PaceEntry[] | undefined,
    remote?: { host: number; run: number; pid: number },
  ) {
    const id = task.id;
    const active = launched({
      task,
      pid: remote ? remote.pid : child!.pid!,
      child,
      prepared,
      retried,
      exec:
        remote && this.ctx.remote
          ? this.ctx.remote.exec(remote.host)
          : this.ctx.exec,
      worker: chosen.worker,
      risk: chosen.risk,
      ...(remote
        ? {
            remote: {
              host: remote.host,
              run: remote.run,
              repo: prepared.remote?.repo?.clone ?? null,
            },
          }
        : {}),
    });
    if (child && prepared.launch.input === "stream-json" && child.stdin)
      active.live = new LiveInput(
        child.stdin,
        prepared.logFile,
        offset,
        (uuid) => markEchoed(this.ctx.db, id, uuid),
        undefined,
        prepared.launch.inputDialect,
      );
    this.active.set(id, active);
    beginUsage(
      this.ctx.db,
      id,
      ADAPTERS[chosen.worker.tool].quotaProvider,
      usagePace,
    );
    // 远程的退出由代理上报（remoteExited）。
    child?.once(
      "exit",
      (code, signal) => void this.finish(id, { code, signal }),
    );
    await active.probe.baseline();
    this.ctx.waits.changed(id);
  }

  /**
   * 交付后的本地检查在哪跑：远程任务的工作树在那台，交给那台的代理；
   * 本机任务按提交派到空闲主机（本机也是候选，那台没跑成就换一台或回本机）。
   */
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
      // 紧急通道（t215）：抢占暂停与换人不收尾、不过关卡，由这里接手。
      if (active.stop?.kind === "preempt")
        return await this.paused(active, active.stop);
      if (active.stop?.kind === "swap")
        return await this.swapped(active, active.stop);
      // 结论类任务（审阅、专员审查、会审）读不出结论：先登记补答，由捎话续上同一执行者。
      await askConclusion(this.ctx.db, active, exit);
      if (await followUpTells(this, this.ctx.db, active, exit)) return;
      const jobId = getTask(this.ctx.db, id).job_id;
      if (jobId) {
        const job = getJobRole(this.ctx.db, `r${jobId}`);
        active.worker.profile.rules.checks = [
          ...new Set([
            ...(active.worker.profile.rules.checks ?? []),
            ...(activeJobChecks(this.ctx.db, id) ?? job.checks),
          ]),
        ];
      }
      const outcome = await settle(active, exit, this.execFor(active));
      if (this.ctx.closed()) return;
      this.collectSkills(active);
      if (getTask(this.ctx.db, id).status !== "running") return;
      const { verdict, facts } = outcome;
      let { decision } = outcome;
      if (outcome.workerGuardRefused)
        noteTask(this.ctx.db, id, "worker_guard_refused", {
          reason: "执行日志出现 Atrium 执行者防护的固定拒绝语句",
        });
      const detail = outcome.exitDetail;
      if (verdict)
        noteTask(this.ctx.db, id, "gates", {
          worker: active.worker.id,
          passed: verdict.passed,
          results: verdict.results,
          ...(facts ? { diff: diffSize(facts) } : {}),
          ...detail,
        });
      if (facts && jobId) {
        const mismatch = jobMismatch(
          getJobRole(this.ctx.db, `r${jobId}`).name,
          facts.numstat.map((s) => s.file),
        );
        if (mismatch)
          noteTask(this.ctx.db, id, "job_mismatch", { reason: mismatch });
      }
      const hints = facts
        ? fileHints(
            this.ctx.db,
            id,
            facts.numstat.map((stat) => stat.file),
          )
        : [];
      if (hints.length)
        noteTask(this.ctx.db, id, "concern_hints", {
          hints,
          next: `atrium task set ${taskRef(id)} --concern ${hints.map((h) => h.ref).join(",")}`,
        });
      // 专员关卡：其余关卡通过才请专员审；审查结果由 settleReviews 补判。
      const reviewing =
        !outcome.quota &&
        !!verdict &&
        decision.event === "exit_ok" &&
        needsReview(invitedFor(this.ctx.db, id).length);
      if (reviewing)
        decision = {
          event: "block",
          publish: "blocked",
          retry: false,
          reason: [decision.reason, "等专员审查"].filter(Boolean).join("；"),
        };
      this.advance(id, { kind: decision.event }, outcome.fields, {
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(verdict && !verdict.passed
          ? { gates: verdict.failed.map((r) => r.gate) }
          : {}),
        ...detail,
      });
      if (reviewing) {
        await this.openReviews(id, facts);
        return;
      }
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
        ...(hints.length
          ? {
              concern_hints: hints.map(hintText),
              next: `要请专员复审：atrium task set ${taskRef(id)} --concern ${hints.map((h) => h.ref).join(",")}，再 atrium task run ${taskRef(id)}`,
            }
          : {}),
      };
      let admitted: Awaited<
        ReturnType<NonNullable<ExecutorContext["onAccepted"]>>
      > = false;
      const thinking = routeAfterThinking({
        thinking: outcome.ending?.kind === "thinking",
        stop: active.stop,
        decision,
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
      // 审查任务的结局经父任务的专员关卡汇报，不单独投给负责人。
      else if (isReviewTask(this.ctx.db, id)) {
        /* 由 reviews.settle 补判父任务。 */
      }
      // 上线验证的结论记进原任务，验证任务自己的结局不单独投递。
      else if (isVerifyTask(this.ctx.db, id)) {
        /* 由 verify.settle 记结论。 */
      }
      // 会审：专员意见经 leader 汇总上报；汇总完成由 councils.settle 记结论后投递。
      else if (
        isOpinionTask(this.ctx.db, id) ||
        (decision.publish === "done" && isCouncilTask(this.ctx.db, id))
      ) {
        /* 由 councils.settle 推进会审。 */
      } else if (patrolRun(this.ctx.db, id)) {
        finishPatrol(this.ctx.db, this.ctx.inbox, id);
        if (decision.publish !== "done")
          this.publish(id, decision.publish, published);
      }
      // 关卡（含专员）都过了才去审阅或合入队列。
      else if (
        decision.publish === "done" &&
        (admitted = (await this.ctx.onAccepted?.(id)) ?? false)
      ) {
        this.publish(id, admitted.kind, { ...published, ...admitted.detail });
      } else
        this.publish(
          id,
          decision.publish,
          {
            ...published,
            // 产品部的研究：把工作目录里的选项单登记上，结果（cN 或错误）随完成事件交给产品部 leader。
            ...(decision.publish === "done"
              ? settleRound(
                  this.ctx.db,
                  this.ctx.inbox,
                  this.ctx.launchOptions.data,
                  id,
                )
              : {}),
          },
          active.stop?.kind === "user" ? active.stop.by : undefined,
        );
      if (!isReviewTask(this.ctx.db, id))
        publishWorkerAdvice(this.ctx.db, this.ctx.inbox, id);
      if (isReviewTask(this.ctx.db, id)) this.ctx.reviews?.settle();
      if (isVerifyTask(this.ctx.db, id)) this.ctx.verify?.settle();
      if (isOpinionTask(this.ctx.db, id) || isCouncilTask(this.ctx.db, id))
        this.ctx.councils?.settle();
    } catch (error) {
      this.failAfterError(id, error);
    } finally {
      // 重试或换执行者重派后，表里已是新的一轮，别删掉。
      if (this.active.get(id) === active) this.active.delete(id);
      const remaining = this.finishing.get(id)! - 1;
      if (remaining) this.finishing.set(id, remaining);
      else this.finishing.delete(id);
      this.ctx.waits.changed(id);
      // 本机并发上限（#358）按所有工具算：谁结束都可能空出位置给别的工具的队首。
      if (!this.ctx.closed()) void this.drain();
    }
  }

  /** 抢占暂停后（t215）：记下会话与执行者、转受阻并知会；紧急通道清空后由运行时续上。 */
  private async paused(
    active: Active,
    stop: Extract<Stop, { kind: "preempt" }>,
  ) {
    await active.live?.finish();
    const id = active.id;
    if (getTask(this.ctx.db, id).status !== "running") return;
    const adapter = ADAPTERS[active.tool];
    const session =
      adapter.resume && adapter.sessionOf && active.host === undefined
        ? (adapter.sessionOf(await readHead(active.logFile)) ?? null)
        : null;
    const reason = pausedText(stop.by, stop.why);
    atomically(this.ctx.db, () => {
      recordPreemption(this.ctx.db, {
        task_id: id,
        by_task: stop.by,
        why: stop.why,
        worker: active.worker.id,
        risk: active.risk,
        host_id: active.host ?? null,
        session,
        paused_at: Date.now(),
      });
      this.advance(id, { kind: "block" }, {}, { reason, preempted: true });
      noteTask(this.ctx.db, id, "preempted", {
        by: `t${stop.by}`,
        why: stop.why,
        worker: active.worker.id,
        session: !!session,
      });
    });
    this.publish(id, "preempted", { reason, by: `t${stop.by}` });
  }

  /** 紧急任务换人（t215）：前一位停下后，换上的执行者在原工作树接着做；拉不起就按受阻知会。 */
  private async swapped(active: Active, stop: Extract<Stop, { kind: "swap" }>) {
    await active.live?.finish();
    const id = active.id;
    const to = this.swapTargets.get(id);
    this.swapTargets.delete(id);
    if (getTask(this.ctx.db, id).status !== "running") return;
    const detail = { from: active.worker.id, to: stop.to, reason: stop.reason };
    this.advance(id, { kind: "block" }, {}, { reason: stop.reason });
    noteTask(this.ctx.db, id, "urgent_swap", detail);
    if (!to) {
      this.publish(id, "blocked", {
        reason: `${stop.reason}，但换上的执行者丢了`,
      });
      return;
    }
    addTell(this.ctx.db, id, {
      text: swapNote(active.worker.id, stop.reason),
      by: "secretary",
      uuid: randomUUID(),
      route: "next_run",
    });
    this.active.delete(id);
    this.claim(id, to.worker.tool, to.host);
    try {
      await this.launch(id, to);
      this.publish(id, "urgent_swap", detail);
    } catch (error) {
      if (this.ctx.closed()) return;
      const why = `换 ${to.worker.id} 拉起失败：${error instanceof Error ? error.message : String(error)}`;
      noteTask(this.ctx.db, id, "retry_failed", { reason: why });
      this.publish(id, "blocked", { reason: `${stop.reason}；${why}` });
    } finally {
      this.release(id);
    }
  }

  /** 建本轮专员审查任务并逐个拉起；拉不起的标受阻，由巡检判为没出结论。 */
  private async openReviews(
    id: number,
    facts: Parameters<typeof openReviews>[3],
  ) {
    const refs = openReviews(
      this.ctx.db,
      this.ctx.launchOptions.data,
      id,
      facts,
    );
    for (const ref of refs) {
      try {
        if (!this.ctx.reviews) throw new Error("运行时没有接上专员审查");
        await this.ctx.reviews.dispatch(ref);
      } catch (error) {
        blockUnsent(
          this.ctx.db,
          ref,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.ctx.reviews?.settle();
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
          subscriber: taskRoute(this.ctx.db, task).subscriber,
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
      // 卡死重试留在原来那台主机上。
      await this.launch(
        active.id,
        { worker: active.worker, risk: active.risk, host: active.host },
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
      const urgent = this.ctx.urgentIdleMs
        ? this.urgentRunning()
        : new Map<number, number>();
      for (const active of [...this.active.values()]) {
        if (active.exited) continue;
        if (active.host !== undefined) {
          // 远程：进程在那台机器上，退出由代理上报；断线期间不判卡死，从重连起重新计空闲。
          if (!this.ctx.remote?.online(active.host)) {
            active.state.lastProgressAt = Date.now();
            continue;
          }
        } else if (!active.child && !alive(active.pid)) {
          void this.finish(active.id, "unknown");
          continue;
        }
        if (active.stop || active.finalizing) continue;
        const { signals } = await active.probe.poll();
        if (signals.length) active.state.lastProgressAt = Date.now();
        if (await this.swapIfIdle(active, urgent)) continue;
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

  /**
   * 紧急任务盯到底（t215）：执行者超过 urgentIdleMs 没有进展就换人（不等 20 分钟卡死判定）；
   * 没得换就记一笔、这一轮交给普通看门狗。返回 true 表示已发出换人。
   */
  private async swapIfIdle(
    active: Active,
    urgent: ReadonlyMap<number, number>,
  ) {
    const limitMs = this.ctx.urgentIdleMs;
    if (!limitMs || !this.ctx.swapChoice || active.swapSkipped) return false;
    const swaps = urgent.get(active.id);
    if (swaps === undefined) return false;
    const due = swapDue({
      urgent: true,
      stopping: !!active.stop || !!active.finalizing,
      startedAt: active.state.startedAt,
      lastProgressAt: active.state.lastProgressAt,
      now: Date.now(),
      limitMs,
      swaps,
    });
    if (due.kind === "ok") return false;
    const choice = await this.ctx.swapChoice(active);
    if (active.exited || active.stop) return false;
    if ("note" in choice) {
      active.swapSkipped = true;
      noteTask(this.ctx.db, active.id, "urgent_swap_skipped", {
        reason: `${due.reason}，但${choice.note}`,
      });
      return false;
    }
    this.swapTargets.set(active.id, choice);
    active.stop = { kind: "swap", reason: due.reason, to: choice.worker.id };
    noteTask(this.ctx.db, active.id, "stop_requested", {
      pid: active.pid,
      reason: `${due.reason}：换 ${choice.worker.id}`,
    });
    this.kill(active);
    return true;
  }

  private forceFinalExit(active: Active) {
    if (active.exited || !active.finalizing || active.finalizing.forced) return;
    active.finalizing.forced = true;
    this.signal(active, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) this.signal(active, "SIGKILL");
    }, this.ctx.killGraceMs ?? 10_000).unref();
  }

  kill(active: Active) {
    this.signal(active, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) this.signal(active, "SIGKILL");
    }, this.ctx.killGraceMs ?? 10_000).unref();
  }

  /** 结束执行者的进程树：本机直接发信号，远程交给那台的代理。 */
  private signal(active: Active, signal: "SIGTERM" | "SIGKILL") {
    if (active.host !== undefined)
      this.ctx.remote?.stop(active.host, active.id, active.run ?? 0, signal);
    else killTree(active.pid, signal);
  }

  /**
   * 拉起排队中的任务：每个工具的队首（紧急的在前、闲时的在后），闲时的还要前面没有普通任务在等同一类执行者，前提是独占工具空闲、账号额度标记已解除、本机没满也不太忙（紧急的不看这两条）；
   * 返回出队几个。几处（退出收尾、巡检、额度解除）可能同时调用，出队以删到队列行为准。
   */
  async drain(tool?: Tool) {
    if (this.ctx.closed()) return 0;
    const held = this.ctx.quota.held();
    let moved = 0;
    for (const entry of heads(this.ctx.db, tool)) {
      const entryTool = entry.tool as Tool;
      if (this.ctx.closed() || held.has(ADAPTERS[entryTool].quotaProvider))
        continue;
      let host: number | undefined;
      const placement = this.ctx.placement;
      const need = placement
        ? await placement
            .need(entry.task_id, entryTool, entry.urgent)
            .catch(() => undefined)
        : undefined;
      if (this.ctx.closed()) return moved;
      // 判定与占位之间没有 await：同时进来的另一轮 drain 看得到这里的 launching。
      // 闲时的（t136）：同一工具或在等本机空位的普通任务还有没拉起的（队首只取每个工具一件），先让它们。
      if (entry.idle && this.idleAhead(entryTool)) continue;
      // 队首按紧急、普通、闲时排好：普通任务被挡住时，后面不会还有紧急的。
      if (placement && need) {
        const choice = placement.choose(need, entry.host_id ?? null);
        // 指定的主机离线、暂停或满了：只等它，不挡别的队。
        if (choice.kind !== "run") {
          if (entry.host_id) continue;
          break;
        }
        host = choice.host;
      } else {
        const gate = this.ctx.hostGate?.(entry.urgent);
        if (gate && !gate.ok) break;
      }
      if (
        ADAPTERS[entryTool].exclusive &&
        this.busy(entryTool, undefined, host ?? LOCAL_HOST)
      ) {
        // 紧急的（t215）：独占工具被普通任务占着就暂停它，它一退出这里再拉起。
        if (entry.urgent)
          this.ctx.makeRoom?.(entry.task_id, entryTool, host ?? LOCAL_HOST);
        continue;
      }
      // 紧急的在满或太忙的主机上拉起前，先暂停一个闲时（再普通）任务腾位置。
      if (
        entry.urgent &&
        this.ctx.makeRoom?.(entry.task_id, entryTool, host ?? LOCAL_HOST).wait
      )
        continue;
      if (!dequeue(this.ctx.db, entry.task_id)) continue;
      moved++;
      this.claim(entry.task_id, entryTool, host);
      try {
        const worker = await resolveWorker(
          entry.worker,
          this.ctx.launchOptions.db,
        );
        if (this.ctx.closed()) return moved;
        const task = getTask(this.ctx.db, entry.task_id);
        await chooseWorker(
          { worker: worker.id, risk: entry.risk as Risk },
          this.ctx.launchOptions,
          held,
          {
            chain: taskAvoidChain(this.ctx.db, task),
            ...(this.remoteHost(host) && placement
              ? { installed: placement.installed(host) }
              : {}),
          },
        );
        await this.launch(entry.task_id, {
          worker,
          risk: entry.risk as Risk,
          host,
        });
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
        this.release(entry.task_id);
        this.ctx.waits.changed(entry.task_id);
      }
    }
    return moved;
  }
}
