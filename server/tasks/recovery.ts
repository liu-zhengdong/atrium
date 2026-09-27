import type { DatabaseSync } from "node:sqlite";
import { adopted } from "./active.ts";
import { ADAPTERS, type Tool } from "./adapters/index.ts";
import { defaultBranch, type Exec } from "./git.ts";
import type { Executors } from "./executors.ts";
import { getTask, noteTask, type Task } from "./ledger.ts";
import { resolveWorker, type ResolvedWorker } from "./profiles.ts";
import { alive } from "./spawn.ts";

/**
 * 服务重启自愈（#262）：找出账本里 running 的任务，判断它的执行者进程还在不在。
 * surveyRunning 只读；recoverRunning 据此按 pid 接管，或对重启窗口内已经退出的补做收尾
 * （日志、关卡、事件与正常退出同一条路径），再把排队的拉起来。
 */

/** pid 还在，且确实是该工具的进程（防 pid 复用误接管、误杀）。 */
export async function ownsPid(pid: number, tool: Tool, exec: Exec) {
  if (!alive(pid)) return false;
  const ps = await exec("ps", ["-o", "command=", "-p", String(pid)], {
    timeoutMs: 5000,
  });
  return ps.ok && ps.stdout.includes(ADAPTERS[tool].executable);
}

export type Survivor =
  /** 进程已不在；worker 解析不出时无从收尾，只能置 failed。 */
  | { task: Task; kind: "gone"; worker?: ResolvedWorker; base: string | null }
  | { task: Task; kind: "alive"; worker: ResolvedWorker; base: string | null };

export async function surveyRunning(
  db: DatabaseSync,
  skip: (id: number) => boolean,
  workersDir: string,
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
      worker = task.worker
        ? await resolveWorker(task.worker, workersDir)
        : undefined;
    } catch {
      worker = undefined;
    }
    const base =
      worker && task.repo
        ? await defaultBranch(task.repo, exec).catch(() => null)
        : null;
    if (task.pid && worker && (await ownsPid(task.pid, worker.tool, exec)))
      found.push({ task, kind: "alive", worker, base });
    else found.push({ task, kind: "gone", worker, base });
  }
  return found;
}

export async function recoverRunning(
  x: Executors,
  db: DatabaseSync,
  workersDir: string,
  ctx: { data: string; exec: Exec; changed: (id: number) => void },
) {
  const skip = (id: number) => x.active.has(id) || x.launching.has(id);
  for (const found of await surveyRunning(db, skip, workersDir, ctx.exec)) {
    const { task } = found;
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
    const reason = "服务重启时执行者进程已不在，执行者档案解析不出，无法收尾";
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
