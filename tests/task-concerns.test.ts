import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  concernOutcome,
  concernSection,
  globRegex,
  inviteHints,
  parseReviewConclusion,
  reviewBrief,
  reviewConclusion,
  type Checklist,
  type ConcernState,
} from "../server/tasks/concern-gate.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import { addPoint } from "../server/org/points.ts";
import { parseDocument } from "../server/org/validate.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { advanceTask } from "../server/tasks/ledger.ts";
import { settleReviews } from "../server/tasks/concern-runtime.ts";
import { TaskRunner } from "../server/tasks/runner.ts";
import {
  concernsBrief,
  concernsText,
  hintLines,
} from "../cli/task-concerns.ts";
import { cliErrorMessage } from "../cli/error-message.ts";
import { startApp, until } from "./task-fixture.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { removeTemp } from "./temp-dir.ts";

// ---- 纯函数 ----

test("审查结论：以最后一行「结论：」为准，认加粗与中英文冒号，没写结论不当通过", () => {
  assert.deepEqual(parseReviewConclusion("看过了\n结论：通过"), {
    verdict: "pass",
    reason: "按清单审过，没有越过底线",
  });
  assert.deepEqual(
    parseReviewConclusion(
      "结论：否决：先写的\n改了主意\n**结论**: 通过，没碰凭据",
    ),
    { verdict: "pass", reason: "没碰凭据" },
  );
  assert.deepEqual(
    parseReviewConclusion("- 结论：否决：server/log.ts:12 把令牌写进日志"),
    { verdict: "veto", reason: "server/log.ts:12 把令牌写进日志" },
  );
  assert.equal(parseReviewConclusion("结论：不通过").verdict, "veto");
  assert.match(parseReviewConclusion("结论：否决").reason, /没写原因/);
  assert.equal(parseReviewConclusion("都挺好").verdict, "none");
  assert.equal(parseReviewConclusion("").verdict, "none");
  // 正文里提到「结论」但不在行首的不算
  assert.equal(
    parseReviewConclusion("我的结论：通过吧？不确定").verdict,
    "none",
  );
});

test("审查任务的去向：完成读摘要，失败取消受阻判没出结论，还在跑不判", () => {
  assert.equal(reviewConclusion("done", "结论：通过")?.verdict, "pass");
  assert.equal(reviewConclusion("done", null)?.verdict, "none");
  for (const status of ["failed", "cancelled", "blocked"])
    assert.equal(reviewConclusion(status, "结论：通过")?.verdict, "none");
  assert.match(
    reviewConclusion("blocked", null, "额度用尽")!.reason,
    /受阻：额度用尽/,
  );
  for (const status of ["todo", "running"])
    assert.equal(reviewConclusion(status, "结论：通过"), null);
});

const state = (
  name: string,
  verdict: ConcernState["verdict"],
  reason: string | null = null,
): ConcernState => ({
  ref: name === "安全" ? "o3" : "o4",
  name,
  review: name === "安全" ? "t2" : "t3",
  review_status: verdict === null ? "running" : "done",
  verdict,
  reason,
});

test("专员关卡合成：等齐再判；否决优先于没出结论；全部通过才通过", () => {
  assert.deepEqual(concernOutcome([]), { kind: "none" });
  const cases: [ConcernState[], string, RegExp][] = [
    [[state("安全", null)], "waiting", /等专员审查：安全（o3 · t2）/],
    [[state("安全", "veto", "漏了"), state("体验", null)], "waiting", /体验/],
    [[state("安全", "pass"), state("体验", "pass")], "passed", /安全.*体验/],
    [
      [state("安全", "veto", "令牌进日志"), state("体验", "pass")],
      "vetoed",
      /专员否决：安全（o3 · t2）：令牌进日志$/,
    ],
    [
      [state("安全", "veto", "令牌进日志"), state("体验", "none", "失败")],
      "vetoed",
      /另有没出结论的：体验/,
    ],
    [
      [state("安全", "pass"), state("体验", "none", "审查任务失败")],
      "incomplete",
      /没出结论：体验（o4 · t3）：审查任务失败/,
    ],
  ];
  for (const [list, kind, reason] of cases) {
    const outcome = concernOutcome(list);
    assert.equal(outcome.kind, kind);
    assert.match((outcome as { reason: string }).reason, reason);
  }
});

