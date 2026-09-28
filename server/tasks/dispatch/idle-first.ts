import { ADAPTERS, type Tool } from "../adapters/index.ts";

/**
 * 自动挑执行者时避开正忙的独占执行者（#262）：独占工具（如 opencode）已有任务在跑，挑中它只能排队，
 * 于是把它排到所有空闲候选之后，其余保持原来的富余顺序；只剩它可选时仍排在第一，由调用方排队。纯函数。
 */
export function idleFirst(
  ranked: readonly Tool[],
  busy: ReadonlySet<Tool> | undefined,
): Tool[] {
  if (!busy?.size) return [...ranked];
  const waits = (tool: Tool) => ADAPTERS[tool].exclusive && busy.has(tool);
  return [...ranked.filter((tool) => !waits(tool)), ...ranked.filter(waits)];
}
