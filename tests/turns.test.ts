import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { TraceStore } from "../server/trace.ts";
import { TurnLedger } from "../server/turns.ts";
import { LOCAL_USER } from "../shared/user.ts";
import type { RuntimeEventPage } from "../shared/trace.ts";

function fixture(
  t: TestContext,
  redact: (agent: string, text: string) => string = (_, text) => text,
) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-turn-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.db"));
  t.after(() => store.close());
  const agent = store.createAgent("收尾测试", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const delivery = store
    .pending(agent.id)
    .find((row) => row.kind === "direct")!;
  const trace = new TraceStore(store, redact);
  const ledger = new TurnLedger(store, redact);
  const runtimeId = randomUUID();
  const generation = randomUUID();
  const sessionId = randomUUID();
  let seq = 0;
  function event(
    kind: RuntimeEventPage["items"][number]["kind"],
    extra: object = {},
  ) {
    const item = { seq: ++seq, at: Date.now(), kind, ...extra };
    const page: RuntimeEventPage = {
      runtimeId,
      generation,
      sessionId,
      items: [item],
      nextAfter: seq,
      hasMore: false,
      gap: false,
    };
    trace.ingest(agent.id, page, (e) =>
      ledger.ingest(agent.id, runtimeId, generation, e),
    );
  }
  return {
    store,
    agent,
    chat,
    delivery,
    ledger,
    trace,
    runtimeId,
    generation,
    sessionId,
    event,
  };
}

test("同一代际多次 run_start 延续接收点，成功 run_end 原子结清并推进游标", (t) => {
  const f = fixture(t);
  f.event("delivery", { name: "Atrium" }); // Pi 在回复 RPC 前先记录投递，可能先于 run_start。
  f.event("run_start");
  f.store.accepted(f.delivery.id);
  f.event("run_start"); // 同一个运行中追加回合，不应遗失 deliveryAt。
  assert.ok(f.ledger.current(f.agent.id)?.delivery_at);
  f.event("run_end");
  assert.equal(f.ledger.current(f.agent.id), null);
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "complete",
  );
  assert.equal(f.trace.cursor(f.agent.id, f.runtimeId, f.generation), 4);
});

test("失败轮保留失败并让 direct 换新 ID 重投，summary 不复制", (t) => {
  const f = fixture(t);
  const summary = f.store.queue(f.agent.id, "summary", "摘要");
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(f.delivery.id);
  f.store.accepted(summary);
  f.event("message", { name: "assistant", error: true, text: "provider 503" });
  assert.equal(f.ledger.current(f.agent.id)?.failure, "provider 503");
  f.event("run_end");
  const pending = f.store.pending(f.agent.id);
  assert.equal(pending.length, 2);
  assert.notEqual(
    pending.find((row) => row.kind === "direct")?.id,
    f.delivery.id,
  );
  assert.notEqual(pending.find((row) => row.kind === "summary")?.id, summary);
  assert.equal(
    f.store.one<{ slot: string }>(
      "SELECT slot FROM deliveries WHERE id=?",
      pending.find((row) => row.kind === "summary")!.id,
    )?.slot,
    "summary",
  );
  f.store.queue(f.agent.id, "summary", "更新后的摘要");
  assert.equal(
    f.store.pending(f.agent.id).filter((row) => row.kind === "summary").length,
    1,
    "同一消息箱重试后再次提醒，仍然只有一条 pending summary",
  );
  assert.equal(f.trace.cursor(f.agent.id, f.runtimeId, f.generation), 4);
});

