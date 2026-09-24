import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { chatReference } from "../shared/schema.ts";
import { LOCAL_USER } from "../shared/user.ts";

test("旧库原地补短号，保留消息、成员、阅读证据；重启零数据重写", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "atrium-refs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "test.sqlite");
  let store = new Store(path);
  const a = store.createAgent("Atlas", folder).agent;
  const b = store.createAgent("Mira", folder).agent;
  const first = store.createChat("早先的群", [a.id, b.id]);
  const second = store.createChat("私聊", [a.id], a.id);
  const message = store.send(LOCAL_USER, {
    chat_id: first.id,
    body: "保留原文",
    mentions: [],
  });
  store.readChat(a.id, first.id);
  // Remove only the new metadata to reproduce the previous database schema.
  store.db.exec("DROP TRIGGER chats_assign_ref; DROP TABLE chat_refs");
  const before = {
    messages: store.all("SELECT * FROM messages"),
    members: store.all("SELECT * FROM members"),
    ranges: store.all("SELECT * FROM chat_read_ranges"),
  };
  store.close();
  store = new Store(path);
  assert.equal(store.chat(first.id).ref, "c1");
  assert.equal(store.chat(second.id).ref, "c2");
  assert.deepEqual(
    {
      messages: store.all("SELECT * FROM messages"),
      members: store.all("SELECT * FROM members"),
      ranges: store.all("SELECT * FROM chat_read_ranges"),
    },
    before,
  );
  assert.equal(
    store.readState(first.id, 0).find((r) => r.agent_id === a.id)!.through,
    message.id,
  );
  assert.equal(store.unread(b.id)[0].count, 1);
  store.run("UPDATE chats SET name=? WHERE id=?", "改名后的群", first.id);
  store.send(LOCAL_USER, {
    chat_id: second.id,
    body: "改变排序",
    mentions: [],
  });
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.one<{ n: number }>("SELECT total_changes() AS n")!.n, 0);
  assert.equal(store.chat(first.id).ref, "c1");
  assert.equal(store.chat(second.id).ref, "c2");
  assert.equal(store.createChat("重复私聊", [a.id], a.id).ref, "c2");
  assert.equal(
    store.chats(a.id).find((c) => c.id === first.id)!.ref,
    store.chats(b.id).find((c) => c.id === first.id)!.ref,
  );
});

test("短号不复用，支持历史版本插入与万级编号；拒绝非规范引用", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const first = store.createChat("第一个", []);
  assert.equal(first.ref, "c1");
  store.run("DELETE FROM chats WHERE id=?", first.id);
  assert.throws(() => store.resolveChatId("c1"), /没有叫「c1」的会话/);
  const second = store.createChat("第二个", []);
  assert.equal(second.ref, "c2");
  const legacy = randomUUID();
  store.run(
    "INSERT INTO chats(id,name,kind,direct_agent) VALUES(?,?,?,?)",
    legacy,
    "旧版本新增",
    "group",
    null,
  );
  assert.equal(store.chatRef(legacy), "c3");
  store.run("UPDATE sqlite_sequence SET seq=9999 WHERE name='chat_refs'");
  const large = store.createChat("一万个群", []);
  assert.equal(large.ref, "c10000");
  assert.equal(store.resolveChatId(large.ref), large.id);
  assert.equal(store.resolveChatId(large.id), large.id);
  for (const input of [
    "c0",
    "c01",
    "C1",
    "c-1",
    "c1.0",
    " c1",
    "c1 ",
    "c1\n",
    "c1 OR 1=1",
    "c9999999999999999",
    "anything",
  ])
    assert(
      !chatReference.safeParse(input).success,
      `应拒绝 ${JSON.stringify(input)}`,
    );
  assert.throws(() => store.resolveChatId("c999"), /没有叫「c999」的会话/);
});

