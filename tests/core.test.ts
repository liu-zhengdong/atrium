import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer as createViteServer } from "vite";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { resolveMentions } from "../shared/mentions.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("Atlas", tmpdir()).agent,
    b = store.createAgent("Mira", tmpdir()).agent;
  const chat = store.createChat("开发", [a.id]);
  return {
    store,
    a,
    b,
    chat,
    send: (body: string) =>
      store.send("user", { chat_id: chat.id, body, mentions: [] }),
  };
}

test("身份、凭据与配置隔离；拒绝自身配置之外的字段", (t) => {
  const { store, a, b } = fixture(t);
  const created = store.createAgent("Cedar", tmpdir());
  assert(store.authenticate(created.agent.id, created.token));
  assert(!store.authenticate(a.id, created.token));
  assert(!JSON.stringify(store.agents()).includes(created.token));
  assert.throws(() => store.createAgent("Atlas", tmpdir()), /已经被使用/);
  assert.throws(() => store.configure(a.id, { cwd: "/tmp" }));
  assert.throws(() => store.configure(a.id, { wake_interval_seconds: 0 }));
  store.configure(a.id, { auto_start: true });
  assert.equal(store.agent(b.id).config.auto_start, false);
});

test("会话成员隔离、后续加入和私聊唯一性", (t) => {
  const { store, a, b, chat, send } = fixture(t);
  send("历史消息");
  assert.throws(() => store.readChat(b.id, chat.id), /只能访问/);
  assert.throws(
    () => store.send(b.id, { chat_id: chat.id, body: "越权", mentions: [] }),
    /只能访问/,
  );
  assert.throws(
    () =>
      store.send("user", {
        chat_id: chat.id,
        body: "错误提及",
        mentions: [b.id],
      }),
    /只能访问/,
  );
  store.addMember(chat.id, b.id);
  assert.equal(store.readChat(b.id, chat.id).items[0].body, "历史消息");
  const dm = store.createChat("Atlas 私聊", [a.id], a.id);
  assert.equal(store.createChat("重复私聊", [a.id], a.id).id, dm.id);
  assert.throws(() => store.addMember(dm.id, b.id), /私聊不能/);
});

test("用户明确 @ 和私聊走即时通道，普通消息不广播；发言幂等", (t) => {
  const { store, a, chat, send } = fixture(t);
  send("普通消息");
  assert.equal(store.pending(a.id).length, 0);
  const input = {
    chat_id: chat.id,
    body: "@Atlas 先讨论",
    mentions: [a.id],
    client_id: randomUUID(),
  };
  const m = store.send("user", input);
  assert.equal(store.send("user", input).id, m.id);
  assert.equal(store.pending(a.id).length, 1);
  assert.match(store.pending(a.id)[0].text, /群聊/);
  assert.throws(
    () => store.send("user", { ...input, body: "同一 ID 换了内容" }),
    /不同内容/,
  );
  store.send(a.id, {
    chat_id: chat.id,
    body: "@Atlas 自己发言",
    mentions: [a.id],
  });
  assert.equal(store.pending(a.id).length, 1);
  const dm = store.createChat("Atlas", [a.id], a.id);
  store.send("user", { chat_id: dm.id, body: "私聊", mentions: [] });
  assert.equal(store.pending(a.id).length, 2);
});

test("阅读分页不能跨过未读缺口；各 Agent 独立，自己的发言不算未读", (t) => {
  const { store, a, b, chat, send } = fixture(t);
  store.addMember(chat.id, b.id);
  const first = send("一");
  send("二");
  send("三");
  assert.equal(store.unread(a.id)[0].count, 3);
  store.readChat(a.id, chat.id, first.id, 2);
  assert.equal(
    store.unread(a.id)[0].count,
    1,
    "跳读只消除返回消息，首条仍未读",
  );
  const page = store.readChat(a.id, chat.id, undefined, 1);
  assert(page.has_more);
  assert.equal(store.unread(a.id).length, 0, "补齐缺口后合并连续阅读位置");
  assert.equal(store.unread(b.id)[0].count, 3);
  store.readChat(a.id, chat.id);
  assert.equal(store.unread(a.id).length, 0);
  store.send(a.id, { chat_id: chat.id, body: "我自己的发言", mentions: [] });
  assert.equal(store.unread(a.id).length, 0);
});

