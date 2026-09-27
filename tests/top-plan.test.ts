import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";
import { ensureUpstreamPrTable } from "../server/tasks/schedule-upstream.ts";
import { taskPlan } from "../server/tasks/schedule.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import {
  renderPlan,
  upstreamText,
  waitText,
  type PlanEntry,
  type PlanView,
} from "../cli/top-plan.ts";
import { renderTop, snapshotOf, type Snapshot } from "../cli/top.ts";
import { mapDepth } from "../cli/top.ts";
import { renderTopMap } from "../cli/map.ts";
import type { MapTreeNode } from "../server/map/view.ts";
import type { Client } from "../cli/service.ts";
import { width } from "../cli/format.ts";

/** atrium top 的排期段（#262）：就绪、依赖链、等待中、因上游卡住，以及折叠与窄屏。 */

const NOW = Date.UTC(2026, 8, 27, 10);

const task = (
  ref: string,
  title: string,
  over: Partial<PlanEntry["task"]> = {},
): PlanEntry["task"] => ({
  ref,
  title,
  status: "todo",
  worker: null,
  started_at: null,
  parent_ref: null,
  owner: null,
  auto: 0,
  node_ref: null,
  ...over,
});
const entry = (
  ref: string,
  title: string,
  over: Omit<Partial<PlanEntry>, "task"> & {
    task?: Partial<PlanEntry["task"]>;
  } = {},
): PlanEntry => ({
  waiting_for: [],
  reason: null,
  node_path: null,
  open_children: 0,
  upstream: [],
  after_pr: [],
  ...over,
  task: task(ref, title, over.task),
});
const up = (
  ref: string,
  status: string,
  over: Partial<NonNullable<PlanEntry["upstream"]>[number]> = {},
) => ({ ref, status, worker: null, started_at: null, pr: null, ...over });

/** A→B→C 链（A 在跑）、一个带外部 PR 条件的等待、一个就绪、一个分组父任务、一个因上游失败卡住的。 */
function sample(): PlanView {
  return {
    next_after: null,
    groups: {
      running: [
        entry("t32", "实现排期接口", {
          node_path: "atrium/runtime",
          task: {
            status: "running",
            worker: "codex+gpt-6-sol",
            started_at: NOW - 12 * 60_000,
          },
        }),
      ],
      ready: [
        entry("t35", "修 README 里失效的链接", {
          node_path: "atrium/cli",
          task: { auto: 1, owner: "secretary" },
        }),
        entry("t40", "发布 v0.2", { open_children: 1 }),
      ],
      waiting: [
        entry("t33", "top 加排期视图", {
          node_path: "atrium/cli",
          upstream: [
            up("t32", "running", {
              worker: "codex+gpt-6-sol",
              started_at: NOW - 12 * 60_000,
            }),
          ],
        }),
        entry("t34", "状态栏改读新字段", {
          upstream: [
            up("t33", "todo"),
            up("t30", "done", {
              pr: { number: 305, state: "merged", error: null },
            }),
          ],
        }),
        entry("t42", "发版", {
          task: { parent_ref: "t40" },
          upstream: [
            up("t31", "done", {
              pr: { number: 310, state: "open", error: null },
            }),
          ],
          after_pr: [
            { repo: "OpenQuota/core", number: 6, merged: false, error: null },
          ],
        }),
      ],
      blocked: [
        entry("t36", "接 kimi 适配器", {
          reason: "上游 t29 [failed]",
          task: { status: "blocked", schedule_state: "blocked" },
          upstream: [up("t29", "failed")],
        }),
        // 执行失败的不是排期卡住，上面的看板已经列了，这里不重复。
        entry("t37", "自己跑失败的", {
          reason: "任务失败",
          task: { status: "failed" },
        }),
      ],
    },
  };
}

const draw = (plan: PlanView, width_: number, maxLines = 40) =>
  renderPlan(plan, {
    width: width_,
    now: NOW,
    maxLines,
    wide: width_ >= 80,
  });

