import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { ADAPTERS } from "../server/tasks/adapters/index.ts";
import { ensureTaskTables, createTask } from "../server/tasks/ledger.ts";
import { LiveInput, lineSignal, userLine } from "../server/tasks/live-input.ts";
import {
  afterExit,
  resumeMessage,
  routeTell,
  tellModeOf,
  tellSection,
} from "../server/tasks/tell.ts";
import {
  addTell,
  listTells,
  markDelivered,
  markEchoed,
  markWritten,
  tellCounts,
  tellInput,
  unsent,
} from "../server/tasks/tell-ledger.ts";
import { startApp, until } from "./task-fixture.ts";
import { writeFakeBin } from "./fake-bin.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const base = {
  promptFile: "/tmp/t/prompt.md",
  prompt: "做点事",
  cwd: "/tmp/repo",
};

test("送达方式：适配器缺省，档案只能改成工具支持的方式", () => {
  assert.equal(tellModeOf(ADAPTERS.claude, undefined), "stdin");
  assert.equal(tellModeOf(ADAPTERS.codex, undefined), "resume");
  for (const tool of ["opencode", "grok", "kimi"] as const)
    assert.equal(tellModeOf(ADAPTERS[tool], undefined), "restart");
  assert.equal(tellModeOf(ADAPTERS.claude, "resume"), "resume");
  assert.equal(tellModeOf(ADAPTERS.claude, "restart"), "restart");
  assert.equal(
    tellModeOf(ADAPTERS.codex, "stdin"),
    "resume",
    "codex 不能即时写入",
  );
  assert.equal(tellModeOf(ADAPTERS.codex, "restart"), "restart");
  assert.equal(tellModeOf(ADAPTERS.kimi, "resume"), "restart", "kimi 不能续上");
  assert.equal(tellModeOf(ADAPTERS.claude, "turbo"), "stdin", "写错退回缺省");
});

test("捎话分派：即时送入、本轮结束后续上、停掉重派、下次拉起、拒绝", () => {
  const running = { status: "running" as const, running: true };
  assert.deepEqual(routeTell({ ...running, mode: "stdin", live: true }), {
    kind: "stdin",
  });
  assert.deepEqual(routeTell({ ...running, mode: "stdin", live: false }), {
    kind: "after_turn",
  });
  assert.deepEqual(routeTell({ ...running, mode: "resume", live: false }), {
    kind: "after_turn",
  });
  assert.deepEqual(routeTell({ ...running, mode: "restart", live: false }), {
    kind: "restart",
  });
  for (const status of ["todo", "blocked", "failed", "running"] as const)
    assert.deepEqual(
      routeTell({ status, running: false, mode: undefined, live: false }),
      { kind: "next_run" },
    );
  for (const status of ["done", "cancelled"] as const) {
    const route = routeTell({ status, running: false, live: false });
    assert.equal(route.kind, "reject");
  }
});

test("退出后：有没送到的就续上或重派，被停下、非 0 退出照常收尾", () => {
  const ok = { code: 0, signal: null };
  const one = { exit: ok, pending: 1, session: SESSION };
  assert.equal(afterExit({ ...one, mode: "resume" }), "resume");
  assert.equal(afterExit({ ...one, mode: "stdin" }), "resume");
  assert.equal(afterExit({ ...one, exit: "unknown", mode: "stdin" }), "resume");
  assert.equal(afterExit({ ...one, mode: "restart" }), "restart");
  assert.equal(
    afterExit({ ...one, session: undefined, mode: "resume" }),
    "restart",
    "取不到会话就重派",
  );
  assert.equal(afterExit({ ...one, pending: 0, mode: "resume" }), "settle");
  assert.equal(
    afterExit({ ...one, exit: { code: 1, signal: null }, mode: "resume" }),
    "settle",
  );
  assert.equal(
    afterExit({ ...one, stop: { kind: "user" }, mode: "resume" }),
    "settle",
  );
  assert.equal(
    afterExit({
      ...one,
      pending: 0,
      exit: { code: null, signal: "SIGTERM" },
      stop: { kind: "tell" },
      mode: "restart",
    }),
    "restart",
  );
});

