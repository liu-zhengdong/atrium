import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { exec, type Exec } from "../server/tasks/git.ts";
import { ensureTaskTables, getTask } from "../server/tasks/ledger.ts";
import { MergeQueue } from "../server/tasks/merge-runtime.ts";
import { HostLoad, type HostLimits } from "../server/tasks/host-load.ts";
import { topRows } from "../server/tasks/top.ts";
import { urgentInMergeFlow } from "../server/tasks/urgent-ledger.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { startApp, until } from "./task-fixture.ts";
import { isolatedPath, removeFakeBin } from "./fake-bin.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 紧急通道（t215）的运行时接入：隔离服务 + 假执行者 + 假 gh。
 * 抢占与续上、先止损、谁能标、合入暂停与让路、审阅与合入并行、没进展换人、状态栏提示。
 */

const limits = (over: Partial<HostLimits> = {}): HostLimits => ({
  cores: 8,
  maxWorkers: null,
  maxChecks: 2,
  testConcurrency: 2,
  checkTimeoutMs: 30 * 60_000,
  busyCores: null,
  busyLoad: null,
  ...over,
});

/** 假 kimi 等到 $HOME/go 出现才收工，期间一直有输出（看门狗不判卡死）。 */
const waitingKimi = (fx: { script: (name: string, body: string) => void }) =>
  fx.script(
    "kimi",
    'set -e\nwhile [ ! -f "$HOME/go" ]; do echo waiting; sleep 0.1; done\necho hi >> done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"',
  );

const kindsOf = (db: DatabaseSync, ref: string) =>
  getTask(db, ref).events.map((event) => event.kind);
const detailsOf = (db: DatabaseSync, ref: string, kind: string) =>
  getTask(db, ref)
    .events.filter((event) => event.kind === kind)
    .map((event) => JSON.parse(event.detail ?? "null"));

test("抢占与续上：本机满时紧急任务立刻派出、先暂停闲时任务；紧急的做完后被暂停的在原工作树自动续上", async (t) => {
  const host = new HostLoad(limits({ maxWorkers: 1 }), () => 0);
  const { fx, data, call, taskRunner } = await startApp(
    t,
    waitingKimi,
    undefined,
    undefined,
    { host },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", {
    title: "闲时整理",
    repo: fx.repo,
    priority: "闲时",
  });
  const idle = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(idle.body.task.status, "running");
  const worktree = idle.body.task.worktree as string;
  await call("POST", "/api/tasks", {
    title: "线上满屏弹窗",
    repo: fx.repo,
    urgent: true,
  });
  const urgent = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(urgent.body.queued, false, "不等名额，立刻派出");
  assert.equal(urgent.body.task.status, "running");
  await until(() => getTask(db, "t1").status === "blocked");
  assert.ok(kindsOf(db, "t1").includes("preempted"));
  assert.match(
    detailsOf(db, "t1", "stop_requested")[0].reason,
    /被紧急任务 t2 抢占暂停（让出执行者名额）/,
  );
  assert.deepEqual(detailsOf(db, "t2", "preempting")[0], {
    task: "t1",
    why: "slot",
    reason: "暂停 t1（让出执行者名额）",
  });
  // 看板：被暂停的由运行时自己续上，不是等谁处理。
  const top = (await call("GET", "/api/tasks/top")).body;
  const row = top.rows.find((item: { ref: string }) => item.ref === "t1");
  assert.equal(row.holder.text, "被紧急 t2 抢占暂停，之后自动续上");
  assert.equal(row.holder.kind, "queue");
  assert.deepEqual(top.urgent, { count: 1, refs: ["t2"], warning: null });
  assert.equal(top.counts.blocked, 0, "被暂停的不算卡住");
  assert.equal(top.counts.queued, 1);
  // 各阶段推给秘书与用户：开始、抢占（同一任务未确认的合成最新一条）。
  for (const subscriber of ["secretary", "u1"]) {
    const stages = taskRunner.inbox
      .list(subscriber, { limit: 50 })
      .events.filter((event) => event.kind === "urgent_stage");
    assert.equal(stages.length, 1, subscriber);
    assert.equal(stages[0]!.task, "t2");
    assert.ok(
      ["开始", "抢占"].includes((stages[0]!.detail as { stage: string }).stage),
    );
  }
  // 暂停与续上对原负责人只是知会。
  const notice = taskRunner.inbox
    .list("secretary", { limit: 50 })
    .events.find((event) => event.kind === "preempted");
  assert.equal(notice?.level, "info");
  writeFileSync(join(fx.root, "home", "go"), "");
  await call("GET", "/api/tasks/t2/wait?timeout=20");
  await until(() => kindsOf(db, "t1").includes("resumed"), 20_000);
  assert.deepEqual(detailsOf(db, "t1", "resumed")[0], {
    by: "t2",
    worker: "kimi",
    how: "在原工作树重派",
  });
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.worktree, worktree, "续上用的是原工作树");
  // kimi 不能续会话：说明写进重派的提示词。
  const tells = detailsOf(db, "t1", "tell");
  assert.ok(tells.some((tell) => /被紧急任务 t2 抢占暂停/.test(tell.text)));
  const record = db
    .prepare(
      "SELECT by_task,why,resumed_at FROM task_preemptions WHERE task_id=1",
    )
    .get() as { by_task: number; why: string; resumed_at: number | null };
  assert.equal(record.by_task, 2);
  assert.equal(record.why, "slot");
  assert.ok(record.resumed_at);
});

