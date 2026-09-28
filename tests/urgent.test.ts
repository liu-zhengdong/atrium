import { test } from "node:test";
import assert from "node:assert/strict";
import {
  avoidHostsOf,
  crowdWarning,
  markVerdict,
  mergeDecision,
  mergeHoldText,
  mergeYield,
  parseStopgap,
  pausedText,
  preemptPlan,
  resumeNote,
  resumePlan,
  stopgapJson,
  stopgapText,
  storedHosts,
  storedStopgap,
  swapDue,
  swapNote,
  urgentIdleMs,
  urgentOrder,
  urgentStage,
  whyOf,
  URGENT_MAX_SWAPS,
  type RunningSlot,
  type UrgentRival,
} from "../server/tasks/urgent.ts";
import {
  chooseHost,
  hostFit,
  type HostCandidate,
  type HostNeed,
} from "../server/hosts/state.ts";
import {
  chooseCheckHost,
  type CheckCandidate,
} from "../server/hosts/check-plan.ts";
import { planOnline } from "../server/tasks/online.ts";
import {
  pickView,
  type PickCandidateFact,
  type PickFacts,
} from "../server/tasks/pick.ts";
import type { Tool } from "../server/tasks/adapters/index.ts";
import { holderOf, type HolderFacts } from "../server/tasks/holder.ts";
import { decideExit } from "../server/tasks/outcome.ts";

/** 紧急通道（t215）的判定：谁能标、止损写法、抢占选谁、何时续上、合入暂停与让路、换人时机、挑人与挑主机。 */

test("谁能标：用户与秘书随时可标、不知会；leader 标紧急须写原因，写了就知会用户；取消紧急不管", () => {
  for (const why of [null, "线上满屏弹窗"]) {
    assert.deepEqual(
      markVerdict({ leader: undefined, urgent: true, why }),
      { ok: true, notify: false },
      "用户或秘书",
    );
    assert.deepEqual(markVerdict({ leader: "a1", urgent: false, why }), {
      ok: true,
      notify: false,
    });
  }
  const refused = markVerdict({ leader: "a1", urgent: true, why: null });
  assert.equal(refused.ok, false);
  assert.match(
    (refused as { reason: string }).reason,
    /^why: a1 标紧急须写原因/,
  );
  assert.deepEqual(markVerdict({ leader: "a2", urgent: true, why: "x" }), {
    ok: true,
    notify: true,
  });
});

test("原因：文本、空白压成一格、空为 null、超长或不是文本拒绝并说参数名", () => {
  assert.equal(whyOf(undefined), null);
  assert.equal(whyOf(null), null);
  assert.equal(whyOf("   "), null);
  assert.equal(whyOf("  满屏\n弹窗  "), "满屏 弹窗");
  assert.throws(() => whyOf(3), /^Error: why: 应为文本|why: 应为文本/);
  assert.throws(() => whyOf("字".repeat(301)), /why: 不能超过 300 字/);
  assert.equal(whyOf("字".repeat(300))?.length, 300);
});

test("太多紧急任务：多于 2 个才提示，不拒绝", () => {
  assert.equal(crowdWarning(0), null);
  assert.equal(crowdWarning(2), null);
  assert.equal(crowdWarning(3), "紧急任务有 3 个，太多就等于没有紧急");
});

test("避开的主机：hN 列表（逗号、中文逗号、空格或数组），去重；写错或太多拒绝；库里的坏记录当没写", () => {
  assert.deepEqual(avoidHostsOf(undefined), []);
  assert.deepEqual(avoidHostsOf(""), []);
  assert.deepEqual(avoidHostsOf("h3"), [3]);
  assert.deepEqual(avoidHostsOf("h3,h4，h3 h5"), [3, 4, 5]);
  assert.deepEqual(avoidHostsOf(["h2", "h2"]), [2]);
  for (const bad of ["3", "h0", "hx", ["h1", 2], 5, "h1;h2"])
    assert.throws(() => avoidHostsOf(bad), /avoid_host: 应为主机短号/);
  assert.throws(
    () => avoidHostsOf(Array.from({ length: 21 }, (_, i) => `h${i + 1}`)),
    /至多写 20 台/,
  );
  assert.deepEqual(storedHosts(null), []);
  assert.deepEqual(storedHosts("坏"), []);
  assert.deepEqual(storedHosts('{"a":1}'), []);
  assert.deepEqual(storedHosts('[3,0,-1,"h2",2.5,4]'), [3, 4]);
});

