import { readdir, readFile } from "node:fs/promises";
import { cpus } from "node:os";
import {
  atriumTree,
  cpuSource,
  cwdInvocation,
  environValue,
  markSource,
  parseLsofCwd,
  parsePs,
  parseProcStat,
  parseWindowsPerf,
  sameProcess,
  treeCores,
  type CpuSnapshot,
  type Platform,
  type ProcCpu,
  type SystemCpu,
} from "./cpu-plan.ts";
import { runFile } from "./index.ts";

/**
 * Atrium 自己占了几个核的采样（t113）：判定在 `cpu-plan.ts`；这里列进程（跑命令或读 /proc）、
 * 记住上一次的读数。采样失败只让读数变成「不知道」（null），不抛给调用方。
 */

async function readProc(): Promise<ProcCpu[]> {
  const procs: ProcCpu[] = [];
  const names = await readdir("/proc");
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const proc = parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"));
      if (proc) procs.push(proc);
    } catch {
      // 读的时候进程刚退出。
    }
  }
  return procs;
}

/** 跑命令取输出；partial 时退出码非 0 但有输出也收下（`lsof -p` 列的进程有的已退出）。 */
async function run(command: string, args: string[], partial = false) {
  const { error, stdout } = await runFile(command, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (error && !(partial && typeof error.code === "number")) throw error;
  return stdout;
}

function systemCpu(): SystemCpu | undefined {
  const list = cpus();
  if (!list.length) return undefined;
  let busy = 0;
  let total = 0;
  for (const { times } of list) {
    const used = times.user + times.nice + times.sys + times.irq;
    busy += used;
    total += used + times.idle;
  }
  return { busy, total, cores: list.length };
}

export async function snapshot(
  platform: Platform = process.platform,
  now = Date.now,
): Promise<CpuSnapshot> {
  const source = cpuSource(platform);
  if (source.kind === "proc")
    return {
      kind: "total",
      at: now(),
      procs: await readProc(),
      system: systemCpu(),
    };
  const text = await run(source.command, source.args);
  const at = now();
  return {
    kind: source.read,
    at,
    procs: source.read === "rate" ? parseWindowsPerf(text) : parsePs(text, at),
    system: systemCpu(),
  };
}

/** 读这些进程的环境变量 name（只有 Linux 读得到）：pid → 值（没有这个变量或读不到的不在结果里）；别的平台为 null。 */
export async function readEnv(
  pids: readonly number[],
  name: string,
  platform: Platform = process.platform,
): Promise<Map<number, string> | null> {
  if (markSource(platform) !== "env") return null;
  const found = new Map<number, string>();
  for (const pid of pids) {
    try {
      const value = environValue(
        await readFile(`/proc/${pid}/environ`, "utf8"),
        name,
      );
      if (value !== null) found.set(pid, value);
    } catch {
      // 已退出或是别的用户的进程。
    }
  }
  return found;
}

/** 读这些进程的工作目录（macOS 等用 lsof）：pid → 路径（读不到的不在结果里）；Linux、Windows 为 null。 */
export async function readCwd(
  pids: readonly number[],
  platform: Platform = process.platform,
): Promise<Map<number, string> | null> {
  if (markSource(platform) !== "cwd") return null;
  if (!pids.length) return new Map();
  const { command, args } = cwdInvocation(pids);
  return parseLsofCwd(await run(command, args, true));
}

/**
 * 认 Atrium 拉起的进程：prefix 是本服务标记的前缀；wants 给了时只查它挑中的进程，其余直接当不是
 * （不起命令、不占每轮名额，父进程变了再看）；recognize 查一批进程，给查过的 pid → 标记
 * （查过、不是 Atrium 的为 null；没查的不在结果里，下次再查）；整批查不了为 null。
 */
export type SpawnMark = {
  prefix: string;
  wants?: (proc: ProcCpu) => boolean;
  recognize: (
    procs: readonly ProcCpu[],
  ) => Promise<ReadonlyMap<number, string | null> | null>;
};
export type MarkedProc = { pid: number; mark: string };

/** 一次最多查多少个进程（启动后第一次要查全机，分几轮查完）。 */
const LOOKUP_BATCH = 400;

/**
 * Atrium 进程树的 CPU：每次 refresh 采一次样，cores() 给最近一次的结果。
 * 树 = 服务的后代 + 接管来的执行者 + 上次在树里、现在还活着的（父进程退出后被 1 号收养也照算）
 * + 认得出是本服务拉起的进程（mark；服务重启后也认得出），各自连同后代。
 * 认进程要起命令或读文件，只查没查过的进程（父进程变了、pid 被复用了重查），且至少隔 lookupMs 查一次；
 * 服务自己和它的祖先（守护进程）不查。
 * orphans() 给带标记、却已不在服务与执行者名下的进程，巡检据此清理任务早已结束的孤儿。
 */
export class ProcessCpu {
  private last: CpuSnapshot | null = null;
  private lastTree = new Set<number>();
  private value: number | null = null;
  private stray: MarkedProc[] = [];
  /** 查过的进程：pid → 标记值（没有为 null）与查时的读数。 */
  private readonly marks = new Map<
    number,
    { mark: string | null; proc: ProcCpu }
  >();
  private lookedAt = -Infinity;
  private running: Promise<void> | null = null;

  constructor(
    private readonly take: () => Promise<CpuSnapshot> = () => snapshot(),
    private readonly service = process.pid,
    private readonly options: {
      mark?: SpawnMark;
      lookupMs?: number;
      now?: () => number;
    } = {},
  ) {}

  cores() {
    return this.value;
  }

  /** 带本服务标记、不在服务与执行者名下的进程。 */
  orphans(): readonly MarkedProc[] {
    return this.stray;
  }

  /** adopted：服务重启后接管来的执行者 pid（父进程已不是服务）。同时来的几次合成一次。 */
  refresh(adopted: readonly number[] = []) {
    this.running ??= (async () => {
      try {
        const current = await this.take();
        const alive = new Map(current.procs.map((proc) => [proc.pid, proc]));
        const owned = atriumTree(current.procs, {
          service: this.service,
          adopted,
        });
        const marked = await this.marked(current, owned, alive);
        const lastProcs = new Map(
          (this.last?.procs ?? []).map((proc) => [proc.pid, proc]),
        );
        // 累计读数变小、启动时刻对不上是 pid 被复用了，不再是上次那个进程。
        const kept = [...this.lastTree].filter((pid) => {
          const now = alive.get(pid);
          const before = lastProcs.get(pid);
          if (!now) return false;
          return !before || sameProcess(before, now, current.kind);
        });
        const tree = atriumTree(current.procs, {
          service: this.service,
          adopted,
          extra: [...kept, ...marked.map((proc) => proc.pid)],
        });
        this.value = treeCores(this.last, current, tree, {
          previousTree: this.lastTree,
          service: this.service,
        });
        this.stray = marked.filter((proc) => !owned.has(proc.pid));
        this.last = current;
        this.lastTree = tree;
      } catch {
        this.value = null;
        this.last = null;
        this.lastTree = new Set();
        this.stray = [];
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** 认得出是本服务拉起的活进程；到点时顺带查一批新进程（查不了不影响 CPU 读数）。 */
  private async marked(
    current: CpuSnapshot,
    owned: ReadonlySet<number>,
    alive: ReadonlyMap<number, ProcCpu>,
  ): Promise<MarkedProc[]> {
    const mark = this.options.mark;
    if (!mark) return [];
    for (const [pid, known] of this.marks) {
      const now = alive.get(pid);
      if (
        !now ||
        now.ppid !== known.proc.ppid ||
        !sameProcess(known.proc, now, current.kind)
      )
        this.marks.delete(pid);
    }
    // 服务自己与祖先（守护进程、被 1 号收养前的启动器）不认。
    const skip = new Set<number>();
    for (
      let pid: number | undefined = this.service;
      pid !== undefined && pid > 1 && !skip.has(pid);
      pid = alive.get(pid)?.ppid
    )
      skip.add(pid);
    const now = (this.options.now ?? Date.now)();
    if (now - this.lookedAt >= (this.options.lookupMs ?? 30_000)) {
      const unknown: ProcCpu[] = [];
      for (const proc of current.procs) {
        if (
          skip.has(proc.pid) ||
          owned.has(proc.pid) ||
          this.marks.has(proc.pid)
        )
          continue;
        if (mark.wants && !mark.wants(proc))
          this.marks.set(proc.pid, { mark: null, proc });
        else if (unknown.length < LOOKUP_BATCH) unknown.push(proc);
      }
      if (unknown.length) {
        this.lookedAt = now;
        const found = await mark.recognize(unknown).catch(() => null);
        if (found)
          for (const proc of unknown)
            if (found.has(proc.pid))
              this.marks.set(proc.pid, { mark: found.get(proc.pid)!, proc });
      }
    }
    const marked: MarkedProc[] = [];
    for (const [pid, { mark: value }] of this.marks)
      if (value?.startsWith(mark.prefix) && !skip.has(pid))
        marked.push({ pid, mark: value });
    return marked;
  }
}
