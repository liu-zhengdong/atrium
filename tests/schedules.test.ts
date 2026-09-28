import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { addNode } from "../server/org/write.ts";
import { editMap } from "../server/map/write.ts";
import {
  DAY,
  HOUR,
  MINUTE,
  catchUp,
  dayLabel,
  decide,
  everyText,
  firstDue,
  following,
  isOpen,
  parseAt,
  parseEvery,
} from "../server/schedules/plan.ts";
import Fastify from "fastify";
import { leaderRule } from "../server/leaders/scope.ts";
import { registerLeaderGuard } from "../server/leaders/guard.ts";
import { LeaderTokens } from "../server/leaders/tokens.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import {
  ensureScheduleTables,
  insertSchedule,
} from "../server/schedules/model.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import { fixture, until } from "./task-fixture.ts";

const utc8 = () => 480;
/** 2026-09-28 00:00 东八区。 */
const D0 = Date.UTC(2026, 8, 27, 16, 0);

test("周期写法：单位、上下限、钟点只配整天", () => {
  assert.equal(parseEvery("7d"), 7 * DAY);
  assert.equal(parseEvery(" 12h "), 12 * HOUR);
  assert.equal(parseEvery("2w"), 14 * DAY);
  assert.equal(parseEvery("90m"), 90 * MINUTE);
  for (const bad of ["30m", "0d", "367d", "1y", "d", "", 7, undefined, "1.5d"])
    assert.throws(() => parseEvery(bad), /--every/);
  assert.equal(everyText(7 * DAY), "7d");
  assert.equal(everyText(3 * DAY), "3d");
  assert.equal(everyText(12 * HOUR), "12h");
  assert.equal(everyText(90 * MINUTE), "90m");
  assert.equal(parseAt("09:30", DAY), 570);
  assert.equal(parseAt("0:00", 7 * DAY), 0);
  for (const bad of ["24:00", "9:60", "0930", "", null])
    assert.throws(() => parseAt(bad, DAY), /--at: 写成/);
  assert.throws(() => parseAt("09:00", 12 * HOUR), /整天/);
});

test("第一轮：不定钟点是一个周期后；定了钟点是下一个到来的该钟点", () => {
  const now = D0 + 8 * HOUR; // 当地 08:00
  assert.equal(firstDue(now, DAY, null, utc8), now + DAY);
  assert.equal(firstDue(now, 7 * DAY, 9 * 60, utc8), D0 + 9 * HOUR);
  assert.equal(firstDue(now, DAY, 8 * 60, utc8), D0 + DAY + 8 * HOUR);
  assert.equal(firstDue(now, DAY, 7 * 60, utc8), D0 + DAY + 7 * HOUR);
  // 当地深夜：UTC 已是次日也按当地日历算。
  assert.equal(
    firstDue(D0 + 23 * HOUR + 30 * MINUTE, DAY, 60, utc8),
    D0 + DAY + HOUR,
  );
});

test("定了钟点的跨夏令时仍在同一钟点", () => {
  // 第二天当地 00:00 起偏移从 +8 变 +9（拨快一小时）。
  const switchAt = D0 + 12 * HOUR;
  const dst = (ms: number) => (ms >= switchAt ? 540 : 480);
  const first = D0 + 9 * HOUR;
  const second = following(first, DAY, 9 * 60, dst);
  assert.equal(second - first, 23 * HOUR);
  assert.equal(new Date(second + dst(second) * MINUTE).getUTCHours(), 9);
  assert.equal(following(first, DAY, null, dst) - first, DAY);
});

test("补跑：停机错过好几轮只算到了几轮，下一轮在未来", () => {
  const due = D0 + 9 * HOUR;
  assert.deepEqual(catchUp(due, DAY, 540, due - 1, utc8), {
    slots: 0,
    next: due,
  });
  assert.deepEqual(catchUp(due, DAY, 540, due, utc8), {
    slots: 1,
    next: due + DAY,
  });
  assert.deepEqual(catchUp(due, DAY, 540, due + 3 * DAY + 5, utc8), {
    slots: 4,
    next: due + 4 * DAY,
  });
  // 停机一年：常数步也算得对。
  const year = catchUp(due, HOUR, null, due + 365 * DAY - 1, utc8);
  assert.equal(year.slots, 365 * 24);
  assert.equal(year.next, due + 365 * DAY);
  const weekly = catchUp(due, 7 * DAY, 540, due + 70 * DAY, utc8);
  assert.equal(weekly.slots, 11);
  assert.equal(weekly.next, due + 77 * DAY);
});

