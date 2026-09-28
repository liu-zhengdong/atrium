import type { DatabaseSync } from "node:sqlite";
import { one, ref } from "../org/model.ts";
import { readLimits } from "../org/limits.ts";

/** 每个订阅账号留给用户的额度；根节点没设时的缺省。 */
export const DEFAULT_QUOTA_RESERVE_PERCENT = 20;

export type QuotaReserve = {
  percent: number;
  /** 用户在根节点设过为 o1；没设、用缺省时为 null。 */
  set_by: string | null;
};

/** 给用户留的份额：根节点的配置（org/limits.ts）；没有组织表或没设就用缺省。 */
export function quotaReserve(db?: DatabaseSync): QuotaReserve {
  const fallback = { percent: DEFAULT_QUOTA_RESERVE_PERCENT, set_by: null };
  if (
    !db ||
    !one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_limits'",
    )
  )
    return fallback;
  const percent = readLimits(db).quota_reserve_percent;
  const root = one<{ id: number }>(
    db,
    "SELECT id FROM org_nodes WHERE parent_id IS NULL",
  );
  return percent === undefined
    ? fallback
    : { percent, set_by: root ? ref(root.id) : null };
}

export function readQuotaReservePercent(db?: DatabaseSync): number {
  return quotaReserve(db).percent;
}

/** 仅在 OpenQuota 明确给出已用比例时阻止派活；缺数据不猜测额度。 */
export function overReserve(
  usedPercent: number | null | undefined,
  reservePercent: number,
): boolean {
  return (
    usedPercent !== null &&
    usedPercent !== undefined &&
    usedPercent >= 100 - reservePercent
  );
}
