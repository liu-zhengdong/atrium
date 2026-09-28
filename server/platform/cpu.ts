import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { cpus } from "node:os";
import {
  atriumTree,
  cpuSource,
  environValue,
  envSource,
  parsePs,
  parsePsEnv,
  parseProcStat,
  parseWindowsPerf,
  treeCores,
  type CpuSnapshot,
  type Platform,
  type ProcCpu,
  type SystemCpu,
} from "./cpu-plan.ts";

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

/** 跑命令取输出；partial 时退出码非 0 但有输出也收下（`ps -p` 列的进程有的已退出）。 */
function run(command: string, args: string[], partial = false) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) =>
        error && !(partial && typeof error.code === "number")
          ? reject(error)
          : resolve(stdout),
    ),
  );
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
  return {
    kind: source.read,
    at: now(),
    procs: source.read === "rate" ? parseWindowsPerf(text) : parsePs(text),
    system: systemCpu(),
  };
}

/** 读这些进程的环境变量 name：pid → 值（没有这个变量或读不到的不在结果里）；平台读不到时为 null。 */
export async function readEnv(
  pids: readonly number[],
  name: string,
  platform: Platform = process.platform,
): Promise<Map<number, string> | null> {
  const source = envSource(platform, pids);
  if (!source) return null;
  if (!pids.length) return new Map();
  if (source.kind === "command")
    return parsePsEnv(await run(source.command, source.args, true), name);
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

/** 认 Atrium 标记：环境变量名与值的前缀（本服务的标记）。 */
export type SpawnMark = { name: string; prefix: string };
export type MarkedProc = { pid: number; mark: string };

/** 一次最多查多少个进程的环境（启动后第一次要查全机，分几轮查完）。 */
const LOOKUP_BATCH = 400;

/**
 * Atrium 进程树的 CPU：每次 refresh 采一次样，cores() 给最近一次的结果。
 * 树 = 服务的后代 + 接管来的执行者 + 上次在树里、现在还活着的（父进程退出后被 1 号收养也照算）
 * + 带本服务标记的进程（mark；环境变量随子孙继承，服务重启后也认得出），各自连同后代。
 * 标记查环境要起命令或读文件，只查没查过的进程，且至少隔 lookupMs 查一次。
 * orphans() 给带标记、却已不在服务与执行者名下的进程，巡检据此清理任务早已结束的孤儿。
 */
export class ProcessCpu {
  private last: CpuSnapshot | null = null;
  private lastTree = new Set<number>();
  private value: number | null = null;
  private stray: MarkedProc[] = [];
  /** 查过环境的进程：pid → 标记值（没有为 null）。 */
  private readonly marks = new Map<number, string | null>();
  private lookedAt = -Infinity;
  private running: Promise<void> | null = null;

  constructor(
    private readonly take: () => Promise<CpuSnapshot> = () => snapshot(),
    private readonly service = process.pid,
    private readonly options: {
      mark?: SpawnMark;
      lookup?: typeof readEnv;
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
        const marked = await this.marked(current.procs, owned, alive);
        const lastCpu = new Map(
          (this.last?.procs ?? []).map((proc) => [proc.pid, proc.cpu]),
        );
        // 累计读数变小是 pid 被复用了，不再是上次那个进程。
        const kept = [...this.lastTree].filter((pid) => {
          const cpu = alive.get(pid)?.cpu;
          if (cpu === undefined) return false;
          return current.kind === "rate" || cpu >= (lastCpu.get(pid) ?? 0);
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

  /** 带本服务标记的活进程；到点时顺带查一批新进程的环境（查不了不影响 CPU 读数）。 */
  private async marked(
    procs: readonly ProcCpu[],
    owned: ReadonlySet<number>,
    alive: ReadonlyMap<number, ProcCpu>,
  ): Promise<MarkedProc[]> {
    const mark = this.options.mark;
    // Windows 读不到别的进程的环境，不认标记（只靠进程树与上次的树）。
    if (!mark || (!this.options.lookup && !envSource(process.platform, [])))
      return [];
    for (const pid of this.marks.keys())
      if (!alive.has(pid)) this.marks.delete(pid);
    const now = (this.options.now ?? Date.now)();
    if (now - this.lookedAt >= (this.options.lookupMs ?? 30_000)) {
      const unknown = procs
        .filter(
          (proc) =>
            proc.pid !== this.service &&
            !owned.has(proc.pid) &&
            !this.marks.has(proc.pid),
        )
        .slice(0, LOOKUP_BATCH)
        .map((proc) => proc.pid);
      if (unknown.length) {
        this.lookedAt = now;
        const found = await (this.options.lookup ?? readEnv)(
          unknown,
          mark.name,
        ).catch(() => null);
        if (found)
          for (const pid of unknown)
            this.marks.set(pid, found.get(pid) ?? null);
      }
    }
    const marked: MarkedProc[] = [];
    for (const [pid, value] of this.marks)
      if (value?.startsWith(mark.prefix) && pid !== this.service)
        marked.push({ pid, mark: value });
    return marked;
  }
}
