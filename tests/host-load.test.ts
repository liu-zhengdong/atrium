import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HostLoad,
  hostGate,
  hostLimits,
  hostView,
  type HostLimits,
} from "../server/tasks/host-load.ts";
import { LocalCheckQueue, runLocalCheck } from "../server/tasks/local-check.ts";
import { workerEnvironment } from "../server/tasks/worker-env.ts";
import { getTask } from "../server/tasks/ledger.ts";
import { hostBrief } from "../cli/top.ts";
import { startApp, until } from "./task-fixture.ts";

const limits = (over: Partial<HostLimits> = {}): HostLimits => ({
  cores: 8,
  maxWorkers: 6,
  maxChecks: 2,
  testConcurrency: 2,
  busyLoad: 16,
  ...over,
});

test("本机限额：缺省按核数，8 核同时 6 个执行者、2 个检查、测试并发 2、负载 16 暂停", () => {
  assert.deepEqual(hostLimits({}, 8), { limits: limits(), problems: [] });
  assert.deepEqual(hostLimits({}, 1).limits, {
    cores: 1,
    maxWorkers: 2,
    maxChecks: 1,
    testConcurrency: 1,
    busyLoad: 2,
  });
  assert.deepEqual(hostLimits({}, 16).limits, {
    cores: 16,
    maxWorkers: 12,
    maxChecks: 4,
    testConcurrency: 4,
    busyLoad: 32,
  });
  // 核数读成 0 或小数也不出 0 上限。
  assert.equal(hostLimits({}, 0).limits.cores, 1);
});

test("本机限额：环境变量覆盖，0/off 表示不限，写错的照缺省并列出", () => {
  assert.deepEqual(
    hostLimits(
      {
        ATRIUM_MAX_WORKERS: "3",
        ATRIUM_MAX_CHECKS: "1",
        ATRIUM_TEST_CONCURRENCY: "4",
        ATRIUM_BUSY_LOAD: "12.5",
      },
      8,
    ).limits,
    limits({
      maxWorkers: 3,
      maxChecks: 1,
      testConcurrency: 4,
      busyLoad: 12.5,
    }),
  );
  assert.deepEqual(
    hostLimits({ ATRIUM_MAX_WORKERS: "off", ATRIUM_BUSY_LOAD: "0" }, 8).limits,
    limits({ maxWorkers: null, busyLoad: null }),
  );
  const bad = hostLimits(
    {
      ATRIUM_MAX_WORKERS: "-1",
      ATRIUM_MAX_CHECKS: "0",
      ATRIUM_TEST_CONCURRENCY: "两个",
      ATRIUM_BUSY_LOAD: "Infinity",
    },
    8,
  );
  assert.deepEqual(bad.limits, limits());
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems[0]!, /ATRIUM_MAX_WORKERS=-1 看不懂/);
  // 空字符串当没设，不报。
  assert.deepEqual(hostLimits({ ATRIUM_MAX_WORKERS: " " }, 8).problems, []);
});

test("本机限额：node:test 派生的进程缺省不限执行者、不看负载，显式设置照样生效", () => {
  assert.deepEqual(
    hostLimits({ NODE_TEST_CONTEXT: "child" }, 8).limits,
    limits({ maxWorkers: null, busyLoad: null }),
  );
  assert.deepEqual(
    hostLimits(
      {
        NODE_TEST_CONTEXT: "child",
        ATRIUM_MAX_WORKERS: "2",
        ATRIUM_BUSY_LOAD: "4",
      },
      8,
    ).limits,
    limits({ maxWorkers: 2, busyLoad: 4 }),
  );
});

