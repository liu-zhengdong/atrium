import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CLOSING_ACTIONS,
  downstreamHint,
  hangEscalateNote,
  hangLabel,
  hangStep,
  nudgeNote,
} from "../server/leaders/hang.ts";
import { patrolHanging } from "../server/leaders/hang-runtime.ts";
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
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { createTask } from "../server/tasks/ledger.ts";
import { advanceTask } from "../server/tasks/ledger-transition.ts";
import { addTaskNote } from "../server/tasks/notes.ts";
import { downstreamOf } from "../server/tasks/schedule-ledger.ts";
import { width } from "../server/text-width.ts";

const MIN = 60_000;
const step = (patch: Partial<Parameters<typeof hangStep>[0]>) =>
  hangStep({
    since: 0,
    nudgedAt: null,
    now: 0,
    afterMs: 30 * MIN,
    registered: true,
    ...patch,
  });

test("挂着的判定：没到时限不动，到点先叫醒，叫醒后再满时限上交；关闭、没登记、上一段的叫醒各自处理", () => {
  assert.deepEqual(step({ now: 29 * MIN }), { kind: "none" });
  assert.deepEqual(step({ now: 30 * MIN }), { kind: "nudge", minutes: 30 });
  assert.deepEqual(step({ now: 45 * MIN + 59_000 }), {
    kind: "nudge",
    minutes: 45,
  });
  // 叫醒过：从叫醒那一刻再算一个时限。
  assert.deepEqual(step({ now: 59 * MIN, nudgedAt: 30 * MIN }), {
    kind: "none",
  });
  assert.deepEqual(step({ now: 60 * MIN, nudgedAt: 30 * MIN }), {
    kind: "escalate",
    minutes: 60,
  });
  // 叫醒记录早于这一段的起算（重派后又受阻）：这一段还没叫醒过。
  assert.deepEqual(
    step({ since: 40 * MIN, now: 70 * MIN, nudgedAt: 30 * MIN }),
    {
      kind: "nudge",
      minutes: 30,
    },
  );
  // 关闭。
  assert.deepEqual(step({ now: 999 * MIN, afterMs: 0 }), { kind: "none" });
  assert.deepEqual(step({ now: 999 * MIN, afterMs: -1 }), { kind: "none" });
  assert.deepEqual(step({ now: 999 * MIN, afterMs: Number.NaN }), {
    kind: "none",
  });
  // 持球的 leader 已不在登记里：叫不醒，到点直接上交。
  assert.deepEqual(step({ now: 29 * MIN, registered: false }), {
    kind: "none",
  });
  assert.deepEqual(step({ now: 31 * MIN, registered: false }), {
    kind: "escalate",
    minutes: 31,
  });
});

test("挂了多久的人话：分钟、小时、天，不到一分钟不说", () => {
  assert.equal(hangLabel(0), "");
  assert.equal(hangLabel(59_999), "");
  assert.equal(hangLabel(-5 * MIN), "");
  assert.equal(hangLabel(Number.NaN), "");
  assert.equal(hangLabel(MIN), "挂 1 分钟");
  assert.equal(hangLabel(59 * MIN + 59_000), "挂 59 分钟");
  assert.equal(hangLabel(60 * MIN), "挂 1 小时");
  assert.equal(hangLabel(3 * 60 * MIN + 20 * MIN), "挂 3 小时");
  assert.equal(hangLabel(47 * 60 * MIN), "挂 47 小时");
  assert.equal(hangLabel(48 * 60 * MIN), "挂 2 天");
});

