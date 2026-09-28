import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import {
  itemBrief,
  orderedItems,
  parsePlan,
  partVerdict,
  pickSpecialists,
  PLAN_FILE,
  PLAN_TASKS_MAX,
  planBrief,
  topoOrder,
  validatePlan,
  type Plan,
} from "../server/plans/model.ts";
import { autoPlanEnabled } from "../server/plans/runtime.ts";
import { renderPlan } from "../cli/plans.ts";
import { eventLine } from "../server/leaders/wake.ts";
import { fixture, until } from "./task-fixture.ts";

/** 规划任务（t275）：清单校验与排序、详述模板、归属部分；派规划 → 待采纳 → 采纳建子任务 / 驳回 / 没出清单。 */

const item = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `做 ${key}`,
  brief: `${key} 的要点`,
  ...extra,
});

const good = {
  summary: "先存储后命令行",
  tasks: [
    item("store"),
    item("cli", { after: ["store"], ask: ["前端"], worker: "claude+opus" }),
    item("docs", { after: ["cli", "store"] }),
  ],
};

test("清单校验：合格的规整出来，缺省值补齐", () => {
  const result = validatePlan(good);
  assert(result.ok, JSON.stringify(result));
  assert.equal(result.value.summary, "先存储后命令行");
  assert.deepEqual(result.value.tasks[1], {
    key: "cli",
    title: "做 cli",
    brief: "cli 的要点",
    after: ["store"],
    by: null,
    ask: ["前端"],
    worker: "claude+opus",
    part: null,
  });
  // 没写代号按序号；ask 写成逗号分隔也认；summary 可省。
  const loose = validatePlan({
    tasks: [
      { title: "一", brief: "要点" },
      { title: "二", brief: "要点", after: ["1"], ask: "前端,后端" },
    ],
  });
  assert(loose.ok);
  assert.deepEqual(
    loose.value.tasks.map((t) => [t.key, t.after, t.ask]),
    [
      ["1", [], []],
      ["2", ["1"], ["前端", "后端"]],
    ],
  );
  assert.equal(loose.value.summary, "");
});

test("清单校验：破坏输入逐条报出位置", () => {
  const cases: [unknown, RegExp][] = [
    [null, /应为 JSON 对象/],
    [[], /应为 JSON 对象/],
    [{ tasks: [] }, /至少要有一件/],
    [{ tasks: "x" }, /至少要有一件/],
    [
      {
        tasks: Array.from({ length: PLAN_TASKS_MAX + 1 }, (_, i) =>
          item(`k${i}`),
        ),
      },
      /至多 20 件/,
    ],
    [{ ...good, extra: 1 }, /extra: 是未知字段/],
    [{ tasks: [item("a", { owner: "u1" })] }, /tasks\[0\]\.owner: 是未知字段/],
    [{ tasks: ["x"] }, /tasks\[0\] 应为对象/],
    [{ tasks: [item("a b")] }, /代号只用字母/],
    [{ tasks: [item("a"), item("a")] }, /代号 a 重复/],
    [{ tasks: [item("a", { title: "" })] }, /tasks\[0\]（a）\.title 不能为空/],
    [{ tasks: [item("a", { title: "长".repeat(101) })] }, /title 至多 100 字/],
    [{ tasks: [item("a", { brief: 3 })] }, /brief 应为文本/],
    [{ tasks: [item("a", { brief: "  " })] }, /brief 不能为空/],
    [{ tasks: [item("a", { after: ["a"] })] }, /不能依赖自己/],
    [{ tasks: [item("a", { after: ["z"] })] }, /没有代号 z/],
    [{ tasks: [item("a", { after: "b" }), item("b")] }, null as never],
    [
      { tasks: [item("a", { after: ["b"] }), item("b", { after: ["a"] })] },
      /先后依赖成环：a、b/,
    ],
    [{ tasks: [item("a", { ask: [1] })] }, /每一项应为非空文本/],
    [
      { tasks: [item("a", { ask: ["一", "二", "三", "四", "五", "六"] })] },
      /至多 5 项/,
    ],
    [{ tasks: [item("a", { by: "长".repeat(41) })] }, /by 至多 40 字/],
    [{ summary: 5, tasks: [item("a")] }, /summary 应为文本/],
  ];
  for (const [input, pattern] of cases) {
    const result = validatePlan(input);
    if (pattern === null) {
      assert(result.ok, JSON.stringify(input));
      continue;
    }
    assert(!result.ok, JSON.stringify(input));
    assert.match(result.error, pattern);
  }
});

