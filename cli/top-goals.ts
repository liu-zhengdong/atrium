import type { GoalNode } from "../server/goals/read.ts";
import { fit } from "./top-plan.ts";
import { width as displayWidth } from "./format.ts";

/** `top` 的目标段：由接口给的递归汇总画图，不推测任务归属。 */
export function renderTopGoals(
  goals: GoalNode[],
  width: number,
  depth = 2,
  maxLines = 20,
): string[] {
  const lines = ["目标"];
  if (!goals.length) return [...lines, "  尚无目标"];
  const walk = (nodes: GoalNode[], level: number) => {
    for (const node of nodes) {
      const { summary } = node;
      const stuck = [
        summary.waiting_for.length
          ? `前置 ${summary.waiting_for.join("、")}`
          : "",
        summary.blocked ? `任务卡住 ${summary.blocked}` : "",
      ].filter(Boolean);
      const indent = "  ".repeat(level + 1);
      const base = `${indent}${node.ref} [${node.status_label}] 在跑 ${summary.running} 未结 ${summary.open} · ${node.result}`;
      const blocker = stuck.length ? `卡在 ${stuck.join("、")}` : "";
      const combined = blocker ? `${base} · ${blocker}` : base;
      if (displayWidth(combined) <= width) lines.push(combined);
      else {
        lines.push(fit(base, width));
        if (blocker) lines.push(fit(`${indent}  ${blocker}`, width));
      }
      if (level + 1 < depth) walk(node.children, level + 1);
      else if (node.children.length)
        lines.push(
          fit(
            `${"  ".repeat(level + 2)}…下层 ${node.children.length} 个：atrium goal tree ${node.ref}`,
            width,
          ),
        );
    }
  };
  walk(goals, 0);
  if (lines.length <= maxLines) return lines;
  return [
    ...lines.slice(0, Math.max(1, maxLines - 1)),
    fit(`  …还有 ${lines.length - maxLines + 1} 行：atrium goal tree`, width),
  ];
}
