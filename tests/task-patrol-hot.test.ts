import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { CI_PENDING_SQL, pollCiOnce } from "../server/tasks/ci-poll.ts";
import { SETTLE_REVIEWS_SQL } from "../server/tasks/concern-runtime.ts";
import { CLOSE_STALE_SQL } from "../server/tasks/council-runtime.ts";
import { DiskBudget } from "../server/tasks/disk-budget.ts";
import type { Exec } from "../server/tasks/git.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";
import { NEXT_MERGE } from "../server/tasks/merge-runtime.ts";
import { LEGACY_ONLINE_SQL } from "../server/tasks/online-backfill.ts";
import { OnlineWatch } from "../server/tasks/online-runtime.ts";
import { skipIfBusy } from "../server/tasks/reentry.ts";
import { TaskRunner } from "../server/tasks/runner.ts";
import {
  CLEANUP_PAGE_SQL,
  cleanupBackoffMs,
  WorktreeCleanup,
} from "../server/tasks/worktree-cleanup.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import { removeTemp } from "./temp-dir.ts";

function planOf(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
      detail: string;
    }[]
  )
    .map((row) => row.detail)
    .join("\n");
}

function fillDone(db: DatabaseSync, n: number) {
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO tasks(title,deliver,status,created_at,updated_at) VALUES ('x','none','done',?,?)",
  );
  for (let i = 0; i < n; i++) insert.run(now, now);
}

test("合入队、清理、上线回填、CI、专员：查询计划不按状态扫全部已完成任务", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  fillDone(db, 80);
  createTask(db, { title: "合入" });
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merge_queued',merge_queued_at=1 WHERE title='合入'",
  ).run();
  createTask(db, { title: "清理" });
  db.prepare(
    "UPDATE tasks SET status='cancelled',repo='/r',worktree='/w' WHERE title='清理'",
  ).run();
  for (const [name, plan] of [
    ["合入", planOf(db, NEXT_MERGE)],
    ["清理", planOf(db, CLEANUP_PAGE_SQL, 0, 0)],
    ["上线回填", planOf(db, LEGACY_ONLINE_SQL, 0)],
    ["CI", planOf(db, CI_PENDING_SQL, 10)],
    ["专员", planOf(db, SETTLE_REVIEWS_SQL, 50)],
    ["会审", planOf(db, CLOSE_STALE_SQL, 50)],
  ] as const) {
    assert.doesNotMatch(
      plan,
      /tasks_status/,
      `${name} 不应走 tasks_status\n${plan}`,
    );
  }
  assert.match(
    planOf(db, NEXT_MERGE),
    /tasks_delivery_stage|tasks_merge_queue/,
  );
  assert.match(planOf(db, CLEANUP_PAGE_SQL, 0, 0), /tasks_cleanup_cancelled/);
  assert.match(planOf(db, CLEANUP_PAGE_SQL, 0, 0), /tasks_cleanup_done/);
  assert.match(planOf(db, LEGACY_ONLINE_SQL, 0), /tasks_online_legacy/);
  assert.match(planOf(db, CI_PENDING_SQL, 10), /tasks_ci_pending/);
  assert.match(planOf(db, CLOSE_STALE_SQL, 50), /task_councils_stage/);
  assert.match(
    planOf(db, SETTLE_REVIEWS_SQL, 50),
    /task_concerns|INTEGER PRIMARY KEY/,
  );
  db.close();
});

test("没配磁盘份额不起 du；有份额才巡 worktree", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  const dir = mkdtempSync(join(tmpdir(), "atrium-du-"));
  t.after(() => removeTemp(dir));
  const task = createTask(db, { title: "盘" });
  db.prepare("UPDATE tasks SET worktree=? WHERE id=?").run(dir, task.id);
  const du: string[] = [];
  const disk = new DiskBudget(db, async (path) => {
    du.push(path);
    return 0.01;
  });
  await disk.refresh();
  assert.equal(du.length, 0);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  editDoc(
    db,
    `o${root.id}`,
    "charter",
    { fields: {}, body: "", budget: { disk: 10 }, reason: "磁盘限额" },
    "u1",
  );
  await disk.refresh();
  assert.equal(du.length, 1);
});

