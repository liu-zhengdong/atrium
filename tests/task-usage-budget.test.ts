import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { addNode, editDoc } from "../server/org/write.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { tree } from "../server/org/read.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  beginUsage,
  endUsage,
  resetAt,
  sameWindow,
  splitDelta,
} from "../server/tasks/usage.ts";
import { quotaHeadroom } from "../server/tasks/usage-budget.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
import { DiskBudget } from "../server/tasks/disk-budget.ts";
import { WorktreeCleanup } from "../server/tasks/worktree-cleanup.ts";
import { fixture, startApp } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

const pace = (usedPercent: number, hoursToReset = 1) => [
  {
    providerId: "kimi",
    usedPercent,
    sparePercent: 90 - usedPercent,
    hoursToReset,
  },
];

test("用量快照按同窗口增量记账，并行时平分；节点子树约用进入份额判断", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "game",
      kind: "project",
      name: "游戏",
      reason: "建树",
    },
    "u1",
  );
  const module = addNode(
    db,
    {
      parent: `o${project.id}`,
      slug: "physics",
      kind: "module",
      name: "物理",
      reason: "建树",
    },
    "u1",
  );
  editDoc(
    db,
    `o${project.id}`,
    "charter",
    { fields: {}, body: "", budget: { quota: { kimi: 1 } }, reason: "分份额" },
    "u1",
  );
  const a = createTask(db, { title: "A", role: `o${module.id}` });
  const b = createTask(db, { title: "B", role: `o${module.id}` });
  const now = Date.now();
  beginUsage(db, a.id, "kimi", pace(10), now);
  beginUsage(db, b.id, "kimi", pace(10), now + 1);
  endUsage(db, a.id, "kimi", pace(12, 1 - 1000 / 3_600_000), now + 1000);
  endUsage(db, b.id, "kimi", pace(12, 1 - 1001 / 3_600_000), now + 1001);
  const rows = db
    .prepare("SELECT points,basis FROM task_usage ORDER BY task_id")
    .all() as { points: number; basis: string }[];
  assert.deepEqual(
    rows.map((r) => r.basis),
    ["split", "split"],
  );
  assert.deepEqual(
    rows.map((r) => r.points),
    [1, 1],
  );
  const room = quotaHeadroom(db, module.id, pace(12), 20, now + 1001).get(
    "kimi",
  )!;
  assert.equal(room.points, -1);
  assert.match(room.reason, /o2 游戏.*份额 1.*已用约 2/);
  const view = tree(db, pace(12)).find((n) => n.id === module.id)!.budget!;
  assert.equal(view.quota.find((q) => q.scope === "kimi")?.used, 2);
  assert.equal(
    quotaHeadroom(
      db,
      null,
      [
        { providerId: "kimi", usedPercent: 79.5, sparePercent: 0 },
        { providerId: "kimi", usedPercent: 78, sparePercent: 0 },
      ],
      20,
    ).get("kimi")?.points,
    0.5,
  );
  assert.deepEqual(splitDelta(15, 14, 2), { points: 0, basis: "unknown" });
});

test("重置时刻跨过五分钟取整边界：仍按同窗口平分记账并计入子树份额", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  editDoc(
    db,
    `o${root.id}`,
    "charter",
    { fields: {}, body: "", budget: { quota: { kimi: 1 } }, reason: "分份额" },
    "u1",
  );
  const a = createTask(db, { title: "A", role: `o${root.id}` });
  const b = createTask(db, { title: "B", role: `o${root.id}` });
  // 开始时的重置时刻离取整半界差 500 毫秒，结束与判断时已跨到下一个桶。
  const now = 1_800_000_000_000 + 150_000 - 3_600_000 - 500;
  assert.notEqual(resetAt(pace(10)[0], now), resetAt(pace(12)[0], now + 1001));
  beginUsage(db, a.id, "kimi", pace(10), now);
  beginUsage(db, b.id, "kimi", pace(10), now + 1);
  endUsage(db, a.id, "kimi", pace(12), now + 1000);
  endUsage(db, b.id, "kimi", pace(12), now + 1001);
  const rows = db
    .prepare("SELECT points,basis FROM task_usage ORDER BY task_id")
    .all() as { points: number; basis: string }[];
  assert.deepEqual(
    rows.map((r) => [r.basis, r.points]),
    [
      ["split", 1],
      ["split", 1],
    ],
  );
  const room = quotaHeadroom(db, root.id, pace(12), 20, now + 1001).get(
    "kimi",
  )!;
  assert.equal(room.points, -1);
  assert.equal(sameWindow(0, 300_000), true);
  assert.equal(sameWindow(0, 300_001), false);
  assert.equal(sameWindow(18_000_000, 0), false);
});

