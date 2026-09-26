import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { TraceStore } from "../server/trace.ts";
import { TurnLedger, settleFailure } from "../server/turns.ts";
import { afterFailure, normalModelOutput } from "../server/runtime-error.ts";
import { LOCAL_USER } from "../shared/user.ts";
import type { RuntimeEventPage } from "../shared/trace.ts";

test("正常模型输出白名单：只算 assistant 文本与工具调用", () => {
  const cases: [string, { name?: string; error?: boolean }, boolean][] = [
    ["tool_start", { name: "bash" }, true],
    ["message", { name: "assistant" }, true],
    ["message", { name: "assistant", error: true }, false],
    ["message", { name: "user" }, false],
    ["message", { name: "user", error: true }, false],
    ["tool_end", { name: "bash" }, false],
    ["run_start", {}, false],
    ["run_end", {}, false],
    ["session", {}, false],
    ["delivery", { name: "Atrium" }, false],
    ["gap", {}, false],
  ];
  for (const [kind, extra, expected] of cases)
    assert.equal(
      normalModelOutput({ kind, ...extra }),
      expected,
      `${kind} ${JSON.stringify(extra)}`,
    );
});

test("排序判定：只有排在故障之后的事件才算", () => {
  assert.equal(afterFailure(6, 5), true);
  assert.equal(afterFailure(5, 5), false, "同一行不算之后");
  assert.equal(afterFailure(4, 5), false);
  assert.equal(afterFailure(null, 5), false, "没有入库行号的事件不清故障");
  assert.equal(afterFailure(5, null), false, "没有故障时不清");
});

test("第一条正常输出清失败；重试回合开始后旧故障不再显示", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-error-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.db"));
  t.after(() => store.close());
  const agent = store.createAgent("出错恢复", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const trace = new TraceStore(store);
  const ledger = new TurnLedger(store);
  const runtimeId = randomUUID(),
    generation = randomUUID(),
    sessionId = randomUUID();
  let seq = 0;
  const ingest = (
    kind: RuntimeEventPage["items"][number]["kind"],
    extra: object = {},
  ) => {
    const item = { seq: ++seq, at: Date.now(), kind, ...extra };
    trace.ingest(
      agent.id,
      {
        runtimeId,
        generation,
        sessionId,
        items: [item],
        nextAfter: seq,
        hasMore: false,
        gap: false,
      },
      (event, traceId) => {
        ledger.ingest(agent.id, runtimeId, generation, event);
        settleFailure(store, agent.id, event, traceId);
      },
    );
    return item;
  };

  ingest("session");
  ingest("run_start");
  store.setFailure(agent.id, "401 invalid API key", Date.now(), "provider");
  assert.equal(
    store.turnAfterFailure(agent.id),
    false,
    "回合开始早于故障：仍显示出错",
  );
  ingest("run_end", { error: true });
  ingest("run_start");
  assert.equal(
    store.turnAfterFailure(agent.id),
    true,
    "重试已开始新回合：显示干活，不挂旧故障",
  );
  assert.equal(store.failure(agent.id)?.text, "401 invalid API key");
  ingest("tool_end", { name: "bash", callId: "t1" });
  assert.equal(
    store.failure(agent.id)?.text,
    "401 invalid API key",
    "工具结果不清",
  );
  ingest("message", { name: "assistant", error: true });
  assert.equal(
    store.failure(agent.id)?.text,
    "401 invalid API key",
    "出错的输出不清",
  );
  ingest("message", { name: "assistant", text: "恢复后的第一句" });
  assert.equal(store.failure(agent.id), null, "第一条正常输出清掉失败");
  assert.equal(store.failureTraceId(agent.id), null);
  assert.equal(store.turnAfterFailure(agent.id), false);
});

