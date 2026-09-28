import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  effectiveSize,
  estimateSize,
  LARGE_ALSO_PARTS,
  LARGE_BRIEF_CHARS,
  parseSize,
  SIZE_WORKERS,
  SIZES,
  sizeFits,
  sizeReason,
  sizeText,
  sizeWorkers,
  speedOf,
  type Size,
} from "../server/tasks/task-size.ts";
import {
  pickView,
  type PickCandidateFact,
  type PickFacts,
} from "../server/tasks/pick.ts";
import type { Tool } from "../server/tasks/adapters/index.ts";
import type { PaceEntry } from "../server/tasks/prepare.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { Problem } from "../server/problem.ts";
import { formatPick, pickLines } from "../cli/tasks.ts";
import { startApp } from "./task-fixture.ts";
import { join } from "node:path";
import { writeFakeBin } from "./fake-bin.ts";

/** 任务大小（t276）：解析、粗估、组合快慢、按大小排序与理由、写入与旧库补列。 */

test("parseSize：认中英文三档，其余一律拒绝", () => {
  for (const [input, size] of [
    ["小", "small"],
    ["中", "medium"],
    ["大", "large"],
    ["small", "small"],
    [" Medium ", "medium"],
    ["LARGE", "large"],
  ] as const)
    assert.equal(parseSize(input), size, input);
  for (const bad of ["特大", "", "s", 1, null, undefined, true])
    assert.throws(
      () => parseSize(bad),
      (error: unknown) =>
        error instanceof Problem &&
        error.statusCode === 400 &&
        error.message === "size: 只能是 小、中 或 大",
      String(bad),
    );
});

test("estimateSize：详述超过上限或牵涉部分够多为大，其余为中，不估小；按字数不按字节", () => {
  const at = "字".repeat(LARGE_BRIEF_CHARS);
  assert.equal(estimateSize({}), "medium");
  assert.equal(estimateSize({ brief: null }), "medium");
  assert.equal(estimateSize({ brief: "" }), "medium");
  assert.equal(estimateSize({ brief: at }), "medium");
  assert.equal(estimateSize({ brief: `${at}多` }), "large");
  assert.equal(estimateSize({ brief: `  ${at}  ` }), "medium", "首尾空白不算");
  const parts = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
  assert.equal(estimateSize({ also: parts(LARGE_ALSO_PARTS - 1) }), "medium");
  assert.equal(estimateSize({ also: parts(LARGE_ALSO_PARTS) }), "large");
});

test("effectiveSize：写了按写的，没写或写坏的旧值按粗估并标明", () => {
  for (const size of SIZES)
    assert.deepEqual(effectiveSize({ size, brief: "x".repeat(9999) }), {
      size,
      estimated: false,
    });
  assert.deepEqual(effectiveSize({ size: null }), {
    size: "medium",
    estimated: true,
  });
  assert.deepEqual(effectiveSize({ size: "huge", also: ["o1", "o2"] }), {
    size: "large",
    estimated: true,
  });
});

test("speedOf：强度 high 以上为强，low 以下、cursor+auto 与快组合表里的模型为快，其余不归类", () => {
  const cases: [string, "fast" | "strong" | null][] = [
    ["cursor+auto", "fast"],
    ["cursor+gpt-5.3-codex:high", "strong"],
    ["cursor+gpt-5.3-codex", null],
    ["codex+gpt-6-sol:low", "fast"],
    ["codex+gpt-6-sol:minimal", "fast"],
    ["codex+gpt-6-sol:none", "fast"],
    ["codex+gpt-6-sol:medium", null],
    ["codex+gpt-6-sol:high", "strong"],
    ["claude+opus:xhigh", "strong"],
    ["claude+opus:max", "strong"],
    ["claude+opus", null],
    ["claude:high", "strong"],
    ["codex:low", "fast"],
    ["opencode+opencode-go/deepseek-v4.1-flash", "fast"],
    ["opencode+opencode-go/deepseek-v4.1-flash:high", "strong"],
    ["opencode+opencode-go/mimo-v2.6-flash", null],
    ["claude+opencode-go/deepseek-v4.1-flash", null],
    ["kimi", null],
    ["不是工具+x", null],
    ["", null],
  ];
  for (const [worker, speed] of cases)
    assert.equal(speedOf(worker), speed, worker);
  // 快组合表里的每一项自己都归为快，强组合表里的都归为强。
  for (const worker of SIZE_WORKERS.fast) assert.equal(speedOf(worker), "fast");
  for (const worker of SIZE_WORKERS.strong)
    assert.equal(speedOf(worker), "strong");
});

