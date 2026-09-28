import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hostLostMs,
  HOST_LOST_MINUTES,
  moveDue,
  movedNote,
  movedText,
  moveFailedText,
  moveWaitText,
  offlineSpan,
  spanText,
} from "../server/hosts/move-plan.ts";
import {
  beginRun,
  ensureHostTables,
  hostRun,
  runningOn,
  voidRun,
} from "../server/hosts/model.ts";
import { RemoteHosts } from "../server/hosts/remote.ts";
import { reconcile, type HostInfo } from "../server/hosts/state.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { removeTemp } from "./temp-dir.ts";

/** 主机掉线超时改派（t184）：判定是纯函数，账与对账用假时钟、假主机，不连网络。 */

test("掉线多久改派：缺省 10 分钟，可配、可关，写错按缺省并说明", () => {
  assert.deepEqual(hostLostMs({}), {
    ms: HOST_LOST_MINUTES * 60_000,
    problem: null,
  });
  assert.deepEqual(hostLostMs({ ATRIUM_HOST_LOST_MINUTES: " " }), {
    ms: 600_000,
    problem: null,
  });
  assert.deepEqual(hostLostMs({ ATRIUM_HOST_LOST_MINUTES: "3" }), {
    ms: 180_000,
    problem: null,
  });
  assert.deepEqual(hostLostMs({ ATRIUM_HOST_LOST_MINUTES: "0.5" }), {
    ms: 30_000,
    problem: null,
  });
  assert.deepEqual(hostLostMs({ ATRIUM_HOST_LOST_MINUTES: "OFF" }), {
    ms: 0,
    problem: null,
  });
  for (const bad of ["0", "-1", "abc", "1441", "Infinity"]) {
    const parsed = hostLostMs({ ATRIUM_HOST_LOST_MINUTES: bad });
    assert.equal(parsed.ms, 600_000, bad);
    assert.match(parsed.problem!, /看不懂，按缺省 10 分钟/);
  }
});

test("掉线时长：从最后心跳与服务开始盯着两者较晚的算起", () => {
  assert.equal(
    offlineSpan({ lastSeenAt: 1000, watchingSince: 0, now: 5000 }),
    4000,
  );
  // 服务停机前的心跳不算：从服务启动起计。
  assert.equal(
    offlineSpan({ lastSeenAt: 1000, watchingSince: 4000, now: 5000 }),
    1000,
  );
  assert.equal(
    offlineSpan({ lastSeenAt: null, watchingSince: 2000, now: 5000 }),
    3000,
  );
  // 时钟回拨不给负数。
  assert.equal(
    offlineSpan({ lastSeenAt: 9000, watchingSince: 0, now: 5000 }),
    0,
  );
});

test("该不该改派：在线、关掉、在停不动；没到时限等；到了改派；挑不到主机隔一阵再挑", () => {
  const due = (patch: Partial<Parameters<typeof moveDue>[0]>) =>
    moveDue({
      offlineMs: 600_000,
      lostMs: 600_000,
      stopping: false,
      now: 10_000,
      ...patch,
    });
  assert.deepEqual(due({ offlineMs: null }), { kind: "stay" });
  assert.deepEqual(due({ lostMs: 0 }), { kind: "stay" });
  assert.deepEqual(due({ stopping: true }), { kind: "stay" });
  assert.deepEqual(due({ offlineMs: 0 }), { kind: "wait", leftMs: 600_000 });
  assert.deepEqual(due({ offlineMs: 599_999 }), { kind: "wait", leftMs: 1 });
  assert.deepEqual(due({}), { kind: "move" });
  assert.deepEqual(due({ offlineMs: 3_600_000 }), { kind: "move" });
  assert.deepEqual(due({ retryAt: 70_000 }), { kind: "wait", leftMs: 60_000 });
  assert.deepEqual(due({ retryAt: 10_000 }), { kind: "move" });
  assert.deepEqual(due({ retryAt: 9_000 }), { kind: "move" });
});

test("改派的几句话：整分钟写分钟，短时限写秒", () => {
  assert.equal(spanText(600_000), "10 分钟");
  assert.equal(spanText(4000), "4 秒");
  assert.equal(spanText(200), "1 秒");
  assert.equal(
    movedText("h3", "h1", 600_000),
    "h3 掉线超过 10 分钟，已改派到 h1",
  );
  assert.equal(
    moveWaitText("h3", 600_000, "本机同时最多跑 4 个执行者"),
    "h3 掉线超过 10 分钟，暂时改派不了：本机同时最多跑 4 个执行者；有主机能接时自动改派",
  );
  assert.equal(
    moveFailedText("h3", "h2", 600_000, "h2 拉起失败：没装 kimi"),
    "h3 掉线超过 10 分钟，改派到 h2 拉起失败：h2 拉起失败：没装 kimi",
  );
  assert.match(movedNote("h3", "task-t9-x"), /远端若已有分支 task-t9-x/);
  assert.doesNotMatch(movedNote("h3", null), /分支/);
});

