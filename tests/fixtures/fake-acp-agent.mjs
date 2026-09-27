// 假 ACP Agent：换行分隔 JSON-RPC。回复「收到：<消息>」；消息含 SLOW 时一轮拖 400 毫秒，
// 含 HANG 时等 session/cancel，含 PERM 时先请求权限再报告选择；含 DIE 时直接退出。
import { createInterface } from "node:readline";

let sessions = 0;
let cancel = null;
const waiting = new Map();
let nextId = 1000;
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const say = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

async function prompt(id, { sessionId, prompt }) {
  const text = prompt.map((part) => part.text ?? "").join("");
  if (text.includes("DIE")) process.exit(3);
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "atrium task show",
        status: "pending",
      },
    },
  });
  if (text.includes("PERM")) {
    const result = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "c1", title: "bash" },
      options: [
        { optionId: "yes", name: "允许", kind: "allow_once" },
        { optionId: "no", name: "拒绝", kind: "reject_once" },
      ],
    });
    say(
      sessionId,
      `权限：${result.outcome.optionId ?? result.outcome.outcome}\n`,
    );
  }
  if (text.includes("HANG")) {
    await new Promise((resolve) => (cancel = resolve));
    return send({ id, result: { stopReason: "cancelled" } });
  }
  if (text.includes("SLOW"))
    await new Promise((resolve) => setTimeout(resolve, 400));
  say(sessionId, `收到：${text}`);
  send({ id, result: { stopReason: "end_turn" } });
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
    send({ id, result: { sessionId: `s-${++sessions}` } });
  else if (method === "session/load") {
    if (!params.sessionId.startsWith("s-"))
      return send({ id, error: { code: -32000, message: "no such session" } });
    say(params.sessionId, "历史回放");
    send({ id, result: null });
  } else if (method === "session/prompt") void prompt(id, params);
  else if (method === "session/cancel") cancel?.();
  else if (id !== undefined)
    send({ id, error: { code: -32601, message: method } });
});
