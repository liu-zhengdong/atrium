import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
  councilOutcome,
  opinionBrief,
  opinionOf,
  opinionsReady,
  parseOpinion,
  parseSummary,
  summaryBrief,
  type MemberOpinion,
  type Topic,
} from "../server/tasks/council-gate.ts";
import {
  councilView,
  createCouncil,
  decideCouncil,
  isCouncilTask,
  isOpinionTask,
  type CouncilView,
} from "../server/tasks/councils.ts";
import { settleCouncils } from "../server/tasks/council-runtime.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import { addPoint } from "../server/org/points.ts";
import { parseDocument } from "../server/org/validate.ts";
import {
  advanceTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { renderCouncil } from "../cli/reviews.ts";
import { cliErrorMessage } from "../cli/error-message.ts";
import { commands } from "../cli/main.ts";
import { startApp, until } from "./task-fixture.ts";

// ---- 纯函数 ----

test("专员意见：以最后一行「意见：」为准，四种立场，没写意见不当同意", () => {
  assert.deepEqual(parseOpinion("看过\n意见：同意"), {
    stance: "agree",
    reason: "",
  });
  assert.deepEqual(
    parseOpinion("意见：反对：先写的\n**意见**: 有条件同意：补测试"),
    {
      stance: "conditional",
      reason: "补测试",
    },
  );
  assert.deepEqual(parseOpinion("- 意见：有条件：先备份"), {
    stance: "conditional",
    reason: "先备份",
  });
  assert.deepEqual(parseOpinion("意见：否决：凭据会进公开历史"), {
    stance: "veto",
    reason: "凭据会进公开历史",
  });
  assert.match(parseOpinion("意见：反对").reason, /没写原因/);
  assert.equal(parseOpinion("我的意见：同意吧").stance, "none");
  assert.equal(parseOpinion("").stance, "none");
});

test("意见任务的去向：完成读摘要，失败取消受阻判没出意见，还在跑不判", () => {
  assert.equal(opinionOf("done", "意见：同意")?.stance, "agree");
  assert.equal(opinionOf("done", null)?.stance, "none");
  for (const status of ["failed", "cancelled", "blocked"])
    assert.equal(opinionOf(status, "意见：同意")?.stance, "none");
  assert.match(opinionOf("failed", null, "退出码 1")!.reason, /失败：退出码 1/);
  for (const status of ["todo", "running"])
    assert.equal(opinionOf(status, "意见：同意"), null);
});

test("意见收齐：都不再跑且不在收尾或排队才算齐；没有成员不算齐", () => {
  const m = (status: string, busy = false) => ({ status, busy });
  assert.equal(opinionsReady([]), false);
  assert.equal(opinionsReady([m("done"), m("running")]), false);
  assert.equal(opinionsReady([m("done"), m("todo")]), false);
  assert.equal(opinionsReady([m("done"), m("done", true)]), false);
  assert.equal(
    opinionsReady([m("done"), m("failed"), m("blocked"), m("cancelled")]),
    true,
  );
});

test("leader 汇总：分出一致、冲突、需用户拍板与结论；「需用户拍板：无」不算", () => {
  const summary = parseSummary(
    [
      "## 一致",
      "- 先清理凭据",
      "- 无",
      "## 冲突",
      "- 安全要求等审计，质量认为可以先发：取质量，审计并行",
      "## 其他",
      "- 不收",
      "需用户拍板：无",
      "**需用户拍板**：是否本周公开（A 本周 / B 下周）",
      "结论：先写的",
      "结论：下周公开，本周清理凭据",
    ].join("\n"),
  );
  assert.deepEqual(summary, {
    agreed: ["先清理凭据"],
    conflicts: ["安全要求等审计，质量认为可以先发：取质量，审计并行"],
    escalate: ["是否本周公开（A 本周 / B 下周）"],
    conclusion: "下周公开，本周清理凭据",
  });
  assert.deepEqual(parseSummary("都挺好"), {
    agreed: [],
    conflicts: [],
    escalate: [],
    conclusion: null,
  });
});

const member = (
  name: string,
  stance: MemberOpinion["stance"],
  reason = "",
): MemberOpinion => ({ ref: "o4", name, task: "t2", stance, reason });

test("会审结局：leader 能定的定；没写结论、都没出意见、底线否决没上交的，运行时补上交", () => {
  const summary = (conclusion: string | null, escalate: string[] = []) => ({
    agreed: [],
    conflicts: [],
    escalate,
    conclusion,
  });
  assert.deepEqual(
    councilOutcome(summary("照做"), [
      member("安全", "agree"),
      member("质量", "oppose", "测试不够"),
    ]),
    { kind: "decided", conclusion: "照做", escalate: [] },
  );
  assert.deepEqual(
    councilOutcome(summary("照做", ["要不要花钱"]), [member("安全", "agree")]),
    { kind: "escalated", conclusion: "照做", escalate: ["要不要花钱"] },
  );
  const noConclusion = councilOutcome(summary(null), [member("安全", "agree")]);
  assert.equal(noConclusion.kind, "escalated");
  assert.match(noConclusion.escalate[0]!, /没写「结论：」/);
  assert.match(
    councilOutcome(summary("照做"), [member("安全", "none")]).escalate.join(),
    /都没出意见/,
  );
  const vetoed = councilOutcome(summary("照做"), [
    member("安全", "veto", "凭据进公开历史"),
  ]);
  assert.equal(vetoed.kind, "escalated");
  assert.match(
    vetoed.escalate[0]!,
    /安全（o4 · t2）以底线否决：凭据进公开历史；专员否决不能由 leader 自行推翻/,
  );
  // leader 已经把否决上交了，不再重复补
  assert.deepEqual(
    councilOutcome(summary("先不公开", ["安全否决：是否仍要公开"]), [
      member("安全", "veto", "凭据"),
    ]).escalate,
    ["安全否决：是否仍要公开"],
  );
});

const topic: Topic = {
  ref: "t1",
  topic: "公开仓库",
  brief: "把 atrium 仓库改为公开。",
  brief_path: "/b/议题.md",
  issue: 322,
  repo: "/repo/atrium",
  leader: "秘书",
  concerns: [
    { ref: "o4", name: "安全" },
    { ref: "o5", name: "质量" },
  ],
};

test("提示词：专员拿到议题、清单与立场写法；leader 拿到各方意见原文与汇总格式", () => {
  const brief = opinionBrief(topic, {
    ref: "o4",
    name: "安全",
    goal: "守住凭据与对外公开",
    points: [{ ref: "k1", text: "报错回显的令牌要抹掉", why: "日志会被转发" }],
    bottom: ["凭据不进日志、提交与 PR"],
  });
  assert.match(brief, /^# 会审意见：安全 · 公开仓库/);
  assert.match(brief, /只出意见不动手/);
  assert.match(brief, /受邀专员：安全（o4）、质量（o5）/);
  assert.match(brief, /关联 issue：#322/);
  assert.match(
    brief,
    /### 议题详述（\/b\/议题\.md）\n\n把 atrium 仓库改为公开。/,
  );
  assert.match(brief, /底线（越过即可否决）：\n- 凭据不进日志、提交与 PR/);
  assert.match(brief, /`意见：否决：<越过了哪条底线>`/);
  const summary = summaryBrief(
    topic,
    [
      { ...member("安全", "agree"), text: "没问题\n意见：同意" },
      { ...member("质量", "none", "意见任务失败"), ref: "o5", text: null },
    ],
    true,
  );
  assert.match(summary, /^# 会审汇总：公开仓库/);
  assert.match(summary, /### 安全（o4 · t2）：同意\n\n没问题\n意见：同意/);
  assert.match(
    summary,
    /### 质量（o5 · t2）：没出意见——意见任务失败\n\n（没有意见原文）/,
  );
  assert.match(summary, /需用户拍板：<要用户定什么/);
  assert.match(summary, /作为一条评论发到 issue #322/);
  assert.doesNotMatch(summaryBrief(topic, [], false), /评论发到 issue/);
});

// ---- 账本 ----

const CHARTER = (goal: string, bottom?: string) => `---
goal: "${goal}"
${bottom ? `boundaries:\n  - id: b1\n    summary: ${bottom}\n` : ""}---
专员。
`;

/** 组织 o1；Atrium o2（挂 repo）下 runtime o3，关注点 安全 o4、质量 o5、体验 o6。 */
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
  node({ parent: "o2", slug: "质量", kind: "concern", name: "质量" });
  node({ parent: "o2", slug: "体验", kind: "concern", name: "体验" });
  editDoc(
    db,
    "o4",
    "charter",
    {
      ...parseDocument(
        CHARTER("守住凭据与对外公开", "凭据不进日志、提交与 PR"),
        "charter",
      ),
      reason: "写章程",
    },
    "u1",
  );
  editDoc(
    db,
    "o5",
    "charter",
    {
      ...parseDocument(CHARTER("改动有测试兜底"), "charter"),
      reason: "写章程",
    },
    "u1",
  );
  addPoint(
    db,
    "o4",
    { text: "报错回显的令牌要抹掉", why: "日志会被转发", by: "u1 09-27" },
    "u1",
  );
}

function ledger(t: { after: (fn: () => void) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-council-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  seed(db, "/repo/atrium");
  return { db, data };
}

test("review add：校验议题与专员；建议题任务与每位专员的意见子任务，详述写进议题目录", (t) => {
  const { db, data } = ledger(t);
  assert.throws(
    () => createCouncil(db, data, { topic: " ", concerns: "安全" }),
    /topic: 议题不能为空/,
  );
  assert.throws(
    () => createCouncil(db, data, { topic: "x" }),
    /concerns: 至少请一位专员/,
  );
  // 字段名换成 concerns，命令行显示 --concerns
  try {
    createCouncil(db, data, { topic: "x", concerns: "runtime" });
    assert.fail("应报错");
  } catch (error) {
    assert.equal(
      cliErrorMessage((error as Error).message, commands["review add"]),
      "--concerns：只能请关注点（专员）节点，o3 runtime 不是",
    );
  }
  assert.throws(
    () =>
      createCouncil(db, data, { topic: "x", concerns: "安全", comment: true }),
    /comment: 同步为 issue 评论需同时给 issue/,
  );
  assert.throws(
    () =>
      createCouncil(db, data, {
        topic: "x",
        concerns: "安全",
        leader: "不存在",
      }),
    /leader: 节点 不存在 不存在/,
  );
  assert.throws(
    () => createCouncil(db, data, { topic: "x", concerns: "安全", extra: 1 }),
    /extra/,
  );
  // 校验失败不留下半截任务
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
    0,
  );
  const { council, opinions } = createCouncil(db, data, {
    topic: "公开仓库",
    concerns: "安全,质量",
    leader: "atrium",
    issue: 322,
  });
  assert.equal(council.ref, "t1");
  assert.equal(council.stage, "opinions");
  assert.deepEqual(council.leader, { ref: "o2", name: "Atrium" });
  assert.deepEqual(opinions, ["t2", "t3"]);
  const parent = getTask(db, "t1");
  assert.equal(parent.title, "会审：公开仓库");
  assert.equal(parent.deliver, "none");
  assert.equal(parent.node_ref, "o2");
  assert.ok(isCouncilTask(db, 1) && !isOpinionTask(db, 1));
  const child = getTask(db, "t2");
  assert.equal(child.parent_ref, "t1");
  assert.equal(child.node_ref, "o4");
  assert.equal(child.deliver, "none");
  assert.ok(isOpinionTask(db, 2));
  const brief = readFileSync(child.brief_path!, "utf8");
  assert.match(brief, /会审意见：安全 · 公开仓库/);
  assert.match(brief, /受邀专员：安全（o4）、质量（o5）/);
  assert.match(brief, /汇总与拍板：Atrium（o2）的 leader/);
  assert.match(brief, /报错回显的令牌要抹掉（k1/);
  assert.ok(getTask(db, "t1").events.some((e) => e.kind === "council_opened"));
});

test("会审推进：意见收齐才交汇总；汇总完成记结论；底线否决上交用户，拍板后转已定", (t) => {
  const { db, data } = ledger(t);
  createCouncil(db, data, { topic: "归档旧代码", concerns: "安全,质量" });
  const finish = (ref: string, result: string) => {
    advanceTask(db, ref, { kind: "start" });
    advanceTask(db, ref, { kind: "exit_ok" }, { result });
  };
  // 只出了一份：不推进
  finish("t2", "凭据已清理\n意见：否决：旧分支里有令牌");
  assert.deepEqual(settleCouncils(db, data), { dispatch: [], decided: [] });
  // 在收尾的不算齐
  advanceTask(db, "t3", { kind: "start" });
  advanceTask(db, "t3", { kind: "exit_fail" }, {}, { reason: "退出码 1" });
  assert.deepEqual(settleCouncils(db, data, (id) => id === 3).dispatch, []);
  const progress = settleCouncils(db, data);
  assert.deepEqual(progress.dispatch, ["t1"]);
  assert.equal(councilView(db, "t1").stage, "summarizing");
  const brief = readFileSync(getTask(db, "t1").brief_path!, "utf8");
  assert.match(
    brief,
    /### 安全（o4 · t2）：否决——旧分支里有令牌\n\n凭据已清理/,
  );
  assert.match(brief, /### 质量（o5 · t3）：没出意见——意见任务失败：退出码 1/);
  // 汇总还是待办（服务重启、拉起前退出）：下一轮再交一次
  assert.deepEqual(settleCouncils(db, data).dispatch, ["t1"]);
  assert.deepEqual(settleCouncils(db, data, (id) => id === 1).dispatch, []);
  finish(
    "t1",
    "## 一致\n- 旧代码可以归档\n## 冲突\n- 质量没出意见\n结论：归档到 legacy 分支",
  );
  const done = settleCouncils(db, data);
  assert.equal(done.decided.length, 1);
  assert.equal(done.decided[0]!.outcome.kind, "escalated");
  const view = councilView(db, "t1");
  assert.equal(view.stage, "escalated");
  assert.equal(view.conclusion, "归档到 legacy 分支");
  assert.deepEqual(view.agreed, ["旧代码可以归档"]);
  assert.match(view.escalate[0]!, /安全（o4 · t2）以底线否决：旧分支里有令牌/);
  assert.deepEqual(
    view.opinions.map((o) => [o.name, o.stance]),
    [
      ["安全", "veto"],
      ["质量", "none"],
    ],
  );
  // 已出结局的不再重复
  assert.deepEqual(settleCouncils(db, data), { dispatch: [], decided: [] });
  const decided = decideCouncil(
    db,
    "t1",
    { conclusion: "先清令牌再归档" },
    "u1",
  );
  assert.equal(decided.stage, "decided");
  assert.equal(decided.decided_by, "u1");
  assert.equal(decided.conclusion, "先清令牌再归档");
  assert.equal(decided.escalate.length, 1);
  assert.match(
    renderCouncil(decided),
    /结论：先清令牌再归档\n拍板：u1\n曾上交用户：/,
  );
  assert.throws(
    () => decideCouncil(db, "t99", { conclusion: "x" }, "u1"),
    /任务 t99 不存在/,
  );
  assert.throws(
    () => decideCouncil(db, "t2", { conclusion: "x" }, "u1"),
    /t2 不是会审议题/,
  );
  assert.throws(
    () => decideCouncil(db, "t1", { conclusion: " " }, "u1"),
    /conclusion: 结论不能为空/,
  );
});

test("会审推进：还在等意见时不能拍板；取消的会审不再推进", (t) => {
  const { db, data } = ledger(t);
  createCouncil(db, data, { topic: "发大版本", concerns: "质量" });
  assert.throws(
    () => decideCouncil(db, "t1", { conclusion: "发" }, "u1"),
    /还没汇总完（等专员意见）/,
  );
  updateTask(db, "t1", { status: "cancelled" });
  advanceTask(db, "t2", { kind: "start" });
  advanceTask(db, "t2", { kind: "exit_ok" }, { result: "意见：同意" });
  assert.deepEqual(settleCouncils(db, data).dispatch, []);
});

test("命令行写法：意见立场、汇总与需用户拍板", () => {
  const view: CouncilView = {
    ref: "t1",
    topic: "公开仓库",
    title: "会审：公开仓库",
    status: "done",
    stage: "escalated",
    stage_label: "需用户拍板",
    leader: null,
    issue: 322,
    comment: true,
    repo: null,
    topic_brief: null,
    opinions: [
      {
        ...member("安全", "conditional", "先清理凭据"),
        status: "done",
        text: "旧提交里有令牌\n意见：有条件同意：先清理凭据",
      },
    ],
    summary: { task: "t1", status: "done", text: "…" },
    agreed: ["先清理凭据"],
    conflicts: [],
    conclusion: "清理后公开",
    escalate: ["公开是不可撤回的，是否本周公开"],
    decided_by: null,
    decided_at: 1,
  };
  assert.equal(
    renderCouncil(view),
    [
      "会审 t1：公开仓库",
      "阶段：需用户拍板",
      "汇总与拍板：秘书 · issue #322（结论同步为评论）",
      "",
      "各方意见：",
      "  安全（o4 · t2）：有条件同意——先清理凭据",
      "    旧提交里有令牌",
      "    意见：有条件同意：先清理凭据",
      "",
      "汇总（t1）：",
      "  一致：",
      "    - 先清理凭据",
      "结论：清理后公开",
      "需用户拍板：",
      "  - 公开是不可撤回的，是否本周公开",
    ].join("\n"),
  );
  assert.doesNotMatch(renderCouncil(view, false), /旧提交里有令牌/);
});

// ---- 隔离服务：三位专员会审，已定与需用户拍板各一次 ----

/**
 * 假 claude：读提示词第一行（标题）。专员意见按专员给立场；leader 汇总按标记文件决定是否上交用户。
 * 意见与汇总都把收到的专员名单回显出来，证明各自拿到了议题上下文。
 */
const FAKE_CLAUDE = `IFS= read -r first
case "$first" in
  *会审意见：安全*)
    echo "看了议题与底线「凭据不进日志、提交与 PR」：本次只改文档，不碰凭据。"
    echo "意见：同意" ;;
  *会审意见：质量*)
    echo "改动没有配测试，回归风险中等。"
    echo "意见：有条件同意：合入前补一条回归用例" ;;
  *会审意见：体验*)
    echo "命令行回执变长，Agent 读起来更费劲。"
    echo "意见：反对：回执超过三行" ;;
  *会审：*)
    echo "## 一致"
    echo "- 不碰凭据，安全上没有顾虑"
    echo "## 冲突"
    echo "- 质量要补用例、体验嫌回执长：取质量，回执压到三行内"
    if [ -f "$HOME/escalate" ]; then echo "需用户拍板：是否接受回执变长（A 接受 / B 砍掉提示行）"; fi
    echo "结论：补回归用例、回执压到三行后合入" ;;
  *) echo "普通任务完成" ;;
esac`;

test("隔离服务：三位专员并行出意见，leader 汇总后记结论并投事件；需用户拍板时投 council_escalated", async (t) => {
  let escalate = "";
  const { data, call } = await startApp(t, (fx) => {
    escalate = join(fx.env.HOME, "escalate");
    const file = join(fx.root, "bin", "claude");
    writeFileSync(file, `#!/bin/sh\n${FAKE_CLAUDE}\n`);
    chmodSync(file, 0o755);
    mkdirSync(join(fx.root, "data"), { recursive: true });
    const db = new DatabaseSync(join(fx.root, "data", "atrium.sqlite"));
    ensureTaskTables(db);
    seed(db, fx.repo);
    db.close();
  });
  const brief = join(data, "..", "议题.md");
  writeFileSync(brief, "把 task show 的回执加一段提示。\n");
  const added = await call("POST", "/api/reviews", {
    topic: "回执加提示段",
    concerns: "安全,质量,体验",
    brief_path: brief,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(
    added.body.opinions.map((o: { task: string }) => o.task),
    ["t2", "t3", "t4"],
  );
  // 还在等意见时不能手动派汇总
  const early = await call("POST", "/api/tasks/t1/run", {});
  if (early.status !== 200)
    assert.match(early.body.error, /会审|等专员意见|汇总/);
  // task wait 等到结论才返回
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=30");
  assert.equal(waited.body.timed_out, false, JSON.stringify(waited.body));
  const view = (await call("GET", "/api/reviews/t1")).body as CouncilView;
  assert.equal(view.stage, "decided", JSON.stringify(view));
  assert.deepEqual(
    view.opinions.map((o) => [o.name, o.stance, o.reason]),
    [
      ["安全", "agree", ""],
      ["质量", "conditional", "合入前补一条回归用例"],
      ["体验", "oppose", "回执超过三行"],
    ],
  );
  assert.deepEqual(view.agreed, ["不碰凭据，安全上没有顾虑"]);
  assert.deepEqual(view.conflicts, [
    "质量要补用例、体验嫌回执长：取质量，回执压到三行内",
  ]);
  assert.equal(view.conclusion, "补回归用例、回执压到三行后合入");
  assert.deepEqual(view.escalate, []);
  // leader 汇总的提示词里有三方意见原文
  const summaryPrompt = readFileSync(
    join(data, "tasks", "1", "prompt.md"),
    "utf8",
  );
  assert.match(summaryPrompt, /# 任务：会审：回执加提示段/);
  assert.match(summaryPrompt, /### 体验（r3 · t4）：反对——回执超过三行/);
  assert.match(summaryPrompt, /命令行回执变长/);
  // 专员意见任务的提示词带议题详述与自己的清单
  const opinionPrompt = readFileSync(
    join(data, "tasks", "2", "prompt.md"),
    "utf8",
  );
  assert.match(opinionPrompt, /把 task show 的回执加一段提示/);
  assert.match(opinionPrompt, /凭据不进日志、提交与 PR/);
  assert.ok(existsSync(join(data, "tasks", "1", "council-summary.md")));
  // 事件：负责人只收到一条会审结局，意见任务与汇总的 done 不单独投
  const open = () => new DatabaseSync(join(data, "atrium.sqlite"));
  let db = open();
  const kinds = () =>
    (
      db
        .prepare("SELECT task_id,kind,detail FROM task_inbox ORDER BY id")
        .all() as { task_id: number; kind: string; detail: string }[]
    ).filter((e) => e.kind !== "budget_unknown");
  assert.deepEqual(
    kinds().map((e) => [e.task_id, e.kind]),
    [[1, "council_decided"]],
  );
  assert.match(kinds()[0]!.detail, /补回归用例、回执压到三行后合入/);
  db.close();

  // 第二场：leader 标了需用户拍板
  writeFileSync(escalate, "1");
  const second = await call("POST", "/api/reviews", {
    topic: "回执再加一段",
    concerns: "安全,质量,体验",
  });
  const ref = second.body.ref as string;
  await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
  const escalated = (await call("GET", `/api/reviews/${ref}`))
    .body as CouncilView;
  assert.equal(escalated.stage, "escalated");
  assert.deepEqual(escalated.escalate, [
    "是否接受回执变长（A 接受 / B 砍掉提示行）",
  ]);
  db = open();
  await until(() => kinds().some((e) => e.kind === "council_escalated"));
  const event = kinds().find((e) => e.kind === "council_escalated")!;
  assert.match(event.detail, /review decide/);
  db.close();
  // 拍板后转已定，汇总阶段外不能再手动派
  const decided = await call("POST", `/api/reviews/${ref}/decide`, {
    conclusion: "接受回执变长",
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.stage, "decided");
  assert.equal(decided.body.decided_by, "u1");
  const rerun = await call("POST", `/api/tasks/${ref}/run`, {});
  assert.equal(rerun.status, 409);
  assert.match(rerun.body.error, /会审已定/);
});
