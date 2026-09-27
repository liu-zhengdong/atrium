import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createTask,
  ensureTaskTables,
  getTask,
  noteTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { EventInbox } from "../server/tasks/events.ts";
import {
  classify,
  Scheduler,
  taskPlan,
  upstreamCondition,
} from "../server/tasks/schedule.ts";
import {
  releaseOf,
  type Dependency,
  type PrState,
  type Release,
} from "../server/tasks/schedule-upstream.ts";
import { holderFor } from "../server/tasks/holder-facts.ts";
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

test("排期纯判定：上游交付 PR 时合入才满足，关闭未合入卡住下游", () => {
  const pr = (state: "open" | "merged" | "closed" | null, error = null) => [
    {
      ref: "t1",
      status: "done" as const,
      pr: { number: 308, state, error },
    },
  ];
  const open = classify("todo", pr("open"), []);
  assert.equal(open.group, "waiting");
  assert.deepEqual(open.waiting_for, ["t1 的 PR #308 合入"]);
  assert.match(classify("todo", pr(null), []).waiting_for[0]!, /尚未查询/);
  assert.equal(classify("todo", pr("merged"), []).group, "ready");
  const closed = classify("todo", pr("closed"), []);
  assert.equal(closed.group, "blocked");
  assert.equal(closed.reason, "上游 t1 的 PR #308 已关闭未合入");
  // 下游因 PR 关闭被卡住后，PR 重开合入即恢复（原因以「上游 」开头）。
  assert.equal(
    classify("blocked", pr("merged"), [], closed.reason).group,
    "ready",
  );
  assert.equal(
    classify("todo", [{ ref: "t1", status: "done" }], []).group,
    "ready",
  );
});

test("A(pr)→B：A done 但 PR 未合入时 B 等待，合入后 B 就绪；comment 交付 done 即满足", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, { title: "A", deliver: "pr" });
  createTask(db, { title: "B", after: "t1", auto: true });
  createTask(db, { title: "C", deliver: "comment", issue: 1 });
  createTask(db, { title: "D", after: "t3" });
  db.prepare(
    "UPDATE tasks SET status='done',pr_url='https://github.com/o/r/pull/308' WHERE id=1",
  ).run();
  db.prepare("UPDATE tasks SET status='done' WHERE id=3").run();
  const calls: string[][] = [];
  let state = "OPEN";
  let dispatched = 0;
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
          state,
          mergedAt: state === "MERGED" ? "2026-09-27T00:00:00Z" : null,
        }),
        stderr: "",
      };
    },
  );
  const group = (ref: string) => {
    const groups = taskPlan(db).groups;
    for (const [name, items] of Object.entries(groups))
      if (items.some((item) => item.task.ref === ref)) return name;
  };
  await scheduler.tick();
  assert.equal(group("t2"), "waiting");
  assert.equal(group("t4"), "ready");
  assert.deepEqual(
    taskPlan(db).groups.waiting.find((item) => item.task.ref === "t2")!
      .waiting_for,
    ["t1 的 PR #308 合入"],
  );
  assert.deepEqual(calls[0], [
    "pr",
    "view",
    "308",
    "-R",
    "o/r",
    "--json",
    "state,mergedAt",
  ]);
  assert.equal(dispatched, 0);
  // 一分钟内不重复查询。
  await scheduler.tick();
  assert.equal(calls.length, 1);
  db.prepare("UPDATE task_pr_merge SET checked_at=0").run();
  state = "MERGED";
  await scheduler.tick();
  assert.equal(dispatched, 1);
  // 合入后不再查。
  db.prepare("UPDATE task_pr_merge SET checked_at=0").run();
  await scheduler.tick();
  assert.equal(calls.length, 2);
  inbox.close();
  db.close();
});

