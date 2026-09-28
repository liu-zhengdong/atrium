import {
  WINDOWS_SYSTEM_ENV,
  envKey,
  executableNames,
  hiddenLaunch,
  isBatchFile,
  killTreePlan,
  launchInvocation,
  linkKinds,
  pathDelimiter,
  shellInvocation
} from "./chunk-AOP4HR6R.js";

// server/platform/index.ts
import {
  execFile,
  spawn
} from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  linkSync,
  readFileSync,
  statSync,
  symlinkSync
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

// server/hosts/tunnel-plan.ts
function tunnelArgs(connection, key) {
  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    ...key ? ["-o", "IdentitiesOnly=yes", "-i", key] : [],
    "-R",
    `127.0.0.1:${connection.remotePort}:127.0.0.1:${connection.localPort}`,
    connection.target
  ];
}

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
function linkPath(source, target) {
  const directory = statSync(source).isDirectory();
  let last;
  for (const kind of linkKinds(process.platform, directory)) {
    try {
      if (kind === "hardlink") linkSync(source, target);
      else
        symlinkSync(
          source,
          target,
          kind === "junction" ? "junction" : directory ? "dir" : "file"
        );
      return kind;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
function spawnSshTunnel(connection) {
  const key = connection.key?.startsWith("~/") ? join(homedir(), connection.key.slice(2)) : connection.key;
  return spawnCommand("ssh", tunnelArgs(connection, key ?? null), {
    env: serviceEnvironment().env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true
  });
}
function stopSshTunnel(child) {
  if (child.pid) killTree(child.pid);
}

export {
  Problem,
  closest,
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
  restrictToOwner,
  linkPath,
  spawnSshTunnel,
  stopSshTunnel
};
