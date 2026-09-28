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
  listDeliveries,
  summarizeDeliveries,
  workerStats,
  type WorkerStat,
} from "../server/tasks/delivery-records.ts";
import {
  ADVICE_REPEAT_MS,
  ADVICE_WINDOW,
  adviceDue,
  adviceFor,
} from "../server/tasks/worker-advice.ts";
import { publishWorkerAdvice } from "../server/tasks/workers-report.ts";
import { EventInbox } from "../server/tasks/events.ts";
import { eventLevel } from "../server/tasks/event-level.ts";

/** 执行者升降建议（t277）：收紧要有规模、同一建议 7 天不重复、知会级。全用内存库。 */

const stat = (over: Partial<WorkerStat> = {}): WorkerStat => ({
  scope: "combination",
  worker: "claude+opus:high",
  role: "后端",
  deliveries: 118,
  first_pass_rate: 0.9,
  average_returns: 0.1,
  median_ms: 1000,
  incidents: 0,
  recent_deliveries: 20,
  recent_incidents: 0,
  low_data: false,
  trust: "medium",
  ...over,
});

test("收紧只在最近一段事故有规模时建议", () => {
  const cases: [Partial<WorkerStat>, string | null, string][] = [
    [
      { incidents: 1, recent_incidents: 1 },
      null,
      "118 次里 1 起事故（09-28 那条）不建议收紧",
    ],
    [{ incidents: 2, recent_incidents: 2 }, null, "最近 20 次 2 起不够"],
    [{ incidents: 3, recent_incidents: 3 }, "tighten", "最近 20 次 3 起即收紧"],
    [
      { incidents: 9, recent_incidents: 0 },
      null,
      "事故都在很久以前，最近一段干净就不收紧",
    ],
    [
      {
        deliveries: 6,
        recent_deliveries: 6,
        incidents: 3,
        recent_incidents: 3,
      },
      "tighten",
      "样本不满一个窗口也按占比算",
    ],
    [
      {
        deliveries: 4,
        recent_deliveries: 4,
        incidents: 4,
        recent_incidents: 4,
      },
      null,
      "样本太少不给建议",
    ],
    [
      { scope: "model", incidents: 5, recent_incidents: 5 },
      null,
      "只对组合给建议",
    ],
    [
      { first_pass_rate: 0.4, incidents: 1, recent_incidents: 1 },
      "avoid_role",
      "事故不够收紧时照常看通过率",
    ],
    [{ first_pass_rate: 1 }, "relax", "全部一次通过且无事故建议放宽"],
    [{ first_pass_rate: 1, trust: "high" }, null, "已经是最高一档不再放宽"],
    [
      { first_pass_rate: 1, incidents: 1, recent_incidents: 0 },
      null,
      "有过事故不建议放宽",
    ],
    [{ first_pass_rate: null }, null, "没有可评的交付不给建议"],
  ];
  for (const [over, action, why] of cases)
    assert.equal(adviceFor(stat(over))?.action ?? null, action, why);
  // 窗口大于门槛算出的次数时，占比那一条才真正起作用：40 次里 3 起（7.5%）不收紧。
  assert.equal(
    adviceFor(stat({ recent_deliveries: 40, recent_incidents: 3 })),
    null,
  );
  assert.match(
    adviceFor(stat({ recent_incidents: 3, incidents: 3 }))!.reason,
    /最近 20 次交付有 3 起事故/,
  );
});

test("同一建议 7 天内不重复", () => {
  const now = 10 * ADVICE_REPEAT_MS;
  assert.equal(adviceDue(null, now), true);
  assert.equal(adviceDue(now - 1000, now), false);
  assert.equal(adviceDue(now - ADVICE_REPEAT_MS + 1, now), false);
  assert.equal(adviceDue(now - ADVICE_REPEAT_MS, now), true);
});

test("建议事件是知会级，不叫醒秘书", () => {
  assert.equal(eventLevel("worker_advice", { action: "tighten" }), "info");
  assert.equal(eventLevel("worker_advice", { action: "relax" }), "info");
});