test("上游 PR 关闭未合入：下游标卡住并说明，重开合入后恢复", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, { title: "A" });
  createTask(db, { title: "B", after: "t1" });
  db.prepare(
    "UPDATE tasks SET status='done',pr_url='https://github.com/o/r/pull/9' WHERE id=1",
  ).run();
  let state = "CLOSED";
  let ok = true;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => ({
      ok,
      stdout: ok ? JSON.stringify({ state }) : "",
      stderr: ok ? "" : "HTTP 502\nsecond line",
    }),
  );
  await scheduler.tick();
  const blocked = getTask(db, "t2");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.schedule_reason, "上游 t1 的 PR #9 已关闭未合入");
  // 查询失败沿用上次状态，并写明失败原因。
  ok = false;
  db.prepare("UPDATE task_pr_merge SET checked_at=0").run();
  await scheduler.tick();
  assert.equal(getTask(db, "t2").status, "blocked");
  ok = true;
  state = "MERGED";
  db.prepare("UPDATE task_pr_merge SET checked_at=0").run();
  await scheduler.tick();
  assert.equal(getTask(db, "t2").status, "todo");
  assert.equal(taskPlan(db).groups.ready[0]!.task.ref, "t2");
  inbox.close();
  db.close();
});

test("上线进度纯判定：账本阶段 × online_wait × 上线失败穷举", () => {
  const stages = [
    null,
    "reviewing",
    "merge_queued",
    "merging",
    "merged",
    "online",
  ] as const;
  for (const delivery_stage of stages)
    for (const online_wait of [0, 1])
      for (const online_failed of [false, true]) {
        const got = releaseOf({ delivery_stage, online_wait, online_failed });
        const want: Release | undefined =
          delivery_stage === "merging"
            ? "merging"
            : delivery_stage === "online"
              ? "online"
              : delivery_stage !== "merged"
                ? undefined
                : online_wait === 1
                  ? "waiting"
                  : online_failed
                    ? "failed"
                    : undefined;
        assert.equal(
          got,
          want,
          `${delivery_stage}/${online_wait}/${online_failed}`,
        );
      }
});

