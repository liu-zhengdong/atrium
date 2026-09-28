import {
  DELIVERS,
  DUE,
  HOLDER_WIDTH,
  LOCAL_USER,
  SECRETARY,
  STAGE_LABEL,
  TASK_STATUSES,
  clip,
  formatChildSummary,
  heldText,
  isTaskStatus,
  limitText,
  oneLine,
  pauseText,
  planCounts,
  progressOf,
  resumeCommand,
  rollupLabel,
  rollupText,
  scheduleBlocked,
  width
} from "./chunk-QE5YTG24.js";
import {
  authCommands,
  defaultActor,
  defaultSubscriber,
  leaderCommandGuard,
  leaderSession,
  workerGuard,
  workerReadable
} from "./chunk-YJ55Y2CF.js";
import "./chunk-BYXBJQAS.js";
import {
  commandOnly,
  exitCodes,
  failure,
  recordNext,
  recordResult,
  withContext
} from "./chunk-C7M4HRWF.js";
import "./chunk-HTIF2JCL.js";
import "./chunk-DGEY7NMR.js";
import {
  briefInput
} from "./chunk-AWSYXCN5.js";
import {
  PRIORITY_LABEL,
  SECRET_VALUE_MAX,
  TREE_MAX,
  TREE_RECENT,
  TREE_ROOTS,
  parsePriority,
  priorityCountsText,
  priorityTag,
  rank,
  secretValue,
  tagTitle,
  titleTag
} from "./chunk-YUQDD424.js";
import {
  alive,
  dataDirectory,
  readService,
  serviceUrl
} from "./chunk-K4FNLP4I.js";
import {
  Problem,
  closest,
  killTree,
  spawnCommand
} from "./chunk-DNL7I37E.js";
import {
  REMIND_MS,
  bridgeClaim
} from "./chunk-VRVTQ3U3.js";
import {
  messagingEndpoint,
  openUrlInvocation
} from "./chunk-JQF35LTD.js";

// cli/main.ts
import { parseArgs } from "node:util";

// cli/format.ts
var pad = (text, target2) => text + " ".repeat(Math.max(0, target2 - width(text)));
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

// cli/args.ts
var str = (values, key) => {
  const value = values[key];
  return typeof value === "string" ? value : void 0;
};
var strs = (values, key) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};

// cli/workers.ts
var client = async () => (await import("./chunk-P53PGFEK.js")).connect();
var percent = (n) => n === null ? "\u2014" : `${Math.round(n * 100)}%`;
var duration = (n) => n === null ? "\u2014" : `${Math.round(n / 6e4)} \u5206`;
var isProfileRef = (value) => /^(harness|models|combos)\//.test(value);
var profilePath = (ref3) => {
  const slash = ref3.indexOf("/");
  return `/workers/profiles/${encodeURIComponent(ref3.slice(0, slash))}/${encodeURIComponent(ref3.slice(slash + 1))}`;
};
function readSource(name) {
  try {
    return readFileSync(name === "-" ? 0 : resolve(name), "utf8");
  } catch {
    throw new Problem(400, `--file \u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${name}`, "usage");
  }
}
async function showProfile(ref3, json) {
  const data = await (await client()).get(profilePath(ref3));
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
  recordNext(`\u6539\u6863\u6848\uFF1Aatrium workers edit ${ref3} --file \u6587\u4EF6`);
}
async function stats(values, json) {
  const role = str(values, "specialist");
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
  }
  recordNext("\u770B\u6267\u884C\u8005\uFF1Aatrium workers \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]");
}
async function profiles(json) {
  const data = await (await client()).get("/workers/profiles");
  if (json) printJson(data);
  else if (!data.profiles.length)
    console.log("\u5E93\u91CC\u8FD8\u6CA1\u6709\u6267\u884C\u8005\u6863\u6848\uFF0C\u6D3E\u6D3B\u7528\u5185\u7F6E\u7F3A\u7701");
  else
    console.log(
      table([
        ["\u6863\u6848", "\u7248\u672C", "\u4FE1\u4EFB", "\u6700\u9AD8\u98CE\u9669", "\u6A21\u578B", "\u52A0\u67E5", "\u66F4\u65B0"],
        ...data.profiles.map((p) => [
          `${p.ref}${p.protocol ? `\uFF08${p.protocol} \u63A5\u5165\uFF09` : ""}`,
          String(p.rev),
          p.trust ?? "\u2014",
          p.max_risk ?? "\u2014",
          `${p.model ?? "\u2014"}${p.endpoint ? ` @ ${p.endpoint}` : ""}`,
          p.checks?.join(",") || "\u2014",
          `${p.updated_by} ${when(p.updated_at)}${p.warnings.length ? " \xB7 \u6709\u8B66\u544A" : ""}`
        ])
      ])
    );
  recordNext("\u770B\u6863\u6848\uFF1Aatrium workers harness/codex");
}
async function workerDetail(worker, json) {
  const data = await (await client()).get(`/workers/${encodeURIComponent(worker)}`);
  if (json) printJson(data);
  else {
    console.log(
      `${data.worker}
${data.profile.body}

\u4EA4\u4ED8\uFF1A
${data.deliveries.map((d) => `${d.task_ref} ${d.task_title} \xB7 ${d.job_name ?? "\u672A\u6307\u5B9A"} \xB7 ${d.final_result} \xB7 ${duration(d.duration_ms)}${d.gate_returns.length ? ` \xB7 \u5173\u5361\uFF1A${d.gate_returns.join("\uFF1B")}` : ""}${d.merge_returns.length ? ` \xB7 \u5408\u5165\u9000\u56DE\uFF1A${d.merge_returns.join("\uFF1B")}` : ""}${d.rebase_conflicts ? ` \xB7 \u53D8\u57FA\u51B2\u7A81 ${d.rebase_conflicts} \u6B21\uFF08\u4E0D\u5F52\u8D23\uFF09` : ""}${d.incidents.length ? ` \xB7 \u4E8B\u6545\uFF1A${d.incidents.join("\u3001")}` : ""}`).join("\n") || "\u6682\u65E0"}`
    );
    for (const w of data.profile.warnings) console.log(`\u8B66\u544A\uFF1A${w}`);
  }
  recordNext("\u770B\u5168\u90E8\uFF1Aatrium workers");
}
var workerCommands = {
  workers: {
    args: "[\u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]|\u5C42/\u540D] [--profiles] [--specialist \u4E13\u5458] [--json]",
    about: "\u4E0D\u7ED9\u53C2\u6570\u6309\u6267\u884C\u8005\u7EC4\u5408\u3001\u6A21\u578B\u3001\u5DE5\u5177\u4E0E\u5E72\u6D3B\u7684\u4E13\u5458\u5217\u4EA4\u4ED8\u4E8B\u5B9E\uFF1B\u7ED9\u6267\u884C\u8005\u770B\u4EA4\u4ED8\u660E\u7EC6\u4E0E\u4E09\u5C42\u53E0\u52A0\u6863\u6848\uFF1B\u7ED9 \u5C42/\u540D\uFF08\u5982 harness/codex\uFF09\u770B\u8FD9\u4EFD\u6863\u6848\u539F\u6587\u4E0E\u4FEE\u8BA2\uFF1B--profiles \u5217\u5E93\u91CC\u7684\u6267\u884C\u8005\u6863\u6848\uFF08\u5DE5\u5177 / \u6A21\u578B / \u7EC4\u5408\u4E09\u5C42\uFF09",
    options: {
      specialist: { type: "string" },
      profiles: { type: "boolean" }
    },
    positionals: [0, 1],
    async run({ positionals: [target2], values, json }) {
      if (target2 !== void 0)
        return isProfileRef(target2) ? showProfile(target2, json) : workerDetail(target2, json);
      return values.profiles ? profiles(json) : stats(values, json);
    }
  },
  "workers edit": {
    args: "\u5C42/\u540D (--file \u6587\u4EF6|- | --trust \u7B49\u7EA7 | --max-risk \u98CE\u9669 | --model \u6A21\u578B | --checks a,b | --set \u952E=\u503C | --unset \u952E) [--reason \u539F\u56E0] [--as secretary]",
    about: "\u6539\u5E93\u91CC\u7684\u4E00\u4EFD\u6267\u884C\u8005\u6863\u6848\u5E76\u7559\u4FEE\u8BA2\uFF1B\u5C42\u662F harness\u3001models\u3001combos\uFF0C\u6863\u6848\u4E0D\u5B58\u5728\u5C31\u65B0\u5EFA\u3002--file - \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u6574\u4EFD\uFF08frontmatter + \u6B63\u6587\uFF09\u3002harness/<\u65B0\u540D\u5B57> \u5199 protocol: cli \u4E0E command\u3001args \u5373\u63A5\u5165\u4E00\u4E2A\u901A\u7528\u547D\u4EE4\u884C\u6267\u884C\u8005\uFF1B\u4EFB\u4E00\u5C42\u5199 endpoint\u3001endpoint_api\u3001endpoint_key\uFF08\u51ED\u636E\u540D\uFF09\u63A5\u81EA\u5B9A\u4E49\u6A21\u578B\u7AEF\u70B9",
    options: {
      file: { type: "string" },
      trust: { type: "string" },
      "max-risk": { type: "string" },
      model: { type: "string" },
      checks: { type: "string" },
      set: { type: "string", multiple: true },
      unset: { type: "string", multiple: true },
      reason: { type: "string" },
      as: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [ref3], values, json }) {
      if (!isProfileRef(ref3))
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
      const who5 = str(values, "as") ?? defaultActor();
      const result = await (await client()).put(
        `${profilePath(ref3)}${who5 ? `?as=${encodeURIComponent(who5)}` : ""}`,
        body
      );
      if (json) printJson(result);
      else
        console.log(
          result.changed ? `${result.created ? "\u5DF2\u65B0\u5EFA" : "\u5DF2\u6539"} ${result.ref}\uFF0C\u7B2C ${result.rev} \u7248` : `${result.ref} \u5185\u5BB9\u6CA1\u53D8\uFF0C\u4ECD\u662F\u7B2C ${result.rev} \u7248`
        );
      recordNext(`\u770B\u6863\u6848\uFF1Aatrium workers ${result.ref}`);
    }
  }
};

// cli/specialists.ts
var client2 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var path = (s) => encodeURIComponent(s);
var fields = (v) => ({
  ...str(v, "name") === void 0 ? {} : { name: str(v, "name") },
  ...str(v, "description") === void 0 ? {} : { description: str(v, "description") },
  ...str(v, "preferred") === void 0 ? {} : { preferred: str(v, "preferred").split(",").filter(Boolean) },
  ...str(v, "checks") === void 0 ? {} : { checks: str(v, "checks").split(",").filter(Boolean) },
  ...str(v, "skills") === void 0 ? {} : { skills: str(v, "skills").split(",").filter(Boolean) },
  ...(str(v, "as") ?? defaultActor()) === void 0 ? {} : { author: str(v, "as") ?? defaultActor() }
});
var opts = {
  name: { type: "string" },
  description: { type: "string" },
  preferred: { type: "string" },
  checks: { type: "string" },
  skills: { type: "string" },
  as: { type: "string" }
};
var output = (json, value, message, next) => {
  if (json) printJson(value);
  else console.log(message);
  recordNext(next);
};
var specialistCommands = {
  "specialist ls": {
    args: "[\u4E13\u5458] [--json]",
    about: "\u5217\u51FA\u4E13\u5458\uFF1A\u540D\u79F0\u3001\u505A\u4EC0\u4E48\u3001\u5728\u505A\u51E0\u4EF6\uFF1B\u7ED9\u4E13\u5458\u770B\u8FD9\u4E00\u4F4D\uFF1A\u505A\u4EC0\u4E48\u3001\u4F18\u5148\u6267\u884C\u8005\u3001\u4EA4\u4ED8\u5173\u5361\u4E0E\u6280\u80FD",
    positionals: [0, 1],
    async run({ positionals: [id], json }) {
      if (id !== void 0) {
        const role = await (await client2()).get(`/specialists/${path(id)}`);
        output(
          json,
          role,
          `${role.ref} ${role.name} \xB7 r${role.rev}
${role.description}
\u4F18\u5148\u6267\u884C\u8005\uFF1A${role.preferred.join("\u3001") || "\u65E0"}
\u4EA4\u4ED8\u5173\u5361\uFF1A${role.checks.join("\u3001") || "\u65E0"}
\u6280\u80FD\uFF1A${role.skills.join("\u3001") || "\u65E0"}`,
          `\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --by ${role.ref}`
        );
        return;
      }
      const rows = await (await client2()).get("/specialists");
      output(
        json,
        rows,
        table([
          ["\u77ED\u53F7", "\u540D\u79F0", "\u505A\u4EC0\u4E48", "\u5728\u505A"],
          ...rows.map((r) => [
            r.ref,
            r.name,
            r.description,
            String(r.running ?? 0)
          ])
        ]),
        "\u770B\u4E13\u5458\uFF1Aatrium specialist ls r1"
      );
    }
  },
  "specialist add": {
    args: "\u540D\u79F0 --description \u6587\u5B57 [--preferred \u5217\u8868] [--checks \u5217\u8868] [--skills \u5217\u8868]",
    about: "\u521B\u5EFA\u4E13\u5458\uFF08\u53EA\u8BB0\u5206\u5DE5\uFF1A\u4E00\u53E5\u505A\u4EC0\u4E48\u3001\u4F18\u5148\u6267\u884C\u8005\u3001\u9A8C\u6536\u5173\u5361\u3001\u6302\u54EA\u4E9B\u6280\u80FD\uFF1B\u505A\u6CD5\u5199\u8FDB\u6280\u80FD\uFF0C\u89C4\u77E9\u5199\u6210\u8981\u70B9\uFF09\uFF1B\u5217\u8868\u7528\u9017\u53F7\u5206\u9694",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      if (!str(values, "description"))
        throw new Problem(
          400,
          "--description: \u5FC5\u586B\uFF0C\u4E00\u53E5\u8BDD\u5199\u8FD9\u4F4D\u4E13\u5458\u505A\u4EC0\u4E48",
          "usage"
        );
      const role = await (await client2()).post("/specialists", { ...fields(values), name });
      output(
        json,
        role,
        `\u5DF2\u5EFA ${role.ref} ${role.name}`,
        `\u770B\u4E13\u5458\uFF1Aatrium specialist ls ${role.ref}`
      );
    }
  },
  "specialist edit": {
    args: "\u4E13\u5458 [--name \u540D\u79F0] [--description \u6587\u5B57] [--preferred \u5217\u8868] [--checks \u5217\u8868] [--skills \u5217\u8868]",
    about: "\u4FEE\u8BA2\u4E13\u5458\uFF0C\u4FDD\u7559\u5386\u53F2",
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
        `\u770B\u4E13\u5458\uFF1Aatrium specialist ls ${role.ref}`
      );
    }
  }
};

