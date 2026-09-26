import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtimes } from "../server/runtime.ts";
import { notifyTerminal } from "../server/incident-notice.ts";
import { Store } from "../server/store.ts";
import { Problem } from "../server/problem.ts";
import { claimRunner, ownerOf } from "../server/runner-ownership.ts";
import { RunnerAuth } from "../server/runner-auth.ts";
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
  return { store, agent, chat, pending, runtimes, info };
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

test("busy Pi keeps an unknown duplicate and its retry entry until run_end", async (t) => {
  const f = fixture(t);
  let calls = 0;
  let busy = false;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string, params: { id?: string }) => {
      if (method === "_pi/runtime/status") return { ...f.info, busy };
      assert.equal(method, "_pi/runtime/deliver");
      assert.equal(params.id, f.pending.id);
      if (++calls === 1)
        throw new Problem(503, "应答丢失", "runner_outcome_unknown");
      return { accepted: true, duplicate: true };
    },
  );
  await f.runtimes.pump(f.agent.id, true);
  f.store.finishTurn(f.agent.id, true); // Earlier turn completed, not proof of this delivery.
  assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
  await f.runtimes.pump(f.agent.id, true); // Even a new direct wake is not a retry.
  assert.equal(calls, 1);
  busy = true;
  await f.runtimes.retry(f.agent.id);
  assert.equal(calls, 2);
  assert.equal(f.store.uncertainDelivery(f.agent.id)?.state, "accepted");
  assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
  await f.runtimes.pump(f.agent.id, true);
  assert.equal(calls, 2);
  // A late successful run_end settles the accepted row; no rekey follows.
  f.store.finishTurn(f.agent.id, true);
  assert.equal(f.store.uncertainDelivery(f.agent.id), null);
  assert.equal(f.store.failure(f.agent.id), null);
  assert.equal(f.store.pending(f.agent.id).length, 0);
});

test("busy unknown retry followed by failed turn can retry again without restarting Web", async (t) => {
  const f = fixture(t);
  let busy = false;
  const calls: { id: string; text: string }[] = [];
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string, params: { id?: string; text?: string }) => {
      if (method === "_pi/runtime/status") return { ...f.info, busy };
      assert.equal(method, "_pi/runtime/deliver");
      calls.push({ id: params.id!, text: params.text! });
      if (calls.length === 1)
        throw new Problem(503, "应答丢失", "runner_outcome_unknown");
      return { accepted: true, duplicate: params.id === f.pending.id };
    },
  );
  await f.runtimes.pump(f.agent.id, true);
  busy = true;
  await f.runtimes.retry(f.agent.id);
  assert.deepEqual(
    calls.map((call) => call.id),
    [f.pending.id, f.pending.id],
  );
  assert.equal(f.store.uncertainDelivery(f.agent.id)?.state, "accepted");
  assert.equal(f.runtimes.connections.get(f.agent.id)?.info.busy, true);

  busy = false; // The Pi is idle, but the uncertain gate prevents refreshing cached status.
  f.store.setFailure(f.agent.id, "500: isolated upstream 500");
  f.store.finishTurn(f.agent.id, false);
  assert.equal(f.store.uncertainDelivery(f.agent.id)?.state, "accepted");
  assert.equal(f.runtimes.connections.get(f.agent.id)?.info.busy, true);
  await f.runtimes.retry(f.agent.id);
  assert.equal(calls.length, 4); // Original, duplicate, duplicate after failure, replay.
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.id),
    [f.pending.id, f.pending.id, f.pending.id],
  );
  assert.notEqual(calls[3]!.id, f.pending.id);
  assert.match(calls[3]!.text, /上一轮运行出错/);
  assert.equal(f.store.uncertainDelivery(f.agent.id), null);
  f.store.finishTurn(f.agent.id, true);
  f.store.send(LOCAL_USER, { chat_id: f.chat.id, body: "BF-2", mentions: [] });
  await f.runtimes.pump(f.agent.id, true);
  f.store.finishTurn(f.agent.id, true);
  assert.equal(calls.length, 5);
  assert.match(calls[4]!.text, /BF-2/);
  assert.equal(f.store.pending(f.agent.id).length, 0);
});