test("挑人：份额用尽跳过并换人；钱为零时跳过 metered；pace 缺失不挡份额", () => {
  const inputs = {
    installed: ["kimi", "grok"] as const,
    risk: "low" as const,
    profiles: {},
    pace: [
      { providerId: "kimi", usedPercent: 10, sparePercent: 50 },
      { providerId: "grok", usedPercent: 10, sparePercent: 20 },
    ],
    headroom: new Map([["kimi", { points: 0.5, reason: "o2 份额已用约 1" }]]),
  };
  const picked = pickWorker(inputs);
  assert.equal(picked.ok && picked.tool, "grok");
  assert.match(picked.skipped.find((s) => s.tool === "kimi")!.reason, /份额/);
  const all = pickWorker({
    ...inputs,
    headroom: new Map([
      ...inputs.headroom,
      ["grok", { points: 0, reason: "o2 份额已用约 1" }],
    ]),
  });
  assert.equal(all.ok, false);
  const missing = pickWorker({ ...inputs, pace: undefined });
  assert.equal(missing.ok && missing.tool, "grok");
  const metered = pickWorker({
    ...inputs,
    headroom: new Map(),
    profiles: {
      grok: {
        rules: { billing: "metered" },
        body: "",
        layers: [],
        warnings: [],
      },
    },
  });
  assert.equal(metered.ok && metered.tool, "kimi");
});

test("磁盘：生效下限与节点 worktree 份额在派活前拒绝", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  const dir = mkdtempSync(join(tmpdir(), "atrium-disk-budget-"));
  t.after(() => removeTemp(dir));
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "game",
      kind: "project",
      name: "游戏",
      reason: "建树",
    },
    "u1",
  );
  const task = createTask(db, { title: "A", role: `o${project.id}` });
  writeFileSync(join(dir, "work.txt"), "hello");
  db.prepare("UPDATE tasks SET worktree=? WHERE id=?").run(dir, task.id);
  editDoc(
    db,
    `o${project.id}`,
    "charter",
    { fields: {}, body: "", budget: { disk: 0 }, reason: "磁盘限额" },
    "u1",
  );
  let free = 1000;
  const disk = new DiskBudget(db, dir, async () => free);
  await assert.rejects(
    disk.check(project.id),
    /磁盘份额 0 GB.*worktree 已占约/,
  );
  editDoc(
    db,
    `o${root.id}`,
    "charter",
    {
      fields: {},
      body: "",
      boundaries: [
        {
          id: "disk-min",
          summary: "磁盘下限",
          param: { disk_min_free_gb: 100000 },
        },
      ],
      reason: "下限",
    },
    "u1",
  );
  free = 0;
  await assert.rejects(disk.check(project.id), /低于章程下限 100000 GB/);
});

test("磁盘不足先清已合入工作树并重查；受阻任务保留，仍不足才拦截", async (t) => {
  const fx = fixture(t);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  ensureOrgTables(db);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fx.repo, ...args], { encoding: "utf8" }).trim();
  const merged = createTask(db, { title: "已合入", repo: fx.repo });
  const blocked = createTask(db, { title: "受阻", repo: fx.repo });
  const cancelled = createTask(db, { title: "已取消", repo: fx.repo });
  const path = `${fx.repo}-merged`;
  const kept = `${fx.repo}-blocked`;
  const cancelledPath = `${fx.repo}-cancelled`;
  git("worktree", "add", "-q", "-b", "task-merged", path, "main");
  git("worktree", "add", "-q", "-b", "task-blocked", kept, "main");
  git("worktree", "add", "-q", "-b", "task-cancelled", cancelledPath, "main");
  writeFileSync(join(cancelledPath, "untracked.txt"), "unfinished");
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merged',worktree=?,branch=? WHERE id=?",
  ).run(path, "task-merged", merged.id);
  db.prepare(
    "UPDATE tasks SET status='blocked',worktree=?,branch=? WHERE id=?",
  ).run(kept, "task-blocked", blocked.id);
  db.prepare(
    "UPDATE tasks SET status='cancelled',worktree=?,branch=? WHERE id=?",
  ).run(cancelledPath, "task-cancelled", cancelled.id);
  const cleanup = new WorktreeCleanup(db);
  const disk = new DiskBudget(
    db,
    fx.repo,
    async () => (existsSync(path) ? 10 : 20),
    cleanup,
  );
  await disk.check(null, fx.repo);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(cancelledPath), false);
  assert.equal(existsSync(kept), true);
  assert.equal(git("branch", "--list", "task-merged"), "");
  assert.match(git("branch", "--list", "task-blocked"), /task-blocked/);
  assert.equal(
    (
      db.prepare("SELECT worktree FROM tasks WHERE id=?").get(merged.id) as {
        worktree: string | null;
      }
    ).worktree,
    null,
  );
  const low = new DiskBudget(db, fx.repo, async () => 10, cleanup);
  await assert.rejects(low.check(null, fx.repo), /低于章程下限 15 GB/);
});

