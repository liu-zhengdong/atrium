import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { ensureGoalTables } from "../server/goals/schema.ts";
import { addGoal, editGoal, settleGoal } from "../server/goals/write.ts";
import { goalShow, goalTree } from "../server/goals/read.ts";
import { adoptTask } from "../server/goals/adopt.ts";
import {
  GOAL_STATUSES,
  adoptBlocker,
  adoptedStatus,
  canChange,
  canCreate,
  depthOf,
  isWithin,
  leadsNode,
  prerequisiteCycle,
  subtreeHeight,
  transition,
  unmetPrerequisites,
  type GoalStatus,
} from "../server/goals/rules.ts";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { createApp } from "../server/app.ts";
import { goalLine, renderGoalTree } from "../cli/goals.ts";

/** 组织 o1（leader u1）；Atrium o2（a1）下 runtime o3（a2）、质量 o4（a3）；OpenQuota o5（a4）。 */
const ORG = [
  { id: 1, parent_id: null, leader: "u1" },
  { id: 2, parent_id: 1, leader: "a1" },
  { id: 3, parent_id: 2, leader: "a2" },
  { id: 4, parent_id: 2, leader: "a3" },
  { id: 5, parent_id: 1, leader: "a4" },
];

function setup() {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureTaskTables(db);
  ensureGoalTables(db);
  const node = (input: Record<string, unknown>) =>
    addNode(db, { reason: "创建", ...input } as never, "u1");
  node({ slug: "org", kind: "org", name: "组织" });
  node({
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    leader: "a1",
  });
  node({
    parent: "o2",
    slug: "runtime",
    kind: "module",
    name: "runtime",
    leader: "a2",
  });
  node({
    parent: "o2",
    slug: "质量",
    kind: "concern",
    name: "质量",
    leader: "a3",
  });
  node({
    parent: "o1",
    slug: "openquota",
    kind: "project",
    name: "OpenQuota",
    leader: "a4",
  });
  return db;
}

test("状态流转：设为规划中／进行中／受阻、达成、放弃；同状态拒绝，达成与放弃都能改回", () => {
  for (const from of GOAL_STATUSES) {
    for (const to of ["planned", "active", "blocked"] as const) {
      const verdict = transition(from, { kind: "set", to });
      assert.equal(verdict.ok, from !== to, `${from} → ${to}`);
      if (verdict.ok) assert.equal(verdict.to, to);
    }
    assert.deepEqual(
      transition(from, { kind: "done" }),
      from === "achieved"
        ? { ok: false, reason: "已经是达成" }
        : { ok: true, to: "achieved" },
    );
    assert.deepEqual(
      transition(from, { kind: "drop" }),
      from === "dropped"
        ? { ok: false, reason: "已经是放弃" }
        : { ok: true, to: "dropped" },
    );
  }
  const prerequisites = GOAL_STATUSES.map((status, id) => ({ id, status }));
  assert.deepEqual(
    unmetPrerequisites(prerequisites).map((p) => p.status),
    GOAL_STATUSES.filter((s) => s !== "achieved"),
    "只有达成算满足前置，放弃的前置也不算",
  );
});

test("权限：顶层目标只有 u1；里程碑看负责部门 leader 链；新建还要能管上级里程碑的部门", () => {
  for (const actor of ["u1", "a1", "a2", "a4", "a9"]) {
    assert.equal(leadsNode(ORG, 3, actor), ["u1", "a1", "a2"].includes(actor));
    assert.equal(
      canChange(ORG, { parent_id: null, node_id: 2 }, actor).ok,
      actor === "u1",
      `顶层目标 ${actor}`,
    );
    assert.equal(
      canChange(ORG, { parent_id: 1, node_id: 3 }, actor).ok,
      ["u1", "a1", "a2"].includes(actor),
      `里程碑 ${actor}`,
    );
    assert.equal(canCreate(ORG, null, 2, actor).ok, actor === "u1");
  }
  // 顶层目标下：各部门都能建自己的里程碑
  const top = { parent_id: null, node_id: 1 };
  assert.equal(canCreate(ORG, top, 3, "a2").ok, true);
  assert.equal(canCreate(ORG, top, 5, "a2").ok, false, "不能替别的部门建");
  // 里程碑（o2 负责）下：a2 管不到 o2，不能拆 o2 的里程碑；a1 能把子里程碑派给 o3
  const milestone = { parent_id: 1, node_id: 2 };
  assert.match(
    (canCreate(ORG, milestone, 3, "a2") as { reason: string }).reason,
    /上级里程碑负责部门 o2/,
  );
  assert.equal(canCreate(ORG, milestone, 3, "a1").ok, true);
  assert.equal(canCreate(ORG, milestone, 5, "a1").ok, false);
  // leader 链成环也不死循环
  const loop = [
    { id: 1, parent_id: 2, leader: null },
    { id: 2, parent_id: 1, leader: null },
  ];
  assert.equal(leadsNode(loop, 1, "a1"), false);
});

