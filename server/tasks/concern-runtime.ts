import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { taskDir } from "./active.ts";
import { clipBrief } from "./brief.ts";
import { awaitingCi } from "./ci-poll.ts";
import {
  concernOutcome,
  reviewBrief,
  reviewConclusion,
  type ConcernOutcome,
  type ConcernState,
} from "./concern-gate.ts";
import { checklistOf, concernRows, concernsOf } from "./concerns.ts";
import type { Facts } from "./gates.ts";
import {
  advanceTask,
  createTask,
  getTask,
  noteTask,
  taskRef,
  type Task,
} from "./ledger.ts";
import { all, one } from "./ledger-model.ts";
import { reasonOf } from "./top.ts";
import type { TaskEventRow } from "./ledger-model.ts";

/**
 * 专员关卡的执行（#322 第 2 步）：父任务的其余关卡通过后，给每位被请的专员建一个一次性的审查任务（子任务，
 * 记在关注点节点上，只交摘要），父任务转受阻「等专员审查」；审查任务不再跑后读它的结论记账，
 * 全部出结论时按 concern-gate.ts 合成：全通过补判通过，任一否决或没出结论则留在受阻并写原因。
 */

const TITLE_MAX = 200;
const clipTitle = (text: string) =>
  Array.from(text).length > TITLE_MAX
    ? `${Array.from(text)
        .slice(0, TITLE_MAX - 1)
        .join("")}…`
    : text;

/** 父任务关卡通过后要等的专员（审查任务自己不再请专员）。 */
export function invitedFor(db: DatabaseSync, id: number): number[] {
  if (reviewRowOf(db, id)) return [];
  return concernRows(db, id).map((row) => row.node_id);
}

const reviewRowOf = (db: DatabaseSync, id: number) =>
  one<{ task_id: number }>(
    db,
    "SELECT task_id FROM task_concerns WHERE review_id=? LIMIT 1",
    id,
  );

export const isReviewTask = (db: DatabaseSync, id: number) =>
  !!reviewRowOf(db, id);

/**
 * 开本轮审查：每位专员建一个审查任务（详述写进父任务目录），记下 review_id、清掉上一轮结论。
 * 返回审查任务短号；拉起由调用方做（dispatch），拉不起的由 blockUnsent 标受阻，再由 settleReviews 判没出结论。
 */
