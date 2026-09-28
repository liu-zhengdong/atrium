import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  getTask,
  noteTask,
  taskTree,
  updateTask,
} from "../server/tasks/ledger.ts";
import { enqueue, queued } from "../server/tasks/queue.ts";
import {
  isTotal,
  openDescendants,
  rollupFor,
  syncTotals,
} from "../server/tasks/rollup-ledger.ts";
import { EventInbox } from "../server/tasks/events.ts";
import { publishTask } from "../server/tasks/notice.ts";
import { Scheduler, taskPlan } from "../server/tasks/schedule.ts";
import { TaskRunner } from "../server/tasks/runner.ts";
import { topRows } from "../server/tasks/top.ts";
import { mapTotals } from "../server/map/view.ts";
import { renderTree } from "../cli/tasks.ts";
import { renderStatusline, type StatuslineInput } from "../cli/statusline.ts";
import { renderTop, type Snapshot, type TopRow } from "../cli/top.ts";
import { renderPlan, type PlanView } from "../cli/top-plan.ts";
import { planCounts } from "../server/tasks/plan-count.ts";
import type { Holder } from "../server/tasks/holder.ts";
import { createApp } from "../server/app.ts";
import { removeTemp } from "./temp-dir.ts";

/** 汇总型总任务（t190）：账本跟随、派发拦截、通知分投、取消连带与各处展示。 */

function memory() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  return db;
}

