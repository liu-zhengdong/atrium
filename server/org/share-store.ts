import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { effective } from "./boundaries.ts";
import { allBoundaries, chainLevels } from "./boundary-store.ts";
import { all, nodes, ref, type NodeRow } from "./model.ts";
import {
  checkShares,
  parseShares,
  type Share,
  type ShareNode,
} from "./shares.ts";

type Row = {
  node_id: number;
  dim: Share["dim"];
  scope: string;
  amount: number;
};
export function allShares(db: DatabaseSync): Map<number, Share[]> {
  const map = new Map<number, Share[]>();
  const rows = all<Row>(
    db,
    "SELECT node_id,dim,scope,amount FROM org_budgets ORDER BY node_id,dim,scope LIMIT 20001",
  );
  if (rows.length > 20000) throw new Problem(409, "组织份额超过 20000 条");
  for (const row of rows)
    map.set(row.node_id, [
      ...(map.get(row.node_id) ?? []),
      { dim: row.dim, scope: row.scope, amount: row.amount },
    ]);
  return map;
}
export function ownShares(db: DatabaseSync, id: number): Share[] {
  const rows = all<Row>(
    db,
    "SELECT node_id,dim,scope,amount FROM org_budgets WHERE node_id=? ORDER BY dim,scope LIMIT 41",
    id,
  );
  if (rows.length > 40) throw new Problem(409, `${ref(id)} 的份额超过 40 条`);
  return rows.map(({ dim, scope, amount }) => ({ dim, scope, amount }));
}
export function saveShares(
  db: DatabaseSync,
  id: number,
  entries: readonly Share[],
) {
  db.prepare("DELETE FROM org_budgets WHERE node_id=?").run(id);
  const insert = db.prepare(
    "INSERT INTO org_budgets(node_id,dim,scope,amount) VALUES(?,?,?,?)",
  );
  for (const entry of entries)
    insert.run(id, entry.dim, entry.scope, entry.amount);
}
export function rootLimits(
  db: DatabaseSync,
  list: NodeRow[],
): { quota: number; money: number } {
  const root = list.find((n) => n.parent_id === null);
  if (!root) return { quota: 80, money: 0 };
  const boundary = allBoundaries(db);
  const values = effective([
    ...chainLevels(list, boundary, root.parent_id),
    { node: root.id, name: root.name, entries: boundary.get(root.id) ?? [] },
  ]);
  const number = (key: string, fallback: number) => {
    const found = values
      .filter((item) => item.param?.key === key)
      .map((item) => item.param!.value);
    return found.length
      ? key === "money_yuan_max"
        ? Math.min(...found)
        : Math.max(...found)
      : fallback;
  };
  return {
    quota: 100 - number("quota_reserve_percent", 20),
    money: number("money_yuan_max", 0),
  };
}
/** 校验提议中的整棵树，含被改节点的父级和子级；事务内调用。 */
export function planShares(
  db: DatabaseSync,
  node: NodeRow,
  proposed: unknown,
  newParent?: number,
): Share[] {
  const parsed = parseShares(proposed);
  if (parsed.problems.length) reject(node, parsed.problems);
  const list = nodes(db);
  const owned = allShares(db);
  owned.set(node.id, parsed.entries);
  const tree: ShareNode[] = list.map((n) => ({
    id: n.id,
    parent:
      n.id === node.id && newParent !== undefined ? newParent : n.parent_id,
    name: n.name,
    shares: owned.get(n.id) ?? [],
  }));
  const problems = checkShares(tree, rootLimits(db, list), [
    "claude",
    "codex",
    "opencode",
    "kimi",
    "grok",
  ]);
  if (problems.length) reject(node, problems);
  return parsed.entries;
}
export function checkStoredShares(
  db: DatabaseSync,
  node: NodeRow,
  newParent?: number,
) {
  const owned = allShares(db);
  const list = nodes(db);
  const tree: ShareNode[] = list.map((n) => ({
    id: n.id,
    parent:
      n.id === node.id && newParent !== undefined ? newParent : n.parent_id,
    name: n.name,
    shares: owned.get(n.id) ?? [],
  }));
  const problems = checkShares(tree, rootLimits(db, list), [
    "claude",
    "codex",
    "opencode",
    "kimi",
    "grok",
  ]);
  if (problems.length) reject(node, problems);
}
function reject(
  node: NodeRow,
  problems: { field: string; message: string }[],
): never {
  throw new Problem(
    400,
    `拒绝修改 ${ref(node.id)} ${node.name} 的份额：\n${problems.map((p) => `- ${p.field}：${p.message}`).join("\n")}`,
    "usage",
    undefined,
    `atrium org show ${ref(node.id)}`,
  );
}
