import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { taskDir } from "../tasks/active.ts";
import { exec as localExec, type Exec } from "../tasks/git.ts";
import type { ReaderOutcome } from "../quota-readers/index.ts";
import type { Exit } from "../tasks/outcome.ts";
import type { LeftoverKill, LeftoverTarget } from "../tasks/leftovers.ts";
import {
  beginRun,
  hostRow,
  hostRun,
  runningOn,
  setLogOffset,
  touchHost,
  updateInfo,
} from "./model.ts";
import {
  POLL_WAIT_MS,
  type AgentCommand,
  type Assignment,
  type CleanReply,
  type ExecReply,
  type ExitBody,
  type HelloBody,
  type LaunchAck,
  type LogBody,
  type PollBody,
  type PollReply,
  type QuotaBody,
} from "./protocol.ts";
import {
  hostRef,
  logAccept,
  ONLINE_MS,
  reconcile,
  type HostInfo,
} from "./state.ts";

/**
 * 服务这一侧的代理连接（#358 第 1 步）：每台主机一条指令队列，代理长轮询来取；
 * 指令的回执按 id 对上等着的调用方。日志与退出由代理另发请求上报，按 host_runs 的轮号与字节偏移对上，
 * 日志写进本机任务目录的同一个 log 文件，`task log`、`top`、看门狗照旧读它。
 */

/** 各种指令去掉 id（按种类分别去，联合类型才对得上）。 */
type CommandInput = AgentCommand extends infer C
  ? C extends AgentCommand
    ? Omit<C, "id">
    : never
  : never;

/** 拉起、查事实、本地检查这类要等结果的指令：代理这么久没来领就先报错。 */
export const PICKUP_MS = 45_000;

/** 某台代理上报的额度读数（按 provider 一份，内存里留最近一次）。 */
export type HostQuota = {
  host: number;
  at: number;
  readings: { provider: string; outcome: ReaderOutcome }[];
};

type Pending = {
  host: number;
  command: AgentCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /**
   * 代理确实收到了：下一轮长轮询报「手上在做」里有它。交给一条已断开的长轮询不算，
   * 那样的指令下一轮会重发。
   */
  received: boolean;
  pickup?: NodeJS.Timeout;
};

/** 执行者运行时对远程运行的处理（由 Executors 实现）。 */
export type RemoteHooks = {
  /** 服务重启自愈是否已完成（之前的对账与退出上报让代理稍后重试）。 */
  ready(): boolean;
  /** 代理报告某一轮退出：done 已接手，retry 还在启动、稍后再报，ignored 账本已不认这一轮。 */
  exited(task: number, run: number, exit: Exit): "done" | "retry" | "ignored";
  /** 账本说在这台上跑、代理却不知道这一轮。 */
  lost(task: number, reason: string): void;
  /** 代理重连后：这台上的执行者从现在起重新计空闲。 */
  reconnected(host: number): void;
};

