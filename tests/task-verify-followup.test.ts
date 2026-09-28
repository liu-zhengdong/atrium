import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { ensureQueueTable } from "../server/tasks/queue.ts";
import { advanceTask, createTask } from "../server/tasks/ledger.ts";
import { EventInbox, ensureEventTables } from "../server/tasks/events.ts";
import { eventLevel } from "../server/tasks/event-level.ts";
import { STUCK_KINDS } from "../server/tasks/rollup.ts";
import {
  verifyEventDetail,
  verifyEventKind,
  type VerifyReport,
} from "../server/tasks/verify.ts";
import {
  phenomenonLine,
  verifyActionText,
  verifyHolder,
  verifyStateText,
  type VerifyView,
} from "../server/tasks/verify-view.ts";
import {
  openVerify,
  settleVerifications,
  verifyFileOf,
  verifyViews,
} from "../server/tasks/verify-runtime.ts";
import { countRows, topRows } from "../server/tasks/top.ts";
import { renderTop, type Snapshot, type TopRow } from "../cli/top.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { verifyLine } from "../cli/tasks.ts";
import { eventLine } from "../cli/events.ts";
import { eventLine as leaderEventLine } from "../server/leaders/wake.ts";
import { startApp } from "./task-fixture.ts";

/** 上线验证之后（t182）：通过就结束，没通过或无法验证叫醒负责人；看板、状态栏、task show 显示验证状态。 */

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";

const failing: VerifyReport = {
  verdict: "failed",
  summary: "task show 没显示已上线",
  steps: [
    {
      command: "atrium status",
      expected: "运行中",
      output: "运行中",
      matched: true,
    },
    {
      command: "atrium task add x",
      expected: "建成",
      output: "要真实登录",
      matched: null,
    },
    {
      command: "atrium task show t1",
      expected: "[已上线]",
      output: "t1 [已合入]",
      matched: false,
    },
  ],
};

test("结论之后叫不叫醒人：通过为 null，没通过、无法验证各有事件类型且算「卡住要人」", () => {
  assert.equal(verifyEventKind("passed"), null);
  assert.equal(verifyEventKind("failed"), "verify_failed");
  assert.equal(verifyEventKind("unverifiable"), "verify_unverifiable");
  for (const kind of ["verify_failed", "verify_unverifiable"]) {
    assert.equal(eventLevel(kind, {}), "action");
    assert.ok(STUCK_KINDS.has(kind));
  }
});

test("没通过的事件内容：一句话、现象不符合在前、无法验证其次、符合的不附，带开修复任务的命令", () => {
  const detail = verifyEventDetail({
    task: { ref: "t5", title: "上线的活", part_ref: "o2" },
    verifier: "t9",
    report: failing,
  });
  assert.equal(
    detail.message,
    "t5「上线的活」上线后没通过：task show 没显示已上线",
  );
  assert.equal(detail.reason, "上线后没通过：task show 没显示已上线");
  assert.equal(detail.verdict, "failed");
  assert.equal(detail.verifier, "t9");
  assert.deepEqual(
    (detail.phenomena as { command: string }[]).map((s) => s.command),
    ["atrium task show t1", "atrium task add x"],
  );
  assert.match(String(detail.hint), /atrium task add 修复标题 --part o2/);
  assert.match(String(detail.hint), /不自动回滚/);
  assert.equal(detail.next, "atrium task show t5");
  // 没有归属部分时不写 --part；总结里的疑似凭据抹掉。
  const bare = verifyEventDetail({
    task: { ref: "t6", title: "无部分", part_ref: null },
    verifier: "t10",
    report: {
      verdict: "unverifiable",
      summary: `需要 GH_TOKEN=${TOKEN}`,
      steps: [],
    },
  });
  assert.doesNotMatch(String(bare.hint), /--part/);
  assert.doesNotMatch(JSON.stringify(bare), new RegExp(TOKEN));
  assert.match(String(bare.message), /上线后无法验证/);
  // 至多附五步。
  const many = verifyEventDetail({
    task: { ref: "t7", title: "多步", part_ref: null },
    verifier: "t11",
    report: {
      verdict: "failed",
      summary: "",
      steps: Array.from({ length: 8 }, (_, i) => ({
        command: `c${i}`,
        expected: "",
        output: "",
        matched: false,
      })),
    },
  });
  assert.equal((many.phenomena as unknown[]).length, 5);
  assert.equal(many.message, "t7「多步」上线后没通过");
});

