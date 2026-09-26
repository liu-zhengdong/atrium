import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RunnerBridge } from "../server/runner-bridge.ts";
import { RunnerDaemon } from "../server/runner-daemon.ts";
import { Problem } from "../server/problem.ts";
import { IDENTITY_LAUNCH_SECRET_CAPABILITY } from "../shared/runtime-capability.ts";

const require = createRequire(import.meta.url);
test("installed pi-atrium and Atrium agree on the launch-secret contract", () => {
  const adapter = require("@liuser/pi-atrium/dist/identity.js") as {
    IDENTITY_LAUNCH_SECRET_CAPABILITY?: string;
  };
  assert.equal(
    adapter.IDENTITY_LAUNCH_SECRET_CAPABILITY,
    IDENTITY_LAUNCH_SECRET_CAPABILITY,
  );
});

const entry = fileURLToPath(
  new URL("./fixtures/fake-runner-acp.mjs", import.meta.url),
);
// The actual generation is random per daemon and must match the persisted
// identity lease. This helper installs a matching read-only lookup for the test.
function bridgeFor(server: Server, daemon: RunnerDaemon, identityId = "a1") {
  return new RunnerBridge(
    server,
    (token) =>
      token === "fake-machine"
        ? { runnerId: "r1", credentialId: "fake-credential" }
        : null,
    () => true,
    (agentId) =>
      agentId === identityId
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

test("runner answers the first frame sent during WebSocket upgrade", async (t) => {
  const server = createServer();
  const sockets = new WebSocketServer({ server, path: "/runner/v1" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const daemon = new RunnerDaemon(
    `ws://127.0.0.1:${address.port}/runner/v1`,
    "fake-machine",
    { ...process.env, ATRIUM_PI_ACP_ENTRY: entry },
  );
  const running = daemon.run();
  t.after(async () => {
    daemon.close();
    await running;
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const firstReply = new Promise<{
    result?: { generation?: string };
    error?: string;
  }>((resolve) => {
    sockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const packet = JSON.parse(raw.toString()) as {
          kind: string;
          id: number;
          method?: string;
          result?: { generation?: string };
          error?: string;
        };
        if (packet.kind === "reply" && packet.id === 777) resolve(packet);
        if (packet.kind === "request" && packet.method === "runner.reconcile")
          socket.send(
            JSON.stringify({
              kind: "reply",
              id: packet.id,
              result: { allRecovered: true },
            }),
          );
      });
      socket.send(
        JSON.stringify({
          kind: "request",
          id: 777,
          method: "runner.heartbeat",
          params: {},
        }),
      );
    });
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await Promise.race([
      firstReply,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("first frame lost")), 2000);
      }),
    ]);
    assert.equal(reply.error, undefined);
    assert.equal(typeof reply.result?.generation, "string");
  } finally {
    clearTimeout(timer);
  }
});

test("new ACP capability accepts a matching identity and forwards its selected account number", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-capable-"));
  const daemon = new RunnerDaemon(
    "ws://127.0.0.1:1/runner/v1",
    "fake-machine",
    {
      ...process.env,
      ATRIUM_DATA: join(dir, "data"),
      PI_ACP_DIR: join(dir, "acp"),
      ATRIUM_PI_ACP_ENTRY: entry,
      TEST_LAUNCH_SECRET_CAPABLE: "1",
    },
  );
  t.after(() => {
    daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const result = (await daemon["handle"]("acp.request", {
    agentId: id,
    params: {
      method: "_pi/identity/start",
      params: { identityId: id, cwd: dir, launchSecretAccount: "k1" },
    },
  })) as { received: { identityId: string; launchSecretAccount: string } };
  assert.equal(result.received.identityId, id);
  assert.equal(result.received.launchSecretAccount, "k1");
});

test("old ACP capability rejects secret start before forwarding, with an actionable error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-legacy-acp-"));
  const identityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const daemon = new RunnerDaemon(
    `ws://127.0.0.1:${address.port}/runner/v1`,
    "fake-machine",
    {
      ...process.env,
      ATRIUM_DATA: join(dir, "data"),
      PI_ACP_DIR: join(dir, "acp"),
      ATRIUM_PI_ACP_ENTRY: entry,
      // Deliberately omit TEST_LAUNCH_SECRET_CAPABLE: the old ACP lacks it.
      TEST_LAUNCH_SECRET_CAPABLE: undefined,
    },
  );
  const bridge = bridgeFor(server, daemon, identityId);
  const running = daemon.run();
  t.after(async () => {
    daemon.close();
    bridge.close();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => bridge.connected("r1"));
  await assert.rejects(
    bridge.requestFor(identityId, "acp.request", {
      method: "_pi/identity/start",
      params: { identityId, launchSecretAccount: "k1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Problem);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "launch_secret_unsupported");
      assert.match(error.message, /需要新版 pi-atrium/);
      assert.match(error.message, /npm ci/);
      return true;
    },
  );
  const list = await bridge.requestFor<{ startCalls: number }>(
    identityId,
    "acp.request",
    { method: "_pi/runtime/list", params: {} },
  );
  assert.equal(list.startCalls, 0, "old ACP must never see _pi/identity/start");
});

test("old bridge refusal stays actionable through runner without exposing arbitrary ACP errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-old-bridge-"));
  const identityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const daemon = new RunnerDaemon(
    `ws://127.0.0.1:${address.port}/runner/v1`,
    "fake-machine",
    {
      ...process.env,
      ATRIUM_DATA: join(dir, "data"),
      PI_ACP_DIR: join(dir, "acp"),
      ATRIUM_PI_ACP_ENTRY: entry,
      TEST_LAUNCH_SECRET_CAPABLE: "1",
      TEST_BRIDGE_READINESS_REJECT: "1",
    },
  );
  const bridge = bridgeFor(server, daemon, identityId);
  const running = daemon.run();
  t.after(async () => {
    daemon.close();
    bridge.close();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => bridge.connected("r1"));
  await assert.rejects(
    bridge.requestFor(identityId, "acp.request", {
      method: "_pi/identity/start",
      params: { identityId, launchSecretAccount: "k1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Problem);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "launch_secret_unsupported");
      assert.match(error.message, /claude-bridge.*pi update/);
      return true;
    },
  );
});

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
  // The outer owner is a1. A forged inner identity must be rejected before
  // the shared ACP can read any other identity's launch account.
  await assert.rejects(
    bridge.requestFor("a1", "acp.request", {
      method: "_pi/identity/start",
      params: {
        identityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        launchSecretAccount: "k1",
      },
    }),
    /运行器处理失败/,
  );
  await assert.rejects(
    bridge.requestFor("a1", "acp.request", {
      method: "_pi/identity/start",
      params: {
        identityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        launchSecretAccount: "../outside",
      },
    }),
  );
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
