import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  checkBoundaries,
  effective,
  parseBoundaries,
  type Boundary,
  type BoundaryProblem,
  type Converted,
  type Level,
  type ParamKey,
  type SubNode,
} from "./boundaries.ts";
import { all, ref, type NodeRow } from "./model.ts";

type Row = {
  node_id: number;
  bid: string;
  summary: string;
  detail: string | null;
  param_key: ParamKey | null;
  param_value: number | null;
};
const toBoundary = (row: Row): Boundary => ({
  id: row.bid,
  summary: row.summary,
  detail: row.detail,
  param:
    row.param_key && row.param_value !== null
      ? { key: row.param_key, value: row.param_value }
      : null,
});

/** 全树最多 500 节点 × 每节点 40 条，一次读完。 */
export function allBoundaries(db: DatabaseSync): Map<number, Boundary[]> {
  const map = new Map<number, Boundary[]>();
  for (const row of all<Row>(
    db,
    "SELECT node_id,bid,summary,detail,param_key,param_value FROM org_boundaries ORDER BY node_id,pos LIMIT 20000",
  )) {
    const list = map.get(row.node_id) ?? [];
    list.push(toBoundary(row));
    map.set(row.node_id, list);
  }
  return map;
}
export function ownBoundaries(db: DatabaseSync, node: number): Boundary[] {
  return all<Row>(
    db,
    "SELECT node_id,bid,summary,detail,param_key,param_value FROM org_boundaries WHERE node_id=? ORDER BY pos LIMIT 100",
    node,
  ).map(toBoundary);
}
/** 祖先各层（根在前，不含 node 自己）。 */
export function chainLevels(
  list: NodeRow[],
  owned: Map<number, Boundary[]>,
  parentId: number | null,
): Level[] {
  const levels: Level[] = [];
  let current = list.find((n) => n.id === parentId);
  while (current) {
    levels.unshift({
      node: current.id,
      name: current.name,
      entries: owned.get(current.id) ?? [],
    });
    const parent = current.parent_id;
    current = list.find((n) => n.id === parent);
  }
  return levels;
}
/** 后代，父在子前。 */
export function subtreeLevels(
  list: NodeRow[],
  owned: Map<number, Boundary[]>,
  root: number,
): SubNode[] {
  const out: SubNode[] = [];
  const visit = (parent: number) => {
    for (const n of list.filter((item) => item.parent_id === parent)) {
      out.push({
        node: n.id,
        parent,
        name: n.name,
        entries: owned.get(n.id) ?? [],
      });
      visit(n.id);
    }
  };
  visit(root);
  return out;
}
export const labeler = (list: NodeRow[]) => (id: number) => {
  const node = list.find((n) => n.id === id);
  return node ? `${ref(id)} ${node.name}` : ref(id);
};
export function rejectBoundaries(
  node: NodeRow,
  what: string,
  problems: BoundaryProblem[],
): never {
  throw new Problem(
    400,
    `拒绝修改 ${ref(node.id)} ${node.name} 的${what}：\n${problems
      .map((p) => `- ${p.field}：${p.message}`)
      .join("\n")}`,
    "usage",
    undefined,
    `atrium org show ${ref(node.id)} --charter --raw`,
  );
}
export function saveBoundaries(
  db: DatabaseSync,
  node: number,
  entries: Boundary[],
) {
  db.prepare("DELETE FROM org_boundaries WHERE node_id=?").run(node);
  const insert = db.prepare(
    "INSERT INTO org_boundaries(node_id,bid,pos,summary,detail,param_key,param_value) VALUES(?,?,?,?,?,?,?)",
  );
  entries.forEach((e, i) =>
    insert.run(
      node,
      e.id,
      i,
      e.summary,
      e.detail,
      e.param?.key ?? null,
      e.param?.value ?? null,
    ),
  );
}
/**
 * 校验本节点提议的边界。edit：proposed 来自 frontmatter（undefined 表示不改）；
 * move：newParent 给出新位置，proposed 沿用现有条目。
 */
export function planBoundaries(
  db: DatabaseSync,
  list: NodeRow[],
  node: NodeRow,
  proposed: unknown,
  options: { newParent?: number; what?: string } = {},
): { entries: Boundary[]; converted: Converted[] } {
  const owned = allBoundaries(db);
  const current = owned.get(node.id) ?? [];
  let entries = current;
  if (proposed !== undefined) {
    const parsed = parseBoundaries(proposed);
    if (parsed.problems.length)
      rejectBoundaries(node, options.what ?? "章程", parsed.problems);
    // 覆盖条目与上层同文时不重复存文字
    const above = new Map(
      effective(chainLevels(list, owned, node.parent_id)).map((e) => [e.id, e]),
    );
    entries = parsed.entries;
    const result = check(list, owned, node, current, entries, undefined);
    if (result.problems.length)
      rejectBoundaries(node, options.what ?? "章程", result.problems);
    entries = entries.map((e) =>
      above.get(e.id)?.param && e.summary === above.get(e.id)!.summary
        ? { ...e, summary: "" }
        : e,
    );
    return { entries, converted: result.converted };
  }
  if (options.newParent === undefined) return { entries, converted: [] };
  const result = check(list, owned, node, current, current, options.newParent);
  if (result.problems.length)
    rejectBoundaries(node, options.what ?? "节点", result.problems);
  return { entries, converted: result.converted };
}
function check(
  list: NodeRow[],
  owned: Map<number, Boundary[]>,
  node: NodeRow,
  current: Boundary[],
  proposed: Boundary[],
  newParent: number | undefined,
) {
  const oldChain = chainLevels(list, owned, node.parent_id);
  return checkBoundaries({
    chain:
      newParent === undefined ? oldChain : chainLevels(list, owned, newParent),
    ...(newParent === undefined ? {} : { oldChain }),
    node: { node: node.id, name: node.name },
    current,
    proposed,
    subtree: subtreeLevels(list, owned, node.id),
    label: labeler(list),
  });
}
