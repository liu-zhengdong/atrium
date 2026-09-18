import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.ts";
import type { ChatReadState } from "../shared/schema.ts";

function hasRead(state: ChatReadState, id: number) {
  return (
    id <= state.through ||
    state.ranges.some((r) => id >= r.first && id <= r.last)
  );
}
function fixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("Atlas", "/tmp").agent;
  const b = store.createAgent("Mira", "/tmp").agent;
  const chat = store.createChat("回执", [a.id, b.id]);
  const send = (body: string, chatId = chat.id) =>
    store.send("user", { chat_id: chatId, body, mentions: [] });
  const state = (agent = a.id) =>
    store.readState(chat.id, 0).find((s) => s.agent_id === agent)!;
  return { store, a, b, chat, send, state };
}

test("回执仅覆盖真实返回页；隔离 Agent、通知、投递与用户审阅", (t) => {
  const { store, a, b, chat, send, state } = fixture(t);
  const one = send("一"),
    two = send("二");
  store.timeline(chat.id);
  store.configure(a.id, { message_threshold: 1 });
  store.schedule(Date.now());
  store.box(a.id, 0, true, true);
  assert(!hasRead(state(), one.id));
  assert(!hasRead(state(), two.id));
  store.readChat(a.id, chat.id, undefined, 1);
  assert(hasRead(state(), one.id));
  assert(!hasRead(state(), two.id));
  assert(!hasRead(state(b.id), one.id));
  const other = store.createChat("私聊", [b.id], b.id);
  assert.throws(() => store.readChat(a.id, other.id), /只能访问/);
  assert(!hasRead(state(b.id), one.id));
});

test("跳读、跨群 ID 和重叠读取准确合并；不越过未读缺口", (t) => {
  const { store, a, chat, send, state } = fixture(t);
  const other = store.createChat("另一群", [a.id]);
  const messages = [];
  for (let i = 0; i < 8; i++) {
    messages.push(send(`消息 ${i}`));
    send("其他群", other.id);
  }
  store.readChat(a.id, chat.id, messages[1].id, 2);
  assert.equal(state().through, 0);
  assert.deepEqual(
    messages.map((m) => hasRead(state(), m.id)),
    [false, false, true, true, false, false, false, false],
  );
  store.readChat(a.id, chat.id, messages[3].id, 2);
  assert.equal(state().ranges.length, 1, "跨群 ID 不阻碍相邻页压缩");
  store.readChat(a.id, chat.id, messages[2].id, 2);
  assert.equal(state().ranges.length, 1, "重叠读取不重复存储");
  store.readChat(a.id, chat.id, undefined, 1);
  assert.equal(state().through, messages[0].id);
  assert(!hasRead(state(), messages[1].id));
  store.readChat(a.id, chat.id, undefined, 1);
  assert.equal(state().through, messages[5].id);
  assert.equal(state().ranges.length, 0, "缺口补齐后回收例外范围");
  assert.equal(store.unread(a.id).find((c) => c.chat_id === chat.id)?.count, 2);
  store.readChat(a.id, chat.id, 0, 1);
  assert.equal(state().through, messages[5].id, "重读历史不回退");
});

test("字节截断不误标下一条；历史页和实时快照覆盖已加载窗口", (t) => {
  const { store, a, chat, send, state } = fixture(t);
  const messages = Array.from({ length: 60 }, () => send("字".repeat(6000)));
  const read = store.readChat(a.id, chat.id, undefined, 30);
  assert.equal(read.items.length, 1);
  assert(hasRead(state(), messages[0].id));
  assert(!hasRead(state(), messages[1].id));
  store.readChat(a.id, chat.id, messages[4].id, 1);
  assert.equal(
    store.timeline(chat.id).read_state.find((s) => s.agent_id === a.id)!.ranges
      .length,
    0,
    "默认只传可见页的跳读范围",
  );
  const older = store.timeline(chat.id, messages[10].id);
  assert(
    hasRead(
      older.read_state.find((s) => s.agent_id === a.id)!,
      messages[5].id,
    ),
  );
  const refresh = store.timeline(chat.id, undefined, messages[0].id);
  assert(
    hasRead(
      refresh.read_state.find((s) => s.agent_id === a.id)!,
      messages[5].id,
    ),
    "实时刷新保留已加载历史回执",
  );
});

test("随机分页反向核对逐条真值；压缩回执不多标或漏标", (t) => {
  const { store, a, chat, send, state } = fixture(t);
  const messages = Array.from({ length: 200 }, (_, i) => send(`消息 ${i}`));
  const seen = new Set<number>();
  let seed = 19;
  for (let i = 0; i < 100; i++) {
    seed = (seed * 16807) % 2147483647;
    const page = store.readChat(
      a.id,
      chat.id,
      messages[seed % 200].id,
      1 + (seed % 15),
    );
    for (const message of page.items) seen.add(message.id);
    for (const message of messages)
      assert.equal(hasRead(state(), message.id), seen.has(message.id));
    assert.equal(store.unread(a.id)[0]?.count ?? 0, 200 - seen.size);
  }
});

