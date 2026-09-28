import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  countTypes,
  fixLikeTitle,
  fixReserve,
  inferType,
  parseReservePercent,
  parseTaskType,
  reserveHolds,
  shownType,
  typeCountsText,
  typeOption,
  typeTag,
  TASK_TYPES,
  type TaskType,
  type TypeSource,
} from "../server/tasks/task-type.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { enqueue, heads, queueHeads } from "../server/tasks/queue.ts";
import { topRows, typeCounts } from "../server/tasks/top.ts";
import {
  chooseHost,
  hostFit,
  type HostCandidate,
  type HostNeed,
} from "../server/hosts/state.ts";
import {
  HostLoad,
  hostLimits,
  type HostLimits,
} from "../server/tasks/host-load.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { taskView } from "../server/map/view.ts";
import { titleOf } from "../cli/top.ts";
import { Problem } from "../server/problem.ts";
import { startApp, until } from "./task-fixture.ts";

/** 任务类型（t237）：功能 / 修复 / 紧急，分组显示与修复保底名额。 */

test("类型写法：功能 / 修复 / 紧急与英文都认；接口的 type 拒绝紧急并说清用 --urgent", () => {
  for (const [text, want] of [
    ["功能", "feature"],
    ["修复", "fix"],
    ["紧急", "urgent"],
    ["feature", "feature"],
    [" FIX ", "fix"],
    ["urgent", "urgent"],
  ] as const)
    assert.equal(typeOption(text), want, text);
  for (const bad of ["", "bug", "闲时", "普通"])
    assert.equal(typeOption(bad), undefined, bad);
  assert.equal(parseTaskType("修复"), "fix");
  assert.equal(parseTaskType("feature"), "feature");
  for (const bad of ["紧急", "urgent"])
    assert.throws(
      () => parseTaskType(bad),
      (error) =>
        error instanceof Problem &&
        /type: 紧急用 --urgent 标/.test(error.message),
    );
  for (const bad of ["", "low", 1, null, undefined, true])
    assert.throws(
      () => parseTaskType(bad),
      (error) =>
        error instanceof Problem &&
        /type: 只能是 功能 或 修复/.test(error.message),
      String(bad),
    );
});

test("标题像修 bug：收得窄，讲机制的功能标题不算", () => {
  for (const title of [
    "修复弹窗重复",
    "远程主机上技能挂载不生效",
    "fix: 窗口隐藏",
    "Fixes top 截断",
    "修 bug：负载统计",
    "紧急 × 负载统计报错",
    "合入队列崩溃",
    "状态栏回归",
    "修掉 Windows 上的弹窗",
    "修好主机暂停 × 排队",
    "修正 CI 计数",
    "修一下 host clean",
    "bug 汇总",
  ])
    assert.equal(fixLikeTitle(title), true, title);
  for (const title of [
    "上线验证没过才叫醒 leader",
    "失败重试机制",
    "修改默认端口",
    "修订章程模板",
    "debug 日志分级",
    "prefix 规则",
    "host clean 远程主机也清残留执行者进程",
    "任务类型与分组显示",
  ])
    assert.equal(fixLikeTitle(title), false, title);
});

test("推断类型：来源 → 标题 → 父任务 → 功能（穷举）", () => {
  const sources: (TypeSource | null)[] = [
    null,
    "choice",
    "patrol",
    "verify",
    "gate",
  ];
  const parents: (TaskType | null)[] = [null, "feature", "fix"];
  for (const source of sources)
    for (const parent of parents)
      for (const title of ["加一个开关", "修复开关"]) {
        const want: TaskType = source
          ? source === "choice"
            ? "feature"
            : "fix"
          : fixLikeTitle(title)
            ? "fix"
            : (parent ?? "feature");
        assert.equal(
          inferType({ title, source, parent }),
          want,
          `${source} ${parent} ${title}`,
        );
      }
});

