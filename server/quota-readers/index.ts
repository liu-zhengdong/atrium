import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { runFile } from "../platform/index.ts";
import { claudeReader } from "./claude.ts";
import { codexReader } from "./codex.ts";
import { opencodeReader } from "./opencode.ts";
import type {
  Platform,
  ReadOk,
  ReadResult,
  Reader,
  ReaderDeps,
} from "./types.ts";

/**
 * 自带额度读取（#352）：服务进程内按账号读本机登录、调供应商用量接口，结果按账号缓存。
 * - 成功缓存 5 分钟，失败 1 分钟（限流按 Retry-After 推迟）；同一账号同时只有一个请求在飞。
 * - 本次读不到但 6 小时内读到过，照旧给上次读数并注明，免得一次限流就把账号变成「没有数据」。
 * - `ATRIUM_QUOTA_READERS=off` 关掉自带读取；node:test 进程里默认也关（测试不读开发者主目录）。
 */

const READERS: readonly Reader[] = [claudeReader, codexReader, opencodeReader];

export const OK_TTL_MS = 5 * 60_000;
export const FAILED_TTL_MS = 60_000;
/** 上次读数最多沿用多久。 */
export const LAST_GOOD_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
const SECURITY = "/usr/bin/security";
/** security 找不到钥匙串项时的退出码。 */
const ITEM_NOT_FOUND = 44;

/** 一个账号的读取结论：读到（可能是沿用的上次读数，note 说明原因），或读不到。 */
export type ReaderOutcome =
  | { ok: true; result: ReadOk; note: string | null }
  | { ok: false; reason: string };

type Entry = {
  result: ReadResult;
  lastGood: ReadOk | undefined;
  nextAt: number;
};

/** 读失败时：有新鲜的上次读数就沿用，否则读不到（纯函数）。 */
export function outcomeOf(
  result: ReadResult,
  lastGood: ReadOk | undefined,
  now: number,
): ReaderOutcome {
  if (result.ok) return { ok: true, result, note: null };
  if (lastGood && now - lastGood.refreshedAt < LAST_GOOD_MS)
    return {
      ok: true,
      result: lastGood,
      note: `本次读不到（${result.reason}），沿用上次读数`,
    };
  return { ok: false, reason: result.reason };
}

/** 下次什么时候再真去请求（纯函数）。 */
function nextReadAt(result: ReadResult, now: number): number {
  if (result.ok) return now + OK_TTL_MS;
  return Math.max(now + FAILED_TTL_MS, result.retryAt ?? 0);
}

export class QuotaReaders {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();

  constructor(
    private readonly deps: ReaderDeps,
    private readonly readers: readonly Reader[] = READERS,
  ) {}

  /** 各账号的读取结论；缓存未到期不发请求。 */
  async read(): Promise<Map<string, ReaderOutcome>> {
    const entries = await Promise.all(
      this.readers.map(
        async (reader) => [reader.provider, await this.entry(reader)] as const,
      ),
    );
    const now = this.deps.now();
    return new Map(
      entries.map(([provider, entry]) => [
        provider,
        outcomeOf(entry.result, entry.lastGood, now),
      ]),
    );
  }

  private entry(reader: Reader): Promise<Entry> {
    const cached = this.entries.get(reader.provider);
    if (cached && this.deps.now() < cached.nextAt)
      return Promise.resolve(cached);
    const running = this.inflight.get(reader.provider);
    if (running) return running;
    const task = this.refresh(reader, cached).finally(() =>
      this.inflight.delete(reader.provider),
    );
    this.inflight.set(reader.provider, task);
    return task;
  }

  private async refresh(reader: Reader, cached: Entry | undefined) {
    let result: ReadResult;
    try {
      result = await reader.read(this.deps);
    } catch {
      // 读取器自己的意外报错不外传原文（可能带路径以外的细节）。
      result = { ok: false, reason: `读取 ${reader.provider} 额度时出错` };
    }
    const now = this.deps.now();
    const entry: Entry = {
      result,
      lastGood: result.ok ? result : cached?.lastGood,
      nextAt: nextReadAt(result, now),
    };
    this.entries.set(reader.provider, entry);
    return entry;
  }
}

function currentPlatform(): Platform {
  return process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** macOS 钥匙串：经 /usr/bin/security 读（Claude Code 自己也是这样写的，读时不弹授权框）。 */
function readKeychain(
  service: string,
  account: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  args.push("-w");
  return runFile(SECURITY, args, {
    timeout: KEYCHAIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { PATH: env.PATH, HOME: env.HOME, USER: env.USER },
  }).then(({ error, stdout }) => {
    if (!error) return stdout.trim() || undefined;
    if (error.code === ITEM_NOT_FOUND) return undefined;
    throw new Error("钥匙串读取失败");
  });
}

export function defaultReaderDeps(
  env: NodeJS.ProcessEnv = process.env,
): ReaderDeps {
  return {
    platform: currentPlatform(),
    home: env.HOME || env.USERPROFILE || homedir(),
    env,
    readFile: readTextFile,
    keychain: (service, account) => readKeychain(service, account, env),
    fetch: globalThis.fetch,
    now: Date.now,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

/** 自带读取是否开着：显式关掉或在 node:test 进程里都不开。 */
export function readersEnabled(env: NodeJS.ProcessEnv = process.env) {
  const flag = env.ATRIUM_QUOTA_READERS?.trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  return !env.NODE_TEST_CONTEXT;
}

let shared: QuotaReaders | null | undefined;

/** 服务进程共用的一份（缓存跨请求有效）；关掉时为 null。 */
export function sharedQuotaReaders(): QuotaReaders | null {
  if (shared === undefined)
    shared = readersEnabled() ? new QuotaReaders(defaultReaderDeps()) : null;
  return shared;
}
