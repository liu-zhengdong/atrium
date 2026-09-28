import {
  AgentState
} from "./chunk-OYU4IKQ6.js";
import {
  ensureWorktree,
  exec,
  firstLine
} from "./chunk-KBI6MJJE.js";
import {
  ADAPTERS,
  TOOLS,
  backoffMs,
  hostGate,
  hostLimits,
  insideData,
  isKnownTool,
  isTool,
  secretNameProblem,
  withSecrets,
  workerEnvironment
} from "./chunk-X2M4GQZ5.js";
import {
  Problem,
  commandInvocation,
  findExecutable,
  killTree,
  linkPath,
  processAlive,
  runFile,
  spawnInvocation
} from "./chunk-XWXBA3CJ.js";
import {
  commandLineInvocation,
  parseProcessProbe,
  processProbeInvocation
} from "./chunk-AOP4HR6R.js";

// server/agent/main.ts
import {
  existsSync as existsSync6,
  openSync as openSync2,
  readSync,
  closeSync as closeSync2,
  readFileSync as readFileSync4,
  statSync as statSync3
} from "node:fs";
import { availableParallelism as availableParallelism2, loadavg } from "node:os";
import { dirname as dirname3 } from "node:path";

// server/skills/remote.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// server/skills/model.ts
import { createHash } from "node:crypto";
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
var bad = (field, message) => {
  throw new Problem(400, `${field} ${message}`, "usage");
};
var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
function validateFilePath(path2) {
  const segments = path2.split("/");
  if (!path2 || segments.length > LIMITS.depth || segments.some((seg) => !SEGMENT.test(seg) || seg.length > 100))
    return bad(
      `files.${path2 || "\uFF08\u7A7A\uFF09"}`,
      `\u8DEF\u5F84\u4E0D\u5408\u6CD5\uFF1A\u53EA\u80FD\u662F\u6280\u80FD\u76EE\u5F55\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u6BB5\u540D\u7528\u82F1\u6570\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u6216\u8FDE\u5B57\u7B26\uFF0C\u4E0D\u4EE5\u70B9\u5F00\u5934\uFF0C\u6700\u591A ${LIMITS.depth} \u5C42`
    );
  return path2;
}
function validateFiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return bad("files", "\u5E94\u4E3A {\u76F8\u5BF9\u8DEF\u5F84: \u6587\u672C}");
  const entries = Object.entries(value);
  if (!entries.some(([path2]) => path2 === "SKILL.md"))
    return bad("files", "\u7F3A\u5C11 SKILL.md");
  if (entries.length > LIMITS.files)
    return bad("files", `\u8D85\u8FC7 ${LIMITS.files} \u4E2A\u6587\u4EF6`);
  let total = 0;
  const out = {};
  for (const [path2, content] of entries.sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  )) {
    validateFilePath(path2);
    if (typeof content !== "string" || content.includes("\0"))
      return bad(`files.${path2}`, "\u5E94\u4E3A\u6587\u672C\u6587\u4EF6");
    total += Buffer.byteLength(content, "utf8");
    out[path2] = content;
  }
  if (total > LIMITS.bytes)
    return bad("files", `\u5408\u8BA1 ${total} \u5B57\u8282\uFF0C\u8D85\u8FC7 ${LIMITS.bytes / 1024} KB`);
  return out;
}
function filesHash(files) {
  const hash = createHash("sha256");
  for (const [path2, content] of Object.entries(files).sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  ))
    hash.update(`${path2}\0${content}\0`);
  return hash.digest("hex");
}

