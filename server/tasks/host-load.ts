import { availableParallelism, loadavg } from "node:os";

/**
 * 本机减负（#358 第 0 步）：同时在跑的执行者上限、本地检查并发上限、注入给执行者与检查的测试并发，
 * 以及系统负载过高时暂停派新活。判定与读配置是纯函数；采样（核数、1 分钟负载）在 HostLoad 里。
 *
 * 配置（服务环境变量，缺省按核数）：
 * - ATRIUM_MAX_WORKERS：同时在跑的执行者上限，缺省核数的 3/4（至少 2）；0 或 off 不限。
 * - ATRIUM_MAX_CHECKS：本地检查同时跑几个，缺省核数的 1/4（至少 1）。
 * - ATRIUM_TEST_CONCURRENCY：注入执行者与本地检查的测试并发，缺省核数的 1/4（至少 1）。
 * - ATRIUM_BUSY_LOAD：1 分钟负载超过多少暂停派新活，缺省 2×核数；0 或 off 不看负载。
 */

export type HostLimits = {
  cores: number;
  /** 同时在跑（含正在启动）的执行者上限；null 不限。 */
  maxWorkers: number | null;
  maxChecks: number;
  testConcurrency: number;
  /** 1 分钟负载超过它就暂停派新活；null 不看负载。 */
  busyLoad: number | null;
};

export type HostGate =
  { ok: true } | { ok: false; busy: boolean; reason: string };

const OFF = new Set(["0", "off", "none", "false"]);

/** 正整数；0/off 在允许时表示不限（null）；其余写法返回 undefined 让调用方用缺省并提示。 */
function parseCount(
  raw: string | undefined,
  allowOff: boolean,
): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim().toLowerCase();
  if (allowOff && OFF.has(text)) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(text)) return undefined;
  return Number(text);
}

function parseLoad(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value < 1e6 ? value : undefined;
}

/**
 * 读配置。problems 列出写错的变量（照缺省执行，由服务记日志）。
 * node:test 派生的进程（测试与测试起的隔离服务）没显式设置时不限执行者数、不看负载：
 * 测试机的负载不能让用例排队；显式设置照样生效，测试据此验证闸门。
 */
export function hostLimits(
  env: NodeJS.ProcessEnv,
  cores: number,
): { limits: HostLimits; problems: string[] } {
  const n = Math.max(1, Math.floor(cores));
  const testing = !!env.NODE_TEST_CONTEXT;
  const problems: string[] = [];
  const pick = <T>(name: string, parsed: T | undefined, fallback: T): T => {
    if (parsed !== undefined) return parsed;
    if (env[name] !== undefined && env[name]!.trim() !== "")
      problems.push(`${name}=${env[name]} 看不懂，按缺省执行`);
    return fallback;
  };
  const quarter = Math.max(1, Math.floor(n / 4));
  return {
    limits: {
      cores: n,
      maxWorkers: pick(
        "ATRIUM_MAX_WORKERS",
        parseCount(env.ATRIUM_MAX_WORKERS, true),
        testing ? null : Math.max(2, Math.floor((n * 3) / 4)),
      ),
      maxChecks: pick(
        "ATRIUM_MAX_CHECKS",
        parseCount(env.ATRIUM_MAX_CHECKS, false) ?? undefined,
        quarter,
      ),
      testConcurrency: pick(
        "ATRIUM_TEST_CONCURRENCY",
        parseCount(env.ATRIUM_TEST_CONCURRENCY, false) ?? undefined,
        quarter,
      ),
      busyLoad: pick(
        "ATRIUM_BUSY_LOAD",
        parseLoad(env.ATRIUM_BUSY_LOAD),
        testing ? null : 2 * n,
      ),
    },
    problems,
  };
}

const loadText = (load: number) =>
  load >= 10 ? load.toFixed(0) : load.toFixed(1);

/** 能不能再拉起一个执行者：先看负载（太忙），再看并发上限。running 是除本任务外在跑与正在启动的。 */
export function hostGate(input: {
  running: number;
  load: number;
  limits: HostLimits;
}): HostGate {
  const { running, load, limits } = input;
  if (limits.busyLoad !== null && load > limits.busyLoad)
    return {
      ok: false,
      busy: true,
      reason: `本机太忙（负载 ${loadText(load)}，超过 ${loadText(limits.busyLoad)}），负载降下来后自动拉起`,
    };
  if (limits.maxWorkers !== null && running >= limits.maxWorkers)
    return {
      ok: false,
      busy: false,
      reason: `本机同时最多跑 ${limits.maxWorkers} 个执行者，有执行者结束后自动拉起`,
    };
  return { ok: true };
}

/** 本机状态（`top` 的抬头与 `--json` 用）。 */
export type HostView = {
  cores: number;
  load: number;
  busy_load: number | null;
  running: number;
  max_workers: number | null;
  checks: { running: number; waiting: number; max: number };
  test_concurrency: number;
  /** 暂停派新活的原因；没暂停为 null。 */
  paused: string | null;
};

export function hostView(input: {
  limits: HostLimits;
  load: number;
  running: number;
  checks: { running: number; waiting: number };
}): HostView {
  const gate = hostGate({
    running: input.running,
    load: input.load,
    limits: input.limits,
  });
  return {
    cores: input.limits.cores,
    load: Math.round(input.load * 100) / 100,
    busy_load: input.limits.busyLoad,
    running: input.running,
    max_workers: input.limits.maxWorkers,
    checks: { ...input.checks, max: input.limits.maxChecks },
    test_concurrency: input.limits.testConcurrency,
    paused: gate.ok ? null : gate.reason,
  };
}

/** 采样：核数与 1 分钟负载（Windows 上 loadavg 恒为 0，等于不看负载）。 */
export class HostLoad {
  constructor(
    readonly limits: HostLimits,
    private readonly sample: () => number = () => loadavg()[0] ?? 0,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    const { limits, problems } = hostLimits(env, availableParallelism());
    for (const problem of problems) console.error(`本机减负配置：${problem}`);
    return new HostLoad(limits);
  }

  load() {
    try {
      const value = this.sample();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  gate(running: number) {
    return hostGate({ running, load: this.load(), limits: this.limits });
  }
}
