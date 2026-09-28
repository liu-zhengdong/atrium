import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATUSES,
  type TaskStatus,
} from "../server/tasks/ledger/state.ts";
import {
  leafDelivery,
  leafPhase,
  progressOf,
  REFS_MAX,
  rollupLabel,
  rollupOf,
  rollupsOf,
  rollupText,
  STUCK_KINDS,
  storedStatusFor,
  totalOnlineMessage,
  type LeafFacts,
  type LeafPhase,
  type Rollup,
  type RollupStatus,
} from "../server/tasks/ledger/rollup.ts";
import {
  planCounts,
  scheduleBlocked,
} from "../server/tasks/ledger/plan-count.ts";

/** 总任务（t190）的判定：叶子分类、汇总、账本状态跟随、通知分投、排期计数，全部穷举。 */

const STAGES = [
  null,
  "reviewing",
  "merge_queued",
  "merging",
  "merged",
  "online",
] as const;

const leaf = (
  id: number,
  status: TaskStatus,
  delivery_stage: LeafFacts["delivery_stage"] = null,
  online_wait = 0,
): LeafFacts => ({ id, status, delivery_stage, online_wait });

test("叶子分类：状态 × 交付阶段 × 是否等上线，逐一穷举", () => {
  for (const status of TASK_STATUSES)
    for (const stage of STAGES)
      for (const wait of [0, 1]) {
        const phase = leafPhase(leaf(1, status, stage, wait));
        const expected: LeafPhase =
          status === "cancelled"
            ? "cancelled"
            : status === "running"
              ? "running"
              : status === "failed" || status === "blocked"
                ? "stuck"
                : status === "todo"
                  ? "todo"
                  : stage === "reviewing" ||
                      stage === "merge_queued" ||
                      stage === "merging" ||
                      (stage === "merged" && wait === 1)
                    ? "landing"
                    : "finished";
        assert.equal(phase, expected, `${status}/${stage}/${wait}`);
      }
});

/** 每类叶子一个代表。 */
const SAMPLE: Record<LeafPhase, (id: number) => LeafFacts> = {
  todo: (id) => leaf(id, "todo"),
  running: (id) => leaf(id, "running"),
  landing: (id) => leaf(id, "done", "merge_queued"),
  stuck: (id) => leaf(id, "failed"),
  finished: (id) => leaf(id, "done", "online"),
  cancelled: (id) => leaf(id, "cancelled"),
};
const PHASES = Object.keys(SAMPLE) as LeafPhase[];

/** 期望的汇总状态，照任务详述的规则一条条写。 */
function expectedStatus(counts: Record<LeafPhase, number>): RollupStatus {
  const total = PHASES.reduce((sum, phase) => sum + counts[phase], 0);
  if (counts.running + counts.landing > 0) return "running";
  if (counts.stuck > 0) return "blocked";
  if (total > 0 && counts.cancelled === total) return "cancelled";
  if (counts.finished > 0 && counts.todo === 0) return "online";
  return "todo";
}

test("汇总状态：六类叶子各 0～2 个的全部组合（729 种）", () => {
  let cases = 0;
  const walk = (index: number, counts: Record<LeafPhase, number>) => {
    if (index === PHASES.length) {
      const leaves: LeafFacts[] = [];
      let id = 1;
      for (const phase of PHASES)
        for (let i = 0; i < counts[phase]; i++)
          leaves.push(SAMPLE[phase](id++));
      const rollup = rollupOf(leaves);
      assert.equal(
        rollup.status,
        expectedStatus(counts),
        JSON.stringify(counts),
      );
      assert.equal(rollup.leaves, leaves.length);
      assert.equal(rollup.finished, counts.finished);
      assert.equal(rollup.running, counts.running + counts.landing);
      assert.equal(rollup.stuck, counts.stuck);
      assert.equal(rollup.todo, counts.todo);
      assert.equal(rollup.cancelled, counts.cancelled);
      assert.equal(
        progressOf(rollup),
        `${counts.finished}/${leaves.length - counts.cancelled}`,
      );
      cases++;
      return;
    }
    for (let n = 0; n <= 2; n++)
      walk(index + 1, { ...counts, [PHASES[index]!]: n });
  };
  walk(0, {
    todo: 0,
    running: 0,
    landing: 0,
    stuck: 0,
    finished: 0,
    cancelled: 0,
  });
  assert.equal(cases, 729);
});

test("汇总：卡住与在做的短号按短号升序、至多 REFS_MAX 个；一句话写清", () => {
  const leaves = [
    ...Array.from({ length: REFS_MAX + 2 }, (_, i) => leaf(20 - i, "failed")),
    leaf(3, "running"),
    leaf(4, "done", "reviewing"),
    leaf(2, "done", "online"),
    leaf(1, "cancelled"),
  ];
  const rollup = rollupOf(leaves);
  assert.deepEqual(rollup.stuck_refs, ["t14", "t15", "t16", "t17", "t18"]);
  assert.deepEqual(rollup.running_refs, ["t3", "t4"]);
  assert.equal(
    rollupText(rollup),
    "在做 · 1/10 · 在做 2（t3、t4） · 卡住 7（t14、t15、t16、t17、t18…） · 取消 1",
  );
  assert.equal(rollupText(rollupOf([leaf(1, "todo")], true)), "待办 · 0/1+");
  assert.equal(
    totalOnlineMessage("t174", rollupOf([leaf(1, "done"), leaf(2, "done")])),
    "t174 整体已上线（2/2）",
  );
});

