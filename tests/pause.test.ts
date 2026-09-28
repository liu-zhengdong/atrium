import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  clearPause,
  ensurePauseTable,
  globalPause,
  hostPaused,
  migrateOldPauses,
  partPause,
  pauseText,
  setPause,
} from "../server/pause.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { leaderRule } from "../server/leaders/scope.ts";
import { startApp } from "./task-fixture.ts";

test("暂停状态：全局、部门（含下层）、主机；重复暂停不改原来的谁与原因；破坏输入被表拒绝", () => {
  const db = new DatabaseSync(":memory:");
  ensurePauseTable(db);
  ensureOrgTables(db);
  for (const [parent, slug, kind] of [
    [undefined, "org", "org"],
    ["o1", "atrium", "project"],
    ["o2", "cli", "module"],
  ] as const)
    addNode(db, { parent, slug, kind, name: slug, reason: "测试" }, "u1");
  assert.equal(globalPause(db), null);
  assert.equal(partPause(db, 3), null);
  const first = setPause(db, "o2", "secretary", "先停 Atrium", 1000);
  assert.equal(first.changed, true);
  assert.equal(partPause(db, 3)?.scope, "o2", "下层也算");
  assert.equal(partPause(db, 1), null, "上层不算");
  const again = setPause(db, "o2", "u1", "别的原因", 2000);
  assert.deepEqual(
    { changed: again.changed, by: again.pause.by, why: again.pause.why },
    { changed: false, by: "secretary", why: "先停 Atrium" },
  );
  assert.match(
    pauseText(first.pause),
    /^已暂停（o2，secretary .*：先停 Atrium）$/,
  );
  setPause(db, "h3", "u1", null);
  assert.equal(hostPaused(db, 3), true);
  assert.equal(hostPaused(db, 2), false);
  setPause(db, "all", "u1", null);
  assert.match(pauseText(globalPause(db)!), /^已暂停（全部，u1 /);
  assert.equal(clearPause(db, "all")?.scope, "all");
  assert.equal(clearPause(db, "all"), null);
  for (const scope of ["o0", "x1", "", "hh"])
    assert.throws(() => setPause(db, scope, "u1", null), /CHECK/);
  db.close();
});

test("旧的暂停开关只迁一次：暂停的主机转主机暂停，暂停的周期任务转全局暂停；没有旧列什么也不做", () => {
  const db = new DatabaseSync(":memory:");
  ensurePauseTable(db);
  assert.deepEqual(migrateOldPauses(db), []);
  db.exec(`CREATE TABLE hosts (id INTEGER PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);
    INSERT INTO hosts(id,paused) VALUES (1,1),(2,0),(3,1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY, paused_at INTEGER, removed_at INTEGER);
    INSERT INTO schedules(id,paused_at,removed_at) VALUES (1,5,NULL),(2,NULL,NULL),(3,5,9);`);
  const notes = migrateOldPauses(db, 1000);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /h1、h3 仍暂停/);
  assert.match(notes[1]!, /s1/);
  assert.equal(hostPaused(db, 1), true);
  assert.equal(hostPaused(db, 2), false);
  assert.equal(hostPaused(db, 3), true);
  assert.match(globalPause(db)!.why!, /s1/);
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM hosts WHERE paused=1").get() as {
        n: number;
      }
    ).n,
    0,
  );
  assert.deepEqual(migrateOldPauses(db), [], "迁过就不再迁");
  db.close();
});

test("一键停机：暂停时派活只排队，恢复后按顺序拉起；--stop 停掉在跑的；leader 不能暂停", async (t) => {
  const { call, fx } = await startApp(t);
  assert.equal(leaderRule("POST", "/api/pause"), "deny");
  assert.equal(leaderRule("POST", "/api/resume"), "deny");
  const paused = await call("POST", "/api/pause?as=secretary", {
    why: "先停下看看",
  });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.pause.scope, "all");
  assert.deepEqual(paused.body.stopped, []);
  await call("POST", "/api/tasks", { title: "排着", repo: fx.repo });
  const run = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.queued, true);
  assert.match(
    run.body.task.queued_reason,
    /已暂停（全部，secretary .*先停下看看/,
  );
  // 看板带暂停；巡检几轮也不拉起。
  const top = (await call("GET", "/api/tasks/top")).body;
  assert.equal(top.pauses[0].by, "secretary");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await call("GET", "/api/tasks/t1")).body.status, "todo");
  // 暂停时事件不投给等待的人。
  const waited = (await call("GET", "/api/events/wait?timeout=1")).body;
  assert.deepEqual(waited.events, []);
  assert.match(waited.paused, /已暂停/);
  // 恢复：排着的按顺序拉起。
  const resumed = await call("POST", "/api/resume", {});
  assert.equal(resumed.body.resumed.scope, "all");
  assert.deepEqual(resumed.body.pauses, []);
  const done = (await call("GET", "/api/tasks/t1/wait?timeout=20")).body.task;
  assert.notEqual(done.status, "todo");
  // --stop：在跑的一并停掉。
  fx.script("grok", "sleep 30");
  await call("POST", "/api/tasks", { title: "在跑", deliver: "none" });
  const running = await call("POST", "/api/tasks/t2/run", { worker: "grok" });
  assert.equal(running.body.task.status, "running");
  const stopped = await call("POST", "/api/pause", { stop: true });
  assert.deepEqual(stopped.body.stopped, ["t2"]);
  const ended = (await call("GET", "/api/tasks/t2/wait?timeout=20")).body.task;
  assert.notEqual(ended.status, "running");
  // 破坏输入：范围只能给一个，主机要登记过。
  const both = await call("POST", "/api/pause", { part: "o1", host: "h1" });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /--part 与 --host 只能给一个/);
  assert.equal((await call("POST", "/api/pause", { host: "h9" })).status, 404);
  assert.equal((await call("POST", "/api/pause", { host: "9" })).status, 400);
});
