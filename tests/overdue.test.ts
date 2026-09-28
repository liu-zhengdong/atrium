import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CLOSING_ACTIONS, downstreamHint } from "../server/leaders/actions.ts";
import { addLeader, ensureLeaderTables } from "../server/leaders/model.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { eventLine, leaderPrompt } from "../server/leaders/wake.ts";
import {
  HOLDER_WIDTH,
  holderOf,
  type HolderFacts,
} from "../server/tasks/holder.ts";
import { holderFor } from "../server/tasks/holder-facts.ts";
import { EventInbox, ensureEventTables } from "../server/tasks/events.ts";
import { eventLevel } from "../server/tasks/event-level.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { createTask, noteTask } from "../server/tasks/ledger.ts";
import { advanceTask } from "../server/tasks/ledger-transition.ts";
import { addTaskNote } from "../server/tasks/notes.ts";
import { downstreamOf } from "../server/tasks/schedule-ledger.ts";
import {
  DUE,
  dueStep,
  heldText,
  overdueDetail,
  spanText,
  type DueKind,
} from "../server/tasks/overdue.ts";
import { patrolOverdue } from "../server/tasks/overdue-runtime.ts";
import { pushOf } from "../server/notify/model.ts";
import { width } from "../server/text-width.ts";

const MIN = 60_000;

/** 持球与期限（overdue.ts）：一张表、一个判定、一种事件、一种显示。 */

test("时限表：每类持球人一行，时限只在这里；叫醒后能上交的只有 leader 与秘书", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(DUE).map(([kind, due]) => [kind, due.ms / MIN]),
    ),
    {
      starting: 3,
      worker: 20,
      check: 10,
      release: 30,
      leader: 30,
      secretary: 3,
    },
  );
  assert.deepEqual(
    Object.entries(DUE)
      .filter(([, due]) => due.escalate)
      .map(([kind]) => kind),
    ["leader", "secretary"],
  );
});

test("dueStep：没到期不动，到期先叫醒，叫醒后再满时限且有上一层才上交；上一段的叫醒不算（穷举）", () => {
  for (const kind of Object.keys(DUE) as DueKind[]) {
    const ms = DUE[kind].ms;
    for (const held of [0, ms - 1, ms, 2 * ms, 3 * ms])
      for (const woke of [null, -1, 0, ms, 2 * ms]) {
        const got = dueStep({ kind, since: 0, wokeAt: woke, now: held });
        const want =
          held < ms
            ? "none"
            : woke === null || woke < 0
              ? "wake"
              : DUE[kind].escalate && held - woke >= ms
                ? "escalate"
                : "none";
        assert.equal(got, want, `${kind} ${held} ${woke}`);
      }
  }
});

test("同一种显示：挂到时限四分之一才说「N 分钟没动」，到期加「已超时」；时长写分钟、小时、天", () => {
  assert.equal(spanText(59_000), "");
  assert.equal(spanText(45 * MIN), "45 分钟");
  assert.equal(spanText(3 * 60 * MIN), "3 小时");
  assert.equal(spanText(50 * 60 * MIN), "2 天");
  assert.equal(heldText("worker", 4 * MIN), "");
  assert.equal(heldText("worker", 5 * MIN), "5 分钟没动");
  assert.equal(heldText("worker", 21 * MIN), "21 分钟没动，已超时");
  assert.equal(heldText("leader", 7 * MIN), "");
  assert.equal(heldText("leader", 3 * 60 * MIN), "3 小时没动，已超时");
  // 秘书的时限短：不到一分钟不说。
  assert.equal(heldText("secretary", 50_000), "");
});