test("收件箱用户审阅不标已读；Agent 只标记实际返回页", (t) => {
  const { store, a, b } = fixture(t);
  for (let i = 0; i < 4; i++)
    store.addNotice(a.id, "system", `事件 ${i}`, "字".repeat(6000));
  const review = store.box(a.id, 0, true, false, 30);
  assert(review.has_more);
  assert.equal(store.boxCount(a.id), 4);
  const page = store.box(a.id, 0, true, true, 30);
  assert.equal(store.boxCount(a.id), 4 - page.items.length);
  assert(page.items.every((m) => m.read_at !== null));
  assert.equal(store.box(b.id).items.length, 0);
  assert(Buffer.byteLength(JSON.stringify(page)) < 33000);
});

test("定时／累计触发、合并限频和已读提醒清理", (t) => {
  const { store, a, chat, send } = fixture(t);
  const now = Date.now();
  store.configure(a.id, { message_threshold: 2 });
  store.run("UPDATE agents SET last_wake=? WHERE id=?", now - 31000, a.id);
  assert.deepEqual(store.schedule(now), []);
  send("一");
  assert.deepEqual(store.schedule(now), []);
  send("二");
  assert.deepEqual(store.schedule(now), [a.id]);
  assert.equal(store.unread(a.id)[0].count, 2);
  assert.equal(store.boxCount(a.id), 1);
  assert.equal(store.pending(a.id)[0].kind, "summary");
  assert.deepEqual(store.schedule(now + 1000), []);
  assert.deepEqual(store.schedule(now + 31000), []);
  assert.deepEqual(store.schedule(now + 301000), [a.id]);
  assert.equal(store.pending(a.id).length, 1);
  assert.equal(store.boxCount(a.id), 1);
  store.box(a.id, 0, true, true);
  assert.equal(store.unread(a.id)[0].count, 2, "读提醒不等于读聊天");
  store.schedule(now + 602000);
  store.readChat(a.id, chat.id);
  assert.equal(store.boxCount(a.id), 0);
  assert.deepEqual(store.schedule(now + 903000), []);
});

test("@ 名称含空格、点、前缀重叠；拒绝误匹配与非成员", () => {
  const agents = [
    { id: "a", name: "Atlas" },
    { id: "b", name: "Atlas One" },
    { id: "c", name: "Mira.v2" },
  ];
  assert.deepEqual(resolveMentions("@Atlas One 请看看 @Mira.v2。", agents), [
    "b",
    "c",
  ]);
  assert.deepEqual(resolveMentions("@MiraXv2 @AtlasPlus @外人", agents), []);
  assert.deepEqual(resolveMentions("@Atlas @Atlas", agents), ["a"]);
});

