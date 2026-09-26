import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
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

/** 在 PATH 上找可执行文件；只读检查，不执行。 */
export function findExecutable(
  name: string,
  path = process.env.PATH ?? "",
): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // 不存在或不可执行，继续找下一个目录。
    }
  }
  return undefined;
}

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
