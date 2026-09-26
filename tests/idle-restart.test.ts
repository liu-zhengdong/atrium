import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { readRestartState, writeRestartState } from "../server/supervisor.ts";
import { idleDecision, IdleRestart } from "../server/tasks/idle-restart.ts";
import { getTask } from "../server/tasks/ledger.ts";
import { startApp, until } from "./task-fixture.ts";

test("空闲重启判定：空队列优先，未到期限等待，到期只报告", () => {
  assert.equal(idleDecision(100, 100, []), "restart");
  assert.equal(idleDecision(99, 100, ["t1"]), "wait");
  assert.equal(idleDecision(100, 100, ["t1"]), "timeout");
  assert.equal(idleDecision(101, 100, ["t1", "t2"]), "timeout");
});

test("假执行者在跑时暂缓重启，新任务记等待事件，结束后重启并续派", async (t) => {
  const { fx, data, call, app, taskRunner } = await startApp(t);
  assert.ok(taskRunner);
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  for (const title of ["first", "second"])
    assert.equal(
      (await call("POST", "/api/tasks", { title, repo: fx.repo })).status,
      201,
    );
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "opencode" })).body.task
      .status,
    "running",
  );
  let launched = 0;
  const idle = new IdleRestart(data, taskRunner, async () => {
    launched++;
    const state = readRestartState(data)!;
    writeRestartState(data, { ...state, status: "stopping" });
  });
  idle.start();
  t.after(() => idle.close());
  const scheduled = idle.schedule(30_000);
  assert.deepEqual(scheduled.running, ["t1"]);
  assert.equal(launched, 0);
  const queued = await call("POST", "/api/tasks/t2/run", {
    worker: "opencode",
  });
  assert.equal(queued.body.queued, true);
  assert.match(
    getTask(db, "t2").events.find((event) => event.kind === "queued")?.detail ??
      "",
    /等待重启/,
  );
  await until(() => launched === 1);
  assert.equal(getTask(db, "t2").status, "todo");
  assert.equal(
    getTask(db, "t2").events.some((event) => event.kind === "start"),
    false,
  );
  idle.close();
  await app.close();
  const next = await createApp({
    data,
    runtime: false,
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      tickMs: 100,
      pace: async () => undefined,
    },
  });
  t.after(() => next.app.close());
  await until(() =>
    getTask(next.store.db, "t2").events.some((event) => event.kind === "start"),
  );
  await until(() => next.taskRunner?.runningTaskRefs().length === 0);
  assert.equal(launched, 1);
});

test("超时仅列出仍在跑的任务，不杀执行者并恢复派发", async (t) => {
  const { fx, data, call, taskRunner } = await startApp(t, (fixture) => {
    writeFileSync(
      join(fixture.workers, "harness", "grok.md"),
      "---\nlimits: {startup_minutes: 10}\n---\n",
    );
  });
  assert.ok(taskRunner);
  assert.equal(
    (await call("POST", "/api/tasks", { title: "long", repo: fx.repo })).status,
    201,
  );
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "grok" })).body.task
      .status,
    "running",
  );
  let launched = 0;
  const idle = new IdleRestart(data, taskRunner, async () => {
    launched++;
  });
  t.after(() => idle.close());
  idle.schedule(30_000);
  await idle.tick(Date.now() + 31_000);
  const state = readRestartState(data);
  assert.equal(state?.status, "idle_timeout");
  assert.deepEqual(state?.remainingTasks, ["t1"]);
  assert.equal(launched, 0);
  assert.equal(taskRunner.isRestartPending(), false);
  assert.equal((await call("GET", "/api/tasks/t1")).body.status, "running");
  await call("POST", "/api/tasks/t1/stop");
  await until(() => taskRunner.runningTaskRefs().length === 0);
});
