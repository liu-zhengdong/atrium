import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodePath,
  nodes,
  one,
  ref,
  type RevisionRow,
} from "./model.ts";
import { overviewOf } from "./overview.ts";
import { nodeFields } from "./write.ts";
import { readLimits } from "./limits.ts";
import { chainPoints, nodePoints } from "./points.ts";
import { nodeTasks, taskCounts, type TaskCounts } from "./task-link.ts";
import { leaderBriefs } from "../leaders/model.ts";

export function tree(db: DatabaseSync) {
  const list = nodes(db).filter((node) => node.kind !== "concern");
  if (list.length > 500) throw new Problem(409, "组织树超过 500 个节点");
  const order: typeof list = [];
  const visit = (parent: number | null) => {
    for (const n of list.filter((item) => item.parent_id === parent)) {
      order.push(n);
      visit(n.id);
    }
  };
  visit(null);
  // 名下任务按子树汇总（项目的「在做」含各模块）；投出的只算节点自己。
  const counts = taskCounts(db);
  const leaders = leaderBriefs(db);
  const subtree = new Map<number, TaskCounts>();
  for (const n of [...order].reverse()) {
    const sum = {
      ...(counts.own.get(n.id) ?? { todo: 0, running: 0, blocked: 0 }),
    };
    for (const child of list.filter((item) => item.parent_id === n.id)) {
      const c = subtree.get(child.id)!;
      sum.todo += c.todo;
      sum.running += c.running;
      sum.blocked += c.blocked;
      if (c.reviewing) sum.reviewing = (sum.reviewing ?? 0) + c.reviewing;
      if (c.merge_queued)
        sum.merge_queued = (sum.merge_queued ?? 0) + c.merge_queued;
      if (c.merging) sum.merging = (sum.merging ?? 0) + c.merging;
    }
    subtree.set(n.id, sum);
  }
  return order.map((original) => {
    const { doc_path: _legacyDocPath, ...n } = original;
    return {
      ...n,
      ref: ref(n.id),
      path: nodePath(list, original),
      repos: all<{ repo: string }>(
        db,
        "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo",
        n.id,
      ).map((r) => r.repo),
      tasks: subtree.get(n.id)!,
      sent: counts.sent.get(n.id) ?? { todo: 0, running: 0, blocked: 0 },
      ...(n.leader && leaders.has(n.leader)
        ? { leader_state: leaders.get(n.leader) }
        : {}),
    };
  });
}
export function show(db: DatabaseSync, address: string) {
  const n = nodeByAddress(db, address);
  if (n.kind === "concern")
    throw new Problem(
      410,
      `关注点 ${n.name} 已从组织树下线；规矩写成要点，放在它们共同的上级`,
      "gone",
    );
  const list = tree(db);
  const node = list.find((item) => item.id === n.id)!;
  const overview = overviewOf(
    nodeFields(db, n.id),
    list
      .filter((item) => item.parent_id === n.id)
      .map((child) => {
        const fields = nodeFields(db, child.id);
        return {
          ref: child.ref,
          name: child.name,
          alias: typeof fields.alias === "string" ? fields.alias.trim() : "",
          analogy:
            typeof fields.analogy === "string" ? fields.analogy.trim() : "",
          archived: child.archived_at !== null,
          tasks: child.tasks,
        };
      }),
  );
  return {
    ...node,
    overview,
    points: nodePoints(db, n.id),
    // 根 → 本节点每层的要点；派活按它附「本部分及上级的要点」
    points_chain: chainPoints(db, n.id),
    recent_tasks: nodeTasks(db, n.id),
    // 根节点的两项配置（给你留的额度、花费上限）
    ...(n.parent_id === null ? { limits: readLimits(db) } : {}),
  };
}
export function history(
  db: DatabaseSync,
  address: string,
  options: { before?: string; after?: string; rev?: string; limit?: number },
) {
  const n = nodeByAddress(db, address);
  const parse = (value: string | undefined, field: string) => {
    if (value === undefined) return undefined;
    if (!/^r[1-9][0-9]*$/.test(value))
      throw new Problem(400, `${field} 应为 rN`);
    return Number(value.slice(1));
  };
  const before = parse(options.before, "--before"),
    after = parse(options.after, "--after"),
    wanted = parse(options.rev, "--rev");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Problem(400, "--limit 应为 1–100");
  if (wanted !== undefined) {
    const row = one<RevisionRow>(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND target='node' AND rev=?",
      n.id,
      wanted,
    );
    if (!row) throw new Problem(404, `${ref(n.id)} r${wanted} 不存在`);
    const previous = one<RevisionRow>(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND target='node' AND rev=?",
      n.id,
      wanted - 1,
    );
    const current = JSON.parse(row.snapshot) as Record<string, unknown>,
      old = previous
        ? (JSON.parse(previous.snapshot) as Record<string, unknown>)
        : {};
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(current)]))
      if (JSON.stringify(old[key]) !== JSON.stringify(current[key]))
        changes[key] = {
          before: old[key] ?? null,
          after: current[key] ?? null,
        };
    return { ref: ref(n.id), revision: { ...row, snapshot: current }, changes };
  }
  const rows = all<RevisionRow>(
    db,
    `SELECT * FROM org_revisions WHERE node_id=? AND target='node' AND (? IS NULL OR rev<?) AND (? IS NULL OR rev>?) ORDER BY id DESC LIMIT ?`,
    n.id,
    before ?? null,
    before ?? null,
    after ?? null,
    after ?? null,
    limit + 1,
  );
  return {
    ref: ref(n.id),
    items: rows
      .slice(0, limit)
      .map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) })),
    has_more: rows.length > limit,
  };
}