test("先后：稳定排序，没有先后关系的保持原顺序；成环报出", () => {
  assert.deepEqual(
    topoOrder([
      { key: "c", after: ["a"] },
      { key: "a", after: [] },
      { key: "b", after: [] },
    ]),
    { ok: true, value: ["a", "c", "b"] },
  );
  const plan = validatePlan({
    tasks: [item("x", { after: ["y"] }), item("y"), item("z")],
  });
  assert(plan.ok);
  assert.deepEqual(
    orderedItems(plan.value).map((t) => t.key),
    ["y", "x", "z"],
  );
  const cycle = topoOrder([
    { key: "a", after: ["c"] },
    { key: "b", after: ["a"] },
    { key: "c", after: ["b"] },
    { key: "d", after: [] },
  ]);
  assert(!cycle.ok);
  assert.match(cycle.error, /成环：a、b、c$/);
});

test("清单文件：没写、空、不是 JSON、不合格、带 BOM", () => {
  assert.match(
    (parsePlan(null) as { error: string }).error,
    /没有在工作目录写 plan\.json/,
  );
  assert.match((parsePlan("  ") as { error: string }).error, /是空的/);
  assert.match((parsePlan("{") as { error: string }).error, /不是合法的 JSON/);
  assert.match(
    (parsePlan('{"tasks":[]}') as { error: string }).error,
    /^plan\.json：tasks: 至少要有一件/,
  );
  assert(parsePlan(`﻿${JSON.stringify(good)}`).ok);
});

test("归属部分：只能是总任务所在部分或其下；总任务没归属部分时不限", () => {
  // o1 → o2 → o3；o1 → o4
  const parents = new Map<number, number | null>([
    [1, null],
    [2, 1],
    [3, 2],
    [4, 1],
  ]);
  const where = "tasks[0]（a）";
  assert.equal(partVerdict({ where, part: 2, home: 2, parents }), null);
  assert.equal(partVerdict({ where, part: 3, home: 2, parents }), null);
  assert.match(
    partVerdict({ where, part: 4, home: 2, parents }) ?? "",
    /o4 不在总任务所在的 o2 之下；别的部分的活先上交 cross/,
  );
  assert.match(partVerdict({ where, part: 1, home: 2, parents }) ?? "", /o1/);
  assert.equal(partVerdict({ where, part: 4, home: null, parents }), null);
  // 父链成环也能停下。
  const loop = new Map<number, number | null>([
    [5, 6],
    [6, 5],
  ]);
  assert.match(
    partVerdict({ where, part: 5, home: 2, parents: loop }) ?? "",
    /o5/,
  );
});

test("规划详述：交付格式与规矩在前，带总任务详述、已有子任务、专员与全景；子任务详述带来源", () => {
  const brief = planBrief({
    target: { ref: "t197", title: "大功能", brief: "要做到 X", repo: "/r" },
    part: { ref: "o2", name: "Atrium" },
    context: "Atrium 是……",
    children: [{ ref: "t198", title: "已有一块", status: "todo" }],
    specialists: [{ name: "后端", description: "服务与命令行" }],
  });
  for (const pattern of [
    /给总任务 t197「大功能」做规划/,
    /仓库在 \/r，只读/,
    new RegExp(`写 ${PLAN_FILE.replace(".", "\\.")}`),
    /要做到 X/,
    /- t198 \[todo\] 已有一块/,
    /- 后端：服务与命令行/,
    /Atrium 是……/,
    /缺省是总任务所在的 o2/,
  ])
    assert.match(brief, pattern);
  const bare = planBrief({
    target: { ref: "t1", title: "x", brief: null, repo: null },
    part: null,
    context: "",
    children: [],
    specialists: [],
  });
  assert.match(bare, /没写仓库/);
  assert.match(bare, /没写详述，只有标题/);
  assert.match(bare, /没有登记专员/);
  const plan = validatePlan(good) as { ok: true; value: Plan };
  const text = itemBrief(plan.value.tasks[1]!, {
    target: "t197",
    title: "大功能",
    plan: "t300",
    by: "a1",
  });
  assert.match(text, /^cli 的要点/);
  assert.match(text, /来源：总任务 t197「大功能」的规划 t300，由 a1 采纳/);
  assert.match(text, /规划建议的执行者：claude\+opus/);
  assert.doesNotMatch(
    itemBrief(plan.value.tasks[0]!, {
      target: "t1",
      title: "x",
      plan: "t2",
      by: "u1",
    }),
    /建议的执行者/,
  );
});

