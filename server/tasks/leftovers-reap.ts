import {
  killTree,
  parseProcessProbe,
  processAlive,
  processProbeInvocation,
  type Platform,
} from "../platform/index.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Exec } from "./git.ts";
import { noteTask } from "./ledger.ts";
import { taskRef } from "./ledger-model.ts";
import { hostRef, LOCAL_HOST } from "../hosts/state.ts";
import {
  killLine,
  LEFTOVER_LIMIT,
  LEFTOVER_MS,
  leftoverMatch,
  leftoverTargets,
  type LeftoverKill,
  type LeftoverRow,
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

/** 停止事件（stop_requested）里记的发起者与缘由（t239）：谁停的、为什么，事后查得到。 */
export type StopNote = { by: string; reason: string };

/**
 * 清理一台主机（t217 `host clean`）：停掉 Atrium 在那台跑的执行者；再结束最近一天里已结束任务仍活着的执行者进程树
 * （本机由服务 reapLocal、远程由那台的代理按同一判定核对工具与启动时刻）。结束的逐条记进所属任务的 leftover_killed 事件。
 */
export async function cleanHost(
  db: DatabaseSync,
  host: number,
  deps: {
    /** 服务手里在跑、没在停的执行者：任务与主机。 */
    running: readonly { id: number; host: number }[];
    /** 服务手里还有进程的任务（不当残留）。 */
    active: ReadonlySet<number>;
    stop: (ref: string, note: StopNote) => unknown;
    reapLocal: (targets: readonly LeftoverTarget[]) => Promise<LeftoverKill[]>;
    remote: (
      host: number,
      targets: readonly LeftoverTarget[],
    ) => Promise<LeftoverKill[]>;
    /** 发起者（u1、secretary 等），记进停止与清理事件。 */
    by?: string;
    now?: number;
  },
) {
  const ref = hostRef(host);
  const now = deps.now ?? Date.now();
  const note: StopNote = {
    by: deps.by ?? "host clean",
    reason: `host clean ${ref}`,
  };
  const stopped: string[] = [];
  for (const run of deps.running)
    if (run.host === host)
      try {
        deps.stop(taskRef(run.id), note);
        stopped.push(taskRef(run.id));
      } catch {
        // 刚结束：下一条照做。
      }
  const rows = db
    .prepare(
      `SELECT id,pid,worker,status,created_at,ended_at,updated_at FROM tasks
         WHERE pid IS NOT NULL AND status<>'running'
           AND ${host === LOCAL_HOST ? "(host_id IS NULL OR host_id=?)" : "host_id=?"}
           AND updated_at>=? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(host, now - LEFTOVER_MS, LEFTOVER_LIMIT * 2) as LeftoverRow[];
  const targets = leftoverTargets(rows, { now, active: deps.active });
  let killed: LeftoverKill[] = [];
  let unreached: string | undefined;
  if (targets.length)
    try {
      killed =
        host === LOCAL_HOST
          ? await deps.reapLocal(targets)
          : await deps.remote(host, targets);
    } catch (error) {
      unreached = error instanceof Error ? error.message : String(error);
    }
  for (const kill of killed)
    noteTask(db, kill.task, "leftover_killed", {
      host: ref,
      pid: kill.pid,
      tool: kill.tool,
      ...(deps.by ? { by: deps.by } : {}),
    });
  const parts = [
    `停掉 ${stopped.length} 个在跑的执行者${stopped.length ? `（${stopped.join("、")}）` : ""}`,
    unreached
      ? `残留进程没清：${unreached}`
      : `结束 ${killed.length} 个残留进程树${killed.length ? `：${killed.map(killLine).join("；")}` : ""}`,
  ];
  return {
    stopped,
    killed: killed.map((kill) => ({ ...kill, task: taskRef(kill.task) })),
    checked: targets.length,
    ...(unreached ? { unreached } : {}),
    detail: `${ref}：${parts.join("，")}`,
  };
}
