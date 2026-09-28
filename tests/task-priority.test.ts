import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  aspectPart,
  defaultPriority,
  idleAhead,
  idleAheadAll,
  idleWaitText,
  isIdle,
  parsePriority,
  priorityAfterMove,
  priorityTag,
  rank,
  underAspect,
  type Priority,
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
import { enqueue, heads, idleWaits } from "../server/tasks/queue.ts";
import { EventInbox } from "../server/tasks/events.ts";
import { Scheduler, taskPlan } from "../server/tasks/schedule.ts";
import { topRows } from "../server/tasks/top.ts";
import { HostLoad, type HostLimits } from "../server/tasks/host-load.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { titleOf } from "../cli/top.ts";
import { Problem } from "../server/problem.ts";
import { startApp, until } from "./task-fixture.ts";

/**
 * 闲时（t136）：管方面的部分开的任务缺省排在普通任务后面，有空闲执行者才派。
 * 树：o1 组织 → o2 Atrium → o3 派活（管东西）、o4 性能（管方面）→ o5 启动速度（性能下的部分）。
 */

const orgDb = () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureOrgTables(db);
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "runtime", "module", "派活"],
    ["o2", "perf", "aspect", "性能"],
    ["o4", "startup", "module", "启动速度"],
  ] as const)
    addNode(db, { parent, slug, kind, name, reason: "测试" }, "u1");
  return db;
};

test("档位写法：闲时 / 普通与 idle / normal 都认，其余拒绝并说参数名", () => {
  for (const [text, want] of [
    ["闲时", "idle"],
    ["普通", "normal"],
    ["idle", "idle"],
    ["normal", "normal"],
    [" IDLE ", "idle"],
  ] as const)
    assert.equal(parsePriority(text), want, text);
  for (const bad of ["紧急", "", "low", 1, null, undefined, true])
    assert.throws(
      () => parsePriority(bad),
      (error) =>
        error instanceof Problem &&
        /priority: 只能是 闲时 或 普通/.test(error.message),
      String(bad),
    );
});

test("缺省档位与换部分：管方面的缺省闲时；没被人改过的跟着新部分走，改过的保留", () => {
  assert.equal(defaultPriority(true), "idle");
  assert.equal(defaultPriority(false), "normal");
  for (const current of ["normal", "idle"] as Priority[])
    for (const before of [false, true])
      for (const after of [false, true])
        assert.equal(
          priorityAfterMove(current, before, after),
          current === defaultPriority(before)
            ? defaultPriority(after)
            : current,
          `${current}/${before}/${after}`,
        );
});

test("管方面判定：自己或父链上有管方面的算；环与断链不算", () => {
  const nodes = new Map(
    [
      { id: 1, parent_id: null, aspect: 0 },
      { id: 2, parent_id: 1, aspect: 1 },
      { id: 3, parent_id: 2, aspect: 0 },
      { id: 4, parent_id: 1, aspect: 0 },
      { id: 5, parent_id: 6, aspect: 0 },
      { id: 6, parent_id: 5, aspect: 0 },
      { id: 7, parent_id: 99, aspect: 0 },
    ].map((node) => [node.id, node]),
  );
  const want: Record<number, boolean> = {
    1: false,
    2: true,
    3: true,
    4: false,
    5: false,
    6: false,
    7: false,
    42: false,
  };
  for (const [id, expected] of Object.entries(want))
    assert.equal(underAspect(nodes, Number(id)), expected, `o${id}`);
  assert.equal(underAspect(nodes, null), false);
});

test("先后档位与闲时标记：紧急最前、普通、闲时；紧急的闲时任务按紧急算", () => {
  for (const urgent of [false, true])
    for (const idle of [false, true])
      assert.equal(rank({ urgent, idle }), urgent ? 0 : idle ? 2 : 1);
  for (const urgent of [0, 1, false, true])
    for (const priority of ["normal", "idle", null, undefined]) {
      const idle = priority === "idle" && !urgent;
      assert.equal(isIdle({ urgent, priority }), idle);
      assert.equal(
        priorityTag({ urgent, priority }),
        urgent ? "紧急" : idle ? "闲时" : "",
      );
    }
});

