import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { RunnerMcp } from "../server/runner-mcp.ts";

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 42,
  method: "tools/call",
  params: { name, arguments: args },
});
const request = async (
  url: string,
  tool: string,
  args?: Record<string, unknown>,
) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fake",
    },
    body: JSON.stringify(call(tool, args)),
  });
  return response.json() as Promise<{
    result: {
      isError?: boolean;
      structuredContent?: { code: string };
      content: { text: string }[];
    };
  }>;
};

test("MCP proxy generates client_id, resends once with the same key after post-write response loss", async (t) => {
  const server = createServer();
  const messages = new Map<string, unknown>();
  let calls = 0;
  server.on("request", async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const clientId = input.params.arguments.client_id;
    assert.match(clientId, /^[0-9a-f-]{36}$/);
    assert.equal(req.headers.authorization, "Bearer fake");
    calls++;
    if (!messages.has(clientId)) messages.set(clientId, { id: "m1", clientId });
    if (calls === 1) {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify(messages.get(clientId)) },
          ],
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const proxy = new RunnerMcp(
    `http://127.0.0.1:${address.port}`,
    () => true,
    "runner-token",
  );
  await proxy.start();
  t.after(() => proxy.close());
  const url = proxy.url("a1");
  assert.equal(
    (
      await fetch(`${url.slice(0, -1)}${url.endsWith("0") ? "1" : "0"}`, {
        method: "POST",
      })
    ).status,
    403,
  ); // A loopback process without the capability cannot use the machine token.
  const reply = await request(url, "atrium_send_message", {
    chat_id: "c1",
    body: "你好",
  });
  assert.equal(reply.result.isError, undefined);
  assert.equal(calls, 2);
  assert.equal(messages.size, 1);
});

test("已记录容器写者时旧宿主 MCP capability 拒绝请求", async (t) => {
  let permitted = true;
  const proxy = new RunnerMcp(
    "http://127.0.0.1:1",
    () => false,
    "fake-runner-token",
    100,
    () => permitted,
  );
  await proxy.start();
  t.after(() => proxy.close());
  const oldUrl = proxy.url("a1");
  permitted = false;
  assert.throws(() => proxy.url("a1"), /容器身份不能使用宿主 MCP 通路/);
  assert.equal((await fetch(oldUrl, { method: "POST" })).status, 403);
});

test("a client that abandoned an offline call cannot trigger a late send", async (t) => {
  let connected = false;
  let forwarded = 0;
  const web = createServer((_req, res) => {
    forwarded++;
    res.writeHead(200).end("{}");
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => web.close());
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("address");
  const proxy = new RunnerMcp(
    `http://127.0.0.1:${address.port}`,
    () => connected,
    "runner-token",
    2_000,
  );
  await proxy.start();
  t.after(() => proxy.close());
  const abort = new AbortController();
  const pending = fetch(proxy.url("a1"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      call("send_message", { chat_id: "c1", body: "不要迟到" }),
    ),
    signal: abort.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  abort.abort();
  await assert.rejects(pending, /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 450));
  connected = true;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(forwarded, 0);
});

test("offline returns Chinese non-delivery; unsafe write with unknown outcome requests inspection, never retries", async (t) => {
  const offline = new RunnerMcp(
    "http://127.0.0.1:1",
    () => false,
    "runner-token",
    400,
  );
  await offline.start();
  t.after(() => offline.close());
  const offlineResult = await request(offline.url("a1"), "send_message");
  assert.equal(offlineResult.result.structuredContent?.code, "atrium_offline");
  assert.match(offlineResult.result.content[0].text, /消息未发送/);
  assert.match(offlineResult.result.content[0].text, /atrium_offline/);
  assert.match(offlineResult.result.content[0].text, /client_id=[\da-f-]{36}/);
  assert.doesNotMatch(offlineResult.result.content[0].text, /ECONN/);

  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.socket?.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const proxy = new RunnerMcp(
    `http://127.0.0.1:${address.port}`,
    () => true,
    "runner-token",
  );
  await proxy.start();
  t.after(() => proxy.close());
  const unknown = await request(proxy.url("a1"), "create_group");
  assert.equal(
    unknown.result.structuredContent?.code,
    "atrium_outcome_unknown",
  );
  assert.match(unknown.result.content[0].text, /先用 list_chats 查一下/);
  assert.equal(calls, 1);
});
