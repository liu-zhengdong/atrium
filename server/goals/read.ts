import type { DatabaseSync } from "node:sqlite";
import { all, nodes, nodePath, ref as nodeRef } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import {
  allGoals,
  criteriaOf,
  dependencies,
  goalRef,
  parseGoalRef,
  requireGoal,
  type GoalRow,
} from "./model.ts";
import { STATUS_LABEL, prerequisiteMet, type GoalStatus } from "./rules.ts";
import { summarize, type GoalSummary } from "./summary.ts";

export type GoalTasks = {
  todo: number;
  running: number;
  blocked: number;
  done: number;
  failed: number;
  cancelled: number;
};
const emptyTasks = (): GoalTasks => ({
  todo: 0,
  running: 0,
  blocked: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
});
export type Prerequisite = {
  ref: string;
  result: string;
  status: GoalStatus;
  met: boolean;
};

/** 服务里任务表总带 goal_id；只建目标表的单测没有任务可数。 */
export function hasTaskGoals(db: DatabaseSync) {
  return all<{ name: string }>(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "goal_id",
  );
}

type Context = {
  byId: Map<number, GoalRow>;
  after: Map<number, number[]>;
  org: Map<number, { name: string; path: string }>;
};
function context(db: DatabaseSync, goals?: GoalRow[]): Context {
  const list = goals ?? allGoals(db);
  const after = new Map<number, number[]>();
  for (const d of dependencies(db))
    after.set(d.goal_id, [...(after.get(d.goal_id) ?? []), d.after_id]);
  const org = new Map<number, { name: string; path: string }>();
  if (hasOrg(db)) {
    const nodeList = nodes(db);
    for (const n of nodeList)
      org.set(n.id, { name: n.name, path: nodePath(nodeList, n) });
  }
  return { byId: new Map(list.map((g) => [g.id, g])), after, org };
}

function view(row: GoalRow, ctx: Context) {
  const criteria = criteriaOf(row);
  const after: Prerequisite[] = (ctx.after.get(row.id) ?? []).flatMap((id) => {
    const found = ctx.byId.get(id);
    return found
      ? [
          {
            ref: goalRef(id),
            result: found.result,
            status: found.status,
            met: prerequisiteMet(found.status),
          },
        ]
      : [];
  });
  return {
    ref: goalRef(row.id),
    parent_ref: row.parent_id === null ? null : goalRef(row.parent_id),
    top: row.parent_id === null,
    result: row.result,
    criteria: criteria.items,
    ...(criteria.broken ? { criteria_broken: true } : {}),
    status: row.status,
    status_label: STATUS_LABEL[row.status],
    note: row.note,
    node_ref: nodeRef(row.node_id),
    node_name: ctx.org.get(row.node_id)?.name ?? null,
    node_path: ctx.org.get(row.node_id)?.path ?? null,
    due: row.due,
    after,
    waiting_for: after.filter((p) => !p.met).map((p) => p.ref),
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
export type GoalView = ReturnType<typeof view>;

export function goalView(db: DatabaseSync, row: GoalRow): GoalView {
  return view(row, context(db));
}

/** 各目标节点直接挂着的任务按状态计数；最多 GOALS_MAX × 6 行。 */
function taskCounts(db: DatabaseSync): Map<number, GoalTasks> {
  const counts = new Map<number, GoalTasks>();
  if (!hasTaskGoals(db)) return counts;
  for (const row of all<{
    goal_id: number;
    status: keyof GoalTasks;
    n: number;
  }>(
    db,
    "SELECT goal_id,status,COUNT(*) AS n FROM tasks WHERE goal_id IS NOT NULL GROUP BY goal_id,status LIMIT 12000",
  )) {
    const item = counts.get(row.goal_id) ?? emptyTasks();
    item[row.status] = row.n;
    counts.set(row.goal_id, item);
  }
  return counts;
}

export type GoalNode = GoalView & {
  tasks: GoalTasks;
  /** 直接及全部下层里程碑的任务和未达成前置汇总。 */
  summary: GoalSummary;
  children: GoalNode[];
};

/** 整棵目标树（或 root 那一棵）；按 id 升序，父节点总先建。 */
export function goalTree(db: DatabaseSync, root?: unknown) {
  const rootId =
    root === undefined || root === "" ? null : parseGoalRef(root, "root");
  if (rootId !== null) requireGoal(db, rootId);
  const goals = allGoals(db);
  const ctx = context(db, goals);
  const counts = taskCounts(db);
  const built = new Map<number, GoalNode>();
  for (const row of goals)
    built.set(row.id, {
      ...view(row, ctx),
      tasks: counts.get(row.id) ?? emptyTasks(),
      summary: { running: 0, open: 0, blocked: 0, waiting_for: [] },
      children: [],
    });
  const roots: GoalNode[] = [];
  for (const row of goals) {
    const node = built.get(row.id)!;
    if (row.id === rootId || (rootId === null && row.parent_id === null))
      roots.push(node);
    else if (row.parent_id !== null)
      built.get(row.parent_id)?.children.push(node);
  }
  for (const root of roots) summarize(root);
  return { goals: roots };
}

const TASKS_SHOWN = 50;
/** 单个目标节点：上层路径、下层、前置、挂着的任务（未结的在前，最多 50 条）。 */
export function goalShow(db: DatabaseSync, reference: unknown) {
  const id = parseGoalRef(reference, "目标");
  const row = requireGoal(db, id);
  const goals = allGoals(db);
  const ctx = context(db, goals);
  const path: { ref: string; result: string }[] = [];
  let current =
    row.parent_id === null ? undefined : ctx.byId.get(row.parent_id);
  while (current && path.length < goals.length) {
    path.unshift({ ref: goalRef(current.id), result: current.result });
    current =
      current.parent_id === null ? undefined : ctx.byId.get(current.parent_id);
  }
  const children = goals
    .filter((g) => g.parent_id === id)
    .map((g) => ({
      ref: goalRef(g.id),
      result: g.result,
      status: g.status,
      status_label: STATUS_LABEL[g.status],
    }));
  const needed_by = [...ctx.after.entries()]
    .filter(([, after]) => after.includes(id))
    .map(([goal]) => goalRef(goal));
  const tasks = hasTaskGoals(db)
    ? all<{
        id: number;
        title: string;
        status: string;
        worker: string | null;
        pr_url: string | null;
      }>(
        db,
        "SELECT id,title,status,worker,pr_url FROM tasks WHERE goal_id=? ORDER BY status IN ('todo','running','blocked') DESC,id DESC LIMIT ?",
        id,
        TASKS_SHOWN,
      ).map((t) => ({ ref: `t${t.id}`, ...t }))
    : [];
  return {
    ...view(row, ctx),
    path,
    children,
    needed_by,
    task_counts: taskCounts(db).get(id) ?? emptyTasks(),
    tasks,
  };
}