test("现象一行：命令、期望、实际；缺的省掉，换行压成空格", () => {
  assert.equal(
    phenomenonLine(failing.steps[2]!),
    "[不符合] atrium task show t1 · 期望 [已上线] · 实际 t1 [已合入]",
  );
  assert.equal(
    phenomenonLine({ matched: null, output: "a\nb" }),
    "[无法验证] （没写命令） · 实际 a b",
  );
  assert.equal(phenomenonLine({ command: "x", matched: true }), "[符合] x");
});

const view = (over: Partial<VerifyView>): VerifyView => ({
  state: "running",
  verifier: "t9",
  worker: "opencode+deepseek",
  started_at: 1,
  summary: null,
  decided_at: null,
  handler: null,
  pending: false,
  ...over,
});

test("验证状态的显示与持球人：验证中是验证执行者，没过且没处理完的是收到事件的人，其余没有", () => {
  const cases: [Partial<VerifyView>, string, string, string | null][] = [
    [
      {},
      "已上线 · 验证中",
      "t9 opencode+deepseek 在照 PR 的端到端验证跑",
      "worker",
    ],
    [{ state: "passed" }, "已上线 · 验证通过", "t9 照着跑通", null],
    [
      { state: "failed", summary: "没显示", handler: "a2", pending: true },
      "已上线 · 验证没过",
      "没显示 · 等 a2 处理",
      "leader",
    ],
    [
      { state: "failed", summary: "没显示", handler: "a2", pending: false },
      "已上线 · 验证没过",
      "没显示 · a2 已看过",
      null,
    ],
    [
      {
        state: "unverifiable",
        summary: "要登录",
        handler: "secretary",
        pending: true,
      },
      "已上线 · 无法验证",
      "要登录 · 等 secretary 处理",
      "secretary",
    ],
    [
      { state: "unverifiable", handler: "u1", pending: true },
      "已上线 · 无法验证",
      "等 u1 处理",
      "user",
    ],
    // 旧记录：收件箱里没有事件。
    [{ state: "failed", summary: "旧的" }, "已上线 · 验证没过", "旧的", null],
  ];
  for (const [over, state, action, holder] of cases) {
    const v = view(over);
    assert.equal(verifyStateText(v), state);
    assert.equal(verifyActionText(v), action);
    assert.equal(verifyHolder(v)?.kind ?? null, holder, JSON.stringify(over));
  }
  assert.equal(verifyHolder(null), null);
  assert.equal(verifyHolder(view({ worker: null }))?.text, "验证中 · t9 在跑");
  assert.equal(
    verifyHolder(view({ state: "failed", handler: "a2", pending: true }))?.text,
    "验证没过 · 等 a2 处理",
  );
  assert.equal(verifyLine(view({})), "验证中（t9）");
  assert.equal(
    verifyLine(
      view({
        state: "failed",
        summary: "没显示",
        handler: "a2",
        pending: true,
      }),
    ),
    "验证没过（t9）：没显示 · 等 a2 处理",
  );
  assert.equal(verifyLine(view({ state: "passed" })), "验证通过（t9）");
});

test("已派人验证的「已上线」是知会；没派人的仍要处理；库里旧的按要处理存的行启动时回写", () => {
  assert.equal(eventLevel("online", { verifier: "t9" }), "info");
  assert.equal(eventLevel("online", {}), "action");
  assert.equal(eventLevel("online", { verifier: 9 }), "action");
  const db = new DatabaseSync(":memory:");
  ensureEventTables(db);
  const insert = db.prepare(
    "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,detail,created_at,updated_at,ready_at,level) VALUES ('secretary',?,'runner',?,?,?,1,1,1,'action')",
  );
  insert.run(1, "online", "t1:online", JSON.stringify({ verifier: "t9" }));
  insert.run(2, "online", "t2:online", JSON.stringify({ verification: "x" }));
  insert.run(3, "online", "t3:online", "坏的");
  insert.run(4, "done", "t4:outcome", JSON.stringify({ verifier: "t9" }));
  ensureEventTables(db);
  assert.deepEqual(
    (
      db
        .prepare("SELECT dedupe_key,level FROM task_inbox ORDER BY id")
        .all() as {
        dedupe_key: string;
        level: string;
      }[]
    ).map((row) => [row.dedupe_key, row.level]),
    [
      ["t1:online", "info"],
      ["t2:online", "action"],
      ["t3:online", "action"],
      ["t4:outcome", "action"],
    ],
  );
  const inbox = new EventInbox(db);
  assert.deepEqual(
    inbox.pending("secretary").map((e) => e.task),
    ["t2", "t3", "t4"],
  );
});

