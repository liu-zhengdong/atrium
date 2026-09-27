import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/**
 * Windows：结束命令行里带着该目录的进程（假执行者的转发脚本、sh 与它们的子进程）。
 * Unix 上夹具按工作目录找进程（tests/fixture-signal.ts），这里不做事。
 */
export function killProcessesUnder(dir: string) {
  if (process.platform !== "win32") return;
  const needles = new Set([dir.toLowerCase()]);
  try {
    needles.add(realpathSync.native(dir).toLowerCase());
  } catch {
    // 目录已不在。
  }
  const filter = [...needles]
    .map(
      (needle) =>
        `$_.CommandLine.ToLower().Contains('${needle.replace(/'/g, "''")}')`,
    )
    .join(" -or ");
  let pids: number[] = [];
  try {
    pids = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (${filter}) } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    )
      .split(/\s+/)
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return;
  }
  for (const pid of pids)
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 已退出。
    }
}
