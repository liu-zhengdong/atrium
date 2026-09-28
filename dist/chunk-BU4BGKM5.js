import {
  dataDirectory
} from "./chunk-NWLFCMFK.js";
import {
  Problem
} from "./chunk-XWXBA3CJ.js";

// cli/contract.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
var exitCodes = {
  internal: 1,
  usage: 2,
  confirmation_required: 2,
  not_found: 3,
  restart_rollback: 3,
  conflict: 4,
  worker_environment: 4,
  leader_scope: 4,
  service_unavailable: 5,
  auth_required: 6,
  upgrade_restart_required: 7,
  restart_timeout: 124,
  timeout: 124
};
var context = new AsyncLocalStorage();
var withContext = (value, fn) => context.run(value, fn);
var recordResult = (result) => {
  const current = context.getStore();
  if (current) current.result = result;
};
var recordNext = (next) => {
  const current = context.getStore();
  if (current) current.next = next;
};
function commandOnly(next) {
  const first = next?.split("\n", 1)[0];
  const start = first?.indexOf("atrium ") ?? -1;
  return first && start >= 0 ? first.slice(start) : null;
}
function errorCode(error) {
  if (error instanceof Problem && error.code in exitCodes)
    return error.code;
  return "internal";
}
function correction(code, usage) {
  if (code === "usage") return usage ?? null;
  if (code === "service_unavailable") return "atrium status";
  if (code === "auth_required") return "atrium auth rotate";
  if (code === "upgrade_restart_required") return "atrium restart";
  if (code === "restart_rollback" || code === "restart_timeout")
    return "atrium status";
  return null;
}
function failure(error, usage) {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const candidates = error instanceof Problem ? error.candidates : void 0;
  const next = error instanceof Problem && error.nextCommand ? error.nextCommand : correction(code, usage);
  const log = join(dataDirectory(), "service.log");
  return {
    code,
    message: code === "service_unavailable" ? `${message.replaceAll(`\u8BF7\u68C0\u67E5 ${log}`, "\u8BF7\u68C0\u67E5\u4E0B\u65B9\u65E5\u5FD7")}
\u6570\u636E\uFF1A${dataDirectory()}
\u65E5\u5FD7\uFF1A${log}` : message,
    ...candidates?.length ? { candidates } : {},
    next,
    exit: exitCodes[code]
  };
}

export {
  exitCodes,
  withContext,
  recordResult,
  recordNext,
  commandOnly,
  failure
};
