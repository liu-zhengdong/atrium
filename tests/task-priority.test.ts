import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parsePriority,
  PRIORITIES,
  priorityCountsText,
  priorityTag,
  rank,
  tagTitle,
  titleTag,
} from "../server/tasks/priority.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  updateTask,
} from "../server/tasks/ledger.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { enqueue, pending } from "../server/tasks/queue.ts";
import { EventInbox } from "../server/tasks/events.ts";
import { Scheduler, taskPlan } from "../server/tasks/schedule.ts";
import { topRows } from "../server/tasks/top.ts";
import { HostLoad, type HostLimits } from "../server/tasks/host-load.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { titleOf } from "../cli/top.ts";
import { Problem } from "../server/problem.ts";
import { startApp, until } from "./task-fixture.ts";

/**
 * 优先级只留一列：紧急 / 修复 / 普通 / 闲时；想跑的任务进同一个队列，唯一的 drain 按优先级、入队先后取。
 * 缺省普通。树：o1 组织 → o2 Atrium → o3 派活、o4 性能 → o5 启动速度。
 */

const orgDb = () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureOrgTables(db);
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "runtime", "module", "派活"],
    ["o2", "perf", "module", "性能"],
    ["o4", "startup", "module", "启动速度"],
  ] as const)
    addNode(db, { parent, slug, kind, name, reason: "测试" }, "u1");
  return db;
};

test("档位写法：紧急 / 修复 / 普通 / 闲时与英文都认，其余拒绝并说参数名", () => {
  for (const [text, want] of [
    ["紧急", "urgent"],
    ["修复", "fix"],
    ["闲时", "idle"],
    ["普通", "normal"],
    ["idle", "idle"],
    [" URGENT ", "urgent"],
    ["fix", "fix"],
  ] as const)
    assert.equal(parsePriority(text), want, text);
  for (const bad of ["很急", "", "low", 1, null, undefined, true])
    assert.throws(
      () => parsePriority(bad),
      (error) =>
        error instanceof Problem &&
        /priority: 只能是 紧急、修复、普通 或 闲时/.test(error.message),
      String(bad),
    );
});

test("先后档位与标记：紧急 0、修复 1、普通 2、闲时 3；普通不标；头部计数只写不为 0 的", () => {
  assert.deepEqual(PRIORITIES.map(rank), [0, 1, 2, 3]);
  assert.deepEqual(PRIORITIES.map(priorityTag), ["紧急", "修复", "", "闲时"]);
  assert.equal(priorityTag(undefined), "");
  assert.equal(
    priorityCountsText({ urgent: 1, fix: 0, normal: 3, idle: 2 }),
    "紧急 1 · 普通 3 · 闲时 2",
  );
  assert.equal(
    priorityCountsText({ urgent: 0, fix: 0, normal: 0, idle: 0 }),
    "",
  );
  assert.equal(priorityCountsText(undefined), "");
});

test("标题标记：标题已以同一标记开头的不重复（巡检 f6）", () => {
  const cases: [tag: string, title: string, want: string][] = [
    ["紧急", "修合入队列", "紧急 修合入队列"],
    ["紧急", "紧急：修合入队列", "紧急：修合入队列"],
    ["紧急", "紧急 修合入队列", "紧急 修合入队列"],
    ["紧急", "  紧急：前面有空格", "  紧急：前面有空格"],
    ["紧急", "不紧急的事", "紧急 不紧急的事"],
    ["闲时", "闲时：整理日志", "闲时：整理日志"],
    ["闲时", "紧急：标题写紧急但只是闲时", "闲时 紧急：标题写紧急但只是闲时"],
    ["", "紧急：没标紧急", "紧急：没标紧急"],
    ["", "普通任务", "普通任务"],
  ];
  for (const [tag, title, want] of cases)
    assert.equal(tagTitle(tag, title), want, `${tag}/${title}`);
  assert.equal(titleTag("紧急", "紧急：x"), "");
  assert.equal(titleTag("紧急", "x"), "紧急");
  assert.equal(
    titleOf({ title: "紧急：修 x", priority: "urgent" } as never),
    "紧急：修 x",
  );
  assert.equal(
    titleOf({ title: "修 x", priority: "urgent" } as never),
    "紧急 修 x",
  );
  assert.equal(
    titleOf({ title: "修 x", priority: "fix" } as never),
    "修复 修 x",
  );
});

