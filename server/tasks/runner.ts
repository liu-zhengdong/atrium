import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { taskDir } from "./active.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { CI_BATCH, CI_POLL_MS, pollCiOnce } from "./ci-poll.ts";
import { EventInbox } from "./events.ts";
import { Executors, type Chosen } from "./executors.ts";
import { exec as defaultExec, type Exec } from "./git.ts";
import { getTask, noteTask, parseTaskRef, type Task } from "./ledger.ts";
import { readLogChunk } from "./log-view.ts";
import { admit, placement, runRequest } from "./plan.ts";
import type { PaceEntry } from "./prepare.ts";
import { DEFAULT_WORKERS_DIR } from "./profiles.ts";
import { dequeue, enqueue, ensureQueueTable, queued } from "./queue.ts";
import { clock } from "./quota-holds.ts";
import { QuotaGuard } from "./quota-runtime.ts";
import { recoverRunning } from "./recovery.ts";
import { signalGroup } from "./spawn.ts";
import { TaskWaits } from "./waits.ts";
import { chooseWorker, type Choice } from "./worker-choice.ts";
import { workerEnvironment } from "./worker-env.ts";
import { readRestartState } from "../supervisor.ts";
import type { LaunchOptions } from "./workspace.ts";

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
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly exec: Exec;
  private readonly launchOptions: LaunchOptions;
  private closed = false;
  private polling = false;
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
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    void this.recover().catch((error) =>
      console.error("任务运行时自愈失败：", error),
    );
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
        { busy: this.x.busyTools(id) },
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
      this.x.launching.has(id)
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
