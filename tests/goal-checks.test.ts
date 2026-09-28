import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { ensureGoalTables } from "../server/goals/schema.ts";
import { addGoal, editGoal } from "../server/goals/write.ts";
import { goalShow, goalTree } from "../server/goals/read.ts";
import {
  CHECK_RESULTS,
  canJudge,
  commandOf,
  commandResult,
  criterionProblem,
  itemStates,
  manualBlocker,
  readiness,
  redact,
  summarize,
  type CheckRecord,
} from "../server/goals/check-rules.ts";
import {
  insertCheck,
  judgeItem,
  sweepInterrupted,
} from "../server/goals/checks.ts";
import { GoalChecker } from "../server/goals/check-runtime.ts";
import { GOAL_STATUSES } from "../server/goals/rules.ts";
import type { Exec } from "../server/tasks/git.ts";
import { createApp } from "../server/app.ts";
import { checkLine, itemLines } from "../cli/goals.ts";
import { removeTemp } from "./temp-dir.ts";
import { nodeCommand, sleepCommand, TRUE_COMMAND } from "./portable-shell.ts";

/** 组织 o1（u1）；Atrium o2（a1）下 runtime o3（a2）、质量 o4（a3，关注点）；OpenQuota o5（a4）下质量 o6（a5）。 */
const ORG = [
  { id: 1, parent_id: null, leader: "u1", kind: "org" },
  { id: 2, parent_id: 1, leader: "a1", kind: "project" },
  { id: 3, parent_id: 2, leader: "a2", kind: "module" },
  { id: 4, parent_id: 2, leader: "a3", kind: "concern" },
  { id: 5, parent_id: 1, leader: "a4", kind: "project" },
  { id: 6, parent_id: 5, leader: "a5", kind: "concern" },
];

function setup() {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureGoalTables(db);
  const node = (input: Record<string, unknown>) =>
    addNode(db, { reason: "创建", ...input } as never, "u1");
  node({ slug: "org", kind: "org", name: "组织" });
  node({
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    leader: "a1",
  });
  node({
    parent: "o2",
    slug: "runtime",
    kind: "module",
    name: "runtime",
    leader: "a2",
  });
  node({
    parent: "o2",
    slug: "质量",
    kind: "concern",
    name: "质量",
    leader: "a3",
  });
  node({
    parent: "o1",
    slug: "openquota",
    kind: "project",
    name: "OpenQuota",
    leader: "a4",
  });
  return db;
}

const record = (
  id: number,
  criterion: string,
  result: CheckRecord["result"],
): CheckRecord => ({
  id,
  criterion,
  kind: commandOf(criterion) ? "command" : "manual",
  result,
  exit_code: null,
  summary: null,
  note: null,
  actor: "u1",
  started_at: id,
  ended_at: id,
});

test("命令条目：以「$ 」开头才算命令；$ 后没命令或没空格在写入时拒绝", () => {
  assert.equal(commandOf("$ npm test"), "npm test");
  assert.equal(commandOf("$   gh pr view 1  "), "gh pr view 1");
  assert.equal(commandOf("$ "), null);
  assert.equal(commandOf("atrium org tree 列出全部节点"), null);
  assert.equal(commandOf("花费 $5 以内"), null);
  assert.equal(criterionProblem("$"), "以 $ 开头的条目要跟命令，如 $ npm test");
  assert.equal(
    criterionProblem("$ "),
    "以 $ 开头的条目要跟命令，如 $ npm test",
  );
  assert.match(criterionProblem("$npm test")!, /\$ 后空一格/);
  assert.equal(criterionProblem("$ npm test"), null);
  assert.equal(criterionProblem("人工看过界面"), null);
});

test("最新判定按条目原文匹配：调顺序保留，改措辞作废，取编号最大的一次", () => {
  const checks = [
    record(1, "$ npm test", "fail"),
    record(3, "$ npm test", "pass"),
    record(2, "界面看过", "pass"),
    record(4, "旧的说法", "pass"),
  ];
  const items = itemStates(["界面看过", "$ npm test", "新的说法"], checks);
  assert.deepEqual(
    items.map((i) => [i.n, i.command, i.latest?.id ?? null]),
    [
      [1, null, 2],
      [2, "npm test", 3],
      [3, null, null],
    ],
  );
});

