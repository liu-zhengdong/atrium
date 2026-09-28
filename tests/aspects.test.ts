import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editNode } from "../server/org/write.ts";
import { addPoint, editPoint } from "../server/org/points.ts";
import {
  appliedFrom,
  covers,
  pointScope,
  type AspectPoint,
  type ScopeNode,
} from "../server/org/aspects.ts";
import { addMap, editMap } from "../server/map/write.ts";
import { contextOf, formatContext, mapContext } from "../server/map/context.ts";
import { mapNode } from "../server/map/view.ts";
import { mapPartRoles, mapRole, mapRoles } from "../server/map/people.ts";
import {
  createJobRole,
  editJobRole,
  ensureJobRoles,
  getJobRole,
  listJobRoles,
  type JobRole,
} from "../server/tasks/job-roles.ts";
import { createTask, updateTask } from "../server/tasks/ledger-write.ts";
import { getTask } from "../server/tasks/ledger-read.ts";
import {
  inScope,
  pickSpecialists,
  scopeOf,
  specialistsForPart,
} from "../server/tasks/specialist-scope.ts";
import { remarkVerdict } from "../server/leaders/scope.ts";
import { foldedLines } from "../cli/specialists.ts";
import { specialistLine } from "../cli/tasks.ts";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { publishTask } from "../server/tasks/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import { Problem } from "../server/problem.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 横跨部分第 1 步（#373）：管方面的部分、要点适用范围、任务牵涉、专员归属。
 * 树：o1 组织 → o2 Atrium → o3 网页、o4 命令行、o5 安全（管方面）。
 */

const list: ScopeNode[] = [
  { id: 1, parent_id: null, name: "组织", archived_at: null },
  { id: 2, parent_id: 1, name: "Atrium", archived_at: null },
  { id: 3, parent_id: 2, name: "网页", archived_at: null },
  { id: 4, parent_id: 2, name: "命令行", archived_at: null },
  { id: 5, parent_id: 2, name: "安全", archived_at: null, aspect: 1 },
  { id: 6, parent_id: 3, name: "全景页", archived_at: null },
  { id: 7, parent_id: 2, name: "旧块", archived_at: 1 },
];
const point = (id: number, applies: number[] | null = null): AspectPoint => ({
  ref: `k${id}`,
  text: `要点${id}`,
  why: "为什么",
  by: "u1",
  check: null,
  applies: applies ? JSON.stringify(applies) : null,
});

test("适用范围：要点写的 → 节点写的 → 整个上级；坏数据当没写；根节点退回自己", () => {
  const node = { id: 5, parent_id: 2 };
  assert.deepEqual(pointScope(node, null), [2]);
  assert.deepEqual(pointScope({ ...node, applies: "[3]" }, null), [3]);
  assert.deepEqual(pointScope({ ...node, applies: "[3]" }, "[4]"), [4]);
  assert.deepEqual(pointScope(node, "坏"), [2]);
  assert.deepEqual(pointScope(node, "[]"), [2]);
  assert.deepEqual(pointScope(node, '["o3"]'), [2]);
  assert.deepEqual(pointScope({ id: 1, parent_id: null }, null), [1]);
});

test("覆盖：自己与下层算，兄弟与上层不算，归档的范围失效", () => {
  assert.equal(covers(list, [3], 3), true);
  assert.equal(covers(list, [3], 6), true);
  assert.equal(covers(list, [3], 4), false);
  assert.equal(covers(list, [3], 2), false);
  assert.equal(covers(list, [2], 6), true);
  assert.equal(covers(list, [7], 7), false);
  assert.equal(covers(list, [99], 3), false);
  assert.equal(covers(list, [4, 3], 6), true);
});