test("提示规则：路径通配对照改动文件，关键词对照标题详述与路径，已请的不提示", () => {
  assert.ok(globRegex("server/auth*").test("server/auth-policy.ts"));
  assert.ok(!globRegex("server/auth*").test("server/x/auth.ts"));
  assert.ok(globRegex("**/*.sql").test("a/b/c.sql"));
  assert.ok(globRegex("**/*.sql").test("c.sql"));
  assert.ok(globRegex("*.env").test("deep/dir/.x.env"));
  assert.ok(!globRegex("*.env").test("deep/env.ts"));
  const rules = [
    { ref: "o3", name: "安全", when: ["server/auth*", "凭据", "token"] },
    { ref: "o4", name: "体验", when: ["cli/**"] },
  ];
  assert.deepEqual(
    inviteHints(
      rules,
      { files: ["server/auth.ts", "cli/top.ts", "lib/token-store.ts"] },
      new Set(),
    ),
    [
      {
        ref: "o3",
        name: "安全",
        matched: [
          "server/auth.ts 命中 server/auth*",
          "lib/token-store.ts 含「token」",
        ],
      },
      { ref: "o4", name: "体验", matched: ["cli/top.ts 命中 cli/**"] },
    ],
  );
  assert.deepEqual(
    inviteHints(rules, { text: "把 Token 与凭据挪到钥匙串" }, new Set(["o4"])),
    [{ ref: "o3", name: "安全", matched: ["提到「凭据」", "提到「token」"] }],
  );
  assert.deepEqual(
    inviteHints(rules, { files: ["server/auth.ts"] }, new Set(["o3"])),
    [],
  );
});

const checklist: Checklist = {
  ref: "o3",
  name: "安全",
  goal: "守住凭据与对外公开",
  points: [{ ref: "k1", text: "报错回显的令牌要抹掉", why: "日志会被转发" }],
  bottom: ["凭据不进日志、提交与 PR"],
};