export class RemoteHosts {
  private readonly queues = new Map<number, Pending[]>();
  private readonly waiters = new Map<number, Set<() => void>>();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<number, number>();
  private readonly quotas = new Map<number, HostQuota>();
  private hooks: RemoteHooks | undefined;
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly data: string,
    private readonly options: {
      pollMs?: number;
      /** 要等结果的指令没人来领多久就报错；缺省 PICKUP_MS。 */
      pickupMs?: number;
      /** 多久没来算离线；缺省 ONLINE_MS。 */
      onlineMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private get pickupMs() {
    return this.options.pickupMs ?? PICKUP_MS;
  }

  get onlineMs() {
    return this.options.onlineMs ?? ONLINE_MS;
  }

  attach(hooks: RemoteHooks) {
    this.hooks = hooks;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  polling(host: number) {
    return (this.waiters.get(host)?.size ?? 0) > 0;
  }

  /** 长轮询挂着，或最近一分钟内来过。 */
  online(host: number) {
    if (this.polling(host)) return true;
    const seen =
      this.seen.get(host) ??
      (() => {
        try {
          return hostRow(this.db, host).last_seen_at;
        } catch {
          return null;
        }
      })();
    return (
      seen !== null && seen !== undefined && this.now() - seen <= this.onlineMs
    );
  }

  /** 这台主机的系统与数据目录；没接入或离线时报错。 */
  site(host: number): {
    os: string;
    data_dir: string;
    skills: boolean;
    version: string;
  } {
    const row = hostRow(this.db, host);
    if (row.kind !== "remote" || row.removed_at !== null)
      throw new Problem(
        409,
        `${hostRef(host)} 不是可派活的远程主机`,
        "conflict",
      );
    if (!this.online(host))
      throw new Problem(
        409,
        `${hostRef(host)} 离线：那台机器上的 atrium agent 没连上服务`,
        "conflict",
        undefined,
        "atrium host ls",
      );
    let info: HostInfo | null = null;
    try {
      info = row.info ? (JSON.parse(row.info) as HostInfo) : null;
    } catch {
      info = null;
    }
    if (!info?.data_dir || !info.os)
      throw new Problem(409, `${hostRef(host)} 还没上报机器信息`, "conflict");
    return {
      os: info.os,
      data_dir: info.data_dir,
      skills: info.skills === true,
      version: info.version,
    };
  }

  /**
   * 发一条指令给代理，等它的回执；超时或服务关闭时报错。
   * pickupMs：这么久没人来领就先报错（代理刚断开时不干等整个回执时限）；不给就一直留到超时（停止指令等重连）。
   */
  send<T>(
    host: number,
    command: CommandInput,
    timeoutMs: number,
    pickupMs?: number,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("服务已关闭"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        host,
        command: { ...command, id } as AgentCommand,
        resolve: resolve as (value: unknown) => void,
        reject,
        received: false,
        timer: setTimeout(() => {
          this.drop(id);
          reject(
            new Problem(
              409,
              `${hostRef(host)} 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应`,
              "conflict",
              undefined,
              `atrium host show ${hostRef(host)}`,
            ),
          );
        }, timeoutMs),
      };
      entry.timer.unref();
      if (pickupMs !== undefined) {
        entry.pickup = setTimeout(() => {
          if (entry.received) return;
          this.drop(id);
          reject(
            new Problem(
              409,
              `${hostRef(host)} 的代理 ${Math.round(pickupMs / 1000)} 秒内没来领（可能刚断开）`,
              "conflict",
              undefined,
              `atrium host show ${hostRef(host)}`,
            ),
          );
        }, pickupMs);
        entry.pickup.unref();
      }
      this.pending.set(id, entry);
      const queue = this.queues.get(host) ?? [];
      queue.push(entry);
      this.queues.set(host, queue);
      this.wake(host);
    });
  }

