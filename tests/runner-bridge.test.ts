import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { RunnerBridge } from "../server/runner-bridge.ts";
import { RunnerLink } from "../server/runner-link.ts";

function connect(url: string, token: string) {
  return new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Atrium-Generation": "generation-001",
      "X-Atrium-Acp-Pid": String(process.pid),
      "X-Atrium-Mcp-Port": "4339",
    },
  });
}
function denied(url: string, token: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = connect(url, token);
    socket.on("error", reject);
    socket.on("unexpected-response", (request, response) => {
      request.destroy();
      resolve(response.statusCode ?? 0);
    });
  });
}

test("machine token guards WS, duplicate writer rejected, revocation disconnects", async (t) => {
  const server = createServer();
  const valid = new Set(["one", "two"]);
  let ownerGeneration = "generation-001";
  const bridge = new RunnerBridge(
    server,
    (token) =>
      valid.has(token)
        ? { runnerId: token === "one" ? "r1" : "r2", credentialId: token }
        : null,
    ({ credentialId }) => valid.has(credentialId),
    (agentId) =>
      agentId === "a1"
        ? { runner_id: "r1", generation: ownerGeneration }
        : null,
    async (_principal, method, params) => ({ method, params }),
  );
  t.after(async () => {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/runner/v1`;
  assert.equal(await denied(url, "bad"), 401);
  const socket = connect(url, "one");
  await once(socket, "open");
  const runner = new RunnerLink(socket, async (method, params) => ({
    method,
    params,
  }));
  assert.equal(await denied(url, "one"), 409);
  assert.equal(bridge.connected("r1"), true);
  assert.deepEqual(
    await bridge.requestFor("a1", "acp.request", { method: "ping" }),
    {
      method: "acp.request",
      params: { agentId: "a1", params: { method: "ping" } },
    },
  );
  await assert.rejects(bridge.requestFor("a2", "acp.request", {}), /不可用/);
  ownerGeneration = "old-generation";
  bridge.markRecovery([], { a1: "alive" });
  await assert.rejects(
    bridge.requestFor("a1", "acp.request", {}),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "runner_locked" &&
      "statusCode" in error &&
      error.statusCode === 409 &&
      error.message.includes("atrium runner reclaim a1"),
  );
  bridge.markRecovery(["a1"], {});
  ownerGeneration = "generation-001";
  assert.equal(
    (await bridge.requestFor<{ method: string }>("a1", "acp.request", {}))
      .method,
    "acp.request",
  );
  const second = connect(url, "two");
  await once(second, "open");
  const outsider = new RunnerLink(second, async () => null);
  await assert.rejects(
    outsider.request("mcp.request", { agentId: "a1" }),
    /运行器处理失败/,
  );
  valid.delete("one");
  bridge.revokeCredential("one");
  await once(socket, "close");
  assert.equal(bridge.connected("r1"), false);
  await assert.rejects(bridge.requestFor("a1", "acp.request", {}), /不可用/);
  runner.close();
  outsider.close();
});

test("revoked WS credential is fenced before even malformed packet content is parsed", async (t) => {
  const server = createServer();
  let valid = true;
  const bridge = new RunnerBridge(
    server,
    () => ({ runnerId: "r1", credentialId: "rc1" }),
    () => valid,
    () => null,
    async () => null,
  );
  t.after(async () => {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = connect(`ws://127.0.0.1:${address.port}/runner/v1`, "token");
  await once(socket, "open");
  valid = false;
  socket.send("{invalid-json");
  const [code] = await once(socket, "close");
  assert.equal(code, 4003); // Fenced before JSON parser could close with 1002.
});