test("到点判定：没到、删除等着；上一轮没结束跳过；错过的只补一轮", () => {
  const clock = { next_at: D0, every_ms: DAY, at_minute: null };
  const base = { ...clock, removed: false };
  assert.deepEqual(decide(base, null, D0 - 1, utc8), { kind: "wait" });
  assert.deepEqual(decide({ ...base, removed: true }, null, D0, utc8), {
    kind: "wait",
  });
  assert.deepEqual(decide(base, null, D0, utc8), {
    kind: "run",
    next_at: D0 + DAY,
    missed: 0,
  });
  assert.deepEqual(decide(base, "t3", D0 + 1, utc8), {
    kind: "skip",
    next_at: D0 + DAY,
    missed: 0,
    open: "t3",
  });
  assert.deepEqual(decide(base, null, D0 + 2 * DAY + 1, utc8), {
    kind: "run",
    next_at: D0 + 3 * DAY,
    missed: 2,
  });
  assert.deepEqual(decide(base, "t3", D0 + 2 * DAY, utc8), {
    kind: "skip",
    next_at: D0 + 3 * DAY,
    missed: 2,
    open: "t3",
  });
  for (const status of ["todo", "running", "blocked"])
    assert.equal(isOpen(status), true);
  for (const status of ["done", "failed", "cancelled"])
    assert.equal(isOpen(status), false);
  assert.equal(dayLabel(D0 + HOUR, utc8), "09-28");
  assert.equal(dayLabel(D0 - HOUR, utc8), "09-27");
});

test("leader 给本节点及子节点排周期任务；别的部分只读，也不能冒名", async (t) => {
  for (const route of ["/api/schedules", "/api/schedules/:id/run"])
    assert.equal(leaderRule("POST", route), "schedule", route);
  assert.equal(leaderRule("DELETE", "/api/schedules/:id"), "schedule");
  assert.equal(leaderRule("GET", "/api/schedules"), "read");

  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  ensureScheduleTables(db);
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  addNode(
    db,
    {
      parent: "o1",
      slug: "cli",
      kind: "project",
      name: "命令行",
      leader: "a1",
      reason: "建",
    },
    "u1",
  );
  addNode(
    db,
    { parent: "o2", slug: "help", kind: "module", name: "帮助", reason: "建" },
    "u1",
  );
  addNode(
    db,
    {
      parent: "o1",
      slug: "web",
      kind: "project",
      name: "网页",
      leader: "a2",
      reason: "建",
    },
    "u1",
  );
  const row = (node: number) => ({
    node_id: node,
    title: "巡检",
    kind: "task" as const,
    every_ms: DAY,
    at_minute: null,
    brief: null,
    brief_path: null,
    by: null,
    worker: null,
  });
  insertSchedule(db, row(3));
  insertSchedule(db, row(4));
  const tokens = new LeaderTokens();
  const app = Fastify();
  t.after(() => app.close());
  registerLeaderGuard(app, db, tokens, () => {
    throw new Error("不该用到事件箱");
  });
  const ok = async () => ({ ok: true });
  app.post("/api/schedules", ok);
  app.post("/api/schedules/:id/run", ok);
  app.delete("/api/schedules/:id", ok);
  const token = `Bearer ${tokens.issue("a1", 60_000)}`;
  const send = async (
    method: "POST" | "DELETE",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: token },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.body };
  };
  for (const node of ["o2", "cli/help"])
    assert.equal(
      (
        await send("POST", "/api/schedules", {
          node,
          title: "巡检",
          every: "1d",
        })
      ).status,
      200,
      node,
    );
  const other = await send("POST", "/api/schedules", {
    node: "o4",
    every: "1d",
  });
  assert.equal(other.status, 403);
  assert.match(other.body, /o4.*不在你负责的部分里/);
  assert.equal((await send("POST", "/api/schedules/s1/run")).status, 200);
  assert.equal((await send("POST", "/api/schedules/s2/run")).status, 403);
  assert.equal((await send("DELETE", "/api/schedules/s1")).status, 200);
  assert.equal((await send("DELETE", "/api/schedules/s2")).status, 403);
  assert.equal((await send("DELETE", "/api/schedules/s9")).status, 404);
  assert.equal(
    (await send("POST", "/api/schedules?as=a2", { node: "o4", every: "1d" }))
      .status,
    403,
  );
});

