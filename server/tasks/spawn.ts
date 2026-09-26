import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { Problem } from "../problem.ts";
import { findExecutable } from "./adapters/index.ts";
import type { Prepared } from "./workspace.ts";

/**
 * 拉起与停止执行者进程（#262）：独立进程组、白名单环境、输出直接写进日志文件（不经管道），
 * 调用方终端退出、服务重启都不会把它带走。
 */

/** 日志抬头里的参数：压成一行（抬头每行以 [atrium] 开头，摘要据此剔除），过长截断。 */
export const shortArg = (arg: string) => {
  const flat = arg.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
};

/**
 * 拉起执行者：独立进程组、白名单环境、stdout/stderr 直接写日志文件。
 * 上一次运行的日志改名留档，本次日志从抬头开始。
 */
export async function spawnWorker(
  prepared: Prepared,
  env: NodeJS.ProcessEnv,
  taskRefText: string,
): Promise<ChildProcess> {
  const { launch, logFile } = prepared;
  if (existsSync(logFile)) renameSync(logFile, `${logFile}-${Date.now()}`);
  const command =
    findExecutable(launch.command, env.PATH ?? "") ?? launch.command;
  writeFileSync(
    logFile,
    `[atrium] ${taskRefText} · ${prepared.worker.id} · ${new Date().toISOString()}\n[atrium] cwd ${launch.cwd}\n[atrium] ${[command, ...launch.args.map(shortArg)].join(" ")}\n`,
    { mode: 0o600 },
  );
  const out = openSync(logFile, "a");
  const input = launch.stdin ? openSync(launch.stdin, "r") : "ignore";
  let child: ChildProcess;
  try {
    child = spawn(command, launch.args, {
      cwd: launch.cwd,
      env,
      detached: true,
      stdio: [input, out, out],
    });
  } finally {
    closeSync(out);
    if (typeof input === "number") closeSync(input);
  }
  if (!child.pid) {
    const error = await new Promise<Error>((resolve) =>
      child.once("error", resolve),
    );
    throw new Problem(
      500,
      `拉起 ${prepared.worker.id} 失败：${error.message}`,
      "internal",
    );
  }
  child.unref();
  return child;
}

/** 进程组整体发信号；进程已不在时静默。 */
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已退出。
    }
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