test("建任务：缺省普通；--priority 覆盖；set 可改，换部分不动档位", () => {
  const db = orgDb();
  const perf = createTask(db, { title: "性能巡检", part: "o4" });
  assert.equal(perf.priority, "normal");
  assert.equal(createTask(db, { title: "没归属" }).priority, "normal");
  assert.equal(
    createTask(db, { title: "功能慢慢来", part: "o3", priority: "闲时" })
      .priority,
    "idle",
  );
  const urgent = createTask(db, {
    title: "急事",
    part: "o4",
    priority: "紧急",
  });
  // 建任务事件记下非普通的档位，全景「谁派的」同一处能看到。
  const created = getTask(db, urgent.ref).events.find(
    (e) => e.kind === "created",
  );
  assert.equal(JSON.parse(created!.detail!).priority, "urgent");
  // 改档位；写错的拒绝并说参数名。
  assert.equal(updateTask(db, perf.ref, { priority: "闲时" }).priority, "idle");
  assert.throws(
    () => updateTask(db, perf.ref, { priority: "很急" }),
    /priority: 只能是 紧急、修复、普通 或 闲时/,
  );
  // 旧写法（urgent、type、size、stopgap、also）一律不认。
  for (const retired of ["urgent", "type", "size", "stopgap", "why", "also"])
    assert.throws(
      () => createTask(db, { title: "旧写法", [retired]: "x" }),
      /不认识|unknown|字段/,
      retired,
    );
  // 换部分不动档位。
  assert.equal(updateTask(db, perf.ref, { part: "o3" }).priority, "idle");
});