test("失败轮已有更新的 summary 在排队时不再制造第二条", (t) => {
  const f = fixture(t);
  const summary = f.store.queue(f.agent.id, "summary", "旧摘要");
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(summary);
  f.store.queue(f.agent.id, "summary", "新的消息箱状态");
  f.event("message", { name: "assistant", error: true, text: "模型失败" });
  f.event("run_end");
  const summaries = f.store
    .pending(f.agent.id)
    .filter((row) => row.kind === "summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.text, "新的消息箱状态");
  assert.equal(
    f.store.one<{ slot: string }>(
      "SELECT slot FROM deliveries WHERE id=?",
      summaries[0]?.id,
    )?.slot,
    "summary",
  );
});

test("消息事件没有 assistant 名称仍是失败，持久化错误文本已脱敏", (t) => {
  const f = fixture(t, (_, text) => text.replace("secret-token", "[已隐藏]"));
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(f.delivery.id);
  f.event("message", { error: true, text: "provider 503 secret-token" });
  assert.equal(f.ledger.current(f.agent.id)?.failure, "provider 503 [已隐藏]");
  f.event("run_end");
  assert.equal(
    f.store.pending(f.agent.id).filter((row) => row.kind === "direct").length,
    1,
  );
  assert.equal(f.ledger.current(f.agent.id), null);
});

test("无本轮投递的 run_end 不会替旧 accepted 宣告成功；新一轮也只结清自己的投递", (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.store.accepted(f.delivery.id);
  f.event("run_start");
  f.event("run_end");
  const state = (id: string) =>
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      id,
    )?.state;
  assert.equal(state(f.delivery.id), "accepted");

  now += 1000;
  f.store.send(LOCAL_USER, {
    chat_id: f.chat.id,
    body: "另一轮",
    mentions: [],
  });
  const next = f.store
    .pending(f.agent.id)
    .find((row) => row.kind === "direct")!;
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(next.id);
  f.event("run_end");
  assert.equal(state(next.id), "complete");
  assert.equal(state(f.delivery.id), "accepted", "旧回合必须经单独判定或重试");
});

test("轨迹事件内若结算失败，游标与投递都回滚，下次仍可消费", (t) => {
  const f = fixture(t);
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(f.delivery.id);
  const before = f.trace.cursor(f.agent.id, f.runtimeId, f.generation);
  const page: RuntimeEventPage = {
    runtimeId: f.runtimeId,
    generation: f.generation,
    sessionId: f.sessionId,
    items: [{ seq: before + 1, at: Date.now(), kind: "run_end" }],
    nextAfter: before + 1,
    hasMore: false,
    gap: false,
  };
  assert.throws(
    () =>
      f.trace.ingest(f.agent.id, page, (e) => {
        f.ledger.ingest(f.agent.id, f.runtimeId, f.generation, e);
        throw new Error("结算故障");
      }),
    /结算故障/,
  );
  assert.equal(f.trace.cursor(f.agent.id, f.runtimeId, f.generation), before);
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "accepted",
  );
  assert.ok(f.ledger.current(f.agent.id));
  f.trace.ingest(f.agent.id, page, (e) =>
    f.ledger.ingest(f.agent.id, f.runtimeId, f.generation, e),
  );
  assert.equal(
    f.trace.cursor(f.agent.id, f.runtimeId, f.generation),
    before + 1,
  );
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "complete",
  );
});

test("旧库迁移可重入；有 start 才能用迟到的 end 收尾，无 start 不伪造成功", (t) => {
  const f = fixture(t);
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(f.delivery.id);
  f.store.run(
    "UPDATE agents SET runtime_id=?,acp_session_id=? WHERE id=?",
    f.runtimeId,
    f.sessionId,
    f.agent.id,
  );
  f.store.run("DELETE FROM runtime_turns WHERE agent_id=?", f.agent.id); // 模拟升级前只留 trace_actions。
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  const turn = f.ledger.current(f.agent.id);
  assert.equal(turn?.generation, f.generation);
  f.store.run(
    "UPDATE runtime_turns SET failure='should-not-overwrite' WHERE agent_id=?",
    f.agent.id,
  );
  new TurnLedger(f.store);
  assert.equal(f.ledger.current(f.agent.id)?.failure, "should-not-overwrite");
  f.store.run("DELETE FROM runtime_turns WHERE agent_id=?", f.agent.id);
  f.event("run_end");
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "accepted",
  );
});

