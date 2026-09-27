import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { recentAction } from "../server/tasks/action.ts";
import { adoptedEnd } from "../server/tasks/adopted-exit.ts";
import { ADAPTERS } from "../server/tasks/adapters/index.ts";
import { agyModelArgs } from "../server/tasks/adapters/agy.ts";
import { lastAssistantText, parseEvents } from "../server/tasks/json-log.ts";
import { LiveInput, lineSignal, userLine } from "../server/tasks/live-input.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
import { parseWorker } from "../server/tasks/profiles.ts";
import { detectQuotaExhausted } from "../server/tasks/quota-signal.ts";
import { countSteps, summarize } from "../server/tasks/summary.ts";
import { tellModeOf } from "../server/tasks/tell.ts";
import { detectTransient } from "../server/tasks/transient.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { startApp, until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/** 真 agy 1.2.12 的 stream-json 日志，见 tests/fixtures/agy/README.md。 */
const STREAM = readFileSync(
  join(import.meta.dirname, "fixtures", "agy", "stream.jsonl"),
  "utf8",
);
const SESSION = "b3812996-550a-458c-b1da-53b0c843732e";
const base = {
  promptFile: "/tmp/t1/prompt.md",
  prompt: "修一个 bug",
  cwd: "/w/repo-t1-x",
};
const FLAGS = [
  "--output-format",
  "stream-json",
  "--dangerously-skip-permissions",
  "--disable-slash-commands",
];

const result = (status: string, extra: object = {}) =>
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: SESSION,
      status,
      response: "",
      duration_seconds: 0,
      num_turns: 0,
      ...extra,
    },
  });

test("agy 适配器：非捎话走 --print=，捎话走 stream-json 标准输入，续上带 --conversation", () => {
  const agy = ADAPTERS.agy;
  assert.equal(agy.quotaProvider, "antigravity");
  assert.equal(agy.defaultModel, "claude-opus-4-6-thinking");
  assert.ok(agy.progressSignals.includes("json_events"));
  assert.deepEqual(agy.build({ ...base, model: "claude-opus-4-6-thinking" }), {
    command: "agy",
    args: [
      "--print=修一个 bug",
      ...FLAGS,
      "--model",
      "claude-opus-4-6-thinking",
    ],
    cwd: "/w/repo-t1-x",
  });
  // 以 - 开头的提示词在等号形式里不会被当成参数。
  assert.equal(
    agy.build({ ...base, prompt: "--model x" }).args[0],
    "--print=--model x",
  );
  assert.deepEqual(
    agy.build({
      ...base,
      model: "gemini-3.8-flash",
      effort: "high",
      live: true,
    }),
    {
      command: "agy",
      args: [
        "-p",
        "",
        "--input-format",
        "stream-json",
        ...FLAGS,
        "--model",
        "gemini-3.8-flash",
        "--effort",
        "high",
      ],
      cwd: "/w/repo-t1-x",
      stdin: "/tmp/t1/prompt.md",
      input: "stream-json",
      inputDialect: "agy",
    },
  );
  const resumed = agy.resume!({ ...base, session: SESSION, live: true });
  assert.deepEqual(resumed.args.slice(-2), ["--conversation", SESSION]);
  assert.equal(resumed.inputDialect, "agy");
  assert.throws(
    () => agy.resume!({ ...base, session: "../x" }),
    /会话 id 不合法/,
  );
  assert.equal(agy.sessionOf!(STREAM), SESSION);
  assert.equal(agy.sessionOf!('{"event":"result"}'), undefined);
  assert.equal(tellModeOf(agy, undefined), "stdin");
  assert.equal(tellModeOf(agy, "resume"), "resume");
});

