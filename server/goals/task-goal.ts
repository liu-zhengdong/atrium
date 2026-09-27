import type { DatabaseSync } from "node:sqlite";
import { one } from "../org/model.ts";
import { goalRef, parseGoalRef, requireGoal, usage } from "./model.ts";

/**
 * `task add/set --goal`：任务挂到目标树的任意一层（通常叶子里程碑）。空值表示摘下；
 * 目标须存在且没放弃。挂任务只是归类，不另设权限（任务账本本身不分操作者）。
 */
export function goalForTask(db: DatabaseSync, value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    !one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'")
  )
    throw usage("goal: 还没有目标树", "atrium goal add 结果");
  const goal = requireGoal(db, parseGoalRef(value, "goal"), "goal");
  if (goal.status === "dropped")
    throw usage(
      `goal: ${goalRef(goal.id)} 已放弃，不能再挂任务`,
      "atrium goal tree",
    );
  return goal.id;
}
