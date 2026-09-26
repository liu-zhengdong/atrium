import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedFunctions,
  ciFromChecks,
  evaluateGates,
  extractClaims,
  parseNumstat,
  type Facts,
} from "../server/tasks/gates.ts";
import { judge, watchLimits } from "../server/tasks/watchdog.ts";
import { countSteps, summarize } from "../server/tasks/summary.ts";
import { workerEnvironment } from "../server/tasks/worker-env.ts";
import { EventInbox, ackIds } from "../server/tasks/events.ts";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import { TaskRunner } from "../server/tasks/runner.ts";
import { exec, type Exec } from "../server/tasks/git.ts";
import { createApp } from "../server/app.ts";

const baseFacts: Facts = {
  repo: true,
  branch: "task-t1-x",
  base: "main",
  pr: null,
  ci: null,
  numstat: [],
  functions: [],
  dirty: [],
  ahead: 1,
  pushed: true,
  claims: [],
};

test("关卡解析：numstat、CI 汇总、新增函数长度、摘要里的声明", () => {
  assert.deepEqual(parseNumstat("3\t1\ta.ts\n-\t-\tlogo.png\n"), [
    { file: "a.ts", added: 3, removed: 1 },
    { file: "logo.png", added: 0, removed: 0 },
  ]);
  assert.equal(ciFromChecks([]), null);
  assert.equal(
    ciFromChecks([{ bucket: "pass" }, { bucket: "skipping" }]),
    "success",
  );
  assert.equal(
    ciFromChecks([{ bucket: "pass" }, { bucket: "pending" }]),
    "pending",
  );
  assert.equal(
    ciFromChecks([{ bucket: "pending" }, { bucket: "fail" }]),
    "failure",
  );

  const body = Array.from({ length: 90 }, (_, i) => `+  const v${i} = ${i};`);
  const diff = [
    "+++ b/src/big.ts",
    "@@ -0,0 +1,95 @@",
    "+export function huge(a: number) {",
    ...body,
    "+  if (a) {",
    "+    return 1;",
    "+  }",
    "+}",
    "+const small = (x: number) => x + 1;",
    "+++ b/app.py",
    "@@ -0,0 +1,3 @@",
    "+def tiny():",
    "+    return 1",
  ].join("\n");
  assert.deepEqual(addedFunctions(diff), [
    { file: "src/big.ts", name: "huge", lines: 95 },
    { file: "src/big.ts", name: "small", lines: 1 },
    { file: "app.py", name: "tiny", lines: 2 },
  ]);

  assert.deepEqual(
    extractClaims(
      "开了 PR #45（https://github.com/o/r/pull/45），提交 a1b2c3d，Closes #262，数字 1234567 与单词 deadbeef 不算",
    ),
    [
      { kind: "pr", value: "45" },
      { kind: "commit", value: "a1b2c3d" },
    ],
  );
});

