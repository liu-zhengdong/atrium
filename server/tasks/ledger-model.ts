import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Problem } from "../problem.ts";
import type { TaskStatus } from "./state.ts";
import type { ChildSummary } from "./ledger-summary.ts";
import type { Deliver } from "./deliver.ts";
import type { NoteView } from "./notes.ts";
import type { Holder } from "./holder.ts";
import type { Rollup } from "./rollup.ts";
import { applyDeliveryEvent } from "./delivery-records.ts";
import { storedHosts } from "../hosts/state.ts";
import { priorityOf, type Priority } from "./priority.ts";

export type TaskRow = {
  id: number;
  parent_id: number | null;
  /** 1 表示运行时替父任务建的帮手（审阅），不让父任务变成总任务（t190）。 */
  helper: number;
  title: string;
  /** 任务详述内容（#355）；列表类视图不带，单个任务才给。 */
  brief?: string | null;
  /** 详述的来源文件，仅作记录；派活读 brief。 */
  brief_path: string | null;
  role: string | null;
  job_id: number | null;
  worker_effort: string | null;
  worker_risk: string | null;
  repo: string | null;
  deliver: Deliver;
  issue: number | null;
  status: TaskStatus;
  worker: string | null;
  pid: number | null;
  /** 这一轮跑在哪台远程主机上（#358，hosts.id）；本机为 null。pid、worktree 是那台机器上的。 */
  host_id?: number | null;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  ci: string | null;
  result: string | null;
  /** PR 交付后的阶段；null 表示尚未进入合入流程。 */
  delivery_stage:
    "reviewing" | "merge_queued" | "merging" | "merged" | "online" | null;
  merge_returns: number;
  /** 审阅关卡这一轮派出的审阅任务 id。 */
  review_task: number | null;
  merge_queued_at: number | null;
  /** 合入后的 squash 提交；自动上线据此找含它的版本。 */
  merge_commit: string | null;
  /** 含合入提交的最早版本（不带 v）。 */
  release_version: string | null;
  /** 1 表示合入的是服务自身的仓库，正在等发版上线。 */
  online_wait: number;
  /** 已为哪个版本发起过自升级；同一版本不重复升级。 */
  online_attempt: string | null;
  owner: string | null;
  auto: number;
  auto_dispatched: number;
  /** 派活避开的主机（JSON 数组，主机 id）；没写为 null。 */
  avoid_hosts?: string | null;
  /** 优先级（priority.ts）：列名是 prio，旧库的 priority 列已不用；读出来的视图给 priority。 */
  prio: Priority;
  schedule_state: string | null;
  schedule_reason: string | null;
  node_id: number | null;
  origin_node_id: number | null;
  part_id: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
};
export type Task = Omit<TaskRow, "prio"> & {
  ref: string;
  parent_ref: string | null;
  node_ref: string | null;
  origin_ref: string | null;
  part_ref: string | null;
  job_ref: string | null;
  /** 跑在哪台远程主机上（hN）；本机为 null。 */
  host_ref: string | null;
  /** 派活避开的主机（hN）；没写为空。 */
  avoid_host_refs: string[];
  priority: Priority;
  /** 在排队时的原因（queue.ts queueView）；不在排队为 null，旧接口不给为 undefined。 */
  queued_reason?: string | null;
  /** 要用的凭据名称（t194，secrets/）：派活时按名称注入执行者环境；没有时不给。 */
  secrets?: string[];
  /** 现在球在谁手里（holder.ts）；只有单个任务视图给，已结束为 null。 */
  holder?: Holder | null;
  /** 总任务（t190）按全部子孙汇总的状态与进度；不是总任务为 null，旧接口不给为 undefined。 */
  rollup?: Rollup | null;
} & NoteView;
/** 树只带画树要的列（t155）；详述、结果摘要等大字段要看用 task show。 */
export type TaskNode = Pick<
  TaskRow,
  | "title"
  | "status"
  | "deliver"
  | "issue"
  | "worker"
  | "pr_url"
  | "delivery_stage"
> & {
  ref: string;
  parent_ref: string | null;
  children: TaskNode[];
  child_summary: ChildSummary | null;
  /** 总任务（t190）按全部子孙汇总的状态与进度；不是总任务为 null。 */
  rollup: Rollup | null;
} & NoteView;
export type TaskEventRow = {
  id: number;
  task_id: number;
  at: number;
  kind: string;
  detail: string | null;
};

export const taskRef = (id: number) => `t${id}`;
/** 旧库里还在、不再读写的列（简化第 2 步）：读出的视图里去掉，免得旧值被当真。 */
const RETIRED = [
  "urgent",
  "urgent_why",
  "urgent_by",
  "stopgap",
  "size",
  "task_type",
] as const;

export const view = (
  row: TaskRow,
): Omit<TaskRow, "prio"> & {
  ref: string;
  parent_ref: string | null;
  node_ref: string | null;
  origin_ref: string | null;
  part_ref: string | null;
  job_ref: string | null;
  host_ref: string | null;
  avoid_host_refs: string[];
  priority: Priority;
} => {
  const { prio, ...rest } = row;
  for (const key of RETIRED) delete (rest as Record<string, unknown>)[key];
  return {
    ...rest,
    priority: priorityOf(prio),
    ref: taskRef(row.id),
    parent_ref: row.parent_id === null ? null : taskRef(row.parent_id),
    node_ref: row.node_id == null ? null : `o${row.node_id}`,
    origin_ref: row.origin_node_id == null ? null : `o${row.origin_node_id}`,
    part_ref: row.part_id == null ? null : `o${row.part_id}`,
    job_ref: row.job_id == null ? null : `r${row.job_id}`,
    host_ref: row.host_id == null ? null : `h${row.host_id}`,
    avoid_host_refs: storedHosts(row.avoid_hosts).map((id) => `h${id}`),
  };
};

/** 列表、树、排期不带详述内容（至多 64 KB 一条），要看用 task show。 */
export const listView = (row: TaskRow) => ({ ...view(row), brief: undefined });

export const RESULT_MAX_BYTES = 4096;
export const LIST_LIMIT = 200;
export const LIST_MAX = 500;
export const TREE_MAX = 2000;
/** 不写根时每页列几个顶层任务（t155），上限与已结束的顶层列最近几个。 */
export const TREE_ROOTS = 30;
export const TREE_ROOTS_MAX = 200;
export const TREE_RECENT = 10;

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
/** 任务有没有过某类事件：按 (task_id,kind) 索引直查，不受事件多少影响。 */
export const hasEvent = (db: DatabaseSync, id: number, kind: string) =>
  !!one(
    db,
    "SELECT 1 FROM task_events WHERE task_id=? AND kind=? LIMIT 1",
    id,
    kind,
  );
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
  const encoded =
    detail === undefined
      ? null
      : typeof detail === "string"
        ? detail
        : JSON.stringify(detail);
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)",
  ).run(id, at, kind, encoded);
  // 交付统计事实（#t123）随事件增量维护：只认统计相关的事件，其余这里直接返回。
  applyDeliveryEvent(db, id, kind, detail);
}