test("十万条消息：冷／热未读与会话列表；写入、阅读使缓存失效", (t) => {
  const { store, a, chat, send } = fixture(t);
  const insert = store.db.prepare(
    "INSERT INTO messages(chat_id,sender,body,mentions,created_at) VALUES(?,?,?,?,?)",
  );
  store.transaction(() => {
    for (let i = 0; i < 100000; i++)
      insert.run(chat.id, "user", "规模样本", "[]", Date.now());
  });
  const start = performance.now();
  assert.equal(store.unread(a.id)[0].count, 100000);
  const cold = performance.now() - start;
  const hotStart = performance.now();
  for (let i = 0; i < 1000; i++) store.unread(a.id);
  const hot = performance.now() - hotStart;
  const listStart = performance.now();
  for (let i = 0; i < 100; i++) store.chats();
  const lists = performance.now() - listStart;
  send("新增");
  assert.equal(store.unread(a.id)[0].count, 100001);
  store.readChat(a.id, chat.id, undefined, 20);
  assert.equal(store.unread(a.id)[0].count, 99981);
  assert.equal(
    store.readState(chat.id, 0)[0].ranges.length,
    0,
    "顺序阅读不增加逐消息回执",
  );
  store.transaction(() => {
    for (let i = 100; i < 100000; i += 100)
      store.run(
        "INSERT INTO chat_read_ranges VALUES(?,?,?,?)",
        chat.id,
        a.id,
        i,
        i + 29,
      );
  });
  store.readChat(a.id, chat.id, undefined, 1);
  const fragmentedStart = performance.now();
  assert.equal(store.unread(a.id)[0].count, 100001 - 21 - 999 * 30);
  const fragmented = performance.now() - fragmentedStart;
  console.log(
    JSON.stringify({
      benchmark: "100k-messages",
      read_ranges: 999,
      fragmented_cold_ms: +fragmented.toFixed(2),
      cold_ms: +cold.toFixed(2),
      hot_1000_ms: +hot.toFixed(2),
      lists_100_ms: +lists.toFixed(2),
    }),
  );
});

async function appFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-test-"));
  const result = await createApp({
    data,
    githubSecret: "test-only-secret",
    runtime: false,
    desktops: join(data, "desktops"),
  });
  await result.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await result.app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const address = result.app.server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const response = await request("/api/agents", {
    name: "测试 Agent",
    template: data,
  });
  assert.equal(response.status, 201);
  const created = (await response.json()) as {
    agent: { id: string; cwd: string };
  };
  assert.equal(
    created.agent.cwd,
    realpathSync(join(data, "desktops", "测试 Agent")),
    "创建即分配固定桌面目录",
  );
  assert(statSync(created.agent.cwd).isDirectory());
  assert(
    !("link_path" in created),
    "UI no longer receives private connection paths",
  );
  const credentialPath = join(data, "credentials", `${created.agent.id}.json`);
  const link = JSON.parse(readFileSync(credentialPath, "utf8"));
  assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
  assert.equal(
    (await request(`/api/agents/${created.agent.id}/link`)).status,
    404,
  );
  assert.equal((await request(`/bridge/${created.agent.id}`)).status, 404);
  return {
    ...result,
    origin,
    request,
    template: data,
    agentId: created.agent.id,
    link,
  };
}

test("HTTP 输入、Host/Origin、伪造签名和重放事件实测拒绝", async (t) => {
  const { app, request, store, agentId } = await appFixture(t);
  assert.equal(
    (
      await request("/api/agents", {
        name: "..",
      })
    ).status,
    400,
    "逃逸名称不能作为桌面目录",
  );
  assert.equal(
    (
      await request("/api/agents", {
        name: "Bad",
        cwd: tmpdir(),
      })
    ).status,
    400,
    "工作目录不再由调用方指定",
  );
  assert.equal(
    (
      await request("/api/agents", {
        name: "Bad",
        token: "injected",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: "attacker.example" },
      })
    ).statusCode,
    403,
  );
  for (const origin of ["https://evil.example", "not a url"])
    assert.equal(
      (await request("/api/overview", undefined, { origin })).status,
      403,
    );
  assert.equal(
    (
      await request("/mcp/" + agentId, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })
    ).status,
    401,
  );
  store.subscribe(agentId, "Owner/Repo", "pull_request.opened");
  const body = {
    action: "opened",
    number: 12,
    repository: { full_name: "Owner/Repo" },
    pull_request: { title: "验证 PR", user: { login: "contributor" } },
  };
  const headers = {
    "x-github-delivery": randomUUID(),
    "x-github-event": "pull_request",
    "x-hub-signature-256":
      "sha256=" +
      createHmac("sha256", "test-only-secret")
        .update(JSON.stringify(body))
        .digest("hex"),
  };
  assert.equal(
    (
      await request("/webhooks/github", body, {
        ...headers,
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("/webhooks/github", { ...body, number: 13 }, headers))
      .status,
    401,
  );
  const valid = await request("/webhooks/github", body, headers);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).matched, 1);
  const repeat = await request("/webhooks/github", body, headers);
  assert.equal((await repeat.json()).duplicate, true);
  assert.equal(store.boxCount(agentId), 1);
  assert.equal(
    store.box(agentId).items[0].url,
    "https://github.com/Owner/Repo/pull/12",
  );
  const review = await request("/api/agents/" + agentId + "/box");
  assert.equal(review.status, 200);
  assert.equal(store.boxCount(agentId), 1);
  const overview = await (await request("/api/overview")).text();
  assert(!overview.includes("token_hash"));
  assert(!overview.includes("test-only-secret"));
});