test("可标达成：条目全满足、前置都达成、自己没达成或放弃；否则逐条说明", () => {
  const pass = itemStates(
    ["$ true", "看过"],
    [record(1, "$ true", "pass"), record(2, "看过", "pass")],
  );
  for (const status of GOAL_STATUSES) {
    const verdict = readiness(status, pass, []);
    assert.equal(
      verdict.ready,
      status !== "achieved" && status !== "dropped",
      status,
    );
  }
  assert.deepEqual(readiness("active", [], []), {
    ready: false,
    blockers: ["还没有验收标准"],
  });
  for (const result of CHECK_RESULTS) {
    const items = itemStates(["$ true", "看过"], [record(1, "$ true", result)]);
    const verdict = readiness("active", items, [
      { ref: "g1", status: "achieved" },
      { ref: "g2", status: "active" },
    ]);
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.blockers, [
      ...(result === "pass"
        ? []
        : [
            `第 1 条${
              {
                running: "正在执行",
                fail: "不满足",
                timeout: "超时",
                error: "没跑成",
              }[result]
            }`,
          ]),
      "第 2 条还没判",
      "前置 g2 未达成",
    ]);
  }
  assert.deepEqual(
    readiness("planned", itemStates(["$ true"], []), []).blockers,
    ["第 1 条还没跑"],
  );
});

test("人工判定权限：负责部门 leader 链，或同项目链上关注点的 leader；别项目的质量不行", () => {
  const cases: [number, string, boolean][] = [
    [3, "u1", true],
    [3, "a1", true],
    [3, "a2", true],
    [3, "a3", true], // Atrium 的质量判 runtime 的里程碑
    [3, "a4", false],
    [3, "a5", false], // OpenQuota 的质量
    [2, "a3", true],
    [2, "a2", false],
    [5, "a5", true],
    [5, "a3", false],
    [1, "a3", false], // 根节点上的顶层目标：只有根链 leader 或根下关注点
  ];
  for (const [node, actor, ok] of cases)
    assert.equal(
      canJudge(ORG, { node_id: node }, actor).ok,
      ok,
      `${actor}@o${node}`,
    );
  const archived = ORG.map((n) => (n.id === 4 ? { ...n, archived_at: 1 } : n));
  assert.equal(canJudge(archived, { node_id: 3 }, "a3").ok, false);
});

test("命令结论、人工判定只给非命令条目、输出摘要截尾并抹凭据", () => {
  assert.equal(commandResult({ code: 0, timedOut: false }), "pass");
  assert.equal(commandResult({ code: 1, timedOut: false }), "fail");
  assert.equal(commandResult({ code: null, timedOut: true }), "timeout");
  assert.equal(commandResult({ code: 0, timedOut: true }), "timeout");
  assert.equal(
    commandResult({ code: null, timedOut: false, error: "ENOENT" }),
    "error",
  );
  assert.equal(manualBlocker(undefined), "没有这一条");
  assert.match(
    manualBlocker(itemStates(["$ true"], [])[0])!,
    /由运行时执行判定/,
  );
  assert.equal(manualBlocker(itemStates(["看过"], [])[0]), null);

  const secret = "ghp_" + "a".repeat(36);
  const text = [
    `token ${secret}`,
    "GITHUB_TOKEN=abcdef123456",
    "export OPENAI_API_KEY='sk-proj-abcdefghijklmnop'",
    "Authorization: Bearer abc.def.ghijklmnop",
    "github_pat_" + "b".repeat(30),
    "普通输出 task-t57 ok",
  ].join("\n");
  const cleaned = redact(text);
  assert.ok(!cleaned.includes(secret));
  assert.ok(!cleaned.includes("abcdef123456"));
  assert.ok(!cleaned.includes("sk-proj"));
  assert.ok(!cleaned.includes("abc.def.ghijklmnop"));
  assert.ok(!cleaned.includes("b".repeat(30)));
  assert.ok(cleaned.includes("普通输出 task-t57 ok"));

  const long = Array.from(
    { length: 50 },
    (_, i) => `\u001b[31m第 ${i} 行\u001b[0m`,
  ).join("\n");
  const summary = summarize(long);
  assert.equal(summary.split("\n").length, 20);
  assert.ok(summary.endsWith("第 49 行"));
  assert.ok(!summary.includes("\u001b"));
  assert.ok(Array.from(summarize("字".repeat(5000))).length <= 1501);
});

