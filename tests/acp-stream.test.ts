import { test } from "node:test";
import assert from "node:assert/strict";
import { inputMessage } from "../server/acp/bridge.ts";
import { sessionConfig } from "../server/acp/session-config.ts";
import {
  pickPermission,
  resultEvent,
  StreamTranslator,
} from "../server/acp/stream.ts";
import { adoptedEnd } from "../server/tasks/adopted-exit.ts";
import { structuredAction } from "../server/tasks/action.ts";
import { lastAssistantText } from "../server/tasks/json-log.ts";
import { lineSignal, userLine } from "../server/tasks/live-input.ts";

const text = (value: string, kind = "agent_message_chunk") => ({
  sessionUpdate: kind,
  content: { type: "text", text: value },
});

test("翻译：文字与思考攒成段，工具调用前写出；工具结束写结果；lastText 是最后一次工具调用之后的话", () => {
  const log = new StreamTranslator();
  assert.deepEqual(log.update(text("我先")), []);
  assert.deepEqual(log.update(text("看看", "agent_thought_chunk")), []);
  assert.deepEqual(log.update(text("读一下代码。")), []);
  const call = log.update({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "Read server/app.ts",
    kind: "read",
    status: "pending",
    locations: [{ path: "/w/server/app.ts" }],
  });
  assert.deepEqual(
    call.map(
      (event) =>
        (event.message as { content: { type: string }[] }).content[0]!.type,
    ),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual((call[2]!.message as { content: unknown[] }).content[0], {
    type: "tool_use",
    id: "c1",
    name: "read",
    input: { path: "/w/server/app.ts", description: "Read server/app.ts" },
  });
  assert.deepEqual(
    log.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      title: "改了标题",
    }),
    [],
  );
  const done = log.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "failed",
    content: [
      { type: "content", content: { type: "text", text: "x".repeat(2500) } },
    ],
  });
  const result = (done[0]!.message as { content: Record<string, unknown>[] })
    .content[0]!;
  assert.equal(result.type, "tool_result");
  assert.equal(result.is_error, true);
  assert.equal((result.content as string).length, 2001);
  log.update(text("改好了。"));
  assert.equal(log.lastText, "改好了。");
  const tail = log.flush();
  assert.equal(tail.length, 1);
  assert.deepEqual(log.flush(), [], "写出后清空");
  assert.equal(log.lastText, "改好了。", "本轮的结果留到下一轮开始");
  log.turn();
  assert.equal(log.lastText, "");
  // 同一个工具调用重复来 tool_call（有的工具先报 pending 再补全）只写一次 tool_use。
  const again = new StreamTranslator();
  again.update({
    sessionUpdate: "tool_call",
    toolCallId: "c2",
    kind: "execute",
    rawInput: { command: "ls" },
  });
  assert.deepEqual(
    again.update({
      sessionUpdate: "tool_call",
      toolCallId: "c2",
      kind: "execute",
    }),
    [],
  );
  // 长回复攒满就先写一段。
  const long = new StreamTranslator();
  assert.equal(long.update(text("字".repeat(4000))).length, 1);
  // 不认识的更新（plan、available_commands_update 等）不写。
  assert.deepEqual(long.update({ sessionUpdate: "plan", entries: [] }), []);
});

test("翻译出的日志按 claude 的规则读得懂：最近动作、摘要、接管后退出、回显与 result", () => {
  const log = new StreamTranslator();
  const lines = [
    ...log.update({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "npm test",
      kind: "execute",
      rawInput: { command: "npm test -- tests/a.test.ts" },
    }),
  ].map((event) => JSON.stringify(event));
  assert.equal(structuredAction(lines.join("\n"))!.text, "跑测试");
  log.update(text("全部通过，PR 已开。"));
  lines.push(...log.flush().map((event) => JSON.stringify(event)));
  lines.push(
    JSON.stringify(
      resultEvent({
        sessionId: "s",
        stopReason: "end_turn",
        text: log.lastText,
      }),
    ),
  );
  const all = lines.join("\n");
  assert.equal(
    lastAssistantText(all.split("\n").map((line) => JSON.parse(line))),
    "全部通过，PR 已开。",
  );
  assert.deepEqual(adoptedEnd({ tool: "claude", log: all }), {
    end: "clean",
    evidence: "result 事件 stop_reason=end_turn",
  });
  assert.deepEqual(lineSignal(lines.at(-1)!), { kind: "result" });
  const refused = JSON.stringify(
    resultEvent({ sessionId: "s", stopReason: "refusal", text: "不做" }),
  );
  assert.equal(adoptedEnd({ tool: "claude", log: refused }).end, "error");
});

