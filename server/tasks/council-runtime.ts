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
 * 汇总任务失败、受阻或取消时照常投递，留在「汇总中」，重跑即可。
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
  const open = all<CouncilRow & { status: string }>(
    db,
    `SELECT c.*, t.status AS status FROM task_councils c JOIN tasks t ON t.id=c.task_id
      WHERE c.stage IN ('opinions','summarizing') ORDER BY c.task_id LIMIT ?`,
    limit,
  );
  for (const council of open) {
    const id = council.task_id;
    // 人工取消的会审不再推进。
    if (council.status === "cancelled") continue;
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
        continue;
      if (busy(id)) continue;
      openSummary(db, data, id);
      progress.dispatch.push(taskRef(id));
      continue;
    }
    if (busy(id)) continue;
    if (council.status === "todo") progress.dispatch.push(taskRef(id));
    else if (council.status === "done") {
      const decision = decide(db, id);
      if (decision) progress.decided.push(decision);
    }
  }
  return progress;
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
