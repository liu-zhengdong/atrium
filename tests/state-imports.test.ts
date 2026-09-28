import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import { ownBoundaries } from "../server/org/boundary-store.ts";
import { history } from "../server/org/read.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { BRIEF_MAX_BYTES } from "../server/tasks/brief.ts";
import { quotaReserve } from "../server/tasks/budget.ts";
import { backfillBriefs, readLegacyBrief } from "../server/imports/briefs.ts";
import {
  importCharterBudget,
  missingBudget,
  parseCharterBudget,
} from "../server/imports/charter.ts";
import { legacyDir } from "../server/imports/index.ts";
import { ensureImportMarks, importMark } from "../server/imports/marks.ts";
import { removeTemp } from "./temp-dir.ts";

const temp = (t: { after: (fn: () => unknown) => void }, name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `atrium-${name}-`));
  t.after(() => removeTemp(dir));
  return dir;
};

test("旧章程预算解析：嵌套字段与注释、money 旧写法、磁盘下限不再导入、坏值与未知键逐项报", () => {
  const parsed = parseCharterBudget(
    "﻿---\r\nstatus: 草稿\r\nbudget:\r\n  quota_reserve_percent: 25 # 给用户\r\n  disk_min_free_gb: 15\r\n  money: 0\r\n---\r\n# 正文",
  );
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(
    parsed.entries.map((e) => [e.id, e.param]),
    [
      ["quota-reserve", { key: "quota_reserve_percent", value: 25 }],
      ["money", { key: "money_yuan_max", value: 0 }],
    ],
  );
  assert.deepEqual(parseCharterBudget("# 没有 frontmatter"), {
    entries: [],
    problems: [],
  });
  assert.deepEqual(parseCharterBudget("---\nstatus: 草稿\n---\n"), {
    entries: [],
    problems: [],
  });
  for (const value of ["-1", "101", "abc", "''"]) {
    const bad = parseCharterBudget(
      `---\nbudget:\n  quota_reserve_percent: ${value}\n  money: 10\n---\n`,
    );
    assert.equal(bad.entries.length, 1, value);
    assert.equal(bad.entries[0]!.param!.key, "money_yuan_max");
    assert.match(bad.problems[0]!, /quota_reserve_percent.*跳过/);
  }
  assert.match(
    parseCharterBudget("---\nbudget:\n  tokens: 3\n---\n").problems[0]!,
    /budget\.tokens 不认识/,
  );
  assert.match(
    parseCharterBudget("---\nbudget: [1\n---\n").problems[0]!,
    /frontmatter 解析失败/,
  );
  assert.match(
    parseCharterBudget("---\nbudget: 3\n---\n").problems[0]!,
    /budget 应为键值/,
  );
});

test("根章程缺哪几项预算：已有同参数跳过，id 撞上无参数条目报跳过，其余补上", () => {
  const imported = parseCharterBudget(
    "---\nbudget:\n  quota_reserve_percent: 20\n  disk_min_free_gb: 15\n  money: 0\n---\n",
  ).entries;
  assert.equal(missingBudget([], imported).add.length, 2);
  const own = [
    {
      id: "reserve",
      summary: "留给用户",
      detail: null,
      param: { key: "quota_reserve_percent" as const, value: 30 },
    },
    { id: "money", summary: "不花钱", detail: null, param: null },
  ];
  const result = missingBudget(own, imported);
  assert.deepEqual(
    result.add.map((e) => e.id),
    [],
  );
  assert.deepEqual(result.skipped, ["money_yuan_max（根章程已有条目 money）"]);
});

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
  writeFileSync(join(dir, "topic.md"), "议题原文");
  const insert = db.prepare(
    "INSERT INTO tasks(title,brief_path,brief,repo,status,created_at,updated_at) VALUES(?,?,?,?,'todo',0,0)",
  );
  insert.run("绝对路径", join(dir, "one.md"), null, null);
  insert.run("相对路径", "topic.md", null, dir);
  insert.run("读不到", join(dir, "gone.md"), null, null);
  insert.run("已进库", join(dir, "gone.md"), "库里的", null);
  insert.run("没有详述", null, null, null);
  db.prepare(
    "INSERT INTO task_councils(task_id,topic,topic_brief,stage,created_at) VALUES(2,'议题',?, 'opinions',0)",
  ).run("topic.md");
  const logs: string[] = [];
  assert.deepEqual(
    backfillBriefs(db, (line) => logs.push(line)),
    { filled: 3, missing: 1 },
  );
  const briefs = db
    .prepare("SELECT id,brief,brief_path FROM tasks ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(
    briefs.map((row) => row.brief),
    ["第一份", "议题原文", null, "库里的", null],
  );
  assert.equal(briefs[2]!.brief_path, join(dir, "gone.md"));
  assert.equal(
    (
      db.prepare("SELECT topic_text FROM task_councils").get() as {
        topic_text: string;
      }
    ).topic_text,
    "议题原文",
  );
  assert.ok(logs.some((line) => /t3 读不到 .*保留原路径/.test(line)));
  assert.match(importMark(db, "task_briefs")!.detail, /回填 3 份，读不到 1 份/);
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

function orgDb(t: { after: (fn: () => unknown) => void }) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureOrgTables(db);
  ensureImportMarks(db);
  return db;
}
const addRoot = (db: DatabaseSync) =>
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建树" }, "u1");

