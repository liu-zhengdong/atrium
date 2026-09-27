import type { DatabaseSync } from "node:sqlite";
import type { PaceEntry } from "./prepare.ts";
import { atomically, one } from "./ledger-model.ts";

/** OpenQuota 只提供账号总量；同窗口内的任务按重叠数平分增量。 */
export type UsageRow = {
  task_id: number;
  provider: string;
  window_reset_at: number;
  started_at: number;
  ended_at: number | null;
  start_percent: number | null;
  points: number;
  basis: "delta" | "split" | "unknown";
};

export function ensureUsageTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_usage (
    task_id INTEGER NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
    window_reset_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER, start_percent REAL, points REAL NOT NULL DEFAULT 0,
    basis TEXT NOT NULL CHECK(basis IN ('delta','split','unknown')),
    PRIMARY KEY(task_id,provider,started_at));
    CREATE INDEX IF NOT EXISTS task_usage_window ON task_usage(provider,window_reset_at,started_at);`);
}

const WINDOW_BUCKET_MS = 300_000;

/** 重置时间取整到五分钟，抵消连续 pace 读取时的秒级漂移。 */
export function resetAt(entry: PaceEntry, now: number): number | null {
  const hours = entry.hoursToReset;
  return hours && Number.isFinite(hours) && hours > 0
    ? Math.round((now + hours * 3_600_000) / WINDOW_BUCKET_MS) *
        WINDOW_BUCKET_MS
    : null;
}

/**
 * 两次读数是否同一窗口：漂移恰好跨过取整边界时会落到相邻的桶，所以差一个桶以内都算同窗口；
 * 同账号的不同窗口（五小时、每周）重置时刻相差远大于五分钟。
 */
export function sameWindow(a: number, b: number): boolean {
  return Math.abs(a - b) <= WINDOW_BUCKET_MS;
}

export function usageSample(
  pace: readonly PaceEntry[] | undefined,
  provider: string,
  now: number,
) {
  const samples =
    pace?.filter(
      (p) =>
        p.providerId === provider &&
        p.usedPercent !== null &&
        p.usedPercent !== undefined &&
        resetAt(p, now) !== null,
    ) ?? [];
  // 同账号多个窗口时，最早重置的窗口与派活判断一致，且每次只记一个窗口。
  const selected = samples.sort(
    (a, b) => resetAt(a, now)! - resetAt(b, now)!,
  )[0];
  return selected
    ? { reset: resetAt(selected, now)!, used: selected.usedPercent! }
    : null;
}

export function splitDelta(
  start: number | null,
  end: number | null,
  concurrent: number,
): { points: number; basis: UsageRow["basis"] } {
  if (start === null || end === null || end < start || concurrent < 1)
    return { points: 0, basis: "unknown" };
  return {
    points: Math.max(0, end - start) / concurrent,
    basis: concurrent > 1 ? "split" : "delta",
  };
}

export function beginUsage(
  db: DatabaseSync,
  taskId: number,
  provider: string,
  pace: readonly PaceEntry[] | undefined,
  now = Date.now(),
) {
  const sample = usageSample(pace, provider, now);
  db.prepare(
    "INSERT INTO task_usage(task_id,provider,window_reset_at,started_at,start_percent,basis) VALUES(?,?,?,?,?,'unknown')",
  ).run(taskId, provider, sample?.reset ?? 0, now, sample?.used ?? null);
}

export function endUsage(
  db: DatabaseSync,
  taskId: number,
  provider: string,
  pace: readonly PaceEntry[] | undefined,
  now = Date.now(),
) {
  const row = one<UsageRow>(
    db,
    "SELECT * FROM task_usage WHERE task_id=? AND provider=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    taskId,
    provider,
  );
  if (!row) return;
  const sample = usageSample(pace, provider, now);
  const overlap = row.window_reset_at
    ? (one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM task_usage WHERE provider=? AND window_reset_at BETWEEN ? AND ? AND started_at<=? AND (ended_at IS NULL OR ended_at>=?)",
        provider,
        row.window_reset_at - WINDOW_BUCKET_MS,
        row.window_reset_at + WINDOW_BUCKET_MS,
        now,
        row.started_at,
      )?.n ?? 1)
    : 1;
  const estimate =
    sample &&
    row.window_reset_at &&
    sameWindow(sample.reset, row.window_reset_at)
      ? splitDelta(row.start_percent, sample.used, overlap)
      : { points: 0, basis: "unknown" as const };
  atomically(db, () =>
    db
      .prepare(
        "UPDATE task_usage SET ended_at=?,points=?,basis=? WHERE task_id=? AND provider=? AND started_at=?",
      )
      .run(
        now,
        estimate.points,
        estimate.basis,
        taskId,
        provider,
        row.started_at,
      ),
  );
}

export function subtreeUsage(
  db: DatabaseSync,
  nodeIds: readonly number[],
  provider: string,
  reset: number,
): number {
  if (!nodeIds.length) return 0;
  let sum = 0;
  for (let i = 0; i < nodeIds.length; i += 100) {
    const page = nodeIds.slice(i, i + 100);
    const marks = page.map(() => "?").join(",");
    let cursor = 0;
    for (;;) {
      const rows = db
        .prepare(
          `SELECT u.rowid AS id,u.points FROM task_usage u JOIN tasks t ON t.id=u.task_id WHERE t.node_id IN (${marks}) AND u.provider=? AND u.window_reset_at BETWEEN ? AND ? AND u.rowid>? ORDER BY u.rowid LIMIT 200`,
        )
        .all(
          ...page,
          provider,
          reset - WINDOW_BUCKET_MS,
          reset + WINDOW_BUCKET_MS,
          cursor,
        ) as {
        id: number;
        points: number;
      }[];
      for (const row of rows) sum += row.points;
      if (rows.length < 200) break;
      cursor = rows.at(-1)!.id;
    }
  }
  return sum;
}
