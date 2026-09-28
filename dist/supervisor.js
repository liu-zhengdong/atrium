// server/supervisor.ts
import { randomBytes } from "node:crypto";
import {
  closeSync as closeSync3,
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  openSync as openSync3,
  readFileSync as readFileSync4,
  renameSync as renameSync2,
  writeFileSync,
  unlinkSync
} from "node:fs";
import { join as join6 } from "node:path";
import { setTimeout as delay2 } from "node:timers/promises";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// server/service-state.ts
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  realpathSync,
  renameSync
} from "node:fs";
import { join as join2, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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

// server/platform/plan.ts
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
function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, { ...options, windowsHide: true });
}
function runFile(command, args, options = {}) {
  return new Promise((resolve3) => {
    execFile(
      command,
      args,
      { ...options, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => resolve3({ error, stdout: String(stdout), stderr: String(stderr) })
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
function damaged(error) {
  const code = error.errcode;
  return typeof code === "number" && [8, 11, 26].includes(code & 255);
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
  } catch (error) {
    if (damaged(error)) return null;
    throw error;
  } finally {
    db.close();
  }
}

// server/service.ts
import {
  closeSync as closeSync2,
  existsSync as existsSync3,
  fstatSync,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readSync,
  statSync as statSync2
} from "node:fs";
import { join as join4 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// server/local-http.ts
var { request } = process.getBuiltinModule(
  "node:http"
);
function localFetch(url, init = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = { ...init.headers };
    if (init.body !== void 0)
      headers["content-length"] = Buffer.byteLength(init.body);
    const failed = (error) => reject(new Error(`\u8FDE\u63A5\u670D\u52A1\u5931\u8D25\uFF1A${error.message}`, { cause: error }));
    let req;
    try {
      req = request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          agent: false,
          signal: init.signal
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let responseHeaders;
          const headersOf = () => {
            if (responseHeaders) return responseHeaders;
            responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === void 0) continue;
              for (const item of Array.isArray(value) ? value : [value])
                responseHeaders.append(name, item);
            }
            return responseHeaders;
          };
          const body = new Promise((resolveBody, rejectBody) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on(
              "end",
              () => resolveBody(Buffer.concat(chunks).toString("utf8"))
            );
            res.on("error", rejectBody);
            res.on(
              "aborted",
              () => rejectBody(
                Object.assign(new Error("\u54CD\u5E94\u4E2D\u9014\u88AB\u65AD\u5F00"), {
                  code: "ECONNRESET"
                })
              )
            );
            res.on("close", () => {
              if (!res.complete)
                rejectBody(
                  Object.assign(new Error("\u54CD\u5E94\u4E2D\u9014\u88AB\u65AD\u5F00"), {
                    code: "ECONNRESET"
                  })
                );
            });
          });
          body.catch(() => {
          });
          resolvePromise({
            ok: status >= 200 && status < 300,
            status,
            get headers() {
              return headersOf();
            },
            text: () => body,
            json: async () => JSON.parse(await body)
          });
        }
      );
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    req.on("error", failed);
    req.end(init.body);
  });
}

