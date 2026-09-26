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
    ["notice"],
    "没有立即投递，只有排队等搭车的告知",
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
