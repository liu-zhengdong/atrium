import {
  killTree,
  parseProcessProbe,
  processAlive,
  processProbeInvocation,
  type Platform,
} from "../platform/index.ts";
import type { Exec } from "./git.ts";
import {
  leftoverMatch,
  type LeftoverKill,
  type LeftoverTarget,
} from "./leftovers.ts";

/**
 * 在这台机器上核对并结束残留执行者进程树（t217）：服务清本机、代理清远程主机都走这里。
 * 判定在 leftovers.ts；这里只看进程在不在、读启动时刻与命令行、认上了用平台层 killTree 整树强制结束
 * （Unix 结束进程组，Windows `taskkill /T /F`，t167）。
 */
export type ReapDeps = {
  exec: Exec;
  platform?: Platform;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  now?: () => number;
  /** 自己的 pid：无论如何不结束。 */
  self?: number;
};

export async function reapLeftovers(
  targets: readonly LeftoverTarget[],
  deps: ReapDeps,
): Promise<LeftoverKill[]> {
  const platform = deps.platform ?? process.platform;
  const alive = deps.alive ?? processAlive;
  const kill = deps.kill ?? ((pid: number) => killTree(pid, "SIGKILL"));
  const now = deps.now ?? Date.now;
  const self = deps.self ?? process.pid;
  const byPid = new Map<number, LeftoverTarget[]>();
  for (const target of targets) {
    const list = byPid.get(target.pid);
    if (list) list.push(target);
    else byPid.set(target.pid, [target]);
  }
  const killed: LeftoverKill[] = [];
  for (const [pid, list] of byPid) {
    if (pid === self || !alive(pid)) continue;
    const call = processProbeInvocation(platform, pid);
    const read = await deps.exec(call.command, call.args, {
      timeoutMs: 10_000,
    });
    if (!read.ok) continue;
    const target = leftoverMatch(
      list,
      parseProcessProbe(platform, read.stdout, now()),
      platform,
    );
    if (!target) continue;
    try {
      kill(pid);
    } catch {
      // 刚退出。
      continue;
    }
    killed.push({ task: target.task, pid, tool: target.tool });
  }
  return killed;
}
