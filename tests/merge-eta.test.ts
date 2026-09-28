import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ETA_SAMPLE_CAP_MS,
  ETA_SAMPLES,
  ETA_WINDOW_MS,
  etaText,
  mergeEta,
  mergeQueueText,
} from "../server/tasks/merge-eta.ts";
import { mergeQueueView } from "../server/tasks/merge-queue-view.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";

const MIN = 60_000;

test("预计还要多久：排着的每件一份平均用时，正在合入的扣掉已用的", () => {
  const samples = [10 * MIN, 20 * MIN];
  assert.deepEqual(mergeEta({ waiting: 16, merging: null, samples }), {
    waiting: 16,
    merging: 0,
    per_ms: 15 * MIN,
    eta_ms: 16 * 15 * MIN,
  });
  assert.equal(
    mergeEta({ waiting: 2, merging: { elapsed_ms: 5 * MIN }, samples }).eta_ms,
    2 * 15 * MIN + 10 * MIN,
  );
  // 正在合入的已经超过平均：至少还算一分钟。
  assert.equal(
    mergeEta({ waiting: 0, merging: { elapsed_ms: 40 * MIN }, samples }).eta_ms,
    MIN,
  );
  // 已用时写坏（负数）按 0 算。
  assert.equal(
    mergeEta({ waiting: 0, merging: { elapsed_ms: -5 }, samples }).eta_ms,
    15 * MIN,
  );
  // 队列空为 0。
  assert.equal(mergeEta({ waiting: 0, merging: null, samples }).eta_ms, 0);
});

test("预计还要多久：没有样本、离群值、坏样本、样本数上限", () => {
  assert.deepEqual(mergeEta({ waiting: 3, merging: null, samples: [] }), {
    waiting: 3,
    merging: 0,
    per_ms: null,
    eta_ms: null,
  });
  assert.equal(
    mergeEta({
      waiting: 1,
      merging: null,
      samples: [NaN, -1, Infinity],
    }).per_ms,
    null,
  );
  // 等人工核对拖了一天的那件按上限算。
  assert.equal(
    mergeEta({ waiting: 1, merging: null, samples: [24 * 60 * MIN, 0] }).per_ms,
    ETA_SAMPLE_CAP_MS / 2,
  );
  // 只取最近 ETA_SAMPLES 个（调用方按新到旧给）。
  const recent = Array.from({ length: ETA_SAMPLES }, () => MIN);
  assert.equal(
    mergeEta({
      waiting: 1,
      merging: null,
      samples: [...recent, 50 * MIN, 50 * MIN],
    }).per_ms,
    MIN,
  );
  assert.equal(
    mergeEta({ waiting: 2.7, merging: null, samples: [MIN] }).waiting,
    2,
  );
});

test("时长与看板一段的写法", () => {
  assert.equal(etaText(0), "约 1 分钟");
  assert.equal(etaText(29_000), "约 1 分钟");
  assert.equal(etaText(25 * MIN), "约 25 分钟");
  assert.equal(etaText(59 * MIN + 29_000), "约 59 分钟");
  assert.equal(etaText(60 * MIN), "约 1 小时");
  assert.equal(etaText(130 * MIN), "约 2 小时 10 分");
  assert.equal(mergeQueueText(null), null);
  assert.equal(mergeQueueText(undefined), null);
  assert.equal(
    mergeQueueText({ waiting: 0, merging: 1, per_ms: MIN, eta_ms: MIN }),
    null,
  );
  assert.equal(
    mergeQueueText({ waiting: 16, merging: 1, per_ms: null, eta_ms: null }),
    "排队合入 16",
  );
  assert.equal(
    mergeQueueText({
      waiting: 16,
      merging: 1,
      per_ms: 8 * MIN,
      eta_ms: 130 * MIN,
    }),
    "排队合入 16 · 还要约 2 小时 10 分",
  );
});

test("合入队列视图从账本取：件数、最近合入用时、正在合入的已用时", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const now = 10 * ETA_WINDOW_MS;
  const task = db.prepare(
    "INSERT INTO tasks(title,deliver,status,delivery_stage,merge_queued_at,created_at,updated_at) VALUES ('t','pr',?,?,?,1,1)",
  );
  const event = db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,NULL)",
  );
  assert.equal(mergeQueueView(db, now), null, "队列空不给");
  // t1、t2 最近合入：用时 10 分钟与 20 分钟（t2 第一次让路后重来，按最后一次开始算）。
  task.run("done", "merged", null);
  event.run(1, now - 60 * MIN, "merge_started");
  event.run(1, now - 50 * MIN, "merged");
  task.run("done", "online", null);
  event.run(2, now - 100 * MIN, "merge_started");
  event.run(2, now - 45 * MIN, "merge_started");
  event.run(2, now - 25 * MIN, "merged");
  // t3 两天前合入：不算。
  task.run("done", "online", null);
  event.run(3, now - 2 * ETA_WINDOW_MS - 90 * MIN, "merge_started");
  event.run(3, now - 2 * ETA_WINDOW_MS, "merged");
  // t4 正在合入，已用 5 分钟；t5、t6 排队；t7 受阻不算。
  task.run("done", "merging", 1);
  event.run(4, now - 5 * MIN, "merge_started");
  task.run("done", "merge_queued", 2);
  task.run("done", "merge_queued", 3);
  task.run("blocked", "merge_queued", 4);
  assert.deepEqual(mergeQueueView(db, now), {
    waiting: 2,
    merging: 1,
    per_ms: 15 * MIN,
    eta_ms: 2 * 15 * MIN + 10 * MIN,
  });
  // 没有近期样本：只给件数。
  const empty = new DatabaseSync(":memory:");
  ensureTaskTables(empty);
  empty
    .prepare(
      "INSERT INTO tasks(title,deliver,status,delivery_stage,merge_queued_at,created_at,updated_at) VALUES ('t','pr','done','merge_queued',1,1,1)",
    )
    .run();
  assert.deepEqual(mergeQueueView(empty, now), {
    waiting: 1,
    merging: 0,
    per_ms: null,
    eta_ms: null,
  });
  db.close();
  empty.close();
});
