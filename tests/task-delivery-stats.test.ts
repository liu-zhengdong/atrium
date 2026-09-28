import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  noteTask,
} from "../server/tasks/ledger.ts";
import { createJobRole } from "../server/tasks/job-roles.ts";
import {
  applyDeliveryEvent,
  deliveryFacts,
  listDeliveries,
  summarizeDeliveries,
  workerStats,
  type Delivery,
  type DeliveryRow,
} from "../server/tasks/delivery-records.ts";
import {
  all,
  one,
  type TaskEventRow,
  type TaskRow,
} from "../server/tasks/ledger-model.ts";

/**
 * 交付统计改 SQL 聚合（t123）的守护检查：事实落库并在事件写入时增量维护、启动迁移回填；
 * 统计走 SQL 聚合，语句数与交付数无关、查询计划不扫整张交付表；结果与改前逐字段一致。
 * 全部用内存库，不依赖本机数据。
 */

/** 改前的 listDeliveries：每条交付回表读任务、逐条翻事件、查用量与岗位。只用于对照。 */
function oldListDeliveries(db: DatabaseSync): Delivery[] {
  const rows = all<DeliveryRow>(
    db,
    "SELECT * FROM task_deliveries ORDER BY id DESC",
  );
  return rows.flatMap((row) => {
    const task = one<TaskRow>(
      db,
      "SELECT * FROM tasks WHERE id=?",
      row.task_id,
    );
    if (!task) return [];
    const events: TaskEventRow[] = [];
    let cursor = row.start_event_id;
    for (;;) {
      const page = all<TaskEventRow>(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id LIMIT 200",
        row.task_id,
        cursor,
      );
      events.push(...page);
      if (page.length < 200 || page.some((event) => event.kind === "start"))
        break;
      cursor = page.at(-1)!.id;
    }
    const usage = one<{ points: number; basis: string }>(
      db,
      "SELECT points,basis FROM task_usage WHERE task_id=? AND started_at>=? ORDER BY started_at LIMIT 1",
      row.task_id,
      row.started_at - 2000,
    );
    const job = row.job_id
      ? one<{ name: string }>(
          db,
          "SELECT name FROM job_roles WHERE id=?",
          row.job_id,
        )
      : undefined;
    return [deliveryFacts(row, task, events, usage, job?.name ?? null)];
  });
}

type StoredFacts = {
  id: number;
  first_pass: number | null;
  duration_ms: number | null;
  gate_return_count: number;
  merge_return_count: number;
  incident_count: number;
};
const readStored = (db: DatabaseSync) =>
  all<StoredFacts>(
    db,
    "SELECT id,first_pass,duration_ms,gate_return_count,merge_return_count,incident_count FROM task_deliveries ORDER BY id",
  ).map((r) => ({
    id: r.id,
    first_pass: r.first_pass,
    duration_ms: r.duration_ms,
    gate_return_count: r.gate_return_count,
    merge_return_count: r.merge_return_count,
    incident_count: r.incident_count,
  }));
const expectedFacts = (d: Delivery): StoredFacts => ({
  id: d.id,
  first_pass: d.first_pass === null ? null : d.first_pass ? 1 : 0,
  duration_ms: d.duration_ms,
  gate_return_count: d.gate_return_count,
  merge_return_count: d.merge_returns.length,
  incident_count: d.incidents.length,
});
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

