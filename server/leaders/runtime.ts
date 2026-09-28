import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { contextOf } from "../map/context.ts";
import { killTree, spawnCommand } from "../platform/index.ts";
import { ADAPTERS } from "../tasks/adapters/index.ts";
import type { EventInbox, InboxEvent } from "../tasks/events.ts";
import { parseTaskRef } from "../tasks/ledger.ts";
import { parseWorker } from "../tasks/profiles.ts";
import { decideWake } from "../tasks/wake-rule.ts";
import { workerEnvironment } from "../tasks/worker-env.ts";
import {
  closeStaleWakes,
  markWakeEnd,
  markWakeStart,
  registeredLeaders,
  showLeader,
  wakeFailures,
} from "./model.ts";
import { upstreamRoute } from "./subscriber.ts";
import type { LeaderTokens } from "./tokens.ts";
import { afterWake, leaderPrompt, wakeSummary, type WakeExit } from "./wake.ts";

/**
 * 按事唤醒 leader（服务内一个巡检循环）：某位 leader 有「要处理」事件就攒批（缺省 30 秒），
 * 然后用它登记的执行者组合起一个一次性进程（复用执行者适配器），同一 leader 同时只起一个。
 * 进程带 leader 令牌（ATRIUM_LEADER_TOKEN），命令行据此以 aN 身份连服务，服务端按 guard.ts 判权限。
 * 结束后按 wake.ts 的 afterWake 收尾：处理完、释放稍后重试，或把没确认的事件转交上一层（秘书）。
 */

export type LeaderRunSpec = {
  leader: string;
  worker: string;
  prompt: string;
  /** 进程工作目录与日志目录：<ATRIUM_DATA>/leaders/aN。 */
  dir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
};
export type LeaderRun = (spec: LeaderRunSpec) => Promise<WakeExit>;

export type LeaderWakerOptions = {
  data: string;
  env?: NodeJS.ProcessEnv;
  /** 服务地址，写进 leader 进程的 ATRIUM_LEADER_URL；内存服务（测试）没有。 */
  url?: () => string | undefined;
  batchMs?: number;
  timeoutMs?: number;
  maxFailures?: number;
  pollMs?: number;
  run?: LeaderRun;
  now?: () => number;
  /** 一键停机（server/pause.ts）：不给 leader 为全局暂停；给了看这位 leader 负责的部分。 */
  paused?: (leader?: string) => boolean;
};

export const LEADER_BATCH_MS = 30_000;
export const LEADER_TIMEOUT_MS = 20 * 60_000;
export const LEADER_MAX_FAILURES = 2;

/**
 * 从环境读：ATRIUM_LEADER_BATCH_SECONDS（攒批）、ATRIUM_LEADER_TIMEOUT_MINUTES（单次唤醒上限）。
 */
export function leaderEnvOptions(
  env: NodeJS.ProcessEnv = process.env,
): Partial<LeaderWakerOptions> {
  const options: Partial<LeaderWakerOptions> = {};
  const batch = Number(env.ATRIUM_LEADER_BATCH_SECONDS);
  if (env.ATRIUM_LEADER_BATCH_SECONDS && Number.isFinite(batch) && batch >= 0)
    options.batchMs = batch * 1000;
  const timeout = Number(env.ATRIUM_LEADER_TIMEOUT_MINUTES);
  if (Number.isFinite(timeout) && timeout > 0)
    options.timeoutMs = timeout * 60_000;
  return options;
}

/**
 * 是否用真进程唤醒 leader（t128）：`ATRIUM_LEADER_WAKE=0` 关、`=1` 开；缺省只在默认数据目录的服务上开。
 * 另给 ATRIUM_DATA 的隔离服务（压测、验收）库里有 leader 也不起真的编码 CLI、不耗额度，事件留在收件箱。
 */
export function leaderWakeEnabled(
  setting: string | undefined,
  service: { defaultData: boolean },
): boolean {
  if (setting === "0") return false;
  if (setting === "1") return true;
  return service.defaultData;
}

/** leader 进程的环境：执行者白名单（不带 ATRIUM_WORKER），加上本次唤醒的身份、令牌与服务地址。 */
export function leaderEnvironment(
  base: NodeJS.ProcessEnv,
  input: { leader: string; token: string; url?: string },
): NodeJS.ProcessEnv {
  const env = workerEnvironment(base);
  delete env.ATRIUM_WORKER;
  env.ATRIUM_LEADER = input.leader;
  env.ATRIUM_LEADER_TOKEN = input.token;
  if (input.url) env.ATRIUM_LEADER_URL = input.url;
  return env;
}

