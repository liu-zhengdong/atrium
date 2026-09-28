import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountOf,
  NOTICE_SPARE_GAP,
  pickView,
  refusalsOf,
  richerAlternative,
  signedPercent,
  trusted,
  writtenNotice,
  type PickCandidateFact,
  type PickFacts,
} from "../server/tasks/pick.ts";
import type { Tool } from "../server/tasks/adapters/index.ts";
import type { PaceEntry } from "../server/tasks/prepare.ts";
import { formatPick, pickLines } from "../cli/tasks.ts";

/** 候选一览（task pick）的纯函数：判定、排序、理由与写死执行者的提醒。 */

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

const pace = (rows: [string, number | null, number?][]): PaceEntry[] =>
  rows.map(([providerId, sparePercent, usedPercent]) => ({
    providerId,
    sparePercent,
    usedPercent: usedPercent ?? null,
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

test("signedPercent：正数带加号、负数用减号、零不带符号，四舍五入", () => {
  assert.equal(signedPercent(54), "+54%");
  assert.equal(signedPercent(-13.4), "−13%");
  assert.equal(signedPercent(0.2), "0%");
  assert.equal(signedPercent(-0.4), "0%");
});

test("accountOf：多窗口已用取最大、富余取最小、距重置取最紧窗口；标记与剩余份额原样带上", () => {
  const q = accountOf("claude", {
    pace: [
      {
        providerId: "claude",
        sparePercent: 30,
        usedPercent: 40,
        hoursToReset: 100,
      },
      {
        providerId: "claude",
        sparePercent: 5,
        usedPercent: 70,
        hoursToReset: 3,
      },
      { providerId: "codex", sparePercent: 90, usedPercent: 1 },
    ],
    held: new Map([["claude", 123]]),
    headroom: new Map([["claude", { points: 10, reason: "保留 20%" }]]),
  });
  assert.deepEqual(q, {
    account: "claude",
    used_percent: 70,
    spare_percent: 5,
    hours_to_reset: 3,
    left_percent: 10,
    left_reason: "保留 20%",
    held_until: 123,
    stale: false,
    refreshed_hours_ago: null,
  });
  const none = accountOf("kimi", {
    held: new Map(),
    headroom: new Map(),
  });
  assert.equal(none.spare_percent, null);
  assert.equal(none.used_percent, null);
  assert.equal(none.hours_to_reset, null);
  assert.equal(none.held_until, null);
});

test("refusalsOf：逐项列出不能接的原因，能接为空", () => {
  const f = facts({
    risk: "high",
    job: { ref: "r1", name: "前端" },
    pace: pace([
      ["codex", -13, 85],
      ["claude", 54, 10],
    ]),
    held: new Map([["kimi", Date.UTC(2026, 8, 27, 6, 0)]]),
    headroom: new Map([
      ["codex", { points: -5, reason: "codex 份额用完" }],
      [
        "claude",
        { points: 0.5, reason: "o3 在 claude 的份额 10，本窗口已用约 9.5" },
      ],
    ]),
    chain: [{ id: 1, ref: "o1", path: "org" }],
  });
  assert.deepEqual(refusalsOf(cand("claude+opus"), f), [
    "o3 在 claude 的份额 10，本窗口已用约 9.5",
  ]);
  assert.deepEqual(
    refusalsOf(cand("codex+gpt-6-sol", { rules: { max_risk: "medium" } }), f),
    [
      "档案 max_risk=medium，低于任务 risk=high",
      "已用额度 85% 达到上限 80%（须留 20% 给用户）",
    ],
  );
  const kimi = refusalsOf(
    cand("kimi", {
      installed: false,
      rules: {
        avoid_jobs: ["r1"],
        avoid_nodes: ["o1"],
        billing: "metered",
      },
    }),
    f,
  );
  assert.equal(kimi[0], "没装：PATH 上找不到 kimi");
  assert.equal(kimi[1], "档案 avoid_jobs 避开专员 前端");
  assert.match(kimi[2]!, /^档案 avoid_nodes 避开 o1/);
  assert.match(kimi[3]!, /^额度用尽至 .*\d\d:\d\d$/);
  assert.equal(kimi[4], "档案 billing=metered（按量计费），不派");
  // 没有 pace 时份额（headroom）不拦。
  assert.deepEqual(
    refusalsOf(cand("claude+opus"), { ...f, pace: undefined }),
    [],
  );
});

test("pickView：没有专员时按富余从多到少，没有富余数据的在后按固定顺序；不能接的排最后", () => {
  const view = pickView(
    facts({
      candidates: [
        cand("codex+gpt-6-sol"),
        cand("opencode+x"),
        cand("claude+opus"),
        cand("grok+g"),
        cand("kimi", { rules: { max_risk: "low" }, installed: false }),
      ],
      pace: pace([
        ["codex", -13, 50],
        ["claude", 54, 10],
        ["opencode", 20, 10],
      ]),
    }),
  );
  assert.deepEqual(
    view.candidates.map((c) => [c.worker, c.rank]),
    [
      ["claude+opus", 1],
      ["opencode+x", 2],
      ["codex+gpt-6-sol", 3],
      ["grok+g", 4],
      ["kimi", null],
    ],
  );
  assert.equal(view.recommended, "claude+opus");
  assert.equal(view.quota_known, true);
  assert.equal(
    view.reason,
    "claude 富余 +54%；opencode 富余 +20%；codex 富余 −13%",
  );
});

test("pickView：旧数不算富余，排在有新数的之后，理由与表格写「旧数（N 小时前）」", () => {
  const view = pickView(
    facts({
      candidates: [cand("claude+opus"), cand("grok+g"), cand("kimi")],
      pace: [
        {
          providerId: "grok",
          sparePercent: 80,
          usedPercent: 5,
          stale: true,
          refreshedHoursAgo: 2.5,
        },
        { providerId: "kimi", sparePercent: 10, usedPercent: 40 },
        {
          providerId: "claude",
          sparePercent: 60,
          usedPercent: 10,
          stale: true,
          refreshedHoursAgo: 0.2,
        },
      ],
    }),
  );
  assert.deepEqual(
    view.candidates.map((c) => c.worker),
    ["kimi", "claude+opus", "grok+g"],
  );
  const grok = view.candidates.find((c) => c.tool === "grok")!.quota;
  assert.deepEqual(
    [
      grok.spare_percent,
      grok.used_percent,
      grok.stale,
      grok.refreshed_hours_ago,
    ],
    [null, 5, true, 2.5],
  );
  assert.equal(view.reason, "kimi 富余 +10%");
  assert.match(
    formatPick({ ...view, task: "t1" }),
    /grok 旧数（2\.5 小时前），已用 5%/,
  );

  const allStale = pickView(
    facts({
      candidates: [cand("grok+g"), cand("claude+opus")],
      pace: [
        {
          providerId: "grok",
          sparePercent: 80,
          stale: true,
          refreshedHoursAgo: 2.5,
        },
        {
          providerId: "claude",
          sparePercent: -60,
          stale: true,
          refreshedHoursAgo: 2,
        },
      ],
    }),
  );
  assert.equal(allStale.recommended, "claude+opus", "旧数都不算，退回固定顺序");
  assert.equal(allStale.reason, "claude 旧数（2 小时前），不按它排富余");
});

test("pickView：理由只对照两个相关账号，其余看表格", () => {
  const view = pickView(
    facts({
      candidates: [
        cand("claude+opus"),
        cand("codex+c"),
        cand("opencode+x"),
        cand("grok+g"),
        cand("kimi"),
      ],
      pace: pace([
        ["claude", 60, 10],
        ["codex", 40, 10],
        ["opencode", 30, 10],
        ["grok", 20, 10],
        ["kimi", 10, 10],
      ]),
    }),
  );
  assert.equal(
    view.reason,
    "claude 富余 +60%；codex 富余 +40%；opencode 富余 +30%",
  );
});

test("pickView：额度数据不可用时按固定顺序 claude、codex、opencode、grok、kimi", () => {
  const view = pickView(
    facts({
      candidates: [cand("kimi"), cand("codex+c"), cand("claude+opus")],
    }),
  );
  assert.deepEqual(
    view.candidates.map((c) => c.worker),
    ["claude+opus", "codex+c", "kimi"],
  );
  assert.equal(view.quota_known, false);
  assert.equal(view.reason, "额度数据不可用，按固定顺序");
});

test("pickView：专员候选能接、不正忙的按专员顺序在前，即使别的账号更富余", () => {
  const view = pickView(
    facts({
      job: { ref: "r1", name: "前端" },
      candidates: [
        cand("codex+gpt-6-sol:high", {
          preferred: 0,
          rules: { max_risk: "low" },
        }),
        cand("claude+opus:high", { preferred: 1 }),
        cand("codex+gpt-6-sol"),
        cand("claude+opus"),
      ],
      risk: "medium",
      pace: pace([
        ["codex", 80, 10],
        ["claude", 10, 30],
      ]),
      records: new Map([
        [
          "claude+opus:high",
          { deliveries: 6, first_pass_rate: 0.5, low_data: false },
        ],
      ]),
    }),
  );
  assert.deepEqual(
    view.candidates.map((c) => [c.worker, c.rank, c.preferred]),
    [
      ["claude+opus:high", 1, 2],
      ["codex+gpt-6-sol", 2, null],
      ["claude+opus", 3, null],
      ["codex+gpt-6-sol:high", null, 1],
    ],
  );
  assert.equal(view.recommended, "claude+opus:high");
  assert.equal(
    view.reason,
    "前端专员优先、claude 富余 +10%；codex 富余 +80%；codex+gpt-6-sol:high 不能接：档案 max_risk=low，低于任务 risk=medium",
  );
  assert.deepEqual(view.candidates[0]!.record, {
    deliveries: 6,
    first_pass_rate: 0.5,
    low_data: false,
  });
});

test("pickView：专员第 1 选超速、第 2 选富余多出 30 点以上时改推荐第 2 选，理由只列这两个账号", () => {
  const view = pickView(
    facts({
      job: { ref: "r2", name: "后端" },
      candidates: [
        cand("codex+gpt-6-sol:high", { preferred: 0 }),
        cand("claude+opus:high", { preferred: 1 }),
        cand("opencode+x"),
        cand("grok+g"),
      ],
      pace: pace([
        ["codex", -17, 60],
        ["claude", 52, 20],
        ["opencode", 80, 5],
        ["grok", 10, 5],
      ]),
    }),
  );
  assert.equal(view.recommended, "claude+opus:high");
  assert.deepEqual(
    view.candidates.map((c) => [c.worker, c.rank]),
    [
      ["claude+opus:high", 1],
      ["codex+gpt-6-sol:high", 2],
      ["opencode+x", 3],
      ["grok+g", 4],
    ],
  );
  assert.equal(
    view.reason,
    "后端专员第 1 选 codex+gpt-6-sol:high 超速（codex −17%），改用第 2 选 claude+opus:high（claude +52%）",
  );
  // 按推荐去派不提醒；写专员第 1 选则提醒推荐的那位。
  const codex = { worker: "codex+gpt-6-sol:high", tool: "codex" as Tool };
  assert.equal(
    writtenNotice(
      view,
      { worker: "claude+opus:high", tool: "claude" as Tool },
      "t9",
    ),
    null,
  );
  assert.match(
    writtenNotice(view, codex, "t9")!,
    /^提醒：claude\+opus:high 同样能接，claude 富余 \+52%，比 codex\+gpt-6-sol:high 的 codex（−17%）多 69 个百分点/,
  );
});

test("pickView：专员第 1 选超速、只有非专员候选富余时改推荐它", () => {
  const view = pickView(
    facts({
      job: { ref: "r2", name: "后端" },
      candidates: [cand("codex+c", { preferred: 0 }), cand("claude+opus")],
      pace: pace([
        ["codex", -17, 60],
        ["claude", 52, 20],
      ]),
    }),
  );
  assert.equal(view.recommended, "claude+opus");
  assert.equal(
    view.reason,
    "后端专员第 1 选 codex+c 超速（codex −17%），改用 claude+opus（claude +52%）",
  );
});

test("pickView：两边都富余时仍按专员顺序，按推荐去派不提醒", () => {
  const view = pickView(
    facts({
      job: { ref: "r2", name: "后端" },
      candidates: [
        cand("codex+c", { preferred: 0 }),
        cand("claude+opus", { preferred: 1 }),
      ],
      pace: pace([
        ["codex", 5, 30],
        ["claude", 90, 5],
      ]),
    }),
  );
  assert.equal(view.recommended, "codex+c");
  assert.equal(view.reason, "后端专员优先、codex 富余 +5%；claude 富余 +90%");
  assert.equal(
    writtenNotice(view, { worker: "codex+c", tool: "codex" }, "t9"),
    null,
  );
});

test("pickView：两边都超速时不换人", () => {
  const view = pickView(
    facts({
      job: { ref: "r2", name: "后端" },
      candidates: [
        cand("codex+c", { preferred: 0 }),
        cand("claude+opus", { preferred: 1 }),
      ],
      pace: pace([
        ["codex", -60, 70],
        ["claude", -5, 50],
      ]),
    }),
  );
  assert.equal(view.recommended, "codex+c");
  assert.match(view.reason, /^后端专员优先、codex 富余 −60%/);
});

test("pickView：只有信任度不够的执行者富余时不换人", () => {
  const view = (trust: "low" | "unknown" | "medium", risk = "low" as const) =>
    pickView(
      facts({
        risk,
        job: { ref: "r2", name: "后端" },
        candidates: [
          cand("codex+c", { preferred: 0 }),
          cand("kimi", { rules: { trust } }),
          cand("grok+g", { preferred: 1, rules: { trust } }),
        ],
        pace: pace([
          ["codex", -17, 60],
          ["kimi", 80, 5],
          ["grok", 70, 5],
        ]),
      }),
    );
  for (const trust of ["low", "unknown"] as const) {
    assert.equal(view(trust).recommended, "codex+c");
    assert.equal(
      writtenNotice(view(trust), { worker: "codex+c", tool: "codex" }, "t9"),
      null,
    );
  }
  assert.equal(view("medium").recommended, "grok+g");
});

test("richerAlternative：与提醒共用一个阈值；富余须为正、能接、不忙、信任度够、另一账号", () => {
  const rival = (over: object = {}) => ({
    worker: "claude+opus",
    account: "claude",
    spare: 30,
    eligible: true,
    busy: false,
    trust: "medium" as const,
    ...over,
  });
  const own = { account: "codex", spare: 0 };
  assert.equal(richerAlternative([rival()], own, "low")?.gap, NOTICE_SPARE_GAP);
  assert.equal(richerAlternative([rival({ spare: 29.4 })], own, "low"), null);
  assert.equal(
    richerAlternative(
      [rival({ spare: 0 })],
      { account: "codex", spare: -40 },
      "low",
    ),
    null,
  );
  assert.equal(
    richerAlternative([rival({ eligible: false })], own, "low"),
    null,
  );
  assert.equal(richerAlternative([rival({ busy: true })], own, "low"), null);
  assert.equal(richerAlternative([rival({ trust: "low" })], own, "low"), null);
  assert.equal(
    richerAlternative([rival({ account: "codex" })], own, "low"),
    null,
  );
  assert.equal(richerAlternative([rival({ spare: null })], own, "low"), null);
  assert.equal(
    richerAlternative([rival()], { account: "codex", spare: null }, "low"),
    null,
  );
  // 按给定顺序取第一个达标的。
  assert.equal(
    richerAlternative(
      [rival({ worker: "a", spare: 31 }), rival({ worker: "b", spare: 90 })],
      own,
      "low",
    )?.worker,
    "a",
  );
  assert.equal(trusted("medium", "medium"), true);
  assert.equal(trusted("medium", "high"), false);
  assert.equal(trusted("high", "high"), true);
  assert.equal(trusted("low", "low"), false);
  assert.equal(trusted("unknown", "low"), false);
});

test("pickView：专员候选都不能接时按额度挑并写明", () => {
  const view = pickView(
    facts({
      job: { ref: "r2", name: "后端" },
      candidates: [
        cand("codex+gpt-6-sol", { preferred: 0 }),
        cand("claude+opus"),
      ],
      pace: pace([
        ["codex", -13, 85],
        ["claude", 54, 10],
      ]),
    }),
  );
  assert.equal(view.recommended, "claude+opus");
  assert.equal(
    view.reason,
    "后端专员的优先执行者都不能接或正忙，按额度挑、claude 富余 +54%；codex+gpt-6-sol 不能接：已用额度 85% 达到上限 80%（须留 20% 给用户）",
  );
});

test("pickView：正忙的独占工具排到空闲候选之后；只剩它时仍推荐并说明会排队", () => {
  const busy = new Set<Tool>(["opencode"]);
  const both = pickView(
    facts({
      job: { ref: "r1", name: "前端" },
      candidates: [cand("opencode+x", { preferred: 0 }), cand("codex+c")],
      pace: pace([
        ["opencode", 90, 1],
        ["codex", 10, 1],
      ]),
      busy,
    }),
  );
  assert.match(
    both.reason,
    /^前端专员的优先执行者都不能接或正忙，按额度挑、codex 富余 \+10%/,
  );
  assert.equal(
    pickView(
      facts({
        job: { ref: "r1", name: "前端" },
        candidates: [cand("codex+c")],
      }),
    ).reason,
    "前端专员没指定优先执行者，按额度挑、额度数据不可用，按固定顺序",
  );
  assert.deepEqual(
    both.candidates.map((c) => [c.worker, c.busy]),
    [
      ["codex+c", false],
      ["opencode+x", true],
    ],
  );
  const alone = pickView(facts({ candidates: [cand("opencode+x")], busy }));
  assert.equal(alone.recommended, "opencode+x");
  assert.match(alone.reason, /opencode 正忙，派了会排队/);
  // 非独占工具有任务在跑不算正忙。
  const codex = pickView(
    facts({ candidates: [cand("codex+c")], busy: new Set<Tool>(["codex"]) }),
  );
  assert.equal(codex.candidates[0]!.busy, false);
});

test("pickView：没有能接的或没有候选时不推荐，理由说清", () => {
  const none = pickView(
    facts({
      candidates: [cand("codex+c", { installed: false })],
    }),
  );
  assert.equal(none.recommended, null);
  assert.equal(
    none.reason,
    "没有能接的执行者（codex+c：没装：PATH 上找不到 codex）",
  );
  const empty = pickView(facts());
  assert.equal(empty.recommended, null);
  assert.match(empty.reason, /没有候选执行者/);
});

test("pickView：trust 低于 medium 的注明合入前另派审阅，不挡", () => {
  const view = pickView(
    facts({
      candidates: [
        cand("kimi", { rules: {} }),
        cand("grok+g", { rules: { trust: "low" } }),
        cand("claude+opus", { rules: { trust: "high" } }),
      ],
    }),
  );
  assert.deepEqual(
    view.candidates.map((c) => [c.worker, c.eligible, c.trust, c.notes]),
    [
      ["claude+opus", true, "high", []],
      ["grok+g", true, "low", ["trust=low，合入前另派审阅"]],
      ["kimi", true, "unknown", ["trust=unknown，合入前另派审阅"]],
    ],
  );
});

test("writtenNotice：另有能接的候选富余多出 30 个百分点以上才提醒", () => {
  const view = (codexSpare: number | null, claudeSpare: number | null) =>
    pickView(
      facts({
        candidates: [cand("codex+c"), cand("claude+opus")],
        pace: pace([
          ["codex", codexSpare, 10],
          ["claude", claudeSpare, 10],
        ]),
      }),
    );
  const codex = { worker: "codex+c", tool: "codex" as Tool };
  assert.equal(
    writtenNotice(view(-13, 54), codex, "t9"),
    "提醒：claude+opus 同样能接，claude 富余 +54%，比 codex+c 的 codex（−13%）多 67 个百分点；看候选：atrium task pick t9",
  );
  assert.equal(NOTICE_SPARE_GAP, 30);
  assert.match(writtenNotice(view(0, 30), codex, "t9")!, /多 30 个百分点/);
  assert.equal(writtenNotice(view(1, 30), codex, "t9"), null);
  assert.equal(writtenNotice(view(null, 90), codex, "t9"), null);
  assert.equal(writtenNotice(view(0, null), codex, "t9"), null);
  // 写死的就是最富余的：不提醒。
  assert.equal(writtenNotice(view(54, -13), codex, "t9"), null);
  // 更富余的那个不能接或正忙：不提醒。
  const refused = pickView(
    facts({
      candidates: [cand("codex+c"), cand("claude+opus", { installed: false })],
      pace: pace([
        ["codex", -13, 10],
        ["claude", 54, 10],
      ]),
    }),
  );
  assert.equal(writtenNotice(refused, codex, "t9"), null);
  const busy = pickView(
    facts({
      candidates: [cand("codex+c"), cand("opencode+x")],
      pace: pace([
        ["codex", -13, 10],
        ["opencode", 54, 10],
      ]),
      busy: new Set<Tool>(["opencode"]),
    }),
  );
  assert.equal(writtenNotice(busy, codex, "t9"), null);
});

test("命令行文本：推荐一句、表格一行一位候选；task run 回执带理由与提醒", () => {
  const view = pickView(
    facts({
      job: { ref: "r1", name: "前端" },
      candidates: [
        cand("claude+opus", { preferred: 0 }),
        cand("codex+c", { installed: false }),
      ],
      pace: [
        {
          providerId: "claude",
          sparePercent: 54,
          usedPercent: 10,
          hoursToReset: 30,
        },
      ],
      headroom: new Map([["claude", { points: 70, reason: "x" }]]),
      records: new Map([
        [
          "claude+opus",
          { deliveries: 3, first_pass_rate: 2 / 3, low_data: true },
        ],
      ]),
    }),
  );
  const text = formatPick({ task: "t5", ...view });
  const lines = text.split("\n");
  assert.equal(lines[0], "推荐 claude+opus：前端专员优先、claude 富余 +54%");
  assert.match(
    lines[1]!,
    /^t5 · risk=low · 干活的专员 前端（r1） · 给你保留 20%$/,
  );
  assert.match(lines[3]!, /执行者\s+能不能接\s+账号额度\s+正忙\s+交付记录/);
  assert.match(
    lines[4]!,
    /^1\s+claude\+opus\s+能接 · 前端专员第 1 选\s+claude 已用 10%，富余 \+54%，30 小时后重置，扣保留剩 70%\s+空闲\s+3 次，一次通过 67%（样本少）$/,
  );
  assert.match(
    lines[5]!,
    /^-\s+codex\+c\s+不能接：没装.*codex 无数据\s+空闲\s+无记录$/,
  );
  assert.deepEqual(
    pickLines({
      worker: "claude+opus",
      auto: true,
      reason: "claude 富余 +54%",
      notice: null,
    }),
    ["按额度挑了 claude+opus，因为claude 富余 +54%"],
  );
  assert.deepEqual(
    pickLines({
      worker: "codex+c",
      auto: false,
      reason: null,
      notice: "提醒：…",
    }),
    ["提醒：…"],
  );
  assert.deepEqual(pickLines(undefined), []);
});

test("隔离服务：task pick 推荐富余的执行者；写死超速的回执带提醒；自动挑人带理由；专员优先", async (t) => {
  const { startApp } = await import("./task-fixture.ts");
  const { call } = await startApp(
    t,
    (fx) =>
      writeFileSync(
        join(fx.workers, "harness", "opencode.md"),
        "---\nchecks: []\ntrust: medium\n---\n",
      ),
    async () => [
      { providerId: "kimi", sparePercent: -13, usedPercent: 60 },
      { providerId: "opencode", sparePercent: 54, usedPercent: 10 },
    ],
  );
  const add = async (title: string, extra: object = {}) =>
    (await call("POST", "/api/tasks", { title, deliver: "none", ...extra }))
      .body as { ref: string };
  const t1 = await add("看候选");
  const picked = await call("GET", `/api/tasks/${t1.ref}/pick`);
  assert.equal(picked.status, 200);
  assert.equal(picked.body.task, t1.ref);
  assert.match(picked.body.recommended, /^opencode/);
  // 本机装了 claude、codex 时理由前面多一句大小（没有它们的额度读数，不按大小换）。
  assert.match(
    picked.body.reason,
    /(?:^|按额度挑、)opencode 富余 \+54%；kimi 富余 −13%/,
  );
  const kimi = picked.body.candidates.find(
    (c: { tool: string }) => c.tool === "kimi",
  );
  assert.deepEqual(Object.keys(kimi).sort(), [
    "busy",
    "eligible",
    "max_risk",
    "notes",
    "preferred",
    "quota",
    "rank",
    "record",
    "refusals",
    "tool",
    "trust",
    "worker",
  ]);
  assert.equal(kimi.quota.used_percent, 60);
  assert.equal(kimi.quota.left_percent, 20);
  assert.equal(
    (
      await call("GET", `/api/tasks/${t1.ref}/pick?risk=medium`)
    ).body.candidates.find((c: { tool: string }) => c.tool === "kimi")
      .refusals[0],
    "档案 max_risk=low，低于任务 risk=medium",
  );
  assert.equal(
    (await call("GET", `/api/tasks/${t1.ref}/pick?risk=huge`)).status,
    400,
  );
  // 写死超速的 kimi：照派，回执带提醒。
  const run = await call("POST", `/api/tasks/${t1.ref}/run`, {
    worker: "kimi",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.pick.auto, false);
  assert.match(
    run.body.pick.notice,
    /^提醒：opencode\S* 同样能接，opencode 富余 \+54%，比 kimi\S* 的 kimi（−13%）多 67 个百分点；看候选：atrium task pick t1$/,
  );
  // 不写 --worker：按同一份排序挑 opencode，回执写理由。
  const t2 = await add("自动挑");
  const auto = await call("POST", `/api/tasks/${t2.ref}/run`, {});
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.equal(auto.body.pick.auto, true);
  assert.match(auto.body.pick.worker, /^opencode/);
  assert.match(auto.body.pick.reason, /(?:^|按额度挑、)opencode 富余 \+54%/);
  // 干活的专员第 1 选 kimi 超速、opencode 富余多出 30 点以上：改推荐 opencode，自动派也挑它。
  const role = await call("POST", "/api/specialists", {
    name: "前端",
    description: "界面",
    preferred: ["kimi"],
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  // opencode 独占，等自动派的那个跑完，免得它正忙。
  await call("GET", `/api/tasks/${t2.ref}/wait?timeout=30`);
  const t3 = await add("改页面", { by: "前端" });
  const favoured = await call("GET", `/api/tasks/${t3.ref}/pick`);
  assert.match(favoured.body.recommended, /^opencode/);
  assert.match(
    favoured.body.reason,
    /^前端专员第 1 选 kimi\S* 超速（kimi −13%），改用 opencode\S*（opencode \+54%）$/,
  );
  assert.equal(favoured.body.job.name, "前端");
  const dispatched = await call("POST", `/api/tasks/${t3.ref}/run`, {});
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
  assert.equal(dispatched.body.pick.worker, favoured.body.recommended);
  assert.equal(dispatched.body.pick.reason, favoured.body.reason);
  // 按推荐写死不提醒。
  await call("GET", `/api/tasks/${t3.ref}/wait?timeout=30`);
  const t4 = await add("照推荐写死", { by: "前端" });
  const same = await call("POST", `/api/tasks/${t4.ref}/run`, {
    worker: favoured.body.recommended,
  });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.pick.notice, null);
});
