import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, detectInstalled } from "../server/tasks/adapters/index.ts";
import { cursorModel } from "../server/tasks/adapters/cursor.ts";
import { recentAction } from "../server/tasks/action.ts";
import { adoptedEnd } from "../server/tasks/adopted-exit.ts";
import {
  abnormalEnding,
  lastAssistantText,
  parseEvents,
} from "../server/tasks/json-log.ts";
import { FALLBACK_ORDER } from "../server/tasks/prepare.ts";
import { resolveWorker } from "../server/tasks/profiles.ts";
import { detectQuotaExhausted } from "../server/tasks/quota-signal.ts";
import { countSteps } from "../server/tasks/summary.ts";
import { tellModeOf } from "../server/tasks/tell.ts";
import { detectTransient } from "../server/tasks/transient.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { profileDb } from "./profile-fixture.ts";
import { startApp, until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/** cursor-agent 2026.09.26 真实输出（auto，读文件、跑 ls、回答 ok），路径换成了 /w/repo-t1-x。 */
const SAMPLE = readFileSync(
  new URL("./fixtures/json-log/cursor-stream.jsonl", import.meta.url),
  "utf8",
);
const SESSION = "28a19893-46ce-4cf2-b22d-8d75202cda02";
const base = {
  promptFile: "/tmp/t1/prompt.md",
  prompt: "修一个 bug",
  cwd: "/w/repo-t1-x",
};
const HEAD = [
  "-p",
  "--output-format",
  "stream-json",
  "--force",
  "--trust",
  "--sandbox",
  "disabled",
  "--workspace",
  "/w/repo-t1-x",
];

test("cursor 适配器：提示词走标准输入，缺省模型 auto，强度写进模型名后缀", () => {
  assert.deepEqual(ADAPTERS.cursor.build(base), {
    command: "cursor-agent",
    args: [...HEAD, "--model", "auto"],
    cwd: "/w/repo-t1-x",
    stdin: "/tmp/t1/prompt.md",
  });
  assert.deepEqual(
    ADAPTERS.cursor.build({ ...base, model: "gpt-5.3-codex", effort: "high" })
      .args,
    [...HEAD, "--model", "gpt-5.3-codex-high"],
  );
  const cursor = ADAPTERS.cursor;
  assert.equal(cursor.executable, "cursor-agent");
  assert.equal(cursor.defaultModel, "auto");
  assert.equal(cursor.quotaProvider, "cursor");
  assert.equal(cursor.exclusive, false);
  assert.ok(cursor.progressSignals.includes("json_events"));
  assert.deepEqual(cursor.defaultRules, { trust: "unknown", max_risk: "low" });
  // 不带 API key：凭据用本机登录。
  assert.ok(!cursor.build(base).args.some((arg) => /api-key/.test(arg)));
  assert.ok(FALLBACK_ORDER.includes("cursor"));
});

test("cursorModel：强度插在 -fast 之前；auto、已带强度、不认识的强度被拒", () => {
  const cases: [string, string | undefined, string][] = [
    ["auto", undefined, "auto"],
    ["composer-2.5", undefined, "composer-2.5"],
    ["gpt-5.3-codex", "xhigh", "gpt-5.3-codex-xhigh"],
    ["claude-opus-5-5", "max", "claude-opus-5-5-max"],
    ["claude-opus-5-5-fast", "low", "claude-opus-5-5-low-fast"],
    ["gpt-5.6-sol", "none", "gpt-5.6-sol-none"],
    ["grok-4.7", "medium", "grok-4.7-medium"],
  ];
  for (const [model, effort, want] of cases)
    assert.equal(cursorModel(model, effort), want, `${model}:${effort}`);
  assert.throws(() => cursorModel("auto", "high"), /auto .*不能指定思考强度/);
  assert.throws(
    () => cursorModel("gpt-5.3-codex-high", "low"),
    /已带强度 high/,
  );
  assert.throws(
    () => cursorModel("claude-opus-5-5-high-fast", "low"),
    /已带强度 high/,
  );
  // 经 build：强度先按适配器声明校验，模型 id 不合法照常拒。
  assert.throws(
    () => ADAPTERS.cursor.build({ ...base, effort: "high" }),
    /auto/,
  );
  assert.throws(
    () =>
      ADAPTERS.cursor.build({
        ...base,
        model: "gpt-5.3-codex",
        effort: "turbo",
      }),
    /思考强度只能是/,
  );
  assert.throws(
    () => ADAPTERS.cursor.build({ ...base, model: "x[effort=high]" }),
    /模型 id 不合法/,
  );
  assert.throws(
    () => ADAPTERS.cursor.build({ ...base, cwd: "relative" }),
    /绝对路径/,
  );
});

test("cursor 捎话：本轮结束后按会话 --resume 续上，会话 id 取 init 事件", () => {
  assert.equal(tellModeOf(ADAPTERS.cursor, undefined), "resume");
  assert.equal(tellModeOf(ADAPTERS.cursor, "stdin"), "resume", "没有输入流");
  assert.equal(tellModeOf(ADAPTERS.cursor, "restart"), "restart");
  assert.equal(ADAPTERS.cursor.sessionOf!(SAMPLE), SESSION);
  assert.equal(ADAPTERS.cursor.sessionOf!("no session"), undefined);
  const resumed = ADAPTERS.cursor.resume!({ ...base, session: SESSION });
  assert.deepEqual(resumed.args, [
    "-p",
    "--resume",
    SESSION,
    ...HEAD.slice(1),
    "--model",
    "auto",
  ]);
  assert.equal(resumed.stdin, base.promptFile);
  assert.throws(
    () => ADAPTERS.cursor.resume!({ ...base, session: "--help" }),
    /会话 id 不合法/,
  );
});

test("cursor 日志：步骤计数、最近动作、最后助手文本、接管后收尾判定", () => {
  // tool_call started/completed 各 2 条、user 1 条、assistant 1 条。
  assert.equal(countSteps(SAMPLE), 6);
  assert.deepEqual(recentAction({ tool: "cursor", tail: SAMPLE }), {
    kind: "step",
    text: "ok",
  });
  // 还没有助手文本：用最后一次开始的工具调用。
  const calls = SAMPLE.split("\n").slice(0, 4).join("\n");
  assert.deepEqual(recentAction({ tool: "cursor", tail: calls }), {
    kind: "tool",
    text: "列文件",
  });
  const read = SAMPLE.split("\n").slice(0, 3).join("\n");
  assert.deepEqual(recentAction({ tool: "cursor", tail: read }), {
    kind: "tool",
    text: "读 a.txt",
  });
  assert.equal(lastAssistantText(parseEvents(SAMPLE)), "ok");
  assert.equal(abnormalEnding(parseEvents(SAMPLE)), undefined);

  assert.deepEqual(adoptedEnd({ tool: "cursor", log: SAMPLE }), {
    end: "clean",
    evidence: "result 事件 subtype=success",
  });
  const failed = SAMPLE.replace(
    /"subtype":"success","duration_ms"/,
    '"subtype":"error","duration_ms"',
  ).replace('"is_error":false', '"is_error":true');
  assert.equal(adoptedEnd({ tool: "cursor", log: failed }).end, "error");
  assert.deepEqual(adoptedEnd({ tool: "cursor", log: calls }), {
    end: "error",
    evidence: "日志没有收尾的 result 事件",
  });
  assert.deepEqual(adoptedEnd({ tool: "cursor" }), { end: "unknown" });
  // claude 的判定不变：没有 stop_reason 的 success 不算正常结束。
  assert.equal(adoptedEnd({ tool: "claude", log: SAMPLE }).end, "error");
});

test("cursor 额度用尽：用量上限与 Spend Limit 报文判到 cursor 账号；正常收尾与助手正文不判", () => {
  const now = new Date("2026-09-28T08:00:00Z");
  const judge = (logTail: string, exitCode: number | null = 1) =>
    detectQuotaExhausted({ exitCode, logTail, now, tool: "cursor" });
  for (const text of [
    "You've hit your usage limit. Get Cursor Pro for more requests.",
    "Your usage limits will reset when your monthly cycle ends on 10/5/2026.",
    "Switch to Auto for more requests or set a Spend Limit to continue with claude-opus-5-5.",
  ]) {
    const verdict = judge(`${SAMPLE.split("\n")[0]}\n${text}\n`);
    assert.ok(verdict.exhausted, text);
    assert.equal(verdict.provider, "cursor");
    assert.equal(verdict.resetAt, null);
  }
  const event = judge(
    '{"type":"result","subtype":"error","is_error":true,"result":"You\'ve hit your usage limit for claude-opus-5-5. Retry-After: 3600"}\n',
  );
  assert.ok(event.exhausted);
  assert.equal(event.resetAt?.toISOString(), "2026-09-28T09:00:00.000Z");
  // 正常结束（退出码 0）与正文里提到额度都不判。
  assert.equal(judge(SAMPLE, 0).exhausted, false);
  assert.equal(
    judge(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"You\'ve hit your usage limit"}]}}\n',
    ).exhausted,
    false,
  );
  // 最后是正常 result：更早的出错报文已越过去。
  assert.equal(
    judge(
      `{"type":"result","subtype":"error","is_error":true,"result":"hit your usage limit"}\n${SAMPLE}`,
      null,
    ).exhausted,
    false,
  );
});