test("适配器：claude 即时输入与续上的参数，codex 续上与会话 id", () => {
  const live = ADAPTERS.claude.build({ ...base, live: true });
  assert.equal(live.input, "stream-json");
  assert.deepEqual(live.args.slice(0, 7), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--replay-user-messages",
  ]);
  assert.equal(ADAPTERS.claude.build(base).input, undefined, "不捎话时照旧");
  const resumed = ADAPTERS.claude.resume!({
    ...base,
    live: true,
    session: SESSION,
  });
  assert.deepEqual(resumed.args.slice(0, 3), ["-p", "--resume", SESSION]);
  assert.throws(
    () => ADAPTERS.claude.resume!({ ...base, session: "--help" }),
    /会话 id 不合法/,
  );
  assert.equal(
    ADAPTERS.claude.sessionOf!(
      `{"type":"system","subtype":"hook_started"}\n{"type":"system","subtype":"init","cwd":"/x","session_id":"${SESSION}","tools":[]}\n`,
    ),
    SESSION,
  );
  const codex = ADAPTERS.codex.resume!({
    ...base,
    model: "gpt-6-sol",
    effort: "high",
    session: SESSION,
  });
  assert.deepEqual(codex.args, [
    "exec",
    "resume",
    "-c",
    'sandbox_mode="danger-full-access"',
    "-m",
    "gpt-6-sol",
    "-c",
    'model_reasoning_effort="high"',
    "-o",
    join("/tmp/t", "last-message.md"),
    SESSION,
    "-",
  ]);
  assert.equal(codex.stdin, base.promptFile);
  assert.equal(
    ADAPTERS.codex.sessionOf!(
      `OpenAI Codex v0.157.1\n--------\nsession id: ${SESSION}\n--------\n`,
    ),
    SESSION,
  );
  assert.equal(ADAPTERS.codex.sessionOf!("no session"), undefined);
  assert.equal(ADAPTERS.kimi.resume, undefined);
});

test("日志行：只认 result 与带 uuid 的回显", () => {
  assert.deepEqual(lineSignal('{"type":"result","subtype":"success"}'), {
    kind: "result",
  });
  assert.deepEqual(lineSignal('{"stop_reason":"end_turn","type":"result"}'), {
    kind: "result",
  });
  assert.equal(
    lineSignal('{"message":{"type":"result"},"type":"assistant"}'),
    undefined,
  );
  assert.deepEqual(
    lineSignal(
      `{"type":"user","message":{"role":"user","content":"x"},"uuid":"${SESSION}","isReplay":true}`,
    ),
    { kind: "echo", uuid: SESSION },
  );
  assert.equal(
    lineSignal(`{"type":"user","message":{"content":[]},"uuid":"${SESSION}"}`),
    undefined,
    "工具结果不是回显",
  );
  assert.equal(lineSignal('{"type":"assistant","result":"x"}'), undefined);
  assert.equal(lineSignal('{"type":"user","isReplay":true,"x":'), undefined);
  // claude 2.1.283：result 行 type 不在行首；正文里转义过的字样不算
  assert.deepEqual(
    lineSignal(
      '{"duration_api_ms":6168,"stop_reason":"end_turn","result":"好了","type":"result","subtype":"success"}',
    ),
    { kind: "result" },
  );
  assert.deepEqual(
    lineSignal(
      `{"message":{"role":"user","content":"x"},"isReplay":true,"type":"user","uuid":"${SESSION}"}`,
    ),
    { kind: "echo", uuid: SESSION },
  );
  assert.equal(
    lineSignal(
      JSON.stringify({ type: "assistant", text: '{"type":"result"}' }),
    ),
    undefined,
  );
  assert.equal(
    lineSignal(
      JSON.stringify({ type: "assistant", inner: { type: "result" } }),
    ),
    undefined,
  );
  const line = JSON.parse(userLine("你好", SESSION));
  assert.deepEqual(line.message, { role: "user", content: "你好" });
  assert.equal(line.uuid, SESSION);
});

