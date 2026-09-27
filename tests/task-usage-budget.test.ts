import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { addNode, editDoc } from "../server/org/write.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { tree } from "../server/org/read.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";
import { beginUsage, endUsage, splitDelta } from "../server/tasks/usage.ts";
import { quotaHeadroom } from "../server/tasks/usage-budget.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
import { DiskBudget } from "../server/tasks/disk-budget.ts";
import { startApp } from "./task-fixture.ts";

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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  const disk = new DiskBudget(db, dir);
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
  await assert.rejects(disk.check(project.id), /低于章程下限 100000 GB/);
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
