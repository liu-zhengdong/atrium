import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  getTask,
  noteTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { EventInbox } from "../server/tasks/events.ts";
import {
  CANDIDATES_SQL,
  classify,
  PLAN_PAGE_SQL,
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
import {
  backoffMs,
  upstreamDueQuery,
} from "../server/tasks/schedule-refresh.ts";
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
          state: merged ? "MERGED" : "OPEN",
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
    "state,mergedAt",
  ]);
  db.prepare(
    "UPDATE task_pr_dependencies SET checked_at=NULL,next_check_at=NULL",
  ).run();
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
  db.prepare("UPDATE task_pr_merge SET checked_at=0,next_check_at=NULL").run();
  state = "MERGED";
  await scheduler.tick();
  assert.equal(dispatched, 1);
  // 合入后不再查。
  db.prepare("UPDATE task_pr_merge SET checked_at=0,next_check_at=NULL").run();
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
  db.prepare("UPDATE task_pr_merge SET checked_at=0,next_check_at=NULL").run();
  await scheduler.tick();
  assert.equal(getTask(db, "t2").status, "blocked");
  ok = true;
  state = "MERGED";
  db.prepare("UPDATE task_pr_merge SET checked_at=0,next_check_at=NULL").run();
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

/** 造一个交付 PR、已 done 的上游；用于巡检刷新测试。 */
function donePrTask(db: DatabaseSync, url = "https://github.com/o/r/pull/7") {
  createTask(db, { title: "A", deliver: "pr" });
  db.prepare("UPDATE tasks SET status='done',pr_url=? WHERE id=1").run(url);
}

test("巡检上游查询走依赖索引，不按状态扫全部已完成任务", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  donePrTask(db);
  createTask(db, { title: "B", after: "t1" });
  const plan = (
    db.prepare("EXPLAIN QUERY PLAN " + upstreamDueQuery(1)).all(1, 0) as {
      detail: string;
    }[]
  )
    .map((row) => row.detail)
    .join("\n");
  assert.match(plan, /task_dependencies.*\(task_id=\?\)/);
  assert.doesNotMatch(plan, /tasks_status/);
  assert.doesNotMatch(plan, /SCAN t\b/);
  db.close();
});

test("上游本地已合入：不调 gh，下游立即就绪", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  donePrTask(db);
  db.prepare("UPDATE tasks SET delivery_stage='merged' WHERE id=1").run();
  createTask(db, { title: "B", after: "t1", auto: true });
  let calls = 0;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      calls++;
      return { ok: true, stdout: "{}", stderr: "" };
    },
  );
  await scheduler.tick();
  assert.equal(calls, 0);
  assert.equal(taskPlan(db).groups.ready[0]!.task.ref, "t2");
  inbox.close();
  db.close();
});

test("多个下游共用同一上游 PR，一轮只查一次", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  donePrTask(db);
  createTask(db, { title: "B", after: "t1", auto: true });
  createTask(db, { title: "C", after: "t1", auto: true });
  let calls = 0;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      calls++;
      return {
        ok: true,
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null }),
        stderr: "",
      };
    },
  );
  await scheduler.tick(1_000_000);
  assert.equal(calls, 1);
  inbox.close();
  db.close();
});

test("查不到的 PR 按连败退避，不再每分钟空转", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  donePrTask(db);
  createTask(db, { title: "B", after: "t1" });
  let calls = 0;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      calls++;
      return { ok: false, stdout: "", stderr: "no such PR" };
    },
  );
  const t0 = 1_000_000;
  await scheduler.tick(t0);
  assert.equal(calls, 1);
  // 退避窗口内不查。
  await scheduler.tick(t0 + 30_000);
  assert.equal(calls, 1);
  // 连败一次退避 1 分钟，到点再查并把窗口翻倍。
  await scheduler.tick(t0 + 61_000);
  assert.equal(calls, 2);
  await scheduler.tick(t0 + 61_000 + 60_000);
  assert.equal(calls, 2);
  await scheduler.tick(t0 + 61_000 + 121_000);
  assert.equal(calls, 3);
  assert.equal(backoffMs(2), 120_000);
  inbox.close();
  db.close();
});