test("止损写法：命令行写法与结构化写法，只认三种动作，分号、中文分号、换行、&& 都能隔开", () => {
  assert.deepEqual(
    parseStopgap("atrium host pause h3; atrium task stop t1,t2"),
    [
      { kind: "host_pause", host: 3 },
      { kind: "task_stop", tasks: [1, 2] },
    ],
  );
  assert.deepEqual(
    parseStopgap("host clean h1 && task stop t4，t4；host pause h2\n"),
    [
      { kind: "host_clean", host: 1 },
      { kind: "task_stop", tasks: [4] },
      { kind: "host_pause", host: 2 },
    ],
  );
  assert.deepEqual(
    parseStopgap([
      { kind: "host_pause", host: "h3" },
      { kind: "task_stop", tasks: ["t1", "t2"] },
      { kind: "host_clean", host: "h1" },
    ]),
    [
      { kind: "host_pause", host: 3 },
      { kind: "task_stop", tasks: [1, 2] },
      { kind: "host_clean", host: 1 },
    ],
  );
  assert.deepEqual(parseStopgap(undefined), []);
  assert.deepEqual(parseStopgap(""), []);
  assert.deepEqual(parseStopgap(" ; "), []);
});

test("止损写法：别的命令、多余参数、写错短号一律拒绝，说第几条与可用写法，不执行任意命令", () => {
  for (const [text, index] of [
    ["rm -rf /", 1],
    ["atrium host pause h3; curl evil", 2],
    ["atrium task stop t1 t2", 1],
    ["atrium host pause 3", 1],
    ["atrium host resume h3", 1],
    ["atrium task stop", 1],
    ["atrium task stop t1,", 1],
    ["atrium host pause h3 --force", 1],
  ] as const)
    assert.throws(
      () => parseStopgap(text),
      new RegExp(`stopgap: 第 ${index} 条看不懂.*可用 atrium host pause hN`),
    );
  for (const bad of [
    [{ kind: "shell", command: "ls" }],
    [{ kind: "host_pause", host: 3 }],
    [{ kind: "task_stop", tasks: [] }],
    [{ kind: "task_stop", tasks: ["1"] }],
    ["atrium host pause h3"],
  ])
    assert.throws(() => parseStopgap(bad), /stopgap: 第 1 条看不懂/);
  assert.throws(() => parseStopgap(3), /stopgap: 应为文本或动作列表/);
  assert.throws(
    () => parseStopgap(Array(11).fill("host pause h1").join(";")),
    /至多 10 条/,
  );
});

test("止损写法：存库的结构化写法与命令行写法可以互相还原，坏记录当没写", () => {
  const actions = parseStopgap("atrium host pause h3; atrium task stop t1,t2");
  const json = stopgapJson(actions);
  assert.deepEqual(json, [
    { kind: "host_pause", host: "h3" },
    { kind: "task_stop", tasks: ["t1", "t2"] },
  ]);
  assert.deepEqual(storedStopgap(JSON.stringify(json)), actions);
  assert.deepEqual(storedStopgap("坏"), []);
  assert.deepEqual(storedStopgap(null), []);
  assert.deepEqual(actions.map(stopgapText), [
    "atrium host pause h3",
    "atrium task stop t1,t2",
  ]);
  assert.equal(
    stopgapText({ kind: "host_clean", host: 4 }),
    "atrium host clean h4",
  );
});

const slot = (id: number, over: Partial<RunningSlot> = {}): RunningSlot => ({
  id,
  tool: "kimi",
  host: 1,
  urgent: false,
  idle: false,
  startedAt: id * 1000,
  stopping: false,
  ...over,
});
const plan = (
  running: RunningSlot[],
  over: Partial<Parameters<typeof preemptPlan>[0]> = {},
) =>
  preemptPlan({
    self: 99,
    host: 1,
    tool: "kimi",
    exclusive: false,
    crowded: true,
    running,
    ...over,
  });

