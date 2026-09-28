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
import { killTree, spawnShell } from "../../platform/index.ts";
import { redact } from "../../secret-redact.ts";
import { workerEnvironment } from "../dispatch/worker-env.ts";

/**
 * 检查前给工作树装依赖（t252、t216）：换主机、新工作树（代理的检查工作树、本机为远程任务另建的合入工作树）、
 * 别人刚改了 package-lock.json 时，工作树里没有或只有旧的 node_modules，`npm run check` 会因为缺命令直接失败，
 * 不能算执行者没过。`runLocalCheck` 每次跑检查前都经这里判一次（`depsPlan` 纯函数，只看几个文件、不遍历
 * node_modules）：要装就 `npm ci --prefer-offline`（先用本机 npm 缓存），输出写进检查日志、记用时。
 * 只管有 package-lock.json 的 npm 仓库；别的生态由仓库自己的 .agents/check 负责准备。
 * 装不上返回失败记录，调用方记为「没跑成」（infra），不算执行者没过。
 */

/** 装依赖最多等多久。 */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export const INSTALL_COMMAND = "npm ci --prefer-offline --no-audit --no-fund";

/** 装好后记下锁文件哈希的地方（在 node_modules 里，跟着依赖目录一起没）：哈希没变下次跳过。 */
export const DEPS_STAMP = join("node_modules", ".atrium-lock");

/** 装失败时从日志末尾摘几行写进结论。 */
const FAIL_TAIL_LINES = 8;

export type DepsFacts = {
  /** 有 package.json 与 package-lock.json。 */
  npm: boolean;
  modules: boolean;
  /** 上次 Atrium 装完记下的锁文件哈希。 */
  stamp: string | null;
  /** 锁文件现在的哈希（只在有记号时才算）。 */
  hash: string | null;
  /** 没有记号时：锁文件与 npm 自己的安装记录（node_modules/.package-lock.json）的修改时刻。 */
  lockMtime: number | null;
  installedMtime: number | null;
};

export type DepsPlan = { install: false } | { install: true; why: string };

/** 要不要装、为什么装。纯函数。 */
export function depsPlan(facts: DepsFacts): DepsPlan {
  if (!facts.npm) return { install: false };
  if (!facts.modules) return { install: true, why: "没有 node_modules" };
  if (facts.stamp !== null)
    return facts.stamp === facts.hash
      ? { install: false }
      : { install: true, why: "package-lock.json 和上次装的不一样" };
  // 执行者自己装过（没有记号）：npm 的安装记录不比锁文件旧就算装好了。
  if (facts.installedMtime === null)
    return { install: true, why: "node_modules 没有 npm 的安装记录" };
  if (facts.lockMtime !== null && facts.lockMtime > facts.installedMtime)
    return { install: true, why: "package-lock.json 比上次安装新" };
  return { install: false };
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
    // npm 收尾总会报一句完整日志在哪，不是原因。
    .filter((line) => line && !/complete log of this run/i.test(line));
  const last = lines.at(-1);
  return redact(last ? `${head}：${last.slice(0, 200)}` : head);
}

function mtime(file: string) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function lockHash(tree: string) {
  return createHash("sha256")
    .update(readFileSync(join(tree, "package-lock.json")))
    .digest("hex");
}

export function depsFacts(tree: string): DepsFacts {
  const lock = join(tree, "package-lock.json");
  const npm = existsSync(lock) && existsSync(join(tree, "package.json"));
  const modules = npm && existsSync(join(tree, "node_modules"));
  let stamp: string | null = null;
  if (modules)
    try {
      stamp = readFileSync(join(tree, DEPS_STAMP), "utf8").trim();
    } catch {
      // 不是 Atrium 装的，或还没装过。
    }
  return {
    npm,
    modules,
    stamp,
    hash: stamp !== null ? lockHash(tree) : null,
    lockMtime: modules && stamp === null ? mtime(lock) : null,
    installedMtime:
      modules && stamp === null
        ? mtime(join(tree, "node_modules", ".package-lock.json"))
        : null,
  };
}