test("外部 PR 查不到也退避，不再每分钟空转", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, { title: "A", after_pr: "o/r#5" });
  let calls = 0;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      calls++;
      return { ok: false, stdout: "", stderr: "no such PR" };
    },
  );
  const t0 = 1_000_000;
  await scheduler.tick(t0);
  assert.equal(calls, 1);
  await scheduler.tick(t0 + 30_000);
  assert.equal(calls, 1);
  await scheduler.tick(t0 + 61_000);
  assert.equal(calls, 2);
  inbox.close();
  db.close();
});

test("外部 PR 已关闭也退避，不再每分钟查", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, { title: "A", after_pr: "o/r#5" });
  let calls = 0;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      calls++;
      return {
        ok: true,
        stdout: JSON.stringify({ state: "CLOSED", mergedAt: null }),
        stderr: "",
      };
    },
  );
  const t0 = 1_000_000;
  await scheduler.tick(t0);
  assert.equal(calls, 1);
  const row = db
    .prepare(
      "SELECT merged,error,attempts,next_check_at FROM task_pr_dependencies",
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...row },
    { merged: 0, error: null, attempts: 1, next_check_at: t0 + backoffMs(1) },
  );
  await scheduler.tick(t0 + 61_000);
  assert.equal(calls, 2);
  // 第二次仍关闭：退避翻倍，一分钟后不再查。
  await scheduler.tick(t0 + 61_000 + 61_000);
  assert.equal(calls, 2);
  await scheduler.tick(t0 + 61_000 + backoffMs(2) + 1_000);
  assert.equal(calls, 3);
  inbox.close();
  db.close();
});

test("上游换新 PR 后不再被旧 PR 的退避挡住", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  donePrTask(db);
  createTask(db, { title: "B", after: "t1" });
  let calls = 0;
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      calls++;
      return {
        ok: true,
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null }),
        stderr: "",
      };
    },
  );
  const t0 = 1_000_000;
  await scheduler.tick(t0);
  assert.equal(calls, 1);
  // 旧 PR #7 被关，退避 12 小时、连败 11 次。
  db.prepare(
    "UPDATE task_pr_merge SET state='closed',next_check_at=?,attempts=11",
  ).run(t0 + 12 * 60 * 60_000);
  // 任务返工后又交了新 PR #8，不该被旧 PR 的退避挡住。
  db.prepare(
    "UPDATE tasks SET pr_url='https://github.com/o/r/pull/8' WHERE id=1",
  ).run();
  await scheduler.tick(t0 + 1_000);
  assert.equal(calls, 2);
  assert.equal(taskPlan(db).groups.waiting.length, 1);
  inbox.close();
  db.close();
});

test("外部 PR 查询失败不把别处已合入的记录改回未合入", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, { title: "A", after_pr: "o/r#5" });
  createTask(db, { title: "B", after_pr: "o/r#5" });
  // A 已从别处记下该 PR 合入。
  db.prepare("UPDATE task_pr_dependencies SET merged=1 WHERE task_id=1").run();
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => ({ ok: false, stdout: "", stderr: "网络错误" }),
  );
  await scheduler.tick(1_000_000);
  const rows = db
    .prepare("SELECT task_id,merged FROM task_pr_dependencies ORDER BY task_id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { task_id: 1, merged: 1 },
    { task_id: 2, merged: 0 },
  ]);
  inbox.close();
  db.close();
});

test("gh 查询期间任务被启动：不把运行中的任务误标受阻", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  createTask(db, { title: "A" });
  createTask(db, { title: "B", after: "t1" });
  db.prepare(
    "UPDATE tasks SET status='done',pr_url='https://github.com/o/r/pull/9' WHERE id=1",
  ).run();
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      // 巡检查 gh 的同时，t2 被启动（状态 todo→running）。
      advanceTask(db, "t2", { kind: "start" });
      return {
        ok: true,
        stdout: JSON.stringify({ state: "CLOSED" }),
        stderr: "",
      };
    },
  );
  await scheduler.tick();
  assert.equal(getTask(db, "t2").status, "running");
  inbox.close();
  db.close();
});