test("提示词：执行者拿到检查要点与底线；审查任务拿到审什么、按什么、怎么交结论", () => {
  assert.equal(concernSection([]), undefined);
  const section = concernSection([
    checklist,
    { ref: "o4", name: "体验", goal: "", points: [], bottom: [] },
  ])!;
  assert.match(section, /### 安全（o3）——守住凭据与对外公开/);
  assert.match(section, /- 报错回显的令牌要抹掉（k1；为什么：日志会被转发）/);
  assert.match(section, /底线（越过即否决）：\n- 凭据不进日志、提交与 PR/);
  assert.match(section, /### 体验（o4）\n检查要点：未写，按专员章程目标审/);
  assert.ok(
    Array.from(
      concernSection([
        {
          ...checklist,
          points: Array.from({ length: 30 }, (_, i) => ({
            ref: `k${i}`,
            text: "长".repeat(190),
            why: "因".repeat(200),
          })),
        },
      ])!,
    ).length <= 3000,
  );
  const brief = reviewBrief({
    checklist,
    task: { ref: "t1", title: "改登录" },
    pr_url: "https://github.com/o/r/pull/9",
    worktree: "/w/t1",
    branch: "task-t1",
    base: "main",
    diff: { files: 1, added: 3, removed: 1, list: ["server/auth.ts（+3 −1）"] },
  });
  assert.match(brief, /只审不改/);
  assert.match(brief, /PR：https:\/\/github.com\/o\/r\/pull\/9/);
  assert.match(brief, /git -C \/w\/t1 diff origin\/main\.\.\.HEAD/);
  assert.match(brief, /server\/auth\.ts（\+3 −1）/);
  assert.match(brief, /结论：否决：<越过了哪条底线或要点、在哪里>/);
});

test("命令行写法：请了谁与各自结论，提示给出请的命令", () => {
  const list = [
    state("安全", "veto", "令牌进日志"),
    { ...state("体验", null), review: null, review_status: null },
  ];
  assert.equal(
    concernsText(list),
    "安全（o3 · t2）：否决：令牌进日志；体验（o4）：已请，交付后审",
  );
  assert.equal(concernsBrief(list), "专员：安全 否决 · 体验 已请");
  assert.equal(concernsText([]), null);
  assert.deepEqual(
    hintLines(
      {
        ref: "t5",
        concern_hints: [{ ref: "o3", name: "安全", matched: ["提到「凭据」"] }],
      },
      true,
    ),
    [
      "提示：可能要请「安全」专员（提到「凭据」）",
      "要请：atrium task set t5 --ask o3，再 atrium task run t5",
    ],
  );
});

// ---- 账本 ----

const SAFETY_CHARTER = `---
goal: "守住凭据与对外公开"
invite_when: ["server/auth*", "凭据"]
boundaries:
  - id: no-secret
    summary: 凭据不进日志、提交与 PR
---
安全专员：凭据、对外公开、权限。
`;

/** 组织 o1；Atrium o2（挂 repo）下 runtime o3、安全 o4（章程带提示规则与底线、一条要点）、体验 o5。 */
function seed(db: DatabaseSync, repo: string) {
  ensureOrgTables(db);
  const node = (input: Record<string, unknown>) =>
    addNode(db, { reason: "创建", ...input } as never, "u1");
  node({ slug: "org", kind: "org", name: "组织" });
  node({
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    repos: [repo],
  });
  node({ parent: "o2", slug: "runtime", kind: "module", name: "runtime" });
  node({ parent: "o2", slug: "安全", kind: "concern", name: "安全" });
  node({ parent: "o2", slug: "体验", kind: "concern", name: "体验" });
  editDoc(
    db,
    "o4",
    "charter",
    { ...parseDocument(SAFETY_CHARTER, "charter"), reason: "写章程" },
    "u1",
  );
  addPoint(
    db,
    "o4",
    { text: "报错回显的令牌要抹掉", why: "日志会被转发", by: "u1 09-27" },
    "u1",
  );
}

function ledger() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  seed(db, "/repo/atrium");
  return db;
}

test("task add/set --concern：只认关注点节点，去重，至多 5 位，执行中不能改；读回带结论", () => {
  const db = ledger();
  const task = createTask(db, { title: "改日志", concern: "安全，体验、安全" });
  assert.deepEqual(
    task.concerns?.map((c) => [c.ref, c.name, c.verdict]),
    [
      ["o4", "安全", null],
      ["o5", "体验", null],
    ],
  );
  assert.throws(
    () => createTask(db, { title: "x", concern: "runtime" }),
    /concern: 只能请关注点（专员）节点，o3 runtime 不是/,
  );
  // 命令行原样透出中文原因，参数名换成 --concern
  try {
    createTask(db, { title: "x", concern: "o3" });
  } catch (error) {
    assert.equal(
      cliErrorMessage((error as Error).message, {
        options: { concern: { type: "string" } },
      } as never),
      "--concern：只能请关注点（专员）节点，o3 runtime 不是",
    );
  }
  assert.throws(
    () => createTask(db, { title: "x", concern: "不存在" }),
    /concern: 节点 不存在 不存在/,
  );
  assert.throws(
    () => createTask(db, { title: "x", concern: 7 }),
    /concern: 应为专员名称或 rN/,
  );
  assert.throws(
    () => createTask(db, { title: "x", concern: "o4,o5,o4,o5,o4,o5" }),
    /至多请 5 位专员/,
  );
  // 改成只请体验：安全那行删掉，记一条 concerns 事件
  const changed = updateTask(db, task.ref, { concern: "体验" });
  assert.deepEqual(
    changed.concerns?.map((c) => c.ref),
    ["o5"],
  );
  assert.ok(
    getTask(db, task.ref).events.some(
      (e) => e.kind === "concerns" && e.detail?.includes('"to":["o5"]'),
    ),
  );
  assert.equal(updateTask(db, task.ref, { concern: "" }).concerns, undefined);
  advanceTask(db, task.ref, { kind: "start" });
  assert.throws(
    () => updateTask(db, task.ref, { concern: "安全" }),
    /执行中不能改请的专员/,
  );
});

test("建任务时按标题关键词提示要不要请专员，只提示不请", () => {
  const db = ledger();
  const task = createTask(db, { title: "把凭据挪进钥匙串" });
  assert.equal(task.concerns, undefined);
  assert.deepEqual(task.concern_hints, [
    { ref: "o4", name: "安全", matched: ["提到「凭据」"] },
  ]);
  assert.equal(
    createTask(db, { title: "把凭据挪进钥匙串", concern: "安全" })
      .concern_hints,
    undefined,
  );
  assert.throws(
    () =>
      editDoc(
        db,
        "o5",
        "charter",
        {
          fields: { invite_when: "cli/**" },
          body: "",
          reason: "x",
        },
        "u1",
      ),
    /charter.invite_when 应为文本列表/,
  );
});

test("专员结论补判：人工改过状态的父任务不动；重跑审查后结论跟着更新", () => {
  const db = ledger();
  const parent = createTask(db, { title: "父", concern: "安全" });
  // 运行时建的专员审查是帮手子任务（t190），不让父任务变成总任务。
  const review = createTask(
    db,
    { title: "审", parent: parent.ref, deliver: "none" },
    undefined,
    undefined,
    { helper: true },
  );
  db.prepare("UPDATE task_concerns SET review_id=? WHERE task_id=?").run(
    review.id,
    parent.id,
  );
  advanceTask(db, parent.ref, { kind: "start" });
  advanceTask(db, parent.ref, { kind: "block" }, {}, { reason: "等专员审查" });
  advanceTask(db, review.ref, { kind: "start" });
  advanceTask(
    db,
    review.ref,
    { kind: "exit_fail" },
    {},
    { reason: "退出码 1" },
  );
  const first = settleReviews(db);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.outcome.kind, "incomplete");
  assert.match(first[0]!.outcome.reason, /审查任务失败：退出码 1/);
  assert.equal(getTask(db, parent.ref).status, "blocked");
  // 同一结论不重复记
  assert.equal(settleReviews(db).length, 0);
  // 重跑审查，这次通过：父任务补判完成
  advanceTask(db, review.ref, { kind: "start" }, {}, undefined, Date.now() + 5);
  advanceTask(
    db,
    review.ref,
    { kind: "exit_ok" },
    { result: "结论：通过" },
    undefined,
    Date.now() + 10,
  );
  const second = settleReviews(db);
  assert.equal(second[0]?.accepted, true);
  assert.equal(getTask(db, parent.ref).status, "done");
  assert.equal(getTask(db, parent.ref).concerns?.[0]?.verdict, "pass");
  // 父任务人工取消后，审查结论只记账不补判
  const other = createTask(db, { title: "父2", concern: "安全" });
  const review2 = createTask(
    db,
    { title: "审2", parent: other.ref, deliver: "none" },
    undefined,
    undefined,
    { helper: true },
  );
  db.prepare("UPDATE task_concerns SET review_id=? WHERE task_id=?").run(
    review2.id,
    other.id,
  );
  updateTask(db, other.ref, { status: "cancelled" });
  advanceTask(db, review2.ref, { kind: "start" });
  advanceTask(
    db,
    review2.ref,
    { kind: "exit_ok" },
    { result: "结论：否决：x" },
  );
  assert.equal(settleReviews(db).length, 0);
  assert.equal(getTask(db, other.ref).status, "cancelled");
  assert.equal(getTask(db, other.ref).concerns?.[0]?.verdict, "veto");
});

