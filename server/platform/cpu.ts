import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import {
  atriumTree,
  cpuSource,
  parsePs,
  parseProcStat,
  parseWindowsPerf,
  treeCores,
  type CpuSnapshot,
  type Platform,
  type ProcCpu,
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

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

export async function snapshot(
  platform: Platform = process.platform,
  now = Date.now,
): Promise<CpuSnapshot> {
  const source = cpuSource(platform);
  if (source.kind === "proc")
    return { kind: "total", at: now(), procs: await readProc() };
  const text = await run(source.command, source.args);
  return {
    kind: source.read,
    at: now(),
    procs: source.read === "rate" ? parseWindowsPerf(text) : parsePs(text),
  };
}

/** Atrium 进程树的 CPU：每次 refresh 采一次样，cores() 给最近一次的结果。 */
export class ProcessCpu {
  private last: CpuSnapshot | null = null;
  private value: number | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly take: () => Promise<CpuSnapshot> = () => snapshot(),
    private readonly service = process.pid,
  ) {}

  cores() {
    return this.value;
  }

  /** adopted：服务重启后接管来的执行者 pid（父进程已不是服务）。同时来的几次合成一次。 */
  refresh(adopted: readonly number[] = []) {
    this.running ??= (async () => {
      try {
        const current = await this.take();
        const tree = atriumTree(current.procs, {
          service: this.service,
          adopted,
        });
        this.value = treeCores(this.last, current, tree);
        this.last = current;
      } catch {
        this.value = null;
        this.last = null;
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
