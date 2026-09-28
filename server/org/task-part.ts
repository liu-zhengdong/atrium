import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one, ref } from "./model.ts";
import { hasOrg } from "./task-node.ts";

/**
 * 任务的归属部门（#322 第 1 步）：`task add/set --part 节点`，指向组织树节点（全景图的一块）。
 * 空值表示摘下。
 * 归属只是归类，不另设权限；与 role（谁来做、记谁的账、附谁的岗位说明）分开记。
 */
export function partForTask(
  db: DatabaseSync,
  value: unknown,
  field = "part",
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string")
    throw usage(`${field}: 应为节点（o4 或 atrium/runtime）`);
  const text = value.trim();
  if (!hasOrg(db)) throw usage(`${field}: 还没有组织树`, "atrium org import");
  let id: number;
  try {
    id = nodeByAddress(db, text).id;
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `${field}: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree",
      );
    throw error;
  }
  const node = one<{ id: number; name: string; archived_at: number | null }>(
    db,
    "SELECT id,name,archived_at FROM org_nodes WHERE id=?",
    id,
  );
  if (!node) throw usage(`${field}: 节点 ${ref(id)} 不存在`);
  if (node.archived_at !== null)
    throw usage(`${field}: 节点 ${ref(node.id)} ${node.name} 已归档`);
  return node.id;
}

const usage = (message: string, next = "atrium org tree") =>
  new Problem(400, message, "usage", undefined, next);
