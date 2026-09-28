import {
  Problem
} from "./chunk-BU3TJ5JT.js";

// server/text-width.ts
var wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
var width = (text) => [...text].reduce((total, char) => total + (wide.test(char) ? 2 : 1), 0);
function clip(text, max) {
  const line = text.replace(/\s+/g, " ").trim();
  if (width(line) <= max) return line;
  let out = "";
  for (const char of line) {
    if (width(out + char) > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}\u2026`;
}
function oneLine(text, max) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return clip(first, max);
}

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

// server/tasks/deliver.ts
var DELIVERS = ["pr", "comment", "none"];

// server/tasks/ledger-summary.ts
var CHILD_STATUS_LABELS = {
  todo: "\u5F85\u529E",
  running: "\u8FDB\u884C\u4E2D",
  done: "\u5B8C\u6210",
  failed: "\u5931\u8D25",
  blocked: "\u53D7\u963B",
  cancelled: "\u53D6\u6D88"
};
function formatChildSummary(summary) {
  return TASK_STATUSES.filter((status) => summary[status] > 0).map(
    (status) => `${CHILD_STATUS_LABELS[status]} ${summary[status]}/${summary.total}`
  ).join(" \xB7 ");
}

// server/tasks/priority.ts
var PRIORITY_LABEL = {
  normal: "\u666E\u901A",
  idle: "\u95F2\u65F6"
};
var ALIASES = {
  normal: "normal",
  idle: "idle",
  \u666E\u901A: "normal",
  \u95F2\u65F6: "idle"
};
function parsePriority(value) {
  const found = typeof value === "string" ? ALIASES[value.trim().toLowerCase()] : void 0;
  if (!found) throw new Problem(400, "priority: \u53EA\u80FD\u662F \u95F2\u65F6 \u6216 \u666E\u901A", "usage");
  return found;
}
var isIdle = (task) => task.priority === "idle" && !task.urgent;
var IDLE_NOTE = "\u95F2\u65F6\uFF1A\u6392\u5728\u666E\u901A\u4EFB\u52A1\u540E\u9762\uFF0C\u6709\u7A7A\u95F2\u6267\u884C\u8005\u624D\u6D3E";
var priorityTag = (task) => task.urgent ? "\u7D27\u6025" : isIdle(task) ? "\u95F2\u65F6" : "";

// server/tasks/host-load.ts
var OFF = /* @__PURE__ */ new Set(["0", "off", "none", "false"]);
function parseCount(raw, allowOff) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const text = raw.trim().toLowerCase();
  if (allowOff && OFF.has(text)) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(text)) return void 0;
  return Number(text);
}
function parseLoad(raw) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value < 1e6 ? value : void 0;
}
function hostLimits(env, cores) {
  const n = Math.max(1, Math.floor(cores));
  const testing = !!env.NODE_TEST_CONTEXT;
  const problems = [];
  const pick = (name, parsed, fallback) => {
    if (parsed !== void 0) return parsed;
    if (env[name] !== void 0 && env[name].trim() !== "")
      problems.push(`${name}=${env[name]} \u770B\u4E0D\u61C2\uFF0C\u6309\u7F3A\u7701\u6267\u884C`);
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
var URGENT_NOTE = "\u7D27\u6025\uFF1A\u8DF3\u8FC7\u672C\u673A\u8D1F\u8F7D\u9650\u5236";
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
function checkPlacement(input) {
  return input.urgent || input.active < input.max ? "run" : "wait";
}

// server/org/boundaries.ts
var UNIT = {
  quota_reserve_percent: "%",
  disk_min_free_gb: " GB",
  money_yuan_max: " \u5143"
};
function formatParam(param) {
  return `${param.key === "money_yuan_max" ? "\u81F3\u591A" : "\u81F3\u5C11"} ${param.value}${UNIT[param.key]}`;
}

// server/org/overview.ts
var STAGE_LABEL = {
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
var HUMAN_KEYS = /* @__PURE__ */ new Set([
  ...Object.keys(OVERVIEW_TEXT),
  ...Object.keys(OVERVIEW_LISTS)
]);
var OVERVIEW_KEYS = /* @__PURE__ */ new Set([...HUMAN_KEYS, "stages"]);

// server/tasks/git.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
var exec = (command, args, options = {}) => new Promise((resolve) => {
  execFile(
    command,
    args,
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
    (error, stdout, stderr) => resolve({
      ok: !error,
      stdout: String(stdout),
      stderr: String(stderr || (error ? error.message : ""))
    })
  );
});
var firstLine = (text) => text.trim().split("\n")[0] ?? "";
async function ensureWorktree(repo, plan, base, run = exec) {
  if (existsSync(plan.path)) {
    const branch = await run(
      "git",
      ["-C", plan.path, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeoutMs: 1e4 }
    );
    if (branch.ok && branch.stdout.trim() === plan.branch)
      return { created: false };
    throw new Problem(
      409,
      `\u5DE5\u4F5C\u6811\u8DEF\u5F84 ${plan.path} \u5DF2\u5B58\u5728\u4F46\u4E0D\u5728\u5206\u652F ${plan.branch} \u4E0A\uFF1B\u5148\u6E05\u7406\u518D\u6D3E`,
      "conflict"
    );
  }
  const fetched = await run("git", ["-C", repo, "fetch", "origin", base], {
    timeoutMs: 12e4
  });
  if (!fetched.ok)
    throw new Problem(
      409,
      `\u62C9\u53D6 origin/${base} \u5931\u8D25\uFF1A${firstLine(fetched.stderr)}`,
      "conflict"
    );
  const exists = await run(
    "git",
    [
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${plan.branch}`
    ],
    { timeoutMs: 1e4 }
  );
  const args = exists.ok ? ["-C", repo, "worktree", "add", plan.path, plan.branch] : [
    "-C",
    repo,
    "worktree",
    "add",
    "--no-track",
    "-b",
    plan.branch,
    plan.path,
    `origin/${base}`
  ];
  const added = await run("git", args, { timeoutMs: 6e4 });
  if (!added.ok)
    throw new Problem(
      409,
      `\u5EFA\u5DE5\u4F5C\u6811\u5931\u8D25\uFF1A${firstLine(added.stderr)}`,
      "conflict"
    );
  return { created: true };
}

