import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventInbox, ackIds, listOptions } from "../server/tasks/events.ts";
import {
  LEASE_MS,
  deliverable,
  selfInitiated,
  type DeliveryState,
} from "../server/tasks/event-lease.ts";
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

  const batched = new EventInbox(db, { batchMs: 150 });
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

test("投递判定：租约内不重投、超时重投、ack 后永不再投、自己发起的不投给自己", () => {
  const now = 10 * LEASE_MS;
  const base: DeliveryState = {
    subscriber: "secretary",
    actor: null,
    ready_at: 0,
    delivered_at: null,
    acked_at: null,
  };
  const at = (patch: Partial<DeliveryState>) =>
    deliverable({ ...base, ...patch }, now, LEASE_MS);
  assert.equal(at({}), true, "没交出过");
  assert.equal(at({ delivered_at: now - 1 }), false, "刚交出");
  assert.equal(at({ delivered_at: now - LEASE_MS + 1 }), false, "租约最后一刻");
  assert.equal(at({ delivered_at: now - LEASE_MS }), true, "租约到期");
  assert.equal(at({ ready_at: now + 1 }), false, "攒批窗口内");
  assert.equal(at({ actor: "lead" }), true, "别人发起的照投");
  assert.equal(at({ actor: "secretary" }), false, "自己发起的不投");
  assert.equal(selfInitiated("secretary", null), false);
  for (const delivered_at of [null, 0, now - 1])
    for (const actor of [null, "secretary", "lead"])
      assert.equal(
        at({ acked_at: now - 5, delivered_at, actor }),
        false,
        "ack 后永不再投",
      );
});

test("事件列表：未送达、送达、确认、合并后重新待送、倒序分页", async () => {
  let now = 1_000;
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db, { now: () => now });
  const first = inbox.publish({
    subscriber: "secretary",
    source: "test",
    kind: "done",
    key: "first",
  });
  assert.deepEqual(inbox.list("secretary", { limit: 50 }).events[0], first);
  now++;
  const [delivered] = (await inbox.wait("secretary", 0)).events;
  assert.equal(delivered!.delivered_at, now);
  assert.equal(delivered!.acked_at, null);
  assert.equal(
    inbox.list("secretary", { limit: 50 }).events[0]!.delivered_at,
    now,
  );
  now++;
  inbox.publish({
    subscriber: "secretary",
    source: "test",
    kind: "done",
    key: "first",
  });
  assert.equal(
    inbox.list("secretary", { limit: 50 }).events[0]!.delivered_at,
    null,
  );
  const [again] = (await inbox.wait("secretary", 0)).events;
  assert.equal(again!.delivered_at, now);
  now++;
  inbox.ack([first.id]);
  assert.equal(inbox.list("secretary", { limit: 50 }).events[0]!.acked_at, now);
  const second = inbox.publish({
    subscriber: "secretary",
    source: "test",
    kind: "failed",
    key: "second",
  });
  assert.deepEqual(
    inbox.list("secretary", { limit: 1 }).next_before,
    second.id,
  );
  assert.deepEqual(
    inbox
      .list("secretary", { before: second.id, limit: 1 })
      .events.map((e) => e.id),
    [first.id],
  );
  assert.equal(
    inbox.list("secretary", { before: second.id, limit: 1 }).next_before,
    null,
  );
  assert.deepEqual(inbox.list("lead", { limit: 50 }).events, []);
  assert.deepEqual(listOptions({}), { before: undefined, limit: 50 });
  assert.throws(() => listOptions({ limit: "201" }), /limit/);
  assert.throws(() => listOptions({ before: "0" }), /before/);
  inbox.close();
});

test("事件队列按判定投递：逐格与纯函数一致，租约到期唤醒 wait", async () => {
  let clock = 1_000_000;
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db, { leaseMs: 1000, now: () => clock });
  const first = await inbox.wait("secretary", 0);
  assert.equal(first.events.length, 0);
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "done",
    key: "t1:outcome",
  });
  const self = inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "failed",
    key: "t2:outcome",
    actor: "secretary",
  });
  assert.equal(self.actor, "secretary");
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "failed",
    key: "t3:outcome",
    actor: "lead",
  });
  const got = await inbox.wait("secretary", 0);
  assert.deepEqual(
    got.events.map((e) => e.key),
    ["t1:outcome", "t3:outcome"],
    "自己发起的只记账",
  );
  assert.equal(
    (
      db
        .prepare("SELECT count(*) AS n FROM task_inbox WHERE id=?")
        .get(self.id) as { n: number }
    ).n,
    1,
    "记账仍记",
  );
  assert.equal(
    (await inbox.wait("secretary", 0)).events.length,
    0,
    "租约内不重投",
  );
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "blocked",
    key: "t4:outcome",
  });
  assert.deepEqual(
    (await inbox.wait("secretary", 0)).events.map((e) => e.key),
    ["t4:outcome"],
    "处理中也能等到新事件",
  );
  inbox.publish({
    subscriber: "secretary",
    source: "ci",
    kind: "ci_failure",
    key: "t1:outcome",
  });
  const merged = (await inbox.wait("secretary", 0)).events;
  assert.deepEqual(
    merged.map((e) => [e.key, e.count]),
    [["t1:outcome", 2]],
    "合并了新内容的重新投递",
  );
  inbox.ack([merged[0]!.id]);
  clock += 1000;
  assert.deepEqual(
    (await inbox.wait("secretary", 0)).events.map((e) => e.key),
    ["t3:outcome", "t4:outcome"],
    "超时未 ack 的重投，已 ack 的不投",
  );
  // 逐行对照纯函数：SQL 条件与 deliverable 一致。
  const rows = db
    .prepare("SELECT * FROM task_inbox")
    .all() as unknown as (DeliveryState & { id: number })[];
  const base = clock;
  for (const offset of [0, 999, 1000, 5000]) {
    clock = base + offset;
    const expected = rows
      .filter((row) => deliverable(row, clock, 1000))
      .map((row) => row.id);
    assert.deepEqual(
      inbox.pending("secretary").map((e) => e.id),
      expected,
      `偏移 ${offset}`,
    );
  }
  inbox.close();

  // 租约到期时挂着的 wait 被唤醒（真实时钟）。
  const live = new EventInbox(db, { leaseMs: 150 });
  live.publish({
    subscriber: "lead",
    source: "ci",
    kind: "ci_success",
    key: "t9:ci",
  });
  const [taken] = (await live.wait("lead", 0)).events;
  const started = Date.now();
  const again = await live.wait("lead", 3);
  assert.equal(again.events[0]?.id, taken!.id);
  assert.ok(Date.now() - started < 2000, "到点就醒，不等满超时");
  live.close();
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
      { pr_url: `https://github.com/o/r/pull/${n}`, ci: "pending" },
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
