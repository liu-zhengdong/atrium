import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import { notifyTerminal } from "../server/incident-notice.ts";
import { classifyFailure, retryDecision } from "../server/incident.ts";
import { LOCAL_USER } from "../shared/user.ts";

const memory = (t: TestContext) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
};

test("分类和截止时间可反向验证；三次重试跨进程持续", () => {
  assert.equal(
    classifyFailure("[400] Invalid request parameters", "provider"),
    "needsHuman",
  );
  assert.equal(
    classifyFailure("Not logged in: keychain access denied", "startup"),
    "needsHuman",
  );
  assert.equal(classifyFailure("HTTP 429 timeout", "provider"), "transient");
  assert.equal(classifyFailure("unknown error", "startup"), "needsHuman");
  const base = {
    started_at: 1000,
    category: "transient" as const,
    attempts_used: 0,
    attempt_running: false,
    notified_at: null,
    blocked: false,
  };
  assert.deepEqual(retryDecision(base, 120999, true, false), {
    state: "waiting",
    attempt: 1,
    max: 3,
    next_at: 121000,
  });
  assert.deepEqual(
    retryDecision({ ...base, attempts_used: 1 }, 700000, true, false),
    { state: "waiting", attempt: 2, max: 3, next_at: 601000 },
  );
  assert.deepEqual(
    retryDecision({ ...base, attempts_used: 3 }, 1801000, true, false),
    { state: "exhausted", attempt: 3, max: 3, next_at: null },
  );
  assert.equal(retryDecision(base, 121000, true, true).state, "needs_action");
});

test("重试持久计数、同一 eventKey 不重复、旧 pending 保留，新用户消息只准一次", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atrium-incident-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "data.db");
  let store = new Store(path);
  const agent = store.createAgent("接收者", directory).agent;
  const chat = store.createChat("用户私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "旧消息", mentions: [] });
  store.setFailure(
    agent.id,
    "HTTP 503 Service Unavailable",
    1000,
    "provider",
    "run-1",
  );
  store.setFailure(
    agent.id,
    "HTTP 503 Service Unavailable",
    1000,
    "provider",
    "run-1",
  );
  assert.equal(store.failure(agent.id)?.count, 1);
  assert.equal(store.claimRetry(agent.id, 120999), false);
  assert.equal(store.claimRetry(agent.id, 121000), true);
  assert.equal(store.claimRetry(agent.id, 121000), false);
  store.setFailure(
    agent.id,
    "HTTP 503 Service Unavailable",
    121001,
    "provider",
    "run-2",
  );
  assert.equal(store.incident(agent.id)?.attempts_used, 1);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.retryStatus(agent.id, 200000)?.retry.attempt, 2);
  const next = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "新消息",
    mentions: [],
  });
  assert.equal(store.userAttemptDue(agent.id), next.id);
  assert.equal(store.claimUserAttempt(agent.id, next.id), true);
  assert.equal(store.userAttemptDue(agent.id), null);
});

test("重启时遗留旧进程 running 不重放，保留事件并转人工", (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "atrium-orphan-")), "store.db");
  t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
  let store = new Store(path);
  const agent = store.createAgent("遗留", tmpdir()).agent;
  const chat = store.createChat("遗留群", [agent.id]);
  store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "请处理",
    mentions: [agent.id],
  });
  store.setFailure(agent.id, "HTTP 503", 1000, "provider", "run-1");
  assert.equal(store.claimRetry(agent.id, 121000, "old-process"), true);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  store.guardOrphanRetry(agent.id, "new-process");
  assert.equal(store.retryStatus(agent.id)?.retry.state, "needs_action");
  assert.equal(store.incident(agent.id)?.attempts_used, 1);
  assert.equal(store.failure(agent.id)?.text, "HTTP 503");
});

test("用户群里仍在等则写群系统消息，Agent 发起者消息箱同轮一次，恢复同一批收件人", (t) => {
  const store = memory(t);
  const failed = store.createAgent("米芙", tmpdir()).agent;
  const peer = store.createAgent("同事", tmpdir()).agent;
  const group = store.createChat("项目群", [failed.id, peer.id]);
  const privateChat = store.openDirect(peer.id, failed.id);
  const user = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "帮我看",
    mentions: [failed.id],
  });
  store.send(peer.id, {
    chat_id: privateChat.id,
    body: "还有任务",
    mentions: [],
  });
  const peerInboxBefore = store.boxCount(peer.id);
  store.setFailure(
    failed.id,
    "[400] Invalid request parameters",
    Date.now(),
    "provider",
    "terminal-1",
  );
  assert.equal(notifyTerminal(store, failed.id), true);
  assert.equal(notifyTerminal(store, failed.id), false);
  const system = store
    .timeline(group.id)
    .items.filter((m) => m.sender === "system");
  assert.equal(system.length, 1);
  assert.equal(system[0].sender_name, "系统");
  assert.equal(system[0].subject_agent_id, failed.id);
  assert.match(system[0].body, /atrium new-session/);
  assert.equal(store.boxCount(peer.id), peerInboxBefore + 1);
  assert.equal(
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM incident_notices WHERE incident_id=?",
      store.incident(failed.id)!.id,
    )?.n,
    2,
  );
  assert.equal(store.userAttemptDue(failed.id), null); // 先前消息不能绕过永久失败。
  store.finishTurn(failed.id, true, Date.now());
  assert.equal(
    store.timeline(group.id).items.filter((m) => m.sender === "system").length,
    2,
  );
  assert.equal(store.boxCount(peer.id), peerInboxBefore + 2);
  assert.equal(store.failure(failed.id), null);
  assert.equal(store.incident(failed.id), null);
  assert.equal(
    store.one<{ id: number }>("SELECT id FROM messages WHERE id=?", user.id)
      ?.id,
    user.id,
  );
});