test("关卡判定：没 PR 写明原因、只差 CI 标等待、上帝文件与虚报打回", () => {
  const noPr = evaluateGates(
    ["pr_exists", "ci"],
    {},
    {
      ...baseFacts,
      prError: "none of the git remotes point to a known GitHub host",
    },
  );
  assert.equal(noPr.passed, false);
  assert.equal(noPr.awaitingCi, false);
  assert.match(
    noPr.failed[0]!.evidence,
    /gh pr list --head task-t1-x 没找到 PR.*GitHub host/,
  );

  const pr = { number: 7, url: "https://x/pull/7", state: "OPEN" };
  const waiting = evaluateGates(
    ["pr_exists", "ci", "finished"],
    {},
    {
      ...baseFacts,
      pr,
      ci: "pending",
    },
  );
  assert.equal(waiting.passed, false);
  assert.equal(waiting.awaitingCi, true);

  const done = evaluateGates(
    ["pr_exists", "ci", "finished"],
    {},
    {
      ...baseFacts,
      pr,
      ci: "success",
    },
  );
  assert.equal(done.passed, true);

  const unfinished = evaluateGates(
    ["finished"],
    {},
    {
      ...baseFacts,
      dirty: ["a.ts"],
      pushed: false,
      ahead: 0,
    },
  );
  assert.match(
    unfinished.failed[0]!.evidence,
    /未提交.*没有新提交.*未推送.*PR 没开/,
  );

  const growth = evaluateGates(
    ["file_growth"],
    { max_file_added_lines: 300, max_function_lines: 80 },
    {
      ...baseFacts,
      numstat: [{ file: "god.ts", added: 900, removed: 0 }],
      functions: [{ file: "god.ts", name: "all", lines: 120 }],
    },
  );
  assert.match(
    growth.failed[0]!.evidence,
    /god\.ts 新增 900 行.*all 有 120 行/,
  );

  const lies = evaluateGates(
    ["claims_verified", "bogus"],
    {},
    {
      ...baseFacts,
      claims: [
        {
          kind: "pr",
          value: "99",
          ok: false,
          detail: "no pull requests found",
        },
        { kind: "commit", value: "abc1234", ok: true },
      ],
    },
  );
  assert.equal(lies.failed.length, 2);
  assert.match(lies.failed[0]!.evidence, /PR #99/);
  assert.match(lies.failed[1]!.evidence, /不认识/);
});

test("看门狗判定：启动无进展判卡死，运行中空闲判受阻；档案 limits 可收紧", () => {
  const limits = { startupMs: 180_000, idleMs: 1_200_000 };
  assert.equal(
    judge({ startedAt: 0, lastProgressAt: null }, limits, 179_999).kind,
    "ok",
  );
  const stalled = judge(
    { startedAt: 0, lastProgressAt: null },
    limits,
    180_000,
  );
  assert.equal(stalled.kind, "stalled");
  assert.match((stalled as { reason: string }).reason, /3 分钟没有任何进展/);
  assert.equal(
    judge({ startedAt: 0, lastProgressAt: 10 }, limits, 1_000_000).kind,
    "ok",
  );
  assert.equal(
    judge({ startedAt: 0, lastProgressAt: 10 }, limits, 1_200_010).kind,
    "idle",
  );
  assert.deepEqual(
    watchLimits({ startupMinutes: 3, idleMinutes: 20 }, { startup_minutes: 1 }),
    {
      startupMs: 60_000,
      idleMs: 1_200_000,
    },
  );
});

test("摘要：opencode JSON 取文本、claude 取 result、普通日志取末尾", () => {
  const opencode = [
    '{"type":"step_start","part":{}}',
    '{"type":"text","part":{"text":"改好了，PR #3"}}',
    '{"type":"step_finish","part":{}}',
  ].join("\n");
  assert.equal(summarize(opencode), "改好了，PR #3");
  assert.equal(countSteps(opencode), 2);
  const claude = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"中间"}]}}',
    '{"type":"result","result":"最终汇报"}',
  ].join("\n");
  assert.equal(summarize(claude), "最终汇报");
  assert.equal(summarize("a\nb\n"), "a\nb");
  assert.equal(Buffer.byteLength(summarize("汉".repeat(5000))) <= 4096, true);
});

test("执行者环境白名单：去掉 HERDR_*、CLAUDECODE、CLAUDE_CODE_*、PI_*、ATRIUM_* 与凭据", () => {
  const env = workerEnvironment({
    PATH: "/bin",
    HOME: "/h",
    LC_ALL: "C",
    HTTPS_PROXY: "http://p",
    HERDR_PANE: "1",
    HERDR_ENV: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    PI_SESSION_ID: "s",
    ATRIUM_DATA: "/d",
    ATRIUM_PORT: "4310",
    GH_TOKEN: "t",
    OPENAI_API_KEY: "k",
    NODE_TEST_CONTEXT: "child",
    SSH_AUTH_SOCK: "/s",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "GH_PROMPT_DISABLED",
    "GIT_PAGER",
    "HOME",
    "HTTPS_PROXY",
    "LC_ALL",
    "NO_COLOR",
    "PAGER",
    "PATH",
  ]);
});