test("overdue 事件：带持球人、已挂多久、下一步；运行时自己处理的只作知会", () => {
  const woke = overdueDetail({
    kind: "leader",
    step: "wake",
    who: "a1",
    heldMs: 31 * MIN,
    next: "atrium task run t7",
  });
  assert.equal(woke.holder, "leader");
  assert.equal(woke.who, "a1");
  assert.equal(woke.held_ms, 31 * MIN);
  assert.match(
    woke.reason,
    /^leader a1 已 31 分钟没动（时限 30 分钟）：再叫醒 leader 一次$/,
  );
  assert.equal(woke.next, "atrium task run t7");
  assert.match(
    overdueDetail({
      kind: "leader",
      step: "escalate",
      who: "a1",
      heldMs: 61 * MIN,
      to: "secretary",
    }).reason,
    /上交 secretary$/,
  );
  assert.equal(eventLevel("overdue", woke), "action");
  for (const holder of ["starting", "worker", "check"] as const)
    assert.equal(
      eventLevel(
        "overdue",
        overdueDetail({ kind: holder, step: "wake", who: null, heldMs: 0 }),
      ),
      "info",
    );
  assert.equal(
    eventLevel(
      "overdue",
      overdueDetail({ kind: "release", step: "wake", who: null, heldMs: 0 }),
    ),
    "action",
  );
  // 上交到用户这层（投给秘书）按「卡住了」推到手机；叫醒不推。
  const push = (step: "wake" | "escalate") =>
    pushOf(
      {
        id: 1,
        subscriber: "secretary",
        kind: "overdue",
        task: "t7",
        actor: null,
        detail: { step, title: "修规矩" },
      },
      "secretary",
      () => null,
    );
  assert.equal(push("escalate")?.kind, "stuck");
  assert.equal(push("wake"), null);
});

test("上游失败的下游说明：列下游、三种动作；没有上游或下游时不写", () => {
  assert.equal(downstreamHint({ upstream: [], downstream: ["t2"] }), "");
  assert.equal(downstreamHint({ upstream: ["t1"], downstream: [] }), "");
  const one = downstreamHint({ upstream: ["t1"], downstream: ["t2"] });
  assert.match(one, /^上游 t1 没成，下游 t2 在等它/);
  assert.match(one, /① 重派上游（atrium task run t1）/);
  assert.match(one, /② 去掉依赖（atrium task set t2 --after 其余上游/);
  assert.match(one, /③ 一起取消（atrium task set t2 --status cancelled/);
  const many = downstreamHint({
    upstream: ["t1", "t4"],
    downstream: ["t2", "t3"],
    more: 5,
  });
  assert.match(many, /上游 t1、t4 没成，下游 t2、t3 等 7 件/);
  assert.match(many, /atrium task run t1；atrium task run t4/);
});

const base: HolderFacts = {
  status: "blocked",
  delivery_stage: null,
  online_wait: 0,
  worker: null,
  queued: null,
  review_task: null,
  schedule_state: null,
  schedule_reason: null,
  waiting_for: [],
  auto: false,
  block: { reason: "自动派发失败：撞车", gates: [] },
  returned: null,
  merge_returned: null,
  escalated: null,
  processing_by: null,
  inbox: null,
  route: "a1",
};

