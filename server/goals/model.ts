import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, one } from "../org/model.ts";
import { GOALS_MAX, type GoalStatus } from "./rules.ts";

export type GoalRow = {
  id: number;
  parent_id: number | null;
  result: string;
  criteria: string;
  status: GoalStatus;
  note: string | null;
  node_id: number;
  due: string | null;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export const goalRef = (id: number) => `g${id}`;
export const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 接口与命令行都只认 g12 这样的短号。 */
export function parseGoalRef(value: unknown, field = "goal"): number {
  const match =
    typeof value === "string"
      ? /^g([1-9][0-9]{0,15})$/.exec(value.trim())
      : null;
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id))
    throw usage(`${field}: 目标短号应为 g1 这样的格式`, "atrium goal tree");
  return id;
}

export function goalRow(db: DatabaseSync, id: number) {
  return one<GoalRow>(db, "SELECT * FROM goals WHERE id=?", id);
}
export function requireGoal(db: DatabaseSync, id: number, field?: string) {
  const found = goalRow(db, id);
  if (!found)
    throw new Problem(
      field ? 400 : 404,
      `${field ? `${field}: ` : ""}目标 ${goalRef(id)} 不存在`,
      field ? "usage" : "not_found",
      undefined,
      "atrium goal tree",
    );
  return found;
}

/** 全部目标节点（上限 GOALS_MAX）；判层级、成环时要整张表。 */
export function allGoals(db: DatabaseSync): GoalRow[] {
  const rows = all<GoalRow>(
    db,
    "SELECT * FROM goals ORDER BY id LIMIT ?",
    GOALS_MAX + 1,
  );
  if (rows.length > GOALS_MAX)
    throw new Problem(409, `目标树超过 ${GOALS_MAX} 个节点`);
  return rows;
}

export function dependencies(db: DatabaseSync) {
  return all<{ goal_id: number; after_id: number }>(
    db,
    "SELECT goal_id,after_id FROM goal_dependencies ORDER BY goal_id,after_id LIMIT ?",
    GOALS_MAX * 20,
  );
}

/** 验收标准存 JSON 字符串数组；坏记录不挡读取，按空列表显示并标出。 */
export function criteriaOf(row: GoalRow): { items: string[]; broken: boolean } {
  try {
    const value = JSON.parse(row.criteria) as unknown;
    if (Array.isArray(value) && value.every((v) => typeof v === "string"))
      return { items: value, broken: false };
  } catch {
    /* 坏记录：下面按空列表返回 */
  }
  return { items: [], broken: true };
}
