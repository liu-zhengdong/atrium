import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  mcpConnectionProblem,
  mcpToolNames,
  prepareMcpCall,
} from "../server/mcp-retry.ts";

test("every Atrium MCP tool has an explicit retry policy", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../server/mcp.ts", import.meta.url)),
    "utf8",
  );
  const actual = [...source.matchAll(/\btool\(\s*"([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(actual.length, 18);
  assert.deepEqual([...new Set(mcpToolNames)].sort(), actual.sort());
});

test("proxy inserts one client_id and reuses it after a lost response", () => {
  let generated = 0;
  const call = prepareMcpCall(
    "send_message",
    { chat_id: "c1", body: "收到" },
    () => `request-${++generated}`,
  );
  assert.deepEqual(call.args, {
    chat_id: "c1",
    body: "收到",
    client_id: "request-1",
  });
  assert.equal(call.retryAfterSend, true);
  assert.equal(generated, 1);
  assert.deepEqual(mcpConnectionProblem(call, false), {
    code: "atrium_offline",
    message: "Atrium 离线，消息未发送。稍后重发即可。",
    client_id: "request-1",
  });
  assert.deepEqual(mcpConnectionProblem(call, true), {
    code: "atrium_outcome_unknown",
    message:
      "Atrium 连接中断，这条消息可能已经发出。稍后重发时带上 client_id=request-1，不会重复。",
    client_id: "request-1",
  });
  const explicit = prepareMcpCall(
    "send_message",
    { client_id: "provided", chat_id: "c1" },
    () => {
      throw new Error("must not replace provided id");
    },
  );
  assert.equal(explicit.clientId, "provided");
});

test("pure reads retry, receipt reads and writes require a status check", () => {
  for (const name of [
    "list_agents",
    "user_info",
    "list_fork_sources",
    "list_chats",
    "search_messages",
    "get_config",
  ])
    assert.equal(prepareMcpCall(name, {}).retryAfterSend, true, name);
  for (const name of [
    "fork_agent",
    "open_direct",
    "create_group",
    "invite_agent",
    "read_chat",
    "view_message_box",
    "claim_status",
    "set_description",
    "complete_inbox",
    "update_config",
    "set_reports_to",
    "new_unknown_write",
  ]) {
    const call = prepareMcpCall(name, {});
    assert.equal(call.retryAfterSend, false, name);
    assert.equal(
      mcpConnectionProblem(call, true).code,
      "atrium_outcome_unknown",
    );
    assert.match(mcpConnectionProblem(call, true).message, /先|稍后/);
  }
  assert.match(
    mcpConnectionProblem(prepareMcpCall("create_group", {}), true).message,
    /list_chats/,
  );
});