test("agy 模型与强度：自带强度的模型名直接用，claude/gpt-oss 不收强度，冲突报错", () => {
  assert.deepEqual(agyModelArgs(), []);
  assert.deepEqual(agyModelArgs("gemini-3.8-flash-high"), [
    "--model",
    "gemini-3.8-flash-high",
  ]);
  assert.deepEqual(
    agyModelArgs("gemini-3.8-flash-high", "high"),
    ["--model", "gemini-3.8-flash-high"],
    "同一档不重复传 --effort",
  );
  assert.deepEqual(agyModelArgs("gemini-3.8-flash", "low"), [
    "--model",
    "gemini-3.8-flash",
    "--effort",
    "low",
  ]);
  assert.deepEqual(agyModelArgs("claude-opus-4-6-thinking"), [
    "--model",
    "claude-opus-4-6-thinking",
  ]);
  assert.throws(
    () => agyModelArgs("gemini-3.8-flash-high", "low"),
    /已带强度 high，与 :low 冲突.*gemini-3\.8-flash-low/,
  );
  assert.throws(
    () => agyModelArgs("gpt-oss-120b-medium", "high"),
    /已带强度 medium/,
  );
  for (const model of ["claude-opus-4-6-thinking", "claude-sonnet-4-6"])
    assert.throws(
      () => agyModelArgs(model, "high"),
      /不接受思考强度（强度含在模型里），去掉 :high/,
    );
  assert.throws(() => agyModelArgs(undefined, "high"), /须同时写模型/);
  // 执行者标识解析后原样交给适配器。
  const spec = parseWorker("agy+claude-opus-4-6-thinking:high");
  assert.deepEqual(spec, {
    tool: "agy",
    model: "claude-opus-4-6-thinking",
    effort: "high",
  });
  assert.throws(
    () =>
      ADAPTERS.agy.build({ ...base, model: spec.model, effort: spec.effort }),
    /不接受思考强度/,
  );
  assert.throws(
    () => ADAPTERS.agy.build({ ...base, effort: "xhigh" }),
    /思考强度只能是 low、medium、high、max/,
  );
  assert.throws(
    () => ADAPTERS.agy.build({ ...base, prompt: " " }),
    /提示词为空/,
  );
});

test("agy 日志：摘要取 result.response，没有 result 时拼回 text_delta，步骤计数与最近动作", () => {
  const events = parseEvents(STREAM);
  assert.match(
    lastAssistantText(events)!,
    /^### 打算怎么做\n我打算使用文件局部替换工具/,
  );
  assert.match(summarize(STREAM, true), /未对整个文件进行重写。/);
  // 被停下时没有 result：把最后一步的片段拼回整段。
  const cut = STREAM.split("\n").filter(
    (line) => !line.includes('"event":"result"'),
  );
  assert.match(
    lastAssistantText(parseEvents(cut.join("\n")))!,
    /^### 打算怎么做\n我打算使用文件局部替换工具精准将 \[e\.txt\]/,
  );
  assert.ok(countSteps(STREAM) > 10);
  assert.equal(countSteps('{"event":"result","result":{}}'), 0);
  // 最近动作：最后一段助手文本的首句（跳过 Markdown 标题）。
  assert.deepEqual(recentAction({ tool: "agy", tail: STREAM }), {
    kind: "step",
    text: "打算怎么做",
  });
  // 文本之前：最后一次工具调用。
  const toolsOnly = cut.filter((line) => !line.includes("text_delta"));
  assert.deepEqual(recentAction({ tool: "agy", tail: toolsOnly.join("\n") }), {
    kind: "tool",
    text: "读 e.txt",
  });
  assert.deepEqual(
    recentAction({
      tool: "agy",
      tail: '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"npm run check"}}}}',
    }),
    { kind: "tool", text: "跑完整检查" },
  );
  const upToEdit = toolsOnly.filter(
    (line) => !line.includes("run_command") && !line.includes('"step_index":5'),
  );
  assert.deepEqual(recentAction({ tool: "agy", tail: upToEdit.join("\n") }), {
    kind: "tool",
    text: "改 e.txt",
  });
  const upToView = upToEdit.filter(
    (line) => !line.includes("replace_file_content"),
  );
  assert.deepEqual(recentAction({ tool: "agy", tail: upToView.join("\n") }), {
    kind: "tool",
    text: "读 e.txt",
  });
});

test("agy 接管后收尾：result status=SUCCESS 正常，ERROR 或没有 result 出错", () => {
  assert.deepEqual(adoptedEnd({ tool: "agy", log: STREAM }), {
    end: "clean",
    evidence: "result 事件 status=SUCCESS",
  });
  const error = adoptedEnd({
    tool: "agy",
    log: result("ERROR", { error: "model unavailable" }),
  });
  assert.deepEqual(error, {
    end: "error",
    evidence: "result 事件 status=ERROR：model unavailable",
  });
  assert.equal(
    adoptedEnd({ tool: "agy", log: STREAM.split("\n").slice(0, 5).join("\n") })
      .end,
    "error",
  );
  assert.deepEqual(adoptedEnd({ tool: "agy" }), { end: "unknown" });
});

