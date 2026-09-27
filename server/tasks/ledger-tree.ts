import type { DatabaseSync } from "node:sqlite";
import {
  all,
  parseTaskRef,
  requireRow,
  TREE_MAX,
  listView,
  type TaskNode,
  type TaskRow,
} from "./ledger-model.ts";
import { childSummaries } from "./ledger-summary.ts";
import { noteView } from "./notes.ts";

/** root 给定时返回那一棵；不给返回全部顶层任务组成的森林。超出上限标 truncated。 */
export function taskTree(db: DatabaseSync, root?: unknown) {
  const rootId =
    root === undefined || root === "" ? null : parseTaskRef(root, "root");
  if (rootId !== null) requireRow(db, rootId);
  const rows = all<TaskRow>(
    db,
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM tasks WHERE ${rootId === null ? "parent_id IS NULL" : "id=?"}
       UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id=sub.id)
     SELECT t.* FROM tasks t JOIN sub USING(id) ORDER BY t.id LIMIT ?`,
    ...(rootId === null ? [] : [rootId]),
    TREE_MAX + 1,
  );
  const truncated = rows.length > TREE_MAX;
  const nodes = new Map<number, TaskNode>();
  const summaries = childSummaries(
    db,
    rows.slice(0, TREE_MAX).map((found) => found.id),
  );
  for (const found of rows.slice(0, TREE_MAX))
    nodes.set(found.id, {
      ...listView(found),
      ...noteView(db, found.id, found.status),
      children: [],
      child_summary: summaries.get(found.id) ?? null,
    });
  const roots: TaskNode[] = [];
  // 按 id 升序：父任务总比子任务先建，先出现。
  for (const node of nodes.values()) {
    const parent =
      node.parent_id === null || node.id === rootId
        ? undefined
        : nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else if (node.parent_id === null || node.id === rootId) roots.push(node);
  }
  return { tasks: roots, truncated };
}
