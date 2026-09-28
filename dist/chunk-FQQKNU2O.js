import {
  WORKER_FLAG,
  isVerifier,
  leaderSession,
  requireUserAuthService,
  userBearer,
  workerGuard
} from "./chunk-BXKWDG66.js";
import {
  recordResult
} from "./chunk-TWHVF7L2.js";
import {
  localFetch,
  restartInProgress,
  startService
} from "./chunk-N7EG5NFG.js";
import "./chunk-AJ73NCVO.js";
import "./chunk-BYXBJQAS.js";
import {
  compareSemver
} from "./chunk-AT7C2M5U.js";
import {
  alive,
  currentVersion,
  dataDirectory,
  readService,
  serviceUrl
} from "./chunk-IF66WVAY.js";
import {
  Problem
} from "./chunk-QCD2PKZ3.js";

// cli/version-check.ts
async function outdatedService(record) {
  if (!record) return null;
  let version;
  try {
    const response = await localFetch(`${serviceUrl(record)}/api/service`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return null;
    version = (await response.json()).version;
  } catch {
    return null;
  }
  const cli = currentVersion();
  const service = typeof version === "string" ? version : "\u672A\u77E5\u7248\u672C";
  if (typeof version === "string" && compareSemver(version, cli) >= 0)
    return null;
  return new Problem(
    409,
    `\u670D\u52A1\u7248\u672C ${service} \u65E7\u4E8E\u547D\u4EE4\u884C ${cli}\uFF0C\u4E0D\u652F\u6301\u6B64\u64CD\u4F5C\uFF1B\u5148 atrium restart \u5230\u65B0\u7248`,
    "service_outdated",
    void 0,
    "atrium restart"
  );
}
function missingRoute(status, body, serviceCredential = false) {
  if (status === 404)
    return body.code === "unknown_route" || body.error === "\u63A5\u53E3\u4E0D\u5B58\u5728" || body.error === "Not Found";
  return serviceCredential && status === 401;
}
async function outdatedServiceAt(data) {
  try {
    return await outdatedService(readService(data));
  } catch {
    return null;
  }
}

// cli/service.ts
async function connect(quietStart = false) {
  workerGuard();
  const leader = leaderSession();
  if (leader) return client(leader.url, "", void 0, leader.bearer);
  const data = dataDirectory();
  const before = readService(data);
  if (isVerifier()) {
    if (!before || !alive(before.pid))
      throw new Problem(
        503,
        "Atrium \u670D\u52A1\u6CA1\u5728\u8DD1\uFF1B\u4E0A\u7EBF\u9A8C\u8BC1\u6267\u884C\u8005\u4E0D\u62C9\u8D77\u670D\u52A1\uFF0C\u8FD9\u4E00\u6B65\u8BB0\u300C\u65E0\u6CD5\u9A8C\u8BC1\uFF1A\u670D\u52A1\u6CA1\u5728\u8DD1\u300D",
        "service_unavailable"
      );
    await requireUserAuthService(before);
    return client(serviceUrl(before), data);
  }
  const restarting = restartInProgress(data);
  const record = await startService(data).catch((error) => {
    if (error instanceof Problem) throw error;
    throw new Problem(
      503,
      error instanceof Error ? error.message : String(error),
      "service_unavailable"
    );
  });
  await requireUserAuthService(record);
  if (!quietStart && restarting)
    console.error(`Atrium \u5DF2\u91CD\u542F\uFF0C\u547D\u4EE4\u53D1\u5F80\u65B0\u670D\u52A1 \xB7 PID ${record.pid}`);
  else if (!quietStart && (!before || before.pid !== record.pid))
    console.error(
      `Atrium \u670D\u52A1\u5DF2\u5728\u540E\u53F0\u542F\u52A8 \xB7 PID ${record.pid} \xB7 ${serviceUrl(record)} \xB7 \u505C\u6B62\uFF1Aatrium stop`
    );
  let current = record;
  return client(serviceUrl(record), data, async (error) => {
    if (!resendable(error, data, current)) return null;
    current = await startService(data);
    return serviceUrl(current);
  });
}
function connectRunning() {
  workerGuard();
  const leader = leaderSession();
  if (leader) return client(leader.url, "", void 0, leader.bearer);
  const data = dataDirectory();
  const record = readService(data);
  if (!record || !alive(record.pid)) return null;
  return client(serviceUrl(record), data);
}
async function connectForRead() {
  try {
    workerGuard();
  } catch (error) {
    if (process.env[WORKER_FLAG] !== "1") throw error;
    const data = dataDirectory();
    const record = readService(data);
    if (!record || !alive(record.pid))
      throw new Problem(
        503,
        "Atrium \u670D\u52A1\u6CA1\u5728\u8DD1\uFF0C\u53D6\u4E0D\u5230\u8D44\u6599\uFF1B\u8FD9\u53F0\u673A\u5668\u4E0A\u6CA1\u6709 Atrium \u670D\u52A1\u65F6\u8BF7\u5728\u4EFB\u52A1\u6C47\u62A5\u91CC\u8BF4\u660E\u7F3A\u8FD9\u4EFD\u8D44\u6599",
        "service_unavailable"
      );
    return client(serviceUrl(record), data);
  }
  return connect();
}
var causeCode = (error) => error?.cause?.code;
var DISCONNECTED = /* @__PURE__ */ new Set([
  "ECONNRESET",
  "EPIPE",
  "EINVAL",
  "ENOTCONN",
  "UND_ERR_SOCKET"
]);
function resendable(error, data, record) {
  const code = causeCode(error);
  if (code === "ECONNREFUSED") return true;
  if (typeof code !== "string" || !DISCONNECTED.has(code)) return false;
  const now = readService(data);
  return !!restartInProgress(data) || !alive(record.pid) || now?.instance !== record.instance;
}
function client(base, data, reconnect, bearer) {
  function send(method, path, body, signal) {
    return localFetch(`${base}/api${path}`, {
      method,
      signal,
      headers: {
        ...body === void 0 ? {} : { "content-type": "application/json" },
        authorization: bearer ?? userBearer(data)
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
  }
  async function call(method, path, body, observe, signal) {
    const response = await send(method, path, body, signal).catch(async (error) => {
      if (signal?.aborted) throw error;
      const next = reconnect ? await reconnect(error) : null;
      if (!next) throw error;
      base = next;
      return send(method, path, body, signal);
    }).catch((error) => {
      if (error instanceof Problem) throw error;
      throw new Problem(
        503,
        error instanceof Error ? error.message : String(error),
        "service_unavailable"
      );
    });
    observe?.(response.headers);
    const text = await response.text().catch((error) => {
      throw new Problem(
        503,
        `\u8BFB\u53D6\u670D\u52A1\u54CD\u5E94\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`,
        "service_unavailable"
      );
    });
    let value = {};
    try {
      value = JSON.parse(text);
    } catch {
      if (response.ok && text.length > 0)
        throw new Problem(
          503,
          `\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u54CD\u5E94\uFF08HTTP ${response.status}\uFF09`,
          "service_unavailable"
        );
    }
    if (!response.ok) {
      if (!bearer && missingRoute(response.status, value)) {
        const outdated = await outdatedServiceAt(data);
        if (outdated) throw outdated;
      }
      const body2 = value;
      throw new Problem(
        response.status,
        typeof body2.error === "string" ? body2.error : `\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`,
        body2.code,
        body2.candidates,
        body2.nextCommand
      );
    }
    recordResult(value);
    return value;
  }
  return {
    get: (path, observe, signal) => call("GET", path, void 0, observe, signal),
    post: (path, body = {}) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    patch: (path, body) => call("PATCH", path, body),
    delete: (path, body) => call("DELETE", path, body)
  };
}
export {
  client,
  connect,
  connectForRead,
  connectRunning,
  resendable
};