test("显示类型与计数：紧急压过功能 / 修复；头部写「功能 N · 修复 M · 紧急 K」", () => {
  for (const urgent of [0, 1, true, false])
    for (const task_type of ["feature", "fix", null, "坏值"]) {
      const want = urgent ? "urgent" : task_type === "fix" ? "fix" : "feature";
      assert.equal(shownType({ urgent, task_type }), want);
      assert.equal(
        typeTag({ urgent, task_type }),
        want === "fix" ? "修复" : "",
      );
    }
  const counts = countTypes([
    { urgent: 0, task_type: "feature", n: 3 },
    { urgent: 0, task_type: "fix" },
    { urgent: 1, task_type: "fix", n: 2 },
  ]);
  assert.deepEqual(counts, { feature: 3, fix: 1, urgent: 2 });
  assert.equal(typeCountsText(counts), "功能 3 · 修复 1 · 紧急 2");
  assert.equal(typeCountsText({ feature: 0, fix: 0, urgent: 0 }), "");
  assert.equal(typeCountsText(undefined), "");
});

test("保底名额：上限 × 比例四舍五入，夹在 1–2，至少给功能留 1 个（穷举）", () => {
  for (const max of [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 40])
    for (const percent of [0, 10, 25, 50, 100]) {
      const got = fixReserve(max, percent);
      if (max === null || max < 2 || percent === 0) {
        assert.equal(got, 0, `${max} ${percent}`);
        continue;
      }
      const want = Math.min(
        Math.min(2, Math.max(1, Math.round((max * percent) / 100))),
        max - 1,
      );
      assert.equal(got, want, `${max} ${percent}`);
      assert.ok(got >= 1 && got <= 2 && got <= max - 1);
    }
  assert.equal(fixReserve(8, 25), 2);
  assert.equal(fixReserve(4, 25), 1);
  assert.equal(fixReserve(2, 100), 1);
  for (const [raw, want] of [
    [undefined, undefined],
    ["", undefined],
    ["25", 25],
    ["0", 0],
    ["off", 0],
    ["100", 100],
    ["101", undefined],
    ["-1", undefined],
    ["2.5", undefined],
    ["abc", undefined],
  ] as const)
    assert.equal(parseReservePercent(raw), want, String(raw));
});

test("保底名额挡不挡：只挡功能、只在有修复在等时、只挡还没被修复用上的位置（穷举）", () => {
  for (const max of [null, 2, 4])
    for (let running = 0; running <= (max ?? 3); running++)
      for (let fixRunning = 0; fixRunning <= running; fixRunning++)
        for (const reserve of [0, 1, 2])
          for (const fixWaiting of [false, true])
            for (const type of TASK_TYPES)
              for (const urgent of [false, true]) {
                const got = reserveHolds({
                  max,
                  running,
                  fixRunning,
                  reserve,
                  fixWaiting,
                  type,
                  urgent,
                });
                const open = Math.max(0, reserve - fixRunning);
                const want =
                  !urgent &&
                  type === "feature" &&
                  fixWaiting &&
                  max !== null &&
                  reserve > 0 &&
                  running + 1 > max - open;
                assert.equal(
                  got,
                  want,
                  JSON.stringify({
                    max,
                    running,
                    fixRunning,
                    reserve,
                    fixWaiting,
                    type,
                    urgent,
                  }),
                );
              }
});

const candidate = (over: Partial<HostCandidate>): HostCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  clis: null,
  repos: ["*"],
  running: 0,
  max: 4,
  busy: null,
  ...over,
});
const need = (over: Partial<HostNeed>): HostNeed => ({
  tool: "kimi",
  repo: null,
  urgent: false,
  localOnly: null,
  ...over,
});

