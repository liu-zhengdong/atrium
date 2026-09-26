import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Problem } from "../server/problem.ts";
import { RunnerBridge } from "../server/runner-bridge.ts";
import { RunnerDaemon } from "../server/runner-daemon.ts";
import { Runtimes } from "../server/runtime.ts";
import { Store } from "../server/store.ts";
import { RunnerAuth } from "../server/runner-auth.ts";
import { claimRunner } from "../server/runner-ownership.ts";
import { LOCAL_USER } from "../shared/user.ts";
import { runtimeSchema } from "../shared/schema.ts";

const agent1 = "00000000-0000-4000-8000-000000000001";
const agent2 = "00000000-0000-4000-8000-000000000002";
const entry = fileURLToPath(
  new URL("./fixtures/fake-drain-acp.mjs", import.meta.url),
);

function bridgeFor(server: Server, daemon: RunnerDaemon) {
  return new RunnerBridge(
    server,
    (token) =>
      token === "fake-machine"
        ? { runnerId: "r1", credentialId: "fake" }
        : null,
    () => true,
    (agentId) =>
      [agent1, agent2].includes(agentId)
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

test("runner drains one identity, survives Web restart and leaves other identity working", async (t) => {
  let server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-drain-"));
  const daemon = new RunnerDaemon(
    `ws://127.0.0.1:${address.port}/runner/v1`,
    "fake-machine",
    { ...process.env, ATRIUM_PI_ACP_ENTRY: entry },
    join(dir, "runner.json"),
  );
  let bridge = bridgeFor(server, daemon);
  const running = daemon.run();
  t.after(async () => {
    daemon.close();
    bridge.close();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => bridge.connected("r1"));
  const deliver = (agentId: string) =>
    bridge.requestFor(agentId, "acp.request", {
      method: "_pi/runtime/deliver",
      params: { runtimeId: agentId },
    });
  const control = (agentId: string, action: string) =>
    bridge.requestControl<{
      drained?: boolean;
      busy?: string[];
      draining?: boolean;
    }>("r1", "runner.drain", { agentId, action });

  assert.deepEqual(await control(agent1, "inspect"), { draining: false });
  await deliver(agent1);
  const pending = await control(agent1, "start");
  assert.deepEqual(await control(agent1, "inspect"), { draining: true });
  assert.equal(
    pending.drained,
    false,
    "accepted active turn must not appear idle",
  );
  assert.match(pending.busy!.join(" "), /正在运行/);
  await assert.rejects(
    deliver(agent1),
    (error: unknown) =>
      error instanceof Problem &&
      error.statusCode === 409 &&
      error.code === "runner_draining",
  );
  for (const method of ["_pi/identity/start", "session/new", "session/load"]) {
    await assert.rejects(
      bridge.requestFor(agent1, "acp.request", {
        method,
        params: { identityId: agent1 },
      }),
      (error: unknown) =>
        error instanceof Problem && error.code === "runner_draining",
    );
  }
  await deliver(agent2);

  bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createServer();
  bridge = bridgeFor(server, daemon);
  server.listen(address.port, "127.0.0.1");
  await once(server, "listening");
  await until(() => bridge.connected("r1"));
  await assert.rejects(
    deliver(agent1),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_draining",
  );
  let settled = await control(agent1, "status");
  for (let i = 0; !settled.drained && i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    settled = await control(agent1, "status");
  }
  assert.equal(settled.drained, true);
  await assert.rejects(
    deliver(agent1),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_draining",
  );
  assert.deepEqual(await control(agent1, "resume"), { draining: false });
  assert.deepEqual(await control(agent1, "inspect"), { draining: false });
  await deliver(agent1);

  // A previously started process absent from Pi discovery is not proof of idle.
  const missing = "00000000-0000-4000-8000-000000000005";
  await bridge.requestControl("r1", "acp.request", {
    agentId: missing,
    params: { method: "_pi/identity/start", params: { identityId: missing } },
  });
  const uncertain = await control(missing, "start");
  assert.equal(uncertain.drained, false);
  assert.match(uncertain.busy!.join(" "), /未出现在运行时列表/);
});

test("a due retry across a real runner drain waits, then sends one direct delivery", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-drain-retry-"));
  const store = new Store(join(dir, "data.sqlite"));
  new RunnerAuth(store);
  const agent = store.createAgent("重试身份", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const pending = store.pending(agent.id).find((row) => row.kind === "direct")!;
  store.run(
    "INSERT INTO accounts(provider,name,type,status) VALUES('test','测试','api_key','ready')",
  );
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?, 'test', 1)",
    agent.id,
  );
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
      ATRIUM_PI_ACP_ENTRY: entry,
      ATRIUM_FAKE_RETRY_AGENT: agent.id,
    },
    join(dir, "runner.json"),
  );
  const bridge = new RunnerBridge(
    server,
    (token) =>
      token === "fake-machine"
        ? { runnerId: "r1", credentialId: "fake" }
        : null,
    () => true,
    (id) =>
      id === agent.id
        ? { runner_id: "r1", generation: daemon.generation }
        : null,
    async (_principal, method) =>
      method === "runner.reconcile" ? { allRecovered: true } : null,
  );
  const running = daemon.run();
  const runtimes = new Runtimes(
    store,
    dir,
    () => {},
    () => "http://127.0.0.1:4338",
    undefined,
    dir,
  );
  runtimes.setBridge(bridge);
  t.after(async () => {
    await runtimes.close();
    daemon.close();
    bridge.close();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(
    runtimes as unknown as { discover(): Promise<void> },
    "discover",
    async () => {},
  );
  t.mock.method(
    runtimes as unknown as { capture(): Promise<void> },
    "capture",
    async () => {},
  );
  await until(() => bridge.connected("r1"));
  claimRunner(store, agent.id, "r1", daemon.generation);
  const status = () =>
    bridge.requestFor(agent.id, "acp.request", {
      method: "_pi/runtime/status",
      params: { runtimeId: agent.id },
    });
  const deliveryCount = async () =>
    (
      await bridge.requestFor<{ deliveries: number }>(agent.id, "acp.request", {
        method: "_pi/runtime/delivery_count",
        params: {},
      })
    ).deliveries;
  const info = await status();
  runtimes.connections.set(agent.id, {
    connection: null,
    info: runtimeSchema.parse(info),
  });
  store.setFailure(agent.id, "HTTP 503", Date.now(), "provider");
  store.run(
    "UPDATE failure_incidents SET started_at=? WHERE agent_id=?",
    Date.now() - 120_001,
    agent.id,
  );
  assert.equal((await runtimes.drainRunner(agent.id, "start")).drained, true);
  const tick = () => (runtimes as unknown as { tick(): Promise<void> }).tick();
  await tick();
  await tick();
  assert.equal(await deliveryCount(), 0, "drain must prevent a new Pi round");
  assert.equal(
    store.incident(agent.id)?.attempts_used,
    0,
    "drain must preserve retry budget",
  );
  assert.equal(store.retryStatus(agent.id)?.retry?.state, "waiting");
  assert.equal(store.pending(agent.id)[0]?.id, pending.id);
  await runtimes.drainRunner(agent.id, "resume");
  await tick();
  assert.equal(await deliveryCount(), 1);
  assert.equal(store.incident(agent.id)?.attempts_used, 1);
  assert.equal(
    store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      pending.id,
    )?.state,
    "accepted",
  );
  store.finishTurn(agent.id, true);
  await tick();
  assert.equal(
    await deliveryCount(),
    1,
    "recovered message must not be delivered twice",
  );
  assert.equal(store.failure(agent.id), null);
});