test("私聊、明确提及和消息箱提醒使用相同短号，正文保持原样", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("Atlas", tmpdir()).agent;
  const group = store.createChat("开发", [a.id]);
  const dm = store.createChat("Atlas", [a.id], a.id);
  store.send(LOCAL_USER, {
    chat_id: group.id,
    body: `外部正文保留 ${group.id}`,
    mentions: [a.id],
  });
  store.send(LOCAL_USER, { chat_id: dm.id, body: "私聊", mentions: [] });
  const direct = store.pending(a.id);
  const payloads = direct.map((d) => JSON.parse(d.text.split("\n")[2]));
  assert.deepEqual(
    payloads.map((p) => p.chat_id),
    ["c1", "c2"],
  );
  assert.equal(payloads[0].body, `外部正文保留 ${group.id}`);
  store.send(LOCAL_USER, {
    chat_id: group.id,
    body: `群消息保留 ${group.id}`,
    mentions: [],
  });
  store.schedule(Date.now() + 301000);
  const summary = store.pending(a.id).find((d) => d.kind === "summary")!;
  assert.match(summary.text, /消息箱中 1 项未完成/);
  assert(!summary.text.includes(group.id));
  for (const notice of store.box(a.id).items)
    assert.equal(
      JSON.parse(notice.body).chat_ref,
      store.chatRef(notice.chat_id!),
    );
});

test("真实 MCP HTTP：短号发现读写、UUID 兼容与幂等、跨 Agent 一致和越权拒绝", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-ref-http-"));
  const { app, store } = await createApp({ data, runtime: false });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const a = store.createAgent("Atlas", data);
  const b = store.createAgent("Mira", data);
  const chat = store.createChat("共同群", [a.agent.id, b.agent.id]);
  const secret = store.createChat("私有群", [b.agent.id]);
  for (const identity of [a, b]) {
    const client = new Client({ name: "short-ref-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${origin}/mcp/${identity.agent.id}`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${identity.token}` },
          },
        },
      ),
    );
    clients.push(client);
  }
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text);
  };
  const [ca, cb] = clients;
  const list = await call(ca, "list_chats", {});
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, "c1");
  assert(!JSON.stringify(list).includes(chat.id));
  assert(
    (await call(cb, "list_chats", {})).items.some(
      (c: { id: string }) => c.id === "c1",
    ),
  );
  const body = `不要改写正文里的 ${chat.id}`;
  const incoming = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body,
    mentions: [],
  });
  const read = await call(ca, "read_chat", { chat_id: "c1" });
  assert.equal(read.items[0].chat_id, "c1");
  assert.equal(read.items[0].body, body);
  assert.equal(
    store.readState(chat.id, 0).find((r) => r.agent_id === a.agent.id)!.through,
    incoming.id,
  );
  const clientId = randomUUID();
  const sent = await call(ca, "send_message", {
    chat_id: "c1",
    body: "短号回复",
    client_id: clientId,
  });
  const retry = await call(ca, "send_message", {
    chat_id: chat.id,
    body: "短号回复",
    client_id: clientId,
  });
  assert.equal(sent.id, retry.id);
  assert.equal(retry.chat_id, "c1");
  assert.equal(
    (await call(cb, "read_chat", { chat_id: chat.id })).items.at(-1).chat_id,
    "c1",
  );
  store.addNotice(
    a.agent.id,
    "chat",
    "旧通知",
    JSON.stringify({ chat_id: chat.id, unread: 1 }),
    chat.id,
  );
  store.addNotice(a.agent.id, "system", "外部正文", chat.id, chat.id);
  const box = await call(ca, "view_message_box", {});
  assert(box.items.every((item: { chat_id: string }) => item.chat_id === "c1"));
  assert.equal(JSON.parse(box.items[0].body).chat_id, "c1");
  assert.equal(box.items[1].body, chat.id, "不替换外部正文");
  const before = store.all("SELECT * FROM members");
  const count = store.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages",
  )!.n;
  for (const ref of [
    secret.ref,
    secret.id,
    "c999",
    "c0",
    "c01",
    "c1 OR 1=1",
    "c9999999999999999",
  ])
    for (const name of ["read_chat", "send_message"]) {
      const result = await ca.callTool({
        name,
        arguments:
          name === "read_chat"
            ? { chat_id: ref }
            : { chat_id: ref, body: "越权" },
      });
      assert(result.isError, `${name} 应拒绝 ${ref}`);
    }
  assert.deepEqual(store.all("SELECT * FROM members"), before);
  assert.equal(
    store.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages")!.n,
    count,
  );
  const overview = await (await fetch(`${origin}/api/overview`)).json();
  assert.equal(
    overview.chats.find((c: { id: string }) => c.id === chat.id).ref,
    "c1",
  );
  console.log("short-ref MCP outputs", JSON.stringify({ list, sent, box }));
});
