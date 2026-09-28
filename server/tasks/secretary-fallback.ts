import { setTimeout as delay } from "node:timers/promises";
import type { EventInbox, InboxEvent } from "./events.ts";
import { claimSecretary } from "./secretary-lock.ts";
import {
  opencodeEnvironment,
  prepareOpencodeHome,
  secretaryOpencodeHome,
  userOpencodeData,
} from "../../shared/opencode-home.ts";
import {
  loadSecretarySession,
  saveWakeCount,
  wakeCount,
  type SecretarySession,
} from "./secretary-session.ts";
import { wakePrompt } from "./wake-prompt.ts";
import { nextWakeCount } from "./wake-rule.ts";
import {
  UNATTENDED_MS,
  WAKE_FAILED,
  watchDecision,
} from "./secretary-watch.ts";
import type { ChildProcessByStdio } from "node:child_process";
import type { Writable } from "node:stream";
import { killTree, spawnCommand } from "../platform/index.ts";
import { serviceEnvironment } from "../service-env.ts";

const SUBSCRIBER = "secretary";
/** 有事时多久再看一眼在不在听；空闲时只挂一个等事件的 peek。 */
const CHECK_MS = 30_000;

export type ResumeRun = (
  session: SecretarySession,
  prompt: string,
  signal: AbortSignal,
  child: (pid: number) => void,
  data: string,
) => Promise<boolean>;

/** Explicit session IDs prevent resuming another user's most recent turn. */
export function resumeCommand(session: SecretarySession, prompt: string) {
  if (session.tool === "codex") {
    if (!/^[0-9a-f-]{36}$/i.test(session.sessionId))
      throw new Error("codex 秘书会话编号无效");
    return {
      command: "codex",
      args: [
        "exec",
        "resume",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'approval_policy="never"',
        session.sessionId,
        "-",
      ],
      stdin: prompt,
    };
  }
  if (!/^ses_[A-Za-z0-9]+$/.test(session.sessionId))
    throw new Error("opencode 秘书会话编号无效");
  return {
    command: "opencode",
    args: ["run", "--session", session.sessionId, "--auto", "--", prompt],
    stdin: undefined,
  };
}

export const resumeTurn: ResumeRun = (
  session,
  prompt,
  signal,
  childPid,
  data,
) => {
  const spec = resumeCommand(session, prompt);
  // 秘书会话里的 atrium 命令缺省以秘书名义写（cli/worker-guard.ts defaultActor）。
  let env: NodeJS.ProcessEnv = {
    ...serviceEnvironment().env,
    ATRIUM_AS: "secretary",
  };
  if (session.tool === "opencode") {
    const home = secretaryOpencodeHome(data);
    const report = prepareOpencodeHome(home, userOpencodeData(env));
    for (const problem of report.problems) console.warn(`[atrium] ${problem}`);
    env = opencodeEnvironment(env, { home });
  }
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<Writable, null, null>;
    try {
      child = spawnCommand(spec.command, spec.args, {
        cwd: session.cwd,
        env,
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      }) as ChildProcessByStdio<Writable, null, null>;
    } catch {
      resolve(false);
      return;
    }
    if (child.pid) childPid(child.pid);
    child.stdin.on("error", () => {});
    if (spec.stdin) child.stdin.end(spec.stdin);
    else child.stdin.end();
    let timedOut = false;
    const signalChild = (signal: "SIGTERM" | "SIGKILL") => {
      if (child.pid) killTree(child.pid, signal);
      else child.kill(signal);
    };
    let force: NodeJS.Timeout | undefined;
    const stop = () => {
      signalChild("SIGTERM");
      force ??= setTimeout(() => signalChild("SIGKILL"), 5000);
      force.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, 15 * 60_000);
    timeout.unref();
    child.once("error", () => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      resolve(code === 0 && !signal.aborted && !timedOut);
    });
  });
};

/** 叫不起来时推给用户的一条（接推送到手机，t185）；同一段没人管只推一次。 */
export type SecretaryAlert = { key: string; pending: number; reason: string };

/**
 * 服务端后台兜底（t242）：有要处理的事件、没有秘书挂着 wait 满 graceMs，就接着 atrium chat 开过的秘书会话
 * 在后台跑一轮；界面持锁时让界面处理。叫不起来（没有会话、连续叫醒到上限、跑失败）就推给用户，
 * 状态栏按 status() 标红。判定在 secretary-watch.ts。
 */
export class SecretaryFallback {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  private waking = false;
  private unreachable: string | null = null;
  private retryAt: number | null = null;
  private alerted: string | null = null;

