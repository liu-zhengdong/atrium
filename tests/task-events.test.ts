import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventInbox, ackIds } from "../server/tasks/events.ts";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import { TaskRunner } from "../server/tasks/runner.ts";
import type { Exec } from "../server/tasks/git.ts";

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

test("CI 轮询：通过后补判完成；未运行保持受阻并投递独立事件", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const calls: string[][] = [];
  const unavailable = JSON.parse(
    readFileSync(
      new URL("./fixtures/ci-unavailable.json", import.meta.url),
      "utf8",
    ),
  ) as { checks: unknown[]; jobs: unknown; annotations: unknown[] };
  const run: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "api")
      return {
        ok: true,
        stdout: JSON.stringify(
          args[1]?.includes("/jobs?")
            ? unavailable.jobs
            : unavailable.annotations,
        ),
        stderr: "",
      };
    const url = args[2]!;
    if (url.endsWith("/4"))
      return {
        ok: false,
        stdout: JSON.stringify(unavailable.checks),
        stderr: "",
      };
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
  for (const n of [1, 2, 3, 4]) {
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
  assert.equal(
    calls.filter((call) => call[1] === "pr").length,
    4,
    "没有 PR 的任务不查",
  );
  assert.equal(getTask(db, "t1").status, "done");
  assert.equal(getTask(db, "t1").ci, "success");
  assert.equal(getTask(db, "t2").status, "blocked");
  assert.equal(getTask(db, "t2").ci, "failure");
  assert.equal(getTask(db, "t3").ci, "pending");
  assert.equal(getTask(db, "t4").status, "blocked");
  assert.equal(getTask(db, "t4").ci, "unavailable");
  const events = (await runner.inbox.wait("secretary", 0)).events;
  assert.deepEqual(
    events.map((event) => [event.task, event.kind]),
    [
      ["t1", "ci_success"],
      ["t2", "ci_failure"],
      ["t4", "ci_unavailable"],
    ],
  );
  assert.match(
    JSON.stringify(events[2]!.detail),
    /CI 未运行：The job was not started.*需人工处理或本地验证/,
  );
  await runner.pollCi();
  assert.equal(
    calls.filter((call) => call[1] === "pr").length,
    5,
    "出结果的不再查，只剩 t3",
  );
  runner.close();
});
