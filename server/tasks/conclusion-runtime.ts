import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Active } from "./active.ts";
import { askText, shouldAsk, type ConclusionKind } from "./conclusion.ts";
import { noteTask } from "./ledger.ts";
import { one } from "./ledger-model.ts";
import type { Exit } from "./outcome.ts";
import { finalSummary } from "./settle.ts";
import { addTell } from "./tell-ledger.ts";

/**
 * 结论补答的运行时（t209）：执行者退出、收尾前，结论类任务读不出结论就登记一条运行时的捎话，
 * 随后由 followUpTells 续上原会话（不支持续上的带着补充重派），每轮至多一次。判定在 conclusion.ts。
 */

/** 这个任务要不要交固定格式的结论：审阅者、专员审查、会审意见、会审汇总；都走索引。 */
export function conclusionKindOf(
  db: DatabaseSync,
  id: number,
): ConclusionKind | undefined {
  if (one(db, "SELECT 1 FROM tasks WHERE review_task=? LIMIT 1", id))
    return "review";
  if (one(db, "SELECT 1 FROM task_concerns WHERE review_id=? LIMIT 1", id))
    return "concern";
  if (one(db, "SELECT 1 FROM council_members WHERE opinion_id=? LIMIT 1", id))
    return "opinion";
  if (
    one(
      db,
      "SELECT 1 FROM task_councils WHERE task_id=? AND stage='summarizing'",
      id,
    )
  )
    return "summary";
  return undefined;
}

/** 最近一次拉起以来已经要求过补答。 */
function askedThisRun(db: DatabaseSync, id: number) {
  return !!one(
    db,
    `SELECT 1 FROM task_events WHERE task_id=? AND kind='conclusion_asked'
       AND id > COALESCE((SELECT MAX(id) FROM task_events WHERE task_id=? AND kind='start'), 0) LIMIT 1`,
    id,
    id,
  );
}

/** 要补答就登记捎话并记一笔，返回 true；随后 followUpTells 负责续上。 */
export async function askConclusion(
  db: DatabaseSync,
  active: Active,
  exit: Exit,
): Promise<boolean> {
  const kind = conclusionKindOf(db, active.id);
  if (!kind || active.stop || askedThisRun(db, active.id)) return false;
  const text = await finalSummary(active);
  if (!shouldAsk({ kind, exit, stop: active.stop, asked: false, text }))
    return false;
  addTell(db, active.id, {
    text: askText(kind),
    by: "运行时",
    uuid: randomUUID(),
    route: "after_turn",
  });
  noteTask(db, active.id, "conclusion_asked", {
    kind,
    reason: "最后一行没有按格式写结论，请同一执行者补答一次",
  });
  return true;
}
