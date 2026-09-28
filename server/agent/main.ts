import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
} from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { killTree, processAlive } from "../platform/index.ts";
import { ADAPTERS, isTool } from "../tasks/adapters/index.ts";
import { exec as defaultExec, type Exec } from "../tasks/git.ts";
import { hostGate, hostLimits } from "../tasks/dispatch/host-load.ts";
import { ownsPid } from "../tasks/dispatch/recovery.ts";
import { killLine, shiftTargets } from "../tasks/dispatch/leftovers.ts";
import { reapLeftovers } from "../tasks/dispatch/leftovers-reap.ts";
import { machineInfo } from "../hosts/info.ts";
import {
  LOG_CHUNK,
  POLL_WAIT_MS,
  type AgentCommand,
  type Assignment,
  type CleanReply,
  type LaunchAck,
  type PollReply,
} from "../hosts/protocol.ts";
import {
  defaultReaderDeps,
  OK_TTL_MS,
  QuotaReaders,
  readersEnabled,
} from "../quota-readers/index.ts";
import {
  backoffMs,
  type AgentRun,
  type HostLoadReport,
} from "../hosts/state.ts";
import { cloneLock, launchAssignment } from "./launch.ts";
import { commandRefusal, nextChunk } from "./plan.ts";
import { AgentState, type AgentConfig, type RunRecord } from "./state.ts";
import { Problem } from "../problem.ts";

/**
 * 远程主机上的代理（#358 第 1 步，`atrium agent`）：主动连服务（远程机器不用开入站端口），
 * 长轮询领指令，在本机拉起执行者、把日志按字节偏移续传回去、退出后补报结果。
 * 断线期间执行者照跑，日志与退出记在本机，重连后补传；服务重启时自动重连。
 * 代理自己退出不带走执行者（独立进程组），再起来时按记录接着看。
 */

export type AgentOptions = {
  server: string;
  data: string;
  /** 执行者环境的来源（再经白名单过滤）与已装工具的探测。 */
  env: NodeJS.ProcessEnv;
  /** 一次性接入码；已接入过同一个服务时不需要。 */
  code?: string;
  version: string;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  /** 日志续传与进程巡检的间隔，缺省 1 秒。 */
  tickMs?: number;
  exec?: Exec;
  /** 额度读取器（#358 第 2 步）；缺省按环境开关用自带读取器，null 不报额度。 */
  quota?: QuotaReaders | null;
  /** 多久报一次额度；缺省 5 分钟（读取器自己也缓存 5 分钟）。 */
  quotaMs?: number;
};

