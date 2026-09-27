import type { Tool } from "./adapters/index.ts";
import { parseEvents, type JsonEvent } from "./json-log.ts";

/**
 * 接管后退出的执行者（#262）：服务重启后按 pid 接管的进程没有句柄，退出码不可得。
 * 按各工具日志的收尾结构判它是正常结束还是出错：纯函数。
 * - claude stream-json：最后的 result 事件 is_error=false、stop_reason=end_turn 为正常；其余 result 或没有 result 为出错。
 * - opencode --format json：最后一个 step_finish 的 reason=stop 为正常；之后出现 error 事件或 reason 是别的为出错。
 * - codex：本轮写出了最后消息文件（-o）为正常；没有则判不了。
 * - kimi、grok 是纯文本日志，判不了。
 */

export type AdoptedEnd =
  | { end: "clean"; evidence: string }
  | { end: "error"; evidence: string }
  | { end: "unknown" };

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonEvent)
    : undefined;

function claudeEnd(events: JsonEvent[]): AdoptedEnd {
  const result = events.findLast((event) => event.type === "result");
  if (!result) return { end: "error", evidence: "日志没有收尾的 result 事件" };
  if (result.is_error === false && result.stop_reason === "end_turn")
    return { end: "clean", evidence: "result 事件 stop_reason=end_turn" };
  const detail = [
    typeof result.subtype === "string" ? `subtype=${result.subtype}` : "",
    `stop_reason=${String(result.stop_reason ?? "无")}`,
    result.is_error === true ? "is_error=true" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { end: "error", evidence: `result 事件 ${detail}` };
}

function opencodeEnd(events: JsonEvent[]): AdoptedEnd {
  let finish = -1;
  for (let i = events.length - 1; i >= 0 && finish < 0; i--)
    if (events[i]!.type === "step_finish") finish = i;
  const error = events
    .slice(finish + 1)
    .findLast((event) => event.type === "error");
  if (error) {
    const message =
      object(object(error.error)?.data)?.message ??
      object(error.error)?.message ??
      object(error.error)?.name;
    return {
      end: "error",
      evidence: `error 事件${typeof message === "string" && message ? `：${message.slice(0, 200)}` : ""}`,
    };
  }
  if (finish < 0) return { end: "unknown" };
  const reason = object(events[finish]!.part)?.reason;
  return reason === "stop"
    ? { end: "clean", evidence: "最后一步 reason=stop" }
    : { end: "error", evidence: `最后一步 reason=${String(reason ?? "无")}` };
}

export function adoptedEnd(input: {
  tool: Tool;
  /** 日志末尾（已去掉 [atrium] 行）；读不到时为 undefined。 */
  log?: string;
  /** codex 本轮写出的最后消息；没有或是上一轮留下的为 undefined。 */
  lastMessage?: string;
}): AdoptedEnd {
  switch (input.tool) {
    case "claude":
      return input.log === undefined
        ? { end: "unknown" }
        : claudeEnd(parseEvents(input.log));
    case "opencode":
      return input.log === undefined
        ? { end: "unknown" }
        : opencodeEnd(parseEvents(input.log));
    case "codex":
      return input.lastMessage?.trim()
        ? { end: "clean", evidence: "写出了最终消息" }
        : { end: "unknown" };
    default:
      return { end: "unknown" };
  }
}
