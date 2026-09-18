import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";

function storeFixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("Atlas", "/tmp").agent;
  const b = store.createAgent("Mira", "/tmp").agent;
  return { store, a, b };
}

test("会话归属与未读：我的私聊计数、围观会话只报动态、用户发言即未读清零", (t) => {
  const { store, a, b } = storeFixture(t);
  const direct = store.createChat("私聊", [a.id], a.id);
  const group = store.createChat("同伴群", [a.id, b.id]);
  const chats = () => store.chats();
  const directRow = () => chats().find((c) => c.id === direct.id)!;
  const groupRow = () => chats().find((c) => c.id === group.id)!;
  assert.equal(directRow().mine, true);
  assert.equal(groupRow().mine, false, "Agent 自建的群不属于我");
  assert.equal(directRow().unread, 0);
  store.send(a.id, { chat_id: direct.id, body: "你好", mentions: [] });
  store.send(a.id, { chat_id: group.id, body: "进展", mentions: [] });
  assert.equal(directRow().unread, 1);
  assert.equal(groupRow().unread, 1, "围观会话也上报未读，界面决定呈现为点");
  // 打开会话读到最新后清零；再来的消息重新计数
  store.markUserRead(direct.id, 999999);
  assert.equal(directRow().unread, 0);
  store.send(a.id, { chat_id: direct.id, body: "在吗", mentions: [] });
  assert.equal(directRow().unread, 1);
  // 用户在围观会话里发言（可插话）：自己的发言不产生未读
  const mine = store.send("user", {
    chat_id: group.id,
    body: "插一句",
    mentions: [],
  });
  store.markUserRead(group.id, mine.id);
  assert.equal(groupRow().unread, 0);
  // 已读水位不回退
  store.markUserRead(direct.id, 1);
  assert.equal(directRow().unread, 1, "低于已读水位不改变计数");
});

test("已读接口：短号解析、单调推进、越过最新消息截断", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-reads-"));
  const { app, store } = await createApp({
    data,
    runtime: false,
    desktops: join(data, "desktops"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const agent = store.createAgent("Atlas", "/tmp").agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  const read = (ref: string, through: unknown) =>
    fetch(`${origin}/api/chats/${ref}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ through }),
    });
  assert.equal((await read("c999", 1)).status, 404, "未知短号");
  assert.equal((await read(chat.ref, -1)).status, 400, "负序号非法");
  assert.equal((await read(chat.ref, "x")).status, 400);
  const m1 = store.send(agent.id, { chat_id: chat.id, body: "一", mentions: [] });
  const m2 = store.send(agent.id, { chat_id: chat.id, body: "二", mentions: [] });
  assert.equal((await read(chat.ref, m1.id)).status, 200);
  assert.equal(
    store.chats().find((c) => c.id === chat.id)!.unread,
    1,
    "只读到第一条",
  );
  // 越过最新消息：截断到最后一条
  assert.equal((await read(chat.ref, m2.id + 100)).status, 200);
  assert.equal(store.chats().find((c) => c.id === chat.id)!.unread, 0);
  // UUID 同样可用
  assert.equal((await read(chat.id, m2.id)).status, 200);
  // 推进后回执里出现「你」
  const state = store.readState(chat.id, 0);
  assert(state.some((s) => s.agent_id === "user"), "回执含用户已读");
});

test("围观会话：用户不是成员仍可发言，投递给成员", (t) => {
  const { store, a, b } = storeFixture(t);
  const group = store.createChat("同伴群", [a.id, b.id]);
  const sent = store.send("user", {
    chat_id: group.id,
    body: "我是围观者",
    mentions: [],
  });
  assert(
    store.timeline(group.id).items.some((m) => m.id === sent.id),
    "用户插话进入群内时间线",
  );
  assert.equal(
    store.chats().find((c) => c.id === group.id)!.mine,
    true,
    "插话后视为我参与的会话，不再是纯围观",
  );
});