test("挑主机：功能被保底名额挡着排队并标 reserve，修复与紧急照派，别的主机有空照派", () => {
  // h1 上限 4、留 1：在跑 3 件功能，有修复在等。
  const h1 = candidate({ running: 3, fixRunning: 0, reserve: 1 });
  const feature = need({ type: "feature", fixWaiting: true });
  const fit = hostFit(h1, feature, false);
  assert.equal(fit.ok, false);
  assert.ok(!fit.ok && fit.kind === "later" && fit.reserve);
  assert.ok(!fit.ok && /h1 给修复留了 1 个位置/.test(fit.reason));
  assert.deepEqual(chooseHost([h1], feature), {
    kind: "queue",
    host: null,
    reason: fit.ok ? "" : fit.reason,
    reserve: true,
  });
  // 指定这台：一样排队并标 reserve。
  const pinned = chooseHost([h1], feature, 1);
  assert.ok(pinned.kind === "queue" && pinned.host === 1 && pinned.reserve);
  // 修复、紧急、没有修复在等、保底已被修复用上：都照派。
  assert.equal(
    hostFit(h1, need({ type: "fix", fixWaiting: true }), false).ok,
    true,
  );
  assert.equal(
    hostFit(
      h1,
      need({ type: "feature", fixWaiting: true, urgent: true }),
      false,
    ).ok,
    true,
  );
  assert.equal(
    hostFit(h1, need({ type: "feature", fixWaiting: false }), false).ok,
    true,
  );
  assert.equal(hostFit({ ...h1, fixRunning: 1 }, feature, false).ok, true);
  // 满了是满了，不是保底挡的：不标 reserve。
  const full = hostFit({ ...h1, running: 4 }, feature, false);
  assert.ok(!full.ok && !full.reserve);
  // 另一台远程主机有空：功能派过去。
  const h2 = candidate({
    id: 2,
    kind: "remote",
    connection: "online",
    clis: { kimi: { installed: true, logged_in: true } },
    running: 0,
    max: 4,
    reserve: 1,
  });
  assert.deepEqual(chooseHost([h1, h2], feature), { kind: "run", host: 2 });
});

test("队首：修复与功能各出一个，功能被保底挡着时后面的修复轮得到", () => {
  const entry = (task_id: number, fix: boolean, at: number) => ({
    task_id,
    tool: "kimi",
    worker: "kimi",
    risk: "low",
    queued_at: at,
    urgent: false,
    idle: false,
    fix,
  });
  const got = queueHeads([
    entry(1, false, 1),
    entry(2, false, 2),
    entry(3, true, 3),
    entry(4, true, 4),
  ]);
  assert.deepEqual(
    got.map((head) => head.task_id),
    [1, 3],
  );
});

test("建任务：不写类型按来源、标题、父任务推断；写了照写；set 可改；接口拒绝紧急", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  assert.equal(createTask(db, { title: "加开关" }).task_type, "feature");
  assert.equal(createTask(db, { title: "修复开关" }).task_type, "fix");
  assert.equal(
    createTask(db, { title: "修复开关", type: "功能" }).task_type,
    "feature",
  );
  assert.equal(
    createTask(db, { title: "加开关", type: "修复" }).task_type,
    "fix",
  );
  assert.equal(
    createTask(db, { title: "选项" }, undefined, undefined, {
      source: "choice",
    }).task_type,
    "feature",
  );
  assert.equal(
    createTask(db, { title: "体验巡检" }, undefined, undefined, {
      source: "patrol",
    }).task_type,
    "fix",
  );
  // 子任务跟父任务（t2 是修复）。
  assert.equal(
    createTask(db, { title: "拆一步", parent: "t2" }).task_type,
    "fix",
  );
  assert.throws(
    () => createTask(db, { title: "x", type: "紧急" }),
    /type: 紧急用 --urgent 标/,
  );
  assert.equal(updateTask(db, "t1", { type: "fix" }).task_type, "fix");
  assert.equal(updateTask(db, "t1", { type: "feature" }).task_type, "feature");
  // 创建事件记下类型。
  const created = getTask(db, "t2").events.find((e) => e.kind === "created");
  assert.equal(JSON.parse(created!.detail!).type, "fix");
});