test("层级与前置环：深度、子树高度、是否在子树内、成环路径", () => {
  const goals = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 2 },
    { id: 4, parent_id: 1 },
  ];
  assert.deepEqual(
    [1, 2, 3, 4].map((id) => depthOf(goals, id)),
    [1, 2, 3, 2],
  );
  assert.equal(depthOf(goals, 9), Infinity);
  assert.equal(subtreeHeight(goals, 1), 3);
  assert.equal(subtreeHeight(goals, 3), 1);
  assert.equal(isWithin(goals, 3, 1), true);
  assert.equal(isWithin(goals, 1, 3), false);
  assert.equal(isWithin(goals, 2, 2), true);
  const edges = [
    { goal_id: 2, after_id: 4 },
    { goal_id: 4, after_id: 3 },
  ];
  assert.deepEqual(prerequisiteCycle(edges, 3, [2]), [3, 2, 4, 3]);
  assert.equal(prerequisiteCycle(edges, 3, [4]) !== null, true);
  assert.equal(prerequisiteCycle(edges, 1, [2, 4]), null);
  assert.equal(
    prerequisiteCycle([{ goal_id: 3, after_id: 2 }], 3, [4]),
    null,
    "id 自己的旧边不算",
  );
});

test("父任务迁移判定：只有归类用的父任务能迁；状态按父任务与子任务推", () => {
  const base = { status: "todo", worker: null, pr_url: null, children: 2 };
  assert.equal(adoptBlocker(base), null);
  assert.match(adoptBlocker({ ...base, children: 0 })!, /没有子任务/);
  assert.match(adoptBlocker({ ...base, status: "running" })!, /正在执行/);
  assert.match(adoptBlocker({ ...base, worker: "codex" })!, /派过执行者/);
  assert.match(adoptBlocker({ ...base, pr_url: "https://x" })!, /PR/);
  const cases: [string, string[], GoalStatus][] = [
    ["done", ["todo"], "achieved"],
    ["cancelled", ["done"], "dropped"],
    ["blocked", ["todo"], "blocked"],
    ["todo", ["todo", "todo"], "planned"],
    ["todo", ["todo", "done"], "active"],
    ["failed", ["running"], "active"],
  ];
  for (const [status, children, expected] of cases)
    assert.equal(adoptedStatus(status, children), expected, status);
});

