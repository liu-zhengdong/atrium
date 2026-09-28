import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { exec as defaultExec, type Exec } from "./git.ts";
import { countSteps } from "./summary.ts";
import { parseLine } from "./json-log.ts";

/**
 * 执行者卡死检测（#262）。判定是纯函数 judge；进展信号由 ProgressProbe 采样：
 * 日志增长、工作目录文件变化、结构化日志里的步骤事件（json_events）。
 */

export type WatchLimits = { startupMs: number; idleMs: number };

export type WatchState = {
  startedAt: number;
  /** 最近一次看到进展的时间；启动后还没有任何进展时为 null。 */
  lastProgressAt: number | null;
};

export type Judgement =
  | { kind: "ok" }
  | { kind: "stalled"; reason: string }
  | { kind: "idle"; reason: string };

const minutes = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.round(ms / 1000)} 秒`;

export function judge(
  state: WatchState,
  limits: WatchLimits,
  now: number,
): Judgement {
  if (state.lastProgressAt === null) {
    if (now - state.startedAt >= limits.startupMs)
      return {
        kind: "stalled",
        reason: `启动后 ${minutes(limits.startupMs)}没有任何进展信号（日志不增长、工作目录无变化、无步骤事件），判定卡死`,
      };
    return { kind: "ok" };
  }
  if (now - state.lastProgressAt >= limits.idleMs)
    return {
      kind: "idle",
      reason: `连续 ${minutes(limits.idleMs)}没有进展信号，判定受阻`,
    };
  return { kind: "ok" };
}

/** 最后的 Claude result 已出现，且其后没有新一轮用户或助手消息。 */
export function finalClaudeResult(log: string): "clean" | "error" | undefined {
  let result: "clean" | "error" | undefined;
  for (const line of log.split("\n")) {
    if (line.startsWith("[atrium] ")) {
      result = undefined;
      continue;
    }
    const event = parseLine(line);
    if (!event) continue;
    if (event.type === "result")
      result =
        event.is_error === false && event.stop_reason === "end_turn"
          ? "clean"
          : "error";
    else if (
      event.type !== "command_lifecycle" &&
      !(event.type === "system" && event.subtype === "stdin_closed")
    )
      result = undefined;
  }
  return result;
}

/** 适配器缺省值，档案 limits.startup_minutes / idle_minutes 写了就用档案的。 */
export function watchLimits(
  defaults: { startupMinutes: number; idleMinutes: number },
  limits: Record<string, number> = {},
): WatchLimits {
  const pick = (value: number | undefined, fallback: number) =>
    value !== undefined && value > 0 ? value : fallback;
  return {
    startupMs: pick(limits.startup_minutes, defaults.startupMinutes) * 60_000,
    idleMs: pick(limits.idle_minutes, defaults.idleMinutes) * 60_000,
  };
}

export type Sample = { logSize: number; fingerprint: string; steps: number };

const SKIP = new Set([".git", "node_modules", "dist", ".atrium"]);
const WALK_MAX = 5000;

/** 非 git 目录：有界遍历，取条目数与最新修改时间作指纹。 */
async function walkFingerprint(dir: string) {
  let count = 0;
  let newest = 0;
  const queue = [dir];
  while (queue.length && count < WALK_MAX) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(current, entry.name);
      count++;
      try {
        newest = Math.max(newest, (await stat(path)).mtimeMs);
      } catch {
        // 遍历途中被删，忽略。
      }
      if (entry.isDirectory()) queue.push(path);
      if (count >= WALK_MAX) break;
    }
  }
  return `${count}:${newest}`;
}

/** 数步骤时每块读多少字节；也是单行日志的上限，更长的行跳过不计。 */
export const STEP_CHUNK = 1024 * 1024;
const STEP_CHUNKS = 16;

export class ProgressProbe {
  private offset = 0;
  private steps = 0;
  /** 正在跳过一行超长日志的剩余部分。 */
  private skipping = false;
  private last: Sample | undefined;

  constructor(
    private readonly logFile: string,
    private readonly cwd: string,
    private readonly git: boolean,
    private readonly jsonEvents: boolean,
    private readonly run: Exec = defaultExec,
  ) {}

  /** 以当前状态为基线（拉起前写进日志的抬头不算进展）。 */
  async baseline() {
    this.last = await this.sample();
  }

  private async fingerprint() {
    if (!this.git) return walkFingerprint(this.cwd);
    // 执行者同时在这个工作树里 git add / commit；status 默认会顺手刷新索引、占 index.lock，
    // 让执行者的提交撞锁失败，所以只读探测一律不拿可选锁。
    const [status, head] = await Promise.all([
      this.run(
        "git",
        [
          "--no-optional-locks",
          "-C",
          this.cwd,
          "status",
          "--porcelain",
          "-uall",
        ],
        { timeoutMs: 15_000 },
      ),
      this.run("git", ["-C", this.cwd, "rev-parse", "HEAD"], {
        timeoutMs: 5_000,
      }),
    ]);
    return createHash("sha256")
      .update(status.stdout)
      .update(head.stdout)
      .digest("hex");
  }

  private async readSteps(size: number) {
    if (!this.jsonEvents || size <= this.offset) return;
    // 按块读新增部分，每块最多 1 MiB、每次采样最多 STEP_CHUNKS 块；跨界的半行留到下次。
    // 整块都没有换行说明这一行超长：丢掉它（不计步），跳到下一个换行后接着数，内存不随行长增长。
    const handle = await open(this.logFile, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size - this.offset, STEP_CHUNK));
      for (let round = 0; round < STEP_CHUNKS && this.offset < size; round++) {
        const length = Math.min(size - this.offset, buffer.length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (!bytesRead) return;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        if (this.skipping) {
          const newline = chunk.indexOf(0x0a);
          if (newline < 0) {
            this.offset += bytesRead;
            continue;
          }
          this.skipping = false;
          start = newline + 1;
        }
        const cut = chunk.lastIndexOf(0x0a);
        if (cut < start) {
          this.offset += start;
          if (start > 0 || bytesRead < STEP_CHUNK) return;
          this.skipping = true;
          this.offset += bytesRead;
          continue;
        }
        this.steps += countSteps(chunk.toString("utf8", start, cut));
        this.offset += cut + 1;
      }
    } finally {
      await handle.close();
    }
  }

  async sample(): Promise<Sample> {
    let logSize = 0;
    try {
      logSize = (await stat(this.logFile)).size;
    } catch {
      logSize = 0;
    }
    await this.readSteps(logSize).catch(() => undefined);
    return {
      logSize,
      fingerprint: await this.fingerprint().catch(() => ""),
      steps: this.steps,
    };
  }

  /** 与上次采样比较，返回这次看到的进展信号（空数组表示没有进展）。 */
  async poll(): Promise<{ signals: string[]; sample: Sample }> {
    const next = await this.sample();
    const prev = this.last;
    this.last = next;
    if (!prev) return { signals: [], sample: next };
    const signals: string[] = [];
    if (next.logSize > prev.logSize) signals.push("log_growth");
    if (next.fingerprint && next.fingerprint !== prev.fingerprint)
      signals.push("worktree_change");
    if (next.steps > prev.steps) signals.push("json_events");
    return { signals, sample: next };
  }
}