test("闲时能不能派：同一工具的普通任务都挡；别的工具的只在等本机空位时挡", () => {
  const ownWait = (tool: string) => tool === "opencode" || tool === "grok";
  // 没有普通任务在排队：可以派。
  assert.equal(idleAhead("codex", [], ownWait), 0);
  // 同一工具：不管它在等什么都挡。
  assert.equal(idleAhead("opencode", [{ tool: "opencode" }], ownWait), 1);
  assert.equal(idleAhead("codex", [{ tool: "codex" }], ownWait), 1);
  // 别的工具：在等自己那个工具（独占正忙、额度用尽）不挡；只在等本机空位的挡。
  assert.equal(idleAhead("codex", [{ tool: "opencode" }], ownWait), 0);
  assert.equal(idleAhead("codex", [{ tool: "claude" }], ownWait), 1);
  assert.equal(
    idleAhead(
      "codex",
      [
        { tool: "claude" },
        { tool: "grok" },
        { tool: "codex" },
        { tool: "kimi" },
      ],
      ownWait,
    ),
    3,
  );
  assert.equal(idleWaitText(3), "等空闲：前面还有 3 件普通任务");
});

test("队列里每件闲时任务前面有几件：线性算法与逐件判定一致（穷举小队列）", () => {
  const tools = ["codex", "claude", "opencode"];
  const ownWaits = [
    () => false,
    (tool: string) => tool === "opencode",
    () => true,
  ];
  // 3 个位置 × 每个位置（工具 × 是否闲时）6 种，全排列穷举。
  const kinds = tools.flatMap((tool) => [
    { tool, idle: false },
    { tool, idle: true },
  ]);
  for (const ownWait of ownWaits)
    for (const a of kinds)
      for (const b of kinds)
        for (const c of kinds) {
          const entries = [a, b, c].map((entry, i) => ({
            ...entry,
            task_id: i + 1,
          }));
          const all = idleAheadAll(entries, ownWait);
          const normals = entries.filter((entry) => !entry.idle);
          for (const entry of entries)
            assert.equal(
              all.get(entry.task_id),
              entry.idle ? idleAhead(entry.tool, normals, ownWait) : undefined,
            );
        }
});

test("建任务：归属管方面的部分（或其下）缺省闲时，其余普通；--priority 覆盖；set 可改，换部分跟着走", () => {
  const db = orgDb();
  assert.equal(aspectPart(db, 4), true);
  assert.equal(aspectPart(db, 5), true);
  assert.equal(aspectPart(db, 3), false);
  assert.equal(aspectPart(db, null), false);
  const perf = createTask(db, { title: "性能巡检", part: "o4" });
  assert.equal(perf.priority, "idle");
  assert.equal(createTask(db, { title: "启动", part: "o5" }).priority, "idle");
  assert.equal(
    createTask(db, { title: "功能", part: "o3" }).priority,
    "normal",
  );
  assert.equal(createTask(db, { title: "没归属" }).priority, "normal");
  // 显式写的优先于缺省。
  const forced = createTask(db, {
    title: "性能急事",
    part: "o4",
    priority: "普通",
  });
  assert.equal(forced.priority, "normal");
  assert.equal(
    createTask(db, { title: "功能慢慢来", part: "o3", priority: "闲时" })
      .priority,
    "idle",
  );
  // 建任务事件记下闲时，全景「谁派的」同一处能看到。
  const created = getTask(db, perf.ref).events.find(
    (e) => e.kind === "created",
  );
  assert.equal(JSON.parse(created!.detail!).priority, "idle");
  // 改档位；写错的拒绝并说参数名。
  assert.equal(
    updateTask(db, perf.ref, { priority: "普通" }).priority,
    "normal",
  );
  assert.equal(updateTask(db, perf.ref, { priority: "idle" }).priority, "idle");
  assert.throws(
    () => updateTask(db, perf.ref, { priority: "紧急" }),
    /priority: 只能是 闲时 或 普通/,
  );
  // 没被人改过的：从性能挪到派活变普通，挪回来变闲时。
  assert.equal(updateTask(db, perf.ref, { part: "o3" }).priority, "normal");
  assert.equal(updateTask(db, perf.ref, { part: "o4" }).priority, "idle");
  // 被人改成普通的：挪到别处保留；挪到派活后与那里的缺省一样，再挪回管方面的部分就跟着变闲时（不另记改没改过）。
  assert.equal(updateTask(db, forced.ref, { part: "o3" }).priority, "normal");
  assert.equal(updateTask(db, forced.ref, { part: "o5" }).priority, "idle");
  // 同时给了部分和档位：以给的档位为准。
  assert.equal(
    updateTask(db, forced.ref, { part: "o3", priority: "闲时" }).priority,
    "idle",
  );
});

