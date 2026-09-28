import type { DatabaseSync } from "node:sqlite";
import { taskRoute } from "../leaders/subscriber.ts";
import { runningHostNames } from "../hosts/model.ts";
import {
  all,
  one,
  taskRef,
  type TaskEventRow,
  type TaskRow,
} from "./ledger-model.ts";
import {
  holderDetail,
  holderOf,
  type Holder,
  type HolderFacts,
} from "./holder.ts";
import { scheduleOf } from "./schedule.ts";
import { urgentInMergeFlow } from "./urgent-ledger.ts";

/** 从账本、收件箱、会审表取「球在谁手里」的事实；判定在 holder.ts。每个任务查询有界。 */

const KINDS = [
  "block",
  "tell",
  "start",
  "merge_returned",
  "escalated",
  "note",
  "local_check_started",
  "local_check",
  "merge_check_started",
  "merge_check",
  "preempted",
  "merge_check_rerun",
  "merge_queued",
  "merge_blocked",
  "merge_check_quiet",
  "worker_quiet",
  "hang_nudged",
  "host_moved",
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
  tables: { inbox: boolean; urgentFlow?: readonly number[] } = {
    inbox: hasTable(db, "task_inbox"),
  },
  hosts?: ReadonlyMap<number, string>,
  now = Date.now(),
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
  // 合入队列转卡住（MergeHold、检查没跑成用尽重跑）只记 merge_blocked，同样算受阻。
  const block = [last("block"), last("merge_blocked")]
    .filter((e) => e !== undefined)
    .reduce<TaskEventRow | undefined>(
      (latest, e) => (!latest || e.id > latest.id ? e : latest),
      undefined,
    );
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
  // 正在跑的检查（#358 第 2 步）：开始了、还没出结果；在哪台跑记在开始事件里。
  // 出了结果或记了「没跑成，等重跑」都算这一轮结束。
  const checkingOf = (started: string, done: string, after = 0) => {
    const begin = last(started, after);
    if (!begin || last(done, begin.id) || last(`${done}_rerun`, begin.id))
      return null;
    return { host: text(parse(begin.detail).host) };
  };
  // 掉线超时改派（t184）：任务一直在跑、没有新的 start，改派这一刻也算新一轮的开始。
  const movedAt = last("host_moved");
  const runStart = Math.max(last("start")?.id ?? 0, movedAt?.id ?? 0);
  const checking =
    row.delivery_stage === "merging"
      ? checkingOf("merge_check_started", "merge_check")
      : row.status === "running"
        ? checkingOf("local_check_started", "local_check", runStart)
        : null;
  // 改派后这一轮还在跑：之后没再受阻、没被交回、没重新派。
  const moved =
    row.status === "running" &&
    movedAt &&
    movedAt.id > since &&
    !last("start", movedAt.id)
      ? text(parse(movedAt.detail).reason)
      : null;
  // 检查没跑成、在等重跑（t204）：记了重跑、之后还没开始下一轮检查。
  const rerunOf = (kind: string, started: string, after = 0) => {
    const mark = last(kind, after);
    if (!mark || last(started, mark.id)) return null;
    const detail = parse(mark.detail);
    return {
      attempt: typeof detail.attempt === "number" ? detail.attempt : 1,
      reason: text(detail.reason),
    };
  };
  const rerun =
    !checking && row.delivery_stage === "merge_queued"
      ? rerunOf(
          "merge_check_rerun",
          "merge_check_started",
          last("merge_queued")?.id,
        )
      : null;
  // 没进展提醒（t260）：这一轮检查或这一轮执行者最新一条提醒，之后没记「又有输出了」。
  const quietOf = (kind: string, after: number | undefined) => {
    const mark = after === undefined ? undefined : last(kind, after);
    const detail = mark ? parse(mark.detail) : null;
    return detail && detail.resumed !== true ? detail : null;
  };
  const checkQuiet =
    row.delivery_stage === "merging" && checking
      ? text(
          quietOf("merge_check_quiet", last("merge_check_started")?.id)?.reason,
        )
      : null;
  const workerQuiet =
    row.status === "running" && !checking
      ? quietOf("worker_quiet", runStart)?.quiet_ms
      : null;
  const escalation = block ? last("escalated", block.id) : undefined;
  const escalated = escalation
    ? (() => {
        const detail = parse(escalation.detail);
        const to = text(detail.to);
        return to ? { to, from: text(detail.from) ?? "leader" } : null;
      })()
    : null;
  const note = block ? last("note", block.id) : undefined;
  // 球到现在这位手里的时刻（t253）：被上交给它的算上交那一刻，否则算受阻那一刻；叫醒记录只认这一段里的。
  const heldFrom =
    row.status === "blocked" ? (escalated ? escalation : block) : undefined;
  const nudged = heldFrom ? last("hang_nudged", heldFrom.id) : undefined;
  // 取「任务受阻后最新一条收件箱记录」；若它正好是被保留清理清掉的已确认知会（#t126），
  // 会退回去读更早的一条，只影响「这次由谁接手」的展示，不影响判定。
  const inbox =
    row.status === "blocked" && block && tables.inbox
      ? one<{ subscriber: string; acked_at: number | null }>(
          db,
          "SELECT subscriber,acked_at FROM task_inbox WHERE task_id=? AND created_at>=? ORDER BY id DESC LIMIT 1",
          row.id,
          block.at,
        )
      : undefined;
  // 被紧急任务抢占暂停（t215）：受阻就是因为它、之后还没再拉起。
  const preemptedAt = last("preempted");
  const preempted =
    row.status === "blocked" &&
    preemptedAt &&
    preemptedAt.id >= since &&
    !last("start", preemptedAt.id)
      ? { by: text(parse(preemptedAt.detail).by) }
      : null;
  // 普通任务排队合入时，有紧急任务在合入流程里就暂停（merge-runtime 同一判定）。
  const heldBy =
    row.delivery_stage === "merge_queued" && row.urgent !== 1
      ? (tables.urgentFlow ?? urgentInMergeFlow(db))
          .filter((id) => id !== row.id)
          .map(taskRef)
      : [];
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
    host:
      row.status === "running" && row.host_id != null && row.host_id !== 1
        ? ((hosts ?? runningHostNames(db, [row.host_id])).get(row.host_id) ??
          null)
        : null,
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
    checking,
    moved,
    preempted,
    merge_held_by: heldBy,
    rerun,
    check_quiet: checkQuiet,
    worker_quiet_ms:
      typeof workerQuiet === "number" && workerQuiet > 0 ? workerQuiet : null,
    held_since: heldFrom?.at ?? null,
    hang_nudged: nudged?.at ?? null,
    now,
  };
}

/** 单个任务视图（`task show`）用：一句话之外附上原因全文。 */
export function holderFor(
  db: DatabaseSync,
  row: TaskRow,
  queued: { reason: string | null } | null,
  now = Date.now(),
): Holder | null {
  const facts = holderFacts(
    db,
    row,
    queued,
    { inbox: hasTable(db, "task_inbox") },
    undefined,
    now,
  );
  const holder = holderOf(facts);
  return holder ? { ...holder, detail: holderDetail(facts) } : null;
}
