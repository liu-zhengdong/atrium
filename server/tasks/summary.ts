import { clipResult } from "./ledger.ts";
import { lastAssistantText, parseEvents, parseLine } from "./json-log.ts";

/**
 * 从日志末尾取执行者的收尾摘要（#262）。纯函数。
 * 结构化日志（json：适配器 progressSignals 含 json_events）取最后一条助手文本，取不到再退回日志末尾；
 * 否则原样取末尾。结果截到 4 KB，只作 result 参考，事实由关卡另查。
 */
export function summarize(tail: string, json = false): string {
  if (json) {
    const text = lastAssistantText(parseEvents(tail));
    if (text !== undefined) return clipResult(text.trim());
  }
  return clipResult(tail.trim());
}

/** 结构化日志里的步骤事件数（opencode 的 step_start/step_finish、claude 的 assistant/user 轮次、agy 的 step_update、cursor 的 tool_call）。 */
export function countSteps(chunk: string): number {
  let steps = 0;
  for (const line of chunk.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    if (
      event.type === "step_start" ||
      event.type === "step_finish" ||
      event.type === "tool_use" ||
      event.type === "tool_call" ||
      event.type === "assistant" ||
      event.type === "user" ||
      event.event === "step_update"
    )
      steps++;
  }
  return steps;
}