/** 小库：覆盖通过、没过关卡、合入退回、变基冲突、卡死、思考耗尽、越界、换人、无专员。 */
function richDb() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const role = createJobRole(db, {
    name: "后端",
    description: "服务与数据",
    preferred: [],
    checks: ["local_check"],
  });
  const codex = "codex+gpt-6-sol:high";
  const claude = "claude+opus:high";
  const run = (title: string, worker: string, job?: string) => {
    const task = createTask(db, { title, ...(job ? { by: job } : {}) });
    advanceTask(db, task.ref, { kind: "start" }, { worker }, { worker }, 1000);
    return task;
  };
  const finish = (task: ReturnType<typeof createTask>, at: number) =>
    advanceTask(db, task.ref, { kind: "exit_ok" }, {}, undefined, at);

  const pass = run("一次通过", codex, role.ref);
  noteTask(db, pass.id, "gates", { passed: true, results: [] }, 1100);
  finish(pass, 2000);

  const fail = run("关卡没过", codex, role.ref);
  noteTask(
    db,
    fail.id,
    "gates",
    { passed: false, results: [{ gate: "local_check", ok: false }] },
    1100,
  );
  advanceTask(db, fail.ref, { kind: "exit_fail" }, {}, undefined, 2000);

  const conflict = run("变基冲突", codex, role.ref);
  noteTask(db, conflict.id, "gates", { passed: true, results: [] }, 1100);
  noteTask(db, conflict.id, "merge_returned", { reason: "rebase 冲突" }, 1200);
  finish(conflict, 2000);

  const returned = run("合入退回", claude, role.ref);
  noteTask(db, returned.id, "gates", { passed: true, results: [] }, 1100);
  noteTask(db, returned.id, "merge_blocked", { reason: "检查失败" }, 1200);
  finish(returned, 2000);

  const stuck = run("卡死", claude, role.ref);
  noteTask(db, stuck.id, "gates", { passed: true, results: [] }, 1100);
  noteTask(db, stuck.id, "stalled", { detail: { reason: "卡死" } }, 1200);
  finish(stuck, 2000);

  const thinking = run("思考耗尽", claude);
  noteTask(db, thinking.id, "gates", { passed: true, results: [] }, 1100);
  noteTask(db, thinking.id, "thinking_retry", { reason: "换人" }, 1200);
  finish(thinking, 2000);

  const guard = run("越界", codex);
  noteTask(db, guard.id, "gates", { passed: true, results: [] }, 1100);
  noteTask(db, guard.id, "worker_guard_refused", { reason: "越界" }, 1200);
  finish(guard, 2000);

  const prMissing = run("没开 PR", codex, role.ref);
  noteTask(
    db,
    prMissing.id,
    "gates",
    { passed: false, results: [{ gate: "pr_exists", ok: false }] },
    1100,
  );
  finish(prMissing, 2000);

  const claim = run("虚报", codex, role.ref);
  noteTask(
    db,
    claim.id,
    "gates",
    { passed: false, results: [{ gate: "claims_verified", ok: false }] },
    1100,
  );
  finish(claim, 2000);

  // 换人：同一任务起两轮，前一轮由 codex、后一轮由 claude。
  const switched = run("换人", codex);
  noteTask(db, switched.id, "gates", { passed: true, results: [] }, 1100);
  advanceTask(db, switched.ref, { kind: "exit_fail" }, {}, undefined, 1200);
  advanceTask(
    db,
    switched.ref,
    { kind: "start" },
    { worker: claude },
    { worker: claude },
    1300,
  );
  finish(switched, 2000);

  // 有专员、但还没结束的：统计里不算，事实列里 first_pass/duration 为空。
  const running = run("进行中", claude, role.ref);

  return { db, role, running };
}

test("事实列在事件写入时增量维护，与改前逐字段一致", () => {
  const { db } = richDb();
  const old = oldListDeliveries(db);
  assert.deepEqual(readStored(db), old.map(expectedFacts).sort(byId));
  db.close();
});

test("workerStats 的聚合结果与改前 summarizeDeliveries 一致", () => {
  const { db, role } = richDb();
  const old = oldListDeliveries(db);
  assert.deepEqual(workerStats(db), summarizeDeliveries(old));
  assert.deepEqual(
    workerStats(db, { job: role.id }),
    summarizeDeliveries(old.filter((d) => d.job_id === role.id)),
  );
  assert.deepEqual(
    workerStats(db, { worker: "codex+gpt-6-sol:high" }),
    summarizeDeliveries(old.filter((d) => d.worker === "codex+gpt-6-sol:high")),
  );
  // 没有专员时只看最近一千条、不区分专员（与旧行为一致）。
  assert.deepEqual(
    workerStats(
      db,
      { worker: "codex+gpt-6-sol:high" },
      { limitPerWorker: 1000, roleNull: true },
    ),
    summarizeDeliveries(
      old
        .filter((d) => d.worker === "codex+gpt-6-sol:high")
        .slice(0, 1000)
        .map((d) => ({ ...d, job_name: null })),
    ),
  );
  db.close();
});

test("listDeliveries 仍按旧形状给全量明细", () => {
  const { db, running } = richDb();
  const old = oldListDeliveries(db);
  const now = listDeliveries(db);
  assert.equal(now.length, old.length);
  assert.deepEqual(
    now
      .slice()
      .sort(byId)
      .map((d) => d.final_result),
    old
      .slice()
      .sort(byId)
      .map((d) => d.final_result),
  );
  assert.ok(now.some((d) => d.task_id === running.id && d.ended_at === null));
  db.close();
});

