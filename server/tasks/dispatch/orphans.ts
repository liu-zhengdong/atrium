import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readCwd, readEnv, type SpawnMark } from "../../platform/cpu.ts";
import { markSource, type ProcCpu } from "../../platform/cpu-plan.ts";
import type { Platform, StopSignal } from "../../platform/plan.ts";
import { worktreePlan } from "./prepare.ts";
import { FINISHED } from "../ledger/state.ts";

/**
 * 认出 Atrium 拉起的进程与孤儿清理（t203）。
 *
 * 认法按平台（cpu-plan.ts markSource）：
 * - Linux：执行者带环境变量 ATRIUM_SPAWN=<服务标识>/t<任务号>，子孙照样继承（执行者起的隔离服务经服务环境
 *   白名单也保留 ATRIUM_*），读 /proc/<pid>/environ 就认得出。服务标识是数据目录的摘要：隔离服务与安装版互不认领。
 * - macOS：ps 读不到进程环境，改看被 1 号收养的进程的工作目录：落在本服务某个本机任务的工作树里，
 *   且启动时刻在任务创建之后、结束之前，才算这个任务的（同一工作树有任务在跑就算在跑的那个，不清）。
 *   工作树目录名带 `-t<任务号>-`（prepare.ts worktreePlan），按号查任务；结束后清理过、账本里 worktree
 *   已置空的，按仓库、任务号与标题还原路径。
 *   执行者的 shell 各自开进程组，不能按进程组认。
 * - Windows：不认。
 * 认出来的父进程退出后仍算 Atrium 的 CPU（server/platform/cpu.ts），任务早已结束还活着的就是孤儿，
 * 巡检里清掉；认不准就不认，宁可漏清不可错杀。判定是纯函数；查库与结束进程在 recognizer、OrphanReaper。
 */

export const SPAWN_ENV = "ATRIUM_SPAWN";
/** 任务结束多久后还活着才算孤儿（执行者收尾、合入检查前后可能还有进程在退）。 */
const ORPHAN_GRACE_MS = 30 * 60_000;
/** 温和结束后多久还在就强制结束。 */
const ORPHAN_KILL_AFTER_MS = 60_000;

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

/** 同一路径的两种写法：macOS 的 /var、/tmp、/etc 是 /private 下的软链接，lsof 给的是真实路径。 */
function plainPath(path: string) {
  return path.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
}

/** 工作目录本身与各级上级目录（不含根与一级目录），统一成不带 /private 的写法。 */
function cwdAncestors(cwd: string): string[] {
  const parts = plainPath(cwd).split("/").filter(Boolean);
  const paths: string[] = [];
  for (let depth = parts.length; depth >= 2; depth--)
    paths.push(`/${parts.slice(0, depth).join("/")}`);
  return paths;
}

/** 工作目录各级目录名里的 `-t<任务号>-`（工作树命名见 prepare.ts worktreePlan）：候选任务号，去重，最多 limit 个。 */
export function cwdTaskIds(cwds: Iterable<string>, limit = 500): number[] {
  const ids = new Set<number>();
  for (const cwd of cwds)
    for (const segment of plainPath(cwd).split("/"))
      for (const match of segment.matchAll(/-t([1-9][0-9]{0,9})(?=-)/g)) {
        if (ids.size >= limit) return [...ids];
        ids.add(Number(match[1]));
      }
  return [...ids];
}

/** 本机任务的工作树：ended 是已结束任务的结束时刻，没结束为 null。 */
export type TaskWorktree = {
  id: number;
  worktree: string;
  created: number;
  ended: number | null;
};

/**
 * 工作目录在 cwd、启动于 start 的进程算哪个任务的；认不准为 null。
 * 按工作目录往上找第一层是某些任务工作树的目录：其中有没结束的任务就算它（在跑，不清）；
 * 否则取启动时刻落在任务创建与结束之间的、结束最晚的那个。
 */
