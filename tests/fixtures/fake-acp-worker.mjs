// 假 ACP 执行者（#418）：换行分隔 JSON-RPC，像编码工具一样干活，供 ACP 桥的测试与契约测试用。
// - initialize：声明 loadSession；session/new 报两个可选模型（fake-small、fake-large）与思考强度配置（low、high）。
// - session/prompt：先想一想、调一次工具（execute，入参带 command），再回复「收到：<消息开头>（模型 m，强度 e）」。
//   消息含 WRITE:<文件名> 时在工作目录写这个文件；含 SLOW 时拖 1.5 秒；含 PERM 时先请求权限并回报选择；
//   含 REFUSE 时以 refusal 结束；含 FAIL 时回请求出错；含 DIE 时直接退出。
// - session/load：会话 id 以 w- 开头的能续上（先回放一段历史），否则报错。
// ATRIUM_FAKE_ACP_BARE=1 时 session/new 不报模型与配置（测「工具不支持选模型」）。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

let sessions = 0;
let nextId = 1000;
let model = "fake-small";
let effort = "low";
const waiting = new Map();
const bare = process.env.ATRIUM_FAKE_ACP_BARE === "1";
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) =>
  send({ method: "session/update", params: { sessionId, update: value } });
const chunk = (sessionId, kind, text) =>
  update(sessionId, { sessionUpdate: kind, content: { type: "text", text } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prompt(id, { sessionId, prompt }) {
  const text = prompt.map((part) => part.text ?? "").join("");
  if (text.includes("DIE")) process.exit(3);
  if (text.includes("FAIL"))
    return send({
      id,
      error: { code: -32000, message: "上游 502 Bad Gateway" },
    });
  chunk(sessionId, "agent_thought_chunk", "先看看要做什么");
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: `c${nextId++}`,
    title: "看看目录",
    kind: "execute",
    status: "pending",
    rawInput: { command: "ls -la" },
  });
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: `c${nextId - 1}`,
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "README.md" } },
    ],
  });
  if (text.includes("PERM")) {
    const result = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "p1", title: "rm -rf build" },
      options: [
        { optionId: "yes", name: "允许", kind: "allow_once" },
        { optionId: "always", name: "一直允许", kind: "allow_always" },
        { optionId: "no", name: "拒绝", kind: "reject_once" },
      ],
    });
    chunk(
      sessionId,
      "agent_message_chunk",
      `权限：${result.outcome.optionId ?? result.outcome.outcome}\n`,
    );
  }
  const file = /WRITE:([\w.-]+)/.exec(text)?.[1];
  if (file) writeFileSync(join(process.cwd(), file), "done\n");
  if (text.includes("SLOW")) await pause(1500);
  chunk(
    sessionId,
    "agent_message_chunk",
    `收到：${text.slice(0, 40)}（模型 ${model}，强度 ${effort}）`,
  );
  send({
    id,
    result: { stopReason: text.includes("REFUSE") ? "refusal" : "end_turn" },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize")
    send({
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  else if (method === "session/new")
    send({
      id,
      result: {
        sessionId: `w-${++sessions}`,
        ...(bare
          ? {}
          : {
              models: {
                currentModelId: model,
                availableModels: [
                  { modelId: "fake-small", name: "Fake Small" },
                  { modelId: "fake-large", name: "Fake Large" },
                ],
              },
              configOptions: [
                {
                  id: "effort",
                  name: "思考强度",
                  category: "thought_level",
                  type: "select",
                  currentValue: effort,
                  options: [{ value: "low" }, { value: "high" }],
                },
              ],
            }),
      },
    });
  else if (method === "session/load") {
    if (!params.sessionId.startsWith("w-"))
      return send({ id, error: { code: -32000, message: "no such session" } });
    chunk(params.sessionId, "agent_message_chunk", "历史回放");
    send({ id, result: {} });
  } else if (method === "session/set_model") {
    model = params.modelId;
    send({ id, result: {} });
  } else if (method === "session/set_config_option") {
    effort = params.value;
    send({ id, result: { configOptions: [] } });
  } else if (method === "session/prompt") void prompt(id, params);
  else if (id !== undefined)
    send({ id, error: { code: -32601, message: method } });
});