// server/skills/mount.ts
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path, { dirname, join } from "node:path";
var MANIFEST = "skills.json";
var NOTES = "skill-notes.md";
var CODEX_LINKS = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "rules",
  "plugins"
];
function skillLayout(dir, tool, join5 = path.join) {
  switch (ADAPTERS[tool].skillMount) {
    case "claude-plugin": {
      const root = join5(dir, "skills-plugin");
      return {
        root,
        skills: join5(root, "skills"),
        args: ["--plugin-dir", root],
        env: {},
        how: "\u5DF2\u4F5C\u4E3A Claude Code \u63D2\u4EF6\u6280\u80FD\u52A0\u8F7D\uFF08\u540D\u5B57\u5E26 atrium-skills: \u524D\u7F00\uFF09"
      };
    }
    case "codex-home": {
      const root = join5(dir, "codex-home");
      return {
        root,
        skills: join5(root, "skills"),
        args: [],
        env: { CODEX_HOME: root },
        how: "\u5DF2\u653E\u8FDB codex \u7684\u6280\u80FD\u76EE\u5F55"
      };
    }
    case "opencode-config": {
      const root = join5(dir, "opencode");
      return {
        root,
        skills: join5(root, "skills"),
        args: [],
        env: { OPENCODE_CONFIG_DIR: root },
        how: "\u5DF2\u653E\u8FDB opencode \u7684\u6280\u80FD\u76EE\u5F55"
      };
    }
    default:
      return {
        root: join5(dir, "skills"),
        skills: join5(dir, "skills"),
        args: [],
        env: {},
        how: "\u6CA1\u6709\u539F\u751F\u52A0\u8F7D\uFF0C\u9700\u8981\u65F6\u8BFB\u5BF9\u5E94\u7684 SKILL.md"
      };
  }
}
function readManifest(dir) {
  try {
    const data = JSON.parse(
      readFileSync(join(dir, MANIFEST), "utf8")
    );
    return Array.isArray(data.skills) ? data : void 0;
  } catch {
    return void 0;
  }
}
function writeFiles(target, files) {
  rmSync(target, { recursive: true, force: true });
  for (const [path2, content] of Object.entries(files)) {
    const file = join(target, ...path2.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 448 });
    writeFileSync(file, content, { mode: 384 });
  }
}
function linkIfAbsent(source, target) {
  if (!existsSync(source)) return;
  try {
    lstatSync(target);
  } catch {
    linkPath(source, target);
  }
}
function linkCodexHome(root, home, skills) {
  const user = join(home, ".codex");
  for (const name of CODEX_LINKS)
    linkIfAbsent(join(user, name), join(root, name));
  let own = [];
  try {
    own = readdirSync(join(user, "skills"));
  } catch {
  }
  for (const name of own)
    if (!name.startsWith(".") && !skills.some((s) => s.slug === name))
      linkIfAbsent(join(user, "skills", name), join(root, "skills", name));
}
function mountSkills(dir, tool, skills, home) {
  if (!skills.length) return void 0;
  const place = skillLayout(dir, tool);
  mkdirSync(place.skills, { recursive: true, mode: 448 });
  if (ADAPTERS[tool].skillMount === "claude-plugin") {
    mkdirSync(join(place.root, ".claude-plugin"), {
      recursive: true,
      mode: 448
    });
    writeFileSync(
      join(place.root, ".claude-plugin", "plugin.json"),
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
    const target = join(place.skills, skill.slug);
    const kept = previous.get(skill.slug);
    if (kept && kept.dir === target && existsSync(join(target, "SKILL.md"))) {
      mounted.push(kept);
      continue;
    }
    writeFiles(target, skill.files);
    mounted.push({
      id: skill.id,
      slug: skill.slug,
      rev: skill.rev,
      dir: target,
      sha: filesHash(skill.files)
    });
  }
  const all3 = [
    ...mounted,
    ...(readManifest(dir)?.skills ?? []).filter(
      (entry) => !mounted.some((m) => m.dir === entry.dir)
    )
  ];
  writeFileSync(
    join(dir, MANIFEST),
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
  \u6587\u4EF6\uFF1A${join(entry.dir, "SKILL.md")}`;
    }),
    `\u6280\u80FD\u5185\u5BB9\u6709\u8BEF\u6216\u8FC7\u65F6\uFF1A\u53EF\u4EE5\u76F4\u63A5\u6539\u4E0A\u9762\u7684\u526F\u672C\uFF08\u4E0D\u8981\u590D\u5236\u8FDB\u4ED3\u5E93\uFF09\uFF0C\u5E76\u628A\u539F\u56E0\u5199\u8FDB ${join(dir, NOTES)}\uFF1B\u6536\u5C3E\u65F6\u4F1A\u751F\u6210\u4FEE\u8BA2\u63D0\u8BAE\uFF0C\u5BA1\u6838\u540E\u91C7\u7EB3\u3002`
  ].join("\n");
  return { env: place.env, args: place.args, section, skills: mounted };
}
function readMounted(root) {
  const files = {};
  let bytes = 0;
  const walk = (dir, prefix, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return `\u8BFB\u4E0D\u5230 ${dir}`;
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= LIMITS.depth) return `${rel} \u76EE\u5F55\u5C42\u7EA7\u8D85\u8FC7 ${LIMITS.depth}`;
        const problem2 = walk(full, rel, depth + 1);
        if (problem2) return problem2;
      } else if (entry.isFile()) {
        if (Object.keys(files).length >= LIMITS.files)
          return `\u6587\u4EF6\u8D85\u8FC7 ${LIMITS.files} \u4E2A`;
        const size = lstatSync(full).size;
        bytes += size;
        if (bytes > LIMITS.bytes) return `\u5408\u8BA1\u8D85\u8FC7 ${LIMITS.bytes / 1024} KB`;
        files[rel] = readFileSync(full, "utf8");
      }
    }
    return void 0;
  };
  const problem = walk(root, "", 1);
  return problem ? { problem } : { files };
}

// server/skills/remote.ts
var SKILLS_SLOT = "<!-- atrium:skills -->";
function fillSkillSlot(prompt, fill) {
  if (!prompt.includes(SKILLS_SLOT)) return prompt;
  const text = !fill ? "" : "section" in fill ? fill.section : `\u8FD9\u6B21\u539F\u672C\u8981\u5E26\u7684\u7EC4\u7EC7\u6280\u80FD\u6CA1\u6302\u4E0A\uFF08${fill.error}\uFF09\uFF0C\u6309\u4EFB\u52A1\u8BE6\u8FF0\u4E0E\u5C97\u4F4D\u8BF4\u660E\u5E72\u6D3B\u3002`;
  return prompt.replace(SKILLS_SLOT, () => text);
}
var positive = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function skillCopiesRefusal(skills) {
  if (skills === void 0) return null;
  if (!Array.isArray(skills)) return "\u6280\u80FD\u6E05\u5355\u4E0D\u5408\u6CD5";
  if (skills.length > LIMITS.perTask) return `\u6280\u80FD\u8D85\u8FC7 ${LIMITS.perTask} \u4E2A`;
  const seen = /* @__PURE__ */ new Set();
  for (const skill of skills) {
    if (typeof skill !== "object" || skill === null) return "\u6280\u80FD\u6E05\u5355\u4E0D\u5408\u6CD5";
    if (typeof skill.slug !== "string" || skill.slug.length > 64 || !SLUG_RE.test(skill.slug))
      return `\u6280\u80FD\u540D\u4E0D\u5408\u6CD5\uFF1A${String(skill.slug).slice(0, 64)}`;
    if (seen.has(skill.slug)) return `\u6280\u80FD ${skill.slug} \u91CD\u590D`;
    seen.add(skill.slug);
    if (!positive(skill.id) || !positive(skill.rev))
      return `\u6280\u80FD ${skill.slug} \u7684\u7F16\u53F7\u6216\u4FEE\u8BA2\u53F7\u4E0D\u5408\u6CD5`;
    if (typeof skill.description !== "string" || typeof skill.via !== "string")
      return `\u6280\u80FD ${skill.slug} \u7F3A\u5C11\u7B80\u4ECB\u6216\u6765\u6E90`;
    try {
      validateFiles(skill.files);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return `\u6280\u80FD ${skill.slug} \u7684\u6587\u4EF6\u4E0D\u5408\u6CD5\uFF1A${error.message}`;
    }
  }
  return null;
}
function skillReport(dir) {
  const manifest = readManifest(dir);
  if (!manifest?.skills.length) return void 0;
  const edits = [];
  for (const entry of manifest.skills) {
    const read = readMounted(entry.dir);
    const head = { id: entry.id, slug: entry.slug, rev: entry.rev };
    if ("problem" in read) edits.push({ ...head, problem: read.problem });
    else if (!entry.sha || filesHash(read.files) !== entry.sha)
      edits.push({ ...head, files: read.files });
  }
  let notes;
  try {
    notes = Array.from(readFileSync2(join2(dir, NOTES), "utf8").trim()).slice(0, LIMITS.proposalReason).join("");
  } catch {
  }
  if (!edits.length) return void 0;
  return { edits, ...notes ? { notes } : {} };
}

// server/tasks/watchdog.ts
var STEP_CHUNK = 1024 * 1024;

// server/tasks/spawn.ts
import {
  appendFileSync,
  closeSync,
  existsSync as existsSync2,
  openSync,
  readFileSync as readFileSync3,
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
  if (!append && existsSync2(logFile))
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
  const out = openSync(logFile, "a");
  const piped = launch.input === "stream-json";
  const input = launch.stdin && !piped ? openSync(launch.stdin, "r") : piped ? "pipe" : "ignore";
  let child;
  try {
    child = spawnInvocation(invocation, {
      cwd: launch.cwd,
      env: childEnv,
      detached: true,
      stdio: [input, out, out]
    });
  } finally {
    closeSync(out);
    if (typeof input === "number") closeSync(input);
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
          readFileSync3(launch.stdin, "utf8"),
          void 0,
          launch.inputDialect
        )
      );
    child.stdin.unref?.();
  }
  child.unref();
  return { child, offset };
}

// server/tasks/recovery.ts
async function ownsPid(pid, tool, exec2) {
  if (!processAlive(pid)) return false;
  const call = commandLineInvocation(process.platform, pid);
  const ps = await exec2(call.command, call.args, { timeoutMs: 1e4 });
  return ps.ok && ps.stdout.includes(ADAPTERS[tool].executable);
}

// server/tasks/leftovers.ts
var LEFTOVER_MS = 24 * 60 * 6e4;
var LEFTOVER_LIMIT = 50;
var START_SLACK_MS = 5e3;
var escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function runsTool(platform, command, executable) {
  if (!executable) return false;
  const pattern = new RegExp(
    `(?:^|[\\s"'/\\\\@])${escapeRegExp(executable)}(?=$|[\\s"'/\\\\.-])`,
    platform === "win32" ? "i" : ""
  );
  return pattern.test(command);
}
function leftoverMatch(targets, probe, platform, slackMs = START_SLACK_MS) {
  if (!probe || probe.start === null) return null;
  const start = probe.start;
  for (const target of targets)
    if (start >= target.created - slackMs && start <= target.ended + slackMs && runsTool(platform, probe.command, ADAPTERS[target.tool].executable))
      return target;
  return null;
}
function shiftTargets(targets, by) {
  return targets.map((target) => ({
    ...target,
    created: target.created + by,
    ended: target.ended + by
  }));
}
function targetsRefusal(targets) {
  if (!Array.isArray(targets)) return "\u6E05\u7406\u6E05\u5355\u5E94\u4E3A\u6570\u7EC4";
  if (targets.length > LEFTOVER_LIMIT)
    return `\u6E05\u7406\u6E05\u5355\u6700\u591A ${LEFTOVER_LIMIT} \u6761`;
  for (const target of targets) {
    if (typeof target !== "object" || target === null) return "\u6E05\u7406\u6761\u76EE\u4E0D\u5408\u6CD5";
    if (!Number.isSafeInteger(target.task) || target.task < 1)
      return "\u4EFB\u52A1\u53F7\u4E0D\u5408\u6CD5";
    if (!Number.isSafeInteger(target.pid) || target.pid <= 1)
      return "\u8FDB\u7A0B\u53F7\u4E0D\u5408\u6CD5";
    if (!isTool(target.tool))
      return `\u4E0D\u8BA4\u8BC6\u7684\u6267\u884C\u8005\u5DE5\u5177\uFF1A${String(target.tool)}`;
    if (!Number.isFinite(target.created) || !Number.isFinite(target.ended) || target.ended < target.created)
      return "\u4EFB\u52A1\u65F6\u523B\u4E0D\u5408\u6CD5";
  }
  return null;
}
var killLine = (kill) => `t${kill.task} pid ${kill.pid} ${kill.tool}`;

// server/tasks/leftovers-reap.ts
async function reapLeftovers(targets, deps) {
  const platform = deps.platform ?? process.platform;
  const alive = deps.alive ?? processAlive;
  const kill = deps.kill ?? ((pid) => killTree(pid, "SIGKILL"));
  const now = deps.now ?? Date.now;
  const self = deps.self ?? process.pid;
  const byPid = /* @__PURE__ */ new Map();
  for (const target of targets) {
    const list = byPid.get(target.pid);
    if (list) list.push(target);
    else byPid.set(target.pid, [target]);
  }
  const killed = [];
  for (const [pid, list] of byPid) {
    if (pid === self || !alive(pid)) continue;
    const call = processProbeInvocation(platform, pid);
    const read = await deps.exec(call.command, call.args, {
      timeoutMs: 1e4
    });
    if (!read.ok) continue;
    const target = leftoverMatch(
      list,
      parseProcessProbe(platform, read.stdout, now()),
      platform
    );
    if (!target) continue;
    try {
      kill(pid);
    } catch {
      continue;
    }
    killed.push({ task: target.task, pid, tool: target.tool });
  }
  return killed;
}

// server/hosts/info.ts
import { existsSync as existsSync3 } from "node:fs";
import { availableParallelism, homedir, hostname, totalmem } from "node:os";
import { join as join3 } from "node:path";
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
        (relative) => existsSync3(join3(home, relative))
      )
    };
  }
  return clis;
}
function machineInfo(input) {
  const cores = availableParallelism();
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
    skills: true
  };
}