test("旧库补列：prio 按旧的 urgent、task_type、priority 折算一次，之后只认 prio；旧列留着不读不写，旧运行时表不动", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL,
      urgent INTEGER NOT NULL DEFAULT 0 CHECK(urgent IN (0,1)),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','idle')),
      task_type TEXT NOT NULL DEFAULT 'feature' CHECK(task_type IN ('feature','fix')),
      size TEXT, stopgap TEXT, urgent_why TEXT);`);
  const insert = db.prepare(
    "INSERT INTO tasks(title,status,urgent,priority,task_type,created_at,updated_at) VALUES (?,?,?,?,?,0,0)",
  );
  insert.run("紧急闲时", "todo", 1, "idle", "feature");
  insert.run("修复", "blocked", 0, "normal", "fix");
  insert.run("闲时", "done", 0, "idle", "feature");
  insert.run("普通", "running", 0, "normal", "feature");
  ensureTaskTables(db);
  ensureTaskTables(db);
  assert.deepEqual(
    db
      .prepare("SELECT title,prio FROM tasks ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { title: "紧急闲时", prio: "urgent" },
      { title: "修复", prio: "fix" },
      { title: "闲时", prio: "idle" },
      { title: "普通", prio: "normal" },
    ],
  );
  // 读出的视图只有 priority，旧列的值不外露；建新任务照常（旧列按缺省）。
  const shown = getTask(db, "t1") as unknown as Record<string, unknown>;
  assert.equal(shown.priority, "urgent");
  for (const retired of [
    "urgent",
    "task_type",
    "size",
    "stopgap",
    "urgent_why",
    "prio",
  ])
    assert.equal(retired in shown, false, retired);
  assert.equal(
    createTask(db, { title: "新", priority: "修复" }).priority,
    "fix",
  );
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM agents").get() },
    { id: "x", name: "旧身份" },
  );
  // 新库不再建旧列。
  const fresh = new DatabaseSync(":memory:");
  ensureTaskTables(fresh);
  const columns = (
    fresh.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  ).map((column) => column.name);
  assert.ok(columns.includes("prio"));
  for (const retired of ["urgent", "priority", "task_type", "size", "stopgap"])
    assert.equal(columns.includes(retired), false, retired);
});

test("队列与看板：一个队列按优先级、入队先后排；排期就绪组同样排；看板与状态栏标档位", () => {
  const db = orgDb();
  const idle = createTask(db, {
    title: "性能巡检",
    part: "o4",
    priority: "闲时",
  });
  const normal = createTask(db, { title: "功能 A", part: "o3" });
  const fix = createTask(db, { title: "修 bug", part: "o3", priority: "修复" });
  const urgent = createTask(db, {
    title: "性能急事",
    part: "o4",
    priority: "紧急",
  });
  const later = createTask(db, { title: "功能 B", part: "o3" });
  const put = (id: number, at: number) =>
    enqueue(db, {
      task_id: id,
      tool: "kimi",
      worker: "kimi",
      risk: "low",
      queued_at: at,
    });
  put(idle.id, 1);
  put(normal.id, 5);
  put(fix.id, 6);
  put(urgent.id, 9);
  put(later.id, 2);
  assert.deepEqual(
    pending(db).map((entry) => [entry.task_id, entry.priority]),
    [
      [urgent.id, "urgent"],
      [fix.id, "fix"],
      [later.id, "normal"],
      [normal.id, "normal"],
      [idle.id, "idle"],
    ],
  );
  const reasons = new Map(
    listTasks(db, {}).tasks.map((task) => [task.ref, task.queued_reason]),
  );
  assert.equal(reasons.get(idle.ref), "等待执行者可用后自动拉起");
  assert.deepEqual(
    taskPlan(db).groups.ready.map((item) => item.task.ref),
    [urgent.ref, fix.ref, normal.ref, later.ref, idle.ref],
  );
  const rows = topRows(db, Date.now()).rows;
  const row = rows.find((item) => item.ref === idle.ref)!;
  assert.equal(row.priority, "idle");
  assert.equal(titleOf({ ...row, action: null, log_at: 0 }), "闲时 性能巡检");
  const line = renderStatusline({
    snapshot: {
      rows: rows.map((item) => ({ ...item, action: null, log_at: 0 })),
      counts: { events: 0 },
      host: null,
      leaders: [],
      subscriber: "secretary",
      priorities: { urgent: 1, fix: 1, normal: 2, idle: 1 },
    } as never,
    plan: null,
    now: Date.now(),
    color: false,
  });
  assert.match(line, /紧急 1 · 修复 1 · 普通 2 · 闲时 1/);
  assert.match(line, /闲时 「性能巡检」 排队/);
  assert.match(line, /修复 「修 bug」 排队/);
});

test("巡检自动派发只负责入队：照短号逐件交给 run，先后由 drain 按优先级定", async () => {
  const db = orgDb();
  const inbox = new EventInbox(db);
  createTask(db, { title: "性能巡检", part: "o4", auto: true });
  createTask(db, { title: "功能 A", part: "o3", auto: true });
  createTask(db, {
    title: "性能急事",
    part: "o4",
    auto: true,
    priority: "紧急",
  });
  createTask(db, { title: "功能 B", part: "o3", auto: true });
  const order: string[] = [];
  const scheduler = new Scheduler(
    db,
    inbox,
    async (ref) => {
      order.push(ref);
    },
    async () => ({ ok: true, stdout: "{}", stderr: "" }),
  );
  await scheduler.tick();
  assert.deepEqual(order, ["t1", "t2", "t3", "t4"]);
  for (const ref of order) assert.equal(getTask(db, ref).auto_dispatched, 1);
});

const limits = (over: Partial<HostLimits>): HostLimits => ({
  cores: 8,
  maxWorkers: null,
  testConcurrency: 2,
  checkTimeoutMs: 30 * 60_000,
  busyCores: null,
  busyLoad: null,
  ...over,
});

/** 假 kimi 等到 $HOME/go 出现才收工，期间一直有输出，看门狗不判卡死。 */
const waitingKimi = (fx: { script: (name: string, body: string) => void }) =>
  fx.script(
    "kimi",
    'set -e\nwhile [ ! -f "$HOME/go" ]; do echo waiting; sleep 0.1; done\necho hi > done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"',
  );

test("运行时：想跑的任务都进同一个队列，执行者满时按优先级、入队先后拉起；改档位立刻重排", async (t) => {
  const host = new HostLoad(limits({ maxWorkers: 1 }), () => 0);
  const { fx, data, call } = await startApp(
    t,
    waitingKimi,
    undefined,
    undefined,
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "runtime", "module", "派活"],
    ["o2", "perf", "module", "性能"],
  ] as const)
    addNode(db, { parent, slug, kind, name, reason: "测试" }, "u1");
  const add = async (title: string, part: string, extra = {}) =>
    (await call("POST", "/api/tasks", { title, repo: fx.repo, part, ...extra }))
      .body;
  assert.equal((await add("占位", "o3")).priority, "normal");
  assert.equal(
    (await add("性能巡检", "o4", { priority: "闲时" })).priority,
    "idle",
  );
  await add("功能 B", "o3");
  assert.equal(
    (await add("修 bug", "o3", { priority: "修复" })).priority,
    "fix",
  );
  await add("功能 C", "o3");
  const bad = await call("POST", "/api/tasks", { title: "坏", priority: "低" });
  assert.equal(bad.status, 400);
  assert.match(
    bad.body.message ?? bad.body.error,
    /priority: 只能是 紧急、修复、普通 或 闲时/,
  );
  const run = (ref: string) =>
    call("POST", `/api/tasks/${ref}/run`, { worker: "kimi" });
  assert.equal((await run("t1")).body.task.status, "running");
  for (const ref of ["t2", "t3", "t4", "t5"]) {
    const queued = await run(ref);
    assert.equal(queued.body.queued, true, ref);
    assert.match(queued.body.task.queued_reason, /本机同时最多跑 1 个执行者/);
  }
  const top = (await call("GET", "/api/tasks/top")).body;
  const row = (ref: string) =>
    top.rows.find((item: { ref: string }) => item.ref === ref);
  assert.equal(row("t2").priority, "idle");
  assert.equal(row("t4").priority, "fix");
  // t5 改成紧急：立刻按紧急重排，紧急的跳过本机上限马上拉起。
  const set = await call("PATCH", "/api/tasks/t5", { priority: "紧急" });
  assert.equal(set.body.priority, "urgent");
  await until(() => getTask(db, "t5").status === "running");
  // 放行：t1 收工后按修复 t4、普通 t3、闲时 t2 的先后拉起。
  writeFileSync(join(fx.root, "home", "go"), "");
  for (const ref of ["t1", "t2", "t3", "t4", "t5"])
    await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
  await until(() => getTask(db, "t2").status !== "todo", 20_000);
  const started = (ref: string) =>
    getTask(db, ref).events.find((event) => event.kind === "start")!.id;
  assert.ok(started("t4") < started("t3"), "修复的 t4 先于普通的 t3");
  assert.ok(started("t3") < started("t2"), "普通的 t3 先于闲时的 t2");
});
