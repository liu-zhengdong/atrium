import type { DatabaseSync } from "node:sqlite";
import { addEvent } from "./ledger-model.ts";

/**
 * 会审随议题任务收尾（t129）：议题任务取消（或在等意见时就被改成完成）后，未定的会审转「已关闭」，
 * 不再占着巡检、也不会被再拉起。只依赖 ledger-model，供状态转移在同一事务里调用。
 */

export const OPEN_STAGES = "('opinions','summarizing')";

/** 关闭一场未定的会审；已定、已上交或已关闭的不动。返回是否关了。 */
export function closeCouncil(
  db: DatabaseSync,
  id: number,
  reason: string,
  now = Date.now(),
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE task_councils SET stage='closed',conclusion=?,decided_at=? WHERE task_id=? AND stage IN ${OPEN_STAGES}`,
    )
    .run(reason, now, id);
  if (!changes) return false;
  addEvent(db, id, now, "council_closed", { reason });
  return true;
}