test("ACP 直投确认注入即标记已读：私聊连续推进、群聊 @ 跳读保留缺口与反向破坏验证", (t) => {
  const { store, a, b, chat, send, state } = fixture(t);
  const dm = store.createChat("私聊", [a.id], a.id);

  // 1. 私聊直投：pending 时未读，ACP accepted 后即标记已读，消除重复未读提醒
  const dmMsg = store.send("user", {
    chat_id: dm.id,
    body: "你好私聊",
    mentions: [],
  });
  const dmState = () =>
    store.readState(dm.id, 0).find((s) => s.agent_id === a.id)!;
  const pendingDirect = store
    .pending(a.id)
    .filter((d) => d.kind === "direct" && d.through_message === dmMsg.id);
  assert.equal(pendingDirect.length, 1);
  assert(!hasRead(dmState(), dmMsg.id), "ACP 确认前处于 pending，仍为未读");
  assert.equal(store.unread(a.id).find((c) => c.chat_id === dm.id)?.count, 1);

  // 模拟 ACP runtime deliver 成功确认 accepted
  store.accepted(pendingDirect[0].id);
  assert(hasRead(dmState(), dmMsg.id), "ACP accepted 确认注入后立即成为已读");
  assert.equal(dmState().through, dmMsg.id);
  assert.equal(store.unread(a.id).find((c) => c.chat_id === dm.id), undefined);

  // 此时 schedule 不应产生多余的未读提醒
  store.configure(a.id, { message_threshold: 1 });
  const woke = store.schedule(Date.now() + 301000);
  assert(!woke.includes(a.id), "已读后不会在后台产生骚扰未读提醒");

  // 2. 群聊明确提及（@）：保留前置未读缺口，ACP accepted 仅标当前消息
  const m1 = send("群聊普通消息 1");
  const m2 = send("群聊普通消息 2");
  const m3 = store.send("user", {
    chat_id: chat.id,
    body: "@Atlas 来看这条",
    mentions: [a.id],
  });
  const m3Delivery = store
    .pending(a.id)
    .find((d) => d.kind === "direct" && d.through_message === m3.id)!;
  assert(m3Delivery, "明确提及产生 direct delivery");

  // accepted 前 m1, m2, m3 均未读
  assert(!hasRead(state(), m1.id));
  assert(!hasRead(state(), m2.id));
  assert(!hasRead(state(), m3.id));

  // 模拟 ACP accepted
  store.accepted(m3Delivery.id);
  assert(hasRead(state(), m3.id), "@ 消息经 ACP 确认注入后成为已读");
  assert(!hasRead(state(), m1.id), "前序未直投普通消息依然未读");
  assert(!hasRead(state(), m2.id), "前序未直投普通消息依然未读");
  assert.equal(state().through, 0, "存在未读缺口时不越过 through");
  assert.equal(state().ranges.length, 1, "记录在跳读范围中");
  assert.equal(
    store.unread(a.id).find((c) => c.chat_id === chat.id)?.count,
    2,
    "未读数准确反映剩余 2 条缺口",
  );

  // 后续 readChat 读完前置消息，缺口消除并合并
  store.readChat(a.id, chat.id, undefined, 2);
  assert.equal(state().through, m3.id, "补齐缺口后 through 推进到最新已读");
  assert.equal(state().ranges.length, 0, "例外跳读范围已清理");
  assert.equal(store.unread(a.id).find((c) => c.chat_id === chat.id), undefined);

  // 3. 反向破坏验证
  // 破坏 A：summary 类型的 delivery 被 accepted 时，绝不能误标任何聊天
  const otherMsg = send("另一条普通消息");
  store.schedule(Date.now() + 602000);
  const summaryDelivery = store
    .pending(a.id)
    .find((d) => d.kind === "summary");
  assert(summaryDelivery, "产生了 summary delivery");
  assert(!hasRead(state(), otherMsg.id));
  store.accepted(summaryDelivery.id);
  assert(!hasRead(state(), otherMsg.id), "summary delivery accepted 不会把消息标为已读");

  // 破坏 B：deliveryError 保持未读
  const mErr = store.send("user", {
    chat_id: dm.id,
    body: "投递失败消息",
    mentions: [],
  });
  const errDelivery = store
    .pending(a.id)
    .find((d) => d.kind === "direct" && d.through_message === mErr.id)!;
  store.deliveryError(errDelivery.id, "Connection refused");
  assert(!hasRead(dmState(), mErr.id), "投递失败的消息绝不标为已读");

  // 破坏 C：幂等性与重复 accepted 不破坏已读状态
  store.accepted(pendingDirect[0].id);
  assert.equal(dmState().through, dmMsg.id);
});
