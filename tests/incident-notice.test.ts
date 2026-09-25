import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import { instruction, notifyTerminal } from "../server/incident-notice.ts";
import { messageRecords } from "../server/records.ts";
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
  assert.equal(classifyFailure("unknown error", "startup"), "transient");
  const base = {
    started_at: 1000,
    category: "transient" as const,
    attempts_used: 0,
    attempt_running: false,
    attempt_claimed_at: null,
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
  assert.deepEqual(
    retryDecision(
      { ...base, attempts_used: 1, attempt_running: true },
      121000,
      false,
      false,
    ),
    {
      state: "running",
      attempt: 1,
      max: 3,
      next_at: null,
    },
  );
});

test("真实 Pi/bridge 错误原文：未知有界重试，仅明确拒绝需人工", () => {
  for (const error of [
    "fetch failed",
    "WebSocket closed 1012",
    "terminated",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "socket hang up",
    "500 Internal Server Error",
    "503 status code (no body)",
    "502 Bad Gateway",
    '503: {"message":"Service Unavailable"}',
    "Connection error.",
    "Provider stream timeout",
    "429 rate limit",
    "529 overloaded",
    "[503] Server Error",
    "some new bridge error",
  ])
    assert.equal(classifyFailure(error, "provider"), "transient", error);
  for (const error of [
    "[400] Invalid request parameters",
    "Not logged in: keychain access denied",
    "401 Unauthorized",
    "403 5-hour usage limit",
    "Codex usage limit",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "Model authentication failed",
    "Model not found: demo",
    "Thinking level not supported by the current model",
    "未分配账号",
    "投递结果未知：应答中断",
  ])
    assert.equal(classifyFailure(error, "provider"), "needsHuman", error);
  assert.equal(classifyFailure("fetch failed", "startup"), "transient");
  assert.equal(classifyFailure("429 rate limit", "delivery"), "transient");
  assert.equal(
    classifyFailure("Authentication required", "startup"),
    "needsHuman",
  );
  assert.equal(
    classifyFailure(
      "arbitrary launch text",
      "startup",
      "launch_secret_unsupported",
    ),
    "needsHuman",
  );
  assert.equal(
    classifyFailure("arbitrary launch text", "startup"),
    "transient",
  );
});

test("真实错误原文给正确的下一步，而非把 API Key/额度当钥匙串", () => {
  for (const text of [
    "[400] Invalid request parameters",
    '400: {"message":"Invalid request parameters"}',
  ])
    assert.match(instruction(text, "a2"), /atrium new-session a2/);
  assert.match(
    instruction("401 Unauthorized: Invalid API Key", "a2"),
    /更换 API Key/,
  );
  assert.match(
    instruction("模型认证失败，请更换 API Key", "a2"),
    /更换 API Key/,
  );
  assert.match(
    instruction("403 You have reached your 5-hour usage limit", "a2"),
    /等额度恢复/,
  );
  assert.match(
    instruction("Not logged in: keychain access denied", "a2"),
    /允许钥匙串访问/,
  );
});

test("in-flight accepted direct is not a terminal incident or an auto retry", (t) => {
  const store = memory(t);
  const agent = store.createAgent("等待回应", tmpdir()).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "还在吗", mentions: [] });
  store.setFailure(agent.id, "Connection error.", Date.now(), "provider");
  store.accepted(store.pending(agent.id)[0]!.id);
  assert.equal(store.retryStatus(agent.id)?.retry, undefined);
  assert.equal(notifyTerminal(store, agent.id), false);
  assert.equal(store.incident(agent.id)?.notified_at, null);
  store.finishTurn(agent.id, false);
  assert.equal(store.retryStatus(agent.id)?.retry?.state, "waiting");
  assert.equal(notifyTerminal(store, agent.id), false);
});

test("瞬态故障没有待重试 direct 不谎称已经三次自动重试", (t) => {
  const store = memory(t);
  const agent = store.createAgent("空载", tmpdir()).agent;
  store.setFailure(agent.id, "HTTP 503", Date.now(), "provider");
  assert.equal(notifyTerminal(store, agent.id), true);
  const message = store.one<{ body: string }>(
    "SELECT body FROM messages WHERE sender='system' ORDER BY id DESC LIMIT 1",
  );
  assert.match(message!.body, /需要处理/);
  assert.doesNotMatch(message!.body, /已自动重试 3 次/);
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
  assert.equal(store.retryStatus(agent.id, 200000)?.retry?.attempt, 2);
  const next = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "新消息",
    mentions: [],
  });
  assert.equal(store.userAttemptDue(agent.id), next.id);
  assert.equal(store.claimUserAttempt(agent.id, next.id), true);
  assert.equal(store.userAttemptDue(agent.id), null);
});