export function openReviews(
  db: DatabaseSync,
  data: string,
  parentId: number,
  facts?: Facts,
): string[] {
  const parent = getTask(db, parentId);
  const dir = taskDir(data, parentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const diff = facts
    ? {
        files: facts.numstat.length,
        added: facts.numstat.reduce((sum, s) => sum + s.added, 0),
        removed: facts.numstat.reduce((sum, s) => sum + s.removed, 0),
        list: facts.numstat.map(
          (s) => `${s.file}（+${s.added} −${s.removed}）`,
        ),
      }
    : undefined;
  const refs: string[] = [];
  const now = Date.now();
  for (const row of concernRows(db, parentId)) {
    const checklist = checklistOf(db, row.node_id);
    const brief = join(dir, `concern-${checklist.ref}-${now}.md`);
    const text = clipBrief(
      reviewBrief({
        checklist,
        task: { ref: parent.ref, title: parent.title },
        pr_url: parent.pr_url,
        worktree: parent.worktree,
        branch: parent.branch,
        base: facts?.base ?? null,
        diff,
      }),
    );
    writeFileSync(brief, text, { mode: 0o600 });
    const review = createTask(db, {
      title: clipTitle(
        `专员审查：${checklist.name} · ${parent.ref} ${parent.title}`,
      ),
      parent: parent.ref,
      ...(row.node_id < 0 ? { job: checklist.ref } : { role: checklist.ref }),
      deliver: "none",
      brief: text,
      brief_path: brief,
      ...(parent.owner ? { owner: parent.owner } : {}),
      ...(parent.part_ref ? { part: parent.part_ref } : {}),
    });
    db.prepare(
      "UPDATE task_concerns SET review_id=?,verdict=NULL,reason=NULL,decided_at=NULL WHERE task_id=? AND node_id=?",
    ).run(review.id, parentId, row.node_id);
    refs.push(review.ref);
  }
  noteTask(db, parentId, "concern_review_started", {
    reviews: concernsOf(db, parentId).map((c) => ({
      concern: c.ref,
      name: c.name,
      review: c.review,
    })),
  });
  return refs;
}

/** 审查任务拉不起来：标受阻并写原因，随后由 settleReviews 判为没出结论。 */
export function blockUnsent(db: DatabaseSync, ref: string, reason: string) {
  const task = getTask(db, ref);
  if (task.status === "todo")
    advanceTask(
      db,
      ref,
      { kind: "block" },
      {},
      {
        reason: `审查任务拉不起来：${reason}`,
      },
    );
}

export type ReviewResolution = {
  parent: number;
  outcome: Exclude<ConcernOutcome, { kind: "none" | "waiting" }>;
  concerns: ConcernState[];
  /** 通过后已补判父任务为完成。 */
  accepted: boolean;
};

type Pending = {
  task_id: number;
  node_id: number;
  review_id: number;
  status: string;
  result: string | null;
  updated_at: number;
};

/**
 * 扫一遍不再跑的审查任务：把结论记到父任务的专员行（审查任务重跑后结论跟着更新），
 * 父任务仍在受阻且本轮全部出了结论时合成去向。busy 为正在拉起、收尾或排队中的任务，先不判。
 */
export function settleReviews(
  db: DatabaseSync,
  busy: (id: number) => boolean = () => false,
  limit = 50,
): ReviewResolution[] {
  const rows = all<Pending>(
    db,
    `SELECT c.task_id, c.node_id, c.review_id, r.status, r.result, r.updated_at
       FROM task_concerns c JOIN tasks r ON r.id=c.review_id
      WHERE r.status IN ('done','failed','cancelled','blocked')
        AND (c.decided_at IS NULL OR r.updated_at > c.decided_at)
      ORDER BY c.task_id, c.pos LIMIT ?`,
    limit,
  );
  const parents = new Set<number>();
  for (const row of rows) {
    if (busy(row.review_id)) continue;
    const blockedReason =
      row.status === "blocked" || row.status === "failed"
        ? lastReason(
            db,
            row.review_id,
            row.status === "blocked" ? "block" : "exit_fail",
          )
        : null;
    const conclusion = reviewConclusion(row.status, row.result, blockedReason);
    if (!conclusion) continue;
    db.prepare(
      "UPDATE task_concerns SET verdict=?,reason=?,decided_at=? WHERE task_id=? AND node_id=? AND review_id=?",
    ).run(
      conclusion.verdict,
      conclusion.reason,
      row.updated_at,
      row.task_id,
      row.node_id,
      row.review_id,
    );
    noteTask(db, row.task_id, "concern_review", {
      concern: row.node_id < 0 ? `r${-row.node_id}` : `o${row.node_id}`,
      review: taskRef(row.review_id),
      verdict: conclusion.verdict,
      reason: conclusion.reason,
    });
    parents.add(row.task_id);
  }
  const resolved: ReviewResolution[] = [];
  for (const id of parents) {
    const parent = getTask(db, id);
    const concerns = concernsOf(db, id);
    const outcome = concernOutcome(concerns);
    if (outcome.kind === "none" || outcome.kind === "waiting") continue;
    // 人工改过状态（完成、取消、重跑）的父任务不再补判。
    if (parent.status !== "blocked") continue;
    if (outcome.kind === "passed") {
      const ciPending = awaitingCi(db, id) && parent.ci !== "success";
      noteTask(db, id, "concern_gate", {
        passed: true,
        reason: outcome.reason,
        ...(ciPending ? { awaiting_ci: true } : {}),
      });
      if (ciPending) continue;
      advanceTask(db, id, { kind: "accept" }, {}, { reason: outcome.reason });
      resolved.push({ parent: id, outcome, concerns, accepted: true });
    } else {
      noteTask(db, id, "concern_gate", {
        passed: false,
        vetoed: outcome.kind === "vetoed",
        reason: outcome.reason,
      });
      resolved.push({ parent: id, outcome, concerns, accepted: false });
    }
  }
  return resolved;
}

function lastReason(db: DatabaseSync, id: number, kind: string) {
  return reasonOf(
    all<TaskEventRow>(
      db,
      "SELECT * FROM task_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
      id,
      kind,
    ),
    kind,
  );
}
