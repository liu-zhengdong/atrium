import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Problem } from "../server/problem.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc, editNode } from "../server/org/write.ts";
import { show as showNode } from "../server/org/read.ts";
import {
  exportDocument,
  parseDocument,
  validateFields,
} from "../server/org/validate.ts";
import { overviewOf, type Overview } from "../server/org/overview.ts";
import { formatOverview, titleOf } from "../cli/org-overview.ts";
import { formatMigration, type MigrationView } from "../cli/org.ts";
import { evidenceOf, planMigration } from "../server/goals/migrate-rules.ts";
import { ensureGoalTables } from "../server/goals/schema.ts";
import { addGoal, settleGoal } from "../server/goals/write.ts";
import { migrateGoals } from "../server/goals/migrate.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { createApp } from "../server/app.ts";
import { renderTop, snapshotOf } from "../cli/top.ts";
import type { Client } from "../cli/service.ts";

/** 不带 raw 的 org show。 */
const show = (db: DatabaseSync, at: string) =>
  showNode(db, at) as Exclude<ReturnType<typeof showNode>, { raw: string }>;
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
  ensureGoalTables(db);
  seed(db);
  return db;
}
const charter = (
  db: DatabaseSync,
  at: string,
  fields: Record<string, unknown>,
  actor = "u1",
) =>
  editDoc(
    db,
    at,
    "charter",
    { fields, body: "负责 server/tasks/", reason: "写人话" },
    actor,
  );

