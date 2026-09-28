import { findExecutable } from "../../platform/index.ts";
import { agy } from "./agy.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { grok } from "./grok.ts";
import { kimi } from "./kimi.ts";
import { opencode } from "./opencode.ts";
import {
  isBuiltinTool,
  TOOLS,
  type Adapter,
  type BuiltinTool,
  type Tool,
} from "./types.ts";

export * from "./types.ts";

export const BUILTIN_ADAPTERS: Readonly<Record<BuiltinTool, Adapter>> = {
  codex,
  opencode,
  claude,
  grok,
  kimi,
  agy,
  cursor,
};

/**
 * 在用的适配器：内置七个，加上档案登记的通用执行者（t271，`harness/<名字>` 写 `protocol: cli`）。
 * 登记由 custom-tools.ts 在服务启动、改档案、解析执行者时维护；内置的不能被盖掉或撤下。
 */
export const ADAPTERS: Record<Tool, Adapter> = { ...BUILTIN_ADAPTERS };

export const isTool = (value: unknown): value is Tool =>
  typeof value === "string" && Object.hasOwn(ADAPTERS, value);

/** 登记（或换掉）一个通用执行者；名字是内置工具时拒绝。 */
export function registerAdapter(adapter: Adapter) {
  if (isBuiltinTool(adapter.tool))
    throw new Error(`${adapter.tool} 是内置工具，不能登记成通用执行者`);
  ADAPTERS[adapter.tool] = adapter;
}

/** 撤下一个通用执行者（档案删了 protocol 或写坏了）；内置的不动。 */
export function dropAdapter(tool: string) {
  if (!isBuiltinTool(tool)) delete ADAPTERS[tool];
}

/** 在用的全部工具名：内置在前，登记的按名字排。 */
export const toolNames = (): Tool[] => [
  ...TOOLS,
  ...Object.keys(ADAPTERS)
    .filter((tool) => !isBuiltinTool(tool))
    .sort(),
];

/** 在 PATH 上找可执行文件（平台层；Windows 按 PATHEXT 补扩展名）。 */
export { findExecutable };

/** 返回已装工具及其可执行文件路径（含登记的通用执行者）。 */
export function detectInstalled(
  path = process.env.PATH ?? "",
): Partial<Record<Tool, string>> {
  const found: Partial<Record<Tool, string>> = {};
  for (const tool of toolNames()) {
    const file = findExecutable(ADAPTERS[tool]!.executable, path);
    if (file) found[tool] = file;
  }
  return found;
}