/** 直接灌 N 条交付与事件：一任务一次交付，混入关卡、合入退回、卡死事件；随后按事件回填事实。 */
function seeded(size: number, db = new DatabaseSync(":memory:")) {
  ensureTaskTables(db);
  db.exec("BEGIN");
  const insTask = db.prepare(
    "INSERT INTO tasks(id,title,status,worker,job_id,created_at,started_at,ended_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const insEvent = db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
  );
  const insDeliv = db.prepare(
    "INSERT INTO task_deliveries(task_id,start_event_id,worker,tool,model,job_id,started_at,ended_at,outcome) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 1; i <= size; i++) {
    const codex = i % 2 === 1;
    const worker = codex ? "codex+gpt-6-sol" : "claude+opus";
    const tool = codex ? "codex" : "claude";
    const model = codex ? "gpt-6-sol" : "opus";
    insTask.run(i, `任务${i}`, "done", worker, null, i, i, i + 1000, i + 1000);
    const start = Number(insEvent.run(i, i, "start", null).lastInsertRowid);
    insDeliv.run(i, start, worker, tool, model, null, i, i + 1000, "exit_ok");
    if (i % 3 === 0)
      insEvent.run(
        i,
        i + 1,
        "gates",
        JSON.stringify({
          passed: i % 6 === 0,
          results: i % 6 === 0 ? [] : [{ gate: "local_check", ok: false }],
        }),
      );
    if (i % 10 === 0)
      insEvent.run(
        i,
        i + 2,
        "merge_returned",
        JSON.stringify({ reason: i % 20 === 0 ? "rebase 冲突" : "检查失败" }),
      );
    if (i % 50 === 0)
      insEvent.run(
        i,
        i + 3,
        "stalled",
        JSON.stringify({ detail: { reason: "卡死" } }),
      );
  }
  db.exec("COMMIT");
  // 事实列与运行时同一条路维护：逐条事件增量，结束时算耗时与一次通过。
  for (const e of all<TaskEventRow>(
    db,
    "SELECT task_id,kind,detail FROM task_events WHERE kind<>'start' ORDER BY id",
  ))
    applyDeliveryEvent(db, e.task_id, e.kind, e.detail);
  db.exec(
    "UPDATE task_deliveries SET duration_ms=MAX(0,ended_at-started_at),first_pass=CASE WHEN gate_passed=1 AND gate_return_count=0 AND merge_return_count=0 THEN 1 ELSE 0 END",
  );
  return db;
}

/** 包一层数语句：prepare 与 exec 各算一次执行。 */
function counting(db: DatabaseSync) {
  const originalPrepare = db.prepare.bind(db);
  const originalExec = db.exec.bind(db);
  const sqls: string[] = [];
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    sqls.push(sql);
    return originalPrepare(sql);
  };
  (db as unknown as { exec: unknown }).exec = (sql: string) => {
    sqls.push(sql);
    return originalExec(sql);
  };
  return {
    read: () => sqls.length,
    sqls,
    restore: () => {
      delete (db as unknown as { prepare?: unknown }).prepare;
      delete (db as unknown as { exec?: unknown }).exec;
    },
  };
}

test("统计的语句数与交付数无关，查询计划不扫整张交付表", () => {
  const small = seeded(20);
  const c1 = counting(small);
  workerStats(small);
  const smallCount = c1.read();
  const smallSqls = c1.sqls;
  c1.restore();
  assert.ok(smallCount > 0);

  const big = seeded(15000);
  const c2 = counting(big);
  const bigStats = workerStats(big);
  const bigCount = c2.read();
  const bigSqls = c2.sqls;
  c2.restore();
  assert.equal(bigCount, smallCount, "语句数应随交付数保持不变");
  assert.ok(bigStats.some((s) => s.deliveries > 0));

  // 每条统计 SQL 里交付表都要走索引（无过滤走覆盖索引），不能整表扫描。
  let covering = false;
  for (const sql of [...smallSqls, ...bigSqls]) {
    if (!sql.includes("task_deliveries")) continue;
    const plan = big.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {
      detail: string;
    }[];
    for (const step of plan) {
      if (!step.detail.includes("task_deliveries")) continue;
      assert.match(step.detail, /USING/, `交付表整表扫描：${step.detail}`);
      if (step.detail.includes("COVERING INDEX")) covering = true;
    }
  }
  assert.ok(covering, "无过滤统计应走覆盖索引");

  small.close();
  big.close();
});

test("按 worker / job 过滤的统计走索引而非整表", () => {
  const db = seeded(2000);
  const c = counting(db);
  workerStats(db, { worker: "codex+gpt-6-sol" });
  workerStats(db, { job: 1 });
  const sqls = c.sqls;
  c.restore();
  const plans = sqls
    .filter(
      (sql) =>
        sql.includes("FROM task_deliveries") &&
        (sql.includes("worker=?") || sql.includes("job_id=?")),
    )
    .flatMap(
      (sql) =>
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[],
    );
  assert.ok(plans.length > 0, "应有按 worker / job 过滤的查询");
  assert.ok(
    plans.some((step) => /SEARCH task_deliveries USING/.test(step.detail)),
    plans.map((p) => p.detail).join("\n"),
  );
  db.close();
});