test("人话字段：合法输入写进章程，破坏输入按字段名中文拒绝", () => {
  const ok = validateFields("charter", {
    goal: "底座",
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
    [{ what: 1 }, /charter\.what 应为文本/],
    [{ alias: "名".repeat(41) }, /charter\.alias 超过 40 字/],
    [{ uses: "一条" }, /charter\.uses 应为文本列表/],
    [{ uses: Array(11).fill("x") }, /charter\.uses 超过 10 项/],
    [{ flow: [1] }, /charter\.flow\[0\] 应为文本/],
    [{ stages: {} }, /charter\.stages 应为阶段列表/],
    [
      { stages: [{ id: "g1", result: "x", status: "done" }] },
      /charter\.stages\[0\]\.status 只能是/,
    ],
    [
      {
        stages: [
          { id: "g1", result: "x", status: "active" },
          { id: "g1", result: "y", status: "active" },
        ],
      },
      /charter\.stages\[1\]\.id 与前面的阶段重复：g1/,
    ],
    [
      { stages: [{ id: "g1", result: " ", status: "active" }] },
      /charter\.stages\[0\]\.result 不能为空/,
    ],
    [
      { stages: [{ id: "g1", result: "x", status: "active", who: 1 }] },
      /charter\.stages\[0\]\.who 是未知字段/,
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
    assert.throws(() => validateFields("charter", fields), message);
  assert.throws(
    () => validateFields("card", { what: "x" }),
    /card\.what 是未知字段/,
    "人话字段只在章程里",
  );
});

test("阶段记录导出为 YAML 块，读回来一致", () => {
  const stages = [
    {
      id: "g13",
      result: "看得见",
      status: "achieved",
      criteria: ["$ npx tsx --test tests/top.test.ts", "秘书看过"],
      evidence: ["第 1 条通过（命令，退出码 0，u1，2026-09-27）"],
    },
  ];
  const source = exportDocument({ goal: "g", stages }, "正文", []);
  assert.match(source, /\nstages:\n {2}- id: g13\n/);
  const parsed = parseDocument(source, "charter");
  assert.deepEqual(parsed.fields, { goal: "g", stages });
  assert.equal(parsed.body, "正文");
});

test("org show 的人话视图：组成部分取子节点的人话名与类比，是什么缺省取目标", () => {
  const db = setup();
  charter(db, "o2", {
    goal: "成为 AI 组织的运行底座",
    uses: ["提一句目标，等汇报"],
  });
  charter(db, "o3", { alias: "派活员", analogy: "项目经理" }, "a1");
  editNode(db, "o4", { archive: true, reason: "并入" }, "u1");
  createTask(db, { title: "x", role: "o3" });
  const shown = show(db, "o2");
  assert.equal(shown.overview.what, "成为 AI 组织的运行底座");
  assert.equal(shown.overview.what_from_goal, true);
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
    "由哪几部分组成：",
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
  assert.ok(!lines.some((l) => l.includes("o9")), "归档的部分默认不列");
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
  assert.match(blank[0]!, /人话介绍还没写.*atrium org show o4 --charter --raw/);
  assert.equal(blank[1], "由哪几部分组成：没有下一层");
  const partial = formatOverview(
    { ref: "o4", name: "cli" },
    overview({ what: "命令行" }),
  );
  assert.ok(partial.includes("能用它做什么：（未写）"));
});

test("迁移判定：gN 变成负责节点的阶段，证据取说明与每条验收的最新判定；任务只回填没有归属的", () => {
  const goals = [
    {
      id: 1,
      parent_id: null,
      result: "顶层",
      criteria: [],
      status: "active" as const,
      note: null,
      node_id: 2,
      due: null,
      repo: null,
    },
    {
      id: 2,
      parent_id: 1,
      result: "看得见",
      criteria: ["$ npm test", "秘书看过", "没判过的"],
      status: "achieved" as const,
      note: "t36 已合入",
      node_id: 3,
      due: "2026-10-01",
      repo: "/r",
    },
    {
      id: 3,
      parent_id: 1,
      result: "负责节点没了",
      criteria: [],
      status: "planned" as const,
      note: null,
      node_id: 99,
      due: null,
      repo: null,
    },
    {
      id: 4,
      parent_id: 1,
      result: "已迁过",
      criteria: [],
      status: "achieved" as const,
      note: null,
      node_id: 3,
      due: null,
      repo: null,
    },
  ];
  const at = Date.UTC(2026, 8, 27);
  const checks = [
    {
      goal_id: 2,
      criterion: "$ npm test",
      kind: "command" as const,
      result: "pass" as const,
      exit_code: 0,
      note: null,
      actor: "u1",
      started_at: at,
    },
    {
      goal_id: 2,
      criterion: "秘书看过",
      kind: "manual" as const,
      result: "pass" as const,
      exit_code: null,
      note: "线上已核",
      actor: "a1",
      started_at: at,
    },
    {
      goal_id: 2,
      criterion: "改措辞前的旧条目",
      kind: "manual" as const,
      result: "fail" as const,
      exit_code: null,
      note: "作废",
      actor: "a1",
      started_at: at,
    },
  ];
  assert.deepEqual(evidenceOf(goals[1]!, checks), [
    "t36 已合入",
    "第 1 条通过（命令，退出码 0，u1，2026-09-27）",
    "第 2 条通过（人工，a1，2026-09-27）：线上已核",
  ]);
  const plan = planMigration({
    goals,
    dependencies: [{ goal_id: 2, after_id: 4 }],
    checks,
    nodes: [
      { id: 2, name: "Atrium", path: "atrium", stages: [] },
      { id: 3, name: "runtime", path: "atrium/runtime", stages: ["g4"] },
    ],
    tasks: [
      { id: 7, goal_id: 2, part_id: null },
      { id: 8, goal_id: 2, part_id: 5 },
      { id: 9, goal_id: 3, part_id: null },
    ],
  });
  assert.deepEqual(
    plan.nodes.map((n) => [n.node, n.stages.map((s) => s.id), n.kept]),
    [
      [2, ["g1"], []],
      [3, ["g2"], ["g4"]],
    ],
  );
  assert.deepEqual(plan.nodes[1]!.stages[0], {
    id: "g2",
    result: "看得见",
    status: "achieved",
    criteria: ["$ npm test", "秘书看过", "没判过的"],
    evidence: [
      "t36 已合入",
      "第 1 条通过（命令，退出码 0，u1，2026-09-27）",
      "第 2 条通过（人工，a1，2026-09-27）：线上已核",
    ],
    due: "2026-10-01",
    after: ["g4"],
    parent: "g1",
    repo: "/r",
  });
  assert.deepEqual(plan.nodes[0]!.stages[0], {
    id: "g1",
    result: "顶层",
    status: "active",
  });
  assert.deepEqual(plan.tasks, [{ task: 7, goal: 2, part: 3 }]);
  assert.deepEqual(plan.tasks_kept, [{ task: 8, goal: 2, part: 5 }]);
  assert.deepEqual(plan.orphans, [{ goal: 3, node: 99 }]);
});

test("task --part 与旧写法 --goal：落到节点、摘下、归档与二选一", () => {
  const db = setup();
  addGoal(db, { result: "顶层", node: "atrium" }, "u1");
  addGoal(db, { result: "M", parent: "g1", node: "atrium/runtime" }, "u1");
  const a = createTask(db, { title: "a", part: "atrium/runtime" });
  assert.equal(a.part_ref, "o3");
  assert.equal(a.goal_ref, null);
  const b = createTask(db, { title: "b", goal: "g2" });
  assert.equal(b.part_ref, "o3", "gN 按负责节点映射");
  assert.equal(createTask(db, { title: "c", goal: "o4" }).part_ref, "o4");
  assert.equal(updateTask(db, a.ref, { part: "o2" }).part_ref, "o2");
  assert.equal(updateTask(db, a.ref, { part: "" }).part_ref, null);
  assert.match(JSON.stringify(getTask(db, a.ref).events.at(-1)), /part_id/);
  editNode(db, "o4", { archive: true, reason: "并入" }, "u1");
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ part: "o4" }, /part: 节点 o4 cli 已归档/],
    [{ part: "nope" }, /part: 节点 nope 不存在/],
    [{ goal: "g9" }, /goal: 目标 g9 不存在；改用 --part 节点/],
    [{ part: "o2", goal: "g1" }, /part: 与 goal 只能给一个/],
    [{ part: 3 }, /part: 应为节点/],
  ];
  for (const [input, message] of bad)
    assert.throws(() => createTask(db, { title: "x", ...input }), message);
  db.close();
});