test("排期段：就绪带节点、自动派与负责人；等待逐项带状态；卡住写原因", () => {
  const { lines, counts } = draw(sample(), 120);
  const text = lines.join("\n");
  assert.deepEqual(counts, { ready: 1, waiting: 3, blocked: 1 });
  assert.equal(lines[0], "排期 · 就绪 1 · 等待中 3 · 卡住 1");
  assert.match(
    text,
    /○ t35\s+修 README 里失效的链接\s+atrium\/cli · 自动派 · secretary/,
  );
  // 上游在跑：带执行者与已跑时长。
  assert.match(
    text,
    /◇ t33\s+top 加排期视图\s+等 t32 在跑（codex\+gpt-6-sol · 12m）/,
  );
  // 上游已合入的算满足，宽屏补一句。
  assert.match(text, /◇ t34\s+状态栏改读新字段\s+等 t33 待办；已满足 t30/);
  // 与 t50 衔接：交付 PR 的上游要等 PR 合入；外部 PR 条件同样逐项列出。
  assert.match(text, /等 t31 的 PR #310 合入、OpenQuota\/core#6 合入/);
  assert.match(text, /✕ t36\s+接 kimi 适配器\s+卡住：上游 t29 失败/);
  assert.doesNotMatch(text, /t37/);
});

test("排期段：就绪的按紧急 → 普通 → 闲时排，标题前标紧急或闲时（t136）", () => {
  const plan: PlanView = {
    next_after: null,
    groups: {
      running: [],
      ready: [
        entry("t1", "性能巡检", { task: { priority: "idle" } }),
        entry("t2", "功能 A", { task: { priority: "normal" } }),
        entry("t3", "性能急事", { task: { priority: "idle", urgent: 1 } }),
        entry("t4", "旧服务的任务"),
      ],
      waiting: [],
      blocked: [],
    },
  };
  const rows = draw(plan, 120)
    .lines.slice(2)
    .map((line) => line.trim());
  assert.deepEqual(
    rows.map((line) => line.split(/\s+/).slice(0, 3).join(" ")),
    ["○ t3 紧急", "○ t2 功能", "○ t4 旧服务的任务", "○ t1 闲时"],
  );
  assert.match(rows[3]!, /闲时 性能巡检/);
});

test("排期段：依赖链按先后缩进，标题给出关键路径；分组父任务只当标题", () => {
  const lines = draw(sample(), 120).lines;
  const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
  const chain = at(/^ 依赖链 t32 → t33 → t34$/);
  assert.ok(chain > 0, lines.join("\n"));
  const indent = (index: number) => /^ */.exec(lines[index]!)![0].length;
  assert.match(lines[chain + 1]!, /^ {2}● t32/);
  assert.match(lines[chain + 2]!, /^ {4}◇ t33/);
  assert.match(lines[chain + 3]!, /^ {6}◇ t34/);
  assert.ok(indent(chain + 1) < indent(chain + 2));
  // 在跑的上游只在链里出现，不单列成待办。
  assert.equal(lines.filter((line) => /t32 {2}/.test(line)).length, 1);
  // 父任务 t40 是分组标题，不计入就绪、不带就绪符号。
  const group = at(/▸ t40 发布 v0\.2/);
  assert.ok(group > 0);
  assert.match(lines[group + 1]!, /^ {4}◇ t42/);
  assert.ok(!lines.some((line) => /○ t40/.test(line)));
  // 分叉的链：两个下游挂在同一上游下，另一分支在标题里注明。
  const fork = sample();
  fork.groups.waiting.push(
    entry("t38", "另一个下游", { upstream: [up("t33", "todo")] }),
  );
  const forked = draw(fork, 120).lines;
  assert.ok(forked.includes(" 依赖链 t32 → t33 → t34（另有 1 项）"));
  assert.ok(forked.some((line) => /^ {6}◇ t38/.test(line)));
  // 上游自己跑失败：链里照实写失败，只把因它卡住的下游计入卡住。
  const failed = sample();
  failed.groups.blocked.push(
    entry("t29", "前置调研", {
      reason: "任务失败",
      task: { status: "failed" },
    }),
  );
  const broken = draw(failed, 120);
  assert.equal(broken.counts.blocked, 1);
  assert.ok(broken.lines.includes(" 依赖链 t29 → t36"));
  assert.ok(broken.lines.some((line) => /✕ t29\s+前置调研\s+失败$/.test(line)));
});

test("排期段：窄屏去掉节点与执行者，每行都不超宽", () => {
  for (const cols of [100, 60, 40, 24]) {
    const { lines } = draw(sample(), cols);
    for (const line of lines)
      assert.ok(width(line) <= cols, `${cols} 列超宽：${line}`);
  }
  const narrow = draw(sample(), 60).lines.join("\n");
  assert.match(narrow, /○ t35 .* 自动 · secretary/);
  assert.doesNotMatch(narrow, /atrium\/cli/);
  assert.match(narrow, /等 t32 在跑 12m/);
  assert.doesNotMatch(narrow, /codex/);
  assert.doesNotMatch(narrow, /已满足/);
});

test("排期任务行标出所属里程碑，窄屏仍可见", () => {
  const plan = sample();
  plan.groups.ready[0]!.task.goal_ref = "g12";
  for (const cols of [100, 60]) {
    const lines = draw(plan, cols).lines;
    const line = lines.find((line) => line.includes("t35"))!;
    assert.match(line, /g12/);
    assert.ok(width(line) <= cols);
  }
});

const part = (
  ref: string,
  name: string,
  children: MapTreeNode[] = [],
  tasks = { running: 0, blocked: 0, open: 0 },
): MapTreeNode => ({
  ref,
  name,
  alias: "",
  analogy: "",
  kind: "module",
  what: `${name}是什么`,
  archived: false,
  dot: tasks.running ? "running" : tasks.blocked ? "blocked" : "idle",
  tasks,
  children,
  children_count: children.length,
});

test("全景段：默认根下两层、可展开、折叠与窄屏", () => {
  const tree = part("o1", "组织", [
    part("o2", "Atrium", [part("o3", "命令行", [part("o5", "看板")])], {
      running: 1,
      blocked: 1,
      open: 3,
    }),
    { ...part("o4", "旧模块"), archived: true },
  ]);
  const shallow = renderTopMap(tree, 100).join("\n");
  assert.match(
    shallow,
    /^全景\n {2}● o2 Atrium · 在跑 1 · 卡住 1 · 待办 1 · Atrium是什么/,
  );
  assert.match(shallow, /o3 命令行/);
  assert.doesNotMatch(shallow, /o5|o4/, "只展开两层，归档的不列");
  assert.match(renderTopMap(tree, 100, 3).join("\n"), /o5 看板/);
  assert.match(renderTopMap(tree, 100, 3, 3).at(-1)!, /还有 .* 行：atrium map/);
  for (const line of renderTopMap(tree, 40, 3)) assert.ok(width(line) <= 40);
  assert.match(renderTopMap(null, 80).join("\n"), /还没有组织树/);
  assert.equal(mapDepth(undefined), 2);
  assert.equal(mapDepth("3"), 3);
  for (const invalid of ["0", "9", "abc", "2.5"])
    assert.throws(() => mapDepth(invalid, "--goals-depth"), /--goals-depth/);
});

test("排期段：超出行数折叠，提示 atrium task plan；不止一页也提示", () => {
  const { lines } = draw(sample(), 100, 5);
  assert.equal(lines.length, 5);
  assert.match(lines[4]!, /^ {2}…还有 \d+ 条，完整排期：atrium task plan$/);
  const hidden = Number(/还有 (\d+) 条/.exec(lines[4]!)![1]);
  // 前 4 行是标题、就绪小标题、t35 与依赖链标题；六条待办里只露出 t35。
  assert.equal(hidden, 5);
  const paged = { ...sample(), next_after: "t200" };
  const full = draw(paged, 100).lines;
  assert.match(full[0]!, /不止一页/);
  assert.match(full.at(-1)!, /排期不止一页，完整排期：atrium task plan/);
  const empty = draw(
    {
      next_after: null,
      groups: { running: [], ready: [], waiting: [], blocked: [] },
    },
    80,
  ).lines;
  assert.deepEqual(empty, [
    "排期 · 就绪 0 · 等待中 0 · 卡住 0",
    "  没有就绪、等待中或卡住的待办",
  ]);
});

test("排期段：条件说明逐项覆盖；旧版服务没有细节字段时退回原文", () => {
  assert.equal(upstreamText(up("t1", "blocked"), NOW, true), "t1 卡住");
  assert.equal(upstreamText(up("t1", "done", { pr: null }), NOW, true), null);
  for (const [state, error, want] of [
    ["open", null, "t1 的 PR #9 合入"],
    [null, null, "t1 的 PR #9 合入（尚未查询）"],
    ["open", "gh 超时", "t1 的 PR #9 合入（查询失败）"],
    ["closed", null, "t1 的 PR #9 已关闭未合入"],
    ["merged", null, null],
  ] as const)
    assert.equal(
      upstreamText(
        up("t1", "done", { pr: { number: 9, state, error } }),
        NOW,
        true,
      ),
      want,
    );
  // 合入服务自身仓库的上游（t130）：上线才算满足。
  const merged = { number: 9, state: "merged", error: null };
  for (const [release, want] of [
    ["waiting", "t1 上线"],
    ["failed", "t1 上线失败"],
    ["online", null],
    ["merging", "t1 的 PR #9 合入"],
    [null, null],
  ] as const)
    assert.equal(
      upstreamText(up("t1", "done", { pr: merged, release }), NOW, true),
      want,
    );
  assert.equal(
    waitText(
      {
        task: task("t2", "用新命令"),
        waiting_for: ["t1 上线"],
        reason: null,
        upstream: [up("t1", "done", { pr: merged, release: "waiting" })],
      },
      NOW,
      false,
    ),
    "等 t1 上线",
  );
  const legacy = {
    task: task("t5", "旧服务"),
    waiting_for: ["t4 [running]", "o/r#1 未合入"],
    reason: null,
  };
  assert.equal(waitText(legacy, NOW, true), "等 t4 在跑、o/r#1 未合入");
  // 旧服务没有 open_children：用别的待办的 parent_ref 认出分组父任务，链从 waiting_for 认上游。
  const lines = draw(
    {
      next_after: null,
      groups: {
        running: [],
        ready: [
          { task: task("t3", "父任务"), waiting_for: [], reason: null },
          {
            task: task("t4", "子任务", { parent_ref: "t3" }),
            waiting_for: [],
            reason: null,
          },
        ],
        waiting: [legacy],
        blocked: [],
      },
    },
    100,
  ).lines;
  assert.ok(lines.includes(" 依赖链 t4 → t5"), lines.join("\n"));
  assert.ok(lines.some((line) => /▸ t3 父任务/.test(line)));
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  recent_ms: 600_000,
  subscriber: "u1",
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

test("top 屏：排期段接在看板下面；取不到排期不影响看板；实时模式按终端高度折叠", async () => {
  const frame = { width: 100, now: NOW, footer: false, color: false };
  const text = renderTop(snapshot({ plan: sample() }), frame);
  assert.match(text, /现在没有在跑、排队或受阻的任务\n\n排期 · 就绪 1/);
  assert.match(
    renderTop(snapshot({ plan: null, plan_error: "服务正在重启" }), frame),
    /\n\n排期：取不到（服务正在重启）$/,
  );
  // 终端 12 行：看板 2 行 + 空行 + 动作 1 行，排期段只剩 8 行。
  const short = renderTop(snapshot({ plan: sample() }), {
    ...frame,
    footer: true,
    height: 12,
  }).split("\n");
  assert.equal(short.length, 12);
  assert.match(short.at(-2)!, /完整排期：atrium task plan/);
  // 取数：两个接口一起取；排期接口出错或格式不对都只在屏上说明。
  const calls: string[] = [];
  const ok = {
    get: async (path: string) => {
      calls.push(path);
      return path === "/tasks/plan" ? sample() : snapshot();
    },
  } as unknown as Client;
  const got = await snapshotOf(ok, undefined);
  assert.deepEqual(calls.sort(), [
    "/map/tree?depth=2",
    "/tasks/plan",
    "/tasks/top",
  ]);
  assert.equal(got.plan?.groups.ready.length, 2);
  const failing = {
    get: async (path: string) => {
      if (path === "/tasks/plan") throw new Error("404 不认识的路径");
      return snapshot();
    },
  } as unknown as Client;
  assert.deepEqual(
    [
      (await snapshotOf(failing, "u1")).plan,
      (await snapshotOf(failing, "u1")).plan_error,
    ],
    [null, "404 不认识的路径"],
  );
  const odd = { get: async () => snapshot() } as unknown as Client;
  assert.equal((await snapshotOf(odd, undefined)).plan, null);
});

test("排期接口：记账节点路径、未结束子任务数与逐项上游细节", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureUpstreamPrTable(db);
  ensureOrgTables(db);
  const node = db.prepare(
    "INSERT INTO org_nodes(parent_id,kind,slug,name,created_at,updated_at) VALUES (?,?,?,?,0,0)",
  );
  node.run(null, "org", "org", "组织");
  node.run(1, "project", "atrium", "Atrium");
  node.run(2, "module", "runtime", "运行时");
  createTask(db, { title: "A", deliver: "none" }); // t1
  createTask(db, { title: "B", after: "t1" }); // t2
  createTask(db, { title: "C", after: "t2", after_pr: "OpenQuota/core#6" }); // t3
  createTask(db, { title: "分组" }); // t4
  createTask(db, { title: "子", parent: "t4" }); // t5
  db.prepare(
    "UPDATE tasks SET status='running',worker='codex+gpt-6-sol',started_at=?,node_id=3 WHERE id=1",
  ).run(NOW - 60_000);
  const plan = taskPlan(db);
  const find = (ref: string) =>
    Object.values(plan.groups)
      .flat()
      .find((item) => item.task.ref === ref)!;
  assert.equal(find("t1").node_path, "atrium/runtime");
  assert.equal(find("t2").node_path, null);
  assert.deepEqual(find("t2").upstream, [
    {
      ref: "t1",
      title: "A",
      status: "running",
      worker: "codex+gpt-6-sol",
      started_at: NOW - 60_000,
      pr: null,
      release: null,
    },
  ]);
  assert.deepEqual(find("t3").after_pr, [
    { repo: "OpenQuota/core", number: 6, merged: false, error: null },
  ]);
  assert.equal(find("t4").open_children, 1);
  assert.equal(find("t5").open_children, 0);
  // 上游 done 且交付 PR：带 PR 号与缓存的合入状态。
  db.prepare(
    "UPDATE tasks SET status='done',deliver='pr',pr_url='https://github.com/o/r/pull/12' WHERE id=1",
  ).run();
  db.prepare(
    "INSERT INTO task_pr_merge(task_id,pr_url,state,checked_at) VALUES (1,'https://github.com/o/r/pull/12','open',0)",
  ).run();
  const later = taskPlan(db).groups.waiting.find(
    (item) => item.task.ref === "t2",
  )!;
  assert.deepEqual(later.upstream[0]!.pr, {
    number: 12,
    state: "open",
    error: null,
  });
  db.close();
});
