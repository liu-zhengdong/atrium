import { posix, win32 } from "node:path";

/**
 * 平台差异的纯判定（#t94）：只吃参数（平台、PATH、PATHEXT、文件内容），不碰进程与文件系统。
 * IO 在 `index.ts`；其余代码只调 `index.ts`，不直接写 `process.kill(-pid)`、`/bin/sh`。
 */

export type Platform = NodeJS.Platform;
export type StopSignal = "SIGTERM" | "SIGKILL";

/** 一次进程调用：命令、参数，以及 Windows 上是否按原样拼命令行（cmd.exe 的引号自己处理）。 */
export type Invocation = {
  command: string;
  args: string[];
  verbatim?: boolean;
};

/**
 * 结束整个进程树：Unix 给独立进程组发信号（拉起时 detached）；
 * Windows 没有进程组信号，用 `taskkill /T /F`。控制台程序收不到 taskkill 的温和关闭，
 * 所以 SIGTERM 与 SIGKILL 在 Windows 上都是强制结束。
 */
export function killTreePlan(
  platform: Platform,
  pid: number,
  signal: StopSignal,
): { kind: "group"; pid: number; signal: StopSignal } | Invocation {
  if (platform === "win32")
    return {
      command: "taskkill",
      args: ["/T", "/F", "/PID", String(pid)],
    };
  return { kind: "group", pid: -pid, signal };
}

/** 跑一条 shell 命令：Unix `/bin/sh -c`；Windows `cmd.exe /d /s /c "命令"`（与 Node 的 shell:true 相同）。 */
export function shellInvocation(
  platform: Platform,
  command: string,
  comspec?: string,
): Invocation {
  if (platform === "win32")
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatim: true,
    };
  return { command: "/bin/sh", args: ["-c", command] };
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Windows 可执行文件扩展名（小写，带点）。 */
export function pathExtensions(pathext?: string): string[] {
  return (pathext || DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
}

/**
 * 在一个 PATH 目录里要找的文件名：Unix 原名（另查可执行位）；
 * Windows 已带可执行扩展名时只找原名，否则按 PATHEXT 顺序补扩展名（无扩展名的文件在 Windows 上不能直接执行）。
 */
export function executableNames(
  platform: Platform,
  name: string,
  pathext?: string,
): string[] {
  if (platform !== "win32") return [name];
  const exts = pathExtensions(pathext);
  const lower = name.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return [name];
  return exts.map((ext) => `${name}${ext}`);
}

/** PATH 分隔符。 */
export const pathDelimiter = (platform: Platform) =>
  platform === "win32" ? ";" : ":";

/** 是否是批处理（.cmd/.bat）：Windows 上必须经 cmd.exe 拉起。 */
export const isBatchFile = (platform: Platform, file: string) =>
  platform === "win32" && /\.(cmd|bat)$/i.test(file);

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** cmd.exe 命令行里的一个参数：先按 MSVCRT 规则转义引号与结尾反斜杠、加引号，再把元字符用 ^ 转义。 */
export function quoteCmdArg(arg: string, doubleEscape = false): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return doubleEscape ? quoted.replace(CMD_META, "^$1") : quoted;
}

/**
 * npm 在 Windows 上生成的 .cmd 包装（cmd-shim）：取出真正要跑的脚本或程序，绕开 cmd.exe——
 * cmd.exe 的命令行不能带换行，而 opencode/kimi/grok 把提示词直接放在参数里。
 * 认不出的包装返回 undefined，由调用方退回 cmd.exe。
 */