test("建议的专员：只请可选范围里的（名称或 rN），请不动的列出来", () => {
  const available = [
    { name: "后端", ref: "r1" },
    { name: "前端", ref: "r2" },
  ];
  assert.deepEqual(
    pickSpecialists({ by: "后端", ask: ["r2", "安全"] }, available),
    { by: "后端", ask: ["r2"], dropped: ["安全"] },
  );
  assert.deepEqual(pickSpecialists({ by: "设计", ask: [] }, available), {
    by: null,
    ask: [],
    dropped: ["设计"],
  });
  assert.deepEqual(pickSpecialists({ by: null, ask: [] }, []), {
    by: null,
    ask: [],
    dropped: [],
  });
});

test("自动派规划的开关：显式 0/1，缺省只在默认数据目录开", () => {
  assert.equal(autoPlanEnabled("0", { defaultData: true }), false);
  assert.equal(autoPlanEnabled("1", { defaultData: false }), true);
  assert.equal(autoPlanEnabled(undefined, { defaultData: true }), true);
  assert.equal(autoPlanEnabled(undefined, { defaultData: false }), false);
});

test("leader 提示词里的规划事件：待采纳带件数与下一步，没出清单带原因", () => {
  const base = {
    id: 9,
    task: "t300",
    count: 1,
  };
  assert.match(
    eventLine({
      ...base,
      kind: "plan_ready",
      detail: {
        target: "t197",
        title: "大功能",
        plan: "t300",
        tasks: 3,
        summary: "先存储",
        next: "atrium task adopt-plan t300 --dry-run",
      },
    }),
    /#9 t197「大功能」规划待采纳，规划 t300 出了 3 件子任务：先存储 → atrium task adopt-plan t300 --dry-run/,
  );
  assert.match(
    eventLine({
      ...base,
      kind: "plan_failed",
      detail: {
        target: "t197",
        title: "大功能",
        plan: "t300",
        plan_error: "plan.json 是空的",
        next: "重新规划：atrium task plan-for t197",
      },
    }),
    /规划没出清单，规划 t300 没出清单：plan\.json 是空的 → 重新规划/,
  );
});

test("清单文字版：状态、思路、先后与建议；采纳后给建出的任务", () => {
  const plan = (validatePlan(good) as { ok: true; value: Plan }).value;
  const view = {
    plan: "t300",
    target: "t197",
    target_title: "大功能",
    status: "ready" as const,
    content: plan,
    error: null,
    decided_at: null,
    decided_by: null,
    note: null,
    adopted: [],
    dry_run: true,
  };
  const text = renderPlan(view).join("\n");
  assert.match(text, /^t300 规划 t197「大功能」 · 清单待采纳/);
  assert.match(text, /思路：先存储后命令行/);
  assert.match(
    text,
    /2\. \[cli\] 做 cli（等 store；请审 前端；建议 claude\+opus）/,
  );
  const adopted = renderPlan({
    ...view,
    status: "adopted",
    decided_by: "a1",
    adopted: [
      { key: "store", ref: "t301", title: "做 store", after: [] },
      { key: "cli", ref: "t302", title: "做 cli", after: ["t301"] },
    ],
  }).join("\n");
  assert.match(adopted, /已采纳（a1）/);
  assert.match(adopted, /2\. \[t302\] 做 cli（等 t301/);
  assert.match(
    renderPlan({
      ...view,
      status: "failed",
      content: null,
      error: "没写",
    }).join("\n"),
    /没出清单\n原因：没写/,
  );
});