test("多层目标树：顶层只有 u1 能建改，里程碑按部门 leader；负责部门缺省沿用上层", () => {
  const db = setup();
  const top = addGoal(db, { result: "Atrium 成为 AI 组织的运行底座" }, "u1");
  assert.equal(top.ref, "g1");
  assert.equal(top.node_ref, "o1", "顶层缺省记在组织根上");
  assert.equal(top.status, "planned");
  assert.throws(
    () => addGoal(db, { result: "另一个顶层" }, "a1"),
    /顶层目标只有你（u1）能建/,
  );
  assert.throws(
    () => editGoal(db, "g1", { result: "改顶层" }, "a1"),
    /顶层目标只有你（u1）能改/,
  );
  const m3 = addGoal(
    db,
    {
      result: "组织树可用",
      parent: "g1",
      node: "atrium",
      criteria: ["atrium org tree 列出全部节点", "  "],
      status: "active",
    },
    "a1",
  );
  assert.equal(m3.node_ref, "o2");
  assert.deepEqual(m3.criteria, ["atrium org tree 列出全部节点"]);
  const m31 = addGoal(
    db,
    { result: "用量估算与派活拦截", parent: "g2", node: "atrium/runtime" },
    "a1",
  );
  const m311 = addGoal(db, { result: "估算模型", parent: m31.ref }, "a2");
  assert.equal(m311.node_ref, "o3", "负责部门缺省同上层");
  assert.throws(
    () => addGoal(db, { result: "拆别人的", parent: "g2", node: "o3" }, "a2"),
    /上级里程碑负责部门 o2/,
  );
  assert.throws(
    () =>
      addGoal(db, { result: "越权", parent: "g1", node: "openquota" }, "a1"),
    /a1 不是负责部门 o5/,
  );
  assert.throws(
    () => editGoal(db, m311.ref, { result: "外人改" }, "a3"),
    /a3 不是负责部门 o3/,
  );
  // 上级 leader 能改下层；改负责部门要新旧部门都管得到
  assert.equal(
    editGoal(db, m311.ref, { result: "估算模型 v1" }, "a1").result,
    "估算模型 v1",
  );
  assert.throws(
    () => editGoal(db, m311.ref, { node: "openquota" }, "a1"),
    /a1 不是负责部门 o5/,
  );
  const tree = goalTree(db);
  assert.deepEqual(renderGoalTree(tree.goals), [
    "g1 [规划中] Atrium 成为 AI 组织的运行底座 · o1 组织",
    "  g2 [进行中] 组织树可用 · o2 Atrium",
    "    g3 [规划中] 用量估算与派活拦截 · o3 runtime",
    "      g4 [规划中] 估算模型 v1 · o3 runtime",
  ]);
  assert.deepEqual(renderGoalTree(tree.goals, 2).slice(2), [
    "    …下层 1 个：atrium goal tree g2",
  ]);
  assert.equal(goalTree(db, "g3").goals[0]!.ref, "g3");
  const shown = goalShow(db, "g4");
  assert.deepEqual(
    shown.path.map((p) => p.ref),
    ["g1", "g2", "g3"],
  );
  assert.equal(shown.updated_by, "a1");
  db.close();
});

test("挪层级：不能挪到自己下层、不能把顶层挂到别处；深度有上限", () => {
  const db = setup();
  addGoal(db, { result: "顶层" }, "u1");
  addGoal(db, { result: "A", parent: "g1", node: "atrium" }, "u1");
  addGoal(db, { result: "B", parent: "g2" }, "u1");
  assert.throws(
    () => editGoal(db, "g2", { parent: "g3" }, "u1"),
    /g3 是 g2 自己或它的下层/,
  );
  assert.throws(
    () => editGoal(db, "g1", { parent: "g2" }, "u1"),
    /顶层目标不能挂到别的目标下/,
  );
  const moved = editGoal(db, "g3", { parent: "g1" }, "u1");
  assert.equal(moved.parent_ref, "g1");
  assert.deepEqual(moved.changed, ["parent"]);
  let parent = "g3";
  for (let i = 0; i < 10; i++)
    parent = addGoal(db, { result: `层 ${i}`, parent }, "u1").ref;
  assert.throws(
    () => addGoal(db, { result: "太深", parent }, "u1"),
    /目标树最多 12 层/,
  );
  db.close();
});

test("前置里程碑：整组替换、不成环；前置没达成不能标达成", () => {
  const db = setup();
  addGoal(db, { result: "顶层" }, "u1");
  addGoal(db, { result: "M1", parent: "g1", node: "atrium" }, "u1");
  addGoal(db, { result: "M2", parent: "g1", node: "atrium" }, "u1");
  const m3 = addGoal(
    db,
    { result: "M3", parent: "g1", node: "atrium", after: "g2,g3" },
    "a1",
  );
  assert.deepEqual(m3.waiting_for, ["g2", "g3"]);
  assert.throws(
    () => editGoal(db, "g2", { after: "g4" }, "u1"),
    /前置成环：g2 → g4 → g2/,
  );
  assert.throws(
    () => editGoal(db, "g4", { after: "g4" }, "u1"),
    /不能把自己设为前置/,
  );
  assert.throws(
    () => editGoal(db, "g4", { after: "g2,g2" }, "u1"),
    /前置里程碑不能重复/,
  );
  assert.throws(
    () => editGoal(db, "g4", { after: "g99" }, "u1"),
    /--after: 目标 g99 不存在/,
  );
  assert.throws(
    () => settleGoal(db, "g4", { kind: "done" }, {}, "a1"),
    /g4 的前置还没达成：g2（规划中）、g3（规划中）/,
  );
  settleGoal(db, "g2", { kind: "done" }, { note: "#304 已合入" }, "a1");
  settleGoal(db, "g3", { kind: "drop" }, { note: "并入 M1" }, "a1");
  assert.throws(
    () => settleGoal(db, "g4", { kind: "done" }, {}, "a1"),
    /g3（放弃）/,
    "放弃的前置不算满足",
  );
  assert.deepEqual(editGoal(db, "g4", { after: "g2" }, "a1").waiting_for, []);
  const done = settleGoal(db, "g4", { kind: "done" }, {}, "a1");
  assert.equal(done.status, "achieved");
  assert.equal(goalShow(db, "g2").needed_by.join(), "g4");
  assert.deepEqual(
    editGoal(db, "g4", { after: "" }, "a1").after,
    [],
    "空串清空前置",
  );
  db.close();
});

