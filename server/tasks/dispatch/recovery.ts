import type { DatabaseSync } from "node:sqlite";
import { commandLineInvocation } from "../../platform/index.ts";
import { adopted } from "./active.ts";
import { ADAPTERS, type Tool } from "../adapters/index.ts";
import { defaultBranch, type Exec } from "../git.ts";
import type { Executors } from "./executors.ts";
import { getTask, noteTask, type Task } from "../ledger/ledger.ts";
import { resolveWorker, type ResolvedWorker } from "../workers/profiles.ts";
import { alive } from "./spawn.ts";
import { hostRun, type HostRun } from "../../hosts/model.ts";
import { hostRef, LOCAL_HOST } from "../../hosts/state.ts";
import type { RemoteHosts } from "../../hosts/remote.ts";

/**
 * 服务重启自愈（#262）：找出账本里 running 的任务，判断它的执行者进程还在不在。
 * surveyRunning 只读；recoverRunning 据此按 pid 接管，或对重启窗口内已经退出的补做收尾
 * （日志、关卡、事件与正常退出同一条路径），再把排队的拉起来。
 */

/** pid 还在，且确实是该工具的进程（防 pid 复用误接管、误杀）。 */
export async function ownsPid(pid: number, tool: Tool, exec: Exec) {
  if (!alive(pid)) return false;
  const call = commandLineInvocation(process.platform, pid);
  const ps = await exec(call.command, call.args, { timeoutMs: 10_000 });
  return ps.ok && ps.stdout.includes(ADAPTERS[tool].executable);
}

export type Survivor =
  /** 进程已不在；worker 解析不出时无从收尾，只能置 failed。 */
  | { task: Task; kind: "gone"; worker?: ResolvedWorker; base: string | null }
  | { task: Task; kind: "alive"; worker: ResolvedWorker; base: string | null }
  /** 跑在远程主机上（#358）：不在本机查 pid，等那台的代理重连后对账、补报退出。 */
  | {
      task: Task;
      kind: "remote";
      worker: ResolvedWorker;
      base: string | null;
      run: HostRun;
    };

async function surveyRunning(
  db: DatabaseSync,
  skip: (id: number) => boolean,
  exec: Exec,
): Promise<Survivor[]> {
  const rows = db
    .prepare("SELECT id FROM tasks WHERE status='running' ORDER BY id")
    .all() as { id: number }[];
  const found: Survivor[] = [];
  for (const { id } of rows) {
    if (skip(id)) continue;
    const task = getTask(db, id);
    let worker: ResolvedWorker | undefined;
    try {
      worker = task.worker ? await resolveWorker(task.worker, db) : undefined;
    } catch {
      worker = undefined;
    }
    const base =
      worker && task.repo
        ? await defaultBranch(task.repo, exec).catch(() => null)
        : null;
    if (task.host_id != null && task.host_id !== LOCAL_HOST) {
      const run = hostRun(db, id);
      if (worker && run && run.host_id === task.host_id)
        found.push({ task, kind: "remote", worker, base, run });
      else found.push({ task, kind: "gone", worker: undefined, base });
      continue;
    }
    if (task.pid && worker && (await ownsPid(task.pid, worker.tool, exec)))
      found.push({ task, kind: "alive", worker, base });
    else found.push({ task, kind: "gone", worker, base });
  }
  return found;
}

export async function recoverRunning(
  x: Executors,
  db: DatabaseSync,
  ctx: {
    data: string;
    exec: Exec;
    changed: (id: number) => void;
    remote?: RemoteHosts;
  },
) {
  const skip = (id: number) => x.active.has(id) || x.launching.has(id);
  for (const found of await surveyRunning(db, skip, ctx.exec)) {
    const { task } = found;
    if (found.kind === "remote") {
      const { run } = found;
      const exec = ctx.remote ? ctx.remote.exec(run.host_id) : ctx.exec;
      const active = adopted({
        task,
        worker: found.worker,
        base: found.base,
        data: ctx.data,
        exec,
        remote: { host: run.host_id, run: run.run, repo: run.clone },
      });
      x.active.set(task.id, active);
      noteTask(db, task.id, "adopted", {
        pid: task.pid,
        host: hostRef(run.host_id),
        reason: `服务重启后接管 ${hostRef(run.host_id)} 上的执行者，等那台的代理重连后补报`,
      });
      await active.probe.baseline();
      continue;
    }
    if (found.worker) {
      const active = adopted({
        task,
        worker: found.worker,
        base: found.base,
        data: ctx.data,
        exec: ctx.exec,
      });
      x.active.set(task.id, active);
      if (found.kind === "alive") {
        await active.probe.baseline();
        noteTask(db, task.id, "adopted", {
          pid: task.pid,
          reason: "服务重启后按 pid 接管",
        });
        continue;
      }
      // 重启窗口内已经退出：接管后立即收尾，退出码不可得，按日志与交付事实判结局。
      noteTask(db, task.id, "adopted", {
        pid: task.pid,
        reason: "服务重启时执行者已退出，接管后补做收尾",
      });
      await x.finish(task.id, "unknown");
      ctx.changed(task.id);
      continue;
    }
    const reason =
      task.host_id != null && task.host_id !== LOCAL_HOST
        ? `服务重启时找不到 ${hostRef(task.host_id)} 上这一轮的记录（或执行者档案解析不出），无法接管`
        : "服务重启时执行者进程已不在，执行者档案解析不出，无法收尾";
    x.advance(
      task.id,
      { kind: "exit_fail" },
      {},
      { reason, pid: task.pid, source: "recovery" },
    );
    x.publish(task.id, "failed", { reason, source: "recovery" });
    ctx.changed(task.id);
  }
  await x.drain();
}
