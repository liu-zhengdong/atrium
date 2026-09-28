/**
 * Atrium 自己占了几个核（t113）：按平台列全机进程（pid、父 pid、CPU），圈出服务起的进程树，
 * 换算成核数。这里全是纯函数（按平台穷举测试）；跑命令、读 /proc 在 `cpu.ts`。
 * 与 t94 平台层同一分法：判定在 `*-plan.ts`，IO 在旁边的模块。
 *
 * 两种读数：
 * - 累计（macOS `ps` 的 time、Linux /proc 的 utime+stime）：两次采样相减再除以间隔；
 * - 瞬时（Windows 性能计数器 PercentProcessorTime，单核 100%）：直接相加。
 *
 * 只数两次采样时都活着的进程会严重少算（t203：整机负载 97 只报 0.82 核）：
 * - `node --test` 每个测试文件一个子进程，两次采样之间起了又退的进程一次都看不到，退出前最后一段也丢；
 *   Linux 上父进程收回子进程时内核把子进程的累计并进父进程（/proc 的 cutime+cstime），一起算上就不漏；
 *   macOS 的 `ps` 拿不到这一项，改用整机忙碌时间减去看得见的进程，差额按进出进程的多少分给 Atrium。
 * - 父进程先退出的子孙（执行者退出后留在后台的测试、执行者起的隔离服务）被 1 号进程收养，
 *   按父子关系就不在树里了：上次在树里的进程只要还活着就继续算，带 Atrium 标记环境变量的进程也算。
 */

import type { Invocation, Platform } from "./plan.ts";

export type { Invocation, Platform };

/**
 * 一个进程的读数：cpu 在累计读数里是秒（只算它自己），在瞬时读数里是核数；
 * children 是它已收回的子进程的累计秒数（只有 Linux 有）。
 */
export type ProcCpu = {
  pid: number;
  ppid: number;
  cpu: number;
  children?: number;
};

/** 整机累计 CPU 时间（os.cpus 各核相加，单位不论）：忙的、总的，与核数。 */
export type SystemCpu = { busy: number; total: number; cores: number };

export type CpuSnapshot = {
  kind: "total" | "rate";
  at: number;
  procs: ProcCpu[];
  system?: SystemCpu;
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

/**
 * 怎么读别的进程的环境变量（认 Atrium 标记用）：Linux 读 /proc/<pid>/environ；
 * macOS 等用 `ps -E`（环境接在命令行后面，只看得到自己用户的进程）；Windows 读不到，为 null。
 */
export function envSource(
  platform: Platform,
  pids: readonly number[],
): { kind: "proc" } | ({ kind: "command" } & Invocation) | null {
  if (platform === "win32") return null;
  if (platform === "linux" || platform === "android") return { kind: "proc" };
  return {
    kind: "command",
    command: "ps",
    args: ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")],
  };
}

const envToken = (name: string) => new RegExp(`(?:^|\\s)${name}=(\\S+)`);

/** `ps -E -o pid=,command=` 的输出里取出带 name 变量的进程：pid → 值。 */
export function parsePsEnv(text: string, name: string): Map<number, string> {
  const found = new Map<number, string>();
  const token = envToken(name);
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    const pid = pidOf(match?.[1]);
    const value = match ? token.exec(match[2]!)?.[1] : undefined;
    if (pid !== null && value !== undefined) found.set(pid, value);
  }
  return found;
}

/** /proc/<pid>/environ（NUL 分隔）里 name 的值；没有为 null。 */
export function environValue(text: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const entry of text.split("\0"))
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  return null;
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
  return text !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
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
 * 父 pid 是第 4 个字段，utime、stime 是第 14、15 个，已收回子进程的 cutime、cstime 是第 16、17 个（时钟节拍）。
 * 看不懂为 null。
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
  const [utime, stime, cutime, cstime] = fields
    .slice(11, 15)
    .map((field) => Number(field));
  if (
    ppid === null ||
    fields.length < 15 ||
    ![utime, stime, cutime, cstime].every(Number.isFinite)
  )
    return null;
  return {
    pid,
    ppid,
    cpu: (utime! + stime!) / ticksPerSecond,
    children: (cutime! + cstime!) / ticksPerSecond,
  };
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
 * 加上 extra 里还活着的进程及其后代（服务重启后接管来的执行者、上次在树里后来被 1 号进程收养的、
 * 带 Atrium 标记的孤儿）。父子关系成环也不死循环。
 */