  private drop(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.pickup) clearTimeout(entry.pickup);
    this.pending.delete(id);
    const queue = this.queues.get(entry.host);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) this.queues.delete(entry.host);
    }
  }

  private wake(host: number) {
    const waiters = this.waiters.get(host);
    if (!waiters) return;
    for (const wake of [...waiters]) wake();
  }

  /** 代理的长轮询：交出还没回执、代理手上也没有的指令；没有就挂着等，最多 pollMs。 */
  async poll(
    host: number,
    body: PollBody,
    signal?: AbortSignal,
  ): Promise<PollReply> {
    this.seen.set(host, this.now());
    touchHost(this.db, host, body.load, this.now());
    const busy = new Set(body.busy);
    for (const entry of this.queues.get(host) ?? [])
      if (busy.has(entry.command.id)) entry.received = true;
    const take = () =>
      (this.queues.get(host) ?? [])
        .filter((entry) => !busy.has(entry.command.id))
        .map((entry) => entry.command);
    let commands = take();
    if (!commands.length && !this.closed && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const waiters = this.waiters.get(host) ?? new Set();
        this.waiters.set(host, waiters);
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          if (!waiters.size) this.waiters.delete(host);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, this.options.pollMs ?? POLL_WAIT_MS);
        timer.unref();
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      commands = this.closed ? [] : take();
    }
    this.seen.set(host, this.now());
    return { commands };
  }

  /** 代理交回执。对不上（超时丢掉、服务重启过）的拉起回执让代理结束刚起的进程。 */
  reply(host: number, id: string, result: unknown) {
    const entry = this.pending.get(id);
    if (!entry || entry.host !== host) return { ok: true, cancel: true };
    // 拉起成功：先记下这一轮与日志起点，代理随后来传的日志才对得上。
    if (entry.command.kind === "launch") {
      const ack = result as LaunchAck;
      if (ack?.ok) this.begin(host, entry.command.assignment, ack);
    }
    this.drop(id);
    entry.resolve(result);
    return { ok: true };
  }

  private begin(
    host: number,
    assignment: Assignment,
    ack: Extract<LaunchAck, { ok: true }>,
  ) {
    const log = join(taskDir(this.data, assignment.task), "log");
    mkdirSync(taskDir(this.data, assignment.task), {
      recursive: true,
      mode: 0o700,
    });
    // 与本机拉起一样：新一轮的日志从头写，上一轮的改名留档；续上会话时接着写。
    if (!assignment.resume && existsSync(log))
      renameSync(log, `${log}-${Date.now()}`);
    if (!existsSync(log)) writeFileSync(log, "", { mode: 0o600 });
    beginRun(this.db, {
      task_id: assignment.task,
      host_id: host,
      run: assignment.run,
      pid: ack.pid,
      clone: assignment.repo?.clone ?? null,
      worktree: assignment.repo?.worktree ?? null,
      dir: assignment.dir,
      log_offset: ack.offset,
      started_at: this.now(),
    });
  }

  // ---- 代理发来的 ----

  hello(host: number, body: HelloBody) {
    this.seen.set(host, this.now());
    updateInfo(this.db, host, body.info, this.now());
    if (!this.hooks?.ready())
      throw new Problem(
        503,
        "服务正在恢复在跑的任务，稍后重连",
        "service_unavailable",
      );
    const { lost, orphans } = reconcile(runningOn(this.db, host), body.runs);
    for (const run of lost)
      this.hooks.lost(
        run.task,
        `${hostRef(host)} 上的代理不知道这一轮（代理数据目录换过或被清掉），按退出情况不明收尾`,
      );
    this.hooks.reconnected(host);
    const row = hostRow(this.db, host);
    return {
      host: hostRef(host),
      name: row.name,
      stop: orphans.map(({ task, run }) => ({ task, run })),
    };
  }

  log(host: number, body: LogBody) {
    this.seen.set(host, this.now());
    const run = hostRun(this.db, body.task);
    if (!run || run.host_id !== host || run.run > body.run)
      return { done: true };
    if (run.run < body.run) return { wait: true };
    const data = Buffer.from(body.data, "base64");
    const accepted = logAccept(run.log_offset, {
      offset: body.offset,
      length: data.length,
    });
    if (accepted.kind !== "append") return { offset: run.log_offset };
    const bytes = data.subarray(accepted.skip);
    appendFileSync(join(taskDir(this.data, body.task), "log"), bytes, {
      mode: 0o600,
    });
    const offset = run.log_offset + bytes.length;
    setLogOffset(this.db, body.task, offset);
    return { offset };
  }

  exit(host: number, body: ExitBody) {
    this.seen.set(host, this.now());
    const run = hostRun(this.db, body.task);
    if (!run || run.host_id !== host || run.run !== body.run)
      return { ok: true, ignored: true };
    if (run.log_offset < body.size)
      return { ok: false, offset: run.log_offset };
    if (!this.hooks?.ready()) return { ok: false, retry: true };
    if (body.last_message !== undefined)
      writeFileSync(
        join(taskDir(this.data, body.task), "last-message.md"),
        body.last_message,
        { mode: 0o600 },
      );
    const verdict = this.hooks.exited(
      body.task,
      body.run,
      body.exit
        ? {
            code: body.exit.code,
            signal: body.exit.signal as NodeJS.Signals | null,
          }
        : "unknown",
    );
    return verdict === "retry"
      ? { ok: false, retry: true }
      : { ok: true, ...(verdict === "ignored" ? { ignored: true } : {}) };
  }

  /** 代理上报额度读数：只留最近一次，按账号合并在 quota-source 里做。 */
  quota(host: number, body: QuotaBody) {
    this.seen.set(host, this.now());
    this.quotas.set(host, { host, at: this.now(), readings: body.readings });
    return { ok: true };
  }

  /** 各主机最近一次上报的额度读数。 */
  quotaReports(): HostQuota[] {
    return [...this.quotas.values()];
  }

  // ---- 服务调用的 ----

  /** 拉起：等代理建好工作树、起了进程再回（克隆大仓库可能要几分钟）。 */
  async launch(
    host: number,
    assignment: Assignment,
  ): Promise<Extract<LaunchAck, { ok: true }>> {
    const ack = await this.send<LaunchAck>(
      host,
      { kind: "launch", assignment },
      10 * 60_000,
      this.pickupMs,
    );
    if (!ack?.ok)
      throw new Problem(
        409,
        `${hostRef(host)} 拉起失败：${ack?.ok === false ? ack.error : "回执无效"}`,
        "conflict",
      );
    return ack;
  }

  /** 结束远程执行者的进程树；代理离线时指令留着，连上后送到（重连对账也会结束账本不认的进程）。 */
  stop(host: number, task: number, run: number, signal: "SIGTERM" | "SIGKILL") {
    this.send(host, { kind: "stop", task, run, signal }, 5 * 60_000).catch(
      () => undefined,
    );
  }

  /**
   * 让那台的代理核对并结束残留执行者进程（t217）：离线、没来领、超时或代理太旧（不认这条指令）时报错写明原因。
   * 回执里只收清单里有的任务与 pid。
   */
  async clean(
    host: number,
    targets: readonly LeftoverTarget[],
  ): Promise<LeftoverKill[]> {
    const ref = hostRef(host);
    if (!this.online(host))
      throw new Problem(
        409,
        `${ref} 离线：那台的残留进程没清，代理连上后再清`,
        "conflict",
        undefined,
        `atrium host show ${ref}`,
      );
    const reply = await this.send<CleanReply | { ok: false; error?: string }>(
      host,
      { kind: "clean", now: this.now(), targets: [...targets] },
      2 * 60_000,
      this.pickupMs,
    );
    const killed = (reply as Partial<CleanReply> | null)?.killed;
    if (!Array.isArray(killed))
      throw new Problem(
        409,
        `${ref} 的代理没清：${(reply as { error?: string } | null)?.error ?? "回执无效"}（代理版本太旧时先在那台升级 Atrium）`,
        "conflict",
      );
    const wanted = new Map(
      targets.map((target) => [`${target.task}:${target.pid}`, target]),
    );
    return killed.flatMap((kill) => {
      const target = wanted.get(`${kill?.task}:${kill?.pid}`);
      return target
        ? [{ task: target.task, pid: target.pid, tool: target.tool }]
        : [];
    });
  }

  /** 在远程跑 git（只读查询与清理），其余命令仍在本机跑（gh 查 GitHub 由服务自己来）。 */
  exec(host: number): Exec {
    return async (command, args, options) => {
      if (command !== "git") return localExec(command, args, options);
      if (!this.online(host))
        return { ok: false, stdout: "", stderr: `${hostRef(host)} 离线` };
      const timeoutMs = options?.timeoutMs ?? 30_000;
      try {
        return await this.send<ExecReply>(
          host,
          { kind: "exec", args, timeoutMs },
          timeoutMs + 15_000,
          this.pickupMs,
        );
      } catch (error) {
        return {
          ok: false,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    };
  }

  close() {
    this.closed = true;
    for (const host of [...this.waiters.keys()]) this.wake(host);
    for (const [id, entry] of [...this.pending]) {
      this.drop(id);
      entry.reject(new Error("服务已关闭"));
    }
  }
}
