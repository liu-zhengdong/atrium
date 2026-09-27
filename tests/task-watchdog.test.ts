import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { getTask } from "../server/tasks/ledger.ts";
import {
  finalClaudeResult,
  ProgressProbe,
  STEP_CHUNK,
} from "../server/tasks/watchdog.ts";
import { startApp, until } from "./task-fixture.ts";

test("最终 result 判定只接受最后一轮完整收尾", () => {
  const result =
    '{"stop_reason":"end_turn","is_error":false,"type":"result"}\n';
  assert.equal(finalClaudeResult(result), "clean");
  assert.equal(
    finalClaudeResult(`${result}{"type":"command_lifecycle"}\n`),
    "clean",
  );
  assert.equal(
    finalClaudeResult(`${result}{"type":"user","isReplay":true}\n`),
    undefined,
  );
  assert.equal(finalClaudeResult(`${result}[atrium] 续上会话\n`), undefined);
  assert.equal(
    finalClaudeResult('{"is_error":true,"type":"result"}\n'),
    "error",
  );
});

test("步骤计数：日志里出现超过 1 MiB 的单行后，后续步骤照常计数", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "run.log");
  const step = '{"type":"assistant"}\n';
  writeFileSync(log, "");
  const probe = new ProgressProbe(log, dir, false, true);
  await probe.baseline();
  appendFileSync(log, step);
  assert.equal((await probe.sample()).steps, 1);

  // 一整行超长的步骤事件（带换行），其后再追加两个正常步骤。
  const huge = `{"type":"assistant","text":"${"x".repeat(STEP_CHUNK + 512 * 1024)}"}\n`;
  appendFileSync(log, huge + step + step);
  assert.equal((await probe.sample()).steps, 3, "超长行跳过，后面的步骤照数");

  // 超长行还在写（跨了几次采样才写完换行），写完后的步骤也照数。
  appendFileSync(log, `{"type":"assistant","text":"${"y".repeat(STEP_CHUNK)}`);
  assert.equal((await probe.sample()).steps, 3);
  appendFileSync(log, "y".repeat(STEP_CHUNK));
  assert.equal((await probe.sample()).steps, 3);
  appendFileSync(log, '"}\n' + step);
  assert.equal((await probe.sample()).steps, 4);

  // 不足一块的半行留到下次，写完再数。
  appendFileSync(log, '{"type":"assi');
  assert.equal((await probe.sample()).steps, 4);
  appendFileSync(log, 'stant"}\n');
  const { signals } = await probe.poll();
  assert.ok(signals.includes("json_events"));
  assert.equal((await probe.sample()).steps, 5);
});

test("看门狗：Claude 已输出最终 result 却不退出，催退后照常过关卡", async (t) => {
  const { data, call } = await startApp(t, (fx) => {
    const file = join(fx.root, "bin", "claude");
    writeFileSync(
      file,
      `#!/usr/bin/env node
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => out({ type: "system", subtype: "stdin_closed" }));
setInterval(() => {}, 1000);
setTimeout(() => out({ stop_reason: "end_turn", is_error: false, result: "done", type: "result" }), 100);
`,
    );
    chmodSync(file, 0o755);
    writeFileSync(
      join(fx.workers, "harness", "claude.md"),
      "---\nchecks: []\nlimits: {idle_minutes: 0.01}\n---\n",
    );
  });
  await call("POST", "/api/tasks", { title: "收尾未退出", deliver: "none" });
  await call("POST", "/api/tasks/t1/run", { worker: "claude" });
  const done = await call("GET", "/api/tasks/t1/wait?timeout=10");
  assert.equal(
    done.body.task.status,
    "done",
    JSON.stringify(done.body.task.events),
  );
  assert.equal(done.body.task.result, "done");
  const kinds = done.body.task.events.map(
    (event: { kind: string }) => event.kind,
  );
  assert.ok(kinds.includes("finalizing"));
  assert.ok(kinds.includes("final_result_exit"));
  assert.ok(kinds.includes("gates"));
  assert.ok(!kinds.includes("idle"));
  assert.match(
    readFileSync(join(data, "tasks", "1", "log"), "utf8"),
    /stdin_closed/,
  );
});

test("看门狗：假执行者零输出判卡死、按档案重试一次后失败；独占工具排队；stop 停进程", async (t) => {
  const { fx, data, call } = await startApp(t);
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
  // 零输出的执行者没有摘要：日志抬头（含多行提示词参数）不能混进 result。
  assert.equal(waited.body.task.result, "");
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
  // 排队原因在 show / ls / plan 里都带出来。
  const why = /opencode 同一时刻只跑一个/;
  assert.match(second.body.task.queued_reason, why);
  const listed = (await call("GET", "/api/tasks")).body.tasks as {
    ref: string;
    queued_reason: string | null;
  }[];
  assert.match(listed.find((task) => task.ref === "t3")!.queued_reason!, why);
  assert.equal(listed.find((task) => task.ref === "t2")!.queued_reason, null);
  const plan = (await call("GET", "/api/tasks/plan")).body.groups.ready as {
    task: { ref: string; queued_reason: string | null };
  }[];
  assert.match(
    plan.find((item) => item.task.ref === "t3")!.task.queued_reason!,
    why,
  );
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
  const stopped = getTask(db, "t4").events.find(
    (event) => event.kind === "stop_requested",
  );
  assert.match(stopped!.detail!, /"by":"secretary"/);
  const after = (await call("GET", "/api/events/wait?as=secretary&timeout=0"))
    .body.events as { task: string; actor: string | null }[];
  assert.deepEqual(
    after.map((event) => event.task),
    ["t2", "t3"],
    "t1 在处理中租约内不重投；secretary 自己停的 t4 不投给自己",
  );
  const own = db
    .prepare("SELECT actor, kind FROM task_inbox WHERE task_id=4")
    .all();
  assert.deepEqual(
    own.map((row) => [row.actor, row.kind]),
    [["secretary", "failed"]],
    "记账仍记",
  );
  assert.equal(
    (await call("POST", "/api/tasks/t4/stop?as=有 空格")).status,
    400,
  );
});
