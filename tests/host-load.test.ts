import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HostLoad,
  checkPlacement,
  hostGate,
  hostLimits,
  hostView,
  queueOrder,
  type HostLimits,
} from "../server/tasks/host-load.ts";
import { queueHeads } from "../server/tasks/queue.ts";
import { NEXT_MERGE } from "../server/tasks/merge-runtime.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  taskColumns,
  taskView,
  type TaskRow as MapTaskRow,
} from "../server/map/view.ts";
import { LocalCheckQueue, runLocalCheck } from "../server/tasks/local-check.ts";
import { workerEnvironment } from "../server/tasks/worker-env.ts";
import { getTask } from "../server/tasks/ledger.ts";
import { hostBrief } from "../cli/top.ts";
import { startApp, until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";
import { nodeCommand } from "./portable-shell.ts";

const limits = (over: Partial<HostLimits> = {}): HostLimits => ({
  cores: 8,
  maxWorkers: 6,
  maxChecks: 4,
  testConcurrency: 7,
  checkTimeoutMs: 30 * 60_000,
  busyCores: 6,
  busyLoad: 32,
  ...over,
});

test("本机限额：缺省按核数，8 核同时 6 个执行者、4 个检查、测试并发 7、检查 30 分钟、Atrium 占 6 核或整机负载 32 暂停", () => {
  assert.deepEqual(hostLimits({}, 8), { limits: limits(), problems: [] });
  assert.deepEqual(hostLimits({}, 1).limits, {
    cores: 1,
    maxWorkers: 2,
    maxChecks: 1,
    testConcurrency: 1,
    checkTimeoutMs: 30 * 60_000,
    busyCores: 0.75,
    busyLoad: 4,
  });
  assert.deepEqual(hostLimits({}, 16).limits, {
    cores: 16,
    maxWorkers: 12,
    maxChecks: 8,
    testConcurrency: 15,
    checkTimeoutMs: 30 * 60_000,
    busyCores: 12,
    busyLoad: 64,
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
        ATRIUM_CHECK_TIMEOUT_MINUTES: "45",
        ATRIUM_BUSY_CORES: "3.5",
        ATRIUM_BUSY_LOAD: "12.5",
      },
      8,
    ).limits,
    limits({
      maxWorkers: 3,
      maxChecks: 1,
      testConcurrency: 4,
      checkTimeoutMs: 45 * 60_000,
      busyCores: 3.5,
      busyLoad: 12.5,
    }),
  );
  assert.deepEqual(
    hostLimits(
      {
        ATRIUM_MAX_WORKERS: "off",
        ATRIUM_BUSY_CORES: "off",
        ATRIUM_BUSY_LOAD: "0",
      },
      8,
    ).limits,
    limits({ maxWorkers: null, busyCores: null, busyLoad: null }),
  );
  const bad = hostLimits(
    {
      ATRIUM_MAX_WORKERS: "-1",
      ATRIUM_MAX_CHECKS: "0",
      ATRIUM_TEST_CONCURRENCY: "两个",
      ATRIUM_CHECK_TIMEOUT_MINUTES: "0",
      ATRIUM_BUSY_CORES: "-2",
      ATRIUM_BUSY_LOAD: "Infinity",
    },
    8,
  );
  assert.deepEqual(bad.limits, limits());
  assert.equal(bad.problems.length, 6);
  assert.match(bad.problems[0]!, /ATRIUM_MAX_WORKERS=-1 看不懂/);
  // 空字符串当没设，不报。
  assert.deepEqual(hostLimits({ ATRIUM_MAX_WORKERS: " " }, 8).problems, []);
});

test("本机限额：node:test 派生的进程缺省不限执行者、不看负载，显式设置照样生效", () => {
  assert.deepEqual(
    hostLimits({ NODE_TEST_CONTEXT: "child" }, 8).limits,
    limits({ maxWorkers: null, busyCores: null, busyLoad: null }),
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
    limits({ maxWorkers: 2, busyCores: null, busyLoad: 4 }),
  );
});