/** 缺省的 leader 进程：按执行者组合找适配器拉起，输出写 leaders/aN/log，超时或服务关闭时停整个进程组。 */
export const runLeaderProcess: LeaderRun = async (spec) => {
  const worker = parseWorker(spec.worker);
  const adapter = ADAPTERS[worker.tool];
  mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
  const promptFile = join(spec.dir, "prompt.md");
  writeFileSync(promptFile, spec.prompt, { mode: 0o600 });
  const launch = adapter.build({
    promptFile,
    prompt: spec.prompt,
    cwd: spec.dir,
    model: worker.model ?? adapter.defaultModel,
    effort: worker.effort,
  });
  const logFile = join(spec.dir, "log");
  if (existsSync(logFile)) renameSync(logFile, `${logFile}.prev`);
  writeFileSync(
    logFile,
    `[atrium] ${spec.leader} · ${spec.worker} · ${new Date().toISOString()}\n`,
    { mode: 0o600 },
  );
  const out = openSync(logFile, "a");
  const input = launch.stdin ? openSync(launch.stdin, "r") : "ignore";
  let child;
  try {
    child = spawnCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env ? { ...spec.env, ...launch.env } : spec.env,
      detached: true,
      stdio: [input, out, out],
    });
  } catch (error) {
    appendFileSync(logFile, `[atrium] 拉起失败：${(error as Error).message}\n`);
    return "failed";
  } finally {
    closeSync(out);
    if (typeof input === "number") closeSync(input);
  }
  return new Promise<WakeExit>((resolve) => {
    let timedOut = false;
    const stop = () => {
      if (child.pid) killTree(child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.pid) killTree(child.pid, "SIGKILL");
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    timer.unref();
    spec.signal.addEventListener("abort", stop, { once: true });
    const done = (exit: WakeExit) => {
      clearTimeout(timer);
      spec.signal.removeEventListener("abort", stop);
      resolve(exit);
    };
    child.once("error", () => done("failed"));
    child.once("exit", (code) =>
      done(timedOut ? "timeout" : code === 0 ? "ok" : "failed"),
    );
  });
};

export class LeaderWaker {
  private readonly abort = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  private loopDone: Promise<void> | undefined;

  constructor(
    private readonly db: DatabaseSync,
    private readonly inbox: EventInbox,
    private readonly tokens: LeaderTokens,
    private readonly options: LeaderWakerOptions,
  ) {}

  private get now() {
    return (this.options.now ?? Date.now)();
  }

  start() {
    // 上次服务停掉时没收尾的唤醒：记失败，收回处理中租约，让事件马上重投。
    const stale = this.db
      .prepare(
        "SELECT id FROM org_leaders WHERE wake_status='running' LIMIT 500",
      )
      .all() as { id: number }[];
    closeStaleWakes(this.db, this.now);
    for (const row of stale) this.inbox.releaseAll(`a${row.id}`);
    this.loopDone ??= this.loop();
  }

  async close() {
    this.abort.abort();
    await this.loopDone;
    await Promise.allSettled([...this.running.values()]);
  }

  /** 正在处理的 leader（看板用）。 */
  busy() {
    return new Set(this.running.keys());
  }