test("先止损：紧急任务建好先执行止损动作并记事件；没标紧急、写错、避开主机写错都拒绝，不建任务", async (t) => {
  const { fx, data, call, taskRunner } = await startApp(t, waitingKimi);
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "在跑的", repo: fx.repo });
  await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  const made = await call("POST", "/api/tasks", {
    title: "修 Windows 弹窗",
    repo: fx.repo,
    urgent: true,
    stopgap: "atrium task stop t1; atrium host pause h1; atrium task stop t9",
    avoid_host: "h3",
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(
    made.body.stopgap_results.map((item: { action: string; ok: boolean }) => [
      item.action,
      item.ok,
    ]),
    [
      ["atrium task stop t1", true],
      ["atrium host pause h1", true],
      ["atrium task stop t9", false],
    ],
  );
  assert.match(made.body.stopgap_results[2].detail, /t9/);
  assert.deepEqual(made.body.avoid_host_refs, ["h3"]);
  const stopped = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(stopped.body.task.status, "failed");
  // 停止事件记发起者（t239）：紧急任务 t2 的止损。
  const [stop] = detailsOf(db, "t1", "stop_requested");
  assert.equal(stop.by, "t2");
  assert.equal(stop.reason, "紧急任务 t2 止损");
  assert.equal(
    (
      db.prepare("SELECT paused FROM hosts WHERE id=1").get() as {
        paused: number;
      }
    ).paused,
    1,
  );
  assert.equal(detailsOf(db, "t2", "stopgap").length, 1);
  const stage = taskRunner.inbox
    .list("u1", { limit: 50 })
    .events.find((event) => event.kind === "urgent_stage");
  assert.equal((stage?.detail as { stage: string }).stage, "止损");
  // 派修复时止损已做过，不重复；本机被暂停、没有别的主机，排队等。
  const run = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(run.body.queued, true);
  assert.match(run.body.task.queued_reason, /h1 已暂停接活/);
  assert.equal(detailsOf(db, "t2", "stopgap").length, 1);
  // 破坏输入：不建任务、说参数名。
  const count = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  const before = count();
  for (const [body, message] of [
    [
      { title: "x", stopgap: "atrium host pause h1" },
      /只有紧急任务能写止损动作/,
    ],
    [
      { title: "x", urgent: true, stopgap: "rm -rf /" },
      /stopgap: 第 1 条看不懂/,
    ],
    [
      { title: "x", urgent: true, stopgap: "atrium host pause h1; curl x" },
      /stopgap: 第 2 条看不懂/,
    ],
    [{ title: "x", avoid_host: "h0" }, /avoid_host: 应为主机短号/],
    [{ title: "x", urgent: true, why: 3 }, /why: 应为文本/],
  ] as const) {
    const refused = await call("POST", "/api/tasks", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.body.message ?? refused.body.error, message);
  }
  assert.equal(count(), before);
  // 改避开的主机与原因。
  const set = await call("PATCH", "/api/tasks/t2", {
    avoid_host: "h3,h4",
    why: "弹窗挡住桌面",
  });
  assert.deepEqual(set.body.avoid_host_refs, ["h3", "h4"]);
  assert.equal(set.body.urgent_why, "弹窗挡住桌面");
  assert.deepEqual(
    (await call("PATCH", "/api/tasks/t2", { avoid_host: "" })).body
      .avoid_host_refs,
    [],
  );
  await call("POST", "/api/tasks/t2/stop");
});