test("附进来的要点：自动牵涉只取适用的，显式牵涉取全部，归属链上的不重复", () => {
  const points = new Map<number, AspectPoint[]>([
    [5, [point(1, [3]), point(2)]],
    [4, [point(3)]],
  ]);
  // 网页任务：k1（适用于网页）与 k2（整个 Atrium）都自动附上。
  const web = appliedFrom(list, points, 3, []);
  assert.deepEqual(
    web.map((l) => [l.node, l.via, l.source, l.points.map((p) => p.ref)]),
    [["o5", "auto", "安全 · 适用于网页", ["k1", "k2"]]],
  );
  // 命令行任务：只有 k2。
  assert.deepEqual(
    appliedFrom(list, points, 4, []).map((l) => l.points.map((p) => p.ref)),
    [["k2"]],
  );
  // 网页任务显式牵涉命令行：命令行（管东西）的要点全附，注明「本任务牵涉」。
  const also = appliedFrom(list, points, 3, [4]);
  assert.deepEqual(
    also.map((l) => [l.node, l.via, l.source]),
    [
      ["o4", "also", "命令行 · 本任务牵涉"],
      ["o5", "auto", "安全 · 适用于网页"],
    ],
  );
  // 显式牵涉管方面的部分：全附，来源写它的适用范围。
  const onlyWeb = new Map([[5, [point(1, [3])]]]);
  assert.deepEqual(
    appliedFrom(list, onlyWeb, 4, [5]).map((l) => [l.via, l.source]),
    [["also", "安全 · 适用于整个Atrium"]],
  );
  assert.deepEqual(appliedFrom(list, onlyWeb, 4, []), []);
  // 在安全自己下面干活：要点已在归属链里，不再附。
  assert.deepEqual(appliedFrom(list, points, 5, [5]), []);
  // 没有归属部分：只附显式牵涉的。
  assert.deepEqual(appliedFrom(list, points, null, []), []);
  // 归档的管方面部分不附。
  assert.deepEqual(
    appliedFrom(
      list.map((n) => (n.id === 5 ? { ...n, archived_at: 1 } : n)),
      points,
      3,
      [],
    ),
    [],
  );
});

test("专员范围：本部分、上级、牵涉部分、全组织依次；别处的不在范围", () => {
  const input = { part: 3, chain: [1, 2, 3], involved: [5] };
  assert.equal(scopeOf(null, input), "org");
  assert.equal(scopeOf(3, input), "own");
  assert.equal(scopeOf(2, input), "chain");
  assert.equal(scopeOf(5, input), "also");
  assert.equal(scopeOf(4, input), null);
  assert.equal(scopeOf(3, { part: null, chain: [], involved: [] }), null);
  const role = (id: number, part_id: number | null) =>
    ({ id, ref: `r${id}`, name: `专员${id}`, part_id }) as JobRole;
  assert.deepEqual(
    inScope([role(1, null), role(2, 5), role(3, 3), role(4, 4)], input).map(
      (r) => [r.ref, r.scope],
    ),
    [
      ["r3", "own"],
      ["r2", "also"],
      ["r1", "org"],
    ],
  );
});

test("渐进式披露：本部分的列表格，继承的折成一行", () => {
  const row = (name: string, scope: string, part_name: string | null) =>
    ({
      ref: "r1",
      name,
      description: "做事",
      scope,
      part: part_name ? "o5" : null,
      part_name,
      running: 0,
    }) as never;
  const lines = foldedLines(
    [
      row("安全专员", "own", "安全"),
      row("前端", "org", null),
      row("后端", "org", null),
    ],
    "o5",
  );
  assert.match(lines[0]!, /安全专员/);
  assert.doesNotMatch(lines[0]!, /前端/);
  assert.equal(
    lines[1],
    "另有 全组织的 前端、后端（展开：atrium specialist ls --part o5 --all）",
  );
  assert.deepEqual(foldedLines([], "o3"), ["o3 没有自己的专员"]);
  assert.equal(
    specialistLine([
      {
        ref: "r2",
        name: "安全专员",
        scope: "also",
        part: "o5",
        part_name: "安全",
      },
      { ref: "r1", name: "前端", scope: "org", part: null, part_name: null },
    ]),
    "能请的专员：安全专员（安全）；全组织的 前端",
  );
});

