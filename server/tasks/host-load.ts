import { availableParallelism, loadavg } from "node:os";
import { ProcessCpu } from "../platform/cpu.ts";

/**
 * 本机减负（#358 第 0 步）：同时在跑的执行者上限、本地检查并发上限、注入给执行者与检查的测试并发，
 * 以及本机太忙时暂停派新活。判定与读配置是纯函数；采样（核数、1 分钟负载、Atrium 进程树 CPU）在 HostLoad 里。
 *
 * 太忙有两条线（t113）：主线只看 Atrium 自己起的进程树占了几个核（执行者及其子进程、本地检查、合入检查），
 * 系统进程（fileproviderd、存储分析）再忙也不挡；整机 1 分钟负载只留一条很高的保护线，防止整台机器已经卡死时还往上加。
 * 标了紧急的任务两条线和执行者上限都不受限（hostGate 的 urgent）。
 *
 * 配置（服务环境变量，缺省按核数）：
 * - ATRIUM_MAX_WORKERS：同时在跑的执行者上限，缺省核数的 3/4（至少 2）；0 或 off 不限。
 * - ATRIUM_MAX_CHECKS：本地检查同时跑几个，缺省核数的 1/4（至少 1）。
 * - ATRIUM_TEST_CONCURRENCY：注入执行者与本地检查的测试并发，缺省核数的 1/4（至少 1）。
 * - ATRIUM_BUSY_CORES：Atrium 进程树占用超过几个核暂停派新活，缺省核数的 3/4；0 或 off 不看。
 * - ATRIUM_BUSY_LOAD：整机 1 分钟负载超过多少暂停派新活（保护线），缺省 4×核数；0 或 off 不看。
 */

export type HostLimits = {
  cores: number;
  /** 同时在跑（含正在启动）的执行者上限；null 不限。 */
  maxWorkers: number | null;
  maxChecks: number;
  testConcurrency: number;
  /** Atrium 进程树占用超过这么多核就暂停派新活；null 不看。 */
  busyCores: number | null;
  /** 整机 1 分钟负载超过它就暂停派新活（保护线）；null 不看负载。 */
  busyLoad: number | null;
};

/** 为什么不能派：own Atrium 自己占得多、load 整机负载过保护线、full 执行者满了。 */
export type HostBlock = "own" | "load" | "full";
export type HostGate =
  { ok: true } | { ok: false; busy: boolean; by: HostBlock; reason: string };

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
      busyCores: pick(
        "ATRIUM_BUSY_CORES",
        parseLoad(env.ATRIUM_BUSY_CORES),
        testing ? null : (n * 3) / 4,
      ),
      busyLoad: pick(
        "ATRIUM_BUSY_LOAD",
        parseLoad(env.ATRIUM_BUSY_LOAD),
        testing ? null : 4 * n,
      ),
    },
    problems,
  };
}

const loadText = (load: number) =>
  load >= 10 ? load.toFixed(0) : load.toFixed(1);

const coreText = (cores: number) =>
  Number.isInteger(cores) ? String(cores) : cores.toFixed(1);

/** 紧急任务的回执与事件里说明跳过了什么。 */
export const URGENT_NOTE = "紧急：跳过本机负载限制";

/**
 * 能不能再拉起一个执行者。running 是除本任务外在跑与正在启动的；own 是 Atrium 进程树占的核数（不知道为 null，不挡）。
 * 先看 Atrium 自己占的，再看整机负载保护线，最后看执行者上限；标了紧急的三条都跳过。
 */
export function hostGate(input: {
  running: number;
  load: number;
  own?: number | null;
  limits: HostLimits;
  urgent?: boolean;
}): HostGate {
  const { running, load, limits } = input;
  const own = input.own ?? null;
  if (input.urgent) return { ok: true };
  if (limits.busyCores !== null && own !== null && own > limits.busyCores)
    return {
      ok: false,
      busy: true,
      by: "own",
      reason: `本机太忙（Atrium 自己占了 ${coreText(own)} 核，超过 ${coreText(limits.busyCores)}），降下来后自动拉起`,
    };
  if (limits.busyLoad !== null && load > limits.busyLoad)
    return {
      ok: false,
      busy: true,
      by: "load",
      reason: `本机太忙（整机负载 ${loadText(load)}，超过 ${loadText(limits.busyLoad)}），降下来后自动拉起`,
    };
  if (limits.maxWorkers !== null && running >= limits.maxWorkers)
    return {
      ok: false,
      busy: false,
      by: "full",
      reason: `本机同时最多跑 ${limits.maxWorkers} 个执行者，有执行者结束后自动拉起`,
    };
  return { ok: true };
}