// server/port-owner.ts
function classifyPortReply(status, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "other" };
  }
  const value = parsed;
  if (status === 200 && value?.service === "atrium")
    return {
      kind: "atrium",
      data: typeof value.data === "string" && value.data ? value.data : null
    };
  if (status === 401 && value?.code === "auth_required")
    return { kind: "atrium", data: null };
  return { kind: "other" };
}
async function probePort(port, timeoutMs = 1500) {
  try {
    const response = await localFetch(
      `http://127.0.0.1:${port}/api/service/info`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    return classifyPortReply(response.status, await response.text());
  } catch (error) {
    const code = error.cause?.code;
    return code === "ECONNREFUSED" ? { kind: "free" } : { kind: "other" };
  }
}
function portTakenMessage(port, owner, data) {
  if (owner.kind === "free") return null;
  if (owner.kind === "other")
    return `\u7AEF\u53E3 ${port} \u5DF2\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\uFF1B\u6362\u7AEF\u53E3\u8BF7\u8BBE ATRIUM_PORT=<\u7AEF\u53E3>`;
  if (owner.data === data) return null;
  if (owner.data === null)
    return `\u7AEF\u53E3 ${port} \u5DF2\u88AB\u53E6\u4E00\u4E2A Atrium \u5360\u7528\uFF08\u7248\u672C\u8F83\u65E7\uFF0C\u67E5\u4E0D\u5230\u5B83\u7684\u6570\u636E\u76EE\u5F55\uFF09\uFF1B\u672C\u6B21\u6570\u636E\u5728 ${data}\u3002\u8981\u8FDE\u5B83\u8BF7\u628A ATRIUM_DATA \u8BBE\u6210\u5B83\u7684\u6570\u636E\u76EE\u5F55\uFF0C\u8981\u53E6\u8D77\u4E00\u4EFD\u8BF7\u8BBE ATRIUM_PORT=<\u7AEF\u53E3>`;
  return `\u7AEF\u53E3 ${port} \u5DF2\u88AB\u53E6\u4E00\u4EFD\u6570\u636E\u7684 Atrium \u5360\u7528\uFF1A\u6570\u636E\u5728 ${owner.data}\uFF1B\u8981\u7528\u5B83\u8BF7\u8BBE ATRIUM_DATA=${owner.data}`;
}

// server/entry.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join3, resolve as resolve2 } from "node:path";
function useDist({ dist, git, forced }) {
  return dist && (forced || !git);
}
function serviceArgs(entry, root = packageRoot) {
  if (entry === void 0) {
    const dist = join3(root, "dist", "server.js");
    if (useDist({
      dist: existsSync2(dist),
      git: existsSync2(join3(root, ".git")),
      forced: process.env.ATRIUM_DIST === "1"
    }))
      return [dist];
  }
  return [
    "--import",
    import.meta.resolve("tsx"),
    resolve2(root, entry ?? "server/main.ts")
  ];
}

// server/service.ts
async function request2(record, stop = false) {
  const response = await localFetch(
    `${serviceUrl(record)}/api/service${stop ? "/stop" : ""}`,
    {
      method: stop ? "POST" : "GET",
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(700)
    }
  );
  if (!response.ok) throw new Error("\u670D\u52A1\u8EAB\u4EFD\u6821\u9A8C\u5931\u8D25");
  const result = await response.json();
  if (result.instance !== record.instance || result.pid !== record.pid)
    throw new Error("\u670D\u52A1\u8EAB\u4EFD\u4E0D\u5339\u914D");
  return result;
}
async function probe(record) {
  try {
    return (await request2(record)).stopping ? "stopping" : "ready";
  } catch {
    return "down";
  }
}
function logSize(data) {
  try {
    return statSync2(join4(data, "service.log")).size;
  } catch {
    return 0;
  }
}
function startupFailure(data, reason, logStart) {
  const path = join4(data, "service.log");
  let recent = "";
  try {
    const fd = openSync2(path, "r");
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(Math.max(size - logStart, 0), 4096));
      const bytes = readSync(
        fd,
        buffer,
        0,
        buffer.length,
        size - buffer.length
      );
      recent = buffer.subarray(0, bytes).toString("utf8").trim().split("\n").slice(-10).join("\n");
    } finally {
      closeSync2(fd);
    }
  } catch {
  }
  return new Error(
    `${reason}\uFF1B\u65E5\u5FD7\uFF1A${path}${recent ? `
\u6700\u8FD1\u8F93\u51FA\uFF1A
${recent}` : ""}`
  );
}
function unavailable(record, data) {
  return new Error(
    `PID ${record.pid} \u4ECD\u5B58\u5728\uFF0C\u4F46\u670D\u52A1\u672A\u5C31\u7EEA\u6216\u8EAB\u4EFD\u4E0D\u5339\u914D\uFF1B\u4E0D\u4F1A\u91CD\u590D\u542F\u52A8\u6216\u6309 PID \u5F3A\u6740\u3002\u8BF7\u68C0\u67E5 ${join4(data, "service.log")}`
  );
}
async function unavailableReason(record, data) {
  try {
    if ((await request2(record)).stopping === true)
      return new Error(
        "\u670D\u52A1\u6B63\u5728\u5E73\u6ED1\u91CD\u542F\u6216\u5173\u95ED\u4E2D\uFF1B\u6709\u8FDB\u884C\u4E2D\u7684\u91CD\u542F\u65F6\u8FD0\u884C atrium restart --wait \u7B49\u7ED3\u679C\uFF0C\u6CA1\u6709\u65F6\u8FD0\u884C atrium restart \u63A5\u7BA1\u5347\u7EA7"
      );
  } catch {
  }
  return unavailable(record, data);
}
async function stopService(data) {
  const record = readService(data);
  if (!record || !alive(record.pid)) {
    console.log("Atrium \u5DF2\u505C\u6B62");
    return;
  }
  try {
    await request2(record);
    await request2(record, true);
  } catch {
    throw unavailable(record, data);
  }
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const current = readService(data);
    if (!current || current.instance !== record.instance || !alive(record.pid)) {
      console.log("Atrium \u5DF2\u505C\u6B62\uFF1B\u6570\u636E\u5DF2\u4FDD\u7559");
      return;
    }
    await delay(100);
  }
  throw new Error(
    "Atrium \u4ECD\u5728\u5173\u95ED\uFF1B\u672A\u5F3A\u5236\u7EC8\u6B62\u8FDB\u7A0B\u3002\u8BF7\u7A0D\u540E\u8FD0\u884C atrium status\u3002"
  );
}
async function startService(data, {
  totalMs = 6e4,
  stallMs = 12e3,
  noticeMs = 5e3,
  notice = (message) => console.error(message),
  entry
} = {}) {
  const waitStarted = Date.now();
  let waitNoticed = false;
  for (let state = restartInProgress(data); state; ) {
    const current = readService(data);
    if (current && alive(current.pid) && await probe(current) === "ready" && state.status !== "stopping")
      return current;
    if (Date.now() - waitStarted >= totalMs)
      throw new Error(
        `Atrium \u6B63\u5728\u91CD\u542F\uFF08${state.status}\uFF09\uFF0C\u5DF2\u7B49 ${Math.round(totalMs / 1e3)} \u79D2\u4ECD\u672A\u5C31\u7EEA\uFF1B\u8FD0\u884C atrium restart --wait \u67E5\u770B\u7ED3\u679C`
      );
    if (!waitNoticed && Date.now() - waitStarted >= noticeMs) {
      waitNoticed = true;
      notice("Atrium \u6B63\u5728\u91CD\u542F\uFF0C\u7B49\u65B0\u670D\u52A1\u5C31\u7EEA\u2026");
    }
    await delay(100);
    state = restartInProgress(data);
  }
  let record = readService(data);
  let child;
  let launchError;
  let logStart = 0;
  if (!record || !alive(record.pid)) {
    const port = servicePort();
    const taken = portTakenMessage(port, await probePort(port), data);
    if (taken) throw new Problem(409, `Atrium \u672A\u542F\u52A8\uFF1A${taken}`, "conflict");
    const legacy = !existsSync3(data) && legacyDataNotice();
    if (legacy) notice(legacy);
    mkdirSync2(data, { recursive: true, mode: 448 });
    const log = openSync2(join4(data, "service.log"), "a", 384);
    logStart = fstatSync(log).size;
    try {
      const { env, droppedSensitive } = serviceEnvironment(process.env);
      reportDroppedIdentity(droppedSensitive);
      child = spawnNode(serviceArgs(entry), {
        cwd: data,
        env: {
          ...env,
          ATRIUM_DATA: data
        },
        detached: true,
        stdio: ["ignore", log, log]
      });
      child.on("error", (error) => {
        launchError = error;
      });
      child.unref();
    } finally {
      closeSync2(log);
    }
  }
  const started = Date.now();
  let lastProgress = started;
  let lastInstance = record?.instance;
  let lastLog = logSize(data);
  let noticed = false;
  for (; ; ) {
    if (launchError) throw launchError;
    record = readService(data);
    const state = record && alive(record.pid) ? await probe(record) : "down";
    if (state === "ready") return record;
    const childExited = child?.exitCode != null || child?.signalCode != null;
    if (childExited && (!record || !alive(record.pid)))
      throw startupFailure(
        data,
        `Atrium \u542F\u52A8\u5931\u8D25\uFF08${child.exitCode != null ? `\u9000\u51FA\u7801 ${child.exitCode}` : `\u4FE1\u53F7 ${child.signalCode}`}\uFF09`,
        logStart
      );
    const now = Date.now();
    if (state === "down") {
      const size = logSize(data);
      if (record?.instance !== lastInstance || size !== lastLog)
        lastProgress = now;
      lastInstance = record?.instance;
      lastLog = size;
    }
    const ours = child !== void 0 && !childExited;
    if (now - started >= totalMs || !ours && now - lastProgress >= stallMs)
      break;
    if (!noticed && now - started >= noticeMs) {
      noticed = true;
      notice(
        `Atrium \u670D\u52A1\u542F\u52A8\u4E2D\u2026\uFF08\u6700\u957F\u7B49 ${Math.round(totalMs / 1e3)} \u79D2\uFF1B\u65E5\u5FD7\uFF1A${join4(data, "service.log")}\uFF09`
      );
    }
    await delay(100);
  }
  if (record && alive(record.pid)) throw await unavailableReason(record, data);
  throw startupFailure(
    data,
    `Atrium \u542F\u52A8\u8D85\u65F6\uFF08\u5DF2\u7B49 ${Math.round((Date.now() - started) / 1e3)} \u79D2\uFF09`,
    logStart
  );
}