for (const restart of ["Web", "identity"] as const) {
  test(`retry after ${restart} restart settles a duplicate from the old finished turn`, async (t) => {
    const f = fixture(t);
    const calls: string[] = [];
    let activeInfo = f.info;
    t.mock.method(
      Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
      "rpc",
      async (method: string, params: { id?: string }) => {
        if (method === "_pi/runtime/status") return activeInfo;
        assert.equal(method, "_pi/runtime/deliver");
        calls.push(params.id!);
        if (calls.length === 1)
          throw new Problem(503, "应答丢失", "runner_outcome_unknown");
        return params.id === f.pending.id
          ? { accepted: true, duplicate: true }
          : { accepted: true };
      },
    );
    await f.runtimes.pump(f.agent.id, true);
    f.store.finishTurn(f.agent.id, true);
    assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
    if (restart === "Web") {
      // A new service has no lastTurn cache but shares the persisted delivery.
      const next = new Runtimes(
        f.store,
        f.info.cwd,
        () => {},
        () => "",
        undefined,
        f.info.cwd,
      );
      t.after(async () => next.close());
      next.connections.set(f.agent.id, {
        connection: null as never,
        info: activeInfo,
      });
      await next.retry(f.agent.id);
      assert.equal(
        (next as unknown as { lastTurn: Map<string, unknown> }).lastTurn.size,
        0,
      );
      next.connections.delete(f.agent.id);
      f.runtimes.connections.set(f.agent.id, {
        connection: null as never,
        info: activeInfo,
      });
    } else {
      // A restarted Pi has a different generation; the old in-memory turn
      // record must not be required to release the original confirmed id.
      activeInfo = { ...f.info, generation: randomUUID() };
      f.runtimes.connections.set(f.agent.id, {
        connection: null as never,
        info: activeInfo,
      });
      await f.runtimes.retry(f.agent.id);
    }
    assert.deepEqual(calls, [f.pending.id, f.pending.id]);
    assert.equal(f.store.uncertainDelivery(f.agent.id), null);
    assert.equal(f.store.failure(f.agent.id), null);
    assert.equal(f.store.pending(f.agent.id).length, 0);
    f.store.send(LOCAL_USER, { chat_id: f.chat.id, body: "W-2", mentions: [] });
    await f.runtimes.pump(f.agent.id, true);
    assert.equal(calls.length, 3);
    assert.notEqual(calls[2], f.pending.id);
  });
}

for (const restart of [false, true]) {
  test(`failed unknown delivery replays with a new id${restart ? " after Web restart" : ""}`, async (t) => {
    const f = fixture(t);
    const calls: { id: string; text: string }[] = [];
    t.mock.method(
      Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
      "rpc",
      async (method: string, params: { id?: string; text?: string }) => {
        if (method === "_pi/runtime/status") return f.info;
        assert.equal(method, "_pi/runtime/deliver");
        calls.push({ id: params.id!, text: params.text! });
        if (calls.length === 1)
          throw new Problem(503, "应答丢失", "runner_outcome_unknown");
        return { accepted: true, duplicate: calls.length === 2 };
      },
    );
    await f.runtimes.pump(f.agent.id, true);
    // The original Pi turn ended with a model error, while the uncertain
    // delivery remained pending. This failure persists across Web restarts.
    f.store.setFailure(f.agent.id, "500: isolated upstream 500");
    let runtimes = f.runtimes;
    if (restart) {
      runtimes = new Runtimes(
        f.store,
        f.info.cwd,
        () => {},
        () => "",
        undefined,
        f.info.cwd,
      );
      t.after(async () => runtimes.close());
      runtimes.connections.set(f.agent.id, {
        connection: null as never,
        info: f.info,
      });
    }
    await runtimes.retry(f.agent.id);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.slice(0, 2).map((call) => call.id),
      [f.pending.id, f.pending.id],
    );
    assert.notEqual(calls[2]!.id, f.pending.id);
    assert.match(calls[2]!.text, /上一轮运行出错/);
    assert.equal(f.store.uncertainDelivery(f.agent.id), null);
    assert.match(f.store.failure(f.agent.id)?.text ?? "", /500/);
    assert.equal(
      f.store.one<{ state: string; error: string | null }>(
        "SELECT state,error FROM deliveries WHERE id=?",
        calls[2]!.id,
      )?.state,
      "accepted",
    );
  });
}

