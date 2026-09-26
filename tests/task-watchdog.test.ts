import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getTask } from "../server/tasks/ledger.ts";
import { startApp, until } from "./task-fixture.ts";

test("看门狗：假执行者零输出判卡死、按档案重试一次后失败；独占工具排队；stop 停进程", async (t) => {
  const { fx, data, call } = await startApp(t);
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "silent" });
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "grok" })).body.task
      .status,
    "running",
  );
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(waited.body.task.status, "failed");
  // 零输出的执行者没有摘要：日志抬头（含多行提示词参数）不能混进 result。
  assert.equal(waited.body.task.result, "");
  const kinds = getTask(db, "t1").events.map((event) => event.kind);
  assert.deepEqual(
    kinds.filter((kind) => ["start", "stalled", "exit_fail"].includes(kind)),
    ["start", "stalled", "exit_fail", "start", "stalled", "exit_fail"],
  );
  const outcome = (await call("GET", "/api/events/wait?as=secretary&timeout=0"))
    .body.events;
  assert.equal(outcome.length, 1, "卡死与最终失败按同一去重键合并");
  assert.equal(outcome[0].kind, "failed");
  assert.equal(outcome[0].count, 2);
  assert.match(outcome[0].detail.reason, /没有任何进展信号/);

  await call("POST", "/api/tasks", { title: "oc one" });
  await call("POST", "/api/tasks", { title: "oc two" });
  assert.equal(
    (await call("POST", "/api/tasks/t2/run", { worker: "opencode" })).body
      .queued,
    false,
  );
  const second = await call("POST", "/api/tasks/t3/run", {
    worker: "opencode",
  });
  assert.equal(second.body.queued, true);
  assert.equal(second.body.task.status, "todo");
  assert.equal(
    (await call("GET", "/api/tasks/t3/wait?timeout=20")).body.task.status,
    "done",
  );
  const t3 = getTask(db, "t3").events.map((event) => event.kind);
  assert.ok(t3.indexOf("queued") < t3.indexOf("start"));
  const t2 = getTask(db, "t2");
  assert.ok(t2.ended_at! <= getTask(db, "t3").started_at!, "独占工具不重叠");

  await call("POST", "/api/tasks", { title: "to stop" });
  const running = await call("POST", "/api/tasks/t4/run", { worker: "grok" });
  const pid = running.body.task.pid as number;
  const stop = await call("POST", "/api/tasks/t4/stop");
  assert.equal(stop.body.stopping, true);
  assert.equal(
    (await call("GET", "/api/tasks/t4/wait?timeout=10")).body.task.status,
    "failed",
  );
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal((await call("POST", "/api/tasks/t4/stop")).status, 409);
  const stopped = getTask(db, "t4").events.find(
    (event) => event.kind === "stop_requested",
  );
  assert.match(stopped!.detail!, /"by":"secretary"/);
  const after = (await call("GET", "/api/events/wait?as=secretary&timeout=0"))
    .body.events as { task: string; actor: string | null }[];
  assert.deepEqual(
    after.map((event) => event.task),
    ["t2", "t3"],
    "t1 在处理中租约内不重投；secretary 自己停的 t4 不投给自己",
  );
  const own = db
    .prepare("SELECT actor, kind FROM task_inbox WHERE task_id=4")
    .all();
  assert.deepEqual(
    own.map((row) => [row.actor, row.kind]),
    [["secretary", "failed"]],
    "记账仍记",
  );
  assert.equal(
    (await call("POST", "/api/tasks/t4/stop?as=有 空格")).status,
    400,
  );
});
