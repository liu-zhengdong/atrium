import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { processAlive } from "../server/platform/index.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exec, type Exec } from "../server/tasks/git.ts";
import {
  MAX_MERGE_RETURNS,
  mergeFailure,
} from "../server/tasks/merge-decision.ts";
import { eventTrail, startApp } from "./task-fixture.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { MergeQueue } from "../server/tasks/merge-runtime.ts";
import { MergeClaim } from "../server/tasks/merge-claim.ts";
import { getTask } from "../server/tasks/ledger.ts";
import { listTells } from "../server/tasks/tell-ledger.ts";
import { whoLabel } from "../server/tasks/holder.ts";
import { createApp } from "../server/app.ts";
import { nodeCommand, sleepCommand, TRUE_COMMAND } from "./portable-shell.ts";

test("合入失败次数的边界", () => {
  assert.deepEqual(mergeFailure(0, "冲突"), {
    returns: 1,
    blocked: false,
    reason: "冲突",
  });
  assert.deepEqual(mergeFailure(1, "失败"), {
    returns: 2,
    blocked: false,
    reason: "失败",
  });
  assert.deepEqual(mergeFailure(MAX_MERGE_RETURNS, "失败"), {
    returns: 3,
    blocked: true,
    reason: "失败",
  });
});

test("合入队列按入队时间处理，后续任务更新时间不插队", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const insert = db.prepare(
    "INSERT INTO tasks(title,deliver,status,delivery_stage,merge_queued_at,created_at,updated_at) VALUES (?,'pr','done','merge_queued',?,?,?)",
  );
  insert.run("先入队", 100, 1, 900);
  insert.run("后入队", 200, 2, 200);
  const queue = new MergeQueue(db, {
    data: "/unused",
    env: {},
    run: async () => ({ ok: false, stdout: "", stderr: "unused" }),
    returned: async () => {},
    publish: () => {},
    changed: () => {},
  });
  queue.kick();
  const until = Date.now() + 1000;
  while (
    !db
      .prepare("SELECT 1 FROM task_events WHERE kind='merge_retry' LIMIT 1")
      .get()
  ) {
    assert.ok(Date.now() < until, "队列没有处理队首");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const started = db
    .prepare(
      "SELECT task_id FROM task_events WHERE kind='merge_started' ORDER BY id LIMIT 1",
    )
    .get() as { task_id: number };
  assert.equal(started.task_id, 1);
  await queue.close();
  db.close();
});

test("两个流程争同一合入占用，旧进程退出后接管", () => {
  const db = new DatabaseSync(":memory:");
  const first = new MergeClaim(db);
  const second = new MergeClaim(db);
  assert.equal(first.acquire(1), true);
  assert.equal(second.acquire(1), false);
  first.release();
  assert.equal(second.acquire(1), true);
  second.release();
  db.prepare(
    "INSERT INTO merge_claim(id,task_id,pid,token) VALUES (1,1,?,?)",
  ).run(2147483647, "dead");
  assert.equal(first.acquire(1), true);
  first.release();
  db.close();
});

test("合入流程尚在外部命令中时，第二队列不能启动同一任务", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  db.prepare(
    "INSERT INTO tasks(title,deliver,status,delivery_stage,merge_queued_at,repo,worktree,branch,pr_url,created_at,updated_at) VALUES ('并发','pr','done','merge_queued',1,'/repo','/worktree','task','https://github.com/acme/demo/pull/1',1,1)",
  ).run();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = {
    data: "/unused",
    env: {},
    returned: async () => {},
    publish: () => {},
    changed: () => {},
  };
  const first = new MergeQueue(db, {
    ...options,
    run: async () => {
      await held;
      return { ok: false, stdout: "", stderr: "stopped" };
    },
  });
  const second = new MergeQueue(db, {
    ...options,
    run: async () => ({ ok: false, stdout: "", stderr: "unused" }),
  });
  const starts = () =>
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM task_events WHERE kind='merge_started'",
        )
        .get() as { n: number }
    ).n;
  first.kick();
  assert.equal(starts(), 1);
  second.kick();
  assert.equal(starts(), 1);
  const closing = first.close();
  release();
  await closing;
  second.kick();
  assert.equal(starts(), 2);
  await second.close();
  db.close();
});