test("agy 临时错误：看 ERROR result 的报错与混进来的 stderr 行，SUCCESS 与 0 退出不判", () => {
  const input = (logTail: string, exitCode: number | null = 1) =>
    detectTransient({ exitCode, logTail, json: true });
  assert.deepEqual(
    input(
      result("ERROR", { error: "googleapi: Error 503: Service Unavailable" }),
    ),
    {
      reason: "供应商或网络临时错误：供应商服务端错误（5xx）",
      evidence: "ERROR: googleapi: Error 503: Service Unavailable",
    },
  );
  assert.equal(
    input(result("ERROR", { error: "connection reset by peer" }))?.reason,
    "供应商或网络临时错误：网络连接出错",
  );
  assert.equal(
    input(`${result("ERROR", { error: "" })}\nerror: fetch failed`)?.reason,
    "供应商或网络临时错误：网络请求失败",
    "事件里没有报错正文时看混进来的 stderr 行",
  );
  assert.equal(
    input(
      `${result("ERROR", { error: "googleapi: Error 503" })}\n${result("SUCCESS")}`,
    ),
    undefined,
    "最后是 SUCCESS：之前的报错已越过去",
  );
  assert.equal(
    input(result("ERROR", { error: "invalid model selection" })),
    undefined,
  );
  assert.equal(input(result("SUCCESS")), undefined);
  assert.equal(input(result("ERROR", { error: "503" }), 0), undefined);
});

test("agy 额度用尽：exhausted your quota 与 RESOURCE_EXHAUSTED 记到 antigravity 账号", () => {
  const now = new Date("2026-09-28T10:00:00Z");
  const detect = (logTail: string, exitCode: number | null = 1) =>
    detectQuotaExhausted({ exitCode, logTail, now, tool: "agy" });
  const hit = detect(
    `${STREAM}${result("ERROR", { error: "You have exhausted your quota on this model." })}\n`,
  );
  assert.ok(hit.exhausted);
  assert.equal(hit.provider, "antigravity");
  assert.equal(hit.resetAt, null);
  assert.match(hit.reason, /exhausted your quota/);
  const grpc = detect(
    `${result("ERROR", { error: "rpc error: code = RESOURCE_EXHAUSTED desc = Retry-After: 120" })}\n`,
  );
  assert.ok(grpc.exhausted);
  assert.equal(grpc.resetAt?.getTime(), now.getTime() + 120_000);
  // 先前报过额度、后来一轮成功：越过去了，不判。
  assert.equal(
    detect(
      `${result("ERROR", { error: "RESOURCE_EXHAUSTED" })}\n${result("SUCCESS")}\n`,
    ).exhausted,
    false,
  );
  // 助手正文里提到额度不算。
  assert.equal(
    detect(
      '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"You have exhausted your quota"}}\n',
    ).exhausted,
    false,
  );
  assert.equal(
    detect(result("ERROR", { error: "RESOURCE_EXHAUSTED" }), 0).exhausted,
    false,
  );
});

test("挑执行者：agy 按 antigravity 账号的富余排，pace 缺失时排在固定顺序最后", () => {
  const byPace = pickWorker({
    installed: ["claude", "agy"],
    pace: [
      { providerId: "claude", sparePercent: 5 },
      { providerId: "antigravity", sparePercent: 39 },
    ],
    risk: "low",
    profiles: {},
  });
  assert.ok(byPace.ok && byPace.tool === "agy" && byPace.basis === "pace");
  const fallback = pickWorker({
    installed: ["kimi", "agy"],
    risk: "low",
    profiles: {},
  });
  assert.ok(fallback.ok && fallback.tool === "kimi");
});

test("agy 捎话消息流：event 格式的用户消息，按读入顺序确认，第一条是提示词", async () => {
  assert.deepEqual(JSON.parse(userLine("你好", "u-1", "agy")), {
    event: "user",
    message: { role: "user", content: "你好" },
  });
  assert.deepEqual(lineSignal(result("SUCCESS"), "agy"), { kind: "result" });
  assert.deepEqual(
    lineSignal(
      '{"event":"step_update","step_update":{"step_index":8,"state":"DONE","step_type":"user_input"}}',
      "agy",
    ),
    { kind: "input" },
  );
  assert.equal(
    lineSignal(
      '{"event":"step_update","step_update":{"step_index":8,"state":"ACTIVE","step_type":"user_input"}}',
      "agy",
    ),
    undefined,
  );
  assert.equal(
    lineSignal(
      '{"event":"step_update","step_update":{"step_type":"tool","tool_info":{"output":"\\"event\\":\\"result\\" user_input"}}}',
      "agy",
    ),
    undefined,
    "工具输出里出现这些字样不算",
  );
  assert.equal(lineSignal('{"type":"result"}', "agy"), undefined);
  assert.equal(lineSignal('{"event":"result"', "agy"), undefined);

  const dir = mkdtempSync(join(tmpdir(), "atrium-agy-live-"));
  try {
    const log = join(dir, "log");
    const header = "[atrium] 抬头\n";
    writeFileSync(log, header);
    const stdin = new PassThrough();
    let written = "";
    stdin.on("data", (chunk) => (written += chunk));
    const echoed: string[] = [];
    const live = new LiveInput(
      stdin,
      log,
      Buffer.byteLength(header),
      (uuid) => echoed.push(uuid),
      10_000,
      "agy",
    );
    const input = (index: number) =>
      `{"event":"step_update","step_update":{"step_index":${index},"state":"DONE","step_type":"user_input"}}\n`;
    assert.ok(live.send("补充一", "a"));
    assert.ok(live.send("补充二", "b"));
    assert.match(
      written,
      /^\{"event":"user","message":\{"role":"user","content":"补充一"\}\}\n/,
    );
    writeFileSync(log, `${header}${input(0)}${result("SUCCESS")}\n${input(8)}`);
    await live.scan();
    assert.deepEqual(echoed, ["a"], "第一条读入是提示词，之后按写入顺序确认");
    assert.equal(live.open, true, "还有没确认的捎话，本轮结束也不关");
    writeFileSync(
      log,
      `${header}${input(0)}${result("SUCCESS")}\n${input(8)}${result("SUCCESS")}\n${input(12)}${result("SUCCESS")}\n`,
    );
    await live.scan();
    assert.deepEqual(echoed, ["a", "b"]);
    assert.equal(live.open, false, "都确认了，最后一轮结束关掉写端");
    await live.finish();
  } finally {
    removeTemp(dir);
  }
});

