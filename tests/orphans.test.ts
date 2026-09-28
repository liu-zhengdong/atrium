import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readEnv } from "../server/platform/cpu.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  markTask,
  OrphanReaper,
  orphanKills,
  orphanTasks,
  spawnMark,
  spawnOwner,
} from "../server/tasks/orphans.ts";
import type { StopSignal } from "../server/platform/plan.ts";

const owner = "0123456789ab";
const other = "ba9876543210";

test("执行者标记：服务标识按数据目录区分、同一目录不变；只认本服务、格式对的标记", () => {
  const a = spawnOwner("/tmp/atrium-a");
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(spawnOwner("/tmp/atrium-a"), a);
  assert.notEqual(spawnOwner("/tmp/atrium-b"), a);
  assert.equal(spawnMark(owner, 42), `${owner}/t42`);
  assert.equal(markTask(`${owner}/t42`, owner), 42);
  for (const bad of [
    `${other}/t42`,
    `${owner}/t0`,
    `${owner}/42`,
    `${owner}/t42/x`,
    `${owner}/t-1`,
    "",
    `x${owner}/t42`,
  ])
    assert.equal(markTask(bad, owner), null, bad);
});

test("孤儿清理判定：任务结束满 30 分钟才结束进程；先温和、1 分钟后还在再强制；别的服务的、没结束的不动", () => {
  const minute = 60_000;
  const now = 1_000 * minute;
  const orphans = [
    { pid: 11, mark: spawnMark(owner, 1) }, // 结束 12 小时
    { pid: 12, mark: spawnMark(owner, 2) }, // 刚结束 10 分钟
    { pid: 13, mark: spawnMark(owner, 3) }, // 还在跑（不在 ended 里）
    { pid: 14, mark: spawnMark(other, 1) }, // 别的服务
    { pid: 15, mark: "乱写" },
    { pid: 16, mark: spawnMark(owner, 1) }, // 已温和结束过，还没到 1 分钟
    { pid: 17, mark: spawnMark(owner, 1) }, // 已温和结束过 2 分钟还在
  ];
  const ended = new Map([
    [1, now - 720 * minute],
    [2, now - 10 * minute],
  ]);
  const tried = new Map([
    [16, now - 30_000],
    [17, now - 2 * minute],
  ]);
  assert.deepEqual(orphanKills({ orphans, owner, ended, now, tried }), [
    { pid: 11, task: 1, signal: "SIGTERM" },
    { pid: 17, task: 1, signal: "SIGKILL" },
  ]);
  assert.deepEqual(
    orphanKills({ orphans, owner, ended, now: now + 25 * minute }).map(
      (kill) => kill.pid,
    ),
    [11, 12, 16, 17],
  );
  assert.deepEqual(orphanKills({ orphans: [], owner, ended, now }), []);
  assert.deepEqual(orphanTasks(orphans, owner), [1, 2, 3]);
  assert.deepEqual(orphanTasks(orphans, owner, 2), [1, 2]);
});

test("巡检清孤儿：按账本判任务结束，记日志；温和结束后还在再强制，进程没了就忘掉", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const minute = 60_000;
  const now = 10_000 * minute;
  const insert = db.prepare(
    "INSERT INTO tasks (title, status, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("早已完成", "done", 0, 0, now - 600 * minute); // t1
  insert.run("在跑", "running", 0, 0, null); // t2
  insert.run("刚失败", "failed", 0, 0, now - 5 * minute); // t3
  insert.run("取消了", "cancelled", 0, 0, now - 60 * minute); // t4
  const killed: [number, StopSignal][] = [];
  const logs: string[] = [];
  const reaper = new OrphanReaper(
    db,
    owner,
    (pid, signal) => killed.push([pid, signal]),
    (line) => logs.push(line),
  );
  const orphans = [1, 2, 3, 4, 99].map((task) => ({
    pid: 100 + task,
    mark: spawnMark(owner, task),
  }));
  assert.deepEqual(
    reaper.sweep(orphans, now).map((kill) => kill.pid),
    [101, 104],
  );
  assert.deepEqual(killed, [
    [101, "SIGTERM"],
    [104, "SIGTERM"],
  ]);
  assert.match(logs[0]!, /清理孤儿进程 101：t1 已结束 600 分钟/);
  // 下一轮：101 已退出，104 还在但没到 1 分钟。
  killed.length = 0;
  const left = orphans.filter((orphan) => orphan.pid !== 101);
  assert.deepEqual(reaper.sweep(left, now + 5_000), []);
  assert.deepEqual(reaper.sweep(left, now + 61_000), [
    { pid: 104, task: 4, signal: "SIGKILL" },
  ]);
  assert.match(logs.at(-1)!, /强制结束/);
  // 101 如果又出现（pid 复用成另一个带标记的孤儿），从温和结束重新开始。
  killed.length = 0;
  reaper.sweep(orphans, now + 70_000);
  assert.deepEqual(killed[0], [101, "SIGTERM"]);
  assert.deepEqual(reaper.sweep([], now), []);
});

test("本机实测：读得到自己起的子进程的标记环境变量（Windows 读不到为 null）", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
    stdio: "ignore",
    env: { ...process.env, ATRIUM_SPAWN: spawnMark(owner, 7) },
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));
  const found = await readEnv([child.pid!, 999_999_9], "ATRIUM_SPAWN");
  if (process.platform === "win32") {
    assert.equal(found, null);
    return;
  }
  assert.equal(found?.get(child.pid!), spawnMark(owner, 7));
  assert.equal(found?.has(999_999_9), false);
});
