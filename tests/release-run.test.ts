import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Exec } from "../server/tasks/git.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { RELEASE_OVERDUE_MS } from "../server/tasks/online.ts";
import { OnlineWatch } from "../server/tasks/online-runtime.ts";
import {
  failedStep,
  logSummary,
  overdueFailure,
  parseRuns,
  RELEASE_NO_RUN_MS,
  releaseFailure,
  releaseVerdict,
  type ReleaseRun,
} from "../server/tasks/release-run.ts";
import { laneAlerts } from "../server/tasks/lane-view.ts";
import { topRows } from "../server/tasks/top.ts";
import { urgentInMergeFlow } from "../server/tasks/urgent-ledger.ts";
import { ensureUrgentTables } from "../server/tasks/urgent-ledger.ts";
import { eventLine } from "../server/leaders/wake.ts";
import { pushOf } from "../server/notify/model.ts";

/** 盯发版工作流（t265）：发版失败或没跑起来立刻记上线失败、叫醒负责人，紧急通道不再让路。 */

const COMMIT = "abc1234def5678abc1234def5678abc1234def56";
const T0 = Date.parse("2026-09-28T08:08:00Z");

const run = (fields: Partial<ReleaseRun> & { id: number }): ReleaseRun => ({
  sha: "0000000",
  status: "completed",
  conclusion: "success",
  createdAt: T0,
  url: `https://github.com/acme/demo/actions/runs/${fields.id}`,
  ...fields,
});

test("发版运行列表：读懂 gh 的 JSON，坏项略过，整体读不懂为 null", () => {
  assert.equal(parseRuns("not json"), null);
  assert.equal(parseRuns("{}"), null);
  assert.deepEqual(
    parseRuns(
      JSON.stringify([
        {
          databaseId: 11,
          headSha: "ABC1234",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-09-28T08:08:05Z",
          url: "https://github.com/acme/demo/actions/runs/11",
        },
        {
          databaseId: 12,
          headSha: "def5678",
          status: "in_progress",
          conclusion: "",
          createdAt: "2026-09-28T08:10:00Z",
          url: "javascript:alert(1)",
        },
        { databaseId: "x", headSha: "abc1234", status: "completed" },
        { databaseId: 13, headSha: "not-a-sha", status: "completed" },
        { databaseId: 14, headSha: "abc1234", status: "completed" },
        null,
      ]),
    ),
    [
      {
        id: 11,
        sha: "abc1234",
        status: "completed",
        conclusion: "failure",
        createdAt: Date.parse("2026-09-28T08:08:05Z"),
        url: "https://github.com/acme/demo/actions/runs/11",
      },
      {
        id: 12,
        sha: "def5678",
        status: "in_progress",
        conclusion: null,
        createdAt: Date.parse("2026-09-28T08:10:00Z"),
        url: null,
      },
    ],
  );
});