test("cursor 临时错误：出错 result 与混进日志的报错行", () => {
  const hit = detectTransient({
    exitCode: 1,
    json: true,
    logTail: `${SAMPLE.split("\n")[0]}\n{"type":"result","subtype":"error","is_error":true,"result":"ConnectError: [unavailable] read ECONNRESET"}\n`,
  });
  assert.equal(hit?.reason, "供应商或网络临时错误：网络连接出错");
  const line = detectTransient({
    exitCode: 1,
    json: true,
    logTail: `${SAMPLE.split("\n")[0]}\nError: fetch failed\n`,
  });
  assert.equal(line?.reason, "供应商或网络临时错误：网络请求失败");
  assert.equal(
    detectTransient({ exitCode: 0, json: true, logTail: SAMPLE }),
    undefined,
  );
  // 坏模型名是配置问题，不当临时错误重试。
  assert.equal(
    detectTransient({
      exitCode: 1,
      json: true,
      logTail:
        "Cannot use this model: nope. Available models: auto, composer-2.5\n",
    }),
    undefined,
  );
});

test("cursor 档案：没写时按 trust unknown、max_risk low，档案写了以档案为准", async () => {
  const bare = await resolveWorker("cursor", profileDb());
  assert.equal(bare.id, "cursor+auto");
  assert.equal(bare.cliModel, "auto");
  assert.equal(bare.profile.rules.trust, "unknown");
  assert.equal(bare.profile.rules.max_risk, "low");
  const explicit = await resolveWorker("cursor+gpt-5.3-codex:high", undefined);
  assert.equal(explicit.cliModel, "gpt-5.3-codex");
  assert.equal(explicit.effort, "high");
  assert.equal(explicit.profile.rules.max_risk, "low");

  const dir = mkdtempSync(join(tmpdir(), "atrium-cursor-profile-"));
  try {
    mkdirSync(join(dir, "harness"));
    writeFileSync(
      join(dir, "harness", "cursor.md"),
      "---\ntrust: medium\nmax_risk: medium\n---\n",
    );
    const raised = await resolveWorker("cursor", profileDb(dir));
    assert.equal(raised.profile.rules.trust, "medium");
    assert.equal(raised.profile.rules.max_risk, "medium");
  } finally {
    removeTemp(dir);
  }
  // 别的工具不受影响：没有档案时规则仍为空。
  const kimi = await resolveWorker("kimi", profileDb());
  assert.equal(kimi.profile.rules.max_risk, undefined);
});