test("context：牵涉部分的要点单独成段、注明来源，挤不下时先丢远处", () => {
  const base = {
    chain: [
      { ref: "o2", name: "Atrium", alias: "", analogy: "", what: "" },
      { ref: "o3", name: "网页", alias: "", analogy: "", what: "看全景" },
    ],
    parts: [],
    now: "",
    next: "",
    points: [
      {
        name: "网页",
        points: [{ text: "只读", why: "安全", by: "u1", check: null }],
      },
    ],
  };
  const { text } = formatContext(
    {
      ...base,
      applied: [
        {
          source: "安全 · 适用于网页",
          points: [{ text: "不回显令牌", why: "泄露", by: "u1", check: null }],
        },
      ],
    },
    "o3",
  );
  assert.match(
    text,
    /牵涉部分的要点（同样必须守住）：\n- \[安全 · 适用于网页\] 不回显令牌/,
  );
  assert.ok(text.indexOf("[网页] 只读") < text.indexOf("[安全"));
  // 没有附进来的要点时不出标题。
  assert.doesNotMatch(formatContext(base, "o3").text, /牵涉部分/);
});

test("leader 说话权限：任务在范围里，或牵涉的部分在范围里；都不在就拒", () => {
  const check = { what: "任务 t1", node: 3 };
  assert.equal(remarkVerdict("a2", new Set([5]), check, [5]), null);
  assert.equal(remarkVerdict("a2", new Set([3]), check, []), null);
  assert.match(
    remarkVerdict("a2", new Set([5]), check, [4]) ?? "",
    /a2 无权动任务 t1：不在你负责的部分里/,
  );
});

const dbOf = () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureOrgTables(db);
  ensureJobRoles(db);
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "web", "module", "网页"],
    ["o2", "cli", "module", "命令行"],
  ] as const)
    addNode(db, { parent, slug, kind, name, reason: "测试" }, "u1");
  return db;
};
const problem = (fn: () => unknown, pattern: RegExp) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Problem, String(error));
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`应当报错：${pattern}`);
};