test("汇总标签：待办没有进展写「待办」，有进展写「等待中」", () => {
  const labels: [LeafFacts[], string][] = [
    [[leaf(1, "running")], "在做"],
    [[leaf(1, "blocked")], "卡住"],
    [[leaf(1, "done")], "已上线"],
    [[leaf(1, "cancelled")], "取消"],
    [[leaf(1, "todo")], "待办"],
    [[leaf(1, "todo"), leaf(2, "done")], "等待中"],
    [[], "待办"],
  ];
  for (const [leaves, label] of labels)
    assert.equal(rollupLabel(rollupOf(leaves)), label);
});

test("账本状态跟随汇总：当前状态 × 汇总状态 × 是否截断，全部穷举", () => {
  const rollups: Record<RollupStatus, Rollup> = {
    running: rollupOf([leaf(1, "running")]),
    blocked: rollupOf([leaf(1, "failed")]),
    online: rollupOf([leaf(1, "done")]),
    cancelled: rollupOf([leaf(1, "cancelled")]),
    todo: rollupOf([leaf(1, "todo")]),
  };
  for (const current of TASK_STATUSES)
    for (const [status, rollup] of Object.entries(rollups) as [
      RollupStatus,
      Rollup,
    ][])
      for (const truncated of [false, true]) {
        const got = storedStatusFor(current, { ...rollup, truncated });
        const target =
          status === "online"
            ? "done"
            : status === "cancelled"
              ? "cancelled"
              : "todo";
        // 自己在跑（拆活的执行者还没退出）的不动；用户取消的不改回来；截断时不猜。
        const expected =
          current === "running" ||
          current === "cancelled" ||
          truncated ||
          current === target
            ? null
            : target;
        assert.equal(got, expected, `${current}/${status}/${truncated}`);
      }
});

test("多层总任务：叶子挂到每一层祖先，中间层只算自己下面的", () => {
  // t1 → t2（→ t4 在跑、t5 完成）、t3 完成；t6 是别的树。
  const rows = [
    { ...leaf(2, "todo"), parent_id: 1, has_children: 1 },
    { ...leaf(3, "done"), parent_id: 1, has_children: 0 },
    { ...leaf(4, "running"), parent_id: 2, has_children: 0 },
    { ...leaf(5, "done", "online"), parent_id: 2, has_children: 0 },
  ];
  const got = rollupsOf(rows);
  assert.equal(got.get(1)?.leaves, 3);
  assert.equal(got.get(1)?.status, "running");
  assert.equal(progressOf(got.get(1)!), "2/3");
  assert.equal(got.get(2)?.leaves, 2);
  assert.equal(progressOf(got.get(2)!), "1/2");
  assert.equal(got.has(3), false);
  // 坏数据里的环不会死循环。
  const loop = rollupsOf([
    { ...leaf(7, "todo"), parent_id: 8, has_children: 0 },
    { ...leaf(8, "todo"), parent_id: 7, has_children: 1 },
  ]);
  assert.ok(loop.size >= 1);
});

test("总任务下的事件分投：投递对象 × 事件类型，秘书只收卡住的总任务级通知", () => {
  const kinds = [
    ...STUCK_KINDS,
    "done",
    "online",
    "merged",
    "merge_queued",
    "ci_failure",
    "ready",
  ];
  const cases: [string[], string][] = [
    [["secretary"], "secretary"],
    [["a1"], "a1"],
    [["a1", "secretary"], "a1"],
  ];
  for (const kind of kinds)
    for (const [targets, main] of cases) {
      const got = leafDelivery(kind, targets, main, "secretary");
      assert.deepEqual(
        got.to,
        targets.filter((target) => target !== "secretary"),
        `${kind}/${targets}`,
      );
      assert.equal(
        got.stuck,
        main === "secretary" && STUCK_KINDS.has(kind),
        `${kind}/${targets}`,
      );
    }
});

test("排期计数：就绪、等待中、因排期卡住，各界面同一口径", () => {
  const item = (schedule_state: string | null, reason: string | null) => ({
    task: { schedule_state },
    reason,
  });
  const blocked = [
    item("blocked", "上游 t1 [failed]"),
    item(null, "上游 t2 [cancelled]"),
    item(null, "任务失败"),
    item("blocked", null),
  ];
  assert.deepEqual(blocked.map(scheduleBlocked), [true, true, false, true]);
  assert.deepEqual(
    planCounts({
      ready: [item(null, null), item(null, null)],
      waiting: [item("waiting", null)],
      blocked,
    }),
    { ready: 2, waiting: 1, schedule_blocked: 3 },
  );
  assert.deepEqual(planCounts({}), {
    ready: 0,
    waiting: 0,
    schedule_blocked: 0,
  });
});
