/**
 * 目标树的纯判定（#313）：状态流转、谁能改、前置里程碑成环、层级。不读库，穷举测试。
 * 目标树与组织树正交：组织树是「谁」，目标树是「要什么」；权限借组织树的 leader 链判定。
 */

export const GOAL_STATUSES = [
  "planned",
  "active",
  "achieved",
  "blocked",
  "dropped",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const STATUS_LABEL: Record<GoalStatus, string> = {
  planned: "规划中",
  active: "进行中",
  achieved: "达成",
  blocked: "受阻",
  dropped: "放弃",
};
export const isGoalStatus = (value: unknown): value is GoalStatus =>
  GOAL_STATUSES.includes(value as GoalStatus);

/** 层级上限：任意多层，但要有界（递归、展示都按此收口）。 */
export const DEPTH_MAX = 12;
/** 全树节点上限：读树有界分页前的硬上限。 */
export const GOALS_MAX = 2000;

export type GoalAction =
  | { kind: "set"; to: "planned" | "active" | "blocked" }
  | { kind: "done" }
  | { kind: "drop" };

export type Verdict =
  { ok: true; to: GoalStatus } | { ok: false; reason: string };

/**
 * 状态流转：done → 达成、drop → 放弃，edit --status 只能设规划中／进行中／受阻。
 * 达成与放弃都可以改回（用户不认可就直接改回）；同状态重复设拒绝，免得误以为改了什么。
 */
export function transition(from: GoalStatus, action: GoalAction): Verdict {
  const to: GoalStatus =
    action.kind === "done"
      ? "achieved"
      : action.kind === "drop"
        ? "dropped"
        : action.to;
  if (from === to) return { ok: false, reason: `已经是${STATUS_LABEL[to]}` };
  return { ok: true, to };
}

/** 前置里程碑是否满足：只有达成算满足；放弃的前置要先从 --after 里去掉。 */
export const prerequisiteMet = (status: GoalStatus) => status === "achieved";

/** 设为达成前要满足的前置；返回没满足的那些。 */
export function unmetPrerequisites<T extends { status: GoalStatus }>(
  prerequisites: readonly T[],
): T[] {
  return prerequisites.filter((p) => !prerequisiteMet(p.status));
}

export type OrgLink = {
  id: number;
  parent_id: number | null;
  leader: string | null;
};

/** actor 是否为该组织节点或其祖先的 leader（u1 总能）。 */
export function leadsNode(
  org: readonly OrgLink[],
  nodeId: number,
  actor: string,
): boolean {
  if (actor === "u1") return true;
  const seen = new Set<number>();
  let current = org.find((n) => n.id === nodeId);
  while (current && !seen.has(current.id)) {
    if (current.leader === actor) return true;
    seen.add(current.id);
    const parent = current.parent_id;
    current = org.find((n) => n.id === parent);
  }
  return false;
}

export type Permission = { ok: true } | { ok: false; reason: string };

/**
 * 改一个目标节点（编辑、达成、放弃）：顶层目标只有 u1；里程碑由负责部门的 leader 或其上级 leader。
 */
export function canChange(
  org: readonly OrgLink[],
  goal: { parent_id: number | null; node_id: number },
  actor: string,
): Permission {
  if (goal.parent_id === null)
    return actor === "u1"
      ? { ok: true }
      : { ok: false, reason: "顶层目标只有你（u1）能改" };
  return leadsNode(org, goal.node_id, actor)
    ? { ok: true }
    : {
        ok: false,
        reason: `${actor} 不是负责部门 o${goal.node_id} 的 leader 或其上级 leader`,
      };
}

/**
 * 在 parent 下新建里程碑（或把里程碑挪到 parent 下）：actor 要能管新里程碑的负责部门；
 * parent 是里程碑时还要能管 parent 的负责部门（拆别人的里程碑要对方或上级点头）。
 * parent 是顶层目标时各部门都可在其下建自己的里程碑。没有 parent 就是顶层目标，只有 u1。
 */
export function canCreate(
  org: readonly OrgLink[],
  parent: { parent_id: number | null; node_id: number } | null,
  nodeId: number,
  actor: string,
): Permission {
  if (!parent)
    return actor === "u1"
      ? { ok: true }
      : { ok: false, reason: "顶层目标只有你（u1）能建" };
  if (!leadsNode(org, nodeId, actor))
    return {
      ok: false,
      reason: `${actor} 不是负责部门 o${nodeId} 的 leader 或其上级 leader`,
    };
  if (parent.parent_id !== null && !leadsNode(org, parent.node_id, actor))
    return {
      ok: false,
      reason: `${actor} 不是上级里程碑负责部门 o${parent.node_id} 的 leader 或其上级 leader`,
    };
  return { ok: true };
}

export type GoalLink = { id: number; parent_id: number | null };

/** 从 id 往上数到顶层的层数（顶层为 1）；链断或成环时返回 Infinity。 */
export function depthOf(goals: readonly GoalLink[], id: number): number {
  const byId = new Map(goals.map((g) => [g.id, g]));
  let depth = 0;
  let current = byId.get(id);
  while (current) {
    depth++;
    if (depth > GOALS_MAX) return Infinity;
    if (current.parent_id === null) return depth;
    current = byId.get(current.parent_id);
  }
  return Infinity;
}

/** 子树里最深的一层相对 id 的层数（id 自身为 1）。 */
export function subtreeHeight(goals: readonly GoalLink[], id: number): number {
  const children = new Map<number, number[]>();
  for (const g of goals)
    if (g.parent_id !== null)
      children.set(g.parent_id, [...(children.get(g.parent_id) ?? []), g.id]);
  const height = (node: number, seen: Set<number>): number => {
    if (seen.has(node)) return Infinity;
    seen.add(node);
    return (
      1 + Math.max(0, ...(children.get(node) ?? []).map((c) => height(c, seen)))
    );
  };
  return height(id, new Set());
}

/** id 是否是 ancestor 自己或其后代。 */
export function isWithin(
  goals: readonly GoalLink[],
  id: number,
  ancestor: number,
): boolean {
  const byId = new Map(goals.map((g) => [g.id, g]));
  let current = byId.get(id);
  for (let i = 0; current && i <= GOALS_MAX; i++) {
    if (current.id === ancestor) return true;
    current =
      current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return false;
}

/**
 * 把 id 的前置设为 after 后是否成环；edges 是现有「goal → 前置」边（不含 id 自己的旧边）。
 * 成环时返回环上的路径（从 id 出发再回到 id），否则 null。
 */
export function prerequisiteCycle(
  edges: readonly { goal_id: number; after_id: number }[],
  id: number,
  after: readonly number[],
): number[] | null {
  const next = new Map<number, number[]>();
  for (const e of edges)
    if (e.goal_id !== id)
      next.set(e.goal_id, [...(next.get(e.goal_id) ?? []), e.after_id]);
  next.set(id, [...after]);
  const seen = new Set<number>();
  const walk = (node: number, path: number[]): number[] | null => {
    for (const to of next.get(node) ?? []) {
      if (to === id) return [...path, to];
      if (seen.has(to)) continue;
      seen.add(to);
      const found = walk(to, [...path, to]);
      if (found) return found;
    }
    return null;
  };
  return walk(id, [id]);
}

/**
 * 只起归类作用的父任务才能迁为里程碑：有子任务、自己从没派过执行者、没有 PR、不在跑。
 * 返回不能迁的原因，能迁返回 null。
 */
export function adoptBlocker(task: {
  status: string;
  worker: string | null;
  pr_url: string | null;
  children: number;
}): string | null {
  if (task.children === 0) return "没有子任务，不是归类用的父任务";
  if (task.status === "running") return "正在执行";
  if (task.worker) return `派过执行者 ${task.worker}，不只是归类`;
  if (task.pr_url) return "有交付 PR，不只是归类";
  return null;
}

/** 父任务迁成的里程碑取什么状态：完成→达成，取消→放弃，受阻→受阻，其余看子任务有没有动过。 */
export function adoptedStatus(
  status: string,
  childStatuses: readonly string[],
): GoalStatus {
  if (status === "done") return "achieved";
  if (status === "cancelled") return "dropped";
  if (status === "blocked") return "blocked";
  return childStatuses.some((s) => s !== "todo") ? "active" : "planned";
}