test("持球人：leader 手里的受阻任务句末按同一种写法写没动多久，原因太长先截原因；秘书、用户手里的不写", () => {
  const at = (patch: Partial<HolderFacts>) =>
    holderOf({ ...base, held_since: 0, now: 3 * 60 * MIN, ...patch })!;
  assert.equal(at({}).text, "自动派发失败 · 等 a1 处理 · 3 小时没动，已超时");
  assert.equal(
    at({ inbox: { subscriber: "a1", acked: true } }).text,
    "自动派发失败 · a1 已接手 · 3 小时没动，已超时",
  );
  assert.equal(
    at({ processing_by: "a3" }).text,
    "自动派发失败 · a3 在处理 · 3 小时没动，已超时",
  );
  assert.equal(
    at({ escalated: { to: "a2", from: "a5" } }).text,
    "自动派发失败 · a5 上交给a2 · 3 小时没动，已超时",
  );
  // 不在 leader 手里：不写时长。
  assert.equal(at({ route: "secretary" }).text, "自动派发失败 · 等 秘书 处理");
  assert.equal(at({ route: "u1" }).text, "自动派发失败 · 等你处理");
  assert.equal(
    at({ escalated: { to: "secretary", from: "runtime" } }).text,
    "自动派发失败 · 运行时 上交给秘书",
  );
  // 没有起算时刻或不到时限的四分之一：不写。
  assert.equal(at({ held_since: null }).text, "自动派发失败 · 等 a1 处理");
  assert.equal(at({ now: 7 * MIN }).text, "自动派发失败 · 等 a1 处理");
  assert.equal(
    at({ now: 8 * MIN }).text,
    "自动派发失败 · 等 a1 处理 · 8 分钟没动",
  );
  assert.deepEqual(at({}).due, { kind: "leader", since: 0 });
  // 原因很长：截原因，时长留着，整句不超宽。
  const long = at({
    block: { reason: `甲乙丙丁${"很长的原因".repeat(20)}`, gates: [] },
    processing_by: "a12",
  });
  assert.match(long.text, /… · a12 在处理 · 3 小时没动，已超时$/);
  assert.ok(width(long.text) <= HOLDER_WIDTH);
});

test("leader 提示词：要求以动作收尾，写明多久没动会再叫醒、上交（时限来自那张表）", () => {
  const input = {
    leader: "a1",
    name: "负责人",
    nodes: [],
    memo: "",
    events: [],
    digest: [],
    upstream: "秘书",
  };
  const prompt = leaderPrompt(input);
  assert.match(prompt, /## 每件事以一个动作收尾/);
  assert.match(prompt, /只写备注、只看不动不算处理完/);
  for (const action of CLOSING_ACTIONS)
    assert.ok(prompt.includes(action), action);
  assert.match(prompt, /在你手里 30 分钟没有上面这些动作/);
});

test("事件行：到期写没动多久与下一步；上游失败写下游与可选动作", () => {
  assert.match(
    eventLine({
      id: 9,
      task: "t7",
      kind: "overdue",
      count: 1,
      detail: {
        title: "修规矩",
        reason: "leader a1 已 31 分钟没动",
        next: "atrium task run t7",
      },
    }),
    /^- #9 t7 到期没动 修规矩：leader a1 已 31 分钟没动；atrium task run t7$/,
  );
  assert.match(
    eventLine({
      id: 3,
      task: "t1",
      kind: "failed",
      count: 1,
      detail: {
        title: "上游",
        reason: "测试没过",
        downstream_hint: "上游 t1 没成，下游 t2 在等它",
      },
    }),
    /· 测试没过 · 上游 t1 没成，下游 t2 在等它$/,
  );
});

function ledger() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureEventTables(db);
  ensureOrgTables(db);
  ensureLeaderTables(db);
  addLeader(db, { id: "a1", name: "负责人", worker: "codex" }, 1);
  const inbox = new EventInbox(db);
  const blocked = (owner: string, at: number) => {
    const task = createTask(db, { title: `${owner} 的活`, owner }, at);
    advanceTask(db, task.ref, { kind: "block" }, {}, { reason: "撞车" }, at);
    return task;
  };
  return { db, inbox, blocked };
}