// server/tasks/council-gate.ts
var STANCE_LABEL = {
  agree: "\u540C\u610F",
  conditional: "\u6709\u6761\u4EF6\u540C\u610F",
  oppose: "\u53CD\u5BF9",
  veto: "\u5426\u51B3",
  none: "\u6CA1\u51FA\u610F\u89C1"
};

// server/tasks/holder.ts
var HOLDER_WIDTH = 60;
var RETURNED = " \xB7 \u5DF2\u4EA4\u56DE\u6267\u884C\u8005";
var MERGE_WIDTH = HOLDER_WIDTH - width(RETURNED);

// server/leaders/route.ts
var FORWARD_WINDOW_MS = 6 * 60 * 6e4;

// server/tasks/schedule-refresh.ts
var BACKOFF_MAX_MS = 24 * 60 * 6e4;

// server/tasks/top.ts
var RECENT_MS = 10 * 6e4;
var FINISHED_STATUSES = [...FINISHED];

// server/tasks/watchdog.ts
var STEP_CHUNK = 1024 * 1024;

export {
  width,
  clip,
  oneLine,
  TASK_STATUSES,
  isTaskStatus,
  DELIVERS,
  formatChildSummary,
  PRIORITY_LABEL,
  parsePriority,
  IDLE_NOTE,
  priorityTag,
  hostLimits,
  URGENT_NOTE,
  hostGate,
  checkPlacement,
  formatParam,
  STAGE_LABEL,
  OVERVIEW_KEYS,
  exec,
  firstLine,
  ensureWorktree,
  STANCE_LABEL,
  HOLDER_WIDTH
};