test("管方面的部分：建、写适用范围、map context 自动带出并注明来源", () => {
  const db = dbOf();
  const added = addMap(
    db,
    { parent: "o2", name: "安全", slug: "security", kind: "aspect" },
    "u1",
  );
  assert.deepEqual(
    { node: added.node, kind: added.kind, aspect: added.aspect },
    { node: "o5", kind: "module", aspect: true },
  );
  const k1 = addPoint(
    db,
    "o5",
    {
      text: "网页不回显令牌",
      why: "泄露收不回",
      by: "u1 09-27",
      applies: "网页",
    },
    "u1",
  );
  assert.deepEqual(k1.applies, ["o3"]);
  // 管东西的部分不能写适用范围；指向不存在的部分报错。
  problem(
    () =>
      addPoint(
        db,
        "o4",
        { text: "x", why: "y", by: "u1", applies: "o3" },
        "u1",
      ),
    /--applies: o4 命令行 不是管方面的部分/,
  );
  problem(
    () => editPoint(db, k1.ref, { applies: "o99" }, "u1"),
    /--applies: 节点 o99 不存在/,
  );
  problem(
    () => editMap(db, "o4", { applies: "o3" }, "u1"),
    /--applies: o4 命令行 不是管方面的部分/,
  );
  assert.match(
    mapContext(db, "o3").text,
    /牵涉部分的要点（同样必须守住）：\n- \[安全 · 适用于网页\] 网页不回显令牌/,
  );
  assert.doesNotMatch(mapContext(db, "o4").text, /网页不回显令牌/);
  // --also 显式牵涉：全部附上。
  assert.match(
    mapContext(db, "o4", undefined, "安全").text,
    /\[安全 · 适用于整个Atrium\] 网页不回显令牌/,
  );
  // 节点级适用范围：不写要点级时跟随节点。
  addPoint(db, "o5", { text: "命令行要点", why: "w", by: "u1" }, "u1");
  assert.match(contextOf(db, 4).text, /\[安全 · 适用于命令行\] 命令行要点/);
  editMap(db, "o5", { applies: "o3" }, "u1");
  assert.doesNotMatch(contextOf(db, 4).text, /命令行要点/);
  assert.match(contextOf(db, 3).text, /命令行要点/);
  // 要点改回跟随节点。
  editPoint(db, k1.ref, { applies: "" }, "u1");
  assert.equal(pointApplies(db, k1.ref), null);
  // 全景接口带上管方面与适用范围，以及适用于本块的别处要点。
  const view = mapNode(db, "o5", []);
  assert.equal(view.aspect, true);
  assert.deepEqual(view.applies, ["o3"]);
  assert.deepEqual(
    mapNode(db, "o3", []).points_applied.map((l) => l.source),
    ["安全 · 适用于网页"],
  );
});
test("已有部分改类型：module ↔ aspect 留节点修订；project/org 不许；改回 module 要先清适用范围", () => {
  const db = dbOf();
  const nodeRevs = () =>
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM org_revisions WHERE node_id=3 AND target='node'",
        )
        .get() as { n: number }
    ).n;
  assert.equal(nodeRevs(), 1);
  const turned = editNode(
    db,
    "o3",
    { kind: "aspect", reason: "横向看性能" },
    "u1",
  );
  assert.equal((turned as { aspect: number }).aspect, 1);
  assert.equal(nodeRevs(), 2);
  assert.equal(mapNode(db, "o3", []).aspect, true);
  // 管方面后要点可写适用范围：改回 module 前要先清掉，且列出命令。
  const k = addPoint(
    db,
    "o3",
    { text: "延迟", why: "体验", by: "u1", applies: "o2" },
    "u1",
  );
  problem(
    () => editNode(db, "o3", { kind: "module", reason: "改回" }, "u1"),
    /还有适用范围，改回 module 前先清掉：要点 k\d+（atrium org point-edit k\d+ --applies ''）/,
  );
  editPoint(db, k.ref, { applies: "" }, "u1");
  // 部分级缺省范围也在：同样拦住，并给 map edit 命令。
  editMap(db, "o3", { applies: "o2" }, "u1");
  problem(
    () => editNode(db, "o3", { kind: "module", reason: "改回" }, "u1"),
    /本部分的缺省适用范围（atrium map edit o3 --applies ''）/,
  );
  editMap(db, "o3", { applies: "" }, "u1");
  const back = editNode(db, "o3", { kind: "module", reason: "改回" }, "u1");
  assert.equal((back as { aspect: number }).aspect, 0);
  assert.equal(nodeRevs(), 3);
  assert.equal(mapNode(db, "o3", []).aspect, false);
  // 只有 module 能改成 aspect；未知 kind 报用法错。
  problem(
    () => editNode(db, "o2", { kind: "aspect", reason: "越级" }, "u1"),
    /只有 module 部分能改成 aspect/,
  );
  problem(
    () => editNode(db, "o1", { kind: "aspect", reason: "越级" }, "u1"),
    /只有 module 部分能改成 aspect/,
  );
  problem(
    () => editNode(db, "o3", { kind: "project", reason: "乱来" }, "u1"),
    /kind 只能是 aspect 或 module/,
  );
});

const pointApplies = (db: DatabaseSync, reference: string) =>
  (
    db
      .prepare("SELECT applies FROM org_points WHERE id=?")
      .get(Number(reference.slice(1))) as { applies: string | null }
  ).applies;

