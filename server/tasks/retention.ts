import type { DatabaseSync } from "node:sqlite";
import { all, one } from "./ledger-model.ts";

/**
 * 收件箱与任务事件的保留上限（#t126）。两张表都会只增不减：
 * - 收件箱：只有「已确认的知会类」按时间或条数清理（源头不是 leader 的上交/转交）；
 *   要处理的事件、未确认的事件、leader 的上交/转交记录一律留着。
 * - 任务事件：只清已结束（done/failed/cancelled）且任务本身超过时间上限的；每个任务至少保留
 *   最近 eventTail 条，以及最近一次 start 之后的事件（最新一轮交付窗口）。这样
 *   task show（按 task_id 有界取最近）、交付统计（按 start 切窗口）、换执行者判断（取最新事实）
 *   读到的最近事实都不变；更早的历史明细会随时间被清掉，这是保留上限的本意。
 *
 * task_events 的读者（grep 全仓）：ledger-read/notes/queue/top/holder-facts 取最近若干条，
 * delivery-records 按 start 事件切窗口，review-runtime/merge-runtime/online-runtime/
 * schedule-upstream/ci-poll/concern-runtime/councils/workers-report 取某类事件最近一条，
 * map/who 取 created/note，map/view 取 max(id)。都只依赖「最近」语义。
 */

/** 已确认知会的保留时间：14 天。 */
export const INBOX_INFO_RETENTION_MS = 14 * 86400_000;
/** 已确认知会的条数上限：最多留最近 2 万条。 */
export const INBOX_INFO_MAX = 20_000;
/** 任务事件的保留时间：只清 90 天前就结束的任务。 */
export const TASK_EVENT_RETENTION_MS = 90 * 86400_000;
/** 每个已结束任务至少保留的最近事件条数。 */
export const TASK_EVENT_TAIL = 1000;
/** 每次清理最多处理多少个已结束任务（按 id 游标分页，不一次扫全表）。 */
export const SWEEP_TASKS_MAX = 300;

export type RetentionOptions = {
  now?: () => number;
  inboxAgeMs?: number;
  inboxMax?: number;
  eventAgeMs?: number;
  eventTail?: number;
  taskLimit?: number;
};

/**
 * 保留清理。收件箱先做（可能很大），任务事件按游标一次清一批；
 * 每轮语句数与数据量无关，且都有索引可走（见 tests/task-retention.test.ts 的查询计划守卫）。
 */
export class Retention {
  private cursor = 0;
  constructor(private readonly db: DatabaseSync) {}

  /** 跑一轮：返回两张表各清掉多少行。 */
  sweep(options: RetentionOptions = {}) {
    const now = (options.now ?? Date.now)();
    return {
      inbox: this.sweepInbox(now, options),
      events: this.sweepEvents(now, options),
    };
  }

  /** 已确认的知会：超过保留时间，或超出条数上限（按确认时间从新到旧保留）就删。 */
  sweepInbox(now: number, options: RetentionOptions = {}) {
    const age = options.inboxAgeMs ?? INBOX_INFO_RETENTION_MS;
    const max = options.inboxMax ?? INBOX_INFO_MAX;
    const where = "acked_at IS NOT NULL AND level='info' AND source<>'leader'";
    let removed = Number(
      this.db
        .prepare(`DELETE FROM task_inbox WHERE ${where} AND acked_at < ?`)
        .run(now - age).changes,
    );
    if (max > 0) {
      const threshold = one<{ acked_at: number; id: number }>(
        this.db,
        `SELECT acked_at,id FROM task_inbox WHERE ${where} ORDER BY acked_at DESC,id DESC LIMIT 1 OFFSET ?`,
        max,
      );
      if (threshold)
        removed += Number(
          this.db
            .prepare(
              `DELETE FROM task_inbox WHERE ${where} AND (acked_at < ? OR (acked_at = ? AND id <= ?))`,
            )
            .run(threshold.acked_at, threshold.acked_at, threshold.id).changes,
        );
    }
    return removed;
  }

  /**
   * 任务事件：按 id 游标分页处理已结束且过期任务，每个任务只删「最近 start 之前、且不在最近
   * eventTail 条内」的事件。返回本轮删掉的行数。
   */
  sweepEvents(now: number, options: RetentionOptions = {}) {
    const age = options.eventAgeMs ?? TASK_EVENT_RETENTION_MS;
    const tail = options.eventTail ?? TASK_EVENT_TAIL;
    const limit = options.taskLimit ?? SWEEP_TASKS_MAX;
    const rows = all<{ id: number }>(
      this.db,
      `SELECT id FROM tasks
        WHERE status IN ('done','failed','cancelled') AND updated_at < ? AND id > ?
        ORDER BY id LIMIT ?`,
      now - age,
      this.cursor,
      limit,
    );
    let removed = 0;
    const boundaryOf = this.db.prepare(
      "SELECT id FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1 OFFSET ?",
    );
    const lastStartOf = this.db.prepare(
      "SELECT id FROM task_events WHERE task_id=? AND kind='start' ORDER BY id DESC LIMIT 1",
    );
    const drop = this.db.prepare(
      "DELETE FROM task_events WHERE task_id=? AND id < ?",
    );
    for (const row of rows) {
      // 第 (tail+1) 新的事件（offset=tail）：它和更早的要删，最近 tail 条留下。
      // 不足 tail+1 条就没有边界，什么都不删。
      const tailRow = boundaryOf.get(row.id, tail) as
        { id: number } | undefined;
      if (!tailRow) continue;
      const start = lastStartOf.get(row.id) as { id: number } | undefined;
      // 同时保留最近一次 start 起的事件（最新交付窗口）：边界取更早的那个，start 本身要留。
      const upper = start && start.id <= tailRow.id ? start.id : tailRow.id + 1;
      removed += Number(drop.run(row.id, upper).changes);
    }
    this.cursor = rows.length < limit ? 0 : rows.at(-1)!.id;
    return removed;
  }
}
