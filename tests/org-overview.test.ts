import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Problem } from "../server/problem.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editFields, editNode } from "../server/org/write.ts";
import { show as showNode } from "../server/org/read.ts";
import { validateFields } from "../server/org/validate.ts";
import { overviewOf, type Overview } from "../server/org/overview.ts";
import { formatOverview, titleOf } from "../cli/org-overview.ts";
import {
  addPoint,
  chainPoints,
  editPoint,
  removePoint,
  reorder,
  validatePoint,
} from "../server/org/points.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger/ledger.ts";
import { createApp } from "../server/app.ts";
import { renderTop, snapshotOf } from "../cli/top.ts";
import type { Client } from "../cli/service.ts";
import { removeTemp } from "./temp-dir.ts";

const show = (db: DatabaseSync, at: string) => showNode(db, at);
const node = (db: DatabaseSync, input: Record<string, unknown>) =>
  addNode(db, { reason: "创建", ...input } as never, "u1");

/** o1 组织；o2 Atrium（a1）下 o3 runtime（a2）、o4 cli；o5 OpenQuota。 */
function seed(db: DatabaseSync) {
  node(db, { slug: "org", kind: "org", name: "组织" });
  node(db, {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    leader: "a1",
  });
  node(db, {
    parent: "o2",
    slug: "runtime",
    kind: "module",
    name: "runtime",
    leader: "a2",
  });
  node(db, { parent: "o2", slug: "cli", kind: "module", name: "cli" });
  node(db, { parent: "o1", slug: "openquota", kind: "project", name: "OQ" });
}
function setup() {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureTaskTables(db);
  seed(db);
  return db;
}
const charter = (
  db: DatabaseSync,
  at: string,
  fields: Record<string, unknown>,
  actor = "u1",
) => editFields(db, at, fields, actor);

test("人话字段：合法输入照收，破坏输入按字段名中文拒绝", () => {
  const ok = validateFields({
    what: "帮用户把目标变成有人做完的事",
    alias: "派活员",
    analogy: "项目经理",
    uses: ["一句话提目标"],
    flow: ["提目标", "拆任务", "验收"],
    now: "命令行跑通",
    next: "全景图",
    stages: [
      {
        id: "g5",
        result: "节点可校验",
        status: "achieved",
        criteria: ["$ npm test"],
        evidence: ["#287"],
        due: "2026-10-01",
        after: ["g4"],
        parent: "g1",
        repo: "/tmp/repo",
      },
    ],
  });
  assert.equal(ok.alias, "派活员");
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ what: 1 }, /fields\.what 应为文本/],
    [{ alias: "名".repeat(41) }, /fields\.alias 超过 40 字/],
    [{ uses: "一条" }, /fields\.uses 应为文本列表/],
    [{ uses: Array(11).fill("x") }, /fields\.uses 超过 10 项/],
    [{ flow: [1] }, /fields\.flow\[0\] 应为文本/],
    [{ stages: {} }, /fields\.stages 应为阶段列表/],
    [
      { stages: [{ id: "g1", result: "x", status: "done" }] },
      /fields\.stages\[0\]\.status 只能是/,
    ],
    [
      {
        stages: [
          { id: "g1", result: "x", status: "active" },
          { id: "g1", result: "y", status: "active" },
        ],
      },
      /fields\.stages\[1\]\.id 与前面的阶段重复：g1/,
    ],
    [
      { stages: [{ id: "g1", result: " ", status: "active" }] },
      /fields\.stages\[0\]\.result 不能为空/,
    ],
    [
      { stages: [{ id: "g1", result: "x", status: "active", who: 1 }] },
      /fields\.stages\[0\]\.who 是未知字段/,
    ],
    [
      { stages: [{ id: "g1", result: "x", status: "active", due: "10-01" }] },
      /due 应为 YYYY-MM-DD/,
    ],
    [
      {
        stages: [{ id: "g1", result: "x", status: "active", repo: "a/../b" }],
      },
      /repo 应为绝对路径/,
    ],
  ];
  for (const [fields, message] of bad)
    assert.throws(() => validateFields(fields), message);
});