test("result：end_turn 为正常，其余与出错都是 is_error，原因写在前面", () => {
  assert.deepEqual(
    resultEvent({ sessionId: "s", stopReason: "end_turn", text: "好了" }),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      session_id: "s",
      result: "好了",
    },
  );
  const cases = [
    [
      { stopReason: "max_turn_requests" as const },
      "error_max_turns",
      /本轮以 max_turn_requests 结束\n半截/,
    ],
    [
      { stopReason: "max_tokens" as const },
      "error_during_execution",
      /max_tokens/,
    ],
    [
      { stopReason: "cancelled" as const },
      "error_during_execution",
      /cancelled/,
    ],
    [
      { error: "ACP 请求出错：429" },
      "error_during_execution",
      /^ACP 请求出错：429\n半截$/,
    ],
  ] as const;
  for (const [extra, subtype, pattern] of cases) {
    const event = resultEvent({ sessionId: "s", text: "半截", ...extra });
    assert.equal(event.is_error, true);
    assert.equal(event.subtype, subtype);
    assert.match(String(event.result), pattern);
  }
});

test("权限答复：allow 优先允许一次，reject 优先拒绝一次，没有对应选项就取消", () => {
  const all = [
    { optionId: "a1", name: "", kind: "allow_always" as const },
    { optionId: "a0", name: "", kind: "allow_once" as const },
    { optionId: "r1", name: "", kind: "reject_always" as const },
    { optionId: "r0", name: "", kind: "reject_once" as const },
  ];
  assert.deepEqual(pickPermission(all, "allow"), {
    outcome: "selected",
    optionId: "a0",
  });
  assert.deepEqual(pickPermission(all, "reject"), {
    outcome: "selected",
    optionId: "r0",
  });
  assert.deepEqual(pickPermission([all[0]!], "allow"), {
    outcome: "selected",
    optionId: "a1",
  });
  assert.deepEqual(pickPermission([all[2]!], "reject"), {
    outcome: "selected",
    optionId: "r1",
  });
  assert.deepEqual(pickPermission([all[2]!], "allow"), {
    outcome: "cancelled",
  });
  assert.deepEqual(pickPermission([], "reject"), { outcome: "cancelled" });
});

test("会话配置：配置项优先，其次模型列表；按值或显示名匹配；分组选项展开；不支持时说清", () => {
  const options = {
    configOptions: [
      {
        id: "m",
        category: "model",
        type: "select",
        options: [
          { group: "GLM", options: [{ value: "glm-5", name: "GLM 5" }] },
          { value: "glm-4.6" },
        ],
      },
      {
        id: "t",
        category: "thought_level",
        type: "select",
        options: [{ value: "low" }, { value: "high", name: "深想" }],
      },
    ],
    models: { availableModels: [{ modelId: "other" }] },
  };
  assert.deepEqual(
    sessionConfig("s", options, { model: "GLM 5", effort: "深想" }),
    {
      ok: true,
      requests: [
        {
          method: "session/set_config_option",
          params: { sessionId: "s", configId: "m", value: "glm-5" },
        },
        {
          method: "session/set_config_option",
          params: { sessionId: "s", configId: "t", value: "high" },
        },
      ],
    },
  );
  assert.deepEqual(
    sessionConfig(
      "s",
      { models: { availableModels: [{ modelId: "a" }, { modelId: "b" }] } },
      { model: "b" },
    ),
    {
      ok: true,
      requests: [
        {
          method: "session/set_model",
          params: { sessionId: "s", modelId: "b" },
        },
      ],
    },
  );
  assert.deepEqual(sessionConfig("s", {}, {}), { ok: true, requests: [] });
  const problem = (
    session: unknown,
    wanted: { model?: string; effort?: string },
  ) => {
    const plan = sessionConfig("s", session, wanted);
    assert.equal(plan.ok, false);
    return plan.ok ? "" : plan.problem;
  };
  assert.match(problem({}, { model: "x" }), /model_args/);
  assert.match(problem(null, { model: "x" }), /model_args/);
  assert.match(
    problem(options, { model: "x" }),
    /可选模型里没有 x；可选：glm-5、glm-4\.6/,
  );
  assert.match(
    problem({ models: { availableModels: [] } }, { model: "x" }),
    /可选：（空）/,
  );
  assert.match(problem({ models: {} }, { effort: "low" }), /effort_args/);
  assert.match(
    problem(options, { effort: "max" }),
    /思考强度里没有 max；可选：low、high/,
  );
  const many = {
    models: {
      availableModels: Array.from({ length: 20 }, (_, i) => ({
        modelId: `m${i}`,
      })),
    },
  };
  assert.match(problem(many, { model: "x" }), /m11 等 20 个/);
});

test("标准输入的一行：只认带文字的用户消息，uuid 原样带上", () => {
  assert.deepEqual(inputMessage(userLine("做事").trim()), { text: "做事" });
  assert.deepEqual(inputMessage(userLine("补充", "u-1").trim()), {
    text: "补充",
    uuid: "u-1",
  });
  assert.deepEqual(
    inputMessage(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "image" },
            { type: "text", text: "b" },
          ],
        },
      }),
    ),
    { text: "ab" },
  );
  for (const bad of [
    "",
    "not json",
    "null",
    "[]",
    '{"type":"assistant"}',
    JSON.stringify({ type: "user", message: { content: "  " } }),
  ])
    assert.equal(inputMessage(bad), undefined, bad);
});
