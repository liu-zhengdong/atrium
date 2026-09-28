import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  parseTaskRef,
  requireRow,
  taskRef,
  usage,
} from "./ledger-model.ts";

export type PrCondition = {
  repo: string;
  number: number;
  merged: boolean;
  checked_at: number | null;
  error: string | null;
};
export type Conditions = { after: string[]; after_pr: PrCondition[] };

export function parseAfter(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("--after 用逗号分隔任务短号，如 t1,t2");
  const ids = value.split(",").map((part) => parseTaskRef(part, "--after"));
  if (new Set(ids).size !== ids.length)
    throw usage("--after 的任务短号不能重复");
  return ids;
}

export function parseAfterPr(
  value: unknown,
): { repo: string; number: number }[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("--after-pr 用逗号分隔 owner/repo#号");
  const prs = value.split(",").map((part) => {
    const match =
      /^([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#([1-9][0-9]*)$/.exec(
        part.trim(),
      );
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw usage(`--after-pr 的 ${part} 应为 owner/repo#号`);
    return { repo: match[1]!, number: Number(match[2]) };
  });
  if (new Set(prs.map((pr) => `${pr.repo}#${pr.number}`)).size !== prs.length)
    throw usage("--after-pr 的 PR 不能重复");
  return prs;
}

export const DOWNSTREAM_MAX = 10;

/** 没结束的直接下游（依赖这件的任务，t253）：至多列 DOWNSTREAM_MAX 件，more 是没列出的件数。走 task_dependencies_after 索引。 */
export function downstreamOf(
  db: DatabaseSync,
  id: number,
): { refs: string[]; more: number } {
  const rows = all<{ task_id: number }>(
    db,
    `SELECT d.task_id FROM task_dependencies d JOIN tasks t ON t.id=d.task_id
      WHERE d.after_id=? AND t.status NOT IN ('done','cancelled') ORDER BY d.task_id LIMIT ${DOWNSTREAM_MAX + 1}`,
    id,
  );
  const more =
    rows.length > DOWNSTREAM_MAX
      ? (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE d.after_id=? AND t.status NOT IN ('done','cancelled')",
            )
            .get(id) as { n: number }
        ).n - DOWNSTREAM_MAX
      : 0;
  return {
    refs: rows.slice(0, DOWNSTREAM_MAX).map((row) => taskRef(row.task_id)),
    more,
  };
}

export function conditions(db: DatabaseSync, id: number): Conditions {
  return {
    after: all<{ after_id: number }>(
      db,
      "SELECT after_id FROM task_dependencies WHERE task_id=? ORDER BY after_id",
      id,
    ).map((row) => taskRef(row.after_id)),
    after_pr: all<PrCondition>(
      db,
      "SELECT repo,number,merged,checked_at,error FROM task_pr_dependencies WHERE task_id=? ORDER BY repo,number",
      id,
    ).map((row) => ({ ...row, merged: !!row.merged })),
  };
}

/** 一页任务的依赖条件批量取（k23）：常数条查询，不随任务数线性增长。 */
export function conditionsOfMany(
  db: DatabaseSync,
  ids: number[],
): Map<number, Conditions> {
  const result = new Map<number, Conditions>(
    ids.map((id) => [id, { after: [], after_pr: [] }]),
  );
  if (!ids.length) return result;
  const list = ids.map(() => "?").join(",");
  for (const row of all<{ task_id: number; after_id: number }>(
    db,
    `SELECT task_id,after_id FROM task_dependencies WHERE task_id IN (${list}) ORDER BY task_id,after_id`,
    ...ids,
  )) {
    const found = result.get(row.task_id);
    if (found) found.after.push(taskRef(row.after_id));
  }
  for (const row of all<PrCondition & { task_id: number }>(
    db,
    `SELECT task_id,repo,number,merged,checked_at,error FROM task_pr_dependencies WHERE task_id IN (${list}) ORDER BY task_id,repo,number`,
    ...ids,
  )) {
    const found = result.get(row.task_id);
    if (found)
      found.after_pr.push({
        repo: row.repo,
        number: row.number,
        merged: !!row.merged,
        checked_at: row.checked_at,
        error: row.error,
      });
  }
  return result;
}

export function setConditions(
  db: DatabaseSync,
  id: number,
  input: Record<string, unknown>,
  now: number,
) {
  const after = "after" in input ? parseAfter(input.after) : undefined;
  const prs = "after_pr" in input ? parseAfterPr(input.after_pr) : undefined;
  if (after === undefined && prs === undefined && !("auto" in input)) return;
  const current = requireRow(db, id);
  if (
    current.status === "running" ||
    current.status === "done" ||
    current.status === "cancelled"
  )
    throw new Problem(
      409,
      `${taskRef(id)} 当前 ${current.status}，不能修改排期`,
      "conflict",
    );
  const hasQueue = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_queue'",
    )
    .get();
  if (
    hasQueue &&
    db.prepare("SELECT 1 FROM task_queue WHERE task_id=?").get(id)
  )
    throw new Problem(
      409,
      `${taskRef(id)} 已排队，先 task stop 再修改排期`,
      "conflict",
    );
  if (current.status === "blocked" && current.schedule_state === "blocked")
    db.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(id);
  if (after !== undefined) {
    for (const dependency of after) {
      if (dependency === id)
        throw usage(`--after：${taskRef(id)} 不能依赖自己`);
      requireRow(db, dependency);
      const cycle = db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
        SELECT after_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.after_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
      ) SELECT id FROM ancestors WHERE id=? LIMIT 1`,
        )
        .get(dependency, id);
      if (cycle)
        throw usage(
          `--after：${taskRef(dependency)} 已依赖 ${taskRef(id)}，会形成环路`,
        );
    }
    db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
    const insert = db.prepare(
      "INSERT INTO task_dependencies(task_id,after_id) VALUES (?,?)",
    );
    for (const dependency of after) insert.run(id, dependency);
  }
  if (prs !== undefined) {
    db.prepare("DELETE FROM task_pr_dependencies WHERE task_id=?").run(id);
    const insert = db.prepare(
      "INSERT INTO task_pr_dependencies(task_id,repo,number) VALUES (?,?,?)",
    );
    for (const pr of prs) insert.run(id, pr.repo, pr.number);
  }
  if ("auto" in input) {
    if (typeof input.auto !== "boolean") throw usage("--auto 应为布尔值");
    db.prepare("UPDATE tasks SET auto=? WHERE id=?").run(
      input.auto ? 1 : 0,
      id,
    );
  }
  db.prepare(
    "UPDATE tasks SET schedule_state=NULL,schedule_reason=NULL,auto_dispatched=0,updated_at=? WHERE id=?",
  ).run(now, id);
}
