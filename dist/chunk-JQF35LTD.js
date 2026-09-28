// server/platform/plan.ts
import { posix, win32 } from "node:path";
function killTreePlan(platform, pid, signal) {
  if (platform === "win32")
    return {
      command: "taskkill",
      args: ["/T", "/F", "/PID", String(pid)]
    };
  return { kind: "group", pid: -pid, signal };
}
function shellInvocation(platform, command, comspec) {
  if (platform === "win32")
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatim: true
    };
  return { command: "/bin/sh", args: ["-c", command] };
}
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
function pathExtensions(pathext) {
  return (pathext || DEFAULT_PATHEXT).split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."));
}
function executableNames(platform, name, pathext) {
  if (platform !== "win32") return [name];
  const exts = pathExtensions(pathext);
  const lower = name.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return [name];
  return exts.map((ext) => `${name}${ext}`);
}
var pathDelimiter = (platform) => platform === "win32" ? ";" : ":";
var isBatchFile = (platform, file) => platform === "win32" && /\.(cmd|bat)$/i.test(file);
var CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function quoteCmdArg(arg, doubleEscape = false) {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return doubleEscape ? quoted.replace(CMD_META, "^$1") : quoted;
}
function cmdShimTarget(shim, shimDir) {
  const match = shim.match(/"%(?:~dp0|dp0)%?\\([^"]+)"\s+%\*/i);
  if (!match) return void 0;
  const target = `${shimDir.replace(/[\\/]+$/, "")}\\${match[1]}`;
  if (/%_prog%/i.test(shim))
    return /_prog=(?:%dp0%\\)?node(?:\.exe)?"/i.test(shim) ? { program: "node", target } : void 0;
  if (/\.(exe|com)$/i.test(target)) return { program: "direct", target };
  return void 0;
}
function launchInvocation(input) {
  const { platform, file, args } = input;
  if (!isBatchFile(platform, file)) return { command: file, args: [...args] };
  const target = input.shim ? cmdShimTarget(input.shim.text, input.shim.dir) : void 0;
  if (target?.program === "node")
    return {
      command: input.nodePath ?? "node",
      args: [target.target, ...args]
    };
  if (target?.program === "direct")
    return { command: target.target, args: [...args] };
  if (args.some((arg) => /[\r\n]/.test(arg)))
    throw new Error(
      `${file} \u662F\u6279\u5904\u7406\u5305\u88C5\uFF0C\u53C2\u6570\u542B\u6362\u884C\u65F6 cmd.exe \u4F1A\u622A\u65AD\uFF1B\u8BF7\u6539\u7528\u53EF\u6267\u884C\u6587\u4EF6\u6216\u8D70\u6807\u51C6\u8F93\u5165\u7684\u5DE5\u5177`
    );
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [
    file.replace(CMD_META, "^$1"),
    ...args.map((arg) => quoteCmdArg(arg, doubleEscape))
  ].join(" ");
  return {
    command: input.comspec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true
  };
}
function commandLineInvocation(platform, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`\u8FDB\u7A0B\u53F7\u4E0D\u5408\u6CD5\uFF1A${pid}`);
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // [wmisearcher] 是内置类型，不靠模块自动加载（白名单环境里可能没有 PSModulePath）。
        `([wmisearcher]'SELECT CommandLine FROM Win32_Process WHERE ProcessId=${pid}').Get() | ForEach-Object { $_.CommandLine }`
      ]
    };
  return {
    command: "ps",
    args: ["-ww", "-o", "command=", "-p", String(pid)]
  };
}
function processProbeInvocation(platform, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`\u8FDB\u7A0B\u53F7\u4E0D\u5408\u6CD5\uFF1A${pid}`);
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = ([wmisearcher]'SELECT CreationDate,CommandLine FROM Win32_Process WHERE ProcessId=${pid}').Get() | Select-Object -First 1; if ($p) { [string]$p.CreationDate; [string]$p.CommandLine }`
      ]
    };
  return {
    command: "ps",
    args: ["-ww", "-o", "etime=,command=", "-p", String(pid)]
  };
}
function elapsedSeconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}
function dmtfTime(text) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(
    text
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
    Math.floor(Number(micro) / 1e3)
  );
  return utc - (sign === "-" ? -1 : 1) * Number(offset) * 6e4;
}
function parseProcessProbe(platform, text, at) {
  if (platform === "win32") {
    const [created = "", ...rest] = text.replace(/\r/g, "").split("\n");
    const command = rest.join(" ").trim();
    if (!created.trim() && !command) return null;
    return { start: dmtfTime(created.trim()), command };
  }
  const line = text.split("\n").find((item) => item.trim());
  if (!line) return null;
  const match = /^\s*(\S+)\s*(.*)$/.exec(line);
  const elapsed = elapsedSeconds(match[1]);
  return {
    start: elapsed === null ? null : at - elapsed * 1e3,
    command: match[2].trim()
  };
}
function openUrlInvocation(platform, url) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  return { command, args: [url] };
}
var HIDDEN_LAUNCHER = [
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
  "  process.stderr.write(`[atrium] \u62C9\u8D77 ${command} \u5931\u8D25\uFF1A${error.message}\\n`, quiet);",
  "  process.exitCode = 127;",
  "  if (stdin) process.stdin.destroy();",
  "});",
  'child.on("close", (code) => {',
  "  process.exitCode ??= code ?? 1;",
  "  if (stdin) process.stdin.destroy();",
  "});"
].join("\n");
function hiddenLaunch(platform, invocation, requested, input) {
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
          verbatim: invocation.verbatim === true
        }),
        invocation.command,
        ...invocation.args
      ]
    },
    detached: true
  };
}
var isAbsolutePath = (platform, path) => platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
function trimTrailingSeparators(platform, path) {
  const lib = platform === "win32" ? win32 : posix;
  const root = lib.parse(path).root;
  const trimmed = path.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  return trimmed.length < root.length ? root : trimmed || root;
}
function samePath(platform, a, b) {
  if (platform !== "win32")
    return trimTrailingSeparators(platform, a) === trimTrailingSeparators(platform, b);
  const key = (path) => trimTrailingSeparators(platform, path).replace(/\//g, "\\").toLowerCase();
  return key(a) === key(b);
}
var pathSegments = (platform, path) => path.split(platform === "win32" ? /[\\/]/ : "/");
var hasParentSegment = (platform, path) => pathSegments(platform, path).includes("..");
var WINDOWS_SYSTEM_ENV = [
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
  "OS"
];
var envKey = (platform, key) => platform === "win32" ? key.toUpperCase() : key;
function linkKinds(platform, directory) {
  if (platform !== "win32") return ["symlink"];
  return directory ? ["symlink", "junction"] : ["symlink", "hardlink"];
}
function messagingEndpoint(platform, raw) {
  const path = raw?.trim().replace(/^uds:/, "") ?? "";
  if (!path || /[\r\n\0]/.test(path)) return null;
  if (platform === "win32")
    return /^\\\\[.?]\\pipe\\[^\\]+/i.test(path) ? path : null;
  return posix.isAbsolute(path) ? path : null;
}
function endpointGone(platform, code) {
  if (code === "ENOENT") return true;
  if (platform === "win32") return false;
  return code === "ECONNREFUSED" || code === "ENOTSOCK";
}

export {
  killTreePlan,
  shellInvocation,
  pathExtensions,
  executableNames,
  pathDelimiter,
  isBatchFile,
  quoteCmdArg,
  cmdShimTarget,
  launchInvocation,
  commandLineInvocation,
  processProbeInvocation,
  dmtfTime,
  parseProcessProbe,
  openUrlInvocation,
  HIDDEN_LAUNCHER,
  hiddenLaunch,
  isAbsolutePath,
  trimTrailingSeparators,
  samePath,
  hasParentSegment,
  WINDOWS_SYSTEM_ENV,
  envKey,
  linkKinds,
  messagingEndpoint,
  endpointGone
};