test("同伴发送回执只警示本条需要处理的 direct；client_id 重发按当前状态重算", (t) => {
  const store = memory(t);
  const failed = store.createAgent("故障身份", tmpdir()).agent;
  const sender = store.createAgent("发信人", tmpdir()).agent;
  const other = store.createAgent("普通身份", tmpdir()).agent;
  const chat = store.createChat("项目群", [sender.id, failed.id, other.id]);
  const quiet = store.send(sender.id, {
    chat_id: chat.id,
    body: "未点名",
    mentions: [],
    client_id: "quiet",
  });
  assert.equal(store.deliveryNotice(quiet.id), undefined);
  store.setFailure(
    failed.id,
    "[400] Invalid request parameters",
    Date.now(),
    "provider",
  );
  const sent = store.send(sender.id, {
    chat_id: chat.id,
    body: "@故障身份 来看",
    mentions: [failed.id],
    client_id: "once",
  });
  assert.match(store.deliveryNotice(sent.id)!, /消息已排队/);
  assert.equal(
    store.send(sender.id, {
      chat_id: chat.id,
      body: "@故障身份 来看",
      mentions: [failed.id],
      client_id: "once",
    }).id,
    sent.id,
  );
  const delivery = store
    .pending(failed.id)
    .find((row) => row.through_message === sent.id)!;
  store.deliveryError(delivery.id, "投递结果未知：未确认");
  assert.match(store.deliveryNotice(sent.id)!, /是否送达尚待确认/);
  store.run("UPDATE deliveries SET error=NULL WHERE id=?", delivery.id);
  store.accepted(delivery.id);
  assert.match(store.deliveryNotice(sent.id)!, /是否送达尚待确认/);
  store.completeDelivery(delivery.id);
  assert.equal(store.deliveryNotice(sent.id), undefined);
  const ordinary = store.send(sender.id, {
    chat_id: chat.id,
    body: "@普通身份 请看",
    mentions: [other.id],
  });
  assert.equal(store.deliveryNotice(ordinary.id), undefined);
});

test("真实 tick：2 分钟前不唤醒，到点只 claim 一次；unknown 和永久故障不自动唤醒", async (t) => {
  const store = memory(t);
  const dir = mkdtempSync(join(tmpdir(), "atrium-retry-tick-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agent = store.createAgent("重试", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "旧消息", mentions: [] });
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
  const attempted: boolean[] = [];
  t.mock.method(
    runtimes as unknown as {
      doPump(id: string, direct: boolean): Promise<void>;
    },
    "doPump",
    async (_id: string, direct: boolean) => {
      attempted.push(direct);
    },
  );
  const tick = () => (runtimes as unknown as { tick(): Promise<void> }).tick();
  const started = Date.now();
  store.setFailure(agent.id, "HTTP 503", started, "provider");
  let now = started + 119_999;
  t.mock.method(Date, "now", () => now);
  await tick();
  assert.deepEqual(attempted, []);
  now++;
  await tick();
  await tick();
  assert.deepEqual(attempted, [true]);
  assert.equal(store.incident(agent.id)?.attempts_used, 1);
  store.setFailure(agent.id, "HTTP 503", now + 1, "provider");
  store.deliveryError(store.pending(agent.id)[0]!.id, "投递结果未知：未确认");
  now = started + 1_000_000;
  await tick();
  assert.deepEqual(attempted, [true]);
  store.clearFailure(agent.id);
  store.run("UPDATE deliveries SET error=NULL WHERE agent_id=?", agent.id);
  store.setFailure(
    agent.id,
    "[400] Invalid request parameters",
    now,
    "provider",
  );
  await tick();
  assert.deepEqual(attempted, [true]);
  const newMessage = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "我已修好，试一次",
    mentions: [],
  });
  await tick();
  await tick();
  assert.deepEqual(attempted, [true, true]);
  assert.equal(store.userAttemptDue(agent.id), null);
  assert.ok(newMessage.id > 0);
});

test("管理者为 Agent、用户仅发私聊时不误写用户系统消息；迁移前 accepted 不产生债务", (t) => {
  const store = memory(t);
  const failed = store.createAgent("失败者", tmpdir()).agent;
  const manager = store.createAgent("上级", tmpdir()).agent;
  store.setReportsTo(failed.id, manager.id);
  const chat = store.createChat("私聊", [failed.id], failed.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "旧私聊", mentions: [] });
  for (const item of store.pending(failed.id)) store.accepted(item.id);
  store.run("UPDATE deliveries SET created_at=0 WHERE agent_id=?", failed.id);
  store.setFailure(failed.id, "Not logged in", Date.now(), "startup");
  notifyTerminal(store, failed.id);
  assert.equal(
    store.timeline(chat.id).items.filter((m) => m.sender === "system").length,
    0,
  );
  assert.equal(store.boxCount(manager.id), 1);
  const notices = store.all<{ recipient: string }>(
    "SELECT recipient FROM incident_notices WHERE incident_id=?",
    store.incident(failed.id)!.id,
  );
  assert.deepEqual(
    notices.map((n) => n.recipient),
    [manager.id],
  );
});
