import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventInbox } from "../server/tasks/events.ts";
import {
  listDeliveries,
  summarizeDeliveries,
} from "../server/tasks/delivery-records.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  Retention,
  RETENTION_SQL,
  SWEEP_TASKS_MAX,
  TASK_EVENT_TAIL,
} from "../server/tasks/retention.ts";

/**
 * 收件箱与任务事件的保留上限（#t126）：清理只动该动的行，且每条语句都有索引可走。
 */

const DAY = 86400_000;
const NOW = 1_800_000_000_000;

type InboxSeed = {
  subscriber?: string;
  source?: string;
  kind: string;
  level: string;
  acked_at: number | null;
  updated_at?: number;
  created_at?: number;
  task_id?: number;
};

function seedInbox(db: DatabaseSync, rows: InboxSeed[]) {
  const insert = db.prepare(
    `INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,detail,created_at,updated_at,ready_at,acked_at,level)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  );
  rows.forEach((row, index) => {
    const at = row.created_at ?? NOW - DAY;
    insert.run(
      row.subscriber ?? "a1",
      row.task_id ?? null,
      row.source ?? "runner",
      row.kind,
      `k${index}`,
      "{}",
      at,
      row.updated_at ?? at,
      at,
      row.acked_at,
      row.level,
    );
  });
}

test("收件箱保留：只清已确认的知会，按时间与条数都有上限", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  new EventInbox(db);
  seedInbox(db, [
    // 已确认知会、过期：删。
    {
      source: "runner",
      kind: "merge_queued",
      level: "info",
      acked_at: NOW - 20 * DAY,
    },
    { source: "ci", kind: "merged", level: "info", acked_at: NOW - 20 * DAY },
    // leader 的上交/转交：不删。
    {
      source: "leader",
      kind: "merged",
      level: "info",
      acked_at: NOW - 20 * DAY,
    },
    // 未确认知会：不删。
    { source: "runner", kind: "merge_queued", level: "info", acked_at: null },
    // 要处理级别、已确认：不删。
    {
      source: "runner",
      kind: "done",
      level: "action",
      acked_at: NOW - 20 * DAY,
    },
    // 已确认知会、刚确认：不删。
    {
      source: "runner",
      kind: "merge_queued",
      level: "info",
      acked_at: NOW - DAY,
    },
  ]);
  const retention = new Retention(db);
  assert.equal(retention.sweepInbox(NOW, { inboxMax: 0 }), 2);
  assert.deepEqual(
    (
      db
        .prepare(
          "SELECT source,kind,acked_at,level FROM task_inbox ORDER BY id",
        )
        .all() as { kind: string }[]
    ).map((row) => row.kind),
    ["merged", "merge_queued", "done", "merge_queued"],
  );
});

test("收件箱保留：条数上限按确认时间从新到旧保留", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  new EventInbox(db);
  seedInbox(
    db,
    Array.from({ length: 5 }, (_, index) => ({
      source: "runner",
      kind: "merge_queued",
      level: "info",
      acked_at: NOW - index * DAY,
    })),
  );
  const retention = new Retention(db);
  // 时间上限放宽，只看条数：留最近 3 条（acked_at 最大）。
  assert.equal(
    retention.sweepInbox(NOW, { inboxAgeMs: 100 * DAY, inboxMax: 3 }),
    2,
  );
  assert.deepEqual(
    (
      db
        .prepare("SELECT acked_at FROM task_inbox ORDER BY acked_at DESC")
        .all() as { acked_at: number }[]
    ).map((row) => NOW - row.acked_at),
    [0, DAY, 2 * DAY],
  );
});

function seedTask(
  db: DatabaseSync,
  title: string,
  status: string,
  updatedAt: number,
): number {
  return Number(
    db
      .prepare(
        "INSERT INTO tasks(title,status,deliver,created_at,updated_at) VALUES(?,?,'none',?,?)",
      )
      .run(title, status, updatedAt, updatedAt).lastInsertRowid,
  );
}

function seedEvent(
  db: DatabaseSync,
  taskId: number,
  kind: string,
  at: number,
  detailText = "{}",
): number {
  return Number(
    db
      .prepare(
        "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
      )
      .run(taskId, at, kind, detailText).lastInsertRowid,
  );
}

test("任务事件保留：未结束、没过期、事件不足的都原样保留", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const active = seedTask(db, "在跑", "running", NOW - 400 * DAY);
  const recent = seedTask(db, "刚结束", "done", NOW - DAY);
  const tiny = seedTask(db, "老但事件少", "done", NOW - 400 * DAY);
  const oldFew = seedTask(db, "老且事件多", "done", NOW - 400 * DAY);
  const oldMany = seedTask(db, "老且有交付窗口", "done", NOW - 400 * DAY);
  for (let i = 0; i < 10; i++)
    seedEvent(db, active, "note", NOW - 400 * DAY + i);
  for (let i = 0; i < 2; i++) seedEvent(db, tiny, "note", NOW - 400 * DAY + i);
  for (let i = 0; i < 10; i++)
    seedEvent(db, oldFew, "note", NOW - 400 * DAY + i);
  // 事件 1..10，start 在第 5 条。
  for (let i = 0; i < 10; i++)
    seedEvent(db, oldMany, i === 4 ? "start" : "note", NOW - 400 * DAY + i);

  const retention = new Retention(db);
  const removed = retention.sweepEvents(NOW, {
    eventAgeMs: 90 * DAY,
    eventTail: 3,
    taskLimit: 100,
  });
  // 老任务事件多：保留最近 3 条，前面的删掉。
  // 有交付窗口的：边界 = min(倒数第 3 条之后, 最近一次 start) = 第 5 条，删掉前 4 条。
  assert.equal(removed, 7 + 4);
  const count = (id: number) =>
    Number(
      (
        db
          .prepare("SELECT count(*) AS n FROM task_events WHERE task_id=?")
          .get(id) as { n: number }
      ).n,
    );
  assert.equal(count(active), 10);
  assert.equal(count(recent), 0);
  assert.equal(count(tiny), 2);
  assert.equal(count(oldFew), 3);
  assert.equal(count(oldMany), 6);
  assert.ok(
    db
      .prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='start'")
      .get(oldMany),
    "最近一次 start 之后的事件要留着（交付窗口）",
  );
});

test("任务事件保留：老任务的 created 与最新一条 note 清理后仍在", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const id = seedTask(db, "老任务", "done", NOW - 400 * DAY);
  // 事件序：created(派发人，最早)、旧 note、最新 note，随后 10 条过程事件。
  const created = seedEvent(db, id, "created", NOW - 400 * DAY);
  const oldNote = seedEvent(db, id, "note", NOW - 400 * DAY + 1);
  const latestNote = seedEvent(db, id, "note", NOW - 400 * DAY + 2);
  for (let i = 0; i < 10; i++)
    seedEvent(db, id, "running", NOW - 400 * DAY + 3 + i);

  const retention = new Retention(db);
  const removed = retention.sweepEvents(NOW, {
    eventAgeMs: 90 * DAY,
    eventTail: 3,
    taskLimit: 100,
  });
  // 13 条里保留最近 3 条（id 11..13）；再兜底 created 与最新 note（id 3），旧 note 该删。
  // 删掉 id<11 且非 created、非最新 note 的：id 2、4..10 共 8 条。
  assert.equal(removed, 8);
  const rows = db
    .prepare("SELECT id,kind FROM task_events WHERE task_id=? ORDER BY id")
    .all(id) as { id: number; kind: string }[];
  assert.deepEqual(
    rows.map((row) => row.id),
    [created, latestNote, 11, 12, 13],
  );
  assert.equal(rows[0]!.kind, "created");
  assert.equal(rows[1]!.kind, "note");
  assert.equal(
    db.prepare("SELECT 1 FROM task_events WHERE id=?").get(oldNote),
    undefined,
    "旧 note 在窗口外，应被清掉",
  );
});

test("任务事件保留：多轮交付清理前后交付统计完全一致", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const id = seedTask(db, "多轮交付的老任务", "done", NOW - 400 * DAY);
  // 第一轮交付窗口：start → gates 未过 → note 打回 → 合入退回 → 卡死。
  const s1 = seedEvent(
    db,
    id,
    "start",
    NOW - 400 * DAY,
    JSON.stringify({ worker: "claude+opus" }),
  );
  seedEvent(
    db,
    id,
    "gates",
    NOW - 400 * DAY + 1,
    JSON.stringify({
      results: [{ gate: "ci", ok: false, evidence: "红了" }],
      diff: { files: 3, added: 10, deleted: 2 },
      passed: false,
    }),
  );
  seedEvent(
    db,
    id,
    "note",
    NOW - 400 * DAY + 2,
    JSON.stringify({ verdict: "rejected", text: "改" }),
  );
  seedEvent(
    db,
    id,
    "merge_returned",
    NOW - 400 * DAY + 3,
    JSON.stringify({ reason: "rebase 冲突" }),
  );
  seedEvent(db, id, "stalled", NOW - 400 * DAY + 4);
  // 第二轮交付窗口：start → gates 通过 → merged。
  const s2 = seedEvent(
    db,
    id,
    "start",
    NOW - 400 * DAY + 5,
    JSON.stringify({ worker: "codex+gpt" }),
  );
  seedEvent(
    db,
    id,
    "gates",
    NOW - 400 * DAY + 6,
    JSON.stringify({
      results: [{ gate: "ci", ok: true }],
      diff: { files: 1, added: 5, deleted: 1 },
      passed: true,
    }),
  );
  seedEvent(db, id, "merged", NOW - 400 * DAY + 7);
  // 过程事件撑过保留条数，让第一轮窗口落进要删的范围。
  for (let i = 0; i < 20; i++)
    seedEvent(db, id, "run", NOW - 400 * DAY + 8 + i);

  const insertDelivery = db.prepare(
    "INSERT INTO task_deliveries(task_id,start_event_id,worker,tool,model,started_at,ended_at,outcome,final_outcome,historical) VALUES(?,?,?,?,?,?,?,?,?,0)",
  );
  insertDelivery.run(
    id,
    s1,
    "claude+opus",
    "claude",
    "opus",
    NOW - 400 * DAY,
    NOW - 400 * DAY + 4,
    "block",
    "returned",
  );
  insertDelivery.run(
    id,
    s2,
    "codex+gpt",
    "codex",
    "gpt",
    NOW - 400 * DAY + 5,
    NOW - 400 * DAY + 7,
    "exit_ok",
    "merged",
  );
  db.prepare("UPDATE tasks SET delivery_stage='merged' WHERE id=?").run(id);

  const before = listDeliveries(db);
  const beforeStats = summarizeDeliveries(before);

  const retention = new Retention(db);
  const removed = retention.sweepEvents(NOW, {
    eventAgeMs: 90 * DAY,
    eventTail: 3,
    taskLimit: 100,
  });
  assert.ok(removed > 0, "老任务的旧事件应被清掉");
  assert.equal(
    db.prepare("SELECT 1 FROM task_events WHERE id=?").get(s1),
    undefined,
    "第一轮的 start 会被清掉，固化必须兜住它读出的交付事实",
  );
  assert.ok(
    db.prepare("SELECT 1 FROM task_events WHERE id=?").get(s2),
    "第二轮（最新交付窗口）的事件要留着",
  );

  assert.deepEqual(listDeliveries(db), before);
  assert.deepEqual(summarizeDeliveries(listDeliveries(db)), beforeStats);
});

test("任务事件保留：一批清不完时按 id 游标接着清，清完回到开头", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const id = seedTask(db, `旧 ${i}`, "done", NOW - 400 * DAY);
    for (let k = 0; k < 6; k++) seedEvent(db, id, "note", NOW - 400 * DAY);
    ids.push(id);
  }
  const retention = new Retention(db);
  const options = { eventAgeMs: 90 * DAY, eventTail: 2, taskLimit: 1 };
  assert.equal(retention.sweepEvents(NOW, options), 4);
  assert.equal(retention.sweepEvents(NOW, options), 4);
  assert.equal(retention.sweepEvents(NOW, options), 4);
  // 三个任务清完后游标回到开头，再扫是空转。
  assert.equal(retention.sweepEvents(NOW, options), 0);
  for (const id of ids)
    assert.equal(
      Number(
        (
          db
            .prepare("SELECT count(*) AS n FROM task_events WHERE task_id=?")
            .get(id) as { n: number }
        ).n,
      ),
      2,
    );
});

test("保留默认值有界：tail 与每轮任务数都是常数", () => {
  assert.ok(TASK_EVENT_TAIL > 0);
  assert.ok(SWEEP_TASKS_MAX > 0 && SWEEP_TASKS_MAX <= 1000);
});

/** 收件箱相关语句逐条看查询计划：不许出现整表扫描（#t126 守护检查）。 */
const INBOX_STATEMENTS: [string, string][] = [
  [
    "同键未确认事件查找",
    "SELECT * FROM task_inbox WHERE subscriber=? AND dedupe_key=? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) ORDER BY id DESC LIMIT 1",
  ],
  [
    "事件列表分页",
    "SELECT * FROM task_inbox WHERE subscriber=? AND id<? ORDER BY id DESC LIMIT ?",
  ],
  [
    "可投递事件",
    "SELECT * FROM task_inbox WHERE subscriber=? AND id>? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND ready_at<=? AND (delivered_at IS NULL OR delivered_at<=?) AND level='action' ORDER BY id LIMIT 200",
  ],
  [
    "处理中租约",
    "SELECT * FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND delivered_at IS NOT NULL AND (actor IS NULL OR actor<>subscriber) AND level='action' ORDER BY delivered_at,id LIMIT 200 OFFSET ?",
  ],
  [
    "知会摘要",
    "SELECT * FROM task_inbox WHERE subscriber=? AND id>? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND level='info' AND updated_at>=? ORDER BY id LIMIT 200",
  ],
  [
    "按任务查收件箱",
    "SELECT subscriber,acked_at FROM task_inbox WHERE task_id=? AND created_at>=? ORDER BY id DESC LIMIT 1",
  ],
  [
    "leader 待处理数",
    "SELECT kind,detail FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND level='action' ORDER BY id DESC LIMIT 200",
  ],
  [
    "leader 事件",
    "SELECT * FROM task_inbox WHERE subscriber=? AND (actor IS NULL OR actor<>subscriber) AND level='action' ORDER BY updated_at DESC,id DESC LIMIT 200",
  ],
  [
    "leader 上交",
    "SELECT * FROM task_inbox WHERE source='leader' AND kind='escalated' AND actor=? ORDER BY id DESC LIMIT 20",
  ],
  [
    "leader 转交",
    "SELECT dedupe_key,updated_at FROM task_inbox WHERE source='leader' AND dedupe_key LIKE '%:handoff' AND json_extract(detail,'$.handoff.from')=? ORDER BY id DESC LIMIT 200",
  ],
  // 保留清理的三条直接从 RETENTION_SQL 引用，不抄副本，免得和真实语句对不上。
  ["保留清理按时间", RETENTION_SQL.inboxByAge],
  ["保留清理取阈值", RETENTION_SQL.inboxThreshold],
  ["保留清理按条数", RETENTION_SQL.inboxByCount],
];

/** task_events 保留清理的语句：同样逐条断言不走整表扫描。 */
const TASK_EVENT_STATEMENTS: [string, string][] = [
  ["保留清理选任务", RETENTION_SQL.tasksToSweep],
  ["保留清理找边界", RETENTION_SQL.tailBoundary],
  ["保留清理找 start", RETENTION_SQL.lastStart],
  ["保留清理找最新 note", RETENTION_SQL.lastNote],
  ["保留清理删除", RETENTION_SQL.dropEvents],
];

test("老库迁移：补 level 写回级别，并换掉不带级别的待投递索引", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  // 旧版表结构：没有 level，待投递索引也不带 level。
  db.exec(`CREATE TABLE task_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber TEXT NOT NULL, task_id INTEGER, source TEXT NOT NULL, kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL, detail TEXT, count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ready_at INTEGER NOT NULL,
      acked_at INTEGER, actor TEXT, delivered_at INTEGER);
    CREATE INDEX task_inbox_pending ON task_inbox(subscriber,acked_at,id);`);
  const insert = db.prepare(
    "INSERT INTO task_inbox(subscriber,source,kind,dedupe_key,detail,created_at,updated_at,ready_at) VALUES('a1','runner',?,?,?,1,1,1)",
  );
  insert.run("merge_queued", "k1", "{}");
  insert.run("done", "k2", "{}");
  insert.run("ready", "k3", JSON.stringify({ auto: true }));
  insert.run("ready", "k4", JSON.stringify({ auto: true, unassigned: true }));

  const inbox = new EventInbox(db);
  const levels = (
    db.prepare("SELECT kind,level FROM task_inbox ORDER BY id").all() as {
      kind: string;
      level: string;
    }[]
  ).map((row) => `${row.kind}:${row.level}`);
  assert.deepEqual(levels, [
    "merge_queued:info",
    "done:action",
    "ready:info",
    "ready:action",
  ]);
  const index = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='task_inbox_pending'",
    )
    .get() as { sql: string };
  assert.match(index.sql, /level/);
  // 待投递只看要处理：知会与自愈 ready 都被 SQL 过滤掉。
  assert.deepEqual(
    inbox.pending("a1").map((event) => event.key),
    ["k2", "k4"],
  );
  // all=true 连知会一起看。
  assert.deepEqual(
    inbox.pending("a1", 10, true).map((event) => event.key),
    ["k1", "k2", "k3", "k4"],
  );
});

/** 取一条语句的查询计划摘要（用 1 占位每个参数）。 */
function planOf(db: DatabaseSync, sql: string): string {
  return (
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(
        ...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1),
      ) as { detail: string }[]
  )
    .map((row) => row.detail)
    .join(" | ");
}

test("收件箱语句查询计划：每条都有索引，不扫整张表", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  new EventInbox(db);
  seedInbox(db, [
    { kind: "done", level: "action", acked_at: null },
    { kind: "merged", level: "info", acked_at: NOW },
  ]);
  for (const [name, sql] of INBOX_STATEMENTS) {
    const detail = planOf(db, sql);
    assert.doesNotMatch(
      detail,
      /SCAN task_inbox/,
      `${name} 扫了整张表：${detail}`,
    );
  }
});

test("任务事件保留语句查询计划：不扫 task_events 或 tasks 整表", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  for (const [name, sql] of TASK_EVENT_STATEMENTS) {
    const detail = planOf(db, sql);
    assert.doesNotMatch(
      detail,
      /SCAN (task_events|tasks)\b/,
      `${name} 扫了整张表：${detail}`,
    );
  }
});