test("迁移选最新会话边界；没证据的旧 accepted 保留而非误判完成", (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.store.accepted(f.delivery.id);
  f.store.run(
    "UPDATE agents SET session_reset_at=?,runtime_id=?,acp_session_id=? WHERE id=?",
    now - 100_000,
    f.runtimeId,
    f.sessionId,
    f.agent.id,
  );
  now += 1_000;
  f.event("session");
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "complete",
    "当前 Pi 会话比陈旧 reset marker 新，旧消息不得在新会话重播",
  );

  const second = f.store.queue(f.agent.id, "direct", "无边界的消息");
  f.store.accepted(second);
  f.store.run(
    "UPDATE agents SET session_reset_at=NULL,runtime_id=NULL WHERE id=?",
    f.agent.id,
  );
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      second,
    )?.state,
    "accepted",
    "离线且无 reset / session 事件不能推断已经处理",
  );
});

test("旧版本无 accepted_at 时，有会话边界的历史收件直接完成", (t) => {
  const f = fixture(t);
  f.store.accepted(f.delivery.id);
  f.store.run(
    "UPDATE deliveries SET accepted_at=NULL WHERE id=?",
    f.delivery.id,
  );
  f.store.run(
    "UPDATE agents SET session_reset_at=? WHERE id=?",
    Date.now(),
    f.agent.id,
  );
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "complete",
    "旧版本 NULL accepted_at 不能被遗留到下一会话重投",
  );
});

test("旧版本无 accepted_at 时，正在跑的回合先保留再由 run_end 结清", (t) => {
  const f = fixture(t);
  f.event("delivery", { name: "Atrium" });
  f.event("run_start");
  f.store.accepted(f.delivery.id);
  f.store.run(
    "UPDATE deliveries SET accepted_at=NULL WHERE id=?",
    f.delivery.id,
  );
  f.store.run(
    "UPDATE agents SET session_reset_at=?,runtime_id=?,acp_session_id=? WHERE id=?",
    Date.now() - 1000,
    f.runtimeId,
    f.sessionId,
    f.agent.id,
  );
  f.store.run("DELETE FROM runtime_turns WHERE agent_id=?", f.agent.id);
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  assert.ok(f.ledger.current(f.agent.id));
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "accepted",
  );
  f.event("run_end");
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "complete",
  );
});

test("迁移恢复空文本助手错误，并按 Atrium delivery 而非外部指引判定", (t) => {
  const f = fixture(t);
  f.event("delivery", { name: "Atrium 接入说明" });
  f.event("run_start");
  f.event("message", { name: "assistant", error: true, text: "" });
  f.store.accepted(f.delivery.id);
  f.store.run(
    "UPDATE agents SET runtime_id=?,acp_session_id=? WHERE id=?",
    f.runtimeId,
    f.sessionId,
    f.agent.id,
  );
  f.store.run("DELETE FROM runtime_turns WHERE agent_id=?", f.agent.id);
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  assert.equal(f.ledger.current(f.agent.id)?.failure, "模型运行失败");
  assert.equal(f.ledger.current(f.agent.id)?.delivery_at, null);
  f.event("run_end");
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "accepted",
  );
});

test("迁移会找到 run_start 后才收到的 Atrium 投递", (t) => {
  const f = fixture(t);
  f.event("run_start");
  f.event("delivery", { name: "Atrium" });
  f.store.accepted(f.delivery.id);
  f.store.run(
    "UPDATE agents SET runtime_id=?,acp_session_id=? WHERE id=?",
    f.runtimeId,
    f.sessionId,
    f.agent.id,
  );
  f.store.run("DELETE FROM runtime_turns WHERE agent_id=?", f.agent.id);
  f.store.run(
    "DELETE FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
  );
  new TurnLedger(f.store);
  assert.ok(f.ledger.current(f.agent.id)?.delivery_at);
  f.event("run_end");
  assert.equal(
    f.store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      f.delivery.id,
    )?.state,
    "complete",
  );
});

test("删身份会同时去掉 accepted 与 pending，且保留历史会话引用", (t) => {
  const f = fixture(t);
  f.store.accepted(f.delivery.id);
  f.store.queue(f.agent.id, "summary", "提醒");
  f.store.deleteAgent(f.agent.id);
  assert.equal(
    f.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=?",
      f.agent.id,
    )?.n,
    0,
  );
  assert.equal(
    f.store.one<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM agents WHERE id=?",
      f.agent.id,
    )?.deleted_at != null,
    true,
  );
});