test("本机闸门：先看 Atrium 自己占的核，再看整机负载保护线，最后看满；恰好到线不算；不限时总能派", () => {
  // [在跑, 整机负载, Atrium 占的核, 限额覆盖, 期望原因, 哪条线]
  const cases: [
    number,
    number,
    number | null,
    Partial<HostLimits>,
    RegExp | null,
    string | null,
  ][] = [
    [0, 0, 0, {}, null, null],
    [5, 32, 6, {}, null, null],
    [5, 18, 1, {}, null, null], // t112 那次：整机 18，Atrium 只占 1 核，照派。
    [6, 0, 0, {}, /本机同时最多跑 6 个执行者，有执行者结束后自动拉起/, "full"],
    [9, 0, null, {}, /最多跑 6 个/, "full"],
    [
      0,
      0,
      6.3,
      {},
      /本机太忙（Atrium 自己占了 6\.3 核，超过 6），降下来后自动拉起/,
      "own",
    ],
    [
      0,
      32.01,
      0,
      {},
      /本机太忙（整机负载 32，超过 32），降下来后自动拉起/,
      "load",
    ],
    [0, 35, 7, {}, /Atrium 自己占了 7 核/, "own"],
    [6, 170, 0, {}, /整机负载 170/, "load"],
    [0, 3.25, null, { busyLoad: 2 }, /整机负载 3\.3，超过 2\.0/, "load"],
    [0, 0, 1, { busyCores: 0.75 }, /占了 1 核，超过 0\.8/, "own"],
    [0, 0, null, { busyCores: 0 }, null, null], // 还没采到样不挡。
    [0, 0, 100, { busyCores: null }, null, null],
    [
      100,
      1000,
      100,
      { maxWorkers: null, busyCores: null, busyLoad: null },
      null,
      null,
    ],
    [100, 0, 0, { maxWorkers: null }, null, null],
    [0, 1000, 0, { busyLoad: null }, null, null],
  ];
  for (const [running, load, own, over, reason, by] of cases) {
    for (const urgent of [false, true]) {
      const gate = hostGate({
        running,
        load,
        own,
        limits: limits(over),
        urgent,
      });
      // 紧急的三条线都不看。
      if (reason === null || urgent) {
        assert.deepEqual(gate, { ok: true }, `${running}/${load}/${own}`);
        continue;
      }
      assert.equal(gate.ok, false, `${running}/${load}/${own}`);
      if (!gate.ok) {
        assert.match(gate.reason, reason);
        assert.equal(gate.by, by);
        assert.equal(gate.busy, /太忙/.test(gate.reason));
      }
    }
  }
});

test("排队先后：紧急的在前、闲时的在后，同一档按入队先后、再按任务号", () => {
  const entries = [
    { urgent: false, at: 1, id: 1 },
    { urgent: true, at: 5, id: 4 },
    { urgent: false, at: 1, id: 0 },
    { urgent: true, at: 3, id: 9 },
    { urgent: false, at: 0, id: 7 },
    { urgent: true, at: 3, id: 2 },
  ];
  assert.deepEqual(
    [...entries].sort(queueOrder).map((entry) => entry.id),
    [2, 9, 4, 7, 0, 1],
  );
  const tiers = [
    { urgent: false, idle: true, at: 0, id: 1 },
    { urgent: false, at: 9, id: 2 },
    { urgent: true, idle: true, at: 9, id: 3 },
    { urgent: false, idle: false, at: 5, id: 4 },
    { urgent: false, idle: true, at: 1, id: 5 },
  ];
  assert.deepEqual(
    [...tiers].sort(queueOrder).map((entry) => entry.id),
    [3, 4, 2, 1, 5],
  );
  const q = (
    task_id: number,
    tool: string,
    queued_at: number,
    urgent = false,
    idle = false,
  ) => ({
    task_id,
    tool,
    worker: tool,
    risk: "low",
    queued_at,
    urgent,
    idle,
  });
  // 每个工具一个队首：同一工具里紧急的顶到前面；各工具的队首之间也是紧急的在前。
  assert.deepEqual(
    queueHeads([
      q(1, "kimi", 1),
      q(2, "kimi", 2, true),
      q(3, "codex", 0),
      q(4, "claude", 5, true),
      q(5, "codex", 3),
    ]).map((entry) => entry.task_id),
    [2, 4, 3],
  );
  // 闲时的（t136）排在同一工具的普通任务后面，各工具队首之间也在普通后面；标了紧急的闲时任务按紧急算。
  assert.deepEqual(
    queueHeads([
      q(1, "kimi", 0, false, true),
      q(2, "kimi", 5),
      q(3, "codex", 0, false, true),
      q(4, "claude", 9),
      q(5, "grok", 9, true, true),
    ]).map((entry) => entry.task_id),
    [5, 2, 4, 3],
  );
  assert.deepEqual(queueHeads([]), []);
});

test("本地检查排位：紧急的立刻跑，其余有空位才跑", () => {
  for (const urgent of [false, true])
    for (const active of [0, 1, 2, 3])
      for (const max of [1, 2])
        assert.equal(
          checkPlacement({ urgent, active, max }),
          urgent || active < max ? "run" : "wait",
          `${urgent}/${active}/${max}`,
        );
});

