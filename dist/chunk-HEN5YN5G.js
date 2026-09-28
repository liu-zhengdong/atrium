// server/problem.ts
var Problem = class extends Error {
  constructor(statusCode, message, code, candidates, nextCommand) {
    super(message);
    this.statusCode = statusCode;
    this.candidates = candidates;
    this.nextCommand = nextCommand;
    this.code = code ?? {
      400: "usage",
      404: "not_found",
      403: "conflict",
      409: "conflict",
      503: "service_unavailable"
    }[statusCode] ?? "internal";
  }
  statusCode;
  candidates;
  nextCommand;
  code;
};
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    row = next;
  }
  return row[b.length];
}
function closest(reference, entries) {
  const distance = editDistance;
  const input = reference.toLowerCase();
  return entries.map((entry) => ({
    entry,
    score: entry.ref.toLowerCase() === input ? -2 : entry.ref.toLowerCase().startsWith(input) || entry.name.toLowerCase().startsWith(input) ? -1 : Math.min(
      distance(input, entry.name.toLowerCase()),
      distance(input, entry.name.toLowerCase().split(/\s+/)[0])
    )
  })).sort(
    (a, b) => a.score - b.score || a.entry.ref.localeCompare(b.entry.ref, void 0, { numeric: true })
  ).slice(0, 3).map(({ entry }) => ({ ref: entry.ref, name: entry.name }));
}

// server/platform/plan.ts
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

// server/service-env.ts
var SYSTEM = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  "XDG_DATA_HOME"
]);
var NETWORK = /* @__PURE__ */ new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
]);
var ISOLATION = /* @__PURE__ */ new Set([
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "PI_ACP_DIR",
  // node:test 子进程标记：让测试里缺 piHome 的服务拒绝写入 ~/.pi（不注入任何值）。
  "NODE_TEST_CONTEXT"
]);
var WINDOWS = new Set(WINDOWS_SYSTEM_ENV);
function allowed(key, platform) {
  const name = envKey(platform, key);
  return SYSTEM.has(name) || NETWORK.has(name) || ISOLATION.has(name) || name.startsWith("ATRIUM_") || name.startsWith("LC_") || platform === "win32" && WINDOWS.has(name);
}
function droppedSensitiveNames(keys) {
  return [...keys].filter(
    (key) => /^(ANTHROPIC|CLAUDE|OPENAI|GH|GITHUB|HERDR|PI)_/.test(key) || /_(API_KEY|TOKEN)$/.test(key) || key === "SSH_AUTH_SOCK"
  ).sort();
}
function serviceEnvironment(base = process.env, platform = process.platform) {
  const env = {};
  const keys = Object.keys(base);
  for (const key of keys) {
    const value = base[key];
    if (value !== void 0 && allowed(key, platform))
      env[envKey(platform, key)] = value;
  }
  return {
    env,
    droppedSensitive: droppedSensitiveNames(
      keys.filter((k) => !allowed(k, platform))
    )
  };
}
function reportDroppedIdentity(names) {
  if (!names.length) return;
  console.error(
    `\u5DF2\u5FFD\u7565\u8EAB\u4EFD/\u51ED\u636E\u73AF\u5883\u53D8\u91CF\uFF1A${names.join(", ")}\uFF1B\u670D\u52A1\u4E0E\u6267\u884C\u8005\u4E0D\u7EE7\u627F\u8FD9\u4E9B\u53D8\u91CF\u3002`
  );
}

// server/platform/index.ts
import {
  execFile,
  spawn
} from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  statSync
} from "node:fs";
import { dirname, join } from "node:path";
function killTree(pid, signal = "SIGTERM") {
  const plan = killTreePlan(process.platform, pid, signal);
  if ("kind" in plan) {
    try {
      process.kill(plan.pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
      }
    }
    return;
  }
  try {
    const child = spawn(plan.command, plan.args, {
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {
      try {
        process.kill(pid, signal);
      } catch {
      }
    });
    child.unref();
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
    }
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function findExecutable(name, path = process.env.PATH ?? "", pathext = process.env.PATHEXT) {
  const names = executableNames(process.platform, name, pathext);
  for (const dir of path.split(pathDelimiter(process.platform))) {
    if (!dir) continue;
    for (const candidate of names) {
      const file = join(dir, candidate);
      try {
        if (!statSync(file).isFile()) continue;
        if (process.platform !== "win32") accessSync(file, constants.X_OK);
        return file;
      } catch {
      }
    }
  }
  return void 0;
}
function commandInvocation(command, args, env = process.env) {
  const file = /[\\/]/.test(command) ? command : findExecutable(command, env.PATH ?? "", env.PATHEXT) ?? command;
  let shim;
  if (isBatchFile(process.platform, file))
    try {
      shim = { text: readFileSync(file, "utf8"), dir: dirname(file) };
    } catch {
    }
  return launchInvocation({
    platform: process.platform,
    file,
    args,
    comspec: env.COMSPEC ?? process.env.ComSpec,
    shim,
    nodePath: process.execPath
  });
}
function takesStdin(stdio) {
  const first = Array.isArray(stdio) ? stdio[0] : stdio;
  return first !== "ignore";
}
function spawnInvocation(invocation, options = {}) {
  const launch = hiddenLaunch(process.platform, invocation, options.detached, {
    nodePath: process.execPath,
    stdin: takesStdin(options.stdio)
  });
  return spawn(launch.invocation.command, launch.invocation.args, {
    ...options,
    detached: launch.detached,
    windowsHide: true,
    windowsVerbatimArguments: launch.invocation.verbatim
  });
}
function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, { ...options, windowsHide: true });
}
function runFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { ...options, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}
function runCommand(command, args, options = {}) {
  const call = commandInvocation(command, args, options.env ?? process.env);
  return runFile(call.command, call.args, {
    ...options,
    windowsVerbatimArguments: call.verbatim
  });
}
function spawnCommand(command, args, options = {}) {
  return spawnInvocation(
    commandInvocation(command, args, options.env ?? process.env),
    options
  );
}
function spawnShell(command, options = {}) {
  return spawnInvocation(
    shellInvocation(
      process.platform,
      command,
      (options.env ?? process.env).COMSPEC ?? process.env.ComSpec
    ),
    options
  );
}
function restrictToOwner(path) {
  if (process.platform !== "win32") chmodSync(path, 384);
}

export {
  Problem,
  closest,
  commandLineInvocation,
  openUrlInvocation,
  WINDOWS_SYSTEM_ENV,
  envKey,
  serviceEnvironment,
  reportDroppedIdentity,
  killTree,
  processAlive,
  findExecutable,
  commandInvocation,
  spawnInvocation,
  spawnNode,
  runFile,
  runCommand,
  spawnCommand,
  spawnShell,
  restrictToOwner
};
