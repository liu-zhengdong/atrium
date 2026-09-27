import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { recentAction } from "./action.ts";
import { taskDir, type Active } from "./active.ts";
import { ADAPTERS, isTool, type Tool } from "./adapters/index.ts";
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
  type Task,
} from "./ledger.ts";
import { readLogChunk, readLogTail } from "./log-view.ts";
import { admit, placement, runRequest } from "./plan.ts";
import type { PaceEntry } from "./prepare.ts";
import { DEFAULT_WORKERS_DIR } from "./profiles.ts";
import { dequeue, enqueue, ensureQueueTable, queued } from "./queue.ts";
import { clock } from "./quota-holds.ts";
import { QuotaGuard } from "./quota-runtime.ts";
import { recoverRunning } from "./recovery.ts";
import { signalGroup } from "./spawn.ts";
import { countRows, RECENT_MS, topRows } from "./top.ts";
import { TaskWaits } from "./waits.ts";
import { chooseWorker, type Choice } from "./worker-choice.ts";
import { workerEnvironment } from "./worker-env.ts";
import { readRestartState } from "../supervisor.ts";
import { Scheduler, planItem } from "./schedule.ts";
import { requireRow } from "./ledger-model.ts";
import { schedulePrExec } from "./schedule-pr.ts";
import type { LaunchOptions } from "./workspace.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";

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
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly exec: Exec;
  private readonly launchOptions: LaunchOptions;
  private closed = false;
  private polling = false;
  /** 看板上把日志里的绝对路径缩成相对路径用的工作目录，按任务记一份。 */
  private readonly cwds = new Map<number, string>();
  private recovered = false;
  private restartPending: boolean;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: RunnerOptions,
  ) {
    this.restartPending =
      readRestartState(options.data)?.status === "waiting_idle";
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
      charterPath: options.charterPath,
    };
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
      paused: () => this.restartPending,
    });
    this.scheduler = new Scheduler(
      db,
      this.inbox,
      (ref) => this.run(ref, {}),
      options.exec ?? schedulePrExec,
    );
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
      if (!this.closed) await this.quota.releaseExpired(this.x);
      if (!this.closed && this.recovered) await this.scheduler.tick();
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    void this.recover()
      .then(async () => {
        this.recovered = true;
        if (!this.closed) await this.scheduler.tick();
      })
      .catch((error) => console.error("任务运行时自愈失败：", error));
  }

  /** 执行者进程不随服务退出：它们在独立进程组里，重启后按 pid 接管。 */
  close() {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.inbox.close();
    this.waits.close();
  }

  setRestartPending(value: boolean) {
    this.restartPending = value;
  }

  isRestartPending() {
    return this.restartPending;
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

  async resumeQueue() {
    if (!this.closed && !this.restartPending)
      while ((await this.x.drain()) > 0) {
        /* each pass removes at least one entry */
      }
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
      chosen = await chooseWorker(
        request,
        this.launchOptions,
        this.quota.held(),
        { busy: this.x.busyTools(id), chain: taskAvoidChain(this.db, task) },
      );
    } catch (error) {
      this.x.launching.delete(id);
      throw error;
    }
    const tool = chosen.worker.tool;
    if (this.restartPending) {
      this.x.launching.delete(id);
      return this.enqueue(task, chosen, "等待重启；重启完成后自动派发");
    }
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
    } finally {
      this.x.launching.delete(id);
    }
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
        this.waits.changed(outcome.task.id);
      }
    } finally {
      this.polling = false;
    }
  }

  // ---- 停止、日志、等待 ----

  /** by：发起停止的订阅者，由此产生的事件不投给他本人。 */
  stop(reference: unknown, by?: string) {
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
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

  private pending(id: number, task: Task) {
    return (
      task.status === "running" ||
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
        const id = Number(row.ref.slice(1));
        const action = recentAction({
          tool: toolOf(row.worker),
          tail: logs[index]!.text,
          cwd: this.cwdOf(id, this.x.active.get(id)),
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

  /**
   * 日志里的路径按执行者真正看到的工作目录缩短。macOS 上 /var 是 /private/var 的软链，
   * 进程里 PWD 是解析后的那份，不解析就缩不掉；解析一次就够，任务在跑期间目录不变。
   */
  private cwdOf(id: number, active: Active | undefined) {
    const known = this.cwds.get(id);
    if (known) return known;
    const path = active?.prepared?.cwd ?? active?.worktree;
    if (!path) return undefined;
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // 目录已经没了就用原样，缩不掉也不该让看板失败。
    }
    if (this.cwds.size > 500) this.cwds.clear();
    this.cwds.set(id, real);
    return real;
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