  constructor(
    private readonly inbox: EventInbox,
    private readonly data: string,
    private readonly options: {
      graceMs?: number;
      maxWakeups?: number;
      runTurn?: ResumeRun;
      now?: () => number;
      alert?: (alert: SecretaryAlert) => void;
      /** 有事时多久再看一眼在不在听（毫秒），测试缩短。 */
      checkMs?: number;
    } = {},
  ) {}

  get graceMs() {
    return this.options.graceMs ?? UNATTENDED_MS;
  }

  start() {
    this.running ??= this.loop();
  }

  async close() {
    this.abort.abort();
    await this.running;
  }

  /** 状态栏与 top：后台是否正在叫醒秘书处理、叫不起来的原因。 */
  status() {
    return { waking: this.waking, unreachable: this.unreachable };
  }

  private async pause(ms: number) {
    try {
      await delay(ms, undefined, { signal: this.abort.signal });
    } catch {
      // Shutdown interrupts the delay.
    }
  }

  /** 没人管、叫不起来：记原因，同一段（按最早一条事件）只推一次。 */
  private giveUp(reason: string, events: readonly InboxEvent[]) {
    this.unreachable = reason;
    const key = `secretary-away:${events[0]!.id}`;
    if (this.alerted === key) return;
    this.alerted = key;
    console.warn(`秘书没在听，${events.length} 件要处理的事没人管：${reason}`);
    try {
      this.options.alert?.({ key, pending: events.length, reason });
    } catch (error) {
      console.warn(`推送「秘书没在听」出错：${String(error)}`);
    }
  }

  private async loop() {
    const signal = this.abort.signal;
    const now = this.options.now ?? Date.now;
    const maxWakeups = this.options.maxWakeups ?? 10;
    const checkMs = this.options.checkMs ?? CHECK_MS;
    while (!signal.aborted) {
      try {
        const events = this.inbox.pending(SUBSCRIBER);
        const decision = watchDecision({
          now: now(),
          presence: this.inbox.presence(SUBSCRIBER),
          oldest: events.length
            ? Math.min(...events.map((event) => event.updated_at))
            : null,
          graceMs: this.graceMs,
          session: loadSecretarySession(this.data) !== undefined,
          limit: wakeCount(this.data) >= maxWakeups,
          retryAt: this.retryAt,
        });
        if (decision.kind === "quiet" || decision.kind === "listening") {
          this.unreachable = null;
          this.retryAt = null;
          this.alerted = null;
        }
        if (decision.kind === "quiet") {
          // 有新事件就醒；只看不取，也不算在听。
          const { restarting } = await this.inbox.wait(SUBSCRIBER, 30, signal, {
            peek: true,
            trackOnline: false,
          });
          if (restarting) break;
          continue;
        }
        if (decision.kind === "listening") {
          await this.pause(checkMs);
          continue;
        }
        if (decision.kind === "wait") {
          await this.pause(Math.min(checkMs, Math.max(0, decision.at - now())));
          continue;
        }
        if (decision.kind === "unreachable") {
          this.giveUp(decision.reason, events);
          await this.pause(
            this.retryAt === null
              ? checkMs
              : Math.min(checkMs, Math.max(0, this.retryAt - now())),
          );
          continue;
        }
        const lock = claimSecretary(this.data);
        if (!lock) {
          // atrium chat 界面开着：由界面送入。
          await this.pause(1000);
          continue;
        }
        let failed = false;
        try {
          const session = loadSecretarySession(this.data);
          if (!session) continue;
          const delivered = this.inbox.deliver(
            SUBSCRIBER,
            events.map((event) => event.id),
          );
          if (!delivered.length) continue;
          let ok = false;
          this.waking = true;
          try {
            ok = await (this.options.runTurn ?? resumeTurn)(
              session,
              wakePrompt(delivered),
              signal,
              (pid) => lock.child(pid),
              this.data,
            );
          } catch {
            console.warn("秘书后台恢复失败；稍后重试");
          } finally {
            this.waking = false;
          }
          if (ok && !signal.aborted) {
            saveWakeCount(
              this.data,
              nextWakeCount(wakeCount(this.data), "delivered"),
            );
            this.unreachable = null;
            this.retryAt = null;
          } else {
            this.inbox.release(SUBSCRIBER, delivered);
            failed = true;
          }
        } finally {
          lock.release();
        }
        if (failed && !signal.aborted) {
          this.retryAt = now() + this.graceMs;
          this.giveUp(WAKE_FAILED, events);
        }
      } catch {
        if (!signal.aborted) {
          console.warn("秘书后台恢复暂时失败；稍后重试");
          await this.pause(5000);
        }
      }
    }
  }
}
