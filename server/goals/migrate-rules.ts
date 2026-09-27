import type { Stage } from "../org/overview.ts";
import type { CheckResult } from "./check-rules.ts";
import type { GoalStatus } from "./rules.ts";

/**
 * 目标树迁为节点阶段记录（#322 第 1 步）的纯判定：每个 gN 变成负责节点章程里的一条阶段（id 沿用 gN），
 * 保留结果、验收标准、状态、证据（达成说明 + 每条验收的最新判定）、截止、前置与上级；
 * 挂着 gN 的任务按该目标的负责节点回填归属部分（只填还没有归属的）。已迁过的阶段按 id 跳过，重复执行不重复写。
 */

export type MigrateGoal = {
  id: number;
  parent_id: number | null;
  result: string;
  criteria: string[];
  status: GoalStatus;
  note: string | null;
  node_id: number;
  due: string | null;
  repo: string | null;
};
export type MigrateCheck = {
  goal_id: number;
  criterion: string;
  kind: "command" | "manual";
  result: CheckResult;
  exit_code: number | null;
  note: string | null;
  actor: string;
  started_at: number;
};
export type MigrateNode = {
  id: number;
  name: string;
  path: string;
  /** 章程里已有的阶段 id。 */
  stages: string[];
};
export type MigrateTask = {
  id: number;
  goal_id: number;
  part_id: number | null;
};

export type NodePlan = {
  node: number;
  name: string;
  path: string;
  stages: Stage[];
  /** 章程里已有、这次跳过的 gN。 */
  kept: string[];
};
export type MigrationPlan = {
  nodes: NodePlan[];
  tasks: { task: number; goal: number; part: number }[];
  /** 已有归属部分、不覆盖的任务。 */
  tasks_kept: { task: number; goal: number; part: number }[];
  /** 负责节点不在组织树里的目标，不迁。 */
  orphans: { goal: number; node: number }[];
};

const RESULT_LABEL: Record<CheckResult, string> = {
  running: "未判完",
  pass: "通过",
  fail: "不通过",
  timeout: "超时",
  error: "出错",
};
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const cut = (text: string, max: number) =>
  Array.from(text).length > max
    ? `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`
    : text;

/** 证据：达成／放弃时写的说明在前，其后每条验收标准的最新判定（按条目原文对上）。 */
export function evidenceOf(
  goal: MigrateGoal,
  checks: readonly MigrateCheck[],
): string[] {
  const lines: string[] = [];
  if (goal.note?.trim()) lines.push(cut(goal.note.trim(), 1000));
  goal.criteria.forEach((criterion, i) => {
    const check = checks.find(
      (c) => c.goal_id === goal.id && c.criterion === criterion,
    );
    if (!check) return;
    const how =
      check.kind === "command"
        ? `命令${check.exit_code === null ? "" : `，退出码 ${check.exit_code}`}`
        : "人工";
    lines.push(
      cut(
        `第 ${i + 1} 条${RESULT_LABEL[check.result]}（${how}，${check.actor}，${day(check.started_at)}）${check.note?.trim() ? `：${check.note.trim()}` : ""}`,
        1000,
      ),
    );
  });
  return lines.slice(0, 20);
}

export function stageOf(
  goal: MigrateGoal,
  after: readonly number[],
  checks: readonly MigrateCheck[],
): Stage {
  const evidence = evidenceOf(goal, checks);
  return {
    id: `g${goal.id}`,
    result: cut(goal.result, 300),
    status: goal.status,
    ...(goal.criteria.length ? { criteria: goal.criteria.slice(0, 20) } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(goal.due ? { due: goal.due } : {}),
    ...(after.length ? { after: after.map((id) => `g${id}`) } : {}),
    ...(goal.parent_id !== null ? { parent: `g${goal.parent_id}` } : {}),
    ...(goal.repo ? { repo: goal.repo } : {}),
  };
}

export function planMigration(input: {
  goals: readonly MigrateGoal[];
  dependencies: readonly { goal_id: number; after_id: number }[];
  checks: readonly MigrateCheck[];
  nodes: readonly MigrateNode[];
  tasks: readonly MigrateTask[];
}): MigrationPlan {
  const byNode = new Map<number, NodePlan>();
  const orphans: MigrationPlan["orphans"] = [];
  for (const goal of [...input.goals].sort((a, b) => a.id - b.id)) {
    const node = input.nodes.find((n) => n.id === goal.node_id);
    if (!node) {
      orphans.push({ goal: goal.id, node: goal.node_id });
      continue;
    }
    const plan = byNode.get(node.id) ?? {
      node: node.id,
      name: node.name,
      path: node.path,
      stages: [],
      kept: [],
    };
    byNode.set(node.id, plan);
    const id = `g${goal.id}`;
    if (node.stages.includes(id)) {
      plan.kept.push(id);
      continue;
    }
    const after = input.dependencies
      .filter((d) => d.goal_id === goal.id)
      .map((d) => d.after_id)
      .sort((a, b) => a - b);
    plan.stages.push(stageOf(goal, after, input.checks));
  }
  const tasks: MigrationPlan["tasks"] = [];
  const kept: MigrationPlan["tasks_kept"] = [];
  for (const task of [...input.tasks].sort((a, b) => a.id - b.id)) {
    const goal = input.goals.find((g) => g.id === task.goal_id);
    if (!goal || !input.nodes.some((n) => n.id === goal.node_id)) continue;
    if (task.part_id !== null)
      kept.push({ task: task.id, goal: goal.id, part: task.part_id });
    else tasks.push({ task: task.id, goal: goal.id, part: goal.node_id });
  }
  return {
    nodes: [...byNode.values()].sort((a, b) => a.node - b.node),
    tasks,
    tasks_kept: kept,
    orphans,
  };
}