test("巡检 leader 手里的任务：到点叫醒一次、再不动上交；重派后又受阻重新起算；没登记的 leader 直接上交；秘书手里的不管", () => {
  const { db, inbox, blocked } = ledger();
  const t1 = blocked("a1", 0);
  const t2 = blocked("a9", 0);
  const t3 = blocked("secretary", 0);
  const t4 = blocked("a1", 0);
  const patrol = (now: number) => {
    const got = patrolOverdue(db, inbox, now);
    return { nudged: got.woke, escalated: got.escalated };
  };

  assert.deepEqual(patrol(29 * MIN), { nudged: [], escalated: [] });
  assert.deepEqual(patrol(31 * MIN), {
    nudged: [t1.ref, t4.ref],
    escalated: [t2.ref],
  });
  const nudge = inbox
    .list("a1", { limit: 10 })
    .events.find((e) => e.task === t1.ref && e.kind === "overdue")!;
  assert.match((nudge.detail as { reason: string }).reason, /已 31 分钟没动/);
  assert.match((nudge.detail as { next: string }).next, /atrium task run t1/);
  assert.equal(nudge.level, "action");
  // 没登记的 a9：直接上交秘书，同一种事件。
  const lost = inbox
    .list("secretary", { limit: 10 })
    .events.find((e) => e.task === t2.ref)!;
  assert.equal(lost.kind, "overdue");
  assert.equal((lost.detail as { step: string }).step, "escalate");
  // 秘书手里的 t3 没动静。
  assert.ok(
    !inbox
      .list("secretary", { limit: 10 })
      .events.some((e) => e.task === t3.ref),
  );

  // a1 给 t1 写了备注（不算动作）；t4 重派后又受阻（重新起算）。
  addTaskNote(db, t1.ref, { text: "是残留" }, 40 * MIN, "a1");
  advanceTask(
    db,
    t4.ref,
    { kind: "manual_set", to: "todo" },
    {},
    "重派",
    45 * MIN,
  );
  advanceTask(
    db,
    t4.ref,
    { kind: "block" },
    {},
    { reason: "又撞车" },
    50 * MIN,
  );
  assert.deepEqual(patrol(60 * MIN), { nudged: [], escalated: [] });
  assert.deepEqual(patrol(61 * MIN), { nudged: [], escalated: [t1.ref] });
  const row = (id: number) =>
    db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as never;
  assert.equal(holderFor(db, row(t1.id), null, 61 * MIN)!.kind, "secretary");
  // t4：从 50 分钟起算，80 分钟到点叫醒；已上交的 t1、t2 不再重复。
  assert.deepEqual(patrol(80 * MIN), { nudged: [t4.ref], escalated: [] });
  assert.deepEqual(patrol(500 * MIN), { nudged: [], escalated: [t4.ref] });
  assert.deepEqual(patrol(900 * MIN), { nudged: [], escalated: [] });
  db.close();
});

test("下游清单：只列没结束的直接下游，多了给件数", () => {
  const { db } = ledger();
  const up = createTask(db, { title: "上游" }, 1);
  const refs: string[] = [];
  for (let i = 0; i < 12; i++) {
    const down = createTask(db, { title: `下游 ${i}`, after: up.ref }, 1);
    refs.push(down.ref);
  }
  db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(
    Number(refs[0]!.slice(1)),
  );
  const found = downstreamOf(db, up.id);
  assert.deepEqual(found.refs, refs.slice(1, 11));
  assert.equal(found.more, 1);
  assert.deepEqual(downstreamOf(db, Number(refs[5]!.slice(1))), {
    refs: [],
    more: 0,
  });
  db.close();
});

test("巡检等发版：合入满 30 分钟还没发版，告诉负责人一次；运行时自己处理的执行者、检查不在这里", () => {
  const { db, inbox } = ledger();
  const task = createTask(db, { title: "发版", owner: "a1" }, 0);
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merged',online_wait=1 WHERE id=?",
  ).run(task.id);
  noteTask(db, task.id, "merged", {}, 10 * MIN);
  assert.deepEqual(patrolOverdue(db, inbox, 39 * MIN).woke, []);
  assert.deepEqual(patrolOverdue(db, inbox, 41 * MIN).woke, [task.ref]);
  assert.deepEqual(patrolOverdue(db, inbox, 200 * MIN).woke, []);
  const told = inbox
    .list("a1", { limit: 10 })
    .events.find((e) => e.kind === "overdue")!;
  assert.equal((told.detail as { holder: string }).holder, "release");
  assert.equal(told.level, "action");
  // 持球人一行写同一种时长。
  const row = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(task.id) as never;
  assert.match(
    holderFor(db, row, null, 60 * MIN)!.text,
    /^已合入，等发版上线 · 50 分钟没动，已超时$/,
  );
  db.close();
});