test("发版判定：以它自己那次运行为起点，在跑就是在发，否则看最近一次结论", () => {
  const verdict = (runs: ReleaseRun[], now = T0 + 60_000) =>
    releaseVerdict({ runs, commit: COMMIT, mergedAt: T0, now });
  const own = run({ id: 1, sha: COMMIT.slice(0, 7), createdAt: T0 + 5_000 });
  // 刚合入还没有运行：等；合入 10 分钟还没有：没跑起来。
  assert.deepEqual(verdict([]), { kind: "waiting" });
  assert.deepEqual(verdict([], T0 + RELEASE_NO_RUN_MS - 1), {
    kind: "waiting",
  });
  assert.deepEqual(verdict([], T0 + RELEASE_NO_RUN_MS), { kind: "missing" });
  // 合入之前的运行（别的提交）不算，哪怕它失败了。
  const before = run({ id: 0, conclusion: "failure", createdAt: T0 - 60_000 });
  assert.deepEqual(verdict([before]), { kind: "waiting" });
  // 自己那次：排队、在跑、通过、失败、取消、超时。
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    const active = { ...own, status, conclusion: null };
    assert.deepEqual(verdict([active, before]), {
      kind: "running",
      run: active,
    });
  }
  assert.deepEqual(verdict([own, before]), { kind: "passed", run: own });
  for (const conclusion of ["skipped", "neutral"])
    assert.equal(verdict([{ ...own, conclusion }]).kind, "passed");
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "startup_failure",
    "action_required",
    "stale",
  ]) {
    const failed = { ...own, conclusion };
    assert.deepEqual(verdict([failed, before]), {
      kind: "failed",
      run: failed,
    });
  }
  // 自己那次失败，之后的提交又触发了一次：在跑就等它，跑通了就算发出来了，又挂了仍是失败。
  const bad = { ...own, conclusion: "failure" };
  const later = run({ id: 2, sha: "fed9876", createdAt: T0 + 120_000 });
  assert.equal(
    verdict([{ ...later, status: "in_progress", conclusion: null }, bad]).kind,
    "running",
  );
  assert.deepEqual(verdict([later, bad]), { kind: "passed", run: later });
  const laterBad = { ...later, conclusion: "failure" };
  assert.deepEqual(verdict([laterBad, bad]), {
    kind: "failed",
    run: laterBad,
  });
  // 自己那次被后来的挤掉（取消），后来的跑通：算发出来。
  assert.equal(
    verdict([later, { ...own, conclusion: "cancelled" }]).kind,
    "passed",
  );
  // 找不到自己那次（列表里没有）：以合入时刻为起点。
  assert.deepEqual(verdict([laterBad, before]), {
    kind: "failed",
    run: laterBad,
  });
  // 起点以运行的创建时刻为准，不受本机时钟偏差影响：自己那次比本机记的合入时刻还早也认。
  const early = { ...bad, createdAt: T0 - 30_000 };
  assert.deepEqual(verdict([early]), { kind: "failed", run: early });
  // 同一时刻创建的按运行号取最新。
  const twin = run({ id: 3, sha: "fed9876", createdAt: T0 + 5_000 });
  assert.deepEqual(verdict([bad, twin]), { kind: "passed", run: twin });
});

test("挂在哪一步：第一个没过的作业里第一个没过的步骤，去掉 Run 前缀；读不出为 null", () => {
  assert.equal(failedStep("oops"), null);
  assert.equal(failedStep("{}"), null);
  assert.equal(
    failedStep(
      JSON.stringify({
        jobs: [
          {
            name: "release",
            conclusion: "failure",
            steps: [
              { name: "Set up job", conclusion: "success" },
              { name: "Run npm ci", conclusion: "success" },
              {
                name: "Run npm run check && npm run format:check",
                conclusion: "failure",
              },
              { name: "Run npm run bench:cli", conclusion: "skipped" },
            ],
          },
        ],
      }),
    ),
    "npm run check && npm run format:check",
  );
  assert.equal(
    failedStep(
      JSON.stringify({
        jobs: [
          { name: "lint", conclusion: "success", steps: [] },
          { name: "release", conclusion: "cancelled", steps: [] },
        ],
      }),
    ),
    "作业 release",
  );
  assert.equal(
    failedStep(JSON.stringify({ jobs: [{ conclusion: "success" }] })),
    null,
  );
});

