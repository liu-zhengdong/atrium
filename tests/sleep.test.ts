import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import type { RuntimeInfo } from "../shared/schema.ts";

type PrivateRuntime = {
  rpc(method: string, params: unknown): Promise<unknown>;
  bind(id: string, selector: { sessionId: string }): Promise<void>;
  owned(id: string): boolean;
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "atrium-sleep-"));
  const data = join(root, "data");
  mkdirSync(join(data, "credentials"), { recursive: true });
  const store = new Store(join(data, "atrium.db"));
  const { agent, token } = store.createAgent("Atlas", root);
  const account = store.run(
    "INSERT INTO accounts(provider,name,type) VALUES('fixture','test','api_key')",
  ).lastInsertRowid;
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    agent.id,
    "fixture",
    account,
  );
  writeFileSync(
    join(data, "credentials", `${agent.id}.json`),
    JSON.stringify({ token }),
  );
  const oldFile = join(root, "original.jsonl");
  writeFileSync(oldFile, "original conversation\n");
  const oldSession = randomUUID();
  store.run(
    "UPDATE agents SET session_file=?, acp_session_id=? WHERE id=?",
    oldFile,
    oldSession,
    agent.id,
  );
  const sessions = new Map<string, RuntimeInfo>();
  const calls: string[] = [];
  let failLoad = false;
  let stopWait: ReturnType<typeof deferred> | null = null;
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "rpc",
    async (method: string, params: unknown) => {
      calls.push(method);
      if (method === "_pi/runtime/list") return { runtimes: [] };
      if (method === "session/load") {
        if (failLoad) throw new Error("original session unreadable");
        return {};
      }
      if (method === "session/new") return { sessionId: randomUUID() };
      if (method === "_pi/runtime/status") return sessions.get(agent.id);
      if (method === "_pi/runtime/events") {
        const info = sessions.get(agent.id)!;
        return { ...info, items: [], nextAfter: 0, hasMore: false, gap: false };
      }
      if (method === "_pi/runtime/deliver") return { accepted: true };
      if (method === "_pi/identity/stop") {
        if (stopWait) await stopWait.promise;
        sessions.delete(agent.id);
        store.run(
          "UPDATE agents SET runtime_pid=NULL,runtime_id=NULL WHERE id=?",
          agent.id,
        );
        return {};
      }
      return {};
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "bind",
    async (id: string, selector: { sessionId: string }) => {
      const info: RuntimeInfo = {
        runtimeId: randomUUID(),
        generation: randomUUID(),
        sessionId: selector.sessionId,
        pid: process.pid,
        ownerPid: process.pid,
        identityId: null,
        sessionFile: oldFile,
        cwd: root,
        mode: "rpc",
        busy: false,
        model: "fixture",
      };
      sessions.set(id, info);
      store.run(
        "UPDATE agents SET runtime_id=?, runtime_pid=?, acp_session_id=? WHERE id=?",
        info.runtimeId,
        999999999,
        info.sessionId,
        id,
      );
      runtimes.connections.set(id, { connection: null as never, info });
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "owned",
    () => true,
  );
  const runtimes = new Runtimes(
    store,
    data,
    () => {},
    () => "http://127.0.0.1:4399",
    undefined,
    join(root, "desktops"),
  );
  t.after(async () => {
    await runtimes.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    runtimes,
    id: agent.id,
    oldFile,
    oldSession,
    calls,
    setFailLoad: (on: boolean) => {
      failLoad = on;
    },
    setStopWait: (wait: ReturnType<typeof deferred> | null) => {
      stopWait = wait;
    },
  };
}

test("自动休眠、原会话唤醒超过五次，不累积启动限流", async (t) => {
  const { store, runtimes, id, oldSession, calls } = await fixture(t);
  for (let attempt = 0; attempt < 6; attempt++) {
    await runtimes.start(id, true);
    assert.equal(store.agent(id).sleeping_at, null);
    assert.equal(
      store.one<{ acp_session_id: string }>(
        "SELECT acp_session_id FROM agents WHERE id=?",
        id,
      )?.acp_session_id,
      oldSession,
    );
    assert.equal(await runtimes.sleep(id), true);
    assert(store.agent(id).sleeping_at);
  }
  assert.equal(calls.filter((item) => item === "session/new").length, 0);
  assert.equal(store.failure(id), null);
});

test("自动唤醒失败保留旧会话与待投递，修复后显式重试", async (t) => {
  const fixtureState = await fixture(t);
  const { store, runtimes, id, oldFile, oldSession, calls } = fixtureState;
  await runtimes.start(id);
  await runtimes.sleep(id);
  store.queue(id, "direct", "hello");
  fixtureState.setFailLoad(true);
  await assert.rejects(runtimes.start(id, true), /original session unreadable/);
  assert.equal(store.agent(id).session_file, oldFile);
  assert.equal(
    store.one<{ acp_session_id: string }>(
      "SELECT acp_session_id FROM agents WHERE id=?",
      id,
    )?.acp_session_id,
    oldSession,
  );
  assert(store.agent(id).sleeping_at);
  assert.equal(store.pending(id).length, 1);
  assert.equal(calls.filter((item) => item === "session/new").length, 0);
  fixtureState.setFailLoad(false);
  await runtimes.retry(id);
  assert.equal(store.agent(id).sleeping_at, null);
  assert.equal(
    calls.filter((item) => item === "_pi/runtime/deliver").length,
    1,
  );
});

test("停止期间进来的直接消息只投一次", async (t) => {
  const fixtureState = await fixture(t);
  const { store, runtimes, id, calls } = fixtureState;
  await runtimes.start(id);
  const stop = deferred();
  fixtureState.setStopWait(stop);
  const sleeping = runtimes.sleep(id);
  // sleep() marks intent before waiting on the stop RPC.
  while (!store.agent(id).sleeping_at)
    await new Promise((resolve) => setImmediate(resolve));
  store.queue(id, "direct", "arrived while stopping");
  await runtimes.pump(id, true);
  stop.release();
  await sleeping;
  // A queued wake runs asynchronously after the lifecycle lock is released.
  for (let n = 0; n < 50 && store.agent(id).sleeping_at; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.agent(id).sleeping_at, null);
  assert.equal(
    calls.filter((item) => item === "_pi/runtime/deliver").length,
    1,
  );
});
