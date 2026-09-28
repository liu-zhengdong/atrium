import {
  checkPlacement,
  ensureWorktree,
  exec,
  firstLine,
  hostGate,
  hostLimits
} from "./chunk-UTFLUNMS.js";
import "./chunk-BYXBJQAS.js";
import {
  ADAPTERS,
  TOOLS,
  isTool
} from "./chunk-FFWKAFBZ.js";
import {
  currentVersion
} from "./chunk-4ZZXUNTR.js";
import {
  AgentState,
  agentDataDir
} from "./chunk-NCWPTG3H.js";
import {
  Problem,
  WINDOWS_SYSTEM_ENV,
  commandInvocation,
  commandLineInvocation,
  envKey,
  findExecutable,
  killTree,
  processAlive,
  spawnInvocation,
  spawnShell
} from "./chunk-P53LWH5T.js";

// server/agent/main.ts
import {
  existsSync as existsSync6,
  mkdirSync as mkdirSync5,
  openSync as openSync4,
  readSync as readSync2,
  closeSync as closeSync4,
  readFileSync as readFileSync3,
  rmSync as rmSync2,
  statSync as statSync3
} from "node:fs";
import { availableParallelism as availableParallelism3, loadavg } from "node:os";
import { join as join5 } from "node:path";

// server/tasks/local-check.ts
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// server/tasks/worker-env.ts
import { availableParallelism } from "node:os";
var SYSTEM = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  "TERM"
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
var WINDOWS = new Set(WINDOWS_SYSTEM_ENV);
function workerAllowed(key, platform = process.platform) {
  const name = envKey(platform, key);
  return SYSTEM.has(name) || NETWORK.has(name) || name.startsWith("LC_") || platform === "win32" && WINDOWS.has(name);
}
function workerEnvironment(base = process.env, platform = process.platform) {
  const env = {};
  for (const [key, value] of Object.entries(base))
    if (value !== void 0 && workerAllowed(key, platform))
      env[envKey(platform, key)] = value;
  env.NO_COLOR = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GH_PROMPT_DISABLED = "1";
  env.ATRIUM_WORKER = "1";
  env.ATRIUM_TEST_CONCURRENCY = String(
    hostLimits(base, availableParallelism()).limits.testConcurrency
  );
  return env;
}

// server/tasks/local-check.ts
var LOCAL_CHECK_TIMEOUT_MS = 15 * 6e4;
var LocalCheckQueue = class {
  constructor(max = 1) {
    this.max = max;
  }
  max;
  active = 0;
  urgentActive = 0;
  waiters = [];
  get limit() {
    return this.max;
  }
  /** 调整并发上限；调大时立刻放行等着的。 */
  set limit(value) {
    this.max = Math.max(1, Math.floor(value));
    this.pump();
  }
  get size() {
    return {
      running: this.active + this.urgentActive,
      waiting: this.waiters.length
    };
  }
  pump() {
    while (this.active < this.max && this.waiters.length) {
      this.active++;
      this.waiters.shift()();
    }
  }
  async run(work, queued, urgent = false) {
    if (checkPlacement({ urgent, active: this.active, max: this.max }) === "run") {
      if (urgent) {
        this.urgentActive++;
        try {
          return await work();
        } finally {
          this.urgentActive--;
        }
      }
      this.active++;
    } else {
      try {
        queued?.();
      } catch {
      }
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        this.pump();
      });
    }
    try {
      return await work();
    } finally {
      this.active--;
      this.pump();
    }
  }
};
var sharedLocalChecks = new LocalCheckQueue();
async function checkCommand(worktree) {
  const root = await realpath(worktree);
  const inside = async (file) => {
    const target = await realpath(file);
    const path = relative(root, target);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`\u68C0\u67E5\u811A\u672C\u6307\u5411\u5DE5\u4F5C\u6811\u5916\uFF1A${file}`);
    return target;
  };
  try {
    const script = (await readFile(await inside(join(worktree, ".agents", "check")), "utf8")).trim();
    if (!script) throw new Error(".agents/check \u4E3A\u7A7A");
    return script;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let pkg;
  try {
    pkg = JSON.parse(
      await readFile(await inside(join(worktree, "package.json")), "utf8")
    );
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("\u6CA1\u6709 .agents/check \u6216 package.json \u7684 check \u811A\u672C");
    throw error;
  }
  if (typeof pkg.scripts?.check !== "string" || !pkg.scripts.check.trim())
    throw new Error("package.json \u6CA1\u6709 check \u811A\u672C");
  return "npm run check";
}
function failedTestNames(log) {
  const names = /* @__PURE__ */ new Set();
  for (const line of log.split("\n")) {
    const name = line.match(/^\s*(?:not ok \d+ - |✖\s+|FAIL\s+)(.+)/)?.[1]?.trim();
    if (name && name !== "failing tests:") names.add(name.slice(0, 200));
  }
  return [...names].slice(0, 10);
}
function logTail(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
async function runLocalCheck(input) {
  const log = join(input.taskDir, "local-check.log");
  return (input.queue ?? sharedLocalChecks).run(
    async () => {
      if (input.signal?.aborted) throw new Error("\u670D\u52A1\u6B63\u5728\u5173\u95ED");
      mkdirSync(input.taskDir, { recursive: true, mode: 448 });
      let command = "";
      try {
        if (!input.worktree)
          throw new Error("\u4EFB\u52A1\u6CA1\u6709 worktree\uFF0C\u4E0D\u80FD\u8FD0\u884C\u672C\u5730\u68C0\u67E5");
        command = await checkCommand(input.worktree);
      } catch (error) {
        writeFileSync(log, `${String(error)}
`, {
          mode: 384,
          flag: input.append ? "a" : "w"
        });
        return {
          status: "error",
          command,
          log,
          detail: String(error),
          failedTests: []
        };
      }
      try {
        input.onStatus?.("started", log);
      } catch {
      }
      const fd = openSync(log, input.append ? "a" : "w", 384);
      let child;
      try {
        child = spawnShell(command, {
          cwd: input.worktree,
          env: workerEnvironment(input.env),
          detached: true,
          stdio: ["ignore", fd, fd]
        });
      } catch (error) {
        closeSync(fd);
        return {
          status: "error",
          command,
          log,
          detail: String(error),
          failedTests: []
        };
      }
      closeSync(fd);
      let timedOut = false;
      const abort = () => {
        if (child.pid) killTree(child.pid, "SIGKILL");
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS);
      const result = await new Promise(
        (resolve) => {
          child.once("error", (error) => resolve({ code: null, error }));
          child.once("close", (code) => resolve({ code }));
        }
      );
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const tail = logTail(log);
      const failedTests = failedTestNames(tail);
      const status = timedOut ? "timeout" : result.error ? "error" : result.code === 0 ? "passed" : "failed";
      const detail = timedOut ? `\u8D85\u8FC7 ${Math.ceil((input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS) / 6e4)} \u5206\u949F` : result.error?.message ?? (result.code === 0 ? "\u68C0\u67E5\u901A\u8FC7" : `\u9000\u51FA\u7801 ${result.code}`);
      return { status, command, log, detail, failedTests };
    },
    () => input.onStatus?.("queued", log),
    input.urgent
  );
}

// server/tasks/spawn.ts
import {
  appendFileSync,
  closeSync as closeSync2,
  existsSync,
  openSync as openSync2,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync as writeFileSync2
} from "node:fs";

// server/tasks/live-input.ts
var userLine = (text, uuid, dialect = "claude") => dialect === "agy" ? `${JSON.stringify({ event: "user", message: { role: "user", content: text } })}
` : `${JSON.stringify({
  type: "user",
  ...uuid ? { uuid } : {},
  session_id: "",
  parent_tool_use_id: null,
  message: { role: "user", content: text }
})}
`;
var LINE_MAX = 16 * 1024 * 1024;
var CHUNK = 256 * 1024;

// server/tasks/spawn.ts
var shortArg = (arg) => {
  const flat = arg.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 77)}\u2026` : flat;
};
async function spawnWorker(prepared, env, taskRefText, append = false) {
  const { launch, logFile } = prepared;
  if (!append && existsSync(logFile))
    renameSync(logFile, `${logFile}-${Date.now()}`);
  const childEnv = launch.env ? { ...env, ...launch.env } : env;
  let invocation;
  try {
    invocation = commandInvocation(launch.command, launch.args, childEnv);
  } catch (error) {
    throw new Problem(
      500,
      `\u62C9\u8D77 ${prepared.worker.id} \u5931\u8D25\uFF1A${error.message}`,
      "internal"
    );
  }
  const command = invocation.command;
  const header = `[atrium] ${taskRefText} \xB7 ${prepared.worker.id} \xB7 ${(/* @__PURE__ */ new Date()).toISOString()}${append ? " \xB7 \u7EED\u4E0A\u4F1A\u8BDD" : ""}
[atrium] cwd ${launch.cwd}
${Object.entries(
    launch.env ?? {}
  ).map(([key, value]) => `[atrium] env ${key}=${value}
`).join(
    ""
  )}[atrium] ${[command, ...invocation.args.map(shortArg)].join(" ")}