export function atriumTree(
  procs: readonly ProcCpu[],
  roots: {
    service: number;
    adopted?: readonly number[];
    extra?: readonly number[];
  },
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
    ...[...(roots.adopted ?? []), ...(roots.extra ?? [])].filter(
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
 *
 * 两次采样之间退出的进程：
 * - 有 children（Linux）：退出的进程被父进程收回后，它的累计（连同它收回的）整段并进父进程的 children。
 *   按上次的父子关系往上找第一个还活着的祖先，是树里的进程或服务本身（服务只算 children 的增量），
 *   它的增量里已含退出进程的整段，减掉上次已经算过的那部分；父子一起退出、孙子先被 1 号收养的，
 *   这一轮会少算一点，结果不低于 0。
 * - 没有 children（macOS）：整机忙碌时间减去所有看得见的进程的增量，就是这段时间里退出的进程
 *   （和内核）用掉的；按新起、退出的进程里 Atrium 的占比分给 Atrium。别的用户的进程读不到 CPU 时，
 *   它们用的也会混进差额，所以只是估算；结果不超过整机用掉的。
 */
export function treeCores(
  previous: CpuSnapshot | null,
  current: CpuSnapshot,
  tree: ReadonlySet<number>,
  context: { previousTree?: ReadonlySet<number>; service?: number } = {},
): number | null {
  if (current.kind === "rate") {
    let sum = 0;
    for (const proc of current.procs) if (tree.has(proc.pid)) sum += proc.cpu;
    return round(sum);
  }
  if (!previous || previous.kind !== "total") return null;
  const seconds = (current.at - previous.at) / 1000;
  if (!(seconds >= 0.5)) return null;
  const before = new Map(previous.procs.map((proc) => [proc.pid, proc]));
  const alive = new Map(current.procs.map((proc) => [proc.pid, proc]));
  const previousTree = context.previousTree ?? new Set<number>();
  const reaped = current.procs.some((proc) => proc.children !== undefined);
  const total = (proc: ProcCpu) => proc.cpu + (proc.children ?? 0);
  const grown = (proc: ProcCpu) => {
    const last = before.get(proc.pid);
    return last === undefined || total(proc) < total(last)
      ? total(proc)
      : total(proc) - total(last);
  };
  let used = 0;
  let visible = 0;
  let born = 0;
  let bornOwn = 0;
  for (const proc of current.procs) {
    const grew = grown(proc);
    visible += grew;
    if (tree.has(proc.pid)) used += grew;
    if (!before.has(proc.pid)) {
      born++;
      if (tree.has(proc.pid)) bornOwn++;
    }
  }
  const service =
    context.service === undefined ? undefined : alive.get(context.service);
  const serviceBefore =
    context.service === undefined ? undefined : before.get(context.service);
  const serviceReaped =
    service?.children !== undefined && serviceBefore?.children !== undefined;
  if (serviceReaped)
    used += Math.max(0, service.children! - serviceBefore.children!);
  // 退出的进程按上次的父子关系往上找第一个还活着的祖先。
  const survivor = (proc: ProcCpu) => {
    const seen = new Set<number>();
    let pid = proc.ppid;
    while (!alive.has(pid)) {
      const up = before.get(pid);
      if (!up || seen.has(pid)) return null;
      seen.add(pid);
      pid = up.ppid;
    }
    return pid;
  };
  let gone = 0;
  let goneOwn = 0;
  for (const last of previous.procs) {
    if (alive.has(last.pid)) continue;
    gone++;
    if (!previousTree.has(last.pid)) continue;
    goneOwn++;
    if (last.children === undefined) continue;
    const into = survivor(last);
    if (
      into !== null &&
      (tree.has(into) || (serviceReaped && into === context.service))
    )
      used -= total(last);
  }
  const system = systemSeconds(previous.system, current.system, seconds);
  if (!reaped && system !== null && born + gone > 0)
    used +=
      (Math.max(0, system - visible) * (bornOwn + goneOwn)) / (born + gone);
  used = Math.max(0, used);
  if (system !== null) used = Math.min(used, system);
  return round(used / seconds);
}

/** 两次整机读数之间用掉的 CPU 秒数（忙的占比 × 核数 × 间隔，单位不论）；读数不全或倒退为 null。 */
function systemSeconds(
  previous: SystemCpu | undefined,
  current: SystemCpu | undefined,
  seconds: number,
): number | null {
  if (!previous || !current) return null;
  const busy = current.busy - previous.busy;
  const total = current.total - previous.total;
  if (!(total > 0) || busy < 0) return null;
  return (Math.min(busy, total) / total) * current.cores * seconds;
}

const round = (value: number) => Math.round(value * 100) / 100;
