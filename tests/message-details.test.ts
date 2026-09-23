import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../server/store.ts";
import { createMcp } from "../server/mcp.ts";
import { messageRecords } from "../server/records.ts";
import { LOCAL_USER } from "../shared/user.ts";
import { sendInput } from "../shared/schema.ts";

const REPORT = `## 核对结果\n\n${"逐条核对了构建脚本与测试输出。".repeat(40)}\n\n结尾提到 zebra-17。`;

function group(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const mira = store.createAgent("Mira", tmpdir()).agent;
  const kai = store.createAgent("Kai", tmpdir()).agent;
  const chat = store.createChat("协作群", [atlas.id, mira.id, kai.id]);
  return { store, atlas, mira, kai, chat };
}

async function mcp(
  t: { after: (fn: () => Promise<void>) => void },
  store: Store,
  agentId: string,
) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createMcp(store, agentId, () => {});
  await server.connect(serverSide);
  const client = new Client({ name: "details-test", version: "1" });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    return { error: !!result.isError, text, json: () => JSON.parse(text) };
  };
  return call;
}

test("Agent 的 body 限 300 字，超了报错并说明拆法；用户不受限；有详情必须有 body", (t) => {
  const { store, atlas, chat } = group(t);
  assert.throws(
    () =>
      store.send(atlas.id, {
        chat_id: chat.id,
        body: "长".repeat(301),
        mentions: [],
      }),
    /body 有 301 字，超过 300 字。body 只写回复或结论，报告、证据、日志放进 details/,
  );
  store.send(atlas.id, {
    chat_id: chat.id,
    body: "长".repeat(300),
    mentions: [],
  });
  store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "用户的长消息".repeat(200),
    mentions: [],
  });
  assert.throws(
    () =>
      store.send(atlas.id, {
        chat_id: chat.id,
        body: "  ",
        details: REPORT,
        mentions: [],
      }),
    /有 details 时 body 不能为空/,
  );
  // HTTP 入口（Web、CLI）先过 schema，提示要和 MCP 路径一致。
  const parsed = sendInput.safeParse({
    chat_id: chat.id,
    body: " ",
    details: REPORT,
  });
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.issues[0]!.message, /有 details 时 body 不能为空/);
});

test("点名对象收到详情全文，没点名的只收合并提醒；详情里的 @ 也算点名", (t) => {
  const { store, atlas, mira, kai, chat } = group(t);
  const sent = store.send(atlas.id, {
    chat_id: chat.id,
    body: "核对完了，结论：构建脚本没问题。",
    details: `${REPORT}\n\n@Kai 第三步请你复核。`,
    mentions: [mira.id],
  });
  assert.deepEqual(new Set(sent.mentions), new Set([mira.id, kai.id]));
  for (const agent of [mira.id, kai.id]) {
    const delivery = store.pending(agent).at(-1)!;
    const json = JSON.parse(delivery.text.split("\n")[2]!);
    assert.equal(json.body, "核对完了，结论：构建脚本没问题。");
    assert.equal(json.details, `${REPORT}\n\n@Kai 第三步请你复核。`);
  }
  // 没有详情的消息，投递 JSON 里不出现 details 键。
  store.send(atlas.id, { chat_id: chat.id, body: "@Mira 收到", mentions: [] });
  const plain = JSON.parse(store.pending(mira.id).at(-1)!.text.split("\n")[2]!);
  assert.equal("details" in plain, false);
});

test("同一个 client_id 换了详情算不同内容", (t) => {
  const { store, atlas, chat } = group(t);
  const client_id = "5f0c7c1e-3f1a-4c52-9a55-3d0b8f0f7a11";
  const first = store.send(atlas.id, {
    chat_id: chat.id,
    body: "结论",
    details: "详情一",
    mentions: [],
    client_id,
  });
  const again = store.send(atlas.id, {
    chat_id: chat.id,
    body: "结论",
    details: "详情一",
    mentions: [],
    client_id,
  });
  assert.equal(again.id, first.id);
  assert.throws(
    () =>
      store.send(atlas.id, {
        chat_id: chat.id,
        body: "结论",
        details: "详情二",
        mentions: [],
        client_id,
      }),
    /消息标识已用于不同内容/,
  );
});