function hostDb() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureHostTables(db);
  db.prepare(
    "INSERT INTO hosts(id,name,kind,repos,token_hash,joined_at,last_seen_at,created_at,updated_at) VALUES(3,'mac3','remote','[\"*\"]','x',1,?,1,1)",
  ).run(1_000_000);
  db.prepare(
    "INSERT INTO tasks(id,title,status,host_id,created_at,updated_at) VALUES(9,'远程的活','running',3,1,1)",
  ).run();
  beginRun(db, {
    task_id: 9,
    host_id: 3,
    run: 2,
    pid: 4321,
    clone: "/agent/repos/o-r",
    worktree: "/agent/repos/o-r-t9-x",
    dir: "/agent/tasks/9",
    log_offset: 5,
    started_at: 1,
  });
  return db;
}

test("掉线时长用假时钟：服务启动前的心跳不算，回来就清零", (t) => {
  const db = hostDb();
  const data = mkdtempSync(join(tmpdir(), "atrium-move-"));
  t.after(() => removeTemp(data));
  let now = 1_000_000 + 30 * 60_000;
  const remote = new RemoteHosts(db, data, {
    onlineMs: 60_000,
    now: () => now,
  });
  t.after(() => remote.close());
  // 上次心跳在半小时前，但服务刚启动：从启动起算，还是 0。
  assert.equal(remote.offlineFor(3), 0);
  now += 11 * 60_000;
  assert.equal(remote.offlineFor(3), 11 * 60_000);
  // 代理回来（上报额度也算来过）：在线。
  remote.quota(3, { readings: [] });
  assert.equal(remote.offlineFor(3), null);
  now += 61_000;
  assert.equal(remote.offlineFor(3), 61_000);
  db.close();
});

test("改派后旧一轮作废：晚到的日志与退出不收，重连对账让代理结束它", (t) => {
  const db = hostDb();
  const data = mkdtempSync(join(tmpdir(), "atrium-move-"));
  t.after(() => removeTemp(data));
  const remote = new RemoteHosts(db, data, { now: () => 2_000_000 });
  t.after(() => remote.close());
  const exited: number[] = [];
  const lost: number[] = [];
  remote.attach({
    ready: () => true,
    exited: (task) => {
      exited.push(task);
      return "done";
    },
    lost: (task) => lost.push(task),
    reconnected: () => undefined,
  });
  // 改派到本机：这一轮作废（轮号加一），任务改记在本机上。
  voidRun(db, 9);
  db.prepare("UPDATE tasks SET host_id=NULL WHERE id=9").run();
  assert.equal(hostRun(db, 9)!.run, 3);
  assert.equal(hostRun(db, 9)!.pid, null);
  assert.deepEqual(runningOn(db, 3), []);
  // 纯对账：代理还在跑第 2 轮，账本已不认，结束它；账本这边没有丢的。
  assert.deepEqual(
    reconcile(runningOn(db, 3), [{ task: 9, run: 2, state: "running" }]),
    { lost: [], orphans: [{ task: 9, run: 2, state: "running" }] },
  );
  // 掉线那台回来：先对账，叫它结束第 2 轮。
  const info = {
    hostname: "mac3",
    os: process.platform,
    arch: process.arch,
    cpus: 4,
    mem_mb: 1024,
    node: process.version,
    version: "test",
    data_dir: "/agent",
    clis: {},
    max_workers: null,
  } satisfies HostInfo;
  const hello = remote.hello(3, {
    info,
    runs: [{ task: 9, run: 2, state: "running" }],
  });
  assert.deepEqual(hello.stop, [{ task: 9, run: 2 }]);
  assert.deepEqual(lost, []);
  // 它晚到的日志与退出：对不上这一轮，不写进本机日志、不收尾。
  assert.deepEqual(
    remote.log(3, {
      task: 9,
      run: 2,
      offset: 5,
      data: Buffer.from("旧进程的输出").toString("base64"),
    }),
    { done: true },
  );
  assert.throws(() => readFileSync(join(data, "tasks", "9", "log")));
  assert.deepEqual(
    remote.exit(3, {
      task: 9,
      run: 2,
      exit: { code: 0, signal: null },
      size: 5,
    }),
    { ok: true, ignored: true },
  );
  assert.deepEqual(exited, []);
  db.close();
});
