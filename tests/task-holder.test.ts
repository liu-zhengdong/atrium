import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  blockShort,
  HOLDER_WIDTH,
  holderDetail,
  holderOf,
  kindOf,
  mergeShort,
  type HolderFacts,
} from "../server/tasks/holder.ts";
import { width } from "../server/text-width.ts";
import { holderFacts, holderFor } from "../server/tasks/holder-facts.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { ensureEventTables } from "../server/tasks/events.ts";
import { createTask, getTask } from "../server/tasks/ledger.ts";
import { advanceTask, noteTask } from "../server/tasks/ledger-transition.ts";
import { addTaskNote } from "../server/tasks/notes.ts";
import type { TaskStatus } from "../server/tasks/state.ts";

const base: HolderFacts = {
  status: "running",
  delivery_stage: null,
  online_wait: 0,
  worker: "codex+gpt-6-sol:high",
  queued: null,
  review_task: null,
  schedule_state: null,
  schedule_reason: null,
  waiting_for: [],
  auto: false,
  block: null,
  returned: null,
  merge_returned: null,
  escalated: null,
  processing_by: null,
  inbox: null,
  route: "secretary",
  council_escalated: false,
};
const localCheck = {
  reason: "关卡不过：local_check：本地检查未通过：退出码 1",
  gates: ["local_check"],
};
const of = (patch: Partial<HolderFacts>) => holderOf({ ...base, ...patch });

test("订阅者归类与受阻原因缩写", () => {
  assert.equal(kindOf("u1"), "user");
  assert.equal(kindOf("a1"), "leader");
  assert.equal(kindOf("a12"), "leader");
  assert.equal(kindOf("secretary"), "secretary");
  assert.equal(kindOf("ops"), "secretary");
  assert.equal(kindOf("a0"), "secretary");
  assert.equal(blockShort(null), "受阻");
  assert.equal(blockShort({ reason: null, gates: [] }), "受阻");
  assert.equal(blockShort(localCheck), "本地检查没过");
  assert.equal(
    blockShort({ reason: "x", gates: ["pr_exists", "local_check"] }),
    "没找到 PR",
  );
  assert.equal(
    blockShort({ reason: "上游 t43 [failed]", gates: [] }),
    "上游 t43 [failed]",
  );
  assert.equal(
    blockShort({ reason: "自动派发失败：没有可用执行者", gates: [] }),
    "自动派发失败",
  );
  const long = blockShort({ reason: "长".repeat(50), gates: [] });
  assert.ok(width(long) <= 40 && long.endsWith("…"));
  assert.equal(
    blockShort({ reason: "派发失败\n第二行细节\n第三行", gates: [] }),
    "派发失败",
  );
});

test("持球人穷举：结束、会审、合入流水线、排队、在做与交回", () => {
  for (const status of ["done", "failed", "cancelled"] as TaskStatus[])
    assert.equal(of({ status }), null, status);
  assert.deepEqual(of({ status: "done", council_escalated: true }), {
    kind: "user",
    who: "u1",
    text: "会审上交，等你拍板",
  });
  assert.deepEqual(
    of({ status: "done", delivery_stage: "reviewing", review_task: "t9" }),
    { kind: "merge", who: null, text: "合入前审阅中（t9）" },
  );
  assert.equal(
    of({ status: "done", delivery_stage: "reviewing" })!.text,
    "合入前审阅中",
  );
  assert.equal(
    of({ status: "done", delivery_stage: "merge_queued" })!.text,
    "排队合入",
  );
  assert.equal(
    of({ status: "done", delivery_stage: "merging" })!.kind,
    "merge",
  );
  assert.equal(
    of({ status: "done", delivery_stage: "merged", online_wait: 1 })!.text,
    "已合入，等发版上线",
  );
  assert.equal(of({ status: "done", delivery_stage: "merged" }), null);
  assert.equal(of({ status: "done", delivery_stage: "online" }), null);
  assert.deepEqual(of({ status: "todo", queued: { reason: "额度用尽" } }), {
    kind: "queue",
    who: null,
    text: "排队：额度用尽",
  });
  assert.equal(of({ status: "todo", queued: { reason: null } })!.text, "排队");
  assert.deepEqual(of({}), {
    kind: "worker",
    who: "codex+gpt-6-sol:high",
    text: "codex+gpt-6-sol:high 在做",
  });
  assert.equal(of({ worker: null })!.text, "执行者 在做");
  // t92：本地检查没过，a1 捎话后重新拉起。
  assert.deepEqual(
    of({ block: localCheck, returned: { by: "a1", via: "tell" } }),
    {
      kind: "worker",
      who: "codex+gpt-6-sol:high",
      text: "本地检查没过 · a1 已交回执行者",
    },
  );
  assert.equal(
    of({ block: localCheck, returned: { by: "u1", via: "tell" } })!.text,
    "本地检查没过 · 你 已交回执行者",
  );
  assert.equal(
    of({ block: localCheck, returned: { by: null, via: "rerun" } })!.text,
    "本地检查没过 · 已交回执行者",
  );
  assert.equal(
    of({
      returned: { by: null, via: "merge" },
      merge_returned: "rebase 冲突：a.ts",
    })!.text,
    "合入没过：rebase 冲突 · 已交回执行者",
  );
  assert.equal(
    of({ returned: { by: null, via: "merge" } })!.text,
    "合入没过 · 已交回执行者",
  );
});