test("叫醒与上交的说明：写挂了多久、再不动会怎样、可选动作带上任务短号", () => {
  const note = nudgeNote({
    task: "t7",
    leader: "a3",
    minutes: 31,
    afterMinutes: 30,
    holder: "自动派发失败 · a3 在处理",
  });
  assert.match(note, /t7 在 a3 手里已挂 31 分钟（自动派发失败 · a3 在处理）/);
  assert.match(note, /只写备注不算处理完/);
  assert.match(note, /再过 30 分钟仍没动，运行时上交上一层/);
  assert.match(note, /atrium task run t7/);
  assert.match(note, /atrium task merge t7/);
  assert.match(note, /atrium task set t7 --status cancelled/);
  assert.doesNotMatch(note, /tN/);
  assert.match(
    hangEscalateNote({
      task: "t7",
      leader: "a3",
      minutes: 61,
      nudged: true,
      holder: "x",
    }),
    /挂了 61 分钟（x），叫醒过一次仍没有动作，运行时上交/,
  );
  assert.match(
    hangEscalateNote({
      task: "t7",
      leader: "a9",
      minutes: 31,
      nudged: false,
      holder: "x",
    }),
    /a9 已不在登记里/,
  );
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
  council_escalated: false,
};

test("持球人：leader 手里的受阻任务句末写挂了多久，原因太长先截原因；秘书、用户手里的不写", () => {
  const at = (patch: Partial<HolderFacts>) =>
    holderOf({ ...base, held_since: 0, now: 3 * 60 * MIN, ...patch })!;
  assert.equal(at({}).text, "自动派发失败 · 等 a1 处理 · 挂 3 小时");
  assert.equal(
    at({ inbox: { subscriber: "a1", acked: true } }).text,
    "自动派发失败 · a1 已接手 · 挂 3 小时",
  );
  assert.equal(
    at({ processing_by: "a3" }).text,
    "自动派发失败 · a3 在处理 · 挂 3 小时",
  );
  assert.equal(
    at({ escalated: { to: "a2", from: "a5" } }).text,
    "自动派发失败 · a5 上交给a2 · 挂 3 小时",
  );
  // 不在 leader 手里：不写时长。
  assert.equal(at({ route: "secretary" }).text, "自动派发失败 · 等 秘书 处理");
  assert.equal(at({ route: "u1" }).text, "自动派发失败 · 等你处理");
  assert.equal(
    at({ escalated: { to: "secretary", from: "runtime" } }).text,
    "自动派发失败 · 运行时 上交给秘书",
  );
  // 没有起算时刻或不到一分钟：不写。
  assert.equal(at({ held_since: null }).text, "自动派发失败 · 等 a1 处理");
  assert.equal(at({ now: 30_000 }).text, "自动派发失败 · 等 a1 处理");
  // 原因很长：截原因，时长留着，整句不超宽。
  const long = at({
    block: { reason: `甲乙丙丁${"很长的原因".repeat(20)}`, gates: [] },
    processing_by: "a12",
  });
  assert.match(long.text, /… · a12 在处理 · 挂 3 小时$/);
  assert.ok(width(long.text) <= HOLDER_WIDTH);
});

test("leader 提示词：要求以动作收尾，写明挂多久会再叫醒、上交；时限可配，关闭时不写", () => {
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
  assert.match(leaderPrompt({ ...input, hangMinutes: 45 }), /45 分钟没有/);
  assert.doesNotMatch(leaderPrompt({ ...input, hangMinutes: 0 }), /运行时盯着/);
});

test("事件行：挂着没动写说明；上游失败写下游与可选动作", () => {
  assert.match(
    eventLine({
      id: 9,
      task: "t7",
      kind: "hanging",
      count: 1,
      detail: { title: "修规矩", note: "t7 在 a1 手里已挂 31 分钟" },
    }),
    /^- #9 t7 在你手里挂着没动 修规矩：t7 在 a1 手里已挂 31 分钟$/,
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

test("巡检挂着的任务：到点叫醒一次、再不动上交；重派后又受阻重新起算；没登记的 leader 直接上交；秘书手里的不管", () => {
  const { db, inbox, blocked } = ledger();
  const t1 = blocked("a1", 0);
  const t2 = blocked("a9", 0);
  const t3 = blocked("secretary", 0);
  const t4 = blocked("a1", 0);
  const patrol = (now: number, afterMs = 30 * MIN) =>
    patrolHanging(db, inbox, { now, afterMs });

  assert.deepEqual(patrol(29 * MIN), { nudged: [], escalated: [] });
  assert.deepEqual(patrol(999 * MIN, 0), { nudged: [], escalated: [] });
  assert.deepEqual(patrol(31 * MIN), {
    nudged: [t1.ref, t4.ref],
    escalated: [t2.ref],
  });
  const nudge = inbox
    .list("a1", { limit: 10 })
    .events.find((e) => e.task === t1.ref && e.kind === "hanging")!;
  assert.match((nudge.detail as { note: string }).note, /已挂 31 分钟/);
  assert.equal(nudge.level, "action");
  // 没登记的 a9：上交秘书，原因写明。
  const lost = inbox
    .list("secretary", { limit: 10 })
    .events.find((e) => e.task === t2.ref)!;
  assert.equal(lost.kind, "escalated");
  assert.match((lost.detail as { reason: string }).reason, /a9 已不在登记里/);
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
