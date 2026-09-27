import type { ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { commandInvocation, spawnInvocation } from "../platform/index.ts";
import { Problem } from "../problem.ts";
import { userLine } from "./live-input.ts";
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
 * 上一次运行的日志改名留档，本次日志从抬头开始；append（续上会话）时接着原日志写。
 * launch.input 为 stream-json 时标准输入是管道：先写提示词作为第一条用户消息，写端交给调用方保持打开。
 * 返回的 offset 是抬头写完时的日志长度，之后都是执行者的输出。
 */
export async function spawnWorker(
  prepared: Pick<Prepared, "launch" | "logFile"> & { worker: { id: string } },
  env: NodeJS.ProcessEnv,
  taskRefText: string,
  append = false,
): Promise<{ child: ChildProcess; offset: number }> {
  const { launch, logFile } = prepared;
  if (!append && existsSync(logFile))
    renameSync(logFile, `${logFile}-${Date.now()}`);
  const childEnv = launch.env ? { ...env, ...launch.env } : env;
  let invocation;
  try {
    invocation = commandInvocation(launch.command, launch.args, childEnv);
  } catch (error) {
    throw new Problem(
      500,
      `拉起 ${prepared.worker.id} 失败：${(error as Error).message}`,
      "internal",
    );
  }
  const command = invocation.command;
  const header = `[atrium] ${taskRefText} · ${prepared.worker.id} · ${new Date().toISOString()}${append ? " · 续上会话" : ""}\n[atrium] cwd ${launch.cwd}\n${Object.entries(
    launch.env ?? {},
  )
    .map(([key, value]) => `[atrium] env ${key}=${value}\n`)
    .join(
      "",
    )}[atrium] ${[command, ...invocation.args.map(shortArg)].join(" ")}\n`;
  if (append) appendFileSync(logFile, header, { mode: 0o600 });
  else writeFileSync(logFile, header, { mode: 0o600 });
  const offset = statSync(logFile).size;
  const out = openSync(logFile, "a");
  const piped = launch.input === "stream-json";
  const input =
    launch.stdin && !piped
      ? openSync(launch.stdin, "r")
      : piped
        ? "pipe"
        : "ignore";
  let child: ChildProcess;
  try {
    child = spawnInvocation(invocation, {
      cwd: launch.cwd,
      env: childEnv,
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
  if (piped && child.stdin) {
    child.stdin.on("error", () => {
      // 执行者提前退出时写端 EPIPE；退出由 exit 事件收尾。
    });
    if (launch.stdin)
      child.stdin.write(
        userLine(
          readFileSync(launch.stdin, "utf8"),
          undefined,
          launch.inputDialect,
        ),
      );
    // 写端不拖住服务进程退出；服务退出时写端关闭，执行者处理完本轮后退出。
    (child.stdin as unknown as { unref?: () => void }).unref?.();
  }
  child.unref();
  return { child, offset };
}

/** 进程是否还在（平台层判定）。 */
export { processAlive as alive } from "../platform/index.ts";
