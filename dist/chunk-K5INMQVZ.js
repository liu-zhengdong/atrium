// server/service-state.ts
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  realpathSync
} from "node:fs";
import { join as join2, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// server/platform/index.ts
import {
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

// server/platform/plan.ts
function killTreePlan(platform, pid, signal) {
  if (platform === "win32")
    return {
      command: "taskkill",
      args: ["/T", "/F", "/PID", String(pid)]
    };
  return { kind: "group", pid: -pid, signal };
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
function openUrlInvocation(platform, url) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  return { command, args: [url] };
}
var spawnDetached = (platform, invocation, requested) => platform === "win32" && invocation.verbatim ? false : requested;
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

// server/platform/index.ts
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
function spawnInvocation(invocation, options = {}) {
  return spawn(invocation.command, invocation.args, {
    ...options,
    detached: spawnDetached(process.platform, invocation, options.detached),
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim
  });
}
function spawnCommand(command, args, options = {}) {
  return spawnInvocation(
    commandInvocation(command, args, options.env ?? process.env),
    options
  );
}

// server/service-state.ts
var packageRoot = fileURLToPath(new URL("../", import.meta.url));
var bootVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync2(join2(packageRoot, "package.json"), "utf8")
    );
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();
function currentVersion() {
  return bootVersion;
}
function dataDirectory(env = process.env, home = homedir()) {
  const path = resolve(env.ATRIUM_DATA ?? join2(home, ".atrium"));
  return existsSync(path) ? realpathSync(path) : path;
}
function isDefaultData(data = dataDirectory(), home = homedir()) {
  const path = existsSync(data) ? realpathSync(data) : resolve(data);
  return path === dataDirectory({}, home);
}
function legacyDataNotice(env = process.env, home = homedir(), exists = existsSync) {
  if (env.ATRIUM_DATA !== void 0) return null;
  const legacy = join2(home, ".pi", "atrium", "data");
  if (exists(join2(home, ".atrium")) || !exists(legacy)) return null;
  return `\u524D\u4E00\u4EE3\u6570\u636E\u5728 ${legacy}\uFF0C\u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u4F7F\u7528\uFF1B\u65B0\u4E00\u4EE3\u6570\u636E\u653E\u5728 ${join2(home, ".atrium")}\uFF08\u53EF\u7528 ATRIUM_DATA \u6539\uFF09`;
}
function servicePort() {
  const port = Number(process.env.ATRIUM_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ATRIUM_PORT \u5FC5\u987B\u4E3A\u6709\u6548\u7AEF\u53E3");
  return port;
}
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
function parseServiceRecord(value) {
  const record = value ?? {};
  if (typeof value !== "object" || value === null || typeof record.instance !== "string" || !UUID.test(record.instance) || !isInt(record.pid, 1, Number.MAX_SAFE_INTEGER) || !isInt(record.port, 1, 65535) || typeof record.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token))
    throw new Error("\u670D\u52A1\u767B\u8BB0\u8BB0\u5F55\u683C\u5F0F\u4E0D\u5BF9");
  const { instance, pid, port, token } = record;
  return { instance, pid, port, token };
}
var serviceUrl = (record) => `http://127.0.0.1:${record.port}`;
var alive = processAlive;
function decode(value) {
  if (!value) return null;
  return parseServiceRecord(JSON.parse(value.record));
}
function readService(data) {
  const path = join2(data, "service.sqlite");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='service'").get())
      return null;
    return decode(db.prepare("SELECT record FROM service WHERE id=1").get());
  } finally {
    db.close();
  }
}

export {
  openUrlInvocation,
  WINDOWS_SYSTEM_ENV,
  envKey,
  killTree,
  commandInvocation,
  spawnCommand,
  packageRoot,
  currentVersion,
  dataDirectory,
  isDefaultData,
  legacyDataNotice,
  servicePort,
  serviceUrl,
  alive,
  readService
};
