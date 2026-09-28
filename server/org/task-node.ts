import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one, ref, type NodeRow } from "./model.ts";

/** 任务与组织节点的对应（#264 第 3 步）：谁投的（--from）。 */

/** 服务启动时两张表都会建；单测或旧库里没有组织表时视为没有节点。 */
export function hasOrg(db: DatabaseSync): boolean {
  return !!one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'",
  );
}

/** `--from`：投任务的节点，必须是存在且未归档的节点。 */
export function originNode(db: DatabaseSync, address: string): NodeRow {
  if (!hasOrg(db))
    throw new Problem(
      400,
      "from: 还没有组织树",
      "usage",
      undefined,
      "atrium org import",
    );
  let node: NodeRow;
  try {
    node = nodeByAddress(db, address.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `from: ${error.message}`,
        "usage",
        undefined,
        "atrium org tree",
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw new Problem(
      400,
      `from: 节点 ${ref(node.id)} ${node.name} 已归档`,
      "usage",
    );
  return node;
}