test("专员归属与任务牵涉：范围外报错并列出可选专员，--also 后可以", () => {
  const db = dbOf();
  addMap(
    db,
    { parent: "o2", name: "安全", slug: "security", kind: "aspect" },
    "u1",
  );
  addPoint(
    db,
    "o5",
    { text: "网页不回显令牌", why: "泄露", by: "u1", applies: "o3" },
    "u1",
  );
  createJobRole(db, { name: "前端", description: "页面", body: "做页面" });
  createJobRole(db, { name: "后端", description: "服务", body: "做服务" });
  const sec = createJobRole(db, {
    name: "安全专员",
    description: "查安全",
    body: "查",
    part: "安全",
  });
  assert.deepEqual([sec.part, sec.part_name], ["o5", "安全"]);
  assert.equal(listJobRoles(db).find((r) => r.id === sec.id)?.part, "o5");
  problem(
    () =>
      createJobRole(db, {
        name: "坏",
        description: "d",
        body: "b",
        part: "o99",
      }),
    /part: 节点 o99 不存在/,
  );
  // 网页任务不写 --also：安全自动牵涉，安全专员可请。
  const web = createTask(db, {
    title: "改网页",
    part: "o3",
    by: "安全专员",
    deliver: "none",
  });
  assert.deepEqual(web.also_auto, ["o5"]);
  assert.equal(web.also, undefined);
  // 命令行任务：安全专员不在范围，报错给出可选名单与下一步。
  const error = problem(
    () =>
      createTask(db, {
        title: "改命令行",
        part: "命令行",
        by: "安全专员",
        deliver: "none",
      }),
    /by: 安全专员（r3）属于「安全」（o5），本任务归属 o4，请不到它；可选：前端、后端；确实要它一起看，加 --also o5/,
  ) as Problem;
  assert.equal(error.nextCommand, "atrium specialist ls --part o4");
  problem(
    () => createTask(db, { title: "没归属", by: "安全专员", deliver: "none" }),
    /本任务没有归属部分/,
  );
  const cli = createTask(db, {
    title: "改命令行",
    part: "o4",
    also: "安全",
    by: "安全专员",
    deliver: "none",
  });
  assert.deepEqual(cli.also, ["o5"]);
  const shown = getTask(db, cli.ref);
  assert.deepEqual(shown.also, ["o5"]);
  assert.match(
    JSON.stringify(shown.events.find((e) => e.kind === "created")?.detail),
    /also.*o5/,
  );
  // 摘掉牵涉：干活的专员就不在范围，拒绝；一并换人可以。
  problem(() => updateTask(db, cli.ref, { also: "" }), /by: 安全专员（r3）/);
  const cleared = updateTask(db, cli.ref, { also: "", by: "后端" });
  assert.equal(cleared.also, undefined);
  assert.equal(cleared.job_ref, "r2");
  assert.ok(
    getTask(db, cli.ref).events.some(
      (e) => e.kind === "also" && /"to":\[\]/.test(e.detail ?? ""),
    ),
  );
  // 改归属把专员挤出范围：拒绝。
  problem(() => updateTask(db, web.ref, { part: "o4" }), /by: 安全专员/);
  // 破坏输入。
  problem(
    () => createTask(db, { title: "x", part: "o4", also: "o99" }),
    /also: 节点 o99 不存在/,
  );
  problem(
    () => createTask(db, { title: "x", part: "o4", also: 3 as never }),
    /also: 应为部分/,
  );
  // 这一部分可选的专员：本部分在前，全组织在后；task pick 同一份。
  assert.deepEqual(
    specialistsForPart(db, "o3").specialists.map((s) => [s.name, s.scope]),
    [
      ["安全专员", "also"],
      ["前端", "org"],
      ["后端", "org"],
    ],
  );
  assert.deepEqual(
    specialistsForPart(db, "o5").specialists.map((s) => s.scope),
    ["own", "org", "org"],
  );
  const pick = pickSpecialists(db, getTask(db, web.ref));
  assert.equal(pick.job_outside, null);
  assert.deepEqual(
    pick.available.map((s) => s.name),
    ["安全专员", "前端", "后端"],
  );
  // 专员改回全组织：行为与旧专员一致。
  assert.equal(editJobRole(db, "安全专员", { part: "" }).part, null);
  assert.equal(getJobRole(db, "r3").part_id, null);
});