for (const trusted of [true, false])
  test(`专员关卡通过后才去合入：${trusted ? "可信执行者投 merge_queued" : "trust 不明先投 review_queued"}，不先投 done`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "atrium-concern-merge-"));
    t.after(() => removeTemp(root));
    const db = ledger();
    const parent = createTask(db, {
      title: "父",
      concern: "安全",
      repo: "/repo/atrium",
    });
    const review = createTask(
      db,
      { title: "审", parent: parent.ref, deliver: "none" },
      undefined,
      undefined,
      { helper: true },
    );
    db.prepare("UPDATE task_concerns SET review_id=? WHERE task_id=?").run(
      review.id,
      parent.id,
    );
    advanceTask(db, parent.ref, { kind: "start" });
    advanceTask(
      db,
      parent.ref,
      { kind: "block" },
      { pr_url: "https://github.com/o/r/pull/9" },
      { reason: "等专员审查" },
    );
    advanceTask(db, review.ref, { kind: "start" });
    advanceTask(db, review.ref, { kind: "exit_ok" }, { result: "结论：通过" });
    // 专员通过后再按风险分档（#325）：可信、低风险直接进合入队列，trust 低的先审阅。
    mkdirSync(join(root, "workers", "harness"), { recursive: true });
    writeFileSync(
      join(root, "workers", "harness", "kimi.md"),
      `---\ntrust: ${trusted ? "medium" : "low"}\n---\n`,
    );
    db.prepare("UPDATE tasks SET worker='kimi' WHERE id=?").run(parent.id);
    const runner = new TaskRunner(db, {
      data: root,
      workersDir: join(root, "workers"),
      env: { PATH: "/usr/bin:/bin" },
      exec: async () => {
        throw new Error("测试不联网");
      },
    });
    t.after(() => runner.close());
    await runner.settleReviews();
    const task = getTask(db, parent.ref);
    // 测试机上没有可挑的审阅者，trust 低的随后转受阻（review_blocked），这里只看去向。
    if (trusted) assert.equal(task.status, "done");
    const next = trusted ? "merge_queued" : "review_needed";
    // 入队后队列立刻开始处理，阶段可能已到 merging；以账本事件为准
    assert.ok(task.events.some((e) => e.kind === next));
    const kinds = (
      db
        .prepare("SELECT kind FROM task_inbox WHERE task_id=? ORDER BY id")
        .all(parent.id) as { kind: string }[]
    ).map((e) => e.kind);
    assert.ok(kinds.includes(trusted ? "merge_queued" : "review_queued"));
    assert.ok(!kinds.includes("done"));
  });