test("标准输入写端：读到 result 关掉，回显按 uuid 确认，退出后写不进", async () => {
  const dir = (await import("node:fs")).mkdtempSync(
    join((await import("node:os")).tmpdir(), "atrium-live-"),
  );
  const log = join(dir, "log");
  writeFileSync(log, "[atrium] 抬头\n");
  const stdin = new PassThrough();
  let ends = 0;
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: Parameters<typeof stdin.end>) => {
    ends++;
    return originalEnd(...args);
  }) as typeof stdin.end;
  let written = "";
  stdin.on("data", (chunk) => (written += chunk));
  const echoed: string[] = [];
  const live = new LiveInput(
    stdin,
    log,
    13 + 3,
    (uuid) => echoed.push(uuid),
    10_000,
  );
  assert.ok(live.send("补充", SESSION));
  assert.match(written, /"content":"补充"/);
  writeFileSync(
    log,
    `[atrium] 抬头\n{"type":"user","uuid":"${SESSION}","isReplay":true,"message":{"content":"补充"}}\n{"type":"result","subtype":"success"}\n`,
  );
  await live.scan();
  assert.deepEqual(echoed, [SESSION]);
  assert.equal(live.open, false, "本轮结束就关掉写端");
  assert.equal(live.send("晚了", SESSION), false);
  await live.finish();
  assert.equal(ends, 1, "写端只关闭一次");
});

test("捎话的账：登记、写入、回显送达、计数与破坏输入", () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  createTask(db, { title: "a" });
  assert.throws(() => tellInput({ text: " " }), /捎话不能为空/);
  assert.throws(
    () => tellInput({ text: "x".repeat(4001) }),
    /不能超过 4000 字/,
  );
  assert.throws(() => tellInput({ text: "x", extra: 1 }), /只接受 text、by/);
  assert.throws(() => tellInput({ text: "x", by: "../x" }));
  assert.throws(() => tellInput([]), /JSON 对象/);
  assert.deepEqual(tellInput({ text: " 改用 v2 " }), {
    text: "改用 v2",
    by: "u1",
  });
  const first = addTell(db, 1, {
    text: "一",
    by: "u1",
    uuid: SESSION,
    route: "stdin",
  });
  const second = addTell(db, 1, {
    text: "二",
    by: "a1",
    uuid: "",
    route: "after_turn",
  });
  markWritten(db, first);
  assert.equal(listTells(db, 1)[0]!.state, "written");
  assert.equal(unsent(listTells(db, 1)).length, 2, "写入未确认仍算没送到");
  assert.equal(markEchoed(db, 1, SESSION), 1);
  assert.equal(markEchoed(db, 1, "unknown"), 0);
  assert.deepEqual(tellCounts(db, [1, 2]).get(1), { total: 2, pending: 1 });
  assert.equal(markDelivered(db, 1, [first.id, second.id], "resume"), 1);
  const tells = listTells(db, 1);
  assert.equal(tells[0]!.delivered_via, "stdin", "已送达的不改");
  assert.equal(tells[1]!.delivered_via, "resume");
  db.prepare("UPDATE task_events SET detail='{坏' WHERE id=?").run(second.id);
  assert.equal(listTells(db, 1).length, 1, "写坏的跳过");
  assert.match(tellSection(tells)!, /a1 · .*：二/);
  assert.match(resumeMessage([tells[1]!]), /二\n\n与前文冲突时以这条为准/);
  db.close();
});

/** 假 claude：读 stream-json 标准输入，回显带 uuid 的消息，收到补充就把它写进回复；读到 EOF 才退出。 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const sid = "${SESSION}";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const replay = process.argv.includes("--replay-user-messages");
let n = 0, resulted = false;
const finish = () => { if (resulted) return; resulted = true; out({ type: "result", subtype: "success", is_error: false, result: "done" }); };
out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, args: process.argv.slice(2) });
const timer = setTimeout(finish, 2000);
require("node:readline").createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = JSON.parse(line); n++;
    if (replay && msg.uuid) out({ ...msg, session_id: sid, isReplay: true });
    if (n === 1) { out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 1" } }] } }); return; }
    out({ type: "assistant", message: { content: [{ type: "text", text: "收到补充：" + msg.message.content }] } });
    clearTimeout(timer); finish();
  })
  .on("close", () => { out({ type: "system", subtype: "stdin_closed" }); process.exit(resulted ? 0 : 3); });
`;

/** 假 codex：第一轮打出会话 id 后慢慢结束；resume 时把标准输入里的补充写进日志。 */
const FAKE_CODEX = `#!/bin/sh
if [ "$2" = "resume" ]; then
  echo "resume args: $*"
  echo "续上收到：$(cat)"
  exit 0
fi
cat >/dev/null
echo "OpenAI Codex (fake)"
echo "session id: ${SESSION}"
sleep 1.5
echo "第一轮结束"
`;