test("detectInstalled：PATH 上找的是 cursor-agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-cursor-path-"));
  try {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    const file = writeFakeBin(join(dir, "a", "cursor-agent"), "#!/bin/sh\n");
    assert.equal(detectInstalled(join(dir, "a")).cursor, file);
    // 只有 Cursor 编辑器的 cursor 命令不算装了 CLI。
    writeFakeBin(join(dir, "b", "cursor"), "#!/bin/sh\n");
    assert.equal(detectInstalled(join(dir, "b")).cursor, undefined);
  } finally {
    removeTemp(dir);
  }
});

/**
 * 假 cursor-agent：记下参数、环境与标准输入；第一轮打出 init（会话 id）、工具调用后慢慢结束，
 * --resume 时把标准输入里的补充写进助手文本。
 */
const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const sid = "${SESSION}";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const input = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const resumed = argv.includes("--resume");
fs.writeFileSync(path.join(process.env.HOME, resumed ? "cursor-resume.json" : "cursor-run.json"),
  JSON.stringify({ argv, input, env: process.env }));
out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, model: "Auto" });
if (resumed) {
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "续上收到：" + input }] }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: "续上收到：" + input, session_id: sid });
  process.exit(0);
}
out({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "npm test" } } }, session_id: sid });
setTimeout(() => {
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一轮结束" }] }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: "第一轮结束", session_id: sid });
}, 1500);
`;

test("派给假 cursor-agent：白名单环境、标准输入提示词、缺省 auto；捎话本轮结束后 --resume 续上", async (t) => {
  const { fx, data, call } = await startApp(t, (fx) => {
    writeFakeBin(join(fx.root, "bin", "cursor-agent"), FAKE_CURSOR);
  });
  await call("POST", "/api/tasks", { title: "Cursor 小任务", deliver: "none" });
  assert.match(
    (
      await call("POST", "/api/tasks/t1/run", {
        worker: "cursor",
        risk: "medium",
      })
    ).body.error,
    /max_risk=low/,
  );
  const started = await call("POST", "/api/tasks/t1/run", { worker: "cursor" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.task.worker, "cursor+auto");
  const log = join(data, "tasks", "1", "log");
  await until(() => {
    try {
      return readFileSync(log, "utf8").includes('"subtype":"init"');
    } catch {
      return false;
    }
  });
  const told = await call("POST", "/api/tasks/t1/tell", { text: "测试也要补" });
  assert.equal(told.body.tell.route, "after_turn");
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.status, "done", JSON.stringify(done.body.task));

  const home = fx.env.HOME;
  const run = JSON.parse(readFileSync(join(home, "cursor-run.json"), "utf8"));
  assert.deepEqual(run.argv.slice(-2), ["--model", "auto"]);
  assert.ok(run.argv.includes("--force") && run.argv.includes("--trust"));
  assert.match(run.input, /Cursor 小任务/);
  assert.equal(run.env.ATRIUM_WORKER, "1");
  assert.equal(run.env.HERDR_PANE, undefined, "去掉 HERDR_*");
  assert.equal(run.env.CLAUDECODE, undefined);
  const resumed = JSON.parse(
    readFileSync(join(home, "cursor-resume.json"), "utf8"),
  );
  assert.deepEqual(resumed.argv.slice(0, 3), ["-p", "--resume", SESSION]);
  assert.match(resumed.input, /测试也要补/);
  assert.match(done.body.task.result ?? "", /续上收到/);
  const kinds = done.body.task.events.map((e: { kind: string }) => e.kind);
  assert.ok(kinds.includes("tell_resumed"));
});
