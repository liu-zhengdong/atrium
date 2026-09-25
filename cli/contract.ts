import { AsyncLocalStorage } from "node:async_hooks";
import { Problem } from "../server/problem.ts";
import { dataDirectory } from "../server/service-state.ts";
import { join } from "node:path";

export const exitCodes = {
  internal: 1,
  usage: 2,
  confirmation_required: 2,
  chat_not_found: 3,
  agent_not_found: 3,
  account_not_found: 3,
  model_not_found: 3,
  thinking_not_supported: 3,
  not_found: 3,
  restart_rollback: 3,
  conflict: 4,
  validation_failed: 4,
  already_assigned: 4,
  unassigned_account: 4,
  local_login_unavailable: 4,
  service_unavailable: 5,
  new_session_failed: 5,
  restart_timeout: 124,
  timeout: 124,
} as const;
export type ErrorCode = keyof typeof exitCodes;
export type Candidate = { ref: string; name: string };
export type Context = {
  result?: unknown;
  next?: string | null;
  lines: string[];
};
const context = new AsyncLocalStorage<Context>();
export const withContext = <T>(value: Context, fn: () => Promise<T>) =>
  context.run(value, fn);
export const recordResult = (result: unknown) => {
  const current = context.getStore();
  if (current) current.result = result;
};
export const recordNext = (next: string) => {
  const current = context.getStore();
  if (current) current.next = next;
};

/** 多步文本回执的 JSON next 只给第一条可执行命令。 */
export function commandOnly(next: string | null): string | null {
  const first = next?.split("\n", 1)[0];
  const start = first?.indexOf("atrium ") ?? -1;
  return first && start >= 0 ? first.slice(start) : null;
}

export function errorCode(error: unknown): ErrorCode {
  if (error instanceof Problem && error.code in exitCodes)
    return error.code as ErrorCode;
  return "internal";
}
export function correction(code: ErrorCode, usage?: string) {
  if (code === "usage") return usage ?? null;
  if (code === "chat_not_found") return "atrium chats";
  if (code === "agent_not_found") return "atrium list";
  if (code === "account_not_found") return "atrium accounts";
  if (code === "unassigned_account") return "atrium account check";
  if (code === "service_unavailable") return "atrium status";
  if (code === "restart_rollback" || code === "restart_timeout")
    return "atrium status";
  return null;
}
export function failure(error: unknown, usage?: string) {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const candidates = error instanceof Problem ? error.candidates : undefined;
  const next =
    error instanceof Problem && error.nextCommand
      ? error.nextCommand
      : correction(code, usage);
  const log = join(dataDirectory(), "service.log");
  return {
    code,
    message:
      code === "service_unavailable"
        ? `${message.replaceAll(`请检查 ${log}`, "请检查下方日志")}\n数据：${dataDirectory()}\n日志：${log}`
        : message,
    ...(candidates?.length ? { candidates } : {}),
    next,
    exit: exitCodes[code],
  };
}
