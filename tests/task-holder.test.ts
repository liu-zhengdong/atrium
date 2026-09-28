import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  blockShort,
  clipWords,
  HOLDER_WIDTH,
  holderDetail,
  holderOf,
  kindOf,
  mergeShort,
  type HolderFacts,
} from "../server/tasks/watch/holder.ts";
import { width } from "../server/text-width.ts";
import { holderFacts, holderFor } from "../server/tasks/watch/holder-facts.ts";
import { ensureTaskTables } from "../server/tasks/ledger/ledger-schema.ts";
import { ensureEventTables } from "../server/tasks/events/events.ts";
import { createTask, getTask } from "../server/tasks/ledger/ledger.ts";
import {
  advanceTask,
  noteTask,
} from "../server/tasks/ledger/ledger-transition.ts";
import { addTaskNote } from "../server/tasks/ledger/notes.ts";
import type { TaskStatus } from "../server/tasks/ledger/state.ts";
import { ensureHostTables } from "../server/hosts/model.ts";

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
};
const localCheck = {
  reason: "关卡不过：local_check：本地检查未通过：退出码 1",
  gates: ["local_check"],
};
const of = (patch: Partial<HolderFacts>) => holderOf({ ...base, ...patch });

test("持球人远程主机优先留在句首，长原因也不挤掉", () => {
  const returned = of({
    host: "ggb（离线）",
    returned: { by: "a1", via: "rerun" },
    block: { reason: "原因".repeat(60), gates: [] },
  })!;
  assert.match(returned.text, /^codex\+gpt-6-sol:high @ ggb（离线） · /);
  assert.ok(width(returned.text) <= HOLDER_WIDTH);
});

test("task show 的持球人：远程用主机名，离线有标记", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureHostTables(db);
  const now = Date.now();
  db.prepare(
    "INSERT INTO hosts(id,name,kind,repos,joined_at,last_seen_at,created_at,updated_at) VALUES(3,'ggb','remote','[]',1,?,?,?)",
  ).run(now, now, now);
  const task = createTask(db, { title: "远程任务" });
  advanceTask(
    db,
    task.ref,
    { kind: "start" },
    { worker: "claude+opus" },
    undefined,
    now,
  );
  db.prepare("UPDATE tasks SET host_id=3 WHERE id=?").run(task.id);
  assert.equal(getTask(db, task.ref).holder?.text, "claude+opus @ ggb 在做");
  db.prepare("UPDATE hosts SET last_seen_at=? WHERE id=3").run(now - 61_000);
  assert.equal(
    getTask(db, task.ref).holder?.text,
    "claude+opus @ ggb（离线） 在做",
  );
  db.prepare("UPDATE tasks SET host_id=NULL WHERE id=?").run(task.id);
  assert.equal(getTask(db, task.ref).holder?.text, "claude+opus 在做");
  db.close();
});

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

