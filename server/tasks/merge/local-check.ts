import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { killTree, spawnShell } from "../../platform/index.ts";
import { workerEnvironment } from "../dispatch/worker-env.ts";
import { CHECK_TIMEOUT_MINUTES } from "../dispatch/host-load.ts";
import { missingCommand } from "./check-outcome.ts";
import { depsLine, installDeps, type DepsInstall } from "./install-deps.ts";
import { stalledCheck } from "./check-quiet.ts";
import { QuietWatch } from "./check-quiet-watch.ts";
import { DUE } from "../watch/overdue.ts";

/** 本地检查只由运行时在服务那台执行（合入队列串行跑）。超时按本机配置（ATRIUM_CHECK_TIMEOUT_MINUTES），这是缺省。 */
const LOCAL_CHECK_TIMEOUT_MS = CHECK_TIMEOUT_MINUTES * 60_000;
export type LocalCheck = {
  status: "passed" | "failed" | "timeout" | "error";
  command: string;
  log: string;
  detail: string;
  failedTests: string[];
  /** 基础设施原因没跑成（装不上依赖、检查命令找不到、检查进程被杀）；跑完了为空。 */
  infra?: string;
  /** 过／没过／没跑成（t204，check-outcome.ts）；旧记录没有。 */
  outcome?: "passed" | "failed" | "not_run";
  /** 没跑成的原因（分类给出）。 */
  reason?: string;
  /** 已自动重跑的次数。 */
  reruns?: number;
  /** 日志到期没新输出、被运行时结束的（overdue.ts 检查一行）：卡在哪个测试文件或哪一行。 */
  stalled?: { at: string | null };
  /** 检查前装了依赖（t216）；依赖本来就绪时没有。装失败时检查不跑，status 为 error 并记 infra（没跑成）。 */
  install?: DepsInstall;
};

/** 记进事件的检查结果：结论、装没装依赖排在前面（`task show` 一行里先看到）。 */
export function checkDetail(check: LocalCheck) {
  const { outcome, status, install, ...rest } = check;
  return {
    ...(outcome ? { outcome } : {}),
    status,
    // 装依赖的输出末尾已在 detail 里，这里只留结论与用时。
    ...(install
      ? {
          deps: depsLine(install),
          install: { status: install.status, ms: install.ms, why: install.why },
        }
      : {}),
    ...rest,
  };
}

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
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStatus?: (status: "started", log: string) => void;
  /** 没输出多久结束检查；缺省按 overdue.ts 检查一行，测试缩短。 */
  stallMs?: number;
  /** 多久看一次日志有没有新输出；测试缩短。 */
  quietPollMs?: number;
}): Promise<LocalCheck> {
  const log = join(input.taskDir, "local-check.log");
  const timeoutMs = input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS;
  const stallMs = input.stallMs ?? DUE.check.ms;
  if (input.signal?.aborted) throw new Error("服务正在关闭");
  mkdirSync(input.taskDir, { recursive: true, mode: 0o700 });
  let command = "";
  try {
    if (!input.worktree) throw new Error("任务没有 worktree，不能运行本地检查");
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
  writeFileSync(log, "", { mode: 0o600 });
  // 依赖没就绪（没装、锁文件变了）先 npm ci；就绪时只看几个文件，不拖慢检查（t252、t216）。
  const install = await installDeps({
    tree: input.worktree,
    log,
    env: input.env,
    signal: input.signal,
  });
  // 装不上依赖检查就没法跑：算没跑成，不交回执行者；合入队列放回队尾重跑。
  if (install?.status === "failed")
    return {
      status: "error",
      command,
      log,
      detail: install.detail ?? install.error ?? "装依赖失败",
      failedTests: [],
      infra: install.error ?? "装依赖失败",
      install,
    };
  const withInstall = install ? { install } : {};
  if (input.signal?.aborted) throw new Error("服务正在关闭");
  const fd = openSync(log, "a", 0o600);
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
      ...withInstall,
    };
  }
  closeSync(fd);
  let timedOut = false;
  // 日志太久没新输出被结束的（t260）：卡在哪。
  const stalled: { at?: string | null } = {};
  const abort = () => {
    if (child.pid) killTree(child.pid, "SIGKILL");
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  const exited = new Promise<{
    code: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const watch = new QuietWatch({
    file: log,
    stallMs,
    pollMs: input.quietPollMs,
    onStall: (at) => {
      if (timedOut || input.signal?.aborted) return;
      stalled.at = at;
      abort();
    },
  });
  await watch.start();
  const result = await exited;
  watch.stop();
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", abort);
  const tail = logTail(log);
  const failedTests = failedTestNames(tail);
  if (stalled.at !== undefined) {
    const judged = stalledCheck({ failedTests, at: stalled.at, stallMs });
    appendFileSync(log, `\n[atrium] ${judged.detail}\n`, { mode: 0o600 });
    return { command, log, failedTests, ...judged, ...withInstall };
  }
  // 不是运行时自己超时结束的，却被信号结束：检查进程被别人杀了，算没跑成（t204）。
  const killed =
    !timedOut &&
    !input.signal?.aborted &&
    !result.error &&
    result.code === null &&
    result.signal
      ? `检查进程被信号 ${result.signal} 结束`
      : undefined;
  // 检查命令找不到（没装依赖）也算没跑成（t204）。
  const missing =
    !timedOut && !result.error && result.code !== 0
      ? missingCommand({ code: result.code, tail, failedTests })
      : null;
  if (missing)
    return {
      status: "failed",
      command,
      log,
      detail: `退出码 ${result.code}`,
      failedTests,
      infra: missing,
      ...withInstall,
    };
  if (killed)
    return {
      status: "error",
      command,
      log,
      detail: killed,
      failedTests,
      infra: killed,
      ...withInstall,
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
  return { status, command, log, detail, failedTests, ...withInstall };
}