test("unknown duplicate with incomplete trace keeps its failure and retry entry", async (t) => {
  const f = fixture(t);
  f.store.deliveryError(f.pending.id, "投递结果未知：应答中断");
  f.store.setFailure(f.agent.id, "投递结果未知：应答中断");
  (f.runtimes as unknown as { traceLag: Set<string> }).traceLag.add(f.agent.id);
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      if (method === "_pi/runtime/status") return f.info;
      assert.equal(method, "_pi/runtime/deliver");
      return { accepted: true, duplicate: true };
    },
  );
  await f.runtimes.retry(f.agent.id);
  assert.equal(f.store.uncertainDelivery(f.agent.id)?.state, "accepted");
  assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
});

test("retry while runner disappears preserves unknown id and retry entry", async (t) => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      if (method === "_pi/runtime/status") {
        if (calls) throw new Problem(503, "运行器断线", "runner_offline");
        return f.info;
      }
      if (method === "_pi/runtime/deliver") {
        calls++;
        throw new Problem(503, "应答丢失", "runner_outcome_unknown");
      }
      throw new Problem(503, "运行器断线", "runner_offline");
    },
  );
  await f.runtimes.pump(f.agent.id, true);
  await f.runtimes.retry(f.agent.id);
  assert.equal(calls, 1);
  assert.equal(f.store.uncertainDelivery(f.agent.id)?.id, f.pending.id);
  assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
});

test("unknown retry after Web restart cannot boot a replacement before discovering the old Pi", async (t) => {
  const f = fixture(t);
  claimRunner(f.store, f.agent.id, "r1", "generation-1");
  f.store.run(
    "UPDATE agents SET runtime_id=?,runtime_pid=? WHERE id=?",
    f.info.runtimeId,
    f.info.pid,
    f.agent.id,
  );
  f.runtimes.connections.clear();
  const internal = f.runtimes as unknown as {
    discovered: unknown[];
    discoveredOnce: boolean;
    bridge: unknown;
  };
  internal.discovered = []; // Web has just restarted and not yet received the runner list.
  internal.discoveredOnce = false;
  internal.bridge = { generation: () => "generation-1", close: () => {} };
  // Runner replied to discovery but the old runtime is temporarily absent.
  // This must test the no-replacement guard, not an unrelated discovery error.
  t.mock.method(Runtimes.prototype, "discover", async () => {
    internal.discoveredOnce = true;
  });
  f.store.deliveryError(f.pending.id, "投递结果未知：应答中断");
  f.store.setFailure(f.agent.id, "投递结果未知：应答中断");
  let starts = 0;
  t.mock.method(
    Runtimes.prototype as unknown as { start(): Promise<void> },
    "start",
    async () => {
      starts++;
    },
  );
  await f.runtimes.retry(f.agent.id);
  assert.equal(starts, 0);
  assert.equal(f.store.uncertainDelivery(f.agent.id)?.id, f.pending.id);
  assert.match(f.store.failure(f.agent.id)?.text ?? "", /投递结果未知/);
});

test("revoked runner's identity can be released only after explicit stop confirmation", async (t) => {
  const f = fixture(t);
  const auth = new RunnerAuth(f.store);
  const { runnerId } = auth.issue("测试运行器", "a".repeat(64));
  claimRunner(f.store, f.agent.id, runnerId, "generation-1");
  f.store.run(
    "UPDATE agents SET runtime_id=?,runtime_pid=? WHERE id=?",
    f.info.runtimeId,
    f.info.pid,
    f.agent.id,
  );
  (f.runtimes as unknown as { bridge: unknown }).bridge = {
    generation: () => null,
    requestControl: () => {
      throw new Error("Revoked runner must never be contacted");
    },
    close: () => {},
  };
  auth.revoke(runnerId);
  // A cached connection must not hide the actionable revoked-runner hint.
  await assert.rejects(
    f.runtimes.start(f.agent.id),
    /已撤销.*atrium runner reclaim.*--confirm-stopped/,
  );
  f.runtimes.connections.delete(f.agent.id); // Revoked daemon has exited.
  await assert.rejects(
    f.runtimes.start(f.agent.id),
    /已撤销.*atrium runner reclaim.*--confirm-stopped/,
  );
  await assert.rejects(
    f.runtimes.reclaimRunner(f.agent.id, false),
    /确认旧 Pi 已停止/,
  );
  assert.equal(ownerOf(f.store, f.agent.id)?.runner_id, runnerId);
  const result = await f.runtimes.reclaimRunner(f.agent.id, true);
  assert.equal(result.released, true);
  assert.equal(ownerOf(f.store, f.agent.id), null);
  assert.equal(
    f.store.one<{ runtime_id: string | null }>(
      "SELECT runtime_id FROM agents WHERE id=?",
      f.agent.id,
    )?.runtime_id,
    null,
  );
  assert.equal(f.runtimes.canBindRunner(f.agent.id), true);
});

