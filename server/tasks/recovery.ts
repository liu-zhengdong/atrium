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
 * surveyRunning 只读；recoverRunning 据此置 failed 或按 pid 接管，再把排队的拉起来。
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
  | { task: Task; kind: "gone" }
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
    if (task.pid && worker && (await ownsPid(task.pid, worker.tool, exec))) {
      const base = task.repo
        ? await defaultBranch(task.repo, exec).catch(() => null)
        : null;
      found.push({ task, kind: "alive", worker, base });
    } else found.push({ task, kind: "gone" });
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
    if (found.kind === "alive") {
      const active = adopted({
        task,
        worker: found.worker,
        base: found.base,
        data: ctx.data,
        exec: ctx.exec,
      });
      await active.probe.baseline();
      x.active.set(task.id, active);
      noteTask(db, task.id, "adopted", {
        pid: task.pid,
        reason: "服务重启后按 pid 接管",
      });
      continue;
    }
    const reason = "服务重启时执行者进程已不在";
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
