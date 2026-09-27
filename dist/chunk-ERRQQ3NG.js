import {
  Problem
} from "./chunk-CWV2D2IH.js";
import {
  alive,
  currentVersion,
  legacyDataNotice,
  packageRoot,
  readService,
  servicePort,
  serviceUrl
} from "./chunk-KAKZC3TG.js";

// server/service.ts
import { spawn as spawn2 } from "node:child_process";
import {
  closeSync as closeSync2,
  existsSync as existsSync3,
  fstatSync,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readSync,
  statSync
} from "node:fs";
import { join as join3 } from "node:path";
import { setTimeout as delay2 } from "node:timers/promises";

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
function allowed(key) {
  return SYSTEM.has(key) || NETWORK.has(key) || ISOLATION.has(key) || key.startsWith("ATRIUM_") || key.startsWith("LC_");
}
function droppedSensitiveNames(keys) {
  return [...keys].filter(
    (key) => /^(ANTHROPIC|CLAUDE|OPENAI|GH|GITHUB|HERDR|PI)_/.test(key) || /_(API_KEY|TOKEN)$/.test(key) || key === "SSH_AUTH_SOCK"
  ).sort();
}
function serviceEnvironment(base = process.env) {
  const env = {};
  const keys = Object.keys(base);
  for (const key of keys) {
    const value = base[key];
    if (value !== void 0 && allowed(key)) env[key] = value;
  }
  const kept = new Set(Object.keys(env));
  return {
    env,
    droppedSensitive: droppedSensitiveNames(keys.filter((k) => !kept.has(k)))
  };
}
function reportDroppedIdentity(names) {
  if (!names.length) return;
  console.error(
    `\u5DF2\u5FFD\u7565\u8EAB\u4EFD/\u51ED\u636E\u73AF\u5883\u53D8\u91CF\uFF1A${names.join(", ")}\uFF1B\u670D\u52A1\u4E0E\u6267\u884C\u8005\u4E0D\u7EE7\u627F\u8FD9\u4E9B\u53D8\u91CF\u3002`
  );
}

// server/entry.ts
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
function useDist({ dist, git, forced }) {
  return dist && (forced || !git);
}
function serviceArgs(entry, root = packageRoot) {
  if (entry === void 0) {
    const dist = join(root, "dist", "server.js");
    if (useDist({
      dist: existsSync(dist),
      git: existsSync(join(root, ".git")),
      forced: process.env.ATRIUM_DIST === "1"
    }))
      return [dist];
  }
  return [
    "--import",
    import.meta.resolve("tsx"),
    resolve(root, entry ?? "server/main.ts")
  ];
}