test("依赖就绪纯判定：要自动上线的上游上线才算，上线失败卡住，不上线的仓库合入即可", () => {
  const dep = (
    state: PrState | null,
    release?: Release,
    status: Dependency["status"] = "done",
  ): Dependency => ({
    ref: "t1",
    status,
    pr: { number: 9, state, error: null },
    ...(release ? { release } : {}),
  });
  // 已合入未上线：等上线，不就绪。
  const waiting = classify("todo", [dep("merged", "waiting")], []);
  assert.equal(waiting.group, "waiting");
  assert.deepEqual(waiting.waiting_for, ["t1 上线"]);
  // PR 缓存还没刷新成合入，但账本已记合入：同样说等上线。
  assert.deepEqual(classify("todo", [dep("open", "waiting")], []).waiting_for, [
    "t1 上线",
  ]);
  // 已上线：就绪。
  assert.equal(classify("todo", [dep("merged", "online")], []).group, "ready");
  // 上线失败：卡住并写明，已被它卡住的上线后恢复。
  const failed = classify("todo", [dep("merged", "failed")], []);
  assert.equal(failed.group, "blocked");
  assert.equal(failed.reason, "上游 t1 上线失败");
  assert.equal(
    classify("blocked", [dep("merged", "online")], [], failed.reason).group,
    "ready",
  );
  // 不上线的仓库（别的仓库、本服务不自升级）：合入即就绪。
  assert.equal(classify("todo", [dep("merged")], []).group, "ready");
  // 运行时正在合入、还没记账：gh 显示已合入也先等，免得先发「就绪」再改口。
  assert.deepEqual(
    classify("todo", [dep("merged", "merging")], []).waiting_for,
    ["t1 的 PR #9 合入"],
  );
  // 穷举：上游没完成的一律按上游状态说；完成的按上线进度优先、PR 其次。
  const statuses = [
    "todo",
    "running",
    "blocked",
    "failed",
    "cancelled",
    "done",
  ] as const;
  const states = [null, "open", "merged", "closed"] as const;
  const releases = [
    undefined,
    "merging",
    "waiting",
    "online",
    "failed",
  ] as const;
  for (const status of statuses)
    for (const state of states)
      for (const release of releases) {
        const got = upstreamCondition(dep(state, release, status));
        const label = `${status}/${state}/${release}`;
        if (status === "failed" || status === "cancelled")
          assert.deepEqual(
            got,
            { kind: "blocked", text: `t1 [${status}]` },
            label,
          );
        else if (status !== "done")
          assert.deepEqual(
            got,
            { kind: "wait", text: `t1 [${status}]` },
            label,
          );
        else if (release === "online") assert.equal(got.kind, "met", label);
        else if (release === "failed")
          assert.deepEqual(
            got,
            { kind: "blocked", text: "t1 上线失败" },
            label,
          );
        else if (release === "waiting")
          assert.deepEqual(got, { kind: "wait", text: "t1 上线" }, label);
        else if (state === "closed") assert.equal(got.kind, "blocked", label);
        else if (state === "merged" && release === undefined)
          assert.equal(got.kind, "met", label);
        else {
          assert.equal(got.kind, "wait", label);
          assert.match((got as { text: string }).text, /的 PR #9 合入/, label);
        }
      }
  // 没交付 PR 的上游：done 即满足（上线进度只对交付 PR 的有）。
  assert.equal(upstreamCondition({ ref: "t1", status: "done" }).kind, "met");
});

test("上游合入自身仓库：已合入不发就绪，上线后才发；上线失败卡住下游；别的仓库合入即就绪", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  // t1 合入 Atrium 自身（等上线），t3 合入 OpenQuota（不上线），t5 上线失败。
  for (const title of ["A", "B", "C", "D", "E", "F"])
    createTask(db, {
      title,
      auto: false,
      ...(title === "B" ? { after: "t1" } : {}),
      ...(title === "D" ? { after: "t3" } : {}),
      ...(title === "F" ? { after: "t5" } : {}),
    });
  const merged = (id: number, wait: 0 | 1) => {
    db.prepare(
      "UPDATE tasks SET status='done',deliver='pr',pr_url=?,delivery_stage='merged',online_wait=? WHERE id=?",
    ).run(`https://github.com/o/r/pull/${id}`, wait, id);
    noteTask(db, id, "merged", {});
  };
  merged(1, 1);
  merged(3, 0);
  merged(5, 0);
  noteTask(db, 5, "online_failed", { reason: "自升级失败" });
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => ({
      ok: true,
      stdout: JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-09-27T00:00:00Z",
      }),
      stderr: "",
    }),
  );
  const events = (kind: string) =>
    (
      db
        .prepare("SELECT task_id FROM task_inbox WHERE kind=? ORDER BY id")
        .all(kind) as { task_id: number }[]
    ).map((row) => `t${row.task_id}`);
  await scheduler.tick();
  const plan = taskPlan(db).groups;
  assert.deepEqual(
    plan.waiting.map((item) => [item.task.ref, item.waiting_for]),
    [["t2", ["t1 上线"]]],
  );
  assert.deepEqual(
    plan.waiting[0]!.upstream.map((up) => up.release),
    ["waiting"],
  );
  // 状态栏的持球人也写清等谁上线。
  assert.equal(
    holderFor(
      db,
      db.prepare("SELECT * FROM tasks WHERE id=2").get() as never,
      null,
    )!.text,
    "等 t1 上线",
  );
  assert.deepEqual(events("ready"), ["t4"]);
  assert.equal(getTask(db, "t6").status, "blocked");
  assert.equal(getTask(db, "t6").schedule_reason, "上游 t5 上线失败");
  // t1 上线：t2 就绪并发一次事件。
  db.prepare(
    "UPDATE tasks SET delivery_stage='online',online_wait=0 WHERE id=1",
  ).run();
  noteTask(db, 1, "online", { version: "0.1.96" });
  // t5 后来补记上线（手动升级后回填）：t6 恢复。
  db.prepare("UPDATE tasks SET delivery_stage='online' WHERE id=5").run();
  noteTask(db, 5, "online_backfilled", { version: "0.1.96" });
  await scheduler.tick();
  assert.deepEqual(events("ready"), ["t4", "t2", "t6"]);
  assert.equal(getTask(db, "t6").status, "todo");
  inbox.close();
  db.close();
});
