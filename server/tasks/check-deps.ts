import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { killTree, spawnShell } from "../platform/index.ts";
import { workerEnvironment } from "./worker-env.ts";

/**
 * 检查前装依赖（t251）：本机合入检查与代理的检查工作树共用。有 package-lock.json 的仓库，
 * 锁文件和上次装的不一样（或还没装）就 npm ci，输出写进检查日志；别的生态由仓库自己的 .agents/check 负责准备。
 */

/** 装依赖最多等多久。 */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** 装完记下锁文件哈希，下次一样就不重装。 */
const STAMP = ".atrium-lock";

export type DepsState = {
  /** 锁文件哈希；没有 package-lock.json 或 package.json 时为空。 */
  lock: string | null;
  /** 上次装完记下的哈希；没记过为空。 */
  stamp: string | null;
  /** node_modules 里 npm 自己的清单（.package-lock.json）不比锁文件旧：别人（执行者）在锁文件最近一次变动后装过。 */
  installedAfterLock: boolean;
};

/** 要不要 npm ci：记过哈希就按哈希比；没记过的，执行者在锁文件变动后装过就沿用，否则装。 */
export function needsInstall(state: DepsState): boolean {
  if (!state.lock) return false;
  if (state.stamp !== null) return state.stamp !== state.lock;
  return !state.installedAfterLock;
}

function depsState(tree: string): DepsState {
  const lockFile = join(tree, "package-lock.json");
  let lock: string;
  let lockTime: number;
  try {
    statSync(join(tree, "package.json"));
    lockTime = statSync(lockFile).mtimeMs;
    lock = createHash("sha256").update(readFileSync(lockFile)).digest("hex");
  } catch {
    return { lock: null, stamp: null, installedAfterLock: false };
  }
  let stamp: string | null = null;
  try {
    stamp = readFileSync(join(tree, "node_modules", STAMP), "utf8").trim();
  } catch {
    // 还没记过。
  }
  let installedAfterLock = false;
  try {
    installedAfterLock =
      statSync(join(tree, "node_modules", ".package-lock.json")).mtimeMs >=
      lockTime;
  } catch {
    // 没装过。
  }
  return { lock, stamp, installedAfterLock };
}

/** 需要就在 tree 里 npm ci，输出追加到 log；装不上返回原因（调用方记为没跑成），不用装或装好了返回 null。 */
export async function installDeps(
  tree: string,
  log: string,
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const state = depsState(tree);
  if (!needsInstall(state)) return null;
  const fail = (why: string) => {
    appendFileSync(log, `[atrium] ${why}\n`, { mode: 0o600 });
    return why;
  };
  appendFileSync(log, "[atrium] 装依赖：npm ci\n", { mode: 0o600 });
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawnShell("npm ci --no-audit --no-fund", {
      cwd: tree,
      env: workerEnvironment(env),
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    return fail(`装依赖失败：${String(error)}`);
  } finally {
    closeSync(fd);
  }
  let timedOut = false;
  const kill = () => {
    if (child.pid) killTree(child.pid, "SIGKILL");
  };
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, INSTALL_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (value) => resolve(value));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", kill);
  if (signal?.aborted) return fail("装依赖时服务不再等这次检查");
  if (timedOut)
    return fail(
      `装依赖失败（npm ci 超过 ${INSTALL_TIMEOUT_MS / 60_000} 分钟）`,
    );
  if (code !== 0) return fail(`装依赖失败（npm ci 退出码 ${code ?? "未知"}）`);
  // 没有依赖的仓库 npm ci 可能不建 node_modules。
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  writeFileSync(join(tree, "node_modules", STAMP), `${state.lock}\n`);
  return null;
}
