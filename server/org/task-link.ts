import type { DatabaseSync } from "node:sqlite";
import { all, nodes, nodePath, one, ref, transaction } from "./model.ts";
import { roleMatcher } from "./task-node.ts";

/**
 * 组织树读任务账本（#264 第 3 步）：按节点聚合在做／卡住的任务、节点手上的任务，以及把旧 role 字符串回填成
 * node_id 的显式迁移（org link-roles，默认只预览）。只读写 tasks.node_id 与 task_events，不改 role 原值。
 */

export type TaskCounts = { todo: number; running: number; blocked: number };
const OPEN = ["todo", "running", "blocked"] as const;
const empty = (): TaskCounts => ({ todo: 0, running: 0, blocked: 0 });

/** 服务里任务表总在；单测只建组织表时没有任务可数。 */
function hasTaskNodes(db: DatabaseSync) {
  return all<{ name: string }>(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "node_id",
  );
}

/** 各节点自己名下（node_id）与投出（origin_node_id）的未结任务数；最多 500 节点 × 3 状态。 */
export function taskCounts(db: DatabaseSync): {
  own: Map<number, TaskCounts>;
  sent: Map<number, TaskCounts>;
} {
  const own = new Map<number, TaskCounts>(),
    sent = new Map<number, TaskCounts>();
  if (!hasTaskNodes(db)) return { own, sent };
  for (const [column, map] of [
    ["node_id", own],
    ["origin_node_id", sent],
  ] as const)
    for (const row of all<{ id: number; status: string; n: number }>(
      db,
      `SELECT ${column} AS id,status,COUNT(*) AS n FROM tasks WHERE ${column} IS NOT NULL AND status IN ('todo','running','blocked') GROUP BY ${column},status LIMIT 1500`,
    )) {
      const counts = map.get(row.id) ?? empty();
      counts[row.status as (typeof OPEN)[number]] = row.n;
      map.set(row.id, counts);
    }
  return { own, sent };
}

export type NodeTask = {
  ref: string;
  title: string;
  status: string;
  worker: string | null;
  origin_ref: string | null;
};
/** 节点手上的任务：未结的在前，最近 limit 条。 */
export function nodeTasks(db: DatabaseSync, id: number, limit = 5): NodeTask[] {
  if (!hasTaskNodes(db)) return [];
  return all<{
    id: number;
    title: string;
    status: string;
    worker: string | null;
    origin_node_id: number | null;
  }>(
    db,
    "SELECT id,title,status,worker,origin_node_id FROM tasks WHERE node_id=? ORDER BY status IN ('todo','running','blocked') DESC,id DESC LIMIT ?",
    id,
    limit,
  ).map((t) => ({
    ref: `t${t.id}`,
    title: t.title,
    status: t.status,
    worker: t.worker,
    origin_ref: t.origin_node_id === null ? null : ref(t.origin_node_id),
  }));
}

export const LINK_MAX = 5000;
export type LinkGroup = {
  node: string;
  path: string;
  roles: string[];
  tasks: string[];
};
export type LinkResult = {
  preview: boolean;
  linked: number;
  groups: LinkGroup[];
  unmatched: { task: string; title: string; role: string; reason: string }[];
  truncated: boolean;
};

/**
 * 旧 role 字符串 → 节点：按任务仓库找挂了该仓库的同名模块／关注点（节点地址写法直接解析）。
 * apply 时在一个事务里只写 node_id，并给每个任务记一条 org_link 事件。
 */
export function linkRoles(
  db: DatabaseSync,
  apply: boolean,
  now = Date.now(),
): LinkResult {
  const plan = () => {
    const rows = all<{
      id: number;
      title: string;
      role: string;
      repo: string | null;
    }>(
      db,
      "SELECT id,title,role,repo FROM tasks WHERE node_id IS NULL AND role IS NOT NULL AND role<>'' ORDER BY id LIMIT ?",
      LINK_MAX + 1,
    );
    const list = nodes(db);
    const matchOf = roleMatcher(db);
    const groups = new Map<number, LinkGroup>();
    const unmatched: LinkResult["unmatched"] = [];
    const matches: [number, number][] = [];
    for (const task of rows.slice(0, LINK_MAX)) {
      const match = matchOf(task.role, task.repo);
      if (!match.node) {
        unmatched.push({
          task: `t${task.id}`,
          title: task.title,
          role: task.role,
          reason: task.repo ? match.reason : `${match.reason}（任务没有仓库）`,
        });
        continue;
      }
      const group = groups.get(match.node.id) ?? {
        node: ref(match.node.id),
        path: nodePath(list, match.node),
        roles: [],
        tasks: [],
      };
      if (!group.roles.includes(task.role)) group.roles.push(task.role);
      group.tasks.push(`t${task.id}`);
      groups.set(match.node.id, group);
      matches.push([task.id, match.node.id]);
    }
    return {
      groups: [...groups.values()],
      unmatched,
      matches,
      truncated: rows.length > LINK_MAX,
    };
  };
  if (!hasTaskNodes(db) || !one(db, "SELECT 1 FROM org_nodes LIMIT 1"))
    return {
      preview: !apply,
      linked: 0,
      groups: [],
      unmatched: [],
      truncated: false,
    };
  if (!apply) {
    const { matches, ...rest } = plan();
    return { preview: true, linked: matches.length, ...rest };
  }
  return transaction(db, () => {
    const { matches, ...rest } = plan();
    const update = db.prepare(
      "UPDATE tasks SET node_id=?,updated_at=? WHERE id=? AND node_id IS NULL",
    );
    const event = db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,'org_link',?)",
    );
    for (const [task, node] of matches) {
      update.run(node, now, task);
      event.run(task, now, JSON.stringify({ node: ref(node) }));
    }
    return { preview: false, linked: matches.length, ...rest };
  });
}
