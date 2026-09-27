import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Problem } from "../problem.ts";
import type { TaskStatus } from "./state.ts";
import type { ChildSummary } from "./ledger-summary.ts";
import type { Deliver } from "./deliver.ts";
import type { NoteView } from "./notes.ts";

export type TaskRow = {
  id: number;
  parent_id: number | null;
  title: string;
  brief_path: string | null;
  role: string | null;
  repo: string | null;
  deliver: Deliver;
  issue: number | null;
  status: TaskStatus;
  worker: string | null;
  pid: number | null;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  ci: string | null;
  result: string | null;
  owner: string | null;
  auto: number;
  auto_dispatched: number;
  schedule_state: string | null;
  schedule_reason: string | null;
  node_id: number | null;
  origin_node_id: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
};
export type Task = TaskRow & {
  ref: string;
  parent_ref: string | null;
  node_ref: string | null;
  origin_ref: string | null;
} & NoteView;
export type TaskNode = Task & {
  children: TaskNode[];
  child_summary: ChildSummary | null;
};
export type TaskEventRow = {
  id: number;
  task_id: number;
  at: number;
  kind: string;
  detail: string | null;
};

export const taskRef = (id: number) => `t${id}`;
export const view = (
  row: TaskRow,
): TaskRow & {
  ref: string;
  parent_ref: string | null;
  node_ref: string | null;
  origin_ref: string | null;
} => ({
  ...row,
  ref: taskRef(row.id),
  parent_ref: row.parent_id === null ? null : taskRef(row.parent_id),
  node_ref: row.node_id == null ? null : `o${row.node_id}`,
  origin_ref: row.origin_node_id == null ? null : `o${row.origin_node_id}`,
});

export const RESULT_MAX_BYTES = 4096;
export const LIST_LIMIT = 200;
export const LIST_MAX = 500;
export const TREE_MAX = 2000;

export const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 接口与命令行都接受 t12 或 12；其余一律拒绝。 */
export function parseTaskRef(value: unknown, field = "id"): number {
  const text = typeof value === "number" ? String(value) : value;
  const match =
    typeof text === "string"
      ? /^t?([1-9][0-9]{0,15})$/.exec(text.trim())
      : null;
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id))
    throw usage(`${field}: 任务短号应为 t1 这样的格式`);
  return id;
}

export function one<T>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
) {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
) {
  return db.prepare(sql).all(...params) as T[];
}
export function atomically<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function row(db: DatabaseSync, id: number) {
  return one<TaskRow>(db, "SELECT * FROM tasks WHERE id=?", id);
}
export function requireRow(db: DatabaseSync, id: number) {
  const found = row(db, id);
  if (!found)
    throw new Problem(
      404,
      `任务 ${taskRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium task ls",
    );
  return found;
}
export function addEvent(
  db: DatabaseSync,
  id: number,
  at: number,
  kind: string,
  detail?: unknown,
) {
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)",
  ).run(
    id,
    at,
    kind,
    detail === undefined
      ? null
      : typeof detail === "string"
        ? detail
        : JSON.stringify(detail),
  );
}