test("稳态巡检语句数不随候选数线性增长", async () => {
  const statementsPerTick = async (count: number) => {
    const db = new DatabaseSync(":memory:");
    ensureTaskTables(db);
    const inbox = new EventInbox(db);
    for (let i = 0; i < count; i++)
      createTask(db, { title: `T${i}`, auto: true });
    // 稳态：候选都已派过、排期状态就是 ready，本轮没有状态迁移也没有派发。
    db.prepare(
      "UPDATE tasks SET auto_dispatched=1,schedule_state='ready',schedule_reason=NULL",
    ).run();
    let statements = 0;
    const real = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
      configurable: true,
      writable: true,
      value: (...args: Parameters<typeof real>) => {
        statements++;
        return real(...args);
      },
    });
    const scheduler = new Scheduler(
      db,
      inbox,
      async () => {},
      async () => ({ ok: true, stdout: "{}", stderr: "" }),
    );
    await scheduler.tick(1_000_000);
    inbox.close();
    db.close();
    return statements;
  };
  assert.equal(await statementsPerTick(150), await statementsPerTick(50));
});

test("巡检进行中关闭：1 秒内返回", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  donePrTask(db);
  createTask(db, { title: "B", after: "t1" });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new Scheduler(
    db,
    inbox,
    async () => {},
    async () => {
      await gate;
      return { ok: true, stdout: "{}", stderr: "" };
    },
  );
  const running = scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const start = Date.now();
  scheduler.close();
  await Promise.race([
    running,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("关闭后巡检未及时返回")), 1_000),
    ),
  ]);
  assert.ok(Date.now() - start < 1_000);
  release();
  inbox.close();
  db.close();
});

test("巡检候选与 plan 走未结束任务的部分索引，不按主键扫已完成任务", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const now = Date.now();
  const done = db.prepare(
    "INSERT INTO tasks(title,deliver,status,created_at,updated_at) VALUES ('x','none',?,?,?)",
  );
  for (let i = 0; i < 300; i++)
    done.run(i % 10 ? "done" : "cancelled", now, now);
  createTask(db, { title: "A", auto: true });
  createTask(db, { title: "B", after: "t301" });
  for (const [name, sql, params] of [
    ["巡检候选", CANDIDATES_SQL, [0]],
    ["plan", PLAN_PAGE_SQL, [0, 200]],
  ] as const) {
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
        detail: string;
      }[]
    )
      .map((row) => row.detail)
      .join("\n");
    assert.match(
      plan,
      /SEARCH tasks USING (COVERING )?INDEX tasks_open/,
      `${name}\n${plan}`,
    );
    assert.doesNotMatch(plan, /TEMP B-TREE/, `${name} 不该另排序\n${plan}`);
  }
  // 候选只有未结束的两条；已完成、已取消的不在结果里。
  assert.deepEqual(
    (db.prepare(CANDIDATES_SQL).all(0) as { id: number }[]).map(
      (row) => row.id,
    ),
    [301, 302],
  );
  db.close();
});

test("失败后排期标了受阻的任务能直接 task run 重派；上游失败的仍拒（t227）", async (t) => {
  const { call, app } = await startApp(t);
  const patch = (id: string, status: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      payload: { status },
      headers: { host: "127.0.0.1" },
    });
  await call("POST", "/api/tasks", { title: "上游", deliver: "none" });
  await call("POST", "/api/tasks", {
    title: "自己失败",
    after: "t1",
    deliver: "none",
  });
  await call("POST", "/api/tasks", { title: "坏上游", deliver: "none" });
  await call("POST", "/api/tasks", {
    title: "下游",
    after: "t3",
    deliver: "none",
  });
  assert.equal((await patch("t1", "done")).statusCode, 200);
  assert.equal((await patch("t2", "failed")).statusCode, 200);
  assert.equal((await patch("t3", "failed")).statusCode, 200);
  // 巡检把失败的 t2 标成排期受阻（原因「任务失败」），与线上 t194 一样。
  await eventually(async () => {
    const task = (await call("GET", "/api/tasks/t2")).body;
    return task.schedule_state === "blocked";
  });
  const rerun = await call("POST", "/api/tasks/t2/run", {});
  assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
  assert.ok(
    ["running", "done", "todo"].includes(rerun.body.task.status),
    rerun.body.task.status,
  );
  const downstream = await call("POST", "/api/tasks/t4/run", {});
  assert.equal(downstream.status, 409);
  assert.match(downstream.body.error, /依赖未就绪：上游 t3/);
  await call("GET", "/api/tasks/t2/wait?timeout=20");
});
