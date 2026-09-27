import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { workerEnvironment } from "./worker-env.ts";

/** 本地检查只由运行时执行；队列在同一服务进程的所有任务之间共享。 */
export const LOCAL_CHECK_TIMEOUT_MS = 15 * 60_000;
export type LocalCheck = {
  status: "passed" | "failed" | "timeout" | "error";
  command: string;
  log: string;
  detail: string;
  failedTests: string[];
};

export class LocalCheckQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  async run<T>(work: () => Promise<T>, queued?: () => void): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    if (this.waiting++ > 0) {
      try {
        queued?.();
      } catch {
        // 事件记录失败不能让等待者绕开前一份检查。
      }
    }
    await previous;
    try {
      return await work();
    } finally {
      this.waiting--;
      release();
    }
  }
}

const sharedQueue = new LocalCheckQueue();

/** .agents/check 是仓库内的 shell 脚本；没有时读取 package.json 的 check 脚本。 */
export async function checkCommand(worktree: string): Promise<string> {
  const root = await realpath(worktree);
  const inside = async (file: string) => {
    const target = await realpath(file);
    const path = relative(root, target);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`检查脚本指向工作树外：${file}`);
    return target;
  };
  try {
    const script = (
      await readFile(await inside(join(worktree, ".agents", "check")), "utf8")
    ).trim();
    if (!script) throw new Error(".agents/check 为空");
    return script;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let pkg: { scripts?: { check?: unknown } };
  try {
    pkg = JSON.parse(
      await readFile(await inside(join(worktree, "package.json")), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("没有 .agents/check 或 package.json 的 check 脚本");
    throw error;
  }
  if (typeof pkg.scripts?.check !== "string" || !pkg.scripts.check.trim())
    throw new Error("package.json 没有 check 脚本");
  return "npm run check";
}

/** 从有界日志尾部提取失败用例名；原始输出始终完整保存在任务目录。 */
export function failedTestNames(log: string): string[] {
  const names = new Set<string>();
  for (const line of log.split("\n")) {
    const name = line
      .match(/^\s*(?:not ok \d+ - |✖\s+|FAIL\s+)(.+)/)?.[1]
      ?.trim();
    if (name && name !== "failing tests:") names.add(name.slice(0, 200));
  }
  return [...names].slice(0, 10);
}

function logTail(file: string): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export async function runLocalCheck(input: {
  worktree: string;
  taskDir: string;
  timeoutMs?: number;
  queue?: LocalCheckQueue;
  env?: NodeJS.ProcessEnv;
  onStatus?: (status: "queued" | "started", log: string) => void;
}): Promise<LocalCheck> {
  const log = join(input.taskDir, "local-check.log");
  return (input.queue ?? sharedQueue).run(
    async () => {
      mkdirSync(input.taskDir, { recursive: true, mode: 0o700 });
      let command = "";
      try {
        if (!input.worktree)
          throw new Error("任务没有 worktree，不能运行本地检查");
        command = await checkCommand(input.worktree);
      } catch (error) {
        writeFileSync(log, `${String(error)}\n`, { mode: 0o600 });
        return {
          status: "error",
          command,
          log,
          detail: String(error),
          failedTests: [],
        };
      }
      try {
        input.onStatus?.("started", log);
      } catch {
        // 检查结果仍由关卡落库；进度事件失败不能中断检查。
      }
      const fd = openSync(log, "w", 0o600);
      let child;
      try {
        child = spawn("/bin/sh", ["-c", command], {
          cwd: input.worktree,
          env: workerEnvironment(input.env),
          detached: true,
          stdio: ["ignore", fd, fd],
        });
      } catch (error) {
        closeSync(fd);
        return {
          status: "error",
          command,
          log,
          detail: String(error),
          failedTests: [],
        };
      }
      closeSync(fd);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      }, input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS);
      const result = await new Promise<{ code: number | null; error?: Error }>(
        (resolve) => {
          child.once("error", (error) => resolve({ code: null, error }));
          child.once("close", (code) => resolve({ code }));
        },
      );
      clearTimeout(timer);
      const tail = logTail(log);
      const failedTests = failedTestNames(tail);
      const status = timedOut
        ? "timeout"
        : result.error
          ? "error"
          : result.code === 0
            ? "passed"
            : "failed";
      const detail = timedOut
        ? `超过 ${Math.ceil((input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS) / 60_000)} 分钟`
        : (result.error?.message ??
          (result.code === 0 ? "检查通过" : `退出码 ${result.code}`));
      return { status, command, log, detail, failedTests };
    },
    () => input.onStatus?.("queued", log),
  );
}