test("重新排队拒绝无 PR 与交付关卡未通过", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const insert = db.prepare(
    "INSERT INTO tasks(title,deliver,status,repo,worktree,branch,pr_url,created_at,updated_at) VALUES (?,'pr','blocked','/repo','/worktree','task',?,1,1)",
  );
  insert.run("无 PR", null);
  insert.run("关卡失败", "https://github.com/acme/demo/pull/1");
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (2,1,'gates',?)",
  ).run(JSON.stringify({ passed: false }));
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (2,1,'merge_queued','{}')",
  ).run();
  const queue = new MergeQueue(db, {
    data: "/unused",
    env: {},
    run: async () => ({ ok: false, stdout: "", stderr: "unused" }),
    returned: async () => {},
    publish: () => {},
    changed: () => {},
  });
  assert.throws(() => queue.requeue(1), /没有可合入的 PR/);
  assert.throws(() => queue.requeue(2), /未通过交付关卡/);
  await queue.close();
  db.close();
});

test("合入队列交回执行者的捎话署名运行时，不冒用用户", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  db.prepare(
    "INSERT INTO tasks(title,deliver,status,delivery_stage,repo,worktree,branch,pr_url,created_at,updated_at) VALUES ('交回','pr','done','merging','/repo','/worktree','task','https://github.com/acme/demo/pull/1',1,1)",
  ).run();
  const queue = new MergeQueue(db, {
    data: "/unused",
    env: {},
    run: async () => ({ ok: false, stdout: "", stderr: "unused" }),
    returned: async () => {},
    publish: () => {},
    changed: () => {},
  });
  await queue.handBack(getTask(db, 1), "rebase 冲突：a.ts");
  const [tell] = listTells(db, 1);
  assert.equal(tell?.by, "runtime");
  assert.match(tell!.text, /合入队列交回（第 1 次）/);
  assert.equal(whoLabel("runtime"), "运行时");
  await queue.close();
  db.close();
});

test("任务取消后立即移除有未提交文件的工作树", async (t) => {
  const { fx, call, app } = await startApp(t);
  const created = await call("POST", "/api/tasks", {
    title: "取消任务",
    repo: fx.repo,
  });
  assert.equal(created.status, 201);
  const ref = created.body.ref as string;
  const started = await call("POST", `/api/tasks/${ref}/run`, {
    worker: "kimi",
  });
  assert.equal(started.status, 200);
  const path = started.body.task.worktree as string;
  const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=20`);
  assert.equal(waited.body.task.status, "blocked");
  writeFileSync(join(path, "untracked.txt"), "unfinished");
  const cancelled = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${ref}`,
    headers: { host: "127.0.0.1" },
    payload: { status: "cancelled" },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().worktree, null);
  assert.equal(existsSync(path), false);
});