test("事件队列：落库、同键合并、攒批窗口、wait 唤醒、ack 后不再投递", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const waiting = inbox.wait("secretary", 5);
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "blocked",
    key: "t1:outcome",
    detail: { n: 1 },
  });
  const first = await waiting;
  assert.equal(first.events.length, 1);
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "done",
    key: "t1:outcome",
    detail: { n: 2 },
  });
  inbox.publish({
    subscriber: "lead",
    source: "ci",
    kind: "ci_success",
    key: "t2:ci",
  });
  const merged = await inbox.wait("secretary", 0);
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0]!.count, 2);
  assert.equal(merged.events[0]!.kind, "done");
  assert.deepEqual(merged.events[0]!.detail, { n: 2 });
  assert.deepEqual(inbox.ack([merged.events[0]!.id, 999]), {
    acked: [merged.events[0]!.id],
    missing: [999],
  });
  assert.equal((await inbox.wait("secretary", 0)).events.length, 0);
  assert.equal((await inbox.wait("lead", 0)).events.length, 1);
  assert.throws(() => ackIds({ ids: ["x"] }), /正整数/);
  assert.throws(() => ackIds({ ids: [] }), /至少/);
  await assert.rejects(inbox.wait("有 空格", 0), /订阅者名/);

  const batched = new EventInbox(db, 150);
  batched.publish({
    subscriber: "batch",
    source: "runner",
    kind: "done",
    key: "t3:outcome",
  });
  assert.equal(
    (await batched.wait("batch", 0)).events.length,
    0,
    "窗口内不投递",
  );
  const later = await batched.wait("batch", 2);
  assert.equal(later.events.length, 1, "窗口结束后唤醒");
  batched.close();
  inbox.close();
});

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: home,
    HERDR_PANE: "9",
    CLAUDECODE: "1",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).trim();
  execFileSync("git", [
    "init",
    "--bare",
    "-q",
    "-b",
    "main",
    join(root, "origin.git"),
  ]);
  mkdirSync(join(root, "repo"));
  git(join(root, "repo"), "init", "-q", "-b", "main");
  writeFileSync(join(root, "repo", "README.md"), "# demo\n");
  git(join(root, "repo"), "add", ".");
  git(join(root, "repo"), "commit", "-qm", "init");
  git(join(root, "repo"), "remote", "add", "origin", join(root, "origin.git"));
  git(join(root, "repo"), "push", "-q", "-u", "origin", "main");
  mkdirSync(join(root, "bin"));
  const script = (name: string, body: string) => {
    const file = join(root, "bin", name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // 假 kimi：记下环境、改一个文件并提交，汇报提交号；不开 PR。
  script(
    "kimi",
    'env > "$PWD/../env-seen.txt"\necho working\necho hi > done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"',
  );
  // 假 grok：故意什么都不输出，也不改文件。
  script("grok", "sleep 30");
  // 假 opencode：独占工具，输出结构化步骤后退出。
  script(
    "opencode",
    'echo \'{"type":"step_start","part":{}}\'\nsleep 0.6\necho \'{"type":"text","part":{"text":"ok"}}\'',
  );
  const workers = join(root, "workers");
  mkdirSync(join(workers, "harness"), { recursive: true });
  writeFileSync(
    join(workers, "harness", "kimi.md"),
    "---\nmax_risk: low\nchecks: [pr_exists, claims_verified]\n---\n假 kimi 的叮嘱\n",
  );
  writeFileSync(
    join(workers, "harness", "grok.md"),
    "---\nlimits: {startup_minutes: 0.01}\n---\n",
  );
  writeFileSync(
    join(workers, "harness", "opencode.md"),
    "---\nchecks: []\n---\n",
  );
  // gh 一律当作非 GitHub 仓库：pr_exists 应判不过并写明原因。
  const run: Exec = (command, args, options) =>
    command === "gh"
      ? Promise.resolve({
          ok: false,
          stdout: "",
          stderr:
            "none of the git remotes configured for this repository point to a known GitHub host",
        })
      : exec(command, args, options);
  return { root, repo: join(root, "repo"), env, workers, run };
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("派活闭环：建 worktree、白名单环境拉起、日志落盘、关卡判受阻、事件投递；破坏输入被拒", async (t) => {
  const fx = fixture(t);
  const data = join(fx.root, "data");
  const { app } = await createApp({
    data,
    runtime: false,
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      tickMs: 100,
      killGraceMs: 200,
      pace: async () => undefined,
    },
  });
  t.after(() => app.close());
  const headers = { host: "127.0.0.1" };
  const call = async (
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json() };
  };
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "Add done file",
        repo: fx.repo,
      })
    ).status,
    201,
  );

  assert.match(
    (await call("POST", "/api/tasks/t1/run", { worker: "nope" })).body.error,
    /未知的执行者工具/,
  );
  assert.match(
    (await call("POST", "/api/tasks/t1/run", { worker: "kimi", risk: "high" }))
      .body.error,
    /max_risk=low/,
  );
  assert.match(
    (await call("POST", "/api/tasks/t1/run", { worker: "codex", extra: 1 }))
      .body.error,
    /不认识的字段/,
  );
  assert.equal(
    (await call("POST", "/api/tasks/t9/run", { worker: "kimi" })).status,
    404,
  );

  const started = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.task.status, "running");
  assert.equal(started.body.task.branch, "task-t1-add-done-file");
  assert.equal(started.body.task.worktree, `${fx.repo}-t1-add-done-file`);
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "kimi" })).status,
    409,
  );

  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(waited.body.timed_out, false);
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const task = getTask(db, "t1");
  assert.equal(task.status, "blocked");
  assert.match(task.result ?? "", /完成，提交 [0-9a-f]{7}/);
  const gates = task.events.find((event) => event.kind === "gates");
  assert.ok(gates);
  const verdict = JSON.parse(gates.detail!);
  assert.equal(verdict.passed, false);
  assert.deepEqual(
    verdict.results.map((r: { gate: string; ok: boolean }) => [r.gate, r.ok]),
    [
      ["pr_exists", false],
      ["claims_verified", true],
    ],
  );
  const block = task.events.find((event) => event.kind === "block");
  assert.match(
    block!.detail!,
    /pr_exists：gh pr list --head task-t1-add-done-file 没找到 PR.*GitHub host/,
  );
  assert.equal(verdict.diff.added, 1);

  const prompt = execFileSync("cat", [join(data, "tasks", "1", "prompt.md")], {
    encoding: "utf8",
  });
  assert.match(prompt, /# 任务：Add done file/);
  assert.match(prompt, /假 kimi 的叮嘱/);
  assert.match(prompt, /停在 PR/);
  assert.match(prompt, /4310/);
  const seen = execFileSync("cat", [join(fx.root, "env-seen.txt")], {
    encoding: "utf8",
  });
  assert.doesNotMatch(seen, /HERDR_|CLAUDECODE|ATRIUM_/);

  const log = await call("GET", "/api/tasks/t1/log?after=0");
  assert.match(log.body.text, /working/);
  assert.match(log.body.text, /\[atrium\] .*退出码 0/);
  assert.equal(log.body.running, false);
  assert.equal((await call("GET", "/api/tasks/t1/log?after=-1")).status, 400);

  const events = await call("GET", "/api/events/wait?as=secretary&timeout=0");
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].task, "t1");
  assert.equal(events.body.events[0].kind, "blocked");
  assert.match(events.body.events[0].detail.reason, /关卡不过/);
  assert.deepEqual(
    (await call("POST", "/api/events/ack", { ids: [events.body.events[0].id] }))
      .body.acked,
    [events.body.events[0].id],
  );
  assert.equal(
    (await call("GET", "/api/events/wait?as=secretary&timeout=0")).body.events
      .length,
    0,
  );
  assert.equal(
    (await call("GET", "/api/events/wait?as=secretary&timeout=x")).status,
    400,
  );
});

