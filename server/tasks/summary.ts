import { clipResult } from "./ledger.ts";

/**
 * 从日志末尾取执行者的收尾摘要（#262）。纯函数。
 * 日志是 JSON 行（opencode --format json、claude stream-json）时，取最后的文本输出；
 * 否则原样取末尾。结果截到 4 KB，只作 result 参考，事实由关卡另查。
 */
export function summarize(tail: string): string {
  const lines = tail.split("\n").filter((line) => line.trim());
  const texts: string[] = [];
  let jsonLines = 0;
  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;
    jsonLines++;
    const text = textOf(event);
    if (text !== undefined) texts.push(text);
  }
  // 大半是 JSON 行才按结构化日志处理，免得普通日志里偶然一行 JSON 截走摘要。
  if (jsonLines > 0 && jsonLines * 2 >= lines.length) {
    // claude 的 result 事件已是整段收尾，直接用；否则拼最后几段文本。
    const result = lastResult(lines);
    if (result !== undefined) return clipResult(result.trim());
    return clipResult(texts.slice(-5).join("\n\n").trim());
  }
  return clipResult(tail.trim());
}

type Json = Record<string, unknown>;

function parseLine(line: string): Json | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Json)
      : undefined;
  } catch {
    return undefined;
  }
}

function lastResult(lines: string[]) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseLine(lines[i]!);
    if (event?.type === "result" && typeof event.result === "string")
      return event.result;
  }
  return undefined;
}

/** opencode：{type:"text",part:{text}}；claude：{type:"assistant",message:{content:[{type:"text",text}]}}。 */
function textOf(event: Json): string | undefined {
  if (event.type === "text") {
    const part = event.part as Json | undefined;
    return typeof part?.text === "string" ? part.text : undefined;
  }
  if (event.type === "assistant") {
    const content = (event.message as Json | undefined)?.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .filter(
        (item): item is { type: "text"; text: string } =>
          !!item &&
          typeof item === "object" &&
          (item as Json).type === "text" &&
          typeof (item as Json).text === "string",
      )
      .map((item) => item.text)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

/** 结构化日志里的步骤事件数（opencode 的 step_start/step_finish、claude 的 assistant/user 轮次）。 */
export function countSteps(chunk: string): number {
  let steps = 0;
  for (const line of chunk.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    if (
      event.type === "step_start" ||
      event.type === "step_finish" ||
      event.type === "tool_use" ||
      event.type === "assistant" ||
      event.type === "user"
    )
      steps++;
  }
  return steps;
}