test("全景网页（第 2 步）：管方面与适用范围、任务牵涉与归属、专员按层", async () => {
  const db = dbOf();
  addMap(
    db,
    { parent: "o2", name: "安全", slug: "security", kind: "aspect" },
    "u1",
  );
  addPoint(
    db,
    "o5",
    { text: "网页不回显令牌", why: "泄露", by: "u1", applies: "o3" },
    "u1",
  );
  addPoint(db, "o5", { text: "跟随节点", why: "w", by: "u1" }, "u1");
  createJobRole(db, { name: "前端", description: "页面", body: "做页面" });
  createJobRole(db, {
    name: "安全专员",
    description: "查安全",
    body: "查",
    part: "o5",
  });
  createJobRole(db, {
    name: "网页设计",
    description: "版式",
    body: "排",
    part: "o3",
  });
  const web = createTask(db, { title: "改网页", part: "o3", deliver: "none" });
  const cli = createTask(db, {
    title: "改命令行",
    part: "o4",
    also: "安全",
    deliver: "none",
  });
  const plain = createTask(db, {
    title: "命令行别的",
    part: "o4",
    deliver: "none",
  });
  const brief = (list: { ref: string; auto?: boolean }[]) =>
    list.map((p) => `${p.ref}${p.auto ? "（自动）" : ""}`);
  const all = (n: ReturnType<typeof mapNode>) =>
    [
      ...n.tasks.running,
      ...n.tasks.blocked,
      ...n.tasks.todo,
      ...n.tasks.recent,
    ].map((t) => ({
      ref: t.ref,
      also: brief(t.also),
      home: t.home?.ref ?? null,
    }));

  // 组成部分标出管方面；管方面的部分带适用范围（缺省整个上级），要点带各自的范围。
  const atrium = mapNode(db, "o2", []);
  assert.deepEqual(
    atrium.overview.parts.map((p) => [
      p.ref,
      (p as { aspect?: boolean }).aspect,
    ]),
    [
      ["o3", false],
      ["o4", false],
      ["o5", true],
    ],
  );
  assert.equal(atrium.scope, null);
  const security = mapNode(db, "o5", []);
  assert.deepEqual(security.scope, {
    explicit: false,
    parts: [{ ref: "o2", name: "Atrium", alias: "" }],
  });
  assert.deepEqual(
    security.points.map((p) => [
      p.text,
      p.scope?.explicit,
      p.scope?.parts.map((x) => x.ref),
    ]),
    [
      ["网页不回显令牌", true, ["o3"]],
      ["跟随节点", false, ["o2"]],
    ],
  );
  // 上层页的「下层要点」也带范围；管东西的部分的要点不带。
  assert.equal(atrium.points_below[0]?.aspect, true);
  assert.deepEqual(atrium.points_below[0]?.points[0]?.scope?.explicit, true);
  assert.equal(mapNode(db, "o3", []).points_applied[0]?.node, "o5");

  // 任务行：自己部分页上写也牵涉（显式在前，自动的标出）；管方面的部分页列牵涉它的任务并写归哪一块。
  assert.deepEqual(all(mapNode(db, "o3", [])), [
    { ref: web.ref, also: ["o5（自动）"], home: null },
  ]);
  assert.deepEqual(
    all(mapNode(db, "o4", [])).sort((a, b) => a.ref.localeCompare(b.ref)),
    [
      { ref: cli.ref, also: ["o5"], home: null },
      { ref: plain.ref, also: ["o5（自动）"], home: null },
    ].sort((a, b) => a.ref.localeCompare(b.ref)),
  );
  assert.deepEqual(
    all(mapNode(db, "o5", []))
      .map((t) => [t.ref, t.home])
      .sort(),
    [
      [cli.ref, "o4"],
      [plain.ref, "o4"],
      [web.ref, "o3"],
    ].sort(),
  );
  // 只写要点级范围时，范围外的部分不算牵涉：改成节点级只管网页后，命令行的任务只剩显式牵涉的那件。
  editMap(db, "o5", { applies: "o3" }, "u1");
  assert.deepEqual(
    all(mapNode(db, "o5", []))
      .map((t) => [t.ref, t.home])
      .sort(),
    [
      [cli.ref, "o4"],
      [web.ref, "o3"],
    ].sort(),
  );
  // 组织根不重复列（子树里的任务都算自己的）。
  assert.ok(all(mapNode(db, "o1", [])).every((t) => t.home === null));

  // 专员按层：部分页的范围与 specialist ls --part 一致；全组织名单带归属；专员页写属于哪一块。
  assert.deepEqual(
    mapPartRoles(db, "o3").roles.map((r) => [r.name, r.scope]),
    [
      ["网页设计", "own"],
      ["安全专员", "also"],
      ["前端", "org"],
    ],
  );
  assert.deepEqual(
    mapPartRoles(db, "o4").roles.map((r) => r.name),
    ["前端"],
  );
  assert.deepEqual(
    mapRoles(db).roles.map((r) => [r.name, r.part?.ref ?? null]),
    [
      ["前端", null],
      ["安全专员", "o5"],
      ["网页设计", "o3"],
    ],
  );
  assert.deepEqual((await mapRole(db, "安全专员")).part, {
    ref: "o5",
    name: "安全",
    alias: "",
  });
  assert.throws(() => mapPartRoles(db, "o99"), /o99/);
});