test("派规划 → 待采纳投给 leader → 看清单 → 采纳建子任务设依赖；重复与破坏输入；驳回；没出清单", async (t) => {
  const fx = fixture(t);
  const writePlan = (body: string) =>
    fx.script(
      "opencode",
      `cat > ${PLAN_FILE} <<'JSON'\n${body}\nJSON\necho '{"type":"text","part":{"text":"拆好了"}}'`,
    );
  writePlan(JSON.stringify(good));
  const { app, db } = await createApp({
    data: join(fx.root, "data"),
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      pace: async () => undefined,
      usagePace: async () => undefined,
      tickMs: 100,
    },
    plans: { auto: false },
  });
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, any>,
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
  const eventOf = async (taskId: number, kinds: string[]) => {
    await until(
      () =>
        !!db
          .prepare(
            `SELECT 1 FROM task_inbox WHERE task_id=? AND kind IN (${kinds.map(() => "?").join(",")})`,
          )
          .get(taskId, ...kinds),
      15_000,
    );
    const row = db
      .prepare(
        `SELECT subscriber,kind,detail FROM task_inbox WHERE task_id=? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId, ...kinds) as {
      subscriber: string;
      kind: string;
      detail: string;
    };
    return {
      subscriber: row.subscriber,
      kind: row.kind,
      ...JSON.parse(row.detail),
    };
  };
  const count = () =>
    (db.prepare("SELECT count(*) n FROM tasks").get() as { n: number }).n;
  for (const [slug, parent, name] of [
    ["org", undefined, "组织"],
    ["atrium", "o1", "Atrium"],
    ["rules", "o2", "组织和规矩"],
    ["oq", "o1", "OpenQuota"],
  ] as const)
    await ok("POST", "/api/org/nodes", {
      slug,
      ...(parent ? { parent } : {}),
      kind: parent ? (parent === "o1" ? "project" : "module") : "org",
      name,
      reason: "建",
    });
  await ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  // t1：准备拆的总任务（带仓库；deliver none 免得采纳后的子任务被自动派给假执行者）。
  await ok("POST", "/api/tasks", {
    title: "大功能",
    part: "o2",
    repo: fx.repo,
    brief: "要做到 X",
    deliver: "none",
  });

  for (const [payload, pattern] of [
    [{ worker: 5 }, /--worker/],
    [{ push: true }, /push: 是未知字段/],
  ] as const) {
    const bad = await call("POST", "/api/tasks/t1/plan", payload);
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, pattern);
  }
  assert.equal((await call("POST", "/api/tasks/t99/plan", {})).status, 404);
  assert.equal(count(), 1);

  const started = await ok("POST", "/api/tasks/t1/plan", {
    worker: "opencode",
  });
  assert.equal(started.task.ref, "t2");
  assert.match(started.next, /atrium task adopt-plan t2 --dry-run/);
  const planTask = db
    .prepare(
      "SELECT parent_id,helper,deliver,repo,brief,title FROM tasks WHERE id=2",
    )
    .get() as {
    parent_id: number;
    helper: number;
    deliver: string;
    repo: string | null;
    brief: string;
    title: string;
  };
  assert.deepEqual(
    [
      planTask.parent_id,
      planTask.helper,
      planTask.deliver,
      planTask.repo,
      planTask.title,
    ],
    [1, 1, "none", null, "规划：大功能"],
  );
  assert.match(planTask.brief, /要做到 X/);
  assert.match(
    planTask.brief,
    new RegExp(
      `仓库在 ${fx.repo.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}，只读`,
    ),
  );
  // 规划是帮手：总任务不因它变成「有子任务」。
  assert.equal((await ok("GET", "/api/tasks/t1")).rollup ?? null, null);
  // 没了结的规划还在：再派报冲突并给等待命令。
  const again = await call("POST", "/api/tasks/t1/plan", {
    worker: "opencode",
  });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /t1 已有规划 t2/);

  const ready = await eventOf(2, ["plan_ready", "plan_failed"]);
  assert.equal(ready.kind, "plan_ready", JSON.stringify(ready));
  assert.equal(ready.subscriber, "a1");
  assert.equal(ready.tasks, 3);
  assert.equal(ready.target, "t1");
  assert.equal(ready.next, "atrium task adopt-plan t2 --dry-run");

  // 看清单：给规划任务或总任务都行。
  const shown = await ok("GET", "/api/plans/t2");
  assert.equal(shown.status, "ready");
  assert.equal(shown.content.tasks.length, 3);
  assert.equal((await ok("GET", "/api/plans/t1")).plan, "t2");
  assert.equal((await call("GET", "/api/plans/t99")).status, 404);

  // 改过的清单不合格、归属部分出界、专员不存在：报错，一件都不建。
  for (const [plan, pattern] of [
    [
      { tasks: [item("a", { after: ["b"] }), item("b", { after: ["a"] })] },
      /成环/,
    ],
    [{ tasks: [item("a", { part: "o4" })] }, /o4 不在总任务所在的 o2 之下/],
    [{ tasks: [item("a"), item("b", { part: "o99" })] }, /o99/],
  ] as const) {
    const bad = await call("POST", "/api/plans/t2/adopt", { plan });
    assert(bad.status >= 400 && bad.status < 500, JSON.stringify(bad.body));
    assert.match(bad.body.error, pattern);
  }
  assert.equal(count(), 2);
  assert.equal(
    (await call("POST", "/api/plans/t2/adopt", { extra: 1 })).status,
    400,
  );
  // --dry-run 带改过的清单：只校验、给看，不建。
  const preview = await ok("POST", "/api/plans/t2/adopt", {
    plan: { tasks: [item("only")] },
    dry_run: true,
  });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.content.tasks[0].key, "only");
  assert.equal(count(), 2);

  const adopted = await ok("POST", "/api/plans/t2/adopt", {});
  assert.equal(adopted.status, "adopted");
  assert.equal(adopted.decided_by, "u1");
  assert.deepEqual(
    adopted.adopted.map((a: { key: string; ref: string; after: string[] }) => [
      a.key,
      a.ref,
      a.after,
    ]),
    [
      ["store", "t3", []],
      ["cli", "t4", ["t3"]],
      ["docs", "t5", ["t4", "t3"]],
    ],
  );
  const children = db
    .prepare(
      "SELECT id,parent_id,auto,deliver,repo,brief FROM tasks WHERE id>=3 ORDER BY id",
    )
    .all() as {
    id: number;
    parent_id: number;
    auto: number;
    deliver: string;
    repo: string;
    brief: string;
  }[];
  assert.deepEqual(
    children.map((c) => [c.parent_id, c.auto, c.deliver, c.repo]),
    Array(3).fill([1, 1, "none", fx.repo]),
  );
  assert.match(
    children[1]!.brief,
    /来源：总任务 t1「大功能」的规划 t2，由 u1 采纳/,
  );
  assert.match(children[1]!.brief, /规划建议的执行者：claude\+opus/);
  // 规划建议的专员请不动（这一部分没有「前端」）：不挡采纳，记进详述。
  assert.match(
    children[1]!.brief,
    /规划建议的专员 前端 不在这一部分可选的范围里，没有请/,
  );
  const deps = db
    .prepare(
      "SELECT task_id,after_id FROM task_dependencies ORDER BY task_id,after_id",
    )
    .all() as { task_id: number; after_id: number }[];
  assert.deepEqual(
    deps.map((d) => [d.task_id, d.after_id]),
    [
      [4, 3],
      [5, 3],
      [5, 4],
    ],
  );
  // 同一份只采纳一次；采纳过的也不能再驳回。
  const twice = await call("POST", "/api/plans/t2/adopt", {});
  assert.equal(twice.status, 409);
  assert.match(twice.body.error, /t2 已采纳（u1）/);
  assert.equal(
    (await call("POST", "/api/plans/t2/reject", { note: "晚了" })).status,
    409,
  );

  // 驳回：要写原因；驳回后可以重新规划。没出清单：投 plan_failed，写明原因与重新规划的命令。
  await ok("POST", "/api/tasks", {
    title: "另一件大事",
    part: "o3",
    deliver: "none",
  });
  writePlan("不是 JSON");
  const second = await ok("POST", "/api/tasks/t6/plan", { worker: "opencode" });
  const failed = await eventOf(second.task.id, ["plan_ready", "plan_failed"]);
  assert.equal(failed.kind, "plan_failed");
  assert.equal(failed.subscriber, "a1");
  assert.match(failed.plan_error, /plan\.json 不是合法的 JSON/);
  assert.equal(failed.next, "重新规划：atrium task plan-for t6");
  assert.equal(
    (await ok("GET", `/api/plans/${second.task.ref}`)).status,
    "failed",
  );
  const refused = await call("POST", `/api/plans/${second.task.ref}/adopt`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /没出可用的清单/);

  writePlan(JSON.stringify(good));
  const third = await ok("POST", "/api/tasks/t6/plan", { worker: "opencode" });
  await eventOf(third.task.id, ["plan_ready"]);
  assert.equal(
    (await call("POST", `/api/plans/${third.task.ref}/reject`, {})).status,
    400,
  );
  const rejected = await ok("POST", `/api/plans/${third.task.ref}/reject`, {
    note: "拆得太碎",
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.note, "拆得太碎");
  assert.equal(
    (await call("POST", `/api/plans/${third.task.ref}/adopt`, {})).status,
    409,
  );
  assert.equal(
    (await call("POST", "/api/tasks/t6/plan", { worker: "opencode" })).status,
    201,
  );

  // task add --plan 的开关只认布尔（真派规划要挑执行者，这里不挑，免得碰到本机真实的 CLI）。
  assert.equal(
    (await call("POST", "/api/tasks", { title: "x", plan: "yes" })).status,
    400,
  );
});