const inboxOf = (db: DatabaseSync, subscriber: string) =>
  (
    db
      .prepare(
        "SELECT task_id,kind,detail FROM task_inbox WHERE subscriber=? ORDER BY id",
      )
      .all(subscriber) as { task_id: number; kind: string; detail: string }[]
  ).map((row) => ({
    task: `t${row.task_id}`,
    kind: row.kind,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));

test("带旧表的库启动：补 helper 列并回填帮手子任务，旧运行时的表不动", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO tasks(parent_id,title,status,created_at,updated_at) VALUES
      (NULL,'请了专员的任务','running',0,0),
      (1,'专员审查：安全 · t1 请了专员的任务','running',0,0),
      (NULL,'大功能','todo',0,0),
      (3,'拆出来的子任务','todo',0,0),
      (NULL,'会审：要不要改','todo',0,0),
      (5,'会审意见：安全 · 要不要改','done',0,0);`);
  ensureTaskTables(db);
  ensureTaskTables(db); // 幂等
  assert.deepEqual(
    db
      .prepare("SELECT id,helper FROM tasks ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 1, helper: 0 },
      { id: 2, helper: 1 },
      { id: 3, helper: 0 },
      { id: 4, helper: 0 },
      { id: 5, helper: 0 },
      { id: 6, helper: 1 },
    ],
  );
  assert.equal(isTotal(db, 1), false);
  assert.equal(isTotal(db, 3), true);
  assert.equal(isTotal(db, 5), false);
  // 迁移：已有带子任务的父任务按新规则显示。
  assert.equal(getTask(db, "t3").rollup?.status, "todo");
  assert.equal(getTask(db, "t1").rollup, null);
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM agents").get() },
    { id: "x", name: "旧身份" },
  );
});

test("账本跟随：有了子任务撤出排队、已结束的改回待办、在跑的不动；叶子全完成改 done，全取消改 cancelled", () => {
  const db = memory();
  const queuedParent = createTask(db, { title: "排着队的" }); // t1
  enqueue(db, {
    task_id: queuedParent.id,
    tool: "codex",
    worker: "codex",
    risk: "low",
    queued_at: 1,
  });
  createTask(db, { title: "子", parent: "t1" }); // t2
  assert.equal(queued(db, 1), undefined);
  assert.ok(getTask(db, "t1").events.some((e) => e.kind === "dequeued"));

  const doneParent = createTask(db, { title: "自己交过 PR 的" }); // t3
  updateTask(db, doneParent.ref, {
    pr_url: "https://github.com/o/r/pull/1",
    status: "done",
  });
  createTask(db, { title: "后来补的子任务", parent: "t3" }); // t4
  const reopened = getTask(db, "t3");
  assert.equal(reopened.status, "todo");
  // 父任务自身的 PR 保留作历史。
  assert.equal(reopened.pr_url, "https://github.com/o/r/pull/1");

  const running = createTask(db, { title: "正在拆的" }); // t5
  advanceTask(db, running.ref, { kind: "start" });
  createTask(db, { title: "拆出的", parent: "t5" }); // t6
  assert.equal(getTask(db, "t5").status, "running");

  // 多层：t7 → t8 → t9、t10；t7 → t11。
  createTask(db, { title: "大功能" }); // t7
  createTask(db, { title: "中间层", parent: "t7" }); // t8
  createTask(db, { title: "叶子甲", parent: "t8" }); // t9
  createTask(db, { title: "叶子乙", parent: "t8" }); // t10
  createTask(db, { title: "叶子丙", parent: "t7" }); // t11
  updateTask(db, "t9", { status: "done" });
  updateTask(db, "t10", { status: "done" });
  assert.equal(getTask(db, "t8").status, "done");
  assert.equal(getTask(db, "t7").status, "todo");
  assert.equal(rollupFor(db, 7)?.finished, 2);
  updateTask(db, "t11", { status: "cancelled" });
  // 完成加取消：整体算已上线（取消的不计进度分母）。
  assert.equal(getTask(db, "t7").status, "done");
  assert.equal(getTask(db, "t7").rollup?.status, "online");
  assert.equal(
    renderTree(taskTree(db, "t7").tasks)[0],
    "t7 [已上线 2/2] 大功能 · 总任务",
  );
  const rollupEvent = getTask(db, "t7").events.findLast(
    (e) => e.kind === "rollup",
  );
  assert.deepEqual(JSON.parse(rollupEvent!.detail!), {
    from: "todo",
    to: "done",
    progress: "2/2",
  });
  // 又加了子任务：改回待办。
  createTask(db, { title: "追加", parent: "t8" }); // t12
  assert.equal(getTask(db, "t7").status, "todo");
  assert.equal(getTask(db, "t8").status, "todo");

  // 全部取消 → cancelled。
  createTask(db, { title: "放弃的" }); // t13
  createTask(db, { title: "a", parent: "t13" }); // t14
  updateTask(db, "t14", { status: "cancelled" });
  assert.equal(getTask(db, "t13").status, "cancelled");

  // 交付后在合入、等上线的算在做。
  createTask(db, { title: "合入中的" }); // t15
  createTask(db, { title: "b", parent: "t15" }); // t16
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merged',online_wait=1 WHERE id=16",
  ).run();
  syncTotals(db, 16);
  assert.equal(rollupFor(db, 15)?.status, "running");
  assert.equal(getTask(db, "t15").status, "todo");
});

test("帮手子任务（专员审查、会审意见）不让父任务变成总任务", () => {
  const db = memory();
  createTask(db, { title: "父" });
  createTask(
    db,
    { title: "专员审查：安全 · t1 父", parent: "t1", deliver: "none" },
    undefined,
    undefined,
    { helper: true },
  );
  assert.equal(isTotal(db, 1), false);
  assert.equal(getTask(db, "t1").rollup, null);
  assert.equal(getTask(db, "t1").children, 1);
  advanceTask(db, "t2", { kind: "start" });
  assert.equal(getTask(db, "t1").status, "todo");
});

test("通知：秘书只收总任务级的——叶子完成不投，卡住转成「tN 下的 tM 卡住」，全部上线发一次「整体已上线」", () => {
  const db = memory();
  const inbox = new EventInbox(db);
  createTask(db, { title: "离开电脑也能拍板" }); // t1
  createTask(db, { title: "手机上看选项单", parent: "t1" }); // t2
  createTask(db, { title: "推送提醒", parent: "t1" }); // t3
  updateTask(db, "t2", { status: "done" });
  noteTask(db, "t2", "online", {});
  publishTask(inbox, db, 2, "done", {});
  assert.deepEqual(inboxOf(db, "secretary"), []);

  advanceTask(db, "t3", { kind: "start" });
  advanceTask(db, "t3", { kind: "exit_fail" });
  publishTask(inbox, db, 3, "failed", { reason: "退出码 1" });
  const stuck = inboxOf(db, "secretary");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]!.kind, "total_stuck");
  assert.equal(stuck[0]!.task, "t3");
  assert.equal(stuck[0]!.detail.message, "t1 下的 t3 卡住要你：退出码 1");
  assert.equal(stuck[0]!.detail.total, "t1");
  assert.equal(stuck[0]!.detail.progress, "1/2");

  updateTask(db, "t3", { status: "done" });
  publishTask(inbox, db, 3, "done", {});
  publishTask(inbox, db, 3, "done", {}); // 同一进度不重复报
  const online = inboxOf(db, "secretary").filter(
    (e) => e.kind === "total_online",
  );
  assert.equal(online.length, 1);
  assert.equal(online[0]!.task, "t1");
  assert.equal(online[0]!.detail.message, "t1 整体已上线（2/2）");
  assert.equal(getTask(db, "t1").status, "done");
});

test("通知：叶子归 leader 管时照旧投 leader，上线不再抄秘书；单个任务上线也不抄秘书（t182）", () => {
  const db = memory();
  const inbox = new EventInbox(db);
  createTask(db, { title: "总" }); // t1
  createTask(db, { title: "叶", parent: "t1", owner: "a1" }); // t2
  createTask(db, { title: "单独的", owner: "a1" }); // t3
  updateTask(db, "t2", { status: "done" });
  publishTask(inbox, db, 2, "online", { message: "t2 已上线" });
  publishTask(inbox, db, 3, "online", { message: "t3 已上线" });
  assert.deepEqual(
    inboxOf(db, "a1").map((e) => `${e.task}:${e.kind}`),
    ["t2:online", "t3:online"],
  );
  assert.deepEqual(
    inboxOf(db, "secretary").map((e) => `${e.task}:${e.kind}`),
    ["t1:total_online"],
  );
  // 叶子卡住：leader 收，秘书不收（有 leader 管）。
  createTask(db, { title: "又一个叶", parent: "t1", owner: "a1" }); // t4
  advanceTask(db, "t4", { kind: "block" }, {}, { reason: "等决定" });
  publishTask(inbox, db, 4, "blocked", { reason: "等决定" });
  assert.ok(inboxOf(db, "a1").some((e) => e.task === "t4"));
  assert.ok(!inboxOf(db, "secretary").some((e) => e.task === "t4"));
});

test("派发拦截：task run、task run --dry-run 给人话提示；自动派发跳过总任务；排期不列总任务", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-total-run-"));
  t.after(() => removeTemp(root));
  const db = memory();
  createTask(db, { title: "总", auto: true }); // t1
  createTask(db, { title: "叶甲", parent: "t1" }); // t2
  createTask(db, { title: "叶乙", parent: "t1", after: "t2" }); // t3
  createTask(db, { title: "单独的" }); // t4
  const runner = new TaskRunner(db, {
    data: root,
    workersDir: join(root, "workers"),
    env: { PATH: "/usr/bin:/bin" },
    exec: async () => {
      throw new Error("测试不联网");
    },
  });
  t.after(() => runner.close());
  for (const call of [
    () => runner.run("t1", {}),
    () => runner.pick("t1", undefined),
  ])
    await assert.rejects(call(), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /^t1 是总任务，派它下面的子任务/);
      return true;
    });
  const dispatched: string[] = [];
  const scheduler = new Scheduler(
    db,
    new EventInbox(db),
    async (ref) => {
      dispatched.push(ref);
    },
    async () => ({ ok: true, stdout: "{}", stderr: "" }),
  );
  await scheduler.tick();
  assert.deepEqual(dispatched, []);
  assert.equal(getTask(db, "t1").status, "todo");
  assert.ok(!getTask(db, "t1").events.some((e) => e.kind === "block"));
  const plan = taskPlan(db);
  const refs = Object.values(plan.groups)
    .flat()
    .map((item) => item.task.ref);
  assert.ok(!refs.includes("t1"));
  assert.deepEqual(plan.totals, [
    { ref: "t1", title: "总", parent_ref: null, part_ref: null },
  ]);
  assert.deepEqual(plan.counts, {
    ready: 2,
    waiting: 1,
    schedule_blocked: 0,
  });
  // task wait 对总任务：子孙没结束就不算结束。
  const waited = await runner.wait("t1", 0);
  assert.equal(waited.timed_out, true);
});

const holder = (kind: Holder["kind"], text: string) =>
  ({ kind, who: null, text }) as Holder;

test("就绪与等待中：task plan、top 排期段、状态栏同一个计数（巡检 f4）", () => {
  const db = memory();
  createTask(db, { title: "总甲" }); // t1
  createTask(db, { title: "a", parent: "t1" }); // t2 就绪
  createTask(db, { title: "b", parent: "t1", after: "t2" }); // t3 等待
  createTask(db, { title: "总乙" }); // t4
  createTask(db, { title: "c", parent: "t4" }); // t5 就绪
  advanceTask(db, "t5", { kind: "start" }); // 在跑，不算就绪
  createTask(db, { title: "单独的" }); // t6 就绪
  const plan = taskPlan(db) as unknown as PlanView & {
    counts: ReturnType<typeof planCounts>;
  };
  const shared = planCounts(plan.groups);
  assert.deepEqual(shared, { ready: 2, waiting: 1, schedule_blocked: 0 });
  assert.deepEqual(plan.counts, shared);
  const top = renderPlan(plan, {
    width: 100,
    now: 0,
    maxLines: 40,
    wide: true,
  });
  assert.deepEqual(top.counts, {
    ready: shared.ready,
    waiting: shared.waiting,
    blocked: shared.schedule_blocked,
  });
  assert.match(top.lines[0]!, /^排期 · 就绪 2 · 等待中 1 · 卡住 0/);
  // 总任务只当分组标题，不带就绪符号。
  assert.ok(top.lines.some((line) => /▸ t1 总甲/.test(line)));
  assert.ok(!top.lines.some((line) => /○ t1\b/.test(line)));
  const line = renderStatusline({
    snapshot: {
      now: 0,
      recent_ms: 0,
      subscriber: "secretary",
      counts: {
        running: 0,
        queued: 0,
        blocked: 0,
        processing: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        events: 0,
      },
      rows: [],
      truncated: false,
    },
    plan,
    now: 0,
    color: false,
  });
  assert.match(line, /接下来：就绪 2 · 等待中 1/);
});

test("top 与状态栏：在做的子任务按最近的总任务并成一组，等你的与没有总任务的照旧单行", () => {
  const db = memory();
  createTask(db, { title: "离开电脑也能拍板" }); // t1
  for (const title of ["手机看单", "推送", "语音拍板"])
    createTask(db, { title, parent: "t1" }); // t2 t3 t4
  createTask(db, { title: "单独的" }); // t5
  advanceTask(db, "t2", { kind: "start" });
  advanceTask(db, "t3", { kind: "start" });
  advanceTask(db, "t5", { kind: "start" });
  updateTask(db, "t4", { status: "done" });
  const rows = topRows(db, Date.now()).rows;
  const byRef = new Map(rows.map((row) => [row.ref, row]));
  assert.deepEqual(byRef.get("t2")?.total, {
    ref: "t1",
    title: "离开电脑也能拍板",
    progress: "1/3",
  });
  assert.equal(byRef.get("t5")?.total, null);

  const base = {
    title: "",
    status: "running",
    worker: "codex+gpt-6-sol",
    started_at: 0,
    ended_at: null,
    queued_at: null,
    reason: null,
    updated_at: 0,
    note: null,
    note_by: null,
    note_at: null,
    processing: false,
    log_at: 0,
    action: null,
  };
  const total = { ref: "t1", title: "离开电脑也能拍板", progress: "1/3" };
  const view: (TopRow & { holder: Holder })[] = [
    {
      ...base,
      ref: "t2",
      title: "手机看单",
      total,
      holder: holder("worker", "codex 在做"),
    },
    {
      ...base,
      ref: "t3",
      title: "推送",
      total,
      holder: holder("worker", "codex 在做"),
    },
    {
      ...base,
      ref: "t6",
      title: "要拍板的",
      total,
      holder: holder("user", "选方案"),
    },
    {
      ...base,
      ref: "t5",
      title: "单独的",
      total: null,
      holder: holder("worker", "codex 在做"),
    },
  ];
  const snapshot: Snapshot = {
    now: 0,
    recent_ms: 0,
    subscriber: "secretary",
    counts: {
      running: 3,
      queued: 0,
      blocked: 0,
      processing: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      events: 0,
    },
    rows: view,
    truncated: false,
  };
  const status = renderStatusline({
    snapshot: snapshot as StatuslineInput["snapshot"],
    plan: null,
    now: 0,
    color: false,
  }).split("\n");
  assert.ok(status.includes("✱ t6 「要拍板的」 等你：选方案"));
  assert.ok(
    status.includes(
      "▸ t1 「离开电脑也能拍板」 1/3 · 在做 t2 手机看单、t3 推送",
    ),
  );
  assert.ok(status.some((l) => /^● t5 「单独的」/.test(l)));
  assert.ok(!status.some((l) => /^● t2/.test(l)));
  const screen = renderTop(snapshot, {
    width: 120,
    now: 0,
    footer: false,
    color: false,
  }).split("\n");
  const heading = screen.findIndex((l) =>
    l.startsWith("▸ t1 离开电脑也能拍板 1/3 · 在做 t2、t3、t6"),
  );
  assert.ok(heading > 0);
  assert.match(screen[heading + 1]!, /t2/);
});

test("全景任务视图：总任务一行带汇总与可展开的直接子任务", () => {
  const db = memory();
  createTask(db, { title: "大功能" }); // t1
  createTask(db, { title: "中间层", parent: "t1" }); // t2
  createTask(db, { title: "叶", parent: "t2" }); // t3
  createTask(db, { title: "叶二", parent: "t1" }); // t4
  advanceTask(db, "t3", { kind: "start" });
  const totals = mapTotals(db, [1, 2, 3, 4]);
  assert.deepEqual([...totals.keys()].sort(), [1, 2]);
  const top = totals.get(1)!;
  assert.equal(top.status, "running");
  assert.equal(top.label, "在做");
  assert.equal(top.progress, "0/2");
  assert.deepEqual(
    top.children.map((c) => [c.ref, c.total]),
    [
      ["t2", true],
      ["t4", false],
    ],
  );
});

test("取消总任务：先问一句，带 with_children 连带取消没结束的子孙，已完成的不动；破坏输入报错", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-total-cancel-"));
  t.after(() => removeTemp(data));
  const { app, db } = await createApp({
    data,
    auth: false,
    tasks: { pace: async () => undefined },
  });
  t.after(() => app.close());
  const call = async (
    method: "PATCH" | "POST",
    url: string,
    payload: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      payload,
    });
    return { status: response.statusCode, body: response.json() };
  };
  await call("POST", "/api/tasks", { title: "大功能" }); // t1
  await call("POST", "/api/tasks", { title: "中间层", parent: "t1" }); // t2
  await call("POST", "/api/tasks", { title: "已完成", parent: "t1" }); // t3
  await call("POST", "/api/tasks", { title: "卡住的", parent: "t1" }); // t4
  await call("POST", "/api/tasks", { title: "孙", parent: "t2" }); // t5
  updateTask(db, "t3", { status: "done" });
  advanceTask(db, "t4", { kind: "block" });
  assert.deepEqual(
    openDescendants(db, 1).map((c) => c.id),
    [2, 4, 5],
  );
  const ask = await call("PATCH", "/api/tasks/t1", { status: "cancelled" });
  assert.equal(ask.status, 409);
  assert.match(
    ask.body.error,
    /^t1 是总任务，下面还有 3 个没结束的子孙：t2、t4、t5；要连带取消加 --with-children/,
  );
  assert.equal(
    ask.body.nextCommand,
    "atrium task set t1 --status cancelled --with-children",
  );
  assert.equal(getTask(db, "t1").status, "todo");
  for (const bad of [
    { status: "cancelled", with_children: "yes" },
    { status: "done", with_children: true },
  ]) {
    const refused = await call("PATCH", "/api/tasks/t1", bad);
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  const done = await call("PATCH", "/api/tasks/t1", {
    status: "cancelled",
    with_children: true,
  });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.cancelled_children, ["t2", "t4", "t5"]);
  assert.equal(done.body.status, "cancelled");
  assert.equal(getTask(db, "t3").status, "done");
  for (const ref of ["t2", "t4", "t5"])
    assert.equal(getTask(db, ref).status, "cancelled", ref);
  // 普通任务照旧直接取消，不问。
  await call("POST", "/api/tasks", { title: "单独的" }); // t6
  assert.equal(
    (await call("PATCH", "/api/tasks/t6", { status: "cancelled" })).status,
    200,
  );
});
