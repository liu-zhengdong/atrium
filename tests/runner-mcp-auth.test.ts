import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/legacy-app.ts";
import { claimRunner } from "../server/runner-ownership.ts";
import { RunnerMcp } from "../server/runner-mcp.ts";

const token = () => randomBytes(32).toString("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("real Web restart: MCP waits briefly, then sends once; timeout says unsent", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-runner-mcp-restart-"));
  let service = await createApp({ data, runtime: false });
  let proxy: RunnerMcp | undefined;
  try {
    const runnerToken = token();
    const runner = service.runnerAuth.issue("owner", hash(runnerToken));
    const { agent, token: agentToken } = service.store.createAgent(
      "worker",
      data,
    );
    const chat = service.store.createChat("worker", [agent.id], agent.id);
    claimRunner(service.store, agent.id, runner.runnerId, "gen-1");
    await service.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (service.app.server.address() as AddressInfo).port;
    let connected = true;
    proxy = new RunnerMcp(
      `http://127.0.0.1:${port}`,
      () => connected,
      runnerToken,
      500,
    );
    await proxy.start();
    const call = async (body: string) => {
      const response = await fetch(proxy!.url(agent.id), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agentToken}`,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: { chat_id: chat.ref, body },
          },
        }),
      });
      const raw = await response.text();
      const event = /^data: (.+)$/m.exec(raw);
      return JSON.parse(event?.[1] ?? raw) as {
        result: { isError?: boolean; structuredContent?: { code: string } };
      };
    };
    await service.app.close();
    connected = false;
    const offline = await call("超时的消息");
    assert.equal(offline.result.structuredContent?.code, "atrium_offline");
    const pending = call("重启期间的消息");
    service = await createApp({ data, runtime: false });
    await service.app.listen({ host: "127.0.0.1", port });
    connected = true;
    const delivered = await pending;
    assert.equal(
      delivered.result.isError,
      undefined,
      JSON.stringify(delivered),
    );
    const messages = service.store.all<{ body: string }>(
      "SELECT body FROM messages ORDER BY id",
    );
    assert.deepEqual(
      messages.map((message) => message.body),
      ["重启期间的消息"],
    );
  } finally {
    await proxy?.close();
    await service.app.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("MCP proxy requires BOTH identity bearer and matching runner ownership", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-runner-mcp-auth-"));
  const { app, store, runnerAuth } = await createApp({ data, runtime: false });
  try {
    const ownerToken = token();
    const alienToken = token();
    const owner = runnerAuth.issue("owner", hash(ownerToken));
    runnerAuth.issue("other", hash(alienToken));
    const { agent, token: identityToken } = store.createAgent("worker", data);
    claimRunner(store, agent.id, owner.runnerId, "generation-001");
    const payload = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const request = (agentToken: string, runnerToken: string) =>
      app.inject({
        method: "POST",
        url: `/mcp/${agent.id}`,
        headers: {
          authorization: `Bearer ${agentToken}`,
          "x-atrium-runner-credential": `Bearer ${runnerToken}`,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        payload,
      });
    assert.equal((await request(identityToken, alienToken)).statusCode, 403);
    const beforeParsing = await app.inject({
      method: "POST",
      url: `/mcp/${agent.id}`,
      headers: {
        authorization: `Bearer ${identityToken}`,
        "x-atrium-runner-credential": `Bearer ${alienToken}`,
        "content-type": "application/json",
      },
      payload: "{malformed",
    });
    assert.equal(beforeParsing.statusCode, 403); // Not JSON parser's 400.
    assert.equal((await request(alienToken, ownerToken)).statusCode, 401);
    assert.equal((await request(identityToken, ownerToken)).statusCode, 200);
    runnerAuth.revoke(owner.runnerId);
    assert.equal((await request(identityToken, ownerToken)).statusCode, 401);
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});
