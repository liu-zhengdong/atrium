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
import { killTree, spawnShell } from "../platform/index.ts";
import { workerEnvironment } from "./worker-env.ts";
import { checkPlacement, CHECK_TIMEOUT_MINUTES } from "./host-load.ts";

/** 本地检查只由运行时执行；队列在同一服务进程的所有任务之间共享。超时按主机配置（ATRIUM_CHECK_TIMEOUT_MINUTES），这是缺省。 */
export const LOCAL_CHECK_TIMEOUT_MS = CHECK_TIMEOUT_MINUTES * 60_000;
export type LocalCheck = {
  status: "passed" | "failed" | "timeout" | "error";
  command: string;
  log: string;
  detail: string;
  failedTests: string[];
  /** 在哪台主机上跑的（#358 第 2 步，hN）；旧记录没有。 */
  host?: string;
  /** 检查的是哪个提交（按提交派到远程时有）。 */
  commit?: string;
  /** 基础设施原因没跑成（主机离线、没派过去、代理没来领、检查进程被杀）；跑完了为空。 */
  infra?: string;
  /** 过／没过／没跑成（t204，check-outcome.ts）；旧记录没有。 */
  outcome?: "passed" | "failed" | "not_run";
  /** 没跑成的原因（分类给出）。 */
  reason?: string;
  /** 已自动重跑的次数。 */
  reruns?: number;
};

/** 记进事件的检查结果：结论、在哪台、哪个提交排在前面（`task show` 一行里先看到）。 */
export function checkDetail(check: LocalCheck) {
  const { outcome, status, host, commit, ...rest } = check;
  return {
    ...(outcome ? { outcome } : {}),
    status,
    ...(host ? { host } : {}),
    ...(commit ? { commit } : {}),
    ...rest,
  };
}

/**
 * 本地检查排队：同时最多 limit 个（缺省 1，即串行），其余按到达顺序等空位（#358）。
 * 紧急任务的检查（t113）立刻跑、不占名额，也不让等着的普通检查多等一个空位（host-load.ts checkPlacement）。
 */
export class LocalCheckQueue {
  private active = 0;
  private urgentActive = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private max = 1,
    /** 这台主机上一次检查最多跑多久；调用方没单独给时用它。 */
    public timeoutMs = LOCAL_CHECK_TIMEOUT_MS,
  ) {}

  get limit() {
    return this.max;
  }

  /** 调整并发上限；调大时立刻放行等着的。 */
  set limit(value: number) {
    this.max = Math.max(1, Math.floor(value));
    this.pump();
  }

  get size() {
    return {
      running: this.active + this.urgentActive,
      waiting: this.waiters.length,
    };
  }

  private pump() {
    while (this.active < this.max && this.waiters.length) {
      this.active++;
      this.waiters.shift()!();
    }
  }

  async run<T>(
    work: () => Promise<T>,
    queued?: () => void,
    urgent = false,
  ): Promise<T> {
    if (
      checkPlacement({ urgent, active: this.active, max: this.max }) === "run"
    ) {
      if (urgent) {
        this.urgentActive++;
        try {
          return await work();
        } finally {
          this.urgentActive--;
        }
      }
      this.active++;
    } else {
      try {
        queued?.();
      } catch {
        // 事件记录失败不能让等待者绕开前面的检查。
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        this.pump();
      });
    }
    try {
      return await work();
    } finally {
      this.active--;
      this.pump();
    }
  }
}

/** 服务里所有任务共用的本地检查队列；并发上限由运行时按本机配置设（host-load.ts）。 */
export const sharedLocalChecks = new LocalCheckQueue();

/** .agents/check 是仓库内的 shell 命令（Unix 经 /bin/sh，Windows 经 cmd.exe）；没有时读取 package.json 的 check 脚本。 */
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
  signal?: AbortSignal;
  onStatus?: (status: "queued" | "started", log: string) => void;
  /** 紧急任务（t113）：立刻跑，不占并发名额。 */
  urgent?: boolean;
  /** 接着日志已有内容写（代理先把取提交、装依赖的输出写在前面）。 */
  append?: boolean;
}): Promise<LocalCheck> {
  const log = join(input.taskDir, "local-check.log");
  const queue = input.queue ?? sharedLocalChecks;
  const timeoutMs = input.timeoutMs ?? queue.timeoutMs;
  return queue.run(
    async () => {
      if (input.signal?.aborted) throw new Error("服务正在关闭");
      mkdirSync(input.taskDir, { recursive: true, mode: 0o700 });
      let command = "";
      try {
        if (!input.worktree)
          throw new Error("任务没有 worktree，不能运行本地检查");
        command = await checkCommand(input.worktree);
      } catch (error) {
        writeFileSync(log, `${String(error)}\n`, {
          mode: 0o600,
          flag: input.append ? "a" : "w",
        });
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
      const fd = openSync(log, input.append ? "a" : "w", 0o600);
      let child;
      try {
        child = spawnShell(command, {
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
      const abort = () => {
        if (child.pid) killTree(child.pid, "SIGKILL");
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeoutMs);
      const result = await new Promise<{
        code: number | null;
        signal?: NodeJS.Signals | null;
        error?: Error;
      }>((resolve) => {
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const tail = logTail(log);
      const failedTests = failedTestNames(tail);
      // 不是运行时自己超时结束的，却被信号结束：检查进程被别人杀了，算没跑成（t204）。
      const killed =
        !timedOut &&
        !input.signal?.aborted &&
        !result.error &&
        result.code === null &&
        result.signal
          ? `检查进程被信号 ${result.signal} 结束`
          : undefined;
      if (killed)
        return {
          status: "error",
          command,
          log,
          detail: killed,
          failedTests,
          infra: killed,
        };
      const status = timedOut
        ? "timeout"
        : result.error
          ? "error"
          : result.code === 0
            ? "passed"
            : "failed";
      const detail = timedOut
        ? `超过 ${Math.ceil(timeoutMs / 60_000)} 分钟`
        : (result.error?.message ??
          (result.code === 0 ? "检查通过" : `退出码 ${result.code}`));
      return { status, command, log, detail, failedTests };
    },
    () => input.onStatus?.("queued", log),
    input.urgent,
  );
}
