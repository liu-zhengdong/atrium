import type { Platform } from "../../platform/plan.ts";
import { ADAPTERS, isTool, type Tool } from "../adapters/index.ts";

/**
 * 残留执行者进程（`host clean`，t217 远程也清）：哪些算、认没认准。纯函数，穷举测试；
 * 查库、读进程、结束进程树在 leftovers-reap.ts 与 UrgentLane.clean，远程的由那台的代理照同一判定做。
 *
 * 算残留：账本里记着 pid、任务已不在跑（最近一天内结束或停下）、服务手上也没有这个进程，
 * 而那个 pid 还活着、命令行里有该工具的可执行文件名、启动时刻落在任务建立与结束之间。
 * 后两条防 pid 复用误杀用户自己开的进程：用户后来开的同名工具启动得晚，认不上；认不准就不认。
 */

/** 只看最近这么久结束的任务。 */
export const LEFTOVER_MS = 24 * 60 * 60_000;
/** 一次最多核对这么多个。 */
export const LEFTOVER_LIMIT = 50;
/** 启动时刻的容差：ps 的 etime 精度到秒，远程按指令下发时刻换算时钟还有传递延迟。 */
const START_SLACK_MS = 5_000;

export type LeftoverRow = {
  id: number;
  pid: number | null;
  worker: string | null;
  status: string;
  created_at: number;
  ended_at: number | null;
  updated_at: number;
};

/** 要核对的一个进程：时刻都是毫秒，远程下发时按服务的时钟。 */
export type LeftoverTarget = {
  task: number;
  pid: number;
  tool: Tool;
  created: number;
  ended: number;
};

/** 结束了的一个残留进程树。 */
export type LeftoverKill = { task: number; pid: number; tool: Tool };

/** 执行者 `工具+模型[:强度]` 里的工具；不认识为 null。 */
export function workerTool(worker: string | null): Tool | null {
  const tool = worker?.split(/[+:]/, 1)[0];
  return isTool(tool) ? tool : null;
}

/**
 * 账本行里要核对哪些：不在跑、服务手上没有、pid 合法（大于 1）、工具认识、结束（没结束时刻的按最后更新）在 windowMs 内。
 * 行按最后更新倒序给，取前 limit 个。
 */
export function leftoverTargets(
  rows: readonly LeftoverRow[],
  input: {
    now: number;
    active: ReadonlySet<number>;
    windowMs?: number;
    limit?: number;
  },
): LeftoverTarget[] {
  const windowMs = input.windowMs ?? LEFTOVER_MS;
  const limit = input.limit ?? LEFTOVER_LIMIT;
  const targets: LeftoverTarget[] = [];
  for (const row of rows) {
    if (targets.length >= limit) break;
    if (row.status === "running" || input.active.has(row.id)) continue;
    const { pid } = row;
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 1) continue;
    const tool = workerTool(row.worker);
    if (!tool) continue;
    const ended = row.ended_at ?? row.updated_at;
    if (input.now - ended > windowMs || ended < row.created_at) continue;
    targets.push({ task: row.id, pid, tool, created: row.created_at, ended });
  }
  return targets;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 命令行是不是在跑这个可执行文件：名字作为路径的一段或独立一词出现（`/usr/bin/claude -p`、
 * `node …/@anthropic-ai/claude-code/cli.js`、`C:\…\codex.cmd`），不认嵌在别的词里（`myclaude`、`claudette`）。
 * Windows 不分大小写。
 */
export function runsTool(
  platform: Platform,
  command: string,
  executable: string,
): boolean {
  if (!executable) return false;
  const pattern = new RegExp(
    `(?:^|[\\s"'/\\\\@])${escapeRegExp(executable)}(?=$|[\\s"'/\\\\.-])`,
    platform === "win32" ? "i" : "",
  );
  return pattern.test(command);
}

/**
 * 同一个 pid 的几个候选（pid 在不同任务间复用过）里认哪个：进程还在、启动时刻看得懂且落在任务建立与结束之间、
 * 命令行是那个工具。认不上为 null。
 */
export function leftoverMatch(
  targets: readonly LeftoverTarget[],
  probe: { start: number | null; command: string } | null,
  platform: Platform,
  slackMs = START_SLACK_MS,
): LeftoverTarget | null {
  if (!probe || probe.start === null) return null;
  const start = probe.start;
  for (const target of targets)
    if (
      start >= target.created - slackMs &&
      start <= target.ended + slackMs &&
      runsTool(platform, probe.command, ADAPTERS[target.tool].executable)
    )
      return target;
  return null;
}

/** 服务时钟的时刻换成代理的：指令带着服务下发时的 now，代理按自己收到时的时钟平移。 */
export function shiftTargets(
  targets: readonly LeftoverTarget[],
  by: number,
): LeftoverTarget[] {
  return targets.map((target) => ({
    ...target,
    created: target.created + by,
    ended: target.ended + by,
  }));
}

/** 服务派来的清理清单能不能照做：条数有上限、每条的任务号、pid、工具、时刻都合法。 */
export function targetsRefusal(targets: unknown): string | null {
  if (!Array.isArray(targets)) return "清理清单应为数组";
  if (targets.length > LEFTOVER_LIMIT)
    return `清理清单最多 ${LEFTOVER_LIMIT} 条`;
  for (const target of targets as Partial<LeftoverTarget>[]) {
    if (typeof target !== "object" || target === null) return "清理条目不合法";
    if (!Number.isSafeInteger(target.task) || target.task! < 1)
      return "任务号不合法";
    if (!Number.isSafeInteger(target.pid) || target.pid! <= 1)
      return "进程号不合法";
    if (!isTool(target.tool))
      return `不认识的执行者工具：${String(target.tool)}`;
    if (
      !Number.isFinite(target.created) ||
      !Number.isFinite(target.ended) ||
      target.ended! < target.created!
    )
      return "任务时刻不合法";
  }
  return null;
}

/** 回执里的一条：「t12 pid 4312 claude」。 */
export const killLine = (kill: LeftoverKill) =>
  `t${kill.task} pid ${kill.pid} ${kill.tool}`;
