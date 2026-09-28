import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { taskDir } from "./active.ts";
import { clipBrief } from "./brief.ts";
import {
  advanceTask,
  atomically,
  createTask,
  getTask,
  noteTask,
  taskRef,
} from "./ledger.ts";
import { all, one } from "./ledger-model.ts";
import {
  scrub,
  VERIFY_EVENT,
  VERIFY_SHOWN_MS,
  VERDICT_TEXT,
  VERIFY_FILE,
  VERIFY_FILE_MAX,
  verifyBrief,
  verifyReport,
  verifyTitle,
  type VerifyReport,
} from "./verify.ts";
import type { VerifyView } from "./verify-view.ts";

/**
 * 上线后的端到端验证（t181）的账与执行：上线时在原任务下建一个验证任务（只交摘要、不开 PR），
 * 由调用方派给便宜执行者；验证任务不再跑后读它工作目录里的 verify.json，把结论记进原任务事件（kind=verified）。
 * PR 里没有「端到端验证」一节的只记 verify_none，不派人；验证任务建不起来记 verify_skipped。
 * 通过就结束；没通过、无法验证由调用方投给原任务的负责人（t182，verify_failed / verify_unverifiable），不自动回滚。
 * 看板、状态栏、task show 的验证状态由 verifyViews 一次取齐。
 */