test("达成、放弃、改回：放弃要原因，下层与挂着的任务先收尾；状态改动清掉旧说明", () => {
  const db = setup();
  addGoal(db, { result: "顶层" }, "u1");
  addGoal(db, { result: "M", parent: "g1", node: "atrium" }, "u1");
  addGoal(db, { result: "M.1", parent: "g2" }, "u1");
  const task = createTask(db, { title: "干活", goal: "g3" });
  assert.throws(
    () => settleGoal(db, "g3", { kind: "drop" }, {}, "a1"),
    /--reason: 放弃要写原因/,
  );
  assert.throws(
    () => settleGoal(db, "g2", { kind: "drop" }, { note: "不做了" }, "a1"),
    /g2 下还有没收尾的里程碑：g3/,
  );
  assert.throws(
    () => settleGoal(db, "g3", { kind: "drop" }, { note: "不做了" }, "a1"),
    new RegExp(`挂着没结的任务：${task.ref}`),
  );
  updateTask(db, task.ref, { status: "cancelled" });
  const dropped = settleGoal(
    db,
    "g3",
    { kind: "drop" },
    { note: "不做了" },
    "a1",
  );
  assert.equal(dropped.status, "dropped");
  assert.equal(dropped.note, "不做了");
  assert.throws(
    () => settleGoal(db, "g3", { kind: "drop" }, { note: "再放弃" }, "a1"),
    /g3 已经是放弃/,
  );
  assert.throws(
    () => addGoal(db, { result: "往放弃的下面拆", parent: "g3" }, "a1"),
    /g3 已放弃，先改回再往下拆/,
  );
  assert.throws(
    () => createTask(db, { title: "挂到放弃的", goal: "g3" }),
    /goal: g3 已放弃/,
  );
  const back = editGoal(db, "g3", { status: "active" }, "a1");
  assert.equal(back.status, "active");
  assert.equal(back.note, null, "改回时清掉放弃原因");
  assert.throws(
    () => editGoal(db, "g3", { status: "achieved" }, "a1"),
    /达成用 goal done/,
  );
  assert.throws(
    () => editGoal(db, "g3", { status: "active" }, "a1"),
    /g3 已经是进行中/,
  );
  const blocked = editGoal(
    db,
    "g3",
    { status: "blocked", note: "等 OpenQuota 修复" },
    "a1",
  );
  assert.equal(
    goalLine(blocked),
    "g3 [受阻] M.1 · o2 Atrium · 等 OpenQuota 修复",
  );
  assert.throws(
    () => settleGoal(db, "g1", { kind: "done" }, {}, "a1"),
    /顶层目标只有你/,
  );
  assert.equal(
    settleGoal(db, "g1", { kind: "done" }, {}, "u1").status,
    "achieved",
  );
  db.close();
});