test("抢占：不满不忙、独占工具也空着时谁都不停", () => {
  assert.deepEqual(
    plan([slot(1), slot(2, { idle: true })], { crowded: false }),
    {
      victims: [],
      wait: false,
    },
  );
  assert.deepEqual(
    plan([slot(1, { tool: "claude" })], {
      crowded: false,
      exclusive: true,
      tool: "opencode",
    }),
    { victims: [], wait: false },
  );
});

test("抢占：满了先停闲时的，同一档先停最晚拉起的；再没有闲时才停普通的；紧急的、在停的、别的主机上的、自己都不选", () => {
  const running = [
    slot(1),
    slot(2),
    slot(3, { idle: true, startedAt: 5000 }),
    slot(4, { idle: true, startedAt: 9000 }),
    slot(5, { urgent: true, startedAt: 99_000 }),
    slot(6, { idle: true, stopping: true, startedAt: 99_000 }),
    slot(7, { idle: true, host: 2, startedAt: 99_000 }),
    slot(99, { idle: true, startedAt: 99_000 }),
  ];
  assert.deepEqual(plan(running).victims, [{ id: 4, why: "slot" }]);
  const normals = running.filter((s) => !s.idle || s.host !== 1 || s.stopping);
  assert.deepEqual(plan(normals).victims, [{ id: 2, why: "slot" }]);
  // 同一时刻拉起的按任务号，后建的先停。
  assert.deepEqual(
    plan([slot(1, { startedAt: 1 }), slot(2, { startedAt: 1 })]).victims,
    [{ id: 2, why: "slot" }],
  );
  // 只剩紧急的或在停的：照旧超额拉起，不等。
  assert.deepEqual(
    plan([slot(5, { urgent: true }), slot(6, { stopping: true })]),
    { victims: [], wait: false },
  );
  // 远程主机满：只在那台上找。
  assert.deepEqual(plan(running, { host: 2 }).victims, [
    { id: 7, why: "slot" },
  ]);
});

test("抢占：独占工具被普通任务占着就停它并等它让出（也腾出了名额，不再多停）；被紧急或在停的占着只等", () => {
  const opencode = { exclusive: true, tool: "opencode" };
  const running = [
    slot(1, { idle: true, startedAt: 9000 }),
    slot(2, { tool: "opencode" }),
  ];
  assert.deepEqual(plan(running, opencode), {
    victims: [{ id: 2, why: "exclusive" }],
    wait: true,
  });
  assert.deepEqual(plan(running, { ...opencode, crowded: false }), {
    victims: [{ id: 2, why: "exclusive" }],
    wait: true,
  });
  assert.deepEqual(
    plan(
      [slot(1, { idle: true }), slot(2, { tool: "opencode", urgent: true })],
      opencode,
    ),
    { victims: [], wait: true },
  );
  assert.deepEqual(
    plan(
      [slot(1, { idle: true }), slot(2, { tool: "opencode", stopping: true })],
      opencode,
    ),
    { victims: [], wait: true },
  );
  // 别的主机上的同一工具不算占着。
  assert.deepEqual(
    plan(
      [slot(1, { idle: true }), slot(2, { tool: "opencode", host: 2 })],
      opencode,
    ),
    { victims: [{ id: 1, why: "slot" }], wait: false },
  );
});

test("暂停与续上的说法：写明被哪件紧急任务、为什么、之后怎么接着做", () => {
  assert.match(
    pausedText(7, "slot"),
    /被紧急任务 t7 抢占暂停（让出执行者名额）/,
  );
  assert.match(pausedText(7, "exclusive"), /让出独占执行者/);
  assert.match(resumeNote(7, true), /紧急任务 t7.*接着把原任务做完/);
  assert.match(resumeNote(null, false), /工作树与分支都保留着.*不要从头重来/);
  assert.match(
    swapNote("grok", "紧急任务的执行者 10 分钟没有进展"),
    /前一位执行者（grok）/,
  );
});

