import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger/ledger.ts";
import {
  beginUsage,
  endUsage,
  resetAt,
  sameWindow,
  splitDelta,
} from "../server/tasks/quota/usage.ts";
import { quotaHeadroom } from "../server/tasks/quota/usage-budget.ts";
import { pickWorker } from "../server/tasks/dispatch/prepare.ts";
import { WorktreeCleanup } from "../server/tasks/merge/worktree-cleanup.ts";
import { fixture } from "./task-fixture.ts";

const pace = (usedPercent: number, hoursToReset = 1) => [
  {
    providerId: "kimi",
    usedPercent,
    sparePercent: 90 - usedPercent,
    hoursToReset,
  },
];

test("用量快照按同窗口增量记账，并行时平分；重置时刻跨过取整边界仍算同窗口；富余取最紧的窗口", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  // 开始时的重置时刻离取整半界差 500 毫秒，结束时已跨到下一个桶。
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
  assert.equal(sameWindow(0, 300_000), true);
  assert.equal(sameWindow(0, 300_001), false);
  assert.equal(sameWindow(18_000_000, 0), false);
  assert.deepEqual(splitDelta(15, 14, 2), { points: 0, basis: "unknown" });
  const room = quotaHeadroom(
    [
      { providerId: "kimi", usedPercent: 79.5, sparePercent: 0 },
      { providerId: "kimi", usedPercent: 78, sparePercent: 0 },
    ],
    20,
  ).get("kimi")!;
  assert.equal(room.points, 0.5);
  assert.match(room.reason, /已用 79.5%，须给用户保留 20%/);
  assert.equal(quotaHeadroom(undefined, 20).size, 0);
});

test("挑人：富余用尽跳过并换人；跳过 metered；pace 缺失不挡", () => {
  const inputs = {
    installed: ["kimi", "grok"] as const,
    risk: "low" as const,
    profiles: {},
    pace: [
      { providerId: "kimi", usedPercent: 10, sparePercent: 50 },
      { providerId: "grok", usedPercent: 10, sparePercent: 20 },
    ],
    headroom: new Map([["kimi", { points: 0.5, reason: "账号已用尽保留线" }]]),
  };
  const picked = pickWorker(inputs);
  assert.equal(picked.ok && picked.tool, "grok");
  assert.match(picked.skipped.find((s) => s.tool === "kimi")!.reason, /保留线/);
  const all = pickWorker({
    ...inputs,
    headroom: new Map([
      ...inputs.headroom,
      ["grok", { points: 0, reason: "账号已用尽保留线" }],
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

test("清理已结束任务的工作树：已合入与已取消的清掉，受阻任务保留", async (t) => {
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
  await cleanup.finished();
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
});
