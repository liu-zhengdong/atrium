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
  backfillDeliveries,
  deliveryFacts,
  listDeliveries,
  recomputeAllDeliveryFacts,
  summarizeDeliveries,
  workerStats,
  type Delivery,
  type DeliveryRow,
} from "../server/tasks/delivery-records.ts";
import { parseWorker } from "../server/tasks/profiles.ts";
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
    body: "测试要过",
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

test("旧库迁移：补出事实列并按事件回填，结果与旧实现一致", () => {
  const { db } = richDb();
  const old = oldListDeliveries(db);
  const expected = old.map(expectedFacts).sort(byId);
  // 还原成没有事实列的旧库，再走一次启动迁移。
  db.exec(
    "DROP INDEX IF EXISTS task_deliveries_facts; DROP INDEX IF EXISTS task_deliveries_job_facts; DROP INDEX IF EXISTS task_deliveries_missing_facts; DROP INDEX IF EXISTS task_deliveries_med_worker; DROP INDEX IF EXISTS task_deliveries_med_model; DROP INDEX IF EXISTS task_deliveries_med_tool;",
  );
  for (const column of [
    "first_pass",
    "gate_return_count",
    "merge_return_count",
    "incident_count",
    "incident_flags",
    "gate_passed",
    "duration_ms",
  ])
    db.exec(`ALTER TABLE task_deliveries DROP COLUMN ${column}`);
  ensureTaskTables(db);
  assert.deepEqual(readStored(db), expected);
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
  recomputeAllDeliveryFacts(db);
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

/** 改前的 backfillDeliveries（t154 前）：逐条 start 查交付、任务、下一次开工与结束事件。只用于对照。 */
function oldBackfill(db: DatabaseSync) {
  let after = 0;
  for (;;) {
    const starts = all<TaskEventRow>(
      db,
      "SELECT * FROM task_events WHERE kind='start' AND id>? ORDER BY id LIMIT 200",
      after,
    );
    for (const start of starts) {
      after = start.id;
      if (
        one(
          db,
          "SELECT 1 FROM task_deliveries WHERE start_event_id=?",
          start.id,
        )
      )
        continue;
      const task = one<TaskRow>(
        db,
        "SELECT * FROM tasks WHERE id=?",
        start.task_id,
      );
      if (!task) continue;
      let d: Record<string, unknown> = {};
      try {
        const x = JSON.parse(start.detail ?? "{}").detail;
        if (x && typeof x === "object") d = x;
      } catch {}
      const raw =
        (typeof d.worker === "string" ? d.worker : null) ?? task.worker;
      if (!raw) continue;
      let spec;
      try {
        spec = parseWorker(raw);
      } catch {
        continue;
      }
      const nextStart = one<TaskEventRow>(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? AND kind='start' ORDER BY id LIMIT 1",
        task.id,
        start.id,
      );
      const end = one<TaskEventRow>(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? AND id<? AND kind IN ('exit_ok','exit_fail','block','manual_set','cancel') ORDER BY id LIMIT 1",
        task.id,
        start.id,
        nextStart?.id ?? Number.MAX_SAFE_INTEGER,
      );
      db.prepare(
        "INSERT OR IGNORE INTO task_deliveries(task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,ended_at,outcome,historical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",
      ).run(
        task.id,
        start.id,
        raw,
        spec.tool,
        spec.model ?? null,
        null,
        task.job_id,
        typeof d.risk === "string" ? d.risk : null,
        task.part_id,
        start.at,
        end?.at ?? nextStart?.at ?? null,
        end?.kind ?? (nextStart ? "switched" : null),
      );
    }
    if (starts.length < 200) break;
  }
}

/** 旧库：只有事件没有交付；多任务交错开工、换人、各种结束事件，伪随机但可复现。 */
function legacyLedger(size: number, recorded = 0) {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  db.exec("BEGIN");
  const insTask = db.prepare(
    "INSERT INTO tasks(id,title,status,worker,job_id,part_id,created_at,updated_at) VALUES(?,?,'done',?,?,?,0,0)",
  );
  const insEvent = db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
  );
  const insDeliv = db.prepare(
    "INSERT INTO task_deliveries(task_id,start_event_id,worker,tool,model,started_at) VALUES(?,?,'claude+opus','claude','opus',?)",
  );
  for (let i = 1; i <= size; i++)
    insTask.run(
      i,
      `旧活${i}`,
      i % 7 === 0 ? null : "claude+opus",
      i % 3 || null,
      i % 5 || null,
    );
  let seed = 7;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const kinds = [
    "start",
    "start",
    "note",
    "exit_ok",
    "exit_fail",
    "block",
    "manual_set",
    "cancel",
    "gates",
  ];
  const workers = [
    undefined,
    "codex+gpt-6-sol",
    "claude+opus:high",
    "opencode",
  ];
  for (let k = 0; k < size * 6; k++) {
    // 偶尔引用不存在的任务：回填应跳过。
    const task = k % 97 === 0 ? size + 5 : 1 + Math.floor(rnd() * size);
    const kind = kinds[Math.floor(rnd() * kinds.length)]!;
    const worker = workers[Math.floor(rnd() * workers.length)];
    const detail =
      kind === "start"
        ? JSON.stringify({
            from: "todo",
            to: "running",
            detail: {
              ...(worker ? { worker } : {}),
              ...(k % 4 ? {} : { risk: "high" }),
            },
          })
        : "{}";
    const id = Number(
      insEvent.run(task, 1000 + k, kind, detail).lastInsertRowid,
    );
    // 前面这些 start 模拟运行中已当场记过交付。
    if (kind === "start" && k < recorded) insDeliv.run(task, id, 1000 + k);
  }
  db.exec("COMMIT");
  return db;
}

const deliveryRows = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,ended_at,outcome,historical FROM task_deliveries ORDER BY start_event_id",
    )
    .all()
    .map((row) => ({ ...row }));

