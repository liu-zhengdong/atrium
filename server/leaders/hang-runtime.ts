import type { DatabaseSync } from "node:sqlite";
import type { EventInbox } from "../tasks/events.ts";
import { all, taskRef, type TaskRow } from "../tasks/ledger-model.ts";
import { noteTask } from "../tasks/ledger.ts";
import { holderFacts } from "../tasks/holder-facts.ts";
import { holderOf } from "../tasks/holder.ts";
import { urgentFlowStages } from "../tasks/urgent-ledger.ts";
import { registeredLeaders } from "./model.ts";
import { escalationDetail } from "./route.ts";
import { upstreamRoute } from "./subscriber.ts";
import { ESCALATE_KINDS } from "./wake.ts";
import { hangEscalateNote, hangStep, nudgeNote } from "./hang.ts";

/**
 * 挂在 leader 手里的受阻任务（t253）：到时限再叫醒持球的 leader 一次（事件 hanging，任务记 hang_nudged），
 * 叫醒后再过同样时长仍没动，运行时代为上交上一层（事件 escalated，任务记 escalated，from=runtime）。
 * 判定在 hang.ts；持球人与起算时刻沿用 holder-facts.ts。每页 200 件受阻任务，走部分索引 tasks_open。
 */

const PAGE = 200;
const BLOCKED_SQL = `SELECT * FROM tasks WHERE id>? AND status NOT IN ('done','cancelled') AND status='blocked'
  ORDER BY id LIMIT ${PAGE}`;

export function patrolHanging(
  db: DatabaseSync,
  inbox: EventInbox,
  options: { now: number; afterMs: number },
): { nudged: string[]; escalated: string[] } {
  const result = { nudged: [] as string[], escalated: [] as string[] };
  if (!(options.afterMs > 0)) return result;
  const registered = registeredLeaders(db);
  const urgentFlow = urgentFlowStages(db, options.now);
  const afterMinutes = Math.round(options.afterMs / 60_000);
  let after = 0;
  for (;;) {
    const rows = all<TaskRow>(db, BLOCKED_SQL, after);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const facts = holderFacts(
        db,
        row,
        null,
        { inbox: true, urgentFlow },
        undefined,
        options.now,
      );
      const holder = holderOf(facts);
      if (holder?.kind !== "leader" || !holder.who || facts.held_since == null)
        continue;
      const leader = holder.who;
      const step = hangStep({
        since: facts.held_since,
        nudgedAt: facts.hang_nudged ?? null,
        now: options.now,
        afterMs: options.afterMs,
        registered: registered.has(leader),
      });
      if (step.kind === "none") continue;
      const ref = taskRef(row.id);
      if (step.kind === "nudge") {
        const note = nudgeNote({
          task: ref,
          leader,
          minutes: step.minutes,
          afterMinutes,
          holder: holder.text,
        });
        inbox.publish({
          subscriber: leader,
          taskId: row.id,
          source: "runtime",
          kind: "hanging",
          key: `${ref}:hanging`,
          detail: {
            title: row.title,
            minutes: step.minutes,
            holder: holder.text,
            note,
            routed: { to: leader, why: `任务在 ${leader} 手里挂着没动` },
          },
        });
        noteTask(
          db,
          row.id,
          "hang_nudged",
          { leader, minutes: step.minutes },
          options.now,
        );
        result.nudged.push(ref);
        continue;
      }
      const route = upstreamRoute(db, leader);
      const detail = {
        ...escalationDetail({
          leader,
          kind: "stuck",
          label: ESCALATE_KINDS.stuck,
          note: hangEscalateNote({
            task: ref,
            leader,
            minutes: step.minutes,
            nudged: registered.has(leader),
            holder: holder.text,
          }),
          task: { ref, title: row.title, pr_url: row.pr_url },
          forward: null,
          route,
        }),
        title:
          `${ref} 在 ${leader} 手里挂了 ${step.minutes} 分钟，运行时上交：${row.title}`.slice(
            0,
            200,
          ),
        by: "runtime",
      };
      inbox.publish({
        subscriber: route.subscriber,
        taskId: row.id,
        source: "runtime",
        kind: "escalated",
        key: `${ref}:hang:escalate`,
        detail,
      });
      noteTask(
        db,
        row.id,
        "escalated",
        { ...detail, from: "runtime", leader, to: route.subscriber },
        options.now,
      );
      result.escalated.push(ref);
    }
    if (rows.length < PAGE) break;
  }
  return result;
}
