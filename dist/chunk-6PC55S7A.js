import {
  recordResult
} from "./chunk-7NDJVDNM.js";
import {
  localFetch,
  startService
} from "./chunk-6ZFPOKLL.js";
import {
  dataDirectory,
  readService,
  serviceUrl
} from "./chunk-PMAHYFAT.js";
import {
  Problem
} from "./chunk-HEN5YN5G.js";

// cli/auth.ts
import { readFileSync } from "node:fs";

// server/user-auth.ts
import { join } from "node:path";
var userTokenPath = (data) => join(data, "user-token");

// cli/auth.ts
async function serviceStatus(record) {
  const response = await localFetch(`${serviceUrl(record)}/api/service`, {
    headers: { authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(1500)
  }).catch(() => {
    throw new Problem(503, "\u670D\u52A1\u4E0D\u53EF\u7528\u6216\u8EAB\u4EFD\u6821\u9A8C\u5931\u8D25", "service_unavailable");
  });
  if (!response.ok)
    throw new Problem(503, "\u670D\u52A1\u4E0D\u53EF\u7528\u6216\u8EAB\u4EFD\u6821\u9A8C\u5931\u8D25", "service_unavailable");
  const status = await response.json();
  if (status.instance !== record.instance)
    throw new Problem(503, "\u670D\u52A1\u8EAB\u4EFD\u4E0D\u5339\u914D", "service_unavailable");
  return status;
}
async function supportsUserAuth(record) {
  return (await serviceStatus(record)).userAuth === "user-v1";
}
async function requireUserAuthService(record) {
  const status = await serviceStatus(record);
  if (status.userAuth !== "user-v1")
    throw new Problem(
      409,
      "\u5DF2\u5B89\u88C5\u65B0\u7248\u672C\uFF0C\u4F46\u5F53\u524D\u670D\u52A1\u4ECD\u5728\u8FD0\u884C\u65E7\u7248\u672C\uFF1B\u8BF7\u8FD0\u884C atrium restart \u5B8C\u6210\u5347\u7EA7",
      "upgrade_restart_required",
      void 0,
      "atrium restart"
    );
  if (status.stopping)
    throw new Problem(
      409,
      "\u670D\u52A1\u6B63\u5728\u5E73\u6ED1\u91CD\u542F\u6216\u5173\u95ED\u4E2D\uFF1B\u6709\u8FDB\u884C\u4E2D\u7684\u91CD\u542F\u65F6\u8FD0\u884C atrium restart --wait \u7B49\u7ED3\u679C\uFF0C\u6CA1\u6709\u65F6\u8FD0\u884C atrium restart \u63A5\u7BA1\u5347\u7EA7",
      "service_stopping",
      void 0,
      "atrium restart --wait"
    );
}
function localToken(data) {
  try {
    const token = readFileSync(userTokenPath(data), "utf8").trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
function userBearer(data) {
  const token = localToken(data);
  if (!token)
    throw new Problem(
      401,
      `\u7528\u6237\u4EE4\u724C\u7F3A\u5931\u6216\u65E0\u6548\uFF08\u6570\u636E\uFF1A${data}\uFF09\uFF1B\u8BF7\u8FD0\u884C atrium auth rotate`,
      "auth_required",
      void 0,
      "atrium auth rotate"
    );
  return `Bearer ${token}`;
}
var authCommands = {
  "auth status": {
    args: "",
    about: "\u67E5\u770B\u5F53\u524D\u672C\u673A\u7528\u6237\u8EAB\u4EFD\u3001\u8BA4\u8BC1\u72B6\u6001\u548C\u8FDE\u63A5\u7684\u670D\u52A1\uFF08\u4E0D\u542F\u52A8\u670D\u52A1\uFF09",
    positionals: [0, 0],
    run: async ({ json }) => {
      const data = dataDirectory();
      const record = readService(data);
      const token = localToken(data);
      let connected = false;
      let authenticated = false;
      let upgradeRequired = false;
      if (record) {
        try {
          connected = true;
          upgradeRequired = !await supportsUserAuth(record);
          if (!upgradeRequired && token) {
            const check = await localFetch(
              `${serviceUrl(record)}/api/org/tree`,
              {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(1500)
              }
            );
            authenticated = check.ok;
          }
        } catch {
          connected = false;
        }
      }
      const result = {
        user: "u1",
        scope: "local",
        service: connected && record ? serviceUrl(record) : null,
        data,
        authenticated,
        ...upgradeRequired ? { upgradeRequired: true } : {}
      };
      recordResult(result);
      if (!json)
        console.log(
          `\u5F53\u524D\uFF1A\u672C\u673A\u7528\u6237 u1
\u670D\u52A1\uFF1A${result.service ?? "\u672A\u8FDE\u63A5"}
\u8BA4\u8BC1\uFF1A${upgradeRequired ? "\u670D\u52A1\u8FD8\u5728\u8FD0\u884C\u65E7\u7248\u672C \xB7 \u8BF7\u8FD0\u884C atrium restart" : authenticated ? "\u6709\u6548" : "\u672A\u8BA4\u8BC1 \xB7 \u8BF7\u8FD0\u884C atrium auth rotate"}
\u6570\u636E\uFF1A${data}`
        );
    }
  },
  "auth rotate": {
    args: "",
    about: "\u8F6E\u6362\u7528\u6237\u4EE4\u724C\uFF1B\u4EE4\u724C\u4E22\u5931\u65F6\u51ED\u672C\u673A\u5B9E\u4F8B\u63A7\u5236\u51ED\u636E\u6062\u590D",
    positionals: [0, 0],
    run: async () => {
      const data = dataDirectory();
      const record = await startService(data);
      await requireUserAuthService(record);
      const url = `${serviceUrl(record)}/api/auth/rotate`;
      const rotate = (token2) => localFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token2}` }
      });
      const token = localToken(data);
      let response = token ? await rotate(token) : void 0;
      if (!response || response.status === 401)
        response = await rotate(record.token);
      if (!response.ok)
        throw new Problem(
          response.status,
          `\u65E0\u6CD5\u8F6E\u6362\u7528\u6237\u4EE4\u724C\uFF08\u6570\u636E\uFF1A${data}\uFF09\uFF1B\u786E\u8BA4 ATRIUM_DATA \u4E0E\u670D\u52A1\u76F8\u540C\uFF0C\u5E76\u68C0\u67E5\u5B9E\u4F8B\u63A7\u5236\u6587\u4EF6 service.sqlite\uFF1B\u8FD0\u884C atrium status \u6392\u67E5\u670D\u52A1`,
          "service_unavailable",
          void 0,
          "atrium status"
        );
      console.log(`\u7528\u6237\u4EE4\u724C\u5DF2\u8F6E\u6362
\u6570\u636E\uFF1A${data}`);
      recordResult({ rotated: true, data });
    }
  }
};

// cli/worker-guard.ts
var WORKER_FLAG = "ATRIUM_WORKER";
var WORKER_REFUSAL = "\u6267\u884C\u8005\u73AF\u5883\u91CC\u4E0D\u80FD\u64CD\u4F5C\u7528\u6237\u7684 Atrium \u670D\u52A1\uFF0C\u5982\u9700\u9694\u79BB\u5B9E\u4F8B\u8BF7\u663E\u5F0F\u8BBE\u7F6E ATRIUM_DATA \u4E0E ATRIUM_PORT";
var USER_PORT = "4310";
var workerReadable = (name, rest) => name === "material" && rest[0] === "get";
function workerGuard(env = process.env) {
  if (env[WORKER_FLAG] !== "1") return;
  const data = env.ATRIUM_DATA?.trim();
  const port = env.ATRIUM_PORT?.trim();
  if (!data || !port || port === USER_PORT || dataDirectory({ ATRIUM_DATA: data }) === dataDirectory({}))
    throw new Problem(403, WORKER_REFUSAL, "worker_environment");
}
function leaderSession(env = process.env) {
  const token = env.ATRIUM_LEADER_TOKEN?.trim();
  if (!token) return null;
  const leader = env.ATRIUM_LEADER?.trim() ?? "";
  const url = env.ATRIUM_LEADER_URL?.trim() ?? "";
  if (!/^a[1-9][0-9]*$/.test(leader) || !token.startsWith(`${leader}.`))
    throw new Problem(
      401,
      "leader \u73AF\u5883\u4E0D\u5B8C\u6574\uFF1AATRIUM_LEADER \u4E0E ATRIUM_LEADER_TOKEN \u5BF9\u4E0D\u4E0A",
      "auth_required"
    );
  if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(url))
    throw new Problem(
      401,
      "leader \u73AF\u5883\u4E0D\u5B8C\u6574\uFF1AATRIUM_LEADER_URL \u5E94\u4E3A\u672C\u673A\u670D\u52A1\u5730\u5740",
      "auth_required"
    );
  return { leader, url, bearer: `Bearer ${token}` };
}
var LEADER_REFUSED = /* @__PURE__ */ new Set([
  "",
  "--no-open",
  "stop",
  "restart",
  "update",
  "auth",
  "chat"
]);
function leaderCommandGuard(name, env = process.env) {
  if (!env.ATRIUM_LEADER_TOKEN?.trim()) return;
  if (LEADER_REFUSED.has(name ?? ""))
    throw new Problem(
      403,
      "leader \u8FDB\u7A0B\u4E0D\u80FD\u542F\u52A8\u3001\u505C\u6B62\u3001\u91CD\u542F\u3001\u5347\u7EA7\u670D\u52A1\uFF0C\u4E5F\u4E0D\u80FD\u8F6E\u6362\u4EE4\u724C\u6216\u5F00\u79D8\u4E66\u4F1A\u8BDD\uFF1B\u9700\u8981\u7684\u8BDD\u4E0A\u4EA4\u79D8\u4E66\uFF1Aatrium leader escalate --kind beyond \u8BF4\u660E",
      "leader_scope",
      void 0,
      "atrium leader escalate --kind beyond \u8BF4\u660E"
    );
}
var defaultActor = (env = process.env) => env.ATRIUM_LEADER_TOKEN?.trim() ? void 0 : env.ATRIUM_AS?.trim() || void 0;
var defaultSubscriber = (env = process.env) => env.ATRIUM_LEADER_TOKEN?.trim() && env.ATRIUM_LEADER?.trim() ? env.ATRIUM_LEADER.trim() : "secretary";

export {
  requireUserAuthService,
  userBearer,
  authCommands,
  WORKER_FLAG,
  workerReadable,
  workerGuard,
  leaderSession,
  leaderCommandGuard,
  defaultActor,
  defaultSubscriber
};