// server/hosts/protocol.ts
var LOG_CHUNK = 256 * 1024;
var POLL_WAIT_MS = 25e3;

// server/quota-readers/index.ts
import { readFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";

// server/quota-readers/credentials.ts
import { createHash as createHash2 } from "node:crypto";
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
  return createHash2("sha256").update(`${provider}:${id}`).digest("hex").slice(0, 16);
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
import { createHash as createHash3 } from "node:crypto";
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
  const hash = createHash3("sha256").update(configDir.replace(/\\/g, "/")).digest("hex");
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash.slice(0, 8)}`;
}
function claudeSources(platform, home, env) {
  const path2 = pathFor(platform);
  const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const dirs = configDir ? [expandHome(configDir, home, platform)] : platform === "linux" ? [
    path2.join(home, ".claude"),
    path2.join(
      nonEmpty(env.XDG_CONFIG_HOME) ?? path2.join(home, ".config"),
      "claude"
    )
  ] : [path2.join(home, ".claude")];
  const files = dirs.map((dir) => ({
    kind: "file",
    path: path2.join(dir, ".credentials.json")
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
  const path2 = pathFor(platform);
  const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return configDir ? path2.join(expandHome(configDir, home, platform), ".claude.json") : path2.join(home, ".claude.json");
}
function codexSources(platform, home, env) {
  const path2 = pathFor(platform);
  const codexHome = nonEmpty(env.CODEX_HOME);
  if (codexHome)
    return [
      {
        kind: "file",
        path: path2.join(expandHome(codexHome, home, platform), "auth.json")
      }
    ];
  return [
    { kind: "file", path: path2.join(home, ".config", "codex", "auth.json") },
    { kind: "file", path: path2.join(home, ".codex", "auth.json") }
  ];
}
function opencodeSources(platform, home, env) {
  const path2 = pathFor(platform);
  const configured = nonEmpty(env.OPENCODE_DATA_DIR);
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  const dir = configured ? expandHome(configured, home, platform) : xdg ? path2.join(expandHome(xdg, home, platform), "opencode") : path2.join(home, ".local", "share", "opencode");
  return [{ kind: "file", path: path2.join(dir, "auth.json") }];
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
var WINDOWS = [
  ["rolling", "session", "Session", 5 * 60 * 60],
  ["weekly", "weekly", "Weekly", 7 * 24 * 60 * 60],
  ["monthly", "monthly", "Monthly", 0]
];
function mapOpencodeUsage(body) {
  const usage2 = isObject(body) && isObject(body.usage) ? body.usage : void 0;
  if (!usage2) return void 0;
  const windows = [];
  for (const [key, id, label, periodSeconds] of WINDOWS) {
    const value = usage2[key];
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
async function readTextFile(path2) {
  try {
    return await readFile(path2, "utf8");
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
  return runFile(SECURITY, args, {
    timeout: KEYCHAIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { PATH: env.PATH, HOME: env.HOME, USER: env.USER }
  }).then(({ error, stdout }) => {
    if (!error) return stdout.trim() || void 0;
    if (error.code === ITEM_NOT_FOUND) return void 0;
    throw new Error("\u94A5\u5319\u4E32\u8BFB\u53D6\u5931\u8D25");
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

// server/agent/launch.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync3, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join4 } from "node:path";

// server/tasks/workspace.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "node:fs";

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

// server/tasks/prepare.ts
var DEFAULT_RULES = [
  "\u53EA\u5728\u7ED9\u5B9A\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u4EFB\u52A1 worktree\uFF09\u5185\u6539\u52A8\uFF0C\u4E0D\u8981\u5207\u6362\u5230\u5176\u4ED6\u5206\u652F\u6216\u76EE\u5F55\u5E72\u6D3B\u3002",
  "\u4E0D\u8981\u4F7F\u7528 git stash\uFF1B\u672A\u5B8C\u6210\u7684\u6539\u52A8\u63D0\u4EA4\u5230\u5F53\u524D\u5206\u652F\u3002",
  "\u505A\u5B8C\u540E\u4F9D\u6B21\uFF1A\u63D0\u4EA4\u3001\u63A8\u9001\u3001\u5F00 PR\uFF08\u6B63\u6587\u5199 Refs \u5BF9\u5E94 issue\uFF09\uFF1B\u4EFB\u4F55\u4E00\u6B65\u505A\u4E0D\u4E86\uFF0C\u5199\u6E05\u695A\u5361\u5728\u54EA\u4E00\u6B65\u518D\u7ED3\u675F\u3002\u5168\u91CF\u68C0\u67E5\u7531\u8FD0\u884C\u65F6\u5728\u4EFB\u52A1 worktree \u8DD1\u3002",
  "\u6C47\u62A5\u91CC\u7684 PR \u53F7\u3001\u63D0\u4EA4\u53F7\u3001CI \u7ED3\u679C\u5FC5\u987B\u6765\u81EA\u4F60\u521A\u6267\u884C\u8FC7\u7684\u547D\u4EE4\u8F93\u51FA\uFF1B\u6CA1\u505A\u7684\u6B65\u9AA4\u76F4\u63A5\u5199\u300C\u6CA1\u505A\u300D\u3002",
  "\u6587\u6863\u3001\u63D0\u4EA4\u8BF4\u660E\u548C PR \u4F7F\u7528\u4E2D\u6587\u3002",
  "\u4EA4\u4ED8\u524D\u505A\u7AEF\u5230\u7AEF\u9A8C\u8BC1\uFF1A\u5728\u9694\u79BB\u73AF\u5883\u91CC\uFF08\u4E34\u65F6\u6570\u636E\u76EE\u5F55\u3001\u53E6\u4E00\u4E2A\u7AEF\u53E3\uFF0C\u5982 `ATRIUM_PORT=<\u7A7A\u95F2\u7AEF\u53E3> ATRIUM_DATA=<\u4E34\u65F6\u76EE\u5F55> node bin/atrium.mjs \u2026`\uFF0C\u7528\u5B8C\u540C\u53D8\u91CF stop\uFF09\u5B9E\u8DD1\u4E00\u4E24\u6761\u80FD\u8BC1\u660E\u8FD9\u6B21\u6539\u52A8\u751F\u6548\u7684\u547D\u4EE4\uFF0C\u628A\u547D\u4EE4\u4E0E\u8F93\u51FA\u539F\u6837\u8D34\u8FDB PR \u6B63\u6587\u300C## \u7AEF\u5230\u7AEF\u9A8C\u8BC1\u300D\u4E00\u8282\uFF1B\u5408\u5165\u524D\u7684\u5BA1\u9605\u4F1A\u6838\u5BF9\u3002\u4E0D\u78B0\u7528\u6237\u5728\u7528\u7684\u670D\u52A1\u3001\u6570\u636E\u4E0E\u7535\u8111\u3002",
  "PR \u6B63\u6587\u5199\u300C## \u78B0\u5230\u54EA\u4E9B\u5DF2\u6709\u80FD\u529B\u300D\u4E00\u8282\uFF1A\u5217\u51FA\u672C\u6B21\u6539\u52A8\u4E0E\u54EA\u4E9B\u5DF2\u6709\u80FD\u529B\u4EA4\u53C9\uFF08\u8FDC\u7A0B\u4E3B\u673A\u3001Windows\u3001\u603B\u4EFB\u52A1\u3001\u6280\u80FD\u6302\u8F7D\u3001\u5408\u5165\u961F\u5217\u3001\u81EA\u5347\u7EA7\u2026\u2026\uFF09\uFF0C\u5404\u9A8C\u4E86\u4EC0\u4E48\uFF1B\u6CA1\u78B0\u5230\u5199\u300C\u65E0\u300D\u3002\u95EE\u9898\u591A\u51FA\u5728\u65B0\u65E7\u80FD\u529B\u7684\u7EC4\u5408\u4E0A\uFF0C\u5199\u6E05\u695A\u597D\u8BA9\u8BD5\u70B9\u6311\u5BF9\u5730\u65B9\u3002",
  "\u6BCF\u505A\u4E00\u6BB5\u8F83\u957F\u7684\u5DE5\u4F5C\u524D\uFF0C\u5148\u7528\u4E00\u53E5\u4E2D\u6587\u8BF4\u660E\u6B63\u5728\u505A\u4EC0\u4E48\uFF08\u5982\u300C\u6B63\u5728\u8865\u5355\u6D4B\u300D\uFF09\uFF0C\u770B\u677F\u4F1A\u628A\u8FD9\u53E5\u663E\u793A\u4E3A\u4F60\u7684\u6700\u8FD1\u52A8\u4F5C\u3002",
  "gh \u547D\u4EE4\u4E00\u5F8B\u5E26 `-R <owner/repo>`\uFF08\u53D6\u81EA origin \u8FDC\u7AEF\uFF09\uFF1Afork \u4ED3\u5E93\u53E6\u6709 upstream \u65F6\uFF0C\u4E0D\u5E26 -R \u4F1A\u67E5\u5230\u6216\u5F00\u5230\u4E0A\u6E38\uFF1BPR \u5F00\u5728 origin \u4E0A\u3002"
];

// server/tasks/workspace.ts
var RUN_RULES = [
  ...DEFAULT_RULES,
  "\u4E0D\u8981\u81EA\u5DF1\u8DD1\u5168\u91CF\u6D4B\u8BD5\uFF08\u5982 `npm run check`\uFF09\uFF0C\u5168\u91CF\u53EA\u7531\u8FD0\u884C\u65F6\u8DD1\uFF1B\u5F00\u53D1\u4E2D\u548C\u4EA4\u4ED8\u524D\u53EA\u8DD1\u7C7B\u578B\u68C0\u67E5\u4E0E\u6539\u52A8\u76F8\u5173\u7684\u6D4B\u8BD5\u6587\u4EF6\u3002\u6D4B\u8BD5\u5E76\u53D1\u7167\u73AF\u5883\u53D8\u91CF ATRIUM_TEST_CONCURRENCY\uFF08\u8FD0\u884C\u65F6\u6309\u672C\u673A\u6838\u6570\u7ED9\u7684\u4E0A\u9650\uFF09\uFF0C\u4E0D\u8981\u8C03\u5927\u3001\u4E0D\u8981\u6362\u6210\u4E0D\u9650\u3002",
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
  if (existsSync5(join4(clone, ".git")) || existsSync5(join4(clone, "HEAD")))
    return;
  mkdirSync3(dirname2(clone), { recursive: true, mode: 448 });
  const cloned = await run("git", ["clone", "--quiet", url, clone], {
    timeoutMs: 10 * 6e4
  });
  if (!cloned.ok)
    throw new Error(
      `\u514B\u9686 ${url} \u5931\u8D25\uFF1A${firstLine(cloned.stderr) || "git \u5931\u8D25"}`
    );
}
function cloneLock() {
  const tails = /* @__PURE__ */ new Map();
  return (clone, work) => {
    const next = (tails.get(clone) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => void 0);
    tails.set(clone, settled);
    void settled.then(() => {
      if (tails.get(clone) === settled) tails.delete(clone);
    });
    return next;
  };
}
async function launchAssignment(assignment, ctx) {
  const adapter = ADAPTERS[assignment.tool];
  mkdirSync3(assignment.dir, { recursive: true, mode: 448 });
  if (assignment.repo) {
    const { url, clone, worktree, branch, base } = assignment.repo;
    const withClone = ctx.withClone ?? ((_clone, work) => work());
    await withClone(clone, async () => {
      await ensureClone(url, clone, ctx.run);
      await ensureWorktree(
        clone,
        { path: worktree, branch, slug: "" },
        base,
        ctx.run
      );
    });
  } else mkdirSync3(assignment.cwd, { recursive: true });
  let mount;
  let skills;
  if (assignment.skills?.length) {
    try {
      mount = mountSkills(
        assignment.dir,
        assignment.tool,
        assignment.skills,
        ctx.env.HOME || homedir3()
      );
      skills = {
        mounted: (mount?.skills ?? []).map((s) => `${s.slug}@r${s.rev}`)
      };
    } catch (error) {
      skills = {
        mounted: [],
        error: `\u6302\u6280\u80FD\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  const prompt = fillSkillSlot(
    assignment.prompt,
    mount ? { section: mount.section } : skills?.error ? { error: skills.error } : void 0
  );
  const promptFile = join4(assignment.dir, "prompt.md");
  writeFileSync4(promptFile, prompt, { mode: 384 });
  const resultFile = join4(assignment.dir, "last-message.md");
  const launch = buildLaunch(
    adapter,
    {
      promptFile,
      prompt,
      cwd: assignment.cwd,
      model: assignment.model,
      effort: assignment.effort,
      resultFile,
      live: false,
      ...assignment.endpoint ? { endpoint: assignment.endpoint } : {}
    },
    assignment.resume ? { ...assignment.resume, file: join4(assignment.dir, "tell.md") } : void 0
  );
  if (mount) {
    launch.args.push(...mount.args);
    if (Object.keys(mount.env).length)
      launch.env = { ...launch.env, ...mount.env };
  }
  const logFile = join4(assignment.dir, "log");
  const append = !!assignment.resume;
  const offset = append && existsSync5(logFile) ? statSync2(logFile).size : 0;
  const { child } = await spawnWorker(
    { launch, logFile, worker: { id: assignment.worker } },
    withSecrets(workerEnvironment(ctx.env), assignment.secrets),
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
    },
    ...skills ? { skills } : {}
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
      const path2 = list[index + 1];
      if (!path2 || !(insideData(os, dataDir, path2) || same(os, dataDir, path2)))
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
    (path2) => path2 !== void 0
  );
  if (paths.some(
    (path2) => typeof path2 !== "string" || !insideData(os, dataDir, path2)
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
  if (a.secrets !== void 0) {
    if (typeof a.secrets !== "object" || a.secrets === null || Array.isArray(a.secrets))
      return "\u51ED\u636E\u4E0D\u5408\u6CD5";
    for (const [name, value] of Object.entries(a.secrets)) {
      const problem = secretNameProblem(name);
      if (problem) return `\u51ED\u636E\u540D\u79F0\u4E0D\u5408\u6CD5\uFF1A${problem}`;
      if (typeof value !== "string" || !value || value.includes("\0"))
        return `\u51ED\u636E ${name} \u7684\u503C\u4E0D\u5408\u6CD5`;
    }
  }
  return skillCopiesRefusal(a.skills);
}
function commandRefusal(command, os, dataDir) {
  switch (command.kind) {
    case "launch":
      return assignmentRefusal(command.assignment, os, dataDir);
    case "exec":
      return gitRefusal(command.args, os, dataDir);
    case "stop":
      return command.signal === "SIGTERM" || command.signal === "SIGKILL" ? null : "\u4E0D\u8BA4\u8BC6\u7684\u4FE1\u53F7";
    case "clean":
      return Number.isFinite(command.now) ? targetsRefusal(command.targets) : "\u4E0B\u53D1\u65F6\u523B\u4E0D\u5408\u6CD5";
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
    this.quota = options.quota !== void 0 ? options.quota : readersEnabled(options.env) && readersEnabled(process.env) ? new QuotaReaders(defaultReaderDeps(options.env)) : null;
  }
  options;
  state;
  config;
  runs = /* @__PURE__ */ new Map();
  /** 正在做（含回执还没送到）的指令：长轮询时告诉服务别重发。 */
  busy = /* @__PURE__ */ new Set();
  abort = new AbortController();
  /** 同一克隆上的 git 操作（派活的克隆与 fetch）排成一串。 */
  withClone = cloneLock();
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
  async call(path2, body, timeoutMs) {
    const token = path2 === "join" ? this.options.code : this.token;
    const response = await (this.options.fetch ?? fetch)(
      `${this.server}/api/agent/${path2}`,
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
      limits: hostLimits(this.options.env, availableParallelism2()).limits
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
  /**
   * 带接入码时先换成主机令牌（已用同一台的令牌接入过就跳过），返回这台的短号；
   * 没接入过又没给接入码时拒绝。装成系统服务（t183）时先在前台做完这一步，服务里不带接入码。
   */
  async enroll() {
    if (this.options.code && (!this.token || !this.config?.host || !this.options.code.startsWith(`${this.config.host}-`)))
      await this.join();
    if (!this.token || !this.config)
      throw new Problem(
        400,
        `\u8FD9\u53F0\u673A\u5668\u8FD8\u6CA1\u63A5\u5165 ${this.server}\uFF1A\u5728\u670D\u52A1\u90A3\u53F0\u673A\u5668\u4E0A\u8FD0\u884C atrium host add \u540D\u79F0\uFF0C\u62FF\u5230\u63A5\u5165\u7801\u540E atrium agent --server ${this.server} --token \u63A5\u5165\u7801`,
        "usage"
      );
    return this.config.host;
  }
  /** 跑到 stop() 或令牌失效为止。 */
  async start() {
    await this.enroll();
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
    let lastFailure = null;
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
        lastFailure = null;
        void this.tick();
        void this.reportQuota();
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
        const why = `${this.connected ? "\u4E0E\u670D\u52A1\u65AD\u5F00" : "\u8FDE\u4E0D\u4E0A\u670D\u52A1"}\uFF1A${reason(error)}`;
        if (why !== lastFailure)
          this.log(
            `${why}\uFF1B${Math.round(wait / 1e3)} \u79D2\u540E\u91CD\u8FDE\uFF08\u539F\u56E0\u4E0D\u53D8\u65F6\u4E0D\u518D\u91CD\u590D\u8BB0\uFF09`
          );
        lastFailure = why;
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
          case "clean":
            result = await this.clean(command);
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
  /**
   * 清残留执行者进程（t217 `host clean`）：服务给的是所属任务已结束的执行者；时刻按下发时的时钟平移成这台的，
   * 核对还活着、启动时刻与命令行对得上才整树结束。
   */
  async clean(command) {
    const killed = await reapLeftovers(
      shiftTargets(command.targets, Date.now() - command.now),
      { exec: this.exec }
    );
    for (const kill of killed) this.log(`\u6E05\u7406\u6B8B\u7559\u8FDB\u7A0B\uFF1A${killLine(kill)}`);
    return { killed };
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
        run: this.exec,
        withClone: this.withClone
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
      if (launched.skills?.error)
        this.log(`${assignment.ref} ${launched.skills.error}`);
      return {
        ok: true,
        pid: launched.pid,
        offset: launched.offset,
        launch: launched.launch,
        ...launched.skills ? { skills: launched.skills } : {}
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
      const fd = openSync2(record.logFile, "r");
      let read = 0;
      try {
        read = readSync(fd, buffer, 0, chunk.length, chunk.offset);
      } finally {
        closeSync2(fd);
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
      return readFileSync4(record.resultFile, "utf8").slice(0, 512 * 1024);
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
    let skills;
    try {
      skills = skillReport(dirname3(record.logFile));
    } catch (error) {
      this.log(`${record.ref} \u7684\u6280\u80FD\u526F\u672C\u6CA1\u8BFB\u51FA\u6765\uFF1A${reason(error)}`);
    }
    const answer = await this.call(
      "exit",
      {
        task: record.task,
        run: record.run,
        exit: record.exit ?? null,
        size,
        ...message !== void 0 ? { last_message: message } : {},
        ...skills ? { skills } : {}
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

export {
  AgentHttpError,
  normalizeServer,
  Agent
};
