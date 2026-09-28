import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  addTaskNote,
  createTask,
  ensureTaskTables,
  taskTree,
  updateTask,
} from "../server/tasks/ledger/ledger.ts";
import { addEvent } from "../server/tasks/ledger/ledger-model.ts";
import { noteView, noteViews } from "../server/tasks/ledger/notes.ts";
import { ensureLeaderTables } from "../server/leaders/model.ts";
import { createApp } from "../server/app.ts";
import { treeMore } from "../cli/tasks.ts";
import { tempDir } from "./temp-dir.ts";

function memory() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureTaskTables(db);
  return db;
}

/** 记下 taskTree 发出的每条 SQL：数语句、看查询计划。 */
function spy(db: DatabaseSync) {
  const sqls: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    sqls.push(sql);
    return prepare(sql);
  };
  return { sqls, prepare };
}

const refs = (tree: ReturnType<typeof taskTree>) =>
  tree.tasks.map((node) => node.ref);

test("task tree 无根：未完成的顶层按页列，已结束的只列最近几个", () => {
  const db = memory();
  // t1..t47：每 4 个里 1 个做完，其余待办；每个顶层带一个子任务。
  const open: string[] = [];
  const closed: string[] = [];
  for (let i = 0; i < 47; i++) {
    const top = createTask(db, {
      title: `顶层${i}`,
      brief: "详述".repeat(500),
    });
    createTask(db, { title: `子${i}`, parent: top.ref });
    if (i % 4 === 0) {
      updateTask(db, top.ref, { status: i % 8 ? "cancelled" : "done" });
      closed.push(top.ref);
    } else open.push(top.ref);
  }
  assert.equal(open.length, 35);
  assert.equal(closed.length, 12);

  const first = taskTree(db);
  assert.deepEqual(
    refs(first),
    [...open.slice(0, 30), ...closed.slice(-10)].sort(
      (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
    ),
  );
  assert.equal(first.next_after, open[29]);
  assert.equal(first.remaining, 5);
  assert.equal(first.closed_hidden, 2);
  assert.equal(first.truncated, false);
  // 子任务照常挂在下面；节点不带详述、结果等大字段。
  const node = first.tasks[0]!;
  assert.equal(node.children.length, 1);
  assert.equal(node.child_summary?.total, 1);
  for (const key of ["brief", "result", "brief_path", "worktree", "id"])
    assert.equal(key in node, false, key);

  const second = taskTree(db, undefined, { after: first.next_after! });
  assert.deepEqual(refs(second), open.slice(30));
  assert.equal(second.next_after, null);
  assert.equal(second.remaining, 0);
  assert.equal(second.closed_hidden, 12);

  const all = taskTree(db, undefined, { all: "1", limit: "20" });
  assert.equal(all.tasks.length, 20);
  assert.equal(all.tasks[0]!.ref, "t1");
  assert.equal(all.remaining, 27);
  assert.equal(all.closed_hidden, 0);
  const rest = taskTree(db, undefined, {
    all: "1",
    after: all.next_after!,
    limit: "200",
  });
  assert.equal(rest.tasks.length, 27);
  assert.equal(rest.next_after, null);

  // 已结束的不足最近几个时全列，不提示隐藏。
  const small = memory();
  createTask(small, { title: "做完" });
  updateTask(small, "t1", { status: "done" });
  createTask(small, { title: "在做" });
  const few = taskTree(small);
  assert.deepEqual(refs(few), ["t1", "t2"]);
  assert.equal(few.closed_hidden, 0);

  assert.deepEqual(treeMore(first, { all: false }), {
    lines: [
      "还有 5 个未完成的顶层任务没列出",
      "另有 2 个已结束的顶层任务没列出：atrium task tree --all",
    ],
    next: `下一页：atrium task tree --after ${open[29]}`,
  });
  assert.deepEqual(treeMore(all, { all: true, limit: "20" }), {
    lines: ["还有 27 个顶层任务没列出"],
    next: `下一页：atrium task tree --all --after t39 --limit 20`,
  });
  assert.deepEqual(treeMore(few, { all: false }), { lines: [], next: null });
});

test("task tree 翻页参数校验：中文报错，给了根不接受翻页参数", () => {
  const db = memory();
  createTask(db, { title: "目标" });
  for (const [query, pattern] of [
    [{ limit: "0" }, /limit: 应为 1～200 的整数/],
    [{ limit: "201" }, /limit: 应为 1～200 的整数/],
    [{ limit: "abc" }, /limit: 应为 1～200 的整数/],
    [{ all: "yes" }, /all: 只能是 1/],
    [{ after: "x" }, /after: 任务短号/],
  ] as const)
    assert.throws(
      () => taskTree(db, undefined, query),
      (error: { statusCode?: number; message: string }) =>
        error.statusCode === 400 && pattern.test(error.message),
    );
  assert.throws(
    () => taskTree(db, "t1", { all: "1" }),
    /all、after、limit 只用于不给 root 时/,
  );
});

test("task tree 备注批量查：与逐个 noteView 一致（受阻处理中、leader 名、坏记录）", () => {
  const db = memory();
  ensureLeaderTables(db);
  db.prepare(
    "INSERT INTO org_leaders(id,name,worker,created_at,updated_at) VALUES (1,'Atrium 负责人','claude',0,0)",
  ).run();
  const root = createTask(db, { title: "目标" });
  const plain = createTask(db, { title: "没备注", parent: root.ref });
  const noted = createTask(db, { title: "有备注", parent: root.ref });
  addTaskNote(db, noted.ref, { text: "旧的", by: "u1" }, 10);
  addTaskNote(db, noted.ref, { text: "新的", by: "secretary" }, 20);
  const leader = createTask(db, { title: "leader 写的", parent: root.ref });
  addTaskNote(db, leader.ref, { text: "我在看", by: "a1" }, 30, "a1");
  const handled = createTask(db, { title: "受阻有人管", parent: root.ref });
  updateTask(db, handled.ref, { status: "blocked" }, 40);
  addTaskNote(db, handled.ref, { text: "处理中", by: "u1" }, 50);
  const stale = createTask(db, { title: "受阻备注在前", parent: root.ref });
  addTaskNote(db, stale.ref, { text: "早先的", by: "u1" }, 60);
  updateTask(db, stale.ref, { status: "blocked" }, 70);
  const broken = createTask(db, { title: "坏备注", parent: root.ref });
  addTaskNote(db, broken.ref, { text: "好的", by: "u1" }, 80);
  addEvent(db, broken.id, 90, "note", "不是对象");

  const tasks = db.prepare("SELECT id, status FROM tasks").all() as {
    id: number;
    status: "todo" | "blocked";
  }[];
  const batch = noteViews(db, tasks);
  for (const task of tasks)
    assert.deepEqual(batch.get(task.id), noteView(db, task.id, task.status));
  const byRef = new Map(
    taskTree(db, root.ref).tasks[0]!.children.map((node) => [node.ref, node]),
  );
  assert.equal(byRef.get(plain.ref)!.note, null);
  assert.equal(byRef.get(noted.ref)!.note, "新的");
  assert.equal(byRef.get(noted.ref)!.note_at, 20);
  assert.equal(byRef.get(leader.ref)!.note_by_name, "Atrium 负责人");
  assert.equal(byRef.get(handled.ref)!.processing, true);
  assert.equal(byRef.get(stale.ref)!.processing, false);
  assert.equal(byRef.get(broken.ref)!.note, null);
});

test("task tree 语句数不随任务数增长，查询计划不扫 tasks 与事件全表", () => {
  const statements = (tops: number) => {
    const db = memory();
    for (let i = 0; i < tops; i++) {
      const top = createTask(db, { title: `顶层${i}` });
      const child = createTask(db, { title: `子${i}`, parent: top.ref });
      addTaskNote(db, child.ref, { text: `备注${i}`, by: "u1" });
      if (i % 3 === 0) updateTask(db, top.ref, { status: "done" });
    }
    const { sqls, prepare } = spy(db);
    const trees = [
      taskTree(db),
      taskTree(db, undefined, { all: "1", limit: "50" }),
      taskTree(db, "t1"),
    ];
    assert.ok(trees[1]!.tasks.every((node) => node.children[0]!.note));
    const plans = sqls.map((sql) =>
      (prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
        (row) => row.detail,
      ),
    );
    return { count: sqls.length, plans };
  };
  // 两边都有下一页、已结束的都超过最近几个：只差任务数。
  const small = statements(60);
  const large = statements(300);
  assert.equal(large.count, small.count);
  for (const plan of large.plans)
    for (const step of plan)
      assert.doesNotMatch(
        step,
        /^SCAN (tasks|t|task_events)\b/,
        `不应扫全表：\n${plan.join("\n")}`,
      );
});

test("HTTP：/api/tasks/tree 接受翻页参数，校验报中文 400", async (t) => {
  const data = tempDir(t, "atrium-tree-");
  const { app } = await createApp({ data, auth: false });
  const headers = { host: "127.0.0.1" };
  try {
    for (const title of ["一", "二", "三"])
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers,
        payload: { title },
      });
    const page = await app.inject({
      url: "/api/tasks/tree?limit=2",
      headers,
    });
    assert.equal(page.statusCode, 200);
    assert.deepEqual(
      page.json().tasks.map((node: { ref: string }) => node.ref),
      ["t1", "t2"],
    );
    assert.equal(page.json().next_after, "t2");
    assert.equal(page.json().remaining, 1);
    const all = await app.inject({
      url: "/api/tasks/tree?all=1&after=t2",
      headers,
    });
    assert.deepEqual(
      all.json().tasks.map((node: { ref: string }) => node.ref),
      ["t3"],
    );
    const bad = await app.inject({
      url: "/api/tasks/tree?limit=0",
      headers,
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /limit: 应为 1～200 的整数/);
  } finally {
    await app.close();
  }
});