export function cmdShimTarget(
  shim: string,
  shimDir: string,
): { program: "node" | "direct"; target: string } | undefined {
  const match = shim.match(/"%(?:~dp0|dp0)%?\\([^"]+)"\s+%\*/i);
  if (!match) return undefined;
  const target = `${shimDir.replace(/[\\/]+$/, "")}\\${match[1]}`;
  // 带 %_prog% 的是解释器脚本，只接 node 的；没有的直接指向程序本身。
  if (/%_prog%/i.test(shim))
    return /_prog=(?:%dp0%\\)?node(?:\.exe)?"/i.test(shim)
      ? { program: "node", target }
      : undefined;
  if (/\.(exe|com)$/i.test(target)) return { program: "direct", target };
  return undefined;
}

/**
 * 把「可执行文件 + 参数」变成真正的进程调用。
 * Windows 的 .cmd/.bat：认得出的 npm 包装直接跑目标（node 脚本用 nodePath）；
 * 否则经 `cmd.exe /d /s /c` 并逐个转义参数，参数含换行时拒绝（cmd.exe 会截断）。
 */
export function launchInvocation(input: {
  platform: Platform;
  file: string;
  args: readonly string[];
  comspec?: string;
  shim?: { text: string; dir: string };
  nodePath?: string;
}): Invocation {
  const { platform, file, args } = input;
  if (!isBatchFile(platform, file)) return { command: file, args: [...args] };
  const target = input.shim
    ? cmdShimTarget(input.shim.text, input.shim.dir)
    : undefined;
  if (target?.program === "node")
    return {
      command: input.nodePath ?? "node",
      args: [target.target, ...args],
    };
  if (target?.program === "direct")
    return { command: target.target, args: [...args] };
  if (args.some((arg) => /[\r\n]/.test(arg)))
    throw new Error(
      `${file} 是批处理包装，参数含换行时 cmd.exe 会截断；请改用可执行文件或走标准输入的工具`,
    );
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [
    file.replace(CMD_META, "^$1"),
    ...args.map((arg) => quoteCmdArg(arg, doubleEscape)),
  ].join(" ");
  return {
    command: input.comspec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

/**
 * 读某个进程的完整命令行（接管执行者时防 pid 复用）：Unix `ps -o command=`；
 * Windows 没有 ps，经 PowerShell 查 Win32_Process.CommandLine。
 */
export function commandLineInvocation(
  platform: Platform,
  pid: number,
): Invocation {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`进程号不合法：${pid}`);
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // [wmisearcher] 是内置类型，不靠模块自动加载（白名单环境里可能没有 PSModulePath）。
        `([wmisearcher]'SELECT CommandLine FROM Win32_Process WHERE ProcessId=${pid}').Get() | ForEach-Object { $_.CommandLine }`,
      ],
    };
  // -ww：不按终端宽度截断。
  return {
    command: "ps",
    args: ["-ww", "-o", "command=", "-p", String(pid)],
  };
}

/**
 * 读一个进程的启动时刻与命令行（t217 清残留进程核对用）：Unix `ps -o etime=,command=`（etime 已运行时长，
 * 不随语言环境变）；Windows 经 PowerShell 查 Win32_Process，第一行 CreationDate（DMTF 格式）、第二行命令行。
 */
