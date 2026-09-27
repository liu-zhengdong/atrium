import {
  ADAPTERS,
  TOOLS,
  checkPlacement,
  ensureWorktree,
  exec,
  firstLine,
  hostGate,
  hostLimits,
  isTool
} from "./chunk-2MG2JPDP.js";
import "./chunk-BYXBJQAS.js";
import {
  Problem
} from "./chunk-BU3TJ5JT.js";
import {
  WINDOWS_SYSTEM_ENV,
  commandInvocation,
  commandLineInvocation,
  currentVersion,
  envKey,
  findExecutable,
  killTree,
  processAlive,
  restrictToOwner,
  spawnInvocation,
  spawnShell
} from "./chunk-DIVCYJ6J.js";

// server/agent/main.ts
import {
  existsSync as existsSync6,
  openSync as openSync3,
  readSync as readSync2,
  closeSync as closeSync3,
  readFileSync as readFileSync3,
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
      await new Promise((resolve2) => {
        this.waiters.push(resolve2);
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
`, { mode: 384 });
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
      const fd = openSync(log, "w", 384);
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
        (resolve2) => {
          child.once("error", (error) => resolve2({ code: null, error }));
          child.once("close", (code) => resolve2({ code }));
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
      (resolve2) => child.once("error", resolve2)
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
    max_workers: hostLimits(input.env, cores).limits.maxWorkers
  };
}

// server/hosts/protocol.ts
var LOG_CHUNK = 256 * 1024;
var POLL_WAIT_MS = 25e3;

// server/agent/launch.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync3, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname, join as join3 } from "node:path";

// server/tasks/workspace.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "node:fs";

// server/tasks/openquota.ts
var PACE_MAX_BUFFER = 1024 * 1024;

// server/quota-readers/credentials.ts
var MAX_CREDENTIAL_BYTES = 1024 * 1024;

// server/quota-readers/http.ts
var MAX_BODY_BYTES = 1024 * 1024;

// server/quota-readers/claude.ts
var DEFAULT_RATE_LIMIT_MS = 5 * 6e4;
var HOUR = 3600;
var WEEK = 7 * 24 * HOUR;
var SCOPED_PERIOD = {
  weekly_scoped: WEEK,
  daily_scoped: 24 * HOUR,
  session_scoped: 5 * HOUR,
  five_hour_scoped: 5 * HOUR
};

// server/quota-readers/codex.ts
var SESSION = 5 * 60 * 60;
var WEEK2 = 7 * 24 * 60 * 60;

// server/quota-readers/opencode.ts
var WINDOWS2 = [
  ["rolling", "session", "Session", 5 * 60 * 60],
  ["weekly", "weekly", "Weekly", 7 * 24 * 60 * 60],
  ["monthly", "monthly", "Monthly", 0]
];

// server/quota-readers/index.ts
var OK_TTL_MS = 5 * 6e4;
var LAST_GOOD_MS = 6 * 60 * 6e4;

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
function commandRefusal(command, os, dataDir) {
  switch (command.kind) {
    case "launch":
      return assignmentRefusal(command.assignment, os, dataDir);
    case "exec":
      return gitRefusal(command.args, os, dataDir);
    case "check":
      return insideData(os, dataDir, command.worktree) ? null : "\u68C0\u67E5\u7684\u5DE5\u4F5C\u6811\u4E0D\u5728\u4EE3\u7406\u6570\u636E\u76EE\u5F55\u91CC";
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

// server/agent/state.ts
import { randomBytes } from "node:crypto";
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync4,
  readdirSync,
  readFileSync as readFileSync2,
  renameSync as renameSync2,
  rmSync,
  writeFileSync as writeFileSync5
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4, resolve } from "node:path";
function agentDataDir(env = process.env) {
  const configured = env.ATRIUM_AGENT_DATA?.trim();
  return resolve(configured || join4(env.HOME || homedir2(), ".atrium-agent"));
}
function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync2(from, to);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= 10 || code !== "EPERM" && code !== "EBUSY") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
function writeSecretFile(path, text) {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync5(temp, text, { mode: 384 });
  try {
    renameRetrying(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  restrictToOwner(path);
}
var AgentState = class {
  constructor(dir) {
    this.dir = dir;
    mkdirSync4(join4(dir, "runs"), { recursive: true, mode: 448 });
  }
  dir;
  get configFile() {
    return join4(this.dir, "agent.json");
  }
  /** 接入过的服务与令牌；没有或写坏了为 null（坏文件挪开留档）。 */
  config() {
    if (!existsSync5(this.configFile)) return null;
    try {
      const value = JSON.parse(
        readFileSync2(this.configFile, "utf8")
      );
      if (typeof value.server === "string" && typeof value.host === "string" && typeof value.token === "string")
        return value;
    } catch {
    }
    renameSync2(this.configFile, `${this.configFile}.invalid-${Date.now()}`);
    return null;
  }
  saveConfig(config) {
    writeSecretFile(this.configFile, `${JSON.stringify(config)}
`);
  }
  runFile(task) {
    return join4(this.dir, "runs", `${task}.json`);
  }
  saveRun(run) {
    writeSecretFile(this.runFile(run.task), JSON.stringify(run));
  }
  removeRun(task) {
    rmSync(this.runFile(task), { force: true, maxRetries: 10, retryDelay: 50 });
  }
  /** 读全部运行记录；单条写坏的挪开并记下，其余照常。 */
  runs(onBad) {
    const found = [];
    for (const name of readdirSync(join4(this.dir, "runs"))) {
      if (!/^[0-9]+\.json$/.test(name)) continue;
      const file = join4(this.dir, "runs", name);
      try {
        const run = JSON.parse(readFileSync2(file, "utf8"));
        if (Number.isSafeInteger(run.task) && Number.isSafeInteger(run.run)) {
          found.push(run);
          continue;
        }
      } catch {
      }
      renameSync2(file, `${file}.invalid-${Date.now()}`);
      onBad?.(file);
    }
    return found.sort((a, b) => a.task - b.task);
  }
};

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
var sleep = (ms, signal) => new Promise((resolve2) => {
  const timer = setTimeout(resolve2, ms);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve2();
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
  }
  options;
  state;
  config;
  runs = /* @__PURE__ */ new Map();
  /** 正在做（含回执还没送到）的指令：长轮询时告诉服务别重发。 */
  busy = /* @__PURE__ */ new Set();
  abort = new AbortController();
  checks;
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
    try {
      await this.loop();
    } finally {
      clearInterval(this.timer);
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
        while (!this.stopped) {
          const { commands } = await this.call(
            "poll",
            { load: this.load(), busy: [...this.busy] },
            POLL_WAIT_MS + 2e4
          );
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
          failedTests: []
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
            result = await runLocalCheck({
              worktree: command.worktree,
              taskDir: join5(this.options.data, "tasks", String(command.task)),
              env: this.options.env,
              urgent: command.urgent,
              queue: this.checks
            });
            break;
        }
      await this.reply(command, result);
    } catch (error) {
      await this.reply(command, this.refused(command, reason(error))).catch(
        () => void 0
      );
    } finally {
      this.busy.delete(command.id);
    }
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
        const answer = await this.call(
          "reply",
          { id: command.id, result },
          3e4
        );
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
        if (track.record.exit !== void 0) return;
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
      const fd = openSync3(record.logFile, "r");
      let read = 0;
      try {
        read = readSync2(fd, buffer, 0, chunk.length, chunk.offset);
      } finally {
        closeSync3(fd);
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
