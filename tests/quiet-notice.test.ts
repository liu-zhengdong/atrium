import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Store } from "../server/store.ts";
import { mergeNotices, wakesOffline } from "../server/delivery.ts";
import { LOCAL_USER } from "../shared/user.ts";
import { Problem } from "../server/problem.ts";

test("纯告知：不叫醒、不提醒，搭下一次投递一起交", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const mira = store.createAgent("Mira", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id, mira.id]);

  const quiet = store.send(atlas.id, {
    chat_id: group.id,
    body: "收到，开始做",
    mentions: [],
    quiet: true,
  });
  assert.equal(quiet.quiet, true, "消息本身留在聊天里");

  assert.equal(store.boxCount(mira.id), 0, "纯告知不进消息箱");
  assert.deepEqual(
    store.pending(mira.id).map((item) => item.kind),
    [],
    "不单独成行，也不占投递窗口",
  );
  assert.deepEqual(
    store.notices(mira.id).map((item) => item.text),
    [
      `- ${store.chatRef(group.id)}「协作群」#${quiet.id} ${store.agentRef(atlas.id)}（Atlas）：收到，开始做`,
    ],
    "排队等搭车，正文只留摘要",
  );
  assert.equal(store.notices(atlas.id).length, 0, "发送者自己不收自己的告知");

  // 搭下一次真正的投递一起走：合成一段附在正文后面。
  const direct = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "看一下 #1",
    mentions: [mira.id],
  });
  const pending = store
    .pending(mira.id)
    .filter((item) => item.kind === "direct");
  assert.equal(pending.length, 1);
  const merged = mergeNotices(
    pending[0].text,
    store.notices(mira.id).map((item) => item.text),
  );
  assert.ok(
    merged.indexOf("看一下 #1") < merged.indexOf("无需回复"),
    "正文在前、告知在后",
  );
  assert.match(merged, /\[Atrium 告知 · 无需回复\]/);
  assert.match(merged, /收到，开始做/, "告知内容一并交给对方");

  // 交付成功即算送达，下一趟不再重复附带。
  store.accepted(
    pending[0].id,
    false,
    store.notices(mira.id).map((i) => i.id),
  );
  assert.deepEqual(store.notices(mira.id), []);
  assert.equal(store.boxCount(mira.id), 0, "点名是直接投递，本来就不进消息箱");

  // 结果未知时不删：重试那一趟再把告知带上。
  store.send(atlas.id, {
    chat_id: group.id,
    body: "做完了",
    mentions: [],
    quiet: true,
  });
  const retry = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "再看一眼",
    mentions: [mira.id],
  });
  const retryPending = store
    .pending(mira.id)
    .filter((item) => item.kind === "direct")
    .at(-1)!;
  store.accepted(
    retryPending.id,
    true,
    store.notices(mira.id).map((i) => i.id),
  );
  assert.equal(store.notices(mira.id).length, 1, "未知结果保留告知");
  assert.equal(
    store
      .readChat(mira.id, group.id, 0, 10, true)
      .items.some((message) => message.id === retry.id),
    true,
    "消息本身照常可读",
  );
});

test("纯告知积压再多也不挡后面的直接投递", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const mira = store.createAgent("Mira", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id, mira.id]);

  // 告知一直排队等搭车，没有车就一直攒着。
  for (let i = 0; i < 120; i++)
    store.send(atlas.id, {
      chat_id: group.id,
      body: `进展 ${i}`,
      mentions: [],
      quiet: true,
    });
  assert.equal(store.notices(mira.id).length, 20, "搭车一次最多带 20 条");
  assert.equal(
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=? AND kind='notice' AND state='pending'",
      mira.id,
    )!.n,
    120,
    "告知都还在排队，不会被丢",
  );

  // 用户点名 Mira：这条直接投递必须取得到，离线时也叫得醒。
  const direct = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "轮到你了",
    mentions: [mira.id],
  });
  const pending = store.pending(mira.id);
  assert.deepEqual(
    pending.map((item) => item.kind),
    ["direct"],
    "积压的告知不占投递窗口",
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0].through_message, direct.id, "就是用户这条点名");
  assert.equal(wakesOffline(pending), true, "点名要叫醒离线身份");
});

test("纯告知：用户不发、离线不唤醒", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id]);

  assert.throws(
    () =>
      store.send(LOCAL_USER, {
        chat_id: group.id,
        body: "这是纯告知",
        mentions: [],
        quiet: true,
      }),
    (error: unknown) => error instanceof Problem && error.statusCode === 403,
    "用户没有纯告知这个动作",
  );
  assert.equal(wakesOffline([{ kind: "notice" }]), false);
  assert.equal(store.boxCount(atlas.id), 0);
});
