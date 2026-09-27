/**
 * 结构化日志（适配器 progressSignals 含 json_events：opencode --format json、claude / agy stream-json）
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

/** agy 的一步：`{event:"step_update",step_update:{step_index,step_type,state,text_delta?,tool_name?,tool_info?}}`。 */
export function agyStep(event: JsonEvent) {
  if (event.event !== "step_update") return undefined;
  const step = object(event.step_update);
  return step && typeof step.step_index === "number"
    ? (step as JsonEvent & { step_index: number })
    : undefined;
}

/** agy 收尾 result 事件里的整段回复。 */
function agyResponse(event: JsonEvent) {
  if (event.event !== "result") return undefined;
  const response = object(event.result)?.response;
  return typeof response === "string" && response.trim() ? response : undefined;
}

/**
 * agy 的助手文本是逐段的 text_delta：从第 end 个事件往前，把同一步（step_index 相同）的片段拼回一段。
 * 返回拼好的文本与这一步第一个片段的位置；end 不是文本片段时返回 undefined。
 */
export function agyTextAt(
  events: JsonEvent[],
  end: number,
): { text: string; start: number } | undefined {
  const last = agyStep(events[end]!);
  if (
    last?.step_type !== "agent_response" ||
    typeof last.text_delta !== "string"
  )
    return undefined;
  const parts: string[] = [];
  let start = end;
  for (let i = end; i >= 0; i--) {
    const step = agyStep(events[i]!);
    if (!step || step.step_index !== last.step_index) break;
    if (typeof step.text_delta === "string") parts.unshift(step.text_delta);
    start = i;
  }
  return { text: parts.join(""), start };
}

/** 最后一条助手文本；claude 的 result 事件、agy 的 result.response 是整段收尾，排在最后时优先用它。 */
export function lastAssistantText(events: JsonEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "result" &&
      typeof event.result === "string" &&
      event.result.trim()
    )
      return event.result;
    const response = agyResponse(event);
    if (response !== undefined) return response;
    const pieces = agyTextAt(events, i);
    if (pieces) {
      if (pieces.text.trim()) return pieces.text;
      i = pieces.start;
      continue;
    }
    const text = textOf(event);
    if (text !== undefined) return text;
  }
  return undefined;
}

export type AbnormalEnd = {
  kind: "length" | "thinking" | "permission" | "midway";
  reason: string;
};

/** 最后一步思考用满单次输出、正文为 0 或极少：这一轮的产出全耗在思考上。 */
export type ThinkingExhausted = {
  reasoning: number;
  output: number;
  /** 单次输出上限：因长度结束时思考加正文就是用满的上限。 */
  limit: number;
};

/** 正文不超过这么多 token 算「极少」：一两句话，写不出交付。 */
const THIN_OUTPUT = 64;

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * 思考耗尽单次输出（#262）：opencode 的 step_finish `reason: "length"`，
 * `tokens.reasoning` 大于 0 而 `tokens.output` 为 0 或极少。
 * claude stream-json 的 usage 不分思考与正文、中间事件的 stop_reason 为 null，没有等价信号，不判；
 * agy 的步骤 usage 有 thinking_tokens，但没有结束原因与单次上限，分不出「用满了」还是「本来就只想了这些」，也不判；
 * codex、kimi、grok 是文本日志，也不判。
 */
export function thinkingExhausted(
  finish: JsonEvent,
): ThinkingExhausted | undefined {
  if (finish.type !== "step_finish") return undefined;
  const part = object(finish.part);
  if (part?.reason !== "length") return undefined;
  const tokens = object(part.tokens);
  const reasoning = count(tokens?.reasoning);
  const output = count(tokens?.output);
  if (!reasoning || output === undefined || output > THIN_OUTPUT)
    return undefined;
  return { reasoning, output, limit: reasoning + output };
}

export const thinkingReason = (hit: ThinkingExhausted) =>
  `思考耗尽单次输出（reasoning ${hit.reasoning} / 上限 ${hit.limit}，正文 ${hit.output}）`;

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
 * 最后一步因长度结束且正文为 0 或极少 → 思考耗尽单次输出；其余因长度结束 → 长度用尽；最后一步里最后一个出错的工具调用是权限被拒 → 权限被拒；
 * 最后一步以 tool-calls 结束且之后没有文本 → 对话中途退出。正常结束返回 undefined。
 */
export function abnormalEnding(events: JsonEvent[]): AbnormalEnd | undefined {
  let finish = -1;
  for (let i = events.length - 1; i >= 0 && finish < 0; i--)
    if (events[i]!.type === "step_finish") finish = i;
  if (finish < 0) return undefined;
  const reason = object(events[finish]!.part)?.reason;
  const thinking = thinkingExhausted(events[finish]!);
  if (thinking) return { kind: "thinking", reason: thinkingReason(thinking) };
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