test("隔离服务：周期巡检到点生成巡检任务，没结束跳过、停机只补一轮、失败投 leader；带旧表启动", async (t) => {
  const fx = fixture(t);
  const data = join(fx.root, "schedule-data");
  mkdirSync(data);
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE IF NOT EXISTS pi_identities (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO pi_identities VALUES (1,'legacy')",
  );
  legacy.close();
  // 假执行者跑 2 秒：够周期巡检在它结束前再到一次点。
  fx.script(
    "opencode",
    'echo \'{"type":"text","part":{"text":"巡检中"}}\'\nsleep 2\necho \'{"type":"text","part":{"text":"好了"}}\'',
  );
  const start = Date.now();
  let clock = start;
  const { app, db } = await createApp({
    data,
    auth: false,
    tasks: {
      env: { ...fx.env, ATRIUM_DATA: data, ATRIUM_PORT: "4999" },
      workersDir: fx.workers,
      pace: async () => undefined,
      usagePace: async () => undefined,
      tickMs: 100,
    },
    schedules: { tickMs: 50, now: () => clock, offset: utc8 },
  });
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, any>,
    };
  };
  const count = (sql: string, ...args: (string | number)[]) =>
    (db.prepare(sql).get(...args) as { n: number }).n;
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  for (const [slug, name] of [
    ["cli", "命令行"],
    ["web", "网页"],
    ["bare", "空白"],
  ])
    addNode(
      db,
      { parent: "o1", slug, kind: "project", name, reason: "建" },
      "u1",
    );
  editMap(db, "o2", { uses: ["看帮助", "看全景"] }, "u1");

  // 校验：建不出任务的当场报错，也不留下任务或短号。
  for (const [payload, status, pattern] of [
    [{ node: "o4", kind: "patrol", every: "1d" }, 409, /uses/],
    [{ node: "o2", title: "甲", every: "30m" }, 400, /--every/],
    [{ node: "o2", title: "甲", every: "12h", at: "09:00" }, 400, /整天/],
    [{ node: "o2", kind: "patrol", every: "1d", brief: "看" }, 400, /patrol/],
    [{ node: "o2", title: "甲", every: "1d", by: "没有这个专员" }, 404, /./],
    [{ node: "o2", every: "1d" }, 400, /标题/],
    [{ node: "o2", title: "甲", every: "1d", kind: "chat" }, 400, /--kind/],
    [{ node: "o9", title: "甲", every: "1d" }, 404, /./],
    [{ node: "o2", title: "甲", every: "1d", worker: "nope+x" }, 400, /工具/],
  ] as const) {
    const bad = await call("POST", "/api/schedules", payload);
    assert.equal(bad.status, status, JSON.stringify(bad.body));
    assert.match(bad.body.error, pattern);
  }
  assert.equal(count("SELECT count(*) n FROM tasks"), 0);
  assert.equal(count("SELECT count(*) n FROM patrol_runs"), 0);

  const patrol = await call("POST", "/api/schedules", {
    node: "o2",
    kind: "patrol",
    every: "1d",
    worker: "opencode",
  });
  assert.equal(patrol.status, 201, JSON.stringify(patrol.body));
  assert.equal(patrol.body.ref, "s1");
  assert.equal(patrol.body.title, "体验巡检");
  assert.equal(patrol.body.next_at, start + DAY);
  // 试建已回滚：到点前没有任务，短号也没被占。
  assert.equal(count("SELECT count(*) n FROM tasks"), 0);
  const research = await call("POST", "/api/schedules", {
    node: "o3",
    title: "看同类产品",
    kind: "research",
    every: "7d",
    brief: "看看同类产品最近在做什么",
    worker: "opencode",
  });
  assert.equal(research.status, 201, JSON.stringify(research.body));
  assert.equal(research.body.ref, "s2");
  assert.equal(research.body.next_at, start + 7 * DAY);
  // s3 登记时 o4 有场景，之后被清空：到点建不出任务。
  editMap(db, "o4", { uses: ["试一试"] }, "u1");
  const failing = await call("POST", "/api/schedules", {
    node: "o4",
    kind: "patrol",
    every: "1d",
    worker: "opencode",
  });
  assert.equal(failing.body.ref, "s3");
  editMap(db, "o4", { uses: [] }, "u1");

  // 第一次到点：生成巡检任务并派发。
  clock = start + DAY;
  await until(
    () => count("SELECT count(*) n FROM patrol_runs WHERE node_id=2") === 1,
  );
  const first = await call("GET", "/api/schedules/s1");
  assert.equal(first.body.runs[0].outcome, "created");
  const firstTask = first.body.last_task.ref as string;
  assert.equal(first.body.next_at, start + 2 * DAY);
  const task = await call("GET", `/api/tasks/${firstTask}`);
  assert.match(task.body.title, /^体验巡检：命令行 · 看帮助/);
  assert.equal(task.body.part_ref, "o2");
  await until(() => {
    const row = db
      .prepare("SELECT status FROM tasks WHERE id=?")
      .get(Number(firstTask.slice(1))) as { status: string };
    return row.status === "running";
  });

  // s3 的节点没有场景了：到点建不出任务，记失败、挪到下一轮并投给该部分的 leader（这里没有，投秘书）。
  await until(
    () =>
      count(
        "SELECT count(*) n FROM schedule_runs WHERE schedule_id=3 AND outcome='failed'",
      ) >= 1,
  );
  const failed = await call("GET", "/api/schedules/s3");
  assert.match(failed.body.runs[0].note, /建不出任务.*uses/);
  assert.ok(failed.body.next_at > clock);
  assert.equal(
    count(
      "SELECT count(*) n FROM task_inbox WHERE kind='schedule_failed' AND subscriber='secretary'",
    ),
    1,
  );
  // 暂停 s3 所在的部分：那一块不再生成，别的照常（一键停机，server/pause.ts）。
  await call("POST", "/api/pause", { part: "o4" });
  // 上一轮还在跑：跳过本轮并记一笔。
  clock = start + 2 * DAY;
  await until(
    () =>
      count(
        "SELECT count(*) n FROM schedule_runs WHERE schedule_id=1 AND outcome='skipped'",
      ) === 1,
  );
  const skipped = await call("GET", "/api/schedules/s1");
  assert.match(skipped.body.runs[0].note, new RegExp(`上一轮 ${firstTask}`));
  assert.equal(skipped.body.next_at, start + 3 * DAY);

  // 上一轮结束后停机错过好几轮：只补一轮。
  await until(() => {
    const row = db
      .prepare("SELECT status FROM tasks WHERE id=?")
      .get(Number(firstTask.slice(1))) as { status: string };
    return row.status === "done";
  }, 15_000);
  clock = start + 5 * DAY;
  await until(
    () => count("SELECT count(*) n FROM patrol_runs WHERE node_id=2") === 2,
  );
  const caught = await call("GET", "/api/schedules/s1");
  assert.equal(caught.body.runs[0].outcome, "created");
  assert.match(caught.body.runs[0].note, /错过 2 轮，只补这一轮/);
  assert.equal(caught.body.next_at, start + 6 * DAY);
  const second = await call("GET", `/api/tasks/${caught.body.last_task.ref}`);
  assert.match(second.body.title, /看全景/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(count("SELECT count(*) n FROM patrol_runs WHERE node_id=2"), 2);

  // 手动跑一轮：不改下次时间；上一轮没结束时不起。
  const researchNext = (await call("GET", "/api/schedules/s2")).body.next_at;
  const manual = await call("POST", "/api/schedules/s2/run");
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  assert.match(manual.body.task.title, /^看同类产品 · /);
  assert.equal(manual.body.task.deliver, "none");
  assert.equal(manual.body.task.part_ref, "o3");
  assert.equal(manual.body.task.brief, "看看同类产品最近在做什么");
  assert.equal(
    (await call("GET", "/api/schedules/s2")).body.next_at,
    researchNext,
  );
  const again = await call("POST", "/api/schedules/s2/run");
  assert.equal(again.status, 409);
  assert.match(again.body.error, /还没结束/);

  // 全局暂停：到点也不生成；恢复后才照常。删除；列表按节点含下层，删掉的只在 all 里。
  assert.equal((await call("POST", "/api/pause", {})).status, 200);
  clock = start + 9 * DAY;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(count("SELECT count(*) n FROM patrol_runs WHERE node_id=2"), 2);
  assert.equal((await call("POST", "/api/resume", {})).status, 200);
  const removed = await call("DELETE", "/api/schedules/s1");
  assert.equal(removed.body.state, "removed");
  assert.equal((await call("POST", "/api/schedules/s1/run")).status, 409);
  const listed = await call("GET", "/api/schedules?node=o1");
  assert.deepEqual(
    listed.body.schedules.map((s: { ref: string }) => s.ref),
    ["s2", "s3"],
  );
  const everything = await call("GET", "/api/schedules?all=1&limit=2");
  assert.deepEqual(
    everything.body.schedules.map((s: { ref: string }) => s.ref),
    ["s1", "s2"],
  );
  assert.equal(everything.body.next_after, "s2");
  const onlyWeb = await call("GET", "/api/schedules?node=o3");
  assert.deepEqual(
    onlyWeb.body.schedules.map((s: { ref: string }) => s.ref),
    ["s2"],
  );
  const next = await call("POST", "/api/schedules", {
    node: "o2",
    title: "周报",
    every: "7d",
    at: "09:30",
    kind: "research",
  });
  assert.equal(next.body.ref, "s4");
  assert.equal(next.body.at, "09:30");
  assert.equal(next.body.every, "7d");
  assert.ok(next.body.next_at > clock && next.body.next_at <= clock + DAY);
  assert.equal(
    (
      db.prepare("SELECT value FROM pi_identities WHERE id=1").get() as {
        value: string;
      }
    ).value,
    "legacy",
  );
});