test("写验收标准与仓库：$ 笔误拒绝；--repo 须是存在目录的绝对路径", (t) => {
  const db = setup();
  const dir = mkdtempSync(join(tmpdir(), "atrium-goal-repo-"));
  t.after(() => removeTemp(dir));
  assert.throws(
    () => addGoal(db, { result: "顶层", criteria: ["$npm test"] }, "u1"),
    /--criteria: .*\$ 后空一格/,
  );
  assert.throws(
    () => addGoal(db, { result: "顶层", repo: "relative/path" }, "u1"),
    /--repo: 应为仓库的绝对路径/,
  );
  assert.throws(
    () => addGoal(db, { result: "顶层", repo: `${dir}/../x` }, "u1"),
    /--repo: 路径不能含 \.\./,
  );
  assert.throws(
    () => addGoal(db, { result: "顶层", repo: join(dir, "nope") }, "u1"),
    /--repo: 目录不存在/,
  );
  const top = addGoal(db, { result: "顶层", repo: `${dir}/` }, "u1");
  assert.equal(top.repo, dir);
  const cleared = editGoal(db, top.ref, { repo: "" }, "u1");
  assert.equal(cleared.repo, null);
  assert.deepEqual(cleared.changed, ["repo"]);
});

test("人工判定：要条目号与证据、只判非命令条目、看权限；goal show 给最新判定与可标达成", () => {
  const db = setup();
  addGoal(db, { result: "顶层", node: "o2" }, "u1");
  const m = addGoal(
    db,
    {
      result: "里程碑",
      parent: "g1",
      node: "o3",
      criteria: ["$ true", "界面看过"],
    },
    "a2",
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "ok", item: 2, note: "x" }, "a2"),
    /--pass 或 --fail/,
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "pass", note: "x" }, "a2"),
    /--item/,
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "pass", item: 2 }, "a2"),
    /--note: 人工判定要写证据/,
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "pass", item: 2, note: "  " }, "a2"),
    /--note/,
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "pass", item: 3, note: "x" }, "a2"),
    /只有 2 条/,
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "pass", item: 1, note: "x" }, "a2"),
    /由运行时执行判定/,
  );
  assert.throws(
    () => judgeItem(db, m.ref, { verdict: "pass", item: 2, note: "x" }, "a4"),
    /不是负责部门/,
  );
  assert.throws(
    () =>
      judgeItem(
        db,
        m.ref,
        { verdict: "pass", item: 2, note: "x", extra: 1 },
        "a2",
      ),
    /extra/,
  );

  const judged = judgeItem(
    db,
    m.ref,
    { verdict: "pass", item: 2, note: "截图见 PR #318" },
    "a3",
  );
  assert.equal(judged.result, "pass");
  assert.equal(judged.actor, "a3");
  let shown = goalShow(db, m.ref);
  assert.equal(shown.items[1]!.latest?.note, "截图见 PR #318");
  assert.equal(shown.ready, false);
  assert.deepEqual(shown.ready_blockers, ["第 1 条还没跑"]);

  // 命令条目只由运行时判：这里直接落一条满足，模拟跑完。
  insertCheck(db, {
    goal_id: 2,
    criterion: "$ true",
    kind: "command",
    result: "pass",
    actor: "u1",
    at: 1,
  });
  shown = goalShow(db, m.ref);
  assert.equal(shown.ready, true);
  assert.equal(goalTree(db).goals[0]!.children[0]!.ready, true);
  assert.deepEqual(itemLines(shown.items[1]!).slice(1), [
    "       截图见 PR #318",
  ]);
  assert.match(checkLine(shown.items[1]!.latest!), /^✓ 满足（a3 判，/);

  // 改措辞：旧判定作废。
  editGoal(db, m.ref, { criteria: ["$ true", "界面看过并截图"] }, "a2");
  shown = goalShow(db, m.ref);
  assert.equal(shown.ready, false);
  assert.equal(shown.items[1]!.latest, null);
});