test("别的仓库合入任务回填一次即记下，第二轮不再起 git", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const now = Date.now();
  for (let i = 0; i < 3; i++)
    db.prepare(
      "INSERT INTO tasks(title,repo,deliver,status,delivery_stage,online_wait,merge_commit,created_at,updated_at) VALUES ('旧','/other','pr','done','merged',0,'abc',?,?)",
    ).run(now, now);
  const calls: string[][] = [];
  const run: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args.includes("get-url"))
      return {
        ok: true,
        stdout: "https://github.com/other/project.git\n",
        stderr: "",
      };
    return { ok: false, stdout: "", stderr: "no" };
  };
  const watch = new OnlineWatch(db, {
    run,
    version: () => "0.1.0",
    selfUpdate: true,
    selfRepo: "acme/demo",
    busy: () => false,
    deploy: async () => ({ ok: true }),
    publish: () => {},
    changed: () => {},
  });
  await watch.tick();
  const git1 = calls.filter((call) => call[0] === "git").length;
  assert.equal(git1, 1);
  const checked = db
    .prepare("SELECT COUNT(*) n FROM tasks WHERE online_checked_at IS NOT NULL")
    .get() as { n: number };
  assert.equal(checked.n, 3);
  calls.length = 0;
  await watch.tick();
  assert.equal(calls.filter((call) => call[0] === "git").length, 0);
  db.close();
});

test("清理失败按连败退避，窗口内不再起 git", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const task = createTask(db, { title: "清" });
  db.prepare(
    "UPDATE tasks SET status='cancelled',repo='/r',worktree='/w' WHERE id=?",
  ).run(task.id);
  let now = 1_000;
  let git = 0;
  const cleanup = new WorktreeCleanup(
    db,
    async () => {
      git++;
      return { ok: false, stdout: "", stderr: "fail" };
    },
    () => false,
    () => now,
  );
  await cleanup.finished();
  assert.equal(git, 1);
  await cleanup.finished();
  assert.equal(git, 1);
  now += cleanupBackoffMs(1) - 1;
  await cleanup.finished();
  assert.equal(git, 1);
  now += 2;
  await cleanup.finished();
  assert.equal(git, 2);
  db.close();
});

test("CI 仍 pending 的让出批次，后面的能轮到", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const asked: string[] = [];
  const run: Exec = async (_command, args) => {
    asked.push(args[2]!);
    return {
      ok: true,
      stdout: JSON.stringify([{ name: "check", bucket: "pending" }]),
      stderr: "",
    };
  };
  for (let n = 1; n <= 12; n++) {
    const task = createTask(db, { title: `c${n}` });
    db.prepare(
      "UPDATE tasks SET status='blocked',pr_url=?,ci='pending' WHERE id=?",
    ).run(`https://github.com/o/r/pull/${n}`, task.id);
  }
  await pollCiOnce(db, 5, run);
  assert.deepEqual(
    asked.map((url) => url.slice(-2)),
    ["/1", "/2", "/3", "/4", "/5"],
  );
  asked.length = 0;
  await pollCiOnce(db, 5, run);
  assert.deepEqual(
    asked.map((url) => url.slice(-2)),
    ["/6", "/7", "/8", "/9", "10"],
  );
  asked.length = 0;
  await pollCiOnce(db, 5, run);
  assert.ok(asked.some((url) => url.endsWith("/11")));
  assert.ok(asked.some((url) => url.endsWith("/12")));
  db.close();
});

test("skipIfBusy：上一轮没完不叠下一轮", async () => {
  let entered = 0;
  let concurrent = 0;
  let max = 0;
  const fn = skipIfBusy(async () => {
    entered++;
    concurrent++;
    max = Math.max(max, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 40));
    concurrent--;
  });
  await Promise.all([fn(), fn(), fn()]);
  assert.equal(entered, 1);
  assert.equal(max, 1);
  await fn();
  assert.equal(entered, 2);
});

test("定时巡检不重入：慢一轮不叠 du", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-reentry-"));
  t.after(() => removeTemp(root));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  const org = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  editDoc(
    db,
    `o${org.id}`,
    "charter",
    { fields: {}, body: "", budget: { disk: 10 }, reason: "磁盘限额" },
    "u1",
  );
  for (let i = 0; i < 5; i++) {
    const task = createTask(db, { title: `w${i}` });
    db.prepare("UPDATE tasks SET worktree=? WHERE id=?").run(
      `/tree/${i}`,
      task.id,
    );
  }
  let inflight = 0;
  let max = 0;
  const runner = new TaskRunner(db, {
    data: root,
    env: { PATH: "/usr/bin:/bin" },
    tickMs: 20,
    ciPollMs: 60_000,
    diskDu: async () => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inflight--;
      return 0.01;
    },
    exec: async () => ({ ok: true, stdout: "", stderr: "" }),
    online: { pollMs: 60_000, selfRepo: null },
  });
  t.after(() => runner.close());
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(max, 5, "同一轮五个 du 并行，不叠下一轮");
});