test("drain control only targets the current owner generation and never certifies a switched runner", async (t) => {
  const f = fixture(t);
  new RunnerAuth(f.store);
  await assert.rejects(
    f.runtimes.drainRunner(f.agent.id, "start"),
    (error: unknown) => error instanceof Problem && error.statusCode === 404,
  );
  claimRunner(f.store, f.agent.id, "r1", "generation-1");
  let generation = "generation-1";
  const calls: string[] = [];
  (f.runtimes as unknown as { bridge: unknown }).bridge = {
    generation: () => generation,
    requestControl: async (
      runnerId: string,
      method: string,
      payload: { action: string },
    ) => {
      calls.push(`${runnerId}:${method}:${payload.action}`);
      return { drained: true, busy: [] };
    },
    close: () => {},
  };
  assert.deepEqual(await f.runtimes.drainRunner(f.agent.id, "start"), {
    drained: true,
    busy: [],
  });
  assert.deepEqual(calls, ["r1:runner.drain:start"]);
  generation = "generation-2";
  await assert.rejects(
    f.runtimes.drainRunner(f.agent.id, "status"),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_offline",
  );
  assert.equal(calls.length, 1);
  generation = "generation-1";
  (
    f.runtimes as unknown as {
      bridge: { requestControl: () => Promise<unknown> };
    }
  ).bridge.requestControl = async () => {
    generation = "generation-2";
    return { drained: true, busy: [] };
  };
  await assert.rejects(
    f.runtimes.drainRunner(f.agent.id, "status"),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_changed",
  );
});

test("真实 tick 连跑三次到期：第三次投递后才耗尽，终态仅通知一次", async (t) => {
  const f = fixture(t);
  const id = f.agent.id;
  const tick = () =>
    (f.runtimes as unknown as { tick(): Promise<void> }).tick();
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  f.store.run(
    "UPDATE deliveries SET created_at=? WHERE agent_id=?",
    1_700_000_000_000,
    id,
  );
  f.store.setFailure(id, "HTTP 503", now - 120_000, "provider", "first");
  const delivered: string[] = [];
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string, args: { id?: string }) => {
      if (method === "_pi/runtime/status") return f.info;
      if (method === "_pi/runtime/deliver") {
        delivered.push(args.id!);
        return { accepted: true };
      }
      throw new Error(`unexpected RPC: ${method}`);
    },
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    const retry = f.store.retryStatus(id, now)?.retry;
    assert.equal(retry?.state, "waiting");
    assert.equal(retry.attempt, attempt);
    now = retry.next_at!;
    await tick(); // Real tick -> claimRetry -> pump -> doPump -> deliver RPC.
    assert.equal(delivered.length, attempt);
    assert.equal(f.store.incident(id)?.attempts_used, attempt);
    assert.equal(f.store.incident(id)?.attempt_running, true);
    assert.equal(f.store.retryStatus(id, now)?.retry?.state, "running");
    // The fake Pi acknowledges input, then its observed run_end fails.
    f.store.finishTurn(id, false, undefined, true);
    now++;
    f.store.setFailure(id, "HTTP 503", now, "provider", `failed-${attempt}`);
    await tick();
    assert.equal(
      f.store.retryStatus(id, now)?.retry?.state,
      attempt === 3 ? "exhausted" : "waiting",
    );
    const notices = f.store.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE sender='system' AND body LIKE '%运行出错%'",
    )!.count;
    assert.equal(notices, attempt === 3 ? 1 : 0);
  }
  assert.equal(new Set(delivered).size, 3);
  assert.equal(notifyTerminal(f.store, id), false);
  assert.match(
    f.store.one<{ body: string }>(
      "SELECT body FROM messages WHERE sender='system' AND body LIKE '%运行出错%'",
    )!.body,
    /已自动重试 3 次/,
  );
});