test("续上：还有紧急任务在跑、启动或排队就都等；清空后按暂停先后续上受阻的；已在动的留着，被人改了状态的不再管", () => {
  const paused = [
    { task: 1, status: "blocked", moving: false },
    { task: 2, status: "cancelled", moving: false },
    { task: 3, status: "todo", moving: true },
    { task: 4, status: "blocked", moving: false },
    { task: 5, status: "failed", moving: false },
  ];
  assert.deepEqual(resumePlan({ urgentBusy: 1, paused }), {
    resume: [],
    drop: [2, 5],
  });
  assert.deepEqual(resumePlan({ urgentBusy: 0, paused }), {
    resume: [1, 4],
    drop: [2, 5],
  });
  assert.deepEqual(resumePlan({ urgentBusy: 0, paused: [] }), {
    resume: [],
    drop: [],
  });
});

test("合入队列：队首紧急的照做；普通的只要还有别的紧急任务在合入流程里就暂停", () => {
  assert.deepEqual(mergeDecision({ next: null, urgentFlow: [3] }), {
    kind: "idle",
  });
  assert.deepEqual(
    mergeDecision({ next: { id: 3, urgent: true }, urgentFlow: [3, 4] }),
    { kind: "run", id: 3 },
  );
  assert.deepEqual(
    mergeDecision({ next: { id: 5, urgent: false }, urgentFlow: [] }),
    { kind: "run", id: 5 },
  );
  assert.deepEqual(
    mergeDecision({ next: { id: 5, urgent: false }, urgentFlow: [5] }),
    { kind: "run", id: 5 },
  );
  assert.deepEqual(
    mergeDecision({ next: { id: 5, urgent: false }, urgentFlow: [3, 4] }),
    { kind: "hold", by: [3, 4] },
  );
  assert.equal(
    mergeHoldText([3, 4]),
    "紧急任务 t3、t4 先合入上线，之后接着合入",
  );
});

test("合入让路：正在合入的普通任务、还没发出 gh 合入、有紧急的在等才让", () => {
  for (const urgent of [false, true])
    for (const committed of [false, true])
      for (const urgentWaiting of [false, true])
        assert.equal(
          mergeYield({ current: { urgent, committed }, urgentWaiting }),
          !urgent && !committed && urgentWaiting,
          `urgent=${urgent} committed=${committed} waiting=${urgentWaiting}`,
        );
  assert.equal(mergeYield({ current: null, urgentWaiting: true }), false);
});

test("换人时机：紧急任务从最近一次进展（没有就从拉起）算起超过时限就换；不紧急、在停、换够次数的不换", () => {
  const base = {
    urgent: true,
    stopping: false,
    startedAt: 0,
    lastProgressAt: null as number | null,
    now: 600_000,
    limitMs: 600_000,
    swaps: 0,
  };
  assert.deepEqual(swapDue(base), {
    kind: "swap",
    reason: "紧急任务的执行者 10 分钟没有进展，换执行者接着做",
  });
  assert.equal(swapDue({ ...base, now: 599_999 }).kind, "ok");
  assert.equal(swapDue({ ...base, lastProgressAt: 1 }).kind, "ok");
  assert.equal(
    swapDue({ ...base, lastProgressAt: 1, now: 600_001 }).kind,
    "swap",
  );
  assert.equal(swapDue({ ...base, urgent: false }).kind, "ok");
  assert.equal(swapDue({ ...base, stopping: true }).kind, "ok");
  assert.equal(swapDue({ ...base, swaps: URGENT_MAX_SWAPS }).kind, "ok");
  assert.equal(swapDue({ ...base, swaps: URGENT_MAX_SWAPS - 1 }).kind, "swap");
  assert.equal(swapDue({ ...base, swaps: 1, maxSwaps: 1 }).kind, "ok");
  assert.match(
    (swapDue({ ...base, limitMs: 90_000, now: 90_000 }) as { reason: string })
      .reason,
    /90 秒没有进展/,
  );
});

test("换人时限配置：缺省 10 分钟，可写小数分钟；写错或超过一天照缺省并说清", () => {
  assert.deepEqual(urgentIdleMs({}), { ms: 600_000, problem: null });
  assert.deepEqual(urgentIdleMs({ ATRIUM_URGENT_IDLE_MINUTES: "5" }), {
    ms: 300_000,
    problem: null,
  });
  assert.deepEqual(urgentIdleMs({ ATRIUM_URGENT_IDLE_MINUTES: " 0.5 " }), {
    ms: 30_000,
    problem: null,
  });
  for (const bad of ["0", "-1", "abc", "2000"]) {
    const read = urgentIdleMs({ ATRIUM_URGENT_IDLE_MINUTES: bad });
    assert.equal(read.ms, 600_000);
    assert.match(read.problem!, /看不懂，按缺省 10 分钟/);
  }
});