`;
  if (append) appendFileSync(logFile, header, { mode: 384 });
  else writeFileSync2(logFile, header, { mode: 384 });
  const offset = statSync(logFile).size;
  const out = openSync2(logFile, "a");
  const piped = launch.input === "stream-json";
  const input = launch.stdin && !piped ? openSync2(launch.stdin, "r") : piped ? "pipe" : "ignore";
  let child;
  try {
    child = spawnInvocation(invocation, {
      cwd: launch.cwd,
      env: childEnv,
      detached: true,
      stdio: [input, out, out]
    });
  } finally {
    closeSync2(out);
    if (typeof input === "number") closeSync2(input);
  }
  if (!child.pid) {
    const error = await new Promise(
      (resolve) => child.once("error", resolve)
    );
    throw new Problem(
      500,
      `\u62C9\u8D77 ${prepared.worker.id} \u5931\u8D25\uFF1A${error.message}`,
      "internal"
    );
  }
  if (piped && child.stdin) {
    child.stdin.on("error", () => {
    });
    if (launch.stdin)
      child.stdin.write(
        userLine(
          readFileSync(launch.stdin, "utf8"),
          void 0,
          launch.inputDialect
        )
      );
    child.stdin.unref?.();
  }
  child.unref();
  return { child, offset };
}

// server/hosts/state.ts
import { posix, win32 } from "node:path";
var JOIN_TTL_MS = 30 * 6e4;
var flavor = (os) => os === "win32" ? win32 : posix;
function insideData(os, dataDir, target) {
  const path = flavor(os);
  if (!path.isAbsolute(target)) return false;
  const rel = path.relative(path.resolve(dataDir), path.resolve(target));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function backoffMs(attempt) {
  return Math.min(15e3, 1e3 * 2 ** Math.max(0, Math.min(attempt, 10)));
}
var isKnownTool = (value) => typeof value === "string" && TOOLS.includes(value);

// server/tasks/recovery.ts
async function ownsPid(pid, tool, exec2) {
  if (!processAlive(pid)) return false;
  const call = commandLineInvocation(process.platform, pid);
  const ps = await exec2(call.command, call.args, { timeoutMs: 1e4 });
  return ps.ok && ps.stdout.includes(ADAPTERS[tool].executable);
}

// server/hosts/info.ts
import { existsSync as existsSync2 } from "node:fs";
import { availableParallelism as availableParallelism2, homedir, hostname, totalmem } from "node:os";
import { join as join2 } from "node:path";
var LOGIN_FILES = {
  claude: [".claude/.credentials.json", ".claude.json"],
  codex: [".codex/auth.json"],
  opencode: [".local/share/opencode/auth.json"],
  kimi: [],
  grok: [],
  agy: [],
  cursor: []
};
function loggedIn(tool, platform, exists) {
  if (LOGIN_FILES[tool].some(exists)) return true;
  if (tool === "codex") return false;
  if (tool === "claude" && platform !== "darwin") return false;
  return null;
}
function detectClis(env, platform = process.platform) {
  const home = env.HOME || homedir();
  const clis = {};
  for (const tool of TOOLS) {
    if (!findExecutable(ADAPTERS[tool].executable, env.PATH ?? "")) continue;
    clis[tool] = {
      installed: true,
      logged_in: loggedIn(
        tool,
        platform,
        (relative2) => existsSync2(join2(home, relative2))
      )
    };
  }
  return clis;
}
function machineInfo(input) {
  const cores = availableParallelism2();
  const limits = hostLimits(input.env, cores).limits;
  return {
    hostname: hostname(),
    os: process.platform,
    arch: process.arch,
    cpus: cores,
    mem_mb: Math.round(totalmem() / 1024 / 1024),
    node: process.version,
    version: input.version,
    data_dir: input.dataDir,
    clis: detectClis(input.env),
    max_workers: limits.maxWorkers,
    max_checks: limits.maxChecks
  };
}

// server/hosts/protocol.ts
var LOG_CHUNK = 256 * 1024;
var POLL_WAIT_MS = 25e3;
var MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

// server/quota-readers/index.ts
import { execFile } from "node:child_process";
import { readFile as readFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";

// server/quota-readers/credentials.ts
import { createHash } from "node:crypto";
var MAX_CREDENTIAL_BYTES = 1024 * 1024;
function describeSource(source) {
  return source.kind === "file" ? source.path : `\u94A5\u5319\u4E32\u300C${source.service}\u300D`;
}
async function readSource(source, deps) {
  if (source.kind === "keychain")
    return deps.keychain(source.service, source.account);
  return deps.readFile(source.path);
}
async function firstCredential(sources, deps, parse) {
  let unreadable = false;
  for (const source of sources) {
    let text;
    try {
      text = await readSource(source, deps);
    } catch {
      unreadable = true;
      continue;
    }
    if (text === void 0) continue;
    if (text.length > MAX_CREDENTIAL_BYTES) {
      unreadable = true;
      continue;
    }
    const value = parse(text);
    if (value === void 0) {
      unreadable = true;
      continue;
    }
    return { ok: true, value, source };
  }
  return { ok: false, unreadable };
}
function parseJsonDocument(text) {
  try {
    return JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length % 2 || !/^[0-9a-f]+$/i.test(trimmed))
      return void 0;
    try {
      return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
    } catch {
      return void 0;
    }
  }
}
function accountKey(provider, id) {
  return createHash("sha256").update(`${provider}:${id}`).digest("hex").slice(0, 16);
}
function jwtPayload(token) {
  const payload = token.split(".")[1];
  if (!payload) return void 0;
  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    return data && typeof data === "object" && !Array.isArray(data) ? data : void 0;
  } catch {
    return void 0;
  }
}
function jwtExpiry(token) {
  const payload = token.split(".")[1];
  if (!payload) return void 0;
  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    const exp = data && typeof data === "object" ? data.exp : void 0;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1e3 : void 0;
  } catch {
    return void 0;
  }
}

// server/quota-readers/http.ts
var MAX_BODY_BYTES = 1024 * 1024;
async function getJson(url, headers, options) {
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await options.fetch(url, {
      method: "GET",
      headers,
      signal,
      redirect: "error"
    });
    const text = await response.text();
    let body;
    if (text.length <= MAX_BODY_BYTES)
      try {
        body = JSON.parse(text);
      } catch {
        body = void 0;
      }
    return { status: response.status, headers: response.headers, body };
  } catch {
    return { error: signal.aborted ? "timeout" : "network" };
  }
}
var isFailure = (reply) => "error" in reply;
var transportReason = (failure, who) => failure.error === "timeout" ? `${who} \u7528\u91CF\u63A5\u53E3\u8D85\u65F6` : `\u8FDE\u4E0D\u4E0A ${who} \u7528\u91CF\u63A5\u53E3`;
function retryAfter(value, now) {
  if (!value) return void 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1e3;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(now, at) : void 0;
}
var isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function numberOf(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : void 0;
}
function timeOf(value) {
  if (typeof value === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    const text = value.trim();
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
    const at = Date.parse(zoned);
    return Number.isFinite(at) ? at : null;
  }
  const raw = numberOf(value);
  if (raw === void 0) return null;
  return Math.round(Math.abs(raw) < 1e10 ? raw * 1e3 : raw);
}

// server/quota-readers/paths.ts
import { createHash as createHash2 } from "node:crypto";
import { posix as posix2, win32 as win322 } from "node:path";
var pathFor = (platform) => platform === "win32" ? win322 : posix2;
var nonEmpty = (value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
};
function expandHome(value, home, platform) {
  if (value === "~") return home;
  const rest = /^~[\\/]/.test(value) ? value.slice(2) : void 0;
  return rest === void 0 ? value : pathFor(platform).join(home, rest);
}
var CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
function scopedClaudeService(configDir) {
  const hash = createHash2("sha256").update(configDir.replace(/\\/g, "/")).digest("hex");
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash.slice(0, 8)}`;
}
function claudeSources(platform, home, env) {
  const path = pathFor(platform);
  const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const dirs = configDir ? [expandHome(configDir, home, platform)] : platform === "linux" ? [
    path.join(home, ".claude"),
    path.join(
      nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config"),
      "claude"
    )
  ] : [path.join(home, ".claude")];
  const files = dirs.map((dir) => ({
    kind: "file",
    path: path.join(dir, ".credentials.json")
  }));
  if (platform !== "darwin") return files;
  const services = configDir ? [scopedClaudeService(configDir), CLAUDE_KEYCHAIN_SERVICE] : [CLAUDE_KEYCHAIN_SERVICE];
  const user = nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME);
  const accounts = user ? [user, ""] : [""];
  const keychain = services.flatMap(
    (service) => accounts.map((account) => ({
      kind: "keychain",
      service,
      account
    }))
  );
  return [...keychain, ...files];
}
function claudeAccountFile(platform, home, env) {
  const path = pathFor(platform);
  const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return configDir ? path.join(expandHome(configDir, home, platform), ".claude.json") : path.join(home, ".claude.json");
}
function codexSources(platform, home, env) {
  const path = pathFor(platform);
  const codexHome = nonEmpty(env.CODEX_HOME);
  if (codexHome)
    return [
      {
        kind: "file",
        path: path.join(expandHome(codexHome, home, platform), "auth.json")
      }
    ];
  return [
    { kind: "file", path: path.join(home, ".config", "codex", "auth.json") },
    { kind: "file", path: path.join(home, ".codex", "auth.json") }
  ];
}
function opencodeSources(platform, home, env) {
  const path = pathFor(platform);
  const configured = nonEmpty(env.OPENCODE_DATA_DIR);
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  const dir = configured ? expandHome(configured, home, platform) : xdg ? path.join(expandHome(xdg, home, platform), "opencode") : path.join(home, ".local", "share", "opencode");
  return [{ kind: "file", path: path.join(dir, "auth.json") }];
}

