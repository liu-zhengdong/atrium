import {
  Problem,
  runFile
} from "./chunk-DNL7I37E.js";

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

// server/tasks/git.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
var exec = async (command, args, options = {}) => {
  const { error, stdout, stderr } = await runFile(command, args, {
    cwd: options.cwd ?? homedir(),
    timeout: options.timeoutMs ?? 3e4,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0"
    }
  });
  return {
    ok: !error,
    stdout,
    stderr: stderr || (error ? error.message : "")
  };
};
var firstLine = (text) => text.trim().split("\n")[0] ?? "";
var FETCH_RETRY_MS = 500;
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
  const fetch = () => run("git", ["-C", repo, "fetch", "origin", base], { timeoutMs: 12e4 });
  let fetched = await fetch();
  if (!fetched.ok) {
    await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_MS));
    fetched = await fetch();
  }
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

// server/pause.ts
var resumeCommand = (pause) => pause.scope === "all" ? "atrium resume" : `atrium resume --${pause.scope.startsWith("h") ? "host" : "part"} ${pause.scope}`;
function pauseText(pause) {
  const at = new Date(pause.at);
  const two = (n) => String(n).padStart(2, "0");
  const time = `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
  const what = pause.scope === "all" ? "\u5168\u90E8" : pause.scope;
  return `\u5DF2\u6682\u505C\uFF08${what}\uFF0C${pause.by} ${time}${pause.why ? `\uFF1A${pause.why}` : ""}\uFF09`;
}

// server/tasks/ledger/state.ts
var TASK_STATUSES = [
  "todo",
  "running",
  "done",
  "failed",
  "blocked",
  "cancelled"
];
var isTaskStatus = (value) => typeof value === "string" && TASK_STATUSES.includes(value);

// server/tasks/ledger/deliver.ts
var DELIVERS = ["pr", "comment", "none"];

// server/tasks/ledger/ledger-summary.ts
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

// server/tasks/ledger/plan-count.ts
var scheduleBlocked = (item) => item.task.schedule_state === "blocked" || (item.reason ?? "").startsWith("\u4E0A\u6E38 ");
function planCounts(groups) {
  return {
    ready: groups.ready?.length ?? 0,
    waiting: groups.waiting?.length ?? 0,
    schedule_blocked: (groups.blocked ?? []).filter(scheduleBlocked).length
  };
}

// server/tasks/ledger/rollup.ts
var progressOf = (rollup) => `${rollup.finished}/${rollup.leaves - rollup.cancelled}`;
function rollupLabel(rollup) {
  switch (rollup.status) {
    case "running":
      return "\u5728\u505A";
    case "blocked":
      return "\u5361\u4F4F";
    case "online":
      return "\u5DF2\u4E0A\u7EBF";
    case "cancelled":
      return "\u53D6\u6D88";
    case "todo":
      return rollup.finished > 0 ? "\u7B49\u5F85\u4E2D" : "\u5F85\u529E";
  }
}
function rollupText(rollup) {
  const refs = (list, count) => list.length ? `\uFF08${list.join("\u3001")}${count > list.length ? "\u2026" : ""}\uFF09` : "";
  return [
    rollupLabel(rollup),
    `${progressOf(rollup)}${rollup.truncated ? "+" : ""}`,
    rollup.running ? `\u5728\u505A ${rollup.running}${refs(rollup.running_refs, rollup.running)}` : "",
    rollup.stuck ? `\u5361\u4F4F ${rollup.stuck}${refs(rollup.stuck_refs, rollup.stuck)}` : "",
    rollup.cancelled ? `\u53D6\u6D88 ${rollup.cancelled}` : ""
  ].filter(Boolean).join(" \xB7 ");
}

// shared/user.ts
var LOCAL_USER = "u1";
var SECRETARY = "secretary";

// server/org/limits.ts
var LIMITS = {
  quota_reserve_percent: { min: 0, max: 100, label: "\u7ED9\u4F60\u7559\u7684\u989D\u5EA6", unit: "%" },
  money_yuan_max: { min: 0, max: 1e6, label: "\u82B1\u8D39\u4E0A\u9650", unit: " \u5143" }
};
var limitText = (limits) => Object.keys(LIMITS).filter((key) => limits[key] !== void 0).map((key) => `${LIMITS[key].label} ${limits[key]}${LIMITS[key].unit}`).join("\uFF1B");

// server/tasks/watch/overdue.ts
var MINUTE = 6e4;
var DUE = {
  starting: {
    who: "\u6267\u884C\u8005\uFF08\u542F\u52A8\uFF09",
    ms: 3 * MINUTE,
    wake: "\u5224\u5361\u6B7B\uFF0C\u7ED3\u675F\u8FDB\u7A0B\u6811\uFF0C\u91CD\u8BD5\u4E00\u6B21\uFF1B\u518D\u5361\u4F4F\u8F6C\u5931\u8D25",
    escalate: null
  },
  worker: {
    who: "\u6267\u884C\u8005",
    ms: 20 * MINUTE,
    wake: "\u5224\u5361\u6B7B\uFF0C\u7ED3\u675F\u8FDB\u7A0B\u6811\uFF0C\u8F6C\u53D7\u963B\u4EA4\u8D1F\u8D23\u4EBA",
    escalate: null
  },
  check: {
    who: "\u68C0\u67E5",
    ms: 10 * MINUTE,
    wake: "\u7ED3\u675F\u68C0\u67E5\uFF1A\u5DF2\u67E5\u51FA\u5931\u8D25\u7528\u4F8B\u7684\u6309\u6CA1\u8FC7\u4EA4\u56DE\u6267\u884C\u8005\uFF0C\u6CA1\u6709\u7684\u6309\u6CA1\u8DD1\u6210\u91CD\u8DD1",
    escalate: null
  },
  release: {
    who: "\u53D1\u7248",
    ms: 30 * MINUTE,
    wake: "\u544A\u8BC9\u8D1F\u8D23\u4EBA\u53BB\u770B\u4ED3\u5E93\u7684\u53D1\u7248\u5DE5\u4F5C\u6D41",
    escalate: null
  },
  leader: {
    who: "leader",
    ms: 30 * MINUTE,
    wake: "\u518D\u53EB\u9192 leader \u4E00\u6B21",
    escalate: "\u4E0A\u4E00\u5C42\uFF08\u4E0A\u7EA7 leader \u6216\u79D8\u4E66\uFF09"
  },
  secretary: {
    who: "\u79D8\u4E66",
    ms: 3 * MINUTE,
    wake: "\u540E\u53F0\u53EB\u9192\u79D8\u4E66\u5904\u7406",
    escalate: "\u63A8\u7ED9\u7528\u6237"
  }
};
function spanText(ms) {
  if (!(ms >= MINUTE)) return "";
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes} \u5206\u949F`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} \u5C0F\u65F6` : `${Math.floor(hours / 24)} \u5929`;
}
function heldText(kind, ms) {
  const { ms: limit } = DUE[kind];
  if (!(ms >= limit / 4) || !spanText(ms)) return "";
  return `${spanText(ms)}\u6CA1\u52A8${ms >= limit ? "\uFF0C\u5DF2\u8D85\u65F6" : ""}`;
}

// server/tasks/watch/holder.ts
var HOLDER_WIDTH = 60;
var RETURNED = " \xB7 \u5DF2\u4EA4\u56DE\u6267\u884C\u8005";
var MERGE_WIDTH = HOLDER_WIDTH - width(RETURNED);

// server/leaders/route.ts
var FORWARD_WINDOW_MS = 6 * 60 * 6e4;

// server/org/overview.ts
var STAGE_LABEL = {
  planned: "\u89C4\u5212\u4E2D",
  active: "\u8FDB\u884C\u4E2D",
  achieved: "\u8FBE\u6210",
  blocked: "\u53D7\u963B",
  dropped: "\u653E\u5F03"
};

// server/tasks/ledger/schedule-refresh.ts
var BACKOFF_MAX_MS = 24 * 60 * 6e4;

export {
  width,
  clip,
  oneLine,
  resumeCommand,
  pauseText,
  TASK_STATUSES,
  isTaskStatus,
  DELIVERS,
  formatChildSummary,
  scheduleBlocked,
  planCounts,
  progressOf,
  rollupLabel,
  rollupText,
  LOCAL_USER,
  SECRETARY,
  limitText,
  STAGE_LABEL,
  DUE,
  heldText,
  HOLDER_WIDTH,
  exec,
  firstLine,
  ensureWorktree
};