test("失败日志摘要：去掉作业、步骤、时间戳与颜色，取失败用例与尾部", () => {
  const log = [
    "release\tRun npm run check\t2026-09-28T08:20:01.1234567Z > atrium@0.1.150 check",
    "release\tRun npm run check\t2026-09-28T08:25:00.0000000Z \x1b[31m✖ 看门狗提醒：启动阶段 3 分钟判卡死 (12ms)\x1b[39m",
    "release\tRun npm run check\t2026-09-28T08:25:00.1000000Z not ok 3 - 检查 10 分钟没输出结束",
    "release\tRun npm run check\t2026-09-28T08:25:01.0000000Z ",
    "release\tRun npm run check\t2026-09-28T08:25:02.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const summary = logSummary(log);
  assert.deepEqual(summary.tests, [
    "看门狗提醒：启动阶段 3 分钟判卡死 (12ms)",
    "检查 10 分钟没输出结束",
  ]);
  assert.equal(
    summary.log,
    [
      "> atrium@0.1.150 check",
      "✖ 看门狗提醒：启动阶段 3 分钟判卡死 (12ms)",
      "not ok 3 - 检查 10 分钟没输出结束",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
  // 有界：至多 20 行、1500 字。
  const long = logSummary(
    Array.from({ length: 100 }, (_, i) => `j\ts\t${"x".repeat(150)}${i}`).join(
      "\n",
    ),
  );
  assert.ok(long.log.length <= 1500);
  assert.ok(long.log.endsWith("x99"));
  assert.deepEqual(logSummary(""), { tests: [], log: "" });
});

test("上线失败的说法：挂在哪一步与失败用例；取消、超时另说；没跑起来；超时没出版本", () => {
  const failed = (conclusion: string) => ({
    kind: "failed" as const,
    run: run({ id: 1, conclusion }),
  });
  assert.deepEqual(
    releaseFailure({
      verdict: failed("failure"),
      step: "npm run check && npm run format:check",
      tests: ["a", "b"],
    }),
    {
      reason:
        "上线失败：发版工作流挂在 npm run check && npm run format:check（失败用例：a、b）",
      short:
        "发版工作流挂在 npm run check && npm run format:check（失败用例：a、b）",
    },
  );
  assert.equal(
    releaseFailure({
      verdict: failed("failure"),
      step: "x",
      tests: ["a", "b", "c", "d"],
    }).short,
    "发版工作流挂在 x（失败用例：a、b、c 等 4 个）",
  );
  assert.equal(
    releaseFailure({ verdict: failed("failure"), step: null, tests: [] }).short,
    "发版工作流挂在 未知步骤",
  );
  assert.equal(
    releaseFailure({ verdict: failed("cancelled"), step: "npm ci", tests: [] })
      .short,
    "发版工作流被取消（npm ci）",
  );
  assert.equal(
    releaseFailure({ verdict: failed("timed_out"), step: null, tests: [] })
      .short,
    "发版工作流超时（未知步骤）",
  );
  assert.equal(
    releaseFailure({ verdict: { kind: "missing" }, step: null, tests: [] })
      .reason,
    "上线失败：合入 10 分钟还没有发版工作流在跑",
  );
  assert.equal(
    overdueFailure(30, null).reason,
    "上线失败：合入 30 分钟仍没有含它的版本；查看仓库的发版工作流",
  );
  assert.equal(
    overdueFailure(30, { kind: "running", run: run({ id: 1 }) }).short,
    "合入 30 分钟仍没有含它的版本，发版工作流还在跑",
  );
  assert.equal(
    overdueFailure(30, { kind: "passed", run: run({ id: 1 }) }).short,
    "合入 30 分钟仍没有含它的版本，发版工作流跑通了但没有打出版本",
  );
});

test("看板提示：发版失败一件一行，让路的并成一行写在等谁、等得最久的多久", () => {
  assert.deepEqual(laneAlerts([]), { release: [], held: null });
  assert.deepEqual(
    laneAlerts([
      { ref: "t1", release_failed: "发版工作流挂在 npm run check" },
      { ref: "t2", merge_held: { by: "t1（等发版）", waited_ms: 60_000 } },
      {
        ref: "t3",
        merge_held: { by: "t1（等发版）", waited_ms: 15 * 60_000 },
      },
      { ref: "t4", merge_held: null, release_failed: null },
    ]),
    {
      release: ["t1 发版失败：发版工作流挂在 npm run check"],
      held: "合入让路：2 件等紧急 t1（等发版） · 已等 15 分钟",
    },
  );
  assert.equal(
    laneAlerts([{ ref: "t2", merge_held: { by: "t1", waited_ms: null } }]).held,
    "合入让路：1 件等紧急 t1",
  );
});

// ---- 运行时：OnlineWatch 盯发版 ----

function memory() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureUrgentTables(db);
  return db;
}

function merged(db: DatabaseSync, at: number, urgent = 0) {
  const id = Number(
    db
      .prepare(
        "INSERT INTO tasks(title,repo,deliver,status,pr_url,delivery_stage,merge_commit,online_wait,urgent,created_at,updated_at) VALUES ('修看门狗',?,'pr','done','https://github.com/acme/demo/pull/1','merged',?,1,?,?,?)",
      )
      .run("/repo", COMMIT, urgent, at, at).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,'merged',NULL)",
  ).run(id, at);
  return id;
}

const JOBS = JSON.stringify({
  jobs: [
    {
      name: "release",
      conclusion: "failure",
      steps: [
        { name: "Run npm ci", conclusion: "success" },
        {
          name: "Run npm run check && npm run format:check",
          conclusion: "failure",
        },
      ],
    },
  ],
});
const LOG =
  "release\tRun npm run check\t2026-09-28T08:25:00.0000000Z not ok 3 - 看门狗提醒用例 token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n";

function watcher(
  db: DatabaseSync,
  state: { runs: unknown[] | null; now: number },
) {
  const calls: string[][] = [];
  const published: {
    id: number;
    kind: string;
    detail: Record<string, unknown>;
  }[] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
    if (command === "git" && args.includes("get-url"))
      return ok("https://github.com/acme/demo.git\n");
    if (command === "git") return ok("");
    if (command === "gh" && args[1] === "list")
      return state.runs === null
        ? { ok: false, stdout: "", stderr: "gh down" }
        : ok(JSON.stringify(state.runs));
    if (command === "gh" && args.includes("jobs")) return ok(JOBS);
    if (command === "gh" && args.includes("--log-failed")) return ok(LOG);
    return { ok: false, stdout: "", stderr: `unexpected ${command}` };
  };
  const watch = new OnlineWatch(db, {
    run: exec,
    version: () => "0.1.150",
    selfUpdate: true,
    selfRepo: "acme/demo",
    busy: () => false,
    deploy: async () => ({ ok: true }),
    publish: (id, kind, detail) => published.push({ id, kind, detail }),
    changed: () => {},
    now: () => state.now,
  });
  return { watch, calls, published };
}

