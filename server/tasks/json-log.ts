/**
 * 结构化日志（适配器 progressSignals 含 json_events：opencode --format json、claude stream-json）
 * 的解析（#262）：逐行 JSON 事件，取最后一条助手文本、识别异常结束。纯函数。
 */

export type JsonEvent = Record<string, unknown>;

export function parseLine(line: string): JsonEvent | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 日志末尾截下来的首行常是半截 JSON，解析不了的行直接跳过。 */
export function parseEvents(text: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of text.split("\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonEvent)
    : undefined;

/** opencode：{type:"text",part:{text}}；claude：{type:"assistant",message:{content:[{type:"text",text}]}}。 */
export function textOf(event: JsonEvent): string | undefined {
  if (event.type === "text") {
    const text = object(event.part)?.text;
    return typeof text === "string" && text.trim() ? text : undefined;
  }
  if (event.type === "assistant") {
    const content = object(event.message)?.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .map(object)
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item!.text as string)
      .join("\n");
    return text.trim() ? text : undefined;
  }
  return undefined;
}

/** 最后一条助手文本；claude 的 result 事件是整段收尾，排在最后时优先用它。 */
export function lastAssistantText(events: JsonEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "result" &&
      typeof event.result === "string" &&
      event.result.trim()
    )
      return event.result;
    const text = textOf(event);
    if (text !== undefined) return text;
  }
  return undefined;
}

export type AbnormalEnd = {
  kind: "length" | "permission" | "midway";
  reason: string;
};

const TARGET_MAX = 200;

/** 被拒工具调用的命令或路径。 */
function rejectedTarget(input: JsonEvent | undefined) {
  const value = [
    input?.command,
    input?.filePath,
    input?.path,
    input?.pattern,
  ].find((item) => typeof item === "string" && item.trim()) as
    string | undefined;
  if (!value) return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > TARGET_MAX ? `${line.slice(0, TARGET_MAX)}…` : line;
}

/** 最后一步里最后一个出错的工具调用，错误含 rejected permission 时给出被拒的命令或路径。 */
function rejection(events: JsonEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "step_start") return undefined;
    if (event.type !== "tool_use") continue;
    const state = object(object(event.part)?.state);
    if (state?.status !== "error") continue;
    const error = typeof state.error === "string" ? state.error : "";
    if (!/rejected permission/i.test(error)) return undefined;
    return rejectedTarget(object(state.input)) ?? "";
  }
  return undefined;
}

/**
 * 从事件识别异常结束（opencode 的 step_finish / tool_use 事件）：
 * 最后一步因长度结束 → 长度用尽；最后一步里最后一个出错的工具调用是权限被拒 → 权限被拒；
 * 最后一步以 tool-calls 结束且之后没有文本 → 对话中途退出。正常结束返回 undefined。
 */
export function abnormalEnding(events: JsonEvent[]): AbnormalEnd | undefined {
  let finish = -1;
  for (let i = events.length - 1; i >= 0 && finish < 0; i--)
    if (events[i]!.type === "step_finish") finish = i;
  if (finish < 0) return undefined;
  const reason = object(events[finish]!.part)?.reason;
  if (reason === "length")
    return { kind: "length", reason: "上下文或输出长度用尽" };
  const rejected = rejection(events.slice(0, finish));
  if (rejected !== undefined)
    return {
      kind: "permission",
      reason: rejected ? `权限被拒后结束：${rejected}` : "权限被拒后结束",
    };
  if (
    reason === "tool-calls" &&
    !events.slice(finish + 1).some((event) => textOf(event) !== undefined)
  )
    return { kind: "midway", reason: "对话中途退出" };
  return undefined;
}