test("看门狗：假执行者零输出判卡死、按档案重试一次后失败；独占工具排队；stop 停进程", async (t) => {
  const fx = fixture(t);
  const data = join(fx.root, "data");
  const { app } = await createApp({
    data,
    runtime: false,
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      tickMs: 100,
      killGraceMs: 200,
      pace: async () => undefined,
    },
  });
  t.after(() => app.close());
  const headers = { host: "127.0.0.1" };
  const call = async (
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json() };
  };
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "silent" });
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "grok" })).body.task
      .status,
    "running",
  );
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(waited.body.task.status, "failed");
  const kinds = getTask(db, "t1").events.map((event) => event.kind);
  assert.deepEqual(
    kinds.filter((kind) => ["start", "stalled", "exit_fail"].includes(kind)),
    ["start", "stalled", "exit_fail", "start", "stalled", "exit_fail"],
  );
  const outcome = (await call("GET", "/api/events/wait?as=secretary&timeout=0"))
    .body.events;
  assert.equal(outcome.length, 1, "卡死与最终失败按同一去重键合并");
  assert.equal(outcome[0].kind, "failed");
  assert.equal(outcome[0].count, 2);
  assert.match(outcome[0].detail.reason, /没有任何进展信号/);

  await call("POST", "/api/tasks", { title: "oc one" });
  await call("POST", "/api/tasks", { title: "oc two" });
  assert.equal(
    (await call("POST", "/api/tasks/t2/run", { worker: "opencode" })).body
      .queued,
    false,
  );
  const second = await call("POST", "/api/tasks/t3/run", {
    worker: "opencode",
  });
  assert.equal(second.body.queued, true);
  assert.equal(second.body.task.status, "todo");
  assert.equal(
    (await call("GET", "/api/tasks/t3/wait?timeout=20")).body.task.status,
    "done",
  );
  const t3 = getTask(db, "t3").events.map((event) => event.kind);
  assert.ok(t3.indexOf("queued") < t3.indexOf("start"));
  const t2 = getTask(db, "t2");
  assert.ok(t2.ended_at! <= getTask(db, "t3").started_at!, "独占工具不重叠");

  await call("POST", "/api/tasks", { title: "to stop" });
  const running = await call("POST", "/api/tasks/t4/run", { worker: "grok" });
  const pid = running.body.task.pid as number;
  const stop = await call("POST", "/api/tasks/t4/stop");
  assert.equal(stop.body.stopping, true);
  assert.equal(
    (await call("GET", "/api/tasks/t4/wait?timeout=10")).body.task.status,
    "failed",
  );
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal((await call("POST", "/api/tasks/t4/stop")).status, 409);
});