test("持球人穷举：结束、合入流水线、排队、在做与交回", () => {
  for (const status of ["done", "failed", "cancelled"] as TaskStatus[])
    assert.equal(of({ status }), null, status);
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
    "合入没过：rebase 冲突（1 个文件） · 已交回执行者",
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
  assert.deepEqual(holderFor(db, row(), null, 10), {
    kind: "leader",
    who: "a1",
    text: "本地检查没过 · 等 a1 处理",
    due: { kind: "leader", since: 3 },
    detail: localCheck.reason,
  });
  db.prepare("UPDATE task_inbox SET acked_at=4").run();
  assert.equal(
    holderFor(db, row(), null, 10)!.text,
    "本地检查没过 · a1 已接手",
  );
  addTaskNote(db, task.ref, { text: "看日志" }, 5, "a1");
  assert.equal(
    holderFor(db, row(), null, 10)!.text,
    "本地检查没过 · a1 在处理",
  );
  // 在 leader 手里挂了多久（t253）：从受阻那一刻（3）算，备注不重新起算。
  assert.equal(
    holderFor(db, row(), null, 3 + 45 * 60_000)!.text,
    "本地检查没过 · a1 在处理 · 45 分钟没动，已超时",
  );
  noteTask(db, task.ref, "escalated", { from: "a1", to: "secretary" }, 6);
  assert.equal(
    holderFor(db, row(), null, 10)!.text,
    "本地检查没过 · a1 上交给秘书",
  );
  // 上交给秘书后不再显示挂了多久（只盯 leader 手里的）。
  assert.equal(
    holderFor(db, row(), null, 3 + 45 * 60_000)!.text,
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

test("事实采集：合入检查没跑成等重跑（t204）；下一轮开始跑就是检查中；重新排队后旧的重跑记录不算", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureEventTables(db);
  const task = createTask(db, { title: "检查重跑" }, 1);
  advanceTask(
    db,
    task.ref,
    { kind: "start" },
    { worker: "claude+opus:high" },
    {},
    2,
  );
  const row = () =>
    db.prepare("SELECT * FROM tasks WHERE id=?").get(task.id) as never;
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merge_queued' WHERE id=?",
  ).run(task.id);
  // 合入队列跑检查时阶段是 merging；没跑成放回队尾（merge_queued）等重跑。
  const stage = (value: string) =>
    db
      .prepare("UPDATE tasks SET delivery_stage=? WHERE id=?")
      .run(value, task.id);
  noteTask(db, task.ref, "merge_queued", {}, 3);
  stage("merging");
  noteTask(db, task.ref, "merge_check_started", { host: "h3" }, 4);
  assert.equal(holderFacts(db, row(), null).checking, true);
  noteTask(
    db,
    task.ref,
    "merge_check_rerun",
    { attempt: 1, max: 3, reason: "h3 离线，检查没派过去", host: "h3" },
    5,
  );
  stage("merge_queued");
  let facts = holderFacts(db, row(), null);
  assert.equal(facts.checking, false);
  assert.deepEqual(facts.rerun, {
    attempt: 1,
    reason: "h3 离线，检查没派过去",
  });
  assert.deepEqual(holderFor(db, row(), null), {
    kind: "merge",
    who: null,
    text: "合入前检查没跑成，等重跑（1/3）",
    detail: "h3 离线，检查没派过去",
  });
  stage("merging");
  noteTask(db, task.ref, "merge_check_started", { host: "h2" }, 6);
  facts = holderFacts(db, row(), null);
  assert.equal(facts.rerun, null);
  assert.equal(facts.checking, true);
  stage("merge_queued");
  noteTask(
    db,
    task.ref,
    "merge_check_rerun",
    { attempt: 2, reason: "超过 30 分钟" },
    7,
  );
  assert.equal(
    holderFor(db, row(), null)!.text,
    "合入前检查没跑成，等重跑（2/3）",
  );
  noteTask(db, task.ref, "merge_queued", {}, 8);
  assert.equal(holderFor(db, row(), null)!.text, "排队合入");

  // 重跑用尽：合入队列转卡住，只记 merge_blocked，也算受阻。
  db.prepare(
    "UPDATE tasks SET status='blocked',delivery_stage=NULL WHERE id=?",
  ).run(task.id);
  noteTask(
    db,
    task.ref,
    "merge_blocked",
    { reason: "基础设施问题：检查没跑成（已自动重跑 3 次）：h3 离线" },
    9,
  );
  assert.equal(holderFor(db, row(), null)!.text, "基础设施问题 · 等 秘书 处理");
  db.close();
});

test("执行者一行按同一种写法写没动多久（进展时刻来自服务内存）；远程插主机名；检查中看检查", () => {
  const now = 100 * 60_000;
  assert.equal(
    of({ progress_at: now - 5 * 60_000 - 30_000, now })!.text,
    "codex+gpt-6-sol:high 在做 · 5 分钟没动",
  );
  assert.equal(
    of({ progress_at: now - 25 * 60_000, host: "ggb", now })!.text,
    "codex+gpt-6-sol:high @ ggb 在做 · 25 分钟没动，已超时",
  );
  assert.equal(
    of({ progress_at: now - 60_000, now })!.text,
    "codex+gpt-6-sol:high 在做",
  );
  assert.equal(of({ host: "ggb" })!.text, "codex+gpt-6-sol:high @ ggb 在做");
  assert.equal(
    of({ progress_at: now - 9 * 60_000, now, checking: true })!.text,
    "codex+gpt-6-sol:high 交付了，本地检查中",
  );
  assert.equal(
    of({ status: "done", delivery_stage: "merging", checking: true })!.text,
    "合入中：rebase 并跑快检查",
  );
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
  assert.equal(
    mergeShort("rebase 冲突：a.ts、b.ts"),
    "rebase 冲突（2 个文件）",
  );
  assert.equal(
    mergeShort(
      `rebase 冲突：${Array.from({ length: 30 }, (_, i) => `f${i}.ts`).join("、")}`,
    ),
    "rebase 冲突（至少 30 个文件）",
  );
  assert.equal(
    mergeShort("rebase 冲突：error: could not apply 1a2b3c"),
    "rebase 冲突",
  );
  assert.equal(
    mergeShort("本地检查failed：tests/a.test.ts、tests/b.test.ts；日志 /x/log"),
    "本地检查没过：tests/a.test.ts",
  );
  assert.equal(
    mergeShort("本地检查failed：持球人判定 (12.5ms)、另一条；日志 /x/log"),
    "本地检查没过：持球人判定",
  );
  assert.equal(
    mergeShort("本地检查failed：退出码 1；日志 /x/log"),
    "本地检查没过",
  );
  assert.equal(
    mergeShort("本地检查error：Error: spawn sh ENOENT；日志 /x/log"),
    "本地检查没过",
  );
  const longCase = mergeShort(
    "本地检查failed：合入交回原因缩成一行：审阅打回取一句要点，其余按类别、b；日志 /x",
    36,
  );
  assert.ok(width(longCase) <= 36 && longCase.endsWith("…"), longCase);
  assert.equal(
    mergeShort("本地检查timeout：超过 15 分钟；日志 /x"),
    "本地检查超时",
  );
  assert.equal(
    mergeShort("检查后推送失败：remote rejected\nhint: …"),
    "检查后推送失败",
  );
  assert.equal(mergeShort("gh 合入失败：GraphQL error"), "gh 合入失败");
  const other = mergeShort(`${"很长的原因".repeat(20)}\n第二行`, 30);
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

/** t123 真实的审阅打回原因（task_events merge_returned）：开头已被截过，「必须改的问题」第一条以代码位置起头。 */
const T123 = `审阅打回（t132，claude+opus）：…ishWorkerAdvice\` 取最近一条、\`confirmWorkerAdvice\` 找不到交付时回退为 0、\`pick\` 无专员时只看最近 1000 条，都与旧行为等价。
- SQL 全部参数化，没有越出任务范围的改动；\`executors.ts\` 和 \`map/people.ts\` 的调用点通过改 \`publishWorkerAdvice\`、\`workersReport\` 一并覆盖。
- 本地类型检查通过，prettier 检查通过，相关 4 个测试文件 36 个测试全过。CI 在 ubuntu 和 macOS 上通过，windows 在我查时还没跑完。

**必须改的问题**

1. **\`server/tasks/delivery-records.ts:583-610\`（\`deliveryMetrics\` 不带 limit 的分支）没达到原任务的性能和内存目标。**
   - 目标：workers、pick 都 ≤50 ms，调用后内存增量 ≤20 MB。
   - PR 自己报的实测：workers 135 ms，调用后常驻内存 242 MB，连续调用后稳定在约 185 MB，而空闲约 115 MB，增量约 70–127 MB；pick 50 ms，刚好卡在上限。正文把这组数当作达标来写，没说明差距。
   - 我在内存库上抽查（1 万任务、1.5 万交付、约 6 万条相关事件）：\`deliveryMetrics(db)\` 约 108–110 ms。其中光把交付和相关事件从 SQLite 读进来、什么都不做，就要约 59 ms。
   - 也就是说，只要每次请求都把全部交付和相关事件读进 JS 再逐条解析，就不可能到 50 ms，内存也会随交付数增长。标题说「改 SQL 聚合」，实际仍是在 JS 里归并。
   - 怎么改：把每条交付的统计事实（\`first_pass\`、\`gate_return_count\`、\`merge_return_count\`、\`incident_count\`、\`duration_ms\`）作为列存进 \`task_deliveries\`。在交付结束、写入 gates、合入退回、卡死、越界等事件时更新，启动迁移时对旧数据回填一次；小库对照测试照旧保留，用来保证回填结果与旧实现一致。
   - 这样 \`workersReport\` 和 \`pickFacts\` 就能直接用 SQL \`GROUP BY\` 算出各组的次数、一次通过率、平均退回次数、事故数，不再逐条读事件。中位耗时可以按组用窗口函数取，或者只取每组的耗时列。
   - 改完用 1 万任务压测库重测，PR 正文给出达标的改前/改后数字；如果确实做不到，要在正文里如实写明差距和原因。

**可选建议（不作为打回理由）**
- 按 worker 过滤并 \`ORDER BY id DESC LIMIT\` 时，查询计划里有 \`USE TEMP B-TREE FOR ORDER BY\`：\`task_deliveries_worker_id\` 的列序是 (worker, job_id, id)，没法按 id 直接倒序取。再加一个 (worker, id) 索引就能避免排序。
- \`walkMetrics\` 和 \`walkMetricsStream\` 的归并逻辑基本重复，可以合并成一个吃迭代器的函数。
- \`workerReport\` 的交付明细现在只返回最近 200 条（统计仍看全部），命令行显示的交付列表会变短。这是有意为之、符合「列表有界」，但 PR 正文可以写明。`;

test("审阅打回取「必须改的问题」第一条的第一句，放不下时在词边界截断", () => {
  // 带上「（t132）」整行会超出一格，理由优先、不写审阅者短号。
  assert.equal(mergeShort(T123), "审阅打回：没达到原任务的性能和内存目标");
  const holder = holderOf({
    ...base,
    returned: { by: null, via: "merge" },
    merge_returned: T123,
  })!;
  assert.equal(
    holder.text,
    "审阅打回：没达到原任务的性能和内存目标 · 已交回执行者",
  );
  assert.ok(width(holder.text) <= HOLDER_WIDTH);
  // 宽度够时带上审阅者短号。
  assert.equal(
    mergeShort(T123, 60),
    "审阅打回：没达到原任务的性能和内存目标（t132）",
  );
  // 窄时在词边界截断，不截半个词。
  assert.equal(mergeShort(T123, 30), "审阅打回：没达到原任…（t132）");
  // 放得下时保留代码位置与括号说明。
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：**必须改的问题**\n1. `a.ts:3` 漏了判空。",
      60,
    ),
    "审阅打回：a.ts:3 漏了判空（t9）",
  );
});

/** t131、t134 真实的审阅打回原因：编号写在加粗里、条目以「文件:行：」起头、下面跟「**现象**：」这类标签。 */
const T131 = `审阅打回（t131，claude+opus）：…rigin/main 跑同一场景对照过。

## 必须改的问题

**1. \`server/tasks/schedule-refresh.ts:42\`：上游换了新 PR 后，要等旧 PR 的退避结束才会去查**
- **现象**：过滤条件 \`m.next_check_at IS NULL OR m.next_check_at<=?\` 没区分 \`task_pr_merge\` 里缓存的是不是当前这个 PR。上游的旧 PR 被关、退避很长之后，任务返工又交了新 PR，新 PR 也被旧的 \`next_check_at\` 挡住。下游这段时间一直显示「等待」，最长一天。
- **复现**：旧 PR #7 的 \`next_check_at\` 设为 12 小时后、\`attempts\` 为 11，把上游 \`pr_url\` 改成 #8 再巡检一轮：gh 调用 0 次，下游 \`schedule_state\` 仍是 \`waiting\`。
- **对照**：改前 \`fresh\` 为假时会立即重查。
- 这个问题只影响在 GitHub 上手动合入的 PR；运行时合入队列合入的有 \`locallyMerged\` 兜底。
- **怎么改**：
  - 条件改成 \`(m.pr_url IS NOT t.pr_url OR m.next_check_at IS NULL OR m.next_check_at<=?)\`。
  - 第 106 行 \`prior\` 在 \`fresh\` 为假时从 0 算起，不继承旧 PR 的连败次数。
  - 补一条测试。

**2. \`server/tasks/schedule-refresh.ts:180\`：外部 PR 一次查询失败，会把别的任务上已合入的记录改回未合入**
- **现象**：UPDATE 只按 \`repo=? AND number=?\` 匹配，没带 \`merged=0\`。任务 X 已记下 \`o/r#5\` 已合入，新任务 Y 也依赖 \`o/r#5\`。这时 gh 查询失败（网络或认证问题），X 那行被写成 \`merged=0\` 加错误，X 会从「就绪」退回「等待」并进入退避。
- **复现**：结果为 \`[{task_id:1, merged:0, error:'网络错误'}, {task_id:2, merged:0, …}]\`；origin/main 上 X 保持 \`merged:1\`。
- **怎么改**：
  - UPDATE 加 \`AND merged=0\`。
  - 补一条测试：已合入的行不被失败的查询覆盖。

## 不打回，供参考

- **一个 main 上本来就有的问题**：巡检等 gh 的时候，用户把一个因上游受阻（\`schedule_state='blocked'\`）的任务取消了，这一轮仍会对它执行 \`manual_set todo\`，并自动派发出去。原因是比较状态时用的是本页开头读到的旧行（\`row.status\` 和 \`row.schedule_state\`）。这不是本 PR 引入的，但 PR 删掉了逐行重读，以后修的时候要在进入状态迁移前重读这三列。建议另开任务。
- **关服务时会把「已取消」当成查询失败写库**：\`abortable\` 返回的「已取消」会走进失败分支，写入 \`error='已取消'\` 并让 \`attempts+1\`，看板会显示「查询失败：已取消」。建议在 \`stop()\` 为真时不写库。

我没有改动工作树，也没有在 PR 上评论。临时复现脚本已删除，工作树 \`git status\` 为空。`;

const T134 = `审阅打回（t134，claude+opus）：…查到已关闭，就会执行 \`dequeue\` 和 \`advanceTask(block)\`，状态机允许从 running 转成 blocked，结果运行中的任务被标受阻，还会发出一条 blocked 事件。
- **复现结果**：上游 t1 已 done、交付 PR；下游 t2 等 t1。假执行器在 gh 调用里对 t2 执行 \`advanceTask(start)\`，并返回 \`CLOSED\`。
  - 本 PR：t2 变成 \`blocked\`，测试失败。
  - origin/main：同一测试 t2 仍是 \`running\`，测试通过。
- **怎么改**：\`refreshDueSchedulePrs\` 返回后，按页再读一次 \`id,status,schedule_state,schedule_reason\`（一条 \`WHERE id IN (...)\` 查询，仍是每页常数条），和原 row 合并后再判定与推进状态。上面这个场景补成单测。

**2. 每轮查询数仍随候选数线性增长，没达到任务目标**

- **位置**：\`server/tasks/schedule.ts:282-289\`
- **现象**：每个判为 ready 的候选都会单独查一次 \`SELECT status,auto,auto_dispatched,owner,deliver FROM tasks WHERE id=?\`，包括早已派过（\`auto_dispatched=1\`）、这轮什么都不做的任务。
- **实测**：给 SQL 执行计数。50 个稳态 ready 候选，一轮 55 条语句；150 个候选，一轮 155 条，其中 150 条就是这句。PR 正文自己的数据也是「297 条（约 1/候选）」。原任务要求「每轮查询数不随候选数线性增长（批量查或只算变了的）」。
- **怎么改**：先用本页读出的行（改完第 1 条后是重读过的）过滤 \`status==='todo' && auto===1 && auto_dispatched===0\` 等条件，只有真要派发的才再读库确认。补一条单测，断言稳态一轮的语句数与候选数无关。

## 已看过、没有问题的部门

- **需求覆盖**：
  - 上游查询从 \`task_dependencies\` 按 task_id 驱动，有 \`EXPLAIN QUERY PLAN\` 守护测试。
  - gh/git 挪到每页开头批量跑，同一上游只查一次。
  - 上游本地已合入（\`delivery_stage\` 为 merged/online，或已有 \`merge_commit\`）时不调 gh。
  - 关闭或查不到的 PR 按连败次数退避：1 分钟起逐次翻倍，封顶一天。上游换了新 PR 会立即重查，不被旧 PR 的退避挡住。
  - \`close()\` 会中止在跑的 gh/git 子进程，有 1 秒内返回的测试。
  - 没有越出任务范围的改动。
- **旧库兼容**：两张表用 \`ALTER TABLE\` 补 \`next_check_at\` 和 \`attempts\`，旧记录按上次查询时刻补下次可查时间，升级时不会全体一起重查。
- **安全**：SQL 全部参数化，一页最多 200 个占位符，没超 SQLite 上限。gh 用参数数组调用，不经过 shell。日志和输出里没有凭据。
- **其他**：关服务中止的查询不写库，不会把「已取消」记成查询失败。查外部 PR 失败时只更新 \`merged=0\` 的行，不会把别处已合入的记录改回未合入。`;

test("审阅打回：加粗里的编号算条目，跳过标签式加粗和开头的代码位置", () => {
  assert.equal(
    mergeShort(T131, 60),
    "审阅打回：上游换了新 PR 后，要等旧 PR 的退避结束才会去查",
  );
  assert.equal(mergeShort(T131), "审阅打回：上游换了新 PR 后，要等旧…（t131）");
  // 开头连同「必须改的问题」小标题被截掉：取第一个编号问题标题，不取「复现结果」下的细节。
  assert.equal(
    mergeShort(T134, 60),
    "审阅打回：每轮查询数仍随候选数线性增长，没达到任务目标",
  );
  assert.equal(
    mergeShort(T134),
    "审阅打回：每轮查询数仍随候选数线性增…（t134）",
  );
  for (const reason of [T131, T134]) {
    const text = holderOf({
      ...base,
      returned: { by: null, via: "merge" },
      merge_returned: reason,
    })!.text;
    assert.ok(width(text) <= HOLDER_WIDTH, text);
    assert.doesNotMatch(text, /现象|复现|schedule/);
  }
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：## 必须改的问题\n1. `a.ts:42`：上游换了新 PR 后要等退避结束",
    ),
    "审阅打回：上游换了新 PR 后要等退避结束（t9）",
  );
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：## 必须改的问题\n**1. a.ts:42、50: 没判空**",
    ),
    "审阅打回：没判空（t9）",
  );
  // 去掉位置后什么都不剩才退回位置本身。
  assert.equal(
    mergeShort("审阅打回（t9，x）：## 必须改的问题\n1. `a.ts:42`："),
    "审阅打回：a.ts:42（t9）",
  );
  // 缩短时去掉位置，不留开头的破折号。
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：## 必须改的问题\n1. `server/tasks/very-long-file-name.ts:42` —— 没有判空，这里会在上游换 PR 时崩掉",
    ),
    "审阅打回：没有判空，这里会在上游换 PR 时崩掉",
  );
  // 引号里的冒号不断句。
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：必须改的问题\n**2. 条目以「文件:行：」起头时只剩位置**",
      60,
    ),
    "审阅打回：条目以「文件:行：」起头时只剩位置（t9）",
  );
});

