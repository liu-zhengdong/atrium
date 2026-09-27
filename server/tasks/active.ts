import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ADAPTERS, type Tool } from "./adapters/index.ts";
import type { Exec } from "./git.ts";
import type { Task } from "./ledger.ts";
import type { Stop } from "./outcome.ts";
import type { ResolvedWorker, Risk } from "./profiles.ts";
import {
  ProgressProbe,
  watchLimits,
  type WatchLimits,
  type WatchState,
} from "./watchdog.ts";
import type { Prepared } from "./workspace.ts";

/** 服务手里一个运行中的执行者（#262）：进程、看门狗状态、收尾要用的仓库信息。 */
export type Active = {
  id: number;
  pid: number;
  /** 服务重启后接管的进程没有句柄，只能按 pid 轮询。 */
  child?: ChildProcess;
  tool: Tool;
  worker: ResolvedWorker;
  risk: Risk;
  prepared?: Prepared;
  logFile: string;
  /** 接管的进程没有 prepared：codex 最后消息文件按任务目录里的固定位置找。 */
  resultFile?: string;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  deliver: Task["deliver"];
  issue: number | null;
  startedAt: number;
  probe: ProgressProbe;
  state: WatchState;
  limits: WatchLimits;
  retried: boolean;
  stop?: Stop;
  exited: boolean;
};

export const taskDir = (data: string, id: number) =>
  join(data, "tasks", String(id));

export function limitsFor(worker: ResolvedWorker): WatchLimits {
  return watchLimits(
    ADAPTERS[worker.tool].watchdog,
    worker.profile.rules.limits,
  );
}

export function probeFor(
  logFile: string,
  cwd: string,
  git: boolean,
  tool: Tool,
  exec: Exec,
) {
  return new ProgressProbe(
    logFile,
    cwd,
    git,
    ADAPTERS[tool].progressSignals.includes("json_events"),
    exec,
  );
}

/** 刚拉起的执行者。 */
export function launched(input: {
  task: Task;
  pid: number;
  child: ChildProcess;
  worker: ResolvedWorker;
  risk: Risk;
  prepared: Prepared;
  retried: boolean;
  exec: Exec;
}): Active {
  const { prepared, worker } = input;
  return {
    id: input.task.id,
    pid: input.pid,
    child: input.child,
    tool: worker.tool,
    worker,
    risk: input.risk,
    prepared,
    logFile: prepared.logFile,
    repo: input.task.repo,
    worktree: prepared.worktree,
    branch: prepared.branch,
    base: prepared.base,
    deliver: input.task.deliver,
    issue: input.task.issue,
    startedAt: input.task.started_at ?? Date.now(),
    probe: probeFor(
      prepared.logFile,
      prepared.cwd,
      !!prepared.worktree,
      worker.tool,
      input.exec,
    ),
    state: { startedAt: Date.now(), lastProgressAt: null },
    limits: limitsFor(worker),
    retried: input.retried,
    exited: false,
  };
}

/** 服务重启后按 pid 接管的执行者：重启期间的进展无从得知，从现在起重新计空闲，不按启动卡死判。 */
export function adopted(input: {
  task: Task;
  worker: ResolvedWorker;
  base: string | null;
  data: string;
  exec: Exec;
}): Active {
  const { task, worker } = input;
  const dir = taskDir(input.data, task.id);
  const logFile = join(dir, "log");
  const now = Date.now();
  return {
    id: task.id,
    pid: task.pid!,
    tool: worker.tool,
    worker,
    risk: "low",
    logFile,
    resultFile: join(dir, "last-message.md"),
    repo: task.repo,
    worktree: task.worktree,
    branch: task.branch,
    base: input.base,
    deliver: task.deliver,
    issue: task.issue,
    startedAt: task.started_at ?? now,
    probe: probeFor(
      logFile,
      task.worktree ?? join(dir, "work"),
      !!task.worktree,
      worker.tool,
      input.exec,
    ),
    state: { startedAt: now, lastProgressAt: now },
    limits: limitsFor(worker),
    retried: true,
    exited: false,
  };
}
