import type { DatabaseSync } from "node:sqlite";
import { all, taskRef, type TaskRow } from "./ledger-model.ts";
import { conditions } from "./schedule-ledger.ts";
import { dependencyOf, type PrState } from "./schedule-upstream.ts";

/**
 * 排期的只读细节（`atrium top` 排期段，#262）：每条待办的记账节点路径、未结束子任务数，
 * 以及逐项的等待条件（上游任务的状态、执行者、开跑时刻与交付 PR，外部 PR 是否合入）。
 * 只读账本，不查 gh；PR 状态用排期器缓存的结果。
 */

export type UpstreamView = {
  ref: string;
  title: string;
  status: TaskRow["status"];
  worker: string | null;
  started_at: number | null;
  /** 上游 done 且交付 PR 时才有；state 为 null 表示还没查过。 */
  pr: { number: number; state: PrState | null; error: string | null } | null;
};
export type AfterPrView = {
  repo: string;
  number: number;
  merged: boolean;
  error: string | null;
};
export type PlanDetail = {
  node_path: string | null;
  /** 未结束（非 done、cancelled）的子任务数；大于 0 的父任务只起归类作用。 */
  open_children: number;
  upstream: UpstreamView[];
  after_pr: AfterPrView[];
};

/** 组织树可能还没建；没有 org_nodes 表时一律不给路径。 */
function nodePaths(db: DatabaseSync) {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'",
    )
    .get();
  const list = exists
    ? all<{ id: number; parent_id: number | null; slug: string }>(
        db,
        "SELECT id,parent_id,slug FROM org_nodes ORDER BY id LIMIT 501",
      )
    : [];
  const byId = new Map(list.map((node) => [node.id, node]));
  // 与 org/model.ts 的 nodePath 同一规则：去掉根节点，其余 slug 用 / 连。
  return (id: number | null) => {
    const node = id === null ? undefined : byId.get(id);
    if (!node) return null;
    const parts = [node.slug];
    const seen = new Set([node.id]);
    let current = node;
    while (current.parent_id !== null) {
      const parent = byId.get(current.parent_id);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      parts.unshift(parent.slug);
      current = parent;
    }
    if (parts.length > 1) parts.shift();
    return parts.join("/");
  };
}

/** 给一页排期补细节；查询次数与页大小成正比，页大小由调用方限定。 */
export function planDetails(
  db: DatabaseSync,
  rows: TaskRow[],
): Map<number, PlanDetail> {
  const pathOf = nodePaths(db);
  const details = new Map<number, PlanDetail>();
  const children = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled')",
  );
  const upstreamRow = db.prepare(
    "SELECT id,title,worker,started_at FROM tasks WHERE id=?",
  );
  for (const row of rows) {
    const deps = conditions(db, row.id);
    details.set(row.id, {
      node_path: pathOf(row.node_id),
      open_children: (children.get(row.id) as { n: number }).n,
      upstream: deps.after.map((ref) => {
        const id = Number(ref.slice(1));
        const dep = dependencyOf(db, id);
        const task = upstreamRow.get(id) as Pick<
          TaskRow,
          "id" | "title" | "worker" | "started_at"
        >;
        return {
          ref: taskRef(id),
          title: task.title,
          status: dep.status,
          worker: task.worker,
          started_at: task.started_at,
          pr: dep.pr ?? null,
        };
      }),
      after_pr: deps.after_pr.map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        merged: pr.merged,
        error: pr.error,
      })),
    });
  }
  return details;
}
