import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtimes } from "../server/runtime.ts";
import { Store } from "../server/store.ts";
import { Problem } from "../server/problem.ts";
import { claimRunner } from "../server/runner-ownership.ts";
import { LOCAL_USER } from "../shared/user.ts";
import type { RuntimeInfo } from "../shared/schema.ts";

function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-delivery-"));
  const store = new Store(join(dir, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const agent = store.createAgent("隔离身份", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const pending = store
    .pending(agent.id)
    .find((item) => item.kind === "direct")!;
  store.run(
    "INSERT INTO accounts(provider,name,type,status) VALUES('test','测试','api_key','ready')",
  );
  const account = store.one<{ number: number }>(
    "SELECT number FROM accounts LIMIT 1",
  )!;
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    agent.id,
    "test",
    account.number,
  );
  t.mock.method(
    Runtimes.prototype as unknown as { discover(): Promise<void> },
    "discover",
    async () => {},
  );
  const runtimes = new Runtimes(
    store,
    dir,
    () => {},
    () => "http://127.0.0.1:4338",
    undefined,
    dir,
  );
  t.after(async () => runtimes.close());
  const info: RuntimeInfo = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    pid: 101,
    ownerPid: 202,
    identityId: agent.id,
    sessionFile: join(dir, "session.jsonl"),
    cwd: dir,
    mode: "rpc",
    busy: false,
    model: "test",
  };
  runtimes.connections.set(agent.id, { connection: null as never, info });
  t.mock.method(
    Runtimes.prototype as unknown as { capture(): Promise<void> },
    "capture",
    async () => {},
  );
  return { store, agent, pending, runtimes, info };
}

test("runner claim cannot race a local start before the new Pi is discoverable", (t) => {
  const f = fixture(t);
  assert.equal(f.runtimes.running(f.agent.id, []), false);
  assert.equal(f.runtimes.canBindRunner(f.agent.id), true);
  const internal = f.runtimes as unknown as {
    connecting: Map<string, Promise<void>>;
  };
  internal.connecting.set(f.agent.id, Promise.resolve());
  assert.equal(f.runtimes.canBindRunner(f.agent.id), false);
  internal.connecting.delete(f.agent.id);
  assert.equal(f.runtimes.canBindRunner(f.agent.id), true);
});

test("runner liveness compares runner lease generation, not the Pi session generation", async (t) => {
  const f = fixture(t);
  claimRunner(f.store, f.agent.id, "r1", "runner-generation");
  (f.runtimes as unknown as { bridge: unknown }).bridge = {
    generation: () => "runner-generation",
    close: () => {},
  };
  assert.notEqual(f.info.generation, "runner-generation");
  const visible = [{ ...f.info, bound_agent: f.agent.id }];
  assert.equal(f.runtimes.running(f.agent.id, visible), true);
  assert.equal(f.runtimes.running(f.agent.id, []), false);
  (f.runtimes as unknown as { bridge: unknown }).bridge = {
    generation: () => null,
    close: () => {},
  };
  assert.equal(f.runtimes.running(f.agent.id, []), true); // Offline is unknown, not proof of exit.
});

test("Web restart reuses a runner-held ACP peer without reattaching or replacing MCP while a Pi survives", async (t) => {
  const f = fixture(t);
  claimRunner(f.store, f.agent.id, "r1", "generation-1");
  f.store.run(
    "UPDATE agents SET runtime_id=?,runtime_pid=?,acp_session_id=?,session_file=? WHERE id=?",
    f.info.runtimeId,
    f.info.pid,
    f.info.sessionId,
    f.info.sessionFile,
    f.agent.id,
  );
  f.runtimes.connections.clear(); // Web's in-memory connection did not survive.
  (f.runtimes as unknown as { discovered: unknown[] }).discovered = [
    { ...f.info, bound_agent: f.agent.id },
  ];
  const calls: string[] = [];
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      calls.push(method);
      if (method === "_pi/runtime/status") return f.info;
      throw new Error(`Unexpected replacement call: ${method}`);
    },
  );
  await (
    f.runtimes as unknown as {
      bind(id: string, selector: { runtimeId: string }): Promise<void>;
    }
  ).bind(f.agent.id, { runtimeId: f.info.runtimeId });
  assert.deepEqual(calls, ["_pi/runtime/status"]);
  assert.equal(f.runtimes.connections.get(f.agent.id)?.info.pid, f.info.pid);
});

test("remote delivery response lost: hold original id and explicit unknown, never duplicate on an automatic wake", async (t) => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      if (method === "_pi/runtime/status") return f.info;
      assert.equal(method, "_pi/runtime/deliver");
      calls++;
      throw new Problem(503, "命令可能已执行", "runner_outcome_unknown");
    },
  );
  await f.runtimes.pump(f.agent.id, true);
  assert.equal(calls, 1);
  assert.equal(f.store.pending(f.agent.id)[0]?.id, f.pending.id);
  assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
  await f.runtimes.pump(f.agent.id, true);
  assert.equal(calls, 1);
});

test("runner offline before delivery keeps pending with no false identity failure", async (t) => {
  const f = fixture(t);
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      if (method === "_pi/runtime/status") return f.info;
      assert.equal(method, "_pi/runtime/deliver");
      throw new Problem(503, "命令未发送", "runner_offline");
    },
  );
  await f.runtimes.pump(f.agent.id, true);
  assert.equal(f.store.pending(f.agent.id)[0]?.id, f.pending.id);
  assert.equal(f.store.failure(f.agent.id), null);
});
