import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { ensureTaskTables } from "../server/tasks/ledger/ledger-schema.ts";
import { BRIEF_MAX_BYTES } from "../server/tasks/ledger/brief.ts";
import { quotaReserve } from "../server/tasks/quota/budget.ts";
import { backfillBriefs, readLegacyBrief } from "../server/imports/briefs.ts";
import {
  commonAncestor,
  headOf,
  RESEARCH_BRIEF,
} from "../server/imports/rules.ts";
import { legacyDir } from "../server/imports/index.ts";
import { ensureImportMarks, importMark } from "../server/imports/marks.ts";
import { removeTemp } from "./temp-dir.ts";

const temp = (t: { after: (fn: () => unknown) => void }, name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `atrium-${name}-`));
  t.after(() => removeTemp(dir));
  return dir;
};

test("旧详述读取：绝对与相对路径、没有仓库、读不到、超限截断", (t) => {
  const dir = temp(t, "brief-read");
  writeFileSync(join(dir, "a.md"), "﻿# 详述");
  assert.deepEqual(readLegacyBrief(join(dir, "a.md"), null), {
    ok: true,
    text: "# 详述",
    clipped: false,
  });
  assert.deepEqual(readLegacyBrief("a.md", dir), {
    ok: true,
    text: "# 详述",
    clipped: false,
  });
  assert.deepEqual(readLegacyBrief("a.md", null), {
    ok: false,
    reason: "相对路径但任务没有仓库",
  });
  const missing = readLegacyBrief(join(dir, "gone.md"), null);
  assert.equal(missing.ok, false);
  assert.match(
    !missing.ok ? missing.reason : "",
    /读不到 .*gone\.md（ENOENT）/,
  );
  writeFileSync(join(dir, "big.md"), "字".repeat(BRIEF_MAX_BYTES));
  const big = readLegacyBrief(join(dir, "big.md"), null);
  assert.ok(big.ok && big.clipped);
  assert.ok(big.ok && Buffer.byteLength(big.text) <= BRIEF_MAX_BYTES);
  assert.ok(big.ok && big.text.endsWith("（详述过长，以下已截断）"));
  assert.ok(big.ok && !big.text.includes("�"));
});

test("旧任务详述回填：读得到的进库，读不到的记日志留路径；整轮做完记号不再读", (t) => {
  const dir = temp(t, "brief-backfill");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureImportMarks(db);
  writeFileSync(join(dir, "one.md"), "第一份");
  writeFileSync(join(dir, "topic.md"), "相对路径原文");
  const insert = db.prepare(
    "INSERT INTO tasks(title,brief_path,brief,repo,status,created_at,updated_at) VALUES(?,?,?,?,'todo',0,0)",
  );
  insert.run("绝对路径", join(dir, "one.md"), null, null);
  insert.run("相对路径", "topic.md", null, dir);
  insert.run("读不到", join(dir, "gone.md"), null, null);
  insert.run("已进库", join(dir, "gone.md"), "库里的", null);
  insert.run("没有详述", null, null, null);
  const logs: string[] = [];
  assert.deepEqual(
    backfillBriefs(db, (line) => logs.push(line)),
    { filled: 2, missing: 1 },
  );
  const briefs = db
    .prepare("SELECT id,brief,brief_path FROM tasks ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(
    briefs.map((row) => row.brief),
    ["第一份", "相对路径原文", null, "库里的", null],
  );
  assert.equal(briefs[2]!.brief_path, join(dir, "gone.md"));
  assert.ok(logs.some((line) => /t3 读不到 .*保留原路径/.test(line)));
  assert.match(importMark(db, "task_briefs")!.detail, /回填 2 份，读不到 1 份/);
  // 记号在：再启动不再读文件，补上文件也不会回填。
  writeFileSync(join(dir, "gone.md"), "后来补的");
  assert.equal(
    backfillBriefs(db, () => assert.fail("不该再读")),
    null,
  );
  assert.equal(
    (db.prepare("SELECT brief FROM tasks WHERE id=3").get() as { brief: null })
      .brief,
    null,
  );
});