const rival = (
  index: number,
  over: Partial<UrgentRival> = {},
): UrgentRival => ({
  busy: false,
  firstPass: null,
  lowData: false,
  medianMs: null,
  index,
  ...over,
});
const order = (rivals: UrgentRival[]) =>
  [...rivals].sort(urgentOrder).map((r) => r.index);

test("紧急挑人：先不忙的，再一次通过率（记录少的向 0.5 收拢），差不到 5 个点看谁快，最后按原顺序", () => {
  assert.deepEqual(
    order([
      rival(0, { busy: true, firstPass: 1 }),
      rival(1, { firstPass: 0.2 }),
    ]),
    [1, 0],
  );
  assert.deepEqual(
    order([rival(0, { firstPass: 0.6 }), rival(1, { firstPass: 0.9 })]),
    [1, 0],
  );
  // 记录少：1.0 收拢成 0.75，不如记录足的 0.8。
  assert.deepEqual(
    order([
      rival(0, { firstPass: 1, lowData: true }),
      rival(1, { firstPass: 0.8 }),
    ]),
    [1, 0],
  );
  // 没记录按 0.5：比 0.3 的强、比 0.7 的弱。
  assert.deepEqual(
    order([
      rival(0, { firstPass: 0.3 }),
      rival(1),
      rival(2, { firstPass: 0.7 }),
    ]),
    [2, 1, 0],
  );
  // 差不到 5 个点：快的在前，没耗时数据的在后。
  assert.deepEqual(
    order([
      rival(0, { firstPass: 0.8, medianMs: 900_000 }),
      rival(1, { firstPass: 0.82, medianMs: null }),
      rival(2, { firstPass: 0.78, medianMs: 300_000 }),
    ]),
    [2, 0, 1],
  );
  assert.deepEqual(order([rival(1), rival(0)]), [0, 1]);
});

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
const facts = (over: Partial<PickFacts> = {}): PickFacts => ({
  risk: "low",
  job: null,
  candidates: [cand("claude"), cand("codex"), cand("kimi")],
  pace: [
    { providerId: "claude", sparePercent: 80, usedPercent: 10 },
    { providerId: "codex", sparePercent: 5, usedPercent: 60 },
    { providerId: "kimi", sparePercent: 40, usedPercent: 30 },
  ],
  held: new Map(),
  reservePercent: 20,
  headroom: new Map(),
  busy: new Set(),
  chain: [],
  records: new Map([
    [
      "claude",
      {
        deliveries: 20,
        first_pass_rate: 0.5,
        low_data: false,
        median_ms: 600_000,
      },
    ],
    [
      "codex",
      {
        deliveries: 30,
        first_pass_rate: 0.9,
        low_data: false,
        median_ms: 1_200_000,
      },
    ],
    [
      "kimi",
      {
        deliveries: 30,
        first_pass_rate: 0.88,
        low_data: false,
        median_ms: 300_000,
      },
    ],
  ]),
  ...over,
});

test("紧急挑人接进候选一览：不看额度富余，按一次通过率与速度；普通任务照旧按额度", () => {
  assert.equal(pickView(facts()).recommended, "claude", "普通任务按富余");
  const urgent = pickView(facts({ urgent: true }));
  assert.equal(urgent.recommended, "kimi", "通过率差不到 5 个点，kimi 更快");
  assert.match(
    urgent.reason,
    /^紧急：不看额度富余.*kimi 一次通过率 88%、中位 5 分钟/,
  );
  // 不能接的（额度用尽）照样不能接：紧急不放宽额度保留。
  const held = pickView(
    facts({ urgent: true, held: new Map([["kimi", Date.now() + 60_000]]) }),
  );
  assert.equal(held.recommended, "codex");
});

