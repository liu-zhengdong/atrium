import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCwd, readEnv, snapshot } from "../server/platform/cpu.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  cwdTask,
  cwdTaskIds,
  markTask,
  OrphanReaper,
  orphanKills,
  orphanTasks,
  recognizer,
  spawnMark,
  spawnOwner,
  worktreesByPath,
  type TaskWorktree,
} from "../server/tasks/orphans.ts";
import { removeTemp } from "./temp-dir.ts";
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

test("按工作目录认任务（macOS）：往上找第一层工作树；有在跑的算在跑的；否则启动时刻落在起止之间、结束最晚的；认不准为 null", () => {
  const wt = "/Users/u/repo/atrium-t5";
  const rows: TaskWorktree[] = [
    { id: 5, worktree: wt, created: 1_000, ended: 5_000 },
    { id: 6, worktree: `${wt}/`, created: 4_000, ended: 9_000 }, // 同一工作树后来又派了一次
    { id: 7, worktree: "/Users/u/repo/atrium-t7", created: 1_000, ended: null },
    { id: 8, worktree: "/Users/u/repo/atrium-t7", created: 0, ended: 3_000 },
    {
      id: 9,
      worktree: "/var/folders/x/T/task-9/work",
      created: 0,
      ended: 10_000,
    },
    { id: 10, worktree: "/Users/u/repo", created: 0, ended: 10_000 }, // 上级目录也是某个任务的
  ];
  const byPath = worktreesByPath(rows);
  const cases: [string, number, number | null][] = [
    [wt, 2_000, 5],
    [`${wt}/.atrium`, 4_500, 6], // 两个都覆盖，取结束最晚的
    [`${wt}/node_modules/x`, 8_000, 6],
    [wt, 500, null], // 任务创建前就在的进程
    [wt, 9_001, null], // 任务结束后才起的
    ["/Users/u/repo/atrium-t7/sub", 2_000, 7], // 同一工作树有在跑的：算在跑的
    ["/private/var/folders/x/T/task-9/work", 5_000, 9], // lsof 给真实路径
    ["/Users/u/repo/atrium-t55", 5_000, 10], // 不在 t5 里（只是前缀像），落到上级
    ["/Users/u/repo", 20_000, null],
    ["/", 5_000, null],
    ["/Users", 5_000, null],
  ];
  for (const [cwd, start, task] of cases)
    assert.equal(cwdTask({ cwd, start }, byPath), task, `${cwd} @${start}`);
  assert.deepEqual(
    cwdTaskIds([
      "/Users/u/repo-t3-x-t12-fix/.atrium",
      "/Users/u/a-t4-t5-y",
      "/private/tmp/r-t12-z",
      "/Users/u/t9-no/-t0-x/-t7",
    ]),
    [3, 12, 4, 5],
  );
  assert.deepEqual(
    cwdTaskIds(["/a-t1-/b-t2-/c-t3-"], 2),
    [1, 2],
    "候选号有上限",
  );
});

function taskDb() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const insert = db.prepare(
    "INSERT INTO tasks (title, status, created_at, updated_at, ended_at, worktree, host_id, repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  return { db, insert };
}

