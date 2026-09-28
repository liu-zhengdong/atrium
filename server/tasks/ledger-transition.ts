import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Problem } from "../problem.ts";
import { FINISHED, transition, type TaskEvent } from "./state.ts";
import {
  addEvent,
  atomically,
  parseTaskRef,
  requireRow,
  RESULT_MAX_BYTES,
  taskRef,
  view,
  type Task,
  type TaskRow,
} from "./ledger-model.ts";
import {
  endDelivery,
  markDeliveryFinal,
  startDelivery,
} from "./delivery-records.ts";
import { noteView } from "./notes.ts";
import { syncTotals } from "./rollup-ledger.ts";

/** 执行者这一侧可以随状态一起写入的运行字段。 */
export type RunFields = Partial<
  Pick<
    TaskRow,
    | "worker"
    | "pid"
    | "host_id"
    | "worktree"
    | "branch"
    | "pr_url"
    | "ci"
    | "result"
  >
>;
const RUN_FIELDS = [
  "worker",
  "pid",
  "host_id",
  "worktree",
  "branch",
  "pr_url",
  "ci",
  "result",
] as const;

/** 结果摘要只留末尾 4 KB（按 UTF-8 字节，不切断字符）。 */
export function clipResult(text: string) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= RESULT_MAX_BYTES) return text;
  let start = bytes.length - RESULT_MAX_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export function applyTransition(
  db: DatabaseSync,
  current: TaskRow,
  event: TaskEvent,
  now: number,
  fields: RunFields = {},
  detail?: unknown,
) {
  const next = transition(current.status, event);
  if (!next.ok)
    throw new Problem(
      409,
      `${taskRef(current.id)}：${next.reason}`,
      "conflict",
      undefined,
      `atrium task show ${taskRef(current.id)}`,
    );
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  for (const key of RUN_FIELDS)
    if (key in fields) {
      sets.push(`${key}=?`);
      const value = fields[key] ?? null;
      params.push(
        key === "result" && typeof value === "string"
          ? clipResult(value)
          : value,
      );
    }
  if (next.changed) {
    sets.push("status=?");
    params.push(next.status);
    if (next.status === "running") {
      sets.push("started_at=?", "ended_at=NULL");
      params.push(now);
    }
    if (FINISHED.has(next.status)) {
      sets.push("ended_at=?");
      params.push(now);
    }
    if (next.status === "todo" || next.status === "blocked")
      sets.push("ended_at=NULL");
  }
  if (sets.length) {
    db.prepare(
      `UPDATE tasks SET ${sets.join(",")},updated_at=? WHERE id=?`,
    ).run(...params, now, current.id);
  }
  if (next.changed || sets.length)
    addEvent(db, current.id, now, event.kind, {
      from: current.status,
      to: next.status,
      ...(detail === undefined ? {} : { detail }),
    });
  if (next.changed && next.status === "running" && fields.worker) {
    const event = db
      .prepare(
        "SELECT id FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(current.id) as { id: number };
    startDelivery(
      db,
      current,
      event.id,
      fields.worker,
      typeof (detail as { risk?: unknown } | undefined)?.risk === "string"
        ? (detail as { risk: string }).risk
        : null,
      now,
    );
    db.prepare("UPDATE tasks SET worker_effort=?,worker_risk=? WHERE id=?").run(
      fields.worker.includes(":")
        ? (fields.worker.split(":").at(-1) ?? null)
        : null,
      typeof (detail as { risk?: unknown } | undefined)?.risk === "string"
        ? (detail as { risk: string }).risk
        : null,
      current.id,
    );
  }
  if (
    next.changed &&
    (next.status === "done" ||
      next.status === "failed" ||
      next.status === "cancelled" ||
      next.status === "blocked")
  ) {
    endDelivery(db, current.id, event.kind, now);
    if (next.status === "cancelled" || next.status === "failed")
      markDeliveryFinal(db, current.id, next.status);
  }
  // 总任务（t190）：上面每层总任务的状态跟着子孙走，同一事务里改。
  if (next.changed) syncTotals(db, current.id, now);
  return next.status;
}

/**
 * 给执行者一侧（run / stop / 退出回收 / 重启自愈）用：按事件转移并一并写运行字段。
 * 拒绝时抛 409，数据不变。
 */
export function advanceTask(
  db: DatabaseSync,
  reference: unknown,
  event: TaskEvent,
  fields: RunFields = {},
  detail?: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  return atomically(db, () => {
    applyTransition(db, requireRow(db, id), event, now, fields, detail);
    const task = requireRow(db, id);
    return { ...view(task), ...noteView(db, id, task.status) };
  });
}

/** 只改运行字段、不改状态（如 CI 轮询写回 ci），并记一条事件。 */
export function patchRunFields(
  db: DatabaseSync,
  reference: unknown,
  fields: RunFields,
  kind: string,
  detail?: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  return atomically(db, () => {
    requireRow(db, id);
    const keys = RUN_FIELDS.filter((key) => key in fields);
    if (keys.length)
      db.prepare(
        `UPDATE tasks SET ${keys.map((key) => `${key}=?`).join(",")},updated_at=? WHERE id=?`,
      ).run(
        ...keys.map((key) => {
          const value = fields[key] ?? null;
          return key === "result" && typeof value === "string"
            ? clipResult(value)
            : value;
        }),
        now,
        id,
      );
    addEvent(db, id, now, kind, detail);
    const task = requireRow(db, id);
    return { ...view(task), ...noteView(db, id, task.status) };
  });
}

/** 只记事件、不改状态（如日志里发现 PR）。 */
export function noteTask(
  db: DatabaseSync,
  reference: unknown,
  kind: string,
  detail?: unknown,
  now = Date.now(),
) {
  const id = parseTaskRef(reference);
  requireRow(db, id);
  addEvent(db, id, now, kind, detail);
}