test("事件怎么读：leader 唤醒与 events 命令都逐条附现象和开修复任务的命令", () => {
  const detail = {
    title: "上线的活",
    ...verifyEventDetail({
      task: { ref: "t5", title: "上线的活", part_ref: "o2" },
      verifier: "t9",
      report: failing,
    }),
  };
  const lead = leaderEventLine({
    id: 3,
    task: "t5",
    kind: "verify_failed",
    count: 1,
    detail,
  });
  const lines = lead.split("\n");
  assert.match(
    lines[0]!,
    /^- #3 t5 上线验证没过 上线的活（验证任务 t9）：task show 没显示已上线$/,
  );
  assert.equal(
    lines[1],
    "  - [不符合] atrium task show t1 · 期望 [已上线] · 实际 t1 [已合入]",
  );
  assert.match(lines[2]!, /\[无法验证\] atrium task add x/);
  assert.match(lines[3]!, /atrium task add 修复标题 --part o2/);
  const cli = eventLine({
    id: 3,
    task: "t5",
    kind: "verify_failed",
    count: 1,
    delivered_at: null,
    acked_at: null,
    updated_at: Date.now(),
    detail,
  } as never);
  assert.match(cli, /· t5「上线的活」上线后没通过/);
  assert.match(cli, /\n {2}\[不符合\] atrium task show t1 · 期望 \[已上线\]/);
  assert.match(cli, /\n {2}要修就开修复任务/);
});

function memory() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureQueueTable(db);
  ensureEventTables(db);
  return db;
}

/** 账本里造一条已上线的任务，结束于很久以前（不因刚结束进看板）。 */
function shipped(db: DatabaseSync, title: string) {
  const task = createTask(db, { title, deliver: "none" });
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='online',updated_at=1,ended_at=1 WHERE id=?",
  ).run(task.id);
  return task;
}