test("谁能标：leader 标紧急须写原因并知会秘书与用户；leader 不能写止损动作；多于 2 个紧急任务时提示", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-urgent-"));
  t.after(() => removeTemp(data));
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: { batchMs: 0, pollMs: 20, run: async () => "ok" },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload: unknown,
    authorization = user,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", authorization },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
  ] as const)
    assert.equal(
      (
        await call("POST", "/api/org/nodes", {
          parent,
          slug,
          kind,
          name,
          reason: "建",
        })
      ).status,
      201,
    );
  assert.ok(
    (
      await call("POST", "/api/leaders", {
        name: "Atrium 负责人",
        worker: "codex",
      })
    ).status < 300,
  );
  assert.ok(
    (await call("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" }))
      .status < 300,
  );
  const leader = `Bearer ${created.leaderTokens.issue("a1", 60_000)}`;
  const task = { title: "网页挂了", part: "o2", deliver: "none" };
  const refused = await call(
    "POST",
    "/api/tasks",
    { ...task, urgent: true },
    leader,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body.message ?? refused.body.error, /a1 标紧急须写原因/);
  const stopgap = await call(
    "POST",
    "/api/tasks",
    { ...task, urgent: true, why: "挂了", stopgap: "atrium host pause h1" },
    leader,
  );
  assert.equal(stopgap.status, 403);
  assert.match(stopgap.body.message ?? stopgap.body.error, /不能写止损动作/);
  const made = await call(
    "POST",
    "/api/tasks",
    { ...task, urgent: true, why: "全景网页打不开" },
    leader,
  );
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.urgent_by, "a1");
  assert.equal(made.body.urgent_why, "全景网页打不开");
  for (const subscriber of ["secretary", "u1"]) {
    const marked = created.taskRunner.inbox
      .list(subscriber, { limit: 50 })
      .events.find((event) => event.kind === "urgent_marked");
    assert.match(
      (marked?.detail as { reason: string }).reason,
      /a1 把 t1 标为紧急：全景网页打不开/,
    );
  }
  // leader 派活时顺手标紧急同样要原因；用户不用。
  await call("POST", "/api/tasks", { ...task }, leader);
  const run = await call("POST", "/api/tasks/t2/run", { urgent: true }, leader);
  assert.equal(run.status, 400);
  assert.match(run.body.message ?? run.body.error, /a1 标紧急须写原因/);
  const set = await call("PATCH", "/api/tasks/t2", { urgent: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.urgent_by, null);
  assert.equal(set.body.urgent_warning, undefined, "两个以内不提示");
  const third = await call("POST", "/api/tasks", { ...task, urgent: true });
  assert.equal(
    third.body.urgent_warning,
    "紧急任务有 3 个，太多就等于没有紧急",
  );
  const top = (await call("GET", "/api/tasks/top", undefined)).body;
  assert.equal(top.urgent.count, 3);
  const line = renderStatusline({
    snapshot: top as never,
    plan: null,
    now: Date.now(),
    color: false,
  });
  assert.match(line, /! 紧急任务有 3 个，太多就等于没有紧急/);
});

function mergeDb() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const add = (id: number, urgent: number, stage: string, online = 0) =>
    db
      .prepare(
        "INSERT INTO tasks(id,title,deliver,status,delivery_stage,merge_queued_at,online_wait,urgent,repo,worktree,branch,pr_url,created_at,updated_at) VALUES (?,?,'pr','done',?,?,?,?,'/repo','/worktree','task','https://github.com/acme/demo/pull/1',1,?)",
      )
      .run(id, `t${id}`, stage, id, online, urgent, Date.now());
  const kinds = (id: number) =>
    (
      db
        .prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id")
        .all(id) as { kind: string }[]
    ).map((row) => row.kind);
  return { db, add, kinds };
}

