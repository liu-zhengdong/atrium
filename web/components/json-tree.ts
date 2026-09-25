/** 运行轨迹的调用参数与执行结果：只有整段是对象或数组才按 JSON 树显示。
    这里只放判断与一行预览，渲染在 JsonTree.tsx，便于直接单测。 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type JsonBranch = JsonValue[] | JsonObject;

/** 整段文本（去掉首尾空白）能解析成对象或数组时返回它，否则 null。 */
export function parseBranch(text: string): JsonBranch | null {
  return branchOf(text.trim());
}

/** 字符串值本身能解析成对象或数组时也展开成子树：MCP 结果常是这种。 */
export function jsonString(value: string): JsonBranch | null {
  return branchOf(value.trim());
}

function branchOf(trimmed: string): JsonBranch | null {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // 被截断的 JSON 解析不了，照旧显示原文。
    return null;
  }
  return isBranch(value) ? value : null;
}

export function isBranch(value: unknown): value is JsonBranch {
  return typeof value === "object" && value !== null;
}

/** 收起时的一行预览：数组报项数，对象列前三个字段，像浏览器那样。 */
export function branchPreview(branch: JsonBranch): string {
  if (Array.isArray(branch)) return `[${branch.length} 项]`;
  const entries = Object.entries(branch);
  const shown = entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${valuePreview(value)}`);
  return `{${shown.join(", ")}${entries.length > shown.length ? ", …" : ""}}`;
}

function valuePreview(value: JsonValue): string {
  // 嵌套的容器只报形状，像浏览器控制台那样：预览保持一行。
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (isBranch(value)) return "{…}";
  if (typeof value === "string")
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  return String(value);
}