export function cwdTask(
  proc: { cwd: string; start: number },
  byPath: ReadonlyMap<string, readonly TaskWorktree[]>,
): number | null {
  for (const path of cwdAncestors(proc.cwd)) {
    const tasks = byPath.get(path);
    if (!tasks?.length) continue;
    const running = tasks.find((task) => task.ended === null);
    if (running) return running.id;
    let best: TaskWorktree | null = null;
    for (const task of tasks)
      if (
        proc.start >= task.created &&
        proc.start <= task.ended! &&
        (!best || task.ended! > best.ended!)
      )
        best = task;
    return best?.id ?? null;
  }
  return null;
}

/** 工作树行按统一写法的路径分组。 */
export function worktreesByPath(
  rows: readonly TaskWorktree[],
): Map<string, TaskWorktree[]> {
  const byPath = new Map<string, TaskWorktree[]>();
  for (const row of rows) {
    const path = plainPath(row.worktree.replace(/\/+$/, ""));
    const list = byPath.get(path);
    if (list) list.push(row);
    else byPath.set(path, [row]);
  }
  return byPath;
}

/** 这些本机任务的工作树：账本里记着的，或清理后按仓库、任务号、标题还原的（分批参数化查询）。 */
function taskWorktrees(db: DatabaseSync, ids: readonly number[]) {
  const statuses = [...FINISHED];
  const rows: TaskWorktree[] = [];
  for (let at = 0; at < ids.length; at += 500) {
    const batch = ids.slice(at, at + 500);
    const found = db
      .prepare(
        `SELECT id, repo, title, role, worktree, created_at, ended_at,
           status IN (${statuses.map(() => "?").join(",")}) AS finished
         FROM tasks WHERE host_id IS NULL
           AND id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(...statuses, ...batch) as {
      id: number;
      repo: string | null;
      title: string;
      role: string | null;
      worktree: string | null;
      created_at: number;
      ended_at: number | null;
      finished: number;
    }[];
    for (const row of found) {
      let worktree = row.worktree;
      if (!worktree && row.repo)
        try {
          worktree = worktreePlan(
            row.repo,
            row.id,
            row.title,
            row.role ?? undefined,
          ).path;
        } catch {
          // 仓库路径不合法：认不了。
        }
      if (worktree)
        rows.push({
          id: row.id,
          worktree,
          created: row.created_at,
          ended: row.finished && row.ended_at !== null ? row.ended_at : null,
        });
    }
  }
  return rows;
}

/**
 * 本服务怎么认自己拉起的进程（给 ProcessCpu）；平台认不了为 undefined。
 * macOS 只看被 1 号收养、知道启动时刻的进程，其余查过即不是（父进程变了会重查）。
 */
export function recognizer(
  db: DatabaseSync,
  owner: string,
  io: {
    platform?: Platform;
    readEnv?: typeof readEnv;
    readCwd?: typeof readCwd;
  } = {},
): SpawnMark | undefined {
  const platform = io.platform ?? process.platform;
  const source = markSource(platform);
  const prefix = `${owner}/`;
  if (source === "env")
    return {
      prefix,
      recognize: async (procs) => {
        const pids = procs.map((proc) => proc.pid);
        const found = await (io.readEnv ?? readEnv)(pids, SPAWN_ENV, platform);
        if (!found) return null;
        return new Map(pids.map((pid) => [pid, found.get(pid) ?? null]));
      },
    };
  if (source !== "cwd") return undefined;
  const wants = (proc: ProcCpu) => proc.ppid === 1 && proc.start !== undefined;
  return {
    prefix,
    wants,
    recognize: async (procs: readonly ProcCpu[]) => {
      const result = new Map<number, string | null>(
        procs.map((proc) => [proc.pid, null]),
      );
      const orphans = procs.filter(wants);
      if (!orphans.length) return result;
      const cwds = await (io.readCwd ?? readCwd)(
        orphans.map((proc) => proc.pid),
        platform,
      );
      if (!cwds) return null;
      const byPath = worktreesByPath(
        taskWorktrees(db, cwdTaskIds(cwds.values())),
      );
      for (const proc of orphans) {
        const cwd = cwds.get(proc.pid);
        const task =
          cwd === undefined
            ? null
            : cwdTask({ cwd, start: proc.start! }, byPath);
        if (task !== null) result.set(proc.pid, spawnMark(owner, task));
      }
      return result;
    },
  };
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