/** 假 kimi：提示词里有补充就立即完成，否则一直干活。 */
const FAKE_KIMI = `#!/bin/sh
case "$2" in *改用方案B*) echo "看到补充：改用方案B"; exit 0;; esac
echo working
sleep 20
`;

async function tellApp(t: Parameters<typeof startApp>[0]) {
  return startApp(t, (fx) => {
    for (const [name, body] of [
      ["claude", FAKE_CLAUDE],
      ["codex", FAKE_CODEX],
      ["kimi", FAKE_KIMI],
    ] as const) {
      writeFakeBin(join(fx.root, "bin", name), body);
      writeFileSync(
        join(fx.workers, "harness", `${name}.md`),
        "---\nchecks: []\n---\n",
      );
    }
  });
}

type Event = { kind: string; detail: string | null };
const tellsOf = (events: Event[]) =>
  events
    .filter((event) => event.kind === "tell")
    .map((event) => JSON.parse(event.detail!));

test("即时送入：假 Claude 在运行中收到捎话，回显后记为已送达，读到 EOF 正常退出", async (t) => {
  const { data, call } = await tellApp(t);
  await call("POST", "/api/tasks", { title: "即时", deliver: "none" });
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "claude" })).status,
    200,
  );
  const log = join(data, "tasks", "1", "log");
  await until(() => {
    try {
      return readFileSync(log, "utf8").includes('"tool_use"');
    } catch {
      return false;
    }
  });
  const told = await call("POST", "/api/tasks/t1/tell", {
    text: "接口改用 v2",
  });
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.equal(told.body.tell.route, "stdin");
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.status, "done");
  const text = readFileSync(log, "utf8");
  assert.match(text, /--input-format stream-json --replay-user-messages/);
  assert.match(text, /"isReplay":true/);
  assert.match(text, /收到补充：补充说明（u1 · [^）]+）：\\n\\n接口改用 v2/);
  assert.match(text, /stdin_closed/, "本轮结束后服务关掉了标准输入");
  const [tell] = tellsOf(done.body.task.events);
  assert.equal(tell.state, "delivered");
  assert.equal(tell.delivered_via, "stdin");
  assert.equal(tell.by, "u1");
  const top = await call("GET", "/api/tasks/top");
  assert.deepEqual(top.body.rows[0].tells, { total: 1, pending: 0 });
});

test("捎话跨两轮 result：假 Claude 最后一轮结束后收到 EOF 并正常退出", async (t) => {
  const { fx, data, call } = await tellApp(t);
  writeFileSync(
    join(fx.root, "bin", "claude"),
    `#!/usr/bin/env node
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let count = 0;
let second = false;
out({ type: "system", subtype: "init", session_id: "${SESSION}" });
require("node:readline").createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    count++;
    if (count === 1) {
      out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
      setTimeout(() => out({ stop_reason: "end_turn", result: "first", is_error: false, type: "result" }), 300);
    } else {
      setTimeout(() => out({ ...message, isReplay: true }), 450);
      setTimeout(() => { second = true; out({ stop_reason: "end_turn", result: "second", is_error: false, type: "result" }); }, 650);
    }
  })
  .on("close", () => {
    out({ type: "system", subtype: "stdin_closed", count });
    process.exit(second ? 0 : 3);
  });
`,
  );
  await call("POST", "/api/tasks", { title: "两轮", deliver: "none" });
  await call("POST", "/api/tasks/t1/run", { worker: "claude" });
  const log = join(data, "tasks", "1", "log");
  await until(() => readFileSync(log, "utf8").includes('"tool_use"'));
  assert.equal(
    (await call("POST", "/api/tasks/t1/tell", { text: "补充" })).body.tell
      .route,
    "stdin",
  );
  const done = await call("GET", "/api/tasks/t1/wait?timeout=5");
  assert.equal(done.body.task.status, "done");
  assert.equal(done.body.task.result, "second");
  assert.match(readFileSync(log, "utf8"), /"subtype":"stdin_closed","count":2/);
});

