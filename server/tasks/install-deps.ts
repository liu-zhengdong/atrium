import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
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
 * 检查前给工作树装依赖（t252）：代理的检查工作树（server/agent/check.ts）和本机为远程任务另建的合入工作树
 * （merge-runtime.ts localWorktree）都没有执行者装好的依赖，跑检查前在这里装。
 * 有 package-lock.json 的仓库：锁文件和上次装的不一样（或还没装）就 `npm ci --prefer-offline`
 * （先用本机 npm 缓存，不重新下载），输出写进检查日志；别的生态由仓库自己的 .agents/check 负责准备。
 * 装不上返回原因，调用方记为「没跑成」（infra），不算执行者没过。
 */

/** 装依赖最多等多久。 */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export const INSTALL_COMMAND = "npm ci --prefer-offline --no-audit --no-fund";

/** 装好后记下锁文件哈希的地方：哈希没变下次跳过。 */
const STAMP = ".atrium-lock";

/** 要不要装：没有 package.json 或锁文件不装；锁文件哈希和上次装好记下的一样也不装。纯函数。 */
export function installNeeded(input: {
  hasPackage: boolean;
  lockHash: string | null;
  stamp: string | null;
}) {
  if (!input.hasPackage || !input.lockHash) return false;
  return input.stamp?.trim() !== input.lockHash;
}

const NPM_ERROR = /^npm (?:error|ERR!)\s+(.+)$/gm;

/** 装依赖没成的原因：退出码（超时、起不来另说）加 npm 最后一行报错。纯函数。 */
export function installFailure(input: {
  code: number | null;
  timedOut?: boolean;
  error?: string;
  tail: string;
}) {
  const head = input.timedOut
    ? `装依赖超时（${INSTALL_COMMAND} 超过 ${INSTALL_TIMEOUT_MS / 60_000} 分钟）`
    : input.error
      ? `装依赖失败（${INSTALL_COMMAND} 起不来：${input.error.slice(0, 200)}）`
      : `装依赖失败（${INSTALL_COMMAND} 退出码 ${input.code ?? "未知"}）`;
  const lines = [...input.tail.matchAll(NPM_ERROR)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? `${head}：${last.slice(0, 200)}` : head;
}

function lockHash(tree: string) {
  try {
    return createHash("sha256")
      .update(readFileSync(join(tree, "package-lock.json")))
      .digest("hex");
  } catch {
    return null;
  }
}

function readStamp(tree: string) {
  try {
    return readFileSync(join(tree, "node_modules", STAMP), "utf8");
  } catch {
    return null;
  }
}

/** 按需装依赖，输出追加到 log；装好或不用装为 null，没装上是原因。 */
export async function installDeps(input: {
  tree: string;
  log: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const { tree, log } = input;
  const hash = lockHash(tree);
  if (
    !installNeeded({
      hasPackage: existsSync(join(tree, "package.json")),
      lockHash: hash,
      stamp: readStamp(tree),
    })
  )
    return null;
  appendFileSync(log, `[atrium] 装依赖：${INSTALL_COMMAND}\n`, {
    mode: 0o600,
  });
  const before = statSync(log).size;
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawnShell(INSTALL_COMMAND, {
      cwd: tree,
      env: workerEnvironment(input.env),
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    return installFailure({ code: null, error: String(error), tail: "" });
  } finally {
    closeSync(fd);
  }
  let timedOut = false;
  const kill = () => {
    if (child.pid) killTree(child.pid, "SIGKILL");
  };
  input.signal?.addEventListener("abort", kill, { once: true });
  if (input.signal?.aborted) kill();
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, input.timeoutMs ?? INSTALL_TIMEOUT_MS);
  const result = await new Promise<{ code: number | null; error?: string }>(
    (resolve) => {
      child.once("error", (error) =>
        resolve({ code: null, error: error.message }),
      );
      child.once("close", (code) => resolve({ code }));
    },
  );
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", kill);
  if (input.signal?.aborted) return "服务不再等这次检查";
  if (timedOut || result.error || result.code !== 0) {
    const output = readFileSync(log).subarray(before).toString("utf8");
    return installFailure({
      code: result.code,
      timedOut,
      error: result.error,
      tail: output.slice(-8 * 1024),
    });
  }
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  writeFileSync(join(tree, "node_modules", STAMP), `${hash}\n`);
  return null;
}