test("org show 的人话视图：下属部门取子节点的人话名与类比", () => {
  const db = setup();
  charter(db, "o2", {
    what: "成为 AI 组织的运行底座",
    uses: ["提一句目标，等汇报"],
  });
  charter(db, "o3", { alias: "派活员", analogy: "项目经理" }, "a1");
  editNode(db, "o4", { archive: true, reason: "并入" }, "u1");
  createTask(db, { title: "x", part: "o3" });
  const shown = show(db, "o2");
  assert.equal(shown.overview.what, "成为 AI 组织的运行底座");
  assert.deepEqual(
    shown.overview.parts.map((p) => [p.ref, p.alias, p.analogy, p.archived]),
    [
      ["o3", "派活员", "项目经理", false],
      ["o4", "", "", true],
    ],
  );
  assert.equal(shown.overview.parts[0]!.tasks.todo, 1);
  db.close();
});

const overview = (over: Partial<Overview> = {}): Overview => ({
  ...overviewOf({}, []),
  ...over,
});

test("formatOverview：按是什么 → 能做什么 → 流程 → 组成 → 现状的顺序讲；细节才展开验收与证据", () => {
  const full = overview({
    alias: "待办本",
    analogy: "团队的任务白板",
    what: "记下每件事谁在做、做到哪",
    uses: ["看谁手上有什么"],
    flow: ["建任务", "派活", "验收"],
    now: "命令行可用",
    next: "接看板",
    parts: [
      {
        ref: "o8",
        name: "ledger",
        alias: "账本",
        analogy: "流水账",
        archived: false,
        tasks: { todo: 2, running: 1, blocked: 0 },
      },
      {
        ref: "o9",
        name: "旧块",
        alias: "",
        analogy: "",
        archived: true,
        tasks: { todo: 0, running: 0, blocked: 0 },
      },
    ],
    stages: [
      {
        id: "g5",
        result: "节点可校验",
        status: "achieved",
        criteria: ["$ npm test"],
        evidence: ["#287 已合入"],
        parent: "g4",
      },
      { id: "g6", result: "技能归组织", status: "active" },
    ],
  });
  const lines = formatOverview({ ref: "o3", name: "runtime" }, full);
  const order = [
    "是什么：",
    "能用它做什么：",
    "一件事怎么走完：",
    "下设哪些部门：",
    "现在做到哪：",
    "接下来：",
    "阶段（达成 1 · 进行中 1）：",
  ].map((head) => lines.findIndex((line) => line.startsWith(head)));
  assert.ok(
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)),
    lines.join("\n"),
  );
  assert.ok(lines.includes("  2. 派活"));
  assert.ok(lines.includes("  o8 账本（ledger）——流水账 · 在做 1 · 待办 2"));
  assert.ok(!lines.some((l) => l.includes("o9")), "归档的部门默认不列");
  assert.ok(lines.includes("  g5 [达成] 节点可校验"));
  assert.ok(!lines.some((l) => l.includes("验收 1")), "验收条目折叠在细节里");
  const detail = formatOverview({ ref: "o3", name: "runtime" }, full, true);
  assert.ok(detail.includes("      验收 1：$ npm test"));
  assert.ok(detail.includes("      证据：#287 已合入"));
  assert.ok(detail.includes("      上级：g4"));
  assert.ok(detail.some((l) => l.includes("o9 旧块 · 已归档")));
  assert.equal(
    titleOf({ ref: "o3", name: "runtime" }, full),
    "o3 待办本（runtime）——团队的任务白板",
  );
  const blank = formatOverview({ ref: "o4", name: "cli" }, overview());
  assert.match(blank[0]!, /人话介绍还没写.*atrium map edit o4 --what/);
  assert.equal(blank[1], "下设哪些部门：没有下一层");
  const partial = formatOverview(
    { ref: "o4", name: "cli" },
    overview({ what: "命令行" }),
  );
  assert.ok(partial.includes("能用它做什么：（未写）"));
});