type Track = {
  record: RunRecord;
  child?: ChildProcess;
  /**
   * 拉起回执已送到服务：之前服务还没记下这一轮，传日志会被当成它不认的。
   * 代理重启后从记录接着看的一律算已送到（服务不认的由重连对账结束）。
   */
  confirmed: boolean;
  /** 服务说这一轮它不认了：不再续传。 */
  abandoned?: boolean;
  /** 上次续传或上报失败的原因（同一原因只记一次日志）。 */
  failure?: string;
};

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeServer(value: string): string {
  const text = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Problem(
      400,
      `--server 应为服务地址，如 http://127.0.0.1:4310（收到：${value}）`,
      "usage",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search
  )
    throw new Problem(
      400,
      `--server 应为 http(s)://主机[:端口]，不带路径（收到：${value}）`,
      "usage",
    );
  return `${url.protocol}//${url.host}`;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class Agent {
  private readonly state: AgentState;
  private config: AgentConfig | null;
  private readonly runs = new Map<number, Track>();
  /** 正在做（含回执还没送到）的指令：长轮询时告诉服务别重发。 */
  private readonly busy = new Set<string>();
  private readonly abort = new AbortController();
  /** 同一克隆上的 git 操作（派活的克隆与 fetch）排成一串。 */
  private readonly withClone = cloneLock();
  private readonly quota: QuotaReaders | null;
  private quotaTimer: NodeJS.Timeout | undefined;
  private readonly exec: Exec;
  private readonly server: string;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private connected = false;
  private stopped = false;
  /** 因为什么停下（令牌失效等）；正常停止为 null。 */
  failure: string | null = null;

  constructor(private readonly options: AgentOptions) {
    this.server = normalizeServer(options.server);
    this.state = new AgentState(options.data);
    this.config = this.state.config();
    this.exec = options.exec ?? defaultExec;
    // 服务进程自己的开关也要看：测试（NODE_TEST_CONTEXT）或显式关掉时不读这台的登录。
    this.quota =
      options.quota !== undefined
        ? options.quota
        : readersEnabled(options.env) && readersEnabled(process.env)
          ? new QuotaReaders(defaultReaderDeps(options.env))
          : null;
  }

  private log(line: string) {
    (this.options.log ?? ((text: string) => console.log(text)))(
      `[${new Date().toTimeString().slice(0, 8)}] ${line}`,
    );
  }

  private get token() {
    return this.config?.server === this.server ? this.config.token : null;
  }

  private async call<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    // 接入时 Authorization 带接入码，之后带主机令牌。
    const token = path === "join" ? this.options.code : this.token;
    const response = await (this.options.fetch ?? fetch)(
      `${this.server}/api/agent/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(timeoutMs),
        ]),
      },
    );
    const text = await response.text();
    let data: unknown = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    if (!response.ok)
      throw new AgentHttpError(
        response.status,
        (data as { error?: string }).error ?? `HTTP ${response.status}`,
      );
    return data as T;
  }

  private info() {
    return machineInfo({
      dataDir: this.options.data,
      version: this.options.version,
      env: this.options.env,
    });
  }

  private load(): HostLoadReport {
    const running = [...this.runs.values()].filter(
      (track) => track.record.exit === undefined,
    ).length;
    const load = loadavg()[0] ?? 0;
    const gate = hostGate({
      running,
      load,
      limits: hostLimits(this.options.env, availableParallelism()).limits,
    });
    return {
      load: Math.round(load * 100) / 100,
      running,
      // 只报太忙；满了由服务按上限自己算。
      busy: !gate.ok && gate.busy ? gate.reason.replace(/^本机/, "这台") : null,
    };
  }

  /** 接入：用接入码换令牌，存进代理数据目录。 */
  private async join() {
    let joined: { host: string; token: string };
    try {
      joined = await this.call<{ host: string; token: string }>(
        "join",
        { info: this.info() },
        30_000,
      );
    } catch (error) {
      throw new Problem(
        error instanceof AgentHttpError && error.status < 500
          ? error.status
          : 503,
        `接入 ${this.server} 失败：${reason(error)}`,
        error instanceof AgentHttpError && error.status === 401
          ? "auth_required"
          : "service_unavailable",
      );
    }
    this.config = {
      server: this.server,
      host: joined.host,
      token: joined.token,
    };
    this.state.saveConfig(this.config);
    this.log(`已接入 ${this.server}，这台是 ${joined.host}`);
  }

  /** 上次代理留下的运行：进程还在的接着看，已不在的按退出情况不明补报。 */
  private async recover() {
    for (const record of this.state.runs((file) =>
      this.log(`运行记录 ${file} 写坏了，已挪开`),
    )) {
      if (record.exit === undefined) {
        const alive =
          isTool(record.tool) &&
          processAlive(record.pid) &&
          (await ownsPid(record.pid, record.tool, this.exec));
        if (!alive) {
          record.exit = null;
          this.state.saveRun(record);
        }
      }
      this.runs.set(record.task, { record, confirmed: true });
      this.log(
        record.exit === undefined
          ? `接着看 ${record.ref}（PID ${record.pid}）`
          : `${record.ref} 已在代理停着时结束，结果待上报`,
      );
    }
  }

  /**
   * 带接入码时先换成主机令牌（已用同一台的令牌接入过就跳过），返回这台的短号；
   * 没接入过又没给接入码时拒绝。装成系统服务（t183）时先在前台做完这一步，服务里不带接入码。
   */
  async enroll(): Promise<string> {
    if (
      this.options.code &&
      (!this.token ||
        !this.config?.host ||
        !this.options.code.startsWith(`${this.config.host}-`))
    )
      await this.join();
    if (!this.token || !this.config)
      throw new Problem(
        400,
        `这台机器还没接入 ${this.server}：在服务那台机器上运行 atrium host add 名称，拿到接入码后 atrium agent --server ${this.server} --token 接入码`,
        "usage",
      );
    return this.config.host;
  }

  /** 跑到 stop() 或令牌失效为止。 */
  async start() {
    await this.enroll();
    await this.recover();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.tickMs ?? 1000,
    );
    this.timer.unref?.();
    if (this.quota) {
      this.quotaTimer = setInterval(
        () => void this.reportQuota(),
        this.options.quotaMs ?? OK_TTL_MS,
      );
      this.quotaTimer.unref?.();
    }
    try {
      await this.loop();
    } finally {
      clearInterval(this.timer);
      clearInterval(this.quotaTimer);
    }
  }

  /** 读这台登录的 CLI 额度并上报：只有额度数字与账号指纹，凭据不出这台。 */
  private async reportQuota() {
    if (!this.quota || !this.connected || this.stopped) return;
    try {
      const outcomes = await this.quota.read();
      await this.call(
        "quota",
        {
          readings: [...outcomes].map(([provider, outcome]) => ({
            provider,
            outcome,
          })),
        },
        30_000,
      );
    } catch {
      // 下一轮再报；额度读不到不影响派活。
    }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  private runSummary(): AgentRun[] {
    return [...this.runs.values()].map((track) => ({
      task: track.record.task,
      run: track.record.run,
      state: track.record.exit === undefined ? "running" : "exited",
    }));
  }

  private async loop() {
    let attempt = 0;
    let lastFailure: string | null = null;
    while (!this.stopped) {
      try {
        const hello = await this.call<{
          host: string;
          name: string;
          stop: { task: number; run: number }[];
        }>("hello", { info: this.info(), runs: this.runSummary() }, 30_000);
        for (const orphan of hello.stop) {
          this.log(`服务已不认 t${orphan.task} 的这一轮，结束它`);
          this.stopRun(orphan.task, orphan.run, "SIGTERM");
          setTimeout(
            () => this.stopRun(orphan.task, orphan.run, "SIGKILL"),
            10_000,
          ).unref();
        }
        this.log(
          attempt || this.connected === false
            ? `已连上 ${this.server}（${hello.host} ${hello.name}）`
            : `已连上 ${this.server}`,
        );
        this.connected = true;
        attempt = 0;
        lastFailure = null;
        void this.tick();
        void this.reportQuota();
        while (!this.stopped) {
          const { commands } = await this.call<PollReply>(
            "poll",
            { load: this.load(), busy: [...this.busy] },
            POLL_WAIT_MS + 20_000,
          );
          for (const command of commands) {
            if (this.busy.has(command.id)) continue;
            this.busy.add(command.id);
            void this.handle(command);
          }
        }
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof AgentHttpError && error.status === 401) {
          this.failure = `服务不认这台主机的令牌（${error.message}）`;
          this.log(this.failure);
          this.stop();
          break;
        }
        const wait = backoffMs(attempt++);
        // 同一原因连续失败只记一次：装成系统服务后服务长时间不在，日志不该每 15 秒长一行。
        const why = `${this.connected ? "与服务断开" : "连不上服务"}：${reason(error)}`;
        if (why !== lastFailure)
          this.log(
            `${why}；${Math.round(wait / 1000)} 秒后重连（原因不变时不再重复记）`,
          );
        lastFailure = why;
        this.connected = false;
        await sleep(wait, this.abort.signal);
      }
    }
  }

  // ---- 指令 ----

  private refused(command: AgentCommand, why: string): unknown {
    switch (command.kind) {
      case "launch":
        return { ok: false, error: why } satisfies LaunchAck;
      case "exec":
        return { ok: false, stdout: "", stderr: why };
      default:
        return { ok: false, error: why };
    }
  }

  private async handle(command: AgentCommand) {
    try {
      const refusal = commandRefusal(
        command,
        process.platform,
        this.options.data,
      );
      let result: unknown;
      if (refusal) {
        this.log(`拒绝服务派来的指令（${command.kind}）：${refusal}`);
        result = this.refused(command, refusal);
      } else
        switch (command.kind) {
          case "launch":
            result = await this.launch(command.assignment);
            break;
          case "stop":
            result = this.stopRun(command.task, command.run, command.signal);
            break;
          case "exec":
            result = await this.exec("git", command.args, {
              timeoutMs: command.timeoutMs,
            });
            break;
          case "clean":
            result = await this.clean(command);
            break;
        }
      await this.reply(command, result);
    } catch (error) {
      await this.reply(command, this.refused(command, reason(error))).catch(
        () => undefined,
      );
    } finally {
      this.busy.delete(command.id);
    }
  }

  /**
   * 清残留执行者进程（t217 `host clean`）：服务给的是所属任务已结束的执行者；时刻按下发时的时钟平移成这台的，
   * 核对还活着、启动时刻与命令行对得上才整树结束。
   */
  private async clean(
    command: Extract<AgentCommand, { kind: "clean" }>,
  ): Promise<CleanReply> {
    const killed = await reapLeftovers(
      shiftTargets(command.targets, Date.now() - command.now),
      { exec: this.exec },
    );
    for (const kill of killed) this.log(`清理残留进程：${killLine(kill)}`);
    return { killed };
  }

  /** 回执送到为止（断线时隔几秒重试）；服务说对不上的拉起，结束刚起的进程。 */
  private async reply(command: AgentCommand, result: unknown) {
    // 拉起的回执送到（或服务明确不要）之后才开始续传这一轮的日志。
    const confirm = () => {
      if (command.kind !== "launch") return;
      const track = this.runs.get(command.assignment.task);
      if (track?.record.run === command.assignment.run) {
        track.confirmed = true;
        void this.tick();
      }
    };
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const answer = await this.call<{
          cancel?: boolean;
          ok?: boolean;
          offset?: number;
        }>("reply", { id: command.id, result }, 30_000);
        confirm();
        if (
          answer.cancel &&
          command.kind === "launch" &&
          (result as LaunchAck).ok
        ) {
          this.log(
            `${command.assignment.ref} 的拉起服务已不再等，结束刚起的进程`,
          );
          this.stopRun(
            command.assignment.task,
            command.assignment.run,
            "SIGKILL",
          );
        }
        return;
      } catch (error) {
        if (error instanceof AgentHttpError && error.status < 500) {
          confirm();
          return;
        }
        await sleep(Math.min(5000, 1000 * (attempt + 1)), this.abort.signal);
      }
    }
  }

  private async launch(assignment: Assignment): Promise<LaunchAck> {
    const old = this.runs.get(assignment.task);
    if (
      old &&
      old.record.exit === undefined &&
      old.record.run !== assignment.run
    ) {
      // 服务要起新的一轮，旧的那轮它已不认。
      killTree(old.record.pid, "SIGKILL");
    }
    try {
      const launched = await launchAssignment(assignment, {
        env: this.options.env,
        run: this.exec,
        withClone: this.withClone,
      });
      const record: RunRecord = {
        task: assignment.task,
        run: assignment.run,
        ref: assignment.ref,
        tool: assignment.tool,
        executable: ADAPTERS[assignment.tool].executable,
        pid: launched.pid,
        logFile: launched.logFile,
        resultFile: launched.resultFile,
        startedAt: Date.now(),
        uploaded: launched.offset,
      };
      // 先落记录再回执：代理这时候挂了，重启后也知道这一轮。
      this.state.saveRun(record);
      const track: Track = {
        record,
        child: launched.child,
        confirmed: false,
      };
      this.runs.set(assignment.task, track);
      launched.child.once("exit", (code, signal) => {
        // 代理停下后运行记录交给下一个代理（它按 pid 看进程还在不在）：这里再写会把
        // 下一个代理已补报、删掉的记录写回来（同一进程里重启代理时；Windows 上 pid
        // 看到进程没了可能早于这个退出事件）。
        if (this.stopped || track.record.exit !== undefined) return;
        track.record.exit = { code, signal };
        this.state.saveRun(track.record);
        this.log(
          `${record.ref} 已退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}）`,
        );
        void this.tick();
      });
      this.log(
        `领到 ${assignment.ref}（${assignment.worker}），PID ${launched.pid}`,
      );
      if (launched.skills?.error)
        this.log(`${assignment.ref} ${launched.skills.error}`);
      return {
        ok: true,
        pid: launched.pid,
        offset: launched.offset,
        launch: launched.launch,
        ...(launched.skills ? { skills: launched.skills } : {}),
      };
    } catch (error) {
      this.log(`${assignment.ref} 拉起失败：${reason(error)}`);
      return { ok: false, error: reason(error) };
    }
  }

  private stopRun(task: number, run: number, signal: "SIGTERM" | "SIGKILL") {
    const track = this.runs.get(task);
    if (!track || track.record.run !== run) return { ok: false };
    if (track.record.exit === undefined) killTree(track.record.pid, signal);
    return { ok: true };
  }

  // ---- 续传与补报 ----

  private async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const track of [...this.runs.values()]) {
        if (this.stopped) return;
        const { record } = track;
        // 代理重启后接着看的进程没有句柄：按 pid 看还在不在。
        if (
          record.exit === undefined &&
          !track.child &&
          !processAlive(record.pid)
        ) {
          record.exit = null;
          this.state.saveRun(record);
          this.log(`${record.ref} 已结束（退出码不可得）`);
        }
        if (!track.confirmed) continue;
        try {
          await this.upload(track);
          if (record.exit !== undefined) await this.report(track);
          track.failure = undefined;
        } catch (error) {
          // 断线由主循环负责重连与提示；别的失败（本机文件、服务拒收）同一原因只记一次。下一轮再试。
          if (!this.connected) return;
          const why = reason(error);
          if (track.failure !== why)
            this.log(`${record.ref} 的日志或结果没传上：${why}；稍后再试`);
          track.failure = why;
          return;
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private size(file: string) {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  private async upload(track: Track) {
    if (track.abandoned) return;
    const { record } = track;
    for (let round = 0; round < 16; round++) {
      const chunk = nextChunk(
        record.uploaded,
        this.size(record.logFile),
        LOG_CHUNK,
      );
      if (!chunk) return;
      const buffer = Buffer.alloc(chunk.length);
      const fd = openSync(record.logFile, "r");
      let read = 0;
      try {
        read = readSync(fd, buffer, 0, chunk.length, chunk.offset);
      } finally {
        closeSync(fd);
      }
      const answer = await this.call<{
        offset?: number;
        done?: boolean;
        wait?: boolean;
      }>(
        "log",
        {
          task: record.task,
          run: record.run,
          offset: chunk.offset,
          data: buffer.subarray(0, read).toString("base64"),
        },
        30_000,
      );
      if (answer.done) {
        track.abandoned = true;
        return;
      }
      if (answer.wait || answer.offset === undefined) return;
      record.uploaded = answer.offset;
      this.state.saveRun(record);
    }
  }

  private lastMessage(record: RunRecord) {
    try {
      if (!existsSync(record.resultFile)) return undefined;
      if (statSync(record.resultFile).mtimeMs < record.startedAt)
        return undefined;
      return readFileSync(record.resultFile, "utf8").slice(0, 512 * 1024);
    } catch {
      return undefined;
    }
  }

  private async report(track: Track) {
    const { record } = track;
    // 先删记录文件再从内存里去掉：删不掉（Windows 上文件被短暂锁住）就留到下一轮再来。
    const done = () => {
      this.state.removeRun(record.task);
      this.runs.delete(record.task);
    };
    if (track.abandoned) return done();
    const size = this.size(record.logFile);
    if (record.uploaded < size) return;
    const message = this.lastMessage(record);
    const answer = await this.call<{
      ok: boolean;
      offset?: number;
      retry?: boolean;
      ignored?: boolean;
    }>(
      "exit",
      {
        task: record.task,
        run: record.run,
        exit: record.exit ?? null,
        size,
        ...(message !== undefined ? { last_message: message } : {}),
      },
      30_000,
    );
    if (answer.ok) {
      if (!answer.ignored) this.log(`${record.ref} 的结果已上报`);
      return done();
    }
    if (answer.offset !== undefined) {
      record.uploaded = answer.offset;
      this.state.saveRun(record);
    }
  }
}

function reason(error: unknown) {
  if (error instanceof AgentHttpError)
    return `${error.status} ${error.message}`;
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  if (cause) return cause;
  return error instanceof Error ? error.message : String(error);
}