const ghRun = (fields: Record<string, unknown>) => ({
  databaseId: 7001,
  headSha: COMMIT,
  status: "completed",
  conclusion: "failure",
  createdAt: new Date(T0 + 5_000).toISOString(),
  url: "https://github.com/acme/demo/actions/runs/7001",
  ...fields,
});

const kinds = (db: DatabaseSync, id: number) =>
  (
    db
      .prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id")
      .all(id) as { kind: string }[]
  ).map((row) => row.kind);

test("发版工作流失败：立刻记上线失败（挂在哪、失败用例、日志与链接，凭据抹掉），紧急通道不再让路，只报一次", async () => {
  const db = memory();
  const id = merged(db, T0, 1);
  const state = {
    runs: [ghRun({ status: "in_progress", conclusion: null })] as
      unknown[] | null,
    now: T0 + 60_000,
  };
  const { watch, calls, published } = watcher(db, state);
  // 在跑：接着等，紧急的照旧让路。
  await watch.tick();
  assert.equal(published.length, 0);
  assert.deepEqual(urgentInMergeFlow(db, state.now), [id]);
  // 挂了：一分钟内就报，不等 30 分钟超时。
  state.runs = [ghRun({})];
  state.now = T0 + 12 * 60_000;
  await watch.tick();
  assert.equal(published.length, 1);
  const event = published[0]!;
  assert.equal(event.kind, "release_failed");
  assert.equal(
    event.detail.short,
    "发版工作流挂在 npm run check && npm run format:check（失败用例：看门狗提醒用例 token=***）",
  );
  assert.match(
    String(event.detail.reason),
    /^上线失败：发版工作流挂在 npm run check && npm run format:check（失败用例：.*）；日志 https:\/\/github\.com\/acme\/demo\/actions\/runs\/7001$/,
  );
  assert.equal(
    event.detail.run_url,
    "https://github.com/acme/demo/actions/runs/7001",
  );
  assert.doesNotMatch(JSON.stringify(event.detail), /ghp_/);
  assert.match(String(event.detail.log), /not ok 3 - 看门狗提醒用例/);
  const row = db
    .prepare("SELECT online_wait,release_failed_at FROM tasks WHERE id=?")
    .get(id) as { online_wait: number; release_failed_at: number };
  // 仍在等上线：修好发版后含它的新版本照样由标签认出来。
  assert.equal(row.online_wait, 1);
  assert.equal(row.release_failed_at, state.now);
  assert.deepEqual(urgentInMergeFlow(db, state.now), []);
  // 看板：持球人是负责人（没有 leader 时是秘书），醒目写发版失败。
  const top = topRows(db, state.now).rows.find((r) => r.ref === `t${id}`)!;
  assert.deepEqual(top.holder, {
    kind: "secretary",
    who: "secretary",
    text: "发版失败：发版工作流挂在 npm run check && npm run format:ch…",
  });
  assert.equal(top.release_failed, event.detail.short);
  // 不重复报，也不再为它查 gh；超时也不另报。
  const ghCalls = calls.filter((call) => call[0] === "gh").length;
  state.now = T0 + RELEASE_OVERDUE_MS + 1;
  await watch.tick();
  await watch.tick();
  assert.equal(published.length, 1);
  assert.equal(calls.filter((call) => call[0] === "gh").length, ghCalls);
  assert.deepEqual(
    kinds(db, id).filter((kind) => kind.startsWith("release")),
    ["release_failed"],
  );
  db.close();
});

