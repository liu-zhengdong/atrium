import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../server/store.ts";
import { createMcp } from "../server/mcp.ts";
import { LOCAL_USER } from "../shared/user.ts";

async function harness(t: { after: (fn: () => unknown) => void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const [a, b, c] = ["Atlas", "Borealis", "Cedar"].map(
    (name) => store.createAgent(name, tmpdir()).agent,
  );
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createMcp(store, a.id, () => {});
  await server.connect(serverSide);
  const client = new Client({ name: "search-test", version: "1" });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const search = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "search_messages",
      arguments: args,
    });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  const refused = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: "search_messages", arguments: args }))
      .isError;
  const say = (sender: string, chatId: string, body: string) =>
    store.send(sender, { chat_id: chatId, body, mentions: [] });
  return { store, a, b, c, search, refused, say };
}

test("search_messages 只搜自己所在的会话；按会话、发送者过滤；不改已读", async (t) => {
  const { store, a, b, c, search, refused, say } = await harness(t);
  const mine = store.createChat("移植调研", [a.id, b.id]);
  const other = store.createChat("另一个群", [a.id, c.id]);
  const outside = store.createChat("不带 Atlas", [b.id, c.id]);
  say(b.id, mine.id, "PR #409 在 Windows 上验证过");
  say(c.id, other.id, "pr 409 不能写成我们验证");
  say(b.id, outside.id, "PR #409 这条 Atlas 不该看到");
  say(LOCAL_USER, mine.id, "409 这个 PR 先放着");
  say(
    a.id,
    mine.id,
    `${"铺垫".repeat(1500)} 关键段落：PR #409 的结论 ${"收尾".repeat(200)}`,
  );
  const unread = JSON.stringify(store.unread(a.id));

  const hits = await search({ query: "pr 409" });
  assert.deepEqual(
    hits.items.map((i: { sender: string }) => i.sender),
    [a.ref, LOCAL_USER, c.ref, b.ref],
    "空格分开的词都要出现，英文不分大小写，新的在前；不在的群搜不到",
  );
  assert.equal(hits.has_more, false);
  const long = hits.items[0];
  assert.equal(long.chat_id, mine.ref);
  assert.match(long.excerpt, /^…铺垫.*关键段落：PR #409 的结论.*…$/);
  assert(long.excerpt.length < 200, "长消息只给命中附近的一段");
  assert.equal(hits.items[1].sender_name, "用户");

  assert.deepEqual(
    (await search({ query: "409", chat_id: other.ref })).items.map(
      (i: { chat_id: string }) => i.chat_id,
    ),
    [other.ref],
  );
  assert(
    await refused({ query: "409", chat_id: outside.ref }),
    "不在的群直接拒绝",
  );
  assert.deepEqual(
    (await search({ query: "409", sender: a.ref })).items.map(
      (i: { sender: string }) => i.sender,
    ),
    [a.ref],
    "可以只搜自己发过的",
  );
  assert.deepEqual(
    (await search({ query: "409", sender: "u1" })).items.map(
      (i: { sender: string }) => i.sender,
    ),
    [LOCAL_USER],
  );
  for (const bad of [
    { query: " " },
    { query: "409", sender: "u999" },
    { query: "x".repeat(101) },
  ])
    assert(await refused(bad), JSON.stringify(bad));
  assert.equal(JSON.stringify(store.unread(a.id)), unread, "搜索不改已读");
});

test("search_messages 按编号往前翻页不重不漏；% 和 _ 按字面匹配", async (t) => {
  const { store, a, b, search, say } = await harness(t);
  const chat = store.createChat("批量", [a.id, b.id]);
  const ids = Array.from(
    { length: 12 },
    (_, n) => say(b.id, chat.id, `第 ${n} 份周报`).id,
  ).reverse();
  const seen: number[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await search({
      query: "周报",
      limit: 5,
      ...(before ? { before } : {}),
    });
    seen.push(...page.items.map((i: { message_id: number }) => i.message_id));
    if (!page.has_more) break;
    before = page.next_before;
  }
  assert.deepEqual(seen, ids);
  say(b.id, chat.id, "完成 100%");
  say(b.id, chat.id, "完成 100 件");
  say(b.id, chat.id, "写成 a_b");
  say(b.id, chat.id, "写成 axb");
  assert.deepEqual(
    (await search({ query: "100%" })).items.map(
      (i: { excerpt: string }) => i.excerpt,
    ),
    ["完成 100%"],
  );
  assert.equal((await search({ query: "a_b" })).items.length, 1);
});

test("用户搜索按全部成员的名字找会话，不止前 4 位", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const agents = ["Atlas", "Borealis", "Cedar", "Dune", "Ember"].map(
    (name) => store.createAgent(name, tmpdir()).agent,
  );
  const group = store.createChat(
    "五人群",
    agents.map((agent) => agent.id),
  );
  assert.deepEqual(
    store.search("ember").chats.map((chat) => chat.id),
    [group.id],
  );
});
