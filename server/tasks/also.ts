import type { DatabaseSync } from "node:sqlite";
import { all } from "./ledger-model.ts";
import { autoInvolved, resolveApplies } from "../org/aspects.ts";
import { ref } from "../org/model.ts";
import { Problem } from "../problem.ts";

/**
 * 任务牵涉的部分（#373）：任务「归」一个部分（`part_id`，负责与汇报只有一处），可以「牵涉」几个部分。
 * 显式牵涉记在 `task_also`（`task add/set --also o20,o4`）；管方面的部分里有要点适用于归属部分的，算自动牵涉，
 * 不入库、每次按当前要点算。牵涉只影响派活附哪些要点、能请哪些专员、知会哪些 leader，不改负责与汇报。
 */

export const ALSO_MAX = 5;

export function ensureAlsoTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_also (
    task_id INTEGER NOT NULL REFERENCES tasks(id), node_id INTEGER NOT NULL,
    pos INTEGER NOT NULL, PRIMARY KEY(task_id,node_id));`);
}

/** `--also` 解析成节点 id；空值表示都不牵涉。 */
export function alsoFor(db: DatabaseSync, value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw new Problem(400, "also: 应为部分，多个用逗号分隔（o20,o4）", "usage");
  const ids = resolveApplies(db, value, "also") ?? [];
  if (ids.length > ALSO_MAX)
    throw new Problem(
      400,
      `also: 一个任务至多牵涉 ${ALSO_MAX} 个部分；要分头干就拆子任务`,
      "usage",
    );
  return ids;
}

/** 在调用方的事务里整体覆盖。 */
export function writeAlso(db: DatabaseSync, taskId: number, ids: number[]) {
  db.prepare("DELETE FROM task_also WHERE task_id=?").run(taskId);
  ids.forEach((id, pos) =>
    db
      .prepare("INSERT INTO task_also(task_id,node_id,pos) VALUES(?,?,?)")
      .run(taskId, id, pos),
  );
}

export function alsoOf(db: DatabaseSync, taskId: number): number[] {
  return all<{ node_id: number }>(
    db,
    `SELECT node_id FROM task_also WHERE task_id=? ORDER BY pos LIMIT ${ALSO_MAX * 4}`,
    taskId,
  ).map((r) => r.node_id);
}

/** 任务读回时的牵涉部分：显式的与自动的（管方面要点适用于归属部分）。 */
export function involvedOf(
  db: DatabaseSync,
  task: { id: number; part_id: number | null; node_id: number | null },
): { also: number[]; auto: number[] } {
  const also = alsoOf(db, task.id);
  let auto: number[] = [];
  try {
    auto = autoInvolved(db, task.part_id ?? task.node_id).filter(
      (id) => !also.includes(id),
    );
  } catch {
    // 没有组织树（表不在）时不算自动牵涉。
  }
  return { also, auto };
}

export const involvedView = (involved: { also: number[]; auto: number[] }) => ({
  ...(involved.also.length ? { also: involved.also.map(ref) } : {}),
  ...(involved.auto.length ? { also_auto: involved.auto.map(ref) } : {}),
});