test("停服 40 分钟后只补一次；后续快速失败分别隔 8/20 分钟，第三次最终通知", (t) => {
  const store = memory(t);
  const agent = store.createAgent("逾期身份", tmpdir()).agent;
  const chat = store.createChat("测试群", [agent.id]);
  store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "开始",
    mentions: [agent.id],
  });
  const firstAt = 1000;
  store.setFailure(agent.id, "HTTP 503", firstAt, "provider", "first");
  const restoredAt = firstAt + 40 * 60_000;
  assert.equal(store.claimRetry(agent.id, restoredAt), true);
  store.setFailure(agent.id, "HTTP 503", restoredAt + 1, "provider", "second");
  const next = restoredAt + 8 * 60_000;
  assert.equal(
    store.retryStatus(agent.id, restoredAt + 1)?.retry?.next_at,
    next,
  );
  assert.equal(store.claimRetry(agent.id, next - 1), false);
  assert.equal(store.claimRetry(agent.id, next), true);
  store.setFailure(agent.id, "HTTP 503", next + 1, "provider", "third");
  const last = next + 20 * 60_000;
  assert.equal(store.retryStatus(agent.id, next + 1)?.retry?.next_at, last);
  assert.equal(store.claimRetry(agent.id, last - 1), false);
  assert.equal(store.claimRetry(agent.id, last), true);
  store.setFailure(agent.id, "HTTP 503", last + 1, "provider", "fourth");
  assert.equal(store.retryStatus(agent.id)?.retry?.state, "exhausted");
  assert.equal(notifyTerminal(store, agent.id), true);
  assert.match(
    store.one<{ body: string }>(
      "SELECT body FROM messages WHERE sender='system' ORDER BY id DESC LIMIT 1",
    )!.body,
    /已自动重试 3 次/,
  );
  assert.equal(notifyTerminal(store, agent.id), false);
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
  assert.equal(store.retryStatus(agent.id)?.retry?.state, "needs_action");
  assert.equal(store.incident(agent.id)?.attempts_used, 1);
  assert.equal(store.failure(agent.id)?.text, "HTTP 503");
});

test("保留自动重试的运行预留仅在投递被确认时成立；未启动则阻断并留原消息", (t) => {
  const store = memory(t);
  const unsent = store.createAgent("未启动", tmpdir()).agent;
  const accepted = store.createAgent("已接收", tmpdir()).agent;
  const chat = store.createChat("测试群", [unsent.id, accepted.id]);
  store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "开始",
    mentions: [unsent.id, accepted.id],
  });
  const now = Date.now();
  for (const id of [unsent.id, accepted.id]) {
    store.setFailure(id, "HTTP 503", now - 120_000, "provider");
    assert.equal(store.claimRetry(id, now, "worker-a"), true);
  }
  store.blockUnstartedRetry(unsent.id, "worker-a");
  assert.equal(store.retryStatus(unsent.id)?.retry?.state, "needs_action");
  assert.equal(store.incident(unsent.id)?.attempts_used, 0);
  assert.equal(store.pending(unsent.id).length, 1);
  store.accepted(store.pending(accepted.id)[0]!.id);
  store.blockUnstartedRetry(accepted.id, "worker-a");
  assert.equal(store.incident(accepted.id)?.attempt_running, true);
  assert.equal(store.incident(accepted.id)?.attempts_used, 1);
  assert.equal(store.retryStatus(accepted.id)?.retry?.state, "running");
  store.finishTurn(accepted.id, false);
  assert.equal(store.retryStatus(accepted.id)?.retry?.state, "needs_action");
  assert.equal(store.pending(accepted.id).length, 1);
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
  const record = messageRecords(store, { q: "米芙运行出错" }).items[0];
  assert.equal(record.subject_agent_id, failed.id);
  assert.equal(record.sender_name, "系统");
  assert.equal(
    store.search("米芙运行出错").messages[0].subject_agent_id,
    failed.id,
  );
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
  const selected: Array<number | undefined> = [];
  t.mock.method(
    runtimes as unknown as {
      doPump(id: string, direct: boolean): Promise<void>;
    },
    "doPump",
    async (_id: string, direct: boolean) => {
      attempted.push(direct);
      selected.push(
        (
          runtimes as unknown as { userAttempt: Map<string, number> }
        ).userAttempt.get(_id),
      );
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
  // This fake pump did not acknowledge a delivery: release the reservation and block.
  assert.equal(store.incident(agent.id)?.attempts_used, 0);
  assert.equal(store.incident(agent.id)?.blocked, true);
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
  assert.deepEqual(selected, [undefined, newMessage.id]);
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