test("启动自愈：执行中的判定若所属服务已不在，判为没跑成；本进程与活着的旧服务的不动", () => {
  const db = setup();
  addGoal(db, { result: "顶层", criteria: ["$ a", "$ b", "$ c", "$ d"] }, "u1");
  const running = (criterion: string, owner: number | null) =>
    insertCheck(db, {
      goal_id: 1,
      criterion,
      kind: "command",
      result: "running",
      owner,
      actor: "u1",
      at: 1,
    });
  running("$ a", 999_001);
  running("$ b", 999_002);
  running("$ c", 42);
  running("$ d", null);
  sweepInterrupted(db, (pid) => pid === 999_002, 42, 5);
  const items = goalShow(db, "g1").items;
  assert.deepEqual(
    items.map((i) => i.latest?.result),
    ["error", "running", "running", "error"],
  );
  assert.match(items[0]!.latest!.summary!, /服务中断/);
});

async function settle(checker: GoalChecker, ref: string, ids: number[]) {
  const result = await checker.wait(ref, ids.join(","), 30);
  assert.equal(result.timed_out, false);
  return result.checks;
}

test("运行时跑命令：没填仓库在空临时目录跑，通过与失败各一次，白名单环境，跑完删临时目录", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-goal-check-"));
  t.after(() => removeTemp(data));
  const db = setup();
  const checker = new GoalChecker(db, {
    data,
    env: { PATH: process.env.PATH, HOME: data, SECRET_TOKEN: "leak-me-please" },
  });
  t.after(() => checker.close());
  addGoal(
    db,
    {
      result: "顶层",
      criteria: [
        `$ ${nodeCommand("if (require('fs').readdirSync('.').length) process.exit(1); console.log('空目录')")}`,
        `$ ${nodeCommand("console.error('坏了'); process.exit(3)")}`,
        `$ ${nodeCommand("process.exit(!process.env.SECRET_TOKEN && process.env.ATRIUM_WORKER === '1' ? 0 : 1)")}`,
        "人工条目",
      ],
    },
    "u1",
  );
  assert.throws(() => checker.start("g1", 4, "u1"), /不是命令，要人工判/);
  assert.throws(() => checker.start("g1", 9, "u1"), /只有 4 条/);
  const started = checker.start("g1", undefined, "u1");
  assert.equal(started.checks.length, 3);
  assert.ok(started.checks.every((c) => c.result === "running"));
  // 正在跑的同一条不重复起。
  assert.deepEqual(
    checker.start("g1", 1, "u1").checks.map((c) => c.id),
    [started.checks[0]!.id],
  );
  const done = await settle(
    checker,
    "g1",
    started.checks.map((c) => c.id),
  );
  assert.deepEqual(
    done.map((c) => [c.result, c.exit_code]),
    [
      ["pass", 0],
      ["fail", 3],
      ["pass", 0],
    ],
  );
  assert.match(done[0]!.summary!, /空目录/);
  assert.match(done[1]!.summary!, /坏了/);
  assert.ok(existsSync(done[0]!.log!));
  assert.deepEqual(
    readdirSync(join(data, "goals", "g1")).filter((f) => f.startsWith("work-")),
    [],
  );
  const shown = goalShow(db, "g1");
  assert.deepEqual(shown.ready_blockers, ["第 2 条不满足", "第 4 条还没判"]);
});

test("运行时跑命令：在仓库的临时 worktree 里跑（不碰原工作区），超时判超时", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-goal-check-"));
  const repo = mkdtempSync(join(tmpdir(), "atrium-goal-repo-"));
  t.after(() => {
    removeTemp(data);
    removeTemp(repo);
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "marker.txt"), "已提交\n");
  git("add", "marker.txt");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "init",
  );
  writeFileSync(join(repo, "dirty.txt"), "没提交\n");
  const db = setup();
  const checker = new GoalChecker(db, { data, timeoutMs: 1500 });
  t.after(() => checker.close());
  addGoal(
    db,
    {
      result: "顶层",
      repo,
      criteria: [
        `$ ${nodeCommand("const fs = require('fs'); if (!fs.readFileSync('marker.txt', 'utf8').includes('已提交') || fs.existsSync('dirty.txt')) process.exit(1); fs.writeFileSync('产物.txt', '')")}`,
        `$ ${sleepCommand(30)}`,
      ],
    },
    "u1",
  );
  const first = checker.start("g1", 1, "u1");
  const [passed] = await settle(checker, "g1", [first.checks[0]!.id]);
  assert.equal(passed!.result, "pass", passed!.summary ?? "");
  assert.ok(!existsSync(join(repo, "产物.txt")), "不在原工作区里跑");
  assert.equal(
    git("worktree", "list").trim().split("\n").length,
    1,
    "临时 worktree 已删",
  );
  const second = checker.start("g1", 2, "u1");
  const [slow] = await settle(checker, "g1", [second.checks[0]!.id]);
  assert.equal(slow!.result, "timeout");
});