/**
 * 排队先后（执行者队列与本地检查共用）：紧急的在前，同样紧急的按入队先后，再按任务号。
 */
export function queueOrder(
  a: { urgent: boolean; at: number; id: number },
  b: { urgent: boolean; at: number; id: number },
) {
  return Number(b.urgent) - Number(a.urgent) || a.at - b.at || a.id - b.id;
}

/** 本地检查：紧急的立刻跑、不占并发名额；其余有空位就跑，没有就排队。 */
export function checkPlacement(input: {
  urgent: boolean;
  active: number;
  max: number;
}): "run" | "wait" {
  return input.urgent || input.active < input.max ? "run" : "wait";
}

/** 本机状态（`top` 的抬头与 `--json` 用）。 */
export type HostView = {
  cores: number;
  load: number;
  busy_load: number | null;
  /** Atrium 进程树占的核数；还没采到或采样失败为 null。 */
  own_cores: number | null;
  busy_cores: number | null;
  running: number;
  max_workers: number | null;
  checks: { running: number; waiting: number; max: number };
  test_concurrency: number;
  /** 暂停派新活的原因；没暂停为 null。 */
  paused: string | null;
  /** 哪条线触发的暂停：own Atrium 自己、load 整机负载、full 执行者满；没暂停为 null。 */
  paused_by: HostBlock | null;
};

export function hostView(input: {
  limits: HostLimits;
  load: number;
  own?: number | null;
  running: number;
  checks: { running: number; waiting: number };
}): HostView {
  const gate = hostGate({
    running: input.running,
    load: input.load,
    own: input.own,
    limits: input.limits,
  });
  return {
    cores: input.limits.cores,
    load: Math.round(input.load * 100) / 100,
    busy_load: input.limits.busyLoad,
    own_cores: input.own ?? null,
    busy_cores: input.limits.busyCores,
    running: input.running,
    max_workers: input.limits.maxWorkers,
    checks: { ...input.checks, max: input.limits.maxChecks },
    test_concurrency: input.limits.testConcurrency,
    paused: gate.ok ? null : gate.reason,
    paused_by: gate.ok ? null : gate.by,
  };
}

/** Atrium 进程树 CPU 的来源（平台层 ProcessCpu；测试给假的）。 */
export type OwnCpu = {
  cores(): number | null;
  refresh(adopted?: readonly number[]): Promise<void>;
};

/** 采样：核数、1 分钟负载（Windows 上 loadavg 恒为 0，等于不看负载）与 Atrium 进程树 CPU。 */
export class HostLoad {
  constructor(
    readonly limits: HostLimits,
    private readonly sample: () => number = () => loadavg()[0] ?? 0,
    private readonly cpu: OwnCpu | null = null,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    const { limits, problems } = hostLimits(env, availableParallelism());
    for (const problem of problems) console.error(`本机减负配置：${problem}`);
    // 不看自己占用时不采样，省得每轮巡检列一遍进程。
    return new HostLoad(
      limits,
      undefined,
      limits.busyCores === null ? null : new ProcessCpu(),
    );
  }

  load() {
    try {
      const value = this.sample();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  /** Atrium 进程树占的核数；不知道为 null。 */
  own() {
    try {
      const value = this.cpu?.cores() ?? null;
      return value !== null && Number.isFinite(value) && value >= 0
        ? value
        : null;
    } catch {
      return null;
    }
  }

  /** 巡检时采一次样；adopted 是接管来的执行者 pid。 */
  async refresh(adopted: readonly number[] = []) {
    await this.cpu?.refresh(adopted).catch(() => undefined);
  }

  gate(running: number, urgent = false) {
    return hostGate({
      running,
      load: this.load(),
      own: this.own(),
      limits: this.limits,
      urgent,
    });
  }
}