test("破坏输入：按参数名中文报错，数据不变", () => {
  const db = setup();
  addGoal(db, { result: "顶层" }, "u1");
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ result: "" }, /结果: 不能为空/],
    [{ result: "长".repeat(201) }, /不能超过 200 字/],
    [{ result: 42 }, /结果: 不能为空/],
    [{ result: "x", parent: "t1" }, /--parent: 目标短号应为 g1/],
    [{ result: "x", parent: "g1; DROP TABLE goals" }, /--parent: 目标短号/],
    [{ result: "x", parent: "g99" }, /--parent: 目标 g99 不存在/],
    [{ result: "x", parent: "g1", node: "o99" }, /--node: 节点 o99 不存在/],
    [{ result: "x", parent: "g1", node: "../etc" }, /--node: /],
    [{ result: "x", parent: "g1", due: "2026-02-30" }, /--due: 目标日期/],
    [{ result: "x", parent: "g1", due: "明天" }, /--due: 目标日期/],
    [
      { result: "x", parent: "g1", status: "achieved" },
      /--status: 新建时只能是/,
    ],
    [
      { result: "x", parent: "g1", criteria: [1] },
      /--criteria: 每条验收标准应为文本/,
    ],
    [{ result: "x", parent: "g1", criteria: ["a", "a"] }, /不能重复/],
    [
      {
        result: "x",
        parent: "g1",
        criteria: Array.from({ length: 21 }, (_, i) => `${i}`),
      },
      /最多 20 条/,
    ],
    [{ result: "x", parent: "g1", after: "g1,x" }, /--after: 目标短号/],
    [{ result: "x", parent: "g1", owner: "a1" }, /不认识的字段：owner/],
  ];
  for (const [input, message] of bad)
    assert.throws(
      () => addGoal(db, input, "u1"),
      message,
      JSON.stringify(input),
    );
  assert.throws(() => addGoal(db, "字符串", "u1"), /请求体应为 JSON 对象/);
  assert.throws(() => editGoal(db, "g1", {}, "u1"), /至少改一项/);
  assert.throws(
    () => editGoal(db, "1", { result: "x" }, "u1"),
    /目标: 目标短号/,
  );
  assert.throws(
    () => editGoal(db, "g9", { result: "x" }, "u1"),
    /目标 g9 不存在/,
  );
  assert.throws(() => goalShow(db, "g0"), /目标短号应为 g1/);
  assert.throws(
    () => createTask(db, { title: "x", goal: "g9" }),
    /goal: 目标 g9 不存在/,
  );
  assert.throws(
    () => updateTask(db, "t1", { goal: "o1" }),
    /任务 t1 不存在|goal: 目标短号/,
  );
  assert.equal(goalTree(db).goals.length, 1);
  assert.equal(goalTree(db).goals[0]!.children.length, 0, "失败的写入没有落库");
  // 坏记录不挡读取
  db.prepare("UPDATE goals SET criteria='{坏' WHERE id=1").run();
  const shown = goalShow(db, "g1");
  assert.deepEqual(shown.criteria, []);
  assert.equal(shown.criteria_broken, true);
  // 只增不删：短号不复用
  assert.throws(
    () => db.prepare("DELETE FROM goals WHERE id=1").run(),
    /drop only/,
  );
  db.close();
});

test("task add/set --goal：挂上、换挂、摘下；目标树按里程碑数任务", () => {
  const db = setup();
  addGoal(db, { result: "顶层" }, "u1");
  addGoal(db, { result: "M", parent: "g1", node: "atrium" }, "u1");
  const a = createTask(db, { title: "a", goal: "g2" });
  assert.equal(a.goal_ref, "g2");
  const b = createTask(db, { title: "b", goal: "g2" });
  advanceTask(db, b.ref, { kind: "start" }, { worker: "codex" });
  createTask(db, { title: "c" });
  assert.equal(updateTask(db, "t3", { goal: "g1" }).goal_ref, "g1");
  const node = goalTree(db).goals[0]!.children[0]!;
  assert.deepEqual(
    { todo: node.tasks.todo, running: node.tasks.running },
    { todo: 1, running: 1 },
  );
  assert.equal(
    goalLine(node),
    "g2 [规划中] M · o2 Atrium · 任务 在跑 1 未结 2/2",
  );
  const shown = goalShow(db, "g2");
  assert.deepEqual(
    shown.tasks.map((t) => t.ref),
    ["t2", "t1"],
  );
  assert.equal(updateTask(db, a.ref, { goal: "" }).goal_ref, null);
  assert.match(
    JSON.stringify(getTask(db, a.ref).events.at(-1)),
    /goal_id/,
    "改挂记事件",
  );
  db.close();
});