test("服务重启自愈：running 且 pid 已不在的任务置 failed 并投递事件", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-recover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  createTask(db, { title: "orphan" });
  advanceTask(
    db,
    "t1",
    { kind: "start" },
    { worker: "kimi", pid: 2 ** 22 + 12345 },
  );
  const runner = new TaskRunner(db, {
    data: root,
    workersDir: join(root, "none"),
    env: { PATH: "/usr/bin:/bin" },
  });
  await runner.recover();
  const task = getTask(db, "t1");
  assert.equal(task.status, "failed");
  assert.match(task.events.at(-1)!.detail!, /服务重启时执行者进程已不在/);
  const events = await runner.inbox.wait("secretary", 0);
  assert.equal(events.events[0]!.kind, "failed");
  runner.close();
  assert.equal(existsSync(join(root, "tasks")), false);
});

test("CI 轮询：只查 pending 且有 PR 的任务；只差 CI 的受阻任务在 CI 通过后补判完成", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const calls: string[][] = [];
  const run: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const url = args[2]!;
    const bucket = url.endsWith("/1")
      ? "pass"
      : url.endsWith("/2")
        ? "fail"
        : "pending";
    return {
      ok: bucket === "pass",
      stdout: JSON.stringify([{ name: "check", bucket }]),
      stderr: "",
    };
  };
  for (const n of [1, 2, 3]) {
    createTask(db, { title: `t${n}` });
    advanceTask(db, `t${n}`, { kind: "start" }, { worker: "kimi" });
    advanceTask(
      db,
      `t${n}`,
      { kind: "block" },
      { pr_url: `https://x/pull/${n}`, ci: "pending" },
    );
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)",
    ).run(n, Date.now(), "gates", JSON.stringify({ awaiting_ci: true }));
  }
  createTask(db, { title: "no pr" });
  const runner = new TaskRunner(db, {
    data: root,
    exec: run,
    env: { PATH: "/bin" },
  });
  await runner.pollCi();
  assert.equal(calls.length, 3, "没有 PR 的任务不查");
  assert.equal(getTask(db, "t1").status, "done");
  assert.equal(getTask(db, "t1").ci, "success");
  assert.equal(getTask(db, "t2").status, "blocked");
  assert.equal(getTask(db, "t2").ci, "failure");
  assert.equal(getTask(db, "t3").ci, "pending");
  const events = (await runner.inbox.wait("secretary", 0)).events;
  assert.deepEqual(
    events.map((event) => [event.task, event.kind]),
    [
      ["t1", "ci_success"],
      ["t2", "ci_failure"],
    ],
  );
  await runner.pollCi();
  assert.equal(calls.length, 4, "出结果的不再查，只剩 t3");
  runner.close();
});
