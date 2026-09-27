import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { EventInbox } from "../server/tasks/events.ts";
import { classify, Scheduler, taskPlan } from "../server/tasks/schedule.ts";
import { startApp } from "./task-fixture.ts";

async function eventually(check: () => Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("等待排期超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("排期纯判定：全部完成才就绪，失败或取消传递，运行中独立分组", () => {
  const one = [{ ref: "t1", status: "done" as const }];
  const pr = [{ ref: "o/r#6", merged: false }];
  assert.equal(classify("todo", one, pr).group, "waiting");
  assert.equal(
    classify("todo", one, [{ ...pr[0]!, merged: true }]).group,
    "ready",
  );
  for (const status of ["failed", "cancelled"] as const)
    assert.match(
      classify("todo", [{ ref: "t1", status }], []).reason!,
      /上游 t1/,
    );
  assert.equal(classify("running", one, pr).group, "running");
});

test("依赖校验：不存在、重复与环路拒绝；修改失败后原依赖仍在", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  createTask(db, { title: "A" });
  createTask(db, { title: "B", after: "t1" });
  createTask(db, { title: "C", after: "t2" });
  assert.throws(() => updateTask(db, "t1", { after: "t3" }), /环路/);
  assert.throws(() => updateTask(db, "t2", { after: "t99" }), /不存在/);
  assert.throws(() => updateTask(db, "t2", { after: "t1,t1" }), /重复/);
  assert.deepEqual(getTask(db, "t2").after, ["t1"]);
  db.close();
});

test("启动时隔离单条坏依赖，其他任务仍可读取", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  createTask(db, { title: "A" });
  createTask(db, { title: "B", after: "t1" });
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare(
    "INSERT INTO task_dependencies(task_id,after_id) VALUES (?,?)",
  ).run(2, 999);
  db.exec("PRAGMA foreign_keys=ON");
  ensureTaskTables(db);
  assert.deepEqual(getTask(db, "t2").after, ["t1"]);
  const quarantined = db
    .prepare("SELECT kind,reason FROM task_schedule_quarantine")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(quarantined, [{ kind: "task", reason: "引用的任务不存在" }]);
  db.close();
});

test("PR 条件通过 gh -R 查询；就绪事件一次、秘书自己的 none 任务不派", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, {
    title: "发布",
    owner: "secretary",
    deliver: "none",
    after_pr: "OpenQuota/core#6",
    auto: true,
  });
  const calls: string[][] = [];
  let dispatched = 0;
  let merged = false;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {
      dispatched++;
    },
    async (_command, args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: JSON.stringify({
          mergedAt: merged ? "2026-09-27T00:00:00Z" : null,
        }),
        stderr: "",
      };
    },
  );
  await scheduler.tick();
  assert.equal(taskPlan(db).groups.waiting.length, 1);
  assert.deepEqual(calls[0], [
    "pr",
    "view",
    "6",
    "-R",
    "OpenQuota/core",
    "--json",
    "mergedAt",
  ]);
  db.prepare("UPDATE task_pr_dependencies SET checked_at=NULL").run();
  merged = true;
  await scheduler.tick();
  assert.equal(taskPlan(db).groups.ready.length, 1);
  assert.equal(dispatched, 0);
  const events = (await inbox.wait("secretary", 0)).events;
  assert.equal(events.filter((event) => event.kind === "ready").length, 1);
  await scheduler.tick();
  assert.equal((await inbox.wait("secretary", 0)).events.length, 0);
  inbox.close();
  db.close();
});

test("隔离服务：A→B→C，A 完成后 B 自动派出，C 仍等待；上游失败卡住下游", async (t) => {
  const { call, taskRunner, fx, app } = await startApp(t);
  assert.ok(taskRunner);
  assert.equal(
    (await call("POST", "/api/tasks", { title: "A", deliver: "none" })).status,
    201,
  );
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "B",
        repo: fx.repo,
        deliver: "none",
        owner: "lead",
        after: "t1",
        auto: true,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "C",
        after: "t2",
        deliver: "none",
      })
    ).status,
    201,
  );
  assert.equal((await call("POST", "/api/tasks/t2/run", {})).status, 409);
  const patch = (id: string, status: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      payload: { status },
      headers: { host: "127.0.0.1" },
    });
  assert.equal((await patch("t1", "done")).statusCode, 200);
  await eventually(async () =>
    (await call("GET", "/api/tasks/t2")).body.events.some(
      (event: { kind: string }) => event.kind === "start",
    ),
  );
  const b = (await call("GET", "/api/tasks/t2")).body;
  assert.ok(b.events.some((event: { kind: string }) => event.kind === "start"));
  const plan = (await call("GET", "/api/tasks/plan")).body;
  assert.ok(
    plan.groups.waiting.some(
      (item: { task: { ref: string } }) => item.task.ref === "t3",
    ),
  );
  assert.equal(
    (await call("POST", "/api/tasks", { title: "坏上游" })).status,
    201,
  );
  assert.equal(
    (await call("POST", "/api/tasks", { title: "下游", after: "t4" })).status,
    201,
  );
  assert.equal((await patch("t4", "failed")).statusCode, 200);
  await eventually(
    async () => (await call("GET", "/api/tasks/t5")).body.status === "blocked",
  );
  const blocked = (await call("GET", "/api/tasks/t5")).body;
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.schedule_reason, /上游 t4/);
  if (taskRunner.runningTaskRefs().includes("t2")) {
    taskRunner.stop("t2");
    await taskRunner.wait("t2", 20);
  }
});
