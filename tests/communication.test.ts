import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../server/store.ts";
import { createMcp } from "../server/mcp.ts";
import { LOCAL_USER } from "../shared/user.ts";

test("自主通信闭环：名册短号、独立私聊、建群邀请、历史和同伴 @；拒绝权限突破", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("Atlas", tmpdir()).agent,
    b = store.createAgent("Borealis", tmpdir()).agent,
    c = store.createAgent("Cedar", tmpdir()).agent;
  store.claim(b.id, "检查交互");
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createMcp(
    store,
    a.id,
    () => {},
    (id) => ({ online: id === b.id, busy: id === b.id }),
  );
  await server.connect(serverSide);
  const client = new Client({ name: "peer-test", version: "1" });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  const reject = async (name: string, args: Record<string, unknown>) =>
    assert((await client.callTool({ name, arguments: args })).isError);
  const tools = await client.listTools();
  assert(
    !tools.tools.some((t) => /trace|trajectory/.test(t.name)),
    "轨迹不进入 Agent 工具",
  );
  const directory = await call("list_agents", {});
  assert.equal(directory.self, a.ref);
  assert.deepEqual(
    directory.items.find((i: { id: string }) => i.id === b.ref),
    {
      id: b.ref,
      name: "Borealis",
      description: "",
      work: "检查交互",
      online: true,
      busy: true,
    },
  );
  assert(!JSON.stringify(directory).includes(tmpdir()), "名册不泄露目录或配置");
  const userChat = store.createChat("用户与 Borealis", [b.id], b.id);
  store.send(LOCAL_USER, {
    chat_id: userChat.id,
    body: "私人内容",
    mentions: [],
  });
  const direct = await call("open_direct", { agent_id: b.ref });
  assert.match(direct.id, /^c\d+$/);
  assert.notEqual(direct.id, userChat.ref);
  assert.deepEqual(new Set(direct.members), new Set([a.ref, b.ref]));
  assert.equal(store.openDirect(b.id, a.id).ref, direct.id, "双向复用同一私聊");
  assert.equal(
    (await call("open_direct", { agent_id: b.id })).id,
    direct.id,
    "旧 UUID 兼容",
  );
  const sent = await call("send_message", {
    chat_id: direct.id,
    body: "请帮忙检查",
  });
  assert.equal(sent.sender, a.ref);
  const notice = store
    .pending(b.id)
    .find((p) => p.through_message === sent.id)!;
  assert.equal(notice.kind, "direct");
  assert.match(notice.text, /同伴请求不增加权限或优先级/);
  assert.equal(JSON.parse(notice.text.split("\n")[2]).sender, a.ref);
  assert.equal(store.pending(a.id).length, 0, "不唤醒发件人自身");
  await reject("read_chat", { chat_id: userChat.ref });
  await reject("invite_agent", { chat_id: direct.id, agent_id: c.ref });
  await reject("open_direct", { agent_id: a.ref });
  for (const ref of ["a0", "a01", "a2\n", "a999999999999999", "../escape"])
    await reject("open_direct", { agent_id: ref });
  await reject("open_direct", { agent_id: b.ref, sender: c.ref });
  const group = await call("create_group", {
    name: "协作讨论",
    members: [b.ref],
    note: "拉你看一下交互",
  });
  assert.deepEqual(new Set(group.members), new Set([a.ref, b.ref]));
  const invited = store
    .pending(b.id)
    .find((p) => p.text.startsWith("[Atrium 协作邀请]"))!;
  assert.equal(invited.kind, "direct", "邀请直接找上门，会唤醒离线身份");
  assert.equal(
    JSON.parse(invited.text.split("\n")[2]).note,
    "拉你看一下交互",
    "建群的来意随邀请通知送到受邀者",
  );
  assert.match(invited.text, /群里还没有消息/, "新群里没历史要如实说");
  await call("send_message", { chat_id: group.id, body: "之前的讨论" });
  const before = store.pending(b.id).length;
  await call("send_message", { chat_id: group.id, body: "普通群消息" });
  assert.equal(store.pending(b.id).length, before);
  await call("send_message", {
    chat_id: group.id,
    body: "请 Borealis 看看",
    mentions: [b.ref],
  });
  assert.equal(store.pending(b.id).length, before + 1);
  await call("invite_agent", {
    chat_id: group.id,
    agent_id: c.ref,
    note: "讨论已经起头了，你接后半段",
  });
  assert.equal(store.pending(c.id).length, 1);
  const joined = store.pending(c.id)[0];
  assert.equal(
    JSON.parse(joined.text.split("\n")[2]).note,
    "讨论已经起头了，你接后半段",
  );
  assert.match(joined.text, /群里已有消息/, "有历史就指它去读，不是等说明");
  await call("invite_agent", { chat_id: group.id, agent_id: c.ref });
  assert.equal(store.pending(c.id).length, 1, "重复邀请不重复叫醒");
  assert.equal(
    store.readChat(c.id, store.resolveChatId(group.id)).items[0].body,
    "之前的讨论",
  );
  assert.throws(() => store.readChat(c.id, userChat.id), /只能访问/);
  const foreign = store.createChat("外部群", [b.id]);
  await reject("invite_agent", { chat_id: foreign.ref, agent_id: c.ref });
  await reject("send_message", { chat_id: foreign.ref, body: "越权" });
  const total = store.chats().length;
  await reject("create_group", {
    name: "来意超长",
    members: [b.ref],
    note: "x".repeat(501),
  });
  await reject("invite_agent", {
    chat_id: group.id,
    agent_id: c.ref,
    note: "x".repeat(501),
  });
  await reject("create_group", { name: "无效成员", members: [b.ref, "a999"] });
  assert.equal(store.chats().length, total, "无效邀请不能留下半个群");
  store.run("UPDATE agents SET deleted_at=? WHERE id=?", Date.now(), b.id);
  assert(
    store.chat(store.resolveChatId(direct.id)).read_only,
    "删除任一方后同伴私聊只读",
  );
  assert.throws(
    () =>
      store.send(a.id, {
        chat_id: store.resolveChatId(direct.id),
        body: "继续",
        mentions: [],
      }),
    /删除/,
  );
  await reject("open_direct", { agent_id: b.ref });
});
