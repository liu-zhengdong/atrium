import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Problem } from "../problem.ts";

export type Kind = "org" | "project" | "module" | "concern";
export type Doc = "charter" | "card";
export type Target = "node" | Doc;
export type NodeRow = {
  id: number;
  parent_id: number | null;
  kind: Kind;
  slug: string;
  name: string;
  leader: string | null;
  doc_path: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};
export type DocRow = {
  node_id: number;
  doc: Doc;
  rev: number;
  fields: string;
  body: string;
  updated_by: string;
  updated_at: number;
};
export type RevisionRow = {
  id: number;
  node_id: number;
  target: Target;
  rev: number;
  author: string;
  at: number;
  reason: string;
  snapshot: string;
};
export const ref = (id: number) => `o${id}`;
export const one = <T>(
  db: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
) => db.prepare(sql).get(...args) as T | undefined;
export const all = <T>(
  db: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
) => db.prepare(sql).all(...args) as T[];
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function nodes(db: DatabaseSync): NodeRow[] {
  return all<NodeRow>(db, "SELECT * FROM org_nodes ORDER BY id LIMIT 501");
}
export function nodeByAddress(db: DatabaseSync, address: string): NodeRow {
  const list = nodes(db);
  if (list.length > 500) throw new Problem(409, "组织树超过 500 个节点");
  const direct = /^o([1-9][0-9]*)$/.exec(address);
  if (direct) {
    const found = list.find((n) => n.id === Number(direct[1]));
    if (found) return found;
  }
  const root = list.find((n) => n.parent_id === null);
  let matches: NodeRow[] = [];
  if (address.includes("/")) {
    const parts = address.split("/");
    let parent = root;
    if (parts[0] === root?.slug) parts.shift();
    for (const part of parts) {
      parent = list.find((n) => n.parent_id === parent?.id && n.slug === part);
      if (!parent) break;
    }
    if (parent) matches = [parent];
  } else matches = list.filter((n) => n.slug === address || n.name === address);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new Problem(
      409,
      `节点 ${address} 重名，请用短号：${matches.map((n) => ref(n.id)).join("、")}`,
      "conflict",
      matches.map((n) => ({ ref: ref(n.id), name: n.name })),
    );
  throw new Problem(
    404,
    `节点 ${address} 不存在`,
    "not_found",
    undefined,
    "atrium org tree",
  );
}
export function nodePath(list: NodeRow[], node: NodeRow): string {
  const parts = [node.slug];
  let current = node;
  while (current.parent_id !== null) {
    const parent = list.find((n) => n.id === current.parent_id);
    if (!parent) break;
    parts.unshift(parent.slug);
    current = parent;
  }
  if (parts.length > 1) parts.shift();
  return parts.join("/");
}
export function canEdit(
  list: NodeRow[],
  node: NodeRow,
  actor: string,
): boolean {
  if (actor === "u1") return true;
  let current: NodeRow | undefined = node;
  while (current) {
    if (current.leader === actor) return true;
    current = list.find((n) => n.id === current?.parent_id);
  }
  return false;
}