  private async loop() {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        this.tick();
      } catch (error) {
        console.warn("leader 唤醒巡检失败；稍后重试", error);
      }
      try {
        await delay(this.options.pollMs ?? 2000, undefined, { signal });
      } catch {
        // 关闭时中断等待。
      }
    }
  }

  /** 巡检一轮：给每位已登记、没在跑的 leader 攒批到点就唤醒。 */
  tick() {
    // 全局暂停：不叫醒任何人；事件留在收件箱，恢复后照常攒批唤醒。
    if (this.options.paused?.()) return;
    for (const leader of registeredLeaders(this.db)) {
      if (this.running.has(leader) || this.abort.signal.aborted) continue;
      if (this.options.paused?.(leader)) continue;
      const events = this.inbox.pending(leader);
      const decision = decideWake({
        events: events.map((e) => ({ id: e.id, queuedAt: e.updated_at })),
        now: this.now,
        batchMs: this.options.batchMs ?? LEADER_BATCH_MS,
        sessionReady: true,
        turnRunning: false,
        consecutiveWakeups: 0,
        maxConsecutiveWakeups: Number.POSITIVE_INFINITY,
      });
      if (decision.kind !== "send") continue;
      const job = this.wake(leader, decision.eventIds)
        .catch((error) =>
          console.warn(`leader ${leader} 唤醒失败；稍后重试`, error),
        )
        .finally(() => this.running.delete(leader));
      this.running.set(leader, job);
    }
  }

  private async wake(leader: string, ids: number[]) {
    const delivered = this.inbox.deliver(leader, ids);
    if (!delivered.length) return;
    let exit: WakeExit = "failed";
    try {
      const view = showLeader(this.db, leader);
      const upstream = upstreamRoute(this.db, leader);
      const digest = this.inbox.digest(leader).items.map((i) => i.summary);
      const prompt = leaderPrompt({
        leader,
        name: view.name,
        nodes: view.nodes.map((n) => ({
          ...n,
          context: contextOf(this.db, Number(n.ref.slice(1)), undefined, [])
            .text,
        })),
        memo: view.memo,
        events: delivered,
        digest,
        upstream:
          upstream.subscriber === "secretary" ? "秘书" : upstream.subscriber,
      });
      markWakeStart(this.db, leader, wakeSummary(delivered), this.now);
      const timeoutMs = this.options.timeoutMs ?? LEADER_TIMEOUT_MS;
      const token = this.tokens.issue(leader, timeoutMs + 60_000);
      try {
        exit = await (this.options.run ?? runLeaderProcess)({
          leader,
          worker: view.worker,
          prompt,
          dir: join(this.options.data, "leaders", leader),
          env: leaderEnvironment(this.options.env ?? process.env, {
            leader,
            token,
            url: this.options.url?.(),
          }),
          timeoutMs,
          signal: this.abort.signal,
        });
      } finally {
        this.tokens.revoke(leader);
      }
    } catch (error) {
      console.warn(`leader ${leader} 拉起失败`, error);
      exit = "failed";
    }
    if (this.abort.signal.aborted) {
      this.inbox.release(leader, delivered);
      markWakeEnd(
        this.db,
        leader,
        "failed",
        wakeFailures(this.db, leader),
        "服务关闭，唤醒中断，事件稍后重投",
        this.now,
      );
      return;
    }
    this.settle(leader, delivered, exit);
  }

  private settle(leader: string, delivered: InboxEvent[], exit: WakeExit) {
    // 处理期间合并进来的新内容不算这次没处理完：重新打开，下次唤醒再送。
    const changed = new Set(this.inbox.reopenChanged(leader, delivered));
    const open = new Set(this.inbox.unacked(delivered.map((e) => e.id)));
    const pending = delivered.filter(
      (e) => open.has(e.id) && !changed.has(e.id),
    );
    const decision = afterWake({
      exit,
      unacked: pending.length,
      failures: wakeFailures(this.db, leader),
      maxFailures: this.options.maxFailures ?? LEADER_MAX_FAILURES,
    });
    if (decision.kind === "done") {
      markWakeEnd(this.db, leader, "done", 0, null, this.now);
      return;
    }
    if (decision.kind === "retry") {
      this.inbox.release(leader, pending);
      markWakeEnd(
        this.db,
        leader,
        "failed",
        decision.failures,
        decision.note,
        this.now,
      );
      return;
    }
    const upstream = upstreamRoute(this.db, leader);
    for (const event of pending)
      this.inbox.publish({
        subscriber: upstream.subscriber,
        taskId: event.task ? parseTaskRef(event.task) : undefined,
        source: "leader",
        kind: event.kind,
        key: `${event.key}:handoff`,
        detail: {
          ...((event.detail ?? {}) as Record<string, unknown>),
          handoff: { from: leader, note: decision.note },
          routed: {
            to: upstream.subscriber,
            why: `${leader} ${decision.note}给 ${upstream.subscriber === "secretary" ? "秘书" : upstream.subscriber}`,
          },
        },
      });
    this.inbox.ack(pending.map((e) => e.id));
    markWakeEnd(this.db, leader, "handed_off", 0, decision.note, this.now);
  }
}