test("本机闸门：太忙优先于满；恰好到阈值不算太忙；不限时总能派", () => {
  const cases: [number, number, Partial<HostLimits>, RegExp | null][] = [
    [0, 0, {}, null],
    [5, 16, {}, null],
    [6, 0, {}, /本机同时最多跑 6 个执行者，有执行者结束后自动拉起/],
    [9, 0, {}, /最多跑 6 个/],
    [0, 16.01, {}, /本机太忙（负载 16，超过 16），负载降下来后自动拉起/],
    [6, 170, {}, /本机太忙.*负载 170/],
    [0, 3.25, { busyLoad: 2 }, /负载 3\.3，超过 2\.0/],
    [100, 1000, { maxWorkers: null, busyLoad: null }, null],
    [100, 0, { maxWorkers: null }, null],
    [0, 1000, { busyLoad: null }, null],
  ];
  for (const [running, load, over, reason] of cases) {
    const gate = hostGate({ running, load, limits: limits(over) });
    if (reason === null) assert.deepEqual(gate, { ok: true });
    else {
      assert.equal(gate.ok, false, `${running}/${load}`);
      if (!gate.ok) {
        assert.match(gate.reason, reason);
        assert.equal(gate.busy, /太忙/.test(gate.reason));
      }
    }
  }
});

test("本机状态：暂停原因与抬头简写", () => {
  const busy = hostView({
    limits: limits(),
    load: 170.456,
    running: 3,
    checks: { running: 2, waiting: 1 },
  });
  assert.equal(busy.load, 170.46);
  assert.deepEqual(busy.checks, { running: 2, waiting: 1, max: 2 });
  assert.match(busy.paused!, /本机太忙/);
  assert.equal(hostBrief(busy), " · 本机太忙，排队中（负载 170/16）");
  const full = hostView({
    limits: limits(),
    load: 1,
    running: 6,
    checks: { running: 0, waiting: 0 },
  });
  assert.equal(hostBrief(full), " · 本机满 6/6，排队中");
  const idle = hostView({
    limits: limits(),
    load: 1,
    running: 1,
    checks: { running: 0, waiting: 0 },
  });
  assert.equal(idle.paused, null);
  assert.equal(hostBrief(idle), "");
  assert.equal(hostBrief(undefined), "");
  // 采样出错或给出负数按 0 算，不挡派活。
  assert.equal(
    new HostLoad(limits(), () => {
      throw new Error("x");
    }).load(),
    0,
  );
  assert.equal(new HostLoad(limits(), () => Number.NaN).gate(0).ok, true);
});

test("执行者环境注入测试并发：沿用来源里的合法值，否则按核数", () => {
  assert.equal(
    workerEnvironment({ ATRIUM_TEST_CONCURRENCY: "3" }).ATRIUM_TEST_CONCURRENCY,
    "3",
  );
  const fallback = workerEnvironment({
    ATRIUM_TEST_CONCURRENCY: "0",
  }).ATRIUM_TEST_CONCURRENCY!;
  assert.match(fallback, /^[1-9][0-9]*$/);
  assert.equal(workerEnvironment({}).ATRIUM_TEST_CONCURRENCY, fallback);
  // 再过一遍白名单（本地检查就是这样）值不变。
  assert.equal(
    workerEnvironment(workerEnvironment({ ATRIUM_TEST_CONCURRENCY: "5" }))
      .ATRIUM_TEST_CONCURRENCY,
    "5",
  );
});

test("本地检查队列：同时最多 limit 个，其余按到达顺序等；调大上限立刻放行", async () => {
  const queue = new LocalCheckQueue(2);
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (name: string) =>
    queue.run(
      () =>
        new Promise<string>((resolve) => {
          log.push(`${name}:start`);
          gates.set(name, () => resolve(name));
        }),
      () => log.push(`${name}:queued`),
    );
  const all = ["a", "b", "c", "d"].map(job);
  await until(() => gates.size === 2);
  assert.deepEqual(log, ["a:start", "b:start", "c:queued", "d:queued"]);
  assert.deepEqual(queue.size, { running: 2, waiting: 2 });
  gates.get("b")!();
  await until(() => gates.has("c"));
  assert.deepEqual(queue.size, { running: 2, waiting: 1 });
  queue.limit = 3;
  await until(() => gates.has("d"));
  assert.deepEqual(queue.size, { running: 3, waiting: 0 });
  for (const name of ["a", "c", "d"]) gates.get(name)!();
  assert.deepEqual(await Promise.all(all), ["a", "b", "c", "d"]);
  assert.deepEqual(queue.size, { running: 0, waiting: 0 });
  queue.limit = 0;
  assert.equal(queue.limit, 1, "上限至少 1");
});