test("持球人穷举：受阻时上交、备注、收件箱与缺省路由；待办的排期与待派", () => {
  const blocked = { status: "blocked" as const, block: localCheck };
  assert.deepEqual(
    of({ ...blocked, escalated: { to: "secretary", from: "a1" } }),
    {
      kind: "secretary",
      who: "secretary",
      text: "本地检查没过 · a1 上交给秘书",
    },
  );
  assert.deepEqual(of({ ...blocked, escalated: { to: "a2", from: "a1" } }), {
    kind: "leader",
    who: "a2",
    text: "本地检查没过 · a1 上交给a2",
  });
  assert.deepEqual(
    of({ ...blocked, escalated: { to: "u1", from: "secretary" } }),
    {
      kind: "user",
      who: "u1",
      text: "本地检查没过 · 秘书 上交，等你",
    },
  );
  // 上交优先于备注与收件箱。
  assert.equal(
    of({
      ...blocked,
      escalated: { to: "secretary", from: "a1" },
      processing_by: "a1",
      inbox: { subscriber: "a1", acked: true },
    })!.who,
    "secretary",
  );
  assert.deepEqual(of({ ...blocked, processing_by: "a1" }), {
    kind: "leader",
    who: "a1",
    text: "本地检查没过 · a1 在处理",
  });
  assert.equal(
    of({ ...blocked, processing_by: "u1" })!.text,
    "本地检查没过 · 你在处理",
  );
  assert.equal(of({ ...blocked, processing_by: "u1" })!.kind, "user");
  assert.deepEqual(
    of({ ...blocked, inbox: { subscriber: "a1", acked: false } }),
    { kind: "leader", who: "a1", text: "本地检查没过 · 等 a1 处理" },
  );
  assert.equal(
    of({ ...blocked, inbox: { subscriber: "a1", acked: true } })!.text,
    "本地检查没过 · a1 已接手",
  );
  assert.deepEqual(of({ ...blocked }), {
    kind: "secretary",
    who: "secretary",
    text: "本地检查没过 · 等 秘书 处理",
  });
  assert.deepEqual(of({ ...blocked, route: "u1" }), {
    kind: "user",
    who: "u1",
    text: "本地检查没过 · 等你处理",
  });
  // 有 PR 而受阻不再当成「待验收」：照样按谁在处理说。
  assert.equal(of({ ...blocked, route: "a1" })!.kind, "leader");
  // 待办
  assert.deepEqual(of({ status: "todo", schedule_state: "waiting" }), {
    kind: "queue",
    who: null,
    text: "等上游完成",
  });
  assert.equal(
    of({ status: "todo", schedule_state: "waiting", schedule_reason: "t3" })!
      .text,
    "等上游：t3",
  );
  // 排期给了条件就逐项写清（t130）：等谁上线、上游在跑。
  assert.equal(
    of({
      status: "todo",
      schedule_state: "waiting",
      waiting_for: ["t3 上线", "t4 [running]"],
    })!.text,
    "等 t3 上线、t4 在跑",
  );
  assert.deepEqual(of({ status: "todo", auto: true }), {
    kind: "queue",
    who: null,
    text: "就绪，自动派发",
  });
  assert.deepEqual(of({ status: "todo", route: "a1" }), {
    kind: "leader",
    who: "a1",
    text: "待派：等 a1 派活",
  });
  assert.equal(of({ status: "todo", route: "u1" })!.text, "待派：等你派活");
});