test("发版没跑起来：合入 10 分钟还没有含它的运行就报；gh 查不到不下结论，超时再报", async () => {
  const db = memory();
  const id = merged(db, T0);
  const state = { runs: [] as unknown[] | null, now: T0 + 60_000 };
  const { watch, published } = watcher(db, state);
  await watch.tick();
  assert.equal(published.length, 0);
  state.now = T0 + RELEASE_NO_RUN_MS;
  await watch.tick();
  assert.deepEqual(
    published.map((event) => [event.kind, event.detail.reason]),
    [["release_failed", "上线失败：合入 10 分钟还没有发版工作流在跑"]],
  );

  const offline = memory();
  const other = merged(offline, T0);
  const blind = watcher(offline, { runs: null, now: T0 + RELEASE_NO_RUN_MS });
  await blind.watch.tick();
  assert.equal(blind.published.length, 0);
  blind.watch.close();
  const later = watcher(offline, {
    runs: null,
    now: T0 + RELEASE_OVERDUE_MS + 1,
  });
  await later.watch.tick();
  assert.deepEqual(
    later.published.map((event) => [event.kind, event.detail.reason]),
    [
      [
        "release_overdue",
        "上线失败：合入 30 分钟仍没有含它的版本；查看仓库的发版工作流",
      ],
    ],
  );
  assert.notEqual(
    (
      offline
        .prepare("SELECT release_failed_at FROM tasks WHERE id=?")
        .get(other) as { release_failed_at: number | null }
    ).release_failed_at,
    null,
  );
  db.close();
  offline.close();
  void id;
});

test("发版失败的事件：leader 唤醒附挂在哪、链接与日志尾部；紧急的推到手机", () => {
  const line = eventLine({
    id: 9,
    task: "t260",
    kind: "release_failed",
    count: 1,
    detail: {
      title: "卡住 5 分钟就提醒",
      reason:
        "上线失败：发版工作流挂在 npm run check（失败用例：x）；日志 https://github.com/acme/demo/actions/runs/1",
      log: "not ok 1 - x\n##[error]exit 1",
    },
  });
  assert.equal(
    line,
    [
      "- #9 t260 发版失败 卡住 5 分钟就提醒：上线失败：发版工作流挂在 npm run check（失败用例：x）；日志 https://github.com/acme/demo/actions/runs/1",
      "  失败日志尾部：",
      "    not ok 1 - x",
      "    ##[error]exit 1",
    ].join("\n"),
  );
  assert.deepEqual(
    pushOf(
      {
        id: 3,
        subscriber: "secretary",
        kind: "urgent_stage",
        task: "t260",
        actor: null,
        detail: { event: "release_failed", title: "卡住 5 分钟就提醒" },
      },
      "secretary",
      () => null,
    ),
    {
      key: "event:3:release_failed",
      kind: "urgent_release",
      ref: "t260",
      title: "卡住 5 分钟就提醒",
    },
  );
});

test("旧库启动：没有 release_failed_at 列的补上，已合入等上线的紧急任务照旧让路；旧运行时的表不读不写", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE inbox_tokens (token TEXT PRIMARY KEY);
    INSERT INTO agents VALUES ('pi','旧身份');`);
  ensureTaskTables(db);
  db.exec("DROP INDEX IF EXISTS tasks_online_wait");
  db.exec("ALTER TABLE tasks DROP COLUMN release_failed_at");
  const id = merged(db, Date.now(), 1);
  ensureTaskTables(db);
  ensureUrgentTables(db);
  assert.equal(
    (
      db.prepare("SELECT release_failed_at FROM tasks WHERE id=?").get(id) as {
        release_failed_at: number | null;
      }
    ).release_failed_at,
    null,
  );
  assert.deepEqual(urgentInMergeFlow(db), [id]);
  assert.deepEqual(
    [...db.prepare("SELECT * FROM agents").all()].map((r) => ({ ...r })),
    [{ id: "pi", name: "旧身份" }],
  );
  db.close();
});
