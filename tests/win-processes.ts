import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** 夹具拉起的进程（命令行）：pid 与存活时间窗，until 缺省表示还活着。 */
export type Launcher = { pid: number; from: number; until?: number };

/** 点名要结束的进程（登记的服务）：只认 before（登记写入时间）之前创建的，进程号被复用了不动。 */
export type Named = { pid: number; before: number };

/** 查到的进程：under 表示命令行里带着夹具目录。 */
export type WinProcess = {
  pid: number;
  parent: number;
  created: number;
  under: boolean;
};

// 进程创建时间与 Date.now 取自同一系统时钟，留一点余量给时钟粒度。
const SLACK_MS = 1000;

/**
 * 该结束哪些进程（t198）：命令行带着夹具目录的、点名且登记之前就在的，
 * 或是登记的命令行进程在存活期间拉起的。
 * 命令行拉起的服务在写登记之前，既不在登记里、命令行也不带夹具目录（只有包里的入口脚本）；
 * Win32_Process 保留父进程号，父进程退出后照样查得到。只认父进程存活期间创建的子进程：
 * 父进程号被系统复用后，新进程拉起的子进程不会误伤。
 */
export function processesToKill(
  processes: WinProcess[],
  {
    launchers = [],
    named = [],
    now,
    self,
  }: { launchers?: Launcher[]; named?: Named[]; now: number; self: number },
): WinProcess[] {
  const byPid = new Map<number, Launcher[]>();
  for (const launcher of launchers) {
    const same = byPid.get(launcher.pid);
    if (same) same.push(launcher);
    else byPid.set(launcher.pid, [launcher]);
  }
  return processes.filter(
    (row) =>
      row.pid !== self &&
      (row.under ||
        named.some(
          (item) =>
            item.pid === row.pid && row.created <= item.before + SLACK_MS,
        ) ||
        (byPid.get(row.parent) ?? []).some(
          (launcher) =>
            row.created >= launcher.from - SLACK_MS &&
            row.created <= (launcher.until ?? now) + SLACK_MS,
        )),
  );
}

/** 跑一段 PowerShell，按行拆成数字；出错当作没查到。 */
function query(script: string): number[][] {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    )
      .split(/\r?\n/)
      .map((line) => line.trim().split(" ").map(Number))
      .filter(([pid]) => pid! > 0);
  } catch {
    return [];
  }
}

const CREATED = "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()";

/**
 * Windows：结束命令行里带着该目录的进程（假执行者的转发脚本、sh 与它们的子进程）、
 * 点名的进程（登记的服务），以及 launchers 拉起的进程（见 processesToKill），
 * 都连同子进程树；返回结束了哪些（带创建时间，事后据此分辨进程号是否被复用）。
 * Unix 上夹具按工作目录找进程（tests/fixture-signal.ts），这里不做事。
 */
export function killProcessesUnder(
  dir: string,
  launchers: Launcher[] = [],
  named: Named[] = [],
): WinProcess[] {
  if (process.platform !== "win32") return [];
  const needles = new Set([dir.toLowerCase()]);
  try {
    needles.add(realpathSync.native(dir).toLowerCase());
  } catch {
    // 目录已不在。
  }
  const under = [...needles]
    .map(
      (needle) =>
        `$_.CommandLine.ToLower().Contains('${needle.replace(/'/g, "''")}')`,
    )
    .join(" -or ");
  const others =
    [
      ...named.map((item) => `$_.ProcessId -eq ${item.pid}`),
      ...launchers.map((launcher) => `$_.ParentProcessId -eq ${launcher.pid}`),
    ].join(" -or ") || "$false";
  const processes = query(
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $u = [bool]($_.CommandLine -and (${under})); if ($u -or ${others}) { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ${CREATED}, [int]$u } }`,
  ).map(([pid, parent, created, flag]) => ({
    pid: pid!,
    parent: parent!,
    created: created!,
    under: flag === 1,
  }));
  // 还活着的命令行进程可能在查询期间又拉起进程：时间窗截到查完为止。
  const killed = processesToKill(processes, {
    launchers,
    named,
    now: Date.now(),
    self: process.pid,
  });
  for (const { pid } of killed)
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 已退出。
    }
  return killed;
}

/** Windows：这些进程号现在对应进程的创建时间，查不到的不在表里。 */
export function creationTimes(pids: number[]): Map<number, number> {
  if (process.platform !== "win32" || pids.length === 0) return new Map();
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  return new Map(
    query(
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { '{0} {1}' -f $_.ProcessId, ${CREATED} }`,
    ).map(([pid, created]) => [pid!, created!]),
  );
}
