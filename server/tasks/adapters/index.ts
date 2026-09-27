import { findExecutable } from "../../platform/index.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { grok } from "./grok.ts";
import { kimi } from "./kimi.ts";
import { opencode } from "./opencode.ts";
import { TOOLS, type Adapter, type Tool } from "./types.ts";

export * from "./types.ts";

export const ADAPTERS: Readonly<Record<Tool, Adapter>> = {
  codex,
  opencode,
  claude,
  grok,
  kimi,
};

/** 在 PATH 上找可执行文件（平台层；Windows 按 PATHEXT 补扩展名）。 */
export { findExecutable };

/** 返回已装工具及其可执行文件路径。 */
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