test("task --part：落到节点、摘下、归档；旧写法 --goal 拒绝", () => {
  const db = setup();
  const a = createTask(db, { title: "a", part: "atrium/runtime" });
  assert.equal(a.part_ref, "o3");
  assert.equal(updateTask(db, a.ref, { part: "o2" }).part_ref, "o2");
  assert.equal(updateTask(db, a.ref, { part: "" }).part_ref, null);
  assert.match(JSON.stringify(getTask(db, a.ref).events.at(-1)), /part_id/);
  editNode(db, "o4", { archive: true, reason: "并入" }, "u1");
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ part: "o4" }, /part: 节点 o4 cli 已归档/],
    [{ part: "nope" }, /part: 节点 nope 不存在/],
    [{ goal: "g1" }, /不认识的字段：goal/],
    [{ part: 3 }, /part: 应为节点/],
  ];
  for (const [input, message] of bad)
    assert.throws(() => createTask(db, { title: "x", ...input }), message);
  db.close();
});

test("top：目标段改读全景图；全景取不到不影响看板", async () => {
  const board = {
    now: 0,
    recent_ms: 0,
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
  };
  const paths: string[] = [];
  const api = (map: () => unknown) =>
    ({
      get: async (path: string) => {
        paths.push(path);
        if (path.startsWith("/map/tree")) return map();
        if (path === "/tasks/plan") throw new Error("没排期");
        return board;
      },
    }) as unknown as Client;
  const tree = {
    root: "o1",
    tree: {
      ref: "o1",
      name: "组织",
      alias: "",
      analogy: "",
      kind: "org",
      what: "",
      archived: false,
      dot: "running",
      tasks: { running: 1, blocked: 0, open: 1 },
      children_count: 1,
      children: [
        {
          ref: "o2",
          name: "Atrium",
          alias: "底座",
          analogy: "",
          kind: "project",
          what: "AI 组织的运行底座",
          archived: false,
          dot: "running",
          tasks: { running: 1, blocked: 0, open: 1 },
          children_count: 0,
          children: [],
        },
      ],
    },
  };
  const snapshot = await snapshotOf(
    api(() => tree),
    undefined,
    3,
  );
  assert.ok(paths.includes("/map/tree?depth=3"));
  assert.equal(snapshot.map?.root, "o1", "状态栏读 top --json 的 map 字段");
  const text = renderTop(snapshot, {
    width: 100,
    now: 0,
    footer: false,
    color: false,
  });
  assert.match(
    text,
    /全景\n {2}● o2 底座（Atrium） · 在跑 1 · AI 组织的运行底座/,
  );
  const broken = await snapshotOf(
    api(() => {
      throw new Error("连不上");
    }),
    undefined,
  );
  assert.equal(broken.map, null);
  assert.match(
    renderTop(broken, { width: 100, now: 0, footer: false, color: false }),
    /全景：取不到（连不上）/,
  );
});