test("旧库补列：在途的管方面任务补成闲时，已结束的与别处的不动，旧运行时表不读不写", () => {
  const db = new DatabaseSync(":memory:");
  // 旧运行时留下的表与没有 priority 列的旧账本。
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL, part_id INTEGER);`);
  ensureOrgTables(db);
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "runtime", "module", "派活"],
    ["o2", "perf", "aspect", "性能"],
    ["o4", "startup", "module", "启动速度"],
  ] as const)
    addNode(db, { parent, slug, kind, name, reason: "测试" }, "u1");
  const insert = db.prepare(
    "INSERT INTO tasks(title,status,part_id,created_at,updated_at) VALUES (?,?,?,0,0)",
  );
  insert.run("在途性能", "todo", 4);
  insert.run("在途启动", "blocked", 5);
  insert.run("已完成性能", "done", 4);
  insert.run("功能", "todo", 3);
  insert.run("没归属", "running", null);
  ensureTaskTables(db);
  ensureTaskTables(db);
  assert.deepEqual(
    db
      .prepare("SELECT title,priority FROM tasks ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { title: "在途性能", priority: "idle" },
      { title: "在途启动", priority: "idle" },
      { title: "已完成性能", priority: "normal" },
      { title: "功能", priority: "normal" },
      { title: "没归属", priority: "normal" },
    ],
  );
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM agents").get() },
    { id: "x", name: "旧身份" },
  );
  // 没有组织表的旧账本也能补列（一律普通）。
  const bare = new DatabaseSync(":memory:");
  bare.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO tasks(title,status,created_at,updated_at) VALUES ('旧','todo',0,0);`);
  ensureTaskTables(bare);
  assert.equal(
    (bare.prepare("SELECT priority FROM tasks").get() as { priority: string })
      .priority,
    "normal",
  );
});

test("队列与看板：队首紧急 → 普通 → 闲时；闲时任务写「等空闲：前面还有 N 件普通任务」，排期与状态栏标闲时", () => {
  const db = orgDb();
  const idle = createTask(db, { title: "性能巡检", part: "o4" });
  const normal = createTask(db, { title: "功能 A", part: "o3" });
  const other = createTask(db, { title: "功能 B", part: "o3" });
  const lone = createTask(db, { title: "性能另一件", part: "o4" });
  const ready = createTask(db, { title: "功能就绪", part: "o3" });
  const urgentIdle = createTask(db, {
    title: "性能急事",
    part: "o4",
    urgent: true,
  });
  const put = (id: number, tool: string, at: number) =>
    enqueue(db, {
      task_id: id,
      tool,
      worker: tool,
      risk: "low",
      queued_at: at,
    });
  put(idle.id, "kimi", 1);
  put(normal.id, "kimi", 5);
  put(other.id, "opencode", 6);
  put(lone.id, "codex", 2);
  // kimi 的队首是后入队的普通任务；闲时的 codex 排在所有普通任务后面。
  assert.deepEqual(
    heads(db).map((head) => [head.task_id, head.idle]),
    [
      [normal.id, false],
      [other.id, false],
      [lone.id, true],
    ],
  );
  // kimi 上的闲时：同一工具的 1 件；codex 上的：kimi 那件在等本机空位也算，独占的 opencode 那件在等自己不算。
  assert.deepEqual(
    [...idleWaits(db)].sort((a, b) => a[0] - b[0]),
    [
      [idle.id, 1],
      [lone.id, 1],
    ],
  );
  const reasons = new Map(
    listTasks(db, {}).tasks.map((task) => [task.ref, task.queued_reason]),
  );
  assert.equal(reasons.get(idle.ref), "等空闲：前面还有 1 件普通任务");
  assert.equal(reasons.get(normal.ref), "等待执行者可用后自动拉起");
  assert.equal(getTask(db, lone.ref).queued_reason, idleWaitText(1));
  assert.equal(getTask(db, ready.ref).queued_reason, null);
  // 就绪组：紧急 → 普通 → 闲时，同一档照短号。
  assert.deepEqual(
    taskPlan(db).groups.ready.map((item) => item.task.ref),
    [urgentIdle.ref, normal.ref, other.ref, ready.ref, idle.ref, lone.ref],
  );
  // 看板：闲时标记与在等什么；球在谁手里直接写「等空闲：…」。
  const rows = topRows(db, Date.now()).rows;
  const row = rows.find((item) => item.ref === idle.ref)!;
  assert.equal(row.idle, true);
  assert.equal(row.reason, "等空闲：前面还有 1 件普通任务");
  assert.equal(row.holder?.text, "等空闲：前面还有 1 件普通任务");
  assert.equal(rows.find((item) => item.ref === normal.ref)!.idle, false);
  assert.equal(titleOf({ ...row, action: null, log_at: 0 }), "闲时 性能巡检");
  const line = renderStatusline({
    snapshot: {
      rows: [{ ...row, action: null, log_at: 0 }],
      counts: { events: 0 },
      host: null,
      leaders: [],
      subscriber: "secretary",
    } as never,
    plan: null,
    now: Date.now(),
    color: false,
  });
  assert.match(line, /闲时 「性能巡检」 等空闲：前面还有 1 件普通任务/);
  // 其余排队任务照旧写「排队」（这里直接入队，没有 queued 事件）。
  assert.equal(
    rows.find((item) => item.ref === normal.ref)!.holder?.text,
    "排队",
  );
});

