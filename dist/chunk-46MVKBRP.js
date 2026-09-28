import {
  afterUninstallSteps,
  agentAlive,
  installSteps,
  lingerOn,
  lingerQuery,
  parseStatus,
  serviceDefinitionFiles,
  serviceLayout,
  servicePlatform,
  statusQuery,
  uninstallSteps
} from "./chunk-5AIA4NLG.js";
import "./chunk-S6DRYDR2.js";
import {
  AgentState
} from "./chunk-OYU4IKQ6.js";
import "./chunk-KBI6MJJE.js";
import "./chunk-BYXBJQAS.js";
import "./chunk-X2M4GQZ5.js";
import {
  packageRoot
} from "./chunk-NWLFCMFK.js";
import {
  Problem,
  processAlive,
  restrictToOwner,
  runCommand
} from "./chunk-XWXBA3CJ.js";
import "./chunk-AOP4HR6R.js";

// server/agent/service.ts
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
function resolve(data, deps) {
  const platform = servicePlatform(deps.platform ?? process.platform);
  if (!platform)
    throw new Problem(
      400,
      `\u8FD9\u4E2A\u7CFB\u7EDF\uFF08${deps.platform ?? process.platform}\uFF09\u8FD8\u4E0D\u652F\u6301\u88C5\u6210\u7CFB\u7EDF\u670D\u52A1\uFF1B\u524D\u53F0\u8FD0\u884C atrium agent`,
      "unsupported"
    );
  const env = deps.env ?? process.env;
  const user = deps.user ?? env.USER ?? userInfo().username;
  const layout = serviceLayout({
    platform,
    node: deps.node ?? process.execPath,
    script: deps.script ?? join(packageRoot, "bin", "atrium.mjs"),
    data,
    home: deps.home ?? env.HOME ?? homedir(),
    env,
    uid: deps.uid ?? process.getuid?.(),
    user
  });
  if ("error" in layout) throw new Problem(400, layout.error, "unsupported");
  return { layout, env, user, retryMs: deps.retryMs ?? 1e3 };
}
async function run(env, command, args) {
  const result = await runCommand(command, args, {
    env,
    timeout: 6e4,
    maxBuffer: 1024 * 1024
  });
  return {
    ok: !result.error,
    stdout: result.stdout,
    stderr: result.stderr || (result.error?.message ?? "")
  };
}
var sameFile = (file) => {
  try {
    return readFileSync(file.path).equals(fileBytes(file));
  } catch {
    return false;
  }
};
var fileBytes = (file) => file.encoding === "utf16le" ? Buffer.from(`\uFEFF${file.content}`, "utf16le") : Buffer.from(file.content, "utf8");
function writeServiceFile(file) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, fileBytes(file), {
    mode: file.secret ? 384 : 420
  });
  if (file.secret) restrictToOwner(file.path);
}
async function query(resolved, data) {
  const { layout, env } = resolved;
  const call = statusQuery(layout);
  const state = parseStatus(
    layout.platform,
    await run(env, call.command, call.args)
  );
  if (state.running === null) {
    const record = new AgentState(data).pid();
    const alive = record?.service === true && processAlive(record.pid);
    state.running = alive;
    state.pid = alive ? record.pid : null;
  }
  let linger = null;
  if (layout.platform === "linux") {
    const call2 = lingerQuery(resolved.user);
    linger = lingerOn(await run(env, call2.command, call2.args));
  }
  return { ...state, linger };
}
async function stopAgent(data) {
  const record = new AgentState(data).pid();
  if (!record?.service || !await agentAlive(record)) return;
  try {
    process.kill(record.pid);
  } catch {
  }
  for (let i = 0; i < 50 && processAlive(record.pid); i++)
    await new Promise((resolve2) => setTimeout(resolve2, 100));
}
async function perform(resolved, data, steps) {
  for (const step of steps) {
    if (step.kind === "stop-agent") {
      await stopAgent(data);
      continue;
    }
    let result = await run(resolved.env, step.command, step.args);
    for (let attempt = 0; !result.ok && attempt < (step.retries ?? 0); attempt++) {
      await new Promise((resolve2) => setTimeout(resolve2, resolved.retryMs));
      result = await run(resolved.env, step.command, step.args);
    }
    if (!result.ok && !step.allowFail)
      throw new Problem(
        500,
        `${step.command} ${step.args.join(" ")} \u5931\u8D25\uFF1A${(result.stderr || result.stdout).trim().slice(0, 500) || "\u6CA1\u6709\u8F93\u51FA"}`,
        "service_failed"
      );
  }
}
async function installService(data, deps = {}) {
  const resolved = resolve(data, deps);
  const { layout } = resolved;
  const before = await query(resolved, data);
  const unchanged = before.installed && before.running === true && layout.files.every(sameFile);
  if (!unchanged) {
    for (const file of layout.files) writeServiceFile(file);
    await perform(resolved, data, installSteps(layout, before));
  }
  let linger = before.linger;
  let lingerHint = null;
  if (layout.platform === "linux" && !linger) {
    const enabled = await run(resolved.env, "loginctl", [
      "enable-linger",
      resolved.user
    ]);
    const call = lingerQuery(resolved.user);
    linger = enabled.ok && lingerOn(await run(resolved.env, call.command, call.args));
    if (!linger) lingerHint = `sudo loginctl enable-linger ${resolved.user}`;
  }
  const after = unchanged ? before : await settle(resolved, data);
  const record = new AgentState(data).pid();
  const foreground = record && !record.service && await agentAlive(record) ? record.pid : null;
  return {
    platform: layout.platform,
    name: layout.name,
    unchanged,
    running: after.running === true,
    pid: after.pid,
    linger,
    lingerHint,
    log: layout.log,
    locations: layout.locations,
    foreground
  };
}
async function settle(resolved, data) {
  let state = await query(resolved, data);
  for (let i = 0; i < 6 && state.running !== true; i++) {
    await new Promise((resolve2) => setTimeout(resolve2, resolved.retryMs / 2));
    state = await query(resolved, data);
  }
  return state;
}
async function uninstallService(data, deps = {}) {
  const resolved = resolve(data, deps);
  const { layout } = resolved;
  const before = await query(resolved, data);
  const files = serviceDefinitionFiles(layout).filter(
    (file) => existsSync(file.path)
  );
  if (!before.installed && !files.length)
    return {
      platform: layout.platform,
      name: layout.name,
      absent: true,
      removed: []
    };
  await perform(resolved, data, uninstallSteps(layout));
  for (const file of files) rmSync(file.path, { force: true });
  await perform(resolved, data, afterUninstallSteps(layout));
  return {
    platform: layout.platform,
    name: layout.name,
    absent: false,
    removed: files.map((file) => file.path)
  };
}
function tail(file, lines) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const length = Math.min(size, 16 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).slice(-lines);
}
async function serviceStatus(data, deps = {}) {
  const resolved = resolve(data, deps);
  const { layout } = resolved;
  const state = await query(resolved, data);
  const agent = new AgentState(data);
  const config = agent.config();
  const record = agent.pid();
  return {
    platform: layout.platform,
    name: layout.name,
    installed: state.installed,
    running: state.running === true,
    pid: state.pid,
    enabled: state.enabled,
    linger: state.linger,
    // 只比服务定义：环境随终端不同，换个终端看状态不算过时。
    stale: state.installed && !serviceDefinitionFiles(layout).every(sameFile),
    server: config?.server ?? null,
    host: config?.host ?? null,
    foreground: record && !record.service && await agentAlive(record) ? record.pid : null,
    log: layout.log,
    tail: tail(layout.log, 8)
  };
}
export {
  installService,
  serviceStatus,
  uninstallService
};