export function processProbeInvocation(
  platform: Platform,
  pid: number,
): Invocation {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`进程号不合法：${pid}`);
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = ([wmisearcher]'SELECT CreationDate,CommandLine FROM Win32_Process WHERE ProcessId=${pid}').Get() | Select-Object -First 1; if ($p) { [string]$p.CreationDate; [string]$p.CommandLine }`,
      ],
    };
  return {
    command: "ps",
    args: ["-ww", "-o", "etime=,command=", "-p", String(pid)],
  };
}

/** `[[天-]时:]分:秒` 的秒数；看不懂为 null。 */
function elapsedSeconds(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** WMI 的 DMTF 时刻 `yyyymmddHHMMSS.ffffff±UUU`（UUU 是相对 UTC 的分钟数）；看不懂为 null。 */
export function dmtfTime(text: string): number | null {
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(
      text,
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, micro, sign, offset] = match;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(Number(micro) / 1000),
  );
  return utc - (sign === "-" ? -1 : 1) * Number(offset) * 60_000;
}

/**
 * processProbeInvocation 的输出：启动时刻（毫秒；看不懂为 null，Unix 按采样时刻 at 推算、精度到秒）与命令行；
 * 没有输出（进程已不在）为 null。
 */
export function parseProcessProbe(
  platform: Platform,
  text: string,
  at: number,
): { start: number | null; command: string } | null {
  if (platform === "win32") {
    const [created = "", ...rest] = text.replace(/\r/g, "").split("\n");
    const command = rest.join(" ").trim();
    if (!created.trim() && !command) return null;
    return { start: dmtfTime(created.trim()), command };
  }
  const line = text.split("\n").find((item) => item.trim());
  if (!line) return null;
  const match = /^\s*(\S+)\s*(.*)$/.exec(line)!;
  const elapsed = elapsedSeconds(match[1]!);
  return {
    start: elapsed === null ? null : at - elapsed * 1000,
    command: match[2]!.trim(),
  };
}

/** 用系统默认程序打开链接：macOS `open`，Windows `explorer`，其余 `xdg-open`。 */
export function openUrlInvocation(platform: Platform, url: string): Invocation {
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "explorer"
        : "xdg-open";
  return { command, args: [url] };
}

/**
 * Windows 上 detached 拉起时的中转（t167）：libuv 的 detached 是 DETACHED_PROCESS，子进程没有控制台，
 * 它再起的控制台程序（git、shell、npm）各自新开一个可见窗口，桌面反复弹窗；
 * 不 detached 又会落进服务的作业对象、随服务退出，接管不到。
 * 所以先 detached 拉起这个中转（node，自己没有控制台、不开窗口），由它不 detached、全管道、windowsHide 拉起真正的程序：
 * libuv 此时带 CREATE_NO_WINDOW，程序得到一个没有窗口的控制台，它的子孙都共用这个控制台，不再弹窗。
 * 中转把程序的输出原样写到自己继承的 stdout/stderr（日志文件或管道），把自己的标准输入转给程序，按程序的退出码退出；
 * 中转被结束时程序在它的作业对象里一并结束。
 * 参数：`-e 脚本 -- 选项JSON 命令 参数...`；选项 `stdin` 是否转发标准输入、`verbatim` 是否原样拼命令行（cmd.exe）。
 */
export const HIDDEN_LAUNCHER = [
  'const { spawn } = require("node:child_process");',
  "const [options, command, ...args] = process.argv.slice(1);",
  "const { stdin, verbatim } = JSON.parse(options);",
  "const quiet = () => {};",
  'process.stdout.on("error", quiet);',
  'process.stderr.on("error", quiet);',
  "const child = spawn(command, args, {",
  '  stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],',
  "  windowsHide: true,",
  "  windowsVerbatimArguments: verbatim,",
  "});",
  // 写不出去（管道那头的服务已退出）也继续读，免得程序卡在写输出上。
  'child.stdout.on("data", (chunk) => process.stdout.write(chunk, quiet));',
  'child.stderr.on("data", (chunk) => process.stderr.write(chunk, quiet));',
  "if (stdin) {",
  '  child.stdin.on("error", quiet);',
  "  process.stdin.pipe(child.stdin);",
  "}",
  'child.on("error", (error) => {',
  "  process.stderr.write(`[atrium] 拉起 ${command} 失败：${error.message}\\n`, quiet);",
  "  process.exitCode = 127;",
  "  if (stdin) process.stdin.destroy();",
  "});",
  'child.on("close", (code) => {',
  "  process.exitCode ??= code ?? 1;",
  "  if (stdin) process.stdin.destroy();",
  "});",
].join("\n");

/**
 * 实际拉起什么、是否 detached：Unix 与不 detached 的调用原样（Unix 靠 detached 得到独立进程组）；
 * Windows 上要求 detached 的调用改由 `HIDDEN_LAUNCHER` 中转，中转自己 detached。
 * 经 cmd.exe 的调用同样中转：cmd.exe 在中转下有控制台和管道，输出不丢，也能随中转活过服务重启。
 */
export function hiddenLaunch(
  platform: Platform,
  invocation: Invocation,
  requested: boolean | undefined,
  input: { nodePath: string; stdin: boolean },
): { invocation: Invocation; detached: boolean | undefined } {
  if (platform !== "win32" || !requested)
    return { invocation, detached: requested };
  return {
    invocation: {
      command: input.nodePath,
      args: [
        "-e",
        HIDDEN_LAUNCHER,
        "--",
        JSON.stringify({
          stdin: input.stdin,
          verbatim: invocation.verbatim === true,
        }),
        invocation.command,
        ...invocation.args,
      ],
    },
    detached: true,
  };
}

/** 路径是否绝对：与 Node 的 path.posix / path.win32 一致（Windows 另认盘符、UNC 与当前盘根路径）。 */
export const isAbsolutePath = (platform: Platform, path: string) =>
  platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);

/** 去掉结尾的分隔符（Windows 上 / 与 \ 都算），根路径（/、C:\）原样保留。 */
export function trimTrailingSeparators(platform: Platform, path: string) {
  const lib = platform === "win32" ? win32 : posix;
  const root = lib.parse(path).root;
  const trimmed = path.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  return trimmed.length < root.length ? root : trimmed || root;
}

/**
 * 两个路径是否指同一处（只比字面，不查文件系统）：Windows 不分大小写、/ 与 \ 等同
 * （git 在 Windows 上输出 C:/a/b，Node 给出 C:\a\b）；Unix 原样比较。结尾分隔符不计。
 */
export function samePath(platform: Platform, a: string, b: string) {
  if (platform !== "win32")
    return (
      trimTrailingSeparators(platform, a) ===
      trimTrailingSeparators(platform, b)
    );
  const key = (path: string) =>
    trimTrailingSeparators(platform, path).replace(/\//g, "\\").toLowerCase();
  return key(a) === key(b);
}

/** 路径各段：Windows 上 / 与 \ 都是分隔符。 */
export const pathSegments = (platform: Platform, path: string) =>
  path.split(platform === "win32" ? /[\\/]/ : "/");

/** 路径是否含 `..` 段（按平台的分隔符切）。 */
export const hasParentSegment = (platform: Platform, path: string) =>
  pathSegments(platform, path).includes("..");

/**
 * 子进程环境白名单里 Windows 额外需要的系统变量：没有 SystemRoot，Node 与 git 的网络和加密会失败；
 * 没有 PATHEXT/ComSpec，按名字找不到 .cmd/.exe；USERPROFILE/APPDATA 是 Windows 上的「HOME」。
 */
export const WINDOWS_SYSTEM_ENV = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "PSMODULEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/**
 * 环境变量名在白名单里怎么比对与落键：Windows 的变量名不分大小写（`Path` 与 `PATH` 是同一个），
 * 统一成大写，调用方就能照常读 `env.PATH`；Unix 原样。
 */
export const envKey = (platform: Platform, key: string) =>
  platform === "win32" ? key.toUpperCase() : key;

/** 一次建链接的方式：软链、目录联接（Windows junction）、硬链接。 */
export type LinkKind = "symlink" | "junction" | "hardlink";

/**
 * 把一个已有的文件或目录链到别处，依次试哪几种方式：Unix 只用软链；Windows 没开开发者模式时普通用户建不了软链，
 * 目录退到 junction（不要权限），文件退到硬链接（同一卷上不要权限，内容与原文件同一份）。
 */
export function linkKinds(platform: Platform, directory: boolean): LinkKind[] {
  if (platform !== "win32") return ["symlink"];
  return directory ? ["symlink", "junction"] : ["symlink", "hardlink"];
}