test("巡检自动派发：同一轮里普通任务先派，闲时的最后派", async () => {
  const db = orgDb();
  const inbox = new EventInbox(db);
  createTask(db, { title: "性能巡检", part: "o4", auto: true });
  createTask(db, { title: "功能 A", part: "o3", auto: true });
  createTask(db, { title: "性能急事", part: "o4", auto: true, urgent: true });
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
  // 紧急的闲时任务按紧急算，照短号在普通任务里派。
  assert.deepEqual(order, ["t2", "t3", "t4", "t1"]);
  for (const ref of order) assert.equal(getTask(db, ref).auto_dispatched, 1);
});

const limits = (over: Partial<HostLimits>): HostLimits => ({
  cores: 8,
  maxWorkers: null,
  maxChecks: 2,
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

test("运行时：执行者满时闲时任务让普通任务先拉起；前面有普通任务在等时直接排队；改成普通立刻重排", async (t) => {
  const host = new HostLoad(limits({ maxWorkers: 1 }), () => 0);
  const { fx, data, call } = await startApp(
    t,
    waitingKimi,
    undefined,
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
    ["o2", "perf", "aspect", "性能"],
  ] as const)
    addNode(db, { parent, slug, kind, name, reason: "测试" }, "u1");
  const add = async (title: string, part: string, extra = {}) =>
    (await call("POST", "/api/tasks", { title, repo: fx.repo, part, ...extra }))
      .body;
  assert.equal((await add("占位", "o3")).priority, "normal");
  assert.equal((await add("性能巡检", "o4")).priority, "idle");
  await add("功能 B", "o3");
  await add("性能二", "o4");
  const bad = await call("POST", "/api/tasks", {
    title: "坏",
    priority: "低",
  });
  assert.equal(bad.status, 400);
  assert.match(
    bad.body.message ?? bad.body.error,
    /priority: 只能是 闲时 或 普通/,
  );
  const run = (ref: string) =>
    call("POST", `/api/tasks/${ref}/run`, { worker: "kimi" });
  assert.equal((await run("t1")).body.task.status, "running");
  // 闲时的先入队（执行者满）；普通的后入队。
  const idle = await run("t2");
  assert.equal(idle.body.queued, true);
  assert.match(idle.body.task.queued_reason, /本机同时最多跑 1 个执行者/);
  assert.equal((await run("t3")).body.queued, true);
  // 前面已有普通任务在等同一类执行者：闲时的直接排队，原因写清。
  const second = await run("t4");
  assert.equal(second.body.queued, true);
  assert.equal(second.body.task.queued_reason, "等空闲：前面还有 1 件普通任务");
  // 先入队的闲时任务现在也写在等普通任务。
  assert.equal(
    (await call("GET", "/api/tasks/t2")).body.queued_reason,
    "等空闲：前面还有 1 件普通任务",
  );
  const top = (await call("GET", "/api/tasks/top")).body;
  const row = (ref: string) =>
    top.rows.find((item: { ref: string }) => item.ref === ref);
  assert.equal(row("t2").idle, true);
  assert.equal(row("t3").idle, false);
  // t4 改成普通：立刻按普通重排（仍在排队，只是不再等空闲）。
  const set = await call("PATCH", "/api/tasks/t4", { priority: "普通" });
  assert.equal(set.body.priority, "normal");
  assert.equal(
    (await call("GET", "/api/tasks/t2")).body.queued_reason,
    "等空闲：前面还有 2 件普通任务",
  );
  // 放行：t1 收工后先拉起普通的 t3、t4，闲时的 t2 最后。
  writeFileSync(join(fx.root, "home", "go"), "");
  for (const ref of ["t1", "t2", "t3", "t4"])
    await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
  await until(() => getTask(db, "t2").status !== "todo", 20_000);
  const started = (ref: string) =>
    getTask(db, ref).events.find((event) => event.kind === "start")!.id;
  assert.ok(started("t3") < started("t2"), "普通的 t3 先于闲时的 t2");
  assert.ok(started("t4") < started("t2"), "改成普通的 t4 先于闲时的 t2");
});