/**
 * git 往上找仓库时停在 ceiling：临时目录的上层本身是 git 仓库时（如 Windows 上
 * `C:/Users/<名>` 是个仓库），不把它认成里程碑的仓库，更不在里面建 worktree。
 */
const ceiledExec =
  (ceiling: string): Exec =>
  (command, args, options = {}) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd ?? ceiling,
          timeout: options.timeoutMs ?? 30_000,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CEILING_DIRECTORIES: ceiling,
          },
        },
        (error, stdout, stderr) =>
          resolve({
            ok: !error,
            stdout: String(stdout),
            stderr: String(stderr || (error ? error.message : "")),
          }),
      );
    });

test("运行时跑命令：仓库不是 git 时判没跑成；关服务时在跑的判中断", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-goal-check-"));
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "atrium-goal-plain-")));
  t.after(() => {
    removeTemp(data);
    removeTemp(plain);
  });
  const db = setup();
  const checker = new GoalChecker(db, {
    data,
    run: ceiledExec(dirname(plain)),
  });
  addGoal(
    db,
    { result: "顶层", repo: plain, criteria: [`$ ${TRUE_COMMAND}`] },
    "u1",
  );
  addGoal(db, { result: "另一个", criteria: [`$ ${sleepCommand(30)}`] }, "u1");
  const bad = checker.start("g1", undefined, "u1");
  const [error] = await settle(checker, "g1", [bad.checks[0]!.id]);
  assert.equal(error!.result, "error");
  assert.match(error!.summary!, /不是 git 仓库/);
  const slow = checker.start("g2", undefined, "u1");
  await delay(300);
  checker.close();
  const [stopped] = goalShow(db, "g2").items;
  assert.equal(stopped!.latest?.result, "error");
  assert.match(stopped!.latest!.summary!, /服务停止/);
  assert.equal(slow.checks.length, 1);
});

test("HTTP：goal check 跑命令并等结果，人工判定走同一入口，goal show 给可标达成", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-goal-http-"));
  t.after(() => removeTemp(data));
  const { app, db } = await createApp({ data, auth: false });
  t.after(() => app.close());
  addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建" } as never,
    "u1",
  );
  const call = async (
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({ method, url, payload });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, any>,
    };
  };
  await call("POST", "/api/goals", {
    result: "顶层",
    criteria: [`$ ${TRUE_COMMAND}`, "$ exit 1", "看过"],
  });
  assert.equal(
    (await call("POST", "/api/goals/g1/check", { item: 1, bogus: 1 })).status,
    400,
  );
  const started = await call("POST", "/api/goals/g1/check", {});
  assert.equal(started.status, 200);
  const ids = started.body.checks.map((c: { id: number }) => c.id).join(",");
  assert.equal(
    (await call("GET", `/api/goals/g1/check-wait?ids=${ids}&timeout=999`))
      .status,
    400,
  );
  assert.equal(
    (await call("GET", `/api/goals/g1/check-wait?ids=x&timeout=5`)).status,
    400,
  );
  const waited = await call(
    "GET",
    `/api/goals/g1/check-wait?ids=${ids}&timeout=30`,
  );
  assert.equal(waited.body.timed_out, false);
  assert.deepEqual(
    waited.body.checks.map((c: { result: string }) => c.result),
    ["pass", "fail"],
  );
  const manual = await call("POST", "/api/goals/g1/check", {
    item: 3,
    verdict: "pass",
    note: "看过",
  });
  assert.equal(manual.status, 200);
  const shown = await call("GET", "/api/goals/g1");
  assert.equal(shown.body.ready, false);
  assert.deepEqual(shown.body.ready_blockers, ["第 2 条不满足"]);
  assert.equal(shown.body.items[2].latest.note, "看过");
});
