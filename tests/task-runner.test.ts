import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getTask } from "../server/tasks/ledger.ts";
import { spawnMark, spawnOwner } from "../server/tasks/orphans.ts";
import { eventTrail, startApp } from "./task-fixture.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { nodeCommand } from "./portable-shell.ts";

test("交付关卡不跑全量检查：档案带 local_check 也不执行检查脚本，关卡写明由合入队列跑", async (t) => {
  const { fx, data, call } = await startApp(t, (fx) => {
    mkdirSync(join(fx.repo, ".agents"));
    writeFileSync(
      join(fx.repo, ".agents", "check"),
      nodeCommand("console.log('local-checked'); process.exit(1)"),
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
  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "Check once",
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
  const task = result.body.task;
  // 没有 PR 只挡在 pr_exists；会失败的检查脚本没被执行。
  assert.equal(task.status, "blocked", eventTrail(task));
  assert.equal(
    task.events.some((event: { kind: string }) =>
      event.kind.startsWith("local_check"),
    ),
    false,
  );
  assert.equal(existsSync(join(data, "tasks", "1", "local-check.log")), false);
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
  assert.match(gates.results[1].evidence, /合入队列/);
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
  assert.doesNotMatch(
    seen,
    /HERDR_|CLAUDECODE|ATRIUM_(?!WORKER=1\n|TEST_CONCURRENCY=[1-9][0-9]*\n|TASK=t1\n|SPAWN=[0-9a-f]{12}\/t1\n)/,
  );
  assert.match(seen, /^ATRIUM_WORKER=1$/m);
  // 执行者 material get 时把读取记在这件任务上（t192）。
  assert.match(seen, /^ATRIUM_TASK=t1$/m);
  // 执行者带本服务的标记（t203），父进程退出后被收养的子孙也认得出。
  assert.ok(
    seen.split("\n").includes(`ATRIUM_SPAWN=${spawnMark(spawnOwner(data), 1)}`),
  );
  assert.match(seen, /^ATRIUM_TEST_CONCURRENCY=[1-9][0-9]*$/m);

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

test("排队中的任务 task run --worker 可改派执行者（t139）", async (t) => {
  // 假 opencode 一直跑着占住独占工具，排队的任务不会被自动拉起。
  const { fx, data, call } = await startApp(t, (fx) => {
    writeFakeBin(join(fx.root, "bin", "opencode"), "#!/bin/sh\nsleep 30\n");
  });
  for (const title of ["占位", "排队"])
    assert.equal(
      (await call("POST", "/api/tasks", { title, repo: fx.repo })).status,
      201,
    );
  const r1 = await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.queued, false);
  // 指定本机 h1 排队：改派不带 --host 时保留。
  const r2 = await call("POST", "/api/tasks/t2/run", {
    worker: "opencode",
    host: "h1",
  });
  assert.equal(r2.body.queued, true, JSON.stringify(r2.body));

  // 不带 --worker：排队不变，409 说明现状与改派方法。
  const same = await call("POST", "/api/tasks/t2/run", {});
  assert.equal(same.status, 409);
  assert.match(
    same.body.error,
    /已在排队（opencode.*排队不变；要改派请带 --worker/,
  );

  // 改派后新执行者仍在忙：换掉排队记录，仍在排队，原因按新执行者重算，排队位置不变。
  const queuedRow = () => {
    const db = new DatabaseSync(join(data, "atrium.sqlite"), {
      readOnly: true,
    });
    try {
      return db
        .prepare(
          "SELECT worker,risk,queued_at,host_id FROM task_queue WHERE task_id=2",
        )
        .get() as
        | { worker: string; risk: string; queued_at: number; host_id: number }
        | undefined;
    } finally {
      db.close();
    }
  };
  const before = queuedRow()!;
  const busy = await call("POST", "/api/tasks/t2/run", {
    worker: "opencode+deepseek",
  });
  assert.equal(busy.status, 200, JSON.stringify(busy.body));
  assert.equal(busy.body.queued, true);
  assert.equal(busy.body.reassigned.from, before.worker);
  assert.match(busy.body.reassigned.worker, /^opencode\+deepseek/);
  assert.match(busy.body.reassigned.reason, /opencode 同一时刻只跑一个/);
  const after = queuedRow()!;
  assert.equal(after.worker, busy.body.reassigned.worker);
  assert.equal(after.queued_at, before.queued_at);
  assert.equal(before.host_id, 1);
  assert.equal(after.host_id, 1);

  // 超出新执行者 max_risk 的拒绝，排队记录不动。
  const risky = await call("POST", "/api/tasks/t2/run", {
    worker: "kimi",
    risk: "high",
  });
  assert.equal(risky.status, 400, JSON.stringify(risky.body));
  assert.equal(queuedRow()!.worker, after.worker);

  // 改派给空着的 kimi：立刻拉起，不再排队。
  const moved = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.queued, false);
  assert.match(moved.body.reassigned.worker, /^kimi/);
  assert.equal(moved.body.reassigned.reason, null);
  assert.equal(queuedRow(), undefined);
  assert.match(moved.body.task.worker, /^kimi/);

  // 正在跑的不能改派。
  const running = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(running.status, 409);
  assert.match(running.body.error, /正在运行/);
});
