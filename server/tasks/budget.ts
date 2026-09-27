import type { DatabaseSync } from "node:sqlite";
import { effective } from "../org/boundaries.ts";
import { allBoundaries, chainLevels } from "../org/boundary-store.ts";
import { nodes, one, ref } from "../org/model.ts";

/** 每个订阅账号留给用户的额度；根章程没写时的缺省。 */
export const DEFAULT_QUOTA_RESERVE_PERCENT = 20;

export type QuotaReserve = {
  percent: number;
  /** 由哪个节点的章程给出（o1 这样的短号）；根章程没写、用缺省时为 null。 */
  set_by: string | null;
};

/**
 * 给用户留的份额只读组织树（#355）：根到 nodeId 逐层叠加的 quota_reserve_percent 取最严；
 * 没有组织树或没写就用缺省。旧的 ~/Atrium/charter.md 由启动导入一次写进根章程，不再读文件。
 */
export function quotaReserve(db?: DatabaseSync, nodeId?: number): QuotaReserve {
  const fallback = { percent: DEFAULT_QUOTA_RESERVE_PERCENT, set_by: null };
  if (
    !db ||
    !one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_boundaries'",
    )
  )
    return fallback;
  const list = nodes(db);
  const root = list.find((n) => n.parent_id === null);
  if (!root) return fallback;
  const node = list.find((n) => n.id === nodeId) ?? root;
  const owned = allBoundaries(db);
  const chain = [
    ...chainLevels(list, owned, node.parent_id),
    { node: node.id, name: node.name, entries: owned.get(node.id) ?? [] },
  ];
  // 不同条目都写了保留份额时取最大（最严）。
  const found = effective(chain)
    .filter((e) => e.param?.key === "quota_reserve_percent")
    .sort((a, b) => b.param!.value - a.param!.value)[0];
  return found
    ? { percent: found.param!.value, set_by: ref(found.set_by) }
    : fallback;
}

export function readQuotaReservePercent(
  db?: DatabaseSync,
  nodeId?: number,
): number {
  return quotaReserve(db, nodeId).percent;
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