test("旧库补列：没结束的按标题补成修复，已结束的不动，旧运行时表不读不写", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL);`);
  const insert = db.prepare(
    "INSERT INTO tasks(title,status,created_at,updated_at) VALUES (?,?,0,0)",
  );
  insert.run("修复在途", "todo");
  insert.run("报错受阻", "blocked");
  insert.run("修复已完成", "done");
  insert.run("加功能", "running");
  ensureTaskTables(db);
  ensureTaskTables(db);
  assert.deepEqual(
    db
      .prepare("SELECT title,task_type FROM tasks ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { title: "修复在途", task_type: "fix" },
      { title: "报错受阻", task_type: "fix" },
      { title: "修复已完成", task_type: "feature" },
      { title: "加功能", task_type: "feature" },
    ],
  );
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM agents").get() },
    { id: "x", name: "旧身份" },
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("计数与看板：在途的按类型分开数（帮手与总任务不算），行带类型，top 与状态栏标「修复」", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  createTask(db, { title: "功能甲" }); // t1
  createTask(db, { title: "修复乙" }); // t2
  createTask(db, { title: "紧急丙", urgent: true }); // t3
  createTask(db, { title: "总任务", type: "功能" }); // t4
  createTask(db, { title: "子一", parent: "t4" }); // t5
  createTask(db, { title: "帮手", parent: "t2" }, undefined, undefined, {
    helper: true,
  }); // t6
  createTask(db, { title: "修复已完成" }); // t7
  updateTask(db, "t7", { status: "done" });
  createTask(db, { title: "修复合入中" }); // t8
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merge_queued' WHERE id=8",
  ).run();
  assert.deepEqual(typeCounts(db), { feature: 2, fix: 2, urgent: 1 });
  db.prepare("UPDATE tasks SET status='running' WHERE id IN (1,2)").run();
  const { rows } = topRows(db, Date.now());
  // 命令行的行多了日志时刻与最近动作（服务的 top 另加）。
  const row = (ref: string) => ({
    ...rows.find((r) => r.ref === ref)!,
    log_at: 0,
    action: null,
  });
  assert.equal(row("t1").type, "feature");
  assert.equal(row("t2").type, "fix");
  assert.equal(titleOf(row("t2")), "修复乙");
  db.prepare("UPDATE tasks SET title='弹窗' WHERE id=2").run();
  const again = {
    ...topRows(db, Date.now()).rows.find((r) => r.ref === "t2")!,
    log_at: 0,
    action: null,
  };
  assert.equal(titleOf(again), "修复 弹窗");
  const line = renderStatusline({
    snapshot: {
      now: Date.now(),
      recent_ms: 0,
      subscriber: "secretary",
      counts: {
        running: 2,
        queued: 0,
        blocked: 0,
        processing: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        events: 0,
      },
      types: { feature: 2, fix: 2, urgent: 1 },
      rows: [
        {
          ...again,
          holder: { kind: "worker", who: "kimi", text: "kimi 在做" },
        },
      ],
      truncated: false,
    },
    plan: null,
    now: Date.now(),
    color: false,
  });
  assert.match(line.split("\n")[0]!, /功能 2 · 修复 2 · 紧急 1/);
  assert.match(line, /t2 修复 「弹窗」/);
});

test("读配置：ATRIUM_FIX_RESERVE_PERCENT 缺省 25，测试进程里没设为 0，写错按缺省并提示", () => {
  assert.equal(hostLimits({}, 8).limits.fixReservePercent, 25);
  assert.equal(
    hostLimits({ NODE_TEST_CONTEXT: "child" }, 8).limits.fixReservePercent,
    0,
  );
  assert.equal(
    hostLimits({ ATRIUM_FIX_RESERVE_PERCENT: "50" }, 8).limits
      .fixReservePercent,
    50,
  );
  assert.equal(
    hostLimits({ ATRIUM_FIX_RESERVE_PERCENT: "off" }, 8).limits
      .fixReservePercent,
    0,
  );
  const bad = hostLimits({ ATRIUM_FIX_RESERVE_PERCENT: "很多" }, 8);
  assert.equal(bad.limits.fixReservePercent, 25);
  assert.match(bad.problems.join("\n"), /ATRIUM_FIX_RESERVE_PERCENT=很多/);
});

test("队列扫描：修复任务带 fix 标记、单独出队首；紧急的修复按紧急算，和功能共用一个队首", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  createTask(db, { title: "功能" });
  createTask(db, { title: "修复一" });
  createTask(db, { title: "修复二", urgent: true });
  for (const id of [1, 2, 3])
    enqueue(db, {
      task_id: id,
      tool: "kimi",
      worker: "kimi",
      risk: "low",
      queued_at: id,
    });
  const got = heads(db).map((h) => ({
    id: h.task_id,
    fix: h.fix,
    urgent: h.urgent,
  }));
  assert.deepEqual(got, [
    { id: 3, fix: false, urgent: true },
    { id: 2, fix: true, urgent: false },
  ]);
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

/** 假 kimi 等到 $HOME/go-tN 出现才收工（每件任务各自放行），期间一直有输出。 */
const gatedKimi = (fx: { script: (name: string, body: string) => void }) =>
  fx.script(
    "kimi",
    'set -e\nwhile [ ! -f "$HOME/go-$ATRIUM_TASK" ]; do echo waiting; sleep 0.1; done\necho hi > done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"',
  );

test("运行时：有修复在等时，空出来的位置先给修复（先入队的功能也让）；没有修复在等时照常给功能", async (t) => {
  // 上限 2、按 50% 留 1 个给修复。
  const host = new HostLoad(
    limits({ maxWorkers: 2, fixReservePercent: 50 }),
    () => 0,
  );
  const { fx, data, call } = await startApp(
    t,
    gatedKimi,
    undefined,
    undefined,
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const add = async (title: string, extra = {}) =>
    (await call("POST", "/api/tasks", { title, repo: fx.repo, ...extra })).body;
  assert.equal((await add("功能一")).task_type, "feature"); // t1
  await add("功能二"); // t2
  await add("功能三"); // t3
  assert.equal((await add("弹窗", { type: "修复" })).task_type, "fix"); // t4
  const bad = await call("POST", "/api/tasks", { title: "坏", type: "紧急" });
  assert.equal(bad.status, 400);
  const run = (ref: string) =>
    call("POST", `/api/tasks/${ref}/run`, { worker: "kimi" });
  const go = (ref: string) =>
    writeFileSync(join(fx.root, "home", `go-${ref}`), "");
  // 没有修复在等：两个位置都给功能。
  assert.equal((await run("t1")).body.task.status, "running");
  assert.equal((await run("t2")).body.task.status, "running");
  // 满了：功能三、修复都排队。
  assert.equal((await run("t3")).body.queued, true);
  assert.equal((await run("t4")).body.queued, true);
  const top = (await call("GET", "/api/tasks/top")).body;
  assert.deepEqual(top.types, { feature: 3, fix: 1, urgent: 0 });
  // 功能一收工：空出来的位置给修复（功能三先入队也让）。
  go("t1");
  await until(() => getTask(db, "t4").status === "running", 20_000);
  assert.equal(getTask(db, "t3").status, "todo");
  // 功能二收工：修复已占着保底位置，功能三拿到剩下的位置。
  go("t2");
  await until(() => getTask(db, "t3").status === "running", 20_000);
  for (const ref of ["t3", "t4"]) go(ref);
  for (const ref of ["t1", "t2", "t3", "t4"])
    await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
  const started = (ref: string) =>
    getTask(db, ref).events.find((event) => event.kind === "start")!.id;
  assert.ok(started("t4") < started("t3"), "修复 t4 先于先入队的功能 t3");
});

test("全景任务行带类型：修复为 fix，旧库没有列按功能", () => {
  const row = {
    id: 1,
    title: "弹窗",
    status: "todo",
    worker: null,
    started_at: null,
    updated_at: 0,
    part: null,
    pr_url: null,
    issue: null,
    repo: null,
    delivery_stage: null,
    ended_at: null,
    job_id: null,
  };
  assert.equal(taskView({ ...row, task_type: "fix" }).type, "fix");
  assert.equal(taskView({ ...row, task_type: null }).type, "feature");
  assert.equal(taskView(row).type, "feature");
});