test("合入暂停：有紧急任务已合入等上线时，其他任务的合入先暂停并记一笔；上线后接着合入", async () => {
  const { db, add, kinds } = mergeDb();
  add(1, 1, "merged", 1);
  add(2, 0, "merge_queued");
  const published: [number, string][] = [];
  const queue = new MergeQueue(db, {
    data: "/unused",
    env: {},
    run: async () => ({ ok: false, stdout: "", stderr: "离线" }),
    returned: async () => {},
    publish: (id, kind) => published.push([id, kind]),
    changed: () => {},
  });
  queue.kick();
  queue.kick();
  assert.deepEqual(kinds(2), ["merge_paused"], "同一段暂停只记一次");
  assert.deepEqual(published, [[2, "merge_paused"]]);
  const row = topRows(db, Date.now()).rows.find((item) => item.ref === "t2")!;
  assert.equal(row.holder?.text, "合入暂停：等紧急 t1 先上线");
  // 发版迟迟不来（超过发版超时提醒）就不再挡别的合入。
  assert.deepEqual(urgentInMergeFlow(db), [1]);
  assert.deepEqual(urgentInMergeFlow(db, Date.now() + 31 * 60_000), []);
  db.prepare(
    "UPDATE tasks SET delivery_stage='online',online_wait=0 WHERE id=1",
  ).run();
  queue.kick();
  await until(() => kinds(2).includes("merge_started"));
  await queue.close();
  db.close();
});

test("合入让路：正在合入的普通任务还没发出 gh 合入，紧急的来了就回到排队合入，紧急的先做", async () => {
  const { db, add, kinds } = mergeDb();
  add(2, 0, "merge_queued");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const queue = new MergeQueue(db, {
    data: "/unused",
    env: {},
    run: async () => {
      if (calls++ === 0) await gate;
      return { ok: false, stdout: "", stderr: "离线" };
    },
    returned: async () => {},
    publish: () => {},
    changed: () => {},
  });
  queue.kick();
  await until(() => kinds(2).includes("merge_started"));
  add(3, 1, "merge_queued");
  queue.kick();
  assert.ok(kinds(2).includes("merge_yield_requested"));
  release();
  await until(() => kinds(3).includes("merge_started"));
  assert.ok(kinds(2).includes("merge_yielded"));
  assert.equal(getTask(db, 2).delivery_stage, "merge_queued");
  assert.equal(getTask(db, 2).merge_queued_at, 2, "保留入队时刻");
  await queue.close();
  db.close();
});

test("审阅不挡合入：紧急任务要审阅的先合入，审阅并行；打回开跟进任务并投给负责人，阶段推给秘书与用户", async (t) => {
  let mergeCalls = 0;
  let merged = false;
  let headBranch = "";
  const { fx, data, call, taskRunner } = await startApp(t, (fixture) => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" }).trim();
    writeFileSync(
      join(fixture.workers, "harness", "kimi.md"),
      "---\ntrust: low\nmax_risk: low\nchecks: [pr_exists, claims_verified]\n---\n",
    );
    writeFileSync(
      join(fixture.workers, "harness", "grok.md"),
      "---\ntrust: medium\n---\n",
    );
    // 审阅者等合入后才给结论：证明合入不等审阅。
    fixture.script(
      "grok",
      `i=0; while [ ! -f '${join(fixture.root, "merged")}' ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done\necho '1. done.txt 少了换行'\necho '审阅结论：打回'`,
    );
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    writeFileSync(
      join(fixture.repo, "package.json"),
      JSON.stringify({ scripts: { check: "true" } }),
    );
    git("add", ".");
    git("commit", "-qm", "检查夹具");
    git("push", "-q", "origin", "main");
    fixture.script(
      "kimi",
      "set -e\necho change >> done.txt\ngit add done.txt\ngit commit -qm 修复\ngit push -q -u origin HEAD\necho 完成",
    );
    const origin = join(fixture.root, "origin.git");
    const remoteHead = () =>
      execFileSync(
        "git",
        ["--git-dir", origin, "rev-parse", `refs/heads/${headBranch}`],
        { encoding: "utf8" },
      ).trim();
    const fake: Exec = async (command, args, options) => {
      if (
        command === "git" &&
        args.includes("get-url") &&
        args.includes("origin")
      )
        return {
          ok: true,
          stdout: "https://github.com/acme/demo.git\n",
          stderr: "",
        };
      if (command !== "gh") return exec(command, args, options);
      if (args[0] === "pr" && args[1] === "list") {
        headBranch = args[args.indexOf("--head") + 1]!;
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              number: 1,
              url: "https://github.com/acme/demo/pull/1",
              state: "OPEN",
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "view")
        return {
          ok: true,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN",
            headRefOid: remoteHead(),
            headRefName: headBranch,
            baseRefName: "main",
            isCrossRepository: false,
          }),
          stderr: "",
        };
      if (args[0] === "pr" && args[1] === "merge") {
        mergeCalls++;
        merged = true;
        writeFileSync(join(fixture.root, "merged"), "");
        return { ok: true, stdout: "merged", stderr: "" };
      }
      return {
        ok: false,
        stdout: "",
        stderr: `unexpected gh ${args.join(" ")}`,
      };
    };
    fixture.run = fake;
  });
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", {
    title: "修线上",
    repo: fx.repo,
    urgent: true,
  });
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "kimi" })).status,
    200,
  );
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=40");
  assert.equal(waited.body.task.delivery_stage, "merged");
  assert.equal(mergeCalls, 1);
  const kinds = kindsOf(db, "t1");
  assert.ok(kinds.includes("review_parallel"));
  assert.ok(!kinds.includes("review_needed"), "没有进审阅关卡等结论");
  await until(() => kindsOf(db, "t1").includes("review_rejected"), 30_000);
  const rejected = detailsOf(db, "t1", "review_rejected")[0];
  assert.equal(rejected.after_merge, true);
  const followup = getTask(db, rejected.followup);
  assert.match(followup.title, /^跟进 t1 的审阅意见：修线上/);
  assert.match(followup.brief ?? "", /done\.txt 少了换行/);
  assert.equal(followup.urgent, 0);
  const inbox = taskRunner.inbox.list("secretary", { limit: 100 }).events;
  assert.ok(inbox.some((event) => event.kind === "review_followup"));
  // 审阅任务自己的结局不单独投递。
  const reviewer = detailsOf(db, "t1", "review_started")[0].reviewer as string;
  assert.ok(!inbox.some((event) => event.task === reviewer));
  // 阶段推送：秘书与用户各一条（同一任务合成最新阶段），最后是合入。
  for (const subscriber of ["secretary", "u1"]) {
    const stage = taskRunner.inbox
      .list(subscriber, { limit: 100 })
      .events.filter((event) => event.kind === "urgent_stage");
    assert.equal(stage.length, 1);
    assert.equal((stage[0]!.detail as { stage: string }).stage, "合入");
  }
});