test("本机状态：暂停原因与抬头简写写清是哪条线", () => {
  const busy = hostView({
    limits: limits(),
    load: 170.456,
    running: 3,
    checks: { running: 2, waiting: 1 },
  });
  assert.equal(busy.load, 170.46);
  assert.deepEqual(busy.checks, { running: 2, waiting: 1, max: 4 });
  assert.match(busy.paused!, /本机太忙/);
  assert.equal(busy.paused_by, "load");
  assert.equal(busy.own_cores, null);
  assert.equal(hostBrief(busy), " · 本机太忙，排队中（整机负载 170，超过 32）");
  const own = hostView({
    limits: limits(),
    load: 18,
    own: 6.34,
    running: 2,
    checks: { running: 0, waiting: 0 },
  });
  assert.equal(own.paused_by, "own");
  assert.equal(own.busy_cores, 6);
  assert.equal(
    hostBrief(own),
    " · 本机太忙，排队中（Atrium 自己占了 6.3 核，超过 6）",
  );
  const full = hostView({
    limits: limits(),
    load: 1,
    running: 6,
    checks: { running: 0, waiting: 0 },
  });
  assert.equal(full.paused_by, "full");
  assert.equal(hostBrief(full), " · 本机满 6/6，排队中");
  const idle = hostView({
    limits: limits(),
    load: 18,
    own: 1,
    running: 1,
    checks: { running: 0, waiting: 0 },
  });
  assert.equal(idle.paused, null);
  assert.equal(idle.paused_by, null);
  assert.equal(hostBrief(idle), "");
  assert.equal(hostBrief(undefined), "");
  // 旧版服务没有 paused_by：按负载判断。
  assert.equal(
    hostBrief({
      ...busy,
      paused_by: undefined as unknown as null,
    }),
    " · 本机太忙，排队中（整机负载 170，超过 32）",
  );
  // 采样出错或给出负数按 0 算，不挡派活。
  assert.equal(
    new HostLoad(limits(), () => {
      throw new Error("x");
    }).load(),
    0,
  );
  assert.equal(new HostLoad(limits(), () => Number.NaN).gate(0).ok, true);
  // Atrium 占用：来源出错、给出负数或 NaN 都当不知道，不挡。
  const own_ = (value: () => number | null) =>
    new HostLoad(limits(), () => 0, {
      cores: value,
      refresh: async () => {},
    });
  assert.equal(
    own_(() => {
      throw new Error("x");
    }).own(),
    null,
  );
  assert.equal(own_(() => -1).own(), null);
  assert.equal(own_(() => Number.NaN).gate(0).ok, true);
  assert.equal(own_(() => 7).gate(0).ok, false);
  assert.equal(own_(() => 7).gate(0, true).ok, true);
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

test("本地检查队列：紧急的立刻跑、不占名额，普通的照样排", async () => {
  const queue = new LocalCheckQueue(1);
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (name: string, urgent = false) =>
    queue.run(
      () =>
        new Promise<string>((resolve) => {
          log.push(`${name}:start`);
          gates.set(name, () => resolve(name));
        }),
      () => log.push(`${name}:queued`),
      urgent,
    );
  const a = job("a");
  const b = job("b");
  const u = job("u", true);
  await until(() => gates.size === 2);
  assert.deepEqual(log, ["a:start", "b:queued", "u:start"]);
  assert.deepEqual(queue.size, { running: 2, waiting: 1 });
  // 紧急的结束不放行普通的：它本来就没占名额。
  gates.get("u")!();
  assert.equal(await u, "u");
  assert.deepEqual(queue.size, { running: 1, waiting: 1 });
  gates.get("a")!();
  await until(() => gates.has("b"));
  gates.get("b")!();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(queue.size, { running: 0, waiting: 0 });
});

test("本地检查带上测试并发上限", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-host-check-"));
  try {
    mkdirSync(join(root, "wt", ".agents"), { recursive: true });
    writeFileSync(
      join(root, "wt", ".agents", "check"),
      nodeCommand(
        "require('fs').writeFileSync(process.argv[1], String(process.env.ATRIUM_TEST_CONCURRENCY))",
        join(root, "seen"),
      ),
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
    removeTemp(root);
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
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "busy", repo: fx.repo });
  const queued = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(queued.body.queued, true);
  assert.match(queued.body.task.queued_reason, /本机太忙（整机负载 170/);
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

test("紧急任务：本机太忙时照样立刻派，排队中的标上紧急立刻拉起，其余限制照旧", async (t) => {
  const host = new HostLoad(limits({ maxWorkers: 1, busyLoad: 16 }), () => 170);
  const { fx, data, call } = await startApp(
    t,
    waitingKimi,
    undefined,
    undefined,
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "普通 A", repo: fx.repo });
  // 标题写「紧急：」不算紧急，只认字段。
  await call("POST", "/api/tasks", { title: "紧急：只是标题", repo: fx.repo });
  await call("POST", "/api/tasks", { title: "B", repo: fx.repo });
  const a = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(a.body.queued, true);
  assert.match(a.body.task.queued_reason, /整机负载 170/);
  const title = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(title.body.queued, true);
  assert.equal(title.body.task.urgent, 0);
  const bad = await call("POST", "/api/tasks/t3/run", {
    worker: "kimi",
    urgent: "yes",
  });
  assert.equal(bad.status, 400);
  assert.match(
    bad.body.message ?? bad.body.error,
    /urgent: 应为 true 或 false/,
  );
  const b = await call("POST", "/api/tasks/t3/run", {
    worker: "kimi",
    urgent: true,
  });
  assert.equal(b.body.queued, false, "紧急的跳过负载与执行者上限");
  assert.equal(b.body.task.status, "running");
  assert.equal(b.body.task.urgent, 1);
  const top = (await call("GET", "/api/tasks/top")).body;
  const row = (ref: string) =>
    top.rows.find((item: { ref: string }) => item.ref === ref);
  assert.equal(row("t3").urgent, true);
  assert.equal(row("t1").urgent, false);
  // 排队中的 t1 标上紧急：不等巡检，立刻按紧急拉起（上限已被 t3 占满也不挡）。
  const set = await call("PATCH", "/api/tasks/t1", { urgent: true });
  assert.equal(set.body.urgent, 1);
  await until(() => getTask(db, "t1").status === "running");
  // 取消紧急只改字段；t2 仍在排队。
  assert.equal(
    (await call("PATCH", "/api/tasks/t3", { urgent: false })).body.urgent,
    0,
  );
  assert.equal(getTask(db, "t2").status, "todo");
  assert.equal(
    (await call("PATCH", "/api/tasks/t2", { urgent: 1 })).status,
    400,
    "只认布尔值",
  );
  writeFileSync(join(fx.root, "home", "go"), "");
  await call("GET", "/api/tasks/t1/wait?timeout=20");
  await call("GET", "/api/tasks/t3/wait?timeout=20");
});

test("紧急任务：建任务时标上，全景任务行与排期就绪组都带紧急、排最前", async (t) => {
  const { fx, data, call } = await startApp(t);
  await call("POST", "/api/tasks", { title: "普通", repo: fx.repo });
  const made = await call("POST", "/api/tasks", {
    title: "修全景网页",
    repo: fx.repo,
    urgent: true,
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.urgent, 1);
  const plan = (await call("GET", "/api/tasks/plan")).body;
  assert.deepEqual(
    plan.groups.ready.map((item: { task: { ref: string } }) => item.task.ref),
    ["t2", "t1"],
  );
  const shown = (await call("GET", "/api/tasks/t2")).body;
  assert.equal(shown.urgent, 1);
  // 全景任务行（网页与 map --json 同一份）。
  const mapDb = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => mapDb.close());
  const rows = mapDb
    .prepare(`SELECT ${taskColumns(mapDb)} FROM tasks ORDER BY id`)
    .all() as unknown as MapTaskRow[];
  assert.deepEqual(
    rows.map((row) => taskView(row).urgent),
    [false, true],
  );
  assert.equal(
    (await call("POST", "/api/tasks", { title: "x", urgent: "true" })).status,
    400,
  );
});

test("合入队列：紧急的在前（连重启前没合完的普通任务也让它），同一档正在合入的先做完，其余按入队先后", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const add = (
    id: number,
    stage: string,
    at: number,
    urgent: number,
    status = "done",
  ) =>
    db
      .prepare(
        "INSERT INTO tasks(id,title,status,delivery_stage,merge_queued_at,urgent,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0)",
      )
      .run(id, `t${id}`, status, stage, at, urgent);
  const next = () => (db.prepare(NEXT_MERGE).get() as { id: number }).id;
  add(1, "merge_queued", 1, 0);
  add(2, "merge_queued", 5, 1);
  add(3, "merge_queued", 3, 1);
  add(4, "merge_queued", 0, 1, "blocked");
  assert.equal(next(), 3);
  // 队列一次只跑一个：「正在合入」而没在跑的普通任务是重启前没合完或让路的，紧急的插到它前面（t215）。
  add(5, "merging", 9, 0);
  assert.equal(next(), 3);
  add(6, "merging", 9, 1);
  assert.equal(next(), 6, "紧急的里正在合入的先做完");
  db.prepare("DELETE FROM tasks WHERE id IN (3,6)").run();
  assert.equal(next(), 2);
  db.prepare("DELETE FROM tasks WHERE id=2").run();
  assert.equal(next(), 5, "普通的里正在合入的先做完");
  db.close();
});