// server/install-version.ts
import { mkdtempSync, readFileSync as readFileSync3, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join5 } from "node:path";
var ok = (run) => {
  if (run.error) throw run.error;
  return run;
};
async function installVersion(version, repo) {
  const source = repo.startsWith("github:") ? `https://github.com/${repo.slice("github:".length)}.git` : repo;
  const dir = mkdtempSync(join5(tmpdir(), "atrium-install-"));
  const checkout = join5(dir, "source");
  const npm = async (args, options) => ok(await runCommand("npm", args, { ...options, env: process.env }));
  try {
    ok(
      await runFile(
        "git",
        ["clone", "--depth", "1", "--branch", `v${version}`, source, checkout],
        {
          cwd: dir,
          timeout: 6e4
        }
      )
    );
    const pkg = JSON.parse(
      readFileSync3(join5(checkout, "package.json"), "utf8")
    );
    if (pkg.version !== version)
      throw new Error(`\u7248\u672C\u6807\u7B7E v${version} \u7684\u5185\u5BB9\u7248\u672C\u662F ${pkg.version}`);
    const { stdout } = await npm(
      ["pack", "--json", "--pack-destination", dir],
      { cwd: checkout, timeout: 6e4 }
    );
    const files = JSON.parse(stdout);
    if (files.length !== 1 || !/^atrium-[\d.]+\.tgz$/.test(files[0].filename))
      throw new Error("\u7248\u672C\u4EA7\u7269\u6253\u5305\u5931\u8D25");
    await npm(["install", "-g", join5(dir, files[0].filename)], {
      cwd: dir,
      timeout: 24e4
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// server/supervisor.ts
var { request: httpRequest } = process.getBuiltinModule(
  "node:http"
);
function restartStatePath(data) {
  return join6(data, "restart-state.json");
}
function readRestartState(data) {
  const path = restartStatePath(data);
  if (!existsSync4(path)) return null;
  try {
    const state = JSON.parse(
      readFileSync4(path, "utf8")
    );
    if (!state || typeof state.id !== "string" || ![
      "waiting_idle",
      "idle_timeout",
      "stopping",
      "starting",
      "checking",
      "success",
      "rolling_back",
      "rolled_back",
      "failed"
    ].includes(state.status ?? "") || !Number.isSafeInteger(state.supervisorPid) || !Number.isSafeInteger(state.startedAt) || typeof state.fromVersion !== "string" || typeof state.data !== "string")
      throw new Error("\u5B57\u6BB5\u65E0\u6548");
    return state;
  } catch (error) {
    try {
      const preserved = `${path}.invalid-${Date.now()}-${process.pid}`;
      renameSync2(path, preserved);
      console.warn(`\u91CD\u542F\u72B6\u6001\u8BB0\u5F55\u635F\u574F\uFF0C\u5DF2\u79FB\u81F3 ${preserved}\uFF1A${String(error)}`);
    } catch (moveError) {
      console.warn(`\u91CD\u542F\u72B6\u6001\u8BB0\u5F55\u635F\u574F\u4E14\u65E0\u6CD5\u632A\u5F00 ${path}\uFF1A${String(moveError)}`);
    }
    return null;
  }
}
function discardLegacyIdleRestart(data) {
  const state = readRestartState(data);
  if (state?.status !== "waiting_idle" && state?.status !== "idle_timeout")
    return false;
  try {
    unlinkSync(restartStatePath(data));
    console.warn(
      `[${(/* @__PURE__ */ new Date()).toISOString()}] \u4E22\u5F03\u65E7\u7248\u5F85\u7A7A\u95F2\u91CD\u542F\u8BB0\u5F55\uFF08${state.id}\uFF0C${state.status}\uFF09\uFF1A\u91CD\u542F\u5DF2\u4E0D\u9700\u8981\u7B49\u6267\u884C\u8005\u7A7A\u95F2\uFF0C\u4E0D\u518D\u6321\u6D3E\u6D3B`
    );
  } catch (error) {
    console.warn(`\u4E22\u5F03\u65E7\u7248\u5F85\u7A7A\u95F2\u91CD\u542F\u8BB0\u5F55\u5931\u8D25\uFF1A${String(error)}`);
  }
  return true;
}
function restartInProgress(data) {
  const state = readRestartState(data);
  return state && ["stopping", "starting", "checking", "rolling_back"].includes(
    state.status
  ) && state.supervisorPid > 0 && state.supervisorPid !== process.pid && alive(state.supervisorPid) ? state : null;
}
function writeRestartState(data, state) {
  mkdirSync3(data, { recursive: true, mode: 448 });
  const path = restartStatePath(data);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 384,
      flag: "wx"
    });
    renameSync2(temp, path);
  } finally {
    if (existsSync4(temp)) unlinkSync(temp);
  }
}
async function checkServiceHealth(record) {
  const statusRes = await localFetch(`${serviceUrl(record)}/api/service`, {
    headers: { authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(4e3)
  });
  if (!statusRes.ok)
    throw new Error(`\u670D\u52A1\u63A5\u53E3\u65E0\u54CD\u5E94 (HTTP ${statusRes.status})`);
  const statusJson = await statusRes.json();
  if (statusJson.instance !== record.instance || statusJson.pid !== record.pid)
    throw new Error("\u670D\u52A1\u8EAB\u4EFD\u4E0D\u5339\u914D");
  if (statusJson.stopping) throw new Error("\u670D\u52A1\u4ECD\u5904\u4E8E stopping \u72B6\u6001");
  const deadline = Date.now() + 15e3;
  let healthError = "\u670D\u52A1\u672A\u5C31\u7EEA";
  let ready = false;
  while (Date.now() < deadline) {
    if (!alive(record.pid)) throw new Error("\u670D\u52A1\u5728\u5C31\u7EEA\u524D\u9000\u51FA");
    const healthRes = await localFetch(
      `${serviceUrl(record)}/api/service/health`,
      {
        headers: { authorization: `Bearer ${record.token}` },
        signal: AbortSignal.timeout(6e3)
      }
    );
    const health = await healthRes.json().catch(() => ({}));
    if (healthRes.ok && health.ok) {
      ready = true;
      break;
    }
    healthError = health.runtimes?.error ?? healthError;
    await delay2(250);
  }
  if (!ready) throw new Error(`\u5065\u5EB7\u68C0\u67E5\u672A\u901A\u8FC7\uFF1A${healthError}`);
}
async function startSupervisor(options) {
  const data = options.data;
  const previous = readRestartState(data);
  const taskId = `rst-${Date.now()}`;
  const pendingPath = join6(data, "pending-update.json");
  const pending = existsSync4(pendingPath) ? JSON.parse(readFileSync4(pendingPath, "utf8")) : null;
  if (pending && pending.to !== currentVersion())
    throw new Error("\u5F85\u751F\u6548\u7248\u672C\u4E0E\u5F53\u524D\u5B89\u88C5\u7248\u672C\u4E0D\u7B26\uFF1B\u8BF7\u91CD\u65B0\u8FD0\u884C atrium update");
  const fromVersion = options.fromVersion ?? pending?.from ?? currentVersion();
  const initialState = {
    id: taskId,
    status: "stopping",
    supervisorPid: 0,
    startedAt: Date.now(),
    fromVersion,
    targetVersion: options.targetVersion ?? pending?.to ?? currentVersion(),
    repo: pending?.repo ?? process.env.ATRIUM_UPDATE_REPO,
    data,
    recoverOldPid: previous?.status === "failed" ? previous.oldPid : void 0
  };
  writeRestartState(data, initialState);
  const supervisorScript = join6(packageRoot, "bin/restart-supervisor.mjs");
  const { env, droppedSensitive } = serviceEnvironment(process.env);
  reportDroppedIdentity(droppedSensitive);
  const logPath = join6(data, "supervisor.log");
  mkdirSync3(data, { recursive: true, mode: 448 });
  const log = openSync3(logPath, "a", 384);
  const args = [
    supervisorScript,
    "--data",
    data,
    "--task-id",
    taskId,
    "--from-version",
    fromVersion,
    ...options.targetVersion ? ["--target-version", options.targetVersion] : [],
    ...options.agentTimeout ? ["--agent-timeout", String(options.agentTimeout)] : []
  ];
  const child = spawnNode(args, {
    cwd: data,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      ATRIUM_DATA: data
    }
  });
  closeSync3(log);
  child.unref();
  initialState.supervisorPid = child.pid;
  writeRestartState(data, initialState);
  return { pid: child.pid, taskId };
}
async function requestDrain(record, timeout) {
  const bodyText = JSON.stringify({ timeout, supervisorPid: process.pid });
  const response = await new Promise(
    (resolvePromise, reject) => {
      const req = httpRequest(
        `${serviceUrl(record)}/api/service/prepare-restart`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${record.token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyText)
          },
          signal: AbortSignal.timeout(timeout + 1e4)
        },
        (res) => {
          const chunks = [];
          res.on("error", reject);
          res.on("data", (chunk) => chunks.push(chunk));
          res.on(
            "end",
            () => resolvePromise({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8")
            })
          );
        }
      );
      req.on("error", reject);
      req.end(bodyText);
    }
  );
  const parsed = (() => {
    try {
      return JSON.parse(response.body);
    } catch {
      return {};
    }
  })();
  if (response.status !== 200)
    throw new Error(
      `\u65E7\u670D\u52A1\u62D2\u7EDD\u5E73\u6ED1\u9000\u51FA\uFF08HTTP ${response.status}\uFF09\uFF1A${parsed.error ?? "\u8BF7\u68C0\u67E5\u65E7\u670D\u52A1\u65E5\u5FD7"}`
    );
}
async function reclaimStoppedService(record, data) {
  const current = readService(data);
  if (!current || current.instance !== record.instance || current.pid !== record.pid)
    throw new Error("\u65E7\u670D\u52A1\u767B\u8BB0\u5DF2\u53D8\u5316\uFF0C\u4E0D\u80FD\u6309 PID \u7ED3\u675F\u8FDB\u7A0B");
  if ((await probePort(record.port)).kind !== "free")
    throw new Error("\u65E7\u670D\u52A1\u4ECD\u5728\u76D1\u542C\uFF0C\u4E0D\u80FD\u5F3A\u5236\u7ED3\u675F\u8FDB\u7A0B");
  const db = new DatabaseSync2(join6(data, "atrium.sqlite"), { readOnly: true });
  try {
    db.prepare("SELECT id, status, pid FROM tasks ORDER BY id LIMIT 1").all();
    const unrecorded = db.prepare(
      "SELECT id FROM tasks WHERE status='running' AND pid IS NULL LIMIT 1"
    ).get();
    if (unrecorded)
      throw new Error("\u6709\u8FD0\u884C\u4E2D\u4EFB\u52A1\u5C1A\u672A\u8BB0\u5F55\u6267\u884C\u8005 PID\uFF0C\u4E0D\u80FD\u7ED3\u675F\u65E7\u670D\u52A1");
  } finally {
    db.close();
  }
  if (!alive(record.pid)) return;
  const call = commandLineInvocation(process.platform, record.pid);
  const { error, stdout: command } = await runFile(call.command, call.args, {
    timeout: 15e3
  });
  if (error) throw error;
  if (!/(?:^|[\s"/\\])server[/\\]main\.ts(?:["\s]|$)/.test(command))
    throw new Error("\u65E7\u670D\u52A1 PID \u5DF2\u4E0D\u662F Atrium \u670D\u52A1\u8FDB\u7A0B\uFF0C\u4E0D\u80FD\u5F3A\u5236\u7ED3\u675F");
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error2) {
    if (error2.code !== "ESRCH") throw error2;
  }
  for (let i = 0; i < 20 && alive(record.pid); i++) await delay2(100);
  if (alive(record.pid)) {
    try {
      process.kill(record.pid, "SIGKILL");
    } catch (error2) {
      if (error2.code !== "ESRCH") throw error2;
    }
    for (let i = 0; i < 30 && alive(record.pid); i++) await delay2(100);
  }
  if (alive(record.pid)) throw new Error("\u65E7\u670D\u52A1\u8FDB\u7A0B\u4ECD\u672A\u9000\u51FA");
}
async function runSupervisor(args) {
  let data = "";
  let taskId = "";
  let fromVersion = "";
  let targetVersion;
  let agentTimeout = 3e5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) data = args[++i];
    else if (args[i] === "--task-id" && args[i + 1]) taskId = args[++i];
    else if (args[i] === "--from-version" && args[i + 1])
      fromVersion = args[++i];
    else if (args[i] === "--target-version" && args[i + 1])
      targetVersion = args[++i];
    else if (args[i] === "--agent-timeout" && args[i + 1])
      agentTimeout = Number(args[++i]);
  }
  if (!data) throw new Error("\u7F3A\u5C11 --data \u53C2\u6570");
  const state = readRestartState(data) ?? {
    id: taskId || `rst-${Date.now()}`,
    status: "stopping",
    supervisorPid: process.pid,
    startedAt: Date.now(),
    fromVersion: fromVersion || currentVersion(),
    targetVersion,
    data
  };
  state.supervisorPid = process.pid;
  writeRestartState(data, state);
  const oldRecord = readService(data);
  if (oldRecord && alive(oldRecord.pid)) {
    state.oldPid = oldRecord.pid;
    writeRestartState(data, state);
    try {
      try {
        await requestDrain(oldRecord, agentTimeout);
      } catch (error) {
        if (state.recoverOldPid !== oldRecord.pid) throw error;
        await reclaimStoppedService(oldRecord, data);
      }
      if (alive(oldRecord.pid)) {
        try {
          await stopService(data);
        } catch (error) {
          console.warn(
            `\u65E7\u670D\u52A1\u672A\u6309\u65F6\u9000\u51FA\uFF0C\u68C0\u67E5\u6301\u4E45\u5316\u8BB0\u5F55\u540E\u63A5\u7BA1\uFF1A${String(error)}`
          );
          await reclaimStoppedService(oldRecord, data);
        }
      }
    } catch (error) {
      state.status = "failed";
      state.error = `\u65E7\u670D\u52A1\u672A\u505C\u6B62\uFF1A${String(error)}`;
      state.finishedAt = Date.now();
      writeRestartState(data, state);
      return;
    }
  }
  state.status = "starting";
  writeRestartState(data, state);
  let newRecord;
  try {
    newRecord = await startService(data);
    state.newPid = newRecord.pid;
    state.status = "checking";
    writeRestartState(data, state);
    await checkServiceHealth(newRecord);
    const reported = await (await localFetch(`${serviceUrl(newRecord)}/api/service`, {
      headers: { authorization: `Bearer ${newRecord.token}` }
    })).json();
    if (reported.version !== state.targetVersion)
      throw new Error(
        `\u542F\u52A8\u7248\u672C\u4E0D\u7B26\uFF1A\u9884\u671F ${state.targetVersion}\uFF0C\u5B9E\u9645 ${reported.version}`
      );
    state.status = "success";
    state.finishedAt = Date.now();
    writeRestartState(data, state);
    const pendingPath = join6(data, "pending-update.json");
    if (existsSync4(pendingPath)) unlinkSync(pendingPath);
    return;
  } catch (err) {
    console.error("\u65B0\u7248\u672C\u542F\u52A8\u6216\u5065\u5EB7\u68C0\u67E5\u5931\u8D25\uFF0C\u51C6\u5907\u81EA\u52A8\u56DE\u6EDA\uFF1A", err);
    state.status = "rolling_back";
    state.error = err.message;
    state.failedVersion = state.targetVersion ?? currentVersion();
    state.rollbackVersion = state.fromVersion;
    writeRestartState(data, state);
    try {
      if (newRecord) await stopService(data);
    } catch (stopError) {
      state.status = "failed";
      state.error += `\uFF1B\u65E0\u6CD5\u505C\u6B62\u5931\u8D25\u7248\u672C\uFF1A${String(stopError)}`;
      state.finishedAt = Date.now();
      writeRestartState(data, state);
      return;
    }
    if (state.fromVersion && state.fromVersion !== state.failedVersion) {
      try {
        await installVersion(
          state.fromVersion,
          state.repo ?? "github:liu-zhengdong/atrium"
        );
      } catch (rollbackErr) {
        state.status = "failed";
        state.error += `\uFF1B\u88C5\u56DE\u65E7\u7248\u672C\u5931\u8D25\uFF1A${String(rollbackErr)}`;
        state.finishedAt = Date.now();
        writeRestartState(data, state);
        return;
      }
    }
    try {
      const rolledBack = await startService(data);
      state.newPid = rolledBack.pid;
      await checkServiceHealth(rolledBack);
    } catch (startOldErr) {
      state.status = "failed";
      state.error += `\uFF1B\u56DE\u6EDA\u7248\u672C\u672A\u80FD\u542F\u52A8\uFF1A${String(startOldErr)}`;
      state.finishedAt = Date.now();
      writeRestartState(data, state);
      return;
    }
    state.status = "rolled_back";
    state.finishedAt = Date.now();
    writeRestartState(data, state);
    const pendingPath = join6(data, "pending-update.json");
    if (existsSync4(pendingPath)) unlinkSync(pendingPath);
    process.exitCode = 1;
  }
}
async function waitForRestart(data, timeoutMs = 3e5) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state2 = readRestartState(data);
    if (state2) {
      if (state2.status === "success" || state2.status === "rolled_back" || state2.status === "failed") {
        return state2;
      }
    }
    await delay2(100);
  }
  const state = readRestartState(data);
  throw new Problem(
    504,
    `\u7B49\u5F85\u5E73\u6ED1\u91CD\u542F\u8D85\u65F6\uFF08\u5F53\u524D\uFF1A${state?.status ?? "\u5C1A\u672A\u542F\u52A8"}\uFF09\uFF1B\u540E\u53F0\u4EFB\u52A1\u4ECD\u53EF\u80FD\u5728\u7EE7\u7EED\u3002\u8FD0\u884C atrium restart --wait --timeout 300 \u67E5\u770B\u6700\u7EC8\u7ED3\u679C`,
    "restart_timeout"
  );
}
export {
  checkServiceHealth,
  discardLegacyIdleRestart,
  readRestartState,
  reclaimStoppedService,
  requestDrain,
  restartInProgress,
  restartStatePath,
  runSupervisor,
  startSupervisor,
  waitForRestart,
  writeRestartState
};
