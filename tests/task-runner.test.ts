import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getTask } from "../server/tasks/ledger.ts";
import { startApp } from "./task-fixture.ts";

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