for (const scenario of [
  "success",
  "rebase_success",
  "return_then_merge",
  "conflict",
  "check_failed",
  "merge_failed",
  "push_failed",
  "wrong_origin",
  "stopped",
  "restart_check",
  "head_changed",
  "stale_pr_head",
  "stale_pr_head_timeout",
  "not_run_then_merge",
  "not_run_blocked",
  "stalled_blocked",
  "deps_failed_then_merge",
] as const) {
  test(`隔离服务与假 gh/执行者：${scenario}`, async (t) => {
    let merged = false;
    let mergeCalls = 0;
    let headBranch = "";
    let advancedMain = false;
    let pushed = false;
    let staleViews = 0;
    let originalHead = "";
    const {
      fx,
      data,
      app,
      call: firstCall,
    } = await startApp(
      t,
      (fixture) => {
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: fixture.repo,
            encoding: "utf8",
          }).trim();
        // 可信执行者、低风险：不经审阅直接进合入队列（审阅分支见 task-review.test.ts）。
        writeFileSync(
          join(fixture.workers, "harness", "kimi.md"),
          "---\ntrust: medium\nmax_risk: low\nchecks: [pr_exists, claims_verified]\n---\n",
        );
        git("config", "user.name", "test");
        git("config", "user.email", "test@example.com");
        writeFileSync(join(fixture.repo, "done.txt"), "base\n");
        writeFileSync(
          join(fixture.repo, "package.json"),
          JSON.stringify({
            scripts: {
              check:
                // 时长敏感用例（t204）：第一次（或每次）挂在登记过的慢用例上，算没跑成、自动重跑。
                scenario === "not_run_then_merge" ||
                scenario === "not_run_blocked"
                  ? nodeCommand(
                      `const fs=require('fs');const f=process.argv[1];const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));if(n<${scenario === "not_run_then_merge" ? 1 : 99}){console.log('not ok 1 - 慢用例：等后台服务');process.exit(1)}`,
                      join(fixture.root, "check-runs"),
                    )
                  : scenario === "stalled_blocked"
                    ? // 输出一行后挂住（t260）：没输出到结束线被结束，没有失败用例算没跑成（卡住）。
                      nodeCommand(
                        "console.log('✔ 前面的用例 (1ms)'); setTimeout(() => {}, 60000)",
                      )
                    : scenario === "check_failed"
                      ? nodeCommand(
                          "console.log('not ok 1 - 故意失败'); process.exit(1)",
                        )
                      : scenario === "stopped"
                        ? // 常驻不退、再起一个常驻的孙进程并记下 pid：停止合入时整棵树都得结束（t167）。
                          nodeCommand(
                            "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); require('node:fs').writeFileSync(process.argv[1], String(g.pid)); setInterval(() => {}, 1000)",
                            join(fixture.root, "check-pid"),
                          )
                        : scenario === "restart_check"
                          ? sleepCommand(2)
                          : TRUE_COMMAND,
            },
          }),
        );
        mkdirSync(join(fixture.repo, ".agents"), { recursive: true });
        writeFileSync(
          join(fixture.repo, ".agents", "timing-sensitive"),
          "# 慢用例\n慢用例：\n",
        );
        if (scenario === "deps_failed_then_merge") {
          // 工作树没有 node_modules：检查前要 npm ci。假 npm 第一次断网失败（输出里带令牌），第二次装上（t216）。
          writeFileSync(join(fixture.repo, "package-lock.json"), "{}\n");
          // 和真实仓库一样忽略 node_modules（装依赖的记号也在里面），检查后工作树仍算干净。
          writeFileSync(join(fixture.repo, ".gitignore"), "node_modules\n");
          const runs = join(fixture.root, "npm-runs").replaceAll("\\", "/");
          fixture.script(
            "npm",
            `n=$(cat "${runs}" 2>/dev/null || echo 0)\necho $((n+1)) > "${runs}"\nif [ "$n" -lt 1 ]; then\n  echo 'npm ERR! network request failed'\n  echo '//registry.npmjs.org/:_authToken=abcdef123456secret'\n  exit 1\nfi\nmkdir -p node_modules\necho installed`,
          );
        }
        git("add", ".");
        git("commit", "-qm", "检查夹具");
        git("push", "-q", "origin", "main");
        fixture.script(
          "kimi",
          `set -e\necho change >> done.txt\ngit add done.txt\ngit commit -qm 修复\ngit push ${scenario === "push_failed" ? "--force-with-lease " : ""}-q -u origin HEAD\necho 完成`,
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
          if (
            scenario === "push_failed" &&
            command === "git" &&
            args.some((arg) => arg.startsWith("--force-with-lease="))
          )
            return { ok: false, stdout: "", stderr: "push rejected" };
          if (
            command === "git" &&
            args.some((arg) => arg.startsWith("--force-with-lease="))
          ) {
            const result = await exec(command, args, options);
            pushed = result.ok;
            if (scenario === "head_changed" && result.ok)
              execFileSync("git", [
                "--git-dir",
                join(fixture.root, "origin.git"),
                "update-ref",
                `refs/heads/${headBranch}`,
                originalHead,
              ]);
            return result;
          }
          if (command !== "gh") return exec(command, args, options);
          assert.equal(args[args.indexOf("-R") + 1], "acme/demo");
          if (args[0] === "pr" && args[1] === "list") {
            headBranch = args[args.indexOf("--head") + 1]!;
            if (
              (scenario === "conflict" ||
                scenario === "rebase_success" ||
                scenario === "push_failed" ||
                scenario === "head_changed" ||
                scenario === "stale_pr_head" ||
                scenario === "stale_pr_head_timeout") &&
              !advancedMain
            ) {
              advancedMain = true;
              const changed =
                scenario === "conflict" ? "done.txt" : "README.md";
              writeFileSync(join(fixture.repo, changed), "main change\n");
              git("add", changed);
              git("commit", "-qm", "主线改动");
              git("push", "-q", "origin", "main");
            }
            return {
              ok: true,
              stdout: JSON.stringify([
                {
                  number: 1,
                  url: `https://github.com/acme/${scenario === "wrong_origin" ? "other" : "demo"}/pull/1`,
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
                headRefOid:
                  (scenario === "stale_pr_head" &&
                    pushed &&
                    staleViews++ < 7) ||
                  (scenario === "stale_pr_head_timeout" && pushed)
                    ? originalHead
                    : remoteHead(),
                headRefName: headBranch,
                baseRefName: "main",
                isCrossRepository: false,
              }),
              stderr: "",
            };
          if (args[0] === "pr" && args[1] === "merge") {
            mergeCalls++;
            assert.ok(args.includes("--squash"));
            assert.equal(
              args[args.indexOf("--match-head-commit") + 1],
              remoteHead(),
            );
            if (
              scenario === "merge_failed" ||
              (scenario === "return_then_merge" && mergeCalls === 1)
            )
              return { ok: false, stdout: "", stderr: "merge rejected" };
            merged = true;
            return { ok: true, stdout: "merged", stderr: "" };
          }
          return {
            ok: false,
            stdout: "",
            stderr: `unexpected gh ${args.join(" ")}`,
          };
        };
        fixture.run = fake;
      },
      undefined,
      undefined,
      {
        mergeHeadWaitMs:
          scenario === "stale_pr_head_timeout" || scenario === "head_changed"
            ? 150
            : undefined,
        checkRerunDelayMs: () => 50,
        ...(scenario === "stalled_blocked"
          ? { quiet: { warnMs: 1_000, stallMs: 2_000, pollMs: 50 } }
          : {}),
      },
    );
    let call = firstCall;
    const created = await call("POST", "/api/tasks", {
      title: "合入测试",
      repo: fx.repo,
    });
    assert.equal(created.status, 201);
    const ref = created.body.ref as string;
    const started = await call("POST", `/api/tasks/${ref}/run`, {
      worker: "kimi",
    });
    assert.equal(started.status, 200);
    const worktree = started.body.task.worktree as string;
    originalHead = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (scenario === "stopped" || scenario === "restart_check") {
      const until = Date.now() + 10_000;
      for (;;) {
        const current = (await call("GET", `/api/tasks/${ref}`)).body;
        if (
          current.events.some(
            (event: { kind: string }) => event.kind === "merge_check_started",
          )
        )
          break;
        assert.ok(Date.now() < until, "等待合入检查启动超时");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (scenario === "stopped") {
        const pidFile = join(fx.root, "check-pid");
        while (!existsSync(pidFile)) {
          assert.ok(Date.now() < until, "检查没起孙进程");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const grandchild = Number(readFileSync(pidFile, "utf8"));
        t.after(() => {
          if (processAlive(grandchild)) process.kill(grandchild, "SIGKILL");
        });
        assert.equal(
          (await call("POST", `/api/tasks/${ref}/stop`)).status,
          200,
        );
        const gone = Date.now() + 15_000;
        while (processAlive(grandchild) && Date.now() < gone)
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          processAlive(grandchild),
          false,
          "停止合入后检查的孙进程还在",
        );
      } else {
        await app.close();
        const resumed = await createApp({
          data,
          auth: false,
          tasks: {
            env: fx.env,
            workersDir: fx.workers,
            exec: fx.run,
            tickMs: 100,
          },
        });
        t.after(() => resumed.app.close());
        call = async (method, url, payload) => {
          const response = await resumed.app.inject({
            method,
            url,
            headers: { host: "127.0.0.1" },
            ...(payload ? { payload } : {}),
          });
          return { status: response.statusCode, body: response.json() };
        };
      }
    }
    const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
    assert.equal(waited.status, 200);
    assert.equal(waited.body.timed_out, false);
    const task = waited.body.task;
    const count = (kind: string) =>
      task.events.filter((event: { kind: string }) => event.kind === kind)
        .length;
    if (scenario === "not_run_then_merge") {
      // 没跑成不交回执行者：放回队列重跑一次就合入了。
      assert.equal(task.delivery_stage, "merged");
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 1);
      assert.equal(count("merge_check_rerun"), 1);
      assert.equal(count("merge_returned"), 0);
      const checks = task.events
        .filter((event: { kind: string }) => event.kind === "merge_check")
        .map((event: { detail: string }) => JSON.parse(event.detail).outcome);
      assert.deepEqual(checks, ["not_run", "passed"]);
      const shown = (await call("GET", `/api/tasks/${ref}`)).body;
      assert.match(shown.last_check, /^合入前过/);
      return;
    }
    if (scenario === "deps_failed_then_merge") {
      // 装依赖失败是检查没跑成：不交回执行者、不计退回次数，重跑时装上就合入了。
      assert.equal(task.delivery_stage, "merged");
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 1);
      assert.equal(count("merge_check_rerun"), 1);
      assert.equal(count("merge_returned"), 0);
      const checks = task.events
        .filter((event: { kind: string }) => event.kind === "merge_check")
        .map((event: { detail: string }) => JSON.parse(event.detail));
      assert.deepEqual(
        checks.map((check: { outcome: string }) => check.outcome),
        ["not_run", "passed"],
      );
      assert.match(
        checks[0].reason,
        /^装依赖失败（npm ci .*退出码 1）：network request failed$/,
      );
      assert.match(checks[0].detail, /输出末尾：/);
      assert.match(checks[1].deps, /^先装了依赖（npm ci，\d+ 秒）/);
      const events = JSON.stringify(task.events);
      assert.doesNotMatch(events, /abcdef123456secret/);
      const shown = (await call("GET", `/api/tasks/${ref}`)).body;
      assert.match(
        shown.last_check,
        /^合入前过.*；先装了依赖（npm ci，\d+ 秒）/,
      );
      return;
    }
    if (scenario === "not_run_blocked") {
      // 重跑 3 次仍没跑成：转卡住、写明基础设施问题，不算执行者交回。
      assert.equal(task.status, "blocked");
      assert.equal(task.delivery_stage, null);
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 0);
      assert.equal(count("merge_check_rerun"), 3);
      assert.equal(count("merge_returned"), 0);
      const shown = (await call("GET", `/api/tasks/${ref}`)).body;
      assert.match(
        JSON.stringify(
          shown.events.filter(
            (e: { kind: string }) => e.kind === "merge_blocked",
          ),
        ),
        /基础设施问题：检查没跑成（已自动重跑 3 次）/,
      );
      assert.match(shown.last_check, /^合入前没跑成.*已自动重跑 3 次/);
      assert.match(shown.holder.text, /^基础设施问题/);
      const urgent = await call("GET", "/api/events/wait?timeout=0");
      assert.deepEqual(
        urgent.body.events.map((event: { kind: string }) => event.kind),
        ["blocked"],
      );
      return;
    }
    if (scenario === "stalled_blocked") {
      // 卡住的检查只自动重跑一次（t260），再卡住转卡住；每次卡住前先提醒并知会负责人。
      assert.equal(task.status, "blocked");
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 0);
      assert.equal(count("merge_check_rerun"), 1);
      assert.equal(count("merge_returned"), 0);
      const quiet = task.events.filter(
        (event: { kind: string; detail: string }) =>
          event.kind === "merge_check_quiet" &&
          !JSON.parse(event.detail).resumed,
      );
      assert.equal(quiet.length, 2);
      assert.match(
        JSON.parse(quiet[0].detail).reason,
        /^检查 1 秒没输出：卡在 ✔ 前面的用例/,
      );
      const checks = task.events
        .filter((event: { kind: string }) => event.kind === "merge_check")
        .map((event: { detail: string }) => JSON.parse(event.detail));
      assert.deepEqual(
        checks.map((check: { outcome: string }) => check.outcome),
        ["not_run", "not_run"],
      );
      assert.deepEqual(checks[0].stalled, { at: "✔ 前面的用例 (1ms)" });
      const shown = (await call("GET", `/api/tasks/${ref}`)).body;
      assert.match(
        JSON.stringify(
          shown.events.filter(
            (e: { kind: string }) => e.kind === "merge_blocked",
          ),
        ),
        /基础设施问题：检查没跑成（已自动重跑 1 次）：检查卡住：日志 2 秒没有新输出，卡在 ✔ 前面的用例/,
      );
      const inbox = await call("GET", "/api/events?limit=100");
      assert.ok(
        inbox.body.events.some(
          (event: { kind: string; level: string }) =>
            event.kind === "check_quiet" && event.level === "info",
        ),
        JSON.stringify(inbox.body.events.map((e: { kind: string }) => e.kind)),
      );
      return;
    }
    if (
      scenario === "success" ||
      scenario === "rebase_success" ||
      scenario === "return_then_merge" ||
      scenario === "push_failed" ||
      scenario === "restart_check" ||
      scenario === "stale_pr_head"
    ) {
      assert.equal(task.delivery_stage, "merged");
      assert.equal(task.status, "done");
      assert.equal(
        task.merge_returns,
        scenario === "return_then_merge" || scenario === "push_failed" ? 1 : 0,
      );
      assert.equal(mergeCalls, scenario === "return_then_merge" ? 2 : 1);
      assert.equal(merged, true);
      assert.equal(task.worktree, null);
      assert.equal(existsSync(worktree), false);
      assert.equal(
        execFileSync("git", ["-C", fx.repo, "branch", "--list", headBranch], {
          encoding: "utf8",
        }).trim(),
        "",
      );
      const urgent = await call("GET", "/api/events/wait?timeout=0");
      assert.equal(urgent.body.events.length, 0, "过程事件不叫醒秘书");
      const digest = await call("GET", "/api/events/digest");
      assert.match(
        digest.body.items[0].summary,
        scenario === "return_then_merge" || scenario === "push_failed"
          ? /退回 1 次后合入/
          : /合入/,
      );
      assert.ok(digest.body.acknowledged >= 2);
      if (scenario === "success") {
        assert.equal(
          (await call("GET", "/api/events/digest?since=bad")).status,
          400,
        );
        assert.equal(
          (await call("GET", "/api/events/wait?timeout=0&settle=-1")).status,
          400,
        );
      }
    } else if (
      scenario === "wrong_origin" ||
      scenario === "stopped" ||
      scenario === "head_changed" ||
      scenario === "stale_pr_head_timeout"
    ) {
      assert.equal(task.status, "blocked", eventTrail(task));
      assert.equal(task.delivery_stage, null);
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 0);
      assert.match(
        JSON.stringify(task.events),
        scenario === "stopped"
          ? /merge_stopped/
          : scenario === "head_changed"
            ? /等待 PR 头提交更新超时/
            : scenario === "stale_pr_head_timeout"
              ? /等待 PR 头提交更新超时/
              : /origin 不一致/,
      );
      if (scenario === "stale_pr_head_timeout") {
        const checkedHead = execFileSync(
          "git",
          ["-C", worktree, "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim();
        const events = JSON.stringify(task.events);
        assert.ok(events.includes(checkedHead));
        assert.ok(events.includes(originalHead));
      }
    } else {
      assert.equal(task.status, "blocked");
      assert.ok(task.worktree && existsSync(task.worktree));
      assert.equal(task.delivery_stage, null);
      assert.equal(task.merge_returns, 3);
      assert.equal(mergeCalls, scenario === "merge_failed" ? 3 : 0);
      const details = (await call("GET", `/api/tasks/${ref}`)).body.events;
      assert.equal(
        details.filter(
          (event: { kind: string }) => event.kind === "merge_returned",
        ).length,
        2,
      );
      assert.equal(
        details.filter(
          (event: { kind: string }) => event.kind === "merge_blocked",
        ).length,
        1,
      );
      const urgent = await call("GET", "/api/events/wait?timeout=0");
      assert.deepEqual(
        urgent.body.events.map((event: { kind: string }) => event.kind),
        ["blocked"],
      );
      const digest = await call("GET", "/api/events/digest");
      assert.match(digest.body.items[0].summary, /退回 2 次/);
    }
    if (scenario === "head_changed" || scenario === "stale_pr_head_timeout") {
      const requeued = await call("POST", `/api/tasks/${ref}/merge`);
      assert.equal(requeued.status, 200);
      assert.equal(requeued.body.task.status, "done");
      assert.ok(
        ["merge_queued", "merging"].includes(requeued.body.task.delivery_stage),
      );
      assert.equal(requeued.body.task.started_at, task.started_at);
      assert.equal(requeued.body.task.pid, task.pid);
    }
  });
}