test("sizeFits 与 sizeWorkers：小要快的，中、大要强的", () => {
  const workers = {
    fast: "cursor+auto",
    strong: "claude+opus:high",
    none: "claude+opus",
  };
  const expected: Record<Size, keyof typeof workers> = {
    small: "fast",
    medium: "strong",
    large: "strong",
  };
  for (const size of SIZES) {
    for (const [kind, worker] of Object.entries(workers))
      assert.equal(
        sizeFits(size, worker),
        kind === expected[size],
        `${size} ${worker}`,
      );
    assert.deepEqual(
      sizeWorkers(size),
      SIZE_WORKERS[expected[size] as "fast" | "strong"],
    );
  }
});

test("sizeReason：候选里没有合适组合不说；推荐合适、专员优先、按额度挑三种说法", () => {
  const small = { size: "small" as const, estimated: false };
  const guessed = { size: "medium" as const, estimated: true };
  assert.equal(sizeText("large", false), "大活");
  assert.equal(sizeText("medium", true), "中活（没写大小，按中估）");
  for (const top of [
    { fits: true, preferred: true },
    { fits: false, preferred: false },
  ])
    assert.equal(sizeReason(small, top, false), null);
  assert.equal(
    sizeReason(small, { fits: true, preferred: false }, true),
    "小活优先快且便宜的组合",
  );
  assert.equal(
    sizeReason(small, { fits: true, preferred: true }, true),
    "小活优先快且便宜的组合",
  );
  assert.equal(
    sizeReason(guessed, { fits: false, preferred: true }, true),
    "中活（没写大小，按中估）不按大小换：专员优先执行者在前",
  );
  assert.equal(
    sizeReason(
      { size: "large", estimated: false },
      { fits: false, preferred: false },
      true,
    ),
    "大活，高强度组合都不能接、正忙、超速或没有额度读数，按额度挑",
  );
});

// ---- 按大小排序（pick.ts pickView） ----

const cand = (
  worker: string,
  extra: Partial<PickCandidateFact> = {},
): PickCandidateFact => ({
  worker,
  tool: worker.split(/[+:]/)[0] as Tool,
  installed: true,
  rules: { trust: "medium" },
  preferred: null,
  ...extra,
});

const pace = (rows: [string, number][]): PaceEntry[] =>
  rows.map(([providerId, sparePercent]) => ({
    providerId,
    sparePercent,
    usedPercent: 10,
  }));

const facts = (over: Partial<PickFacts> = {}): PickFacts => ({
  risk: "low",
  job: null,
  candidates: [],
  held: new Map(),
  reservePercent: 20,
  headroom: new Map(),
  busy: new Set(),
  chain: [],
  records: new Map(),
  ...over,
});

const order = (view: ReturnType<typeof pickView>) =>
  view.candidates.map((c) => c.worker);

const smallPool = [
  cand("cursor+auto"),
  cand("codex+gpt-6-sol:low"),
  cand("claude+opus"),
  cand("codex+gpt-6-sol"),
];

test("pickView 小活：快且便宜的排在其余能接的前面，其中按富余；理由开头写大小", () => {
  const view = pickView(
    facts({
      candidates: smallPool,
      pace: pace([
        ["cursor", 10],
        ["codex", 40],
        ["claude", 60],
      ]),
      size: { size: "small", estimated: false },
    }),
  );
  assert.deepEqual(order(view), [
    "codex+gpt-6-sol:low",
    "cursor+auto",
    "claude+opus",
    "codex+gpt-6-sol",
  ]);
  assert.equal(view.size, "small");
  assert.equal(view.size_estimated, false);
  assert.equal(
    view.reason,
    "小活优先快且便宜的组合、codex 富余 +40%；cursor 富余 +10%；claude 富余 +60%",
  );
});

