import { findExecutable } from "../../platform/index.ts";
import { agy } from "./agy.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { grok } from "./grok.ts";
import { kimi } from "./kimi.ts";
import { opencode } from "./opencode.ts";
import { TOOLS, type Adapter, type Tool } from "./types.ts";

export * from "./types.ts";

/**
 * 工具名 → 适配器。内置七个固定；档案里用 protocol 接入的新工具由 custom.ts 按库里的 harness 档案登记进来
 * （服务启动与 `workers edit` 改了工具层档案时同步），这里只放不删内置的。
 */
export const ADAPTERS: Record<Tool, Adapter> = {
  codex,
  opencode,
  claude,
  grok,
  kimi,
  agy,
  cursor,
};

/** 是不是认得的工具：内置的，或已按档案登记的新工具。 */
export const isTool = (value: unknown): value is Tool =>
  typeof value === "string" && Object.hasOwn(ADAPTERS, value);

/** 认得的全部工具名：内置在前，新工具按名字排。 */
export const toolNames = (): Tool[] => [
  ...TOOLS,
  ...Object.keys(ADAPTERS)
    .filter((name) => !(TOOLS as readonly string[]).includes(name))
    .sort(),
];

/** 日志是 claude stream-json 格式的工具（claude 自己与经 ACP 桥接的新工具）：收尾与接管按 claude 的规则判。 */
export const claudeStream = (tool: Tool) =>
  ADAPTERS[tool]?.logFormat === "claude-stream";

/** 在 PATH 上找可执行文件（平台层；Windows 按 PATHEXT 补扩展名）。 */
export { findExecutable };

/** 返回已装的内置工具及其可执行文件路径；新工具只在写死执行者时用，不参与自动挑选。 */
export function detectInstalled(
  path = process.env.PATH ?? "",
): Partial<Record<Tool, string>> {
  const found: Partial<Record<Tool, string>> = {};
  for (const tool of TOOLS) {
    const file = findExecutable(ADAPTERS[tool].executable, path);
    if (file) found[tool] = file;
  }
  return found;
}
