import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { cloneLimits, ensureLeaderTables } from "../server/leaders/model.ts";
import { closeStaleWakes, clonesOf } from "../server/leaders/wakes.ts";
import { ensureMemoPartTables, readMemoParts } from "../server/memos/parts.ts";
import {
  busyLine,
  claimVerdict,
  cloneLimit,
  clonesProblem,
  CLONES_DEFAULT,
  CLONES_MAX,
  groupOf,
  laneOf,
  memoTarget,
  planClones,
  ROUTINE_LABEL,
  type CloneEvent,
  type RunningClone,
} from "../server/leaders/clones.ts";

/** 分身判定（t275）：分组、认领冲突、并发上限、日常与大事分开、攒批、备忘写到哪。 */

const ev = (
  id: number,
  kind: string,
  group: string | null,
  queuedAt = 0,
): CloneEvent => ({ id, kind, group, queuedAt });

const plan = (
  events: CloneEvent[],
  running: RunningClone[] = [],
  max = 3,
  now = 100_000,
  batchMs = 30_000,
) => planClones({ events, running, max, now, batchMs });

test("分组：总任务是自己；子任务归父任务；独立任务是自己", () => {
  assert.equal(groupOf({ id: 197, parent_id: null, total: true }), "t197");
  assert.equal(groupOf({ id: 197, parent_id: 150, total: true }), "t197");
  assert.equal(groupOf({ id: 300, parent_id: 197, total: false }), "t197");
  assert.equal(groupOf({ id: 84, parent_id: null, total: false }), "t84");
});

test("大事与日常：规划结果、会审结论是大事，其余是日常", () => {
  for (const kind of [
    "plan_ready",
    "plan_failed",
    "council_decided",
    "council_escalated",
  ])
    assert.equal(laneOf(kind), "big", kind);
  for (const kind of ["online", "merge_returned", "stalled", "failed", "done"])
    assert.equal(laneOf(kind), "routine", kind);
});

test("并发上限：没配为缺省 3，夹在 1～8；--clones 校验", () => {
  assert.equal(cloneLimit(null), CLONES_DEFAULT);
  assert.equal(cloneLimit(undefined), CLONES_DEFAULT);
  assert.equal(cloneLimit(0), 1);
  assert.equal(cloneLimit(99), CLONES_MAX);
  assert.equal(cloneLimit(2.7), 2);
  for (const ok of [1, "3", 8]) assert.equal(clonesProblem(ok), null);
  for (const bad of [0, "0", 9, "abc", -1, 1.5, "", null, true])
    assert.match(clonesProblem(bad) ?? "", /clones: 分身并发上限应为 1～8/);
});

test("空闲时：日常事件合成一个分身，大事一组一个，同一组的日常事件跟大事分身走", () => {
  const result = plan([
    ev(1, "online", "t84"),
    ev(2, "plan_ready", "t197"),
    ev(3, "merge_returned", "t90"),
    ev(4, "failed", "t197"),
    ev(5, "material_stale", null),
    ev(6, "council_decided", "t210"),
  ]);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.start, [
    {
      slot: 1,
      lane: "routine",
      label: ROUTINE_LABEL,
      groups: ["t84", "t90"],
      eventIds: [1, 3, 5],
    },
    {
      slot: 2,
      lane: "big",
      label: "t197",
      groups: ["t197"],
      eventIds: [2, 4],
    },
    {
      slot: 3,
      lane: "big",
      label: "t210",
      groups: ["t210"],
      eventIds: [6],
    },
  ]);
});

test("日常不被大事挡住：大事占满时仍给日常留一个位置", () => {
  const running: RunningClone[] = [
    { slot: 1, lane: "big", label: "t197", groups: ["t197"] },
    { slot: 3, lane: "big", label: "t210", groups: ["t210"] },
  ];
  const result = plan(
    [ev(7, "online", "t84"), ev(8, "plan_ready", "t220")],
    running,
  );
  assert.deepEqual(result.start, [
    {
      slot: 2,
      lane: "routine",
      label: ROUTINE_LABEL,
      groups: ["t84"],
      eventIds: [7],
    },
  ]);
});

test("大事至多占上限减一个分身；日常同时只有一个分身", () => {
  // 上限 3、日常在跑：再来三组大事只起两个。
  const result = plan(
    [
      ev(1, "plan_ready", "t1", 0),
      ev(2, "plan_ready", "t2", 10),
      ev(3, "plan_ready", "t3", 20),
      ev(4, "online", "t4"),
    ],
    [{ slot: 2, lane: "routine", label: ROUTINE_LABEL, groups: ["t9"] }],
  );
  assert.deepEqual(
    result.start.map((s) => [s.slot, s.lane, s.label]),
    [
      [1, "big", "t1"],
      [3, "big", "t2"],
    ],
  );
  // 上限 4、没有日常事件：大事至多 3 个，第四组等着。
  const four = plan(
    [
      ev(1, "plan_ready", "t1", 3),
      ev(2, "plan_ready", "t2", 2),
      ev(3, "plan_ready", "t3", 1),
      ev(4, "plan_ready", "t4", 0),
    ],
    [],
    4,
  );
  assert.deepEqual(
    four.start.map((s) => s.label),
    ["t4", "t3", "t2"],
  );
});