test("回合中途出错后，重投一条更早的正常事件不能清失败", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-error-midturn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.db"));
  t.after(() => store.close());
  const agent = store.createAgent("中途出错", dir).agent;
  const trace = new TraceStore(store);
  const ledger = new TurnLedger(store);
  const runtimeId = randomUUID(),
    generation = randomUUID(),
    sessionId = randomUUID();
  let seq = 0;
  const ingest = (
    kind: RuntimeEventPage["items"][number]["kind"],
    extra: object = {},
  ) => {
    const item = { seq: ++seq, at: Date.now(), kind, ...extra };
    trace.ingest(
      agent.id,
      {
        runtimeId,
        generation,
        sessionId,
        items: [item],
        nextAfter: seq,
        hasMore: false,
        gap: false,
      },
      (event, traceId) => {
        ledger.ingest(agent.id, runtimeId, generation, event);
        settleFailure(store, agent.id, event, traceId);
      },
    );
    return item;
  };

  ingest("session");
  ingest("run_start");
  const first = ingest("message", { name: "assistant", text: "正常输出" });
  // 同一回合「正常 → 出错」：故障来自轨迹事件，水位就是它的入库行号。
  ingest("message", { name: "assistant", error: true });
  store.setFailure(agent.id, "401 invalid API key", Date.now(), "provider");
  const watermark = store.failureTraceId(agent.id)!;
  const rows = trace.page(agent.id).items;
  assert.equal(
    afterFailure(rows.at(-1)!.id, watermark),
    false,
    "水位就是出错那条事件自己",
  );
  assert.equal(
    afterFailure(rows.find((i) => i.kind === "message")!.id, watermark),
    false,
    "出错之前那条正常输出排在水位之前，不能清失败",
  );
  // 轨迹游标本来就拒绝重投更早的 seq，规则和游标是同一条顺序。
  assert.throws(
    () =>
      trace.ingest(agent.id, {
        runtimeId,
        generation,
        sessionId,
        items: [{ ...first, at: Date.now() }],
        nextAfter: seq,
        hasMore: false,
        gap: false,
      }),
    /轨迹游标不连续/,
  );
  assert.equal(store.failure(agent.id)?.text, "401 invalid API key");
  // 随后真的排在故障之后的正常输出仍然能清。
  ingest("message", { name: "assistant", text: "恢复后的第一句" });
  assert.equal(store.failure(agent.id), null);
});

test("失败与恢复来回交替：计数、通知与重试间隔照实记下", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-error-alternate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.db"));
  t.after(() => store.close());
  const agent = store.createAgent("来回失败", dir).agent;
  const notices = () =>
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM incident_notices WHERE incident_id IN (SELECT id FROM failure_incidents WHERE agent_id=?)",
      agent.id,
    )!.n;
  const incidents = () =>
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM failure_incidents WHERE agent_id=?",
      agent.id,
    )!.n;
  const at = Date.now();
  store.setFailure(agent.id, "401 invalid API key", at, "provider");
  assert.equal(store.failure(agent.id)?.count, 1);
  store.clearFailure(agent.id, true);
  assert.equal(store.failure(agent.id), null);
  store.setFailure(agent.id, "401 invalid API key", at + 1, "provider");
  assert.equal(store.failure(agent.id)?.count, 1, "清除后计数从头开始");
  store.clearFailure(agent.id, true);
  assert.equal(incidents(), 2);
  assert.equal(notices(), 0, "没有待重试投递时不写通知");
  assert.equal(store.retryStatus(agent.id), null);
});

test("投递结果未知时，正常输出不清失败，重试回合也不藏起故障", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-error-uncertain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.db"));
  t.after(() => store.close());
  const agent = store.createAgent("投递未知", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const trace = new TraceStore(store);
  const ledger = new TurnLedger(store);
  const runtimeId = randomUUID(),
    generation = randomUUID(),
    sessionId = randomUUID();
  let seq = 0;
  const ingest = (
    kind: RuntimeEventPage["items"][number]["kind"],
    extra: object = {},
  ) => {
    const item = { seq: ++seq, at: Date.now(), kind, ...extra };
    trace.ingest(
      agent.id,
      {
        runtimeId,
        generation,
        sessionId,
        items: [item],
        nextAfter: seq,
        hasMore: false,
        gap: false,
      },
      (event, traceId) => {
        ledger.ingest(agent.id, runtimeId, generation, event);
        settleFailure(store, agent.id, event, traceId);
      },
    );
  };
  ingest("session");
  const warning =
    "投递结果未知：运行器连接中断；先核对轨迹和消息箱，再手动重试";
  store.deliveryError(store.pending(agent.id)[0].id, warning);
  store.setFailure(agent.id, warning);
  assert.ok(store.uncertainDelivery(agent.id));
  // 另一轮（如心跳或新消息）开始并正常输出：不能证明那条未知投递已送达。
  ingest("run_start");
  assert.equal(store.turnAfterFailure(agent.id), false, "不藏起投递未知");
  ingest("message", { name: "assistant", text: "别的事情的正常输出" });
  assert.equal(store.failure(agent.id)?.text, warning, "正常输出不清投递未知");
});