const WORKER = "claude+opus:high";
function ledger() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const role = createJobRole(db, {
    name: "后端",
    description: "服务与数据",
    body: "测试要过",
    preferred: [],
    checks: ["local_check"],
  });
  /** 交付一次；incident 时记一次卡死（算一起事故）。 */
  const deliver = (at: number, incident = false) => {
    const task = createTask(db, { title: `活 ${at}`, job: role.ref });
    advanceTask(
      db,
      task.ref,
      { kind: "start" },
      { worker: WORKER },
      { worker: WORKER },
      at,
    );
    noteTask(db, task.id, "gates", { passed: true, results: [] }, at + 10);
    if (incident)
      noteTask(db, task.id, "stalled", { detail: { reason: "卡死" } }, at + 20);
    advanceTask(db, task.ref, { kind: "exit_ok" }, {}, undefined, at + 100);
    return task;
  };
  return { db, role, deliver };
}

test("统计只把最近一段的事故算进窗口，SQL 与逐条折算一致", () => {
  const { db, role, deliver } = ledger();
  for (let i = 0; i < 5; i++) deliver(1000 + i * 1000, true);
  for (let i = 0; i < ADVICE_WINDOW; i++) deliver(100_000 + i * 1000);
  const combo = workerStats(db, { job: role.id }).find(
    (s) => s.scope === "combination",
  )!;
  assert.equal(combo.deliveries, 25);
  assert.equal(combo.incidents, 5);
  assert.equal(combo.recent_deliveries, ADVICE_WINDOW);
  assert.equal(combo.recent_incidents, 0);
  assert.equal(adviceFor(combo), null, "老事故不再触发收紧");
  assert.deepEqual(workerStats(db), summarizeDeliveries(listDeliveries(db)));
  db.close();
});

test("收紧建议投给秘书一次，7 天内同一组合不再投，过了再投", () => {
  const { db, deliver } = ledger();
  const inbox = new EventInbox(db);
  const day = 24 * 60 * 60 * 1000;
  let last = deliver(1000, true);
  for (let i = 1; i < 6; i++) last = deliver(1000 + i * 1000, i < 3);
  publishWorkerAdvice(db, inbox, last.id, 10 * day);
  const next = deliver(20_000);
  publishWorkerAdvice(db, inbox, next.id, 12 * day);
  publishWorkerAdvice(db, inbox, next.id, 12 * day);
  const events = () =>
    db
      .prepare(
        "SELECT task_id,detail FROM task_events WHERE kind='worker_advice' ORDER BY id",
      )
      .all() as { task_id: number; detail: string }[];
  assert.equal(events().length, 1, "7 天内只投一次");
  assert.equal(JSON.parse(events()[0]!.detail).action, "tighten");
  const later = deliver(30_000);
  publishWorkerAdvice(db, inbox, later.id, 17 * day + 1);
  assert.equal(events().length, 2, "满 7 天再投");
  const pending = inbox.pending("secretary");
  assert.equal(pending.length, 0, "知会级不进待处理");
  const all = inbox.pending("secretary", 50, true);
  assert.ok(all.length >= 1);
  assert.ok(all.every((e) => e.kind !== "worker_advice" || e.level === "info"));
  inbox.close();
  db.close();
});

test("118 次交付 1 起事故不投建议", () => {
  const { db, deliver } = ledger();
  const inbox = new EventInbox(db);
  let last = deliver(1000, true);
  for (let i = 1; i < 118; i++) last = deliver(1000 + i * 1000);
  publishWorkerAdvice(db, inbox, last.id, 1_000_000_000);
  const advice = db
    .prepare("SELECT detail FROM task_events WHERE kind='worker_advice'")
    .all() as { detail: string }[];
  assert.ok(
    advice.every((row) => JSON.parse(row.detail).action !== "tighten"),
    "不建议收紧",
  );
  inbox.close();
  db.close();
});

test("老库里按要处理存的建议启动时回写为知会", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  new EventInbox(db).close();
  db.prepare(
    "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,detail,level,created_at,updated_at,ready_at) VALUES('secretary',NULL,'workers','worker_advice','t1:worker_advice','{}','action',1,1,1)",
  ).run();
  const inbox = new EventInbox(db);
  assert.equal(
    (
      db
        .prepare("SELECT level FROM task_inbox WHERE kind='worker_advice'")
        .get() as { level: string }
    ).level,
    "info",
  );
  inbox.close();
  db.close();
});