// cli/pause.ts
var client3 = async () => (await import("./chunk-P53PGFEK.js")).connect();
function scopeOf(values) {
  const part = str(values, "part");
  const host = str(values, "host");
  if (part !== void 0 && host !== void 0)
    throw new Problem(400, "--part \u4E0E --host \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
  if (host !== void 0 && !/^h[1-9][0-9]{0,8}$/.test(host.trim()))
    throw new Problem(
      400,
      `--host \u5E94\u4E3A\u4E3B\u673A\u77ED\u53F7\uFF0C\u5982 h2\uFF08\u6536\u5230\uFF1A${host}\uFF09`,
      "usage"
    );
  return {
    ...part !== void 0 ? { part } : {},
    ...host !== void 0 ? { host: host.trim() } : {}
  };
}
var asQuery = () => {
  const who5 = defaultActor();
  return who5 ? `?${new URLSearchParams({ as: who5 })}` : "";
};
var pauseLines = (pauses) => (pauses ?? []).map(pauseText);
var scopeWords = (values) => {
  const part = str(values, "part");
  const host = str(values, "host");
  return part !== void 0 ? ` --part ${part}` : host !== void 0 ? ` --host ${host}` : "";
};
var pauseCommands = {
  pause: {
    args: "[--part \u8282\u70B9|--host hN] [--why \u539F\u56E0] [--stop]",
    about: "\u4E00\u952E\u505C\u673A\uFF1A\u505C\u4E0B\u4E00\u5207\u81EA\u4E3B\u52A8\u4F5C\u2014\u2014\u4E0D\u6D3E\u6D3B\uFF08\u81EA\u52A8\u6D3E\u53D1\u3001\u6392\u961F\u62C9\u8D77\u3001\u91CD\u8BD5\u6362\u4EBA\uFF09\u3001\u4E0D\u751F\u6210\u5468\u671F\u4EFB\u52A1\u3001\u4E0D\u53EB\u9192 leader \u4E0E\u540E\u53F0\u79D8\u4E66\u3001\u5408\u5165\u4E0E\u4E0A\u7EBF\u4E0D\u63A8\u8FDB\uFF1B\u4E8B\u4EF6\u7167\u5E38\u843D\u5E93\u4F46\u4E0D\u6295\u7ED9\u7B49\u5F85\u7684\u4EBA\u3002\u5728\u8DD1\u7684\u6267\u884C\u8005\u7F3A\u7701\u8DD1\u5B8C\u4E0D\u63A5\u65B0\u7684\uFF0C--stop \u4E00\u5E76\u505C\u6389\u3002--part \u53EA\u505C\u90A3\u4E00\u5757\uFF08\u6D3E\u6D3B\u3001\u5468\u671F\u4EFB\u52A1\u3001\u5408\u5165\u3001leader\uFF09\uFF0C--host \u53EA\u662F\u4E0D\u5F80\u90A3\u53F0\u6D3E\u6D3B\u4E0E\u68C0\u67E5",
    options: {
      part: { type: "string" },
      host: { type: "string" },
      why: { type: "string" },
      stop: { type: "boolean" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const why = str(values, "why");
      const result = await (await client3()).post(
        `/pause${asQuery()}`,
        {
          ...scopeOf(values),
          ...why !== void 0 ? { why } : {},
          ...values.stop === true ? { stop: true } : {}
        }
      );
      if (json) printJson(result);
      else
        console.log(
          [
            result.changed ? pauseText(result.pause) : `\u672C\u6765\u5C31\u6682\u505C\u7740\uFF1A${pauseText(result.pause)}`,
            result.stopped.length ? `\u4E00\u5E76\u505C\u6389\uFF1A${result.stopped.join("\u3001")}` : values.stop === true ? "\u6CA1\u6709\u5728\u8DD1\u7684\u8981\u505C" : "\u5728\u8DD1\u7684\u6267\u884C\u8005\u7167\u8DD1\uFF0C\u8DD1\u5B8C\u4E0D\u63A5\u65B0\u7684\uFF1B\u8981\u4E00\u5E76\u505C\u6389\u52A0 --stop"
          ].join("\n")
        );
      recordNext(`\u6062\u590D\uFF1Aatrium resume${scopeWords(values)}`);
    }
  },
  resume: {
    args: "[--part \u8282\u70B9|--host hN]",
    about: "\u6062\u590D atrium pause \u505C\u4E0B\u7684\uFF08\u4E0D\u5199\u8303\u56F4\u662F\u5168\u5C40\uFF09\uFF1A\u6392\u7740\u7684\u6309\u987A\u5E8F\u62C9\u8D77\uFF0C\u5230\u70B9\u7684\u5468\u671F\u4EFB\u52A1\u53EA\u8865\u4E00\u8F6E\uFF0C\u6512\u4E0B\u7684\u4E8B\u4EF6\u7167\u5E38\u53EB\u9192 leader \u4E0E\u79D8\u4E66",
    options: { part: { type: "string" }, host: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (await client3()).post(
        `/resume${asQuery()}`,
        scopeOf(values)
      );
      if (json) printJson(result);
      else
        console.log(
          [
            result.resumed ? `\u5DF2\u6062\u590D\uFF1B\u539F\u6765\u662F ${pauseText(result.resumed)}` : "\u8FD9\u4E00\u8303\u56F4\u672C\u6765\u5C31\u6CA1\u6682\u505C",
            ...pauseLines(result.pauses).map((line3) => `\u4ECD\u5728\u6682\u505C\uFF1A${line3}`)
          ].join("\n")
        );
      recordNext("\u770B\u8C01\u5728\u5E72\u6D3B\uFF1Aatrium top");
    }
  }
};

// cli/tasks.ts
import { existsSync, statSync } from "node:fs";
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

// server/tasks/quota/percent.ts
function signedPercent(value) {
  const n = Math.round(value);
  return n > 0 ? `+${n}%` : n < 0 ? `\u2212${-n}%` : "0%";
}
function staleLabel(hoursAgo) {
  return typeof hoursAgo === "number" && Number.isFinite(hoursAgo) ? `\u65E7\u6570\uFF08${Number(hoursAgo.toFixed(1))} \u5C0F\u65F6\u524D\uFF09` : "\u65E7\u6570";
}

// cli/tasks.ts
var client4 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var displayStatus = (task) => (
  // 总任务（t190）：状态与进度按全部子孙汇总，自己的交付记录只作历史。
  task.rollup ? task.status === "cancelled" ? `\u53D6\u6D88 ${progressOf(task.rollup)}` : `${rollupLabel(task.rollup)} ${progressOf(task.rollup)}` : task.queued_reason ? "\u6392\u961F" : task.processing ? "\u5904\u7406\u4E2D" : task.status === "blocked" ? "\u5361\u4F4F" : task.delivery_stage === "reviewing" ? "\u5BA1\u9605\u4E2D" : task.delivery_stage === "merge_queued" ? "\u6392\u961F\u5408\u5165" : task.delivery_stage === "merging" ? "\u5408\u5165\u4E2D" : task.delivery_stage === "merged" ? "\u5DF2\u5408\u5165" : task.delivery_stage === "online" ? "\u5DF2\u4E0A\u7EBF" : task.status
);
var queueLine = (task) => task.queued_reason ? `  \u6392\u961F\u539F\u56E0\uFF1A${task.queued_reason}` : null;
var noteAuthor = (task) => task.note_by_name ? `${task.note_by_name}\uFF08${task.note_by}\uFF09` : task.note_by ?? "\u672A\u77E5";
var noteLine = (task) => task.note ? `  \u5907\u6CE8\uFF08${noteAuthor(task)} \xB7 ${when(task.note_at)}\uFF09\uFF1A${task.note.replace(/\s+/g, " ")}` : null;
var taggedTitle = (task) => tagTitle(priorityTag(task.priority), task.title);
var queuedText = (reason3) => `\u6392\u961F\uFF1A${reason3}`;
function priorityInput(values) {
  const text = str(values, "priority");
  const avoid = str(values, "avoid-host");
  const body = {};
  if (avoid !== void 0) body.avoid_host = avoid;
  if (text === void 0) return body;
  try {
    return { ...body, priority: parsePriority(text) };
  } catch {
    throw new Problem(
      400,
      "--priority \u53EA\u80FD\u662F \u7D27\u6025\u3001\u4FEE\u590D\u3001\u666E\u901A \u6216 \u95F2\u65F6",
      "usage"
    );
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
  const path5 = resolve2(value);
  const stat = existsSync(path5) ? statSync(path5) : null;
  if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    throw new Problem(
      400,
      `${flag} \u6307\u5411\u7684${kind === "file" ? "\u6587\u4EF6" : "\u76EE\u5F55"}\u4E0D\u5B58\u5728\uFF1A${path5}`,
      "usage"
    );
  return path5;
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
function skippedSkillsLine(events) {
  if (!events) return null;
  let last = -1;
  let prev = -1;
  events.forEach((event, index) => {
    if (event.kind !== "start") return;
    prev = last;
    last = index;
  });
  if (last < 0) return null;
  const skipped = events.slice(prev + 1, last).findLast((event) => event.kind === "skills_skipped");
  if (!skipped?.detail) return null;
  try {
    const detail4 = JSON.parse(skipped.detail);
    const skills = Array.isArray(detail4.skills) ? detail4.skills.join("\u3001") : "";
    return `\u7EC4\u7EC7\u6280\u80FD\u6CA1\u6302\u4E0A${skills ? `\uFF08${skills}\uFF09` : ""}\uFF1A${typeof detail4.reason === "string" ? detail4.reason : "\u539F\u56E0\u4E0D\u660E"}`;
  } catch {
    return null;
  }
}
var line = (task) => task.rollup ? [
  task.ref,
  `[${displayStatus(task)}]`,
  task.title,
  "\xB7 \u603B\u4EFB\u52A1",
  ...rollupDetail(task.rollup)
].join(" ") : [
  task.ref,
  `[${displayStatus(task)}]`,
  task.title,
  `\xB7 ${task.deliver}${task.issue ? ` #${task.issue}` : ""}`,
  task.child_summary ? `\xB7 ${formatChildSummary(task.child_summary)}` : "",
  task.worker ? `\xB7 ${task.worker}` : "",
  task.pr_url ? `\xB7 ${task.pr_url}` : ""
].filter(Boolean).join(" ");
function rollupDetail(rollup) {
  const refs = (list3, count) => list3.length ? `\uFF08${list3.join("\u3001")}${count > list3.length ? "\u2026" : ""}\uFF09` : "";
  return [
    rollup.running ? `\xB7 \u5728\u505A ${rollup.running}${refs(rollup.running_refs, rollup.running)}` : "",
    rollup.stuck ? `\xB7 \u5361\u4F4F ${rollup.stuck}${refs(rollup.stuck_refs, rollup.stuck)}` : ""
  ].filter(Boolean);
}
function renderTree(nodes2, depth = 0) {
  return nodes2.flatMap((node) => [
    `${"  ".repeat(depth)}${line(node)}`,
    ...renderTree(node.children, depth + 1)
  ]);
}
function partInput(values) {
  const part = str(values, "part");
  return part !== void 0 ? { part } : {};
}
var add = {
  args: "\u6807\u9898 [--parent tN] [--part \u8282\u70B9] [--secret \u540D\u79F0[,\u540D\u79F0]] [--by \u4E13\u5458] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--priority \u7D27\u6025|\u4FEE\u590D|\u666E\u901A|\u95F2\u65F6] [--avoid-host hN[,hM]] [--from \u8282\u70B9] [--repo \u8DEF\u5F84] [--brief \u6587\u4EF6|-] [--owner \u8BA2\u9605\u8005] [--deliver pr|comment|none] [--issue \u53F7]",
  about: "\u5EFA\u4EFB\u52A1\uFF1B--by \u6307\u5B9A\u5E72\u6D3B\u7684\u4E13\u5458\uFF08\u6D3E\u6D3B\u9644\u6280\u80FD\u4E0E\u4EA4\u4ED8\u5173\u5361\uFF09\uFF1B--part \u5199\u5F52\u5C5E\u90E8\u95E8\uFF08\u8D1F\u8D23\u4E0E\u6C47\u62A5\u53EA\u5728\u8FD9\u4E00\u5904\uFF1B\u6D3E\u6D3B\u9644\u8FD9\u4E2A\u90E8\u95E8\u94FE\u4E0A\u7684\u8981\u70B9\uFF09\uFF0C--secret \u5199\u8981\u7528\u7684\u51ED\u636E\u540D\u79F0\uFF08\u5148 atrium secret set \u8282\u70B9 \u540D\u79F0\uFF1B\u6D3E\u6D3B\u90A3\u4E00\u523B\u6309\u5F52\u5C5E\u90E8\u95E8\u5F80\u4E0A\u627E\u3001\u4EE5\u540C\u540D\u73AF\u5883\u53D8\u91CF\u6CE8\u5165\u6267\u884C\u8005\uFF0C\u63D0\u793A\u8BCD\u53EA\u5199\u540D\u79F0\uFF09\uFF0C--from \u5199\u6295\u4EFB\u52A1\u7684\u8282\u70B9\uFF0C--brief \u9644\u4EFB\u52A1\u8BE6\u8FF0 md\uFF08\u5EFA\u4EFB\u52A1\u65F6\u8BFB\u5165\u5B58\u5E93\uFF0C\u81F3\u591A 64 KB\uFF1B- \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\uFF09\uFF1B--priority \u7D27\u6025|\u4FEE\u590D|\u666E\u901A|\u95F2\u65F6\uFF1A\u6D3E\u6D3B\u4E0E\u5408\u5165\u90FD\u6309\u5B83\u6392\u5148\u540E\uFF0C\u7D27\u6025\u7684\u53E6\u8DF3\u8FC7\u672C\u673A\u8D1F\u8F7D\u9650\u5236\uFF08\u7F3A\u7701\u666E\u901A\uFF09\uFF1B--avoid-host \u6D3E\u6D3B\u907F\u5F00\u8FD9\u4E9B\u4E3B\u673A",
  options: {
    parent: { type: "string" },
    part: { type: "string" },
    secret: { type: "string" },
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
    "avoid-host": { type: "string" },
    priority: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [title], values, json }) {
    const parent = str(values, "parent");
    const repo = str(values, "repo");
    const brief = str(values, "brief");
    const kind = str(values, "deliver");
    const issueText = str(values, "issue");
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
      ...str(values, "by") === void 0 ? {} : { by: str(values, "by") },
      ...str(values, "from") === void 0 ? {} : { from: str(values, "from") },
      ...partInput(values),
      ...str(values, "secret") === void 0 ? {} : { secret: str(values, "secret") },
      ...repo === void 0 ? {} : { repo: existing(repo, "--repo", "directory") },
      ...brief === void 0 ? {} : await briefInput(brief, (path5) => existing(path5, "--brief", "file")),
      ...str(values, "owner") === void 0 ? {} : { owner: str(values, "owner") },
      ...kind === void 0 ? {} : { deliver: deliver(kind) },
      ...issueText === void 0 ? {} : { issue: issue(issueText) },
      ...str(values, "after") === void 0 ? {} : { after: str(values, "after") },
      ...str(values, "after-pr") === void 0 ? {} : { after_pr: str(values, "after-pr") },
      ...values.auto === true ? { auto: true } : {},
      ...priorityInput(values)
    };
    const task = await (await client4()).post("/tasks", body);
    if (json) printJson(task);
    else
      console.log(
        [
          `\u5DF2\u5EFA ${task.ref}\uFF1A${task.title} \xB7 ${PRIORITY_LABEL[task.priority]}${task.parent_ref ? `\uFF08\u7236\u4EFB\u52A1 ${task.parent_ref}\uFF09` : ""}${task.node_ref ? ` \xB7 \u8BB0\u5728 ${task.node_ref}` : ""}${task.origin_ref ? ` \xB7 ${task.origin_ref} \u6295\u6765` : ""}${task.part_ref ? ` \xB7 \u5F52\u5C5E ${task.part_ref}` : ""}${task.secrets?.length ? ` \xB7 \u51ED\u636E ${task.secrets.join("\u3001")}` : ""}`,
          ...task.parent_ref ? [
            `${task.parent_ref} \u662F\u603B\u4EFB\u52A1\uFF1A\u4E0D\u6D3E\u7ED9\u6267\u884C\u8005\uFF0C\u72B6\u6001\u4E0E\u8FDB\u5EA6\u6309\u5168\u90E8\u5B50\u5B59\u6C47\u603B\uFF08atrium task tree ${task.parent_ref}\uFF09`
          ] : []
        ].join("\n")
      );
    recordNext(
      task.priority === "urgent" && !task.parent_ref ? `\u9A6C\u4E0A\u6D3E\uFF1Aatrium task run ${task.ref}` : str(values, "after") || str(values, "after-pr") || values.auto === true ? "\u770B\u6392\u671F\uFF1Aatrium task plan" : task.parent_ref ? `\u770B\u5019\u9009\u5E76\u6D3E\u6D3B\uFF1Aatrium task run ${task.ref} --dry-run` : `\u62C6\u5B50\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898 --parent ${task.ref}`
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
    const wanted = str(values, "status");
    if (wanted !== void 0) search.set("status", status(wanted));
    const parent = str(values, "parent");
    if (parent !== void 0) search.set("parent", ref(parent, "--parent"));
    const after = str(values, "after");
    if (after !== void 0) search.set("after", ref(after, "--after"));
    const result = await (await client4()).get(
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
          clip(taggedTitle(task), 40),
          task.worker ?? "",
          task.pr_url ?? ""
        ])
      ]).split("\n");
      console.log(
        [
          lines[0],
          ...result.tasks.flatMap(
            (task, i) => [lines[i + 1], queueLine(task), noteLine(task)].filter(
              (line3) => !!line3
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
    const task = await (await client4()).get(`/tasks/${ref(reference, "\u4EFB\u52A1")}`);
    if (json) printJson(task);
    else {
      const rows = [
        ["\u6807\u9898", task.title],
        ["\u72B6\u6001", displayStatus(task)],
        ["\u4F18\u5148\u7EA7", PRIORITY_LABEL[task.priority]],
        [
          "\u907F\u5F00\u4E3B\u673A",
          task.avoid_host_refs?.length ? task.avoid_host_refs.join("\u3001") : null
        ],
        ["\u5408\u5165\u4EA4\u56DE\u6B21\u6570", task.merge_returns || null],
        ["\u5BA1\u9605\u4EFB\u52A1", task.review_task ? `t${task.review_task}` : null],
        ["\u6392\u961F\u539F\u56E0", task.queued_reason ?? null],
        ["\u7403\u5728\u8C01\u624B\u91CC", task.holder?.text ?? null],
        ["\u6700\u65B0\u5907\u6CE8", task.note],
        ["\u5907\u6CE8\u4F5C\u8005", task.note ? noteAuthor(task) : null],
        ["\u5907\u6CE8\u65F6\u95F4", task.note_at ? when(task.note_at) : null],
        ["\u7236\u4EFB\u52A1", task.parent_ref],
        [
          "\u603B\u4EFB\u52A1",
          task.rollup ? `\u662F\uFF1A\u4E0D\u6D3E\u7ED9\u6267\u884C\u8005\uFF0C\u6D3E\u5B83\u4E0B\u9762\u7684\u5B50\u4EFB\u52A1\uFF1B\u6309\u5168\u90E8\u5B50\u5B59\u6C47\u603B ${rollupText(task.rollup)}` : null
        ],
        ["\u5B50\u4EFB\u52A1", task.children || null],
        [
          "\u5B50\u4EFB\u52A1\u6C47\u603B",
          task.child_summary ? formatChildSummary(task.child_summary) : null
        ],
        ["\u8BB0\u5728", task.node_ref],
        ["\u6295\u4EFB\u52A1\u7684\u8282\u70B9", task.origin_ref],
        ["\u5F52\u5C5E\u90E8\u95E8", task.part_ref],
        ["\u51ED\u636E", task.secrets?.length ? task.secrets.join("\u3001") : null],
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
        ["\u672C\u5730\u68C0\u67E5", task.last_check ?? null],
        ["CI", task.ci],
        ["\u5EFA\u4E8E", when(task.created_at)],
        ["\u5F00\u59CB", task.started_at ? when(task.started_at) : null],
        ["\u7ED3\u675F", task.ended_at ? when(task.ended_at) : null]
      ];
      console.log(
        [
          `${task.ref} \xB7 ${taggedTitle(task)}`,
          ...rows.slice(1).filter(([, value]) => value !== null && value !== "").map(([key, value]) => `  ${key}\uFF1A${value}`),
          ...task.brief?.trim() ? [
            "\u8BE6\u8FF0\uFF1A",
            ...task.brief.trimEnd().split("\n").map((line3) => `  ${line3}`)
          ] : task.brief_path ? [
            `\u8BE6\u8FF0\uFF1A\u6CA1\u6709\u8FDB\u5E93\uFF08\u539F\u6587\u4EF6\u8BFB\u4E0D\u5230\uFF09\uFF0C\u8865\u4E0A\uFF1Aatrium task set ${task.ref} --brief \u6587\u4EF6`
          ] : [],
          ...task.holder?.detail?.trim() ? [
            "\u539F\u56E0\u5168\u6587\uFF1A",
            ...task.holder.detail.trimEnd().split("\n").map((line3) => `  ${line3}`)
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
function treeMore(result, page) {
  const lines = [];
  if (result.truncated)
    lines.push(
      `\uFF08\u4EFB\u52A1\u8FC7\u591A\uFF0C\u53EA\u663E\u793A\u524D ${TREE_MAX} \u4E2A\uFF1B\u770B\u67D0\u4E00\u68F5\uFF1Aatrium task tree tN\uFF09`
    );
  let next = null;
  if (result.next_after) {
    next = `\u4E0B\u4E00\u9875\uFF1Aatrium task tree${page.all ? " --all" : ""} --after ${result.next_after}${page.limit ? ` --limit ${page.limit}` : ""}`;
    lines.push(
      `\u8FD8\u6709 ${result.remaining} \u4E2A${page.all ? "" : "\u672A\u5B8C\u6210\u7684"}\u9876\u5C42\u4EFB\u52A1\u6CA1\u5217\u51FA`
    );
  }
  if (result.closed_hidden) {
    lines.push(
      `\u53E6\u6709 ${result.closed_hidden} \u4E2A\u5DF2\u7ED3\u675F\u7684\u9876\u5C42\u4EFB\u52A1\u6CA1\u5217\u51FA\uFF1Aatrium task tree --all`
    );
  }
  return { lines, next };
}
var tree = {
  args: "[tN] [--all] [--after tN] [--limit N]",
  about: `\u7F29\u8FDB\u6811\uFF1A\u77ED\u53F7\u3001\u72B6\u6001\u3001\u6807\u9898\u3001\u4EA4\u4ED8\u7269\u3001\u6267\u884C\u8005\u3001PR\uFF1B\u4E0D\u5199 tN \u5217\u672A\u5B8C\u6210\u7684\u9876\u5C42\u4EFB\u52A1\uFF08\u6BCF\u9875 ${TREE_ROOTS} \u4E2A\uFF09\u4E0E\u6700\u8FD1 ${TREE_RECENT} \u4E2A\u5DF2\u7ED3\u675F\u7684\uFF0C--all \u6309\u77ED\u53F7\u7FFB\u5168\u90E8\u9876\u5C42`,
  options: {
    all: { type: "boolean" },
    after: { type: "string" },
    limit: { type: "string" }
  },
  positionals: [0, 1],
  async run({ positionals: [root], values, json }) {
    const search = new URLSearchParams();
    const all2 = values.all === true;
    if (root !== void 0 && (all2 || str(values, "after") !== void 0 || str(values, "limit") !== void 0))
      throw new Problem(
        400,
        "--all\u3001--after\u3001--limit \u53EA\u7528\u4E8E\u4E0D\u5199 tN \u65F6\u7FFB\u9876\u5C42\u4EFB\u52A1",
        "usage",
        void 0,
        `atrium task tree ${root}`
      );
    if (root !== void 0) search.set("root", ref(root, "\u4EFB\u52A1"));
    if (all2) search.set("all", "1");
    const after = str(values, "after");
    if (after !== void 0) search.set("after", ref(after, "--after"));
    const limit = str(values, "limit");
    if (limit !== void 0) search.set("limit", limit);
    const result = await (await client4()).get(`/tasks/tree${search.size ? `?${search}` : ""}`);
    const more = treeMore(result, { all: all2, limit });
    if (json) printJson(result);
    else {
      console.log(
        [
          ...result.tasks.length ? renderTree(result.tasks) : [
            root !== void 0 || all2 || after !== void 0 ? "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4EFB\u52A1" : "\u8FD8\u6CA1\u6709\u4EFB\u52A1"
          ],
          ...more.lines
        ].join("\n")
      );
    }
    recordNext(
      more.next ?? (result.tasks.length ? `\u770B\u8BE6\u60C5\uFF1Aatrium task show ${root ?? result.tasks[0].ref}` : "\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898")
    );
  }
};
var set = {
  args: "tN [--status S] [--with-children] [--pr URL] [--by \u4E13\u5458|''] [--from \u8282\u70B9|''] [--part \u8282\u70B9|''] [--secret \u540D\u79F0[,\u540D\u79F0]|''] [--brief \u6587\u4EF6|-|''] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--priority \u7D27\u6025|\u4FEE\u590D|\u666E\u901A|\u95F2\u65F6] [--avoid-host hN[,hM]|'']",
  about: `\u4EBA\u5DE5\u4FEE\u6B63\u72B6\u6001\uFF08${TASK_STATUSES.filter((s) => s !== "running").join("\u3001")}\uFF09\uFF1B\u4E5F\u53EF\u8865\u767B PR \u6216\u6539\u6807\u9898\u3001\u5E72\u6D3B\u7684\u4E13\u5458\u3001\u5F52\u5C5E\u90E8\u95E8\u3001\u8981\u7528\u7684\u51ED\u636E\uFF08--secret\uFF0C\u4E0B\u4E00\u8F6E\u62C9\u8D77\u6309\u65B0\u7684\u6CE8\u5165\uFF09\u3001\u8BE6\u8FF0\u3001\u4EA4\u4ED8\u7269\u3001\u4F9D\u8D56\u3001\u81EA\u52A8\u6D3E\u53D1\u3001\u4F18\u5148\u7EA7\uFF08--priority\uFF0C\u6392\u961F\u4E2D\u7684\u7ACB\u523B\u6309\u65B0\u5148\u540E\u91CD\u6392\uFF0C\u5728\u8DD1\u7684\u4E0D\u6253\u65AD\uFF09\u4E0E\u907F\u5F00\u7684\u4E3B\u673A\uFF08--avoid-host\uFF09\uFF1B\u53D6\u6D88\u603B\u4EFB\u52A1\u65F6 --with-children \u8FDE\u5E26\u53D6\u6D88\u6CA1\u7ED3\u675F\u7684\u5B50\u5B59\uFF08\u5728\u8DD1\u7684\u5148\u505C\uFF0C\u5DF2\u4E0A\u7EBF\u3001\u5DF2\u5B8C\u6210\u7684\u4E0D\u52A8\uFF09`,
  options: {
    status: { type: "string" },
    "with-children": { type: "boolean" },
    title: { type: "string" },
    by: { type: "string" },
    from: { type: "string" },
    part: { type: "string" },
    secret: { type: "string" },
    brief: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    pr: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
    "avoid-host": { type: "string" },
    priority: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const body = {};
    const wanted = str(values, "status");
    if (wanted !== void 0) body.status = status(wanted);
    if (values["with-children"] === true) {
      if (body.status !== "cancelled")
        throw new Problem(
          400,
          "--with-children \u53EA\u7528\u4E8E\u53D6\u6D88\u603B\u4EFB\u52A1\uFF1A\u540C\u65F6\u7ED9 --status cancelled",
          "usage",
          void 0,
          `atrium task set ${ref(reference, "\u4EFB\u52A1")} --status cancelled --with-children`
        );
      body.with_children = true;
    }
    const title = str(values, "title");
    if (title !== void 0) {
      if (!title.trim()) throw new Problem(400, "--title \u4E0D\u80FD\u4E3A\u7A7A", "usage");
      body.title = title;
    }
    const by = str(values, "by");
    if (by !== void 0) body.by = by;
    const from = str(values, "from");
    if (from !== void 0) body.from = from;
    Object.assign(body, partInput(values));
    if (str(values, "secret") !== void 0)
      body.secret = str(values, "secret");
    const brief = str(values, "brief");
    if (brief === "") body.brief = "";
    else if (brief !== void 0)
      Object.assign(
        body,
        await briefInput(brief, (path5) => existing(path5, "--brief", "file"))
      );
    const kind = str(values, "deliver");
    if (kind !== void 0) body.deliver = deliver(kind);
    const issueText = str(values, "issue");
    if (issueText !== void 0) body.issue = String(issue(issueText));
    const pr = str(values, "pr");
    if (pr !== void 0) body.pr_url = pr;
    if (str(values, "after") !== void 0) body.after = str(values, "after");
    if (str(values, "after-pr") !== void 0)
      body.after_pr = str(values, "after-pr");
    if (values.auto === true) body.auto = true;
    Object.assign(body, priorityInput(values));
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "\u81F3\u5C11\u7ED9\u4E00\u9879\uFF1A--status\u3001--pr\u3001--title\u3001--by\u3001--from\u3001--part\u3001--secret\u3001--brief\u3001--deliver\u3001--issue\u3001--after\u3001--after-pr\u3001--auto\u3001--avoid-host \u6216 --priority",
        "usage",
        void 0,
        `atrium task set ${id} --status done`
      );
    const task = await (await client4()).patch(
      `/tasks/${id}`,
      body
    );
    if (json) printJson(task);
    else
      console.log(
        [
          `${task.ref} \u5DF2\u66F4\u65B0 \xB7 [${task.status}] ${task.title}`,
          ...task.cancelled_children ? [
            task.cancelled_children.length ? `\u8FDE\u5E26\u53D6\u6D88 ${task.cancelled_children.length} \u4E2A\u5B50\u5B59\uFF1A${task.cancelled_children.join("\u3001")}` : "\u6CA1\u6709\u8981\u8FDE\u5E26\u53D6\u6D88\u7684\u5B50\u5B59",
            ...task.stopped?.length ? [`\u5176\u4E2D\u5148\u505C\u6389\u5728\u8DD1\u7684\uFF1A${task.stopped.join("\u3001")}`] : []
          ] : [],
          ...body.priority !== void 0 ? [
            `\u4F18\u5148\u7EA7\uFF1A${PRIORITY_LABEL[task.priority]}\uFF08\u6392\u961F\u6309\u7D27\u6025\u3001\u4FEE\u590D\u3001\u666E\u901A\u3001\u95F2\u65F6\u7684\u5148\u540E\uFF09`
          ] : []
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
    const result = await (await client4()).post(`/tasks/${id}/note`, {
      text,
      by: str(values, "as") ?? leaderSession()?.leader ?? defaultActor() ?? "u1",
      ...str(values, "verdict") ? { verdict: str(values, "verdict") } : {}
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
    const result = await (await client4()).post(
      `/tasks/${id}/tell`,
      {
        text,
        by: str(values, "as") ?? leaderSession()?.leader ?? defaultActor() ?? "u1"
      }
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
    const after = str(values, "after");
    const result = await (await client4()).get(`/tasks/plan${after ? `?after=${ref(after, "--after")}` : ""}`);
    if (json) printJson(result);
    else {
      const counts3 = planCounts(result.groups);
      for (const [group, label2] of [
        ["running", "\u5728\u8DD1"],
        ["ready", "\u5C31\u7EEA"],
        ["waiting", "\u7B49\u5F85\u4E2D"],
        ["blocked", "\u5361\u4F4F"]
      ]) {
        const count = group === "ready" ? counts3.ready : group === "waiting" ? counts3.waiting : result.groups[group].length;
        console.log(`${label2}\uFF08${count}\uFF09`);
        for (const item of result.groups[group])
          console.log(
            `  ${item.task.ref} ${taggedTitle(item.task)}${item.task.queued_reason ? ` \xB7 ${queuedText(item.task.queued_reason)}` : ""}${item.waiting_for.length ? ` \xB7 \u7B49 ${item.waiting_for.join("\u3001")}` : ""}${item.reason ? ` \xB7 ${item.reason}` : ""}`
          );
      }
    }
    recordNext(
      result.next_after ? `\u4E0B\u4E00\u9875\uFF1Aatrium task plan --after ${result.next_after}` : "\u5EFA\u4EFB\u52A1\uFF1Aatrium task add \u6807\u9898"
    );
  }
};
var run = {
  args: "tN [--worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]] [--risk low|medium|high] [--host hN] [--dry-run]",
  about: "\u6D3E\u7ED9\u6267\u884C\u8005\uFF1A\u8FDB\u6D3E\u6D3B\u961F\u5217\uFF0C\u6309\u4F18\u5148\u7EA7\u3001\u5165\u961F\u5148\u540E\u62C9\u8D77\uFF08\u670D\u52A1\u6301\u6709\u8FDB\u7A0B\uFF09\uFF1B\u4E0D\u5199 --worker \u6309\u989D\u5EA6\u6311\uFF0C--risk \u7F3A\u7701 low\uFF1B--host \u6D3E\u5230\u6307\u5B9A\u7684\u6267\u884C\u673A\u5668\uFF08\u4E0D\u5199\u5728\u80FD\u63A5\u7684\u4E3B\u673A\u91CC\u6311\u6700\u7A7A\u7684\uFF09\uFF1B\u5DF2\u5728\u6392\u961F\u7684\u5E26 --worker \u6216 --host \u6539\u6D3E\u6267\u884C\u8005\u6216\u4E3B\u673A\uFF0C\u6392\u961F\u4F4D\u7F6E\u4E0D\u53D8\uFF1B\u8981\u63D2\u5230\u524D\u9762\u7528 atrium task set tN --priority \u7D27\u6025\uFF1B--dry-run \u53EA\u770B\u5019\u9009\uFF08\u80FD\u4E0D\u80FD\u63A5\u3001\u8D26\u53F7\u989D\u5EA6\u3001\u662F\u5426\u6B63\u5FD9\u3001\u4EA4\u4ED8\u8BB0\u5F55\u3001\u63A8\u8350\u4E0E\u7406\u7531\uFF09\uFF0C\u4E0D\u6D3E",
  options: {
    worker: { type: "string" },
    risk: { type: "string" },
    host: { type: "string" },
    "dry-run": { type: "boolean" }
  },
  positionals: [1, 1],
  async run(input) {
    if (input.values["dry-run"]) return pickRun(input);
    const {
      positionals: [reference],
      values,
      json
    } = input;
    const id = ref(reference, "\u4EFB\u52A1");
    const body = {};
    const worker = str(values, "worker");
    if (worker !== void 0) {
      if (!worker.trim())
        throw new Problem(
          400,
          "--worker \u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5982 codex+gpt-6-sol",
          "usage"
        );
      body.worker = worker;
    }
    const risk = str(values, "risk");
    if (risk !== void 0) {
      if (!["low", "medium", "high"].includes(risk))
        throw new Problem(
          400,
          `--risk \u53EA\u80FD\u662F low\u3001medium\u3001high\uFF08\u6536\u5230\uFF1A${risk}\uFF09`,
          "usage"
        );
      body.risk = risk;
    }
    const host = str(values, "host");
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
    const result = await (await client4()).post(`/tasks/${id}/run`, body);
    const { task } = result;
    const target2 = result.reassigned ? `${result.reassigned.host ? `${result.reassigned.host} \u4E0A\u7684 ` : ""}${result.reassigned.worker}` : "";
    if (json) printJson(result);
    else
      console.log(
        [
          result.reassigned && result.queued ? `${task.ref} \u5DF2\u6539\u6D3E\u7ED9 ${target2}\uFF0C\u4ECD\u5728\u6392\u961F\uFF1A${result.reassigned.reason ?? queuedReason(task.events)}` : result.reassigned && task.status !== "running" ? `${task.ref} \u5DF2\u6539\u6D3E\u7ED9 ${target2}\uFF0C\u73B0\u5728 ${task.status}` : result.queued ? `${task.ref} \u6392\u961F\u4E2D\uFF1A${queuedReason(task.events)}` : `\u5DF2${result.reassigned ? "\u6539" : ""}\u6D3E ${task.ref} \u7ED9 ${task.worker}\uFF08${task.host_ref ? `${task.host_ref} \u4E0A ` : ""}PID ${task.pid}${task.worktree ? `\uFF0C\u5DE5\u4F5C\u6811 ${task.worktree}\uFF0C\u5206\u652F ${task.branch}` : ""}\uFF09`,
          ...pickLines(result.pick),
          ...(result.queued ? [] : [skippedSkillsLine(task.events)]).filter(
            (text) => !!text
          )
        ].join("\n")
      );
    recordNext(`\u7B49\u7ED3\u679C\uFF1Aatrium task wait ${task.ref}`);
  }
};
function pickLines(pick) {
  if (!pick) return [];
  return [
    ...pick.auto && pick.reason ? [
      pick.reason.startsWith("\u7D27\u6025\uFF1A") ? `\u6311\u4E86 ${pick.worker}\uFF08${pick.reason}\uFF09` : /^[小中大]活/.test(pick.reason) ? `\u6311\u4E86 ${pick.worker}\uFF0C\u56E0\u4E3A${pick.reason}` : `\u6309\u989D\u5EA6\u6311\u4E86 ${pick.worker}\uFF0C\u56E0\u4E3A${pick.reason}`
    ] : [],
    ...pick.notice ? [pick.notice] : []
  ];
}
var accountCell = (q) => {
  if (q.held_until !== null) return `\u989D\u5EA6\u7528\u5C3D\u81F3 ${when(q.held_until)}`;
  const parts = [
    q.stale ? staleLabel(q.refreshed_hours_ago) : null,
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
        h.fit === "ok" ? h.reason ? `\u80FD\u63A5\uFF08${h.reason}\uFF09` : "\u80FD\u63A5" : h.fit === "later" ? `\u6392\u961F\uFF1A${h.reason}` : `\u4E0D\u80FD\u63A5\uFF1A${h.reason}`
      ])
    )
  ];
}
function formatPick(view) {
  const head = view.recommended ? `\u63A8\u8350 ${view.recommended}\uFF1A${view.reason}` : `\u6682\u65E0\u63A8\u8350\uFF1A${view.reason}`;
  const meta = `${view.task} \xB7 risk=${view.risk}${view.job ? ` \xB7 \u5E72\u6D3B\u7684\u4E13\u5458 ${view.job.name}\uFF08${view.job.ref}\uFF09` : " \xB7 \u6CA1\u6307\u5B9A\u5E72\u6D3B\u7684\u4E13\u5458"} \xB7 \u7ED9\u4F60\u4FDD\u7559 ${view.reserve_percent}%${view.quota_known ? "" : " \xB7 \u989D\u5EA6\u6570\u636E\u4E0D\u53EF\u7528"}`;
  if (!view.candidates.length) return [head, meta].join("\n");
  return [
    head,
    meta,
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
async function pickRun({ positionals: [reference], values, json }) {
  const id = ref(reference, "\u4EFB\u52A1");
  const risk = str(values, "risk");
  if (risk !== void 0 && !["low", "medium", "high"].includes(risk))
    throw new Problem(
      400,
      `--risk \u53EA\u80FD\u662F low\u3001medium\u3001high\uFF08\u6536\u5230\uFF1A${risk}\uFF09`,
      "usage"
    );
  const view = await (await client4()).get(
    `/tasks/${id}/pick${risk ? `?${new URLSearchParams({ risk })}` : ""}`
  );
  if (json) printJson(view);
  else console.log(formatPick(view));
  const riskFlag = risk && risk !== "low" ? ` --risk ${risk}` : "";
  recordNext(
    view.recommended ? `\u6D3E\u6D3B\uFF1Aatrium task run ${id} --worker ${view.recommended}${riskFlag}` : "\u770B\u989D\u5EA6\uFF1Aatrium quota"
  );
}
var stop = {
  args: "tN [--as \u8BA2\u9605\u8005]",
  about: "\u505C\u6389\u6267\u884C\u8005\u6216\u5408\u5165\u961F\u5217\uFF1B\u7531\u6B64\u4EA7\u751F\u7684\u4E8B\u4EF6\u4E0D\u6295\u7ED9\u53D1\u8D77\u8005\u672C\u4EBA\uFF08\u7F3A\u7701 secretary\uFF09",
  options: { as: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const who5 = str(values, "as") ?? defaultSubscriber();
    if (!who5.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const result = await (await client4()).post(
      `/tasks/${id}/stop?${new URLSearchParams({ as: who5 })}`
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
  args: "tN [--as \u8BA2\u9605\u8005]",
  about: "\u5C06\u5173\u5361\u5DF2\u901A\u8FC7\u3001\u5E26 PR \u7684\u53D7\u963B\u5408\u5165\u4EFB\u52A1\u91CD\u65B0\u6392\u961F\uFF1B\u53D7\u963B\u5728\u4E13\u5458\u5426\u51B3\u6216\u6CA1\u51FA\u7ED3\u8BBA\u4E0A\u7684\uFF0C\u8D1F\u8D23\u7684 leader \u770B\u8FC7\u7406\u7531\u4E0D\u8BA4\u540C\u65F6\u7528\u5B83\u653E\u884C",
  options: { as: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const who5 = str(values, "as") ?? defaultSubscriber();
    if (!who5.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const result = await (await client4()).post(
      `/tasks/${id}/merge?${new URLSearchParams({ as: who5 })}`,
      {}
    );
    if (json) printJson(result);
    else console.log(`${id} \u5DF2\u6392\u961F\u5408\u5165 \xB7 [${result.task.status}]`);
    recordNext(`\u7B49\u5408\u5165\uFF1Aatrium task wait ${id}`);
  }
};
var deliverTask = {
  args: "tN --pr URL [--worktree \u8DEF\u5F84] [--repo \u8DEF\u5F84] [--as \u8BA2\u9605\u8005]",
  about: "\u79D8\u4E66\u3001leader \u4EB2\u81EA\u505A\u5B8C\u7684\u6D3B\u767B\u8BB0\u4EA4\u4ED8\uFF1A\u8FD0\u884C\u65F6\u6838\u5BF9 PR \u4E0E\u5DE5\u4F5C\u6811\u540E\u8BB0\u6210\u5B8C\u6210\u3001\u8FDB\u5408\u5165\u961F\u5217\uFF08\u6309\u4F18\u5148\u7EA7\u6392\uFF09\uFF1B--worktree \u7ED9 PR \u5206\u652F\u6240\u5728\u7684\u9644\u5C5E\u5DE5\u4F5C\u6811\uFF0C\u5408\u5165\u5728\u90A3\u91CC rebase\u3001\u68C0\u67E5\uFF0C\u5408\u5165\u540E\u548C\u6267\u884C\u8005\u7684\u4E00\u6837\u6E05\u7406\uFF1B\u4E0D\u7ED9\u65F6\u5408\u5165\u961F\u5217\u6309\u4EFB\u52A1\u5DE5\u4F5C\u6811\u89C4\u5219\u53E6\u5EFA\u4E00\u4E2A\uFF1B\u4EFB\u52A1\u6CA1\u8BB0\u4ED3\u5E93\u65F6\u52A0 --repo",
  options: {
    pr: { type: "string" },
    worktree: { type: "string" },
    repo: { type: "string" },
    as: { type: "string" }
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "\u4EFB\u52A1");
    const pr = str(values, "pr");
    if (!pr) throw new Problem(400, "\u7F3A\u5C11 --pr\uFF1APR \u94FE\u63A5", "usage");
    const worktree = str(values, "worktree");
    const repo = str(values, "repo");
    const who5 = str(values, "as") ?? defaultSubscriber();
    if (!who5.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const result = await (await client4()).post(
      `/tasks/${id}/deliver?${new URLSearchParams({ as: who5 })}`,
      {
        pr_url: pr,
        ...worktree === void 0 ? {} : { worktree: existing(worktree, "--worktree", "directory") },
        ...repo === void 0 ? {} : { repo: existing(repo, "--repo", "directory") }
      }
    );
    if (json) printJson(result);
    else
      console.log(
        `${id} \u5DF2\u767B\u8BB0\u4EA4\u4ED8\u3001\u6392\u961F\u5408\u5165 \xB7 \u5DE5\u4F5C\u6811 ${result.task.worktree ?? "\u5408\u5165\u961F\u5217\u53E6\u5EFA"}`
      );
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
    const afterText = str(values, "after");
    if (afterText !== void 0 && !/^(0|[1-9]\d*)$/.test(afterText))
      throw new Problem(400, "--after \u5E94\u4E3A\u975E\u8D1F\u6574\u6570\u5B57\u8282\u504F\u79FB", "usage");
    const follow = values.follow === true;
    if (follow && json)
      throw new Problem(400, "--follow \u4E0D\u80FD\u4E0E --json \u540C\u65F6\u4F7F\u7528", "usage");
    const api2 = await client4();
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
      if (!more) await new Promise((resolve11) => setTimeout(resolve11, 1e3));
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
    const seconds = waitSeconds(str(values, "timeout"));
    const api2 = await client4();
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
  "task run": run,
  "task stop": stop,
  "task merge": merge,
  "task deliver": deliverTask,
  "task log": log,
  "task wait": wait
};

// cli/org.ts
import { resolve as resolve3 } from "node:path";

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
  return lines.map((line3) => `      ${line3.split("\n").join("\n      ")}`);
}
function pointLines(points) {
  if (!points.length) return [];
  return [
    "\u8981\u70B9\uFF08\u5FC5\u987B\u5B88\u4F4F\uFF1B\u8D8A\u9760\u524D\u8D8A\u91CD\u8981\uFF0C\u51B2\u7A81\u65F6\u9760\u524D\u7684\u4F18\u5148\uFF09\uFF1A",
    ...points.flatMap((p, i) => [
      `  ${i + 1}. ${p.ref} ${p.text}`,
      `     \u4E3A\u4EC0\u4E48\uFF1A${p.why} \xB7 ${p.by} \u5B9A${p.check ? ` \xB7 \u68C0\u67E5\uFF1A${p.check}` : ""}`
    ])
  ];
}
function formatOverview(node, overview, detail4 = false, points = []) {
  if (isBlank(overview))
    return [
      `\u4EBA\u8BDD\u4ECB\u7ECD\u8FD8\u6CA1\u5199\uFF08\u662F\u4EC0\u4E48\u3001\u80FD\u505A\u4EC0\u4E48\u3001\u600E\u4E48\u8D70\u5B8C\u3001\u73B0\u72B6\uFF09\uFF1Aatrium map edit ${node.ref} --what \u4E00\u53E5\u8BDD --uses \u573A\u666F --flow \u6B65\u9AA4 --now \u73B0\u72B6 --next \u63A5\u4E0B\u6765`,
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
    `\u662F\u4EC0\u4E48\uFF1A${overview.what || none}`,
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
  if (!parts.length) return ["\u4E0B\u8BBE\u54EA\u4E9B\u90E8\u95E8\uFF1A\u6CA1\u6709\u4E0B\u4E00\u5C42"];
  return [
    "\u4E0B\u8BBE\u54EA\u4E9B\u90E8\u95E8\uFF1A",
    ...parts.map(
      (p) => `  ${titleOf(p, p)}${counts(p.tasks)}${p.archived ? " \xB7 \u5DF2\u5F52\u6863" : ""}`
    )
  ];
}

// cli/leaders.ts
import { readFileSync as readFileSync2 } from "node:fs";

// server/leaders/wake.ts
var ESCALATE_KINDS = {
  shipped: "\u5DF2\u4E0A\u7EBF",
  cross: "\u9700\u8981\u522B\u7684\u90E8\u95E8\u914D\u5408",
  beyond: "\u8D8A\u8FC7\u6743\u9650\uFF0F\u989D\u5EA6\uFF0F\u6839\u4E0A\u7684\u539F\u5219",
  stuck: "\u641E\u4E0D\u5B9A"
};

// cli/leaders.ts
var client5 = async () => (await import("./chunk-P53PGFEK.js")).connect();
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
    args: "[aN]",
    about: "\u5217\u51FA leader\uFF1A\u8D1F\u8D23\u7684\u8282\u70B9\u3001\u6267\u884C\u8005\u7EC4\u5408\u3001\u6700\u8FD1\u4E00\u6B21\u5524\u9192\u5728\u5904\u7406\u4EC0\u4E48\uFF1B\u8282\u70B9\u4E0A\u5F15\u7528\u4E86\u4F46\u6CA1\u767B\u8BB0\u7684\u5355\u5217\uFF1B\u7ED9 aN \u770B\u8FD9\u4E00\u4F4D\u7684\u8BE6\u60C5\u4E0E\u5907\u5FD8",
    positionals: [0, 1],
    async run({ positionals: [who5], json }) {
      if (who5 !== void 0) {
        const view = await (await client5()).get(`/leaders/${enc(who5)}`);
        if (json) printJson(view);
        else console.log(detail(view));
        recordNext(`\u770B\u5B83\u7684\u4E8B\u4EF6\uFF1Aatrium events --as ${view.ref}`);
        return;
      }
      const result = await (await client5()).get("/leaders");
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
        result.leaders.length ? `\u770B\u4E00\u4F4D\uFF1Aatrium leader ls ${result.leaders[0].ref}` : "\u767B\u8BB0\uFF1Aatrium leader add \u540D\u79F0 --worker claude+opus"
      );
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
      if (!str(values, "worker"))
        throw new Problem(
          400,
          "--worker \u5FC5\u586B\uFF1Aleader \u88AB\u5524\u9192\u65F6\u7528\u54EA\u4E2A\u6267\u884C\u8005\u7EC4\u5408\uFF0C\u5982 claude+opus:high",
          "usage"
        );
      const view = await (await client5()).post("/leaders", {
        name,
        worker: str(values, "worker"),
        ...str(values, "memo") === void 0 ? {} : { memo: str(values, "memo") },
        ...str(values, "id") === void 0 ? {} : { id: str(values, "id") }
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
    async run({ positionals: [who5], values, json }) {
      if (str(values, "memo") !== void 0 && str(values, "memo-file"))
        throw new Problem(400, "--memo \u4E0E --memo-file \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
      let memo = str(values, "memo");
      const file2 = str(values, "memo-file");
      if (file2 !== void 0) {
        try {
          memo = readFileSync2(file2, "utf8");
        } catch {
          throw new Problem(400, `--memo-file: \u8BFB\u4E0D\u5230 ${file2}`, "usage");
        }
      }
      const body = {
        ...str(values, "name") === void 0 ? {} : { name: str(values, "name") },
        ...str(values, "worker") === void 0 ? {} : { worker: str(values, "worker") },
        ...memo === void 0 ? {} : { memo }
      };
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "\u81F3\u5C11\u6539\u4E00\u9879\uFF1A--name\u3001--worker\u3001--memo \u6216 --memo-file",
          "usage"
        );
      const view = await (await client5()).patch(`/leaders/${enc(who5)}`, body);
      if (json) printJson(view);
      else console.log(`\u5DF2\u66F4\u65B0 ${view.ref}
${detail(view)}`);
      recordNext(`\u770B\uFF1Aatrium leader ls ${view.ref}`);
    }
  },
  "leader escalate": {
    args: "\u8BF4\u660E --kind shipped|cross|beyond|stuck [--task tN] [--event \u7F16\u53F7] [--as aN]",
    about: `leader \u4E0A\u4EA4\u7ED9\u4E0A\u4E00\u5C42\uFF08\u79D8\u4E66\u6216\u4E0A\u5C42 leader\uFF09\uFF0C\u751F\u6210\u4E00\u6761\u300C\u8981\u5904\u7406\u300D\u4E8B\u4EF6\uFF1B\u53EA\u6709\u56DB\u7C7B\uFF1A${Object.entries(
      ESCALATE_KINDS
    ).map(([k, v]) => `${k} ${v}`).join(
      "\u3001"
    )}\uFF1Bshipped \u8981\u5E26 --task\u3002\u8F6C\u4EA4\u4E0B\u5C42 leader \u7684\u4E0A\u4EA4\u65F6\u7528 --event \u7ED9\u90A3\u6761\u4E8B\u4EF6\u7684\u7F16\u53F7\u3001\u8BF4\u660E\u5199\u4F60\u7684\u610F\u89C1\uFF08\u540C\u4EFB\u52A1\u540C\u7C7B\u578B\u7684\u4F1A\u81EA\u52A8\u8BA4\u4F5C\u8F6C\u4EA4\uFF09\uFF0C\u4E0A\u9762\u53EA\u6536\u4E00\u6761\u3002leader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u4EE5\u81EA\u5DF1\u7684\u8EAB\u4EFD\u4E0A\u4EA4`,
    options: {
      kind: { type: "string" },
      task: { type: "string" },
      event: { type: "string" },
      as: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [note2], values, json }) {
      const who5 = str(values, "as") ?? self();
      if (!who5)
        throw new Problem(
          400,
          "--as: \u4EE5\u54EA\u4F4D leader \u7684\u540D\u4E49\u4E0A\u4EA4\uFF0C\u5982 a1\uFF08leader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u662F\u81EA\u5DF1\uFF09",
          "usage"
        );
      const kind = str(values, "kind");
      if (!kind)
        throw new Problem(
          400,
          `--kind \u5FC5\u586B\uFF1A${Object.keys(ESCALATE_KINDS).join("\u3001")}`,
          "usage"
        );
      const result = await (await client5()).post(`/leaders/${enc(who5)}/escalate`, {
        kind,
        note: note2,
        ...str(values, "task") === void 0 ? {} : { task: str(values, "task") },
        ...str(values, "event") === void 0 ? {} : { event: str(values, "event") }
      });
      if (json) printJson(result);
      else
        console.log(
          `${result.forwarded === null ? "\u5DF2\u4E0A\u4EA4" : `\u5DF2\u8F6C\u4EA4 #${result.forwarded} `}\u300C${result.kind_label}\u300D\u7ED9 ${result.to === "secretary" ? "\u79D8\u4E66" : result.to}\uFF08\u4E8B\u4EF6 #${result.event}${result.task ? ` \xB7 ${result.task}` : ""}\uFF09
${result.why}`
        );
      recordNext(`\u5904\u7406\u5B8C\u8FD9\u6279\u4E8B\u4EF6\u540E\u786E\u8BA4\uFF1Aatrium events ack \u7F16\u53F7`);
    }
  }
};

// cli/org.ts
var client6 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var path2 = (value) => encodeURIComponent(value);
var as = (values) => {
  const who5 = str(values, "as") ?? defaultActor();
  return who5 ? `?as=${path2(who5)}` : "";
};
var options = { as: { type: "string" } };
var person = (value) => value === "u1" ? "\u4F60" : value === "secretary" ? "\u79D8\u4E66" : value ?? "\u65E0";
function formatOrgChanges(changes) {
  const value = (key, item) => key === "leader" && item === "u1" ? "\u4F60" : item == null || item === "" ? "\uFF08\u7A7A\uFF09" : typeof item === "string" ? item : JSON.stringify(item);
  const lines = [];
  for (const [key, change] of Object.entries(changes)) {
    if (key === "doc_path") continue;
    lines.push(
      `${key}\uFF1A${value(key, change.before)}\u2192 ${value(key, change.after)}`
    );
  }
  return lines.join("\n") || "\u65E0\u5B57\u6BB5\u53D8\u5316";
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
  const out3 = sent.running + sent.blocked + sent.todo + (sent.reviewing ?? 0) + (sent.merge_queued ?? 0) + (sent.merging ?? 0);
  if (out3)
    parts.push(`\u6295\u51FA ${out3}${sent.running ? `\uFF08\u5728\u505A ${sent.running}\uFF09` : ""}`);
  return parts.filter(Boolean).map((p) => ` \xB7 ${p}`).join("");
}
var KIND_LABEL = {
  org: "\u7EC4\u7EC7",
  project: "\u9879\u76EE",
  module: "\u6A21\u5757",
  concern: "\u5173\u6CE8\u70B9"
};
var reason = (values) => {
  const result = str(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason \u4E0D\u80FD\u4E3A\u7A7A");
  return result;
};
var out = (json, value, text, next) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(`\u52A8\u4F5C\uFF1A${next}`);
};
async function history(id, values, json) {
  const query = new URLSearchParams();
  for (const key of ["as", "rev", "before", "after", "limit"])
    if (str(values, key)) query.set(key, str(values, key));
  const result = await (await client6()).get(`/org/nodes/${path2(id)}/history?${query}`);
  if (result.revision) {
    out(
      json,
      result,
      `${id} \u4FEE\u8BA2\u8BE6\u60C5
${formatOrgChanges(result.changes ?? {})}`,
      `atrium org show ${id} --history`
    );
    return;
  }
  out(
    json,
    result,
    `${id} \u7684\u4FEE\u8BA2\uFF08\u65B0\u2192\u65E7\uFF09
${result.items?.map((r) => `r${r.rev} ${new Date(r.at).toLocaleString("zh-CN")} ${person(r.author)} \u2014\u2014 ${r.reason}`).join("\n") ?? ""}`,
    `atrium org show ${id}`
  );
}
var orgCommands = {
  "org tree": {
    args: "",
    about: "\u67E5\u770B\u7EC4\u7EC7\u6811",
    options,
    positionals: [0, 0],
    async run({ values, json }) {
      const rows = await (await client6()).get(`/org/tree${as(values)}`);
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
          (n) => `${"  ".repeat(depth(n))}${n.ref} [${labels[n.kind]}] ${n.name}${n.leader ? ` \xB7 leader ${person(n.leader)}${n.leader_state ? `\uFF08${n.leader_state.name}\uFF0C${wakeText(n.leader_state.wake)}\uFF09` : ""}` : ""}${formatCounts(n.tasks, n.sent)}${n.archived_at ? " \xB7 \u5DF2\u5F52\u6863" : ""}`
        ).join("\n") || "\u7EC4\u7EC7\u6811\u4E3A\u7A7A",
        rows.length ? "atrium org show o1" : "atrium org add org --kind org --name \u7EC4\u7EC7 --reason \u5EFA\u6811"
      );
    }
  },
  "org show": {
    args: "\u8282\u70B9 [--detail] [--history [--rev rN] [--before rN] [--after rN] [--limit N]]",
    about: "\u770B\u4E00\u4E2A\u90E8\u95E8\uFF1A\u5148\u8BB2\u4EBA\u8BDD\uFF08\u662F\u4EC0\u4E48\u3001\u80FD\u505A\u4EC0\u4E48\u3001\u600E\u4E48\u8D70\u5B8C\u3001\u4E0B\u8BBE\u54EA\u4E9B\u90E8\u95E8\u3001\u8981\u70B9\u3001\u73B0\u72B6\u4E0E\u9636\u6BB5\uFF09\uFF1B--detail \u53E6\u5217\u4ED3\u5E93\u3001\u4E0A\u7EA7\u7684\u8981\u70B9\u4E0E\u624B\u4E0A\u7684\u4EFB\u52A1\uFF1B\u6839\u8282\u70B9\u53E6\u7ED9\u4E24\u9879\u914D\u7F6E\uFF08\u7ED9\u4F60\u7559\u7684\u989D\u5EA6\u3001\u82B1\u8D39\u4E0A\u9650\uFF09\uFF1B--history \u770B\u4FEE\u8BA2\u5386\u53F2\uFF08\u540D\u79F0\u3001\u8DEF\u5F84\u540D\u3001leader\u3001\u4E0A\u7EA7\u3001\u4ED3\u5E93\u3001\u5F52\u6863\uFF09\uFF0C--rev \u770B\u4E00\u7248\u7684\u5B57\u6BB5\u5DEE\u5F02",
    options: {
      ...options,
      detail: { type: "boolean" },
      history: { type: "boolean" },
      rev: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      if (values.history === true || str(values, "rev"))
        return history(id, values, json);
      const node = await (await client6()).get(`/org/nodes/${path2(id)}${as(values)}`);
      const detail4 = values.detail === true;
      const lines = [
        titleOf(node, node.overview),
        `[${KIND_LABEL[node.kind] ?? node.kind}] ${node.path} \xB7 leader ${person(node.leader)}`,
        ...node.limits ? [
          `\u914D\u7F6E\uFF1A${limitText(node.limits) || "\u672A\u8BBE\uFF08\u7ED9\u4F60\u7559\u7684\u989D\u5EA6\u7F3A\u7701 20%\uFF09"}`
        ] : [],
        ...formatOverview(node, node.overview, detail4, node.points),
        ...detail4 ? [
          "\u2014\u2014 \u7EC6\u8282 \u2014\u2014",
          `\u4ED3\u5E93\uFF1A${node.repos.join("\u3001") || "\u65E0"}`,
          ...node.points_chain.filter((level) => level.node !== node.ref).flatMap(
            (level) => pointLines(level.points).map(
              (line3, i) => i === 0 ? `\u4E0A\u7EA7 ${level.node} ${level.name} \u7684${line3}` : line3
            )
          ),
          ...node.recent_tasks.length ? [
            `\u624B\u4E0A\u7684\u4EFB\u52A1\uFF08\u6700\u8FD1 ${node.recent_tasks.length} \u6761\uFF09`,
            ...node.recent_tasks.map(
              (t) => `  ${t.ref} [${t.delivery_stage === "reviewing" ? "\u5BA1\u9605\u4E2D" : t.delivery_stage === "merge_queued" ? "\u6392\u961F\u5408\u5165" : t.delivery_stage === "merging" ? "\u5408\u5165\u4E2D" : t.delivery_stage === "merged" ? "\u5DF2\u5408\u5165" : t.delivery_stage === "online" ? "\u5DF2\u4E0A\u7EBF" : t.status}] ${t.title}${t.worker ? ` \xB7 ${t.worker}` : ""}${t.origin_ref ? ` \xB7 ${t.origin_ref} \u6295\u6765` : ""}`
            )
          ] : []
        ] : [
          `\u7EC6\u8282\u5DF2\u6298\u53E0\uFF08\u4ED3\u5E93\u3001\u4E0A\u7EA7\u7684\u8981\u70B9\u3001\u624B\u4E0A\u7684\u4EFB\u52A1\uFF09\uFF1Aatrium org show ${node.ref} --detail`
        ]
      ];
      out(
        json,
        node,
        lines.join("\n"),
        isBlank(node.overview) ? `atrium map edit ${node.ref} --what \u4E00\u53E5\u8BDD` : `atrium org point-add ${node.ref} \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by \u8C01\u5B9A\u7684`
      );
    }
  },
  "org add": {
    args: "[\u7236\u8282\u70B9] slug [--name \u540D\u79F0] [--kind \u7C7B\u578B] [--what \u4E00\u53E5\u8BDD] [--alias \u4EBA\u8BDD\u540D] [--analogy \u7C7B\u6BD4] [--reason \u539F\u56E0] [--repo \u8DEF\u5F84] [--leader u1|aN]",
    about: "\u5728\u7236\u8282\u70B9\u4E0B\u52A0\u4E00\u4E2A\u90E8\u95E8\uFF08\u4E0D\u5199 --kind \u6309\u4E0A\u7EA7\u63A8\u65AD\uFF0C\u53EF\u540C\u65F6\u5199\u4E00\u53E5\u662F\u4EC0\u4E48\u3001\u4EBA\u8BDD\u540D\u4E0E\u7C7B\u6BD4\uFF09\uFF1Bslug \u662F\u8DEF\u5F84\u540D\uFF08\u5C0F\u5199\u82F1\u6570\u3001\u8FDE\u5B57\u7B26\u6216\u4E2D\u6587\uFF09\uFF1B\u53EA\u7ED9 slug\uFF08\u4E0D\u7ED9\u7236\u8282\u70B9\uFF09\u5EFA\u6839\uFF1Aatrium org add org --kind org --name \u7EC4\u7EC7 --reason \u5EFA\u6811",
    options: {
      ...options,
      kind: { type: "string" },
      name: { type: "string" },
      what: { type: "string" },
      alias: { type: "string" },
      analogy: { type: "string" },
      repo: { type: "string", multiple: true },
      leader: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 2],
    async run({ positionals, values, json }) {
      const [parent, slug] = positionals.length === 2 ? positionals : [void 0, positionals[0]];
      const repos = values.repo === void 0 ? [] : (Array.isArray(values.repo) ? values.repo : [values.repo]).map(
        (v) => resolve3(String(v))
      );
      if (parent !== void 0 && str(values, "kind") === void 0 && !repos.length && str(values, "leader") === void 0) {
        const result2 = await (await client6()).post(
          `/map/nodes${as(values)}`,
          {
            parent,
            name: str(values, "name") ?? slug,
            slug,
            ...Object.fromEntries(
              ["analogy", "alias", "what", "reason"].filter((k) => str(values, k) !== void 0).map((k) => [k, str(values, k)])
            )
          }
        );
        out(
          json,
          result2,
          `\u5DF2\u5728 ${result2.parent} \u4E0B\u52A0\u4E86 ${result2.node} ${result2.name}\uFF08${result2.kind}\uFF09`,
          `atrium map edit ${result2.node} --what \u4E00\u53E5\u8BDD --uses \u573A\u666F --flow \u6B65\u9AA4`
        );
        return;
      }
      const result = await (await client6()).post(
        `/org/nodes${as(values)}`,
        {
          parent,
          slug,
          kind: str(values, "kind"),
          name: str(values, "name") ?? slug,
          leader: str(values, "leader"),
          repos,
          reason: reason(values)
        }
      );
      out(
        json,
        result,
        `\u5DF2\u65B0\u5EFA o${result.id} [${result.kind}] ${result.name}`,
        `atrium map edit o${result.id} --what \u4E00\u53E5\u8BDD`
      );
    }
  },
  "org edit": {
    args: "\u8282\u70B9 [--name \u540D\u79F0] [--slug \u8DEF\u5F84\u540D] [--leader aN|none] [--parent \u8282\u70B9] [--repo \u8DEF\u5F84] [--archive] [--rev rN] [--reason \u539F\u56E0]",
    about: "\u7F16\u8F91\u8282\u70B9\uFF08\u540D\u79F0\u3001\u8DEF\u5F84\u540D\u3001leader\u3001\u4E0A\u7EA7\u3001\u4ED3\u5E93\u3001\u5F52\u6863\uFF09\uFF0C\u7559\u8282\u70B9\u4FEE\u8BA2",
    options: {
      ...options,
      slug: { type: "string" },
      name: { type: "string" },
      leader: { type: "string" },
      parent: { type: "string" },
      repo: { type: "string", multiple: true },
      archive: { type: "boolean" },
      rev: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const input = {
        reason: reason(values),
        rev: str(values, "rev"),
        slug: str(values, "slug"),
        name: str(values, "name"),
        leader: str(values, "leader"),
        parent: str(values, "parent"),
        repos: values.repo === void 0 ? void 0 : (Array.isArray(values.repo) ? values.repo : [values.repo]).map(
          (repo) => resolve3(String(repo))
        ),
        archive: values.archive === true
      };
      if (!input.slug && !input.name && !input.leader && !input.parent && !input.repos && !input.archive)
        throw new Problem(400, "org edit \u9700\u6307\u5B9A\u8981\u4FEE\u6539\u7684\u5B57\u6BB5");
      const result = await (await client6()).patch(`/org/nodes/${path2(id)}${as(values)}`, input);
      out(
        json,
        result,
        `\u5DF2\u66F4\u65B0 ${id} \u8282\u70B9 \u2192 ${result.rev}`,
        `atrium org show ${id} --history`
      );
    }
  },
  "org limits": {
    args: "[--quota-reserve \u767E\u5206\u6BD4] [--money-max \u5143]",
    about: "\u770B\u6216\u6539\u6839\u8282\u70B9\u7684\u4E24\u9879\u914D\u7F6E\uFF1A\u6BCF\u4E2A\u8BA2\u9605\u8D26\u53F7\u7ED9\u4F60\u7559\u7684\u989D\u5EA6\uFF08\u7F3A\u7701 20%\uFF09\u3001\u82B1\u8D39\u4E0A\u9650\uFF08\u5143\uFF09\uFF1B\u53EA\u6709\u4F60\u80FD\u6539\u3002\u89C4\u77E9\u4E0D\u5199\u5728\u8FD9\u91CC\uFF0C\u5199\u6210\u8981\u70B9",
    options: {
      "quota-reserve": { type: "string" },
      "money-max": { type: "string" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const body = {};
      if (str(values, "quota-reserve") !== void 0)
        body.quota_reserve_percent = Number(str(values, "quota-reserve"));
      if (str(values, "money-max") !== void 0)
        body.money_yuan_max = Number(str(values, "money-max"));
      const api2 = await client6();
      const result = Object.keys(body).length ? await api2.put("/org/limits", body) : await api2.get("/org/limits");
      out(
        json,
        result,
        limitText(result) || "\u672A\u8BBE\uFF08\u7ED9\u4F60\u7559\u7684\u989D\u5EA6\u7F3A\u7701 20%\uFF0C\u82B1\u8D39\u4E0A\u9650\u672A\u5199\uFF09",
        "atrium org limits --quota-reserve 20 --money-max 0"
      );
    }
  },
  "org point-add": {
    args: "\u8282\u70B9 \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by \u8C01\u5B9A\u7684 [--check \u68C0\u67E5] [--pos N] [--as aN]",
    about: "\u7ED9\u4E00\u4E2A\u90E8\u95E8\u52A0\u4E00\u6761\u8981\u70B9\uFF08\u89C4\u77E9\u53EA\u5199\u8FD9\u91CC\uFF1A\u7528\u6237\u7684\u539F\u5219\u3001\u53E3\u5473\u3001\u53D6\u820D\u4E0E\u8FD9\u4E00\u5757\u5FC5\u987B\u5B88\u4F4F\u7684\u7EA6\u675F\uFF09\uFF1A\u4EBA\u8BDD\u4E00\u53E5\u3001\u4E3A\u4EC0\u4E48\u3001\u8C01\u5B9A\u7684\uFF08\u5982 u1 09-27\uFF09\uFF0C\u53EF\u9009\u5B88\u62A4\u5B83\u7684\u68C0\u67E5\uFF08\u6D4B\u8BD5\u6587\u4EF6\u4E0E\u7528\u4F8B\u540D\uFF0C\u6216 $ \u547D\u4EE4\uFF09\uFF1B\u6309\u6811\u5F80\u4E0B\u7EE7\u627F\uFF0C\u8DE8\u51E0\u5757\u7684\u653E\u5171\u540C\u4E0A\u7EA7\uFF1B--pos \u6392\u5728\u7B2C\u51E0\u6761\uFF081 \u6700\u91CD\u8981\uFF0C\u51B2\u7A81\u65F6\u9760\u524D\u7684\u4F18\u5148\uFF09\uFF0C\u4E0D\u5199\u6392\u6700\u540E\uFF1B\u4E0D\u7559\u4FEE\u8BA2\u8BB0\u5F55",
    options: {
      ...options,
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
      pos: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [id, text], values, json }) {
      const result = await (await client6()).post(`/org/nodes/${path2(id)}/points${as(values)}`, {
        text,
        ...str(values, "why") === void 0 ? {} : { why: str(values, "why") },
        ...str(values, "by") === void 0 ? {} : { by: str(values, "by") },
        ...str(values, "check") === void 0 ? {} : { check: str(values, "check") },
        ...str(values, "pos") === void 0 ? {} : { pos: str(values, "pos") }
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
    args: "kN [--text \u8981\u70B9] [--why \u4E3A\u4EC0\u4E48] [--by \u8C01\u5B9A\u7684] [--check \u68C0\u67E5|''] [--pos N] [--rm] [--as aN]",
    about: "\u6539\u4E00\u6761\u8981\u70B9\uFF1B--check '' \u53BB\u6389\u68C0\u67E5\uFF1B--pos \u632A\u5230\u672C\u90E8\u95E8\u7B2C\u51E0\u6761\uFF081 \u6700\u91CD\u8981\uFF0C\u51B2\u7A81\u65F6\u9760\u524D\u7684\u4F18\u5148\uFF09\uFF1B--rm \u5220\u6389\u8FD9\u6761\u8FC7\u65F6\u7684\u8981\u70B9\uFF08\u4E0D\u7559\u4FEE\u8BA2\u8BB0\u5F55\uFF09",
    options: {
      ...options,
      rm: { type: "boolean" },
      text: { type: "string" },
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
      pos: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      if (values.rm === true) {
        const result2 = await (await client6()).delete(`/org/points/${path2(id)}${as(values)}`);
        out(
          json,
          result2,
          `\u5DF2\u5220 ${result2.ref}\uFF08${result2.node}\uFF09\uFF1A${result2.text}`,
          `atrium org show ${result2.node}`
        );
        return;
      }
      const body = {};
      for (const key of ["text", "why", "by", "check", "pos"])
        if (str(values, key) !== void 0) body[key] = str(values, key);
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "\u81F3\u5C11\u6539\u4E00\u9879\uFF1A--text\u3001--why\u3001--by\u3001--check\u3001--pos",
          "usage"
        );
      const result = await (await client6()).patch(`/org/points/${path2(id)}${as(values)}`, body);
      out(
        json,
        result,
        `\u5DF2\u6539 ${result.ref}\uFF08${result.node}\uFF09\uFF1A${result.text}`,
        `atrium org show ${result.node}`
      );
    }
  }
};

// cli/skills.ts
import {
  existsSync as existsSync2,
  lstatSync,
  mkdirSync,
  readFileSync as readFileSync3,
  readdirSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve as resolve4 } from "node:path";
var client7 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var path3 = (value) => encodeURIComponent(value);
var as2 = (values) => {
  const who5 = str(values, "as") ?? defaultActor();
  return who5 ? `?as=${path3(who5)}` : "";
};
var options2 = { as: { type: "string" } };
var person2 = (value) => value === "u1" ? "\u4F60" : value === "secretary" ? "\u79D8\u4E66" : value ?? "\u65E0";
var out2 = (json, value, text, next) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(`\u52A8\u4F5C\uFF1A${next}`);
};
var reason2 = (values) => {
  const result = str(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason \u4E0D\u80FD\u4E3A\u7A7A");
  return result;
};
function readSkillSource(source) {
  const root = resolve4(source);
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    throw new Problem(400, `\u6280\u80FD\u6765\u6E90\u8BFB\u4E0D\u5230\uFF1A${root}`);
  }
  if (stat.isFile()) return { "SKILL.md": readFileSync3(root, "utf8") };
  if (!stat.isDirectory())
    throw new Problem(400, `\u6280\u80FD\u6765\u6E90\u5E94\u4E3A SKILL.md \u6587\u4EF6\u6216\u76EE\u5F55\uFF1A${root}`);
  const files = {};
  let bytes = 0;
  const walk = (dir, prefix) => {
    for (const entry2 of readdirSync(dir, { withFileTypes: true })) {
      if (entry2.name.startsWith(".") || entry2.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry2.name}` : entry2.name;
      const full = join(dir, entry2.name);
      if (entry2.isDirectory()) walk(full, rel);
      else if (entry2.isFile()) {
        if (Object.keys(files).length >= 64)
          throw new Problem(400, `${root} \u6587\u4EF6\u592A\u591A\uFF1A\u6280\u80FD\u6700\u591A 32 \u4E2A\u6587\u4EF6`);
        bytes += lstatSync(full).size;
        if (bytes > 1024 * 1024)
          throw new Problem(400, `${root} \u592A\u5927\uFF1A\u6280\u80FD\u5408\u8BA1\u6700\u591A 256 KB`);
        files[rel] = readFileSync3(full, "utf8");
      }
    }
  };
  walk(root, "");
  if (!files["SKILL.md"]) throw new Problem(400, `${root} \u4E0B\u6CA1\u6709 SKILL.md`);
  return files;
}
function exportTo(target2, files) {
  const root = resolve4(target2);
  if (existsSync2(root) && readdirSync(root).length)
    throw new Problem(400, `--out \u76EE\u5F55\u4E0D\u662F\u7A7A\u7684\uFF1A${root}`);
  for (const [rel, content] of Object.entries(files)) {
    const file2 = join(root, ...rel.split("/"));
    mkdirSync(dirname(file2), { recursive: true });
    writeFileSync(file2, content);
  }
  return root;
}
var printDiff = (lines) => {
  const shown = lines.slice(0, 200).map((line3) => line3.length > 300 ? `${line3.slice(0, 300)}\u2026` : line3);
  if (lines.length > 200) shown.push(`\u2026\u7701\u7565 ${lines.length - 200} \u884C`);
  return shown.join("\n") || "\uFF08\u65E0\u6587\u4EF6\u53D8\u5316\uFF09";
};
async function history2(slug, values, json) {
  const query = new URLSearchParams();
  for (const key of ["rev", "before", "limit"])
    if (str(values, key)) query.set(key, str(values, key));
  const result = await (await client7()).get(`/skills/${path3(slug)}/history?${query}`);
  const line3 = (r) => `${r.rev} ${new Date(r.at).toLocaleString("zh-CN")} ${person2(r.author)}${r.reviewer ? `\uFF08${person2(r.reviewer)} \u5BA1\u6838\uFF09` : ""} \u2014\u2014 ${r.reason}${r.source ? ` \xB7 \u51FA\u5904 ${r.source}` : ""}`;
  if (result.revision) {
    out2(
      json,
      result,
      [
        `${result.slug} ${line3(result.revision)}`,
        ...(result.meta ?? []).map(
          (m) => `${m.field}\uFF1A${String(m.before ?? "\uFF08\u7A7A\uFF09")} \u2192 ${String(m.after ?? "\uFF08\u7A7A\uFF09")}`
        ),
        printDiff(result.diff ?? [])
      ].join("\n"),
      `atrium skill show ${result.slug} --history`
    );
    return;
  }
  const items = result.items ?? [];
  out2(
    json,
    result,
    [
      `${result.slug} \u7684\u4FEE\u8BA2\uFF08\u65B0\u2192\u65E7\uFF09`,
      ...items.map(line3),
      ...result.has_more ? ["\u8FD8\u6709\u66F4\u65E9\u7684\u4FEE\u8BA2"] : []
    ].join("\n"),
    result.has_more ? `atrium skill show ${result.slug} --history --before ${items.at(-1).rev}` : `atrium skill show ${result.slug} --history --rev ${items[0]?.rev ?? "r1"}`
  );
}
var skillCommands = {
  "skill ls": {
    args: "[--all]",
    about: "\u5217\u51FA\u7EC4\u7EC7\u6280\u80FD\uFF08--all \u542B\u5DF2\u5F52\u6863\uFF09",
    options: { ...options2, all: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const rows = await (await client7()).get(`/skills${values.all ? "?archived=1" : ""}`);
      out2(
        json,
        rows,
        rows.length ? rows.map(
          (s) => `${s.slug} ${s.rev}${s.archived ? " \xB7 \u5DF2\u5F52\u6863" : ""} \xB7 owner ${s.owner ?? "\u4F60"} \xB7 \u7ED1\u5B9A ${s.bound.join("\u3001") || "\u65E0"}
  ${s.description}`
        ).join("\n") : "\u8FD8\u6CA1\u6709\u6280\u80FD",
        rows.length ? `atrium skill show ${rows[0].slug}` : "atrium skill add <slug> <\u76EE\u5F55\u6216SKILL.md> --reason \u539F\u56E0"
      );
    }
  },
  "skill show": {
    args: "slug [--out \u76EE\u5F55] [--history [--rev rN] [--before rN] [--limit N]]",
    about: "\u67E5\u770B\u6280\u80FD\u5185\u5BB9\u4E0E\u7ED1\u5B9A\uFF1B--out \u5BFC\u51FA\u6587\u4EF6\u4EE5\u4FBF\u4FEE\u6539\uFF1B--history \u770B\u4FEE\u8BA2\u4E0E\u6765\u6E90\uFF0C--rev \u770B\u8BE5\u4FEE\u8BA2\u7684\u5DEE\u5F02",
    options: {
      ...options2,
      out: { type: "string" },
      history: { type: "boolean" },
      rev: { type: "string" },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      if (values.history === true || str(values, "rev"))
        return history2(slug, values, json);
      const skill = await (await client7()).get(`/skills/${path3(slug)}`);
      if (str(values, "out")) {
        const root = exportTo(str(values, "out"), skill.files);
        out2(
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
        "",
        skill.files["SKILL.md"] ?? ""
      ];
      out2(
        json,
        skill,
        lines.join("\n").trimEnd(),
        `atrium skill show ${skill.slug} --history`
      );
    }
  },
  "skill add": {
    args: "slug \u76EE\u5F55\u6216SKILL.md [--description \u7B80\u4ECB] [--name \u540D\u79F0] [--owner \u8282\u70B9] [--source \u51FA\u5904] [--reason \u539F\u56E0]",
    about: "\u65B0\u5EFA\u7EC4\u7EC7\u6280\u80FD\uFF08owner \u9ED8\u8BA4\u7EC4\u7EC7\u6839\u8282\u70B9\uFF09",
    options: {
      ...options2,
      description: { type: "string" },
      name: { type: "string" },
      owner: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [slug, source], values, json }) {
      const result = await (await client7()).post(`/skills${as2(values)}`, {
        slug,
        files: readSkillSource(source),
        description: str(values, "description"),
        name: str(values, "name"),
        owner: str(values, "owner"),
        source: str(values, "source"),
        reason: reason2(values)
      });
      out2(
        json,
        result,
        `\u5DF2\u65B0\u5EFA\u6280\u80FD ${result.slug} ${result.rev}\uFF08${result.files} \u4E2A\u6587\u4EF6\uFF0Cowner ${result.owner ?? "\u4F60"}\uFF09\uFF0C\u8FD8\u6CA1\u7ED1\u5230\u4EFB\u4F55\u8282\u70B9`,
        `atrium skill edit ${result.slug} --bind <\u8282\u70B9>`
      );
    }
  },
  "skill edit": {
    args: "slug [\u76EE\u5F55\u6216SKILL.md] [--name \u540D\u79F0] [--owner \u8282\u70B9] [--archive|--restore] [--to rN] [--bind \u8282\u70B9] [--unbind \u8282\u70B9] [--rev rN] [--source \u51FA\u5904] [--reason \u539F\u56E0]",
    about: "\u4FEE\u6539\u6280\u80FD\u5E76\u8FFD\u52A0\u4FEE\u8BA2\uFF1B--to \u6062\u590D\u65E7\u4FEE\u8BA2\u7684\u5185\u5BB9\uFF1B--bind \u6302\u5230\u8282\u70B9\uFF08\u6D3E\u5230\u8BE5\u8282\u70B9\u53CA\u5B50\u8282\u70B9\u7684\u4EFB\u52A1\u90FD\u5E26\u4E0A\uFF09\uFF0C--unbind \u4ECE\u8282\u70B9\u53D6\u4E0B\uFF1B\u7528\u6237\u7EA0\u6B63\u5199 --reason \u7528\u6237\u7EA0\u6B63\u2026 --source \u51FA\u5904",
    options: {
      ...options2,
      name: { type: "string" },
      owner: { type: "string" },
      archive: { type: "boolean" },
      restore: { type: "boolean" },
      to: { type: "string" },
      bind: { type: "string" },
      unbind: { type: "string" },
      rev: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" }
    },
    positionals: [1, 2],
    async run({ positionals: [slug, source], values, json }) {
      for (const flag of ["bind", "unbind"]) {
        const node = str(values, flag);
        if (node === void 0) continue;
        const result2 = await (await client7()).post(
          `/skills/${path3(slug)}/${flag}${as2(values)}`,
          { node }
        );
        out2(
          json,
          result2,
          flag === "bind" ? `\u5DF2\u628A ${result2.slug} \u6302\u5230 ${result2.node}\uFF1B\u4E4B\u540E\u6D3E\u5230\u8FD9\u91CC\uFF08\u542B\u5B50\u8282\u70B9\uFF09\u7684\u4EFB\u52A1\u90FD\u4F1A\u5E26\u4E0A` : `\u5DF2\u4ECE ${result2.node} \u53D6\u4E0B ${result2.slug}`,
          `atrium skill show ${result2.slug}`
        );
        return;
      }
      if (str(values, "to")) {
        const result2 = await (await client7()).post(
          `/skills/${path3(slug)}/revert${as2(values)}`,
          { to: str(values, "to"), reason: reason2(values) }
        );
        out2(
          json,
          result2,
          `\u5DF2\u628A ${result2.slug} \u6062\u590D\u5230 ${result2.to} \u7684\u5185\u5BB9\uFF0C${result2.before} \u2192 ${result2.rev}`,
          `atrium skill show ${result2.slug} --history`
        );
        return;
      }
      if (values.archive && values.restore)
        throw new Problem(400, "--archive \u4E0E --restore \u53EA\u80FD\u9009\u4E00\u4E2A");
      const input = {
        reason: reason2(values),
        rev: str(values, "rev"),
        name: str(values, "name"),
        owner: str(values, "owner"),
        source: str(values, "source"),
        ...values.archive ? { archive: true } : {},
        ...values.restore ? { archive: false } : {}
      };
      if (source) input.files = readSkillSource(source);
      if (!source && input.name === void 0 && input.owner === void 0 && input.archive === void 0)
        throw new Problem(
          400,
          "skill edit \u9700\u7ED9\u51FA\u65B0\u5185\u5BB9\uFF08\u76EE\u5F55\u6216 SKILL.md\uFF09\uFF0C\u6216 --name\u3001--owner\u3001--archive\u3001--restore\u3001--to\u3001--bind\u3001--unbind \u4E4B\u4E00"
        );
      const result = await (await client7()).put(
        `/skills/${path3(slug)}${as2(values)}`,
        input
      );
      out2(
        json,
        result,
        `\u5DF2\u66F4\u65B0\u6280\u80FD ${result.slug} ${result.before} \u2192 ${result.rev}\uFF1B\u4E0B\u6B21\u6D3E\u6D3B\u751F\u6548`,
        `atrium skill show ${result.slug} --history`
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
  (_, status4) => ` ${STATUS2[status4] ?? status4}`
);
var labelOf = (task) => tagTitle(priorityTag(task.priority), task.title);
var tier = (task) => rank(task.priority ?? "normal");
var idOf = (ref3) => Number(ref3.slice(1)) || 0;
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
    const ref3 = `${wide ? pr.repo : pr.repo.split("/").pop()}#${pr.number}`;
    if (pr.merged) met.push(ref3);
    else open.push(`${ref3} \u5408\u5165${pr.error ? "\uFF08\u67E5\u8BE2\u5931\u8D25\uFF09" : ""}`);
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
  const owner = task.owner ?? "secretary";
  return goal + (wide ? [item.node_path ?? task.node_ref, auto, owner].filter(Boolean).join(" \xB7 ") : `${task.auto ? "\u81EA\u52A8" : "\u624B\u52A8"} \xB7 ${owner}`);
}
var upstreamRefs = (entry2) => entry2.upstream ? entry2.upstream.map((dep) => dep.ref) : entry2.waiting_for.map((text) => /^(t[1-9][0-9]*)\b/.exec(text)?.[1]).filter((ref3) => !!ref3);
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
    plan2.totals ? plan2.totals.map((total) => [
      total.ref,
      {
        task: {
          ref: total.ref,
          title: total.title,
          status: "todo",
          worker: null,
          started_at: null,
          parent_ref: total.parent_ref,
          owner: null,
          auto: 0,
          part_ref: total.part_ref
        },
        waiting_for: [],
        reason: null,
        group: "waiting",
        ref: total.ref
      }
    ]) : all2.filter(
      (item) => item.group !== "running" && (item.open_children !== void 0 ? item.open_children > 0 : childParents.has(item.ref))
    ).map((item) => [item.ref, item])
  );
  const items = new Map(
    all2.filter((item) => !parents.has(item.ref)).map((item) => [item.ref, item])
  );
  const ups = /* @__PURE__ */ new Map();
  const downs = /* @__PURE__ */ new Map();
  for (const item of items.values()) {
    const list3 = upstreamRefs(item).filter((ref3) => items.has(ref3));
    ups.set(item.ref, list3);
    for (const ref3 of list3)
      downs.set(ref3, [...downs.get(ref3) ?? [], item.ref]);
  }
  const chainOf = /* @__PURE__ */ new Map();
  for (const item of [...items.values()].sort(byRef)) {
    if (chainOf.has(item.ref)) continue;
    const members = [];
    const stack = [item.ref];
    while (stack.length) {
      const ref3 = stack.pop();
      if (members.includes(ref3)) continue;
      members.push(ref3);
      stack.push(...ups.get(ref3) ?? [], ...downs.get(ref3) ?? []);
    }
    for (const ref3 of members) chainOf.set(ref3, members);
  }
  const chains = [...new Set(chainOf.values())].filter((members) => members.length > 1).map((members) => members.sort((a, b) => idOf(a) - idOf(b)));
  const inChain = new Set(chains.flat());
  const alone = [...items.values()].filter((item) => !inChain.has(item.ref)).sort(byRef);
  const ready = alone.filter((item) => item.group === "ready").sort((a, b) => tier(a.task) - tier(b.task) || byRef(a, b));
  const waiting = alone.filter((item) => item.group === "waiting");
  const blocked = alone.filter(
    (item) => item.group === "blocked" && scheduleBlocked(item)
  );
  const shared = planCounts(plan2.groups);
  const counts3 = {
    ready: shared.ready,
    waiting: shared.waiting,
    blocked: shared.schedule_blocked
  };
  const refW = Math.max(3, ...[...items.keys()].map(width));
  const rows = [];
  const depthOf2 = (ref3, members, seen = /* @__PURE__ */ new Set()) => {
    if (seen.has(ref3)) return 0;
    seen.add(ref3);
    const list3 = (ups.get(ref3) ?? []).filter((up) => members.has(up));
    return list3.length ? 1 + Math.max(...list3.map((up) => depthOf2(up, members, new Set(seen)))) : 0;
  };
  const section = (label2, list3, base) => {
    if (!list3.length) return [];
    return [{ heading: label2, rows: grouped(list3, base) }];
  };
  const grouped = (list3, base) => {
    const out3 = [];
    const groups2 = /* @__PURE__ */ new Map();
    for (const item of list3) {
      const key = item.task.parent_ref && parents.has(item.task.parent_ref) ? item.task.parent_ref : "";
      groups2.set(key, [...groups2.get(key) ?? [], item]);
    }
    for (const key of [...groups2.keys()].sort((a, b) => idOf(a) - idOf(b))) {
      if (key) out3.push({ indent: -base, item: parents.get(key) });
      for (const item of groups2.get(key))
        out3.push({ indent: base + (key ? 1 : 0), item });
    }
    return out3;
  };
  const blocks = [...section("\u5C31\u7EEA", ready, 1)];
  for (const members of chains) {
    const set2 = new Set(members);
    const depth = new Map(members.map((ref3) => [ref3, depthOf2(ref3, set2)]));
    const holder = (ref3) => (ups.get(ref3) ?? []).filter((up) => set2.has(up)).sort((a, b) => depth.get(b) - depth.get(a) || idOf(a) - idOf(b))[0];
    const kids = /* @__PURE__ */ new Map();
    for (const ref3 of members) {
      const up = holder(ref3);
      if (up) kids.set(up, [...kids.get(up) ?? [], ref3]);
    }
    const deepest = [...members].sort(
      (a, b) => depth.get(b) - depth.get(a) || idOf(a) - idOf(b)
    )[0];
    const path5 = [deepest];
    for (let up = holder(deepest); up; up = holder(up)) path5.unshift(up);
    const more = members.length - path5.length;
    const root = items.get(path5[0]);
    const group = root.task.parent_ref && parents.has(root.task.parent_ref) ? parents.get(root.task.parent_ref) : void 0;
    const base = group ? 2 : 1;
    const chainRows = [];
    if (group) chainRows.push({ indent: -1, item: group });
    const walk = (ref3, level) => {
      chainRows.push({ indent: base + level, item: items.get(ref3) });
      for (const kid of (kids.get(ref3) ?? []).sort((a, b) => idOf(a) - idOf(b)))
        walk(kid, level + 1);
    };
    for (const ref3 of members.filter((ref4) => !holder(ref4))) walk(ref3, 0);
    blocks.push({
      heading: `\u4F9D\u8D56\u94FE ${path5.join(" \u2192 ")}${more > 0 ? `\uFF08\u53E6\u6709 ${more} \u9879\uFF09` : ""}`,
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
        const indent = "  ".repeat(-row.indent);
        lines.push({
          text: fit(
            `${indent}\u25B8 ${row.item.ref} ${row.item.task.title}${row.item.task.part_ref ?? row.item.task.goal_ref ? ` \xB7 ${row.item.task.part_ref ?? row.item.task.goal_ref}` : ""}`,
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
      ...lines.map((line3) => line3.text),
      ...paged ? [fit(`  \u2026\u6392\u671F\u4E0D\u6B62\u4E00\u9875\uFF0C${hint}`, frame.width)] : []
    ];
  const shown = lines.slice(0, max - 1);
  const seen = new Set(shown.map((line3) => line3.item).filter(Boolean));
  const hidden = new Set(
    lines.slice(max - 1).map((line3) => line3.item).filter((item) => !!item && !seen.has(item))
  ).size;
  return [
    ...shown.map((line3) => line3.text),
    fit(
      `  \u2026\u8FD8\u6709 ${hidden} \u6761${paged ? "\uFF08\u4E0D\u6B62\u4E00\u9875\uFF09" : ""}\uFF0C${hint}`,
      frame.width
    )
  ];
}
function fit(text, max) {
  if (width(text) <= max) return text;
  let out3 = "";
  for (const char of text) {
    if (width(out3 + char) > max - 1) break;
    out3 += char;
  }
  return `${out3}\u2026`;
}

// cli/map.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { resolve as resolve5 } from "node:path";
var list = (values, key) => {
  const value = values[key];
  if (value === void 0) return void 0;
  return (Array.isArray(value) ? value : [value]).map(String);
};
var client8 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var enc2 = encodeURIComponent;
var as3 = (values) => {
  const who5 = str(values, "as") ?? defaultActor();
  return who5 ? `?as=${enc2(who5)}` : "";
};
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
function renderMapTree(tree2, options3 = {}) {
  const lines = [];
  const walk = (node, level) => {
    if (node.archived) return;
    const indent = "  ".repeat(level);
    const line3 = `${indent}${DOT[node.dot]} ${label(node)}${counts2(node.tasks)}`;
    lines.push(options3.width ? fit(line3, options3.width) : line3);
    if (options3.what !== false && node.what && level <= 1)
      lines.push(
        options3.width ? fit(`${indent}  ${node.what}`, options3.width) : `${indent}  ${node.what}`
      );
    const kids = (node.children ?? []).filter((c) => !c.archived);
    if (node.children) for (const child of kids) walk(child, level + 1);
    else if (node.children_count)
      lines.push(
        `${indent}  \u2026\u4E0B\u5C42 ${node.children_count} \u5757\uFF1Aatrium map ${node.ref} --depth 2`
      );
    if (node.children && node.children.length < node.children_count)
      lines.push(
        `${indent}  \u2026\u8FD8\u6709 ${node.children_count - node.children.length} \u5757\u8FD9\u6B21\u6CA1\u5C55\u5F00\uFF1Aatrium map ${node.ref} --depth 1`
      );
  };
  walk(tree2, 0);
  return lines;
}
function renderTopMap(tree2, width2, depth = 2, maxLines = 20) {
  const lines = ["\u5168\u666F"];
  if (!tree2) return [...lines, "  \u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811\uFF1Aatrium org import --repo \u4ED3\u5E93"];
  const walk = (nodes2, level) => {
    for (const node of nodes2) {
      if (node.archived) continue;
      const indent = "  ".repeat(level + 1);
      const what = node.what ? ` \xB7 ${node.what}` : "";
      lines.push(
        fit(
          `${indent}${DOT[node.dot]} ${label({ ...node, analogy: "" })}${counts2(node.tasks)}${what}`,
          width2
        )
      );
      if (level + 1 < depth && node.children) walk(node.children, level + 1);
    }
  };
  walk(tree2.children ?? [], 0);
  if (lines.length === 1)
    lines.push("  \u8FD8\u6CA1\u6709\u4E0B\u4E00\u5C42\uFF1Aatrium org add \u7236\u8282\u70B9 \u8DEF\u5F84\u540D --name \u540D\u79F0");
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
  const value = str(values, "depth");
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
            "atrium org add org --kind org --name \u7EC4\u7EC7 --reason \u5EFA\u6811"
          );
        const result = await api2.get(
          `/map/nodes/${enc2(root)}?depth=${depthOf(values, 1)}`
        );
        printJson(result);
        recordNext(`\u52A8\u4F5C\uFF1Aatrium map context ${result.ref}`);
        return 0;
      }
      const tree2 = await api2.get(
        `/map/tree?depth=${depthOf(values, 2)}${node ? `&root=${enc2(node)}` : ""}`
      );
      const lines = tree2.tree ? renderMapTree(tree2.tree, {
        width: process.stdout.isTTY ? process.stdout.columns : void 0
      }) : [
        "\u8FD8\u6CA1\u6709\u7EC4\u7EC7\u6811\uFF1Aatrium org add org --kind org --name \u7EC4\u7EC7 --reason \u5EFA\u6811"
      ];
      const login = await api2.post(
        "/map/login"
      );
      const record = readService(dataDirectory());
      if (!record)
        throw new Problem(503, "\u627E\u4E0D\u5230\u670D\u52A1\u5730\u5740", "service_unavailable");
      const url = `${serviceUrl(record)}${login.path}${tree2.root ? `&node=${tree2.root}` : ""}`;
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
      recordNext(`\u52A8\u4F5C\uFF1Aatrium map ${tree2.root ?? "\u8282\u70B9"} --json`);
      return 0;
    }
  },
  "map context": {
    args: "\u8282\u70B9 [--max \u5B57\u6570]",
    about: "\u7ED9\u51FA\u4ECE\u6839\u5230\u8FD9\u4E2A\u90E8\u95E8\u94FE\u4E0A\u7684\u8981\u70B9\uFF08\u6309\u6811\u4ECE\u4E0A\u5230\u4E0B\u3001\u540C\u4E00\u5C42\u6309\u6392\u5E8F\uFF0C\u51B2\u7A81\u65F6\u9760\u524D\u7684\u4F18\u5148\uFF09\u4E0E\u7528\u5230\u7684\u6280\u80FD\uFF0C\u6709\u5B57\u6570\u4E0A\u9650\uFF1B\u6D3E\u6D3B\u4E0E leader \u5524\u9192\u9644\u7684\u5C31\u662F\u8FD9\u4E00\u6BB5",
    options: { max: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const query = new URLSearchParams(
        Object.fromEntries(
          ["max"].filter((k) => str(values, k) !== void 0).map((k) => [k, str(values, k)])
        )
      ).toString();
      const result = await (await client8()).get(`/map/context/${enc2(node)}${query ? `?${query}` : ""}`);
      if (json) printJson(result);
      else
        console.log(
          result.text || `${result.ref} \u548C\u5B83\u7684\u4E0A\u7EA7\u90FD\u8FD8\u6CA1\u6709\u8981\u70B9\uFF1Aatrium org point-add ${result.ref} \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by \u8C01\u5B9A\u7684`
        );
      recordNext(`\u52A8\u4F5C\uFF1Aatrium task add \u6807\u9898 --part ${result.ref}`);
      return 0;
    }
  },
  "map edit": {
    args: "\u8282\u70B9 [--what \u4E00\u53E5\u8BDD] [--uses \u573A\u666F]\u2026 [--flow \u6B65\u9AA4]\u2026 [--alias \u4EBA\u8BDD\u540D] [--analogy \u7C7B\u6BD4] [--now \u73B0\u72B6] [--next \u63A5\u4E0B\u6765] [--stages \u6587\u4EF6] [--as aN]",
    about: "\u6539\u4E00\u5757\u7684\u4EBA\u8BDD\u5B57\u6BB5\uFF0C\u76F4\u63A5\u8986\u76D6\u4E14\u4E0D\u7559\u4FEE\u8BA2\uFF1B\u7ED9\u7A7A\u4E32\u6E05\u6389\uFF1B--stages \u7ED9 YAML \u6216 JSON \u7684\u9636\u6BB5\u5217\u8868\uFF08\u4E5F\u53EF\u5199\u6210 stages: \u5217\u8868\uFF09\uFF0C\u6574\u4EFD\u66FF\u6362\uFF1B\u8D1F\u8D23\u7684 leader \u6216\u5176\u4E0A\u7EA7\u53EF\u6539\uFF0C\u6839\u53EA\u6709\u4F60\u80FD\u6539",
    options: {
      what: { type: "string" },
      uses: { type: "string", multiple: true },
      flow: { type: "string", multiple: true },
      alias: { type: "string" },
      analogy: { type: "string" },
      now: { type: "string" },
      next: { type: "string" },
      stages: { type: "string" },
      as: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const file2 = str(values, "stages");
      let stages;
      if (file2 !== void 0) {
        let text;
        try {
          text = readFileSync4(resolve5(file2), "utf8");
        } catch (error) {
          throw new Problem(
            400,
            `--stages: \u8BFB\u4E0D\u4E86 ${file2}\uFF08${error.code ?? "\u672A\u77E5\u9519\u8BEF"}\uFF09`,
            "usage"
          );
        }
        const { default: YAML } = await import("yaml");
        let parsed;
        try {
          parsed = YAML.parse(text);
        } catch (error) {
          throw new Problem(
            400,
            `--stages \u4E0D\u662F\u5408\u6CD5\u7684 YAML/JSON\uFF1A${error.message.split("\n")[0]}`,
            "usage"
          );
        }
        stages = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.stages : parsed) ?? [];
      }
      const input = {
        ...Object.fromEntries(
          ["what", "alias", "analogy", "now", "next"].filter((k) => str(values, k) !== void 0).map((k) => [k, str(values, k)])
        ),
        ...list(values, "uses") ? { uses: list(values, "uses") } : {},
        ...list(values, "flow") ? { flow: list(values, "flow") } : {},
        ...stages === void 0 ? {} : { stages }
      };
      const result = await (await client8()).patch(`/map/nodes/${enc2(node)}${as3(values)}`, input);
      if (json) printJson(result);
      else console.log(`\u5DF2\u6539 ${result.node} \u7684\u5168\u666F`);
      recordNext(`\u52A8\u4F5C\uFF1Aatrium map ${result.node} --json`);
      return 0;
    }
  }
};

// server/memos/decisions.ts
var who = (by) => by === SECRETARY ? "\u79D8\u4E66" : by === LOCAL_USER ? "\u7528\u6237" : by;
function decisionLine(d) {
  const links = [
    d.issue === null ? "" : `#${d.issue}`,
    ...d.nodes.map((n) => n.ref),
    d.task ?? ""
  ].filter(Boolean);
  return [
    `${d.ref} ${d.date.slice(5)} ${who(d.by)}\u5B9A\uFF1A${d.text}`,
    `\u2014\u2014${d.why}`,
    links.length ? `\uFF08${links.join(" ")}\uFF09` : "",
    d.supersedes.length ? `\uFF08\u63A8\u7FFB ${d.supersedes.join("\u3001")}\uFF09` : "",
    d.superseded_by ? `\u3010\u5DF2\u88AB ${d.superseded_by} \u63A8\u7FFB\u3011` : ""
  ].join("");
}

// server/choices/model.ts
function commentLine(comment) {
  const prefer = comment.prefer.length ? `\uFF08\u503E\u5411\u9009\u9879 ${comment.prefer.join("\u3001")}\uFF09` : "";
  const basis = comment.basis.length ? `\uFF1B\u8865\u4F9D\u636E\uFF1A${comment.basis.join("\uFF1B")}` : "";
  const who5 = comment.by === "secretary" ? "\u79D8\u4E66" : comment.by;
  return `${who5}\uFF1A${comment.text}${prefer}${basis}`;
}
function pendingLine(pending, total, max = 60) {
  const first = pending[0];
  if (!first || total <= 0) return null;
  const more = total > 1 ? `\uFF0C\u53E6\u6709 ${total - 1} \u4EFD` : "";
  return `\u7B49\u4F60\u62CD\u677F\uFF1A${first.ref} ${oneLine(first.title, max)}\uFF08${first.options} \u4E2A\u9009\u9879\uFF09${more}`;
}

// server/materials/model.ts
var MATERIAL_MAX_BYTES = 20 * 1024 * 1024;
var MATERIAL_MAX_FILES = 500;
var DAY = 24 * 60 * 60 * 1e3;
var STALE_MS = 90 * DAY;
var HINT_AGAIN_MS = 30 * DAY;
var PURGE_ARCHIVED_MS = 365 * DAY;
var PURGE_MIN_BYTES = 10 * 1024 * 1024;
function segmentProblem(segment) {
  if (!segment) return "\u6709\u7A7A\u7684\u4E00\u6BB5";
  if (segment === "." || segment === "..") return "\u4E0D\u80FD\u542B . \u6216 ..";
  if (segment.startsWith(".")) return `\u4E0D\u80FD\u542B\u9690\u85CF\u7684\u4E00\u6BB5\uFF08${segment}\uFF09`;
  if (/[\\:]/.test(segment)) return `\u4E0D\u80FD\u542B\u53CD\u659C\u6760\u6216\u5192\u53F7\uFF08${segment}\uFF09`;
  if (/[\u0000-\u001f\u007f]/.test(segment)) return "\u4E0D\u80FD\u542B\u63A7\u5236\u5B57\u7B26";
  if (Array.from(segment).length > 255) return "\u6709\u4E00\u6BB5\u8D85\u8FC7 255 \u5B57";
  return null;
}
function pathProblem(path5) {
  if (typeof path5 !== "string" || !path5) return "\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A";
  if (path5.startsWith("/") || /^[A-Za-z]:/.test(path5) || path5.startsWith("\\"))
    return `\u4E0D\u80FD\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF08${path5}\uFF09`;
  if (Array.from(path5).length > 1024) return "\u8DEF\u5F84\u8D85\u8FC7 1024 \u5B57";
  for (const segment of path5.split("/")) {
    const problem = segmentProblem(segment);
    if (problem) return `${problem}\uFF1A${path5}`;
  }
  return null;
}
var sizeText = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
var tooBig = (size, max = MATERIAL_MAX_BYTES) => `\u8D44\u6599 ${sizeText(size)}\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${sizeText(max)}\uFF1B\u538B\u7F29\u540E\u518D\u52A0\uFF08\u622A\u56FE\u8F6C\u6210\u5C0F\u4E00\u4E9B\u7684\u683C\u5F0F\u3001\u5220\u6389\u4E0D\u7528\u7684\u6587\u4EF6\uFF09\uFF0C\u6216\u628A\u5927\u6587\u4EF6\u653E\u5230\u7F51\u76D8\u3001\u4ED3\u5E93\uFF0C\u53EA\u5728 --note \u91CC\u5199\u94FE\u63A5`;

// server/map/view.ts
var DEPTH_MAX = 8;

// server/tasks/secretary/secretary-watch.ts
var UNATTENDED_MS = DUE.secretary.ms;
function secretaryText(view) {
  const pending = view.pending ? ` \xB7 \u672A\u5904\u7406 ${view.pending}` : "";
  if (view.waking) return { text: `\u79D8\u4E66\u540E\u53F0\u5904\u7406\u4E2D${pending}`, tone: "ok" };
  if (view.listening) return { text: `\u79D8\u4E66\u5728\u542C${pending}`, tone: "ok" };
  const minutes = Math.floor((view.away_ms ?? 0) / 6e4);
  const away = `\u79D8\u4E66\u6CA1\u5728\u542C${minutes ? ` ${minutes} \u5206\u949F` : ""}`;
  if (!view.pending) return { text: away, tone: "ok" };
  if (view.unreachable)
    return {
      text: `${away}${pending} \xB7 \u53EB\u4E0D\u8D77\u6765\uFF1A${view.unreachable}`,
      tone: "alarm"
    };
  return { text: `${away}${pending}`, tone: view.overdue ? "alarm" : "warn" };
}

// cli/top.ts
function groupByTotal(rows) {
  const out3 = [];
  const groups2 = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!row.total) {
      out3.push({ heading: null, rows: [row] });
      continue;
    }
    const group = groups2.get(row.total.ref);
    if (group) group.push(row);
    else {
      const created = [row];
      groups2.set(row.total.ref, created);
      out3.push({ heading: row.total, rows: created });
    }
  }
  return out3;
}
function totalHeading(total, rows) {
  const live = rows.filter((row) => !FINISHED.has(phase(row)));
  return `\u25B8 ${total.ref} ${total.title} ${total.progress}${live.length ? ` \xB7 \u5728\u505A ${live.map((row) => row.ref).join("\u3001")}` : ""}`;
}
var client9 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var REFRESH_SECONDS = 2;
var REFRESH_MAX = 60;
var WORKER_MIN_WIDTH = 80;
var MIN_TITLE = 12;
var MIN_ACTION = 10;
var MAX_WORKER = 32;
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
function mapDepth(value) {
  if (value === void 0) return 2;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > DEPTH_MAX)
    throw new Problem(
      400,
      `--depth \u5E94\u4E3A 1\uFF5E${DEPTH_MAX} \u7684\u6574\u6570\uFF08\u6536\u5230\uFF1A${value}\uFF09`,
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
function symbolOf(row) {
  const kind = phase(row);
  return SYMBOL2[row.processing && kind === "blocked" ? "processing" : kind] ?? "\xB7";
}
var phase = (row) => row.queued_at !== null ? "queued" : row.delivery_stage ?? (row.status === "running" || row.status === "blocked" ? row.status : row.status);
var titleOf2 = (row) => tagTitle(priorityTag(row.priority), row.title);
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
  const due = row.holder?.due;
  const held = due ? heldText(due.kind, now - due.since) : "";
  return `${from ? duration2(to - from) : "\u2014"}${held ? ` \xB7 ${held}` : ""}`;
}
function action(row, now) {
  const kind = phase(row);
  if (kind === "queued" || kind === "blocked") return "";
  if (row.checking) return "\u672C\u5730\u68C0\u67E5\u4E2D";
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
var workerCell = (row) => row.host_name ? `${row.worker ?? "\u6267\u884C\u8005"} @ ${row.host_name}` : row.worker ?? "";
var TITLE_SHARE = 0.55;
function layoutOf(rows, width_, stateW) {
  const refW = Math.max(3, ...rows.map((row) => width(row.ref)));
  const workerW = Math.min(
    MAX_WORKER,
    Math.max(0, ...rows.map((row) => width(workerCell(row)))),
    Math.max(
      0,
      width_ - (1 + 2 + refW + 2 + 2 + 2 + stateW + 2 + MIN_TITLE + MIN_ACTION)
    )
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
function hostBrief(host, queued) {
  if (!host?.paused) return "";
  const waiting = queued > 0 ? `\uFF0C\u6392\u961F ${queued} \u4EF6` : "";
  const load = (value) => value >= 10 ? value.toFixed(0) : value.toFixed(1);
  const cores = (value) => Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (host.paused_by === "own" && host.own_cores != null && host.busy_cores != null)
    return ` \xB7 \u672C\u673A\u592A\u5FD9${waiting}\uFF08Atrium \u81EA\u5DF1\u5360\u4E86 ${cores(host.own_cores)} \u6838\uFF0C\u8D85\u8FC7 ${cores(host.busy_cores)}\uFF09`;
  if (host.paused_by === "load" || host.paused_by === void 0 && host.busy_load !== null && host.load > host.busy_load)
    return ` \xB7 \u672C\u673A\u592A\u5FD9${waiting}\uFF08\u6574\u673A\u8D1F\u8F7D ${load(host.load)}\uFF0C\u8D85\u8FC7 ${load(host.busy_load)}\uFF09`;
  return ` \xB7 \u672C\u673A\u6EE1 ${host.running}/${host.max_workers}${waiting}`;
}
function renderTop(snapshot, frame) {
  const groups2 = groupByTotal(snapshot.rows);
  const rows = groups2.flatMap((group) => group.rows);
  const headings = /* @__PURE__ */ new Map();
  for (const group of groups2)
    if (group.heading)
      headings.set(group.rows[0], totalHeading(group.heading, group.rows));
  const states = rows.map((row) => oneLine(state(row, frame.now), Infinity));
  const stateW = Math.max(
    0,
    ...states.filter((_, index) => rowTakesStateWidth(rows[index])).map(width)
  );
  const plan2 = layoutOf(rows, frame.width, stateW);
  const clock = `${new Date(frame.now).toTimeString().slice(0, 5)} \u5237\u65B0`;
  const head = (
    // 在途任务按类型分开计数（t237）放最前：头部太长时截掉的是后面的细项。
    `Atrium \xB7 ${priorityCountsText(snapshot.priorities) ? `${priorityCountsText(snapshot.priorities)} \xB7 ` : ""}\u5728\u8DD1 ${snapshot.counts.running} \xB7 \u6392\u961F ${snapshot.counts.queued}` + hostBrief(snapshot.host, snapshot.counts.queued) + (snapshot.counts.reviewing ? ` \xB7 \u5BA1\u9605\u4E2D ${snapshot.counts.reviewing}` : "") + (snapshot.counts.merge_queued ? ` \xB7 \u6392\u961F\u5408\u5165 ${snapshot.counts.merge_queued}` : "") + (snapshot.counts.merging ? ` \xB7 \u5408\u5165\u4E2D ${snapshot.counts.merging}` : "") + (snapshot.counts.merged ? ` \xB7 \u5DF2\u5408\u5165 ${snapshot.counts.merged}` : "") + (snapshot.counts.online ? ` \xB7 \u5DF2\u4E0A\u7EBF ${snapshot.counts.online}` : "") + ` \xB7 \u5904\u7406\u4E2D ${snapshot.counts.processing} \xB7 \u5361\u4F4F ${snapshot.counts.blocked}` + // 秘书在不在听（t242）；旧版服务没有这个字段，照旧只说未处理事件。
    (snapshot.secretary ? ` \xB7 ${secretaryText(snapshot.secretary).text}` : ` \xB7 \u672A\u5904\u7406\u4E8B\u4EF6 ${snapshot.counts.events}`)
  );
  const headRoom = Math.max(10, frame.width - width(clock) - 1);
  const choice = snapshot.choices ? pendingLine(snapshot.choices.list, snapshot.choices.open) : null;
  const lines = [
    pad(oneLine(head, headRoom), headRoom) + clock,
    ...(snapshot.pauses ?? []).map(
      (pause) => oneLine(
        `\u25A0 ${pauseText(pause)}\uFF1B\u6062\u590D\uFF1A${resumeCommand(pause)}`,
        frame.width
      )
    ),
    ...choice ? [oneLine(choice, frame.width)] : [],
    ...rows.flatMap((row, index) => {
      const cell2 = oneLine(states[index], plan2.stateW + 2 + plan2.actionW);
      const text = [
        `${symbolOf(row)} ${pad(row.ref, plan2.refW)}`,
        pad(oneLine(titleOf2(row), plan2.titleW), plan2.titleW),
        ...plan2.showWorker ? [pad(oneLine(workerCell(row), plan2.workerW), plan2.workerW)] : [],
        pad(cell2, plan2.stateW),
        pad(oneLine(action(row, frame.now), plan2.actionW), plan2.actionW)
      ].join("  ").trimEnd();
      const line3 = FINISHED.has(phase(row)) && frame.color ? faint(text) : text;
      const heading = headings.get(row);
      return [
        ...heading ? [oneLine(heading, frame.width)] : [],
        line3,
        ...row.note ? [
          `  ${oneLine(`\u5907\u6CE8\uFF08${row.note_by ?? "\u672A\u77E5"} \xB7 ${new Date(row.note_at).toLocaleString("zh-CN")}\uFF09\uFF1A${row.note}`, frame.width - 2)}`
        ] : [],
        ...row.tells?.total ? [
          `  ${oneLine(`\u634E\u8BDD ${row.tells.total} \u6761${row.tells.pending ? `\uFF0C${row.tells.pending} \u6761\u5F85\u9001\u8FBE` : "\uFF0C\u90FD\u5DF2\u9001\u8FBE"}`, frame.width - 2)}`
        ] : []
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
async function snapshotOf(api2, as4, depth = 2) {
  const [snapshot, plan2, map] = await Promise.all([
    api2.get(path4(as4)),
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
var path4 = (as4) => as4 === void 0 ? "/tasks/top" : `/tasks/top?${new URLSearchParams({ as: as4 })}`;
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
async function watch(api2, as4, seconds, terminal, once = false, depth = 2) {
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
        snapshot = await snapshotOf(api2, as4, depth);
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
    as: { type: "string" }
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const as4 = str(values, "as");
    if (as4 !== void 0 && !as4.trim())
      throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const seconds = interval(str(values, "interval"));
    const width_ = columns(str(values, "width"));
    const depth = mapDepth(str(values, "depth"));
    const once = values.once === true || json || !process.stdout.isTTY || !process.stdin.isTTY;
    const api2 = await client9();
    if (!once) return watch(api2, as4, seconds, liveTerminal(), false, depth);
    const snapshot = await snapshotOf(api2, as4, depth);
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
var TONE = {
  ok: DIM2,
  warn: YELLOW,
  alarm: `${BOLD}${RED}`
};
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
  const shown = titleTag(priorityTag(row.priority), row.title);
  const tag = shown ? `${paint(shown === "\u7D27\u6025" ? `${BOLD}${RED}` : shown === "\u4FEE\u590D" ? YELLOW : DIM2, shown)} ` : "";
  const title = `${tag}\u300C${oneLine(row.title, TITLE_MAX)}\u300D`;
  if (holder.kind === "user")
    return `${paint(color, mark)} ${row.ref} ${title} ${paint(color, `\u7B49\u4F60\uFF1A${holder.text}`)}`;
  if (holder.kind === "worker") {
    const took = row.started_at ? ` ${duration2(now - row.started_at)}` : "";
    const prefix = `${row.worker ?? "\u6267\u884C\u8005"} @ ${row.host_name} \xB7 `;
    const detail4 = row.host_name && holder.text.startsWith(prefix) ? holder.text.slice(prefix.length) : holder.text;
    const story = /^\S+ 在做( · |$)/.test(detail4) ? detail4.replace(/^\S+ 在做/, "") : ` \xB7 ${detail4}`;
    const host = row.host_name ? ` @ ${row.host_name}` : "";
    return `${paint(color, mark)} ${row.ref} ${title} ${workerLabel(row.worker)}${host}${paint(DIM2, took)}${story}`;
  }
  const text = holder.kind === "queue" ? paint(DIM2, holder.text) : paint(color, holder.text);
  return `${paint(color, mark)} ${row.ref} ${title} ${text}`;
}
var GROUP_LABEL = {
  user: "\u7B49\u4F60",
  worker: "\u5728\u505A",
  leader: "leader \u5904\u7406",
  secretary: "\u79D8\u4E66\u5904\u7406",
  merge: "\u5408\u5165",
  queue: "\u6392\u961F"
};
var MEMBER_TITLE = 8;
var MEMBERS_SHOWN = 3;
function groupRows(held) {
  const items = [];
  const groups2 = /* @__PURE__ */ new Map();
  for (const row of held) {
    if (!row.total || row.holder.kind === "user") {
      items.push({ row });
      continue;
    }
    const group = groups2.get(row.total.ref);
    if (group) group.rows.push(row);
    else {
      const created = { total: row.total, rows: [row] };
      groups2.set(row.total.ref, created);
      items.push(created);
    }
  }
  return items;
}
function groupLine(total, rows, paint) {
  const kinds = ORDER.filter(
    (kind) => rows.some((row) => row.holder.kind === kind)
  );
  const [, color] = MARK[kinds[0] ?? "worker"];
  const segments = kinds.map((kind) => {
    const members = rows.filter((row) => row.holder.kind === kind);
    const shown = members.slice(0, MEMBERS_SHOWN).map((row) => `${row.ref} ${oneLine(row.title, MEMBER_TITLE)}`);
    const more = members.length > MEMBERS_SHOWN ? ` \u7B49 ${members.length} \u4E2A` : "";
    return `${GROUP_LABEL[kind]} ${shown.join("\u3001")}${more}`;
  });
  return `${paint(color, "\u25B8")} ${total.ref} \u300C${oneLine(total.title, TITLE_MAX)}\u300D ${total.progress} \xB7 ${segments.join(" \xB7 ")}`;
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
  const counts3 = input.plan ? planCounts(input.plan.groups) : null;
  const ready = counts3?.ready ?? 0;
  const waiting = counts3?.waiting ?? 0;
  const choice = snapshot.choices ? pendingLine(snapshot.choices.list, snapshot.choices.open, TITLE_MAX) : null;
  const secretary = snapshot.secretary ? secretaryText(snapshot.secretary) : null;
  const secretaryPart = secretary ? paint(TONE[secretary.tone], secretary.text) : null;
  const paused = (snapshot.pauses ?? []).map(
    (pause) => paint(`${BOLD}${RED}`, `\u25A0 ${pauseText(pause)}`)
  );
  if (!paused.length && !held.length && !leaders.length && !events && !ready && !waiting && !choice && (!secretary || secretary.tone === "ok"))
    return [
      paint(DIM2, "Atrium \u7A7A\u95F2"),
      ...secretaryPart ? [secretaryPart] : []
    ].join(" \xB7 ");
  const parts = [
    `\u5728\u505A ${count("worker")}`,
    ...count("leader") ? [`leader \u5904\u7406 ${count("leader")}`] : [],
    ...count("secretary") ? [`\u79D8\u4E66\u5904\u7406 ${count("secretary")}`] : [],
    ...count("merge") ? [`\u5408\u5165 ${count("merge")}`] : [],
    ...count("queue") ? [`\u6392\u961F ${count("queue")}`] : []
  ];
  const head = [
    // 暂停派新活时写清是哪条线（t113）：Atrium 自己占的核、整机负载保护线，还是执行者满了。
    `Atrium ${parts.join(" \xB7 ")}${hostBrief(snapshot.host, snapshot.counts.queued)}`,
    // 在途任务按优先级分开计数：紧急 K · 修复 M · 普通 N · 闲时 I。
    ...priorityCountsText(snapshot.priorities) ? [priorityCountsText(snapshot.priorities)] : [],
    ...count("user") ? [paint(`${BOLD}${RED}`, `\u7B49\u4F60 ${count("user")}`)] : [],
    ...secretaryPart ? [secretaryPart] : events ? [
      paint(
        YELLOW,
        `${snapshot.subscriber === "secretary" ? "\u79D8\u4E66" : snapshot.subscriber}\u672A\u5904\u7406\u4E8B\u4EF6 ${events}`
      )
    ] : []
  ].join(" \xB7 ");
  const lines = [...paused, head];
  if (choice) lines.push(paint(`${BOLD}${RED}`, `\u2731 ${choice}`));
  const items = groupRows(held);
  for (const item of items.slice(0, TASK_LINES))
    lines.push(
      "row" in item ? taskLine(item.row, item.row.holder, now, paint) : groupLine(item.total, item.rows, paint)
    );
  if (items.length > TASK_LINES) {
    const rest = items.slice(TASK_LINES).reduce((sum, item) => sum + ("row" in item ? 1 : item.rows.length), 0);
    lines.push(paint(DIM2, `  \u2026\u8FD8\u6709 ${rest} \u4E2A\uFF0Catrium top \u770B\u5168\u90E8`));
  }
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
function statuslineNext(input) {
  const mine = input.snapshot.rows.find((row) => row.holder?.kind === "user");
  if (mine) return `atrium task show ${mine.ref}`;
  const counts3 = input.plan ? planCounts(input.plan.groups) : null;
  return counts3?.ready ? "atrium task plan" : "atrium top";
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
  about: "Claude Code \u72B6\u6001\u680F\uFF1A\u7B49\u4F60\u62CD\u677F\u7684\u9009\u9879\u5355\u3001\u672A\u7ED3\u675F\u4EFB\u52A1\u5404\u5728\u8C01\u624B\u91CC\uFF08\u6267\u884C\u8005\u3001\u5408\u5165\u3001leader\u3001\u79D8\u4E66\u3001\u7B49\u4F60\uFF09\u3001leader \u5728\u5904\u7406\u4EC0\u4E48\u3001\u79D8\u4E66\u5728\u4E0D\u5728\u542C\u4E0E\u672A\u5904\u7406\u4E8B\u4EF6\uFF1B\u670D\u52A1\u4E0D\u5728\u53EA\u663E\u793A\u672A\u8FD0\u884C\uFF0C\u4E0D\u62C9\u8D77",
  positionals: [0, 0],
  async run({ json }) {
    const done = drainStdin();
    try {
      const { connectRunning } = await import("./chunk-P53PGFEK.js");
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
      recordNext(`\u4E0B\u4E00\u6B65\uFF1A${statuslineNext(state2)}`);
    } finally {
      done();
    }
  }
};

// cli/quota.ts
var client10 = async () => (await import("./chunk-P53PGFEK.js")).connect();
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
  const withHosts = accounts.some((account) => account.hosts !== void 0);
  const body = table([
    [
      "\u8D26\u53F7",
      "\u6765\u6E90",
      ...withHosts ? ["\u4E3B\u673A"] : [],
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
      ...withHosts ? [(account.hosts ?? []).join(" ")] : [],
      cell(account.usedPercent),
      cell(account.periodElapsedPercent),
      cell(account.sparePercent),
      cell(account.hoursToReset),
      cell(account.shortWindowUsedPercent),
      refreshed(account.refreshedAt),
      account.runtime ?? "",
      [
        account.stale ? staleLabel(account.refreshedHoursAgo) : null,
        account.note
      ].filter(Boolean).join("\uFF1B")
    ])
  ]);
  return `${body}${tail}`;
}
function reserveLine(reserve) {
  if (!reserve) return null;
  return reserve.set_by ? `\u7ED9\u4F60\u7559\u7684\u4EFD\u989D\uFF1A\u6BCF\u4E2A\u8D26\u53F7\u81F3\u5C11 ${reserve.percent}%\uFF08atrium org limits \u53EF\u6539\uFF09` : `\u7ED9\u4F60\u7559\u7684\u4EFD\u989D\uFF1A\u6BCF\u4E2A\u8D26\u53F7\u81F3\u5C11 ${reserve.percent}%\uFF08\u7F3A\u7701\uFF1Batrium org limits --quota-reserve N \u53EF\u6539\uFF09`;
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
        ].filter((line3) => line3 !== null).join("\n")
      );
    recordNext("\u770B\u4EFB\u52A1\uFF1Aatrium task ls");
  }
};
var quotaCommands = { quota };

// cli/events.ts
var client11 = async () => (await import("./chunk-P53PGFEK.js")).connect();
function eventLine(event) {
  const detail4 = event.detail ?? {};
  const reason3 = typeof detail4.message === "string" ? detail4.message : typeof detail4.reason === "string" ? detail4.reason : "";
  const title = typeof detail4.title === "string" ? detail4.title : "";
  const line3 = [
    `#${event.id}`,
    event.task ?? "",
    event.kind,
    title ? clip(title, 40) : "",
    event.count > 1 ? `\uFF08\u5408\u5E76 ${event.count} \u6B21\uFF09` : "",
    event.delivered_at !== null ? "\u5DF2\u9001\u8FBE" : "\u672A\u9001\u8FBE",
    event.acked_at !== null ? "\u5DF2\u786E\u8BA4" : "\u672A\u786E\u8BA4",
    typeof detail4.pr_url === "string" ? detail4.pr_url : "",
    reason3 ? `\xB7 ${clip(reason3, 160)}` : "",
    // 下层上交经上层转交：逐层附上「谁看过、一句意见」。
    ...(Array.isArray(detail4.forwarded) ? detail4.forwarded : []).flatMap(
      (f) => typeof f?.by === "string" && typeof f?.note === "string" ? [`\xB7 ${f.by} \u8F6C\u4EA4\uFF1A${clip(f.note, 160)}`] : []
    ),
    `\xB7 ${when(event.updated_at)}`
  ].filter(Boolean).join(" ");
  return line3;
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
    const who5 = str(values, "as") ?? defaultSubscriber();
    if (!who5.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const query = new URLSearchParams({ as: who5 });
    for (const key of ["before", "limit"])
      if (str(values, key) !== void 0) query.set(key, str(values, key));
    const result = await (await client11()).get(
      `/events?${query}`
    );
    if (result.next_before !== null)
      recordNext(
        `\u7EE7\u7EED\u67E5\u770B\uFF1Aatrium events --as ${who5} --before ${result.next_before}`
      );
    else recordNext(`\u7B49\u65B0\u4E8B\u4EF6\uFF1Aatrium events wait --as ${who5}`);
    if (json) printJson(result);
    else if (!result.events.length) console.log(`${who5} \u6CA1\u6709\u4E8B\u4EF6`);
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
    const who5 = str(values, "as") ?? defaultSubscriber();
    if (!who5.trim()) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
    const seconds = waitSeconds(str(values, "timeout"));
    const settle = str(values, "settle");
    if (settle !== void 0 && (!/^(0|[1-9]\d*)$/.test(settle) || Number(settle) > 300))
      throw new Problem(400, "--settle \u5E94\u4E3A 0\uFF5E300 \u7684\u6574\u6570\u79D2", "usage");
    const api2 = await client11();
    const query = (timeout) => new URLSearchParams({
      as: who5,
      timeout: String(timeout),
      ...settle === void 0 ? {} : { settle },
      ...values.all === true ? { all: "1" } : {}
    });
    const result = await longWait(
      seconds,
      (timeout) => api2.get(`/events/wait?${query(timeout)}`),
      () => `atrium events wait --as ${who5}`
    );
    const ids = result.events.map((event) => event.id);
    recordNext(
      ids.length ? `\u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}` : result.paused ? "\u6062\u590D\uFF1Aatrium resume" : `\u7EE7\u7EED\u7B49\uFF1Aatrium events wait --as ${who5}`
    );
    if (json) printJson(result);
    else if (result.paused)
      console.log(`${result.paused}\uFF1A\u4E8B\u4EF6\u7167\u5E38\u843D\u5E93\uFF0C\u6062\u590D\u540E\u518D\u53D6`);
    else if (!ids.length)
      console.log(
        `${seconds} \u79D2\u5185 ${who5} \u6CA1\u6709\u65B0\u4E8B\u4EF6\uFF1Batrium events wait --as ${who5}`
      );
    else console.log(result.events.map(eventLine).join("\n"));
    return ids.length ? 0 : 124;
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
  "events ack": ack
};

// cli/chat.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join4, resolve as resolve7 } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// server/tasks/secretary/secretary-session.ts
import { randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync5, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, isAbsolute, join as join2 } from "node:path";
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
    raw = readFileSync5(file2, "utf8");
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
  const directory = join2(data, "secretary");
  mkdirSync2(directory, { recursive: true, mode: 448 });
  saveJson(join2(directory, secretarySessionFile(session.tool)), {
    sessionId: session.sessionId,
    cwd: session.cwd,
    updated_at: Date.now()
  });
  saveJson(join2(directory, "active.json"), { tool: session.tool });
}
function wakeCount(data) {
  const file2 = join2(data, "secretary", "wake-count.json");
  const value = readJson(file2);
  if (!value) return 0;
  if (Number.isInteger(value.count) && value.count >= 0)
    return value.count;
  quarantine(file2);
  return 0;
}
function saveWakeCount(data, count) {
  const directory = join2(data, "secretary");
  mkdirSync2(directory, { recursive: true, mode: 448 });
  saveJson(join2(directory, "wake-count.json"), { count });
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
  constructor(command, args, options3, handlers) {
    this.handlers = handlers;
    this.child = spawnCommand(command, args, {
      cwd: options3.cwd,
      env: options3.env,
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
    return new Promise((resolve11, reject) => {
      this.pending.set(id, {
        resolve: resolve11,
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
      const line3 = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line3) continue;
      let message;
      try {
        message = JSON.parse(line3);
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
function planAuthFile(file2, source, target2, previous = []) {
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
  if (target2 !== void 0) {
    const parsed = parse(target2);
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
  readFileSync as readFileSync6,
  realpathSync,
  renameSync as renameSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { homedir } from "node:os";
import { join as join3, resolve as resolve6 } from "node:path";
var AUTH_FILES = ["auth.json", "mcp-auth.json"];
var SYNCED = "atrium-synced.json";
function secretaryOpencodeHome(data) {
  return join3(data, "secretary", "opencode-home");
}
function userOpencodeData(env = process.env) {
  return join3(
    resolve6(env.XDG_DATA_HOME || join3(homedir(), ".local", "share")),
    "opencode"
  );
}
var real = (path5) => existsSync3(path5) ? realpathSync(path5) : path5;
var readText = (path5) => {
  try {
    return readFileSync6(path5, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
};
function readSynced(path5) {
  try {
    const value = JSON.parse(readText(path5) ?? "{}");
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
  const target2 = join3(home, "opencode");
  mkdirSync3(target2, { recursive: true, mode: 448 });
  if (real(target2) === real(source)) return report;
  const syncedPath = join3(home, SYNCED);
  const synced = readSynced(syncedPath);
  const next = {};
  for (const name of AUTH_FILES) {
    const to = join3(target2, name);
    let from;
    try {
      from = readText(join3(source, name));
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
function opencodeEnvironment(base, options3) {
  const env = { ...base, XDG_DATA_HOME: options3.home };
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  if (options3.password) env.OPENCODE_SERVER_PASSWORD = options3.password;
  return env;
}

// cli/opencode-serve.ts
var newPassword = () => randomBytes(24).toString("base64url");
function startOpencodeServe(options3) {
  const command = options3.command ?? "opencode";
  const args = options3.args ?? [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0"
  ];
  const child = spawnCommand(command, args, {
    cwd: options3.cwd,
    env: options3.env,
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
  const exited = new Promise((resolve11) => {
    child.on("error", (error) => resolve11(error.message));
    child.on(
      "close",
      (code, signal) => resolve11(
        `${command} serve \u5DF2\u9000\u51FA\uFF08${signal ?? `\u9000\u51FA\u7801 ${code}`}\uFF09${tail.trim() ? `\uFF1A${tail.trim().split("\n").at(-1)}` : ""}`
      )
    );
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    tail = (tail + chunk).slice(-4e3);
  });
  child.stdout.setEncoding("utf8");
  return new Promise((resolve11, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(
        new Error(
          `\u7B49 ${command} serve \u62A5\u51FA\u5730\u5740\u8D85\u65F6${tail.trim() ? `\uFF1A${tail.trim().split("\n").at(-1)}` : ""}`
        )
      );
    }, options3.timeoutMs ?? 3e4);
    const onData = (chunk) => {
      output3 = (output3 + chunk).slice(-4e3);
      const found = /listening on (https?:\/\/[^\s]+)/.exec(output3);
      if (!found) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.resume();
      resolve11({ url: found[1].replace(/\/$/, ""), exited, close });
    };
    child.stdout.on("data", onData);
    void exited.then((reason3) => {
      clearTimeout(timer);
      reject(new Error(reason3));
    });
  });
}
var OpencodeHttpError = class extends Error {
  constructor(status4, message) {
    super(message);
    this.status = status4;
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
  async call(method, path5, body, query = {}) {
    const search = new URLSearchParams({
      directory: this.directory,
      ...query
    });
    const headers = {};
    if (this.auth) headers.authorization = this.auth;
    if (body !== void 0) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url}${path5}?${search}`, {
      method,
      headers,
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(15e3)
    });
    const text = await response.text();
    if (!response.ok)
      throw new OpencodeHttpError(
        response.status,
        `opencode ${method} ${path5}\uFF1AHTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`
      );
    return text ? JSON.parse(text) : void 0;
  }
};

// cli/secretary-chat.ts
import { setTimeout as delay3 } from "node:timers/promises";

// server/tasks/secretary/wake-rule.ts
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

// server/tasks/secretary/wake-prompt.ts
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
    // 汇报与上交是通用规则（原先写在根章程里）；规矩本身看要点（atrium org show 根部门）。
    "\u53EA\u628A\u8981\u7528\u6237\u62CD\u677F\u7684\u4E8B\u9012\u7ED9\u7528\u6237\uFF08\u9009\u9879\u5355\u3001\u76EE\u6807\u51B2\u7A81\u3001\u8D8A\u8FC7\u5E95\u7EBF\u6216\u989D\u5EA6\u3001\u4E0B\u9762\u641E\u4E0D\u5B9A\u7684\uFF09\uFF1B\u6C47\u62A5\u5148\u7ED9\u7ED3\u8BBA\uFF0C\u6309\u7EC4\u7EC7\u6811\u9010\u5C42\u6C47\u603B\u3002",
    `\u5904\u7406\u5B8C\u786E\u8BA4\uFF1Aatrium events ack ${ids.join(" ")}`
  ].join("\n");
}

// cli/secretary-chat.ts
var PEEK_SECONDS = 240;
var DEFAULT_BATCH_MS = 2e3;
var DEFAULT_MAX_WAKEUPS = 10;
var SecretaryChat = class {
  constructor(options3) {
    this.options = options3;
    this.now = options3.now ?? Date.now;
    this.batchMs = options3.batchMs ?? DEFAULT_BATCH_MS;
    this.maxWakeups = options3.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
    this.wakeCount = options3.initialWakeCount ?? 0;
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
        const status4 = typeof update.status === "string" ? update.status : "";
        if (update.sessionUpdate === "tool_call" || status4)
          this.options.view.tool(title, status4 || "pending");
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
    for (const resolve11 of this.waiters) resolve11();
    this.waiters.clear();
  }
  poked() {
    return new Promise((resolve11) => this.waiters.add(resolve11));
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
  constructor(options3) {
    this.options = options3;
    this.now = options3.now ?? Date.now;
    this.batchMs = options3.batchMs ?? DEFAULT_BATCH_MS;
    this.maxWakeups = options3.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
    this.pollMs = options3.pollMs ?? 1e3;
    this.wakeCount = options3.initialWakeCount ?? 0;
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
    for (const resolve11 of this.waiters) resolve11();
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
    const woken = new Promise((resolve11) => wake = resolve11);
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
  claude: {
    kind: "bridge",
    note: "Claude Code \u8D70\u539F\u751F\u754C\u9762\uFF1A\u5728\u79D8\u4E66\u7684\u5DE5\u4F5C\u76EE\u5F55\u76F4\u63A5\u6253\u5F00 claude\uFF0C\u8981\u5904\u7406\u7684\u4E8B\u4EF6\u7531 atrium secretary bridge \u7ECF\u4F1A\u8BDD\u6536\u4EF6 socket \u6CE8\u5165\uFF08\u9700\u8981 Claude Code v2.1.224 \u53CA\u4EE5\u4E0A\uFF09\uFF1B\u5148\u5728\u90A3\u4E2A\u76EE\u5F55\u88C5\u4E00\u6B21 SessionStart hook\uFF0C\u4E4B\u540E\u6BCF\u6B21\u6253\u5F00\u79D8\u4E66\u4F1A\u8BDD\u81EA\u52A8\u8D77 bridge",
    next: "atrium secretary bridge --install-hook"
  }
};
var SUBSCRIBER = "secretary";
var NEW_SESSION_HINT = "\uFF1B\u65B0\u4F1A\u8BDD\u5148\u8BA9\u79D8\u4E66\u8BFB\u5907\u5FD8\u4E0E\u51B3\u5B9A\u8BB0\u5F55\uFF1Aatrium memo show";
function chatMode(tool) {
  const mode = CHAT_TOOLS[tool];
  if (!mode) {
    const candidate = closest(
      tool,
      Object.keys(CHAT_TOOLS).map((ref3) => ({ ref: ref3, name: ref3 }))
    )[0];
    throw new Problem(
      400,
      `--tool \u4E0D\u8BA4\u8BC6\uFF1A${tool}\uFF1B\u53EF\u9009 ${Object.keys(CHAT_TOOLS).join("\u3001")}`,
      "usage",
      void 0,
      candidate ? `atrium chat --tool ${candidate.ref}` : void 0
    );
  }
  if (mode.kind === "bridge")
    throw new Problem(409, mode.note, "conflict", void 0, mode.next);
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
  const file2 = join4(
    data,
    "secretary",
    tool === "codex" || tool === "opencode" ? secretarySessionFile(tool) : `${tool}-session.json`
  );
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync7(file2, "utf8"));
        return typeof value.sessionId === "string" && value.sessionId ? value.sessionId : void 0;
      } catch {
        return void 0;
      }
    },
    save(sessionId) {
      if (cwd && (tool === "codex" || tool === "opencode"))
        saveSecretarySession(data, { tool, sessionId, cwd });
      else {
        mkdirSync4(join4(data, "secretary"), { recursive: true, mode: 448 });
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
function terminalView(options3) {
  let fresh = true;
  const write = (text) => {
    if (!text) return;
    process.stdout.write(text);
    fresh = text.endsWith("\n");
  };
  const block = (text) => write(`${fresh ? "" : "\n"}${text}
`);
  const dim = (text) => options3.tty ? `\x1B[2m${text}\x1B[22m` : text;
  return {
    text: write,
    thought(chunk) {
      if (options3.tty) write(dim(chunk));
    },
    tool(title, status4) {
      if (status4 === "pending" || status4 === "completed" || status4 === "failed")
        block(
          dim(
            `  \xB7 ${clip(title.split("\n", 1)[0], 100)}\uFF08${STATUS3[status4]}\uFF09`
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
      options3.prompt();
    },
    async permission(request) {
      const title = request.toolCall.title ?? "\u5DE5\u5177\u8C03\u7528";
      const pick = (kind) => request.options.find((option) => option.kind === kind);
      if (options3.allow || !options3.tty) {
        const option = options3.allow ? pick("allow_once") : pick("reject_once") ?? pick("reject_always");
        block(
          `[atrium] \u6743\u9650\u8BF7\u6C42\u300C${title}\u300D\uFF1A${option ? option.name : "\u53D6\u6D88"}\uFF08${options3.allow ? "--allow \u81EA\u52A8\u5141\u8BB8\u4E00\u6B21" : "\u975E\u4EA4\u4E92\uFF0C\u81EA\u52A8\u62D2\u7EDD\uFF1B\u9700\u8981\u65F6\u52A0 --allow"}\uFF09`
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
      const answer = (await options3.ask("\u9009\u62E9\u7F16\u53F7\uFF08\u56DE\u8F66\u62D2\u7EDD\uFF09\uFF1A")).trim();
      const chosen = request.options[Number(answer) - 1];
      if (chosen) return { outcome: "selected", optionId: chosen.optionId };
      const reject = pick("reject_once") ?? pick("reject_always");
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
var secretaryAgentEnvironment = () => ({
  ...agentEnvironment(),
  ATRIUM_AS: "secretary"
});
function secretaryEnvironment(data, password) {
  const home = secretaryOpencodeHome(data);
  const report = prepareOpencodeHome(home, userOpencodeData());
  for (const problem of report.problems) console.error(`[atrium] ${problem}`);
  const mcp = mcpHint(home, report.mcpSkipped);
  if (mcp) console.error(`[atrium] ${mcp}`);
  return {
    env: opencodeEnvironment(secretaryAgentEnvironment(), { home, password }),
    hint: (model) => oauthHint(home, report.oauthOnly, model)
  };
}
async function runNative(options3) {
  const { api: api2, data, cwd } = options3;
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
    const client18 = new OpencodeClient(server.url, cwd, password);
    const warning = hint(await client18.model());
    if (warning) console.error(`[atrium] ${warning}`);
    const store = sessionStore(data, "opencode", cwd);
    const previous = options3.fresh ? void 0 : store.load();
    const resumed = previous !== void 0 && await client18.getSession(previous) !== void 0;
    const session = resumed ? previous : (await client18.createSession("Atrium \u79D8\u4E66")).id;
    store.save(session);
    console.error(
      `\u79D8\u4E66\u4F1A\u8BDD\uFF08opencode \u539F\u751F\u754C\u9762 \xB7 ${resumed ? "\u63A5\u7740\u4E0A\u6B21" : "\u65B0\u4F1A\u8BDD"} ${session}\uFF09\uFF1B\u5F85\u5904\u7406\u4E8B\u4EF6\u5728\u79D8\u4E66\u7A7A\u95F2\u65F6\u4EE5\u300C\u3010Atrium \u4E8B\u4EF6\u3011\u300D\u6D88\u606F\u9001\u5165\uFF0C\u4E0D\u52A8\u8F93\u5165\u6846\uFF1B\u9000\u51FA\u754C\u9762\u5373\u7ED3\u675F${resumed ? "" : NEW_SESSION_HINT}`
    );
    waker = new ServeWaker({
      source: eventSource(api2),
      initialWakeCount: options3.fresh ? 0 : wakeCount(data),
      onWakeCountChange: (count) => saveWakeCount(data, count),
      session: {
        status: () => client18.status(session),
        prompt: (text) => client18.prompt(session, text),
        messages: (limit) => client18.messages(session, limit),
        toast: (message, variant) => client18.toast(message, variant)
      }
    });
    if (options3.fresh) saveWakeCount(data, 0);
    running = waker.run();
    const ignore = () => {
    };
    process.on("SIGINT", ignore);
    const outcome = await new Promise((resolve11) => {
      const child = spawnCommand(
        "opencode",
        ["attach", server.url, "--session", session, "--dir", cwd],
        { cwd, env, stdio: "inherit" }
      );
      child.on("error", (error) => resolve11(error.message));
      child.on(
        "exit",
        (code, signal) => resolve11(
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
  about: "\u548C\u79D8\u4E66\u5BF9\u8BDD\uFF1Bopencode \u7F3A\u7701\u5F00\u539F\u751F\u754C\u9762\uFF08--acp \u7528 ACP\uFF09\uFF0Ccodex \u7ECF ACP\uFF1B\u7A7A\u95F2\u65F6\u81EA\u52A8\u9001\u5165\u4E8B\u4EF6\uFF0C\u754C\u9762\u5173\u95ED\u540E\u7531\u670D\u52A1\u6062\u590D\u539F\u4F1A\u8BDD\u5904\u7406\uFF1BClaude Code \u76F4\u63A5\u5F00\u539F\u751F\u754C\u9762\uFF0C\u4E8B\u4EF6\u7531 atrium secretary bridge \u6CE8\u5165",
  options: {
    tool: { type: "string" },
    cwd: { type: "string" },
    new: { type: "boolean", default: false },
    acp: { type: "boolean", default: false },
    allow: { type: "boolean", default: false }
  },
  positionals: [0, 0],
  async run({ values }) {
    const tool = str(values, "tool") ?? process.env.ATRIUM_SECRETARY_TOOL ?? "opencode";
    const mode = chatMode(tool);
    const cwd = resolve7(str(values, "cwd") ?? process.cwd());
    const data = dataDirectory();
    const { claimSecretary } = await import("./chunk-ROVTCY6F.js");
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
      const api2 = await (await import("./chunk-P53PGFEK.js")).connect();
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
          (resolve11) => rl ? rl.question(question, resolve11) : resolve11("")
        ),
        prompt: () => {
          if (tty) rl?.prompt(true);
        }
      });
      let chat;
      let env = secretaryAgentEnvironment();
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
      rl.on("line", (line3) => {
        const text = line3.trim();
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

// cli/secretary.ts
import {
  closeSync,
  mkdirSync as mkdirSync5,
  openSync,
  readFileSync as readFileSync8,
  writeFileSync as writeFileSync5
} from "node:fs";
import { dirname as dirname2, join as join5, resolve as resolve8 } from "node:path";
var BRIDGE_HOOK_COMMAND = "atrium secretary bridge --detach";
var hookEntry = () => ({
  hooks: [{ type: "command", command: BRIDGE_HOOK_COMMAND, timeout: 30 }]
});
var isObject2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function withBridgeHook(settings) {
  if (settings !== void 0 && !isObject2(settings))
    throw new Problem(409, "\u8BBE\u7F6E\u6587\u4EF6\u9876\u5C42\u4E0D\u662F JSON \u5BF9\u8C61\uFF0C\u6CA1\u6709\u6539\u52A8", "conflict");
  const base = settings ?? {};
  if (base.hooks !== void 0 && !isObject2(base.hooks))
    throw new Problem(409, "\u8BBE\u7F6E\u91CC\u7684 hooks \u4E0D\u662F\u5BF9\u8C61\uFF0C\u6CA1\u6709\u6539\u52A8", "conflict");
  const hooks = base.hooks ?? {};
  const start = hooks.SessionStart;
  if (start !== void 0 && !Array.isArray(start))
    throw new Problem(
      409,
      "\u8BBE\u7F6E\u91CC\u7684 hooks.SessionStart \u4E0D\u662F\u6570\u7EC4\uFF0C\u6CA1\u6709\u6539\u52A8",
      "conflict"
    );
  const groups2 = start ?? [];
  const present = groups2.some(
    (group) => isObject2(group) && Array.isArray(group.hooks) && group.hooks.some(
      (hook) => isObject2(hook) && typeof hook.command === "string" && hook.command.includes("atrium secretary bridge")
    )
  );
  if (present) return { settings: base, added: false };
  return {
    settings: {
      ...base,
      hooks: { ...hooks, SessionStart: [...groups2, hookEntry()] }
    },
    added: true
  };
}
function sessionInbox(env = process.env) {
  const raw = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim();
  if (!raw?.trim() || !token)
    throw new Problem(
      400,
      "\u4E0D\u5728 Claude Code \u4F1A\u8BDD\u91CC\uFF1A\u6CA1\u6709 CLAUDE_CODE_MESSAGING_SOCKET \u4E0E CLAUDE_CODE_MESSAGING_TOKEN\uFF08\u9700\u8981 Claude Code v2.1.224 \u53CA\u4EE5\u4E0A\uFF0CWindows v2.1.234 \u53CA\u4EE5\u4E0A\uFF1B\u5728\u79D8\u4E66\u4F1A\u8BDD\u7684 Bash \u6216 SessionStart hook \u91CC\u8FD0\u884C\uFF09",
      "usage"
    );
  const endpoint = messagingEndpoint(process.platform, raw);
  if (!endpoint)
    throw new Problem(
      400,
      `CLAUDE_CODE_MESSAGING_SOCKET \u8BA4\u4E0D\u51FA\uFF1A${raw.slice(0, 200)}`,
      "usage"
    );
  return { endpoint, token };
}
function remindMs(values) {
  const text = str(values, "remind");
  if (text === void 0) return REMIND_MS;
  if (!/^[1-9]\d*$/.test(text) || Number(text) > 1440)
    throw new Problem(
      400,
      `--remind \u5E94\u4E3A 1\uFF5E1440 \u7684\u6574\u6570\u5206\u949F\uFF08\u6536\u5230\uFF1A${text}\uFF09`,
      "usage"
    );
  return Number(text) * 6e4;
}
async function installHook(values, json) {
  const dir = resolve8(str(values, "cwd") ?? process.cwd());
  const file2 = join5(dir, ".claude", "settings.local.json");
  let text;
  try {
    text = readFileSync8(file2, "utf8");
  } catch {
    text = void 0;
  }
  let current;
  if (text !== void 0 && text.trim()) {
    try {
      current = JSON.parse(text);
    } catch {
      throw new Problem(
        409,
        `${file2} \u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF0C\u6CA1\u6709\u6539\u52A8\uFF1B\u624B\u52A8\u5728 hooks.SessionStart \u91CC\u52A0\u5165\uFF1A${JSON.stringify(hookEntry())}`,
        "conflict"
      );
    }
  }
  const { settings, added } = withBridgeHook(current);
  if (json) printJson({ file: file2, added, hook: hookEntry() });
  if (!added) {
    if (!json)
      console.log(`${file2} \u91CC\u5DF2\u6709\u8D77 bridge \u7684 SessionStart hook\uFF0C\u6CA1\u6709\u6539\u52A8`);
    recordNext("\u770B\u5728\u4E0D\u5728\u542C\uFF1Aatrium secretary bridge --status");
    return;
  }
  if (!json)
    console.log(
      [
        `\u5C06\u5199\u5165 ${file2}\uFF08hooks.SessionStart \u52A0\u4E00\u6761\uFF0C\u5176\u4F59\u8BBE\u7F6E\u4E0D\u52A8\uFF09\uFF1A`,
        JSON.stringify(hookEntry(), null, 2)
      ].join("\n")
    );
  mkdirSync5(dirname2(file2), { recursive: true });
  writeFileSync5(file2, `${JSON.stringify(settings, null, 2)}
`);
  if (!json)
    console.log(
      `\u5DF2\u5199\u5165\u3002\u4E4B\u540E\u5728 ${dir} \u6253\u5F00\u6216\u63A5\u7740\u7684 Claude Code \u4F1A\u8BDD\u90FD\u4F1A\u5728\u540E\u53F0\u8D77 bridge\uFF1B\u5F53\u524D\u4F1A\u8BDD\u8981\u9A6C\u4E0A\u751F\u6548\uFF0C\u5728\u4F1A\u8BDD\u91CC\u8FD0\u884C ${BRIDGE_HOOK_COMMAND}`
    );
  recordNext("\u770B\u5728\u4E0D\u5728\u542C\uFF1Aatrium secretary bridge --status");
}
async function status2(json) {
  const data = dataDirectory();
  const { readBridge } = await import("./chunk-QPCJ645J.js");
  const record = readBridge(data);
  const running = record && alive(record.pid) ? record : null;
  const api2 = await (await import("./chunk-P53PGFEK.js")).connect();
  const { listener } = await api2.get(
    "/events/listen?as=secretary"
  );
  if (json) printJson({ listener, bridge: running });
  else if (listener)
    console.log(
      `\u79D8\u4E66\u5728\u542C\uFF08${listener.via}\uFF09\xB7 \u81EA ${when(listener.since)}${running ? ` \xB7 bridge pid ${running.pid}` : ""}`
    );
  else
    console.log(
      running ? `bridge \u5728\u8DD1\uFF08pid ${running.pid}\uFF09\uFF0C\u4F46\u8FD8\u6CA1\u5411\u670D\u52A1\u62A5\u300C\u5728\u542C\u300D\uFF1B\u770B\u65E5\u5FD7\uFF1A${join5(data, "secretary", "bridge.log")}` : "\u6CA1\u6709 bridge \u5728\u542C\uFF1AClaude Code \u79D8\u4E66\u4F1A\u8BDD\u6536\u4E0D\u5230\u6CE8\u5165\u7684\u4E8B\u4EF6"
    );
  recordNext(
    listener ? "\u770B\u5F85\u5904\u7406\u4E8B\u4EF6\uFF1Aatrium events" : "\u5728\u79D8\u4E66\u76EE\u5F55\u88C5 hook\uFF1Aatrium secretary bridge --install-hook"
  );
}
async function detach(values) {
  const { endpoint } = sessionInbox();
  const data = dataDirectory();
  const bridge = await import("./chunk-QPCJ645J.js");
  const current = bridge.readBridge(data);
  if (bridgeClaim(current, endpoint, alive) === "running") {
    console.log(
      `Atrium bridge \u5DF2\u5728\u8DD1\uFF08pid ${current.pid}\uFF09\uFF1A\u8981\u5904\u7406\u7684\u4E8B\u4EF6\u4EE5\u300C\u3010Atrium \u4E8B\u4EF6\u3011\u300D\u6D88\u606F\u9001\u8FDB\u672C\u4F1A\u8BDD\uFF0C\u5904\u7406\u5B8C atrium events ack <\u7F16\u53F7>`
    );
    recordNext("\u770B\u5728\u4E0D\u5728\u542C\uFF1Aatrium secretary bridge --status");
    return;
  }
  const { spawnNode } = await import("./chunk-OEBBC3LC.js");
  mkdirSync5(join5(data, "secretary"), { recursive: true, mode: 448 });
  const logPath = bridge.bridgeLog(data);
  const log2 = openSync(logPath, "a", 384);
  let child;
  try {
    const remind = str(values, "remind");
    child = spawnNode(
      [
        ...process.execArgv,
        process.argv[1],
        "secretary",
        "bridge",
        ...remind === void 0 ? [] : ["--remind", remind]
      ],
      { detached: true, stdio: ["ignore", log2, log2], env: process.env }
    );
  } finally {
    closeSync(log2);
  }
  let exited = null;
  child.once("exit", (code) => exited = code ?? 1);
  child.once("error", () => exited = 1);
  child.unref();
  const deadline = Date.now() + 1e4;
  while (exited === null && bridge.readBridge(data)?.pid !== child.pid && Date.now() < deadline)
    await new Promise((resolve11) => setTimeout(resolve11, 100));
  if (exited !== null || bridge.readBridge(data)?.pid !== child.pid)
    throw new Problem(
      500,
      `bridge \u6CA1\u8D77\u6765${exited !== null ? `\uFF08\u9000\u51FA\u7801 ${exited}\uFF09` : ""}\uFF1B\u770B\u65E5\u5FD7\uFF1A${logPath}`,
      "internal"
    );
  console.log(
    `Atrium bridge \u5DF2\u5728\u540E\u53F0\u8FD0\u884C\uFF08pid ${child.pid}\uFF09\uFF1A\u79D8\u4E66\u8981\u5904\u7406\u7684\u4E8B\u4EF6\u4F1A\u4EE5\u300C\u3010Atrium \u4E8B\u4EF6\u3011\u300D\u5F00\u5934\u7684\u6D88\u606F\u9001\u8FDB\u672C\u4F1A\u8BDD\uFF0C\u5904\u7406\u5B8C\u7528 atrium events ack <\u7F16\u53F7> \u786E\u8BA4\u3002\u65E5\u5FD7\uFF1A${logPath}`
  );
  recordNext("\u770B\u5728\u4E0D\u5728\u542C\uFF1Aatrium secretary bridge --status");
}
async function foreground(values) {
  const remind = remindMs(values);
  const { endpoint, token } = sessionInbox();
  const data = dataDirectory();
  const bridge = await import("./chunk-QPCJ645J.js");
  const current = bridge.readBridge(data);
  if (current?.pid !== process.pid && bridgeClaim(current, endpoint, alive) === "running")
    throw new Problem(
      409,
      `\u672C\u4F1A\u8BDD\u7684 bridge \u5DF2\u5728\u8DD1\uFF08pid ${current.pid}\uFF09`,
      "conflict",
      void 0,
      "atrium secretary bridge --status"
    );
  bridge.writeBridge(data, {
    pid: process.pid,
    socket: endpoint,
    started_at: Date.now()
  });
  const log2 = (line3) => console.error(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${line3}`);
  const loop = new bridge.SecretaryBridge({
    endpoint,
    token,
    remindMs: remind,
    source: bridge.serviceSource(
      await (await import("./chunk-P53PGFEK.js")).connect(true)
    ),
    owner: () => {
      const record = bridge.readBridge(data);
      return !record || record.pid === process.pid;
    },
    log: log2
  });
  const stop2 = () => loop.close();
  process.on("SIGINT", stop2);
  process.on("SIGTERM", stop2);
  log2(`bridge \u5F00\u59CB\uFF08pid ${process.pid}\uFF0C\u4F1A\u8BDD\u6536\u4EF6\u5730\u5740 ${endpoint}\uFF09`);
  try {
    log2(`bridge \u9000\u51FA\uFF1A${await loop.run()}`);
  } finally {
    process.off("SIGINT", stop2);
    process.off("SIGTERM", stop2);
    bridge.releaseBridge(data, process.pid);
  }
  recordNext("\u770B\u5728\u4E0D\u5728\u542C\uFF1Aatrium secretary bridge --status");
}
var bridgeCommand = {
  args: "[--detach] [--remind \u5206\u949F] | --install-hook [--cwd \u76EE\u5F55] | --status",
  about: "\u5728 Claude Code \u79D8\u4E66\u4F1A\u8BDD\u91CC\u5E38\u9A7B\uFF1A\u628A\u8981\u5904\u7406\u7684\u4E8B\u4EF6\u7ECF\u4F1A\u8BDD\u6536\u4EF6 socket \u6CE8\u5165\u4F1A\u8BDD\uFF08\u4E0D\u786E\u8BA4\uFF0C\u79D8\u4E66\u5904\u7406\u5B8C\u81EA\u5DF1 ack\uFF09\uFF0C\u6309\u7F16\u53F7\u53BB\u91CD\u3001\u6CA1\u786E\u8BA4\u7684\u9694 30 \u5206\u949F\u518D\u63D0\u9192\uFF1B\u4F1A\u8BDD\u5173\u4E86\u5C31\u9000\u51FA\uFF1B--install-hook \u5728\u79D8\u4E66\u76EE\u5F55\u88C5 SessionStart hook \u968F\u4F1A\u8BDD\u81EA\u52A8\u8D77",
  options: {
    detach: { type: "boolean", default: false },
    remind: { type: "string" },
    "install-hook": { type: "boolean", default: false },
    cwd: { type: "string" },
    status: { type: "boolean", default: false }
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const modes = ["detach", "install-hook", "status"].filter(
      (key) => values[key] === true
    );
    if (modes.length > 1)
      throw new Problem(400, `--${modes.join("\u3001--")} \u4E0D\u80FD\u4E00\u8D77\u7528`, "usage");
    if (values.cwd !== void 0 && values["install-hook"] !== true)
      throw new Problem(400, "--cwd \u53EA\u548C --install-hook \u4E00\u8D77\u7528", "usage");
    if (values["install-hook"] === true) return installHook(values, json);
    if (values.status === true) return status2(json);
    remindMs(values);
    if (values.detach === true) return detach(values);
    return foreground(values);
  }
};
var secretaryCommands = {
  "secretary bridge": bridgeCommand
};

// cli/schedules.ts
import { existsSync as existsSync4, statSync as statSync2 } from "node:fs";
import { resolve as resolve9 } from "node:path";
var api = async () => (await import("./chunk-P53PGFEK.js")).connect();
var enc3 = encodeURIComponent;
var kindText = { task: "\u4EFB\u52A1", patrol: "\u4F53\u9A8C\u5DE1\u68C0", research: "\u8C03\u7814" };
var stateText = { active: "", removed: "\u5DF2\u5220\u9664" };
var outcomeText = { created: "\u751F\u6210", skipped: "\u8DF3\u8FC7", failed: "\u5931\u8D25" };
function everyWords(every, at) {
  const match = /^(\d+)([mhd])$/.exec(every);
  const unit = { m: "\u5206\u949F", h: "\u5C0F\u65F6", d: "\u5929" }[match?.[2] ?? "d"];
  const n = Number(match?.[1] ?? 0);
  const base = !match ? `\u6BCF ${every}` : n === 1 && unit !== "\u5206\u949F" ? unit === "\u5929" ? "\u6BCF\u5929" : "\u6BCF\u5C0F\u65F6" : `\u6BCF ${n} ${unit}`;
  return at ? `${base} ${at}` : base;
}
function scheduleLine(s) {
  return [
    `${s.ref} ${s.title}`,
    everyWords(s.every, s.at),
    s.kind === "task" || s.title === kindText[s.kind] ? "" : kindText[s.kind],
    `${s.node_name ?? s.node}\uFF08${s.node}\uFF09`,
    s.state === "active" && s.next_at !== null ? `\u4E0B\u6B21 ${when(s.next_at)}` : stateText[s.state],
    s.last_task ? `\u4E0A\u4E00\u8F6E ${s.last_task.ref} ${s.last_task.status}` : ""
  ].filter(Boolean).join(" \xB7 ");
}
function detailText(s) {
  return [
    scheduleLine(s),
    ...s.by ? [`\u4E13\u5458\uFF1A${s.by}`] : [],
    ...s.worker ? [`\u6267\u884C\u8005\uFF1A${s.worker}`] : [],
    ...s.brief ? ["\u8BE6\u8FF0\uFF1A", s.brief.trimEnd()] : [],
    s.runs.length ? "\u6700\u8FD1\u51E0\u8F6E\uFF1A" : "\u8FD8\u6CA1\u6709\u8DD1\u8FC7",
    ...s.runs.map(
      (run2) => `  ${when(run2.at)} ${outcomeText[run2.outcome]}${run2.task ? ` ${run2.task}` : ""}${run2.note ? ` \xB7 ${run2.note}` : ""}`
    )
  ].join("\n");
}
var output2 = (json, result, line3, next) => {
  if (json) printJson(result);
  else console.log(line3);
  recordNext(next);
};
function file(value) {
  const path5 = resolve9(value);
  if (!existsSync4(path5) || !statSync2(path5).isFile())
    throw new Problem(400, `--brief \u6307\u5411\u7684\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${path5}`, "usage");
  return path5;
}
var scheduleCommands = {
  "schedule add": {
    args: "\u8282\u70B9 [\u6807\u9898] --every 7d|1d|12h [--at 09:00] [--kind task|patrol|research] [--brief \u6587\u4EF6|-] [--by \u4E13\u5458] [--worker \u5DE5\u5177+\u6A21\u578B[:\u5F3A\u5EA6]]",
    about: "\u5468\u671F\u4EFB\u52A1\uFF1A\u5230\u70B9\u5728\u8282\u70B9\u4E0B\u751F\u6210\u4E00\u4EF6\u666E\u901A\u4EFB\u52A1\u5E76\u6D3E\u53D1\uFF08\u95F2\u65F6/\u666E\u901A\u6309\u8282\u70B9\u7F3A\u7701\uFF09\uFF1B\u4E0A\u4E00\u8F6E\u6CA1\u7ED3\u675F\u5C31\u8DF3\u8FC7\u672C\u8F6E\u5E76\u8BB0\u4E00\u7B14\uFF0C\u670D\u52A1\u505C\u673A\u9519\u8FC7\u7684\u53EA\u8865\u4E00\u8F6E\uFF1B--at \u672C\u673A\u949F\u70B9\uFF08\u53EA\u7528\u4E8E\u6574\u5929\u7684\u5468\u671F\uFF09\uFF1B--kind patrol \u4F53\u9A8C\u5DE1\u68C0\uFF08\u6309\u8282\u70B9 uses \u573A\u666F\u8F6E\u6362\uFF0C\u53D1\u73B0\u76F4\u63A5\u5EFA\u4FEE\u590D\u4EFB\u52A1\uFF1B\u6807\u9898\u53EF\u7701\uFF09\uFF0Cresearch \u53EA\u8C03\u7814\u4E0D\u4EA4 PR",
    options: {
      every: { type: "string" },
      at: { type: "string" },
      kind: { type: "string" },
      brief: { type: "string" },
      by: { type: "string" },
      worker: { type: "string" }
    },
    positionals: [1, 2],
    async run({ positionals: [node, title], values, json }) {
      if (!str(values, "every"))
        throw new Problem(
          400,
          "--every: \u5FC5\u586B\uFF0C\u5982 7d\u30011d\u300112h",
          "usage",
          void 0,
          `atrium schedule add ${node} ${title ?? "\u6807\u9898"} --every 7d`
        );
      const brief = str(values, "brief");
      const body = {
        node,
        ...title === void 0 ? {} : { title },
        every: str(values, "every"),
        ...str(values, "at") ? { at: str(values, "at") } : {},
        ...str(values, "kind") ? { kind: str(values, "kind") } : {},
        ...str(values, "by") ? { by: str(values, "by") } : {},
        ...str(values, "worker") ? { worker: str(values, "worker") } : {},
        ...brief === void 0 ? {} : await (await import("./chunk-J6LS4XLB.js")).briefInput(brief, file)
      };
      const result = await (await api()).post("/schedules", body);
      output2(
        json,
        result,
        `\u5DF2\u5EFA ${scheduleLine(result)}`,
        `\u9A6C\u4E0A\u8DD1\u4E00\u8F6E\uFF1Aatrium schedule run ${result.ref}`
      );
    }
  },
  "schedule ls": {
    args: "[sN] [--node \u8282\u70B9] [--all] [--after sN]",
    about: "\u5217\u5468\u671F\u4EFB\u52A1\uFF1A--node \u53EA\u770B\u8BE5\u8282\u70B9\u53CA\u4E0B\u5C42\uFF0C--all \u8FDE\u5DF2\u5220\u9664\u7684\u4E00\u8D77\u5217\uFF1B\u6BCF\u9875\u81F3\u591A 200 \u6761\uFF1B\u7ED9 sN \u770B\u8FD9\u4E00\u6761\uFF1A\u8282\u594F\u3001\u4E0B\u6B21\u65F6\u95F4\u3001\u8BE6\u8FF0\u4E0E\u6700\u8FD1\u51E0\u8F6E\uFF08\u751F\u6210\u3001\u8DF3\u8FC7\u3001\u5931\u8D25\uFF09",
    options: {
      node: { type: "string" },
      all: { type: "boolean" },
      after: { type: "string" }
    },
    positionals: [0, 1],
    async run({ positionals: [ref3], values, json }) {
      if (ref3 !== void 0) {
        const result2 = await (await api()).get(`/schedules/${enc3(ref3)}`);
        output2(
          json,
          result2,
          detailText(result2),
          result2.last_task ? `\u770B\u4E0A\u4E00\u8F6E\uFF1Aatrium task show ${result2.last_task.ref}` : `\u9A6C\u4E0A\u8DD1\u4E00\u8F6E\uFF1Aatrium schedule run ${result2.ref}`
        );
        return;
      }
      const query = new URLSearchParams();
      if (str(values, "node")) query.set("node", str(values, "node"));
      if (values.all === true) query.set("all", "1");
      if (str(values, "after")) query.set("after", str(values, "after"));
      const result = await (await api()).get(
        `/schedules${query.size ? `?${query}` : ""}`
      );
      output2(
        json,
        result,
        [
          ...result.schedules.length ? result.schedules.map(scheduleLine) : ["\u8FD8\u6CA1\u6709\u5468\u671F\u4EFB\u52A1"],
          ...result.next_after ? [`\u8FD8\u6709\u66F4\u591A\uFF1Aatrium schedule ls --after ${result.next_after}`] : []
        ].join("\n"),
        result.schedules.length ? `\u770B\u4E00\u6761\uFF1Aatrium schedule ls ${result.schedules[0].ref}` : "\u5EFA\u4E00\u6761\uFF1Aatrium schedule add \u8282\u70B9 \u6807\u9898 --every 7d"
      );
    }
  },
  "schedule run": {
    args: "sN",
    about: "\u9A6C\u4E0A\u8DD1\u4E00\u8F6E\uFF08\u4E0D\u6539\u4E0B\u6B21\u65F6\u95F4\uFF09\uFF1B\u4E0A\u4E00\u8F6E\u6CA1\u7ED3\u675F\u65F6\u4E0D\u8D77",
    positionals: [1, 1],
    async run({ positionals: [ref3], json }) {
      const result = await (await api()).post(`/schedules/${enc3(ref3)}/run`, {});
      output2(
        json,
        result,
        `${result.schedule} \u5DF2\u751F\u6210 ${result.task.ref}\uFF1A${result.task.title}${result.queued ? "\uFF08\u6392\u961F\u4E2D\uFF09" : ""}`,
        `\u7B49\u7ED3\u679C\uFF1Aatrium task wait ${result.task.ref}`
      );
    }
  },
  "schedule rm": {
    args: "sN",
    about: "\u5220\u9664\u5468\u671F\u4EFB\u52A1\uFF1A\u4E0D\u518D\u751F\u6210\uFF0C\u5DF2\u751F\u6210\u7684\u4EFB\u52A1\u7167\u5E38\uFF1BsN \u4E0D\u590D\u7528",
    positionals: [1, 1],
    async run({ positionals: [ref3], json }) {
      const result = await (await api()).delete(`/schedules/${enc3(ref3)}`);
      output2(
        json,
        result,
        `${result.ref} \u5DF2\u5220\u9664\uFF1A${scheduleLine(result)}`,
        `\u770B\u5468\u671F\u4EFB\u52A1\uFF1Aatrium schedule ls ${result.ref}`
      );
    }
  }
};

// cli/memos.ts
import { readFileSync as readFileSync9 } from "node:fs";
var client12 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var ownerOf = (values) => {
  const who5 = (str(values, "as") ?? defaultSubscriber()).trim();
  if (!who5) throw new Problem(400, "--as \u4E0D\u80FD\u4E3A\u7A7A", "usage");
  return who5;
};
var asFlag = (owner) => owner === "secretary" ? "" : ` --as ${owner}`;
var whose = (owner, name) => owner === "secretary" ? "\u79D8\u4E66" : owner === "u1" ? "\u7528\u6237" : `${owner}${name ? `\uFF08${name}\uFF09` : ""}`;
var memoCommands = {
  "memo show": {
    args: "[--as secretary|u1|aN]",
    about: "\u770B\u5907\u5FD8\uFF08\u65B0\u4F1A\u8BDD\u3001\u6362\u4EBA\u63A5\u624B\u5148\u8DD1\u8FD9\u4E00\u6761\uFF09\uFF1A\u5728\u7B49\u4EC0\u4E48\u3001\u4E0B\u6B21\u5148\u770B\u4EC0\u4E48\uFF1B\u7F3A\u7701\u79D8\u4E66\uFF0Cleader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u81EA\u5DF1",
    options: { as: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const owner = ownerOf(values);
      const view = await (await client12()).get(`/memo?as=${encodeURIComponent(owner)}`);
      if (json) printJson(view);
      else
        console.log(
          [
            `${whose(view.owner, view.name)}\u7684\u5907\u5FD8\uFF08${Array.from(view.memo).length}/${view.memo_max} \u5B57${view.memo_updated_at ? ` \xB7 ${when(view.memo_updated_at)} \u66F4\u65B0` : ""}\uFF09\uFF1A`,
            view.memo || "\uFF08\u7A7A\uFF09"
          ].join("\n")
        );
      recordNext(`\u6539\u5907\u5FD8\uFF1Aatrium memo edit \u6587\u672C${asFlag(view.owner)}`);
    }
  },
  "memo edit": {
    args: "[\u6587\u672C] [--file \u6587\u4EF6] [--as secretary|aN]",
    about: "\u8986\u76D6\u5199\u5907\u5FD8\uFF1A\u5728\u7B49\u4EC0\u4E48\u3001\u4E0B\u6B21\u5148\u770B\u4EC0\u4E48\u8FD9\u7C7B\u5F53\u524D\u72B6\u6001\uFF08\u6709\u957F\u5EA6\u4E0A\u9650\uFF0C\u8D85\u4E86\u5148\u7CBE\u7B80\uFF09",
    options: { as: { type: "string" }, file: { type: "string" } },
    positionals: [0, 1],
    async run({ positionals: [text], values, json }) {
      const file2 = str(values, "file");
      if (text === void 0 === (file2 === void 0))
        throw new Problem(
          400,
          "\u5907\u5FD8\u6B63\u6587\u7ED9\u4E00\u79CD\uFF1A\u76F4\u63A5\u5199\u6587\u672C\uFF0C\u6216 --file \u6587\u4EF6",
          "usage"
        );
      let memo = text;
      if (file2 !== void 0) {
        try {
          memo = readFileSync9(file2, "utf8");
        } catch {
          throw new Problem(400, `--file: \u8BFB\u4E0D\u5230 ${file2}`, "usage");
        }
      }
      const owner = ownerOf(values);
      const view = await (await client12()).put(`/memo?as=${encodeURIComponent(owner)}`, { memo });
      if (json) printJson(view);
      else
        console.log(
          `\u5DF2\u66F4\u65B0${whose(view.owner, view.name)}\u7684\u5907\u5FD8\uFF08${Array.from(view.memo).length}/${view.memo_max} \u5B57\uFF09`
        );
      recordNext(`\u770B\uFF1Aatrium memo show${asFlag(view.owner)}`);
    }
  },
  "decision add": {
    args: "\u51B3\u5B9A --why \u539F\u56E0 [--date \u65E5\u671F] [--issue \u53F7] [--node \u8282\u70B9]\u2026 [--task tN] [--supersedes dN]",
    about: "\u8BB0\u4E00\u6761\u7528\u6237\u62CD\u677F\u7684\u51B3\u5B9A\u4E0E\u539F\u56E0\uFF08\u7ED9\u4EBA\u56DE\u770B\uFF0C\u4E0D\u9644\u8FDB\u63D0\u793A\u8BCD\uFF09\uFF1B\u53EF\u5173\u8054 issue\u3001\u4E00\u4E2A\u6216\u591A\u4E2A\u8282\u70B9\u3001\u4EFB\u52A1\uFF1B\u8865\u8BB0\u65E7\u51B3\u5B9A\u7528 --date\uFF1B--supersedes \u540C\u65F6\u628A\u65E7\u51B3\u5B9A\u6807\u4E3A\u5DF2\u63A8\u7FFB\u3002\u8981\u5927\u5BB6\u5B88\u7684\u89C4\u77E9\u5199\u6210\u8981\u70B9\uFF1Aatrium org point-add",
    options: {
      why: { type: "string" },
      date: { type: "string" },
      issue: { type: "string" },
      node: { type: "string", multiple: true },
      task: { type: "string" },
      supersedes: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [text], values, json }) {
      const body = { text };
      for (const key of ["why", "date", "issue", "task", "supersedes"])
        if (str(values, key) !== void 0) body[key] = str(values, key);
      if (strs(values, "node").length) body.node = strs(values, "node");
      if (body.why === void 0)
        throw new Problem(400, "--why: \u539F\u56E0\u5FC5\u586B", "usage");
      const decision = await (await client12()).post("/decisions", body);
      if (json) printJson(decision);
      else console.log(`\u5DF2\u8BB0\u4E0B ${decision.ref}
${decisionLine(decision)}`);
      recordNext(
        decision.nodes.length ? `\u770B\u8FD9\u4E00\u5757\u7684\uFF1Aatrium decision ls --node ${decision.nodes[0].ref}` : "\u770B\u5168\u90E8\uFF1Aatrium decision ls"
      );
    }
  },
  "decision ls": {
    args: "[\u5173\u952E\u8BCD\u2026] [--node \u8282\u70B9] [--all] [--before dN] [--limit \u6761\u6570]",
    about: "\u5217\u7528\u6237\u62CD\u677F\u7684\u51B3\u5B9A\uFF0C\u65E5\u671F\u65B0\u7684\u5728\u524D\uFF1B\u7ED9\u5173\u952E\u8BCD\u53EA\u5217\u51B3\u5B9A\u4E0E\u539F\u56E0\u91CC\u5168\u90E8\u547D\u4E2D\u7684\uFF1B--node \u53EA\u5217\u6302\u5728\u8BE5\u8282\u70B9\u53CA\u5176\u4E0A\u7EA7\u7684\uFF1B\u7F3A\u7701\u53EA\u5217\u6CA1\u88AB\u63A8\u7FFB\u7684\uFF0C--all \u8FDE\u5DF2\u63A8\u7FFB\u7684\uFF1B--before \u63A5\u7740\u4E0A\u4E00\u9875\u5F80\u4E0B",
    options: {
      node: { type: "string" },
      all: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [0, 5],
    async run({ positionals, values, json }) {
      const query = new URLSearchParams();
      if (values.all === true) query.set("all", "1");
      for (const key of ["before", "limit", "node"])
        if (str(values, key) !== void 0) query.set(key, str(values, key));
      if (positionals.length) query.set("q", positionals.join(" "));
      const page = await (await client12()).get(`/decisions?${query}`);
      if (json) printJson(page);
      else
        console.log(
          [
            `\u51B3\u5B9A\u8BB0\u5F55\uFF1A\u6709\u6548 ${page.active} \u6761\uFF0C\u5DF2\u63A8\u7FFB ${page.superseded} \u6761${values.all === true ? "" : "\uFF08\u53EA\u5217\u6709\u6548\u7684\uFF09"}`,
            ...page.decisions.map((d) => `- ${decisionLine(d)}`)
          ].join("\n")
        );
      const again = [
        ...positionals,
        ...str(values, "node") ? [`--node ${str(values, "node")}`] : [],
        ...values.all === true ? ["--all"] : []
      ].join(" ");
      recordNext(
        page.next_before ? `\u5F80\u4E0B\u770B\uFF1Aatrium decision ls${again ? ` ${again}` : ""} --before ${page.next_before}` : "\u8BB0\u4E00\u6761\uFF1Aatrium decision add \u51B3\u5B9A --why \u539F\u56E0"
      );
    }
  }
};

// cli/materials.ts
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync6,
  readdirSync as readdirSync2,
  readFileSync as readFileSync10,
  realpathSync as realpathSync2,
  statSync as statSync3,
  writeFileSync as writeFileSync6
} from "node:fs";
import { basename as basename2, dirname as dirname3, join as join6, relative, resolve as resolve10, sep } from "node:path";
var client13 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var who2 = (reader) => reader === null ? "" : reader === "secretary" ? "\u79D8\u4E66" : reader;
var readText2 = (m) => m.last_read_at ? `${when(m.last_read_at)} ${who2(m.last_read_by)} \u8BFB\u8FC7` : "\u8FD8\u6CA1\u4EBA\u8BFB\u8FC7";
function collect(input) {
  let stat;
  try {
    stat = statSync3(input);
  } catch {
    throw new Problem(400, `\u6587\u4EF6|\u76EE\u5F55: \u8BFB\u4E0D\u5230 ${input}`, "usage");
  }
  const name = basename2(resolve10(input));
  if (stat.isFile() && stat.size > MATERIAL_MAX_BYTES)
    throw new Problem(400, tooBig(stat.size), "usage");
  if (stat.isFile())
    return {
      kind: "file",
      name,
      files: [{ path: name, abs: resolve10(input), size: stat.size }],
      skipped: []
    };
  if (!stat.isDirectory())
    throw new Problem(400, `\u6587\u4EF6|\u76EE\u5F55: ${input} \u4E0D\u662F\u6587\u4EF6\u6216\u76EE\u5F55`, "usage");
  const root = realpathSync2(input);
  const files = [];
  const skipped = [];
  const seen = /* @__PURE__ */ new Set([root]);
  let size = 0;
  const walk = (dir, prefix) => {
    const entries = readdirSync2(dir, { withFileTypes: true }).sort(
      (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry2 of entries) {
      const rel = prefix ? `${prefix}/${entry2.name}` : entry2.name;
      if (entry2.name.startsWith(".")) {
        skipped.push(rel);
        continue;
      }
      let full = join6(dir, entry2.name);
      if (entry2.isSymbolicLink()) {
        let real2;
        try {
          real2 = realpathSync2(full);
        } catch {
          skipped.push(rel);
          continue;
        }
        if (real2 !== root && !real2.startsWith(root + sep))
          throw new Problem(
            400,
            `\u6587\u4EF6|\u76EE\u5F55: ${rel} \u662F\u6307\u5411\u76EE\u5F55\u5916\u7684\u8F6F\u94FE\u63A5\uFF0C\u4E0D\u6536\uFF1B\u628A\u5B83\u6307\u5411\u7684\u5185\u5BB9\u590D\u5236\u8FDB\u6765\u518D\u52A0`,
            "usage"
          );
        full = real2;
      }
      const info = statSync3(full);
      if (info.isDirectory()) {
        if (seen.has(full)) continue;
        seen.add(full);
        walk(full, rel);
      } else if (info.isFile()) {
        const problem = pathProblem(rel);
        if (problem) throw new Problem(400, `\u6587\u4EF6|\u76EE\u5F55: ${problem}`, "usage");
        size += info.size;
        if (size > MATERIAL_MAX_BYTES)
          throw new Problem(400, tooBig(size), "usage");
        files.push({ path: rel, abs: full, size: info.size });
        if (files.length > MATERIAL_MAX_FILES)
          throw new Problem(
            400,
            `\u6587\u4EF6|\u76EE\u5F55: \u8D85\u8FC7 ${MATERIAL_MAX_FILES} \u4E2A\u6587\u4EF6\uFF1B\u6253\u6210\u538B\u7F29\u5305\u518D\u52A0`,
            "usage"
          );
      } else skipped.push(rel);
    }
  };
  walk(root, "");
  return { kind: "dir", name, files, skipped };
}
function materialLines(list3) {
  if (!list3.length) return "\uFF08\u6CA1\u6709\uFF09";
  return table([
    ["\u8D44\u6599", "\u540D\u79F0", "\u8BF4\u660E", "\u8282\u70B9", "\u7248\u672C", "\u5927\u5C0F", "\u8BFB\u53D6"],
    ...list3.map((m) => [
      m.ref,
      oneLine(m.name, 30),
      oneLine(m.note, 36),
      m.node,
      `v${m.version}`,
      sizeText(m.bytes),
      readText2(m)
    ])
  ]);
}
function detailText2(d) {
  const state2 = d.archived ? `\u5DF2\u5F52\u6863\uFF08${when(d.archived_at)}${d.archive_note ? `\uFF1A${d.archive_note}` : ""}\uFF09` : d.superseded_by ? `\u5DF2\u88AB ${d.superseded_by} \u53D6\u4EE3` : "\u5728\u7528";
  return [
    `${d.ref} ${d.name}\uFF08${d.kind === "dir" ? `\u76EE\u5F55\uFF0C${d.files} \u4E2A\u6587\u4EF6` : "\u6587\u4EF6"}\uFF09 \xB7 \u6302\u5728 ${d.node}${d.node_name ? ` ${d.node_name}` : ""}`,
    `\u8BF4\u660E\uFF1A${d.note || "\uFF08\u6CA1\u5199\uFF09"}`,
    `\u72B6\u6001\uFF1A${state2} \xB7 \u5F53\u524D v${d.version}\uFF0C${sizeText(d.bytes)} \xB7 \u52A0\u4E8E ${when(d.created_at)}\uFF08${who2(d.created_by)}\uFF09`,
    ...d.supersedes.length ? [`\u53D6\u4EE3\u4E86\uFF1A${d.supersedes.join("\u3001")}`] : [],
    ...d.links.length ? [
      `\u5173\u8054\uFF1A${d.links.map((l) => `${l.ref}${l.ended ? "\uFF08\u5DF2\u7ED3\u675F\uFF09" : ""}`).join("\u3001")}`
    ] : [],
    ...d.keep_note ? [`\u7559\u4E0B\uFF1A${d.keep_note}\uFF08\u6E05\u7406\u7EBF\u7D22\u4E0D\u518D\u63D0\uFF09`] : [],
    ...d.stale ? [`\u6E05\u7406\u7EBF\u7D22\uFF1A\u7591\u4F3C\u6CA1\u7528\u2014\u2014${d.stale.reason}`] : [],
    "",
    "\u7248\u672C\uFF08\u65B0\u7684\u5728\u524D\uFF09\uFF1A",
    ...d.versions.map(
      (v) => `- v${v.version} ${when(v.created_at)} ${who2(v.created_by)} \xB7 ${v.files} \u4E2A\u6587\u4EF6 ${sizeText(v.bytes)}${v.note ? ` \xB7 ${v.note}` : ""}`
    ),
    "",
    `\u8C01\u8BFB\u8FC7\uFF08\u6700\u8FD1 ${d.reads.length} \u6B21\uFF09\uFF1A`,
    ...d.reads.length ? d.reads.map((r) => `- ${when(r.at)} ${who2(r.reader)} \u8BFB v${r.version}`) : ["\uFF08\u8FD8\u6CA1\u4EBA\u8BFB\u8FC7\uFF09"]
  ].join("\n");
}
async function stale(values, json) {
  const node = str(values, "node");
  const result = await (await client13()).get(`/materials/stale${node ? `?node=${encodeURIComponent(node)}` : ""}`);
  if (json) printJson(result);
  else
    console.log(
      [
        `\u7591\u4F3C\u6CA1\u7528\uFF08${result.stale.length} \u4EFD\uFF09\uFF1A`,
        ...result.stale.length ? result.stale.map(
          (m) => `- ${m.ref} ${m.name}\uFF08${m.node}\uFF09\uFF1A${m.stale.reason}`
        ) : ["\uFF08\u6CA1\u6709\uFF09"],
        ...node ? [] : [
          "",
          `\u53EF\u4EE5\u771F\u5220\uFF08\u5F52\u6863\u8D85\u8FC7\u4E00\u5E74\u4E14\u5927\u4E8E 10 MB\uFF0C\u8981\u7528\u6237\u70B9\u5934\uFF1B${result.purge.length} \u4EFD\uFF09\uFF1A`,
          ...result.purge.length ? result.purge.map(
            (m) => `- ${m.ref} ${m.name}\uFF08${m.node}\uFF09\uFF1A\u5F52\u6863\u4E8E ${when(m.archived_at)}\uFF0C\u5171 ${sizeText(m.total_bytes)}`
          ) : ["\uFF08\u6CA1\u6709\uFF09"]
        ]
      ].join("\n")
    );
  const first = result.stale[0];
  if (first)
    recordNext(
      `\u7528\u4E0D\u4E0A\u5C31\u5F52\u6863\uFF1Aatrium material archive ${first.ref} --note \u539F\u56E0\uFF1B\u8981\u7559\uFF1Aatrium material keep ${first.ref} --note \u539F\u56E0`
    );
}
var materialCommands = {
  "material add": {
    args: "\u8282\u70B9 \u6587\u4EF6|\u76EE\u5F55 --note \u4E00\u53E5\u8BDD [--name \u540D\u79F0] [--supersedes mN] [--for t1,k1,d1]",
    about: "\u628A\u6587\u4EF6\u6216\u76EE\u5F55\u4F5C\u4E3A\u8D44\u6599\u6302\u5230\u8282\u70B9\u4E0A\uFF08\u5B58\u8FDB\u6570\u636E\u76EE\u5F55\uFF0C\u5355\u7248\u81F3\u591A 20 MB\uFF0C\u9690\u85CF\u6587\u4EF6\u4E0D\u6536\uFF09\uFF1B\u540C\u4E00\u8282\u70B9\u540C\u540D\u7684\u518D\u52A0\u5C31\u662F\u65B0\u7248\u672C\uFF1B--supersedes \u6807\u65E7\u8D44\u6599\u88AB\u53D6\u4EE3\uFF0C--for \u5173\u8054\u4EFB\u52A1\u3001\u8981\u70B9\u6216\u51B3\u5B9A\uFF08\u6E05\u7406\u7EBF\u7D22\u770B\u5B83\u4EEC\u662F\u5426\u7ED3\u675F\uFF09",
    options: {
      note: { type: "string" },
      name: { type: "string" },
      supersedes: { type: "string" },
      for: { type: "string" }
    },
    positionals: [2, 2],
    async run({ positionals: [node, path5], values, json }) {
      const found = collect(path5);
      const name = str(values, "name") ?? found.name;
      const files = found.files.map((f) => ({
        path: found.kind === "file" ? name : f.path,
        data: readFileSync10(f.abs).toString("base64")
      }));
      const body = {
        node,
        kind: found.kind,
        name,
        files
      };
      for (const key of ["note", "supersedes", "for"])
        if (str(values, key) !== void 0) body[key] = str(values, key);
      const result = await (await client13()).post("/materials", body);
      const m = result.material;
      if (json) printJson({ ...result, skipped: found.skipped });
      else
        console.log(
          [
            result.outcome === "new" ? `\u5DF2\u6302\u4E0A ${m.ref} ${m.name} \u2192 ${m.node}\uFF08v1\uFF0C${m.files} \u4E2A\u6587\u4EF6\uFF0C${sizeText(m.bytes)}\uFF09` : result.outcome === "version" ? `${m.ref} ${m.name} \u52A0\u4E86\u65B0\u7248\u672C v${m.version}\uFF08${m.files} \u4E2A\u6587\u4EF6\uFF0C${sizeText(m.bytes)}\uFF09` : `${m.ref} ${m.name} \u5185\u5BB9\u548C\u5F53\u524D\u7248\u672C v${m.version} \u4E00\u6837\uFF0C\u6CA1\u52A0\u65B0\u7248\u672C`,
            ...found.skipped.length ? [
              `\u8DF3\u8FC7 ${found.skipped.length} \u4E2A\u9690\u85CF\u6587\u4EF6\u6216\u7279\u6B8A\u6587\u4EF6\uFF1A${found.skipped.slice(0, 5).join("\u3001")}${found.skipped.length > 5 ? " \u7B49" : ""}`
            ] : []
          ].join("\n")
        );
      recordNext(`\u770B\uFF1Aatrium material show ${m.ref}`);
    }
  },
  "material ls": {
    args: "[--node \u8282\u70B9] [--archived] [--stale] [--before mN] [--limit \u6761\u6570]",
    about: "\u5217\u8D44\u6599\uFF08\u65B0\u7684\u5728\u524D\uFF09\uFF1A\u77ED\u53F7\u3001\u540D\u79F0\u3001\u4E00\u53E5\u8BDD\u3001\u8282\u70B9\u3001\u7248\u672C\u3001\u5927\u5C0F\u3001\u6700\u8FD1\u8C01\u8BFB\u8FC7\uFF1B\u7F3A\u7701\u4E0D\u542B\u5F52\u6863\u7684\uFF0C--archived \u53EA\u5217\u5F52\u6863\u7684\uFF1B--stale \u5217\u6E05\u7406\u7EBF\u7D22\uFF1A\u7591\u4F3C\u6CA1\u7528\u7684\u8D44\u6599\uFF08\u88AB\u53D6\u4EE3\uFF0C\u6216 90 \u5929\u6CA1\u8BFB\u4E14\u5173\u8054\u90FD\u7ED3\u675F\uFF1B\u7531\u8FD9\u4E00\u5757\u7684 leader \u5B9A\u5F52\u6863\u8FD8\u662F\u7559\uFF09\uFF0C\u770B\u5168\u90E8\u65F6\u53E6\u5217\u5F52\u6863\u8D85\u8FC7\u4E00\u5E74\u4E14\u5927\u4E8E 10 MB\u3001\u53EF\u4EE5\u771F\u5220\u7684\uFF08\u8981\u7528\u6237\u70B9\u5934\uFF09",
    options: {
      node: { type: "string" },
      archived: { type: "boolean", default: false },
      stale: { type: "boolean" },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      if (values.stale === true) return stale(values, json);
      const query = new URLSearchParams();
      for (const key of ["node", "before", "limit"])
        if (str(values, key) !== void 0) query.set(key, str(values, key));
      if (values.archived === true) query.set("archived", "1");
      const page = await (await client13()).get(
        `/materials${query.size ? `?${query}` : ""}`
      );
      if (json) printJson(page);
      else console.log(materialLines(page.materials));
      recordNext(
        page.next_before ? `\u5F80\u4E0B\u770B\uFF1Aatrium material ls${values.archived === true ? " --archived" : ""}${str(values, "node") ? ` --node ${str(values, "node")}` : ""} --before ${page.next_before}` : page.materials[0] ? `\u770B\u4E00\u4EFD\uFF1Aatrium material show ${page.materials[0].ref}` : "\u6302\u4E00\u4EFD\uFF1Aatrium material add \u8282\u70B9 \u6587\u4EF6|\u76EE\u5F55 --note \u4E00\u53E5\u8BDD"
      );
    }
  },
  "material show": {
    args: "mN",
    about: "\u770B\u4E00\u4EFD\u8D44\u6599\uFF1A\u8BF4\u660E\u3001\u72B6\u6001\u3001\u7248\u672C\u3001\u5173\u8054\u3001\u8C01\u8BFB\u8FC7\u3001\u6E05\u7406\u7EBF\u7D22",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const detail4 = await (await client13()).get(`/materials/${encodeURIComponent(reference)}`);
      if (json) printJson(detail4);
      else console.log(detailText2(detail4));
      recordNext(`\u53D6\uFF1Aatrium material get ${detail4.ref}`);
    }
  },
  "material get": {
    args: "mN [--out \u76EE\u5F55] [--version \u7248\u672C]",
    about: "\u53D6\u8D44\u6599\u5230 --out \u76EE\u5F55\uFF08\u7F3A\u7701\u5F53\u524D\u76EE\u5F55\uFF09\u4E0B\uFF0C\u6309\u540D\u79F0\u843D\u6210\u6587\u4EF6\u6216\u76EE\u5F55\uFF0C\u5DF2\u5B58\u5728\u5C31\u62A5\u9519\uFF1B\u7F3A\u7701\u5F53\u524D\u7248\u672C\uFF1B\u6267\u884C\u8005\u5728\u4EFB\u52A1\u91CC\u4E5F\u80FD\u7528\uFF08\u8BFB\u53D6\u8BB0\u5728\u4EFB\u52A1\u4E0A\uFF09",
    options: { out: { type: "string" }, version: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      const { connectForRead } = await import("./chunk-P53PGFEK.js");
      const c = await connectForRead();
      const out3 = resolve10(str(values, "out") ?? ".");
      const body = {};
      if (str(values, "version") !== void 0)
        body.version = str(values, "version");
      const task = process.env.ATRIUM_TASK?.trim();
      if (task) body.task = task;
      const { name } = await c.get(
        `/materials/${encodeURIComponent(reference)}`
      );
      if (existsSync5(join6(out3, name)))
        throw new Problem(
          409,
          `${join6(out3, name)} \u5DF2\u5B58\u5728\uFF1B\u6362\u4E2A\u76EE\u5F55\uFF1Aatrium material get ${reference} --out \u53E6\u4E00\u4E2A\u76EE\u5F55`,
          "conflict"
        );
      const opened = await c.post(`/materials/${encodeURIComponent(reference)}/get`, body);
      if (pathProblem(opened.name) || opened.name.includes("/"))
        throw new Problem(502, `\u670D\u52A1\u8FD4\u56DE\u4E86\u574F\u540D\u79F0\uFF1A${opened.name}`);
      const target2 = join6(out3, opened.name);
      if (existsSync5(target2))
        throw new Problem(
          409,
          `${target2} \u5DF2\u5B58\u5728\uFF1B\u6362\u4E2A\u76EE\u5F55\uFF1Aatrium material get ${opened.ref} --out \u53E6\u4E00\u4E2A\u76EE\u5F55`,
          "conflict"
        );
      for (const file2 of opened.files) {
        const problem = pathProblem(file2.path);
        if (problem) throw new Problem(502, `\u670D\u52A1\u8FD4\u56DE\u4E86\u574F\u8DEF\u5F84\uFF1A${problem}`);
        const dest = opened.kind === "file" ? target2 : join6(target2, ...file2.path.split("/"));
        if (relative(out3, dest).startsWith(".."))
          throw new Problem(502, `\u670D\u52A1\u8FD4\u56DE\u4E86\u8D8A\u754C\u8DEF\u5F84\uFF1A${file2.path}`);
        const query = new URLSearchParams({
          version: String(opened.version),
          path: file2.path
        });
        const got = await c.get(
          `/materials/${encodeURIComponent(opened.ref)}/files?${query}`
        );
        mkdirSync6(dirname3(dest), { recursive: true });
        writeFileSync6(dest, Buffer.from(got.data, "base64"));
      }
      const result = { ...opened, path: target2 };
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u53D6 ${opened.ref} ${opened.name} v${opened.version}\uFF08${opened.files.length} \u4E2A\u6587\u4EF6\uFF0C${sizeText(opened.bytes)}\uFF09\u2192 ${target2}`
        );
    }
  },
  "material archive": {
    args: "mN [--note \u539F\u56E0] [--undo]",
    about: "\u5F52\u6863\u8D44\u6599\uFF1A\u4E0D\u8FDB\u6E05\u5355\u548C\u6D3E\u6D3B\u63D0\u793A\u8BCD\u3001\u6E05\u7406\u7EBF\u7D22\u4E5F\u4E0D\u518D\u63D0\uFF0C\u6587\u4EF6\u7559\u7740\u53EF\u6062\u590D\uFF08\u53EA\u5F52\u6863\u4E0D\u5220\uFF09\uFF1B--undo \u6062\u590D\u5F52\u6863\u7684\uFF0C\u91CD\u65B0\u8FDB\u6E05\u5355\u548C\u6D3E\u6D3B\u63D0\u793A\u8BCD",
    options: { note: { type: "string" }, undo: { type: "boolean" } },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      if (values.undo === true) {
        const m2 = await (await client13()).post(
          `/materials/${encodeURIComponent(reference)}/restore`,
          str(values, "note") === void 0 ? {} : { note: str(values, "note") }
        );
        if (json) printJson(m2);
        else console.log(`\u5DF2\u6062\u590D ${m2.ref} ${m2.name} \u2192 ${m2.node}`);
        recordNext(`\u770B\uFF1Aatrium material show ${m2.ref}`);
        return;
      }
      const m = await (await client13()).post(
        `/materials/${encodeURIComponent(reference)}/archive`,
        str(values, "note") === void 0 ? {} : { note: str(values, "note") }
      );
      if (json) printJson(m);
      else console.log(`\u5DF2\u5F52\u6863 ${m.ref} ${m.name}`);
      recordNext(`\u6062\u590D\uFF1Aatrium material archive ${m.ref} --undo`);
    }
  },
  "material keep": {
    args: "mN --note \u539F\u56E0",
    about: "\u6E05\u7406\u7EBF\u7D22\u8BF4\u7591\u4F3C\u6CA1\u7528\u3001\u4F46\u51B3\u5B9A\u7559\u4E0B\uFF1A\u5199\u4E00\u53E5\u539F\u56E0\uFF0C\u4E4B\u540E\u6E05\u7406\u7EBF\u7D22\u4E0D\u518D\u63D0\u5B83",
    options: { note: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      if (str(values, "note") === void 0)
        throw new Problem(400, "--note: \u7559\u4E0B\u8981\u5199\u4E00\u53E5\u539F\u56E0", "usage");
      const m = await (await client13()).post(`/materials/${encodeURIComponent(reference)}/keep`, {
        note: str(values, "note")
      });
      if (json) printJson(m);
      else console.log(`\u7559\u4E0B ${m.ref} ${m.name}\uFF1A${m.keep_note}`);
      recordNext(`\u770B\u5176\u4F59\u7EBF\u7D22\uFF1Aatrium material ls --stale --node ${m.node}`);
    }
  },
  "material rm": {
    args: "mN",
    about: "\u771F\u5220\u8D44\u6599\uFF08\u5E93\u91CC\u7684\u8BB0\u5F55\u4E0E\u5168\u90E8\u7248\u672C\u7684\u6587\u4EF6\uFF0C\u5220\u4E86\u627E\u4E0D\u56DE\u6765\uFF09\uFF1B\u53EA\u6709\u7528\u6237\u80FD\u5220\uFF0C\u5E73\u65F6\u7528\u4E0D\u4E0A\u5C31 archive",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const m = await (await client13()).delete(`/materials/${encodeURIComponent(reference)}`);
      if (json) printJson(m);
      else console.log(`\u5DF2\u5220\u9664 ${m.ref} ${m.name}\uFF08\u5168\u90E8\u7248\u672C\uFF09`);
    }
  }
};

// cli/secrets.ts
var client14 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var who3 = (by) => by === "secretary" ? "\u79D8\u4E66" : by;
async function readPiped(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > SECRET_VALUE_MAX + 4) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function readHidden(stdin, prompt) {
  return new Promise((resolve11, reject) => {
    let text = "";
    process.stderr.write(prompt);
    const done = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve11(text);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return done();
        if (char === "" || char === "")
          return done(new Problem(400, "\u5DF2\u53D6\u6D88\uFF0C\u6CA1\u6709\u4FDD\u5B58", "usage"));
        if (char === "\x7F" || char === "\b")
          text = Array.from(text).slice(0, -1).join("");
        else text += char;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
async function readSecretInput(name, stdin = process.stdin) {
  const raw = stdin.isTTY ? await readHidden(stdin, `\u8F93\u5165 ${name} \u7684\u503C\uFF08\u4E0D\u56DE\u663E\uFF09\uFF0C\u56DE\u8F66\u7ED3\u675F\uFF1A`) : await readPiped(stdin);
  return secretValue(raw);
}
function secretLines(list3) {
  if (!list3.length) return "\uFF08\u6CA1\u6709\uFF09";
  return table([
    ["\u540D\u79F0", "\u8282\u70B9", "\u8BBE\u4E8E", "\u6700\u8FD1\u4F7F\u7528", "\u7EBF\u7D22"],
    ...list3.map((s) => [
      s.name,
      s.node,
      `${when(s.updated_at)} ${who3(s.updated_by)}`,
      s.last_used_at ? `${when(s.last_used_at)}${s.last_used_task ? ` ${s.last_used_task}` : ""}` : "\u6CA1\u7528\u8FC7",
      s.archived ? `\u5DF2\u5F52\u6863${s.archive_note ? `\uFF1A${oneLine(s.archive_note, 30)}` : ""}` : s.keep_at ? `\u7559\u4E0B\uFF1A${oneLine(s.keep_note ?? "", 30)}` : s.stale ?? ""
    ])
  ]);
}
var target = (node, name) => ({ node, name });
var secretCommands = {
  "secret set": {
    args: "\u8282\u70B9 \u540D\u79F0",
    about: "\u8BBE\u51ED\u636E\uFF08\u4EE4\u724C\u3001\u5BC6\u7801\uFF09\uFF1A\u503C\u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\uFF08\u7EC8\u7AEF\u91CC\u4E0D\u56DE\u663E\uFF1B\u4E5F\u53EF < \u6587\u4EF6 \u6216\u7BA1\u9053\uFF09\uFF0C\u540D\u79F0\u5C31\u662F\u6CE8\u5165\u6267\u884C\u8005\u7684\u73AF\u5883\u53D8\u91CF\u540D\uFF08\u5982 TELEGRAM_BOT_TOKEN\uFF09\uFF1B\u540C\u4E00\u8282\u70B9\u540C\u540D\u7684\u8986\u76D6\uFF0C\u5DF2\u5F52\u6863\u7684\u987A\u5E26\u6062\u590D\uFF1B\u53EA\u5B58\u4E0D\u663E\u793A",
    positionals: [2, 2],
    async run({ positionals: [node, name], json }) {
      const value = await readSecretInput(name);
      const s = await (await client14()).put("/secrets", {
        node,
        name,
        value
      });
      if (json) printJson(s);
      else
        console.log(
          `${s.created ? "\u5DF2\u5B58" : s.restored ? "\u5DF2\u6062\u590D\u5E76\u66F4\u65B0" : "\u5DF2\u66F4\u65B0"} ${s.name}\uFF08\u6302\u5728 ${s.node}${s.node_name ? ` ${s.node_name}` : ""}\uFF09\uFF1B\u503C\u53EA\u5B58\u4E0D\u663E\u793A`
        );
      recordNext(
        `\u6D3E\u6D3B\u65F6\u7528\uFF1Aatrium task add \u6807\u9898 --part ${s.node} --secret ${s.name}\uFF08\u5DF2\u6709\u4EFB\u52A1\uFF1Aatrium task set tN --secret ${s.name}\uFF09`
      );
    }
  },
  "secret ls": {
    args: "[--node \u8282\u70B9] [--archived] [--before \u53F7] [--limit \u6761\u6570]",
    about: "\u5217\u51ED\u636E\uFF08\u65B0\u8BBE\u7684\u5728\u524D\uFF09\uFF1A\u540D\u79F0\u3001\u8282\u70B9\u3001\u8BBE\u4E8E\u3001\u6700\u8FD1\u4F7F\u7528\uFF08\u65F6\u95F4\u4E0E\u4EFB\u52A1\uFF09\u3001\u6E05\u7406\u7EBF\u7D22\uFF1B\u4E0D\u663E\u793A\u503C\uFF1B\u7F3A\u7701\u4E0D\u542B\u5F52\u6863\u7684\uFF0C--archived \u53EA\u5217\u5F52\u6863\u7684",
    options: {
      node: { type: "string" },
      archived: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      for (const key of ["node", "before", "limit"])
        if (str(values, key) !== void 0) query.set(key, str(values, key));
      if (values.archived === true) query.set("archived", "1");
      const page = await (await client14()).get(
        `/secrets${query.size ? `?${query}` : ""}`
      );
      if (json) printJson(page);
      else console.log(secretLines(page.secrets));
      const stale2 = page.secrets.find((s) => s.stale && !s.archived);
      recordNext(
        page.next_before ? `\u5F80\u4E0B\u770B\uFF1Aatrium secret ls${values.archived === true ? " --archived" : ""}${str(values, "node") ? ` --node ${str(values, "node")}` : ""} --before ${page.next_before}` : stale2 ? `\u7528\u4E0D\u4E0A\u5C31\u5F52\u6863\uFF1Aatrium secret archive ${stale2.node} ${stale2.name} --note \u539F\u56E0\uFF1B\u8981\u7559\uFF1Aatrium secret keep ${stale2.node} ${stale2.name} --note \u539F\u56E0` : "\u8BBE\u4E00\u4E2A\uFF1Aatrium secret set \u8282\u70B9 \u540D\u79F0\uFF08\u503C\u4ECE\u6807\u51C6\u8F93\u5165\u7ED9\uFF09"
      );
    }
  },
  "secret archive": {
    args: "\u8282\u70B9 \u540D\u79F0 [--note \u539F\u56E0] [--undo]",
    about: "\u5F52\u6863\u51ED\u636E\uFF1A\u6D3E\u6D3B\u4E0D\u518D\u6CE8\u5165\uFF08\u58F0\u660E\u4E86\u5B83\u7684\u4EFB\u52A1\u6D3E\u4E0D\u51FA\u53BB\uFF09\u3001\u6E05\u7406\u7EBF\u7D22\u4E5F\u4E0D\u518D\u63D0\uFF0C\u503C\u7559\u7740\u53EF\u6062\u590D\uFF08\u53EA\u5F52\u6863\u4E0D\u5220\uFF09\uFF1B--undo \u6062\u590D\u5F52\u6863\u7684\uFF0C\u6D3E\u6D3B\u65F6\u91CD\u65B0\u6CE8\u5165",
    options: { note: { type: "string" }, undo: { type: "boolean" } },
    positionals: [2, 2],
    async run({ positionals: [node, name], values, json }) {
      const undo = values.undo === true;
      const s = await (await client14()).post(undo ? "/secrets/restore" : "/secrets/archive", {
        ...target(node, name),
        ...str(values, "note") === void 0 ? {} : { note: str(values, "note") }
      });
      if (json) printJson(s);
      else console.log(`\u5DF2${undo ? "\u6062\u590D" : "\u5F52\u6863"} ${s.node} \u7684 ${s.name}`);
      recordNext(
        undo ? `\u770B\uFF1Aatrium secret ls --node ${s.node}` : `\u6062\u590D\uFF1Aatrium secret archive ${s.node} ${s.name} --undo`
      );
    }
  },
  "secret keep": {
    args: "\u8282\u70B9 \u540D\u79F0 --note \u539F\u56E0",
    about: "\u6E05\u7406\u7EBF\u7D22\u8BF4\u7591\u4F3C\u6CA1\u7528\uFF0890 \u5929\u6CA1\u7528\u8FC7\uFF09\u3001\u4F46\u51B3\u5B9A\u7559\u4E0B\uFF1A\u5199\u4E00\u53E5\u539F\u56E0\uFF0C\u4E4B\u540E\u6E05\u7406\u7EBF\u7D22\u4E0D\u518D\u63D0\u5B83",
    options: { note: { type: "string" } },
    positionals: [2, 2],
    async run({ positionals: [node, name], values, json }) {
      if (str(values, "note") === void 0)
        throw new Problem(400, "--note: \u7559\u4E0B\u8981\u5199\u4E00\u53E5\u539F\u56E0", "usage");
      const s = await (await client14()).post("/secrets/keep", {
        ...target(node, name),
        note: str(values, "note")
      });
      if (json) printJson(s);
      else console.log(`\u7559\u4E0B ${s.node} \u7684 ${s.name}\uFF1A${s.keep_note}`);
      recordNext(`\u770B\u5176\u4F59\u7684\uFF1Aatrium secret ls --node ${s.node}`);
    }
  },
  "secret rm": {
    args: "\u8282\u70B9 \u540D\u79F0",
    about: "\u771F\u5220\u51ED\u636E\uFF08\u8BB0\u5F55\u4E0E\u503C\u4E00\u8D77\u5220\uFF0C\u627E\u4E0D\u56DE\u6765\uFF09\uFF1B\u53EA\u6709\u7528\u6237\u80FD\u5220\uFF0C\u5E73\u65F6\u7528\u4E0D\u4E0A\u5C31 archive",
    positionals: [2, 2],
    async run({ positionals: [node, name], json }) {
      const s = await (await client14()).delete("/secrets", target(node, name));
      if (json) printJson(s);
      else console.log(`\u5DF2\u5220\u9664 ${s.node} \u7684 ${s.name}`);
    }
  }
};

// cli/choices.ts
import { readFileSync as readFileSync11 } from "node:fs";
var client15 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var enc4 = encodeURIComponent;
var who4 = (by) => by === "secretary" ? "\u79D8\u4E66" : by;
function optionText(choice, o) {
  const star = choice.recommend.includes(o.seq) ? "\uFF08\u63A8\u8350\uFF09" : "";
  const fate = o.picked === true ? ` \u2192 \u5DF2\u9009\uFF0C\u5EFA\u4E86 ${o.task}` : o.picked === false ? ` \u2192 \u6CA1\u9009\uFF0C\u8BB0\u4E3A ${o.decision}` : "";
  return [
    `${o.seq}. ${o.title}${star}${fate}`,
    `   \u80FD\u591A\u505A\u5230\uFF1A${o.gain}`,
    `   \u4E3A\u4EC0\u4E48\u73B0\u5728\uFF1A${o.why_now}`,
    `   \u4EE3\u4EF7\uFF1A${o.cost}`,
    `   \u4E0D\u505A\u4F1A\u600E\u6837\uFF1A${o.skip}`,
    ...o.basis.length ? [`   \u4F9D\u636E\uFF1A${o.basis.join("\uFF1B")}`] : []
  ].join("\n");
}
var deciderName = (by) => by === "u1" || by === null ? "\u7528\u6237" : by;
function choiceText(choice) {
  const decided = choice.decided_at ? `\uFF1B${deciderName(choice.decided_by)}\u62CD\u677F\u4E8E ${when(choice.decided_at)}` : "";
  return [
    `${choice.ref} ${choice.title} \xB7 ${choice.status_text} \xB7 ${choice.node_alias || choice.node_name}\uFF08${choice.node}\uFF09`,
    `${who4(choice.created_by)}\u63D0\u4E8E ${when(choice.created_at)}${choice.task ? `\uFF0C\u51FA\u81EA ${choice.task}` : ""}${decided}`,
    ...choice.note ? [`${deciderName(choice.decided_by)}\u8BF4\u660E\uFF1A${choice.note}`] : [],
    "",
    ...choice.options.map((o) => optionText(choice, o)),
    "",
    `\u63A8\u8350\uFF1A\u9009\u9879 ${choice.recommend.join("\u3001")}\u2014\u2014${choice.why}`,
    ...choice.small ? [choice.small.text] : [],
    ...choice.comments.length ? ["", "\u610F\u89C1\uFF1A", ...choice.comments.map((c) => `- ${commentLine(c)}`)] : []
  ].join("\n");
}
var line2 = (c) => `${c.ref} ${oneLine(c.title, 40)} \xB7 ${c.status_text} \xB7 ${c.node_alias || c.node_name}\uFF08${c.node}\uFF09\xB7 ${c.options.length} \u4E2A\u9009\u9879${c.status === "picked" ? `\uFF0C\u9009\u4E86 ${c.options.filter((o) => o.picked).map((o) => o.seq).join("\u3001")}` : ""}`;
function readChoiceFile(file2) {
  if (file2 === "-" && process.stdin.isTTY)
    throw new Problem(
      400,
      "--file - \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u9009\u9879\u5355\uFF0C\u9700\u8981\u7528\u7BA1\u9053\u6216\u91CD\u5B9A\u5411\u4F20\u5165\uFF0C\u5982 atrium choice add o2 --file - < \u9009\u9879\u5355.json",
      "usage"
    );
  let raw;
  try {
    raw = readFileSync11(file2 === "-" ? 0 : file2, "utf8");
  } catch {
    throw new Problem(
      400,
      `--file: \u8BFB\u4E0D\u5230 ${file2 === "-" ? "\u6807\u51C6\u8F93\u5165" : file2}`,
      "usage"
    );
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Problem(
      400,
      '--file: \u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF1B\u683C\u5F0F\u89C1 atrium choice add --help\uFF08{"title","options":[\u2026],"recommend":[1],"why"}\uFF09',
      "usage"
    );
  }
}
var choiceCommands = {
  "choice ls": {
    args: "[--node \u8282\u70B9] [--open] [--before cN] [--limit \u4EFD\u6570]",
    about: "\u5217\u9009\u9879\u5355\uFF0C\u7B49\u62CD\u677F\u7684\u5728\u524D\u3001\u65B0\u7684\u5728\u524D\uFF1B--node \u53EA\u770B\u8FD9\u4E00\u5757\u53CA\u4E0B\u5C42\uFF0C--open \u53EA\u770B\u7B49\u62CD\u677F\u7684",
    options: {
      node: { type: "string" },
      open: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      if (str(values, "node")) query.set("node", str(values, "node"));
      if (values.open === true) query.set("open", "1");
      for (const key of ["before", "limit"])
        if (str(values, key) !== void 0) query.set(key, str(values, key));
      const page = await (await client15()).get(`/choices${query.size ? `?${query}` : ""}`);
      if (json) printJson(page);
      else
        console.log(
          page.choices.length ? [
            `\u7B49\u4F60\u62CD\u677F ${page.open} \u4EFD`,
            ...page.choices.map((c) => `- ${line2(c)}`)
          ].join("\n") : values.open === true ? "\u6CA1\u6709\u7B49\u4F60\u62CD\u677F\u7684\u9009\u9879\u5355" : "\u8FD8\u6CA1\u6709\u9009\u9879\u5355"
        );
      const first = page.choices.find((c) => c.status === "open");
      recordNext(
        page.next_before ? `\u5F80\u4E0B\u770B\uFF1Aatrium choice ls${values.open === true ? " --open" : ""}${str(values, "node") ? ` --node ${str(values, "node")}` : ""} --before ${page.next_before}` : first ? `\u770B\u5168\u6587\u518D\u62CD\u677F\uFF1Aatrium choice show ${first.ref}` : "\u770B\u5168\u666F\uFF1Aatrium map"
      );
    }
  },
  "choice show": {
    args: "cN",
    about: "\u770B\u4E00\u4EFD\u9009\u9879\u5355\u5168\u6587\uFF1A\u6BCF\u4E2A\u9009\u9879\u80FD\u591A\u505A\u5230\u4EC0\u4E48\u3001\u4E3A\u4EC0\u4E48\u73B0\u5728\u3001\u4EE3\u4EF7\u3001\u4E0D\u505A\u4F1A\u600E\u6837\u3001\u4F9D\u636E\uFF0C\u63A8\u8350\u4E0E\u7406\u7531\uFF0C\u62CD\u8FC7\u677F\u7684\u5199\u660E\u5EFA\u4E86\u54EA\u4E9B\u4EFB\u52A1\u3001\u8BB0\u4E86\u54EA\u4E9B\u51B3\u5B9A",
    positionals: [1, 1],
    async run({ positionals: [ref3], json }) {
      const choice = await (await client15()).get(`/choices/${enc4(ref3)}`);
      if (json) printJson(choice);
      else console.log(choiceText(choice));
      recordNext(
        choice.status !== "open" ? `\u770B\u8282\u70B9\uFF1Aatrium map ${choice.node}` : process.env.ATRIUM_LEADER_TOKEN ? `\u5199\u610F\u89C1\uFF1Aatrium choice comment ${choice.ref} \u610F\u89C1 --prefer ${choice.recommend.join(",")} --basis \u4F9D\u636E` : `\u62CD\u677F\uFF1Aatrium choice pick ${choice.ref} ${choice.recommend.join(" ")} --note \u8BF4\u660E\uFF08\u8FD9\u8F6E\u90FD\u4E0D\u8981\uFF1Aatrium choice pass ${choice.ref} --note \u539F\u56E0\uFF09`
      );
    }
  },
  "choice pick": {
    args: "cN \u9009\u9879\u53F7\u2026 [--note \u8BF4\u660E]",
    about: "\u62CD\u677F\u8981\u505A\u54EA\u51E0\u4E2A\uFF1A\u9009\u4E2D\u7684\u5728\u8BE5\u8282\u70B9\u4E0B\u5404\u5EFA\u4E00\u4E2A\u4EFB\u52A1\uFF08\u5E26\u9009\u9879\u5168\u6587\u4F5C\u8BE6\u8FF0\uFF0C\u4EA4\u8BE5\u8282\u70B9 leader \u62C6\u89E3\uFF09\uFF0C\u6CA1\u9009\u7684\u8FDE\u540C\u8BF4\u660E\u8BB0\u6210\u8BE5\u8282\u70B9\u7684\u51B3\u5B9A\u8BB0\u5F55\uFF08\u8FD9\u8F6E\u4E0D\u505A X\uFF1A\u539F\u56E0\uFF09\uFF1B\u53EA\u6709\u7528\u6237\u80FD\u62CD\u677F",
    options: { note: { type: "string" } },
    positionals: [2, 6],
    async run({ positionals: [ref3, ...picks], values, json }) {
      const result = await (await client15()).post(`/choices/${enc4(ref3)}/pick`, {
        picks,
        ...str(values, "note") !== void 0 ? { note: str(values, "note") } : {}
      });
      if (json) printJson(result);
      else
        console.log(
          [
            `${result.choice.ref} \u5DF2\u62CD\u677F`,
            ...result.tasks.map(
              (t) => `- \u9009\u9879 ${t.option}\u300C${t.title}\u300D\u2192 \u5EFA\u4E86 ${t.ref}`
            ),
            ...result.decisions.map(
              (d) => `- \u9009\u9879 ${d.option} \u6CA1\u9009 \u2192 \u8BB0\u4E3A\u51B3\u5B9A ${d.ref}`
            )
          ].join("\n")
        );
      recordNext(
        result.tasks[0] ? `\u770B\u4EFB\u52A1\uFF1Aatrium task show ${result.tasks[0].ref}` : `\u770B\u9009\u9879\u5355\uFF1Aatrium choice show ${result.choice.ref}`
      );
    }
  },
  "choice pass": {
    args: "cN [--note \u539F\u56E0]",
    about: "\u8FD9\u8F6E\u90FD\u4E0D\u8981\uFF1A\u6BCF\u4E2A\u9009\u9879\u8FDE\u540C\u539F\u56E0\u8BB0\u6210\u8BE5\u8282\u70B9\u7684\u51B3\u5B9A\u8BB0\u5F55\uFF0C\u4E0B\u4E00\u8F6E\u8C03\u7814\u60C5\u51B5\u6CA1\u53D8\u4E0D\u91CD\u590D\u63D0",
    options: { note: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [ref3], values, json }) {
      const result = await (await client15()).post(`/choices/${enc4(ref3)}/pass`, {
        ...str(values, "note") !== void 0 ? { note: str(values, "note") } : {}
      });
      if (json) printJson(result);
      else
        console.log(
          `${result.choice.ref} \u8FD9\u8F6E\u90FD\u4E0D\u8981\uFF0C\u8BB0\u4E86\u51B3\u5B9A ${result.decisions.map((d) => d.ref).join("\u3001")}`
        );
      recordNext(`\u770B\u51B3\u5B9A\u8BB0\u5F55\uFF1Aatrium decision ls --node ${result.choice.node}`);
    }
  },
  "choice comment": {
    args: "cN \u610F\u89C1 [--prefer \u9009\u9879\u53F7[,\u9009\u9879\u53F7]] [--basis \u4F9D\u636E]\u2026",
    about: "\u7ED9\u7B49\u62CD\u677F\u7684\u9009\u9879\u5355\u5199\u610F\u89C1\uFF08\u9879\u76EE leader\u3001\u79D8\u4E66\uFF09\uFF1A\u53EF\u6807\u503E\u5411\u54EA\u51E0\u4E2A\u3001\u8865\u4F9D\u636E\uFF08fN\u3001tN\u3001dN\u3001\u94FE\u63A5\uFF0C\u53EF\u5199\u591A\u6B21\uFF09\uFF1B\u62CD\u677F\u4EBA\u770B\u9009\u9879\u5355\u65F6\u4E00\u8D77\u770B\u5230\uFF0C\u9009\u4E2D\u7684\u4EFB\u52A1\u8BE6\u8FF0\u4E5F\u5E26\u4E0A",
    options: {
      prefer: { type: "string" },
      basis: { type: "string", multiple: true }
    },
    positionals: [2, 2],
    async run({ positionals: [ref3, text], values, json }) {
      const basis = Array.isArray(values.basis) ? values.basis.filter((v) => typeof v === "string") : [];
      const choice = await (await client15()).post(`/choices/${enc4(ref3)}/comment`, {
        text,
        ...str(values, "prefer") ? { prefer: [str(values, "prefer")] } : {},
        ...basis.length ? { basis } : {}
      });
      if (json) printJson(choice);
      else
        console.log(
          `\u5DF2\u7ED9 ${choice.ref} \u5199\u610F\u89C1\uFF08\u5171 ${choice.comments.length} \u6761\uFF09\uFF0C\u7B49\u7528\u6237\u62CD\u677F`
        );
      recordNext(`\u770B\u5168\u6587\uFF1Aatrium choice show ${choice.ref}`);
    }
  },
  "choice add": {
    args: "\u8282\u70B9 --file \u9009\u9879\u5355.json|- [--task tN]",
    about: '\u63D0\u4E00\u4EFD\u9009\u9879\u5355\u6302\u5728\u8282\u70B9\u4E0A\uFF08\u5B83\u8981\u6F14\u8FDB\u7684\u90A3\u4E00\u5757\uFF09\uFF0C\u5EFA\u597D\u53EB\u9192\u79D8\u4E66\u9012\u7ED9\u7528\u6237\uFF1B\u6587\u4EF6\u662F JSON\uFF1A{"title":"\u6807\u9898","options":[{"title","gain":"\u80FD\u591A\u505A\u5230\u4EC0\u4E48","why_now":"\u4E3A\u4EC0\u4E48\u73B0\u5728","cost":"\u4EE3\u4EF7\uFF1A\u591A\u5C11\u6D3B\u3001\u5360\u54EA\u4E9B\u989D\u5EA6","skip":"\u4E0D\u505A\u4F1A\u600E\u6837","basis":["f3","t120","d4","\u94FE\u63A5"]}\u20263\u20135 \u4E2A],"recommend":[\u9009\u9879\u53F7],"why":"\u63A8\u8350\u7406\u7531","small":[{"title":"\u5C0F\u6539\u8FDB","why":"\u4E3A\u4EC0\u4E48","basis":["f5"]}\u2026\u53EF\u4E0D\u5199\uFF0C\u81F3\u591A 10 \u6761]}\uFF1B\u9009\u9879\u53EA\u653E\u5927\u65B9\u5411\uFF0Csmall \u662F\u4E00\u5929\u5185\u80FD\u505A\u5B8C\u3001\u4E0D\u6539\u7528\u6CD5\u7684\u5C0F\u6539\u8FDB\uFF0C\u4E0D\u8FDB\u9009\u9879\u5355\uFF0C\u4EA4\u8BE5\u8282\u70B9\u6700\u8FD1\u7684 leader \u81EA\u5DF1\u5B9A\uFF08\u6536 choice_small\uFF09\uFF1B--task \u8BB0\u4EA7\u51FA\u5B83\u7684\u7814\u7A76\u4EFB\u52A1',
    options: { file: { type: "string" }, task: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const file2 = str(values, "file");
      if (!file2)
        throw new Problem(
          400,
          "--file: \u9009\u9879\u5355\u6587\u4EF6\u5FC5\u586B\uFF08JSON\uFF0C- \u4E3A\u6807\u51C6\u8F93\u5165\uFF09",
          "usage"
        );
      const choice = await (await client15()).post("/choices", {
        node,
        choice: readChoiceFile(file2),
        ...str(values, "task") ? { task: str(values, "task") } : {}
      });
      if (json) printJson(choice);
      else
        console.log(
          `\u5DF2\u63D0 ${choice.ref}\u300C${choice.title}\u300D\uFF08${choice.node_alias || choice.node_name}\uFF0C${choice.options.length} \u4E2A\u9009\u9879\uFF09\uFF0C\u5DF2\u901A\u77E5\u79D8\u4E66`
        );
      recordNext(`\u770B\u5168\u6587\uFF1Aatrium choice show ${choice.ref}`);
    }
  }
};

// cli/hosts.ts
var client16 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var enc5 = encodeURIComponent;
var asQuery2 = () => {
  const who5 = defaultActor();
  return who5 ? `?as=${enc5(who5)}` : "";
};
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
    [
      "\u77ED\u53F7",
      "\u540D\u79F0",
      "\u72B6\u6001",
      "\u96A7\u9053",
      "\u673A\u5668",
      "\u7F16\u7801 CLI",
      "\u5728\u8DD1",
      "\u81EA\u52A8\u6D3E\u54EA\u4E9B\u4ED3\u5E93"
    ],
    ...hosts.map((view) => [
      view.ref,
      view.name,
      view.status,
      view.ssh ? oneLine(
        `${view.ssh.status}${view.ssh.error ? ` \xB7 ${view.ssh.error}` : ""}`,
        60
      ) : "\u2014",
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
    ...view.ssh ? [
      `SSH\uFF1A${view.ssh.target}${view.ssh.key ? ` \xB7 \u79C1\u94A5\u8DEF\u5F84 ${view.ssh.key}` : ""}`,
      `\u96A7\u9053\uFF1A\u672C\u673A:\u8FDC\u7AEF ${view.ssh.tunnel} \xB7 ${view.ssh.status}`,
      `\u4EE3\u7406\u670D\u52A1\u5730\u5740\uFF1A${view.ssh.agentServer}`,
      ...view.ssh.error ? [`\u96A7\u9053\u6700\u8FD1\u9519\u8BEF\uFF1A${view.ssh.error}`] : []
    ] : [],
    ...view.checks ? [`\u628A\u5173\u68C0\u67E5\uFF1A${view.checks}`] : [],
    ...view.last_seen_at ? [`\u6700\u8FD1\u5FC3\u8DF3\uFF1A${when(view.last_seen_at)}`] : [],
    ...view.tasks?.length ? [
      "\u5728\u8DD1\u7684\u4EFB\u52A1\uFF1A",
      ...view.tasks.map((task) => `  ${task.ref} ${task.title}`)
    ] : []
  ].join("\n");
}
var serviceAddress = async () => {
  const { servicePort } = await import("./chunk-MDR2YA57.js");
  return `http://127.0.0.1:${servicePort()}`;
};
var hostCommands = {
  "host ls": {
    args: "[--all]",
    about: "\u5217\u51FA\u6267\u884C\u673A\u5668\uFF1A\u672C\u673A h1 \u4E0E\u63A5\u5165\u7684\u8FDC\u7A0B\u4E3B\u673A\uFF0C\u72B6\u6001\u3001\u7F16\u7801 CLI\u3001\u5728\u8DD1\u51E0\u4EF6\u3001\u81EA\u52A8\u6D3E\u54EA\u4E9B\u4ED3\u5E93\uFF1B--all \u8FDE\u5DF2\u79FB\u9664\u7684",
    options: { all: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (await client16()).get(
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
    about: "\u770B\u4E00\u53F0\u6267\u884C\u673A\u5668\uFF1A\u7CFB\u7EDF\u3001\u7F16\u7801 CLI\u3001\u8D1F\u8F7D\u3001\u8DD1\u4E0D\u8DD1\u628A\u5173\u68C0\u67E5\u3001\u6700\u8FD1\u5FC3\u8DF3\u3001\u5728\u8DD1\u7684\u4EFB\u52A1",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const view = await (await client16()).get(`/hosts/${enc5(hostRef(reference))}`);
      if (json) printJson(view);
      else console.log(detail3(view));
      recordNext(`\u6D3E\u6D3B\u5230\u8FD9\u53F0\uFF1Aatrium task run tN --host ${view.ref}`);
    }
  },
  "host add": {
    args: "\u540D\u79F0 [--repo owner/name|*]\u2026 [--max \u6570\u91CF] [--ssh user@\u5730\u5740] [--key \u79C1\u94A5\u8DEF\u5F84] [--tunnel \u672C\u673A\u7AEF\u53E3:\u8FDC\u7AEF\u7AEF\u53E3]",
    about: "\u767B\u8BB0\u4E00\u53F0\u8FDC\u7A0B\u6267\u884C\u673A\u5668\uFF0C\u7ED9\u51FA\u4E00\u6B21\u6027\u63A5\u5165\u7801\uFF0830 \u5206\u949F\u5185\u6709\u6548\uFF09\u4E0E\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u8981\u8FD0\u884C\u7684 atrium agent \u547D\u4EE4\uFF1B--repo \u767B\u8BB0\u81EA\u52A8\u6D3E\u6D3B\u65F6\u80FD\u63A5\u7684\u4ED3\u5E93\uFF08* \u5168\u90E8\uFF1B\u4E0D\u5199\u53EA\u81EA\u52A8\u63A5\u6CA1\u6709\u4ED3\u5E93\u7684\u6D3B\uFF0C--host \u6307\u5B9A\u65F6\u4E0D\u53D7\u9650\uFF09\uFF0C--max \u540C\u65F6\u6700\u591A\u8DD1\u51E0\u4EF6\uFF08\u7F3A\u7701\u6309\u90A3\u53F0\u7684\u6838\u6570\uFF09",
    options: {
      repo: { type: "string", multiple: true },
      max: { type: "string" },
      ssh: { type: "string" },
      key: { type: "string" },
      tunnel: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      const maxText = str(values, "max");
      if (maxText !== void 0 && !/^[1-9][0-9]?$/.test(maxText))
        throw new Problem(
          400,
          `--max \u5E94\u4E3A 1 \u5230 64 \u7684\u6574\u6570\uFF08\u6536\u5230\uFF1A${maxText}\uFF09`,
          "usage"
        );
      const result = await (await client16()).post("/hosts", {
        name,
        repos: strs(values, "repo"),
        ...maxText !== void 0 ? { max: Number(maxText) } : {},
        ...str(values, "ssh") !== void 0 ? { ssh: str(values, "ssh") } : {},
        ...str(values, "key") !== void 0 ? { key: str(values, "key") } : {},
        ...str(values, "tunnel") !== void 0 ? { tunnel: str(values, "tunnel") } : {}
      });
      const address = result.host.ssh?.agentServer ?? await serviceAddress();
      const command = `atrium agent install --server ${address} --token ${result.code}`;
      if (json) printJson({ ...result, command });
      else
        console.log(
          [
            `\u5DF2\u767B\u8BB0 ${result.host.ref} ${result.host.name}\uFF08\u5F85\u63A5\u5165\uFF1B\u63A5\u5165\u7801 30 \u5206\u949F\u5185\u6709\u6548\uFF0C\u53EA\u80FD\u7528\u4E00\u6B21\uFF09`,
            "\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u88C5\u597D Node 24+ \u4E0E Atrium \u540E\u8FD0\u884C\uFF08\u63A5\u5165\u5E76\u88C5\u6210\u7CFB\u7EDF\u670D\u52A1\uFF0C\u5F00\u673A\u6216\u767B\u5F55\u81EA\u542F\u3001\u5173\u7EC8\u7AEF\u4E0D\u65AD\uFF09\uFF1A",
            `  ${command}`,
            "\u53EA\u60F3\u5728\u7EC8\u7AEF\u524D\u53F0\u8DD1\uFF1A\u628A agent install \u6362\u6210 agent",
            ...result.host.ssh ? [
              `Atrium \u6B63\u5728\u7BA1\u7406 ${result.host.ssh.target} \u7684 SSH \u96A7\u9053\uFF1B\u72B6\u6001\u7528 atrium host show ${result.host.ref} \u67E5\u770B`
            ] : [
              `\u670D\u52A1\u5730\u5740\u8981\u6362\u6210\u90A3\u53F0\u673A\u5668\u8FDE\u5F97\u5230\u7684\uFF1A\u672C\u673A\u670D\u52A1\u53EA\u542C ${address}\uFF0C\u8DE8\u673A\u5668\u7ECF SSH \u8F6C\u53D1\uFF08ssh -R\uFF09\u3001\u5185\u7F51\u7A7F\u900F\u6216 VPN \u8FDE\u8FC7\u6765\uFF1BOrbStack \u865A\u62DF\u673A\u91CC\u7528 http://host.orb.internal:${new URL(address).port}`
            ]
          ].join("\n")
        );
      recordNext(`\u63A5\u5165\u540E\u67E5\u770B\uFF1Aatrium host show ${result.host.ref}`);
    }
  },
  "host edit": {
    args: "hN [--ssh user@\u5730\u5740] [--key \u79C1\u94A5\u8DEF\u5F84] [--tunnel \u672C\u673A\u7AEF\u53E3:\u8FDC\u7AEF\u7AEF\u53E3]",
    about: "\u66F4\u65B0\u8FDC\u7A0B\u4E3B\u673A\u7684 SSH \u8FDE\u63A5\u548C Atrium \u81EA\u7BA1\u96A7\u9053\uFF1B\u672A\u5199\u7684\u5B57\u6BB5\u6CBF\u7528\u539F\u503C",
    options: {
      ssh: { type: "string" },
      key: { type: "string" },
      tunnel: { type: "string" }
    },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      const body = Object.fromEntries(
        ["ssh", "key", "tunnel"].flatMap((key) => {
          const value = str(values, key);
          return value === void 0 ? [] : [[key, value]];
        })
      );
      if (!Object.keys(body).length)
        throw new Problem(400, "\u8BF7\u7ED9\u51FA --ssh\u3001--key \u6216 --tunnel", "usage");
      const result = await (await client16()).patch(`/hosts/${enc5(hostRef(reference))}`, body);
      if (json) printJson(result);
      else console.log(detail3(result.host));
      recordNext(`\u67E5\u770B\u8FDE\u63A5\u72B6\u6001\uFF1Aatrium host show ${result.host.ref}`);
    }
  },
  "host remove": {
    args: "hN",
    about: "\u79FB\u9664\u8FDC\u7A0B\u6267\u884C\u673A\u5668\uFF1A\u4EE4\u724C\u4F5C\u5E9F\uFF0C\u77ED\u53F7\u4FDD\u7559\u4E0D\u590D\u7528\uFF1B\u4E0A\u9762\u8FD8\u6709\u5728\u8DD1\u7684\u4EFB\u52A1\u65F6\u62D2\u7EDD",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (await client16()).delete(`/hosts/${enc5(hostRef(reference))}`);
      if (json) printJson(result);
      else
        console.log(
          `\u5DF2\u79FB\u9664 ${result.host.ref} ${result.host.name}\uFF1B\u90A3\u53F0\u673A\u5668\u4E0A\u7684 atrium agent \u4F1A\u56E0\u4EE4\u724C\u5931\u6548\u9000\u51FA`
        );
      recordNext("\u770B\u5269\u4E0B\u7684\uFF1Aatrium host ls");
    }
  },
  "host clean": {
    args: "hN",
    about: "\u6E05\u7406\u8FD9\u53F0\u4E0A Atrium \u62C9\u8D77\u7684\u6267\u884C\u8005\uFF1A\u505C\u6389\u5728\u90A3\u53F0\u8DD1\u7684\uFF0C\u518D\u7ED3\u675F\u6700\u8FD1\u4E00\u5929\u5DF2\u7ED3\u675F\u4EFB\u52A1\u4ECD\u6D3B\u7740\u7684\u6267\u884C\u8005\u8FDB\u7A0B\u6811\uFF08\u8FDC\u7A0B\u7531\u90A3\u53F0\u7684\u4EE3\u7406\u6838\u5BF9\u5E76\u7ED3\u675F\uFF1B\u6309\u547D\u4EE4\u884C\u4E0E\u542F\u52A8\u65F6\u523B\u6838\u5BF9\uFF0C\u4E0D\u78B0\u4F60\u81EA\u5DF1\u5F00\u7684\u8FDB\u7A0B\uFF09\uFF0C\u9010\u6761\u5217\u51FA\u5E76\u8BB0\u8FDB\u4EFB\u52A1\u4E8B\u4EF6\uFF1B\u5E38\u548C pause --host \u4E00\u8D77\u7528",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const result = await (await client16()).post(`/hosts/${enc5(hostRef(reference))}/clean${asQuery2()}`, {});
      if (json) printJson(result);
      else {
        const lines = [
          `${result.host.ref} \u505C\u6389 ${result.stopped.length} \u4E2A\u5728\u8DD1\u7684\u6267\u884C\u8005${result.stopped.length ? `\uFF1A${result.stopped.join("\u3001")}` : ""}`
        ];
        if (result.unreached) lines.push(`\u6B8B\u7559\u8FDB\u7A0B\u6CA1\u6E05\uFF1A${result.unreached}`);
        else {
          lines.push(`\u7ED3\u675F ${result.killed.length} \u4E2A\u6B8B\u7559\u8FDB\u7A0B\u6811`);
          for (const kill of result.killed)
            lines.push(`  ${kill.task}  pid ${kill.pid}  ${kill.tool}`);
        }
        console.log(lines.join("\n"));
      }
      recordNext(
        result.unreached ? `\u4EE3\u7406\u8FDE\u4E0A\u540E\u518D\u6E05\uFF1Aatrium host clean ${result.host.ref}` : result.killed.length ? `\u770B\u4EFB\u52A1\u4E8B\u4EF6\uFF1Aatrium task show ${result.killed[0].task}` : `\u770B\u8FD9\u53F0\uFF1Aatrium host show ${result.host.ref}`
      );
    }
  }
};
var agentData = async (values) => {
  const { agentDataDir } = await import("./chunk-Q3H2H4V4.js");
  const { resolve: resolve11 } = await import("node:path");
  const given = str(values, "data")?.trim();
  return given ? resolve11(given) : agentDataDir();
};
var agentCommand = {
  args: "[--server <\u670D\u52A1\u5730\u5740>] [--token <\u63A5\u5165\u7801>] [--data <\u76EE\u5F55>]",
  about: "\u5728\u8FDC\u7A0B\u673A\u5668\u4E0A\u8FD0\u884C\uFF1A\u63A5\u5165 Atrium \u670D\u52A1\u5E76\u9886\u6D3E\u7ED9\u8FD9\u53F0\u7684\u6D3B\uFF08\u524D\u53F0\u5E38\u9A7B\uFF0CCtrl-C \u505C\uFF1B\u6267\u884C\u8005\u4E0D\u968F\u5B83\u9000\u51FA\uFF0C\u518D\u8D77\u6765\u63A5\u7740\u770B\uFF09\uFF1B\u9996\u6B21\u7528 host add \u7ED9\u7684\u63A5\u5165\u7801\uFF0C\u4E4B\u540E\u53EA\u8981 --server\u3002\u60F3\u5F00\u673A\u81EA\u542F\u3001\u5173\u7EC8\u7AEF\u4E0D\u65AD\u7528 atrium agent install\u3002\u6570\u636E\u5728 ~/.atrium-agent\uFF08--data \u6216 ATRIUM_AGENT_DATA \u53EF\u6539\uFF09\uFF1B--service \u7531\u7CFB\u7EDF\u670D\u52A1\u62C9\u8D77\u65F6\u7528",
  options: {
    server: { type: "string" },
    token: { type: "string" },
    data: { type: "string" },
    service: { type: "boolean" }
  },
  positionals: [0, 0],
  async run({ values }) {
    const { runAgent } = await import("./chunk-KRFGVCPB.js");
    return runAgent({
      server: str(values, "server"),
      code: str(values, "token"),
      data: await agentData(values),
      service: values.service === true
    });
  }
};
var SERVICE_KIND = {
  darwin: "launchd \u7528\u6237\u4EE3\u7406",
  linux: "systemd \u7528\u6237\u670D\u52A1",
  win32: "\u8BA1\u5212\u4EFB\u52A1"
};
var AUTOSTART = {
  darwin: "\u767B\u5F55\u65F6\u81EA\u542F",
  linux: "\u5F00\u673A\u81EA\u542F\uFF08linger\uFF09",
  win32: "\u672C\u4EBA\u767B\u5F55\u65F6\u81EA\u542F"
};
async function uninstall(values, json) {
  const data = await agentData(values);
  const { uninstallService } = await import("./chunk-XQ3BYK75.js");
  const result = await uninstallService(data);
  if (json) printJson(result);
  else
    console.log(
      result.absent ? `\u6CA1\u88C5\u7CFB\u7EDF\u670D\u52A1\uFF08${SERVICE_KIND[result.platform]} ${result.name}\uFF09\uFF0C\u4E0D\u7528\u5378\u8F7D` : [
        `\u5DF2\u5378\u8F7D ${SERVICE_KIND[result.platform]} ${result.name}\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u7167\u8DD1`,
        ...result.removed.length ? ["\u5220\u6389\u7684\u6587\u4EF6\uFF1A", ...result.removed.map((file2) => `  ${file2}`)] : [],
        `\u4EE4\u724C\u4ECD\u5728 ${data}\uFF1B\u524D\u53F0\u8FD0\u884C atrium agent \u6216\u518D\u88C5 atrium agent install \u90FD\u4E0D\u7528\u91CD\u65B0\u63A5\u5165`
      ].join("\n")
    );
  recordNext(`\u524D\u53F0\u8FD0\u884C\uFF1Aatrium agent${values.data ? ` --data ${data}` : ""}`);
}
async function status3(values, json) {
  const data = await agentData(values);
  const { serviceStatus } = await import("./chunk-XQ3BYK75.js");
  const result = await serviceStatus(data);
  const suffix = values.data ? ` --data ${data}` : "";
  if (json) printJson(result);
  else
    console.log(
      [
        `\u7CFB\u7EDF\u670D\u52A1\uFF1A${SERVICE_KIND[result.platform]} ${result.name} \xB7 ${result.installed ? `${result.running ? `\u5728\u8DD1\uFF08PID ${result.pid ?? "?"}\uFF09` : "\u6CA1\u5728\u8DD1"} \xB7 ${result.enabled ? AUTOSTART[result.platform] : "\u4E0D\u81EA\u542F"}` : "\u6CA1\u88C5"}`,
        ...result.linger === false && result.installed ? ["linger \u6CA1\u5F00\uFF1A\u9000\u51FA\u767B\u5F55\u4F1A\u505C\u3001\u5F00\u673A\u4E0D\u4F1A\u81EA\u5DF1\u8D77"] : [],
        ...result.stale ? [
          "\u670D\u52A1\u5B9A\u4E49\u548C\u73B0\u5728\u7684\u4E0D\u4E00\u81F4\uFF08node \u6216 Atrium \u6362\u4E86\u4F4D\u7F6E\uFF09\uFF1A\u91CD\u8DD1 atrium agent install"
        ] : [],
        `\u63A5\u5165\uFF1A${result.host ? `${result.host} \xB7 \u670D\u52A1 ${result.server}` : "\u8FD8\u6CA1\u63A5\u5165"}`,
        ...result.foreground ? [`\u524D\u53F0\u4EE3\u7406\u5728\u8DD1\uFF1APID ${result.foreground}`] : [],
        `\u65E5\u5FD7\uFF1A${result.log}`,
        ...result.tail.map((line3) => `  ${line3}`)
      ].join("\n")
    );
  recordNext(
    !result.installed ? `\u88C5\u6210\u7CFB\u7EDF\u670D\u52A1\uFF1Aatrium agent install${suffix}` : result.stale || !result.running ? `\u6309\u73B0\u5728\u7684\u5B9A\u4E49\u91CD\u88C5\u5E76\u91CD\u8D77\uFF1Aatrium agent install${suffix}` : `\u5378\u8F7D\uFF1Aatrium agent install --uninstall${suffix}`
  );
}
var agentServiceCommands = {
  "agent install": {
    args: "[--server <\u670D\u52A1\u5730\u5740>] [--token <\u63A5\u5165\u7801>] [--data <\u76EE\u5F55>] [--status | --uninstall]",
    about: "\u5728\u8FDC\u7A0B\u673A\u5668\u4E0A\u628A\u4EE3\u7406\u88C5\u6210\u7CFB\u7EDF\u670D\u52A1\uFF0C\u4E00\u6761\u547D\u4EE4\u5B8C\u6210\u63A5\u5165\u4E0E\u81EA\u542F\uFF1AmacOS launchd\u3001Linux systemd \u7528\u6237\u670D\u52A1\u3001Windows \u8BA1\u5212\u4EFB\u52A1\uFF08\u767B\u5F55\u65F6\u542F\u52A8\u3001\u9690\u85CF\u7A97\u53E3\uFF09\uFF1B\u5F02\u5E38\u9000\u51FA 10 \u79D2\u540E\u81EA\u52A8\u91CD\u8D77\uFF0C\u5173\u7EC8\u7AEF\u4E0D\u65AD\u3002\u9996\u6B21\u5E26 host add \u7ED9\u7684\u63A5\u5165\u7801\uFF0C\u5DF2\u63A5\u5165\u8FC7\u53EF\u7701\u7565\u3002\u91CD\u590D\u6267\u884C\u5E42\u7B49\uFF1A\u6CA1\u53D8\u5C31\u4E0D\u52A8\uFF0C\u53D8\u4E86\u6309\u65B0\u5B9A\u4E49\u91CD\u8D77\u3002\u4EE4\u724C\u53EA\u5728\u6570\u636E\u76EE\u5F55\u7684 agent.json\uFF080600\uFF09\uFF0C\u670D\u52A1\u914D\u7F6E\u91CC\u6CA1\u6709\u3002--status \u770B\u88C5\u6CA1\u88C5\u3001\u5728\u4E0D\u5728\u8DD1\u3001\u670D\u52A1\u5B9A\u4E49\u662F\u5426\u8FC7\u65F6\u4E0E\u65E5\u5FD7\u672B\u5C3E\uFF1B--uninstall \u5378\u8F7D\u7CFB\u7EDF\u670D\u52A1\uFF08\u6267\u884C\u8005\u7167\u8DD1\uFF0C\u4EE4\u724C\u7559\u7740\uFF0C\u518D\u88C5\u4E0D\u7528\u91CD\u65B0\u63A5\u5165\uFF09",
    options: {
      server: { type: "string" },
      token: { type: "string" },
      data: { type: "string" },
      status: { type: "boolean" },
      uninstall: { type: "boolean" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      if (values.status === true && values.uninstall === true)
        throw new Problem(400, "--status \u548C --uninstall \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
      if (values.status === true) return status3(values, json);
      if (values.uninstall === true) return uninstall(values, json);
      const data = await agentData(values);
      const { AgentState } = await import("./chunk-Q3H2H4V4.js");
      const server = str(values, "server") ?? new AgentState(data).config()?.server;
      if (!server)
        throw new Problem(
          400,
          "--server \u5FC5\u586B\uFF1A\u9996\u6B21\u63A5\u5165\u65F6\u4F7F\u7528 host add \u56DE\u6267\u91CC\u7684\u5730\u5740\uFF1B\u63A5\u5165\u540E\u53EF\u7701\u7565",
          "usage"
        );
      const { Agent } = await import("./chunk-WVU4EJRN.js");
      const { currentVersion } = await import("./chunk-MDR2YA57.js");
      const agent = new Agent({
        server,
        data,
        env: process.env,
        code: str(values, "token")?.trim() || void 0,
        version: currentVersion(),
        quota: null
      });
      const host = await agent.enroll();
      const { installService } = await import("./chunk-XQ3BYK75.js");
      const result = await installService(data);
      const config = new AgentState(data).config();
      if (json)
        printJson({ ...result, host, server: config?.server ?? server });
      else
        console.log(
          [
            `${result.unchanged ? "\u5DF2\u88C5\u597D\uFF0C\u6CA1\u6709\u6539\u52A8" : "\u5DF2\u88C5\u6210\u7CFB\u7EDF\u670D\u52A1"}\uFF1A${SERVICE_KIND[result.platform]} ${result.name}\uFF08${host} \xB7 \u670D\u52A1 ${config?.server ?? server}\uFF09`,
            result.running ? `\u5728\u8DD1 \xB7 PID ${result.pid ?? "?"} \xB7 ${AUTOSTART[result.platform]}` : `\u8FD8\u6CA1\u5728\u8DD1\uFF1A${result.foreground ? "\u7B49\u524D\u53F0\u4EE3\u7406\u505C\u4E0B" : `\u770B\u65E5\u5FD7 ${result.log}`}`,
            ...result.foreground ? [
              `\u8FD9\u53F0\u8FD8\u6709\u524D\u53F0\u8FD0\u884C\u7684\u4EE3\u7406\uFF08PID ${result.foreground}\uFF09\uFF1A\u5728\u90A3\u4E2A\u7EC8\u7AEF\u6309 Ctrl-C \u505C\u6389\uFF0C\u670D\u52A1\u91CC\u7684\u4EE3\u7406 10 \u79D2\u5185\u63A5\u624B`
            ] : [],
            ...result.lingerHint ? [
              `linger \u6CA1\u5F00\uFF1A\u73B0\u5728\u53EA\u5728\u767B\u5F55\u671F\u95F4\u8FD0\u884C\uFF0C\u9000\u51FA\u767B\u5F55\u4F1A\u505C\uFF1B\u8981\u5F00\u673A\u5C31\u8D77\u8FD0\u884C ${result.lingerHint}`
            ] : [],
            ...result.platform === "win32" ? ["Windows \u4E0A\u672C\u4EBA\u767B\u5F55\u540E\u624D\u8D77\uFF08\u9501\u5C4F\u4E0D\u5F71\u54CD\uFF09\uFF1B\u6CE8\u9500\u540E\u4E0D\u8DD1"] : [],
            "\u6539\u52A8\u7684\u7CFB\u7EDF\u4F4D\u7F6E\uFF1A",
            ...result.locations.map((location) => `  ${location}`),
            `\u65E5\u5FD7\uFF1A${result.log}`
          ].join("\n")
        );
      recordNext(
        `\u770B\u72B6\u6001\uFF1Aatrium agent install --status${values.data ? ` --data ${data}` : ""}`
      );
    }
  }
};

// cli/notify.ts
var client17 = async () => (await import("./chunk-P53PGFEK.js")).connect();
var TOKEN_MAX = 4 * 1024;
var PIPE_HINT = "pbpaste | atrium notify --token\uFF08Windows\uFF1AGet-Clipboard | atrium notify --token\uFF09";
var TOKEN_NEXT = "\u5B58 token\uFF1Apbpaste | atrium notify --token";
async function readToken(stdin = process.stdin) {
  if (stdin.isTTY)
    throw new Problem(
      400,
      `bot token \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\uFF0C\u4E0D\u5728\u547D\u4EE4\u884C\u53C2\u6570\u91CC\u7ED9\uFF08\u514D\u5F97\u8FDB shell \u5386\u53F2\uFF09\uFF1A${PIPE_HINT}`,
      "usage"
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > TOKEN_MAX)
      throw new Problem(
        400,
        "\u6807\u51C6\u8F93\u5165\u592A\u957F\uFF1A\u53EA\u653E @BotFather \u7ED9\u7684\u90A3\u4E00\u884C token",
        "usage"
      );
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").trim();
}
var bindLines = (bot, hint) => [
  hint.link ? `\u5728\u624B\u673A\u4E0A\u6253\u5F00 ${hint.link} \u70B9\u300C\u5F00\u59CB\u300D\uFF0C\u6216\u7ED9 @${bot} \u53D1\uFF1A${hint.code}` : `\u7ED9\u4F60\u7684\u673A\u5668\u4EBA\u53D1\uFF1A${hint.code}`,
  `\u7ED1\u5B9A\u7801 ${when(hint.expires_at)} \u524D\u6709\u6548`
];
function statusText(s) {
  if (!s.configured)
    return `\u8FD8\u6CA1\u914D\u63A8\u9001\u5230\u624B\u673A\u3002\u5148\u5728 Telegram \u627E @BotFather \u5EFA\u4E00\u4E2A\u673A\u5668\u4EBA\uFF0C\u518D\u628A token \u4F20\u8FDB\u6765\uFF1A${PIPE_HINT}`;
  const lines = [
    `Telegram \u673A\u5668\u4EBA @${s.bot} \xB7 ${s.bound ? "\u5DF2\u7ED1\u5B9A" : "\u8FD8\u6CA1\u7ED1\u5B9A\u804A\u5929"} \xB7 ${s.enabled ? "\u63A8\u9001\u5F00\u7740" : "\u63A8\u9001\u5173\u4E86"}`,
    `\u514D\u6253\u6270\uFF1A${s.quiet === "off" ? "\u6CA1\u8BBE" : s.quiet} \xB7 \u6512\u6279 ${s.batch_seconds} \u79D2`,
    `\u4EE3\u7406\uFF1A${s.proxy ? `${s.proxy}\uFF08Atrium \u5355\u72EC\u914D\u7684\uFF09` : s.system_proxy ? `${s.system_proxy}\uFF08\u7CFB\u7EDF\u4EE3\u7406\uFF09` : "\u76F4\u8FDE"}`,
    `\u5F85\u53D1 ${s.pending} \u4EF6${s.last_sent_at ? ` \xB7 \u6700\u8FD1\u53D1\u51FA ${when(s.last_sent_at)}` : ""}`
  ];
  if (s.last_error)
    lines.push(`\u6700\u8FD1\u5931\u8D25\uFF08${when(s.last_error.at)}\uFF09\uFF1A${s.last_error.error}`);
  if (!s.bound && s.bind) lines.push(...bindLines(s.bot, s.bind));
  return lines.join("\n");
}
async function saveToken(json) {
  const token = await readToken();
  const result = await (await client17()).put("/notify/telegram/token", { token });
  if (json) printJson(result);
  else
    console.log(
      [
        `\u5DF2\u5B58 bot token\uFF08@${result.bot}\uFF09\uFF0C\u51ED\u636E\u6587\u4EF6\u53EA\u7559\u7ED9\u672C\u4EBA`,
        ...bindLines(result.bot, result)
      ].join("\n")
    );
  recordNext("atrium notify --bind");
}
async function bind(values, json) {
  const raw = str(values, "timeout");
  if (raw !== void 0 && (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 3600))
    throw new Problem(400, "--timeout \u5E94\u4E3A 0\uFF5E3600 \u7684\u6574\u6570\u79D2", "usage");
  const seconds = raw === void 0 ? 120 : Number(raw);
  const api2 = await client17();
  const result = await longWait(
    seconds,
    (timeout) => api2.post("/notify/telegram/bind", { timeout }),
    () => "atrium notify --bind"
  );
  if (json) printJson(result);
  else if (result.bound)
    console.log(`\u5DF2\u7ED1\u5B9A @${result.bot}\uFF0C\u673A\u5668\u4EBA\u5DF2\u56DE\u4E86\u4E00\u6761\u300C\u5DF2\u7ED1\u5B9A\u300D`);
  else {
    console.log(bindLines(result.bot ?? null, result).join("\n"));
    console.log(
      `${seconds} \u79D2\u5185\u6CA1\u6536\u5230\u7ED1\u5B9A\u7801\uFF1B\u53D1\u4E86\u4E4B\u540E\u518D\u7B49\uFF1Aatrium notify --bind`
    );
  }
  recordNext(result.bound ? "atrium notify --test" : "atrium notify --bind");
  return result.bound ? 0 : 124;
}
async function test(json) {
  const result = await (await client17()).post("/notify/telegram/test", {});
  if (json) printJson(result);
  else console.log(`\u5DF2\u53D1\u6D4B\u8BD5\u6D88\u606F\uFF08@${result.bot}\uFF09\uFF0C\u53BB\u624B\u673A\u4E0A\u770B\u770B`);
  recordNext("atrium notify");
}
async function remove(json) {
  const result = await (await client17()).delete("/notify/telegram");
  if (json) printJson(result);
  else
    console.log(result.removed ? "\u5DF2\u5220\u6389 bot token \u4E0E\u7ED1\u5B9A" : "\u672C\u6765\u5C31\u6CA1\u914D\u63A8\u9001");
  recordNext(TOKEN_NEXT);
}
var notifyCommands = {
  notify: {
    args: "[--token | --bind [--timeout \u79D2] | --test | --remove]",
    about: "\u63A8\u9001\u5230\u624B\u673A\uFF08Telegram\uFF09\uFF1A\u4E0D\u5E26\u9009\u9879\u770B\u72B6\u6001\uFF08\u673A\u5668\u4EBA\u3001\u662F\u5426\u7ED1\u5B9A\u3001\u514D\u6253\u6270\u3001\u6512\u6279\u3001\u4EE3\u7406\u3001\u5F85\u53D1\u4E0E\u6700\u8FD1\u4E00\u6B21\u5931\u8D25\uFF1B\u4E0D\u663E\u793A token\uFF09\uFF1B--token \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB @BotFather \u7ED9\u7684 bot token\uFF08\u5982 pbpaste | atrium notify --token\uFF09\uFF0C\u5B58\u8FDB Atrium \u81EA\u5DF1\u7684\u51ED\u636E\u6587\u4EF6\uFF080600\uFF09\u5E76\u7ED9\u51FA\u7ED1\u5B9A\u7801\uFF0C\u6362 token \u8981\u91CD\u65B0\u7ED1\u5B9A\uFF1B--bind \u7B49\u4F60\u7ED9\u673A\u5668\u4EBA\u53D1\u7ED1\u5B9A\u7801\uFF08\u7F3A\u7701\u7B49 120 \u79D2\uFF0C\u6700\u591A 3600\uFF09\uFF0C\u6CA1\u6536\u5230\u9000\u51FA\u7801 124\uFF1B--test \u7ACB\u523B\u53D1\u4E00\u6761\u6D4B\u8BD5\u6D88\u606F\uFF1B--remove \u5220\u6389 bot token \u4E0E\u7ED1\u5B9A\u3001\u6E05\u7A7A\u5F85\u53D1\uFF08\u673A\u5668\u4EBA\u672C\u8EAB\u5230 @BotFather \u5220\uFF09",
    options: {
      token: { type: "boolean" },
      bind: { type: "boolean" },
      timeout: { type: "string" },
      test: { type: "boolean" },
      remove: { type: "boolean" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const picked = ["token", "bind", "test", "remove"].filter(
        (flag) => values[flag] === true
      );
      if (picked.length > 1)
        throw new Problem(
          400,
          "--token\u3001--bind\u3001--test\u3001--remove \u4E00\u6B21\u53EA\u80FD\u7ED9\u4E00\u4E2A",
          "usage"
        );
      if (picked[0] === "token") return saveToken(json);
      if (picked[0] === "bind") return bind(values, json);
      if (picked[0] === "test") return test(json);
      if (picked[0] === "remove") return remove(json);
      const status4 = await (await client17()).get("/notify/telegram");
      if (json) printJson(status4);
      else console.log(statusText(status4));
      recordNext(
        !status4.configured ? TOKEN_NEXT : !status4.bound ? "atrium notify --bind" : "atrium notify --test"
      );
    }
  },
  "notify set": {
    args: "[--quiet 23:00-08:00|off] [--batch \u79D2] [--proxy http://\u4E3B\u673A:\u7AEF\u53E3|off] [--on|--off]",
    about: "\u6539\u63A8\u9001\u8BBE\u7F6E\uFF1A\u514D\u6253\u6270\u65F6\u6BB5\uFF08\u672C\u673A\u949F\u70B9\uFF0C\u671F\u95F4\u6512\u7740\u3001\u7ED3\u675F\u540E\u5408\u6210\u4E00\u6761\u53D1\uFF09\u3001\u6512\u6279\u7A97\u53E3\uFF08\u7F3A\u7701 60 \u79D2\u5185\u591A\u6761\u5408\u4E00\u6761\uFF09\u3001\u5355\u72EC\u7684 HTTP \u4EE3\u7406\uFF08\u4E0D\u914D\u5C31\u8D70\u7CFB\u7EDF HTTPS_PROXY\uFF09\u3001\u5F00\u5173\uFF08\u5173\u6389\u6E05\u7A7A\u5F85\u53D1\uFF09",
    options: {
      quiet: { type: "string" },
      batch: { type: "string" },
      proxy: { type: "string" },
      on: { type: "boolean" },
      off: { type: "boolean" }
    },
    positionals: [0, 0],
    async run({ values, json }) {
      if (values.on === true && values.off === true)
        throw new Problem(400, "--on \u548C --off \u53EA\u80FD\u7ED9\u4E00\u4E2A", "usage");
      const body = {};
      if (str(values, "quiet") !== void 0) body.quiet = str(values, "quiet");
      if (str(values, "batch") !== void 0)
        body.batch_seconds = str(values, "batch");
      if (str(values, "proxy") !== void 0) body.proxy = str(values, "proxy");
      if (values.on === true) body.enabled = true;
      if (values.off === true) body.enabled = false;
      const status4 = await (await client17()).patch("/notify/telegram", body);
      if (json) printJson(status4);
      else console.log(`\u5DF2\u6539
${statusText(status4)}`);
      recordNext(status4.bound ? "atrium notify --test" : "atrium notify");
    }
  }
};

// cli/guide.ts
var groups = {
  \u670D\u52A1: [
    "start",
    "status",
    "stop",
    "restart",
    "update",
    "pause",
    "resume",
    "auth status",
    "auth rotate"
  ],
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
    "task run",
    "task stop",
    "task merge",
    "task deliver",
    "task log",
    "task wait",
    "schedule add",
    "schedule ls",
    "schedule run",
    "schedule rm",
    "events",
    "events wait",
    "events ack",
    "chat",
    "secretary bridge"
  ],
  \u63A8\u9001\u5230\u624B\u673A: ["notify", "notify set"],
  \u6267\u884C\u673A\u5668: [
    "host ls",
    "host show",
    "host add",
    "host edit",
    "host remove",
    "host clean",
    "agent",
    "agent install"
  ],
  \u4E13\u5458: [
    "specialist ls",
    "specialist add",
    "specialist edit",
    "workers",
    "workers edit"
  ],
  \u5168\u666F: ["map", "map context", "map edit"],
  \u7EC4\u7EC7: [
    "org tree",
    "org show",
    "org add",
    "org edit",
    "org point-add",
    "org point-edit",
    "org limits",
    "leader ls",
    "leader add",
    "leader edit",
    "leader escalate"
  ],
  \u5907\u5FD8\u4E0E\u51B3\u5B9A: ["memo show", "memo edit", "decision add", "decision ls"],
  \u8D44\u6599: [
    "material add",
    "material ls",
    "material show",
    "material get",
    "material archive",
    "material keep",
    "material rm"
  ],
  \u51ED\u636E: [
    "secret set",
    "secret ls",
    "secret archive",
    "secret keep",
    "secret rm"
  ],
  \u9009\u9879\u4E0E\u62CD\u677F: [
    "choice ls",
    "choice show",
    "choice pick",
    "choice pass",
    "choice comment",
    "choice add"
  ],
  \u6280\u80FD: ["skill ls", "skill show", "skill add", "skill edit"]
};
function groupOf(name) {
  return Object.entries(groups).find(([, members]) => members.includes(name))?.[0] ?? "\u670D\u52A1";
}
function example(name, command) {
  if (name === "task add") return "atrium task add \u62C6\u5206\u767B\u5F55\u6A21\u5757 --parent t1";
  if (name === "task set") return "atrium task set t1 --status done";
  if (name === "task deliver")
    return "atrium task deliver t1 --pr https://github.com/acme/demo/pull/7";
  if (name === "task run")
    return "atrium task run t1 --worker codex+gpt-6-sol:high";
  if (name === "schedule add")
    return "atrium schedule add atrium/cli --kind patrol --every 1d --at 09:30";
  if (name === "host add")
    return "atrium host add \u4E66\u623F\u53F0\u5F0F\u673A --repo liu-zhengdong/atrium --max 4";
  if (name === "host edit")
    return "atrium host edit h2 --ssh user@100.70.239.117 --tunnel 4310:14310";
  if (name === "agent")
    return "atrium agent --server http://host.orb.internal:4310 --token h2-\u63A5\u5165\u7801";
  if (name === "agent install")
    return "atrium agent install --server http://127.0.0.1:14310 --token h3-\u63A5\u5165\u7801";
  if (name === "events ack") return "atrium events ack 12 13";
  if (name === "notify set")
    return "atrium notify set --quiet 23:00-08:00 --proxy http://127.0.0.1:7890";
  if (name === "pause") return "atrium pause --why \u5148\u505C\u4E0B\u770B\u770B\u5168\u5C40 --stop";
  if (name === "resume") return "atrium resume --host h3";
  if (name === "workers edit")
    return "atrium workers edit combos/codex+gpt-6-sol --trust medium --reason \u8FDE\u7EED\u4E94\u6B21\u4E00\u6B21\u901A\u8FC7";
  if (name === "workers") return "atrium workers harness/codex";
  if (name === "map") return "atrium map atrium --depth 2";
  if (name === "map edit")
    return "atrium map edit atrium/cli --what \u4E00\u53E5\u8BDD --uses \u573A\u666F\u4E00 --uses \u573A\u666F\u4E8C --now \u73B0\u72B6";
  if (name === "org add")
    return "atrium org add atrium ledger --name \u5F85\u529E\u672C --analogy \u56E2\u961F\u7684\u4EFB\u52A1\u767D\u677F";
  if (name === "org point-add")
    return "atrium org point-add atrium/runtime \u4E0D\u91C7\u4FE1\u6267\u884C\u8005\u81EA\u8FF0 --why \u4E8B\u5B9E\u7531\u8FD0\u884C\u65F6\u67E5 --by u1\uFF0809-27\uFF09";
  if (name === "org point-edit") return "atrium org point-edit k27 --pos 1";
  if (name === "org limits")
    return "atrium org limits --quota-reserve 20 --money-max 0";
  if (name === "leader add")
    return "atrium leader add Atrium\u8D1F\u8D23\u4EBA --worker claude+opus:high";
  if (name === "leader edit")
    return "atrium leader edit a1 --memo \u5728\u7B49t5\u5408\u5165\uFF0C\u5408\u5165\u540E\u4E0A\u4EA4\u5DF2\u4E0A\u7EBF";
  if (name === "leader escalate")
    return "atrium leader escalate \u7EC4\u7EC7\u6811\u9636\u6BB5\u8FBE\u6210 --kind shipped --task t5";
  if (name === "memo edit") return "atrium memo edit \u5728\u7B49t5\u5408\u5165 --as a1";
  if (name === "decision add")
    return "atrium decision add \u989D\u5EA6\u8BFB\u53D6\u4E0D\u4F9D\u8D56OpenQuota --why \u8981\u8FC1\u5230\u522B\u7684\u8BBE\u5907 --issue 352";
  if (name === "decision ls") return "atrium decision ls \u989D\u5EA6 --node o2";
  if (name === "material add")
    return "atrium material add o4 docs/design/t120-tasks --note t120\u4EFB\u52A1\u89C6\u56FE\u7684\u8BBE\u8BA1\u7A3F\u4E0E\u622A\u56FE --for t120";
  if (name === "material ls") return "atrium material ls --node o4";
  if (name === "material get") return "atrium material get m1 --out \u8D44\u6599";
  if (name === "material archive")
    return "atrium material archive m1 --note \u5DF2\u6309\u65B0\u8BBE\u8BA1\u4E0A\u7EBF";
  if (name === "material keep")
    return "atrium material keep m1 --note \u4E0B\u4E00\u7248\u8FD8\u8981\u5BF9\u7167";
  if (name === "material show" || name === "material rm")
    return `atrium ${name} m1`;
  if (name === "choice ls") return "atrium choice ls --open";
  if (name === "choice pick")
    return "atrium choice pick c3 1 3 --note \u9009\u98792\u7B49\u989D\u5EA6\u5BBD\u88D5\u518D\u8BF4";
  if (name === "choice pass")
    return "atrium choice pass c3 --note \u8FD9\u5468\u5148\u6536\u5C3E\u5728\u505A\u7684";
  if (name === "choice show") return "atrium choice show c3";
  if (name === "choice add")
    return "atrium choice add atrium --file \u9009\u9879\u5355.json --task t42";
  if (name === "choice comment")
    return "atrium choice comment c3 \u5148\u505A\u770B\u677F\u8FC7\u6EE4\uFF0C\u5408\u5165\u63D0\u901F\u7B49CI\u7A33\u4E86 --prefer 1 --basis f3";
  const sample = command.args.split("[")[0].replace(/\S+…/g, "\u7532").replace(/序号/g, "1").replace(/\btN\b/g, "t1").trim();
  return `atrium ${name}${sample ? ` ${sample}` : ""}`;
}
function guide() {
  const codes = Object.entries(exitCodes).map(([code, exit]) => `  ${exit}  ${code}`).join("\n");
  return `Atrium \u547D\u4EE4\u884C\u8BF4\u660E\u4E66\uFF08\u5199\u7ED9 Agent\uFF09

\u8C03\u7528\u7EA6\u5B9A
  \u547D\u4EE4\u7528\u6CD5\u53EA\u5728 --help\uFF1Aatrium --help \u5217\u51FA\u5168\u90E8\u547D\u4EE4\uFF0Catrium <\u547D\u4EE4> --help \u770B\u4E00\u6761\u7684\u7528\u6CD5\u4E0E\u793A\u4F8B\u3002
  \u77ED\u53F7\u5168\u5C40\u4E00\u81F4\u3001\u4E0D\u590D\u7528\uFF1A\u4EFB\u52A1 t1\u3001\u90E8\u95E8 o1\u3001\u8981\u70B9 k1\u3001\u51B3\u5B9A d1\u3001\u9009\u9879\u5355 c1\u3001\u8D44\u6599 m1\u3001\u5468\u671F\u4EFB\u52A1 s1\u3001\u4E13\u5458 r1\u3001\u7528\u6237 u1\u3001leader a1\u3001\u6267\u884C\u673A\u5668 h1\u3002\u90E8\u95E8\u4E5F\u53EF\u5199\u8DEF\u5F84\uFF0C\u5982 atrium/web\u3002
  --as\uFF1Atask/events \u662F\u4E8B\u4EF6\u8BA2\u9605\u8005\uFF0Cmemo \u662F\u5907\u5FD8\u7684\u4E3B\u4EBA\uFF08\u7F3A\u7701 secretary\uFF0Cleader \u8FDB\u7A0B\u91CC\u7F3A\u7701\u81EA\u5DF1\uFF09\uFF1Borg/skill/map\u3001pause/resume\u3001workers edit\u3001specialist \u662F\u6539\u52A8\u8BB0\u5728\u8C01\u540D\u4E0B\uFF08u1\u3001secretary \u6216 aN\uFF0C\u7F3A\u7701 u1\uFF0C\u79D8\u4E66\u4F1A\u8BDD\u91CC\u7F3A\u7701 secretary\uFF09\u3002
  --json\uFF1A\u6210\u529F {"ok":true,"result":\u63A5\u53E3\u7ED3\u679C,"next":\u4E0B\u4E00\u6B65\u547D\u4EE4\u6216null}\uFF1B\u5931\u8D25 {"ok":false,"error":{"code","message","candidates"?},"next":\u4FEE\u6B63\u547D\u4EE4\u6216null}\u3002stdout \u53EA\u5199\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u63D0\u793A\u5728 stderr\u3002
  \u6587\u672C\u56DE\u6267\u6700\u540E\u4E00\u884C\u662F\u300C\u52A8\u4F5C\uFF1Aatrium \u547D\u4EE4\u300D\uFF1B\u62A5\u9519\u540E\u6309\u5019\u9009\u77ED\u53F7\u91CD\u8BD5\uFF0C\u6216\u6267\u884C\u56DE\u6267\u91CC\u7684\u4FEE\u6B63\u547D\u4EE4\u3002
  \u5F02\u6B65\u72B6\u6001\u7528\u7B49\u5F85\uFF0C\u4E0D\u8F6E\u8BE2\uFF1Aatrium task wait\u3001atrium task log --follow\u3001atrium events wait\u3002
  \u6267\u884C\u8005\u8FDB\u7A0B\uFF08\u5E26 ATRIUM_WORKER=1\uFF09\u4E0D\u80FD\u64CD\u4F5C\u670D\u52A1\uFF0C\u53EA\u80FD atrium material get \u53D6\u8D44\u6599\u3002

\u9000\u51FA\u7801\u4E0E code
  0  \u6210\u529F
${codes}

\u6BCF\u7C7B\u4E1C\u897F\u653E\u54EA
  \u89C4\u77E9\uFF08\u7528\u6237\u7684\u539F\u5219\u3001\u53E3\u5473\u3001\u53D6\u820D\u3001\u8981\u5B88\u7684\u7EA6\u675F\uFF09\u2192 \u8981\u70B9\uFF1Aatrium org point-add \u90E8\u95E8 \u8981\u70B9 --why \u4E3A\u4EC0\u4E48 --by 'u1 09-28' [--pos N]\uFF1B\u6302\u5728\u90E8\u95E8\u4E0A\u6309\u6811\u5F80\u4E0B\u7EE7\u627F\uFF0C\u8DE8\u51E0\u4E2A\u90E8\u95E8\u7684\u653E\u5171\u540C\u4E0A\u7EA7\uFF0C\u540C\u4E00\u90E8\u95E8\u8D8A\u9760\u524D\u8D8A\u91CD\u8981\u3001\u51B2\u7A81\u65F6\u9760\u524D\u7684\u4F18\u5148\u3002\u6D3E\u6D3B\u4E0E leader \u5524\u9192\u53EA\u9644\u5F52\u5C5E\u90E8\u95E8\u94FE\u4E0A\u7684\u8981\u70B9\uFF08atrium map context \u90E8\u95E8\uFF09\u3002
  \u505A\u6CD5\u4E0E\u53E3\u5473 \u2192 \u6280\u80FD\uFF08atrium skill edit\uFF09\u3002
  \u8C01\u5E72\u3001\u4EA4\u4ED8\u4EC0\u4E48\u3001\u6302\u54EA\u4E9B\u6280\u80FD \u2192 \u4E13\u5458\uFF08\u53EA\u8BB0\u5206\u5DE5\uFF09\u3002
  \u5DE5\u5177\u4E0E\u6A21\u578B\u672C\u8EAB\u7684\u4E8B\u5B9E \u2192 \u6267\u884C\u8005\u6863\u6848\uFF08atrium workers edit\uFF09\u3002
  \u7ED9\u4F60\u7559\u7684\u989D\u5EA6\u3001\u82B1\u8D39\u4E0A\u9650 \u2192 atrium org limits\u3002
  \u7528\u6237\u62CD\u677F\u7684\u4E8B\u4E0E\u539F\u56E0 \u2192 \u51B3\u5B9A\u8BB0\u5F55\uFF08atrium decision add\uFF1B\u7ED9\u4EBA\u56DE\u770B\uFF0C\u4E0D\u9644\u8FDB\u63D0\u793A\u8BCD\uFF09\u3002
  \u5904\u7406\u8FC7\u7A0B \u2192 \u4EFB\u52A1\u5907\u6CE8\uFF08atrium task note\uFF09\uFF1B\u5F53\u524D\u5728\u7B49\u4EC0\u4E48 \u2192 \u5907\u5FD8\uFF08atrium memo edit\uFF09\u3002
  \u6587\u4EF6\u3001\u8BBE\u8BA1\u7A3F \u2192 \u8D44\u6599\uFF08atrium material add\uFF09\uFF1B\u4EE4\u724C\u3001\u5BC6\u7801 \u2192 \u51ED\u636E\uFF08atrium secret set\uFF0C\u503C\u4E0D\u663E\u793A\uFF09\u3002
  \u8DDF\u7740\u4EE3\u7801\u8D70\u7684\u7EA6\u5B9A \u2192 \u4ED3\u5E93 AGENTS.md\u3002

\u4E3B\u8DEF\u5F84
  \u670D\u52A1\uFF1A\u53EA\u7531 atrium\uFF08\u6216 atrium start\uFF09\u542F\u52A8\uFF0C\u522B\u7684\u547D\u4EE4\u5728\u670D\u52A1\u6CA1\u5728\u8DD1\u65F6\u62A5\u9519\uFF1Batrium restart \u968F\u65F6\u53EF\u505A\uFF08\u5728\u8DD1\u7684\u6267\u884C\u8005\u7531\u65B0\u670D\u52A1\u63A5\u7BA1\uFF09\uFF1B\u6570\u636E\u9ED8\u8BA4 ~/.atrium\uFF08ATRIUM_DATA \u6539\uFF09\uFF0C\u7AEF\u53E3 ATRIUM_PORT\uFF1B\u4EE4\u724C\u5931\u6548 atrium auth rotate\u3002
  \u4E00\u952E\u505C\u673A\uFF1Aatrium pause [--part \u90E8\u95E8|--host hN] [--why \u539F\u56E0] \u505C\u4E0B\u4E00\u5207\u81EA\u4E3B\u52A8\u4F5C\uFF08\u6D3E\u6D3B\u3001\u5468\u671F\u4EFB\u52A1\u3001\u5524\u9192\u3001\u5408\u5165\u3001\u53D1\u7248\uFF09\uFF1Batrium resume \u6062\u590D\u3002
  \u62C6\u4EFB\u52A1\u6D3E\u6D3B\uFF1Aatrium task add \u6807\u9898 [--parent t1] [--part \u90E8\u95E8] [--by \u4E13\u5458] [--priority \u7D27\u6025|\u4FEE\u590D|\u666E\u901A|\u95F2\u65F6]\uFF1Batrium task run t2 \u5165\u961F\uFF08\u4E00\u4E2A\u961F\u5217\uFF0C\u6309\u4F18\u5148\u7EA7\u4E0E\u5165\u961F\u5148\u540E\u62C9\u8D77\uFF09\uFF1Batrium task wait t2\u3002\u6709\u5B50\u4EFB\u52A1\u7684\u662F\u603B\u4EFB\u52A1\uFF0C\u72B6\u6001\u6309\u5B50\u5B59\u6C47\u603B\u3002
  \u989D\u5EA6\uFF1A\u6D3E\u6D3B\u524D\u770B\u5019\u9009\uFF1Aatrium task run t2 --dry-run\uFF1B\u53EA\u770B\u989D\u5EA6\uFF1Aatrium quota\uFF1B\u4EBA\u5DE5\u89E3\u9664\u8BEF\u5224\u5360\u7528\uFF1Aatrium quota --clear claude\u3002
  \u770B\u8C01\u5728\u5E72\u4EC0\u4E48\uFF1Aatrium top\uFF08\u811A\u672C\u7528 --once --json\uFF09\uFF1BClaude Code \u72B6\u6001\u680F\u7528 atrium statusline\u3002
  \u7B49\u4E8B\u4EF6\uFF1Aatrium events wait --as secretary \u53EA\u53D6\u8981\u5904\u7406\u7684\u4E8B\uFF08\u6512\u6279 30 \u79D2\uFF09\uFF1B\u5904\u7406\u5B8C atrium events ack 12\u3002
  \u4EA4\u4ED8\uFF1A\u6267\u884C\u8005\u505C\u5728 PR\uFF1B\u4EA4\u4ED8\u524D\u5728\u9694\u79BB\u5B9E\u4F8B\u8DD1\u7AEF\u5230\u7AEF\u9A8C\u8BC1\uFF0C\u628A\u547D\u4EE4\u4E0E\u8F93\u51FA\u8D34\u8FDB PR\u300C\u7AEF\u5230\u7AEF\u9A8C\u8BC1\u300D\u4E00\u8282\uFF1B\u8FD0\u884C\u65F6\u5173\u5361\u67E5\u4E8B\u5B9E\uFF0C\u9AD8\u98CE\u9669\u6216\u4F4E\u4FE1\u4EFB\u7684 PR \u5408\u5165\u524D\u7531\u53E6\u4E00\u4E2A\u6A21\u578B\u5BA1\u9605\uFF1B\u5408\u5165\u961F\u5217\u4E32\u884C\u5408\u5165\uFF1B\u81EA\u5347\u7EA7\u4E0A\u7EBF\u540E\u53EA\u8DD1\u53EA\u8BFB\u5192\u70DF\uFF08status\u3001task ls\u3001--help\uFF09\u3002
  \u6301\u7403\u4E0E\u671F\u9650\uFF1A\u6BCF\u4EF6\u6CA1\u7ED3\u675F\u7684\u4E8B\u90FD\u6709\u6301\u7403\u4EBA\uFF0C\u5230\u671F\u5148\u53EB\u9192\u6301\u7403\u4EBA\uFF0C\u518D\u5230\u671F\u5F80\u4E0A\u4EA4\uFF1B\u72B6\u6001\u680F\u4E0E top \u5199\u300CN \u5206\u949F\u6CA1\u52A8\u300D\u3002
  leader\uFF1A\u4E8B\u4EF6\u6295\u7ED9\u5F52\u5C5E\u90E8\u95E8\u6700\u8FD1\u7684 leader\uFF0C\u5B83\u6309\u4E8B\u5524\u9192\u5904\u7406\u3001\u4EE5\u52A8\u4F5C\u6536\u5C3E\uFF1B\u53EA\u628A\u56DB\u7C7B\u4E8B\u4E0A\u4EA4\uFF1Aatrium leader escalate \u8BF4\u660E --kind shipped|cross|beyond|stuck\u3002
  \u5168\u666F\uFF1A\u4EBA\u7528 atrium map \u6253\u5F00\u672C\u673A\u7F51\u9875\uFF08\u53EA\u8BFB\uFF0C\u53EA\u80FD\u62CD\u677F\u9009\u9879\u5355\uFF09\uFF1BAgent \u7528 atrium map \u90E8\u95E8 --json\uFF0C\u6539\u4EBA\u8BDD\u5B57\u6BB5\u7528 atrium map edit\u3002
  \u9009\u9879\u4E0E\u62CD\u677F\uFF1A\u8C03\u7814\u5199\u51FA\u9009\u9879\u5355\uFF08atrium choice add \u90E8\u95E8 --file \u9009\u9879\u5355.json\uFF09\uFF0C\u53EB\u9192\u79D8\u4E66\u9012\u7ED9\u7528\u6237\uFF1B\u53EA\u6709\u7528\u6237\u62CD\u677F\uFF08atrium choice pick / pass\uFF09\u3002
  \u79D8\u4E66\uFF1AClaude Code \u505A\u79D8\u4E66\u65F6 atrium secretary bridge --install-hook\uFF1B\u4E5F\u53EF atrium chat\uFF08opencode / codex\uFF09\u3002`;
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
  conclusion: "\u7ED3\u8BBA",
  avoid_host: "--avoid-host"
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
var updateCommand = {
  args: "[--to <\u7248\u672C>] [--repo <\u4ED3\u5E93>]",
  about: "\u68C0\u67E5\u5E76\u66F4\u65B0 Atrium \u7248\u672C\uFF0C\u5B89\u88C5\u65B0\u7248\u672C\u5E76\u5C55\u793A\u6539\u52A8\u6458\u8981",
  options: {
    to: { type: "string" },
    repo: { type: "string" }
  },
  positionals: [0, 0],
  run: async ({ values }) => {
    const { update } = await import("./chunk-YT3VOIF2.js");
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
    const { restart } = await import("./chunk-CEPIOVBD.js");
    await restart(
      values
    );
    return 0;
  }
};
var commands = {
  ...authCommands,
  ...pauseCommands,
  // 看板放在任务组最前：先看谁在干活，再看单个任务。
  top: topCommand,
  statusline: statuslineCommand,
  ...taskCommands,
  ...specialistCommands,
  ...workerCommands,
  ...mapCommands,
  ...orgCommands,
  ...leaderCommands,
  ...scheduleCommands,
  ...memoCommands,
  ...materialCommands,
  ...secretCommands,
  ...choiceCommands,
  ...skillCommands,
  ...quotaCommands,
  ...eventCommands,
  ...notifyCommands,
  ...hostCommands,
  agent: agentCommand,
  ...agentServiceCommands,
  chat: chatCommand,
  ...secretaryCommands,
  update: updateCommand,
  restart: restartCommand
};
var service = [
  [
    "atrium",
    "\u542F\u52A8\u6216\u590D\u7528\u540E\u53F0\u670D\u52A1\uFF0C\u8F93\u51FA\u5730\u5740\uFF08\u540C atrium start\uFF1B\u53EA\u6709\u8FD9\u4E24\u4E2A\u4F1A\u542F\u52A8\u670D\u52A1\uFF09"
  ],
  ["atrium status", "\u67E5\u770B\u670D\u52A1\u72B6\u6001\u3001\u5730\u5740\u3001\u6570\u636E\u76EE\u5F55\u4E0E\u6682\u505C"],
  [
    "atrium pause [--part \u8282\u70B9|--host hN] [--why \u539F\u56E0] [--stop]",
    "\u4E00\u952E\u505C\u673A\uFF1A\u505C\u4E0B\u4E00\u5207\u81EA\u4E3B\u52A8\u4F5C"
  ],
  ["atrium resume [--part \u8282\u70B9|--host hN]", "\u6062\u590D atrium pause \u505C\u4E0B\u7684"],
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
  const widest = Math.max(...service.map(([line3]) => width(line3)));
  return [
    "\u4F60\u662F Agent \u7684\u8BDD\uFF0C\u5148\u8BFB atrium guide\u3002",
    "",
    "\u670D\u52A1",
    ...service.map(([line3, about]) => `  ${pad(line3, widest)}  ${about}`),
    ...Object.keys(groups).filter((group) => group !== "\u670D\u52A1").flatMap((group) => [
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
        if (!workerReadable(name, rest)) workerGuard();
        leaderCommandGuard(name);
      }
      if (name === void 0 || name === "--no-open" || name === "start") {
        if (rest.filter((part) => part !== "--json").length)
          throw new Problem(400, usage, "usage");
        const { startService } = await import("./chunk-HBJE6DNU.js");
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
        const { serviceStatus, stopService } = await import("./chunk-HBJE6DNU.js");
        await (name === "status" ? serviceStatus : stopService)(
          dataDirectory()
        );
        if (name === "status") {
          const { connectRunning } = await import("./chunk-P53PGFEK.js");
          const pauses = await Promise.resolve().then(() => connectRunning()?.get("/pause")).catch(() => void 0);
          for (const line3 of pauseLines(pauses?.pauses)) console.log(line3);
        }
        return 0;
      }
      if (name === "guide") {
        console.log(guide());
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
          Object.keys(commands).map((ref3) => ({ ref: ref3, name: ref3 }))
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
            `\u6700\u63A5\u8FD1\u7684\uFF1A${result.candidates.map(({ name: name2, ref: ref3 }) => `${name2 === ref3.split("/").at(-1) ? ref3 : `${name2}\uFF08${ref3}\uFF09`}`).join("\u3001")}`
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
  if (name === "" || name === "--no-open" || name === "start")
    return "\u505C\u6B62\uFF1Aatrium stop";
  if (name === "update") return "\u751F\u6548\uFF1Aatrium restart";
  if (name === "restart") return "\u67E5\u770B\u72B6\u6001\uFF1Aatrium status";
  if (name === "status") return "\u770B\u4EFB\u52A1\uFF1Aatrium top";
  return null;
}
export {
  commands,
  help,
  main,
  service
};