test("a new user direct during a transient failure gets one turn, then the scheduled retry still runs", async (t) => {
  const f = fixture(t);
  f.store.setFailure(
    f.agent.id,
    "Connection error.",
    Date.now() - 1000,
    "provider",
  );
  f.store.send(LOCAL_USER, {
    chat_id: f.chat.id,
    body: "请再试一次",
    mentions: [],
  });
  const nextAt = f.store.retryStatus(f.agent.id)?.retry?.next_at;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      assert.equal(method, "_pi/runtime/status");
      return f.info;
    },
  );
  const calls: boolean[] = [];
  t.mock.method(
    f.runtimes as unknown as {
      doPump(id: string, direct: boolean): Promise<void>;
    },
    "doPump",
    async (id: string, direct: boolean) => {
      calls.push(direct);
      f.store.accepted(f.store.pending(id)[0]!.id);
      f.store.setFailure(id, "Connection error.", Date.now(), "provider");
      f.store.finishTurn(id, false);
    },
  );
  const tick = () =>
    (f.runtimes as unknown as { tick(): Promise<void> }).tick();
  await tick();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(
    calls,
    [true],
    "the same user message must not loop every tick",
  );
  assert.equal(f.store.incident(f.agent.id)?.attempts_used, 0);
  assert.equal(f.store.retryStatus(f.agent.id)?.retry?.next_at, nextAt);
  f.store.run(
    "UPDATE failure_incidents SET started_at=? WHERE agent_id=?",
    Date.now() - 120_001,
    f.agent.id,
  );
  await tick();
  assert.deepEqual(
    calls,
    [true, true],
    "the scheduled attempt must not be starved",
  );
  assert.equal(f.store.incident(f.agent.id)?.attempts_used, 1);
  assert.equal(f.store.retryStatus(f.agent.id)?.retry?.state, "waiting");
});

for (const next of ["scheduled", "manual", "new user"] as const) {
  test(`a steer during a failed retry cannot strand ${next} delivery behind cached busy`, async (t) => {
    const f = fixture(t);
    const id = f.agent.id;
    let now = 1_800_000_000_000;
    t.mock.method(Date, "now", () => now);
    f.store.run(
      "UPDATE deliveries SET created_at=? WHERE agent_id=?",
      now - 200_000,
      id,
    );
    f.store.setFailure(id, "Connection error.", now - 120_000, "provider");
    let busy = false;
    const delivered: string[] = [];
    t.mock.method(
      Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
      "rpc",
      async (method: string, args: { id?: string }) => {
        if (method === "_pi/runtime/status") return { ...f.info, busy };
        if (method === "_pi/runtime/deliver") {
          delivered.push(args.id!);
          return { accepted: true };
        }
        throw new Error(`unexpected RPC: ${method}`);
      },
    );
    const tick = () =>
      (f.runtimes as unknown as { tick(): Promise<void> }).tick();
    await tick(); // The first scheduled attempt starts a Pi turn.
    assert.equal(f.store.incident(id)?.attempts_used, 1);
    assert.equal(delivered.length, 1);
    busy = true;
    now += 100;
    f.store.send(LOCAL_USER, {
      chat_id: f.chat.id,
      body: "这一轮中途补一条私聊",
      mentions: [],
    });
    await tick(); // A steer refreshes the cached info to busy=true.
    assert.equal(f.runtimes.connections.get(id)?.info.busy, true);
    assert.equal(delivered.length, 2);
    busy = false; // Pi's turn ended; no new pump will refresh the cached info.
    f.store.finishTurn(id, false, undefined, true);
    now += 100;
    f.store.setFailure(id, "Connection error.", now, "provider", "steer-fail");
    const due = f.store.retryStatus(id, now)?.retry;
    assert.equal(due?.state, "waiting");
    const before = delivered.length;
    if (next === "manual") await f.runtimes.retry(id);
    else if (next === "scheduled") {
      now = due.next_at!;
      await tick();
      assert.equal(f.store.incident(id)?.attempts_used, 2);
    } else {
      now += 100;
      f.store.send(LOCAL_USER, {
        chat_id: f.chat.id,
        body: "上一轮失败后再来一条私聊",
        mentions: [],
      });
      await tick();
      assert.equal(f.store.incident(id)?.attempts_used, 1);
    }
    assert(
      delivered.length > before,
      "the idle Pi must receive the next attempt",
    );
    assert.equal(f.runtimes.connections.get(id)?.info.busy, false);
  });
}

