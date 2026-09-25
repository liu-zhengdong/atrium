import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RunnerBridge } from "../server/runner-bridge.ts";
import { RunnerDaemon } from "../server/runner-daemon.ts";

const entry = fileURLToPath(
  new URL("./fixtures/fake-runner-acp.mjs", import.meta.url),
);
// The actual generation is random per daemon and must match the persisted
// identity lease. This helper installs a matching read-only lookup for the test.
function bridgeFor(server: Server, daemon: RunnerDaemon) {
  return new RunnerBridge(
    server,
    (token) =>
      token === "fake-machine"
        ? { runnerId: "r1", credentialId: "fake-credential" }
        : null,
    () => true,
    (agentId) =>
      agentId === "a1"
        ? { runner_id: "r1", generation: daemon.generation }
        : null,
    async (_principal, method) =>
      method === "runner.reconcile" ? { allRecovered: true } : null,
  );
}

async function until(predicate: () => boolean, timeout = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout)
      throw new Error("runner did not reconnect");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("service replacement keeps the independent ACP child and its session", async (t) => {
  let server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const daemon = new RunnerDaemon(
    `ws://127.0.0.1:${address.port}/runner/v1`,
    "fake-machine",
    { ...process.env, ATRIUM_PI_ACP_ENTRY: entry },
  );
  let bridge = bridgeFor(server, daemon);
  const running = daemon.run();
  t.after(async () => {
    daemon.close();
    bridge.close();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await until(() => bridge.connected("r1"));
  const before = await bridge.requestFor<{
    pid: number;
    runtimes: Array<{
      runtimeId: string;
      generation: string;
      sessionId: string;
    }>;
  }>("a1", "acp.request", { method: "_pi/runtime/list", params: {} });
  assert.ok(before.pid > 0);
  assert.equal(before.runtimes.length, 1);
  const mcp = await bridge.mcpUrl("a1");
  assert.match(mcp, /\/mcp\/a1\/[0-9a-f]{64}$/);
  assert.equal(
    (
      await fetch(`${mcp.slice(0, -1)}${mcp.endsWith("0") ? "1" : "0"}`, {
        method: "POST",
      })
    ).status,
    403,
  );
  bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The ACP child keeps producing events while the Web service is gone.
  await new Promise((resolve) => setTimeout(resolve, 700));
  server = createServer();
  bridge = bridgeFor(server, daemon);
  server.listen(address.port, "127.0.0.1");
  await once(server, "listening");
  await until(() => bridge.connected("r1"));
  const after = await bridge.requestFor<{ pid: number }>("a1", "acp.request", {
    method: "_pi/runtime/list",
    params: {},
  });
  assert.equal(after.pid, before.pid);
  const history = await bridge.requestFor<{
    items: Array<{ seq: number }>;
    nextAfter: number;
    gap: boolean;
  }>("a1", "acp.request", {
    method: "_pi/runtime/events",
    params: { ...before.runtimes[0], after: 0, limit: 100 },
  });
  assert.equal(history.gap, false);
  assert.ok(history.nextAfter >= 5);
  assert.deepEqual(
    history.items.map((item) => item.seq),
    Array.from({ length: history.nextAfter }, (_, index) => index + 1),
  );
  // An ACP child can die without the runner or Web service stopping. The
  // runner must reconnect with the NEW child PID before accepting commands.
  process.kill(before.pid, "SIGTERM");
  await until(
    () => bridge.connected("r1") && bridge.acpPid("r1") !== before.pid,
  );
  const restarted = await bridge.requestFor<{ pid: number }>(
    "a1",
    "acp.request",
    { method: "_pi/runtime/list", params: {} },
  );
  assert.notEqual(restarted.pid, before.pid);
});
