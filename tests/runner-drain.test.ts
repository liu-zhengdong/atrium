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

  await deliver(agent1);
  const pending = await control(agent1, "start");
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