test("three consecutive failed status checks end the scheduled retry without consuming attempts", async (t) => {
  const f = fixture(t);
  const id = f.agent.id;
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  f.store.run(
    "UPDATE deliveries SET created_at=? WHERE agent_id=?",
    now - 200_000,
    id,
  );
  f.store.setFailure(id, "Connection error.", now - 120_000, "provider");
  let unavailable = true;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      assert.equal(method, "_pi/runtime/status");
      if (unavailable) throw new Error("status endpoint offline");
      return { ...f.info, busy: true };
    },
  );
  const tick = () =>
    (f.runtimes as unknown as { tick(): Promise<void> }).tick();
  await tick();
  assert.equal(f.store.incident(id)?.attempts_used, 0);
  assert.equal(f.store.retryStatus(id)?.retry?.state, "waiting");
  unavailable = false;
  await tick(); // A healthy check resets the consecutive failure counter.
  unavailable = true;
  await tick();
  await tick();
  assert.equal(f.store.retryStatus(id)?.retry?.state, "waiting");
  await tick();
  assert.equal(f.store.retryStatus(id)?.retry?.state, "needs_action");
  assert.equal(f.store.incident(id)?.attempts_used, 0);
  assert.match(f.store.failure(id)?.text ?? "", /连续核对失败 3 次/);
  assert.equal(f.store.incident(id)?.blocked, true);
});

test("an overdue retry waits through drain without a new turn or budget, then delivers once", async (t) => {
  const f = fixture(t);
  new RunnerAuth(f.store);
  claimRunner(f.store, f.agent.id, "r1", "generation-1");
  let draining = true;
  let inspections = 0;
  (f.runtimes as unknown as { bridge: unknown }).bridge = {
    generation: () => "generation-1",
    requestControl: async (
      _runner: string,
      method: string,
      payload: { action: string },
    ) => {
      assert.equal(method, "runner.drain");
      assert.equal(payload.action, "inspect");
      inspections++;
      return { draining };
    },
    close: () => {},
  };
  f.store.setFailure(f.agent.id, "HTTP 503", Date.now(), "provider");
  f.store.run(
    "UPDATE failure_incidents SET started_at=? WHERE agent_id=?",
    Date.now() - 120_001,
    f.agent.id,
  );
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      assert.equal(method, "_pi/runtime/status");
      return f.info;
    },
  );
  const calls: boolean[] = [];
  t.mock.method(
    f.runtimes as unknown as {
      doPump(id: string, direct: boolean): Promise<void>;
    },
    "doPump",
    async (id: string, direct: boolean) => {
      calls.push(direct);
      if (direct) {
        f.store.accepted(f.pending.id);
        f.store.completeDelivery(f.pending.id);
        f.store.clearFailure(id);
      }
    },
  );
  const tick = () =>
    (f.runtimes as unknown as { tick(): Promise<void> }).tick();
  await tick();
  await tick();
  assert.equal(inspections, 2);
  assert.deepEqual(calls, []);
  assert.equal(f.store.incident(f.agent.id)?.attempts_used, 0);
  assert.equal(f.store.retryStatus(f.agent.id)?.retry?.state, "waiting");
  assert.equal(f.store.pending(f.agent.id)[0]?.id, f.pending.id);
  draining = false;
  await tick();
  await tick();
  assert.deepEqual(calls.filter(Boolean), [true]);
  assert.equal(
    f.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries WHERE id=? AND state='complete'",
      f.pending.id,
    )?.n,
    1,
  );
  assert.equal(f.store.failure(f.agent.id), null);
});

