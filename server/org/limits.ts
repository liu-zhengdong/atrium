import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { actsForUser } from "../../shared/user.ts";
import { all } from "./model.ts";

/**
 * 根节点的两项配置（不是规矩，是数值）：给用户留的额度百分比、花费上限（元）。只有用户能改；
 * 规矩一律写成要点（points.ts）。旧库的 org_boundaries 只在迁移那一次读（migrate-rules.ts）。
 */

export const LIMITS = {
  quota_reserve_percent: { min: 0, max: 100, label: "给你留的额度", unit: "%" },
  money_yuan_max: { min: 0, max: 1_000_000, label: "花费上限", unit: " 元" },
} as const;
export type LimitKey = keyof typeof LIMITS;
export type Limits = Partial<Record<LimitKey, number>>;

export function ensureLimitTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_limits (
    key TEXT PRIMARY KEY, value REAL NOT NULL,
    updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
}

export function readLimits(db: DatabaseSync): Limits {
  const out: Limits = {};
  for (const row of all<{ key: string; value: number }>(
    db,
    "SELECT key,value FROM org_limits ORDER BY key LIMIT 10",
  ))
    if (row.key in LIMITS) out[row.key as LimitKey] = row.value;
  return out;
}

/** 校验（纯函数）：只认两项，数值在范围里；至少给一项。 */
function validateLimits(body: unknown): Limits {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为对象", "usage");
  const out: Limits = {};
  for (const [key, value] of Object.entries(body)) {
    const spec = LIMITS[key as LimitKey];
    if (!spec) throw new Problem(400, `${key}: 是未知字段`, "usage");
    const flag = key === "money_yuan_max" ? "--money-max" : "--quota-reserve";
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < spec.min ||
      value > spec.max
    )
      throw new Problem(
        400,
        `${flag}: 应为 ${spec.min}–${spec.max} 的数`,
        "usage",
      );
    out[key as LimitKey] = value;
  }
  if (!Object.keys(out).length)
    throw new Problem(400, "至少改一项：--quota-reserve、--money-max", "usage");
  return out;
}

export function writeLimits(
  db: DatabaseSync,
  body: unknown,
  actor: string,
  now = Date.now(),
): Limits {
  if (!actsForUser(actor))
    throw new Problem(403, "给你留的额度与花费上限只有你能改");
  const input = validateLimits(body);
  const upsert = db.prepare(
    "INSERT INTO org_limits(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
  );
  for (const [key, value] of Object.entries(input))
    upsert.run(key, value, actor, now);
  return readLimits(db);
}

export const limitText = (limits: Limits) =>
  (Object.keys(LIMITS) as LimitKey[])
    .filter((key) => limits[key] !== undefined)
    .map((key) => `${LIMITS[key].label} ${limits[key]}${LIMITS[key].unit}`)
    .join("；");