test("真实 Vite 代理保留 Host：正常写入、伪造 Origin 拒绝及 Webhook 路由", async (t) => {
  const { origin, template } = await appFixture(t);
  const previousPort = process.env.ATRIUM_PORT;
  let vite;
  try {
    process.env.ATRIUM_PORT = new URL(origin).port;
    vite = await createViteServer({
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1" },
    });
  } finally {
    if (previousPort === undefined) delete process.env.ATRIUM_PORT;
    else process.env.ATRIUM_PORT = previousPort;
  }
  t.after(() => vite.close());
  await vite.listen();
  const address = vite.httpServer!.address();
  assert(address && typeof address !== "string");
  const front = `http://127.0.0.1:${address.port}`;
  const post = (path: string, origin: string) =>
    fetch(front + path, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify({ name: "代理创建", template }),
    });
  assert.equal((await post("/api/agents", front)).status, 201);
  assert.equal((await post("/api/agents", "https://evil.example")).status, 403);
  assert.equal((await post("/webhooks/github", front)).status, 401);
});

test("真实 MCP HTTP：发现、调用、自身配置与身份越权拒绝", async (t) => {
  const { origin, store, agentId, link } = await appFixture(t);
  const other = store.createAgent("另一个 Agent", tmpdir()).agent;
  const chat = store.createChat("工具会话", [agentId]);
  const privateChat = store.createChat("别人的会话", [other.id]);
  store.addNotice(agentId, "system", "测试通知", "只需阅读");
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp/${agentId}`),
    { requestInit: { headers: { Authorization: `Bearer ${link.token}` } } },
  );
  const client = new Client({ name: "atrium-test", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 14);
  const claim = await client.callTool({
    name: "claim_status",
    arguments: { work: "正在检查通知" },
  });
  assert(!claim.isError);
  assert.equal(store.agent(agentId).work, "正在检查通知");
  await client.callTool({
    name: "update_config",
    arguments: { auto_start: true },
  });
  assert.equal(store.agent(agentId).config.auto_start, true);
  assert.equal(store.agent(other.id).config.auto_start, false);
  const forbidden = await client.callTool({
    name: "update_config",
    arguments: { auto_start: true, agent_id: other.id },
  });
  assert(forbidden.isError);
  const read = await client.callTool({
    name: "read_chat",
    arguments: { chat_id: privateChat.id },
  });
  assert(read.isError);
  const incoming = store.send("user", {
    chat_id: chat.id,
    body: "需要阅读回执",
    mentions: [],
  });
  const receipt = async () =>
    (await (
      await fetch(`${origin}/api/chats/${chat.id}/messages`)
    ).json()) as ReturnType<Store["timeline"]>;
  assert.equal(
    (await receipt()).read_state[0].through,
    0,
    "浏览器审阅不标记已读",
  );
  await client.callTool({ name: "read_chat", arguments: { chat_id: chat.id } });
  assert.equal(
    (await receipt()).read_state[0].through,
    incoming.id,
    "真实 MCP 调用后 HTTP 可见回执",
  );
  const sent = await client.callTool({
    name: "send_message",
    arguments: { chat_id: chat.id, body: "真实 MCP 回复" },
  });
  assert(!sent.isError);
  assert.equal(store.timeline(chat.id).items.at(-1)?.sender, agentId);
  await client.callTool({ name: "view_message_box", arguments: {} });
  assert.equal(store.boxCount(agentId), 0);
});