export function ensureVerifyTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_verifications (
      verify_id INTEGER PRIMARY KEY REFERENCES tasks(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      verdict TEXT CHECK(verdict IS NULL OR verdict IN ('passed','failed','unverifiable')),
      created_at INTEGER NOT NULL, decided_at INTEGER);
    CREATE INDEX IF NOT EXISTS task_verifications_task ON task_verifications(task_id);
    CREATE INDEX IF NOT EXISTS task_verifications_open ON task_verifications(verify_id) WHERE decided_at IS NULL;
    CREATE INDEX IF NOT EXISTS task_verifications_decided ON task_verifications(decided_at) WHERE decided_at IS NOT NULL;`);
  // 看板上要显示没通过的原因（t182）：结论的一句总结也记在这一行。
  const columns = all<{ name: string }>(
    db,
    "PRAGMA table_info(task_verifications)",
  );
  if (!columns.some((column) => column.name === "summary"))
    db.exec("ALTER TABLE task_verifications ADD COLUMN summary TEXT");
}

export const isVerifyTask = (db: DatabaseSync, id: number) =>
  !!one(db, "SELECT 1 FROM task_verifications WHERE verify_id=?", id);

/** 验证执行者写结果的位置（没有仓库的任务在任务目录的 work 下干活）。 */
export const verifyFileOf = (data: string, verifyId: number) =>
  join(taskDir(data, verifyId), "work", VERIFY_FILE);

/**
 * 上线时开验证：有验证步骤就在原任务下建验证任务并返回短号（拉起由调用方做）；没有就记「无验证步骤」返回 null。
 * 在调用方的事务里跑，和「已上线」一同提交。
 */
export function openVerify(
  db: DatabaseSync,
  input: { taskId: number; version: string; steps: string | null },
  now = Date.now(),
): string | null {
  const task = getTask(db, input.taskId);
  if (!input.steps) {
    noteTask(db, task.id, "verify_none", {
      reason: "PR 里没有「端到端验证」一节，不派人验证",
    });
    return null;
  }
  const brief = clipBrief(
    verifyBrief({
      ref: task.ref,
      title: task.title,
      version: input.version,
      pr_url: task.pr_url,
      steps: input.steps,
    }),
  );
  // 建不起来（如归属部分已归档）只记一笔，不连累「已上线」一同回滚。
  db.exec("SAVEPOINT verify_open");
  try {
    // 帮手子任务（同专员审查）：不让原任务变成总任务、按子孙汇总状态（t190）。
    const verify = createTask(
      db,
      {
        title: verifyTitle(task),
        parent: task.ref,
        deliver: "none",
        brief,
        ...(task.owner ? { owner: task.owner } : {}),
        ...(task.part_ref ? { part: task.part_ref } : {}),
      },
      undefined,
      undefined,
      { helper: true },
    );
    db.prepare(
      "INSERT INTO task_verifications(verify_id,task_id,created_at) VALUES (?,?,?)",
    ).run(verify.id, task.id, now);
    noteTask(db, task.id, "verify_started", { verifier: verify.ref });
    db.exec("RELEASE verify_open");
    return verify.ref;
  } catch (error) {
    db.exec("ROLLBACK TO verify_open");
    db.exec("RELEASE verify_open");
    noteTask(db, task.id, "verify_skipped", {
      reason: scrub(
        `建验证任务失败：${error instanceof Error ? error.message : String(error)}`,
        300,
      ),
    });
    return null;
  }
}

export type VerifyOutcome = { task: number; verifier: string } & VerifyReport;

/** 记结论：同一个验证任务只记一次；记进原任务事件。 */
function record(
  db: DatabaseSync,
  row: { verify_id: number; task_id: number },
  report: VerifyReport,
  now: number,
): VerifyOutcome | null {
  return atomically(db, () => {
    const changed = db
      .prepare(
        "UPDATE task_verifications SET verdict=?,summary=?,decided_at=? WHERE verify_id=? AND decided_at IS NULL",
      )
      .run(report.verdict, report.summary, now, row.verify_id).changes;
    if (!changed) return null;
    const verifier = taskRef(row.verify_id);
    noteTask(
      db,
      row.task_id,
      "verified",
      {
        verifier,
        verdict: report.verdict,
        conclusion: VERDICT_TEXT[report.verdict],
        summary: report.summary,
        steps: report.steps,
      },
      now,
    );
    return { task: row.task_id, verifier, ...report };
  });
}

/** 验证任务拉不起来（没有可用的验证执行者）：标受阻，原任务记「无法验证」。 */
export function unsentVerify(
  db: DatabaseSync,
  ref: string,
  reason: string,
  now = Date.now(),
): VerifyOutcome | null {
  const task = getTask(db, ref);
  const row = one<{ verify_id: number; task_id: number }>(
    db,
    "SELECT verify_id,task_id FROM task_verifications WHERE verify_id=?",
    task.id,
  );
  if (!row) return null;
  const why = scrub(`没有可用的验证执行者：${reason}`, 300);
  if (task.status === "todo")
    advanceTask(db, ref, { kind: "block" }, {}, { reason: why });
  return record(
    db,
    row,
    { verdict: "unverifiable", summary: why, steps: [] },
    now,
  );
}

/** 读结果文件：没有为 null；太大给错误，不读进内存。 */
function readReport(file: string): string | null | { error: string } {
  try {
    if (statSync(file).size > VERIFY_FILE_MAX)
      return { error: `${VERIFY_FILE} 超过 ${VERIFY_FILE_MAX / 1024} KB` };
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

type Pending = {
  verify_id: number;
  task_id: number;
  status: string;
  result: string | null;
  created_at: number;
};

/** 从未出结论的验证行驱动（部分索引），按主键连验证任务、排除排队中的，一次取齐状态与汇报，循环里不再查库。 */
export const SETTLE_VERIFY_SQL = `SELECT v.verify_id, v.task_id, r.status, r.result, v.created_at
       FROM task_verifications v CROSS JOIN tasks r ON r.id=v.verify_id
      WHERE v.decided_at IS NULL
        AND r.status IN ('todo','done','failed','cancelled','blocked')
        AND NOT EXISTS (SELECT 1 FROM task_queue q WHERE q.task_id=v.verify_id)
      ORDER BY v.verify_id LIMIT ?`;

/** 建好多久还停在待办、又不在拉起或排队的，认为派发中途服务重启了，重派一次。 */
export const STRANDED_MS = 2 * 60_000;

/**
 * 扫一遍不再跑的验证任务，把结论记进原任务；busy 为正在拉起、运行或收尾的任务（内存里的），先不判。
 * 返回记下的结论与停在待办、要重派的验证任务短号。
 */
export function settleVerifications(
  db: DatabaseSync,
  data: string,
  busy: (id: number) => boolean = () => false,
  options: { now?: number; limit?: number } = {},
): { outcomes: VerifyOutcome[]; stranded: string[] } {
  const now = options.now ?? Date.now();
  const outcomes: VerifyOutcome[] = [];
  const stranded: string[] = [];
  for (const row of all<Pending>(db, SETTLE_VERIFY_SQL, options.limit ?? 20)) {
    if (busy(row.verify_id)) continue;
    if (row.status === "todo") {
      if (now - row.created_at >= STRANDED_MS)
        stranded.push(taskRef(row.verify_id));
      continue;
    }
    const report = verifyReport({
      status: row.status,
      raw: readReport(verifyFileOf(data, row.verify_id)),
      result: row.result,
    });
    const outcome = record(db, row, report, now);
    if (outcome) outcomes.push(outcome);
  }
  return { outcomes, stranded };
}

/**
 * 看板要列的原任务（t182）：验证还没出结论的，和 VERIFY_SHOWN_MS 内没通过、无法验证的。
 * 两段各走一个部分索引；参数是 since（now - VERIFY_SHOWN_MS）。
 */
export const VERIFY_TOP_SQL = `SELECT task_id FROM task_verifications WHERE decided_at IS NULL
   UNION SELECT task_id FROM task_verifications
    WHERE decided_at IS NOT NULL AND decided_at >= ? AND verdict IN ('failed','unverifiable')`;

export const verifyTopSince = (now: number) => now - VERIFY_SHOWN_MS;

type ViewRow = {
  task_id: number;
  verify_id: number;
  verdict: VerifyView["state"] | null;
  summary: string | null;
  decided_at: number | null;
  worker: string | null;
  started_at: number | null;
};

/**
 * 一批原任务各自最近一次上线验证的状态（t182）：一条 SQL 连验证任务取执行者与开始时刻，
 * 没通过、无法验证的再一条 SQL 从收件箱取投给了谁、处理完没有；循环里不查库。
 */
export function verifyViews(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, VerifyView> {
  const views = new Map<number, VerifyView>();
  if (!ids.length) return views;
  const marks = ids.map(() => "?").join(",");
  const latest = new Map<number, ViewRow>();
  for (const row of all<ViewRow>(
    db,
    `SELECT v.task_id, v.verify_id, v.verdict, v.summary, v.decided_at, r.worker, r.started_at
       FROM task_verifications v CROSS JOIN tasks r ON r.id=v.verify_id
      WHERE v.task_id IN (${marks}) ORDER BY v.verify_id`,
    ...ids,
  ))
    latest.set(row.task_id, row);
  const told = [...latest.values()]
    .filter((row) => row.verdict === "failed" || row.verdict === "unverifiable")
    .map((row) => row.task_id);
  const inbox = new Map<number, { subscriber: string; acked: boolean }>();
  if (
    told.length &&
    one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_inbox'",
    )
  ) {
    const kinds = Object.values(VERIFY_EVENT);
    for (const row of all<{
      task_id: number;
      subscriber: string;
      acked_at: number | null;
    }>(
      db,
      `SELECT task_id, subscriber, acked_at FROM task_inbox
        WHERE task_id IN (${told.map(() => "?").join(",")}) AND kind IN (${kinds.map(() => "?").join(",")})
        ORDER BY id`,
      ...told,
      ...kinds,
    ))
      inbox.set(row.task_id, {
        subscriber: row.subscriber,
        acked: row.acked_at !== null,
      });
  }
  for (const [id, row] of latest) {
    const sent = inbox.get(id);
    views.set(id, {
      state: row.decided_at === null ? "running" : (row.verdict ?? "running"),
      verifier: taskRef(row.verify_id),
      worker: row.worker,
      started_at: row.started_at,
      summary: row.summary,
      decided_at: row.decided_at,
      handler: sent?.subscriber ?? null,
      pending: !!sent && !sent.acked,
    });
  }
  return views;
}

/** 一批任务里哪些是上线验证任务：验证任务 id → 原任务短号。 */
export function verifyParents(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, string> {
  const parents = new Map<number, string>();
  if (!ids.length) return parents;
  for (const row of all<{ verify_id: number; task_id: number }>(
    db,
    `SELECT verify_id, task_id FROM task_verifications WHERE verify_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  ))
    parents.set(row.verify_id, taskRef(row.task_id));
  return parents;
}
