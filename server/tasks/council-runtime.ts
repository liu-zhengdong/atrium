import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { taskDir } from "./active.ts";
import { clipBrief } from "./brief.ts";
import {
  councilOutcome,
  opinionsReady,
  parseSummary,
  summaryBrief,
  type CouncilOutcome,
} from "./council-gate.ts";
import { closeCouncil, OPEN_STAGES } from "./council-close.ts";
import {
  councilRow,
  opinionsOf,
  topicOf,
  type CouncilRow,
  type OpinionView,
} from "./councils.ts";
import { getTask, noteTask } from "./ledger.ts";
import { all, atomically, taskRef } from "./ledger-model.ts";

/**
 * 会审的编排（#322 第 3 步）：巡检时推进每场未定的会审。
 * - 等专员意见：意见任务都不再跑后，把各方意见写进汇总详述、议题任务转「leader 汇总中」，交调用方拉起；
 * - leader 汇总中：议题任务还是待办且没人在拉起（服务重启、拉起前退出）时再交调用方拉起；
 *   议题任务完成后读汇总，合成结局（已定／需用户拍板）记在议题上。
 * 汇总任务失败、受阻时照常投递，留在「汇总中」，重跑即可；议题任务取消时会审转「已关闭」，不再推进。
 */

export type CouncilDecision = {
  id: number;
  outcome: CouncilOutcome;
  opinions: OpinionView[];
};

export type CouncilProgress = {
  /** 要拉起 leader 汇总的议题任务短号。 */
  dispatch: string[];
  /** 本轮出了结局的会审。 */
  decided: CouncilDecision[];
};

export function settleCouncils(
  db: DatabaseSync,
  data: string,
  busy: (id: number) => boolean = () => false,
  limit = 50,
): CouncilProgress {
  const progress: CouncilProgress = { dispatch: [], decided: [] };
  closeStale(db, limit);
  // 按议题分页走完全部未定的会审：前面的卡着（等不来的意见、汇总失败）也挤不掉后面的。
  let after = 0;
  while (true) {
    const open = all<CouncilRow & { status: string }>(
      db,
      `SELECT c.*, t.status AS status FROM task_councils c JOIN tasks t ON t.id=c.task_id
        WHERE c.stage IN ${OPEN_STAGES} AND c.task_id>? AND t.status!='cancelled'
        ORDER BY c.task_id LIMIT ?`,
      after,
      limit,
    );
    for (const council of open) settleOne(db, data, busy, council, progress);
    if (open.length < limit) break;
    after = open.at(-1)!.task_id;
  }
  return progress;
}

/**
 * 未定会审里议题任务已取消、或还在等意见就已完成的。CROSS JOIN 固定先按阶段索引取未定的会审、
 * 再按主键查任务；否则规划器会按状态扫全部已完成任务（每轮随任务总数变慢，t154）。
 */
export const CLOSE_STALE_SQL = `SELECT c.task_id, t.status FROM task_councils c CROSS JOIN tasks t ON t.id=c.task_id
  WHERE c.stage IN ${OPEN_STAGES}
    AND (t.status='cancelled' OR (c.stage='opinions' AND t.status='done'))
  ORDER BY c.task_id LIMIT ?`;

/**
 * 议题任务已取消、或还在等意见就被改成完成的会审，转「已关闭」。
 * 取消时状态转移已顺手关闭；这里补上老库里早先卡住的，每轮至多关 limit 场。
 */
function closeStale(db: DatabaseSync, limit: number) {
  const stale = all<{ task_id: number; status: string }>(
    db,
    CLOSE_STALE_SQL,
    limit,
  );
  for (const { task_id, status } of stale)
    atomically(db, () =>
      closeCouncil(
        db,
        task_id,
        status === "cancelled" ? "议题任务已取消" : "议题任务已结束",
      ),
    );
}

function settleOne(
  db: DatabaseSync,
  data: string,
  busy: (id: number) => boolean,
  council: CouncilRow & { status: string },
  progress: CouncilProgress,
) {
  const id = council.task_id;
  if (council.stage === "opinions") {
    const members = all<{ opinion_id: number; status: string }>(
      db,
      `SELECT m.opinion_id, t.status FROM council_members m JOIN tasks t ON t.id=m.opinion_id
        WHERE m.task_id=? ORDER BY m.pos LIMIT 50`,
      id,
    );
    if (
      !opinionsReady(
        members.map((m) => ({ status: m.status, busy: busy(m.opinion_id) })),
      )
    )
      return;
    if (busy(id)) return;
    openSummary(db, data, id);
    progress.dispatch.push(taskRef(id));
    return;
  }
  if (busy(id)) return;
  if (council.status === "todo") progress.dispatch.push(taskRef(id));
  else if (council.status === "done") {
    const decision = decide(db, id);
    if (decision) progress.decided.push(decision);
  }
}

/** 意见收齐：写汇总详述（含各方意见原文）、议题任务的详述换成它、阶段转汇总中。 */
function openSummary(db: DatabaseSync, data: string, id: number) {
  const topic = topicOf(db, id);
  const opinions = opinionsOf(db, id);
  const council = councilRow(db, id)!;
  const dir = taskDir(data, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const brief = join(dir, "council-summary.md");
  const text = clipBrief(summaryBrief(topic, opinions, council.comment === 1));
  writeFileSync(brief, text, { mode: 0o600 });
  atomically(db, () => {
    db.prepare(
      "UPDATE task_councils SET stage='summarizing' WHERE task_id=? AND stage='opinions'",
    ).run(id);
    db.prepare(
      "UPDATE tasks SET brief=?,brief_path=?,updated_at=? WHERE id=?",
    ).run(text, brief, Date.now(), id);
    noteTask(db, id, "council_opinions", {
      opinions: opinions.map((o) => ({
        concern: o.ref,
        name: o.name,
        task: o.task,
        stance: o.stance,
        reason: o.reason,
      })),
    });
  });
}

/** 汇总完成：读 leader 摘要合成结局，记在议题上。 */
function decide(db: DatabaseSync, id: number): CouncilDecision | null {
  const task = getTask(db, id);
  const opinions = opinionsOf(db, id);
  const summary = parseSummary(task.result ?? "");
  const outcome = councilOutcome(summary, opinions);
  const now = Date.now();
  const changed = atomically(db, () => {
    const { changes } = db
      .prepare(
        "UPDATE task_councils SET stage=?,conclusion=?,escalate=?,agreed=?,conflicts=?,decided_by=?,decided_at=? WHERE task_id=? AND stage='summarizing'",
      )
      .run(
        outcome.kind,
        outcome.conclusion,
        JSON.stringify(outcome.escalate),
        JSON.stringify(summary.agreed),
        JSON.stringify(summary.conflicts),
        outcome.kind === "decided" ? "leader" : null,
        now,
        id,
      );
    if (!changes) return false;
    noteTask(db, id, `council_${outcome.kind}`, {
      conclusion: outcome.conclusion,
      ...(outcome.escalate.length ? { escalate: outcome.escalate } : {}),
    });
    return true;
  });
  return changed ? { id, outcome, opinions } : null;
}