test("审阅打回：整行「必须改的问题」算小标题，不当作理由", () => {
  assert.equal(
    mergeShort("审阅打回（t9，x）：先说背景\n必须改的问题\n- 没判空。"),
    "审阅打回：没判空（t9）",
  );
  assert.equal(
    mergeShort("审阅打回（t9，x）：必须要改\n- 没判空。"),
    "审阅打回：没判空（t9）",
  );
  // 写明没有必须改的：不把小标题当理由，也不取可选建议。
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：必须改的问题：无\n\n## 可选建议\n- 命名可以更直白。",
    ),
    "审阅打回（t9）",
  );
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：**必须改的问题**：无\n\n**不作为打回理由：**\n- 命名。",
    ),
    "审阅打回（t9）",
  );
});

test("本地检查没过：用例名里带「、」时按耗时标记取第一个用例", () => {
  assert.equal(
    mergeShort(
      "本地检查failed：持球人穷举：结束、取消 (3.2ms)、另一条 (1ms)；日志 /x/log",
    ),
    "本地检查没过：持球人穷举：结束、取消",
  );
});

test("审阅意见没有「必须改的问题」时取结论句，再没有取第一句完整句子", () => {
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：先说背景。\n\n结论：测试没覆盖 Windows 路径。\n审阅结论：打回",
    ),
    "审阅打回：测试没覆盖 Windows 路径（t9）",
  );
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：…前面被截掉的半句，后面。\n改动把旧表也删了。\n审阅结论：打回",
    ),
    "审阅打回：改动把旧表也删了（t9）",
  );
  assert.equal(
    mergeShort(
      "审阅打回（t9，x）：## 可选建议\n- 命名可以更直白。\n\n## 必须改的问题\n- **没加测试**：见上。\n## 其他\n- x",
    ),
    "审阅打回：没加测试（t9）",
  );
  assert.equal(
    mergeShort("审阅打回（t9，x）：审阅结论：打回"),
    "审阅打回（t9）",
  );
});

test("clipWords 只在词或标点边界截断", () => {
  assert.equal(clipWords("短句", 10), "短句");
  assert.equal(clipWords("修改 publishWorkerAdvice 的查询", 12), "修改…");
  assert.equal(
    clipWords("修改 publishWorkerAdvice 的查询", 26),
    "修改 publishWorkerAdvice…",
  );
  assert.equal(clipWords("一二三四五六七八九十", 9), "一二三四…");
  assert.equal(clipWords("性能没达到，内存也超了", 14), "性能没达到…");
  assert.equal(clipWords("server/tasks/delivery-records.ts", 10), "");
  const line = T123.split("\n")[0]!.replace(/\s+/g, " ");
  const id = /[\w./:@#$-]/;
  for (let max = 1; max <= 80; max++) {
    const out = clipWords(line, max);
    assert.ok(width(out) <= max, `${max}: ${out}`);
    if (!out) continue;
    const kept = out.slice(0, -1);
    assert.ok(line.startsWith(kept), out);
    const last = kept.at(-1)!;
    const next = line[kept.length] ?? "";
    assert.ok(!(id.test(last) && id.test(next)), `${max}: ${out}`);
  }
});