test("pickView 小活：快的超速、不能接或正忙时不优先，按额度挑并写明", () => {
  const view = pickView(
    facts({
      candidates: [
        cand("cursor+auto"),
        cand("codex+gpt-6-sol:low"),
        cand("opencode+opencode-go/deepseek-v4.1-flash"),
        cand("claude+opus"),
      ],
      pace: pace([
        ["codex", -5],
        ["opencode", 90],
        ["claude", 60],
      ]),
      held: new Map([["cursor", Date.now() + 3_600_000]]),
      busy: new Set<Tool>(["opencode"]),
      size: { size: "small", estimated: false },
    }),
  );
  assert.deepEqual(order(view), [
    "claude+opus",
    "codex+gpt-6-sol:low",
    "opencode+opencode-go/deepseek-v4.1-flash",
    "cursor+auto",
  ]);
  assert.match(
    view.reason,
    /^小活，快且便宜的组合都不能接、正忙、超速或没有额度读数，按额度挑、claude 富余 \+60%/,
  );
});

test("pickView 中活：高强度排在前面，其中按富余；有额度数据时没读数的不算合适，整个读不到时仍在前", () => {
  const pool = [
    cand("claude+opus:high"),
    cand("codex+gpt-6-sol:high"),
    cand("claude+opus"),
    cand("codex+gpt-6-sol"),
    cand("opencode+x"),
  ];
  const guessed = { size: "medium" as const, estimated: true };
  const view = pickView(
    facts({
      candidates: pool,
      pace: pace([
        ["claude", 20],
        ["codex", 30],
        ["opencode", 80],
      ]),
      size: guessed,
    }),
  );
  assert.deepEqual(order(view), [
    "codex+gpt-6-sol:high",
    "claude+opus:high",
    "opencode+x",
    "codex+gpt-6-sol",
    "claude+opus",
  ]);
  assert.equal(view.size_estimated, true);
  assert.match(
    view.reason,
    /^中活（没写大小，按中估）优先高强度组合、codex 富余 \+30%/,
  );
  // 只有 opencode 有读数：高强度的 claude 没读数，不按大小提前。
  const unseen = pickView(
    facts({
      candidates: [cand("claude+opus:high"), cand("opencode+x")],
      pace: pace([["opencode", 50]]),
      size: { size: "large", estimated: false },
    }),
  );
  assert.equal(unseen.recommended, "opencode+x");
  assert.match(unseen.reason, /^大活，高强度组合都不能接.*opencode 富余 \+50%/);
  // 额度数据整个读不到：按固定顺序，合适的仍在前。
  const blind = pickView(
    facts({
      candidates: [
        cand("opencode+x"),
        cand("claude+opus"),
        cand("claude+opus:high"),
      ],
      size: { size: "large", estimated: false },
    }),
  );
  assert.deepEqual(order(blind), [
    "claude+opus:high",
    "claude+opus",
    "opencode+x",
  ]);
  assert.equal(blind.reason, "大活优先高强度组合、额度数据不可用，按固定顺序");
});