test("看板与状态栏：验证中、没过的原任务列出来并计数，验证任务由原任务那一行代表；过了一天的不再列", () => {
  const db = memory();
  const now = Date.now();
  const running = shipped(db, "在验证的活");
  const runningVerifier = openVerify(db, {
    taskId: running.id,
    version: "0.1.9",
    steps: "跑 a",
  })!;
  advanceTask(
    db,
    runningVerifier,
    { kind: "start" },
    { worker: "opencode+opencode-go/deepseek-v4.1-flash" },
    undefined,
    now - 3 * 60_000,
  );
  const failed = shipped(db, "没过的活");
  const failedVerifier = openVerify(db, {
    taskId: failed.id,
    version: "0.1.9",
    steps: "跑 b",
  })!;
  const old = shipped(db, "很久前没过的");
  const oldVerifier = openVerify(db, {
    taskId: old.id,
    version: "0.1.8",
    steps: "跑 c",
  })!;
  const passed = shipped(db, "过了的活");
  const passedVerifier = openVerify(db, {
    taskId: passed.id,
    version: "0.1.9",
    steps: "跑 d",
  })!;
  // 无法验证只挂 1 小时（t255）；没通过的两小时前照样列。
  const unsure = shipped(db, "没法验的活");
  const unsureVerifier = openVerify(db, {
    taskId: unsure.id,
    version: "0.1.9",
    steps: "跑 e",
  })!;
  const staleUnsure = shipped(db, "早先没法验的");
  const staleUnsureVerifier = openVerify(db, {
    taskId: staleUnsure.id,
    version: "0.1.8",
    steps: "跑 f",
  })!;
  const lateFailed = shipped(db, "两小时前没过的");
  const lateFailedVerifier = openVerify(db, {
    taskId: lateFailed.id,
    version: "0.1.8",
    steps: "跑 g",
  })!;
  for (const ref of [
    failedVerifier,
    oldVerifier,
    passedVerifier,
    unsureVerifier,
    staleUnsureVerifier,
    lateFailedVerifier,
  ])
    db.prepare(
      "UPDATE tasks SET status='done',updated_at=1,ended_at=1 WHERE id=?",
    ).run(Number(ref.slice(1)));
  const decide = (ref: string, verdict: string, at: number) =>
    db
      .prepare(
        "UPDATE task_verifications SET verdict=?,summary='没显示已上线',decided_at=? WHERE verify_id=?",
      )
      .run(verdict, at, Number(ref.slice(1)));
  decide(failedVerifier, "failed", now - 60_000);
  decide(oldVerifier, "failed", now - 25 * 60 * 60_000);
  decide(passedVerifier, "passed", now - 60_000);
  decide(unsureVerifier, "unverifiable", now - 30 * 60_000);
  decide(staleUnsureVerifier, "unverifiable", now - 61 * 60_000);
  decide(lateFailedVerifier, "failed", now - 2 * 60 * 60_000);
  // 没过的事件已投给 a2、还没处理。
  new EventInbox(db).publish({
    subscriber: "a2",
    taskId: failed.id,
    source: "runner",
    kind: "verify_failed",
    key: `${failed.ref}:verify`,
    detail: {},
  });

  const { rows } = topRows(db, now);
  const byRef = new Map(rows.map((row) => [row.ref, row]));
  assert.equal(byRef.get(running.ref)?.verify?.state, "running");
  assert.equal(
    byRef.get(running.ref)?.holder?.text,
    `验证中 · ${runningVerifier} opencode+opencode-go/deepseek-v4.1-flash 在跑`,
  );
  assert.equal(byRef.get(runningVerifier)?.verify_of, running.ref);
  assert.equal(byRef.get(failed.ref)?.verify?.state, "failed");
  assert.equal(byRef.get(failed.ref)?.verify?.handler, "a2");
  assert.equal(byRef.get(failed.ref)?.holder?.kind, "leader");
  assert.ok(!byRef.has(old.ref), "过了一天的没过不再列");
  assert.ok(!byRef.has(passed.ref), "通过的按普通已结束任务处理");
  assert.equal(byRef.get(unsure.ref)?.verify?.state, "unverifiable");
  assert.ok(!byRef.has(staleUnsure.ref), "过了 1 小时的无法验证不再列");
  assert.equal(byRef.get(lateFailed.ref)?.verify?.state, "failed");
  const counts = countRows(rows);
  assert.equal(counts.verifying, 1);
  assert.equal(counts.verify_failed, 2);
  assert.equal(counts.unverifiable, 1);
  assert.equal(counts.online, undefined);
  // 验证没过和受阻排在一起，在刚结束的前面；无法验证不算出事，排在验证中的后面。
  const at = (ref: string) => rows.findIndex((row) => row.ref === ref);
  assert.ok(at(failed.ref) < at(running.ref));
  assert.ok(at(running.ref) < at(unsure.ref));

  const snapshot: Snapshot = {
    now,
    recent_ms: 0,
    subscriber: "secretary",
    counts: { ...counts, events: 0 },
    rows: rows as unknown as TopRow[],
    truncated: false,
  };
  const top = renderTop(snapshot, {
    width: 160,
    now,
    footer: false,
    color: false,
  });
  assert.match(top, /验证中 1 · 验证没过 2 · 无法验证 1/);
  // 无法验证用中性的 ?，不画 ✕（t255）。
  assert.match(top, new RegExp(`[?] ${unsure.ref} .*已上线 · 无法验证`));
  // 带颜色时和已结束的一样淡着画；验证没过照常醒目。
  const colored = renderTop(snapshot, {
    width: 160,
    now,
    footer: false,
    color: true,
  });
  assert.match(colored, new RegExp(`\\x1b\\[2m[?] ${unsure.ref} `));
  assert.match(colored, new RegExp(`^✕ ${failed.ref} `, "m"));
  assert.match(top, new RegExp(`● ${running.ref} .*已上线 · 验证中`));
  assert.match(
    top,
    new RegExp(
      `✕ ${failed.ref} .*已上线 · 验证没过 .*没显示已上线 · 等 a2 处理`,
    ),
  );
  const status = renderStatusline({
    snapshot: snapshot as never,
    plan: null,
    now,
    color: false,
  });
  assert.match(
    status,
    new RegExp(
      `● ${running.ref} 「在验证的活」 验证中 · opencode · deepseek-v4.1-flash 3m`,
    ),
  );
  assert.match(
    status,
    new RegExp(`◇ ${failed.ref} 「没过的活」 验证没过 · 等 a2 处理`),
  );
  assert.doesNotMatch(
    status,
    new RegExp(`${runningVerifier} `),
    "验证任务不单列",
  );
  assert.match(status, /在做 1 · leader 处理 1/);

  // 处理完（确认）后不再占状态栏，看板仍列、写已看过。
  const inbox = new EventInbox(db);
  inbox.ack(inbox.pending("a2").map((e) => e.id));
  const after = verifyViews(db, [failed.id]).get(failed.id)!;
  assert.equal(after.pending, false);
  assert.equal(verifyHolder(after), null);
  assert.equal(verifyActionText(after), "没显示已上线 · a2 已看过");
});