test("旧目录：ATRIUM_LEGACY_DIR 优先；测试进程不给就不读主目录", () => {
  assert.equal(legacyDir({ ATRIUM_LEGACY_DIR: "/x/Atrium" }), "/x/Atrium");
  assert.equal(legacyDir({ NODE_TEST_CONTEXT: "child" }), undefined);
  assert.match(legacyDir({})!, /Atrium$/);
});

test("带旧表与旧式任务表的库启动：详述回填；删掉旧目录再启动一切照常", async (t) => {
  const data = temp(t, "imports-app");
  const legacy = join(data, "legacy");
  mkdirSync(join(legacy, "briefs"), { recursive: true });
  const briefFile = join(legacy, "briefs", "t1.md");
  writeFileSync(briefFile, "# 旧任务详述\n按这里做");
  // 旧运行时的表与升级前的任务表（没有 brief 列）。
  const old = new DatabaseSync(join(data, "atrium.sqlite"));
  old.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL, brief_path TEXT, role TEXT, repo TEXT,
      status TEXT NOT NULL CHECK(status IN ('todo','running','done','failed','blocked','cancelled')),
      worker TEXT, pid INTEGER, worktree TEXT, branch TEXT, pr_url TEXT, ci TEXT, result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);`);
  old
    .prepare(
      "INSERT INTO tasks(title,brief_path,status,created_at,updated_at) VALUES('旧任务',?,'todo',1,1)",
    )
    .run(briefFile);
  old.close();
  const host = { host: "127.0.0.1" };
  const start = () =>
    createApp({
      data,
      auth: false,
      tasks: { pace: async () => undefined },
    });
  let { app, db } = await start();
  const show = async () => {
    const task = await app.inject({ url: "/api/tasks/t1", headers: host });
    assert.equal(task.statusCode, 200, task.body);
    return task.json() as { brief: string; brief_path: string };
  };
  assert.equal((await show()).brief, "# 旧任务详述\n按这里做");
  assert.equal(quotaReserve(db).percent, 20);
  await app.close();
  removeTemp(legacy);
  ({ app, db } = await start());
  try {
    const task = await show();
    assert.equal(task.brief, "# 旧任务详述\n按这里做");
    assert.equal(task.brief_path, briefFile);
    const list = await app.inject({ url: "/api/tasks", headers: host });
    assert.equal(
      (list.json() as { tasks: { brief?: string }[] }).tasks[0]!.brief,
      undefined,
    );
    assert.deepEqual(
      db
        .prepare("SELECT id,name FROM agents")
        .all()
        .map((row) => ({ ...row })),
      [{ id: "x", name: "旧身份" }],
    );
  } finally {
    await app.close();
  }
});

test("规矩并进要点的纯函数：共同上级、判重的开头", () => {
  const list = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 2 },
    { id: 4, parent_id: 2 },
    { id: 5, parent_id: 1 },
  ];
  assert.equal(commonAncestor(list, [3, 4]), 2);
  assert.equal(commonAncestor(list, [3, 5]), 1);
  assert.equal(commonAncestor(list, [3]), 3);
  assert.equal(commonAncestor(list, [99]), 1, "找不到的退回根");
  assert.equal(
    headOf("每项任务的首要目标是让系统更简洁，哪怕…"),
    headOf("每项任务的首要目标是让系统更简洁：先找…"),
  );
});

test("旧库启动：硬边界、原则决定、管方面的部门、产品部、章程目标一次并进要点与配置；再启动不重复", async (t) => {
  const data = temp(t, "rules");
  const old = new DatabaseSync(join(data, "atrium.sqlite"));
  old.exec(`CREATE TABLE org_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES org_nodes(id),
      kind TEXT NOT NULL CHECK(kind IN ('org','project','module','concern')), slug TEXT NOT NULL, name TEXT NOT NULL,
      leader TEXT, doc_path TEXT, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      aspect INTEGER NOT NULL DEFAULT 0, applies TEXT, UNIQUE(parent_id,slug));
    INSERT INTO org_nodes(id,parent_id,kind,slug,name,created_at,updated_at,aspect,applies) VALUES
      (1,NULL,'org','org','组织',1,1,0,NULL),(2,1,'project','atrium','Atrium',1,1,0,NULL),
      (3,2,'module','cli','命令行',1,1,0,NULL),(4,2,'module','perf','性能',1,1,1,NULL),
      (5,2,'module','product','产品部',1,1,0,NULL);
    CREATE TABLE org_points (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, pos INTEGER NOT NULL,
      text TEXT NOT NULL, why TEXT NOT NULL, decided_by TEXT NOT NULL, check_ref TEXT, updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL, applies TEXT, sources TEXT);
    INSERT INTO org_points(node_id,pos,text,why,decided_by,updated_by,updated_at,applies) VALUES
      (1,1,'每项任务的首要目标是让系统更简洁：先找最简单的做法','越来越复杂','u1 09-28','u1',1,NULL),
      (4,1,'命令秒回','天天用','u1 09-27','u1',1,NULL),
      (4,2,'命令行不做 n²','会变慢','u1 09-27','u1',1,'[3]');
    CREATE TABLE org_boundaries (node_id INTEGER NOT NULL, bid TEXT NOT NULL, pos INTEGER NOT NULL,
      summary TEXT NOT NULL, detail TEXT, param_key TEXT, param_value REAL, PRIMARY KEY(node_id,bid));
    INSERT INTO org_boundaries VALUES (1,'no-spend',0,'不花钱',NULL,NULL,NULL),
      (1,'quota-reserve',1,'额度留给用户',NULL,'quota_reserve_percent',25),
      (1,'money',2,'花费上限（元）',NULL,'money_yuan_max',0);
    CREATE TABLE org_docs (node_id INTEGER NOT NULL, doc TEXT NOT NULL CHECK(doc IN ('charter','card')), rev INTEGER NOT NULL,
      fields TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(node_id,doc));
    INSERT INTO org_docs VALUES (2,'charter',3,'{"goal":"成为运行底座","report":"每周","now":"跑通了"}','旧正文','u1',1),
      (3,'charter',1,'{"goal":"命令秒回","what":"命令行入口"}','','u1',1);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, decided_on TEXT NOT NULL,
      decided_by TEXT NOT NULL, text TEXT NOT NULL, why TEXT NOT NULL, issue INTEGER, node_id INTEGER, task_id INTEGER,
      superseded_by INTEGER, superseded_at INTEGER, created_at INTEGER NOT NULL, principle INTEGER NOT NULL DEFAULT 0,
      settled_point INTEGER, settled_at INTEGER);
    INSERT INTO decisions(id,owner,decided_on,decided_by,text,why,created_at,principle,settled_point,superseded_by) VALUES
      (1,'u1','2026-09-26','u1','Atrium 定位','转为 AI 组织的运行底座',1,1,NULL,NULL),
      (2,'u1','2026-09-28','u1','每项任务的首要目标是让系统更简洁，哪怕要上交','不为绕过去再加补丁',1,1,NULL,NULL),
      (3,'u1','2026-09-27','u1','外部系统做成可插拔','公司不在 GitHub 上',1,1,NULL,NULL),
      (4,'a1','2026-09-27','a1','普通决定','不迁',1,0,NULL,NULL),
      (5,'u1','2026-09-27','u1','已沉淀的原则','不再迁',1,1,9,NULL);
    CREATE TABLE decision_nodes (decision_id INTEGER NOT NULL, node_id INTEGER NOT NULL, PRIMARY KEY(decision_id,node_id));
    INSERT INTO decision_nodes VALUES (3,2);
    CREATE TABLE products (node_id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, leader TEXT NOT NULL,
      schedule_id INTEGER, created_at INTEGER NOT NULL);
    INSERT INTO products VALUES (5,2,'a3',1,1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('task','patrol','research')), every_ms INTEGER NOT NULL, at_minute INTEGER,
      brief TEXT, brief_path TEXT, by TEXT, worker TEXT, next_at INTEGER NOT NULL, removed_at INTEGER,
      last_task_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO schedules(node_id,title,kind,every_ms,next_at,created_at,updated_at) VALUES (5,'下一步调研','research',604800000,9e12,1,1);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL, brief_path TEXT, role TEXT, repo TEXT,
      status TEXT NOT NULL CHECK(status IN ('todo','running','done','failed','blocked','cancelled')),
      worker TEXT, pid INTEGER, worktree TEXT, branch TEXT, pr_url TEXT, ci TEXT, result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES (1,'原任务','done',1,1),(2,'上线验证：t1','todo',1,1);
    CREATE TABLE task_verifications (verify_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, verdict TEXT,
      created_at INTEGER NOT NULL, decided_at INTEGER, summary TEXT);
    INSERT INTO task_verifications VALUES (2,1,NULL,1,NULL,NULL);`);
  old.close();
  const start = () =>
    createApp({ data, auth: false, tasks: { pace: async () => undefined } });
  let { app, db } = await start();
  const points = () =>
    db
      .prepare(
        "SELECT node_id,pos,text,why,decided_by FROM org_points ORDER BY node_id,pos",
      )
      .all()
      .map((r) => ({ ...r }));
  const before = points();
  try {
    assert.deepEqual(
      before.map((p) => [p.node_id, p.pos, p.text]),
      [
        [1, 1, "不花钱"],
        [1, 2, "每项任务的首要目标是让系统更简洁：先找最简单的做法"],
        [1, 3, "Atrium 定位：转为 AI 组织的运行底座"],
        [2, 1, "外部系统做成可插拔：公司不在 GitHub 上"],
        [2, 2, "命令秒回"],
        [3, 1, "命令行不做 n²"],
      ],
      "硬边界排在根最前；和 k 重复的原则（开头相同）不迁；只写了标题的原则并进原因；管方面的要点挪到适用范围的共同上级",
    );
    assert.equal(before[0]!.why, "底线");
    assert.equal(before[3]!.decided_by, "u1 09-27");
    assert.equal(before[3]!.why, "原则决定 d3");
    assert.deepEqual(
      db
        .prepare("SELECT key,value FROM org_limits ORDER BY key")
        .all()
        .map((r) => ({ ...r })),
      [
        { key: "money_yuan_max", value: 0 },
        { key: "quota_reserve_percent", value: 25 },
      ],
    );
    assert.equal(quotaReserve(db).percent, 25);
    const fields = (id: number) =>
      JSON.parse(
        (
          db.prepare("SELECT fields FROM org_docs WHERE node_id=?").get(id) as {
            fields: string;
          }
        ).fields,
      );
    assert.deepEqual(fields(2), { now: "跑通了", what: "成为运行底座" });
    assert.deepEqual(fields(3), { what: "命令行入口" }, "已写的是什么不动");
    assert.ok(
      (
        db.prepare("SELECT archived_at FROM org_nodes WHERE id=5").get() as {
          archived_at: number | null;
        }
      ).archived_at,
      "产品部归档",
    );
    assert.deepEqual(
      { ...db.prepare("SELECT node_id,brief FROM schedules WHERE id=1").get() },
      { node_id: 2, brief: RESEARCH_BRIEF },
    );
    assert.equal(
      (
        db.prepare("SELECT status FROM tasks WHERE id=2").get() as {
          status: string;
        }
      ).status,
      "cancelled",
      "没出结论的上线验证任务取消",
    );
    const map = await app.inject({
      url: "/api/map/context/o3",
      headers: { host: "127.0.0.1" },
    });
    assert.match(map.json().text, /\[组织\]\n1\. 不花钱（底线）/);
  } finally {
    await app.close();
  }
  ({ app, db } = await start());
  try {
    assert.deepEqual(points(), before, "只迁一次");
  } finally {
    await app.close();
  }
});