/** 装了依赖时的记录（没装为 undefined）：结论、用时，失败时带原因与输出末尾。 */
export type DepsInstall = {
  status: "installed" | "failed";
  ms: number;
  why: string;
  /** 装失败的一句话原因（进 infra，`task show` 与卡住原因里用）。 */
  error?: string;
  /** 装失败的原因加 npm 输出末尾（已脱敏）。 */
  detail?: string;
};

/** 代理回执里的装依赖记录：字段不对就当没有（远程回执不可信任意形状）。 */
export function parseDepsInstall(value: unknown): DepsInstall | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.status !== "installed" && v.status !== "failed") return undefined;
  if (typeof v.ms !== "number" || !Number.isFinite(v.ms) || v.ms < 0)
    return undefined;
  const text = (x: unknown, max: number) =>
    typeof x === "string" ? x.slice(0, max) : undefined;
  const error = text(v.error, 500);
  const detail = text(v.detail, 2500);
  return {
    status: v.status,
    ms: v.ms,
    why: text(v.why, 200) ?? "",
    ...(error ? { error } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** 检查结论里一句话说装依赖的事（`task show` 事件行里看得到）。 */
export function depsLine(install: DepsInstall) {
  const seconds = Math.max(1, Math.round(install.ms / 1000));
  return install.status === "installed"
    ? `先装了依赖（npm ci，${seconds} 秒）`
    : `装依赖失败（npm ci，${seconds} 秒）`;
}

function tailLines(text: string) {
  return redact(
    text.trimEnd().split("\n").slice(-FAIL_TAIL_LINES).join("\n"),
  ).slice(-2000);
}

/**
 * 依赖没就绪就在工作树里 `npm ci`，输出追加到 log；已就绪直接返回 undefined，不多花时间。
 * 装失败（断网、磁盘满等）返回 failed：是「检查没跑成」，不是执行者没过。
 */
export async function installDeps(input: {
  tree: string;
  log: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DepsInstall | undefined> {
  const { tree, log } = input;
  let facts;
  try {
    facts = depsFacts(tree);
  } catch {
    return undefined;
  }
  const plan = depsPlan(facts);
  if (!plan.install) return undefined;
  const started = Date.now();
  const note = (line: string) =>
    appendFileSync(log, `[atrium] ${line}\n`, { mode: 0o600 });
  const failed = (error: string, output = ""): DepsInstall => {
    const tail = output ? tailLines(output) : "";
    note(error);
    return {
      status: "failed",
      ms: Date.now() - started,
      why: plan.why,
      error,
      detail: tail ? `${error}；输出末尾：\n${tail}` : error,
    };
  };
  note(`${plan.why}，先装依赖：${INSTALL_COMMAND}`);
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
    return failed(
      installFailure({ code: null, error: String(error), tail: "" }),
    );
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
  if (input.signal?.aborted) return failed("服务不再等这次检查");
  if (timedOut || result.error || result.code !== 0) {
    const output = readFileSync(log).subarray(before).toString("utf8");
    return failed(
      installFailure({
        code: result.code,
        timedOut,
        error: result.error,
        tail: output.slice(-8 * 1024),
      }),
      output.slice(-8 * 1024),
    );
  }
  try {
    mkdirSync(join(tree, "node_modules"), { recursive: true });
    writeFileSync(join(tree, DEPS_STAMP), `${facts.hash ?? lockHash(tree)}\n`);
  } catch {
    // 记号写不上只是下次多装一回。
  }
  const install: DepsInstall = {
    status: "installed",
    ms: Date.now() - started,
    why: plan.why,
  };
  note(`依赖装好，用时 ${Math.max(1, Math.round(install.ms / 1000))} 秒`);
  return install;
}