test("根章程预算导入：没有根等下次；导入一次留修订；再启动不读文件", (t) => {
  const dir = temp(t, "charter");
  const file = join(dir, "charter.md");
  writeFileSync(
    file,
    "---\nbudget:\n  quota_reserve_percent: 30\n  disk_min_free_gb: 12\n  money: 0\n---\n# 章程",
  );
  const db = orgDb(t);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  assert.deepEqual(importCharterBudget(db, file, log), { status: "no_root" });
  assert.equal(importMark(db, "charter_budget"), undefined);
  const root = addRoot(db);
  editDoc(
    db,
    `o${root.id}`,
    "charter",
    {
      fields: { goal: "目标" },
      body: "正文",
      boundaries: [{ id: "no-spend", summary: "不花钱" }],
      reason: "建章程",
    },
    "u1",
  );
  assert.deepEqual(importCharterBudget(db, file, log), {
    status: "imported",
    keys: ["quota_reserve_percent", "money_yuan_max"],
  });
  assert.deepEqual(
    ownBoundaries(db, root.id).map((e) => [e.id, e.param?.value ?? null]),
    [
      ["no-spend", null],
      ["quota-reserve", 30],
      ["money", 0],
    ],
  );
  assert.deepEqual(quotaReserve(db), { percent: 30, set_by: `o${root.id}` });
  const listed = history(db, `o${root.id}`, { target: "charter" });
  assert.ok(
    listed.items?.some((r) => r.reason === `从 ${file} 导入预算`),
    JSON.stringify(listed),
  );
  // 删掉旧文件、再启动：记号在，不读文件，预算照旧来自根章程。
  rmSync(file);
  assert.equal(
    importCharterBudget(db, file, log, () => assert.fail("不该再读")).status,
    "done",
  );
  assert.equal(quotaReserve(db).percent, 30);
});

test("根章程预算导入：只补缺的项；没有旧文件、没有缺项、坏值都记号且不挡启动", (t) => {
  const dir = temp(t, "charter-partial");
  const file = join(dir, "charter.md");
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  const partial = orgDb(t);
  const root = addRoot(partial);
  editDoc(
    partial,
    `o${root.id}`,
    "charter",
    {
      fields: {},
      body: "",
      boundaries: [
        { id: "reserve", summary: "留", param: { quota_reserve_percent: 40 } },
      ],
      reason: "建",
    },
    "u1",
  );
  writeFileSync(
    file,
    "---\nbudget:\n  quota_reserve_percent: 10\n  disk_min_free_gb: 999999\n  money: 0\n---\n",
  );
  assert.deepEqual(importCharterBudget(partial, file, log), {
    status: "imported",
    keys: ["money_yuan_max"],
  });
  assert.equal(quotaReserve(partial).percent, 40);
  assert.ok(!logs.some((line) => /disk_min_free_gb/.test(line)));

  const noFile = orgDb(t);
  addRoot(noFile);
  assert.deepEqual(importCharterBudget(noFile, join(dir, "missing.md"), log), {
    status: "no_file",
  });
  assert.match(importMark(noFile, "charter_budget")!.detail, /没有旧章程/);

  // 根节点只建了节点、还没写章程：导入时连带建出章程。
  const bare = orgDb(t);
  const bareRoot = addRoot(bare);
  writeFileSync(file, "---\nbudget:\n  quota_reserve_percent: 15\n---\n");
  assert.equal(importCharterBudget(bare, file, log).status, "imported");
  assert.deepEqual(quotaReserve(bare), {
    percent: 15,
    set_by: `o${bareRoot.id}`,
  });
});

test("旧目录：ATRIUM_LEGACY_DIR 优先；测试进程不给就不读主目录", () => {
  assert.equal(legacyDir({ ATRIUM_LEGACY_DIR: "/x/Atrium" }), "/x/Atrium");
  assert.equal(legacyDir({ NODE_TEST_CONTEXT: "child" }), undefined);
  assert.match(legacyDir({})!, /Atrium$/);
});

test("带旧表与旧式任务表的库启动：详述回填、根章程预算导入；删掉旧目录再启动一切照常", async (t) => {
  const data = temp(t, "imports-app");
  const legacy = join(data, "legacy");
  mkdirSync(join(legacy, "briefs"), { recursive: true });
  const briefFile = join(legacy, "briefs", "t1.md");
  writeFileSync(briefFile, "# 旧任务详述\n按这里做");
  writeFileSync(
    join(legacy, "charter.md"),
    "---\nbudget:\n  quota_reserve_percent: 35\n---\n# 章程",
  );
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
      legacyDir: legacy,
      tasks: { pace: async () => undefined },
    });
  let { app, db } = await start();
  // 第一次启动还没有组织树：详述先回填，根章程等根节点建好。
  const created = await app.inject({
    method: "POST",
    url: "/api/org/nodes",
    headers: host,
    payload: { slug: "org", kind: "org", name: "组织", reason: "建树" },
  });
  assert.equal(created.statusCode, 201, created.body);
  await app.close();
  ({ app, db } = await start());
  const show = async () => {
    const task = await app.inject({ url: "/api/tasks/t1", headers: host });
    assert.equal(task.statusCode, 200, task.body);
    return task.json() as { brief: string; brief_path: string };
  };
  assert.equal((await show()).brief, "# 旧任务详述\n按这里做");
  const quota = (db: DatabaseSync) => quotaReserve(db).percent;
  assert.equal(quota(db), 35);
  await app.close();
  removeTemp(legacy);
  ({ app, db } = await start());
  try {
    const task = await show();
    assert.equal(task.brief, "# 旧任务详述\n按这里做");
    assert.equal(task.brief_path, briefFile);
    assert.equal(quota(db), 35);
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
