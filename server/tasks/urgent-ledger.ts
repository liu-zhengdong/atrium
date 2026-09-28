import type { DatabaseSync } from "node:sqlite";
import { all } from "./ledger-model.ts";
import { storedHosts, storedStopgap, stopgapJson } from "./urgent.ts";
import { RELEASE_OVERDUE_MS } from "./online.ts";

/**
 * 紧急通道（t215）的账：任务上的原因、谁标的、避开的主机、止损动作（tasks 的列），
 * 被抢占暂停的任务（task_preemptions，一件一行，续上后留作记录），紧急任务合入与审阅并行时的审阅（task_after_reviews）。
 * 新表名与旧运行时的表（agents、inbox_tokens、pi_* 等）不重名，旧表不读不写。
 */

export function ensureUrgentTables(db: DatabaseSync) {
  const columns = all<{ name: string }>(db, "PRAGMA table_info(tasks)");
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("urgent_why"))
    db.exec("ALTER TABLE tasks ADD COLUMN urgent_why TEXT");
  if (!has("urgent_by")) db.exec("ALTER TABLE tasks ADD COLUMN urgent_by TEXT");
  if (!has("avoid_hosts"))
    db.exec("ALTER TABLE tasks ADD COLUMN avoid_hosts TEXT");
  if (!has("stopgap")) db.exec("ALTER TABLE tasks ADD COLUMN stopgap TEXT");
  // 紧急任务历来不多：部分索引只收 urgent=1 的，紧急通道的查询（带 urgent=1）都走它，不扫全表。
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_urgent_ids ON tasks(id) WHERE urgent=1",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS task_preemptions (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
      by_task INTEGER NOT NULL,
      why TEXT NOT NULL CHECK(why IN ('exclusive','slot')),
      worker TEXT NOT NULL,
      risk TEXT NOT NULL,
      host_id INTEGER,
      session TEXT,
      paused_at INTEGER NOT NULL,
      resumed_at INTEGER);
    CREATE INDEX IF NOT EXISTS task_preemptions_open ON task_preemptions(paused_at,task_id) WHERE resumed_at IS NULL;
    CREATE TABLE IF NOT EXISTS task_after_reviews (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
      review_task INTEGER,
      started_at INTEGER NOT NULL,
      settled_at INTEGER,
      verdict TEXT,
      followup_task INTEGER);
    CREATE INDEX IF NOT EXISTS task_after_reviews_open ON task_after_reviews(task_id) WHERE settled_at IS NULL;`);
}

export type UrgentFields = {
  why: string | null;
  by: string | null;
  avoid: number[];
  stopgap: ReturnType<typeof stopgapJson>;
};

/** 任务的紧急附加信息（task show 与派活用）；旧库没有列时为空。 */
export function urgentFields(row: {
  urgent_why?: string | null;
  urgent_by?: string | null;
  avoid_hosts?: string | null;
  stopgap?: string | null;
}): UrgentFields {
  return {
    why: row.urgent_why ?? null,
    by: row.urgent_by ?? null,
    avoid: storedHosts(row.avoid_hosts),
    stopgap: stopgapJson(storedStopgap(row.stopgap)),
  };
}

// ---- 抢占 ----

export type Preemption = {
  task_id: number;
  by_task: number;
  why: "exclusive" | "slot";
  worker: string;
  risk: string;
  host_id: number | null;
  session: string | null;
  paused_at: number;
  resumed_at: number | null;
};

export function recordPreemption(
  db: DatabaseSync,
  entry: Omit<Preemption, "resumed_at">,
) {
  db.prepare(
    `INSERT INTO task_preemptions(task_id,by_task,why,worker,risk,host_id,session,paused_at,resumed_at)
      VALUES (?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(task_id) DO UPDATE SET by_task=excluded.by_task,why=excluded.why,worker=excluded.worker,
        risk=excluded.risk,host_id=excluded.host_id,session=excluded.session,paused_at=excluded.paused_at,resumed_at=NULL`,
  ).run(
    entry.task_id,
    entry.by_task,
    entry.why,
    entry.worker,
    entry.risk,
    entry.host_id,
    entry.session,
    entry.paused_at,
  );
}

/** 还没续上的暂停（按暂停先后，有界）。 */
export function openPreemptions(db: DatabaseSync, limit = 100): Preemption[] {
  return all<Preemption>(
    db,
    "SELECT * FROM task_preemptions WHERE resumed_at IS NULL ORDER BY paused_at,task_id LIMIT ?",
    limit,
  );
}

export function openPreemption(
  db: DatabaseSync,
  id: number,
): Preemption | undefined {
  return db
    .prepare(
      "SELECT * FROM task_preemptions WHERE task_id=? AND resumed_at IS NULL",
    )
    .get(id) as Preemption | undefined;
}

export function closePreemption(db: DatabaseSync, id: number, now: number) {
  db.prepare(
    "UPDATE task_preemptions SET resumed_at=? WHERE task_id=? AND resumed_at IS NULL",
  ).run(now, id);
}

/** 暂停中的任务：看板与持球人用（一次查询，ids 为空不查）。 */
export function pausedBy(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, { by: number; why: "exclusive" | "slot" }> {
  const result = new Map<number, { by: number; why: "exclusive" | "slot" }>();
  if (!ids.length || !hasTable(db, "task_preemptions")) return result;
  for (const row of all<{
    task_id: number;
    by_task: number;
    why: "exclusive" | "slot";
  }>(
    db,
    `SELECT task_id,by_task,why FROM task_preemptions WHERE resumed_at IS NULL AND task_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  ))
    result.set(row.task_id, { by: row.by_task, why: row.why });
  return result;
}

