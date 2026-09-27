import { setTimeout as delay } from "node:timers/promises";
import type { EventInbox } from "./events.ts";
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
import { decideWake, nextWakeCount } from "./wake-rule.ts";
import type { ChildProcessByStdio } from "node:child_process";
import type { Writable } from "node:stream";
import { killTree, spawnCommand } from "../platform/index.ts";
import { serviceEnvironment } from "../service-env.ts";

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
  let env = serviceEnvironment().env;
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

/** Service-side one-shot event consumer. A UI lock wins whenever it is open. */
export class SecretaryFallback {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly inbox: EventInbox,
    private readonly data: string,
    private readonly options: {
      batchMs?: number;
      maxWakeups?: number;
      runTurn?: ResumeRun;
      now?: () => number;
    } = {},
  ) {}

  start() {
    this.running ??= this.loop();
  }

  async close() {
    this.abort.abort();
    await this.running;
  }

  private async pause(ms: number) {
    try {
      await delay(ms, undefined, { signal: this.abort.signal });
    } catch {
      // Shutdown interrupts the delay.
    }
  }

  private async loop() {
    const signal = this.abort.signal;
    const now = this.options.now ?? Date.now;
    const batchMs = this.options.batchMs ?? 2000;
    const maxWakeups = this.options.maxWakeups ?? 10;
    while (!signal.aborted) {
      try {
        if (!loadSecretarySession(this.data)) {
          await this.pause(5000);
          continue;
        }
        const { events, restarting } = await this.inbox.wait(
          "secretary",
          30,
          signal,
          {
            peek: true,
            trackOnline: false,
          },
        );
        if (signal.aborted || restarting) break;
        const decision = decideWake({
          events: events.map((event) => ({
            id: event.id,
            queuedAt: event.updated_at,
          })),
          now: now(),
          batchMs,
          sessionReady: true,
          turnRunning: false,
          consecutiveWakeups: wakeCount(this.data),
          maxConsecutiveWakeups: maxWakeups,
        });
        if (decision.kind === "empty") continue;
        if (decision.kind === "batching") {
          await this.pause(Math.max(0, decision.readyAt - now()));
          continue;
        }
        if (decision.kind === "limit") {
          await this.pause(5000);
          continue;
        }
        if (decision.kind !== "send") continue;
        const lock = claimSecretary(this.data);
        if (!lock) {
          await this.pause(1000);
          continue;
        }
        let failed = false;
        try {
          const session = loadSecretarySession(this.data);
          if (!session) continue;
          const delivered = this.inbox.deliver("secretary", decision.eventIds);
          if (!delivered.length) continue;
          let ok = false;
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
          }
          if (ok && !signal.aborted)
            saveWakeCount(
              this.data,
              nextWakeCount(wakeCount(this.data), "delivered"),
            );
          else {
            this.inbox.release("secretary", delivered);
            failed = true;
          }
        } finally {
          lock.release();
        }
        if (failed && !signal.aborted) await this.pause(5000);
      } catch {
        if (!signal.aborted) {
          console.warn("秘书后台恢复暂时失败；稍后重试");
          await this.pause(5000);
        }
      }
    }
  }
}