test("旧库补列：org_nodes、org_points、job_roles 没有新列也能启动，旧运行时表不动", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE org_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES org_nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('org','project','module','concern')),
    slug TEXT NOT NULL, name TEXT NOT NULL, leader TEXT, doc_path TEXT,
    archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(parent_id,slug));
    INSERT INTO org_nodes(parent_id,kind,slug,name,created_at,updated_at) VALUES(NULL,'org','org','组织',1,1);
    CREATE TABLE org_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    pos INTEGER NOT NULL, text TEXT NOT NULL, why TEXT NOT NULL, decided_by TEXT NOT NULL,
    check_ref TEXT, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO org_points(node_id,pos,text,why,decided_by,updated_by,updated_at) VALUES(1,1,'旧要点','w','u1','u1',1);
    CREATE TABLE job_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL, body TEXT NOT NULL, preferred TEXT NOT NULL, checks TEXT NOT NULL, skills TEXT NOT NULL, rev INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO job_roles(name,description,body,preferred,checks,skills,rev,created_at,updated_at) VALUES('前端','d','b','[]','[]','[]',1,1,1);`);
  ensureTaskTables(db);
  ensureOrgTables(db);
  ensureJobRoles(db);
  ensureOrgTables(db);
  assert.equal(getJobRole(db, "前端").part, null);
  assert.deepEqual(
    { ...db.prepare("SELECT aspect,applies FROM org_nodes").get() },
    { aspect: 0, applies: null },
  );
  assert.equal(
    (db.prepare("SELECT applies FROM org_points").get() as { applies: null })
      .applies,
    null,
  );
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM agents").get() },
    { id: "x", name: "旧身份" },
  );
});

test("隔离服务：被牵涉部分的 leader 收到知会不被叫醒，能写备注不能派活", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-aspects-"));
  t.after(() => removeTemp(data));
  const runs: LeaderRunSpec[] = [];
  let behave = async (_spec: LeaderRunSpec) => "ok" as const;
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      maxFailures: 2,
      run: async (spec) => {
        runs.push(spec);
        return behave(spec);
      },
    },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    authorization = user,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", authorization },
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
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "web", "module", "网页"],
    ["o2", "cli", "module", "命令行"],
  ] as const)
    await ok("POST", "/api/org/nodes", {
      parent,
      slug,
      kind,
      name,
      reason: "建",
    });
  await ok("POST", "/api/map/nodes", {
    parent: "o2",
    name: "安全",
    slug: "security",
    kind: "aspect",
  });
  await ok("POST", "/api/org/nodes/o5/points", {
    text: "网页不回显令牌",
    why: "泄露",
    by: "u1",
    applies: "o3",
  });
  await ok("POST", "/api/leaders", { name: "Atrium 负责人", worker: "codex" });
  await ok("POST", "/api/leaders", { name: "安全负责人", worker: "codex" });
  await ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await ok("PATCH", "/api/org/nodes/o5", { leader: "a2", reason: "指派" });
  const web = await ok("POST", "/api/tasks", {
    title: "改网页",
    part: "o3",
    deliver: "none",
  });
  assert.deepEqual(web.also_auto, ["o5"]);
  await ok("POST", "/api/tasks", {
    title: "改命令行",
    part: "o4",
    deliver: "none",
  });
  await ok("POST", "/api/tasks", {
    title: "安全巡查",
    part: "o5",
    deliver: "none",
  });
  const inbox = created.taskRunner.inbox;
  const notices = inbox.list("a2", { limit: 50 }).events;
  assert.deepEqual(
    notices.map((e) => [e.task, e.kind, e.level]),
    [["t1", "involved", "info"]],
  );
  assert.match(
    (notices[0]!.detail as { hint: string }).hint,
    /t1 牵涉你负责的「安全」（它的要点适用于这个任务的归属部分）/,
  );
  // 命令行任务显式牵涉安全：再知会一条；重复改不重复知会。
  await ok("PATCH", "/api/tasks/t2", { also: "o5" });
  await ok("PATCH", "/api/tasks/t2", { title: "改命令行 2" });
  assert.deepEqual(
    inbox
      .list("a2", { limit: 50 })
      .events.filter((e) => e.kind === "involved")
      .map((e) => e.task)
      .sort(),
    ["t1", "t2"],
  );
  await new Promise((r) => setTimeout(r, 150));
  // 只看 a2：a1 可能因为 t1、t2 自己的事件被叫醒，与知会无关。
  assert.equal(
    runs.filter((r) => r.leader === "a2").length,
    0,
    "知会不叫醒 leader",
  );
  // 叫醒 a2（安全自己的任务失败），用它的令牌试说话与越权。
  const results: Record<string, number> = {};
  let done = false;
  behave = async (spec) => {
    // 这里不确认事件：a2 的唤醒会重试、再转交上级 a1；只记 a2 第一次的结果，免得被覆盖。
    if (done || spec.leader !== "a2") return "ok";
    const auth = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
    results.note = (
      await call(
        "POST",
        "/api/tasks/t1/note",
        { text: "注意令牌", by: "a2" },
        auth,
      )
    ).status;
    results.tell = (
      await call(
        "POST",
        "/api/tasks/t2/tell",
        { text: "看一下", by: "a2" },
        auth,
      )
    ).status;
    results.stop = (await call("POST", "/api/tasks/t1/stop", {}, auth)).status;
    results.patch = (
      await call("PATCH", "/api/tasks/t1", { title: "改" }, auth)
    ).status;
    done = true;
    return "ok";
  };
  // t2 的牵涉摘掉后，a2 就不能再对它说话。
  await ok("PATCH", "/api/tasks/t2", { also: "" });
  publishTask(inbox, created.db, 3, "failed", { reason: "测试" });
  await until(() => done, 20000);
  assert.deepEqual(results, { note: 200, tell: 403, stop: 403, patch: 403 });
  assert.equal((await ok("GET", "/api/tasks/t1")).note_by, "a2");
});
