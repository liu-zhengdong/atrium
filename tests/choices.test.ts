import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { authPolicy } from "../server/auth-policy.ts";
import { publishTask } from "../server/tasks/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import { choiceAddVerdict, leaderRule } from "../server/leaders/scope.ts";
import {
  CHOICE_LIMITS,
  decideVerdict,
  noteOf,
  parseChoiceRef,
  parsePicks,
  pendingLine,
  pickedBrief,
  skippedDecision,
  statusAfter,
  validateChoice,
  type ChoiceFacts,
  type OptionFacts,
} from "../server/choices/model.ts";
import { renderTop, type Snapshot } from "../cli/top.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { choiceText } from "../cli/choices.ts";
import { width } from "../server/text-width.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

const option = (n: number, over: Record<string, unknown> = {}) => ({
  title: `选项${n}`,
  gain: `能多做到${n}`,
  why_now: `现在做${n}`,
  cost: `两个任务${n}`,
  skip: `不做会${n}`,
  basis: [`f${n}`],
  ...over,
});
const sheet = (over: Record<string, unknown> = {}) => ({
  title: "Atrium 下一步",
  options: [option(1), option(2), option(3), option(4)],
  recommend: [1, 3],
  why: "先补最常用的",
  ...over,
});
const usage = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (error: { statusCode?: number; message: string }) => {
    assert.equal(error.statusCode, 400, error.message);
    assert.match(error.message, pattern);
    return true;
  });

// ---- 纯函数 ----