test("盯到底：紧急任务的执行者没进展就换执行者在原工作树接着做，不等卡死判定", async (t) => {
  const { fx, data, call } = await startApp(
    t,
    (fixture) => {
      const bin = join(fixture.root, "bin");
      removeFakeBin(join(bin, "opencode"));
      fixture.env.PATH = isolatedPath(bin);
      // 启动判卡死放到 1 分钟：只有换人能先把它换下来。
      writeFileSync(
        join(fixture.workers, "harness", "grok.md"),
        "---\nlimits: {startup_minutes: 1}\n---\n",
      );
    },
    undefined,
    undefined,
    { urgentIdleMs: 300 },
  );
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", {
    title: "紧急修",
    repo: fx.repo,
    urgent: true,
  });
  const run = await call("POST", "/api/tasks/t1/run", { worker: "grok" });
  assert.match(run.body.task.worker, /^grok/);
  await until(() => kindsOf(db, "t1").includes("urgent_swap"), 20_000);
  const swap = detailsOf(db, "t1", "urgent_swap")[0];
  assert.match(swap.from, /^grok/);
  assert.match(swap.to, /^kimi/);
  assert.equal(
    swap.reason,
    "紧急任务的执行者 300 毫秒没有进展，换执行者接着做",
  );
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.match(done.body.task.worker, /^kimi/);
  const tells = detailsOf(db, "t1", "tell");
  assert.ok(
    tells.some((tell) => /前一位执行者（grok\S*）已停下/.test(tell.text)),
  );
  assert.ok(!kindsOf(db, "t1").includes("stalled"));
});

test("旧库启动：补上紧急通道的列与表，可重复执行；旧运行时的表原样不动", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, title TEXT NOT NULL,
      brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER, worktree TEXT,
      branch TEXT, pr_url TEXT, ci TEXT, result TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO tasks(title,status,created_at,updated_at) VALUES ('紧急：旧任务','todo',0,0);`);
  ensureTaskTables(db);
  ensureTaskTables(db);
  const task = getTask(db, "t1");
  assert.equal(task.urgent, 0, "标题写紧急不算");
  assert.equal(task.urgent_why, null);
  assert.deepEqual(task.avoid_host_refs, []);
  for (const table of ["task_preemptions", "task_after_reviews"])
    assert.ok(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
      table,
    );
  assert.deepEqual(
    db
      .prepare("SELECT id,name FROM agents")
      .all()
      .map((row) => ({ ...row })),
    [{ id: "x", name: "旧身份" }],
  );
  db.close();
});