test("事实采集：受阻后事件投 a1，a1 捎话后重新拉起显示已交回；备注与上交按受阻之后算", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureEventTables(db);
  const task = createTask(db, { title: "派活命令" }, 1);
  advanceTask(
    db,
    task.ref,
    { kind: "start" },
    { worker: "claude+opus:high" },
    {},
    2,
  );
  advanceTask(
    db,
    task.ref,
    { kind: "block" },
    {},
    { reason: localCheck.reason, gates: ["local_check"] },
    3,
  );
  db.prepare(
    "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,created_at,updated_at,ready_at) VALUES('a1',?,'task','blocked','k',3,3,3)",
  ).run(task.id);
  const row = () =>
    db.prepare("SELECT * FROM tasks WHERE id=?").get(task.id) as never;
  assert.deepEqual(holderFor(db, row(), null), {
    kind: "leader",
    who: "a1",
    text: "本地检查没过 · 等 a1 处理",
    detail: localCheck.reason,
  });
  db.prepare("UPDATE task_inbox SET acked_at=4").run();
  assert.equal(holderFor(db, row(), null)!.text, "本地检查没过 · a1 已接手");
  addTaskNote(db, task.ref, { text: "看日志" }, 5, "a1");
  assert.equal(holderFor(db, row(), null)!.text, "本地检查没过 · a1 在处理");
  noteTask(db, task.ref, "escalated", { from: "a1", to: "secretary" }, 6);
  assert.equal(
    holderFor(db, row(), null)!.text,
    "本地检查没过 · a1 上交给秘书",
  );
  noteTask(db, task.ref, "tell", { text: "rebase 再跑", by: "a1" }, 7);
  advanceTask(
    db,
    task.ref,
    { kind: "start" },
    { worker: "claude+opus:high" },
    {},
    8,
  );
  const facts = holderFacts(db, row(), null);
  assert.deepEqual(facts.returned, { by: "a1", via: "tell" });
  assert.deepEqual(getTask(db, task.ref).holder, {
    kind: "worker",
    who: "claude+opus:high",
    text: "本地检查没过 · a1 已交回执行者",
    detail: localCheck.reason,
  });
  db.close();
});

/** 审阅打回的原文形如 review-runtime 交回时写的：审阅者短号、执行者，再接整篇意见。 */
const REJECTED = `审阅打回（t132，codex+gpt-6-sol:high）：## 必须改的问题

**必须改的问题：**
1. **性能目标没达到**：task ls 实测 240 毫秒，超过 150 毫秒的要点。
2. \`server/tasks/top.ts:88\` 循环里查库。

## 可选建议
- 函数名可以更直白。`;

test("合入交回原因缩成一行：审阅打回取一句要点，其余按类别", () => {
  assert.equal(mergeShort(REJECTED), "审阅打回：性能目标没达到（t132）");
  assert.equal(
    mergeShort("审阅打回（t9，审阅者）：结论前没写别的。\n审阅结论：打回"),
    "审阅打回：结论前没写别的（t9）",
  );
  assert.equal(
    mergeShort("审阅打回（t9，审阅者）：审阅者没写具体问题"),
    "审阅打回：审阅者没写具体问题（t9）",
  );
  assert.equal(
    mergeShort("审阅打回（t9，x）：## 必须改的问题\n```\ncode\n```"),
    "审阅打回（t9）",
  );
  assert.equal(mergeShort("rebase 冲突：a.ts、b.ts"), "rebase 冲突");
  assert.equal(
    mergeShort("本地检查failed：tests/a.test.ts、tests/b.test.ts；日志 /x/log"),
    "本地检查没过",
  );
  assert.equal(
    mergeShort("本地检查timeout：超过 15 分钟；日志 /x"),
    "本地检查超时",
  );
  assert.equal(
    mergeShort("检查后推送失败：remote rejected\nhint: …"),
    "检查后推送失败",
  );
  assert.equal(mergeShort("gh 合入失败：GraphQL error"), "gh 合入失败");
  const other = mergeShort(`${"很长的原因".repeat(20)}\n第二行`);
  assert.ok(width(other) <= 30 && other.endsWith("…") && !other.includes("\n"));
});

test("合入交回的持球人：整篇审阅意见只出一行，全文在 detail", () => {
  const facts: HolderFacts = {
    ...base,
    returned: { by: null, via: "merge" },
    merge_returned: REJECTED,
  };
  const holder = holderOf(facts)!;
  assert.equal(holder.text, "审阅打回：性能目标没达到（t132） · 已交回执行者");
  assert.equal(holder.detail, undefined);
  assert.equal(holderDetail(facts), REJECTED);
  // 任何一句都单行、不超过显示宽度上限。
  const long = holderOf({
    ...base,
    status: "todo",
    schedule_state: "waiting",
    waiting_for: Array.from({ length: 20 }, (_, i) => `t${i + 100} 上线`),
  })!;
  assert.ok(width(long.text) <= HOLDER_WIDTH && long.text.endsWith("…"));
  const queued = holderOf({
    ...base,
    queued: { reason: "额度不够\n详细：codex 剩 3%\n第三行" },
  })!;
  assert.equal(queued.text, "排队：额度不够");
  assert.equal(holderDetail({ ...base }), null);
  assert.equal(
    holderDetail({ ...base, status: "blocked", block: localCheck }),
    localCheck.reason,
  );
});