test("pickView 专员优先执行者仍在最前：小活时其中快的先，中活按专员原顺序并写明不按大小换", () => {
  const job = { ref: "r1", name: "前端" };
  const pool = [
    cand("claude+opus", { preferred: 0 }),
    cand("cursor+auto", { preferred: 1 }),
    cand("codex+gpt-6-sol:high"),
  ];
  const quota = pace([
    ["claude", 30],
    ["cursor", 20],
    ["codex", 90],
  ]);
  const small = pickView(
    facts({
      job,
      candidates: pool,
      pace: quota,
      size: { size: "small", estimated: false },
    }),
  );
  assert.deepEqual(order(small), [
    "cursor+auto",
    "claude+opus",
    "codex+gpt-6-sol:high",
  ]);
  assert.match(
    small.reason,
    /^小活优先快且便宜的组合、前端专员优先、cursor 富余/,
  );
  const medium = pickView(
    facts({
      job,
      candidates: pool,
      pace: quota,
      size: { size: "medium", estimated: false },
    }),
  );
  assert.deepEqual(order(medium), [
    "claude+opus",
    "cursor+auto",
    "codex+gpt-6-sol:high",
  ]);
  assert.match(
    medium.reason,
    /^中活不按大小换：专员优先执行者在前、前端专员优先、claude 富余 \+30%/,
  );
});

test("pickView：候选里没有合这一档的组合时排序与理由同不按大小；不给大小时 size 为 null", () => {
  const base = facts({
    candidates: [cand("claude+opus"), cand("opencode+x")],
    pace: pace([
      ["claude", 10],
      ["opencode", 50],
    ]),
  });
  const plain = pickView(base);
  assert.equal(plain.size, null);
  assert.equal(plain.size_estimated, false);
  for (const size of SIZES) {
    const sized = pickView({ ...base, size: { size, estimated: false } });
    assert.deepEqual(order(sized), order(plain), size);
    assert.equal(sized.reason, plain.reason, size);
  }
});

test("pickView：紧急任务照旧按一次通过率与速度挑，不看大小", () => {
  const view = pickView(
    facts({
      urgent: true,
      candidates: [cand("cursor+auto"), cand("claude+opus")],
      pace: pace([
        ["cursor", 50],
        ["claude", 10],
      ]),
      records: new Map([
        [
          "claude+opus",
          { deliveries: 20, first_pass_rate: 0.9, low_data: false },
        ],
        [
          "cursor+auto",
          { deliveries: 20, first_pass_rate: 0.3, low_data: false },
        ],
      ]),
      size: { size: "small", estimated: false },
    }),
  );
  assert.equal(view.recommended, "claude+opus");
  assert.match(view.reason, /^紧急：/);
});

test("命令行文本：大小写在候选一览的抬头；按大小挑的回执写「挑了 X，因为小活…」", () => {
  const view = pickView(
    facts({
      candidates: smallPool,
      pace: pace([["cursor", 10]]),
      size: { size: "medium", estimated: true },
    }),
  );
  assert.match(
    formatPick({ ...view, task: "t1" }),
    /t1 · risk=low · 大小 中（没写，粗估） · 没指定/,
  );
  assert.match(
    formatPick({ ...pickView(facts({ candidates: smallPool })), task: "t1" }),
    /t1 · risk=low · 没指定/,
  );
  assert.deepEqual(
    pickLines({
      worker: "cursor+auto",
      auto: true,
      reason: "小活优先快且便宜的组合、cursor 富余 +10%",
      notice: null,
    }),
    ["挑了 cursor+auto，因为小活优先快且便宜的组合、cursor 富余 +10%"],
  );
  assert.deepEqual(
    pickLines({
      worker: "claude+opus",
      auto: true,
      reason: "claude 富余 +10%",
      notice: null,
    }),
    ["按额度挑了 claude+opus，因为claude 富余 +10%"],
  );
});

// ---- 写入与旧库 ----

test("建任务与修改：--size 存三档，写错用参数名报错，给空清掉回到粗估；建任务事件记下", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const small = createTask(db, { title: "小改", size: "小" });
  assert.equal(small.size, "small");
  const created = getTask(db, small.ref).events.find(
    (e) => e.kind === "created",
  );
  assert.equal(JSON.parse(created!.detail!).size, "small");
  const plain = createTask(db, { title: "没写" });
  assert.equal(plain.size, null);
  assert.equal(
    JSON.parse(
      getTask(db, plain.ref).events.find((e) => e.kind === "created")!.detail!,
    ).size,
    undefined,
  );
  assert.throws(
    () => createTask(db, { title: "坏", size: "特大" }),
    /size: 只能是 小、中 或 大/,
  );
  assert.equal(updateTask(db, plain.ref, { size: "large" }).size, "large");
  assert.equal(updateTask(db, plain.ref, { size: "" }).size, null);
  assert.equal(updateTask(db, small.ref, { size: null }).size, null);
  assert.throws(
    () => updateTask(db, small.ref, { size: 3 }),
    /size: 只能是 小、中 或 大/,
  );
  // 库里的约束也拦住坏值（绕过接口直接写）。
  assert.throws(() =>
    db.prepare("UPDATE tasks SET size='huge' WHERE id=1").run(),
  );
});

