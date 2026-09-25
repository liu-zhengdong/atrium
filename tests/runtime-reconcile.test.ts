import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtimes } from "../server/runtime.ts";
import { Store } from "../server/store.ts";
import { LOCAL_USER } from "../shared/user.ts";
import type { RuntimeInfo } from "../shared/schema.ts";

function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-reconcile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.db"));
  t.after(() => store.close());
  const agent = store.createAgent("回收条件", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const delivery = store
    .pending(agent.id)
    .find((row) => row.kind === "direct")!;
  const info: RuntimeInfo = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    pid: 1,
    ownerPid: 1,
    identityId: null,
    sessionFile: join(dir, "session.jsonl"),
    cwd: dir,
    mode: "rpc",
    busy: true,
    model: "test",
  };
  t.mock.method(
    Runtimes.prototype as unknown as { discover(): Promise<void> },
    "discover",
    async () => {},
  );
  const runtimes = new Runtimes(
    store,
    dir,
    () => {},
    () => "http://127.0.0.1:4331",
    undefined,
    dir,
  );
  t.after(async () => runtimes.close());
  const reconcile = (state: RuntimeInfo | null) =>
    (
      runtimes as unknown as {
        reconcileAccepted(id: string, info: RuntimeInfo | null): void;
      }
    ).reconcileAccepted(agent.id, state);
  const status = () =>
    store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      delivery.id,
    )?.state;
  return { store, agent, delivery, info, runtimes, reconcile, status };
}

test("Pi 回 duplicate:true 不产生 run event；pump 不把它当新接收，换 ID 下一轮重投", async (t) => {
  const f = fixture(t);
  f.store.run(
    "INSERT INTO accounts(provider,name,type,status) VALUES('test','测试','api_key','ready')",
  );
  const account = f.store.one<{ number: number }>(
    "SELECT number FROM accounts ORDER BY number DESC LIMIT 1",
  )!.number;
  f.store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    f.agent.id,
    "test",
    account,
  );
  let calls = 0;
  const prototype = Runtimes.prototype as unknown as {
    rpc(method: string, params: unknown): Promise<unknown>;
    capture(id: string, info: RuntimeInfo): Promise<void>;
  };
  t.mock.method(prototype, "rpc", async (method: string) => {
    if (method === "_pi/runtime/status") return f.info;
    assert.equal(method, "_pi/runtime/deliver");
    calls++;
    return { accepted: true, duplicate: true };
  });
  t.mock.method(prototype, "capture", async () => {});
  f.runtimes.connections.set(f.agent.id, {
    connection: null as never,
    info: f.info,
  });
  await f.runtimes.pump(f.agent.id, true);
  const pending = f.store.pending(f.agent.id);
  assert.equal(calls, 1);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]?.id, f.delivery.id);
  assert.match(pending[0]!.text, /重新投递同一条消息/);
  assert.equal(f.store.failure(f.agent.id), null);
});

test("Pi 对旧 ID 去重后重新投递必须换 ID；summary 失败也不能沿用旧 ID", async (t) => {
  const f = fixture(t);
  f.store.rekeyPending(f.delivery.id);
  const next = f.store
    .pending(f.agent.id)
    .find((row) => row.kind === "direct")!;
  assert.notEqual(next.id, f.delivery.id);
  assert.match(next.text, /重新投递同一条消息/);
  f.store.rekeyPending(next.id);
  const again = f.store
    .pending(f.agent.id)
    .find((row) => row.kind === "direct")!;
  assert.notEqual(again.id, next.id);
  assert.equal((again.text.match(/重新投递同一条消息/g) ?? []).length, 1);
  const summaryId = f.store.queue(f.agent.id, "summary", "待办提醒");
  f.store.accepted(summaryId);
  f.store.finishTurn(f.agent.id, false);
  const summary = f.store
    .pending(f.agent.id)
    .find((row) => row.kind === "summary")!;
  assert.notEqual(summary.id, summaryId);
});

test("忙碌中与首次空闲不误重投；空闲稳定后才补救丢失 run_end", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.store.accepted(f.delivery.id);
  f.reconcile(f.info);
  assert.equal(f.status(), "accepted");
  now += 60_000; // 即使长时间忙碌，也不能靠 accepted_at 超时重投。
  f.reconcile(f.info);
  assert.equal(f.status(), "accepted");
  const idle = { ...f.info, busy: false };
  f.reconcile(idle);
  assert.equal(f.status(), "accepted");
  now += 9_999;
  f.reconcile(idle);
  assert.equal(f.status(), "accepted");
  now += 1;
  f.reconcile(idle);
  assert.equal(f.status(), undefined);
  assert.equal(f.store.pending(f.agent.id).length, 1);
  assert.notEqual(f.store.pending(f.agent.id)[0]?.id, f.delivery.id);
});

test("事件流尚有积压或采集错误时不凭空闲猜失败；恢复后才启动静默窗口", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.store.accepted(f.delivery.id);
  const internal = f.runtimes as unknown as {
    traceLag: Set<string>;
    traceErrors: Map<string, string>;
  };
  internal.traceLag.add(f.agent.id);
  f.reconcile({ ...f.info, busy: false });
  now += 60_000;
  f.reconcile({ ...f.info, busy: false });
  assert.equal(f.status(), "accepted");
  internal.traceLag.delete(f.agent.id);
  internal.traceErrors.set(f.agent.id, "temporarily unavailable");
  f.reconcile({ ...f.info, busy: false });
  assert.equal(f.status(), "accepted");
  internal.traceErrors.delete(f.agent.id);
  f.reconcile({ ...f.info, busy: false });
  now += 10_000;
  f.reconcile({ ...f.info, busy: false });
  assert.equal(f.store.pending(f.agent.id).length, 1);
});

test("离线且没分配账号或已有故障时，也不能让旧 accepted 永远卡住", async (t) => {
  const f = fixture(t);
  f.store.accepted(f.delivery.id);
  (f.runtimes as unknown as { discoveredOnce: boolean }).discoveredOnce = true;
  await f.runtimes.pump(f.agent.id);
  assert.equal(
    f.store.pending(f.agent.id).length,
    1,
    "未分配账号的早退路径仍须回收",
  );
  const next = f.store.pending(f.agent.id)[0]!;
  f.store.accepted(next.id);
  f.store.setFailure(f.agent.id, "模型认证失败");
  await f.runtimes.pump(f.agent.id);
  assert.equal(
    f.store.pending(f.agent.id).length,
    1,
    "故障阻断发送，但不阻断已接收残债回收",
  );
});

test("代际变化或旧进程退出可直接重投；已删除身份不会留残债", async (t) => {
  const f = fixture(t);
  f.store.accepted(f.delivery.id);
  f.reconcile({ ...f.info, generation: randomUUID() });
  assert.equal(
    f.store.pending(f.agent.id).length,
    0,
    "无持久 turn 时忙状态不能当作旧代际证据",
  );
  f.reconcile(null);
  assert.equal(f.store.pending(f.agent.id).length, 1);
  f.store.accepted(f.store.pending(f.agent.id)[0]!.id);
  f.store.deleteAgent(f.agent.id);
  f.reconcile(null);
  assert.equal(f.store.pending(f.agent.id).length, 0);
  assert.equal(
    f.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=?",
      f.agent.id,
    )?.n,
    0,
  );
});