test("要点：增改删与排序、权限按 leader 链、不留修订；show 带本节点与上级链，排在现状前", async (t) => {
  const db = setup();
  const k1 = addPoint(
    db,
    "o2",
    { text: "不采信执行者自述", why: "事实由运行时查", by: "u1 09-27" },
    "a1",
  );
  assert.deepEqual([k1.ref, k1.node, k1.check], ["k1", "o2", null]);
  const k2 = addPoint(
    db,
    "atrium/runtime",
    {
      text: "服务重启不带走执行者",
      why: "升级随时可做",
      by: "u1 09-26",
      check: "tests/recovery.test.ts「按 pid 接管」",
    },
    "a2",
  );
  addPoint(db, "o1", { text: "根要点", why: "w", by: "u1" }, "u1");
  assert.throws(
    () => addPoint(db, "o1", { text: "x", why: "w", by: "a1" }, "a1"),
    /根节点的要点只有你能改/,
  );
  assert.throws(
    () => addPoint(db, "o2", { text: "x", why: "w", by: "a2" }, "a2"),
    /a2 不是 o2 的 leader/,
    "下级 leader 不能改上级的要点",
  );
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ why: "w", by: "u1" }, /要点: 要点必填/],
    [{ text: " ", why: "w", by: "u1" }, /要点: 要点不能为空/],
    [{ text: "x", by: "u1" }, /--why: 为什么必填/],
    [{ text: "x", why: "w" }, /--by: 谁定的必填/],
    [{ text: "x".repeat(201), why: "w", by: "u1" }, /不能超过 200 字/],
    [{ text: "x", why: "w", by: "u1", check: 1 }, /--check: 应为/],
    [{ text: "x", why: "w", by: "u1", who: 1 }, /who: 是未知字段/],
  ];
  for (const [input, message] of bad)
    assert.throws(() => validatePoint(input), message);
  assert.throws(() => validatePoint({}, true), /至少改一项/);
  const edited = editPoint(db, "k2", { check: "" }, "a1");
  assert.equal(edited.check, null, "上级 leader 能改，--check '' 去掉检查");
  assert.equal(
    editPoint(db, "k2", { text: "重启不丢执行者" }, "a2").why,
    "升级随时可做",
  );
  assert.throws(
    () => editPoint(db, "k9", { text: "x" }, "u1"),
    /要点 k9 不存在/,
  );
  assert.throws(() => removePoint(db, "2", "u1"), /要点短号应为 k1/);
  assert.deepEqual(
    chainPoints(db, 3).map((l) => [l.node, l.points.map((p) => p.ref)]),
    [
      ["o1", ["k3"]],
      ["o2", ["k1"]],
      ["o3", ["k2"]],
    ],
  );
  const shown = show(db, "o3");
  assert.deepEqual(
    shown.points.map((p) => p.text),
    ["重启不丢执行者"],
  );
  assert.equal(shown.points_chain.length, 3);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM org_revisions WHERE target<>'node'")
      .get()!.n,
    0,
    "要点不留修订",
  );
  // 排序：靠前的更重要；--pos 挪到第几条，其余顺延。
  assert.deepEqual(reorder([1, 2, 3], 3, 1), [3, 1, 2]);
  assert.deepEqual(reorder([1, 2, 3], 1, 9), [2, 3, 1]);
  addPoint(db, "o1", { text: "根二", why: "w", by: "u1", pos: 1 }, "u1");
  assert.deepEqual(
    chainPoints(db, 1)[0]!.points.map((p) => p.text),
    ["根二", "根要点"],
  );
  editPoint(db, "k4", { pos: 2 }, "u1");
  assert.deepEqual(
    chainPoints(db, 1)[0]!.points.map((p) => p.text),
    ["根要点", "根二"],
  );
  assert.throws(() => validatePoint({ pos: 0 }, true), /--pos: 应为 1–30/);
  charter(db, "o3", { what: "派活" }, "a2");
  const lines = formatOverview(
    { ref: "o3", name: "runtime" },
    show(db, "o3").overview,
    false,
    shown.points,
  );
  const at = lines.indexOf(
    "要点（必须守住；越靠前越重要，冲突时靠前的优先）：",
  );
  assert.ok(at > 0 && at < lines.findIndex((l) => l.startsWith("现在做到哪")));
  assert.equal(lines[at + 1], "  1. k2 重启不丢执行者");
  assert.equal(lines[at + 2], "     为什么：升级随时可做 · u1 09-26 定");
  assert.equal(removePoint(db, "k2", "a2").ref, "k2");
  assert.equal(show(db, "o3").points.length, 0);
  const k5 = addPoint(db, "o3", { text: "新", why: "w", by: "u1" }, "a2");
  assert.equal(k5.ref, "k5", "短号不复用");
  db.close();

  const data = mkdtempSync(join(tmpdir(), "atrium-points-"));
  t.after(() => removeTemp(data));
  const { app, db: live } = await createApp({ data, auth: false });
  t.after(() => app.close());
  seed(live);
  const created = await app.inject({
    method: "POST",
    url: "/api/org/nodes/o3/points?as=a2",
    payload: { text: "x", why: "w", by: "u1 09-27" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/org/points/k1?as=a2",
        payload: { why: "新理由" },
      })
    ).json().why,
    "新理由",
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/api/org/points/k1?as=a1" }))
      .statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/api/org/points/k1" }))
      .statusCode,
    404,
  );
});