test("旧库回填与改前逐条回填结果一致（换人、结束事件、缺任务、缺执行者）", () => {
  for (const [size, recorded] of [
    [40, 0],
    [300, 0],
    [300, 500],
  ] as const) {
    const a = legacyLedger(size, recorded);
    const b = legacyLedger(size, recorded);
    oldBackfill(a);
    backfillDeliveries(b);
    const want = deliveryRows(a);
    assert.ok(want.some((row) => row.outcome === "switched"));
    assert.ok(want.some((row) => row.outcome === null));
    assert.deepEqual(
      deliveryRows(b),
      want,
      `size=${size} recorded=${recorded}`,
    );
    a.close();
    b.close();
  }
});

test("回填按页批量查询；再次启动只剩常数条语句，与任务数无关", () => {
  const firstRun = (size: number) => {
    const db = legacyLedger(size);
    db.exec("DELETE FROM task_deliveries");
    const starts = (
      db
        .prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='start'")
        .get() as { n: number }
    ).n;
    const c = counting(db);
    backfillDeliveries(db);
    const count = c.read();
    c.restore();
    return { db, count, pages: Math.ceil(starts / 200) };
  };
  const small = firstRun(100);
  const big = firstRun(1000);
  // 首次回填：每页常数条（取 start、已记交付、任务、后续事件、事务、插入语句），不随每页条数增长。
  assert.ok(
    big.count <= (small.count / small.pages) * big.pages + 8,
    `首次回填语句 ${big.count}，${big.pages} 页`,
  );
  const again = (db: DatabaseSync) => {
    const c = counting(db);
    backfillDeliveries(db);
    const count = c.read();
    c.restore();
    return count;
  };
  const before = deliveryRows(big.db);
  assert.equal(
    again(big.db),
    again(small.db),
    "再次启动的语句数应与任务数无关",
  );
  assert.ok(again(big.db) <= 3);
  assert.deepEqual(deliveryRows(big.db), before);
  // 之后新写的 start 仍会被补上（只处理增量）。
  const id = Number(
    big.db
      .prepare(
        "INSERT INTO task_events(task_id,at,kind,detail) VALUES(1,9e9,'start',?)",
      )
      .run(JSON.stringify({ detail: { worker: "codex+gpt-6-sol" } }))
      .lastInsertRowid,
  );
  backfillDeliveries(big.db);
  assert.equal(
    one<{ worker: string }>(
      big.db,
      "SELECT worker FROM task_deliveries WHERE start_event_id=?",
      id,
    )?.worker,
    "codex+gpt-6-sol",
  );
  small.db.close();
  big.db.close();
});
