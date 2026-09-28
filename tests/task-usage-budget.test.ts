import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  beginUsage,
  endUsage,
  resetAt,
  sameWindow,
  splitDelta,
} from "../server/tasks/usage.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
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