// ---- 紧急通道的在途计数 ----

const hasTable = (db: DatabaseSync, name: string) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);

/** 进行中的紧急任务（没完成、没取消，或已合入还在等上线）：看板提示「太多就等于没有紧急」用。 */
export function openUrgent(db: DatabaseSync): number[] {
  return all<{ id: number }>(
    db,
    `SELECT id FROM tasks WHERE urgent=1 AND (status NOT IN ('done','cancelled')
       OR delivery_stage IN ('reviewing','merge_queued','merging') OR (delivery_stage='merged' AND online_wait=1))
     ORDER BY id LIMIT 50`,
  ).map((row) => row.id);
}

const MERGE_FLOW_SQL = `SELECT id,delivery_stage,release_version FROM tasks WHERE urgent=1 AND (
       (delivery_stage IN ('merge_queued','merging') AND status='done')
       OR (delivery_stage='merged' AND online_wait=1 AND release_failed_at IS NULL AND updated_at>=?))
     ORDER BY id LIMIT 50`;

/**
 * 在合入流程里的紧急任务：排队合入、合入中，或已合入还在等上线。等上线只算发版真在进行的那段（t265）：
 * 发版工作流失败或合入太久没出版本（记了 release_failed_at）就不再挡别的合入，修发版的任务自己再走紧急；
 * 另留发版超时提醒之前（RELEASE_OVERDUE_MS）的兜底，免得整条合入队列一直停着。
 */
export function urgentInMergeFlow(
  db: DatabaseSync,
  now = Date.now(),
): number[] {
  return urgentFlowStages(db, now).map((item) => item.id);
}

/** 紧急任务在合入流程里的哪一段（看板写「在等谁」）。 */
export type UrgentFlowStage = "排队合入" | "合入中" | "等发版" | "升级上线中";

/** 在合入流程里的紧急任务与各自在哪一段；判定同 urgentInMergeFlow。 */
export function urgentFlowStages(
  db: DatabaseSync,
  now = Date.now(),
): { id: number; stage: UrgentFlowStage }[] {
  return all<{
    id: number;
    delivery_stage: string;
    release_version: string | null;
  }>(db, MERGE_FLOW_SQL, now - RELEASE_OVERDUE_MS).map((row) => ({
    id: row.id,
    stage:
      row.delivery_stage === "merge_queued"
        ? "排队合入"
        : row.delivery_stage === "merging"
          ? "合入中"
          : row.release_version
            ? "升级上线中"
            : "等发版",
  }));
}

/** 排队合入中的紧急任务（正在合入的普通任务据此让路）。 */
export function urgentMergeWaiting(db: DatabaseSync): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM tasks WHERE urgent=1 AND delivery_stage='merge_queued' AND status='done' LIMIT 1",
    )
    .get();
}

// ---- 合入与审阅并行 ----

export type AfterReview = {
  task_id: number;
  review_task: number | null;
  started_at: number;
  settled_at: number | null;
  verdict: string | null;
  followup_task: number | null;
};

export function openAfterReviews(db: DatabaseSync, limit = 50): AfterReview[] {
  return all<AfterReview>(
    db,
    "SELECT * FROM task_after_reviews WHERE settled_at IS NULL ORDER BY task_id LIMIT ?",
    limit,
  );
}