test("不捎话时 Claude 照旧：提示词作为第一条消息写入，本轮结束关掉输入，退出码 0", async (t) => {
  const { data, call } = await tellApp(t);
  await call("POST", "/api/tasks", { title: "照旧", deliver: "none" });
  await call("POST", "/api/tasks/t1/run", { worker: "claude" });
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.status, "done");
  assert.equal(done.body.task.result, "done");
  const text = readFileSync(join(data, "tasks", "1", "log"), "utf8");
  assert.match(text, /stdin_closed/);
  assert.equal(tellsOf(done.body.task.events).length, 0);
});

test("下一轮续上：假 codex 本轮结束后以 exec resume <会话> 带着补充继续，关卡按续上后的结果判", async (t) => {
  const { data, call } = await tellApp(t);
  await call("POST", "/api/tasks", { title: "续上", deliver: "none" });
  await call("POST", "/api/tasks/t1/run", { worker: "codex" });
  const log = join(data, "tasks", "1", "log");
  await until(() => {
    try {
      return readFileSync(log, "utf8").includes("session id:");
    } catch {
      return false;
    }
  });
  const told = await call("POST", "/api/tasks/t1/tell", { text: "测试也要补" });
  assert.equal(told.body.tell.route, "after_turn");
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.status, "done");
  const text = readFileSync(log, "utf8");
  assert.match(
    text,
    /第一轮结束[\s\S]*续上会话[\s\S]*resume args: exec resume -c sandbox_mode=/,
  );
  assert.match(text, new RegExp(`${SESSION} -\\n`));
  assert.match(text, /续上收到：补充说明（u1 · [^）]+）：\n\n测试也要补/);
  const kinds = done.body.task.events.map((event: Event) => event.kind);
  assert.ok(kinds.includes("tell_resumed"));
  assert.equal(
    kinds.filter((kind: string) => kind === "exit_ok").length,
    1,
    "只收尾一次",
  );
  const [tell] = tellsOf(done.body.task.events);
  assert.equal(tell.delivered_via, "resume");
});

test("兜底：不能追加的执行者停掉、带着补充重派；不在跑的写进下次提示词；已完成拒绝", async (t) => {
  const { data, call } = await tellApp(t);
  await call("POST", "/api/tasks", { title: "重派", deliver: "none" });
  await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  const log = join(data, "tasks", "1", "log");
  await until(() => {
    try {
      return readFileSync(log, "utf8").includes("working");
    } catch {
      return false;
    }
  });
  const told = await call("POST", "/api/tasks/t1/tell", { text: "改用方案B" });
  assert.equal(told.body.tell.route, "restart");
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.status, "done");
  assert.match(readFileSync(log, "utf8"), /看到补充：改用方案B/);
  assert.match(
    readFileSync(join(data, "tasks", "1", "prompt.md"), "utf8"),
    /## 运行中收到的补充[\s\S]*改用方案B[\s\S]*运行中可能收到补充说明/,
  );
  const kinds = done.body.task.events.map((event: Event) => event.kind);
  assert.ok(kinds.includes("tell_restarted"));
  assert.ok(!kinds.includes("exit_fail"), "为送捎话停下不算失败");
  assert.equal(tellsOf(done.body.task.events)[0].delivered_via, "restart");

  // 已完成的拒绝；空文本、坏作者按参数名报错。
  assert.equal(
    (await call("POST", "/api/tasks/t1/tell", { text: "晚了" })).status,
    409,
  );
  const empty = await call("POST", "/api/tasks/t1/tell", { text: "" });
  assert.equal(empty.status, 400);
  assert.match(JSON.stringify(empty.body), /text/);
  assert.equal(
    (await call("POST", "/api/tasks/t1/tell", { text: "x", by: "../u" }))
      .status,
    400,
  );

  // 还没派的：登记后等拉起时写进提示词。
  await call("POST", "/api/tasks", { title: "先捎话", deliver: "none" });
  const early = await call("POST", "/api/tasks/t2/tell", { text: "改用方案B" });
  assert.equal(early.body.tell.route, "next_run");
  await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  const second = await call("GET", "/api/tasks/t2/wait?timeout=20");
  assert.equal(second.body.task.status, "done");
  assert.equal(tellsOf(second.body.task.events)[0].delivered_via, "prompt");
});