test("旧库补列：没有 size 列的旧账本启动时补上、旧任务为空，旧运行时表不读不写", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO tasks(title,status,created_at,updated_at) VALUES ('旧','todo',0,0);`);
  ensureTaskTables(db);
  ensureTaskTables(db);
  assert.equal(
    (db.prepare("SELECT size FROM tasks").get() as { size: string | null })
      .size,
    null,
  );
  assert.equal(updateTask(db, "t1", { size: "中" }).size, "medium");
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM agents").get() },
    { id: "x", name: "旧身份" },
  );
});

test("隔离服务：小活挑快且便宜的、没写大小挑高强度的，task set 改大小后跟着变；task run 回执写理由", async (t) => {
  const { call } = await startApp(
    t,
    (fx) => {
      // 装上 claude、codex、cursor-agent 的假命令（前置在 PATH 上，不碰本机真实的）。
      for (const name of ["claude", "codex", "cursor-agent"])
        writeFakeBin(join(fx.root, "bin", name), "#!/bin/sh\nexit 0\n");
    },
    async () => [
      { providerId: "claude", sparePercent: 50, usedPercent: 10 },
      { providerId: "codex", sparePercent: 30, usedPercent: 10 },
      { providerId: "cursor", sparePercent: 20, usedPercent: 10 },
      { providerId: "opencode", sparePercent: 70, usedPercent: 10 },
    ],
  );
  const add = async (extra: object) =>
    (
      await call("POST", "/api/tasks", {
        title: "活",
        deliver: "none",
        ...extra,
      })
    ).body as { ref: string; size: string | null };
  const small = await add({ size: "小" });
  assert.equal(small.size, "small");
  const quick = await call("GET", `/api/tasks/${small.ref}/pick`);
  assert.equal(quick.status, 200, JSON.stringify(quick.body));
  assert.equal(quick.body.size, "small");
  assert.equal(
    quick.body.recommended,
    "opencode+opencode-go/deepseek-v4.1-flash",
  );
  assert.match(
    quick.body.reason,
    /^小活优先快且便宜的组合、opencode 富余 \+70%/,
  );
  const plain = await add({});
  const strong = await call("GET", `/api/tasks/${plain.ref}/pick`);
  assert.equal(strong.body.size, "medium");
  assert.equal(strong.body.size_estimated, true);
  assert.equal(strong.body.recommended, "claude+opus:high");
  assert.match(
    strong.body.reason,
    /^中活（没写大小，按中估）优先高强度组合、claude 富余 \+50%/,
  );
  const set = await call("PATCH", `/api/tasks/${plain.ref}`, { size: "小" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.size, "small");
  assert.equal(
    (await call("GET", `/api/tasks/${plain.ref}/pick`)).body.recommended,
    "opencode+opencode-go/deepseek-v4.1-flash",
  );
  const bad = await call("POST", "/api/tasks", { title: "坏", size: "特大" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message ?? bad.body.error, /size: 只能是 小、中 或 大/);
  // 不写 --worker 派：按同一份排序挑，回执写理由。
  const run = await call("POST", `/api/tasks/${small.ref}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.pick.auto, true);
  assert.equal(
    run.body.pick.worker,
    "opencode+opencode-go/deepseek-v4.1-flash",
  );
  assert.equal(run.body.pick.reason, quick.body.reason);
  await call("GET", `/api/tasks/${small.ref}/wait?timeout=30`);
});
