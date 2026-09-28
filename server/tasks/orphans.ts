import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StopSignal } from "../platform/plan.ts";
import { FINISHED } from "./state.ts";

/**
 * Atrium 拉起的进程的标记与孤儿清理（t203）。
 *
 * 执行者带环境变量 ATRIUM_SPAWN=<服务标识>/t<任务号>，子孙进程照样继承（执行者起的隔离服务经服务环境白名单
 * 也保留 ATRIUM_*）。父进程退出后被 1 号进程收养的子孙据此仍算 Atrium 的 CPU（server/platform/cpu.ts），
 * 任务早已结束还活着的就是孤儿，巡检里清掉。服务标识是数据目录的摘要：隔离服务与安装版互不认领。
 * 判定是纯函数；查库与结束进程在 OrphanReaper。
 */

export const SPAWN_ENV = "ATRIUM_SPAWN";
/** 任务结束多久后还活着才算孤儿（执行者收尾、合入检查前后可能还有进程在退）。 */
export const ORPHAN_GRACE_MS = 30 * 60_000;
/** 温和结束后多久还在就强制结束。 */
export const ORPHAN_KILL_AFTER_MS = 60_000;

/** 服务标识：数据目录绝对路径的摘要前 12 位。 */
export const spawnOwner = (data: string) =>
  createHash("sha256").update(resolve(data)).digest("hex").slice(0, 12);

export const spawnMark = (owner: string, task: number) => `${owner}/t${task}`;

/** 标记属于本服务时给任务号，否则 null。 */
export function markTask(mark: string, owner: string): number | null {
  const match = /^([0-9a-f]{12})\/t([1-9][0-9]{0,9})$/.exec(mark);
  return match && match[1] === owner ? Number(match[2]) : null;
}

export type Orphan = { pid: number; mark: string };
export type OrphanKill = { pid: number; task: number; signal: StopSignal };

/**
 * 该结束哪些孤儿：标记属于本服务、任务已结束超过 graceMs；先温和结束，
 * 过了 killAfterMs 还在就强制。ended 是已结束任务的结束时刻；tried 是已温和结束过的 pid 与时刻。
 */
export function orphanKills(input: {
  orphans: readonly Orphan[];
  owner: string;
  ended: ReadonlyMap<number, number>;
  now: number;
  tried?: ReadonlyMap<number, number>;
  graceMs?: number;
  killAfterMs?: number;
}): OrphanKill[] {
  const grace = input.graceMs ?? ORPHAN_GRACE_MS;
  const killAfter = input.killAfterMs ?? ORPHAN_KILL_AFTER_MS;
  const kills: OrphanKill[] = [];
  for (const { pid, mark } of input.orphans) {
    const task = markTask(mark, input.owner);
    const endedAt = task === null ? undefined : input.ended.get(task);
    if (task === null || endedAt === undefined || input.now - endedAt < grace)
      continue;
    const triedAt = input.tried?.get(pid);
    if (triedAt === undefined) kills.push({ pid, task, signal: "SIGTERM" });
    else if (input.now - triedAt >= killAfter)
      kills.push({ pid, task, signal: "SIGKILL" });
  }
  return kills;
}

/** 孤儿涉及的本服务任务号（去重，最多 limit 个，查库用）。 */
export function orphanTasks(
  orphans: readonly Orphan[],
  owner: string,
  limit = 100,
): number[] {
  const ids = new Set<number>();
  for (const { mark } of orphans) {
    const task = markTask(mark, owner);
    if (task !== null) ids.add(task);
    if (ids.size >= limit) break;
  }
  return [...ids];
}

/** 巡检时清理孤儿：查这些任务是否已结束，按 orphanKills 结束进程并记日志。 */
export class OrphanReaper {
  private readonly tried = new Map<number, number>();

  constructor(
    private readonly db: DatabaseSync,
    readonly owner: string,
    private readonly kill: (pid: number, signal: StopSignal) => void,
    private readonly log: (line: string) => void = (line) =>
      console.error(line),
  ) {}

  sweep(orphans: readonly Orphan[], now = Date.now()): OrphanKill[] {
    const present = new Set(orphans.map((orphan) => orphan.pid));
    for (const pid of this.tried.keys())
      if (!present.has(pid)) this.tried.delete(pid);
    const ids = orphanTasks(orphans, this.owner);
    if (!ids.length) return [];
    const statuses = [...FINISHED];
    const rows = this.db
      .prepare(
        `SELECT id, ended_at FROM tasks WHERE ended_at IS NOT NULL
           AND status IN (${statuses.map(() => "?").join(",")})
           AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...statuses, ...ids) as { id: number; ended_at: number }[];
    const ended = new Map(rows.map((row) => [row.id, row.ended_at]));
    const kills = orphanKills({
      orphans,
      owner: this.owner,
      ended,
      now,
      tried: this.tried,
    });
    for (const { pid, task, signal } of kills) {
      const minutes = Math.round((now - ended.get(task)!) / 60_000);
      this.log(
        `清理孤儿进程 ${pid}：t${task} 已结束 ${minutes} 分钟${signal === "SIGKILL" ? "，温和结束后仍在，强制结束" : ""}`,
      );
      try {
        this.kill(pid, signal);
      } catch {
        // 已退出。
      }
      if (signal === "SIGTERM") this.tried.set(pid, now);
    }
    return kills;
  }
}