test("本地检查带上测试并发上限", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-host-check-"));
  try {
    mkdirSync(join(root, "wt", ".agents"), { recursive: true });
    writeFileSync(
      join(root, "wt", ".agents", "check"),
      `echo "$ATRIUM_TEST_CONCURRENCY" > '${join(root, "seen")}'\n`,
    );
    const result = await runLocalCheck({
      worktree: join(root, "wt"),
      taskDir: join(root, "task"),
      queue: new LocalCheckQueue(),
      env: { PATH: process.env.PATH, ATRIUM_TEST_CONCURRENCY: "3" },
    });
    assert.equal(result.status, "passed");
    assert.equal(readFileSync(join(root, "seen"), "utf8").trim(), "3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 假 kimi 等到 $HOME/go 出现才收工，期间一直有输出，看门狗不判卡死。 */
const waitingKimi = (fx: { script: (name: string, body: string) => void }) =>
  fx.script(
    "kimi",
    'set -e\necho "$ATRIUM_TEST_CONCURRENCY" > "$HOME/concurrency-seen.txt"\nwhile [ ! -f "$HOME/go" ]; do echo waiting; sleep 0.1; done\necho hi > done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"',
  );

test("本机满：超过执行者上限的落库排队，有人结束后自动拉起", async (t) => {
  const host = new HostLoad(limits({ maxWorkers: 1, busyLoad: null }), () => 0);
  const { fx, data, call } = await startApp(
    t,
    waitingKimi,
    undefined,
    undefined,
    undefined,
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "one", repo: fx.repo });
  await call("POST", "/api/tasks", { title: "two", repo: fx.repo });
  const first = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(first.body.queued, false);
  assert.equal(first.body.task.status, "running");
  const second = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(second.body.queued, true);
  assert.equal(second.body.task.status, "todo");
  assert.match(second.body.task.queued_reason, /本机同时最多跑 1 个执行者/);
  const top = (await call("GET", "/api/tasks/top")).body;
  assert.equal(top.host.running, 1);
  assert.equal(top.host.max_workers, 1);
  assert.match(top.host.paused, /最多跑 1 个/);
  assert.equal(
    top.rows.find((row: { ref: string }) => row.ref === "t2").reason,
    second.body.task.queued_reason,
  );
  // 巡检多轮也不越过上限。
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(getTask(db, "t2").status, "todo");
  writeFileSync(join(fx.root, "home", "go"), "");
  await call("GET", "/api/tasks/t1/wait?timeout=20");
  const done = await call("GET", "/api/tasks/t2/wait?timeout=20");
  assert.equal(done.body.task.status, "blocked");
  const kinds = getTask(db, "t2").events.map((event) => event.kind);
  assert.ok(kinds.indexOf("queued") < kinds.indexOf("start"));
});

test("本机太忙：负载超过阈值暂停派新活，降下来后巡检自动拉起", async (t) => {
  let load = 170;
  const host = new HostLoad(
    limits({ maxWorkers: null, busyLoad: 16 }),
    () => load,
  );
  const { fx, data, call } = await startApp(
    t,
    waitingKimi,
    undefined,
    undefined,
    undefined,
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "busy", repo: fx.repo });
  const queued = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(queued.body.queued, true);
  assert.match(queued.body.task.queued_reason, /本机太忙（负载 170/);
  assert.match((await call("GET", "/api/tasks/top")).body.host.paused, /太忙/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(getTask(db, "t1").status, "todo");
  load = 1;
  await until(() => getTask(db, "t1").status === "running");
  assert.equal((await call("GET", "/api/tasks/top")).body.host.paused, null);
  writeFileSync(join(fx.root, "home", "go"), "");
  assert.equal(
    (await call("GET", "/api/tasks/t1/wait?timeout=20")).body.task.status,
    "blocked",
    "假 kimi 提交后退出，只因没有 PR 受阻",
  );
  // 执行者拿到了测试并发上限。
  assert.match(
    readFileSync(join(fx.root, "home", "concurrency-seen.txt"), "utf8"),
    /^[1-9][0-9]*\n$/,
  );
});