test("同一组同一时刻只归一个分身：组被占着的事件等它结束", () => {
  const running: RunningClone[] = [
    { slot: 1, lane: "big", label: "t197", groups: ["t197"] },
  ];
  const result = plan(
    [
      ev(1, "failed", "t197"),
      ev(2, "plan_ready", "t197"),
      ev(3, "online", "t84"),
    ],
    running,
  );
  assert.deepEqual(result.held, [1, 2]);
  assert.deepEqual(
    result.start.map((s) => [s.label, s.eventIds]),
    [[ROUTINE_LABEL, [3]]],
  );
  // 日常分身占着 t84：t84 的新结果等着，别的组照常。
  const routine = plan(
    [ev(4, "online", "t84"), ev(5, "plan_ready", "t197")],
    [{ slot: 1, lane: "routine", label: ROUTINE_LABEL, groups: ["t84"] }],
  );
  assert.deepEqual(routine.held, [4]);
  assert.deepEqual(
    routine.start.map((s) => [s.slot, s.label]),
    [[2, "t197"]],
  );
});

test("满了不起；攒批没到不起，各候选按自己最早的一条算", () => {
  const full: RunningClone[] = [1, 2, 3].map((slot) => ({
    slot,
    lane: slot === 1 ? "routine" : "big",
    label: `t${slot}`,
    groups: [`t${slot}`],
  }));
  assert.deepEqual(plan([ev(9, "online", "t50")], full).start, []);
  const now = 100_000;
  const result = plan(
    [
      ev(1, "online", "t84", now - 10_000),
      ev(2, "plan_ready", "t197", now - 40_000),
    ],
    [],
    3,
    now,
  );
  assert.deepEqual(
    result.start.map((s) => s.label),
    ["t197"],
  );
  assert.deepEqual(plan([], []).start, []);
});

test("上限为 1：和从前一样，一个唤醒送全部，有大事时记作大事", () => {
  const events = [
    ev(1, "online", "t84"),
    ev(2, "plan_ready", "t197"),
    ev(3, "stalled", null),
  ];
  assert.deepEqual(plan(events, [], 1).start, [
    {
      slot: 1,
      lane: "big",
      label: ROUTINE_LABEL,
      groups: ["t84", "t197"],
      eventIds: [1, 2, 3],
    },
  ]);
  assert.deepEqual(plan([ev(2, "plan_ready", "t197")], [], 1).start[0], {
    slot: 1,
    lane: "big",
    label: "t197",
    groups: ["t197"],
    eventIds: [2],
  });
  assert.deepEqual(
    plan(events, [{ slot: 1, lane: "routine", label: "日常", groups: [] }], 1)
      .start,
    [],
  );
});

test("认领冲突：自己的组放行；别的分身占着的拒绝并说清是谁；没人占着放行", () => {
  const siblings = [{ label: "t197", groups: ["t197"] }];
  assert.equal(
    claimVerdict({
      leader: "a1",
      task: "t300",
      group: "t197",
      mine: ["t197"],
      siblings,
    }),
    null,
  );
  assert.match(
    claimVerdict({
      leader: "a1",
      task: "t300",
      group: "t197",
      mine: ["t84"],
      siblings,
    }) ?? "",
    /t300 属于 t197，正由 a1 的另一个分身（t197）处理/,
  );
  assert.equal(
    claimVerdict({
      leader: "a1",
      task: "t5",
      group: "t5",
      mine: [],
      siblings,
    }),
    null,
  );
});

test("状态栏一句：一个分身给摘要，几个给「N 件：…」", () => {
  assert.equal(busyLine([]), "");
  assert.equal(
    busyLine([{ label: ROUTINE_LABEL, summary: "t84 上线" }]),
    "t84 上线",
  );
  assert.equal(
    busyLine([
      { label: "t197", summary: "t197 规划待采纳" },
      { label: ROUTINE_LABEL, summary: "t84 上线、t90 失败" },
      { label: "t210", summary: "会审结论" },
    ]),
    "3 件：t197 规划待采纳；t84 上线、t90 失败；t210 会审结论",
  );
});

test("备忘写到哪：用户与秘书写主备忘；有兄弟时写自己的段；只剩自己时合并", () => {
  assert.deepEqual(memoTarget(undefined), { kind: "main" });
  assert.deepEqual(memoTarget({ label: "t197", started: 5, siblings: 2 }), {
    kind: "part",
    part: "t197",
  });
  assert.deepEqual(memoTarget({ label: "日常", started: 5, siblings: 0 }), {
    kind: "merge",
    before: 5,
    part: "日常",
  });
});

test("旧库：org_leaders 没有分身上限列时补上（缺省 3），新表幂等；带旧运行时的表照常、不动", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧');
    CREATE TABLE org_leaders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, worker TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      wake_at INTEGER, wake_ended_at INTEGER, wake_status TEXT, wake_summary TEXT, wake_note TEXT,
      wake_failures INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0);
    INSERT INTO org_leaders(id,name,worker,created_at,updated_at,wake_status,wake_at)
      VALUES (1,'甲','codex',1,1,'running',5);`);
  ensureLeaderTables(db);
  ensureLeaderTables(db);
  ensureMemoPartTables(db);
  ensureMemoPartTables(db);
  assert.deepEqual([...cloneLimits(db)], [["a1", CLONES_DEFAULT]]);
  assert.deepEqual(clonesOf(db, "a1"), []);
  // 旧的「处理中」：服务重启时记失败，分身表清空。
  closeStaleWakes(db, 9);
  assert.equal(
    (
      db.prepare("SELECT wake_status FROM org_leaders").get() as {
        wake_status: string;
      }
    ).wake_status,
    "failed",
  );
  assert.deepEqual(readMemoParts(db, "a1"), []);
  assert.deepEqual(
    db
      .prepare("SELECT id,name FROM agents")
      .all()
      .map((r) => ({ ...r })),
    [{ id: "x", name: "旧" }],
  );
});
