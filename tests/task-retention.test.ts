import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventInbox } from "../server/tasks/events/events.ts";
import { ensureTaskTables } from "../server/tasks/ledger/ledger.ts";
import { Retention, RETENTION_SQL } from "../server/tasks/events/retention.ts";

/**
 * 收件箱的保留上限（#t126）：清理只动该动的行，且每条语句都有索引可走；任务事件不清理。
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
