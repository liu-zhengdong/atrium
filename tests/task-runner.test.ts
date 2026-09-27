import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getTask } from "../server/tasks/ledger.ts";
import { startApp } from "./task-fixture.ts";

test("隔离任务服务按档案执行 local_check 并记录关卡事件", async (t) => {
  const { fx, data, call } = await startApp(t, (fx) => {
    mkdirSync(join(fx.repo, ".agents"));
    writeFileSync(
      join(fx.repo, ".agents", "check"),
      'echo local-checked-$ATRIUM_WORKER; test "$ATRIUM_WORKER" = 1\n',
    );
    execFileSync("git", ["-C", fx.repo, "add", ".agents/check"]);
    execFileSync("git", [
      "-C",
      fx.repo,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "add check",
    ]);
    execFileSync("git", ["-C", fx.repo, "push", "-q", "origin", "main"]);
    writeFileSync(
      join(fx.workers, "harness", "kimi.md"),
      "---\nchecks: [pr_exists, local_check]\n---\n",
    );
  });
  // 从任务 worktree 的真实分支执行仓库脚本，不采信假执行者的文字汇报。
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "Check locally",
        repo: fx.repo,
      })
    ).status,
    201,
  );
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "kimi" })).status,
    200,
  );
  const result = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(result.body.task.status, "blocked");
  const task = result.body.task;
  const local = task.events.find(
    (event: { kind: string }) => event.kind === "local_check",
  );
  assert.ok(local);
  assert.equal(JSON.parse(local.detail).status, "passed");
  assert.match(
    readFileSync(join(data, "tasks", "1", "local-check.log"), "utf8"),
    /local-checked-1/,
  );
  const gates = JSON.parse(
    task.events.find((event: { kind: string }) => event.kind === "gates")
      .detail,
  );
  assert.deepEqual(
    gates.results.map((entry: { gate: string; ok: boolean }) => [
      entry.gate,
      entry.ok,
    ]),
    [
      ["pr_exists", false],
      ["local_check", true],
    ],
  );

  writeFileSync(
    join(fx.repo, ".agents", "check"),
    "echo 'not ok 1 - 关键失败用例'; exit 1\n",
  );
  execFileSync("git", ["-C", fx.repo, "add", ".agents/check"]);
  execFileSync("git", [
    "-C",
    fx.repo,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fail check",
  ]);
  execFileSync("git", ["-C", fx.repo, "push", "-q", "origin", "main"]);
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "Failed check",
        repo: fx.repo,
      })
    ).status,
    201,
  );
  assert.equal(
    (await call("POST", "/api/tasks/t2/run", { worker: "kimi" })).status,
    200,
  );
  const failedTask = (await call("GET", "/api/tasks/t2/wait?timeout=20")).body
    .task;
  assert.equal(failedTask.status, "blocked");
  const block = failedTask.events.find(
    (event: { kind: string }) => event.kind === "block",
  );
  assert.match(block.detail, /local_check：.*失败用例：关键失败用例/);
});

test("派活闭环：建 worktree、白名单环境拉起、日志落盘、关卡判受阻、事件投递；破坏输入被拒", async (t) => {
  const { fx, data, call } = await startApp(t);
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
    /pr_exists：gh pr list --head task-t1-add-done-file 没找到 PR：origin 远端 .* 解析不出 owner\/repo/,
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
  assert.doesNotMatch(seen, /HERDR_|CLAUDECODE|ATRIUM_(?!WORKER=1\n)/);
  assert.match(seen, /^ATRIUM_WORKER=1$/m);

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

test("comment 与 none 交付不用 PR，评论链接进入摘要", async (t) => {
  let commentQueries = 0;
  const link = "https://github.com/o/r/issues/262#issuecomment-123";
  // 评论时间取任务真实的开始时间：假执行者可能在 run 请求返回前就结束并查评论，不能等测试侧赋值。
  let call!: Awaited<ReturnType<typeof startApp>>["call"];
  const app = await startApp(t, (fixture) => {
    const original = fixture.run;
    fixture.run = async (command, args, options) => {
      // 夹具的 origin 是本地 bare 仓库；评论关卡要从 origin 解析仓库，这里换成 GitHub 地址。
      if (
        command === "git" &&
        args.slice(2).join(" ") === "remote get-url origin"
      )
        return {
          ok: true,
          stdout: "https://github.com/o/r.git\n",
          stderr: "",
        };
      if (
        command === "gh" &&
        args[0] === "api" &&
        args[1]?.includes("/issues/262/comments")
      ) {
        commentQueries++;
        const listed = await call("GET", "/api/tasks");
        const task = (
          listed.body.tasks as { issue: number | null; started_at: number }[]
        ).find((item) => item.issue === 262)!;
        return {
          ok: true,
          stdout: JSON.stringify([
            [
              {
                created_at: new Date(task.started_at).toISOString(),
                html_url: link,
              },
            ],
          ]),
          stderr: "",
        };
      }
      return original(command, args, options);
    };
  });
  const { fx } = app;
  call = app.call;
  const invalid = await call("POST", "/api/tasks", {
    title: "设计",
    repo: fx.repo,
    deliver: "comment",
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /--issue/);
  for (const [deliver, issue] of [
    ["comment", 262],
    ["none", undefined],
  ] as const) {
    const created = await call("POST", "/api/tasks", {
      title: `设计 ${deliver}`,
      repo: fx.repo,
      deliver,
      ...(issue ? { issue } : {}),
    });
    assert.equal(created.status, 201);
    const started = await call("POST", `/api/tasks/${created.body.ref}/run`, {
      worker: "kimi",
    });
    assert.equal(started.status, 200);
    const waited = await call(
      "GET",
      `/api/tasks/${created.body.ref}/wait?timeout=20`,
    );
    assert.equal(waited.body.task.status, "done", JSON.stringify(waited.body));
    assert.equal(waited.body.task.pr_url, null);
    assert.equal(waited.body.task.ci, null);
    if (deliver === "comment")
      assert.match(waited.body.task.result, /issuecomment-123/);
  }
  assert.equal(commentQueries, 1);
});