test("选项单校验：字段、个数、长度、重复、推荐逐项报到第几个选项", () => {
  const ok = validateChoice(sheet({ recommend: ["3", 1] }));
  assert.equal(ok.options.length, 4);
  assert.deepEqual(ok.recommend, [1, 3]);
  assert.deepEqual(ok.options[0]!.basis, ["f1"]);
  assert.deepEqual(
    validateChoice(
      sheet({
        options: [option(1, { basis: undefined }), option(2), option(3)],
      }),
    ).options[0]!.basis,
    [],
  );
  assert.equal(
    validateChoice(sheet({ title: "  前后空白  " })).title,
    "前后空白",
  );
  assert.equal(
    validateChoice(sheet({ options: [1, 2, 3, 4, 5].map((n) => option(n)) }))
      .options.length,
    5,
  );
  const cases: [unknown, RegExp][] = [
    [null, /选项单应为对象/],
    [[], /选项单应为对象/],
    [sheet({ extra: 1 }), /extra: 是未知字段/],
    [sheet({ title: "" }), /title（选项单标题）不能为空/],
    [sheet({ title: 3 }), /title（选项单标题）不能为空/],
    [sheet({ title: "长".repeat(81) }), /不能超过 80 字/],
    [sheet({ options: "x" }), /options: 应为 3–5 个选项的列表/],
    [
      sheet({ options: [option(1), option(2)] }),
      /应有 3–5 个选项，现在是 2 个/,
    ],
    [
      sheet({ options: [1, 2, 3, 4, 5, 6].map((n) => option(n)) }),
      /现在是 6 个/,
    ],
    [sheet({ options: [option(1), "x", option(3)] }), /选项 2: 应为对象/],
    [
      sheet({ options: [option(1), option(2, { owner: "a1" }), option(3)] }),
      /选项 2: owner 是未知字段/,
    ],
    [
      sheet({ options: [option(1), option(2, { cost: " " }), option(3)] }),
      /选项 2的「代价」（cost）不能为空/,
    ],
    [
      sheet({
        options: [option(1, { gain: undefined }), option(2), option(3)],
      }),
      /选项 1的「能多做到什么」（gain）不能为空/,
    ],
    [
      sheet({
        options: [
          option(1),
          option(2),
          option(3, { why_now: "长".repeat(801) }),
        ],
      }),
      /选项 3的「为什么现在」（why_now）不能超过 800 字/,
    ],
    [
      sheet({
        options: [option(1), option(2), option(3, { skip: null })],
      }),
      /「不做会怎样」（skip）不能为空/,
    ],
    [
      sheet({
        options: [option(1, { title: "长".repeat(81) }), option(2), option(3)],
      }),
      /选项 1的「标题」（title）不能超过 80 字/,
    ],
    [
      sheet({ options: [option(1, { basis: "f1" }), option(2), option(3)] }),
      /「依据」（basis）应为列表/,
    ],
    [
      sheet({
        options: [
          option(1, { basis: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
          option(2),
          option(3),
        ],
      }),
      /「依据」（basis）至多 10 条/,
    ],
    [
      sheet({
        options: [option(1, { basis: ["f1", ""] }), option(2), option(3)],
      }),
      /选项 1的「依据」第 2 条不能为空/,
    ],
    [
      sheet({
        options: [option(1), option(2, { title: "选项１" }), option(3)],
      }),
      /选项 2: 标题「选项１」和前面的重复/,
    ],
    [sheet({ recommend: [] }), /recommend: 推荐选哪几个/],
    [sheet({ recommend: 1 }), /recommend: 推荐选哪几个/],
    [sheet({ recommend: [5] }), /recommend: 没有选项 5，这份只有 4 个选项/],
    [sheet({ recommend: [1, 1] }), /recommend: 选项 1 写了两次/],
    [sheet({ why: "" }), /why（推荐理由）不能为空/],
    [sheet({ why: "长".repeat(1001) }), /why（推荐理由）不能超过 1000 字/],
  ];
  for (const [body, pattern] of cases)
    usage(() => validateChoice(body), pattern);
});

test("选项号：数字、字符串、逗号混写，范围与重复都报清楚，结果排好序", () => {
  assert.deepEqual(parsePicks([3, "1"], 4), [1, 3]);
  assert.deepEqual(parsePicks(["1,3"], 4), [1, 3]);
  assert.deepEqual(parsePicks(["4，2 1"], 4), [1, 2, 4]);
  assert.deepEqual(parsePicks([" 2 "], 3), [2]);
  const bad: [unknown[], RegExp][] = [
    [[], /至少写一个选项号/],
    [[""], /至少写一个选项号/],
    [[0], /应为 1 到 4 的整数/],
    [["0"], /应为 1 到 4 的整数/],
    [[-1], /应为 1 到 4 的整数/],
    [[1.5], /应为 1 到 4 的整数/],
    [["二"], /应为 1 到 4 的整数/],
    [["01"], /应为 1 到 4 的整数/],
    [[null], /应为 1 到 4 的整数/],
    [[true], /应为 1 到 4 的整数/],
    [[{}], /应为 1 到 4 的整数/],
    [[5], /没有选项 5，这份只有 4 个选项/],
    [["1", 1], /选项 1 写了两次/],
    [["2,2"], /选项 2 写了两次/],
  ];
  for (const [values, pattern] of bad)
    usage(() => parsePicks(values, 4, "选项号"), pattern);
  usage(() => parsePicks([9], 4, "recommend"), /^recommend: /);
});

test("短号、说明、能不能拍板、拍板后的状态", () => {
  assert.equal(parseChoiceRef("c3"), 3);
  assert.equal(parseChoiceRef(" c12 "), 12);
  for (const bad of ["3", "c0", "c-1", "t3", "c1.5", "", 3, null])
    usage(() => parseChoiceRef(bad), /c1 这样的格式/);
  assert.equal(noteOf(undefined), null);
  assert.equal(noteOf(null), null);
  assert.equal(noteOf("   "), null);
  assert.equal(noteOf(" 先收尾 "), "先收尾");
  usage(() => noteOf(3), /--note: 应为文字/);
  usage(() => noteOf("长".repeat(CHOICE_LIMITS.note + 1)), /不能超过 1000 字/);
  assert.equal(noteOf("长".repeat(CHOICE_LIMITS.note))!.length, 1000);

  for (const status of ["open", "picked", "passed"] as const)
    for (const archived of [false, true]) {
      const verdict = decideVerdict({ ref: "c3", status, archived });
      if (status === "open" && !archived) assert.equal(verdict, null);
      else if (status === "picked") assert.match(verdict!, /c3 已经拍过板了/);
      else if (status === "passed")
        assert.match(verdict!, /c3 这轮已经定了都不要/);
      else assert.match(verdict!, /c3 挂的节点已归档/);
    }
  assert.equal(statusAfter("pick"), "picked");
  assert.equal(statusAfter("pass"), "passed");
});

const facts: ChoiceFacts = {
  ref: "c3",
  title: "Atrium 下一步",
  node: { ref: "o2", name: "Atrium" },
  recommend: [1, 3],
  why: "先补最常用的",
};
const opt = (over: Partial<OptionFacts> = {}): OptionFacts => ({
  seq: 2,
  title: "看板加过滤",
  gain: "只看自己关心的部分",
  why_now: "任务多了",
  cost: "两个任务，claude 额度",
  skip: "每次都要翻很久",
  basis: ["f3", "t120"],
  ...over,
});

test("选中的建任务：详述带选项全文、来源、用户说明与推荐，交节点 leader 拆解", () => {
  const brief = pickedBrief(facts, opt(), "这周就要");
  assert.match(brief, /^# 看板加过滤\n/);
  assert.match(
    brief,
    /来源：选项单 c3「Atrium 下一步」的选项 2，用户拍板要做（o2「Atrium」）/,
  );
  assert.match(brief, /用户说明：这周就要/);
  for (const line of [
    "- 能多做到什么：只看自己关心的部分",
    "- 为什么现在：任务多了",
    "- 代价：两个任务，claude 额度",
    "- 不做会怎样：每次都要翻很久",
    "- 依据：f3；t120",
    "产品部推荐：选项 1、3——先补最常用的",
  ])
    assert.ok(brief.includes(line), line);
  assert.match(brief, /交 o2 的 leader 拆解/);
  const bare = pickedBrief(facts, opt({ basis: [] }), null);
  assert.doesNotMatch(bare, /用户说明/);
  assert.doesNotMatch(bare, /依据/);
});

test("没选的记决定：写这轮不做 X，原因取说明，没写说明也写清；超长按决定记录上限截", () => {
  const picked = skippedDecision(facts, opt(), "等额度宽裕", "pick");
  assert.equal(picked.text, "这轮不做「看板加过滤」（c3 选项 2）");
  assert.match(
    picked.why,
    /^等额度宽裕。当时的说法：能多做到「只看自己关心的部分」；不做会「每次都要翻很久」。情况没变就不再提。$/,
  );
  assert.match(
    skippedDecision(facts, opt(), null, "pick").why,
    /^用户选了别的选项，没写原因。/,
  );
  assert.match(
    skippedDecision(facts, opt(), null, "pass").why,
    /^用户这轮都不要，没写原因。/,
  );
  const long = skippedDecision(
    facts,
    opt({ title: "长".repeat(400), gain: "多".repeat(900) }),
    "说".repeat(1000),
    "pass",
  );
  assert.ok(Array.from(long.text).length <= 300, long.text);
  assert.match(long.text, /（c3 选项 2）$/);
  assert.ok(Array.from(long.why).length <= 1000);
});

test("状态栏一行：最早一份加还有几份，没有就是 null，标题按宽度截", () => {
  const pending = [
    {
      ref: "c3",
      title: "Atrium 下一步",
      options: 4,
      node: "o2",
      node_name: "Atrium",
    },
    { ref: "c5", title: "OQ 下一步", options: 3, node: "o6", node_name: "OQ" },
  ];
  assert.equal(pendingLine([], 0), null);
  assert.equal(pendingLine(pending, 0), null);
  assert.equal(
    pendingLine(pending.slice(0, 1), 1),
    "等你拍板：c3 Atrium 下一步（4 个选项）",
  );
  assert.equal(
    pendingLine(pending, 5),
    "等你拍板：c3 Atrium 下一步（4 个选项），另有 4 份",
  );
  const long = pendingLine(
    [{ ...pending[0]!, title: "很长的标题\n第二行".repeat(20) }],
    1,
    20,
  )!;
  assert.ok(!long.includes("\n"));
  assert.ok(width(long) < 60, long);
});

test("leader 提选项单：自己负责的部分、下层、上一层可以，别处与查不到的不行；拍板一律拒绝", () => {
  // o1 ─ o2 ─ o3（a1 负责）─ o4；o1 ─ o5
  const parents = new Map<number, number | null>([
    [1, null],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 1],
  ]);
  const input = {
    leader: "a1",
    led: new Set([3]),
    scope: new Set([3, 4]),
    parents,
  };
  for (const [node, allowed] of [
    [3, true],
    [4, true],
    [2, true],
    [1, false],
    [5, false],
  ] as const) {
    const verdict = choiceAddVerdict({ ...input, node });
    if (allowed) assert.equal(verdict, null, `o${node}`);
    else assert.match(verdict!, new RegExp(`a1 无权在 o${node} 上提选项单`));
  }
  assert.match(
    choiceAddVerdict({ ...input, node: null })!,
    /在查不到的节点上提选项单/,
  );
  assert.equal(leaderRule("POST", "/api/choices"), "choice-add");
  assert.equal(leaderRule("POST", "/api/choices/:id/pick"), "deny");
  assert.equal(leaderRule("POST", "/api/choices/:id/pass"), "deny");
  assert.equal(leaderRule("GET", "/api/choices"), "read");
  assert.equal(authPolicy("POST", "/api/choices/:id/pick"), "map-write");
  assert.equal(authPolicy("POST", "/api/choices/:id/pass"), "map-write");
  assert.equal(authPolicy("POST", "/api/choices"), "user");
  assert.equal(authPolicy("GET", "/api/choices"), "user");
});

test("看板与状态栏：有等拍板的选项单时在第一行下面单出一行", () => {
  const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
    now: 0,
    recent_ms: 60_000,
    subscriber: "secretary",
    counts: {
      running: 0,
      queued: 0,
      blocked: 0,
      processing: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      events: 0,
    },
    rows: [],
    truncated: false,
    ...over,
  });
  const choices = {
    open: 2,
    list: [
      {
        ref: "c3",
        title: "Atrium 下一步",
        options: 4,
        node: "o2",
        node_name: "Atrium",
      },
    ],
  };
  const frame = renderTop(snapshot({ choices }), {
    width: 80,
    now: 0,
    footer: false,
    color: false,
  }).split("\n");
  assert.equal(frame[1], "等你拍板：c3 Atrium 下一步（4 个选项），另有 1 份");
  assert.ok(
    !renderTop(snapshot(), {
      width: 80,
      now: 0,
      footer: false,
      color: false,
    }).includes("等你拍板"),
  );
  const line = renderStatusline({
    snapshot: snapshot({ choices }) as never,
    plan: null,
    now: 0,
    color: false,
  }).split("\n");
  assert.equal(line[1], "✱ 等你拍板：c3 Atrium 下一步（4 个选项），另有 1 份");
  assert.equal(
    renderStatusline({
      snapshot: snapshot() as never,
      plan: null,
      now: 0,
      color: false,
    }),
    "Atrium 空闲",
  );
});