test("迁移接口：预览不写；只有 u1 能写；写入先备份，阶段进章程、任务回填、goal 接口下线并指路", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-migrate-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { app, db } = await createApp({ data, auth: false });
  t.after(() => app.close());
  seed(db);
  addGoal(db, { result: "顶层", node: "atrium" }, "u1");
  addGoal(
    db,
    {
      result: "闭环",
      parent: "g1",
      node: "atrium/runtime",
      criteria: ["看过"],
    },
    "u1",
  );
  settleGoal(db, "g2", { kind: "done" }, { note: "t9 已合入" }, "u1");
  charter(db, "o3", { goal: "跑得稳", alias: "派活员" }, "a1");
  const task = createTask(db, { title: "旧任务" });
  db.prepare("UPDATE tasks SET goal_id=2 WHERE id=?").run(
    Number(task.ref.slice(1)),
  );
  const call = async (method: "GET" | "POST", url: string, payload = {}) => {
    const response = await app.inject({ method, url, payload });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, unknown>,
    };
  };
  const preview = await call("POST", "/api/goals/migrate", {});
  assert.equal(preview.status, 200);
  const view = preview.body as unknown as MigrationView;
  assert.equal(view.preview, true);
  assert.equal(view.stages, 2);
  assert.deepEqual(view.tasks, [
    { task: task.ref, goal: "g2", part: "o3", part_name: "runtime" },
  ]);
  assert.equal(show(db, "o3").overview.stages.length, 0, "预览不写");
  const text = formatMigration(view);
  assert.match(text, /预览，未写入/);
  assert.match(text, /o3 runtime（atrium\/runtime）← 1 条阶段/);
  assert.match(text, /g2 \[达成\] 闭环 · 验收 1 条 · 证据 1 条/);
  assert.match(text, new RegExp(`${task.ref} g2 → o3 runtime`));

  const denied = await call("POST", "/api/goals/migrate?as=a1", {
    apply: true,
  });
  assert.equal(denied.status, 403);

  const applied = await call("POST", "/api/goals/migrate", { apply: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const backup = applied.body.backup as string;
  assert.ok(backup.startsWith(join(data, "backups")) && existsSync(backup));
  const copy = new DatabaseSync(backup, { readOnly: true });
  assert.equal(
    (copy.prepare("SELECT count(*) AS n FROM goals").get() as { n: number }).n,
    2,
    "备份是迁移前的整库",
  );
  copy.close();
  const runtime = show(db, "o3");
  assert.deepEqual(runtime.overview.stages, [
    {
      id: "g2",
      result: "闭环",
      status: "achieved",
      criteria: ["看过"],
      evidence: ["t9 已合入"],
      parent: "g1",
    },
  ]);
  assert.equal(runtime.charter?.fields.goal, "跑得稳", "原有字段保留");
  assert.equal(runtime.charter?.body, "负责 server/tasks/", "正文保留");
  assert.equal(runtime.overview.alias, "派活员");
  assert.equal(show(db, "o2").overview.stages[0]!.id, "g1");
  const migrated = getTask(db, task.ref);
  assert.equal(migrated.part_ref, "o3");
  assert.equal(migrated.goal_ref, "g2", "原来的 goal 不改");

  const gone = await call("GET", "/api/goals/g2");
  assert.equal(gone.status, 410);
  assert.match(String(gone.body.error), /goal 命令已下线；g2 在 o3 runtime/);
  assert.equal(gone.body.nextCommand, "atrium org show o3");
  for (const [method, url] of [
    ["GET", "/api/goals/tree"],
    ["POST", "/api/goals"],
    ["POST", "/api/goals/g1/done"],
    ["POST", "/api/goals/adopt"],
  ] as const)
    assert.equal((await call(method, url)).status, 410, url);

  const again = await call("POST", "/api/goals/migrate", { apply: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.stages, 0);
  assert.equal(again.body.backup, backup, "重复执行不再备份、不重复写");
  assert.equal(show(db, "o3").overview.stages.length, 1);
  assert.match(
    formatMigration(again.body as unknown as MigrationView),
    /已迁移：\n {2}o2 Atrium（atrium）← 0 条阶段，已在章程里 g1/,
  );

  const mapped = await call("POST", "/api/tasks", { title: "新", goal: "g1" });
  assert.equal(mapped.body.part_ref, "o2", "迁移后 --goal gN 照映射落到节点");
});

test("top：目标树下线后目标段指向组织节点，不当成取不到", async () => {
  const api = {
    get: async (path: string) => {
      if (path === "/goals/tree")
        throw new Problem(
          410,
          "目标树已迁为组织节点的阶段记录",
          "conflict",
          undefined,
          "atrium org tree",
        );
      if (path === "/tasks/plan") throw new Error("没排期");
      return {
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
    },
  } as unknown as Client;
  const snapshot = await snapshotOf(api, undefined);
  assert.equal(snapshot.goals, undefined);
  const text = renderTop(snapshot, {
    width: 100,
    now: 0,
    footer: false,
    color: false,
  });
  assert.match(text, /目标：已迁为组织节点的阶段记录，看 atrium org tree/);
  assert.doesNotMatch(text, /目标：取不到/);
});