test("父任务迁为里程碑：默认预览不写；apply 后子任务挂上并上移、父任务取消；干过活的不能迁", () => {
  const db = setup();
  addGoal(db, { result: "顶层" }, "u1");
  addGoal(
    db,
    { result: "M4 秘书不绑定工具", parent: "g1", node: "atrium" },
    "u1",
  );
  const grand = createTask(db, { title: "总" });
  const parent = createTask(db, {
    title: "秘书唤醒通道",
    parent: grand.ref,
    role: "atrium/runtime",
  });
  const c1 = createTask(db, { title: "第 1 步", parent: parent.ref });
  const c2 = createTask(db, {
    title: "第 2 步",
    parent: parent.ref,
    goal: "g1",
  });
  updateTask(db, c1.ref, { status: "done" });
  const preview = adoptTask(db, { task: parent.ref, parent: "g2" }, "a1");
  assert.deepEqual(preview, {
    preview: true,
    task: "t2",
    goal: {
      ref: null,
      result: "秘书唤醒通道",
      parent: "g2",
      node: "o3",
      status: "active",
      status_label: "进行中",
    },
    attach: ["t3"],
    keep: [{ task: "t4", goal: "g1" }],
    parent_task: "cancel",
  });
  assert.equal(
    goalTree(db).goals[0]!.children[0]!.children.length,
    0,
    "预览不写",
  );
  assert.throws(
    () => adoptTask(db, { task: parent.ref, parent: "g2", apply: true }, "a4"),
    /a4 不是负责部门 o3/,
  );
  const applied = adoptTask(
    db,
    { task: parent.ref, parent: "g2", apply: true },
    "a1",
  );
  assert.equal(applied.goal.ref, "g3");
  const shown = goalShow(db, "g3");
  assert.equal(shown.note, "由父任务 t2 迁来");
  assert.deepEqual(shown.tasks.map((t) => t.ref).sort(), ["t2", "t3"]);
  assert.equal(
    getTask(db, c1.ref).parent_ref,
    "t1",
    "子任务上移到父任务的上一层",
  );
  assert.equal(getTask(db, c2.ref).goal_ref, "g1", "已挂别处的保持");
  assert.equal(getTask(db, parent.ref).status, "cancelled");
  assert.ok(getTask(db, c1.ref).events.some((e) => e.kind === "goal_adopt"));
  assert.throws(
    () => adoptTask(db, { task: parent.ref, parent: "g2" }, "a1"),
    /t2 不能迁为里程碑：没有子任务/,
  );
  const worked = createTask(db, { title: "干过活" });
  createTask(db, { title: "子", parent: worked.ref });
  advanceTask(db, worked.ref, { kind: "start" }, { worker: "codex" });
  assert.throws(
    () => adoptTask(db, { task: worked.ref, parent: "g2" }, "u1"),
    /正在执行/,
  );
  assert.throws(
    () => adoptTask(db, { task: worked.ref }, "u1"),
    /--parent: 要指定/,
  );
  assert.throws(
    () => adoptTask(db, { task: "g1", parent: "g2" }, "u1"),
    /task: 任务短号/,
  );
  db.close();
});

test("接口：?as= 决定操作者，非 leader 的 aN 被拒；任务接口带 goal_ref", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-goals-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { app, db } = await createApp({ data, auth: false });
  t.after(() => app.close());
  addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建" } as never,
    "u1",
  );
  addNode(
    db,
    {
      parent: "o1",
      slug: "atrium",
      kind: "project",
      name: "Atrium",
      leader: "a1",
      reason: "建",
    } as never,
    "u1",
  );
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({ method, url, payload });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, unknown>,
    };
  };
  assert.equal(
    (await call("POST", "/api/goals", { result: "顶层" })).status,
    201,
  );
  const denied = await call("POST", "/api/goals?as=a1", { result: "顶层 2" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "conflict");
  assert.equal(
    (await call("POST", "/api/goals?as=a7", { result: "x", parent: "g1" }))
      .status,
    404,
    "a7 不是任何节点的 leader",
  );
  const milestone = await call("POST", "/api/goals?as=a1", {
    result: "M",
    parent: "g1",
    node: "atrium",
  });
  assert.equal(milestone.body.ref, "g2");
  const task = await call("POST", "/api/tasks", { title: "t", goal: "g2" });
  assert.equal(task.body.goal_ref, "g2");
  assert.equal(
    (await call("POST", "/api/goals/g2/done?as=a1")).body.status,
    "achieved",
  );
  const tree = await call("GET", "/api/goals/tree");
  assert.equal(
    (tree.body.goals as { children: { status: string }[] }[])[0]!.children[0]!
      .status,
    "achieved",
  );
  assert.equal((await call("GET", "/api/goals/g9")).status, 404);
  assert.equal(
    (await call("PATCH", "/api/goals/g1?as=a1", { result: "改" })).status,
    403,
  );
});