// ---- 集成 ----

async function open(t: { after: (fn: () => unknown) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-choices-"));
  t.after(() => removeTemp(data));
  mkdirSync(data, { recursive: true });
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE IF NOT EXISTS pi_identities (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO pi_identities VALUES (1,'legacy')",
  );
  legacy.close();
  let behave: (spec: LeaderRunSpec) => Promise<"ok"> = async () => "ok";
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      run: async (spec) => behave(spec),
    },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = { authorization: user },
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  const ok = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    assert(
      result.status < 300,
      `${args[0]} ${args[1]} → ${result.status} ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  for (const node of [
    { slug: "org", kind: "org", name: "组织" },
    { parent: "o1", slug: "atrium", kind: "project", name: "Atrium" },
    { parent: "o2", slug: "product", kind: "module", name: "产品" },
    { parent: "o1", slug: "oq", kind: "project", name: "OQ" },
  ])
    await ok("POST", "/api/org/nodes", { ...node, reason: "建" });
  await ok("POST", "/api/leaders", { name: "产品部", worker: "codex" });
  await ok("PATCH", "/api/org/nodes/o3", { leader: "a1", reason: "产品部" });
  await ok("POST", "/api/leaders", { name: "Atrium 负责人", worker: "codex" });
  await ok("PATCH", "/api/org/nodes/o2", { leader: "a2", reason: "负责" });
  return {
    ...created,
    data,
    user,
    call,
    ok,
    set: (next: typeof behave) => {
      behave = next;
    },
  };
}

const inboxOf = (db: DatabaseSync, key: string) =>
  db
    .prepare(
      "SELECT subscriber,kind,level,acked_at FROM task_inbox WHERE dedupe_key=? ORDER BY id",
    )
    .all(key) as {
    subscriber: string;
    kind: string;
    level: string;
    acked_at: number | null;
  }[];

test("隔离服务：提选项单叫醒秘书，拍板建任务、记决定，全景与 top 看得到；旧表不妨碍启动", async (t) => {
  const x = await open(t);
  const bad = await x.call("POST", "/api/choices", {
    node: "o2",
    choice: sheet({ options: [option(1)] }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /应有 3–5 个选项/);
  const missing = await x.call("POST", "/api/choices", {
    node: "o9",
    choice: sheet(),
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(
    (
      await x.call("POST", "/api/choices", {
        node: "o2",
        task: "t99",
        choice: sheet(),
      })
    ).status,
    404,
  );

  const c1 = await x.ok("POST", "/api/choices", {
    node: "atrium",
    choice: sheet(),
  });
  assert.equal(c1.ref, "c1");
  assert.equal(c1.node, "o2");
  assert.equal(c1.status, "open");
  assert.equal(c1.created_by, "secretary");
  assert.deepEqual(
    c1.options.map((o: { seq: number; picked: null }) => [o.seq, o.picked]),
    [
      [1, null],
      [2, null],
      [3, null],
      [4, null],
    ],
  );
  const ready = inboxOf(x.db, "choice:c1");
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.subscriber, "secretary");
  assert.equal(ready[0]!.kind, "choice_ready");
  assert.equal(ready[0]!.level, "action");

  const c2 = await x.ok("POST", "/api/choices", {
    node: "oq",
    choice: sheet({
      title: "OQ 下一步",
      options: [option(1), option(2), option(3)],
    }),
  });
  assert.equal(c2.ref, "c2");

  const top = await x.ok("GET", "/api/tasks/top");
  assert.equal(top.choices.open, 2);
  assert.deepEqual(
    top.choices.list.map((c: { ref: string; options: number }) => [
      c.ref,
      c.options,
    ]),
    [
      ["c1", 4],
      ["c2", 3],
    ],
  );
  const now = await x.ok("GET", "/api/map/now");
  assert.equal(now.choices.open, 2);
  const root = await x.ok("GET", "/api/map/nodes/o1");
  assert.deepEqual(
    root.choices.map((c: { ref: string }) => c.ref),
    ["c2", "c1"],
  );
  const part = await x.ok("GET", "/api/map/nodes/o3");
  assert.deepEqual(part.choices, []);

  // 列表：等拍板的在前，--node 看这一块及下层，分页接着往下取。
  const page = await x.ok("GET", "/api/choices?limit=1");
  assert.deepEqual(
    page.choices.map((c: { ref: string }) => c.ref),
    ["c2"],
  );
  assert.equal(page.next_before, "c2");
  const rest = await x.ok("GET", "/api/choices?limit=1&before=c2");
  assert.deepEqual(
    rest.choices.map((c: { ref: string }) => c.ref),
    ["c1"],
  );
  assert.equal(rest.next_before, null);
  const scoped = await x.ok("GET", "/api/choices?node=o2");
  assert.deepEqual(
    scoped.choices.map((c: { ref: string }) => c.ref),
    ["c1"],
  );
  assert.equal(scoped.open, 1);
  assert.equal((await x.call("GET", "/api/choices?limit=0")).status, 400);
  assert.equal((await x.call("GET", "/api/choices/c9")).status, 404);
  assert.equal((await x.call("GET", "/api/choices/9")).status, 400);

  // 拍板：坏选项号不动数据。
  for (const payload of [
    { picks: [5] },
    { picks: [] },
    { picks: [1], owner: "a1" },
  ])
    assert.equal(
      (await x.call("POST", "/api/choices/c1/pick", payload)).status,
      400,
    );
  assert.equal((await x.ok("GET", "/api/choices/c1")).status, "open");

  const picked = await x.ok("POST", "/api/choices/c1/pick", {
    picks: ["3", 1],
    note: "选项2等额度宽裕再说",
  });
  assert.equal(picked.choice.status, "picked");
  assert.equal(picked.choice.note, "选项2等额度宽裕再说");
  assert.equal(picked.choice.decided_by, "u1");
  assert.deepEqual(
    picked.tasks.map((t: { option: number; title: string }) => [
      t.option,
      t.title,
    ]),
    [
      [1, "选项1"],
      [3, "选项3"],
    ],
  );
  assert.deepEqual(
    picked.decisions.map((d: { option: number; owner: string }) => [
      d.option,
      d.owner,
    ]),
    [
      [2, "a2"],
      [4, "a2"],
    ],
  );
  const task = x.db
    .prepare("SELECT part_id,brief FROM tasks WHERE id=?")
    .get(Number(picked.tasks[0].ref.slice(1))) as {
    part_id: number;
    brief: string;
  };
  assert.equal(task.part_id, 2);
  assert.match(task.brief, /来源：选项单 c1「Atrium 下一步」的选项 1/);
  assert.match(task.brief, /用户说明：选项2等额度宽裕再说/);
  assert.match(task.brief, /- 能多做到什么：能多做到1/);
  const decisions = await x.ok("GET", "/api/decisions?as=a2");
  const skipped = decisions.decisions.find(
    (d: { ref: string }) => d.ref === picked.decisions[0].ref,
  );
  assert.equal(skipped.text, "这轮不做「选项2」（c1 选项 2）");
  assert.match(skipped.why, /^选项2等额度宽裕再说。/);
  assert.equal(skipped.by, "u1");
  const shown = await x.ok("GET", "/api/choices/c1");
  assert.deepEqual(
    shown.options.map(
      (o: {
        picked: boolean;
        task: string | null;
        decision: string | null;
      }) => [o.picked, !!o.task, !!o.decision],
    ),
    [
      [true, true, false],
      [false, false, true],
      [true, true, false],
      [false, false, true],
    ],
  );
  const text = choiceText(shown as never);
  assert.match(text, /^c1 Atrium 下一步 · 已拍板 · Atrium（o2）/);
  assert.match(text, /1\. 选项1（推荐） → 已选，建了 t\d+/);
  assert.match(text, /2\. 选项2 → 没选，记为 d\d+/);
  assert.match(text, /用户说明：选项2等额度宽裕再说/);

  // 秘书收到的「等拍板」被同一去重键改成知会，不再叫醒。
  const decided = inboxOf(x.db, "choice:c1");
  assert.equal(decided.length, 1);
  assert.equal(decided[0]!.kind, "choice_decided");
  assert.equal(decided[0]!.level, "info");

  // 定了就不能再改。
  for (const action of ["pick", "pass"]) {
    const again = await x.call("POST", `/api/choices/c1/${action}`, {
      picks: [2],
    });
    assert.equal(again.status, action === "pick" ? 409 : 400);
  }
  const conflict = await x.call("POST", "/api/choices/c1/pass", {});
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /c1 已经拍过板了/);

  // 这轮都不要：OQ 没有 leader，决定记到秘书名下。
  const passed = await x.ok("POST", "/api/choices/c2/pass", {
    note: "这周先收尾",
  });
  assert.equal(passed.choice.status, "passed");
  assert.equal(passed.tasks.length, 0);
  assert.deepEqual(
    passed.decisions.map((d: { owner: string }) => d.owner),
    ["secretary", "secretary", "secretary"],
  );
  assert.equal((await x.ok("GET", "/api/tasks/top")).choices, undefined);
  assert.equal((await x.ok("GET", "/api/map/now")).choices.open, 0);
  const ordered = await x.ok("GET", "/api/choices");
  assert.equal(ordered.open, 0);
  assert.deepEqual(
    ordered.choices.map((c: { ref: string }) => c.ref),
    ["c2", "c1"],
  );

  assert.equal(
    (
      x.db.prepare("SELECT value FROM pi_identities WHERE id=1").get() as {
        value: string;
      }
    ).value,
    "legacy",
  );
});

test("拍板只认用户：leader 令牌能提不能拍，网页会话同源才能拍，匿名拒绝", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o3",
    deliver: "none",
  });
  let checked = false;
  let failure: unknown;
  x.set(async (spec) => {
    if (checked || failure || !spec.env.ATRIUM_LEADER_TOKEN) return "ok";
    try {
      const token = { authorization: `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}` };
      const upper = await x.call(
        "POST",
        "/api/choices",
        { node: "o2", choice: sheet() },
        token,
      );
      assert.equal(upper.status, 201, JSON.stringify(upper.body));
      assert.equal(upper.body.created_by, "a1");
      const outside = await x.call(
        "POST",
        "/api/choices",
        { node: "oq", choice: sheet() },
        token,
      );
      assert.equal(outside.status, 403);
      assert.match(
        outside.body.error,
        /只能挂在你负责的部分、它的下层或它的上一层/,
      );
      const pick = await x.call(
        "POST",
        `/api/choices/${upper.body.ref}/pick`,
        { picks: [1] },
        token,
      );
      assert.equal(pick.status, 403);
      assert.match(pick.body.error, /拍板选项单（那是用户的决定）/);
      checked = true;
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => checked || failure !== undefined, 20000);
  if (failure) throw failure;
  const ready = inboxOf(x.db, "choice:c1");
  assert.equal(ready[0]!.kind, "choice_ready");

  // 网页会话：同源（带 Origin）才能拍；不带 Origin、跨源、匿名都不行；会话也不能提选项单。
  const link = await x.ok("POST", "/api/map/login");
  const login = await x.app.inject({
    url: link.path,
    headers: { host: "127.0.0.1" },
  });
  assert.equal(login.statusCode, 303);
  const session = String(login.headers["set-cookie"]).split(";")[0]!;
  const anonymous = await x.call(
    "POST",
    "/api/choices/c1/pick",
    { picks: [1] },
    {},
  );
  assert.equal(anonymous.status, 401);
  const noOrigin = await x.call(
    "POST",
    "/api/choices/c1/pick",
    { picks: [1] },
    { cookie: session },
  );
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.code, "map_session_forbidden");
  const crossOrigin = await x.call(
    "POST",
    "/api/choices/c1/pick",
    { picks: [1] },
    { cookie: session, origin: "http://evil.example" },
  );
  assert.equal(crossOrigin.status, 403);
  const remote = await x.app.inject({
    method: "POST",
    url: "/api/choices/c1/pick",
    headers: { host: "127.0.0.1", cookie: session, origin: "http://127.0.0.1" },
    payload: { picks: [1] },
    remoteAddress: "10.0.0.2",
  });
  assert.equal(remote.statusCode, 403);
  const add = await x.call(
    "POST",
    "/api/choices",
    { node: "o2", choice: sheet() },
    { cookie: session, origin: "http://127.0.0.1" },
  );
  assert.equal(add.status, 403);
  assert.equal((await x.ok("GET", "/api/choices/c1")).status, "open");
  const web = await x.call(
    "POST",
    "/api/choices/c1/pick",
    { picks: [2], note: "网页上选的" },
    { cookie: session, origin: "http://127.0.0.1" },
  );
  assert.equal(web.status, 200, JSON.stringify(web.body));
  assert.equal(web.body.choice.status, "picked");
  assert.equal(web.body.choice.decided_by, "u1");
});