test("磁盘清后仍不足：派活转 blocked 并通知秘书", async (t) => {
  const { call, taskRunner } = await startApp(
    t,
    undefined,
    undefined,
    undefined,
    async () => 0,
  );
  const created = await call("POST", "/api/tasks", { title: "磁盘不足" });
  const run = await call("POST", `/api/tasks/${created.body.ref}/run`, {});
  assert.equal(run.body.task.status, "blocked");
  assert.match(
    JSON.stringify(run.body.task.events),
    /budget_blocked.*磁盘可用/,
  );
  const inbox = await taskRunner.inbox.wait("secretary", 0);
  assert.equal(inbox.events[0]?.kind, "blocked");
  assert.match(JSON.stringify(inbox.events[0]?.detail), /磁盘可用/);
});

test("隔离运行时：份额用尽转 blocked 通知 leader；pace 不可用记事件并允许派活", async (t) => {
  let available = true;
  const { data, call } = await startApp(t, undefined, async () =>
    available ? pace(10) : undefined,
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "game",
      kind: "project",
      name: "游戏",
      leader: "a1",
      reason: "建树",
    },
    "u1",
  );
  const module = addNode(
    db,
    {
      parent: `o${project.id}`,
      slug: "physics",
      kind: "module",
      name: "物理",
      leader: "a1",
      reason: "建树",
    },
    "u1",
  );
  editDoc(
    db,
    `o${project.id}`,
    "charter",
    { fields: {}, body: "", budget: { quota: { kimi: 0 } }, reason: "用尽" },
    "u1",
  );
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "额度阻断",
        role: `o${module.id}`,
        owner: "u1",
      })
    ).status,
    201,
  );
  const blocked = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.task.status, "blocked");
  assert.match(JSON.stringify(blocked.body.task.events), /份额不足/);
  const notice = db
    .prepare(
      "SELECT subscriber,kind FROM task_inbox WHERE task_id=1 AND subscriber='a1'",
    )
    .get() as { subscriber: string; kind: string };
  assert.equal(notice.kind, "blocked");
  available = false;
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "额度未知",
        role: `o${module.id}`,
      })
    ).status,
    201,
  );
  const launched = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(launched.status, 200);
  const read = await call("GET", "/api/tasks/t2");
  assert.match(JSON.stringify(read.body.events), /budget_unknown/);
});

test("真实执行者生命周期采样：OpenQuota 已用上升时节点约用同向上升", async (t) => {
  let samples = 0;
  const { data, call } = await startApp(
    t,
    (fx) =>
      writeFileSync(
        join(fx.root, "bin", "kimi"),
        "#!/bin/sh\necho '采样完成'\n",
      ),
    async () => pace(10),
    async () => pace(samples++ === 0 ? 10 : 12),
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "game",
      kind: "project",
      name: "游戏",
      reason: "建树",
    },
    "u1",
  );
  editDoc(
    db,
    `o${project.id}`,
    "charter",
    { fields: {}, body: "", budget: { quota: { kimi: 10 } }, reason: "分份额" },
    "u1",
  );
  const before = tree(db, pace(10))
    .find((n) => n.id === project.id)!
    .budget!.quota.find((q) => q.scope === "kimi")!.used;
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "用量采样",
        role: `o${project.id}`,
        deliver: "none",
      })
    ).status,
    201,
  );
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "kimi" })).status,
    200,
  );
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(
    waited.body.task.status,
    "done",
    JSON.stringify(waited.body.task.events),
  );
  const usage = db
    .prepare("SELECT points,basis FROM task_usage WHERE task_id=1")
    .get() as { points: number; basis: string };
  assert.equal(usage.points, 2);
  assert.equal(usage.basis, "delta");
  const after = tree(db, pace(12))
    .find((n) => n.id === project.id)!
    .budget!.quota.find((q) => q.scope === "kimi")!.used;
  assert.equal(before, 0);
  assert.equal(after, 2);
});
