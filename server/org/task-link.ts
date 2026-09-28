import type { DatabaseSync } from "node:sqlite";
import { all, ref } from "./model.ts";

/** 组织树读任务账本（#264 第 3 步）：按节点聚合在做／卡住的任务、节点手上的任务。 */

export type TaskCounts = {
  todo: number;
  running: number;
  blocked: number;
  reviewing?: number;
  merge_queued?: number;
  merging?: number;
};
const OPEN = [
  "todo",
  "running",
  "blocked",
  "reviewing",
  "merge_queued",
  "merging",
] as const;
const empty = (): TaskCounts => ({ todo: 0, running: 0, blocked: 0 });

/** 服务里任务表总在；单测只建组织表时没有任务可数。 */
function hasTaskNodes(db: DatabaseSync) {
  return all<{ name: string }>(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "node_id",
  );
}

/** 各节点名下（归属部门，旧任务看 node_id）与投出（origin_node_id）的未结任务数；最多 500 节点 × 3 状态。 */
export function taskCounts(db: DatabaseSync): {
  own: Map<number, TaskCounts>;
  sent: Map<number, TaskCounts>;
} {
  const own = new Map<number, TaskCounts>(),
    sent = new Map<number, TaskCounts>();
  if (!hasTaskNodes(db)) return { own, sent };
  for (const [column, map] of [
    ["COALESCE(part_id,node_id)", own],
    ["origin_node_id", sent],
  ] as const)
    for (const row of all<{ id: number; status: string; n: number }>(
      db,
      `SELECT ${column} AS id,
         CASE WHEN delivery_stage IN ('reviewing','merge_queued','merging') THEN delivery_stage ELSE status END AS status,
         COUNT(*) AS n FROM tasks WHERE ${column} IS NOT NULL
         AND (status IN ('todo','running','blocked') OR delivery_stage IN ('reviewing','merge_queued','merging'))
         GROUP BY ${column},CASE WHEN delivery_stage IN ('reviewing','merge_queued','merging') THEN delivery_stage ELSE status END LIMIT 2500`,
    )) {
      const counts = map.get(row.id) ?? empty();
      if (OPEN.includes(row.status as (typeof OPEN)[number]))
        counts[row.status as (typeof OPEN)[number]] = row.n;
      map.set(row.id, counts);
    }
  return { own, sent };
}

export type NodeTask = {
  ref: string;
  title: string;
  status: string;
  delivery_stage?: string | null;
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
    delivery_stage?: string | null;
    worker: string | null;
    origin_node_id: number | null;
  }>(
    db,
    "SELECT id,title,status,delivery_stage,worker,origin_node_id FROM tasks WHERE COALESCE(part_id,node_id)=? ORDER BY status IN ('todo','running','blocked') OR delivery_stage IN ('reviewing','merge_queued','merging') DESC,id DESC LIMIT ?",
    id,
    limit,
  ).map((t) => ({
    ref: `t${t.id}`,
    title: t.title,
    status: t.status,
    delivery_stage: t.delivery_stage,
    worker: t.worker,
    origin_ref: t.origin_node_id === null ? null : ref(t.origin_node_id),
  }));
}