test("a drain beginning after inspect releases the unstarted retry without blocking later recovery", async (t) => {
  const f = fixture(t);
  new RunnerAuth(f.store);
  claimRunner(f.store, f.agent.id, "r1", "generation-1");
  (f.runtimes as unknown as { bridge: unknown }).bridge = {
    generation: () => "generation-1",
    requestControl: async () => ({ draining: false }),
    close: () => {},
  };
  f.store.setFailure(f.agent.id, "HTTP 503", Date.now(), "provider");
  f.store.run(
    "UPDATE failure_incidents SET started_at=? WHERE agent_id=?",
    Date.now() - 120_001,
    f.agent.id,
  );
  let attempted = 0;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      if (method === "_pi/runtime/status") return f.info;
      if (method !== "_pi/runtime/deliver")
        throw new Error(`unexpected RPC: ${method}`);
      if (++attempted === 1)
        throw new Problem(409, "身份正在排空", "runner_draining");
      return { accepted: true };
    },
  );
  const tick = () =>
    (f.runtimes as unknown as { tick(): Promise<void> }).tick();
  await tick();
  assert.equal(attempted, 1);
  assert.equal(f.store.incident(f.agent.id)?.attempts_used, 0);
  assert.equal(f.store.incident(f.agent.id)?.blocked, false);
  assert.equal(f.store.retryStatus(f.agent.id)?.retry?.state, "waiting");
  assert.equal(f.store.pending(f.agent.id)[0]?.id, f.pending.id);
  await tick();
  assert.equal(attempted, 2);
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.pending.id,
    )?.state,
    "accepted",
  );
  f.store.finishTurn(f.agent.id, true);
  await tick();
  assert.equal(attempted, 2);
});

test("draining rejects manual and automatic start without failure or budget; resume delivers pending once", async (t) => {
  const f = fixture(t);
  f.runtimes.connections.delete(f.agent.id);
  let draining = true;
  const delivered: string[] = [];
  t.mock.method(
    Runtimes.prototype as unknown as { services(): Promise<unknown> },
    "services",
    async () => ({}),
  );
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string, params: { id?: string }) => {
      if (method === "session/new") {
        if (draining) throw new Problem(409, "身份正在排空", "runner_draining");
        return { sessionId: f.info.sessionId };
      }
      if (method === "_pi/runtime/status") return f.info;
      if (method === "_pi/runtime/deliver") {
        delivered.push(params.id!);
        return { accepted: true };
      }
      throw new Error(`unexpected RPC: ${method}`);
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as { bind(): Promise<void> },
    "bind",
    async () => {
      f.runtimes.connections.set(f.agent.id, {
        connection: null as never,
        info: f.info,
      });
    },
  );
  await assert.rejects(
    f.runtimes.start(f.agent.id),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_draining",
  );
  assert.equal(f.store.failure(f.agent.id), null);
  await assert.rejects(
    f.runtimes.start(f.agent.id, true),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_draining",
  );
  assert.equal(f.store.failure(f.agent.id), null);
  assert.deepEqual(delivered, []);
  assert.equal(
    (f.runtimes as unknown as { starts: Map<string, unknown> }).starts.has(
      f.agent.id,
    ),
    false,
    "rejected automatic start must not consume cooldown or failure budget",
  );
  draining = false;
  await f.runtimes.start(f.agent.id);
  assert.deepEqual(delivered, [f.pending.id]);
  assert.equal(f.store.failure(f.agent.id), null);
});

test("draining rejects attach without recording an identity failure", async (t) => {
  const f = fixture(t);
  f.runtimes.connections.delete(f.agent.id);
  t.mock.method(
    Runtimes.prototype as unknown as { bind(): Promise<void> },
    "bind",
    async () => {
      throw new Problem(409, "身份正在排空", "runner_draining");
    },
  );
  await assert.rejects(
    f.runtimes.attach(f.agent.id, f.info.runtimeId),
    (error: unknown) =>
      error instanceof Problem && error.code === "runner_draining",
  );
  assert.equal(f.store.failure(f.agent.id), null);
  assert.equal(f.store.pending(f.agent.id)[0]?.id, f.pending.id);
});