const hostLocal = (over: Partial<HostCandidate> = {}): HostCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  clis: null,
  repos: ["*"],
  running: 0,
  max: 2,
  busy: null,
  ...over,
});
const hostRemote = (
  id: number,
  over: Partial<HostCandidate> = {},
): HostCandidate => ({
  id,
  kind: "remote",
  connection: "online",
  paused: false,
  clis: { kimi: { installed: true, logged_in: null } },
  repos: ["*"],
  running: 0,
  max: 4,
  busy: null,
  ...over,
});
const need = (over: Partial<HostNeed> = {}): HostNeed => ({
  tool: "kimi",
  repo: "o/r",
  urgent: false,
  localOnly: null,
  ...over,
});

test("挑主机：任务写了避开的主机自动挑与指定都不派；紧急的先挑不用抢占的，同样时本机优先", () => {
  const busyLocal = hostLocal({ running: 2 });
  assert.deepEqual(hostFit(hostRemote(3), need({ avoid: [3] }), true), {
    ok: false,
    kind: "never",
    reason: "任务写了避开 h3（--avoid-host）",
  });
  assert.deepEqual(
    chooseHost([hostLocal(), hostRemote(3)], need({ avoid: [3] }), 3),
    { kind: "refuse", reason: "任务写了避开 h3（--avoid-host）" },
  );
  // 普通任务：本机满了去远程。
  assert.deepEqual(chooseHost([busyLocal, hostRemote(3)], need()), {
    kind: "run",
    host: 3,
  });
  // 紧急的：本机满（要抢占）而远程空着，去远程；远程被避开就回本机抢占。
  assert.deepEqual(
    chooseHost([busyLocal, hostRemote(3)], need({ urgent: true })),
    { kind: "run", host: 3 },
  );
  assert.deepEqual(
    chooseHost([busyLocal, hostRemote(3)], need({ urgent: true, avoid: [3] })),
    { kind: "run", host: 1 },
  );
  // 紧急的：都不满时本机优先（即使远程更空）。
  assert.deepEqual(
    chooseHost(
      [hostLocal({ running: 1 }), hostRemote(3)],
      need({ urgent: true }),
    ),
    { kind: "run", host: 1 },
  );
  // 远程太忙（代理报的）也算要抢占。
  assert.deepEqual(
    chooseHost(
      [
        busyLocal,
        hostRemote(3, { busy: "太忙" }),
        hostRemote(4, { running: 3 }),
      ],
      need({ urgent: true }),
    ),
    { kind: "run", host: 4 },
  );
});

const checkLocal = (over: Partial<CheckCandidate> = {}): CheckCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  repos: ["*"],
  cpus: 8,
  load: 16,
  running: 2,
  max: 2,
  busy: null,
  platform: "darwin",
  ...over,
});
const checkRemote = (id: number): CheckCandidate => ({
  id,
  kind: "remote",
  connection: "online",
  paused: false,
  repos: ["*"],
  cpus: 8,
  load: 0,
  running: 0,
  max: 2,
  busy: null,
  platform: "darwin",
});

test("检查派哪台：紧急的本机能跑就在本机（立刻跑、不占名额）；避开的主机不派；普通的照旧挑空的", () => {
  const candidates = [checkLocal(), checkRemote(3)];
  assert.deepEqual(
    chooseCheckHost(candidates, {
      repo: "o/r",
      platform: "darwin",
      urgent: false,
    }),
    {
      host: 3,
      kind: "remote",
    },
  );
  assert.deepEqual(
    chooseCheckHost(candidates, {
      repo: "o/r",
      platform: "darwin",
      urgent: true,
    }),
    {
      host: 1,
      kind: "local",
    },
  );
  assert.deepEqual(
    chooseCheckHost(candidates, {
      repo: "o/r",
      platform: "darwin",
      urgent: false,
      avoid: [3],
    }),
    { host: 1, kind: "local" },
  );
  // 本机不是检查基准平台（仓库另配了基准）：紧急的也去基准平台的主机。
  assert.deepEqual(
    chooseCheckHost([checkLocal({ platform: "win32" }), checkRemote(3)], {
      repo: "o/r",
      platform: "darwin",
      urgent: true,
    }),
    { host: 3, kind: "remote" },
  );
  // 本机暂停接活时紧急的也去远程（避开的除外）。
  assert.deepEqual(
    chooseCheckHost([checkLocal({ paused: true }), checkRemote(3)], {
      repo: "o/r",
      platform: "darwin",
      urgent: true,
    }),
    { host: 3, kind: "remote" },
  );
});

