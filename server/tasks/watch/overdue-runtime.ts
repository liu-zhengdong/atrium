import type { DatabaseSync } from "node:sqlite";
import type { EventInbox } from "../events/events.ts";
import { all, taskRef, type TaskRow } from "../ledger/ledger-model.ts";
import { noteTask } from "../ledger/ledger.ts";
import { holderFacts } from "./holder-facts.ts";
import { holderOf } from "./holder.ts";
import { registeredLeaders } from "../../leaders/model.ts";
import { upstreamRoute } from "../../leaders/subscriber.ts";
import { CLOSING_ACTIONS } from "../../leaders/actions.ts";
import { publishTask } from "../events/notice.ts";
import { dueStep, overdueDetail } from "./overdue.ts";

/**
 * 持球与期限的巡检（overdue.ts 那张表里 leader 与发版两行；执行者、检查、秘书由各自在跑的看门狗按同一张表处理）：
 * - 受阻任务在 leader 手里：到期叫醒它一次（事件 overdue，任务记 overdue），再过一个时限仍没动，
 *   运行时代为上交上一层（事件 overdue step=escalate，任务记 escalated，from=runtime）；leader 已不在登记里的直接上交。
 * - 已合入等发版上线：到期告诉负责人去看发版工作流（同一段只说一次）。
 * 持球人与起算时刻沿用 holder-facts.ts。每页 200 件，走部分索引。
 */

const PAGE = 200;
const BLOCKED_SQL = `SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') AND status='blocked'
  ORDER BY id LIMIT ${PAGE}`;
const RELEASE_SQL = `SELECT * FROM tasks WHERE online_wait=1 AND delivery_stage='merged' AND id>?
  ORDER BY id LIMIT ${PAGE}`;

export function patrolOverdue(
  db: DatabaseSync,
  inbox: EventInbox,
  now = Date.now(),
): { woke: string[]; escalated: string[] } {
  const result = { woke: [] as string[], escalated: [] as string[] };
  const registered = registeredLeaders(db);
  for (const row of pages(db, BLOCKED_SQL)) {
    const facts = holderFacts(db, row, null, { inbox: true }, undefined, now);
    const holder = holderOf(facts);
    if (holder?.kind !== "leader" || !holder.who || facts.held_since == null)
      continue;
    const leader = holder.who;
    let step = dueStep({
      kind: "leader",
      since: facts.held_since,
      wokeAt: facts.overdue_at ?? null,
      now,
    });
    // 没登记的 leader 叫不醒：到期直接上交。
    if (step === "wake" && !registered.has(leader)) step = "escalate";
    if (step === "none") continue;
    const ref = taskRef(row.id);
    const heldMs = now - facts.held_since;
    if (step === "wake") {
      inbox.publish({
        subscriber: leader,
        taskId: row.id,
        source: "runtime",
        kind: "overdue",
        key: `${ref}:overdue`,
        detail: overdueDetail({
          kind: "leader",
          step,
          who: leader,
          heldMs,
          title: row.title,
          next: `以一个动作收尾（只写备注不算）：${CLOSING_ACTIONS.map((a) => a.replaceAll("tN", ref)).join("；")}`,
        }),
      });
      noteTask(db, row.id, "overdue", { holder: "leader", who: leader }, now);
      result.woke.push(ref);
      continue;
    }
    const route = upstreamRoute(db, leader);
    const detail = overdueDetail({
      kind: "leader",
      step,
      who: leader,
      heldMs,
      title: row.title,
      to: route.subscriber,
      next: `决定重派、改依赖、取消或换人：atrium task show ${ref}`,
    });
    inbox.publish({
      subscriber: route.subscriber,
      taskId: row.id,
      source: "runtime",
      kind: "overdue",
      key: `${ref}:overdue:escalate`,
      detail: { ...detail, routed: { to: route.subscriber, why: route.why } },
    });
    noteTask(
      db,
      row.id,
      "escalated",
      { reason: detail.reason, from: "runtime", leader, to: route.subscriber },
      now,
    );
    result.escalated.push(ref);
  }
  for (const row of pages(db, RELEASE_SQL)) {
    const facts = holderFacts(db, row, null, { inbox: true }, undefined, now);
    if (facts.merged_at == null) continue;
    const step = dueStep({
      kind: "release",
      since: facts.merged_at,
      wokeAt: facts.overdue_at ?? null,
      now,
    });
    if (step !== "wake") continue;
    noteTask(db, row.id, "overdue", { holder: "release" }, now);
    publishTask(
      inbox,
      db,
      row.id,
      "overdue",
      overdueDetail({
        kind: "release",
        step,
        who: null,
        heldMs: now - facts.merged_at,
        next: "查看仓库的发版工作流",
      }),
    );
    result.woke.push(taskRef(row.id));
  }
  return result;
}

/** 按 id 翻页取行，每页有界。 */
function* pages(db: DatabaseSync, sql: string) {
  for (let after = 0; ;) {
    const rows = all<TaskRow>(db, sql, after);
    yield* rows;
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.id;
  }
}
