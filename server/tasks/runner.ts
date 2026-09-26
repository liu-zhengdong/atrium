import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { ADAPTERS, type Tool } from "./adapters/index.ts";
import { CI_BATCH, CI_POLL_MS, pollCiOnce } from "./ci-poll.ts";
import { EventInbox } from "./events.ts";
import { collectFacts } from "./facts.ts";
import { evaluateGates } from "./gates.ts";
import { defaultBranch, exec as defaultExec, type Exec } from "./git.ts";
import {
  alive,
  chooseWorker,
  prepareRun,
  runRequest,
  signalGroup,
  spawnWorker,
  taskDir,
  type LaunchOptions,
  type Prepared,
} from "./launch.ts";
import {
  DEFAULT_OWNER,
  advanceTask,
  getTask,
  noteTask,
  parseTaskRef,
  taskRef,
  type RunFields,
  type Task,
} from "./ledger.ts";
import type { PaceEntry } from "./prepare.ts";
import {
  DEFAULT_WORKERS_DIR,
  resolveWorker,
  type ResolvedWorker,
  type Risk,
} from "./profiles.ts";
import { dequeue, enqueue, ensureQueueTable, heads, queued } from "./queue.ts";
import { transition, type TaskEvent } from "./state.ts";
import { summarize } from "./summary.ts";
import {
  ProgressProbe,
  judge,
  watchLimits,
  type WatchLimits,
  type WatchState,
} from "./watchdog.ts";
import { workerEnvironment } from "./worker-env.ts";

/**
 * 派活与等待的运行时（#262）：服务持有执行者进程、看门狗、退出后查事实过关卡、CI 轮询、
 * 重启自愈。领域判定（状态机、关卡、看门狗）都在各自的纯函数里，这里只做编排与落库。
 */

export type RunnerOptions = {
  data: string;
  workersDir?: string;
  /** 执行者环境的来源（再经白名单过滤）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  pace?: () => Promise<PaceEntry[] | undefined>;
  tickMs?: number;
  ciPollMs?: number;
  ciBatch?: number;
  /** 事件攒批窗口（毫秒），缺省 0。 */
  batchMs?: number;
  /** 停止信号发出后多久强杀。 */
  killGraceMs?: number;
};

type Stop =
  | { kind: "user" }
  | { kind: "stalled"; reason: string }
  | { kind: "idle"; reason: string };

type Active = {
  id: number;
  pid: number;
  /** 服务重启后接管的进程没有句柄，只能按 pid 轮询。 */
  child?: ChildProcess;
  tool: Tool;
  worker: ResolvedWorker;
  risk: Risk;
  prepared?: Prepared;
  logFile: string;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  probe: ProgressProbe;
  state: WatchState;
  limits: WatchLimits;
  retried: boolean;
  stop?: Stop;
  exited: boolean;
};

type Exit = { code: number | null; signal: NodeJS.Signals | null } | "unknown";

const TAIL_BYTES = 64 * 1024;
export const LOG_CHUNK = 64 * 1024;