test("上线：有紧急任务要上线时只等别的紧急任务合入与重启，普通任务的合入不挡", () => {
  const behind = (urgent: boolean) => [
    { id: 1, release: "0.1.9", attempted: null, urgent },
  ];
  assert.equal(
    planOnline(behind(false), "0.1.8", { selfUpdate: true, busy: true }).deploy,
    null,
  );
  assert.equal(
    planOnline(behind(true), "0.1.8", {
      selfUpdate: true,
      busy: true,
      urgentBusy: false,
    }).deploy,
    "0.1.9",
  );
  assert.equal(
    planOnline(behind(true), "0.1.8", {
      selfUpdate: true,
      busy: false,
      urgentBusy: true,
    }).deploy,
    null,
  );
  // 没给 urgentBusy 时照旧看 busy。
  assert.equal(
    planOnline(behind(true), "0.1.8", { selfUpdate: true, busy: true }).deploy,
    null,
  );
});

test("阶段推送：开始、止损、抢占、交付、检查、合入、上线、失败、受阻、卡死、换人各有说法，其余不推", () => {
  const stages: [string, string | null][] = [
    ["start", "开始"],
    ["stopgap", "止损"],
    ["preempting", "抢占"],
    ["merge_queued", "交付"],
    ["review_queued", "交付"],
    ["done", "交付"],
    ["local_check_started", "检查"],
    ["merge_check_started", "检查"],
    ["merged", "合入"],
    ["online", "上线"],
    ["online_failed", "上线失败"],
    ["failed", "失败"],
    ["blocked", "受阻"],
    ["stalled", "卡死重试"],
    ["urgent_swap", "换人"],
    ["merge_rebased", null],
    ["ci_success", null],
    ["resumed", null],
  ];
  for (const [kind, stage] of stages)
    assert.equal(urgentStage(kind), stage, kind);
});

const holderBase: HolderFacts = {
  status: "blocked",
  delivery_stage: null,
  online_wait: 0,
  worker: "kimi",
  queued: null,
  review_task: null,
  schedule_state: null,
  schedule_reason: null,
  waiting_for: [],
  auto: false,
  block: { reason: pausedText(7, "slot"), gates: [] },
  returned: null,
  merge_returned: null,
  escalated: null,
  processing_by: null,
  inbox: null,
  route: "secretary",
  council_escalated: false,
};

test("持球人：被抢占暂停的由运行时自己续上；暂停中的合入写明在等哪件紧急任务", () => {
  assert.deepEqual(holderOf({ ...holderBase, preempted: { by: "t7" } }), {
    kind: "queue",
    who: null,
    text: "被紧急 t7 抢占暂停，之后自动续上",
  });
  assert.equal(holderOf(holderBase)?.kind, "secretary");
  const queued = {
    ...holderBase,
    status: "done" as const,
    delivery_stage: "merge_queued" as const,
    block: null,
  };
  assert.equal(holderOf(queued)?.text, "排队合入");
  assert.equal(
    holderOf({ ...queued, merge_held_by: ["t7", "t8"] })?.text,
    "合入暂停：等紧急 t7、t8 先上线",
  );
});

test("收尾兜底：抢占与换人没被运行时接手时按受阻留给人看，不重试", () => {
  assert.deepEqual(
    decideExit({
      stop: { kind: "preempt", by: 7, why: "slot" },
      exit: { code: null, signal: "SIGTERM" },
      retried: false,
      retryAllowed: true,
    }),
    {
      event: "block",
      publish: "blocked",
      reason: "被紧急任务 t7 抢占暂停",
      retry: false,
    },
  );
  assert.deepEqual(
    decideExit({
      stop: { kind: "swap", reason: "没进展", to: "codex" },
      exit: "unknown",
      retried: false,
      retryAllowed: true,
    }),
    { event: "block", publish: "blocked", reason: "没进展", retry: false },
  );
});
