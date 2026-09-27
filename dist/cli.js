import {
  authCommands,
  defaultSubscriber,
  leaderCommandGuard,
  leaderSession,
  workerGuard
} from "./chunk-W4RAWVSV.js";
import {
  BRIEF_MAX_BYTES,
  DELIVERS,
  HOLDER_WIDTH,
  IDLE_NOTE,
  OVERVIEW_KEYS,
  PRIORITY_LABEL,
  STAGE_LABEL,
  STANCE_LABEL,
  TASK_STATUSES,
  URGENT_NOTE,
  briefBytes,
  briefTooLong,
  clip,
  formatChildSummary,
  formatParam,
  isTaskStatus,
  oneLine,
  parsePriority,
  priorityTag,
  width
} from "./chunk-2MG2JPDP.js";
import "./chunk-BYXBJQAS.js";
import "./chunk-HVSVZFOO.js";
import {
  commandOnly,
  exitCodes,
  failure,
  recordNext,
  recordResult,
  withContext
} from "./chunk-G5UPIELH.js";
import "./chunk-T7KEDH72.js";
import {
  Problem,
  closest
} from "./chunk-BU3TJ5JT.js";
import {
  dataDirectory,
  isDefaultData,
  killTree,
  openUrlInvocation,
  readService,
  serviceUrl,
  spawnCommand
} from "./chunk-DIVCYJ6J.js";

// cli/main.ts
import { parseArgs } from "node:util";

// cli/format.ts
var pad = (text, target) => text + " ".repeat(Math.max(0, target - width(text)));
function table(rows) {
  const widths = [];
  for (const row of rows)
    row.forEach((cell2, index) => {
      widths[index] = Math.max(widths[index] ?? 0, width(cell2));
    });
  return rows.map(
    (row) => row.map(
      (cell2, index) => index === row.length - 1 ? cell2 : pad(cell2, widths[index] ?? 0)
    ).join("  ").trimEnd()
  ).join("\n");
}
function when(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp), now = /* @__PURE__ */ new Date();
  const two = (value) => String(value).padStart(2, "0");
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return clock;
  const day = `${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}-${day} ${clock}`;
}
var printJson = (value) => {
  recordResult(value);
  console.log(JSON.stringify(value, null, 2));
};

// cli/workers.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
var str = (v, k) => typeof v[k] === "string" ? v[k] : void 0;
var strs = (v, k) => Array.isArray(v[k]) ? v[k].filter((x) => typeof x === "string") : [];
var client = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var percent = (n) => n === null ? "\u2014" : `${Math.round(n * 100)}%`;
var duration = (n) => n === null ? "\u2014" : `${Math.round(n / 6e4)} \u5206`;
var isProfileRef = (value) => /^(harness|models|combos)\//.test(value);
var profilePath = (ref5) => {
  const slash = ref5.indexOf("/");
  return `/workers/profiles/${encodeURIComponent(ref5.slice(0, slash))}/${encodeURIComponent(ref5.slice(slash + 1))}`;
};
function readSource(name) {
  try {
    return readFileSync(name === "-" ? 0 : resolve(name), "utf8");
  } catch {
    throw new Problem(400, `--file \u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${name}`, "usage");
  }
}
async function showProfile(ref5, json) {
  const data = await (await client()).get(profilePath(ref5));
  if (json) printJson(data);
  else {
    console.log(
      `${data.ref} \xB7 \u7B2C ${data.rev} \u7248 \xB7 ${data.updated_by} ${when(data.updated_at)}`
    );
    console.log(data.source.trimEnd());
    if (data.notes) console.log("\n\uFF08\u4EA4\u4ED8\u8BB0\u5F55\u6BB5\u4F5C\u5907\u6CE8\u4FDD\u7559\uFF0C\u4E0D\u9644\u8FDB\u63D0\u793A\u8BCD\uFF09");
    for (const w of data.warnings) console.log(`\u8B66\u544A\uFF1A${w}`);
    console.log("\n\u4FEE\u8BA2\uFF1A");
    for (const h of data.history)
      console.log(`  \u7B2C ${h.rev} \u7248 \xB7 ${h.author} ${when(h.at)} \xB7 ${h.reason}`);
  }
  recordNext(`\u6539\u6863\u6848\uFF1Aatrium workers edit ${ref5} --file \u6587\u4EF6`);
}
var workerCommands = {
  workers: {
    args: "[--specialist \u4E13\u5458] [--json]",
    about: "\u6309\u6267\u884C\u8005\u7EC4\u5408\u3001\u6A21\u578B\u3001\u5DE5\u5177\u4E0E\u5E72\u6D3B\u7684\u4E13\u5458\u67E5\u770B\u4EA4\u4ED8\u4E8B\u5B9E",
    options: { role: { type: "string" }, specialist: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const role = str(values, "specialist") ?? str(values, "role");
      if (str(values, "role") !== void 0)
        console.error("--role \u5DF2\u6539\u4E3A --specialist\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528");
      const q = role ? `?role=${encodeURIComponent(role)}` : "";
      const data = await (await client()).get(`/workers${q}`);
      if (json) printJson(data);
      else {
        console.log(
          table([
            [
              "\u5C42\u7EA7",
              "\u6267\u884C\u8005",
              "\u4E13\u5458",
              "\u6B21\u6570",
              "\u4E00\u6B21\u901A\u8FC7",
              "\u5E73\u5747\u9000\u56DE",
              "\u4E2D\u4F4D\u7528\u65F6",
              "\u4E8B\u6545",
              "\u4FE1\u4EFB",
              "\u6837\u672C"
            ],
            ...data.stats.map((s) => [
              s.scope,
              s.worker,
              s.role ?? "\u672A\u6307\u5B9A",
              String(s.deliveries),
              percent(s.first_pass_rate),
              s.average_returns.toFixed(1),
              duration(s.median_ms),
              String(s.incidents),
              s.trust ?? "\u2014",
              s.low_data ? "\u6570\u636E\u5C11" : "\u8DB3\u591F"
            ])
          ])
        );
        for (const x of data.suggestions)
          console.log(
            `\u5EFA\u8BAE ${x.stat.worker} \xB7 ${x.stat.role}\uFF1A${x.advice.action}\uFF0C${x.advice.reason}`
          );
      }
      recordNext("\u770B\u6267\u884C\u8005\uFF1Aatrium workers show \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]");
    }
  },
  "workers ls": {
    args: "[--json]",
    about: "\u5217\u51FA\u5E93\u91CC\u7684\u6267\u884C\u8005\u6863\u6848\uFF08\u5DE5\u5177 / \u6A21\u578B / \u7EC4\u5408\u4E09\u5C42\uFF09",
    positionals: [0, 0],
    async run({ json }) {
      const data = await (await client()).get("/workers/profiles");
      if (json) printJson(data);
      else if (!data.profiles.length)
        console.log("\u5E93\u91CC\u8FD8\u6CA1\u6709\u6267\u884C\u8005\u6863\u6848\uFF0C\u6D3E\u6D3B\u7528\u5185\u7F6E\u7F3A\u7701");
      else
        console.log(
          table([
            ["\u6863\u6848", "\u7248\u672C", "\u4FE1\u4EFB", "\u6700\u9AD8\u98CE\u9669", "\u6A21\u578B", "\u52A0\u67E5", "\u66F4\u65B0"],
            ...data.profiles.map((p) => [
              p.ref,
              String(p.rev),
              p.trust ?? "\u2014",
              p.max_risk ?? "\u2014",
              p.model ?? "\u2014",
              p.checks?.join(",") || "\u2014",
              `${p.updated_by} ${when(p.updated_at)}${p.warnings.length ? " \xB7 \u6709\u8B66\u544A" : ""}`
            ])
          ])
        );
      recordNext("\u770B\u6863\u6848\uFF1Aatrium workers show harness/codex");
    }
  },
  "workers edit": {
    args: "\u5C42/\u540D (--file \u6587\u4EF6|- | --trust \u7B49\u7EA7 | --max-risk \u98CE\u9669 | --model \u6A21\u578B | --checks a,b | --set \u952E=\u503C | --unset \u952E) [--reason \u539F\u56E0]",
    about: "\u6539\u5E93\u91CC\u7684\u4E00\u4EFD\u6267\u884C\u8005\u6863\u6848\u5E76\u7559\u4FEE\u8BA2\uFF1B\u5C42\u662F harness\u3001models\u3001combos\uFF0C\u6863\u6848\u4E0D\u5B58\u5728\u5C31\u65B0\u5EFA\u3002--file - \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u6574\u4EFD\uFF08frontmatter + \u6B63\u6587\uFF09",
    options: {
      file: { type: "string" },
      trust: { type: "string" },
      "max-risk": { type: "string" },
      model: { type: "string" },
      checks: { type: "string" },
      set: { type: "string", multiple: true },
      unset: { type: "string", multiple: true },
      reason: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [ref5], values, json }) {
      if (!isProfileRef(ref5))
        throw new Problem(
          400,
          "\u6863\u6848\u5E94\u5199\u6210 \u5C42/\u540D\uFF0C\u5C42\u662F harness\u3001models\u3001combos\uFF0C\u5982 harness/codex",
          "usage"
        );
      const file2 = str(values, "file");
      const set2 = {};
      for (const [flag, key] of [
        ["trust", "trust"],
        ["max-risk", "max_risk"],
        ["model", "model"]
      ]) {
        const value = str(values, flag);
        if (value !== void 0) set2[key] = value;
      }
      const checks = str(values, "checks");
      if (checks !== void 0)
        set2.checks = `[${checks.split(/[,，]/).map((c) => c.trim()).filter(Boolean).join(", ")}]`;
      for (const pair of strs(values, "set")) {
        const at = pair.indexOf("=");
        if (at <= 0)
          throw new Problem(400, `--set \u5E94\u5199\u6210 \u952E=\u503C\uFF1A${pair}`, "usage");
        set2[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      const unset = strs(values, "unset");
      const body = {
        ...file2 !== void 0 ? { source: readSource(file2) } : {},
        ...Object.keys(set2).length ? { set: set2 } : {},
        ...unset.length ? { unset } : {},
        ...str(values, "reason") ? { reason: str(values, "reason") } : {}
      };
      const result = await (await client()).put(
        profilePath(ref5),
        body
      );
      if (json) printJson(result);
      else
        console.log(
          result.changed ? `${result.created ? "\u5DF2\u65B0\u5EFA" : "\u5DF2\u6539"} ${result.ref}\uFF0C\u7B2C ${result.rev} \u7248` : `${result.ref} \u5185\u5BB9\u6CA1\u53D8\uFF0C\u4ECD\u662F\u7B2C ${result.rev} \u7248`
        );
      recordNext(`\u770B\u6863\u6848\uFF1Aatrium workers show ${result.ref}`);
    }
  },
  "workers show": {
    args: "\u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]|\u5C42/\u540D [--json]",
    about: "\u67E5\u770B\u6267\u884C\u8005\u7684\u4EA4\u4ED8\u660E\u7EC6\u4E0E\u4E09\u5C42\u53E0\u52A0\u6863\u6848\uFF1B\u7ED9 \u5C42/\u540D\uFF08\u5982 harness/codex\uFF09\u65F6\u770B\u8FD9\u4EFD\u6863\u6848\u539F\u6587\u4E0E\u4FEE\u8BA2",
    positionals: [1, 1],
    async run({ positionals: [worker], json }) {
      if (isProfileRef(worker)) return showProfile(worker, json);
      const data = await (await client()).get(`/workers/${encodeURIComponent(worker)}`);
      if (json) printJson(data);
      else
        console.log(
          `${data.worker}
${data.profile.body}

\u4EA4\u4ED8\uFF1A
${data.deliveries.map((d) => `${d.task_ref} ${d.task_title} \xB7 ${d.job_name ?? "\u672A\u6307\u5B9A"} \xB7 ${d.final_result} \xB7 ${duration(d.duration_ms)}${d.gate_returns.length ? ` \xB7 \u5173\u5361\uFF1A${d.gate_returns.join("\uFF1B")}` : ""}${d.merge_returns.length ? ` \xB7 \u5408\u5165\u9000\u56DE\uFF1A${d.merge_returns.join("\uFF1B")}` : ""}${d.rebase_conflicts ? ` \xB7 \u53D8\u57FA\u51B2\u7A81 ${d.rebase_conflicts} \u6B21\uFF08\u4E0D\u5F52\u8D23\uFF09` : ""}${d.incidents.length ? ` \xB7 \u4E8B\u6545\uFF1A${d.incidents.join("\u3001")}` : ""}`).join("\n") || "\u6682\u65E0"}
${data.suggestions.map((x) => `\u5EFA\u8BAE\uFF1A${x.advice.action} \xB7 ${x.advice.reason}`).join("\n")}`
        );
      recordNext("\u770B\u5168\u90E8\uFF1Aatrium workers");
    }
  },
  "workers confirm": {
    args: "\u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6] --specialist \u4E13\u5458 --action relax|tighten|avoid_specialist",
    about: "\u79D8\u4E66\u786E\u8BA4\u7EDF\u8BA1\u5EFA\u8BAE\u540E\u5199\u5165\u7EC4\u5408\u6863\u6848",
    options: {
      role: { type: "string" },
      specialist: { type: "string" },
      action: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [worker], values, json }) {
      const role = str(values, "specialist") ?? str(values, "role"), suppliedAction = str(values, "action"), action2 = suppliedAction === "avoid_specialist" ? "avoid_role" : suppliedAction;
      if (str(values, "role") !== void 0)
        console.error("--role \u5DF2\u6539\u4E3A --specialist\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528");
      if (!role?.trim())
        throw new Problem(400, "--specialist \u4E0D\u80FD\u4E3A\u7A7A", "usage");
      if (suppliedAction === "avoid_role")
        console.error(
          "--action avoid_role \u5DF2\u6539\u4E3A avoid_specialist\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528"
        );
      if (!action2 || !["relax", "tighten", "avoid_role"].includes(action2))
        throw new Problem(
          400,
          "--action \u53EA\u80FD\u662F relax\u3001tighten\u3001avoid_specialist",
          "usage"
        );
      const result = await (await client()).post(
        "/workers/advice/confirm",
        { worker, role, action: action2 }
      );
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u786E\u8BA4 ${result.worker} \xB7 ${result.role}\uFF1A${result.action}
\u6863\u6848\uFF1A${result.file}\uFF08\u5DF2\u7559\u4FEE\u8BA2\uFF09`
        );
      recordNext(`\u770B\u6863\u6848\uFF1Aatrium workers show ${worker}`);
    }
  }
};

// cli/roles.ts
import { readFileSync as readFileSync2, statSync } from "node:fs";
var str2 = (v, k) => typeof v[k] === "string" ? v[k] : void 0;
var client2 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var path = (s) => encodeURIComponent(s);
var bodyFile = (file2) => {
  try {
    if (!statSync(file2).isFile()) throw new Error("not file");
    return readFileSync2(file2, "utf8");
  } catch {
    throw new Problem(400, `--body \u6587\u4EF6\u8BFB\u4E0D\u5230\uFF1A${file2}`, "usage");
  }
};
var pointsFile = (file2) => {
  try {
    return JSON.parse(bodyFile(file2));
  } catch {
    throw new Problem(400, `--review-points \u6587\u4EF6\u5E94\u4E3A JSON\uFF1A${file2}`, "usage");
  }
};
var fields = (v) => ({
  ...str2(v, "name") === void 0 ? {} : { name: str2(v, "name") },
  ...str2(v, "description") === void 0 ? {} : { description: str2(v, "description") },
  ...str2(v, "body") === void 0 ? {} : { body: bodyFile(str2(v, "body")) },
  ...str2(v, "preferred") === void 0 ? {} : { preferred: str2(v, "preferred").split(",").filter(Boolean) },
  ...str2(v, "checks") === void 0 ? {} : { checks: str2(v, "checks").split(",").filter(Boolean) },
  ...str2(v, "skills") === void 0 ? {} : { skills: str2(v, "skills").split(",").filter(Boolean) },
  ...str2(v, "review-goal") === void 0 ? {} : { review_goal: str2(v, "review-goal") },
  ...str2(v, "review-points") === void 0 ? {} : { review_points: pointsFile(str2(v, "review-points")) },
  ...str2(v, "review-bottom") === void 0 ? {} : { review_bottom: str2(v, "review-bottom").split(",").filter(Boolean) },
  ...str2(v, "invite-when") === void 0 ? {} : { invite_when: str2(v, "invite-when").split(",").filter(Boolean) },
  ...str2(v, "part") === void 0 ? {} : { part: str2(v, "part") },
  ...str2(v, "as") === void 0 ? {} : { author: str2(v, "as") }
});
var opts = {
  name: { type: "string" },
  description: { type: "string" },
  body: { type: "string" },
  preferred: { type: "string" },
  checks: { type: "string" },
  skills: { type: "string" },
  "review-goal": { type: "string" },
  "review-points": { type: "string" },
  "review-bottom": { type: "string" },
  "invite-when": { type: "string" },
  part: { type: "string" },
  as: { type: "string" }
};
var output = (json, value, message, next) => {
  if (json) printJson(value);
  else console.log(message);
  recordNext(next);
};
var owner = (r) => r.part ? `${r.part_name ?? r.part}\uFF08${r.part}\uFF09` : "\u5168\u7EC4\u7EC7";
var rowsTable = (rows, withOwner) => table([
  ["\u77ED\u53F7", "\u540D\u79F0", ...withOwner ? ["\u5F52\u5C5E"] : [], "\u505A\u4EC0\u4E48", "\u5728\u505A"],
  ...rows.map((r) => [
    r.ref,
    r.name,
    ...withOwner ? [owner(r)] : [],
    r.description,
    String(r.running ?? 0)
  ])
]);
var SCOPE_WORD = {
  own: "\u672C\u90E8\u5206",
  chain: "\u4E0A\u7EA7",
  also: "\u7275\u6D89\u90E8\u5206",
  org: "\u5168\u7EC4\u7EC7"
};
function foldedLines(rows, part) {
  const own = rows.filter((r) => r.scope === "own");
  const groups2 = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (r.scope === "own") continue;
    const key = r.scope === "org" ? "\u5168\u7EC4\u7EC7\u7684" : `${r.part_name ?? r.part}\u7684`;
    groups2.set(key, [...groups2.get(key) ?? [], r.name]);
  }
  const rest = [...groups2].map(([k, v]) => `${k} ${v.join("\u3001")}`);
  return [
    ...own.length ? [rowsTable(own, false)] : [`${part} \u6CA1\u6709\u81EA\u5DF1\u7684\u4E13\u5458`],
    ...rest.length ? [
      `\u53E6\u6709 ${rest.join("\uFF1B")}\uFF08\u5C55\u5F00\uFF1Aatrium specialist ls --part ${part} --all\uFF09`
    ] : []
  ];
}
var roleCommands = {
  "specialist ls": {
    args: "[--part \u90E8\u5206] [--all] [--json]",
    about: "\u5217\u51FA\u4E13\u5458\uFF1A\u7F3A\u7701\u53EA\u5217\u5168\u7EC4\u7EC7\u5171\u7528\u7684\uFF1B--part \u5217\u8FD9\u4E00\u90E8\u5206\u80FD\u8BF7\u7684\uFF08\u672C\u90E8\u5206\u7684\u5728\u524D\uFF0C\u4E0A\u7EA7\u3001\u7275\u6D89\u90E8\u5206\u4E0E\u5168\u7EC4\u7EC7\u7684\u6298\u6210\u4E00\u884C\uFF09\uFF1B--all \u5C55\u5F00\u5168\u90E8",
    options: {
      part: { type: "string" },
      all: { type: "boolean", default: false }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const api2 = await client2();
      const part = str2(values, "part");
      const all2 = values.all === true;
      if (part !== void 0) {
        const view = await api2.get(`/specialists?${new URLSearchParams({ part })}`);
        output(
          json,
          view,
          [
            `${view.part} ${view.name} \u80FD\u8BF7\u7684\u4E13\u5458`,
            ...all2 ? [
              table([
                ["\u77ED\u53F7", "\u540D\u79F0", "\u6765\u81EA", "\u505A\u4EC0\u4E48", "\u5728\u505A"],
                ...view.specialists.map((r) => [
                  r.ref,
                  r.name,
                  r.scope === "org" ? SCOPE_WORD.org : `${SCOPE_WORD[r.scope]} ${owner(r)}`,
                  r.description,
                  String(r.running ?? 0)
                ])
              ])
            ] : foldedLines(view.specialists, view.part)
          ].join("\n"),
          `\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --part ${view.part} --by \u4E13\u5458`
        );
        return;
      }
      const rows = await api2.get("/specialists");
      const shown = all2 ? rows : rows.filter((r) => !r.part);
      const hidden = rows.length - shown.length;
      output(
        json,
        shown,
        [
          rowsTable(shown, all2),
          ...hidden ? [
            `\u53E6\u6709 ${hidden} \u4F4D\u5C5E\u4E8E\u67D0\u4E2A\u90E8\u5206\uFF1A${rows.filter((r) => r.part).map((r) => `${r.name}\uFF08${r.part_name ?? r.part}\uFF09`).join("\u3001")}\uFF08\u5C55\u5F00\uFF1Aatrium specialist ls --all\uFF09`
          ] : []
        ].join("\n"),
        "\u770B\u4E13\u5458\uFF1Aatrium specialist show r1"
      );
    }
  },
  "specialist show": {
    args: "\u4E13\u5458 [--json]",
    about: "\u67E5\u770B\u4E13\u5458\u3001\u5C97\u4F4D\u8BF4\u660E\u3001\u4F18\u5148\u6267\u884C\u8005\u3001\u4EA4\u4ED8\u5173\u5361\u4E0E\u6280\u80FD",
    positionals: [1, 1],
    async run({ positionals: [id], json }) {
      const role = await (await client2()).get(`/specialists/${path(id)}`);
      output(
        json,
        role,
        `${role.ref} ${role.name} \xB7 r${role.rev}
${role.description}
\u5F52\u5C5E\uFF1A${owner(role)}
\u4F18\u5148\u6267\u884C\u8005\uFF1A${role.preferred.join("\u3001") || "\u65E0"}
\u4EA4\u4ED8\u5173\u5361\uFF1A${role.checks.join("\u3001") || "\u65E0"}
\u6280\u80FD\uFF1A${role.skills.join("\u3001") || "\u65E0"}
\u5BA1\u67E5\u76EE\u6807\uFF1A${role.review_goal || "\u65E0"}
\u68C0\u67E5\u8981\u70B9\uFF1A${role.review_points.map((p) => p.text).join("\u3001") || "\u65E0"}
\u5BA1\u67E5\u5E95\u7EBF\uFF1A${role.review_bottom.join("\u3001") || "\u65E0"}
\u8BF7\u6765\u770B\u63D0\u793A\uFF1A${role.invite_when.join("\u3001") || "\u65E0"}

${role.body}`,
        `\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --by ${role.ref}`
      );
    }
  },
  "specialist add": {
    args: "\u540D\u79F0 --description \u6587\u5B57 --body \u6587\u4EF6 [--part \u90E8\u5206] [--preferred \u5217\u8868] [--checks \u5217\u8868] [--skills \u5217\u8868] [--review-goal \u76EE\u6807] [--review-points JSON\u6587\u4EF6] [--review-bottom \u5217\u8868] [--invite-when \u5217\u8868]",
    about: "\u521B\u5EFA\u4E13\u5458\uFF1B--part \u5199\u5B83\u5C5E\u4E8E\u54EA\u4E00\u90E8\u5206\uFF08\u5982\u5B89\u5168\u4E13\u5458\u5C5E\u4E8E\u5B89\u5168\uFF0C\u53EA\u6709\u5F52\u5C5E\u94FE\u6216\u7275\u6D89\u5230\u90A3\u4E00\u90E8\u5206\u7684\u4EFB\u52A1\u80FD\u8BF7\uFF09\uFF0C\u4E0D\u5199\u5373\u5168\u7EC4\u7EC7\u5171\u7528\uFF1B\u5217\u8868\u7528\u9017\u53F7\u5206\u9694\uFF0C\u6B63\u6587\u4ECE\u6587\u4EF6\u8BFB\u53D6",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      if (!str2(values, "description") || !str2(values, "body"))
        throw new Problem(400, "--description \u548C --body \u5FC5\u586B", "usage");
      const role = await (await client2()).post("/specialists", { ...fields(values), name });
      output(
        json,
        role,
        `\u5DF2\u5EFA ${role.ref} ${role.name}`,
        `\u770B\u4E13\u5458\uFF1Aatrium specialist show ${role.ref}`
      );
    }
  },
  "specialist edit": {
    args: "\u4E13\u5458 [--name \u540D\u79F0] [--description \u6587\u5B57] [--body \u6587\u4EF6] [--part \u90E8\u5206|''] [--preferred \u5217\u8868] [--checks \u5217\u8868] [--skills \u5217\u8868] [--review-goal \u76EE\u6807] [--review-points JSON\u6587\u4EF6] [--review-bottom \u5217\u8868] [--invite-when \u5217\u8868]",
    about: "\u4FEE\u8BA2\u4E13\u5458\uFF0C\u4FDD\u7559\u5386\u53F2\uFF1B--part '' \u6539\u56DE\u5168\u7EC4\u7EC7\u5171\u7528",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const body = fields(values);
      if (!Object.keys(body).some((k) => k !== "author"))
        throw new Problem(400, "\u81F3\u5C11\u63D0\u4F9B\u4E00\u9879\u8981\u4FEE\u6539\u7684\u4E13\u5458\u5B57\u6BB5", "usage");
      const role = await (await client2()).patch(`/specialists/${path(id)}`, body);
      output(
        json,
        role,
        `\u5DF2\u4FEE\u8BA2 ${role.ref} ${role.name} \xB7 r${role.rev}`,
        `\u770B\u4E13\u5458\uFF1Aatrium specialist show ${role.ref}`
      );
    }
  }
};
for (const [name, command] of Object.entries({ ...roleCommands })) {
  const old = name.replace("specialist", "role");
  roleCommands[old] = {
    ...command,
    about: `${command.about}\uFF08\u65E7\u5199\u6CD5\uFF1B\u6539\u7528 atrium ${name}\uFF09`,
    async run(input) {
      console.error(`atrium ${old} \u5DF2\u6539\u4E3A atrium ${name}\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528`);
      return command.run(input);
    }
  };
}

// cli/tasks.ts
import { existsSync, statSync as statSync2 } from "node:fs";
import { resolve as resolve2 } from "node:path";

// cli/wait-options.ts
import { setTimeout as delay } from "node:timers/promises";
async function reconnectingWait(config) {
  const deadline = Date.now() + config.seconds * 1e3;
  let cursor = config.cursor;
  let announced = false;
  const left = () => Math.ceil((deadline - Date.now()) / 1e3);
  const giveUp = () => new Problem(
    503,
    `\u670D\u52A1\u5728 ${config.seconds} \u79D2\u5185\u6CA1\u6709\u6062\u590D`,
    "service_unavailable",
    void 0,
    config.resume(cursor)
  );
  const notice = () => {
    if (announced) return;
    announced = true;
    console.error(`\u670D\u52A1\u91CD\u542F\u6216\u65AD\u5F00\uFF0C\u7EE7\u7EED\u7B49\u5269\u4F59 ${Math.max(left(), 0)} \u79D2`);
  };
  for (; ; ) {
    const remaining = left();
    if (remaining <= 0) throw giveUp();
    let result;
    try {
      result = await config.request(Math.max(remaining, 1), cursor, (after) => {
        cursor = after;
      });
    } catch (error) {
      if (!(error instanceof Problem && error.code === "service_unavailable"))
        throw error;
      if (left() <= 0) throw giveUp();
      notice();
      await delay(500);
      continue;
    }
    if (!config.restarting(result)) return result;
    cursor = config.nextCursor?.(result) ?? cursor;
    if (left() <= 0) throw giveUp();
    notice();
  }
}

// cli/long-wait.ts
var CHUNK_SECONDS = 240;
var WAIT_MAX_SECONDS = 3600;
function waitSeconds(value) {
  if (value === void 0) return 300;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > WAIT_MAX_SECONDS)
    throw new Problem(
      400,
      `--timeout \u5E94\u4E3A 0\uFF5E${WAIT_MAX_SECONDS} \u7684\u6574\u6570\u79D2\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  return Number(value);
}
async function longWait(seconds, request, resume) {
  if (seconds === 0) return request(0);
  const deadline = Date.now() + seconds * 1e3;
  for (; ; ) {
    const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1e3));
    const result = await reconnectingWait({
      seconds: left,
      request: (timeout) => request(Math.min(timeout, CHUNK_SECONDS)),
      restarting: (value) => value.restarting === true,
      resume
    });
    if (!result.timed_out || Date.now() >= deadline - 500) return result;
  }
}

// cli/task-concerns.ts
function concernState(c) {
  if (c.verdict === "pass") return "\u901A\u8FC7";
  if (c.verdict === "veto") return `\u5426\u51B3\uFF1A${c.reason ?? ""}`;
  if (c.verdict === "none") return `\u6CA1\u51FA\u7ED3\u8BBA\uFF1A${c.reason ?? ""}`;
  if (!c.review) return "\u5DF2\u8BF7\uFF0C\u4EA4\u4ED8\u540E\u5BA1";
  return c.review_status === "running" ? "\u5BA1\u67E5\u4E2D" : "\u7B49\u5BA1\u67E5";
}
var concernLabel = (c) => `${c.name}\uFF08${c.ref}${c.review ? ` \xB7 ${c.review}` : ""}\uFF09`;
var concernsText = (list3) => list3?.length ? list3.map((c) => `${concernLabel(c)}\uFF1A${concernState(c)}`).join("\uFF1B") : null;
var concernsBrief = (list3) => list3?.length ? `\u4E13\u5458\uFF1A${list3.map(
  (c) => `${c.name} ${c.verdict === "pass" ? "\u901A\u8FC7" : c.verdict === "veto" ? "\u5426\u51B3" : c.verdict === "none" ? "\u6CA1\u51FA\u7ED3\u8BBA" : c.review ? c.review_status === "running" ? `\u5BA1\u67E5\u4E2D ${c.review}` : `\u7B49\u5BA1\u67E5 ${c.review}` : "\u5DF2\u8BF7"}`
).join(" \xB7 ")}` : null;
function hintLines(task, rerun = false) {
  const hints = task.concern_hints ?? [];
  if (!hints.length) return [];
  return [
    ...hints.map(
      (h) => `\u63D0\u793A\uFF1A\u53EF\u80FD\u8981\u8BF7\u300C${h.name}\u300D\u4E13\u5458\uFF08${h.matched.join("\uFF1B")}\uFF09`
    ),
    `\u8981\u8BF7\uFF1Aatrium task set ${task.ref} --ask ${hints.map((h) => h.ref).join(",")}${rerun ? `\uFF0C\u518D atrium task run ${task.ref}` : ""}`
  ];
}

// server/tasks/percent.ts
function signedPercent(value) {
  const n = Math.round(value);
  return n > 0 ? `+${n}%` : n < 0 ? `\u2212${-n}%` : "0%";
}

// cli/brief-input.ts
import { readFileSync as readFileSync3 } from "node:fs";
async function readStdin(stdin) {
  if (stdin.isTTY)
    throw new Problem(
      400,
      "--brief - \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u8BE6\u8FF0\uFF0C\u9700\u8981\u7528\u7BA1\u9053\u6216\u91CD\u5B9A\u5411\u4F20\u5165\uFF0C\u5982 atrium task add \u6807\u9898 --brief - < \u8BE6\u8FF0.md",
      "usage"
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > BRIEF_MAX_BYTES + 4) throw briefTooLong(size, "--brief");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function briefInput(value, resolvePath, stdin = process.stdin) {
  const fromStdin = value === "-";
  const path6 = fromStdin ? void 0 : resolvePath(value);
  let text;
  if (path6 === void 0) text = await readStdin(stdin);
  else
    try {
      text = readFileSync3(path6, "utf8");
    } catch {
      throw new Problem(400, `--brief \u8BFB\u4E0D\u5230\uFF1A${path6}`, "usage");
    }
  text = text.replace(/^﻿/, "");
  const bytes = briefBytes(text);
  if (bytes > BRIEF_MAX_BYTES) throw briefTooLong(bytes, "--brief");
  if (!text.trim())
    throw new Problem(
      400,
      `--brief ${fromStdin ? "\u6807\u51C6\u8F93\u5165" : path6} \u662F\u7A7A\u7684\uFF1B\u8981\u6E05\u7A7A\u8BE6\u8FF0\u7528 --brief ''`,
      "usage"
    );
  return { brief: text, ...path6 ? { brief_path: path6 } : {} };
}

// cli/tasks.ts
var str3 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var client3 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var displayStatus = (task) => task.queued_reason ? "\u6392\u961F" : task.processing ? "\u5904\u7406\u4E2D" : task.status === "blocked" ? "\u5361\u4F4F" : task.delivery_stage === "reviewing" ? "\u5BA1\u9605\u4E2D" : task.delivery_stage === "merge_queued" ? "\u6392\u961F\u5408\u5165" : task.delivery_stage === "merging" ? "\u5408\u5165\u4E2D" : task.delivery_stage === "merged" ? "\u5DF2\u5408\u5165" : task.delivery_stage === "online" ? "\u5DF2\u4E0A\u7EBF" : task.status;
var queueLine = (task) => task.queued_reason ? `  \u6392\u961F\u539F\u56E0\uFF1A${task.queued_reason}` : null;
var noteAuthor = (task) => task.note_by_name ? `${task.note_by_name}\uFF08${task.note_by}\uFF09` : task.note_by ?? "\u672A\u77E5";
var noteLine = (task) => task.note ? `  \u5907\u6CE8\uFF08${noteAuthor(task)} \xB7 ${when(task.note_at)}\uFF09\uFF1A${task.note.replace(/\s+/g, " ")}` : null;
var urgentLines = (task) => task.urgent === 1 ? [URGENT_NOTE] : priorityTag(task) ? [IDLE_NOTE] : [];
var tagText = (task) => {
  const tag = priorityTag(task);
  return tag ? `${tag} ` : "";
};
var queuedText = (reason3) => reason3.startsWith("\u7B49\u7A7A\u95F2") ? reason3 : `\u6392\u961F\uFF1A${reason3}`;
function priorityInput(values) {
  const text = str3(values, "priority");
  if (text === void 0) return {};
  try {
    return { priority: parsePriority(text) };
  } catch {
    throw new Problem(400, "--priority \u53EA\u80FD\u662F \u95F2\u65F6 \u6216 \u666E\u901A", "usage");
  }
}
function ref(value, flag) {
  if (!value || !/^t[1-9][0-9]*$/.test(value))
    throw new Problem(
      400,
      `${flag === "\u4EFB\u52A1" ? "\u4EFB\u52A1\u77ED\u53F7\u5E94\u4E3A t1 \u8FD9\u6837\u7684\u683C\u5F0F" : `${flag} \u8981\u586B\u4EFB\u52A1\u77ED\u53F7\uFF0C\u5982 t1`}\uFF08\u6536\u5230\uFF1A${value ?? "\u7A7A"}\uFF09`,
      "usage",
      void 0,
      "atrium task ls"
    );
  return value;
}
function status(value) {
  if (!isTaskStatus(value))
    throw new Problem(
      400,
      `--status \u53EA\u80FD\u662F ${TASK_STATUSES.join("\u3001")}\uFF08\u6536\u5230\uFF1A${value ?? "\u7A7A"}\uFF09`,
      "usage"
    );
  return value;
}
function deliver(value) {
  if (!DELIVERS.includes(value))
    throw new Problem(
      400,
      `--deliver \u53EA\u80FD\u662F ${DELIVERS.join("\u3001")}\uFF08\u6536\u5230\uFF1A${value ?? "\u7A7A"}\uFF09`,
      "usage"
    );
  return value;
}
function issue(value) {
  const number = Number(value);
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number))
    throw new Problem(400, "--issue \u5E94\u4E3A\u6B63\u6574\u6570 issue \u53F7", "usage");
  return number;
}
function existing(value, flag, kind) {
  const path6 = resolve2(value);
  const stat = existsSync(path6) ? statSync2(path6) : null;
  if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    throw new Problem(
      400,
      `${flag} \u6307\u5411\u7684${kind === "file" ? "\u6587\u4EF6" : "\u76EE\u5F55"}\u4E0D\u5B58\u5728\uFF1A${path6}`,
      "usage"
    );
  return path6;
}
function queuedReason(events) {
  const detail4 = events.findLast((event) => event.kind === "queued")?.detail;
  if (detail4) {
    try {
      const reason3 = JSON.parse(detail4).reason;
      if (typeof reason3 === "string") return reason3;
    } catch {
    }
  }
  return "\u7B49\u5F85\u6267\u884C\u8005\u53EF\u7528\u540E\u81EA\u52A8\u62C9\u8D77";
}
var line = (task) => [
  task.ref,
  `[${displayStatus(task)}]`,
  task.title,
  `\xB7 ${task.deliver}${task.issue ? ` #${task.issue}` : ""}`,
  task.child_summary ? `\xB7 ${formatChildSummary(task.child_summary)}` : "",
  task.worker ? `\xB7 ${task.worker}` : "",
  task.pr_url ? `\xB7 ${task.pr_url}` : ""
].filter(Boolean).join(" ");
function renderTree(nodes2, depth = 0) {
  return nodes2.flatMap((node) => [
    `${"  ".repeat(depth)}${line(node)}`,
    ...renderTree(node.children, depth + 1)
  ]);
}
function roleHint(task) {
  return task.role && !task.node_ref ? [
    `\u5C97\u4F4D ${task.role} \u6CA1\u6709\u5BF9\u5E94\u7EC4\u7EC7\u8282\u70B9\uFF0C\u6D3E\u6D3B\u65F6\u6CA1\u6709\u5C97\u4F4D\u8BF4\u660E\uFF1B\u5173\u8054\u8282\u70B9\uFF1Aatrium org link-roles`
  ] : [];
}
function partInput(values) {
  const part = str3(values, "part"), goal = str3(values, "goal");
  if (part !== void 0 && goal !== void 0)
    throw new Problem(
      400,
      "--part \u4E0E --goal \u53EA\u80FD\u7ED9\u4E00\u4E2A\uFF1B--goal \u5DF2\u6539\u4E3A\u5F52\u5C5E\u90E8\u5206\uFF0C\u7528 --part",
      "usage"
    );
  return part !== void 0 ? { part } : goal !== void 0 ? { goal } : {};
}
function alsoText(task) {
  return [
    ...task.also ?? [],
    ...(task.also_auto ?? []).map((r) => `${r}\uFF08\u81EA\u52A8\uFF09`)
  ].join("\u3001");
}
var add = {
  args: "\u6807\u9898 [--parent tN] [--part \u8282\u70B9] [--also \u90E8\u5206[,\u90E8\u5206]] [--by \u4E13\u5458] [--ask \u4E13\u5458[,\u4E13\u5458]] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--urgent] [--priority \u95F2\u65F6|\u666E\u901A] [--from \u8282\u70B9] [--repo \u8DEF\u5F84] [--brief \u6587\u4EF6|-] [--owner \u8BA2\u9605\u8005] [--deliver pr|comment|none] [--issue \u53F7]",
  about: "\u5EFA\u4EFB\u52A1\uFF1B--by \u6307\u5B9A\u5E72\u6D3B\u7684\u4E13\u5458\uFF08\u6D3E\u6D3B\u9644\u6280\u80FD\u4E0E\u4EA4\u4ED8\u5173\u5361\uFF09\uFF0C--ask \u8BF7\u4E13\u5458\u6309\u6E05\u5355\u5BA1\uFF08\u53EF\u591A\u4F4D\uFF09\uFF1B--part \u5199\u5F52\u5C5E\u90E8\u5206\uFF08\u8D1F\u8D23\u4E0E\u6C47\u62A5\u53EA\u5728\u8FD9\u4E00\u5904\uFF09\uFF0C--also \u5199\u8FD8\u7275\u6D89\u7684\u90E8\u5206\uFF08\u6D3E\u6D3B\u9644\u5B83\u4EEC\u7684\u8981\u70B9\u3001\u53EF\u8BF7\u5B83\u4EEC\u7684\u4E13\u5458\u3001\u77E5\u4F1A\u5B83\u4EEC\u7684 leader\uFF1B\u7BA1\u65B9\u9762\u7684\u8981\u70B9\u9002\u7528\u4E8E\u5F52\u5C5E\u90E8\u5206\u7684\u81EA\u52A8\u7275\u6D89\uFF09\uFF0C--from \u5199\u6295\u4EFB\u52A1\u7684\u8282\u70B9\uFF0C--brief \u9644\u4EFB\u52A1\u8BE6\u8FF0 md\uFF08\u5EFA\u4EFB\u52A1\u65F6\u8BFB\u5165\u5B58\u5E93\uFF0C\u81F3\u591A 64 KB\uFF1B- \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\uFF09\uFF1B--urgent \u6807\u7D27\u6025\uFF08\u8DF3\u8FC7\u672C\u673A\u8D1F\u8F7D\u9650\u5236\u3001\u6392\u961F\u63D2\u5230\u6700\u524D\uFF09\uFF1B--priority \u95F2\u65F6|\u666E\u901A\uFF08\u4E0D\u5199\u6309\u5F52\u5C5E\u90E8\u5206\uFF1A\u7BA1\u65B9\u9762\u7684\u90E8\u5206\u7F3A\u7701\u95F2\u65F6\uFF0C\u6392\u5728\u666E\u901A\u4EFB\u52A1\u540E\u9762\u3001\u6709\u7A7A\u95F2\u6267\u884C\u8005\u624D\u6D3E\uFF09\uFF1B\u65E7 --job\u3001--concern\u3001--role \u6682\u53EF\u7528",
  options: {
    parent: { type: "string" },
    part: { type: "string" },
    also: { type: "string" },
    concern: { type: "string" },
    ask: { type: "string" },
    goal: { type: "string" },
    role: { type: "string" },
    job: { type: "string" },
    by: { type: "string" },
    from: { type: "string" },
    repo: { type: "string" },
    brief: { type: "string" },
    owner: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
    urgent: { type: "boolean" },
    priority: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [title], values, json }) {
    for (const [old, replacement] of [
      ["job", "by"],
      ["concern", "ask"]
    ])
      if (str3(values, old) !== void 0)
        console.error(`--${old} \u5DF2\u6539\u4E3A --${replacement}\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528`);
    if (str3(values, "role") !== void 0)
      console.error(
        "--role \u5DF2\u8FC7\u65F6\uFF1B\u4E13\u5458\u7528 --by\uFF0C\u5F52\u5C5E\u90E8\u5206\u7528 --part\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528"
      );
    const parent = str3(values, "parent");
    const repo = str3(values, "repo");
    const brief = str3(values, "brief");
    const kind = str3(values, "deliver");
    const issueText = str3(values, "issue");
    if (kind === "comment" && issueText === void 0)
      throw new Problem(
        400,
        "--deliver comment \u9700\u540C\u65F6\u7ED9 --issue <\u53F7>",
        "usage"
      );
    if (!title?.trim())
      throw new Problem(
        400,
        "\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A",
        "usage",
        void 0,
        "atrium task add \u6807\u9898"
      );
    const body = {
      title,
      ...parent === void 0 ? {} : { parent: ref(parent, "--parent") },
      ...str3(values, "job") === void 0 ? {} : { job: str3(values, "job") },
      ...str3(values, "by") === void 0 ? {} : { by: str3(values, "by") },
      ...str3(values, "role") === void 0 ? {} : { role: str3(values, "role") },
      ...str3(values, "from") === void 0 ? {} : { from: str3(values, "from") },
      ...partInput(values),
      ...str3(values, "also") === void 0 ? {} : { also: str3(values, "also") },
      ...str3(values, "concern") === void 0 ? {} : { concern: str3(values, "concern") },
      ...str3(values, "ask") === void 0 ? {} : { ask: str3(values, "ask") },
      ...repo === void 0 ? {} : { repo: existing(repo, "--repo", "directory") },
      ...brief === void 0 ? {} : await briefInput(brief, (path6) => existing(path6, "--brief", "file")),
      ...str3(values, "owner") === void 0 ? {} : { owner: str3(values, "owner") },
      ...kind === void 0 ? {} : { deliver: deliver(kind) },
      ...issueText === void 0 ? {} : { issue: issue(issueText) },
      ...str3(values, "after") === void 0 ? {} : { after: str3(values, "after") },
      ...str3(values, "after-pr") === void 0 ? {} : { after_pr: str3(values, "after-pr") },
      ...values.auto === true ? { auto: true } : {},
      ...values.urgent === true ? { urgent: true } : {},
      ...priorityInput(values)
    };
    const task = await (await client3()).post("/tasks", body);
    if (json) printJson(task);
    else
      console.log(
        [
          `\u5DF2\u5EFA ${task.ref}\uFF1A${task.title}${task.parent_ref ? `\uFF08\u7236\u4EFB\u52A1 ${task.parent_ref}\uFF09` : ""}${task.node_ref ? ` \xB7 \u8BB0\u5728 ${task.node_ref}` : ""}${task.origin_ref ? ` \xB7 ${task.origin_ref} \u6295\u6765` : ""}${task.part_ref ? ` \xB7 \u5F52\u5C5E ${task.part_ref}` : ""}${alsoText(task) ? ` \xB7 \u7275\u6D89 ${alsoText(task)}` : ""}${task.concerns?.length ? ` \xB7 \u8BF7\u4E86 ${task.concerns.map((c) => c.name).join("\u3001")}` : ""}`,
          ...urgentLines(task),
          ...roleHint(task),
          ...hintLines(task)
        ].join("\n")
      );
    recordNext(
      str3(values, "after") || str3(values, "after-pr") || values.auto === true ? "\u770B\u6392\u671F\uFF1Aatrium task plan" : task.parent_ref ? `\u770B\u5019\u9009\u5E76\u6D3E\u6D3B\uFF1Aatrium task pick ${task.ref}` : `\u62C6\u5B50\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --parent ${task.ref}`
    );
  }
};
var ls = {
  args: "[--status S] [--parent tN] [--after tN]",
  about: "\u5217\u4EFB\u52A1\uFF0C\u6309\u77ED\u53F7\u5347\u5E8F\uFF0C\u6BCF\u9875 200 \u6761",
  options: {
    status: { type: "string" },
    parent: { type: "string" },
    after: { type: "string" }
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const search = new URLSearchParams();
    const wanted = str3(values, "status");
    if (wanted !== void 0) search.set("status", status(wanted));
    const parent = str3(values, "parent");
    if (parent !== void 0) search.set("parent", ref(parent, "--parent"));
    const after = str3(values, "after");
    if (after !== void 0) search.set("after", ref(after, "--after"));
    const result = await (await client3()).get(
      `/tasks${search.size ? `?${search}` : ""}`
    );
    if (json) printJson(result);
    else if (!result.tasks.length)
      console.log(
        wanted || parent || after ? "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4EFB\u52A1" : "\u8FD8\u6CA1\u6709\u4EFB\u52A1"
      );
    else {
      const lines = table([
        ["\u77ED\u53F7", "\u72B6\u6001", "\u7236\u4EFB\u52A1", "\u6807\u9898", "\u6267\u884C\u8005", "PR"],
        ...result.tasks.map((task) => [
          task.ref,
          displayStatus(task),
          task.parent_ref ?? "",
          clip(`${tagText(task)}${task.title}`, 40),
          task.worker ?? "",
          task.pr_url ?? ""
        ])
      ]).split("\n");
      console.log(
        [
          lines[0],
          ...result.tasks.flatMap(
            (task, i) => [lines[i + 1], queueLine(task), noteLine(task)].filter(
              (line2) => !!line2
            )
          )
        ].join("\n")
      );
    }
    if (result.next_after) {
      search.set("after", result.next_after);
      const flags = [...search].map(([key, value]) => `--${key} ${value}`).join(" ");
      recordNext(`\u4E0B\u4E00\u9875\uFF1Aatrium task ls ${flags}`);
    } else if (result.tasks[0])
      recordNext(
        `\u5728\u8DD1\u7684\u5728\u5B9E\u65F6\u89C6\u56FE\u91CC\u770B\uFF08--once \u6253\u5370\u4E00\u6B21\u3001--json \u7ED9\u811A\u672C\uFF09\uFF1Aatrium top
\u770B\u8BE6\u60C5\uFF1Aatrium task show ${result.tasks[0].ref}`
      );
    else recordNext("\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898");
  }
};
var show = {
  args: "tN",
  about: "\u770B\u4EFB\u52A1\u8BE6\u60C5\u4E0E\u6700\u8FD1\u4E8B\u4EF6",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const task = await (await client3()).get(`/tasks/${ref(reference, "\u4EFB\u52A1")}`);
    if (json) printJson(task);
    else {
      const rows = [
        ["\u6807\u9898", task.title],
        ["\u72B6\u6001", displayStatus(task)],
        [
          "\u7D27\u6025",
          task.urgent === 1 ? "\u662F\uFF08\u8DF3\u8FC7\u672C\u673A\u8D1F\u8F7D\u9650\u5236\uFF0C\u6392\u961F\u63D2\u5230\u6700\u524D\uFF09" : null
        ],
        [
          "\u4F18\u5148\u7EA7",
          task.priority === "idle" ? `${PRIORITY_LABEL.idle}\uFF08\u6392\u5728\u666E\u901A\u4EFB\u52A1\u540E\u9762\uFF0C\u6709\u7A7A\u95F2\u6267\u884C\u8005\u624D\u6D3E\uFF09` : null
        ],
        ["\u5408\u5165\u4EA4\u56DE\u6B21\u6570", task.merge_returns || null],
        ["\u5BA1\u9605\u4EFB\u52A1", task.review_task ? `t${task.review_task}` : null],
        ["\u6392\u961F\u539F\u56E0", task.queued_reason ?? null],
        ["\u7403\u5728\u8C01\u624B\u91CC", task.holder?.text ?? null],
        ["\u6700\u65B0\u5907\u6CE8", task.note],
        ["\u5907\u6CE8\u4F5C\u8005", task.note ? noteAuthor(task) : null],
        ["\u5907\u6CE8\u65F6\u95F4", task.note_at ? when(task.note_at) : null],
        ["\u7236\u4EFB\u52A1", task.parent_ref],
        ["\u5B50\u4EFB\u52A1", task.children || null],
        [
          "\u5B50\u4EFB\u52A1\u6C47\u603B",
          task.child_summary ? formatChildSummary(task.child_summary) : null
        ],
        [
          "\u5C97\u4F4D",
          task.role ? `${task.role}${task.node_ref && task.node_ref !== task.role ? `\uFF08${task.node_ref}\uFF09` : ""}` : task.node_ref
        ],
        ["\u6295\u4EFB\u52A1\u7684\u8282\u70B9", task.origin_ref],
        ["\u5F52\u5C5E\u90E8\u5206", task.part_ref],
        ["\u7275\u6D89\u90E8\u5206", alsoText(task) || null],
        ["\u8BF7\u7684\u4E13\u5458", concernsText(task.concerns)],
        ["\u539F\u91CC\u7A0B\u7891", task.goal_ref],
        ["\u4ED3\u5E93", task.repo],
        [
          "\u4EA4\u4ED8\u7269",
          `${task.deliver}${task.issue ? `\uFF08issue #${task.issue}\uFF09` : ""}`
        ],
        ["\u8BE6\u8FF0\u6765\u6E90", task.brief_path],
        ["\u8D1F\u8D23\u4EBA", task.owner],
        ["\u5E72\u6D3B\u7684\u4E13\u5458", task.job_ref],
        ["\u6267\u884C\u8005", task.worker],
        ["\u4E3B\u673A", task.host_ref ?? null],
        ["\u8FDB\u7A0B", task.pid],
        ["\u5DE5\u4F5C\u6811", task.worktree],
        ["\u5206\u652F", task.branch],
        ["PR", task.pr_url],
        ["CI", task.ci],
        ["\u5EFA\u4E8E", when(task.created_at)],
        ["\u5F00\u59CB", task.started_at ? when(task.started_at) : null],
        ["\u7ED3\u675F", task.ended_at ? when(task.ended_at) : null]
      ];
      console.log(
        [
          `${task.ref} \xB7 ${tagText(task)}${task.title}`,
          ...rows.slice(1).filter(([, value]) => value !== null && value !== "").map(([key, value]) => `  ${key}\uFF1A${value}`),
          ...hintLines(task, true).map((line2) => `  ${line2}`),
          ...task.brief?.trim() ? [
            "\u8BE6\u8FF0\uFF1A",
            ...task.brief.trimEnd().split("\n").map((line2) => `  ${line2}`)
          ] : task.brief_path ? [
            `\u8BE6\u8FF0\uFF1A\u6CA1\u6709\u8FDB\u5E93\uFF08\u539F\u6587\u4EF6\u8BFB\u4E0D\u5230\uFF09\uFF0C\u8865\u4E0A\uFF1Aatrium task set ${task.ref} --brief \u6587\u4EF6`
          ] : [],
          ...task.holder?.detail?.trim() ? [
            "\u539F\u56E0\u5168\u6587\uFF1A",
            ...task.holder.detail.trimEnd().split("\n").map((line2) => `  ${line2}`)
          ] : [],
          ...task.result ? ["\u7ED3\u679C\u6458\u8981\uFF1A", task.result] : [],
          ...task.events.length ? [
            "\u4E8B\u4EF6\uFF1A",
            ...task.events.map(
              (event) => `  ${when(event.at)}  ${event.kind}${event.kind === "tell" ? `  ${tellLine(event.detail)}` : event.detail ? `  ${clip(event.detail, 80)}` : ""}`
            )
          ] : []
        ].join("\n")
      );
    }
    recordNext(
      task.children ? `\u770B\u5B50\u6811\uFF1Aatrium task tree ${task.ref}` : `\u62C6\u5B50\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --parent ${task.ref}`
    );
  }
};
var tree = {
  args: "[tN]",
  about: "\u7F29\u8FDB\u6811\uFF1A\u77ED\u53F7\u3001\u72B6\u6001\u3001\u6807\u9898\u3001\u4EA4\u4ED8\u7269\u3001\u6267\u884C\u8005\u3001PR\uFF1B\u4E0D\u5199 tN \u663E\u793A\u5168\u90E8\u9876\u5C42\u4EFB\u52A1",
  positionals: [0, 1],
  async run({ positionals: [root], json }) {
    const result = await (await client3()).get(
      `/tasks/tree${root === void 0 ? "" : `?root=${ref(root, "\u4EFB\u52A1")}`}`
    );
    if (json) printJson(result);
    else if (!result.tasks.length) console.log("\u8FD8\u6CA1\u6709\u4EFB\u52A1");
    else {
      console.log(renderTree(result.tasks).join("\n"));
      if (result.truncated) console.log("\uFF08\u4EFB\u52A1\u8FC7\u591A\uFF0C\u53EA\u663E\u793A\u524D 2000 \u4E2A\uFF09");
    }
    recordNext(
      result.tasks.length ? `\u770B\u8BE6\u60C5\uFF1Aatrium task show ${root ?? result.tasks[0].ref}` : "\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898"
    );
  }
};
var set = {
  args: "tN [--status S] [--pr URL] [--by \u4E13\u5458|''] [--ask \u4E13\u5458[,\u4E13\u5458]|''] [--from \u8282\u70B9|''] [--part \u8282\u70B9|''] [--also \u90E8\u5206[,\u90E8\u5206]|''] [--brief \u6587\u4EF6|-|''] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--urgent|--no-urgent] [--priority \u95F2\u65F6|\u666E\u901A]",
  about: `\u4EBA\u5DE5\u4FEE\u6B63\u72B6\u6001\uFF08${TASK_STATUSES.filter((s) => s !== "running").join("\u3001")}\uFF09\uFF1B\u4E5F\u53EF\u8865\u767B PR \u6216\u6539\u6807\u9898\u3001\u5E72\u6D3B\u6216\u8BF7\u6765\u770B\u7684\u4E13\u5458\u3001\u5F52\u5C5E\u90E8\u5206\u3001\u7275\u6D89\u90E8\u5206\u3001\u8BE6\u8FF0\u3001\u4EA4\u4ED8\u7269\u3001\u4F9D\u8D56\u3001\u81EA\u52A8\u6D3E\u53D1\u3001\u7D27\u6025\uFF08--urgent \u8DF3\u8FC7\u672C\u673A\u8D1F\u8F7D\u9650\u5236\uFF0C\u6392\u961F\u4E2D\u7684\u7ACB\u523B\u6309\u7D27\u6025\u91CD\u6392\uFF09\u548C\u4F18\u5148\u7EA7\uFF08--priority \u95F2\u65F6 \u6392\u5728\u666E\u901A\u4EFB\u52A1\u540E\u9762\u3001\u6709\u7A7A\u95F2\u6267\u884C\u8005\u624D\u6D3E\uFF1B\u666E\u901A\u7167\u5E38\u6392\uFF1B\u5728\u8DD1\u7684\u4E0D\u6253\u65AD\uFF09`,
  options: {
    status: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    job: { type: "string" },
    by: { type: "string" },
    from: { type: "string" },
    part: { type: "string" },
    also: { type: "string" },
    concern: { type: "string" },
    ask: { type: "string" },
    goal: { type: "string" },
    brief: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    pr: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
    urgent: { type: "boolean" },
    "no-urgent": { type: "boolean" },
    priority: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    for (const [old, replacement] of [
      ["job", "by"],
      ["concern", "ask"]
    ])
      if (str3(values, old) !== void 0)
        console.error(`--${old} \u5DF2\u6539\u4E3A --${replacement}\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528`);
    if (str3(values, "role") !== void 0)
      console.error(
        "--role \u5DF2\u8FC7\u65F6\uFF1B\u4E13\u5458\u7528 --by\uFF0C\u5F52\u5C5E\u90E8\u5206\u7528 --part\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528"
      );
    const id = ref(reference, "\u4EFB\u52A1");
    const body = {};
    const wanted = str3(values, "status");
    if (wanted !== void 0) body.status = status(wanted);
    const title = str3(values, "title");
    if (title !== void 0) {
      if (!title.trim()) throw new Problem(400, "--title \u4E0D\u80FD\u4E3A\u7A7A", "usage");
      body.title = title;
    }
    const role = str3(values, "role");
    if (role !== void 0) body.role = role;
    const job = str3(values, "job");
    if (job !== void 0) body.job = job;
    const by = str3(values, "by");
    if (by !== void 0) body.by = by;
    const from = str3(values, "from");
    if (from !== void 0) body.from = from;
    Object.assign(body, partInput(values));
    if (str3(values, "also") !== void 0) body.also = str3(values, "also");
    const concern = str3(values, "concern");
    if (concern !== void 0) body.concern = concern;
    const ask = str3(values, "ask");
    if (ask !== void 0) body.ask = ask;
    const brief = str3(values, "brief");
    if (brief === "") body.brief = "";
    else if (brief !== void 0)
      Object.assign(
        body,
        await briefInput(brief, (path6) => existing(path6, "--brief", "file"))
      );
    const kind = str3(values, "deliver");
    if (kind !== void 0) body.deliver = deliver(kind);
    const issueText = str3(values, "issue");
    if (issueText !== void 0) body.issue = String(issue(issueText));
    const pr = str3(values, "pr");
    if (pr !== void 0) body.pr_url = pr;
    if (str3(values, "after") !== void 0) body.after = str3(values, "after");
    if (str3(values, "after-pr") !== void 0)
      body.after_pr = str3(values, "after-pr");
    if (values.auto === true) body.auto = true;
    if (values.urgent === true && values["no-urgent"] === true)
      throw new Problem(400, "--urgent \u4E0E --no-urgent \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
    if (values.urgent === true) body.urgent = true;
    if (values["no-urgent"] === true) body.urgent = false;
    Object.assign(body, priorityInput(values));
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "\u81F3\u5C11\u7ED9\u4E00\u9879\uFF1A--status\u3001--pr\u3001--title\u3001--by\u3001--ask\u3001--from\u3001--part\u3001--also\u3001--brief\u3001--deliver\u3001--issue\u3001--after\u3001--after-pr\u3001--auto\u3001--urgent/--no-urgent \u6216 --priority",
        "usage",
        void 0,
        `atrium task set ${id} --status done`
      );
    const task = await (await client3()).patch(`/tasks/${id}`, body);
    if (json) printJson(task);
    else
      console.log(
        [
          `${task.ref} \u5DF2\u66F4\u65B0 \xB7 [${task.status}] ${task.title}`,
          ...body.urgent === true ? urgentLines(task) : [],
          ...body.urgent === false ? ["\u5DF2\u53D6\u6D88\u7D27\u6025\uFF1A\u7167\u5E38\u53D7\u672C\u673A\u8D1F\u8F7D\u9650\u5236"] : [],
          ...body.priority === "idle" && body.urgent !== true ? urgentLines(task) : [],
          ...body.priority === "normal" ? ["\u4F18\u5148\u7EA7\uFF1A\u666E\u901A\uFF0C\u7167\u5E38\u6392\uFF08\u7D27\u6025\u7684\u4ECD\u5728\u524D\uFF09"] : [],
          ...role !== void 0 ? roleHint(task) : [],
          ...concern !== void 0 || ask !== void 0 ? [
            task.concerns?.length ? `\u8BF7\u4E86 ${task.concerns.map((c) => `${c.name}\uFF08${c.ref}\uFF09`).join("\u3001")}\uFF1A\u6D3E\u6D3B\u65F6\u9644\u68C0\u67E5\u8981\u70B9\uFF0C\u4EA4\u4ED8\u540E\u6309\u6E05\u5355\u5BA1` : "\u6CA1\u6709\u8BF7\u4E13\u5458"
          ] : [],
          ...hintLines(task)
        ].join("\n")
      );
    recordNext(`\u770B\u5168\u8C8C\uFF1Aatrium task tree ${task.parent_ref ?? task.ref}`);
  }
};
var note = {
  args: "tN \u6587\u5B57 [--as \u8EAB\u4EFD] [--verdict ok|fixed|rejected]",
  about: "\u8FFD\u52A0\u5904\u7406\u5907\u6CE8\uFF08\u6700\u591A 300 \u5B57\uFF09\uFF1B\u6700\u65B0\u4E00\u6761\u663E\u793A\u4E3A\u5F53\u524D\u8BF4\u660E",
  options: { as: { type: "string" }, verdict: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, text], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const result = await (await client3()).post(`/tasks/${id}/note`, {
      text,
      by: str3(values, "as") ?? leaderSession()?.leader ?? "u1",
      ...str3(values, "verdict") ? { verdict: str3(values, "verdict") } : {}
    });
    if (json) printJson(result);
    else console.log(`${id} \u5DF2\u8FFD\u52A0\u5907\u6CE8\uFF08${result.note_by}\uFF09\uFF1A${result.note}`);
    recordNext(`\u770B\u8BE6\u60C5\uFF1Aatrium task show ${id}`);
  }
};
var TELL_VIA = {
  stdin: "\u5373\u65F6\u9001\u5165",
  resume: "\u7EED\u4E0A\u4F1A\u8BDD",
  restart: "\u505C\u6389\u91CD\u6D3E",
  prompt: "\u5199\u8FDB\u63D0\u793A\u8BCD"
};
var TELL_STATE = {
  pending: "\u5F85\u9001\u8FBE",
  written: "\u5DF2\u5199\u5165\uFF0C\u5F85\u786E\u8BA4"
};
function tellLine(detail4) {
  try {
    const tell2 = JSON.parse(detail4 ?? "");
    const state2 = tell2.state === "delivered" ? `\u5DF2\u9001\u8FBE\xB7${TELL_VIA[tell2.delivered_via ?? ""] ?? tell2.delivered_via}` : TELL_STATE[tell2.state ?? ""] ?? "\u5F85\u9001\u8FBE";
    return `${tell2.by ?? "\u672A\u77E5"} [${state2}] ${clip((tell2.text ?? "").replace(/\s+/g, " "), 80)}`;
  } catch {
    return clip(detail4 ?? "", 80);
  }
}
var tell = {
  args: "tN \u6587\u5B57 [--as \u8EAB\u4EFD] [--verdict ok|fixed|rejected]",
  about: "\u7ED9\u5728\u8DD1\u7684\u6267\u884C\u8005\u634E\u8BDD\uFF1AClaude Code \u5373\u65F6\u9001\u5165\uFF0Ccodex \u672C\u8F6E\u7ED3\u675F\u540E\u7EED\u4E0A\u4F1A\u8BDD\uFF0C\u5176\u4F59\u505C\u6389\u5E26\u7740\u8865\u5145\u91CD\u6D3E\uFF1B\u4E0D\u5728\u8DD1\u7684\u4E0B\u6B21\u62C9\u8D77\u65F6\u5199\u8FDB\u63D0\u793A\u8BCD",
  options: { as: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, text], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const result = await (await client3()).post(
      `/tasks/${id}/tell`,
      { text, by: str3(values, "as") ?? leaderSession()?.leader ?? "u1" }
    );
    if (json) printJson(result);
    else console.log(`${id} \u5DF2\u767B\u8BB0\u634E\u8BDD\uFF08${result.tell.by}\uFF09\uFF1A${result.how}`);
    recordNext(`\u770B\u9001\u8FBE\u72B6\u6001\uFF1Aatrium task show ${id}`);
  }
};
var plan = {
  args: "[--after tN]",
  about: "\u6309\u5728\u8DD1\u3001\u5C31\u7EEA\u3001\u7B49\u5F85\u4E2D\u3001\u5361\u4F4F\u5217\u51FA\u5F85\u529E\u53CA\u4F9D\u8D56\uFF1B--json \u7ED9\u811A\u672C",
  options: { after: { type: "string" } },
  positionals: [0, 0],
  async run({ values, json }) {
    const after = str3(values, "after");
    const result = await (await client3()).get(`/tasks/plan${after ? `?after=${ref(after, "--after")}` : ""}`);
    if (json) printJson(result);
    else {
      for (const [group, label2] of [
        ["running", "\u5728\u8DD1"],
        ["ready", "\u5C31\u7EEA"],
        ["waiting", "\u7B49\u5F85\u4E2D"],
        ["blocked", "\u5361\u4F4F"]
      ]) {
        console.log(`${label2}\uFF08${result.groups[group].length}\uFF09`);
        for (const item of result.groups[group])
          console.log(
            `  ${item.task.ref} ${tagText(item.task)}${item.task.title}${item.task.queued_reason ? ` \xB7 ${queuedText(item.task.queued_reason)}` : ""}${item.waiting_for.length ? ` \xB7 \u7B49 ${item.waiting_for.join("\u3001")}` : ""}${item.reason ? ` \xB7 ${item.reason}` : ""}`
          );
      }
    }
    recordNext(
      result.next_after ? `\u4E0B\u4E00\u9875\uFF1Aatrium task plan --after ${result.next_after}` : "\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898"
    );
  }
};
var done = {
  args: "tN",
  about: "\u4EBA\u5DE5\u5B8C\u6210\u4EFB\u52A1\uFF1B\u7B49\u540C task set tN --status done",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const task = await (await client3()).patch(`/tasks/${id}`, { status: "done" });
    if (json) printJson(task);
    else console.log(`${task.ref} \u5DF2\u5B8C\u6210 \xB7 ${task.title}`);
    recordNext("\u770B\u6392\u671F\uFF1Aatrium task plan");
  }
};
var run = {
  args: "tN [--worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]] [--risk low|medium|high] [--host hN] [--urgent]",
  about: "\u6D3E\u7ED9\u6267\u884C\u8005\uFF08\u670D\u52A1\u6301\u6709\u8FDB\u7A0B\uFF09\uFF1B\u4E0D\u5199 --worker \u6309\u989D\u5EA6\u6311\uFF0C--risk \u7F3A\u7701 low\uFF1B--host \u6D3E\u5230\u6307\u5B9A\u7684\u6267\u884C\u673A\u5668\uFF08\u4E0D\u5199\u5728\u80FD\u63A5\u7684\u4E3B\u673A\u91CC\u6311\u6700\u7A7A\u7684\uFF09\uFF1B--urgent \u540C\u65F6\u6807\u7D27\u6025\uFF0C\u8DF3\u8FC7\u8D1F\u8F7D\u9650\u5236\uFF08\u989D\u5EA6\u4FDD\u7559\u3001trust\u3001\u4F9D\u8D56\u7167\u65E7\uFF09",
  options: {
    worker: { type: "string" },
    risk: { type: "string" },
    host: { type: "string" },
    urgent: { type: "boolean" }
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const body = {};
    if (values.urgent === true) body.urgent = true;
    const worker = str3(values, "worker");
    if (worker !== void 0) {
      if (!worker.trim())
        throw new Problem(
          400,
          "--worker \u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5982 codex+gpt-6-sol",
          "usage"
        );
      body.worker = worker;
    }
    const risk = str3(values, "risk");
    if (risk !== void 0) {
      if (!["low", "medium", "high"].includes(risk))
        throw new Problem(
          400,
          `--risk \u53EA\u80FD\u662F low\u3001medium\u3001high\uFF08\u6536\u5230\uFF1A${risk}\uFF09`,
          "usage"
        );
      body.risk = risk;
    }
    const host = str3(values, "host");
    if (host !== void 0) {
      if (!/^h[1-9][0-9]{0,8}$/.test(host.trim()))
        throw new Problem(
          400,
          `--host \u5E94\u4E3A\u4E3B\u673A\u77ED\u53F7\uFF0C\u5982 h2\uFF08\u6536\u5230\uFF1A${host}\uFF09`,
          "usage",
          void 0,
          "atrium host ls"
        );
      body.host = host.trim();
    }
    const result = await (await client3()).post(`/tasks/${id}/run`, body);
    const { task } = result;
    if (json) printJson(result);
    else
      console.log(
        [
          result.reassigned && result.queued ? `${task.ref} \u5DF2\u6539\u6D3E\u7ED9 ${result.reassigned.worker}\uFF0C\u4ECD\u5728\u6392\u961F\uFF1A${result.reassigned.reason ?? queuedReason(task.events)}` : result.reassigned && task.status !== "running" ? `${task.ref} \u5DF2\u6539\u6D3E\u7ED9 ${result.reassigned.worker}\uFF0C\u73B0\u5728 ${task.status}` : result.queued ? `${task.ref} \u6392\u961F\u4E2D\uFF1A${queuedReason(task.events)}` : `\u5DF2${result.reassigned ? "\u6539" : ""}\u6D3E ${task.ref} \u7ED9 ${task.worker}\uFF08${task.host_ref ? `${task.host_ref} \u4E0A ` : ""}PID ${task.pid}${task.worktree ? `\uFF0C\u5DE5\u4F5C\u6811 ${task.worktree}\uFF0C\u5206\u652F ${task.branch}` : ""}\uFF09`,
          ...urgentLines(task),
          ...pickLines(result.pick)
        ].join("\n")
      );
    recordNext(`\u7B49\u7ED3\u679C\uFF1Aatrium task wait ${task.ref}`);
  }
};
function pickLines(pick2) {
  if (!pick2) return [];
  return [
    ...pick2.auto && pick2.reason ? [`\u6309\u989D\u5EA6\u6311\u4E86 ${pick2.worker}\uFF0C\u56E0\u4E3A${pick2.reason}`] : [],
    ...pick2.notice ? [pick2.notice] : []
  ];
}
var accountCell = (q) => {
  if (q.held_until !== null) return `\u989D\u5EA6\u7528\u5C3D\u81F3 ${when(q.held_until)}`;
  const parts = [
    q.used_percent === null ? null : `\u5DF2\u7528 ${Math.round(q.used_percent)}%`,
    q.spare_percent === null ? null : `\u5BCC\u4F59 ${signedPercent(q.spare_percent)}`,
    q.hours_to_reset === null ? null : `${q.hours_to_reset < 10 ? q.hours_to_reset.toFixed(1) : Math.round(q.hours_to_reset)} \u5C0F\u65F6\u540E\u91CD\u7F6E`,
    q.left_percent === null ? null : `\u6263\u4FDD\u7559\u5269 ${Math.round(q.left_percent)}%`
  ].filter(Boolean);
  return parts.length ? `${q.account} ${parts.join("\uFF0C")}` : `${q.account} \u65E0\u6570\u636E`;
};
var recordCell = (r) => !r || !r.deliveries ? "\u65E0\u8BB0\u5F55" : `${r.deliveries} \u6B21${r.first_pass_rate === null ? "" : `\uFF0C\u4E00\u6B21\u901A\u8FC7 ${Math.round(r.first_pass_rate * 100)}%`}${r.low_data ? "\uFF08\u6837\u672C\u5C11\uFF09" : ""}`;
var takeCell = (c, job) => [
  c.eligible ? "\u80FD\u63A5" : `\u4E0D\u80FD\u63A5\uFF1A${c.refusals.join("\uFF1B")}`,
  c.preferred !== null && job ? `${job.name}\u4E13\u5458\u7B2C ${c.preferred} \u9009` : "",
  ...c.notes
].filter(Boolean).join(" \xB7 ");
function specialistLine(list3) {
  const near = list3.filter((s) => s.scope !== "org").map((s) => `${s.name}\uFF08${s.part_name ?? s.part}\uFF09`);
  const org = list3.filter((s) => s.scope === "org").map((s) => s.name);
  return `\u80FD\u8BF7\u7684\u4E13\u5458\uFF1A${[...near, ...org.length ? [`\u5168\u7EC4\u7EC7\u7684 ${org.join("\u3001")}`] : []].join("\uFF1B") || "\u65E0"}`;
}
function hostPickLines(hosts, worker) {
  if (!hosts?.length || !worker) return [];
  return [
    "",
    `\u4E3B\u673A\uFF08\u6309\u63A8\u8350\u7684 ${worker}\uFF09\uFF1A`,
    table(
      hosts.map((h) => [
        h.chosen ? "\u2192" : "",
        h.ref,
        h.name,
        h.status,
        `${h.running}/${h.max ?? "\u4E0D\u9650"}`,
        h.fit === "ok" ? "\u80FD\u63A5" : h.fit === "later" ? `\u6392\u961F\uFF1A${h.reason}` : `\u4E0D\u80FD\u63A5\uFF1A${h.reason}`
      ])
    )
  ];
}
function formatPick(view) {
  const head = view.recommended ? `\u63A8\u8350 ${view.recommended}\uFF1A${view.reason}` : `\u6682\u65E0\u63A8\u8350\uFF1A${view.reason}`;
  const meta = `${view.task} \xB7 risk=${view.risk}${view.job ? ` \xB7 \u5E72\u6D3B\u7684\u4E13\u5458 ${view.job.name}\uFF08${view.job.ref}\uFF09` : " \xB7 \u6CA1\u6307\u5B9A\u5E72\u6D3B\u7684\u4E13\u5458"} \xB7 \u6839\u7AE0\u7A0B\u7ED9\u7528\u6237\u4FDD\u7559 ${view.reserve_percent}%${view.quota_known ? "" : " \xB7 \u989D\u5EA6\u6570\u636E\u4E0D\u53EF\u7528"}`;
  const scope = view.specialists ? [
    ...view.specialists.job_outside ? [view.specialists.job_outside] : [],
    specialistLine(view.specialists.available)
  ] : [];
  if (!view.candidates.length) return [head, meta, ...scope].join("\n");
  return [
    head,
    meta,
    ...scope,
    ...hostPickLines(view.hosts, view.recommended),
    "",
    table([
      ["", "\u6267\u884C\u8005", "\u80FD\u4E0D\u80FD\u63A5", "\u8D26\u53F7\u989D\u5EA6", "\u6B63\u5FD9", "\u4EA4\u4ED8\u8BB0\u5F55"],
      ...view.candidates.map((c) => [
        c.rank === null ? "-" : String(c.rank),
        c.worker,
        takeCell(c, view.job),
        accountCell(c.quota),
        c.busy ? "\u6B63\u5FD9\uFF0C\u6D3E\u4E86\u4F1A\u6392\u961F" : "\u7A7A\u95F2",
        recordCell(c.record)
      ])
    ])
  ].join("\n");
}
var pick = {
  args: "tN [--risk low|medium|high]",
  about: "\u770B\u6D3E\u6D3B\u5019\u9009\uFF08\u53EA\u8BFB\uFF0C\u4E0D\u6D3E\uFF09\uFF1A\u5019\u9009\u6267\u884C\u8005\u80FD\u4E0D\u80FD\u63A5\u3001\u8D26\u53F7\u989D\u5EA6\u3001\u662F\u5426\u6B63\u5FD9\u3001\u5728\u5E72\u6D3B\u7684\u4E13\u5458\u4E0B\u7684\u4EA4\u4ED8\u8BB0\u5F55\uFF0C\u7ED9\u51FA\u63A8\u8350\u4E0E\u7406\u7531\uFF1B--risk \u7F3A\u7701 low",
  options: { risk: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const risk = str3(values, "risk");
    if (risk !== void 0 && !["low", "medium", "high"].includes(risk))
      throw new Problem(
        400,
        `--risk \u53EA\u80FD\u662F low\u3001medium\u3001high\uFF08\u6536\u5230\uFF1A${risk}\uFF09`,
        "usage"
      );
    const view = await (await client3()).get(
      `/tasks/${id}/pick${risk ? `?${new URLSearchParams({ risk })}` : ""}`
    );
    if (json) printJson(view);
    else console.log(formatPick(view));
    const riskFlag = risk && risk !== "low" ? ` --risk ${risk}` : "";
    recordNext(
      view.recommended ? `\u6D3E\u6D3B\uFF1Aatrium task run ${id} --worker ${view.recommended}${riskFlag}` : "\u770B\u989D\u5EA6\uFF1Aatrium quota"
    );
  }
};
var stop = {
  args: "tN [--as \u8BA2\u9605\u8005]",
  about: "\u505C\u6389\u6267\u884C\u8005\u6216\u5408\u5165\u961F\u5217\uFF1B\u7531\u6B64\u4EA7\u751F\u7684\u4E8B\u4EF6\u4E0D\u6295\u7ED9\u53D1\u8D77\u8005\u672C\u4EBA\uFF08\u7F3A\u7701 secretary\uFF09",
  options: { as: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const who = str3(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const result = await (await client3()).post(
      `/tasks/${id}/stop?${new URLSearchParams({ as: who })}`
    );
    if (json) printJson(result);
    else
      console.log(
        result.stopping ? `\u5DF2\u5411 ${id} \u7684\u6267\u884C\u8005\u53D1\u505C\u6B62\u4FE1\u53F7` : `${id} \u5DF2\u505C \xB7 [${result.task.status}]`
      );
    recordNext(
      result.stopping ? `\u7B49\u5B83\u9000\u51FA\uFF1Aatrium task wait ${id}` : `\u770B\u8BE6\u60C5\uFF1Aatrium task show ${id}`
    );
  }
};
var merge = {
  args: "tN",
  about: "\u5C06\u5173\u5361\u5DF2\u901A\u8FC7\u3001\u5E26 PR \u7684\u53D7\u963B\u5408\u5165\u4EFB\u52A1\u91CD\u65B0\u6392\u961F",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const result = await (await client3()).post(`/tasks/${id}/merge`, {});
    if (json) printJson(result);
    else console.log(`${id} \u5DF2\u91CD\u65B0\u6392\u961F\u5408\u5165`);
    recordNext(`\u7B49\u5408\u5165\uFF1Aatrium task wait ${id}`);
  }
};
var log = {
  args: "tN [--follow] [--after \u5B57\u8282]",
  about: "\u770B\u6267\u884C\u8005\u65E5\u5FD7\uFF1B--follow \u8DDF\u5230\u4EFB\u52A1\u7ED3\u675F\uFF0C--after \u4ECE\u4E0A\u6B21\u7684\u5B57\u8282\u504F\u79FB\u7EED\u8BFB",
  options: {
    follow: { type: "boolean", default: false },
    after: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const afterText = str3(values, "after");
    if (afterText !== void 0 && !/^(0|[1-9]\d*)$/.test(afterText))
      throw new Problem(400, "--after \u5E94\u4E3A\u975E\u8D1F\u6574\u6570\u5B57\u8282\u504F\u79FB", "usage");
    const follow = values.follow === true;
    if (follow && json)
      throw new Problem(400, "--follow \u4E0D\u80FD\u4E0E --json \u540C\u65F6\u4F7F\u7528", "usage");
    const api2 = await client3();
    let after = afterText === void 0 ? 0 : Number(afterText);
    for (; ; ) {
      const chunk = await api2.get(`/tasks/${id}/log?after=${after}`);
      if (json) {
        printJson(chunk);
        after = chunk.next;
        break;
      }
      if (chunk.text) process.stdout.write(chunk.text);
      const more = chunk.next < chunk.size;
      after = chunk.next;
      if (!follow) {
        if (!more && !chunk.text && !chunk.running)
          console.log(chunk.size ? "\uFF08\u6CA1\u6709\u65B0\u65E5\u5FD7\uFF09" : "\u8FD8\u6CA1\u6709\u65E5\u5FD7");
        break;
      }
      if (!more && !chunk.running) break;
      if (!more) await new Promise((resolve10) => setTimeout(resolve10, 1e3));
    }
    recordNext(`\u7EED\u8BFB\uFF1Aatrium task log ${id} --after ${after}`);
  }
};
var wait = {
  args: "tN [--timeout \u79D2]",
  about: "\u7B49\u4EFB\u52A1\u7ED3\u675F\uFF08PR \u4EFB\u52A1\u7B49\u5408\u5165\u6216\u5361\u4F4F\uFF09\u6216\u8D85\u65F6\uFF1B\u7F3A\u7701 300 \u79D2",
  options: { timeout: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const seconds = waitSeconds(str3(values, "timeout"));
    const api2 = await client3();
    const result = await longWait(
      seconds,
      (timeout) => api2.get(`/tasks/${id}/wait?timeout=${timeout}`),
      () => `atrium task wait ${id}`
    );
    if (json) printJson(result);
    else if (result.timed_out)
      console.log(`${seconds} \u79D2\u5185 ${id} \u8FD8\u6CA1\u7ED3\u675F\uFF1Batrium task wait ${id}`);
    else {
      const task = result.task;
      console.log(
        [
          `${task.ref} [${displayStatus(task)}] ${task.title}`,
          task.pr_url ? `  PR\uFF1A${task.pr_url}${task.ci ? `\uFF08CI ${task.ci}\uFF09` : ""}` : "",
          task.result ? `  \u6458\u8981\uFF1A${clip(task.result.replace(/\s+/g, " "), 200)}` : ""
        ].filter(Boolean).join("\n")
      );
    }
    recordNext(
      result.timed_out ? `\u7EE7\u7EED\u7B49\uFF1Aatrium task wait ${id}` : `\u770B\u8BE6\u60C5\u4E0E\u5173\u5361\uFF1Aatrium task show ${id}`
    );
    return result.timed_out ? 124 : 0;
  }
};
var taskCommands = {
  "task add": add,
  "task ls": ls,
  "task plan": plan,
  "task show": show,
  "task tree": tree,
  "task set": set,
  "task note": note,
  "task tell": tell,
  "task done": done,
  "task pick": pick,
  "task run": run,
  "task stop": stop,
  "task merge": merge,
  "task log": log,
  "task wait": wait
};

// cli/org.ts
import { readFileSync as readFileSync5, readdirSync } from "node:fs";
import { join as join2, resolve as resolve3 } from "node:path";

// server/imports/dirs.ts
import { homedir } from "node:os";
import { join } from "node:path";
function legacyDir(env = process.env, home = homedir()) {
  if (env.ATRIUM_LEGACY_DIR) return env.ATRIUM_LEGACY_DIR;
  if (env.NODE_TEST_CONTEXT) return void 0;
  if (!isDefaultData(dataDirectory(env, home), home)) return void 0;
  return join(home, "Atrium");
}

// cli/org-overview.ts
var counts = (t) => [
  t.running ? `\u5728\u505A ${t.running}` : "",
  t.reviewing ? `\u5BA1\u9605\u4E2D ${t.reviewing}` : "",
  t.merge_queued ? `\u6392\u961F\u5408\u5165 ${t.merge_queued}` : "",
  t.merging ? `\u5408\u5165\u4E2D ${t.merging}` : "",
  t.blocked ? `\u5361\u4F4F ${t.blocked}` : "",
  t.todo ? `\u5F85\u529E ${t.todo}` : ""
].filter(Boolean).map((p) => ` \xB7 ${p}`).join("");
function titleOf(node, overview) {
  const alias = overview.alias && overview.alias !== node.name;
  return `${node.ref} ${alias ? `${overview.alias}\uFF08${node.name}\uFF09` : node.name}${overview.analogy ? `\u2014\u2014${overview.analogy}` : ""}`;
}
var isBlank = (o) => !o.what && !o.uses.length && !o.flow.length && !o.now && !o.next && !o.stages.length && !o.parts.some((p) => p.alias || p.analogy);
function stageLine(stage) {
  return `${stage.id} [${STAGE_LABEL[stage.status]}] ${stage.result}`;
}
function stageDetail(stage) {
  const lines = [
    ...stage.parent ? [`\u4E0A\u7EA7\uFF1A${stage.parent}`] : [],
    ...stage.after?.length ? [`\u524D\u7F6E\uFF1A${stage.after.join("\u3001")}`] : [],
    ...stage.due ? [`\u622A\u6B62\uFF1A${stage.due}`] : [],
    ...stage.repo ? [`\u4ED3\u5E93\uFF1A${stage.repo}`] : [],
    ...(stage.criteria ?? []).map((c, i) => `\u9A8C\u6536 ${i + 1}\uFF1A${c}`),
    ...(stage.evidence ?? []).map((e) => `\u8BC1\u636E\uFF1A${e}`),
    ...stage.note ? [`\u8BF4\u660E\uFF1A${stage.note}`] : []
  ];
  return lines.map((line2) => `      ${line2.split("\n").join("\n      ")}`);
}
function pointLines(points) {
  if (!points.length) return [];
  return [
    "\u8981\u70B9\uFF08\u5FC5\u987B\u5B88\u4F4F\uFF09\uFF1A",
    ...points.flatMap((p) => [
      `  ${p.ref} ${p.text}${p.applies?.length ? `\uFF08\u9002\u7528\u4E8E ${p.applies.join("\u3001")}\uFF09` : ""}`,
      `     \u4E3A\u4EC0\u4E48\uFF1A${p.why} \xB7 ${p.by} \u5B9A${p.check ? ` \xB7 \u68C0\u67E5\uFF1A${p.check}` : ""}`
    ])
  ];
}
function formatOverview(node, overview, detail4 = false, points = []) {
  if (isBlank(overview))
    return [
      `\u4EBA\u8BDD\u4ECB\u7ECD\u8FD8\u6CA1\u5199\uFF08\u662F\u4EC0\u4E48\u3001\u80FD\u505A\u4EC0\u4E48\u3001\u600E\u4E48\u8D70\u5B8C\u3001\u7531\u54EA\u51E0\u90E8\u5206\u7EC4\u6210\u3001\u73B0\u72B6\uFF09\uFF1Aatrium org show ${node.ref} --charter --raw > \u7AE0\u7A0B.md\uFF0C\u8865\u4E0A what\u3001uses\u3001flow\u3001alias\u3001analogy\u3001now\u3001next \u540E atrium org edit ${node.ref} --charter \u7AE0\u7A0B.md --reason \u539F\u56E0`,
      ...partLines(overview, detail4),
      ...pointLines(points)
    ];
  const none = "\uFF08\u672A\u5199\uFF09";
  const stages = overview.stages;
  const tally = Object.entries(
    stages.reduce((sum, s) => {
      sum[STAGE_LABEL[s.status]] = (sum[STAGE_LABEL[s.status]] ?? 0) + 1;
      return sum;
    }, {})
  ).map(([label2, n]) => `${label2} ${n}`).join(" \xB7 ");
  return [
    `\u662F\u4EC0\u4E48\uFF1A${overview.what ? `${overview.what}${overview.what_from_goal ? "\uFF08\u53D6\u81EA\u7AE0\u7A0B\u76EE\u6807\uFF09" : ""}` : none}`,
    ...overview.uses.length ? ["\u80FD\u7528\u5B83\u505A\u4EC0\u4E48\uFF1A", ...overview.uses.map((u) => `  \xB7 ${u}`)] : [`\u80FD\u7528\u5B83\u505A\u4EC0\u4E48\uFF1A${none}`],
    ...overview.flow.length ? [
      "\u4E00\u4EF6\u4E8B\u600E\u4E48\u8D70\u5B8C\uFF1A",
      ...overview.flow.map((step, i) => `  ${i + 1}. ${step}`)
    ] : [`\u4E00\u4EF6\u4E8B\u600E\u4E48\u8D70\u5B8C\uFF1A${none}`],
    ...partLines(overview, detail4),
    ...pointLines(points),
    `\u73B0\u5728\u505A\u5230\u54EA\uFF1A${overview.now || none}`,
    `\u63A5\u4E0B\u6765\uFF1A${overview.next || none}`,
    ...stages.length ? [
      `\u9636\u6BB5\uFF08${tally}\uFF09\uFF1A`,
      ...stages.flatMap((s) => [
        `  ${stageLine(s)}`,
        ...detail4 ? stageDetail(s) : []
      ])
    ] : []
  ];
}
function partLines(overview, detail4) {
  const parts = overview.parts.filter((p) => detail4 || !p.archived);
  if (!parts.length) return ["\u7531\u54EA\u51E0\u90E8\u5206\u7EC4\u6210\uFF1A\u6CA1\u6709\u4E0B\u4E00\u5C42"];
  return [
    "\u7531\u54EA\u51E0\u90E8\u5206\u7EC4\u6210\uFF1A",
    ...parts.map(
      (p) => `  ${titleOf(p, p)}${counts(p.tasks)}${p.archived ? " \xB7 \u5DF2\u5F52\u6863" : ""}`
    )
  ];
}

// cli/leaders.ts
import { readFileSync as readFileSync4 } from "node:fs";

// server/memos/decisions.ts
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

// server/leaders/wake.ts
var ESCALATE_KINDS = {
  shipped: "\u5DF2\u4E0A\u7EBF",
  cross: "\u9700\u8981\u522B\u7684\u90E8\u5206\u914D\u5408",
  beyond: "\u8D8A\u8FC7\u6743\u9650\uFF0F\u9884\u7B97\uFF0F\u786C\u8FB9\u754C",
  stuck: "\u641E\u4E0D\u5B9A"
};

// cli/leaders.ts
var str4 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var client4 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var enc = encodeURIComponent;
var STATUS = {
  running: "\u5904\u7406\u4E2D",
  done: "\u5904\u7406\u5B8C",
  failed: "\u5931\u8D25",
  handed_off: "\u5DF2\u8F6C\u4EA4"
};
function wakeText(wake) {
  if (!wake) return "\u8FD8\u6CA1\u5524\u9192\u8FC7";
  const what = wake.summary ? `\uFF1A${wake.summary}` : "";
  return wake.status === "running" ? `${when(wake.at)}\u8D77\u5904\u7406\u4E2D${what}` : `${when(wake.at)}\u5524\u9192 \xB7 ${STATUS[wake.status]}${what}${wake.note ? `\uFF08${wake.note}\uFF09` : ""}`;
}
function detail(view) {
  return [
    `${view.ref} ${view.name} \xB7 \u6267\u884C\u8005 ${view.worker}`,
    `\u8D1F\u8D23\uFF1A${view.nodes.map((n) => `${n.ref} ${n.name}\uFF08${n.path}\uFF09`).join("\u3001") || "\uFF08\u8FD8\u6CA1\u6307\u6D3E\u8282\u70B9\uFF1Aatrium org edit \u8282\u70B9 --leader " + view.ref + "\uFF09"}`,
    `\u6700\u8FD1\u5524\u9192\uFF1A${wakeText(view.wake)}${view.wake ? ` \xB7 \u5171 ${view.wake.count} \u6B21` : ""}`,
    `\u5907\u5FD8\uFF08${Array.from(view.memo).length}/${view.memo_max} \u5B57\uFF09\uFF1A${view.memo ? `
${view.memo}` : "\uFF08\u7A7A\uFF09"}`
  ].join("\n");
}
var self = () => process.env.ATRIUM_LEADER_TOKEN?.trim() && process.env.ATRIUM_LEADER?.trim() ? process.env.ATRIUM_LEADER.trim() : void 0;
var leaderCommands = {
  "leader ls": {
    args: "",
    about: "\u5217\u51FA leader\uFF1A\u8D1F\u8D23\u7684\u8282\u70B9\u3001\u6267\u884C\u8005\u7EC4\u5408\u3001\u6700\u8FD1\u4E00\u6B21\u5524\u9192\u5728\u5904\u7406\u4EC0\u4E48\uFF1B\u8282\u70B9\u4E0A\u5F15\u7528\u4E86\u4F46\u6CA1\u767B\u8BB0\u7684\u5355\u5217",
    positionals: [0, 0],
    async run({ json }) {
      const result = await (await client4()).get("/leaders");
      if (json) printJson(result);
      else
        console.log(
          [
            ...result.leaders.map(
              (l) => `${l.ref} ${l.name} \xB7 ${l.worker} \xB7 \u8D1F\u8D23 ${l.nodes.map((n) => `${n.ref} ${n.name}`).join("\u3001") || "\uFF08\u65E0\uFF09"} \xB7 ${wakeText(l.wake)}`
            ),
            ...result.unregistered.map(
              (u) => `${u.ref}\uFF08\u672A\u767B\u8BB0\uFF09\xB7 \u8D1F\u8D23 ${u.nodes.map((n) => `${n.ref} ${n.name}`).join("\u3001")} \xB7 \u4E8B\u4EF6\u4E0D\u4F1A\u6295\u7ED9\u5B83\uFF0C\u767B\u8BB0\uFF1Aatrium leader add \u540D\u79F0 --worker claude+opus --id ${u.ref}`
            )
          ].join("\n") || "\u8FD8\u6CA1\u6709 leader"
        );
      recordNext(
        result.leaders.length ? `\u770B\u4E00\u4F4D\uFF1Aatrium leader show ${result.leaders[0].ref}` : "\u767B\u8BB0\uFF1Aatrium leader add \u540D\u79F0 --worker claude+opus"
      );
    }
  },
  "leader show": {
    args: "aN",
    about: "\u770B\u4E00\u4F4D leader\uFF1A\u8D1F\u8D23\u7684\u8282\u70B9\u3001\u6267\u884C\u8005\u7EC4\u5408\u3001\u6700\u8FD1\u4E00\u6B21\u5524\u9192\u4E0E\u5907\u5FD8",
    positionals: [1, 1],
    async run({ positionals: [who], json }) {
      const view = await (await client4()).get(`/leaders/${enc(who)}`);
      if (json) printJson(view);
      else console.log(detail(view));
      recordNext(`\u770B\u5B83\u7684\u4E8B\u4EF6\uFF1Aatrium events --as ${view.ref}`);
    }
  },
  "leader add": {
    args: "\u540D\u79F0 --worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6] [--memo \u6587\u672C] [--id aN]",
    about: "\u767B\u8BB0 leader\uFF08\u56FA\u5B9A\u8EAB\u4EFD\uFF0C\u6309\u4E8B\u5524\u9192\u65F6\u7528 --worker \u7684\u6267\u884C\u8005\u7EC4\u5408\u8D77\u4E00\u6B21\u6027\u8FDB\u7A0B\uFF09\uFF1B--id \u8BA4\u9886\u8282\u70B9\u4E0A\u5DF2\u5F15\u7528\u4F46\u6CA1\u767B\u8BB0\u7684 aN\uFF1B\u518D\u7528 org edit \u8282\u70B9 --leader aN \u6307\u6D3E",
    options: {
      worker: { type: "string" },
      memo: { type: "string" },
      id: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      if (!str4(values, "worker"))
        throw new Problem(
          400,
          "--worker \u5FC5\u586B\uFF1Aleader \u88AB\u5524\u9192\u65F6\u7528\u54EA\u4E2A\u6267\u884C\u8005\u7EC4\u5408\uFF0C\u5982 claude+opus:high",
          "usage"
        );
      const view = await (await client4()).post("/leaders", {
        name,
        worker: str4(values, "worker"),
        ...str4(values, "memo") === void 0 ? {} : { memo: str4(values, "memo") },
        ...str4(values, "id") === void 0 ? {} : { id: str4(values, "id") }
      });
      if (json) printJson(view);
      else
        console.log(`\u5DF2\u767B\u8BB0 ${view.ref} ${view.name} \xB7 \u6267\u884C\u8005 ${view.worker}`);
      recordNext(`\u6307\u6D3E\u8282\u70B9\uFF1Aatrium org edit \u8282\u70B9 --leader ${view.ref}`);
    }
  },
  "leader edit": {
    args: "aN [--name \u540D\u79F0] [--worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]] [--memo \u6587\u672C|--memo-file \u6587\u4EF6]",
    about: "\u6539 leader \u7684\u540D\u79F0\u3001\u6267\u884C\u8005\u7EC4\u5408\u6216\u5907\u5FD8\uFF08\u8986\u76D6\u5199\uFF0C\u6709\u957F\u5EA6\u4E0A\u9650\uFF0C\u8D85\u4E86\u5148\u7CBE\u7B80\uFF09\uFF1Bleader \u81EA\u5DF1\u53EA\u80FD\u6539\u81EA\u5DF1\u7684\u5907\u5FD8",
    options: {
      name: { type: "string" },
      worker: { type: "string" },
      memo: { type: "string" },
      "memo-file": { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [who], values, json }) {
      if (str4(values, "memo") !== void 0 && str4(values, "memo-file"))
        throw new Problem(400, "--memo \u4E0E --memo-file \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
      let memo = str4(values, "memo");
      const file2 = str4(values, "memo-file");
      if (file2 !== void 0) {
        try {
          memo = readFileSync4(file2, "utf8");
        } catch {
          throw new Problem(400, `--memo-file: \u8BFB\u4E0D\u5230 ${file2}`, "usage");
        }
      }
      const body = {
        ...str4(values, "name") === void 0 ? {} : { name: str4(values, "name") },
        ...str4(values, "worker") === void 0 ? {} : { worker: str4(values, "worker") },
        ...memo === void 0 ? {} : { memo }
      };
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "\u81F3\u5C11\u6539\u4E00\u9879\uFF1A--name\u3001--worker\u3001--memo \u6216 --memo-file",
          "usage"
        );
      const view = await (await client4()).patch(`/leaders/${enc(who)}`, body);
      if (json) printJson(view);
      else console.log(`\u5DF2\u66F4\u65B0 ${view.ref}
${detail(view)}`);
      recordNext(`\u770B\uFF1Aatrium leader show ${view.ref}`);
    }
  },
  "leader escalate": {
    args: "\u8BF4\u660E --kind shipped|cross|beyond|stuck [--task tN] [--as aN]",
    about: `leader \u4E0A\u4EA4\u7ED9\u4E0A\u4E00\u5C42\uFF08\u79D8\u4E66\u6216\u4E0A\u5C42 leader\uFF09\uFF0C\u751F\u6210\u4E00\u6761\u300C\u8981\u5904\u7406\u300D\u4E8B\u4EF6\uFF1B\u53EA\u6709\u56DB\u7C7B\uFF1A${Object.entries(
      ESCALATE_KINDS
    ).map(([k, v]) => `${k} ${v}`).join(
      "\u3001"
    )}\uFF1Bshipped \u8981\u5E26 --task \u5E76\u5728\u8BF4\u660E\u91CC\u9644\u7AEF\u5230\u7AEF\u9A8C\u8BC1\u3002leader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u4EE5\u81EA\u5DF1\u7684\u8EAB\u4EFD\u4E0A\u4EA4`,
    options: {
      kind: { type: "string" },
      task: { type: "string" },
      as: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [note2], values, json }) {
      const who = str4(values, "as") ?? self();
      if (!who)
        throw new Problem(
          400,
          "--as: \u4EE5\u54EA\u4F4D leader \u7684\u540D\u4E49\u4E0A\u4EA4\uFF0C\u5982 a1\uFF08leader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u662F\u81EA\u5DF1\uFF09",
          "usage"
        );
      const kind = str4(values, "kind");
      if (!kind)
        throw new Problem(
          400,
          `--kind \u5FC5\u586B\uFF1A${Object.keys(ESCALATE_KINDS).join("\u3001")}`,
          "usage"
        );
      const result = await (await client4()).post(`/leaders/${enc(who)}/escalate`, {
        kind,
        note: note2,
        ...str4(values, "task") === void 0 ? {} : { task: str4(values, "task") }
      });
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u4E0A\u4EA4\u300C${result.kind_label}\u300D\u7ED9 ${result.to === "secretary" ? "\u79D8\u4E66" : result.to}\uFF08\u4E8B\u4EF6 #${result.event}${result.task ? ` \xB7 ${result.task}` : ""}\uFF09
${result.why}`
        );
      recordNext(`\u5904\u7406\u5B8C\u8FD9\u6279\u4E8B\u4EF6\u540E\u786E\u8BA4\uFF1Aatrium events ack \u7F16\u53F7`);
    }
  }
};

// cli/org.ts
var str5 = (values, key) => typeof values[key] === "string" ? values[key] : void 0;
var client5 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var path2 = (value) => encodeURIComponent(value);
var as = (values) => str5(values, "as") ? `?as=${path2(str5(values, "as"))}` : "";
var options = { as: { type: "string" } };
var person = (value) => value === "u1" ? "\u4F60" : value ?? "\u65E0";
function formatOrgChanges(changes) {
  const boundary = (item) => [
    item.summary ?? "\uFF08\u6587\u5B57\u6CBF\u7528\u4E0A\u5C42\uFF09",
    ...Object.entries(item.param ?? {}).map(([k, v]) => `${k}=${v}`)
  ].join(" ");
  const value = (key, item) => key.startsWith("boundaries.") && item && typeof item === "object" ? boundary(item) : key === "leader" && item === "u1" ? "\u4F60" : item == null || item === "" ? "\uFF08\u7A7A\uFF09" : typeof item === "string" ? item : JSON.stringify(item);
  const lines = [];
  for (const [key, change] of Object.entries(changes)) {
    if (key === "doc_path") continue;
    if (key === "body") {
      const diff = (change.diff ?? "").split("\n");
      lines.push(
        "\u6B63\u6587\uFF1A",
        ...diff.slice(0, 80).map((line2) => line2.length > 300 ? `${line2.slice(0, 300)}\u2026` : line2)
      );
      if (diff.length > 80) lines.push(`\u2026\u7701\u7565 ${diff.length - 80} \u884C`);
    } else
      lines.push(
        `${key.replace(/^fields\./, "")}\uFF1A${value(key, change.before)}\u2192 ${value(key, change.after)}`
      );
  }
  return lines.join("\n") || "\u65E0\u5B57\u6BB5\u53D8\u5316";
}
function formatBoundaries(view) {
  if (!view.items.length) return ["\u786C\u8FB9\u754C\uFF1A\u65E0"];
  const width2 = Math.max(...view.items.map((e) => e.id.length));
  const lines = [
    `\u786C\u8FB9\u754C\uFF08\u7EE7\u627F ${view.inherited} + \u672C\u8282\u70B9 ${view.added}\uFF0Csummary \u5408\u8BA1 ${view.chars}/1200 \u5B57\uFF09`,
    ...view.items.map((e) => {
      const param = e.param ? `\uFF1A${formatParam(e.param)}${e.set_by !== e.from ? `\uFF08${e.set_by} ${e.set_by_name} \u6536\u7D27\uFF09` : ""}` : "";
      return `  ${e.id.padEnd(width2)}  ${e.summary}${param} \xB7 ${e.from} ${e.from_name}`;
    })
  ];
  for (const own of view.own)
    if (own.shadowed_by && own.param) {
      const live = view.items.find((e) => e.id === own.id);
      lines.push(
        `  \u672C\u8282\u70B9 ${own.id} \u5199\u7684${formatParam(own.param)} \u5DF2\u88AB\u4E0A\u5C42\u8986\u76D6\uFF1A${own.shadowed_by} ${own.shadowed_by_name} \u8981\u6C42${formatParam(live.param)}`
      );
    }
  return lines;
}
function formatBudget(view, detail4 = false) {
  const quota2 = view.quota.filter(
    (q) => detail4 ? q.amount !== void 0 : !q.shared || q.relevant
  );
  const parts = quota2.map(
    (q) => `${q.scope} ${q.shared ? "\u5171\u4EAB\u6C60" : "\u4EFD\u989D"} ${q.amount}${q.used === null || q.used === void 0 ? "\uFF08\u989D\u5EA6\u6570\u636E\u4E0D\u53EF\u7528\uFF09" : `\uFF08\u7EA6\u7528 ${q.used}\uFF09`}`
  );
  if (detail4 && !parts.length) parts.push("\u5171\u4EAB\u6C60\uFF08\u6682\u65E0\u989D\u5EA6\u6570\u636E\uFF09");
  const disk = view.disk.amount === void 0 ? detail4 ? "\u78C1\u76D8\u5171\u4EAB\u6C60\uFF08\u52A8\u6001\uFF09" : "" : !detail4 && view.disk.shared ? "" : `\u78C1\u76D8 ${view.disk.shared ? "\u5171\u4EAB\u6C60" : "\u4EFD\u989D"} ${view.disk.amount} GB`;
  const money = !detail4 && view.money.shared ? "" : `\u94B1 ${view.money.shared ? "\u5171\u4EAB\u6C60" : "\u4EFD\u989D"} ${view.money.amount ?? 0} \u5143`;
  return [parts.length ? `\u989D\u5EA6 ${parts.join("\u3001")}` : "", disk, money].filter(Boolean).join(" \xB7 ");
}
function formatCounts(own, sent) {
  const parts = [
    own.running ? `\u5728\u505A ${own.running}` : "",
    own.reviewing ? `\u5BA1\u9605\u4E2D ${own.reviewing}` : "",
    own.merge_queued ? `\u6392\u961F\u5408\u5165 ${own.merge_queued}` : "",
    own.merging ? `\u5408\u5165\u4E2D ${own.merging}` : "",
    own.blocked ? `\u5361\u4F4F ${own.blocked}` : "",
    own.todo ? `\u5F85\u529E ${own.todo}` : ""
  ];
  const out4 = sent.running + sent.blocked + sent.todo + (sent.reviewing ?? 0) + (sent.merge_queued ?? 0) + (sent.merging ?? 0);
  if (out4)
    parts.push(`\u6295\u51FA ${out4}${sent.running ? `\uFF08\u5728\u505A ${sent.running}\uFF09` : ""}`);
  return parts.filter(Boolean).map((p) => ` \xB7 ${p}`).join("");
}
var KIND_LABEL = {
  org: "\u7EC4\u7EC7",
  project: "\u9879\u76EE",
  module: "\u6A21\u5757",
  concern: "\u5173\u6CE8\u70B9"
};
var FIELD_LABELS = {
  goal: "\u76EE\u6807",
  report: "\u6C47\u62A5",
  escalate: "\u627E\u4E0A\u5C42",
  owns: "\u8D1F\u8D23",
  accepts: "\u80FD\u63A5",
  status: "\u73B0\u72B6",
  commitments: "\u627F\u8BFA",
  asks: "\u8981\u4E0A\u9762\u5B9A"
};
function formatDoc(label2, doc2) {
  const value = (item) => Array.isArray(item) ? item.map(
    (entry2) => entry2 && typeof entry2 === "object" ? (() => {
      const c = entry2;
      return `${c.id ? `${c.id} ` : ""}${c.text ?? ""}${c.due ? `\uFF08${c.due}\uFF09` : ""}`;
    })() : String(entry2)
  ).join("\u3001") : String(item ?? "");
  const lines = Object.entries(doc2?.fields ?? {}).map(([key, item]) => [FIELD_LABELS[key] ?? key, value(item).trim()]).filter(([, text]) => text).map(([key, text]) => `  ${key}\uFF1A${text}`);
  const body = doc2?.body.trim() ?? "";
  if (!lines.length && !body) return [`${label2} ${doc2?.rev ?? "r0"}\uFF1A\u672A\u586B\u5199`];
  return [`${label2} ${doc2?.rev ?? "r0"}`, ...lines, ...body ? [body] : []];
}
var reason = (values) => {
  const result = str5(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason \u4E0D\u80FD\u4E3A\u7A7A");
  return result;
};
var doc = (values) => values.charter !== void 0 ? "charter" : values.card !== void 0 ? "card" : void 0;
var file = (values, key) => {
  const name = str5(values, key);
  if (!name) throw new Problem(400, `--${key} \u5E94\u6307\u5B9A\u6587\u4EF6`);
  try {
    return readFileSync5(resolve3(name), "utf8");
  } catch {
    throw new Problem(400, `--${key} \u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${name}`);
  }
};
var common = {
  ...options,
  charter: { type: "string" },
  card: { type: "string" }
};
var out = (json, value, text, next) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(`\u52A8\u4F5C\uFF1A${next}`);
};
var orgCommands = {
  "org tree": {
    args: "",
    about: "\u67E5\u770B\u7EC4\u7EC7\u6811",
    options,
    positionals: [0, 0],
    async run({ values, json }) {
      const rows = await (await client5()).get(`/org/tree${as(values)}`);
      const labels = {
        org: "\u7EC4\u7EC7",
        project: "\u9879\u76EE",
        module: "\u6A21\u5757",
        concern: "\u5173\u6CE8\u70B9"
      };
      const depth = (row) => row.parent_id === null ? 0 : 1 + depth(rows.find((n) => n.id === row.parent_id));
      out(
        json,
        rows,
        rows.map(
          (n) => `${"  ".repeat(depth(n))}${n.ref} [${n.aspect ? "\u7BA1\u65B9\u9762" : labels[n.kind]}] ${n.name}${n.leader ? ` \xB7 leader ${person(n.leader)}${n.leader_state ? `\uFF08${n.leader_state.name}\uFF0C${wakeText(n.leader_state.wake)}\uFF09` : ""}` : ""}${formatCounts(n.tasks, n.sent)}${formatBudget(n.budget) ? ` \xB7 ${formatBudget(n.budget)}` : ""}${n.archived_at ? " \xB7 \u5DF2\u5F52\u6863" : ""}`
        ).join("\n") + (rows.length ? "\n\u989D\u5EA6\u7528\u91CF\u4E3A\u4F30\u7B97\uFF1B\u8D26\u53F7\u603B\u89C8\u770B atrium quota" : "") || "\u7EC4\u7EC7\u6811\u4E3A\u7A7A",
        rows.length ? "atrium org show o1" : "atrium org import"
      );
    }
  },
  "org show": {
    args: "\u8282\u70B9 [--detail] [--charter|--card --raw]",
    about: "\u770B\u8282\u70B9\uFF1A\u5148\u8BB2\u4EBA\u8BDD\uFF08\u662F\u4EC0\u4E48\u3001\u80FD\u505A\u4EC0\u4E48\u3001\u600E\u4E48\u8D70\u5B8C\u3001\u7531\u54EA\u51E0\u90E8\u5206\u7EC4\u6210\u3001\u73B0\u72B6\u4E0E\u9636\u6BB5\uFF09\uFF0C--detail \u5C55\u5F00\u7AE0\u7A0B\u6B63\u6587\u3001\u786C\u8FB9\u754C\u3001\u9884\u7B97\u3001\u80FD\u529B\u5361\u7B49\u6280\u672F\u7EC6\u8282",
    options: {
      ...options,
      detail: { type: "boolean" },
      charter: { type: "boolean" },
      card: { type: "boolean" },
      raw: { type: "boolean" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const target = doc(values);
      if (values.raw && !target)
        throw new Problem(400, "--raw \u9700\u540C\u65F6\u6307\u5B9A --charter \u6216 --card");
      const query = new URLSearchParams();
      if (str5(values, "as")) query.set("as", str5(values, "as"));
      if (values.raw && target) query.set("raw", target);
      const result = await (await client5()).get(`/org/nodes/${path2(id)}?${query}`);
      if (values.raw && target) {
        if (json) printJson(result);
        else process.stdout.write(result.raw);
        return;
      }
      const node = result;
      const detail4 = values.detail === true;
      const technical = node.charter && {
        ...node.charter,
        fields: Object.fromEntries(
          Object.entries(node.charter.fields).filter(
            ([key]) => !OVERVIEW_KEYS.has(key)
          )
        )
      };
      const lines = [
        titleOf(node, node.overview),
        `[${node.aspect ? "\u7BA1\u65B9\u9762" : KIND_LABEL[node.kind] ?? node.kind}] ${node.path} \xB7 leader ${person(node.leader)}`,
        ...formatOverview(node, node.overview, detail4, node.points),
        ...detail4 ? [
          "\u2014\u2014 \u7EC6\u8282 \u2014\u2014",
          `\u4ED3\u5E93\uFF1A${node.repos.join("\u3001") || "\u65E0"}`,
          ...node.points_chain.filter((level) => level.node !== node.ref).flatMap(
            (level) => pointLines(level.points).map(
              (line2, i) => i === 0 ? `\u4E0A\u7EA7 ${level.node} ${level.name} \u7684${line2}` : line2
            )
          ),
          ...node.chain.length ? [
            "\u76EE\u6807\u94FE",
            ...node.chain.map(
              (c) => `  ${c.name}\uFF1A${c.goal.split("\n").join("\n    ")}`
            )
          ] : ["\u76EE\u6807\u94FE\uFF1A\u65E0"],
          ...formatBoundaries(node.boundaries),
          `\u9884\u7B97\uFF1A${formatBudget(node.budget, true)}`,
          ...formatDoc("\u7AE0\u7A0B", technical),
          ...formatDoc("\u80FD\u529B\u5361", node.card),
          ...node.recent_tasks.length ? [
            `\u624B\u4E0A\u7684\u4EFB\u52A1\uFF08\u6700\u8FD1 ${node.recent_tasks.length} \u6761\uFF09`,
            ...node.recent_tasks.map(
              (t) => `  ${t.ref} [${t.delivery_stage === "reviewing" ? "\u5BA1\u9605\u4E2D" : t.delivery_stage === "merge_queued" ? "\u6392\u961F\u5408\u5165" : t.delivery_stage === "merging" ? "\u5408\u5165\u4E2D" : t.delivery_stage === "merged" ? "\u5DF2\u5408\u5165" : t.delivery_stage === "online" ? "\u5DF2\u4E0A\u7EBF" : t.status}] ${t.title}${t.worker ? ` \xB7 ${t.worker}` : ""}${t.origin_ref ? ` \xB7 ${t.origin_ref} \u6295\u6765` : ""}`
            )
          ] : []
        ] : [
          `\u7EC6\u8282\u5DF2\u6298\u53E0\uFF08\u7AE0\u7A0B\u6B63\u6587\u3001\u786C\u8FB9\u754C\u3001\u9884\u7B97\u3001\u80FD\u529B\u5361\u3001\u624B\u4E0A\u7684\u4EFB\u52A1\uFF09\uFF1Aatrium org show ${node.ref} --detail`
        ]
      ];
      out(
        json,
        result,
        lines.join("\n"),
        isBlank(node.overview) ? `atrium org show ${node.ref} --charter --raw` : detail4 ? `atrium org history ${node.ref}` : `atrium org show ${node.ref} --detail`
      );
    }
  },
  "org add": {
    args: "\u7236\u8282\u70B9 slug [--kind \u7C7B\u578B] [--name \u540D\u79F0] [--reason \u539F\u56E0] [--repo \u8DEF\u5F84] [--leader u1|aN]",
    about: "\u6DFB\u52A0\u7EC4\u7EC7\u8282\u70B9",
    options: {
      ...options,
      kind: { type: "string" },
      name: { type: "string" },
      repo: { type: "string", multiple: true },
      leader: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [parent, slug], values, json }) {
      const repos = values.repo === void 0 ? [] : (Array.isArray(values.repo) ? values.repo : [values.repo]).map(
        (v) => resolve3(String(v))
      );
      const result = await (await client5()).post(
        `/org/nodes${as(values)}`,
        {
          parent,
          slug,
          kind: str5(values, "kind"),
          name: str5(values, "name") ?? slug,
          leader: str5(values, "leader"),
          repos,
          reason: reason(values)
        }
      );
      out(
        json,
        result,
        `\u5DF2\u65B0\u5EFA o${result.id} [${result.kind}] ${result.name}\uFF0C\u7AE0\u7A0B\u4E0E\u80FD\u529B\u5361\u4E3A\u7A7A\uFF08r0\uFF09`,
        `atrium org edit o${result.id} --charter \u7AE0\u7A0B.md --reason \u539F\u56E0`
      );
    }
  },
  "org stages": {
    args: "\u8282\u70B9 --file \u6587\u4EF6 --reason \u539F\u56E0 [--as aN]",
    about: "\u6539\u8282\u70B9\u7684\u9636\u6BB5\u8BB0\u5F55\uFF08\u7AE0\u7A0B\u91CC\u7684 stages\uFF09\uFF0C\u5176\u4F59\u5B57\u6BB5\u3001\u6B63\u6587\u3001\u8FB9\u754C\u4E0E\u9884\u7B97\u4E0D\u52A8\uFF0C\u7559\u7AE0\u7A0B\u4FEE\u8BA2\uFF1B\u6587\u4EF6\u662F YAML \u6216 JSON \u7684\u9636\u6BB5\u5217\u8868\uFF08\u4E5F\u53EF\u5199\u6210 stages: \u5217\u8868\uFF09\uFF1Bleader \u53EF\u6539\u81EA\u5DF1\u8D1F\u8D23\u7684\u8282\u70B9\u53CA\u5B50\u8282\u70B9",
    options: {
      ...options,
      file: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const name = str5(values, "file");
      if (!name) throw new Problem(400, "--file \u5E94\u6307\u5B9A\u9636\u6BB5\u6587\u4EF6", "usage");
      let text;
      try {
        text = readFileSync5(resolve3(name), "utf8");
      } catch {
        throw new Problem(400, `--file \u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${name}`, "usage");
      }
      const { default: YAML } = await import("yaml");
      let parsed;
      try {
        parsed = YAML.parse(text);
      } catch (error) {
        throw new Problem(
          400,
          `--file \u4E0D\u662F\u5408\u6CD5\u7684 YAML/JSON\uFF1A${error.message.split("\n")[0]}`,
          "usage"
        );
      }
      const stages = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.stages : parsed;
      const result = await (await client5()).put(
        `/org/nodes/${path2(id)}/stages${as(values)}`,
        { stages: stages ?? [], reason: reason(values) }
      );
      out(
        json,
        result,
        `\u5DF2\u66F4\u65B0 ${id} \u9636\u6BB5 ${result.before ?? ""} \u2192 ${result.rev}`,
        `atrium map ${id}`
      );
    }
  },
  "org edit": {
    args: "\u8282\u70B9 [--charter \u6587\u4EF6|--card \u6587\u4EF6|--name \u540D\u79F0] [--slug \u8DEF\u5F84\u540D] [--leader aN|none] [--parent \u8282\u70B9] [--repo \u8DEF\u5F84] [--kind aspect|module] [--archive] [--rev rN] [--reason \u539F\u56E0]",
    about: "\u7F16\u8F91\u8282\u70B9\u3001\u7AE0\u7A0B\u6216\u80FD\u529B\u5361\uFF1B--kind aspect \u6539\u6210\u7BA1\u65B9\u9762\u7684\u90E8\u5206\uFF0C--kind module \u6539\u56DE\u666E\u901A\u90E8\u5206\uFF08\u6539\u56DE\u524D\u8981\u5148\u6E05\u6389\u8981\u70B9\u4E0E\u90E8\u5206\u7684\u9002\u7528\u8303\u56F4\uFF09",
    options: {
      ...common,
      slug: { type: "string" },
      name: { type: "string" },
      leader: { type: "string" },
      parent: { type: "string" },
      repo: { type: "string", multiple: true },
      kind: { type: "string" },
      archive: { type: "boolean" },
      rev: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const target = doc(values);
      if (values.charter !== void 0 && values.card !== void 0)
        throw new Problem(400, "--charter \u4E0E --card \u53EA\u80FD\u9009\u4E00\u4E2A");
      const input = {
        reason: reason(values),
        rev: str5(values, "rev")
      };
      let result;
      if (target) {
        if (["slug", "name", "leader", "parent", "repo", "kind"].some(
          (key) => values[key] !== void 0
        ) || values.archive === true)
          throw new Problem(400, "--charter/--card \u4E0D\u80FD\u4E0E\u8282\u70B9\u5B57\u6BB5\u540C\u65F6\u4FEE\u6539");
        input.source = file(values, target);
        result = await (await client5()).put(`/org/nodes/${path2(id)}/docs/${target}${as(values)}`, input);
      } else {
        Object.assign(input, {
          slug: str5(values, "slug"),
          name: str5(values, "name"),
          leader: str5(values, "leader"),
          parent: str5(values, "parent"),
          repos: values.repo === void 0 ? void 0 : (Array.isArray(values.repo) ? values.repo : [values.repo]).map(
            (repo) => resolve3(String(repo))
          ),
          kind: str5(values, "kind"),
          archive: values.archive === true
        });
        if (!input.slug && !input.name && !input.leader && !input.parent && !input.repos && !input.kind && !input.archive)
          throw new Problem(400, "org edit \u9700\u6307\u5B9A\u8981\u4FEE\u6539\u7684\u5B57\u6BB5");
        result = await (await client5()).patch(`/org/nodes/${path2(id)}${as(values)}`, input);
      }
      const value = result;
      out(
        json,
        result,
        [
          `\u5DF2\u66F4\u65B0 ${id} ${target ?? "\u8282\u70B9"} ${value.before ?? ""} \u2192 ${value.rev}`,
          ...(value.converted ?? []).map(
            (c) => `${c.node} \u7684 ${c.id} \u4E0D\u518D\u8986\u76D6\u4E0A\u5C42\uFF0C\u8F6C\u4E3A\u8BE5\u8282\u70B9\u81EA\u6709\u6761\u76EE`
          )
        ].join("\n"),
        `atrium org history ${id}`
      );
    }
  },
  "org point-add": {
    args: "\u8282\u70B9 \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by \u8C01\u5B9A\u7684 [--check \u68C0\u67E5] [--applies \u90E8\u5206[,\u90E8\u5206]] [--as aN]",
    about: "\u7ED9\u8282\u70B9\u52A0\u4E00\u6761\u8981\u70B9\uFF08\u8FD9\u4E00\u5757\u5FC5\u987B\u5B88\u4F4F\u7684\u8BBE\u8BA1\u7EA6\u675F\uFF09\uFF1A\u4EBA\u8BDD\u4E00\u53E5\u3001\u4E3A\u4EC0\u4E48\u3001\u8C01\u5B9A\u7684\uFF08\u5982 u1 09-27\uFF09\uFF0C\u53EF\u9009\u5B88\u62A4\u5B83\u7684\u68C0\u67E5\uFF08\u6D4B\u8BD5\u6587\u4EF6\u4E0E\u7528\u4F8B\u540D\uFF0C\u6216 $ \u547D\u4EE4\uFF09\uFF1B\u7BA1\u65B9\u9762\u7684\u90E8\u5206\u53EF\u7528 --applies \u5199\u8FD9\u6761\u9002\u7528\u4E8E\u54EA\u4E9B\u90E8\u5206\uFF08\u4E0D\u5199\u8DDF\u968F\u90E8\u5206\uFF0C\u7F3A\u7701\u6574\u4E2A\u4E0A\u7EA7\uFF09\uFF1B\u4E0D\u7559\u4FEE\u8BA2\u8BB0\u5F55",
    options: {
      ...options,
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
      applies: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [id, text], values, json }) {
      const result = await (await client5()).post(`/org/nodes/${path2(id)}/points${as(values)}`, {
        text,
        ...str5(values, "why") === void 0 ? {} : { why: str5(values, "why") },
        ...str5(values, "by") === void 0 ? {} : { by: str5(values, "by") },
        ...str5(values, "check") === void 0 ? {} : { check: str5(values, "check") },
        ...str5(values, "applies") === void 0 ? {} : { applies: str5(values, "applies") }
      });
      out(
        json,
        result,
        `\u5DF2\u52A0 ${result.ref}\uFF08${result.node}\uFF09\uFF1A${result.text}`,
        `atrium org show ${result.node}`
      );
    }
  },
  "org point-edit": {
    args: "kN [--text \u8981\u70B9] [--why \u4E3A\u4EC0\u4E48] [--by \u8C01\u5B9A\u7684] [--check \u68C0\u67E5|''] [--applies \u90E8\u5206[,\u90E8\u5206]|''] [--as aN]",
    about: "\u6539\u4E00\u6761\u8981\u70B9\uFF1B--check '' \u53BB\u6389\u68C0\u67E5\uFF0C--applies '' \u6539\u56DE\u8DDF\u968F\u90E8\u5206\u7684\u9002\u7528\u8303\u56F4",
    options: {
      ...options,
      text: { type: "string" },
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
      applies: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const body = {};
      for (const key of ["text", "why", "by", "check", "applies"])
        if (str5(values, key) !== void 0) body[key] = str5(values, key);
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "\u81F3\u5C11\u6539\u4E00\u9879\uFF1A--text\u3001--why\u3001--by\u3001--check\u3001--applies",
          "usage"
        );
      const result = await (await client5()).patch(`/org/points/${path2(id)}${as(values)}`, body);
      out(
        json,
        result,
        `\u5DF2\u6539 ${result.ref}\uFF08${result.node}\uFF09\uFF1A${result.text}`,
        `atrium org show ${result.node}`
      );
    }
  },
  "org point-rm": {
    args: "kN [--as aN]",
    about: "\u5220\u6389\u4E00\u6761\u8FC7\u65F6\u7684\u8981\u70B9\uFF08\u4E0D\u7559\u4FEE\u8BA2\u8BB0\u5F55\uFF09",
    options,
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const result = await (await client5()).delete(`/org/points/${path2(id)}${as(values)}`);
      out(
        json,
        result,
        `\u5DF2\u5220 ${result.ref}\uFF08${result.node}\uFF09\uFF1A${result.text}`,
        `atrium org show ${result.node}`
      );
    }
  },
  "org history": {
    args: "\u8282\u70B9 [--target node|charter|card] [--rev rN] [--before rN] [--after rN] [--limit N]",
    about: "\u67E5\u770B\u4FEE\u8BA2\u5386\u53F2\u4E0E\u5B57\u6BB5\u5DEE\u5F02",
    options: {
      ...options,
      target: { type: "string" },
      rev: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const query = new URLSearchParams();
      for (const key of ["as", "target", "rev", "before", "after", "limit"])
        if (str5(values, key)) query.set(key, str5(values, key));
      const result = await (await client5()).get(`/org/nodes/${path2(id)}/history?${query}`);
      if (result.revision) {
        out(
          json,
          result,
          `${id} \u4FEE\u8BA2\u8BE6\u60C5
${formatOrgChanges(result.changes ?? {})}`,
          `atrium org history ${id}`
        );
        return;
      }
      out(
        json,
        result,
        `${id} \u7684\u4FEE\u8BA2\uFF08\u65B0\u2192\u65E7\uFF09
${result.items?.map((r) => `r${r.rev} ${r.target} ${new Date(r.at).toLocaleString("zh-CN")} ${person(r.author)} \u2014\u2014 ${r.reason}`).join("\n") ?? ""}`,
        `atrium org show ${id}`
      );
    }
  },
  "org revert": {
    args: "\u8282\u70B9 [--charter|--card] [--to rN] [--reason \u539F\u56E0]",
    about: "\u6062\u590D\u65E7\u5185\u5BB9\u5E76\u8FFD\u52A0\u65B0\u4FEE\u8BA2",
    options: {
      ...options,
      charter: { type: "boolean" },
      card: { type: "boolean" },
      to: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const target = doc(values);
      if (!target) throw new Problem(400, "--charter \u6216 --card \u5FC5\u586B");
      const result = await (await client5()).post(`/org/nodes/${path2(id)}/revert${as(values)}`, {
        doc: target,
        to: str5(values, "to"),
        reason: reason(values)
      });
      out(
        json,
        result,
        `\u5DF2\u6062\u590D ${id} ${target}\uFF0C\u65B0\u589E ${result.rev}`,
        `atrium org history ${id}`
      );
    }
  },
  "org link-roles": {
    args: "[--apply]",
    about: "\u628A\u65E7 role \u5B57\u7B26\u4E32\u7684\u4EFB\u52A1\u5173\u8054\u5230\u7EC4\u7EC7\u8282\u70B9\uFF08\u9ED8\u8BA4\u53EA\u9884\u89C8\uFF09",
    options: { ...options, apply: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const apply = values.apply === true;
      const result = await (await client5()).post(`/org/link-roles${as(values)}`, { apply });
      const lines = [
        result.preview ? `\u5C06\u5173\u8054 ${result.linked} \u4E2A\u4EFB\u52A1\uFF08\u9884\u89C8\uFF0C\u672A\u5199\u5165\uFF09\uFF1A` : `\u5DF2\u5173\u8054 ${result.linked} \u4E2A\u4EFB\u52A1\uFF1A`,
        ...result.groups.map(
          (g) => `  ${g.roles.join(" / ")} \u2192 ${g.node} ${g.path}  ${g.tasks.length} \u4E2A\uFF08${g.tasks.slice(0, 10).join("\u3001")}${g.tasks.length > 10 ? "\u2026" : ""}\uFF09`
        ),
        ...result.unmatched.length ? [
          `\u65E0\u6CD5\u5BF9\u5E94 ${result.unmatched.length} \u4E2A\uFF08\u4FDD\u7559\u539F role\uFF0Cnode_id \u7559\u7A7A\uFF09\uFF1A`,
          ...result.unmatched.slice(0, 50).map(
            (u) => `  ${u.task}\u300C${u.title}\u300Drole=${u.role}\uFF1A${u.reason}`
          ),
          ...result.unmatched.length > 50 ? [
            `  \u2026\u53E6\u6709 ${result.unmatched.length - 50} \u4E2A\uFF0C\u7528 --json \u770B\u5168\u90E8`
          ] : []
        ] : [],
        ...result.truncated ? ["\u4E00\u6B21\u6700\u591A\u5904\u7406 5000 \u4E2A\uFF1Bapply \u540E\u518D\u8DD1\u4E00\u6B21\u5904\u7406\u5176\u4F59"] : []
      ];
      if (!result.linked && !result.unmatched.length)
        lines.splice(0, lines.length, "\u6CA1\u6709\u5F85\u5173\u8054\u7684\u65E7 role \u4EFB\u52A1");
      out(
        json,
        result,
        lines.join("\n"),
        result.preview && result.linked ? "atrium org link-roles --apply" : "atrium org tree"
      );
    }
  },
  "org migrate-goals": {
    args: "[--apply]",
    about: "\u628A\u76EE\u6807\u6811\uFF08gN\uFF09\u8FC1\u4E3A\u6240\u5728\u8282\u70B9\u7684\u9636\u6BB5\u8BB0\u5F55\u3001\u4EFB\u52A1\u6309\u76EE\u6807\u56DE\u586B\u5F52\u5C5E\u90E8\u5206\uFF1B\u9ED8\u8BA4\u53EA\u9884\u89C8\uFF0C--apply \u5148\u5907\u4EFD\u518D\u5199\u5165\uFF0C\u4E4B\u540E goal \u547D\u4EE4\u4E0B\u7EBF",
    options: { ...options, apply: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (await client5()).post(`/goals/migrate${as(values)}`, {
        apply: values.apply === true
      });
      const pending = result.stages > 0 || result.tasks.length > 0 || !result.retired;
      out(
        json,
        result,
        formatMigration(result),
        result.preview && pending ? "atrium org migrate-goals --apply" : `atrium org show ${result.nodes[0]?.node ?? "o1"}`
      );
    }
  },
  "org import": {
    args: "[\u7AE0\u7A0B\u6587\u4EF6] [--repo \u4ED3\u5E93] [--apply]",
    about: "\u9884\u89C8\u6216\u5BFC\u5165\u6839\u7AE0\u7A0B\u4E0E\u5C97\u4F4D\u8282\u70B9",
    options: {
      ...options,
      repo: { type: "string" },
      apply: { type: "boolean" }
    },
    positionals: [0, 1],
    async run({ positionals, values, json }) {
      const legacy = legacyDir();
      if (positionals[0] === void 0 && !legacy)
        throw new Problem(
          400,
          "\u9694\u79BB\u6570\u636E\u76EE\u5F55\u4E0D\u7F3A\u7701\u8BFB\u4E3B\u76EE\u5F55\u7684 ~/Atrium/charter.md\uFF1B\u8BF7\u7ED9\u51FA\u7AE0\u7A0B\u6587\u4EF6\u8DEF\u5F84"
        );
      const charterPath = resolve3(
        positionals[0] ?? join2(legacy, "charter.md")
      );
      let source;
      try {
        source = readFileSync5(charterPath, "utf8");
      } catch {
        throw new Problem(400, `\u7AE0\u7A0B\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${charterPath}`);
      }
      if (Buffer.byteLength(source) > 16 * 1024)
        throw new Problem(400, "body \u8D85\u8FC7 16 KB");
      const repo = resolve3(str5(values, "repo") ?? process.cwd());
      const goals = [
        ...source.matchAll(/^\d+\. \*\*(Atrium|OpenQuota)\*\*：([^\n]+)/gm)
      ];
      const section = (heading) => {
        const marker = `## ${heading}
`;
        const start = source.indexOf(marker);
        if (start < 0) return "";
        const rest = source.slice(start + marker.length);
        const end = rest.indexOf("\n## ");
        return (end < 0 ? rest : rest.slice(0, end)).trim();
      };
      const goal = (goals.find((m) => m[1] === "Atrium")?.[2] ?? section("\u76EE\u6807").slice(0, 300)) || "\u6210\u4E3A AI \u7EC4\u7EC7\u7684\u8FD0\u884C\u5E95\u5EA7";
      const openquotaGoal = goals.find((m) => m[1] === "OpenQuota")?.[2] ?? "\u5404\u5BB6\u8BA2\u9605\u989D\u5EA6\u770B\u5F97\u6E05\u3001\u67E5\u5F97\u5230\uFF0C\u4F9B\u7EC4\u7EC7\u6309\u5BCC\u4F59\u8C03\u5EA6\u3002";
      const rootGoal = goals.length ? goals.map((m) => `${m[1]}\uFF1A${m[2]}`).join("\n") : section("\u76EE\u6807").slice(0, 300);
      const reporting = section("\u6C47\u62A5").split("\n").filter((line2) => line2.startsWith("- "));
      const docs = [];
      for (const [directory, kind] of [["modules", "module"]]) {
        let files = [];
        try {
          files = readdirSync(join2(repo, ".agents", directory));
        } catch {
        }
        for (const name of files.filter((f) => f.endsWith(".md"))) {
          const slug = name.slice(0, -3);
          if (!/^(?:[a-z0-9-]|[\u3400-\u9fff]){1,40}$/.test(slug)) continue;
          const source2 = `.agents/${directory}/${name}`;
          const filename = join2(repo, source2);
          let body;
          try {
            body = readFileSync5(filename, "utf8");
          } catch {
            throw new Problem(400, `\u5C97\u4F4D\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${filename}`);
          }
          if (Buffer.byteLength(body) > 16 * 1024)
            throw new Problem(400, `${filename} \u6B63\u6587\u8D85\u8FC7 16 KB`);
          docs.push({
            kind,
            slug,
            name: slug,
            source: source2,
            body
          });
        }
      }
      const result = await (await client5()).post(
        `/org/import${as(values)}`,
        {
          charter: {
            fields: {
              goal: rootGoal || goal,
              report: reporting[0]?.slice(2) ?? "\u6BCF\u5468\u4E00\u4EFD\u76EE\u6807\u5C42\u9762\u7684\u8FDB\u5C55",
              escalate: reporting[1]?.slice(2) ?? "\u76EE\u6807\u51B2\u7A81\u3001\u7A81\u7834\u8FB9\u754C\u6216\u9884\u7B97\u3001\u4FEE\u6539\u7AE0\u7A0B\u65F6\u627E\u7528\u6237"
            },
            body: source
          },
          atrium_goal: goal,
          openquota_goal: openquotaGoal,
          repo,
          docs,
          apply: values.apply === true
        }
      );
      out(
        json,
        result,
        result.preview ? `\u5BFC\u5165\u9884\u89C8\uFF08\u672A\u5199\u5165\uFF09\uFF1A
${result.plan.join("\n")}` : result.created ? `\u5DF2\u5BFC\u5165 ${result.created} \u9879\uFF1A
${result.plan.join("\n")}` : "\u5DF2\u662F\u6700\u65B0",
        result.preview ? `atrium org import ${charterPath} --repo ${repo} --apply` : "atrium org tree"
      );
    }
  }
};
function formatMigration(view) {
  const head = view.preview ? view.retired ? "\u76EE\u6807\u6811\u5DF2\u8FC1\u79FB\u8FC7\uFF1B\u518D\u8FC1\u4F1A\u8865\u4E0A\u65B0\u51FA\u73B0\u7684\uFF08\u9884\u89C8\uFF0C\u672A\u5199\u5165\uFF09\uFF1A" : "\u76EE\u6807\u6811\u8FC1\u4E3A\u8282\u70B9\u9636\u6BB5\u8BB0\u5F55\uFF08\u9884\u89C8\uFF0C\u672A\u5199\u5165\uFF09\uFF1A" : "\u5DF2\u8FC1\u79FB\uFF1A";
  const lines = [head];
  for (const node of view.nodes) {
    if (!node.stages.length && !node.kept.length) continue;
    lines.push(
      `  ${node.node} ${node.name}\uFF08${node.path}\uFF09\u2190 ${node.stages.length} \u6761\u9636\u6BB5${node.kept.length ? `\uFF0C\u5DF2\u5728\u7AE0\u7A0B\u91CC ${node.kept.join("\u3001")}` : ""}`,
      ...node.stages.map(
        (s) => `    ${s.id} [${s.status_label}] ${s.result}${s.criteria ? ` \xB7 \u9A8C\u6536 ${s.criteria} \u6761` : ""}${s.evidence ? ` \xB7 \u8BC1\u636E ${s.evidence} \u6761` : ""}`
      )
    );
  }
  if (view.tasks.length)
    lines.push(
      `  \u4EFB\u52A1\u5F52\u5C5E\uFF08\u6309\u76EE\u6807\u7684\u8D1F\u8D23\u8282\u70B9\u56DE\u586B ${view.tasks.length} \u4E2A\uFF09\uFF1A`,
      ...view.tasks.map(
        (t) => `    ${t.task} ${t.goal} \u2192 ${t.part} ${t.part_name}`
      )
    );
  if (view.tasks_kept.length)
    lines.push(
      `  \u5DF2\u6709\u5F52\u5C5E\u90E8\u5206\u3001\u4E0D\u6539 ${view.tasks_kept.length} \u4E2A\uFF1A${view.tasks_kept.map((t) => `${t.task}\uFF08${t.part}\uFF09`).join("\u3001")}`
    );
  if (view.orphans.length)
    lines.push(
      `  \u8D1F\u8D23\u8282\u70B9\u4E0D\u5728\u7EC4\u7EC7\u6811\u91CC\u3001\u4E0D\u80FD\u8FC1\uFF1A${view.orphans.map((o) => `${o.goal}\uFF08${o.node}\uFF09`).join("\u3001")}`
    );
  if (lines.length === 1) lines.push("  \u6CA1\u6709\u8981\u8FC1\u7684\u76EE\u6807\u6216\u4EFB\u52A1");
  if (view.preview)
    lines.push(
      "\u5199\u5165\u65F6\u5148\u6574\u5E93\u5907\u4EFD\uFF1B\u9636\u6BB5\u5199\u8FDB\u5404\u8282\u70B9\u7AE0\u7A0B\u5E76\u7559\u4FEE\u8BA2\uFF08\u53EF atrium org revert\uFF09\uFF0Cgoals \u8868\u4E0E\u4EFB\u52A1\u539F\u6765\u7684 goal \u4E0D\u6539\uFF1B\u5199\u5165\u540E goal \u547D\u4EE4\u4E0B\u7EBF"
    );
  else if (view.backup) lines.push(`\u5907\u4EFD\uFF1A${view.backup}`);
  return lines.join("\n");
}

// cli/goals.ts
import { resolve as resolve4 } from "node:path";

// server/goals/check-rules.ts
var CHECK_LABEL = {
  running: "\u6267\u884C\u4E2D",
  pass: "\u6EE1\u8DB3",
  fail: "\u4E0D\u6EE1\u8DB3",
  timeout: "\u8D85\u65F6",
  error: "\u6CA1\u8DD1\u6210"
};

// cli/goals.ts
var str6 = (values, key) => typeof values[key] === "string" ? values[key] : void 0;
var strs2 = (values, key) => {
  const value = values[key];
  return (Array.isArray(value) ? value : value === void 0 ? [] : [value]).filter((v) => typeof v === "string");
};
var client6 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var path3 = (value) => encodeURIComponent(value);
var as2 = (values) => str6(values, "as") ? `?as=${path3(str6(values, "as"))}` : "";
var options2 = { as: { type: "string" } };
var person2 = (value) => value === "u1" ? "\u4F60" : value;
function ref3(value) {
  if (!value || !/^g[1-9][0-9]*$/.test(value))
    throw new Problem(
      400,
      `\u76EE\u6807\u77ED\u53F7\u5E94\u4E3A g1 \u8FD9\u6837\u7684\u683C\u5F0F\uFF08\u6536\u5230\uFF1A${value ?? "\u7A7A"}\uFF09`,
      "usage",
      void 0,
      "atrium goal tree"
    );
  return value;
}
function formatGoalTasks(tasks) {
  const total = Object.values(tasks).reduce((a, b) => a + b, 0);
  if (!total) return "";
  const open = tasks.todo + tasks.running + tasks.blocked;
  return [
    tasks.running ? `\u5728\u8DD1 ${tasks.running}` : "",
    tasks.blocked ? `\u5361\u4F4F ${tasks.blocked}` : "",
    `\u672A\u7ED3 ${open}/${total}`
  ].filter(Boolean).join(" ");
}
function goalLine(goal) {
  const waiting = goal.after.filter((a) => !a.met);
  return [
    `${goal.ref} [${goal.status_label}] ${goal.result}`,
    goal.ready ? "\xB7 \u53EF\u6807\u8FBE\u6210" : "",
    `\xB7 ${goal.node_ref}${goal.node_name ? ` ${goal.node_name}` : ""}`,
    goal.after.length ? `\xB7 \u524D\u7F6E ${goal.after.map((a) => `${a.ref}${a.met ? "\u2713" : ""}`).join(",")}${waiting.length ? `\uFF08\u7B49 ${waiting.map((a) => a.ref).join(",")}\uFF09` : ""}` : "",
    goal.due ? `\xB7 ${goal.due}` : "",
    goal.tasks && formatGoalTasks(goal.tasks) ? `\xB7 \u4EFB\u52A1 ${formatGoalTasks(goal.tasks)}` : "",
    goal.status === "dropped" || goal.status === "blocked" ? goal.note ? `\xB7 ${goal.note}` : "" : ""
  ].filter(Boolean).join(" ");
}
function renderGoalTree(goals, maxDepth = Infinity, depth = 0) {
  return goals.flatMap((goal) => [
    `${"  ".repeat(depth)}${goalLine(goal)}`,
    ...depth + 1 < maxDepth ? renderGoalTree(goal.children, maxDepth, depth + 1) : goal.children.length ? [
      `${"  ".repeat(depth + 1)}\u2026\u4E0B\u5C42 ${goal.children.length} \u4E2A\uFF1Aatrium goal tree ${goal.ref}`
    ] : []
  ]);
}
var out2 = (json, value, text, next) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(next);
};
var tree2 = {
  args: "[gN] [--depth N]",
  about: "\u770B\u76EE\u6807\u6811\uFF1A\u5404\u5C42\u72B6\u6001\u3001\u8D1F\u8D23\u90E8\u95E8\u3001\u524D\u7F6E\u548C\u6302\u7740\u7684\u4EFB\u52A1\uFF1B\u7ED9 gN \u53EA\u770B\u90A3\u4E00\u68F5",
  options: { depth: { type: "string" } },
  positionals: [0, 1],
  async run({ positionals: [root], values, json }) {
    const depthText = str6(values, "depth");
    const depth = depthText === void 0 ? Infinity : Number(depthText);
    if (depthText !== void 0 && (!Number.isInteger(depth) || depth < 1))
      throw new Problem(400, "--depth \u5E94\u4E3A\u6B63\u6574\u6570", "usage");
    const result = await (await client6()).get(
      `/goals/tree${root === void 0 ? "" : `?root=${ref3(root)}`}`
    );
    out2(
      json,
      result,
      result.goals.length ? renderGoalTree(result.goals, depth).join("\n") : "\u8FD8\u6CA1\u6709\u76EE\u6807",
      result.goals.length ? `\u770B\u8BE6\u60C5\uFF1Aatrium goal show ${root ?? result.goals[0].ref}` : "\u5EFA\u9876\u5C42\u76EE\u6807\uFF1Aatrium goal add \u7ED3\u679C --node o1"
    );
  }
};
var show2 = {
  args: "gN",
  about: "\u770B\u76EE\u6807\u6216\u91CC\u7A0B\u7891\uFF1A\u7ED3\u679C\u3001\u9A8C\u6536\u6807\u51C6\u3001\u72B6\u6001\u3001\u8D1F\u8D23\u90E8\u95E8\u3001\u524D\u7F6E\u3001\u4E0B\u5C42\u4E0E\u6302\u7740\u7684\u4EFB\u52A1",
  positionals: [1, 1],
  async run({ positionals: [id], json }) {
    const goal = await (await client6()).get(`/goals/${ref3(id)}`);
    const lines = [
      `${goal.ref} [${goal.status_label}] ${goal.result}${goal.top ? "\uFF08\u9876\u5C42\u76EE\u6807\uFF09" : ""}`,
      ...goal.path.length ? [
        `  \u4E0A\u5C42\uFF1A${goal.path.map((p) => `${p.ref} ${p.result}`).join(" \u203A ")}`
      ] : [],
      `  \u8D1F\u8D23\uFF1A${goal.node_ref}${goal.node_path ? ` ${goal.node_path}` : ""}`,
      ...goal.due ? [`  \u76EE\u6807\u65E5\u671F\uFF1A${goal.due}`] : [],
      ...goal.note ? [`  \u8BF4\u660E\uFF1A${goal.note}`] : [],
      ...goal.after.length ? [
        `  \u524D\u7F6E\uFF1A${goal.after.map((a) => `${a.ref} [${a.met ? "\u8FBE\u6210" : "\u672A\u8FBE\u6210"}] ${a.result}`).join("\uFF1B")}`
      ] : [],
      ...goal.needed_by.length ? [`  \u88AB\u4F9D\u8D56\uFF1A${goal.needed_by.join("\u3001")}`] : [],
      ...goal.repo ? [`  \u4ED3\u5E93\uFF1A${goal.repo}`] : [],
      ...goal.items.length ? ["  \u9A8C\u6536\u6807\u51C6\uFF1A", ...goal.items.flatMap(itemLines)] : [
        goal.criteria_broken ? "  \u9A8C\u6536\u6807\u51C6\uFF1A\u8BB0\u5F55\u635F\u574F\uFF0C\u8BF7\u7528 goal edit --criteria \u91CD\u5199" : "  \u9A8C\u6536\u6807\u51C6\uFF1A\u672A\u586B\u5199"
      ],
      ...goal.children.length ? [
        "  \u4E0B\u5C42\uFF1A",
        ...goal.children.map(
          (c) => `    ${c.ref} [${c.status_label}] ${c.result}`
        )
      ] : [],
      ...goal.tasks.length ? [
        `  \u4EFB\u52A1\uFF08${formatGoalTasks(goal.task_counts)}\uFF09\uFF1A`,
        ...goal.tasks.map(
          (t) => `    ${t.ref} [${t.status}] ${t.title}${t.worker ? ` \xB7 ${t.worker}` : ""}`
        )
      ] : [],
      ...goal.ready ? ["  \u9A8C\u6536\u6807\u51C6\u5168\u90E8\u6EE1\u8DB3\u3001\u524D\u7F6E\u90FD\u5DF2\u8FBE\u6210\uFF1A\u53EF\u6807\u8FBE\u6210"] : goal.ready_blockers.length && goal.items.length ? [`  \u672A\u6EE1\u8DB3\uFF1A${goal.ready_blockers.join("\uFF1B")}`] : [],
      `  \u6700\u540E\u6539\u52A8\uFF1A${person2(goal.updated_by)}`
    ];
    out2(
      json,
      goal,
      lines.join("\n"),
      goal.ready ? `\u6807\u8FBE\u6210\uFF1Aatrium goal done ${goal.ref} --note \u8BC1\u636E` : goal.items.some((i) => i.command && i.latest?.result !== "pass") ? `\u8DD1\u547D\u4EE4\u6761\u76EE\uFF1Aatrium goal check ${goal.ref}` : goal.children.length ? `\u770B\u4E0B\u5C42\uFF1Aatrium goal tree ${goal.ref}` : goal.tasks[0] ? `\u770B\u4EFB\u52A1\uFF1Aatrium task show ${goal.tasks[0].ref}` : `\u6302\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --goal ${goal.ref}`
    );
  }
};
function checkLine(check2) {
  const mark = check2.result === "pass" ? "\u2713" : check2.result === "running" ? "\u2026" : "\u2717";
  return `${mark} ${CHECK_LABEL[check2.result]}\uFF08${check2.kind === "command" ? `\u8FD0\u884C\u65F6${check2.exit_code === null ? "" : `\uFF0C\u9000\u51FA\u7801 ${check2.exit_code}`}` : `${person2(check2.actor)} \u5224`}\uFF0C${when(check2.ended_at ?? check2.started_at)}\uFF09`;
}
var indent = (text, prefix) => text.split("\n").slice(-8).map((line2) => `${prefix}${line2}`);
function itemLines(item) {
  const head = `    ${item.n}. ${item.text}`;
  if (!item.latest) return [`${head}  \xB7 ${item.command ? "\u8FD8\u6CA1\u8DD1" : "\u8FD8\u6CA1\u5224"}`];
  const evidence = item.latest.note ?? item.latest.summary;
  return [
    `${head}  \xB7 ${checkLine(item.latest)}`,
    ...evidence ? indent(evidence, "       ") : []
  ];
}
var check = {
  args: "gN [--item N] [--pass|--fail --note \u8BC1\u636E] [--timeout \u79D2] [--as aN]",
  about: "\u5224\u5B9A\u9A8C\u6536\u6807\u51C6\uFF1A\u4E0D\u7ED9 --pass/--fail \u65F6\u8FD0\u884C\u65F6\u5728\u9694\u79BB\u7684\u4E34\u65F6 worktree \u91CC\u8DD1\u547D\u4EE4\u6761\u76EE\uFF08`$ ` \u5F00\u5934\uFF1B\u7ED9 --item \u53EA\u8DD1\u90A3\u6761\uFF09\uFF0C\u9000\u51FA\u7801 0 \u4E3A\u6EE1\u8DB3\uFF1B\u5199\u4E0D\u6210\u547D\u4EE4\u7684\u6761\u76EE\u7528 --item N --pass|--fail --note \u8BC1\u636E \u4EBA\u5DE5\u5224",
  options: {
    ...options2,
    item: { type: "string" },
    pass: { type: "boolean" },
    fail: { type: "boolean" },
    note: { type: "string" },
    timeout: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const goal = ref3(id);
    const itemText = str6(values, "item");
    const item = itemText === void 0 ? void 0 : Number(itemText);
    if (item !== void 0 && (!/^[1-9][0-9]*$/.test(itemText) || !Number.isSafeInteger(item)))
      throw new Problem(400, "--item \u5E94\u4E3A\u6B63\u6574\u6570\uFF0C\u5982 --item 2", "usage");
    if (values.pass === true && values.fail === true)
      throw new Problem(400, "--pass \u4E0E --fail \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
    const verdict = values.pass === true ? "pass" : values.fail === true ? "fail" : void 0;
    if (verdict === void 0 && str6(values, "note") !== void 0)
      throw new Problem(
        400,
        "--note \u53EA\u914D\u4EBA\u5DE5\u5224\u5B9A\uFF1A\u540C\u65F6\u7ED9 --item N \u548C --pass \u6216 --fail",
        "usage"
      );
    const seconds = waitSeconds(str6(values, "timeout"));
    const api2 = await client6();
    const started = await api2.post(
      `/goals/${goal}/check${as2(values)}`,
      {
        ...item === void 0 ? {} : { item },
        ...verdict === void 0 ? {} : { verdict, note: str6(values, "note") ?? "" }
      }
    );
    let checks = started.checks;
    let timedOut = false;
    if (checks.some((c) => c.result === "running")) {
      const ids = checks.map((c) => c.id).join(",");
      const waited = await longWait(
        seconds,
        (timeout) => api2.get(`/goals/${goal}/check-wait?ids=${ids}&timeout=${timeout}`),
        () => `atrium goal check ${goal}`
      );
      checks = waited.checks;
      timedOut = waited.timed_out;
    }
    const view = await api2.get(`/goals/${goal}`);
    const number = (c) => view.items.find((i) => i.text === c.criterion)?.n;
    const lines = [
      ...checks.flatMap((c) => [
        `${goal} \u7B2C ${number(c) ?? "?"} \u6761 ${c.criterion}  \xB7 ${checkLine(c)}`,
        ...c.note ?? c.summary ? indent(c.note ?? c.summary, "    ") : []
      ]),
      ...timedOut ? [`${seconds} \u79D2\u5185\u8FD8\u6CA1\u8DD1\u5B8C\uFF1B\u518D\u8FD0\u884C\u540C\u4E00\u547D\u4EE4\u63A5\u7740\u7B49`] : [],
      view.ready ? `${goal} \u9A8C\u6536\u6807\u51C6\u5168\u90E8\u6EE1\u8DB3\u3001\u524D\u7F6E\u90FD\u5DF2\u8FBE\u6210\uFF1A\u53EF\u6807\u8FBE\u6210\uFF08\u8FD0\u884C\u65F6\u4E0D\u81EA\u52A8\u6807\uFF09` : `${goal} \u8FD8\u4E0D\u80FD\u6807\u8FBE\u6210\uFF1A${view.ready_blockers.join("\uFF1B") || "\u5DF2\u8FBE\u6210\u6216\u5DF2\u653E\u5F03"}`
    ];
    out2(
      json,
      {
        checks,
        timed_out: timedOut,
        ready: view.ready,
        ready_blockers: view.ready_blockers
      },
      lines.join("\n"),
      timedOut ? `\u63A5\u7740\u7B49\uFF1Aatrium goal check ${goal}${item === void 0 ? "" : ` --item ${item}`}` : view.ready ? `\u6807\u8FBE\u6210\uFF1Aatrium goal done ${goal} --note \u8BC1\u636E` : `\u770B\u8BE6\u60C5\uFF1Aatrium goal show ${goal}`
    );
  }
};
var repoPath = (value) => value.trim() ? resolve4(value) : "";
var add2 = {
  args: "\u7ED3\u679C [--parent gN] [--node \u8282\u70B9] [--criteria \u6761\u76EE]\u2026 [--after gN[,gM]] [--due \u65E5\u671F] [--repo \u8DEF\u5F84] [--status planned|active] [--as aN]",
  about: "\u5EFA\u9876\u5C42\u76EE\u6807\uFF08\u4E0D\u7ED9 --parent\uFF0C\u53EA\u6709\u4F60\u80FD\u5EFA\uFF09\u6216\u91CC\u7A0B\u7891\uFF1B--node \u8D1F\u8D23\u90E8\u95E8\uFF08\u7F3A\u7701\u540C\u4E0A\u5C42\uFF09\uFF0C--criteria \u53EF\u591A\u6B21\u7ED9\uFF0C\u4EE5 `$ ` \u5F00\u5934\u7684\u6761\u76EE\u662F\u547D\u4EE4\uFF0C\u7531\u8FD0\u884C\u65F6\u5728 --repo \u4ED3\u5E93\u91CC\u8DD1",
  options: {
    ...options2,
    repo: { type: "string" },
    parent: { type: "string" },
    node: { type: "string" },
    criteria: { type: "string", multiple: true },
    after: { type: "string" },
    due: { type: "string" },
    status: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [result], values, json }) {
    const parent = str6(values, "parent");
    const body = {
      result,
      ...parent === void 0 ? {} : { parent: ref3(parent) },
      ...str6(values, "node") === void 0 ? {} : { node: str6(values, "node") },
      ...values.criteria === void 0 ? {} : { criteria: strs2(values, "criteria") },
      ...str6(values, "after") === void 0 ? {} : { after: str6(values, "after") },
      ...str6(values, "due") === void 0 ? {} : { due: str6(values, "due") },
      ...str6(values, "repo") === void 0 ? {} : { repo: repoPath(str6(values, "repo")) },
      ...str6(values, "status") === void 0 ? {} : { status: str6(values, "status") }
    };
    const goal = await (await client6()).post(`/goals${as2(values)}`, body);
    out2(
      json,
      goal,
      `\u5DF2\u5EFA ${goal.ref}${goal.top ? "\uFF08\u9876\u5C42\u76EE\u6807\uFF09" : `\uFF08\u5728 ${goal.parent_ref} \u4E0B\uFF09`}\uFF1A${goal.result} \xB7 ${goal.node_ref}${goal.node_name ? ` ${goal.node_name}` : ""} \xB7 ${goal.status_label}${goal.criteria.length ? "" : "\n\u8FD8\u6CA1\u6709\u9A8C\u6536\u6807\u51C6\uFF1Aatrium goal edit " + goal.ref + " --criteria \u6761\u76EE"}`,
      `\u62C6\u91CC\u7A0B\u7891\uFF1Aatrium goal add \u7ED3\u679C --parent ${goal.ref}`
    );
  }
};
var edit = {
  args: "gN [--result \u7ED3\u679C] [--criteria \u6761\u76EE]\u2026 [--node \u8282\u70B9] [--parent gN] [--after gN[,gM]|''] [--due \u65E5\u671F|''] [--repo \u8DEF\u5F84|''] [--status planned|active|blocked] [--note \u8BF4\u660E] [--as aN]",
  about: "\u6539\u76EE\u6807\u6216\u91CC\u7A0B\u7891\uFF1B--criteria \u6574\u7EC4\u66FF\u6362\uFF08\u7ED9\u4E00\u6B21\u7A7A\u4E32\u6E05\u7A7A\uFF09\uFF0C--after \u6574\u7EC4\u66FF\u6362\uFF1B\u4E0D\u7559\u4FEE\u8BA2\u8BB0\u5F55",
  options: {
    ...options2,
    result: { type: "string" },
    criteria: { type: "string", multiple: true },
    node: { type: "string" },
    parent: { type: "string" },
    after: { type: "string" },
    due: { type: "string" },
    repo: { type: "string" },
    status: { type: "string" },
    note: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const body = {};
    for (const key of [
      "result",
      "node",
      "after",
      "due",
      "repo",
      "status",
      "note"
    ])
      if (str6(values, key) !== void 0) body[key] = str6(values, key);
    if (str6(values, "repo") !== void 0)
      body.repo = repoPath(str6(values, "repo"));
    if (str6(values, "parent") !== void 0)
      body.parent = ref3(str6(values, "parent"));
    if (values.criteria !== void 0) body.criteria = strs2(values, "criteria");
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "\u81F3\u5C11\u7ED9\u4E00\u9879\uFF1A--result\u3001--criteria\u3001--node\u3001--parent\u3001--after\u3001--due\u3001--repo\u3001--status \u6216 --note",
        "usage"
      );
    const goal = await (await client6()).patch(
      `/goals/${ref3(id)}${as2(values)}`,
      body
    );
    out2(
      json,
      goal,
      goal.changed.length ? `\u5DF2\u6539 ${goal.ref}\uFF08${goal.changed.join("\u3001")}\uFF09\uFF1A[${goal.status_label}] ${goal.result}` : `${goal.ref} \u6CA1\u6709\u53D8\u5316`,
      `\u770B\u8BE6\u60C5\uFF1Aatrium goal show ${goal.ref}`
    );
  }
};
var done2 = {
  args: "gN [--note \u8BC1\u636E] [--as aN]",
  about: "\u6807\u4E3A\u8FBE\u6210\uFF08\u524D\u7F6E\u987B\u90FD\u5DF2\u8FBE\u6210\uFF09\uFF1B--note \u8BB0\u8FBE\u6210\u8BC1\u636E",
  options: { ...options2, note: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const goal = await (await client6()).post(`/goals/${ref3(id)}/done${as2(values)}`, {
      ...str6(values, "note") === void 0 ? {} : { note: str6(values, "note") }
    });
    out2(
      json,
      goal,
      `${goal.ref} \u5DF2\u8FBE\u6210\uFF1A${goal.result}`,
      goal.parent_ref ? `\u770B\u4E0A\u5C42\uFF1Aatrium goal show ${goal.parent_ref}` : "\u770B\u5168\u8C8C\uFF1Aatrium goal tree"
    );
  }
};
var drop = {
  args: "gN --reason \u539F\u56E0 [--as aN]",
  about: "\u653E\u5F03\u76EE\u6807\u6216\u91CC\u7A0B\u7891\uFF08\u8981\u5199\u539F\u56E0\uFF1B\u4E0B\u5C42\u4E0E\u6302\u7740\u7684\u4EFB\u52A1\u987B\u5148\u6536\u5C3E\uFF09\uFF1B\u6539\u56DE\u7528 goal edit --status",
  options: { ...options2, reason: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const reason3 = str6(values, "reason");
    if (!reason3?.trim())
      throw new Problem(400, "--reason \u4E0D\u80FD\u4E3A\u7A7A\uFF1A\u653E\u5F03\u8981\u5199\u539F\u56E0", "usage");
    const goal = await (await client6()).post(`/goals/${ref3(id)}/drop${as2(values)}`, { note: reason3 });
    out2(
      json,
      goal,
      `${goal.ref} \u5DF2\u653E\u5F03\uFF1A${goal.result}\uFF08${goal.note}\uFF09`,
      `\u6539\u56DE\uFF1Aatrium goal edit ${goal.ref} --status active`
    );
  }
};
var adopt = {
  args: "tN --parent gN [--node \u8282\u70B9] [--apply] [--as aN]",
  about: "\u628A\u53EA\u8D77\u5F52\u7C7B\u4F5C\u7528\u7684\u7236\u4EFB\u52A1\u8FC1\u4E3A\u91CC\u7A0B\u7891\uFF1A\u5B50\u4EFB\u52A1\u6302\u4E0A\u5E76\u4E0A\u79FB\u4E00\u5C42\uFF0C\u7236\u4EFB\u52A1\u6807\u53D6\u6D88\uFF08\u9ED8\u8BA4\u53EA\u9884\u89C8\uFF09",
  options: {
    ...options2,
    parent: { type: "string" },
    node: { type: "string" },
    apply: { type: "boolean" }
  },
  positionals: [1, 1],
  async run({ positionals: [task], values, json }) {
    if (!task || !/^t[1-9][0-9]*$/.test(task))
      throw new Problem(
        400,
        `\u4EFB\u52A1\u77ED\u53F7\u5E94\u4E3A t1 \u8FD9\u6837\u7684\u683C\u5F0F\uFF08\u6536\u5230\uFF1A${task ?? "\u7A7A"}\uFF09`,
        "usage"
      );
    const parent = str6(values, "parent");
    if (parent === void 0)
      throw new Problem(
        400,
        "--parent \u5FC5\u586B\uFF1A\u6302\u5230\u54EA\u4E2A\u76EE\u6807\u6216\u91CC\u7A0B\u7891\u4E0B\uFF0C\u5982 g1",
        "usage",
        void 0,
        "atrium goal tree"
      );
    const plan2 = await (await client6()).post(`/goals/adopt${as2(values)}`, {
      task,
      parent: ref3(parent),
      ...str6(values, "node") === void 0 ? {} : { node: str6(values, "node") },
      apply: values.apply === true
    });
    const lines = [
      plan2.preview ? `\u5C06\u628A ${plan2.task} \u8FC1\u4E3A\u91CC\u7A0B\u7891\uFF08\u9884\u89C8\uFF0C\u672A\u5199\u5165\uFF09\uFF1A` : `\u5DF2\u628A ${plan2.task} \u8FC1\u4E3A\u91CC\u7A0B\u7891 ${plan2.goal.ref}\uFF1A`,
      `  \u7ED3\u679C\uFF1A${plan2.goal.result} \xB7 \u5728 ${plan2.goal.parent} \u4E0B \xB7 ${plan2.goal.node} \xB7 ${plan2.goal.status_label}`,
      `  \u6302\u4E0A\u7684\u5B50\u4EFB\u52A1\uFF1A${plan2.attach.join("\u3001") || "\u65E0"}`,
      ...plan2.keep.length ? [
        `  \u5DF2\u6302\u522B\u5904\u3001\u4FDD\u6301\u4E0D\u53D8\uFF1A${plan2.keep.map((k) => `${k.task}\u2192${k.goal}`).join("\u3001")}`
      ] : [],
      `  \u5B50\u4EFB\u52A1\u4E0A\u79FB\u4E00\u5C42\uFF1B${plan2.task} ${plan2.parent_task === "cancel" ? "\u6807\u4E3A\u53D6\u6D88" : "\u4FDD\u6301\u539F\u72B6\u6001"}\uFF0C\u4E5F\u6302\u4E0A\u65B0\u91CC\u7A0B\u7891\u7559\u75D5`
    ];
    out2(
      json,
      plan2,
      lines.join("\n"),
      plan2.preview ? `\u5199\u5165\uFF1Aatrium goal adopt ${plan2.task} --parent ${plan2.goal.parent}${str6(values, "node") ? ` --node ${str6(values, "node")}` : ""}${str6(values, "as") ? ` --as ${str6(values, "as")}` : ""} --apply` : `\u8865\u9A8C\u6536\u6807\u51C6\uFF1Aatrium goal edit ${plan2.goal.ref} --criteria \u6761\u76EE`
    );
  }
};
var goalCommands = Object.fromEntries(
  Object.entries({
    "goal tree": tree2,
    "goal show": show2,
    "goal add": add2,
    "goal edit": edit,
    "goal check": check,
    "goal done": done2,
    "goal drop": drop,
    "goal adopt": adopt
  }).map(([name, command]) => [
    name,
    {
      ...command,
      about: `${command.about}\uFF08atrium org migrate-goals --apply \u540E\u4E0B\u7EBF\uFF0C\u6539\u770B atrium org show \u8282\u70B9\uFF09`
    }
  ])
);

// cli/skills.ts
import {
  existsSync as existsSync2,
  lstatSync,
  mkdirSync,
  readFileSync as readFileSync6,
  readdirSync as readdirSync2,
  writeFileSync
} from "node:fs";
import { dirname, join as join3, resolve as resolve5 } from "node:path";
var str7 = (values, key) => typeof values[key] === "string" ? values[key] : void 0;
var client7 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var path4 = (value) => encodeURIComponent(value);
var as3 = (values) => str7(values, "as") ? `?as=${path4(str7(values, "as"))}` : "";
var options3 = { as: { type: "string" } };
var person3 = (value) => value === "u1" ? "\u4F60" : value ?? "\u65E0";
var out3 = (json, value, text, next) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(`\u52A8\u4F5C\uFF1A${next}`);
};
var reason2 = (values) => {
  const result = str7(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason \u4E0D\u80FD\u4E3A\u7A7A");
  return result;
};
function readSkillSource(source) {
  const root = resolve5(source);
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    throw new Problem(400, `\u6280\u80FD\u6765\u6E90\u8BFB\u4E0D\u5230\uFF1A${root}`);
  }
  if (stat.isFile()) return { "SKILL.md": readFileSync6(root, "utf8") };
  if (!stat.isDirectory())
    throw new Problem(400, `\u6280\u80FD\u6765\u6E90\u5E94\u4E3A SKILL.md \u6587\u4EF6\u6216\u76EE\u5F55\uFF1A${root}`);
  const files = {};
  let bytes = 0;
  const walk = (dir, prefix) => {
    for (const entry2 of readdirSync2(dir, { withFileTypes: true })) {
      if (entry2.name.startsWith(".") || entry2.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry2.name}` : entry2.name;
      const full = join3(dir, entry2.name);
      if (entry2.isDirectory()) walk(full, rel);
      else if (entry2.isFile()) {
        if (Object.keys(files).length >= 64)
          throw new Problem(400, `${root} \u6587\u4EF6\u592A\u591A\uFF1A\u6280\u80FD\u6700\u591A 32 \u4E2A\u6587\u4EF6`);
        bytes += lstatSync(full).size;
        if (bytes > 1024 * 1024)
          throw new Problem(400, `${root} \u592A\u5927\uFF1A\u6280\u80FD\u5408\u8BA1\u6700\u591A 256 KB`);
        files[rel] = readFileSync6(full, "utf8");
      }
    }
  };
  walk(root, "");
  if (!files["SKILL.md"]) throw new Problem(400, `${root} \u4E0B\u6CA1\u6709 SKILL.md`);
  return files;
}
function exportTo(target, files) {
  const root = resolve5(target);
  if (existsSync2(root) && readdirSync2(root).length)
    throw new Problem(400, `--out \u76EE\u5F55\u4E0D\u662F\u7A7A\u7684\uFF1A${root}`);
  for (const [rel, content] of Object.entries(files)) {
    const file2 = join3(root, ...rel.split("/"));
    mkdirSync(dirname(file2), { recursive: true });
    writeFileSync(file2, content);
  }
  return root;
}
var printDiff = (lines) => {
  const shown = lines.slice(0, 200).map((line2) => line2.length > 300 ? `${line2.slice(0, 300)}\u2026` : line2);
  if (lines.length > 200) shown.push(`\u2026\u7701\u7565 ${lines.length - 200} \u884C`);
  return shown.join("\n") || "\uFF08\u65E0\u6587\u4EF6\u53D8\u5316\uFF09";
};
var skillCommands = {
  "skill ls": {
    args: "[--all]",
    about: "\u5217\u51FA\u7EC4\u7EC7\u6280\u80FD\uFF08--all \u542B\u5DF2\u5F52\u6863\uFF09",
    options: { ...options3, all: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const rows = await (await client7()).get(`/skills${values.all ? "?archived=1" : ""}`);
      out3(
        json,
        rows,
        rows.length ? rows.map(
          (s) => `${s.slug} ${s.rev}${s.archived ? " \xB7 \u5DF2\u5F52\u6863" : ""} \xB7 owner ${s.owner ?? "\u4F60"} \xB7 \u7ED1\u5B9A ${s.bound.join("\u3001") || "\u65E0"}${s.pending ? ` \xB7 \u5F85\u5BA1\u63D0\u8BAE ${s.pending}` : ""}
  ${s.description}`
        ).join("\n") : "\u8FD8\u6CA1\u6709\u6280\u80FD",
        rows.length ? `atrium skill show ${rows[0].slug}` : "atrium skill add <slug> <\u76EE\u5F55\u6216SKILL.md> --reason \u539F\u56E0"
      );
    }
  },
  "skill show": {
    args: "slug [--out \u76EE\u5F55]",
    about: "\u67E5\u770B\u6280\u80FD\u5185\u5BB9\u4E0E\u7ED1\u5B9A\uFF1B--out \u5BFC\u51FA\u6587\u4EF6\u4EE5\u4FBF\u4FEE\u6539",
    options: { ...options3, out: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      const skill = await (await client7()).get(`/skills/${path4(slug)}`);
      if (str7(values, "out")) {
        const root = exportTo(str7(values, "out"), skill.files);
        out3(
          json,
          { ...skill, exported: root },
          `\u5DF2\u5BFC\u51FA ${skill.slug} ${skill.rev} \u5230 ${root}`,
          `atrium skill edit ${skill.slug} ${root} --rev ${skill.rev} --reason \u539F\u56E0`
        );
        return;
      }
      const lines = [
        `${skill.slug} ${skill.rev} \xB7 ${skill.name}${skill.archived ? " \xB7 \u5DF2\u5F52\u6863" : ""}`,
        `\u7B80\u4ECB\uFF1A${skill.description}`,
        `owner\uFF1A${skill.owner ?? "\u4F60"} \xB7 \u7ED1\u5B9A\uFF1A${skill.bound.join("\u3001") || "\u65E0"}`,
        `\u6587\u4EF6\uFF1A${Object.entries(skill.sizes).map(([f, n]) => `${f}\uFF08${n} \u5B57\u8282\uFF09`).join("\u3001")}`,
        ...skill.pending.length ? [
          `\u5F85\u5BA1\u63D0\u8BAE\uFF1A${skill.pending.map((p) => `${p.ref}\uFF08${p.task}\uFF0C\u57FA\u4E8E ${p.base}\uFF09`).join("\u3001")}`
        ] : [],
        "",
        skill.files["SKILL.md"] ?? ""
      ];
      out3(
        json,
        skill,
        lines.join("\n").trimEnd(),
        skill.pending.length ? `atrium skill proposal ${skill.pending[0].ref}` : `atrium skill history ${skill.slug}`
      );
    }
  },
  "skill add": {
    args: "slug \u76EE\u5F55\u6216SKILL.md [--description \u7B80\u4ECB] [--name \u540D\u79F0] [--owner \u8282\u70B9] [--source \u51FA\u5904] [--reason \u539F\u56E0]",
    about: "\u65B0\u5EFA\u7EC4\u7EC7\u6280\u80FD\uFF08owner \u9ED8\u8BA4\u7EC4\u7EC7\u6839\u8282\u70B9\uFF09",
    options: {
      ...options3,
      description: { type: "string" },
      name: { type: "string" },
      owner: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [slug, source], values, json }) {
      const result = await (await client7()).post(`/skills${as3(values)}`, {
        slug,
        files: readSkillSource(source),
        description: str7(values, "description"),
        name: str7(values, "name"),
        owner: str7(values, "owner"),
        source: str7(values, "source"),
        reason: reason2(values)
      });
      out3(
        json,
        result,
        `\u5DF2\u65B0\u5EFA\u6280\u80FD ${result.slug} ${result.rev}\uFF08${result.files} \u4E2A\u6587\u4EF6\uFF0Cowner ${result.owner ?? "\u4F60"}\uFF09\uFF0C\u8FD8\u6CA1\u7ED1\u5230\u4EFB\u4F55\u8282\u70B9`,
        `atrium skill bind ${result.slug} <\u8282\u70B9>`
      );
    }
  },
  "skill edit": {
    args: "slug [\u76EE\u5F55\u6216SKILL.md] [--name \u540D\u79F0] [--owner \u8282\u70B9] [--archive|--restore] [--rev rN] [--proposal pN] [--source \u51FA\u5904] [--reason \u539F\u56E0]",
    about: "\u4FEE\u6539\u6280\u80FD\u5E76\u8FFD\u52A0\u4FEE\u8BA2\uFF1B\u7528\u6237\u7EA0\u6B63\u5199 --reason \u7528\u6237\u7EA0\u6B63\u2026 --source \u51FA\u5904",
    options: {
      ...options3,
      name: { type: "string" },
      owner: { type: "string" },
      archive: { type: "boolean" },
      restore: { type: "boolean" },
      rev: { type: "string" },
      proposal: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 2],
    async run({ positionals: [slug, source], values, json }) {
      if (values.archive && values.restore)
        throw new Problem(400, "--archive \u4E0E --restore \u53EA\u80FD\u9009\u4E00\u4E2A");
      const input = {
        reason: reason2(values),
        rev: str7(values, "rev"),
        name: str7(values, "name"),
        owner: str7(values, "owner"),
        source: str7(values, "source"),
        proposal: str7(values, "proposal"),
        ...values.archive ? { archive: true } : {},
        ...values.restore ? { archive: false } : {}
      };
      if (source) input.files = readSkillSource(source);
      if (!source && input.name === void 0 && input.owner === void 0 && input.archive === void 0)
        throw new Problem(
          400,
          "skill edit \u9700\u7ED9\u51FA\u65B0\u5185\u5BB9\uFF08\u76EE\u5F55\u6216 SKILL.md\uFF09\uFF0C\u6216 --name\u3001--owner\u3001--archive\u3001--restore \u4E4B\u4E00"
        );
      const result = await (await client7()).put(
        `/skills/${path4(slug)}${as3(values)}`,
        input
      );
      out3(
        json,
        result,
        `\u5DF2\u66F4\u65B0\u6280\u80FD ${result.slug} ${result.before} \u2192 ${result.rev}${result.proposal ? `\uFF0C${result.proposal} \u6807\u4E3A\u5DF2\u91C7\u7EB3` : ""}\uFF1B\u4E0B\u6B21\u6D3E\u6D3B\u751F\u6548`,
        `atrium skill history ${result.slug}`
      );
    }
  },
  "skill history": {
    args: "slug [--rev rN] [--before rN] [--limit N]",
    about: "\u67E5\u770B\u6280\u80FD\u4FEE\u8BA2\u4E0E\u6765\u6E90\uFF1B--rev \u770B\u8BE5\u4FEE\u8BA2\u7684\u5DEE\u5F02",
    options: {
      ...options3,
      rev: { type: "string" },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      const query = new URLSearchParams();
      for (const key of ["rev", "before", "limit"])
        if (str7(values, key)) query.set(key, str7(values, key));
      const result = await (await client7()).get(`/skills/${path4(slug)}/history?${query}`);
      const line2 = (r) => `${r.rev} ${new Date(r.at).toLocaleString("zh-CN")} ${person3(r.author)}${r.reviewer ? `\uFF08${person3(r.reviewer)} \u5BA1\u6838\uFF09` : ""} \u2014\u2014 ${r.reason}${r.source ? ` \xB7 \u51FA\u5904 ${r.source}` : ""}`;
      if (result.revision) {
        out3(
          json,
          result,
          [
            `${result.slug} ${line2(result.revision)}`,
            ...(result.meta ?? []).map(
              (m) => `${m.field}\uFF1A${String(m.before ?? "\uFF08\u7A7A\uFF09")} \u2192 ${String(m.after ?? "\uFF08\u7A7A\uFF09")}`
            ),
            printDiff(result.diff ?? [])
          ].join("\n"),
          `atrium skill history ${result.slug}`
        );
        return;
      }
      const items = result.items ?? [];
      out3(
        json,
        result,
        [
          `${result.slug} \u7684\u4FEE\u8BA2\uFF08\u65B0\u2192\u65E7\uFF09`,
          ...items.map(line2),
          ...result.has_more ? ["\u8FD8\u6709\u66F4\u65E9\u7684\u4FEE\u8BA2"] : []
        ].join("\n"),
        result.has_more ? `atrium skill history ${result.slug} --before ${items.at(-1).rev}` : `atrium skill history ${result.slug} --rev ${items[0]?.rev ?? "r1"}`
      );
    }
  },
  "skill revert": {
    args: "slug --to rN [--reason \u539F\u56E0]",
    about: "\u6062\u590D\u65E7\u4FEE\u8BA2\u7684\u5185\u5BB9\u5E76\u8FFD\u52A0\u65B0\u4FEE\u8BA2",
    options: { ...options3, to: { type: "string" }, reason: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      if (!str7(values, "to")) throw new Problem(400, "--to \u5FC5\u586B\uFF0C\u5982 --to r2");
      const result = await (await client7()).post(
        `/skills/${path4(slug)}/revert${as3(values)}`,
        { to: str7(values, "to"), reason: reason2(values) }
      );
      out3(
        json,
        result,
        `\u5DF2\u628A ${result.slug} \u6062\u590D\u5230 ${result.to} \u7684\u5185\u5BB9\uFF0C${result.before} \u2192 ${result.rev}`,
        `atrium skill history ${result.slug}`
      );
    }
  },
  "skill bind": {
    args: "slug \u8282\u70B9",
    about: "\u628A\u6280\u80FD\u6302\u5230\u8282\u70B9\uFF1A\u6D3E\u5230\u8BE5\u8282\u70B9\u53CA\u5B50\u8282\u70B9\u7684\u4EFB\u52A1\u90FD\u5E26\u4E0A",
    options: options3,
    positionals: [2, 2],
    async run({ positionals: [slug, node], values, json }) {
      const result = await (await client7()).post(
        `/skills/${path4(slug)}/bind${as3(values)}`,
        { node }
      );
      out3(
        json,
        result,
        `\u5DF2\u628A ${result.slug} \u6302\u5230 ${result.node}\uFF1B\u4E4B\u540E\u6D3E\u5230\u8FD9\u91CC\uFF08\u542B\u5B50\u8282\u70B9\uFF09\u7684\u4EFB\u52A1\u90FD\u4F1A\u5E26\u4E0A`,
        `atrium skill show ${result.slug}`
      );
    }
  },
  "skill unbind": {
    args: "slug \u8282\u70B9",
    about: "\u4ECE\u8282\u70B9\u4E0A\u53D6\u4E0B\u6280\u80FD",
    options: options3,
    positionals: [2, 2],
    async run({ positionals: [slug, node], values, json }) {
      const result = await (await client7()).post(
        `/skills/${path4(slug)}/unbind${as3(values)}`,
        { node }
      );
      out3(
        json,
        result,
        `\u5DF2\u4ECE ${result.node} \u53D6\u4E0B ${result.slug}`,
        `atrium skill show ${result.slug}`
      );
    }
  },
  "skill proposals": {
    args: "[--status pending|accepted|rejected|all] [--limit N]",
    about: "\u5217\u51FA\u6267\u884C\u8005\u6539\u6280\u80FD\u751F\u6210\u7684\u4FEE\u8BA2\u63D0\u8BAE\uFF08\u9ED8\u8BA4\u5F85\u5BA1\uFF09",
    options: {
      ...options3,
      status: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      for (const key of ["status", "limit"])
        if (str7(values, key)) query.set(key, str7(values, key));
      const rows = await (await client7()).get(`/skill-proposals?${query}`);
      const labels = {
        pending: "\u5F85\u5BA1",
        accepted: "\u5DF2\u91C7\u7EB3",
        rejected: "\u5DF2\u9A73\u56DE"
      };
      out3(
        json,
        rows,
        rows.length ? rows.map(
          (p) => `${p.ref} [${labels[p.status]}] ${p.skill} \xB7 ${p.task} \xB7 \u57FA\u4E8E ${p.base}\uFF08\u5F53\u524D ${p.current}\uFF09${p.result ? ` \u2192 ${p.result}` : ""}
  ${p.reason.split("\n")[0]}`
        ).join("\n") : "\u6CA1\u6709\u63D0\u8BAE",
        rows.length ? `atrium skill proposal ${rows[0].ref}` : "atrium skill ls"
      );
    }
  },
  "skill proposal": {
    args: "pN [--out \u76EE\u5F55]",
    about: "\u67E5\u770B\u4E00\u4E2A\u4FEE\u8BA2\u63D0\u8BAE\u7684\u5DEE\u5F02\uFF1B--out \u5BFC\u51FA\u63D0\u8BAE\u5185\u5BB9\u4EE5\u4FBF\u624B\u5DE5\u5408\u5E76",
    options: { ...options3, out: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const p = await (await client7()).get(`/skill-proposals/${path4(id)}`);
      if (str7(values, "out")) {
        const root = exportTo(str7(values, "out"), p.files);
        out3(
          json,
          { ...p, exported: root },
          `\u5DF2\u5BFC\u51FA ${p.ref} \u7684\u5185\u5BB9\u5230 ${root}`,
          `atrium skill edit ${p.skill} ${root} --rev ${p.current} --proposal ${p.ref} --reason \u624B\u5DE5\u5408\u5E76 ${p.ref}`
        );
        return;
      }
      const lines = [
        `${p.ref} ${p.skill} \xB7 ${p.task} \u63D0\u51FA \xB7 \u57FA\u4E8E ${p.base}\uFF0C\u5F53\u524D ${p.current} \xB7 ${p.status === "pending" ? "\u5F85\u5BA1" : p.status === "accepted" ? `\u5DF2\u91C7\u7EB3\uFF08${person3(p.decided_by)}\uFF0C${p.result}\uFF09` : `\u5DF2\u9A73\u56DE\uFF08${person3(p.decided_by)}\uFF1A${p.decision_reason}\uFF09`}`,
        `\u539F\u56E0\uFF1A${p.reason}`,
        printDiff(p.diff)
      ];
      out3(
        json,
        p,
        lines.join("\n"),
        p.status === "pending" ? `atrium skill accept ${p.ref}` : `atrium skill history ${p.skill}`
      );
    }
  },
  "skill accept": {
    args: "pN [--reason \u539F\u56E0]",
    about: "\u91C7\u7EB3\u4FEE\u8BA2\u63D0\u8BAE\uFF1A\u5199\u6210\u65B0\u4FEE\u8BA2\uFF08\u57FA\u4E8E\u65E7\u7248\u672C\u65F6\u4E09\u65B9\u5408\u5E76\uFF09",
    options: { ...options3, reason: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const result = await (await client7()).post(`/skill-proposals/${path4(id)}/accept${as3(values)}`, {
        reason: str7(values, "reason")
      });
      out3(
        json,
        result,
        `\u5DF2\u91C7\u7EB3 ${result.ref}\uFF1A${result.slug} ${result.before} \u2192 ${result.rev}${result.merged ? "\uFF08\u4E0E\u671F\u95F4\u7684\u4FEE\u8BA2\u81EA\u52A8\u5408\u5E76\uFF09" : ""}\uFF1B\u4E0B\u6B21\u6D3E\u6D3B\u751F\u6548`,
        `atrium skill history ${result.slug} --rev ${result.rev}`
      );
    }
  },
  "skill reject": {
    args: "pN [--reason \u539F\u56E0]",
    about: "\u9A73\u56DE\u4FEE\u8BA2\u63D0\u8BAE",
    options: { ...options3, reason: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const result = await (await client7()).post(
        `/skill-proposals/${path4(id)}/reject${as3(values)}`,
        { reason: reason2(values) }
      );
      out3(
        json,
        result,
        `\u5DF2\u9A73\u56DE ${result.ref}\uFF08${result.slug} \u4E0D\u53D8\uFF09`,
        "atrium skill proposals"
      );
    }
  }
};

// cli/top.ts
import { setTimeout as delay2 } from "node:timers/promises";

// cli/top-plan.ts
var PLAN_LINES = 20;
var SYMBOL = {
  running: "\u25CF",
  ready: "\u25CB",
  waiting: "\u25C7",
  blocked: "\u2715"
};
var STATUS2 = {
  todo: "\u5F85\u529E",
  running: "\u5728\u8DD1",
  blocked: "\u5361\u4F4F",
  failed: "\u5931\u8D25",
  cancelled: "\u5DF2\u53D6\u6D88",
  done: "\u5B8C\u6210"
};
var readable = (text) => text.replace(
  / \[([a-z]+)\]/g,
  (_, status2) => ` ${STATUS2[status2] ?? status2}`
);
var labelOf = (task) => task.urgent === 1 ? `\u7D27\u6025 ${task.title}` : task.priority === "idle" ? `\u95F2\u65F6 ${task.title}` : task.title;
var tier = (task) => task.urgent === 1 ? 0 : task.priority === "idle" ? 2 : 1;
var idOf = (ref5) => Number(ref5.slice(1)) || 0;
var byRef = (a, b) => idOf(a.ref) - idOf(b.ref);
function elapsed(ms) {
  const minutes = Math.max(0, Math.floor(ms / 6e4));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
function upstreamText(dep, now, wide) {
  if (dep.status === "running") {
    const took = dep.started_at ? elapsed(now - dep.started_at) : "";
    if (!wide) return `${dep.ref} \u5728\u8DD1${took ? ` ${took}` : ""}`;
    const extra = [dep.worker, took].filter(Boolean).join(" \xB7 ");
    return `${dep.ref} \u5728\u8DD1${extra ? `\uFF08${extra}\uFF09` : ""}`;
  }
  if (dep.status !== "done")
    return `${dep.ref} ${STATUS2[dep.status] ?? dep.status}`;
  if (dep.release === "online") return null;
  if (dep.release === "failed") return `${dep.ref} \u4E0A\u7EBF\u5931\u8D25`;
  if (dep.release === "waiting") return `${dep.ref} \u4E0A\u7EBF`;
  if (!dep.pr || dep.pr.state === "merged" && dep.release !== "merging")
    return null;
  if (dep.pr.state === "closed")
    return `${dep.ref} \u7684 PR #${dep.pr.number} \u5DF2\u5173\u95ED\u672A\u5408\u5165`;
  const note2 = dep.pr.error ? "\uFF08\u67E5\u8BE2\u5931\u8D25\uFF09" : dep.pr.state === null ? "\uFF08\u5C1A\u672A\u67E5\u8BE2\uFF09" : "";
  return `${dep.ref} \u7684 PR #${dep.pr.number} \u5408\u5165${note2}`;
}
function waitText(entry2, now, wide) {
  if (!entry2.upstream && !entry2.after_pr)
    return entry2.waiting_for.length ? `\u7B49 ${readable(entry2.waiting_for.join("\u3001"))}` : "";
  const open = [];
  const met = [];
  for (const dep of entry2.upstream ?? []) {
    const text = upstreamText(dep, now, wide);
    if (text) open.push(text);
    else met.push(dep.ref);
  }
  for (const pr of entry2.after_pr ?? []) {
    const ref5 = `${wide ? pr.repo : pr.repo.split("/").pop()}#${pr.number}`;
    if (pr.merged) met.push(ref5);
    else open.push(`${ref5} \u5408\u5165${pr.error ? "\uFF08\u67E5\u8BE2\u5931\u8D25\uFF09" : ""}`);
  }
  const head = open.length ? `\u7B49 ${open.join("\u3001")}` : "";
  if (!wide || !met.length) return head;
  return `${head}${head ? "\uFF1B" : ""}\u5DF2\u6EE1\u8DB3 ${met.join("\u3001")}`;
}
function detail2(item, now, wide) {
  const task = item.task;
  const part = task.part_ref ?? task.goal_ref;
  const goal = part ? `${part} \xB7 ` : "";
  if (item.group === "running") {
    const took = task.started_at ? elapsed(now - task.started_at) : "";
    return goal + (wide ? ["\u5728\u8DD1", task.worker, took].filter(Boolean).join(" \xB7 ") : `\u5728\u8DD1${took ? ` ${took}` : ""}`);
  }
  if (item.group === "blocked" && !scheduleBlocked(item))
    return goal + (item.task.status === "failed" ? `\u5931\u8D25${item.reason && item.reason !== "\u4EFB\u52A1\u5931\u8D25" ? `\uFF1A${item.reason}` : ""}` : `\u5361\u4F4F\uFF1A${item.reason ?? "\u4EFB\u52A1\u53D7\u963B"}`);
  if (item.group === "blocked")
    return `${goal}\u5361\u4F4F\uFF1A${readable(item.reason ?? "\u4EFB\u52A1\u53D7\u963B")}`;
  if (item.group === "waiting") return goal + waitText(item, now, wide);
  const auto = task.auto ? "\u81EA\u52A8\u6D3E" : "\u624B\u52A8\u6D3E";
  const owner2 = task.owner ?? "secretary";
  return goal + (wide ? [item.node_path ?? task.node_ref, auto, owner2].filter(Boolean).join(" \xB7 ") : `${task.auto ? "\u81EA\u52A8" : "\u624B\u52A8"} \xB7 ${owner2}`);
}
var upstreamRefs = (entry2) => entry2.upstream ? entry2.upstream.map((dep) => dep.ref) : entry2.waiting_for.map((text) => /^(t[1-9][0-9]*)\b/.exec(text)?.[1]).filter((ref5) => !!ref5);
var scheduleBlocked = (item) => item.task.schedule_state === "blocked" || (item.reason ?? "").startsWith("\u4E0A\u6E38 ");
function renderPlan(plan2, frame) {
  const all2 = ["running", "ready", "waiting", "blocked"].flatMap(
    (group) => (plan2.groups[group] ?? []).map((entry2) => ({
      ...entry2,
      group,
      ref: entry2.task.ref
    }))
  );
  const childParents = new Set(
    all2.map((item) => item.task.parent_ref).filter(Boolean)
  );
  const parents = new Map(
    all2.filter(
      (item) => item.group !== "running" && (item.open_children !== void 0 ? item.open_children > 0 : childParents.has(item.ref))
    ).map((item) => [item.ref, item])
  );
  const items = new Map(
    all2.filter((item) => !parents.has(item.ref)).map((item) => [item.ref, item])
  );
  const ups = /* @__PURE__ */ new Map();
  const downs = /* @__PURE__ */ new Map();
  for (const item of items.values()) {
    const list3 = upstreamRefs(item).filter((ref5) => items.has(ref5));
    ups.set(item.ref, list3);
    for (const ref5 of list3)
      downs.set(ref5, [...downs.get(ref5) ?? [], item.ref]);
  }
  const chainOf = /* @__PURE__ */ new Map();
  for (const item of [...items.values()].sort(byRef)) {
    if (chainOf.has(item.ref)) continue;
    const members = [];
    const stack = [item.ref];
    while (stack.length) {
      const ref5 = stack.pop();
      if (members.includes(ref5)) continue;
      members.push(ref5);
      stack.push(...ups.get(ref5) ?? [], ...downs.get(ref5) ?? []);
    }
    for (const ref5 of members) chainOf.set(ref5, members);
  }
  const chains = [...new Set(chainOf.values())].filter((members) => members.length > 1).map((members) => members.sort((a, b) => idOf(a) - idOf(b)));
  const inChain = new Set(chains.flat());
  const alone = [...items.values()].filter((item) => !inChain.has(item.ref)).sort(byRef);
  const ready = alone.filter((item) => item.group === "ready").sort((a, b) => tier(a.task) - tier(b.task) || byRef(a, b));
  const waiting = alone.filter((item) => item.group === "waiting");
  const blocked = alone.filter(
    (item) => item.group === "blocked" && scheduleBlocked(item)
  );
  const chained = chains.flat().map((ref5) => items.get(ref5));
  const counts3 = {
    ready: ready.length + chained.filter((i) => i.group === "ready").length,
    waiting: waiting.length + chained.filter((i) => i.group === "waiting").length,
    blocked: blocked.length + chained.filter((i) => i.group === "blocked" && scheduleBlocked(i)).length
  };
  const refW = Math.max(3, ...[...items.keys()].map(width));
  const rows = [];
  const depthOf2 = (ref5, members, seen = /* @__PURE__ */ new Set()) => {
    if (seen.has(ref5)) return 0;
    seen.add(ref5);
    const list3 = (ups.get(ref5) ?? []).filter((up) => members.has(up));
    return list3.length ? 1 + Math.max(...list3.map((up) => depthOf2(up, members, new Set(seen)))) : 0;
  };
  const section = (label2, list3, base) => {
    if (!list3.length) return [];
    return [{ heading: label2, rows: grouped(list3, base) }];
  };
  const grouped = (list3, base) => {
    const out4 = [];
    const groups2 = /* @__PURE__ */ new Map();
    for (const item of list3) {
      const key = item.task.parent_ref && parents.has(item.task.parent_ref) ? item.task.parent_ref : "";
      groups2.set(key, [...groups2.get(key) ?? [], item]);
    }
    for (const key of [...groups2.keys()].sort((a, b) => idOf(a) - idOf(b))) {
      if (key) out4.push({ indent: -base, item: parents.get(key) });
      for (const item of groups2.get(key))
        out4.push({ indent: base + (key ? 1 : 0), item });
    }
    return out4;
  };
  const blocks = [...section("\u5C31\u7EEA", ready, 1)];
  for (const members of chains) {
    const set2 = new Set(members);
    const depth = new Map(members.map((ref5) => [ref5, depthOf2(ref5, set2)]));
    const holder = (ref5) => (ups.get(ref5) ?? []).filter((up) => set2.has(up)).sort((a, b) => depth.get(b) - depth.get(a) || idOf(a) - idOf(b))[0];
    const kids = /* @__PURE__ */ new Map();
    for (const ref5 of members) {
      const up = holder(ref5);
      if (up) kids.set(up, [...kids.get(up) ?? [], ref5]);
    }
    const deepest = [...members].sort(
      (a, b) => depth.get(b) - depth.get(a) || idOf(a) - idOf(b)
    )[0];
    const path6 = [deepest];
    for (let up = holder(deepest); up; up = holder(up)) path6.unshift(up);
    const more = members.length - path6.length;
    const root = items.get(path6[0]);
    const group = root.task.parent_ref && parents.has(root.task.parent_ref) ? parents.get(root.task.parent_ref) : void 0;
    const base = group ? 2 : 1;
    const chainRows = [];
    if (group) chainRows.push({ indent: -1, item: group });
    const walk = (ref5, level) => {
      chainRows.push({ indent: base + level, item: items.get(ref5) });
      for (const kid of (kids.get(ref5) ?? []).sort((a, b) => idOf(a) - idOf(b)))
        walk(kid, level + 1);
    };
    for (const ref5 of members.filter((ref6) => !holder(ref6))) walk(ref5, 0);
    blocks.push({
      heading: `\u4F9D\u8D56\u94FE ${path6.join(" \u2192 ")}${more > 0 ? `\uFF08\u53E6\u6709 ${more} \u9879\uFF09` : ""}`,
      rows: chainRows
    });
  }
  blocks.push(...section("\u7B49\u5F85\u4E2D", waiting, 1), ...section("\u5361\u4F4F", blocked, 1));
  rows.push(...blocks.flatMap((block) => block.rows));
  const prefixW = Math.max(
    0,
    ...rows.filter((row) => row.indent >= 0).map((row) => row.indent * 2 + 2 + refW)
  );
  const room = Math.max(0, frame.width - prefixW - 2);
  const longest = Math.max(
    8,
    ...rows.filter((row) => row.indent >= 0).map((row) => width(labelOf(row.item.task)))
  );
  const titleW = Math.min(
    longest,
    Math.max(8, Math.floor(room * (frame.wide ? 0.45 : 0.35)))
  );
  const detailW = frame.width - prefixW - 2 - titleW - 2;
  const header = `\u6392\u671F \xB7 \u5C31\u7EEA ${counts3.ready} \xB7 \u7B49\u5F85\u4E2D ${counts3.waiting} \xB7 \u5361\u4F4F ${counts3.blocked}` + (plan2.next_after ? " \xB7 \u4E0D\u6B62\u4E00\u9875" : "");
  const lines = [{ text: fit(header, frame.width) }];
  if (!rows.length)
    lines.push({ text: fit("  \u6CA1\u6709\u5C31\u7EEA\u3001\u7B49\u5F85\u4E2D\u6216\u5361\u4F4F\u7684\u5F85\u529E", frame.width) });
  for (const block of blocks) {
    if (block.heading)
      lines.push({ text: fit(` ${block.heading}`, frame.width) });
    for (const row of block.rows) {
      if (row.indent < 0) {
        const indent3 = "  ".repeat(-row.indent);
        lines.push({
          text: fit(
            `${indent3}\u25B8 ${row.item.ref} ${row.item.task.title}${row.item.task.part_ref ?? row.item.task.goal_ref ? ` \xB7 ${row.item.task.part_ref ?? row.item.task.goal_ref}` : ""}`,
            frame.width
          )
        });
        continue;
      }
      const prefix = pad(
        `${"  ".repeat(row.indent)}${SYMBOL[row.item.group]} ${row.item.ref}`,
        prefixW
      );
      const title = pad(oneLine(labelOf(row.item.task), titleW), titleW);
      const text = detail2(row.item, frame.now, frame.wide);
      const tail = detailW >= 6 && text ? `  ${oneLine(text, detailW)}` : "";
      lines.push({
        text: fit(`${prefix}  ${title}${tail}`.trimEnd(), frame.width),
        item: row.item.ref
      });
    }
  }
  return { counts: counts3, lines: fold(lines, frame, !!plan2.next_after) };
}
function fold(lines, frame, paged) {
  const hint = "\u5B8C\u6574\u6392\u671F\uFF1Aatrium task plan";
  const max = Math.max(2, frame.maxLines);
  if (lines.length <= max)
    return [
      ...lines.map((line2) => line2.text),
      ...paged ? [fit(`  \u2026\u6392\u671F\u4E0D\u6B62\u4E00\u9875\uFF0C${hint}`, frame.width)] : []
    ];
  const shown = lines.slice(0, max - 1);
  const seen = new Set(shown.map((line2) => line2.item).filter(Boolean));
  const hidden = new Set(
    lines.slice(max - 1).map((line2) => line2.item).filter((item) => !!item && !seen.has(item))
  ).size;
  return [
    ...shown.map((line2) => line2.text),
    fit(
      `  \u2026\u8FD8\u6709 ${hidden} \u6761${paged ? "\uFF08\u4E0D\u6B62\u4E00\u9875\uFF09" : ""}\uFF0C${hint}`,
      frame.width
    )
  ];
}
function fit(text, max) {
  if (width(text) <= max) return text;
  let out4 = "";
  for (const char of text) {
    if (width(out4 + char) > max - 1) break;
    out4 += char;
  }
  return `${out4}\u2026`;
}

// cli/map.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { resolve as resolve6 } from "node:path";
var str8 = (values, key) => typeof values[key] === "string" ? values[key] : void 0;
var list = (values, key) => {
  const value = values[key];
  if (value === void 0) return void 0;
  return (Array.isArray(value) ? value : [value]).map(String);
};
var client8 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var enc2 = encodeURIComponent;
var as4 = (values) => str8(values, "as") ? `?as=${enc2(str8(values, "as"))}` : "";
function label(node) {
  const alias = node.alias && node.alias !== node.name;
  return `${node.ref} ${alias ? `${node.alias}\uFF08${node.name}\uFF09` : node.name}${node.analogy ? `\u2014\u2014${node.analogy}` : ""}`;
}
var counts2 = (t) => [
  t.running ? `\u5728\u8DD1 ${t.running}` : "",
  t.blocked ? `\u5361\u4F4F ${t.blocked}` : "",
  t.open - t.running - t.blocked > 0 ? `\u5F85\u529E ${t.open - t.running - t.blocked}` : ""
].filter(Boolean).map((p) => ` \xB7 ${p}`).join("");
var DOT = {
  running: "\u25CF",
  blocked: "\u2715",
  idle: "\u25CB"
};
function renderMapTree(tree3, options4 = {}) {
  const lines = [];
  const walk = (node, level) => {
    if (node.archived) return;
    const indent3 = "  ".repeat(level);
    const line2 = `${indent3}${DOT[node.dot]} ${label(node)}${node.aspect ? " \xB7 \u7BA1\u65B9\u9762" : ""}${counts2(node.tasks)}`;
    lines.push(options4.width ? fit(line2, options4.width) : line2);
    if (options4.what !== false && node.what && level <= 1)
      lines.push(
        options4.width ? fit(`${indent3}  ${node.what}`, options4.width) : `${indent3}  ${node.what}`
      );
    const kids = (node.children ?? []).filter((c) => !c.archived);
    if (node.children) for (const child of kids) walk(child, level + 1);
    else if (node.children_count)
      lines.push(
        `${indent3}  \u2026\u4E0B\u5C42 ${node.children_count} \u5757\uFF1Aatrium map ${node.ref} --depth 2`
      );
  };
  walk(tree3, 0);
  return lines;
}
function renderTopMap(tree3, width2, depth = 2, maxLines = 20) {
  const lines = ["\u5168\u666F"];
  if (!tree3) return [...lines, "  \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811\uFF1Aatrium org import --repo \u4ED3\u5E93"];
  const walk = (nodes2, level) => {
    for (const node of nodes2) {
      if (node.archived) continue;
      const indent3 = "  ".repeat(level + 1);
      const what = node.what ? ` \xB7 ${node.what}` : "";
      lines.push(
        fit(
          `${indent3}${DOT[node.dot]} ${label({ ...node, analogy: "" })}${counts2(node.tasks)}${what}`,
          width2
        )
      );
      if (level + 1 < depth && node.children) walk(node.children, level + 1);
    }
  };
  walk(tree3.children ?? [], 0);
  if (lines.length === 1)
    lines.push("  \u8FD8\u6CA1\u6709\u4E0B\u4E00\u5C42\uFF1Aatrium map add \u7236\u8282\u70B9 \u540D\u79F0");
  if (lines.length <= maxLines) return lines;
  return [
    ...lines.slice(0, Math.max(1, maxLines - 1)),
    fit(`  \u2026\u8FD8\u6709 ${lines.length - maxLines + 1} \u884C\uFF1Aatrium map`, width2)
  ];
}
function openBrowser(url) {
  try {
    const { command, args } = openUrlInvocation(process.platform, url);
    const child = spawnCommand(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => {
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
function depthOf(values, fallback) {
  const value = str8(values, "depth");
  if (value === void 0) return fallback;
  if (!/^[0-8]$/.test(value))
    throw new Problem(
      400,
      `--depth \u5E94\u4E3A 0\uFF5E8 \u7684\u6574\u6570\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  return Number(value);
}
var mapCommands = {
  map: {
    args: "[\u8282\u70B9] [--depth N] [--no-open] [--json]",
    about: "\u770B\u5168\u666F\uFF1A\u7EC8\u7AEF\u6253\u5168\u666F\u6811\u5E76\u6253\u5F00\u672C\u673A\u7F51\u9875\uFF08\u4E00\u6B21\u6027\u767B\u5F55\u94FE\u63A5\uFF09\uFF1B--json \u8FD4\u56DE\u8282\u70B9\u4EBA\u8BDD\u5B57\u6BB5\u3001\u7EC4\u6210\u3001\u9636\u6BB5\u4E0E\u5728\u8DD1\u4EFB\u52A1\uFF08\u4E0E\u7F51\u9875\u540C\u4E00\u63A5\u53E3\uFF09",
    options: {
      depth: { type: "string" },
      "no-open": { type: "boolean", default: false }
    },
    positionals: [0, 1],
    async run({ positionals: [node], values, json }) {
      const api2 = await client8();
      if (json) {
        const root = node ?? (await api2.get("/map/tree?depth=0")).root ?? void 0;
        if (!root)
          throw new Problem(
            404,
            "\u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811",
            "not_found",
            void 0,
            "atrium org import --repo \u4ED3\u5E93"
          );
        const result = await api2.get(
          `/map/nodes/${enc2(root)}?depth=${depthOf(values, 1)}`
        );
        printJson(result);
        recordNext(`\u52A8\u4F5C\uFF1Aatrium map context ${result.ref}`);
        return 0;
      }
      const tree3 = await api2.get(
        `/map/tree?depth=${depthOf(values, 2)}${node ? `&root=${enc2(node)}` : ""}`
      );
      const lines = tree3.tree ? renderMapTree(tree3.tree, {
        width: process.stdout.isTTY ? process.stdout.columns : void 0
      }) : ["\u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811\uFF1Aatrium org import --repo \u4ED3\u5E93"];
      const login = await api2.post(
        "/map/login"
      );
      const record = readService(dataDirectory());
      if (!record)
        throw new Problem(503, "\u627E\u4E0D\u5230\u670D\u52A1\u5730\u5740", "service_unavailable");
      const url = `${serviceUrl(record)}${login.path}${tree3.root ? `&node=${tree3.root}` : ""}`;
      const interactive = process.stdout.isTTY && values["no-open"] !== true && process.env.ATRIUM_WORKER !== "1";
      const opened = interactive && openBrowser(url);
      console.log(
        [
          ...lines,
          "",
          `${opened ? "\u5DF2\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u5168\u666F\u7F51\u9875" : "\u5168\u666F\u7F51\u9875"}\uFF1A${url}`,
          `\uFF08\u94FE\u63A5\u53EA\u80FD\u7528\u4E00\u6B21\uFF0C${Math.round(login.ttl_ms / 6e4)} \u5206\u949F\u5185\u6709\u6548\uFF1B\u53EA\u8BFB\uFF0C\u6539\u52A8\u7528 atrium map edit\uFF09`
        ].join("\n")
      );
      recordNext(`\u52A8\u4F5C\uFF1Aatrium map ${tree3.root ?? "\u8282\u70B9"} --json`);
      return 0;
    }
  },
  "map context": {
    args: "\u8282\u70B9 [--also \u90E8\u5206[,\u90E8\u5206]] [--max \u5B57\u6570]",
    about: "\u7ED9\u51FA\u4ECE\u6839\u5230\u8BE5\u8282\u70B9\u7684\u4EBA\u8BDD\u94FE\u3001\u7EC4\u6210\u3001\u73B0\u72B6\u4E0E\u672C\u8282\u70B9\u53CA\u4E0A\u7EA7\u7684\u8981\u70B9\uFF0C\u518D\u52A0\u9002\u7528\u4E8E\u672C\u8282\u70B9\u7684\u7BA1\u65B9\u9762\u8981\u70B9\u4E0E --also \u7275\u6D89\u90E8\u5206\u7684\u8981\u70B9\uFF08\u6CE8\u660E\u6765\u6E90\uFF0C\u6709\u957F\u5EA6\u4E0A\u9650\uFF09\uFF1B\u6D3E\u6D3B\u65F6\u81EA\u52A8\u9644\u8FDB\u6267\u884C\u8005\u63D0\u793A\u8BCD",
    options: { max: { type: "string" }, also: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const query = new URLSearchParams(
        Object.fromEntries(
          ["max", "also"].filter((k) => str8(values, k) !== void 0).map((k) => [k, str8(values, k)])
        )
      ).toString();
      const result = await (await client8()).get(`/map/context/${enc2(node)}${query ? `?${query}` : ""}`);
      if (json) printJson(result);
      else
        console.log(
          result.text || `${result.ref} \u8FD8\u6CA1\u6709\u4EBA\u8BDD\u5B57\u6BB5\uFF1Aatrium map edit ${result.ref} --what \u4E00\u53E5\u8BDD`
        );
      recordNext(`\u52A8\u4F5C\uFF1Aatrium task add \u6807\u9898 --part ${result.ref}`);
      return 0;
    }
  },
  "map edit": {
    args: "\u8282\u70B9 [--what \u4E00\u53E5\u8BDD] [--uses \u573A\u666F]\u2026 [--flow \u6B65\u9AA4]\u2026 [--alias \u4EBA\u8BDD\u540D] [--analogy \u7C7B\u6BD4] [--now \u73B0\u72B6] [--next \u63A5\u4E0B\u6765] [--applies \u90E8\u5206[,\u90E8\u5206]] [--detail \u6587\u4EF6] [--rev rN] [--reason \u539F\u56E0] [--as aN]",
    about: "\u6539\u4E00\u5757\u7684\u4EBA\u8BDD\u5B57\u6BB5\uFF0C\u76F4\u63A5\u8986\u76D6\u4E14\u4E0D\u7559\u4FEE\u8BA2\uFF1B--applies \u53EA\u7528\u4E8E\u7BA1\u65B9\u9762\u7684\u90E8\u5206\uFF0C\u5199\u5B83\u7684\u8981\u70B9\u7F3A\u7701\u9002\u7528\u4E8E\u54EA\u4E9B\u90E8\u5206\uFF08\u7A7A\u4E32\u6539\u56DE\u6574\u4E2A\u4E0A\u7EA7\uFF09\uFF1B--detail \u6587\u4EF6\u6539\u7AE0\u7A0B\u6B63\u6587\u5E76\u7559\u4FEE\u8BA2\uFF08--rev \u4EC5\u7528\u4E8E\u6B64\uFF09\uFF1B\u7ED9\u7A7A\u4E32\u6E05\u6389\uFF1B\u8D1F\u8D23\u90E8\u95E8 leader \u6216\u5176\u4E0A\u7EA7\u53EF\u6539\uFF0C\u6839\u53EA\u6709\u4F60\u80FD\u6539",
    options: {
      applies: { type: "string" },
      what: { type: "string" },
      uses: { type: "string", multiple: true },
      flow: { type: "string", multiple: true },
      alias: { type: "string" },
      analogy: { type: "string" },
      now: { type: "string" },
      next: { type: "string" },
      when: { type: "string" },
      detail: { type: "string" },
      rev: { type: "string" },
      reason: { type: "string" },
      as: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      if (str8(values, "when") !== void 0)
        console.error(
          "--when \u5DF2\u8FC1\u5230\u4E13\u5458\u7684 --invite-when\uFF1B\u8BF7\u7528 atrium specialist edit\uFF1B\u65E7\u5199\u6CD5\u6682\u53EF\u7528"
        );
      const detail4 = str8(values, "detail");
      let body;
      if (detail4 !== void 0)
        try {
          body = readFileSync7(resolve6(detail4), "utf8");
        } catch (error) {
          throw new Problem(
            400,
            `--detail: \u8BFB\u4E0D\u4E86 ${detail4}\uFF08${error.code ?? "\u672A\u77E5\u9519\u8BEF"}\uFF09`,
            "usage"
          );
        }
      const input = {
        ...Object.fromEntries(
          [
            "what",
            "alias",
            "analogy",
            "now",
            "next",
            "when",
            "applies"
          ].filter((k) => str8(values, k) !== void 0).map((k) => [k, str8(values, k)])
        ),
        ...list(values, "uses") ? { uses: list(values, "uses") } : {},
        ...list(values, "flow") ? { flow: list(values, "flow") } : {},
        ...body === void 0 ? {} : { detail: body },
        ...str8(values, "rev") ? { rev: str8(values, "rev") } : {},
        ...str8(values, "reason") ? { reason: str8(values, "reason") } : {}
      };
      const result = await (await client8()).patch(
        `/map/nodes/${enc2(node)}${as4(values)}`,
        input
      );
      if (json) printJson(result);
      else console.log(`\u5DF2\u6539 ${result.node} \u7684\u5168\u666F`);
      recordNext(`\u52A8\u4F5C\uFF1Aatrium map context ${result.node}`);
      return 0;
    }
  },
  "map add": {
    args: "\u7236\u8282\u70B9 \u540D\u79F0 [--analogy \u7C7B\u6BD4] [--alias \u4EBA\u8BDD\u540D] [--what \u4E00\u53E5\u8BDD] [--slug \u8DEF\u5F84\u540D] [--kind aspect] [--reason \u539F\u56E0] [--as aN]",
    about: "\u5728\u7236\u8282\u70B9\u4E0B\u52A0\u4E00\u5757\uFF08\u7EC4\u6210\u90E8\u5206\uFF09\uFF0C\u53EF\u540C\u65F6\u5199\u4EBA\u8BDD\u540D\u3001\u7C7B\u6BD4\u4E0E\u4E00\u53E5\u662F\u4EC0\u4E48\uFF1B\u540D\u79F0\u4E0D\u80FD\u76F4\u63A5\u5F53\u8DEF\u5F84\u540D\u65F6\u7ED9 --slug\uFF1B--kind aspect \u5EFA\u7BA1\u65B9\u9762\u7684\u90E8\u5206\uFF08\u5982\u5B89\u5168\uFF0C\u8981\u70B9\u6A2A\u8DE8\u591A\u4E2A\u90E8\u5206\uFF0C\u7528 map edit --applies \u6216 org point-add --applies \u5199\u9002\u7528\u8303\u56F4\uFF09",
    options: {
      analogy: { type: "string" },
      alias: { type: "string" },
      what: { type: "string" },
      slug: { type: "string" },
      kind: { type: "string" },
      reason: { type: "string" },
      as: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [parent, name], values, json }) {
      const result = await (await client8()).post(`/map/nodes${as4(values)}`, {
        parent,
        name,
        ...Object.fromEntries(
          ["analogy", "alias", "what", "slug", "kind", "reason"].filter((k) => str8(values, k) !== void 0).map((k) => [k, str8(values, k)])
        )
      });
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u5728 ${result.parent} \u4E0B\u52A0\u4E86 ${result.node} ${result.name}\uFF08${result.aspect ? "\u7BA1\u65B9\u9762" : result.kind}\uFF09`
        );
      recordNext(
        result.aspect ? `\u52A8\u4F5C\uFF1Aatrium org point-add ${result.node} \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by \u8C01\u5B9A\u7684 --applies \u90E8\u5206` : `\u52A8\u4F5C\uFF1Aatrium map edit ${result.node} --what \u4E00\u53E5\u8BDD --uses \u573A\u666F --flow \u6B65\u9AA4`
      );
      return 0;
    }
  }
};

// server/map/view.ts
var DEPTH_MAX = 8;

// cli/top.ts
var str9 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var client9 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var REFRESH_SECONDS = 2;
var REFRESH_MAX = 60;
var WORKER_MIN_WIDTH = 80;
var MIN_TITLE = 12;
var MIN_ACTION = 10;
var MAX_WORKER = 20;
function interval(value) {
  if (value === void 0) return REFRESH_SECONDS;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > REFRESH_MAX)
    throw new Problem(
      400,
      `--interval \u5E94\u4E3A 1\uFF5E${REFRESH_MAX} \u7684\u6574\u6570\u79D2\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  return Number(value);
}
function columns(value) {
  if (value === void 0) return process.stdout.columns || 80;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 20 || number > 500)
    throw new Problem(
      400,
      `--width \u5E94\u4E3A 20\uFF5E500 \u7684\u6574\u6570\u5217\u6570\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  return number;
}
function mapDepth(value, flag = "--depth") {
  if (value === void 0) return 2;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > DEPTH_MAX)
    throw new Problem(
      400,
      `${flag} \u5E94\u4E3A 1\uFF5E${DEPTH_MAX} \u7684\u6574\u6570\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
      "usage"
    );
  return Number(value);
}
var SYMBOL2 = {
  running: "\u25CF",
  queued: "\u25CC",
  blocked: "\u2715",
  processing: "\u25CF",
  done: "\u2713",
  failed: "\u2715",
  cancelled: "\xB7",
  reviewing: "\u25CF",
  merge_queued: "\u25CC",
  merging: "\u25CF",
  merged: "\u2713",
  online: "\u2713"
};
var FINISHED = /* @__PURE__ */ new Set(["done", "failed", "cancelled"]);
var phase = (row) => row.queued_at !== null ? "queued" : row.delivery_stage ?? (row.status === "running" || row.status === "blocked" ? row.status : row.status);
var titleOf2 = (row) => row.urgent ? `\u7D27\u6025 ${row.title}` : row.idle ? `\u95F2\u65F6 ${row.title}` : row.title;
function state(row, now) {
  const kind = phase(row);
  if (kind === "queued") return `\u6392\u961F${row.reason ? `\uFF08${row.reason}\uFF09` : ""}`;
  if (kind === "reviewing") return "\u5BA1\u9605\u4E2D";
  if (kind === "merge_queued") return "\u6392\u961F\u5408\u5165";
  if (kind === "merging") return "\u5408\u5165\u4E2D";
  if (kind === "merged") return "\u5DF2\u5408\u5165";
  if (kind === "online") return "\u5DF2\u4E0A\u7EBF";
  if (kind === "blocked")
    return row.holder ? row.holder.text : `${row.processing ? "\u5904\u7406\u4E2D" : "\u5361\u4F4F"}${row.reason ? `\uFF1A${row.reason}` : ""}`;
  const from = row.started_at;
  const to = FINISHED.has(kind) ? row.ended_at ?? now : now;
  return from ? duration2(to - from) : "\u2014";
}
function action(row, now) {
  const kind = phase(row);
  if (kind === "queued" || kind === "blocked") return "";
  if (row.action?.text)
    return `${row.action.text} \xB7 ${ago(row.log_at, now)} \u524D`;
  if (row.log_at) return `\u65E5\u5FD7 ${ago(row.log_at, now)} \u524D\u6709\u8F93\u51FA`;
  return "";
}
function duration2(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
}
var ago = (at, now) => duration2(now - at);
var DIM = "\x1B[2m";
var RESET = "\x1B[0m";
var faint = (text) => text ? `${DIM}${text}${RESET}` : text;
var workerCell = (row) => row.host ? `${row.host} ${row.worker ?? ""}` : row.worker ?? "";
var TITLE_SHARE = 0.55;
function layoutOf(rows, width_, stateW) {
  const refW = Math.max(3, ...rows.map((row) => width(row.ref)));
  const workerW = Math.min(
    MAX_WORKER,
    Math.max(0, ...rows.map((row) => width(workerCell(row))))
  );
  const showWorker = width_ >= WORKER_MIN_WIDTH && workerW > 0;
  const overhead = 1 + 2 + refW + 2 + 2 + (showWorker ? workerW + 2 : 0) + stateW + 2;
  const room = Math.max(MIN_TITLE + MIN_ACTION, width_ - overhead);
  const titleW = Math.max(
    MIN_TITLE,
    Math.min(
      Math.max(MIN_TITLE, ...rows.map((row) => width(titleOf2(row)))),
      Math.max(MIN_TITLE, Math.floor(room * TITLE_SHARE))
    )
  );
  return {
    refW,
    workerW,
    showWorker,
    titleW,
    stateW,
    actionW: Math.max(MIN_ACTION, room - titleW)
  };
}
function hostBrief(host) {
  if (!host?.paused) return "";
  const load = (value) => value >= 10 ? value.toFixed(0) : value.toFixed(1);
  const cores = (value) => Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (host.paused_by === "own" && host.own_cores != null && host.busy_cores != null)
    return ` \xB7 \u672C\u673A\u592A\u5FD9\uFF0C\u6392\u961F\u4E2D\uFF08Atrium \u81EA\u5DF1\u5360\u4E86 ${cores(host.own_cores)} \u6838\uFF0C\u8D85\u8FC7 ${cores(host.busy_cores)}\uFF09`;
  if (host.paused_by === "load" || host.paused_by === void 0 && host.busy_load !== null && host.load > host.busy_load)
    return ` \xB7 \u672C\u673A\u592A\u5FD9\uFF0C\u6392\u961F\u4E2D\uFF08\u6574\u673A\u8D1F\u8F7D ${load(host.load)}\uFF0C\u8D85\u8FC7 ${load(host.busy_load)}\uFF09`;
  return ` \xB7 \u672C\u673A\u6EE1 ${host.running}/${host.max_workers}\uFF0C\u6392\u961F\u4E2D`;
}
function renderTop(snapshot, frame) {
  const rows = snapshot.rows;
  const states = rows.map((row) => oneLine(state(row, frame.now), Infinity));
  const stateW = Math.max(
    0,
    ...states.filter((_, index) => rowTakesStateWidth(rows[index])).map(width)
  );
  const plan2 = layoutOf(rows, frame.width, stateW);
  const clock = `${new Date(frame.now).toTimeString().slice(0, 5)} \u5237\u65B0`;
  const head = `Atrium \xB7 \u5728\u8DD1 ${snapshot.counts.running} \xB7 \u6392\u961F ${snapshot.counts.queued}` + hostBrief(snapshot.host) + (snapshot.counts.reviewing ? ` \xB7 \u5BA1\u9605\u4E2D ${snapshot.counts.reviewing}` : "") + (snapshot.counts.merge_queued ? ` \xB7 \u6392\u961F\u5408\u5165 ${snapshot.counts.merge_queued}` : "") + (snapshot.counts.merging ? ` \xB7 \u5408\u5165\u4E2D ${snapshot.counts.merging}` : "") + (snapshot.counts.merged ? ` \xB7 \u5DF2\u5408\u5165 ${snapshot.counts.merged}` : "") + (snapshot.counts.online ? ` \xB7 \u5DF2\u4E0A\u7EBF ${snapshot.counts.online}` : "") + ` \xB7 \u5904\u7406\u4E2D ${snapshot.counts.processing} \xB7 \u5361\u4F4F ${snapshot.counts.blocked} \xB7 \u672A\u5904\u7406\u4E8B\u4EF6 ${snapshot.counts.events}`;
  const headRoom = Math.max(10, frame.width - width(clock) - 1);
  const lines = [
    pad(oneLine(head, headRoom), headRoom) + clock,
    ...rows.flatMap((row, index) => {
      const cell2 = oneLine(states[index], plan2.stateW + 2 + plan2.actionW);
      const text = [
        `${SYMBOL2[row.processing && phase(row) === "blocked" ? "processing" : phase(row)] ?? "\xB7"} ${pad(row.ref, plan2.refW)}`,
        pad(oneLine(titleOf2(row), plan2.titleW), plan2.titleW),
        ...plan2.showWorker ? [pad(oneLine(workerCell(row), plan2.workerW), plan2.workerW)] : [],
        pad(cell2, plan2.stateW),
        pad(oneLine(action(row, frame.now), plan2.actionW), plan2.actionW)
      ].join("  ").trimEnd();
      const line2 = FINISHED.has(phase(row)) && frame.color ? faint(text) : text;
      return [
        line2,
        ...row.note ? [
          `  ${oneLine(`\u5907\u6CE8\uFF08${row.note_by ?? "\u672A\u77E5"} \xB7 ${new Date(row.note_at).toLocaleString("zh-CN")}\uFF09\uFF1A${row.note}`, frame.width - 2)}`
        ] : [],
        ...row.tells?.total ? [
          `  ${oneLine(`\u634E\u8BDD ${row.tells.total} \u6761${row.tells.pending ? `\uFF0C${row.tells.pending} \u6761\u5F85\u9001\u8FBE` : "\uFF0C\u90FD\u5DF2\u9001\u8FBE"}`, frame.width - 2)}`
        ] : [],
        ...row.concerns?.length ? [`  ${oneLine(concernsBrief(row.concerns), frame.width - 2)}`] : []
      ];
    })
  ];
  if (!rows.length) lines.push("\u73B0\u5728\u6CA1\u6709\u5728\u8DD1\u3001\u6392\u961F\u6216\u53D7\u963B\u7684\u4EFB\u52A1");
  if (snapshot.truncated)
    lines.push(`\uFF08\u4EFB\u52A1\u8FC7\u591A\uFF0C\u53EA\u663E\u793A\u524D ${rows.length} \u4E2A\uFF09`);
  if (snapshot.hosts?.length)
    lines.push(
      "",
      oneLine(
        `\u4E3B\u673A\uFF1A${snapshot.hosts.map((h) => `${h.ref} ${h.name} ${h.status} ${h.running}/${h.max ?? "\u4E0D\u9650"}`).join(" \xB7 ")}`,
        frame.width
      )
    );
  if (snapshot.leaders?.length)
    lines.push(
      "",
      "leader",
      ...snapshot.leaders.map(
        (l) => `  ${oneLine(`${l.ref} ${l.name} \xB7 \u8D1F\u8D23 ${l.nodes.join("\u3001") || "\uFF08\u65E0\uFF09"} \xB7 ${wakeText(l.wake)}${l.events ? ` \xB7 \u5F85\u5904\u7406 ${l.events}` : ""}`, frame.width - 2)}`
      )
    );
  if (snapshot.map) {
    lines.push("");
    const room = frame.height ? Math.max(
      3,
      frame.height - lines.length - PLAN_MIN_LINES - (frame.footer ? 1 : 0)
    ) : 20;
    lines.push(
      ...renderTopMap(
        snapshot.map.tree,
        frame.width,
        frame.mapDepth ?? 2,
        room
      )
    );
  } else if (snapshot.map === null)
    lines.push(
      "",
      oneLine(
        `\u5168\u666F\uFF1A\u53D6\u4E0D\u5230\uFF08${snapshot.map_error ?? "\u672A\u77E5\u539F\u56E0"}\uFF09`,
        frame.width
      )
    );
  if (snapshot.plan) {
    lines.push("");
    const room = frame.height ? frame.height - lines.length - (frame.footer ? 1 : 0) : PLAN_LINES;
    lines.push(
      ...renderPlan(snapshot.plan, {
        width: frame.width,
        now: frame.now,
        maxLines: Math.max(PLAN_MIN_LINES, room),
        wide: frame.width >= WORKER_MIN_WIDTH
      }).lines
    );
  } else if (snapshot.plan === null)
    lines.push(
      "",
      oneLine(
        `\u6392\u671F\uFF1A\u53D6\u4E0D\u5230\uFF08${snapshot.plan_error ?? "\u672A\u77E5\u539F\u56E0"}\uFF09`,
        frame.width
      )
    );
  if (frame.footer) lines.push(`\u52A8\u4F5C\uFF1A${nextOf(rows)}`);
  return lines.join("\n");
}
var rowTakesStateWidth = (row) => {
  const kind = phase(row);
  return kind !== "queued" && kind !== "blocked";
};
var nextOf = (rows) => {
  const live = rows.find((row) => phase(row) === "running") ?? rows[0];
  return live ? `atrium task show ${live.ref}` : "atrium task add \u6807\u9898";
};
var PLAN_MIN_LINES = 4;
async function snapshotOf(api2, as5, depth = 2) {
  const [snapshot, plan2, map] = await Promise.all([
    api2.get(path5(as5)),
    api2.get("/tasks/plan").then(
      (value) => ({ value }),
      (error) => ({
        error: error instanceof Error ? error.message : String(error)
      })
    ),
    api2.get(`/map/tree?depth=${depth}`).then(
      (value) => ({ value }),
      (error) => ({
        error: error instanceof Error ? error.message : String(error)
      })
    )
  ]);
  return {
    ...snapshot,
    ..."error" in map ? { map: null, map_error: map.error } : map.value && "tree" in map.value ? { map: { root: map.value.root, tree: map.value.tree } } : { map: null, map_error: "\u5168\u666F\u63A5\u53E3\u8FD4\u56DE\u7684\u683C\u5F0F\u770B\u4E0D\u61C2" },
    ..."error" in plan2 ? { plan: null, plan_error: plan2.error } : plan2.value?.groups && typeof plan2.value.groups === "object" ? { plan: plan2.value } : { plan: null, plan_error: "\u6392\u671F\u63A5\u53E3\u8FD4\u56DE\u7684\u683C\u5F0F\u770B\u4E0D\u61C2" }
  };
}
var path5 = (as5) => as5 === void 0 ? "/tasks/top" : `/tasks/top?${new URLSearchParams({ as: as5 })}`;
function liveTerminal() {
  let release;
  return {
    columns: () => process.stdout.columns || 80,
    rows: () => process.stdout.rows || 24,
    color: () => Boolean(process.stdout.isTTY),
    enter: () => process.stdout.write("\x1B[?1049h\x1B[?25l"),
    leave: () => process.stdout.write("\x1B[?25h\x1B[?1049l"),
    frame: (text) => process.stdout.write(`\x1B[H\x1B[0J${text}
`),
    onQuit: (quit) => {
      const onData = (chunk) => {
        const text = chunk.toString("utf8");
        if (/[qQ]/.test(text) || text.includes("") || text.includes(""))
          quit();
      };
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      release = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      };
    },
    offQuit: () => {
      release?.();
      release = void 0;
    }
  };
}
async function watch(api2, as5, seconds, terminal, once = false, depth = 2) {
  let stopped = false;
  const stop2 = () => {
    stopped = true;
  };
  if (!once) {
    terminal.enter();
    terminal.onQuit(stop2);
    const restore = () => {
      if (stopped) return;
      stopped = true;
      terminal.offQuit();
      terminal.leave();
    };
    process.once("exit", restore);
    process.once("SIGINT", restore);
    process.once("SIGTERM", restore);
  }
  try {
    while (!stopped) {
      let snapshot;
      let reason3 = null;
      try {
        snapshot = await snapshotOf(api2, as5, depth);
      } catch (error) {
        reason3 = error instanceof Problem ? error.message : `\u53D6\u6570\u636E\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
      }
      terminal.frame(
        snapshot ? renderTop(snapshot, {
          width: terminal.columns(),
          now: Date.now(),
          footer: true,
          color: terminal.color(),
          height: terminal.rows?.(),
          mapDepth: depth
        }) : `Atrium \xB7 ${reason3}`
      );
      if (once) break;
      await delay2(seconds * 1e3);
    }
  } finally {
    if (!once) {
      terminal.offQuit();
      terminal.leave();
    }
  }
  return 0;
}
var topCommand = {
  args: "[--once] [--json] [--interval \u79D2] [--width \u5217] [--depth N] [--as \u8BA2\u9605\u8005]",
  about: "\u5B9E\u65F6\u770B\u8C01\u5728\u5E72\u6D3B\u3001\u5168\u666F\u56FE\u4E0A\u4E24\u5C42\u5404\u5757\u7684\u72B6\u6001\u4E0E\u5728\u8DD1\u6570\uFF0C\u4EE5\u53CA\u6392\u671F\uFF1B--depth \u5C55\u5F00\u5168\u666F\u5C42\u6570\uFF1B\u7F3A\u7701\u6BCF 2 \u79D2\u5237\u65B0\uFF0Cq \u6216 Ctrl-C \u9000\u51FA",
  options: {
    once: { type: "boolean", default: false },
    interval: { type: "string" },
    width: { type: "string" },
    depth: { type: "string" },
    // 旧写法：目标树已并进全景图，照旧接受，等同 --depth。
    "goals-depth": { type: "string" },
    as: { type: "string" }
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const as5 = str9(values, "as");
    if (as5 !== void 0 && !as5.trim())
      throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const seconds = interval(str9(values, "interval"));
    const width_ = columns(str9(values, "width"));
    const depth = str9(values, "depth") !== void 0 ? mapDepth(str9(values, "depth")) : mapDepth(str9(values, "goals-depth"), "--goals-depth");
    const once = values.once === true || json || !process.stdout.isTTY || !process.stdin.isTTY;
    const api2 = await client9();
    if (!once) return watch(api2, as5, seconds, liveTerminal(), false, depth);
    const snapshot = await snapshotOf(api2, as5, depth);
    if (json) {
      printJson(snapshot);
      recordNext("\u5B9E\u65F6\u770B\uFF1Aatrium top");
    } else {
      console.log(
        renderTop(snapshot, {
          width: width_,
          now: Date.now(),
          footer: false,
          color: false,
          mapDepth: depth
        })
      );
      recordNext(`\u52A8\u4F5C\uFF1A${nextOf(snapshot.rows)}`);
    }
    return 0;
  }
};

// cli/statusline.ts
var DIM2 = "\x1B[2m";
var BOLD = "\x1B[1m";
var GREEN = "\x1B[32m";
var YELLOW = "\x1B[33m";
var RED = "\x1B[31m";
var CYAN = "\x1B[36m";
var RESET2 = "\x1B[0m";
var TASK_LINES = 8;
var TITLE_MAX = 28;
var ORDER = [
  "user",
  "worker",
  "leader",
  "secretary",
  "merge",
  "queue"
];
var MARK = {
  user: ["\u2731", `${BOLD}${RED}`],
  worker: ["\u25CF", GREEN],
  leader: ["\u25C7", YELLOW],
  secretary: ["\u25C7", YELLOW],
  merge: ["\u25C6", CYAN],
  queue: ["\u25CC", DIM2]
};
function workerLabel(worker) {
  const [harness, rest = ""] = (worker ?? "?").split("+", 2);
  const model = rest.split(":")[0].split("/").at(-1) ?? "";
  return model ? `${harness} \xB7 ${model}` : harness;
}
function taskLine(row, full, now, paint) {
  const holder = { ...full, text: oneLine(full.text, HOLDER_WIDTH) };
  const [mark, color] = MARK[holder.kind];
  const tag = row.urgent ? `${paint(`${BOLD}${RED}`, "\u7D27\u6025")} ` : row.idle ? `${paint(DIM2, "\u95F2\u65F6")} ` : "";
  const title = `${tag}\u300C${oneLine(row.title, TITLE_MAX)}\u300D`;
  if (holder.kind === "user")
    return `${paint(color, mark)} ${row.ref} ${title} ${paint(color, `\u7B49\u4F60\uFF1A${holder.text}`)}`;
  if (holder.kind === "worker") {
    const took = row.started_at ? ` ${duration2(now - row.started_at)}` : "";
    const story = holder.text.endsWith(" \u5728\u505A") ? "" : ` \xB7 ${holder.text}`;
    return `${paint(color, mark)} ${row.ref} ${title} ${workerLabel(row.worker)}${paint(DIM2, took)}${story}`;
  }
  const text = holder.kind === "queue" ? paint(DIM2, holder.text) : paint(color, holder.text);
  return `${paint(color, mark)} ${row.ref} ${title} ${text}`;
}
function renderStatusline(input) {
  const paint = (color, text) => input.color && text ? `${color}${text}${RESET2}` : text;
  const { snapshot, now } = input;
  const held = snapshot.rows.filter((row) => !!row.holder).sort(
    (a, b) => ORDER.indexOf(a.holder.kind) - ORDER.indexOf(b.holder.kind) || (a.started_at ?? a.updated_at) - (b.started_at ?? b.updated_at)
  );
  const count = (kind) => held.filter((row) => row.holder.kind === kind).length;
  const leaders = (snapshot.leaders ?? []).filter(
    (l) => l.wake?.status === "running" || l.events > 0
  );
  const events = snapshot.counts.events;
  const ready = input.plan?.groups.ready.length ?? 0;
  const waiting = input.plan?.groups.waiting.length ?? 0;
  if (!held.length && !leaders.length && !events && !ready && !waiting)
    return paint(DIM2, "Atrium \u7A7A\u95F2");
  const parts = [
    `\u5728\u505A ${count("worker")}`,
    ...count("leader") ? [`leader \u5904\u7406 ${count("leader")}`] : [],
    ...count("secretary") ? [`\u79D8\u4E66\u5904\u7406 ${count("secretary")}`] : [],
    ...count("merge") ? [`\u5408\u5165 ${count("merge")}`] : [],
    ...count("queue") ? [`\u6392\u961F ${count("queue")}`] : []
  ];
  const head = [
    // 暂停派新活时写清是哪条线（t113）：Atrium 自己占的核、整机负载保护线，还是执行者满了。
    `Atrium ${parts.join(" \xB7 ")}${hostBrief(snapshot.host)}`,
    ...count("user") ? [paint(`${BOLD}${RED}`, `\u7B49\u4F60 ${count("user")}`)] : [],
    ...events ? [
      paint(
        YELLOW,
        `${snapshot.subscriber === "secretary" ? "\u79D8\u4E66" : snapshot.subscriber}\u672A\u5904\u7406\u4E8B\u4EF6 ${events}`
      )
    ] : []
  ].join(" \xB7 ");
  const lines = [head];
  for (const row of held.slice(0, TASK_LINES))
    lines.push(taskLine(row, row.holder, now, paint));
  if (held.length > TASK_LINES)
    lines.push(
      paint(DIM2, `  \u2026\u8FD8\u6709 ${held.length - TASK_LINES} \u4E2A\uFF0Catrium top \u770B\u5168\u90E8`)
    );
  for (const leader of leaders) {
    const doing = leader.wake?.status === "running" ? `\u5904\u7406\u4E2D${leader.wake.summary ? `\uFF1A${oneLine(leader.wake.summary, 40)}` : ""}` : "";
    const pending = leader.events ? `\u5F85\u5904\u7406 ${leader.events} \u4EF6` : "";
    lines.push(
      `${paint(YELLOW, "\u25CE")} ${leader.ref} ${leader.name} ${paint(DIM2, [doing, pending].filter(Boolean).join(" \xB7 "))}`
    );
  }
  if (ready || waiting)
    lines.push(paint(DIM2, `\u63A5\u4E0B\u6765\uFF1A\u5C31\u7EEA ${ready} \xB7 \u7B49\u5F85\u4E2D ${waiting}`));
  return lines.join("\n");
}
async function fetchState(api2, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const [snapshot, plan2] = await Promise.all([
    api2.get("/tasks/top", void 0, signal),
    api2.get("/tasks/plan", void 0, signal).catch(() => null)
  ]);
  return { snapshot, plan: plan2?.groups ? plan2 : null };
}
function drainStdin() {
  if (process.stdin.isTTY) return () => {
  };
  process.stdin.on("data", () => {
  });
  process.stdin.on("error", () => {
  });
  return () => process.stdin.destroy();
}
var statuslineCommand = {
  args: "[--json]",
  about: "Claude Code \u72B6\u6001\u680F\uFF1A\u672A\u7ED3\u675F\u4EFB\u52A1\u5404\u5728\u8C01\u624B\u91CC\uFF08\u6267\u884C\u8005\u3001\u5408\u5165\u3001leader\u3001\u79D8\u4E66\u3001\u7B49\u4F60\uFF09\u3001leader \u5728\u5904\u7406\u4EC0\u4E48\u3001\u672A\u5904\u7406\u4E8B\u4EF6\uFF1B\u670D\u52A1\u4E0D\u5728\u53EA\u663E\u793A\u672A\u8FD0\u884C\uFF0C\u4E0D\u62C9\u8D77",
  positionals: [0, 0],
  async run({ json }) {
    const done3 = drainStdin();
    try {
      const { connectRunning } = await import("./chunk-YHCQNRVB.js");
      const api2 = connectRunning();
      if (!api2) {
        if (json) printJson({ running: false });
        else console.log("Atrium \u672A\u8FD0\u884C");
        return;
      }
      let state2;
      try {
        state2 = await fetchState(api2, 1500);
      } catch (error) {
        if (json) throw error;
        const why = error instanceof Problem && error.code === "auth_required" ? "\u8BA4\u8BC1\u5931\u6548\uFF0C\u8FD0\u884C atrium auth rotate" : "\u670D\u52A1\u6CA1\u54CD\u5E94";
        console.log(`Atrium ${why}`);
        return;
      }
      if (json) printJson({ running: true, ...state2 });
      else
        console.log(
          renderStatusline({
            ...state2,
            now: Date.now(),
            color: !process.env.NO_COLOR
          })
        );
    } finally {
      done3();
    }
  }
};

// cli/quota.ts
var client10 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
function cell(value) {
  if (value === null) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function refreshed(value) {
  if (!value) return "";
  const at = Date.parse(value);
  return Number.isFinite(at) ? when(at) : value;
}
var SOURCE_LABEL = { builtin: "\u81EA\u5E26", openquota: "OpenQuota" };
function formatQuotaTable(accounts, notes = []) {
  const tail = notes.length ? `
${notes.join("\n")}` : "";
  if (!accounts.length) return `\u6CA1\u6709\u8D26\u53F7\u989D\u5EA6\u6570\u636E${tail}`;
  const body = table([
    [
      "\u8D26\u53F7",
      "\u6765\u6E90",
      "\u5DF2\u7528%",
      "\u5468\u671F\u8FDB\u5EA6%",
      "\u5BCC\u4F59%",
      "\u8DDD\u91CD\u7F6E\uFF08\u5C0F\u65F6\uFF09",
      "\u77ED\u7A97\u5DF2\u7528%",
      "\u5237\u65B0\u65F6\u95F4",
      "\u8FD0\u884C\u65F6\u8BB0\u5F55",
      "\u8BF4\u660E"
    ],
    ...accounts.map((account) => [
      account.providerId,
      account.source ? SOURCE_LABEL[account.source] : "",
      cell(account.usedPercent),
      cell(account.periodElapsedPercent),
      cell(account.sparePercent),
      cell(account.hoursToReset),
      cell(account.shortWindowUsedPercent),
      refreshed(account.refreshedAt),
      account.runtime ?? "",
      account.note ?? ""
    ])
  ]);
  return `${body}${tail}`;
}
function reserveLine(reserve) {
  if (!reserve) return null;
  return reserve.set_by ? `\u7ED9\u4F60\u7559\u7684\u4EFD\u989D\uFF1A\u6BCF\u4E2A\u8D26\u53F7\u81F3\u5C11 ${reserve.percent}%\uFF08${reserve.set_by} \u7AE0\u7A0B\uFF09` : `\u7ED9\u4F60\u7559\u7684\u4EFD\u989D\uFF1A\u6BCF\u4E2A\u8D26\u53F7\u81F3\u5C11 ${reserve.percent}%\uFF08\u7F3A\u7701\uFF1B\u5728\u6839\u7AE0\u7A0B boundaries \u91CC\u5199 quota_reserve_percent \u53EF\u6539\uFF09`;
}
var quota = {
  args: "[--clear <\u8D26\u53F7>] [--json]",
  about: "\u5217\u51FA\u8D26\u53F7\u989D\u5EA6\uFF1B--clear \u4EBA\u5DE5\u89E3\u9664\u8FD0\u884C\u65F6\u5360\u7528\u5E76\u7ACB\u5373\u91CD\u6D3E\u6392\u961F\u4EFB\u52A1",
  options: { clear: { type: "string" } },
  positionals: [0, 0],
  async run({ json, values }) {
    const provider = typeof values.clear === "string" ? values.clear : void 0;
    if (values.clear !== void 0) {
      if (!provider || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider))
        throw new Problem(400, "--clear: \u8D26\u53F7\u540D\u4E0D\u5408\u6CD5", "usage");
      const result2 = await (await client10()).post(
        `/quota/${encodeURIComponent(provider)}/clear`,
        {}
      );
      recordResult(result2);
      if (json) printJson(result2);
      else
        console.log(
          `\u5DF2\u89E3\u9664 ${provider} \u7684\u8FD0\u884C\u65F6\u989D\u5EA6\u5360\u7528\uFF1B\u7ACB\u5373\u6D3E\u53D1 ${result2.dispatched} \u4E2A\u6392\u961F\u4EFB\u52A1`
        );
      recordNext("\u770B\u4EFB\u52A1\uFF1Aatrium task ls");
      return;
    }
    const result = await (await client10()).get("/quota");
    if (json) printJson(result);
    else
      console.log(
        [
          formatQuotaTable(result.accounts, result.notes ?? []),
          reserveLine(result.reserve)
        ].filter((line2) => line2 !== null).join("\n")
      );
    recordNext("\u770B\u4EFB\u52A1\uFF1Aatrium task ls");
  }
};
var quotaCommands = { quota };

// cli/events.ts
var str10 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var client11 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
function eventLine(event) {
  const detail4 = event.detail ?? {};
  const reason3 = typeof detail4.message === "string" ? detail4.message : typeof detail4.reason === "string" ? detail4.reason : "";
  const title = typeof detail4.title === "string" ? detail4.title : "";
  const verification = event.kind === "online" && typeof detail4.verification === "string" ? `
  \u7AEF\u5230\u7AEF\u9A8C\u8BC1\uFF1A
${detail4.verification.split("\n").map((line3) => `    ${line3}`).join("\n")}` : "";
  const line2 = [
    `#${event.id}`,
    event.task ?? "",
    event.kind,
    title ? clip(title, 40) : "",
    event.count > 1 ? `\uFF08\u5408\u5E76 ${event.count} \u6B21\uFF09` : "",
    event.delivered_at !== null ? "\u5DF2\u9001\u8FBE" : "\u672A\u9001\u8FBE",
    event.acked_at !== null ? "\u5DF2\u786E\u8BA4" : "\u672A\u786E\u8BA4",
    typeof detail4.pr_url === "string" ? detail4.pr_url : "",
    reason3 ? `\xB7 ${clip(reason3, 160)}` : "",
    `\xB7 ${when(event.updated_at)}`
  ].filter(Boolean).join(" ");
  return line2 + verification;
}
var list2 = {
  args: "[--as \u8BA2\u9605\u8005] [--before \u7F16\u53F7] [--limit \u6761\u6570]",
  about: "\u67E5\u770B\u4E8B\u4EF6\u7684\u9001\u8FBE\u4E0E\u786E\u8BA4\u72B6\u6001\uFF0C\u7F3A\u7701\u663E\u793A secretary \u6700\u8FD1 50 \u6761",
  options: {
    as: { type: "string" },
    before: { type: "string" },
    limit: { type: "string" }
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const who = str10(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const query = new URLSearchParams({ as: who });
    for (const key of ["before", "limit"])
      if (str10(values, key) !== void 0) query.set(key, str10(values, key));
    const result = await (await client11()).get(
      `/events?${query}`
    );
    if (result.next_before !== null)
      recordNext(
        `\u7EE7\u7EED\u67E5\u770B\uFF1Aatrium events --as ${who} --before ${result.next_before}`
      );
    else recordNext(`\u7B49\u65B0\u4E8B\u4EF6\uFF1Aatrium events wait --as ${who}`);
    if (json) printJson(result);
    else if (!result.events.length) console.log(`${who} \u6CA1\u6709\u4E8B\u4EF6`);
    else console.log(result.events.map(eventLine).join("\n"));
  }
};
var wait2 = {
  args: "[--as \u8BA2\u9605\u8005] [--timeout \u79D2] [--settle \u79D2] [--all]",
  about: "\u7F3A\u7701\u53EA\u53D6\u8981\u5904\u7406\u4E8B\u4EF6\uFF0C\u9996\u6761\u540E\u6700\u591A\u6512\u6279 30 \u79D2\uFF1B--all \u5305\u62EC\u8FC7\u7A0B\u77E5\u4F1A\uFF1B\u53D6\u8D70\u540E 15 \u5206\u949F\u5185\u4E0D\u91CD\u6295",
  options: {
    as: { type: "string" },
    timeout: { type: "string" },
    settle: { type: "string" },
    all: { type: "boolean" }
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const who = str10(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const seconds = waitSeconds(str10(values, "timeout"));
    const settle = str10(values, "settle");
    if (settle !== void 0 && (!/^(0|[1-9]\d*)$/.test(settle) || Number(settle) > 300))
      throw new Problem(400, "--settle \u5E94\u4E3A 0\uFF5E300 \u7684\u6574\u6570\u79D2", "usage");
    const api2 = await client11();
    const query = (timeout) => new URLSearchParams({
      as: who,
      timeout: String(timeout),
      ...settle === void 0 ? {} : { settle },
      ...values.all === true ? { all: "1" } : {}
    });
    const result = await longWait(
      seconds,
      (timeout) => api2.get(`/events/wait?${query(timeout)}`),
      () => `atrium events wait --as ${who}`
    );
    const ids = result.events.map((event) => event.id);
    recordNext(
      ids.length ? `\u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}` : `\u7EE7\u7EED\u7B49\uFF1Aatrium events wait --as ${who}`
    );
    if (json) printJson(result);
    else if (!ids.length)
      console.log(
        `${seconds} \u79D2\u5185 ${who} \u6CA1\u6709\u65B0\u4E8B\u4EF6\uFF1Batrium events wait --as ${who}`
      );
    else console.log(result.events.map(eventLine).join("\n"));
    return ids.length ? 0 : 124;
  }
};
var digest = {
  args: "[--as \u8BA2\u9605\u8005] [--since \u65F6\u95F4]",
  about: "\u6309\u4EFB\u52A1\u5408\u5E76\u5C1A\u672A\u786E\u8BA4\u7684\u77E5\u4F1A\u4E8B\u4EF6\uFF1B\u8BFB\u53D6\u540E\u81EA\u52A8\u786E\u8BA4\uFF1B--since \u4F7F\u7528\u5E26\u65F6\u533A\u7684 ISO \u65F6\u95F4",
  options: { as: { type: "string" }, since: { type: "string" } },
  positionals: [0, 0],
  async run({ values, json }) {
    const who = str10(values, "as") ?? defaultSubscriber();
    const since = str10(values, "since");
    if (!who.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    if (since !== void 0 && (!/^\d{4}-\d{2}-\d{2}T/.test(since) || !Number.isFinite(Date.parse(since)) || !/(Z|[+-]\d{2}:\d{2})$/.test(since)))
      throw new Problem(400, "--since \u5E94\u4E3A\u5E26\u65F6\u533A\u7684 ISO \u65F6\u95F4", "usage");
    const query = new URLSearchParams({
      as: who,
      ...since === void 0 ? {} : { since }
    });
    const result = await (await client11()).get(
      `/events/digest?${query}`
    );
    if (json) printJson(result);
    else
      console.log(
        result.items.length ? result.items.map((item) => item.summary).join("\n") : "\u6CA1\u6709\u65B0\u7684\u77E5\u4F1A\u4E8B\u4EF6"
      );
    recordNext(`\u7B49\u8981\u5904\u7406\u7684\u4E8B\uFF1Aatrium events wait --as ${who}`);
  }
};
var ack = {
  args: "\u7F16\u53F7\u2026",
  about: "\u786E\u8BA4\u4E8B\u4EF6\u5DF2\u5904\u7406\uFF08\u7F16\u53F7\u89C1 events wait\uFF09\uFF1B\u786E\u8BA4\u540E\u4E0D\u518D\u6295\u9012\uFF0C\u672A\u786E\u8BA4\u7684\u5904\u7406\u4E2D\u79DF\u7EA6\u5230\u671F\u540E\u91CD\u6295",
  positionals: [1, 500],
  async run({ positionals, json }) {
    const ids = positionals.map((value) => {
      const text = value.replace(/^#/, "");
      if (!/^[1-9]\d*$/.test(text))
        throw new Problem(
          400,
          `\u4E8B\u4EF6\u7F16\u53F7\u5E94\u4E3A\u6B63\u6574\u6570\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
          "usage",
          void 0,
          "atrium events wait"
        );
      return Number(text);
    });
    const result = await (await client11()).post("/events/ack", { ids });
    if (json) printJson(result);
    else
      console.log(
        [
          result.acked.length ? `\u5DF2\u786E\u8BA4 ${result.acked.map((id) => `#${id}`).join(" ")}` : "",
          result.missing.length ? `\u4E0D\u5B58\u5728\u6216\u65E9\u5DF2\u786E\u8BA4\uFF1A${result.missing.map((id) => `#${id}`).join(" ")}` : ""
        ].filter(Boolean).join("\uFF1B")
      );
    recordNext("\u7B49\u4E0B\u4E00\u6279\uFF1Aatrium events wait");
  }
};
var eventCommands = {
  events: list2,
  "events wait": wait2,
  "events digest": digest,
  "events ack": ack
};

// cli/chat.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync10, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join6, resolve as resolve8 } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// server/tasks/secretary-session.ts
import { randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync8, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, isAbsolute, join as join4 } from "node:path";
function secretarySessionFile(tool) {
  return tool === "opencode" ? "opencode-session.json" : "codex-acp.json";
}
function saveJson(file2, value) {
  const temporary = `${file2}.tmp-${randomUUID()}`;
  writeFileSync2(temporary, `${JSON.stringify(value)}
`, { mode: 384 });
  renameSync(temporary, file2);
}
function quarantine(file2) {
  try {
    renameSync(file2, `${file2}.bad-${randomUUID()}`);
    console.warn(`\u79D8\u4E66\u4F1A\u8BDD\u8BB0\u5F55 ${basename(file2)} \u5DF2\u635F\u574F\uFF0C\u5DF2\u79FB\u5F00`);
  } catch {
  }
}
function readJson(file2) {
  let raw;
  try {
    raw = readFileSync8(file2, "utf8");
  } catch {
    return void 0;
  }
  try {
    return JSON.parse(raw);
  } catch {
    quarantine(file2);
    return void 0;
  }
}
function saveSecretarySession(data, session) {
  const directory = join4(data, "secretary");
  mkdirSync2(directory, { recursive: true, mode: 448 });
  saveJson(join4(directory, secretarySessionFile(session.tool)), {
    sessionId: session.sessionId,
    cwd: session.cwd,
    updated_at: Date.now()
  });
  saveJson(join4(directory, "active.json"), { tool: session.tool });
}
function wakeCount(data) {
  const file2 = join4(data, "secretary", "wake-count.json");
  const value = readJson(file2);
  if (!value) return 0;
  if (Number.isInteger(value.count) && value.count >= 0)
    return value.count;
  quarantine(file2);
  return 0;
}
function saveWakeCount(data, count) {
  const directory = join4(data, "secretary");
  mkdirSync2(directory, { recursive: true, mode: 448 });
  saveJson(join4(directory, "wake-count.json"), { count });
}

// cli/acp.ts
var AcpError = class extends Error {
};
function agentEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base))
    if (value !== void 0 && !key.startsWith("HERDR_") && !key.startsWith("CLAUDE_CODE_") && key !== "CLAUDECODE" && !key.startsWith("PI_") && !/_(API_KEY|TOKEN)$/.test(key) && !/^(ANTHROPIC|OPENAI|CLAUDE|GH|GITHUB)_/.test(key) && key !== "NODE_TEST_CONTEXT")
      env[key] = value;
  return env;
}
var AcpConnection = class {
  constructor(command, args, options4, handlers) {
    this.handlers = handlers;
    this.child = spawnCommand(command, args, {
      cwd: options4.cwd,
      env: options4.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4e3);
    });
    this.child.stdin.on("error", () => {
    });
    this.child.on("error", (error) => this.finish(error.message));
    this.child.on(
      "exit",
      (code, signal) => this.finish(
        `${command} \u5DF2\u9000\u51FA\uFF08${signal ?? `\u9000\u51FA\u7801 ${code}`}\uFF09${this.stderr.trim() ? `\uFF1A${this.stderr.trim().split("\n").at(-1)}` : ""}`
      )
    );
  }
  handlers;
  child;
  pending = /* @__PURE__ */ new Map();
  nextId = 1;
  buffer = "";
  stderr = "";
  exited = null;
  get alive() {
    return this.exited === null;
  }
  request(method, params) {
    if (this.exited) return Promise.reject(new AcpError(this.exited));
    const id = this.nextId++;
    return new Promise((resolve10, reject) => {
      this.pending.set(id, {
        resolve: resolve10,
        reject
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    if (!this.exited) this.write({ jsonrpc: "2.0", method, params });
  }
  close() {
    if (this.exited) return;
    if (this.child.pid) killTree(this.child.pid, "SIGTERM");
    else this.child.kill("SIGTERM");
  }
  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}
`);
  }
  finish(reason3) {
    if (this.exited) return;
    this.exited = reason3;
    for (const { reject } of this.pending.values())
      reject(new AcpError(reason3));
    this.pending.clear();
    this.handlers.exit(reason3);
  }
  read(chunk) {
    this.buffer += chunk;
    for (; ; ) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line2 = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line2) continue;
      let message;
      try {
        message = JSON.parse(line2);
      } catch {
        continue;
      }
      if (message.method !== void 0) this.incoming(message);
      else if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error)
          waiter.reject(new AcpError(message.error.message ?? "ACP \u8BF7\u6C42\u5931\u8D25"));
        else waiter.resolve(message.result);
      }
    }
  }
  incoming(message) {
    const { id, method, params } = message;
    if (method === "session/update") {
      const value = params;
      if (value?.update) this.handlers.update(value.sessionId, value.update);
      return;
    }
    if (id === void 0) return;
    if (method === "session/request_permission") {
      this.handlers.permission(params).catch(() => ({ outcome: "cancelled" })).then(
        (outcome) => this.write({ jsonrpc: "2.0", id, result: { outcome } })
      );
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `\u4E0D\u652F\u6301\uFF1A${method}` }
    });
  }
};

// shared/opencode-auth.ts
import { isDeepStrictEqual } from "node:util";
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var nonEmpty = (value) => typeof value === "string" && value.length > 0;
function isApiKeyEntry(entry2) {
  if (!isObject(entry2)) return false;
  if (entry2.type === "api") return nonEmpty(entry2.key);
  if (entry2.type === "wellknown")
    return nonEmpty(entry2.key) && nonEmpty(entry2.token);
  return false;
}
function classify(entry2) {
  if (isApiKeyEntry(entry2)) return void 0;
  if (isObject(entry2) && (entry2.type === "oauth" || "refresh" in entry2 || "tokens" in entry2 || "clientInfo" in entry2 || "codeVerifier" in entry2))
    return "oauth";
  return "uncertain";
}
function secrets(entry2) {
  if (!isObject(entry2)) return [];
  const found = [entry2.refresh, entry2.access, entry2.key];
  if (isObject(entry2.tokens))
    found.push(entry2.tokens.refreshToken, entry2.tokens.accessToken);
  return found.filter(nonEmpty);
}
function copiedFrom(entry2, source) {
  if (source === void 0) return false;
  if (isDeepStrictEqual(entry2, source)) return true;
  const theirs = new Set(secrets(source));
  return secrets(entry2).some((secret) => theirs.has(secret));
}
function parse(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : "\u4E0D\u662F JSON \u5BF9\u8C61";
  } catch {
    return "\u4E0D\u662F\u5408\u6CD5 JSON";
  }
}
function planAuthFile(file2, source, target, previous = []) {
  const problems = [];
  let theirs = {};
  if (source !== void 0) {
    const parsed = parse(source);
    if (typeof parsed === "string")
      return {
        synced: [...previous],
        skipped: [],
        problems: [
          `\u7528\u6237\u7684 opencode ${file2} ${parsed}\uFF0C\u8FD9\u6B21\u4E0D\u540C\u6B65\uFF0C\u79D8\u4E66\u90A3\u4EFD\u4E0D\u52A8`
        ]
      };
    theirs = parsed;
  }
  let ours = {};
  if (target !== void 0) {
    const parsed = parse(target);
    if (typeof parsed === "string")
      problems.push(`\u79D8\u4E66\u7684 ${file2} ${parsed}\uFF0C\u5DF2\u632A\u5F00\u91CD\u5EFA`);
    else ours = parsed;
  }
  const result = {};
  for (const [name, entry2] of Object.entries(ours)) {
    if (previous.includes(name)) continue;
    if (copiedFrom(entry2, theirs[name])) continue;
    result[name] = entry2;
  }
  const synced = [];
  const skipped = [];
  for (const [name, entry2] of Object.entries(theirs)) {
    const reason3 = classify(entry2);
    if (reason3) {
      skipped.push({ name, reason: reason3 });
      continue;
    }
    result[name] = entry2;
    synced.push(name);
  }
  return {
    content: `${JSON.stringify(result, null, 2)}
`,
    synced,
    skipped,
    problems
  };
}
function oauthOnly(plan2) {
  if (plan2.content === void 0) return [];
  const present = parse(plan2.content);
  return plan2.skipped.filter((item) => item.reason === "oauth" && !(item.name in present)).map((item) => item.name);
}
function oauthHint(home, providers, model) {
  const how = `\u8BF7\u7ED9\u79D8\u4E66\u6362\u7528\u6709 API key \u7684\u63D0\u4F9B\u5546\uFF08opencode \u754C\u9762\u91CC /models\uFF09\uFF0C\u6216\u5728\u79D8\u4E66\u76EE\u5F55\u91CC\u5355\u72EC\u767B\u5F55\uFF1AXDG_DATA_HOME=${home} opencode auth login`;
  if (model) {
    const provider = model.split("/", 1)[0];
    if (!providers.includes(provider)) return void 0;
    return `\u79D8\u4E66\u6240\u7528\u6A21\u578B ${model} \u7684\u63D0\u4F9B\u5546 ${provider} \u5728\u4F60\u7684 opencode \u91CC\u53EA\u6709 OAuth \u767B\u5F55\uFF1B\u4E3A\u514D\u5237\u65B0\u4EE4\u724C\u8BA9\u4F60\u81EA\u5DF1\u7684\u767B\u5F55\u5931\u6548\uFF0C\u6CA1\u5E26\u7ED9\u79D8\u4E66\u3002${how}`;
  }
  if (!providers.length) return void 0;
  return `\u8FD9\u4E9B\u63D0\u4F9B\u5546\u5728\u4F60\u7684 opencode \u91CC\u53EA\u6709 OAuth \u767B\u5F55\uFF0C\u6CA1\u5E26\u7ED9\u79D8\u4E66\uFF08\u514D\u5F97\u5237\u65B0\u4EE4\u724C\u8BA9\u4F60\u81EA\u5DF1\u7684\u767B\u5F55\u5931\u6548\uFF09\uFF1A${providers.join("\u3001")}\u3002\u79D8\u4E66\u82E5\u7528\u5B83\u4EEC\u7684\u6A21\u578B\uFF0C${how}`;
}
function mcpHint(home, skipped) {
  if (!skipped.length) return void 0;
  return `\u8FD9\u4E9B MCP \u670D\u52A1\u7684\u767B\u5F55\uFF08OAuth \u6216\u65E0\u6CD5\u5224\u65AD\uFF09\u6CA1\u5E26\u7ED9\u79D8\u4E66\uFF1A${skipped.map((item) => item.name).join("\u3001")}\uFF1B\u79D8\u4E66\u8981\u7528\u65F6\u5728\u79D8\u4E66\u76EE\u5F55\u91CC\u5355\u72EC\u767B\u5F55\uFF1AXDG_DATA_HOME=${home} opencode mcp auth <\u540D\u79F0>`;
}

// cli/opencode-serve.ts
import { randomBytes } from "node:crypto";

// shared/opencode-home.ts
import {
  chmodSync,
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync9,
  realpathSync,
  renameSync as renameSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join5, resolve as resolve7 } from "node:path";
var AUTH_FILES = ["auth.json", "mcp-auth.json"];
var SYNCED = "atrium-synced.json";
function secretaryOpencodeHome(data) {
  return join5(data, "secretary", "opencode-home");
}
function userOpencodeData(env = process.env) {
  return join5(
    resolve7(env.XDG_DATA_HOME || join5(homedir2(), ".local", "share")),
    "opencode"
  );
}
var real = (path6) => existsSync3(path6) ? realpathSync(path6) : path6;
var readText = (path6) => {
  try {
    return readFileSync9(path6, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
};
function readSynced(path6) {
  try {
    const value = JSON.parse(readText(path6) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const result = {};
    for (const [file2, names] of Object.entries(value))
      if (Array.isArray(names))
        result[file2] = names.filter((name) => typeof name === "string");
    return result;
  } catch {
    return {};
  }
}
function prepareOpencodeHome(home, source) {
  const report = {
    written: [],
    oauthOnly: [],
    mcpSkipped: [],
    problems: []
  };
  const target = join5(home, "opencode");
  mkdirSync3(target, { recursive: true, mode: 448 });
  if (real(target) === real(source)) return report;
  const syncedPath = join5(home, SYNCED);
  const synced = readSynced(syncedPath);
  const next = {};
  for (const name of AUTH_FILES) {
    const to = join5(target, name);
    let from;
    try {
      from = readText(join5(source, name));
    } catch (error) {
      report.problems.push(
        `\u8BFB\u4E0D\u4E86\u7528\u6237\u7684 opencode ${name}\uFF08${error.code ?? "\u672A\u77E5\u9519\u8BEF"}\uFF09\uFF0C\u8FD9\u6B21\u4E0D\u540C\u6B65`
      );
      next[name] = synced[name] ?? [];
      continue;
    }
    const current = readText(to);
    const plan2 = planAuthFile(name, from, current, synced[name]);
    report.problems.push(...plan2.problems);
    next[name] = plan2.synced;
    if (name === "auth.json") report.oauthOnly = oauthOnly(plan2);
    else report.mcpSkipped = plan2.skipped;
    if (plan2.content === void 0 || plan2.content === current) continue;
    if (current !== void 0 && plan2.problems.length)
      renameSync2(to, `${to}.bad-${Date.now()}`);
    writeFileSync3(`${to}.tmp`, plan2.content, { mode: 384 });
    chmodSync(`${to}.tmp`, 384);
    renameSync2(`${to}.tmp`, to);
    report.written.push(name);
  }
  writeFileSync3(syncedPath, `${JSON.stringify(next)}
`, { mode: 384 });
  return report;
}
function opencodeEnvironment(base, options4) {
  const env = { ...base, XDG_DATA_HOME: options4.home };
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  if (options4.password) env.OPENCODE_SERVER_PASSWORD = options4.password;
  return env;
}

// cli/opencode-serve.ts
var newPassword = () => randomBytes(24).toString("base64url");
function startOpencodeServe(options4) {
  const command = options4.command ?? "opencode";
  const args = options4.args ?? [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0"
  ];
  const child = spawnCommand(command, args, {
    cwd: options4.cwd,
    env: options4.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  let output3 = "";
  let tail = "";
  const close = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid) killTree(child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  };
  const exited = new Promise((resolve10) => {
    child.on("error", (error) => resolve10(error.message));
    child.on(
      "close",
      (code, signal) => resolve10(
        `${command} serve \u5DF2\u9000\u51FA\uFF08${signal ?? `\u9000\u51FA\u7801 ${code}`}\uFF09${tail.trim() ? `\uFF1A${tail.trim().split("\n").at(-1)}` : ""}`
      )
    );
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    tail = (tail + chunk).slice(-4e3);
  });
  child.stdout.setEncoding("utf8");
  return new Promise((resolve10, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(
        new Error(
          `\u7B49 ${command} serve \u62A5\u51FA\u5730\u5740\u8D85\u65F6${tail.trim() ? `\uFF1A${tail.trim().split("\n").at(-1)}` : ""}`
        )
      );
    }, options4.timeoutMs ?? 3e4);
    const onData = (chunk) => {
      output3 = (output3 + chunk).slice(-4e3);
      const found = /listening on (https?:\/\/[^\s]+)/.exec(output3);
      if (!found) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.resume();
      resolve10({ url: found[1].replace(/\/$/, ""), exited, close });
    };
    child.stdout.on("data", onData);
    void exited.then((reason3) => {
      clearTimeout(timer);
      reject(new Error(reason3));
    });
  });
}
var OpencodeHttpError = class extends Error {
  constructor(status2, message) {
    super(message);
    this.status = status2;
  }
  status;
};
var OpencodeClient = class {
  constructor(url, directory, password) {
    this.url = url;
    this.directory = directory;
    this.auth = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : void 0;
  }
  url;
  directory;
  auth;
  async getSession(id) {
    try {
      return await this.call("GET", `/session/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404)
        return void 0;
      throw error;
    }
  }
  createSession(title) {
    return this.call("POST", "/session", { title });
  }
  /** 会话状态：一轮进行中（含重试等待）为 busy，否则 idle。 */
  async status(id) {
    const all2 = await this.call(
      "GET",
      "/session/status"
    );
    const type = all2?.[id]?.type;
    return type === "busy" || type === "retry" ? "busy" : "idle";
  }
  /** 作为新一轮送入，立即返回；一轮进行中时由 opencode 排在之后。 */
  async prompt(id, text) {
    await this.call("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
      parts: [{ type: "text", text }]
    });
  }
  messages(id, limit) {
    return this.call(
      "GET",
      `/session/${encodeURIComponent(id)}/message`,
      void 0,
      { limit: String(limit) }
    );
  }
  /** 缺省模型（`提供商/模型`）；读不到时 undefined。 */
  async model() {
    try {
      const config = await this.call("GET", "/config");
      return typeof config?.model === "string" ? config.model : void 0;
    } catch {
      return void 0;
    }
  }
  /** 在 attach 的界面里弹提示；不碰输入框。 */
  async toast(message, variant = "info") {
    await this.call("POST", "/tui/show-toast", {
      title: "Atrium",
      message,
      variant
    });
  }
  async call(method, path6, body, query = {}) {
    const search = new URLSearchParams({
      directory: this.directory,
      ...query
    });
    const headers = {};
    if (this.auth) headers.authorization = this.auth;
    if (body !== void 0) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url}${path6}?${search}`, {
      method,
      headers,
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(15e3)
    });
    const text = await response.text();
    if (!response.ok)
      throw new OpencodeHttpError(
        response.status,
        `opencode ${method} ${path6}\uFF1AHTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`
      );
    return text ? JSON.parse(text) : void 0;
  }
};

// cli/secretary-chat.ts
import { setTimeout as delay3 } from "node:timers/promises";

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
function nextWakeCount(count, action2) {
  if (action2 === "user_turn") return 0;
  return action2 === "delivered" ? count + 1 : count;
}

// server/tasks/wake-prompt.ts
function wakePrompt(events) {
  const ids = events.map((event) => event.id);
  const tasks = [
    ...new Set(events.flatMap((event) => event.task ? [event.task] : []))
  ];
  return [
    `\u3010Atrium \u4E8B\u4EF6\u3011${events.length} \u6761\u5F85\u5904\u7406\u4E8B\u4EF6\u5DF2\u9001\u8FBE\uFF08\u7F16\u53F7 ${ids.join("\u3001")}\uFF09\uFF1A`,
    ...events.map((event) => {
      const detail4 = event.detail ?? {};
      const title = typeof detail4.title === "string" ? detail4.title.slice(0, 40) : "";
      const reason3 = typeof detail4.reason === "string" ? detail4.reason.slice(0, 160) : "";
      const pr = typeof detail4.pr_url === "string" ? detail4.pr_url.slice(0, 500) : "";
      return `- ${[
        `#${event.id}`,
        event.task,
        event.kind,
        title,
        event.count > 1 ? `\uFF08\u5408\u5E76 ${event.count} \u6B21\uFF09` : "",
        pr,
        reason3 ? `\xB7 ${reason3}` : ""
      ].filter(Boolean).join(" ")}`;
    }),
    "",
    tasks.length ? `\u770B\u8BE6\u60C5\uFF1A${tasks.map((task) => `atrium task show ${task}`).join("\uFF1B")}` : "\u770B\u8BE6\u60C5\uFF1Aatrium events",
    `\u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}`
  ].join("\n");
}

// cli/secretary-chat.ts
var PEEK_SECONDS = 240;
var DEFAULT_BATCH_MS = 2e3;
var DEFAULT_MAX_WAKEUPS = 10;
var SecretaryChat = class {
  constructor(options4) {
    this.options = options4;
    this.now = options4.now ?? Date.now;
    this.batchMs = options4.batchMs ?? DEFAULT_BATCH_MS;
    this.maxWakeups = options4.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
    this.wakeCount = options4.initialWakeCount ?? 0;
  }
  options;
  sessionId = "";
  replaying = false;
  busy = false;
  closed = false;
  ending = false;
  wakeCount = 0;
  queue = [];
  waiters = /* @__PURE__ */ new Set();
  peekAbort = null;
  exitReason = null;
  tools = /* @__PURE__ */ new Map();
  now;
  batchMs;
  maxWakeups;
  get session() {
    return this.sessionId;
  }
  get running() {
    return this.busy;
  }
  /** 连接层回调：流式更新交给界面；恢复会话时的历史回放不重复显示。 */
  update(sessionId, update) {
    if (this.replaying || this.sessionId && sessionId !== this.sessionId)
      return;
    const content = update.content;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (content?.type === "text" && content.text)
          this.options.view.text(content.text);
        return;
      case "agent_thought_chunk":
        if (content?.type === "text" && content.text)
          this.options.view.thought(content.text);
        return;
      case "tool_call":
      case "tool_call_update": {
        const id = String(update.toolCallId ?? "");
        const title = typeof update.title === "string" && update.title ? update.title : this.tools.get(id) ?? "\u5DE5\u5177";
        this.tools.set(id, title);
        const status2 = typeof update.status === "string" ? update.status : "";
        if (update.sessionUpdate === "tool_call" || status2)
          this.options.view.tool(title, status2 || "pending");
        return;
      }
    }
  }
  permission(request) {
    return this.options.view.permission(request);
  }
  /** Agent 进程退出：结束循环，run() 带原因返回。 */
  exit(reason3) {
    if (!this.closed) this.exitReason = reason3;
    this.closed = true;
    this.poke();
  }
  /** 建立会话：先试恢复上次的，失败就新建。 */
  async start(agent) {
    const { connection, store, cwd } = this.options;
    const previous = this.options.fresh ? void 0 : store.load();
    if (previous && agent.loadSession) {
      this.replaying = true;
      try {
        await connection.request("session/load", {
          sessionId: previous,
          cwd,
          mcpServers: []
        });
        this.sessionId = previous;
      } catch {
      } finally {
        this.replaying = false;
      }
    }
    if (!this.sessionId) {
      const created = await connection.request(
        "session/new",
        { cwd, mcpServers: [] }
      );
      this.sessionId = created.sessionId;
    }
    store.save(this.sessionId);
    return { resumed: this.sessionId === previous };
  }
  /** 用户消息：空闲时立即开一轮，忙时排在本轮之后。 */
  say(text) {
    this.queue.push(text);
    this.poke();
  }
  /** 取消进行中的一轮；返回是否有可取消的。 */
  cancel() {
    if (!this.busy) return false;
    this.options.connection.notify("session/cancel", {
      sessionId: this.sessionId
    });
    return true;
  }
  /** 输入结束：排队的消息送完、当前一轮结束后退出。 */
  end() {
    this.ending = true;
    this.poke();
  }
  close() {
    this.closed = true;
    this.poke();
    this.options.connection.close();
  }
  /** 主循环：用户消息优先；空闲时按唤醒规则把事件送入。返回 Agent 退出原因（正常结束为 null）。 */
  async run() {
    let limited = false;
    while (!this.closed) {
      const message = this.queue.shift();
      if (message !== void 0) {
        this.wakeCount = nextWakeCount(this.wakeCount, "user_turn");
        this.options.onWakeCountChange?.(this.wakeCount);
        limited = false;
        await this.turn(message);
        continue;
      }
      if (this.ending) break;
      const events = await this.peek();
      if (events === null) continue;
      const decision = decideWake({
        events: events.map((event) => ({
          id: event.id,
          queuedAt: event.updated_at
        })),
        now: this.now(),
        batchMs: this.batchMs,
        sessionReady: true,
        turnRunning: this.busy,
        consecutiveWakeups: this.wakeCount,
        maxConsecutiveWakeups: this.maxWakeups
      });
      if (decision.kind === "batching") {
        await Promise.race([
          delay3(Math.max(0, decision.readyAt - this.now())),
          this.poked()
        ]);
      } else if (decision.kind === "limit") {
        if (!limited)
          this.options.view.notice(
            `\u5DF2\u8FDE\u7EED\u81EA\u52A8\u9001\u5165 ${this.maxWakeups} \u6B21\u4E8B\u4EF6\uFF0C\u6682\u505C\u81EA\u52A8\u9001\u5165\uFF1B\u4F60\u53D1\u8BDD\u540E\u7EE7\u7EED\uFF08\u5F85\u5904\u7406\uFF1Aatrium events\uFF09`
          );
        limited = true;
        await this.poked();
      } else if (decision.kind === "send") {
        let delivered;
        try {
          delivered = await this.options.source.deliver(decision.eventIds);
        } catch (error) {
          this.options.view.notice(`\u767B\u8BB0\u9001\u8FBE\u5931\u8D25\uFF1A${message_(error)}`);
          await Promise.race([delay3(5e3), this.poked()]);
          continue;
        }
        if (!delivered.length) continue;
        this.options.view.wake(delivered);
        const ok = await this.turn(wakePrompt(delivered));
        this.wakeCount = nextWakeCount(
          this.wakeCount,
          ok ? "delivered" : "failed"
        );
        this.options.onWakeCountChange?.(this.wakeCount);
      }
    }
    this.peekAbort?.abort();
    return this.exitReason;
  }
  /** 等事件；用户发话或关闭时中止并返回 null。 */
  async peek() {
    const abort = new AbortController();
    this.peekAbort = abort;
    const poked = this.poked().then(() => {
      abort.abort();
      return null;
    });
    const looked = this.options.source.peek(PEEK_SECONDS, abort.signal).catch(async (error) => {
      if (abort.signal.aborted) return null;
      this.options.view.notice(`\u53D6\u4E8B\u4EF6\u5931\u8D25\uFF0C\u7A0D\u540E\u91CD\u8BD5\uFF1A${message_(error)}`);
      await Promise.race([delay3(5e3), poked]);
      return null;
    });
    const result = await Promise.race([looked, poked]);
    abort.abort();
    return result;
  }
  /** 唤醒等待中的主循环（用户发话、输入结束、关闭）。 */
  poke() {
    for (const resolve10 of this.waiters) resolve10();
    this.waiters.clear();
  }
  poked() {
    return new Promise((resolve10) => this.waiters.add(resolve10));
  }
  async turn(text) {
    this.busy = true;
    try {
      const result = await this.options.connection.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }]
      });
      this.options.view.turnEnd(result.stopReason);
      return true;
    } catch (error) {
      if (!this.closed)
        this.options.view.notice(`\u672C\u8F6E\u5931\u8D25\uFF1A${message_(error)}`);
      this.options.view.turnEnd("failed");
      return false;
    } finally {
      this.busy = false;
    }
  }
};
var message_ = (error) => error instanceof Error ? error.message : String(error);

// cli/secretary-serve.ts
import { setTimeout as delay4 } from "node:timers/promises";
var WAKE_PREFIX = "\u3010Atrium \u4E8B\u4EF6\u3011";
var TURN_START_MS = 5e3;
function userTurnSince(messages, since) {
  return messages.some(
    (message) => message.info.role === "user" && (message.info.time?.created ?? 0) > since && !message.parts.some(
      (part) => part.type === "text" && part.text?.startsWith(WAKE_PREFIX)
    )
  );
}
var ServeWaker = class {
  constructor(options4) {
    this.options = options4;
    this.now = options4.now ?? Date.now;
    this.batchMs = options4.batchMs ?? DEFAULT_BATCH_MS;
    this.maxWakeups = options4.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
    this.pollMs = options4.pollMs ?? 1e3;
    this.wakeCount = options4.initialWakeCount ?? 0;
    if (this.wakeCount > 0) this.lastWakeAt = this.now();
  }
  options;
  closed = false;
  wakeCount;
  lastWakeAt = 0;
  waiters = /* @__PURE__ */ new Set();
  peekAbort = null;
  now;
  batchMs;
  maxWakeups;
  pollMs;
  close() {
    this.closed = true;
    this.peekAbort?.abort();
    for (const resolve10 of this.waiters) resolve10();
    this.waiters.clear();
  }
  async run() {
    let limited = false;
    let unavailable = false;
    while (!this.closed) {
      const events = await this.peek();
      if (!events?.length) continue;
      let running;
      try {
        if (this.wakeCount > 0) {
          const recent = await this.options.session.messages(20);
          if (userTurnSince(recent, this.lastWakeAt)) {
            this.wakeCount = nextWakeCount(this.wakeCount, "user_turn");
            this.options.onWakeCountChange?.(this.wakeCount);
            limited = false;
          }
        }
        running = await this.options.session.status() === "busy";
        unavailable = false;
      } catch {
        if (!unavailable)
          this.toast("\u8FDE\u4E0D\u4E0A\u79D8\u4E66\u7684 opencode \u670D\u52A1\uFF0C\u4E8B\u4EF6\u6682\u4E0D\u9001\u5165", "warning");
        unavailable = true;
        await this.sleep(5e3);
        continue;
      }
      const decision = decideWake({
        events: events.map((event) => ({
          id: event.id,
          queuedAt: event.updated_at
        })),
        now: this.now(),
        batchMs: this.batchMs,
        sessionReady: true,
        turnRunning: running,
        consecutiveWakeups: this.wakeCount,
        maxConsecutiveWakeups: this.maxWakeups
      });
      if (decision.kind === "batching")
        await this.sleep(Math.max(0, decision.readyAt - this.now()));
      else if (decision.kind === "busy") await this.sleep(this.pollMs);
      else if (decision.kind === "limit") {
        if (!limited)
          this.toast(
            `\u5DF2\u8FDE\u7EED\u81EA\u52A8\u9001\u5165 ${this.maxWakeups} \u6B21\u4E8B\u4EF6\uFF0C\u6682\u505C\u81EA\u52A8\u9001\u5165\uFF1B\u4F60\u53D1\u8BDD\u540E\u7EE7\u7EED`,
            "warning"
          );
        limited = true;
        await this.sleep(this.pollMs * 2);
      } else if (decision.kind === "send") await this.send(decision.eventIds);
    }
    this.peekAbort?.abort();
  }
  async send(ids) {
    let delivered;
    try {
      delivered = await this.options.source.deliver(ids);
    } catch {
      await this.sleep(5e3);
      return;
    }
    if (!delivered.length) return;
    try {
      await this.options.session.prompt(wakePrompt(delivered));
    } catch {
      this.toast("\u4E8B\u4EF6\u9001\u5165\u79D8\u4E66\u4F1A\u8BDD\u5931\u8D25\uFF0C\u7A0D\u540E\u91CD\u6295", "warning");
      await this.sleep(5e3);
      return;
    }
    this.lastWakeAt = this.now();
    this.wakeCount = nextWakeCount(this.wakeCount, "delivered");
    this.options.onWakeCountChange?.(this.wakeCount);
    this.toast(
      `\u9001\u5165\u4E8B\u4EF6 ${delivered.map((event) => `#${event.id}`).join(" ")}`,
      "info"
    );
    this.options.delivered?.(delivered);
    await this.started(this.lastWakeAt);
  }
  /**
   * prompt_async 立即返回，一轮稍后才开始：等到服务端报 busy 或已经答完，再回主循环判忙闲，
   * 免得这段空档里把新事件当空闲另起一轮（最多等 TURN_START_MS）。
   */
  async started(since) {
    const deadline = this.now() + TURN_START_MS;
    while (!this.closed && this.now() < deadline) {
      try {
        if (await this.options.session.status() === "busy") return;
        const last = (await this.options.session.messages(1)).at(-1);
        if (last?.info.role === "assistant" && (last.info.time?.created ?? 0) >= since)
          return;
      } catch {
        return;
      }
      await this.sleep(this.pollMs);
    }
  }
  toast(message, variant) {
    void this.options.session.toast(message, variant).catch(() => {
    });
  }
  /** 等事件；关闭时中止并返回 null。 */
  async peek() {
    const abort = new AbortController();
    this.peekAbort = abort;
    try {
      return await this.options.source.peek(PEEK_SECONDS, abort.signal);
    } catch {
      if (!this.closed) await this.sleep(5e3);
      return null;
    } finally {
      this.peekAbort = null;
    }
  }
  async sleep(ms) {
    if (this.closed) return;
    let wake = () => {
    };
    const woken = new Promise((resolve10) => wake = resolve10);
    this.waiters.add(wake);
    const abort = new AbortController();
    try {
      await Promise.race([
        delay4(ms, void 0, { signal: abort.signal }).catch(() => {
        }),
        woken
      ]);
    } finally {
      abort.abort();
      this.waiters.delete(wake);
    }
  }
};

// cli/chat.ts
var CHAT_TOOLS = {
  opencode: {
    kind: "acp",
    command: "opencode",
    args: ["acp"],
    native: "opencode"
  },
  kimi: { kind: "planned", note: "\u539F\u751F kimi acp\uFF0C\u540E\u7EED\u63A5\u5165" },
  codex: {
    kind: "acp",
    command: process.execPath,
    args: [
      fileURLToPath(
        import.meta.resolve("@zed-industries/codex-acp/bin/codex-acp.js")
      )
    ]
  },
  claude: { kind: "planned", note: "\u7ECF claude-code-acp \u9002\u914D\u5668\uFF0C\u540E\u7EED\u63A5\u5165" }
};
var SUBSCRIBER = "secretary";
var NEW_SESSION_HINT = "\uFF1B\u65B0\u4F1A\u8BDD\u5148\u8BA9\u79D8\u4E66\u8BFB\u5907\u5FD8\u4E0E\u51B3\u5B9A\u8BB0\u5F55\uFF1Aatrium memo show";
var str11 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
function chatMode(tool) {
  const mode = CHAT_TOOLS[tool];
  if (!mode) {
    const candidate = closest(
      tool,
      Object.keys(CHAT_TOOLS).map((ref5) => ({ ref: ref5, name: ref5 }))
    )[0];
    throw new Problem(
      400,
      `--tool \u4E0D\u8BA4\u8BC6\uFF1A${tool}\uFF1B\u53EF\u9009 ${Object.keys(CHAT_TOOLS).join("\u3001")}`,
      "usage",
      void 0,
      candidate ? `atrium chat --tool ${candidate.ref}` : void 0
    );
  }
  if (mode.kind === "planned")
    throw new Problem(
      409,
      `${tool} \u505A\u79D8\u4E66\u7684\u5BF9\u8BDD\u5C1A\u672A\u63A5\u5165\uFF08${mode.note}\uFF09\uFF1B\u73B0\u5728\u53EF\u7528\uFF1Aatrium chat --tool opencode`,
      "conflict",
      void 0,
      "atrium chat --tool opencode"
    );
  return mode;
}
function sessionStore(data, tool, cwd) {
  const file2 = join6(
    data,
    "secretary",
    tool === "codex" || tool === "opencode" ? secretarySessionFile(tool) : `${tool}-session.json`
  );
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync10(file2, "utf8"));
        return typeof value.sessionId === "string" && value.sessionId ? value.sessionId : void 0;
      } catch {
        return void 0;
      }
    },
    save(sessionId) {
      if (cwd && (tool === "codex" || tool === "opencode"))
        saveSecretarySession(data, { tool, sessionId, cwd });
      else {
        mkdirSync4(join6(data, "secretary"), { recursive: true, mode: 448 });
        writeFileSync4(file2, JSON.stringify({ sessionId }), { mode: 384 });
      }
    }
  };
}
var STATUS3 = {
  pending: "\u5F00\u59CB",
  in_progress: "\u8FDB\u884C\u4E2D",
  completed: "\u5B8C\u6210",
  failed: "\u5931\u8D25"
};
function terminalView(options4) {
  let fresh = true;
  const write = (text) => {
    if (!text) return;
    process.stdout.write(text);
    fresh = text.endsWith("\n");
  };
  const block = (text) => write(`${fresh ? "" : "\n"}${text}
`);
  const dim = (text) => options4.tty ? `\x1B[2m${text}\x1B[22m` : text;
  return {
    text: write,
    thought(chunk) {
      if (options4.tty) write(dim(chunk));
    },
    tool(title, status2) {
      if (status2 === "pending" || status2 === "completed" || status2 === "failed")
        block(
          dim(
            `  \xB7 ${clip(title.split("\n", 1)[0], 100)}\uFF08${STATUS3[status2]}\uFF09`
          )
        );
    },
    wake(events) {
      block(
        [
          `\u2500\u2500 \u9001\u5165\u4E8B\u4EF6 ${events.map((event) => `#${event.id}`).join(" ")} \u2500\u2500`,
          ...events.map((event) => `  ${eventLine(event)}`)
        ].join("\n")
      );
    },
    notice(message) {
      block(`[atrium] ${message}`);
    },
    turnEnd(stopReason) {
      if (stopReason === "cancelled") block("\uFF08\u672C\u8F6E\u5DF2\u53D6\u6D88\uFF09");
      else if (stopReason !== "end_turn" && stopReason !== "failed")
        block(`\uFF08\u672C\u8F6E\u7ED3\u675F\uFF1A${stopReason}\uFF09`);
      else if (!fresh) write("\n");
      options4.prompt();
    },
    async permission(request) {
      const title = request.toolCall.title ?? "\u5DE5\u5177\u8C03\u7528";
      const pick2 = (kind) => request.options.find((option) => option.kind === kind);
      if (options4.allow || !options4.tty) {
        const option = options4.allow ? pick2("allow_once") : pick2("reject_once") ?? pick2("reject_always");
        block(
          `[atrium] \u6743\u9650\u8BF7\u6C42\u300C${title}\u300D\uFF1A${option ? option.name : "\u53D6\u6D88"}\uFF08${options4.allow ? "--allow \u81EA\u52A8\u5141\u8BB8\u4E00\u6B21" : "\u975E\u4EA4\u4E92\uFF0C\u81EA\u52A8\u62D2\u7EDD\uFF1B\u9700\u8981\u65F6\u52A0 --allow"}\uFF09`
        );
        return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
      }
      block(
        [
          `[atrium] \u6743\u9650\u8BF7\u6C42\uFF1A${title}`,
          ...request.options.map(
            (option, index) => `  ${index + 1}. ${option.name}`
          )
        ].join("\n")
      );
      const answer = (await options4.ask("\u9009\u62E9\u7F16\u53F7\uFF08\u56DE\u8F66\u62D2\u7EDD\uFF09\uFF1A")).trim();
      const chosen = request.options[Number(answer) - 1];
      if (chosen) return { outcome: "selected", optionId: chosen.optionId };
      const reject = pick2("reject_once") ?? pick2("reject_always");
      return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    }
  };
}
function eventSource(api2) {
  return {
    peek: async (timeout, signal) => (await api2.get(
      `/events/wait?${new URLSearchParams({ as: SUBSCRIBER, peek: "1", timeout: String(timeout) })}`,
      void 0,
      signal
    )).events,
    deliver: async (ids) => (await api2.post(
      `/events/deliver?as=${SUBSCRIBER}`,
      { ids }
    )).events
  };
}
function secretaryEnvironment(data, password) {
  const home = secretaryOpencodeHome(data);
  const report = prepareOpencodeHome(home, userOpencodeData());
  for (const problem of report.problems) console.error(`[atrium] ${problem}`);
  const mcp = mcpHint(home, report.mcpSkipped);
  if (mcp) console.error(`[atrium] ${mcp}`);
  return {
    env: opencodeEnvironment(agentEnvironment(), { home, password }),
    hint: (model) => oauthHint(home, report.oauthOnly, model)
  };
}
async function runNative(options4) {
  const { api: api2, data, cwd } = options4;
  const password = newPassword();
  const { env, hint } = secretaryEnvironment(data, password);
  let server;
  try {
    server = await startOpencodeServe({ cwd, env });
  } catch (error) {
    throw new Problem(
      503,
      `\u79D8\u4E66\u7684 opencode \u670D\u52A1\u8D77\u4E0D\u6765\uFF08opencode serve\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`,
      "internal",
      void 0,
      "atrium chat --acp"
    );
  }
  const stop2 = () => server.close();
  process.once("exit", stop2);
  let waker;
  let running;
  try {
    const client15 = new OpencodeClient(server.url, cwd, password);
    const warning = hint(await client15.model());
    if (warning) console.error(`[atrium] ${warning}`);
    const store = sessionStore(data, "opencode", cwd);
    const previous = options4.fresh ? void 0 : store.load();
    const resumed = previous !== void 0 && await client15.getSession(previous) !== void 0;
    const session = resumed ? previous : (await client15.createSession("Atrium \u79D8\u4E66")).id;
    store.save(session);
    console.error(
      `\u79D8\u4E66\u4F1A\u8BDD\uFF08opencode \u539F\u751F\u754C\u9762 \xB7 ${resumed ? "\u63A5\u7740\u4E0A\u6B21" : "\u65B0\u4F1A\u8BDD"} ${session}\uFF09\uFF1B\u5F85\u5904\u7406\u4E8B\u4EF6\u5728\u79D8\u4E66\u7A7A\u95F2\u65F6\u4EE5\u300C\u3010Atrium \u4E8B\u4EF6\u3011\u300D\u6D88\u606F\u9001\u5165\uFF0C\u4E0D\u52A8\u8F93\u5165\u6846\uFF1B\u9000\u51FA\u754C\u9762\u5373\u7ED3\u675F${resumed ? "" : NEW_SESSION_HINT}`
    );
    waker = new ServeWaker({
      source: eventSource(api2),
      initialWakeCount: options4.fresh ? 0 : wakeCount(data),
      onWakeCountChange: (count) => saveWakeCount(data, count),
      session: {
        status: () => client15.status(session),
        prompt: (text) => client15.prompt(session, text),
        messages: (limit) => client15.messages(session, limit),
        toast: (message, variant) => client15.toast(message, variant)
      }
    });
    if (options4.fresh) saveWakeCount(data, 0);
    running = waker.run();
    const ignore = () => {
    };
    process.on("SIGINT", ignore);
    const outcome = await new Promise((resolve10) => {
      const child = spawnCommand(
        "opencode",
        ["attach", server.url, "--session", session, "--dir", cwd],
        { cwd, env, stdio: "inherit" }
      );
      child.on("error", (error) => resolve10(error.message));
      child.on(
        "exit",
        (code, signal) => resolve10(
          code === 0 || signal === "SIGINT" || signal === "SIGTERM" ? null : `opencode attach \u5DF2\u9000\u51FA\uFF08${signal ?? `\u9000\u51FA\u7801 ${code}`}\uFF09`
        )
      );
    }).finally(() => process.off("SIGINT", ignore));
    if (outcome) throw new Problem(500, outcome, "internal");
  } finally {
    waker?.close();
    await running;
    server.close();
    process.off("exit", stop2);
  }
}
var chatCommand = {
  args: "[--tool opencode|codex] [--cwd \u76EE\u5F55] [--new] [--acp] [--allow]",
  about: "\u548C\u79D8\u4E66\u5BF9\u8BDD\uFF1Bopencode \u7F3A\u7701\u5F00\u539F\u751F\u754C\u9762\uFF08--acp \u7528 ACP\uFF09\uFF0Ccodex \u7ECF ACP\uFF1B\u7A7A\u95F2\u65F6\u81EA\u52A8\u9001\u5165\u4E8B\u4EF6\uFF0C\u754C\u9762\u5173\u95ED\u540E\u7531\u670D\u52A1\u6062\u590D\u539F\u4F1A\u8BDD\u5904\u7406",
  options: {
    tool: { type: "string" },
    cwd: { type: "string" },
    new: { type: "boolean", default: false },
    acp: { type: "boolean", default: false },
    allow: { type: "boolean", default: false }
  },
  positionals: [0, 0],
  async run({ values }) {
    const tool = str11(values, "tool") ?? process.env.ATRIUM_SECRETARY_TOOL ?? "opencode";
    const mode = chatMode(tool);
    const cwd = resolve8(str11(values, "cwd") ?? process.cwd());
    const data = dataDirectory();
    const { claimSecretary } = await import("./chunk-GZKPZHD7.js");
    const lock = claimSecretary(data);
    if (!lock)
      throw new Problem(
        409,
        "\u79D8\u4E66\u4F1A\u8BDD\u5DF2\u7ECF\u7531\u754C\u9762\u6216\u540E\u53F0\u6062\u590D\u8FDB\u7A0B\u6301\u6709\uFF1B\u7A0D\u540E\u91CD\u8BD5",
        "conflict"
      );
    let activeConnection;
    let activeRl;
    let onInterrupt;
    const cleanup = () => {
      activeConnection?.close();
      lock.release();
    };
    process.once("exit", cleanup);
    try {
      const api2 = await (await import("./chunk-YHCQNRVB.js")).connect();
      const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
      if (mode.native && values.acp !== true) {
        if (tty) {
          await runNative({ api: api2, data, cwd, fresh: values.new === true });
          recordNext("\u518D\u6B21\u6253\u5F00\uFF1Aatrium chat");
          return;
        }
        console.error(
          "\u4E0D\u5728\u7EC8\u7AEF\u91CC\uFF0C\u5F00\u4E0D\u4E86 opencode \u539F\u751F\u754C\u9762\uFF0C\u6539\u7528 ACP \u5BF9\u8BDD\u754C\u9762"
        );
      }
      let rl;
      const view = terminalView({
        tty,
        allow: values.allow === true,
        ask: (question) => new Promise(
          (resolve10) => rl ? rl.question(question, resolve10) : resolve10("")
        ),
        prompt: () => {
          if (tty) rl?.prompt(true);
        }
      });
      let chat;
      let env = agentEnvironment();
      if (mode.native) {
        const secretary = secretaryEnvironment(data);
        env = secretary.env;
        const warning = secretary.hint();
        if (warning) console.error(`[atrium] ${warning}`);
      }
      const connection = new AcpConnection(
        mode.command,
        mode.args,
        {
          cwd,
          env
        },
        {
          update: (sessionId, update) => chat?.update(sessionId, update),
          permission: (request) => view.permission(request),
          exit: (reason4) => chat?.exit(reason4)
        }
      );
      activeConnection = connection;
      chat = new SecretaryChat({
        connection,
        view,
        cwd,
        fresh: values.new === true,
        store: sessionStore(data, tool, cwd),
        initialWakeCount: values.new === true ? 0 : wakeCount(data),
        onWakeCountChange: (count) => saveWakeCount(data, count),
        source: eventSource(api2)
      });
      try {
        const init = await connection.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false
          },
          clientInfo: { name: "atrium", version: "1" }
        });
        const { resumed } = await chat.start({
          loadSession: init.agentCapabilities?.loadSession === true
        });
        if (values.new === true) saveWakeCount(data, 0);
        console.error(
          `\u79D8\u4E66\u4F1A\u8BDD\uFF08${tool} \xB7 ACP \u5BF9\u8BDD\u754C\u9762 \xB7 ${resumed ? "\u63A5\u7740\u4E0A\u6B21" : "\u65B0\u4F1A\u8BDD"} ${chat.session}\uFF09\uFF1B\u5F85\u5904\u7406\u4E8B\u4EF6\u5728\u79D8\u4E66\u7A7A\u95F2\u65F6\u81EA\u52A8\u9001\u5165\u3002Ctrl-C \u53D6\u6D88\u672C\u8F6E\uFF0C\u7A7A\u95F2\u65F6 Ctrl-C \u6216 /exit \u9000\u51FA${resumed ? "" : NEW_SESSION_HINT}`
        );
      } catch (error) {
        connection.close();
        throw new Problem(
          503,
          `\u79D8\u4E66\u4F1A\u8BDD\u542F\u52A8\u5931\u8D25\uFF08${mode.command} ${mode.args.join(" ")}\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`,
          "internal"
        );
      }
      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: tty
      });
      activeRl = rl;
      rl.setPrompt("\u4F60> ");
      const interrupt = () => {
        if (chat.cancel()) view.notice("\u5DF2\u8BF7\u6C42\u53D6\u6D88\u672C\u8F6E");
        else chat.close();
      };
      onInterrupt = interrupt;
      rl.on("SIGINT", interrupt);
      if (!tty) process.on("SIGINT", interrupt);
      rl.on("line", (line2) => {
        const text = line2.trim();
        if (!text) return view.turnEnd("end_turn");
        if (text === "/exit" || text === "/quit") return chat.close();
        if (chat.running) view.notice("\u79D8\u4E66\u6B63\u5728\u5904\u7406\uFF0C\u8FD9\u6761\u6392\u5728\u672C\u8F6E\u4E4B\u540E");
        chat.say(text);
      });
      rl.on("close", () => chat.end());
      view.turnEnd("end_turn");
      const reason3 = await chat.run();
      recordNext("\u518D\u6B21\u6253\u5F00\uFF1Aatrium chat");
      if (reason3)
        throw new Problem(500, `\u79D8\u4E66\u8FDB\u7A0B\u610F\u5916\u7ED3\u675F\uFF1A${reason3}`, "internal");
    } finally {
      activeRl?.close();
      activeConnection?.close();
      if (onInterrupt) process.off("SIGINT", onInterrupt);
      process.off("exit", cleanup);
      lock.release();
    }
  }
};

// cli/reviews.ts
import { existsSync as existsSync4, statSync as statSync3 } from "node:fs";
import { resolve as resolve9 } from "node:path";
var str12 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var client12 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
function ref4(value) {
  if (!value || !/^t[1-9][0-9]*$/.test(value))
    throw new Problem(
      400,
      `\u4F1A\u5BA1\u7528\u8BAE\u9898\u4EFB\u52A1\u7684\u77ED\u53F7\uFF0C\u5982 t1\uFF08\u6536\u5230\uFF1A${value ?? "\u7A7A"}\uFF09`,
      "usage",
      void 0,
      "atrium task ls"
    );
  return value;
}
function existing2(value, flag, kind) {
  const path6 = resolve9(value);
  const stat = existsSync4(path6) ? statSync3(path6) : null;
  if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    throw new Problem(
      400,
      `${flag} \u6307\u5411\u7684${kind === "file" ? "\u6587\u4EF6" : "\u76EE\u5F55"}\u4E0D\u5B58\u5728\uFF1A${path6}`,
      "usage"
    );
  return path6;
}
var indent2 = (text) => text.trim().split("\n").map((line2) => `    ${line2}`).join("\n");
function renderCouncil(view, full = true) {
  const lines = [
    `\u4F1A\u5BA1 ${view.ref}\uFF1A${view.topic}`,
    `\u9636\u6BB5\uFF1A${view.stage_label}${view.status === "failed" || view.status === "blocked" ? `\uFF08\u6C47\u603B\u4EFB\u52A1 ${view.status === "failed" ? "\u5931\u8D25" : "\u53D7\u963B"}\uFF0C\u770B atrium task show ${view.ref}\uFF09` : ""}`,
    `\u6C47\u603B\u4E0E\u62CD\u677F\uFF1A${view.leader ? `${view.leader.name}\uFF08${view.leader.ref}\uFF09\u7684 leader` : "\u79D8\u4E66"}${view.issue ? ` \xB7 issue #${view.issue}${view.comment ? "\uFF08\u7ED3\u8BBA\u540C\u6B65\u4E3A\u8BC4\u8BBA\uFF09" : ""}` : ""}`,
    "",
    "\u5404\u65B9\u610F\u89C1\uFF1A",
    ...view.opinions.flatMap((o) => [
      `  ${o.name}\uFF08${o.ref} \xB7 ${o.task}\uFF09\uFF1A${STANCE_LABEL[o.stance]}${o.reason ? `\u2014\u2014${o.reason}` : ""}`,
      ...full && o.text?.trim() ? [indent2(o.text)] : []
    ])
  ];
  if (view.stage === "closed")
    lines.push(
      "",
      `\u5DF2\u5173\u95ED\uFF1A${view.conclusion ?? "\u8BAE\u9898\u4EFB\u52A1\u5DF2\u53D6\u6D88"}\uFF1B\u8981\u91CD\u8BAE\u53E6\u53D1\u8D77\u4F1A\u5BA1`
    );
  if (view.stage === "decided" || view.stage === "escalated") {
    lines.push("", `\u6C47\u603B\uFF08${view.summary.task}\uFF09\uFF1A`);
    if (view.agreed.length)
      lines.push("  \u4E00\u81F4\uFF1A", ...view.agreed.map((a) => `    - ${a}`));
    if (view.conflicts.length)
      lines.push("  \u51B2\u7A81\uFF1A", ...view.conflicts.map((c) => `    - ${c}`));
    if (full && view.summary.text?.trim() && !view.agreed.length)
      lines.push(indent2(view.summary.text));
    lines.push(`\u7ED3\u8BBA\uFF1A${view.conclusion ?? "\uFF08leader \u6CA1\u5199\u7ED3\u8BBA\uFF09"}`);
    if (view.decided_by && view.decided_by !== "leader")
      lines.push(`\u62CD\u677F\uFF1A${view.decided_by}`);
    if (view.escalate.length)
      lines.push(
        view.stage === "escalated" ? "\u9700\u7528\u6237\u62CD\u677F\uFF1A" : "\u66FE\u4E0A\u4EA4\u7528\u6237\uFF1A",
        ...view.escalate.map((e) => `  - ${e}`)
      );
  }
  return lines.join("\n");
}
var add3 = {
  args: "\u8BAE\u9898 --concerns \u4E13\u5458[,\u4E13\u5458] [--brief \u6587\u4EF6|-] [--issue \u53F7] [--leader \u8282\u70B9] [--repo \u8DEF\u5F84] [--comment] [--part \u8282\u70B9] [--owner \u8BA2\u9605\u8005]",
  about: "\u53D1\u8D77\u4F1A\u5BA1\uFF1A\u5E76\u884C\u7ED9\u6BCF\u4F4D\u53D7\u9080\u4E13\u5458\u6D3E\u4E00\u4E2A\u4E00\u6B21\u6027\u6267\u884C\u8005\u6309\u5404\u81EA\u7AE0\u7A0B\u4E0E\u6E05\u5355\u51FA\u610F\u89C1\uFF0C\u6536\u9F50\u540E leader\uFF08--leader \u8282\u70B9\uFF0C\u7F3A\u7701\u79D8\u4E66\uFF09\u6C47\u603B\u4E00\u81F4\u4E0E\u51B2\u7A81\u3001\u80FD\u5B9A\u7684\u5B9A\uFF0C\u78B0\u5230\u7528\u6237\u8FB9\u754C\u6216\u8C08\u4E0D\u62E2\u7684\u6807\u300C\u9700\u7528\u6237\u62CD\u677F\u300D\u6295\u4E8B\u4EF6\uFF1B\u7ED3\u8BBA\u8BB0\u5728\u8BAE\u9898\u4E0A\uFF0C--comment \u540C\u6B65\u4E3A --issue \u7684\u8BC4\u8BBA",
  options: {
    concerns: { type: "string" },
    brief: { type: "string" },
    issue: { type: "string" },
    leader: { type: "string" },
    repo: { type: "string" },
    comment: { type: "boolean" },
    part: { type: "string" },
    owner: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [topic], values, json }) {
    if (!topic?.trim())
      throw new Problem(
        400,
        "\u8BAE\u9898\u4E0D\u80FD\u4E3A\u7A7A",
        "usage",
        void 0,
        "atrium review add \u8BAE\u9898 --concerns \u524D\u7AEF,\u540E\u7AEF"
      );
    const concerns = str12(values, "concerns");
    if (!concerns?.trim())
      throw new Problem(
        400,
        "--concerns \u81F3\u5C11\u8BF7\u4E00\u4F4D\u4E13\u5458\uFF0C\u5982 \u524D\u7AEF,\u540E\u7AEF",
        "usage",
        void 0,
        "atrium org tree"
      );
    const issueText = str12(values, "issue");
    let issue2;
    if (issueText !== void 0) {
      issue2 = Number(issueText);
      if (!/^[1-9][0-9]*$/.test(issueText) || !Number.isSafeInteger(issue2))
        throw new Problem(400, "--issue \u5E94\u4E3A\u6B63\u6574\u6570 issue \u53F7", "usage");
    }
    const repo = str12(values, "repo");
    const brief = str12(values, "brief");
    if (values.comment === true && (issue2 === void 0 || repo === void 0))
      throw new Problem(
        400,
        "--comment \u9700\u540C\u65F6\u7ED9 --issue <\u53F7> \u4E0E --repo <\u4ED3\u5E93>",
        "usage"
      );
    const body = {
      topic,
      concerns,
      ...brief === void 0 ? {} : await briefInput(brief, (path6) => existing2(path6, "--brief", "file")),
      ...issue2 === void 0 ? {} : { issue: issue2 },
      ...str12(values, "leader") === void 0 ? {} : { leader: str12(values, "leader") },
      ...repo === void 0 ? {} : { repo: existing2(repo, "--repo", "directory") },
      ...values.comment === true ? { comment: true } : {},
      ...str12(values, "part") === void 0 ? {} : { part: str12(values, "part") },
      ...str12(values, "owner") === void 0 ? {} : { owner: str12(values, "owner") }
    };
    const view = await (await client12()).post("/reviews", body);
    if (json) printJson(view);
    else
      console.log(
        [
          `\u5DF2\u53D1\u8D77\u4F1A\u5BA1 ${view.ref}\uFF1A${view.topic}`,
          ...view.opinions.map(
            (o) => `  ${o.name}\uFF08${o.ref}\uFF09\u51FA\u610F\u89C1\uFF1A${o.task} ${o.status === "running" ? "\u5DF2\u6D3E" : o.status === "blocked" ? `\u62C9\u4E0D\u8D77\u6765\uFF1A${o.reason}` : o.status === "todo" ? "\u6392\u961F" : o.status}`
          ),
          `\u610F\u89C1\u6536\u9F50\u540E\u7531${view.leader ? `${view.leader.name}\uFF08${view.leader.ref}\uFF09\u7684 leader` : "\u79D8\u4E66"}\u6C47\u603B\uFF0C\u7ED3\u8BBA\u4E0E\u300C\u9700\u7528\u6237\u62CD\u677F\u300D\u6295\u4E8B\u4EF6`
        ].join("\n")
      );
    recordNext(
      `\u7B49\u7ED3\u8BBA\uFF1Aatrium task wait ${view.ref}\uFF1B\u770B\u610F\u89C1\u4E0E\u7ED3\u8BBA\uFF1Aatrium review show ${view.ref}`
    );
  }
};
var show3 = {
  args: "tN [--brief]",
  about: "\u770B\u4F1A\u5BA1\uFF1A\u5404\u65B9\u610F\u89C1\uFF08\u7ACB\u573A\u4E0E\u539F\u6587\uFF09\u3001\u6C47\u603B\u7684\u4E00\u81F4\u4E0E\u51B2\u7A81\u3001\u7ED3\u8BBA\u3001\u9700\u7528\u6237\u62CD\u677F\u7684\u4E8B\uFF1B--brief \u53EA\u5217\u7ACB\u573A\u4E0D\u5E26\u539F\u6587",
  options: { brief: { type: "boolean", default: false } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref4(reference);
    const view = await (await client12()).get(`/reviews/${id}`);
    if (json) printJson(view);
    else console.log(renderCouncil(view, values.brief !== true));
    recordNext(
      view.stage === "escalated" ? `\u7528\u6237\u62CD\u677F\u540E\u8BB0\u4E0B\uFF1Aatrium review decide ${id} \u7ED3\u8BBA` : view.stage === "decided" ? `\u6309\u7ED3\u8BBA\u5EFA\u540E\u7EED\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --parent ${id}` : view.stage === "closed" ? `\u8981\u91CD\u8BAE\u53E6\u53D1\u8D77\u4F1A\u5BA1\uFF1Aatrium review add \u8BAE\u9898 --concerns \u4E13\u5458` : `\u7B49\u7ED3\u8BBA\uFF1Aatrium task wait ${id}`
    );
  }
};
var decide = {
  args: "tN \u7ED3\u8BBA [--as \u62CD\u677F\u4EBA]",
  about: "\u8BB0\u4E0B\u5BF9\u4F1A\u5BA1\u7684\u62CD\u677F\uFF08\u591A\u7528\u4E8E\u300C\u9700\u7528\u6237\u62CD\u677F\u300D\u7684\u4F1A\u5BA1\uFF09\uFF1A\u9636\u6BB5\u8F6C\u5DF2\u5B9A\uFF0C\u539F\u4E0A\u4EA4\u4E8B\u9879\u4FDD\u7559\uFF1B--as \u7F3A\u7701 u1",
  options: { as: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, conclusion], values, json }) {
    const id = ref4(reference);
    if (!conclusion?.trim()) throw new Problem(400, "\u7ED3\u8BBA\u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const who = str12(values, "as") ?? "u1";
    if (!who.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const view = await (await client12()).post(
      `/reviews/${id}/decide?${new URLSearchParams({ as: who })}`,
      { conclusion }
    );
    if (json) printJson(view);
    else console.log(`\u5DF2\u8BB0\u4E0B ${id} \u7684\u7ED3\u8BBA\uFF08${who} \u62CD\u677F\uFF09\uFF1A${view.conclusion}`);
    recordNext(`\u6309\u7ED3\u8BBA\u5EFA\u540E\u7EED\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --parent ${id}`);
  }
};
var reviewCommands = {
  "review add": add3,
  "review show": show3,
  "review decide": decide
};

// cli/patrol.ts
var str13 = (values, key) => typeof values[key] === "string" ? values[key] : void 0;
var api = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var enc3 = encodeURIComponent;
var statusText = {
  new: "\u5F85\u5904\u7406",
  task: "\u5DF2\u5F00\u4EFB\u52A1",
  merged: "\u5E76\u5165\u4EFB\u52A1",
  ignored: "\u5DF2\u5FFD\u7565"
};
var output2 = (json, result, line2, next) => {
  if (json) printJson(result);
  else console.log(line2);
  recordNext(next);
};
var required = (values, key) => {
  const value = str13(values, key);
  if (!value?.trim()) throw new Problem(400, `--${key}: \u5FC5\u586B`, "usage");
  return value;
};
var patrolCommands = {
  "patrol run": {
    args: "\u8282\u70B9 [--worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]]",
    about: "\u624B\u52A8\u5DE1\u68C0\u8282\u70B9\uFF1A\u4ECE uses \u8F6E\u6362\u4E00\u6761\u573A\u666F\uFF0C\u5728\u5F53\u524D\u771F\u5B9E\u73AF\u5883\u542F\u52A8\u4F53\u9A8C\u5DE1\u68C0\u4EFB\u52A1",
    options: { worker: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const result = await (await api()).post(
        `/patrol/nodes/${enc3(node)}/run`,
        { ...str13(values, "worker") ? { worker: str13(values, "worker") } : {} }
      );
      output2(
        json,
        result,
        `${result.task.ref} \u5DE1\u68C0\u5DF2${result.queued ? "\u6392\u961F" : "\u542F\u52A8"}\uFF1A${result.scenario}`,
        `\u7B49\u5DE1\u68C0\uFF1Aatrium task wait ${result.task.ref}`
      );
    }
  },
  "patrol report": {
    args: "\u5DE1\u68C0\u4EFB\u52A1 --phenomenon \u73B0\u8C61 --step \u6B65\u9AA4 --command \u547D\u4EE4 --expected \u9884\u671F --actual \u5B9E\u9645 --kind broken|awkward",
    about: "\u8BB0\u5F55\u5DE1\u68C0\u53D1\u73B0\uFF1B\u540C\u8282\u70B9\u540C\u4E00\u73B0\u8C61\u53EA\u8BB0\u4E00\u6B21\uFF0C\u5DF2\u5FFD\u7565\u7684\u73B0\u8C61\u4E0D\u518D\u62A5",
    options: Object.fromEntries(
      ["phenomenon", "step", "command", "expected", "actual", "kind"].map(
        (key) => [key, { type: "string" }]
      )
    ),
    positionals: [1, 1],
    async run({ positionals: [task], values, json }) {
      const body = Object.fromEntries(
        ["phenomenon", "step", "command", "expected", "actual", "kind"].map(
          (key) => [key, required(values, key)]
        )
      );
      const result = await (await api()).post(
        `/patrol/tasks/${enc3(task)}/findings`,
        body
      );
      output2(
        json,
        result,
        `${result.finding.ref} ${result.duplicate ? "\u5DF2\u6709\u8BB0\u5F55\uFF0C\u672A\u91CD\u590D\u62A5" : "\u53D1\u73B0\u5DF2\u8BB0\u5F55"}`,
        `\u770B\u5DE1\u68C0\u4EFB\u52A1\uFF1Aatrium task show ${task}`
      );
    }
  },
  "patrol findings": {
    args: "\u8282\u70B9",
    about: "\u67E5\u770B\u8282\u70B9\u4E0A\u7684\u5DE1\u68C0\u53D1\u73B0\u4E0E leader \u5904\u7406\u7ED3\u679C",
    positionals: [1, 1],
    async run({ positionals: [node], json }) {
      const rows = await (await api()).get(`/patrol/nodes/${enc3(node)}/findings`);
      output2(
        json,
        rows,
        rows.length ? rows.map(
          (f) => `${f.ref} ${f.phenomenon}\uFF08${f.kind === "broken" ? "\u574F\u4E86" : "\u4E0D\u987A\u624B"}\uFF09\xB7 ${statusText[f.status] ?? f.status}${f.linked_task ? ` ${f.linked_task}` : ""}${f.reason ? ` \xB7 ${f.reason}` : ""}
  \u6B65\u9AA4\uFF1A${f.step}
  \u547D\u4EE4\uFF1A${f.command}
  \u9884\u671F\uFF1A${f.expected}
  \u5B9E\u9645\uFF1A${f.actual}`
        ).join("\n\n") : "\u8FD8\u6CA1\u6709\u5DE1\u68C0\u53D1\u73B0",
        `\u770B\u5168\u666F\uFF1Aatrium map ${node} --json`
      );
    }
  },
  "patrol decide": {
    args: "\u53D1\u73B0 (--task tN | --merge tN | --ignore \u539F\u56E0)",
    about: "leader \u5904\u7406\u53D1\u73B0\uFF1A\u5F00\u4EFB\u52A1\u540E\u5173\u8054\u3001\u5E76\u5165\u5DF2\u6709\u4EFB\u52A1\uFF0C\u6216\u5FFD\u7565\u5E76\u5199\u539F\u56E0",
    options: {
      task: { type: "string" },
      merge: { type: "string" },
      ignore: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [finding], values, json }) {
      const choices = [
        str13(values, "task"),
        str13(values, "merge"),
        str13(values, "ignore")
      ].filter(Boolean);
      if (choices.length !== 1)
        throw new Problem(
          400,
          "--task\u3001--merge\u3001--ignore \u5FC5\u987B\u4E14\u53EA\u80FD\u7ED9\u4E00\u4E2A",
          "usage"
        );
      const body = str13(values, "task") ? { action: "task", task: str13(values, "task") } : str13(values, "merge") ? { action: "merged", task: str13(values, "merge") } : { action: "ignored", reason: str13(values, "ignore") };
      const result = await (await api()).post(
        `/patrol/findings/${enc3(finding)}/decide`,
        body
      );
      output2(
        json,
        result,
        `${result.ref} \u5DF2\u5904\u7406\uFF1A${statusText[result.status] ?? result.status}`,
        `\u770B\u5904\u7406\u7ED3\u679C\uFF1Aatrium patrol findings ${result.node}`
      );
    }
  }
};

// cli/memos.ts
import { readFileSync as readFileSync11 } from "node:fs";
var str14 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var client13 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var ownerOf = (values) => {
  const who = (str14(values, "as") ?? defaultSubscriber()).trim();
  if (!who) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
  return who;
};
var asFlag = (owner2) => owner2 === "secretary" ? "" : ` --as ${owner2}`;
var whose = (owner2, name) => owner2 === "secretary" ? "\u79D8\u4E66" : `${owner2}${name ? `\uFF08${name}\uFF09` : ""}`;
var afterVerb = (owner2, name) => owner2 === "secretary" ? "\u79D8\u4E66" : ` ${whose(owner2, name)}`;
function memoText(view) {
  const size = Array.from(view.memo).length;
  return [
    `${whose(view.owner, view.name)}\u7684\u5907\u5FD8\uFF08${size}/${view.memo_max} \u5B57${view.memo_updated_at ? ` \xB7 ${when(view.memo_updated_at)} \u66F4\u65B0` : ""}\uFF09\uFF1A`,
    view.memo || "\uFF08\u7A7A\uFF09",
    "",
    `\u6709\u6548\u7684\u51B3\u5B9A\uFF08${view.active} \u6761${view.superseded ? `\uFF0C\u53E6\u6709\u5DF2\u63A8\u7FFB ${view.superseded} \u6761` : ""}\uFF0C\u65B0\u7684\u5728\u524D\uFF09\uFF1A`,
    ...view.decisions.length ? view.decisions.map((d) => `- ${decisionLine(d)}`) : ["\uFF08\u8FD8\u6CA1\u6709\uFF09"]
  ].join("\n");
}
var memoCommands = {
  "memo show": {
    args: "[--as secretary|aN]",
    about: "\u770B\u79D8\u4E66\u6216 leader \u7684\u5907\u5FD8\u4E0E\u5168\u90E8\u6709\u6548\u7684\u51B3\u5B9A\uFF08\u65B0\u4F1A\u8BDD\u3001\u6362\u4EBA\u63A5\u624B\u5148\u8DD1\u8FD9\u4E00\u6761\uFF09\uFF1B\u7F3A\u7701\u79D8\u4E66\uFF0Cleader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u81EA\u5DF1",
    options: { as: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const owner2 = ownerOf(values);
      const view = await (await client13()).get(`/memo?as=${encodeURIComponent(owner2)}`);
      if (json) printJson(view);
      else console.log(memoText(view));
      recordNext(
        view.next_before ? `\u5F80\u4E0B\u770B\uFF1Aatrium decision ls${asFlag(view.owner)} --before ${view.next_before}` : `\u6539\u5907\u5FD8\uFF1Aatrium memo edit \u6587\u672C${asFlag(view.owner)}`
      );
    }
  },
  "memo edit": {
    args: "[\u6587\u672C] [--file \u6587\u4EF6] [--as secretary|aN]",
    about: "\u8986\u76D6\u5199\u5907\u5FD8\uFF1A\u5728\u7B49\u4EC0\u4E48\u3001\u4E0B\u6B21\u5148\u770B\u4EC0\u4E48\u8FD9\u7C7B\u5F53\u524D\u72B6\u6001\uFF08\u6709\u957F\u5EA6\u4E0A\u9650\uFF0C\u8D85\u4E86\u5148\u7CBE\u7B80\uFF09\uFF1B\u53D6\u820D\u4E0E\u539F\u56E0\u8BB0\u8FDB decision add",
    options: { as: { type: "string" }, file: { type: "string" } },
    positionals: [0, 1],
    async run({ positionals: [text], values, json }) {
      const file2 = str14(values, "file");
      if (text === void 0 === (file2 === void 0))
        throw new Problem(
          400,
          "\u5907\u5FD8\u6B63\u6587\u7ED9\u4E00\u79CD\uFF1A\u76F4\u63A5\u5199\u6587\u672C\uFF0C\u6216 --file \u6587\u4EF6",
          "usage"
        );
      let memo = text;
      if (file2 !== void 0) {
        try {
          memo = readFileSync11(file2, "utf8");
        } catch {
          throw new Problem(400, `--file: \u8BFB\u4E0D\u5230 ${file2}`, "usage");
        }
      }
      const owner2 = ownerOf(values);
      const view = await (await client13()).put(`/memo?as=${encodeURIComponent(owner2)}`, { memo });
      if (json) printJson(view);
      else
        console.log(
          `\u5DF2\u66F4\u65B0${afterVerb(view.owner, view.name)}\u7684\u5907\u5FD8\uFF08${Array.from(view.memo).length}/${view.memo_max} \u5B57\uFF09`
        );
      recordNext(`\u770B\uFF1Aatrium memo show${asFlag(view.owner)}`);
    }
  },
  "decision add": {
    args: "\u51B3\u5B9A --why \u539F\u56E0 [--by u1|secretary|aN] [--date \u65E5\u671F] [--issue \u53F7] [--node \u8282\u70B9] [--task tN] [--supersedes dN] [--as secretary|aN]",
    about: "\u8FFD\u52A0\u4E00\u6761\u51B3\u5B9A\u8BB0\u5F55\uFF08\u8C01\u62CD\u677F\u3001\u51B3\u5B9A\u3001\u539F\u56E0\uFF0C\u53EF\u5173\u8054 issue\u3001\u8282\u70B9\u3001\u4EFB\u52A1\uFF09\uFF1B--by \u7F3A\u7701\u662F\u8BB0\u5F55\u7684\u4E3B\u4EBA\uFF0C\u8865\u8BB0\u65E7\u51B3\u5B9A\u7528 --date\uFF1B--supersedes \u540C\u65F6\u628A\u65E7\u51B3\u5B9A\u6807\u4E3A\u5DF2\u63A8\u7FFB",
    options: {
      why: { type: "string" },
      by: { type: "string" },
      date: { type: "string" },
      issue: { type: "string" },
      node: { type: "string" },
      task: { type: "string" },
      supersedes: { type: "string" },
      as: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [text], values, json }) {
      const owner2 = ownerOf(values);
      const body = { text };
      for (const key of [
        "why",
        "by",
        "date",
        "issue",
        "node",
        "task",
        "supersedes"
      ])
        if (str14(values, key) !== void 0) body[key] = str14(values, key);
      if (body.why === void 0)
        throw new Problem(400, "--why: \u539F\u56E0\u5FC5\u586B", "usage");
      const decision = await (await client13()).post(`/decisions?as=${encodeURIComponent(owner2)}`, body);
      if (json) printJson(decision);
      else
        console.log(
          `\u5DF2\u8BB0\u4E0B ${decision.ref}\uFF08${whose(decision.owner)}\u7684\u51B3\u5B9A\u8BB0\u5F55\uFF09
${decisionLine(decision)}`
        );
      recordNext(`\u770B\u5168\u90E8\u6709\u6548\u7684\uFF1Aatrium decision ls${asFlag(decision.owner)}`);
    }
  },
  "decision ls": {
    args: "[--as secretary|aN] [--all] [--before dN] [--limit \u6761\u6570]",
    about: "\u5217\u51B3\u5B9A\u8BB0\u5F55\uFF0C\u65E5\u671F\u65B0\u7684\u5728\u524D\uFF1B\u7F3A\u7701\u53EA\u5217\u6709\u6548\u7684\uFF0C--all \u8FDE\u5DF2\u63A8\u7FFB\u7684\u4E00\u8D77\u5217\uFF1B--before \u63A5\u7740\u4E0A\u4E00\u9875\u5F80\u4E0B",
    options: {
      as: { type: "string" },
      all: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const owner2 = ownerOf(values);
      const query = new URLSearchParams({ as: owner2 });
      if (values.all === true) query.set("all", "1");
      for (const key of ["before", "limit"])
        if (str14(values, key) !== void 0) query.set(key, str14(values, key));
      const page = await (await client13()).get(`/decisions?${query}`);
      if (json) printJson(page);
      else
        console.log(
          [
            `${whose(page.owner)}\u7684\u51B3\u5B9A\u8BB0\u5F55\uFF1A\u6709\u6548 ${page.active} \u6761\uFF0C\u5DF2\u63A8\u7FFB ${page.superseded} \u6761${values.all === true ? "" : "\uFF08\u53EA\u5217\u6709\u6548\u7684\uFF09"}`,
            ...page.decisions.map((d) => `- ${decisionLine(d)}`)
          ].join("\n")
        );
      recordNext(
        page.next_before ? `\u5F80\u4E0B\u770B\uFF1Aatrium decision ls${asFlag(page.owner)}${values.all === true ? " --all" : ""} --before ${page.next_before}` : `\u8BB0\u4E00\u6761\uFF1Aatrium decision add \u51B3\u5B9A --why \u539F\u56E0${asFlag(page.owner)}`
      );
    }
  },
  "decision supersede": {
    args: "dN --by dM [--as secretary|aN]",
    about: "\u628A\u65E7\u51B3\u5B9A dN \u6807\u4E3A\u5DF2\u63A8\u7FFB\u3001\u6307\u5411\u65B0\u51B3\u5B9A dM\uFF08\u4E24\u6761\u987B\u5728\u540C\u4E00\u4EFD\u8BB0\u5F55\u91CC\u4E14\u90FD\u8FD8\u6709\u6548\uFF09\uFF1B\u4E4B\u540E decision ls \u7F3A\u7701\u4E0D\u518D\u5217 dN",
    options: { by: { type: "string" }, as: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [old], values, json }) {
      const by = str14(values, "by");
      if (!by)
        throw new Problem(
          400,
          "--by: \u88AB\u54EA\u6761\u65B0\u51B3\u5B9A\u63A8\u7FFB\uFF0C\u5982 d5\uFF08\u8FD8\u6CA1\u8BB0\u5C31\u5148 atrium decision add\uFF09",
          "usage"
        );
      const owner2 = ownerOf(values);
      const result = await (await client13()).post(
        `/decisions/${encodeURIComponent(old)}/supersede?as=${encodeURIComponent(owner2)}`,
        { by }
      );
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u6807 ${result.old.ref} \u4E3A\u5DF2\u63A8\u7FFB\uFF0C\u6307\u5411 ${result.next.ref}
- ${decisionLine(result.next)}`
        );
      recordNext(`\u770B\u5168\u90E8\u6709\u6548\u7684\uFF1Aatrium decision ls${asFlag(owner2)}`);
    }
  }
};

// cli/hosts.ts
var str15 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var strs3 = (values, key) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};
var client14 = async () => (await import("./chunk-YHCQNRVB.js")).connect();
var enc4 = encodeURIComponent;
var HOST_REF = /^h[1-9][0-9]{0,8}$/;
function hostRef(value) {
  if (!value || !HOST_REF.test(value))
    throw new Problem(
      400,
      `\u4E3B\u673A\u5E94\u4E3A\u77ED\u53F7\uFF0C\u5982 h2\uFF08\u6536\u5230\uFF1A${value ?? ""}\uFF09`,
      "usage",
      void 0,
      "atrium host ls"
    );
  return value;
}
function clisText(clis) {
  const names = Object.entries(clis ?? {}).filter(([, cli]) => cli.installed).map(
    ([tool, cli]) => cli.logged_in === false ? `${tool}\uFF08\u672A\u767B\u5F55\uFF09` : cli.logged_in === null ? `${tool}?` : tool
  );
  return names.join(" ") || "\uFF08\u6CA1\u88C5\uFF09";
}
var machine = (view) => view.info ? `${view.info.os}/${view.info.arch} ${view.info.cpus} \u6838 ${Math.round(view.info.mem_mb / 1024)}G` : "\u2014";
var reposText = (view) => view.kind === "local" ? "\u5168\u90E8" : view.repos.includes("*") ? "\u5168\u90E8" : view.repos.join(" ") || "\u53EA\u63A5\u6CA1\u6709\u4ED3\u5E93\u7684\u6D3B\uFF08\u7528 --repo \u767B\u8BB0\uFF09";
function hostTable(hosts) {
  return table([
    ["\u77ED\u53F7", "\u540D\u79F0", "\u72B6\u6001", "\u673A\u5668", "\u7F16\u7801 CLI", "\u5728\u8DD1", "\u81EA\u52A8\u6D3E\u54EA\u4E9B\u4ED3\u5E93"],
    ...hosts.map((view) => [
      view.ref,
      view.name,
      view.status,
      machine(view),
      clisText(view.info?.clis),
      `${view.running}/${view.max ?? "\u4E0D\u9650"}`,
      reposText(view)
    ])
  ]);
}
function detail3(view) {
  return [
    `${view.ref} ${view.name} \xB7 ${view.status}`,
    `\u673A\u5668\uFF1A${view.info ? `${view.info.hostname} \xB7 ${machine(view)} \xB7 Node ${view.info.node} \xB7 Atrium ${view.info.version}` : "\u8FD8\u6CA1\u4E0A\u62A5"}`,
    ...view.info && view.kind === "remote" ? [`\u4EE3\u7406\u6570\u636E\u76EE\u5F55\uFF1A${view.info.data_dir}`] : [],
    `\u7F16\u7801 CLI\uFF1A${clisText(view.info?.clis)}`,
    `\u5728\u8DD1 ${view.running}/${view.max ?? "\u4E0D\u9650"}${view.load ? ` \xB7 \u8D1F\u8F7D ${view.load.load}${view.load.busy ? ` \xB7 ${view.load.busy}` : ""}` : ""}`,
    `\u81EA\u52A8\u6D3E\u54EA\u4E9B\u4ED3\u5E93\uFF1A${reposText(view)}`,
    ...view.last_seen_at ? [`\u6700\u8FD1\u5FC3\u8DF3\uFF1A${when(view.last_seen_at)}`] : [],
    ...view.tasks?.length ? [
      "\u5728\u8DD1\u7684\u4EFB\u52A1\uFF1A",
      ...view.tasks.map((task) => `  ${task.ref} ${task.title}`)
    ] : []
  ].join("\n");
}
var serviceAddress = async () => {
  const { servicePort } = await import("./chunk-2SXZRFCM.js");
  return `http://127.0.0.1:${servicePort()}`;
};
var hostCommands = {
  "host ls": {
    args: "[--all]",
    about: "\u5217\u51FA\u6267\u884C\u673A\u5668\uFF1A\u672C\u673A h1 \u4E0E\u63A5\u5165\u7684\u8FDC\u7A0B\u4E3B\u673A\uFF0C\u72B6\u6001\u3001\u7F16\u7801 CLI\u3001\u5728\u8DD1\u51E0\u4EF6\u3001\u81EA\u52A8\u6D3E\u54EA\u4E9B\u4ED3\u5E93\uFF1B--all \u8FDE\u5DF2\u79FB\u9664\u7684",
    options: { all: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (await client14()).get(
        `/hosts${values.all === true ? "?all=1" : ""}`
      );
      if (json) printJson(result);
      else console.log(hostTable(result.hosts));
      recordNext(
        result.hosts.some((host) => host.kind === "remote") ? "\u6D3E\u5230\u67D0\u53F0\uFF1Aatrium task run tN --host h2" : "\u63A5\u5165\u4E00\u53F0\uFF1Aatrium host add \u540D\u79F0 --repo owner/name"
      );
    }
  },
  "host show": {
    args: "hN",
    about: "\u770B\u4E00\u53F0\u6267\u884C\u673A\u5668\uFF1A\u7CFB\u7EDF\u3001\u7F16\u7801 CLI\u3001\u8D1F\u8F7D\u3001\u6700\u8FD1\u5FC3\u8DF3\u3001\u5728\u8DD1\u7684\u4EFB\u52A1",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const view = await (await client14()).get(
        `/hosts/${enc4(hostRef(reference))}`
      );
      if (json) printJson(view);
      else console.log(detail3(view));
      recordNext(`\u6D3E\u6D3B\u5230\u8FD9\u53F0\uFF1Aatrium task run tN --host ${view.ref}`);
    }
  },
  "host add": {
    args: "\u540D\u79F0 [--repo owner/name|*]\u2026 [--max \u6570\u91CF]",
    about: "\u767B\u8BB0\u4E00\u53F0\u8FDC\u7A0B\u6267\u884C\u673A\u5668\uFF0C\u7ED9\u51FA\u4E00\u6B21\u6027\u63A5\u5165\u7801\uFF0830 \u5206\u949F\u5185\u6709\u6548\uFF09\u4E0E\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u8981\u8FD0\u884C\u7684 atrium agent \u547D\u4EE4\uFF1B--repo \u767B\u8BB0\u81EA\u52A8\u6D3E\u6D3B\u65F6\u80FD\u63A5\u7684\u4ED3\u5E93\uFF08* \u5168\u90E8\uFF1B\u4E0D\u5199\u53EA\u81EA\u52A8\u63A5\u6CA1\u6709\u4ED3\u5E93\u7684\u6D3B\uFF0C--host \u6307\u5B9A\u65F6\u4E0D\u53D7\u9650\uFF09\uFF0C--max \u540C\u65F6\u6700\u591A\u8DD1\u51E0\u4EF6\uFF08\u7F3A\u7701\u6309\u90A3\u53F0\u7684\u6838\u6570\uFF09",
    options: {
      repo: { type: "string", multiple: true },
      max: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      const maxText = str15(values, "max");
      if (maxText !== void 0 && !/^[1-9][0-9]?$/.test(maxText))
        throw new Problem(
          400,
          `--max \u5E94\u4E3A 1 \u5230 64 \u7684\u6574\u6570\uFF08\u6536\u5230\uFF1A${maxText}\uFF09`,
          "usage"
        );
      const result = await (await client14()).post("/hosts", {
        name,
        repos: strs3(values, "repo"),
        ...maxText !== void 0 ? { max: Number(maxText) } : {}
      });
      const address = await serviceAddress();
      const command = `atrium agent --server ${address} --token ${result.code}`;
      if (json) printJson({ ...result, command });
      else
        console.log(
          [
            `\u5DF2\u767B\u8BB0 ${result.host.ref} ${result.host.name}\uFF08\u5F85\u63A5\u5165\uFF1B\u63A5\u5165\u7801 30 \u5206\u949F\u5185\u6709\u6548\uFF0C\u53EA\u80FD\u7528\u4E00\u6B21\uFF09`,
            "\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u88C5\u597D Node 24+ \u4E0E Atrium \u540E\u8FD0\u884C\uFF1A",
            `  ${command}`,
            `\u670D\u52A1\u5730\u5740\u8981\u6362\u6210\u90A3\u53F0\u673A\u5668\u8FDE\u5F97\u5230\u7684\uFF1A\u672C\u673A\u670D\u52A1\u53EA\u542C ${address}\uFF0C\u8DE8\u673A\u5668\u7ECF SSH \u8F6C\u53D1\uFF08ssh -R\uFF09\u3001\u5185\u7F51\u7A7F\u900F\u6216 VPN \u8FDE\u8FC7\u6765\uFF1BOrbStack \u865A\u62DF\u673A\u91CC\u7528 http://host.orb.internal:${new URL(address).port}`
          ].join("\n")
        );
      recordNext(`\u63A5\u5165\u540E\u67E5\u770B\uFF1Aatrium host show ${result.host.ref}`);
    }
  },
  "host remove": {
    args: "hN",
    about: "\u79FB\u9664\u8FDC\u7A0B\u6267\u884C\u673A\u5668\uFF1A\u4EE4\u724C\u4F5C\u5E9F\uFF0C\u77ED\u53F7\u4FDD\u7559\u4E0D\u590D\u7528\uFF1B\u4E0A\u9762\u8FD8\u6709\u5728\u8DD1\u7684\u4EFB\u52A1\u65F6\u62D2\u7EDD",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (await client14()).delete(`/hosts/${enc4(hostRef(reference))}`);
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u79FB\u9664 ${result.host.ref} ${result.host.name}\uFF1B\u90A3\u53F0\u673A\u5668\u4E0A\u7684 atrium agent \u4F1A\u56E0\u4EE4\u724C\u5931\u6548\u9000\u51FA`
        );
      recordNext("\u770B\u5269\u4E0B\u7684\uFF1Aatrium host ls");
    }
  },
  "host pause": {
    args: "hN",
    about: "\u6682\u505C\u5F80\u8FD9\u53F0\u6D3E\u65B0\u6D3B\uFF08\u5728\u8DD1\u7684\u7167\u8DD1\uFF09\uFF1B\u672C\u673A h1 \u4E5F\u53EF\u4EE5\u6682\u505C\uFF0C\u8BA9\u6D3B\u53EA\u53BB\u8FDC\u7A0B",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (await client14()).post(`/hosts/${enc4(hostRef(reference))}/pause`, {
        paused: true
      });
      if (json) printJson(result);
      else
        console.log(
          `${result.host.ref} ${result.host.name} \u5DF2\u6682\u505C\u63A5\u6D3B\uFF1B\u5728\u8DD1\u7684\u7167\u8DD1`
        );
      recordNext(`\u6062\u590D\uFF1Aatrium host resume ${result.host.ref}`);
    }
  },
  "host resume": {
    args: "hN",
    about: "\u6062\u590D\u5F80\u8FD9\u53F0\u6D3E\u6D3B\uFF1B\u6392\u7740\u7684\u6D3B\u4F1A\u6309\u987A\u5E8F\u62C9\u8D77",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (await client14()).post(`/hosts/${enc4(hostRef(reference))}/pause`, {
        paused: false
      });
      if (json) printJson(result);
      else console.log(`${result.host.ref} ${result.host.name} \u5DF2\u6062\u590D\u63A5\u6D3B`);
      recordNext("\u770B\u4E3B\u673A\uFF1Aatrium host ls");
    }
  }
};
var agentCommand = {
  args: "--server <\u670D\u52A1\u5730\u5740> [--token <\u63A5\u5165\u7801>]",
  about: "\u5728\u8FDC\u7A0B\u673A\u5668\u4E0A\u8FD0\u884C\uFF1A\u63A5\u5165 Atrium \u670D\u52A1\u5E76\u9886\u6D3E\u7ED9\u8FD9\u53F0\u7684\u6D3B\uFF08\u524D\u53F0\u5E38\u9A7B\uFF0CCtrl-C \u505C\uFF1B\u6267\u884C\u8005\u4E0D\u968F\u5B83\u9000\u51FA\uFF0C\u518D\u8D77\u6765\u63A5\u7740\u770B\uFF09\uFF1B\u9996\u6B21\u7528 host add \u7ED9\u7684\u63A5\u5165\u7801\uFF0C\u4E4B\u540E\u53EA\u8981 --server\u3002\u6570\u636E\u5728 ~/.atrium-agent\uFF08ATRIUM_AGENT_DATA \u53EF\u6539\uFF09",
  options: {
    server: { type: "string" },
    token: { type: "string" }
  },
  positionals: [0, 0],
  async run({ values }) {
    const server = str15(values, "server");
    if (!server)
      throw new Problem(
        400,
        "--server \u5FC5\u586B\uFF1AAtrium \u670D\u52A1\u7684\u5730\u5740\uFF0C\u5982 http://127.0.0.1:4310\uFF08\u8DE8\u673A\u5668\u65F6\u662F\u8F6C\u53D1\u6216 VPN \u540E\u7684\u5730\u5740\uFF09",
        "usage"
      );
    const { runAgent } = await import("./chunk-35ASC7SW.js");
    return runAgent({ server, code: str15(values, "token") });
  }
};

// cli/guide.ts
var groups = {
  \u670D\u52A1: ["status", "stop", "restart", "update", "auth status", "auth rotate"],
  \u4EFB\u52A1: [
    "quota",
    "top",
    "statusline",
    "task add",
    "task ls",
    "task plan",
    "task show",
    "task tree",
    "task set",
    "task note",
    "task tell",
    "task pick",
    "task run",
    "task done",
    "task stop",
    "task merge",
    "task log",
    "task wait",
    "patrol run",
    "patrol report",
    "patrol findings",
    "patrol decide",
    "review add",
    "review show",
    "review decide",
    "events",
    "events wait",
    "events digest",
    "events ack",
    "chat"
  ],
  \u6267\u884C\u673A\u5668: [
    "host ls",
    "host show",
    "host add",
    "host remove",
    "host pause",
    "host resume",
    "agent"
  ],
  \u4E13\u5458: [
    "specialist ls",
    "specialist show",
    "specialist add",
    "specialist edit",
    "workers",
    "workers show",
    "workers ls",
    "workers edit",
    "workers confirm"
  ],
  \u5168\u666F: ["map", "map context", "map edit", "map add"],
  "\u76EE\u6807\uFF08\u8FC1\u79FB\u540E\u4E0B\u7EBF\uFF09": [
    "goal tree",
    "goal show",
    "goal add",
    "goal edit",
    "goal check",
    "goal done",
    "goal drop",
    "goal adopt"
  ],
  \u7EC4\u7EC7: [
    "org tree",
    "org show",
    "org add",
    "org edit",
    "org point-add",
    "org point-edit",
    "org point-rm",
    "org stages",
    "org history",
    "org revert",
    "org import",
    "org link-roles",
    "org migrate-goals",
    "leader ls",
    "leader show",
    "leader add",
    "leader edit",
    "leader escalate"
  ],
  \u5907\u5FD8\u4E0E\u51B3\u5B9A: [
    "memo show",
    "memo edit",
    "decision add",
    "decision ls",
    "decision supersede"
  ],
  \u6280\u80FD: [
    "skill ls",
    "skill show",
    "skill add",
    "skill edit",
    "skill history",
    "skill revert",
    "skill bind",
    "skill unbind",
    "skill proposals",
    "skill proposal",
    "skill accept",
    "skill reject"
  ]
};
function groupOf(name) {
  return Object.entries(groups).find(([, members]) => members.includes(name))?.[0] ?? "\u670D\u52A1";
}
function example(name, command) {
  if (name === "task add") return "atrium task add \u62C6\u5206\u767B\u5F55\u6A21\u5757 --parent t1";
  if (name === "task set") return "atrium task set t1 --status done";
  if (name === "task pick") return "atrium task pick t1 --risk medium";
  if (name === "task run")
    return "atrium task run t1 --worker codex+gpt-6-sol:high";
  if (name === "patrol run") return "atrium patrol run o4";
  if (name === "host add")
    return "atrium host add \u4E66\u623F\u53F0\u5F0F\u673A --repo liu-zhengdong/atrium --max 4";
  if (name === "agent")
    return "atrium agent --server http://host.orb.internal:4310 --token h2-\u63A5\u5165\u7801";
  if (name === "patrol report")
    return "atrium patrol report t1 --phenomenon \u5E2E\u52A9\u7F3A\u5C11\u793A\u4F8B --step \u7B2C\u4E00\u6B65 --command atrium-guide --expected \u6709\u793A\u4F8B --actual \u6CA1\u6709\u793A\u4F8B --kind awkward";
  if (name === "patrol decide")
    return "atrium patrol decide f1 --ignore \u5DF2\u6709\u540C\u7C7B\u6539\u8FDB\u8BA1\u5212";
  if (name === "events ack") return "atrium events ack 12 13";
  if (name === "review add")
    return "atrium review add \u516C\u5F00\u4ED3\u5E93 --concerns \u524D\u7AEF,\u540E\u7AEF --brief \u8BAE\u9898.md --issue 322";
  if (name === "review decide")
    return "atrium review decide t1 \u5148\u4E0D\u516C\u5F00\uFF0C\u7B49\u51ED\u636E\u6E05\u7406\u5B8C";
  if (name === "workers edit")
    return "atrium workers edit combos/codex+gpt-6-sol --trust medium --reason \u8FDE\u7EED\u4E94\u6B21\u4E00\u6B21\u901A\u8FC7";
  if (name === "workers show") return "atrium workers show harness/codex";
  if (name === "map") return "atrium map atrium --depth 2";
  if (name === "map edit")
    return "atrium map edit atrium/cli --what \u4E00\u53E5\u8BDD --uses \u573A\u666F\u4E00 --uses \u573A\u666F\u4E8C --now \u73B0\u72B6";
  if (name === "map add")
    return "atrium map add atrium \u5F85\u529E\u672C --slug ledger --analogy \u56E2\u961F\u7684\u4EFB\u52A1\u767D\u677F";
  if (name === "org point-add")
    return "atrium org point-add atrium/runtime \u4E0D\u91C7\u4FE1\u6267\u884C\u8005\u81EA\u8FF0 --why \u4E8B\u5B9E\u7531\u8FD0\u884C\u65F6\u67E5 --by u1\uFF0809-27\uFF09";
  if (name === "org stages")
    return "atrium org stages atrium --file \u9636\u6BB5.yaml --reason \u7B2C\u4E8C\u9636\u6BB5\u5B8C\u6210";
  if (name === "leader add")
    return "atrium leader add Atrium\u8D1F\u8D23\u4EBA --worker claude+opus:high";
  if (name === "leader edit")
    return "atrium leader edit a1 --memo \u5728\u7B49t5\u5408\u5165\uFF0C\u5408\u5165\u540E\u4E0A\u4EA4\u5DF2\u4E0A\u7EBF";
  if (name === "leader escalate")
    return "atrium leader escalate \u7EC4\u7EC7\u6811\u5DF2\u4E0A\u7EBF\uFF0C\u7AEF\u5230\u7AEF\uFF1Aatrium-org-tree\u663E\u793Aleader --kind shipped --task t5";
  if (name === "memo edit")
    return "atrium memo edit \u5728\u7B49t5\u5408\u5165\uFF0C\u5408\u5165\u540E\u5148\u770B\u7EBF\u4E0A\u9A8C\u8BC1 --as a1";
  if (name === "decision add")
    return "atrium decision add \u989D\u5EA6\u8BFB\u53D6\u4E0D\u4F9D\u8D56OpenQuota --why \u8981\u8FC1\u5230\u522B\u7684\u8BBE\u5907 --by u1 --issue 352";
  if (name === "decision supersede")
    return "atrium decision supersede d1 --by d3";
  if (name === "goal add")
    return "atrium goal add \u7EC4\u7EC7\u6811\u53EF\u7528 --parent g1 --node atrium --criteria \u6761\u76EE";
  if (name === "goal check")
    return "atrium goal check g2 --item 2 --pass --note \u5DF2\u5408\u5165";
  if (name === "goal drop") return "atrium goal drop g2 --reason \u4E0D\u518D\u9700\u8981";
  if (name === "goal adopt") return "atrium goal adopt t21 --parent g1";
  const sample = command.args.split("[")[0].replace(/\S+…/g, "\u7532").replace(/序号/g, "1").replace(/\btN\b/g, "t1").trim();
  return `atrium ${name}${sample ? ` ${sample}` : ""}`;
}
function guide(commands2) {
  const codes = Object.entries(exitCodes).map(([code, exit]) => `  ${exit}  ${code}`).join("\n");
  const reference = Object.entries(commands2).map(
    ([name, command]) => `atrium ${name} ${command.args}`.trimEnd() + `
  ${command.about}
  \u793A\u4F8B\uFF1A${example(name, command)}`
  ).join("\n");
  return `Atrium \u547D\u4EE4\u884C\u8BF4\u660E\u4E66

\u8C03\u7528\u7EA6\u5B9A
  \u4EFB\u52A1\u7528 t1\uFF0C\u7EC4\u7EC7\u8282\u70B9\u7528 o1\uFF08\u65E7\u76EE\u6807\u4E0E\u91CC\u7A0B\u7891 g1 \u8FC1\u4E3A\u8282\u70B9\u9636\u6BB5\u8BB0\u5F55\u7684 id\uFF09\uFF0C\u7528\u6237\u7528 u1\uFF0C\u7EC4\u7EC7\u8282\u70B9 leader \u7528 a1\u3002
  task/events \u7684 --as \u662F\u4E8B\u4EF6\u8BA2\u9605\u8005\u540D\uFF0Cmemo/decision \u7684 --as \u662F\u8BB0\u5F55\u7684\u4E3B\u4EBA\uFF0C\u90FD\u7F3A\u7701 secretary\uFF08leader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u662F\u81EA\u5DF1\u7684 aN\uFF09\uFF1Borg/skill/goal \u7684 --as \u662F u1 \u6216\u67D0\u4E2A\u8282\u70B9 leader \u7684 aN\uFF0C\u7F3A\u7701 u1\uFF1B\u6280\u80FD\u4FEE\u8BA2\u63D0\u8BAE\u7528 p1\u3002
  \u6240\u6709\u547D\u4EE4\u652F\u6301 --json\uFF1A\u6210\u529F {"ok":true,"result":\u63A5\u53E3\u7ED3\u679C,"next":\u4E0B\u4E00\u6B65\u547D\u4EE4\u6216null}\uFF1B\u5931\u8D25 {"ok":false,"error":{"code","message","candidates"?},"next":\u4FEE\u6B63\u547D\u4EE4\u6216null}\u3002\u53EA\u5728 stdout \u5199\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u63D0\u793A\u5728 stderr\u3002
  \u6587\u672C\u56DE\u6267\u6700\u540E\u4E00\u884C\u662F\u300C\u52A8\u4F5C\uFF1Aatrium \u547D\u4EE4\u300D\uFF0C\u6CA1\u6709\u4E0B\u4E00\u6B65\u5219\u7701\u7565\u3002
  \u9000\u51FA\u7801\u4E0E code\uFF1A
  0  \u6210\u529F
${codes}

\u5E38\u89C1\u4EFB\u52A1
  \u4EE4\u724C\u5931\u6548\uFF1Aatrium auth rotate\uFF08\u4F7F\u7528\u5F53\u524D ATRIUM_DATA\uFF09\u3002
  \u6570\u636E\u76EE\u5F55\u4E0E\u7AEF\u53E3\uFF1A\u9ED8\u8BA4\u6570\u636E ~/.atrium\uFF0C\u7528 ATRIUM_DATA \u6539\uFF1B\u524D\u4E00\u4EE3\u6570\u636E ~/.pi/atrium/data \u5DF2\u5F52\u6863\u4E0D\u518D\u4F7F\u7528\u3002\u7AEF\u53E3\u88AB\u53E6\u4E00\u4EFD\u6570\u636E\u7684 Atrium \u5360\u7740\u65F6\u56DE\u6267\u7ED9\u51FA\u5B83\u7684\u6570\u636E\u76EE\u5F55\uFF0C\u8981\u7528\u5B83\u5C31\u8BBE ATRIUM_DATA=\u90A3\u4E2A\u76EE\u5F55\uFF1B\u88AB\u522B\u7684\u7A0B\u5E8F\u5360\u7740\u5C31\u6362 ATRIUM_PORT
  \u62C6\u4EFB\u52A1\u770B\u5168\u8C8C\uFF1Aatrium task add \u76EE\u6807\uFF1Batrium task add \u5B50\u4EFB\u52A1 --parent t1\uFF1Batrium task tree t1\uFF1B\u4EBA\u5DE5\u6536\u5C3E\uFF1Aatrium task set t2 --status done
  \u6D3E\u6D3B\u524D\u770B\u5019\u9009\uFF1Aatrium task pick t2\uFF08\u5019\u9009\u6267\u884C\u8005\u3001\u80FD\u4E0D\u80FD\u63A5\u3001\u8D26\u53F7\u989D\u5EA6\u3001\u6B63\u5FD9\u3001\u5728\u5E72\u6D3B\u7684\u4E13\u5458\u4E0B\u7684\u4EA4\u4ED8\u8BB0\u5F55\uFF0C\u6700\u4E0A\u9762\u662F\u63A8\u8350\u4E0E\u7406\u7531\uFF09\uFF1B\u53EA\u770B\u989D\u5EA6\uFF1Aatrium quota\uFF1B\u4EBA\u5DE5\u89E3\u9664\u8BEF\u5224\u5360\u7528\uFF1Aatrium quota --clear claude
  leader \u5C42\uFF1Aatrium leader add \u540D\u79F0 --worker claude+opus \u767B\u8BB0\uFF0Catrium org edit \u8282\u70B9 --leader a1 \u6307\u6D3E\uFF1B\u4EFB\u52A1\u6CA1\u5199 --owner \u65F6\u4E8B\u4EF6\u6295\u7ED9\u5F52\u5C5E\u90E8\u5206\u6700\u8FD1\u7684 leader\uFF08\u4E8B\u4EF6 routed \u5199\u660E\u6295\u7ED9\u8C01\u3001\u4E3A\u4EC0\u4E48\uFF09\uFF0C\u627E\u4E0D\u5230\u6295\u79D8\u4E66\uFF1Bleader \u6709\u8981\u5904\u7406\u7684\u4E8B\u4EF6\u65F6\u6512\u6279 30 \u79D2\u3001\u8D77\u4E00\u6B21\u6027\u8FDB\u7A0B\u5904\u7406\u5E76\u786E\u8BA4\uFF0C\u8FDE\u7EED\u5931\u8D25\u6216\u8D85\u65F6\u8F6C\u4EA4\u79D8\u4E66\uFF1Bleader \u53EA\u80FD\u52A8\u8D1F\u8D23\u7684\u8282\u70B9\u53CA\u5B50\u8282\u70B9\uFF08\u8D8A\u6743\u62A5 leader_scope\uFF09\uFF0C\u53EA\u628A\u56DB\u7C7B\u4E8B\u4E0A\u4EA4\uFF1Aatrium leader escalate \u8BF4\u660E --kind shipped|cross|beyond|stuck [--task tN]\uFF1B\u770B leader\uFF1Aatrium leader ls\u3001atrium top
  \u5907\u5FD8\u4E0E\u51B3\u5B9A\u8BB0\u5F55\uFF1A\u79D8\u4E66\uFF08secretary\uFF09\u4E0E\u6BCF\u4F4D leader \u5404\u6709\u4E00\u4EFD\u5907\u5FD8\uFF08atrium memo edit \u6587\u672C [--as aN]\uFF0C\u8986\u76D6\u5199\u3001\u81F3\u591A 2000 \u5B57\uFF0C\u5199\u5728\u7B49\u4EC0\u4E48\u3001\u4E0B\u6B21\u5148\u770B\u4EC0\u4E48\uFF09\u548C\u51B3\u5B9A\u8BB0\u5F55\uFF08atrium decision add \u51B3\u5B9A --why \u539F\u56E0 [--by u1] [--issue N]\uFF0C\u8FFD\u52A0\uFF0C\u77ED\u53F7 dN\uFF1B\u63A8\u7FFB\u7528 atrium decision supersede dN --by dM\uFF0Cdecision ls \u7F3A\u7701\u53EA\u5217\u6709\u6548\u7684\uFF0C--all \u5168\u5217\uFF09\uFF1B\u65B0\u4F1A\u8BDD\u6216\u6362\u4EBA\u63A5\u624B\u5148\u8DD1 atrium memo show [--as aN]\uFF1Bleader \u5524\u9192\u65F6\u81EA\u52A8\u9644\u81EA\u5DF1\u7684\u5907\u5FD8\u4E0E\u6700\u8FD1\u7684\u51B3\u5B9A\uFF1B\u548C\u8981\u70B9\u7684\u533A\u522B\uFF1A\u8981\u70B9\u662F\u6267\u884C\u8005\u8981\u5B88\u7684\u7EA6\u675F\uFF0C\u51B3\u5B9A\u8BB0\u5F55\u662F\u7ED9\u81EA\u5DF1\u56DE\u770B\u7684\u53D6\u820D\u4E0E\u539F\u56E0
  \u770B\u5168\u666F\uFF1A\u4EBA\u7528\u7F51\u9875\uFF0Catrium map \u6253\u5F00\u672C\u673A\u5168\u666F\u7F51\u9875\uFF08\u4E00\u6B21\u6027\u767B\u5F55\u94FE\u63A5\u3001\u53EA\u8BFB\u3001\u5B9E\u65F6\u5237\u65B0\uFF09\uFF1BAgent \u7528\u547D\u4EE4\u884C\uFF0Catrium map o2 --json \u8BFB\u4E00\u5757\uFF08\u4EBA\u8BDD\u5B57\u6BB5\u3001\u7EC4\u6210\u3001\u9636\u6BB5\u3001\u5728\u8DD1\u4EFB\u52A1\u3001\u5DE1\u68C0\u53D1\u73B0\uFF0C\u4E0E\u7F51\u9875\u540C\u4E00\u63A5\u53E3\uFF09\uFF0Catrium map context o2 \u662F\u6D3E\u6D3B\u65F6\u81EA\u52A8\u9644\u8FDB\u63D0\u793A\u8BCD\u7684\u5168\u666F\u4F4D\u7F6E\u4E0E\u8981\u70B9\uFF08\u6709\u957F\u5EA6\u4E0A\u9650\uFF09\uFF1B\u6539\u53EA\u8D70\u547D\u4EE4\u884C\uFF1Aatrium map edit o2 --what \u4E00\u53E5\u8BDD --uses \u573A\u666F --flow \u6B65\u9AA4 --now \u73B0\u72B6\uFF0Catrium map add o2 \u540D\u79F0 --analogy \u7C7B\u6BD4\uFF1B\u4E13\u5458\u6E05\u5355\uFF1Aatrium specialist ls
  \u4F53\u9A8C\u5DE1\u68C0\uFF1Aatrium patrol run o4 \u624B\u52A8\u5DE1\u68C0\u4E00\u6761 uses \u573A\u666F\uFF08\u9010\u6B21\u8F6E\u6362\uFF09\uFF1B\u5DE1\u68C0\u8FDB\u7A0B\u53EA\u8BFB\u5168\u666F\u3001\u5E2E\u52A9\u548C\u56DE\u6267\uFF0C\u7528\u5F53\u524D\u670D\u52A1\u4E0E\u771F\u5B9E\u6570\u636E\uFF0C\u4E0D\u8BFB\u4EE3\u7801\uFF1B\u53D1\u73B0\u7528 atrium patrol report tN \u8BB0\u5F55\uFF0C\u540C\u8282\u70B9\u540C\u73B0\u8C61\u53BB\u91CD\uFF1B\u7ED3\u675F\u540E\u65B0\u589E\u53D1\u73B0\u6295\u7ED9\u8BE5\u8282\u70B9 leader\uFF1Bleader \u7528 atrium patrol decide fN --task tN \u6216 --merge tN \u6216 --ignore \u539F\u56E0\uFF1Batrium patrol findings o4 \u4E0E\u5168\u666F\u53EF\u770B\u5904\u7406\u7ED3\u679C
  \u5168\u666F\u56FE\uFF1Aatrium org show o2 \u5148\u8BB2\u4EBA\u8BDD\uFF08\u662F\u4EC0\u4E48\u3001\u80FD\u505A\u4EC0\u4E48\u3001\u4E00\u4EF6\u4E8B\u600E\u4E48\u8D70\u5B8C\u3001\u7531\u54EA\u51E0\u90E8\u5206\u7EC4\u6210\u3001\u73B0\u5728\u505A\u5230\u54EA\uFF09\uFF0C--detail \u5C55\u5F00\u7AE0\u7A0B\u6B63\u6587\u3001\u786C\u8FB9\u754C\u3001\u9884\u7B97\u7B49\u7EC6\u8282\uFF1B\u4EBA\u8BDD\u5B57\u6BB5\u5199\u5728\u7AE0\u7A0B frontmatter\uFF1Awhat\u3001uses\u3001flow\u3001alias\uFF08\u4EBA\u8BDD\u540D\uFF09\u3001analogy\uFF08\u7C7B\u6BD4\uFF09\u3001now\u3001next\u3001stages\uFF08\u9636\u6BB5\u8BB0\u5F55\uFF09\uFF1B\u8981\u70B9\uFF08\u5FC5\u987B\u5B88\u4F4F\u7684\u8BBE\u8BA1\u7EA6\u675F\uFF0C\u4E0D\u7559\u4FEE\u8BA2\uFF09\uFF1Aatrium org point-add atrium/runtime \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by 'u1 09-27' --check 'tests/x.test.ts \u7528\u4F8B\u540D'\uFF0Catrium org point-edit k1 --check ''\uFF0Catrium org point-rm k1\uFF1B\u5DF2\u6709\u90E8\u5206\u6539\u7C7B\u578B\uFF08\u53EA\u5207\u300C\u7BA1\u65B9\u9762\u300D\u6807\u8BB0\uFF0C\u7559\u8282\u70B9\u4FEE\u8BA2\uFF0Cproject/org \u4E0D\u80FD\u6539\u6210 aspect\uFF0C\u6539\u56DE module \u524D\u8981\u5148\u6E05\u6389\u9002\u7528\u8303\u56F4\uFF09\uFF1Aatrium org edit \u8282\u70B9 --kind aspect|module\uFF1B\u4EFB\u52A1\u5F52\u5C5E\u54EA\u4E00\u90E8\u5206\uFF1Aatrium task add \u6807\u9898 --part atrium/runtime
  \u4F1A\u5BA1\uFF1A\u5F71\u54CD\u9762\u5927\u3001\u4E0D\u53EF\u64A4\u56DE\u7684\u51B3\u5B9A\u6216\u7591\u96BE\u4E8B\u6545\uFF0Catrium review add \u8BAE\u9898 --concerns \u524D\u7AEF,\u540E\u7AEF --brief \u8BAE\u9898.md [--issue \u53F7 --repo \u4ED3\u5E93 --comment] [--leader \u8282\u70B9]\uFF1B\u6BCF\u4F4D\u4E13\u5458\u5E76\u884C\u51FA\u610F\u89C1\uFF08\u6700\u540E\u4E00\u884C\u300C\u610F\u89C1\uFF1A\u540C\u610F\uFF0F\u6709\u6761\u4EF6\u540C\u610F\uFF0F\u53CD\u5BF9\uFF0F\u5426\u51B3\u300D\uFF09\uFF0C\u6536\u9F50\u540E leader\uFF08\u7F3A\u7701\u79D8\u4E66\uFF09\u6C47\u603B\u4E00\u81F4\u4E0E\u51B2\u7A81\u3001\u80FD\u5B9A\u7684\u5B9A\uFF0C\u78B0\u5230\u7528\u6237\u8FB9\u754C\u3001\u8C08\u4E0D\u62E2\u6216\u6709\u4E13\u5458\u4EE5\u5E95\u7EBF\u5426\u51B3\u7684\u6807\u300C\u9700\u7528\u6237\u62CD\u677F\u300D\uFF1B\u7ED3\u5C40\u6295 council_decided / council_escalated \u4E8B\u4EF6\uFF1Batrium task wait t1 \u7B49\u7ED3\u8BBA\uFF0Catrium review show t1 \u770B\u610F\u89C1\u4E0E\u7ED3\u8BBA\uFF0C\u7528\u6237\u62CD\u677F\u540E atrium review decide t1 \u7ED3\u8BBA
  \u5E72\u6D3B\u4E0E\u8BF7\u770B\uFF1Aatrium task add \u6807\u9898 --by \u524D\u7AEF --ask \u540E\u7AEF\uFF08\u6D3E\u6D3B\u9644\u68C0\u67E5\u8981\u70B9\uFF0C\u4EA4\u4ED8\u540E\u5EFA\u5BA1\u67E5\u5B50\u4EFB\u52A1\u6309\u6E05\u5355\u5BA1\uFF0C\u5168\u90E8\u901A\u8FC7\u624D\u5B8C\u6210\u3001\u4EFB\u4E00\u5426\u51B3\u5373\u5361\u4F4F\u5E76\u5199\u539F\u56E0\uFF1B\u4E13\u5458\u7684 invite_when \u5199\u63D0\u793A\u89C4\u5219\uFF0C\u53EA\u63D0\u793A\u4E0D\u81EA\u52A8\u8BF7\uFF09
  \u76EE\u6807\u6811\u8FC1\u79FB\uFF1Aatrium org migrate-goals \u9884\u89C8 gN \u8FC1\u4E3A\u6240\u5728\u8282\u70B9\u7684\u9636\u6BB5\u8BB0\u5F55\u3001\u4EFB\u52A1\u6309\u76EE\u6807\u56DE\u586B\u5F52\u5C5E\u90E8\u5206\uFF0C\u52A0 --apply \u5148\u6574\u5E93\u5907\u4EFD\u518D\u5199\u5165\uFF1B\u5199\u5165\u540E goal \u547D\u4EE4\u4E0B\u7EBF\uFF0C\u65E7\u5199\u6CD5 --goal gN \u6309\u6620\u5C04\u843D\u5230\u8282\u70B9
  \u770B\u7EC4\u7EC7\uFF1Aatrium org tree\uFF1Batrium org show o2\uFF1B\u6811\u4E3A\u7A7A\u65F6\u5148 atrium org import --repo \u4ED3\u5E93 \u9884\u89C8\u3001\u52A0 --apply \u5199\u5165
  \u7EC4\u7EC7\u6280\u80FD\uFF1Aatrium skill add web-design ./web-design --reason \u539F\u56E0\uFF1Batrium skill bind web-design atrium/web\uFF1B\u6267\u884C\u8005\u6539\u4E86\u6302\u8F7D\u526F\u672C\u4F1A\u751F\u6210\u63D0\u8BAE\uFF1Aatrium skill proposals\uFF1Batrium skill accept p1
  \u770B\u8C01\u5728\u5E72\u4EC0\u4E48\uFF1Aatrium top\uFF08\u9ED8\u8BA4\u6BCF 2 \u79D2\u5168\u5C4F\u5237\u65B0\uFF0Cq \u9000\u51FA\uFF1B\u53EA\u6253\u4E00\u6B21\u7528 --once\uFF0C\u811A\u672C\u7528 --once --json\uFF09
  \u6D3E\u6D3B\u5E76\u7B49\u7ED3\u679C\uFF1Aatrium task run t2\uFF08\u4E0D\u5199 --worker \u4E0E task pick \u540C\u4E00\u4EFD\u6392\u5E8F\u6311\u4EBA\uFF0C\u56DE\u6267\u5199\u7406\u7531\uFF1B\u5199\u6B7B\u7684\u6267\u884C\u8005\u989D\u5EA6\u660E\u663E\u66F4\u7D27\u65F6\u56DE\u6267\u63D0\u9192\uFF09\uFF1B\u6025\u4E8B\uFF1Aatrium task run t2 --urgent \u6216 atrium task set t2 --urgent\uFF08\u8DF3\u8FC7\u672C\u673A\u8D1F\u8F7D\u4E0E\u6267\u884C\u8005\u4E0A\u9650\uFF0C\u6392\u961F\u4E0E\u672C\u5730\u68C0\u67E5\u63D2\u5230\u6700\u524D\uFF1B\u989D\u5EA6\u4FDD\u7559\u3001trust\u3001\u4F9D\u8D56\u7167\u65E7\uFF09\uFF1B\u7BA1\u65B9\u9762\u7684\u90E8\u5206\uFF08\u6027\u80FD\u3001\u5B89\u5168\u2026\uFF09\u5F00\u7684\u4EFB\u52A1\u7F3A\u7701\u95F2\u65F6\uFF1A\u6392\u5728\u666E\u901A\u4EFB\u52A1\u540E\u9762\uFF0C\u6709\u7A7A\u95F2\u6267\u884C\u8005\u624D\u6D3E\uFF0C\u6392\u961F\u4E2D\u5199\u300C\u7B49\u7A7A\u95F2\uFF1A\u524D\u9762\u8FD8\u6709 N \u4EF6\u666E\u901A\u4EFB\u52A1\u300D\uFF1B\u8981\u7167\u5E38\u6392\u7528 atrium task set t2 --priority \u666E\u901A\uFF08\u5EFA\u4EFB\u52A1\u65F6 --priority \u95F2\u65F6|\u666E\u901A\uFF09\uFF1Batrium task run t2 --worker opencode\uFF1B\u6267\u884C\u8005\u5199\u4F5C \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]\uFF0C\u5DE5\u5177\u6709 claude\u3001codex\u3001opencode\u3001kimi\u3001grok\u3001agy\uFF08Antigravity\uFF1Aagy \u7F3A\u7701 claude-opus-4-6-thinking\uFF0Cgemini \u7528\u5E26\u5F3A\u5EA6\u7684\u6A21\u578B\u540D\u5982 agy+gemini-3.8-flash-high \u6216\u57FA\u540D\u52A0\u5F3A\u5EA6 agy+gemini-3.8-flash:high\uFF0Cclaude-*\u3001gpt-oss-* \u4E0D\u6536\u5F3A\u5EA6\uFF1B\u53EF\u9009\u6A21\u578B\u770B agy models\uFF09\u3001cursor\uFF08Cursor CLI \u7684 cursor-agent\uFF1A\u7F3A\u7701 auto\uFF0C\u5F3A\u5EA6\u5199\u8FDB\u6A21\u578B\u540D\u540E\u7F00\u5982 cursor+gpt-5.3-codex:high\uFF0Cauto \u4E0D\u6536\u5F3A\u5EA6\uFF09\uFF1Batrium task wait t2\uFF1Batrium task log t2 --follow
  \u7B49\u4E8B\u4EF6\uFF1Aatrium events \u67E5\u770B\u9001\u8FBE\u4E0E\u786E\u8BA4\u72B6\u6001\uFF1Batrium events wait --as secretary \u53EA\u53D6\u8981\u5904\u7406\u7684\u4E8B\uFF0C\u9996\u6761\u540E\u6512\u6279 30 \u79D2\uFF08--settle \u53EF\u8C03\uFF09\uFF0C--all \u53D6\u5168\u90E8\uFF1Batrium events digest \u8BFB\u77E5\u4F1A\u6458\u8981\u5E76\u81EA\u52A8\u786E\u8BA4\uFF1B\u5904\u7406\u5B8C atrium events ack 12\uFF1B\u53D6\u8D70\u7684\u4E8B\u4EF6\u5904\u7406\u4E2D 15 \u5206\u949F\u5185\u4E0D\u91CD\u6295\uFF08ATRIUM_EVENT_LEASE_MINUTES \u53EF\u8C03\uFF09\uFF0C\u5230\u70B9\u4ECD\u672A\u786E\u8BA4\u624D\u91CD\u6295\uFF1B\u81EA\u5DF1 task stop \u5F15\u51FA\u7684\u4E8B\u4EF6\u4E0D\u6295\u7ED9\u81EA\u5DF1
  \u6267\u884C\u673A\u5668\uFF08\u8FDC\u7A0B\u6267\u884C\u8005\uFF09\uFF1A\u672C\u673A\u662F h1\uFF1Batrium host add \u540D\u79F0 --repo owner/name \u767B\u8BB0\u4E00\u53F0\uFF0C\u6309\u56DE\u6267\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u8FD0\u884C atrium agent --server \u670D\u52A1\u5730\u5740 --token \u63A5\u5165\u7801\uFF08\u90A3\u53F0\u4E3B\u52A8\u8FDE\u670D\u52A1\uFF0C\u4E0D\u7528\u5F00\u5165\u7AD9\u7AEF\u53E3\uFF1B\u5730\u5740\u7ECF SSH \u8F6C\u53D1\u3001\u5185\u7F51\u7A7F\u900F\u6216 VPN \u901A\uFF09\uFF1Batrium host ls \u770B\u5404\u53F0\u72B6\u6001\uFF1Batrium task run t2 --host h2 \u6D3E\u5230\u6307\u5B9A\u7684\u4E00\u53F0\uFF0C\u4E0D\u5199 --host \u5728\u80FD\u63A5\u7684\u4E3B\u673A\u91CC\u6311\u6700\u7A7A\u7684\uFF08\u8FDC\u7A0B\u4E3B\u673A\u53EA\u81EA\u52A8\u63A5 --repo \u767B\u8BB0\u8FC7\u7684\u4ED3\u5E93\uFF09\uFF1B\u65AD\u7EBF\u671F\u95F4\u6267\u884C\u8005\u7167\u8DD1\uFF0C\u91CD\u8FDE\u540E\u8865\u4F20\u65E5\u5FD7\u4E0E\u7ED3\u679C\uFF1Batrium host pause h2 \u6682\u505C\u5F80\u90A3\u53F0\u6D3E\u6D3B
  \u91CD\u542F\u4E0E\u5347\u7EA7\uFF1Aatrium restart\uFF08\u968F\u65F6\u53EF\u505A\uFF0C\u5728\u8DD1\u7684\u6267\u884C\u8005\u7531\u65B0\u670D\u52A1\u63A5\u7BA1\uFF0C\u4E0D\u7B49\u7A7A\u95F2\uFF09\uFF1B\u7B49\u7ED3\u679C atrium restart --wait
  \u548C\u79D8\u4E66\u5BF9\u8BDD\uFF1Aatrium chat\uFF08\u7F3A\u7701 opencode \u539F\u751F\u754C\u9762\uFF0C--acp \u7528 ACP\uFF1B--tool codex \u7528 codex-acp\uFF09\uFF1B\u79D8\u4E66\u7A7A\u95F2\u65F6\u4E8B\u4EF6\u81EA\u52A8\u9001\u5165\uFF0C\u5FD9\u65F6\u6392\u961F\uFF1B\u754C\u9762\u5173\u95ED\u540E\u670D\u52A1\u6062\u590D\u539F\u4F1A\u8BDD\u5904\u7406\u4E8B\u4EF6\u518D\u9000\u51FA\uFF0C\u754C\u9762\u548C\u540E\u53F0\u4E92\u65A5
  \u7A7A\u95F2\u65F6\u91CD\u542F\uFF1Aatrium restart --when-idle\uFF1B\u8FDB\u5EA6\u770B atrium status
  \u62A5\u9519\u540E\u600E\u4E48\u529E\uFF1A\u6309\u5019\u9009\u77ED\u53F7\u91CD\u8BD5\uFF0C\u6216\u6267\u884C\u56DE\u6267\u91CC\u7684\u4FEE\u6B63\u547D\u4EE4\u3002

\u547D\u4EE4\u53C2\u8003\uFF08\u7531\u547D\u4EE4\u8868\u751F\u6210\uFF09
${reference}`;
}

// cli/error-message.ts
var fieldNames = {
  name: "\u540D\u79F0",
  title: "\u6807\u9898",
  brief_path: "--brief",
  pr_url: "--pr",
  text: "\u6587\u5B57",
  by: "--as",
  topic: "\u8BAE\u9898",
  conclusion: "\u7ED3\u8BBA"
};
function cliErrorMessage(message, command) {
  return message.split("\uFF1B").map((part) => {
    const field = /^([a-z][\w.]*): (.*)$/i.exec(part);
    if (!field) return part;
    const key = field[1].split(".")[0];
    const label2 = (key in (command?.options ?? {}) ? `--${key}` : void 0) ?? fieldNames[key] ?? "\u53C2\u6570";
    const detail4 = field[2];
    if (/^[\u3400-\u9fff]/u.test(detail4)) return `${label2}\uFF1A${detail4}`;
    return `${label2}\u4E0D\u7B26\u5408\u8981\u6C42`;
  }).join("\uFF1B");
}
function optionError(error) {
  const detail4 = error instanceof Error ? error.message : String(error);
  const code = error?.code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /Unknown option '([^']+)'/.exec(detail4)?.[1];
    return `\u4E0D\u8BA4\u8BC6\u7684\u9009\u9879${flag ? `\uFF1A${flag}` : ""}`;
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE")
    return "\u9009\u9879\u7F3A\u5C11\u6216\u586B\u9519\u4E86\u503C";
  return "\u53C2\u6570\u683C\u5F0F\u4E0D\u5BF9";
}

// cli/main.ts
var str16 = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var strs4 = (values, key) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};
var updateCommand = {
  args: "[--to <\u7248\u672C>] [--repo <\u4ED3\u5E93>]",
  about: "\u68C0\u67E5\u5E76\u66F4\u65B0 Atrium \u7248\u672C\uFF0C\u5B89\u88C5\u65B0\u7248\u672C\u5E76\u5C55\u793A\u6539\u52A8\u6458\u8981",
  options: {
    to: { type: "string" },
    repo: { type: "string" }
  },
  positionals: [0, 0],
  run: async ({ values }) => {
    const { update } = await import("./chunk-ACJKZV7C.js");
    await update(values);
    return 0;
  }
};
var restartCommand = {
  args: "[--wait] [--timeout <\u79D2>]",
  about: "\u5E73\u6ED1\u91CD\u542F Atrium \u670D\u52A1\uFF0C\u968F\u65F6\u53EF\u505A\uFF1A\u5728\u8DD1\u7684\u6267\u884C\u8005\u4E0D\u4E2D\u65AD\uFF0C\u7531\u65B0\u670D\u52A1\u63A5\u7BA1",
  options: {
    wait: { type: "boolean", default: false },
    "when-idle": { type: "boolean", default: false },
    timeout: { type: "string" },
    data: { type: "string" }
  },
  positionals: [0, 0],
  run: async ({ values }) => {
    const { restart } = await import("./chunk-XFH23PDI.js");
    await restart(
      values
    );
    return 0;
  }
};
var commands = {
  ...authCommands,
  // 看板放在任务组最前：先看谁在干活，再看单个任务。
  top: topCommand,
  statusline: statuslineCommand,
  ...taskCommands,
  ...roleCommands,
  ...workerCommands,
  ...reviewCommands,
  ...mapCommands,
  ...orgCommands,
  ...leaderCommands,
  ...patrolCommands,
  ...memoCommands,
  ...goalCommands,
  ...skillCommands,
  ...quotaCommands,
  ...eventCommands,
  ...hostCommands,
  agent: agentCommand,
  chat: chatCommand,
  update: updateCommand,
  restart: restartCommand
};
var service = [
  ["atrium", "\u542F\u52A8\u6216\u590D\u7528\u540E\u53F0\u670D\u52A1\uFF0C\u8F93\u51FA\u5730\u5740"],
  ["atrium status", "\u67E5\u770B\u670D\u52A1\u72B6\u6001\u3001\u5730\u5740\u548C\u6570\u636E\u76EE\u5F55"],
  ["atrium stop", "\u505C\u6B62\u670D\u52A1\uFF0C\u4FDD\u7559\u6570\u636E\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u7531\u4E0B\u6B21\u542F\u52A8\u63A5\u7BA1"],
  ["atrium restart", "\u5E73\u6ED1\u91CD\u542F\u670D\u52A1\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u7531\u65B0\u670D\u52A1\u63A5\u7BA1\uFF0C\u4E0D\u7B49\u7A7A\u95F2"],
  ["atrium update", "\u68C0\u67E5\u5E76\u66F4\u65B0 Atrium \u7248\u672C\uFF1B--to \u6307\u5B9A\u76EE\u6807\u7248\u672C"],
  ["atrium auth status", "\u67E5\u770B\u672C\u673A\u7528\u6237\u8BA4\u8BC1\u72B6\u6001\uFF08\u4E0D\u542F\u52A8\u670D\u52A1\uFF09"],
  ["atrium auth rotate", "\u8F6E\u6362\u7528\u6237\u4EE4\u724C"]
];
var usage = "\u7528\u6CD5\uFF1Aatrium [\u547D\u4EE4] \u2026\uFF1Batrium --help \u5217\u51FA\u5168\u90E8\u547D\u4EE4";
function entry(name, command) {
  return `  atrium ${name} ${command.args}  ${command.about}`;
}
function membersOf(group) {
  return Object.entries(commands).filter(
    ([name]) => name.startsWith(`${group} `)
  );
}
function groupHelp(group) {
  const bare = commands[group];
  const usage2 = bare ? [`\u7528\u6CD5\uFF1Aatrium ${group} ${bare.args}`, `      atrium ${group} <\u5B50\u547D\u4EE4> \u2026`] : [`\u7528\u6CD5\uFF1Aatrium ${group} <\u5B50\u547D\u4EE4> \u2026`];
  return [
    ...usage2,
    "",
    ...bare ? [entry(group, bare)] : [],
    ...membersOf(group).map(([name, command]) => entry(name, command)),
    "",
    `\u547D\u4EE4\u8BE6\u60C5\uFF1Aatrium ${group} <\u5B50\u547D\u4EE4> --help\uFF1B\u5168\u90E8\u547D\u4EE4\uFF1Aatrium --help\uFF1B\u8C03\u7528\u7EA6\u5B9A\uFF1Aatrium guide`
  ].join("\n");
}
function help() {
  const widest = Math.max(...service.map(([line2]) => width(line2)));
  return [
    "\u4F60\u662F Agent \u7684\u8BDD\uFF0C\u5148\u8BFB atrium guide\u3002",
    "",
    "\u670D\u52A1",
    ...service.map(([line2, about]) => `  ${pad(line2, widest)}  ${about}`),
    ...[
      "\u4EFB\u52A1",
      "\u6267\u884C\u673A\u5668",
      "\u4E13\u5458",
      "\u5168\u666F",
      "\u76EE\u6807",
      "\u7EC4\u7EC7",
      "\u5907\u5FD8\u4E0E\u51B3\u5B9A"
    ].flatMap((group) => [
      "",
      group,
      ...Object.entries(commands).filter(([name]) => groupOf(name) === group).map(([name, command]) => entry(name, command))
    ]),
    "",
    "\u547D\u4EE4\u8BE6\u60C5\uFF1Aatrium <\u547D\u4EE4> --help\uFF1B\u8C03\u7528\u7EA6\u5B9A\uFF1Aatrium guide"
  ].join("\n");
}
async function main(argv) {
  const [name, ...rest] = argv;
  const json = argv.includes("--json");
  const state2 = { lines: [] };
  const originalLog = console.log;
  if (json)
    console.log = (...args) => {
      state2.lines.push(args.join(" "));
    };
  return withContext(state2, async () => {
    let code = 0;
    let failed = false;
    let subcommand = name ?? "";
    try {
      if (!["--help", "-h", "help", "guide"].includes(name ?? "") && !rest.includes("--help")) {
        workerGuard();
        leaderCommandGuard(name);
      }
      if (name === void 0 || name === "--no-open") {
        if (rest.filter((part) => part !== "--json").length)
          throw new Problem(400, usage, "usage");
        const { startService } = await import("./chunk-OLH2PWKR.js");
        const data = dataDirectory();
        const record = await startService(data);
        console.log(
          `Atrium \u2192 ${serviceUrl(record)}
\u670D\u52A1\u5DF2\u5C31\u7EEA \xB7 PID ${record.pid}
\u6570\u636E\uFF1A${data}`
        );
        return 0;
      }
      if (["--help", "-h", "help"].includes(name)) {
        console.log(help());
        return 0;
      }
      if ((name === "status" || name === "stop") && rest.every((arg) => arg === "--json")) {
        const { serviceStatus, stopService } = await import("./chunk-OLH2PWKR.js");
        await (name === "status" ? serviceStatus : stopService)(
          dataDirectory()
        );
        return 0;
      }
      if (name === "guide") {
        console.log(guide(commands));
        return 0;
      }
      if (name !== void 0 && membersOf(name).length && (commands[name] === void 0 || rest[0] !== void 0 && !rest[0].startsWith("-") || rest.length > 0 && rest.every((arg) => arg === "--help" || arg === "-h"))) {
        const words = rest.filter((arg) => !arg.startsWith("-"));
        const plain = rest.every(
          (arg) => arg === "--json" || arg === "--help" || arg === "-h"
        );
        if (!words.length && plain) {
          console.log(groupHelp(name));
          subcommand = "--help";
          return 0;
        }
        const word = words[0];
        const own = word !== void 0 && commands[`${name} ${word}`] === void 0 && (commands[name]?.positionals[1] ?? 0) > 0;
        subcommand = word === void 0 || own ? name : `${name} ${rest.splice(rest.indexOf(word), 1)[0]}`;
      } else subcommand = name ?? "";
      const command = commands[subcommand];
      if (!command) {
        const candidate = closest(
          subcommand,
          Object.keys(commands).map((ref5) => ({ ref: ref5, name: ref5 }))
        )[0];
        throw new Problem(
          400,
          `\u4E0D\u8BA4\u8BC6\u7684\u547D\u4EE4\uFF1A${subcommand}${candidate ? `\u3002\u6700\u63A5\u8FD1\u7684\uFF1A${candidate.ref}` : ""}`,
          "usage",
          candidate ? [{ ref: candidate.ref, name: candidate.ref }] : void 0
        );
      }
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(
          `\u7528\u6CD5\uFF1Aatrium ${subcommand} ${command.args}
${command.about}
\u793A\u4F8B\uFF1A${example(subcommand, command)}
\u76F8\u5173\u547D\u4EE4\uFF1Aatrium guide`
        );
        subcommand = "--help";
        return 0;
      }
      let parsed;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            json: { type: "boolean", default: false },
            ...command.options
          },
          allowPositionals: true,
          strict: true
        });
      } catch (error) {
        throw new Problem(
          400,
          `\u7528\u6CD5\uFF1Aatrium ${subcommand} ${command.args}
${optionError(error)}
\u793A\u4F8B\uFF1A${example(subcommand, command)}`,
          "usage"
        );
      }
      const [min, max] = command.positionals;
      if (parsed.positionals.length < min || parsed.positionals.length > max) {
        throw new Problem(
          400,
          `\u7528\u6CD5\uFF1Aatrium ${subcommand} ${command.args}
\u793A\u4F8B\uFF1A${example(subcommand, command)}`,
          "usage"
        );
      }
      code = await command.run({
        positionals: parsed.positionals,
        values: parsed.values,
        json: parsed.values.json === true
      }) ?? 0;
      if (code === 124)
        throw new Problem(408, state2.lines.at(-1) ?? "\u7B49\u5F85\u8D85\u65F6", "timeout");
      return code;
    } catch (error) {
      failed = true;
      const result = failure(error);
      result.message = cliErrorMessage(result.message, commands[subcommand]);
      if (!commands[subcommand] && result.candidates?.[0])
        result.next = `atrium ${result.candidates[0].ref} --help`;
      if (json) {
        state2.lines = [];
        originalLog(
          JSON.stringify({
            ok: false,
            error: {
              code: result.code,
              message: result.code === "confirmation_required" ? result.message.split("\n", 1)[0] : result.message,
              ...result.candidates ? { candidates: result.candidates } : {}
            },
            next: commandOnly(result.next)
          })
        );
      } else {
        console.error(result.message);
        if (commands[subcommand] && result.candidates?.length)
          console.error(
            `\u6700\u63A5\u8FD1\u7684\uFF1A${result.candidates.map(({ name: name2, ref: ref5 }) => `${name2 === ref5.split("/").at(-1) ? ref5 : `${name2}\uFF08${ref5}\uFF09`}`).join("\u3001")}`
          );
        if (result.next && result.code !== "confirmation_required")
          console.error(`\u4FEE\u6B63\uFF1A${result.next}`);
      }
      return result.exit;
    } finally {
      console.log = originalLog;
      if (json && !failed) {
        const next = state2.next ?? defaultNext(subcommand);
        originalLog(
          JSON.stringify({
            ok: true,
            result: state2.result ?? state2.lines.at(-1) ?? null,
            next: commandOnly(next)
          })
        );
      } else if (!json && !failed && !["--help", "-h", "help", "guide"].includes(subcommand)) {
        const next = state2.next ?? defaultNext(subcommand);
        if (next) originalLog(next);
      }
    }
  });
}
function defaultNext(name) {
  if (name === "" || name === "--no-open") return "\u505C\u6B62\uFF1Aatrium stop";
  if (name === "update") return "\u751F\u6548\uFF1Aatrium restart";
  if (name === "restart") return "\u67E5\u770B\u72B6\u6001\uFF1Aatrium status";
  if (name === "status") return "\u770B\u4EFB\u52A1\uFF1Aatrium top";
  return null;
}
export {
  commands,
  groupHelp,
  help,
  main,
  str16 as str,
  strs4 as strs
};
