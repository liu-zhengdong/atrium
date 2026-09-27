import type { DatabaseSync } from "node:sqlite";
import { taskRoute } from "../leaders/subscriber.ts";
import {
  all,
  one,
  taskRef,
  type TaskEventRow,
  type TaskRow,
} from "./ledger-model.ts";
import { holderOf, type Holder, type HolderFacts } from "./holder.ts";
import { scheduleOf } from "./schedule.ts";

/** 从账本、收件箱、会审表取「球在谁手里」的事实；判定在 holder.ts。每个任务查询有界。 */

const KINDS = [
  "block",
  "tell",
  "start",
  "merge_returned",
  "escalated",
  "note",
] as const;

function parse(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const value: unknown = JSON.parse(detail);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** 状态转移记的事件把原因包在 detail 里，noteTask 记的放在顶层；两种都认。 */
function blockOf(event: TaskEventRow) {
  const outer = parse(event.detail);
  const inner =
    outer.detail && typeof outer.detail === "object"
      ? (outer.detail as Record<string, unknown>)
      : {};
  const gates = Array.isArray(inner.gates) ? inner.gates : [];
  return {
    reason: text(inner.reason) ?? text(outer.reason),
    gates: gates.filter((g): g is string => typeof g === "string"),
  };
}

const hasTable = (db: DatabaseSync, name: string) =>
  !!one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export function holderFacts(
  db: DatabaseSync,
  row: TaskRow,
  queued: { reason: string | null } | null,
  tables = { inbox: hasTable(db, "task_inbox") },
): HolderFacts {
  // 倒序取最近几十条相关事件，再按时间正序看。
  const events = all<TaskEventRow>(
    db,
    `SELECT * FROM task_events WHERE task_id=? AND kind IN (${KINDS.map(() => "?").join(",")})
      ORDER BY id DESC LIMIT 40`,
    row.id,
    ...KINDS,
  ).reverse();
  const last = (kind: string, after = 0) =>
    events.findLast((e) => e.kind === kind && e.id > after);
  const block = last("block");
  const mergeBack = last("merge_returned");
  // 最近一次「被挡回」：受阻或合入交回，之后的动作才算接手。
  const setback =
    block && mergeBack
      ? block.id > mergeBack.id
        ? block
        : mergeBack
      : (block ?? mergeBack);
  const since = setback?.id ?? 0;
  const start = setback ? last("start", since) : undefined;
  let returned: HolderFacts["returned"] = null;
  if (setback && start && row.status === "running") {
    if (setback.kind === "merge_returned")
      returned = { by: null, via: "merge" };
    else {
      const tell = events.findLast(
        (e) => e.kind === "tell" && e.id > since && e.id < start.id,
      );
      returned = tell
        ? { by: text(parse(tell.detail).by), via: "tell" }
        : { by: null, via: "rerun" };
    }
  }
  const escalation = block ? last("escalated", block.id) : undefined;
  const escalated = escalation
    ? (() => {
        const detail = parse(escalation.detail);
        const to = text(detail.to);
        return to ? { to, from: text(detail.from) ?? "leader" } : null;
      })()
    : null;
  const note = block ? last("note", block.id) : undefined;
  const inbox =
    row.status === "blocked" && block && tables.inbox
      ? one<{ subscriber: string; acked_at: number | null }>(
          db,
          "SELECT subscriber,acked_at FROM task_inbox WHERE task_id=? AND created_at>=? ORDER BY id DESC LIMIT 1",
          row.id,
          block.at,
        )
      : undefined;
  const council = one<{ stage: string }>(
    db,
    "SELECT stage FROM task_councils WHERE task_id=?",
    row.id,
  );
  return {
    status: row.status,
    delivery_stage: row.delivery_stage,
    online_wait: row.online_wait,
    worker: row.worker,
    queued,
    review_task: row.review_task ? taskRef(row.review_task) : null,
    schedule_state: row.schedule_state,
    schedule_reason: row.schedule_reason,
    waiting_for:
      row.status === "todo" && row.schedule_state === "waiting"
        ? scheduleOf(db, row).waiting_for
        : [],
    auto: row.auto === 1,
    block: block ? blockOf(block) : null,
    returned,
    merge_returned: mergeBack ? text(parse(mergeBack.detail).reason) : null,
    escalated,
    processing_by: note ? text(parse(note.detail).by) : null,
    inbox: inbox
      ? { subscriber: inbox.subscriber, acked: inbox.acked_at !== null }
      : null,
    route: taskRoute(db, row).subscriber,
    council_escalated: council?.stage === "escalated",
  };
}

export function holderFor(
  db: DatabaseSync,
  row: TaskRow,
  queued: { reason: string | null } | null,
): Holder | null {
  return holderOf(holderFacts(db, row, queued));
}