test("MCP：发送结果和 read_chat 默认只给详情字数，with_details 给全文", async (t) => {
  const { store, atlas, mira, chat } = group(t);
  const asAtlas = await mcp(t, store, atlas.id);
  const asMira = await mcp(t, store, mira.id);
  const tooLong = await asAtlas("send_message", {
    chat_id: chat.ref,
    body: "长".repeat(400),
  });
  assert(tooLong.error);
  assert.match(tooLong.text, /body 有 400 字，超过 300 字/);
  const sent = await asAtlas("send_message", {
    chat_id: chat.ref,
    body: "报告写好了，要点：三处脚本都能复现。",
    details: REPORT,
  });
  assert(!sent.error, sent.text);
  assert.equal(sent.json().details_chars, REPORT.length);
  assert.equal("details" in sent.json(), false, "不把刚写的详情回显给发送者");
  await asAtlas("send_message", {
    chat_id: chat.ref,
    body: "补一句：没有详情",
  });

  const summary = (await asMira("read_chat", { chat_id: chat.ref })).json();
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items[0].details_chars, REPORT.length);
  assert.equal("details" in summary.items[0], false);
  assert.equal("details_chars" in summary.items[1], false);

  const id = summary.items[0].id;
  const full = (
    await asMira("read_chat", {
      chat_id: chat.ref,
      after: id - 1,
      limit: 1,
      with_details: true,
    })
  ).json();
  assert.equal(full.items.length, 1);
  assert.equal(full.items[0].details, REPORT);
  assert.equal("details_chars" in full.items[0], false);
});

test("read_chat 的页预算只算实际返回的内容：不带详情时详情不占预算", (t) => {
  const { store, atlas, mira, kai, chat } = group(t);
  for (let i = 1; i <= 8; i++)
    store.send(atlas.id, {
      chat_id: chat.id,
      body: `第 ${i} 份报告`,
      details: "证据".repeat(2500),
      mentions: [],
    });
  const brief = store.readChat(mira.id, chat.id);
  assert.equal(brief.items.length, 8, "详情折叠时一页读完");
  assert.equal(brief.has_more, false);
  const full = store.readChat(kai.id, chat.id, undefined, 20, true);
  assert.equal(full.items.length, 2, "带详情时按全文字节数截页");
  assert.equal(full.has_more, true);
  assert.equal(full.next_after, full.items[1]!.id);
  assert.equal(
    store.unread(kai.id).find((u) => u.chat_id === chat.id)?.count,
    6,
    "只有实际返回的两条记为已读",
  );
});

test("搜索覆盖详情：片段取详情里的命中并标明，正文命中时照旧", (t) => {
  const { store, atlas, mira, chat } = group(t);
  store.send(atlas.id, {
    chat_id: chat.id,
    body: "报告写好了",
    details: REPORT,
    mentions: [],
  });
  store.send(atlas.id, {
    chat_id: chat.id,
    body: "正文里就有 zebra-17",
    mentions: [],
  });

  const agentHits = store.searchMessages(mira.id, {
    query: "ZEBRA-17",
    limit: 10,
  });
  assert.equal(agentHits.items.length, 2);
  const [inBody, inDetails] = agentHits.items;
  assert.match(inBody!.excerpt, /^正文里就有 zebra-17$/);
  assert.equal("details_chars" in inBody!, false);
  assert.match(inDetails!.excerpt, /^详情：….*zebra-17/);
  assert.equal(inDetails!.details_chars, REPORT.length);
  // 多个词可以分别落在正文和详情里。
  assert.equal(
    store.searchMessages(mira.id, { query: "写好了 zebra-17", limit: 10 }).items
      .length,
    1,
  );

  // 用户界面的搜索结果只显示一行，命中词要靠前。
  const nearStart = (text: string) =>
    text.startsWith("详情：…") && text.indexOf("zebra-17") <= 4 + 12;
  const userHits = store.search("zebra-17").messages;
  assert.equal(userHits.length, 2);
  assert(userHits.some((hit) => nearStart(hit.text)));
  assert(userHits.some((hit) => hit.text === "正文里就有 zebra-17"));

  const records = messageRecords(store, { q: "zebra-17" }).items;
  assert.equal(records.length, 2);
  assert(records.some((hit) => nearStart(hit.text)));
});

test("旧库升级：messages 补上 details 列，旧消息的详情为空", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-details-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "atrium.sqlite");
  const old = new Store(path);
  const agent = old.createAgent("Atlas", tmpdir()).agent;
  const chat = old.createChat("协作群", [agent.id]);
  old.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "升级前的消息",
    mentions: [],
  });
  old.close();
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE messages DROP COLUMN details");
  raw.close();

  const upgraded = new Store(path);
  t.after(() => upgraded.close());
  const [message] = upgraded.timeline(chat.id).items;
  assert.equal(message!.body, "升级前的消息");
  assert.equal(message!.details, "");
});
