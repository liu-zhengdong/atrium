import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exec, type Exec } from "../server/tasks/git.ts";
import {
  MAX_MERGE_RETURNS,
  mergeFailure,
} from "../server/tasks/merge-decision.ts";
import { startApp } from "./task-fixture.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { MergeQueue } from "../server/tasks/merge-runtime.ts";

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
  queue.close();
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
] as const) {
  test(`隔离服务与假 gh/执行者：${scenario}`, async (t) => {
    let merged = false;
    let mergeCalls = 0;
    let headBranch = "";
    let advancedMain = false;
    const { fx, call } = await startApp(t, (fixture) => {
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
              scenario === "check_failed"
                ? "echo 'not ok 1 - 故意失败'; exit 1"
                : scenario === "stopped"
                  ? "sleep 2; true"
                  : "true",
          },
        }),
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
        if (
          scenario === "push_failed" &&
          command === "git" &&
          args.some((arg) => arg.startsWith("--force-with-lease="))
        )
          return { ok: false, stdout: "", stderr: "push rejected" };
        if (command !== "gh") return exec(command, args, options);
        assert.equal(args[args.indexOf("-R") + 1], "acme/demo");
        if (args[0] === "pr" && args[1] === "list") {
          headBranch = args[args.indexOf("--head") + 1]!;
          if (
            (scenario === "conflict" || scenario === "rebase_success") &&
            !advancedMain
          ) {
            advancedMain = true;
            const changed = scenario === "conflict" ? "done.txt" : "README.md";
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
              headRefOid: remoteHead(),
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
    });
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
    if (scenario === "stopped") {
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
      assert.equal((await call("POST", `/api/tasks/${ref}/stop`)).status, 200);
    }
    const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
    assert.equal(waited.status, 200);
    assert.equal(waited.body.timed_out, false);
    const task = waited.body.task;
    if (
      scenario === "success" ||
      scenario === "rebase_success" ||
      scenario === "return_then_merge"
    ) {
      assert.equal(task.delivery_stage, "merged");
      assert.equal(task.status, "done");
      assert.equal(
        task.merge_returns,
        scenario === "return_then_merge" ? 1 : 0,
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
        scenario === "return_then_merge" ? /退回 1 次后合入/ : /合入/,
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
    } else if (scenario === "wrong_origin" || scenario === "stopped") {
      assert.equal(task.status, "blocked");
      assert.equal(task.delivery_stage, null);
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 0);
      assert.match(
        JSON.stringify(task.events),
        scenario === "stopped" ? /merge_stopped/ : /origin 不一致/,
      );
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
  });
}