// ---- 隔离服务：请了安全专员的任务，通过与否决各一次 ----

/**
 * 假 claude 当专员：读提示词第一行（标题），是专员审查就按标记文件给结论，否则当普通执行者直接完成。
 * 流式输入时第一行是整段提示词的 JSON 消息，同样含标题。
 */
const FAKE_REVIEWER = `IFS= read -r first
case "$first" in
  *专员审查*)
    echo "逐条看过要点 k1 与底线。"
    if [ -f "$HOME/sloppy" ]; then rm -f "$HOME/sloppy"; echo "看起来没问题"; exit 0; fi
    if [ -f "$HOME/veto" ]; then echo "结论：否决：server/log.ts 把令牌写进日志"; else echo "结论：通过"; fi ;;
  *) echo "普通任务完成" ;;
esac`;

test("隔离服务：请了安全专员的任务交付后派审查任务，通过即完成；否决交 leader 判断、可放行；没写结论先补答", async (t) => {
  let veto = "";
  let sloppy = "";
  const { fx, data, call } = await startApp(t, (fx) => {
    veto = join(fx.env.HOME, "veto");
    sloppy = join(fx.env.HOME, "sloppy");
    writeFakeBin(
      join(fx.root, "bin", "claude"),
      `#!/bin/sh\n${FAKE_REVIEWER}\n`,
    );
    mkdirSync(join(fx.root, "data"), { recursive: true });
    const db = new DatabaseSync(join(fx.root, "data", "atrium.sqlite"));
    ensureTaskTables(db);
    seed(db, fx.repo);
    db.close();
  });
  const open = () => new DatabaseSync(join(data, "atrium.sqlite"));

  const added = await call("POST", "/api/tasks", {
    title: "改登录日志",
    repo: fx.repo,
    ask: "安全",
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.concerns[0].name, "安全");
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "opencode" })).status,
    200,
  );
  // task wait 等到专员出结论才返回
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(waited.body.timed_out, false);
  assert.equal(waited.body.task.status, "done", JSON.stringify(waited.body));
  const passed = (await call("GET", "/api/tasks/t1")).body;
  assert.deepEqual(
    passed.concerns.map((c: ConcernState) => [c.name, c.review, c.verdict]),
    [["安全", "t2", "pass"]],
  );
  const kinds = passed.events.map((e: { kind: string }) => e.kind);
  for (const kind of [
    "gates",
    "block",
    "concern_review_started",
    "concern_review",
    "concern_gate",
    "accept",
  ])
    assert.ok(kinds.includes(kind), `缺事件 ${kind}：${kinds.join(",")}`);
  // 执行者提示词附了检查要点与底线；审查任务提示词带清单、工作树与结论写法
  const prompt = readFileSync(join(data, "tasks", "1", "prompt.md"), "utf8");
  assert.match(prompt, /## 请了的专员与检查要点/);
  assert.match(prompt, /报错回显的令牌要抹掉（k/);
  assert.match(prompt, /底线（越过即否决）：\n- 凭据不进日志、提交与 PR/);
  const reviewTask = (await call("GET", "/api/tasks/t2")).body;
  assert.equal(reviewTask.parent_ref, "t1");
  assert.equal(reviewTask.job_ref, "r1");
  assert.equal(reviewTask.deliver, "none");
  const reviewPrompt = readFileSync(
    join(data, "tasks", "2", "prompt.md"),
    "utf8",
  );
  assert.match(reviewPrompt, /# 任务：专员审查：安全 · t1 改登录日志/);
  assert.ok(reviewPrompt.includes(`工作树：${passed.worktree}`), reviewPrompt);
  assert.match(reviewPrompt, /结论：通过/);

  // 否决：同样的任务，专员给出否决
  writeFileSync(veto, "1");
  await call("POST", "/api/tasks", {
    title: "再改登录日志",
    repo: fx.repo,
    ask: "安全",
  });
  await call("POST", "/api/tasks/t3/run", { worker: "opencode" });
  const vetoed = await call("GET", "/api/tasks/t3/wait?timeout=20");
  assert.equal(vetoed.body.task.status, "blocked", JSON.stringify(vetoed.body));
  const shown = (await call("GET", "/api/tasks/t3")).body;
  assert.equal(shown.concerns[0].verdict, "veto");
  assert.match(shown.concerns[0].reason, /server\/log\.ts 把令牌写进日志/);
  const top = (await call("GET", "/api/tasks/top")).body;
  const row = top.rows.find((r: { ref: string }) => r.ref === "t3");
  assert.match(
    row.reason,
    /专员否决：安全（r1 · t4）：server\/log\.ts 把令牌写进日志/,
  );
  assert.equal(row.concerns[0].verdict, "veto");
  // 负责人收到否决：blocked 事件带原因与专员结论；审查任务本身不单独投递
  const db = open();
  await until(() => {
    const events = db
      .prepare(
        "SELECT task_id,kind,detail FROM task_inbox WHERE kind IN ('done','blocked')",
      )
      .all() as { task_id: number; kind: string; detail: string }[];
    return events.some((e) => e.task_id === 3 && e.kind === "blocked");
  });
  const events = db
    .prepare(
      "SELECT task_id,kind,detail FROM task_inbox WHERE kind IN ('done','blocked') ORDER BY id",
    )
    .all() as { task_id: number; kind: string; detail: string }[];
  db.close();
  assert.deepEqual(
    events.map((e) => [e.task_id, e.kind]),
    [
      [1, "done"],
      [3, "blocked"],
    ],
  );
  assert.match(events[1]!.detail, /"vetoed":true/);
  // 否决交负责的 leader 判断：下一步给出打回与放行两条路
  assert.match(events[1]!.detail, /交你判断[^"]*atrium task merge t3/);

  // leader 不认同否决：task merge 放行，照专员通过后的路走审阅或合入
  const merged = await call("POST", "/api/tasks/t3/merge?as=a1");
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  const overruled = (await call("GET", "/api/tasks/t3")).body;
  const overruledKinds = overruled.events.map((e: { kind: string }) => e.kind);
  assert.ok(
    overruledKinds.includes("concern_overruled"),
    overruledKinds.join(),
  );
  assert.ok(overruledKinds.includes("accept"), overruledKinds.join());
  // 与专员通过后同一条路：这里的假仓库没有 PR，直接完成
  assert.equal(overruled.status, "done");
  // 不在专员关卡上受阻的（比如已放行的）不能再借 task merge 放行
  const again = await call("POST", "/api/tasks/t3/merge?as=a1");
  assert.equal(again.status, 409, JSON.stringify(again.body));

  // 专员最后一行没按格式写结论：同一审查任务补答一次，不当没结论卡住
  rmSync(veto);
  writeFileSync(sloppy, "1");
  await call("POST", "/api/tasks", {
    title: "三改登录日志",
    repo: fx.repo,
    ask: "安全",
  });
  await call("POST", "/api/tasks/t5/run", { worker: "opencode" });
  const redone = await call("GET", "/api/tasks/t5/wait?timeout=30");
  assert.equal(redone.body.task.status, "done", JSON.stringify(redone.body));
  const review = (await call("GET", "/api/tasks/t6")).body;
  const reviewKinds = review.events.map((e: { kind: string }) => e.kind);
  assert.ok(reviewKinds.includes("conclusion_asked"), reviewKinds.join());
  assert.equal(
    reviewKinds.filter((kind: string) => kind === "exit_ok").length,
    1,
    "补答后只收尾一次",
  );
  const asked = review.events
    .filter((e: { kind: string }) => e.kind === "tell")
    .map((e: { detail: string }) => JSON.parse(e.detail));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].by, "运行时");
  assert.equal(asked[0].state, "delivered");
  assert.match(asked[0].text, /`结论：通过` 或 `结论：否决：/);
  assert.equal(
    (await call("GET", "/api/tasks/t5")).body.concerns[0].verdict,
    "pass",
  );
});
