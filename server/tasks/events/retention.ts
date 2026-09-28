import type { DatabaseSync } from "node:sqlite";
import { one } from "../ledger/ledger-model.ts";

/**
 * 收件箱的保留上限（#t126）：只有「已确认的知会类」按时间或条数清理（源头不是 leader 的上交/转交）；
 * 要处理的事件、未确认的事件、leader 的上交/转交记录一律留着。
 * 任务事件不清理：交付事实、task show、换执行者判断都直接从事件查（每天几千行，SQLite 放得下多年），
 * 省掉清理前把交付事实固化进 task_deliveries 那一套。
 */

/** 已确认知会的保留时间：14 天。 */
export const INBOX_INFO_RETENTION_MS = 14 * 86400_000;
/** 已确认知会的条数上限：最多留最近 2 万条。 */
export const INBOX_INFO_MAX = 20_000;

export type RetentionOptions = {
  now?: () => number;
  inboxAgeMs?: number;
  inboxMax?: number;
};

/** 只清「已确认的知会类」；要处理、未确认、leader 上交/转交都不动。 */
const INBOX_RETENTION_WHERE =
  "acked_at IS NOT NULL AND level='info' AND source<>'leader'";

/**
 * 保留清理用到的静态语句。导出给 tests/task-retention.test.ts 的查询计划守卫直接引用，
 * 免得测试里抄一份副本、日后和真实语句对不上。
 */
export const RETENTION_SQL = {
  inboxByAge: `DELETE FROM task_inbox WHERE ${INBOX_RETENTION_WHERE} AND acked_at < ?`,
  inboxThreshold: `SELECT acked_at,id FROM task_inbox WHERE ${INBOX_RETENTION_WHERE} ORDER BY acked_at DESC,id DESC LIMIT 1 OFFSET ?`,
  inboxByCount: `DELETE FROM task_inbox WHERE ${INBOX_RETENTION_WHERE} AND (acked_at < ? OR (acked_at = ? AND id <= ?))`,
} as const;

/** 保留清理：每轮语句数与数据量无关，且都有索引可走（见 tests/task-retention.test.ts 的查询计划守卫）。 */
export class Retention {
  constructor(private readonly db: DatabaseSync) {}

  /** 跑一轮：返回清掉多少行。 */
  sweep(options: RetentionOptions = {}) {
    return this.sweepInbox((options.now ?? Date.now)(), options);
  }

  /** 已确认的知会：超过保留时间，或超出条数上限（按确认时间从新到旧保留）就删。 */
  sweepInbox(now: number, options: RetentionOptions = {}) {
    const age = options.inboxAgeMs ?? INBOX_INFO_RETENTION_MS;
    const max = options.inboxMax ?? INBOX_INFO_MAX;
    let removed = Number(
      this.db.prepare(RETENTION_SQL.inboxByAge).run(now - age).changes,
    );
    if (max > 0) {
      const threshold = one<{ acked_at: number; id: number }>(
        this.db,
        RETENTION_SQL.inboxThreshold,
        max,
      );
      if (threshold)
        removed += Number(
          this.db
            .prepare(RETENTION_SQL.inboxByCount)
            .run(threshold.acked_at, threshold.acked_at, threshold.id).changes,
        );
    }
    return removed;
  }
}
