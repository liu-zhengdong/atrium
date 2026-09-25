import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RunnerLink } from "../server/runner-link.ts";

test("bidirectional local runner RPC rejects pending calls on disconnect without replay", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const accepted = once(server, "connection") as Promise<[WebSocket]>;
  await once(client, "open");
  const [socket] = await accepted;
  const runtime = new RunnerLink(client, async (method, params) => {
    if (method === "hold") return new Promise(() => {});
    if (method === "throw") throw new Error("token secret should not be sent");
    return { method, params };
  });
  const web = new RunnerLink(socket, async (method, params) => ({
    method,
    params,
  }));
  assert.deepEqual(await web.request("ping", { id: "a1" }), {
    method: "ping",
    params: { id: "a1" },
  });
  assert.deepEqual(await runtime.request("state", { id: "a2" }), {
    method: "state",
    params: { id: "a2" },
  });
  await assert.rejects(web.request("throw", {}), (error: Error) => {
    assert.equal(error.message, "运行器处理失败");
    return true;
  });
  const pending = web.request("hold", {});
  client.close();
  await assert.rejects(pending, /已发请求结果待核对/);
  await assert.rejects(web.request("ping", {}), /连接已断开/);
  runtime.close();
  web.close();
});