test("运行时：没通过投给归属部分的 leader，附现象、不带凭据；通过谁也不叫醒", async (t) => {
  const { call, data, taskRunner } = await startApp(t);
  for (const body of [
    { slug: "org", kind: "org", name: "组织", reason: "测试" },
    {
      parent: "o1",
      slug: "atrium",
      kind: "project",
      name: "Atrium",
      reason: "测试",
    },
  ])
    assert.equal((await call("POST", "/api/org/nodes", body)).status, 201);
  assert.equal(
    (
      await call("POST", "/api/leaders", {
        name: "Atrium 负责人",
        worker: "kimi",
      })
    ).status,
    201,
  );
  assert.equal(
    (await call("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "测试" }))
      .status,
    200,
  );
  const db = (taskRunner as unknown as { db: DatabaseSync }).db;
  const make = async (title: string) => {
    const ref = (
      await call("POST", "/api/tasks", { title, part: "o2", deliver: "none" })
    ).body.ref as string;
    const id = Number(ref.slice(1));
    db.prepare(
      "UPDATE tasks SET status='done',delivery_stage='online',updated_at=1,ended_at=1 WHERE id=?",
    ).run(id);
    const verifier = openVerify(db, {
      taskId: id,
      version: "0.1.9",
      steps: "跑",
    })!;
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(
      Number(verifier.slice(1)),
    );
    return { ref, id, verifier };
  };
  const write = (verifier: string, body: object) => {
    const file = verifyFileOf(data, Number(verifier.slice(1)));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  };
  const bad = await make("没过的活");
  write(bad.verifier, {
    verdict: "failed",
    summary: "没显示已上线",
    steps: [
      {
        command: "atrium task show t1",
        expected: "[已上线]",
        output: `t1 [已合入] GH_TOKEN=${TOKEN}`,
        matched: false,
      },
    ],
  });
  const good = await make("过了的活");
  write(good.verifier, {
    verdict: "passed",
    summary: "照着跑通",
    steps: [{ command: "a", expected: "b", output: "b", matched: true }],
  });
  await taskRunner.settleVerifications();
  // 巡检也可能先记下；两边只记一次、只投一次。
  assert.deepEqual(settleVerifications(db, data).outcomes, []);

  const inboxOf = async (as: string) =>
    (await call("GET", `/api/events?as=${as}`)).body.events as {
      kind: string;
      task: string;
      level: string;
      detail: Record<string, unknown>;
    }[];
  const leader = await inboxOf("a1");
  const event = leader.find((e) => e.kind === "verify_failed")!;
  assert.equal(event.task, bad.ref);
  assert.equal(event.level, "action");
  assert.equal((event.detail.routed as { to: string }).to, "a1");
  assert.equal(event.detail.verifier, bad.verifier);
  assert.equal(
    (event.detail.phenomena as { output: string }[])[0]!.output,
    "t1 [已合入] GH_TOKEN=***",
  );
  assert.doesNotMatch(JSON.stringify(leader), new RegExp(TOKEN));
  assert.ok(!leader.some((e) => e.task === good.ref));
  assert.ok(
    !(await inboxOf("secretary")).some((e) => e.kind.startsWith("verify_")),
  );

  const shown = (await call("GET", `/api/tasks/${bad.ref}`)).body;
  assert.equal(shown.verify.state, "failed");
  assert.equal(shown.verify.handler, "a1");
  assert.equal(shown.verify.pending, true);
  assert.equal(shown.holder.text, "验证没过 · 等 a1 处理");
  assert.equal(
    (await call("GET", `/api/tasks/${good.ref}`)).body.verify.state,
    "passed",
  );
  const top = (await call("GET", "/api/tasks/top")).body as {
    rows: { ref: string; verify: VerifyView | null }[];
    counts: { verify_failed?: number };
  };
  assert.equal(top.counts.verify_failed, 1);
  assert.equal(
    top.rows.find((row) => row.ref === bad.ref)?.verify?.state,
    "failed",
  );
});