for (const [name, code, status] of [
  ["runner offline", "runner_offline", 503],
  ["identity draining", "runner_draining", 409],
] as const) {
  test(`${name} before delivery keeps pending with no false identity failure`, async (t) => {
    const f = fixture(t);
    const methods: string[] = [];
    t.mock.method(
      Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
      "rpc",
      async (method: string) => {
        methods.push(method);
        if (method === "_pi/runtime/status") return f.info;
        assert.equal(method, "_pi/runtime/deliver");
        throw new Problem(status, "命令未发送", code);
      },
    );
    await f.runtimes.pump(f.agent.id, true);
    assert.ok(
      methods.includes("_pi/runtime/deliver"),
      "must exercise delivery rejection",
    );
    assert.equal(f.store.pending(f.agent.id)[0]?.id, f.pending.id);
    assert.equal(f.store.failure(f.agent.id), null);
  });
}

test("只剩纯告知时 prepareMigration 不再被待办挡住", async (t) => {
  const f = fixture(t);
  f.store.run("DELETE FROM deliveries WHERE id=?", f.pending.id);
  const mate = f.store.createAgent("同伴", f.info.cwd).agent;
  const group = f.store.createChat("协作群", [f.agent.id, mate.id]);
  f.store.send(mate.id, {
    chat_id: group.id,
    body: "我这边做完了",
    mentions: [],
    quiet: true,
  });
  assert.equal(f.store.pending(f.agent.id).length, 0);
  assert.equal(f.store.notices(f.agent.id).length, 1, "告知还在排队");
  t.mock.method(
    Runtimes.prototype as unknown as { owned(): boolean },
    "owned",
    () => true,
  );
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string) => {
      if (method === "_pi/runtime/status") return { ...f.info, busy: false };
      return {};
    },
  );
  await f.runtimes.prepareMigration(f.agent.id);
  assert.equal(f.store.notices(f.agent.id).length, 1, "迁移不碰排队的告知");
});

test("只剩纯告知不把身份标成未分配", async (t) => {
  const f = fixture(t);
  f.store.run("DELETE FROM deliveries WHERE id=?", f.pending.id);
  f.store.run("DELETE FROM account_assignments WHERE agent_id=?", f.agent.id);
  const mate = f.store.createAgent("同伴", f.info.cwd).agent;
  const group = f.store.createChat("协作群", [f.agent.id, mate.id]);
  f.store.send(mate.id, {
    chat_id: group.id,
    body: "我这边做完了",
    mentions: [],
    quiet: true,
  });
  await f.runtimes.pump(f.agent.id, false);
  assert.equal(f.store.failure(f.agent.id), null, "没有要送的投递，不算没分配");
});

test("duplicate 不删搭车的告知：下一趟再带上", async (t) => {
  const f = fixture(t);
  const mate = f.store.createAgent("同伴", f.info.cwd).agent;
  const group = f.store.createChat("协作群", [f.agent.id, mate.id]);
  f.store.send(mate.id, {
    chat_id: group.id,
    body: "我这边做完了",
    mentions: [],
    quiet: true,
  });
  const texts: string[] = [];
  let activeInfo = f.info;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc(): Promise<unknown> },
    "rpc",
    async (method: string, params: { id?: string; text?: string }) => {
      if (method === "_pi/runtime/status") return activeInfo;
      assert.equal(method, "_pi/runtime/deliver");
      texts.push(params.text!);
      if (texts.length === 1)
        throw new Problem(503, "应答丢失", "runner_outcome_unknown");
      return { accepted: true, duplicate: true };
    },
  );
  await f.runtimes.pump(f.agent.id, true);
  assert.match(texts[0]!, /我这边做完了/, "第一趟把告知搭上");
  f.store.finishTurn(f.agent.id, true);
  activeInfo = { ...f.info, generation: randomUUID() };
  f.runtimes.connections.set(f.agent.id, {
    connection: null as never,
    info: activeInfo,
  });
  await f.runtimes.retry(f.agent.id);
  assert.equal(f.store.uncertainDelivery(f.agent.id), null);
  assert.equal(
    f.store.notices(f.agent.id).length,
    1,
    "duplicate 那一趟的告知没交出去，不能删",
  );
  f.store.send(LOCAL_USER, { chat_id: f.chat.id, body: "W-2", mentions: [] });
  await f.runtimes.pump(f.agent.id, true);
  assert.equal(texts.length, 3);
  assert.match(texts[2]!, /我这边做完了/, "下一趟重新搭上，宁可重复不丢");
});
