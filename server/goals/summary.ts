import type { GoalTasks } from "./read.ts";

export type GoalSummary = {
  /** 本节点及全部下层直接挂载任务的总数；已完成、失败、取消不算未结。 */
  running: number;
  open: number;
  blocked: number;
  /** 本节点及全部下层尚未达成的前置里程碑短号，去重、按短号排序。 */
  waiting_for: string[];
};

export type SummaryNode = {
  tasks: GoalTasks;
  waiting_for: string[];
  children: SummaryNode[];
  summary: GoalSummary;
};

const idOf = (ref: string) => Number(ref.slice(1));

/** 从叶到根汇总；同一任务只属于一个目标节点，不会重复计数。 */
export function summarize(node: SummaryNode): GoalSummary {
  const children = node.children.map(summarize);
  return (node.summary = {
    running: node.tasks.running + children.reduce((n, c) => n + c.running, 0),
    open:
      node.tasks.todo +
      node.tasks.running +
      node.tasks.blocked +
      children.reduce((n, c) => n + c.open, 0),
    blocked: node.tasks.blocked + children.reduce((n, c) => n + c.blocked, 0),
    waiting_for: [
      ...new Set([
        ...node.waiting_for,
        ...children.flatMap((child) => child.waiting_for),
      ]),
    ].sort((a, b) => idOf(a) - idOf(b)),
  });
}