/** 假 agy：按 agy 1.2.12 的 stream-json 协议读标准输入，每行一轮；读到 EOF 才退出。 */
const FAKE_AGY = `#!/usr/bin/env node
const sid = "${SESSION}";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const step = (s) => out({ event: "step_update", step_update: { conversation_id: sid, ...s } });
out({ event: "init", conversation_id: sid, init: { model: "fake", cwd: process.cwd(), args: process.argv.slice(2) } });
let n = 0, i = 0, turns = [];
const turn = (text) => {
  step({ step_index: i++, state: "DONE", step_type: "user_input" });
  if (n === 1) step({ step_index: i++, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 1" } } });
  const reply = n === 1 ? "第一轮完成" : "收到补充：" + text;
  setTimeout(() => {
    step({ step_index: i++, state: "DONE", step_type: "agent_response", text_delta: reply });
    out({ event: "result", result: { conversation_id: sid, status: "SUCCESS", response: reply, num_turns: n } });
    busy = false; next();
  }, n === 1 ? 1500 : 200);
};
let busy = false;
const next = () => { if (busy || !turns.length) return; busy = true; n++; turn(turns.shift()); };
require("node:readline").createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.event !== "user") { out({ event: "result", result: { status: "ERROR", error: "stream input message is missing the \\"event\\" field" } }); process.exit(1); }
    turns.push(msg.message.content); next();
  })
  .on("close", () => { const wait = () => (busy || turns.length ? setTimeout(wait, 50) : (step({ step_index: i++, state: "DONE", step_type: "stdin_closed", turns: n }), process.exit(0))); wait(); });
`;

test("端到端：假 agy 在运行中收到捎话，排成下一轮，读入后记为已送达，读到 EOF 正常退出", async (t) => {
  const { data, call } = await startApp(t, (fx) => {
    writeFakeBin(join(fx.root, "bin", "agy"), FAKE_AGY);
    writeFileSync(
      join(fx.workers, "harness", "agy.md"),
      "---\nchecks: []\n---\n",
    );
  });
  await call("POST", "/api/tasks", { title: "agy 捎话", deliver: "none" });
  const run = await call("POST", "/api/tasks/t1/run", {
    worker: "agy+gemini-3.8-flash:low",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const log = join(data, "tasks", "1", "log");
  await until(() => {
    try {
      return readFileSync(log, "utf8").includes('"run_command"');
    } catch {
      return false;
    }
  });
  const told = await call("POST", "/api/tasks/t1/tell", { text: "改用 v2" });
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.equal(told.body.tell.route, "stdin");
  const done = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(done.body.task.status, "done", JSON.stringify(done.body.task));
  assert.match(
    done.body.task.result,
    /^收到补充：补充说明（u1 · [^）]+）：\n\n改用 v2/,
  );
  const text = readFileSync(log, "utf8");
  assert.match(
    text,
    /-p {2}--input-format stream-json --output-format stream-json --dangerously-skip-permissions --disable-slash-commands --model gemini-3\.8-flash --effort low/,
  );
  assert.match(text, /"step_type":"stdin_closed","turns":2/);
  assert.doesNotMatch(text, /missing the/);
  const tell = done.body.task.events
    .filter((event: { kind: string }) => event.kind === "tell")
    .map((event: { detail: string }) => JSON.parse(event.detail))[0];
  assert.equal(tell.state, "delivered");
  assert.equal(tell.delivered_via, "stdin");
});
