// shared/secret.ts
import { createHash, timingSafeEqual } from "node:crypto";
function sameSecret(left, right) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

// server/app.ts
import Fastify from "fastify";
import { mkdirSync as mkdirSync17 } from "node:fs";
import { join as join30, resolve as resolve3 } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";
import { z } from "zod";

// server/problem.ts
var Problem = class extends Error {
  constructor(statusCode, message4, code, candidates, nextCommand) {
    super(message4);
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

// server/user-auth.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
var digest = (value) => createHash2("sha256").update(value).digest("hex");
var secret = () => randomBytes(32).toString("hex");
function atomicSecret(path, value) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${value}
`, { flag: "wx", mode: 384 });
    renameSync(temp, path);
    chmodSync(path, 384);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
var userTokenPath = (data2) => join(data2, "user-token");
var UserAuth = class {
  constructor(db, data2) {
    this.db = db;
    this.data = data2;
    mkdirSync(data2, { recursive: true, mode: 448 });
    db.exec(`CREATE TABLE IF NOT EXISTS user_auth (
      id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL);`);
    if (!db.prepare("SELECT id FROM user_auth WHERE id=1").get()) {
      const path = userTokenPath(data2);
      let token = existsSync(path) ? readFileSync(path, "utf8").trim() : null;
      if (token !== null && !/^[a-f0-9]{64}$/.test(token)) {
        const preserved = `${path}.invalid-${randomBytes(6).toString("hex")}`;
        renameSync(path, preserved);
        chmodSync(preserved, 384);
        console.warn(
          `\u7528\u6237\u4EE4\u724C\u6587\u4EF6\u65E0\u6548\uFF0C\u539F\u4EF6\u5DF2\u4FDD\u7559\uFF1A${preserved}\uFF1B\u5DF2\u751F\u6210\u65B0\u4EE4\u724C`
        );
        token = null;
      }
      if (!token) {
        token = secret();
        atomicSecret(path, token);
      }
      db.prepare("INSERT INTO user_auth(id,token_hash) VALUES(1,?)").run(
        digest(token)
      );
    }
  }
  db;
  data;
  validUser(value) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(value ?? "")?.[1];
    const row3 = this.db.prepare("SELECT token_hash FROM user_auth WHERE id=1").get();
    return !!token && !!row3 && sameSecret(digest(token), row3.token_hash);
  }
  rotate() {
    const token = secret();
    atomicSecret(userTokenPath(this.data), token);
    this.db.prepare("UPDATE user_auth SET token_hash=? WHERE id=1").run(digest(token));
  }
};

// server/auth-policy.ts
var separatelyAuthenticatedRoutes = /* @__PURE__ */ new Set([
  "POST /api/auth/rotate",
  // user or local instance-control credential
  "GET /api/service",
  "GET /api/service/info",
  // 免认证：只回服务身份与数据目录，供撞端口时说明（t71）
  "GET /api/service/health",
  "POST /api/service/prepare-restart",
  "POST /api/service/stop"
]);
var mapLoginRoutes = /* @__PURE__ */ new Set(["GET /map/login"]);
var mapPageRoutes = /* @__PURE__ */ new Set([
  "GET /map",
  "GET /map/app.js",
  "GET /map/format.js",
  "GET /map/style.css"
]);
var mapReadRoutes = /* @__PURE__ */ new Set([
  "GET /api/map/tree",
  "GET /api/map/nodes/:id",
  "GET /api/map/now",
  "GET /api/map/stream",
  "GET /api/map/roles",
  "GET /api/map/roles/:id",
  "GET /api/map/specialists",
  "GET /api/map/specialists/:id",
  "GET /api/map/skills",
  "GET /api/map/workers",
  "GET /api/map/workers/:id",
  "GET /api/map/leaders",
  "GET /api/map/leaders/:id"
]);
function authPolicy(method, route) {
  const key = `${method === "HEAD" ? "GET" : method} ${route}`;
  if (separatelyAuthenticatedRoutes.has(key)) return "separate";
  if (mapLoginRoutes.has(key)) return "map-login";
  if (mapPageRoutes.has(key)) return "map-page";
  if (mapReadRoutes.has(key)) return "map-read";
  return "user";
}

// server/tasks/ledger-model.ts
var taskRef = (id3) => `t${id3}`;
var view = (row3) => ({
  ...row3,
  ref: taskRef(row3.id),
  parent_ref: row3.parent_id === null ? null : taskRef(row3.parent_id),
  node_ref: row3.node_id == null ? null : `o${row3.node_id}`,
  origin_ref: row3.origin_node_id == null ? null : `o${row3.origin_node_id}`,
  goal_ref: row3.goal_id == null ? null : `g${row3.goal_id}`,
  part_ref: row3.part_id == null ? null : `o${row3.part_id}`,
  job_ref: row3.job_id == null ? null : `r${row3.job_id}`
});
var listView = (row3) => ({ ...view(row3), brief: void 0 });
var RESULT_MAX_BYTES = 4096;
var LIST_LIMIT = 200;
var LIST_MAX = 500;
var TREE_MAX = 2e3;
var usage = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function parseTaskRef(value, field2 = "id") {
  const text6 = typeof value === "number" ? String(value) : value;
  const match = typeof text6 === "string" ? /^t?([1-9][0-9]{0,15})$/.exec(text6.trim()) : null;
  const id3 = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id3))
    throw usage(`${field2}: \u4EFB\u52A1\u77ED\u53F7\u5E94\u4E3A t1 \u8FD9\u6837\u7684\u683C\u5F0F`);
  return id3;
}
function one(db, sql, ...params3) {
  return db.prepare(sql).get(...params3);
}
function all(db, sql, ...params3) {
  return db.prepare(sql).all(...params3);
}
function atomically(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function row(db, id3) {
  return one(db, "SELECT * FROM tasks WHERE id=?", id3);
}
function requireRow(db, id3) {
  const found = row(db, id3);
  if (!found)
    throw new Problem(
      404,
      `\u4EFB\u52A1 ${taskRef(id3)} \u4E0D\u5B58\u5728`,
      "not_found",
      void 0,
      "atrium task ls"
    );
  return found;
}
function addEvent(db, id3, at, kind, detail2) {
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)"
  ).run(
    id3,
    at,
    kind,
    detail2 === void 0 ? null : typeof detail2 === "string" ? detail2 : JSON.stringify(detail2)
  );
}

// server/tasks/host-load.ts
import { availableParallelism, loadavg } from "node:os";

// server/platform/cpu.ts
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

// server/platform/cpu-plan.ts
function cpuSource(platform) {
  if (platform === "linux" || platform === "android") return { kind: "proc" };
  if (platform === "win32")
    return {
      kind: "command",
      read: "rate",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `([wmisearcher]'SELECT IDProcess,CreatingProcessID,PercentProcessorTime FROM Win32_PerfFormattedData_PerfProc_Process').Get() | ForEach-Object { "$($_.IDProcess) $($_.CreatingProcessID) $($_.PercentProcessorTime)" }`
      ]
    };
  return {
    kind: "command",
    read: "total",
    command: "ps",
    args: ["-A", "-o", "pid=,ppid=,time="]
  };
}
function cpuTimeSeconds(text6) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(
    text6.trim()
  );
  if (!match) return null;
  const [, days, hours, minutes2, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes2) * 60 + Number(seconds);
}
var pidOf = (text6) => {
  const value = Number(text6);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
function parsePs(text6) {
  const procs = [];
  for (const line of text6.split("\n")) {
    const [pidText, ppidText, time2] = line.trim().split(/\s+/);
    const pid = pidOf(pidText);
    const ppid = pidOf(ppidText);
    const cpu = time2 === void 0 ? null : cpuTimeSeconds(time2);
    if (pid !== null && ppid !== null && cpu !== null)
      procs.push({ pid, ppid, cpu });
  }
  return procs;
}
function parseProcStat(text6, ticksPerSecond = 100) {
  const close = text6.lastIndexOf(")");
  const pid = pidOf(text6.slice(0, text6.indexOf("(")).trim());
  if (close < 0 || pid === null) return null;
  const fields = text6.slice(close + 1).trim().split(/\s+/);
  const ppid = pidOf(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (ppid === null || !Number.isFinite(utime) || !Number.isFinite(stime))
    return null;
  return { pid, ppid, cpu: (utime + stime) / ticksPerSecond };
}
function parseWindowsPerf(text6) {
  const procs = [];
  for (const line of text6.split(/\r?\n/)) {
    const [pidText, ppidText, percentText] = line.trim().split(/\s+/);
    const pid = pidOf(pidText);
    const ppid = pidOf(ppidText);
    const percent = Number(percentText);
    if (pid && ppid !== null && Number.isFinite(percent) && percent >= 0)
      procs.push({ pid, ppid, cpu: percent / 100 });
  }
  return procs;
}
function atriumTree(procs, roots) {
  const children = /* @__PURE__ */ new Map();
  for (const proc of procs) {
    if (proc.pid === proc.ppid) continue;
    const list4 = children.get(proc.ppid);
    if (list4) list4.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const alive4 = new Set(procs.map((proc) => proc.pid));
  const tree2 = /* @__PURE__ */ new Set();
  const stack = [
    ...children.get(roots.service) ?? [],
    ...(roots.adopted ?? []).filter(
      (pid) => pid !== roots.service && alive4.has(pid)
    )
  ];
  while (stack.length) {
    const pid = stack.pop();
    if (pid === roots.service || tree2.has(pid)) continue;
    tree2.add(pid);
    stack.push(...children.get(pid) ?? []);
  }
  return tree2;
}
function treeCores(previous, current2, tree2) {
  if (current2.kind === "rate") {
    let sum = 0;
    for (const proc of current2.procs) if (tree2.has(proc.pid)) sum += proc.cpu;
    return round(sum);
  }
  if (!previous || previous.kind !== "total") return null;
  const seconds = (current2.at - previous.at) / 1e3;
  if (!(seconds >= 0.5)) return null;
  const before = new Map(previous.procs.map((proc) => [proc.pid, proc.cpu]));
  let used = 0;
  for (const proc of current2.procs) {
    if (!tree2.has(proc.pid)) continue;
    const last = before.get(proc.pid);
    used += last === void 0 || proc.cpu < last ? proc.cpu : proc.cpu - last;
  }
  return round(used / seconds);
}
var round = (value) => Math.round(value * 100) / 100;

// server/platform/cpu.ts
async function readProc() {
  const procs = [];
  const names2 = await readdir("/proc");
  for (const name2 of names2) {
    if (!/^\d+$/.test(name2)) continue;
    try {
      const proc = parseProcStat(await readFile(`/proc/${name2}/stat`, "utf8"));
      if (proc) procs.push(proc);
    } catch {
    }
  }
  return procs;
}
function run(command, args2) {
  return new Promise(
    (resolve4, reject3) => execFile(
      command,
      args2,
      { timeout: 1e4, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject3(error) : resolve4(stdout)
    )
  );
}
async function snapshot(platform = process.platform, now = Date.now) {
  const source2 = cpuSource(platform);
  if (source2.kind === "proc")
    return { kind: "total", at: now(), procs: await readProc() };
  const text6 = await run(source2.command, source2.args);
  return {
    kind: source2.read,
    at: now(),
    procs: source2.read === "rate" ? parseWindowsPerf(text6) : parsePs(text6)
  };
}
var ProcessCpu = class {
  constructor(take = () => snapshot(), service = process.pid) {
    this.take = take;
    this.service = service;
  }
  take;
  service;
  last = null;
  value = null;
  running = null;
  cores() {
    return this.value;
  }
  /** adopted：服务重启后接管来的执行者 pid（父进程已不是服务）。同时来的几次合成一次。 */
  refresh(adopted2 = []) {
    this.running ??= (async () => {
      try {
        const current2 = await this.take();
        const tree2 = atriumTree(current2.procs, {
          service: this.service,
          adopted: adopted2
        });
        this.value = treeCores(this.last, current2, tree2);
        this.last = current2;
      } catch {
        this.value = null;
        this.last = null;
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
};

// server/tasks/host-load.ts
var OFF = /* @__PURE__ */ new Set(["0", "off", "none", "false"]);
function parseCount(raw, allowOff) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const text6 = raw.trim().toLowerCase();
  if (allowOff && OFF.has(text6)) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(text6)) return void 0;
  return Number(text6);
}
function parseLoad(raw) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const text6 = raw.trim().toLowerCase();
  if (OFF.has(text6)) return null;
  const value = Number(text6);
  return Number.isFinite(value) && value > 0 && value < 1e6 ? value : void 0;
}
function hostLimits(env, cores) {
  const n = Math.max(1, Math.floor(cores));
  const testing = !!env.NODE_TEST_CONTEXT;
  const problems = [];
  const pick = (name2, parsed, fallback) => {
    if (parsed !== void 0) return parsed;
    if (env[name2] !== void 0 && env[name2].trim() !== "")
      problems.push(`${name2}=${env[name2]} \u770B\u4E0D\u61C2\uFF0C\u6309\u7F3A\u7701\u6267\u884C`);
    return fallback;
  };
  const quarter = Math.max(1, Math.floor(n / 4));
  return {
    limits: {
      cores: n,
      maxWorkers: pick(
        "ATRIUM_MAX_WORKERS",
        parseCount(env.ATRIUM_MAX_WORKERS, true),
        testing ? null : Math.max(2, Math.floor(n * 3 / 4))
      ),
      maxChecks: pick(
        "ATRIUM_MAX_CHECKS",
        parseCount(env.ATRIUM_MAX_CHECKS, false) ?? void 0,
        quarter
      ),
      testConcurrency: pick(
        "ATRIUM_TEST_CONCURRENCY",
        parseCount(env.ATRIUM_TEST_CONCURRENCY, false) ?? void 0,
        quarter
      ),
      busyCores: pick(
        "ATRIUM_BUSY_CORES",
        parseLoad(env.ATRIUM_BUSY_CORES),
        testing ? null : n * 3 / 4
      ),
      busyLoad: pick(
        "ATRIUM_BUSY_LOAD",
        parseLoad(env.ATRIUM_BUSY_LOAD),
        testing ? null : 4 * n
      )
    },
    problems
  };
}
var loadText = (load) => load >= 10 ? load.toFixed(0) : load.toFixed(1);
var coreText = (cores) => Number.isInteger(cores) ? String(cores) : cores.toFixed(1);
function hostGate(input) {
  const { running, load, limits } = input;
  const own = input.own ?? null;
  if (input.urgent) return { ok: true };
  if (limits.busyCores !== null && own !== null && own > limits.busyCores)
    return {
      ok: false,
      busy: true,
      by: "own",
      reason: `\u672C\u673A\u592A\u5FD9\uFF08Atrium \u81EA\u5DF1\u5360\u4E86 ${coreText(own)} \u6838\uFF0C\u8D85\u8FC7 ${coreText(limits.busyCores)}\uFF09\uFF0C\u964D\u4E0B\u6765\u540E\u81EA\u52A8\u62C9\u8D77`
    };
  if (limits.busyLoad !== null && load > limits.busyLoad)
    return {
      ok: false,
      busy: true,
      by: "load",
      reason: `\u672C\u673A\u592A\u5FD9\uFF08\u6574\u673A\u8D1F\u8F7D ${loadText(load)}\uFF0C\u8D85\u8FC7 ${loadText(limits.busyLoad)}\uFF09\uFF0C\u964D\u4E0B\u6765\u540E\u81EA\u52A8\u62C9\u8D77`
    };
  if (limits.maxWorkers !== null && running >= limits.maxWorkers)
    return {
      ok: false,
      busy: false,
      by: "full",
      reason: `\u672C\u673A\u540C\u65F6\u6700\u591A\u8DD1 ${limits.maxWorkers} \u4E2A\u6267\u884C\u8005\uFF0C\u6709\u6267\u884C\u8005\u7ED3\u675F\u540E\u81EA\u52A8\u62C9\u8D77`
    };
  return { ok: true };
}
function queueOrder(a, b) {
  return Number(b.urgent) - Number(a.urgent) || a.at - b.at || a.id - b.id;
}
function checkPlacement(input) {
  return input.urgent || input.active < input.max ? "run" : "wait";
}
function hostView(input) {
  const gate = hostGate({
    running: input.running,
    load: input.load,
    own: input.own,
    limits: input.limits
  });
  return {
    cores: input.limits.cores,
    load: Math.round(input.load * 100) / 100,
    busy_load: input.limits.busyLoad,
    own_cores: input.own ?? null,
    busy_cores: input.limits.busyCores,
    running: input.running,
    max_workers: input.limits.maxWorkers,
    checks: { ...input.checks, max: input.limits.maxChecks },
    test_concurrency: input.limits.testConcurrency,
    paused: gate.ok ? null : gate.reason,
    paused_by: gate.ok ? null : gate.by
  };
}
var HostLoad = class _HostLoad {
  constructor(limits, sample = () => loadavg()[0] ?? 0, cpu = null) {
    this.limits = limits;
    this.sample = sample;
    this.cpu = cpu;
  }
  limits;
  sample;
  cpu;
  static fromEnv(env = process.env) {
    const { limits, problems } = hostLimits(env, availableParallelism());
    for (const problem of problems) console.error(`\u672C\u673A\u51CF\u8D1F\u914D\u7F6E\uFF1A${problem}`);
    return new _HostLoad(
      limits,
      void 0,
      limits.busyCores === null ? null : new ProcessCpu()
    );
  }
  load() {
    try {
      const value = this.sample();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }
  /** Atrium 进程树占的核数；不知道为 null。 */
  own() {
    try {
      const value = this.cpu?.cores() ?? null;
      return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }
  /** 巡检时采一次样；adopted 是接管来的执行者 pid。 */
  async refresh(adopted2 = []) {
    await this.cpu?.refresh(adopted2).catch(() => void 0);
  }
  gate(running, urgent = false) {
    return hostGate({
      running,
      load: this.load(),
      own: this.own(),
      limits: this.limits,
      urgent
    });
  }
};

// server/tasks/queue.ts
function ensureQueueTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_queue (
      task_id INTEGER PRIMARY KEY,
      tool TEXT NOT NULL,
      worker TEXT NOT NULL,
      risk TEXT NOT NULL,
      queued_at INTEGER NOT NULL)`);
}
function enqueue(db, entry) {
  db.prepare(
    "INSERT INTO task_queue(task_id,tool,worker,risk,queued_at) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET tool=excluded.tool,worker=excluded.worker,risk=excluded.risk"
  ).run(entry.task_id, entry.tool, entry.worker, entry.risk, entry.queued_at);
}
function dequeue(db, taskId) {
  return db.prepare("DELETE FROM task_queue WHERE task_id=?").run(taskId).changes > 0;
}
function queued(db, taskId) {
  return db.prepare("SELECT * FROM task_queue WHERE task_id=?").get(taskId);
}
function queueView(db, taskId) {
  if (!queued(db, taskId)) return { queued_reason: null };
  const row3 = db.prepare(
    "SELECT detail FROM task_events WHERE task_id=? AND kind='queued' ORDER BY id DESC LIMIT 1"
  ).get(taskId);
  try {
    const reason = JSON.parse(row3?.detail ?? "null")?.reason;
    if (typeof reason === "string" && reason.trim())
      return { queued_reason: reason.trim() };
  } catch {
  }
  return { queued_reason: "\u7B49\u5F85\u6267\u884C\u8005\u53EF\u7528\u540E\u81EA\u52A8\u62C9\u8D77" };
}
function queueHeads(entries) {
  const order = (a, b) => queueOrder(
    { urgent: a.urgent, at: a.queued_at, id: a.task_id },
    { urgent: b.urgent, at: b.queued_at, id: b.task_id }
  );
  const first = /* @__PURE__ */ new Map();
  for (const entry of [...entries].sort(order))
    if (!first.has(entry.tool)) first.set(entry.tool, entry);
  return [...first.values()].sort(order);
}
var QUEUE_SCAN = 1e3;
function heads(db, tool) {
  const rows = db.prepare(
    `SELECT q.*,COALESCE(t.urgent,0) AS urgent FROM task_queue q LEFT JOIN tasks t ON t.id=q.task_id${tool ? " WHERE q.tool=?" : ""} ORDER BY COALESCE(t.urgent,0) DESC,q.queued_at,q.task_id LIMIT ${QUEUE_SCAN}`
  ).all(...tool ? [tool] : []);
  return queueHeads(rows.map((row3) => ({ ...row3, urgent: row3.urgent === 1 })));
}

// server/tasks/schedule-recovery.ts
var repoName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
function repairScheduleRecords(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_schedule_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
    reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL);`);
  const keep = db.prepare(
    "INSERT INTO task_schedule_quarantine(kind,payload,reason,quarantined_at) VALUES (?,?,?,?)"
  );
  let after = 0;
  for (; ; ) {
    const rows = db.prepare(
      `SELECT d.rowid,d.task_id,d.after_id,t.id AS valid_task,a.id AS valid_after
      FROM task_dependencies d LEFT JOIN tasks t ON t.id=d.task_id
      LEFT JOIN tasks a ON a.id=d.after_id WHERE d.rowid>? ORDER BY d.rowid LIMIT 200`
    ).all(after);
    for (const edge of rows) {
      after = edge.rowid;
      const reason = edge.valid_task === null || edge.valid_after === null ? "\u5F15\u7528\u7684\u4EFB\u52A1\u4E0D\u5B58\u5728" : edge.task_id === edge.after_id ? "\u4EFB\u52A1\u4F9D\u8D56\u81EA\u8EAB" : null;
      if (!reason) continue;
      atomically(db, () => {
        keep.run(
          "task",
          JSON.stringify({ task_id: edge.task_id, after_id: edge.after_id }),
          reason,
          Date.now()
        );
        db.prepare(
          "DELETE FROM task_dependencies WHERE task_id=? AND after_id=?"
        ).run(edge.task_id, edge.after_id);
      });
      console.error(
        `\u4EFB\u52A1\u6392\u671F\uFF1A\u5DF2\u9694\u79BB ${taskRef(edge.task_id)} \u7684\u574F\u4F9D\u8D56\uFF1A${reason}`
      );
    }
    if (rows.length < 200) break;
  }
  let cursor = 0;
  for (; ; ) {
    const rows = db.prepare(
      `SELECT p.rowid,p.task_id,p.repo,p.number,p.merged,t.id AS valid_task
      FROM task_pr_dependencies p LEFT JOIN tasks t ON t.id=p.task_id
      WHERE p.rowid>? ORDER BY p.rowid LIMIT 200`
    ).all(cursor);
    for (const edge of rows) {
      cursor = edge.rowid;
      const reason = edge.valid_task === null ? "\u4EFB\u52A1\u4E0D\u5B58\u5728" : !repoName.test(edge.repo) || !Number.isSafeInteger(edge.number) || edge.number < 1 || ![0, 1].includes(edge.merged) ? "PR \u6761\u4EF6\u683C\u5F0F\u635F\u574F" : null;
      if (!reason) continue;
      atomically(db, () => {
        keep.run(
          "pr",
          JSON.stringify({
            task_id: edge.task_id,
            repo: edge.repo,
            number: edge.number,
            merged: edge.merged
          }),
          reason,
          Date.now()
        );
        db.prepare("DELETE FROM task_pr_dependencies WHERE rowid=?").run(
          edge.rowid
        );
      });
      console.error(
        `\u4EFB\u52A1\u6392\u671F\uFF1A\u5DF2\u9694\u79BB ${taskRef(edge.task_id)} \u7684\u574F PR \u6761\u4EF6\uFF1A${reason}`
      );
    }
    if (rows.length < 200) break;
  }
}

// server/tasks/git.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { homedir } from "node:os";
var exec = (command, args2, options = {}) => new Promise((resolve4) => {
  execFile2(
    command,
    args2,
    {
      cwd: options.cwd ?? homedir(),
      timeout: options.timeoutMs ?? 3e4,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0"
      }
    },
    (error, stdout, stderr) => resolve4({
      ok: !error,
      stdout: String(stdout),
      stderr: String(stderr || (error ? error.message : ""))
    })
  );
});
var firstLine = (text6) => text6.trim().split("\n")[0] ?? "";
async function defaultBranch(repo, run3 = exec) {
  const head2 = await run3(
    "git",
    ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { timeoutMs: 1e4 }
  );
  if (head2.ok && head2.stdout.trim().startsWith("origin/"))
    return head2.stdout.trim().slice("origin/".length);
  for (const name2 of ["main", "master"]) {
    const found = await run3(
      "git",
      ["-C", repo, "rev-parse", "--verify", "--quiet", `origin/${name2}`],
      { timeoutMs: 1e4 }
    );
    if (found.ok) return name2;
  }
  throw new Problem(
    409,
    `\u4ED3\u5E93 ${repo} \u627E\u4E0D\u5230 origin \u7684\u9ED8\u8BA4\u5206\u652F\uFF08origin/HEAD\u3001origin/main\u3001origin/master \u90FD\u6CA1\u6709\uFF09`,
    "conflict"
  );
}
async function ensureWorktree(repo, plan2, base2, run3 = exec) {
  if (existsSync2(plan2.path)) {
    const branch = await run3(
      "git",
      ["-C", plan2.path, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeoutMs: 1e4 }
    );
    if (branch.ok && branch.stdout.trim() === plan2.branch)
      return { created: false };
    throw new Problem(
      409,
      `\u5DE5\u4F5C\u6811\u8DEF\u5F84 ${plan2.path} \u5DF2\u5B58\u5728\u4F46\u4E0D\u5728\u5206\u652F ${plan2.branch} \u4E0A\uFF1B\u5148\u6E05\u7406\u518D\u6D3E`,
      "conflict"
    );
  }
  const fetched = await run3("git", ["-C", repo, "fetch", "origin", base2], {
    timeoutMs: 12e4
  });
  if (!fetched.ok)
    throw new Problem(
      409,
      `\u62C9\u53D6 origin/${base2} \u5931\u8D25\uFF1A${firstLine(fetched.stderr)}`,
      "conflict"
    );
  const exists = await run3(
    "git",
    [
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${plan2.branch}`
    ],
    { timeoutMs: 1e4 }
  );
  const args2 = exists.ok ? ["-C", repo, "worktree", "add", plan2.path, plan2.branch] : [
    "-C",
    repo,
    "worktree",
    "add",
    "--no-track",
    "-b",
    plan2.branch,
    plan2.path,
    `origin/${base2}`
  ];
  const added = await run3("git", args2, { timeoutMs: 6e4 });
  if (!added.ok)
    throw new Problem(
      409,
      `\u5EFA\u5DE5\u4F5C\u6811\u5931\u8D25\uFF1A${firstLine(added.stderr)}`,
      "conflict"
    );
  return { created: true };
}

// server/tasks/gh-repo.ts
var SEGMENT = /^[A-Za-z0-9_.-]+$/;
function fromPath(host, path) {
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, name2] = parts;
  if (!host || !SEGMENT.test(owner) || !SEGMENT.test(name2)) return null;
  if (owner.startsWith(".") || name2.startsWith(".")) return null;
  return { host: host.toLowerCase(), owner, name: name2 };
}
function parseRemote(url) {
  const text6 = url.trim();
  const scheme = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)$/i.exec(
    text6
  );
  if (scheme) return fromPath(scheme[1], scheme[2]);
  if (text6.includes("://")) return null;
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/.exec(text6);
  if (scp) return fromPath(scp[1], scp[2]);
  return null;
}
function parsePrUrl(url) {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(
    url.trim()
  );
  return match ? fromPath(match[1], `${match[2]}/${match[3]}`) : null;
}
function repoFlag(repo) {
  const slug = `${repo.owner}/${repo.name}`;
  return repo.host === "github.com" ? slug : `${repo.host}/${slug}`;
}
function apiArgs(repo, path) {
  return [
    "api",
    `repos/${repo.owner}/${repo.name}/${path}`,
    ...repo.host === "github.com" ? [] : ["--hostname", repo.host]
  ];
}
async function originRepo(repo, run3 = exec) {
  const url = await run3("git", ["-C", repo, "remote", "get-url", "origin"], {
    timeoutMs: 1e4
  });
  if (!url.ok)
    return {
      error: `\u8BFB\u4E0D\u5230\u4ED3\u5E93 ${repo} \u7684 origin \u8FDC\u7AEF\uFF1A${firstLine(url.stderr) || "git \u5931\u8D25"}`
    };
  const parsed = parseRemote(url.stdout);
  if (!parsed)
    return {
      error: `origin \u8FDC\u7AEF ${firstLine(url.stdout)} \u89E3\u6790\u4E0D\u51FA owner/repo\uFF0C\u4E0D\u80FD\u786E\u5B9A gh \u67E5\u8BE2\u7684\u4ED3\u5E93`
    };
  return { repo: parsed };
}

// server/tasks/schedule-upstream.ts
function ensureUpstreamPrTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_pr_merge (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), pr_url TEXT NOT NULL,
    state TEXT CHECK(state IN ('open','merged','closed')), checked_at INTEGER, error TEXT);`);
}
function prNumber(url) {
  const match = /\/pull\/([1-9][0-9]*)\/?$/.exec(url.trim());
  const number2 = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number2) ? number2 : null;
}
function watched(row3) {
  return row3.status === "done" && row3.deliver === "pr" && !!row3.pr_url && prNumber(row3.pr_url) !== null;
}
function dependencyOf(db, id3) {
  const row3 = db.prepare("SELECT id,status,deliver,pr_url,repo FROM tasks WHERE id=?").get(id3);
  const ref2 = `t${id3}`;
  if (!watched(row3)) return { ref: ref2, status: row3.status };
  const cached = db.prepare(
    "SELECT state,error FROM task_pr_merge WHERE task_id=? AND pr_url=?"
  ).get(id3, row3.pr_url);
  return {
    ref: ref2,
    status: row3.status,
    pr: {
      number: prNumber(row3.pr_url),
      state: cached?.state ?? null,
      error: cached?.error ?? null
    }
  };
}
function parsePrState(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed.state === "MERGED" || parsed.mergedAt) return "merged";
  if (parsed.state === "CLOSED") return "closed";
  if (parsed.state === "OPEN") return "open";
  throw new Error(`gh \u8FD4\u56DE\u7684 PR \u72B6\u6001\u770B\u4E0D\u61C2\uFF1A${String(parsed.state)}`);
}
async function refreshUpstreamPrs(db, taskId, now, run3) {
  const rows = all(
    db,
    `SELECT t.id,t.status,t.deliver,t.pr_url,t.repo,m.pr_url AS cached_url,m.checked_at,m.state
     FROM task_dependencies d JOIN tasks t ON t.id=d.after_id LEFT JOIN task_pr_merge m ON m.task_id=t.id
     WHERE d.task_id=? AND t.status='done' AND t.deliver='pr' AND t.pr_url IS NOT NULL
     ORDER BY t.id LIMIT 20`,
    taskId
  );
  for (const row3 of rows) {
    if (!watched(row3)) continue;
    const fresh = row3.cached_url === row3.pr_url;
    if (fresh && (row3.state === "merged" || row3.checked_at !== null && row3.checked_at >= now - 6e4))
      continue;
    let state = null;
    let error = null;
    try {
      const target = await ghTarget(row3, run3);
      const result = await run3(
        "gh",
        [
          "pr",
          "view",
          String(prNumber(row3.pr_url)),
          "-R",
          target,
          "--json",
          "state,mergedAt"
        ],
        { timeoutMs: 15e3 }
      );
      if (!result.ok)
        throw new Error(firstLine(result.stderr) || "gh \u67E5\u8BE2\u5931\u8D25");
      state = parsePrState(result.stdout);
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(
        0,
        300
      );
      state = fresh ? row3.state : null;
    }
    db.prepare(
      `INSERT INTO task_pr_merge(task_id,pr_url,state,checked_at,error) VALUES (?,?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET pr_url=excluded.pr_url,state=excluded.state,checked_at=excluded.checked_at,error=excluded.error`
    ).run(row3.id, row3.pr_url, state, now, error);
  }
}
async function ghTarget(row3, run3) {
  if (row3.repo) {
    const origin = await originRepo(row3.repo, run3);
    if ("repo" in origin) return repoFlag(origin.repo);
  }
  const fromUrl = parsePrUrl(row3.pr_url);
  if (!fromUrl) throw new Error(`PR \u94FE\u63A5 ${row3.pr_url} \u89E3\u6790\u4E0D\u51FA owner/repo`);
  return repoFlag(fromUrl);
}

// server/tasks/usage.ts
function ensureUsageTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_usage (
    task_id INTEGER NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
    window_reset_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER, start_percent REAL, points REAL NOT NULL DEFAULT 0,
    basis TEXT NOT NULL CHECK(basis IN ('delta','split','unknown')),
    PRIMARY KEY(task_id,provider,started_at));
    CREATE INDEX IF NOT EXISTS task_usage_window ON task_usage(provider,window_reset_at,started_at);`);
}
var WINDOW_BUCKET_MS = 3e5;
function resetAt(entry, now) {
  const hours = entry.hoursToReset;
  return hours && Number.isFinite(hours) && hours > 0 ? Math.round((now + hours * 36e5) / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS : null;
}
function sameWindow(a, b) {
  return Math.abs(a - b) <= WINDOW_BUCKET_MS;
}
function usageSample(pace, provider2, now) {
  const samples = pace?.filter(
    (p3) => p3.providerId === provider2 && p3.usedPercent !== null && p3.usedPercent !== void 0 && resetAt(p3, now) !== null
  ) ?? [];
  const selected = samples.sort(
    (a, b) => resetAt(a, now) - resetAt(b, now)
  )[0];
  return selected ? { reset: resetAt(selected, now), used: selected.usedPercent } : null;
}
function splitDelta(start, end, concurrent) {
  if (start === null || end === null || end < start || concurrent < 1)
    return { points: 0, basis: "unknown" };
  return {
    points: Math.max(0, end - start) / concurrent,
    basis: concurrent > 1 ? "split" : "delta"
  };
}
function beginUsage(db, taskId, provider2, pace, now = Date.now()) {
  const sample = usageSample(pace, provider2, now);
  db.prepare(
    "INSERT INTO task_usage(task_id,provider,window_reset_at,started_at,start_percent,basis) VALUES(?,?,?,?,?,'unknown')"
  ).run(taskId, provider2, sample?.reset ?? 0, now, sample?.used ?? null);
}
function endUsage(db, taskId, provider2, pace, now = Date.now()) {
  const row3 = one(
    db,
    "SELECT * FROM task_usage WHERE task_id=? AND provider=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    taskId,
    provider2
  );
  if (!row3) return;
  const sample = usageSample(pace, provider2, now);
  const overlap = row3.window_reset_at ? one(
    db,
    "SELECT COUNT(*) AS n FROM task_usage WHERE provider=? AND window_reset_at BETWEEN ? AND ? AND started_at<=? AND (ended_at IS NULL OR ended_at>=?)",
    provider2,
    row3.window_reset_at - WINDOW_BUCKET_MS,
    row3.window_reset_at + WINDOW_BUCKET_MS,
    now,
    row3.started_at
  )?.n ?? 1 : 1;
  const estimate = sample && row3.window_reset_at && sameWindow(sample.reset, row3.window_reset_at) ? splitDelta(row3.start_percent, sample.used, overlap) : { points: 0, basis: "unknown" };
  atomically(
    db,
    () => db.prepare(
      "UPDATE task_usage SET ended_at=?,points=?,basis=? WHERE task_id=? AND provider=? AND started_at=?"
    ).run(
      now,
      estimate.points,
      estimate.basis,
      taskId,
      provider2,
      row3.started_at
    )
  );
}
function subtreeUsage(db, nodeIds, provider2, reset) {
  if (!nodeIds.length) return 0;
  let sum = 0;
  for (let i = 0; i < nodeIds.length; i += 100) {
    const page = nodeIds.slice(i, i + 100);
    const marks = page.map(() => "?").join(",");
    let cursor = 0;
    for (; ; ) {
      const rows = db.prepare(
        `SELECT u.rowid AS id,u.points FROM task_usage u JOIN tasks t ON t.id=u.task_id WHERE t.node_id IN (${marks}) AND u.provider=? AND u.window_reset_at BETWEEN ? AND ? AND u.rowid>? ORDER BY u.rowid LIMIT 200`
      ).all(
        ...page,
        provider2,
        reset - WINDOW_BUCKET_MS,
        reset + WINDOW_BUCKET_MS,
        cursor
      );
      for (const row3 of rows) sum += row3.points;
      if (rows.length < 200) break;
      cursor = rows.at(-1).id;
    }
  }
  return sum;
}

// server/org/model.ts
var ref = (id3) => `o${id3}`;
var one2 = (db, sql, ...args2) => db.prepare(sql).get(...args2);
var all2 = (db, sql, ...args2) => db.prepare(sql).all(...args2);
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function nodes(db) {
  return all2(db, "SELECT * FROM org_nodes ORDER BY id LIMIT 501");
}
function nodeByAddress(db, address) {
  const list4 = nodes(db);
  if (list4.length > 500) throw new Problem(409, "\u7EC4\u7EC7\u6811\u8D85\u8FC7 500 \u4E2A\u8282\u70B9");
  const direct = /^o([1-9][0-9]*)$/.exec(address);
  if (direct) {
    const found = list4.find((n) => n.id === Number(direct[1]));
    if (found) return found;
  }
  const root = list4.find((n) => n.parent_id === null);
  let matches = [];
  if (address.includes("/")) {
    const parts = address.split("/");
    let parent = root;
    if (parts[0] === root?.slug) parts.shift();
    for (const part of parts) {
      parent = list4.find((n) => n.parent_id === parent?.id && n.slug === part);
      if (!parent) break;
    }
    if (parent) matches = [parent];
  } else matches = list4.filter((n) => n.slug === address || n.name === address);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new Problem(
      409,
      `\u8282\u70B9 ${address} \u91CD\u540D\uFF0C\u8BF7\u7528\u77ED\u53F7\uFF1A${matches.map((n) => ref(n.id)).join("\u3001")}`,
      "conflict",
      matches.map((n) => ({ ref: ref(n.id), name: n.name }))
    );
  throw new Problem(
    404,
    `\u8282\u70B9 ${address} \u4E0D\u5B58\u5728`,
    "not_found",
    void 0,
    "atrium org tree"
  );
}
function nodePath(list4, node) {
  const parts = [node.slug];
  let current2 = node;
  while (current2.parent_id !== null) {
    const parent = list4.find((n) => n.id === current2.parent_id);
    if (!parent) break;
    parts.unshift(parent.slug);
    current2 = parent;
  }
  if (parts.length > 1) parts.shift();
  return parts.join("/");
}
function canEdit(list4, node, actor) {
  if (actor === "u1") return true;
  let current2 = node;
  while (current2) {
    if (current2.leader === actor) return true;
    current2 = list4.find((n) => n.id === current2?.parent_id);
  }
  return false;
}

// server/org/task-node.ts
var LEGACY = /^(?:(modules|concerns)\/)?([^/]+?)(?:\.md)?$/;
function hasOrg(db) {
  return !!one2(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'"
  );
}
var trimRepo = (repo) => repo.length > 1 ? repo.replace(/\/+$/, "") : repo;
function coversRepo(list4, repos, node, repo) {
  let current2 = node;
  while (current2) {
    if (repos.get(current2.id)?.includes(repo)) return true;
    const parent = current2.parent_id;
    current2 = list4.find((n) => n.id === parent);
  }
  return false;
}
function repoMap(db) {
  const map = /* @__PURE__ */ new Map();
  for (const row3 of all2(
    db,
    "SELECT node_id,repo FROM org_node_repos ORDER BY node_id LIMIT 5000"
  ))
    map.set(row3.node_id, [...map.get(row3.node_id) ?? [], trimRepo(row3.repo)]);
  return map;
}
function matchLegacyRole(list4, repos, role, repo) {
  const legacy = LEGACY.exec(role.trim());
  if (!legacy) return { node: null, reason: "\u4E0D\u662F\u65E7\u5C97\u4F4D\u540D" };
  const kind = legacy[1] === "modules" ? "module" : legacy[1] === "concerns" ? "concern" : void 0;
  const named2 = list4.filter(
    (n) => n.archived_at === null && n.slug === legacy[2] && (kind ? n.kind === kind : n.kind === "module" || n.kind === "concern")
  );
  if (!named2.length) return { node: null, reason: "\u6CA1\u6709\u540C\u540D\u8282\u70B9" };
  const found = repo ? named2.filter((n) => coversRepo(list4, repos, n, trimRepo(repo))) : named2;
  if (found.length === 1)
    return { node: found[0], path: nodePath(list4, found[0]) };
  if (!found.length)
    return {
      node: null,
      reason: `\u540C\u540D\u8282\u70B9 ${named2.map((n) => ref(n.id)).join("\u3001")} \u90FD\u6CA1\u6709\u6302\u4EFB\u52A1\u4ED3\u5E93`
    };
  return {
    node: null,
    reason: `\u591A\u4E2A\u540C\u540D\u8282\u70B9\uFF1A${found.map((n) => ref(n.id)).join("\u3001")}`
  };
}
function matchRole(db, role, repo, explicit = false) {
  return roleMatcher(db)(role, repo, explicit);
}
function roleMatcher(db) {
  if (!hasOrg(db))
    return (_role, _repo, _explicit = false) => ({
      node: null,
      reason: "\u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811"
    });
  const list4 = nodes(db);
  let repos;
  return (role, repo, explicit = false) => {
    const text6 = role.trim();
    const legacy = /^(?:modules|concerns)\//.test(text6) || !text6.includes("/");
    if (!legacy || /^o[1-9][0-9]*$/.test(text6)) {
      try {
        const node = nodeByAddress(db, text6);
        if (node.archived_at !== null) {
          if (explicit)
            throw new Problem(
              400,
              `role: \u8282\u70B9 ${ref(node.id)} ${node.name} \u5DF2\u5F52\u6863`,
              "usage",
              void 0,
              "atrium org tree"
            );
          return { node: null, reason: `${ref(node.id)} \u5DF2\u5F52\u6863` };
        }
        return { node, path: nodePath(list4, node) };
      } catch (error) {
        if (!(error instanceof Problem)) throw error;
        if (error.message.startsWith("role:")) throw error;
        if (explicit && (error.statusCode !== 404 || /^o\d/.test(text6)))
          throw new Problem(
            400,
            `role: ${error.message}`,
            "usage",
            void 0,
            "atrium org tree"
          );
        if (/^o\d/.test(text6)) return { node: null, reason: error.message };
        return { node: null, reason: "\u6CA1\u6709\u8FD9\u4E2A\u8282\u70B9\u8DEF\u5F84" };
      }
    }
    repos ??= repoMap(db);
    return matchLegacyRole(list4, repos, text6, repo);
  };
}
function originNode(db, address) {
  if (!hasOrg(db))
    throw new Problem(
      400,
      "from: \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811",
      "usage",
      void 0,
      "atrium org import"
    );
  let node;
  try {
    node = nodeByAddress(db, address.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `from: ${error.message}`,
        "usage",
        void 0,
        "atrium org tree"
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw new Problem(
      400,
      `from: \u8282\u70B9 ${ref(node.id)} ${node.name} \u5DF2\u5F52\u6863`,
      "usage"
    );
  return node;
}
function nodeDoc(db, id3) {
  if (!hasOrg(db)) return void 0;
  const node = one2(db, "SELECT * FROM org_nodes WHERE id=?", id3);
  if (!node) return void 0;
  const charter = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    id3
  );
  return { id: id3, ref: ref(id3), name: node.name, body: charter?.body ?? "" };
}
function taskNode(db, task) {
  if (task.node_id !== null) return nodeDoc(db, task.node_id);
  if (!task.role) return void 0;
  const match = matchRole(db, task.role, task.repo);
  return match.node ? nodeDoc(db, match.node.id) : void 0;
}

// server/org/aspects.ts
var APPLIES_MAX = 20;
function ensureAspectColumns(db) {
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has("org_nodes", "aspect"))
    db.exec(
      "ALTER TABLE org_nodes ADD COLUMN aspect INTEGER NOT NULL DEFAULT 0"
    );
  if (!has("org_nodes", "applies"))
    db.exec("ALTER TABLE org_nodes ADD COLUMN applies TEXT");
  if (!has("org_points", "applies"))
    db.exec("ALTER TABLE org_points ADD COLUMN applies TEXT");
}
function parseApplies(value) {
  if (!value) return null;
  try {
    const list4 = JSON.parse(value);
    if (!Array.isArray(list4)) return null;
    const ids = list4.filter(
      (x) => Number.isSafeInteger(x) && x > 0
    );
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}
function pointScope(node, pointApplies) {
  return parseApplies(pointApplies) ?? parseApplies(node.applies) ?? [node.parent_id ?? node.id];
}
function covers(list4, scope, part) {
  const alive4 = new Set(
    scope.filter(
      (id3) => list4.some((n) => n.id === id3 && n.archived_at === null)
    )
  );
  const seen = /* @__PURE__ */ new Set();
  for (let current2 = list4.find((n) => n.id === part); current2 && !seen.has(current2.id); current2 = list4.find((n) => n.id === current2.parent_id)) {
    if (alive4.has(current2.id)) return true;
    seen.add(current2.id);
  }
  return false;
}
function chainIds(list4, part) {
  const out = [];
  for (let current2 = list4.find((n) => n.id === part); current2 && !out.includes(current2.id); current2 = list4.find((n) => n.id === current2.parent_id))
    out.unshift(current2.id);
  return out;
}
function scopeLabel(list4, scope, explicit) {
  const names2 = scope.map((id3) => list4.find((n) => n.id === id3)?.name).filter(Boolean);
  if (!names2.length) return "\u9002\u7528\u8303\u56F4\u5DF2\u5931\u6548";
  return explicit ? `\u9002\u7528\u4E8E${names2.join("\u3001")}` : `\u9002\u7528\u4E8E\u6574\u4E2A${names2[0]}`;
}
function appliedFrom(list4, points, part, also) {
  const chain = new Set(part === null ? [] : chainIds(list4, part));
  const out = [];
  const nodeScope = (n) => ({
    scope: pointScope(n, null),
    explicit: parseApplies(n.applies) !== null
  });
  for (const n of [...list4].sort((a, b) => a.id - b.id)) {
    if (n.archived_at !== null || chain.has(n.id)) continue;
    const own = points.get(n.id) ?? [];
    if (also.includes(n.id)) {
      if (!own.length) continue;
      const { scope, explicit } = nodeScope(n);
      out.push({
        node: ref(n.id),
        name: n.name,
        source: n.aspect ? `${n.name} \xB7 ${scopeLabel(list4, scope, explicit)}` : `${n.name} \xB7 \u672C\u4EFB\u52A1\u7275\u6D89`,
        via: "also",
        points: own.map(strip)
      });
      continue;
    }
    if (!n.aspect || part === null) continue;
    const hit2 = own.filter((p3) => covers(list4, pointScope(n, p3.applies), part));
    if (!hit2.length) continue;
    const partName = list4.find((x) => x.id === part)?.name ?? ref(part);
    out.push({
      node: ref(n.id),
      name: n.name,
      source: `${n.name} \xB7 \u9002\u7528\u4E8E${partName}`,
      via: "auto",
      points: hit2.map(strip)
    });
  }
  return out;
}
var strip = ({ applies: _applies, ...rest }) => rest;
function aspectFacts(db) {
  const list4 = all2(
    db,
    "SELECT id,parent_id,name,archived_at,aspect,applies FROM org_nodes ORDER BY id LIMIT 501"
  );
  const points = /* @__PURE__ */ new Map();
  for (const row3 of all2(
    db,
    "SELECT p.id,p.node_id,p.text,p.why,p.decided_by,p.check_ref,p.applies FROM org_points p JOIN org_nodes n ON n.id=p.node_id WHERE n.archived_at IS NULL ORDER BY p.node_id,p.pos,p.id LIMIT 5000"
  ))
    points.set(row3.node_id, [
      ...points.get(row3.node_id) ?? [],
      {
        ref: `k${row3.id}`,
        text: row3.text,
        why: row3.why,
        by: row3.decided_by,
        check: row3.check_ref,
        applies: row3.applies
      }
    ]);
  return { list: list4, points };
}
function appliedPoints(db, part, also = []) {
  const { list: list4, points } = aspectFacts(db);
  return appliedFrom(list4, points, part, also);
}
function autoInvolved(db, part) {
  return appliedPoints(db, part).filter((l) => l.via === "auto").map((l) => Number(l.node.slice(1)));
}
var usage2 = (message4) => new Problem(400, message4, "usage", void 0, "atrium org tree");
function resolveApplies(db, value, flag = "--applies") {
  if (value === void 0 || value === null || value === "") return null;
  const items = typeof value === "string" ? value.split(/[,，、]/) : Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
  if (!items) throw usage2(`${flag}: \u5E94\u4E3A\u90E8\u5206\u5217\u8868\uFF0C\u5982 o4,o13`);
  const names2 = items.map((s) => s.trim()).filter(Boolean);
  if (!names2.length) return null;
  if (names2.length > APPLIES_MAX)
    throw usage2(`${flag}: \u81F3\u591A ${APPLIES_MAX} \u4E2A\u90E8\u5206`);
  const ids = [];
  for (const name2 of names2) {
    let node;
    try {
      node = nodeByAddress(db, name2);
    } catch (error) {
      if (error instanceof Problem)
        throw new Problem(
          400,
          `${flag}: ${error.message}`,
          "usage",
          error.candidates,
          "atrium org tree"
        );
      throw error;
    }
    if (node.archived_at !== null)
      throw usage2(`${flag}: ${ref(node.id)} ${node.name} \u5DF2\u5F52\u6863`);
    if (!ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}
var appliesText = (ids) => ids && ids.length ? JSON.stringify(ids) : null;
var appliesRefs = (value) => parseApplies(value)?.map(ref) ?? null;
function aspectClearance(nodeApplies, points) {
  return {
    points: points.filter((p3) => parseApplies(p3.applies) !== null).map((p3) => p3.ref),
    node: parseApplies(nodeApplies) !== null
  };
}

// server/org/points.ts
var POINT_LIMITS = { text: 200, why: 300, by: 40, check: 300 };
var POINTS_PER_NODE = 30;
function ensurePointTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    pos INTEGER NOT NULL,
    text TEXT NOT NULL, why TEXT NOT NULL, decided_by TEXT NOT NULL,
    check_ref TEXT, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS org_points_node ON org_points(node_id,pos,id);`);
}
var pointRef = (id3) => `k${id3}`;
var view2 = (row3) => ({
  ref: pointRef(row3.id),
  node: ref(row3.node_id),
  text: row3.text,
  why: row3.why,
  by: row3.decided_by,
  check: row3.check_ref,
  applies: appliesRefs(row3.applies),
  updated_by: row3.updated_by,
  updated_at: row3.updated_at
});
var usage3 = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function validatePoint(input, partial = false) {
  for (const key of Object.keys(input))
    if (!["text", "why", "by", "check", "applies"].includes(key))
      throw usage3(`${key}: \u662F\u672A\u77E5\u5B57\u6BB5`);
  const out = {};
  const field2 = (key, flag, label5) => {
    if (!(key in input)) {
      if (!partial) throw usage3(`${flag}: ${label5}\u5FC5\u586B`);
      return;
    }
    const value = input[key];
    if (typeof value !== "string" || !value.trim())
      throw usage3(`${flag}: ${label5}\u4E0D\u80FD\u4E3A\u7A7A`);
    if (Array.from(value.trim()).length > POINT_LIMITS[key])
      throw usage3(`${flag}: ${label5}\u4E0D\u80FD\u8D85\u8FC7 ${POINT_LIMITS[key]} \u5B57`);
    out[key] = value.trim();
  };
  field2("text", "\u8981\u70B9", "\u8981\u70B9");
  field2("why", "--why", "\u4E3A\u4EC0\u4E48");
  field2("by", "--by", "\u8C01\u5B9A\u7684");
  if ("check" in input) {
    const value = input.check;
    if (value === null || value === "") out.check = null;
    else if (typeof value !== "string")
      throw usage3("--check: \u5E94\u4E3A\u6D4B\u8BD5\u6587\u4EF6\u4E0E\u7528\u4F8B\u540D\uFF0C\u6216 $ \u5F00\u5934\u7684\u547D\u4EE4");
    else if (Array.from(value.trim()).length > POINT_LIMITS.check)
      throw usage3(`--check: \u4E0D\u80FD\u8D85\u8FC7 ${POINT_LIMITS.check} \u5B57`);
    else out.check = value.trim();
  }
  if ("applies" in input) out.applies = input.applies;
  if (partial && !Object.keys(out).length)
    throw usage3("\u81F3\u5C11\u6539\u4E00\u9879\uFF1A\u8981\u70B9\u3001--why\u3001--by\u3001--check\u3001--applies");
  return out;
}
function authorize(db, node, actor) {
  if (node.parent_id === null && actor !== "u1")
    throw new Problem(403, "\u6839\u8282\u70B9\u7684\u8981\u70B9\u53EA\u6709\u4F60\u80FD\u6539");
  if (!canEdit(nodes(db), node, actor))
    throw new Problem(
      403,
      `\u8981\u70B9\u65E0\u6743\u9650\uFF1A${actor} \u4E0D\u662F ${ref(node.id)} \u7684 leader \u6216\u7956\u5148 leader`
    );
  if (node.archived_at !== null)
    throw new Problem(400, `${ref(node.id)} \u5DF2\u5F52\u6863`);
}
function parsePointRef(value) {
  const match = /^k([1-9][0-9]{0,15})$/.exec(value.trim());
  if (!match) throw usage3("\u8981\u70B9\u77ED\u53F7\u5E94\u4E3A k1 \u8FD9\u6837\u7684\u683C\u5F0F");
  return Number(match[1]);
}
function requirePoint(db, value) {
  const id3 = parsePointRef(value);
  const row3 = one2(db, "SELECT * FROM org_points WHERE id=?", id3);
  if (!row3)
    throw new Problem(
      404,
      `\u8981\u70B9 ${pointRef(id3)} \u4E0D\u5B58\u5728`,
      "not_found",
      void 0,
      "atrium org tree"
    );
  return row3;
}
function nodePoints(db, nodeId) {
  return all2(
    db,
    "SELECT * FROM org_points WHERE node_id=? ORDER BY pos,id LIMIT ?",
    nodeId,
    POINTS_PER_NODE
  ).map(view2);
}
function chainPoints(db, nodeId) {
  const list4 = nodes(db);
  const chain = [];
  let current2 = list4.find((n) => n.id === nodeId);
  while (current2) {
    chain.unshift(current2);
    const parent = current2.parent_id;
    current2 = list4.find((n) => n.id === parent);
  }
  return chain.map((n) => ({
    node: ref(n.id),
    name: n.name,
    points: nodePoints(db, n.id)
  })).filter((level) => level.points.length);
}
function addPoint(db, address, body3, actor) {
  const input = validatePoint(objectOf(body3));
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorize(db, node, actor);
    const applies = appliesOf(db, node, input.applies);
    const count2 = one2(
      db,
      "SELECT count(*) AS n, max(pos) AS pos FROM org_points WHERE node_id=?",
      node.id
    );
    if (count2.n >= POINTS_PER_NODE)
      throw new Problem(
        409,
        `${ref(node.id)} \u5DF2\u6709 ${POINTS_PER_NODE} \u6761\u8981\u70B9\uFF0C\u5148\u5220\u6389\u8FC7\u65F6\u7684`,
        "conflict",
        void 0,
        `atrium org show ${ref(node.id)}`
      );
    const id3 = Number(
      db.prepare(
        "INSERT INTO org_points(node_id,pos,text,why,decided_by,check_ref,applies,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).run(
        node.id,
        (count2.pos ?? 0) + 1,
        input.text,
        input.why,
        input.by,
        input.check ?? null,
        applies === void 0 ? null : appliesText(applies),
        actor,
        Date.now()
      ).lastInsertRowid
    );
    return view2(one2(db, "SELECT * FROM org_points WHERE id=?", id3));
  });
}
function editPoint(db, reference, body3, actor) {
  const input = validatePoint(objectOf(body3), true);
  return transaction(db, () => {
    const row3 = requirePoint(db, reference);
    const node = nodeByAddress(db, ref(row3.node_id));
    authorize(db, node, actor);
    const applies = appliesOf(db, node, input.applies);
    db.prepare(
      "UPDATE org_points SET text=?,why=?,decided_by=?,check_ref=?,applies=?,updated_by=?,updated_at=? WHERE id=?"
    ).run(
      input.text ?? row3.text,
      input.why ?? row3.why,
      input.by ?? row3.decided_by,
      input.check === void 0 ? row3.check_ref : input.check,
      applies === void 0 ? row3.applies ?? null : appliesText(applies),
      actor,
      Date.now(),
      row3.id
    );
    return view2(
      one2(db, "SELECT * FROM org_points WHERE id=?", row3.id)
    );
  });
}
function removePoint(db, reference, actor) {
  return transaction(db, () => {
    const row3 = requirePoint(db, reference);
    authorize(db, nodeByAddress(db, ref(row3.node_id)), actor);
    db.prepare("DELETE FROM org_points WHERE id=?").run(row3.id);
    return view2(row3);
  });
}
function appliesOf(db, node, value) {
  if (value === void 0) return void 0;
  const ids = resolveApplies(db, value);
  if (ids && !node.aspect)
    throw usage3(
      `--applies: ${ref(node.id)} ${node.name} \u4E0D\u662F\u7BA1\u65B9\u9762\u7684\u90E8\u5206\uFF1B\u7BA1\u4E1C\u897F\u7684\u90E8\u5206\u7684\u8981\u70B9\u53EA\u5BF9\u672C\u5757\u53CA\u4E0B\u5C42\u751F\u6548`
    );
  return ids;
}
function objectOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usage3("\u8BF7\u6C42\u4F53\u5E94\u4E3A\u5BF9\u8C61");
  return value;
}

// server/org/boundaries.ts
var PARAM_KEYS = [
  "quota_reserve_percent",
  "disk_min_free_gb",
  "money_yuan_max"
];
var MAX_SUMMARY = 80;
var MAX_DETAIL = 500;
var MAX_CHAIN_SUMMARY = 1200;
var MAX_OWN = 40;
var ID = /^[a-z][a-z0-9-]{1,39}$/;
var RANGE = {
  quota_reserve_percent: [0, 100],
  disk_min_free_gb: [0, 1e5],
  money_yuan_max: [0, 1e6]
};
var UNIT = {
  quota_reserve_percent: "%",
  disk_min_free_gb: " GB",
  money_yuan_max: " \u5143"
};
var chars = (value) => Array.from(value).length;
function stricter(key, a, b) {
  return key === "money_yuan_max" ? Math.min(a, b) : Math.max(a, b);
}
function looser(key, candidate, floor) {
  return stricter(key, candidate, floor) !== candidate;
}
function formatParam(param) {
  return `${param.key === "money_yuan_max" ? "\u81F3\u591A" : "\u81F3\u5C11"} ${param.value}${UNIT[param.key]}`;
}
function effective(levels) {
  const out = /* @__PURE__ */ new Map();
  for (const level of levels)
    for (const entry of level.entries) {
      const found = out.get(entry.id);
      if (!found) {
        out.set(entry.id, {
          id: entry.id,
          summary: entry.summary,
          detail: entry.detail,
          param: entry.param,
          from: level.node,
          set_by: level.node
        });
        continue;
      }
      if (found.param && entry.param && entry.param.key === found.param.key && stricter(found.param.key, found.param.value, entry.param.value) !== found.param.value) {
        found.param = { ...found.param, value: entry.param.value };
        found.set_by = level.node;
      }
    }
  return [...out.values()];
}
function summaryLength(list4) {
  return list4.reduce((sum, entry) => sum + chars(entry.summary), 0);
}
function parseBoundaries(value) {
  const problems = [];
  const entries = [];
  if (!Array.isArray(value))
    return {
      entries,
      problems: [{ field: "boundaries", message: "\u5E94\u4E3A\u6761\u76EE\u5217\u8868" }]
    };
  if (value.length > MAX_OWN)
    problems.push({
      field: "boundaries",
      message: `\u672C\u8282\u70B9\u6700\u591A ${MAX_OWN} \u6761`
    });
  value.slice(0, MAX_OWN).forEach((raw, i) => {
    const field2 = `boundaries[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push({ field: field2, message: "\u5E94\u4E3A\u5BF9\u8C61" });
      return;
    }
    const item = raw;
    for (const key of Object.keys(item))
      if (!["id", "summary", "detail", "param"].includes(key))
        problems.push({ field: `${field2}.${key}`, message: "\u662F\u672A\u77E5\u5B57\u6BB5" });
    const id3 = typeof item.id === "string" ? item.id : "";
    const named2 = id3 ? `boundaries.${id3}` : field2;
    if (typeof item.id !== "string")
      problems.push({ field: `${field2}.id`, message: "\u5E94\u4E3A\u6587\u672C" });
    const summary2 = item.summary ?? "";
    if (typeof summary2 !== "string")
      problems.push({ field: `${named2}.summary`, message: "\u5E94\u4E3A\u6587\u672C" });
    const detail2 = item.detail ?? null;
    if (detail2 !== null && typeof detail2 !== "string")
      problems.push({ field: `${named2}.detail`, message: "\u5E94\u4E3A\u6587\u672C" });
    let param = null;
    if (item.param !== void 0 && item.param !== null) {
      const p3 = item.param;
      const keys = p3 && typeof p3 === "object" && !Array.isArray(p3) ? Object.keys(p3) : [];
      const key = keys[0];
      const v = key ? p3[key] : void 0;
      if (keys.length !== 1 || !PARAM_KEYS.includes(key))
        problems.push({
          field: `${named2}.param`,
          message: `\u5E94\u4E3A ${PARAM_KEYS.join("\u3001")} \u4E4B\u4E00\uFF0C\u4E14\u53EA\u5199\u4E00\u4E2A`
        });
      else if (typeof v !== "number" || !Number.isFinite(v) || v < RANGE[key][0] || v > RANGE[key][1])
        problems.push({
          field: `${named2}.param.${key}`,
          message: `\u5E94\u4E3A ${RANGE[key][0]}\u2013${RANGE[key][1]} \u7684\u6570`
        });
      else param = { key, value: v };
    }
    entries.push({
      id: id3,
      summary: typeof summary2 === "string" ? summary2.trim() : "",
      detail: typeof detail2 === "string" ? detail2.trim() || null : null,
      param
    });
  });
  return { entries, problems };
}
function exportBoundaries(entries) {
  return entries.map((e) => ({
    id: e.id,
    ...e.summary ? { summary: e.summary } : {},
    ...e.detail ? { detail: e.detail } : {},
    ...e.param ? { param: { [e.param.key]: e.param.value } } : {}
  }));
}
function checkBoundaries(input) {
  const problems = [];
  const label5 = input.label ?? ((node) => `o${node}`);
  const moving = input.oldChain !== void 0;
  const oldChain = input.oldChain ?? input.chain;
  const inherited = effective(input.chain);
  const oldById = new Map(effective(oldChain).map((e) => [e.id, e]));
  const oldInherited = new Set(oldById.keys());
  const converted = [];
  const byId = new Map(inherited.map((e) => [e.id, e]));
  const seen = /* @__PURE__ */ new Set();
  for (const entry of input.proposed) {
    const field2 = `boundaries.${entry.id || "\uFF08\u7A7A id\uFF09"}`;
    if (!ID.test(entry.id))
      problems.push({
        field: field2,
        message: "id \u53EA\u80FD\u7528\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\u7684\u5C0F\u5199\u82F1\u6570\u4E0E\u8FDE\u5B57\u7B26\uFF0C2\u201340 \u5B57"
      });
    else if (seen.has(entry.id))
      problems.push({ field: field2, message: "id \u5728\u672C\u8282\u70B9\u91CD\u590D" });
    seen.add(entry.id);
    if (chars(entry.summary) > MAX_SUMMARY)
      problems.push({
        field: `${field2}.summary`,
        message: `\u8D85\u8FC7 ${MAX_SUMMARY} \u5B57`
      });
    if (entry.detail && chars(entry.detail) > MAX_DETAIL)
      problems.push({
        field: `${field2}.detail`,
        message: `\u8D85\u8FC7 ${MAX_DETAIL} \u5B57`
      });
  }
  for (const entry of input.proposed) {
    const field2 = `boundaries.${entry.id}`;
    const above = byId.get(entry.id);
    if (!above) {
      const was = oldById.get(entry.id);
      if (!entry.summary && moving && was)
        converted.push({
          node: input.node.node,
          id: entry.id,
          summary: was.summary
        });
      else if (!entry.summary)
        problems.push({ field: `${field2}.summary`, message: "\u4E0D\u80FD\u4E3A\u7A7A" });
      continue;
    }
    if (moving && !oldInherited.has(entry.id)) {
      problems.push({
        field: field2,
        message: `\u79FB\u52A8\u540E\u4E0E\u4E0A\u5C42 ${label5(above.from)} \u7684\u540C\u540D\u6761\u76EE\u51B2\u7A81\uFF0C\u8BF7\u5148\u6539\u540D`
      });
      continue;
    }
    if (!above.param || !entry.param || above.param.key !== entry.param.key) {
      problems.push({
        field: field2,
        message: above.param ? `\u8986\u76D6\u4E0A\u5C42 ${label5(above.from)} \u7684\u6761\u76EE\u53EA\u80FD\u6539\u53C2\u6570 ${above.param.key}` : `\u4E0A\u5C42 ${label5(above.from)} \u7684\u6587\u5B57\u6761\u76EE\u4E0D\u80FD\u540C id \u91CD\u5199\uFF0C\u8981\u6536\u7D27\u5C31\u53E6\u52A0\u65B0\u6761\u76EE`
      });
      continue;
    }
    if (entry.summary && entry.summary !== above.summary)
      problems.push({
        field: `${field2}.summary`,
        message: `\u8986\u76D6\u6761\u76EE\u53EA\u6539\u53C2\u6570\uFF0C\u6587\u5B57\u6CBF\u7528\u4E0A\u5C42 ${label5(above.from)}\uFF0C\u4E0D\u8981\u53E6\u5199`
      });
    const old = input.current.find((e) => e.id === entry.id);
    const changed2 = old?.param?.value !== entry.param.value;
    if (changed2 && looser(above.param.key, entry.param.value, above.param.value))
      problems.push({
        field: field2,
        message: `\u53EA\u80FD\u6536\u7D27\uFF0C\u4E0A\u5C42 ${label5(above.set_by)} \u8981\u6C42${formatParam(above.param)}\uFF0C\u8FD9\u91CC\u5199\u7684\u662F ${entry.param.value}${UNIT[above.param.key]}`
      });
  }
  const self = {
    ...input.node,
    entries: input.proposed.map((e) => {
      const filled = converted.find((c) => c.id === e.id);
      return filled ? { ...e, summary: filled.summary } : e;
    })
  };
  const selfTotal = summaryLength(effective([...input.chain, self]));
  if (selfTotal > MAX_CHAIN_SUMMARY)
    problems.push({
      field: "boundaries",
      message: `\u6574\u6761\u94FE\u7684 summary \u5408\u8BA1 ${selfTotal} \u5B57\uFF0C\u8D85\u8FC7 ${MAX_CHAIN_SUMMARY}`
    });
  const oldSelf = { ...input.node, entries: input.current };
  const oldLevels = /* @__PURE__ */ new Map([
    [input.node.node, [...oldChain, oldSelf]]
  ]);
  const newLevels = /* @__PURE__ */ new Map([
    [input.node.node, [...input.chain, self]]
  ]);
  for (const sub of input.subtree) {
    const oldAbove = oldLevels.get(sub.parent);
    const newAbove = newLevels.get(sub.parent);
    if (!oldAbove || !newAbove) continue;
    const before = effective(oldAbove);
    const beforeIds = new Set(before.map((e) => e.id));
    const after = new Map(effective(newAbove).map((e) => [e.id, e]));
    const beforeSummary = new Map(before.map((e) => [e.id, e.summary]));
    const entries = [];
    for (const entry of sub.entries) {
      const field2 = `boundaries.${entry.id}`;
      const above = after.get(entry.id);
      let next = entry;
      if (above && !beforeIds.has(entry.id))
        problems.push({
          field: field2,
          message: `\u540E\u4EE3 ${label5(sub.node)} \u5DF2\u6709\u540C\u540D\u6761\u76EE\uFF0C\u6362\u4E00\u4E2A id`
        });
      else if (above && (!above.param || !entry.param || above.param.key !== entry.param.key))
        problems.push({
          field: field2,
          message: `\u540E\u4EE3 ${label5(sub.node)} \u4EE5\u53C2\u6570\u8986\u76D6\u6B64\u6761\uFF0C\u8FD9\u91CC\u4E0D\u80FD\u6539\u6210${above.param ? `\u53C2\u6570 ${above.param.key}` : "\u6587\u5B57\u6761\u76EE"}`
        });
      else if (!above && beforeIds.has(entry.id)) {
        const summary2 = entry.summary || beforeSummary.get(entry.id) || entry.id;
        converted.push({ node: sub.node, id: entry.id, summary: summary2 });
        next = { ...entry, summary: summary2 };
      }
      entries.push(next);
    }
    const subLevel = { ...sub, entries };
    oldLevels.set(sub.node, [...oldAbove, sub]);
    newLevels.set(sub.node, [...newAbove, subLevel]);
    const total = summaryLength(effective([...newAbove, subLevel]));
    if (total > MAX_CHAIN_SUMMARY)
      problems.push({
        field: "boundaries",
        message: `\u540E\u4EE3 ${label5(sub.node)} \u7684\u6574\u6761\u94FE summary \u5408\u8BA1\u5C06\u4E3A ${total} \u5B57\uFF0C\u8D85\u8FC7 ${MAX_CHAIN_SUMMARY}`
      });
  }
  return { problems, converted };
}

// server/org/boundary-store.ts
var toBoundary = (row3) => ({
  id: row3.bid,
  summary: row3.summary,
  detail: row3.detail,
  param: row3.param_key && row3.param_value !== null ? { key: row3.param_key, value: row3.param_value } : null
});
function allBoundaries(db) {
  const map = /* @__PURE__ */ new Map();
  for (const row3 of all2(
    db,
    "SELECT node_id,bid,summary,detail,param_key,param_value FROM org_boundaries ORDER BY node_id,pos LIMIT 20000"
  )) {
    const list4 = map.get(row3.node_id) ?? [];
    list4.push(toBoundary(row3));
    map.set(row3.node_id, list4);
  }
  return map;
}
function ownBoundaries(db, node) {
  return all2(
    db,
    "SELECT node_id,bid,summary,detail,param_key,param_value FROM org_boundaries WHERE node_id=? ORDER BY pos LIMIT 100",
    node
  ).map(toBoundary);
}
function chainLevels(list4, owned, parentId) {
  const levels = [];
  let current2 = list4.find((n) => n.id === parentId);
  while (current2) {
    levels.unshift({
      node: current2.id,
      name: current2.name,
      entries: owned.get(current2.id) ?? []
    });
    const parent = current2.parent_id;
    current2 = list4.find((n) => n.id === parent);
  }
  return levels;
}
function subtreeLevels(list4, owned, root) {
  const out = [];
  const visit = (parent) => {
    for (const n of list4.filter((item) => item.parent_id === parent)) {
      out.push({
        node: n.id,
        parent,
        name: n.name,
        entries: owned.get(n.id) ?? []
      });
      visit(n.id);
    }
  };
  visit(root);
  return out;
}
var labeler = (list4) => (id3) => {
  const node = list4.find((n) => n.id === id3);
  return node ? `${ref(id3)} ${node.name}` : ref(id3);
};
function rejectBoundaries(node, what, problems) {
  throw new Problem(
    400,
    `\u62D2\u7EDD\u4FEE\u6539 ${ref(node.id)} ${node.name} \u7684${what}\uFF1A
${problems.map((p3) => `- ${p3.field}\uFF1A${p3.message}`).join("\n")}`,
    "usage",
    void 0,
    `atrium org show ${ref(node.id)} --charter --raw`
  );
}
function saveBoundaries(db, node, entries) {
  db.prepare("DELETE FROM org_boundaries WHERE node_id=?").run(node);
  const insert = db.prepare(
    "INSERT INTO org_boundaries(node_id,bid,pos,summary,detail,param_key,param_value) VALUES(?,?,?,?,?,?,?)"
  );
  entries.forEach(
    (e, i) => insert.run(
      node,
      e.id,
      i,
      e.summary,
      e.detail,
      e.param?.key ?? null,
      e.param?.value ?? null
    )
  );
}
function planBoundaries(db, list4, node, proposed, options = {}) {
  const owned = allBoundaries(db);
  const current2 = owned.get(node.id) ?? [];
  let entries = current2;
  if (proposed !== void 0) {
    const parsed = parseBoundaries(proposed);
    if (parsed.problems.length)
      rejectBoundaries(node, options.what ?? "\u7AE0\u7A0B", parsed.problems);
    const above = new Map(
      effective(chainLevels(list4, owned, node.parent_id)).map((e) => [e.id, e])
    );
    entries = parsed.entries;
    const result2 = check(list4, owned, node, current2, entries, void 0);
    if (result2.problems.length)
      rejectBoundaries(node, options.what ?? "\u7AE0\u7A0B", result2.problems);
    entries = entries.map(
      (e) => above.get(e.id)?.param && e.summary === above.get(e.id).summary ? { ...e, summary: "" } : e
    );
    return { entries, converted: result2.converted };
  }
  if (options.newParent === void 0) return { entries, converted: [] };
  const result = check(list4, owned, node, current2, current2, options.newParent);
  if (result.problems.length)
    rejectBoundaries(node, options.what ?? "\u8282\u70B9", result.problems);
  return { entries, converted: result.converted };
}
function check(list4, owned, node, current2, proposed, newParent) {
  const oldChain = chainLevels(list4, owned, node.parent_id);
  return checkBoundaries({
    chain: newParent === void 0 ? oldChain : chainLevels(list4, owned, newParent),
    ...newParent === void 0 ? {} : { oldChain },
    node: { node: node.id, name: node.name },
    current: current2,
    proposed,
    subtree: subtreeLevels(list4, owned, node.id),
    label: labeler(list4)
  });
}

// server/tasks/gate-parse.ts
function parseNumstat(text6) {
  const stats = [];
  for (const line of text6.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    stats.push({
      file: match[3],
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2])
    });
  }
  return stats;
}
function ciFromChecks(checks) {
  if (!checks.length) return null;
  const buckets = checks.map((check2) => check2.bucket ?? "");
  if (buckets.some((bucket) => bucket === "fail" || bucket === "cancel"))
    return "failure";
  if (buckets.some((bucket) => bucket === "pending")) return "pending";
  return "success";
}
var FUNCTION_START = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+(\w+)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/
];
var KEYWORDS = /* @__PURE__ */ new Set(["if", "for", "while", "switch", "catch", "return"]);
function functionStart(line) {
  for (const pattern of FUNCTION_START) {
    const match = pattern.exec(line);
    if (match && !KEYWORDS.has(match[1] ?? "")) return match[1] || "(\u533F\u540D)";
  }
  return void 0;
}
var braces = (line) => {
  const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "");
  let delta = 0;
  for (const ch of code) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
};
var indent = (line) => /^\s*/.exec(line)[0].length;
function spans(file, lines2) {
  const found = [];
  for (let i = 0; i < lines2.length; i++) {
    const name2 = functionStart(lines2[i]);
    if (name2 === void 0) continue;
    let end = i;
    if (/^\s*(?:async\s+)?def\s/.test(lines2[i])) {
      const base2 = indent(lines2[i]);
      while (end + 1 < lines2.length && (!lines2[end + 1].trim() || indent(lines2[end + 1]) > base2))
        end++;
    } else {
      let depth = 0;
      let opened = false;
      for (let j = i; j < lines2.length; j++) {
        depth += braces(lines2[j]);
        if (lines2[j].includes("{")) opened = true;
        end = j;
        if (opened && depth <= 0) break;
        if (!opened && /[;,]\s*$/.test(lines2[j])) break;
      }
    }
    found.push({ file, name: name2, lines: end - i + 1 });
    i = end;
  }
  return found;
}
function addedFunctions(diff) {
  const result = [];
  let file = "";
  let run3 = [];
  const flush = () => {
    if (file && run3.length) result.push(...spans(file, run3));
    run3 = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      flush();
      file = line.slice(4).replace(/^b\//, "");
      if (file === "/dev/null") file = "";
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      run3.push(line.slice(1));
    } else flush();
  }
  flush();
  return result;
}
function extractClaims(text6) {
  const claims = /* @__PURE__ */ new Map();
  const pr = /(?:\bPR\s*#?\s*|pull request\s*#?\s*|\/pull\/)(\d{1,7})\b/gi;
  for (const match of text6.matchAll(pr))
    claims.set(`pr:${match[1]}`, { kind: "pr", value: match[1] });
  for (const match of text6.matchAll(/(?<![\w/.-])[0-9a-f]{7,40}(?![\w-])/g)) {
    const sha = match[0];
    if (!/[0-9]/.test(sha) || !/[a-f]/.test(sha)) continue;
    claims.set(`commit:${sha}`, { kind: "commit", value: sha });
  }
  return [...claims.values()].slice(0, 20);
}

// server/tasks/ci-classify.ts
var unavailableReason = /\b(?:job was not started|could not be started|spending limit|billing|payment(?:s)? (?:have )?failed|quota|queued? (?:too long|timeout)|waiting for (?:an? )?(?:available )?runner|no (?:hosted |available )?runners? available)\b|计费|付款|配额|排队|额度不足/i;
function actionJob(link) {
  if (!link) return null;
  try {
    const url = new URL(link);
    const match = /^\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(
      url.pathname
    );
    if (url.hostname !== "github.com" || !match) return null;
    return {
      repo: `${match[1]}/${match[2]}`,
      run: match[3],
      job: Number(match[4])
    };
  } catch {
    return null;
  }
}
function annotationSummary(annotation) {
  const message4 = (annotation.message || annotation.title || "").replace(/\s+/g, " ").trim();
  return message4.length > 220 ? `${message4.slice(0, 217)}\u2026` : message4;
}
var ciUnavailableReason = (detail2) => `CI \u672A\u8FD0\u884C\uFF1A${detail2 || "\u68C0\u67E5\u4EFB\u52A1\u672A\u5F00\u59CB"}\uFF0C\u9700\u4EBA\u5DE5\u5904\u7406\u6216\u672C\u5730\u9A8C\u8BC1`;
function classifyCi(checks, observations) {
  const base2 = ciFromChecks(checks);
  if (base2 !== "failure") return { ci: base2 };
  const failing = checks.filter(
    (check2) => check2.bucket === "fail" || check2.bucket === "cancel"
  );
  const unavailable = [];
  const failed = [];
  for (const check2 of failing) {
    const observed = observations.find((item) => item.check === check2);
    const annotation = observed?.annotations?.find(
      (item) => item.annotation_level === "failure" && unavailableReason.test(`${item.title ?? ""} ${item.message ?? ""}`)
    );
    if (annotation || observed?.job && (observed.job.steps?.length === 0 || observed.job.status === "queued")) {
      unavailable.push(
        annotation ? annotationSummary(annotation) : `${check2.name || observed?.job?.name || "\u68C0\u67E5"} job \u672A\u5F00\u59CB\uFF08${observed?.job?.steps?.length === 0 ? "\u96F6\u6B65\u9AA4" : "\u4ECD\u5728\u961F\u5217"}\uFF09`
      );
    } else failed.push(check2.name || "\u672A\u547D\u540D\u68C0\u67E5");
  }
  if (failed.length)
    return { ci: "failure", detail: `\u5931\u8D25\u7684\u68C0\u67E5\uFF1A${failed.join("\u3001")}` };
  return { ci: "unavailable", detail: unavailable[0] };
}

// server/tasks/gates.ts
var GATES = [
  "pr_exists",
  "local_check",
  "ci",
  "finished",
  "file_growth",
  "claims_verified",
  "screenshot",
  "screenshots"
];
function prExists(facts) {
  if (!facts.repo)
    return {
      gate: "pr_exists",
      ok: false,
      evidence: "\u4EFB\u52A1\u6CA1\u6709\u4ED3\u5E93\uFF0C\u65E0\u4ECE\u5F00 PR"
    };
  if (facts.pr)
    return {
      gate: "pr_exists",
      ok: true,
      evidence: `\u5206\u652F ${facts.branch} \u6709 PR\uFF1A${facts.pr.url}\uFF08${facts.pr.state}\uFF09`
    };
  return {
    gate: "pr_exists",
    ok: false,
    evidence: `gh pr list${facts.ghRepo ? ` -R ${facts.ghRepo}` : ""} --head ${facts.branch} \u6CA1\u627E\u5230 PR${facts.prError ? `\uFF1A${facts.prError}` : ""}`
  };
}
function ci(facts) {
  if (!facts.pr)
    return { gate: "ci", ok: false, evidence: "\u6CA1\u6709 PR\uFF0C\u4E5F\u5C31\u6CA1\u6709 CI \u7ED3\u679C" };
  if (facts.ci === "success")
    return { gate: "ci", ok: true, evidence: `CI \u901A\u8FC7\uFF08${facts.pr.url}\uFF09` };
  if (facts.ci === "pending")
    return {
      gate: "ci",
      ok: false,
      pending: true,
      evidence: `CI \u8FD8\u6CA1\u51FA\u7ED3\u679C\uFF08${facts.pr.url}\uFF09\uFF0C\u7531 CI \u8F6E\u8BE2\u8865\u5224`
    };
  if (facts.ci === "unavailable")
    return {
      gate: "ci",
      ok: false,
      unavailable: true,
      evidence: ciUnavailableReason(facts.ciDetail)
    };
  if (facts.ci === "failure")
    return {
      gate: "ci",
      ok: false,
      evidence: `CI \u5931\u8D25\uFF08${facts.pr.url}\uFF09${facts.ciDetail ? `\uFF1A${facts.ciDetail}` : ""}`
    };
  return {
    gate: "ci",
    ok: false,
    evidence: `PR \u4E0A\u6CA1\u6709 CI \u68C0\u67E5${facts.ciDetail ? `\uFF1A${facts.ciDetail}` : ""}`
  };
}
function localCheck(facts) {
  const result = facts.localCheck;
  if (!result)
    return {
      gate: "local_check",
      ok: false,
      evidence: "\u8FD0\u884C\u65F6\u6CA1\u6709\u672C\u5730\u68C0\u67E5\u7ED3\u679C"
    };
  return {
    gate: "local_check",
    ok: result.status === "passed",
    evidence: `\u672C\u5730\u68C0\u67E5${result.status === "passed" ? "\u901A\u8FC7" : "\u672A\u901A\u8FC7"}\uFF1A${result.detail}${result.failedTests.length ? `\uFF1B\u5931\u8D25\u7528\u4F8B\uFF1A${result.failedTests.join("\u3001")}` : ""}\uFF1B\u65E5\u5FD7\uFF1A${result.log}`
  };
}
function finished(facts) {
  if (!facts.repo)
    return { gate: "finished", ok: false, evidence: "\u4EFB\u52A1\u6CA1\u6709\u4ED3\u5E93" };
  const missing = [];
  if (facts.dirty.length)
    missing.push(
      `\u6709 ${facts.dirty.length} \u4E2A\u6587\u4EF6\u672A\u63D0\u4EA4\uFF08${facts.dirty.slice(0, 5).join("\u3001")}\uFF09`
    );
  if (facts.ahead <= 0) missing.push(`\u5206\u652F\u6BD4 origin/${facts.base} \u6CA1\u6709\u65B0\u63D0\u4EA4`);
  if (facts.pushed !== true)
    missing.push(
      `\u672A\u63A8\u9001\u5230 origin${facts.pushDetail ? `\uFF1A${facts.pushDetail}` : ""}`
    );
  if (!facts.pr) missing.push("PR \u6CA1\u5F00");
  return missing.length ? { gate: "finished", ok: false, evidence: `\u6CA1\u6536\u5C3E\uFF1A${missing.join("\uFF1B")}` } : {
    gate: "finished",
    ok: true,
    evidence: `\u5DF2\u63D0\u4EA4 ${facts.ahead} \u4E2A\u63D0\u4EA4\u3001\u5DF2\u63A8\u9001\u3001PR \u5DF2\u5F00`
  };
}
function fileGrowth(facts, limits) {
  const maxFile = limits.max_file_added_lines;
  const maxFunction = limits.max_function_lines;
  const problems = [];
  if (maxFile !== void 0) {
    for (const stat5 of facts.numstat)
      if (stat5.added > maxFile)
        problems.push(`${stat5.file} \u65B0\u589E ${stat5.added} \u884C\uFF08\u4E0A\u9650 ${maxFile}\uFF09`);
  }
  if (maxFunction !== void 0) {
    for (const span of facts.functions)
      if (span.lines > maxFunction)
        problems.push(
          `${span.file} \u7684 ${span.name} \u6709 ${span.lines} \u884C\uFF08\u4E0A\u9650 ${maxFunction}\uFF09`
        );
  }
  if (maxFile === void 0 && maxFunction === void 0)
    return {
      gate: "file_growth",
      ok: true,
      evidence: "\u6863\u6848\u6CA1\u7ED9 limits\uFF0C\u672A\u8BBE\u4E0A\u9650"
    };
  const total = facts.numstat.reduce((sum, stat5) => sum + stat5.added, 0);
  return problems.length ? {
    gate: "file_growth",
    ok: false,
    evidence: problems.slice(0, 10).join("\uFF1B")
  } : {
    gate: "file_growth",
    ok: true,
    evidence: `${facts.numstat.length} \u4E2A\u6587\u4EF6\u5171\u65B0\u589E ${total} \u884C\uFF0C\u672A\u8D85\u9650`
  };
}
function screenshots(facts, gate) {
  if (!facts.pr)
    return { gate, ok: false, evidence: "\u6CA1\u6709 PR\uFF1B\u8BF7\u5F00 PR \u5E76\u5728\u6B63\u6587\u9644\u622A\u56FE" };
  if (!facts.screenshots?.length)
    return {
      gate,
      ok: false,
      evidence: "PR \u6B63\u6587\u6CA1\u6709\u56FE\u7247\uFF1B\u8BF7\u6DFB\u52A0 Markdown \u56FE\u7247\u6216 GitHub \u56FE\u7247\u9644\u4EF6\u94FE\u63A5"
    };
  const bad5 = facts.screenshots.filter((image) => image.status !== 200);
  const showUrl = (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "\u65E0\u6548\u56FE\u7247\u94FE\u63A5";
    }
  };
  return {
    gate,
    ok: bad5.length === 0,
    evidence: bad5.length ? `\u622A\u56FE\u94FE\u63A5 HEAD \u672A\u8FD4\u56DE 200\uFF1A${bad5.map((image) => `${showUrl(image.url)}\uFF08${image.status ?? image.error ?? "\u672A\u68C0\u67E5"}\uFF09`).join("\uFF1B")}` : `PR \u6B63\u6587 ${facts.screenshots.length} \u5F20\u622A\u56FE\u5747\u53EF\u8BBF\u95EE\uFF08HEAD 200\uFF09`
  };
}
function claimsVerified(facts) {
  if (!facts.claims.length)
    return {
      gate: "claims_verified",
      ok: true,
      evidence: "\u6458\u8981\u91CC\u6CA1\u6709\u63D0\u5230 PR \u53F7\u6216\u63D0\u4EA4\u53F7"
    };
  const bad5 = facts.claims.filter((claim) => !claim.ok);
  const label5 = (claim) => claim.kind === "pr" ? `PR #${claim.value}` : `\u63D0\u4EA4 ${claim.value}`;
  return bad5.length ? {
    gate: "claims_verified",
    ok: false,
    evidence: `\u6838\u5BF9\u4E0D\u4E0A\uFF1A${bad5.map((claim) => `${label5(claim)}${claim.detail ? `\uFF08${claim.detail}\uFF09` : ""}`).join("\uFF1B")}`
  } : {
    gate: "claims_verified",
    ok: true,
    evidence: `\u6838\u5BF9\u4E86 ${facts.claims.map(label5).join("\u3001")}\uFF0C\u90FD\u5B58\u5728`
  };
}
function evaluateGates(checks, limits, facts) {
  const results = [...new Set(checks)].map((gate) => {
    switch (gate) {
      case "pr_exists":
        return prExists(facts);
      case "local_check":
        return localCheck(facts);
      case "ci":
        return ci(facts);
      case "finished":
        return finished(facts);
      case "file_growth":
        return fileGrowth(facts, limits);
      case "claims_verified":
        return claimsVerified(facts);
      case "screenshot":
      case "screenshots":
        return screenshots(facts, gate);
      default:
        return {
          gate,
          ok: false,
          evidence: `\u6863\u6848\u91CC\u7684\u5173\u5361 ${gate} \u4E0D\u8BA4\u8BC6\uFF1B\u53EF\u7528 ${GATES.join("\u3001")}`
        };
    }
  });
  const failed = results.filter((result) => !result.ok);
  return {
    results,
    passed: failed.length === 0,
    awaitingCi: failed.length > 0 && failed.every((result) => result.pending),
    failed
  };
}

// server/tasks/adapters/index.ts
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join as join3 } from "node:path";

// server/tasks/adapters/types.ts
import { isAbsolute } from "node:path";
var TOOLS = ["codex", "opencode", "claude", "grok", "kimi"];
var isTool = (value) => typeof value === "string" && TOOLS.includes(value);
var TELL_MODES = ["stdin", "resume", "restart"];
var ARG_PROMPT_MAX_BYTES = 256 * 1024;
var DEFAULT_WATCHDOG = { startupMinutes: 3, idleMinutes: 20 };
var invalid = (message4) => new Problem(400, message4);
function checkArgPrompt(adapter, prompt) {
  if (!prompt.trim()) throw invalid("\u63D0\u793A\u8BCD\u4E3A\u7A7A");
  const limit = adapter.maxPromptBytes ?? ARG_PROMPT_MAX_BYTES;
  const size = Buffer.byteLength(prompt, "utf8");
  if (size > limit)
    throw invalid(
      `${adapter.tool} \u7684\u63D0\u793A\u8BCD\u8D70\u547D\u4EE4\u884C\u53C2\u6570\uFF0C${size} \u5B57\u8282\u8D85\u8FC7\u4E0A\u9650 ${limit}`
    );
}
function checkEffort(adapter, effort) {
  if (effort === void 0) return;
  if (!adapter.efforts) throw invalid(`${adapter.tool} \u4E0D\u652F\u6301\u6307\u5B9A\u601D\u8003\u5F3A\u5EA6`);
  if (!adapter.efforts.includes(effort))
    throw invalid(
      `${adapter.tool} \u7684\u601D\u8003\u5F3A\u5EA6\u53EA\u80FD\u662F ${adapter.efforts.join("\u3001")}`
    );
}
function checkCommon(adapter, input) {
  if (!isAbsolute(input.cwd)) throw invalid("\u5DE5\u4F5C\u76EE\u5F55\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  if (!isAbsolute(input.promptFile)) throw invalid("\u63D0\u793A\u8BCD\u6587\u4EF6\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  if (input.model !== void 0 && !/^[\w.:/@+-]+$/.test(input.model))
    throw invalid(`\u6A21\u578B id \u4E0D\u5408\u6CD5\uFF1A${input.model}`);
  checkEffort(adapter, input.effort);
  if (adapter.promptVia === "arg") checkArgPrompt(adapter, input.prompt);
}

// server/tasks/adapters/claude.ts
var SESSION_RE = /"type":"system","subtype":"init"[^\n]*?"session_id":"([0-9a-f-]{36})"/;
function args(input) {
  const list4 = ["-p", "--output-format", "stream-json", "--verbose"];
  if (input.live)
    list4.push("--input-format", "stream-json", "--replay-user-messages");
  list4.push("--permission-mode", "bypassPermissions");
  if (input.model) list4.push("--model", input.model);
  if (input.effort) list4.push("--effort", input.effort);
  return list4;
}
var claude = {
  tool: "claude",
  executable: "claude",
  promptVia: "stdin",
  defaultModel: "opus",
  exclusive: false,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  quotaProvider: "claude",
  skillMount: "claude-plugin",
  resumeArgs: ["-p", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: ["\u5DE5\u4F5C\u76EE\u5F55\u7531\u8FDB\u7A0B cwd \u51B3\u5B9A\uFF0C\u6CA1\u6709 --cwd \u53C2\u6570"],
  tell: "stdin",
  build(input) {
    checkCommon(claude, input);
    return {
      command: claude.executable,
      args: args(input),
      cwd: input.cwd,
      stdin: input.promptFile,
      ...input.live ? { input: "stream-json" } : {}
    };
  },
  resume(input) {
    checkCommon(claude, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`\u4F1A\u8BDD id \u4E0D\u5408\u6CD5\uFF1A${input.session}`);
    const list4 = args(input);
    list4.splice(1, 0, "--resume", input.session);
    return {
      command: claude.executable,
      args: list4,
      cwd: input.cwd,
      stdin: input.promptFile,
      ...input.live ? { input: "stream-json" } : {}
    };
  },
  sessionOf: (log) => SESSION_RE.exec(log)?.[1]
};

// server/tasks/adapters/codex.ts
import { dirname, join as join2 } from "node:path";
var codex = {
  tool: "codex",
  executable: "codex",
  promptVia: "stdin",
  defaultModel: "gpt-6-sol",
  exclusive: false,
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  quotaProvider: "codex",
  skillMount: "codex-home",
  resumeArgs: ["exec", "resume", "--last"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["\u63D0\u793A\u8BCD\u8D70 stdin\uFF08PROMPT \u5199 -\uFF09\uFF0C\u907F\u514D\u53C2\u6570\u957F\u5EA6\u4E0A\u9650"],
  tell: "resume",
  build(input) {
    checkCommon(codex, input);
    const resultFile = input.resultFile ?? join2(dirname(input.promptFile), "last-message.md");
    const args2 = ["exec", "-C", input.cwd, "-s", "danger-full-access"];
    if (input.model) args2.push("-m", input.model);
    if (input.effort)
      args2.push("-c", `model_reasoning_effort="${input.effort}"`);
    args2.push("-o", resultFile, "-");
    return {
      command: codex.executable,
      args: args2,
      cwd: input.cwd,
      stdin: input.promptFile,
      resultFile
    };
  },
  resume(input) {
    checkCommon(codex, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`\u4F1A\u8BDD id \u4E0D\u5408\u6CD5\uFF1A${input.session}`);
    const resultFile = input.resultFile ?? join2(dirname(input.promptFile), "last-message.md");
    const args2 = ["exec", "resume", "-c", 'sandbox_mode="danger-full-access"'];
    if (input.model) args2.push("-m", input.model);
    if (input.effort)
      args2.push("-c", `model_reasoning_effort="${input.effort}"`);
    args2.push("-o", resultFile, input.session, "-");
    return {
      command: codex.executable,
      args: args2,
      cwd: input.cwd,
      stdin: input.promptFile,
      resultFile
    };
  },
  sessionOf: (log) => /^session id: ([0-9a-f-]{36})$/m.exec(log)?.[1]
};

// server/tasks/adapters/grok.ts
var grok = {
  tool: "grok",
  executable: "grok",
  promptVia: "arg",
  defaultModel: "grok-4.6",
  exclusive: false,
  efforts: ["low", "medium", "high"],
  quotaProvider: "grok",
  resumeArgs: ["--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["grok-4.6 \u6613\u628A\u903B\u8F91\u5806\u8FDB\u4E00\u4E2A\u6587\u4EF6\uFF0C\u9A8C\u6536\u67E5 file_growth"],
  tell: "restart",
  build(input) {
    checkCommon(grok, input);
    const args2 = ["-p", input.prompt];
    if (input.model) args2.push("-m", input.model);
    if (input.effort) args2.push("--reasoning-effort", input.effort);
    args2.push("--always-approve", "--cwd", input.cwd);
    return { command: grok.executable, args: args2, cwd: input.cwd };
  }
};

// server/tasks/adapters/kimi.ts
var kimi = {
  tool: "kimi",
  executable: "kimi",
  promptVia: "arg",
  defaultModel: void 0,
  exclusive: false,
  efforts: void 0,
  quotaProvider: "kimi",
  resumeArgs: ["--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: [
    "\u53EA\u7528 -p\uFF0C\u4E0D\u52A0 -y/--auto",
    "\u9000\u51FA\u65F6\u53EF\u80FD\u6709\u5185\u90E8\u62A5\u9519\u4F46\u6D3B\u5DF2\u5E72\u5B8C\uFF0C\u4EE5\u5B9E\u9645\u4EA7\u7269\u4E3A\u51C6"
  ],
  tell: "restart",
  build(input) {
    checkCommon(kimi, input);
    const args2 = ["-p", input.prompt];
    if (input.model) args2.push("-m", input.model);
    return { command: kimi.executable, args: args2, cwd: input.cwd };
  }
};

// server/tasks/adapters/opencode.ts
var opencode = {
  tool: "opencode",
  executable: "opencode",
  promptVia: "arg",
  defaultModel: "opencode-go/mimo-v2.6-flash",
  // 同一数据目录并发会死锁或 SQLITE_BUSY（上游 anomalyco/opencode#29395、#21215）。
  exclusive: true,
  efforts: ["minimal", "low", "medium", "high", "max"],
  quotaProvider: "opencode",
  skillMount: "opencode-config",
  resumeArgs: ["run", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "cwd \u5FC5\u987B\u662F\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u76EE\u5F55\u5916\u8BBF\u95EE\u4F1A\u88AB\u62D2",
    "\u540C\u4E00\u65F6\u523B\u53EA\u8DD1\u4E00\u4E2A",
    "\u62C9\u8D77\u73AF\u5883\u53BB\u6389 HERDR_*\uFF0C\u5426\u5219\u5361\u5728 init",
    "\u5E38\u505C\u5728\u63D0\u4EA4\u524D\uFF0C\u9A8C\u6536\u67E5 finished"
  ],
  tell: "restart",
  build(input) {
    checkCommon(opencode, input);
    const args2 = ["run", "--format", "json", "--auto"];
    if (input.model) args2.push("-m", input.model);
    if (input.effort) args2.push("--variant", input.effort);
    args2.push("--", input.prompt);
    return { command: opencode.executable, args: args2, cwd: input.cwd };
  }
};

// server/tasks/adapters/index.ts
var ADAPTERS = {
  codex,
  opencode,
  claude,
  grok,
  kimi
};
function findExecutable(name2, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join3(dir, name2);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
    }
  }
  return void 0;
}
function detectInstalled(path = process.env.PATH ?? "") {
  const found = {};
  for (const tool of TOOLS) {
    const file = findExecutable(ADAPTERS[tool].executable, path);
    if (file) found[tool] = file;
  }
  return found;
}

// server/tasks/profiles.ts
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";

// server/tasks/frontmatter.ts
function parseFrontmatter(text6) {
  const source2 = text6.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source2);
  if (!match) return { data: {}, body: source2.trim(), warnings: [] };
  const data2 = {};
  const warnings = [];
  for (const raw of match[1].split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      warnings.push(`\u65E0\u6CD5\u89E3\u6790\u7684\u884C\uFF1A${raw.trim()}`);
      continue;
    }
    data2[pair[1]] = parseValue(pair[2].trim());
  }
  return { data: data2, body: source2.slice(match[0].length).trim(), warnings };
}
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1])))
      return line.slice(0, i);
  }
  return line;
}
function parseValue(value) {
  if (value.startsWith("[") && value.endsWith("]"))
    return splitTop(value.slice(1, -1)).map(parseValue);
  if (value.startsWith("{") && value.endsWith("}")) {
    const out = {};
    for (const item of splitTop(value.slice(1, -1))) {
      const at = item.indexOf(":");
      if (at <= 0) continue;
      out[unquote(item.slice(0, at).trim())] = parseValue(
        item.slice(at + 1).trim()
      );
    }
    return out;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return unquote(value);
}
function splitTop(inner2) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < inner2.length; i++) {
    const ch = inner2[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner2.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner2.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
    return value.slice(1, -1);
  return value;
}

// server/tasks/worker-profiles.ts
import { lstatSync, readdirSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
var PROFILE_LAYERS = ["harness", "models", "combos"];
var isProfileLayer = (value) => typeof value === "string" && PROFILE_LAYERS.includes(value);
var PROFILE_MAX_BYTES = 64 * 1024;
var NAME_RE = /^[\w.@-]+$/;
function ensureWorkerProfiles(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_profiles (
      layer TEXT NOT NULL CHECK(layer IN ('harness','models','combos')),
      name TEXT NOT NULL, source TEXT NOT NULL, rev INTEGER NOT NULL,
      updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(layer,name));
    CREATE TABLE IF NOT EXISTS worker_profile_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL,
      author TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL,
      UNIQUE(layer,name,rev));
    CREATE TABLE IF NOT EXISTS worker_profile_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dir TEXT NOT NULL, at INTEGER NOT NULL,
      imported INTEGER NOT NULL, skipped TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS worker_profile_revisions_no_update
      BEFORE UPDATE ON worker_profile_revisions BEGIN SELECT RAISE(ABORT,'worker_profile_revisions append only'); END;
    CREATE TRIGGER IF NOT EXISTS worker_profile_revisions_no_delete
      BEFORE DELETE ON worker_profile_revisions BEGIN SELECT RAISE(ABORT,'worker_profile_revisions append only'); END;`);
}
function profileNameProblem(layer, name2) {
  if (layer === "harness")
    return isTool(name2) ? null : `\u5DE5\u5177\u5C42\u6863\u6848\u540D\u987B\u662F ${TOOLS.join("\u3001")} \u4E4B\u4E00`;
  if (layer === "models")
    return NAME_RE.test(name2) && !name2.startsWith(".") ? null : "\u6A21\u578B\u5C42\u6863\u6848\u540D\u987B\u662F\u6A21\u578B\u540D\u6700\u540E\u4E00\u6BB5\uFF0C\u5982 gpt-6-sol";
  const plus = name2.indexOf("+");
  const tool = name2.slice(0, plus);
  const model = name2.slice(plus + 1);
  return plus > 0 && isTool(tool) && NAME_RE.test(model) && !model.startsWith(".") ? null : "\u7EC4\u5408\u5C42\u6863\u6848\u540D\u987B\u662F \u5DE5\u5177+\u6A21\u578B\u540D\uFF0C\u5982 codex+gpt-6-sol";
}
function parseProfileRef(value) {
  const slash = value.indexOf("/");
  const layer = value.slice(0, slash);
  const name2 = value.slice(slash + 1);
  if (slash < 0 || !isProfileLayer(layer))
    throw new Problem(
      400,
      `\u6863\u6848\u5E94\u5199\u6210 \u5C42/\u540D\uFF0C\u5C42\u662F ${PROFILE_LAYERS.join("\u3001")}\uFF0C\u5982 harness/codex`,
      "usage"
    );
  const problem = profileNameProblem(layer, name2);
  if (problem) throw new Problem(400, problem, "usage");
  return { layer, name: name2 };
}
function readProfile(db, layer, name2) {
  return one(
    db,
    "SELECT layer,name,source,rev,updated_by,updated_at FROM worker_profiles WHERE layer=? AND name=?",
    layer,
    name2
  );
}
function listProfiles(db) {
  return all(
    db,
    "SELECT layer,name,source,rev,updated_by,updated_at FROM worker_profiles ORDER BY CASE layer WHEN 'harness' THEN 0 WHEN 'models' THEN 1 ELSE 2 END, name LIMIT 500"
  );
}
function profileHistory(db, layer, name2, limit = 20) {
  return all(
    db,
    "SELECT rev,author,at,reason,source FROM worker_profile_revisions WHERE layer=? AND name=? ORDER BY rev DESC LIMIT ?",
    layer,
    name2,
    Math.max(1, Math.min(limit, 200))
  );
}
function sourceProblems(source2) {
  const problems = [];
  if (Buffer.byteLength(source2, "utf8") > PROFILE_MAX_BYTES)
    problems.push(`\u6863\u6848\u8D85\u8FC7 ${PROFILE_MAX_BYTES / 1024} KB\uFF0C\u8BF7\u7CBE\u7B80`);
  if (source2.includes("\0")) problems.push("\u6863\u6848\u542B\u7A7A\u5B57\u7B26");
  return problems;
}
function writeProfile(db, input) {
  return atomically(db, () => {
    const current2 = readProfile(db, input.layer, input.name);
    if (current2 && current2.source === input.source)
      return { rev: current2.rev, changed: false, created: false };
    const rev2 = (current2?.rev ?? 0) + 1;
    const at = input.at ?? Date.now();
    db.prepare(
      `INSERT INTO worker_profiles(layer,name,source,rev,updated_by,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(layer,name) DO UPDATE SET source=excluded.source,rev=excluded.rev,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at`
    ).run(input.layer, input.name, input.source, rev2, input.author, at);
    db.prepare(
      "INSERT INTO worker_profile_revisions(layer,name,rev,author,at,reason,source) VALUES(?,?,?,?,?,?,?)"
    ).run(
      input.layer,
      input.name,
      rev2,
      input.author,
      at,
      input.reason,
      input.source
    );
    return { rev: rev2, changed: true, created: !current2 };
  });
}
function patchFront(source2, key, value) {
  const text6 = source2.replace(/\r\n?/g, "\n");
  if (!text6.startsWith("---\n"))
    return value === void 0 ? text6 : `---
${key}: ${value}
---
${text6 ? `
${text6}` : ""}`;
  const end = text6.indexOf("\n---", 3);
  if (end < 0)
    throw new Problem(409, "\u6267\u884C\u8005\u6863\u6848 frontmatter \u4E0D\u5B8C\u6574", "conflict");
  const head2 = end === 3 ? [] : text6.slice(4, end).split("\n");
  const at = head2.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (value === void 0) {
    if (at >= 0) head2.splice(at, 1);
  } else if (at >= 0) head2[at] = `${key}: ${value}`;
  else head2.push(`${key}: ${value}`);
  return `---
${head2.length ? `${head2.join("\n")}
` : ""}---${text6.slice(end + 4)}`;
}
var profilesImported = (db) => !!one(db, "SELECT 1 AS ok FROM worker_profile_imports LIMIT 1");
function importWorkerProfiles(db, dir, log = console.warn) {
  if (!dir || profilesImported(db)) return null;
  let top;
  try {
    top = lstatSync(dir);
  } catch {
    return null;
  }
  if (!top.isDirectory()) return null;
  const result = { dir, imported: 0, skipped: [] };
  const skip = (file, reason) => {
    result.skipped.push({ file, reason });
    log(`\u6267\u884C\u8005\u6863\u6848 ${file} \u672A\u5BFC\u5165\uFF1A${reason}`);
  };
  const at = Date.now();
  for (const layer of PROFILE_LAYERS) {
    const sub = join4(dir, layer);
    let names2;
    try {
      if (!lstatSync(sub).isDirectory()) continue;
      names2 = readdirSync(sub).sort();
    } catch {
      continue;
    }
    for (const entry of names2) {
      if (!entry.endsWith(".md")) continue;
      const file = join4(sub, entry);
      const name2 = entry.slice(0, -3);
      const problem = profileNameProblem(layer, name2);
      if (problem) {
        skip(file, problem);
        continue;
      }
      let source2;
      try {
        const stat5 = lstatSync(file);
        if (!stat5.isFile()) {
          skip(file, "\u4E0D\u662F\u666E\u901A\u6587\u4EF6");
          continue;
        }
        if (stat5.size > PROFILE_MAX_BYTES) {
          skip(file, `\u8D85\u8FC7 ${PROFILE_MAX_BYTES / 1024} KB`);
          continue;
        }
        source2 = readFileSync2(file, "utf8");
      } catch (error) {
        skip(file, `\u8BFB\u4E0D\u4E86\uFF1A${error.message}`);
        continue;
      }
      const problems = sourceProblems(source2);
      if (problems.length) {
        skip(file, problems.join("\uFF1B"));
        continue;
      }
      if (readProfile(db, layer, name2)) continue;
      writeProfile(db, {
        layer,
        name: name2,
        source: source2,
        author: "import",
        reason: `\u4ECE ${file} \u5BFC\u5165`,
        at
      });
      result.imported++;
    }
  }
  db.prepare(
    "INSERT INTO worker_profile_imports(dir,at,imported,skipped) VALUES(?,?,?,?)"
  ).run(dir, at, result.imported, JSON.stringify(result.skipped));
  if (result.imported || result.skipped.length)
    log(
      `\u6267\u884C\u8005\u6863\u6848\u5DF2\u4ECE ${dir} \u5BFC\u5165 ${result.imported} \u4EFD${result.skipped.length ? `\uFF0C\u8DF3\u8FC7 ${result.skipped.length} \u4EFD` : ""}\uFF1B\u6B64\u540E\u53EA\u8BFB\u6570\u636E\u5E93`
    );
  return result;
}

// server/tasks/profiles.ts
var RISKS = ["low", "medium", "high"];
var isRisk = (value) => typeof value === "string" && RISKS.includes(value);
var TRUSTS = ["unknown", "low", "medium", "high"];
var isTrust = (value) => typeof value === "string" && TRUSTS.includes(value);
var DEFAULT_WORKERS_DIR = join5(homedir2(), "Atrium", "workers");
var MODEL_RE = /^[\w.@-]+(\/[\w.@-]+)*$/;
var EFFORT_RE = /^[a-z]+$/;
function parseWorker(value) {
  const text6 = value.trim();
  const plus = text6.indexOf("+");
  const head2 = plus < 0 ? text6 : text6.slice(0, plus);
  let rest = plus < 0 ? "" : text6.slice(plus + 1);
  let effort;
  let tool = head2;
  const colon = (plus < 0 ? head2 : rest).lastIndexOf(":");
  if (colon >= 0) {
    if (plus < 0) {
      effort = head2.slice(colon + 1);
      tool = head2.slice(0, colon);
    } else {
      effort = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  if (!isTool(tool))
    throw invalid(
      `\u672A\u77E5\u7684\u6267\u884C\u8005\u5DE5\u5177\uFF1A${tool || "\uFF08\u7A7A\uFF09"}\uFF0C\u53EF\u9009 ${TOOLS.join("\u3001")}`
    );
  if (plus >= 0 && !MODEL_RE.test(rest))
    throw invalid(`\u6267\u884C\u8005\u6A21\u578B\u4E0D\u5408\u6CD5\uFF1A${rest || "\uFF08\u7A7A\uFF09"}`);
  if (plus >= 0 && rest.split("/").some((seg) => seg.startsWith(".")))
    throw invalid(`\u6267\u884C\u8005\u6A21\u578B\u4E0D\u5408\u6CD5\uFF1A${rest}`);
  if (effort !== void 0 && !EFFORT_RE.test(effort))
    throw invalid(`\u601D\u8003\u5F3A\u5EA6\u4E0D\u5408\u6CD5\uFF1A${effort || "\uFF08\u7A7A\uFF09"}`);
  return { tool, model: plus >= 0 ? rest : void 0, effort };
}
var workerId = (spec) => `${spec.tool}${spec.model ? `+${spec.model}` : ""}${spec.effort ? `:${spec.effort}` : ""}`;
var modelKey = (model) => model.slice(model.lastIndexOf("/") + 1);
function splitDeliveryNotes(body3) {
  const lines2 = body3.split("\n");
  const start = lines2.findIndex((line) => /^#{1,6}\s*交付记录\s*$/.test(line));
  if (start < 0) return { body: body3, notes: "" };
  const level = /^#+/.exec(lines2[start])[0].length;
  let end = start + 1;
  while (end < lines2.length) {
    const heading = /^(#{1,6})\s/.exec(lines2[end]);
    if (heading && heading[1].length <= level) break;
    end++;
  }
  return {
    body: [...lines2.slice(0, start), ...lines2.slice(end)].join("\n").trim(),
    notes: lines2.slice(start + 1, end).join("\n").trim()
  };
}
function parseProfileSource(source2) {
  const parsed = parseFrontmatter(source2);
  const { rules, warnings } = normalizeRules(parsed.data);
  return {
    rules,
    ...splitDeliveryNotes(parsed.body),
    warnings: [...parsed.warnings, ...warnings]
  };
}
function readLayer(db, layer, name2) {
  const stored = db && readProfile(db, layer, name2);
  if (!stored) return void 0;
  const file = `${layer}/${name2}`;
  const parsed = parseProfileSource(stored.source);
  return {
    layer,
    file,
    rev: stored.rev,
    rules: parsed.rules,
    body: parsed.body,
    notes: parsed.notes,
    warnings: parsed.warnings.map((w) => `${file}\uFF1A${w}`)
  };
}
function normalizeRules(data2) {
  const rules = {};
  const warnings = [];
  for (const [key, value] of Object.entries(data2)) {
    if (key === "trust") {
      if (isTrust(value)) rules.trust = value;
      else warnings.push(`trust \u53EA\u80FD\u662F ${TRUSTS.join("\u3001")}`);
    } else if (key === "max_risk") {
      if (isRisk(value)) rules.max_risk = value;
      else warnings.push(`max_risk \u53EA\u80FD\u662F ${RISKS.join("\u3001")}`);
    } else if (key === "billing") {
      if (value === "subscription" || value === "metered")
        rules.billing = value;
      else warnings.push("billing \u53EA\u80FD\u662F subscription \u6216 metered");
    } else if (key === "checks") {
      const list4 = Array.isArray(value) ? value : [value];
      rules.checks = list4.filter(
        (item) => typeof item === "string"
      );
    } else if (key === "limits") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rules.limits = {};
        for (const [name2, n] of Object.entries(value))
          if (typeof n === "number" && Number.isFinite(n))
            rules.limits[name2] = n;
          else warnings.push(`limits.${name2} \u987B\u4E3A\u6570\u5B57`);
      } else warnings.push("limits \u987B\u4E3A {\u952E: \u6570\u5B57}");
    } else if (key === "model") {
      if (typeof value === "string" && MODEL_RE.test(value))
        rules.model = value;
      else warnings.push("model \u4E0D\u5408\u6CD5");
    } else if (key === "tell") {
      if (TELL_MODES.includes(value))
        rules.tell = value;
      else warnings.push(`tell \u53EA\u80FD\u662F ${TELL_MODES.join("\u3001")}`);
    } else rules[key] = value;
  }
  return { rules, warnings };
}
var lower = (order, a, b) => a === void 0 ? b : b === void 0 ? a : order.indexOf(a) <= order.indexOf(b) ? a : b;
var strings = (value) => (Array.isArray(value) ? value : value === void 0 ? [] : [value]).filter(
  (item) => typeof item === "string"
);
var union = (a, b) => [
  .../* @__PURE__ */ new Set([...strings(a), ...strings(b)])
];
var mapOf = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function mergeLayers(layers) {
  let rules = {};
  for (const { rules: next } of layers) {
    const merged = { ...rules, ...next };
    merged.trust = lower(TRUSTS, rules.trust, next.trust);
    merged.max_risk = lower(RISKS, rules.max_risk, next.max_risk);
    if (rules.billing === "metered" || next.billing === "metered")
      merged.billing = "metered";
    if (rules.checks || next.checks)
      merged.checks = [
        .../* @__PURE__ */ new Set([...rules.checks ?? [], ...next.checks ?? []])
      ];
    if (rules.limits || next.limits) {
      const limits = { ...rules.limits };
      for (const [name2, n] of Object.entries(next.limits ?? {}))
        limits[name2] = name2 in limits ? Math.min(limits[name2], n) : n;
      merged.limits = limits;
    }
    for (const key of ["skills", "avoid_nodes"])
      if (rules[key] !== void 0 || next[key] !== void 0)
        merged[key] = union(rules[key], next[key]);
    if (rules.skills_for !== void 0 || next.skills_for !== void 0) {
      const scoped2 = { ...mapOf(rules.skills_for) };
      for (const [node, slugs] of Object.entries(mapOf(next.skills_for)))
        scoped2[node] = union(scoped2[node], slugs);
      merged.skills_for = scoped2;
    }
    for (const key of Object.keys(merged))
      if (merged[key] === void 0) delete merged[key];
    rules = merged;
  }
  return {
    rules,
    body: layers.map((layer) => layer.body).filter(Boolean).join("\n\n"),
    layers,
    warnings: layers.flatMap((layer) => layer.warnings)
  };
}
async function resolveWorker(value, db) {
  const spec = typeof value === "string" ? parseWorker(value) : value;
  const harness = readLayer(db, "harness", spec.tool);
  const model = spec.model ?? harness?.rules.model ?? ADAPTERS[spec.tool].defaultModel;
  const layers = harness ? [harness] : [];
  if (model) {
    const key = modelKey(model);
    const models = readLayer(db, "models", key);
    const combos = readLayer(db, "combos", `${spec.tool}+${key}`);
    for (const layer of [models, combos]) if (layer) layers.push(layer);
  }
  const profile = mergeLayers(layers);
  const layerModel = [...layers].reverse().find((layer) => layer.layer !== "harness" && layer.rules.model)?.rules.model;
  const cliModel = layerModel ?? model;
  if (cliModel) profile.rules.model = cliModel;
  else delete profile.rules.model;
  const resolved = { tool: spec.tool, model, effort: spec.effort };
  return {
    ...resolved,
    cliModel,
    id: workerId(resolved),
    profile
  };
}

// server/tasks/job-roles.ts
var view3 = (r) => ({
  ...r,
  ref: `r${r.id}`,
  part_id: r.part_id ?? null,
  part: r.part_id ? `o${r.part_id}` : null,
  part_name: r.part_name ?? null,
  preferred: JSON.parse(r.preferred),
  checks: JSON.parse(r.checks),
  skills: JSON.parse(r.skills),
  review_points: JSON.parse(r.review_points),
  review_bottom: JSON.parse(r.review_bottom),
  invite_when: JSON.parse(r.invite_when)
});
var bad = (message4) => {
  throw new Problem(400, message4, "usage");
};
function ensureJobRoles(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL, body TEXT NOT NULL, preferred TEXT NOT NULL, checks TEXT NOT NULL, skills TEXT NOT NULL, rev INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS job_role_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES job_roles(id), rev INTEGER NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(role_id,rev));
  CREATE INDEX IF NOT EXISTS job_role_revisions_role ON job_role_revisions(role_id,rev);
  CREATE TRIGGER IF NOT EXISTS job_role_revisions_no_update BEFORE UPDATE ON job_role_revisions BEGIN SELECT RAISE(ABORT,'job role revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS job_role_revisions_no_delete BEFORE DELETE ON job_role_revisions BEGIN SELECT RAISE(ABORT,'job role revisions append only'); END;`);
  const columns = db.prepare("PRAGMA table_info(job_roles)").all();
  for (const [name2, definition] of [
    ["review_goal", "TEXT NOT NULL DEFAULT ''"],
    ["review_points", "TEXT NOT NULL DEFAULT '[]'"],
    ["review_bottom", "TEXT NOT NULL DEFAULT '[]'"],
    ["invite_when", "TEXT NOT NULL DEFAULT '[]'"],
    // 专员归属（#373）：指向 org_nodes.id；旧专员留空，即全组织共用，行为不变。
    ["part_id", "INTEGER"]
  ])
    if (!columns.some((column) => column.name === name2))
      db.exec(`ALTER TABLE job_roles ADD COLUMN ${name2} ${definition}`);
}
var required = (value, flag, max) => {
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    bad(`${flag} \u5E94\u4E3A 1\u2013${max} \u5B57\u7684\u6587\u5B57`);
  return value.trim();
};
var list = (value, flag) => {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((x) => typeof x !== "string" || !x.trim()))
    bad(`${flag} \u5E94\u4E3A\u4E0D\u8D85\u8FC7 20 \u9879\u7684\u6587\u5B57\u5217\u8868`);
  return [...new Set(value.map((x) => x.trim()))];
};
function values(db, input, previous) {
  const name2 = required(input.name ?? previous?.name, "name", 100);
  const description = required(
    input.description ?? previous?.description,
    "description",
    500
  );
  const body3 = required(input.body ?? previous?.body, "body", 16e3);
  const preferred = input.preferred === void 0 ? previous?.preferred ?? [] : list(input.preferred, "preferred");
  for (const worker of preferred) {
    const spec = parseWorker(worker);
    checkEffort(ADAPTERS[spec.tool], spec.effort);
  }
  const checks = input.checks === void 0 ? previous?.checks ?? [] : list(input.checks, "checks");
  for (const check2 of checks)
    if (!GATES.includes(check2))
      bad(`checks: \u672A\u77E5\u9A8C\u6536\u5173\u5361 ${check2}`);
  const skills = input.skills === void 0 ? previous?.skills ?? [] : list(input.skills, "skills");
  for (const slug of skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      bad(`skills: \u6280\u80FD\u540D\u4E0D\u5408\u6CD5 ${slug}`);
    if (!one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_skills'"
    ) || !one(
      db,
      "SELECT 1 FROM org_skills WHERE slug=? AND archived_at IS NULL",
      slug
    ))
      bad(`skills: \u6280\u80FD ${slug} \u4E0D\u5B58\u5728`);
  }
  const review_goal = input.review_goal === void 0 ? previous?.review_goal ?? "" : typeof input.review_goal === "string" && input.review_goal.length <= 300 ? input.review_goal.trim() : bad("review_goal \u5E94\u4E3A\u4E0D\u8D85\u8FC7 300 \u5B57\u7684\u6587\u5B57");
  const review_points = input.review_points === void 0 ? previous?.review_points ?? [] : Array.isArray(input.review_points) && input.review_points.length <= 30 && input.review_points.every(
    (p3) => p3 && typeof p3 === "object" && typeof p3.ref === "string" && typeof p3.text === "string" && typeof p3.why === "string"
  ) ? input.review_points : bad("review_points \u5E94\u4E3A\u4E0D\u8D85\u8FC7 30 \u6761\u68C0\u67E5\u8981\u70B9");
  const review_bottom = input.review_bottom === void 0 ? previous?.review_bottom ?? [] : list(input.review_bottom, "review_bottom");
  const invite_when = input.invite_when === void 0 ? previous?.invite_when ?? [] : list(input.invite_when, "invite_when");
  const part_id = input.part === void 0 ? previous?.part_id ?? null : partOf(db, input.part);
  return {
    name: name2,
    part_id,
    description,
    body: body3,
    preferred,
    checks,
    skills,
    review_goal,
    review_points,
    review_bottom,
    invite_when
  };
}
function partOf(db, value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return bad("part \u5E94\u4E3A\u90E8\u5206\uFF08o20 \u6216\u540D\u79F0\uFF09");
  if (!one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'"
  ))
    return bad("part: \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811");
  let node;
  try {
    node = nodeByAddress(db, value.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `part: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree"
      );
    throw error;
  }
  if (node.archived_at !== null)
    return bad(`part: ${node.name}\uFF08o${node.id}\uFF09\u5DF2\u5F52\u6863`);
  return node.id;
}
function inputOf(body3) {
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    bad("\u4E13\u5458\u5B57\u6BB5\u5E94\u4E3A JSON \u5BF9\u8C61");
  const input = body3;
  if (Object.keys(input).some(
    (key) => ![
      "name",
      "description",
      "body",
      "preferred",
      "checks",
      "skills",
      "review_goal",
      "review_points",
      "review_bottom",
      "invite_when",
      "part",
      "author"
    ].includes(key)
  ))
    bad("\u4E13\u5458\u542B\u4E0D\u652F\u6301\u7684\u5B57\u6BB5");
  return input;
}
function author(input) {
  return input.author === void 0 ? "u1" : required(input.author, "author", 100);
}
var hasOrgNodes = (db) => !!one(
  db,
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'"
);
var SELECT = (db) => hasOrgNodes(db) ? "SELECT j.*, n.name AS part_name FROM job_roles j LEFT JOIN org_nodes n ON n.id=j.part_id" : "SELECT j.*, NULL AS part_name FROM job_roles j";
function listJobRoles(db) {
  return all(db, `${SELECT(db)} ORDER BY j.id LIMIT 200`).map((row3) => ({
    ...view3(row3),
    running: one(
      db,
      "SELECT COUNT(*) n FROM tasks WHERE job_id=? AND status='running'",
      row3.id
    )?.n ?? 0
  }));
}
function getJobRole(db, reference) {
  const text6 = String(reference ?? "").trim();
  const r = /^r([1-9]\d*)$/.exec(text6);
  const row3 = r ? one(db, `${SELECT(db)} WHERE j.id=?`, Number(r[1])) : one(db, `${SELECT(db)} WHERE j.name=? COLLATE NOCASE`, text6);
  if (!row3)
    throw new Problem(404, `\u4E13\u5458 ${text6 || "\uFF08\u7A7A\uFF09"} \u4E0D\u5B58\u5728`, "not_found");
  return view3(row3);
}
function createJobRole(db, body3, now = Date.now()) {
  const input = inputOf(body3), data2 = values(db, input);
  return atomically(db, () => {
    if (one(db, "SELECT 1 FROM job_roles WHERE name=? COLLATE NOCASE", data2.name))
      bad(`\u4E13\u5458\u540D\u79F0\u5DF2\u5B58\u5728\uFF1A${data2.name}`);
    const id3 = Number(
      db.prepare(
        "INSERT INTO job_roles(name,part_id,description,body,preferred,checks,skills,review_goal,review_points,review_bottom,invite_when,rev,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)"
      ).run(
        data2.name,
        data2.part_id,
        data2.description,
        data2.body,
        JSON.stringify(data2.preferred),
        JSON.stringify(data2.checks),
        JSON.stringify(data2.skills),
        data2.review_goal,
        JSON.stringify(data2.review_points),
        JSON.stringify(data2.review_bottom),
        JSON.stringify(data2.invite_when),
        now,
        now
      ).lastInsertRowid
    );
    const role = getJobRole(db, `r${id3}`);
    db.prepare(
      "INSERT INTO job_role_revisions(role_id,rev,at,author,snapshot) VALUES (?,1,?,?,?)"
    ).run(id3, now, author(input), JSON.stringify(role));
    return role;
  });
}
function editJobRole(db, reference, body3, now = Date.now()) {
  const input = inputOf(body3);
  return atomically(db, () => {
    const old = getJobRole(db, reference), data2 = values(db, input, old);
    if (one(
      db,
      "SELECT id FROM job_roles WHERE name=? COLLATE NOCASE AND id<>?",
      data2.name,
      old.id
    ))
      bad(`\u4E13\u5458\u540D\u79F0\u5DF2\u5B58\u5728\uFF1A${data2.name}`);
    db.prepare(
      "UPDATE job_roles SET name=?,part_id=?,description=?,body=?,preferred=?,checks=?,skills=?,review_goal=?,review_points=?,review_bottom=?,invite_when=?,rev=rev+1,updated_at=? WHERE id=?"
    ).run(
      data2.name,
      data2.part_id,
      data2.description,
      data2.body,
      JSON.stringify(data2.preferred),
      JSON.stringify(data2.checks),
      JSON.stringify(data2.skills),
      data2.review_goal,
      JSON.stringify(data2.review_points),
      JSON.stringify(data2.review_bottom),
      JSON.stringify(data2.invite_when),
      now,
      old.id
    );
    const role = getJobRole(db, `r${old.id}`);
    db.prepare(
      "INSERT INTO job_role_revisions(role_id,rev,at,author,snapshot) VALUES (?,?,?,?,?)"
    ).run(role.id, role.rev, now, author(input), JSON.stringify(role));
    return role;
  });
}
function jobRoleHistory(db, reference) {
  const role = getJobRole(db, reference);
  return all(
    db,
    "SELECT rev,at,author,snapshot FROM job_role_revisions WHERE role_id=? ORDER BY rev DESC LIMIT 100",
    role.id
  ).map((row3) => ({ ...row3, snapshot: JSON.parse(row3.snapshot) }));
}

// server/tasks/concern-gate.ts
var VERDICT_RE = /^[\s>*#-]*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(?:\*\*)?(通过|否决|不通过)(?:\*\*)?\s*(?:[:：，,。;；-]\s*)?(.*)$/;
function parseReviewConclusion(summary2) {
  let found;
  for (const line of summary2.split("\n")) {
    const match = VERDICT_RE.exec(line.trim());
    if (!match) continue;
    const reason = match[2].trim().replace(/\*\*$/, "").trim();
    found = match[1] === "\u901A\u8FC7" ? { verdict: "pass", reason: reason || "\u6309\u6E05\u5355\u5BA1\u8FC7\uFF0C\u6CA1\u6709\u8D8A\u8FC7\u5E95\u7EBF" } : {
      verdict: "veto",
      reason: reason || "\u4E13\u5458\u5426\u51B3\uFF0C\u6CA1\u5199\u539F\u56E0\uFF08\u770B\u5BA1\u67E5\u4EFB\u52A1\u7684\u6458\u8981\uFF09"
    };
  }
  return found ?? {
    verdict: "none",
    reason: "\u5BA1\u67E5\u6458\u8981\u91CC\u6CA1\u6709\u300C\u7ED3\u8BBA\uFF1A\u901A\u8FC7\u300D\u6216\u300C\u7ED3\u8BBA\uFF1A\u5426\u51B3\uFF1A\u539F\u56E0\u300D"
  };
}
function reviewConclusion(status, result, reason) {
  if (status === "done") return parseReviewConclusion(result ?? "");
  if (status === "failed" || status === "cancelled" || status === "blocked")
    return {
      verdict: "none",
      reason: `\u5BA1\u67E5\u4EFB\u52A1${status === "failed" ? "\u5931\u8D25" : status === "cancelled" ? "\u5DF2\u53D6\u6D88" : "\u53D7\u963B"}${reason ? `\uFF1A${reason}` : ""}`
    };
  return null;
}
var label = (c) => `${c.name}\uFF08${c.ref}${c.review ? ` \xB7 ${c.review}` : ""}\uFF09`;
function concernOutcome(list4) {
  if (!list4.length) return { kind: "none" };
  const waiting = list4.filter((c) => c.verdict === null);
  if (waiting.length)
    return {
      kind: "waiting",
      reason: `\u7B49\u4E13\u5458\u5BA1\u67E5\uFF1A${waiting.map(label).join("\u3001")}`
    };
  const vetoed = list4.filter((c) => c.verdict === "veto");
  const missing = list4.filter((c) => c.verdict === "none");
  if (vetoed.length)
    return {
      kind: "vetoed",
      reason: `\u4E13\u5458\u5426\u51B3\uFF1A${vetoed.map((c) => `${label(c)}\uFF1A${c.reason}`).join("\uFF1B")}${missing.length ? `\uFF1B\u53E6\u6709\u6CA1\u51FA\u7ED3\u8BBA\u7684\uFF1A${missing.map(label).join("\u3001")}` : ""}`
    };
  if (missing.length)
    return {
      kind: "incomplete",
      reason: `\u4E13\u5458\u5BA1\u67E5\u6CA1\u51FA\u7ED3\u8BBA\uFF1A${missing.map((c) => `${label(c)}\uFF1A${c.reason}`).join("\uFF1B")}\uFF1B\u91CD\u8DD1\u5BA1\u67E5\u4EFB\u52A1\u6216\u4EBA\u5DE5\u5224\u5B9A`
    };
  return {
    kind: "passed",
    reason: `\u4E13\u5458\u5BA1\u67E5\u901A\u8FC7\uFF1A${list4.map(label).join("\u3001")}`
  };
}
var needsReview = (invited2) => invited2 > 0;
var isPathRule = (rule) => /[/*?]|^\./.test(rule);
function globRegex(glob) {
  let source2 = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      source2 += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") source2 += "[^/]*";
    else if (ch === "?") source2 += "[^/]";
    else source2 += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.includes("/") ? `^${source2}$` : `(?:^|/)${source2}$`);
}
function inviteHints(rules, input, invited2) {
  const files = input.files ?? [];
  const text6 = (input.text ?? "").toLowerCase();
  const hints = [];
  for (const rule of rules) {
    if (invited2.has(rule.ref)) continue;
    const matched = [];
    for (const when of rule.when) {
      const entry = when.trim();
      if (!entry) continue;
      if (isPathRule(entry)) {
        const re = globRegex(entry);
        const file = files.find((f) => re.test(f));
        if (file) matched.push(`${file} \u547D\u4E2D ${entry}`);
      } else {
        const word = entry.toLowerCase();
        const file = files.find((f) => f.toLowerCase().includes(word));
        if (text6.includes(word)) matched.push(`\u63D0\u5230\u300C${entry}\u300D`);
        else if (file) matched.push(`${file} \u542B\u300C${entry}\u300D`);
      }
      if (matched.length >= 3) break;
    }
    if (matched.length) hints.push({ ref: rule.ref, name: rule.name, matched });
  }
  return hints;
}
var hintText = (hint) => `${hint.name}\uFF08${hint.ref}\uFF09\uFF1A${hint.matched.join("\uFF1B")}`;
var CHECKLIST_MAX = 3e3;
var clip = (text6, max) => Array.from(text6).length > max ? `${Array.from(text6).slice(0, max - 1).join("")}\u2026` : text6;
function checklistLines(c) {
  return [
    `### ${c.name}\uFF08${c.ref}\uFF09${c.goal ? `\u2014\u2014${c.goal}` : ""}`,
    ...c.points.length ? [
      "\u68C0\u67E5\u8981\u70B9\uFF1A",
      ...c.points.map((p3) => `- ${p3.text}\uFF08${p3.ref}\uFF1B\u4E3A\u4EC0\u4E48\uFF1A${p3.why}\uFF09`)
    ] : ["\u68C0\u67E5\u8981\u70B9\uFF1A\u672A\u5199\uFF0C\u6309\u4E13\u5458\u7AE0\u7A0B\u76EE\u6807\u5BA1"],
    ...c.bottom.length ? ["\u5E95\u7EBF\uFF08\u8D8A\u8FC7\u5373\u5426\u51B3\uFF09\uFF1A", ...c.bottom.map((b) => `- ${b}`)] : []
  ];
}
function concernSection(list4) {
  if (!list4.length) return void 0;
  const text6 = [
    "\u8FD9\u4E2A\u4EFB\u52A1\u8BF7\u4E86\u4E0B\u5217\u4E13\u5458\u3002\u5F00\u5DE5\u524D\u6309\u4ED6\u4EEC\u7684\u8981\u70B9\u81EA\u67E5\uFF1B\u4EA4\u4ED8\u540E\u8FD0\u884C\u65F6\u4F1A\u8BF7\u4ED6\u4EEC\u9010\u6761\u5BA1\u4E00\u904D\uFF0C\u8D8A\u8FC7\u5E95\u7EBF\u4F1A\u88AB\u5426\u51B3\u3001\u4EFB\u52A1\u8F6C\u5361\u4F4F\u3002",
    "",
    ...list4.flatMap((c) => [...checklistLines(c), ""])
  ].join("\n").trim();
  return clip(text6, CHECKLIST_MAX);
}
function reviewBrief(input) {
  const { checklist: c, task } = input;
  const range = input.base ? `origin/${input.base}...HEAD` : "HEAD";
  return [
    `# \u4E13\u5458\u5BA1\u67E5\uFF1A${c.name} \xB7 ${task.ref} ${task.title}`,
    "",
    `\u4F60\u662F\u300C${c.name}\u300D\u4E13\u5458\uFF0C\u88AB\u8BF7\u6765\u5BA1 ${task.ref} \u7684\u4EA4\u4ED8\u3002\u53EA\u5BA1\u4E0D\u6539\uFF1A\u4E0D\u8981\u63D0\u4EA4\u3001\u63A8\u9001\u3001\u6539\u5206\u652F\u6216\u8BC4\u8BBA PR\u3002`,
    "",
    "## \u5BA1\u4EC0\u4E48",
    "",
    ...input.pr_url ? [`- PR\uFF1A${input.pr_url}`] : ["- \u6CA1\u6709 PR"],
    ...input.worktree ? [
      `- \u5DE5\u4F5C\u6811\uFF1A${input.worktree}${input.branch ? `\uFF08\u5206\u652F ${input.branch}\uFF09` : ""}`,
      `- \u6539\u52A8\uFF1A\`git -C ${input.worktree} diff ${range}\``
    ] : [],
    ...input.diff ? [
      `- \u89C4\u6A21\uFF1A${input.diff.files} \u4E2A\u6587\u4EF6\uFF0C+${input.diff.added} \u2212${input.diff.removed}`,
      ...input.diff.list.slice(0, 30).map((f) => `  - ${f}`),
      ...input.diff.list.length > 30 ? [`  - \u2026\u53E6\u6709 ${input.diff.list.length - 30} \u4E2A`] : []
    ] : [],
    "",
    "## \u6309\u4EC0\u4E48\u5BA1",
    "",
    ...checklistLines(c),
    "",
    "## \u600E\u4E48\u4EA4\u7ED3\u8BBA",
    "",
    "\u9010\u6761\u5199\uFF1A\u8981\u70B9 \u2192 \u770B\u4E86\u54EA\u91CC\uFF08\u6587\u4EF6\u4E0E\u884C\uFF09\u2192 \u7ED3\u8BBA\u3002\u8BC1\u636E\u6765\u81EA\u4F60\u521A\u770B\u8FC7\u7684\u4EE3\u7801\u6216\u547D\u4EE4\u8F93\u51FA\uFF0C\u4E0D\u91C7\u4FE1\u6267\u884C\u8005\u81EA\u8FF0\u3002",
    "\u56DE\u590D\u7684\u6700\u540E\u4E00\u884C\u53EA\u5199\u7ED3\u8BBA\uFF0C\u4E8C\u9009\u4E00\uFF1A",
    "- `\u7ED3\u8BBA\uFF1A\u901A\u8FC7`\uFF08\u53EF\u5728\u540E\u9762\u52A0\u4E00\u53E5\u8BF4\u660E\uFF09",
    "- `\u7ED3\u8BBA\uFF1A\u5426\u51B3\uFF1A<\u8D8A\u8FC7\u4E86\u54EA\u6761\u5E95\u7EBF\u6216\u8981\u70B9\u3001\u5728\u54EA\u91CC>`",
    "\u53EA\u6709\u8D8A\u8FC7\u5E95\u7EBF\u6216\u660E\u786E\u8FDD\u53CD\u8981\u70B9\u624D\u5426\u51B3\uFF1B\u6539\u8FDB\u5EFA\u8BAE\u5199\u5728\u6B63\u6587\uFF0C\u4E0D\u5F71\u54CD\u901A\u8FC7\u3002",
    ""
  ].join("\n");
}

// server/tasks/concerns.ts
var CONCERNS_MAX = 5;
var specialistId = (id3) => -id3;
var specialistRef = (id3) => id3 < 0 ? `r${-id3}` : ref(id3);
function ensureConcernTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_concerns (
    task_id INTEGER NOT NULL REFERENCES tasks(id), node_id INTEGER NOT NULL,
    pos INTEGER NOT NULL, review_id INTEGER, verdict TEXT CHECK(verdict IN ('pass','veto','none')),
    reason TEXT, decided_at INTEGER,
    PRIMARY KEY(task_id,node_id));
  CREATE INDEX IF NOT EXISTS task_concerns_review ON task_concerns(review_id);`);
}
function concernsFor(db, value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("concern: \u5E94\u4E3A\u4E13\u5458\u540D\u79F0\u6216 rN\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694");
  const names2 = value.split(/[,，、]/).map((part) => part.trim()).filter(Boolean);
  if (!names2.length) return [];
  if (names2.length > CONCERNS_MAX)
    throw usage(`concern: \u4E00\u4E2A\u4EFB\u52A1\u81F3\u591A\u8BF7 ${CONCERNS_MAX} \u4F4D\u4E13\u5458`);
  const ids = [];
  for (const name2 of names2) {
    try {
      const id3 = specialistId(getJobRole(db, name2).id);
      if (!ids.includes(id3)) ids.push(id3);
      continue;
    } catch (error) {
      if (!(error instanceof Problem) || error.statusCode !== 404) throw error;
    }
    if (!hasOrg(db))
      throw usage("concern: \u4E13\u5458\u4E0D\u5B58\u5728\uFF1B\u8BF7\u5148\u7528 atrium specialist add \u521B\u5EFA");
    let node;
    try {
      node = nodeByAddress(db, name2);
    } catch (error) {
      if (error instanceof Problem)
        throw new Problem(
          400,
          `concern: ${error.message}`,
          "usage",
          error.candidates,
          "atrium org tree"
        );
      throw error;
    }
    if (node.kind !== "concern")
      throw new Problem(
        400,
        `concern: \u53EA\u80FD\u8BF7\u5173\u6CE8\u70B9\uFF08\u4E13\u5458\uFF09\u8282\u70B9\uFF0C${ref(node.id)} ${node.name} \u4E0D\u662F`,
        "usage",
        void 0,
        "atrium org tree"
      );
    if (node.archived_at !== null)
      throw usage(`concern: \u4E13\u5458\u5DF2\u5F52\u6863\uFF1A${ref(node.id)} ${node.name}`);
    if (!ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}
function specialistsFor(db, value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("ask: \u5E94\u4E3A\u4E13\u5458\u540D\u79F0\u6216 rN\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694");
  const names2 = value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  if (names2.length > CONCERNS_MAX)
    throw usage(`ask: \u4E00\u4E2A\u4EFB\u52A1\u81F3\u591A\u8BF7 ${CONCERNS_MAX} \u4F4D\u4E13\u5458`);
  return [
    ...new Set(names2.map((name2) => specialistId(getJobRole(db, name2).id)))
  ];
}
function writeConcerns(db, taskId, ids) {
  const current2 = all(
    db,
    "SELECT * FROM task_concerns WHERE task_id=? ORDER BY pos LIMIT 50",
    taskId
  );
  for (const row3 of current2)
    if (!ids.includes(row3.node_id))
      db.prepare("DELETE FROM task_concerns WHERE task_id=? AND node_id=?").run(
        taskId,
        row3.node_id
      );
  ids.forEach((id3, pos) => {
    if (current2.some((row3) => row3.node_id === id3))
      db.prepare(
        "UPDATE task_concerns SET pos=? WHERE task_id=? AND node_id=?"
      ).run(pos, taskId, id3);
    else
      db.prepare(
        "INSERT INTO task_concerns(task_id,node_id,pos) VALUES(?,?,?)"
      ).run(taskId, id3, pos);
  });
}
function concernRows(db, taskId) {
  return all(
    db,
    "SELECT * FROM task_concerns WHERE task_id=? ORDER BY pos LIMIT 50",
    taskId
  );
}
function concernStates(db, ids) {
  const map = /* @__PURE__ */ new Map();
  if (!ids.length) return map;
  const org = hasOrg(db);
  const rows = all(
    db,
    `SELECT c.*, ${org ? "COALESCE(s.name,n.name)" : "s.name"} AS name, r.status AS review_status
       FROM task_concerns c ${org ? "LEFT JOIN org_nodes n ON n.id=c.node_id AND c.node_id>0" : ""}
       LEFT JOIN job_roles s ON s.id=-c.node_id AND c.node_id<0
       LEFT JOIN tasks r ON r.id=c.review_id
      WHERE c.task_id IN (${ids.map(() => "?").join(",")})
      ORDER BY c.task_id, c.pos LIMIT 1000`,
    ...ids
  );
  for (const row3 of rows) {
    const list4 = map.get(row3.task_id) ?? [];
    list4.push({
      ref: specialistRef(row3.node_id),
      name: row3.name,
      review: row3.review_id === null ? null : taskRef(row3.review_id),
      review_status: row3.review_status,
      verdict: row3.verdict,
      reason: row3.reason
    });
    map.set(row3.task_id, list4);
  }
  return map;
}
var concernsOf = (db, taskId) => concernStates(db, [taskId]).get(taskId) ?? [];
function awaitingReview(db, taskId) {
  return !!one(
    db,
    "SELECT 1 FROM task_concerns WHERE task_id=? AND review_id IS NOT NULL AND verdict IS NULL LIMIT 1",
    taskId
  );
}
var charterFields = (db, id3) => {
  const doc2 = one(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    id3
  );
  try {
    return doc2 ? JSON.parse(doc2.fields) : {};
  } catch {
    return {};
  }
};
function checklistOf(db, nodeId) {
  if (nodeId < 0) {
    const specialist = getJobRole(db, `r${-nodeId}`);
    return {
      ref: specialist.ref,
      name: specialist.name,
      goal: specialist.review_goal || specialist.description,
      points: specialist.review_points,
      bottom: specialist.review_bottom
    };
  }
  const node = one(db, "SELECT * FROM org_nodes WHERE id=?", nodeId);
  const goal = charterFields(db, nodeId).goal;
  return {
    ref: ref(nodeId),
    name: node?.name ?? ref(nodeId),
    goal: typeof goal === "string" ? goal.trim().replace(/[。.]+$/, "") : "",
    points: nodePoints(db, nodeId).map((p3) => ({
      ref: p3.ref,
      text: p3.text,
      why: p3.why
    })),
    bottom: ownBoundaries(db, nodeId).map(
      (b) => `${b.summary}${b.param ? `\uFF1A${formatParam(b.param)}` : ""}`
    )
  };
}
function checklists(db, taskId) {
  return concernRows(db, taskId).map((row3) => checklistOf(db, row3.node_id));
}
function inviteRules(db) {
  const specialists = listJobRoles(db).filter((role) => role.invite_when.length).map((role) => ({
    ref: role.ref,
    name: role.name,
    when: role.invite_when
  }));
  if (!hasOrg(db)) return specialists;
  return [
    ...specialists,
    ...all(
      db,
      `SELECT n.*, d.fields AS fields FROM org_nodes n JOIN org_docs d ON d.node_id=n.id AND d.doc='charter'
      WHERE n.kind='concern' AND n.archived_at IS NULL ORDER BY n.id LIMIT 500`
    ).flatMap((row3) => {
      let when;
      try {
        when = JSON.parse(row3.fields).invite_when;
      } catch {
        return [];
      }
      return Array.isArray(when) && when.length ? [
        {
          ref: ref(row3.id),
          name: row3.name,
          when: when.filter((w) => typeof w === "string")
        }
      ] : [];
    })
  ];
}
function textHints(db, task) {
  const rules = inviteRules(db);
  if (!rules.length) return [];
  const invited2 = new Set(
    concernRows(db, task.id).map((r) => specialistRef(r.node_id))
  );
  return inviteHints(
    rules,
    { text: `${task.title}
${task.brief ?? ""}` },
    invited2
  );
}
function fileHints(db, taskId, files) {
  const rules = inviteRules(db);
  if (!rules.length || !files.length) return [];
  const invited2 = new Set(
    concernRows(db, taskId).map((r) => specialistRef(r.node_id))
  );
  return inviteHints(rules, { files }, invited2);
}

// server/tasks/also.ts
var ALSO_MAX = 5;
function ensureAlsoTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_also (
    task_id INTEGER NOT NULL REFERENCES tasks(id), node_id INTEGER NOT NULL,
    pos INTEGER NOT NULL, PRIMARY KEY(task_id,node_id));`);
}
function alsoFor(db, value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string")
    throw new Problem(400, "also: \u5E94\u4E3A\u90E8\u5206\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694\uFF08o20,o4\uFF09", "usage");
  const ids = resolveApplies(db, value, "also") ?? [];
  if (ids.length > ALSO_MAX)
    throw new Problem(
      400,
      `also: \u4E00\u4E2A\u4EFB\u52A1\u81F3\u591A\u7275\u6D89 ${ALSO_MAX} \u4E2A\u90E8\u5206\uFF1B\u8981\u5206\u5934\u5E72\u5C31\u62C6\u5B50\u4EFB\u52A1`,
      "usage"
    );
  return ids;
}
function writeAlso(db, taskId, ids) {
  db.prepare("DELETE FROM task_also WHERE task_id=?").run(taskId);
  ids.forEach(
    (id3, pos) => db.prepare("INSERT INTO task_also(task_id,node_id,pos) VALUES(?,?,?)").run(taskId, id3, pos)
  );
}
function alsoOf(db, taskId) {
  return all(
    db,
    `SELECT node_id FROM task_also WHERE task_id=? ORDER BY pos LIMIT ${ALSO_MAX * 4}`,
    taskId
  ).map((r) => r.node_id);
}
function involvedOf(db, task) {
  const also = alsoOf(db, task.id);
  let auto = [];
  try {
    auto = autoInvolved(db, task.part_id ?? task.node_id).filter(
      (id3) => !also.includes(id3)
    );
  } catch {
  }
  return { also, auto };
}
var involvedView = (involved) => ({
  ...involved.also.length ? { also: involved.also.map(ref) } : {},
  ...involved.auto.length ? { also_auto: involved.auto.map(ref) } : {}
});

// server/tasks/delivery-records.ts
var detail = (event) => {
  try {
    const x = JSON.parse(event.detail ?? "null");
    return x && typeof x === "object" && !Array.isArray(x) ? x : {};
  } catch {
    return {};
  }
};
var inner = (event) => {
  const d = detail(event).detail;
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
};
var text = (x) => typeof x === "string" ? x : null;
var number = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
var isRebaseConflict = (reason) => /rebase\s*冲突|变基\s*冲突|rebase\s+conflict/i.test(reason);
function ensureDeliveryRecords(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL,start_event_id INTEGER NOT NULL UNIQUE,worker TEXT NOT NULL,tool TEXT NOT NULL,model TEXT,effort TEXT,job_id INTEGER,risk TEXT,part_id INTEGER,started_at INTEGER NOT NULL,ended_at INTEGER,outcome TEXT,final_outcome TEXT,historical INTEGER NOT NULL DEFAULT 0,job_rev INTEGER,job_checks TEXT);
  CREATE INDEX IF NOT EXISTS task_deliveries_worker ON task_deliveries(tool,model,effort,job_id,id);
  CREATE INDEX IF NOT EXISTS task_deliveries_task ON task_deliveries(task_id,id);`);
  const columns = new Set(
    all(db, "PRAGMA table_info(task_deliveries)").map(
      (x) => x.name
    )
  );
  if (!columns.has("job_rev"))
    db.exec("ALTER TABLE task_deliveries ADD COLUMN job_rev INTEGER");
  if (!columns.has("job_checks"))
    db.exec("ALTER TABLE task_deliveries ADD COLUMN job_checks TEXT");
  if (!columns.has("final_outcome"))
    db.exec("ALTER TABLE task_deliveries ADD COLUMN final_outcome TEXT");
  backfillDeliveries(db);
}
function backfillDeliveries(db) {
  let after = 0;
  for (; ; ) {
    const starts = all(
      db,
      "SELECT * FROM task_events WHERE kind='start' AND id>? ORDER BY id LIMIT 200",
      after
    );
    for (const start of starts) {
      after = start.id;
      if (one(
        db,
        "SELECT 1 FROM task_deliveries WHERE start_event_id=?",
        start.id
      ))
        continue;
      const task = one(
        db,
        "SELECT * FROM tasks WHERE id=?",
        start.task_id
      );
      if (!task) continue;
      const d = inner(start), raw = text(d.worker) ?? task.worker;
      if (!raw) continue;
      let spec;
      try {
        spec = parseWorker(raw);
      } catch {
        continue;
      }
      const nextStart = one(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? AND kind='start' ORDER BY id LIMIT 1",
        task.id,
        start.id
      );
      const end = one(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? AND id<? AND kind IN ('exit_ok','exit_fail','block','manual_set','cancel') ORDER BY id LIMIT 1",
        task.id,
        start.id,
        nextStart?.id ?? Number.MAX_SAFE_INTEGER
      );
      db.prepare(
        "INSERT OR IGNORE INTO task_deliveries(task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,ended_at,outcome,historical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)"
      ).run(
        task.id,
        start.id,
        raw,
        spec.tool,
        spec.model ?? null,
        null,
        task.job_id,
        text(d.risk),
        task.part_id,
        start.at,
        end?.at ?? nextStart?.at ?? null,
        end?.kind ?? (nextStart ? "switched" : null)
      );
    }
    if (starts.length < 200) break;
  }
}
function startDelivery(db, task, eventId, worker, risk, at) {
  let spec;
  try {
    spec = parseWorker(worker);
  } catch {
    spec = { tool: worker.split(/[+:]/, 1)[0] ?? worker };
  }
  const job = task.job_id ? getJobRole(db, `r${task.job_id}`) : null;
  db.prepare(
    "UPDATE task_deliveries SET final_outcome='switched',ended_at=COALESCE(ended_at,?),outcome=COALESCE(outcome,'switched') WHERE id=(SELECT id FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1) AND worker<>? AND COALESCE(final_outcome,'') NOT IN ('merged','cancelled')"
  ).run(at, task.id, worker);
  db.prepare(
    "INSERT OR IGNORE INTO task_deliveries(task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,historical,job_rev,job_checks) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)"
  ).run(
    task.id,
    eventId,
    worker,
    spec.tool,
    spec.model ?? null,
    spec.effort ?? null,
    task.job_id,
    risk,
    task.part_id,
    at,
    job?.rev ?? null,
    job ? JSON.stringify(job.checks) : null
  );
}
function activeJobChecks(db, taskId) {
  const row3 = one(
    db,
    "SELECT job_checks FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1",
    taskId
  );
  if (!row3?.job_checks) return null;
  try {
    const checks = JSON.parse(row3.job_checks);
    return Array.isArray(checks) && checks.every((x) => typeof x === "string") ? checks : null;
  } catch {
    return null;
  }
}
function endDelivery(db, taskId, outcome, at) {
  db.prepare(
    "UPDATE task_deliveries SET ended_at=?,outcome=?,final_outcome=? WHERE id=(SELECT id FROM task_deliveries WHERE task_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)"
  ).run(at, outcome, outcome, taskId);
}
function markDeliveryFinal(db, taskId, result) {
  db.prepare(
    "UPDATE task_deliveries SET final_outcome=? WHERE id=(SELECT id FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1)"
  ).run(result, taskId);
}
function deliveryFacts(row3, task, events2, usage11, jobName) {
  const later = events2.filter((e) => e.id > row3.start_event_id);
  const untilNext = later.find((e) => e.kind === "start");
  const current2 = later.filter((e) => !untilNext || e.id < untilNext.id);
  const gates = current2.filter((e) => e.kind === "gates").map(detail);
  const failedGates = gates.flatMap(
    (d) => Array.isArray(d.results) ? d.results.filter(
      (x) => !!x && typeof x === "object" && !Array.isArray(x)
    ).filter((x) => x.ok === false && x.pending !== true).map(
      (x) => `${text(x.gate) ?? "\u5173\u5361"}\uFF1A${text(x.evidence) ?? "\u672A\u8FC7"}`
    ) : []
  );
  const mergeReturns = current2.filter((e) => e.kind === "merge_returned" || e.kind === "merge_blocked").map((e) => text(detail(e).reason) ?? "\u5408\u5165\u961F\u5217\u9000\u56DE");
  const conflicts = mergeReturns.filter(isRebaseConflict).length;
  const incidents = [
    ...current2.some(
      (e) => e.kind === "stalled" || /卡死/.test(text(inner(e).reason) ?? "")
    ) ? ["\u5361\u6B7B"] : [],
    ...current2.some((e) => e.kind === "thinking_retry") ? ["\u601D\u8003\u8017\u5C3D"] : [],
    ...gates.some(
      (d) => Array.isArray(d.results) && d.results.some(
        (x) => !!x && typeof x === "object" && "gate" in x && x.gate === "pr_exists" && x.ok === false
      )
    ) ? ["\u6CA1\u5F00 PR"] : [],
    ...failedGates.some((x) => x.startsWith("claims_verified")) ? ["\u865A\u62A5"] : [],
    ...current2.some((e) => /worker_guard|worker-guard/.test(e.kind)) ? ["\u8D8A\u754C"] : []
  ];
  const gateDiff = gates.map((d) => d.diff).find((x) => !!x && typeof x === "object");
  const diff = gateDiff ? {
    files: number(gateDiff.files) ?? 0,
    added: number(gateDiff.added) ?? 0,
    deleted: number(gateDiff.deleted) ?? number(gateDiff.removed) ?? 0
  } : null;
  const notes2 = current2.filter((e) => e.kind === "note").map(detail).filter((d) => ["ok", "fixed", "rejected"].includes(text(d.verdict) ?? ""));
  const lastNote = notes2.at(-1);
  const merged = current2.some((e) => e.kind === "merged") || (task.delivery_stage === "merged" || task.delivery_stage === "online") && !untilNext;
  const passed = gates.some((d) => d.passed === true);
  return {
    ...row3,
    task_ref: `t${row3.task_id}`,
    task_title: task.title,
    final_result: row3.final_outcome === "merged" || merged ? "\u5DF2\u5408\u5165" : row3.final_outcome === "cancelled" ? "\u53D6\u6D88" : row3.final_outcome === "switched" || untilNext && text(inner(untilNext).worker) !== row3.worker ? "\u6362\u4EBA" : row3.final_outcome === "rebase_conflict" ? "\u53D8\u57FA\u51B2\u7A81" : row3.final_outcome === "returned" ? "\u5408\u5165\u9000\u56DE" : !untilNext && task.status === "cancelled" ? "\u53D6\u6D88" : row3.outcome === "exit_ok" ? "\u4EA4\u4ED8" : row3.outcome === "exit_fail" ? "\u5931\u8D25" : row3.outcome === "block" ? "\u53D7\u963B" : row3.outcome ?? "\u8FDB\u884C\u4E2D",
    job_ref: row3.job_id ? `r${row3.job_id}` : null,
    job_name: jobName,
    duration_ms: row3.ended_at === null ? null : Math.max(0, row3.ended_at - row3.started_at),
    diff,
    gate_returns: failedGates,
    gate_return_count: gates.filter(
      (d) => Array.isArray(d.results) && d.results.some(
        (x) => !!x && typeof x === "object" && "ok" in x && x.ok === false && x.pending !== true
      )
    ).length,
    merge_returns: mergeReturns.filter((r) => !isRebaseConflict(r)),
    rebase_conflicts: conflicts,
    incidents,
    first_pass: row3.ended_at === null ? null : passed && failedGates.length === 0 && mergeReturns.length === conflicts,
    merged,
    usage_points: usage11?.basis === "unknown" ? null : usage11?.points ?? null,
    usage_basis: usage11?.basis ?? null,
    verdict: text(lastNote?.verdict),
    verdict_note: text(lastNote?.text)
  };
}
function listDeliveries(db, filter = {}) {
  const limit = filter.limit === void 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(filter.limit, 1e3));
  const rows = [];
  let before = Number.MAX_SAFE_INTEGER;
  while (rows.length < limit) {
    const page = all(
      db,
      "SELECT * FROM task_deliveries WHERE (? IS NULL OR worker=?) AND (? IS NULL OR job_id=?) AND id<? ORDER BY id DESC LIMIT ?",
      filter.worker ?? null,
      filter.worker ?? null,
      filter.job ?? null,
      filter.job ?? null,
      before,
      Math.min(200, limit - rows.length)
    );
    rows.push(...page);
    if (page.length < 200 || rows.length >= limit) break;
    before = page.at(-1).id;
  }
  return rows.flatMap((row3) => {
    const task = one(
      db,
      "SELECT * FROM tasks WHERE id=?",
      row3.task_id
    );
    if (!task) return [];
    const events2 = [];
    let cursor = row3.start_event_id;
    for (; ; ) {
      const page = all(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id LIMIT 200",
        row3.task_id,
        cursor
      );
      events2.push(...page);
      if (page.length < 200 || page.some((event) => event.kind === "start"))
        break;
      cursor = page.at(-1).id;
    }
    const usage11 = one(
      db,
      "SELECT points,basis FROM task_usage WHERE task_id=? AND started_at>=? ORDER BY started_at LIMIT 1",
      row3.task_id,
      row3.started_at - 2e3
    );
    const job = row3.job_id ? one(
      db,
      "SELECT name FROM job_roles WHERE id=?",
      row3.job_id
    ) : void 0;
    return [deliveryFacts(row3, task, events2, usage11, job?.name ?? null)];
  });
}
function summarizeDeliveries(rows, trust = /* @__PURE__ */ new Map()) {
  const groups = /* @__PURE__ */ new Map();
  for (const row3 of rows)
    for (const [scope, worker] of [
      ["combination", row3.worker],
      ["model", row3.model ? `${row3.tool}+${row3.model}` : row3.tool],
      ["tool", row3.tool]
    ]) {
      const role = row3.job_name;
      const key = JSON.stringify([scope, worker, role]);
      const group = groups.get(key) ?? { scope, worker, role, rows: [] };
      group.rows.push(row3);
      groups.set(key, group);
    }
  return [...groups.values()].map((g) => {
    const finished2 = g.rows.filter((r) => r.ended_at !== null);
    const rated = finished2.filter((r) => r.first_pass !== null);
    const durations = finished2.map((r) => r.duration_ms).filter((n) => n !== null).sort((a, b) => a - b);
    const mid = durations.length ? durations.length % 2 ? durations[(durations.length - 1) / 2] : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2 : null;
    return {
      scope: g.scope,
      worker: g.worker,
      role: g.role,
      deliveries: finished2.length,
      first_pass_rate: rated.length ? rated.filter((r) => r.first_pass).length / rated.length : null,
      average_returns: finished2.length ? finished2.reduce(
        (n, r) => n + r.gate_return_count + r.merge_returns.length,
        0
      ) / finished2.length : 0,
      median_ms: mid,
      incidents: finished2.reduce((n, r) => n + r.incidents.length, 0),
      low_data: finished2.length < 5,
      trust: trust.get(g.worker) ?? null
    };
  }).sort(
    (a, b) => (a.role ?? "").localeCompare(b.role ?? "") || a.scope.localeCompare(b.scope) || a.worker.localeCompare(b.worker)
  );
}
function adviceFor(stat5) {
  if (stat5.scope !== "combination" || stat5.deliveries < 5) return null;
  if (stat5.incidents > 0)
    return {
      action: "tighten",
      reason: `${stat5.deliveries} \u6B21\u4EA4\u4ED8\u6709 ${stat5.incidents} \u8D77\u4E8B\u6545`
    };
  if (stat5.first_pass_rate !== null && stat5.first_pass_rate < 0.5)
    return {
      action: "avoid_role",
      reason: `${stat5.role ?? "\u672A\u6307\u5B9A\u4E13\u5458"} ${stat5.deliveries} \u6B21\u4EA4\u4ED8\u4E00\u6B21\u901A\u8FC7\u7387 ${Math.round(stat5.first_pass_rate * 100)}%`
    };
  if (stat5.first_pass_rate === 1 && stat5.deliveries >= 5 && stat5.trust !== "high")
    return {
      action: "relax",
      reason: `${stat5.deliveries} \u6B21\u4EA4\u4ED8\u5747\u4E00\u6B21\u901A\u8FC7\u4E14\u65E0\u4E8B\u6545`
    };
  return null;
}

// server/tasks/councils.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join9 } from "node:path";

// server/tasks/brief.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join6 } from "node:path";
var BRIEF_MAX_BYTES = 64 * 1024;
var briefBytes = (text6) => Buffer.byteLength(text6, "utf8");
function briefTooLong(bytes, field2 = "brief") {
  return usage(
    `${field2}: \u4EFB\u52A1\u8BE6\u8FF0 ${Math.ceil(bytes / 1024)} KB\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${BRIEF_MAX_BYTES / 1024} KB\uFF1B\u8BF7\u7CBE\u7B80\uFF0C\u957F\u6750\u6599\u653E\u8FDB\u4ED3\u5E93\u6587\u4EF6\u3001\u8BE6\u8FF0\u91CC\u5199\u8DEF\u5F84`
  );
}
function briefText(value, field2 = "brief") {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw usage(`${field2}: \u5E94\u4E3A\u6587\u672C`);
  const text6 = value.replace(/^﻿/, "");
  if (!text6.trim()) return null;
  const bytes = briefBytes(text6);
  if (bytes > BRIEF_MAX_BYTES) throw briefTooLong(bytes, field2);
  return text6;
}
function clipBrief(text6) {
  if (briefBytes(text6) <= BRIEF_MAX_BYTES) return text6;
  const note = "\n\n\uFF08\u8BE6\u8FF0\u8FC7\u957F\uFF0C\u4EE5\u4E0B\u5DF2\u622A\u65AD\uFF09";
  const room = BRIEF_MAX_BYTES - briefBytes(note);
  let out = Buffer.from(text6, "utf8").subarray(0, room).toString("utf8");
  out = out.replace(/\uFFFD+$/, "");
  return `${out}${note}`;
}
function briefFile(path, repo) {
  if (isAbsolute2(path)) return path;
  return repo ? join6(repo, path) : void 0;
}
function readBriefFile(path, repo) {
  const file = briefFile(path, repo);
  if (!file)
    throw usage(`brief_path: \u76F8\u5BF9\u8DEF\u5F84\u9700\u8981\u4EFB\u52A1\u6709\u4ED3\u5E93\uFF08--repo\uFF09\uFF1A${path}`);
  let text6;
  try {
    text6 = readFileSync3(file, "utf8");
  } catch {
    throw usage(`brief_path: \u4EFB\u52A1\u8BE6\u8FF0\u8BFB\u4E0D\u5230\uFF1A${file}`);
  }
  return briefText(text6, "brief_path") ?? "";
}

// server/tasks/active.ts
import { join as join8 } from "node:path";

// server/tasks/watchdog.ts
import { createHash as createHash3 } from "node:crypto";
import { open, readdir as readdir2, stat } from "node:fs/promises";
import { join as join7 } from "node:path";

// server/tasks/json-log.ts
function parseLine(line) {
  const text6 = line.trim();
  if (!text6.startsWith("{")) return void 0;
  try {
    const value = JSON.parse(text6);
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function parseEvents(text6) {
  const events2 = [];
  for (const line of text6.split("\n")) {
    const event = parseLine(line);
    if (event) events2.push(event);
  }
  return events2;
}
var object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
function textOf(event) {
  if (event.type === "text") {
    const text6 = object(event.part)?.text;
    return typeof text6 === "string" && text6.trim() ? text6 : void 0;
  }
  if (event.type === "assistant") {
    const content = object(event.message)?.content;
    if (!Array.isArray(content)) return void 0;
    const text6 = content.map(object).filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
    return text6.trim() ? text6 : void 0;
  }
  return void 0;
}
function lastAssistantText(events2) {
  for (let i = events2.length - 1; i >= 0; i--) {
    const event = events2[i];
    if (event.type === "result" && typeof event.result === "string" && event.result.trim())
      return event.result;
    const text6 = textOf(event);
    if (text6 !== void 0) return text6;
  }
  return void 0;
}
var THIN_OUTPUT = 64;
var count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
function thinkingExhausted(finish) {
  if (finish.type !== "step_finish") return void 0;
  const part = object(finish.part);
  if (part?.reason !== "length") return void 0;
  const tokens = object(part.tokens);
  const reasoning = count(tokens?.reasoning);
  const output = count(tokens?.output);
  if (!reasoning || output === void 0 || output > THIN_OUTPUT)
    return void 0;
  return { reasoning, output, limit: reasoning + output };
}
var thinkingReason = (hit2) => `\u601D\u8003\u8017\u5C3D\u5355\u6B21\u8F93\u51FA\uFF08reasoning ${hit2.reasoning} / \u4E0A\u9650 ${hit2.limit}\uFF0C\u6B63\u6587 ${hit2.output}\uFF09`;
var TARGET_MAX = 200;
function rejectedTarget(input) {
  const value = [
    input?.command,
    input?.filePath,
    input?.path,
    input?.pattern
  ].find((item) => typeof item === "string" && item.trim());
  if (!value) return void 0;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > TARGET_MAX ? `${line.slice(0, TARGET_MAX)}\u2026` : line;
}
function rejection(events2) {
  for (let i = events2.length - 1; i >= 0; i--) {
    const event = events2[i];
    if (event.type === "step_start") return void 0;
    if (event.type !== "tool_use") continue;
    const state = object(object(event.part)?.state);
    if (state?.status !== "error") continue;
    const error = typeof state.error === "string" ? state.error : "";
    if (!/rejected permission/i.test(error)) return void 0;
    return rejectedTarget(object(state.input)) ?? "";
  }
  return void 0;
}
function abnormalEnding(events2) {
  let finish = -1;
  for (let i = events2.length - 1; i >= 0 && finish < 0; i--)
    if (events2[i].type === "step_finish") finish = i;
  if (finish < 0) return void 0;
  const reason = object(events2[finish].part)?.reason;
  const thinking = thinkingExhausted(events2[finish]);
  if (thinking) return { kind: "thinking", reason: thinkingReason(thinking) };
  if (reason === "length")
    return { kind: "length", reason: "\u4E0A\u4E0B\u6587\u6216\u8F93\u51FA\u957F\u5EA6\u7528\u5C3D" };
  const rejected = rejection(events2.slice(0, finish));
  if (rejected !== void 0)
    return {
      kind: "permission",
      reason: rejected ? `\u6743\u9650\u88AB\u62D2\u540E\u7ED3\u675F\uFF1A${rejected}` : "\u6743\u9650\u88AB\u62D2\u540E\u7ED3\u675F"
    };
  if (reason === "tool-calls" && !events2.slice(finish + 1).some((event) => textOf(event) !== void 0))
    return { kind: "midway", reason: "\u5BF9\u8BDD\u4E2D\u9014\u9000\u51FA" };
  return void 0;
}

// server/tasks/summary.ts
function summarize(tail, json = false) {
  if (json) {
    const text6 = lastAssistantText(parseEvents(tail));
    if (text6 !== void 0) return clipResult(text6.trim());
  }
  return clipResult(tail.trim());
}
function countSteps(chunk) {
  let steps = 0;
  for (const line of chunk.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    if (event.type === "step_start" || event.type === "step_finish" || event.type === "tool_use" || event.type === "assistant" || event.type === "user")
      steps++;
  }
  return steps;
}

// server/tasks/watchdog.ts
var minutes = (ms) => ms % 6e4 === 0 ? `${ms / 6e4} \u5206\u949F` : `${Math.round(ms / 1e3)} \u79D2`;
function judge(state, limits, now) {
  if (state.lastProgressAt === null) {
    if (now - state.startedAt >= limits.startupMs)
      return {
        kind: "stalled",
        reason: `\u542F\u52A8\u540E ${minutes(limits.startupMs)}\u6CA1\u6709\u4EFB\u4F55\u8FDB\u5C55\u4FE1\u53F7\uFF08\u65E5\u5FD7\u4E0D\u589E\u957F\u3001\u5DE5\u4F5C\u76EE\u5F55\u65E0\u53D8\u5316\u3001\u65E0\u6B65\u9AA4\u4E8B\u4EF6\uFF09\uFF0C\u5224\u5B9A\u5361\u6B7B`
      };
    return { kind: "ok" };
  }
  if (now - state.lastProgressAt >= limits.idleMs)
    return {
      kind: "idle",
      reason: `\u8FDE\u7EED ${minutes(limits.idleMs)}\u6CA1\u6709\u8FDB\u5C55\u4FE1\u53F7\uFF0C\u5224\u5B9A\u53D7\u963B`
    };
  return { kind: "ok" };
}
function finalClaudeResult(log) {
  let result;
  for (const line of log.split("\n")) {
    if (line.startsWith("[atrium] ")) {
      result = void 0;
      continue;
    }
    const event = parseLine(line);
    if (!event) continue;
    if (event.type === "result")
      result = event.is_error === false && event.stop_reason === "end_turn" ? "clean" : "error";
    else if (event.type !== "command_lifecycle" && !(event.type === "system" && event.subtype === "stdin_closed"))
      result = void 0;
  }
  return result;
}
function watchLimits(defaults, limits = {}) {
  const pick = (value, fallback) => value !== void 0 && value > 0 ? value : fallback;
  return {
    startupMs: pick(limits.startup_minutes, defaults.startupMinutes) * 6e4,
    idleMs: pick(limits.idle_minutes, defaults.idleMinutes) * 6e4
  };
}
var SKIP = /* @__PURE__ */ new Set([".git", "node_modules", "dist", ".atrium"]);
var WALK_MAX = 5e3;
async function walkFingerprint(dir) {
  let count2 = 0;
  let newest = 0;
  const queue = [dir];
  while (queue.length && count2 < WALK_MAX) {
    const current2 = queue.shift();
    let entries;
    try {
      entries = await readdir2(current2, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join7(current2, entry.name);
      count2++;
      try {
        newest = Math.max(newest, (await stat(path)).mtimeMs);
      } catch {
      }
      if (entry.isDirectory()) queue.push(path);
      if (count2 >= WALK_MAX) break;
    }
  }
  return `${count2}:${newest}`;
}
var ProgressProbe = class {
  constructor(logFile, cwd, git, jsonEvents2, run3 = exec) {
    this.logFile = logFile;
    this.cwd = cwd;
    this.git = git;
    this.jsonEvents = jsonEvents2;
    this.run = run3;
  }
  logFile;
  cwd;
  git;
  jsonEvents;
  run;
  offset = 0;
  steps = 0;
  last;
  /** 以当前状态为基线（拉起前写进日志的抬头不算进展）。 */
  async baseline() {
    this.last = await this.sample();
  }
  async fingerprint() {
    if (!this.git) return walkFingerprint(this.cwd);
    const [status, head2] = await Promise.all([
      this.run(
        "git",
        [
          "--no-optional-locks",
          "-C",
          this.cwd,
          "status",
          "--porcelain",
          "-uall"
        ],
        { timeoutMs: 15e3 }
      ),
      this.run("git", ["-C", this.cwd, "rev-parse", "HEAD"], {
        timeoutMs: 5e3
      })
    ]);
    return createHash3("sha256").update(status.stdout).update(head2.stdout).digest("hex");
  }
  async readSteps(size) {
    if (!this.jsonEvents || size <= this.offset) return;
    const length = Math.min(size - this.offset, 1024 * 1024);
    const handle = await open(this.logFile, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      const text6 = buffer.toString("utf8");
      const cut3 = text6.lastIndexOf("\n");
      if (cut3 < 0) return;
      this.steps += countSteps(text6.slice(0, cut3));
      this.offset += Buffer.byteLength(text6.slice(0, cut3 + 1));
    } finally {
      await handle.close();
    }
  }
  async sample() {
    let logSize = 0;
    try {
      logSize = (await stat(this.logFile)).size;
    } catch {
      logSize = 0;
    }
    await this.readSteps(logSize).catch(() => void 0);
    return {
      logSize,
      fingerprint: await this.fingerprint().catch(() => ""),
      steps: this.steps
    };
  }
  /** 与上次采样比较，返回这次看到的进展信号（空数组表示没有进展）。 */
  async poll() {
    const next = await this.sample();
    const prev = this.last;
    this.last = next;
    if (!prev) return { signals: [], sample: next };
    const signals = [];
    if (next.logSize > prev.logSize) signals.push("log_growth");
    if (next.fingerprint && next.fingerprint !== prev.fingerprint)
      signals.push("worktree_change");
    if (next.steps > prev.steps) signals.push("json_events");
    return { signals, sample: next };
  }
};

// server/tasks/active.ts
var taskDir = (data2, id3) => join8(data2, "tasks", String(id3));
function limitsFor(worker) {
  return watchLimits(
    ADAPTERS[worker.tool].watchdog,
    worker.profile.rules.limits
  );
}
function probeFor(logFile, cwd, git, tool, exec2) {
  return new ProgressProbe(
    logFile,
    cwd,
    git,
    ADAPTERS[tool].progressSignals.includes("json_events"),
    exec2
  );
}
function launched(input) {
  const { prepared, worker } = input;
  return {
    id: input.task.id,
    pid: input.pid,
    child: input.child,
    tool: worker.tool,
    worker,
    risk: input.risk,
    prepared,
    logFile: prepared.logFile,
    repo: input.task.repo,
    worktree: prepared.worktree,
    branch: prepared.branch,
    base: prepared.base,
    deliver: input.task.deliver,
    issue: input.task.issue,
    startedAt: input.task.started_at ?? Date.now(),
    probe: probeFor(
      prepared.logFile,
      prepared.cwd,
      !!prepared.worktree,
      worker.tool,
      input.exec
    ),
    state: { startedAt: Date.now(), lastProgressAt: null },
    limits: limitsFor(worker),
    retried: input.retried,
    exited: false
  };
}
function adopted(input) {
  const { task, worker } = input;
  const dir = taskDir(input.data, task.id);
  const logFile = join8(dir, "log");
  const now = Date.now();
  return {
    id: task.id,
    pid: task.pid,
    tool: worker.tool,
    worker,
    risk: "low",
    logFile,
    resultFile: join8(dir, "last-message.md"),
    repo: task.repo,
    worktree: task.worktree,
    branch: task.branch,
    base: input.base,
    deliver: task.deliver,
    issue: task.issue,
    startedAt: task.started_at ?? now,
    probe: probeFor(
      logFile,
      task.worktree ?? join8(dir, "work"),
      !!task.worktree,
      worker.tool,
      input.exec
    ),
    state: { startedAt: now, lastProgressAt: now },
    limits: limitsFor(worker),
    retried: true,
    exited: false
  };
}

// server/tasks/council-gate.ts
var STANCE_LABEL = {
  agree: "\u540C\u610F",
  conditional: "\u6709\u6761\u4EF6\u540C\u610F",
  oppose: "\u53CD\u5BF9",
  veto: "\u5426\u51B3",
  none: "\u6CA1\u51FA\u610F\u89C1"
};
var OPINION_RE = /^[\s>*#-]*(?:\*\*)?意见(?:\*\*)?\s*[:：]\s*(?:\*\*)?(同意|有条件同意|有条件|反对|否决)(?:\*\*)?\s*(?:[:：，,。;；-]\s*)?(.*)$/;
function parseOpinion(summary2) {
  let found;
  for (const line of summary2.split("\n")) {
    const match = OPINION_RE.exec(line.trim());
    if (!match) continue;
    const reason = match[2].trim().replace(/\*\*$/, "").trim();
    const word = match[1];
    found = word === "\u540C\u610F" ? { stance: "agree", reason } : word === "\u53CD\u5BF9" ? { stance: "oppose", reason: reason || "\u6CA1\u5199\u539F\u56E0\uFF08\u770B\u610F\u89C1\u6B63\u6587\uFF09" } : word === "\u5426\u51B3" ? { stance: "veto", reason: reason || "\u6CA1\u5199\u8D8A\u8FC7\u54EA\u6761\u5E95\u7EBF" } : { stance: "conditional", reason: reason || "\u6CA1\u5199\u6761\u4EF6" };
  }
  return found ?? {
    stance: "none",
    reason: "\u610F\u89C1\u6458\u8981\u91CC\u6CA1\u6709\u300C\u610F\u89C1\uFF1A\u540C\u610F\uFF0F\u6709\u6761\u4EF6\u540C\u610F\uFF0F\u53CD\u5BF9\uFF0F\u5426\u51B3\u300D"
  };
}
function opinionOf(status, result, reason) {
  if (status === "done") return parseOpinion(result ?? "");
  if (status === "failed" || status === "cancelled" || status === "blocked")
    return {
      stance: "none",
      reason: `\u610F\u89C1\u4EFB\u52A1${status === "failed" ? "\u5931\u8D25" : status === "cancelled" ? "\u5DF2\u53D6\u6D88" : "\u53D7\u963B"}${reason ? `\uFF1A${reason}` : ""}`
    };
  return null;
}
function opinionsReady(members) {
  return members.length > 0 && members.every(
    (m) => !m.busy && (m.status === "done" || m.status === "failed" || m.status === "cancelled" || m.status === "blocked")
  );
}
var CONCLUSION_RE = /^[\s>*#-]*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.*?)(?:\*\*)?\s*$/;
var ESCALATE_RE = /^[\s>*#-]*(?:\*\*)?需用户拍板(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.*?)(?:\*\*)?\s*$/;
var HEADING_RE = /^#{1,6}\s*(.+?)\s*$/;
var NONE_RE = /^(无|没有|暂无|不需要|none|-)?[。.]?$/i;
function parseSummary(text6) {
  const summary2 = {
    agreed: [],
    conflicts: [],
    escalate: [],
    conclusion: null
  };
  let section = null;
  for (const raw of text6.split("\n")) {
    const line = raw.trim();
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const name2 = heading[1].replace(/[:：]$/, "");
      section = /^一致/.test(name2) ? "agreed" : /^(冲突|分歧)/.test(name2) ? "conflicts" : null;
      continue;
    }
    const escalate2 = ESCALATE_RE.exec(line);
    if (escalate2) {
      const item = escalate2[1].trim();
      if (!NONE_RE.test(item)) summary2.escalate.push(item);
      continue;
    }
    const conclusion = CONCLUSION_RE.exec(line);
    if (conclusion) {
      const value = conclusion[1].trim();
      if (value) summary2.conclusion = value;
      continue;
    }
    if (section && /^[-*]\s+/.test(line)) {
      const item = line.replace(/^[-*]\s+/, "").trim();
      if (item && !NONE_RE.test(item)) summary2[section].push(item);
    }
  }
  return summary2;
}
function councilOutcome(summary2, opinions) {
  const escalate2 = [...summary2.escalate];
  if (!summary2.conclusion) escalate2.push("leader \u6C47\u603B\u6CA1\u5199\u300C\u7ED3\u8BBA\uFF1A\u300D\uFF0C\u8BF7\u4E0A\u5C42\u5B9A");
  if (opinions.length && opinions.every((o) => o.stance === "none"))
    escalate2.push("\u53D7\u9080\u4E13\u5458\u90FD\u6CA1\u51FA\u610F\u89C1\uFF0C\u7ED3\u8BBA\u7F3A\u4F9D\u636E");
  if (!summary2.escalate.length)
    for (const o of opinions.filter((o2) => o2.stance === "veto"))
      escalate2.push(
        `${o.name}\uFF08${o.ref} \xB7 ${o.task}\uFF09\u4EE5\u5E95\u7EBF\u5426\u51B3\uFF1A${o.reason}\uFF1B\u4E13\u5458\u5426\u51B3\u4E0D\u80FD\u7531 leader \u81EA\u884C\u63A8\u7FFB`
      );
  return {
    kind: escalate2.length ? "escalated" : "decided",
    conclusion: summary2.conclusion,
    escalate: escalate2
  };
}
var clip2 = (text6, max) => Array.from(text6).length > max ? `${Array.from(text6).slice(0, max - 1).join("")}\u2026` : text6;
var TOPIC_MAX = 16e3;
var OPINION_MAX = 4e3;
function topicLines(topic) {
  return [
    `- \u8BAE\u9898\uFF1A${topic.topic}\uFF08\u4F1A\u5BA1 ${topic.ref}\uFF09`,
    ...topic.issue ? [`- \u5173\u8054 issue\uFF1A#${topic.issue}`] : [],
    ...topic.repo ? [`- \u4ED3\u5E93\uFF08\u53EA\u8BFB\u53C2\u8003\uFF09\uFF1A${topic.repo}`] : [],
    `- \u53D7\u9080\u4E13\u5458\uFF1A${topic.concerns.map((c) => `${c.name}\uFF08${c.ref}\uFF09`).join("\u3001")}`,
    `- \u6C47\u603B\u4E0E\u62CD\u677F\uFF1A${topic.leader}`,
    "",
    ...topic.brief ? [
      `### \u8BAE\u9898\u8BE6\u8FF0${topic.brief_path ? `\uFF08${topic.brief_path}\uFF09` : ""}`,
      "",
      clip2(topic.brief.trim(), TOPIC_MAX)
    ] : ["\uFF08\u6CA1\u6709\u9644\u8BAE\u9898\u8BE6\u8FF0\uFF0C\u6309\u8BAE\u9898\u6807\u9898\u4E0E\u5173\u8054 issue \u5224\u65AD\uFF09"]
  ];
}
function checklistLines2(c) {
  return [
    `### ${c.name}\uFF08${c.ref}\uFF09${c.goal ? `\u2014\u2014${c.goal}` : ""}`,
    ...c.points.length ? [
      "\u68C0\u67E5\u8981\u70B9\uFF1A",
      ...c.points.map((p3) => `- ${p3.text}\uFF08${p3.ref}\uFF1B\u4E3A\u4EC0\u4E48\uFF1A${p3.why}\uFF09`)
    ] : ["\u68C0\u67E5\u8981\u70B9\uFF1A\u672A\u5199\uFF0C\u6309\u4E13\u5458\u7AE0\u7A0B\u76EE\u6807\u770B"],
    ...c.bottom.length ? ["\u5E95\u7EBF\uFF08\u8D8A\u8FC7\u5373\u53EF\u5426\u51B3\uFF09\uFF1A", ...c.bottom.map((b) => `- ${b}`)] : []
  ];
}
function opinionBrief(topic, checklist) {
  return [
    `# \u4F1A\u5BA1\u610F\u89C1\uFF1A${checklist.name} \xB7 ${topic.topic}`,
    "",
    `\u4F60\u662F\u300C${checklist.name}\u300D\u4E13\u5458\uFF0C\u88AB\u8BF7\u6765\u53C2\u52A0\u4F1A\u5BA1 ${topic.ref}\uFF0C\u548C\u5176\u4ED6\u4E13\u5458\u5404\u81EA\u72EC\u7ACB\u3001\u5E76\u884C\u51FA\u610F\u89C1\uFF0C\u4E4B\u540E\u7531${topic.leader}\u6C47\u603B\u3002`,
    "\u53EA\u51FA\u610F\u89C1\u4E0D\u52A8\u624B\uFF1A\u4E0D\u8981\u6539\u6587\u4EF6\u3001\u63D0\u4EA4\u3001\u63A8\u9001\u3001\u5F00 PR\uFF0C\u4E5F\u4E0D\u8981\u5728 issue \u6216 PR \u4E0A\u8BC4\u8BBA\u3002",
    "",
    "## \u8BAE\u9898",
    "",
    ...topicLines(topic),
    "",
    "## \u6309\u4EC0\u4E48\u770B",
    "",
    ...checklistLines2(checklist),
    "",
    "## \u600E\u4E48\u4EA4\u610F\u89C1",
    "",
    "\u4ECE\u4F60\u8FD9\u4F4D\u4E13\u5458\u7684\u89D2\u5EA6\u9010\u6761\u5199\uFF1A\u770B\u5230\u7684\u98CE\u9669\u6216\u597D\u5904 \u2192 \u4F9D\u636E\uFF08\u770B\u4E86\u54EA\u91CC\u3001\u54EA\u6761\u8981\u70B9\u6216\u5E95\u7EBF\uFF09\u2192 \u5EFA\u8BAE\u3002\u8BC1\u636E\u6765\u81EA\u4F60\u521A\u770B\u8FC7\u7684\u6750\u6599\u6216\u547D\u4EE4\u8F93\u51FA\uFF0C\u4E0D\u51ED\u5370\u8C61\u3002",
    "\u56DE\u590D\u7684\u6700\u540E\u4E00\u884C\u53EA\u5199\u7ACB\u573A\uFF0C\u56DB\u9009\u4E00\uFF1A",
    "- `\u610F\u89C1\uFF1A\u540C\u610F`\uFF08\u53EF\u5728\u540E\u9762\u52A0\u4E00\u53E5\u8BF4\u660E\uFF09",
    "- `\u610F\u89C1\uFF1A\u6709\u6761\u4EF6\u540C\u610F\uFF1A<\u6761\u4EF6>`",
    "- `\u610F\u89C1\uFF1A\u53CD\u5BF9\uFF1A<\u539F\u56E0>`",
    "- `\u610F\u89C1\uFF1A\u5426\u51B3\uFF1A<\u8D8A\u8FC7\u4E86\u54EA\u6761\u5E95\u7EBF>`\uFF08\u53EA\u6709\u8D8A\u8FC7\u5E95\u7EBF\u624D\u7528\uFF1B\u5426\u51B3\u987B\u4E0A\u4EA4\u7528\u6237\uFF0Cleader \u4E0D\u80FD\u81EA\u884C\u63A8\u7FFB\uFF09",
    ""
  ].join("\n");
}
function summaryBrief(topic, opinions, comment) {
  return [
    `# \u4F1A\u5BA1\u6C47\u603B\uFF1A${topic.topic}`,
    "",
    `\u4F60\u4EE3${topic.leader}\u4E3B\u6301\u4F1A\u5BA1 ${topic.ref}\uFF1A\u53D7\u9080\u4E13\u5458\u5DF2\u5404\u81EA\u51FA\u4E86\u610F\u89C1\uFF08\u539F\u6587\u5728\u4E0B\u9762\uFF09\uFF0C\u8BF7\u6C47\u603B\u4E00\u81F4\u4E0E\u51B2\u7A81\uFF0C\u80FD\u5B9A\u7684\u81EA\u5DF1\u5B9A\u3002`,
    "\u53EA\u6C47\u603B\u4E0E\u62CD\u677F\uFF0C\u4E0D\u52A8\u624B\u5B9E\u73B0\uFF1A\u4E0D\u8981\u6539\u6587\u4EF6\u3001\u63D0\u4EA4\u3001\u63A8\u9001\u6216\u5F00 PR\u3002",
    "",
    "## \u8BAE\u9898",
    "",
    ...topicLines(topic),
    "",
    "## \u5404\u65B9\u610F\u89C1",
    "",
    ...opinions.flatMap((o) => [
      `### ${o.name}\uFF08${o.ref} \xB7 ${o.task}\uFF09\uFF1A${STANCE_LABEL[o.stance]}${o.reason ? `\u2014\u2014${o.reason}` : ""}`,
      "",
      o.text?.trim() ? clip2(o.text.trim(), OPINION_MAX) : "\uFF08\u6CA1\u6709\u610F\u89C1\u539F\u6587\uFF09",
      ""
    ]),
    "## \u600E\u4E48\u6C47\u603B",
    "",
    "- \u4E00\u81F4\uFF1A\u5404\u65B9\u90FD\u8BA4\u53EF\u7684\u505A\u6CD5\u6216\u98CE\u9669\u3002",
    "- \u51B2\u7A81\uFF1A\u4E13\u5458\u4E4B\u95F4\u610F\u89C1\u4E0D\u540C\u7684\u5730\u65B9\uFF0C\u5199\u6E05\u5404\u65B9\u4E3B\u5F20\uFF1B\u80FD\u6309\u7EC4\u7EC7\u76EE\u6807\u4E0E\u8981\u70B9\u5B9A\u7684\uFF0C\u7ED9\u51FA\u53D6\u820D\u548C\u7406\u7531\u3002",
    "- \u53EA\u6709\u4E24\u7C7B\u4E8B\u4E0A\u4EA4\u7528\u6237\uFF1A\u78B0\u5230\u7528\u6237\u5B9A\u7684\u8FB9\u754C\uFF08\u786C\u8FB9\u754C\u3001\u9884\u7B97\u3001\u5BF9\u5916\u516C\u5F00\u3001\u4E0D\u53EF\u64A4\u56DE\u7684\u6570\u636E\u64CD\u4F5C\u7B49\uFF09\uFF0C\u6216\u4E13\u5458\u4E4B\u95F4\u8C08\u4E0D\u62E2\u3001\u4F60\u4E5F\u5B9A\u4E0D\u4E86\u3002\u6BCF\u6761\u5199\u4E00\u884C `\u9700\u7528\u6237\u62CD\u677F\uFF1A<\u8981\u7528\u6237\u5B9A\u4EC0\u4E48\u3001\u6709\u54EA\u51E0\u4E2A\u9009\u9879\u3001\u5404\u81EA\u4EE3\u4EF7>`\u3002",
    "- \u6709\u4E13\u5458\u4EE5\u5E95\u7EBF\u5426\u51B3\u7684\uFF0C\u4E0D\u80FD\u81EA\u884C\u63A8\u7FFB\uFF1A\u8981\u4E48\u6309\u5426\u51B3\u8C03\u6574\u7ED3\u8BBA\uFF0C\u8981\u4E48\u5199 `\u9700\u7528\u6237\u62CD\u677F\uFF1A`\u3002",
    "- \u6CA1\u51FA\u610F\u89C1\u7684\u4E13\u5458\uFF0C\u5728\u51B2\u7A81\u6216\u7ED3\u8BBA\u91CC\u8BF4\u660E\u7F3A\u4E86\u8C01\u3001\u5F71\u54CD\u591A\u5927\u3002",
    ...comment ? [
      `- \u628A\u6C47\u603B\uFF08\u4E00\u81F4\u3001\u51B2\u7A81\u3001\u9700\u7528\u6237\u62CD\u677F\u3001\u7ED3\u8BBA\uFF09\u4F5C\u4E3A\u4E00\u6761\u8BC4\u8BBA\u53D1\u5230 issue #${topic.issue}\uFF08gh \u547D\u4EE4\u5E26 -R \u6307\u5411\u8BE5\u4ED3\u5E93\uFF09\uFF0C\u5E76\u5728\u56DE\u590D\u91CC\u9644\u8BC4\u8BBA\u94FE\u63A5\u3002`
    ] : [],
    "",
    "\u56DE\u590D\u683C\u5F0F\uFF1A",
    "",
    "```",
    "## \u4E00\u81F4",
    "- \u2026",
    "## \u51B2\u7A81",
    "- \u2026\uFF08\u5404\u65B9\u4E3B\u5F20\uFF1B\u4F60\u7684\u53D6\u820D\u4E0E\u7406\u7531\uFF09",
    "\u9700\u7528\u6237\u62CD\u677F\uFF1A\u2026\uFF08\u6BCF\u6761\u4E00\u884C\uFF1B\u6CA1\u6709\u5C31\u4E0D\u5199\u8FD9\u4E00\u884C\uFF09",
    "\u7ED3\u8BBA\uFF1A<\u4E00\u53E5\u8BDD\uFF0C\u540E\u7EED\u4EFB\u52A1\u7167\u6B64\u6267\u884C>",
    "```",
    "",
    "\u6700\u540E\u4E00\u884C\u5FC5\u987B\u662F\u300C\u7ED3\u8BBA\uFF1A\u2026\u300D\u3002",
    ""
  ].join("\n");
}

// server/tasks/ledger-validate.ts
import { isAbsolute as isAbsolute3 } from "node:path";

// server/tasks/state.ts
var TASK_STATUSES = [
  "todo",
  "running",
  "done",
  "failed",
  "blocked",
  "cancelled"
];
var isTaskStatus = (value) => typeof value === "string" && TASK_STATUSES.includes(value);
var FINISHED = /* @__PURE__ */ new Set([
  "done",
  "failed",
  "cancelled"
]);
var reject = (reason) => ({ ok: false, reason });
var to = (from, status) => ({
  ok: true,
  status,
  changed: from !== status
});
function transition(from, event) {
  switch (event.kind) {
    case "start":
      if (from === "todo" || from === "failed" || from === "blocked")
        return to(from, "running");
      if (from === "running") return reject("\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\uFF0C\u4E0D\u80FD\u91CD\u590D\u542F\u52A8");
      return reject(`\u4EFB\u52A1\u5DF2${label2[from]}\uFF0C\u8981\u91CD\u505A\u5148\u6539\u56DE todo`);
    case "exit_ok":
    case "exit_fail":
      if (from !== "running")
        return reject(`\u4EFB\u52A1\u4E0D\u5728\u8FD0\u884C\uFF08\u5F53\u524D ${from}\uFF09\uFF0C\u5FFD\u7565\u6267\u884C\u8005\u9000\u51FA`);
      return to(from, event.kind === "exit_ok" ? "done" : "failed");
    case "accept":
      if (from === "running" || from === "blocked") return to(from, "done");
      return reject(`\u4EFB\u52A1\u5F53\u524D ${from}\uFF0C\u4E0D\u80FD\u6309\u9A8C\u6536\u901A\u8FC7\u6536\u5C3E`);
    case "block":
      if (from === "todo" || from === "running") return to(from, "blocked");
      if (from === "blocked") return reject("\u4EFB\u52A1\u5DF2\u7ECF\u53D7\u963B");
      return reject(`\u4EFB\u52A1\u5DF2${label2[from]}\uFF0C\u4E0D\u80FD\u518D\u6807\u53D7\u963B`);
    case "cancel":
      if (from === "done") return reject("\u4EFB\u52A1\u5DF2\u5B8C\u6210\uFF0C\u4E0D\u80FD\u53D6\u6D88");
      if (from === "cancelled") return reject("\u4EFB\u52A1\u5DF2\u7ECF\u53D6\u6D88");
      return to(from, "cancelled");
    case "manual_set":
      if (!isTaskStatus(event.to)) return reject("\u672A\u77E5\u7684\u4EFB\u52A1\u72B6\u6001");
      if (event.to === "running" && from !== "running")
        return reject("running \u53EA\u80FD\u7531\u6267\u884C\u8005\u542F\u52A8\u8FDB\u5165\uFF0C\u8BF7\u7528 atrium task run");
      return to(from, event.to);
  }
}
var label2 = {
  todo: "\u5F85\u529E",
  running: "\u8FD0\u884C",
  done: "\u5B8C\u6210",
  failed: "\u5931\u8D25",
  blocked: "\u53D7\u963B",
  cancelled: "\u53D6\u6D88"
};

// server/tasks/ledger-validate.ts
var TITLE_MAX = 200;
var TEXT_MAX = 4096;
var DEFAULT_OWNER = "secretary";
var OWNER_RE = /^[\p{L}\p{N}_.-]{1,60}$/u;
function ownerOf(value, field2 = "owner") {
  if (typeof value !== "string" || !OWNER_RE.test(value.trim()))
    throw usage(`${field2}: \u8BA2\u9605\u8005\u540D\u53EA\u80FD\u7528\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ . -\uFF0C1\uFF5E60 \u5B57`);
  return value.trim();
}
function attributedAuthor(value, actor) {
  const by = value === void 0 ? actor ?? "u1" : ownerOf(value, "by");
  if (actor && by !== actor)
    throw new Problem(403, `by: \u53EA\u80FD\u4EE5\u81EA\u5DF1\u7684\u8EAB\u4EFD\uFF08${actor}\uFF09\u5199\u5165`, "forbidden");
  return actor ?? by;
}
var optionalText = (value, field2, max = TEXT_MAX) => {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw usage(`${field2}: \u5E94\u4E3A\u6587\u672C`);
  const text6 = value.trim();
  if (!text6) return null;
  if (text6.length > max) throw usage(`${field2}: \u4E0D\u80FD\u8D85\u8FC7 ${max} \u5B57`);
  return text6;
};
var title = (value) => {
  if (typeof value !== "string" || !value.trim())
    throw usage("title: \u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
  const text6 = value.replace(/\s+/g, " ").trim();
  if (text6.length > TITLE_MAX)
    throw usage(`title: \u6807\u9898\u4E0D\u80FD\u8D85\u8FC7 ${TITLE_MAX} \u5B57`);
  return text6;
};
var statusOf = (value, field2 = "status") => {
  if (!isTaskStatus(value))
    throw usage(`${field2}: \u53EA\u80FD\u662F ${TASK_STATUSES.join("\u3001")}`);
  return value;
};
var repoOf = (value) => {
  const repo = optionalText(value, "repo");
  if (repo && !isAbsolute3(repo)) throw usage("repo: \u5E94\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  return repo;
};
var objectOf2 = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usage("\u8BF7\u6C42\u4F53\u5E94\u4E3A JSON \u5BF9\u8C61");
  return value;
};
var onlyKeys = (input, allowed3) => {
  const extra = Object.keys(input).filter((key) => !allowed3.includes(key));
  if (extra.length)
    throw usage(
      `\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5\uFF1A${extra.join("\u3001")}\uFF1B\u53EF\u7528 ${allowed3.join("\u3001")}`
    );
};
function parentOf(db, value) {
  if (value === void 0 || value === null || value === "") return null;
  const id3 = parseTaskRef(value, "parent");
  if (!row(db, id3))
    throw usage(`parent: \u7236\u4EFB\u52A1 ${taskRef(id3)} \u4E0D\u5B58\u5728`, "atrium task ls");
  return id3;
}

// server/tasks/notes.ts
var isProcessing = (status, noteId, blockedId) => status === "blocked" && noteId !== null && blockedId !== null && noteId > blockedId;
function leaderName(db, by) {
  const match = /^a([1-9][0-9]{0,8})$/.exec(by);
  if (!match || !one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='org_leaders'"
  ))
    return null;
  return one(
    db,
    "SELECT name FROM org_leaders WHERE id=?",
    Number(match[1])
  )?.name ?? null;
}
function noteView(db, id3, status) {
  const note = one(
    db,
    "SELECT * FROM task_events WHERE task_id=? AND kind='note' ORDER BY id DESC LIMIT 1",
    id3
  );
  let text6 = null;
  let by = null;
  if (note?.detail) {
    try {
      const parsed = JSON.parse(note.detail);
      if (parsed && typeof parsed === "object") {
        const detail2 = parsed;
        if (typeof detail2.text === "string" && typeof detail2.by === "string") {
          text6 = detail2.text;
          by = detail2.by;
        }
      }
    } catch {
    }
  }
  const blocked = status === "blocked" && text6 !== null ? one(
    db,
    "SELECT id FROM task_events WHERE task_id=? AND kind IN ('block','manual_set') ORDER BY id DESC LIMIT 1",
    id3
  ) : void 0;
  return {
    note: text6,
    note_by: by,
    note_by_name: by === null ? null : leaderName(db, by),
    note_at: text6 === null ? null : note.at,
    processing: isProcessing(
      status,
      text6 === null ? null : note.id,
      blocked?.id ?? null
    )
  };
}
function addTaskNote(db, reference, body3, now = Date.now(), actor) {
  const id3 = parseTaskRef(reference);
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw usage("\u8BF7\u6C42\u4F53\u5E94\u4E3A JSON \u5BF9\u8C61");
  const input = body3;
  if (Object.keys(input).some((key) => !["text", "by", "verdict"].includes(key)))
    throw usage("\u53EA\u63A5\u53D7 text\u3001by\u3001verdict \u5B57\u6BB5");
  if (input.verdict !== void 0 && !["ok", "fixed", "rejected"].includes(String(input.verdict)))
    throw usage("verdict: \u53EA\u80FD\u662F ok\u3001fixed\u3001rejected");
  if (typeof input.text !== "string" || !input.text.trim())
    throw usage("text: \u5907\u6CE8\u4E0D\u80FD\u4E3A\u7A7A");
  const text6 = input.text.trim();
  if ([...text6].length > 300) throw usage("text: \u5907\u6CE8\u4E0D\u80FD\u8D85\u8FC7 300 \u5B57");
  const by = attributedAuthor(input.by, actor);
  return atomically(db, () => {
    const task = requireRow(db, id3);
    addEvent(db, id3, now, "note", {
      text: text6,
      by,
      ...input.verdict ? { verdict: input.verdict } : {}
    });
    db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now, id3);
    return { ...noteView(db, id3, task.status) };
  });
}

// server/tasks/tell.ts
var TELL_MAX_CHARS = 4e3;
function tellModeOf(adapter, override) {
  if (!TELL_MODES.includes(override))
    return adapter.tell;
  const mode = override;
  if (mode === "stdin" && adapter.tell !== "stdin") return adapter.tell;
  if (mode === "resume" && !adapter.resume) return adapter.tell;
  return mode;
}
function routeTell(input) {
  if (input.status === "done" || input.status === "cancelled")
    return {
      kind: "reject",
      reason: `\u4EFB\u52A1\u5DF2${input.status === "done" ? "\u5B8C\u6210" : "\u53D6\u6D88"}\uFF0C\u634E\u8BDD\u9001\u4E0D\u5230\uFF1B\u8981\u6539\u9700\u6C42\u8BF7\u5EFA\u65B0\u4EFB\u52A1\u6216\u6539\u56DE todo \u540E\u91CD\u6D3E`
    };
  if (!input.running || !input.mode) return { kind: "next_run" };
  if (input.mode === "stdin")
    return { kind: input.live ? "stdin" : "after_turn" };
  return { kind: input.mode === "resume" ? "after_turn" : "restart" };
}
function afterExit(input) {
  if (input.stop?.kind === "tell") return "restart";
  if (input.stop || input.pending === 0) return "settle";
  const clean = input.exit === "unknown" || input.exit.code === 0 && input.exit.signal === null;
  if (!clean) return "settle";
  return input.session && input.mode !== "restart" ? "resume" : "restart";
}
var time = (at) => new Date(at).toLocaleString("zh-CN", { hour12: false });
var tellMessage = (tell) => `\u8865\u5145\u8BF4\u660E\uFF08${tell.by} \xB7 ${time(tell.at)}\uFF09\uFF1A

${tell.text}

\u4E0E\u524D\u6587\u51B2\u7A81\u65F6\u4EE5\u8FD9\u6761\u4E3A\u51C6\u3002`;
function resumeMessage(tells) {
  if (tells.length === 1) return tellMessage(tells[0]);
  return [
    "\u672C\u8F6E\u7ED3\u675F\u540E\u6536\u5230\u4EE5\u4E0B\u8865\u5145\u8BF4\u660E\uFF0C\u4E0E\u524D\u6587\u51B2\u7A81\u65F6\u4EE5\u6700\u65B0\u7684\u4E3A\u51C6\uFF1A",
    ...tells.map((tell) => `- ${tell.by} \xB7 ${time(tell.at)}\uFF1A${tell.text}`)
  ].join("\n\n");
}
function tellSection(tells) {
  if (!tells.length) return void 0;
  return [
    "\u4E4B\u524D\u8FD0\u884C\u4E2D\u6536\u5230\u7684\u8865\u5145\u8BF4\u660E\uFF08\u6309\u65F6\u95F4\u5148\u540E\uFF0C\u4E0E\u4E0A\u6587\u51B2\u7A81\u65F6\u4EE5\u6700\u65B0\u7684\u4E3A\u51C6\uFF09\uFF1A",
    ...tells.map((tell) => `- ${tell.by} \xB7 ${time(tell.at)}\uFF1A${tell.text}`)
  ].join("\n");
}
var TELL_RULE = "\u8FD0\u884C\u4E2D\u53EF\u80FD\u6536\u5230\u8865\u5145\u8BF4\u660E\uFF08\u65B0\u7684\u7528\u6237\u6D88\u606F\uFF0C\u6216\u672C\u8F6E\u7ED3\u675F\u540E\u63A5\u7740\u539F\u4F1A\u8BDD\u53D1\u6765\uFF09\uFF1B\u4E0E\u524D\u6587\u51B2\u7A81\u65F6\u4EE5\u6700\u65B0\u7684\u4E3A\u51C6\u3002";

// server/tasks/tell-ledger.ts
var TELLS_MAX = 50;
function parse(row3) {
  try {
    const d = JSON.parse(row3.detail ?? "");
    if (typeof d.text !== "string" || typeof d.by !== "string")
      return void 0;
    return {
      id: row3.id,
      at: row3.at,
      text: d.text,
      by: d.by,
      uuid: typeof d.uuid === "string" ? d.uuid : "",
      route: d.route ?? "next_run",
      state: d.state ?? "pending",
      ...d.delivered_via ? { delivered_via: d.delivered_via } : {},
      ...d.delivered_at ? { delivered_at: d.delivered_at } : {}
    };
  } catch {
    return void 0;
  }
}
function tellInput(body3, actor) {
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw usage("\u8BF7\u6C42\u4F53\u5E94\u4E3A JSON \u5BF9\u8C61");
  const input = body3;
  if (Object.keys(input).some((key) => key !== "text" && key !== "by"))
    throw usage("\u53EA\u63A5\u53D7 text\u3001by \u5B57\u6BB5");
  if (typeof input.text !== "string" || !input.text.trim())
    throw usage("text: \u634E\u8BDD\u4E0D\u80FD\u4E3A\u7A7A");
  const text6 = input.text.trim();
  if ([...text6].length > TELL_MAX_CHARS)
    throw usage(`text: \u634E\u8BDD\u4E0D\u80FD\u8D85\u8FC7 ${TELL_MAX_CHARS} \u5B57`);
  const by = attributedAuthor(input.by, actor);
  return { text: text6, by };
}
function addTell(db, id3, tell, now = Date.now()) {
  return atomically(db, () => {
    requireRow(db, id3);
    const detail2 = { ...tell, state: "pending" };
    addEvent(db, id3, now, "tell", detail2);
    db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now, id3);
    const row3 = one(
      db,
      "SELECT * FROM task_events WHERE task_id=? AND kind='tell' ORDER BY id DESC LIMIT 1",
      id3
    );
    return parse(row3);
  });
}
function listTells(db, id3) {
  return all(
    db,
    "SELECT * FROM (SELECT * FROM task_events WHERE task_id=? AND kind='tell' ORDER BY id DESC LIMIT ?) ORDER BY id",
    id3,
    TELLS_MAX
  ).map(parse).filter((tell) => !!tell);
}
var unsent = (tells) => tells.filter((tell) => tell.state !== "delivered");
function update(db, tell, patch) {
  const { id: _id, at: _at, ...rest } = tell;
  db.prepare("UPDATE task_events SET detail=? WHERE id=? AND kind='tell'").run(
    JSON.stringify({ ...rest, ...patch }),
    tell.id
  );
}
function markWritten(db, tell) {
  update(db, tell, { state: "written" });
}
function markDelivered(db, taskId, ids, via, now = Date.now()) {
  if (!ids.length) return 0;
  return atomically(db, () => {
    let changed2 = 0;
    for (const tell of listTells(db, taskId))
      if (ids.includes(tell.id) && tell.state !== "delivered") {
        update(db, tell, {
          state: "delivered",
          delivered_via: via,
          delivered_at: now
        });
        changed2++;
      }
    return changed2;
  });
}
function markEchoed(db, taskId, uuid) {
  const tell = listTells(db, taskId).find((item) => item.uuid === uuid);
  return tell ? markDelivered(db, taskId, [tell.id], "stdin") : 0;
}
function tellCounts(db, ids) {
  const counts = /* @__PURE__ */ new Map();
  if (!ids.length) return counts;
  for (const row3 of all(
    db,
    `SELECT * FROM task_events WHERE kind='tell' AND task_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
    ...ids
  )) {
    const tell = parse(row3);
    if (!tell) continue;
    const entry = counts.get(row3.task_id) ?? { total: 0, pending: 0 };
    entry.total++;
    if (tell.state !== "delivered") entry.pending++;
    counts.set(row3.task_id, entry);
  }
  return counts;
}

// server/memos/store.ts
var MEMO_MAX = 2e3;
function ensureMemoTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memos (
    owner TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    decided_on TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    text TEXT NOT NULL,
    why TEXT NOT NULL,
    issue INTEGER, node_id INTEGER, task_id INTEGER,
    superseded_by INTEGER, superseded_at INTEGER,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS decisions_owner ON decisions(owner,superseded_by,decided_on,id);
  CREATE INDEX IF NOT EXISTS decisions_superseded ON decisions(superseded_by);`);
  const legacy = one2(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='org_leaders'"
  );
  if (legacy)
    db.exec(
      "INSERT OR IGNORE INTO memos(owner,body,updated_at) SELECT 'a'||id,memo,updated_at FROM org_leaders WHERE memo<>''"
    );
}
function memoProblem(memo, max = MEMO_MAX) {
  const size = Array.from(memo).length;
  return size > max ? `memo: \u5907\u5FD8 ${size} \u5B57\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${max} \u5B57\uFF1B\u8BF7\u7CBE\u7B80\uFF08\u7559\u7ED3\u8BBA\u4E0E\u5F85\u529E\uFF0C\u5220\u8FC7\u7A0B\uFF09\u540E\u518D\u5199` : null;
}
function memoText(value, next) {
  if (typeof value !== "string")
    throw new Problem(400, "memo: \u5E94\u4E3A\u6587\u672C", "usage");
  const text6 = value.trim();
  const problem = memoProblem(text6);
  if (problem) throw new Problem(400, problem, "usage", void 0, next);
  return text6;
}
function readMemo(db, owner) {
  const row3 = one2(
    db,
    "SELECT body,updated_at FROM memos WHERE owner=?",
    owner
  );
  return row3 ?? { body: "", updated_at: null };
}
function readMemos(db) {
  return new Map(
    all2(
      db,
      "SELECT owner,body,updated_at FROM memos ORDER BY owner LIMIT 1000"
    ).map((r) => [r.owner, { body: r.body, updated_at: r.updated_at }])
  );
}
function writeMemo(db, owner, body3, now = Date.now()) {
  db.prepare(
    "INSERT INTO memos(owner,body,updated_at) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at"
  ).run(owner, body3, now);
}

// server/leaders/model.ts
var LEADER_RE = /^a([1-9][0-9]{0,8})$/;
var NAME_MAX = 40;
function ensureLeaderTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_leaders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    worker TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    wake_at INTEGER, wake_ended_at INTEGER, wake_status TEXT,
    wake_summary TEXT, wake_note TEXT,
    wake_failures INTEGER NOT NULL DEFAULT 0,
    wakes INTEGER NOT NULL DEFAULT 0)`);
  ensureMemoTables(db);
}
var hasTable = (db, name2) => !!one2(
  db,
  "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
  name2
);
var leaderRef = (id3) => `a${id3}`;
var usage4 = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function leaderId(value, field2 = "leader") {
  const text6 = typeof value === "string" ? value.trim() : "";
  const match = LEADER_RE.exec(text6);
  if (!match)
    throw usage4(`${field2}: \u5E94\u4E3A leader \u77ED\u53F7\uFF0C\u5982 a1`, "atrium leader ls");
  return Number(match[1]);
}
function rowOf(db, id3) {
  if (!hasTable(db, "org_leaders")) return void 0;
  return one2(db, "SELECT * FROM org_leaders WHERE id=?", id3);
}
function requireLeader(db, value) {
  const id3 = leaderId(value);
  const row3 = rowOf(db, id3);
  if (!row3)
    throw new Problem(
      404,
      `${leaderRef(id3)} \u6CA1\u6709\u767B\u8BB0\u4E3A leader`,
      "not_found",
      void 0,
      `atrium leader add \u540D\u79F0 --worker claude+opus --id ${leaderRef(id3)}`
    );
  return row3;
}
var isRegistered = (db, leader) => {
  const match = LEADER_RE.exec(leader);
  return !!match && !!rowOf(db, Number(match[1]));
};
function registeredLeaders(db) {
  if (!hasTable(db, "org_leaders")) return /* @__PURE__ */ new Set();
  return new Set(
    all2(
      db,
      "SELECT id FROM org_leaders ORDER BY id LIMIT 500"
    ).map((r) => leaderRef(r.id))
  );
}
var nameOf = (value) => {
  if (typeof value !== "string" || !value.trim())
    throw usage4("name: \u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const text6 = value.replace(/\s+/g, " ").trim();
  if (Array.from(text6).length > NAME_MAX)
    throw usage4(`name: \u540D\u79F0\u81F3\u591A ${NAME_MAX} \u5B57`);
  return text6;
};
var workerOf = (value) => {
  if (typeof value !== "string" || !value.trim())
    throw usage4("worker: \u6267\u884C\u8005\u7EC4\u5408\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5982 claude+opus:high");
  try {
    return workerId(parseWorker(value));
  } catch (error) {
    throw usage4(`worker: ${error.message}`);
  }
};
var memoOf = (value, who2) => memoText(value, `atrium memo show --as ${who2}`);
var objectOf3 = (body3) => {
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw usage4("\u8BF7\u6C42\u4F53\u5E94\u4E3A\u5BF9\u8C61");
  return body3;
};
var onlyKeys2 = (input, keys) => {
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw usage4(`${key}: \u662F\u672A\u77E5\u5B57\u6BB5`);
};
function nextId(db) {
  let max = 0;
  if (hasTable(db, "org_leaders"))
    max = one2(db, "SELECT MAX(id) AS n FROM org_leaders")?.n ?? 0;
  for (const n of nodes(db)) {
    const match = n.leader ? LEADER_RE.exec(n.leader) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
function addLeader(db, body3, now = Date.now()) {
  const input = objectOf3(body3);
  onlyKeys2(input, ["name", "worker", "memo", "id"]);
  const name2 = nameOf(input.name);
  const worker = workerOf(input.worker);
  db.exec("BEGIN IMMEDIATE");
  try {
    let id3;
    if (input.id !== void 0 && input.id !== null && input.id !== "") {
      id3 = leaderId(input.id, "id");
      if (rowOf(db, id3))
        throw new Problem(
          409,
          `${leaderRef(id3)} \u5DF2\u767B\u8BB0`,
          "conflict",
          void 0,
          `atrium leader show ${leaderRef(id3)}`
        );
    } else id3 = nextId(db);
    const memo = input.memo === void 0 ? "" : memoOf(input.memo, leaderRef(id3));
    db.prepare(
      "INSERT INTO org_leaders(id,name,worker,created_at,updated_at) VALUES (?,?,?,?,?)"
    ).run(id3, name2, worker, now, now);
    if (memo) writeMemo(db, leaderRef(id3), memo, now);
    db.exec("COMMIT");
    return showLeader(db, leaderRef(id3));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function editLeader(db, reference, body3, now = Date.now()) {
  const row3 = requireLeader(db, reference);
  const input = objectOf3(body3);
  onlyKeys2(input, ["name", "worker", "memo"]);
  if (!Object.keys(input).length)
    throw usage4("\u81F3\u5C11\u6539\u4E00\u9879\uFF1A--name\u3001--worker \u6216 --memo");
  const name2 = input.name === void 0 ? row3.name : nameOf(input.name);
  const worker = input.worker === void 0 ? row3.worker : workerOf(input.worker);
  const memo = input.memo === void 0 ? void 0 : memoOf(input.memo, leaderRef(row3.id));
  transaction(db, () => {
    db.prepare(
      "UPDATE org_leaders SET name=?,worker=?,updated_at=? WHERE id=?"
    ).run(name2, worker, now, row3.id);
    if (memo !== void 0) writeMemo(db, leaderRef(row3.id), memo, now);
  });
  return showLeader(db, leaderRef(row3.id));
}
var wakeOf = (row3) => row3.wake_at === null || row3.wake_status === null ? null : {
  at: row3.wake_at,
  ended_at: row3.wake_ended_at,
  status: row3.wake_status,
  summary: row3.wake_summary,
  note: row3.wake_note,
  failures: row3.wake_failures,
  count: row3.wakes
};
function ledNodes(db) {
  const list4 = nodes(db);
  const map = /* @__PURE__ */ new Map();
  for (const n of list4)
    if (n.leader && n.archived_at === null && LEADER_RE.test(n.leader))
      map.set(n.leader, [
        ...map.get(n.leader) ?? [],
        { ref: ref(n.id), name: n.name, path: nodePath(list4, n) }
      ]);
  return map;
}
var viewOf = (row3, led, memo) => ({
  ref: leaderRef(row3.id),
  name: row3.name,
  worker: row3.worker,
  memo: memo.body,
  memo_max: MEMO_MAX,
  nodes: led.get(leaderRef(row3.id)) ?? [],
  wake: wakeOf(row3),
  created_at: row3.created_at,
  updated_at: row3.updated_at
});
function showLeader(db, reference) {
  const row3 = requireLeader(db, reference);
  return viewOf(row3, ledNodes(db), readMemo(db, leaderRef(row3.id)));
}
function listLeaders(db) {
  const led = ledNodes(db);
  const rows = hasTable(db, "org_leaders") ? all2(db, "SELECT * FROM org_leaders ORDER BY id LIMIT 500") : [];
  const known = new Set(rows.map((r) => leaderRef(r.id)));
  const memos = readMemos(db);
  const empty3 = { body: "", updated_at: null };
  return {
    leaders: rows.map(
      (r) => viewOf(r, led, memos.get(leaderRef(r.id)) ?? empty3)
    ),
    busy: rows.filter((r) => r.wake_status === "running" && r.wake_at !== null).map((r) => ({
      ref: leaderRef(r.id),
      name: r.name,
      doing: r.wake_summary ?? "",
      since: r.wake_at
    })),
    unregistered: [...led].filter(([who2]) => !known.has(who2)).map(([who2, list4]) => ({ ref: who2, nodes: list4 }))
  };
}
function leaderBriefs(db) {
  const map = /* @__PURE__ */ new Map();
  if (!hasTable(db, "org_leaders")) return map;
  for (const row3 of all2(
    db,
    "SELECT * FROM org_leaders ORDER BY id LIMIT 500"
  ))
    map.set(leaderRef(row3.id), {
      ref: leaderRef(row3.id),
      name: row3.name,
      wake: wakeOf(row3)
    });
  return map;
}
function markWakeStart(db, leader, summary2, now = Date.now()) {
  db.prepare(
    "UPDATE org_leaders SET wake_at=?,wake_ended_at=NULL,wake_status='running',wake_summary=?,wake_note=NULL,wakes=wakes+1 WHERE id=?"
  ).run(now, summary2, leaderId(leader));
}
function markWakeEnd(db, leader, status, failures, note, now = Date.now()) {
  db.prepare(
    "UPDATE org_leaders SET wake_ended_at=?,wake_status=?,wake_failures=?,wake_note=? WHERE id=?"
  ).run(now, status, failures, note, leaderId(leader));
}
function closeStaleWakes(db, now = Date.now()) {
  if (!hasTable(db, "org_leaders")) return;
  db.prepare(
    "UPDATE org_leaders SET wake_ended_at=?,wake_status='failed',wake_note='\u670D\u52A1\u91CD\u542F\uFF0C\u672C\u6B21\u5524\u9192\u4E2D\u65AD\uFF0C\u4E8B\u4EF6\u7A0D\u540E\u91CD\u6295' WHERE wake_status='running'"
  ).run(now);
}
var wakeFailures = (db, leader) => rowOf(db, leaderId(leader))?.wake_failures ?? 0;

// server/leaders/route.ts
var SECRETARY = "secretary";
function deliveryRoutes(kind, route) {
  if (kind !== "online" && kind !== "online_failed") return [route];
  return route.subscriber === SECRETARY ? [route] : [
    route,
    {
      subscriber: SECRETARY,
      why: "\u4E0A\u7EBF\u7ED3\u8BBA\u76F4\u63A5\u901A\u77E5\u79D8\u4E66\uFF0C\u6309\u7AEF\u5230\u7AEF\u9A8C\u8BC1\u5728\u7EBF\u4E0A\u590D\u6838",
      via: null
    }
  ];
}
var label3 = (n) => `${n.ref}\u300C${n.name}\u300D`;
function nearest(chain, registered, skip) {
  const unregistered = [];
  for (const node of chain) {
    const who2 = node.leader;
    if (!who2 || !LEADER_RE.test(who2) || who2 === skip) continue;
    if (registered.has(who2)) return { node, who: who2, unregistered };
    unregistered.push(`${who2}\uFF08${node.ref}\uFF09`);
  }
  return { node: null, who: null, unregistered };
}
var skipped = (list4) => list4.length ? `\uFF1B${list4.join("\u3001")} \u6CA1\u6709\u767B\u8BB0\u4E3A leader\uFF0C\u8DF3\u8FC7` : "";
function routeTaskEvent(input) {
  if (input.owner !== null)
    return {
      subscriber: input.owner,
      why: `\u4EFB\u52A1\u6307\u5B9A\u4E86\u8D1F\u8D23\u4EBA ${input.owner}`,
      via: null
    };
  const part = input.chain[0];
  if (!part)
    return {
      subscriber: SECRETARY,
      why: "\u4EFB\u52A1\u6CA1\u6709\u5F52\u5C5E\u90E8\u5206\uFF0C\u6295\u79D8\u4E66",
      via: null
    };
  const found = nearest(input.chain, input.registered);
  if (!found.node)
    return {
      subscriber: SECRETARY,
      why: `\u4EFB\u52A1\u5F52\u5C5E ${label3(part)}\uFF0C\u5B83\u548C\u4E0A\u7EA7\u90FD\u6CA1\u6709 leader\uFF0C\u6295\u79D8\u4E66${skipped(found.unregistered)}`,
      via: null
    };
  return {
    subscriber: found.who,
    why: found.node === part ? `\u4EFB\u52A1\u5F52\u5C5E ${label3(part)}\uFF0C\u7531\u5B83\u7684 leader ${found.who} \u5904\u7406${skipped(found.unregistered)}` : `\u4EFB\u52A1\u5F52\u5C5E ${label3(part)}\uFF0C\u6700\u8FD1\u7684 leader \u662F ${label3(found.node)}\u7684 ${found.who}${skipped(found.unregistered)}`,
    via: found.node.ref
  };
}
function escalationRoute(input) {
  for (const chain of input.chains) {
    const found = nearest(chain, input.registered, input.leader);
    if (found.node)
      return {
        subscriber: found.who,
        why: `${input.leader} \u4E0A\u4EA4\uFF0C\u4E0A\u4E00\u5C42\u7684 leader \u662F ${label3(found.node)}\u7684 ${found.who}`,
        via: found.node.ref
      };
  }
  return {
    subscriber: SECRETARY,
    why: `${input.leader} \u4E0A\u4EA4\uFF0C\u4E0A\u5C42\u6CA1\u6709\u522B\u7684 leader\uFF0C\u6295\u79D8\u4E66`,
    via: null
  };
}

// server/leaders/subscriber.ts
var PARENT_DEPTH = 50;
function chainFrom(list4, id3) {
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let current2 = id3 === null ? void 0 : list4.find((n) => n.id === id3);
  while (current2 && !seen.has(current2.id)) {
    seen.add(current2.id);
    chain.push({
      ref: ref(current2.id),
      name: current2.name,
      leader: current2.archived_at === null ? current2.leader : null
    });
    const parent = current2.parent_id;
    current2 = parent === null ? void 0 : list4.find((n) => n.id === parent);
  }
  return chain;
}
function taskPartId(db, task) {
  let current2 = task;
  for (let depth = 0; current2 && depth < PARENT_DEPTH; depth++) {
    const part = current2.part_id ?? current2.node_id;
    if (part !== null) return part;
    if (current2.parent_id === null) return null;
    current2 = one2(
      db,
      "SELECT id,parent_id,owner,part_id,node_id FROM tasks WHERE id=?",
      current2.parent_id
    );
  }
  return null;
}
function taskRoute(db, task) {
  if (!hasOrg(db))
    return {
      subscriber: task.owner ?? SECRETARY,
      why: task.owner === null ? "\u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811\uFF0C\u6295\u79D8\u4E66" : `\u4EFB\u52A1\u6307\u5B9A\u4E86\u8D1F\u8D23\u4EBA ${task.owner}`,
      via: null
    };
  return routeTaskEvent({
    owner: task.owner,
    chain: chainFrom(nodes(db), taskPartId(db, task)),
    registered: registeredLeaders(db)
  });
}
function upstreamRoute(db, leader) {
  if (!hasOrg(db))
    return escalationRoute({ leader, chains: [], registered: /* @__PURE__ */ new Set() });
  const list4 = nodes(db);
  const chains = list4.filter((n) => n.leader === leader && n.archived_at === null).map((n) => chainFrom(list4, n.parent_id));
  return escalationRoute({ leader, chains, registered: registeredLeaders(db) });
}
function partRoute(db, nodeId) {
  return routeTaskEvent({
    owner: null,
    chain: chainFrom(nodes(db), nodeId),
    registered: registeredLeaders(db)
  });
}

// server/tasks/holder.ts
var FINISHED2 = /* @__PURE__ */ new Set(["done", "failed", "cancelled"]);
function kindOf(who2) {
  if (who2 === "u1") return "user";
  if (/^a[1-9][0-9]*$/.test(who2)) return "leader";
  return "secretary";
}
function whoLabel(who2) {
  return who2 === "u1" ? "\u4F60" : who2 === "secretary" ? "\u79D8\u4E66" : who2;
}
var GATE_LABEL = {
  local_check: "\u672C\u5730\u68C0\u67E5\u6CA1\u8FC7",
  ci: "CI \u6CA1\u8FC7",
  pr_exists: "\u6CA1\u627E\u5230 PR",
  finished: "\u6267\u884C\u8005\u6CA1\u505A\u5B8C",
  file_growth: "\u6539\u52A8\u89C4\u6A21\u8D85\u9650",
  claims_verified: "\u81EA\u8FF0\u4E0E\u4E8B\u5B9E\u5BF9\u4E0D\u4E0A",
  concern: "\u4E13\u5458\u6CA1\u901A\u8FC7",
  review: "\u5BA1\u9605\u6253\u56DE"
};
function blockShort(block) {
  if (!block) return "\u53D7\u963B";
  const gate = block.gates.find((g) => GATE_LABEL[g]);
  if (gate) return GATE_LABEL[gate];
  const reason = (block.reason ?? "").trim();
  if (!reason) return "\u53D7\u963B";
  const first = reason.split(/[：；\n]/)[0].trim() || reason;
  const chars4 = Array.from(first);
  return chars4.length > 30 ? `${chars4.slice(0, 29).join("")}\u2026` : first;
}
function holderOf(f) {
  if (f.council_escalated)
    return { kind: "user", who: "u1", text: "\u4F1A\u5BA1\u4E0A\u4EA4\uFF0C\u7B49\u4F60\u62CD\u677F" };
  if (f.delivery_stage === "reviewing")
    return {
      kind: "merge",
      who: null,
      text: `\u5408\u5165\u524D\u5BA1\u9605\u4E2D${f.review_task ? `\uFF08${f.review_task}\uFF09` : ""}`
    };
  if (f.delivery_stage === "merge_queued")
    return { kind: "merge", who: null, text: "\u6392\u961F\u5408\u5165" };
  if (f.delivery_stage === "merging")
    return { kind: "merge", who: null, text: "\u5408\u5165\u4E2D\uFF1Arebase \u5E76\u91CD\u8DD1\u672C\u5730\u68C0\u67E5" };
  if (f.delivery_stage === "merged" && f.online_wait === 1)
    return { kind: "merge", who: null, text: "\u5DF2\u5408\u5165\uFF0C\u7B49\u53D1\u7248\u4E0A\u7EBF" };
  if (FINISHED2.has(f.status)) return null;
  if (f.queued)
    return {
      kind: "queue",
      who: null,
      text: `\u6392\u961F${f.queued.reason ? `\uFF1A${f.queued.reason}` : ""}`
    };
  if (f.status === "running") {
    const worker = f.worker ?? "\u6267\u884C\u8005";
    if (f.returned?.via === "merge")
      return {
        kind: "worker",
        who: f.worker,
        text: `\u5408\u5165\u6CA1\u8FC7${f.merge_returned ? `\uFF08${f.merge_returned}\uFF09` : ""} \xB7 \u5DF2\u4EA4\u56DE\u6267\u884C\u8005`
      };
    if (f.returned)
      return {
        kind: "worker",
        who: f.worker,
        text: `${blockShort(f.block)} \xB7 ${f.returned.by ? `${whoLabel(f.returned.by)} ` : ""}\u5DF2\u4EA4\u56DE\u6267\u884C\u8005`
      };
    return { kind: "worker", who: f.worker, text: `${worker} \u5728\u505A` };
  }
  if (f.status === "blocked") {
    const why = blockShort(f.block);
    if (f.escalated)
      return {
        kind: kindOf(f.escalated.to),
        who: f.escalated.to,
        text: `${why} \xB7 ${whoLabel(f.escalated.from)} \u4E0A\u4EA4${f.escalated.to === "u1" ? "\uFF0C\u7B49\u4F60" : `\u7ED9${whoLabel(f.escalated.to)}`}`
      };
    if (f.processing_by)
      return {
        kind: kindOf(f.processing_by),
        who: f.processing_by,
        text: `${why} \xB7 ${f.processing_by === "u1" ? "\u4F60\u5728\u5904\u7406" : `${whoLabel(f.processing_by)} \u5728\u5904\u7406`}`
      };
    const who2 = f.inbox?.subscriber ?? f.route;
    return {
      kind: kindOf(who2),
      who: who2,
      text: who2 === "u1" ? `${why} \xB7 \u7B49\u4F60\u5904\u7406` : `${why} \xB7 ${f.inbox?.acked ? `${whoLabel(who2)} \u5DF2\u63A5\u624B` : `\u7B49 ${whoLabel(who2)} \u5904\u7406`}`
    };
  }
  if (f.schedule_state === "waiting")
    return {
      kind: "queue",
      who: null,
      text: `\u7B49\u4E0A\u6E38${f.schedule_reason ? `\uFF1A${f.schedule_reason}` : "\u5B8C\u6210"}`
    };
  if (f.auto) return { kind: "queue", who: null, text: "\u5C31\u7EEA\uFF0C\u81EA\u52A8\u6D3E\u53D1" };
  return {
    kind: kindOf(f.route),
    who: f.route,
    text: f.route === "u1" ? "\u5F85\u6D3E\uFF1A\u7B49\u4F60\u6D3E\u6D3B" : `\u5F85\u6D3E\uFF1A\u7B49 ${whoLabel(f.route)} \u6D3E\u6D3B`
  };
}

// server/tasks/holder-facts.ts
var KINDS = [
  "block",
  "tell",
  "start",
  "merge_returned",
  "escalated",
  "note"
];
function parse2(detail2) {
  if (!detail2) return {};
  try {
    const value = JSON.parse(detail2);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
var text2 = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
function blockOf(event) {
  const outer = parse2(event.detail);
  const inner2 = outer.detail && typeof outer.detail === "object" ? outer.detail : {};
  const gates = Array.isArray(inner2.gates) ? inner2.gates : [];
  return {
    reason: text2(inner2.reason) ?? text2(outer.reason),
    gates: gates.filter((g) => typeof g === "string")
  };
}
var hasTable2 = (db, name2) => !!one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name2);
function holderFacts(db, row3, queued2, tables = { inbox: hasTable2(db, "task_inbox") }) {
  const events2 = all(
    db,
    `SELECT * FROM task_events WHERE task_id=? AND kind IN (${KINDS.map(() => "?").join(",")})
      ORDER BY id DESC LIMIT 40`,
    row3.id,
    ...KINDS
  ).reverse();
  const last = (kind, after = 0) => events2.findLast((e) => e.kind === kind && e.id > after);
  const block = last("block");
  const mergeBack = last("merge_returned");
  const setback = block && mergeBack ? block.id > mergeBack.id ? block : mergeBack : block ?? mergeBack;
  const since = setback?.id ?? 0;
  const start = setback ? last("start", since) : void 0;
  let returned = null;
  if (setback && start && row3.status === "running") {
    if (setback.kind === "merge_returned")
      returned = { by: null, via: "merge" };
    else {
      const tell = events2.findLast(
        (e) => e.kind === "tell" && e.id > since && e.id < start.id
      );
      returned = tell ? { by: text2(parse2(tell.detail).by), via: "tell" } : { by: null, via: "rerun" };
    }
  }
  const escalation = block ? last("escalated", block.id) : void 0;
  const escalated = escalation ? (() => {
    const detail2 = parse2(escalation.detail);
    const to2 = text2(detail2.to);
    return to2 ? { to: to2, from: text2(detail2.from) ?? "leader" } : null;
  })() : null;
  const note = block ? last("note", block.id) : void 0;
  const inbox = row3.status === "blocked" && block && tables.inbox ? one(
    db,
    "SELECT subscriber,acked_at FROM task_inbox WHERE task_id=? AND created_at>=? ORDER BY id DESC LIMIT 1",
    row3.id,
    block.at
  ) : void 0;
  const council = one(
    db,
    "SELECT stage FROM task_councils WHERE task_id=?",
    row3.id
  );
  return {
    status: row3.status,
    delivery_stage: row3.delivery_stage,
    online_wait: row3.online_wait,
    worker: row3.worker,
    queued: queued2,
    review_task: row3.review_task ? taskRef(row3.review_task) : null,
    schedule_state: row3.schedule_state,
    schedule_reason: row3.schedule_reason,
    auto: row3.auto === 1,
    block: block ? blockOf(block) : null,
    returned,
    merge_returned: mergeBack ? text2(parse2(mergeBack.detail).reason) : null,
    escalated,
    processing_by: note ? text2(parse2(note.detail).by) : null,
    inbox: inbox ? { subscriber: inbox.subscriber, acked: inbox.acked_at !== null } : null,
    route: taskRoute(db, row3).subscriber,
    council_escalated: council?.stage === "escalated"
  };
}
function holderFor(db, row3, queued2) {
  return holderOf(holderFacts(db, row3, queued2));
}

// server/tasks/top.ts
var RECENT_MS = 10 * 6e4;
var TOP_MAX = 50;
var FINISHED_STATUSES = [...FINISHED];
function selectRows(db, now, recentMs = RECENT_MS, limit = TOP_MAX) {
  const params3 = [...FINISHED_STATUSES, now - recentMs];
  const rows = all(
    db,
    `SELECT * FROM tasks
      WHERE status IN ('running','blocked')
         OR delivery_stage IN ('reviewing','merge_queued','merging')
         OR (delivery_stage='merged' AND online_wait=1)
         OR id IN (SELECT task_id FROM task_councils WHERE stage='escalated')
         OR id IN (SELECT task_id FROM task_queue)
         OR (status IN (${FINISHED_STATUSES.map(() => "?").join(",")})
             AND updated_at >= ?)
      ORDER BY id
      LIMIT ?`,
    ...params3,
    limit + 1
  );
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
function sortRows(rows) {
  const group = (row3) => row3.queued_at !== null ? 1 : row3.delivery_stage === "merging" || row3.delivery_stage === "reviewing" ? 0 : row3.status === "running" ? 0 : row3.delivery_stage === "merge_queued" ? 1 : row3.status === "blocked" ? 2 : 3;
  const at = (row3) => group(row3) === 3 ? -(row3.delivery_stage === "merged" || row3.delivery_stage === "online" ? row3.updated_at : row3.ended_at ?? row3.updated_at) : row3.queued_at ?? row3.merge_queued_at ?? row3.started_at ?? row3.updated_at;
  return [...rows].sort((a, b) => group(a) - group(b) || at(a) - at(b));
}
function reasonOf(events2, kind) {
  const detail2 = events2.findLast((event) => event.kind === kind)?.detail;
  if (!detail2) return null;
  try {
    const parsed = JSON.parse(detail2);
    for (const value of [
      parsed.reason,
      parsed.detail && typeof parsed.detail === "object" ? parsed.detail.reason : void 0
    ])
      if (typeof value === "string" && value.trim()) return value.trim();
    return null;
  } catch {
    return null;
  }
}
function latestOf(events2, a, b) {
  const idOf2 = (kind) => events2.findLast((event) => event.kind === kind)?.id ?? 0;
  const [x, y] = [idOf2(a), idOf2(b)];
  return x === 0 && y === 0 ? null : x > y ? a : b;
}
function topRows(db, now, recentMs = RECENT_MS, limit = TOP_MAX) {
  const selected = selectRows(db, now, recentMs, limit);
  const queue = /* @__PURE__ */ new Map();
  for (const entry of all(db, "SELECT task_id,queued_at,worker FROM task_queue"))
    queue.set(entry.task_id, {
      queued_at: entry.queued_at,
      worker: entry.worker
    });
  const events2 = /* @__PURE__ */ new Map();
  const ids = selected.rows.map((row3) => row3.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    for (const event of all(
      db,
      `SELECT * FROM task_events WHERE task_id IN (${marks}) AND kind IN ('queued','block','concern_gate')
        ORDER BY task_id, id DESC`,
      ...ids
    )) {
      const history2 = events2.get(event.task_id) ?? [];
      if (!history2.some((item) => item.kind === event.kind))
        history2.push(event);
      events2.set(event.task_id, history2);
    }
  }
  const tells = tellCounts(db, ids);
  const concerns = concernStates(db, ids);
  const inbox = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_inbox'"
  ).get();
  const rows = selected.rows.map((row3) => {
    const history2 = events2.get(row3.id) ?? [];
    const waiting = queue.get(row3.id);
    return {
      ref: taskRef(row3.id),
      title: row3.title,
      status: row3.status,
      delivery_stage: row3.delivery_stage,
      merge_queued_at: row3.merge_queued_at,
      // 排队的任务账本里还没有执行者，用队列里记的那个。
      worker: row3.worker ?? waiting?.worker ?? null,
      started_at: row3.started_at,
      ended_at: row3.ended_at,
      updated_at: row3.updated_at,
      queued_at: waiting?.queued_at ?? null,
      urgent: row3.urgent === 1,
      reason: reasonOf(history2, "queued") ?? // 专员关卡的结论晚于受阻事件：否决或没出结论的原因以它为准。
      (latestOf(history2, "concern_gate", "block") === "concern_gate" && row3.status === "blocked" ? reasonOf(history2, "concern_gate") : reasonOf(history2, "block")),
      tells: tells.get(row3.id) ?? null,
      concerns: concerns.get(row3.id) ?? null,
      holder: holderOf(
        holderFacts(
          db,
          row3,
          waiting ? { reason: reasonOf(history2, "queued") } : null,
          { inbox }
        )
      ),
      ...noteView(db, row3.id, row3.status)
    };
  });
  return { rows: sortRows(rows), truncated: selected.truncated };
}
function countRows(rows) {
  const counts = {
    running: 0,
    queued: 0,
    blocked: 0,
    processing: 0,
    done: 0,
    failed: 0,
    cancelled: 0
  };
  for (const row3 of rows)
    if (row3.queued_at !== null) counts.queued++;
    else if (row3.delivery_stage === "reviewing")
      counts.reviewing = (counts.reviewing ?? 0) + 1;
    else if (row3.delivery_stage === "merge_queued")
      counts.merge_queued = (counts.merge_queued ?? 0) + 1;
    else if (row3.delivery_stage === "merging")
      counts.merging = (counts.merging ?? 0) + 1;
    else if (row3.delivery_stage === "merged")
      counts.merged = (counts.merged ?? 0) + 1;
    else if (row3.delivery_stage === "online")
      counts.online = (counts.online ?? 0) + 1;
    else if (row3.status === "running") counts.running++;
    else if (row3.status === "blocked") {
      if (row3.processing) counts.processing++;
      else counts.blocked++;
    } else if (row3.status !== "todo") counts[row3.status]++;
  return counts;
}

// server/tasks/councils.ts
var STAGE_LABEL = {
  opinions: "\u7B49\u4E13\u5458\u610F\u89C1",
  summarizing: "leader \u6C47\u603B\u4E2D",
  decided: "\u5DF2\u5B9A",
  escalated: "\u9700\u7528\u6237\u62CD\u677F"
};
function ensureCouncilTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_councils (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), topic TEXT NOT NULL, topic_brief TEXT,
    leader_node_id INTEGER, comment INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL CHECK(stage IN ('opinions','summarizing','decided','escalated')),
    conclusion TEXT, escalate TEXT, agreed TEXT, conflicts TEXT, decided_by TEXT, decided_at INTEGER,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS task_councils_stage ON task_councils(stage,task_id);
  CREATE TABLE IF NOT EXISTS council_members (
    task_id INTEGER NOT NULL REFERENCES tasks(id), node_id INTEGER NOT NULL, pos INTEGER NOT NULL,
    opinion_id INTEGER NOT NULL, PRIMARY KEY(task_id,node_id));
  CREATE INDEX IF NOT EXISTS council_members_opinion ON council_members(opinion_id);`);
  const columns = all(db, "PRAGMA table_info(task_councils)");
  if (!columns.some((column) => column.name === "topic_text"))
    db.exec("ALTER TABLE task_councils ADD COLUMN topic_text TEXT");
}
var councilRow = (db, id3) => one(db, "SELECT * FROM task_councils WHERE task_id=?", id3);
var memberRows = (db, id3) => all(
  db,
  "SELECT * FROM council_members WHERE task_id=? ORDER BY pos LIMIT 50",
  id3
);
var isOpinionTask = (db, id3) => !!one(db, "SELECT 1 FROM council_members WHERE opinion_id=? LIMIT 1", id3);
var isCouncilTask = (db, id3) => !!councilRow(db, id3);
function topicOf(db, id3) {
  const council = councilRow(db, id3);
  const task = getTask(db, id3);
  return {
    ref: task.ref,
    topic: council.topic,
    brief: council.topic_text,
    brief_path: council.topic_brief,
    issue: task.issue,
    repo: task.repo,
    leader: leaderLabel(db, council.leader_node_id),
    concerns: memberRows(db, id3).map((m) => ({
      ref: specialistRef(m.node_id),
      name: nodeName(db, m.node_id)
    }))
  };
}
var nodeName = (db, id3) => id3 < 0 ? getJobRole(db, `r${-id3}`).name : one(db, "SELECT * FROM org_nodes WHERE id=?", id3)?.name ?? ref(id3);
var leaderLabel = (db, id3) => id3 === null ? "\u79D8\u4E66" : `${nodeName(db, id3)}\uFF08${ref(id3)}\uFF09\u7684 leader`;
var TOPIC_MAX2 = 120;
function leaderNode(db, address) {
  try {
    return nodeByAddress(db, address);
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `leader: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree"
      );
    throw error;
  }
}
function invited(db, value) {
  try {
    return specialistsFor(db, value);
  } catch (error) {
    if (error instanceof Problem && error.code === "not_found")
      try {
        return concernsFor(db, value);
      } catch (legacyError) {
        if (legacyError instanceof Problem && legacyError.message.startsWith("concern: "))
          throw new Problem(
            legacyError.statusCode,
            `concerns: ${legacyError.message.slice("concern: ".length)}`,
            legacyError.code,
            legacyError.candidates,
            legacyError.nextCommand
          );
        throw legacyError;
      }
    if (error instanceof Problem && error.message.startsWith("concern: "))
      throw new Problem(
        error.statusCode,
        `concerns: ${error.message.slice("concern: ".length)}`,
        error.code,
        error.candidates,
        error.nextCommand
      );
    throw error;
  }
}
function createCouncil(db, data2, body3) {
  const input = objectOf2(body3);
  onlyKeys(input, [
    "topic",
    "concerns",
    "brief",
    "brief_path",
    "issue",
    "leader",
    "repo",
    "owner",
    "part",
    "comment"
  ]);
  if (typeof input.topic !== "string" || !input.topic.trim())
    throw usage(
      "topic: \u8BAE\u9898\u4E0D\u80FD\u4E3A\u7A7A",
      "atrium review add \u8BAE\u9898 --concerns \u524D\u7AEF,\u540E\u7AEF"
    );
  const topic = input.topic.trim().replace(/\s+/g, " ");
  if (Array.from(topic).length > TOPIC_MAX2)
    throw usage(`topic: \u8BAE\u9898\u81F3\u591A ${TOPIC_MAX2} \u5B57\uFF0C\u957F\u5185\u5BB9\u5199\u8FDB --brief \u6587\u4EF6`);
  if (input.concerns === void 0 || input.concerns === "")
    throw usage("concerns: \u81F3\u5C11\u8BF7\u4E00\u4F4D\u4E13\u5458\uFF0C\u5982 \u524D\u7AEF,\u540E\u7AEF");
  const comment = input.comment === true;
  if (input.comment !== void 0 && typeof input.comment !== "boolean")
    throw usage("comment: \u5E94\u4E3A true \u6216 false");
  if (comment && (input.issue === void 0 || input.issue === null))
    throw usage("comment: \u540C\u6B65\u4E3A issue \u8BC4\u8BBA\u9700\u540C\u65F6\u7ED9 issue");
  if (comment && !input.repo)
    throw usage("comment: \u540C\u6B65\u4E3A issue \u8BC4\u8BBA\u9700\u540C\u65F6\u7ED9 repo\uFF08gh \u636E\u6B64\u5B9A\u4ED3\u5E93\uFF09");
  if (input.leader !== void 0 && input.leader !== null && input.leader !== "") {
    if (typeof input.leader !== "string")
      throw usage("leader: \u5E94\u4E3A\u7EC4\u7EC7\u8282\u70B9\uFF0C\u5982 atrium \u6216 o2");
  }
  if (input.owner !== void 0) ownerOf(input.owner);
  return atomically(db, () => {
    const concerns = invited(db, input.concerns);
    if (!concerns.length) throw usage("concerns: \u81F3\u5C11\u8BF7\u4E00\u4F4D\u4E13\u5458\uFF0C\u5982 \u524D\u7AEF,\u540E\u7AEF");
    const leader = input.leader ? leaderNode(db, String(input.leader)) : null;
    const now = Date.now();
    const parent = createTask(
      db,
      {
        title: `\u4F1A\u5BA1\uFF1A${topic}`,
        deliver: comment ? "comment" : "none",
        ...leader ? { role: ref(leader.id) } : {},
        ...input.brief !== void 0 ? { brief: input.brief } : {},
        ...input.brief_path ? { brief_path: input.brief_path } : {},
        ...input.issue !== void 0 ? { issue: input.issue } : {},
        ...input.repo ? { repo: input.repo } : {},
        ...input.owner ? { owner: input.owner } : {},
        ...input.part ? { part: input.part } : {}
      },
      now
    );
    db.prepare(
      "INSERT INTO task_councils(task_id,topic,topic_brief,topic_text,leader_node_id,comment,stage,created_at) VALUES(?,?,?,?,?,?,'opinions',?)"
    ).run(
      parent.id,
      topic,
      parent.brief_path,
      parent.brief ?? null,
      leader?.id ?? null,
      comment ? 1 : 0,
      now
    );
    const dir = taskDir(data2, parent.id);
    mkdirSync2(dir, { recursive: true, mode: 448 });
    const refs = [];
    concerns.forEach((nodeId, pos) => {
      db.prepare(
        "INSERT INTO council_members(task_id,node_id,pos,opinion_id) VALUES(?,?,?,0)"
      ).run(parent.id, nodeId, pos);
    });
    const topicView = topicOf(db, parent.id);
    for (const nodeId of concerns) {
      const checklist = checklistOf(db, nodeId);
      const brief2 = join9(dir, `opinion-${checklist.ref}.md`);
      const text6 = clipBrief(opinionBrief(topicView, checklist));
      writeFileSync2(brief2, text6, { mode: 384 });
      const opinion = createTask(
        db,
        {
          title: `\u4F1A\u5BA1\u610F\u89C1\uFF1A${checklist.name} \xB7 ${topic}`,
          parent: parent.ref,
          ...nodeId < 0 ? { job: checklist.ref } : { role: checklist.ref },
          deliver: "none",
          brief: text6,
          brief_path: brief2,
          ...input.owner ? { owner: input.owner } : {},
          ...input.part ? { part: input.part } : {}
        },
        now
      );
      db.prepare(
        "UPDATE council_members SET opinion_id=? WHERE task_id=? AND node_id=?"
      ).run(opinion.id, parent.id, nodeId);
      refs.push(opinion.ref);
    }
    noteTask(db, parent.id, "council_opened", {
      topic,
      leader: leader ? ref(leader.id) : "secretary",
      opinions: refs,
      ...comment ? { comment: true } : {}
    });
    return { council: councilView(db, parent.id), opinions: refs };
  });
}
var list2 = (text6) => {
  try {
    const value = text6 ? JSON.parse(text6) : [];
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
};
function lastReason(db, id3, kind) {
  return reasonOf(
    all(
      db,
      "SELECT * FROM task_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
      id3,
      kind
    ),
    kind
  );
}
function opinionsOf(db, id3) {
  return memberRows(db, id3).map((m) => {
    const task = one(
      db,
      "SELECT status,result FROM tasks WHERE id=?",
      m.opinion_id
    );
    const status = task?.status ?? "cancelled";
    const reason = status === "failed" ? lastReason(db, m.opinion_id, "exit_fail") : status === "blocked" ? lastReason(db, m.opinion_id, "block") : null;
    const opinion = opinionOf(status, task?.result ?? null, reason) ?? {
      stance: "none",
      reason: status === "running" ? "\u6B63\u5728\u51FA\u610F\u89C1" : "\u8FD8\u6CA1\u5F00\u59CB"
    };
    return {
      ref: specialistRef(m.node_id),
      name: nodeName(db, m.node_id),
      task: taskRef(m.opinion_id),
      status,
      stance: opinion.stance,
      reason: opinion.reason,
      text: status === "done" ? task?.result ?? null : null
    };
  });
}
function councilView(db, reference) {
  const id3 = parseTaskRef(reference);
  requireRow(db, id3);
  const council = councilRow(db, id3);
  if (!council)
    throw new Problem(
      404,
      `${taskRef(id3)} \u4E0D\u662F\u4F1A\u5BA1\u8BAE\u9898`,
      "not_found",
      void 0,
      `atrium task show ${taskRef(id3)}`
    );
  const task = getTask(db, id3);
  return {
    ref: task.ref,
    topic: council.topic,
    title: task.title,
    status: task.status,
    stage: council.stage,
    stage_label: STAGE_LABEL[council.stage],
    leader: council.leader_node_id === null ? null : {
      ref: ref(council.leader_node_id),
      name: nodeName(db, council.leader_node_id)
    },
    issue: task.issue,
    comment: council.comment === 1,
    repo: task.repo,
    topic_brief: council.topic_brief,
    opinions: opinionsOf(db, id3),
    summary: {
      task: task.ref,
      status: task.status,
      text: council.stage === "decided" || council.stage === "escalated" ? task.result : null
    },
    agreed: list2(council.agreed),
    conflicts: list2(council.conflicts),
    conclusion: council.conclusion,
    escalate: list2(council.escalate),
    decided_by: council.decided_by,
    decided_at: council.decided_at
  };
}
var DECISION_MAX = 2e3;
function decideCouncil(db, reference, body3, actor) {
  const id3 = parseTaskRef(reference);
  const input = objectOf2(body3);
  onlyKeys(input, ["conclusion"]);
  if (typeof input.conclusion !== "string" || !input.conclusion.trim())
    throw usage("conclusion: \u7ED3\u8BBA\u4E0D\u80FD\u4E3A\u7A7A");
  const conclusion = input.conclusion.trim();
  if (Array.from(conclusion).length > DECISION_MAX)
    throw usage(`conclusion: \u7ED3\u8BBA\u81F3\u591A ${DECISION_MAX} \u5B57`);
  return atomically(db, () => {
    const council = councilView(db, id3);
    if (council.stage !== "escalated" && council.stage !== "decided")
      throw new Problem(
        409,
        `${council.ref} \u8FD8\u6CA1\u6C47\u603B\u5B8C\uFF08${council.stage_label}\uFF09\uFF0C\u7B49 leader \u6C47\u603B\u540E\u518D\u62CD\u677F`,
        "conflict",
        void 0,
        `atrium task wait ${council.ref}`
      );
    const now = Date.now();
    db.prepare(
      "UPDATE task_councils SET stage='decided',conclusion=?,decided_by=?,decided_at=? WHERE task_id=?"
    ).run(conclusion, actor, now, id3);
    noteTask(db, id3, "council_decided", {
      conclusion,
      by: actor,
      ...council.escalate.length ? { resolved: council.escalate } : {}
    });
    return councilView(db, id3);
  });
}

// server/tasks/patrol.ts
import { createHash as createHash4 } from "node:crypto";

// server/org/overview.ts
var STAGE_STATUSES = [
  "planned",
  "active",
  "achieved",
  "blocked",
  "dropped"
];
var STAGE_LABEL2 = {
  planned: "\u89C4\u5212\u4E2D",
  active: "\u8FDB\u884C\u4E2D",
  achieved: "\u8FBE\u6210",
  blocked: "\u53D7\u963B",
  dropped: "\u653E\u5F03"
};
var OVERVIEW_TEXT = {
  what: 300,
  alias: 40,
  analogy: 100,
  now: 500,
  next: 500,
  when: 200
};
var OVERVIEW_LISTS = { uses: 10, flow: 12 };
var STAGES_MAX = 60;
var bad2 = (field2, message4) => {
  throw new Problem(400, `${field2} ${message4}`, "usage");
};
var text3 = (value, field2, max) => {
  if (typeof value !== "string") return bad2(field2, "\u5E94\u4E3A\u6587\u672C");
  if (Array.from(value).length > max) bad2(field2, `\u8D85\u8FC7 ${max} \u5B57`);
  return value;
};
var texts = (value, field2, count2, max) => {
  if (!Array.isArray(value)) return bad2(field2, "\u5E94\u4E3A\u6587\u672C\u5217\u8868");
  if (value.length > count2) bad2(field2, `\u8D85\u8FC7 ${count2} \u9879`);
  value.forEach((item, i) => text3(item, `${field2}[${i}]`, max));
  return value;
};
var DATE = /^\d{4}-\d{2}-\d{2}$/;
function validateStages(value, field2 = "charter.stages") {
  if (!Array.isArray(value)) return bad2(field2, "\u5E94\u4E3A\u9636\u6BB5\u5217\u8868");
  if (value.length > STAGES_MAX) bad2(field2, `\u8D85\u8FC7 ${STAGES_MAX} \u9879`);
  const ids = /* @__PURE__ */ new Set();
  value.forEach((item, i) => {
    const at = `${field2}[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item))
      return bad2(at, "\u5E94\u4E3A\u5BF9\u8C61");
    const stage = item;
    for (const key of Object.keys(stage))
      if (![
        "id",
        "result",
        "status",
        "criteria",
        "evidence",
        "note",
        "due",
        "after",
        "parent",
        "repo"
      ].includes(key))
        bad2(`${at}.${key}`, "\u662F\u672A\u77E5\u5B57\u6BB5");
    const id3 = text3(stage.id, `${at}.id`, 40).trim();
    if (!id3) bad2(`${at}.id`, "\u4E0D\u80FD\u4E3A\u7A7A");
    if (ids.has(id3)) bad2(`${at}.id`, `\u4E0E\u524D\u9762\u7684\u9636\u6BB5\u91CD\u590D\uFF1A${id3}`);
    ids.add(id3);
    if (!text3(stage.result, `${at}.result`, 300).trim())
      bad2(`${at}.result`, "\u4E0D\u80FD\u4E3A\u7A7A");
    if (!STAGE_STATUSES.includes(stage.status))
      bad2(`${at}.status`, `\u53EA\u80FD\u662F ${STAGE_STATUSES.join("\u3001")}`);
    if (stage.criteria !== void 0)
      texts(stage.criteria, `${at}.criteria`, 20, 500);
    if (stage.evidence !== void 0)
      texts(stage.evidence, `${at}.evidence`, 20, 1e3);
    if (stage.after !== void 0) texts(stage.after, `${at}.after`, 20, 40);
    if (stage.note !== void 0) text3(stage.note, `${at}.note`, 500);
    if (stage.parent !== void 0) text3(stage.parent, `${at}.parent`, 40);
    if (stage.repo !== void 0 && (!text3(stage.repo, `${at}.repo`, 500).startsWith("/") || stage.repo.split("/").includes("..")))
      bad2(`${at}.repo`, "\u5E94\u4E3A\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u4E0D\u80FD\u5305\u542B ..");
    if (stage.due !== void 0 && (typeof stage.due !== "string" || !DATE.test(stage.due) || Number.isNaN(Date.parse(stage.due)) || new Date(stage.due).toISOString().slice(0, 10) !== stage.due))
      bad2(`${at}.due`, "\u5E94\u4E3A YYYY-MM-DD \u65E5\u671F");
  });
  return value;
}
function validateOverviewField(key, value) {
  const field2 = `charter.${key}`;
  if (Object.hasOwn(OVERVIEW_TEXT, key))
    text3(value, field2, OVERVIEW_TEXT[key]);
  else if (Object.hasOwn(OVERVIEW_LISTS, key))
    texts(value, field2, OVERVIEW_LISTS[key], 300);
  else if (key === "stages") validateStages(value, field2);
  else return false;
  return true;
}
var str = (value) => typeof value === "string" ? value.trim() : "";
var list3 = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string" && !!v.trim()) : [];
function overviewOf(fields, parts) {
  const what = str(fields.what);
  const goal = str(fields.goal);
  let stages = [];
  try {
    stages = fields.stages === void 0 ? [] : validateStages(fields.stages);
  } catch {
    stages = [];
  }
  return {
    alias: str(fields.alias),
    analogy: str(fields.analogy),
    what: what || goal,
    what_from_goal: !what && !!goal,
    uses: list3(fields.uses),
    flow: list3(fields.flow),
    parts,
    now: str(fields.now),
    next: str(fields.next),
    stages
  };
}
var HUMAN_KEYS = /* @__PURE__ */ new Set([
  ...Object.keys(OVERVIEW_TEXT),
  ...Object.keys(OVERVIEW_LISTS)
]);
var OVERVIEW_KEYS = /* @__PURE__ */ new Set([...HUMAN_KEYS, "stages"]);

// server/tasks/patrol.ts
function ensurePatrolTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS patrol_runs (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), node_id INTEGER NOT NULL,
    scenario TEXT NOT NULL, flow TEXT NOT NULL, created_at INTEGER NOT NULL,
    finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS patrol_runs_node ON patrol_runs(node_id,task_id);
    CREATE TABLE IF NOT EXISTS patrol_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL REFERENCES tasks(id), fingerprint TEXT NOT NULL,
      phenomenon TEXT NOT NULL, step TEXT NOT NULL, command TEXT NOT NULL,
      expected TEXT NOT NULL, actual TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('broken','awkward')),
      status TEXT NOT NULL CHECK(status IN ('new','task','merged','ignored')),
      linked_task_id INTEGER, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(node_id,fingerprint));
    CREATE INDEX IF NOT EXISTS patrol_findings_node ON patrol_findings(node_id,id);`);
}
var findingView = ({
  fingerprint: _fingerprint,
  ...row3
}) => ({
  ...row3,
  ref: `f${row3.id}`,
  node: ref(row3.node_id),
  patrol: `t${row3.task_id}`,
  linked_task: row3.linked_task_id ? `t${row3.linked_task_id}` : null
});
function scenarioAt(uses, previous) {
  if (!uses.length)
    throw new Problem(
      409,
      "\u8282\u70B9\u8FD8\u6CA1\u6709 uses \u573A\u666F\uFF1B\u5148\u7528 atrium map edit \u8282\u70B9 --uses \u573A\u666F \u8865\u4E0A",
      "conflict"
    );
  return uses[previous % uses.length];
}
function patrolRun(db, taskId) {
  return db.prepare("SELECT * FROM patrol_runs WHERE task_id=?").get(taskId);
}
function startPatrol(db, address) {
  const node = nodeByAddress(db, address);
  if (node.archived_at !== null)
    throw new Problem(409, `${ref(node.id)} \u5DF2\u5F52\u6863`, "conflict");
  const doc2 = one2(
    db,
    "SELECT fields FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id
  );
  let fields = {};
  try {
    const parsed = JSON.parse(doc2?.fields ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      fields = parsed;
  } catch {
  }
  const overview = overviewOf(fields, []);
  return atomically(db, () => {
    const count2 = db.prepare("SELECT count(*) n FROM patrol_runs WHERE node_id=?").get(node.id).n;
    const scenario = scenarioAt(overview.uses, count2);
    const task = createTask(db, {
      title: `\u4F53\u9A8C\u5DE1\u68C0\uFF1A${node.name} \xB7 ${scenario}`,
      part: ref(node.id),
      deliver: "none"
    });
    db.prepare(
      "INSERT INTO patrol_runs(task_id,node_id,scenario,flow,created_at) VALUES (?,?,?,?,?)"
    ).run(
      task.id,
      node.id,
      scenario,
      JSON.stringify(overview.flow),
      Date.now()
    );
    return { task, scenario, flow: overview.flow };
  });
}
var needed = (body3, key, max) => {
  const value = body3[key];
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    throw new Problem(400, `${key}: \u5E94\u4E3A 1\uFF5E${max} \u5B57`, "usage");
  return value.trim();
};
function fingerprintOf(phenomenon) {
  return createHash4("sha256").update(
    phenomenon.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
  ).digest("hex");
}
function inNodeTree(nodeId, rootId, parents) {
  const seen = /* @__PURE__ */ new Set();
  let current2 = nodeId;
  while (current2 !== null && !seen.has(current2)) {
    if (current2 === rootId) return true;
    seen.add(current2);
    current2 = parents.get(current2) ?? null;
  }
  return false;
}
function reportFinding(db, taskRef2, raw) {
  const task = getTask(db, taskRef2);
  const run3 = patrolRun(db, task.id);
  if (!run3) throw new Problem(409, `${task.ref} \u4E0D\u662F\u5DE1\u68C0\u4EFB\u52A1`, "conflict");
  if (task.status !== "running")
    throw new Problem(409, `${task.ref} \u6CA1\u6709\u5728\u5DE1\u68C0`, "conflict");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Problem(400, "\u53D1\u73B0\u5B57\u6BB5\u5E94\u4E3A\u5BF9\u8C61", "usage");
  const body3 = raw;
  if (Object.keys(body3).some(
    (key) => ![
      "phenomenon",
      "step",
      "command",
      "expected",
      "actual",
      "kind"
    ].includes(key)
  ))
    throw new Problem(400, "\u53D1\u73B0\u542B\u4E0D\u652F\u6301\u7684\u5B57\u6BB5", "usage");
  const phenomenon = needed(body3, "phenomenon", 200);
  const step2 = needed(body3, "step", 200);
  const command = needed(body3, "command", 500);
  const expected = needed(body3, "expected", 1e3);
  const actual = needed(body3, "actual", 1e3);
  if (body3.kind !== "broken" && body3.kind !== "awkward")
    throw new Problem(400, "kind: \u53EA\u80FD\u662F broken \u6216 awkward", "usage");
  const fingerprint = fingerprintOf(phenomenon);
  const now = Date.now();
  const inserted = db.prepare(
    "INSERT OR IGNORE INTO patrol_findings(node_id,task_id,fingerprint,phenomenon,step,command,expected,actual,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'new',?,?)"
  ).run(
    run3.node_id,
    task.id,
    fingerprint,
    phenomenon,
    step2,
    command,
    expected,
    actual,
    body3.kind,
    now,
    now
  );
  const row3 = db.prepare("SELECT * FROM patrol_findings WHERE node_id=? AND fingerprint=?").get(run3.node_id, fingerprint);
  return { finding: findingView(row3), duplicate: inserted.changes === 0 };
}
function findingsForNode(db, nodeId) {
  return db.prepare(
    "SELECT * FROM patrol_findings WHERE node_id=? ORDER BY id DESC LIMIT 100"
  ).all(nodeId).map(findingView);
}
function findingsForNodes(db, nodeIds) {
  if (!nodeIds.length) return [];
  return db.prepare(
    `SELECT * FROM patrol_findings WHERE node_id IN (${nodeIds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 100`
  ).all(...nodeIds).map(findingView);
}
function findingNode(db, reference) {
  const match = /^f([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  return db.prepare("SELECT node_id FROM patrol_findings WHERE id=?").get(Number(match[1]))?.node_id ?? null;
}
function finishPatrol(db, inbox, taskId) {
  const run3 = patrolRun(db, taskId);
  if (!run3 || run3.finished_at !== null) return;
  db.prepare(
    "UPDATE patrol_runs SET finished_at=? WHERE task_id=? AND finished_at IS NULL"
  ).run(Date.now(), taskId);
  const findings = db.prepare(
    "SELECT * FROM patrol_findings WHERE task_id=? ORDER BY id LIMIT 100"
  ).all(taskId).map(findingView);
  const route = taskRoute(db, getTask(db, taskId));
  inbox.publish({
    subscriber: route.subscriber,
    taskId,
    source: "patrol",
    kind: findings.length ? "patrol_findings" : "patrol_finished",
    key: `patrol:${taskId}`,
    detail: {
      node: ref(run3.node_id),
      status: getTask(db, taskId).status,
      findings: findings.map((f) => ({
        ref: f.ref,
        phenomenon: f.phenomenon,
        kind: f.kind
      })),
      routed: { to: route.subscriber, why: route.why }
    }
  });
}
function decideFinding(db, reference, raw) {
  const match = /^f([1-9]\d*)$/.exec(reference);
  if (!match) throw new Problem(400, "\u53D1\u73B0\u77ED\u53F7\u5E94\u4E3A f1 \u8FD9\u6837\u7684\u683C\u5F0F", "usage");
  const row3 = db.prepare("SELECT * FROM patrol_findings WHERE id=?").get(Number(match[1]));
  if (!row3) throw new Problem(404, `\u53D1\u73B0 ${reference} \u4E0D\u5B58\u5728`, "not_found");
  if (row3.status !== "new")
    throw new Problem(409, `${reference} \u5DF2\u5904\u7406`, "conflict");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Problem(400, "\u5904\u7406\u5B57\u6BB5\u5E94\u4E3A\u5BF9\u8C61", "usage");
  const body3 = raw;
  if (Object.keys(body3).some((k) => !["action", "task", "reason"].includes(k)))
    throw new Problem(400, "\u5904\u7406\u542B\u4E0D\u652F\u6301\u7684\u5B57\u6BB5", "usage");
  const action = body3.action;
  if (action !== "task" && action !== "merged" && action !== "ignored")
    throw new Problem(400, "action: \u53EA\u80FD\u662F task\u3001merged \u6216 ignored", "usage");
  const reason = action === "ignored" ? needed(body3, "reason", 1e3) : typeof body3.reason === "string" ? body3.reason.trim().slice(0, 1e3) : null;
  const linked = action === "ignored" ? null : parseTaskRef(body3.task, "task");
  if (linked !== null) {
    const task = getTask(db, linked);
    const parents = new Map(nodes(db).map((n) => [n.id, n.parent_id]));
    if (!inNodeTree(task.part_id ?? task.node_id, row3.node_id, parents))
      throw new Problem(
        409,
        `\u4EFB\u52A1 ${task.ref} \u4E0D\u5728\u53D1\u73B0\u6240\u5C5E\u8282\u70B9\u53CA\u4E0B\u5C42`,
        "conflict"
      );
  }
  db.prepare(
    "UPDATE patrol_findings SET status=?,linked_task_id=?,reason=?,updated_at=? WHERE id=?"
  ).run(action, linked, reason, Date.now(), row3.id);
  return findingView(
    db.prepare("SELECT * FROM patrol_findings WHERE id=?").get(row3.id)
  );
}

// server/tasks/ledger-schema.ts
function ensureTaskTables(db) {
  ensureQueueTable(db);
  ensureJobRoles(db);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL,
      brief_path TEXT,
      role TEXT,
      repo TEXT,
      deliver TEXT NOT NULL DEFAULT 'pr' CHECK(deliver IN ('pr','comment','none')),
      issue INTEGER,
      status TEXT NOT NULL CHECK(status IN ('todo','running','done','failed','blocked','cancelled')),
      worker TEXT,
      pid INTEGER, worktree TEXT, branch TEXT,
      pr_url TEXT, ci TEXT,
      result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id,id);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,id);
    CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,id);`);
  const columns = all(db, "PRAGMA table_info(tasks)");
  if (!columns.some((column) => column.name === "brief"))
    db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT");
  if (!columns.some((column) => column.name === "job_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN job_id INTEGER");
  if (!columns.some((column) => column.name === "worker_effort"))
    db.exec("ALTER TABLE tasks ADD COLUMN worker_effort TEXT");
  if (!columns.some((column) => column.name === "worker_risk"))
    db.exec("ALTER TABLE tasks ADD COLUMN worker_risk TEXT");
  if (!columns.some((column) => column.name === "owner"))
    db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT");
  if (!columns.some((column) => column.name === "deliver"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN deliver TEXT NOT NULL DEFAULT 'pr' CHECK(deliver IN ('pr','comment','none'))"
    );
  if (!columns.some((column) => column.name === "issue"))
    db.exec("ALTER TABLE tasks ADD COLUMN issue INTEGER");
  if (!columns.some((column) => column.name === "auto"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto INTEGER NOT NULL DEFAULT 0 CHECK(auto IN (0,1))"
    );
  if (!columns.some((column) => column.name === "auto_dispatched"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(auto_dispatched IN (0,1))"
    );
  if (!columns.some((column) => column.name === "urgent"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0 CHECK(urgent IN (0,1))"
    );
  if (!columns.some((column) => column.name === "schedule_state"))
    db.exec("ALTER TABLE tasks ADD COLUMN schedule_state TEXT");
  if (!columns.some((column) => column.name === "schedule_reason"))
    db.exec("ALTER TABLE tasks ADD COLUMN schedule_reason TEXT");
  if (!columns.some((column) => column.name === "node_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN node_id INTEGER");
  if (!columns.some((column) => column.name === "origin_node_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN origin_node_id INTEGER");
  if (!columns.some((column) => column.name === "goal_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN goal_id INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id,status)");
  if (!columns.some((column) => column.name === "part_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN part_id INTEGER");
  if (!columns.some((column) => column.name === "delivery_stage"))
    db.exec("ALTER TABLE tasks ADD COLUMN delivery_stage TEXT");
  if (!columns.some((column) => column.name === "merge_returns"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN merge_returns INTEGER NOT NULL DEFAULT 0"
    );
  if (!columns.some((column) => column.name === "merge_queued_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN merge_queued_at INTEGER");
  if (!columns.some((column) => column.name === "review_task"))
    db.exec("ALTER TABLE tasks ADD COLUMN review_task INTEGER");
  if (!columns.some((column) => column.name === "merge_commit"))
    db.exec("ALTER TABLE tasks ADD COLUMN merge_commit TEXT");
  if (!columns.some((column) => column.name === "release_version"))
    db.exec("ALTER TABLE tasks ADD COLUMN release_version TEXT");
  if (!columns.some((column) => column.name === "online_wait"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN online_wait INTEGER NOT NULL DEFAULT 0"
    );
  if (!columns.some((column) => column.name === "online_attempt"))
    db.exec("ALTER TABLE tasks ADD COLUMN online_attempt TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_delivery_stage ON tasks(delivery_stage,id)"
  );
  db.exec("CREATE INDEX IF NOT EXISTS tasks_part ON tasks(part_id,status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_review_task ON tasks(review_task) WHERE review_task IS NOT NULL"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_node ON tasks(node_id,status); CREATE INDEX IF NOT EXISTS tasks_origin_node ON tasks(origin_node_id,status)"
  );
  db.exec(`CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), after_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(task_id,after_id));
    CREATE INDEX IF NOT EXISTS task_dependencies_after ON task_dependencies(after_id,task_id);
    CREATE TABLE IF NOT EXISTS task_pr_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), repo TEXT NOT NULL, number INTEGER NOT NULL,
    merged INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, error TEXT,
    PRIMARY KEY(task_id,repo,number));`);
  ensureUpstreamPrTable(db);
  repairScheduleRecords(db);
  ensureUsageTable(db);
  ensureConcernTable(db);
  ensureAlsoTable(db);
  ensureCouncilTables(db);
  ensureDeliveryRecords(db);
  ensurePatrolTables(db);
  ensureWorkerProfiles(db);
}

// server/tasks/ledger-summary.ts
function emptyChildSummary() {
  return {
    total: 0,
    todo: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0
  };
}
function childSummaries(db, parentIds) {
  const summaries = /* @__PURE__ */ new Map();
  for (let offset = 0; offset < parentIds.length; offset += 400) {
    const ids = parentIds.slice(offset, offset + 400);
    const rows = all(
      db,
      `SELECT parent_id, status, COUNT(*) AS count FROM tasks
       WHERE parent_id IN (${ids.map(() => "?").join(",")})
       GROUP BY parent_id, status`,
      ...ids
    );
    for (const { parent_id, status, count: count2 } of rows) {
      const summary2 = summaries.get(parent_id) ?? emptyChildSummary();
      summary2[status] += count2;
      summary2.total += count2;
      summaries.set(parent_id, summary2);
    }
  }
  return summaries;
}

// server/tasks/schedule-ledger.ts
function parseAfter(value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("--after \u7528\u9017\u53F7\u5206\u9694\u4EFB\u52A1\u77ED\u53F7\uFF0C\u5982 t1,t2");
  const ids = value.split(",").map((part) => parseTaskRef(part, "--after"));
  if (new Set(ids).size !== ids.length)
    throw usage("--after \u7684\u4EFB\u52A1\u77ED\u53F7\u4E0D\u80FD\u91CD\u590D");
  return ids;
}
function parseAfterPr(value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("--after-pr \u7528\u9017\u53F7\u5206\u9694 owner/repo#\u53F7");
  const prs = value.split(",").map((part) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#([1-9][0-9]*)$/.exec(
      part.trim()
    );
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw usage(`--after-pr \u7684 ${part} \u5E94\u4E3A owner/repo#\u53F7`);
    return { repo: match[1], number: Number(match[2]) };
  });
  if (new Set(prs.map((pr) => `${pr.repo}#${pr.number}`)).size !== prs.length)
    throw usage("--after-pr \u7684 PR \u4E0D\u80FD\u91CD\u590D");
  return prs;
}
function conditions(db, id3) {
  return {
    after: all(
      db,
      "SELECT after_id FROM task_dependencies WHERE task_id=? ORDER BY after_id",
      id3
    ).map((row3) => taskRef(row3.after_id)),
    after_pr: all(
      db,
      "SELECT repo,number,merged,checked_at,error FROM task_pr_dependencies WHERE task_id=? ORDER BY repo,number",
      id3
    ).map((row3) => ({ ...row3, merged: !!row3.merged }))
  };
}
function setConditions(db, id3, input, now) {
  const after = "after" in input ? parseAfter(input.after) : void 0;
  const prs = "after_pr" in input ? parseAfterPr(input.after_pr) : void 0;
  if (after === void 0 && prs === void 0 && !("auto" in input)) return;
  const current2 = requireRow(db, id3);
  if (current2.status === "running" || current2.status === "done" || current2.status === "cancelled")
    throw new Problem(
      409,
      `${taskRef(id3)} \u5F53\u524D ${current2.status}\uFF0C\u4E0D\u80FD\u4FEE\u6539\u6392\u671F`,
      "conflict"
    );
  const hasQueue = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_queue'"
  ).get();
  if (hasQueue && db.prepare("SELECT 1 FROM task_queue WHERE task_id=?").get(id3))
    throw new Problem(
      409,
      `${taskRef(id3)} \u5DF2\u6392\u961F\uFF0C\u5148 task stop \u518D\u4FEE\u6539\u6392\u671F`,
      "conflict"
    );
  if (current2.status === "blocked" && current2.schedule_state === "blocked")
    db.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(id3);
  if (after !== void 0) {
    for (const dependency of after) {
      if (dependency === id3)
        throw usage(`--after\uFF1A${taskRef(id3)} \u4E0D\u80FD\u4F9D\u8D56\u81EA\u5DF1`);
      requireRow(db, dependency);
      const cycle = db.prepare(
        `WITH RECURSIVE ancestors(id) AS (
        SELECT after_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.after_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
      ) SELECT id FROM ancestors WHERE id=? LIMIT 1`
      ).get(dependency, id3);
      if (cycle)
        throw usage(
          `--after\uFF1A${taskRef(dependency)} \u5DF2\u4F9D\u8D56 ${taskRef(id3)}\uFF0C\u4F1A\u5F62\u6210\u73AF\u8DEF`
        );
    }
    db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id3);
    const insert = db.prepare(
      "INSERT INTO task_dependencies(task_id,after_id) VALUES (?,?)"
    );
    for (const dependency of after) insert.run(id3, dependency);
  }
  if (prs !== void 0) {
    db.prepare("DELETE FROM task_pr_dependencies WHERE task_id=?").run(id3);
    const insert = db.prepare(
      "INSERT INTO task_pr_dependencies(task_id,repo,number) VALUES (?,?,?)"
    );
    for (const pr of prs) insert.run(id3, pr.repo, pr.number);
  }
  if ("auto" in input) {
    if (typeof input.auto !== "boolean") throw usage("--auto \u5E94\u4E3A\u5E03\u5C14\u503C");
    db.prepare("UPDATE tasks SET auto=? WHERE id=?").run(
      input.auto ? 1 : 0,
      id3
    );
  }
  db.prepare(
    "UPDATE tasks SET schedule_state=NULL,schedule_reason=NULL,auto_dispatched=0,updated_at=? WHERE id=?"
  ).run(now, id3);
}

// server/tasks/ledger-read.ts
var EVENTS_SHOWN = 50;
function getTask(db, reference) {
  const found = requireRow(db, parseTaskRef(reference));
  const events2 = all(
    db,
    "SELECT * FROM (SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
    found.id,
    EVENTS_SHOWN
  );
  const child_summary = childSummaries(db, [found.id]).get(found.id) ?? null;
  const concerns = concernsOf(db, found.id);
  const hints = lastHints(db, found.id);
  const queue = queueView(db, found.id);
  return {
    ...view(found),
    ...noteView(db, found.id, found.status),
    ...queue,
    holder: holderFor(
      db,
      found,
      queued(db, found.id) ? { reason: queue.queued_reason } : null
    ),
    children: child_summary?.total ?? 0,
    child_summary,
    events: events2,
    ...conditions(db, found.id),
    ...concerns.length ? { concerns } : {},
    ...hints.length ? { concern_hints: hints } : {},
    ...involvedView(involvedOf(db, found))
  };
}
function lastHints(db, id3) {
  const row3 = all(
    db,
    "SELECT * FROM task_events WHERE task_id=? AND kind='concern_hints' ORDER BY id DESC LIMIT 1",
    id3
  )[0];
  try {
    const hints = row3?.detail ? JSON.parse(row3.detail).hints : void 0;
    return Array.isArray(hints) ? hints : [];
  } catch {
    return [];
  }
}
function listTasks(db, query2) {
  const where = [];
  const params3 = [];
  if (query2.parent !== void 0 && query2.parent !== "") {
    where.push("parent_id=?");
    params3.push(parentOf(db, query2.parent));
  }
  if (query2.status !== void 0 && query2.status !== "") {
    where.push("status=?");
    params3.push(statusOf(query2.status));
  }
  if (query2.after !== void 0 && query2.after !== "") {
    where.push("id>?");
    params3.push(parseTaskRef(query2.after, "after"));
  }
  let limit = LIST_LIMIT;
  if (query2.limit !== void 0 && query2.limit !== "") {
    limit = Number(query2.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX)
      throw usage(`limit: \u5E94\u4E3A 1\uFF5E${LIST_MAX} \u7684\u6574\u6570`);
  }
  const rows = all(
    db,
    `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`,
    ...params3,
    limit + 1
  );
  const more = rows.length > limit;
  const tasks = rows.slice(0, limit).map((row3) => ({
    ...listView(row3),
    ...noteView(db, row3.id, row3.status),
    ...queueView(db, row3.id)
  }));
  return { tasks, next_after: more ? tasks.at(-1).ref : null };
}

// server/tasks/ledger-tree.ts
function taskTree(db, root) {
  const rootId = root === void 0 || root === "" ? null : parseTaskRef(root, "root");
  if (rootId !== null) requireRow(db, rootId);
  const rows = all(
    db,
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM tasks WHERE ${rootId === null ? "parent_id IS NULL" : "id=?"}
       UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id=sub.id)
     SELECT t.* FROM tasks t JOIN sub USING(id) ORDER BY t.id LIMIT ?`,
    ...rootId === null ? [] : [rootId],
    TREE_MAX + 1
  );
  const truncated = rows.length > TREE_MAX;
  const nodes2 = /* @__PURE__ */ new Map();
  const summaries = childSummaries(
    db,
    rows.slice(0, TREE_MAX).map((found) => found.id)
  );
  for (const found of rows.slice(0, TREE_MAX))
    nodes2.set(found.id, {
      ...listView(found),
      ...noteView(db, found.id, found.status),
      children: [],
      child_summary: summaries.get(found.id) ?? null
    });
  const roots = [];
  for (const node of nodes2.values()) {
    const parent = node.parent_id === null || node.id === rootId ? void 0 : nodes2.get(node.parent_id);
    if (parent) parent.children.push(node);
    else if (node.parent_id === null || node.id === rootId) roots.push(node);
  }
  return { tasks: roots, truncated };
}

// server/tasks/ledger-transition.ts
var RUN_FIELDS = [
  "worker",
  "pid",
  "worktree",
  "branch",
  "pr_url",
  "ci",
  "result"
];
function clipResult(text6) {
  const bytes = Buffer.from(text6, "utf8");
  if (bytes.length <= RESULT_MAX_BYTES) return text6;
  let start = bytes.length - RESULT_MAX_BYTES;
  while (start < bytes.length && (bytes[start] & 192) === 128) start++;
  return bytes.subarray(start).toString("utf8");
}
function applyTransition(db, current2, event, now, fields = {}, detail2) {
  const next = transition(current2.status, event);
  if (!next.ok)
    throw new Problem(
      409,
      `${taskRef(current2.id)}\uFF1A${next.reason}`,
      "conflict",
      void 0,
      `atrium task show ${taskRef(current2.id)}`
    );
  const sets = [];
  const params3 = [];
  for (const key of RUN_FIELDS)
    if (key in fields) {
      sets.push(`${key}=?`);
      const value = fields[key] ?? null;
      params3.push(
        key === "result" && typeof value === "string" ? clipResult(value) : value
      );
    }
  if (next.changed) {
    sets.push("status=?");
    params3.push(next.status);
    if (next.status === "running") {
      sets.push("started_at=?", "ended_at=NULL");
      params3.push(now);
    }
    if (FINISHED.has(next.status)) {
      sets.push("ended_at=?");
      params3.push(now);
    }
    if (next.status === "todo" || next.status === "blocked")
      sets.push("ended_at=NULL");
  }
  if (sets.length) {
    db.prepare(
      `UPDATE tasks SET ${sets.join(",")},updated_at=? WHERE id=?`
    ).run(...params3, now, current2.id);
  }
  if (next.changed || sets.length)
    addEvent(db, current2.id, now, event.kind, {
      from: current2.status,
      to: next.status,
      ...detail2 === void 0 ? {} : { detail: detail2 }
    });
  if (next.changed && next.status === "running" && fields.worker) {
    const event2 = db.prepare(
      "SELECT id FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1"
    ).get(current2.id);
    startDelivery(
      db,
      current2,
      event2.id,
      fields.worker,
      typeof detail2?.risk === "string" ? detail2.risk : null,
      now
    );
    db.prepare("UPDATE tasks SET worker_effort=?,worker_risk=? WHERE id=?").run(
      fields.worker.includes(":") ? fields.worker.split(":").at(-1) ?? null : null,
      typeof detail2?.risk === "string" ? detail2.risk : null,
      current2.id
    );
  }
  if (next.changed && (next.status === "done" || next.status === "failed" || next.status === "cancelled" || next.status === "blocked")) {
    endDelivery(db, current2.id, event.kind, now);
    if (next.status === "cancelled" || next.status === "failed")
      markDeliveryFinal(db, current2.id, next.status);
  }
  return next.status;
}
function advanceTask(db, reference, event, fields = {}, detail2, now = Date.now()) {
  const id3 = parseTaskRef(reference);
  return atomically(db, () => {
    applyTransition(db, requireRow(db, id3), event, now, fields, detail2);
    const task = requireRow(db, id3);
    return { ...view(task), ...noteView(db, id3, task.status) };
  });
}
function patchRunFields(db, reference, fields, kind, detail2, now = Date.now()) {
  const id3 = parseTaskRef(reference);
  return atomically(db, () => {
    requireRow(db, id3);
    const keys = RUN_FIELDS.filter((key) => key in fields);
    if (keys.length)
      db.prepare(
        `UPDATE tasks SET ${keys.map((key) => `${key}=?`).join(",")},updated_at=? WHERE id=?`
      ).run(
        ...keys.map((key) => {
          const value = fields[key] ?? null;
          return key === "result" && typeof value === "string" ? clipResult(value) : value;
        }),
        now,
        id3
      );
    addEvent(db, id3, now, kind, detail2);
    const task = requireRow(db, id3);
    return { ...view(task), ...noteView(db, id3, task.status) };
  });
}
function noteTask(db, reference, kind, detail2, now = Date.now()) {
  const id3 = parseTaskRef(reference);
  requireRow(db, id3);
  addEvent(db, id3, now, kind, detail2);
}

// server/tasks/deliver.ts
var DELIVERS = ["pr", "comment", "none"];
function deliverOf(value) {
  if (typeof value !== "string" || !DELIVERS.includes(value))
    throw usage(`deliver: \u53EA\u80FD\u662F ${DELIVERS.join("\u3001")}`);
  return value;
}
function issueOf(value) {
  if (value === void 0 || value === null || value === "") return null;
  const text6 = typeof value === "number" ? String(value) : value;
  if (typeof text6 !== "string" || !/^[1-9][0-9]*$/.test(text6))
    throw usage("issue: \u5E94\u4E3A\u6B63\u6574\u6570 issue \u53F7");
  const issue = Number(text6);
  if (!Number.isSafeInteger(issue)) throw usage("issue: \u5E94\u4E3A\u6B63\u6574\u6570 issue \u53F7");
  return issue;
}
function validateDeliver(deliver, issue) {
  if (deliver === "comment" && issue === null)
    throw usage("--deliver comment \u9700\u540C\u65F6\u7ED9 --issue <\u53F7>");
}

// server/org/task-part.ts
function partForTask(db, value, field2 = "part") {
  if (value === void 0 || value === null || value === "") return null;
  if (typeof value !== "string")
    throw usage5(`${field2}: \u5E94\u4E3A\u8282\u70B9\uFF08o4 \u6216 atrium/runtime\uFF09`);
  const text6 = value.trim();
  if (!hasOrg(db)) throw usage5(`${field2}: \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811`, "atrium org import");
  const goal = /^g([1-9][0-9]{0,15})$/.exec(text6);
  let id3;
  if (goal) {
    const found = hasGoals(db) ? one2(
      db,
      "SELECT node_id FROM goals WHERE id=?",
      Number(goal[1])
    ) : void 0;
    if (!found) throw usage5(`${field2}: \u76EE\u6807 ${text6} \u4E0D\u5B58\u5728\uFF1B\u6539\u7528 --part \u8282\u70B9`);
    id3 = found.node_id;
  } else {
    try {
      id3 = nodeByAddress(db, text6).id;
    } catch (error) {
      if (error instanceof Problem)
        throw new Problem(
          400,
          `${field2}: ${error.message}`,
          "usage",
          error.candidates,
          "atrium org tree"
        );
      throw error;
    }
  }
  const node = one2(
    db,
    "SELECT id,name,archived_at FROM org_nodes WHERE id=?",
    id3
  );
  if (!node) throw usage5(`${field2}: \u8282\u70B9 ${ref(id3)} \u4E0D\u5B58\u5728`);
  if (node.archived_at !== null)
    throw usage5(`${field2}: \u8282\u70B9 ${ref(node.id)} ${node.name} \u5DF2\u5F52\u6863`);
  return node.id;
}
var usage5 = (message4, next = "atrium org tree") => new Problem(400, message4, "usage", void 0, next);
function hasGoals(db) {
  return !!one2(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'"
  );
}

// server/tasks/specialist-options.ts
function specialistOptions(input) {
  for (const key of ["by", "ask"])
    if (key in input && input[key] !== null && typeof input[key] !== "string")
      throw new Problem(400, `${key}: \u5E94\u4E3A\u4E13\u5458\u540D\u79F0\u6216\u77ED\u53F7`, "usage");
  if ("by" in input && "job" in input)
    throw new Problem(400, "by: \u4E0E\u65E7\u5199\u6CD5 job \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
  if ("ask" in input && "concern" in input)
    throw new Problem(400, "ask: \u4E0E\u65E7\u5199\u6CD5 concern \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
  return {
    byPresent: "by" in input || "job" in input,
    by: "by" in input ? input.by : input.job,
    askPresent: "ask" in input || "concern" in input,
    ask: "ask" in input ? input.ask : input.concern,
    modernAsk: "ask" in input
  };
}

// server/tasks/specialist-scope.ts
function scopeOf(partId, input) {
  if (partId === null) return "org";
  if (partId === input.part) return "own";
  if (input.chain.includes(partId)) return "chain";
  if (input.involved.includes(partId)) return "also";
  return null;
}
var ORDER = ["own", "chain", "also", "org"];
function inScope(roles, input) {
  return roles.flatMap((role) => {
    const scope = scopeOf(role.part_id, input);
    return scope ? [{ ...role, scope }] : [];
  }).sort(
    (a, b) => ORDER.indexOf(a.scope) - ORDER.indexOf(b.scope) || a.id - b.id
  );
}
function chainOf(db, part) {
  if (part === null || !hasOrg(db)) return [];
  return chainIds(
    all2(
      db,
      "SELECT id,parent_id FROM org_nodes ORDER BY id LIMIT 501"
    ),
    part
  );
}
function scopeInput(db, part, involved) {
  return { part, chain: chainOf(db, part), involved };
}
function specialistsForPart(db, address) {
  const node = nodeByAddress(db, address);
  const { auto } = involvedOf(db, { id: 0, part_id: node.id, node_id: null });
  return {
    part: ref(node.id),
    name: node.name,
    specialists: inScope(listJobRoles(db), scopeInput(db, node.id, auto))
  };
}
function specialistsForTask(db, task) {
  const { auto } = involvedOf(db, { id: 0, part_id: task.part, node_id: null });
  const input = scopeInput(db, task.part, [...task.also, ...auto]);
  return { input, specialists: inScope(listJobRoles(db), input) };
}
var names = (list4) => list4.map((s) => s.name).join("\u3001") || "\uFF08\u65E0\uFF09";
function checkSpecialists(db, task, picks) {
  const wanted = picks.filter((p3) => p3.ids.length);
  if (!wanted.length) return;
  const { specialists } = specialistsForTask(db, task);
  const allowed3 = new Set(specialists.map((s) => s.id));
  const roles = listJobRoles(db);
  for (const { flag, ids } of wanted)
    for (const id3 of ids) {
      if (allowed3.has(id3)) continue;
      const role = roles.find((r) => r.id === id3);
      if (!role) continue;
      const where = task.part === null ? "\u672C\u4EFB\u52A1\u6CA1\u6709\u5F52\u5C5E\u90E8\u5206" : `\u672C\u4EFB\u52A1\u5F52\u5C5E ${ref(task.part)}`;
      throw new Problem(
        400,
        `${flag}: ${role.name}\uFF08${role.ref}\uFF09\u5C5E\u4E8E\u300C${role.part_name ?? role.part}\u300D\uFF08${role.part}\uFF09\uFF0C${where}\uFF0C\u8BF7\u4E0D\u5230\u5B83\uFF1B\u53EF\u9009\uFF1A${names(specialists)}\uFF1B\u786E\u5B9E\u8981\u5B83\u4E00\u8D77\u770B\uFF0C\u52A0 --also ${role.part}`,
        "usage",
        void 0,
        task.part === null ? "atrium specialist ls" : `atrium specialist ls --part ${ref(task.part)}`
      );
    }
}
function pickSpecialists(db, task) {
  const part = task.part_id ?? task.node_id;
  const { specialists } = specialistsForTask(db, {
    part,
    also: alsoOf(db, task.id)
  });
  const job = task.job_id && !specialists.some((s) => s.id === task.job_id) ? listJobRoles(db).find((r) => r.id === task.job_id) : void 0;
  return {
    available: specialists.map((s) => ({
      ref: s.ref,
      name: s.name,
      scope: s.scope,
      part: s.part,
      part_name: s.part_name
    })),
    job_outside: job ? `\u5E72\u6D3B\u7684\u4E13\u5458 ${job.name}\uFF08${job.ref}\uFF09\u5C5E\u4E8E\u300C${job.part_name ?? job.part}\u300D\uFF0C\u4E0D\u5728\u672C\u4EFB\u52A1\u8303\u56F4\uFF1A\u52A0 --also ${job.part} \u6216\u6362 --by` : null
  };
}

// server/tasks/ledger-write.ts
function briefOf(input, repo) {
  const brief_path = optionalText(input.brief_path, "brief_path");
  if (input.brief !== void 0)
    return { brief: briefText(input.brief), brief_path };
  return {
    brief: brief_path ? readBriefFile(brief_path, repo) : null,
    brief_path
  };
}
function urgentOf(value) {
  if (value === void 0) return false;
  if (typeof value !== "boolean") throw usage("urgent: \u5E94\u4E3A true \u6216 false");
  return value;
}
var roleNode = (db, role, repo) => role ? matchRole(db, role, repo, true).node?.id ?? null : null;
var fromNode = (db, value) => {
  const text6 = optionalText(value, "from", 200);
  return text6 ? originNode(db, text6).id : null;
};
function partOf2(db, input) {
  if ("part" in input && "goal" in input)
    throw usage("part: \u4E0E goal \u53EA\u80FD\u7ED9\u4E00\u4E2A\uFF1Bgoal \u5DF2\u6539\u4E3A\u5F52\u5C5E\u90E8\u5206\uFF0C\u7528 part");
  return "goal" in input ? partForTask(db, input.goal, "goal") : partForTask(db, input.part);
}
function withConcerns(db, task, hints) {
  const concerns = concernsOf(db, task.id);
  const concern_hints = hints ? textHints(db, task) : [];
  return {
    ...concerns.length ? { concerns } : {},
    ...concern_hints.length ? { concern_hints } : {},
    ...involvedView(involvedOf(db, task))
  };
}
function checkScope(db, task, job, concerns, byFlag) {
  checkSpecialists(db, task, [
    { flag: byFlag, ids: job ? [job] : [] },
    { flag: "ask", ids: concerns.filter((id3) => id3 < 0).map((id3) => -id3) }
  ]);
}
function createTask(db, body3, now = Date.now(), by) {
  const input = objectOf2(body3);
  onlyKeys(input, [
    "title",
    "parent",
    "role",
    "job",
    "by",
    "repo",
    "brief",
    "brief_path",
    "owner",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "urgent",
    "from",
    "part",
    "goal",
    "concern",
    "ask",
    "also"
  ]);
  const specialist = specialistOptions(input);
  const urgent = urgentOf(input.urgent);
  const deliver = input.deliver === void 0 ? "pr" : deliverOf(input.deliver);
  const issue = issueOf(input.issue);
  validateDeliver(deliver, issue);
  const repo = repoOf(input.repo);
  const values2 = {
    owner: input.owner === void 0 || input.owner === null || input.owner === "" ? null : ownerOf(input.owner),
    title: title(input.title),
    role: optionalText(input.role, "role", 200),
    repo,
    ...briefOf(input, repo)
  };
  return atomically(db, () => {
    const parent = parentOf(db, input.parent);
    let oldRoleSpecialist = null;
    if (values2.role && !specialist.byPresent)
      try {
        oldRoleSpecialist = getJobRole(db, values2.role).id;
      } catch (error) {
        if (!(error instanceof Problem) || error.statusCode !== 404)
          throw error;
      }
    const role = oldRoleSpecialist ? null : values2.role;
    const node = roleNode(db, role, values2.repo);
    const job = specialist.by ? getJobRole(db, specialist.by).id : oldRoleSpecialist;
    const origin = fromNode(db, input.from);
    const part = partOf2(db, input);
    const concerns = specialist.modernAsk ? specialistsFor(db, specialist.ask) : concernsFor(db, specialist.ask);
    const also = alsoFor(db, input.also);
    checkScope(
      db,
      { part: part ?? node, also },
      job,
      concerns,
      oldRoleSpecialist ? "role" : "by"
    );
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO tasks(parent_id,title,brief,brief_path,role,repo,owner,deliver,issue,node_id,origin_node_id,part_id,job_id,urgent,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'todo',?,?)"
    ).run(
      parent,
      values2.title,
      values2.brief,
      values2.brief_path,
      role,
      values2.repo,
      values2.owner,
      deliver,
      issue,
      node,
      origin,
      part,
      job,
      urgent ? 1 : 0,
      now,
      now
    );
    const id3 = Number(lastInsertRowid);
    setConditions(db, id3, input, now);
    writeConcerns(db, id3, concerns);
    writeAlso(db, id3, also);
    addEvent(db, id3, now, "created", {
      title: values2.title,
      ...parent ? { parent: taskRef(parent) } : {},
      ...node ? { node: `o${node}` } : {},
      ...origin ? { from: `o${origin}` } : {},
      ...part ? { part: `o${part}` } : {},
      ...job ? { job: `r${job}` } : {},
      ...concerns.length ? { concerns: concerns.map(specialistRef) } : {},
      ...urgent ? { urgent: true } : {},
      ...also.length ? { also: also.map(ref) } : {},
      ...by ? { by } : {}
    });
    const task = requireRow(db, id3);
    return {
      ...view(task),
      ...noteView(db, id3, task.status),
      ...withConcerns(db, task, true)
    };
  });
}
function updateTask(db, reference, body3, now = Date.now()) {
  const id3 = parseTaskRef(reference);
  const input = objectOf2(body3);
  onlyKeys(input, [
    "title",
    "brief",
    "brief_path",
    "role",
    "job",
    "by",
    "status",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "urgent",
    "pr_url",
    "from",
    "part",
    "goal",
    "concern",
    "ask",
    "also"
  ]);
  const specialist = specialistOptions(input);
  if (!Object.keys(input).length)
    throw usage(
      "\u81F3\u5C11\u4FEE\u6539\u4E00\u9879\uFF1Atitle\u3001brief\u3001brief_path\u3001role\u3001job\u3001from\u3001part\u3001also\u3001concern\u3001status\u3001deliver\u3001issue\u3001after\u3001after_pr\u3001auto\u3001urgent\u3001pr_url"
    );
  const fields = {};
  if ("title" in input) fields.title = title(input.title);
  if ("role" in input) fields.role = optionalText(input.role, "role", 200);
  if ("deliver" in input) fields.deliver = deliverOf(input.deliver);
  if ("issue" in input) fields.issue = issueOf(input.issue);
  if ("urgent" in input) fields.urgent = urgentOf(input.urgent) ? 1 : 0;
  if ("pr_url" in input) {
    if (typeof input.pr_url !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(
      input.pr_url
    ))
      throw usage("pr_url: \u5E94\u4E3A https://github.com/owner/repo/pull/N");
    fields.pr_url = input.pr_url;
  }
  const target = "status" in input ? statusOf(input.status) : void 0;
  return atomically(db, () => {
    const current2 = requireRow(db, id3);
    if ("brief" in input || "brief_path" in input)
      Object.assign(fields, briefOf(input, current2.repo));
    if (specialist.byPresent)
      fields.job_id = specialist.by ? getJobRole(db, specialist.by).id : null;
    if ("role" in fields) {
      let oldRoleSpecialist = null;
      if (fields.role && !specialist.byPresent)
        try {
          oldRoleSpecialist = getJobRole(db, fields.role).id;
        } catch (error) {
          if (!(error instanceof Problem) || error.statusCode !== 404)
            throw error;
        }
      if (oldRoleSpecialist) {
        fields.job_id = oldRoleSpecialist;
        fields.role = null;
        fields.node_id = null;
      } else
        fields.node_id = roleNode(
          db,
          fields.role,
          current2.repo
        );
    }
    if (current2.status === "running" && "job_id" in fields && fields.job_id !== current2.job_id)
      throw new Problem(
        409,
        "\u6267\u884C\u4E2D\u4E0D\u80FD\u4FEE\u6539 --by\uFF1A\u672C\u8F6E\u4E13\u5458\u5DF2\u9644\u8FDB\u63D0\u793A\u8BCD",
        "conflict"
      );
    if ("from" in input) fields.origin_node_id = fromNode(db, input.from);
    if ("part" in input || "goal" in input) fields.part_id = partOf2(db, input);
    if (fields.pr_url !== void 0 && current2.status === "running")
      throw new Problem(409, "\u6267\u884C\u4E2D\u4E0D\u80FD\u4EBA\u5DE5\u8865\u767B PR", "conflict");
    const concerns = specialist.askPresent ? specialist.modernAsk ? specialistsFor(db, specialist.ask) : concernsFor(db, specialist.ask) : void 0;
    if (concerns && current2.status === "running")
      throw new Problem(
        409,
        "\u6267\u884C\u4E2D\u4E0D\u80FD\u6539\u8BF7\u7684\u4E13\u5458\uFF1A\u63D0\u793A\u8BCD\u5DF2\u7ECF\u53D1\u51FA\uFF1B\u7B49\u5B83\u7ED3\u675F\u518D\u6539\uFF0C\u4E0B\u4E00\u8F6E\u751F\u6548",
        "conflict",
        void 0,
        `atrium task wait ${taskRef(id3)}`
      );
    const also = "also" in input ? alsoFor(db, input.also) : void 0;
    if ("job_id" in fields || concerns || also || "part_id" in fields || "node_id" in fields) {
      const job = "job_id" in fields ? fields.job_id : current2.job_id;
      checkScope(
        db,
        {
          part: ("part_id" in fields ? fields.part_id : current2.part_id) ?? ("node_id" in fields ? fields.node_id : current2.node_id),
          also: also ?? alsoOf(db, id3)
        },
        job ?? null,
        concerns ?? concernRows(db, id3).map((row3) => row3.node_id),
        "role" in input && !specialist.byPresent ? "role" : "by"
      );
    }
    setConditions(db, id3, input, now);
    if (also) {
      const before = alsoOf(db, id3).map(ref);
      writeAlso(db, id3, also);
      const after = also.map(ref);
      if (before.join(",") !== after.join(","))
        addEvent(db, id3, now, "also", { from: before, to: after });
    }
    if (concerns) {
      const before = concernRows(db, id3).map(
        (row3) => specialistRef(row3.node_id)
      );
      writeConcerns(db, id3, concerns);
      const after = concerns.map(specialistRef);
      if (before.join(",") !== after.join(","))
        addEvent(db, id3, now, "concerns", { from: before, to: after });
    }
    if (current2.status === "running" && (fields.deliver !== void 0 && fields.deliver !== current2.deliver || fields.issue !== void 0 && fields.issue !== current2.issue))
      throw new Problem(409, "\u6267\u884C\u4E2D\u4E0D\u80FD\u4FEE\u6539\u4EA4\u4ED8\u7269\u7C7B\u578B\u6216 issue \u53F7", "conflict");
    validateDeliver(
      fields.deliver ?? current2.deliver,
      fields.issue === void 0 ? current2.issue : fields.issue
    );
    const changed2 = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => current2[key] !== value
      )
    );
    if (changed2.pr_url) changed2.ci = "pending";
    if (Object.keys(changed2).length) {
      db.prepare(
        `UPDATE tasks SET ${Object.keys(changed2).map((key) => `${key}=?`).join(",")},updated_at=? WHERE id=?`
      ).run(...Object.values(changed2), now, id3);
      addEvent(
        db,
        id3,
        now,
        "edited",
        "brief" in changed2 ? {
          ...changed2,
          brief: changed2.brief ? `\u5DF2\u66F4\u65B0\uFF08${Array.from(String(changed2.brief)).length} \u5B57\uFF09` : "\u5DF2\u6E05\u7A7A"
        } : changed2
      );
    }
    if (target !== void 0)
      applyTransition(db, current2, { kind: "manual_set", to: target }, now);
    const task = requireRow(db, id3);
    return {
      ...view(task),
      ...noteView(db, id3, task.status),
      ...withConcerns(db, task, concerns !== void 0 || "title" in input)
    };
  });
}

// server/tasks/event-level.ts
var information = /* @__PURE__ */ new Set([
  "merge_queued",
  "merge_returned",
  "merge_retry",
  "merge_rebased",
  "merge_started",
  "merge_check",
  "local_check_started",
  "local_check_running",
  "merged",
  "review_queued",
  "review_passed",
  "quota_switched",
  "quota_queued",
  "quota_cleared",
  "quota_restored",
  "transient_retry",
  "thinking_retry",
  "ci_success",
  "ci_pending",
  "patrol_finished",
  // 牵涉知会（#373）：让被牵涉部分的 leader 知道，不叫醒。
  "involved"
]);
function eventLevel(kind, detail2) {
  if (kind === "ready") {
    const data2 = detail2;
    return data2?.auto === true && data2.unassigned !== true ? "info" : "action";
  }
  return information.has(kind) ? "info" : "action";
}
function summarizeEvents(events2) {
  const groups = /* @__PURE__ */ new Map();
  for (const event of events2) {
    const key = event.task ?? `#${event.id}`;
    groups.set(key, [...groups.get(key) ?? [], event]);
  }
  return [...groups].map(([key, rows]) => {
    const returns = rows.filter((row3) => row3.kind === "merge_returned").reduce((sum, row3) => sum + row3.count, 0);
    const kinds = new Set(rows.map((row3) => row3.kind));
    const progress = [];
    if (kinds.has("merge_queued")) progress.push("\u6392\u961F\u5408\u5165");
    if (kinds.has("merge_rebased")) progress.push("\u5DF2 rebase");
    if (kinds.has("merge_check") || kinds.has("local_check_started"))
      progress.push("\u672C\u5730\u68C0\u67E5");
    const summary2 = kinds.has("merged") ? `${returns ? `\u9000\u56DE ${returns} \u6B21\u540E` : ""}\u5408\u5165` : [returns ? `\u9000\u56DE ${returns} \u6B21` : "", ...progress].filter(Boolean).join("\uFF0C") || [...kinds].join("\u3001");
    return {
      task: rows[0].task,
      summary: `${key}\uFF1A${summary2}`,
      ids: rows.map((row3) => row3.id)
    };
  });
}

// server/tasks/notice.ts
function publishTask(inbox, db, id3, kind, detail2, actor) {
  if (db.prepare("SELECT 1 FROM tasks WHERE review_task=? LIMIT 1").get(id3))
    return;
  const task = getTask(db, id3);
  const route = taskRoute(db, task);
  const key = kind === "online" || kind === "online_failed" ? kind : eventLevel(kind, detail2) === "info" ? kind : kind.startsWith("ci") ? "ci" : "outcome";
  for (const target of deliveryRoutes(kind, route))
    inbox.publish({
      subscriber: target.subscriber,
      taskId: id3,
      source: detail2.source === void 0 ? "runner" : String(detail2.source),
      kind,
      key: `${task.ref}:${key}`,
      actor,
      detail: {
        title: task.title,
        status: task.status,
        worker: task.worker,
        pr_url: task.pr_url,
        ci: task.ci,
        ...detail2,
        routed: { to: target.subscriber, why: target.why }
      }
    });
  if (kind === "blocked" && detail2.source === "budget" && task.node_id !== null) {
    const list4 = nodes(db);
    const node = list4.find((n) => n.id === task.node_id);
    if (node?.leader && node.leader !== route.subscriber)
      inbox.publish({
        subscriber: node.leader,
        taskId: id3,
        source: "budget",
        kind,
        key: `${task.ref}:budget`,
        actor,
        detail: { title: task.title, ...detail2 }
      });
  }
}
function publishInvolved(inbox, db, id3, before = [], actor) {
  if (!hasOrg(db)) return [];
  const task = getTask(db, id3);
  if (task.status === "done" || task.status === "cancelled") return [];
  const { also, auto } = involvedOf(db, task);
  const main = taskRoute(db, task).subscriber;
  const list4 = nodes(db);
  const sent = [];
  for (const nodeId of [...also, ...auto]) {
    if (before.includes(nodeId)) continue;
    const route = partRoute(db, nodeId);
    if (route.subscriber === SECRETARY || route.subscriber === main) continue;
    const name2 = list4.find((n) => n.id === nodeId)?.name ?? ref(nodeId);
    inbox.publish({
      subscriber: route.subscriber,
      taskId: id3,
      source: "ledger",
      kind: "involved",
      key: `${task.ref}:involved:${ref(nodeId)}`,
      actor,
      detail: {
        title: task.title,
        status: task.status,
        part: task.part_ref,
        involved: ref(nodeId),
        involved_name: name2,
        auto: auto.includes(nodeId),
        hint: `${task.ref} \u7275\u6D89\u4F60\u8D1F\u8D23\u7684\u300C${name2}\u300D${auto.includes(nodeId) ? "\uFF08\u5B83\u7684\u8981\u70B9\u9002\u7528\u4E8E\u8FD9\u4E2A\u4EFB\u52A1\u7684\u5F52\u5C5E\u90E8\u5206\uFF09" : ""}\uFF1A\u8D1F\u8D23\u4E0E\u6C47\u62A5\u4E0D\u5728\u4F60\u8FD9\u91CC\uFF1B\u6709\u8BDD\u5199\u5907\u6CE8 atrium task note ${task.ref} \u6587\u5B57\uFF0C\u6216\u634E\u8BDD atrium task tell ${task.ref} \u6587\u5B57\uFF1B\u8981\u5426\u51B3\u53D1\u8D77\u4F1A\u5BA1 atrium review add`,
        routed: { to: route.subscriber, why: route.why }
      }
    });
    sent.push(ref(nodeId));
  }
  return sent;
}

// server/tasks/events.ts
import { EventEmitter } from "node:events";

// server/tasks/event-lease.ts
var LEASE_MS = 15 * 6e4;
var selfInitiated = (subscriber, actor) => actor !== null && actor === subscriber;

// server/tasks/events.ts
function ensureEventTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber TEXT NOT NULL,
      task_id INTEGER,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      detail TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ready_at INTEGER NOT NULL,
      acked_at INTEGER);
    CREATE INDEX IF NOT EXISTS task_inbox_pending ON task_inbox(subscriber,acked_at,id);
    CREATE INDEX IF NOT EXISTS task_inbox_key ON task_inbox(subscriber,dedupe_key,acked_at);`);
  const columns = new Set(
    db.prepare("PRAGMA table_info(task_inbox)").all().map((column) => column.name)
  );
  if (!columns.has("actor"))
    db.exec("ALTER TABLE task_inbox ADD COLUMN actor TEXT");
  if (!columns.has("delivered_at"))
    db.exec("ALTER TABLE task_inbox ADD COLUMN delivered_at INTEGER");
}
var view4 = (row3) => {
  let detail2 = row3.detail;
  try {
    detail2 = row3.detail === null ? null : JSON.parse(row3.detail);
  } catch {
    detail2 = row3.detail;
  }
  return {
    id: row3.id,
    subscriber: row3.subscriber,
    task: row3.task_id === null ? null : taskRef(row3.task_id),
    source: row3.source,
    kind: row3.kind,
    level: eventLevel(row3.kind, detail2),
    key: row3.dedupe_key,
    actor: row3.actor,
    count: row3.count,
    detail: detail2,
    created_at: row3.created_at,
    updated_at: row3.updated_at,
    delivered_at: row3.delivered_at,
    acked_at: row3.acked_at
  };
};
var BATCH_LIMIT = 50;
var WAIT_MAX_SECONDS = 3600;
var ACK_MAX = 500;
var LIST_LIMIT2 = 50;
var LIST_MAX2 = 200;
function listOptions(query2) {
  const positive = (value, name2, max) => {
    if (value === void 0) return void 0;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
      throw usage6(`${name2}: \u5E94\u4E3A 1\uFF5E${max} \u7684\u6574\u6570`);
    return Number(value);
  };
  return {
    before: positive(query2.before, "before", Number.MAX_SAFE_INTEGER),
    limit: positive(query2.limit, "limit", LIST_MAX2) ?? LIST_LIMIT2
  };
}
var EventInbox = class {
  constructor(db, options = {}) {
    this.db = db;
    this.batchMs = options.batchMs ?? 0;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.now = options.now ?? Date.now;
    ensureEventTables(db);
    this.emitter.setMaxListeners(0);
  }
  db;
  emitter = new EventEmitter();
  lastWait = /* @__PURE__ */ new Map();
  closed = false;
  batchMs;
  leaseMs;
  now;
  publish(event) {
    const now = this.now();
    const subscriber = ownerOf(event.subscriber, "subscriber");
    const actor = event.actor === void 0 ? null : ownerOf(event.actor, "as");
    const self = selfInitiated(subscriber, actor);
    const detail2 = event.detail === void 0 ? null : JSON.stringify(event.detail);
    const existing = this.db.prepare(
      `SELECT * FROM task_inbox WHERE subscriber=? AND dedupe_key=? AND acked_at IS NULL AND ${self ? "actor=?" : "(actor IS NULL OR actor<>?)"} ORDER BY id DESC LIMIT 1`
    ).get(subscriber, event.key, subscriber);
    let id3;
    if (existing) {
      this.db.prepare(
        "UPDATE task_inbox SET kind=?,source=?,actor=?,detail=?,count=count+1,updated_at=?,delivered_at=NULL WHERE id=?"
      ).run(event.kind, event.source, actor, detail2, now, existing.id);
      id3 = existing.id;
    } else {
      const inserted = this.db.prepare(
        "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,actor,detail,created_at,updated_at,ready_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(
        subscriber,
        event.taskId ?? null,
        event.source,
        event.kind,
        event.key,
        actor,
        detail2,
        now,
        now,
        now + this.batchMs
      );
      id3 = Number(inserted.lastInsertRowid);
    }
    const row3 = this.db.prepare("SELECT * FROM task_inbox WHERE id=?").get(id3);
    if (self) return view4(row3);
    this.emitter.emit(subscriber);
    if (this.batchMs > 0)
      setTimeout(() => this.emitter.emit(subscriber), this.batchMs + 5).unref();
    return view4(row3);
  }
  /** 最近事件，含已送达与已确认记录；按编号倒序、有界分页。 */
  list(subscriber, options) {
    const who2 = ownerOf(subscriber, "as");
    const rows = this.db.prepare(
      "SELECT * FROM task_inbox WHERE subscriber=? AND id<? ORDER BY id DESC LIMIT ?"
    ).all(
      who2,
      options.before ?? Number.MAX_SAFE_INTEGER,
      options.limit + 1
    );
    const page = rows.slice(0, options.limit);
    return {
      events: page.map(view4),
      next_before: rows.length > options.limit ? page.at(-1).id : null
    };
  }
  /** 可投递的事件（条件与 event-lease.ts 的 deliverable 一致），按编号升序，每批最多 50 条；只看不交。 */
  pending(subscriber, limit = BATCH_LIMIT, all3 = false) {
    const now = this.now();
    const result = [];
    let after = 0;
    while (result.length < limit) {
      const rows = this.db.prepare(
        "SELECT * FROM task_inbox WHERE subscriber=? AND id>? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND ready_at<=? AND (delivered_at IS NULL OR delivered_at<=?) ORDER BY id LIMIT 200"
      ).all(subscriber, after, now, now - this.leaseMs);
      for (const row3 of rows) {
        after = row3.id;
        const event = view4(row3);
        if (all3 || event.level === "action") result.push(event);
        if (result.length === limit) break;
      }
      if (rows.length < 200) break;
    }
    return result;
  }
  /**
   * 未处理事件条数（#262 `atrium top` 的汇总行）：条件与 pending 一致，只数不取。
   * 计数封顶 cap，攒批窗口未到的事件也算未处理。
   */
  countPending(subscriber, cap2 = BATCH_LIMIT) {
    return this.pending(subscriber, cap2).length;
  }
  /** 取一批交给订阅者，并从现在起算处理中租约。 */
  take(subscriber, all3 = false) {
    return atomically(this.db, () => {
      const events2 = this.pending(subscriber, BATCH_LIMIT, all3);
      const mark = this.db.prepare(
        "UPDATE task_inbox SET delivered_at=? WHERE id=?"
      );
      const now = this.now();
      for (const event of events2) mark.run(now, event.id);
      return events2.map((event) => ({ ...event, delivered_at: now }));
    });
  }
  /** 最早到期的处理中租约还有多久（毫秒）；没有处理中的返回 undefined。 */
  nextLeaseIn(subscriber, all3 = false) {
    let offset = 0;
    while (true) {
      const rows = this.db.prepare(
        "SELECT * FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND delivered_at IS NOT NULL AND (actor IS NULL OR actor<>subscriber) ORDER BY delivered_at,id LIMIT 200 OFFSET ?"
      ).all(subscriber, offset);
      const row3 = rows.find((entry) => all3 || view4(entry).level === "action");
      if (row3)
        return Math.max(0, row3.delivered_at + this.leaseMs - this.now());
      if (rows.length < 200) return void 0;
      offset += rows.length;
    }
  }
  /**
   * 只把仍可投递的指定事件记为已送达（唤醒通道送入会话前调用），返回实际标记的事件；
   * 已确认、处理中或不属于该订阅者的编号略过。之后与 wait 取走的一样走处理中租约。
   */
  deliver(subscriber, ids) {
    const who2 = ownerOf(subscriber, "as");
    const wanted = new Set(ids);
    return atomically(this.db, () => {
      const events2 = this.pending(who2, BATCH_LIMIT).filter(
        (event) => wanted.has(event.id)
      );
      const mark = this.db.prepare(
        "UPDATE task_inbox SET delivered_at=? WHERE id=?"
      );
      const now = this.now();
      for (const event of events2) mark.run(now, event.id);
      return events2.map((event) => ({ ...event, delivered_at: now }));
    });
  }
  /** A failed one-shot wake can relinquish its lease without touching newer merges or acknowledgements. */
  release(subscriber, events2) {
    const who2 = ownerOf(subscriber, "as");
    const clear = this.db.prepare(
      "UPDATE task_inbox SET delivered_at=NULL WHERE subscriber=? AND id=? AND acked_at IS NULL AND delivered_at=? AND updated_at=?"
    );
    atomically(this.db, () => {
      for (const event of events2)
        if (event.delivered_at !== null)
          clear.run(who2, event.id, event.delivered_at, event.updated_at);
    });
    this.emitter.emit(who2);
  }
  /** 服务重启后收回上次唤醒没确认完的处理中租约，免得等满租约才重投。 */
  releaseAll(subscriber) {
    const who2 = ownerOf(subscriber, "as");
    this.db.prepare(
      "UPDATE task_inbox SET delivered_at=NULL WHERE subscriber=? AND acked_at IS NULL AND delivered_at IS NOT NULL"
    ).run(who2);
    this.emitter.emit(who2);
  }
  /** 事件编号各自的订阅者；不存在的编号不出现在结果里。 */
  subscribersOf(ids) {
    const map = /* @__PURE__ */ new Map();
    const get = this.db.prepare("SELECT subscriber FROM task_inbox WHERE id=?");
    for (const id3 of ids) {
      const row3 = get.get(id3);
      if (row3) map.set(id3, row3.subscriber);
    }
    return map;
  }
  /**
   * 送达后内容又被合并更新过的事件（处理期间同一任务又有新结果）：已确认的重新打开、收回租约，
   * 让新内容再投一次，免得「确认旧内容」顺带吞掉新结果。返回内容变过的编号。
   */
  reopenChanged(subscriber, events2) {
    const who2 = ownerOf(subscriber, "as");
    const read = this.db.prepare(
      "SELECT updated_at FROM task_inbox WHERE subscriber=? AND id=?"
    );
    const reopen = this.db.prepare(
      "UPDATE task_inbox SET acked_at=NULL,delivered_at=NULL WHERE subscriber=? AND id=?"
    );
    const changed2 = atomically(
      this.db,
      () => events2.flatMap((event) => {
        const row3 = read.get(who2, event.id);
        if (!row3 || row3.updated_at <= event.updated_at) return [];
        reopen.run(who2, event.id);
        return [event.id];
      })
    );
    if (changed2.length) this.emitter.emit(who2);
    return changed2;
  }
  /** 这批事件里还没确认的编号。 */
  unacked(ids) {
    const get = this.db.prepare("SELECT acked_at FROM task_inbox WHERE id=?");
    return ids.filter((id3) => {
      const row3 = get.get(id3);
      return row3 !== void 0 && row3.acked_at === null;
    });
  }
  /**
   * 有可取事件立即返回；否则等到有事件、超时或服务关闭。
   * peek 只看不取：不记送达、不起租约，供唤醒通道判断空闲后再 deliver。
   */
  async wait(subscriber, timeoutSeconds, signal, options = {}) {
    const who2 = ownerOf(subscriber, "as");
    if (options.trackOnline !== false) this.lastWait.set(who2, this.now());
    const all3 = options.all === true;
    const settleMs = (options.settleSeconds ?? 0) * 1e3;
    const take = () => options.peek ? this.pending(who2, BATCH_LIMIT, all3) : this.take(who2, all3);
    const ready = this.pending(who2, 1, all3);
    if (ready.length && (settleMs === 0 || timeoutSeconds <= 0) || !ready.length && timeoutSeconds <= 0 || this.closed)
      return {
        events: take(),
        timed_out: !ready.length,
        ...this.closed ? { restarting: true } : {}
      };
    return new Promise((resolve4) => {
      let settled = false;
      let collecting = Boolean(ready.length);
      let settleTimer;
      if (collecting) settleTimer = setTimeout(() => finish(), settleMs);
      const finish = (restarting = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(lease2);
        clearTimeout(settleTimer);
        this.emitter.off(who2, check2);
        this.emitter.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        if (options.trackOnline !== false) this.lastWait.set(who2, this.now());
        const events2 = take();
        resolve4({
          events: events2,
          timed_out: !events2.length,
          ...restarting ? { restarting: true } : {}
        });
      };
      let lease2;
      const arm = () => {
        clearTimeout(lease2);
        const leaseIn = this.nextLeaseIn(who2, all3);
        lease2 = leaseIn !== void 0 && leaseIn < timeoutSeconds * 1e3 ? setTimeout(check2, leaseIn + 5) : void 0;
      };
      const check2 = () => {
        if (this.pending(who2, 1, all3).length) {
          if (settleMs === 0) finish();
          else if (!collecting) {
            collecting = true;
            settleTimer = setTimeout(() => finish(), settleMs);
          }
        } else arm();
      };
      const closing = () => finish(true);
      const aborted = () => finish();
      const timer = setTimeout(() => finish(), timeoutSeconds * 1e3);
      arm();
      this.emitter.on(who2, check2);
      this.emitter.on("close", closing);
      signal?.addEventListener("abort", aborted);
    });
  }
  ack(ids) {
    const now = this.now();
    const acked = [];
    const missing = [];
    for (const id3 of ids) {
      const result = this.db.prepare(
        "UPDATE task_inbox SET acked_at=? WHERE id=? AND acked_at IS NULL"
      ).run(now, id3);
      if (result.changes) acked.push(id3);
      else missing.push(id3);
    }
    return { acked, missing };
  }
  /** 读取知会摘要与确认在同一事务中，避免读过却重复出现在下次摘要。 */
  digest(subscriber, since) {
    const who2 = ownerOf(subscriber, "as");
    return atomically(this.db, () => {
      const events2 = [];
      let after = 0;
      while (true) {
        const rows = this.db.prepare(
          "SELECT * FROM task_inbox WHERE subscriber=? AND id>? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND updated_at>=? ORDER BY id LIMIT 200"
        ).all(who2, after, since ?? 0);
        for (const row3 of rows) {
          after = row3.id;
          const event = view4(row3);
          if (event.level === "info") events2.push(event);
        }
        if (rows.length < 200) break;
      }
      const mark = this.db.prepare(
        "UPDATE task_inbox SET acked_at=? WHERE id=? AND acked_at IS NULL"
      );
      for (const event of events2) mark.run(this.now(), event.id);
      return { items: summarizeEvents(events2), acknowledged: events2.length };
    });
  }
  /** 订阅者最近一次挂着 wait 的时间：#193 据此判断在线，无人在线时再后台唤醒。 */
  lastWaitAt(subscriber) {
    return this.lastWait.get(subscriber);
  }
  close() {
    this.closed = true;
    this.emitter.emit("close");
  }
};
var usage6 = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function waitSeconds(value) {
  if (value === void 0 || value === "") return 300;
  const text6 = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text6) || Number(text6) > WAIT_MAX_SECONDS)
    throw usage6(`timeout: \u5E94\u4E3A 0\uFF5E${WAIT_MAX_SECONDS} \u7684\u6574\u6570\u79D2`);
  return Number(text6);
}
function settleSeconds(value) {
  if (value === void 0) return 30;
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || Number(value) > 300)
    throw usage6("settle: \u5E94\u4E3A 0\uFF5E300 \u7684\u6574\u6570\u79D2");
  return Number(value);
}
function sinceTime(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    throw usage6("since: \u5E94\u4E3A\u5E26\u65F6\u533A\u7684 ISO \u65F6\u95F4\uFF0C\u5982 2026-09-27T10:00:00+08:00");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw usage6("since: \u5E94\u4E3A\u5E26\u65F6\u533A\u7684 ISO \u65F6\u95F4\uFF0C\u5982 2026-09-27T10:00:00+08:00");
  return parsed;
}
function ackIds(body3) {
  const ids = body3 && typeof body3 === "object" && !Array.isArray(body3) ? body3.ids : void 0;
  if (!Array.isArray(ids) || !ids.length)
    throw usage6("ids: \u81F3\u5C11\u7ED9\u4E00\u4E2A\u4E8B\u4EF6\u7F16\u53F7", "atrium events wait");
  if (ids.length > ACK_MAX) throw usage6(`ids: \u4E00\u6B21\u6700\u591A ${ACK_MAX} \u4E2A`);
  return [
    ...new Set(
      ids.map((value) => {
        const id3 = Number(value);
        if (!Number.isSafeInteger(id3) || id3 <= 0 || String(value).trim() === "")
          throw usage6(`ids: \u4E8B\u4EF6\u7F16\u53F7\u5E94\u4E3A\u6B63\u6574\u6570\uFF08\u6536\u5230\uFF1A${String(value)}\uFF09`);
        return id3;
      })
    )
  ];
}

// server/leaders/tokens.ts
import { createHash as createHash5, randomBytes as randomBytes2 } from "node:crypto";
var FORMAT = /^Bearer (a[1-9][0-9]{0,8})\.([a-f0-9]{64})$/i;
var digest2 = (value) => createHash5("sha256").update(value).digest("hex");
var LeaderTokens = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  now;
  tokens = /* @__PURE__ */ new Map();
  /** 签发；同一 leader 同时只有一枚，重签即作废旧的。 */
  issue(leader, ttlMs) {
    const secret2 = randomBytes2(32).toString("hex");
    this.tokens.set(leader, {
      hash: digest2(secret2),
      expires: this.now() + ttlMs
    });
    return `${leader}.${secret2}`;
  }
  revoke(leader) {
    this.tokens.delete(leader);
  }
  /** 看起来像 leader 令牌（不论真假）：认证时据此走 leader 分支，不再当用户令牌。 */
  static looksLike(authorization) {
    return FORMAT.test(authorization ?? "");
  }
  /** 有效时返回 aN，否则 null。 */
  verify(authorization) {
    const match = FORMAT.exec(authorization ?? "");
    if (!match) return null;
    const leader = match[1];
    const entry = this.tokens.get(leader);
    if (!entry || entry.expires < this.now()) return null;
    return sameSecret(digest2(match[2].toLowerCase()), entry.hash) ? leader : null;
  }
};

// server/leaders/scope.ts
var RULES = {
  "POST /api/tasks": "task-create",
  "PATCH /api/tasks/:id": "task-patch",
  "POST /api/tasks/:id/note": "task-remark",
  "POST /api/tasks/:id/tell": "task-remark",
  "POST /api/tasks/:id/run": "task",
  "POST /api/tasks/:id/stop": "task",
  "POST /api/reviews": "review-create",
  "POST /api/events/ack": "events-ack",
  "POST /api/org/nodes/:id/points": "point",
  "PATCH /api/org/points/:id": "point",
  "DELETE /api/org/points/:id": "point",
  "PUT /api/org/nodes/:id/stages": "stages",
  "PATCH /api/org/nodes/:id": "node-edit",
  "PATCH /api/map/nodes/:id": "map-edit",
  "PATCH /api/leaders/:id": "leader-edit",
  // 备忘与决定记录按 ?as= 定主人，guard 已把它锁成自己，不必再判。
  "PUT /api/memo": "self",
  "POST /api/decisions": "self",
  "POST /api/decisions/:id/supersede": "self",
  "POST /api/leaders/:id/escalate": "escalate",
  "POST /api/patrol/findings/:id/decide": "patrol-decide"
};
function leaderRule(method, route) {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "read";
  return RULES[`${verb} ${route}`] ?? "deny";
}
var ESCALATE_HINT = "atrium leader escalate --kind beyond \u8BF4\u660E";
var denied = (leader, what) => `${leader} \u65E0\u6743${what}\uFF1B\u9700\u8981\u7684\u8BDD\u4E0A\u4EA4\u79D8\u4E66\uFF1A${ESCALATE_HINT}`;
function denyReason(leader, method, route) {
  const key = `${method.toUpperCase()} ${route}`;
  if (key === "PUT /api/org/nodes/:id/docs/:doc" || route.endsWith("/revert"))
    return denied(
      leader,
      "\u6539\u7AE0\u7A0B\u3001\u8FB9\u754C\u4E0E\u9884\u7B97\uFF08\u6539\u9636\u6BB5\u7528 atrium org stages \u8282\u70B9 --file \u6587\u4EF6\uFF09"
    );
  if (key === "POST /api/reviews/:id/decide")
    return denied(leader, "\u62CD\u677F\u4E0A\u4EA4\u7684\u4F1A\u5BA1\uFF08\u90A3\u662F\u7528\u6237\u7684\u51B3\u5B9A\uFF09");
  if (key === "POST /api/org/nodes" || key === "POST /api/map/nodes")
    return denied(leader, "\u65B0\u5EFA\u7EC4\u7EC7\u8282\u70B9");
  if (route.startsWith("/api/quota")) return denied(leader, "\u6539\u989D\u5EA6\u6807\u8BB0");
  if (route.startsWith("/api/skill")) return denied(leader, "\u6539\u7EC4\u7EC7\u6280\u80FD");
  if (route.startsWith("/api/workers/profiles"))
    return denied(leader, "\u6539\u6267\u884C\u8005\u6863\u6848");
  if (key === "POST /api/leaders") return denied(leader, "\u767B\u8BB0\u65B0\u7684 leader");
  return denied(leader, `\u8C03\u7528 ${key}`);
}
function asVerdict(leader, as) {
  if (as === void 0 || as === "" || as === leader) return null;
  return denied(leader, `\u4EE5 ${as} \u7684\u540D\u4E49\u64CD\u4F5C\uFF0C\u53EA\u80FD\u7528\u81EA\u5DF1\uFF08${leader}\uFF09`);
}
function scopeOf2(list4, leader) {
  const led = new Set(
    list4.filter((n) => n.leader === leader && n.archived_at === null).map((n) => n.id)
  );
  const scope = /* @__PURE__ */ new Set();
  const visit = (id3) => {
    if (scope.has(id3)) return;
    scope.add(id3);
    for (const child of list4) if (child.parent_id === id3) visit(child.id);
  };
  for (const id3 of led) visit(id3);
  return { led, scope };
}
function scopeVerdict(leader, scope, checks) {
  for (const check2 of checks)
    if (check2.node === null || !scope.has(check2.node))
      return denied(leader, `\u52A8${check2.what}\uFF1A\u4E0D\u5728\u4F60\u8D1F\u8D23\u7684\u90E8\u5206\u91CC`);
  return null;
}
function remarkVerdict(leader, scope, check2, involved) {
  if (involved.some((id3) => scope.has(id3))) return null;
  return scopeVerdict(leader, scope, [check2]);
}
function ownerVerdict(leader, owner) {
  if (owner === void 0 || owner === null || owner === "" || owner === leader)
    return null;
  return denied(leader, `\u628A\u4EFB\u52A1\u8D1F\u8D23\u4EBA\u8BBE\u4E3A ${String(owner)}`);
}
function nodeEditVerdict(input) {
  const extra = input.keys.filter((k) => k !== "leader" && k !== "reason");
  if (extra.length || !input.keys.includes("leader"))
    return denied(
      input.leader,
      `\u6539\u8282\u70B9\u7684${extra.length ? ` ${extra.join("\u3001")} ` : "\u5176\u4ED6\u5B57\u6BB5"}\uFF08\u53EA\u80FD\u7ED9\u5B50\u8282\u70B9\u6307\u6D3E leader\uFF09`
    );
  if (input.led.has(input.node))
    return denied(input.leader, "\u6539\u81EA\u5DF1\u8D1F\u8D23\u7684\u8282\u70B9\u7684 leader");
  if (!input.scope.has(input.node))
    return denied(input.leader, "\u7ED9\u4E0D\u5728\u4F60\u8D1F\u8D23\u90E8\u5206\u91CC\u7684\u8282\u70B9\u6307\u6D3E leader");
  return null;
}
function mapEditVerdict(leader, keys) {
  if (keys.includes("detail") || keys.includes("rev"))
    return denied(leader, "\u6539\u7AE0\u7A0B\u6B63\u6587\uFF08--detail\uFF09");
  return null;
}
function leaderEditVerdict(leader, target, keys) {
  if (target !== leader) return denied(leader, `\u6539 ${target} \u7684\u767B\u8BB0`);
  const extra = keys.filter((k) => k !== "memo");
  if (extra.length)
    return denied(leader, `\u6539\u81EA\u5DF1\u7684 ${extra.join("\u3001")}\uFF08\u53EA\u80FD\u6539\u5907\u5FD8\uFF09`);
  return null;
}
function escalateVerdict(leader, target) {
  return target === leader ? null : denied(leader, `\u66FF ${target} \u4E0A\u4EA4`);
}
function ackVerdict(leader, subscribers) {
  const others = subscribers.filter((s) => s !== null && s !== leader);
  return others.length ? denied(leader, `\u786E\u8BA4\u6295\u7ED9 ${[...new Set(others)].join("\u3001")} \u7684\u4E8B\u4EF6`) : null;
}

// server/leaders/guard.ts
var leaders = /* @__PURE__ */ new WeakMap();
var leaderOf = (request2) => leaders.get(request2);
var forbid = (message4) => new Problem(403, message4, "leader_scope", void 0, ESCALATE_HINT);
var bodyOf = (request2) => request2.body && typeof request2.body === "object" && !Array.isArray(request2.body) ? request2.body : {};
var idParam = (request2) => String(request2.params?.id ?? "");
var given = (value) => value !== void 0 && value !== null && value !== "";
var changed = (body3) => Object.entries(body3).filter(
  ([key, value]) => value !== void 0 && !(key === "archive" && value === false)
).map(([key]) => key);
function taskCheck(db, reference, what = "\u4EFB\u52A1") {
  const task = getTask(db, reference);
  return {
    what: `${what} ${task.ref}`,
    node: taskPartId(db, task)
  };
}
function nodeCheck(db, address, what) {
  const node = nodeByAddress(db, address);
  return { what: `${what} ${ref(node.id)}`, node: node.id };
}
function bodyChecks(db, body3, roleKey) {
  const checks = [];
  if (given(body3.part)) {
    const id3 = partForTask(db, body3.part);
    checks.push({ what: `\u5F52\u5C5E\u90E8\u5206 ${ref(id3)}`, node: id3 });
  }
  if (given(body3.goal)) {
    const id3 = partForTask(db, body3.goal, "goal");
    checks.push({ what: `\u5F52\u5C5E\u90E8\u5206 ${ref(id3)}`, node: id3 });
  }
  if (given(body3.from))
    checks.push(nodeCheck(db, String(body3.from), "\u6295\u4EFB\u52A1\u7684\u8282\u70B9"));
  const role = body3[roleKey];
  if (typeof role === "string" && role.trim()) {
    const node = roleKey === "leader" ? nodeByAddress(db, role.trim()) : matchRole(
      db,
      role.trim(),
      typeof body3.repo === "string" ? body3.repo : null,
      true
    ).node;
    if (node) checks.push({ what: `\u8BB0\u8D26\u8282\u70B9 ${ref(node.id)}`, node: node.id });
  }
  if (given(body3.parent)) {
    const parent = parentOf(db, body3.parent);
    if (parent !== null) checks.push(taskCheck(db, parent, "\u7236\u4EFB\u52A1"));
  }
  return checks;
}
function registerLeaderGuard(app2, db, tokens, inbox) {
  app2.addHook("onRequest", async (request2) => {
    const header = request2.headers.authorization;
    if (!LeaderTokens.looksLike(header)) return;
    const leader = tokens.verify(header);
    if (!leader)
      throw new Problem(
        401,
        "leader \u4EE4\u724C\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF08\u672C\u6B21\u5524\u9192\u5DF2\u7ED3\u675F\uFF09\uFF1B\u8FD9\u6B21\u5524\u9192\u6CA1\u505A\u5B8C\u7684\u4E8B\u4F1A\u968F\u4E8B\u4EF6\u91CD\u6295\u518D\u5524\u9192\u4F60\uFF0C\u73B0\u5728\u76F4\u63A5\u9000\u51FA",
        "leader_scope"
      );
    const route = request2.routeOptions.url ?? "";
    if (!route.startsWith("/api/") || route.startsWith("/api/service"))
      throw forbid(denyReason(leader, request2.method, route || request2.url));
    const rule = leaderRule(request2.method, route);
    if (rule === "deny")
      throw forbid(denyReason(leader, request2.method, route));
    const query2 = request2.query ?? {};
    const as = asVerdict(leader, query2.as);
    if (as) throw forbid(as);
    query2.as = leader;
    leaders.set(request2, leader);
  });
  app2.addHook("preHandler", async (request2) => {
    const leader = leaders.get(request2);
    if (!leader) return;
    const rule = leaderRule(request2.method, request2.routeOptions.url ?? "");
    if (rule === "read" || rule === "deny" || rule === "self") return;
    const { led, scope } = scopeOf2(nodes(db), leader);
    const body3 = bodyOf(request2);
    let verdict2 = null;
    switch (rule) {
      case "task-create":
      case "review-create": {
        verdict2 = ownerVerdict(leader, body3.owner);
        if (verdict2) break;
        if (!given(body3.part) && !given(body3.goal)) {
          const home = [...led].sort((a, b) => a - b)[0];
          if (home === void 0) {
            verdict2 = denied(leader, "\u5EFA\u4EFB\u52A1\uFF1A\u4F60\u8FD8\u6CA1\u6709\u8D1F\u8D23\u7684\u8282\u70B9");
            break;
          }
          body3.part = ref(home);
        }
        verdict2 = scopeVerdict(
          leader,
          scope,
          bodyChecks(db, body3, rule === "task-create" ? "role" : "leader")
        );
        break;
      }
      case "task":
        verdict2 = scopeVerdict(leader, scope, [
          taskCheck(db, idParam(request2))
        ]);
        break;
      case "task-remark": {
        const task = getTask(db, idParam(request2));
        const { also, auto } = involvedOf(db, task);
        verdict2 = remarkVerdict(leader, scope, taskCheck(db, task.ref), [
          ...also,
          ...auto
        ]);
        break;
      }
      case "task-patch":
        verdict2 = ownerVerdict(leader, body3.owner) ?? scopeVerdict(leader, scope, [
          taskCheck(db, idParam(request2)),
          ...bodyChecks(db, body3, "role")
        ]);
        break;
      case "point":
        if (request2.method === "POST")
          verdict2 = scopeVerdict(leader, scope, [
            nodeCheck(db, idParam(request2), "\u8282\u70B9")
          ]);
        break;
      case "stages":
        verdict2 = scopeVerdict(leader, scope, [
          nodeCheck(db, idParam(request2), "\u8282\u70B9")
        ]);
        break;
      case "node-edit":
        verdict2 = nodeEditVerdict({
          leader,
          keys: changed(body3),
          node: nodeByAddress(db, idParam(request2)).id,
          led,
          scope
        });
        break;
      case "map-edit":
        verdict2 = mapEditVerdict(leader, changed(body3)) ?? scopeVerdict(leader, scope, [
          nodeCheck(db, idParam(request2), "\u8282\u70B9")
        ]);
        break;
      case "leader-edit":
        verdict2 = leaderEditVerdict(leader, idParam(request2), changed(body3));
        break;
      case "escalate":
        verdict2 = escalateVerdict(leader, idParam(request2)) ?? (given(body3.task) ? scopeVerdict(leader, scope, [taskCheck(db, body3.task)]) : null);
        break;
      case "events-ack": {
        const found = inbox().subscribersOf(ackIds(request2.body));
        verdict2 = ackVerdict(leader, [...found.values()]);
        break;
      }
      case "patrol-decide":
        verdict2 = scopeVerdict(leader, scope, [
          {
            what: `\u53D1\u73B0 ${idParam(request2)}`,
            node: findingNode(db, idParam(request2))
          },
          ...given(body3.task) ? [taskCheck(db, body3.task)] : []
        ]);
        break;
    }
    if (verdict2) throw forbid(verdict2);
  });
}

// server/tasks/workers-report.ts
function pendingSuggestions(db, records, stats) {
  return stats.flatMap((stat5) => {
    const advice = adviceFor(stat5);
    if (!advice) return [];
    const latest = records.find(
      (row3) => row3.worker === stat5.worker && row3.job_name === stat5.role
    );
    if (!latest) return [];
    const confirmations = db.prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='worker_advice_confirmed' ORDER BY id DESC LIMIT 20"
    ).all(latest.task_id);
    const confirmed = confirmations.some(({ detail: detail2 }) => {
      try {
        const data2 = JSON.parse(detail2);
        return data2.worker === stat5.worker && data2.role === latest.job_ref && data2.action === advice.action;
      } catch {
        return false;
      }
    });
    return confirmed ? [] : [{ stat: stat5, advice }];
  });
}
async function workersReport(db, role) {
  const job = role ? getJobRole(db, role) : void 0;
  const records = listDeliveries(db, { job: job?.id });
  const ids = [
    ...new Set(
      records.flatMap((r) => [
        r.worker,
        r.model ? `${r.tool}+${r.model}` : r.tool,
        r.tool
      ])
    )
  ];
  const trust = new Map(
    await Promise.all(
      ids.map(
        async (id3) => [
          id3,
          await resolveWorker(id3, db).then((x) => x.profile.rules.trust ?? "unknown").catch(() => "unknown")
        ]
      )
    )
  );
  const stats = summarizeDeliveries(records, trust);
  return {
    role: job ?? null,
    stats,
    suggestions: pendingSuggestions(db, records, stats)
  };
}
async function workerReport(db, worker) {
  parseWorker(worker);
  const resolved = await resolveWorker(worker, db);
  const records = listDeliveries(db, {
    worker: resolved.id
  }).filter((r) => r.worker === resolved.id);
  const stats = summarizeDeliveries(
    records,
    /* @__PURE__ */ new Map([[resolved.id, resolved.profile.rules.trust ?? "unknown"]])
  ).filter((s) => s.scope === "combination");
  return {
    worker: resolved.id,
    tool: resolved.tool,
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    profile: resolved.profile,
    stats,
    deliveries: records,
    suggestions: pendingSuggestions(db, records, stats)
  };
}
function publishWorkerAdvice(db, inbox, taskId) {
  const task = one(
    db,
    "SELECT job_id,worker FROM tasks WHERE id=?",
    taskId
  );
  if (!task?.job_id || !task.worker) return;
  const rows = listDeliveries(db, { job: task.job_id, worker: task.worker });
  const last = rows.find((r) => r.task_id === taskId);
  if (!last || !last.job_id) return;
  const stats = summarizeDeliveries(rows).filter(
    (s) => s.scope === "combination" && s.worker === last.worker && s.role === last.job_name
  );
  for (const stat5 of stats) {
    const advice = adviceFor(stat5);
    if (!advice) return;
    const event = db.prepare(
      "SELECT 1 FROM task_events WHERE task_id=? AND kind='worker_advice' AND detail LIKE ? LIMIT 1"
    ).get(taskId, `%${advice.action}%`);
    if (event) return;
    const data2 = {
      worker: stat5.worker,
      role: last.job_ref,
      action: advice.action,
      reason: advice.reason
    };
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)"
    ).run(taskId, Date.now(), "worker_advice", JSON.stringify(data2));
    inbox.publish({
      subscriber: "secretary",
      taskId,
      source: "workers",
      kind: "worker_advice",
      key: `t${taskId}:worker_advice`,
      detail: data2
    });
  }
}
async function confirmWorkerAdvice(db, body3) {
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw new Problem(400, "\u8BF7\u6C42\u4F53\u5E94\u4E3A JSON \u5BF9\u8C61", "usage");
  const b = body3;
  if (typeof b.worker !== "string" || typeof b.role !== "string" || typeof b.action !== "string")
    throw new Problem(400, "worker\u3001role\u3001action \u5FC5\u586B", "usage");
  const role = getJobRole(db, b.role);
  const spec = parseWorker(b.worker);
  if (!spec.model) throw new Problem(400, "worker \u987B\u5305\u542B\u6A21\u578B", "usage");
  const report = await workersReport(db, role.ref);
  const suggestion = report.suggestions.find(
    (x) => x.stat.worker === b.worker && x.stat.role === role.name && x.advice?.action === b.action
  );
  if (!suggestion)
    throw new Problem(
      409,
      "\u5F53\u524D\u7EDF\u8BA1\u6CA1\u6709\u8FD9\u6761\u5EFA\u8BAE\uFF0C\u8BF7\u91CD\u65B0\u8FD0\u884C atrium workers \u67E5\u770B",
      "conflict"
    );
  const profile = await resolveWorker(b.worker, db);
  const name2 = `${spec.tool}+${modelKey(spec.model)}`;
  const file = `combos/${name2}`;
  const source2 = readProfile(db, "combos", name2)?.source ?? "";
  if (parseFrontmatter(source2).warnings.length)
    throw new Problem(
      409,
      `\u6863\u6848 ${file} \u6709\u65E0\u6CD5\u89E3\u6790\u7684 frontmatter\uFF0C\u5148\u7528 atrium workers edit ${file} --file \u4FEE\u6B63\u540E\u786E\u8BA4`,
      "conflict"
    );
  let key, value;
  if (b.action === "avoid_role") {
    key = "avoid_jobs";
    const old = profile.profile.rules.avoid_jobs;
    const items = Array.isArray(old) ? old.filter((x) => typeof x === "string") : [];
    value = JSON.stringify([.../* @__PURE__ */ new Set([...items, role.ref])]);
  } else {
    key = "trust";
    const actual = profile.profile.rules.trust ?? "unknown";
    const index2 = TRUSTS.indexOf(actual);
    const next = b.action === "relax" ? Math.min(TRUSTS.length - 1, index2 + 1) : Math.max(0, index2 - 1);
    value = TRUSTS[next];
    if (b.action === "relax" && profile.profile.layers.some(
      (layer) => layer.layer !== "combos" && layer.rules.trust !== void 0 && TRUSTS.indexOf(layer.rules.trust) < next
    ))
      throw new Problem(
        409,
        "\u4E0A\u5C42\u6863\u6848\u7684 trust \u66F4\u4E25\uFF0C\u7EC4\u5408\u6863\u6848\u65E0\u6CD5\u653E\u5BBD\uFF1B\u8BF7\u5148\u5BA1\u67E5\u4E0A\u5C42\u6863\u6848",
        "conflict"
      );
  }
  atomically(db, () => {
    writeProfile(db, {
      layer: "combos",
      name: name2,
      source: patchFront(source2, key, value),
      author: "secretary",
      reason: `\u786E\u8BA4\u4EA4\u4ED8\u8BB0\u5F55\u5EFA\u8BAE\uFF1A${role.ref} ${b.action}`
    });
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)"
    ).run(
      suggestion.stat.deliveries ? listDeliveries(db, {
        worker: String(b.worker),
        job: role.id,
        limit: 1
      })[0].task_id : 0,
      Date.now(),
      "worker_advice_confirmed",
      JSON.stringify({
        worker: b.worker,
        role: role.ref,
        action: b.action,
        file
      })
    );
  });
  return {
    worker: b.worker,
    role: role.ref,
    action: b.action,
    file,
    [key]: value
  };
}

// server/tasks/runner.ts
import { join as join21 } from "node:path";

// server/text-width.ts
var wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
var width = (text6) => [...text6].reduce((total, char) => total + (wide.test(char) ? 2 : 1), 0);
function clip3(text6, max) {
  const line = text6.replace(/\s+/g, " ").trim();
  if (width(line) <= max) return line;
  let out = "";
  for (const char of line) {
    if (width(out + char) > max - 1) break;
    out += char;
  }
  return `${out}\u2026`;
}

// server/tasks/command-gist.ts
function segmentsOf(command) {
  const segments = [];
  let words = [];
  let word = "";
  let quoted = false;
  let heredoc = false;
  let piped = false;
  let pending;
  const endWord = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const endSegment = (nextPiped) => {
    endWord();
    if (words.length) segments.push({ words, heredoc, piped });
    words = [];
    heredoc = false;
    piped = nextPiped;
  };
  const text6 = command;
  let i = 0;
  while (i < text6.length) {
    const char = text6[i];
    if (char === "'" || char === '"') {
      const close = text6.indexOf(char, i + 1);
      const end = close < 0 ? text6.length : close;
      word += text6.slice(i + 1, end);
      quoted = true;
      i = end + 1;
      continue;
    }
    if (char === "\\" && text6[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (char === "<" && text6[i + 1] === "<" && text6[i + 2] !== "<") {
      endWord();
      const match = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(text6.slice(i));
      if (match) {
        pending = match[2];
        heredoc = true;
        i += match[0].length;
        continue;
      }
    }
    if (char === "\n") {
      endSegment(false);
      i++;
      if (pending) {
        const lines2 = text6.slice(i).split("\n");
        let skipped2 = 0;
        for (const line of lines2) {
          skipped2 += line.length + 1;
          if (line.trim() === pending) break;
        }
        i += skipped2;
        pending = void 0;
      }
      continue;
    }
    if (char === ";" || char === "&" || char === "|") {
      const pair = text6[i + 1] === char;
      const pipe = char === "|" && !pair;
      if (char === "&" && (text6[i - 1] === ">" || text6[i + 1] === ">")) {
        word += char;
        i++;
        continue;
      }
      endSegment(pipe);
      i += pair ? 2 : 1;
      continue;
    }
    if (char === " " || char === "	") {
      endWord();
      i++;
      continue;
    }
    word += char;
    i++;
  }
  endSegment(false);
  return segments;
}
var LEADING = /* @__PURE__ */ new Set([
  "do",
  "then",
  "else",
  "if",
  "while",
  "until",
  "!",
  "{",
  "(",
  "time",
  "sudo",
  "exec",
  "command",
  "env"
]);
var NOISE = /* @__PURE__ */ new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "export",
  "set",
  "unset",
  "true",
  "false",
  ":",
  "for",
  "done",
  "fi",
  "esac",
  "}",
  ")",
  "sleep",
  "wait",
  "source",
  ".",
  "local",
  "read"
]);
function commandWords(words) {
  let rest = words;
  for (; ; ) {
    const head2 = rest[0];
    if (head2 === void 0) return rest;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head2) || LEADING.has(head2)) {
      rest = rest.slice(1);
      continue;
    }
    if (head2 === "timeout" || head2 === "nice") {
      rest = rest.slice(1).filter((word, index2) => index2 > 0 || !/^-?\d/.test(word));
      continue;
    }
    return rest;
  }
}
var base = (path) => path.replace(/\/+$/, "").split("/").pop() || path;
var name = (word) => base(word);
var fileArg = (args2) => args2.find(
  (arg) => !arg.startsWith("-") && /[\w.]/.test(arg) && !/^\d+(,\d+)?p$/.test(arg) && !arg.includes("*")
);
var SCRIPT_TOOLS = /* @__PURE__ */ new Set([
  "python",
  "python3",
  "node",
  "bash",
  "sh",
  "zsh",
  "ruby",
  "perl",
  "deno",
  "bun",
  "tsx"
]);
var NPM_SCRIPTS = {
  check: "\u8DD1\u5B8C\u6574\u68C0\u67E5",
  test: "\u8DD1\u6D4B\u8BD5",
  "format:check": "\u67E5\u683C\u5F0F",
  format: "\u6392\u7248",
  build: "\u6784\u5EFA",
  lint: "\u8DD1\u9759\u6001\u68C0\u67E5",
  typecheck: "\u7C7B\u578B\u68C0\u67E5"
};
var GIT = {
  push: "\u63A8\u9001",
  commit: "\u63D0\u4EA4",
  add: "\u6682\u5B58\u6539\u52A8",
  status: "\u770B\u6539\u52A8",
  diff: "\u770B\u6539\u52A8",
  log: "\u770B\u63D0\u4EA4\u8BB0\u5F55",
  show: "\u770B\u63D0\u4EA4",
  rebase: "\u53D8\u57FA",
  fetch: "\u62C9\u53D6\u8FDC\u7AEF",
  pull: "\u62C9\u53D6\u6700\u65B0\u4EE3\u7801",
  checkout: "\u5207\u5206\u652F",
  switch: "\u5207\u5206\u652F",
  branch: "\u770B\u5206\u652F",
  merge: "\u5408\u5E76\u5206\u652F",
  worktree: "\u7BA1\u7406 worktree",
  reset: "\u56DE\u9000\u6539\u52A8",
  restore: "\u64A4\u9500\u6539\u52A8",
  "rev-parse": "\u67E5\u7248\u672C\u53F7",
  "ls-files": "\u5217\u6587\u4EF6",
  blame: "\u67E5\u6539\u52A8\u6765\u6E90",
  grep: "\u641C\u4EE3\u7801",
  clone: "\u514B\u9686\u4ED3\u5E93",
  tag: "\u6253\u6807\u7B7E",
  config: "\u770B git \u914D\u7F6E"
};
var GH_PR = {
  create: "\u5F00 PR",
  checks: "\u770B CI",
  view: "\u770B PR",
  diff: "\u770B PR \u6539\u52A8",
  comment: "\u8BC4\u8BBA PR",
  edit: "\u6539 PR",
  list: "\u5217 PR",
  merge: "\u5408\u5165 PR",
  review: "\u5BA1 PR",
  ready: "PR \u8F6C\u4E3A\u5F85\u5BA1",
  status: "\u770B PR \u72B6\u6001"
};
var GH_ISSUE = {
  view: "\u770B issue",
  create: "\u5F00 issue",
  comment: "\u8BC4\u8BBA issue",
  list: "\u5217 issue",
  edit: "\u6539 issue",
  close: "\u5173 issue"
};
var WEAK = /* @__PURE__ */ new Set(["\u5EFA\u76EE\u5F55", "\u5EFA\u6587\u4EF6", "\u5217\u6587\u4EF6", "\u590D\u5236\u6587\u4EF6"]);
function gistOf(segment) {
  const words = commandWords(segment.words);
  const head2 = words[0];
  if (!head2) return void 0;
  const cmd = name(head2);
  const args2 = words.slice(1);
  const sub = args2.find((arg) => !arg.startsWith("-"));
  switch (cmd) {
    case "npm":
    case "pnpm":
    case "yarn": {
      const script = sub === "run" || sub === "run-script" ? args2[args2.indexOf(sub) + 1] : sub;
      if (sub === "test" || sub === "t") return "\u8DD1\u6D4B\u8BD5";
      if (sub === "install" || sub === "i" || sub === "ci" || sub === "add")
        return "\u88C5\u4F9D\u8D56";
      if (script && NPM_SCRIPTS[script]) return NPM_SCRIPTS[script];
      return script ? `\u8DD1 ${cmd} ${script}` : `\u8DD1 ${cmd}`;
    }
    case "npx":
      if (sub === "tsc") return "\u7C7B\u578B\u68C0\u67E5";
      if (sub === "prettier")
        return args2.includes("--check") ? "\u67E5\u683C\u5F0F" : "\u6392\u7248";
      return sub ? `\u8DD1 ${name(sub)}` : "\u8DD1 npx";
    case "tsc":
      return "\u7C7B\u578B\u68C0\u67E5";
    case "prettier":
      return args2.includes("--check") ? "\u67E5\u683C\u5F0F" : "\u6392\u7248";
    case "git": {
      const rest = args2[0] === "-C" ? args2.slice(2) : args2;
      const verb = rest.find((arg) => !arg.startsWith("-"));
      return (verb && GIT[verb]) ?? "\u8DD1 git";
    }
    case "gh": {
      const rest = args2.filter(
        (arg, index2) => !arg.startsWith("-") && !(index2 > 0 && ["-R", "--repo"].includes(args2[index2 - 1]))
      );
      const [group, verb] = rest;
      if (group === "pr") return (verb && GH_PR[verb]) ?? "\u770B PR";
      if (group === "issue") return (verb && GH_ISSUE[verb]) ?? "\u770B issue";
      if (group === "run") return "\u770B CI";
      if (group === "api") return "\u67E5 GitHub";
      if (group === "repo") return "\u770B\u4ED3\u5E93";
      return "\u8DD1 gh";
    }
    case "atrium": {
      const verb = args2.find((arg) => !arg.startsWith("-"));
      return verb ? `\u8DD1 atrium ${verb}` : "\u8DD1 atrium";
    }
    case "rg":
    case "grep":
    case "ag":
      return "\u641C\u4EE3\u7801";
    case "ls":
    case "find":
    case "tree":
    case "fd":
      return "\u5217\u6587\u4EF6";
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "nl":
    case "wc":
    case "sed":
    case "awk":
    case "jq": {
      const redirect = words.findIndex((word) => word === ">" || word === ">>");
      const glued = words.find((word) => /^>>?[^>&]/.test(word));
      const target = redirect >= 0 ? words[redirect + 1] : glued?.replace(/^>+/, "");
      if (target) return segment.heredoc ? `\u5199 ${base(target)}` : "\u590D\u5236\u6587\u4EF6";
      if (cmd === "sed" && args2.includes("-i") || cmd === "awk" || cmd === "jq") {
        const file2 = fileArg(args2.slice(1));
        return cmd === "sed" && args2.includes("-i") ? `\u6539 ${file2 ? base(file2) : "\u6587\u4EF6"}` : `\u8DD1 ${cmd}`;
      }
      const file = fileArg(
        cmd === "sed" ? args2.filter((arg) => arg !== "-n").slice(1) : args2
      );
      return file ? `\u8BFB ${base(file)}` : `\u8BFB\u6587\u4EF6`;
    }
    case "mkdir":
      return "\u5EFA\u76EE\u5F55";
    case "rm":
      return "\u5220\u6587\u4EF6";
    case "mv":
    case "cp":
      return "\u632A\u6587\u4EF6";
    case "touch":
      return "\u5EFA\u6587\u4EF6";
    case "curl":
    case "wget":
      return "\u8BF7\u6C42\u63A5\u53E3";
    case "kill":
    case "pkill":
      return "\u505C\u8FDB\u7A0B";
    case "ps":
    case "lsof":
    case "pgrep":
      return "\u770B\u8FDB\u7A0B";
    case "open":
      return "\u6253\u5F00\u9875\u9762";
  }
  if (SCRIPT_TOOLS.has(cmd)) {
    if (sub === "--test" || args2.includes("--test")) return "\u8DD1\u6D4B\u8BD5";
    const script = args2.find((arg) => !arg.startsWith("-"));
    if (script && /atrium\.mjs$/.test(script)) {
      const verb = args2.slice(args2.indexOf(script) + 1).find((arg) => !arg.startsWith("-"));
      return verb ? `\u8DD1 atrium ${verb}` : "\u8DD1 atrium";
    }
    if (segment.heredoc || args2.some((arg) => ["-", "-c", "-e", "--eval", "-p"].includes(arg)) || !script)
      return `\u8DD1 ${cmd} \u811A\u672C`;
    return `\u8DD1 ${base(script)}`;
  }
  return void 0;
}
function commandGist(command) {
  const segments = segmentsOf(command).filter((segment) => !segment.piped);
  const real2 = segments.filter((segment) => {
    const head3 = commandWords(segment.words)[0];
    return head3 !== void 0 && !NOISE.has(head3);
  });
  const gists = real2.map(gistOf);
  const gist = gists.find((text6) => text6 && !WEAK.has(text6)) ?? gists.find(Boolean);
  if (gist) return gist;
  const head2 = real2[0] && commandWords(real2[0].words)[0];
  if (head2) return `\u8DD1 ${name(head2)}`;
  const any = segments[0] && commandWords(segments[0].words)[0];
  if (any === "sleep") return "\u7B49\u5F85";
  return any ? `\u8DD1 ${name(any)}` : "\u8DD1\u547D\u4EE4";
}

// server/tasks/action.ts
var ACTION_WIDTH = 80;
var cap = (text6) => clip3(text6, ACTION_WIDTH);
var SENTENCE_END = /[。！？；!?;]|\.(?=\s|$)/;
function firstSentence(text6) {
  let fenced = false;
  for (const raw of text6.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^>\s*/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();
    if (!plain || /^[-=*_|:\s]+$/.test(plain)) continue;
    const end = SENTENCE_END.exec(plain);
    const sentence = (end ? plain.slice(0, end.index) : plain).replace(/[，,：:、\s]+$/, "").trim();
    if (sentence) return sentence;
  }
  return void 0;
}
var step = (text6) => {
  const sentence = firstSentence(text6);
  return sentence ? { kind: "step", text: cap(sentence) } : void 0;
};
var fileName = (path) => path.replace(/\/+$/, "").split("/").pop() || path;
var PATH_KEYS = ["filePath", "file_path", "path", "notebook_path"];
var FILE_VERBS = {
  read: "\u8BFB",
  view: "\u8BFB",
  write: "\u5199",
  create: "\u5199",
  edit: "\u6539",
  patch: "\u6539",
  multiedit: "\u6539",
  notebookedit: "\u6539",
  apply_patch: "\u6539"
};
var FIXED = {
  grep: "\u641C\u4EE3\u7801",
  glob: "\u5217\u6587\u4EF6",
  list: "\u5217\u76EE\u5F55",
  ls: "\u5217\u76EE\u5F55",
  webfetch: "\u53D6\u7F51\u9875",
  fetch: "\u53D6\u7F51\u9875",
  websearch: "\u641C\u7F51\u9875",
  todowrite: "\u5217\u5F85\u529E",
  todoread: "\u770B\u5F85\u529E",
  bashoutput: "\u770B\u540E\u53F0\u8F93\u51FA",
  killshell: "\u505C\u540E\u53F0\u547D\u4EE4",
  toolsearch: "\u627E\u5DE5\u5177"
};
var object2 = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
function textIn(input, key) {
  const value = input?.[key];
  const text6 = Array.isArray(value) ? value.join(" ") : value;
  return typeof text6 === "string" && text6.trim() ? text6.trim() : void 0;
}
function describe(name2, input) {
  const key = name2.toLowerCase();
  const tool = (text6) => ({ kind: "tool", text: cap(text6) });
  if (key === "bash" || key === "shell") {
    const command = textIn(input, "command");
    return tool(command ? commandGist(command) : "\u8DD1\u547D\u4EE4");
  }
  const verb = FILE_VERBS[key];
  if (verb) {
    const path = PATH_KEYS.map((k) => textIn(input, k)).find(Boolean);
    return tool(path ? `${verb} ${fileName(path)}` : `${verb}\u6587\u4EF6`);
  }
  if (FIXED[key]) return tool(FIXED[key]);
  if (key === "task" || key === "agent") {
    const what = textIn(input, "description");
    return tool(what ? `\u6D3E\u5B50\u4EFB\u52A1\uFF1A${what}` : "\u6D3E\u5B50\u4EFB\u52A1");
  }
  if (key === "skill") {
    const skill = textIn(input, "skill") ?? textIn(input, "name");
    return tool(skill ? `\u7528\u6280\u80FD ${skill}` : "\u7528\u6280\u80FD");
  }
  return tool(name2 || "\u8C03\u7528\u5DE5\u5177");
}
function structuredAction(tail) {
  const events2 = parseEvents(tail);
  let lastTool;
  for (let i = events2.length - 1; i >= 0; i--) {
    const event = events2[i];
    if (event.type === "tool_use") {
      const part = object2(event.part);
      if (part)
        lastTool ??= describe(
          String(part.tool ?? ""),
          object2(object2(part.state)?.input)
        );
      continue;
    }
    if (event.type === "assistant") {
      const content = object2(event.message)?.content;
      if (Array.isArray(content))
        for (let j = content.length - 1; j >= 0; j--) {
          const item = object2(content[j]);
          if (item?.type === "tool_use")
            lastTool ??= describe(String(item.name ?? ""), object2(item.input));
          if (item?.type === "text" && typeof item.text === "string") {
            const said2 = step(item.text);
            if (said2) return said2;
          }
        }
      continue;
    }
    const text6 = textOf(event);
    const said = text6 === void 0 ? void 0 : step(text6);
    if (said) return said;
  }
  return lastTool;
}
var CODEX_HEADS = /* @__PURE__ */ new Set([
  "user",
  "codex",
  "exec",
  "apply patch",
  "tokens used"
]);
function unwrapShell(text6) {
  const match = /^([\s\S]*) in \/\S+$/.exec(text6);
  const command = match ? match[1] : text6;
  const shell = /^\S+\s+-l?c\s+"([\s\S]*)"$/.exec(command) ?? /^\S+\s+-l?c\s+'([\s\S]*)'$/.exec(command);
  return shell ? shell[1].replace(/\\(["\\$`])/g, "$1") : command;
}
function execCommand(lines2) {
  const taken = [];
  for (const line of lines2.slice(0, 400)) {
    taken.push(line);
    if (/ in \/\S+$/.test(line)) return unwrapShell(taken.join("\n"));
  }
  return lines2[0] === void 0 ? void 0 : unwrapShell(lines2[0]);
}
function patchTarget(body3) {
  const path = body3.find((line) => line.startsWith("/"));
  if (path) return fileName(path);
  const diff = /^\+\+\+ b\/(.+)$/m.exec(body3.join("\n"));
  return diff ? fileName(diff[1]) : "\u6587\u4EF6";
}
function codexAction(tail) {
  const lines2 = tail.split("\n");
  let lastTool;
  for (let i = lines2.length - 1; i >= 0; i--) {
    const head2 = lines2[i].trim();
    if (!head2 || !CODEX_HEADS.has(head2)) continue;
    if (head2 === "tokens used" || head2 === "user") continue;
    if (head2 === "exec") {
      const command = execCommand(lines2.slice(i + 1));
      lastTool ??= {
        kind: "tool",
        text: cap(command ? commandGist(command) : "\u8DD1\u547D\u4EE4")
      };
      continue;
    }
    if (head2 === "apply patch") {
      const body4 = lines2.slice(i + 1, i + 40).map((line) => line.trim()).filter(Boolean);
      lastTool ??= { kind: "tool", text: cap(`\u6539 ${patchTarget(body4)}`) };
      continue;
    }
    const body3 = [];
    for (const line of lines2.slice(i + 1)) {
      if (CODEX_HEADS.has(line.trim())) break;
      body3.push(line);
    }
    const said = step(body3.join("\n"));
    if (said) return said;
  }
  return lastTool;
}
function recentAction(input) {
  if (!input.tool) return void 0;
  return ADAPTERS[input.tool].progressSignals.includes("json_events") ? structuredAction(input.tail) : input.tool === "codex" ? codexAction(input.tail) : void 0;
}

// server/tasks/screenshot-facts.ts
function screenshotUrls(body3) {
  const urls = [];
  const markdown = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|(https:\/\/[^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gi;
  for (const match of body3.matchAll(markdown)) urls.push(match[1] ?? match[2]);
  const attachments = /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/gi;
  for (const match of body3.matchAll(attachments)) urls.push(match[0]);
  return [...new Set(urls)];
}
function publicUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":"))
      return null;
    return url;
  } catch {
    return null;
  }
}
async function checkScreenshot(value, head2 = fetch) {
  let url = publicUrl(value);
  if (!url) return { url: value, error: "\u4E0D\u662F\u53EF\u68C0\u67E5\u7684\u516C\u7F51 HTTPS \u94FE\u63A5" };
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await head2(url.href, {
        method: "HEAD",
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(1e4)
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        url = location ? publicUrl(new URL(location, url).href) : null;
        if (!url)
          return { url: value, error: "\u91CD\u5B9A\u5411\u7F3A\u5931\u6216\u6307\u5411\u975E\u516C\u7F51 HTTPS \u94FE\u63A5" };
        continue;
      }
      return { url: value, status: response.status };
    }
    return { url: value, error: "\u91CD\u5B9A\u5411\u8D85\u8FC7 5 \u6B21" };
  } catch (error) {
    return {
      url: value,
      error: error instanceof Error && error.name === "TimeoutError" ? "HEAD \u8BF7\u6C42\u8D85\u65F6" : "HEAD \u8BF7\u6C42\u5931\u8D25"
    };
  }
}
async function readScreenshots(body3, head2 = fetch) {
  return Promise.all(
    screenshotUrls(body3).map((url) => checkScreenshot(url, head2))
  );
}

// server/tasks/facts.ts
async function findPr(target, branch, run3 = exec) {
  const listed = await run3(
    "gh",
    [
      "pr",
      "list",
      "-R",
      repoFlag(target),
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,state,body",
      "--limit",
      "1"
    ],
    { timeoutMs: 3e4 }
  );
  if (!listed.ok) return { pr: null, error: firstLine(listed.stderr) };
  try {
    const [pr] = JSON.parse(listed.stdout);
    return { pr: pr ?? null };
  } catch {
    return { pr: null, error: "gh \u8F93\u51FA\u4E0D\u662F JSON" };
  }
}
async function readCi(prUrl, run3 = exec) {
  const target = parsePrUrl(prUrl);
  if (!target)
    return { ci: null, detail: `PR \u94FE\u63A5 ${prUrl} \u89E3\u6790\u4E0D\u51FA owner/repo` };
  const checks = await run3("gh", [
    "pr",
    "checks",
    prUrl,
    "-R",
    repoFlag(target),
    "--json",
    "name,bucket,link"
  ]);
  let list4;
  try {
    const parsed = JSON.parse(checks.stdout);
    if (Array.isArray(parsed)) list4 = parsed;
  } catch {
    list4 = void 0;
  }
  if (!list4)
    return { ci: null, detail: firstLine(checks.stderr) || "\u67E5\u4E0D\u5230\u68C0\u67E5" };
  const failing = list4.filter(
    (check2) => check2.bucket === "fail" || check2.bucket === "cancel"
  );
  const jobs = /* @__PURE__ */ new Map();
  const observations = [];
  for (const check2 of failing) {
    const action = actionJob(check2.link);
    if (!action) continue;
    const runKey = `${action.repo}/${action.run}`;
    const actions = {
      ...target,
      owner: action.repo.split("/")[0],
      name: action.repo.split("/")[1]
    };
    if (!jobs.has(runKey)) {
      const response = await run3(
        "gh",
        apiArgs(actions, `actions/runs/${action.run}/jobs?per_page=100`)
      );
      let listed = [];
      if (response.ok) {
        try {
          const parsed = JSON.parse(response.stdout);
          if (parsed && typeof parsed === "object" && "jobs" in parsed && Array.isArray(parsed.jobs))
            listed = parsed.jobs;
        } catch {
        }
      }
      jobs.set(runKey, listed);
    }
    const job = jobs.get(runKey)?.find((entry) => entry.id === action.job);
    const annotations = await run3(
      "gh",
      apiArgs(actions, `check-runs/${action.job}/annotations?per_page=100`)
    );
    let parsedAnnotations = [];
    if (annotations.ok) {
      try {
        const parsed = JSON.parse(annotations.stdout);
        if (Array.isArray(parsed)) parsedAnnotations = parsed;
      } catch {
      }
    }
    observations.push({ check: check2, job, annotations: parsedAnnotations });
  }
  return classifyCi(list4, observations);
}
async function verifyClaims(target, worktree, summary2, run3) {
  const checked = [];
  for (const claim of extractClaims(summary2)) {
    if (claim.kind === "pr") {
      if ("error" in target) {
        checked.push({ ...claim, ok: false, detail: target.error });
        continue;
      }
      const view7 = await run3(
        "gh",
        ["pr", "view", claim.value, "-R", repoFlag(target), "--json", "number"],
        { timeoutMs: 3e4 }
      );
      checked.push({
        ...claim,
        ok: view7.ok,
        detail: view7.ok ? void 0 : firstLine(view7.stderr)
      });
    } else {
      const found = await run3(
        "git",
        ["-C", worktree, "cat-file", "-e", `${claim.value}^{commit}`],
        { timeoutMs: 1e4 }
      );
      checked.push({
        ...claim,
        ok: found.ok,
        detail: found.ok ? void 0 : "\u4ED3\u5E93\u91CC\u6CA1\u6709\u8FD9\u4E2A\u63D0\u4EA4"
      });
    }
  }
  return checked;
}
async function collectFacts(input, run3 = exec, includeCi = true, includeScreenshots = false) {
  const empty3 = {
    repo: false,
    pr: null,
    ci: null,
    numstat: [],
    functions: [],
    dirty: [],
    ahead: 0,
    pushed: null,
    claims: []
  };
  const { repo, worktree, branch, base: base2 } = input;
  if (!repo || !worktree || !branch || !base2) return empty3;
  const git = (...args2) => run3("git", ["--no-optional-locks", "-C", worktree, ...args2], {
    timeoutMs: 3e4
  });
  const range = `origin/${base2}...${branch}`;
  const origin = await originRepo(repo, run3);
  const target = "error" in origin ? origin : origin.repo;
  const [numstat, diff, status, ahead, head2, remote, found] = await Promise.all(
    [
      git("diff", "--numstat", range),
      git("diff", "-U0", "--no-color", range),
      git("status", "--porcelain"),
      git("rev-list", "--count", `origin/${base2}..${branch}`),
      git("rev-parse", branch),
      git("ls-remote", "origin", `refs/heads/${branch}`),
      "error" in target ? Promise.resolve({ pr: null, error: target.error }) : findPr(target, branch, run3)
    ]
  );
  const facts = {
    ...empty3,
    repo: true,
    branch,
    base: base2,
    ghRepo: "error" in target ? void 0 : repoFlag(target),
    pr: found.pr,
    prError: found.error,
    numstat: numstat.ok ? parseNumstat(numstat.stdout) : [],
    functions: diff.ok ? addedFunctions(diff.stdout) : [],
    dirty: status.ok ? status.stdout.split("\n").filter((line) => line.trim()).map((line) => line.slice(3)) : [],
    ahead: ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0
  };
  if (!remote.ok) {
    facts.pushed = null;
    facts.pushDetail = firstLine(remote.stderr);
  } else {
    const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
    facts.pushed = !!remoteSha && remoteSha === head2.stdout.trim();
    if (!remoteSha) facts.pushDetail = `origin \u4E0A\u6CA1\u6709\u5206\u652F ${branch}`;
    else if (!facts.pushed) facts.pushDetail = "origin \u4E0A\u7684\u5206\u652F\u843D\u540E\u4E8E\u672C\u5730";
  }
  if (facts.pr && includeCi) {
    const ci2 = await readCi(facts.pr.url, run3);
    facts.ci = ci2.ci;
    facts.ciDetail = ci2.detail;
  }
  if (facts.pr && includeScreenshots)
    facts.screenshots = await readScreenshots(facts.pr.body ?? "");
  facts.claims = await verifyClaims(target, worktree, input.summary, run3);
  return facts;
}

// server/tasks/ci-poll.ts
var CI_POLL_MS = 6e4;
var CI_BATCH = 10;
function awaitingCi(db, id3) {
  const row3 = db.prepare(
    "SELECT detail FROM task_events WHERE task_id=? AND kind='gates' ORDER BY id DESC LIMIT 1"
  ).get(id3);
  try {
    return !!(row3?.detail && JSON.parse(row3.detail).awaiting_ci);
  } catch {
    return false;
  }
}
async function pollCiOnce(db, batch = CI_BATCH, run3 = exec) {
  const rows = db.prepare(
    "SELECT id,pr_url,status FROM tasks WHERE ci='pending' AND pr_url IS NOT NULL AND status NOT IN ('done','cancelled') ORDER BY updated_at,id LIMIT ?"
  ).all(batch);
  const outcomes = [];
  for (const row3 of rows) {
    const { ci: ci2, detail: ciDetail } = await readCi(row3.pr_url, run3);
    if (ci2 === "pending") continue;
    const detail2 = ci2 === "unavailable" ? ciUnavailableReason(ciDetail) : ciDetail;
    let task = patchRunFields(db, row3.id, { ci: ci2 }, "ci", {
      ci: ci2,
      pr_url: row3.pr_url,
      ...detail2 ? { detail: detail2 } : {}
    });
    let accepted = false;
    if (ci2 === "success" && row3.status === "blocked" && awaitingCi(db, row3.id) && // 请了专员的，本轮都通过才补判；否则由专员关卡在全部出结论时补判。
    concernsOf(db, row3.id).every((c) => c.verdict === "pass")) {
      task = advanceTask(
        db,
        taskRef(row3.id),
        { kind: "accept" },
        {},
        {
          reason: "CI \u901A\u8FC7\uFF0C\u9A8C\u6536\u8865\u5224\u901A\u8FC7"
        }
      );
      accepted = true;
    }
    outcomes.push({ task, ci: ci2, detail: detail2, accepted });
  }
  return outcomes;
}

// server/tasks/executors.ts
import { dirname as dirname4 } from "node:path";

// server/tasks/outcome.ts
var ADOPTED_EXIT = "\u63A5\u7BA1\u540E\u9000\u51FA\uFF0C\u9000\u51FA\u7801\u4E0D\u53EF\u5F97";
function exitText(exit, adopted2) {
  if (exit === "unknown")
    return adopted2 && adopted2.end !== "unknown" ? `${ADOPTED_EXIT}\uFF1B\u6309\u65E5\u5FD7\u5224\u4E3A${adopted2.end === "clean" ? "\u6B63\u5E38\u7ED3\u675F" : "\u51FA\u9519"}\uFF08${adopted2.evidence}\uFF09` : ADOPTED_EXIT;
  return exit.signal ? `\u88AB\u4FE1\u53F7 ${exit.signal} \u7ED3\u675F` : `\u9000\u51FA\u7801 ${exit.code}`;
}
function exitDetail(exit) {
  return exit === "unknown" ? { exit: "unknown" } : { code: exit.code, signal: exit.signal };
}
var needsFacts = (stop) => stop === void 0;
var needsGates = (stop, exit) => stop === void 0 && (exit === "unknown" || exit.code === 0 && exit.signal === null);
function decideExit(input) {
  const { stop, exit } = input;
  const lead = (reason) => [input.ending, input.transient, reason].filter(Boolean).join("\uFF1B");
  if (!stop && input.quota)
    return {
      event: "block",
      publish: "blocked",
      reason: input.quota,
      retry: false
    };
  if (stop?.kind === "user")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: "\u4EBA\u5DE5\u505C\u6B62",
      retry: false
    };
  if (stop?.kind === "tell")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: "\u4E3A\u9001\u634E\u8BDD\u505C\u4E0B\u540E\u91CD\u6D3E\u5931\u8D25",
      retry: false
    };
  if (stop?.kind === "stalled")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: stop.reason,
      retry: !input.retried && input.retryAllowed
    };
  if (stop?.kind === "idle")
    return {
      event: "block",
      publish: "blocked",
      reason: stop.reason,
      retry: false
    };
  if (!needsGates(stop, exit)) {
    const ended = exit;
    return {
      event: "exit_fail",
      publish: "failed",
      reason: lead(
        ended.signal ? `\u6267\u884C\u8005\u88AB\u4FE1\u53F7 ${ended.signal} \u7ED3\u675F` : `\u6267\u884C\u8005\u9000\u51FA\u7801 ${ended.code}`
      ),
      retry: false
    };
  }
  if (exit === "unknown" && input.adopted?.end === "error")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: lead(
        `${ADOPTED_EXIT}\uFF1B\u65E5\u5FD7\u663E\u793A\u51FA\u9519\u7ED3\u675F\uFF1A${input.adopted.evidence}`
      ),
      retry: false
    };
  if (input.abnormalFatal && exit === "unknown" && input.adopted?.end !== "clean")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: exitText(exit),
      retry: false
    };
  if (input.abnormalFatal && input.ending)
    return input.thinking ? {
      event: "block",
      publish: "blocked",
      reason: input.ending,
      retry: false
    } : {
      event: "exit_fail",
      publish: "failed",
      reason: input.ending,
      retry: false
    };
  const verdict2 = input.verdict;
  if (!verdict2) throw new Error("\u6B63\u5E38\u9000\u51FA\u987B\u5148\u7ED9\u51FA\u5173\u5361\u7ED3\u8BBA");
  if (verdict2.passed)
    return { event: "exit_ok", publish: "done", retry: false };
  const failed = verdict2.failed.map((result) => `${result.gate}\uFF1A${result.evidence}`).join("\uFF1B");
  const unavailable = verdict2.failed.find((result) => result.unavailable);
  return {
    event: "block",
    publish: unavailable ? "ci_unavailable" : "blocked",
    reason: lead(
      unavailable ? `${unavailable.evidence}${verdict2.failed.length > 1 ? `\uFF1B\u5176\u4F59\u5173\u5361\u4E0D\u8FC7\uFF1A${verdict2.failed.filter((result) => result !== unavailable).map((result) => `${result.gate}\uFF1A${result.evidence}`).join("\uFF1B")}` : ""}` : verdict2.awaitingCi ? `\u7B49 CI\uFF1A${failed}` : `\u5173\u5361\u4E0D\u8FC7\uFF1A${failed}`
    ),
    retry: false
  };
}

// server/tasks/settle.ts
import { readFileSync as readFileSync4, statSync as statSync2, appendFileSync } from "node:fs";
import { open as open2, stat as stat2 } from "node:fs/promises";

// server/tasks/adopted-exit.ts
var object3 = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
function claudeEnd(events2) {
  const result = events2.findLast((event) => event.type === "result");
  if (!result) return { end: "error", evidence: "\u65E5\u5FD7\u6CA1\u6709\u6536\u5C3E\u7684 result \u4E8B\u4EF6" };
  if (result.is_error === false && result.stop_reason === "end_turn")
    return { end: "clean", evidence: "result \u4E8B\u4EF6 stop_reason=end_turn" };
  const detail2 = [
    typeof result.subtype === "string" ? `subtype=${result.subtype}` : "",
    `stop_reason=${String(result.stop_reason ?? "\u65E0")}`,
    result.is_error === true ? "is_error=true" : ""
  ].filter(Boolean).join(" ");
  return { end: "error", evidence: `result \u4E8B\u4EF6 ${detail2}` };
}
function opencodeEnd(events2) {
  let finish = -1;
  for (let i = events2.length - 1; i >= 0 && finish < 0; i--)
    if (events2[i].type === "step_finish") finish = i;
  const error = events2.slice(finish + 1).findLast((event) => event.type === "error");
  if (error) {
    const message4 = object3(object3(error.error)?.data)?.message ?? object3(error.error)?.message ?? object3(error.error)?.name;
    return {
      end: "error",
      evidence: `error \u4E8B\u4EF6${typeof message4 === "string" && message4 ? `\uFF1A${message4.slice(0, 200)}` : ""}`
    };
  }
  if (finish < 0) return { end: "unknown" };
  const reason = object3(events2[finish].part)?.reason;
  return reason === "stop" ? { end: "clean", evidence: "\u6700\u540E\u4E00\u6B65 reason=stop" } : { end: "error", evidence: `\u6700\u540E\u4E00\u6B65 reason=${String(reason ?? "\u65E0")}` };
}
function adoptedEnd(input) {
  switch (input.tool) {
    case "claude":
      return input.log === void 0 ? { end: "unknown" } : claudeEnd(parseEvents(input.log));
    case "opencode":
      return input.log === void 0 ? { end: "unknown" } : opencodeEnd(parseEvents(input.log));
    case "codex":
      return input.lastMessage?.trim() ? { end: "clean", evidence: "\u5199\u51FA\u4E86\u6700\u7EC8\u6D88\u606F" } : { end: "unknown" };
    default:
      return { end: "unknown" };
  }
}

// server/tasks/comment-facts.ts
async function collectComments(repo, issue, startedAt, run3 = exec) {
  if (!repo)
    return { comments: [], error: "\u4EFB\u52A1\u6CA1\u6709\u4ED3\u5E93\uFF0C\u65E0\u6CD5\u67E5\u8BE2 issue \u8BC4\u8BBA" };
  const origin = await originRepo(repo, run3);
  if ("error" in origin) return { comments: [], error: origin.error };
  const response = await run3(
    "gh",
    [
      ...apiArgs(origin.repo, `issues/${issue}/comments`),
      "--method",
      "GET",
      "-f",
      `since=${new Date(startedAt - 1e3).toISOString()}`,
      "-f",
      "per_page=100",
      "--paginate",
      "--slurp"
    ],
    { timeoutMs: 3e4 }
  );
  if (!response.ok)
    return {
      comments: [],
      error: response.stderr.trim().split("\n")[0] || "gh \u67E5\u8BE2\u5931\u8D25"
    };
  try {
    const pages = JSON.parse(response.stdout);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error();
    const comments = pages.flat().filter(
      (item) => !!item && typeof item === "object" && typeof item.created_at === "string" && typeof item.html_url === "string"
    );
    return { comments };
  } catch {
    return { comments: [], error: "gh \u8BC4\u8BBA\u8F93\u51FA\u4E0D\u662F\u9884\u671F JSON" };
  }
}

// server/tasks/delivery-gates.ts
function verdict(results) {
  const failed = results.filter((result) => !result.ok);
  return { results, failed, passed: failed.length === 0, awaitingCi: false };
}
function evaluateDelivery(input) {
  if (input.deliver === "pr") {
    if (!input.facts) throw new Error("PR \u4EA4\u4ED8\u7F3A\u5C11\u4ED3\u5E93\u4E8B\u5B9E");
    return evaluateGates(input.checks, input.limits, input.facts);
  }
  if (input.deliver === "none") return verdict([]);
  const { issue, comments, startedAt, endedAt } = input;
  if (!issue)
    return verdict([
      { gate: "comment", ok: false, evidence: "\u4EFB\u52A1\u6CA1\u6709 issue \u53F7" }
    ]);
  if (!comments)
    return verdict([{ gate: "comment", ok: false, evidence: "\u6CA1\u6709\u67E5\u8BE2\u8BC4\u8BBA" }]);
  if (comments.error)
    return verdict([
      {
        gate: "comment",
        ok: false,
        evidence: `issue #${issue} \u8BC4\u8BBA\u67E5\u8BE2\u5931\u8D25\uFF1A${comments.error}`
      }
    ]);
  const startSecond = Math.floor(startedAt / 1e3) * 1e3;
  const found = comments.comments.find((comment) => {
    const at = Date.parse(comment.created_at);
    return Number.isFinite(at) && at >= startSecond && at <= endedAt && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+#issuecomment-\d+$/.test(
      comment.html_url
    );
  });
  return verdict([
    {
      gate: "comment",
      ok: !!found,
      evidence: found ? `issue #${issue} \u5728\u8FD0\u884C\u671F\u95F4\u65B0\u589E\u8BC4\u8BBA\uFF1A${found.html_url}` : `issue #${issue} \u5728\u8FD0\u884C\u671F\u95F4\u6CA1\u6709\u65B0\u8BC4\u8BBA`
    }
  ]);
}

// server/tasks/quota-holds.ts
var DEFAULT_UNKNOWN_HOLD_MS = 60 * 60 * 1e3;
function ensureQuotaHoldTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS quota_holds (
      provider TEXT PRIMARY KEY,
      until INTEGER NULL,
      reason TEXT,
      since INTEGER NOT NULL)`);
}
function holdUntil(resetAt2, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  const at = resetAt2?.getTime();
  return at !== void 0 && Number.isFinite(at) ? at : now + unknownMs;
}
var expiresAt = (hold, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) => hold.until ?? hold.since + unknownMs;
var pad = (value) => String(value).padStart(2, "0");
function clock(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function quotaReason(provider2, resetAt2) {
  return resetAt2 ? `\u989D\u5EA6\u7528\u5C3D\uFF1A${provider2}\uFF0C\u9884\u8BA1 ${clock(resetAt2.getTime())} \u6062\u590D` : `\u989D\u5EA6\u7528\u5C3D\uFF1A${provider2}\uFF0C\u6062\u590D\u65F6\u95F4\u672A\u77E5`;
}
function heldProviders(holds, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  const held = /* @__PURE__ */ new Map();
  for (const hold of holds) {
    const until = expiresAt(hold, unknownMs);
    if (until > now) held.set(hold.provider, until);
  }
  return held;
}
function expiredHolds(holds, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  return holds.filter((hold) => expiresAt(hold, unknownMs) <= now);
}
function routeAfterQuota(input) {
  if (!input.switchAllowed)
    return { kind: "blocked", why: "\u6863\u6848\u4E0D\u5141\u8BB8\u989D\u5EA6\u7528\u5C3D\u65F6\u6362\u6267\u884C\u8005" };
  if (input.switched)
    return { kind: "blocked", why: "\u672C\u4EFB\u52A1\u5DF2\u56E0\u989D\u5EA6\u6362\u8FC7\u4E00\u6B21\u6267\u884C\u8005" };
  return { kind: "switch" };
}
function listHolds(db) {
  return db.prepare("SELECT * FROM quota_holds ORDER BY provider LIMIT 100").all();
}
function placeHold(db, hold, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  return atomically(db, () => {
    const existing = db.prepare("SELECT * FROM quota_holds WHERE provider=?").get(hold.provider);
    const live = existing && expiresAt(existing, unknownMs) > now;
    const until = live ? Math.max(expiresAt(existing, unknownMs), hold.until) : hold.until;
    db.prepare(
      "INSERT INTO quota_holds(provider,until,reason,since) VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET until=excluded.until,reason=excluded.reason,since=excluded.since"
    ).run(hold.provider, until, hold.reason, live ? existing.since : now);
    return { fresh: !live, until };
  });
}
function releaseHold(db, provider2, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  return db.prepare(
    "DELETE FROM quota_holds WHERE provider=? AND COALESCE(until, since+?)<=?"
  ).run(provider2, unknownMs, now).changes > 0;
}
function clearHold(db, provider2) {
  return atomically(db, () => {
    const hold = db.prepare("SELECT * FROM quota_holds WHERE provider=?").get(provider2);
    if (hold)
      db.prepare("DELETE FROM quota_holds WHERE provider=?").run(provider2);
    return hold;
  });
}

// server/tasks/quota-signal.ts
var QUOTA_MARK = /(?:usage|session|rate|request|monthly|daily|5[-_\s]?hour)[\s_]+limits?\s+(?:reached|exceeded|hit|exhausted)|hit (?:your|the) [^\n]{0,40}limits?|rate_limit_error|(?:insufficient|exceeded|exhausted)[_\s]+quota|quota[_\s]+(?:exceeded|exhausted|limit|depleted)|too many requests|(?:额度|用量|余额)[^\n]{0,20}(?:用尽|不足|超限|达到上限|已满)|(?:用尽|不足|超限)[^\n]{0,20}(?:额度|用量|余额)/i;
var HTTP_429 = /(?<![\d.])429(?![\d])/;
function quotaErrorText(logTail4) {
  let last = "";
  for (const line of logTail4.split("\n")) {
    const event = parseLine(line);
    if (!event) {
      if (/\b(?:error|failed|limit reached|limit exceeded|hit your .*limit|too many requests|HTTP\/\S+ 429)\b|额度.{0,20}(?:用尽|不足|超限)|余额不足/i.test(
        line
      ))
        last = line;
      else if (last && /\b(?:retry-after|try again in|resets? \d)/i.test(line))
        last += `
${line}`;
      continue;
    }
    const type = event.type;
    if (type === "result" && event.is_error === false && event.stop_reason === "end_turn") {
      last = "";
      continue;
    }
    if (type === "rate_limit_event") {
      const info = event.rate_limit_info;
      const status = info && typeof info === "object" && "status" in info ? info.status : void 0;
      if (typeof status === "string" && /^(?:rejected|blocked|limited|rate_limited|exceeded|denied)$/i.test(
        status
      ))
        last = `rate limit exceeded: ${status}`;
      continue;
    }
    if (type !== "error" && !(type === "result" && (event.is_error === true || event.subtype === "error")))
      continue;
    const report = [];
    for (const value of [event.error, event.errors, event.message]) {
      if (typeof value === "string") report.push(value);
      else if (Array.isArray(value)) {
        for (const item of value)
          if (typeof item === "string") report.push(item);
      } else if (value && typeof value === "object") {
        const error = value;
        for (const field2 of ["message", "type", "code"])
          if (typeof error[field2] === "string") report.push(error[field2]);
      }
    }
    if (report.length) last = report.join("\n");
  }
  return last;
}
var CODEX_MINUTES = /try\s+again\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|m)(?![a-z])/i;
var RESET_AT = /\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
var RETRY_AFTER = /\bretry-after\s*:\s*([^\r\n]+)/i;
var SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
function validZone(zone) {
  if (!zone) return void 0;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return void 0;
  }
}
function zoneWall(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const num = (type) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second")
  };
}
function zoneOffset(ts, zone) {
  const w = zoneWall(new Date(ts), zone);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - Math.floor(ts / 1e3) * 1e3;
}
function wallToUtc(wallMs, zone) {
  let ts = wallMs - zoneOffset(wallMs, zone);
  ts = wallMs - zoneOffset(ts, zone);
  return new Date(ts);
}
var pad2 = (value) => String(value).padStart(2, "0");
function fromMinutes(text6, now) {
  const match = CODEX_MINUTES.exec(text6);
  if (!match) return void 0;
  const minutes2 = Number(match[1]);
  if (!Number.isFinite(minutes2) || minutes2 <= 0) return void 0;
  return {
    resetAt: new Date(now.getTime() + minutes2 * 6e4),
    label: `\u989D\u5EA6\u62A5\u6587\uFF1A\u7EA6 ${match[1]} \u5206\u949F\u540E\u6062\u590D`,
    index: match.index
  };
}
function fromResetTime(text6, now) {
  for (const match of text6.matchAll(RESET_AT)) {
    const hourText = match[1];
    if (!hourText) continue;
    const minuteText = match[2];
    const ampm = match[3] ? match[3].toLowerCase() : "";
    if (!minuteText && !ampm) continue;
    const minute = minuteText ? Number(minuteText) : 0;
    if (minute > 59) continue;
    let hour = Number(hourText);
    if (ampm) {
      if (hour < 1 || hour > 12) continue;
      if (ampm === "pm" && hour !== 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
    } else if (hour > 23) continue;
    const after = text6.slice(match.index + match[0].length);
    const zone = validZone(/^\s*\(([^()]{2,64})\)/.exec(after)?.[1]) ?? SYSTEM_ZONE;
    const wall = zoneWall(now, zone);
    let target = Date.UTC(wall.year, wall.month - 1, wall.day, hour, minute);
    const today = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute
    );
    if (target <= today) target += 864e5;
    return {
      resetAt: wallToUtc(target, zone),
      label: `\u989D\u5EA6\u62A5\u6587\uFF1A${zone} ${pad2(hour)}:${pad2(minute)} \u6062\u590D`,
      index: match.index
    };
  }
  return void 0;
}
function fromRetryAfter(text6, now) {
  const match = RETRY_AFTER.exec(text6);
  if (!match) return void 0;
  const value = match[1].trim();
  const label5 = `\u9650\u6D41\u54CD\u5E94\uFF1ARetry-After ${value.slice(0, 60)}`;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return void 0;
    return {
      resetAt: new Date(now.getTime() + seconds * 1e3),
      label: label5,
      index: match.index
    };
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return void 0;
  return { resetAt: new Date(ts), label: label5, index: match.index };
}
function lineAt(text6, index2) {
  const start = text6.lastIndexOf("\n", index2) + 1;
  let end = text6.indexOf("\n", index2);
  if (end < 0) end = text6.length;
  return text6.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 160);
}
var withLine = (text6, index2, label5) => {
  const line = lineAt(text6, index2);
  return line ? `${label5}\uFF08${line}\uFF09` : label5;
};
function detectQuotaExhausted({
  exitCode,
  logTail: logTail4,
  now,
  tool
}) {
  if (exitCode === 0) return { exhausted: false };
  const text6 = quotaErrorText(logTail4);
  const marked = QUOTA_MARK.test(text6);
  const http429 = HTTP_429.test(text6);
  if (!marked && !http429) return { exhausted: false };
  const provider2 = ADAPTERS[tool].quotaProvider;
  const timed = fromMinutes(text6, now) ?? fromResetTime(text6, now) ?? fromRetryAfter(text6, now);
  if (timed)
    return {
      exhausted: true,
      provider: provider2,
      resetAt: timed.resetAt,
      reason: withLine(text6, timed.index, timed.label)
    };
  const index2 = QUOTA_MARK.exec(text6)?.index ?? HTTP_429.exec(text6)?.index ?? 0;
  return {
    exhausted: true,
    provider: provider2,
    resetAt: null,
    reason: withLine(
      text6,
      index2,
      http429 ? "HTTP 429 \u9650\u6D41\uFF0C\u4F46\u6CA1\u6709\u89E3\u6790\u51FA\u6062\u590D\u65F6\u95F4" : "\u65E5\u5FD7\u50CF\u662F\u989D\u5EA6\u7528\u5C3D\uFF0C\u4F46\u6CA1\u6709\u89E3\u6790\u51FA\u6062\u590D\u65F6\u95F4"
    )
  };
}

// server/tasks/transient.ts
var MARKS = [
  [
    /certificate verif|unable to (?:get|verify) (?:local issuer )?certificate|self[- ]signed certificate|\bCERT_[A-Z_]+\b|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
    "\u8BC1\u4E66\u6821\u9A8C\u51FA\u9519"
  ],
  [
    /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|AI_AGAIN|NOTFOUND|NETUNREACH|HOSTUNREACH)\b|socket hang up|connection (?:reset|refused)|stream disconnected|network error/i,
    "\u7F51\u7EDC\u8FDE\u63A5\u51FA\u9519"
  ],
  [/fetch failed/i, "\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25"],
  [/overloaded/i, "\u4F9B\u5E94\u5546\u8FC7\u8F7D"],
  [
    /\b(?:HTTP|status(?:\s*code)?|error\s*code)\s*[:=]?\s*5\d\d\b|\b5\d\d\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout/i,
    "\u4F9B\u5E94\u5546\u670D\u52A1\u7AEF\u9519\u8BEF\uFF085xx\uFF09"
  ]
];
var TAIL_LINES = 12;
var EVIDENCE_MAX = 200;
var object4 = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
var oneLine = (text6) => {
  const line = text6.replace(/\s+/g, " ").trim();
  return line.length > EVIDENCE_MAX ? `${line.slice(0, EVIDENCE_MAX)}\u2026` : line;
};
function classify(text6) {
  return MARKS.find(([pattern]) => pattern.test(text6))?.[1];
}
function errorText(event) {
  if (event.type === "error") {
    const error = object4(event.error);
    const parts = [
      error?.name,
      object4(error?.data)?.message,
      error?.message,
      typeof event.error === "string" ? event.error : void 0,
      event.message
    ].filter((part) => typeof part === "string" && !!part);
    return parts.length ? parts.join(": ") : void 0;
  }
  if (event.type === "result" && event.is_error === true) {
    const parts = [event.subtype, event.result].filter(
      (part) => typeof part === "string" && !!part
    );
    return parts.length ? parts.join(": ") : void 0;
  }
  return void 0;
}
function fromEvents(text6) {
  const events2 = parseEvents(text6);
  for (let i = events2.length - 1; i >= 0; i--) {
    const body3 = errorText(events2[i]);
    if (body3 === void 0) continue;
    const kind = classify(body3);
    return kind ? hit(kind, body3) : void 0;
  }
  return void 0;
}
function fromLines(text6) {
  const lines2 = text6.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("{")).slice(-TAIL_LINES);
  for (let i = lines2.length - 1; i >= 0; i--) {
    const kind = classify(lines2[i]);
    if (kind) return hit(kind, lines2[i]);
  }
  return void 0;
}
var hit = (kind, evidence) => ({
  reason: `\u4F9B\u5E94\u5546\u6216\u7F51\u7EDC\u4E34\u65F6\u9519\u8BEF\uFF1A${kind}`,
  evidence: oneLine(evidence)
});
function detectTransient({
  exitCode,
  logTail: logTail4,
  json
}) {
  if (exitCode === 0 || exitCode === null) return void 0;
  return (json ? fromEvents(logTail4) : void 0) ?? fromLines(logTail4);
}
function routeAfterTransient(input) {
  if (!input.allowed)
    return { kind: "fail", why: "\u6863\u6848\u4E0D\u5141\u8BB8\u4E34\u65F6\u9519\u8BEF\u540E\u81EA\u52A8\u91CD\u8BD5" };
  if (input.attempts === 0) return { kind: "same", attempt: 1 };
  if (input.attempts === 1) return { kind: "switch", attempt: 2 };
  return { kind: "fail", why: "\u4E34\u65F6\u9519\u8BEF\u5DF2\u91CD\u8BD5\u8FC7\u540C\u4E00\u6267\u884C\u8005\u5E76\u6362\u8FC7\u6267\u884C\u8005" };
}
var startDetail = (event) => {
  try {
    return object4(object4(JSON.parse(event.detail ?? "null"))?.detail);
  } catch {
    return void 0;
  }
};
function transientAttempts(events2) {
  return retryAttempts(events2, "transient_retry");
}
function retryAttempts(events2, kind) {
  let count2 = 0;
  for (let i = events2.length - 1; i >= 0; i--) {
    const event = events2[i];
    if (event.kind === kind) count2++;
    else if (event.kind === "start" && !startDetail(event)?.retry) break;
  }
  return count2;
}

// server/tasks/local-check.ts
import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync as mkdirSync3,
  openSync,
  readSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { readFile as readFile2, realpath } from "node:fs/promises";
import { isAbsolute as isAbsolute4, join as join10, relative, sep } from "node:path";

// server/tasks/worker-env.ts
import { availableParallelism as availableParallelism2 } from "node:os";
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
function workerAllowed(key) {
  return SYSTEM.has(key) || NETWORK.has(key) || key.startsWith("LC_");
}
function workerEnvironment(base2 = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base2))
    if (value !== void 0 && workerAllowed(key)) env[key] = value;
  env.NO_COLOR = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GH_PROMPT_DISABLED = "1";
  env.ATRIUM_WORKER = "1";
  env.ATRIUM_TEST_CONCURRENCY = String(
    hostLimits(base2, availableParallelism2()).limits.testConcurrency
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
  async run(work, queued2, urgent = false) {
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
        queued2?.();
      } catch {
      }
      await new Promise((resolve4) => {
        this.waiters.push(resolve4);
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
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute4(path))
      throw new Error(`\u68C0\u67E5\u811A\u672C\u6307\u5411\u5DE5\u4F5C\u6811\u5916\uFF1A${file}`);
    return target;
  };
  try {
    const script = (await readFile2(await inside(join10(worktree, ".agents", "check")), "utf8")).trim();
    if (!script) throw new Error(".agents/check \u4E3A\u7A7A");
    return script;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let pkg;
  try {
    pkg = JSON.parse(
      await readFile2(await inside(join10(worktree, "package.json")), "utf8")
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
  const names2 = /* @__PURE__ */ new Set();
  for (const line of log.split("\n")) {
    const name2 = line.match(/^\s*(?:not ok \d+ - |✖\s+|FAIL\s+)(.+)/)?.[1]?.trim();
    if (name2 && name2 !== "failing tests:") names2.add(name2.slice(0, 200));
  }
  return [...names2].slice(0, 10);
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
  const log = join10(input.taskDir, "local-check.log");
  return (input.queue ?? sharedLocalChecks).run(
    async () => {
      if (input.signal?.aborted) throw new Error("\u670D\u52A1\u6B63\u5728\u5173\u95ED");
      mkdirSync3(input.taskDir, { recursive: true, mode: 448 });
      let command = "";
      try {
        if (!input.worktree)
          throw new Error("\u4EFB\u52A1\u6CA1\u6709 worktree\uFF0C\u4E0D\u80FD\u8FD0\u884C\u672C\u5730\u68C0\u67E5");
        command = await checkCommand(input.worktree);
      } catch (error) {
        writeFileSync3(log, `${String(error)}
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
        child = spawn("/bin/sh", ["-c", command], {
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
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
          }
        }
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS);
      const result = await new Promise(
        (resolve4) => {
          child.once("error", (error) => resolve4({ code: null, error }));
          child.once("close", (code) => resolve4({ code }));
        }
      );
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const tail = logTail(log);
      const failedTests = failedTestNames(tail);
      const status = timedOut ? "timeout" : result.error ? "error" : result.code === 0 ? "passed" : "failed";
      const detail2 = timedOut ? `\u8D85\u8FC7 ${Math.ceil((input.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS) / 6e4)} \u5206\u949F` : result.error?.message ?? (result.code === 0 ? "\u68C0\u67E5\u901A\u8FC7" : `\u9000\u51FA\u7801 ${result.code}`);
      return { status, command, log, detail: detail2, failedTests };
    },
    () => input.onStatus?.("queued", log),
    input.urgent
  );
}

// server/tasks/settle.ts
import { dirname as dirname2 } from "node:path";
var TAIL_BYTES = 64 * 1024;
async function logTail2(file, bytes = TAIL_BYTES) {
  const size = (await stat2(file)).size;
  const start = Math.max(0, size - bytes);
  const handle = await open2(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
async function readLog(active) {
  try {
    return (await logTail2(active.logFile)).split("\n").filter((line) => !line.startsWith("[atrium] ")).join("\n");
  } catch {
    return void 0;
  }
}
var jsonEvents = (active) => ADAPTERS[active.tool].progressSignals.includes("json_events");
function readLastMessage(active) {
  const resultFile = active.prepared?.launch.resultFile ?? active.resultFile;
  if (!resultFile) return void 0;
  try {
    if (statSync2(resultFile).mtimeMs < active.startedAt) return void 0;
    return readFileSync4(resultFile, "utf8").trim() || void 0;
  } catch {
    return void 0;
  }
}
function readSummary(active, log, lastMessage) {
  if (lastMessage) return summarize(lastMessage);
  return log === void 0 ? "" : summarize(log, jsonEvents(active));
}
var QUOTA_TAIL_CHARS = 4096;
var deliveredDespiteUnknownExit = (exit, facts) => exit === "unknown" && !!facts?.pr && facts.ci === "success";
function detectQuota(active, exit, log) {
  if (active.stop || log === void 0) return void 0;
  const verdict2 = detectQuotaExhausted({
    exitCode: exit === "unknown" ? null : exit.code,
    logTail: log.slice(-QUOTA_TAIL_CHARS),
    now: /* @__PURE__ */ new Date(),
    tool: active.tool
  });
  if (!verdict2.exhausted) return void 0;
  return {
    provider: verdict2.provider,
    resetAt: verdict2.resetAt,
    reason: quotaReason(verdict2.provider, verdict2.resetAt),
    evidence: verdict2.reason
  };
}
async function settle(active, exit, exec2, onLocalCheckStatus, env, urgent = false) {
  const log = await readLog(active);
  const workerGuardRefused = log?.includes("\u6267\u884C\u8005\u73AF\u5883\u91CC\u4E0D\u80FD\u64CD\u4F5C\u7528\u6237\u7684 Atrium \u670D\u52A1") ?? false;
  const lastMessage = readLastMessage(active);
  const summary2 = readSummary(active, log, lastMessage);
  const adopted2 = exit === "unknown" ? adoptedEnd({ tool: active.tool, log, lastMessage }) : void 0;
  try {
    appendFileSync(
      active.logFile,
      `
[atrium] ${(/* @__PURE__ */ new Date()).toISOString()} ${exitText(exit, adopted2)}
`
    );
  } catch {
  }
  const fields = { result: summary2 };
  const endedAt = Date.now();
  let facts;
  if (exit === "unknown" && active.deliver === "pr" && needsFacts(active.stop)) {
    facts = await collectFacts(
      {
        repo: active.repo,
        worktree: active.worktree,
        branch: active.branch,
        base: active.base,
        summary: summary2
      },
      exec2,
      active.worker.profile.rules.checks?.includes("ci") ?? false,
      active.worker.profile.rules.checks?.some(
        (gate) => ["screenshot", "screenshots"].includes(gate)
      ) ?? false
    );
    fields.pr_url = facts.pr?.url ?? null;
    fields.ci = facts.ci;
  }
  const quota = deliveredDespiteUnknownExit(exit, facts) ? void 0 : detectQuota(active, exit, log);
  if (quota) {
    const decision2 = decideExit({
      exit,
      retried: active.retried,
      retryAllowed: false,
      quota: quota.reason
    });
    return { summary: summary2, fields, decision: decision2, quota };
  }
  let verdict2;
  let localCheck2;
  if (!facts && active.deliver === "pr" && needsFacts(active.stop)) {
    facts = await collectFacts(
      {
        repo: active.repo,
        worktree: active.worktree,
        branch: active.branch,
        base: active.base,
        summary: summary2
      },
      exec2,
      active.worker.profile.rules.checks?.includes("ci") ?? false,
      active.worker.profile.rules.checks?.some(
        (gate) => ["screenshot", "screenshots"].includes(gate)
      ) ?? false
    );
    fields.pr_url = facts.pr?.url ?? null;
    fields.ci = facts.ci;
  }
  if (needsGates(active.stop, exit)) {
    const rules = active.worker.profile.rules;
    if (active.deliver === "pr" && rules.checks?.includes("local_check")) {
      localCheck2 = await runLocalCheck({
        worktree: active.worktree ?? "",
        taskDir: dirname2(active.logFile),
        env,
        onStatus: onLocalCheckStatus,
        urgent
      });
      if (facts) facts.localCheck = localCheck2;
    }
    const comments = active.deliver === "comment" && active.issue ? await collectComments(
      active.repo,
      active.issue,
      active.startedAt,
      exec2
    ) : void 0;
    verdict2 = evaluateDelivery({
      deliver: active.deliver,
      issue: active.issue,
      startedAt: active.startedAt,
      endedAt,
      comments,
      checks: rules.checks ?? [],
      limits: rules.limits ?? {},
      facts
    });
    const link = verdict2.results.find((result) => result.gate === "comment" && result.ok)?.evidence.match(/https:\/\/\S+/)?.[0];
    if (link)
      fields.result = [summary2, `\u8BC4\u8BBA\uFF1A${link}`].filter(Boolean).join("\n");
  }
  const ending = log !== void 0 && jsonEvents(active) ? abnormalEnding(parseEvents(log)) : void 0;
  const transient = active.stop || log === void 0 || ending && ending.kind !== "midway" ? void 0 : detectTransient({
    exitCode: exit === "unknown" ? null : exit.code,
    logTail: log,
    json: jsonEvents(active)
  });
  const decision = decideExit({
    stop: active.stop,
    exit,
    retried: active.retried,
    retryAllowed: active.worker.profile.rules.retry_on_stall !== false,
    verdict: verdict2,
    ending: ending?.reason,
    abnormalFatal: active.deliver !== "pr",
    thinking: ending?.kind === "thinking",
    transient: transient?.reason,
    // 远端已交付（PR 在、CI 过）的照常过关卡，不因日志里的出错判失败。
    adopted: deliveredDespiteUnknownExit(exit, facts) ? void 0 : adopted2
  });
  return {
    summary: summary2,
    fields,
    decision,
    verdict: verdict2,
    facts,
    transient,
    ending,
    localCheck: localCheck2,
    workerGuardRefused
  };
}
function diffSize(facts) {
  return {
    files: facts.numstat.length,
    added: facts.numstat.reduce((sum, stat5) => sum + stat5.added, 0),
    removed: facts.numstat.reduce((sum, stat5) => sum + stat5.removed, 0)
  };
}

// server/tasks/spawn.ts
import { spawn as spawn2 } from "node:child_process";
import {
  appendFileSync as appendFileSync2,
  closeSync as closeSync2,
  existsSync as existsSync3,
  openSync as openSync2,
  readFileSync as readFileSync5,
  renameSync as renameSync2,
  statSync as statSync3,
  writeFileSync as writeFileSync4
} from "node:fs";

// server/tasks/live-input.ts
import { open as open3 } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
var userLine = (text6, uuid) => `${JSON.stringify({
  type: "user",
  ...uuid ? { uuid } : {},
  session_id: "",
  parent_tool_use_id: null,
  message: { role: "user", content: text6 }
})}
`;
var LINE_MAX = 16 * 1024 * 1024;
var CHUNK = 256 * 1024;
function lineSignal(line) {
  if (!line.startsWith("{") || !line.includes('"type":"result"') && !line.includes('"isReplay":true'))
    return void 0;
  try {
    const event = JSON.parse(line);
    if (event.type === "result") return { kind: "result" };
    return event.type === "user" && event.isReplay === true && typeof event.uuid === "string" ? { kind: "echo", uuid: event.uuid } : void 0;
  } catch {
    return void 0;
  }
}
var LiveInput = class {
  constructor(stdin, logFile, offset, onEcho, pollMs = 500) {
    this.stdin = stdin;
    this.logFile = logFile;
    this.offset = offset;
    this.onEcho = onEcho;
    stdin.on("error", () => {
      this.ended = true;
    });
    this.timer = setInterval(() => void this.scan(), pollMs);
    this.timer.unref();
  }
  stdin;
  logFile;
  offset;
  onEcho;
  buffer = "";
  decoder = new StringDecoder("utf8");
  ended = false;
  awaitingEcho = /* @__PURE__ */ new Set();
  scanning;
  timer;
  /** 还能即时写入：本轮没结束、写端没断。 */
  get open() {
    return !this.ended && this.stdin.writable;
  }
  send(text6, uuid) {
    if (!this.open) return false;
    this.awaitingEcho.add(uuid);
    this.stdin.write(userLine(text6, uuid));
    return true;
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.stdin.end();
  }
  /** 进程退出后：读完剩下的日志（确认最后的回显），停止轮询并关掉写端。 */
  async finish() {
    clearInterval(this.timer);
    await this.scan();
    this.end();
  }
  scan() {
    this.scanning ??= this.read().finally(() => {
      this.scanning = void 0;
    });
    return this.scanning;
  }
  async read() {
    let file;
    try {
      file = await open3(this.logFile, "r");
    } catch {
      return;
    }
    try {
      const chunk = Buffer.alloc(CHUNK);
      for (; ; ) {
        const { bytesRead } = await file.read(chunk, 0, CHUNK, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.feed(this.decoder.write(chunk.subarray(0, bytesRead)));
      }
    } finally {
      await file.close();
    }
  }
  feed(text6) {
    this.buffer += text6;
    let index2;
    while ((index2 = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index2);
      this.buffer = this.buffer.slice(index2 + 1);
      const signal = lineSignal(line);
      if (signal?.kind === "result" && !this.awaitingEcho.size) this.end();
      else if (signal?.kind === "echo") {
        this.awaitingEcho.delete(signal.uuid);
        this.onEcho(signal.uuid);
      }
    }
    if (this.buffer.length > LINE_MAX) this.buffer = "";
  }
};

// server/tasks/spawn.ts
var shortArg = (arg) => {
  const flat = arg.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 77)}\u2026` : flat;
};
async function spawnWorker(prepared, env, taskRefText, append = false) {
  const { launch, logFile } = prepared;
  if (!append && existsSync3(logFile))
    renameSync2(logFile, `${logFile}-${Date.now()}`);
  const command = findExecutable(launch.command, env.PATH ?? "") ?? launch.command;
  const header = `[atrium] ${taskRefText} \xB7 ${prepared.worker.id} \xB7 ${(/* @__PURE__ */ new Date()).toISOString()}${append ? " \xB7 \u7EED\u4E0A\u4F1A\u8BDD" : ""}
[atrium] cwd ${launch.cwd}
${Object.entries(
    launch.env ?? {}
  ).map(([key, value]) => `[atrium] env ${key}=${value}
`).join("")}[atrium] ${[command, ...launch.args.map(shortArg)].join(" ")}
`;
  if (append) appendFileSync2(logFile, header, { mode: 384 });
  else writeFileSync4(logFile, header, { mode: 384 });
  const offset = statSync3(logFile).size;
  const out = openSync2(logFile, "a");
  const piped = launch.input === "stream-json";
  const input = launch.stdin && !piped ? openSync2(launch.stdin, "r") : piped ? "pipe" : "ignore";
  let child;
  try {
    child = spawn2(command, launch.args, {
      cwd: launch.cwd,
      env: launch.env ? { ...env, ...launch.env } : env,
      detached: true,
      stdio: [input, out, out]
    });
  } finally {
    closeSync2(out);
    if (typeof input === "number") closeSync2(input);
  }
  if (!child.pid) {
    const error = await new Promise(
      (resolve4) => child.once("error", resolve4)
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
      child.stdin.write(userLine(readFileSync5(launch.stdin, "utf8")));
    child.stdin.unref?.();
  }
  child.unref();
  return { child, offset };
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
    }
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// server/tasks/thinking.ts
function routeAfterThinking(input) {
  const { decision, verdict: verdict2 } = input;
  if (!input.thinking || input.stop) return { kind: "none" };
  if (decision.publish === "done" || decision.publish === "ci_unavailable")
    return { kind: "none" };
  if (verdict2?.awaitingCi) return { kind: "none" };
  if (input.attempts >= 1)
    return { kind: "give_up", why: "\u601D\u8003\u8017\u5C3D\u540E\u5DF2\u6362\u8FC7\u4E00\u6B21\u6267\u884C\u8005" };
  return { kind: "switch" };
}
var thinkingAttempts = (events2) => retryAttempts(events2, "thinking_retry");

// server/tasks/plan.ts
function runRequest(body3) {
  if (body3 === void 0 || body3 === null) return {};
  if (typeof body3 !== "object" || Array.isArray(body3))
    throw new Problem(400, "\u8BF7\u6C42\u4F53\u5E94\u4E3A JSON \u5BF9\u8C61", "usage");
  const input = body3;
  const extra = Object.keys(input).filter(
    (key) => key !== "worker" && key !== "risk" && key !== "urgent"
  );
  if (extra.length)
    throw new Problem(
      400,
      `\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5\uFF1A${extra.join("\u3001")}\uFF1B\u53EF\u7528 worker\u3001risk\u3001urgent`,
      "usage"
    );
  if (input.urgent !== void 0 && typeof input.urgent !== "boolean")
    throw new Problem(400, "urgent: \u5E94\u4E3A true \u6216 false", "usage");
  const text6 = (key) => {
    const value = input[key];
    if (value === void 0 || value === null || value === "") return void 0;
    if (typeof value !== "string")
      throw new Problem(400, `${key}: \u5E94\u4E3A\u6587\u672C`, "usage");
    return value.trim();
  };
  const risk = text6("risk");
  if (risk !== void 0 && !isRisk(risk))
    throw new Problem(400, `risk: \u53EA\u80FD\u662F ${RISKS.join("\u3001")}`, "usage");
  return {
    worker: text6("worker"),
    risk,
    ...input.urgent === true ? { urgent: true } : {}
  };
}
function admit(input) {
  if (input.running)
    return { ok: false, reason: "\u6B63\u5728\u8FD0\u884C\u6216\u6B63\u5728\u542F\u52A8\uFF0C\u4E0D\u80FD\u91CD\u590D\u6D3E" };
  if (input.queued) return { ok: false, reason: "\u5DF2\u5728\u6392\u961F" };
  const next = transition(input.status, { kind: "start" });
  return next.ok ? { ok: true } : { ok: false, reason: next.reason };
}
function riskRefusal(workerId2, maxRisk, risk) {
  if (!maxRisk || RISKS.indexOf(maxRisk) >= RISKS.indexOf(risk))
    return void 0;
  return `\u6267\u884C\u8005 ${workerId2} \u7684\u6863\u6848 max_risk=${maxRisk}\uFF0C\u63A5\u4E0D\u4E86 risk=${risk} \u7684\u4EFB\u52A1\uFF1B\u6362\u6267\u884C\u8005\u6216\u964D\u4F4E --risk`;
}
function trustRefusal(workerId2, trust, risk) {
  const actual = trust ?? "unknown";
  if (TRUSTS.indexOf(actual) > RISKS.indexOf(risk)) return void 0;
  return `\u6267\u884C\u8005 ${workerId2} \u7684\u6863\u6848 trust=${actual}\uFF0C\u63A5\u4E0D\u4E86 risk=${risk} \u7684\u989D\u5EA6\u91CD\u6D3E\u4EFB\u52A1`;
}
function placement(exclusive, busy) {
  return exclusive && busy ? "queue" : "launch";
}

// server/tasks/prepare.ts
import { readFile as readFile4 } from "node:fs/promises";
import { isAbsolute as isAbsolute5, join as join11, sep as sep2 } from "node:path";

// server/tasks/openquota.ts
import { execFile as execFile3 } from "node:child_process";
import { homedir as homedir3 } from "node:os";
var OPENQUOTA_BIN = "/Applications/OpenQuota.app/Contents/MacOS/openquota";
var PACE_TIMEOUT_MS = 1e4;
var PACE_MAX_BUFFER = 1024 * 1024;
var SYSTEM_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "TZ"
];
function resolveOpenquotaBin(explicit, env = process.env) {
  const given2 = explicit?.trim();
  if (given2) return given2;
  const fromEnv = env.ATRIUM_OPENQUOTA_BIN?.trim();
  return fromEnv || OPENQUOTA_BIN;
}
function childEnv(base2) {
  const env = {};
  for (const key of SYSTEM_ENV)
    if (base2[key] !== void 0) env[key] = base2[key];
  for (const [key, value] of Object.entries(base2))
    if (key.startsWith("LC_") && value !== void 0) env[key] = value;
  return env;
}
function parseOpenquotaRows(text6) {
  try {
    const data2 = JSON.parse(text6);
    return Array.isArray(data2) ? data2 : void 0;
  } catch {
    return void 0;
  }
}
function readOpenquotaPace(options = {}) {
  const env = options.env ?? process.env;
  return new Promise((resolve4) => {
    execFile3(
      resolveOpenquotaBin(options.bin, env),
      ["pace", "--json"],
      {
        cwd: homedir3(),
        timeout: options.timeoutMs ?? PACE_TIMEOUT_MS,
        maxBuffer: PACE_MAX_BUFFER,
        env: childEnv(env)
      },
      (error, stdout) => {
        if (error) {
          resolve4(
            error.code === "ENOENT" ? { missing: true } : { error: error.killed ? "timeout" : "failed" }
          );
          return;
        }
        const rows = parseOpenquotaRows(stdout);
        resolve4(rows ? { ok: true, rows } : { error: "parse" });
      }
    );
  });
}

// server/quota-readers/index.ts
import { execFile as execFile4 } from "node:child_process";
import { readFile as readFile3 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";

// server/quota-readers/credentials.ts
var MAX_CREDENTIAL_BYTES = 1024 * 1024;
function describeSource(source2) {
  return source2.kind === "file" ? source2.path : `\u94A5\u5319\u4E32\u300C${source2.service}\u300D`;
}
async function readSource(source2, deps) {
  if (source2.kind === "keychain")
    return deps.keychain(source2.service, source2.account);
  return deps.readFile(source2.path);
}
async function firstCredential(sources, deps, parse6) {
  let unreadable = false;
  for (const source2 of sources) {
    let text6;
    try {
      text6 = await readSource(source2, deps);
    } catch {
      unreadable = true;
      continue;
    }
    if (text6 === void 0) continue;
    if (text6.length > MAX_CREDENTIAL_BYTES) {
      unreadable = true;
      continue;
    }
    const value = parse6(text6);
    if (value === void 0) {
      unreadable = true;
      continue;
    }
    return { ok: true, value, source: source2 };
  }
  return { ok: false, unreadable };
}
function parseJsonDocument(text6) {
  try {
    return JSON.parse(text6);
  } catch {
    const trimmed = text6.trim();
    if (!trimmed || trimmed.length % 2 || !/^[0-9a-f]+$/i.test(trimmed))
      return void 0;
    try {
      return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
    } catch {
      return void 0;
    }
  }
}
function jwtExpiry(token) {
  const payload = token.split(".")[1];
  if (!payload) return void 0;
  try {
    const data2 = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    const exp = data2 && typeof data2 === "object" ? data2.exp : void 0;
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
    const text6 = await response.text();
    let body3;
    if (text6.length <= MAX_BODY_BYTES)
      try {
        body3 = JSON.parse(text6);
      } catch {
        body3 = void 0;
      }
    return { status: response.status, headers: response.headers, body: body3 };
  } catch {
    return { error: signal.aborted ? "timeout" : "network" };
  }
}
var isFailure = (reply) => "error" in reply;
var transportReason = (failure, who2) => failure.error === "timeout" ? `${who2} \u7528\u91CF\u63A5\u53E3\u8D85\u65F6` : `\u8FDE\u4E0D\u4E0A ${who2} \u7528\u91CF\u63A5\u53E3`;
function retryAfter(value, now) {
  if (!value) return void 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1e3;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(now, at) : void 0;
}
var isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function numberOf(value) {
  const number2 = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number2) ? number2 : void 0;
}
function timeOf(value) {
  if (typeof value === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    const text6 = value.trim();
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text6) ? text6 : `${text6}Z`;
    const at = Date.parse(zoned);
    return Number.isFinite(at) ? at : null;
  }
  const raw = numberOf(value);
  if (raw === void 0) return null;
  return Math.round(Math.abs(raw) < 1e10 ? raw * 1e3 : raw);
}

// server/quota-readers/paths.ts
import { createHash as createHash6 } from "node:crypto";
import { posix, win32 } from "node:path";
var pathFor = (platform) => platform === "win32" ? win32 : posix;
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
  const hash = createHash6("sha256").update(configDir.replace(/\\/g, "/")).digest("hex");
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
function parseClaudeLogin(text6) {
  const document = parseJsonDocument(text6);
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
  const plan2 = subscription.toLowerCase().split(/\s+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  const multiplier = tier?.split(/[^a-z0-9]+/i).find((part) => /^\d+x$/.test(part));
  return multiplier ? `${plan2} ${multiplier}` : plan2;
}
function percentWindow(id3, label5, percent, resets, periodSeconds) {
  const used = numberOf(percent);
  if (used === void 0) return void 0;
  return {
    id: id3,
    label: label5,
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
function mapClaudeUsage(body3) {
  if (!isObject(body3)) return void 0;
  const windows = [];
  const push = (window) => {
    if (window) windows.push(window);
  };
  for (const [key, id3, label5, period] of [
    ["five_hour", "session", "Session", 5 * HOUR],
    ["seven_day", "weekly", "Weekly", WEEK],
    ["seven_day_sonnet", "sonnet", "Sonnet", WEEK]
  ]) {
    const value = body3[key];
    if (isObject(value))
      push(
        percentWindow(id3, label5, value.utilization, value.resets_at, period)
      );
  }
  if (Array.isArray(body3.limits))
    for (const limit of body3.limits) {
      if (!isObject(limit)) continue;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      if (!kind.endsWith("_scoped")) continue;
      const scope = isObject(limit.scope) ? limit.scope : {};
      const model = isObject(scope.model) ? scope.model : {};
      const label5 = typeof model.display_name === "string" ? model.display_name.trim() : "";
      if (!label5) continue;
      const slug = label5.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join("-");
      if (!slug) continue;
      const id3 = label5 === "Fable" && kind === "weekly_scoped" ? "fable" : kind === "weekly_scoped" ? `scoped-${slug}` : `scoped-${kind.replace(/_scoped$/, "")}-${slug}`;
      const period = numberOf(limit.period_seconds);
      push(
        percentWindow(
          id3,
          label5,
          limit.percent,
          limit.resets_at,
          period !== void 0 && period >= 0 ? Math.trunc(period) : SCOPED_PERIOD[kind] ?? 0
        )
      );
    }
  return windows.length ? windows : void 0;
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
    refreshedAt: now
  };
}
var claudeReader = { provider: "claude", read: readClaude };

// server/quota-readers/codex.ts
var CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
var SESSION = 5 * 60 * 60;
var WEEK2 = 7 * 24 * 60 * 60;
function parseCodexLogin(text6) {
  const document = parseJsonDocument(text6);
  if (!isObject(document)) return void 0;
  const tokens = isObject(document.tokens) ? document.tokens : {};
  const token = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (token)
    return {
      apiKeyOnly: false,
      accessToken: token,
      accountId: typeof tokens.account_id === "string" && tokens.account_id.trim() ? tokens.account_id.trim() : null
    };
  return typeof document.OPENAI_API_KEY === "string" && document.OPENAI_API_KEY.trim() ? { apiKeyOnly: true } : void 0;
}
function codexPlan(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const lower2 = raw.toLowerCase();
  if (lower2 === "prolite") return "Pro 5x";
  if (lower2 === "pro") return "Pro 20x";
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
    const resetAt2 = timeOf(candidate.window?.reset_at);
    const after = numberOf(candidate.window?.reset_after_seconds);
    const period = numberOf(candidate.window?.limit_window_seconds);
    const [id3, label5] = ids[kind];
    windows.push({
      id: id3,
      label: label5,
      usedPercent: candidate.used,
      resetsAt: resetAt2 ?? (after === void 0 ? null : now + Math.round(after * 1e3)),
      periodSeconds: period === void 0 ? kind === "session" ? SESSION : WEEK2 : Math.max(0, Math.trunc(period))
    });
  }
  return windows;
}
function mapCodexUsage(body3, headers, now) {
  if (!isObject(body3)) return void 0;
  const header = (name2) => numberOf(headers.get(name2));
  const windows = classified(
    body3.rate_limit,
    { session: ["session", "Session"], weekly: ["weekly", "Weekly"] },
    {
      primary: header("x-codex-primary-used-percent"),
      secondary: header("x-codex-secondary-used-percent")
    },
    now
  );
  const spark = Array.isArray(body3.additional_rate_limits) ? body3.additional_rate_limits.find(
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
    refreshedAt: now
  };
}
var codexReader = { provider: "codex", read: readCodex };

// server/quota-readers/opencode.ts
var OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
function parseOpencodeKey(text6) {
  let document;
  try {
    document = JSON.parse(text6);
  } catch {
    return void 0;
  }
  if (!isObject(document)) return void 0;
  const entry = document["opencode-go"];
  const key = isObject(entry) && typeof entry.key === "string" ? entry.key : "";
  return key.trim() || null;
}
var WINDOWS = [
  ["rolling", "session", "Session", 5 * 60 * 60],
  ["weekly", "weekly", "Weekly", 7 * 24 * 60 * 60],
  ["monthly", "monthly", "Monthly", 0]
];
function mapOpencodeUsage(body3) {
  const usage11 = isObject(body3) && isObject(body3.usage) ? body3.usage : void 0;
  if (!usage11) return void 0;
  const windows = [];
  for (const [key, id3, label5, periodSeconds] of WINDOWS) {
    const value = usage11[key];
    const percent = isObject(value) ? numberOf(value.percent) : void 0;
    if (!isObject(value) || percent === void 0) return void 0;
    windows.push({
      id: id3,
      label: label5,
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
    (text6) => {
      const key = parseOpencodeKey(text6);
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
  return { ok: true, plan: "Go", windows, refreshedAt: deps.now() };
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
      entries.map(([provider2, entry]) => [
        provider2,
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
    return await readFile3(path, "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw error;
  }
}
function readKeychain(service, account, env = process.env) {
  if (process.platform !== "darwin") return Promise.resolve(void 0);
  const args2 = ["find-generic-password", "-s", service];
  if (account) args2.push("-a", account);
  args2.push("-w");
  return new Promise((resolve4, reject3) => {
    execFile4(
      SECURITY,
      args2,
      {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { PATH: env.PATH, HOME: env.HOME, USER: env.USER }
      },
      (error, stdout) => {
        if (!error) return resolve4(stdout.trim() || void 0);
        if (error.code === ITEM_NOT_FOUND) return resolve4(void 0);
        reject3(new Error("\u94A5\u5319\u4E32\u8BFB\u53D6\u5931\u8D25"));
      }
    );
  });
}
function defaultReaderDeps(env = process.env) {
  return {
    platform: currentPlatform(),
    home: env.HOME || env.USERPROFILE || homedir4(),
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
var shared;
function sharedQuotaReaders() {
  if (shared === void 0)
    shared = readersEnabled() ? new QuotaReaders(defaultReaderDeps()) : null;
  return shared;
}

// server/quota-readers/pace.ts
var SHORT_WINDOW_MAX_PERIOD_SECONDS = 6 * 60 * 60;
var STALE_AFTER_MS = 10 * 6e4;
var clampPercent = (value) => Math.min(100, Math.max(0, value));
function round1(value) {
  const scaled = value * 10;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return rounded / 10 + 0;
}
function periodElapsedPercent(window, now) {
  const used = clampPercent(window.usedPercent);
  if (Math.round(100 - used) <= 0) return null;
  if (used <= 0) return null;
  if (window.resetsAt === null) return null;
  if (window.periodSeconds === 0 || window.resetsAt <= now) return null;
  const startsAt = window.resetsAt - window.periodSeconds * 1e3;
  const elapsedSeconds = Math.max(0, now - startsAt) / 1e3;
  const progress = Math.min(
    1,
    Math.max(0, elapsedSeconds / window.periodSeconds)
  );
  if (elapsedSeconds < Math.max(window.periodSeconds * 0.01, 60)) return null;
  const projected = used / progress;
  if (projected <= 90) return progress * 100;
  if (used < 5) return null;
  return progress * 100;
}
var named = (window, needle) => window.id.toLowerCase().includes(needle) || window.label.toLowerCase().includes(needle);
function longest(windows) {
  return windows.reduce(
    (best, window) => !best || window.periodSeconds > best.periodSeconds ? window : best,
    void 0
  );
}
function comparisonWindow(windows) {
  const weekly = windows.filter((window) => named(window, "week"));
  return longest(weekly.length ? weekly : windows);
}
function shortWindow(windows) {
  const session = windows.find((window) => named(window, "session"));
  if (session) return session;
  return windows.filter(
    (window) => window.periodSeconds > 0 && window.periodSeconds <= SHORT_WINDOW_MAX_PERIOD_SECONDS
  ).reduce(
    (best, window) => !best || window.periodSeconds < best.periodSeconds ? window : best,
    void 0
  );
}
function hoursBetween(start, end) {
  return Math.trunc((end - start) / 1e3) / 3600;
}
function isoSeconds(at) {
  return new Date(Math.floor(at / 1e3) * 1e3).toISOString().replace(".000Z", "Z");
}
function paceRow(input) {
  const { windows, now } = input;
  const comparison = comparisonWindow(windows);
  const short = shortWindow(windows);
  const elapsed = comparison ? periodElapsedPercent(comparison, now) : null;
  return {
    providerId: input.providerId,
    plan: input.plan,
    windowId: comparison?.id ?? null,
    windowLabel: comparison?.label ?? null,
    usedPercent: comparison ? round1(clampPercent(comparison.usedPercent)) : null,
    periodElapsedPercent: elapsed === null ? null : round1(elapsed),
    sparePercent: comparison && elapsed !== null ? round1(elapsed - clampPercent(comparison.usedPercent)) : null,
    hoursToReset: comparison?.resetsAt != null ? round1(hoursBetween(now, comparison.resetsAt)) : null,
    shortWindowId: short?.id ?? null,
    shortWindowUsedPercent: short ? round1(clampPercent(short.usedPercent)) : null,
    refreshedAt: isoSeconds(input.refreshedAt),
    refreshedHoursAgo: round1(
      Math.max(0, hoursBetween(input.refreshedAt, now))
    ),
    stale: now - input.refreshedAt >= STALE_AFTER_MS
  };
}

// server/quota-readers/merge.ts
var NO_DATA = "\u6CA1\u6709\u989D\u5EA6\u6570\u636E";
function providerOf(row3) {
  if (!row3 || typeof row3 !== "object") return void 0;
  const id3 = row3.providerId;
  return typeof id3 === "string" && id3 ? id3 : void 0;
}
var hasQuotaData = (row3) => row3.source === "openquota" || row3.source === "builtin" && typeof row3.refreshedAt === "string";
var empty = (providerId, source2, note) => ({ providerId, source: source2, note });
function mergeQuotaRows(input) {
  const fromOpenquota = /* @__PURE__ */ new Map();
  for (const row3 of input.openquota ?? []) {
    const provider2 = providerOf(row3);
    if (provider2 && !fromOpenquota.has(provider2))
      fromOpenquota.set(provider2, row3);
  }
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [providerId, outcome] of input.builtin) {
    seen.add(providerId);
    if (outcome.ok) {
      rows.push({
        ...paceRow({
          providerId,
          plan: outcome.result.plan,
          windows: outcome.result.windows,
          refreshedAt: outcome.result.refreshedAt,
          now: input.now
        }),
        source: "builtin",
        note: outcome.note
      });
      continue;
    }
    const fallback = fromOpenquota.get(providerId);
    rows.push(
      fallback ? {
        ...fallback,
        providerId,
        source: "openquota",
        note: `\u81EA\u5E26\u8BFB\u4E0D\u5230\uFF1A${outcome.reason}`
      } : empty(providerId, "builtin", `\u8BFB\u4E0D\u5230\uFF1A${outcome.reason}`)
    );
  }
  for (const [providerId, row3] of fromOpenquota) {
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    rows.push({ ...row3, providerId, source: "openquota", note: null });
  }
  for (const providerId of input.expected ?? []) {
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    rows.push(empty(providerId, null, NO_DATA));
  }
  return rows;
}

// server/tasks/quota-source.ts
var OPENQUOTA_FAILURE = {
  timeout: "\u8BFB\u53D6 OpenQuota \u989D\u5EA6\u8D85\u65F6",
  parse: "OpenQuota \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790",
  failed: "\u8BFB\u53D6 OpenQuota \u989D\u5EA6\u5931\u8D25"
};
var EXPECTED_PROVIDERS = [
  ...new Set(Object.values(ADAPTERS).map((adapter) => adapter.quotaProvider))
];
async function readQuotaRows(options = {}) {
  const { readers: given2, now = Date.now, ...openquota } = options;
  const readers = given2 === void 0 ? sharedQuotaReaders() : given2;
  const [builtin, pace] = await Promise.all([
    readers ? readers.read() : Promise.resolve(/* @__PURE__ */ new Map()),
    readOpenquotaPace(openquota)
  ]);
  const notes2 = "error" in pace ? [OPENQUOTA_FAILURE[pace.error]] : [];
  return {
    rows: mergeQuotaRows({
      builtin,
      openquota: "ok" in pace ? pace.rows : void 0,
      expected: EXPECTED_PROVIDERS,
      now: now()
    }),
    notes: notes2
  };
}

// server/tasks/budget.ts
var DEFAULT_QUOTA_RESERVE_PERCENT = 20;
function quotaReserve(db, nodeId) {
  const fallback = { percent: DEFAULT_QUOTA_RESERVE_PERCENT, set_by: null };
  if (!db || !one2(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_boundaries'"
  ))
    return fallback;
  const list4 = nodes(db);
  const root = list4.find((n) => n.parent_id === null);
  if (!root) return fallback;
  const node = list4.find((n) => n.id === nodeId) ?? root;
  const owned = allBoundaries(db);
  const chain = [
    ...chainLevels(list4, owned, node.parent_id),
    { node: node.id, name: node.name, entries: owned.get(node.id) ?? [] }
  ];
  const found = effective(chain).filter((e) => e.param?.key === "quota_reserve_percent").sort((a, b) => b.param.value - a.param.value)[0];
  return found ? { percent: found.param.value, set_by: ref(found.set_by) } : fallback;
}
function readQuotaReservePercent(db, nodeId) {
  return quotaReserve(db, nodeId).percent;
}
function overReserve(usedPercent, reservePercent) {
  return usedPercent !== null && usedPercent !== void 0 && usedPercent >= 100 - reservePercent;
}

// server/tasks/idle-first.ts
function idleFirst(ranked, busy) {
  if (!busy?.size) return [...ranked];
  const waits = (tool) => ADAPTERS[tool].exclusive && busy.has(tool);
  return [...ranked.filter((tool) => !waits(tool)), ...ranked.filter(waits)];
}

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
var bad3 = (field2, message4) => {
  throw new Problem(400, `${field2} ${message4}`, "usage");
};
var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validateSkillSlug(value) {
  if (typeof value !== "string" || value.length > 64 || !SLUG_RE.test(value))
    return bad3("slug", "\u53EA\u80FD\u7528\u5C0F\u5199\u82F1\u6570\u548C\u5355\u4E2A\u8FDE\u5B57\u7B26\uFF0C\u957F\u5EA6 1\u201364\uFF0C\u5982 web-design");
  return value;
}
var SEGMENT2 = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
function validateFilePath(path) {
  const segments = path.split("/");
  if (!path || segments.length > LIMITS.depth || segments.some((seg) => !SEGMENT2.test(seg) || seg.length > 100))
    return bad3(
      `files.${path || "\uFF08\u7A7A\uFF09"}`,
      `\u8DEF\u5F84\u4E0D\u5408\u6CD5\uFF1A\u53EA\u80FD\u662F\u6280\u80FD\u76EE\u5F55\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u6BB5\u540D\u7528\u82F1\u6570\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u6216\u8FDE\u5B57\u7B26\uFF0C\u4E0D\u4EE5\u70B9\u5F00\u5934\uFF0C\u6700\u591A ${LIMITS.depth} \u5C42`
    );
  return path;
}
function validateFiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return bad3("files", "\u5E94\u4E3A {\u76F8\u5BF9\u8DEF\u5F84: \u6587\u672C}");
  const entries = Object.entries(value);
  if (!entries.some(([path]) => path === "SKILL.md"))
    return bad3("files", "\u7F3A\u5C11 SKILL.md");
  if (entries.length > LIMITS.files)
    return bad3("files", `\u8D85\u8FC7 ${LIMITS.files} \u4E2A\u6587\u4EF6`);
  let total = 0;
  const out = {};
  for (const [path, content] of entries.sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  )) {
    validateFilePath(path);
    if (typeof content !== "string" || content.includes("\0"))
      return bad3(`files.${path}`, "\u5E94\u4E3A\u6587\u672C\u6587\u4EF6");
    total += Buffer.byteLength(content, "utf8");
    out[path] = content;
  }
  if (total > LIMITS.bytes)
    return bad3("files", `\u5408\u8BA1 ${total} \u5B57\u8282\uFF0C\u8D85\u8FC7 ${LIMITS.bytes / 1024} KB`);
  return out;
}
function readFrontmatter(skillMd) {
  const source2 = skillMd.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!source2.startsWith("---\n")) return null;
  const end = source2.indexOf("\n---", 4);
  if (end < 0) return bad3("SKILL.md", "frontmatter \u7F3A\u5C11\u7ED3\u5C3E ---");
  try {
    const parsed = YAML.parseDocument(source2.slice(4, end), {
      uniqueKeys: true
    });
    if (parsed.errors.length) return bad3("SKILL.md", "frontmatter \u683C\u5F0F\u9519\u8BEF");
    const data2 = parsed.toJS({ maxAliasCount: 100 }) ?? {};
    if (typeof data2 !== "object" || Array.isArray(data2))
      return bad3("SKILL.md", "frontmatter \u5E94\u4E3A\u952E\u503C\u5BF9");
    return data2;
  } catch (error) {
    if (error instanceof Problem) throw error;
    return bad3("SKILL.md", "frontmatter \u683C\u5F0F\u9519\u8BEF");
  }
}
function skillMeta(slug, files, description) {
  const front = readFrontmatter(files["SKILL.md"]);
  if (!front) {
    const text7 = description?.trim();
    if (!text7)
      return bad3(
        "description",
        "\u5FC5\u586B\uFF1ASKILL.md \u6CA1\u6709 frontmatter \u65F6\u987B\u7528 --description \u7ED9\u51FA\u4E00\u53E5\u7B80\u4ECB"
      );
    checkDescription(text7);
    const header = YAML.stringify(
      { name: slug, description: text7 },
      { lineWidth: 0 }
    );
    return {
      files: {
        ...files,
        "SKILL.md": `---
${header}---

${files["SKILL.md"]}`
      },
      description: text7
    };
  }
  if (front.name !== slug)
    return bad3(
      "SKILL.md",
      `frontmatter \u7684 name \u5E94\u4E3A ${slug}\uFF08\u4E0E\u6280\u80FD slug \u4E00\u81F4\uFF09\uFF0C\u73B0\u5728\u662F ${front.name === void 0 ? "\uFF08\u7A7A\uFF09" : String(front.name)}`
    );
  const text6 = typeof front.description === "string" ? front.description.trim() : "";
  if (!text6) return bad3("SKILL.md", "frontmatter \u7F3A\u5C11 description");
  if (description?.trim() && description.trim() !== text6)
    return bad3(
      "description",
      "\u4E0E SKILL.md frontmatter \u91CC\u7684 description \u4E0D\u4E00\u81F4\uFF1B\u6539 SKILL.md \u5373\u53EF"
    );
  checkDescription(text6);
  return { files, description: text6 };
}
function checkDescription(text6) {
  if (Array.from(text6).length > LIMITS.description)
    bad3("description", `\u8D85\u8FC7 ${LIMITS.description} \u5B57`);
}
function sameFiles(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((key) => a[key] === b[key]);
}
var listOf = (value) => (Array.isArray(value) ? value : value === void 0 ? [] : [value]).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
function chainHit(chain, address) {
  const text6 = address.trim().replace(/^\/+|\/+$/g, "");
  return chain.find((node) => node.ref === text6 || node.path === text6);
}
function effectiveSkills(input) {
  const max = input.max ?? LIMITS.perTask;
  const order = [];
  for (const node of input.chain)
    for (const slug of input.bound.get(node.id) ?? [])
      order.push({ slug, via: `${node.ref} ${node.path}` });
  for (const slug of listOf(input.profile?.skills))
    order.push({ slug, via: "\u6267\u884C\u8005\u6863\u6848" });
  const scoped2 = input.profile?.skills_for;
  if (scoped2 && typeof scoped2 === "object" && !Array.isArray(scoped2))
    for (const [address, slugs] of Object.entries(scoped2)) {
      const hit2 = chainHit(input.chain, address);
      if (hit2)
        for (const slug of listOf(slugs))
          order.push({ slug, via: `\u6267\u884C\u8005\u6863\u6848\uFF08\u505A ${hit2.path} \u7684\u6D3B\uFF09` });
    }
  const seen = /* @__PURE__ */ new Set();
  const unknown = [];
  const picked = [];
  const dropped = [];
  for (const item of order) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    if (!input.known.has(item.slug)) {
      unknown.push(item.slug);
      continue;
    }
    (picked.length < max ? picked : dropped).push(item);
  }
  return { picked, dropped, unknown };
}
function avoidReason(chain, avoid) {
  for (const address of listOf(avoid)) {
    const hit2 = chainHit(chain, address);
    if (hit2) return `\u6863\u6848 avoid_nodes \u907F\u5F00 ${hit2.ref} ${hit2.path}`;
  }
  return void 0;
}
var LCS_CELLS = 4e6;
function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > LCS_CELLS) return void 0;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i2 = n - 1; i2 >= 0; i2--)
    for (let j2 = m - 1; j2 >= 0; j2--)
      dp[i2 * w + j2] = a[i2] === b[j2] ? dp[(i2 + 1) * w + j2 + 1] + 1 : Math.max(dp[(i2 + 1) * w + j2], dp[i2 * w + j2 + 1]);
  const pairs = /* @__PURE__ */ new Map();
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.set(i++, j++);
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}
var lines = (text6) => text6.split("\n");
function lineDiff(before, after, context2 = 2) {
  const a = lines(before), b = lines(after);
  const pairs = lcsPairs(a, b);
  const out = [];
  if (!pairs) {
    out.push(...a.map((text6) => ({ mark: "-", text: text6 })));
    out.push(...b.map((text6) => ({ mark: "+", text: text6 })));
  } else {
    let i = 0, j = 0;
    for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
      while (i < pi) out.push({ mark: "-", text: a[i++] });
      while (j < pj) out.push({ mark: "+", text: b[j++] });
      if (i < a.length && j < b.length) {
        out.push({ mark: " ", text: a[i] });
        i++;
        j++;
      }
    }
  }
  const keep = out.map(
    (line, index2) => out.slice(Math.max(0, index2 - context2), index2 + context2 + 1).some((near) => near.mark !== " ")
  );
  const result = [];
  out.forEach((line, index2) => {
    if (keep[index2]) result.push(`${line.mark} ${line.text}`);
    else if (keep[index2 - 1] || index2 === 0) result.push("\u2026");
  });
  return result;
}
function filesDiff(before, after) {
  const paths = [
    .../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])
  ].sort();
  const out = [];
  for (const path of paths) {
    const a = before[path], b = after[path];
    if (a === b) continue;
    if (a === void 0)
      out.push(`\u65B0\u589E ${path}`, ...lines(b).map((line) => `+ ${line}`));
    else if (b === void 0)
      out.push(`\u5220\u9664 ${path}`, ...lines(a).map((line) => `- ${line}`));
    else out.push(`\u4FEE\u6539 ${path}`, ...lineDiff(a, b));
  }
  return out;
}
var same = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);
function merge3Text(base2, ours, theirs) {
  const b = lines(base2), o = lines(ours), t = lines(theirs);
  const mo = lcsPairs(b, o), mt = lcsPairs(b, t);
  if (!mo || !mt)
    return ours === base2 ? { text: theirs, conflict: false } : theirs === base2 || theirs === ours ? { text: ours, conflict: false } : { text: ours, conflict: true };
  const out = [];
  let conflict = false;
  let i = 0, j = 0, k = 0;
  while (i < b.length || j < o.length || k < t.length) {
    let next = i;
    while (next < b.length && !(mo.has(next) && mt.has(next))) next++;
    const oEnd = next < b.length ? mo.get(next) : o.length;
    const tEnd = next < b.length ? mt.get(next) : t.length;
    if (next === i && oEnd === j && tEnd === k) {
      if (i >= b.length) break;
      out.push(b[i]);
      i++;
      j++;
      k++;
      continue;
    }
    const bs = b.slice(i, next), os = o.slice(j, oEnd), ts = t.slice(k, tEnd);
    if (same(os, bs)) out.push(...ts);
    else if (same(ts, bs) || same(os, ts)) out.push(...os);
    else {
      conflict = true;
      out.push(...os);
    }
    i = next;
    j = oEnd;
    k = tEnd;
  }
  return { text: out.join("\n"), conflict };
}
function mergeFiles(base2, ours, theirs) {
  const paths = [
    .../* @__PURE__ */ new Set([
      ...Object.keys(base2),
      ...Object.keys(ours),
      ...Object.keys(theirs)
    ])
  ].sort();
  const files = {};
  const conflicts = [];
  for (const path of paths) {
    const b = base2[path], o = ours[path], t = theirs[path];
    let value;
    if (o === t || t === b) value = o;
    else if (o === b) value = t;
    else if (b === void 0 || o === void 0 || t === void 0) {
      conflicts.push(path);
      value = o;
    } else {
      const merged = merge3Text(b, o, t);
      if (merged.conflict) conflicts.push(path);
      value = merged.text;
    }
    if (value !== void 0) files[path] = value;
  }
  return { files, conflicts };
}

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
function buildPrompt({
  title: title2,
  brief: brief2,
  tells,
  roleDoc,
  charter,
  concerns,
  originDoc,
  skills,
  rootDoc,
  profileBody,
  rules = DEFAULT_RULES
}) {
  const heading = title2.trim();
  if (!heading) throw invalid("\u4EFB\u52A1\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
  const sections = [
    ["\u4EFB\u52A1\u8BE6\u8FF0", brief2],
    ["\u8FD0\u884C\u4E2D\u6536\u5230\u7684\u8865\u5145", tells],
    ["\u5C97\u4F4D\u8BF4\u660E", roleDoc],
    ...charter ? [[charter.heading, charter.text]] : [],
    ["\u8BF7\u4E86\u7684\u4E13\u5458\u4E0E\u68C0\u67E5\u8981\u70B9", concerns],
    ["\u6295\u4EFB\u52A1\u7684\u4E13\u5458\u8BF4\u660E", originDoc],
    ["\u672C\u6B21\u6302\u8F7D\u7684\u6280\u80FD", skills],
    ["\u7EC4\u7EC7\u8BF4\u660E\uFF08.agents/README.md\uFF09", rootDoc],
    ["\u7ED9\u4F60\u7684\u989D\u5916\u53EE\u5631", profileBody],
    ["\u901A\u7528\u7EA6\u675F", rules.map((rule) => `- ${rule}`).join("\n")]
  ];
  const parts = [`# \u4EFB\u52A1\uFF1A${heading}`];
  for (const [name2, text6] of sections)
    if (text6?.trim()) parts.push(`## ${name2}

${text6.trim()}`);
  return `${parts.join("\n\n")}
`;
}
async function readIfExists(file) {
  try {
    return await readFile4(file, "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR")
      return void 0;
    throw error;
  }
}
async function loadRoleDocs(repo, node) {
  if (!isAbsolute5(repo)) throw invalid("\u4ED3\u5E93\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  const rootDoc = await readIfExists(join11(repo, ".agents", "README.md")) ?? "";
  return node ? { roleDoc: node.body, rootDoc, rolePath: node.ref } : { roleDoc: "", rootDoc };
}
async function readPace(bin, timeoutMs = 1e4, source2 = {}) {
  const { rows } = await readQuotaRows({ ...source2, bin, timeoutMs });
  const entries = parsePaceRows(rows.filter(hasQuotaData));
  return entries.length ? entries : void 0;
}
function parsePaceRows(data2) {
  const entries = [];
  for (const item of data2) {
    if (!item || typeof item !== "object") continue;
    const { providerId, sparePercent, usedPercent, windowId, hoursToReset } = item;
    if (typeof providerId !== "string") continue;
    entries.push({
      providerId,
      sparePercent: typeof sparePercent === "number" && Number.isFinite(sparePercent) ? sparePercent : null,
      usedPercent: typeof usedPercent === "number" && Number.isFinite(usedPercent) ? usedPercent : null,
      windowId: typeof windowId === "string" ? windowId : null,
      ...typeof hoursToReset === "number" && Number.isFinite(hoursToReset) && hoursToReset > 0 ? { hoursToReset } : {}
    });
  }
  return entries;
}
function spareByProvider(pace) {
  const spare = /* @__PURE__ */ new Map();
  for (const { providerId, sparePercent } of pace) {
    if (sparePercent === null) continue;
    const prev = spare.get(providerId);
    spare.set(
      providerId,
      prev === void 0 ? sparePercent : Math.min(prev, sparePercent)
    );
  }
  return spare;
}
var FALLBACK_ORDER = [
  "claude",
  "codex",
  "opencode",
  "grok",
  "kimi"
];
function pickWorker({
  installed,
  pace,
  risk,
  profiles,
  held,
  reservePercent = DEFAULT_QUOTA_RESERVE_PERCENT,
  headroom,
  busy,
  exclude,
  requireTrust,
  chain,
  jobRef
}) {
  if (!RISKS.includes(risk))
    throw invalid(`risk \u53EA\u80FD\u662F ${RISKS.join("\u3001")}`);
  const have = new Set(
    Symbol.iterator in installed ? installed : Object.keys(installed).filter(
      (tool) => installed[tool]
    )
  );
  const skipped2 = [];
  const eligible = [];
  for (const tool of FALLBACK_ORDER) {
    if (!have.has(tool)) {
      skipped2.push({ tool, reason: "\u6CA1\u88C5" });
      continue;
    }
    if (exclude?.has(tool)) {
      skipped2.push({ tool, reason: "\u521A\u56E0\u4E34\u65F6\u9519\u8BEF\u5931\u8D25\uFF0C\u8FD9\u6B21\u6362\u522B\u7684" });
      continue;
    }
    const max = profiles[tool]?.rules.max_risk;
    if (max && RISKS.indexOf(max) < RISKS.indexOf(risk)) {
      skipped2.push({
        tool,
        reason: `\u6863\u6848 max_risk=${max}\uFF0C\u4F4E\u4E8E\u4EFB\u52A1 risk=${risk}`
      });
      continue;
    }
    const jobAvoid = profiles[tool]?.rules.avoid_jobs;
    if (jobRef && Array.isArray(jobAvoid) && jobAvoid.includes(jobRef)) {
      skipped2.push({ tool, reason: `\u6863\u6848 avoid_jobs \u907F\u5F00\u4E13\u5458 ${jobRef}` });
      continue;
    }
    const avoided = chain?.length && avoidReason(chain, profiles[tool]?.rules.avoid_nodes);
    if (avoided) {
      skipped2.push({ tool, reason: avoided });
      continue;
    }
    const trust = requireTrust && trustRefusal(tool, profiles[tool]?.rules.trust, risk);
    if (trust) {
      skipped2.push({ tool, reason: trust });
      continue;
    }
    const heldUntil = held?.get(ADAPTERS[tool].quotaProvider);
    if (heldUntil !== void 0) {
      skipped2.push({ tool, reason: `\u989D\u5EA6\u7528\u5C3D\u81F3 ${clock(heldUntil)}` });
      continue;
    }
    const used = pace?.filter((entry) => entry.providerId === ADAPTERS[tool].quotaProvider).find((entry) => overReserve(entry.usedPercent, reservePercent));
    if (used) {
      skipped2.push({
        tool,
        reason: `\u5DF2\u7528\u989D\u5EA6 ${used.usedPercent}% \u8FBE\u5230\u7AE0\u7A0B\u4E0A\u9650 ${100 - reservePercent}%\uFF08\u987B\u7559 ${reservePercent}% \u7ED9\u7528\u6237\uFF09`
      });
      continue;
    }
    const room = headroom?.get(ADAPTERS[tool].quotaProvider);
    if (pace && room && room.points < 1) {
      skipped2.push({ tool, reason: room.reason });
      continue;
    }
    if (profiles[tool]?.rules.billing === "metered") {
      skipped2.push({ tool, reason: "\u6863\u6848 billing=metered\uFF0C\u5F53\u524D\u94B1\u4EFD\u989D\u4E3A 0 \u5143" });
      continue;
    }
    eligible.push(tool);
  }
  if (!eligible.length)
    return {
      ok: false,
      reason: "\u6CA1\u6709\u53EF\u7528\u7684\u6267\u884C\u8005\uFF1A\u90FD\u6CA1\u88C5\u3001\u6863\u6848\u4E0D\u5141\u8BB8\u8BE5\u98CE\u9669\u3001\u989D\u5EA6\u7528\u5C3D\u6216\u89E6\u53CA\u7AE0\u7A0B\u4FDD\u7559\u989D",
      skipped: skipped2
    };
  if (!pace) {
    const order2 = idleFirst(eligible, busy);
    return {
      ok: true,
      tool: order2[0],
      basis: "fallback",
      skipped: skipped2,
      available: order2
    };
  }
  const spare = spareByProvider(pace);
  const ranked = eligible.map((tool, order2) => ({
    tool,
    order: order2,
    spare: spare.get(ADAPTERS[tool].quotaProvider)
  })).sort(
    (a, b) => a.spare === void 0 || b.spare === void 0 ? a.spare === b.spare ? a.order - b.order : a.spare === void 0 ? 1 : -1 : b.spare - a.spare || a.order - b.order
  );
  const order = idleFirst(
    ranked.map((entry) => entry.tool),
    busy
  );
  const spareOf = spare.get(ADAPTERS[order[0]].quotaProvider);
  return {
    ok: true,
    tool: order[0],
    spare: spareOf,
    basis: spareOf === void 0 ? "fallback" : "pace",
    skipped: skipped2,
    available: order
  };
}
var SLUG_MAX = 40;
function slugBase(text6) {
  return text6.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX).replace(/-+$/, "");
}
function worktreePlan(repo, taskId, title2, role) {
  if (!isAbsolute5(repo)) throw invalid("\u4ED3\u5E93\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  if (!Number.isSafeInteger(taskId) || taskId <= 0)
    throw invalid("\u4EFB\u52A1\u7F16\u53F7\u4E0D\u5408\u6CD5");
  const base2 = repo.length > 1 ? repo.replace(new RegExp(`\\${sep2}+$`), "") : repo;
  const slug = slugBase(title2) || slugBase(role ?? "") || "task";
  return {
    path: `${base2}-t${taskId}-${slug}`,
    branch: `task-t${taskId}-${slug}`,
    slug
  };
}

// server/org/shares.ts
var provider = /^[a-z][a-z0-9-]{0,79}$/;
function parseShares(value) {
  const problems = [];
  const entries = [];
  const bad5 = (field2, message4) => problems.push({ field: field2, message: message4 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { entries, problems: [{ field: "budget", message: "\u5E94\u4E3A\u5BF9\u8C61" }] };
  const source2 = value;
  for (const [dim, raw] of Object.entries(source2)) {
    if (dim === "quota") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        bad5("budget.quota", "\u5E94\u4E3A\u8D26\u53F7\u5230\u767E\u5206\u70B9\u7684\u6620\u5C04");
        continue;
      }
      for (const [scope, amount] of Object.entries(raw)) {
        const field2 = `budget.quota.${scope}`;
        if (scope !== "*" && !provider.test(scope)) bad5(field2, "\u8D26\u53F7\u540D\u4E0D\u5408\u6CD5");
        else if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 100)
          bad5(field2, "\u5E94\u4E3A 0 \u5230 100 \u7684\u6570\u5B57");
        else entries.push({ dim: "quota", scope, amount });
      }
    } else if (dim === "disk" || dim === "money") {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
        bad5(`budget.${dim}`, "\u5E94\u4E3A\u975E\u8D1F\u6570\u5B57");
      else entries.push({ dim, scope: "", amount: raw });
    } else bad5(`budget.${dim}`, "\u662F\u672A\u77E5\u5B57\u6BB5");
  }
  if (entries.length > 40) bad5("budget", "\u8D85\u8FC7 40 \u4E2A\u4EFD\u989D\u6761\u76EE");
  return { entries, problems };
}
function exportShares(entries) {
  const quota = {};
  const out = {};
  for (const entry of entries) {
    if (entry.dim === "quota") quota[entry.scope] = entry.amount;
    else out[entry.dim] = entry.amount;
  }
  if (Object.keys(quota).length) out.quota = quota;
  return out;
}
function ownAmount(shares, dim, scope) {
  return shares.find((s) => s.dim === dim && s.scope === scope)?.amount ?? (dim === "quota" ? shares.find((s) => s.dim === dim && s.scope === "*")?.amount : void 0);
}
function shareCapacity(nodes2, id3, dim, scope, rootLimit) {
  const node = nodes2.find((n) => n.id === id3);
  if (!node) return void 0;
  if (node.parent === null) {
    const limit = dim === "quota" ? rootLimit.quota : dim === "money" ? rootLimit.money : void 0;
    const own2 = ownAmount(node.shares, dim, scope);
    return limit === void 0 ? own2 : own2 === void 0 ? limit : Math.min(limit, own2);
  }
  const parent = nodes2.find((n) => n.id === node.parent);
  const cap2 = shareCapacity(nodes2, parent.id, dim, scope, rootLimit);
  const own = ownAmount(node.shares, dim, scope);
  if (own !== void 0) return own;
  if (cap2 === void 0) return void 0;
  const allocated = nodes2.filter((n) => n.parent === parent.id).reduce(
    (sum, sibling) => sum + (ownAmount(sibling.shares, dim, scope) ?? 0),
    0
  );
  return Math.max(0, cap2 - allocated);
}
function checkShares(nodes2, rootLimit, knownProviders = []) {
  const problems = [];
  const scopes = /* @__PURE__ */ new Set(["*", ...knownProviders]);
  for (const node of nodes2)
    for (const share of node.shares)
      if (share.dim === "quota") scopes.add(share.scope);
  for (const parent of nodes2) {
    const children = nodes2.filter((n) => n.parent === parent.id);
    for (const dim of ["quota", "disk", "money"]) {
      for (const scope of dim === "quota" ? scopes : [""]) {
        const cap2 = shareCapacity(nodes2, parent.id, dim, scope, rootLimit);
        if (cap2 === void 0) continue;
        const allocated = children.map((n) => ({ node: n, amount: ownAmount(n.shares, dim, scope) })).filter(
          (e) => e.amount !== void 0
        );
        const sum = allocated.reduce((total, e) => total + e.amount, 0);
        if (sum > cap2 + 1e-9)
          problems.push({
            field: `budget.${dim}${dim === "quota" ? `.${scope}` : ""}`,
            message: `o${parent.id} ${parent.name} \u53EF\u5206\u914D ${cap2}\uFF0C\u5B50\u8282\u70B9\u5408\u8BA1 ${sum}\uFF08${allocated.map((e) => `o${e.node.id} ${e.node.name} ${e.amount}`).join("\u3001")}\uFF09\uFF0C\u8D85\u51FA ${Number((sum - cap2).toFixed(9))}`
          });
      }
    }
    if (parent.parent === null) {
      for (const scope of scopes) {
        const amount = ownAmount(parent.shares, "quota", scope);
        if (amount !== void 0 && amount > rootLimit.quota)
          problems.push({
            field: `budget.quota.${scope}`,
            message: `\u6839\u8282\u70B9\u6700\u591A\u53EF\u5206\u914D ${rootLimit.quota}`
          });
      }
      const money = ownAmount(parent.shares, "money", "");
      if (money !== void 0 && money > rootLimit.money)
        problems.push({
          field: "budget.money",
          message: `\u6839\u8282\u70B9\u6700\u591A\u53EF\u5206\u914D ${rootLimit.money} \u5143`
        });
    }
  }
  return problems;
}

// server/org/share-store.ts
function allShares(db) {
  const map = /* @__PURE__ */ new Map();
  const rows = all2(
    db,
    "SELECT node_id,dim,scope,amount FROM org_budgets ORDER BY node_id,dim,scope LIMIT 20001"
  );
  if (rows.length > 2e4) throw new Problem(409, "\u7EC4\u7EC7\u4EFD\u989D\u8D85\u8FC7 20000 \u6761");
  for (const row3 of rows)
    map.set(row3.node_id, [
      ...map.get(row3.node_id) ?? [],
      { dim: row3.dim, scope: row3.scope, amount: row3.amount }
    ]);
  return map;
}
function ownShares(db, id3) {
  const rows = all2(
    db,
    "SELECT node_id,dim,scope,amount FROM org_budgets WHERE node_id=? ORDER BY dim,scope LIMIT 41",
    id3
  );
  if (rows.length > 40) throw new Problem(409, `${ref(id3)} \u7684\u4EFD\u989D\u8D85\u8FC7 40 \u6761`);
  return rows.map(({ dim, scope, amount }) => ({ dim, scope, amount }));
}
function saveShares(db, id3, entries) {
  db.prepare("DELETE FROM org_budgets WHERE node_id=?").run(id3);
  const insert = db.prepare(
    "INSERT INTO org_budgets(node_id,dim,scope,amount) VALUES(?,?,?,?)"
  );
  for (const entry of entries)
    insert.run(id3, entry.dim, entry.scope, entry.amount);
}
function rootLimits(db, list4) {
  const root = list4.find((n) => n.parent_id === null);
  if (!root) return { quota: 80, money: 0 };
  const boundary = allBoundaries(db);
  const values2 = effective([
    ...chainLevels(list4, boundary, root.parent_id),
    { node: root.id, name: root.name, entries: boundary.get(root.id) ?? [] }
  ]);
  const number2 = (key, fallback) => {
    const found = values2.filter((item) => item.param?.key === key).map((item) => item.param.value);
    return found.length ? key === "money_yuan_max" ? Math.min(...found) : Math.max(...found) : fallback;
  };
  return {
    quota: 100 - number2("quota_reserve_percent", 20),
    money: number2("money_yuan_max", 0)
  };
}
function planShares(db, node, proposed, newParent) {
  const parsed = parseShares(proposed);
  if (parsed.problems.length) reject2(node, parsed.problems);
  const list4 = nodes(db);
  const owned = allShares(db);
  owned.set(node.id, parsed.entries);
  const tree2 = list4.map((n) => ({
    id: n.id,
    parent: n.id === node.id && newParent !== void 0 ? newParent : n.parent_id,
    name: n.name,
    shares: owned.get(n.id) ?? []
  }));
  const problems = checkShares(tree2, rootLimits(db, list4), [
    "claude",
    "codex",
    "opencode",
    "kimi",
    "grok"
  ]);
  if (problems.length) reject2(node, problems);
  return parsed.entries;
}
function checkStoredShares(db, node, newParent) {
  const owned = allShares(db);
  const list4 = nodes(db);
  const tree2 = list4.map((n) => ({
    id: n.id,
    parent: n.id === node.id && newParent !== void 0 ? newParent : n.parent_id,
    name: n.name,
    shares: owned.get(n.id) ?? []
  }));
  const problems = checkShares(tree2, rootLimits(db, list4), [
    "claude",
    "codex",
    "opencode",
    "kimi",
    "grok"
  ]);
  if (problems.length) reject2(node, problems);
}
function reject2(node, problems) {
  throw new Problem(
    400,
    `\u62D2\u7EDD\u4FEE\u6539 ${ref(node.id)} ${node.name} \u7684\u4EFD\u989D\uFF1A
${problems.map((p3) => `- ${p3.field}\uFF1A${p3.message}`).join("\n")}`,
    "usage",
    void 0,
    `atrium org show ${ref(node.id)}`
  );
}

// server/tasks/usage-budget.ts
function quotaHeadroom(db, nodeId, pace, reserve, now = Date.now()) {
  const result = /* @__PURE__ */ new Map();
  if (!pace) return result;
  if (nodeId === null) {
    for (const entry of pace)
      if (entry.usedPercent !== null && entry.usedPercent !== void 0) {
        const room = {
          points: 100 - reserve - entry.usedPercent,
          reason: `\u8D26\u53F7 ${entry.providerId} \u5DF2\u7528 ${entry.usedPercent}%\uFF0C\u987B\u7ED9\u7528\u6237\u4FDD\u7559 ${reserve}%`
        };
        const previous = result.get(entry.providerId);
        if (!previous || room.points < previous.points)
          result.set(entry.providerId, room);
      }
    return result;
  }
  const list4 = nodes(db);
  const shares = allShares(db);
  let current2 = list4.find((n) => n.id === nodeId);
  const chain = [];
  while (current2) {
    chain.push(current2);
    current2 = list4.find((n) => n.id === current2.parent_id);
  }
  const descendants = (id3) => {
    const found = [id3];
    for (let i = 0; i < found.length; i++)
      for (const child of list4.filter((n) => n.parent_id === found[i]))
        found.push(child.id);
    return found;
  };
  for (const entry of pace) {
    if (entry.usedPercent === null || entry.usedPercent === void 0) continue;
    const reset = resetAt(entry, now);
    let points = 100 - reserve - entry.usedPercent;
    let reason = `\u8D26\u53F7 ${entry.providerId} \u5DF2\u7528 ${entry.usedPercent}%\uFF0C\u987B\u7ED9\u7528\u6237\u4FDD\u7559 ${reserve}%`;
    if (reset !== null)
      for (const node of chain) {
        const amount = ownAmount(
          shares.get(node.id) ?? [],
          "quota",
          entry.providerId
        );
        if (amount === void 0) continue;
        const used = subtreeUsage(
          db,
          descendants(node.id),
          entry.providerId,
          reset
        );
        if (amount - used < points) {
          points = amount - used;
          reason = `${ref(node.id)} ${node.name} \u5728 ${entry.providerId} \u7684\u4EFD\u989D ${amount}\uFF0C\u672C\u7A97\u53E3\u5DF2\u7528\u7EA6 ${Number(used.toFixed(2))}`;
        }
      }
    const previous = result.get(entry.providerId);
    if (!previous || points < previous.points)
      result.set(entry.providerId, { points, reason });
  }
  return result;
}

// server/tasks/budget-problem.ts
var BudgetProblem = class extends Problem {
  constructor(message4) {
    super(409, message4, "conflict", void 0, "atrium org tree");
  }
};

// server/tasks/worker-choice.ts
async function chooseWorker(request2, options, held = /* @__PURE__ */ new Map(), avoid = {}) {
  const risk = request2.risk ?? "low";
  const path = options.env.PATH ?? "";
  let worker;
  let waitUntil;
  const reservePercent = readQuotaReservePercent(
    options.db,
    avoid.chain?.at(-1)?.id
  );
  const pace = await (options.pace ?? (() => readPace()))();
  const headroom = options.db ? quotaHeadroom(
    options.db,
    avoid.chain?.at(-1)?.id ?? null,
    pace,
    reservePercent
  ) : /* @__PURE__ */ new Map();
  if (request2.worker) {
    worker = await resolveWorker(request2.worker, options.db);
    if (!findExecutable(ADAPTERS[worker.tool].executable, path))
      throw new Problem(
        400,
        `\u6267\u884C\u8005 ${worker.tool} \u6CA1\u88C5\uFF1APATH \u4E0A\u627E\u4E0D\u5230 ${ADAPTERS[worker.tool].executable}`,
        "usage"
      );
    const account = ADAPTERS[worker.tool].quotaProvider;
    const room = headroom.get(account);
    if (pace && room && room.points < 1)
      throw new BudgetProblem(
        `\u6267\u884C\u8005 ${worker.tool} \u7684\u8D26\u53F7 ${account} \u4EFD\u989D\u4E0D\u8DB3\uFF1A${room.reason}\uFF1B\u7B49\u7A97\u53E3\u91CD\u7F6E\u6216\u8BF7\u4E0A\u5C42\u8C03\u6574\u4EFD\u989D`
      );
    if (worker.profile.rules.billing === "metered")
      throw new BudgetProblem(
        `\u6267\u884C\u8005 ${worker.tool} \u7684\u6863\u6848 billing=metered\uFF0C\u5F53\u524D\u94B1\u4EFD\u989D\u4E3A 0 \u5143`
      );
    const used = pace?.find(
      (entry) => entry.providerId === account && overReserve(entry.usedPercent, reservePercent)
    );
    if (used) {
      const installed = detectInstalled(path);
      const tools = Object.keys(installed);
      const profiles = Object.fromEntries(
        await Promise.all(
          tools.map(async (tool) => [
            tool,
            (await resolveWorker(tool, options.db)).profile
          ])
        )
      );
      const picked = pickWorker({
        installed,
        pace,
        risk,
        profiles,
        held,
        reservePercent,
        headroom
      });
      const available = picked.ok ? picked.available.filter((tool) => tool !== worker.tool) : [];
      throw new Problem(
        409,
        `\u6267\u884C\u8005 ${worker.tool} \u7684\u8D26\u53F7 ${account} \u5DF2\u7528\u989D\u5EA6 ${used.usedPercent}%\uFF0C\u8FBE\u5230\u7AE0\u7A0B\u4E0A\u9650 ${100 - reservePercent}%\uFF08\u987B\u7559 ${reservePercent}% \u7ED9\u7528\u6237\uFF09\uFF1B${available.length ? `\u53EF\u9009\u7684\u5176\u4ED6\u6267\u884C\u8005\uFF1A${available.join("\u3001")}` : "\u76EE\u524D\u6CA1\u6709\u53EF\u9009\u7684\u5176\u4ED6\u6267\u884C\u8005"}`,
        "conflict"
      );
    }
    waitUntil = held.get(ADAPTERS[worker.tool].quotaProvider);
  } else {
    const installed = detectInstalled(path);
    const tools = Object.keys(installed);
    const profiles = Object.fromEntries(
      await Promise.all(
        tools.map(async (tool) => [
          tool,
          (await resolveWorker(tool, options.db)).profile
        ])
      )
    );
    let picked = pickWorker({
      installed,
      pace,
      risk,
      profiles,
      held,
      reservePercent,
      headroom,
      ...avoid
    });
    if (!picked.ok && held.size) {
      const waiting = pickWorker({
        installed,
        pace,
        risk,
        profiles,
        reservePercent,
        headroom,
        ...avoid
      });
      if (waiting.ok) {
        picked = waiting;
        waitUntil = held.get(ADAPTERS[waiting.tool].quotaProvider);
      }
    }
    if (!picked.ok) {
      const blocked = picked.skipped.some(
        (skip) => skip.reason.includes("\u4EFD\u989D") || skip.reason.includes("billing=metered")
      );
      const message4 = `${picked.reason}\uFF08${picked.skipped.map((skip) => `${skip.tool}\uFF1A${skip.reason}`).join("\uFF1B")}\uFF09`;
      if (blocked)
        throw new BudgetProblem(`${message4}\uFF1B\u7B49\u7A97\u53E3\u91CD\u7F6E\u6216\u8BF7\u4E0A\u5C42\u8C03\u6574\u4EFD\u989D`);
      throw new Problem(409, message4, "conflict");
    }
    worker = await resolveWorker(picked.tool, options.db);
  }
  const refusal = riskRefusal(worker.id, worker.profile.rules.max_risk, risk);
  if (refusal) throw new Problem(400, refusal, "usage");
  const trust = avoid.requireTrust && trustRefusal(worker.id, worker.profile.rules.trust, risk);
  if (trust) throw new Problem(400, trust, "usage");
  return waitUntil === void 0 ? { worker, risk } : { worker, risk, waitUntil };
}

// server/skills/task-skills.ts
var hasSkills = (db) => !!one2(
  db,
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_skills'"
);
function taskChain(db, task) {
  if (!hasOrg(db)) return [];
  const node = taskNode(db, task);
  if (!node) return [];
  const list4 = nodes(db);
  const chain = [];
  let current2 = list4.find((n) => n.id === node.id);
  while (current2) {
    chain.unshift({
      id: current2.id,
      ref: ref(current2.id),
      path: nodePath(list4, current2)
    });
    const parent = current2.parent_id;
    current2 = list4.find((n) => n.id === parent);
  }
  return chain;
}
function taskAvoidChain(db, task) {
  try {
    return taskChain(db, task);
  } catch {
    return [];
  }
}
function skillsForTask(db, task, profile = {}) {
  if (!hasSkills(db)) return { skills: [], dropped: [], unknown: [] };
  const chain = taskChain(db, task);
  const bound = /* @__PURE__ */ new Map();
  if (chain.length)
    for (const row3 of all2(
      db,
      `SELECT b.node_id node_id, s.slug slug FROM org_skill_bindings b JOIN org_skills s ON s.id=b.skill_id
       WHERE s.archived_at IS NULL AND b.node_id IN (${chain.map(() => "?").join(",")})
       ORDER BY s.slug LIMIT 500`,
      ...chain.map((node) => node.id)
    ))
      bound.set(row3.node_id, [...bound.get(row3.node_id) ?? [], row3.slug]);
  const rows = all2(
    db,
    "SELECT * FROM org_skills WHERE archived_at IS NULL ORDER BY slug LIMIT 500"
  );
  const bySlug = new Map(rows.map((row3) => [row3.slug, row3]));
  const effective2 = effectiveSkills({
    chain,
    bound,
    profile,
    known: new Set(bySlug.keys())
  });
  return {
    skills: effective2.picked.map(({ slug, via }) => {
      const row3 = bySlug.get(slug);
      return {
        id: row3.id,
        slug,
        name: row3.name,
        description: row3.description,
        rev: row3.rev,
        files: JSON.parse(row3.files),
        via
      };
    }),
    dropped: effective2.dropped,
    unknown: effective2.unknown
  };
}

// server/tasks/transient-runtime.ts
var message = (error) => error instanceof Error ? error.message : String(error);
async function chooseAnother(x, ctx, active) {
  let choice;
  try {
    choice = await chooseWorker(
      { risk: active.risk },
      ctx.launchOptions,
      ctx.held(),
      {
        busy: x.busyTools(active.id),
        exclude: /* @__PURE__ */ new Set([active.tool]),
        chain: taskAvoidChain(ctx.db, getTask(ctx.db, active.id))
      }
    );
  } catch (error) {
    return { note: `\u6CA1\u6709\u53EF\u6362\u7684\u6267\u884C\u8005\uFF1A${message(error)}` };
  }
  const tool = choice.worker.tool;
  if (choice.waitUntil !== void 0)
    return {
      note: `\u53EF\u6362\u7684 ${choice.worker.id} \u989D\u5EA6\u7528\u5C3D\u81F3 ${clock(choice.waitUntil)}`
    };
  if (ADAPTERS[tool].exclusive && x.busy(tool, active.id))
    return { note: `\u53EF\u6362\u7684 ${choice.worker.id} \u6B63\u5FD9` };
  return choice;
}
async function retryAfterTransient(x, ctx, active, hit2, reason) {
  const { db } = ctx;
  const route = routeAfterTransient({
    allowed: active.worker.profile.rules.retry_on_transient !== false,
    attempts: transientAttempts(getTask(db, active.id).events)
  });
  const base2 = { reason, evidence: hit2.evidence };
  if (route.kind === "fail")
    return x.publish(active.id, "failed", { ...base2, note: route.why });
  x.launching.set(active.id, null);
  try {
    let choice;
    if (route.kind === "same")
      choice = { worker: active.worker, risk: active.risk };
    else {
      const other = await chooseAnother(x, ctx, active);
      if (x.isClosed()) return;
      if ("note" in other)
        return x.publish(active.id, "failed", {
          ...base2,
          note: `\u4E34\u65F6\u9519\u8BEF\u540E${other.note}`
        });
      choice = other;
    }
    const retry = {
      retry: route.kind,
      attempt: route.attempt,
      from: active.worker.id,
      to: choice.worker.id
    };
    noteTask(db, active.id, "transient_retry", { ...base2, ...retry });
    x.active.delete(active.id);
    x.launching.set(active.id, choice.worker.tool);
    try {
      await x.launch(active.id, choice, true);
    } catch (error) {
      if (x.isClosed()) return;
      const why = `\u4E34\u65F6\u9519\u8BEF\u540E\u91CD\u6D3E ${choice.worker.id} \u62C9\u8D77\u5931\u8D25\uFF1A${message(error)}`;
      noteTask(db, active.id, "retry_failed", { reason: why });
      return x.publish(active.id, "failed", { ...base2, note: why });
    }
    if (x.isClosed()) return;
    x.publish(active.id, "transient_retry", { ...base2, ...retry });
  } finally {
    x.launching.delete(active.id);
  }
}

// server/tasks/thinking-runtime.ts
var message2 = (error) => error instanceof Error ? error.message : String(error);
var attemptsOf = (ctx, id3) => thinkingAttempts(getTask(ctx.db, id3).events);
async function retryAfterThinking(x, ctx, active, route, decision, detail2) {
  const { db } = ctx;
  const giveUp = (note) => x.publish(active.id, decision.publish, { ...detail2, note });
  if (route.kind === "give_up") return giveUp(route.why);
  x.launching.set(active.id, null);
  try {
    const choice = await chooseAnother(x, ctx, active);
    if (x.isClosed()) return;
    if ("note" in choice) return giveUp(`\u601D\u8003\u8017\u5C3D\u540E${choice.note}`);
    const retry = {
      reason: decision.reason,
      retry: "switch",
      attempt: 1,
      from: active.worker.id,
      to: choice.worker.id
    };
    noteTask(db, active.id, "thinking_retry", retry);
    x.active.delete(active.id);
    x.launching.set(active.id, choice.worker.tool);
    try {
      await x.launch(active.id, choice, true);
    } catch (error) {
      if (x.isClosed()) return;
      const why = `\u601D\u8003\u8017\u5C3D\u540E\u6362 ${choice.worker.id} \u62C9\u8D77\u5931\u8D25\uFF1A${message2(error)}`;
      noteTask(db, active.id, "retry_failed", { reason: why });
      return giveUp(why);
    }
    if (x.isClosed()) return;
    x.publish(active.id, "thinking_retry", retry);
  } finally {
    x.launching.delete(active.id);
  }
}

// server/tasks/workspace.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join13 } from "node:path";

// server/org/brief.ts
var BRIEF_MAX = 2e3;
var chars2 = (text6) => Array.from(text6).length;
var cut = (text6, max) => Array.from(text6).slice(0, Math.max(0, max)).join("");
function formatBrief({
  chain,
  node,
  parent,
  boundaries
}) {
  const heading = `\u7AE0\u7A0B\u8981\u70B9\uFF08${chain.join(" \u2192 ")}\uFF09`;
  const more = `\u2026\uFF08\u5168\u6587\uFF1Aatrium org show ${node.ref}\uFF09`;
  const lines2 = boundaries.map(
    (e) => `- ${e.summary}${e.param ? `\uFF1A${formatParam(e.param)}` : ""}`
  );
  const tail = [
    ...lines2.length ? ["\u786C\u8FB9\u754C\uFF08\u4EFB\u4F55\u60C5\u51B5\u90FD\u4E0D\u80FD\u653E\u5F00\uFF09\uFF1A", ...lines2] : ["\u786C\u8FB9\u754C\uFF1A\u65E0"],
    `\u9884\u7B97\uFF1A\u672C\u4EFB\u52A1\u8BB0\u5728 ${node.name}\uFF08${node.ref}\uFF09\u8D26\u4E0A\u3002`,
    "\u78B0\u5230\u8FB9\u754C\u6216\u9884\u7B97\u4E0D\u591F\uFF1A\u505C\u4E0B\uFF0C\u5728\u7ED3\u679C\u91CC\u5199\u300C\u9700\u8981\u4E0A\u5C42\u51B3\u5B9A\uFF1A\u2026\u2026\u300D\uFF0C\u4E0D\u8981\u7ED5\u8FC7\u3002"
  ];
  const goalLine = (parentGoal2, ownGoal2) => {
    const parts = [
      ...parent && parentGoal2 ? [`${parent.name}\u2014\u2014${parentGoal2}`] : [],
      ...ownGoal2 ? [`${node.name}\u2014\u2014${ownGoal2}`] : []
    ];
    return parts.length ? [`\u76EE\u6807\uFF1A${parts.join("\uFF1B")}`] : [];
  };
  const assemble = (parentGoal2, ownGoal2) => [...goalLine(parentGoal2, ownGoal2), ...tail].join("\n");
  const size = (text7) => chars2(heading) + chars2(text7);
  const clean = (goal) => goal.trim().replace(/[。.]+$/, "");
  let parentGoal = clean(parent?.goal ?? "");
  let ownGoal = clean(node.goal);
  let text6 = assemble(parentGoal, ownGoal);
  if (size(text6) > BRIEF_MAX && parentGoal) {
    const over = size(text6) - BRIEF_MAX;
    const keep = chars2(parentGoal) - over - chars2(more);
    parentGoal = keep > 0 ? cut(parentGoal, keep) + more : "";
    text6 = assemble(parentGoal, ownGoal);
  }
  if (size(text6) > BRIEF_MAX && ownGoal) {
    const over = size(text6) - BRIEF_MAX;
    const keep = chars2(ownGoal) - over - chars2(more);
    ownGoal = keep > 0 ? cut(ownGoal, keep) + more : "";
    text6 = assemble(parentGoal, ownGoal);
  }
  return { heading, text: text6 };
}
var goalOf = (db, id3) => {
  const doc2 = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    id3
  );
  if (!doc2) return "";
  const goal = JSON.parse(doc2.fields).goal;
  return typeof goal === "string" ? goal : "";
};
function charterBrief(db, id3) {
  const list4 = nodes(db);
  const node = list4.find((n) => n.id === id3);
  if (!node) return void 0;
  const chain = [];
  let current2 = node;
  while (current2) {
    chain.unshift(current2);
    const parentId = current2.parent_id;
    current2 = list4.find((n) => n.id === parentId);
  }
  const owned = allBoundaries(db);
  const levels = [
    ...chainLevels(list4, owned, node.parent_id),
    { node: node.id, name: node.name, entries: owned.get(node.id) ?? [] }
  ];
  const parent = list4.find((n) => n.id === node.parent_id);
  return formatBrief({
    chain: chain.map((n) => n.name),
    node: { ref: ref(node.id), name: node.name, goal: goalOf(db, node.id) },
    ...parent ? { parent: { name: parent.name, goal: goalOf(db, parent.id) } } : {},
    boundaries: effective(levels)
  });
}
function withContext(brief2, context2) {
  if (!context2) return brief2;
  if (!brief2) return { heading: "\u5168\u666F\u4F4D\u7F6E\u4E0E\u8981\u70B9", text: context2 };
  return { heading: brief2.heading, text: `${context2}

${brief2.text}` };
}

// server/map/context.ts
var CONTEXT_MAX = 1500;
var CONTEXT_MIN = 200;
var LINE_MAX2 = 240;
var chars3 = (text6) => Array.from(text6).length;
function clip4(text6, max) {
  const line = text6.replace(/\s+/g, " ").trim();
  return chars3(line) > max ? `${Array.from(line).slice(0, max - 1).join("")}\u2026` : line;
}
var label4 = (l) => l.alias && l.alias !== l.name ? `${l.alias}\uFF08${l.name}\uFF09` : l.name;
function formatContext(input, self, max = CONTEXT_MAX) {
  const more = `\u2026\uFF08\u5168\u6587\uFF1Aatrium map context ${self}\uFF09`;
  const node = input.chain.at(-1);
  if (!node) return { text: "", truncated: false };
  const items = [];
  let clipped = false;
  const add = (order, rank, text7) => {
    const cut3 = clip4(text7, LINE_MAX2);
    if (cut3 !== text7.replace(/\s+/g, " ").trim()) clipped = true;
    items.push({ order, rank, text: cut3 });
  };
  add(
    0,
    0,
    `\u5168\u666F\u4F4D\u7F6E\uFF1A${input.chain.map(label4).join(" \u2192 ")}${node.analogy ? `\uFF08${node.analogy}\uFF09` : ""}`
  );
  const depth = input.chain.length;
  input.chain.forEach((level, i) => {
    if (!level.what) return;
    const distance = depth - 1 - i;
    add(
      1 + i,
      distance === 0 ? 1 : distance === 1 ? 4 : 6 + distance,
      `- ${label4(level)}\uFF1A${level.what}`
    );
  });
  const parts = input.parts.filter((p3) => p3.alias || p3.name);
  if (parts.length)
    add(
      50,
      6,
      `\u672C\u5757\u7531\u8FD9\u51E0\u90E8\u5206\u7EC4\u6210\uFF1A${parts.map((p3) => `${label4(p3)}${p3.analogy ? `\u2014\u2014${p3.analogy}` : ""}`).join("\uFF1B")}`
    );
  if (input.now) add(51, 5, `\u73B0\u5728\uFF1A${input.now}`);
  if (input.next) add(52, 5, `\u63A5\u4E0B\u6765\uFF1A${input.next}`);
  const levels = input.points.filter((l) => l.points.length);
  if (levels.length) {
    add(60, 0, "\u8981\u70B9\uFF08\u672C\u8282\u70B9\u53CA\u4E0A\u7EA7\uFF0C\u5FC5\u987B\u5B88\u4F4F\uFF09\uFF1A");
    levels.forEach((level, i) => {
      const distance = levels.length - 1 - i;
      level.points.forEach(
        (p3, j) => add(
          61 + i * 40 + j,
          // 本节点的要点排在上级前；同层按先后。
          2 + distance + j / 100,
          `- [${level.name}] ${p3.text}\uFF08\u4E3A\u4EC0\u4E48\uFF1A${p3.why}\uFF1B${p3.by} \u5B9A${p3.check ? `\uFF1B\u68C0\u67E5\uFF1A${p3.check}` : ""}\uFF09`
        )
      );
    });
  }
  const applied = (input.applied ?? []).filter((l) => l.points.length);
  if (applied.length) {
    add(1e3, 0, "\u7275\u6D89\u90E8\u5206\u7684\u8981\u70B9\uFF08\u540C\u6837\u5FC5\u987B\u5B88\u4F4F\uFF09\uFF1A");
    applied.forEach(
      (level, i) => level.points.forEach(
        (p3, j) => add(
          1001 + i * 40 + j,
          // 与上一层的要点同级：比本块要点低，比更远的上级高。
          3 + i / 10 + j / 100,
          `- [${level.source}] ${p3.text}\uFF08\u4E3A\u4EC0\u4E48\uFF1A${p3.why}\uFF1B${p3.by} \u5B9A${p3.check ? `\uFF1B\u68C0\u67E5\uFF1A${p3.check}` : ""}\uFF09`
        )
      )
    );
  }
  const budget = max - chars3(more) - 1;
  const kept = [];
  let used = 0;
  let dropped = false;
  for (const item of [...items].sort(
    (a, b) => a.rank - b.rank || a.order - b.order
  )) {
    const cost = chars3(item.text) + (kept.length ? 1 : 0);
    if (used + cost <= budget) {
      kept.push(item);
      used += cost;
    } else dropped = true;
  }
  const hasPoint = kept.some((k) => k.order > 60 && k.order < 1e3);
  const hasApplied = kept.some((k) => k.order > 1e3);
  const lines2 = kept.filter(
    (k) => (k.order !== 60 || hasPoint) && (k.order !== 1e3 || hasApplied)
  ).sort((a, b) => a.order - b.order).map((k) => k.text);
  const truncated = dropped || clipped;
  if (truncated) lines2.push(more);
  let text6 = lines2.join("\n");
  if (chars3(text6) > max)
    text6 = `${Array.from(text6).slice(0, max - chars3(more) - 1).join("")}
${more}`;
  return { text: text6, truncated };
}
var str2 = (value) => typeof value === "string" ? value.trim() : "";
function mapContext(db, address, max = CONTEXT_MAX, also) {
  const n = nodeByAddress(db, address);
  return contextOf(db, n.id, max, resolveApplies(db, also, "--also") ?? []);
}
function contextOf(db, id3, max = CONTEXT_MAX, also = []) {
  const list4 = nodes(db);
  const fieldsOf = (nodeId) => {
    const doc2 = one2(
      db,
      "SELECT fields FROM org_docs WHERE node_id=? AND doc='charter'",
      nodeId
    );
    try {
      return doc2 ? JSON.parse(doc2.fields) : {};
    } catch {
      return {};
    }
  };
  const chain = [];
  for (let c = list4.find((n) => n.id === id3); c; ) {
    const f = fieldsOf(c.id);
    chain.unshift({
      ref: ref(c.id),
      name: c.name,
      alias: str2(f.alias),
      analogy: str2(f.analogy),
      what: str2(f.what) || str2(f.goal)
    });
    const parent = c.parent_id;
    c = list4.find((n) => n.id === parent);
  }
  const own = fieldsOf(id3);
  const parts = list4.filter((n) => n.parent_id === id3 && n.archived_at === null).map((n) => {
    const f = fieldsOf(n.id);
    return { name: n.name, alias: str2(f.alias), analogy: str2(f.analogy) };
  });
  const { text: text6, truncated } = formatContext(
    {
      chain,
      parts,
      now: str2(own.now),
      next: str2(own.next),
      points: chainPoints(db, id3).map((level) => ({
        name: level.name,
        points: level.points
      })),
      applied: appliedPoints(db, id3, also)
    },
    ref(id3),
    max
  );
  return { ref: ref(id3), text: text6, chars: chars3(text6), max, truncated };
}
function parseMax(value) {
  if (value === void 0 || value === "") return CONTEXT_MAX;
  const n = Number(value);
  if (!Number.isInteger(n) || n < CONTEXT_MIN || n > 8e3)
    throw new Problem(
      400,
      `--max \u5E94\u4E3A ${CONTEXT_MIN}\uFF5E8000 \u7684\u6574\u6570\u5B57\u6570`,
      "usage"
    );
  return n;
}
function taskContext(db, id3, also = []) {
  if (id3 === null) return void 0;
  try {
    if (!one2(db, "SELECT 1 FROM org_nodes WHERE id=?", id3)) return void 0;
    return contextOf(db, id3, CONTEXT_MAX, also).text || void 0;
  } catch {
    return void 0;
  }
}

// server/skills/mount.ts
import {
  existsSync as existsSync4,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync6,
  readdirSync as readdirSync2,
  rmSync,
  symlinkSync,
  writeFileSync as writeFileSync5
} from "node:fs";
import { dirname as dirname3, join as join12 } from "node:path";
var MANIFEST = "skills.json";
var NOTES = "skill-notes.md";
var CODEX_LINKS = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "rules",
  "plugins"
];
function layout(dir, tool) {
  switch (ADAPTERS[tool].skillMount) {
    case "claude-plugin": {
      const root = join12(dir, "skills-plugin");
      return {
        root,
        skills: join12(root, "skills"),
        args: ["--plugin-dir", root],
        env: {},
        how: "\u5DF2\u4F5C\u4E3A Claude Code \u63D2\u4EF6\u6280\u80FD\u52A0\u8F7D\uFF08\u540D\u5B57\u5E26 atrium-skills: \u524D\u7F00\uFF09"
      };
    }
    case "codex-home": {
      const root = join12(dir, "codex-home");
      return {
        root,
        skills: join12(root, "skills"),
        args: [],
        env: { CODEX_HOME: root },
        how: "\u5DF2\u653E\u8FDB codex \u7684\u6280\u80FD\u76EE\u5F55"
      };
    }
    case "opencode-config": {
      const root = join12(dir, "opencode");
      return {
        root,
        skills: join12(root, "skills"),
        args: [],
        env: { OPENCODE_CONFIG_DIR: root },
        how: "\u5DF2\u653E\u8FDB opencode \u7684\u6280\u80FD\u76EE\u5F55"
      };
    }
    default:
      return {
        root: join12(dir, "skills"),
        skills: join12(dir, "skills"),
        args: [],
        env: {},
        how: "\u6CA1\u6709\u539F\u751F\u52A0\u8F7D\uFF0C\u9700\u8981\u65F6\u8BFB\u5BF9\u5E94\u7684 SKILL.md"
      };
  }
}
function readManifest(dir) {
  try {
    const data2 = JSON.parse(
      readFileSync6(join12(dir, MANIFEST), "utf8")
    );
    return Array.isArray(data2.skills) ? data2 : void 0;
  } catch {
    return void 0;
  }
}
function writeFiles(target, files) {
  rmSync(target, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const file = join12(target, ...path.split("/"));
    mkdirSync4(dirname3(file), { recursive: true, mode: 448 });
    writeFileSync5(file, content, { mode: 384 });
  }
}
function linkIfAbsent(source2, target) {
  if (!existsSync4(source2)) return;
  try {
    lstatSync2(target);
  } catch {
    symlinkSync(source2, target);
  }
}
function linkCodexHome(root, home, skills) {
  const user = join12(home, ".codex");
  for (const name2 of CODEX_LINKS)
    linkIfAbsent(join12(user, name2), join12(root, name2));
  let own = [];
  try {
    own = readdirSync2(join12(user, "skills"));
  } catch {
  }
  for (const name2 of own)
    if (!name2.startsWith(".") && !skills.some((s) => s.slug === name2))
      linkIfAbsent(join12(user, "skills", name2), join12(root, "skills", name2));
}
function mountSkills(dir, tool, skills, home) {
  if (!skills.length) return void 0;
  const place = layout(dir, tool);
  mkdirSync4(place.skills, { recursive: true, mode: 448 });
  if (ADAPTERS[tool].skillMount === "claude-plugin") {
    mkdirSync4(join12(place.root, ".claude-plugin"), {
      recursive: true,
      mode: 448
    });
    writeFileSync5(
      join12(place.root, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "atrium-skills", description: "Atrium \u6D3E\u6D3B\u65F6\u6302\u8F7D\u7684\u7EC4\u7EC7\u6280\u80FD", version: "1.0.0" }, null, 2)}
`,
      { mode: 384 }
    );
  }
  if (ADAPTERS[tool].skillMount === "codex-home")
    linkCodexHome(place.root, home, skills);
  const previous = new Map(
    (readManifest(dir)?.skills ?? []).map((entry) => [entry.slug, entry])
  );
  const mounted = [];
  for (const skill of skills) {
    const target = join12(place.skills, skill.slug);
    const kept = previous.get(skill.slug);
    if (kept && kept.dir === target && existsSync4(join12(target, "SKILL.md"))) {
      mounted.push(kept);
      continue;
    }
    writeFiles(target, skill.files);
    mounted.push({
      id: skill.id,
      slug: skill.slug,
      rev: skill.rev,
      dir: target
    });
  }
  const all3 = [
    ...mounted,
    ...(readManifest(dir)?.skills ?? []).filter(
      (entry) => !mounted.some((m) => m.dir === entry.dir)
    )
  ];
  writeFileSync5(
    join12(dir, MANIFEST),
    `${JSON.stringify({ skills: all3 }, null, 2)}
`,
    {
      mode: 384
    }
  );
  const byslug = new Map(skills.map((skill) => [skill.slug, skill]));
  const section = [
    `\u4EE5\u4E0B\u6280\u80FD\u7531\u7EC4\u7EC7\u7EF4\u62A4\uFF0C\u53EA\u5BF9\u8FD9\u6B21\u8FD0\u884C\u751F\u6548\uFF1B${place.how}\u3002`,
    ...mounted.map((entry) => {
      const skill = byslug.get(entry.slug);
      return `- ${entry.slug}\uFF08r${entry.rev}\uFF0C\u6765\u81EA ${skill.via}\uFF09\uFF1A${skill.description}
  \u6587\u4EF6\uFF1A${join12(entry.dir, "SKILL.md")}`;
    }),
    `\u6280\u80FD\u5185\u5BB9\u6709\u8BEF\u6216\u8FC7\u65F6\uFF1A\u53EF\u4EE5\u76F4\u63A5\u6539\u4E0A\u9762\u7684\u526F\u672C\uFF08\u4E0D\u8981\u590D\u5236\u8FDB\u4ED3\u5E93\uFF09\uFF0C\u5E76\u628A\u539F\u56E0\u5199\u8FDB ${join12(dir, NOTES)}\uFF1B\u6536\u5C3E\u65F6\u4F1A\u751F\u6210\u4FEE\u8BA2\u63D0\u8BAE\uFF0C\u5BA1\u6838\u540E\u91C7\u7EB3\u3002`
  ].join("\n");
  return { env: place.env, args: place.args, section, skills: mounted };
}
function readMounted(root) {
  const files = {};
  let bytes = 0;
  const walk = (dir, prefix, depth) => {
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
    } catch {
      return `\u8BFB\u4E0D\u5230 ${dir}`;
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join12(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= LIMITS.depth) return `${rel} \u76EE\u5F55\u5C42\u7EA7\u8D85\u8FC7 ${LIMITS.depth}`;
        const problem2 = walk(full, rel, depth + 1);
        if (problem2) return problem2;
      } else if (entry.isFile()) {
        if (Object.keys(files).length >= LIMITS.files)
          return `\u6587\u4EF6\u8D85\u8FC7 ${LIMITS.files} \u4E2A`;
        const size = lstatSync2(full).size;
        bytes += size;
        if (bytes > LIMITS.bytes) return `\u5408\u8BA1\u8D85\u8FC7 ${LIMITS.bytes / 1024} KB`;
        files[rel] = readFileSync6(full, "utf8");
      }
    }
    return void 0;
  };
  const problem = walk(root, "", 1);
  return problem ? { problem } : { files };
}

// server/tasks/workspace.ts
import { homedir as homedir5 } from "node:os";
var RUN_RULES = [
  ...DEFAULT_RULES,
  "\u505C\u5728 PR\uFF1A\u4E0D\u8981\u5408\u5165\u3001\u4E0D\u8981\u6539\u9ED8\u8BA4\u5206\u652F\u3001\u4E0D\u8981\u53D1\u7248\u3002",
  "\u4E0D\u8981\u542F\u52A8\u3001\u505C\u6B62\u6216\u66F4\u65B0 4310 \u7AEF\u53E3\u4E0A\u7684 Atrium \u670D\u52A1\uFF0C\u4E5F\u4E0D\u8981\u6267\u884C\u6CA1\u6709\u9694\u79BB ATRIUM_PORT / ATRIUM_DATA \u7684 atrium \u547D\u4EE4\u3002"
];
function deliveryRules(task) {
  if (task.deliver === "pr") return RUN_RULES;
  const common = DEFAULT_RULES.filter((rule) => !rule.startsWith("\u505A\u5B8C\u540E\u4F9D\u6B21"));
  return [
    ...common,
    task.deliver === "comment" ? `\u4EA4\u4ED8\u7269\u662F\u5728 issue #${task.issue} \u53D1\u5E03\u4E00\u6761\u8BC4\u8BBA\uFF1B\u5B8C\u6210\u540E\u9644\u8BC4\u8BBA\u94FE\u63A5\uFF0C\u4E0D\u8981\u6C42\u63D0\u4EA4\u3001\u63A8\u9001\u6216\u5F00 PR\u3002` : "\u4EA4\u4ED8\u7269\u662F\u6700\u7EC8\u6458\u8981\uFF1B\u5B8C\u6210\u540E\u5199\u660E\u8C03\u67E5\u7ED3\u679C\uFF0C\u4E0D\u8981\u6C42\u63D0\u4EA4\u3001\u63A8\u9001\u6216\u5F00 PR\u3002",
    RUN_RULES.at(-1)
  ];
}
function briefOf2(task) {
  if (task.brief != null) return task.brief;
  if (!task.brief_path) return void 0;
  throw new Problem(
    400,
    `${task.ref} \u7684\u4EFB\u52A1\u8BE6\u8FF0\u6CA1\u6709\u8FDB\u5E93\uFF08\u539F\u6587\u4EF6 ${task.brief_path} \u8BFB\u4E0D\u5230\uFF09`,
    "usage",
    void 0,
    `atrium task set ${task.ref} --brief \u6587\u4EF6`
  );
}
async function prepareRun(task, chosen, options, resume) {
  const run3 = options.run ?? exec;
  const { worker } = chosen;
  const adapter = ADAPTERS[worker.tool];
  const tellMode = tellModeOf(adapter, worker.profile.rules.tell);
  const tells = options.db ? listTells(options.db, task.id) : [];
  const dir = taskDir(options.data, task.id);
  mkdirSync5(dir, { recursive: true, mode: 448 });
  const brief2 = briefOf2(task);
  let cwd;
  let worktree = null;
  let branch = null;
  let base2 = null;
  if (task.repo) {
    if (!existsSync5(task.repo))
      throw new Problem(400, `\u4EFB\u52A1\u4ED3\u5E93\u4E0D\u5B58\u5728\uFF1A${task.repo}`, "usage");
    const plan2 = worktreePlan(
      task.repo,
      task.id,
      task.title,
      task.role ?? void 0
    );
    base2 = await defaultBranch(task.repo, run3);
    await ensureWorktree(task.repo, plan2, base2, run3);
    cwd = worktree = plan2.path;
    branch = plan2.branch;
  } else {
    cwd = join13(dir, "work");
    mkdirSync5(cwd, { recursive: true });
  }
  const node = options.db ? taskNode(options.db, task) : void 0;
  const origin = options.db && task.origin_node_id !== null ? nodeDoc(options.db, task.origin_node_id) : void 0;
  const job = options.db && task.job_id ? getJobRole(options.db, `r${task.job_id}`) : void 0;
  const patrol = options.db ? patrolRun(options.db, task.id) : void 0;
  const docs = task.repo ? await loadRoleDocs(worktree ?? task.repo, node) : { roleDoc: node?.body ?? "", rootDoc: "" };
  const picked = options.db && !patrol ? skillsForTask(options.db, task, {
    ...worker.profile.rules,
    skills: [
      .../* @__PURE__ */ new Set([
        ...Array.isArray(worker.profile.rules.skills) ? worker.profile.rules.skills : [],
        ...job?.skills ?? []
      ])
    ]
  }) : void 0;
  const mount = picked ? mountSkills(
    dir,
    worker.tool,
    picked.skills,
    options.env.HOME ?? homedir5()
  ) : void 0;
  if (options.db && picked && (mount || picked.dropped.length || picked.unknown.length))
    noteTask(options.db, task.id, "skills_mounted", {
      worker: worker.id,
      skills: mount?.skills.map((s) => `${s.slug}@r${s.rev}`) ?? [],
      ...picked.dropped.length ? { dropped: picked.dropped.map((d) => d.slug) } : {},
      ...picked.unknown.length ? { unknown: picked.unknown } : {}
    });
  const where = branch ? `\u5DE5\u4F5C\u76EE\u5F55\uFF1A${cwd}\uFF08\u5206\u652F ${branch}\uFF0C\u57FA\u4E8E origin/${base2}\uFF09\u3002` : `\u5DE5\u4F5C\u76EE\u5F55\uFF1A${cwd}\uFF08\u6CA1\u6709\u4ED3\u5E93\uFF0C\u7ED3\u679C\u5199\u5728\u6700\u540E\u7684\u56DE\u590D\u91CC\uFF09\u3002`;
  const prompt = buildPrompt({
    title: task.title,
    brief: patrol ? `\u8282\u70B9\uFF1Ao${patrol.node_id}
\u672C\u8F6E\u573A\u666F\uFF1A${patrol.scenario}
\u4E00\u4EF6\u4E8B\u600E\u4E48\u8D70\u5B8C\uFF1A${JSON.parse(patrol.flow).map((step2, i) => `${i + 1}. ${step2}`).join("\n") || "\u6309\u573A\u666F\u81EA\u884C\u8D70\u901A"}

\u6309\u573A\u666F\u5B9E\u9645\u64CD\u4F5C\uFF1B\u53EA\u8BFB\u5168\u666F\u3001\u5E2E\u52A9\u548C\u547D\u4EE4\u56DE\u6267\u3002\u9047\u5230\u95EE\u9898\u7528 atrium patrol report ${task.ref} --phenomenon \u7B80\u77ED\u73B0\u8C61 --step \u54EA\u4E00\u6B65 --command '\u5B9E\u9645\u547D\u4EE4' --expected '\u9884\u671F' --actual '\u5B9E\u9645' --kind broken|awkward \u8BB0\u5F55\u3002\u65E0\u53D1\u73B0\u4E5F\u6B63\u5E38\u7ED3\u675F\u3002` : brief2,
    tells: tellSection(tells),
    roleDoc: [
      patrol ? "# \u4F53\u9A8C\u5DE1\u68C0\n\n\u628A\u81EA\u5DF1\u5F53\u7528\u6237\u4F7F\u7528 Atrium\uFF0C\u627E\u6838\u5FC3\u4F53\u9A8C\u4E0A\u7684\u6BDB\u75C5\u3002\u4E0D\u8BFB\u4EE3\u7801\u3001\u4E0D\u6539\u4EE3\u7801\u3001\u4E0D\u67E5\u51ED\u636E\u6216\u6743\u9650\u8FB9\u754C\u3002\u4E0D\u76F4\u63A5\u5EFA\u6539\u52A8\u4EFB\u52A1\uFF1B\u53D1\u73B0\u4EA4\u7ED9\u8282\u70B9 leader\u3002" : "",
      job ? `# \u5E72\u6D3B\u7684\u4E13\u5458\uFF1A${job.name}

${job.body}

\u4EA4\u4ED8\u8981\u6C42\uFF1A${job.checks.join("\u3001") || "\u6309\u4EFB\u52A1\u4E0E\u6863\u6848\u8981\u6C42"}` : "",
      patrol ? "" : docs.roleDoc
    ].filter(Boolean).join("\n\n"),
    charter: options.db && !patrol ? withContext(
      node ? charterBrief(options.db, node.id) : void 0,
      taskContext(
        options.db,
        task.part_id ?? node?.id ?? null,
        alsoOf(options.db, task.id)
      )
    ) : void 0,
    concerns: options.db ? concernSection(checklists(options.db, task.id)) : void 0,
    originDoc: origin ? `\u672C\u4EFB\u52A1\u7531 ${origin.ref} ${origin.name} \u6295\u6765\u3002

${origin.body}` : void 0,
    skills: patrol ? void 0 : mount?.section,
    rootDoc: patrol ? void 0 : docs.rootDoc,
    profileBody: patrol ? void 0 : worker.profile.body,
    rules: patrol ? [
      "\u76F4\u63A5\u4F7F\u7528\u5F53\u524D\u670D\u52A1\u4E0E\u771F\u5B9E\u6570\u636E\u3002\u53EA\u770B atrium map / org show \u7684\u4EBA\u8BDD\u5B57\u6BB5\u3001atrium --help\u3001atrium guide \u548C\u547D\u4EE4\u56DE\u6267\uFF1B\u4E0D\u8BFB\u4ED3\u5E93\u4EE3\u7801\u3002\u53EA\u8FD0\u884C\u4E0E\u672C\u8F6E\u573A\u666F\u6709\u5173\u7684\u547D\u4EE4\uFF1B\u6709\u526F\u4F5C\u7528\u7684\u64CD\u4F5C\u53EA\u6309\u573A\u666F\u5B9E\u9645\u9700\u8981\u6267\u884C\u3002",
      "\u6BCF\u4E2A\u4E0D\u540C\u73B0\u8C61\u53EA\u62A5\u544A\u4E00\u6B21\uFF1B\u7ED3\u675F\u540E\u62A5\u544A\u4F60\u8D70\u8FC7\u7684\u6B65\u9AA4\u3002"
    ] : [where, ...deliveryRules(task), TELL_RULE]
  });
  const promptFile = join13(dir, "prompt.md");
  writeFileSync6(promptFile, prompt, { mode: 384 });
  const logFile = join13(dir, "log");
  const input = {
    promptFile,
    prompt,
    cwd,
    model: worker.cliModel,
    effort: worker.effort,
    resultFile: join13(dir, "last-message.md"),
    live: tellMode === "stdin"
  };
  let launch;
  if (resume) {
    if (!adapter.resume)
      throw new Problem(400, `${adapter.tool} \u4E0D\u652F\u6301\u7EED\u4E0A\u4F1A\u8BDD`, "usage");
    const tellFile = join13(dir, "tell.md");
    writeFileSync6(tellFile, resume.text, { mode: 384 });
    launch = adapter.resume({
      ...input,
      promptFile: tellFile,
      prompt: resume.text,
      session: resume.session
    });
  } else launch = adapter.build(input);
  if (mount) {
    launch.args.push(...mount.args);
    if (Object.keys(mount.env).length)
      launch.env = { ...launch.env, ...mount.env };
  }
  return {
    worker,
    adapter,
    risk: chosen.risk,
    cwd,
    worktree,
    branch,
    base: base2,
    dir,
    promptFile,
    logFile,
    launch,
    tellMode,
    tellIds: resume ? [] : unsent(tells).map((tell) => tell.id)
  };
}

// server/tasks/tell-runtime.ts
import { randomUUID } from "node:crypto";
import { open as open4 } from "node:fs/promises";
var HEAD_BYTES = 1024 * 1024;
async function readHead(file) {
  try {
    const handle = await open4(file, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
var NEXT = {
  stdin: "\u5DF2\u5199\u8FDB\u6267\u884C\u8005\u7684\u8F93\u5165\uFF0C\u5728\u4E0B\u4E00\u4E2A\u5DE5\u5177\u8C03\u7528\u8FB9\u754C\u8BFB\u5165",
  after_turn: "\u6267\u884C\u8005\u8FD9\u4E00\u8F6E\u7ED3\u675F\u540E\u5E26\u7740\u8865\u5145\u7EED\u4E0A\u539F\u4F1A\u8BDD",
  restart: "\u6267\u884C\u8005\u4E0D\u652F\u6301\u8FD0\u884C\u4E2D\u8FFD\u52A0\uFF0C\u6B63\u5728\u505C\u4E0B\u5E76\u5E26\u7740\u8865\u5145\u91CD\u6D3E\uFF08\u5DE5\u4F5C\u6811\u4FDD\u7559\uFF09",
  next_run: "\u4E0B\u6B21\u62C9\u8D77\u6267\u884C\u8005\u65F6\u5199\u8FDB\u63D0\u793A\u8BCD"
};
function tellTask(x, db, reference, body3, actor) {
  const id3 = parseTaskRef(reference);
  const { text: text6, by } = tellInput(body3, actor);
  const task = getTask(db, id3);
  const active = x.active.get(id3);
  const running = !!active && !active.exited && !active.stop;
  const route = routeTell({
    status: task.status,
    running,
    mode: active ? tellModeOf(ADAPTERS[active.tool], active.worker.profile.rules.tell) : void 0,
    live: !!active?.live?.open
  });
  if (route.kind === "reject")
    throw new Problem(
      409,
      `${task.ref}\uFF1A${route.reason}`,
      "conflict",
      void 0,
      `atrium task show ${task.ref}`
    );
  let kind = route.kind;
  const tell = addTell(db, id3, { text: text6, by, uuid: randomUUID(), route: kind });
  if (kind === "stdin") {
    if (active.live.send(tellMessage(tell), tell.uuid)) markWritten(db, tell);
    else kind = "after_turn";
  } else if (kind === "restart") {
    active.stop = { kind: "tell" };
    noteTask(db, id3, "stop_requested", {
      pid: active.pid,
      by,
      reason: "\u9001\u634E\u8BDD\uFF1A\u505C\u4E0B\u540E\u5E26\u7740\u8865\u5145\u91CD\u6D3E"
    });
    x.kill(active);
  }
  const saved = listTells(db, id3).find((item) => item.id === tell.id) ?? tell;
  return {
    task: getTask(db, id3),
    tell: { ...saved, route: kind },
    how: NEXT[kind]
  };
}
async function followUpTells(x, db, active, exit) {
  await active.live?.finish();
  if (x.isClosed()) return false;
  const pending = unsent(listTells(db, active.id));
  if (!pending.length && active.stop?.kind !== "tell") return false;
  const adapter = ADAPTERS[active.tool];
  const session = adapter.resume && adapter.sessionOf ? adapter.sessionOf(await readHead(active.logFile)) : void 0;
  const next = afterExit({
    stop: active.stop,
    exit,
    pending: pending.length,
    session,
    mode: tellModeOf(adapter, active.worker.profile.rules.tell)
  });
  if (next === "settle" || getTask(db, active.id).status !== "running")
    return false;
  try {
    await x.relaunch(
      active,
      next === "resume" ? {
        session,
        text: resumeMessage(pending),
        ids: pending.map((tell) => tell.id)
      } : void 0
    );
    return true;
  } catch (error) {
    if (x.isClosed()) return false;
    noteTask(db, active.id, "tell_failed", {
      reason: `${next === "resume" ? "\u7EED\u4E0A\u4F1A\u8BDD" : "\u91CD\u6D3E"}\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
    });
    return false;
  }
}

// server/skills/collect.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { join as join14 } from "node:path";

// server/org/validate.ts
import YAML2 from "yaml";
var bad4 = (field2, message4) => {
  throw new Problem(400, `${field2} ${message4}`, "usage");
};
var object5 = (value, field2) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return bad4(field2, "\u5E94\u4E3A\u5BF9\u8C61");
  return value;
};
var text4 = (value, field2, max) => {
  if (typeof value !== "string") return bad4(field2, "\u5E94\u4E3A\u6587\u672C");
  if (Array.from(value).length > max) return bad4(field2, `\u8D85\u8FC7 ${max} \u5B57`);
  return value;
};
function validateSlug(value) {
  const slug = text4(value, "slug", 40);
  if (!slug || !/^(?:[a-z0-9-]|[\u3400-\u9fff])+$/.test(slug))
    return bad4("slug", "\u53EA\u80FD\u7528\u5C0F\u5199\u82F1\u6570\u3001\u8FDE\u5B57\u7B26\u6216\u4E2D\u6587\uFF0C\u957F\u5EA6 1\u201340 \u5B57");
  return slug;
}
function validateReason(value) {
  const reason = text4(value, "reason", 500).trim();
  if (!reason) return bad4("reason", "\u4E0D\u80FD\u4E3A\u7A7A");
  return reason;
}
function validateKind(value) {
  if (!["org", "project", "module", "concern"].includes(String(value)))
    return bad4("kind", "\u53EA\u80FD\u662F org\u3001project\u3001module\u3001concern");
  return value;
}
function validParent(parent, child) {
  return parent === "org" && child === "project" || parent === "project" && (child === "module" || child === "concern") || parent === "module" && (child === "module" || child === "concern");
}
function validateFields(doc2, value) {
  const fields = object5(value, doc2);
  const rules = doc2 === "charter" ? { goal: 300, report: 200, escalate: 200 } : { status: 300 };
  const lists = doc2 === "card" ? { owns: 10, accepts: 10, asks: 5 } : { invite_when: 20 };
  for (const [key, v] of Object.entries(fields)) {
    const field2 = `${doc2}.${key}`;
    if (doc2 === "charter" && validateOverviewField(key, v)) continue;
    if (Object.hasOwn(rules, key)) text4(v, field2, rules[key]);
    else if (Object.hasOwn(lists, key)) {
      if (!Array.isArray(v)) bad4(field2, "\u5E94\u4E3A\u6587\u672C\u5217\u8868");
      const entries = v;
      if (entries.length > lists[key]) bad4(field2, `\u8D85\u8FC7 ${lists[key]} \u9879`);
      entries.forEach((item, i) => text4(item, `${field2}[${i}]`, 300));
    } else if (doc2 === "card" && key === "commitments") {
      if (!Array.isArray(v)) bad4(field2, "\u5E94\u4E3A\u627F\u8BFA\u5217\u8868");
      const entries = v;
      if (entries.length > 10) bad4(field2, "\u8D85\u8FC7 10 \u9879");
      entries.forEach((item, i) => {
        const entry = object5(item, `${field2}[${i}]`);
        for (const k of Object.keys(entry))
          if (!["id", "text", "due"].includes(k))
            bad4(`${field2}[${i}].${k}`, "\u662F\u672A\u77E5\u5B57\u6BB5");
        text4(entry.id, `${field2}[${i}].id`, 40);
        text4(entry.text, `${field2}[${i}].text`, 300);
        if (entry.due !== void 0 && (typeof entry.due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.due) || Number.isNaN(Date.parse(entry.due)) || new Date(entry.due).toISOString().slice(0, 10) !== entry.due))
          bad4(`${field2}[${i}].due`, "\u5E94\u4E3A YYYY-MM-DD \u65E5\u671F");
      });
    } else bad4(field2, "\u662F\u672A\u77E5\u5B57\u6BB5");
  }
  return fields;
}
function validateBody(value) {
  if (typeof value !== "string") return bad4("body", "\u5E94\u4E3A\u6587\u672C");
  if (Buffer.byteLength(value, "utf8") > 16 * 1024)
    return bad4("body", "\u8D85\u8FC7 16 KB");
  return value;
}
function parseDocument(source2, doc2) {
  if (!source2.startsWith("---\n")) return bad4(doc2, "frontmatter \u7F3A\u5C11\u5F00\u5934 ---");
  const end = source2.indexOf("\n---\n", 4);
  if (end < 0) return bad4(doc2, "frontmatter \u7F3A\u5C11\u7ED3\u5C3E ---");
  let fields;
  try {
    const parsed = YAML2.parseDocument(source2.slice(4, end), {
      uniqueKeys: true
    });
    if (parsed.errors.length) return bad4(doc2, "frontmatter \u683C\u5F0F\u9519\u8BEF");
    fields = parsed.toJS({ maxAliasCount: 100 }) ?? {};
  } catch {
    return bad4(doc2, "frontmatter \u683C\u5F0F\u9519\u8BEF");
  }
  let boundaries;
  let budget;
  if (doc2 === "charter" && fields && typeof fields === "object" && !Array.isArray(fields) && Object.hasOwn(fields, "boundaries")) {
    const { boundaries: list4, ...rest } = fields;
    boundaries = list4 ?? [];
    fields = rest;
  }
  if (doc2 === "charter" && fields && typeof fields === "object" && !Array.isArray(fields) && Object.hasOwn(fields, "budget")) {
    const { budget: shares, ...rest } = fields;
    budget = shares;
    fields = rest;
  }
  return {
    fields: validateFields(doc2, fields),
    body: validateBody(source2.slice(end + 5)),
    ...boundaries === void 0 ? {} : { boundaries },
    ...budget === void 0 ? {} : { budget }
  };
}
function exportDocument(fields, body3, boundaries, budget) {
  const lines2 = Object.entries(fields).map(
    ([k, v]) => k === "stages" && Array.isArray(v) && v.length ? YAML2.stringify({ [k]: v }, { lineWidth: 0 }).trimEnd() : `${k}: ${JSON.stringify(v)}`
  );
  if (boundaries)
    lines2.push(
      boundaries.length ? YAML2.stringify({ boundaries }, { lineWidth: 0 }).trimEnd() : "boundaries: []"
    );
  if (budget && Object.keys(budget).length)
    lines2.push(YAML2.stringify({ budget }, { lineWidth: 0 }).trimEnd());
  return `---
${lines2.join("\n")}
---
${body3}`;
}

// server/skills/store.ts
var proposalRef = (id3) => `p${id3}`;
var rev = (value) => `r${value}`;
function parseRev(value, field2) {
  const match = /^r?(0|[1-9][0-9]*)$/.exec(String(value ?? "").trim());
  if (!match) throw new Problem(400, `${field2} \u5E94\u4E3A\u4FEE\u8BA2\u53F7\uFF0C\u5982 r3`, "usage");
  return Number(match[1]);
}
function skillBySlug(db, slug) {
  const row3 = one2(
    db,
    "SELECT * FROM org_skills WHERE slug=?",
    String(slug ?? "").trim()
  );
  if (!row3)
    throw new Problem(
      404,
      `\u6280\u80FD ${slug} \u4E0D\u5B58\u5728`,
      "not_found",
      void 0,
      "atrium skill ls"
    );
  return row3;
}
function proposalById(db, value) {
  const match = /^p?([1-9][0-9]*)$/.exec(String(value ?? "").trim());
  if (!match) throw new Problem(400, "\u63D0\u8BAE\u5E94\u5199\u6210 p1 \u8FD9\u6837\u7684\u77ED\u53F7", "usage");
  const row3 = one2(
    db,
    "SELECT * FROM org_skill_proposals WHERE id=?",
    Number(match[1])
  );
  if (!row3)
    throw new Problem(
      404,
      `\u63D0\u8BAE ${value} \u4E0D\u5B58\u5728`,
      "not_found",
      void 0,
      "atrium skill proposals"
    );
  return row3;
}
var filesOf = (row3) => JSON.parse(row3.files);
function snapshotOf(row3) {
  return {
    slug: row3.slug,
    name: row3.name,
    description: row3.description,
    owner: row3.owner_node_id === null ? null : ref(row3.owner_node_id),
    archived: row3.archived_at !== null,
    files: filesOf(row3)
  };
}
function ownerLabel(list4, id3) {
  if (id3 === null) return null;
  const node = list4.find((n) => n.id === id3);
  return node ? `${ref(id3)} ${nodePath(list4, node)}` : ref(id3);
}
function authorize2(list4, ownerId, actor, what) {
  if (actor === "u1") return;
  const owner = list4.find((n) => n.id === ownerId);
  if (!owner || !canEdit(list4, owner, actor))
    throw new Problem(
      403,
      `${what}\u65E0\u6743\u9650\uFF1A${actor} \u4E0D\u662F\u6280\u80FD owner ${owner ? ref(owner.id) : "\uFF08\u672A\u6307\u5B9A\uFF0C\u53EA\u6709\u4F60\u80FD\u6539\uFF09"} \u7684 leader \u6216\u7956\u5148 leader`,
      "conflict"
    );
}
function liveNode(db, address, field2) {
  let node;
  try {
    node = nodeByAddress(db, String(address ?? "").trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        error.statusCode === 404 ? 400 : error.statusCode,
        `${field2}: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree"
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw new Problem(400, `${field2}: \u8282\u70B9 ${ref(node.id)} \u5DF2\u5F52\u6863`, "usage");
  return node;
}
function source(value) {
  if (value === void 0 || value === null || value === "") return null;
  if (typeof value !== "string" || Array.from(value).length > 300)
    throw new Problem(
      400,
      "source \u5E94\u4E3A 300 \u5B57\u4EE5\u5185\u7684\u51FA\u5904\uFF08\u4EFB\u52A1\u53F7\u3001\u94FE\u63A5\u7B49\uFF09",
      "usage"
    );
  return value.trim() || null;
}
function appendRevision(db, row3, author2, reason, from, reviewer = null) {
  db.prepare(
    "INSERT INTO org_skill_revisions(skill_id,rev,author,reviewer,at,reason,source,snapshot) VALUES(?,?,?,?,?,?,?,?)"
  ).run(
    row3.id,
    row3.rev,
    author2,
    reviewer,
    row3.updated_at,
    reason,
    from,
    JSON.stringify(snapshotOf(row3))
  );
}
function addSkill(db, input, actor) {
  return transaction(db, () => {
    const slug = validateSkillSlug(input.slug);
    const reason = validateReason(input.reason);
    const count2 = one2(db, "SELECT count(*) n FROM org_skills");
    if (count2.n >= LIMITS.skills)
      throw new Problem(400, `\u6280\u80FD\u5DF2\u8FBE ${LIMITS.skills} \u4E2A\u4E0A\u9650`, "usage");
    if (one2(db, "SELECT 1 FROM org_skills WHERE slug=?", slug))
      throw new Problem(
        409,
        `\u6280\u80FD ${slug} \u5DF2\u5B58\u5728`,
        "conflict",
        void 0,
        `atrium skill show ${slug}`
      );
    const list4 = nodes(db);
    const owner = typeof input.owner === "string" && input.owner.trim() ? liveNode(db, input.owner, "owner") : list4.find((n) => n.parent_id === null) ?? null;
    authorize2(list4, owner?.id ?? null, actor, "\u65B0\u5EFA\u6280\u80FD");
    const meta = skillMeta(
      slug,
      validateFiles(input.files),
      typeof input.description === "string" ? input.description : void 0
    );
    const files = validateFiles(meta.files);
    const name2 = displayName(input.name, slug);
    const now = Date.now();
    const id3 = Number(
      db.prepare(
        "INSERT INTO org_skills(slug,name,description,owner_node_id,rev,files,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)"
      ).run(
        slug,
        name2,
        meta.description,
        owner?.id ?? null,
        JSON.stringify(files),
        now,
        now
      ).lastInsertRowid
    );
    const row3 = one2(db, "SELECT * FROM org_skills WHERE id=?", id3);
    appendRevision(db, row3, actor, reason, source(input.source));
    return {
      slug,
      rev: rev(1),
      owner: ownerLabel(list4, row3.owner_node_id),
      files: Object.keys(files).length
    };
  });
}
function displayName(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  const text6 = typeof value === "string" ? value.trim() : "";
  if (!text6 || Array.from(text6).length > LIMITS.name)
    throw new Problem(400, `name \u5E94\u4E3A 1\u2013${LIMITS.name} \u5B57`, "usage");
  return text6;
}
function commit(db, row3, change, author2, reason, from, reviewer = null) {
  const next = {
    ...row3,
    rev: row3.rev + 1,
    updated_at: Date.now(),
    files: change.files ? JSON.stringify(change.files) : row3.files,
    name: change.name ?? row3.name,
    description: change.description ?? row3.description,
    owner_node_id: change.owner === void 0 ? row3.owner_node_id : change.owner,
    archived_at: change.archived === void 0 ? row3.archived_at : change.archived ? row3.archived_at ?? Date.now() : null
  };
  if (next.files === row3.files && next.name === row3.name && next.description === row3.description && next.owner_node_id === row3.owner_node_id && next.archived_at === row3.archived_at)
    throw new Problem(400, "\u6CA1\u6709\u53D8\u5316\uFF1A\u5185\u5BB9\u4E0E\u5F53\u524D\u7248\u76F8\u540C", "usage");
  db.prepare(
    "UPDATE org_skills SET rev=?,files=?,name=?,description=?,owner_node_id=?,archived_at=?,updated_at=? WHERE id=?"
  ).run(
    next.rev,
    next.files,
    next.name,
    next.description,
    next.owner_node_id,
    next.archived_at,
    next.updated_at,
    row3.id
  );
  appendRevision(db, next, author2, reason, from, reviewer);
  return next;
}
function editSkill(db, slug, input, actor) {
  return transaction(db, () => {
    const row3 = skillBySlug(db, slug);
    const list4 = nodes(db);
    authorize2(list4, row3.owner_node_id, actor, "\u4FEE\u6539\u6280\u80FD");
    const reason = validateReason(input.reason);
    if (input.rev !== void 0 && input.rev !== null && input.rev !== "") {
      const base2 = parseRev(input.rev, "rev");
      if (base2 !== row3.rev)
        throw new Problem(
          409,
          `\u6280\u80FD\u5DF2\u662F ${rev(row3.rev)}\uFF0C\u4F60\u57FA\u4E8E ${rev(base2)} \u4FEE\u6539\uFF1B\u5148\u770B\u53D8\u5316`,
          "conflict",
          void 0,
          `atrium skill history ${row3.slug}`
        );
    }
    const change = {};
    if (input.files !== void 0) {
      const meta = skillMeta(
        row3.slug,
        validateFiles(input.files),
        typeof input.description === "string" ? input.description : void 0
      );
      change.files = validateFiles(meta.files);
      change.description = meta.description;
    } else if (input.description !== void 0)
      throw new Problem(
        400,
        "description \u5199\u5728 SKILL.md \u7684 frontmatter \u91CC\uFF1B\u6539 SKILL.md \u540E\u8FDE\u6587\u4EF6\u4E00\u8D77\u63D0\u4EA4",
        "usage"
      );
    if (input.name !== void 0)
      change.name = displayName(input.name, row3.slug);
    if (typeof input.owner === "string" && input.owner.trim()) {
      const owner = liveNode(db, input.owner, "owner");
      authorize2(list4, owner.id, actor, "\u628A\u6280\u80FD\u4EA4\u7ED9\u65B0 owner ");
      change.owner = owner.id;
    }
    if (input.archive !== void 0) change.archived = input.archive === true;
    let proposal;
    if (input.proposal !== void 0 && input.proposal !== null && input.proposal !== "") {
      proposal = proposalById(db, String(input.proposal));
      if (proposal.skill_id !== row3.id)
        throw new Problem(
          400,
          `proposal: ${proposalRef(proposal.id)} \u4E0D\u662F ${row3.slug} \u7684\u63D0\u8BAE`,
          "usage"
        );
      if (proposal.status !== "pending")
        throw new Problem(
          409,
          `proposal: ${proposalRef(proposal.id)} \u5DF2${proposal.status === "accepted" ? "\u91C7\u7EB3" : "\u9A73\u56DE"}`,
          "conflict"
        );
    }
    const next = commit(
      db,
      row3,
      change,
      proposal ? taskRef(proposal.task_id) : actor,
      reason,
      source(input.source) ?? (proposal ? proposalRef(proposal.id) : null),
      proposal ? actor : null
    );
    if (proposal) decide(db, proposal, "accepted", actor, reason, next.rev);
    return {
      slug: row3.slug,
      before: rev(row3.rev),
      rev: rev(next.rev),
      ...proposal ? { proposal: proposalRef(proposal.id) } : {}
    };
  });
}
function revisionAt(db, skill, at) {
  const found = one2(
    db,
    "SELECT * FROM org_skill_revisions WHERE skill_id=? AND rev=?",
    skill.id,
    at
  );
  if (!found)
    throw new Problem(
      404,
      `\u6280\u80FD ${skill.slug} \u6CA1\u6709\u4FEE\u8BA2 ${rev(at)}`,
      "not_found",
      void 0,
      `atrium skill history ${skill.slug}`
    );
  return JSON.parse(found.snapshot);
}
function revertSkill(db, slug, to2, reasonText, actor) {
  return transaction(db, () => {
    const row3 = skillBySlug(db, slug);
    const list4 = nodes(db);
    authorize2(list4, row3.owner_node_id, actor, "\u56DE\u9000\u6280\u80FD");
    const reason = validateReason(reasonText);
    const target = parseRev(to2, "to");
    const old = revisionAt(db, row3, target);
    const next = commit(
      db,
      row3,
      { files: old.files, name: old.name, description: old.description },
      actor,
      reason,
      `\u56DE\u9000\u5230 ${rev(target)}`
    );
    return {
      slug: row3.slug,
      before: rev(row3.rev),
      rev: rev(next.rev),
      to: rev(target)
    };
  });
}
function bindSkill(db, slug, address, actor, unbind = false) {
  return transaction(db, () => {
    const row3 = skillBySlug(db, slug);
    const list4 = nodes(db);
    const node = liveNode(db, address, "node");
    if (!canEdit(list4, node, actor))
      throw new Problem(
        403,
        `${unbind ? "\u89E3\u7ED1" : "\u7ED1\u5B9A"}\u65E0\u6743\u9650\uFF1A${actor} \u4E0D\u662F ${ref(node.id)} \u7684 leader \u6216\u7956\u5148 leader`,
        "conflict"
      );
    const where = `${ref(node.id)} ${nodePath(list4, node)}`;
    if (unbind) {
      const result = db.prepare(
        "DELETE FROM org_skill_bindings WHERE skill_id=? AND node_id=?"
      ).run(row3.id, node.id);
      if (!result.changes)
        throw new Problem(
          404,
          `${row3.slug} \u6CA1\u6709\u7ED1\u5728 ${where}`,
          "not_found",
          void 0,
          `atrium skill show ${row3.slug}`
        );
      return { slug: row3.slug, node: where, bound: false };
    }
    if (row3.archived_at !== null)
      throw new Problem(400, `\u6280\u80FD ${row3.slug} \u5DF2\u5F52\u6863\uFF0C\u4E0D\u80FD\u7ED1\u5B9A`, "usage");
    if (one2(
      db,
      "SELECT 1 FROM org_skill_bindings WHERE skill_id=? AND node_id=?",
      row3.id,
      node.id
    ))
      throw new Problem(
        409,
        `${row3.slug} \u5DF2\u7ED1\u5728 ${where}`,
        "conflict",
        void 0,
        `atrium skill show ${row3.slug}`
      );
    db.prepare(
      "INSERT INTO org_skill_bindings(skill_id,node_id,created_by,created_at) VALUES(?,?,?,?)"
    ).run(row3.id, node.id, actor, Date.now());
    return { slug: row3.slug, node: where, bound: true };
  });
}
function bindingsOf(db, list4, skillId) {
  return all2(
    db,
    "SELECT node_id FROM org_skill_bindings WHERE skill_id=? ORDER BY node_id LIMIT 500",
    skillId
  ).map((b) => ownerLabel(list4, b.node_id));
}
function listSkills(db, includeArchived = false) {
  const list4 = nodes(db);
  const pending = new Map(
    all2(
      db,
      "SELECT skill_id, count(*) n FROM org_skill_proposals WHERE status='pending' GROUP BY skill_id"
    ).map((r) => [r.skill_id, r.n])
  );
  return all2(
    db,
    `SELECT * FROM org_skills ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY slug LIMIT ?`,
    LIMITS.skills
  ).map((row3) => ({
    slug: row3.slug,
    name: row3.name,
    description: row3.description,
    rev: rev(row3.rev),
    owner: ownerLabel(list4, row3.owner_node_id),
    bound: bindingsOf(db, list4, row3.id),
    files: Object.keys(filesOf(row3)).length,
    pending: pending.get(row3.id) ?? 0,
    archived: row3.archived_at !== null
  }));
}
function showSkill(db, slug) {
  const row3 = skillBySlug(db, slug);
  const list4 = nodes(db);
  const files = filesOf(row3);
  return {
    slug: row3.slug,
    name: row3.name,
    description: row3.description,
    rev: rev(row3.rev),
    owner: ownerLabel(list4, row3.owner_node_id),
    archived: row3.archived_at !== null,
    bound: bindingsOf(db, list4, row3.id),
    files,
    sizes: Object.fromEntries(
      Object.entries(files).map(([path, text6]) => [
        path,
        Buffer.byteLength(text6)
      ])
    ),
    pending: all2(
      db,
      "SELECT * FROM org_skill_proposals WHERE skill_id=? AND status='pending' ORDER BY id LIMIT 20",
      row3.id
    ).map((p3) => ({
      ref: proposalRef(p3.id),
      task: taskRef(p3.task_id),
      base: rev(p3.base_rev)
    }))
  };
}
function skillHistory(db, slug, query2 = {}) {
  const row3 = skillBySlug(db, slug);
  if (query2.rev) {
    const at = parseRev(query2.rev, "rev");
    const after = revisionAt(db, row3, at);
    const before2 = at > 1 ? revisionAt(db, row3, at - 1) : void 0;
    const meta = one2(
      db,
      "SELECT * FROM org_skill_revisions WHERE skill_id=? AND rev=?",
      row3.id,
      at
    );
    return {
      slug: row3.slug,
      revision: { ...revisionView(meta) },
      diff: filesDiff(before2?.files ?? {}, after.files),
      meta: ["name", "description", "owner", "archived"].filter((key) => before2 && before2[key] !== after[key]).map((key) => ({
        field: key,
        before: before2[key],
        after: after[key]
      }))
    };
  }
  const limit = Math.min(Math.max(Math.trunc(query2.limit ?? 20) || 20, 1), 100);
  const before = query2.before ? parseRev(query2.before, "before") : void 0;
  const items = all2(
    db,
    `SELECT * FROM org_skill_revisions WHERE skill_id=? ${before === void 0 ? "" : "AND rev<?"} ORDER BY rev DESC LIMIT ?`,
    ...before === void 0 ? [row3.id, limit + 1] : [row3.id, before, limit + 1]
  );
  return {
    slug: row3.slug,
    items: items.slice(0, limit).map(revisionView),
    has_more: items.length > limit
  };
}
function revisionView(r) {
  return {
    rev: rev(r.rev),
    author: r.author,
    reviewer: r.reviewer,
    at: r.at,
    reason: r.reason,
    source: r.source
  };
}
function listProposals(db, query2 = {}) {
  const status = query2.status ?? "pending";
  if (!["pending", "accepted", "rejected", "all"].includes(status))
    throw new Problem(
      400,
      "status \u53EA\u80FD\u662F pending\u3001accepted\u3001rejected \u6216 all",
      "usage"
    );
  const limit = Math.min(Math.max(Math.trunc(query2.limit ?? 50) || 50, 1), 200);
  return all2(
    db,
    `SELECT p.*, s.slug slug, s.rev current FROM org_skill_proposals p JOIN org_skills s ON s.id=p.skill_id
     ${status === "all" ? "" : "WHERE p.status=?"} ORDER BY p.id DESC LIMIT ?`,
    ...status === "all" ? [limit] : [status, limit]
  ).map((p3) => ({
    ref: proposalRef(p3.id),
    skill: p3.slug,
    task: taskRef(p3.task_id),
    base: rev(p3.base_rev),
    current: rev(p3.current),
    status: p3.status,
    reason: p3.reason,
    created_at: p3.created_at,
    result: p3.result_rev === null ? null : rev(p3.result_rev)
  }));
}
function showProposal(db, value) {
  const p3 = proposalById(db, value);
  const skill = one2(
    db,
    "SELECT * FROM org_skills WHERE id=?",
    p3.skill_id
  );
  const base2 = revisionAt(db, skill, p3.base_rev);
  return {
    ref: proposalRef(p3.id),
    skill: skill.slug,
    task: taskRef(p3.task_id),
    base: rev(p3.base_rev),
    current: rev(skill.rev),
    status: p3.status,
    reason: p3.reason,
    decided_by: p3.decided_by,
    decision_reason: p3.decision_reason,
    result: p3.result_rev === null ? null : rev(p3.result_rev),
    files: filesOf(p3),
    diff: filesDiff(base2.files, filesOf(p3))
  };
}
function decide(db, p3, status, actor, reason, result) {
  db.prepare(
    "UPDATE org_skill_proposals SET status=?,decided_by=?,decided_at=?,decision_reason=?,result_rev=? WHERE id=? AND status='pending'"
  ).run(status, actor, Date.now(), reason, result, p3.id);
}
function acceptProposal(db, value, reasonText, actor) {
  return transaction(db, () => {
    const p3 = proposalById(db, value);
    if (p3.status !== "pending")
      throw new Problem(
        409,
        `${proposalRef(p3.id)} \u5DF2${p3.status === "accepted" ? "\u91C7\u7EB3" : "\u9A73\u56DE"}`,
        "conflict"
      );
    const row3 = one2(
      db,
      "SELECT * FROM org_skills WHERE id=?",
      p3.skill_id
    );
    authorize2(nodes(db), row3.owner_node_id, actor, "\u5BA1\u6838\u6280\u80FD\u63D0\u8BAE");
    const reason = reasonText === void 0 || reasonText === null || reasonText === "" ? `\u91C7\u7EB3 ${proposalRef(p3.id)}\uFF1A${p3.reason}`.slice(0, 500) : validateReason(reasonText);
    const theirs = filesOf(p3);
    let files = theirs;
    let merged = false;
    if (p3.base_rev !== row3.rev) {
      const base2 = revisionAt(db, row3, p3.base_rev).files;
      const result = mergeFiles(base2, filesOf(row3), theirs);
      if (result.conflicts.length)
        throw new Problem(
          409,
          `${proposalRef(p3.id)} \u57FA\u4E8E ${rev(p3.base_rev)}\uFF0C\u6280\u80FD\u5DF2\u662F ${rev(row3.rev)}\uFF0C\u5408\u5E76\u6709\u51B2\u7A81\uFF1A${result.conflicts.join("\u3001")}\uFF1B\u624B\u5DE5\u5408\u5E76\u540E\u5199\u56DE`,
          "conflict",
          void 0,
          `atrium skill proposal ${proposalRef(p3.id)}`
        );
      files = result.files;
      merged = true;
    }
    const meta = skillMeta(row3.slug, validateFiles(files));
    if (sameFiles(meta.files, filesOf(row3)))
      throw new Problem(
        409,
        `${proposalRef(p3.id)} \u7684\u6539\u52A8\u5DF2\u5728\u5F53\u524D\u7248\u91CC\uFF0C\u76F4\u63A5\u9A73\u56DE\u5373\u53EF`,
        "conflict",
        void 0,
        `atrium skill reject ${proposalRef(p3.id)} --reason \u5DF2\u5305\u542B`
      );
    const next = commit(
      db,
      row3,
      { files: meta.files, description: meta.description },
      taskRef(p3.task_id),
      reason,
      proposalRef(p3.id),
      actor
    );
    decide(db, p3, "accepted", actor, reason, next.rev);
    return {
      ref: proposalRef(p3.id),
      slug: row3.slug,
      before: rev(row3.rev),
      rev: rev(next.rev),
      merged
    };
  });
}
function rejectProposal(db, value, reasonText, actor) {
  return transaction(db, () => {
    const p3 = proposalById(db, value);
    if (p3.status !== "pending")
      throw new Problem(
        409,
        `${proposalRef(p3.id)} \u5DF2${p3.status === "accepted" ? "\u91C7\u7EB3" : "\u9A73\u56DE"}`,
        "conflict"
      );
    const row3 = one2(
      db,
      "SELECT * FROM org_skills WHERE id=?",
      p3.skill_id
    );
    authorize2(nodes(db), row3.owner_node_id, actor, "\u5BA1\u6838\u6280\u80FD\u63D0\u8BAE");
    const reason = validateReason(reasonText);
    decide(db, p3, "rejected", actor, reason, null);
    return { ref: proposalRef(p3.id), slug: row3.slug, status: "rejected" };
  });
}
function recordProposal(db, input) {
  return transaction(db, () => {
    const text6 = JSON.stringify(input.files);
    const existing = one2(
      db,
      "SELECT id FROM org_skill_proposals WHERE task_id=? AND skill_id=? AND files=? LIMIT 1",
      input.taskId,
      input.skillId,
      text6
    );
    if (existing) return { id: existing.id, created: false };
    const id3 = Number(
      db.prepare(
        "INSERT INTO org_skill_proposals(skill_id,task_id,base_rev,files,reason,created_at) VALUES(?,?,?,?,?,?)"
      ).run(
        input.skillId,
        input.taskId,
        input.baseRev,
        text6,
        Array.from(input.reason).slice(0, LIMITS.proposalReason).join(""),
        Date.now()
      ).lastInsertRowid
    );
    return { id: id3, created: true };
  });
}
function filesAt(db, skillId, at) {
  const found = one2(
    db,
    "SELECT snapshot FROM org_skill_revisions WHERE skill_id=? AND rev=?",
    skillId,
    at
  );
  return found ? JSON.parse(found.snapshot).files : void 0;
}
function ownerOf2(db, skillId) {
  const row3 = one2(db, "SELECT * FROM org_skills WHERE id=?", skillId);
  if (!row3 || row3.owner_node_id === null) return { node: null, leader: "u1" };
  const list4 = nodes(db);
  let current2 = list4.find((n) => n.id === row3.owner_node_id);
  const node = ownerLabel(list4, row3.owner_node_id);
  while (current2) {
    if (current2.leader) return { node, leader: current2.leader };
    const parent = current2.parent_id;
    current2 = list4.find((n) => n.id === parent);
  }
  return { node, leader: "u1" };
}

// server/skills/collect.ts
function notes(dir) {
  try {
    const text6 = readFileSync7(join14(dir, NOTES), "utf8").trim();
    return Array.from(text6).slice(0, LIMITS.proposalReason).join("");
  } catch {
    return "";
  }
}
function collectSkillEdits(db, taskId, dir) {
  const manifest = readManifest(dir);
  const proposals = [];
  const problems = [];
  if (!manifest) return { proposals, problems };
  const reason = notes(dir) || "\u6267\u884C\u8005\u6CA1\u5199\u539F\u56E0\uFF08\u89C1\u4EFB\u52A1\u7ED3\u679C\uFF09";
  for (const entry of manifest.skills) {
    const base2 = filesAt(db, entry.id, entry.rev);
    if (!base2) continue;
    const read = readMounted(entry.dir);
    if ("problem" in read) {
      problems.push(`${entry.slug}\uFF1A${read.problem}\uFF0C\u6CA1\u751F\u6210\u63D0\u8BAE`);
      continue;
    }
    if (sameFiles(read.files, base2)) continue;
    try {
      const files = validateFiles(read.files);
      skillMeta(entry.slug, files);
      const { id: id3, created } = recordProposal(db, {
        skillId: entry.id,
        taskId,
        baseRev: entry.rev,
        files,
        reason
      });
      if (created)
        proposals.push({
          proposal: proposalRef(id3),
          slug: entry.slug,
          base: `r${entry.rev}`,
          owner: ownerOf2(db, entry.id)
        });
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      problems.push(
        `${entry.slug}\uFF1A\u6539\u52A8\u4E0D\u5408\u89C4\uFF08${error.message}\uFF09\uFF0C\u6CA1\u751F\u6210\u63D0\u8BAE`
      );
    }
  }
  return { proposals, problems };
}

// server/tasks/job-mismatch.ts
function jobMismatch(role, files) {
  if (files.length < 2) return null;
  const ui = files.filter(
    (path) => /(^|\/)(web|frontend|components|pages)\/|\.(tsx|jsx|vue|svelte|css|scss|html)$/i.test(
      path
    )
  ).length;
  if (role === "\u540E\u7AEF" && ui > files.length / 2)
    return `\u4EFB\u52A1\u6807\u4E3A\u540E\u7AEF\uFF0C\u4F46 ${ui}/${files.length} \u4E2A\u6539\u52A8\u6587\u4EF6\u5C5E\u4E8E\u754C\u9762\uFF0C\u8BF7\u6838\u5BF9\u5E72\u6D3B\u7684\u4E13\u5458`;
  if (role === "\u524D\u7AEF" && files.length - ui > files.length / 2)
    return `\u4EFB\u52A1\u6807\u4E3A\u524D\u7AEF\uFF0C\u4F46 ${files.length - ui}/${files.length} \u4E2A\u6539\u52A8\u6587\u4EF6\u5C5E\u4E8E\u975E\u754C\u9762\uFF0C\u8BF7\u6838\u5BF9\u5E72\u6D3B\u7684\u4E13\u5458`;
  return null;
}

// server/tasks/concern-runtime.ts
import { mkdirSync as mkdirSync6, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join15 } from "node:path";
var TITLE_MAX2 = 200;
var clipTitle = (text6) => Array.from(text6).length > TITLE_MAX2 ? `${Array.from(text6).slice(0, TITLE_MAX2 - 1).join("")}\u2026` : text6;
function invitedFor(db, id3) {
  if (reviewRowOf(db, id3)) return [];
  return concernRows(db, id3).map((row3) => row3.node_id);
}
var reviewRowOf = (db, id3) => one(
  db,
  "SELECT task_id FROM task_concerns WHERE review_id=? LIMIT 1",
  id3
);
var isReviewTask = (db, id3) => !!reviewRowOf(db, id3);
function openReviews(db, data2, parentId, facts) {
  const parent = getTask(db, parentId);
  const dir = taskDir(data2, parentId);
  mkdirSync6(dir, { recursive: true, mode: 448 });
  const diff = facts ? {
    files: facts.numstat.length,
    added: facts.numstat.reduce((sum, s) => sum + s.added, 0),
    removed: facts.numstat.reduce((sum, s) => sum + s.removed, 0),
    list: facts.numstat.map(
      (s) => `${s.file}\uFF08+${s.added} \u2212${s.removed}\uFF09`
    )
  } : void 0;
  const refs = [];
  const now = Date.now();
  for (const row3 of concernRows(db, parentId)) {
    const checklist = checklistOf(db, row3.node_id);
    const brief2 = join15(dir, `concern-${checklist.ref}-${now}.md`);
    const text6 = clipBrief(
      reviewBrief({
        checklist,
        task: { ref: parent.ref, title: parent.title },
        pr_url: parent.pr_url,
        worktree: parent.worktree,
        branch: parent.branch,
        base: facts?.base ?? null,
        diff
      })
    );
    writeFileSync7(brief2, text6, { mode: 384 });
    const review = createTask(db, {
      title: clipTitle(
        `\u4E13\u5458\u5BA1\u67E5\uFF1A${checklist.name} \xB7 ${parent.ref} ${parent.title}`
      ),
      parent: parent.ref,
      ...row3.node_id < 0 ? { job: checklist.ref } : { role: checklist.ref },
      deliver: "none",
      brief: text6,
      brief_path: brief2,
      ...parent.owner ? { owner: parent.owner } : {},
      ...parent.part_ref ? { part: parent.part_ref } : {}
    });
    db.prepare(
      "UPDATE task_concerns SET review_id=?,verdict=NULL,reason=NULL,decided_at=NULL WHERE task_id=? AND node_id=?"
    ).run(review.id, parentId, row3.node_id);
    refs.push(review.ref);
  }
  noteTask(db, parentId, "concern_review_started", {
    reviews: concernsOf(db, parentId).map((c) => ({
      concern: c.ref,
      name: c.name,
      review: c.review
    }))
  });
  return refs;
}
function blockUnsent(db, ref2, reason) {
  const task = getTask(db, ref2);
  if (task.status === "todo")
    advanceTask(
      db,
      ref2,
      { kind: "block" },
      {},
      {
        reason: `\u5BA1\u67E5\u4EFB\u52A1\u62C9\u4E0D\u8D77\u6765\uFF1A${reason}`
      }
    );
}
function settleReviews(db, busy = () => false, limit = 50) {
  const rows = all(
    db,
    `SELECT c.task_id, c.node_id, c.review_id, r.status, r.result, r.updated_at
       FROM task_concerns c JOIN tasks r ON r.id=c.review_id
      WHERE r.status IN ('done','failed','cancelled','blocked')
        AND (c.decided_at IS NULL OR r.updated_at > c.decided_at)
      ORDER BY c.task_id, c.pos LIMIT ?`,
    limit
  );
  const parents = /* @__PURE__ */ new Set();
  for (const row3 of rows) {
    if (busy(row3.review_id)) continue;
    const blockedReason = row3.status === "blocked" || row3.status === "failed" ? lastReason2(
      db,
      row3.review_id,
      row3.status === "blocked" ? "block" : "exit_fail"
    ) : null;
    const conclusion = reviewConclusion(row3.status, row3.result, blockedReason);
    if (!conclusion) continue;
    db.prepare(
      "UPDATE task_concerns SET verdict=?,reason=?,decided_at=? WHERE task_id=? AND node_id=? AND review_id=?"
    ).run(
      conclusion.verdict,
      conclusion.reason,
      row3.updated_at,
      row3.task_id,
      row3.node_id,
      row3.review_id
    );
    noteTask(db, row3.task_id, "concern_review", {
      concern: row3.node_id < 0 ? `r${-row3.node_id}` : `o${row3.node_id}`,
      review: taskRef(row3.review_id),
      verdict: conclusion.verdict,
      reason: conclusion.reason
    });
    parents.add(row3.task_id);
  }
  const resolved = [];
  for (const id3 of parents) {
    const parent = getTask(db, id3);
    const concerns = concernsOf(db, id3);
    const outcome = concernOutcome(concerns);
    if (outcome.kind === "none" || outcome.kind === "waiting") continue;
    if (parent.status !== "blocked") continue;
    if (outcome.kind === "passed") {
      const ciPending = awaitingCi(db, id3) && parent.ci !== "success";
      noteTask(db, id3, "concern_gate", {
        passed: true,
        reason: outcome.reason,
        ...ciPending ? { awaiting_ci: true } : {}
      });
      if (ciPending) continue;
      advanceTask(db, id3, { kind: "accept" }, {}, { reason: outcome.reason });
      resolved.push({ parent: id3, outcome, concerns, accepted: true });
    } else {
      noteTask(db, id3, "concern_gate", {
        passed: false,
        vetoed: outcome.kind === "vetoed",
        reason: outcome.reason
      });
      resolved.push({ parent: id3, outcome, concerns, accepted: false });
    }
  }
  return resolved;
}
function lastReason2(db, id3, kind) {
  return reasonOf(
    all(
      db,
      "SELECT * FROM task_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
      id3,
      kind
    ),
    kind
  );
}

// server/tasks/executors.ts
var Executors = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  active = /* @__PURE__ */ new Map();
  /** 正在准备（建 worktree、写提示词）的任务及其工具，防止重复派与独占冲突。 */
  launching = /* @__PURE__ */ new Map();
  /** 退出收尾期间仍可能自动重派；wait 不应把中途状态当作最终结果。 */
  finishing = /* @__PURE__ */ new Map();
  ticking = false;
  async pace() {
    try {
      return await (this.ctx.launchOptions.usagePace ?? readPace)();
    } catch {
      return void 0;
    }
  }
  isClosed() {
    return this.ctx.closed();
  }
  busy(tool, except) {
    for (const active of this.active.values())
      if (active.tool === tool && active.id !== except && !active.exited)
        return true;
    for (const [id3, launching] of this.launching)
      if (launching === tool && id3 !== except) return true;
    return false;
  }
  /** 在跑（未退出）与正在启动的执行者个数，except 除外；本机并发上限按它算。 */
  inFlight(except) {
    const ids = /* @__PURE__ */ new Set();
    for (const active of this.active.values())
      if (!active.exited) ids.add(active.id);
    for (const id3 of this.launching.keys()) ids.add(id3);
    ids.delete(except ?? -1);
    return ids.size;
  }
  /** 已有任务在跑（或正在启动）的工具，except 除外；自动挑人时据此避开正忙的独占执行者。 */
  busyTools(except) {
    const tools = /* @__PURE__ */ new Set();
    for (const active of this.active.values())
      if (active.id !== except && !active.exited) tools.add(active.tool);
    for (const [id3, launching] of this.launching)
      if (launching && id3 !== except) tools.add(launching);
    return tools;
  }
  publish(id3, kind, detail2, actor) {
    publishTask(this.ctx.inbox, this.ctx.db, id3, kind, detail2, actor);
  }
  advance(id3, event, fields = {}, detail2) {
    return advanceTask(this.ctx.db, taskRef(id3), event, fields, detail2);
  }
  async launch(id3, chosen, retried = false) {
    if (this.ctx.closed()) throw new Error("\u670D\u52A1\u5DF2\u5173\u95ED");
    const task = getTask(this.ctx.db, id3);
    await this.ctx.disk.check(task.node_id, task.repo);
    const prepared = await prepareRun(task, chosen, this.ctx.launchOptions);
    const usagePace = await this.pace();
    if (this.ctx.closed()) throw new Error("\u670D\u52A1\u5DF2\u5173\u95ED");
    const env = { ...this.ctx.launchOptions.env };
    if (patrolRun(this.ctx.db, id3)) {
      delete env.ATRIUM_WORKER;
      Object.assign(env, this.ctx.launchOptions.patrolServiceEnv);
    }
    const { child, offset } = await spawnWorker(prepared, env, task.ref);
    const pid = child.pid;
    if (this.ctx.closed()) {
      signalGroup(pid, "SIGKILL");
      throw new Error("\u670D\u52A1\u5DF2\u5173\u95ED");
    }
    let started;
    try {
      started = this.advance(
        id3,
        { kind: "start" },
        {
          worker: chosen.worker.id,
          pid,
          worktree: prepared.worktree,
          branch: prepared.branch,
          pr_url: null,
          ci: null,
          result: null
        },
        {
          worker: chosen.worker.id,
          risk: chosen.risk,
          cwd: prepared.cwd,
          ...retried ? { retry: true } : {}
        }
      );
    } catch (error) {
      signalGroup(pid, "SIGKILL");
      throw error;
    }
    markDelivered(this.ctx.db, id3, prepared.tellIds, "prompt");
    await this.track(
      started,
      chosen,
      prepared,
      child,
      offset,
      retried,
      usagePace
    );
    return started;
  }
  /**
   * 同一轮里换进程（#307 捎话）：带着补充续上原会话（resume），或保留工作树带着补充重派（未给 resume）。
   * 任务保持 running，只换 pid；关卡按新进程退出后的结果判。
   */
  async relaunch(prev, resume) {
    if (this.ctx.closed()) throw new Error("\u670D\u52A1\u5DF2\u5173\u95ED");
    const id3 = prev.id;
    const task = getTask(this.ctx.db, id3);
    const chosen = { worker: prev.worker, risk: prev.risk };
    const prepared = await prepareRun(
      task,
      chosen,
      this.ctx.launchOptions,
      resume
    );
    const usagePace = await this.pace();
    if (this.ctx.closed()) throw new Error("\u670D\u52A1\u5DF2\u5173\u95ED");
    const { child, offset } = await spawnWorker(
      prepared,
      this.ctx.launchOptions.env,
      task.ref,
      !!resume
    );
    const pid = child.pid;
    const ids = resume ? resume.ids : prepared.tellIds;
    const updated = patchRunFields(
      this.ctx.db,
      id3,
      { pid },
      resume ? "tell_resumed" : "tell_restarted",
      { pid, worker: prev.worker.id, tells: ids.length }
    );
    markDelivered(this.ctx.db, id3, ids, resume ? "resume" : "restart");
    await this.track(
      updated,
      chosen,
      prepared,
      child,
      offset,
      prev.retried,
      usagePace
    );
  }
  async track(task, chosen, prepared, child, offset, retried, usagePace) {
    const id3 = task.id;
    const active = launched({
      task,
      pid: child.pid,
      child,
      prepared,
      retried,
      exec: this.ctx.exec,
      ...chosen
    });
    if (prepared.launch.input === "stream-json" && child.stdin)
      active.live = new LiveInput(
        child.stdin,
        prepared.logFile,
        offset,
        (uuid) => markEchoed(this.ctx.db, id3, uuid)
      );
    this.active.set(id3, active);
    beginUsage(
      this.ctx.db,
      id3,
      ADAPTERS[chosen.worker.tool].quotaProvider,
      usagePace
    );
    child.once(
      "exit",
      (code, signal) => void this.finish(id3, { code, signal })
    );
    await active.probe.baseline();
    this.ctx.waits.changed(id3);
  }
  // ---- 退出收尾 ----
  async finish(id3, exit) {
    const active = this.active.get(id3);
    if (!active || active.exited) return;
    active.exited = true;
    this.finishing.set(id3, (this.finishing.get(id3) ?? 0) + 1);
    try {
      if (active.finalizing?.forced) {
        noteTask(this.ctx.db, id3, "final_result_exit", {
          ...exitDetail(exit),
          result: active.finalizing.result
        });
        exit = "unknown";
      }
      endUsage(
        this.ctx.db,
        id3,
        ADAPTERS[active.tool].quotaProvider,
        await this.pace()
      );
      if (await followUpTells(this, this.ctx.db, active, exit)) return;
      const jobId = getTask(this.ctx.db, id3).job_id;
      if (jobId) {
        const job = getJobRole(this.ctx.db, `r${jobId}`);
        active.worker.profile.rules.checks = [
          .../* @__PURE__ */ new Set([
            ...active.worker.profile.rules.checks ?? [],
            ...activeJobChecks(this.ctx.db, id3) ?? job.checks
          ])
        ];
      }
      const outcome = await settle(
        active,
        exit,
        this.ctx.exec,
        (status, log) => {
          noteTask(this.ctx.db, id3, `local_check_${status}`, { log });
          this.ctx.waits.changed(id3);
        },
        this.ctx.launchOptions.env,
        getTask(this.ctx.db, id3).urgent === 1
      );
      if (this.ctx.closed()) return;
      this.collectSkills(active);
      if (getTask(this.ctx.db, id3).status !== "running") return;
      const { verdict: verdict2, facts } = outcome;
      let { decision } = outcome;
      if (outcome.localCheck)
        noteTask(this.ctx.db, id3, "local_check", outcome.localCheck);
      if (outcome.workerGuardRefused)
        noteTask(this.ctx.db, id3, "worker_guard_refused", {
          reason: "\u6267\u884C\u65E5\u5FD7\u51FA\u73B0 Atrium \u6267\u884C\u8005\u9632\u62A4\u7684\u56FA\u5B9A\u62D2\u7EDD\u8BED\u53E5"
        });
      const detail2 = exitDetail(exit);
      if (verdict2)
        noteTask(this.ctx.db, id3, "gates", {
          worker: active.worker.id,
          passed: verdict2.passed,
          awaiting_ci: verdict2.awaitingCi,
          results: verdict2.results,
          ...facts ? { diff: diffSize(facts) } : {},
          ...detail2
        });
      if (facts && jobId) {
        const mismatch = jobMismatch(
          getJobRole(this.ctx.db, `r${jobId}`).name,
          facts.numstat.map((s) => s.file)
        );
        if (mismatch)
          noteTask(this.ctx.db, id3, "job_mismatch", { reason: mismatch });
      }
      const hints = facts ? fileHints(
        this.ctx.db,
        id3,
        facts.numstat.map((stat5) => stat5.file)
      ) : [];
      if (hints.length)
        noteTask(this.ctx.db, id3, "concern_hints", {
          hints,
          next: `atrium task set ${taskRef(id3)} --concern ${hints.map((h) => h.ref).join(",")}`
        });
      const reviewing = !outcome.quota && !!verdict2 && (decision.event === "exit_ok" || decision.event === "block" && verdict2.awaitingCi) && needsReview(invitedFor(this.ctx.db, id3).length);
      if (reviewing)
        decision = {
          event: "block",
          publish: "blocked",
          retry: false,
          reason: [decision.reason, "\u7B49\u4E13\u5458\u5BA1\u67E5"].filter(Boolean).join("\uFF1B")
        };
      this.advance(id3, { kind: decision.event }, outcome.fields, {
        ...decision.reason ? { reason: decision.reason } : {},
        ...verdict2 && !verdict2.passed ? { gates: verdict2.failed.map((r) => r.gate) } : {},
        ...detail2
      });
      if (reviewing) {
        await this.openReviews(id3, facts);
        return;
      }
      const retryContext = {
        db: this.ctx.db,
        launchOptions: this.ctx.launchOptions,
        held: () => this.ctx.quota.held()
      };
      const published = {
        ...decision.reason ? { reason: decision.reason } : {},
        ...decision.publish === "done" && facts ? { diff: diffSize(facts) } : {},
        ...verdict2 && !verdict2.passed ? { gates: verdict2.failed } : {},
        ...hints.length ? {
          concern_hints: hints.map(hintText),
          next: `\u8981\u8BF7\u4E13\u5458\u590D\u5BA1\uFF1Aatrium task set ${taskRef(id3)} --concern ${hints.map((h) => h.ref).join(",")}\uFF0C\u518D atrium task run ${taskRef(id3)}`
        } : {}
      };
      let admitted = false;
      const thinking = routeAfterThinking({
        thinking: outcome.ending?.kind === "thinking",
        stop: active.stop,
        decision,
        verdict: verdict2,
        attempts: outcome.ending?.kind === "thinking" ? attemptsOf(retryContext, id3) : 0
      });
      if (outcome.quota)
        await this.ctx.quota.exhausted(this, active, outcome.quota);
      else if (decision.retry) await this.retry(active, decision.reason);
      else if (outcome.transient)
        await retryAfterTransient(
          this,
          retryContext,
          active,
          outcome.transient,
          decision.reason ?? outcome.transient.reason
        );
      else if (thinking.kind !== "none")
        await retryAfterThinking(
          this,
          retryContext,
          active,
          thinking,
          decision,
          published
        );
      else if (isReviewTask(this.ctx.db, id3)) {
      } else if (isOpinionTask(this.ctx.db, id3) || decision.publish === "done" && isCouncilTask(this.ctx.db, id3)) {
      } else if (patrolRun(this.ctx.db, id3)) {
        finishPatrol(this.ctx.db, this.ctx.inbox, id3);
        if (decision.publish !== "done")
          this.publish(id3, decision.publish, published);
      } else if (decision.publish === "done" && (admitted = await this.ctx.onAccepted?.(id3) ?? false)) {
        this.publish(id3, admitted.kind, { ...published, ...admitted.detail });
      } else
        this.publish(
          id3,
          decision.publish,
          published,
          active.stop?.kind === "user" ? active.stop.by : void 0
        );
      if (!isReviewTask(this.ctx.db, id3))
        publishWorkerAdvice(this.ctx.db, this.ctx.inbox, id3);
      if (isReviewTask(this.ctx.db, id3)) this.ctx.reviews?.settle();
      if (isOpinionTask(this.ctx.db, id3) || isCouncilTask(this.ctx.db, id3))
        this.ctx.councils?.settle();
    } catch (error) {
      this.failAfterError(id3, error);
    } finally {
      if (this.active.get(id3) === active) this.active.delete(id3);
      const remaining = this.finishing.get(id3) - 1;
      if (remaining) this.finishing.set(id3, remaining);
      else this.finishing.delete(id3);
      this.ctx.waits.changed(id3);
      if (!this.ctx.closed()) void this.drain();
    }
  }
  /** 建本轮专员审查任务并逐个拉起；拉不起的标受阻，由巡检判为没出结论。 */
  async openReviews(id3, facts) {
    const refs = openReviews(
      this.ctx.db,
      this.ctx.launchOptions.data,
      id3,
      facts
    );
    for (const ref2 of refs) {
      try {
        if (!this.ctx.reviews) throw new Error("\u8FD0\u884C\u65F6\u6CA1\u6709\u63A5\u4E0A\u4E13\u5458\u5BA1\u67E5");
        await this.ctx.reviews.dispatch(ref2);
      } catch (error) {
        blockUnsent(
          this.ctx.db,
          ref2,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    this.ctx.reviews?.settle();
  }
  /** 执行者改了挂载的技能副本：生成修订提议，通知任务负责人（事件里带技能 owner 与其 leader）。 */
  collectSkills(active) {
    try {
      const { proposals, problems } = collectSkillEdits(
        this.ctx.db,
        active.id,
        dirname4(active.logFile)
      );
      if (problems.length)
        noteTask(this.ctx.db, active.id, "skill_proposal_skipped", {
          problems
        });
      if (!proposals.length) return;
      const task = getTask(this.ctx.db, active.id);
      for (const p3 of proposals) {
        noteTask(this.ctx.db, active.id, "skill_proposal", p3);
        this.ctx.inbox.publish({
          subscriber: taskRoute(this.ctx.db, task).subscriber,
          taskId: active.id,
          source: "runner",
          kind: "skill_proposal",
          key: `${task.ref}:skill:${p3.proposal}`,
          detail: {
            title: task.title,
            ...p3,
            next: `atrium skill proposal ${p3.proposal}`
          }
        });
      }
    } catch (error) {
      console.error(`\u4EFB\u52A1 ${taskRef(active.id)} \u56DE\u6536\u6280\u80FD\u6539\u52A8\u5931\u8D25\uFF1A`, error);
    }
  }
  async retry(active, reason) {
    if (this.ctx.closed()) return;
    this.publish(active.id, "stalled", { reason, retry: true });
    this.active.delete(active.id);
    try {
      await this.launch(
        active.id,
        { worker: active.worker, risk: active.risk },
        true
      );
    } catch (error) {
      if (this.ctx.closed()) return;
      const why = `\u5361\u6B7B\u540E\u91CD\u8BD5\u62C9\u8D77\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
      noteTask(this.ctx.db, active.id, "retry_failed", { reason: why });
      this.publish(active.id, "failed", { reason: why });
    }
  }
  failAfterError(id3, error) {
    if (this.ctx.closed()) return;
    console.error(`\u4EFB\u52A1 ${taskRef(id3)} \u6536\u5C3E\u5931\u8D25\uFF1A`, error);
    try {
      if (getTask(this.ctx.db, id3).status !== "running") return;
      const reason = `\u6536\u5C3E\u51FA\u9519\uFF1A${error instanceof Error ? error.message : String(error)}`;
      this.advance(id3, { kind: "exit_fail" }, {}, { reason });
      this.publish(id3, "failed", { reason });
    } catch {
    }
  }
  // ---- 看门狗、重启自愈、排队、CI ----
  async tick() {
    if (this.ticking || this.ctx.closed()) return;
    this.ticking = true;
    try {
      for (const active of [...this.active.values()]) {
        if (active.exited) continue;
        if (!active.child && !alive(active.pid)) {
          void this.finish(active.id, "unknown");
          continue;
        }
        if (active.stop || active.finalizing) continue;
        const { signals } = await active.probe.poll();
        if (signals.length) active.state.lastProgressAt = Date.now();
        const verdict2 = judge(active.state, active.limits, Date.now());
        if (verdict2.kind === "ok") continue;
        if (active.tool === "claude") {
          const result = await logTail2(active.logFile, 1024 * 1024).then(finalClaudeResult).catch(() => void 0);
          if (result) {
            active.finalizing = { result, forced: false };
            noteTask(this.ctx.db, active.id, "finalizing", {
              reason: "\u6700\u7EC8 result \u5DF2\u8F93\u51FA\uFF0C\u6267\u884C\u8005\u4ECD\u672A\u9000\u51FA\uFF0C\u50AC\u4FC3\u6536\u5C3E",
              result
            });
            if (active.live?.open) {
              active.live.end();
              setTimeout(
                () => this.forceFinalExit(active),
                this.ctx.killGraceMs ?? 1e4
              ).unref();
            } else this.forceFinalExit(active);
            continue;
          }
        }
        active.stop = verdict2;
        noteTask(this.ctx.db, active.id, verdict2.kind, {
          reason: verdict2.reason
        });
        this.kill(active);
      }
    } finally {
      this.ticking = false;
    }
  }
  forceFinalExit(active) {
    if (active.exited || !active.finalizing || active.finalizing.forced) return;
    active.finalizing.forced = true;
    signalGroup(active.pid, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) signalGroup(active.pid, "SIGKILL");
    }, this.ctx.killGraceMs ?? 1e4).unref();
  }
  kill(active) {
    signalGroup(active.pid, "SIGTERM");
    setTimeout(() => {
      if (!active.exited) signalGroup(active.pid, "SIGKILL");
    }, this.ctx.killGraceMs ?? 1e4).unref();
  }
  /**
   * 拉起排队中的任务：每个工具的队首（紧急的在前），前提是独占工具空闲、账号额度标记已解除、本机没满也不太忙（紧急的不看这两条）；
   * 返回出队几个。几处（退出收尾、巡检、额度解除）可能同时调用，出队以删到队列行为准。
   */
  async drain(tool) {
    if (this.ctx.closed()) return 0;
    const held = this.ctx.quota.held();
    let moved = 0;
    for (const entry of heads(this.ctx.db, tool)) {
      const entryTool = entry.tool;
      if (this.ctx.closed() || held.has(ADAPTERS[entryTool].quotaProvider))
        continue;
      if (ADAPTERS[entryTool].exclusive && this.busy(entryTool)) continue;
      const gate = this.ctx.hostGate?.(entry.urgent);
      if (gate && !gate.ok) break;
      if (!dequeue(this.ctx.db, entry.task_id)) continue;
      moved++;
      this.launching.set(entry.task_id, entryTool);
      try {
        const worker = await resolveWorker(
          entry.worker,
          this.ctx.launchOptions.db
        );
        if (this.ctx.closed()) return moved;
        const task = getTask(this.ctx.db, entry.task_id);
        await chooseWorker(
          { worker: worker.id, risk: entry.risk },
          this.ctx.launchOptions,
          held,
          { chain: taskAvoidChain(this.ctx.db, task) }
        );
        await this.launch(entry.task_id, { worker, risk: entry.risk });
      } catch (error) {
        if (this.ctx.closed()) return moved;
        const reason = `\u6392\u961F\u540E\u62C9\u8D77\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
        try {
          if (getTask(this.ctx.db, entry.task_id).status === "blocked")
            noteTask(this.ctx.db, entry.task_id, "launch_failed", { reason });
          else this.advance(entry.task_id, { kind: "block" }, {}, { reason });
          this.publish(entry.task_id, "blocked", {
            reason,
            ...error instanceof BudgetProblem ? { source: "budget" } : {}
          });
        } catch {
          if (!this.ctx.closed())
            noteTask(this.ctx.db, entry.task_id, "launch_failed", { reason });
        }
      } finally {
        this.launching.delete(entry.task_id);
        this.ctx.waits.changed(entry.task_id);
      }
    }
    return moved;
  }
};

// server/tasks/log-view.ts
import { open as open5, stat as stat3 } from "node:fs/promises";
var LOG_CHUNK = 64 * 1024;
var LOG_TAIL = 64 * 1024;
async function readLogChunk(file, offset) {
  let size = 0;
  try {
    size = (await stat3(file)).size;
  } catch {
    return { text: "", next: 0, size: 0 };
  }
  const start = Math.min(offset, size);
  const length = Math.min(size - start, LOG_CHUNK);
  const handle = await open5(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let end = length;
    if (start + length < size) {
      while (end > 0 && (buffer[end - 1] & 192) === 128) end--;
      if (end > 0 && buffer[end - 1] >= 192) end--;
    }
    return {
      text: buffer.subarray(0, end).toString("utf8"),
      next: start + end,
      size
    };
  } finally {
    await handle.close();
  }
}
async function readLogTail(file, max = LOG_TAIL) {
  let size = 0;
  let at = 0;
  try {
    const info = await stat3(file);
    size = info.size;
    at = info.mtimeMs;
  } catch {
    return { text: "", size: 0, at: 0 };
  }
  const start = Math.max(0, size - max);
  const length = size - start;
  if (!length) return { text: "", size, at };
  const handle = await open5(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let from = 0;
    if (start > 0)
      while (from < length && (buffer[from] & 192) === 128) from++;
    return { text: buffer.subarray(from).toString("utf8"), size, at };
  } finally {
    await handle.close();
  }
}

// server/tasks/quota-runtime.ts
var message3 = (error) => error instanceof Error ? error.message : String(error);
var QuotaGuard = class {
  constructor(ctx) {
    this.ctx = ctx;
    ensureQuotaHoldTable(ctx.db);
    this.unknownMs = ctx.unknownMs ?? DEFAULT_UNKNOWN_HOLD_MS;
  }
  ctx;
  unknownMs;
  /** 还没到期的账号标记：provider → 到期时刻。 */
  held(now = Date.now()) {
    return heldProviders(listHolds(this.ctx.db), now, this.unknownMs);
  }
  /** 人工解除后立刻排空可派任务，并留下事件。 */
  async clear(x, provider2) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider2))
      throw new Problem(400, "--clear: \u8D26\u53F7\u540D\u4E0D\u5408\u6CD5", "usage");
    const hold = clearHold(this.ctx.db, provider2);
    if (!hold)
      throw new Problem(
        404,
        `\u8D26\u53F7 ${provider2} \u6CA1\u6709\u8FD0\u884C\u65F6\u989D\u5EA6\u5360\u7528`,
        "not_found"
      );
    this.ctx.inbox.publish({
      subscriber: DEFAULT_OWNER,
      source: "quota",
      kind: "quota_cleared",
      key: `quota:${provider2}`,
      detail: {
        provider: provider2,
        reason: `\u4EBA\u5DE5\u89E3\u9664\u989D\u5EA6\u5360\u7528\uFF1A${provider2}`,
        since: hold.since,
        until: hold.until,
        previous_reason: hold.reason
      }
    });
    let dispatched = 0;
    while (true) {
      const moved = await x.drain();
      if (!moved) break;
      dispatched += moved;
    }
    return { provider: provider2, cleared: true, dispatched };
  }
  /**
   * 任务已按额度用尽置为受阻之后：记账号标记，再按档案换执行者、排队或留在受阻。
   * 同一账号已有未到期标记时（并行的任务先报过），自动换人或排队不再发事件；留在受阻的照发。
   */
  async exhausted(x, active, hit2) {
    const { db } = this.ctx;
    const now = Date.now();
    const until = holdUntil(hit2.resetAt, now, this.unknownMs);
    const { fresh } = placeHold(
      db,
      { provider: hit2.provider, until, reason: hit2.reason },
      now,
      this.unknownMs
    );
    const base2 = { reason: hit2.reason, provider: hit2.provider, until };
    noteTask(db, active.id, "quota_exhausted", {
      ...base2,
      fresh,
      evidence: hit2.evidence
    });
    const route = routeAfterQuota({
      switchAllowed: active.worker.profile.rules.switch_on_quota !== false,
      switched: getTask(db, active.id).events.some(
        (event) => event.kind === "quota_switch"
      )
    });
    if (route.kind === "blocked")
      return x.publish(active.id, "blocked", { ...base2, note: route.why });
    x.launching.set(active.id, null);
    try {
      let choice;
      try {
        choice = await chooseWorker(
          { risk: active.risk },
          this.ctx.launchOptions,
          this.held(),
          {
            busy: x.busyTools(active.id),
            requireTrust: true,
            chain: taskAvoidChain(db, getTask(db, active.id))
          }
        );
      } catch (error) {
        if (x.isClosed()) return;
        return x.publish(active.id, "blocked", {
          ...base2,
          note: `\u6CA1\u6709\u53EF\u6362\u7684\u6267\u884C\u8005\uFF1A${message3(error)}`
        });
      }
      if (x.isClosed()) return;
      const tool = choice.worker.tool;
      if (choice.worker.id === active.worker.id)
        return x.publish(active.id, "blocked", {
          ...base2,
          note: "\u6CA1\u6709\u53EF\u6362\u7684\u6267\u884C\u8005\uFF1A\u552F\u4E00\u5408\u683C\u6267\u884C\u8005\u4ECD\u88AB\u989D\u5EA6\u5360\u7528"
        });
      if (choice.waitUntil !== void 0 || ADAPTERS[tool].exclusive && x.busy(tool, active.id))
        return this.park(x, active, choice, base2, fresh);
      await this.switchTo(x, active, choice, base2, fresh);
    } finally {
      x.launching.delete(active.id);
    }
  }
  /** 换到别的执行者重派一次；事件写明从谁换到谁。 */
  async switchTo(x, active, choice, base2, fresh) {
    const switched = { from: active.worker.id, to: choice.worker.id };
    noteTask(this.ctx.db, active.id, "quota_switch", switched);
    x.active.delete(active.id);
    x.launching.set(active.id, choice.worker.tool);
    try {
      await x.launch(active.id, choice);
    } catch (error) {
      if (x.isClosed()) return;
      return x.publish(active.id, "blocked", {
        ...base2,
        note: `\u6362\u6267\u884C\u8005 ${choice.worker.id} \u62C9\u8D77\u5931\u8D25\uFF1A${message3(error)}`
      });
    } finally {
      x.launching.delete(active.id);
    }
    if (x.isClosed()) return;
    if (fresh) x.publish(active.id, "quota_switched", { ...base2, ...switched });
  }
  /** 没有可换的：留在排队（状态保持受阻），等账号恢复或独占工具空出来再派。 */
  park(x, active, choice, base2, fresh) {
    const { db } = this.ctx;
    enqueue(db, {
      task_id: active.id,
      tool: choice.worker.tool,
      worker: choice.worker.id,
      risk: choice.risk,
      queued_at: Date.now()
    });
    const wait = choice.waitUntil === void 0 ? `${choice.worker.tool} \u6B63\u5FD9\uFF0C\u7A7A\u51FA\u6765\u540E\u6D3E\u7ED9 ${choice.worker.id}` : `\u7B49\u5230 ${clock(choice.waitUntil)} \u989D\u5EA6\u6062\u590D\u540E\u6D3E\u7ED9 ${choice.worker.id}`;
    noteTask(db, active.id, "queued", {
      worker: choice.worker.id,
      reason: wait
    });
    if (fresh)
      x.publish(active.id, "quota_queued", {
        ...base2,
        waiting: wait,
        ...choice.waitUntil === void 0 ? {} : { wait_until: choice.waitUntil }
      });
  }
  /** 定时 tick：解除到期标记、发「额度恢复」事件，再把排队的任务拉起来。 */
  async releaseExpired(x) {
    const { db, inbox } = this.ctx;
    const now = Date.now();
    let released = false;
    for (const hold of expiredHolds(listHolds(db), now, this.unknownMs)) {
      if (!releaseHold(db, hold.provider, now, this.unknownMs)) continue;
      released = true;
      inbox.publish({
        subscriber: DEFAULT_OWNER,
        source: "quota",
        kind: "quota_restored",
        key: `quota:${hold.provider}`,
        detail: {
          provider: hold.provider,
          reason: `\u989D\u5EA6\u6062\u590D\uFF1A${hold.provider}`,
          since: hold.since,
          until: hold.until
        }
      });
    }
    if (released) while (await x.drain() > 0) ;
  }
};

// server/tasks/recovery.ts
async function ownsPid(pid, tool, exec2) {
  if (!alive(pid)) return false;
  const ps = await exec2("ps", ["-o", "command=", "-p", String(pid)], {
    timeoutMs: 5e3
  });
  return ps.ok && ps.stdout.includes(ADAPTERS[tool].executable);
}
async function surveyRunning(db, skip, exec2) {
  const rows = db.prepare("SELECT id FROM tasks WHERE status='running' ORDER BY id").all();
  const found = [];
  for (const { id: id3 } of rows) {
    if (skip(id3)) continue;
    const task = getTask(db, id3);
    let worker;
    try {
      worker = task.worker ? await resolveWorker(task.worker, db) : void 0;
    } catch {
      worker = void 0;
    }
    const base2 = worker && task.repo ? await defaultBranch(task.repo, exec2).catch(() => null) : null;
    if (task.pid && worker && await ownsPid(task.pid, worker.tool, exec2))
      found.push({ task, kind: "alive", worker, base: base2 });
    else found.push({ task, kind: "gone", worker, base: base2 });
  }
  return found;
}
async function recoverRunning(x, db, ctx) {
  const skip = (id3) => x.active.has(id3) || x.launching.has(id3);
  for (const found of await surveyRunning(db, skip, ctx.exec)) {
    const { task } = found;
    if (found.worker) {
      const active = adopted({
        task,
        worker: found.worker,
        base: found.base,
        data: ctx.data,
        exec: ctx.exec
      });
      x.active.set(task.id, active);
      if (found.kind === "alive") {
        await active.probe.baseline();
        noteTask(db, task.id, "adopted", {
          pid: task.pid,
          reason: "\u670D\u52A1\u91CD\u542F\u540E\u6309 pid \u63A5\u7BA1"
        });
        continue;
      }
      noteTask(db, task.id, "adopted", {
        pid: task.pid,
        reason: "\u670D\u52A1\u91CD\u542F\u65F6\u6267\u884C\u8005\u5DF2\u9000\u51FA\uFF0C\u63A5\u7BA1\u540E\u8865\u505A\u6536\u5C3E"
      });
      await x.finish(task.id, "unknown");
      ctx.changed(task.id);
      continue;
    }
    const reason = "\u670D\u52A1\u91CD\u542F\u65F6\u6267\u884C\u8005\u8FDB\u7A0B\u5DF2\u4E0D\u5728\uFF0C\u6267\u884C\u8005\u6863\u6848\u89E3\u6790\u4E0D\u51FA\uFF0C\u65E0\u6CD5\u6536\u5C3E";
    x.advance(
      task.id,
      { kind: "exit_fail" },
      {},
      { reason, pid: task.pid, source: "recovery" }
    );
    x.publish(task.id, "failed", { reason, source: "recovery" });
    ctx.changed(task.id);
  }
  await x.drain();
}

// server/tasks/waits.ts
import { EventEmitter as EventEmitter2 } from "node:events";
var TaskWaits = class {
  constructor(settled, current2) {
    this.settled = settled;
    this.current = current2;
    this.changes.setMaxListeners(0);
  }
  settled;
  current;
  changes = new EventEmitter2();
  closed = false;
  changed(id3) {
    this.changes.emit("change", id3);
  }
  close() {
    this.closed = true;
    this.changes.emit("close");
  }
  wait(id3, seconds, signal) {
    return new Promise((resolve4) => {
      let done = false;
      const finish = (restarting = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.changes.off("change", changed2);
        this.changes.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        const task = this.closed ? null : this.settled(id3);
        resolve4({
          task: task ?? (this.closed ? { ref: taskRef(id3) } : this.current(id3)),
          timed_out: !task,
          ...restarting ? { restarting: true } : {}
        });
      };
      const changed2 = (changedId) => {
        if (changedId === id3 && this.settled(id3)) finish();
      };
      const closing = () => finish(true);
      const aborted = () => finish();
      const timer = setTimeout(() => finish(), seconds * 1e3);
      this.changes.on("change", changed2);
      this.changes.on("close", closing);
      signal?.addEventListener("abort", aborted);
    });
  }
};

// server/tasks/plan-view.ts
function nodePaths(db) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'"
  ).get();
  const list4 = exists ? all(
    db,
    "SELECT id,parent_id,slug FROM org_nodes ORDER BY id LIMIT 501"
  ) : [];
  const byId = new Map(list4.map((node) => [node.id, node]));
  return (id3) => {
    const node = id3 === null ? void 0 : byId.get(id3);
    if (!node) return null;
    const parts = [node.slug];
    const seen = /* @__PURE__ */ new Set([node.id]);
    let current2 = node;
    while (current2.parent_id !== null) {
      const parent = byId.get(current2.parent_id);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      parts.unshift(parent.slug);
      current2 = parent;
    }
    if (parts.length > 1) parts.shift();
    return parts.join("/");
  };
}
function planDetails(db, rows) {
  const pathOf = nodePaths(db);
  const details = /* @__PURE__ */ new Map();
  const children = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled')"
  );
  const upstreamRow = db.prepare(
    "SELECT id,title,worker,started_at FROM tasks WHERE id=?"
  );
  for (const row3 of rows) {
    const deps = conditions(db, row3.id);
    details.set(row3.id, {
      node_path: pathOf(row3.node_id),
      open_children: children.get(row3.id).n,
      upstream: deps.after.map((ref2) => {
        const id3 = Number(ref2.slice(1));
        const dep = dependencyOf(db, id3);
        const task = upstreamRow.get(id3);
        return {
          ref: taskRef(id3),
          title: task.title,
          status: dep.status,
          worker: task.worker,
          started_at: task.started_at,
          pr: dep.pr ?? null
        };
      }),
      after_pr: deps.after_pr.map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        merged: pr.merged,
        error: pr.error
      }))
    });
  }
  return details;
}

// server/tasks/schedule.ts
function upstreamProblem(dep) {
  if (dep.status === "failed" || dep.status === "cancelled")
    return `${dep.ref} [${dep.status}]`;
  if (dep.status === "done" && dep.pr?.state === "closed")
    return `${dep.ref} \u7684 PR #${dep.pr.number} \u5DF2\u5173\u95ED\u672A\u5408\u5165`;
  return null;
}
function upstreamWait(dep) {
  if (dep.status !== "done") return `${dep.ref} [${dep.status}]`;
  if (!dep.pr || dep.pr.state === "merged" || dep.pr.state === "closed")
    return null;
  const note = dep.pr.error ? `\uFF08\u67E5\u8BE2\u5931\u8D25\uFF1A${dep.pr.error}\uFF09` : dep.pr.state === null ? "\uFF08\u5C1A\u672A\u67E5\u8BE2\uFF09" : "";
  return `${dep.ref} \u7684 PR #${dep.pr.number} \u5408\u5165${note}`;
}
function classify2(status, dependencies2, prs, reason = null) {
  if (status === "running")
    return { group: "running", waiting_for: [], reason: null };
  const failed = dependencies2.map(upstreamProblem).filter((text6) => text6 !== null);
  const waiting = [
    ...dependencies2.map(upstreamWait).filter((text6) => text6 !== null),
    ...prs.filter((pr) => !pr.merged).map((pr) => `${pr.ref} \u672A\u5408\u5165`)
  ];
  if (failed.length)
    return {
      group: "blocked",
      waiting_for: waiting,
      reason: `\u4E0A\u6E38 ${failed.join("\u3001")}`
    };
  if (status === "blocked" && !reason?.startsWith("\u4E0A\u6E38 "))
    return {
      group: "blocked",
      waiting_for: waiting,
      reason: reason ?? "\u4EFB\u52A1\u53D7\u963B"
    };
  if (status === "failed")
    return {
      group: "blocked",
      waiting_for: waiting,
      reason: reason ?? "\u4EFB\u52A1\u5931\u8D25"
    };
  if (waiting.length)
    return { group: "waiting", waiting_for: waiting, reason: null };
  return { group: "ready", waiting_for: [], reason: null };
}
function planItem(db, row3) {
  const deps = conditions(db, row3.id);
  const tasks = deps.after.map((ref2) => dependencyOf(db, Number(ref2.slice(1))));
  const prs = deps.after_pr.map((pr) => ({
    ref: `${pr.repo}#${pr.number}${pr.error ? `\uFF08\u67E5\u8BE2\u5931\u8D25\uFF1A${pr.error}\uFF09` : ""}`,
    merged: pr.merged
  }));
  return {
    task: {
      ...listView(row3),
      ...noteView(db, row3.id, row3.status),
      ...queueView(db, row3.id)
    },
    ...classify2(row3.status, tasks, prs, row3.schedule_reason)
  };
}
function taskPlan(db, after = 0, limit = 200) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw usage("plan: after \u5E94\u4E3A\u975E\u8D1F\u6574\u6570\uFF0Climit \u5E94\u4E3A 1\uFF5E500");
  const rows = all(
    db,
    "SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') ORDER BY id LIMIT ?",
    after,
    limit + 1
  );
  const page = rows.slice(0, limit);
  const details = planDetails(db, page);
  const items = page.map((row3) => ({
    ...planItem(db, row3),
    ...details.get(row3.id)
  }));
  return {
    groups: {
      running: items.filter((item) => item.group === "running"),
      // 紧急的排最前（t113），其余照短号。
      ready: items.filter((item) => item.group === "ready").sort((a, b) => b.task.urgent - a.task.urgent),
      waiting: items.filter((item) => item.group === "waiting"),
      blocked: items.filter((item) => item.group === "blocked")
    },
    next_after: rows.length > limit ? taskRef(rows[limit - 1].id) : null
  };
}
var Scheduler = class {
  constructor(db, inbox, run3, exec2) {
    this.db = db;
    this.inbox = inbox;
    this.run = run3;
    this.exec = exec2;
  }
  db;
  inbox;
  run;
  exec;
  busy = false;
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      let after = 0;
      for (; ; ) {
        const rows = all(
          this.db,
          `SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') AND (auto=1 OR schedule_state IS NOT NULL OR EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=tasks.id) OR EXISTS(SELECT 1 FROM task_pr_dependencies WHERE task_id=tasks.id)) ORDER BY id LIMIT 200`,
          after
        );
        if (!rows.length) break;
        for (const row3 of rows) {
          after = row3.id;
          await this.refreshPrs(row3.id, now);
          await refreshUpstreamPrs(this.db, row3.id, now, this.exec);
          const item = planItem(this.db, {
            ...row3,
            ...this.db.prepare(
              "SELECT status,schedule_state,schedule_reason FROM tasks WHERE id=?"
            ).get(row3.id)
          });
          const state = item.group === "waiting" ? "waiting" : item.group === "blocked" ? "blocked" : item.group === "ready" ? "ready" : null;
          if (!state || row3.status === "blocked" && row3.schedule_state !== "blocked")
            continue;
          if (state !== row3.schedule_state || item.reason !== row3.schedule_reason) {
            if (state === "blocked") dequeue(this.db, row3.id);
            if (state === "blocked" && row3.status === "todo")
              advanceTask(
                this.db,
                row3.id,
                { kind: "block" },
                {},
                { reason: item.reason }
              );
            if (state !== "blocked" && row3.status === "blocked" && row3.schedule_state === "blocked")
              advanceTask(
                this.db,
                row3.id,
                { kind: "manual_set", to: "todo" },
                {},
                "\u4F9D\u8D56\u6062\u590D"
              );
            this.db.prepare(
              "UPDATE tasks SET schedule_state=?,schedule_reason=?,updated_at=? WHERE id=?"
            ).run(state, item.reason, now, row3.id);
            noteTask(this.db, row3.id, `schedule_${state}`, {
              waiting_for: item.waiting_for,
              reason: item.reason
            });
            if (state === "ready" || state === "blocked")
              this.publish(row3.id, state, item.reason, item.waiting_for);
          }
          const fresh = getTask(this.db, row3.id);
          if (state === "ready" && fresh.status === "todo" && fresh.auto === 1 && fresh.auto_dispatched === 0 && !((fresh.owner ?? "secretary") === "secretary" && fresh.deliver === "none")) {
            if (queued(this.db, row3.id)) {
              this.db.prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?").run(row3.id);
              continue;
            }
            try {
              await this.run(fresh.ref);
              this.db.prepare("UPDATE tasks SET auto_dispatched=1 WHERE id=?").run(row3.id);
            } catch (error) {
              const reason = `\u81EA\u52A8\u6D3E\u53D1\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
              advanceTask(this.db, row3.id, { kind: "block" }, {}, { reason });
              this.db.prepare(
                "UPDATE tasks SET schedule_state='blocked',schedule_reason=? WHERE id=?"
              ).run(reason, row3.id);
              this.publish(row3.id, "blocked", reason, []);
            }
          }
        }
        if (rows.length < 200) break;
      }
    } finally {
      this.busy = false;
    }
  }
  async refreshPrs(id3, now) {
    const prs = all(
      this.db,
      "SELECT repo,number FROM task_pr_dependencies WHERE task_id=? AND merged=0 AND (checked_at IS NULL OR checked_at<?) ORDER BY repo,number LIMIT 20",
      id3,
      now - 6e4
    );
    for (const pr of prs) {
      const result = await this.exec(
        "gh",
        ["pr", "view", String(pr.number), "-R", pr.repo, "--json", "mergedAt"],
        { timeoutMs: 15e3 }
      );
      let merged = false;
      let error = null;
      try {
        if (!result.ok) throw new Error(result.stderr.trim() || "gh \u67E5\u8BE2\u5931\u8D25");
        merged = !!JSON.parse(result.stdout).mergedAt;
      } catch (cause) {
        error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause);
      }
      this.db.prepare(
        "UPDATE task_pr_dependencies SET merged=?,checked_at=?,error=? WHERE task_id=? AND repo=? AND number=?"
      ).run(merged ? 1 : 0, now, error, id3, pr.repo, pr.number);
    }
  }
  publish(id3, kind, reason, waiting) {
    const task = getTask(this.db, id3);
    const route = taskRoute(this.db, task);
    this.inbox.publish({
      subscriber: route.subscriber,
      taskId: id3,
      source: "schedule",
      kind,
      key: `${task.ref}:schedule:${kind}`,
      detail: {
        title: task.title,
        reason,
        waiting_for: waiting,
        auto: task.auto === 1,
        unassigned: (task.owner ?? "secretary") === "secretary" && task.deliver === "none",
        routed: { to: route.subscriber, why: route.why }
      }
    });
  }
};

// server/tasks/schedule-pr.ts
import { execFile as execFile5 } from "node:child_process";
import { homedir as homedir6 } from "node:os";
var schedulePrExec = (command, args2, options = {}) => new Promise((resolve4) => {
  const env = {
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "GH_HOST"
  ])
    if (process.env[key]) env[key] = process.env[key];
  execFile5(
    command,
    args2,
    {
      env,
      cwd: options.cwd ?? homedir6(),
      timeout: options.timeoutMs ?? 15e3,
      maxBuffer: 64 * 1024
    },
    (error, stdout, stderr) => resolve4({
      ok: !error,
      stdout: String(stdout),
      stderr: String(stderr || (error ? error.message : ""))
    })
  );
});

// server/tasks/percent.ts
function signedPercent(value) {
  const n = Math.round(value);
  return n > 0 ? `+${n}%` : n < 0 ? `\u2212${-n}%` : "0%";
}

// server/tasks/pick.ts
var NOTICE_SPARE_GAP = 30;
function accountOf(account, facts) {
  const rows = facts.pace?.filter((entry) => entry.providerId === account);
  const spare = facts.pace ? spareByProvider(rows ?? []).get(account) : null;
  const used = (rows ?? []).map((entry) => entry.usedPercent).filter((n) => typeof n === "number");
  const tight = (rows ?? []).filter((entry) => entry.sparePercent !== null).sort((a, b) => a.sparePercent - b.sparePercent)[0];
  const hours = tight?.hoursToReset ?? (rows ?? []).map((entry) => entry.hoursToReset).filter((n) => typeof n === "number").sort((a, b) => a - b)[0];
  const room = facts.headroom.get(account);
  return {
    account,
    used_percent: used.length ? Math.max(...used) : null,
    spare_percent: spare ?? null,
    hours_to_reset: hours ?? null,
    left_percent: room ? Number(room.points.toFixed(2)) : null,
    left_reason: room?.reason ?? null,
    held_until: facts.held.get(account) ?? null
  };
}
function refusalsOf(candidate, facts) {
  const { rules, tool } = candidate;
  const account = ADAPTERS[tool].quotaProvider;
  const reasons = [];
  if (!candidate.installed)
    reasons.push(`\u6CA1\u88C5\uFF1APATH \u4E0A\u627E\u4E0D\u5230 ${ADAPTERS[tool].executable}`);
  const max = rules.max_risk;
  if (max && RISKS.indexOf(max) < RISKS.indexOf(facts.risk))
    reasons.push(`\u6863\u6848 max_risk=${max}\uFF0C\u4F4E\u4E8E\u4EFB\u52A1 risk=${facts.risk}`);
  if (facts.job && Array.isArray(rules.avoid_jobs) && rules.avoid_jobs.includes(facts.job.ref))
    reasons.push(`\u6863\u6848 avoid_jobs \u907F\u5F00\u4E13\u5458 ${facts.job.name}`);
  const avoided = facts.chain.length && avoidReason([...facts.chain], rules.avoid_nodes);
  if (avoided) reasons.push(avoided);
  const heldUntil = facts.held.get(account);
  if (heldUntil !== void 0) reasons.push(`\u989D\u5EA6\u7528\u5C3D\u81F3 ${clock(heldUntil)}`);
  const over = facts.pace?.filter((entry) => entry.providerId === account).find((entry) => overReserve(entry.usedPercent, facts.reservePercent));
  if (over)
    reasons.push(
      `\u5DF2\u7528\u989D\u5EA6 ${over.usedPercent}% \u8FBE\u5230\u7AE0\u7A0B\u4E0A\u9650 ${100 - facts.reservePercent}%\uFF08\u987B\u7559 ${facts.reservePercent}% \u7ED9\u7528\u6237\uFF09`
    );
  const room = facts.headroom.get(account);
  if (!over && facts.pace && room && room.points < 1) reasons.push(room.reason);
  if (rules.billing === "metered")
    reasons.push("\u6863\u6848 billing=metered\uFF0C\u5F53\u524D\u94B1\u4EFD\u989D\u4E3A 0 \u5143");
  return reasons;
}
function notesOf(candidate) {
  const trust = candidate.rules.trust ?? "unknown";
  return trust === "unknown" || trust === "low" ? [`trust=${trust}\uFF0C\u5408\u5165\u524D\u53E6\u6D3E\u5BA1\u9605`] : [];
}
function pickView(facts) {
  const spare = facts.pace ? spareByProvider(facts.pace) : /* @__PURE__ */ new Map();
  const rows = facts.candidates.map((candidate, index2) => {
    const refusals = refusalsOf(candidate, facts);
    const busy = ADAPTERS[candidate.tool].exclusive && facts.busy.has(candidate.tool);
    return {
      candidate,
      index: index2,
      refusals,
      busy,
      spare: spare.get(ADAPTERS[candidate.tool].quotaProvider)
    };
  });
  const eligible = rows.filter((row3) => !row3.refusals.length);
  const favoured = eligible.filter((row3) => row3.candidate.preferred !== null && !row3.busy).sort((a, b) => a.candidate.preferred - b.candidate.preferred);
  const byOrder = (row3) => FALLBACK_ORDER.indexOf(row3.candidate.tool);
  const rest = eligible.filter((row3) => !favoured.includes(row3)).sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? 1 : -1;
    if (a.spare === void 0 || b.spare === void 0)
      return a.spare === b.spare ? byOrder(a) - byOrder(b) || a.index - b.index : a.spare === void 0 ? 1 : -1;
    return b.spare - a.spare || byOrder(a) - byOrder(b) || a.index - b.index;
  });
  const ordered = [...favoured, ...rest];
  const first = favoured[0];
  const swap = first && first.spare !== void 0 && first.spare < 0 ? richerAlternative(
    ordered.map((row3) => ({
      worker: row3.candidate.worker,
      account: ADAPTERS[row3.candidate.tool].quotaProvider,
      spare: row3.spare ?? null,
      eligible: true,
      busy: row3.busy,
      trust: row3.candidate.rules.trust ?? "unknown"
    })),
    {
      account: ADAPTERS[first.candidate.tool].quotaProvider,
      spare: first.spare
    },
    facts.risk
  ) : null;
  const ranked = swap ? [
    ordered.find((row3) => row3.candidate.worker === swap.worker),
    ...ordered.filter((row3) => row3.candidate.worker !== swap.worker)
  ] : ordered;
  const refused = rows.filter((row3) => row3.refusals.length);
  const candidates = [...ranked, ...refused].map((row3) => ({
    worker: row3.candidate.worker,
    tool: row3.candidate.tool,
    preferred: row3.candidate.preferred === null ? null : row3.candidate.preferred + 1,
    trust: row3.candidate.rules.trust ?? "unknown",
    max_risk: row3.candidate.rules.max_risk ?? null,
    eligible: !row3.refusals.length,
    refusals: row3.refusals,
    notes: notesOf(row3.candidate),
    busy: row3.busy,
    rank: ranked.includes(row3) ? ranked.indexOf(row3) + 1 : null,
    quota: accountOf(ADAPTERS[row3.candidate.tool].quotaProvider, facts),
    record: facts.records.get(row3.candidate.worker) ?? null
  }));
  const top = candidates[0]?.eligible ? candidates[0] : void 0;
  return {
    risk: facts.risk,
    job: facts.job,
    reserve_percent: facts.reservePercent,
    quota_known: !!facts.pace,
    candidates,
    recommended: top?.worker ?? null,
    reason: pickReason(
      candidates,
      facts,
      swap ? candidates.find((c) => c.worker === first.candidate.worker) : void 0
    )
  };
}
function trusted(trust, risk) {
  const level = TRUSTS.indexOf(trust);
  return level >= TRUSTS.indexOf("medium") && level > RISKS.indexOf(risk);
}
function richerAlternative(rivals, own, risk) {
  if (own.spare === null || own.spare === void 0) return null;
  for (const rival of rivals) {
    if (!rival.eligible || rival.busy || rival.account === own.account || rival.spare === null || rival.spare <= 0 || !trusted(rival.trust, risk))
      continue;
    const gap = Math.round(rival.spare - own.spare);
    if (gap >= NOTICE_SPARE_GAP) return { ...rival, spare: rival.spare, gap };
  }
  return null;
}
var rivalOf = (c) => ({
  worker: c.worker,
  account: c.quota.account,
  spare: c.quota.spare_percent,
  eligible: c.eligible,
  busy: c.busy,
  trust: c.trust
});
var spareText = (quota) => quota.spare_percent === null ? `${quota.account} \u6CA1\u6709\u5BCC\u4F59\u6570\u636E` : `${quota.account} \u5BCC\u4F59 ${signedPercent(quota.spare_percent)}`;
function pickReason(candidates, facts, overSpeed) {
  const top = candidates[0]?.eligible ? candidates[0] : void 0;
  if (!top) {
    const why2 = candidates.slice(0, 3).map((c) => `${c.worker}\uFF1A${c.refusals[0]}`).join("\uFF1B");
    return candidates.length ? `\u6CA1\u6709\u80FD\u63A5\u7684\u6267\u884C\u8005\uFF08${why2}\uFF09` : "\u6CA1\u6709\u5019\u9009\u6267\u884C\u8005\uFF1A\u5DF2\u88C5\u7684\u7F16\u7801 CLI \u4E00\u4E2A\u90FD\u6CA1\u6709";
  }
  if (overSpeed) {
    const job = facts.job ? `${facts.job.name}\u4E13\u5458` : "\u4E13\u5458";
    const to2 = top.preferred !== null ? `\u7B2C ${top.preferred} \u9009 ${top.worker}` : ` ${top.worker}`;
    return `${job}\u7B2C ${overSpeed.preferred} \u9009 ${overSpeed.worker} \u8D85\u901F\uFF08${overSpeed.quota.account} ${signedPercent(overSpeed.quota.spare_percent)}\uFF09\uFF0C\u6539\u7528${to2}\uFF08${top.quota.account} ${signedPercent(top.quota.spare_percent)}\uFF09`;
  }
  const why = [];
  if (facts.job && top.preferred !== null)
    why.push(`${facts.job.name}\u4E13\u5458\u4F18\u5148`);
  else if (facts.job)
    why.push(
      candidates.some((c) => c.preferred !== null) ? `${facts.job.name}\u4E13\u5458\u7684\u4F18\u5148\u6267\u884C\u8005\u90FD\u4E0D\u80FD\u63A5\u6216\u6B63\u5FD9\uFF0C\u6309\u989D\u5EA6\u6311` : `${facts.job.name}\u4E13\u5458\u6CA1\u6307\u5B9A\u4F18\u5148\u6267\u884C\u8005\uFF0C\u6309\u989D\u5EA6\u6311`
    );
  why.push(facts.pace ? spareText(top.quota) : "\u989D\u5EA6\u6570\u636E\u4E0D\u53EF\u7528\uFF0C\u6309\u56FA\u5B9A\u987A\u5E8F");
  if (top.busy) why.push(`${top.tool} \u6B63\u5FD9\uFF0C\u6D3E\u4E86\u4F1A\u6392\u961F`);
  const others = [];
  const seen = /* @__PURE__ */ new Set([top.quota.account]);
  for (const c of candidates) {
    if (others.length >= 2) break;
    if (!c.eligible && c.preferred !== null) {
      others.push(`${c.worker} \u4E0D\u80FD\u63A5\uFF1A${c.refusals[0]}`);
      seen.add(c.quota.account);
      continue;
    }
    if (seen.has(c.quota.account) || !facts.pace || c.quota.spare_percent === null)
      continue;
    seen.add(c.quota.account);
    others.push(
      c.eligible ? spareText(c.quota) : `${c.worker} \u4E0D\u80FD\u63A5\uFF1A${c.refusals[0]}`
    );
  }
  return `${why.join("\u3001")}${others.length ? `\uFF1B${others.join("\uFF1B")}` : ""}`;
}
function writtenNotice(view7, written, taskRef2) {
  if (written.worker === view7.recommended) return null;
  const account = ADAPTERS[written.tool].quotaProvider;
  const mine = view7.candidates.find((c) => c.quota.account === account)?.quota.spare_percent;
  const better = richerAlternative(
    view7.candidates.map(rivalOf),
    { account, spare: mine },
    view7.risk
  );
  if (!better) return null;
  return `\u63D0\u9192\uFF1A${better.worker} \u540C\u6837\u80FD\u63A5\uFF0C${better.account} \u5BCC\u4F59 ${signedPercent(better.spare)}\uFF0C\u6BD4 ${written.worker} \u7684 ${account}\uFF08${signedPercent(mine)}\uFF09\u591A ${better.gap} \u4E2A\u767E\u5206\u70B9\uFF1B\u770B\u5019\u9009\uFF1Aatrium task pick ${taskRef2}`;
}

// server/tasks/role-ranking.ts
function rankRoleWorkers(preferred, stats, role) {
  const rate = new Map(
    stats.filter((s) => s.role === role && !s.low_data).map((s) => [`${s.scope}:${s.worker}`, s.first_pass_rate ?? 0])
  );
  const score = (worker) => {
    const spec = parseWorker(worker);
    return rate.get(`combination:${worker}`) ?? rate.get(`model:${spec.tool}${spec.model ? `+${spec.model}` : ""}`) ?? rate.get(`tool:${spec.tool}`) ?? 0.5;
  };
  const observed = stats.filter((s) => s.scope === "combination" && s.role === role && !s.low_data).sort((a, b) => (b.first_pass_rate ?? 0) - (a.first_pass_rate ?? 0)).map((s) => s.worker).filter((worker) => {
    try {
      parseWorker(worker);
      return true;
    } catch {
      return false;
    }
  });
  const candidates = [.../* @__PURE__ */ new Set([...preferred, ...observed])];
  return candidates.map((worker, index2) => ({
    worker,
    index: index2,
    priority: index2 - (score(worker) - 0.5) * (preferred.length + 1)
  })).sort((a, b) => a.priority - b.priority || a.index - b.index).map((x) => x.worker);
}

// server/tasks/pick-runtime.ts
var recordOf = (rows, worker, role) => {
  const stat5 = summarizeDeliveries(rows).find(
    (s) => s.scope === "combination" && s.worker === worker && s.role === role
  );
  return stat5 ? {
    deliveries: stat5.deliveries,
    first_pass_rate: stat5.first_pass_rate,
    low_data: stat5.low_data
  } : void 0;
};
async function pickFacts(task, risk, ctx) {
  const { db, launchOptions: options } = ctx;
  const chain = taskAvoidChain(db, task);
  const nodeId = chain.at(-1)?.id;
  const reservePercent = readQuotaReservePercent(db, nodeId);
  const pace = ctx.pace ? [...ctx.pace] : void 0;
  const headroom = quotaHeadroom(db, nodeId ?? null, pace, reservePercent);
  const installed = detectInstalled(options.env.PATH ?? "");
  const job = task.job_id ? getJobRole(db, `r${task.job_id}`) : null;
  const jobRows = job ? listDeliveries(db, { job: job.id }) : [];
  const names2 = [
    ...(job ? rankRoleWorkers(job.preferred, summarizeDeliveries(jobRows), job.name) : []).map((name2, index2) => ({ name: name2, preferred: index2 })),
    ...FALLBACK_ORDER.filter((tool) => installed[tool]).map((tool) => ({
      name: tool,
      preferred: null
    }))
  ];
  const candidates = [];
  for (const { name: name2, preferred } of names2) {
    let worker;
    try {
      worker = await resolveWorker(name2, db);
    } catch {
      continue;
    }
    const seen = candidates.find((c) => c.worker === worker.id);
    if (seen) {
      if (seen.preferred === null) seen.preferred = preferred;
      continue;
    }
    candidates.push({
      worker: worker.id,
      tool: worker.tool,
      installed: !!installed[worker.tool],
      rules: worker.profile.rules,
      preferred
    });
  }
  const records = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const record = job ? recordOf(jobRows, candidate.worker, job.name) : recordOf(
      listDeliveries(db, { worker: candidate.worker, limit: 1e3 }).map(
        (row3) => ({ ...row3, job_name: null })
      ),
      candidate.worker,
      null
    );
    if (record) records.set(candidate.worker, record);
  }
  return {
    risk,
    job: job ? { ref: job.ref, name: job.name } : null,
    candidates,
    pace,
    held: ctx.held,
    reservePercent,
    headroom,
    busy: ctx.busy,
    chain,
    records
  };
}
async function pickFor(task, risk, ctx) {
  return pickView(await pickFacts(task, risk, ctx));
}

// server/tasks/disk-budget.ts
import { execFile as execFile6 } from "node:child_process";
import { stat as stat4, statfs } from "node:fs/promises";
import { promisify } from "node:util";
var run2 = promisify(execFile6);
var GB = 1024 ** 3;
var DiskBudget = class {
  constructor(db, data2, freeGb = async (path) => {
    const space = await statfs(path);
    return space.bavail * space.bsize / GB;
  }, cleanup) {
    this.db = db;
    this.data = data2;
    this.freeGb = freeGb;
    this.cleanup = cleanup;
  }
  db;
  data;
  freeGb;
  cleanup;
  cache = /* @__PURE__ */ new Map();
  cursor = 0;
  async size(path) {
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < 3e4) return cached.gb;
    try {
      await stat4(path);
      const { stdout } = await run2("du", ["-sk", path], {
        timeout: 1e4,
        maxBuffer: 1024
      });
      const gb = Number.parseInt(stdout, 10) * 1024 / GB;
      if (!Number.isFinite(gb)) throw new Error("du \u8F93\u51FA\u65E0\u6548");
      this.cache.set(path, { at: Date.now(), gb });
      return gb;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }
  /** 看门狗每轮只巡五个 worktree，避免 du 扫描长期占住派活。 */
  async refresh() {
    const rows = all(
      this.db,
      "SELECT id,worktree FROM tasks WHERE id>? AND worktree IS NOT NULL ORDER BY id LIMIT 5",
      this.cursor
    );
    if (!rows.length) {
      this.cursor = 0;
      return;
    }
    this.cursor = rows.at(-1).id;
    await Promise.all(
      rows.map((row3) => this.size(row3.worktree).catch(() => 0))
    );
  }
  async check(nodeId, repo) {
    const list4 = nodes(this.db);
    const node = list4.find((n) => n.id === nodeId) ?? list4.find((n) => n.parent_id === null);
    const boundaries = node ? allBoundaries(this.db) : /* @__PURE__ */ new Map();
    const levels = node ? [
      ...chainLevels(list4, boundaries, node.parent_id),
      {
        node: node.id,
        name: node.name,
        entries: boundaries.get(node.id) ?? []
      }
    ] : [];
    const minFree = Math.max(
      15,
      ...effective(levels).filter((b) => b.param?.key === "disk_min_free_gb").map((b) => b.param.value)
    );
    let free = await this.freeGb(repo ?? this.data);
    if (free < minFree && this.cleanup) {
      await this.cleanup.finished();
      free = await this.freeGb(repo ?? this.data);
    }
    if (free < minFree)
      throw new BudgetProblem(
        `\u78C1\u76D8\u53EF\u7528\u7EA6 ${free.toFixed(1)} GB\uFF0C\u4F4E\u4E8E\u7AE0\u7A0B\u4E0B\u9650 ${minFree} GB\uFF1B\u5148\u6E05\u7406\u7EC4\u7EC7\u4E34\u65F6\u4EA7\u7269`
      );
    if (nodeId === null || !node) return;
    const shares = allShares(this.db);
    const chain = [];
    let current2 = node;
    while (current2) {
      if (ownAmount(shares.get(current2.id) ?? [], "disk", "") !== void 0)
        chain.push(current2);
      current2 = list4.find((n) => n.id === current2.parent_id);
    }
    if (!chain.length) return;
    const paths = all(
      this.db,
      "SELECT node_id,worktree FROM tasks WHERE node_id IS NOT NULL AND worktree IS NOT NULL ORDER BY id DESC LIMIT 2001"
    );
    if (paths.length > 2e3)
      throw new BudgetProblem("\u4EFB\u52A1 worktree \u8D85\u8FC7 2000 \u6761\uFF0C\u65E0\u6CD5\u6838\u5BF9\u78C1\u76D8\u4EFD\u989D");
    const usage11 = /* @__PURE__ */ new Map();
    for (const row3 of paths)
      usage11.set(
        row3.node_id,
        (usage11.get(row3.node_id) ?? 0) + await this.size(row3.worktree)
      );
    for (const current3 of chain) {
      const limit = ownAmount(shares.get(current3.id) ?? [], "disk", "");
      if (limit !== void 0) {
        const subtree2 = /* @__PURE__ */ new Set([current3.id]);
        for (const candidate of list4) {
          let parent = candidate.parent_id;
          while (parent !== null) {
            if (parent === current3.id) {
              subtree2.add(candidate.id);
              break;
            }
            parent = list4.find((n) => n.id === parent)?.parent_id ?? null;
          }
        }
        const used = [...usage11].reduce(
          (sum, [id3, gb]) => sum + (subtree2.has(id3) ? gb : 0),
          0
        );
        if (used >= limit)
          throw new BudgetProblem(
            `${ref(current3.id)} ${current3.name} \u7684\u78C1\u76D8\u4EFD\u989D ${limit} GB\uFF0Cworktree \u5DF2\u5360\u7EA6 ${used.toFixed(2)} GB\uFF1B\u5148\u6E05\u7406\u8BE5\u8282\u70B9\u5DF2\u7ED3\u675F\u4EFB\u52A1\u7684 worktree`
          );
      }
    }
  }
};

// server/tasks/merge-runtime.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { existsSync as existsSync6 } from "node:fs";

// server/secret-redact.ts
var SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /(?<=\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  /(?<=\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"']{6,})/g
];
function redact(text6) {
  let out = text6;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "***");
  return out;
}

// server/tasks/merge-decision.ts
var MAX_MERGE_RETURNS = 2;
function mergeFailure(count2, reason) {
  const returns = count2 + 1;
  return {
    returns,
    blocked: returns > MAX_MERGE_RETURNS,
    reason
  };
}

// server/tasks/merge-claim.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var MergeClaim = class {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS merge_claim (
      id INTEGER PRIMARY KEY CHECK(id=1), task_id INTEGER NOT NULL,
      pid INTEGER NOT NULL, token TEXT NOT NULL)`);
  }
  db;
  token = randomUUID2();
  acquire(taskId) {
    return atomically(this.db, () => {
      const held = this.db.prepare("SELECT pid,token FROM merge_claim WHERE id=1").get();
      if (held) {
        if (held.token === this.token) return false;
        try {
          process.kill(held.pid, 0);
          return false;
        } catch (error) {
          if (error.code !== "ESRCH") return false;
          this.db.prepare("DELETE FROM merge_claim WHERE id=1").run();
        }
      }
      this.db.prepare(
        "INSERT INTO merge_claim(id,task_id,pid,token) VALUES (1,?,?,?)"
      ).run(taskId, process.pid, this.token);
      return true;
    });
  }
  release() {
    this.db.prepare("DELETE FROM merge_claim WHERE id=1 AND token=?").run(this.token);
  }
};

// server/tasks/merge-runtime.ts
var MergeHold = class extends Error {
};
var NEXT_MERGE = "SELECT id FROM tasks WHERE delivery_stage IN ('merge_queued','merging') AND status='done' ORDER BY delivery_stage='merging' DESC,urgent DESC,merge_queued_at,id LIMIT 1";
var MergeQueue = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
    this.claim = new MergeClaim(db);
  }
  db;
  options;
  draining = false;
  closed = false;
  retryAfter = 0;
  returning = /* @__PURE__ */ new Set();
  stopping = /* @__PURE__ */ new Map();
  claim;
  abort = new AbortController();
  active;
  isReturning(id3) {
    return this.returning.has(id3);
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.active;
  }
  /** 用户停止排队或合入；已发出的 gh merge 仍以 PR 实际状态为准。 */
  stop(id3, by) {
    const task = getTask(this.db, id3);
    if (task.delivery_stage !== "merge_queued" && task.delivery_stage !== "merging")
      return null;
    if (task.delivery_stage === "merging") {
      this.stopping.set(id3, by);
      noteTask(this.db, id3, "merge_stop_requested", { reason: "\u7528\u6237\u505C\u6B62\u5408\u5165" });
      return { stopping: true };
    }
    this.finishStop(id3, by);
    return { stopping: false };
  }
  finishStop(id3, by) {
    this.stopping.delete(id3);
    atomically(this.db, () => {
      this.db.prepare(
        "UPDATE tasks SET delivery_stage=NULL,merge_queued_at=NULL,status='blocked',ended_at=NULL,updated_at=? WHERE id=?"
      ).run(Date.now(), id3);
      noteTask(this.db, id3, "merge_stopped", { reason: "\u7528\u6237\u505C\u6B62\u5408\u5165" });
    });
    this.options.changed(id3);
    this.options.publish(id3, "blocked", { reason: "\u7528\u6237\u505C\u6B62\u5408\u5165" }, by);
  }
  stopped(id3) {
    if (!this.stopping.has(id3)) return false;
    this.finishStop(id3, this.stopping.get(id3));
    return true;
  }
  stage(id3, stage, kind, detail2, changed2 = true) {
    atomically(this.db, () => {
      this.db.prepare(
        "UPDATE tasks SET delivery_stage=?,merge_queued_at=CASE WHEN ?='merged' THEN NULL ELSE merge_queued_at END,updated_at=? WHERE id=?"
      ).run(stage, stage, Date.now(), id3);
      noteTask(this.db, id3, kind, detail2);
    });
    if (changed2) this.options.changed(id3);
  }
  enqueue(id3) {
    const task = getTask(this.db, id3);
    if (task.deliver !== "pr" || !task.pr_url || !task.repo) return;
    atomically(this.db, () => {
      const now = Date.now();
      this.db.prepare(
        "UPDATE tasks SET delivery_stage='merge_queued',merge_queued_at=?,updated_at=? WHERE id=?"
      ).run(now, now, id3);
      noteTask(this.db, id3, "merge_queued", { pr_url: task.pr_url });
    });
    this.options.changed(id3);
    this.options.publish(id3, "merge_queued", { pr_url: task.pr_url });
    this.kick();
  }
  /** 仅重新排入已通过交付关卡、曾进入合入队列的受阻 PR。 */
  requeue(id3) {
    const task = getTask(this.db, id3);
    const gate = this.db.prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='gates' ORDER BY id DESC LIMIT 1"
    ).get(id3);
    let passed = false;
    try {
      passed = JSON.parse(gate?.detail ?? "null")?.passed === true;
    } catch {
    }
    const admitted = this.db.prepare(
      "SELECT 1 FROM task_events WHERE task_id=? AND kind='merge_queued' LIMIT 1"
    ).get(id3);
    if (task.deliver !== "pr" || !task.pr_url || !task.repo || !task.worktree || !task.branch)
      throw new Problem(
        409,
        `${task.ref} \u6CA1\u6709\u53EF\u5408\u5165\u7684 PR\u3001\u4ED3\u5E93\u6216\u5DE5\u4F5C\u6811`,
        "conflict"
      );
    if (task.status !== "blocked" || task.delivery_stage !== null || !passed || !admitted)
      throw new Problem(
        409,
        `${task.ref} \u672A\u901A\u8FC7\u4EA4\u4ED8\u5173\u5361\uFF0C\u6216\u4E0D\u5728\u53EF\u91CD\u65B0\u6392\u961F\u7684\u53D7\u963B\u72B6\u6001`,
        "conflict"
      );
    const now = Date.now();
    atomically(this.db, () => {
      this.db.prepare(
        "UPDATE tasks SET status='done',delivery_stage='merge_queued',merge_queued_at=?,ended_at=?,updated_at=? WHERE id=?"
      ).run(now, now, now, id3);
      noteTask(this.db, id3, "merge_queued", { pr_url: task.pr_url });
    });
    this.options.changed(id3);
    this.options.publish(id3, "merge_queued", { pr_url: task.pr_url });
    this.kick();
    return getTask(this.db, id3);
  }
  kick() {
    if (this.closed || this.draining || Date.now() < this.retryAfter) return;
    const row3 = this.db.prepare(NEXT_MERGE).get();
    if (!row3 || !this.claim.acquire(row3.id)) return;
    this.active = this.drain().catch(
      (error) => console.error("\u5408\u5165\u961F\u5217\u5931\u8D25\uFF1A", redact(String(error)))
    );
  }
  async drain() {
    this.draining = true;
    try {
      while (!this.closed) {
        const row3 = this.db.prepare(NEXT_MERGE).get();
        if (!row3) return;
        this.stage(row3.id, "merging", "merge_started");
        try {
          await this.process(getTask(this.db, row3.id));
        } catch (error) {
          if (this.closed) return;
          if (this.stopped(row3.id)) continue;
          const reason = redact(
            error instanceof Error ? error.message : String(error)
          );
          if (error instanceof MergeHold) {
            atomically(this.db, () => {
              this.db.prepare(
                "UPDATE tasks SET delivery_stage=NULL,merge_queued_at=NULL,status='blocked',ended_at=NULL,updated_at=? WHERE id=?"
              ).run(Date.now(), row3.id);
              noteTask(this.db, row3.id, "merge_blocked", { reason });
            });
            this.options.changed(row3.id);
            this.options.publish(row3.id, "blocked", { reason });
            continue;
          }
          noteTask(this.db, row3.id, "merge_error", { reason });
          this.stage(row3.id, "merge_queued", "merge_retry", { reason });
          this.options.publish(row3.id, "merge_retry", { reason });
          this.retryAfter = Date.now() + 6e4;
          return;
        }
      }
    } finally {
      this.draining = false;
      this.claim.release();
    }
  }
  async command(command, args2, cwd) {
    if (this.closed) throw new Error("\u670D\u52A1\u6B63\u5728\u5173\u95ED");
    const result = await this.options.run(command, args2, {
      ...cwd ? { cwd } : {},
      timeoutMs: command === "git" && args2.includes("fetch") ? 12e4 : 3e4
    });
    if (this.closed) throw new Error("\u670D\u52A1\u6B63\u5728\u5173\u95ED");
    if (!result.ok)
      throw new Error(
        redact(
          `${command} ${args2.filter((arg) => !arg.startsWith("--force-with-lease")).join(" ")}\uFF1A${firstLine(result.stderr) || "\u6267\u884C\u5931\u8D25"}`
        )
      );
    return result.stdout.trim();
  }
  async pr(task, repo) {
    const output = await this.command("gh", [
      "pr",
      "view",
      task.pr_url,
      "-R",
      repo,
      "--json",
      "state,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit"
    ]);
    const value = JSON.parse(output);
    if (!value || typeof value !== "object")
      throw new Error("gh pr view \u6CA1\u6709\u8FD4\u56DE PR");
    const data2 = value;
    if (![data2.state, data2.headRefOid, data2.headRefName, data2.baseRefName].every(
      (item) => typeof item === "string" && !!item
    ) || typeof data2.isCrossRepository !== "boolean")
      throw new Error("gh pr view \u7F3A\u5C11\u5408\u5165\u6240\u9700\u5B57\u6BB5");
    return data2;
  }
  async process(task) {
    const { repo, worktree, branch, pr_url: url } = task;
    if (!repo || !worktree || !branch || !url)
      throw new Error("\u5408\u5165\u4EFB\u52A1\u7F3A\u5C11\u4ED3\u5E93\u3001\u5DE5\u4F5C\u6811\u3001\u5206\u652F\u6216 PR");
    const origin = await originRepo(repo, this.options.run);
    if ("error" in origin) throw new Error(redact(origin.error));
    const target = parsePrUrl(url);
    const flag = repoFlag(origin.repo);
    if (!target || repoFlag(target) !== flag)
      throw new MergeHold("PR \u4E0E\u4ED3\u5E93 origin \u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u5408\u5165");
    const base2 = await defaultBranch(repo, this.options.run);
    const before = await this.pr(task, flag);
    if (before.state === "MERGED") return this.merged(task, flag, before);
    if (this.stopped(task.id)) return;
    if (before.isCrossRepository)
      throw new MergeHold("PR \u6765\u6E90\u4E0D\u662F\u4ED3\u5E93 origin \u7684\u5206\u652F\uFF0C\u62D2\u7EDD\u5408\u5165");
    if (before.state !== "OPEN" || before.headRefName !== branch || before.baseRefName !== base2)
      throw new MergeHold("PR \u72B6\u6001\u3001\u6E90\u5206\u652F\u6216\u76EE\u6807\u5206\u652F\u4E0E\u4EFB\u52A1\u4E0D\u7B26");
    if (task.delivery_stage === "merging") {
      for (const kind of ["rebase-merge", "rebase-apply"]) {
        const path = await this.command("git", [
          "-C",
          worktree,
          "rev-parse",
          "--git-path",
          kind
        ]);
        if (existsSync6(path)) {
          await this.command("git", ["-C", worktree, "rebase", "--abort"]);
          break;
        }
      }
    }
    const head2 = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD"
    ]);
    if (head2 !== before.headRefOid) {
      const last = this.db.prepare(
        "SELECT detail FROM task_events WHERE task_id=? AND kind='merge_rebased' AND id>(SELECT COALESCE(MAX(id),0) FROM task_events WHERE task_id=? AND kind='merge_queued') ORDER BY id DESC LIMIT 1"
      ).get(task.id, task.id);
      let rebased = "";
      try {
        rebased = JSON.parse(last?.detail ?? "null")?.head ?? "";
      } catch {
      }
      if (rebased !== head2)
        throw new MergeHold("PR \u5934\u63D0\u4EA4\u4E0E\u4EFB\u52A1\u5DE5\u4F5C\u6811\u4E0D\u4E00\u81F4\uFF0C\u7B49\u5F85\u4EBA\u5DE5\u6838\u5BF9");
    }
    const dirty = await this.command("git", [
      "--no-optional-locks",
      "-C",
      worktree,
      "status",
      "--porcelain"
    ]);
    if (this.stopped(task.id)) return;
    if (dirty) throw new MergeHold("\u4EFB\u52A1\u5DE5\u4F5C\u6811\u5C1A\u6709\u672A\u63D0\u4EA4\u6539\u52A8\uFF0C\u62D2\u7EDD\u5408\u5165");
    await this.command("git", ["-C", repo, "fetch", "origin", base2]);
    const rebase = await this.options.run(
      "git",
      ["-C", worktree, "rebase", `origin/${base2}`],
      { timeoutMs: 12e4 }
    );
    if (this.closed) return;
    if (!rebase.ok) {
      const files = await this.options.run("git", [
        "-C",
        worktree,
        "diff",
        "--name-only",
        "--diff-filter=U"
      ]);
      await this.options.run("git", ["-C", worktree, "rebase", "--abort"]);
      if (this.stopped(task.id)) return;
      const conflict = files.stdout.trim().split("\n").filter(Boolean).slice(0, 30);
      return this.handBack(
        task,
        redact(
          `rebase \u51B2\u7A81\uFF1A${conflict.join("\u3001") || firstLine(rebase.stderr)}`
        )
      );
    }
    if (this.stopped(task.id)) return;
    const checkedHead = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD"
    ]);
    noteTask(this.db, task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "local_check_started", {});
    const checked = await runLocalCheck({
      worktree,
      taskDir: taskDir(this.options.data, task.id),
      env: this.options.env,
      signal: this.abort.signal,
      urgent: task.urgent === 1,
      onStatus: (status, log) => {
        if (!this.closed)
          noteTask(this.db, task.id, `merge_check_${status}`, { log });
      }
    });
    if (this.closed) return;
    if (this.stopped(task.id)) return;
    noteTask(this.db, task.id, "merge_check", checked);
    if (checked.status !== "passed")
      return this.handBack(
        task,
        `\u672C\u5730\u68C0\u67E5${checked.status}\uFF1A${checked.failedTests.join("\u3001") || checked.detail}\uFF1B\u65E5\u5FD7 ${checked.log}`
      );
    const afterCheckHead = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD"
    ]);
    if (afterCheckHead !== checkedHead || await this.command("git", [
      "--no-optional-locks",
      "-C",
      worktree,
      "status",
      "--porcelain"
    ]) !== "")
      throw new MergeHold("\u672C\u5730\u68C0\u67E5\u4FEE\u6539\u4E86\u5DE5\u4F5C\u6811\uFF0C\u62D2\u7EDD\u5408\u5165");
    if (this.stopped(task.id)) return;
    const remoteHead = async () => (await this.command("git", [
      "-C",
      repo,
      "ls-remote",
      "--heads",
      "origin",
      branch
    ])).split(/\s+/)[0];
    const remoteBeforePush = await remoteHead();
    if (remoteBeforePush !== checkedHead) {
      if (remoteBeforePush !== before.headRefOid)
        throw new MergeHold("\u68C0\u67E5\u540E\u8FDC\u7AEF\u5206\u652F\u5934\u63D0\u4EA4\u53D1\u751F\u53D8\u5316\uFF0C\u62D2\u7EDD\u5408\u5165");
      const pushed = await this.options.run(
        "git",
        [
          "-C",
          worktree,
          "push",
          `--force-with-lease=refs/heads/${branch}:${before.headRefOid}`,
          "origin",
          `HEAD:refs/heads/${branch}`
        ],
        { timeoutMs: 12e4 }
      );
      if (!pushed.ok)
        return this.handBack(
          task,
          `\u68C0\u67E5\u540E\u63A8\u9001\u5931\u8D25\uFF1A${firstLine(pushed.stderr) || "\u672A\u77E5\u539F\u56E0"}`
        );
    }
    if (this.closed) return;
    const deadline = Date.now() + (this.options.prHeadWaitMs ?? 6e4);
    let current2 = await this.pr(task, flag);
    while (current2.state === "OPEN" && current2.headRefOid !== checkedHead && Date.now() < deadline) {
      if (this.stopped(task.id) || this.closed) return;
      await new Promise(
        (resolve4) => setTimeout(resolve4, Math.min(1e3, deadline - Date.now()))
      );
      current2 = await this.pr(task, flag);
    }
    if (this.stopped(task.id) || this.closed) return;
    if (current2.state !== "OPEN" || current2.headRefOid !== checkedHead)
      throw new MergeHold(
        `\u7B49\u5F85 PR \u5934\u63D0\u4EA4\u66F4\u65B0\u8D85\u65F6\u6216\u72B6\u6001\u53D8\u5316\uFF1A\u68C0\u67E5\u8FC7 ${checkedHead}\uFF0CPR \u5934 ${current2.headRefOid}\uFF08${current2.state}\uFF09\uFF0C\u62D2\u7EDD\u5408\u5165`
      );
    const merge = await this.options.run(
      "gh",
      [
        "pr",
        "merge",
        url,
        "-R",
        flag,
        "--squash",
        "--match-head-commit",
        checkedHead
      ],
      { timeoutMs: 12e4 }
    );
    if (!merge.ok) {
      const state = await this.pr(task, flag);
      if (state.state === "MERGED") return this.merged(task, flag, state);
      if (this.stopped(task.id)) return;
      return this.handBack(
        task,
        redact(`gh \u5408\u5165\u5931\u8D25\uFF1A${firstLine(merge.stderr) || "\u672A\u77E5\u539F\u56E0"}`)
      );
    }
    const after = await this.pr(task, flag);
    if (after.state !== "MERGED")
      throw new Error("gh \u5408\u5165\u540E PR \u5C1A\u672A\u663E\u793A MERGED");
    await this.merged(task, flag, after);
  }
  async merged(task, flag, view7) {
    if (this.closed) return;
    const commit2 = typeof view7.mergeCommit?.oid === "string" && /^[0-9a-f]{7,64}$/i.test(view7.mergeCommit.oid) ? view7.mergeCommit.oid : null;
    const online = !!this.options.selfRepo && this.options.selfRepo === flag;
    this.db.prepare("UPDATE tasks SET merge_commit=?,online_wait=? WHERE id=?").run(commit2, online ? 1 : 0, task.id);
    this.stage(
      task.id,
      "merged",
      "merged",
      {
        pr_url: task.pr_url,
        ...commit2 ? { commit: commit2 } : {},
        ...online ? { online: "\u7B49\u53D1\u7248\u540E\u81EA\u52A8\u4E0A\u7EBF" } : {}
      },
      false
    );
    markDeliveryFinal(this.db, task.id, "merged");
    try {
      await this.options.cleaned?.(task.id);
    } catch (error) {
      console.error(`t${task.id} \u5DE5\u4F5C\u6811\u6E05\u7406\u5931\u8D25\uFF1A${redact(String(error))}`);
    }
    this.options.changed(task.id);
    this.options.publish(task.id, "merged", { pr_url: task.pr_url });
    if (online) this.options.onMerged?.(task.id);
  }
  /** 交回原执行者在原分支续做；超过次数转卡住。审阅打回也走这里。 */
  async handBack(task, reason) {
    if (this.closed) return;
    const safeReason = redact(reason);
    const decision = mergeFailure(task.merge_returns, safeReason);
    if (!decision.blocked) this.returning.add(task.id);
    atomically(this.db, () => {
      this.db.prepare(
        "UPDATE tasks SET delivery_stage=NULL,merge_queued_at=NULL,merge_returns=?,status='blocked',ended_at=NULL,updated_at=? WHERE id=?"
      ).run(decision.returns, Date.now(), task.id);
      noteTask(
        this.db,
        task.id,
        decision.blocked ? "merge_blocked" : "merge_returned",
        decision
      );
      markDeliveryFinal(
        this.db,
        task.id,
        isRebaseConflict(safeReason) ? "rebase_conflict" : "returned"
      );
      if (!decision.blocked)
        addTell(this.db, task.id, {
          text: `\u5408\u5165\u961F\u5217\u4EA4\u56DE\uFF08\u7B2C ${decision.returns} \u6B21\uFF09\uFF1A${safeReason}
\u8BF7\u5728\u539F\u5DE5\u4F5C\u6811\u548C\u539F\u5206\u652F\u4FEE\u590D\u3001\u91CD\u65B0\u8DD1\u68C0\u67E5\u3001\u63A8\u9001\u539F PR\u3002\u82E5\u5206\u652F\u5DF2\u53D8\u57FA\uFF0C\u8BF7\u4F7F\u7528 --force-with-lease \u63A8\u9001\u3002`,
          by: "u1",
          uuid: randomUUID3(),
          route: "next_run"
        });
    });
    this.options.changed(task.id);
    if (decision.blocked)
      this.options.publish(task.id, "blocked", {
        reason: safeReason,
        merge_returns: decision.returns
      });
    else {
      this.options.publish(task.id, "merge_returned", {
        reason: safeReason,
        merge_returns: decision.returns
      });
      try {
        await this.options.returned(getTask(this.db, task.id));
      } catch (error) {
        const why = redact(
          `\u4EA4\u56DE\u540E\u91CD\u6D3E\u539F\u6267\u884C\u8005\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
        );
        noteTask(this.db, task.id, "merge_return_launch_failed", {
          reason: why
        });
        this.options.publish(task.id, "blocked", { reason: why });
      } finally {
        this.returning.delete(task.id);
        this.options.changed(task.id);
      }
    }
  }
};

// server/tasks/worktree-cleanup.ts
import { existsSync as existsSync7 } from "node:fs";
import { realpath as realpath2 } from "node:fs/promises";
var WorktreeCleanup = class {
  constructor(db, run3 = exec, active = () => false) {
    this.db = db;
    this.run = run3;
    this.active = active;
  }
  db;
  run;
  active;
  cleaning = /* @__PURE__ */ new Map();
  candidate(id3) {
    return one(
      this.db,
      `SELECT id,repo,worktree,branch,status,delivery_stage FROM tasks
       WHERE id=? AND repo IS NOT NULL AND worktree IS NOT NULL
         AND (status='cancelled' OR (status='done' AND delivery_stage IN ('merged','online')))`,
      id3
    );
  }
  async cleanup(id3) {
    const pending = this.cleaning.get(id3);
    if (pending) {
      await pending;
      return false;
    }
    const task = this.candidate(id3);
    if (!task || this.active(id3)) return false;
    let finished2;
    this.cleaning.set(
      id3,
      new Promise((resolve4) => {
        finished2 = resolve4;
      })
    );
    try {
      const listed = await this.run("git", [
        "-C",
        task.repo,
        "worktree",
        "list",
        "--porcelain"
      ]);
      if (!listed.ok) throw new Error(redact(listed.stderr));
      const path = existsSync7(task.worktree) ? await realpath2(task.worktree) : task.worktree;
      const registered = listed.stdout.split("\n").some((line) => line === `worktree ${path}`);
      if (!registered && existsSync7(task.worktree))
        throw new Error(`t${id3} \u5DE5\u4F5C\u6811\u8DEF\u5F84\u5B58\u5728\u4F46\u672A\u767B\u8BB0\u5728 Git\uFF0C\u4FDD\u7559\u5F85\u6838\u5BF9`);
      if (registered) {
        const branch = await this.run("git", [
          "-C",
          task.worktree,
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD"
        ]);
        if (!branch.ok || branch.stdout.trim() !== task.branch)
          throw new Error(`t${id3} \u5DE5\u4F5C\u6811\u5206\u652F\u4E0E\u8D26\u672C\u4E0D\u4E00\u81F4\uFF0C\u4FDD\u7559\u5F85\u6838\u5BF9`);
        const removed = await this.run(
          "git",
          [
            "-C",
            task.repo,
            "worktree",
            "remove",
            ...task.status === "cancelled" ? ["--force"] : [],
            task.worktree
          ],
          { timeoutMs: 12e4 }
        );
        if (!removed.ok) throw new Error(redact(removed.stderr));
      }
      if (task.status === "done" && task.branch) {
        const found = await this.run("git", [
          "-C",
          task.repo,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${task.branch}`
        ]);
        if (found.ok) {
          const deleted = await this.run("git", [
            "-C",
            task.repo,
            "branch",
            "-D",
            task.branch
          ]);
          if (!deleted.ok) throw new Error(redact(deleted.stderr));
        }
      }
      this.db.prepare(
        "UPDATE tasks SET worktree=NULL,updated_at=? WHERE id=? AND worktree=?"
      ).run(Date.now(), id3, task.worktree);
      noteTask(this.db, id3, "worktree_cleaned", { path: task.worktree });
      return true;
    } finally {
      this.cleaning.delete(id3);
      finished2();
    }
  }
  /** 有界分页；同一轮里失败的任务只尝试一次。 */
  async finished() {
    let after = 0;
    let count2 = 0;
    for (; ; ) {
      const rows = all(
        this.db,
        `SELECT id FROM tasks WHERE id>? AND repo IS NOT NULL AND worktree IS NOT NULL
         AND (status='cancelled' OR (status='done' AND delivery_stage IN ('merged','online')))
         ORDER BY id LIMIT 100`,
        after
      );
      if (!rows.length) return count2;
      for (const row3 of rows) {
        try {
          if (await this.cleanup(row3.id)) count2++;
        } catch (error) {
          console.error(`t${row3.id} \u5DE5\u4F5C\u6811\u6E05\u7406\u5931\u8D25\uFF1A${redact(String(error))}`);
        }
      }
      after = rows.at(-1).id;
    }
  }
};

// server/tasks/review-runtime.ts
import { mkdirSync as mkdirSync7, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join16 } from "node:path";

// server/tasks/review.ts
var TRUSTED = TRUSTS.indexOf("medium");
function reviewNeed(risk, trust) {
  const actual = trust ?? "unknown";
  const reasons = [
    risk === "high" ? "\u4EFB\u52A1\u98CE\u9669 high" : "",
    TRUSTS.indexOf(actual) < TRUSTED ? `\u6267\u884C\u8005 trust=${actual}` : ""
  ].filter(Boolean);
  return reasons.length ? { needed: true, reason: reasons.join("\uFF0C") } : { needed: false };
}
function reviewerRefusal(original, candidate) {
  if (candidate.tool === original.tool)
    return `${candidate.tool} \u4E0E\u539F\u6267\u884C\u8005\u540C\u4E00\u5DE5\u5177`;
  if (candidate.model && original.model && candidate.model === original.model)
    return `${candidate.tool} \u4E0E\u539F\u6267\u884C\u8005\u540C\u4E00\u6A21\u578B ${candidate.model}`;
  const trust = candidate.trust ?? "unknown";
  if (TRUSTS.indexOf(trust) < TRUSTED)
    return `${candidate.tool} \u7684\u6863\u6848 trust=${trust}\uFF0C\u5BA1\u9605\u8005\u81F3\u5C11 medium`;
  return void 0;
}
var VERDICT_RE2 = /审阅结论\s*[:：]\s*\**\s*(通过|打回)/g;
var NOTES_MAX = 1500;
function parseReviewVerdict(text6) {
  if (!text6) return null;
  let last;
  for (const match of text6.matchAll(VERDICT_RE2)) last = match;
  if (!last) return null;
  const before = text6.slice(0, last.index).trim();
  const notes2 = before.length > NOTES_MAX ? `\u2026${before.slice(-NOTES_MAX)}` : before;
  return { passed: last[1] === "\u901A\u8FC7", notes: notes2 };
}
function diffSummary(stats) {
  const added = stats.reduce((sum, s) => sum + s.added, 0);
  const removed = stats.reduce((sum, s) => sum + s.removed, 0);
  const top = [...stats].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || a.file.localeCompare(b.file)
  ).slice(0, 10);
  const head2 = `\u6539\u52A8 ${stats.length} \u4E2A\u6587\u4EF6\uFF0C+${added} \u2212${removed}`;
  const text6 = top.length ? `${head2}\uFF1A${top.map((s) => `${s.file}\uFF08+${s.added} \u2212${s.removed}\uFF09`).join("\u3001")}${stats.length > top.length ? ` \u7B49` : ""}` : head2;
  return { files: stats.length, added, removed, top, text: text6 };
}
function reviewBrief2(input) {
  return [
    `# \u5BA1\u9605 ${input.ref} \u7684 PR`,
    "",
    `\u539F\u4EFB\u52A1\uFF1A${input.ref} ${input.title}`,
    `PR\uFF1A${input.prUrl}\uFF08gh \u67E5\u8BE2\u4E00\u5F8B\u5E26 -R ${input.repoFlag}\uFF09`,
    `\u4EE3\u7801\uFF1A${input.worktree}\uFF08\u5206\u652F\u5DF2\u63A8\u9001\uFF1B\u5BF9\u6BD4\u57FA\u7EBF origin/${input.base}\uFF09`,
    `\u4E3A\u4EC0\u4E48\u8981\u5BA1\u9605\uFF1A${input.reason}\uFF1B\u4EFB\u52A1\u98CE\u9669 ${input.risk}`,
    `\u6539\u52A8\u89C4\u6A21\uFF1A${input.diff.text}`,
    ...input.brief ? ["", "## \u539F\u4EFB\u52A1\u8BE6\u8FF0", "", input.brief.trim()] : [],
    "",
    "## \u600E\u4E48\u770B",
    "",
    `- \`gh pr diff ${input.prUrl} -R ${input.repoFlag}\` \u6216 \`git -C ${input.worktree} diff origin/${input.base}...HEAD\` \u770B\u6539\u52A8\uFF1B\u9700\u8981\u65F6\u8BFB\u5DE5\u4F5C\u6811\u91CC\u7684\u6587\u4EF6\u3002`,
    "- \u53EA\u8BFB\uFF1A\u4E0D\u8981\u4FEE\u6539\u3001\u63D0\u4EA4\u3001\u63A8\u9001\u5DE5\u4F5C\u6811\uFF0C\u4E0D\u8981\u5728 PR \u4E0A\u8BC4\u8BBA\u3001\u6279\u51C6\u6216\u5408\u5165\u3002",
    "",
    "## \u6E05\u5355",
    "",
    "1. \u6539\u52A8\u662F\u5426\u505A\u5230\u539F\u4EFB\u52A1\u8981\u6C42\uFF0C\u6709\u6CA1\u6709\u8D8A\u51FA\u4EFB\u52A1\u8303\u56F4\u7684\u6539\u52A8\u3002",
    "2. \u6B63\u786E\u6027\uFF1A\u8FB9\u754C\u6761\u4EF6\u3001\u9519\u8BEF\u5904\u7406\u3001\u5E76\u53D1\u4E0E\u91CD\u542F\u540E\u7684\u72B6\u6001\u3001\u65E7\u6570\u636E\u517C\u5BB9\u3002",
    "3. \u5B89\u5168\uFF1A\u51ED\u636E\u4E0D\u8FDB\u65E5\u5FD7\u4E0E\u8F93\u51FA\u3001SQL \u53C2\u6570\u5316\u3001\u8DEF\u5F84\u4E0E\u5916\u90E8\u8F93\u5165\u6821\u9A8C\u3001\u5B50\u8FDB\u7A0B\u73AF\u5883\u3002",
    "4. \u6D4B\u8BD5\uFF1A\u65B0\u589E\u5206\u652F\u662F\u5426\u6709\u6D4B\u8BD5\u8986\u76D6\uFF0C\u6D4B\u8BD5\u662F\u5426\u771F\u7684\u65AD\u8A00\u4E86\u884C\u4E3A\u3002",
    "5. \u53EF\u7EF4\u62A4\u6027\uFF1A\u662F\u5426\u7B26\u5408\u4ED3\u5E93 AGENTS.md \u7684\u7EA6\u5B9A\uFF0C\u6709\u6CA1\u6709\u660E\u663E\u91CD\u590D\u6216\u65E0\u7528\u4EE3\u7801\u3002",
    "",
    "## \u7ED3\u8BBA\u683C\u5F0F",
    "",
    "\u6253\u56DE\u65F6\u5148\u9010\u6761\u5199\u95EE\u9898\uFF08\u6587\u4EF6:\u884C\u3001\u73B0\u8C61\u3001\u600E\u4E48\u6539\uFF09\uFF0C\u53EA\u5199\u5FC5\u987B\u6539\u7684\uFF1B\u5C0F\u5EFA\u8BAE\u4E0D\u6253\u56DE\u3002",
    "\u6700\u540E\u4E00\u884C\u5FC5\u987B\u5355\u72EC\u5199 `\u5BA1\u9605\u7ED3\u8BBA\uFF1A\u901A\u8FC7` \u6216 `\u5BA1\u9605\u7ED3\u8BBA\uFF1A\u6253\u56DE`\uFF0C\u4E0D\u5199\u89C6\u4E3A\u6CA1\u6709\u7ED3\u8BBA\u3002",
    ""
  ].join("\n");
}

// server/tasks/review-runtime.ts
function taskRisk(db, id3) {
  const start = db.prepare(
    "SELECT detail FROM task_events WHERE task_id=? AND kind='start' ORDER BY id DESC LIMIT 1"
  ).get(id3);
  try {
    const risk = JSON.parse(start?.detail ?? "{}").detail?.risk;
    return isRisk(risk) ? risk : "low";
  } catch {
    return "low";
  }
}
function adoptedExit(db, id3) {
  const row3 = db.prepare(
    "SELECT detail FROM task_events WHERE task_id=? AND kind='exit_fail' ORDER BY id DESC LIMIT 1"
  ).get(id3);
  try {
    const reason = JSON.parse(row3?.detail ?? "{}").detail?.reason;
    return typeof reason === "string" && reason.startsWith(ADOPTED_EXIT);
  } catch {
    return false;
  }
}
var ReviewGate = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
  }
  db;
  options;
  closed = false;
  sweeping = false;
  close() {
    this.closed = true;
  }
  async worker(task) {
    if (!task.worker) return void 0;
    try {
      return await resolveWorker(task.worker, this.db);
    } catch {
      return void 0;
    }
  }
  /** 交付关卡通过后的去向：要审阅的进 reviewing，其余直接进合入队列；不走合入的返回 false。 */
  async admit(id3) {
    const task = getTask(this.db, id3);
    if (task.deliver !== "pr" || !task.pr_url || !task.repo) return false;
    const risk = taskRisk(this.db, id3);
    const original = await this.worker(task);
    const need = reviewNeed(risk, original?.profile.rules.trust);
    if (!need.needed) {
      this.options.enqueue(id3);
      return { kind: "merge_queued" };
    }
    const diff = await this.diff(task);
    atomically(this.db, () => {
      this.db.prepare(
        "UPDATE tasks SET delivery_stage='reviewing',review_task=NULL,merge_queued_at=NULL,updated_at=? WHERE id=?"
      ).run(Date.now(), id3);
      noteTask(this.db, id3, "review_needed", {
        reason: need.reason,
        risk,
        ...diff ? { diff } : {}
      });
    });
    this.options.changed(id3);
    this.kick();
    return {
      kind: "review_queued",
      detail: {
        reason: `\u5408\u5165\u524D\u5BA1\u9605\uFF1A${need.reason}${diff ? `\uFF1B${diff.text}` : ""}`,
        risk,
        next: `atrium task show ${task.ref}`
      }
    };
  }
  /** 改动规模：任务分支相对 origin/<默认分支>；查不到返回 undefined，不挡审阅。 */
  async diff(task) {
    if (!task.repo || !task.worktree) return void 0;
    try {
      const base2 = await defaultBranch(task.repo, this.options.run);
      const out = await this.options.run(
        "git",
        [
          "--no-optional-locks",
          "-C",
          task.worktree,
          "diff",
          "--numstat",
          `origin/${base2}...HEAD`
        ],
        { timeoutMs: 3e4 }
      );
      return out.ok ? diffSummary(parseNumstat(out.stdout)) : void 0;
    } catch {
      return void 0;
    }
  }
  kick() {
    if (this.closed || this.sweeping) return;
    void this.sweep().catch(
      (error) => console.error("\u5BA1\u9605\u5173\u5361\u5DE1\u68C0\u5931\u8D25\uFF1A", redact(String(error)))
    );
  }
  async sweep() {
    this.sweeping = true;
    try {
      const rows = this.db.prepare(
        "SELECT id FROM tasks WHERE delivery_stage='reviewing' ORDER BY id LIMIT 50"
      ).all();
      for (const { id: id3 } of rows) {
        if (this.closed) return;
        try {
          await this.step(getTask(this.db, id3));
        } catch (error) {
          noteTask(this.db, id3, "review_error", {
            reason: redact(
              error instanceof Error ? error.message : String(error)
            )
          });
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
  async step(task) {
    if (task.delivery_stage !== "reviewing") return;
    if (task.review_task === null) return this.startReview(task);
    const reviewer = getTask(this.db, task.review_task);
    if (this.options.inFlight(reviewer.id) || reviewer.status === "running")
      return;
    if (reviewer.status === "todo") return this.launch(task, reviewer);
    if (reviewer.status !== "done" && !(reviewer.status === "failed" && adoptedExit(this.db, reviewer.id)))
      return this.block(
        task,
        `\u5BA1\u9605\u4EFB\u52A1 ${reviewer.ref} ${reviewer.status}\uFF0C\u6CA1\u6709\u7ED9\u51FA\u7ED3\u8BBA`,
        reviewer.ref
      );
    const verdict2 = parseReviewVerdict(reviewer.result);
    if (!verdict2)
      return this.block(
        task,
        `\u5BA1\u9605\u4EFB\u52A1 ${reviewer.ref} \u6CA1\u6709\u5199\u300C\u5BA1\u9605\u7ED3\u8BBA\uFF1A\u901A\u8FC7/\u6253\u56DE\u300D`,
        reviewer.ref
      );
    const notes2 = redact(verdict2.notes);
    if (verdict2.passed) {
      noteTask(this.db, task.id, "review_passed", {
        reviewer: reviewer.ref,
        worker: reviewer.worker,
        ...notes2 ? { notes: notes2 } : {}
      });
      this.options.publish(task.id, "review_passed", {
        reviewer: reviewer.ref
      });
      this.options.enqueue(task.id);
      return;
    }
    noteTask(this.db, task.id, "review_rejected", {
      reviewer: reviewer.ref,
      worker: reviewer.worker,
      notes: notes2
    });
    await this.options.handBack(
      task,
      `\u5BA1\u9605\u6253\u56DE\uFF08${reviewer.ref}\uFF0C${reviewer.worker ?? "\u5BA1\u9605\u8005"}\uFF09\uFF1A${notes2 || "\u5BA1\u9605\u8005\u6CA1\u5199\u5177\u4F53\u95EE\u9898"}`
    );
  }
  async startReview(task) {
    const { repo, worktree, pr_url: url } = task;
    if (!repo || !worktree || !url)
      return this.block(task, "\u5BA1\u9605\u7F3A\u5C11\u4ED3\u5E93\u3001\u5DE5\u4F5C\u6811\u6216 PR");
    const original = await this.worker(task);
    let worker;
    try {
      worker = await this.options.pickReviewer(original);
    } catch (error) {
      return this.block(
        task,
        `\u627E\u4E0D\u5230\u5408\u683C\u7684\u5BA1\u9605\u8005\uFF1A${error instanceof Error ? error.message : String(error)}`
      );
    }
    const origin = await originRepo(repo, this.options.run);
    if ("error" in origin) return this.block(task, origin.error);
    const base2 = await defaultBranch(repo, this.options.run);
    const diff = await this.diff(task) ?? diffSummary([]);
    const risk = taskRisk(this.db, task.id);
    const need = reviewNeed(risk, original?.profile.rules.trust);
    const dir = taskDir(this.options.data, task.id);
    mkdirSync7(dir, { recursive: true, mode: 448 });
    const file = join16(dir, `review-${Date.now()}.md`);
    const text6 = clipBrief(
      reviewBrief2({
        ref: task.ref,
        title: task.title,
        prUrl: url,
        repoFlag: repoFlag(origin.repo),
        worktree,
        base: base2,
        risk,
        reason: need.needed ? need.reason : "\u6309\u89C4\u5219\u9700\u5BA1\u9605",
        diff,
        brief: task.brief ?? null
      })
    );
    writeFileSync8(file, text6, { mode: 384 });
    const reviewer = atomically(this.db, () => {
      const current2 = getTask(this.db, task.id);
      if (current2.delivery_stage !== "reviewing" || current2.review_task)
        return null;
      const created = createTask(this.db, {
        title: `\u5BA1\u9605 ${task.ref}\uFF1A${task.title}`.slice(0, 200),
        brief: text6,
        brief_path: file,
        deliver: "none",
        ...task.owner ? { owner: task.owner } : {}
      });
      noteTask(this.db, created.id, "review_of", { task: task.ref });
      this.db.prepare("UPDATE tasks SET review_task=?,updated_at=? WHERE id=?").run(created.id, Date.now(), task.id);
      noteTask(this.db, task.id, "review_started", {
        reviewer: created.ref,
        worker,
        diff: diff.text
      });
      return created;
    });
    if (!reviewer) return;
    this.options.changed(task.id);
    await this.launch(task, reviewer, worker);
  }
  async launch(task, reviewer, worker) {
    const chosen = worker ?? reviewer.worker;
    try {
      if (!chosen) {
        const original = await this.worker(task);
        await this.options.launch(
          reviewer.ref,
          await this.options.pickReviewer(original)
        );
      } else await this.options.launch(reviewer.ref, chosen);
    } catch (error) {
      this.block(
        task,
        `\u5BA1\u9605\u4EFB\u52A1 ${reviewer.ref} \u6D3E\u4E0D\u51FA\u53BB\uFF1A${error instanceof Error ? error.message : String(error)}`,
        reviewer.ref
      );
    }
  }
  block(task, reason, reviewer, by) {
    const safe = redact(reason);
    const moved = atomically(this.db, () => {
      const current2 = getTask(this.db, task.id);
      if (current2.delivery_stage !== "reviewing") return false;
      this.db.prepare(
        "UPDATE tasks SET delivery_stage=NULL,status='blocked',ended_at=NULL,updated_at=? WHERE id=?"
      ).run(Date.now(), task.id);
      noteTask(this.db, task.id, "review_blocked", { reason: safe });
      return true;
    });
    if (!moved) return;
    this.options.changed(task.id);
    this.options.publish(
      task.id,
      "blocked",
      {
        reason: safe,
        source: "review",
        next: `atrium task show ${reviewer ?? task.ref}`
      },
      by
    );
  }
  /** 用户停止审阅：停掉在跑的审阅者，原任务转卡住。不在审阅返回 null。 */
  stop(id3, by) {
    const task = getTask(this.db, id3);
    if (task.delivery_stage !== "reviewing") return null;
    if (task.review_task !== null && this.options.inFlight(task.review_task))
      try {
        this.options.stopTask(`t${task.review_task}`, by);
      } catch (error) {
        noteTask(this.db, id3, "review_error", {
          reason: redact(
            error instanceof Error ? error.message : String(error)
          )
        });
      }
    this.block(task, "\u7528\u6237\u505C\u6B62\u5BA1\u9605", void 0, by);
    return { stopping: false };
  }
};

// server/tasks/council-runtime.ts
import { mkdirSync as mkdirSync8, writeFileSync as writeFileSync9 } from "node:fs";
import { join as join17 } from "node:path";
function settleCouncils(db, data2, busy = () => false, limit = 50) {
  const progress = { dispatch: [], decided: [] };
  const open6 = all(
    db,
    `SELECT c.*, t.status AS status FROM task_councils c JOIN tasks t ON t.id=c.task_id
      WHERE c.stage IN ('opinions','summarizing') ORDER BY c.task_id LIMIT ?`,
    limit
  );
  for (const council of open6) {
    const id3 = council.task_id;
    if (council.status === "cancelled") continue;
    if (council.stage === "opinions") {
      const members = all(
        db,
        `SELECT m.opinion_id, t.status FROM council_members m JOIN tasks t ON t.id=m.opinion_id
          WHERE m.task_id=? ORDER BY m.pos LIMIT 50`,
        id3
      );
      if (!opinionsReady(
        members.map((m) => ({ status: m.status, busy: busy(m.opinion_id) }))
      ))
        continue;
      if (busy(id3)) continue;
      openSummary(db, data2, id3);
      progress.dispatch.push(taskRef(id3));
      continue;
    }
    if (busy(id3)) continue;
    if (council.status === "todo") progress.dispatch.push(taskRef(id3));
    else if (council.status === "done") {
      const decision = decide2(db, id3);
      if (decision) progress.decided.push(decision);
    }
  }
  return progress;
}
function openSummary(db, data2, id3) {
  const topic = topicOf(db, id3);
  const opinions = opinionsOf(db, id3);
  const council = councilRow(db, id3);
  const dir = taskDir(data2, id3);
  mkdirSync8(dir, { recursive: true, mode: 448 });
  const brief2 = join17(dir, "council-summary.md");
  const text6 = clipBrief(summaryBrief(topic, opinions, council.comment === 1));
  writeFileSync9(brief2, text6, { mode: 384 });
  atomically(db, () => {
    db.prepare(
      "UPDATE task_councils SET stage='summarizing' WHERE task_id=? AND stage='opinions'"
    ).run(id3);
    db.prepare(
      "UPDATE tasks SET brief=?,brief_path=?,updated_at=? WHERE id=?"
    ).run(text6, brief2, Date.now(), id3);
    noteTask(db, id3, "council_opinions", {
      opinions: opinions.map((o) => ({
        concern: o.ref,
        name: o.name,
        task: o.task,
        stance: o.stance,
        reason: o.reason
      }))
    });
  });
}
function decide2(db, id3) {
  const task = getTask(db, id3);
  const opinions = opinionsOf(db, id3);
  const summary2 = parseSummary(task.result ?? "");
  const outcome = councilOutcome(summary2, opinions);
  const now = Date.now();
  const changed2 = atomically(db, () => {
    const { changes } = db.prepare(
      "UPDATE task_councils SET stage=?,conclusion=?,escalate=?,agreed=?,conflicts=?,decided_by=?,decided_at=? WHERE task_id=? AND stage='summarizing'"
    ).run(
      outcome.kind,
      outcome.conclusion,
      JSON.stringify(outcome.escalate),
      JSON.stringify(summary2.agreed),
      JSON.stringify(summary2.conflicts),
      outcome.kind === "decided" ? "leader" : null,
      now,
      id3
    );
    if (!changes) return false;
    noteTask(db, id3, `council_${outcome.kind}`, {
      conclusion: outcome.conclusion,
      ...outcome.escalate.length ? { escalate: outcome.escalate } : {}
    });
    return true;
  });
  return changed2 ? { id: id3, outcome, opinions } : null;
}

// server/tasks/online-runtime.ts
import { execFile as execFile9 } from "node:child_process";
import { join as join20 } from "node:path";

// server/service-state.ts
import { DatabaseSync } from "node:sqlite";
import { randomBytes as randomBytes3, randomUUID as randomUUID4 } from "node:crypto";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync3,
  existsSync as existsSync8,
  mkdirSync as mkdirSync9,
  openSync as openSync3,
  readFileSync as readFileSync8,
  realpathSync
} from "node:fs";
import { join as join18, resolve } from "node:path";
import { homedir as homedir7 } from "node:os";
import { fileURLToPath } from "node:url";
var packageRoot = fileURLToPath(new URL("../", import.meta.url));
var bootVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync8(join18(packageRoot, "package.json"), "utf8")
    );
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();
function currentVersion() {
  return bootVersion;
}
function dataDirectory(env = process.env) {
  const path = resolve(env.ATRIUM_DATA ?? join18(homedir7(), ".atrium"));
  return existsSync8(path) ? realpathSync(path) : path;
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
function alive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function decode(value) {
  if (!value) return null;
  return parseServiceRecord(JSON.parse(value.record));
}
function claimService(data2, port) {
  mkdirSync9(data2, { recursive: true, mode: 448 });
  const path = join18(data2, "service.sqlite");
  closeSync3(openSync3(path, "a", 384));
  chmodSync2(path, 384);
  const db = new DatabaseSync(path);
  const record = {
    instance: randomUUID4(),
    pid: process.pid,
    port,
    token: randomBytes3(32).toString("hex")
  };
  try {
    db.exec(
      "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS service (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL); BEGIN IMMEDIATE"
    );
    const previous = decode(
      db.prepare("SELECT record FROM service WHERE id=1").get()
    );
    if (previous && alive2(previous.pid))
      throw new Error(
        `Atrium \u5DF2\u8FD0\u884C\u6216\u6B63\u5728\u542F\u52A8\uFF08PID ${previous.pid}\uFF09\uFF1B\u4E0D\u4F1A\u91CD\u590D\u542F\u52A8\u3002`
      );
    db.prepare("INSERT OR REPLACE INTO service(id,record) VALUES(1, ?)").run(
      JSON.stringify(record)
    );
    db.exec("COMMIT");
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return {
    record,
    release() {
      if (released) return;
      released = true;
      try {
        db.prepare("DELETE FROM service WHERE id=1 AND record=?").run(
          JSON.stringify(record)
        );
      } finally {
        db.close();
      }
    }
  };
}

// server/supervisor.ts
import { randomBytes as randomBytes4 } from "node:crypto";
import {
  closeSync as closeSync4,
  existsSync as existsSync9,
  mkdirSync as mkdirSync10,
  openSync as openSync4,
  readFileSync as readFileSync9,
  renameSync as renameSync3,
  writeFileSync as writeFileSync10,
  unlinkSync as unlinkSync2
} from "node:fs";
import { join as join19 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// server/local-http.ts
var { request } = process.getBuiltinModule(
  "node:http"
);
function localFetch(url, init = {}) {
  return new Promise((resolvePromise, reject3) => {
    const headers = { ...init.headers };
    if (init.body !== void 0)
      headers["content-length"] = Buffer.byteLength(init.body);
    const failed = (error) => reject3(new Error(`\u8FDE\u63A5\u670D\u52A1\u5931\u8D25\uFF1A${error.message}`, { cause: error }));
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
            for (const [name2, value] of Object.entries(res.headers)) {
              if (value === void 0) continue;
              for (const item of Array.isArray(value) ? value : [value])
                responseHeaders.append(name2, item);
            }
            return responseHeaders;
          };
          const body3 = new Promise((resolveBody, rejectBody) => {
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
          body3.catch(() => {
          });
          resolvePromise({
            ok: status >= 200 && status < 300,
            status,
            get headers() {
              return headersOf();
            },
            text: () => body3,
            json: async () => JSON.parse(await body3)
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
function classifyPortReply(status, body3) {
  let parsed;
  try {
    parsed = JSON.parse(body3);
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
function portTakenMessage(port, owner, data2) {
  if (owner.kind === "free") return null;
  if (owner.kind === "other")
    return `\u7AEF\u53E3 ${port} \u5DF2\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\uFF1B\u6362\u7AEF\u53E3\u8BF7\u8BBE ATRIUM_PORT=<\u7AEF\u53E3>`;
  if (owner.data === data2) return null;
  if (owner.data === null)
    return `\u7AEF\u53E3 ${port} \u5DF2\u88AB\u53E6\u4E00\u4E2A Atrium \u5360\u7528\uFF08\u7248\u672C\u8F83\u65E7\uFF0C\u67E5\u4E0D\u5230\u5B83\u7684\u6570\u636E\u76EE\u5F55\uFF09\uFF1B\u672C\u6B21\u6570\u636E\u5728 ${data2}\u3002\u8981\u8FDE\u5B83\u8BF7\u628A ATRIUM_DATA \u8BBE\u6210\u5B83\u7684\u6570\u636E\u76EE\u5F55\uFF0C\u8981\u53E6\u8D77\u4E00\u4EFD\u8BF7\u8BBE ATRIUM_PORT=<\u7AEF\u53E3>`;
  return `\u7AEF\u53E3 ${port} \u5DF2\u88AB\u53E6\u4E00\u4EFD\u6570\u636E\u7684 Atrium \u5360\u7528\uFF1A\u6570\u636E\u5728 ${owner.data}\uFF1B\u8981\u7528\u5B83\u8BF7\u8BBE ATRIUM_DATA=${owner.data}`;
}

// server/service-env.ts
var SYSTEM2 = /* @__PURE__ */ new Set([
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
var NETWORK2 = /* @__PURE__ */ new Set([
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
function allowed(key) {
  return SYSTEM2.has(key) || NETWORK2.has(key) || ISOLATION.has(key) || key.startsWith("ATRIUM_") || key.startsWith("LC_");
}
function droppedSensitiveNames(keys) {
  return [...keys].filter(
    (key) => /^(ANTHROPIC|CLAUDE|OPENAI|GH|GITHUB|HERDR|PI)_/.test(key) || /_(API_KEY|TOKEN)$/.test(key) || key === "SSH_AUTH_SOCK"
  ).sort();
}
function serviceEnvironment(base2 = process.env) {
  const env = {};
  const keys = Object.keys(base2);
  for (const key of keys) {
    const value = base2[key];
    if (value !== void 0 && allowed(key)) env[key] = value;
  }
  const kept = new Set(Object.keys(env));
  return {
    env,
    droppedSensitive: droppedSensitiveNames(keys.filter((k) => !kept.has(k)))
  };
}

// server/install-version.ts
import { execFile as execFile7 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync = promisify2(execFile7);

// server/supervisor.ts
var { request: httpRequest } = process.getBuiltinModule(
  "node:http"
);
function restartStatePath(data2) {
  return join19(data2, "restart-state.json");
}
function readRestartState(data2) {
  const path = restartStatePath(data2);
  if (!existsSync9(path)) return null;
  try {
    const state = JSON.parse(
      readFileSync9(path, "utf8")
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
      renameSync3(path, preserved);
      console.warn(`\u91CD\u542F\u72B6\u6001\u8BB0\u5F55\u635F\u574F\uFF0C\u5DF2\u79FB\u81F3 ${preserved}\uFF1A${String(error)}`);
    } catch (moveError) {
      console.warn(`\u91CD\u542F\u72B6\u6001\u8BB0\u5F55\u635F\u574F\u4E14\u65E0\u6CD5\u632A\u5F00 ${path}\uFF1A${String(moveError)}`);
    }
    return null;
  }
}
function discardLegacyIdleRestart(data2) {
  const state = readRestartState(data2);
  if (state?.status !== "waiting_idle" && state?.status !== "idle_timeout")
    return false;
  try {
    unlinkSync2(restartStatePath(data2));
    console.warn(
      `[${(/* @__PURE__ */ new Date()).toISOString()}] \u4E22\u5F03\u65E7\u7248\u5F85\u7A7A\u95F2\u91CD\u542F\u8BB0\u5F55\uFF08${state.id}\uFF0C${state.status}\uFF09\uFF1A\u91CD\u542F\u5DF2\u4E0D\u9700\u8981\u7B49\u6267\u884C\u8005\u7A7A\u95F2\uFF0C\u4E0D\u518D\u6321\u6D3E\u6D3B`
    );
  } catch (error) {
    console.warn(`\u4E22\u5F03\u65E7\u7248\u5F85\u7A7A\u95F2\u91CD\u542F\u8BB0\u5F55\u5931\u8D25\uFF1A${String(error)}`);
  }
  return true;
}
function restartInProgress(data2) {
  const state = readRestartState(data2);
  return state && ["stopping", "starting", "checking", "rolling_back"].includes(
    state.status
  ) && state.supervisorPid > 0 && state.supervisorPid !== process.pid && alive2(state.supervisorPid) ? state : null;
}
function writeRestartState(data2, state) {
  mkdirSync10(data2, { recursive: true, mode: 448 });
  const path = restartStatePath(data2);
  const temp = `${path}.${process.pid}.${randomBytes4(6).toString("hex")}.tmp`;
  try {
    writeFileSync10(temp, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 384,
      flag: "wx"
    });
    renameSync3(temp, path);
  } finally {
    if (existsSync9(temp)) unlinkSync2(temp);
  }
}

// server/releases.ts
import { execFile as execFile8 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync2 = promisify3(execFile8);
function parseSemver(v) {
  const trimmed = v.trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!m) throw new Error(`\u65E0\u6548\u7684\u8BED\u4E49\u5316\u7248\u672C\u53F7\uFF1A${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}
function compareSemver(a, b) {
  let pa;
  let pb;
  try {
    pa = parseSemver(a);
  } catch {
    pa = [0, 0, 0, a];
  }
  try {
    pb = parseSemver(b);
  } catch {
    pb = [0, 0, 0, b];
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  if (pa[3] && !pb[3]) return -1;
  if (!pa[3] && pb[3]) return 1;
  if (pa[3] && pb[3]) return pa[3].localeCompare(pb[3]);
  return 0;
}

// server/tasks/online.ts
var RELEASE_OVERDUE_MS = 30 * 6e4;
function selfRepoFlag(source2) {
  const text6 = source2.trim();
  const remote = text6.startsWith("github:") ? parseRemote(`https://github.com/${text6.slice("github:".length)}.git`) : parseRemote(text6);
  return remote ? repoFlag(remote) : null;
}
function selfUpdateEnabled(setting, service) {
  if (setting === "0") return false;
  if (setting === "1") return true;
  return !service.gitCheckout && service.defaultData;
}
function firstRelease(tags) {
  const versions = tags.split("\n").map((tag) => tag.trim()).filter((tag) => {
    try {
      parseSemver(tag);
      return /^v/.test(tag);
    } catch {
      return false;
    }
  }).map((tag) => tag.slice(1)).sort(compareSemver);
  return versions[0] ?? null;
}
function includedInVersion(tags, current2) {
  return tags.split("\n").some((tag) => tag.trim() === `v${current2}`);
}
function verificationSection(text6) {
  if (!text6) return null;
  const lines2 = text6.replace(/\r\n/g, "\n").split("\n");
  let fence = false;
  let start = -1;
  let level = 0;
  const out = [];
  for (const line of lines2) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (start < 0) {
      if (heading && heading[2].includes("\u7AEF\u5230\u7AEF\u9A8C\u8BC1")) {
        start = out.length;
        level = heading[1].length;
      }
      continue;
    }
    if (heading && heading[1].length <= level) break;
    out.push(line);
  }
  if (start < 0) return null;
  while (out.length && (!out.at(-1).trim() || /^\s*((refs|closes|fixes|resolves)\s+#\d+|🤖 generated with)/i.test(
    out.at(-1)
  )))
    out.pop();
  const body3 = out.join("\n").trim();
  return body3 ? body3.slice(0, 4e3) : null;
}
function planOnline(candidates, current2, options) {
  const plan2 = {
    online: [],
    failed: [],
    deploy: null,
    deploying: [],
    skipped: []
  };
  const behind = [];
  for (const task of candidates) {
    if (task.release === null) continue;
    if (compareSemver(task.release, current2) <= 0) plan2.online.push(task.id);
    else if (task.attempted !== null && compareSemver(task.attempted, task.release) >= 0)
      plan2.failed.push(task.id);
    else behind.push(task);
  }
  if (!behind.length) return plan2;
  if (!options.selfUpdate) {
    plan2.skipped = behind.map((task) => task.id);
    return plan2;
  }
  if (options.busy) return plan2;
  plan2.deploy = behind.map((task) => task.release).sort(compareSemver).at(-1);
  plan2.deploying = behind.map((task) => task.id);
  return plan2;
}
function onlineMessage(ref2, version) {
  return `${ref2} \u5DF2\u4E0A\u7EBF\uFF08v${version}\uFF09`;
}

// server/tasks/online-runtime.ts
var RESTART_GRACE_MS = 10 * 6e4;
var OnlineWatch = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
  }
  db;
  options;
  running = false;
  closed = false;
  restartingUntil = 0;
  legacyCursor = 0;
  close() {
    this.closed = true;
  }
  kick() {
    if (this.closed || this.running) return;
    void this.tick().catch(
      (error) => console.error("\u81EA\u52A8\u4E0A\u7EBF\u5931\u8D25\uFF1A", redact(String(error)))
    );
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  rows() {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE delivery_stage='merged' AND online_wait=1 ORDER BY id LIMIT 100"
    ).all();
  }
  async tick() {
    if (this.closed || this.running || this.now() < this.restartingUntil)
      return;
    this.running = true;
    try {
      let rows = this.rows();
      if (!rows.length) {
        await this.backfillLegacy(this.options.version());
        return;
      }
      await this.findReleases(rows.filter((row3) => !row3.release_version));
      if (this.closed) return;
      rows = this.rows();
      const current2 = this.options.version();
      const plan2 = planOnline(
        rows.map((row3) => ({
          id: row3.id,
          release: row3.release_version,
          attempted: row3.online_attempt
        })),
        current2,
        { selfUpdate: this.options.selfUpdate, busy: this.options.busy() }
      );
      const published = [];
      for (const id3 of plan2.online)
        published.push({ id: id3, detail: await this.prepareOnline(id3, current2) });
      atomically(this.db, () => {
        for (const item of published) {
          this.db.prepare(
            "UPDATE tasks SET delivery_stage='online',online_wait=0,updated_at=? WHERE id=?"
          ).run(this.now(), item.id);
          noteTask(this.db, item.id, "online", {
            version: current2,
            release: item.detail.release,
            verification: item.detail.hasVerification
          });
          const { hasVerification: _, ...detail2 } = item.detail;
          this.options.publish(item.id, "online", detail2);
        }
      });
      for (const item of published) this.options.changed(item.id);
      for (const id3 of plan2.failed) {
        const task = getTask(this.db, id3);
        this.fail(
          id3,
          this.options.restartError?.(task.online_attempt ?? "") ?? `\u5DF2\u4E3A v${task.online_attempt} \u81EA\u5347\u7EA7\u5E76\u91CD\u542F\uFF0C\u8FD0\u884C\u7248\u672C\u4ECD\u662F v${current2}`
        );
      }
      for (const id3 of plan2.skipped) {
        atomically(this.db, () => {
          this.db.prepare("UPDATE tasks SET online_wait=0,updated_at=? WHERE id=?").run(this.now(), id3);
          noteTask(this.db, id3, "online_skipped", {
            reason: "\u672C\u670D\u52A1\u4E0D\u81EA\u5347\u7EA7\uFF08\u5F00\u53D1\u4E2D\u7684\u68C0\u51FA\u3001\u53E6\u7ED9 ATRIUM_DATA \u7684\u9694\u79BB\u670D\u52A1\u6216 ATRIUM_SELF_UPDATE=0\uFF09\uFF0C\u505C\u5728\u5DF2\u5408\u5165"
          });
        });
        this.options.changed(id3);
      }
      if (plan2.deploy && !this.closed) await this.deploy(plan2);
      if (!this.closed) await this.backfillLegacy(current2);
    } finally {
      this.running = false;
    }
  }
  /** 旧任务没有 online_wait；只有合入提交确实落在运行版本内才补状态，不补通知。 */
  async backfillLegacy(current2) {
    if (!this.options.selfRepo) return;
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE id>? AND delivery_stage='merged' AND online_wait=0
         AND release_version IS NULL AND online_attempt IS NULL AND repo IS NOT NULL
         ORDER BY id LIMIT 100`
    ).all(this.legacyCursor);
    if (!rows.length) {
      this.legacyCursor = 0;
      return;
    }
    const fetched = /* @__PURE__ */ new Map();
    for (const row3 of rows) {
      if (this.closed) return;
      this.legacyCursor = row3.id;
      if (!row3.repo) continue;
      const origin = await originRepo(row3.repo, this.options.run);
      if ("error" in origin || repoFlag(origin.repo) !== this.options.selfRepo)
        continue;
      const commit2 = row3.merge_commit ?? await this.mergeCommit(row3);
      if (!commit2) continue;
      if (!fetched.has(row3.repo)) {
        const fetch2 = await this.options.run(
          "git",
          ["-C", row3.repo, "fetch", "--quiet", "--tags", "--force", "origin"],
          { timeoutMs: 12e4 }
        );
        fetched.set(row3.repo, fetch2.ok);
      }
      if (!fetched.get(row3.repo)) continue;
      const tags = await this.options.run("git", [
        "-C",
        row3.repo,
        "tag",
        "--contains",
        commit2,
        "--list",
        "v*"
      ]);
      const release = tags.ok ? firstRelease(tags.stdout) : null;
      if (!release || !includedInVersion(tags.stdout, current2) || compareSemver(release, current2) > 0)
        continue;
      atomically(this.db, () => {
        this.db.prepare(
          "UPDATE tasks SET delivery_stage='online',release_version=?,updated_at=? WHERE id=? AND delivery_stage='merged'"
        ).run(release, this.now(), row3.id);
        noteTask(this.db, row3.id, "online_backfilled", {
          version: current2,
          release
        });
      });
      this.options.changed(row3.id);
    }
    if (rows.length < 100) this.legacyCursor = 0;
  }
  /** 按仓库拉一次标签，找含合入提交的最早版本；超时没发版提醒一次。 */
  async findReleases(rows) {
    const fetched = /* @__PURE__ */ new Map();
    for (const row3 of rows) {
      if (this.closed || !row3.repo) return;
      let commit2 = row3.merge_commit;
      if (!commit2) commit2 = await this.mergeCommit(row3);
      if (commit2) {
        if (!fetched.has(row3.repo)) {
          const fetch2 = await this.options.run(
            "git",
            ["-C", row3.repo, "fetch", "--quiet", "--tags", "--force", "origin"],
            { timeoutMs: 12e4 }
          );
          if (!fetch2.ok)
            console.error(
              "\u81EA\u52A8\u4E0A\u7EBF\u62C9\u53D6\u6807\u7B7E\u5931\u8D25\uFF1A",
              redact(firstLine(fetch2.stderr))
            );
          fetched.set(row3.repo, fetch2.ok);
        }
        if (fetched.get(row3.repo)) {
          const tags = await this.options.run("git", [
            "-C",
            row3.repo,
            "tag",
            "--contains",
            commit2,
            "--list",
            "v*"
          ]);
          const version = tags.ok ? firstRelease(tags.stdout) : null;
          if (version) {
            atomically(this.db, () => {
              this.db.prepare(
                "UPDATE tasks SET release_version=?,updated_at=? WHERE id=?"
              ).run(version, this.now(), row3.id);
              noteTask(this.db, row3.id, "released", { version });
            });
            this.options.changed(row3.id);
            continue;
          }
        }
      }
      this.overdue(row3);
    }
  }
  async mergeCommit(row3) {
    if (!row3.pr_url || !row3.repo) return null;
    const origin = await originRepo(row3.repo, this.options.run);
    if ("error" in origin) return null;
    const view7 = await this.options.run("gh", [
      "pr",
      "view",
      row3.pr_url,
      "-R",
      repoFlag(origin.repo),
      "--json",
      "mergeCommit"
    ]);
    if (!view7.ok) return null;
    try {
      const oid = JSON.parse(view7.stdout).mergeCommit?.oid;
      if (typeof oid !== "string" || !/^[0-9a-f]{7,64}$/i.test(oid))
        return null;
      this.db.prepare("UPDATE tasks SET merge_commit=? WHERE id=?").run(oid, row3.id);
      return oid;
    } catch {
      return null;
    }
  }
  overdue(row3) {
    const merged = this.db.prepare(
      "SELECT at FROM task_events WHERE task_id=? AND kind='merged' ORDER BY id DESC LIMIT 1"
    ).get(row3.id);
    if (!merged || this.now() - merged.at < RELEASE_OVERDUE_MS) return;
    const told = this.db.prepare(
      "SELECT 1 FROM task_events WHERE task_id=? AND kind='release_overdue' AND id>(SELECT MAX(id) FROM task_events WHERE task_id=? AND kind='merged') LIMIT 1"
    ).get(row3.id, row3.id);
    if (told) return;
    const reason = `\u5408\u5165 ${Math.round(RELEASE_OVERDUE_MS / 6e4)} \u5206\u949F\u4ECD\u6CA1\u6709\u542B\u5B83\u7684\u7248\u672C\uFF1B\u67E5\u770B\u4ED3\u5E93\u7684\u53D1\u7248\u5DE5\u4F5C\u6D41`;
    noteTask(this.db, row3.id, "release_overdue", { reason });
    this.options.publish(row3.id, "release_overdue", { reason });
  }
  async prepareOnline(id3, current2) {
    const task = getTask(this.db, id3);
    let body3 = null;
    if (task.pr_url && task.repo) {
      const origin = await originRepo(task.repo, this.options.run);
      if (!("error" in origin)) {
        const view7 = await this.options.run("gh", [
          "pr",
          "view",
          task.pr_url,
          "-R",
          repoFlag(origin.repo),
          "--json",
          "body"
        ]);
        if (view7.ok)
          try {
            const value = JSON.parse(view7.stdout).body;
            if (typeof value === "string") body3 = value;
          } catch {
          }
      }
    }
    const verification = verificationSection(body3) ?? verificationSection(task.result);
    const message4 = onlineMessage(task.ref, current2);
    return {
      message: message4,
      version: current2,
      release: task.release_version,
      hasVerification: verification !== null,
      verification: verification ?? "\u6267\u884C\u8005\u6CA1\u6709\u5199\u300C\u7AEF\u5230\u7AEF\u9A8C\u8BC1\u300D\u4E00\u8282\uFF1B\u8BF7\u6309\u4EFB\u52A1\u76EE\u6807\u81EA\u884C\u9A8C\u8BC1"
    };
  }
  fail(id3, why) {
    const reason = redact(why);
    atomically(this.db, () => {
      this.db.prepare("UPDATE tasks SET online_wait=0,updated_at=? WHERE id=?").run(this.now(), id3);
      noteTask(this.db, id3, "online_failed", { reason });
    });
    this.options.changed(id3);
    this.options.publish(id3, "online_failed", { reason });
  }
  async deploy(plan2) {
    const version = plan2.deploy;
    atomically(this.db, () => {
      for (const id3 of plan2.deploying) {
        this.db.prepare("UPDATE tasks SET online_attempt=?,updated_at=? WHERE id=?").run(version, this.now(), id3);
        noteTask(this.db, id3, "online_deploy", { version });
      }
    });
    for (const id3 of plan2.deploying) this.options.changed(id3);
    const result = await this.options.deploy(version);
    if (result.ok) {
      this.restartingUntil = this.now() + RESTART_GRACE_MS;
      return;
    }
    for (const id3 of plan2.deploying)
      this.fail(id3, `\u81EA\u5347\u7EA7\u5230 v${version} \u5931\u8D25\uFF1A${result.reason}`);
  }
};
function cliDeploy(data2, env = process.env) {
  const bin = join20(packageRoot, "bin", "atrium.mjs");
  const cli = (args2, timeout) => new Promise((resolve4) => {
    execFile9(
      process.execPath,
      [bin, ...args2],
      {
        cwd: data2,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...env, ATRIUM_DATA: data2 }
      },
      (error, stdout, stderr) => resolve4({
        ok: !error,
        output: [stdout, stderr, error?.message].filter(Boolean).map(String).join("\n").trim()
      })
    );
  });
  return async (version) => {
    const update2 = await cli(["update", "--to", version], 10 * 6e4);
    if (!update2.ok)
      return {
        ok: false,
        reason: `atrium update\uFF1A${redact(update2.output) || "\u6267\u884C\u5931\u8D25"}`
      };
    const restart = await cli(["restart"], 6e4);
    if (!restart.ok)
      return {
        ok: false,
        reason: `atrium restart\uFF1A${redact(restart.output) || "\u6267\u884C\u5931\u8D25"}`
      };
    return { ok: true };
  };
}
function lastRestartError(data2, version) {
  const state = readRestartState(data2);
  if (!state || state.status !== "rolled_back" && state.status !== "failed" || state.targetVersion !== version && state.failedVersion !== version)
    return null;
  return `\u81EA\u5347\u7EA7\u91CD\u542F${state.status === "rolled_back" ? `\u5DF2\u56DE\u6EDA\u5230 v${state.rollbackVersion ?? state.fromVersion}` : "\u5931\u8D25"}\uFF1A${state.error ?? "\u672A\u77E5\u539F\u56E0"}`;
}

// server/tasks/runner.ts
import { existsSync as existsSync10 } from "node:fs";
var TaskRunner = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
    ensureQueueTable(db);
    ensureWorkerProfiles(db);
    importWorkerProfiles(db, options.workersDir);
    this.host = options.host ?? HostLoad.fromEnv(process.env);
    sharedLocalChecks.limit = this.host.limits.maxChecks;
    this.inbox = new EventInbox(db, {
      batchMs: options.batchMs,
      leaseMs: options.leaseMs
    });
    this.exec = options.exec ?? exec;
    const sourceEnv = options.env ?? process.env;
    this.launchOptions = {
      db,
      data: options.data,
      env: workerEnvironment(sourceEnv),
      patrolServiceEnv: {
        ...sourceEnv.ATRIUM_DATA ? { ATRIUM_DATA: sourceEnv.ATRIUM_DATA } : {},
        ...sourceEnv.ATRIUM_PORT ? { ATRIUM_PORT: sourceEnv.ATRIUM_PORT } : {}
      },
      run: this.exec,
      pace: options.pace,
      usagePace: options.usagePace
    };
    this.cleanup = new WorktreeCleanup(
      db,
      this.exec,
      (id3) => this.x?.active.has(id3) || this.x?.launching.has(id3) || this.x?.finishing.has(id3)
    );
    this.disk = new DiskBudget(
      db,
      options.data,
      options.diskFreeGb,
      this.cleanup
    );
    this.waits = new TaskWaits(
      (id3) => this.settled(id3),
      (id3) => getTask(this.db, id3)
    );
    this.quota = new QuotaGuard({
      db,
      inbox: this.inbox,
      launchOptions: this.launchOptions,
      unknownMs: options.quotaUnknownMs
    });
    this.x = new Executors({
      db,
      inbox: this.inbox,
      exec: this.exec,
      launchOptions: this.launchOptions,
      waits: this.waits,
      quota: this.quota,
      disk: this.disk,
      killGraceMs: options.killGraceMs,
      closed: () => this.closed,
      onAccepted: (id3) => this.review.admit(id3),
      hostGate: (urgent) => this.host.gate(this.x.inFlight(), urgent),
      reviews: {
        dispatch: (ref2) => this.run(ref2, {}),
        settle: () => void this.settleReviews()
      },
      // 在收尾的 finally 之后再推进，免得刚结束的任务还算在收尾里。
      councils: {
        settle: () => setImmediate(
          () => this.settleCouncils().catch(
            (error) => console.error("\u4F1A\u5BA1\u63A8\u8FDB\u5931\u8D25\uFF1A", error)
          )
        )
      }
    });
    this.merge = new MergeQueue(db, {
      data: options.data,
      env: this.launchOptions.env,
      run: this.exec,
      prHeadWaitMs: options.mergeHeadWaitMs,
      changed: (id3) => this.waits.changed(id3),
      cleaned: async (id3) => {
        await this.cleanup.cleanup(id3);
      },
      publish: (id3, kind, detail2, actor) => this.x.publish(id3, kind, detail2, actor),
      selfRepo: options.online?.selfRepo !== void 0 ? options.online.selfRepo : selfRepoFlag(
        process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium"
      ),
      onMerged: () => this.online.kick(),
      returned: async (task) => {
        if (this.closed || !task.worker) return;
        await this.run(task.ref, {
          worker: task.worker,
          risk: taskRisk(this.db, task.id)
        });
      }
    });
    this.review = new ReviewGate(db, {
      data: options.data,
      run: this.exec,
      pickReviewer: (original) => this.pickReviewer(original),
      launch: (ref2, worker) => this.run(ref2, { worker, risk: "low" }),
      inFlight: (id3) => this.pending(id3, getTask(this.db, id3)),
      stopTask: (ref2, by) => void this.stop(ref2, by),
      enqueue: (id3) => this.merge.enqueue(id3),
      handBack: (task, reason) => this.merge.handBack(task, reason),
      changed: (id3) => this.waits.changed(id3),
      publish: (id3, kind, detail2, actor) => this.x.publish(id3, kind, detail2, actor)
    });
    this.online = new OnlineWatch(db, {
      run: this.exec,
      version: options.online?.version ?? currentVersion,
      selfUpdate: options.online?.selfUpdate ?? selfUpdateEnabled(process.env.ATRIUM_SELF_UPDATE, {
        gitCheckout: existsSync10(join21(packageRoot, ".git")),
        defaultData: options.data === dataDirectory({})
      }),
      selfRepo: options.online?.selfRepo !== void 0 ? options.online.selfRepo : selfRepoFlag(
        process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium"
      ),
      busy: () => !!this.db.prepare("SELECT 1 FROM tasks WHERE delivery_stage='merging' LIMIT 1").get() || !!restartInProgress(options.data),
      deploy: options.online?.deploy ?? cliDeploy(options.data),
      restartError: (version) => lastRestartError(options.data, version),
      publish: (id3, kind, detail2) => this.x.publish(id3, kind, detail2),
      changed: (id3) => this.waits.changed(id3)
    });
    this.scheduler = new Scheduler(
      db,
      this.inbox,
      (ref2) => this.run(ref2, {}),
      options.exec ?? schedulePrExec
    );
  }
  db;
  options;
  inbox;
  x;
  waits;
  quota;
  scheduler;
  disk;
  cleanup;
  merge;
  review;
  online;
  host;
  timers = [];
  background = /* @__PURE__ */ new Set();
  exec;
  launchOptions;
  closed = false;
  polling = false;
  /** 会审推进在跑时再来的请求只记一笔，跑完再补一轮，免得重复拉起汇总。 */
  councilSettling = null;
  councilAgain = false;
  /** 看板上把日志里的绝对路径缩成相对路径用的工作目录，按任务记一份。 */
  recovered = false;
  async cleanupCancelled(id3) {
    try {
      await this.cleanup.cleanup(id3);
    } catch (error) {
      console.error(`t${id3} \u5DE5\u4F5C\u6811\u6E05\u7406\u5931\u8D25\uFF1A`, error);
    }
  }
  clearQuota(provider2) {
    return this.quota.clear(this.x, provider2);
  }
  /** 启动看门狗（顺带解除到期的额度标记）与 CI 轮询，并在后台自愈上次遗留的运行中任务（不阻塞启动）。 */
  start() {
    const every = (ms, fn) => {
      const timer = setInterval(() => {
        const job = fn().catch((error) => console.error("\u4EFB\u52A1\u8FD0\u884C\u65F6\uFF1A", error)).finally(() => this.background.delete(job));
        this.background.add(job);
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.options.tickMs ?? 5e3, async () => {
      await this.x.tick();
      if (!this.closed)
        await this.host.refresh(
          [...this.x.active.values()].filter((active) => !active.child && !active.exited).map((active) => active.pid)
        );
      if (!this.closed) await this.cleanup.finished();
      if (!this.closed) await this.disk.refresh();
      if (!this.closed) await this.quota.releaseExpired(this.x);
      if (!this.closed && this.recovered) await this.scheduler.tick();
      if (!this.closed && this.recovered) await this.x.drain();
      if (!this.closed && this.recovered) await this.settleReviews();
      if (!this.closed && this.recovered) await this.settleCouncils();
      if (!this.closed && this.recovered) this.review.kick();
      if (!this.closed && this.recovered) this.merge.kick();
    });
    every(this.options.ciPollMs ?? CI_POLL_MS, () => this.pollCi());
    every(this.options.online?.pollMs ?? 6e4, async () => {
      if (!this.closed && this.recovered) this.online.kick();
    });
    const recovery = this.recover().then(async () => {
      this.recovered = true;
      if (!this.closed) await this.scheduler.tick();
      if (!this.closed) this.review.kick();
      if (!this.closed) this.merge.kick();
      if (!this.closed) this.online.kick();
    }).catch((error) => console.error("\u4EFB\u52A1\u8FD0\u884C\u65F6\u81EA\u6108\u5931\u8D25\uFF1A", error)).finally(() => this.background.delete(recovery));
    this.background.add(recovery);
  }
  /** 执行者进程不随服务退出：它们在独立进程组里，重启后按 pid 接管。 */
  async close() {
    this.closed = true;
    this.inbox.close();
    this.waits.close();
    const mergeClosing = this.merge.close();
    this.review.close();
    this.online.close();
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.background]);
    for (const active of this.x.active.values()) void active.live?.finish();
    await mergeClosing;
  }
  /** Count the ledger and in-flight launches, including work recovered after a service crash. */
  runningTaskRefs() {
    const query2 = this.db.prepare(
      "SELECT id FROM tasks WHERE status='running' AND id>? ORDER BY id LIMIT 200"
    );
    const rows = [];
    let after = 0;
    for (; ; ) {
      const page = query2.all(after);
      rows.push(...page);
      if (page.length < 200) break;
      after = page.at(-1).id;
    }
    return [
      .../* @__PURE__ */ new Set([...rows.map(({ id: id3 }) => id3), ...this.x.launching.keys()])
    ].sort((a, b) => a - b).map((id3) => `t${id3}`);
  }
  // ---- 派活 ----
  /** 派活候选一览（只读）：候选执行者、额度、专员与交付记录，推荐与理由；与 run 自动挑人同一份排序。 */
  async pick(reference, risk) {
    const task = getTask(this.db, parseTaskRef(reference));
    if (risk !== void 0 && risk !== "" && !isRisk(risk))
      throw new Problem(400, "risk: \u53EA\u80FD\u662F low\u3001medium\u3001high", "usage");
    const pace = await (this.launchOptions.pace ?? readPace)().catch(
      () => void 0
    );
    const view7 = await pickFor(task, isRisk(risk) ? risk : "low", {
      db: this.db,
      launchOptions: this.launchOptions,
      pace,
      held: this.quota.held(),
      busy: this.x.busyTools(task.id)
    });
    return {
      task: task.ref,
      ...view7,
      specialists: pickSpecialists(this.db, task)
    };
  }
  async run(reference, body3) {
    const request2 = runRequest(body3);
    const id3 = parseTaskRef(reference);
    if (request2.urgent && queued(this.db, id3)) {
      this.markUrgent(id3);
      await this.urgentQueued(id3);
      return { task: getTask(this.db, id3), queued: !!queued(this.db, id3) };
    }
    let task = getTask(this.db, id3);
    const council = councilRow(this.db, id3);
    if (council && council.stage !== "summarizing")
      throw new Problem(
        409,
        council.stage === "opinions" ? `${task.ref} \u662F\u4F1A\u5BA1\u8BAE\u9898\uFF0C\u8FD8\u5728\u7B49\u4E13\u5458\u610F\u89C1\uFF1B\u610F\u89C1\u6536\u9F50\u540E\u81EA\u52A8\u4EA4 leader \u6C47\u603B` : `${task.ref} \u4F1A\u5BA1${STAGE_LABEL[council.stage]}\uFF1B\u8981\u91CD\u8BAE\u53E6\u53D1\u8D77\u4F1A\u5BA1`,
        "conflict",
        void 0,
        `atrium review show ${task.ref}`
      );
    const schedule = planItem(this.db, requireRow(this.db, id3));
    if (schedule.group === "waiting" || schedule.group === "blocked" && task.schedule_state === "blocked")
      throw new Problem(
        409,
        `${task.ref} \u4F9D\u8D56\u672A\u5C31\u7EEA\uFF1A${schedule.reason ?? schedule.waiting_for.join("\u3001")}`,
        "conflict",
        void 0,
        "atrium task plan"
      );
    const admission = admit({
      status: task.status,
      running: this.x.active.has(id3) || this.x.launching.has(id3),
      queued: !!queued(this.db, id3)
    });
    if (!admission.ok)
      throw new Problem(
        409,
        `${task.ref}\uFF1A${admission.reason}`,
        "conflict",
        void 0,
        `atrium task show ${task.ref}`
      );
    if (request2.urgent && task.urgent !== 1) task = this.markUrgent(id3);
    this.x.launching.set(id3, null);
    let chosen;
    let pick;
    try {
      await this.disk.check(task.node_id, task.repo);
      const pace = await (this.launchOptions.pace ?? readPace)().catch(
        () => void 0
      );
      if (!pace)
        noteTask(this.db, id3, "budget_unknown", {
          reason: "\u989D\u5EA6\u6570\u636E\u4E0D\u53EF\u7528\uFF0C\u4EFD\u989D\u4E0D\u62E6\u622A"
        });
      const chain = taskAvoidChain(this.db, task);
      const avoid = {
        busy: this.x.busyTools(id3),
        chain,
        jobRef: task.job_ref ?? void 0
      };
      const options = { ...this.launchOptions, pace: async () => pace };
      const held = this.quota.held();
      const view7 = await pickFor(task, request2.risk ?? "low", {
        db: this.db,
        launchOptions: this.launchOptions,
        pace,
        held,
        busy: avoid.busy
      });
      chosen = await chooseWorker(
        !request2.worker && view7.recommended ? { ...request2, worker: view7.recommended } : request2,
        options,
        held,
        avoid
      );
      pick = request2.worker ? {
        worker: chosen.worker.id,
        auto: false,
        reason: null,
        notice: writtenNotice(
          view7,
          { worker: chosen.worker.id, tool: chosen.worker.tool },
          task.ref
        )
      } : {
        worker: chosen.worker.id,
        auto: true,
        reason: view7.reason,
        notice: null
      };
    } catch (error) {
      this.x.launching.delete(id3);
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    }
    const tool = chosen.worker.tool;
    if (chosen.waitUntil !== void 0) {
      this.x.launching.delete(id3);
      return {
        ...this.enqueue(
          task,
          chosen,
          `${ADAPTERS[tool].quotaProvider} \u989D\u5EA6\u7528\u5C3D\uFF0C\u7B49\u5230 ${clock(chosen.waitUntil)} \u6062\u590D\u540E\u81EA\u52A8\u62C9\u8D77`
        ),
        pick
      };
    }
    if (placement(ADAPTERS[tool].exclusive, this.x.busy(tool, id3)) === "queue") {
      this.x.launching.delete(id3);
      return {
        ...this.enqueue(
          task,
          chosen,
          `${tool} \u540C\u4E00\u65F6\u523B\u53EA\u8DD1\u4E00\u4E2A\uFF0C\u524D\u4E00\u4E2A\u7ED3\u675F\u540E\u81EA\u52A8\u62C9\u8D77`
        ),
        pick
      };
    }
    const gate = this.host.gate(this.x.inFlight(id3), task.urgent === 1);
    if (!gate.ok) {
      this.x.launching.delete(id3);
      return this.enqueue(task, chosen, gate.reason);
    }
    this.x.launching.set(id3, tool);
    try {
      return { task: await this.x.launch(id3, chosen), queued: false, pick };
    } catch (error) {
      if (error instanceof BudgetProblem)
        return this.blockBudget(task, error.message);
      throw error;
    } finally {
      this.x.launching.delete(id3);
    }
  }
  /** 排队中的任务刚标上紧急：立刻按紧急再排一轮，不等下次巡检。 */
  async urgentQueued(id3) {
    if (!this.closed && this.recovered && queued(this.db, id3))
      await this.x.drain();
  }
  markUrgent(id3) {
    const task = updateTask(this.db, id3, { urgent: true });
    this.waits.changed(id3);
    return getTask(this.db, task.id);
  }
  blockBudget(task, reason) {
    noteTask(this.db, task.id, "budget_blocked", { reason });
    this.x.advance(
      task.id,
      task.status === "todo" ? { kind: "block" } : { kind: "manual_set", to: "blocked" },
      {},
      { reason }
    );
    this.x.publish(task.id, "blocked", {
      reason,
      source: "budget",
      next: "\u7B49\u7A97\u53E3\u91CD\u7F6E\u6216\u8BF7\u4E0A\u5C42\u8C03\u6574\u4EFD\u989D"
    });
    this.waits.changed(task.id);
    return { task: getTask(this.db, task.id), queued: false };
  }
  enqueue(task, chosen, reason) {
    enqueue(this.db, {
      task_id: task.id,
      tool: chosen.worker.tool,
      worker: chosen.worker.id,
      risk: chosen.risk,
      queued_at: Date.now()
    });
    if (task.status !== "todo")
      this.x.advance(
        task.id,
        { kind: "manual_set", to: "todo" },
        {},
        "\u6392\u961F\u91CD\u6D3E"
      );
    noteTask(this.db, task.id, "queued", {
      worker: chosen.worker.id,
      reason
    });
    this.waits.changed(task.id);
    return { task: getTask(this.db, task.id), queued: true };
  }
  /** 服务重启自愈：进程已不在的置 failed；还在的按 pid 接管；再把排队的拉起来。 */
  recover() {
    return recoverRunning(this.x, this.db, {
      data: this.options.data,
      exec: this.exec,
      changed: (id3) => this.waits.changed(id3)
    });
  }
  async pollCi() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      for (const outcome of await pollCiOnce(
        this.db,
        this.options.ciBatch ?? CI_BATCH,
        this.exec
      )) {
        this.x.publish(outcome.task.id, `ci_${outcome.ci ?? "none"}`, {
          source: "ci",
          ...outcome.detail ? { reason: outcome.detail } : {},
          ...outcome.accepted ? { accepted: true } : {}
        });
        if (outcome.accepted && outcome.task.deliver === "pr")
          await this.review.admit(outcome.task.id);
        this.waits.changed(outcome.task.id);
      }
    } finally {
      this.polling = false;
    }
  }
  /** 审阅者：自动挑人，跳过原执行者的工具、同模型与 trust 不足 medium 的，直到挑到或无人可挑。 */
  async pickReviewer(original) {
    const exclude = new Set(original ? [original.tool] : []);
    const refusals = [];
    while (exclude.size <= TOOLS.length) {
      let choice;
      try {
        choice = await chooseWorker(
          { risk: "low" },
          this.launchOptions,
          this.quota.held(),
          { exclude }
        );
      } catch (error) {
        refusals.push(
          refusals.length ? "\u5176\u4F59\u6267\u884C\u8005\u90FD\u4E0D\u53EF\u7528" : error instanceof Error ? error.message : String(error)
        );
        break;
      }
      const refusal = reviewerRefusal(
        { tool: original?.tool ?? "", model: original?.cliModel },
        {
          tool: choice.worker.tool,
          model: choice.worker.cliModel,
          trust: choice.worker.profile.rules.trust
        }
      );
      if (!refusal) return choice.worker.id;
      refusals.push(refusal);
      exclude.add(choice.worker.tool);
    }
    throw new Error(refusals.join("\uFF1B"));
  }
  // ---- 停止、日志、等待 ----
  requeueMerge(reference) {
    return { task: this.merge.requeue(parseTaskRef(reference)) };
  }
  /** by：发起停止的订阅者，由此产生的事件不投给他本人。 */
  stop(reference, by) {
    const id3 = parseTaskRef(reference);
    const task = getTask(this.db, id3);
    const mergeStop = this.review.stop(id3, by) ?? this.merge.stop(id3, by);
    if (mergeStop)
      return { task: getTask(this.db, id3), stopping: mergeStop.stopping };
    if (dequeue(this.db, id3)) {
      noteTask(this.db, id3, "unqueued", { reason: "\u4EBA\u5DE5\u505C\u6B62\uFF0C\u79FB\u51FA\u961F\u5217" });
      this.waits.changed(id3);
      return { task: getTask(this.db, id3), stopping: false };
    }
    const active = this.x.active.get(id3);
    if (active && !active.exited) {
      active.stop = { kind: "user", ...by ? { by } : {} };
      noteTask(this.db, id3, "stop_requested", {
        pid: active.pid,
        ...by ? { by } : {}
      });
      this.x.kill(active);
      return { task: getTask(this.db, id3), stopping: true };
    }
    if (this.x.launching.has(id3))
      throw new Problem(409, `${task.ref} \u6B63\u5728\u542F\u52A8\uFF0C\u7A0D\u540E\u518D\u505C`, "conflict");
    if (task.status !== "running")
      throw new Problem(
        409,
        `${task.ref} \u4E0D\u5728\u8FD0\u884C\uFF08\u5F53\u524D ${task.status}\uFF09`,
        "conflict",
        void 0,
        `atrium task show ${task.ref}`
      );
    if (task.pid) signalGroup(task.pid, "SIGTERM");
    const stopped = this.x.advance(
      id3,
      { kind: "exit_fail" },
      {},
      { reason: "\u4EBA\u5DE5\u505C\u6B62\uFF08\u670D\u52A1\u672A\u638C\u63E1\u8BE5\u8FDB\u7A0B\uFF09" }
    );
    this.x.publish(id3, "failed", { reason: "\u4EBA\u5DE5\u505C\u6B62" }, by);
    this.waits.changed(id3);
    return { task: stopped, stopping: false };
  }
  /** 给在跑的执行者捎话（#307）；不在跑的留到下次拉起时写进提示词。 */
  tell(reference, body3, actor) {
    const result = tellTask(this.x, this.db, reference, body3, actor);
    this.waits.changed(result.task.id);
    return result;
  }
  /** 专员关卡补判（#322）：审查任务不再跑后记结论，父任务全部出结论时补判通过或留在受阻并投递。 */
  async settleReviews() {
    if (this.closed) return;
    const busy = (id3) => this.x.active.has(id3) || this.x.launching.has(id3) || this.x.finishing.has(id3) || !!queued(this.db, id3);
    for (const resolution of settleReviews(this.db, busy)) {
      const { parent, outcome, concerns } = resolution;
      const admitted = resolution.accepted && await this.review.admit(parent);
      const kind = admitted ? admitted.kind : resolution.accepted ? "done" : "blocked";
      this.x.publish(parent, kind, {
        ...admitted ? admitted.detail : {},
        reason: admitted && admitted.detail?.reason || outcome.reason,
        concerns,
        ...outcome.kind === "vetoed" ? { vetoed: true } : {},
        ...resolution.accepted ? {} : { next: `atrium task show ${taskRef(parent)}` }
      });
      this.waits.changed(parent);
    }
  }
  // ---- 会审（#322 第 3 步） ----
  /** 发起会审：建议题与各专员的意见任务，并行拉起；拉不起的标受阻，汇总时算没出意见。 */
  async addCouncil(body3) {
    const { council, opinions } = createCouncil(
      this.db,
      this.options.data,
      body3
    );
    await Promise.all(opinions.map((ref2) => this.dispatchCouncil(ref2)));
    await this.settleCouncils();
    return councilView(this.db, council.ref);
  }
  council(reference) {
    return councilView(this.db, reference);
  }
  /** 用户对上交的会审拍板。 */
  decideCouncil(reference, body3, actor) {
    const view7 = decideCouncil(this.db, reference, body3, actor);
    this.x.publish(
      Number(view7.ref.slice(1)),
      "council_decided",
      {
        conclusion: view7.conclusion,
        by: actor,
        next: `atrium review show ${view7.ref}`
      },
      actor
    );
    this.waits.changed(Number(view7.ref.slice(1)));
    return view7;
  }
  /** 拉起会审里的任务（专员意见或 leader 汇总）；拉不起的标受阻并写原因。 */
  async dispatchCouncil(ref2) {
    try {
      await this.run(ref2, {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const task = getTask(this.db, ref2);
      if (task.status === "todo")
        this.x.advance(
          task.id,
          { kind: "block" },
          {},
          { reason: `\u4F1A\u5BA1\u4EFB\u52A1\u62C9\u4E0D\u8D77\u6765\uFF1A${reason}` }
        );
      this.waits.changed(task.id);
    }
  }
  /** 推进会审：意见收齐交 leader 汇总；汇总完成记结论，已定或需用户拍板都投给负责人。 */
  settleCouncils() {
    if (this.closed) return Promise.resolve();
    if (this.councilSettling) {
      this.councilAgain = true;
      return this.councilSettling;
    }
    const run3 = async () => {
      do {
        this.councilAgain = false;
        const busy = (id3) => this.x.active.has(id3) || this.x.launching.has(id3) || this.x.finishing.has(id3) || !!queued(this.db, id3);
        const progress = settleCouncils(this.db, this.options.data, busy);
        for (const decision of progress.decided) {
          const { id: id3, outcome, opinions } = decision;
          const ref2 = taskRef(id3);
          this.x.publish(id3, `council_${outcome.kind}`, {
            conclusion: outcome.conclusion,
            opinions: opinions.map((o) => ({
              concern: o.ref,
              name: o.name,
              stance: o.stance
            })),
            ...outcome.escalate.length ? { escalate: outcome.escalate } : {},
            next: outcome.kind === "escalated" ? `\u9700\u7528\u6237\u62CD\u677F\uFF1Aatrium review show ${ref2}\uFF1B\u62CD\u677F\u540E atrium review decide ${ref2} \u7ED3\u8BBA` : `atrium review show ${ref2}`
          });
          this.waits.changed(id3);
        }
        for (const ref2 of progress.dispatch) {
          if (this.closed) return;
          await this.dispatchCouncil(ref2);
        }
      } while (this.councilAgain && !this.closed);
    };
    const settling = run3().finally(() => {
      if (this.councilSettling === settling) this.councilSettling = null;
    });
    this.councilSettling = settling;
    return settling;
  }
  /** 会审议题在专员出意见、leader 汇总到记下结论之前都算没结束。 */
  councilPending(id3, task) {
    const council = councilRow(this.db, id3);
    if (!council || task.status === "cancelled") return false;
    if (council.stage === "opinions") return true;
    return council.stage === "summarizing" && (task.status === "todo" || task.status === "running" || task.status === "done");
  }
  pending(id3, task) {
    return task.status === "running" || task.delivery_stage === "reviewing" || task.delivery_stage === "merge_queued" || task.delivery_stage === "merging" || this.merge.isReturning(id3) || task.status === "blocked" && awaitingReview(this.db, id3) || this.councilPending(id3, task) || !!queued(this.db, id3) || this.x.launching.has(id3) || this.x.finishing.has(id3);
  }
  async log(reference, after) {
    const id3 = parseTaskRef(reference);
    const task = getTask(this.db, id3);
    const offset = after === void 0 || after === "" ? 0 : Number(after);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Problem(400, "after: \u5E94\u4E3A\u975E\u8D1F\u6574\u6570\u5B57\u8282\u504F\u79FB", "usage");
    const chunk = await readLogChunk(
      join21(taskDir(this.options.data, id3), "log"),
      offset
    );
    return { ...chunk, running: this.pending(id3, task), status: task.status };
  }
  /**
   * 进行中任务的实时视图（#262 `atrium top`）：在跑、排队、受阻与刚结束的，
   * 每行带日志尾部解析出的最近一个动作与日志最后写入时刻。只读，日志最多读尾部固定字节数。
   * 解析不出动作时 action 为 null，但 log_at 照给，命令行据此说「日志 N 秒前有输出」。
   */
  async top(input = {}) {
    const now = input.now ?? Date.now();
    const who2 = input.as ? ownerOf(input.as, "as") : DEFAULT_OWNER;
    const { rows, truncated } = topRows(this.db, now);
    const logs = await Promise.all(
      rows.map((row3) => {
        const id3 = Number(row3.ref.slice(1));
        return readLogTail(join21(taskDir(this.options.data, id3), "log"));
      })
    );
    const leaders2 = hasOrg(this.db) ? listLeaders(this.db).leaders.map((l) => ({
      ref: l.ref,
      name: l.name,
      nodes: l.nodes.map((n) => n.ref),
      wake: l.wake,
      events: this.inbox.countPending(l.ref)
    })) : [];
    return {
      now,
      recent_ms: RECENT_MS,
      subscriber: who2,
      counts: {
        ...countRows(rows),
        events: this.inbox.countPending(who2)
      },
      ...leaders2.length ? { leaders: leaders2 } : {},
      host: this.hostView(),
      rows: rows.map((row3, index2) => {
        const action = recentAction({
          tool: toolOf(row3.worker),
          tail: logs[index2].text
        });
        return {
          ...row3,
          log_at: logs[index2].at,
          action: action ? { text: action.text, kind: action.kind } : null
        };
      }),
      truncated
    };
  }
  /** 本机负载与限额（#358）：`top` 抬头显示「本机太忙，排队中」用。 */
  hostView() {
    return hostView({
      limits: this.host.limits,
      load: this.host.load(),
      own: this.host.own(),
      running: this.x.inFlight(),
      checks: sharedLocalChecks.size
    });
  }
  settled(id3) {
    const task = getTask(this.db, id3);
    return this.pending(id3, task) ? null : task;
  }
  /** 任务离开 running（且不在排队、不在启动）或超时返回。 */
  wait(reference, seconds, signal) {
    const id3 = parseTaskRef(reference);
    const now = this.settled(id3);
    if (now || seconds <= 0 || this.closed)
      return Promise.resolve({
        task: now ?? getTask(this.db, id3),
        timed_out: !now
      });
    return this.waits.wait(id3, seconds, signal);
  }
};
var toolOf = (worker) => {
  const head2 = worker?.split(/[+:]/, 1)[0]?.trim();
  return isTool(head2) ? head2 : void 0;
};

// server/tasks/worker-profile-edit.ts
var KEY_RE = /^[A-Za-z_][\w-]*$/;
function summary(row3) {
  const parsed = parseProfileSource(row3.source);
  return {
    ref: `${row3.layer}/${row3.name}`,
    layer: row3.layer,
    name: row3.name,
    rev: row3.rev,
    trust: parsed.rules.trust ?? null,
    max_risk: parsed.rules.max_risk ?? null,
    model: parsed.rules.model ?? null,
    checks: parsed.rules.checks ?? null,
    updated_by: row3.updated_by,
    updated_at: row3.updated_at,
    warnings: parsed.warnings
  };
}
var listProfileViews = (db) => listProfiles(db).map(summary);
function profileView(db, ref2) {
  const { layer, name: name2 } = parseProfileRef(ref2);
  const row3 = readProfile(db, layer, name2);
  if (!row3)
    throw new Problem(
      404,
      `\u6863\u6848 ${layer}/${name2} \u4E0D\u5B58\u5728`,
      "not_found",
      void 0,
      "atrium workers ls"
    );
  const parsed = parseProfileSource(row3.source);
  return {
    ...summary(row3),
    rules: parsed.rules,
    body: parsed.body,
    notes: parsed.notes,
    source: row3.source,
    history: profileHistory(db, layer, name2).map(({ source: source2, ...rest }) => ({
      ...rest,
      bytes: Buffer.byteLength(source2, "utf8")
    }))
  };
}
function editProfile(db, ref2, body3, author2) {
  const { layer, name: name2 } = parseProfileRef(ref2);
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw new Problem(400, "\u8BF7\u6C42\u4F53\u5E94\u4E3A JSON \u5BF9\u8C61", "usage");
  const b = body3;
  const set = b.set && typeof b.set === "object" && !Array.isArray(b.set) ? Object.entries(b.set) : [];
  const unset = Array.isArray(b.unset) ? b.unset : [];
  const hasSource = typeof b.source === "string";
  if (hasSource === set.length + unset.length > 0)
    throw new Problem(
      400,
      "--file \u4E0E\u5B57\u6BB5\u53C2\u6570\uFF08--trust\u3001--max-risk\u3001--model\u3001--checks\u3001--set\u3001--unset\uFF09\u4E8C\u9009\u4E00\uFF0C\u4E14\u81F3\u5C11\u7ED9\u4E00\u4E2A",
      "usage"
    );
  const current2 = readProfile(db, layer, name2);
  let source2;
  if (hasSource) source2 = b.source;
  else {
    source2 = current2?.source ?? "";
    for (const [key, value] of set) {
      if (!KEY_RE.test(key))
        throw new Problem(400, `--set \u7684\u952E\u4E0D\u5408\u6CD5\uFF1A${key}`, "usage");
      if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
        throw new Problem(400, `--set ${key} \u7684\u503C\u987B\u662F\u4E00\u884C\u975E\u7A7A\u6587\u5B57`, "usage");
      source2 = patchFront(source2, key, value.trim());
    }
    for (const key of unset) {
      if (typeof key !== "string" || !KEY_RE.test(key))
        throw new Problem(400, `--unset \u7684\u952E\u4E0D\u5408\u6CD5\uFF1A${String(key)}`, "usage");
      source2 = patchFront(source2, key, void 0);
    }
  }
  const problems = [
    ...sourceProblems(source2),
    ...parseProfileSource(source2).warnings
  ];
  if (problems.length)
    throw new Problem(
      400,
      `\u6863\u6848 ${layer}/${name2} \u6CA1\u6539\uFF1A${problems.join("\uFF1B")}`,
      "usage"
    );
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 500) : hasSource ? "\u6574\u4EFD\u66FF\u6362" : `\u6539\u5B57\u6BB5 ${[...set.map(([k]) => k), ...unset].join("\u3001")}`;
  const result = writeProfile(db, { layer, name: name2, source: source2, author: author2, reason });
  return { ref: `${layer}/${name2}`, ...result };
}

// shared/user.ts
var LOCAL_USER = "u1";

// server/actor.ts
var LEADER = /^a[1-9][0-9]*$/;
function resolveActor(db, reference) {
  const value = (reference ?? "").trim() || LOCAL_USER;
  if (value === LOCAL_USER) return value;
  if (!LEADER.test(value))
    throw new Problem(400, "--as \u5E94\u4E3A u1 \u6216\u7EC4\u7EC7\u8282\u70B9 leader \u7684\u77ED\u53F7\uFF0C\u5982 a1");
  const found = db.prepare(
    "SELECT 1 FROM org_nodes WHERE leader=? AND archived_at IS NULL LIMIT 1"
  ).get(value);
  if (!found)
    throw new Problem(
      404,
      `${value} \u4E0D\u662F\u4EFB\u4F55\u7EC4\u7EC7\u8282\u70B9\u7684 leader`,
      "not_found",
      void 0,
      "atrium org tree"
    );
  return value;
}

// server/tasks/routes.ts
var params = (value) => value ?? {};
var query = (value) => value ?? {};
var actorOf = (q6) => q6.as === void 0 || q6.as === "" ? DEFAULT_OWNER : ownerOf(q6.as, "as");
function disconnect(request2) {
  const controller = new AbortController();
  request2.raw.once("close", () => controller.abort());
  return controller.signal;
}
function runnerEnvOptions(env = process.env) {
  const options = {};
  if (env.ATRIUM_WORKERS_DIR) options.workersDir = env.ATRIUM_WORKERS_DIR;
  const batch = Number(env.ATRIUM_EVENT_BATCH_SECONDS);
  if (Number.isFinite(batch) && batch > 0) options.batchMs = batch * 1e3;
  const lease2 = Number(env.ATRIUM_EVENT_LEASE_MINUTES);
  if (Number.isFinite(lease2) && lease2 > 0) options.leaseMs = lease2 * 6e4;
  const unknown = Number(env.ATRIUM_QUOTA_UNKNOWN_MINUTES);
  if (Number.isFinite(unknown) && unknown > 0)
    options.quotaUnknownMs = unknown * 6e4;
  if (env.NODE_TEST_CONTEXT && env.ATRIUM_TEST_DISK_FREE_GB) {
    const gb = Number(env.ATRIUM_TEST_DISK_FREE_GB);
    if (Number.isFinite(gb) && gb >= 0) options.diskFreeGb = async () => gb;
  }
  const online = Number(env.ATRIUM_ONLINE_POLL_SECONDS);
  if (Number.isFinite(online) && online > 0)
    options.online = { pollMs: online * 1e3 };
  return options;
}
function registerTaskRoutes(app2, db, runnerOptions) {
  ensureTaskTables(db);
  const runner = new TaskRunner(db, runnerOptions);
  runner.start();
  app2.post(
    "/api/quota/:provider/clear",
    (request2) => runner.clearQuota(
      (request2.params ?? {}).provider
    )
  );
  app2.addHook("preClose", async () => runner.close());
  app2.get(
    "/api/workers",
    (request2) => workersReport(db, query(request2.query).role)
  );
  app2.get(
    "/api/workers/:id",
    (request2) => workerReport(db, params(request2.params).id)
  );
  const profileRef = (request2) => {
    const p3 = request2.params ?? {};
    return `${p3.layer ?? ""}/${p3.name ?? ""}`;
  };
  app2.get("/api/workers/profiles", () => ({
    profiles: listProfileViews(db)
  }));
  app2.get(
    "/api/workers/profiles/:layer/:name",
    (request2) => profileView(db, profileRef(request2))
  );
  app2.put(
    "/api/workers/profiles/:layer/:name",
    { bodyLimit: 256 * 1024 },
    (request2) => editProfile(
      db,
      profileRef(request2),
      request2.body,
      resolveActor(db, query(request2.query).as)
    )
  );
  app2.post(
    "/api/workers/advice/confirm",
    { bodyLimit: 4096 },
    (request2) => confirmWorkerAdvice(db, request2.body)
  );
  for (const path of ["/api/specialists", "/api/roles"]) {
    app2.get(path, (request2) => {
      const part = query(request2.query).part;
      return part ? specialistsForPart(db, part) : listJobRoles(db);
    });
    app2.post(
      path,
      { bodyLimit: 32 * 1024 },
      (request2, reply) => reply.code(201).send(createJobRole(db, request2.body))
    );
    app2.get(`${path}/:id`, async (request2) => {
      const role = getJobRole(db, params(request2.params).id);
      const tasks = db.prepare(
        "SELECT id,title,status,worker,created_at,started_at,ended_at,delivery_stage FROM tasks WHERE job_id=? ORDER BY id DESC LIMIT 200"
      ).all(role.id).map((task) => ({ ...task, ref: `t${task.id}` }));
      const workers = await workersReport(db, role.ref);
      const skillDetails = role.skills.map(
        (slug) => db.prepare(
          "SELECT id,slug,name,description,rev FROM org_skills WHERE slug=? AND archived_at IS NULL"
        ).get(slug)
      ).filter(Boolean);
      return {
        ...role,
        tasks,
        skill_details: skillDetails,
        workers: workers.stats,
        suggestions: workers.suggestions
      };
    });
    app2.patch(
      `${path}/:id`,
      { bodyLimit: 32 * 1024 },
      (request2) => editJobRole(db, params(request2.params).id, request2.body)
    );
    app2.get(
      `${path}/:id/history`,
      (request2) => jobRoleHistory(db, params(request2.params).id)
    );
  }
  app2.post("/api/tasks", { bodyLimit: 256 * 1024 }, async (request2, reply) => {
    const task = createTask(db, request2.body, Date.now(), leaderOf(request2));
    publishInvolved(runner.inbox, db, task.id, [], leaderOf(request2));
    return reply.code(201).send(task);
  });
  app2.get("/api/tasks", (request2) => {
    const { parent, status, after, limit } = query(request2.query);
    return listTasks(db, { parent, status, after, limit });
  });
  app2.get(
    "/api/tasks/tree",
    (request2) => taskTree(db, query(request2.query).root)
  );
  app2.get(
    "/api/tasks/top",
    (request2) => runner.top({ as: query(request2.query).as })
  );
  app2.get("/api/tasks/plan", (request2) => {
    const q6 = query(request2.query);
    return taskPlan(
      db,
      q6.after ? parseTaskRef(q6.after, "after") : 0,
      q6.limit ? Number(q6.limit) : 200
    );
  });
  app2.get(
    "/api/tasks/:id",
    (request2) => getTask(db, params(request2.params).id)
  );
  app2.patch("/api/tasks/:id", { bodyLimit: 256 * 1024 }, async (request2) => {
    const id3 = parseTaskRef(params(request2.params).id);
    const exists = db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id3);
    const before = exists ? involvedOf(db, getTask(db, id3)) : void 0;
    const task = updateTask(db, params(request2.params).id, request2.body);
    if (task.status === "cancelled") await runner.cleanupCancelled(task.id);
    if (task.urgent === 1) await runner.urgentQueued(task.id);
    if (task.status !== "cancelled" && before)
      publishInvolved(
        runner.inbox,
        db,
        task.id,
        [...before.also, ...before.auto],
        leaderOf(request2)
      );
    return getTask(db, task.id);
  });
  app2.post(
    "/api/tasks/:id/note",
    { bodyLimit: 4 * 1024 },
    (request2) => addTaskNote(
      db,
      params(request2.params).id,
      request2.body,
      Date.now(),
      leaderOf(request2) ?? "u1"
    )
  );
  app2.post(
    "/api/tasks/:id/tell",
    { bodyLimit: 32 * 1024 },
    (request2) => runner.tell(
      params(request2.params).id,
      request2.body,
      leaderOf(request2) ?? "u1"
    )
  );
  app2.get(
    "/api/tasks/:id/pick",
    (request2) => runner.pick(params(request2.params).id, query(request2.query).risk)
  );
  app2.post(
    "/api/tasks/:id/run",
    { bodyLimit: 16 * 1024 },
    (request2) => runner.run(params(request2.params).id, request2.body)
  );
  app2.post(
    "/api/tasks/:id/stop",
    (request2) => runner.stop(params(request2.params).id, actorOf(query(request2.query)))
  );
  app2.post(
    "/api/tasks/:id/merge",
    (request2) => runner.requeueMerge(params(request2.params).id)
  );
  app2.get(
    "/api/tasks/:id/log",
    (request2) => runner.log(params(request2.params).id, query(request2.query).after)
  );
  app2.get(
    "/api/tasks/:id/wait",
    (request2) => runner.wait(
      params(request2.params).id,
      waitSeconds(query(request2.query).timeout),
      disconnect(request2)
    )
  );
  app2.post(
    "/api/reviews",
    { bodyLimit: 256 * 1024 },
    async (request2, reply) => reply.code(201).send(await runner.addCouncil(request2.body))
  );
  app2.get(
    "/api/reviews/:id",
    (request2) => runner.council(params(request2.params).id)
  );
  app2.post("/api/reviews/:id/decide", { bodyLimit: 16 * 1024 }, (request2) => {
    const q6 = query(request2.query);
    const actor = q6.as === void 0 || q6.as === "" ? "u1" : ownerOf(q6.as, "as");
    return runner.decideCouncil(params(request2.params).id, request2.body, actor);
  });
  app2.get("/api/events/wait", (request2) => {
    const q6 = query(request2.query);
    return runner.inbox.wait(
      actorOf(q6),
      waitSeconds(q6.timeout),
      disconnect(request2),
      {
        peek: q6.peek === "1" || q6.peek === "true",
        all: q6.all === "1",
        settleSeconds: settleSeconds(q6.settle)
      }
    );
  });
  app2.get("/api/events/digest", (request2) => {
    const q6 = query(request2.query);
    return runner.inbox.digest(actorOf(q6), sinceTime(q6.since));
  });
  app2.post("/api/events/deliver", { bodyLimit: 64 * 1024 }, (request2) => ({
    events: runner.inbox.deliver(
      actorOf(query(request2.query)),
      ackIds(request2.body)
    )
  }));
  app2.get("/api/events", (request2) => {
    const q6 = query(request2.query);
    return runner.inbox.list(actorOf(q6), listOptions(q6));
  });
  app2.post(
    "/api/events/ack",
    { bodyLimit: 64 * 1024 },
    (request2) => runner.inbox.ack(ackIds(request2.body))
  );
  return runner;
}

// server/tasks/patrol-routes.ts
function registerPatrolRoutes(app2, db, runner) {
  app2.post(
    "/api/patrol/nodes/:id/run",
    { bodyLimit: 1024 },
    async (request2, reply) => {
      const address = request2.params.id;
      const body3 = request2.body ?? {};
      if (Object.keys(body3).some((key) => key !== "worker") || body3.worker !== void 0 && typeof body3.worker !== "string")
        throw new Problem(400, "worker: \u5E94\u4E3A\u6267\u884C\u8005\u7EC4\u5408", "usage");
      const started = startPatrol(db, address);
      const launched2 = await runner.run(started.task.ref, {
        worker: body3.worker
      });
      return reply.code(201).send({ ...started, ...launched2 });
    }
  );
  app2.post(
    "/api/patrol/tasks/:id/findings",
    { bodyLimit: 8 * 1024 },
    (request2, reply) => reply.code(201).send(
      reportFinding(
        db,
        request2.params.id,
        request2.body
      )
    )
  );
  app2.get(
    "/api/patrol/nodes/:id/findings",
    (request2) => findingsForNode(
      db,
      nodeByAddress(db, request2.params.id).id
    )
  );
  app2.post(
    "/api/patrol/findings/:id/decide",
    { bodyLimit: 4 * 1024 },
    (request2) => decideFinding(db, request2.params.id, request2.body)
  );
}

// server/org/schema.ts
function ensureOrgTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES org_nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('org','project','module','concern')),
    slug TEXT NOT NULL, name TEXT NOT NULL, leader TEXT, doc_path TEXT,
    archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(parent_id,slug));
  CREATE UNIQUE INDEX IF NOT EXISTS org_single_root ON org_nodes((1)) WHERE parent_id IS NULL;
  CREATE TABLE IF NOT EXISTS org_node_repos (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id), repo TEXT NOT NULL,
    PRIMARY KEY(node_id,repo));
  CREATE TABLE IF NOT EXISTS org_docs (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    doc TEXT NOT NULL CHECK(doc IN ('charter','card')),
    rev INTEGER NOT NULL, fields TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(node_id,doc));
  CREATE TABLE IF NOT EXISTS org_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    target TEXT NOT NULL CHECK(target IN ('node','charter','card')),
    rev INTEGER NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL,
    reason TEXT NOT NULL, snapshot TEXT NOT NULL,
    UNIQUE(node_id,target,rev));
  CREATE INDEX IF NOT EXISTS org_revisions_node ON org_revisions(node_id,id);
  CREATE TABLE IF NOT EXISTS org_boundaries (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    bid TEXT NOT NULL, pos INTEGER NOT NULL,
    summary TEXT NOT NULL, detail TEXT,
    param_key TEXT CHECK(param_key IN ('quota_reserve_percent','disk_min_free_gb','money_yuan_max')),
    param_value REAL,
    CHECK((param_key IS NULL) = (param_value IS NULL)),
    PRIMARY KEY(node_id,bid));
  CREATE TABLE IF NOT EXISTS org_budgets (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    dim TEXT NOT NULL CHECK(dim IN ('quota','disk','money')),
    scope TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL CHECK(amount >= 0),
    PRIMARY KEY(node_id,dim,scope));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS org_revisions_no_update
    BEFORE UPDATE ON org_revisions BEGIN SELECT RAISE(ABORT,'org_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_revisions_no_delete
    BEFORE DELETE ON org_revisions BEGIN SELECT RAISE(ABORT,'org_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_nodes_no_delete
    BEFORE DELETE ON org_nodes BEGIN SELECT RAISE(ABORT,'org_nodes archive only'); END;`);
  ensurePointTables(db);
  ensureAspectColumns(db);
}

// server/org/goal-chain.ts
var LABELED = /^\s*(?:[-*]\s*)?([^：:\n]{1,40})[：:]\s*(.*)$/;
function goalChain(levels) {
  const goals = levels.map((level) => level.goal.trim());
  return levels.map((level, i) => {
    const next = levels[i + 1];
    const below = new Set(goals.slice(i + 1).filter(Boolean));
    const lines2 = goals[i].split("\n").filter((line) => {
      const text6 = line.trim();
      if (!text6 || below.has(text6)) return false;
      const label5 = LABELED.exec(text6);
      if (!next || !label5 || !level.children.includes(label5[1].trim()))
        return true;
      return label5[1].trim() === next.name && !goals[i + 1] && !!label5[2];
    });
    return { ref: level.ref, name: level.name, goal: lines2.join("\n") };
  }).filter((link) => link.goal !== "");
}

// server/org/task-link.ts
var OPEN = [
  "todo",
  "running",
  "blocked",
  "reviewing",
  "merge_queued",
  "merging"
];
var empty2 = () => ({ todo: 0, running: 0, blocked: 0 });
function hasTaskNodes(db) {
  return all2(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "node_id"
  );
}
function taskCounts(db) {
  const own = /* @__PURE__ */ new Map(), sent = /* @__PURE__ */ new Map();
  if (!hasTaskNodes(db)) return { own, sent };
  for (const [column, map] of [
    ["node_id", own],
    ["origin_node_id", sent]
  ])
    for (const row3 of all2(
      db,
      `SELECT ${column} AS id,
         CASE WHEN delivery_stage IN ('reviewing','merge_queued','merging') THEN delivery_stage ELSE status END AS status,
         COUNT(*) AS n FROM tasks WHERE ${column} IS NOT NULL
         AND (status IN ('todo','running','blocked') OR delivery_stage IN ('reviewing','merge_queued','merging'))
         GROUP BY ${column},CASE WHEN delivery_stage IN ('reviewing','merge_queued','merging') THEN delivery_stage ELSE status END LIMIT 2500`
    )) {
      const counts = map.get(row3.id) ?? empty2();
      if (OPEN.includes(row3.status))
        counts[row3.status] = row3.n;
      map.set(row3.id, counts);
    }
  return { own, sent };
}
function nodeTasks(db, id3, limit = 5) {
  if (!hasTaskNodes(db)) return [];
  return all2(
    db,
    "SELECT id,title,status,delivery_stage,worker,origin_node_id FROM tasks WHERE node_id=? ORDER BY status IN ('todo','running','blocked') OR delivery_stage IN ('reviewing','merge_queued','merging') DESC,id DESC LIMIT ?",
    id3,
    limit
  ).map((t) => ({
    ref: `t${t.id}`,
    title: t.title,
    status: t.status,
    delivery_stage: t.delivery_stage,
    worker: t.worker,
    origin_ref: t.origin_node_id === null ? null : ref(t.origin_node_id)
  }));
}
var LINK_MAX = 5e3;
function linkRoles(db, apply, now = Date.now()) {
  const plan2 = () => {
    const rows = all2(
      db,
      "SELECT id,title,role,repo FROM tasks WHERE node_id IS NULL AND role IS NOT NULL AND role<>'' ORDER BY id LIMIT ?",
      LINK_MAX + 1
    );
    const list4 = nodes(db);
    const matchOf = roleMatcher(db);
    const groups = /* @__PURE__ */ new Map();
    const unmatched = [];
    const matches = [];
    for (const task of rows.slice(0, LINK_MAX)) {
      const match = matchOf(task.role, task.repo);
      if (!match.node) {
        unmatched.push({
          task: `t${task.id}`,
          title: task.title,
          role: task.role,
          reason: task.repo ? match.reason : `${match.reason}\uFF08\u4EFB\u52A1\u6CA1\u6709\u4ED3\u5E93\uFF09`
        });
        continue;
      }
      const group = groups.get(match.node.id) ?? {
        node: ref(match.node.id),
        path: nodePath(list4, match.node),
        roles: [],
        tasks: []
      };
      if (!group.roles.includes(task.role)) group.roles.push(task.role);
      group.tasks.push(`t${task.id}`);
      groups.set(match.node.id, group);
      matches.push([task.id, match.node.id]);
    }
    return {
      groups: [...groups.values()],
      unmatched,
      matches,
      truncated: rows.length > LINK_MAX
    };
  };
  if (!hasTaskNodes(db) || !one2(db, "SELECT 1 FROM org_nodes LIMIT 1"))
    return {
      preview: !apply,
      linked: 0,
      groups: [],
      unmatched: [],
      truncated: false
    };
  if (!apply) {
    const { matches, ...rest } = plan2();
    return { preview: true, linked: matches.length, ...rest };
  }
  return transaction(db, () => {
    const { matches, ...rest } = plan2();
    const update2 = db.prepare(
      "UPDATE tasks SET node_id=?,updated_at=? WHERE id=? AND node_id IS NULL"
    );
    const event = db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,'org_link',?)"
    );
    for (const [task, node] of matches) {
      update2.run(node, now, task);
      event.run(task, now, JSON.stringify({ node: ref(node) }));
    }
    return { preview: false, linked: matches.length, ...rest };
  });
}

// server/org/read.ts
function budgetViews(db, pace) {
  const list4 = nodes(db);
  const owned = allShares(db);
  const tree2 = list4.map((n) => ({
    id: n.id,
    parent: n.parent_id,
    name: n.name,
    shares: owned.get(n.id) ?? []
  }));
  const limits = rootLimits(db, list4);
  const scopes = /* @__PURE__ */ new Set(["claude", "codex", "opencode", "kimi", "grok"]);
  const allocated = /* @__PURE__ */ new Set();
  for (const shares of owned.values())
    for (const s of shares)
      if (s.dim === "quota") {
        allocated.add(s.scope);
        if (s.scope !== "*") scopes.add(s.scope);
      }
  const subtree2 = (id3) => {
    const ids = [id3];
    for (let i = 0; i < ids.length; i++)
      for (const child of list4.filter((n) => n.parent_id === ids[i]))
        ids.push(child.id);
    return ids;
  };
  const now = Date.now();
  return new Map(
    list4.map((n) => [
      n.id,
      {
        own: exportShares(owned.get(n.id) ?? []),
        quota: [...scopes].sort().map((scope) => ({
          scope,
          amount: shareCapacity(tree2, n.id, "quota", scope, limits),
          used: scope === "*" ? null : (() => {
            const sample = usageSample(pace, scope, now);
            return sample ? Number(
              subtreeUsage(
                db,
                subtree2(n.id),
                scope,
                sample.reset
              ).toFixed(2)
            ) : null;
          })(),
          relevant: allocated.has(scope) || allocated.has("*"),
          shared: !(owned.get(n.id) ?? []).some(
            (s) => s.dim === "quota" && (s.scope === scope || s.scope === "*")
          )
        })),
        disk: {
          amount: shareCapacity(tree2, n.id, "disk", "", limits),
          shared: !(owned.get(n.id) ?? []).some((s) => s.dim === "disk")
        },
        money: {
          amount: shareCapacity(tree2, n.id, "money", "", limits),
          shared: !(owned.get(n.id) ?? []).some((s) => s.dim === "money")
        }
      }
    ])
  );
}
function tree(db, pace) {
  const list4 = nodes(db).filter((node) => node.kind !== "concern");
  if (list4.length > 500) throw new Problem(409, "\u7EC4\u7EC7\u6811\u8D85\u8FC7 500 \u4E2A\u8282\u70B9");
  const order = [];
  const visit = (parent) => {
    for (const n of list4.filter((item) => item.parent_id === parent)) {
      order.push(n);
      visit(n.id);
    }
  };
  visit(null);
  const counts = taskCounts(db);
  const budgets = budgetViews(db, pace);
  const leaders2 = leaderBriefs(db);
  const subtree2 = /* @__PURE__ */ new Map();
  for (const n of [...order].reverse()) {
    const sum = {
      ...counts.own.get(n.id) ?? { todo: 0, running: 0, blocked: 0 }
    };
    for (const child of list4.filter((item) => item.parent_id === n.id)) {
      const c = subtree2.get(child.id);
      sum.todo += c.todo;
      sum.running += c.running;
      sum.blocked += c.blocked;
      if (c.reviewing) sum.reviewing = (sum.reviewing ?? 0) + c.reviewing;
      if (c.merge_queued)
        sum.merge_queued = (sum.merge_queued ?? 0) + c.merge_queued;
      if (c.merging) sum.merging = (sum.merging ?? 0) + c.merging;
    }
    subtree2.set(n.id, sum);
  }
  return order.map((original) => {
    const { doc_path: _legacyDocPath, ...n } = original;
    return {
      ...n,
      ref: ref(n.id),
      path: nodePath(list4, original),
      repos: all2(
        db,
        "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo",
        n.id
      ).map((r) => r.repo),
      tasks: subtree2.get(n.id),
      sent: counts.sent.get(n.id) ?? { todo: 0, running: 0, blocked: 0 },
      budget: budgets.get(n.id),
      ...n.leader && leaders2.has(n.leader) ? { leader_state: leaders2.get(n.leader) } : {}
    };
  });
}
function show(db, address, raw, pace) {
  const n = nodeByAddress(db, address);
  if (n.kind === "concern")
    throw new Problem(
      410,
      `\u5173\u6CE8\u70B9 ${n.name} \u5DF2\u4ECE\u7EC4\u7EC7\u6811\u4E0B\u7EBF\uFF1B\u8BF7\u7528 atrium specialist ls \u67E5\u770B\u4E13\u5458`,
      "gone"
    );
  const list4 = tree(db, pace);
  const node = list4.find((item) => item.id === n.id);
  const charter = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    n.id
  );
  const card = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='card'",
    n.id
  );
  const view7 = (doc2) => doc2 ? {
    rev: `r${doc2.rev}`,
    fields: JSON.parse(doc2.fields),
    body: doc2.body,
    updated_by: doc2.updated_by,
    updated_at: doc2.updated_at
  } : null;
  const owned = allBoundaries(db);
  if (raw) {
    const found = raw === "charter" ? charter : card;
    return {
      raw: exportDocument(
        found ? JSON.parse(found.fields) : {},
        found?.body ?? "",
        raw === "charter" ? exportBoundaries(owned.get(n.id) ?? []) : void 0,
        raw === "charter" ? exportShares(allShares(db).get(n.id) ?? []) : void 0
      ),
      ref: ref(n.id),
      doc: raw
    };
  }
  const goalOf2 = (id3) => {
    const doc2 = one2(
      db,
      "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
      id3
    );
    const goal = doc2 ? JSON.parse(doc2.fields).goal : void 0;
    return typeof goal === "string" ? goal : "";
  };
  const levels = [];
  let current2 = node;
  while (current2) {
    const id3 = current2.id;
    levels.unshift({
      ref: current2.ref,
      name: current2.name,
      goal: goalOf2(id3),
      children: list4.filter((item) => item.parent_id === id3).map((c) => c.name)
    });
    current2 = list4.find((item) => item.id === current2?.parent_id);
  }
  const all3 = nodes(db);
  const name2 = (id3) => all3.find((item) => item.id === id3)?.name ?? "";
  const upper = chainLevels(all3, owned, n.parent_id);
  const inherited = new Set(effective(upper).map((e) => e.id));
  const own = owned.get(n.id) ?? [];
  const merged = effective([
    ...upper,
    { node: n.id, name: n.name, entries: own }
  ]);
  const boundaries = {
    chars: summaryLength(merged),
    inherited: merged.filter((e) => e.from !== n.id).length,
    added: merged.filter((e) => e.from === n.id).length,
    items: merged.map((e) => ({
      ...e,
      from: ref(e.from),
      from_name: name2(e.from),
      set_by: ref(e.set_by),
      set_by_name: name2(e.set_by)
    })),
    own: own.map((e) => {
      const live = merged.find((item) => item.id === e.id);
      const shadowed = e.param && live.param && live.set_by !== n.id ? live.param.value !== e.param.value : false;
      return {
        ...e,
        override: inherited.has(e.id),
        ...shadowed ? {
          shadowed_by: ref(live.set_by),
          shadowed_by_name: name2(live.set_by)
        } : {}
      };
    })
  };
  const fieldsOf = (id3) => {
    const doc2 = one2(
      db,
      "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
      id3
    );
    try {
      return doc2 ? JSON.parse(doc2.fields) : {};
    } catch {
      return {};
    }
  };
  const overview = overviewOf(
    fieldsOf(n.id),
    list4.filter((item) => item.parent_id === n.id).map((child) => {
      const fields = fieldsOf(child.id);
      return {
        ref: child.ref,
        name: child.name,
        alias: typeof fields.alias === "string" ? fields.alias.trim() : "",
        analogy: typeof fields.analogy === "string" ? fields.analogy.trim() : "",
        archived: child.archived_at !== null,
        tasks: child.tasks
      };
    })
  );
  return {
    ...node,
    overview,
    points: nodePoints(db, n.id),
    // 根 → 本节点每层的要点；后续派活按它附「本节点及上级的要点」
    points_chain: chainPoints(db, n.id),
    recent_tasks: nodeTasks(db, n.id),
    boundaries,
    charter: view7(charter),
    card: view7(card),
    chain: goalChain(levels)
  };
}
function bodyDiff(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  let head2 = 0, tail = 0;
  while (head2 < a.length && head2 < b.length && a[head2] === b[head2]) head2++;
  while (tail < a.length - head2 && tail < b.length - head2 && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  return [
    ...a.slice(head2, a.length - tail).map((line) => `- ${line}`),
    ...b.slice(head2, b.length - tail).map((line) => `+ ${line}`)
  ].join("\n");
}
function history(db, address, options) {
  const n = nodeByAddress(db, address);
  const parse6 = (value, field2) => {
    if (value === void 0) return void 0;
    if (!/^r[1-9][0-9]*$/.test(value))
      throw new Problem(400, `${field2} \u5E94\u4E3A rN`);
    return Number(value.slice(1));
  };
  const before = parse6(options.before, "--before"), after = parse6(options.after, "--after"), wanted = parse6(options.rev, "--rev");
  const target = options.target;
  if (target !== void 0 && !["node", "charter", "card"].includes(target))
    throw new Problem(400, "--target \u53EA\u80FD\u662F node\u3001charter\u3001card");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Problem(400, "--limit \u5E94\u4E3A 1\u2013100");
  if (wanted !== void 0) {
    const matches = all2(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND rev=? AND (? IS NULL OR target=?) ORDER BY id DESC LIMIT 4",
      n.id,
      wanted,
      target ?? null,
      target ?? null
    );
    if (matches.length > 1)
      throw new Problem(
        409,
        `r${wanted} \u5728\u591A\u4E2A\u6587\u6863\u4E2D\u5B58\u5728\uFF0C\u8BF7\u52A0 --target ${matches.map((m) => m.target).join("|")}`
      );
    const row3 = matches[0];
    if (!row3) throw new Problem(404, `${ref(n.id)} r${wanted} \u4E0D\u5B58\u5728`);
    const previous = one2(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND target=? AND rev=?",
      n.id,
      row3.target,
      wanted - 1
    );
    const current2 = JSON.parse(row3.snapshot), old = previous ? JSON.parse(previous.snapshot) : {};
    const beforeFields = old.fields ?? {}, afterFields = current2.fields ?? {};
    const changes = {};
    for (const key of /* @__PURE__ */ new Set([
      ...Object.keys(beforeFields),
      ...Object.keys(afterFields)
    ]))
      if ((row3.target !== "charter" || !HUMAN_KEYS.has(key)) && JSON.stringify(beforeFields[key]) !== JSON.stringify(afterFields[key]))
        changes[`fields.${key}`] = {
          before: beforeFields[key] ?? null,
          after: afterFields[key] ?? null
        };
    if (current2.boundaries !== void 0 || old.boundaries !== void 0) {
      const list4 = (value) => new Map(
        (Array.isArray(value) ? value : []).map((item) => [
          item.id,
          item
        ])
      );
      const a = list4(old.boundaries), b = list4(current2.boundaries);
      for (const id3 of /* @__PURE__ */ new Set([...a.keys(), ...b.keys()]))
        if (JSON.stringify(a.get(id3)) !== JSON.stringify(b.get(id3)))
          changes[`boundaries.${id3}`] = {
            before: a.get(id3) ?? null,
            after: b.get(id3) ?? null
          };
    }
    if (current2.budget !== void 0 || old.budget !== void 0) {
      const flatten = (value) => {
        const data2 = value && typeof value === "object" ? value : {};
        const quota = data2.quota && typeof data2.quota === "object" ? data2.quota : {};
        const flat = {
          ...Object.fromEntries(
            Object.entries(quota).map(([scope, amount]) => [
              `quota.${scope}`,
              amount
            ])
          ),
          ...data2.disk === void 0 ? {} : { disk: data2.disk },
          ...data2.money === void 0 ? {} : { money: data2.money }
        };
        return flat;
      };
      const before2 = flatten(old.budget), after2 = flatten(current2.budget);
      for (const key of /* @__PURE__ */ new Set([
        ...Object.keys(before2),
        ...Object.keys(after2)
      ]))
        if (before2[key] !== after2[key])
          changes[`budget.${key}`] = {
            before: before2[key] ?? null,
            after: after2[key] ?? null
          };
    }
    for (const key of /* @__PURE__ */ new Set([...Object.keys(old), ...Object.keys(current2)])) {
      if (key === "fields" || key === "boundaries" || key === "budget")
        continue;
      if (JSON.stringify(old[key]) !== JSON.stringify(current2[key]))
        changes[key] = {
          before: old[key] ?? null,
          after: current2[key] ?? null,
          ...key === "body" ? {
            diff: bodyDiff(
              String(old[key] ?? ""),
              String(current2[key] ?? "")
            )
          } : {}
        };
    }
    return { ref: ref(n.id), revision: { ...row3, snapshot: current2 }, changes };
  }
  const rows = all2(
    db,
    `SELECT * FROM org_revisions WHERE node_id=? AND (? IS NULL OR target=?) AND (? IS NULL OR rev<?) AND (? IS NULL OR rev>?) ORDER BY id DESC LIMIT ?`,
    n.id,
    target ?? null,
    target ?? null,
    before ?? null,
    before ?? null,
    after ?? null,
    after ?? null,
    limit + 1
  );
  return {
    ref: ref(n.id),
    items: rows.slice(0, limit).map((row3) => ({ ...row3, snapshot: JSON.parse(row3.snapshot) })),
    has_more: rows.length > limit
  };
}

// server/org/write.ts
function authorized(db, node, actor, target) {
  if (node.parent_id === null && target === "charter" && actor !== "u1" || !canEdit(nodes(db), node, actor))
    throw new Problem(
      403,
      `${target} \u65E0\u6743\u9650\uFF1A${actor} \u4E0D\u662F ${ref(node.id)} \u7684 leader \u6216\u7956\u5148 leader`,
      "conflict"
    );
}
function revision(db, id3, target, rev2, actor, reason, snapshot2) {
  db.prepare(
    "INSERT INTO org_revisions(node_id,target,rev,author,at,reason,snapshot) VALUES(?,?,?,?,?,?,?)"
  ).run(id3, target, rev2, actor, Date.now(), reason, JSON.stringify(snapshot2));
}
function nodeSnapshot(db, id3) {
  const node = one2(db, "SELECT * FROM org_nodes WHERE id=?", id3);
  const { doc_path: _legacyDocPath, ...visible } = node;
  const repos = all2(
    db,
    "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo",
    id3
  ).map((r) => r.repo);
  return { ...visible, repos };
}
function repoPaths(value) {
  if (!Array.isArray(value) || value.some(
    (repo) => typeof repo !== "string" || !repo.startsWith("/") || repo.split("/").includes("..")
  ))
    throw new Problem(400, "repos \u5E94\u4E3A\u7EDD\u5BF9\u8DEF\u5F84\u5217\u8868\uFF0C\u4E0D\u80FD\u5305\u542B ..");
  return [...new Set(value)];
}
function addNode(db, input, actor) {
  return transaction(db, () => {
    if ("doc_path" in input)
      throw new Problem(400, "doc_path \u5DF2\u505C\u7528\uFF0C\u8BF7\u7F16\u8F91\u8282\u70B9\u7AE0\u7A0B\u6B63\u6587");
    const list4 = nodes(db);
    if (list4.length >= 500) throw new Problem(400, "\u7EC4\u7EC7\u6811\u5DF2\u8FBE 500 \u4E2A\u8282\u70B9");
    const parent = input.parent ? nodeByAddress(db, input.parent) : null;
    const aspect = input.kind === "aspect";
    if (aspect && !parent)
      throw new Problem(400, "\u7BA1\u65B9\u9762\u7684\u90E8\u5206\u8981\u6302\u5728\u67D0\u4E2A\u90E8\u5206\u4E0B\u9762");
    const kind = aspect ? parent.kind === "org" ? "project" : "module" : validateKind(input.kind), slug = validateSlug(input.slug), reason = validateReason(input.reason);
    const name2 = input.name?.trim();
    if (!name2 || Array.from(name2).length > 100)
      throw new Problem(400, "name \u5E94\u4E3A 1\u2013100 \u5B57");
    if (!parent && (kind !== "org" || list4.length))
      throw new Problem(400, "parent \u5FC5\u987B\u6307\u5B9A\u5408\u6CD5\u7236\u8282\u70B9\uFF1Borg \u53EA\u80FD\u6709\u4E00\u4E2A\u6839");
    if (parent) {
      authorized(db, parent, actor, "node");
      if (parent.archived_at !== null) throw new Problem(400, "parent \u5DF2\u5F52\u6863");
      if (!validParent(parent.kind, kind))
        throw new Problem(400, `kind ${kind} \u4E0D\u80FD\u6302\u5728 ${parent.kind} \u4E0B`);
      let depth = 1, current2 = parent;
      while (current2) {
        depth++;
        current2 = list4.find((n) => n.id === current2?.parent_id);
      }
      if (depth > 8) throw new Problem(400, "parent \u5C42\u7EA7\u8D85\u8FC7\u6DF1\u5EA6 8");
    } else if (actor !== "u1") throw new Problem(403, "\u6839\u8282\u70B9\u53EA\u6709\u4F60\u80FD\u521B\u5EFA");
    if (list4.some((n) => n.parent_id === parent?.id && n.slug === slug))
      throw new Problem(409, `slug ${slug} \u5728\u540C\u4E00\u7236\u8282\u70B9\u4E0B\u5DF2\u5B58\u5728`);
    const leader = input.leader ?? (kind === "org" ? "u1" : null);
    if (leader !== null && !/^(u1|a[1-9][0-9]*)$/.test(leader))
      throw new Problem(400, "leader \u5E94\u4E3A u1 \u6216 aN");
    const repos = repoPaths(input.repos ?? []);
    const now = Date.now();
    const result = db.prepare(
      "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,aspect,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run(
      parent?.id ?? null,
      kind,
      slug,
      name2,
      leader,
      aspect ? 1 : 0,
      now,
      now
    );
    const id3 = Number(result.lastInsertRowid);
    for (const repo of repos)
      db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
        id3,
        repo
      );
    revision(db, id3, "node", 1, actor, reason, nodeSnapshot(db, id3));
    return nodeSnapshot(db, id3);
  });
}
function current(db, id3, doc2) {
  return one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc=?",
    id3,
    doc2
  );
}
function expectedRev(value, actual, id3, doc2) {
  if (value === void 0) return;
  if (typeof value !== "string" || !/^r(0|[1-9][0-9]*)$/.test(value))
    throw new Problem(400, "--rev \u5E94\u4E3A rN");
  if (Number(value.slice(1)) !== actual)
    throw new Problem(
      409,
      `${doc2} \u5DF2\u662F r${actual}\uFF0C\u4F60\u57FA\u4E8E ${value} \u4FEE\u6539\uFF1B\u5148\u770B\u53D8\u5316\uFF1Aatrium org history ${ref(id3)} --after ${value}`,
      "conflict",
      void 0,
      `atrium org history ${ref(id3)}`
    );
}
function editDoc(db, address, doc2, input, actor) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, doc2);
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} \u5DF2\u5F52\u6863`);
    expectedRev(input.rev, current(db, node.id, doc2)?.rev ?? 0, node.id, doc2);
    return editDocInner(
      db,
      node,
      doc2,
      input,
      validateReason(input.reason),
      actor
    );
  });
}
function editStages(db, address, stages, reason, actor) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "charter");
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} \u5DF2\u5F52\u6863`);
    const old = current(db, node.id, "charter");
    const fields = old ? JSON.parse(old.fields) : {};
    return editDocInner(
      db,
      node,
      "charter",
      { fields: { ...fields, stages }, body: old?.body ?? "" },
      validateReason(reason),
      actor
    );
  });
}
function editOverviewFields(db, address, fields, actor, detail2) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "charter");
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} \u5DF2\u5F52\u6863`);
    const old = current(db, node.id, "charter");
    const validated = validateFields("charter", fields);
    const previousFields = old ? JSON.parse(old.fields) : {};
    for (const key of /* @__PURE__ */ new Set([
      ...Object.keys(previousFields),
      ...Object.keys(validated)
    ]))
      if (!HUMAN_KEYS.has(key) && JSON.stringify(previousFields[key]) !== JSON.stringify(validated[key]))
        throw new Problem(400, `${key} \u5E94\u8D70\u7AE0\u7A0B\u4FEE\u8BA2`);
    let revisionResult;
    if (detail2) {
      expectedRev(detail2.rev, old?.rev ?? 0, node.id, "charter");
      revisionResult = editDocInner(
        db,
        node,
        "charter",
        { fields: previousFields, body: detail2.body },
        validateReason(detail2.reason),
        actor
      );
    }
    if (JSON.stringify(validated) !== (old?.fields ?? "{}")) {
      const previous = current(db, node.id, "charter");
      const at = Math.max(Date.now(), (previous?.updated_at ?? 0) + 1);
      db.prepare(
        "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,'charter',0,?,'',?,?) ON CONFLICT(node_id,doc) DO UPDATE SET fields=excluded.fields,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
      ).run(node.id, JSON.stringify(validated), actor, at);
    }
    return {
      node: ref(node.id),
      ...revisionResult ? { before: revisionResult.before, rev: revisionResult.rev } : {}
    };
  });
}
function revertDoc(db, address, doc2, to2, reason, actor) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, doc2);
    if (!/^r[1-9][0-9]*$/.test(to2)) throw new Problem(400, "--to \u5E94\u4E3A rN");
    const found = one2(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND target=? AND rev=?",
      node.id,
      doc2,
      Number(to2.slice(1))
    );
    if (!found) throw new Problem(404, `${doc2} ${to2} \u4E0D\u5B58\u5728`);
    const snapshot2 = JSON.parse(found.snapshot);
    if (doc2 === "charter") {
      snapshot2.boundaries ??= [];
      snapshot2.budget ??= {};
      const latest = current(db, node.id, "charter");
      const fields = snapshot2.fields;
      const currentFields = latest ? JSON.parse(latest.fields) : {};
      for (const key of HUMAN_KEYS) {
        if (Object.hasOwn(currentFields, key)) fields[key] = currentFields[key];
        else delete fields[key];
      }
    }
    return editDocInner(db, node, doc2, snapshot2, validateReason(reason), actor);
  });
}
function writeDoc(db, node, doc2, fields, body3, reason, actor) {
  const next = (current(db, node, doc2)?.rev ?? 0) + 1;
  db.prepare(
    "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,doc) DO UPDATE SET rev=excluded.rev,fields=excluded.fields,body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
  ).run(node, doc2, next, JSON.stringify(fields), body3, actor, Date.now());
  revision(db, node, doc2, next, actor, reason, {
    fields: doc2 === "charter" ? Object.fromEntries(
      Object.entries(fields).filter(([key]) => !HUMAN_KEYS.has(key))
    ) : fields,
    body: body3,
    ...doc2 === "charter" ? {
      boundaries: exportBoundaries(ownBoundaries(db, node)),
      budget: exportShares(ownShares(db, node))
    } : {}
  });
  return next;
}
function applyConverted(db, from, converted, reason, actor) {
  const touched = [...new Set(converted.map((c) => c.node))];
  const update2 = db.prepare(
    "UPDATE org_boundaries SET summary=? WHERE node_id=? AND bid=?"
  );
  for (const c of converted) update2.run(c.summary, c.node, c.id);
  for (const id3 of touched) {
    const old = current(db, id3, "charter");
    writeDoc(
      db,
      id3,
      "charter",
      old ? JSON.parse(old.fields) : {},
      old?.body ?? "",
      `\u56E0 ${ref(from.id)} ${from.name} \u7684\u4FEE\u6539\uFF0C${converted.filter((c) => c.node === id3).map((c) => c.id).join("\u3001")} \u8F6C\u4E3A\u672C\u8282\u70B9\u81EA\u6709\u6761\u76EE\uFF1A${reason}`,
      actor
    );
  }
  return converted.map((c) => ({ node: ref(c.node), id: c.id }));
}
function editDocInner(db, node, doc2, snapshot2, reason, actor) {
  const before = current(db, node.id, doc2)?.rev ?? 0;
  const fields = validateFields(doc2, snapshot2.fields), body3 = validateBody(snapshot2.body);
  let converted = [];
  if (doc2 === "card") {
    if (snapshot2.boundaries !== void 0)
      throw new Problem(400, "card.boundaries \u662F\u672A\u77E5\u5B57\u6BB5\uFF0C\u8FB9\u754C\u5199\u5728\u7AE0\u7A0B\u91CC");
    if (snapshot2.budget !== void 0)
      throw new Problem(400, "card.budget \u662F\u672A\u77E5\u5B57\u6BB5\uFF0C\u4EFD\u989D\u5199\u5728\u7AE0\u7A0B\u91CC");
  } else if (snapshot2.boundaries !== void 0) {
    const plan2 = planBoundaries(db, nodes(db), node, snapshot2.boundaries);
    saveBoundaries(db, node.id, plan2.entries);
    converted = plan2.converted;
  }
  if (doc2 === "charter" && snapshot2.budget !== void 0)
    saveShares(db, node.id, planShares(db, node, snapshot2.budget));
  if (doc2 === "charter" && snapshot2.boundaries !== void 0)
    checkStoredShares(db, node);
  const next = writeDoc(db, node.id, doc2, fields, body3, reason, actor);
  return {
    node: ref(node.id),
    doc: doc2,
    before: `r${before}`,
    rev: `r${next}`,
    fields,
    body: body3,
    ...doc2 === "charter" ? {
      boundaries: exportBoundaries(ownBoundaries(db, node.id)),
      budget: exportShares(ownShares(db, node.id)),
      converted: applyConverted(db, node, converted, reason, actor)
    } : {}
  };
}
function switchAspect(db, node, value) {
  if (value !== "aspect" && value !== "module")
    throw new Problem(400, "kind \u53EA\u80FD\u662F aspect \u6216 module", "usage");
  if (value === "aspect") {
    if (node.kind !== "module")
      throw new Problem(
        400,
        `kind: \u53EA\u6709 module \u90E8\u5206\u80FD\u6539\u6210 aspect\uFF08${ref(node.id)} ${node.name} \u662F ${node.kind}\uFF09`,
        "usage"
      );
    return 1;
  }
  const points = all2(
    db,
    "SELECT id,applies FROM org_points WHERE node_id=?",
    node.id
  ).map((row3) => ({ ref: pointRef(row3.id), applies: row3.applies }));
  const blockers = aspectClearance(node.applies, points);
  if (blockers.points.length || blockers.node) {
    const steps = [
      ...blockers.points.map(
        (r) => `\u8981\u70B9 ${r}\uFF08atrium org point-edit ${r} --applies ''\uFF09`
      ),
      ...blockers.node ? [
        `\u672C\u90E8\u5206\u7684\u7F3A\u7701\u9002\u7528\u8303\u56F4\uFF08atrium map edit ${ref(node.id)} --applies ''\uFF09`
      ] : []
    ];
    throw new Problem(
      400,
      `${ref(node.id)} ${node.name} \u8FD8\u6709\u9002\u7528\u8303\u56F4\uFF0C\u6539\u56DE module \u524D\u5148\u6E05\u6389\uFF1A${steps.join("\u3001")}`,
      "usage"
    );
  }
  return 0;
}
function editNode(db, address, input, actor) {
  return transaction(db, () => {
    if ("doc_path" in input)
      throw new Problem(400, "doc_path \u5DF2\u505C\u7528\uFF0C\u8BF7\u7F16\u8F91\u8282\u70B9\u7AE0\u7A0B\u6B63\u6587");
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "node");
    if (node.parent_id === null && actor !== "u1")
      throw new Problem(403, "\u6839\u8282\u70B9\u53EA\u6709\u4F60\u80FD\u6539");
    const old = one2(
      db,
      "SELECT rev FROM org_revisions WHERE node_id=? AND target='node' ORDER BY rev DESC LIMIT 1",
      node.id
    ).rev;
    expectedRev(input.rev, old, node.id, "node");
    const reason = validateReason(input.reason);
    let parent = node.parent_id;
    let moved = [];
    if (input.parent !== void 0) {
      const target = nodeByAddress(db, input.parent);
      authorized(db, target, actor, "node");
      if (target.archived_at !== null) throw new Problem(400, "parent \u5DF2\u5F52\u6863");
      if (!validParent(target.kind, node.kind))
        throw new Problem(400, "parent \u5C42\u7EA7\u4E0D\u5408\u6CD5");
      let current2 = target, depth = 1;
      const list4 = nodes(db);
      while (current2) {
        if (current2.id === node.id)
          throw new Problem(400, "parent \u4E0D\u80FD\u662F\u81EA\u8EAB\u6216\u540E\u4EE3");
        depth++;
        current2 = list4.find((n) => n.id === current2?.parent_id);
      }
      const height = (id3) => 1 + Math.max(
        0,
        ...list4.filter((n) => n.parent_id === id3).map((n) => height(n.id))
      );
      if (depth + height(node.id) - 1 > 8)
        throw new Problem(400, "parent \u5C42\u7EA7\u8D85\u8FC7\u6DF1\u5EA6 8");
      if (target.id !== node.parent_id)
        moved = planBoundaries(db, list4, node, void 0, {
          newParent: target.id,
          what: "\u4F4D\u7F6E"
        }).converted;
      if (target.id !== node.parent_id) checkStoredShares(db, node, target.id);
      parent = target.id;
    }
    const slug = input.slug === void 0 ? node.slug : validateSlug(input.slug);
    if (nodes(db).some(
      (n) => n.id !== node.id && n.parent_id === parent && n.slug === slug
    ))
      throw new Problem(409, "slug \u5728\u76EE\u6807\u7236\u8282\u70B9\u4E0B\u5DF2\u5B58\u5728");
    const name2 = input.name === void 0 ? node.name : input.name.trim();
    if (!name2 || Array.from(name2).length > 100)
      throw new Problem(400, "name \u5E94\u4E3A 1\u2013100 \u5B57");
    const leader = input.leader === void 0 ? node.leader : input.leader;
    if (leader !== null && !/^(u1|a[1-9][0-9]*)$/.test(leader))
      throw new Problem(400, "leader \u5E94\u4E3A u1 \u6216 aN");
    const repos = input.repos === void 0 ? void 0 : repoPaths(input.repos);
    const aspect = input.kind === void 0 ? node.aspect ? 1 : 0 : switchAspect(db, node, input.kind);
    const archived = input.archive === true ? Date.now() : node.archived_at;
    db.prepare(
      "UPDATE org_nodes SET parent_id=?,slug=?,name=?,leader=?,archived_at=?,aspect=?,updated_at=? WHERE id=?"
    ).run(parent, slug, name2, leader, archived, aspect, Date.now(), node.id);
    if (repos !== void 0) {
      db.prepare("DELETE FROM org_node_repos WHERE node_id=?").run(node.id);
      for (const repo of repos)
        db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
          node.id,
          repo
        );
    }
    revision(
      db,
      node.id,
      "node",
      old + 1,
      actor,
      reason,
      nodeSnapshot(db, node.id)
    );
    const converted = applyConverted(db, node, moved, reason, actor);
    return {
      ...nodeSnapshot(db, node.id),
      rev: `r${old + 1}`,
      ...converted.length ? { converted } : {}
    };
  });
}
function importOrg(db, input, actor) {
  if (actor !== "u1") throw new Problem(403, "org import \u53EA\u6709\u4F60\u80FD\u6267\u884C");
  const fields = validateFields("charter", input.charter?.fields), body3 = validateBody(input.charter?.body);
  repoPaths([input.repo]);
  if (!Array.isArray(input.docs) || input.docs.length > 200)
    throw new Problem(400, "docs \u8D85\u8FC7 200 \u9879");
  const seen = /* @__PURE__ */ new Set();
  for (const doc2 of input.docs) {
    validateSlug(doc2.slug);
    if (doc2.kind !== "module" || !/^\.agents\/modules\/(?:[a-z0-9-]|[\u3400-\u9fff]){1,40}\.md$/.test(
      doc2.source
    ) || doc2.source.includes("..") || !doc2.source.startsWith(".agents/modules/"))
      throw new Problem(400, "docs \u683C\u5F0F\u9519\u8BEF");
    try {
      validateBody(doc2.body);
    } catch {
      throw new Problem(400, `${doc2.source} \u6B63\u6587\u8D85\u8FC7 16 KB \u6216\u683C\u5F0F\u9519\u8BEF`);
    }
    if (seen.has(doc2.slug)) throw new Problem(400, `docs.${doc2.slug} \u91CD\u590D`);
    seen.add(doc2.slug);
  }
  const plan2 = [
    "\u7EC4\u7EC7",
    "Atrium \u9879\u76EE",
    "OpenQuota \u9879\u76EE",
    ...input.docs.map((d) => `${d.kind} ${d.name}`)
  ];
  if (!input.apply) return { preview: true, plan: plan2 };
  return transaction(db, () => {
    const changes = [];
    let root = nodes(db).find((n) => n.parent_id === null);
    if (!root) {
      const id3 = addNodeInnerRoot(db, actor);
      changes.push(`\u65B0\u5EFA ${ref(id3)} \u7EC4\u7EC7`);
      root = nodes(db).find((n) => n.parent_id === null);
    }
    if (!current(db, root.id, "charter")) {
      const edit = editDocInner(
        db,
        root,
        "charter",
        { fields, body: body3 },
        "\u5BFC\u5165\u6839\u7AE0\u7A0B",
        actor
      );
      changes.push(`\u66F4\u65B0 ${ref(root.id)} \u7EC4\u7EC7\u7AE0\u7A0B ${edit.rev}`);
    }
    const project = (slug, name2, goal, repos) => {
      let found = nodes(db).find(
        (n) => n.parent_id === root.id && n.slug === slug
      );
      if (!found) {
        const id3 = insertNode(
          db,
          root.id,
          "project",
          slug,
          name2,
          actor,
          repos,
          "\u7EC4\u7EC7\u6811\u521D\u59CB\u5316"
        );
        changes.push(`\u65B0\u5EFA ${ref(id3)} ${name2}`);
        found = one2(db, "SELECT * FROM org_nodes WHERE id=?", id3);
      }
      if (!current(db, found.id, "charter")) {
        const edit = editDocInner(
          db,
          found,
          "charter",
          { fields: { goal }, body: "" },
          "\u5BFC\u5165\u9879\u76EE\u76EE\u6807",
          actor
        );
        changes.push(`\u66F4\u65B0 ${ref(found.id)} ${name2} \u7AE0\u7A0B ${edit.rev}`);
      }
      return found;
    };
    const atrium = project(
      "atrium",
      "Atrium",
      String(input.atrium_goal ?? fields.goal ?? ""),
      [input.repo]
    );
    project(
      "openquota",
      "OpenQuota",
      String(
        input.openquota_goal ?? "\u5404\u5BB6\u8BA2\u9605\u989D\u5EA6\u770B\u5F97\u6E05\u3001\u67E5\u5F97\u5230\uFF0C\u4F9B\u7EC4\u7EC7\u6309\u5BCC\u4F59\u8C03\u5EA6\u3002"
      ),
      []
    );
    for (const doc2 of input.docs) {
      let found = nodes(db).find(
        (n) => n.parent_id === atrium.id && n.slug === doc2.slug
      );
      if (!found) {
        const id3 = insertNode(
          db,
          atrium.id,
          doc2.kind,
          doc2.slug,
          doc2.name,
          actor,
          [input.repo],
          "\u5BFC\u5165\u5C97\u4F4D\u8BF4\u660E"
        );
        changes.push(`\u65B0\u5EFA ${ref(id3)} atrium/${doc2.slug}`);
        found = one2(db, "SELECT * FROM org_nodes WHERE id=?", id3);
      }
      if (found.kind !== doc2.kind)
        throw new Problem(409, `atrium/${doc2.slug} \u7C7B\u578B\u4E0D\u662F ${doc2.kind}`);
      const previous = current(db, found.id, "charter");
      if (!previous || previous.body !== doc2.body) {
        const edit = editDocInner(
          db,
          found,
          "charter",
          {
            fields: previous ? JSON.parse(previous.fields) : {},
            body: doc2.body
          },
          "\u4ECE .agents \u5BFC\u5165",
          actor
        );
        changes.push(
          `\u66F4\u65B0 ${ref(found.id)} atrium/${doc2.slug} \u7AE0\u7A0B ${edit.rev}`
        );
      }
    }
    return { preview: false, plan: changes, created: changes.length };
  });
}
function insertNode(db, parent, kind, slug, name2, actor, repos, reason) {
  if (nodes(db).length >= 500) throw new Problem(400, "\u7EC4\u7EC7\u6811\u5DF2\u8FBE 500 \u4E2A\u8282\u70B9");
  const now = Date.now();
  const id3 = Number(
    db.prepare(
      "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
    ).run(parent, kind, slug, name2, kind === "org" ? "u1" : null, now, now).lastInsertRowid
  );
  for (const repo of repos)
    db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
      id3,
      repo
    );
  revision(db, id3, "node", 1, actor, reason, nodeSnapshot(db, id3));
  return id3;
}
function addNodeInnerRoot(db, actor) {
  return insertNode(db, null, "org", "org", "\u7EC4\u7EC7", actor, [], "\u7EC4\u7EC7\u6811\u521D\u59CB\u5316");
}
function charterFields2(db, node) {
  const old = current(db, node, "charter");
  return old ? JSON.parse(old.fields) : {};
}
function writeCharterFields(db, node, fields, reason, actor) {
  const row3 = one2(db, "SELECT * FROM org_nodes WHERE id=?", node);
  if (!row3) throw new Problem(404, `${ref(node)} \u4E0D\u5B58\u5728`);
  return editDocInner(
    db,
    row3,
    "charter",
    { fields, body: current(db, node, "charter")?.body ?? "" },
    validateReason(reason),
    actor
  );
}

// server/org/routes.ts
var q = (value) => value ?? {};
var p = (value) => value ?? {};
var body = (value) => value ?? {};
var doc = (value) => {
  if (value !== "charter" && value !== "card")
    throw new Problem(400, "doc \u53EA\u80FD\u662F charter \u6216 card");
  return value;
};
function registerOrgRoutes(app2, db) {
  ensureOrgTables(db);
  const actor = (query2) => resolveActor(db, q(query2).as);
  const checkedLeader = (input) => {
    const leader = typeof input.leader === "string" ? input.leader.trim() : input.leader;
    if (typeof leader === "string" && /^a[1-9][0-9]*$/.test(leader) && !isRegistered(db, leader))
      throw new Problem(
        404,
        `--leader: ${leader} \u6CA1\u6709\u767B\u8BB0\u4E3A leader`,
        "not_found",
        void 0,
        `atrium leader add \u540D\u79F0 --worker claude+opus --id ${leader}`
      );
    return leader === "none" || leader === "\u65E0" ? { ...input, leader: null } : typeof leader === "string" ? { ...input, leader } : input;
  };
  app2.get("/api/org/tree", async () => tree(db, await readPace()));
  app2.get(
    "/api/org/nodes/:id",
    async (request2) => show(
      db,
      p(request2.params).id,
      q(request2.query).raw === void 0 ? void 0 : doc(q(request2.query).raw),
      await readPace()
    )
  );
  app2.get("/api/org/nodes/:id/history", (request2) => {
    const query2 = q(request2.query);
    return history(db, p(request2.params).id, {
      ...query2,
      limit: query2.limit === void 0 ? void 0 : Number(query2.limit)
    });
  });
  app2.post(
    "/api/org/nodes",
    { bodyLimit: 64 * 1024 },
    (request2, reply) => reply.code(201).send(
      addNode(
        db,
        (() => {
          const input = checkedLeader(body(request2.body));
          if (input.kind === "concern")
            throw new Problem(
              400,
              "\u5173\u6CE8\u70B9\u8282\u70B9\u5DF2\u4E0B\u7EBF\uFF1B\u8BF7\u7528 atrium specialist add \u521B\u5EFA\u4E13\u5458",
              "usage"
            );
          return input;
        })(),
        actor(request2.query)
      )
    )
  );
  app2.patch(
    "/api/org/nodes/:id",
    { bodyLimit: 64 * 1024 },
    (request2) => editNode(
      db,
      p(request2.params).id,
      checkedLeader(body(request2.body)),
      actor(request2.query)
    )
  );
  app2.put(
    "/api/org/nodes/:id/docs/:doc",
    { bodyLimit: 64 * 1024 },
    (request2) => {
      const input = body(request2.body), target = doc(request2.params.doc);
      const parsed = typeof input.source === "string" ? parseDocument(input.source, target) : input;
      return editDoc(
        db,
        p(request2.params).id,
        target,
        {
          fields: parsed.fields,
          body: parsed.body,
          boundaries: parsed.boundaries,
          budget: parsed.budget,
          rev: input.rev,
          reason: input.reason
        },
        actor(request2.query)
      );
    }
  );
  app2.post("/api/org/nodes/:id/revert", { bodyLimit: 8 * 1024 }, (request2) => {
    const input = body(request2.body);
    return revertDoc(
      db,
      p(request2.params).id,
      doc(input.doc),
      String(input.to ?? ""),
      String(input.reason ?? ""),
      actor(request2.query)
    );
  });
  app2.put("/api/org/nodes/:id/stages", { bodyLimit: 64 * 1024 }, (request2) => {
    const input = body(request2.body);
    for (const key of Object.keys(input))
      if (key !== "stages" && key !== "reason")
        throw new Problem(400, `${key}: \u662F\u672A\u77E5\u5B57\u6BB5`);
    return editStages(
      db,
      p(request2.params).id,
      input.stages,
      input.reason,
      actor(request2.query)
    );
  });
  app2.post(
    "/api/org/nodes/:id/points",
    { bodyLimit: 8 * 1024 },
    (request2, reply) => reply.code(201).send(
      addPoint(
        db,
        p(request2.params).id,
        request2.body,
        actor(request2.query)
      )
    )
  );
  app2.patch(
    "/api/org/points/:id",
    { bodyLimit: 8 * 1024 },
    (request2) => editPoint(db, p(request2.params).id, request2.body, actor(request2.query))
  );
  app2.delete(
    "/api/org/points/:id",
    (request2) => removePoint(db, p(request2.params).id, actor(request2.query))
  );
  app2.post("/api/org/link-roles", { bodyLimit: 1024 }, (request2) => {
    const apply = body(request2.body).apply === true;
    if (apply && actor(request2.query) !== "u1")
      throw new Problem(403, "org link-roles --apply \u53EA\u6709\u4F60\u80FD\u6267\u884C");
    return linkRoles(db, apply);
  });
  app2.post(
    "/api/org/import",
    { bodyLimit: 4 * 1024 * 1024 },
    (request2) => importOrg(db, body(request2.body), actor(request2.query))
  );
}

// server/tasks/specialist-migrate.ts
var specialistMigrationAction = (node) => node.id === 6 && node.name === "\u5B89\u5168" || node.id === 7 && node.name === "\u8D28\u91CF" ? "retire" : "convert";
function migrateSpecialists(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS specialist_migration_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL,
    snapshot TEXT NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL);`);
  const legacy = all2(
    db,
    "SELECT * FROM org_nodes WHERE kind='concern' AND archived_at IS NULL ORDER BY id LIMIT 500"
  );
  for (const node of legacy) {
    try {
      transaction(db, () => migrateOne(db, node));
    } catch (error) {
      const message4 = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      transaction(db, () => {
        db.prepare(
          "INSERT INTO specialist_migration_quarantine(node_id,snapshot,error,at) VALUES(?,?,?,?)"
        ).run(node.id, JSON.stringify(node), message4, now);
        db.prepare(
          "UPDATE org_nodes SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL"
        ).run(now, now, node.id);
      });
      console.error(`\u4E13\u5458\u8FC1\u79FB\uFF1Ao${node.id} \u5DF2\u9694\u79BB\uFF1A${message4}`);
    }
  }
}
function quarantineRows(db, table, nodeId, reason, now, duplicateWith) {
  let after = 0;
  for (; ; ) {
    const rows = all2(
      db,
      `SELECT * FROM ${table} WHERE node_id=? AND task_id>?
       ${duplicateWith === void 0 ? "" : `AND task_id IN (SELECT task_id FROM ${table} WHERE node_id=?)`}
       ORDER BY task_id LIMIT 200`,
      ...duplicateWith === void 0 ? [nodeId, after] : [nodeId, after, duplicateWith]
    );
    if (!rows.length) return;
    for (const row3 of rows)
      db.prepare(
        "INSERT INTO specialist_migration_quarantine(node_id,snapshot,error,at) VALUES(?,?,?,?)"
      ).run(nodeId, JSON.stringify({ table, row: row3 }), reason, now);
    after = rows.at(-1).task_id;
  }
}
function migrateOne(db, node) {
  const now = Date.now();
  if (specialistMigrationAction(node) === "retire") {
    const target = one2(
      db,
      "SELECT id FROM org_nodes WHERE id=2 AND archived_at IS NULL"
    );
    if (!target) throw new Error("\u627E\u4E0D\u5230\u63A5\u6536\u8981\u70B9\u7684 o2 Atrium");
    const targetFirst = one2(
      db,
      "SELECT COALESCE(MIN(pos),0) n FROM org_points WHERE node_id=?",
      target.id
    ).n;
    const sourceLast = one2(
      db,
      "SELECT COALESCE(MAX(pos),0) n FROM org_points WHERE node_id=?",
      node.id
    ).n;
    db.prepare(
      "UPDATE org_points SET node_id=?,pos=pos+?,updated_at=? WHERE node_id=?"
    ).run(target.id, targetFirst - sourceLast - 1, now, node.id);
    for (const table of ["task_concerns", "council_members"]) {
      quarantineRows(db, table, node.id, "\u64A4\u9500\u793A\u4F8B\u4E13\u5458\u7684\u65E7\u9080\u8BF7", now);
      db.prepare(`DELETE FROM ${table} WHERE node_id=?`).run(node.id);
    }
    db.prepare(
      "UPDATE org_nodes SET archived_at=?,updated_at=? WHERE id=?"
    ).run(now, now, node.id);
    return;
  }
  const doc2 = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id
  );
  const fields = doc2 ? JSON.parse(doc2.fields) : {};
  const goal = typeof fields.goal === "string" ? fields.goal.trim() : "";
  const points = nodePoints(db, node.id).map((point) => ({
    ref: point.ref,
    text: point.text,
    why: point.why
  }));
  const bottom = ownBoundaries(db, node.id).map(
    (b) => `${b.summary}${b.param ? `\uFF1A${formatParam(b.param)}` : ""}`
  );
  const invite_when = Array.isArray(fields.invite_when) ? fields.invite_when.filter((x) => typeof x === "string") : [];
  const hasSkills2 = one2(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_skill_bindings'"
  );
  const boundSkills = hasSkills2 ? all2(
    db,
    `SELECT s.slug FROM org_skill_bindings b JOIN org_skills s ON s.id=b.skill_id
          WHERE b.node_id=? AND s.archived_at IS NULL ORDER BY s.slug LIMIT 20`,
    node.id
  ).map((row3) => row3.slug) : [];
  let specialist;
  try {
    specialist = getJobRole(db, node.name);
  } catch {
    specialist = void 0;
  }
  const data2 = {
    review_goal: goal,
    review_points: points,
    review_bottom: bottom,
    invite_when,
    skills: [.../* @__PURE__ */ new Set([...specialist?.skills ?? [], ...boundSkills])]
  };
  specialist = specialist ? editJobRole(db, specialist.ref, data2, now) : createJobRole(
    db,
    {
      name: node.name,
      description: goal || node.name,
      body: doc2?.body?.trim() || goal || node.name,
      ...data2
    },
    now
  );
  const id3 = -specialist.id;
  for (const table of ["task_concerns", "council_members"]) {
    quarantineRows(db, table, node.id, "\u91CD\u590D\u9080\u8BF7\uFF0C\u4FDD\u7559\u65B0\u4E13\u5458\u8BB0\u5F55", now, id3);
    db.prepare(
      `DELETE FROM ${table} WHERE node_id=? AND task_id IN (SELECT task_id FROM ${table} WHERE node_id=?)`
    ).run(node.id, id3);
    db.prepare(`UPDATE ${table} SET node_id=? WHERE node_id=?`).run(
      id3,
      node.id
    );
  }
  db.prepare(
    `UPDATE tasks SET job_id=?,role=NULL,node_id=NULL
    WHERE job_id IS NULL AND id IN (
      SELECT review_id FROM task_concerns WHERE node_id=? AND review_id IS NOT NULL
      UNION SELECT opinion_id FROM council_members WHERE node_id=?)`
  ).run(specialist.id, id3, id3);
  db.prepare("UPDATE org_nodes SET archived_at=?,updated_at=? WHERE id=?").run(
    now,
    now,
    node.id
  );
}

// server/goals/schema.ts
function ensureGoalTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES goals(id),
    result TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('planned','active','achieved','blocked','dropped')),
    note TEXT,
    node_id INTEGER NOT NULL,
    due TEXT,
    updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS goals_parent ON goals(parent_id,id);
  CREATE TABLE IF NOT EXISTS goal_dependencies (
    goal_id INTEGER NOT NULL REFERENCES goals(id), after_id INTEGER NOT NULL REFERENCES goals(id),
    PRIMARY KEY(goal_id,after_id));
  CREATE INDEX IF NOT EXISTS goal_dependencies_after ON goal_dependencies(after_id,goal_id);
  CREATE TRIGGER IF NOT EXISTS goals_no_delete
    BEFORE DELETE ON goals BEGIN SELECT RAISE(ABORT,'goals drop only'); END;`);
  if (!all2(db, "PRAGMA table_info(goals)").some(
    (c) => c.name === "repo"
  ))
    db.exec("ALTER TABLE goals ADD COLUMN repo TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS goal_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id),
    criterion TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('command','manual')),
    result TEXT NOT NULL CHECK(result IN ('running','pass','fail','timeout','error')),
    exit_code INTEGER, summary TEXT, note TEXT, log TEXT,
    owner INTEGER,
    actor TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER);
  CREATE INDEX IF NOT EXISTS goal_checks_goal ON goal_checks(goal_id,id);
  CREATE INDEX IF NOT EXISTS goal_checks_running ON goal_checks(result) WHERE result='running';`);
  db.exec(`CREATE TABLE IF NOT EXISTS goal_migrations (
    goal_id INTEGER PRIMARY KEY REFERENCES goals(id),
    node_id INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS goal_retirement (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    at INTEGER NOT NULL, actor TEXT NOT NULL, backup TEXT);`);
}

// server/goals/rules.ts
var STATUS_LABEL = {
  planned: "\u89C4\u5212\u4E2D",
  active: "\u8FDB\u884C\u4E2D",
  achieved: "\u8FBE\u6210",
  blocked: "\u53D7\u963B",
  dropped: "\u653E\u5F03"
};
var DEPTH_MAX = 12;
var GOALS_MAX = 2e3;
function transition2(from, action) {
  const to2 = action.kind === "done" ? "achieved" : action.kind === "drop" ? "dropped" : action.to;
  if (from === to2) return { ok: false, reason: `\u5DF2\u7ECF\u662F${STATUS_LABEL[to2]}` };
  return { ok: true, to: to2 };
}
var prerequisiteMet = (status) => status === "achieved";
function unmetPrerequisites(prerequisites) {
  return prerequisites.filter((p3) => !prerequisiteMet(p3.status));
}
function leadsNode(org, nodeId, actor) {
  if (actor === "u1") return true;
  const seen = /* @__PURE__ */ new Set();
  let current2 = org.find((n) => n.id === nodeId);
  while (current2 && !seen.has(current2.id)) {
    if (current2.leader === actor) return true;
    seen.add(current2.id);
    const parent = current2.parent_id;
    current2 = org.find((n) => n.id === parent);
  }
  return false;
}
function canChange(org, goal, actor) {
  if (goal.parent_id === null)
    return actor === "u1" ? { ok: true } : { ok: false, reason: "\u9876\u5C42\u76EE\u6807\u53EA\u6709\u4F60\uFF08u1\uFF09\u80FD\u6539" };
  return leadsNode(org, goal.node_id, actor) ? { ok: true } : {
    ok: false,
    reason: `${actor} \u4E0D\u662F\u8D1F\u8D23\u90E8\u95E8 o${goal.node_id} \u7684 leader \u6216\u5176\u4E0A\u7EA7 leader`
  };
}
function canCreate(org, parent, nodeId, actor) {
  if (!parent)
    return actor === "u1" ? { ok: true } : { ok: false, reason: "\u9876\u5C42\u76EE\u6807\u53EA\u6709\u4F60\uFF08u1\uFF09\u80FD\u5EFA" };
  if (!leadsNode(org, nodeId, actor))
    return {
      ok: false,
      reason: `${actor} \u4E0D\u662F\u8D1F\u8D23\u90E8\u95E8 o${nodeId} \u7684 leader \u6216\u5176\u4E0A\u7EA7 leader`
    };
  if (parent.parent_id !== null && !leadsNode(org, parent.node_id, actor))
    return {
      ok: false,
      reason: `${actor} \u4E0D\u662F\u4E0A\u7EA7\u91CC\u7A0B\u7891\u8D1F\u8D23\u90E8\u95E8 o${parent.node_id} \u7684 leader \u6216\u5176\u4E0A\u7EA7 leader`
    };
  return { ok: true };
}
function depthOf(goals, id3) {
  const byId = new Map(goals.map((g) => [g.id, g]));
  let depth = 0;
  let current2 = byId.get(id3);
  while (current2) {
    depth++;
    if (depth > GOALS_MAX) return Infinity;
    if (current2.parent_id === null) return depth;
    current2 = byId.get(current2.parent_id);
  }
  return Infinity;
}
function subtreeHeight(goals, id3) {
  const children = /* @__PURE__ */ new Map();
  for (const g of goals)
    if (g.parent_id !== null)
      children.set(g.parent_id, [...children.get(g.parent_id) ?? [], g.id]);
  const height = (node, seen) => {
    if (seen.has(node)) return Infinity;
    seen.add(node);
    return 1 + Math.max(0, ...(children.get(node) ?? []).map((c) => height(c, seen)));
  };
  return height(id3, /* @__PURE__ */ new Set());
}
function isWithin(goals, id3, ancestor) {
  const byId = new Map(goals.map((g) => [g.id, g]));
  let current2 = byId.get(id3);
  for (let i = 0; current2 && i <= GOALS_MAX; i++) {
    if (current2.id === ancestor) return true;
    current2 = current2.parent_id === null ? void 0 : byId.get(current2.parent_id);
  }
  return false;
}
function prerequisiteCycle(edges, id3, after) {
  const next = /* @__PURE__ */ new Map();
  for (const e of edges)
    if (e.goal_id !== id3)
      next.set(e.goal_id, [...next.get(e.goal_id) ?? [], e.after_id]);
  next.set(id3, [...after]);
  const seen = /* @__PURE__ */ new Set();
  const walk = (node, path) => {
    for (const to2 of next.get(node) ?? []) {
      if (to2 === id3) return [...path, to2];
      if (seen.has(to2)) continue;
      seen.add(to2);
      const found = walk(to2, [...path, to2]);
      if (found) return found;
    }
    return null;
  };
  return walk(id3, [id3]);
}
function adoptBlocker(task) {
  if (task.children === 0) return "\u6CA1\u6709\u5B50\u4EFB\u52A1\uFF0C\u4E0D\u662F\u5F52\u7C7B\u7528\u7684\u7236\u4EFB\u52A1";
  if (task.status === "running") return "\u6B63\u5728\u6267\u884C";
  if (task.worker) return `\u6D3E\u8FC7\u6267\u884C\u8005 ${task.worker}\uFF0C\u4E0D\u53EA\u662F\u5F52\u7C7B`;
  if (task.pr_url) return "\u6709\u4EA4\u4ED8 PR\uFF0C\u4E0D\u53EA\u662F\u5F52\u7C7B";
  return null;
}
function adoptedStatus(status, childStatuses) {
  if (status === "done") return "achieved";
  if (status === "cancelled") return "dropped";
  if (status === "blocked") return "blocked";
  return childStatuses.some((s) => s !== "todo") ? "active" : "planned";
}

// server/goals/model.ts
var goalRef = (id3) => `g${id3}`;
var usage7 = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function parseGoalRef(value, field2 = "goal") {
  const match = typeof value === "string" ? /^g([1-9][0-9]{0,15})$/.exec(value.trim()) : null;
  const id3 = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id3))
    throw usage7(`${field2}: \u76EE\u6807\u77ED\u53F7\u5E94\u4E3A g1 \u8FD9\u6837\u7684\u683C\u5F0F`, "atrium goal tree");
  return id3;
}
function goalRow(db, id3) {
  return one2(db, "SELECT * FROM goals WHERE id=?", id3);
}
function requireGoal(db, id3, field2) {
  const found = goalRow(db, id3);
  if (!found)
    throw new Problem(
      field2 ? 400 : 404,
      `${field2 ? `${field2}: ` : ""}\u76EE\u6807 ${goalRef(id3)} \u4E0D\u5B58\u5728`,
      field2 ? "usage" : "not_found",
      void 0,
      "atrium goal tree"
    );
  return found;
}
function allGoals(db) {
  const rows = all2(
    db,
    "SELECT * FROM goals ORDER BY id LIMIT ?",
    GOALS_MAX + 1
  );
  if (rows.length > GOALS_MAX)
    throw new Problem(409, `\u76EE\u6807\u6811\u8D85\u8FC7 ${GOALS_MAX} \u4E2A\u8282\u70B9`);
  return rows;
}
function dependencies(db) {
  return all2(
    db,
    "SELECT goal_id,after_id FROM goal_dependencies ORDER BY goal_id,after_id LIMIT ?",
    GOALS_MAX * 20
  );
}
function criteriaOf(row3) {
  try {
    const value = JSON.parse(row3.criteria);
    if (Array.isArray(value) && value.every((v) => typeof v === "string"))
      return { items: value, broken: false };
  } catch {
  }
  return { items: [], broken: true };
}

// server/goals/summary.ts
var idOf = (ref2) => Number(ref2.slice(1));
function summarize2(node) {
  const children = node.children.map(summarize2);
  return node.summary = {
    running: node.tasks.running + children.reduce((n, c) => n + c.running, 0),
    open: node.tasks.todo + node.tasks.running + node.tasks.blocked + children.reduce((n, c) => n + c.open, 0),
    blocked: node.tasks.blocked + children.reduce((n, c) => n + c.blocked, 0),
    waiting_for: [
      .../* @__PURE__ */ new Set([
        ...node.waiting_for,
        ...children.flatMap((child) => child.waiting_for)
      ])
    ].sort((a, b) => idOf(a) - idOf(b))
  };
}

// server/goals/check-rules.ts
var COMMAND_PREFIX = "$ ";
var CHECK_LABEL = {
  running: "\u6267\u884C\u4E2D",
  pass: "\u6EE1\u8DB3",
  fail: "\u4E0D\u6EE1\u8DB3",
  timeout: "\u8D85\u65F6",
  error: "\u6CA1\u8DD1\u6210"
};
function commandOf(criterion) {
  if (!criterion.startsWith(COMMAND_PREFIX)) return null;
  const command = criterion.slice(COMMAND_PREFIX.length).trim();
  return command || null;
}
function criterionProblem(criterion) {
  if (/^\$\s*$/.test(criterion))
    return "\u4EE5 $ \u5F00\u5934\u7684\u6761\u76EE\u8981\u8DDF\u547D\u4EE4\uFF0C\u5982 $ npm test";
  if (/^\$\S/.test(criterion))
    return "\u547D\u4EE4\u6761\u76EE\u5199\u6210 `$ \u547D\u4EE4`\uFF08$ \u540E\u7A7A\u4E00\u683C\uFF09\uFF0C\u5426\u5219\u6309\u4EBA\u5DE5\u5224\u5B9A\u7684\u6761\u76EE\u5904\u7406";
  return null;
}
function itemStates(criteria, checks) {
  const latest = /* @__PURE__ */ new Map();
  for (const check2 of checks) {
    const seen = latest.get(check2.criterion);
    if (!seen || check2.id > seen.id) latest.set(check2.criterion, check2);
  }
  return criteria.map((text6, i) => ({
    n: i + 1,
    text: text6,
    command: commandOf(text6),
    latest: latest.get(text6) ?? null
  }));
}
function readiness(status, items, prerequisites) {
  if (status === "achieved" || status === "dropped")
    return { ready: false, blockers: [] };
  const blockers = [];
  if (!items.length) blockers.push("\u8FD8\u6CA1\u6709\u9A8C\u6536\u6807\u51C6");
  for (const item of items) {
    const result = item.latest?.result;
    if (result === "pass") continue;
    blockers.push(
      `\u7B2C ${item.n} \u6761${!result ? item.command ? "\u8FD8\u6CA1\u8DD1" : "\u8FD8\u6CA1\u5224" : result === "running" ? "\u6B63\u5728\u6267\u884C" : CHECK_LABEL[result]}`
    );
  }
  for (const p3 of prerequisites)
    if (!prerequisiteMet(p3.status)) blockers.push(`\u524D\u7F6E ${p3.ref} \u672A\u8FBE\u6210`);
  return { ready: blockers.length === 0, blockers };
}
function canJudge(org, goal, actor) {
  if (leadsNode(org, goal.node_id, actor)) return { ok: true };
  const chain = /* @__PURE__ */ new Set();
  let current2 = org.find((n) => n.id === goal.node_id);
  while (current2 && !chain.has(current2.id)) {
    chain.add(current2.id);
    const parent = current2.parent_id;
    current2 = org.find((n) => n.id === parent);
  }
  const concern = org.some(
    (n) => n.kind === "concern" && n.leader === actor && !n.archived_at && n.parent_id !== null && chain.has(n.parent_id)
  );
  return concern ? { ok: true } : {
    ok: false,
    reason: `${actor} \u4E0D\u662F\u8D1F\u8D23\u90E8\u95E8 o${goal.node_id} \u7684 leader\u3001\u4E0A\u7EA7 leader \u6216\u540C\u9879\u76EE\u5173\u6CE8\u70B9\uFF08\u5982\u8D28\u91CF\uFF09\u7684 leader`
  };
}
function manualBlocker(item) {
  if (!item) return "\u6CA1\u6709\u8FD9\u4E00\u6761";
  if (item.command)
    return `\u7B2C ${item.n} \u6761\u662F\u547D\u4EE4\uFF0C\u7531\u8FD0\u884C\u65F6\u6267\u884C\u5224\u5B9A\uFF1B\u53BB\u6389 --pass/--fail \u91CD\u8DD1`;
  return null;
}
function commandResult(input) {
  if (input.timedOut) return "timeout";
  if (input.error) return "error";
  return input.code === 0 ? "pass" : "fail";
}
var SUMMARY_MAX = 1500;
function summarize3(output) {
  const plain = redact(output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")).trim();
  const lines2 = plain.split("\n").slice(-20).join("\n");
  const chars4 = Array.from(lines2);
  return chars4.length > SUMMARY_MAX ? `\u2026${chars4.slice(-SUMMARY_MAX).join("")}` : lines2;
}

// server/goals/checks.ts
var NOTE_MAX = 500;
var LATEST_MAX = GOALS_MAX * 20;
function latestChecks(db, goalId) {
  const rows = goalId === void 0 ? all2(
    db,
    "SELECT * FROM goal_checks WHERE id IN (SELECT MAX(id) FROM goal_checks GROUP BY goal_id,criterion) ORDER BY id LIMIT ?",
    LATEST_MAX
  ) : all2(
    db,
    "SELECT * FROM goal_checks WHERE id IN (SELECT MAX(id) FROM goal_checks WHERE goal_id=? GROUP BY criterion) ORDER BY id LIMIT 200",
    goalId
  );
  const byGoal = /* @__PURE__ */ new Map();
  for (const row3 of rows)
    byGoal.set(row3.goal_id, [...byGoal.get(row3.goal_id) ?? [], row3]);
  return byGoal;
}
function checkRow(db, id3) {
  return one2(db, "SELECT * FROM goal_checks WHERE id=?", id3);
}
function checkView(row3) {
  return {
    id: row3.id,
    criterion: row3.criterion,
    kind: row3.kind,
    result: row3.result,
    exit_code: row3.exit_code,
    summary: row3.summary,
    note: row3.note,
    log: row3.log,
    actor: row3.actor,
    started_at: row3.started_at,
    ended_at: row3.ended_at
  };
}
function goalItems(db, row3) {
  return itemStates(
    criteriaOf(row3).items,
    latestChecks(db, row3.id).get(row3.id) ?? []
  );
}
function insertCheck(db, input) {
  const done = input.result !== "running";
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO goal_checks(goal_id,criterion,kind,result,note,owner,actor,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(
    input.goal_id,
    input.criterion,
    input.kind,
    input.result,
    input.note ?? null,
    input.owner ?? null,
    input.actor,
    input.at,
    done ? input.at : null
  );
  return Number(lastInsertRowid);
}
function finishCheck(db, id3, outcome, at = Date.now()) {
  db.prepare(
    "UPDATE goal_checks SET result=?,exit_code=?,summary=?,log=?,ended_at=? WHERE id=? AND result='running'"
  ).run(
    outcome.result,
    outcome.exit_code,
    outcome.summary,
    outcome.log,
    at,
    id3
  );
}
function sweepInterrupted(db, alive4, self = process.pid, at = Date.now()) {
  const rows = all2(
    db,
    "SELECT id,owner FROM goal_checks WHERE result='running' ORDER BY id LIMIT 1000"
  );
  for (const row3 of rows)
    if (row3.owner === null || row3.owner !== self && !alive4(row3.owner))
      finishCheck(
        db,
        row3.id,
        {
          result: "error",
          exit_code: null,
          summary: "\u670D\u52A1\u4E2D\u65AD\uFF0C\u68C0\u67E5\u6CA1\u8DD1\u5B8C\uFF1B\u91CD\u8DD1 atrium goal check",
          log: null
        },
        at
      );
}
function judgeItem(db, reference, body3, actor, now = Date.now()) {
  const id3 = parseGoalRef(reference, "\u76EE\u6807");
  const input = objectOf2(body3);
  onlyKeys(input, ["item", "verdict", "note"]);
  if (input.verdict !== "pass" && input.verdict !== "fail")
    throw usage7("--pass \u6216 --fail \u4E8C\u9009\u4E00");
  const n = input.item;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
    throw usage7("--item: \u4EBA\u5DE5\u5224\u5B9A\u8981\u6307\u660E\u7B2C\u51E0\u6761\uFF0C\u5982 --item 2");
  if (typeof input.note !== "string" || !input.note.trim())
    throw usage7("--note: \u4EBA\u5DE5\u5224\u5B9A\u8981\u5199\u8BC1\u636E\uFF08\u94FE\u63A5\u3001\u547D\u4EE4\u8F93\u51FA\u6216\u89C2\u5BDF\u5230\u7684\u4E8B\u5B9E\uFF09");
  const note = input.note.trim();
  if (Array.from(note).length > NOTE_MAX)
    throw usage7(`--note: \u4E0D\u80FD\u8D85\u8FC7 ${NOTE_MAX} \u5B57`);
  const row3 = requireGoal(db, id3);
  if (row3.status === "dropped")
    throw new Problem(409, `${goalRef(id3)} \u5DF2\u653E\u5F03\uFF0C\u4E0D\u518D\u5224\u5B9A`, "conflict");
  const allowed3 = canJudge(hasOrg(db) ? nodes(db) : [], row3, actor);
  if (!allowed3.ok) throw new Problem(403, allowed3.reason, "conflict");
  const items = goalItems(db, row3);
  const item = items[n - 1];
  if (!item)
    throw usage7(
      `--item: ${goalRef(id3)} \u53EA\u6709 ${items.length} \u6761\u9A8C\u6536\u6807\u51C6`,
      `atrium goal show ${goalRef(id3)}`
    );
  const blocker = manualBlocker(item);
  if (blocker)
    throw usage7(
      `--item: ${blocker}`,
      `atrium goal check ${goalRef(id3)} --item ${n}`
    );
  const checkId = insertCheck(db, {
    goal_id: id3,
    criterion: item.text,
    kind: "manual",
    result: input.verdict,
    note,
    actor,
    at: now
  });
  return checkView(checkRow(db, checkId));
}

// server/goals/read.ts
var emptyTasks = () => ({
  todo: 0,
  running: 0,
  blocked: 0,
  done: 0,
  failed: 0,
  cancelled: 0
});
function hasTaskGoals(db) {
  return all2(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "goal_id"
  );
}
function checksOf(db) {
  return all2(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='goal_checks'"
  ).length ? latestChecks(db) : /* @__PURE__ */ new Map();
}
function context(db, goals) {
  const list4 = goals ?? allGoals(db);
  const after = /* @__PURE__ */ new Map();
  for (const d of dependencies(db))
    after.set(d.goal_id, [...after.get(d.goal_id) ?? [], d.after_id]);
  const org = /* @__PURE__ */ new Map();
  if (hasOrg(db)) {
    const nodeList = nodes(db);
    for (const n of nodeList)
      org.set(n.id, { name: n.name, path: nodePath(nodeList, n) });
  }
  return {
    byId: new Map(list4.map((g) => [g.id, g])),
    after,
    org,
    checks: checksOf(db)
  };
}
function view5(row3, ctx) {
  const criteria = criteriaOf(row3);
  const after = (ctx.after.get(row3.id) ?? []).flatMap((id3) => {
    const found = ctx.byId.get(id3);
    return found ? [
      {
        ref: goalRef(id3),
        result: found.result,
        status: found.status,
        met: prerequisiteMet(found.status)
      }
    ] : [];
  });
  const items = itemStates(criteria.items, ctx.checks.get(row3.id) ?? []);
  const ready = readiness(row3.status, items, after);
  return {
    ref: goalRef(row3.id),
    parent_ref: row3.parent_id === null ? null : goalRef(row3.parent_id),
    top: row3.parent_id === null,
    result: row3.result,
    criteria: criteria.items,
    ...criteria.broken ? { criteria_broken: true } : {},
    // 每条的最新判定与证据（#313 第 2 步）；ready 为真时提示可标达成，不自动标。
    items: items.map((i) => ({
      n: i.n,
      text: i.text,
      command: i.command,
      latest: i.latest ? checkView(i.latest) : null
    })),
    ready: ready.ready,
    ready_blockers: ready.blockers,
    status: row3.status,
    status_label: STATUS_LABEL[row3.status],
    note: row3.note,
    node_ref: ref(row3.node_id),
    node_name: ctx.org.get(row3.node_id)?.name ?? null,
    node_path: ctx.org.get(row3.node_id)?.path ?? null,
    due: row3.due,
    repo: row3.repo,
    after,
    waiting_for: after.filter((p3) => !p3.met).map((p3) => p3.ref),
    updated_by: row3.updated_by,
    created_at: row3.created_at,
    updated_at: row3.updated_at
  };
}
function goalView(db, row3) {
  return view5(row3, context(db));
}
function taskCounts2(db) {
  const counts = /* @__PURE__ */ new Map();
  if (!hasTaskGoals(db)) return counts;
  for (const row3 of all2(
    db,
    "SELECT goal_id,status,COUNT(*) AS n FROM tasks WHERE goal_id IS NOT NULL GROUP BY goal_id,status LIMIT 12000"
  )) {
    const item = counts.get(row3.goal_id) ?? emptyTasks();
    item[row3.status] = row3.n;
    counts.set(row3.goal_id, item);
  }
  return counts;
}
function goalTree(db, root) {
  const rootId = root === void 0 || root === "" ? null : parseGoalRef(root, "root");
  if (rootId !== null) requireGoal(db, rootId);
  const goals = allGoals(db);
  const ctx = context(db, goals);
  const counts = taskCounts2(db);
  const built = /* @__PURE__ */ new Map();
  for (const row3 of goals)
    built.set(row3.id, {
      ...view5(row3, ctx),
      tasks: counts.get(row3.id) ?? emptyTasks(),
      summary: { running: 0, open: 0, blocked: 0, waiting_for: [] },
      children: []
    });
  const roots = [];
  for (const row3 of goals) {
    const node = built.get(row3.id);
    if (row3.id === rootId || rootId === null && row3.parent_id === null)
      roots.push(node);
    else if (row3.parent_id !== null)
      built.get(row3.parent_id)?.children.push(node);
  }
  for (const root2 of roots) summarize2(root2);
  return { goals: roots };
}
var TASKS_SHOWN = 50;
function goalShow(db, reference) {
  const id3 = parseGoalRef(reference, "\u76EE\u6807");
  const row3 = requireGoal(db, id3);
  const goals = allGoals(db);
  const ctx = context(db, goals);
  const path = [];
  let current2 = row3.parent_id === null ? void 0 : ctx.byId.get(row3.parent_id);
  while (current2 && path.length < goals.length) {
    path.unshift({ ref: goalRef(current2.id), result: current2.result });
    current2 = current2.parent_id === null ? void 0 : ctx.byId.get(current2.parent_id);
  }
  const children = goals.filter((g) => g.parent_id === id3).map((g) => ({
    ref: goalRef(g.id),
    result: g.result,
    status: g.status,
    status_label: STATUS_LABEL[g.status]
  }));
  const needed_by = [...ctx.after.entries()].filter(([, after]) => after.includes(id3)).map(([goal]) => goalRef(goal));
  const tasks = hasTaskGoals(db) ? all2(
    db,
    "SELECT id,title,status,worker,pr_url FROM tasks WHERE goal_id=? ORDER BY status IN ('todo','running','blocked') DESC,id DESC LIMIT ?",
    id3,
    TASKS_SHOWN
  ).map((t) => ({ ref: `t${t.id}`, ...t })) : [];
  return {
    ...view5(row3, ctx),
    path,
    children,
    needed_by,
    task_counts: taskCounts2(db).get(id3) ?? emptyTasks(),
    tasks
  };
}

// server/goals/write.ts
import { statSync as statSync4 } from "node:fs";
import { isAbsolute as isAbsolute6, normalize } from "node:path";
var RESULT_MAX = 200;
var CRITERION_MAX = 500;
var CRITERIA_MAX = 20;
var NOTE_MAX2 = 500;
function resultOf(value) {
  if (typeof value !== "string" || !value.trim())
    throw usage7("\u7ED3\u679C: \u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u7528\u4E00\u53E5\u8BDD\u5199\u8981\u8FBE\u5230\u7684\u72B6\u6001");
  const text6 = value.replace(/\s+/g, " ").trim();
  if (Array.from(text6).length > RESULT_MAX)
    throw usage7(`\u7ED3\u679C: \u4E0D\u80FD\u8D85\u8FC7 ${RESULT_MAX} \u5B57\uFF0C\u4E00\u53E5\u8BDD\u5199\u6E05\u8981\u8FBE\u5230\u7684\u72B6\u6001`);
  return text6;
}
function criteriaOf2(value) {
  if (value === void 0 || value === null) return [];
  const list4 = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list4) || list4.some((item) => typeof item !== "string"))
    throw usage7("--criteria: \u6BCF\u6761\u9A8C\u6536\u6807\u51C6\u5E94\u4E3A\u6587\u672C");
  const items = list4.map((item) => item.trim()).filter(Boolean);
  if (items.length > CRITERIA_MAX)
    throw usage7(`--criteria: \u6700\u591A ${CRITERIA_MAX} \u6761`);
  for (const item of items)
    if (Array.from(item).length > CRITERION_MAX)
      throw usage7(`--criteria: \u6BCF\u6761\u4E0D\u80FD\u8D85\u8FC7 ${CRITERION_MAX} \u5B57`);
  if (new Set(items).size !== items.length)
    throw usage7("--criteria: \u9A8C\u6536\u6807\u51C6\u4E0D\u80FD\u91CD\u590D");
  for (const item of items) {
    const problem = criterionProblem(item);
    if (problem) throw usage7(`--criteria: ${problem}\uFF08\u6536\u5230\uFF1A${item}\uFF09`);
  }
  return items;
}
function repoOf2(value) {
  if (value === void 0 || value === null || value === "") return null;
  if (typeof value !== "string" || !isAbsolute6(value.trim()))
    throw usage7("--repo: \u5E94\u4E3A\u4ED3\u5E93\u7684\u7EDD\u5BF9\u8DEF\u5F84");
  const path = value.trim();
  if (path.split(/[\\/]/).includes("..")) throw usage7("--repo: \u8DEF\u5F84\u4E0D\u80FD\u542B ..");
  let dir = false;
  try {
    dir = statSync4(path).isDirectory();
  } catch {
  }
  if (!dir) throw usage7(`--repo: \u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${path}`);
  return normalize(path).replace(/\/+$/, "") || "/";
}
function dueOf(value) {
  if (value === void 0 || value === null || value === "") return null;
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  const date = match ? /* @__PURE__ */ new Date(`${match[0]}T00:00:00Z`) : null;
  if (!match || !date || date.toISOString().slice(0, 10) !== match[0])
    throw usage7("--due: \u76EE\u6807\u65E5\u671F\u5E94\u4E3A 2026-10-01 \u8FD9\u6837\u7684\u65E5\u671F");
  return match[0];
}
function noteOf(value, field2 = "--note") {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw usage7(`${field2}: \u5E94\u4E3A\u6587\u672C`);
  const text6 = value.trim();
  if (Array.from(text6).length > NOTE_MAX2)
    throw usage7(`${field2}: \u4E0D\u80FD\u8D85\u8FC7 ${NOTE_MAX2} \u5B57`);
  return text6 || null;
}
function afterOf(value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage7("--after: \u7528\u9017\u53F7\u5206\u9694\u76EE\u6807\u77ED\u53F7\uFF0C\u5982 g1,g2");
  const ids = value.split(",").map((part) => parseGoalRef(part, "--after"));
  if (new Set(ids).size !== ids.length)
    throw usage7("--after: \u524D\u7F6E\u91CC\u7A0B\u7891\u4E0D\u80FD\u91CD\u590D");
  return ids;
}
function nodeOf(db, value) {
  if (!hasOrg(db)) throw usage7("--node: \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811", "atrium org import");
  if (typeof value !== "string" || !value.trim())
    throw usage7("--node: \u5E94\u4E3A\u7EC4\u7EC7\u8282\u70B9\uFF0C\u5982 o2 \u6216 atrium/runtime");
  let node;
  try {
    node = nodeByAddress(db, value.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `--node: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree"
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw usage7(`--node: \u8282\u70B9 ${ref(node.id)} ${node.name} \u5DF2\u5F52\u6863`);
  return node;
}
function rootNode(db) {
  const root = hasOrg(db) ? nodes(db).find((n) => n.parent_id === null && n.archived_at === null) : void 0;
  if (!root)
    throw usage7(
      "--node: \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811\uFF0C\u5EFA\u9876\u5C42\u76EE\u6807\u8981\u5148\u6709\u7EC4\u7EC7\u6839\u8282\u70B9",
      "atrium org import"
    );
  return root;
}
function allowed2(permission) {
  if (!permission.ok) throw new Problem(403, permission.reason, "conflict");
}
function setAfter(db, id3, after) {
  for (const other of after) {
    if (other === id3) throw usage7("--after: \u4E0D\u80FD\u628A\u81EA\u5DF1\u8BBE\u4E3A\u524D\u7F6E");
    requireGoal(db, other, "--after");
  }
  const cycle = prerequisiteCycle(dependencies(db), id3, after);
  if (cycle)
    throw usage7(`--after: \u524D\u7F6E\u6210\u73AF\uFF1A${cycle.map(goalRef).join(" \u2192 ")}`);
  db.prepare("DELETE FROM goal_dependencies WHERE goal_id=?").run(id3);
  const insert = db.prepare(
    "INSERT INTO goal_dependencies(goal_id,after_id) VALUES(?,?)"
  );
  for (const other of after) insert.run(id3, other);
}
function checkDepth(goals, parent, height = 1) {
  if (depthOf(goals, parent.id) + height > DEPTH_MAX)
    throw usage7(`--parent: \u76EE\u6807\u6811\u6700\u591A ${DEPTH_MAX} \u5C42`);
}
function addGoal(db, body3, actor, now = Date.now()) {
  const input = objectOf2(body3);
  onlyKeys(input, [
    "result",
    "parent",
    "node",
    "criteria",
    "after",
    "due",
    "status",
    "repo"
  ]);
  const result = resultOf(input.result), criteria = criteriaOf2(input.criteria), due = dueOf(input.due), repo = repoOf2(input.repo), after = afterOf(input.after);
  const status = input.status ?? "planned";
  if (status !== "planned" && status !== "active")
    throw usage7("--status: \u65B0\u5EFA\u65F6\u53EA\u80FD\u662F planned\uFF08\u89C4\u5212\u4E2D\uFF09\u6216 active\uFF08\u8FDB\u884C\u4E2D\uFF09");
  return transaction(db, () => {
    const goals = allGoals(db);
    const parent = input.parent === void 0 || input.parent === null || input.parent === "" ? null : requireGoal(db, parseGoalRef(input.parent, "--parent"), "--parent");
    if (parent?.status === "dropped")
      throw usage7(
        `--parent: ${goalRef(parent.id)} \u5DF2\u653E\u5F03\uFF0C\u5148\u6539\u56DE\u518D\u5F80\u4E0B\u62C6`,
        `atrium goal edit ${goalRef(parent.id)} --status active`
      );
    const node = input.node === void 0 || input.node === null || input.node === "" ? parent ? { id: parent.node_id } : rootNode(db) : nodeOf(db, input.node);
    allowed2(canCreate(nodes(db), parent, node.id, actor));
    if (parent) checkDepth(goals, parent);
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO goals(parent_id,result,criteria,status,node_id,due,repo,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).run(
      parent?.id ?? null,
      result,
      JSON.stringify(criteria),
      status,
      node.id,
      due,
      repo,
      actor,
      now,
      now
    );
    const id3 = Number(lastInsertRowid);
    setAfter(db, id3, after);
    return goalView(db, requireGoal(db, id3));
  });
}
function editGoal(db, reference, body3, actor, now = Date.now()) {
  const id3 = parseGoalRef(reference, "\u76EE\u6807");
  const input = objectOf2(body3);
  const keys = [
    "result",
    "criteria",
    "node",
    "parent",
    "after",
    "due",
    "status",
    "note",
    "repo"
  ];
  onlyKeys(input, keys);
  if (!Object.keys(input).length)
    throw usage7(
      "\u81F3\u5C11\u6539\u4E00\u9879\uFF1A--result\u3001--criteria\u3001--node\u3001--parent\u3001--after\u3001--due\u3001--repo\u3001--status\u3001--note"
    );
  const fields = {};
  if ("result" in input) fields.result = resultOf(input.result);
  if ("criteria" in input)
    fields.criteria = JSON.stringify(criteriaOf2(input.criteria));
  if ("due" in input) fields.due = dueOf(input.due);
  if ("note" in input) fields.note = noteOf(input.note);
  if ("repo" in input) fields.repo = repoOf2(input.repo);
  const after = "after" in input ? afterOf(input.after) : void 0;
  return transaction(db, () => {
    const current2 = requireGoal(db, id3);
    const org = nodes(db);
    allowed2(canChange(org, current2, actor));
    if ("status" in input) {
      const to2 = input.status;
      if (to2 !== "planned" && to2 !== "active" && to2 !== "blocked")
        throw usage7(
          "--status: \u53EA\u80FD\u662F planned\uFF08\u89C4\u5212\u4E2D\uFF09\u3001active\uFF08\u8FDB\u884C\u4E2D\uFF09\u6216 blocked\uFF08\u53D7\u963B\uFF09\uFF1B\u8FBE\u6210\u7528 goal done\uFF0C\u653E\u5F03\u7528 goal drop"
        );
      const verdict2 = transition2(current2.status, { kind: "set", to: to2 });
      if (!verdict2.ok)
        throw new Problem(409, `${goalRef(id3)} ${verdict2.reason}`, "conflict");
      fields.status = verdict2.to;
      if (!("note" in input)) fields.note = null;
    }
    if ("node" in input) {
      const node = nodeOf(db, input.node);
      allowed2(canChange(org, { ...current2, node_id: node.id }, actor));
      fields.node_id = node.id;
    }
    if ("parent" in input) {
      if (current2.parent_id === null)
        throw usage7("--parent: \u9876\u5C42\u76EE\u6807\u4E0D\u80FD\u6302\u5230\u522B\u7684\u76EE\u6807\u4E0B");
      const parent = requireGoal(
        db,
        parseGoalRef(input.parent, "--parent"),
        "--parent"
      );
      const goals = allGoals(db);
      if (isWithin(goals, parent.id, id3))
        throw usage7(
          `--parent: ${goalRef(parent.id)} \u662F ${goalRef(id3)} \u81EA\u5DF1\u6216\u5B83\u7684\u4E0B\u5C42`
        );
      if (parent.status === "dropped")
        throw usage7(`--parent: ${goalRef(parent.id)} \u5DF2\u653E\u5F03`);
      allowed2(
        canCreate(
          org,
          parent,
          fields.node_id ?? current2.node_id,
          actor
        )
      );
      checkDepth(goals, parent, subtreeHeight(goals, id3));
      fields.parent_id = parent.id;
    }
    const changed2 = Object.entries(fields).filter(
      ([key, value]) => current2[key] !== value
    );
    if (after !== void 0) setAfter(db, id3, after);
    if (changed2.length || after !== void 0)
      db.prepare(
        `UPDATE goals SET ${changed2.map(([key]) => `${key}=?,`).join("")}updated_by=?,updated_at=? WHERE id=?`
      ).run(...changed2.map(([, value]) => value), actor, now, id3);
    return {
      ...goalView(db, requireGoal(db, id3)),
      changed: [
        ...changed2.map(
          ([key]) => key === "node_id" ? "node" : key === "parent_id" ? "parent" : key
        ),
        ...after === void 0 ? [] : ["after"]
      ]
    };
  });
}
function settleGoal(db, reference, action, body3, actor, now = Date.now()) {
  const id3 = parseGoalRef(reference, "\u76EE\u6807");
  const input = objectOf2(body3 ?? {});
  onlyKeys(input, ["note"]);
  const note = noteOf(
    input.note,
    action.kind === "drop" ? "--reason" : "--note"
  );
  if (action.kind === "drop" && !note) throw usage7("--reason: \u653E\u5F03\u8981\u5199\u539F\u56E0");
  return transaction(db, () => {
    const current2 = requireGoal(db, id3);
    allowed2(canChange(nodes(db), current2, actor));
    const verdict2 = transition2(current2.status, action);
    if (!verdict2.ok)
      throw new Problem(409, `${goalRef(id3)} ${verdict2.reason}`, "conflict");
    if (action.kind === "done") {
      const prerequisites = db.prepare(
        "SELECT g.id,g.status FROM goal_dependencies d JOIN goals g ON g.id=d.after_id WHERE d.goal_id=? ORDER BY g.id"
      ).all(id3);
      const unmet = unmetPrerequisites(prerequisites);
      if (unmet.length)
        throw new Problem(
          409,
          `${goalRef(id3)} \u7684\u524D\u7F6E\u8FD8\u6CA1\u8FBE\u6210\uFF1A${unmet.map((p3) => `${goalRef(p3.id)}\uFF08${STATUS_LABEL[p3.status]}\uFF09`).join("\u3001")}`,
          "conflict",
          void 0,
          `atrium goal show ${goalRef(id3)}`
        );
    } else {
      const open6 = db.prepare(
        "SELECT id FROM goals WHERE parent_id=? AND status NOT IN ('achieved','dropped') ORDER BY id LIMIT 20"
      ).all(id3);
      if (open6.length)
        throw new Problem(
          409,
          `${goalRef(id3)} \u4E0B\u8FD8\u6709\u6CA1\u6536\u5C3E\u7684\u91CC\u7A0B\u7891\uFF1A${open6.map((g) => goalRef(g.id)).join("\u3001")}\uFF1B\u5148\u8FBE\u6210\u6216\u653E\u5F03\u5B83\u4EEC`,
          "conflict",
          void 0,
          `atrium goal tree ${goalRef(id3)}`
        );
      const tasks = !hasTaskGoals(db) ? [] : db.prepare(
        "SELECT id FROM tasks WHERE goal_id=? AND status IN ('todo','running','blocked') ORDER BY id LIMIT 20"
      ).all(id3);
      if (tasks.length)
        throw new Problem(
          409,
          `${goalRef(id3)} \u4E0A\u8FD8\u6302\u7740\u6CA1\u7ED3\u7684\u4EFB\u52A1\uFF1A${tasks.map((t) => `t${t.id}`).join("\u3001")}\uFF1B\u5148\u6536\u5C3E\u6216\u6539\u6302\u522B\u7684\u91CC\u7A0B\u7891`,
          "conflict",
          void 0,
          `atrium goal show ${goalRef(id3)}`
        );
    }
    db.prepare(
      "UPDATE goals SET status=?,note=?,updated_by=?,updated_at=? WHERE id=?"
    ).run(verdict2.to, note, actor, now, id3);
    return goalView(db, requireGoal(db, id3));
  });
}

// server/goals/adopt.ts
var CHILDREN_MAX = 500;
function adoptTask(db, body3, actor, now = Date.now()) {
  const input = objectOf2(body3);
  onlyKeys(input, ["task", "parent", "node", "apply"]);
  const apply = input.apply === true;
  if (!hasTaskGoals(db)) throw usage7("\u4EFB\u52A1\u8D26\u672C\u8FD8\u6CA1\u51C6\u5907\u597D");
  const run3 = () => {
    const task = requireRow(db, parseTaskRef(input.task, "task"));
    if (input.parent === void 0 || input.parent === "")
      throw usage7(
        "--parent: \u8981\u6307\u5B9A\u6302\u5230\u54EA\u4E2A\u76EE\u6807\u6216\u91CC\u7A0B\u7891\u4E0B\uFF0C\u5982 g1",
        "atrium goal tree"
      );
    const parent = requireGoal(
      db,
      parseGoalRef(input.parent, "--parent"),
      "--parent"
    );
    if (parent.status === "dropped")
      throw usage7(`--parent: ${goalRef(parent.id)} \u5DF2\u653E\u5F03`);
    const children = all(
      db,
      "SELECT id,status,goal_id FROM tasks WHERE parent_id=? ORDER BY id LIMIT ?",
      task.id,
      CHILDREN_MAX + 1
    );
    if (children.length > CHILDREN_MAX)
      throw usage7(
        `${taskRef(task.id)} \u7684\u5B50\u4EFB\u52A1\u8D85\u8FC7 ${CHILDREN_MAX} \u4E2A\uFF0C\u5148\u624B\u5DE5\u62C6\u5F00`
      );
    const blocker = adoptBlocker({ ...task, children: children.length });
    if (blocker)
      throw new Problem(
        409,
        `${taskRef(task.id)} \u4E0D\u80FD\u8FC1\u4E3A\u91CC\u7A0B\u7891\uFF1A${blocker}`,
        "conflict",
        void 0,
        `atrium task show ${taskRef(task.id)}`
      );
    let nodeId = task.node_id ?? parent.node_id;
    if (typeof input.node === "string" && input.node.trim()) {
      try {
        nodeId = nodeByAddress(db, input.node.trim()).id;
      } catch (error) {
        if (error instanceof Problem)
          throw usage7(`--node: ${error.message}`, "atrium org tree");
        throw error;
      }
    }
    const permission = canCreate(nodes(db), parent, nodeId, actor);
    if (!permission.ok) throw new Problem(403, permission.reason, "conflict");
    if (depthOf(allGoals(db), parent.id) + 1 > DEPTH_MAX)
      throw usage7(`--parent: \u76EE\u6807\u6811\u6700\u591A ${DEPTH_MAX} \u5C42`);
    const status = adoptedStatus(
      task.status,
      children.map((c) => c.status)
    );
    const attach = children.filter((c) => c.goal_id === null);
    const keep = children.filter((c) => c.goal_id !== null);
    const cancel = !["done", "cancelled"].includes(task.status);
    const plan2 = {
      preview: !apply,
      task: taskRef(task.id),
      goal: {
        ref: null,
        result: task.title,
        parent: goalRef(parent.id),
        node: ref(nodeId),
        status,
        status_label: STATUS_LABEL[status]
      },
      attach: attach.map((c) => taskRef(c.id)),
      keep: keep.map((c) => ({
        task: taskRef(c.id),
        goal: goalRef(c.goal_id)
      })),
      parent_task: cancel ? "cancel" : "keep"
    };
    if (!apply) return plan2;
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO goals(parent_id,result,criteria,status,note,node_id,updated_by,created_at,updated_at) VALUES(?,?,'[]',?,?,?,?,?,?)"
    ).run(
      parent.id,
      task.title,
      status,
      `\u7531\u7236\u4EFB\u52A1 ${taskRef(task.id)} \u8FC1\u6765`,
      nodeId,
      actor,
      now,
      now
    );
    const goal = Number(lastInsertRowid);
    const detail2 = { goal: goalRef(goal), from: taskRef(task.id) };
    const move = db.prepare(
      "UPDATE tasks SET parent_id=?,goal_id=COALESCE(goal_id,?),updated_at=? WHERE id=?"
    );
    for (const child of children) {
      move.run(task.parent_id, goal, now, child.id);
      addEvent(db, child.id, now, "goal_adopt", detail2);
    }
    db.prepare("UPDATE tasks SET goal_id=?,updated_at=? WHERE id=?").run(
      goal,
      now,
      task.id
    );
    addEvent(db, task.id, now, "goal_adopt", detail2);
    if (cancel)
      applyTransition(
        db,
        requireRow(db, task.id),
        { kind: "cancel" },
        now,
        {},
        detail2
      );
    return { ...plan2, goal: { ...plan2.goal, ref: goalRef(goal) } };
  };
  return apply ? transaction(db, run3) : run3();
}

// server/goals/check-runtime.ts
import { spawn as spawn3 } from "node:child_process";
import {
  closeSync as closeSync5,
  fstatSync as fstatSync2,
  mkdirSync as mkdirSync11,
  openSync as openSync5,
  readSync as readSync2,
  rmSync as rmSync2,
  writeSync
} from "node:fs";
import { join as join22 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var GOAL_CHECK_TIMEOUT_MS = 15 * 6e4;
var firstLine2 = (text6) => text6.trim().split("\n")[0] ?? "";
function logTail3(file, from = 0) {
  try {
    const fd = openSync5(file, "r");
    try {
      const size = fstatSync2(fd).size;
      const length = Math.max(0, Math.min(size - from, 64 * 1024));
      const buffer = Buffer.alloc(length);
      readSync2(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync5(fd);
    }
  } catch {
    return "";
  }
}
var GoalChecker = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
    try {
      sweepInterrupted(db, alive);
    } catch (error) {
      console.error(`\u76EE\u6807\u5224\u5B9A\uFF1A\u6E05\u7406\u4E2D\u65AD\u7684\u68C0\u67E5\u5931\u8D25\uFF1A${String(error)}`);
    }
  }
  db;
  options;
  queue = new LocalCheckQueue();
  children = /* @__PURE__ */ new Map();
  closed = false;
  /** 跑命令条目：给 item 只跑那一条，否则跑全部命令条目；同一条正在跑就沿用，不重复起。 */
  start(reference, item, actor, now = Date.now()) {
    const id3 = parseGoalRef(reference, "\u76EE\u6807");
    const goal = requireGoal(this.db, id3);
    if (goal.status === "dropped")
      throw new Problem(409, `${goalRef(id3)} \u5DF2\u653E\u5F03\uFF0C\u4E0D\u518D\u5224\u5B9A`, "conflict");
    const items = goalItems(this.db, goal);
    let targets;
    if (item === void 0 || item === null) {
      targets = items.filter((i) => i.command);
      if (!targets.length)
        throw usage7(
          `${goalRef(id3)} \u6CA1\u6709\u547D\u4EE4\u6761\u76EE\uFF08\u4EE5 $ \u5F00\u5934\uFF09\uFF1B\u4EBA\u5DE5\u5224\u7528 --item N --pass|--fail --note \u8BC1\u636E`,
          `atrium goal show ${goalRef(id3)}`
        );
    } else {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 1)
        throw usage7("--item: \u5E94\u4E3A\u6B63\u6574\u6570\uFF0C\u5982 --item 2");
      const found = items[item - 1];
      if (!found)
        throw usage7(
          `--item: ${goalRef(id3)} \u53EA\u6709 ${items.length} \u6761\u9A8C\u6536\u6807\u51C6`,
          `atrium goal show ${goalRef(id3)}`
        );
      if (!found.command)
        throw usage7(
          `--item: \u7B2C ${item} \u6761\u4E0D\u662F\u547D\u4EE4\uFF0C\u8981\u4EBA\u5DE5\u5224\uFF1A\u52A0 --pass \u6216 --fail \u548C --note \u8BC1\u636E`,
          `atrium goal check ${goalRef(id3)} --item ${item} --pass --note \u8BC1\u636E`
        );
      targets = [found];
    }
    const started = [];
    for (const target of targets) {
      const running = target.latest?.result === "running" ? target.latest : null;
      if (running) {
        started.push(running);
        continue;
      }
      const checkId = insertCheck(this.db, {
        goal_id: id3,
        criterion: target.text,
        kind: "command",
        result: "running",
        owner: process.pid,
        actor,
        at: now
      });
      started.push(checkRow(this.db, checkId));
      void this.execute(checkId, id3, target.command, goal.repo);
    }
    return { goal: goalRef(id3), checks: started.map(checkView) };
  }
  /** 等这些判定跑完（服务端长轮询）；按库轮询，跨平滑重启的新旧服务都看得到。 */
  async wait(reference, ids, seconds, signal) {
    const id3 = parseGoalRef(reference, "\u76EE\u6807");
    requireGoal(this.db, id3);
    const list4 = typeof ids === "string" && ids ? ids.split(",").map((part) => Number(part)) : [];
    if (!list4.length || list4.length > 20 || list4.some((n) => !Number.isSafeInteger(n) || n < 1))
      throw usage7("ids: \u5224\u5B9A\u7F16\u53F7\u7528\u9017\u53F7\u5206\u9694\uFF0C\u6700\u591A 20 \u4E2A");
    const deadline = Date.now() + seconds * 1e3;
    const read = () => all2(
      this.db,
      `SELECT * FROM goal_checks WHERE goal_id=? AND id IN (${list4.map(() => "?").join(",")}) ORDER BY id`,
      id3,
      ...list4
    );
    for (; ; ) {
      if (this.closed) return { checks: [], timed_out: true, restarting: true };
      const rows = read();
      const pending = rows.some((r) => r.result === "running");
      if (!pending || Date.now() >= deadline || signal?.aborted)
        return { checks: rows.map(checkView), timed_out: pending };
      await delay(Math.min(300, Math.max(1, deadline - Date.now())));
    }
  }
  /** 服务关闭：杀掉在跑的检查进程组，判为没跑成（下一个服务不会接着跑）。 */
  close() {
    this.closed = true;
    for (const [checkId, child] of this.children) {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      try {
        finishCheck(this.db, checkId, {
          result: "error",
          exit_code: null,
          summary: "\u670D\u52A1\u505C\u6B62\uFF0C\u68C0\u67E5\u4E2D\u65AD\uFF1B\u91CD\u8DD1 atrium goal check",
          log: null
        });
      } catch {
      }
    }
    this.children.clear();
  }
  async execute(checkId, goalId, command, repo) {
    const base2 = join22(this.options.data, "goals", goalRef(goalId));
    const log = join22(base2, `check-${checkId}.log`);
    const work = join22(base2, `work-${checkId}`);
    try {
      await this.queue.run(async () => {
        if (this.closed) return;
        mkdirSync11(base2, { recursive: true, mode: 448 });
        const fd = openSync5(log, "w", 384);
        let prepared = null;
        let outcome;
        const from = writeSync(fd, `$ ${command}
`);
        try {
          prepared = await this.prepare(work, repo, fd);
          const runOutcome = await this.spawn(checkId, command, work, fd);
          closeSync5(fd);
          const output = summarize3(logTail3(log, from));
          outcome = {
            ...runOutcome,
            summary: runOutcome.result === "timeout" || !output ? [output, runOutcome.detail].filter(Boolean).join("\n") : output,
            log
          };
        } catch (error) {
          try {
            closeSync5(fd);
          } catch {
          }
          const message4 = error instanceof Error ? error.message : String(error);
          outcome = {
            result: "error",
            exit_code: null,
            summary: summarize3(message4),
            log
          };
        } finally {
          await prepared?.cleanup().catch(() => void 0);
          rmSync2(work, { recursive: true, force: true });
        }
        finishCheck(this.db, checkId, outcome);
      });
    } catch (error) {
      if (this.closed) return;
      console.error(`\u76EE\u6807\u5224\u5B9A ${checkId} \u5931\u8D25\uFF1A${String(error)}`);
    }
  }
  /** 隔离环境：有仓库就从 origin 默认分支（没有 origin 用 HEAD）检出只读用途的临时 worktree。 */
  async prepare(work, repo, fd) {
    rmSync2(work, { recursive: true, force: true });
    if (!repo) {
      mkdirSync11(work, { recursive: true, mode: 448 });
      writeSync(fd, `# \u5728\u7A7A\u7684\u4E34\u65F6\u76EE\u5F55\u91CC\u6267\u884C\uFF08\u91CC\u7A0B\u7891\u6CA1\u586B --repo\uFF09
`);
      return { cleanup: async () => void 0 };
    }
    const run3 = this.options.run ?? exec;
    const top = await run3("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      timeoutMs: 1e4
    });
    if (!top.ok)
      throw new Error(`${repo} \u4E0D\u662F git \u4ED3\u5E93\uFF1A${firstLine2(top.stderr)}`);
    let ref2 = "HEAD";
    const branch = await defaultBranch(repo, run3).catch(() => null);
    if (branch) {
      const fetched = await run3(
        "git",
        ["-C", repo, "fetch", "origin", branch],
        {
          timeoutMs: 12e4
        }
      );
      if (!fetched.ok)
        throw new Error(
          `\u62C9\u53D6 origin/${branch} \u5931\u8D25\uFF1A${firstLine2(fetched.stderr)}`
        );
      ref2 = `origin/${branch}`;
    }
    const added = await run3(
      "git",
      ["-C", repo, "worktree", "add", "--detach", work, ref2],
      { timeoutMs: 6e4 }
    );
    if (!added.ok)
      throw new Error(`\u5EFA\u4E34\u65F6\u5DE5\u4F5C\u6811\u5931\u8D25\uFF1A${firstLine2(added.stderr)}`);
    const head2 = await run3(
      "git",
      ["-C", work, "rev-parse", "--short", "HEAD"],
      {
        timeoutMs: 1e4
      }
    );
    writeSync(fd, `# ${repo} @ ${ref2} ${head2.stdout.trim()}\uFF08\u4E34\u65F6\u5DE5\u4F5C\u6811\uFF09
`);
    return {
      cleanup: async () => {
        await run3("git", ["-C", repo, "worktree", "remove", "--force", work], {
          timeoutMs: 6e4
        });
        await run3("git", ["-C", repo, "worktree", "prune"], {
          timeoutMs: 3e4
        });
      }
    };
  }
  spawn(checkId, command, cwd, fd) {
    const timeoutMs = this.options.timeoutMs ?? GOAL_CHECK_TIMEOUT_MS;
    const child = spawn3("/bin/sh", ["-c", command], {
      cwd,
      env: workerEnvironment(this.options.env),
      detached: true,
      stdio: ["ignore", fd, fd]
    });
    this.children.set(checkId, child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
        }
    }, timeoutMs);
    return new Promise((resolve4) => {
      const finish = (code, error) => {
        clearTimeout(timer);
        this.children.delete(checkId);
        const result = commandResult({ code, timedOut, error: error?.message });
        resolve4({
          result,
          exit_code: code,
          detail: timedOut ? `\u8D85\u8FC7 ${Math.ceil(timeoutMs / 1e3)} \u79D2` : error?.message ?? `\u9000\u51FA\u7801 ${code}`
        });
      };
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
    });
  }
};

// server/goals/migrate.ts
import { mkdirSync as mkdirSync12 } from "node:fs";
import { join as join23 } from "node:path";

// server/goals/migrate-rules.ts
var RESULT_LABEL = {
  running: "\u672A\u5224\u5B8C",
  pass: "\u901A\u8FC7",
  fail: "\u4E0D\u901A\u8FC7",
  timeout: "\u8D85\u65F6",
  error: "\u51FA\u9519"
};
var day = (at) => new Date(at).toISOString().slice(0, 10);
var cut2 = (text6, max) => Array.from(text6).length > max ? `${Array.from(text6).slice(0, max - 1).join("")}\u2026` : text6;
function evidenceOf(goal, checks) {
  const lines2 = [];
  if (goal.note?.trim()) lines2.push(cut2(goal.note.trim(), 1e3));
  goal.criteria.forEach((criterion, i) => {
    const check2 = checks.find(
      (c) => c.goal_id === goal.id && c.criterion === criterion
    );
    if (!check2) return;
    const how = check2.kind === "command" ? `\u547D\u4EE4${check2.exit_code === null ? "" : `\uFF0C\u9000\u51FA\u7801 ${check2.exit_code}`}` : "\u4EBA\u5DE5";
    lines2.push(
      cut2(
        `\u7B2C ${i + 1} \u6761${RESULT_LABEL[check2.result]}\uFF08${how}\uFF0C${check2.actor}\uFF0C${day(check2.started_at)}\uFF09${check2.note?.trim() ? `\uFF1A${check2.note.trim()}` : ""}`,
        1e3
      )
    );
  });
  return lines2.slice(0, 20);
}
function stageOf(goal, after, checks) {
  const evidence = evidenceOf(goal, checks);
  return {
    id: `g${goal.id}`,
    result: cut2(goal.result, 300),
    status: goal.status,
    ...goal.criteria.length ? { criteria: goal.criteria.slice(0, 20) } : {},
    ...evidence.length ? { evidence } : {},
    ...goal.due ? { due: goal.due } : {},
    ...after.length ? { after: after.map((id3) => `g${id3}`) } : {},
    ...goal.parent_id !== null ? { parent: `g${goal.parent_id}` } : {},
    ...goal.repo ? { repo: goal.repo } : {}
  };
}
function planMigration(input) {
  const byNode = /* @__PURE__ */ new Map();
  const orphans = [];
  for (const goal of [...input.goals].sort((a, b) => a.id - b.id)) {
    const node = input.nodes.find((n) => n.id === goal.node_id);
    if (!node) {
      orphans.push({ goal: goal.id, node: goal.node_id });
      continue;
    }
    const plan2 = byNode.get(node.id) ?? {
      node: node.id,
      name: node.name,
      path: node.path,
      stages: [],
      kept: []
    };
    byNode.set(node.id, plan2);
    const id3 = `g${goal.id}`;
    if (node.stages.includes(id3)) {
      plan2.kept.push(id3);
      continue;
    }
    const after = input.dependencies.filter((d) => d.goal_id === goal.id).map((d) => d.after_id).sort((a, b) => a - b);
    plan2.stages.push(stageOf(goal, after, input.checks));
  }
  const tasks = [];
  const kept = [];
  for (const task of [...input.tasks].sort((a, b) => a.id - b.id)) {
    const goal = input.goals.find((g) => g.id === task.goal_id);
    if (!goal || !input.nodes.some((n) => n.id === goal.node_id)) continue;
    if (task.part_id !== null)
      kept.push({ task: task.id, goal: goal.id, part: task.part_id });
    else tasks.push({ task: task.id, goal: goal.id, part: goal.node_id });
  }
  return {
    nodes: [...byNode.values()].sort((a, b) => a.node - b.node),
    tasks,
    tasks_kept: kept,
    orphans
  };
}

// server/goals/migrate.ts
function goalsRetired(db) {
  if (!one2(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_retirement'"
  ))
    return void 0;
  return one2(
    db,
    "SELECT at,actor,backup FROM goal_retirement WHERE id=1"
  );
}
function retiredProblem(db, goal) {
  const id3 = goal && /^g([1-9][0-9]{0,15})$/.exec(goal.trim())?.[1];
  const mapped = id3 ? one2(
    db,
    "SELECT m.node_id,n.name FROM goal_migrations m JOIN org_nodes n ON n.id=m.node_id WHERE m.goal_id=?",
    Number(id3)
  ) : void 0;
  const next = mapped ? `atrium org show ${ref(mapped.node_id)}` : "atrium org tree";
  return new Problem(
    410,
    `\u76EE\u6807\u6811\u5DF2\u8FC1\u4E3A\u7EC4\u7EC7\u8282\u70B9\u7684\u9636\u6BB5\u8BB0\u5F55\uFF0Cgoal \u547D\u4EE4\u5DF2\u4E0B\u7EBF${mapped ? `\uFF1Bg${id3} \u5728 ${ref(mapped.node_id)} ${mapped.name}` : ""}\u3002\u770B\u9636\u6BB5\uFF1A${next}\uFF1B\u6539\u9636\u6BB5\uFF1Aatrium org edit \u8282\u70B9 --charter \u6587\u4EF6\uFF1B\u4EFB\u52A1\u5F52\u5C5E\u6539\u7528 --part \u8282\u70B9`,
    "conflict",
    void 0,
    next
  );
}
function plan(db) {
  const list4 = hasOrg(db) ? nodes(db) : [];
  const goals = allGoals(db);
  const checks = all2(
    db,
    "SELECT goal_id,criterion,kind,result,exit_code,note,actor,started_at FROM goal_checks WHERE id IN (SELECT MAX(id) FROM goal_checks GROUP BY goal_id,criterion) ORDER BY id LIMIT 40000"
  );
  return planMigration({
    goals: goals.map((g) => ({ ...g, criteria: criteriaOf(g).items })),
    dependencies: dependencies(db),
    checks,
    nodes: list4.map((n) => {
      const stages = charterFields2(db, n.id).stages;
      return {
        id: n.id,
        name: n.name,
        path: nodePath(list4, n),
        stages: Array.isArray(stages) ? stages.map((s) => s?.id).filter((s) => typeof s === "string") : []
      };
    }),
    tasks: hasTaskGoals(db) ? all2(
      db,
      "SELECT id,goal_id,part_id FROM tasks WHERE goal_id IS NOT NULL ORDER BY id LIMIT 5000"
    ) : []
  });
}
function view6(db, found) {
  const name2 = (id3) => one2(db, "SELECT name FROM org_nodes WHERE id=?", id3)?.name ?? "";
  const stage = (s) => ({
    id: s.id,
    result: s.result,
    status: s.status,
    status_label: STAGE_LABEL2[s.status],
    criteria: s.criteria?.length ?? 0,
    evidence: s.evidence?.length ?? 0
  });
  const task = (t) => ({
    task: `t${t.task}`,
    goal: goalRef(t.goal),
    part: ref(t.part),
    part_name: name2(t.part)
  });
  return {
    nodes: found.nodes.map((n) => ({
      node: ref(n.node),
      name: n.name,
      path: n.path,
      stages: n.stages.map(stage),
      kept: n.kept
    })),
    tasks: found.tasks.map(task),
    tasks_kept: found.tasks_kept.map(task),
    orphans: found.orphans.map((o) => ({
      goal: goalRef(o.goal),
      node: ref(o.node)
    })),
    stages: found.nodes.reduce((sum, n) => sum + n.stages.length, 0)
  };
}
function migrateGoals(db, options) {
  const retired = goalsRetired(db);
  const preview = plan(db);
  if (!options.apply)
    return { preview: true, retired: !!retired, ...view6(db, preview) };
  if (options.actor !== "u1")
    throw new Problem(403, "org migrate-goals --apply \u53EA\u6709\u4F60\u80FD\u6267\u884C");
  if (preview.orphans.length)
    throw new Problem(
      409,
      `\u8FD9\u4E9B\u76EE\u6807\u7684\u8D1F\u8D23\u8282\u70B9\u4E0D\u5728\u7EC4\u7EC7\u6811\u91CC\uFF0C\u5148\u6539\u5230\u73B0\u6709\u8282\u70B9\u518D\u8FC1\uFF1A${preview.orphans.map((o) => `${goalRef(o.goal)}\uFF08${ref(o.node)}\uFF09`).join("\u3001")}`,
      "conflict",
      void 0,
      `atrium goal edit ${goalRef(preview.orphans[0].goal)} --node \u8282\u70B9`
    );
  const pending = preview.tasks.length || preview.nodes.some((n) => n.stages.length);
  if (retired && !pending)
    return {
      preview: false,
      retired: true,
      backup: retired.backup,
      ...view6(db, preview)
    };
  const now = options.now ?? Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backup = join23(
    options.data,
    "backups",
    `before-goal-migration-${stamp}.sqlite`
  );
  mkdirSync12(join23(options.data, "backups"), { recursive: true, mode: 448 });
  db.prepare("VACUUM INTO ?").run(backup);
  return transaction(db, () => {
    const found = plan(db);
    for (const node of found.nodes) {
      if (!node.stages.length) continue;
      const fields = charterFields2(db, node.node);
      const existing = Array.isArray(fields.stages) ? fields.stages : [];
      writeCharterFields(
        db,
        node.node,
        { ...fields, stages: [...existing, ...node.stages] },
        `\u76EE\u6807\u6811\u8FC1\u4E3A\u9636\u6BB5\u8BB0\u5F55\uFF08#322\uFF09\uFF1A${node.stages.map((s) => s.id).join("\u3001")}`,
        options.actor
      );
    }
    for (const task of found.tasks) {
      db.prepare(
        "UPDATE tasks SET part_id=?,updated_at=? WHERE id=? AND part_id IS NULL"
      ).run(task.part, now, task.task);
      addEvent(db, task.task, now, "edited", {
        part_id: task.part,
        from_goal: goalRef(task.goal)
      });
    }
    for (const goal of allGoals(db))
      db.prepare(
        "INSERT OR IGNORE INTO goal_migrations(goal_id,node_id,at) VALUES(?,?,?)"
      ).run(goal.id, goal.node_id, now);
    db.prepare(
      "INSERT OR IGNORE INTO goal_retirement(id,at,actor,backup) VALUES(1,?,?,?)"
    ).run(now, options.actor, backup);
    return { preview: false, retired: true, backup, ...view6(db, found) };
  });
}

// server/goals/routes.ts
var q2 = (value) => value ?? {};
var p2 = (value) => value ?? {};
function registerGoalRoutes(app2, db, checks) {
  ensureGoalTables(db);
  const checker = new GoalChecker(db, checks);
  app2.addHook("onClose", async () => checker.close());
  const actor = (query2) => resolveActor(db, q2(query2).as);
  const live = (id3) => {
    if (goalsRetired(db))
      throw retiredProblem(db, typeof id3 === "string" ? id3 : void 0);
  };
  app2.addHook("preHandler", async (request2) => {
    const url = request2.routeOptions.url;
    if (!url?.startsWith("/api/goals") || url === "/api/goals/migrate") return;
    live(request2.params?.id);
  });
  app2.post(
    "/api/goals/migrate",
    { bodyLimit: 1024 },
    (request2) => migrateGoals(db, {
      apply: objectOf2(request2.body ?? {}).apply === true,
      actor: actor(request2.query),
      data: checks.data
    })
  );
  app2.get("/api/goals/tree", (request2) => goalTree(db, q2(request2.query).root));
  app2.get("/api/goals/:id", (request2) => goalShow(db, p2(request2.params).id));
  app2.post(
    "/api/goals",
    { bodyLimit: 64 * 1024 },
    (request2, reply) => reply.code(201).send(addGoal(db, request2.body, actor(request2.query)))
  );
  app2.patch(
    "/api/goals/:id",
    { bodyLimit: 64 * 1024 },
    (request2) => editGoal(db, p2(request2.params).id, request2.body, actor(request2.query))
  );
  app2.post(
    "/api/goals/:id/done",
    { bodyLimit: 8 * 1024 },
    (request2) => settleGoal(
      db,
      p2(request2.params).id,
      { kind: "done" },
      request2.body,
      actor(request2.query)
    )
  );
  app2.post(
    "/api/goals/:id/drop",
    { bodyLimit: 8 * 1024 },
    (request2) => settleGoal(
      db,
      p2(request2.params).id,
      { kind: "drop" },
      request2.body,
      actor(request2.query)
    )
  );
  app2.post("/api/goals/:id/check", { bodyLimit: 8 * 1024 }, (request2) => {
    const body3 = objectOf2(request2.body ?? {});
    const who2 = actor(request2.query);
    if (body3.verdict !== void 0)
      return { checks: [judgeItem(db, p2(request2.params).id, body3, who2)] };
    const extra = Object.keys(body3).filter((key) => key !== "item");
    if (extra.length)
      throw new Problem(400, `\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5\uFF1A${extra.join("\u3001")}`, "usage");
    return checker.start(p2(request2.params).id, body3.item, who2);
  });
  app2.get("/api/goals/:id/check-wait", (request2) => {
    const query2 = q2(request2.query);
    const seconds = Number(query2.timeout ?? 0);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 240)
      throw new Problem(400, "timeout: \u5E94\u4E3A 0\uFF5E240 \u7684\u6574\u6570\u79D2", "usage");
    const abort = new AbortController();
    request2.raw.once("close", () => abort.abort());
    return checker.wait(p2(request2.params).id, query2.ids, seconds, abort.signal);
  });
  app2.post(
    "/api/goals/adopt",
    { bodyLimit: 4 * 1024 },
    (request2) => adoptTask(db, request2.body, actor(request2.query))
  );
}

// server/skills/schema.ts
function ensureSkillTables(db) {
  ensureOrgTables(db);
  db.exec(`CREATE TABLE IF NOT EXISTS org_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
    owner_node_id INTEGER REFERENCES org_nodes(id),
    rev INTEGER NOT NULL, files TEXT NOT NULL,
    archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS org_skill_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES org_skills(id),
    rev INTEGER NOT NULL, author TEXT NOT NULL, reviewer TEXT, at INTEGER NOT NULL,
    reason TEXT NOT NULL, source TEXT, snapshot TEXT NOT NULL,
    UNIQUE(skill_id,rev));
  CREATE TABLE IF NOT EXISTS org_skill_bindings (
    skill_id INTEGER NOT NULL REFERENCES org_skills(id),
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(skill_id,node_id));
  CREATE INDEX IF NOT EXISTS org_skill_bindings_node ON org_skill_bindings(node_id);
  CREATE TABLE IF NOT EXISTS org_skill_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES org_skills(id),
    task_id INTEGER NOT NULL, base_rev INTEGER NOT NULL,
    files TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    created_at INTEGER NOT NULL,
    decided_by TEXT, decided_at INTEGER, decision_reason TEXT, result_rev INTEGER);
  CREATE INDEX IF NOT EXISTS org_skill_proposals_status ON org_skill_proposals(status,id);
  CREATE INDEX IF NOT EXISTS org_skill_proposals_task ON org_skill_proposals(task_id,skill_id);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS org_skill_revisions_no_update
    BEFORE UPDATE ON org_skill_revisions BEGIN SELECT RAISE(ABORT,'org_skill_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_skill_revisions_no_delete
    BEFORE DELETE ON org_skill_revisions BEGIN SELECT RAISE(ABORT,'org_skill_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_skills_no_delete
    BEFORE DELETE ON org_skills BEGIN SELECT RAISE(ABORT,'org_skills archive only'); END;`);
}

// server/skills/routes.ts
var q3 = (value) => value ?? {};
var params2 = (value) => value ?? {};
var body2 = (value) => value ?? {};
var FILES_BODY = 1024 * 1024;
function registerSkillRoutes(app2, db) {
  ensureSkillTables(db);
  const actor = (query2) => resolveActor(db, q3(query2).as);
  app2.get(
    "/api/skills",
    (request2) => listSkills(db, q3(request2.query).archived === "1")
  );
  app2.get(
    "/api/skills/:slug",
    (request2) => showSkill(db, params2(request2.params).slug)
  );
  app2.get("/api/skills/:slug/history", (request2) => {
    const query2 = q3(request2.query);
    return skillHistory(db, params2(request2.params).slug, {
      rev: query2.rev,
      before: query2.before,
      limit: query2.limit === void 0 ? void 0 : Number(query2.limit)
    });
  });
  app2.post(
    "/api/skills",
    { bodyLimit: FILES_BODY },
    (request2, reply) => reply.code(201).send(
      addSkill(db, body2(request2.body), actor(request2.query))
    )
  );
  app2.put(
    "/api/skills/:slug",
    { bodyLimit: FILES_BODY },
    (request2) => editSkill(
      db,
      params2(request2.params).slug,
      body2(request2.body),
      actor(request2.query)
    )
  );
  app2.post("/api/skills/:slug/revert", { bodyLimit: 8 * 1024 }, (request2) => {
    const input = body2(request2.body);
    return revertSkill(
      db,
      params2(request2.params).slug,
      input.to,
      input.reason,
      actor(request2.query)
    );
  });
  app2.post(
    "/api/skills/:slug/bind",
    { bodyLimit: 8 * 1024 },
    (request2) => bindSkill(
      db,
      params2(request2.params).slug,
      String(body2(request2.body).node ?? ""),
      actor(request2.query)
    )
  );
  app2.post(
    "/api/skills/:slug/unbind",
    { bodyLimit: 8 * 1024 },
    (request2) => bindSkill(
      db,
      params2(request2.params).slug,
      String(body2(request2.body).node ?? ""),
      actor(request2.query),
      true
    )
  );
  app2.get("/api/skill-proposals", (request2) => {
    const query2 = q3(request2.query);
    return listProposals(db, {
      status: query2.status,
      limit: query2.limit === void 0 ? void 0 : Number(query2.limit)
    });
  });
  app2.get(
    "/api/skill-proposals/:id",
    (request2) => showProposal(db, params2(request2.params).id)
  );
  app2.post(
    "/api/skill-proposals/:id/accept",
    { bodyLimit: 8 * 1024 },
    (request2) => acceptProposal(
      db,
      params2(request2.params).id,
      body2(request2.body).reason,
      actor(request2.query)
    )
  );
  app2.post(
    "/api/skill-proposals/:id/reject",
    { bodyLimit: 8 * 1024 },
    (request2) => rejectProposal(
      db,
      params2(request2.params).id,
      body2(request2.body).reason,
      actor(request2.query)
    )
  );
}

// server/tasks/quota.ts
var UNKNOWN_RESTORE = /恢复时间未知/;
function holdRuntime(hold, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  if (!hold) return null;
  const until = expiresAt(hold, unknownMs);
  if (until <= now) return null;
  return {
    note: hold.until === null || UNKNOWN_RESTORE.test(hold.reason ?? "") ? "\u989D\u5EA6\u7528\u5C3D\uFF0C\u6062\u590D\u65F6\u95F4\u672A\u77E5" : `\u989D\u5EA6\u7528\u5C3D\uFF0C\u9884\u8BA1 ${clock(hold.until)} \u6062\u590D`,
    hold: { until, reason: hold.reason }
  };
}
function holdRuntimes(holds, now, unknownMs = DEFAULT_UNKNOWN_HOLD_MS) {
  const runtimes = /* @__PURE__ */ new Map();
  for (const hold of holds) {
    const runtime = holdRuntime(hold, now, unknownMs);
    if (runtime) runtimes.set(hold.provider, runtime);
  }
  return runtimes;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function providerIdOf(value) {
  return typeof value === "string" && value ? value : void 0;
}
var textOf2 = (value) => typeof value === "string" && value ? value : null;
function sourceOf(value) {
  return value === "builtin" || value === "openquota" ? value : null;
}
function row2(item, runtimes = /* @__PURE__ */ new Map()) {
  const providerId = providerIdOf(item.providerId);
  if (!providerId) return void 0;
  const runtime = runtimes.get(providerId);
  return {
    providerId,
    plan: textOf2(item.plan),
    source: sourceOf(item.source),
    note: textOf2(item.note),
    usedPercent: finiteNumber(item.usedPercent),
    periodElapsedPercent: finiteNumber(item.periodElapsedPercent),
    sparePercent: finiteNumber(item.sparePercent),
    hoursToReset: finiteNumber(item.hoursToReset),
    shortWindowUsedPercent: finiteNumber(item.shortWindowUsedPercent),
    refreshedAt: typeof item.refreshedAt === "string" ? item.refreshedAt : null,
    runtime: runtime?.note ?? null,
    hold: runtime?.hold ?? null
  };
}
function parseQuotaRows(data2, runtimes) {
  const accounts = [];
  for (const item of data2) {
    if (!item || typeof item !== "object") continue;
    const parsed = row2(item, runtimes);
    if (parsed) accounts.push(parsed);
  }
  return accounts;
}
function sortBySpare(accounts) {
  return [...accounts].sort((a, b) => {
    if (a.sparePercent === null && b.sparePercent === null)
      return a.providerId.localeCompare(b.providerId);
    if (a.sparePercent === null) return 1;
    if (b.sparePercent === null) return -1;
    return b.sparePercent - a.sparePercent || a.providerId.localeCompare(b.providerId);
  });
}
async function listQuota(options = {}) {
  const { db, now = Date.now(), unknownMs, ...source2 } = options;
  const { rows, notes: notes2 } = await readQuotaRows({ now: () => now, ...source2 });
  const runtimes = db ? holdRuntimes(listHolds(db), now, unknownMs) : /* @__PURE__ */ new Map();
  return {
    accounts: sortBySpare(parseQuotaRows(rows, runtimes)),
    notes: notes2,
    reserve: quotaReserve(db)
  };
}
function registerQuotaRoute(app2, options = {}) {
  if (options.db) ensureQuotaHoldTable(options.db);
  app2.get("/api/quota", () => listQuota(options));
}

// server/tasks/secretary-fallback.ts
import { spawn as spawn4 } from "node:child_process";
import { setTimeout as delay2 } from "node:timers/promises";

// server/tasks/secretary-lock.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { mkdirSync as mkdirSync13 } from "node:fs";
import { join as join24 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
function withLockDb(data2, work) {
  const directory = join24(data2, "secretary");
  mkdirSync13(directory, { recursive: true, mode: 448 });
  const db = new DatabaseSync3(join24(directory, "owner.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS owner (
        id INTEGER PRIMARY KEY CHECK(id=1),
        token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        child_pid INTEGER
      );
      BEGIN IMMEDIATE;`);
    try {
      const result = work(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
function claimSecretary(data2) {
  const token = randomUUID5();
  const claimed = withLockDb(data2, (db) => {
    const current2 = db.prepare("SELECT * FROM owner WHERE id=1").get();
    if (current2 && (alive2(current2.pid) || current2.child_pid && alive2(current2.child_pid)))
      return false;
    db.prepare(
      "INSERT INTO owner(id,token,pid,child_pid) VALUES (1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,child_pid=NULL"
    ).run(token, process.pid);
    return true;
  });
  if (!claimed) return null;
  return {
    child(pid) {
      withLockDb(data2, (db) => {
        db.prepare("UPDATE owner SET child_pid=? WHERE id=1 AND token=?").run(
          pid,
          token
        );
      });
    },
    release() {
      withLockDb(data2, (db) => {
        db.prepare("DELETE FROM owner WHERE id=1 AND token=?").run(token);
      });
    }
  };
}

// shared/opencode-home.ts
import {
  chmodSync as chmodSync3,
  existsSync as existsSync11,
  mkdirSync as mkdirSync14,
  readFileSync as readFileSync10,
  realpathSync as realpathSync2,
  renameSync as renameSync4,
  writeFileSync as writeFileSync11
} from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join25, resolve as resolve2 } from "node:path";

// shared/opencode-auth.ts
import { isDeepStrictEqual } from "node:util";
var isObject2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var nonEmpty2 = (value) => typeof value === "string" && value.length > 0;
function isApiKeyEntry(entry) {
  if (!isObject2(entry)) return false;
  if (entry.type === "api") return nonEmpty2(entry.key);
  if (entry.type === "wellknown")
    return nonEmpty2(entry.key) && nonEmpty2(entry.token);
  return false;
}
function classify3(entry) {
  if (isApiKeyEntry(entry)) return void 0;
  if (isObject2(entry) && (entry.type === "oauth" || "refresh" in entry || "tokens" in entry || "clientInfo" in entry || "codeVerifier" in entry))
    return "oauth";
  return "uncertain";
}
function secrets(entry) {
  if (!isObject2(entry)) return [];
  const found = [entry.refresh, entry.access, entry.key];
  if (isObject2(entry.tokens))
    found.push(entry.tokens.refreshToken, entry.tokens.accessToken);
  return found.filter(nonEmpty2);
}
function copiedFrom(entry, source2) {
  if (source2 === void 0) return false;
  if (isDeepStrictEqual(entry, source2)) return true;
  const theirs = new Set(secrets(source2));
  return secrets(entry).some((secret2) => theirs.has(secret2));
}
function parse3(text6) {
  try {
    const value = JSON.parse(text6);
    return isObject2(value) ? value : "\u4E0D\u662F JSON \u5BF9\u8C61";
  } catch {
    return "\u4E0D\u662F\u5408\u6CD5 JSON";
  }
}
function planAuthFile(file, source2, target, previous = []) {
  const problems = [];
  let theirs = {};
  if (source2 !== void 0) {
    const parsed = parse3(source2);
    if (typeof parsed === "string")
      return {
        synced: [...previous],
        skipped: [],
        problems: [
          `\u7528\u6237\u7684 opencode ${file} ${parsed}\uFF0C\u8FD9\u6B21\u4E0D\u540C\u6B65\uFF0C\u79D8\u4E66\u90A3\u4EFD\u4E0D\u52A8`
        ]
      };
    theirs = parsed;
  }
  let ours = {};
  if (target !== void 0) {
    const parsed = parse3(target);
    if (typeof parsed === "string")
      problems.push(`\u79D8\u4E66\u7684 ${file} ${parsed}\uFF0C\u5DF2\u632A\u5F00\u91CD\u5EFA`);
    else ours = parsed;
  }
  const result = {};
  for (const [name2, entry] of Object.entries(ours)) {
    if (previous.includes(name2)) continue;
    if (copiedFrom(entry, theirs[name2])) continue;
    result[name2] = entry;
  }
  const synced = [];
  const skipped2 = [];
  for (const [name2, entry] of Object.entries(theirs)) {
    const reason = classify3(entry);
    if (reason) {
      skipped2.push({ name: name2, reason });
      continue;
    }
    result[name2] = entry;
    synced.push(name2);
  }
  return {
    content: `${JSON.stringify(result, null, 2)}
`,
    synced,
    skipped: skipped2,
    problems
  };
}
function oauthOnly(plan2) {
  if (plan2.content === void 0) return [];
  const present = parse3(plan2.content);
  return plan2.skipped.filter((item) => item.reason === "oauth" && !(item.name in present)).map((item) => item.name);
}

// shared/opencode-home.ts
var AUTH_FILES = ["auth.json", "mcp-auth.json"];
var SYNCED = "atrium-synced.json";
function secretaryOpencodeHome(data2) {
  return join25(data2, "secretary", "opencode-home");
}
function userOpencodeData(env = process.env) {
  return join25(
    resolve2(env.XDG_DATA_HOME || join25(homedir8(), ".local", "share")),
    "opencode"
  );
}
var real = (path) => existsSync11(path) ? realpathSync2(path) : path;
var readText = (path) => {
  try {
    return readFileSync10(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
};
function readSynced(path) {
  try {
    const value = JSON.parse(readText(path) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const result = {};
    for (const [file, names2] of Object.entries(value))
      if (Array.isArray(names2))
        result[file] = names2.filter((name2) => typeof name2 === "string");
    return result;
  } catch {
    return {};
  }
}
function prepareOpencodeHome(home, source2) {
  const report = {
    written: [],
    oauthOnly: [],
    mcpSkipped: [],
    problems: []
  };
  const target = join25(home, "opencode");
  mkdirSync14(target, { recursive: true, mode: 448 });
  if (real(target) === real(source2)) return report;
  const syncedPath = join25(home, SYNCED);
  const synced = readSynced(syncedPath);
  const next = {};
  for (const name2 of AUTH_FILES) {
    const to2 = join25(target, name2);
    let from;
    try {
      from = readText(join25(source2, name2));
    } catch (error) {
      report.problems.push(
        `\u8BFB\u4E0D\u4E86\u7528\u6237\u7684 opencode ${name2}\uFF08${error.code ?? "\u672A\u77E5\u9519\u8BEF"}\uFF09\uFF0C\u8FD9\u6B21\u4E0D\u540C\u6B65`
      );
      next[name2] = synced[name2] ?? [];
      continue;
    }
    const current2 = readText(to2);
    const plan2 = planAuthFile(name2, from, current2, synced[name2]);
    report.problems.push(...plan2.problems);
    next[name2] = plan2.synced;
    if (name2 === "auth.json") report.oauthOnly = oauthOnly(plan2);
    else report.mcpSkipped = plan2.skipped;
    if (plan2.content === void 0 || plan2.content === current2) continue;
    if (current2 !== void 0 && plan2.problems.length)
      renameSync4(to2, `${to2}.bad-${Date.now()}`);
    writeFileSync11(`${to2}.tmp`, plan2.content, { mode: 384 });
    chmodSync3(`${to2}.tmp`, 384);
    renameSync4(`${to2}.tmp`, to2);
    report.written.push(name2);
  }
  writeFileSync11(syncedPath, `${JSON.stringify(next)}
`, { mode: 384 });
  return report;
}
function opencodeEnvironment(base2, options) {
  const env = { ...base2, XDG_DATA_HOME: options.home };
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  if (options.password) env.OPENCODE_SERVER_PASSWORD = options.password;
  return env;
}

// server/tasks/secretary-session.ts
import { randomUUID as randomUUID6 } from "node:crypto";
import { mkdirSync as mkdirSync15, readFileSync as readFileSync11, renameSync as renameSync5, writeFileSync as writeFileSync12 } from "node:fs";
import { basename, isAbsolute as isAbsolute7, join as join26 } from "node:path";
function secretarySessionFile(tool) {
  return tool === "opencode" ? "opencode-session.json" : "codex-acp.json";
}
function saveJson(file, value) {
  const temporary = `${file}.tmp-${randomUUID6()}`;
  writeFileSync12(temporary, `${JSON.stringify(value)}
`, { mode: 384 });
  renameSync5(temporary, file);
}
function quarantine(file) {
  try {
    renameSync5(file, `${file}.bad-${randomUUID6()}`);
    console.warn(`\u79D8\u4E66\u4F1A\u8BDD\u8BB0\u5F55 ${basename(file)} \u5DF2\u635F\u574F\uFF0C\u5DF2\u79FB\u5F00`);
  } catch {
  }
}
function readJson(file) {
  let raw;
  try {
    raw = readFileSync11(file, "utf8");
  } catch {
    return void 0;
  }
  try {
    return JSON.parse(raw);
  } catch {
    quarantine(file);
    return void 0;
  }
}
function loadSecretarySession(data2) {
  const activeFile = join26(data2, "secretary", "active.json");
  const active = readJson(activeFile);
  if (!active) return void 0;
  if (active.tool !== "codex" && active.tool !== "opencode") {
    quarantine(activeFile);
    return void 0;
  }
  const sessionFile = join26(
    data2,
    "secretary",
    secretarySessionFile(active.tool)
  );
  const saved = readJson(sessionFile);
  if (!saved) return void 0;
  if (typeof saved.sessionId !== "string" || !saved.sessionId || typeof saved.cwd !== "string" || !isAbsolute7(saved.cwd)) {
    quarantine(sessionFile);
    return void 0;
  }
  return { tool: active.tool, sessionId: saved.sessionId, cwd: saved.cwd };
}
function wakeCount(data2) {
  const file = join26(data2, "secretary", "wake-count.json");
  const value = readJson(file);
  if (!value) return 0;
  if (Number.isInteger(value.count) && value.count >= 0)
    return value.count;
  quarantine(file);
  return 0;
}
function saveWakeCount(data2, count2) {
  const directory = join26(data2, "secretary");
  mkdirSync15(directory, { recursive: true, mode: 448 });
  saveJson(join26(directory, "wake-count.json"), { count: count2 });
}

// server/tasks/wake-prompt.ts
function wakePrompt(events2) {
  const ids = events2.map((event) => event.id);
  const tasks = [
    ...new Set(events2.flatMap((event) => event.task ? [event.task] : []))
  ];
  return [
    `\u3010Atrium \u4E8B\u4EF6\u3011${events2.length} \u6761\u5F85\u5904\u7406\u4E8B\u4EF6\u5DF2\u9001\u8FBE\uFF08\u7F16\u53F7 ${ids.join("\u3001")}\uFF09\uFF1A`,
    ...events2.map((event) => {
      const detail2 = event.detail ?? {};
      const title2 = typeof detail2.title === "string" ? detail2.title.slice(0, 40) : "";
      const reason = typeof detail2.reason === "string" ? detail2.reason.slice(0, 160) : "";
      const pr = typeof detail2.pr_url === "string" ? detail2.pr_url.slice(0, 500) : "";
      return `- ${[
        `#${event.id}`,
        event.task,
        event.kind,
        title2,
        event.count > 1 ? `\uFF08\u5408\u5E76 ${event.count} \u6B21\uFF09` : "",
        pr,
        reason ? `\xB7 ${reason}` : ""
      ].filter(Boolean).join(" ")}`;
    }),
    "",
    tasks.length ? `\u770B\u8BE6\u60C5\uFF1A${tasks.map((task) => `atrium task show ${task}`).join("\uFF1B")}` : "\u770B\u8BE6\u60C5\uFF1Aatrium events",
    `\u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}`
  ].join("\n");
}

// server/tasks/wake-rule.ts
function decideWake(input) {
  if (!input.events.length) return { kind: "empty" };
  const readyAt = input.events.reduce(
    (earliest, event) => Math.min(earliest, event.queuedAt),
    Number.POSITIVE_INFINITY
  ) + input.batchMs;
  if (input.now < readyAt) return { kind: "batching", readyAt };
  if (!input.sessionReady) return { kind: "unavailable" };
  if (input.turnRunning) return { kind: "busy" };
  if (input.consecutiveWakeups >= input.maxConsecutiveWakeups)
    return { kind: "limit" };
  return {
    kind: "send",
    eventIds: [...new Set(input.events.map((event) => event.id))].sort(
      (a, b) => a - b
    )
  };
}
function nextWakeCount(count2, action) {
  if (action === "user_turn") return 0;
  return action === "delivered" ? count2 + 1 : count2;
}

// server/tasks/secretary-fallback.ts
function resumeCommand(session, prompt) {
  if (session.tool === "codex") {
    if (!/^[0-9a-f-]{36}$/i.test(session.sessionId))
      throw new Error("codex \u79D8\u4E66\u4F1A\u8BDD\u7F16\u53F7\u65E0\u6548");
    return {
      command: "codex",
      args: [
        "exec",
        "resume",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'approval_policy="never"',
        session.sessionId,
        "-"
      ],
      stdin: prompt
    };
  }
  if (!/^ses_[A-Za-z0-9]+$/.test(session.sessionId))
    throw new Error("opencode \u79D8\u4E66\u4F1A\u8BDD\u7F16\u53F7\u65E0\u6548");
  return {
    command: "opencode",
    args: ["run", "--session", session.sessionId, "--auto", "--", prompt],
    stdin: void 0
  };
}
var resumeTurn = (session, prompt, signal, childPid, data2) => {
  const spec = resumeCommand(session, prompt);
  let env = serviceEnvironment().env;
  if (session.tool === "opencode") {
    const home = secretaryOpencodeHome(data2);
    const report = prepareOpencodeHome(home, userOpencodeData(env));
    for (const problem of report.problems) console.warn(`[atrium] ${problem}`);
    env = opencodeEnvironment(env, { home });
  }
  return new Promise((resolve4) => {
    const child = spawn4(spec.command, spec.args, {
      cwd: session.cwd,
      env,
      stdio: ["pipe", "ignore", "ignore"],
      detached: process.platform !== "win32"
    });
    if (child.pid) childPid(child.pid);
    child.stdin.on("error", () => {
    });
    if (spec.stdin) child.stdin.end(spec.stdin);
    else child.stdin.end();
    let timedOut = false;
    const signalChild = (signal2) => {
      try {
        if (process.platform === "win32") child.kill(signal2);
        else if (child.pid) process.kill(-child.pid, signal2);
      } catch {
        child.kill(signal2);
      }
    };
    let force;
    const stop = () => {
      signalChild("SIGTERM");
      force ??= setTimeout(() => signalChild("SIGKILL"), 5e3);
      force.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, 15 * 6e4);
    timeout.unref();
    child.once("error", () => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      resolve4(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      resolve4(code === 0 && !signal.aborted && !timedOut);
    });
  });
};
var SecretaryFallback = class {
  constructor(inbox, data2, options = {}) {
    this.inbox = inbox;
    this.data = data2;
    this.options = options;
  }
  inbox;
  data;
  options;
  abort = new AbortController();
  running;
  start() {
    this.running ??= this.loop();
  }
  async close() {
    this.abort.abort();
    await this.running;
  }
  async pause(ms) {
    try {
      await delay2(ms, void 0, { signal: this.abort.signal });
    } catch {
    }
  }
  async loop() {
    const signal = this.abort.signal;
    const now = this.options.now ?? Date.now;
    const batchMs = this.options.batchMs ?? 2e3;
    const maxWakeups = this.options.maxWakeups ?? 10;
    while (!signal.aborted) {
      try {
        if (!loadSecretarySession(this.data)) {
          await this.pause(5e3);
          continue;
        }
        const { events: events2, restarting } = await this.inbox.wait(
          "secretary",
          30,
          signal,
          {
            peek: true,
            trackOnline: false
          }
        );
        if (signal.aborted || restarting) break;
        const decision = decideWake({
          events: events2.map((event) => ({
            id: event.id,
            queuedAt: event.updated_at
          })),
          now: now(),
          batchMs,
          sessionReady: true,
          turnRunning: false,
          consecutiveWakeups: wakeCount(this.data),
          maxConsecutiveWakeups: maxWakeups
        });
        if (decision.kind === "empty") continue;
        if (decision.kind === "batching") {
          await this.pause(Math.max(0, decision.readyAt - now()));
          continue;
        }
        if (decision.kind === "limit") {
          await this.pause(5e3);
          continue;
        }
        if (decision.kind !== "send") continue;
        const lock = claimSecretary(this.data);
        if (!lock) {
          await this.pause(1e3);
          continue;
        }
        let failed = false;
        try {
          const session = loadSecretarySession(this.data);
          if (!session) continue;
          const delivered = this.inbox.deliver("secretary", decision.eventIds);
          if (!delivered.length) continue;
          let ok = false;
          try {
            ok = await (this.options.runTurn ?? resumeTurn)(
              session,
              wakePrompt(delivered),
              signal,
              (pid) => lock.child(pid),
              this.data
            );
          } catch {
            console.warn("\u79D8\u4E66\u540E\u53F0\u6062\u590D\u5931\u8D25\uFF1B\u7A0D\u540E\u91CD\u8BD5");
          }
          if (ok && !signal.aborted)
            saveWakeCount(
              this.data,
              nextWakeCount(wakeCount(this.data), "delivered")
            );
          else {
            this.inbox.release("secretary", delivered);
            failed = true;
          }
        } finally {
          lock.release();
        }
        if (failed && !signal.aborted) await this.pause(5e3);
      } catch {
        if (!signal.aborted) {
          console.warn("\u79D8\u4E66\u540E\u53F0\u6062\u590D\u6682\u65F6\u5931\u8D25\uFF1B\u7A0D\u540E\u91CD\u8BD5");
          await this.pause(5e3);
        }
      }
    }
  }
};

// server/memos/decisions.ts
var DECISION_LIMITS = { text: 300, why: 1e3 };
var PAGE_MAX = 200;
var PAGE_DEFAULT = 50;
var DECISION_RE = /^d([1-9][0-9]{0,15})$/;
var LEADER_RE2 = /^a[1-9][0-9]{0,8}$/;
var decisionRef = (id3) => `d${id3}`;
var usage8 = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function parseDecisionRef(value, field2 = "\u51B3\u5B9A") {
  const match = typeof value === "string" ? DECISION_RE.exec(value.trim()) : null;
  if (!match) throw usage8(`${field2}: \u51B3\u5B9A\u77ED\u53F7\u5E94\u4E3A d1 \u8FD9\u6837\u7684\u683C\u5F0F`);
  return Number(match[1]);
}
function deciderOf(value, owner) {
  if (value === void 0 || value === null || value === "") return owner;
  const text6 = typeof value === "string" ? value.trim() : "";
  if (text6 === "\u79D8\u4E66") return "secretary";
  if (text6 === "u1" || text6 === "secretary" || LEADER_RE2.test(text6))
    return text6;
  throw usage8("--by: \u8C01\u62CD\u677F\u5E94\u4E3A u1\u3001secretary \u6216 leader \u77ED\u53F7 aN");
}
function dateOf(value, now = Date.now()) {
  if (value === void 0 || value === null || value === "") {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const text6 = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text6);
  const day2 = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  if (!match || !day2 || day2.getFullYear() !== Number(match[1]) || day2.getMonth() !== Number(match[2]) - 1 || day2.getDate() !== Number(match[3]))
    throw usage8("--date: \u65E5\u671F\u5E94\u4E3A 2026-09-27 \u8FD9\u6837\u7684\u683C\u5F0F");
  if (day2.getTime() > now) throw usage8("--date: \u4E0D\u80FD\u662F\u5C06\u6765\u7684\u65E5\u671F");
  return text6;
}
function validateDecision(body3, owner, now = Date.now()) {
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw usage8("\u8BF7\u6C42\u4F53\u5E94\u4E3A\u5BF9\u8C61");
  const input = body3;
  const keys = [
    "text",
    "why",
    "by",
    "date",
    "issue",
    "node",
    "task",
    "supersedes"
  ];
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw usage8(`${key}: \u662F\u672A\u77E5\u5B57\u6BB5`);
  const field2 = (key, flag, label5) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim())
      throw usage8(`${flag}: ${label5}\u4E0D\u80FD\u4E3A\u7A7A`);
    const text6 = value.trim();
    if (Array.from(text6).length > DECISION_LIMITS[key])
      throw usage8(`${flag}: ${label5}\u4E0D\u80FD\u8D85\u8FC7 ${DECISION_LIMITS[key]} \u5B57`);
    return text6;
  };
  const given2 = (value) => value !== void 0 && value !== null && value !== "";
  let issue = null;
  if (given2(input.issue)) {
    const text6 = String(input.issue).trim().replace(/^#/, "");
    if (!/^[1-9][0-9]{0,8}$/.test(text6))
      throw usage8("--issue: \u5E94\u4E3A issue \u53F7\uFF0C\u5982 355");
    issue = Number(text6);
  }
  let node = null;
  if (given2(input.node)) {
    if (typeof input.node !== "string")
      throw usage8("--node: \u5E94\u4E3A\u7EC4\u7EC7\u8282\u70B9\uFF0C\u5982 o3 \u6216 atrium/org");
    node = input.node.trim();
  }
  return {
    text: field2("text", "\u51B3\u5B9A", "\u51B3\u5B9A"),
    why: field2("why", "--why", "\u539F\u56E0"),
    by: deciderOf(input.by, owner),
    date: dateOf(input.date, now),
    issue,
    node,
    task: given2(input.task) ? parseTaskRef(input.task, "--task") : null,
    supersedes: given2(input.supersedes) ? parseDecisionRef(input.supersedes, "--supersedes") : null
  };
}
function supersedeVerdict(owner, old, next) {
  if (old.id === next.id) return `${decisionRef(old.id)} \u4E0D\u80FD\u63A8\u7FFB\u81EA\u5DF1`;
  for (const d of [old, next])
    if (d.owner !== owner)
      return `${decisionRef(d.id)} \u662F ${who(d.owner)} \u7684\u51B3\u5B9A\u8BB0\u5F55\uFF0C\u4E0D\u5728 ${who(owner)} \u7684\u8BB0\u5F55\u91CC\uFF08\u7528 --as ${d.owner}\uFF09`;
  if (old.superseded_by !== null)
    return `${decisionRef(old.id)} \u5DF2\u88AB ${decisionRef(old.superseded_by)} \u63A8\u7FFB`;
  if (next.superseded_by !== null)
    return `${decisionRef(next.id)} \u81EA\u5DF1\u5DF2\u88AB ${decisionRef(next.superseded_by)} \u63A8\u7FFB\uFF0C\u6539\u6307\u5411\u6709\u6548\u7684\u51B3\u5B9A`;
  return null;
}
var who = (owner) => owner === "secretary" ? "\u79D8\u4E66" : owner;
function promptDecisions(list4, maxItems = 10, maxChars = 2e3) {
  const shown = [];
  let used = 0;
  for (const d of list4) {
    const size = Array.from(d.text).length + Array.from(d.why).length + 20;
    if (shown.length >= maxItems || used + size > maxChars) break;
    shown.push(d);
    used += size;
  }
  return { shown, omitted: list4.length - shown.length };
}
function decisionLine(d) {
  const links = [
    d.issue === null ? "" : `#${d.issue}`,
    d.node ?? "",
    d.task ?? ""
  ].filter(Boolean);
  return [
    `${d.ref} ${d.date.slice(5)} ${d.by === "secretary" ? "\u79D8\u4E66" : d.by} \u5B9A\uFF1A${d.text}`,
    `\u2014\u2014${d.why}`,
    links.length ? `\uFF08${links.join(" ")}\uFF09` : "",
    d.supersedes.length ? `\uFF08\u63A8\u7FFB ${d.supersedes.join("\u3001")}\uFF09` : "",
    d.superseded_by ? `\u3010\u5DF2\u88AB ${d.superseded_by} \u63A8\u7FFB\u3011` : ""
  ].join("");
}
function views(db, rows) {
  const ids = rows.map((r) => r.id);
  const replaced = /* @__PURE__ */ new Map();
  if (ids.length)
    for (const r of all2(
      db,
      `SELECT id,superseded_by FROM decisions WHERE superseded_by IN (${ids.map(() => "?").join(",")}) ORDER BY id LIMIT ${PAGE_MAX * 4}`,
      ...ids
    ))
      replaced.set(r.superseded_by, [
        ...replaced.get(r.superseded_by) ?? [],
        decisionRef(r.id)
      ]);
  const nodeIds = [
    ...new Set(rows.flatMap((r) => r.node_id === null ? [] : [r.node_id]))
  ];
  const names2 = new Map(
    nodeIds.length ? all2(
      db,
      `SELECT id,name FROM org_nodes WHERE id IN (${nodeIds.map(() => "?").join(",")}) LIMIT ${PAGE_MAX}`,
      ...nodeIds
    ).map((n) => [n.id, n.name]) : []
  );
  return rows.map((r) => ({
    ref: decisionRef(r.id),
    owner: r.owner,
    date: r.decided_on,
    by: r.decided_by,
    text: r.text,
    why: r.why,
    issue: r.issue,
    node: r.node_id === null ? null : ref(r.node_id),
    node_name: r.node_id === null ? null : names2.get(r.node_id) ?? null,
    task: r.task_id === null ? null : `t${r.task_id}`,
    superseded_by: r.superseded_by === null ? null : decisionRef(r.superseded_by),
    supersedes: replaced.get(r.id) ?? [],
    created_at: r.created_at
  }));
}
function requireRow2(db, id3, owner) {
  const row3 = one2(db, "SELECT * FROM decisions WHERE id=?", id3);
  if (!row3)
    throw new Problem(
      404,
      `\u51B3\u5B9A ${decisionRef(id3)} \u4E0D\u5B58\u5728`,
      "not_found",
      void 0,
      `atrium decision ls --as ${owner} --all`
    );
  return row3;
}
function getDecision(db, id3, owner) {
  return views(db, [requireRow2(db, id3, owner)])[0];
}
function supersede(db, owner, oldId, nextId2, now) {
  const old = requireRow2(db, oldId, owner);
  const next = requireRow2(db, nextId2, owner);
  const problem = supersedeVerdict(owner, old, next);
  if (problem)
    throw new Problem(
      409,
      problem,
      "conflict",
      void 0,
      `atrium decision ls --as ${owner} --all`
    );
  db.prepare(
    "UPDATE decisions SET superseded_by=?,superseded_at=? WHERE id=?"
  ).run(nextId2, now, oldId);
}
function addDecision(db, owner, body3, now = Date.now()) {
  const input = validateDecision(body3, owner, now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const node = input.node === null ? null : nodeByAddress(db, input.node).id;
    if (input.task !== null && !one2(db, "SELECT 1 AS ok FROM tasks WHERE id=?", input.task))
      throw new Problem(
        404,
        `--task: \u4EFB\u52A1 t${input.task} \u4E0D\u5B58\u5728`,
        "not_found",
        void 0,
        "atrium task ls"
      );
    const id3 = Number(
      db.prepare(
        "INSERT INTO decisions(owner,decided_on,decided_by,text,why,issue,node_id,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).run(
        owner,
        input.date,
        input.by,
        input.text,
        input.why,
        input.issue,
        node,
        input.task,
        now
      ).lastInsertRowid
    );
    if (input.supersedes !== null)
      supersede(db, owner, input.supersedes, id3, now);
    db.exec("COMMIT");
    return getDecision(db, id3, owner);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function supersedeDecision(db, owner, reference, body3, now = Date.now()) {
  const oldId = parseDecisionRef(reference);
  const input = body3 ?? {};
  if (typeof input !== "object" || Array.isArray(input))
    throw usage8("\u8BF7\u6C42\u4F53\u5E94\u4E3A\u5BF9\u8C61");
  for (const key of Object.keys(input))
    if (key !== "by") throw usage8(`${key}: \u662F\u672A\u77E5\u5B57\u6BB5`);
  const nextId2 = parseDecisionRef(input.by, "--by");
  db.exec("BEGIN IMMEDIATE");
  try {
    supersede(db, owner, oldId, nextId2, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    old: getDecision(db, oldId, owner),
    next: getDecision(db, nextId2, owner)
  };
}
function parseLimit(value, fallback = PAGE_DEFAULT) {
  if (value === void 0 || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
    throw usage8(`--limit: \u5E94\u4E3A 1 \u5230 ${PAGE_MAX} \u7684\u6574\u6570`);
  return n;
}
function listDecisions(db, owner, options = {}) {
  const limit = options.limit ?? PAGE_DEFAULT;
  const where = ["owner=?"];
  const args2 = [owner];
  if (!options.all) where.push("superseded_by IS NULL");
  if (options.before !== void 0 && options.before !== null && options.before !== "") {
    const cursor = requireRow2(
      db,
      parseDecisionRef(options.before, "--before"),
      owner
    );
    where.push("(decided_on<? OR (decided_on=? AND id<?))");
    args2.push(cursor.decided_on, cursor.decided_on, cursor.id);
  }
  const rows = all2(
    db,
    `SELECT * FROM decisions WHERE ${where.join(" AND ")} ORDER BY decided_on DESC,id DESC LIMIT ?`,
    ...args2,
    limit + 1
  );
  const page = rows.slice(0, limit);
  const count2 = (extra) => one2(
    db,
    `SELECT count(*) AS n FROM decisions WHERE owner=?${extra}`,
    owner
  ).n;
  return {
    owner,
    decisions: views(db, page),
    active: count2(" AND superseded_by IS NULL"),
    superseded: count2(" AND superseded_by IS NOT NULL"),
    next_before: rows.length > limit ? decisionRef(page[page.length - 1].id) : null
  };
}

// server/leaders/wake.ts
var ESCALATE_KINDS = {
  shipped: "\u5DF2\u4E0A\u7EBF",
  cross: "\u9700\u8981\u522B\u7684\u90E8\u5206\u914D\u5408",
  beyond: "\u8D8A\u8FC7\u6743\u9650\uFF0F\u9884\u7B97\uFF0F\u786C\u8FB9\u754C",
  stuck: "\u641E\u4E0D\u5B9A"
};
var NOTE_MAX3 = 2e3;
var usage9 = (message4, next) => new Problem(400, message4, "usage", void 0, next);
function escalateInput(body3) {
  if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
    throw usage9("\u8BF7\u6C42\u4F53\u5E94\u4E3A\u5BF9\u8C61");
  const input = body3;
  for (const key of Object.keys(input))
    if (!["kind", "note", "task"].includes(key))
      throw usage9(`${key}: \u662F\u672A\u77E5\u5B57\u6BB5`);
  const kinds = Object.keys(ESCALATE_KINDS);
  if (typeof input.kind !== "string" || !kinds.includes(input.kind))
    throw usage9(
      `--kind: \u4E0A\u4EA4\u7C7B\u578B\u53EA\u80FD\u662F ${kinds.map((k) => `${k}\uFF08${ESCALATE_KINDS[k]}\uFF09`).join("\u3001")}`
    );
  if (typeof input.note !== "string" || !input.note.trim())
    throw usage9("\u8BF4\u660E: \u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5199\u6E05\u695A\u8981\u4E0A\u9762\u505A\u4EC0\u4E48");
  const note = input.note.trim();
  if (Array.from(note).length > NOTE_MAX3)
    throw usage9(`\u8BF4\u660E: \u81F3\u591A ${NOTE_MAX3} \u5B57\uFF0C\u957F\u5185\u5BB9\u653E\u8FDB\u4EFB\u52A1\u5907\u6CE8\u6216 PR`);
  let task = null;
  if (input.task !== void 0 && input.task !== null && input.task !== "") {
    if (typeof input.task !== "string" || !/^t[1-9][0-9]*$/.test(input.task))
      throw usage9("--task: \u5E94\u4E3A\u4EFB\u52A1\u77ED\u53F7\uFF0C\u5982 t5");
    task = input.task;
  }
  if (input.kind === "shipped" && !task)
    throw usage9("--task: \u4E0A\u4EA4\u300C\u5DF2\u4E0A\u7EBF\u300D\u8981\u7ED9\u4E0A\u7EBF\u7684\u4EFB\u52A1\uFF0C\u9644\u7AEF\u5230\u7AEF\u9A8C\u8BC1");
  return { kind: input.kind, note, task };
}
function afterWake(input) {
  if (input.exit === "ok" && input.unacked === 0)
    return { kind: "done", failures: 0 };
  if (input.exit === "timeout")
    return { kind: "handoff", failures: 0, note: "\u5524\u9192\u8D85\u65F6\uFF0C\u8F6C\u4EA4" };
  const failures = input.failures + 1;
  const why = input.exit === "failed" ? "leader \u8FDB\u7A0B\u5F02\u5E38\u9000\u51FA" : `leader \u9000\u51FA\u65F6\u8FD8\u6709 ${input.unacked} \u6761\u4E8B\u4EF6\u6CA1\u786E\u8BA4`;
  if (failures >= input.maxFailures)
    return {
      kind: "handoff",
      failures: 0,
      note: `${why}\uFF0C\u8FDE\u7EED ${failures} \u6B21\u5931\u8D25\uFF0C\u8F6C\u4EA4`
    };
  return {
    kind: "retry",
    failures,
    note: `${why}\uFF08\u7B2C ${failures} \u6B21\uFF09\uFF0C\u7A0D\u540E\u91CD\u8BD5`
  };
}
var field = (detail2, key, max) => {
  const value = detail2?.[key];
  return typeof value === "string" ? value.slice(0, max) : "";
};
function eventLine(event) {
  if (event.kind === "patrol_findings") {
    const detail2 = event.detail;
    return `- #${event.id} \u5DE1\u68C0\u53D1\u73B0 ${detail2?.node ?? ""}\uFF1A${(detail2?.findings ?? []).map((f) => `${f.ref} ${f.phenomenon}`).join("\uFF1B")}`;
  }
  return `- ${[
    `#${event.id}`,
    event.task,
    event.kind,
    field(event.detail, "title", 60),
    event.count > 1 ? `\uFF08\u5408\u5E76 ${event.count} \u6B21\uFF09` : "",
    field(event.detail, "pr_url", 300),
    field(event.detail, "reason", 300) || field(event.detail, "note", 300) ? `\xB7 ${field(event.detail, "reason", 300) || field(event.detail, "note", 300)}` : ""
  ].filter(Boolean).join(" ")}`;
}
var EVENT_WORDS = {
  done: "\u5B8C\u6210",
  failed: "\u5931\u8D25",
  blocked: "\u53D7\u963B",
  stalled: "\u5361\u4F4F",
  ready: "\u53EF\u4EE5\u6D3E\u4E86",
  waiting: "\u5728\u7B49",
  online: "\u4E0A\u7EBF",
  online_failed: "\u4E0A\u7EBF\u5931\u8D25",
  release_overdue: "\u7B49\u53D1\u7248\u8D85\u65F6",
  merged: "\u5DF2\u5408\u5165",
  merge_returned: "\u5408\u5165\u88AB\u6253\u56DE",
  escalated: "\u4E0A\u4EA4",
  ci_failure: "\u8FDC\u7AEF\u68C0\u67E5\u5931\u8D25",
  ci_success: "\u8FDC\u7AEF\u68C0\u67E5\u901A\u8FC7",
  ci_unavailable: "\u8FDC\u7AEF\u68C0\u67E5\u8DD1\u4E0D\u4E86",
  recovery: "\u670D\u52A1\u91CD\u542F\u540E\u63A5\u7BA1",
  review_passed: "\u5BA1\u9605\u901A\u8FC7",
  worker_advice: "\u6267\u884C\u8005\u5347\u964D\u5EFA\u8BAE",
  skill_proposal: "\u6280\u80FD\u4FEE\u8BA2\u63D0\u8BAE"
};
var eventWord = (kind) => EVENT_WORDS[kind] ?? kind;
function wakeSummary(events2) {
  const parts = events2.slice(0, 3).map((e) => [e.task, eventWord(e.kind)].filter(Boolean).join(" "));
  return `${parts.join("\u3001")}${events2.length > 3 ? ` \u7B49 ${events2.length} \u4EF6` : ""}`;
}
function leaderPrompt(input) {
  const ids = input.events.map((e) => e.id);
  const home = input.nodes[0]?.ref ?? "\u8282\u70B9";
  return [
    `\u4F60\u662F Atrium \u7EC4\u7EC7\u91CC\u7684 leader ${input.leader}\uFF08${input.name}\uFF09\uFF0C\u8D1F\u8D23\uFF1A${input.nodes.map((n) => `${n.ref} ${n.name}\uFF08${n.path}\uFF09`).join("\u3001") || "\uFF08\u6682\u65E0\u8282\u70B9\uFF09"} \u53CA\u5176\u4E0B\u5C5E\u90E8\u5206\u3002`,
    "\u4F60\u662F\u4E00\u6B21\u6027\u8FDB\u7A0B\uFF1A\u5904\u7406\u5B8C\u8FD9\u6279\u4E8B\u4EF6\u3001\u786E\u8BA4\u540E\u9000\u51FA\u3002\u4F60\u7684\u8FDE\u7EED\u6027\u5B58\u5728 Atrium\uFF08\u8282\u70B9\u8981\u70B9\u3001\u9636\u6BB5\u3001\u4EA4\u4ED8\u8BB0\u5F55\u3001\u4F60\u7684\u5907\u5FD8\uFF09\uFF0C\u4E0D\u9760\u8FD9\u6B21\u7684\u8BB0\u5FC6\u3002",
    "\u4F60\u4E0D\u5199\u4EE3\u7801\u3001\u4E0D\u6539\u4ED3\u5E93\uFF1B\u6D3B\u6D3E\u7ED9\u6267\u884C\u8005\uFF0C\u4F60\u8D1F\u8D23\u5224\u65AD\u3001\u6D3E\u3001\u76EF\u3001\u6536\u3002",
    "",
    "## \u4F60\u8D1F\u8D23\u7684\u90E8\u5206",
    ...input.nodes.map((n) => n.context),
    "",
    `## \u4F60\u7684\u5907\u5FD8\uFF08\u4E0A\u6B21\u7559\u7ED9\u81EA\u5DF1\u7684\uFF0C\u4E0A\u9650 ${MEMO_MAX} \u5B57\uFF09`,
    input.memo || "\uFF08\u7A7A\uFF09",
    "",
    "## \u4F60\u7684\u51B3\u5B9A\u8BB0\u5F55\uFF08\u6700\u8FD1\u6709\u6548\u7684\uFF0C\u65B0\u7684\u5728\u524D\uFF09",
    ...input.decisions?.shown.length ? input.decisions.shown.map((d) => `- ${decisionLine(d)}`) : ["\uFF08\u8FD8\u6CA1\u6709\uFF09"],
    ...input.decisions?.omitted ? [
      `\u8FD8\u6709 ${input.decisions.omitted} \u6761\u6CA1\u5217\uFF1Aatrium decision ls\uFF08\u770B\u5DF2\u63A8\u7FFB\u7684\u52A0 --all\uFF09`
    ] : [],
    "",
    `## \u8FD9\u6279\u8981\u5904\u7406\u7684\u4E8B\u4EF6\uFF08${input.events.length} \u6761\uFF09`,
    ...input.events.map(eventLine),
    ...input.digest.length ? [
      "",
      "## \u8FC7\u7A0B\u6458\u8981\uFF08\u5DF2\u81EA\u52A8\u786E\u8BA4\uFF0C\u4F9B\u53C2\u8003\uFF09",
      ...input.digest.map((d) => `- ${d}`)
    ] : [],
    "",
    "## \u53EF\u7528\u547D\u4EE4\uFF08\u90FD\u662F atrium\uFF0C\u5DF2\u6309\u4F60\u7684\u8EAB\u4EFD\u8FDE\u5230\u670D\u52A1\uFF09",
    "- \u770B\uFF1Aatrium task show tN\uFF1Batrium task log tN\uFF1Batrium task tree tN\uFF1Batrium top --once\uFF1Batrium map oN --json",
    "- \u91CD\u6D3E\uFF1Aatrium task run tN [--worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]]\uFF1B\u634E\u8BDD\uFF1Aatrium task tell tN \u8865\u5145\uFF1B\u505C\uFF1Aatrium task stop tN\uFF1B\u5907\u6CE8\uFF1Aatrium task note tN \u6587\u5B57",
    `- \u65B0\u6D3B\uFF1Aatrium task add \u6807\u9898 --part ${home} [--brief \u6587\u4EF6] [--repo \u8DEF\u5F84] [--by \u4E13\u5458] [--ask \u4E13\u5458]\uFF1B\u518D atrium task run tN`,
    "- \u5DE1\u68C0\u53D1\u73B0\uFF1Aatrium patrol findings oN\uFF1B\u5F00\u4EFB\u52A1\u540E atrium patrol decide fN --task tN\uFF0C\u5408\u5230\u5DF2\u6709\u4EFB\u52A1\u7528 --merge tN\uFF0C\u5FFD\u7565\u7528 --ignore \u539F\u56E0\uFF1B\u5904\u7406\u540E\u786E\u8BA4\u4E8B\u4EF6",
    `- \u8BF7\u4E13\u5458\uFF1Aatrium task set tN --ask \u524D\u7AEF\uFF1B\u4F1A\u5BA1\uFF1Aatrium review add \u8BAE\u9898 --concerns \u524D\u7AEF,\u540E\u7AEF --part ${home}`,
    `- \u8981\u70B9\uFF1Aatrium org point-add ${home} \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by ${input.leader}\uFF1B\u9636\u6BB5\uFF1Aatrium org stages ${home} --file \u9636\u6BB5.yaml`,
    `- \u5B50\u8282\u70B9\u6307\u6D3E leader\uFF1Aatrium org edit \u5B50\u8282\u70B9 --leader aM`,
    "- \u5907\u5FD8\uFF1Aatrium memo edit \u6587\u672C\uFF08\u8986\u76D6\u5199\uFF0C\u8D85\u8FC7\u4E0A\u9650\u4F1A\u88AB\u62D2\uFF0C\u5148\u7CBE\u7B80\uFF09\uFF1B\u770B\u5168\uFF1Aatrium memo show",
    "- \u51B3\u5B9A\u8BB0\u5F55\uFF08\u53D6\u820D\u4E0E\u539F\u56E0\uFF0C\u7ED9\u81EA\u5DF1\u4EE5\u540E\u56DE\u770B\uFF1B\u4E0D\u662F\u6267\u884C\u8005\u8981\u5B88\u7684\u8981\u70B9\uFF09\uFF1Aatrium decision add \u51B3\u5B9A --why \u539F\u56E0 [--by u1] [--issue N] [--task tN] [--supersedes dN]\uFF1B\u63A8\u7FFB\uFF1Aatrium decision supersede dN --by dM",
    "",
    "## \u6743\u9650\u8FB9\u754C\uFF08\u670D\u52A1\u7AEF\u5F3A\u5236\uFF0C\u8D8A\u6743\u4F1A\u88AB\u62D2\uFF09",
    "- \u53EF\u4EE5\uFF1A\u5728\u4F60\u8D1F\u8D23\u7684\u8282\u70B9\u53CA\u5B50\u8282\u70B9\u5EFA\u4EFB\u52A1\u3001\u6D3E\u6D3B\u3001\u91CD\u6D3E\u3001\u634E\u8BDD\u3001\u505C\u3001\u8BF7\u4E13\u5458\u4E0E\u4F1A\u5BA1\uFF1B\u6539\u8FD9\u4E9B\u8282\u70B9\u7684\u8981\u70B9\u3001\u9636\u6BB5\u4E0E\u5168\u666F\u4EBA\u8BDD\u5B57\u6BB5\uFF1B\u5199\u81EA\u5DF1\u7684\u5907\u5FD8\u4E0E\u51B3\u5B9A\u8BB0\u5F55\uFF1B\u7ED9\u5B50\u8282\u70B9\u6307\u6D3E\u4E0B\u5C42 leader\u3002",
    "- \u4E0D\u53EF\u4EE5\uFF1A\u52A8\u522B\u7684\u90E8\u5206\u7684\u4EFB\u52A1\u3001\u6539\u7AE0\u7A0B\u4E0E\u4E0A\u5C42\u89C4\u77E9\u3001\u7A81\u7834\u9884\u7B97\u4E0E\u786C\u8FB9\u754C\u3001\u6539\u4ED3\u5E93\u516C\u5F00\u8303\u56F4\u3001\u82B1\u94B1\u3001\u62CD\u677F\u4E0A\u4EA4\u7684\u4F1A\u5BA1\u3002",
    "",
    `## \u4E0A\u4EA4\uFF08\u6295\u7ED9 ${input.upstream}\uFF1B\u53EA\u6709\u8FD9\u56DB\u7C7B\u624D\u4E0A\u4EA4\uFF0C\u5176\u4F59\u81EA\u5DF1\u5904\u7406\uFF09`,
    "- shipped \u5DF2\u4E0A\u7EBF\uFF1A\u53EA\u5728\u91CC\u7A0B\u7891\uFF0F\u9636\u6BB5\u8FBE\u6210\u65F6\u4E0A\u4EA4 \u2192 atrium leader escalate --kind shipped \u8BF4\u660E --task tN\uFF1B\u5355\u4E2A\u4EFB\u52A1\u4E0A\u7EBF\u8FD0\u884C\u65F6\u5DF2\u81EA\u52A8\u901A\u77E5\u79D8\u4E66\uFF0C\u4E0D\u5FC5\u518D\u62A5",
    "- cross \u9700\u8981\u522B\u7684\u90E8\u5206\u914D\u5408 \u2192 atrium leader escalate --kind cross \u8BF4\u660E [--task tN]",
    "- beyond \u8D8A\u8FC7\u6743\u9650\uFF0F\u9884\u7B97\uFF0F\u786C\u8FB9\u754C \u2192 atrium leader escalate --kind beyond \u8BF4\u660E [--task tN]",
    "- stuck \u641E\u4E0D\u5B9A\uFF08\u540C\u4E00\u4EF6\u4E8B\u5361\u4F4F\u591A\u6B21\u3001\u62FF\u4E0D\u5B9A\uFF09\u2192 atrium leader escalate --kind stuck \u8BF4\u660E [--task tN]",
    "",
    "## \u6536\u5C3E",
    "1. \u628A\u8981\u8BB0\u4F4F\u7684\uFF08\u5728\u7B49\u4EC0\u4E48\u3001\u4E0B\u6B21\u5148\u770B\u4EC0\u4E48\uFF09\u5199\u8FDB\u5907\u5FD8\uFF1B\u8FD9\u6B21\u505A\u4E86\u53D6\u820D\u7684\uFF0C\u8BB0\u4E00\u6761\u51B3\u5B9A\u3002",
    `2. \u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}`,
    "3. \u9000\u51FA\u3002\u6CA1\u786E\u8BA4\u7684\u4E8B\u4EF6\u4F1A\u518D\u6B21\u5524\u9192\u4F60\uFF0C\u8FDE\u7EED\u5931\u8D25\u4F1A\u8F6C\u4EA4\u4E0A\u5C42\u3002"
  ].join("\n");
}

// server/leaders/routes.ts
var id = (params3) => String(params3.id ?? "");
function escalate(db, inbox, reference, body3, now = Date.now()) {
  const leader = leaderRef(requireLeader(db, reference).id);
  const input = escalateInput(body3);
  const task = input.task ? getTask(db, input.task) : null;
  const route = upstreamRoute(db, leader);
  const label5 = ESCALATE_KINDS[input.kind];
  const detail2 = {
    title: `${leader} \u4E0A\u4EA4\uFF1A${label5}${task ? ` \xB7 ${task.title}` : ""}`.slice(
      0,
      200
    ),
    from: leader,
    kind: input.kind,
    kind_label: label5,
    reason: input.note,
    task: task?.ref ?? null,
    pr_url: task?.pr_url ?? null,
    routed: { to: route.subscriber, why: route.why }
  };
  const event = inbox.publish({
    subscriber: route.subscriber,
    taskId: task?.id,
    source: "leader",
    kind: "escalated",
    key: `${leader}:escalate:${input.kind}:${task?.ref ?? now}`,
    actor: leader,
    detail: detail2
  });
  if (task)
    noteTask(
      db,
      task.id,
      "escalated",
      { ...detail2, to: route.subscriber },
      now
    );
  return {
    event: event.id,
    from: leader,
    to: route.subscriber,
    why: route.why,
    kind: input.kind,
    kind_label: label5,
    task: task?.ref ?? null
  };
}
function registerLeaderRoutes(app2, db, inbox) {
  ensureLeaderTables(db);
  app2.get("/api/leaders", () => listLeaders(db));
  app2.get("/api/leaders/:id", (request2) => showLeader(db, id(request2.params)));
  app2.post(
    "/api/leaders",
    { bodyLimit: 16 * 1024 },
    (request2, reply) => reply.code(201).send(addLeader(db, request2.body))
  );
  app2.patch(
    "/api/leaders/:id",
    { bodyLimit: 16 * 1024 },
    (request2) => editLeader(db, id(request2.params), request2.body)
  );
  app2.post(
    "/api/leaders/:id/escalate",
    { bodyLimit: 16 * 1024 },
    (request2) => escalate(db, inbox, id(request2.params), request2.body)
  );
}

// server/memos/routes.ts
var SECRETARY2 = "secretary";
function ownerOf3(db, value) {
  const text6 = typeof value === "string" ? value.trim() : "";
  if (!text6 || text6 === SECRETARY2) return SECRETARY2;
  if (!/^a/.test(text6))
    throw new Problem(
      400,
      "--as: \u5E94\u4E3A secretary \u6216 leader \u77ED\u53F7 aN",
      "usage",
      void 0,
      "atrium leader ls"
    );
  return leaderRef(requireLeader(db, text6).id);
}
function memoView(db, owner, all3 = false) {
  const memo = readMemo(db, owner);
  const leader = owner === SECRETARY2 ? null : showLeader(db, owner);
  const { owner: _, ...decisions } = listDecisions(db, owner, {
    all: all3,
    limit: PAGE_MAX
  });
  return {
    owner,
    name: leader?.name ?? "\u79D8\u4E66",
    kind: leader ? "leader" : "secretary",
    worker: leader?.worker ?? null,
    nodes: leader?.nodes ?? [],
    wake: leader?.wake ?? null,
    memo: memo.body,
    memo_max: MEMO_MAX,
    memo_updated_at: memo.updated_at,
    ...decisions
  };
}
var q4 = (value) => value ?? {};
function registerMemoRoutes(app2, db) {
  ensureMemoTables(db);
  app2.get(
    "/api/memo",
    (request2) => memoView(db, ownerOf3(db, q4(request2.query).as))
  );
  app2.put("/api/memo", { bodyLimit: 32 * 1024 }, (request2) => {
    const owner = ownerOf3(db, q4(request2.query).as);
    const body3 = request2.body;
    if (!body3 || typeof body3 !== "object" || Array.isArray(body3))
      throw new Problem(400, "\u8BF7\u6C42\u4F53\u5E94\u4E3A\u5BF9\u8C61", "usage");
    for (const key of Object.keys(body3))
      if (key !== "memo") throw new Problem(400, `${key}: \u662F\u672A\u77E5\u5B57\u6BB5`, "usage");
    writeMemo(db, owner, memoText(body3.memo, `atrium memo show --as ${owner}`));
    return memoView(db, owner);
  });
  app2.get("/api/decisions", (request2) => {
    const query2 = q4(request2.query);
    return listDecisions(db, ownerOf3(db, query2.as), {
      all: query2.all === "1" || query2.all === "true",
      before: query2.before,
      limit: parseLimit(query2.limit)
    });
  });
  app2.post(
    "/api/decisions",
    { bodyLimit: 16 * 1024 },
    (request2, reply) => reply.code(201).send(addDecision(db, ownerOf3(db, q4(request2.query).as), request2.body))
  );
  app2.post(
    "/api/decisions/:id/supersede",
    { bodyLimit: 1024 },
    (request2) => supersedeDecision(
      db,
      ownerOf3(db, q4(request2.query).as),
      request2.params.id,
      request2.body
    )
  );
}

// server/leaders/runtime.ts
import { spawn as spawn5 } from "node:child_process";
import {
  closeSync as closeSync6,
  existsSync as existsSync12,
  mkdirSync as mkdirSync16,
  openSync as openSync6,
  renameSync as renameSync6,
  writeFileSync as writeFileSync13
} from "node:fs";
import { join as join27 } from "node:path";
import { setTimeout as delay3 } from "node:timers/promises";
var LEADER_BATCH_MS = 3e4;
var LEADER_TIMEOUT_MS = 20 * 6e4;
var LEADER_MAX_FAILURES = 2;
function leaderEnvOptions(env = process.env) {
  const options = {};
  const batch = Number(env.ATRIUM_LEADER_BATCH_SECONDS);
  if (env.ATRIUM_LEADER_BATCH_SECONDS && Number.isFinite(batch) && batch >= 0)
    options.batchMs = batch * 1e3;
  const timeout = Number(env.ATRIUM_LEADER_TIMEOUT_MINUTES);
  if (Number.isFinite(timeout) && timeout > 0)
    options.timeoutMs = timeout * 6e4;
  return options;
}
function leaderEnvironment(base2, input) {
  const env = workerEnvironment(base2);
  delete env.ATRIUM_WORKER;
  env.ATRIUM_LEADER = input.leader;
  env.ATRIUM_LEADER_TOKEN = input.token;
  if (input.url) env.ATRIUM_LEADER_URL = input.url;
  return env;
}
var runLeaderProcess = async (spec) => {
  const worker = parseWorker(spec.worker);
  const adapter = ADAPTERS[worker.tool];
  mkdirSync16(spec.dir, { recursive: true, mode: 448 });
  const promptFile = join27(spec.dir, "prompt.md");
  writeFileSync13(promptFile, spec.prompt, { mode: 384 });
  const launch = adapter.build({
    promptFile,
    prompt: spec.prompt,
    cwd: spec.dir,
    model: worker.model ?? adapter.defaultModel,
    effort: worker.effort
  });
  const logFile = join27(spec.dir, "log");
  if (existsSync12(logFile)) renameSync6(logFile, `${logFile}.prev`);
  writeFileSync13(
    logFile,
    `[atrium] ${spec.leader} \xB7 ${spec.worker} \xB7 ${(/* @__PURE__ */ new Date()).toISOString()}
`,
    { mode: 384 }
  );
  const out = openSync6(logFile, "a");
  const input = launch.stdin ? openSync6(launch.stdin, "r") : "ignore";
  let child;
  try {
    child = spawn5(
      findExecutable(launch.command, spec.env.PATH ?? "") ?? launch.command,
      launch.args,
      {
        cwd: launch.cwd,
        env: launch.env ? { ...spec.env, ...launch.env } : spec.env,
        detached: true,
        stdio: [input, out, out]
      }
    );
  } finally {
    closeSync6(out);
    if (typeof input === "number") closeSync6(input);
  }
  return new Promise((resolve4) => {
    let timedOut = false;
    const stop = () => {
      if (child.pid) signalGroup(child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.pid) signalGroup(child.pid, "SIGKILL");
      }, 5e3).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    timer.unref();
    spec.signal.addEventListener("abort", stop, { once: true });
    const done = (exit) => {
      clearTimeout(timer);
      spec.signal.removeEventListener("abort", stop);
      resolve4(exit);
    };
    child.once("error", () => done("failed"));
    child.once(
      "exit",
      (code) => done(timedOut ? "timeout" : code === 0 ? "ok" : "failed")
    );
  });
};
var LeaderWaker = class {
  constructor(db, inbox, tokens, options) {
    this.db = db;
    this.inbox = inbox;
    this.tokens = tokens;
    this.options = options;
  }
  db;
  inbox;
  tokens;
  options;
  abort = new AbortController();
  running = /* @__PURE__ */ new Map();
  loopDone;
  get now() {
    return (this.options.now ?? Date.now)();
  }
  start() {
    const stale = this.db.prepare(
      "SELECT id FROM org_leaders WHERE wake_status='running' LIMIT 500"
    ).all();
    closeStaleWakes(this.db, this.now);
    for (const row3 of stale) this.inbox.releaseAll(`a${row3.id}`);
    this.loopDone ??= this.loop();
  }
  async close() {
    this.abort.abort();
    await this.loopDone;
    await Promise.allSettled([...this.running.values()]);
  }
  /** 正在处理的 leader（看板用）。 */
  busy() {
    return new Set(this.running.keys());
  }
  async loop() {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        this.tick();
      } catch (error) {
        console.warn("leader \u5524\u9192\u5DE1\u68C0\u5931\u8D25\uFF1B\u7A0D\u540E\u91CD\u8BD5", error);
      }
      try {
        await delay3(this.options.pollMs ?? 2e3, void 0, { signal });
      } catch {
      }
    }
  }
  /** 巡检一轮：每位已登记、没在跑的 leader，攒批到点就唤醒。 */
  tick() {
    for (const leader of registeredLeaders(this.db)) {
      if (this.running.has(leader) || this.abort.signal.aborted) continue;
      const events2 = this.inbox.pending(leader);
      const decision = decideWake({
        events: events2.map((e) => ({ id: e.id, queuedAt: e.updated_at })),
        now: this.now,
        batchMs: this.options.batchMs ?? LEADER_BATCH_MS,
        sessionReady: true,
        turnRunning: false,
        consecutiveWakeups: 0,
        maxConsecutiveWakeups: Number.POSITIVE_INFINITY
      });
      if (decision.kind !== "send") continue;
      const job = this.wake(leader, decision.eventIds).catch(
        (error) => console.warn(`leader ${leader} \u5524\u9192\u5931\u8D25\uFF1B\u7A0D\u540E\u91CD\u8BD5`, error)
      ).finally(() => this.running.delete(leader));
      this.running.set(leader, job);
    }
  }
  async wake(leader, ids) {
    const delivered = this.inbox.deliver(leader, ids);
    if (!delivered.length) return;
    let exit = "failed";
    try {
      const view7 = showLeader(this.db, leader);
      const upstream = upstreamRoute(this.db, leader);
      const digest4 = this.inbox.digest(leader).items.map((i) => i.summary);
      const prompt = leaderPrompt({
        leader,
        name: view7.name,
        nodes: view7.nodes.map((n) => ({
          ...n,
          context: contextOf(this.db, Number(n.ref.slice(1))).text
        })),
        memo: view7.memo,
        decisions: promptDecisions(
          listDecisions(this.db, leader, { limit: 30 }).decisions
        ),
        events: delivered,
        digest: digest4,
        upstream: upstream.subscriber === "secretary" ? "\u79D8\u4E66" : upstream.subscriber
      });
      markWakeStart(this.db, leader, wakeSummary(delivered), this.now);
      const timeoutMs = this.options.timeoutMs ?? LEADER_TIMEOUT_MS;
      const token = this.tokens.issue(leader, timeoutMs + 6e4);
      try {
        exit = await (this.options.run ?? runLeaderProcess)({
          leader,
          worker: view7.worker,
          prompt,
          dir: join27(this.options.data, "leaders", leader),
          env: leaderEnvironment(this.options.env ?? process.env, {
            leader,
            token,
            url: this.options.url?.()
          }),
          timeoutMs,
          signal: this.abort.signal
        });
      } finally {
        this.tokens.revoke(leader);
      }
    } catch (error) {
      console.warn(`leader ${leader} \u62C9\u8D77\u5931\u8D25`, error);
      exit = "failed";
    }
    if (this.abort.signal.aborted) {
      this.inbox.release(leader, delivered);
      markWakeEnd(
        this.db,
        leader,
        "failed",
        wakeFailures(this.db, leader),
        "\u670D\u52A1\u5173\u95ED\uFF0C\u5524\u9192\u4E2D\u65AD\uFF0C\u4E8B\u4EF6\u7A0D\u540E\u91CD\u6295",
        this.now
      );
      return;
    }
    this.settle(leader, delivered, exit);
  }
  settle(leader, delivered, exit) {
    const changed2 = new Set(this.inbox.reopenChanged(leader, delivered));
    const open6 = new Set(this.inbox.unacked(delivered.map((e) => e.id)));
    const pending = delivered.filter(
      (e) => open6.has(e.id) && !changed2.has(e.id)
    );
    const decision = afterWake({
      exit,
      unacked: pending.length,
      failures: wakeFailures(this.db, leader),
      maxFailures: this.options.maxFailures ?? LEADER_MAX_FAILURES
    });
    if (decision.kind === "done") {
      markWakeEnd(this.db, leader, "done", 0, null, this.now);
      return;
    }
    if (decision.kind === "retry") {
      this.inbox.release(leader, pending);
      markWakeEnd(
        this.db,
        leader,
        "failed",
        decision.failures,
        decision.note,
        this.now
      );
      return;
    }
    const upstream = upstreamRoute(this.db, leader);
    for (const event of pending)
      this.inbox.publish({
        subscriber: upstream.subscriber,
        taskId: event.task ? parseTaskRef(event.task) : void 0,
        source: "leader",
        kind: event.kind,
        key: `${event.key}:handoff`,
        detail: {
          ...event.detail ?? {},
          handoff: { from: leader, note: decision.note },
          routed: {
            to: upstream.subscriber,
            why: `${leader} ${decision.note}\u7ED9 ${upstream.subscriber === "secretary" ? "\u79D8\u4E66" : upstream.subscriber}`
          }
        }
      });
    this.inbox.ack(pending.map((e) => e.id));
    markWakeEnd(this.db, leader, "handed_off", 0, decision.note, this.now);
  }
};

// server/map/login.ts
import { createHash as createHash7, randomBytes as randomBytes5 } from "node:crypto";
var LINK_TTL_MS = 2 * 6e4;
var SESSION_TTL_MS = 7 * 24 * 36e5;
var COOKIE = "atrium_map";
var KEEP = 20;
var digest3 = (value) => createHash7("sha256").update(value).digest("hex");
var TOKEN = /^[a-f0-9]{64}$/;
var MapLogin = class {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS map_login (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('link','session')),
      expires_at INTEGER NOT NULL);`);
  }
  db;
  now;
  issue(kind, ttl) {
    const token = randomBytes5(32).toString("hex");
    const now = this.now();
    this.db.prepare("DELETE FROM map_login WHERE expires_at<=?").run(now);
    this.db.prepare(
      "DELETE FROM map_login WHERE kind=? AND hash NOT IN (SELECT hash FROM map_login WHERE kind=? ORDER BY expires_at DESC LIMIT ?)"
    ).run(kind, kind, KEEP - 1);
    this.db.prepare("INSERT INTO map_login(hash,kind,expires_at) VALUES(?,?,?)").run(digest3(token), kind, now + ttl);
    return { token, expires_at: now + ttl };
  }
  /** 签发一次性登录码。 */
  link() {
    return this.issue("link", LINK_TTL_MS);
  }
  /** 用登录码换会话：码只认一次，过期或用过都返回 null。 */
  exchange(code) {
    if (typeof code !== "string" || !TOKEN.test(code)) return null;
    const hash = digest3(code);
    const row3 = this.db.prepare(
      "DELETE FROM map_login WHERE hash=? AND kind='link' RETURNING expires_at"
    ).get(hash);
    if (!row3 || row3.expires_at <= this.now()) return null;
    return this.issue("session", SESSION_TTL_MS);
  }
  /** 请求头里的会话 cookie 是否有效。 */
  valid(cookieHeader) {
    const token = cookieOf(cookieHeader);
    if (!token) return false;
    const row3 = this.db.prepare(
      "SELECT expires_at FROM map_login WHERE hash=? AND kind='session'"
    ).get(digest3(token));
    return !!row3 && row3.expires_at > this.now();
  }
};
function cookieOf(header) {
  for (const part of (header ?? "").split(";")) {
    const [name2, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name2 === COOKIE && TOKEN.test(value)) return value;
  }
  return null;
}
var sessionCookie = (token, ttl = SESSION_TTL_MS) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1e3)}`;

// server/imports/index.ts
import { homedir as homedir9 } from "node:os";
import { join as join28 } from "node:path";

// server/imports/briefs.ts
import { readFileSync as readFileSync12 } from "node:fs";

// server/imports/marks.ts
function ensureImportMarks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS state_imports (
    name TEXT PRIMARY KEY, done_at INTEGER NOT NULL, detail TEXT NOT NULL)`);
}
function importMark(db, name2) {
  return db.prepare("SELECT name,done_at,detail FROM state_imports WHERE name=?").get(name2);
}
function markImported(db, name2, detail2, now = Date.now()) {
  db.prepare(
    "INSERT OR IGNORE INTO state_imports(name,done_at,detail) VALUES(?,?,?)"
  ).run(name2, now, detail2);
}

// server/imports/briefs.ts
var PAGE = 200;
function readLegacyBrief(path, repo, read = (file) => readFileSync12(file, "utf8")) {
  const file = briefFile(path, repo);
  if (!file) return { ok: false, reason: "\u76F8\u5BF9\u8DEF\u5F84\u4F46\u4EFB\u52A1\u6CA1\u6709\u4ED3\u5E93" };
  let text6;
  try {
    text6 = read(file).replace(/^﻿/, "");
  } catch (error) {
    return {
      ok: false,
      reason: `\u8BFB\u4E0D\u5230 ${file}\uFF08${error.code ?? "\u9519\u8BEF"}\uFF09`
    };
  }
  const clipped = briefBytes(text6) > BRIEF_MAX_BYTES;
  return { ok: true, text: clipped ? clipBrief(text6) : text6, clipped };
}
function backfillBriefs(db, log = console.error, read) {
  if (importMark(db, "task_briefs")) return null;
  const result = { filled: 0, missing: 0 };
  let after = 0;
  for (; ; ) {
    const rows = db.prepare(
      "SELECT id,brief_path,repo FROM tasks WHERE id>? AND brief IS NULL AND brief_path IS NOT NULL ORDER BY id LIMIT ?"
    ).all(after, PAGE);
    if (!rows.length) break;
    for (const row3 of rows) {
      after = row3.id;
      const found = readLegacyBrief(row3.brief_path, row3.repo, read);
      if (!found.ok) {
        result.missing++;
        log(`\u4EFB\u52A1\u8BE6\u8FF0\u56DE\u586B\uFF1At${row3.id} ${found.reason}\uFF0C\u4FDD\u7559\u539F\u8DEF\u5F84`);
        continue;
      }
      db.prepare("UPDATE tasks SET brief=? WHERE id=? AND brief IS NULL").run(
        found.text,
        row3.id
      );
      result.filled++;
      if (found.clipped)
        log(
          `\u4EFB\u52A1\u8BE6\u8FF0\u56DE\u586B\uFF1At${row3.id} \u8D85\u8FC7 ${BRIEF_MAX_BYTES / 1024} KB\uFF0C\u5DF2\u622A\u65AD`
        );
    }
  }
  after = 0;
  for (; ; ) {
    const rows = db.prepare(
      `SELECT c.task_id,c.topic_brief,t.repo FROM task_councils c JOIN tasks t ON t.id=c.task_id
          WHERE c.task_id>? AND c.topic_text IS NULL AND c.topic_brief IS NOT NULL ORDER BY c.task_id LIMIT ?`
    ).all(after, PAGE);
    if (!rows.length) break;
    for (const row3 of rows) {
      after = row3.task_id;
      const found = readLegacyBrief(row3.topic_brief, row3.repo, read);
      if (!found.ok) {
        result.missing++;
        log(`\u4F1A\u5BA1\u8BAE\u9898\u56DE\u586B\uFF1At${row3.task_id} ${found.reason}\uFF0C\u4FDD\u7559\u539F\u8DEF\u5F84`);
        continue;
      }
      db.prepare(
        "UPDATE task_councils SET topic_text=? WHERE task_id=? AND topic_text IS NULL"
      ).run(found.text, row3.task_id);
      result.filled++;
    }
  }
  markImported(
    db,
    "task_briefs",
    `\u56DE\u586B ${result.filled} \u4EFD\uFF0C\u8BFB\u4E0D\u5230 ${result.missing} \u4EFD`
  );
  if (result.filled || result.missing)
    log(
      `\u4EFB\u52A1\u8BE6\u8FF0\u5DF2\u8FDB\u5E93\uFF1A\u56DE\u586B ${result.filled} \u4EFD${result.missing ? `\uFF0C${result.missing} \u4EFD\u8BFB\u4E0D\u5230\uFF08\u4FDD\u7559\u539F\u8DEF\u5F84\uFF0Catrium task set tN --brief \u6587\u4EF6 \u8865\u4E0A\uFF09` : ""}`
    );
  return result;
}

// server/imports/charter.ts
import { readFileSync as readFileSync13 } from "node:fs";
import YAML3 from "yaml";
var LEGACY_KEYS = {
  quota_reserve_percent: "quota_reserve_percent",
  disk_min_free_gb: "disk_min_free_gb",
  money: "money_yuan_max",
  money_yuan_max: "money_yuan_max"
};
var ENTRY = {
  quota_reserve_percent: {
    id: "quota-reserve",
    summary: "\u6BCF\u4E2A\u8BA2\u9605\u8D26\u53F7\u7684\u5468\u671F\u989D\u5EA6\u7559\u7ED9\u7528\u6237"
  },
  disk_min_free_gb: {
    id: "disk-floor",
    summary: "\u672C\u673A\u78C1\u76D8\u53EF\u7528\u4F4E\u4E8E\u4E0B\u9650\u5C31\u6682\u505C\u65B0\u4EFB\u52A1\uFF0C\u5148\u6E05\u7406\u7EC4\u7EC7\u81EA\u5DF1\u7684\u4E34\u65F6\u4EA7\u7269"
  },
  money_yuan_max: { id: "money", summary: "\u82B1\u8D39\u4E0A\u9650\uFF08\u5143\uFF09" }
};
function parseCharterBudget(text6) {
  const normalized = text6.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  if (frontmatter === void 0) return { entries: [], problems: [] };
  let data2;
  try {
    data2 = YAML3.parse(frontmatter);
  } catch (error) {
    return {
      entries: [],
      problems: [
        `frontmatter \u89E3\u6790\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
  const budget = data2 && typeof data2 === "object" && !Array.isArray(data2) ? data2.budget : void 0;
  if (budget === void 0 || budget === null)
    return { entries: [], problems: [] };
  if (typeof budget !== "object" || Array.isArray(budget))
    return { entries: [], problems: ["budget \u5E94\u4E3A\u952E\u503C"] };
  const entries = [];
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [name2, value] of Object.entries(budget)) {
    const key = LEGACY_KEYS[name2];
    if (!key) {
      problems.push(`budget.${name2} \u4E0D\u8BA4\u8BC6\uFF0C\u8DF3\u8FC7`);
      continue;
    }
    if (seen.has(key)) continue;
    const parsed = parseBoundaries([
      { ...ENTRY[key], param: { [key]: value } }
    ]);
    if (parsed.problems.length || !parsed.entries[0]?.param) {
      problems.push(
        `budget.${name2}\uFF1A${parsed.problems.map((p3) => p3.message).join("\uFF1B") || "\u65E0\u6548"}\uFF0C\u8DF3\u8FC7`
      );
      continue;
    }
    seen.add(key);
    entries.push(parsed.entries[0]);
  }
  return { entries, problems };
}
function missingBudget(own, imported) {
  const keys = new Set(own.flatMap((e) => e.param ? [e.param.key] : []));
  const ids = new Set(own.map((e) => e.id));
  const add = [];
  const skipped2 = [];
  for (const entry of imported) {
    if (!entry.param || keys.has(entry.param.key)) continue;
    if (ids.has(entry.id)) {
      skipped2.push(`${entry.param.key}\uFF08\u6839\u7AE0\u7A0B\u5DF2\u6709\u6761\u76EE ${entry.id}\uFF09`);
      continue;
    }
    add.push(entry);
  }
  return { add, skipped: skipped2 };
}
function importCharterBudget(db, file, log = console.error, read = (path) => readFileSync13(path, "utf8")) {
  const mark = importMark(db, "charter_budget");
  if (mark) return { status: "done", detail: mark.detail };
  const root = nodes(db).find((n) => n.parent_id === null);
  const charter = root ? one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    root.id
  ) : void 0;
  if (!root) return { status: "no_root" };
  const own = ownBoundaries(db, root.id);
  if (PARAM_KEYS.every((key) => own.some((e) => e.param?.key === key))) {
    markImported(db, "charter_budget", "\u6839\u7AE0\u7A0B\u5DF2\u6709\u5168\u90E8\u9884\u7B97");
    return { status: "nothing" };
  }
  let text6;
  try {
    text6 = read(file);
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") log(`\u6839\u7AE0\u7A0B\u5BFC\u5165\uFF1A\u8BFB\u4E0D\u5230 ${file}\uFF08${code}\uFF09\uFF0C\u8DF3\u8FC7`);
    markImported(db, "charter_budget", `\u6CA1\u6709\u65E7\u7AE0\u7A0B ${file}`);
    return { status: "no_file" };
  }
  const parsed = parseCharterBudget(text6);
  for (const problem of parsed.problems) log(`\u6839\u7AE0\u7A0B\u5BFC\u5165\uFF1A${file} ${problem}`);
  const { add, skipped: skipped2 } = missingBudget(own, parsed.entries);
  for (const item of skipped2) log(`\u6839\u7AE0\u7A0B\u5BFC\u5165\uFF1A\u8DF3\u8FC7 ${item}`);
  if (!add.length) {
    markImported(db, "charter_budget", "\u65E7\u7AE0\u7A0B\u6CA1\u6709\u6839\u7AE0\u7A0B\u7F3A\u7684\u9884\u7B97");
    return { status: "nothing" };
  }
  try {
    editDoc(
      db,
      ref(root.id),
      "charter",
      {
        fields: charter ? JSON.parse(charter.fields) : {},
        body: charter?.body ?? "",
        boundaries: [...exportBoundaries(own), ...exportBoundaries(add)],
        rev: `r${charter?.rev ?? 0}`,
        reason: `\u4ECE ${file} \u5BFC\u5165\u9884\u7B97`
      },
      "u1"
    );
  } catch (error) {
    log(
      `\u6839\u7AE0\u7A0B\u5BFC\u5165\uFF1A\u5199\u5165\u5931\u8D25\uFF0C\u8DF3\u8FC7\uFF08${error instanceof Error ? error.message : String(error)}\uFF09`
    );
    markImported(db, "charter_budget", "\u5199\u5165\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7");
    return { status: "nothing" };
  }
  const keys = add.map((e) => e.param.key);
  markImported(db, "charter_budget", `\u5BFC\u5165 ${keys.join("\u3001")}`);
  log(`\u6839\u7AE0\u7A0B\u5DF2\u5BFC\u5165\u9884\u7B97\uFF1A${keys.join("\u3001")}\uFF08\u6765\u81EA ${file}\uFF09`);
  return { status: "imported", keys };
}

// server/imports/index.ts
function legacyDir(env = process.env) {
  if (env.ATRIUM_LEGACY_DIR) return env.ATRIUM_LEGACY_DIR;
  if (env.NODE_TEST_CONTEXT) return void 0;
  return join28(homedir9(), "Atrium");
}
function importLegacyState(db, options) {
  const log = options.log ?? console.error;
  ensureImportMarks(db);
  const step2 = (name2, run3) => {
    try {
      run3();
    } catch (error) {
      log(
        `${name2}\u5BFC\u5165\u5931\u8D25\uFF0C\u4E0B\u6B21\u542F\u52A8\u91CD\u8BD5\uFF1A${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  step2("\u4EFB\u52A1\u8BE6\u8FF0", () => backfillBriefs(db, log));
  if (options.legacyDir) {
    const file = join28(options.legacyDir, "charter.md");
    step2("\u6839\u7AE0\u7A0B", () => importCharterBudget(db, file, log));
  }
}

// server/map/routes.ts
import { readFileSync as readFileSync14 } from "node:fs";
import { join as join29 } from "node:path";

// server/map/who.ts
function peopleNames(db) {
  const names2 = /* @__PURE__ */ new Map([
    ["u1", "\u4F60"],
    ["secretary", "\u79D8\u4E66"]
  ]);
  for (const [ref2, brief2] of leaderBriefs(db)) names2.set(ref2, brief2.name);
  return names2;
}
var personOf = (ref2, names2) => ({ ref: ref2, name: names2.get(ref2) ?? ref2 });
var parse4 = (text6) => {
  try {
    const value = text6 === null ? null : JSON.parse(text6);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};
function taskPeople(db, ids, names2 = peopleNames(db)) {
  const map = /* @__PURE__ */ new Map();
  if (!ids.length) return map;
  const marks = ids.map(() => "?").join(",");
  for (const id3 of ids) map.set(id3, { by: null, note: null });
  for (const row3 of all2(
    db,
    `SELECT task_id,detail FROM task_events WHERE kind='created' AND task_id IN (${marks}) LIMIT ${ids.length}`,
    ...ids
  )) {
    const by = parse4(row3.detail).by;
    if (typeof by === "string" && LEADER_RE.test(by))
      map.get(row3.task_id).by = personOf(by, names2);
  }
  for (const row3 of all2(
    db,
    `SELECT e.task_id,e.at,e.detail FROM task_events e
      JOIN (SELECT task_id,MAX(id) AS id FROM task_events WHERE kind='note' AND task_id IN (${marks}) GROUP BY task_id) m
        ON m.id=e.id LIMIT ${ids.length}`,
    ...ids
  )) {
    const detail2 = parse4(row3.detail);
    if (typeof detail2.text === "string" && typeof detail2.by === "string")
      map.get(row3.task_id).note = {
        text: detail2.text,
        at: row3.at,
        by: personOf(detail2.by, names2)
      };
  }
  return map;
}

// server/map/view.ts
var DEPTH_MAX2 = 8;
var OPEN2 = "('todo','running','blocked')";
var str3 = (value) => typeof value === "string" ? value.trim() : "";
function firstLine3(text6, max = 80) {
  const line = text6.split("\n", 1)[0].trim();
  const chars4 = Array.from(line);
  return chars4.length > max ? `${chars4.slice(0, max - 1).join("")}\u2026` : line;
}
function dotOf(counts) {
  return counts.running ? "running" : counts.blocked ? "blocked" : "idle";
}
function hasTasks(db) {
  return all2(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "part_id"
  );
}
function charters(db) {
  const map = /* @__PURE__ */ new Map();
  for (const row3 of all2(
    db,
    "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600"
  ))
    try {
      map.set(row3.node_id, JSON.parse(row3.fields));
    } catch {
      map.set(row3.node_id, {});
    }
  return map;
}
function ownCounts(db) {
  const map = /* @__PURE__ */ new Map();
  if (!hasTasks(db)) return map;
  for (const row3 of all2(
    db,
    `SELECT COALESCE(part_id,node_id) AS id,status,COUNT(*) AS n FROM tasks
      WHERE COALESCE(part_id,node_id) IS NOT NULL AND status IN ${OPEN2}
      GROUP BY 1,2 LIMIT 1500`
  )) {
    const c = map.get(row3.id) ?? { running: 0, blocked: 0, open: 0 };
    if (row3.status === "running") c.running += row3.n;
    if (row3.status === "blocked") c.blocked += row3.n;
    c.open += row3.n;
    map.set(row3.id, c);
  }
  return map;
}
function index(db) {
  const list4 = nodes(db).filter((node) => node.kind !== "concern");
  if (list4.length > 500) throw new Problem(409, "\u7EC4\u7EC7\u6811\u8D85\u8FC7 500 \u4E2A\u8282\u70B9");
  const children = /* @__PURE__ */ new Map();
  for (const n of list4)
    children.set(n.parent_id, [...children.get(n.parent_id) ?? [], n]);
  const own = ownCounts(db);
  const counts = /* @__PURE__ */ new Map();
  const sum = (n) => {
    const c = { ...own.get(n.id) ?? { running: 0, blocked: 0, open: 0 } };
    for (const child of children.get(n.id) ?? []) {
      const s = sum(child);
      c.running += s.running;
      c.blocked += s.blocked;
      c.open += s.open;
    }
    counts.set(n.id, c);
    return c;
  };
  for (const root of children.get(null) ?? []) sum(root);
  return {
    list: list4,
    byId: new Map(list4.map((n) => [n.id, n])),
    children,
    fields: charters(db),
    counts,
    leaders: leaderBriefs(db)
  };
}
var head = (x, n) => {
  const f = x.fields.get(n.id) ?? {};
  return {
    ref: ref(n.id),
    name: n.name,
    alias: str3(f.alias),
    analogy: str3(f.analogy)
  };
};
var leaderState = (x, n) => {
  const state = n.leader ? x.leaders.get(n.leader) : void 0;
  return state ? { leader_state: state } : {};
};
function leadOf(x, n) {
  for (let c = n; c; ) {
    const brief2 = c.leader ? x.leaders.get(c.leader) : void 0;
    if (brief2) {
      const h = head(x, c);
      return {
        ...brief2,
        from: c === n ? null : { ref: h.ref, name: h.name, alias: h.alias }
      };
    }
    c = c.parent_id === null ? void 0 : x.byId.get(c.parent_id);
  }
  return null;
}
function treeNode(x, n, depth) {
  const f = x.fields.get(n.id) ?? {};
  const counts = x.counts.get(n.id) ?? { running: 0, blocked: 0, open: 0 };
  const kids = x.children.get(n.id) ?? [];
  return {
    ...head(x, n),
    kind: n.kind,
    aspect: !!n.aspect,
    what: firstLine3(str3(f.what) || str3(f.goal)),
    archived: n.archived_at !== null,
    dot: dotOf(counts),
    tasks: counts,
    ...leaderState(x, n),
    ...depth > 0 ? { children: kids.map((c) => treeNode(x, c, depth - 1)) } : {},
    children_count: kids.length
  };
}
function parseDepth(value, fallback = DEPTH_MAX2) {
  if (value === void 0 || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > DEPTH_MAX2)
    throw new Problem(400, `--depth \u5E94\u4E3A 0\uFF5E${DEPTH_MAX2} \u7684\u6574\u6570`, "usage");
  return n;
}
function mapTree(db, root, depth = DEPTH_MAX2) {
  const x = index(db);
  const start = root ? nodeByAddress(db, root) : (x.children.get(null) ?? [])[0];
  if (!start)
    return {
      root: null,
      tree: null,
      next: "atrium org import --repo \u4ED3\u5E93"
    };
  if (start.kind === "concern")
    throw new Problem(
      404,
      `\u5173\u6CE8\u70B9\u8282\u70B9 ${root} \u5DF2\u4E0B\u7EBF\uFF0C\u8BF7\u67E5\u770B\u4E13\u5458\u540D\u5355`,
      "not_found"
    );
  return { root: ref(start.id), tree: treeNode(x, start, depth) };
}
function subtree(x, id3) {
  const ids = [id3];
  for (let i = 0; i < ids.length; i++)
    for (const c of x.children.get(ids[i]) ?? []) ids.push(c.id);
  return ids;
}
function jobNames(db) {
  if (!one2(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='job_roles'"
  ))
    return /* @__PURE__ */ new Map();
  return new Map(
    all2(
      db,
      "SELECT id,name FROM job_roles ORDER BY id LIMIT 200"
    ).map((r) => [r.id, r.name])
  );
}
function taskView(row3, live, jobs = /* @__PURE__ */ new Map(), people, involved = {}) {
  return {
    ref: `t${row3.id}`,
    title: row3.title,
    status: row3.status,
    queued: live?.queued_at != null,
    urgent: row3.urgent === 1,
    worker: row3.worker ?? live?.worker ?? null,
    started_at: row3.started_at,
    updated_at: row3.updated_at,
    reason: live?.reason ?? null,
    action: live?.action?.text ?? null,
    log_at: live?.log_at || null,
    part: row3.part === null ? null : ref(row3.part),
    pr_url: row3.pr_url,
    issue: row3.issue,
    delivery_stage: row3.delivery_stage ?? null,
    ended_at: row3.ended_at ?? null,
    job: row3.job_id != null && jobs.has(row3.job_id) ? { ref: `r${row3.job_id}`, name: jobs.get(row3.job_id) } : null,
    by: people?.by ?? null,
    note: people?.note ?? null,
    also: involved.also ?? [],
    home: involved.home ?? null
  };
}
var brief = (x, n) => {
  const h = head(x, n);
  return { ref: h.ref, name: h.name, alias: h.alias };
};
var alive3 = (x, id3) => {
  const n = x.byId.get(id3);
  return n && n.archived_at === null ? n : void 0;
};
function autoByPart(db, parts) {
  const map = /* @__PURE__ */ new Map();
  if (!parts.length) return map;
  try {
    const { list: list4, points } = aspectFacts(db);
    for (const part of new Set(parts))
      map.set(
        part,
        appliedFrom(list4, points, part, []).map((l) => Number(l.node.slice(1)))
      );
  } catch {
  }
  return map;
}
function involvedOfTasks(db, rows, x = index(db)) {
  const out = /* @__PURE__ */ new Map();
  if (!rows.length) return out;
  const explicit = /* @__PURE__ */ new Map();
  if (hasTable3(db, "task_also"))
    for (const r of all2(
      db,
      `SELECT task_id,node_id FROM task_also WHERE task_id IN (${rows.map(() => "?").join(",")})
        ORDER BY task_id,pos LIMIT 2000`,
      ...rows.map((r2) => r2.id)
    ))
      explicit.set(r.task_id, [...explicit.get(r.task_id) ?? [], r.node_id]);
  const auto = autoByPart(
    db,
    rows.flatMap((r) => r.part === null ? [] : [r.part])
  );
  for (const row3 of rows) {
    const mine = explicit.get(row3.id) ?? [];
    const list4 = [];
    for (const id3 of mine) {
      const n = alive3(x, id3);
      if (n) list4.push({ ...brief(x, n), auto: false });
    }
    for (const id3 of row3.part === null ? [] : auto.get(row3.part) ?? []) {
      const n = alive3(x, id3);
      if (n && !mine.includes(id3)) list4.push({ ...brief(x, n), auto: true });
    }
    if (list4.length) out.set(row3.id, list4);
  }
  return out;
}
function involvedRows(db, x, ids) {
  if (!hasTasks(db)) return [];
  const inTree = new Set(ids);
  const aspects = ids.filter((id3) => x.byId.get(id3)?.aspect);
  let covered = [];
  if (aspects.length) {
    const parts = all2(
      db,
      "SELECT DISTINCT COALESCE(part_id,node_id) AS part FROM tasks WHERE COALESCE(part_id,node_id) IS NOT NULL LIMIT 500"
    ).map((r) => r.part).filter((p3) => !inTree.has(p3));
    const auto = autoByPart(db, parts);
    covered = parts.filter(
      (p3) => (auto.get(p3) ?? []).some((a) => aspects.includes(a))
    );
  }
  const also = hasTable3(db, "task_also");
  if (!also && !covered.length) return [];
  const marks = (list4) => list4.map(() => "?").join(",");
  const where = [
    ...also ? [
      `id IN (SELECT task_id FROM task_also WHERE node_id IN (${marks(ids)}))`
    ] : [],
    ...covered.length ? [`COALESCE(part_id,node_id) IN (${marks(covered)})`] : []
  ].join(" OR ");
  return all2(
    db,
    `SELECT ${taskColumns(db)} FROM tasks
      WHERE (${where}) AND COALESCE(part_id,node_id) NOT IN (${marks(ids)})
      ORDER BY ${TASK_ORDER(db)}, updated_at DESC LIMIT 30`,
    ...also ? ids : [],
    ...covered,
    ...ids
  );
}
var hasTable3 = (db, name2) => !!one2(
  db,
  "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
  name2
);
function hasColumn(db, table, column) {
  return all2(db, `PRAGMA table_info(${table})`).some(
    (c) => c.name === column
  );
}
var taskColumns = (db) => `id,title,status,worker,started_at,updated_at,COALESCE(part_id,node_id) AS part,pr_url,issue,repo,ended_at,${hasColumn(db, "tasks", "delivery_stage") ? "delivery_stage" : "NULL AS delivery_stage"},${hasColumn(db, "tasks", "job_id") ? "job_id" : "NULL AS job_id"},${hasColumn(db, "tasks", "urgent") ? "urgent" : "0 AS urgent"}`;
var MERGING = "delivery_stage IN ('merge_queued','merging')";
var TASK_ORDER = (db) => `CASE WHEN status='running' THEN 0 WHEN status='blocked' THEN 1
    WHEN ${hasColumn(db, "tasks", "delivery_stage") ? MERGING : "0"} THEN 1 WHEN status='todo' THEN 2 ELSE 3 END`;
function repoUrls(db) {
  const map = /* @__PURE__ */ new Map();
  for (const row3 of all2(
    db,
    "SELECT repo,pr_url FROM tasks WHERE repo IS NOT NULL AND pr_url LIKE 'https://github.com/%' ORDER BY id DESC LIMIT 2000"
  )) {
    const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/.exec(
      row3.pr_url
    );
    if (m && !map.has(row3.repo)) map.set(row3.repo, m[1]);
  }
  return map;
}
function mapNode(db, address, live = []) {
  const x = index(db);
  const n = nodeByAddress(db, address);
  if (n.kind === "concern")
    throw new Problem(
      404,
      `\u5173\u6CE8\u70B9\u8282\u70B9 ${address} \u5DF2\u4E0B\u7EBF\uFF0C\u8BF7\u67E5\u770B\u4E13\u5458\u540D\u5355`,
      "not_found"
    );
  const fields = x.fields.get(n.id) ?? {};
  const kids = x.children.get(n.id) ?? [];
  const part = (c) => {
    const counts = x.counts.get(c.id);
    const f = x.fields.get(c.id) ?? {};
    return {
      ...head(x, c),
      kind: c.kind,
      aspect: !!c.aspect,
      what: firstLine3(str3(f.what) || str3(f.goal), 120),
      archived: c.archived_at !== null,
      parts: (x.children.get(c.id) ?? []).filter(
        (k) => k.kind !== "concern" && k.archived_at === null
      ).length,
      tasks: {
        todo: counts.open - counts.running - counts.blocked,
        running: counts.running,
        blocked: counts.blocked
      }
    };
  };
  const overview = overviewOf(
    fields,
    kids.filter((c) => c.kind !== "concern").map(part)
  );
  const chain = [];
  for (let c = n; c; ) {
    const h = head(x, c);
    chain.unshift({ ref: h.ref, name: h.name, alias: h.alias });
    c = c.parent_id === null ? void 0 : x.byId.get(c.parent_id);
  }
  const liveBy = new Map(live.map((row3) => [row3.ref, row3]));
  const ids = subtree(x, n.id);
  const marks = ids.map(() => "?").join(",");
  const rows = hasTasks(db) ? all2(
    db,
    `SELECT ${taskColumns(db)} FROM tasks WHERE COALESCE(part_id,node_id) IN (${marks})
          ORDER BY ${TASK_ORDER(db)}, updated_at DESC LIMIT 60`,
    ...ids
  ) : [];
  const others = involvedRows(db, x, ids);
  const jobs = jobNames(db);
  const both = [...rows, ...others];
  const who2 = taskPeople(
    db,
    both.map((r) => r.id)
  );
  const involved = involvedOfTasks(db, both, x);
  const homeOf = (r) => {
    const h = r.part === null ? void 0 : x.byId.get(r.part);
    return h ? brief(x, h) : null;
  };
  const tasks = [
    ...rows.map(
      (r) => taskView(r, liveBy.get(`t${r.id}`), jobs, who2.get(r.id), {
        also: involved.get(r.id)
      })
    ),
    ...others.map(
      (r) => taskView(r, liveBy.get(`t${r.id}`), jobs, who2.get(r.id), {
        also: involved.get(r.id),
        home: homeOf(r)
      })
    )
  ];
  const urls = repoUrls(db);
  const prs = rows.filter((r) => r.pr_url).slice(0, 10).map((r) => ({ task: `t${r.id}`, title: r.title, url: r.pr_url }));
  const issues = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const base2 = r.repo ? urls.get(r.repo) : void 0;
    if (r.issue && base2 && issues.size < 10)
      issues.set(`${base2}#${r.issue}`, {
        number: r.issue,
        url: `${base2}/issues/${r.issue}`
      });
  }
  const charter = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    n.id
  );
  const repos = all2(
    db,
    "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo LIMIT 20",
    n.id
  ).map((r) => r.repo);
  let repoUrl = null;
  for (let c = n; c && !repoUrl; ) {
    for (const r of all2(
      db,
      "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo LIMIT 20",
      c.id
    ))
      repoUrl ??= urls.get(r.repo) ?? urls.get(r.repo.replace(/\/+$/, "")) ?? null;
    c = c.parent_id === null ? void 0 : x.byId.get(c.parent_id);
  }
  return {
    ...head(x, n),
    kind: n.kind,
    /** 管方面的部分与它的要点缺省适用于哪些部分（null 为整个上级），#373。 */
    aspect: !!n.aspect,
    applies: appliesRefs(n.applies),
    /** 网页用：管方面的部分缺省适用于哪几块（带名字）；管东西的部分为 null。 */
    scope: n.aspect ? scopeOf3(x, n, null) : null,
    path: nodePath(x.list, n),
    leader: n.leader,
    ...leaderState(x, n),
    lead: leadOf(x, n),
    archived: n.archived_at !== null,
    dot: dotOf(x.counts.get(n.id)),
    counts: x.counts.get(n.id),
    chain,
    overview,
    points: scoped(x, n, nodePoints(db, n.id)),
    points_chain: chainPoints(db, n.id).filter((l) => l.node !== ref(n.id)),
    points_below: pointsBelow(db, x, n),
    /** 别处管方面的部分里适用于本块的要点，注明来源。 */
    points_applied: appliedPoints(db, n.id),
    findings: findingsForNode(db, n.id),
    /** 下层各块的巡检发现，注明来自哪一块；与本块的合起来就是网页「巡检发现」页签。 */
    findings_below: findingsBelow(db, x, n),
    tasks: {
      running: tasks.filter((t) => t.status === "running"),
      blocked: tasks.filter((t) => t.status === "blocked"),
      todo: tasks.filter((t) => t.status === "todo").slice(0, 10),
      recent: tasks.filter((t) => !["running", "blocked", "todo"].includes(t.status)).slice(0, 20)
    },
    links: { prs, issues: [...issues.values()] },
    detail: {
      body: charter?.body ?? "",
      rev: charter ? `r${charter.rev}` : null,
      updated_at: charter?.updated_at ?? null,
      repos,
      repo_url: repoUrl
    }
  };
}
function scopeOf3(x, n, refs) {
  const own = refs?.map((r) => Number(r.slice(1))) ?? null;
  const node = parseApplies(n.applies);
  const ids = own ?? node ?? [n.parent_id ?? n.id];
  return {
    explicit: (own ?? node) !== null,
    parts: ids.flatMap((id3) => {
      const p3 = alive3(x, id3);
      return p3 ? [brief(x, p3)] : [];
    })
  };
}
var scoped = (x, n, points) => n.aspect ? points.map((p3) => ({ ...p3, scope: scopeOf3(x, n, p3.applies) })) : points;
function pointsBelow(db, x, n) {
  const levels = [];
  let seen = 0;
  const walk = (parent) => {
    for (const c of x.children.get(parent.id) ?? []) {
      if (c.archived_at !== null || ++seen > 200) continue;
      const points = nodePoints(db, c.id);
      if (points.length)
        levels.push({
          node: ref(c.id),
          name: c.name,
          alias: head(x, c).alias,
          aspect: !!c.aspect,
          points: scoped(x, c, points)
        });
      walk(c);
    }
  };
  walk(n);
  return levels;
}
function findingsBelow(db, x, n) {
  const below = /* @__PURE__ */ new Map();
  const walk = (parent) => {
    for (const c of x.children.get(parent.id) ?? []) {
      if (c.archived_at !== null || below.size >= 200) continue;
      below.set(c.id, c);
      walk(c);
    }
  };
  walk(n);
  return findingsForNodes(db, [...below.keys()]).map((f) => {
    const { ref: at, name: name2, alias } = head(x, below.get(f.node_id));
    return { ...f, from: { ref: at, name: name2, alias } };
  });
}
function mapNow(db, live = []) {
  const active = live.filter(
    (r) => r.status === "running" || r.queued_at !== null
  );
  const x = index(db);
  const ids = active.map((r) => Number(r.ref.slice(1)));
  const rows = ids.length && hasTasks(db) ? all2(
    db,
    `SELECT ${taskColumns(db)} FROM tasks WHERE id IN (${ids.map(() => "?").join(",")}) LIMIT 100`,
    ...ids
  ) : [];
  const byRef = new Map(active.map((r) => [r.ref, r]));
  const jobs = jobNames(db);
  const who2 = taskPeople(
    db,
    rows.map((r) => r.id)
  );
  const groups = /* @__PURE__ */ new Map();
  for (const row3 of rows) {
    const node = row3.part === null ? void 0 : x.byId.get(row3.part);
    const key = node ? ref(node.id) : "";
    const group = groups.get(key) ?? {
      part: node ? { ref: ref(node.id), name: node.name, alias: head(x, node).alias } : null,
      tasks: []
    };
    group.tasks.push(
      taskView(row3, byRef.get(`t${row3.id}`), jobs, who2.get(row3.id))
    );
    groups.set(key, group);
  }
  const list4 = [...groups.values()].sort(
    (a, b) => b.tasks.length - a.tasks.length || (a.part ? 0 : 1) - (b.part ? 0 : 1) || (a.part?.ref ?? "").localeCompare(b.part?.ref ?? "")
  );
  return {
    /** 正在处理事件的负责人（顶栏「Atrium 负责人在处理」）。 */
    leaders: [...x.leaders.values()].filter((l) => l.wake?.status === "running").map((l) => ({ ref: l.ref, name: l.name, doing: l.wake.summary })),
    running: active.filter((r) => r.queued_at === null).length,
    queued: active.filter((r) => r.queued_at !== null).length,
    blocked: live.filter((r) => r.status === "blocked").length,
    groups: list4
  };
}
function mapSignature(db) {
  const q6 = (sql) => {
    try {
      return Object.values(
        db.prepare(sql).get() ?? {}
      ).join(":");
    } catch {
      return "-";
    }
  };
  return [
    q6("SELECT max(updated_at),count(*) FROM tasks"),
    q6("SELECT max(id) FROM task_events"),
    q6("SELECT max(updated_at),count(*) FROM org_nodes"),
    q6("SELECT max(updated_at),count(*) FROM org_docs"),
    q6("SELECT max(updated_at),count(*),max(id) FROM org_points"),
    q6("SELECT count(*),max(rowid) FROM task_also"),
    q6("SELECT count(*),max(queued_at) FROM task_queue"),
    q6("SELECT max(updated_at),count(*) FROM job_roles"),
    q6("SELECT max(updated_at),count(*) FROM org_skills"),
    q6("SELECT max(id),max(ended_at) FROM task_deliveries"),
    q6("SELECT max(updated_at),count(*) FROM patrol_findings"),
    q6(
      "SELECT max(updated_at),max(wake_at),max(wake_ended_at),sum(wakes),count(*) FROM org_leaders"
    ),
    q6("SELECT max(id),max(updated_at),max(acked_at) FROM task_inbox"),
    q6("SELECT max(updated_at),count(*) FROM memos"),
    q6("SELECT max(id),max(superseded_at) FROM decisions")
  ].join("|");
}

// server/map/leaders.ts
var EVENTS_MAX = 30;
var ESCALATIONS_MAX = 20;
var hasInbox = (db) => !!one2(
  db,
  "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='task_inbox'"
);
var parse5 = (text6) => {
  try {
    const value = text6 === null ? null : JSON.parse(text6);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};
var text5 = (value, max = 200) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const line = value.replace(/\s+/g, " ").trim();
  const chars4 = Array.from(line);
  return chars4.length > max ? `${chars4.slice(0, max - 1).join("")}\u2026` : line;
};
function aliases(db) {
  const map = /* @__PURE__ */ new Map();
  for (const row3 of all2(
    db,
    "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600"
  )) {
    const alias = text5(parse5(row3.fields).alias, 40);
    if (alias) map.set(`o${row3.node_id}`, alias);
  }
  return map;
}
function titles(db, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return /* @__PURE__ */ new Map();
  return new Map(
    all2(
      db,
      `SELECT id,title FROM tasks WHERE id IN (${unique.map(() => "?").join(",")}) LIMIT ${unique.length}`,
      ...unique
    ).map((r) => [r.id, r.title])
  );
}
function pendingCount(db, leader) {
  if (!hasInbox(db)) return 0;
  return all2(
    db,
    "SELECT kind,detail FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) ORDER BY id DESC LIMIT 200",
    leader
  ).filter((r) => eventLevel(r.kind, parse5(r.detail)) === "action").length;
}
var rowOf2 = (view7, db, alias) => ({
  ref: view7.ref,
  name: view7.name,
  worker: view7.worker,
  nodes: view7.nodes.map((n) => ({ ...n, alias: alias.get(n.ref) ?? "" })),
  wake: view7.wake,
  pending: Math.min(99, pendingCount(db, view7.ref))
});
function mapLeaders(db) {
  const alias = aliases(db);
  return {
    leaders: listLeaders(db).leaders.map((v) => rowOf2(v, db, alias))
  };
}
function eventState(row3, handedOff) {
  if (row3.acked_at !== null) return handedOff ? "handed_off" : "done";
  return row3.delivered_at !== null ? "doing" : "waiting";
}
function events(db, leader, names2) {
  const rows = all2(
    db,
    "SELECT * FROM task_inbox WHERE subscriber=? AND (actor IS NULL OR actor<>subscriber) ORDER BY updated_at DESC,id DESC LIMIT 200",
    leader
  ).map((row3) => ({ row: row3, detail: parse5(row3.detail) })).filter(({ row: row3, detail: detail2 }) => eventLevel(row3.kind, detail2) === "action").slice(0, EVENTS_MAX);
  const handoffs = all2(
    db,
    "SELECT dedupe_key,updated_at FROM task_inbox WHERE source='leader' AND dedupe_key LIKE '%:handoff' AND json_extract(detail,'$.handoff.from')=? ORDER BY id DESC LIMIT 200",
    leader
  );
  const handedOff = (row3) => row3.acked_at !== null && handoffs.some(
    (h) => h.dedupe_key === `${row3.dedupe_key}:handoff` && Math.abs(h.updated_at - row3.acked_at) < 6e4
  );
  const title2 = titles(
    db,
    rows.flatMap(({ row: row3 }) => row3.task_id === null ? [] : [row3.task_id])
  );
  return rows.map(({ row: row3, detail: detail2 }) => {
    const from = typeof detail2.from === "string" ? detail2.from : null;
    return {
      id: row3.id,
      at: row3.updated_at,
      task: row3.task_id === null ? null : {
        ref: `t${row3.task_id}`,
        title: title2.get(row3.task_id) ?? text5(detail2.title, 120) ?? "\uFF08\u5DF2\u5220\u9664\uFF09"
      },
      what: row3.kind === "escalated" && typeof detail2.kind_label === "string" ? `\u4E0A\u4EA4\uFF1A${detail2.kind_label}` : eventWord(row3.kind),
      why: text5(detail2.reason) ?? text5(detail2.note),
      from: row3.kind === "escalated" && from ? personOf(from, names2) : null,
      count: row3.count,
      state: eventState(row3, handedOff(row3))
    };
  });
}
function escalations(db, leader, names2) {
  const rows = all2(
    db,
    `SELECT * FROM task_inbox WHERE source='leader' AND kind='escalated' AND actor=? ORDER BY id DESC LIMIT ${ESCALATIONS_MAX}`,
    leader
  );
  const title2 = titles(
    db,
    rows.flatMap((r) => r.task_id === null ? [] : [r.task_id])
  );
  return rows.map((row3) => {
    const detail2 = parse5(row3.detail);
    return {
      id: row3.id,
      at: row3.created_at,
      kind: typeof detail2.kind === "string" ? detail2.kind : "",
      label: typeof detail2.kind_label === "string" ? detail2.kind_label : "\u4E0A\u4EA4",
      task: row3.task_id === null ? null : {
        ref: `t${row3.task_id}`,
        title: title2.get(row3.task_id) ?? "\uFF08\u5DF2\u5220\u9664\uFF09"
      },
      note: text5(detail2.reason, 600) ?? "",
      to: personOf(row3.subscriber, names2),
      seen: row3.acked_at !== null
    };
  });
}
function memoPart(db, owner) {
  const memo = readMemo(db, owner);
  return {
    memo: memo.body,
    memo_max: MEMO_MAX,
    memo_updated_at: memo.updated_at,
    decisions: listDecisions(db, owner, { all: true, limit: PAGE_MAX }).decisions
  };
}
function mapLeader(db, reference) {
  if (reference === "secretary")
    return {
      kind: "secretary",
      ref: "secretary",
      name: "\u79D8\u4E66",
      ...memoPart(db, "secretary")
    };
  const view7 = showLeader(db, reference);
  const names2 = peopleNames(db);
  const inbox = hasInbox(db);
  return {
    kind: "leader",
    ...rowOf2(view7, db, aliases(db)),
    ...memoPart(db, view7.ref),
    events: inbox ? events(db, view7.ref, names2) : [],
    escalations: inbox ? escalations(db, view7.ref, names2) : []
  };
}

// server/map/write.ts
var FIELDS = {
  what: "text",
  alias: "text",
  analogy: "text",
  now: "text",
  next: "text",
  when: "text",
  uses: "list",
  flow: "list"
};
var usage10 = (message4) => new Problem(400, message4, "usage");
function mergeFields(current2, input) {
  const next = { ...current2 };
  for (const key of Object.keys(input)) {
    if (["detail", "reason", "rev", "applies"].includes(key)) continue;
    const type = FIELDS[key];
    if (!type) throw usage10(`--${key}: \u4E0D\u662F\u5168\u666F\u5B57\u6BB5`);
    const value = input[key];
    if (value === void 0) continue;
    if (type === "text") {
      if (typeof value !== "string") throw usage10(`--${key}: \u5E94\u4E3A\u6587\u672C`);
      if (value.trim()) next[key] = value.trim();
      else delete next[key];
    } else {
      const list4 = (Array.isArray(value) ? value : [value]).map((v) => {
        if (typeof v !== "string") throw usage10(`--${key}: \u5E94\u4E3A\u6587\u672C`);
        return v.trim();
      });
      const kept = list4.filter(Boolean);
      if (kept.length) next[key] = kept;
      else delete next[key];
    }
  }
  return next;
}
function editMap(db, address, input, actor) {
  const node = nodeByAddress(db, address);
  if (node.kind !== "concern" && typeof input.when === "string" && input.when.trim())
    throw usage10(
      `--when: \u4E13\u5458\u8BF7\u7528 atrium specialist edit <\u4E13\u5458> --invite-when \u4FEE\u6539\uFF1B${ref(node.id)} ${node.name} \u662F\u7EC4\u7EC7\u8282\u70B9`
    );
  const doc2 = one2(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id
  );
  const current2 = doc2 ? JSON.parse(doc2.fields) : {};
  const fields = mergeFields(current2, input);
  const applies = input.applies === void 0 ? void 0 : appliesText(resolveApplies(db, input.applies));
  if (applies !== void 0 && !node.aspect)
    throw usage10(
      `--applies: ${ref(node.id)} ${node.name} \u4E0D\u662F\u7BA1\u65B9\u9762\u7684\u90E8\u5206\uFF1B\u7BA1\u4E1C\u897F\u7684\u90E8\u5206\u7684\u8981\u70B9\u53EA\u5BF9\u672C\u5757\u53CA\u4E0B\u5C42\u751F\u6548`
    );
  const appliesChanged = applies !== void 0 && applies !== (node.applies ?? null);
  const changed2 = appliesChanged || JSON.stringify(fields) !== JSON.stringify(current2) || input.detail !== void 0 && input.detail !== (doc2?.body ?? "");
  if (!changed2)
    throw usage10(
      "\u6CA1\u6709\u8981\u6539\u7684\uFF1A\u7ED9 --what\u3001--uses\u3001--flow\u3001--alias\u3001--analogy\u3001--now\u3001--next\u3001--when\u3001--applies \u6216 --detail \u6587\u4EF6"
    );
  if (input.rev !== void 0 && input.detail === void 0)
    throw usage10("--rev: \u53EA\u7528\u4E8E --detail \u4FEE\u6539\u7AE0\u7A0B\u6B63\u6587");
  if (appliesChanged) {
    if (node.parent_id === null && actor !== "u1" || !canEdit(nodes(db), node, actor))
      throw new Problem(
        403,
        `--applies \u65E0\u6743\u9650\uFF1A${actor} \u4E0D\u662F ${ref(node.id)} \u7684 leader \u6216\u7956\u5148 leader`
      );
    db.prepare("UPDATE org_nodes SET applies=?,updated_at=? WHERE id=?").run(
      applies,
      Date.now(),
      node.id
    );
    const rest = Object.keys(input).filter(
      (k) => k !== "applies" && input[k] !== void 0
    );
    if (!rest.length) return { node: ref(node.id) };
  }
  return editOverviewFields(
    db,
    ref(node.id),
    fields,
    actor,
    input.detail === void 0 ? void 0 : {
      body: input.detail,
      rev: typeof input.rev === "string" ? input.rev : void 0,
      reason: typeof input.reason === "string" && input.reason.trim() ? input.reason : "\u6539\u5168\u666F\u6280\u672F\u7EC6\u8282\uFF08atrium map edit --detail\uFF09"
    }
  );
}
var CHILD = {
  org: "project",
  project: "module",
  module: "module",
  concern: null
};
function addMap(db, input, actor) {
  const parent = nodeByAddress(db, String(input.parent ?? ""));
  const name2 = typeof input.name === "string" ? input.name.trim() : "";
  if (!name2) throw usage10("\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const kind = input.kind ?? CHILD[parent.kind];
  if (!kind || parent.kind === "concern")
    throw usage10(`${ref(parent.id)} \u662F\u5173\u6CE8\u70B9\uFF0C\u4E0B\u9762\u4E0D\u80FD\u518D\u52A0\u90E8\u5206`);
  if (kind === "concern")
    throw usage10("\u5173\u6CE8\u70B9\u8282\u70B9\u5DF2\u4E0B\u7EBF\uFF1B\u8BF7\u7528 atrium specialist add \u521B\u5EFA\u4E13\u5458");
  const slug = (input.slug ?? name2).trim().toLowerCase();
  if (!/^(?:[a-z0-9-]|[㐀-鿿])+$/.test(slug))
    throw usage10(
      `--slug: \u540D\u79F0\u300C${name2}\u300D\u4E0D\u80FD\u76F4\u63A5\u5F53\u8DEF\u5F84\u540D\uFF0C\u8BF7\u7ED9 --slug\uFF08\u5C0F\u5199\u82F1\u6570\u3001\u8FDE\u5B57\u7B26\u6216\u4E2D\u6587\uFF09`
    );
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason : "\u5168\u666F\u56FE\u52A0\u4E00\u5757\uFF08atrium map add\uFF09";
  const fields = mergeFields(
    {},
    Object.fromEntries(
      ["alias", "analogy", "what"].filter((k) => input[k] !== void 0).map((k) => [k, input[k]])
    )
  );
  for (const [key, value] of Object.entries(fields))
    validateOverviewField(key, value);
  const created = addNode(
    db,
    { parent: ref(parent.id), slug, kind, name: name2, reason },
    actor
  );
  if (Object.keys(fields).length)
    editOverviewFields(db, ref(created.id), fields, actor);
  return {
    node: ref(created.id),
    parent: ref(parent.id),
    name: name2,
    kind: created.kind,
    aspect: kind === "aspect",
    slug
  };
}

// server/map/people.ts
var hasTable4 = (db, name2) => !!one2(
  db,
  "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
  name2
);
function aliases2(db) {
  if (!hasTable4(db, "org_docs")) return /* @__PURE__ */ new Map();
  return new Map(
    all2(
      db,
      "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600"
    ).map((r) => {
      try {
        const a = JSON.parse(r.fields).alias;
        return [r.node_id, typeof a === "string" ? a.trim() : ""];
      } catch {
        return [r.node_id, ""];
      }
    })
  );
}
function mapSkills(db) {
  if (!hasTable4(db, "org_skills")) return { skills: [] };
  const list4 = nodes(db);
  const alias = aliases2(db);
  const roles = hasTable4(db, "job_roles") ? listJobRoles(db) : [];
  const skills = all2(
    db,
    "SELECT id,slug,name,description FROM org_skills WHERE archived_at IS NULL ORDER BY slug LIMIT 200"
  ).map((s) => {
    const parts = all2(
      db,
      "SELECT node_id FROM org_skill_bindings WHERE skill_id=? ORDER BY node_id LIMIT 50",
      s.id
    ).flatMap(({ node_id }) => {
      const n = list4.find((x) => x.id === node_id);
      return n && n.archived_at === null ? [
        {
          kind: "part",
          ref: `o${n.id}`,
          name: alias.get(n.id) || n.name
        }
      ] : [];
    });
    const last = one2(
      db,
      "SELECT at,author,reason FROM org_skill_revisions WHERE skill_id=? ORDER BY rev DESC LIMIT 1",
      s.id
    );
    return {
      slug: s.slug,
      name: s.name,
      description: s.description,
      on: [
        ...roles.filter((r) => r.skills.includes(s.slug)).map((r) => ({ kind: "role", ref: r.ref, name: r.name })),
        ...parts
      ],
      last: last ?? null
    };
  });
  return { skills };
}
var partOf3 = (r, alias) => r.part_id === null ? null : {
  ref: `o${r.part_id}`,
  name: r.part_name ?? `o${r.part_id}`,
  alias: alias.get(r.part_id) ?? ""
};
var roleRow = (r, alias) => ({
  ref: r.ref,
  name: r.name,
  description: r.description,
  preferred: r.preferred,
  checks: r.checks,
  skills: r.skills,
  running: r.running ?? 0,
  part: partOf3(r, alias)
});
function mapRoles(db) {
  if (!hasTable4(db, "job_roles")) return { roles: [] };
  const alias = aliases2(db);
  return { roles: listJobRoles(db).map((r) => roleRow(r, alias)) };
}
function mapPartRoles(db, address) {
  if (!hasTable4(db, "job_roles")) return { part: null, roles: [] };
  const alias = aliases2(db);
  const { part, specialists } = specialistsForPart(db, address);
  return {
    part,
    roles: specialists.map((r) => ({ ...roleRow(r, alias), scope: r.scope }))
  };
}
async function mapRole(db, address, live = []) {
  if (!hasTable4(db, "job_roles"))
    throw new Problem(404, `\u4E13\u5458 ${address} \u4E0D\u5B58\u5728`, "not_found");
  const role = getJobRole(db, address);
  const liveBy = new Map(live.map((row3) => [row3.ref, row3]));
  const jobs = jobNames(db);
  const rows = all2(
    db,
    `SELECT ${taskColumns(db)} FROM tasks WHERE job_id=?
      ORDER BY CASE WHEN status='running' THEN 0 WHEN status='blocked' THEN 1 WHEN status='todo' THEN 2 ELSE 3 END,
        updated_at DESC LIMIT 60`,
    role.id
  );
  const who2 = taskPeople(
    db,
    rows.map((r) => r.id)
  );
  const involved = involvedOfTasks(db, rows);
  const tasks = rows.map(
    (r) => taskView(r, liveBy.get(`t${r.id}`), jobs, who2.get(r.id), {
      also: involved.get(r.id)
    })
  );
  const report = await workersReport(db, role.ref);
  const skills = mapSkills(db).skills.filter(
    (s) => role.skills.includes(s.slug)
  );
  return {
    ref: role.ref,
    name: role.name,
    part: partOf3(role, aliases2(db)),
    description: role.description,
    preferred: role.preferred,
    checks: role.checks,
    review_goal: role.review_goal,
    review_points: role.review_points,
    review_bottom: role.review_bottom,
    invite_when: role.invite_when,
    skills,
    tasks,
    workers: combinations(report.stats),
    suggestions: report.suggestions.map(adviceView)
  };
}
var combinations = (stats) => stats.filter((s) => s.scope === "combination" && s.deliveries > 0);
var adviceView = ({ stat: stat5, advice }) => ({
  worker: stat5.worker,
  role: stat5.role,
  action: advice.action,
  reason: advice.reason
});
async function mapWorkers(db, role) {
  if (!hasTable4(db, "task_deliveries"))
    return { role: null, rows: [], suggestions: [] };
  const report = await workersReport(db, role || void 0);
  return {
    role: report.role ? { ref: report.role.ref, name: report.role.name } : null,
    rows: combinations(report.stats),
    suggestions: report.suggestions.map(adviceView)
  };
}
function deliveryResult(d) {
  if (d.verdict === "rejected") return { label: "\u88AB\u4F60\u5426\u6389", tone: "orange" };
  const returns = d.gate_return_count + d.merge_returns.length;
  switch (d.final_result) {
    case "\u5931\u8D25":
      return { label: "\u6CA1\u4EA4\u4ED8", tone: "orange" };
    case "\u6362\u4EBA":
      return { label: "\u6362\u4EBA", tone: "orange" };
    case "\u53D7\u963B":
      return { label: "\u5361\u4F4F", tone: "orange" };
    case "\u5408\u5165\u9000\u56DE":
      return { label: "\u5408\u5165\u9000\u56DE", tone: "orange" };
    case "\u53D6\u6D88":
      return { label: "\u53D6\u6D88", tone: "gray" };
    case "\u53D8\u57FA\u51B2\u7A81":
      return { label: "\u5408\u5165\u51B2\u7A81", tone: "gray" };
  }
  if (d.ended_at === null) return { label: "\u8FDB\u884C\u4E2D", tone: "green" };
  if (d.verdict === "fixed") return { label: "\u4E0A\u7EBF\u540E\u8FD4\u4FEE", tone: "amber" };
  if (returns > 0)
    return {
      label: `\u6253\u56DE ${returns} \u6B21`,
      tone: returns > 1 ? "orange" : "amber"
    };
  if (d.first_pass) return { label: "\u4E00\u6B21\u901A\u8FC7", tone: "green" };
  return d.final_result === "\u5DF2\u5408\u5165" ? { label: "\u5DF2\u5408\u5165", tone: "gray" } : { label: "\u7B49\u5408\u5165", tone: "blue" };
}
var GATE_LABEL2 = {
  pr_exists: "\u5F00 PR",
  local_check: "\u672C\u5730\u68C0\u67E5",
  ci: "\u8FDC\u7AEF\u68C0\u67E5",
  finished: "\u63D0\u4EA4\u63A8\u9001",
  file_growth: "\u6587\u4EF6\u81A8\u80C0",
  claims_verified: "\u6C47\u62A5\u5C5E\u5B9E",
  screenshot: "\u9644\u622A\u56FE"
};
function gateReason(text6) {
  const at = text6.indexOf("\uFF1A");
  const gate = at < 0 ? text6 : text6.slice(0, at);
  const evidence = at < 0 ? "" : text6.slice(at + 1).trim();
  const label5 = GATE_LABEL2[gate] ?? gate;
  return !evidence || evidence === "\u672A\u8FC7" ? `${label5}\u6CA1\u8FC7` : evidence;
}
function deliveryStory(d) {
  return [
    d.incidents.length ? `\u51FA\u4E8B\uFF1A${d.incidents.join("\u3001")}` : "",
    d.gate_returns.length ? `\u9A8C\u6536\u6CA1\u8FC7\uFF1A${d.gate_returns.map(gateReason).join("\uFF1B")}` : "",
    d.merge_returns.length ? `\u5408\u5165\u9000\u56DE\uFF1A${d.merge_returns.join("\uFF1B")}` : "",
    d.rebase_conflicts ? `\u5408\u5165\u65F6\u548C\u522B\u4EBA\u51B2\u7A81 ${d.rebase_conflicts} \u6B21\uFF08\u4E0D\u7B97\u5B83\u7684\uFF09` : "",
    d.verdict_note ?? ""
  ].filter(Boolean).join("\uFF1B");
}
function profileNotes(layers) {
  const notes2 = [];
  const re = /^[（(](\d{4})-(\d{2})-(\d{2})\s*([^：:（）()]{0,12})[：:]\s*([\s\S]+?)[）)]?\s*$/;
  for (const layer of layers)
    for (const block of layer.body.split(/\n\s*\n|\n(?=[（(]\d{4}-)/)) {
      const m = re.exec(block.trim());
      if (!m) continue;
      const tag = m[4].trim();
      const by = !tag || tag === "\u89C2\u5BDF" ? "\u79D8\u4E66" : tag.replace(/^u1|^用户/, "\u4F60").replace(/观察$/, "") || "\u79D8\u4E66";
      notes2.push({
        at: `${m[1]}-${m[2]}-${m[3]}`,
        date: `${m[2]}-${m[3]}`,
        text: m[5].replace(/\s*\n\s*/g, " ").trim(),
        by,
        seq: notes2.length
      });
    }
  return notes2.sort((a, b) => b.at.localeCompare(a.at) || a.seq - b.seq).map(({ date, text: text6, by }) => ({ date, text: text6, by }));
}
async function mapWorker(db, id3) {
  parseWorker(id3);
  const resolved = await resolveWorker(id3, db);
  const report = hasTable4(db, "task_deliveries") ? await workerReport(db, id3) : null;
  const profile = resolved.profile;
  const records = report?.deliveries ?? [];
  if (!records.length && !profile.layers.some((l) => l.layer !== "harness"))
    throw new Problem(
      404,
      `\u6267\u884C\u8005 ${id3} \u6CA1\u6709\u4EA4\u4ED8\u8BB0\u5F55\uFF0C\u4E5F\u6CA1\u6709\u6863\u6848`,
      "not_found"
    );
  return {
    worker: resolved.id,
    trust: profile.rules.trust ?? "unknown",
    stats: report?.stats ?? [],
    deliveries: records.slice(0, 200).map((d) => ({
      task: d.task_ref,
      title: d.task_title,
      role: d.job_ref ? { ref: d.job_ref, name: d.job_name ?? d.job_ref } : null,
      result: deliveryResult(d),
      duration_ms: d.duration_ms,
      story: deliveryStory(d)
    })),
    notes: profileNotes(profile.layers),
    suggestions: (report?.suggestions ?? []).map(adviceView)
  };
}

// server/map/routes.ts
var WEB = join29(packageRoot, "server", "map", "web");
var asset = (name2) => readFileSync14(join29(WEB, name2), "utf8");
var CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
var isLoopback = (address) => LOOPBACK.has(address ?? "");
var expiredPage = (message4) => `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atrium \u5168\u666F</title>
<body style="font:16px/1.6 -apple-system,'PingFang SC',sans-serif;max-width:32em;margin:18vh auto;padding:0 20px;color:#333">
<h1 style="font-size:20px;margin:0 0 8px">${message4}</h1>
<p style="margin:0;color:#666">\u5728\u7EC8\u7AEF\u8FD0\u884C <code style="background:#f2f2f2;padding:2px 6px;border-radius:4px">atrium map</code>\uFF0C\u4F1A\u91CD\u65B0\u6253\u5F00\u4E00\u4E2A\u767B\u5F55\u94FE\u63A5\u3002</p>
</body></html>`;
var q5 = (value) => value ?? {};
var id2 = (request2) => request2.params.id;
function registerMapRoutes(app2, db, options) {
  ensureOrgTables(db);
  const live = () => options.live().catch(() => []);
  const pages = {
    "/map": ["text/html; charset=utf-8", asset("index.html")],
    "/map/app.js": ["text/javascript; charset=utf-8", asset("app.js")],
    "/map/format.js": ["text/javascript; charset=utf-8", asset("format.js")],
    "/map/style.css": ["text/css; charset=utf-8", asset("style.css")]
  };
  for (const [url, [type, body3]] of Object.entries(pages))
    app2.get(
      url,
      (_request, reply) => reply.header("content-type", type).header("cache-control", "no-store").header("content-security-policy", CSP).header("x-frame-options", "DENY").send(body3)
    );
  app2.get("/map/login", (request2, reply) => {
    const query2 = q5(request2.query);
    const session = options.login.exchange(query2.code);
    if (!session)
      return reply.code(401).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(expiredPage("\u767B\u5F55\u94FE\u63A5\u5DF2\u5931\u6548\uFF08\u53EA\u80FD\u7528\u4E00\u6B21\uFF0C2 \u5206\u949F\u5185\u6709\u6548\uFF09"));
    const node = /^o[1-9][0-9]{0,8}$/.test(query2.node ?? "") ? `#${query2.node}` : "";
    return reply.code(303).header("set-cookie", sessionCookie(session.token)).header("cache-control", "no-store").header("location", `/map${node}`).send();
  });
  app2.post("/api/map/login", { bodyLimit: 1024 }, () => {
    const link = options.login.link();
    return {
      path: `/map/login?code=${link.token}`,
      expires_at: link.expires_at,
      ttl_ms: LINK_TTL_MS
    };
  });
  app2.get("/api/map/tree", (request2) => {
    const query2 = q5(request2.query);
    return mapTree(db, query2.root || void 0, parseDepth(query2.depth));
  });
  app2.get("/api/map/nodes/:id", async (request2) => {
    const query2 = q5(request2.query);
    const node = mapNode(db, id2(request2), await live());
    return query2.depth === void 0 ? node : { ...node, tree: mapTree(db, node.ref, parseDepth(query2.depth)).tree };
  });
  app2.get("/api/map/now", async () => mapNow(db, await live()));
  app2.get("/api/map/roles", () => mapRoles(db));
  app2.get(
    "/api/map/roles/:id",
    async (request2) => mapRole(db, id2(request2), await live())
  );
  app2.get("/api/map/specialists", (request2) => {
    const part = q5(request2.query).part;
    return part ? { specialists: mapPartRoles(db, part).roles } : { specialists: mapRoles(db).roles };
  });
  app2.get(
    "/api/map/specialists/:id",
    async (request2) => mapRole(db, id2(request2), await live())
  );
  app2.get("/api/map/skills", () => mapSkills(db));
  app2.get("/api/map/leaders", () => mapLeaders(db));
  app2.get("/api/map/leaders/:id", (request2) => mapLeader(db, id2(request2)));
  app2.get(
    "/api/map/workers",
    (request2) => mapWorkers(db, q5(request2.query).role)
  );
  app2.get("/api/map/workers/:id", (request2) => mapWorker(db, id2(request2)));
  app2.get(
    "/api/map/context/:id",
    (request2) => mapContext(
      db,
      id2(request2),
      parseMax(q5(request2.query).max),
      q5(request2.query).also
    )
  );
  app2.patch(
    "/api/map/nodes/:id",
    { bodyLimit: 64 * 1024 },
    (request2) => editMap(
      db,
      id2(request2),
      request2.body ?? {},
      resolveActor(db, q5(request2.query).as)
    )
  );
  app2.post(
    "/api/map/nodes",
    { bodyLimit: 16 * 1024 },
    (request2, reply) => reply.code(201).send(
      addMap(
        db,
        request2.body ?? {},
        resolveActor(db, q5(request2.query).as)
      )
    )
  );
  const streams = /* @__PURE__ */ new Set();
  let closing = false;
  app2.addHook("preClose", async () => {
    closing = true;
    for (const close of [...streams]) close();
  });
  app2.get("/api/map/stream", (request2, reply) => {
    if (closing) return reply.code(503).send({ restarting: true });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      connection: "keep-alive"
    });
    let last = mapSignature(db);
    let beats = 0;
    res.write(`retry: 3000
event: hello
data: {}

`);
    const timer = setInterval(() => {
      const now = mapSignature(db);
      if (now !== last) {
        last = now;
        res.write("event: changed\ndata: {}\n\n");
      } else if (++beats % 10 === 0) res.write(": ping\n\n");
    }, options.pollMs ?? 1500);
    const close = () => {
      if (!streams.delete(close)) return;
      clearInterval(timer);
      res.end();
    };
    streams.add(close);
    request2.raw.on("close", close);
  });
}
var notLocal = () => new Problem(403, "\u5168\u666F\u7F51\u9875\u53EA\u63A5\u53D7\u672C\u673A\u8BBF\u95EE", "conflict");

// server/app.ts
function openDatabase(data2) {
  const db = new DatabaseSync4(join30(data2, "atrium.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;"
  );
  return db;
}
async function createApp(options) {
  mkdirSync17(options.data, { recursive: true, mode: 448 });
  const db = openDatabase(options.data);
  const auth = new UserAuth(db, options.data);
  const app2 = Fastify({
    logger: { level: "warn" },
    bodyLimit: 4 * 1024 * 1024,
    forceCloseConnections: "idle"
  });
  app2.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      options.onRoute?.(method, route.url);
  });
  app2.addHook("onClose", async () => db.close());
  app2.setErrorHandler((error, request2, reply) => {
    const status = error instanceof z.ZodError ? 400 : error instanceof Problem ? error.statusCode : error.statusCode ?? 500;
    void reply.code(status).send({
      code: error instanceof Problem ? error.code : status === 400 ? "usage" : status === 403 || status === 409 ? "conflict" : status === 404 ? "not_found" : "internal",
      ...error instanceof Problem && error.candidates?.length ? { candidates: error.candidates } : {},
      ...error instanceof Problem && error.nextCommand ? { nextCommand: error.nextCommand } : {},
      error: error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\uFF1B") : status >= 500 ? "\u670D\u52A1\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u672C\u5730\u65E5\u5FD7" : error instanceof Error ? error.message : String(error)
    });
    if (status >= 500) {
      if (/^\/api\/auth(\/|$)/.test(request2.url))
        app2.log.error("\u8BA4\u8BC1\u5904\u7406\u5931\u8D25\uFF08\u8BE6\u60C5\u5DF2\u9690\u85CF\uFF09");
      else app2.log.error(error);
    }
  });
  app2.addHook("onRequest", async (request2, reply) => {
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
    let hostname;
    try {
      hostname = new URL(`http://${request2.headers.host}`).hostname;
    } catch {
      throw new Problem(403, "\u4E0D\u63A5\u53D7\u6B64 Host");
    }
    if (!["localhost", "atrium.localhost", "127.0.0.1", "[::1]"].includes(
      hostname
    ))
      throw new Problem(403, "\u7BA1\u7406\u5165\u53E3\u4EC5\u9762\u5411\u672C\u673A");
    const origin = request2.headers.origin;
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        throw new Problem(403, "Origin \u683C\u5F0F\u65E0\u6548");
      }
      if (host !== request2.headers.host)
        throw new Problem(403, "\u4E0D\u63A5\u53D7\u8DE8\u7AD9\u8BF7\u6C42");
    }
  });
  const requireRotation = (authorization) => {
    const control = options.controlToken;
    if (!auth.validUser(authorization) && !(control && sameSecret(authorization?.replace(/^Bearer /i, "") ?? "", control)))
      throw new Problem(
        401,
        "\u7528\u6237\u6216\u5B9E\u4F8B\u63A7\u5236\u51ED\u636E\u65E0\u6548",
        "auth_required",
        void 0,
        "atrium auth rotate"
      );
  };
  const leaderTokens = new LeaderTokens();
  let inbox;
  registerLeaderGuard(app2, db, leaderTokens, () => inbox());
  const mapLogin = new MapLogin(db);
  app2.addHook("onRequest", async (request2, reply) => {
    if (options.auth === false || leaderOf(request2)) return;
    const route = request2.routeOptions.url ?? "";
    if (route === "/api/auth/rotate") {
      requireRotation(request2.headers.authorization);
      return;
    }
    const policy = authPolicy(request2.method, route);
    if (policy.startsWith("map-")) {
      if (!isLoopback(request2.socket.remoteAddress)) throw notLocal();
      if (policy === "map-login") return;
      if (mapLogin.valid(request2.headers.cookie)) return;
      if (policy === "map-page")
        return reply.code(401).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(expiredPage("\u5168\u666F\u7F51\u9875\u7684\u767B\u5F55\u5DF2\u5931\u6548"));
    } else if (policy !== "user") return;
    if (auth.validUser(request2.headers.authorization)) return;
    if (mapLogin.valid(request2.headers.cookie))
      throw new Problem(
        403,
        "\u8FD9\u4E2A\u9875\u9762\u7684\u6570\u636E\u63A5\u53E3\u6CA1\u5F00\u653E\u7ED9\u7F51\u9875\uFF08Atrium \u7684\u95EE\u9898\uFF0C\u4E0D\u662F\u4F60\u7684\u767B\u5F55\uFF09",
        "map_session_forbidden"
      );
    throw new Problem(
      401,
      request2.headers.authorization ? "\u7528\u6237\u8BA4\u8BC1\u5931\u6548\uFF1B\u8BF7\u8FD0\u884C atrium auth rotate\uFF08\u786E\u8BA4 ATRIUM_DATA \u6307\u5411\u5F53\u524D\u6570\u636E\u76EE\u5F55\uFF09" : "\u670D\u52A1\u5DF2\u5347\u7EA7\uFF0C\u8BF7\u91CD\u65B0\u8FD0\u884C\u547D\u4EE4\uFF1B\u82E5\u4ECD\u5931\u8D25\uFF0C\u8BF7\u8FD0\u884C atrium auth rotate\uFF08\u786E\u8BA4 ATRIUM_DATA \u6307\u5411\u5F53\u524D\u6570\u636E\u76EE\u5F55\uFF09",
      "auth_required",
      void 0,
      "atrium auth rotate"
    );
  });
  app2.post("/api/auth/rotate", { bodyLimit: 16 * 1024 }, () => {
    auth.rotate();
    return { rotated: true };
  });
  const taskOptions = {
    data: resolve3(options.data),
    ...runnerEnvOptions(),
    ...options.tasks
  };
  ensureTaskTables(db);
  ensureOrgTables(db);
  migrateSpecialists(db);
  const taskRunner = registerTaskRoutes(app2, db, taskOptions);
  registerPatrolRoutes(app2, db, taskRunner);
  const secretaryFallback = new SecretaryFallback(
    taskRunner.inbox,
    resolve3(options.data),
    { batchMs: options.tasks?.batchMs }
  );
  secretaryFallback.start();
  app2.addHook("preClose", async () => secretaryFallback.close());
  inbox = () => taskRunner.inbox;
  registerOrgRoutes(app2, db);
  importLegacyState(db, { legacyDir: options.legacyDir });
  registerLeaderRoutes(app2, db, taskRunner.inbox);
  registerMemoRoutes(app2, db);
  const leaderWaker = new LeaderWaker(db, taskRunner.inbox, leaderTokens, {
    data: resolve3(options.data),
    env: options.tasks?.env,
    url: () => options.serviceUrl,
    ...leaderEnvOptions(),
    ...options.leaders
  });
  leaderWaker.start();
  app2.addHook("preClose", async () => leaderWaker.close());
  registerGoalRoutes(app2, db, {
    data: resolve3(options.data),
    ...options.goals
  });
  registerSkillRoutes(app2, db);
  registerMapRoutes(app2, db, {
    login: mapLogin,
    live: async () => (await taskRunner.top()).rows,
    pollMs: options.mapPollMs
  });
  registerQuotaRoute(app2, {
    bin: options.quotaBin,
    db,
    readers: options.quotaReaders
  });
  return { app: app2, db, taskRunner };
}

// server/main.ts
var data = dataDirectory();
var portTaken = async (port) => {
  const owner = await probePort(port);
  if (owner.kind === "free") return null;
  return portTakenMessage(port, owner, data);
};
{
  const taken = await portTaken(servicePort());
  if (taken) {
    console.error(`Atrium \u672A\u542F\u52A8\uFF1A${taken}`);
    process.exit(1);
  }
}
var lease = claimService(data, servicePort());
process.chdir(data);
discardLegacyIdleRestart(data);
var app;
var stopping = false;
var shutdownStarted = false;
var drained = false;
var drainRecoverMs = (() => {
  const value = Number(process.env.ATRIUM_DRAIN_RECOVER_MS ?? 6e4);
  return Number.isInteger(value) && value >= 100 ? value : 6e4;
})();
var stopRequested = false;
var drainWatch;
var clearDrainWatch = () => {
  if (drainWatch) clearInterval(drainWatch);
  drainWatch = void 0;
};
var shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopping = true;
  clearDrainWatch();
  const disconnect2 = setTimeout(() => {
    console.warn("HTTP \u5173\u95ED\u8D85\u8FC7 5 \u79D2\uFF0C\u65AD\u5F00\u5269\u4F59\u8FDE\u63A5");
    app?.server.closeAllConnections();
  }, 5e3);
  const deadline = setTimeout(() => {
    console.error("\u670D\u52A1\u5173\u95ED\u8D85\u8FC7 8 \u79D2\uFF0C\u9000\u51FA\u65E7\u8FDB\u7A0B\u4F9B\u65B0\u670D\u52A1\u63A5\u7BA1\u6267\u884C\u8005");
    process.exit(1);
  }, 8e3);
  try {
    await app?.close();
    clearTimeout(disconnect2);
    clearTimeout(deadline);
    lease.release();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
try {
  ({ app } = await createApp({
    data,
    controlToken: lease.record.token,
    serviceUrl: `http://127.0.0.1:${servicePort()}`,
    // 旧版执行者档案目录只在首次启动导入一次（#355）；ATRIUM_WORKERS_DIR 可改。
    tasks: {
      workersDir: process.env.ATRIUM_WORKERS_DIR || DEFAULT_WORKERS_DIR
    },
    legacyDir: legacyDir()
  }));
  const authorize3 = (value) => {
    const actual = /^Bearer (.+)$/i.exec(value ?? "")?.[1] ?? "";
    return sameSecret(actual, lease.record.token);
  };
  app.addHook("onRequest", async (request2, reply) => {
    const route = request2.routeOptions.url;
    if (!route?.startsWith("/api/service") || route === "/api/service/info")
      return;
    if (!authorize3(request2.headers.authorization))
      return reply.code(401).send({ error: "\u670D\u52A1\u63A7\u5236\u51ED\u636E\u65E0\u6548" });
  });
  const status = () => ({
    instance: lease.record.instance,
    pid: process.pid,
    stopping,
    version: currentVersion(),
    userAuth: "user-v1"
  });
  app.get("/api/service", () => {
    return status();
  });
  app.get("/api/service/info", () => ({
    service: "atrium",
    data,
    version: currentVersion()
  }));
  const drainOwner = (value) => {
    if (Number.isInteger(value) && value > 0)
      return value;
    const state = readRestartState(data);
    return state?.status === "stopping" && state.supervisorPid > 0 ? state.supervisorPid : null;
  };
  const recoverFromDrain = (supervisorPid) => {
    clearDrainWatch();
    stopping = false;
    drained = false;
    const reason = `\u6392\u7A7A\u5B8C\u6210\u540E ${drainRecoverMs / 1e3} \u79D2\u5185\u6CA1\u6709\u6536\u5230\u505C\u6B62\u8BF7\u6C42\uFF0C\u53D1\u8D77\u91CD\u542F\u7684 supervisor${supervisorPid ? `\uFF08PID ${supervisorPid}\uFF09` : ""}\u5DF2\u4E0D\u5728`;
    console.warn(
      `[${(/* @__PURE__ */ new Date()).toISOString()}] \u5E73\u6ED1\u91CD\u542F\u672A\u5B8C\u6210\uFF1A${reason}\uFF1B\u65E7\u670D\u52A1\u6062\u590D\u8FD0\u884C`
    );
    try {
      const state = readRestartState(data);
      if (state && state.oldPid === process.pid && !["success", "rolled_back", "failed"].includes(state.status) && !(state.supervisorPid > 0 && alive2(state.supervisorPid)))
        writeRestartState(data, {
          ...state,
          status: "failed",
          error: `${reason}\uFF1B\u65E7\u670D\u52A1\uFF08PID ${process.pid}\uFF09\u5DF2\u81EA\u52A8\u6062\u590D\u8FD0\u884C\u3002\u8981\u5B8C\u6210\u5347\u7EA7\u8BF7\u91CD\u65B0\u8FD0\u884C atrium restart`,
          finishedAt: Date.now()
        });
    } catch (error) {
      console.warn(`\u66F4\u65B0 restart-state \u5931\u8D25\uFF1A${String(error)}`);
    }
  };
  const armDrainWatch = (supervisorPid) => {
    clearDrainWatch();
    const deadline = Date.now() + drainRecoverMs;
    let waitingLogged = false;
    drainWatch = setInterval(
      () => {
        if (shutdownStarted || stopRequested || !stopping) {
          clearDrainWatch();
          return;
        }
        if (Date.now() < deadline) return;
        if (supervisorPid && alive2(supervisorPid)) {
          if (!waitingLogged)
            console.log(
              `\u5E73\u6ED1\u91CD\u542F\u6392\u7A7A\u5DF2\u5B8C\u6210 ${drainRecoverMs / 1e3} \u79D2\uFF0Csupervisor\uFF08PID ${supervisorPid}\uFF09\u4ECD\u5728\uFF0C\u7EE7\u7EED\u7B49\u5F85\u5B83\u505C\u6B62\u65E7\u670D\u52A1`
            );
          waitingLogged = true;
          return;
        }
        recoverFromDrain(supervisorPid);
      },
      Math.min(1e3, drainRecoverMs)
    );
    drainWatch.unref();
  };
  app.post("/api/service/prepare-restart", async (request2, reply) => {
    const body3 = request2.body ?? {};
    if (stopping) {
      if (drained && !stopRequested) {
        armDrainWatch(drainOwner(body3.supervisorPid));
        return { ready: true, agentsToWake: [] };
      }
      return reply.code(409).send({ error: "\u670D\u52A1\u6B63\u5728\u5173\u95ED" });
    }
    const timeout = Number(body3.timeout ?? 3e5);
    if (!Number.isInteger(timeout) || timeout < 1e3 || timeout > 72e5)
      return reply.code(400).send({ error: "timeout \u5FC5\u987B\u4E3A 1000\u20137200000 \u6BEB\u79D2" });
    stopping = true;
    drained = true;
    armDrainWatch(drainOwner(body3.supervisorPid));
    return { ready: true, agentsToWake: [] };
  });
  app.get("/api/service/health", async (_request, reply) => {
    const health = {
      ok: !stopping,
      version: currentVersion(),
      instance: lease.record.instance,
      pid: process.pid,
      stopping
    };
    if (!health.ok) return reply.code(503).send(health);
    return health;
  });
  app.post("/api/service/stop", (_request, reply) => {
    stopRequested = true;
    clearDrainWatch();
    reply.raw.once("finish", () => {
      void shutdown();
    });
    return status();
  });
  await app.listen({ port: lease.record.port, host: "127.0.0.1" });
  console.log(`Atrium \u2192 ${serviceUrl(lease.record)}
\u6570\u636E\uFF1A${data}`);
} catch (error) {
  if (error.code === "EADDRINUSE")
    console.error(
      `Atrium \u672A\u542F\u52A8\uFF1A${await portTaken(lease.record.port) ?? `\u7AEF\u53E3 ${lease.record.port} \u5DF2\u88AB\u5360\u7528`}`
    );
  else console.error(error);
  lease.release();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2e3).unref();
}
