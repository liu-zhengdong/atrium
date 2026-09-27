/**
 * Atrium 自己占了几个核（t113）：按平台列全机进程（pid、父 pid、CPU），圈出服务起的进程树，
 * 换算成核数。这里全是纯函数（按平台穷举测试）；跑命令、读 /proc 在 `cpu.ts`。
 * 与 t94 平台层同一分法：判定在 `*-plan.ts`，IO 在旁边的模块。
 *
 * 两种读数：
 * - 累计（macOS `ps` 的 time、Linux /proc 的 utime+stime）：两次采样相减再除以间隔；
 * - 瞬时（Windows 性能计数器 PercentProcessorTime，单核 100%）：直接相加。
 */

export type Platform = NodeJS.Platform;

/** 一次进程调用。 */
export type Invocation = { command: string; args: string[] };

/** 一个进程的读数：cpu 在累计读数里是秒，在瞬时读数里是核数。 */
export type ProcCpu = { pid: number; ppid: number; cpu: number };
export type CpuSnapshot = {
  kind: "total" | "rate";
  at: number;
  procs: ProcCpu[];
};

/**
 * 怎么列进程：Linux 直接读 /proc（不起进程，精度到时钟节拍）；
 * macOS 用 `ps`（time 是累计 CPU，分:秒.百分秒）；Windows 经 PowerShell 查性能计数器
 * （[wmisearcher] 是内置类型，不靠模块自动加载，白名单环境里也能用）。
 */
export function cpuSource(
  platform: Platform,
):
  | { kind: "proc" }
  | ({ kind: "command"; read: "total" | "rate" } & Invocation) {
  if (platform === "linux" || platform === "android") return { kind: "proc" };
  if (platform === "win32")
    return {
      kind: "command",
      read: "rate",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "([wmisearcher]'SELECT IDProcess,CreatingProcessID,PercentProcessorTime FROM Win32_PerfFormattedData_PerfProc_Process').Get() | ForEach-Object { \"$($_.IDProcess) $($_.CreatingProcessID) $($_.PercentProcessorTime)\" }",
      ],
    };
  return {
    kind: "command",
    read: "total",
    command: "ps",
    args: ["-A", "-o", "pid=,ppid=,time="],
  };
}

/** `ps` 的累计 CPU：`[[天-]时:]分:秒[.小数]`（macOS 分钟可超过 60，procps 是时:分:秒）；看不懂为 null。 */
export function cpuTimeSeconds(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

const pidOf = (text: string | undefined) => {
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/** `ps -A -o pid=,ppid=,time=` 的输出；坏行跳过。 */
export function parsePs(text: string): ProcCpu[] {
  const procs: ProcCpu[] = [];
  for (const line of text.split("\n")) {
    const [pidText, ppidText, time] = line.trim().split(/\s+/);
    const pid = pidOf(pidText);
    const ppid = pidOf(ppidText);
    const cpu = time === undefined ? null : cpuTimeSeconds(time);
    if (pid !== null && ppid !== null && cpu !== null)
      procs.push({ pid, ppid, cpu });
  }
  return procs;
}

/**
 * /proc/<pid>/stat 一行：进程名在括号里、可能带空格和括号，从最后一个 `)` 往后数字段；
 * 父 pid 是第 4 个字段，utime、stime 是第 14、15 个（时钟节拍）。看不懂为 null。
 */
export function parseProcStat(text: string, ticksPerSecond = 100) {
  const close = text.lastIndexOf(")");
  const pid = pidOf(text.slice(0, text.indexOf("(")).trim());
  if (close < 0 || pid === null) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields[0] 是状态（第 3 个字段），往后依次顺延。
  const ppid = pidOf(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (ppid === null || !Number.isFinite(utime) || !Number.isFinite(stime))
    return null;
  return { pid, ppid, cpu: (utime + stime) / ticksPerSecond };
}

/** PowerShell 输出的「pid 父pid 百分比」行：百分比按单核 100% 换成核数；_Total、Idle（pid 0）不计。 */
export function parseWindowsPerf(text: string): ProcCpu[] {
  const procs: ProcCpu[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pidText, ppidText, percentText] = line.trim().split(/\s+/);
    const pid = pidOf(pidText);
    const ppid = pidOf(ppidText);
    const percent = Number(percentText);
    if (pid && ppid !== null && Number.isFinite(percent) && percent >= 0)
      procs.push({ pid, ppid, cpu: percent / 100 });
  }
  return procs;
}

/**
 * Atrium 的进程树：服务的全部后代（执行者、本地检查、合入检查，以及它们的子进程；不含服务本身），
 * 加上服务重启后接管来的执行者（父进程已是 1）及其后代。父子关系成环也不死循环。
 */
export function atriumTree(
  procs: readonly ProcCpu[],
  roots: { service: number; adopted?: readonly number[] },
): Set<number> {
  const children = new Map<number, number[]>();
  for (const proc of procs) {
    if (proc.pid === proc.ppid) continue;
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const alive = new Set(procs.map((proc) => proc.pid));
  const tree = new Set<number>();
  const stack = [
    ...(children.get(roots.service) ?? []),
    ...(roots.adopted ?? []).filter(
      (pid) => pid !== roots.service && alive.has(pid),
    ),
  ];
  while (stack.length) {
    const pid = stack.pop()!;
    if (pid === roots.service || tree.has(pid)) continue;
    tree.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/**
 * 进程树占了几个核。瞬时读数直接相加；累计读数与上一次采样相减、除以间隔：
 * 上一次没有的进程（新起的）按它的全部累计算；累计变小（pid 被复用）也按新进程算。
 * 没有上一次、间隔不到 0.5 秒或种类不同时为 null（不知道，不拿来挡派活）。
 */
export function treeCores(
  previous: CpuSnapshot | null,
  current: CpuSnapshot,
  tree: ReadonlySet<number>,
): number | null {
  if (current.kind === "rate") {
    let sum = 0;
    for (const proc of current.procs) if (tree.has(proc.pid)) sum += proc.cpu;
    return round(sum);
  }
  if (!previous || previous.kind !== "total") return null;
  const seconds = (current.at - previous.at) / 1000;
  if (!(seconds >= 0.5)) return null;
  const before = new Map(previous.procs.map((proc) => [proc.pid, proc.cpu]));
  let used = 0;
  for (const proc of current.procs) {
    if (!tree.has(proc.pid)) continue;
    const last = before.get(proc.pid);
    used += last === undefined || proc.cpu < last ? proc.cpu : proc.cpu - last;
  }
  return round(used / seconds);
}

const round = (value: number) => Math.round(value * 100) / 100;