export class TaskRunner {
  readonly inbox: EventInbox;
  private readonly active = new Map<number, Active>();
  /** 正在准备（建 worktree、写提示词）的任务及其工具，防止重复派与独占冲突。 */
  private readonly launching = new Map<number, Tool | null>();
  private readonly changes = new EventEmitter();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly exec: Exec;
  private readonly workersDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private closed = false;
  private ticking = false;
  private polling = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: RunnerOptions,
  ) {
    ensureQueueTable(db);
    this.inbox = new EventInbox(db, options.batchMs ?? 0);
    this.exec = options.exec ?? defaultExec;
    this.workersDir = options.workersDir ?? DEFAULT_WORKERS_DIR;
    this.env = workerEnvironment(options.env ?? process.env);
    this.changes.setMaxListeners(0);
  }

  /** 启动看门狗与 CI 轮询，并在后台自愈上次遗留的运行中任务（不阻塞启动）。 */
  start() {
    const every = (ms: number, fn: () => Promise<void>) => {
      const timer = setInterval(() => {
        void fn().catch((error) => console.error("任务运行时：", error));
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.options.tickMs ?? 5000, () => this.tick());
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    void this.recover().catch((error) =>
      console.error("任务运行时自愈失败：", error),
    );
  }

  close() {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.inbox.close();
    this.changes.emit("close");
    // 执行者进程不随服务退出：它们在独立进程组里，重启后按 pid 接管。
  }

  private launchOptions(): LaunchOptions {
    return {
      data: this.options.data,
      workersDir: this.workersDir,
      env: this.env,
      run: this.exec,
      pace: this.options.pace,
    };
  }

  private busy(tool: Tool, except?: number) {
    for (const active of this.active.values())
      if (active.tool === tool && active.id !== except && !active.exited)
        return true;
    for (const [id, launching] of this.launching)
      if (launching === tool && id !== except) return true;
    return false;
  }

  private notify(id: number) {
    this.changes.emit("change", id);
  }

  private publish(id: number, kind: string, detail: Record<string, unknown>) {
    const task = getTask(this.db, id);
    this.inbox.publish({
      subscriber: task.owner ?? DEFAULT_OWNER,
      taskId: id,
      source: detail.source === undefined ? "runner" : String(detail.source),
      kind,
      key: `${task.ref}:${kind.startsWith("ci") ? "ci" : "outcome"}`,
      detail: {
        title: task.title,
        status: task.status,
        worker: task.worker,
        pr_url: task.pr_url,
        ci: task.ci,
        ...detail,
      },
    });
  }

  private advance(
    id: number,
    event: TaskEvent,
    fields: RunFields = {},
    detail?: unknown,
  ) {
    return advanceTask(this.db, taskRef(id), event, fields, detail);
  }

  // ---- 派活 ----

  async run(reference: unknown, body: unknown) {
    const request = runRequest(body);
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    if (this.active.has(id) || this.launching.has(id))
      throw new Problem(
        409,
        `${task.ref} 正在运行或正在启动，不能重复派`,
        "conflict",
        undefined,
        `atrium task wait ${task.ref}`,
      );
    if (queued(this.db, id))
      throw new Problem(
        409,
        `${task.ref} 已在排队`,
        "conflict",
        undefined,
        `atrium task wait ${task.ref}`,
      );
    const check = transition(task.status, { kind: "start" });
    if (!check.ok)
      throw new Problem(
        409,
        `${task.ref}：${check.reason}`,
        "conflict",
        undefined,
        `atrium task show ${task.ref}`,
      );
    this.launching.set(id, null);
    let chosen;
    try {
      chosen = await chooseWorker(request, this.launchOptions());
    } catch (error) {
      this.launching.delete(id);
      throw error;
    }
    const tool = chosen.worker.tool;
    if (ADAPTERS[tool].exclusive && this.busy(tool, id)) {
      this.launching.delete(id);
      enqueue(this.db, {
        task_id: id,
        tool,
        worker: chosen.worker.id,
        risk: chosen.risk,
        queued_at: Date.now(),
      });
      if (task.status !== "todo")
        this.advance(id, { kind: "manual_set", to: "todo" }, {}, "排队重派");
      noteTask(this.db, id, "queued", {
        worker: chosen.worker.id,
        reason: `${tool} 同一时刻只跑一个，前一个结束后自动拉起`,
      });
      this.notify(id);
      return { task: getTask(this.db, id), queued: true };
    }
    this.launching.set(id, tool);
    try {
      return { task: await this.launch(id, chosen), queued: false };
    } finally {
      this.launching.delete(id);
    }
  }

  private async launch(
    id: number,
    chosen: { worker: ResolvedWorker; risk: Risk },
    retried = false,
  ): Promise<Task> {
    const task = getTask(this.db, id);
    const prepared = await prepareRun(task, chosen, this.launchOptions());
    const child = await spawnWorker(prepared, this.env, task.ref);
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
    const active: Active = {
      id,
      pid,
      child,
      tool: chosen.worker.tool,
      worker: chosen.worker,
      risk: chosen.risk,
      prepared,
      logFile: prepared.logFile,
      repo: task.repo,
      worktree: prepared.worktree,
      branch: prepared.branch,
      base: prepared.base,
      probe: this.probe(
        prepared.logFile,
        prepared.cwd,
        !!prepared.worktree,
        chosen.worker.tool,
      ),
      state: { startedAt: Date.now(), lastProgressAt: null },
      limits: this.limitsFor(chosen.worker),
      retried,
      exited: false,
    };
    this.active.set(id, active);
    child.once("exit", (code, signal) => {
      void this.finish(id, { code, signal });
    });
    await active.probe.baseline();
    this.notify(id);
    return started;
  }

  private probe(logFile: string, cwd: string, git: boolean, tool: Tool) {
    return new ProgressProbe(
      logFile,
      cwd,
      git,
      ADAPTERS[tool].progressSignals.includes("json_events"),
      this.exec,
    );
  }

  private limitsFor(worker: ResolvedWorker) {
    return watchLimits(
      ADAPTERS[worker.tool].watchdog,
      worker.profile.rules.limits,
    );
  }

  // ---- 退出与验收 ----

  private async readSummary(active: Active) {
    const resultFile = active.prepared?.launch.resultFile;
    if (resultFile && existsSync(resultFile)) {
      const text = readFileSync(resultFile, "utf8").trim();
      if (text) return summarize(text);
    }
    try {
      const size = (await stat(active.logFile)).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const handle = await open(active.logFile, "r");
      try {
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const text = buffer
          .toString("utf8")
          .split("\n")
          .filter((line) => !line.startsWith("[atrium] "))
          .join("\n");
        return summarize(text);
      } finally {
        await handle.close();
      }
    } catch {
      return "";
    }
  }

  private async finish(id: number, exit: Exit) {
    const active = this.active.get(id);
    if (!active || active.exited) return;
    active.exited = true;
    let relaunched = false;
    try {
      const summary = await this.readSummary(active);
      const exitText =
        exit === "unknown"
          ? "退出码未知（服务重启期间退出）"
          : exit.signal
            ? `被信号 ${exit.signal} 结束`
            : `退出码 ${exit.code}`;
      try {
        appendFileSync(
          active.logFile,
          `\n[atrium] ${new Date().toISOString()} ${exitText}\n`,
        );
      } catch {
        // 日志目录被删不影响收尾。
      }
      const task = getTask(this.db, id);
      if (task.status !== "running") return;
      const exitDetail =
        exit === "unknown"
          ? { exit: "unknown" }
          : { code: exit.code, signal: exit.signal };
      const stop = active.stop;
      if (stop?.kind === "user") {
        this.advance(
          id,
          { kind: "exit_fail" },
          { result: summary },
          {
            reason: "人工停止",
            ...exitDetail,
          },
        );
        this.publish(id, "failed", { reason: "人工停止" });
      } else if (stop?.kind === "stalled") {
        this.advance(
          id,
          { kind: "exit_fail" },
          { result: summary },
          {
            reason: stop.reason,
            ...exitDetail,
          },
        );
        const retry =
          !active.retried &&
          active.worker.profile.rules.retry_on_stall !== false;
        if (retry) {
          this.publish(id, "stalled", { reason: stop.reason, retry: true });
          this.active.delete(id);
          relaunched = true;
          try {
            await this.launch(
              id,
              { worker: active.worker, risk: active.risk },
              true,
            );
          } catch (error) {
            const reason = `卡死后重试拉起失败：${error instanceof Error ? error.message : String(error)}`;
            noteTask(this.db, id, "retry_failed", { reason });
            this.publish(id, "failed", { reason });
          }
        } else this.publish(id, "failed", { reason: stop.reason });
      } else if (stop?.kind === "idle") {
        this.advance(
          id,
          { kind: "block" },
          { result: summary },
          {
            reason: stop.reason,
            ...exitDetail,
          },
        );
        this.publish(id, "blocked", { reason: stop.reason });
      } else await this.accept(active, exit, summary, exitDetail);
    } catch (error) {
      console.error(`任务 ${taskRef(id)} 收尾失败：`, error);
      try {
        if (getTask(this.db, id).status === "running") {
          const reason = `收尾出错：${error instanceof Error ? error.message : String(error)}`;
          this.advance(id, { kind: "exit_fail" }, {}, { reason });
          this.publish(id, "failed", { reason });
        }
      } catch {
        // 数据库已关闭（服务正在停），重启自愈会接手。
      }
    } finally {
      if (!relaunched) this.active.delete(id);
      this.notify(id);
      if (!this.closed) void this.drain(active.tool);
    }
  }

  /** 正常退出：自己查事实、按档案过关卡；非 0 退出直接失败，但事实照样记下。 */
  private async accept(
    active: Active,
    exit: Exit,
    summary: string,
    exitDetail: Record<string, unknown>,
  ) {
    const { id } = active;
    const facts = await collectFacts(
      {
        repo: active.repo,
        worktree: active.worktree,
        branch: active.branch,
        base: active.base,
        summary,
      },
      this.exec,
    );
    const fields: RunFields = {
      pr_url: facts.pr?.url ?? null,
      ci: facts.ci,
      result: summary,
    };
    if (exit !== "unknown" && exit.code !== 0) {
      const reason = exit.signal
        ? `执行者被信号 ${exit.signal} 结束`
        : `执行者退出码 ${exit.code}`;
      this.advance(id, { kind: "exit_fail" }, fields, {
        reason,
        ...exitDetail,
      });
      this.publish(id, "failed", { reason });
      return;
    }
    const rules = active.worker.profile.rules;
    const verdict = evaluateGates(
      rules.checks ?? [],
      rules.limits ?? {},
      facts,
    );
    const added = facts.numstat.reduce((sum, stat) => sum + stat.added, 0);
    const removed = facts.numstat.reduce((sum, stat) => sum + stat.removed, 0);
    noteTask(this.db, id, "gates", {
      worker: active.worker.id,
      passed: verdict.passed,
      awaiting_ci: verdict.awaitingCi,
      results: verdict.results,
      diff: { files: facts.numstat.length, added, removed },
      ...exitDetail,
    });
    if (verdict.passed) {
      this.advance(id, { kind: "exit_ok" }, fields, exitDetail);
      this.publish(id, "done", {
        diff: { files: facts.numstat.length, added, removed },
      });
      return;
    }
    const reason = verdict.failed
      .map((result) => `${result.gate}：${result.evidence}`)
      .join("；");
    this.advance(id, { kind: "block" }, fields, {
      reason: verdict.awaitingCi ? `等 CI：${reason}` : `关卡不过：${reason}`,
      gates: verdict.failed.map((result) => result.gate),
      ...exitDetail,
    });
    this.publish(id, "blocked", {
      reason: verdict.awaitingCi ? `等 CI：${reason}` : `关卡不过：${reason}`,
      gates: verdict.failed,
    });
  }

  // ---- 看门狗与接管 ----

  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const now = () => Date.now();
      for (const active of [...this.active.values()]) {
        if (active.exited) continue;
        if (!active.child && !alive(active.pid)) {
          void this.finish(active.id, "unknown");
          continue;
        }
        if (active.stop) continue;
        const { signals } = await active.probe.poll();
        if (signals.length) active.state.lastProgressAt = now();
        const verdict = judge(active.state, active.limits, now());
        if (verdict.kind === "ok") continue;
        active.stop = verdict;
        noteTask(this.db, active.id, verdict.kind, { reason: verdict.reason });
        this.kill(active);
      }
    } finally {
      this.ticking = false;
    }
  }

  private kill(active: Active) {
    signalGroup(active.pid, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) signalGroup(active.pid, "SIGKILL");
    }, this.options.killGraceMs ?? 10_000).unref();
  }

  /** pid 还在，且确实是该工具的进程（防 pid 复用误接管、误杀）。 */
  private async ownsPid(pid: number, tool: Tool) {
    if (!alive(pid)) return false;
    const ps = await this.exec("ps", ["-o", "command=", "-p", String(pid)], {
      timeoutMs: 5000,
    });
    return ps.ok && ps.stdout.includes(ADAPTERS[tool].executable);
  }

  /** 服务重启自愈：进程已不在的置 failed；还在的按 pid 接管；再把排队的拉起来。 */
  async recover() {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status='running' ORDER BY id")
      .all() as { id: number }[];
    for (const { id } of rows) {
      if (this.active.has(id) || this.launching.has(id)) continue;
      const task = getTask(this.db, id);
      let worker: ResolvedWorker | undefined;
      try {
        worker = task.worker
          ? await resolveWorker(task.worker, this.workersDir)
          : undefined;
      } catch {
        worker = undefined;
      }
      if (task.pid && worker && (await this.ownsPid(task.pid, worker.tool))) {
        await this.adopt(task, worker);
        continue;
      }
      const reason = "服务重启时执行者进程已不在";
      this.advance(
        id,
        { kind: "exit_fail" },
        {},
        { reason, pid: task.pid, source: "recovery" },
      );
      this.publish(id, "failed", { reason, source: "recovery" });
      this.notify(id);
    }
    await this.drain();
  }

  private async adopt(task: Task, worker: ResolvedWorker) {
    const logFile = join(taskDir(this.options.data, task.id), "log");
    const cwd =
      task.worktree ?? join(taskDir(this.options.data, task.id), "work");
    let base: string | null = null;
    if (task.repo)
      base = await defaultBranch(task.repo, this.exec).catch(() => null);
    const active: Active = {
      id: task.id,
      pid: task.pid!,
      tool: worker.tool,
      worker,
      risk: "low",
      logFile,
      repo: task.repo,
      worktree: task.worktree,
      branch: task.branch,
      base,
      probe: this.probe(logFile, cwd, !!task.worktree, worker.tool),
      // 重启期间的进展无从得知：从现在起重新计空闲时间，不按启动卡死判。
      state: { startedAt: Date.now(), lastProgressAt: Date.now() },
      limits: this.limitsFor(worker),
      retried: true,
      exited: false,
    };
    await active.probe.baseline();
    this.active.set(task.id, active);
    noteTask(this.db, task.id, "adopted", {
      pid: task.pid,
      reason: "服务重启后按 pid 接管",
    });
  }

  /** 拉起排队中的任务：每个工具的队首，前提是该工具空闲。 */
  private async drain(tool?: Tool) {
    for (const entry of heads(this.db, tool)) {
      const entryTool = entry.tool as Tool;
      if (this.closed || this.busy(entryTool)) continue;
      dequeue(this.db, entry.task_id);
      this.launching.set(entry.task_id, entryTool);
      try {
        const worker = await resolveWorker(entry.worker, this.workersDir);
        await this.launch(entry.task_id, { worker, risk: entry.risk as Risk });
      } catch (error) {
        const reason = `排队后拉起失败：${error instanceof Error ? error.message : String(error)}`;
        try {
          this.advance(entry.task_id, { kind: "block" }, {}, { reason });
          this.publish(entry.task_id, "blocked", { reason });
        } catch {
          noteTask(this.db, entry.task_id, "launch_failed", { reason });
        }
      } finally {
        this.launching.delete(entry.task_id);
        this.notify(entry.task_id);
      }
    }
  }

  // ---- CI ----

  async pollCi() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const outcomes = await pollCiOnce(
        this.db,
        this.options.ciBatch ?? CI_BATCH,
        this.exec,
      );
      for (const outcome of outcomes) {
        this.publish(outcome.task.id, `ci_${outcome.ci ?? "none"}`, {
          source: "ci",
          ...(outcome.detail ? { reason: outcome.detail } : {}),
          ...(outcome.accepted ? { accepted: true } : {}),
        });
        this.notify(outcome.task.id);
      }
    } finally {
      this.polling = false;
    }
  }

  // ---- 停止、日志、等待 ----

  stop(reference: unknown) {
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    if (dequeue(this.db, id)) {
      noteTask(this.db, id, "unqueued", { reason: "人工停止，移出队列" });
      this.notify(id);
      return { task: getTask(this.db, id), stopping: false };
    }
    const active = this.active.get(id);
    if (active && !active.exited) {
      active.stop = { kind: "user" };
      noteTask(this.db, id, "stop_requested", { pid: active.pid });
      this.kill(active);
      return { task: getTask(this.db, id), stopping: true };
    }
    if (this.launching.has(id))
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
    const stopped = this.advance(
      id,
      { kind: "exit_fail" },
      {},
      {
        reason: "人工停止（服务未掌握该进程）",
      },
    );
    this.publish(id, "failed", { reason: "人工停止" });
    this.notify(id);
    return { task: stopped, stopping: false };
  }

  async log(reference: unknown, after: unknown) {
    const id = parseTaskRef(reference);
    const task = getTask(this.db, id);
    const offset = after === undefined || after === "" ? 0 : Number(after);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Problem(400, "after: 应为非负整数字节偏移", "usage");
    const file = join(taskDir(this.options.data, id), "log");
    const running =
      task.status === "running" ||
      !!queued(this.db, id) ||
      this.launching.has(id);
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      return { text: "", next: 0, size: 0, running, status: task.status };
    }
    const start = Math.min(offset, size);
    const length = Math.min(size - start, LOG_CHUNK);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      // 不切断 UTF-8 字符：末尾是半个字符就留到下一次。
      let end = length;
      if (start + length < size) {
        while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end--;
        if (end > 0 && buffer[end - 1]! >= 0xc0) end--;
      }
      return {
        text: buffer.subarray(0, end).toString("utf8"),
        next: start + end,
        size,
        running,
        status: task.status,
      };
    } finally {
      await handle.close();
    }
  }

  private settled(id: number) {
    const task = getTask(this.db, id);
    const pending =
      task.status === "running" ||
      !!queued(this.db, id) ||
      this.launching.has(id);
    return pending ? null : task;
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
    return new Promise<{
      task: Task;
      timed_out: boolean;
      restarting?: boolean;
    }>((resolve) => {
      let done = false;
      const finish = (restarting = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.changes.off("change", changed);
        this.changes.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        const task = this.closed ? null : this.settled(id);
        resolve({
          task:
            task ??
            (this.closed
              ? ({ ref: taskRef(id) } as Task)
              : getTask(this.db, id)),
          timed_out: !task,
          ...(restarting ? { restarting: true } : {}),
        });
      };
      const changed = (changedId: number) => {
        if (changedId === id && this.settled(id)) finish();
      };
      const closing = () => finish(true);
      const aborted = () => finish();
      const timer = setTimeout(() => finish(), seconds * 1000);
      this.changes.on("change", changed);
      this.changes.on("close", closing);
      signal?.addEventListener("abort", aborted);
    });
  }
}