// server/supervisor.ts
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync as existsSync2,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync
} from "node:fs";
import { join as join2 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
var { request: httpRequest } = process.getBuiltinModule(
  "node:http"
);
function restartStatePath(data) {
  return join2(data, "restart-state.json");
}
function readRestartState(data) {
  const path = restartStatePath(data);
  if (!existsSync2(path)) return null;
  try {
    const state = JSON.parse(
      readFileSync(path, "utf8")
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
      renameSync(path, preserved);
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
  mkdirSync(data, { recursive: true, mode: 448 });
  const path = restartStatePath(data);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 384,
      flag: "wx"
    });
    renameSync(temp, path);
  } finally {
    if (existsSync2(temp)) unlinkSync(temp);
  }
}
async function startSupervisor(options) {
  const data = options.data;
  const previous = readRestartState(data);
  const taskId = `rst-${Date.now()}`;
  const pendingPath = join2(data, "pending-update.json");
  const pending = existsSync2(pendingPath) ? JSON.parse(readFileSync(pendingPath, "utf8")) : null;
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
  const supervisorScript = join2(packageRoot, "bin/restart-supervisor.mjs");
  const { env, droppedSensitive } = serviceEnvironment(process.env);
  reportDroppedIdentity(droppedSensitive);
  const logPath = join2(data, "supervisor.log");
  mkdirSync(data, { recursive: true, mode: 448 });
  const log = openSync(logPath, "a", 384);
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
  const child = spawn(process.execPath, args, {
    cwd: data,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: {
      ...env,
      ATRIUM_DATA: data
    }
  });
  closeSync(log);
  child.unref();
  initialState.supervisorPid = child.pid;
  writeRestartState(data, initialState);
  return { pid: child.pid, taskId };
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
    await delay(100);
  }
  const state = readRestartState(data);
  throw new Problem(
    504,
    `\u7B49\u5F85\u5E73\u6ED1\u91CD\u542F\u8D85\u65F6\uFF08\u5F53\u524D\uFF1A${state?.status ?? "\u5C1A\u672A\u542F\u52A8"}\uFF09\uFF1B\u540E\u53F0\u4EFB\u52A1\u4ECD\u53EF\u80FD\u5728\u7EE7\u7EED\u3002\u8FD0\u884C atrium restart --wait --timeout 300 \u67E5\u770B\u6700\u7EC8\u7ED3\u679C`,
    "restart_timeout"
  );
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
    return statSync(join3(data, "service.log")).size;
  } catch {
    return 0;
  }
}
function startupFailure(data, reason, logStart) {
  const path = join3(data, "service.log");
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
    `PID ${record.pid} \u4ECD\u5B58\u5728\uFF0C\u4F46\u670D\u52A1\u672A\u5C31\u7EEA\u6216\u8EAB\u4EFD\u4E0D\u5339\u914D\uFF1B\u4E0D\u4F1A\u91CD\u590D\u542F\u52A8\u6216\u6309 PID \u5F3A\u6740\u3002\u8BF7\u68C0\u67E5 ${join3(data, "service.log")}`
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
async function serviceStatus(data) {
  const record = readService(data);
  if (!record || !alive(record.pid)) {
    const legacy = !existsSync3(data) && legacyDataNotice();
    console.log(`Atrium \u672A\u8FD0\u884C
\u6570\u636E\uFF1A${data}${legacy ? `
${legacy}` : ""}`);
    return;
  }
  const current = await request2(record).catch(async () => {
    const state = readRestartState(data);
    if (state?.oldPid === record.pid && (await probePort(record.port)).kind === "free")
      throw new Error(
        state.status === "failed" ? `\u65E7\u670D\u52A1 PID ${record.pid} \u5DF2\u5173\u76D1\u542C\u4F46\u8FDB\u7A0B\u672A\u9000\u51FA\uFF1B\u8FD0\u884C atrium restart \u63A5\u7BA1\u5347\u7EA7\uFF0C\u518D\u8FD0\u884C atrium restart --wait \u67E5\u770B\u7ED3\u679C` : `\u65E7\u670D\u52A1 PID ${record.pid} \u5DF2\u5173\u76D1\u542C\uFF0C\u6B63\u5728\u7B49\u5F85\u8FDB\u7A0B\u9000\u51FA\uFF1B\u8FD0\u884C atrium restart --wait \u67E5\u770B\u7ED3\u679C`
      );
    throw unavailable(record, data);
  });
  if (current.stopping) throw await unavailableReason(record, data);
  console.log(
    `Atrium \u6B63\u5728\u8FD0\u884C \xB7 PID ${record.pid}
${serviceUrl(record)}
\u6570\u636E\uFF1A${data}
\u65E5\u5FD7\uFF1A${join3(data, "service.log")}\uFF08\u540E\u53F0\u542F\u52A8\uFF09`
  );
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
    await delay2(100);
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
    await delay2(100);
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
    const log = openSync2(join3(data, "service.log"), "a", 384);
    logStart = fstatSync(log).size;
    try {
      const { env, droppedSensitive } = serviceEnvironment(process.env);
      reportDroppedIdentity(droppedSensitive);
      child = spawn2(process.execPath, serviceArgs(entry), {
        cwd: data,
        env: {
          ...env,
          ATRIUM_DATA: data
        },
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true
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
        `Atrium \u670D\u52A1\u542F\u52A8\u4E2D\u2026\uFF08\u6700\u957F\u7B49 ${Math.round(totalMs / 1e3)} \u79D2\uFF1B\u65E5\u5FD7\uFF1A${join3(data, "service.log")}\uFF09`
      );
    }
    await delay2(100);
  }
  if (record && alive(record.pid)) throw await unavailableReason(record, data);
  throw startupFailure(
    data,
    `Atrium \u542F\u52A8\u8D85\u65F6\uFF08\u5DF2\u7B49 ${Math.round((Date.now() - started) / 1e3)} \u79D2\uFF09`,
    logStart
  );
}

export {
  localFetch,
  readRestartState,
  discardLegacyIdleRestart,
  restartInProgress,
  startSupervisor,
  waitForRestart,
  serviceStatus,
  stopService,
  startService
};