// server/quota-readers/claude.ts
var CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
var DEFAULT_RATE_LIMIT_MS = 5 * 6e4;
var HOUR = 3600;
var WEEK = 7 * 24 * HOUR;
function parseClaudeLogin(text) {
  const document = parseJsonDocument(text);
  if (!isObject(document) || !isObject(document.claudeAiOauth))
    return void 0;
  const oauth = document.claudeAiOauth;
  const token = typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!token) return void 0;
  const stringOf = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    accessToken: token,
    expiresAt: numberOf(oauth.expiresAt) ?? null,
    subscriptionType: stringOf(oauth.subscriptionType),
    rateLimitTier: stringOf(oauth.rateLimitTier)
  };
}
function claudePlan(subscription, tier) {
  if (!subscription) return null;
  const plan = subscription.toLowerCase().split(/\s+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  const multiplier = tier?.split(/[^a-z0-9]+/i).find((part) => /^\d+x$/.test(part));
  return multiplier ? `${plan} ${multiplier}` : plan;
}
function percentWindow(id, label, percent, resets, periodSeconds) {
  const used = numberOf(percent);
  if (used === void 0) return void 0;
  return {
    id,
    label,
    usedPercent: used,
    resetsAt: timeOf(resets),
    periodSeconds
  };
}
var SCOPED_PERIOD = {
  weekly_scoped: WEEK,
  daily_scoped: 24 * HOUR,
  session_scoped: 5 * HOUR,
  five_hour_scoped: 5 * HOUR
};
function mapClaudeUsage(body) {
  if (!isObject(body)) return void 0;
  const windows = [];
  const push = (window) => {
    if (window) windows.push(window);
  };
  for (const [key, id, label, period] of [
    ["five_hour", "session", "Session", 5 * HOUR],
    ["seven_day", "weekly", "Weekly", WEEK],
    ["seven_day_sonnet", "sonnet", "Sonnet", WEEK]
  ]) {
    const value = body[key];
    if (isObject(value))
      push(
        percentWindow(id, label, value.utilization, value.resets_at, period)
      );
  }
  if (Array.isArray(body.limits))
    for (const limit of body.limits) {
      if (!isObject(limit)) continue;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      if (!kind.endsWith("_scoped")) continue;
      const scope = isObject(limit.scope) ? limit.scope : {};
      const model = isObject(scope.model) ? scope.model : {};
      const label = typeof model.display_name === "string" ? model.display_name.trim() : "";
      if (!label) continue;
      const slug = label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join("-");
      if (!slug) continue;
      const id = label === "Fable" && kind === "weekly_scoped" ? "fable" : kind === "weekly_scoped" ? `scoped-${slug}` : `scoped-${kind.replace(/_scoped$/, "")}-${slug}`;
      const period = numberOf(limit.period_seconds);
      push(
        percentWindow(
          id,
          label,
          limit.percent,
          limit.resets_at,
          period !== void 0 && period >= 0 ? Math.trunc(period) : SCOPED_PERIOD[kind] ?? 0
        )
      );
    }
  return windows.length ? windows : void 0;
}
var MAX_ACCOUNT_FILE = 32 * 1024 * 1024;
function claudeAccount(text) {
  if (!text || text.length > MAX_ACCOUNT_FILE) return null;
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const account = isObject(document) && isObject(document.oauthAccount) ? document.oauthAccount : {};
  const id = typeof account.accountUuid === "string" ? account.accountUuid.trim() : "";
  if (!id) return null;
  const org = typeof account.organizationUuid === "string" ? account.organizationUuid.trim() : "";
  return accountKey("claude", `${id}:${org}`);
}
async function readClaudeAccount(deps) {
  try {
    return claudeAccount(
      await deps.readFile(
        claudeAccountFile(deps.platform, deps.home, deps.env)
      )
    );
  } catch {
    return null;
  }
}
async function readClaude(deps) {
  const found = await firstCredential(
    claudeSources(deps.platform, deps.home, deps.env),
    deps,
    parseClaudeLogin
  );
  if (!found.ok)
    return {
      ok: false,
      reason: found.unreadable ? "Claude Code \u767B\u5F55\u6570\u636E\u8BFB\u4E0D\u51FA\uFF0C\u8FD0\u884C claude \u91CD\u65B0\u767B\u5F55" : "\u6CA1\u6709\u627E\u5230 Claude Code \u767B\u5F55\uFF0C\u8FD0\u884C claude \u767B\u5F55"
    };
  const login = found.value;
  const now = deps.now();
  if (login.expiresAt !== null && login.expiresAt <= now)
    return {
      ok: false,
      reason: `Claude Code \u767B\u5F55\u5DF2\u8FC7\u671F\uFF08${describeSource(found.source)}\uFF09\uFF0C\u8FD0\u884C\u4E00\u6B21 claude \u4F1A\u81EA\u52A8\u7EED\u671F`
    };
  const reply = await getJson(
    CLAUDE_USAGE_URL,
    {
      Authorization: `Bearer ${login.accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69"
    },
    deps
  );
  if (isFailure(reply))
    return { ok: false, reason: transportReason(reply, "Claude") };
  if (reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      reason: "Claude \u7528\u91CF\u63A5\u53E3\u62D2\u7EDD\u4E86\u767B\u5F55\uFF08\u4EE4\u724C\u5931\u6548\uFF09\uFF0C\u8FD0\u884C claude \u91CD\u65B0\u767B\u5F55"
    };
  if (reply.status === 429)
    return {
      ok: false,
      reason: "Claude \u7528\u91CF\u63A5\u53E3\u9650\u6D41",
      retryAt: retryAfter(reply.headers.get("retry-after"), now) ?? now + DEFAULT_RATE_LIMIT_MS
    };
  if (reply.status < 200 || reply.status >= 300)
    return { ok: false, reason: `Claude \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE HTTP ${reply.status}` };
  const windows = mapClaudeUsage(reply.body);
  if (!windows) return { ok: false, reason: "Claude \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE\u7684\u7ED3\u6784\u8BA4\u4E0D\u51FA" };
  return {
    ok: true,
    plan: claudePlan(login.subscriptionType, login.rateLimitTier),
    windows,
    refreshedAt: now,
    account: await readClaudeAccount(deps)
  };
}
var claudeReader = { provider: "claude", read: readClaude };

// server/quota-readers/codex.ts
var CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
var SESSION = 5 * 60 * 60;
var WEEK2 = 7 * 24 * 60 * 60;
function codexAccount(tokens, accountId) {
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : "";
  const claims = jwtPayload(idToken) ?? {};
  const auth = isObject(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : {};
  const user = [auth.chatgpt_user_id, auth.user_id, claims.sub].find(
    (value) => typeof value === "string" && !!value.trim()
  ) ?? null;
  if (!user && !accountId) return null;
  return accountKey("codex", `${user ?? ""}:${accountId ?? ""}`);
}
function parseCodexLogin(text) {
  const document = parseJsonDocument(text);
  if (!isObject(document)) return void 0;
  const tokens = isObject(document.tokens) ? document.tokens : {};
  const token = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (token) {
    const accountId = typeof tokens.account_id === "string" && tokens.account_id.trim() ? tokens.account_id.trim() : null;
    return {
      apiKeyOnly: false,
      accessToken: token,
      accountId,
      account: codexAccount(tokens, accountId)
    };
  }
  return typeof document.OPENAI_API_KEY === "string" && document.OPENAI_API_KEY.trim() ? { apiKeyOnly: true } : void 0;
}
function codexPlan(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (lower === "prolite") return "Pro 5x";
  if (lower === "pro") return "Pro 20x";
  return raw.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
}
function exactKind(window) {
  const seconds = numberOf(window?.limit_window_seconds);
  if (seconds === SESSION) return "session";
  if (seconds === WEEK2) return "weekly";
  return null;
}
function classified(rateLimit, ids, headers, now) {
  const limit = isObject(rateLimit) ? rateLimit : {};
  const candidates = [];
  for (const [key, header, fallback] of [
    ["primary_window", headers.primary, "session"],
    ["secondary_window", headers.secondary, "weekly"]
  ]) {
    const window = isObject(limit[key]) ? limit[key] : void 0;
    if (!window && header === void 0) continue;
    candidates.push({
      window,
      used: numberOf(window?.used_percent) ?? header,
      fallback
    });
  }
  const windows = [];
  for (const kind of ["session", "weekly"]) {
    const candidate = candidates.find((c) => exactKind(c.window) === kind) ?? candidates.find(
      (c) => exactKind(c.window) === null && c.fallback === kind
    );
    if (!candidate || candidate.used === void 0) continue;
    const resetAt = timeOf(candidate.window?.reset_at);
    const after = numberOf(candidate.window?.reset_after_seconds);
    const period = numberOf(candidate.window?.limit_window_seconds);
    const [id, label] = ids[kind];
    windows.push({
      id,
      label,
      usedPercent: candidate.used,
      resetsAt: resetAt ?? (after === void 0 ? null : now + Math.round(after * 1e3)),
      periodSeconds: period === void 0 ? kind === "session" ? SESSION : WEEK2 : Math.max(0, Math.trunc(period))
    });
  }
  return windows;
}
function mapCodexUsage(body, headers, now) {
  if (!isObject(body)) return void 0;
  const header = (name) => numberOf(headers.get(name));
  const windows = classified(
    body.rate_limit,
    { session: ["session", "Session"], weekly: ["weekly", "Weekly"] },
    {
      primary: header("x-codex-primary-used-percent"),
      secondary: header("x-codex-secondary-used-percent")
    },
    now
  );
  const spark = Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits.find(
    (entry) => isObject(entry) && ["limit_name", "metered_feature"].some(
      (key) => typeof entry[key] === "string" && entry[key].toLowerCase().includes("spark")
    )
  ) : void 0;
  if (isObject(spark))
    windows.push(
      ...classified(
        spark.rate_limit,
        {
          session: ["spark", "Spark"],
          weekly: ["sparkWeekly", "Spark Weekly"]
        },
        {},
        now
      )
    );
  return windows;
}
async function readCodex(deps) {
  const found = await firstCredential(
    codexSources(deps.platform, deps.home, deps.env),
    deps,
    parseCodexLogin
  );
  if (!found.ok)
    return {
      ok: false,
      reason: found.unreadable ? "Codex \u767B\u5F55\u6570\u636E\u8BFB\u4E0D\u51FA\uFF0C\u8FD0\u884C codex \u91CD\u65B0\u767B\u5F55" : "\u6CA1\u6709\u627E\u5230 Codex \u767B\u5F55\uFF0C\u8FD0\u884C codex \u7528 ChatGPT \u8D26\u53F7\u767B\u5F55"
    };
  const login = found.value;
  if (login.apiKeyOnly)
    return {
      ok: false,
      reason: "Codex \u53EA\u7528 API key \u767B\u5F55\uFF0C\u6CA1\u6709\u8BA2\u9605\u989D\u5EA6\uFF1B\u6539\u7528 ChatGPT \u8D26\u53F7\u767B\u5F55"
    };
  const now = deps.now();
  const expiry = jwtExpiry(login.accessToken);
  if (expiry !== void 0 && expiry <= now)
    return {
      ok: false,
      reason: `Codex \u767B\u5F55\u5DF2\u8FC7\u671F\uFF08${describeSource(found.source)}\uFF09\uFF0C\u8FD0\u884C\u4E00\u6B21 codex \u4F1A\u81EA\u52A8\u7EED\u671F`
    };
  const reply = await getJson(
    CODEX_USAGE_URL,
    {
      Authorization: `Bearer ${login.accessToken}`,
      Accept: "application/json",
      "User-Agent": "Atrium",
      ...login.accountId ? { "ChatGPT-Account-Id": login.accountId } : {}
    },
    deps
  );
  if (isFailure(reply))
    return { ok: false, reason: transportReason(reply, "Codex") };
  if (reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      reason: "Codex \u7528\u91CF\u63A5\u53E3\u62D2\u7EDD\u4E86\u767B\u5F55\uFF08\u4EE4\u724C\u5931\u6548\uFF09\uFF0C\u8FD0\u884C codex \u91CD\u65B0\u767B\u5F55"
    };
  if (reply.status < 200 || reply.status >= 300)
    return { ok: false, reason: `Codex \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE HTTP ${reply.status}` };
  const windows = mapCodexUsage(reply.body, reply.headers, now);
  if (!windows?.length)
    return { ok: false, reason: "Codex \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE\u7684\u7ED3\u6784\u8BA4\u4E0D\u51FA" };
  return {
    ok: true,
    plan: codexPlan(isObject(reply.body) ? reply.body.plan_type : void 0),
    windows,
    refreshedAt: now,
    account: login.account
  };
}
var codexReader = { provider: "codex", read: readCodex };

// server/quota-readers/opencode.ts
var OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
function parseOpencodeKey(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (!isObject(document)) return void 0;
  const entry = document["opencode-go"];
  const key = isObject(entry) && typeof entry.key === "string" ? entry.key : "";
  return key.trim() || null;
}
var WINDOWS2 = [
  ["rolling", "session", "Session", 5 * 60 * 60],
  ["weekly", "weekly", "Weekly", 7 * 24 * 60 * 60],
  ["monthly", "monthly", "Monthly", 0]
];
function mapOpencodeUsage(body) {
  const usage = isObject(body) && isObject(body.usage) ? body.usage : void 0;
  if (!usage) return void 0;
  const windows = [];
  for (const [key, id, label, periodSeconds] of WINDOWS2) {
    const value = usage[key];
    const percent = isObject(value) ? numberOf(value.percent) : void 0;
    if (!isObject(value) || percent === void 0) return void 0;
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAt: timeOf(value.resetsAt),
      periodSeconds
    });
  }
  return windows;
}
async function readOpencode(deps) {
  let noGoEntry = false;
  const found = await firstCredential(
    opencodeSources(deps.platform, deps.home, deps.env),
    deps,
    (text) => {
      const key = parseOpencodeKey(text);
      if (key === null) noGoEntry = true;
      return key ?? void 0;
    }
  );
  if (!found.ok)
    return {
      ok: false,
      reason: noGoEntry ? "OpenCode \u6CA1\u6709\u767B\u5F55 OpenCode Go" : found.unreadable ? "OpenCode \u767B\u5F55\u6570\u636E\u8BFB\u4E0D\u51FA\uFF0C\u91CD\u65B0\u767B\u5F55 OpenCode Go" : "\u6CA1\u6709\u627E\u5230 OpenCode \u767B\u5F55\uFF0C\u767B\u5F55 OpenCode Go"
    };
  const reply = await getJson(
    OPENCODE_USAGE_URL,
    {
      Authorization: `Bearer ${found.value}`,
      Accept: "application/json",
      "User-Agent": "Atrium"
    },
    deps
  );
  if (isFailure(reply))
    return { ok: false, reason: transportReason(reply, "OpenCode Go") };
  if (reply.status === 401)
    return {
      ok: false,
      reason: "OpenCode Go \u767B\u5F55\u5931\u6548\u6216\u8FC7\u671F\uFF0C\u91CD\u65B0\u767B\u5F55 OpenCode Go"
    };
  if (reply.status === 403) {
    const error = isObject(reply.body) && isObject(reply.body.error) ? reply.body.error : {};
    return {
      ok: false,
      reason: error.type === "EntitlementError" ? "\u6CA1\u6709 OpenCode Go \u8BA2\u9605" : "OpenCode Go \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE HTTP 403"
    };
  }
  if (reply.status < 200 || reply.status >= 300)
    return {
      ok: false,
      reason: `OpenCode Go \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE HTTP ${reply.status}`
    };
  const windows = mapOpencodeUsage(reply.body);
  if (!windows)
    return { ok: false, reason: "OpenCode Go \u7528\u91CF\u63A5\u53E3\u8FD4\u56DE\u7684\u7ED3\u6784\u8BA4\u4E0D\u51FA" };
  return {
    ok: true,
    plan: "Go",
    windows,
    refreshedAt: deps.now(),
    account: accountKey("opencode", found.value)
  };
}
var opencodeReader = {
  provider: "opencode",
  read: readOpencode
};

// server/quota-readers/index.ts
var READERS = [
  claudeReader,
  codexReader,
  opencodeReader
];
var OK_TTL_MS = 5 * 6e4;
var FAILED_TTL_MS = 6e4;
var LAST_GOOD_MS = 6 * 60 * 6e4;
var REQUEST_TIMEOUT_MS = 1e4;
var KEYCHAIN_TIMEOUT_MS = 5e3;
var SECURITY = "/usr/bin/security";
var ITEM_NOT_FOUND = 44;
function outcomeOf(result, lastGood, now) {
  if (result.ok) return { ok: true, result, note: null };
  if (lastGood && now - lastGood.refreshedAt < LAST_GOOD_MS)
    return {
      ok: true,
      result: lastGood,
      note: `\u672C\u6B21\u8BFB\u4E0D\u5230\uFF08${result.reason}\uFF09\uFF0C\u6CBF\u7528\u4E0A\u6B21\u8BFB\u6570`
    };
  return { ok: false, reason: result.reason };
}
function nextReadAt(result, now) {
  if (result.ok) return now + OK_TTL_MS;
  return Math.max(now + FAILED_TTL_MS, result.retryAt ?? 0);
}
var QuotaReaders = class {
  constructor(deps, readers = READERS) {
    this.deps = deps;
    this.readers = readers;
  }
  deps;
  readers;
  entries = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  /** 各账号的读取结论；缓存未到期不发请求。 */
  async read() {
    const entries = await Promise.all(
      this.readers.map(
        async (reader) => [reader.provider, await this.entry(reader)]
      )
    );
    const now = this.deps.now();
    return new Map(
      entries.map(([provider, entry]) => [
        provider,
        outcomeOf(entry.result, entry.lastGood, now)
      ])
    );
  }
  entry(reader) {
    const cached = this.entries.get(reader.provider);
    if (cached && this.deps.now() < cached.nextAt)
      return Promise.resolve(cached);
    const running = this.inflight.get(reader.provider);
    if (running) return running;
    const task = this.refresh(reader, cached).finally(
      () => this.inflight.delete(reader.provider)
    );
    this.inflight.set(reader.provider, task);
    return task;
  }
  async refresh(reader, cached) {
    let result;
    try {
      result = await reader.read(this.deps);
    } catch {
      result = { ok: false, reason: `\u8BFB\u53D6 ${reader.provider} \u989D\u5EA6\u65F6\u51FA\u9519` };
    }
    const now = this.deps.now();
    const entry = {
      result,
      lastGood: result.ok ? result : cached?.lastGood,
      nextAt: nextReadAt(result, now)
    };
    this.entries.set(reader.provider, entry);
    return entry;
  }
};
function currentPlatform() {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}
async function readTextFile(path) {
  try {
    return await readFile2(path, "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw error;
  }
}
function readKeychain(service, account, env = process.env) {
  if (process.platform !== "darwin") return Promise.resolve(void 0);
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  args.push("-w");
  return new Promise((resolve, reject) => {
    execFile(
      SECURITY,
      args,
      {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { PATH: env.PATH, HOME: env.HOME, USER: env.USER }
      },
      (error, stdout) => {
        if (!error) return resolve(stdout.trim() || void 0);
        if (error.code === ITEM_NOT_FOUND) return resolve(void 0);
        reject(new Error("\u94A5\u5319\u4E32\u8BFB\u53D6\u5931\u8D25"));
      }
    );
  });
}
function defaultReaderDeps(env = process.env) {
  return {
    platform: currentPlatform(),
    home: env.HOME || env.USERPROFILE || homedir2(),
    env,
    readFile: readTextFile,
    keychain: (service, account) => readKeychain(service, account, env),
    fetch: globalThis.fetch,
    now: Date.now,
    timeoutMs: REQUEST_TIMEOUT_MS
  };
}
function readersEnabled(env = process.env) {
  const flag = env.ATRIUM_QUOTA_READERS?.trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  return !env.NODE_TEST_CONTEXT;
}

// server/agent/check.ts
import { createHash as createHash3 } from "node:crypto";
import {
  appendFileSync as appendFileSync2,
  closeSync as closeSync3,
  existsSync as existsSync5,
  mkdirSync as mkdirSync4,
  openSync as openSync3,
  readFileSync as readFileSync2,
  rmSync,
  writeFileSync as writeFileSync5
} from "node:fs";
import { join as join4 } from "node:path";

// server/hosts/check-plan.ts
function checkTreeName(clone, slot) {
  return `${clone}-check-${slot}`;
}

// server/agent/launch.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync3, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname, join as join3 } from "node:path";

// server/tasks/workspace.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "node:fs";

// server/tasks/openquota.ts
var PACE_MAX_BUFFER = 1024 * 1024;

// server/quota-readers/pace.ts
var SHORT_WINDOW_MAX_PERIOD_SECONDS = 6 * 60 * 60;
var STALE_AFTER_MS = 10 * 6e4;

// server/tasks/quota-source.ts
var EXPECTED_PROVIDERS = [
  ...new Set(Object.values(ADAPTERS).map((adapter) => adapter.quotaProvider))
];

// server/tasks/quota-holds.ts
var DEFAULT_UNKNOWN_HOLD_MS = 60 * 60 * 1e3;

// server/skills/model.ts
import YAML from "yaml";
var LIMITS = {
  /** 一个技能最多几个文件（含 SKILL.md）。 */
  files: 32,
  /** 一个技能全部文件合计字节数。 */
  bytes: 256 * 1024,
  /** 一次派活最多挂几个技能。 */
  perTask: 8,
  /** 全库技能数（列表有界）。 */
  skills: 200,
  description: 1024,
  name: 100,
  /** 提议里执行者自述原因的字数。 */
  proposalReason: 2e3,
  /** 附属文件的目录深度。 */
  depth: 4
};

// server/tasks/prepare.ts
var DEFAULT_RULES = [
  "\u53EA\u5728\u7ED9\u5B9A\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u4EFB\u52A1 worktree\uFF09\u5185\u6539\u52A8\uFF0C\u4E0D\u8981\u5207\u6362\u5230\u5176\u4ED6\u5206\u652F\u6216\u76EE\u5F55\u5E72\u6D3B\u3002",
  "\u4E0D\u8981\u4F7F\u7528 git stash\uFF1B\u672A\u5B8C\u6210\u7684\u6539\u52A8\u63D0\u4EA4\u5230\u5F53\u524D\u5206\u652F\u3002",
  "\u505A\u5B8C\u540E\u4F9D\u6B21\uFF1A\u8FD0\u884C\u9879\u76EE\u68C0\u67E5\u3001\u63D0\u4EA4\u3001\u63A8\u9001\u3001\u5F00 PR\uFF08\u6B63\u6587\u5199 Refs \u5BF9\u5E94 issue\uFF09\uFF1B\u4EFB\u4F55\u4E00\u6B65\u505A\u4E0D\u4E86\uFF0C\u5199\u6E05\u695A\u5361\u5728\u54EA\u4E00\u6B65\u518D\u7ED3\u675F\u3002\u8FD0\u884C\u65F6\u4F1A\u5728\u4EFB\u52A1 worktree \u518D\u8DD1\u672C\u5730\u68C0\u67E5\u3002",
  "\u6C47\u62A5\u91CC\u7684 PR \u53F7\u3001\u63D0\u4EA4\u53F7\u3001CI \u7ED3\u679C\u5FC5\u987B\u6765\u81EA\u4F60\u521A\u6267\u884C\u8FC7\u7684\u547D\u4EE4\u8F93\u51FA\uFF1B\u6CA1\u505A\u7684\u6B65\u9AA4\u76F4\u63A5\u5199\u300C\u6CA1\u505A\u300D\u3002",
  "\u6587\u6863\u3001\u63D0\u4EA4\u8BF4\u660E\u548C PR \u4F7F\u7528\u4E2D\u6587\u3002",
  "PR \u6B63\u6587\u5199\u300C## \u7AEF\u5230\u7AEF\u9A8C\u8BC1\u300D\u4E00\u8282\uFF1A\u4E00\u4E24\u6761\u7528\u6237\u4E0A\u7EBF\u540E\u4F1A\u5B9E\u9645\u8FD0\u884C\u7684\u547D\u4EE4\u4E0E\u671F\u671B\u7ED3\u679C\uFF1B\u4E0A\u7EBF\u901A\u77E5\u4F1A\u539F\u6837\u9644\u4E0A\uFF0C\u8D1F\u8D23\u4EBA\u7167\u7740\u5728\u7EBF\u4E0A\u9A8C\u8BC1\u3002",
  "\u6BCF\u505A\u4E00\u6BB5\u8F83\u957F\u7684\u5DE5\u4F5C\u524D\uFF0C\u5148\u7528\u4E00\u53E5\u4E2D\u6587\u8BF4\u660E\u6B63\u5728\u505A\u4EC0\u4E48\uFF08\u5982\u300C\u6B63\u5728\u8865\u5355\u6D4B\u300D\uFF09\uFF0C\u770B\u677F\u4F1A\u628A\u8FD9\u53E5\u663E\u793A\u4E3A\u4F60\u7684\u6700\u8FD1\u52A8\u4F5C\u3002",
  "gh \u547D\u4EE4\u4E00\u5F8B\u5E26 `-R <owner/repo>`\uFF08\u53D6\u81EA origin \u8FDC\u7AEF\uFF09\uFF1Afork \u4ED3\u5E93\u53E6\u6709 upstream \u65F6\uFF0C\u4E0D\u5E26 -R \u4F1A\u67E5\u5230\u6216\u5F00\u5230\u4E0A\u6E38\uFF1BPR \u5F00\u5728 origin \u4E0A\u3002"
];

// server/tasks/workspace.ts
var RUN_RULES = [
  ...DEFAULT_RULES,
  "\u505C\u5728 PR\uFF1A\u4E0D\u8981\u5408\u5165\u3001\u4E0D\u8981\u6539\u9ED8\u8BA4\u5206\u652F\u3001\u4E0D\u8981\u53D1\u7248\u3002",
  "\u4E0D\u8981\u542F\u52A8\u3001\u505C\u6B62\u6216\u66F4\u65B0 4310 \u7AEF\u53E3\u4E0A\u7684 Atrium \u670D\u52A1\uFF0C\u4E5F\u4E0D\u8981\u6267\u884C\u6CA1\u6709\u9694\u79BB ATRIUM_PORT / ATRIUM_DATA \u7684 atrium \u547D\u4EE4\u3002"
];
function buildLaunch(adapter, input, resume) {
  if (!resume) return adapter.build(input);
  if (!adapter.resume)
    throw new Problem(400, `${adapter.tool} \u4E0D\u652F\u6301\u7EED\u4E0A\u4F1A\u8BDD`, "usage");
  writeFileSync3(resume.file, resume.text, { mode: 384 });
  return adapter.resume({
    ...input,
    promptFile: resume.file,
    prompt: resume.text,
    session: resume.session
  });
}

// server/agent/launch.ts
async function ensureClone(url, clone, run) {
  if (existsSync4(join3(clone, ".git")) || existsSync4(join3(clone, "HEAD")))
    return;
  mkdirSync3(dirname(clone), { recursive: true, mode: 448 });
  const cloned = await run("git", ["clone", "--quiet", url, clone], {
    timeoutMs: 10 * 6e4
  });
  if (!cloned.ok)
    throw new Error(
      `\u514B\u9686 ${url} \u5931\u8D25\uFF1A${firstLine(cloned.stderr) || "git \u5931\u8D25"}`
    );
}
async function launchAssignment(assignment, ctx) {
  const adapter = ADAPTERS[assignment.tool];
  mkdirSync3(assignment.dir, { recursive: true, mode: 448 });
  if (assignment.repo) {
    const { url, clone, worktree, branch, base } = assignment.repo;
    await ensureClone(url, clone, ctx.run);
    await ensureWorktree(
      clone,
      { path: worktree, branch, slug: "" },
      base,
      ctx.run
    );
  } else mkdirSync3(assignment.cwd, { recursive: true });
  const promptFile = join3(assignment.dir, "prompt.md");
  writeFileSync4(promptFile, assignment.prompt, { mode: 384 });
  const resultFile = join3(assignment.dir, "last-message.md");
  const launch = buildLaunch(
    adapter,
    {
      promptFile,
      prompt: assignment.prompt,
      cwd: assignment.cwd,
      model: assignment.model,
      effort: assignment.effort,
      resultFile,
      live: false
    },
    assignment.resume ? { ...assignment.resume, file: join3(assignment.dir, "tell.md") } : void 0
  );
  const logFile = join3(assignment.dir, "log");
  const append = !!assignment.resume;
  const offset = append && existsSync4(logFile) ? statSync2(logFile).size : 0;
  const { child } = await spawnWorker(
    { launch, logFile, worker: { id: assignment.worker } },
    workerEnvironment(ctx.env),
    assignment.ref,
    append
  );
  return {
    child,
    pid: child.pid,
    offset,
    logFile,
    resultFile,
    launch: {
      command: launch.command,
      args: launch.args.map(
        (arg) => arg.length > 200 ? `${arg.slice(0, 197)}\u2026` : arg
      ),
      cwd: launch.cwd,
      ...launch.input ? { input: launch.input } : {}
    }
  };
}

// server/agent/check.ts
var INSTALL_TIMEOUT_MS = 10 * 6e4;
var UNLIMITED = new LocalCheckQueue(1e6);
async function checkCommit(input) {
  const { source, dir, run } = input;
  const log = join4(dir, "local-check.log");
  mkdirSync4(dir, { recursive: true, mode: 448 });
  writeFileSync5(log, "", { mode: 384 });
  const note = (line) => appendFileSync2(log, `[atrium] ${line}
`, { mode: 384 });
  const infra = (why) => {
    note(why);
    return {
      status: "error",
      command: "",
      log,
      detail: why,
      failedTests: [],
      commit: source.commit,
      infra: why
    };
  };
  const git = (args, timeoutMs = 5 * 6e4) => run("git", args, { timeoutMs });
  const ref2 = `refs/atrium/checks/${input.id.replace(/[^A-Za-z0-9-]/g, "")}`;
  note(`\u53D6\u63D0\u4EA4 ${source.commit.slice(0, 12)}`);
  const fetched = await input.withClone(source.clone, async () => {
    try {
      await ensureClone(source.url, source.clone, run);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const base = await git([
      "-C",
      source.clone,
      "fetch",
      "--quiet",
      "origin",
      source.base
    ]);
    if (source.bundle) {
      const file = join4(dir, "source.bundle");
      writeFileSync5(file, Buffer.from(source.bundle, "base64"), {
        mode: 384
      });
      const unbundled = await git([
        "-C",
        source.clone,
        "fetch",
        "--quiet",
        file,
        `+HEAD:${ref2}`
      ]);
      rmSync(file, { force: true });
      if (!unbundled.ok)
        return `\u88C5\u4E0D\u4E0A\u670D\u52A1\u5E26\u6765\u7684\u63D0\u4EA4\uFF1A${firstLine(unbundled.stderr) || "git fetch \u5931\u8D25"}${base.ok ? "" : `\uFF08fetch ${source.base} \u4E5F\u5931\u8D25\uFF1A${firstLine(base.stderr)}\uFF09`}`;
    }
    const found = await git([
      "-C",
      source.clone,
      "cat-file",
      "-e",
      `${source.commit}^{commit}`
    ]);
    if (!found.ok)
      return `\u8FD9\u53F0\u53D6\u4E0D\u5230\u63D0\u4EA4 ${source.commit.slice(0, 12)}${base.ok ? "" : `\uFF1Afetch ${source.base} \u5931\u8D25\uFF08${firstLine(base.stderr)}\uFF09`}`;
    return null;
  });
  if (fetched) return infra(fetched);
  if (input.signal.aborted) return infra("\u670D\u52A1\u4E0D\u518D\u7B49\u8FD9\u6B21\u68C0\u67E5");
  const slot = input.slot(source.clone);
  const tree = checkTreeName(source.clone, slot.index);
  try {
    const placed = await input.withClone(
      source.clone,
      () => placeTree(source.clone, tree, source.commit, git)
    );
    if (placed) return infra(placed);
    if (input.signal.aborted) return infra("\u670D\u52A1\u4E0D\u518D\u7B49\u8FD9\u6B21\u68C0\u67E5");
    const installed = await installDeps(tree, log, input.env, input.signal);
    if (installed) return infra(installed);
    note(`\u5728 ${tree} \u8DD1\u68C0\u67E5`);
    const result = await runLocalCheck({
      worktree: tree,
      taskDir: dir,
      env: input.env,
      urgent: input.urgent,
      queue: UNLIMITED,
      signal: input.signal,
      append: true
    });
    return { ...result, commit: source.commit };
  } finally {
    slot.release();
    if (source.bundle)
      await git(["-C", source.clone, "update-ref", "-d", ref2]).catch(
        () => void 0
      );
  }
}
async function placeTree(clone, tree, commit, git) {
  if (existsSync5(join4(tree, ".git"))) {
    const moved = await git([
      "-C",
      tree,
      "checkout",
      "--quiet",
      "--detach",
      "--force",
      commit
    ]);
    if (moved.ok) {
      const cleaned = await git([
        "-C",
        tree,
        "clean",
        "-ffdxq",
        "-e",
        "node_modules"
      ]);
      if (cleaned.ok) return null;
    }
  }
  rmSync(tree, { recursive: true, force: true, maxRetries: 5 });
  await git(["-C", clone, "worktree", "prune"]);
  const added = await git([
    "-C",
    clone,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    "--force",
    tree,
    commit
  ]);
  return added.ok ? null : `\u5EFA\u68C0\u67E5\u5DE5\u4F5C\u6811\u5931\u8D25\uFF1A${firstLine(added.stderr) || "git worktree add \u5931\u8D25"}`;
}
async function installDeps(tree, log, env, signal) {
  const lock = join4(tree, "package-lock.json");
  if (!existsSync5(lock) || !existsSync5(join4(tree, "package.json"))) return null;
  const hash = createHash3("sha256").update(readFileSync2(lock)).digest("hex");
  const stamp = join4(tree, "node_modules", ".atrium-lock");
  try {
    if (readFileSync2(stamp, "utf8").trim() === hash) return null;
  } catch {
  }
  appendFileSync2(log, "[atrium] \u88C5\u4F9D\u8D56\uFF1Anpm ci\n");
  const fd = openSync3(log, "a", 384);
  let child;
  try {
    child = spawnShell("npm ci --no-audit --no-fund", {
      cwd: tree,
      env: workerEnvironment(env),
      detached: true,
      stdio: ["ignore", fd, fd]
    });
  } catch (error) {
    return `\u88C5\u4F9D\u8D56\u5931\u8D25\uFF1A${String(error)}`;
  } finally {
    closeSync3(fd);
  }
  const kill = () => {
    if (child.pid) killTree(child.pid, "SIGKILL");
  };
  signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, INSTALL_TIMEOUT_MS);
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (value) => resolve(value));
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", kill);
  if (code !== 0) return `\u88C5\u4F9D\u8D56\u5931\u8D25\uFF08npm ci \u9000\u51FA\u7801 ${code ?? "\u672A\u77E5"}\uFF09`;
  writeFileSync5(stamp, `${hash}
`);
  return null;
}

// server/agent/plan.ts
var GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "remote",
  "diff",
  "status",
  "rev-list",
  "rev-parse",
  "ls-remote",
  "cat-file",
  "worktree",
  "branch",
  "symbolic-ref",
  "show-ref",
  "log"
]);
function gitRefusal(args, os, dataDir) {
  if (!args.every((arg) => typeof arg === "string")) return "git \u53C2\u6570\u5E94\u4E3A\u6587\u672C";
  const list = args;
  let index = 0;
  while (index < list.length) {
    const arg = list[index];
    if (arg === "--no-optional-locks") {
      index++;
      continue;
    }
    if (arg === "-C") {
      const path = list[index + 1];
      if (!path || !(insideData(os, dataDir, path) || same(os, dataDir, path)))
        return "git -C \u7684\u8DEF\u5F84\u4E0D\u5728\u4EE3\u7406\u6570\u636E\u76EE\u5F55\u91CC";
      index += 2;
      continue;
    }
    break;
  }
  const sub = list[index];
  if (!sub || !GIT_SUBCOMMANDS.has(sub))
    return `\u4E0D\u63A5\u53D7 git ${sub ?? ""}`.trim();
  if (list.some(
    (arg) => arg === "-c" || arg.startsWith("--exec-path") || arg.startsWith("--upload-pack") || arg.startsWith("--config")
  ))
    return "\u4E0D\u63A5\u53D7\u6539 git \u914D\u7F6E\u6216\u5916\u90E8\u547D\u4EE4\u7684\u53C2\u6570";
  return null;
}
var same = (os, a, b) => (os === "win32" ? a.toLowerCase() : a) === (os === "win32" ? b.toLowerCase() : b);
function assignmentRefusal(a, os, dataDir) {
  if (!Number.isSafeInteger(a.task) || a.task < 1) return "\u4EFB\u52A1\u53F7\u4E0D\u5408\u6CD5";
  if (!Number.isSafeInteger(a.run) || a.run < 1) return "\u8F6E\u53F7\u4E0D\u5408\u6CD5";
  if (!isKnownTool(a.tool)) return `\u4E0D\u8BA4\u8BC6\u7684\u6267\u884C\u8005\u5DE5\u5177\uFF1A${String(a.tool)}`;
  if (typeof a.prompt !== "string" || !a.prompt.trim()) return "\u63D0\u793A\u8BCD\u4E3A\u7A7A";
  const paths = [a.dir, a.cwd, a.repo?.clone, a.repo?.worktree].filter(
    (path) => path !== void 0
  );
  if (paths.some(
    (path) => typeof path !== "string" || !insideData(os, dataDir, path)
  ))
    return "\u6D3E\u6765\u7684\u8DEF\u5F84\u4E0D\u5728\u4EE3\u7406\u6570\u636E\u76EE\u5F55\u91CC";
  if (a.repo) {
    if (!a.repo.url || /^-/.test(a.repo.url) || /[\s]/.test(a.repo.url))
      return "\u4ED3\u5E93\u5730\u5740\u4E0D\u5408\u6CD5";
    if (!/^[A-Za-z0-9._/-]+$/.test(a.repo.branch) || a.repo.branch.startsWith("-"))
      return "\u5206\u652F\u540D\u4E0D\u5408\u6CD5";
    if (!/^[A-Za-z0-9._/-]+$/.test(a.repo.base) || a.repo.base.startsWith("-"))
      return "\u57FA\u7840\u5206\u652F\u540D\u4E0D\u5408\u6CD5";
  }
  return null;
}
var REF_NAME = /^[A-Za-z0-9._/-]+$/;
function sourceRefusal(source, os, dataDir) {
  if (typeof source !== "object" || source === null) return "\u68C0\u67E5\u6765\u6E90\u4E0D\u5408\u6CD5";
  if (typeof source.clone !== "string" || !insideData(os, dataDir, source.clone))
    return "\u68C0\u67E5\u7684\u514B\u9686\u4E0D\u5728\u4EE3\u7406\u6570\u636E\u76EE\u5F55\u91CC";
  if (typeof source.url !== "string" || !source.url || /^-/.test(source.url) || /\s/.test(source.url))
    return "\u4ED3\u5E93\u5730\u5740\u4E0D\u5408\u6CD5";
  if (typeof source.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(source.commit))
    return "\u63D0\u4EA4\u53F7\u4E0D\u5408\u6CD5";
  if (typeof source.base !== "string" || !REF_NAME.test(source.base) || source.base.startsWith("-"))
    return "\u57FA\u7840\u5206\u652F\u540D\u4E0D\u5408\u6CD5";
  if (source.bundle !== void 0 && (typeof source.bundle !== "string" || source.bundle.length > Math.ceil(MAX_BUNDLE_BYTES / 3) * 4))
    return "\u63D0\u4EA4\u5305\u592A\u5927\u6216\u4E0D\u5408\u6CD5";
  return null;
}
function commandRefusal(command, os, dataDir) {
  switch (command.kind) {
    case "launch":
      return assignmentRefusal(command.assignment, os, dataDir);
    case "exec":
      return gitRefusal(command.args, os, dataDir);
    case "check":
      if (command.worktree === void 0 === (command.source === void 0))
        return "\u68C0\u67E5\u8981\u4E48\u7ED9\u5DE5\u4F5C\u6811\u3001\u8981\u4E48\u7ED9\u63D0\u4EA4";
      if (command.source) return sourceRefusal(command.source, os, dataDir);
      return typeof command.worktree === "string" && insideData(os, dataDir, command.worktree) ? null : "\u68C0\u67E5\u7684\u5DE5\u4F5C\u6811\u4E0D\u5728\u4EE3\u7406\u6570\u636E\u76EE\u5F55\u91CC";
    case "stop":
      return command.signal === "SIGTERM" || command.signal === "SIGKILL" ? null : "\u4E0D\u8BA4\u8BC6\u7684\u4FE1\u53F7";
    default:
      return "\u4E0D\u8BA4\u8BC6\u7684\u6307\u4EE4";
  }
}
function nextChunk(uploaded, size, max) {
  if (uploaded >= size) return null;
  return { offset: uploaded, length: Math.min(max, size - uploaded) };
}

// server/agent/main.ts
var AgentHttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
function normalizeServer(value) {
  const text = value.trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Problem(
      400,
      `--server \u5E94\u4E3A\u670D\u52A1\u5730\u5740\uFF0C\u5982 http://127.0.0.1:4310\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search)
    throw new Problem(
      400,
      `--server \u5E94\u4E3A http(s)://\u4E3B\u673A[:\u7AEF\u53E3]\uFF0C\u4E0D\u5E26\u8DEF\u5F84\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  return `${url.protocol}//${url.host}`;
}
var sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true }
  );
});
var Agent = class {
  constructor(options) {
    this.options = options;
    this.server = normalizeServer(options.server);
    this.state = new AgentState(options.data);
    this.config = this.state.config();
    this.exec = options.exec ?? exec;
    const limits = hostLimits(options.env, availableParallelism3()).limits;
    this.checks = new LocalCheckQueue(limits.maxChecks);
    this.quota = options.quota !== void 0 ? options.quota : readersEnabled(options.env) && readersEnabled(process.env) ? new QuotaReaders(defaultReaderDeps(options.env)) : null;
  }
  options;
  state;
  config;
  runs = /* @__PURE__ */ new Map();
  /** 正在做（含回执还没送到）的指令：长轮询时告诉服务别重发。 */
  busy = /* @__PURE__ */ new Set();
  abort = new AbortController();
  checks;
  checkTracks = /* @__PURE__ */ new Map();
  checkAborts = /* @__PURE__ */ new Map();
  /** 服务已叫停、还在收尾的检查：不再报「手上在做」，免得服务一轮轮重复叫停。 */
  cancelled = /* @__PURE__ */ new Set();
  cloneLocks = /* @__PURE__ */ new Map();
  slots = /* @__PURE__ */ new Map();
  quota;
  quotaTimer;
  exec;
  server;
  timer;
  ticking = false;
  connected = false;
  stopped = false;
  /** 因为什么停下（令牌失效等）；正常停止为 null。 */
  failure = null;
  log(line) {
    (this.options.log ?? ((text) => console.log(text)))(
      `[${(/* @__PURE__ */ new Date()).toTimeString().slice(0, 8)}] ${line}`
    );
  }
  get token() {
    return this.config?.server === this.server ? this.config.token : null;
  }
  async call(path, body, timeoutMs) {
    const token = path === "join" ? this.options.code : this.token;
    const response = await (this.options.fetch ?? fetch)(
      `${this.server}/api/agent/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...token ? { authorization: `Bearer ${token}` } : {}
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(timeoutMs)
        ])
      }
    );
    const text = await response.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    if (!response.ok)
      throw new AgentHttpError(
        response.status,
        data.error ?? `HTTP ${response.status}`
      );
    return data;
  }
  info() {
    return machineInfo({
      dataDir: this.options.data,
      version: this.options.version,
      env: this.options.env
    });
  }
  load() {
    const running = [...this.runs.values()].filter(
      (track) => track.record.exit === void 0
    ).length;
    const load = loadavg()[0] ?? 0;
    const gate = hostGate({
      running,
      load,
      limits: hostLimits(this.options.env, availableParallelism3()).limits
    });
    return {
      load: Math.round(load * 100) / 100,
      running,
      // 只报太忙；满了由服务按上限自己算。
      busy: !gate.ok && gate.busy ? gate.reason.replace(/^本机/, "\u8FD9\u53F0") : null
    };
  }
  /** 接入：用接入码换令牌，存进代理数据目录。 */
  async join() {
    let joined;
    try {
      joined = await this.call(
        "join",
        { info: this.info() },
        3e4
      );
    } catch (error) {
      throw new Problem(
        error instanceof AgentHttpError && error.status < 500 ? error.status : 503,
        `\u63A5\u5165 ${this.server} \u5931\u8D25\uFF1A${reason(error)}`,
        error instanceof AgentHttpError && error.status === 401 ? "auth_required" : "service_unavailable"
      );
    }
    this.config = {
      server: this.server,
      host: joined.host,
      token: joined.token
    };
    this.state.saveConfig(this.config);
    this.log(`\u5DF2\u63A5\u5165 ${this.server}\uFF0C\u8FD9\u53F0\u662F ${joined.host}`);
  }
  /** 上次代理留下的运行：进程还在的接着看，已不在的按退出情况不明补报。 */
  async recover() {
    for (const record of this.state.runs(
      (file) => this.log(`\u8FD0\u884C\u8BB0\u5F55 ${file} \u5199\u574F\u4E86\uFF0C\u5DF2\u632A\u5F00`)
    )) {
      if (record.exit === void 0) {
        const alive = isTool(record.tool) && processAlive(record.pid) && await ownsPid(record.pid, record.tool, this.exec);
        if (!alive) {
          record.exit = null;
          this.state.saveRun(record);
        }
      }
      this.runs.set(record.task, { record, confirmed: true });
      this.log(
        record.exit === void 0 ? `\u63A5\u7740\u770B ${record.ref}\uFF08PID ${record.pid}\uFF09` : `${record.ref} \u5DF2\u5728\u4EE3\u7406\u505C\u7740\u65F6\u7ED3\u675F\uFF0C\u7ED3\u679C\u5F85\u4E0A\u62A5`
      );
    }
  }
  /** 跑到 stop() 或令牌失效为止。 */
  async start() {
    if (this.options.code && (!this.token || !this.config?.host || !this.options.code.startsWith(`${this.config.host}-`)))
      await this.join();
    if (!this.token)
      throw new Problem(
        400,
        `\u8FD9\u53F0\u673A\u5668\u8FD8\u6CA1\u63A5\u5165 ${this.server}\uFF1A\u5728\u670D\u52A1\u90A3\u53F0\u673A\u5668\u4E0A\u8FD0\u884C atrium host add \u540D\u79F0\uFF0C\u62FF\u5230\u63A5\u5165\u7801\u540E atrium agent --server ${this.server} --token \u63A5\u5165\u7801`,
        "usage"
      );
    await this.recover();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.tickMs ?? 1e3
    );
    this.timer.unref?.();
    if (this.quota) {
      this.quotaTimer = setInterval(
        () => void this.reportQuota(),
        this.options.quotaMs ?? OK_TTL_MS
      );
      this.quotaTimer.unref?.();
    }
    try {
      await this.loop();
    } finally {
      clearInterval(this.timer);
      clearInterval(this.quotaTimer);
    }
  }
  /** 读这台登录的 CLI 额度并上报：只有额度数字与账号指纹，凭据不出这台。 */
  async reportQuota() {
    if (!this.quota || !this.connected || this.stopped) return;
    try {
      const outcomes = await this.quota.read();
      await this.call(
        "quota",
        {
          readings: [...outcomes].map(([provider, outcome]) => ({
            provider,
            outcome
          }))
        },
        3e4
      );
    } catch {
    }
  }
  stop() {
    this.stopped = true;
    this.abort.abort();
  }
  runSummary() {
    return [...this.runs.values()].map((track) => ({
      task: track.record.task,
      run: track.record.run,
      state: track.record.exit === void 0 ? "running" : "exited"
    }));
  }
  async loop() {
    let attempt = 0;
    while (!this.stopped) {
      try {
        const hello = await this.call("hello", { info: this.info(), runs: this.runSummary() }, 3e4);
        for (const orphan of hello.stop) {
          this.log(`\u670D\u52A1\u5DF2\u4E0D\u8BA4 t${orphan.task} \u7684\u8FD9\u4E00\u8F6E\uFF0C\u7ED3\u675F\u5B83`);
          this.stopRun(orphan.task, orphan.run, "SIGTERM");
          setTimeout(
            () => this.stopRun(orphan.task, orphan.run, "SIGKILL"),
            1e4
          ).unref();
        }
        this.log(
          attempt || this.connected === false ? `\u5DF2\u8FDE\u4E0A ${this.server}\uFF08${hello.host} ${hello.name}\uFF09` : `\u5DF2\u8FDE\u4E0A ${this.server}`
        );
        this.connected = true;
        attempt = 0;
        void this.tick();
        void this.reportQuota();
        while (!this.stopped) {
          const { commands, cancel } = await this.call(
            "poll",
            {
              load: this.load(),
              busy: [...this.busy].filter((id) => !this.cancelled.has(id))
            },
            POLL_WAIT_MS + 2e4
          );
          for (const id of cancel ?? []) {
            const abort = this.checkAborts.get(id);
            if (!abort || abort.signal.aborted) continue;
            this.cancelled.add(id);
            this.log("\u670D\u52A1\u5DF2\u4E0D\u518D\u7B49\u4E00\u6B21\u68C0\u67E5\uFF0C\u505C\u4E0B\u5B83");
            const track = this.checkTracks.get(id);
            if (track) track.abandoned = true;
            abort.abort();
          }
          for (const command of commands) {
            if (this.busy.has(command.id)) continue;
            this.busy.add(command.id);
            void this.handle(command);
          }
        }
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof AgentHttpError && error.status === 401) {
          this.failure = `\u670D\u52A1\u4E0D\u8BA4\u8FD9\u53F0\u4E3B\u673A\u7684\u4EE4\u724C\uFF08${error.message}\uFF09`;
          this.log(this.failure);
          this.stop();
          break;
        }
        const wait = backoffMs(attempt++);
        this.log(
          `${this.connected ? "\u4E0E\u670D\u52A1\u65AD\u5F00" : "\u8FDE\u4E0D\u4E0A\u670D\u52A1"}\uFF1A${reason(error)}\uFF1B${Math.round(wait / 1e3)} \u79D2\u540E\u91CD\u8FDE`
        );
        this.connected = false;
        await sleep(wait, this.abort.signal);
      }
    }
  }
  // ---- 指令 ----
  refused(command, why) {
    switch (command.kind) {
      case "launch":
        return { ok: false, error: why };
      case "exec":
        return { ok: false, stdout: "", stderr: why };
      case "check":
        return {
          status: "error",
          command: "",
          log: "",
          detail: why,
          failedTests: [],
          infra: why
        };
      default:
        return { ok: false, error: why };
    }
  }
  async handle(command) {
    try {
      const refusal = commandRefusal(
        command,
        process.platform,
        this.options.data
      );
      let result;
      if (refusal) {
        this.log(`\u62D2\u7EDD\u670D\u52A1\u6D3E\u6765\u7684\u6307\u4EE4\uFF08${command.kind}\uFF09\uFF1A${refusal}`);
        result = this.refused(command, refusal);
      } else
        switch (command.kind) {
          case "launch":
            result = await this.launch(command.assignment);
            break;
          case "stop":
            result = this.stopRun(command.task, command.run, command.signal);
            break;
          case "exec":
            result = await this.exec("git", command.args, {
              timeoutMs: command.timeoutMs
            });
            break;
          case "check":
            result = await this.check(command);
            break;
        }
      await this.reply(command, result);
    } catch (error) {
      await this.reply(command, this.refused(command, reason(error))).catch(
        () => void 0
      );
    } finally {
      this.busy.delete(command.id);
      if (command.kind === "check") this.endCheck(command.id);
    }
  }
  checkDir(id) {
    return join5(this.options.data, "checks", id.replace(/[^A-Za-z0-9-]/g, ""));
  }
  /**
   * 跑一次检查：远程任务在它的工作树里跑，按提交派来的在检查工作树里跑（check.ts）。
   * 日志边跑边续传，结束时先补齐再回执（服务收全了才落定结果）。
   */
  async check(command) {
    const dir = this.checkDir(command.id);
    mkdirSync5(dir, { recursive: true, mode: 448 });
    const track = {
      id: command.id,
      file: join5(dir, "local-check.log"),
      uploaded: 0
    };
    const abort = new AbortController();
    this.checkTracks.set(command.id, track);
    this.checkAborts.set(command.id, abort);
    const task = `t${command.task}`;
    this.log(
      command.source ? `\u9886\u5230 ${task} \u7684\u68C0\u67E5\uFF08\u63D0\u4EA4 ${command.source.commit.slice(0, 12)}\uFF09` : `\u9886\u5230 ${task} \u7684\u68C0\u67E5`
    );
    const source = command.source;
    const result = source ? await this.checks.run(
      () => checkCommit({
        id: command.id,
        source,
        urgent: command.urgent,
        dir,
        env: this.options.env,
        run: this.exec,
        signal: abort.signal,
        withClone: (clone, work) => this.withClone(clone, work),
        slot: (clone) => this.slot(clone)
      }),
      void 0,
      command.urgent
    ) : await runLocalCheck({
      worktree: command.worktree ?? "",
      taskDir: dir,
      env: this.options.env,
      urgent: command.urgent,
      queue: this.checks,
      signal: abort.signal
    });
    this.log(`${task} \u7684\u68C0\u67E5\u7ED3\u675F\uFF1A${result.status}\uFF08${result.detail}\uFF09`);
    await this.flushCheck(track);
    return { ...result, size: this.size(track.file) };
  }
  endCheck(id) {
    this.cancelled.delete(id);
    this.checkTracks.delete(id);
    this.checkAborts.delete(id);
    rmSync2(this.checkDir(id), {
      recursive: true,
      force: true,
      maxRetries: 5
    });
  }
  /** 同一克隆上的 git 操作排成一串。 */
  withClone(clone, work) {
    const previous = this.cloneLocks.get(clone) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => void 0);
    this.cloneLocks.set(clone, settled);
    void settled.then(() => {
      if (this.cloneLocks.get(clone) === settled) this.cloneLocks.delete(clone);
    });
    return next;
  }
  slot(clone) {
    const used = this.slots.get(clone) ?? /* @__PURE__ */ new Set();
    this.slots.set(clone, used);
    let index = 0;
    while (used.has(index)) index++;
    used.add(index);
    return {
      index,
      release: () => {
        used.delete(index);
        if (!used.size) this.slots.delete(clone);
      }
    };
  }
  /** 把检查日志传到服务：一趟最多 16 段；服务说不再等了就停。 */
  uploadCheck(track) {
    if (track.uploading) return track.uploading;
    const work = (async () => {
      for (let round = 0; round < 16 && !track.abandoned; round++) {
        const chunk = nextChunk(
          track.uploaded,
          this.size(track.file),
          LOG_CHUNK
        );
        if (!chunk) return;
        const data = this.readChunk(track.file, chunk);
        const answer = await this.call(
          "check-log",
          { id: track.id, offset: chunk.offset, data: data.toString("base64") },
          3e4
        );
        if (answer.done) {
          track.abandoned = true;
          return;
        }
        if (answer.offset === void 0) return;
        track.uploaded = answer.offset;
      }
    })().finally(() => {
      track.uploading = void 0;
    });
    track.uploading = work;
    return work;
  }
  /** 检查结束后把日志传完（断线时隔几秒重试，连上后补齐）。 */
  async flushCheck(track) {
    for (let attempt = 0; !this.stopped && !track.abandoned; attempt++) {
      try {
        await this.uploadCheck(track);
        if (track.uploaded >= this.size(track.file)) return;
        attempt = 0;
      } catch {
        await sleep(Math.min(5e3, 1e3 * (attempt + 1)), this.abort.signal);
      }
    }
  }
  readChunk(file, chunk) {
    const buffer = Buffer.alloc(chunk.length);
    const fd = openSync4(file, "r");
    let read = 0;
    try {
      read = readSync2(fd, buffer, 0, chunk.length, chunk.offset);
    } finally {
      closeSync4(fd);
    }
    return buffer.subarray(0, read);
  }
  /** 回执送到为止（断线时隔几秒重试）；服务说对不上的拉起，结束刚起的进程。 */
  async reply(command, result) {
    const confirm = () => {
      if (command.kind !== "launch") return;
      const track = this.runs.get(command.assignment.task);
      if (track?.record.run === command.assignment.run) {
        track.confirmed = true;
        void this.tick();
      }
    };
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const answer = await this.call("reply", { id: command.id, result }, 3e4);
        if (command.kind === "check" && answer.ok === false && typeof answer.offset === "number") {
          const track = this.checkTracks.get(command.id);
          if (track) {
            track.uploaded = answer.offset;
            await this.flushCheck(track);
            continue;
          }
        }
        confirm();
        if (answer.cancel && command.kind === "launch" && result.ok) {
          this.log(
            `${command.assignment.ref} \u7684\u62C9\u8D77\u670D\u52A1\u5DF2\u4E0D\u518D\u7B49\uFF0C\u7ED3\u675F\u521A\u8D77\u7684\u8FDB\u7A0B`
          );
          this.stopRun(
            command.assignment.task,
            command.assignment.run,
            "SIGKILL"
          );
        }
        return;
      } catch (error) {
        if (error instanceof AgentHttpError && error.status < 500) {
          confirm();
          return;
        }
        await sleep(Math.min(5e3, 1e3 * (attempt + 1)), this.abort.signal);
      }
    }
  }
  async launch(assignment) {
    const old = this.runs.get(assignment.task);
    if (old && old.record.exit === void 0 && old.record.run !== assignment.run) {
      killTree(old.record.pid, "SIGKILL");
    }
    try {
      const launched = await launchAssignment(assignment, {
        env: this.options.env,
        run: this.exec
      });
      const record = {
        task: assignment.task,
        run: assignment.run,
        ref: assignment.ref,
        tool: assignment.tool,
        executable: ADAPTERS[assignment.tool].executable,
        pid: launched.pid,
        logFile: launched.logFile,
        resultFile: launched.resultFile,
        startedAt: Date.now(),
        uploaded: launched.offset
      };
      this.state.saveRun(record);
      const track = {
        record,
        child: launched.child,
        confirmed: false
      };
      this.runs.set(assignment.task, track);
      launched.child.once("exit", (code, signal) => {
        if (this.stopped || track.record.exit !== void 0) return;
        track.record.exit = { code, signal };
        this.state.saveRun(track.record);
        this.log(
          `${record.ref} \u5DF2\u9000\u51FA\uFF08${signal ? `\u4FE1\u53F7 ${signal}` : `\u9000\u51FA\u7801 ${code}`}\uFF09`
        );
        void this.tick();
      });
      this.log(
        `\u9886\u5230 ${assignment.ref}\uFF08${assignment.worker}\uFF09\uFF0CPID ${launched.pid}`
      );
      return {
        ok: true,
        pid: launched.pid,
        offset: launched.offset,
        launch: launched.launch
      };
    } catch (error) {
      this.log(`${assignment.ref} \u62C9\u8D77\u5931\u8D25\uFF1A${reason(error)}`);
      return { ok: false, error: reason(error) };
    }
  }
  stopRun(task, run, signal) {
    const track = this.runs.get(task);
    if (!track || track.record.run !== run) return { ok: false };
    if (track.record.exit === void 0) killTree(track.record.pid, signal);
    return { ok: true };
  }
  // ---- 续传与补报 ----
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (this.connected) {
        for (const track of this.checkTracks.values())
          if (!track.abandoned)
            await this.uploadCheck(track).catch(() => void 0);
      }
      for (const track of [...this.runs.values()]) {
        if (this.stopped) return;
        const { record } = track;
        if (record.exit === void 0 && !track.child && !processAlive(record.pid)) {
          record.exit = null;
          this.state.saveRun(record);
          this.log(`${record.ref} \u5DF2\u7ED3\u675F\uFF08\u9000\u51FA\u7801\u4E0D\u53EF\u5F97\uFF09`);
        }
        if (!track.confirmed) continue;
        try {
          await this.upload(track);
          if (record.exit !== void 0) await this.report(track);
          track.failure = void 0;
        } catch (error) {
          if (!this.connected) return;
          const why = reason(error);
          if (track.failure !== why)
            this.log(`${record.ref} \u7684\u65E5\u5FD7\u6216\u7ED3\u679C\u6CA1\u4F20\u4E0A\uFF1A${why}\uFF1B\u7A0D\u540E\u518D\u8BD5`);
          track.failure = why;
          return;
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  size(file) {
    try {
      return statSync3(file).size;
    } catch {
      return 0;
    }
  }
  async upload(track) {
    if (track.abandoned) return;
    const { record } = track;
    for (let round = 0; round < 16; round++) {
      const chunk = nextChunk(
        record.uploaded,
        this.size(record.logFile),
        LOG_CHUNK
      );
      if (!chunk) return;
      const buffer = Buffer.alloc(chunk.length);
      const fd = openSync4(record.logFile, "r");
      let read = 0;
      try {
        read = readSync2(fd, buffer, 0, chunk.length, chunk.offset);
      } finally {
        closeSync4(fd);
      }
      const answer = await this.call(
        "log",
        {
          task: record.task,
          run: record.run,
          offset: chunk.offset,
          data: buffer.subarray(0, read).toString("base64")
        },
        3e4
      );
      if (answer.done) {
        track.abandoned = true;
        return;
      }
      if (answer.wait || answer.offset === void 0) return;
      record.uploaded = answer.offset;
      this.state.saveRun(record);
    }
  }
  lastMessage(record) {
    try {
      if (!existsSync6(record.resultFile)) return void 0;
      if (statSync3(record.resultFile).mtimeMs < record.startedAt)
        return void 0;
      return readFileSync3(record.resultFile, "utf8").slice(0, 512 * 1024);
    } catch {
      return void 0;
    }
  }
  async report(track) {
    const { record } = track;
    const done = () => {
      this.state.removeRun(record.task);
      this.runs.delete(record.task);
    };
    if (track.abandoned) return done();
    const size = this.size(record.logFile);
    if (record.uploaded < size) return;
    const message = this.lastMessage(record);
    const answer = await this.call(
      "exit",
      {
        task: record.task,
        run: record.run,
        exit: record.exit ?? null,
        size,
        ...message !== void 0 ? { last_message: message } : {}
      },
      3e4
    );
    if (answer.ok) {
      if (!answer.ignored) this.log(`${record.ref} \u7684\u7ED3\u679C\u5DF2\u4E0A\u62A5`);
      return done();
    }
    if (answer.offset !== void 0) {
      record.uploaded = answer.offset;
      this.state.saveRun(record);
    }
  }
};
function reason(error) {
  if (error instanceof AgentHttpError)
    return `${error.status} ${error.message}`;
  const cause = error?.cause?.code;
  if (cause) return cause;
  return error instanceof Error ? error.message : String(error);
}

// server/agent/run.ts
async function runAgent(input) {
  const server = normalizeServer(input.server);
  const data = agentDataDir();
  const url = new URL(server);
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]", "host.orb.internal"].includes(
    url.hostname
  ))
    console.error(
      "\u63D0\u793A\uFF1A\u4EE4\u724C\u8D70\u660E\u6587 HTTP\uFF1B\u8DE8\u516C\u7F51\u8BF7\u7528 HTTPS \u6216 SSH \u8F6C\u53D1\uFF08ssh -R\uFF09\u628A\u670D\u52A1\u7AEF\u53E3\u5E26\u5230\u8FD9\u53F0\u673A\u5668\u7684 127.0.0.1"
    );
  const agent = new Agent({
    server,
    data,
    env: process.env,
    code: input.code?.trim() || void 0,
    version: currentVersion()
  });
  const stop = () => agent.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Atrium \u4EE3\u7406 \xB7 \u670D\u52A1 ${server} \xB7 \u6570\u636E ${data}`);
  try {
    await agent.start();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (agent.failure) {
    console.error(
      `\u4EE3\u7406\u5DF2\u505C\u6B62\uFF1A${agent.failure}\u3002\u5728\u670D\u52A1\u90A3\u53F0\u673A\u5668\u4E0A\u91CD\u65B0 atrium host add \u62FF\u63A5\u5165\u7801\uFF0C\u518D atrium agent --server ${server} --token \u63A5\u5165\u7801`
    );
    return 1;
  }
  console.log("\u4EE3\u7406\u5DF2\u505C\u6B62\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u7167\u8DD1\uFF0C\u518D\u8FD0\u884C atrium agent \u63A5\u7740\u770B");
  return 0;
}
export {
  runAgent
};