test("macOS 认法：只看被 1 号收养、有启动时刻的进程，按工作目录与任务起止认，已清理的工作树按仓库与标题还原；远程主机的任务、查不了工作目录的不认", async () => {
  const { db, insert } = taskDb();
  const wt = (id: number, title: string) => `/Users/u/atrium-t${id}-${title}`;
  const repo = "/Users/u/atrium";
  insert.run("a", "done", 1_000, 0, 50_000, wt(1, "a"), null, repo); // t1
  insert.run("b", "running", 1_000, 0, null, wt(2, "b"), null, repo); // t2
  insert.run("c", "done", 1_000, 0, 50_000, wt(3, "c"), 2, repo); // t3：远程
  insert.run("d", "running", 1_000, 0, 40_000, wt(4, "d"), null, repo); // t4：重开过，旧的结束时刻不算
  insert.run("Fix CI", "done", 1_000, 0, 50_000, null, null, repo); // t5：工作树已清理
  insert.run("e", "done", 1_000, 0, 50_000, null, null, null); // t6：没有仓库
  const cwds = new Map([
    [11, `${wt(1, "a")}/.atrium`],
    [12, wt(2, "b")],
    [13, wt(3, "c")],
    [14, wt(1, "a")], // 挂在别的进程下，不查
    [15, wt(1, "a")], // 任务结束后才起
    [16, "/Users/u/somewhere"],
    [18, wt(4, "d")],
    [20, "/Users/u/atrium-t5-fix-ci/node_modules"],
    [21, "/Users/u/atrium-t5-other"], // 号对得上、路径对不上
    [22, "/Users/u/atrium-t6-e"],
  ]);
  const asked: number[][] = [];
  const mark = recognizer(db, owner, {
    platform: "darwin",
    readCwd: async (pids) => {
      asked.push([...pids]);
      return new Map([...cwds].filter(([pid]) => pids.includes(pid)));
    },
  })!;
  assert.equal(mark.prefix, `${owner}/`);
  assert.equal(mark.wants!({ pid: 9, ppid: 1, cpu: 0, start: 1 }), true);
  assert.equal(mark.wants!({ pid: 9, ppid: 2, cpu: 0, start: 1 }), false);
  assert.equal(mark.wants!({ pid: 9, ppid: 1, cpu: 0 }), false);
  const found = await mark.recognize([
    { pid: 11, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 12, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 13, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 14, ppid: 11, cpu: 0, start: 2_000 },
    { pid: 15, ppid: 1, cpu: 0, start: 60_000 },
    { pid: 16, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 17, ppid: 1, cpu: 0 }, // 不知道启动时刻
    { pid: 18, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 19, ppid: 1, cpu: 0, start: 2_000 }, // lsof 没给（别的用户的）
    { pid: 20, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 21, ppid: 1, cpu: 0, start: 2_000 },
    { pid: 22, ppid: 1, cpu: 0, start: 2_000 },
  ]);
  assert.deepEqual(asked, [[11, 12, 13, 15, 16, 18, 19, 20, 21, 22]]);
  assert.deepEqual(
    [...found!],
    [
      [11, spawnMark(owner, 1)],
      [12, spawnMark(owner, 2)],
      [13, null],
      [14, null],
      [15, null],
      [16, null],
      [17, null],
      [18, spawnMark(owner, 4)],
      [19, null],
      [20, spawnMark(owner, 5)],
      [21, null],
      [22, null],
    ],
  );
  // 清理只动已结束的：t2、t4 在跑。
  const reaper = new OrphanReaper(
    db,
    owner,
    () => {},
    () => {},
  );
  const orphans = [...found!]
    .filter(([, value]) => value !== null)
    .map(([pid, value]) => ({ pid, mark: value! }));
  assert.deepEqual(
    reaper.sweep(orphans, 50_000 + 31 * 60_000).map((kill) => kill.pid),
    [11, 20],
  );
  const broken = recognizer(db, owner, {
    platform: "darwin",
    readCwd: async () => null,
  })!;
  assert.equal(
    await broken.recognize([{ pid: 11, ppid: 1, cpu: 0, start: 2_000 }]),
    null,
    "查不了整批不收",
  );
});

test("Linux 认法读标记环境变量，查过的都有结果；Windows 不认", async () => {
  const { db } = taskDb();
  const mark = recognizer(db, owner, {
    platform: "linux",
    readEnv: async (pids, name) => {
      assert.equal(name, "ATRIUM_SPAWN");
      return new Map([[pids[0]!, spawnMark(owner, 3)]]);
    },
  })!;
  assert.deepEqual(
    [
      ...(await mark.recognize([
        { pid: 5, ppid: 9, cpu: 0 },
        { pid: 6, ppid: 1, cpu: 0 },
      ]))!,
    ],
    [
      [5, spawnMark(owner, 3)],
      [6, null],
    ],
  );
  assert.equal(recognizer(db, owner, { platform: "win32" }), undefined);
});

test("本机实测：按平台真实能力认得出自己起的子进程（Linux 读环境变量，macOS 读工作目录与启动时刻，Windows 都读不到）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-orphan-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
    stdio: "ignore",
    cwd: dir,
    env: { ...process.env, ATRIUM_SPAWN: spawnMark(owner, 7) },
  });
  t.after(() => child.kill());
  t.after(() => removeTemp(dir));
  await new Promise((resolve) => child.once("spawn", resolve));
  const pid = child.pid!;
  const env = await readEnv([pid, 999_999_9], "ATRIUM_SPAWN");
  const cwd = await readCwd([pid, 999_999_9]);
  if (process.platform === "win32") {
    assert.equal(env, null);
    assert.equal(cwd, null);
    return;
  }
  if (process.platform === "linux") {
    assert.equal(env?.get(pid), spawnMark(owner, 7));
    assert.equal(env?.has(999_999_9), false);
    assert.equal(cwd, null);
    return;
  }
  // macOS 等：ps 读不到环境，读得到工作目录与启动时刻。
  assert.equal(env, null);
  assert.equal(cwd?.get(pid), realpathSync(dir));
  assert.equal(cwd?.has(999_999_9), false);
  const proc = (await snapshot()).procs.find((one) => one.pid === pid);
  assert.ok(proc?.start !== undefined);
  assert.ok(Math.abs(proc.start - Date.now()) < 10_000, `${proc.start}`);
});
