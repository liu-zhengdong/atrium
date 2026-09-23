import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer as createViteServer } from "vite";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { receiveInbox, writeGithubTemplate } from "../server/adapters.ts";
import { displayDesktops, defaultDesktops } from "../server/agents.ts";
import { mentionsAll, resolveMentions } from "../shared/mentions.ts";
import { UNREAD_CAP, unreadLabel } from "../shared/schema.ts";
import { LOCAL_USER } from "../shared/user.ts";

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
      store.send(LOCAL_USER, { chat_id: chat.id, body, mentions: [] }),
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
  assert.throws(() => store.configure(a.id, { heartbeat_seconds: 0 }));
  store.configure(a.id, { heartbeat_seconds: 90 });
  assert.equal(store.agent(a.id).config.heartbeat_seconds, 90);
  assert.equal(
    store.agent(b.id).config.heartbeat_seconds,
    30,
    "偏好按身份隔离",
  );
  assert.throws(
    () => store.configure(a.id, { auto_start: true }),
    "唤醒不再是一项设置",
  );
});

test("旧版本存下的配置键不阻止身份加载", (t) => {
  const { store, a } = fixture(t);
  store.run(
    "UPDATE agents SET config=? WHERE id=?",
    JSON.stringify({
      auto_start: true,
      heartbeat_seconds: 45,
      wake_interval_seconds: 300,
      message_threshold: 3,
    }),
    a.id,
  );
  assert.deepEqual(
    store.agent(a.id).config,
    { heartbeat_seconds: 45 },
    "已删的键读时丢掉，保留的值不变",
  );
  assert.deepEqual(
    JSON.parse(
      store.one<{ config: string }>(
        "SELECT config FROM agents WHERE id=?",
        a.id,
      )!.config,
    ),
    { heartbeat_seconds: 45 },
    "并且写回去，不用每次读都重算",
  );
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
      store.send(LOCAL_USER, {
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
  const m = store.send(LOCAL_USER, input);
  assert.equal(store.send(LOCAL_USER, input).id, m.id);
  assert.equal(store.pending(a.id).length, 1);
  assert.match(store.pending(a.id)[0].text, /群聊/);
  assert.throws(
    () => store.send(LOCAL_USER, { ...input, body: "同一 ID 换了内容" }),
    /不同内容/,
  );
  store.send(a.id, {
    chat_id: chat.id,
    body: "@Atlas 自己发言",
    mentions: [a.id],
  });
  assert.equal(store.pending(a.id).length, 1);
  const dm = store.createChat("Atlas", [a.id], a.id);
  store.send(LOCAL_USER, { chat_id: dm.id, body: "私聊", mentions: [] });
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

test("通知箱用户审阅不标已读；Agent 只标记实际返回页，完成才算出队", (t) => {
  const { store, a, b } = fixture(t);
  for (let i = 0; i < 4; i++)
    store.addNotice(a.id, "system", `事件 ${i}`, "字".repeat(6000));
  const review = store.box(a.id, 0, true, false, 30);
  assert(review.has_more);
  assert.equal(store.boxCount(a.id), 4, "用户审阅不改变完成状态");
  const page = store.box(a.id, 0, true, true, 30);
  assert(page.items.every((m) => m.read_at !== null));
  assert.equal(store.boxCount(a.id), 4, "已读不等于完成");
  assert.equal(store.box(b.id).items.length, 0);
  assert(Buffer.byteLength(JSON.stringify(page)) < 33000);
  assert.equal(
    store.completeBox(
      a.id,
      page.items.map((m) => m.id),
    ),
    page.items.length,
  );
  assert.equal(store.boxCount(a.id), 4 - page.items.length, "完成后才出队");
});

test("心跳按间隔检查消息箱；阅读或完成后不再提醒", (t) => {
  const { store, a, chat, send } = fixture(t);
  const now = Date.now();
  store.run("UPDATE agents SET last_wake=? WHERE id=?", now - 31000, a.id);
  assert.deepEqual(store.schedule(now), [], "消息箱没有待完成消息不唤醒");
  send("一");
  assert.equal(store.boxCount(a.id), 1, "群发言即时合并进消息箱");
  assert.deepEqual(store.schedule(now), [a.id]);
  const summary = store.pending(a.id).find((d) => d.kind === "summary")!;
  assert.match(summary.text, /消息箱中 1 条消息未完成/);
  assert.deepEqual(store.schedule(now + 1000), [], "心跳间隔未到不重复提醒");
  assert.deepEqual(store.schedule(now + 31000), [a.id], "未完成则继续提醒");
  assert.equal(
    store.pending(a.id).filter((d) => d.kind === "summary").length,
    1,
  );
  store.readChat(a.id, chat.id);
  assert.equal(store.boxCount(a.id), 0, "读取群聊自动完成对应提醒");
  assert.deepEqual(store.schedule(now + 62000), []);
  send("二");
  const item = store.box(a.id).items[0];
  assert.equal(store.completeBox(a.id, [item.id]), 1);
  assert.equal(store.completeBox(a.id, [item.id]), 0, "重复完成是幂等的");
  assert.equal(store.boxCount(a.id), 0);
  assert.deepEqual(store.schedule(now + 100000), []);
});

test("同一副样子的消息箱只提醒几次，变了才重新计数", (t) => {
  const { store, a, send } = fixture(t);
  let now = Date.now();
  const tick = () => store.schedule((now += 31000));
  send("一");
  assert.deepEqual(
    [tick(), tick(), tick()],
    [[a.id], [a.id], [a.id]],
    "先提醒三次",
  );
  assert.deepEqual(tick(), [], "同一副样子就不再提了");
  assert.deepEqual(tick(), [], "也不会过一阵自己又开始");

  send("二");
  assert.deepEqual(tick(), [a.id], "群消息更新算作变化，重新计数");
  assert.deepEqual([tick(), tick()], [[a.id], [a.id]]);
  assert.deepEqual(tick(), [], "同样只提三次");

  const noteId = store.addNotice(a.id, "webhook", "CI 告警", "流水线失败");
  assert.deepEqual(tick(), [a.id], "来了新通知又重新计数");
  assert.equal(store.completeBox(a.id, [noteId]), 1);
  assert.deepEqual(tick(), [a.id], "完成了一部分也算有变化");

  assert.equal(
    store.completeBox(
      a.id,
      store.box(a.id).items.map((i) => i.id),
    ),
    1,
  );
  assert.equal(store.boxCount(a.id), 0);
  assert.deepEqual(tick(), [], "处理完就完全不提");
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

test("@ 短号、中文紧挨、标点收尾都算点名；邮箱、包名、代码里的不算", () => {
  const agents = [
    { id: "a", name: "Atlas", ref: "a1" },
    { id: "b", name: "a2", ref: "a9" },
    { id: "c", name: "Kimi-K3", ref: "a2" },
  ];
  const cases: [string, string[]][] = [
    ["@a1 交作业", ["a"]],
    ["请@Atlas 看一下", ["a"]],
    ["**@a1**：结论如下", ["a"]],
    ["转给 @Kimi-K3。", ["c"]],
    ["(@Atlas)、「@a1」", ["a"]],
    ["@a2 是 Kimi-K3 的短号，不是名叫 a2 的那位", ["c"]],
    ["@a9 和 @a1 按出现顺序", ["b", "a"]],
    ["信箱 x@Atlas.com，包 @liuser/pi-atrium", []],
    ["@a10 不是 @a1", ["a"]],
    ["代码 `@a1` 和\n```\n@Atlas\n```\n都不算", []],
  ];
  for (const [body, expected] of cases)
    assert.deepEqual(resolveMentions(body, agents), expected, body);
  assert(!mentionsAll("`@全体` 是代码"), "代码里的 @ 全体不算");
  assert(mentionsAll("请@全体。"), "中文紧挨也算");
});

test("十万条消息：未读封顶 99+，会话列表与未读摘要不随规模变慢", (t) => {
  const { store, a, chat, send } = fixture(t);
  const insert = store.db.prepare(
    "INSERT INTO messages(chat_id,sender,body,mentions,created_at) VALUES(?,?,?,?,?)",
  );
  store.transaction(() => {
    for (let i = 0; i < 100000; i++)
      insert.run(chat.id, LOCAL_USER, "规模样本", "[]", Date.now());
    // 用户的未读数只数别人发的，单独造一批越过封顶的
    for (let i = 0; i < 150; i++)
      insert.run(chat.id, a.id, "Agent 发言", "[]", Date.now());
  });
  // 封顶值的含义是「及以上」，不是精确数字
  assert.equal(store.unread(a.id)[0].count, UNREAD_CAP + 1);
  assert.equal(store.chats()[0].unread, UNREAD_CAP + 1);
  assert.equal(unreadLabel(store.chats()[0].unread!), "99+");

  // 同一个库里和封顶前的全量计数对照：换机器也成立，不依赖绝对耗时
  const ms = (fn: () => unknown, runs = 5) => {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }
    return times.sort((x, y) => x - y)[Math.floor(runs / 2)]!;
  };
  const fullCount = store.db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE chat_id=? AND sender!=? AND id>0",
  );
  const capped = ms(() => {
    store.unread(a.id);
    store.chats();
  });
  const linear = ms(() => fullCount.get(chat.id, a.id));
  assert.ok(
    capped * 10 < linear,
    `封顶后的未读与列表 ${capped.toFixed(2)}ms 应远快于全量计数 ${linear.toFixed(2)}ms`,
  );

  send("新增");
  store.readChat(a.id, chat.id, undefined, 20);
  assert.equal(
    store.unread(a.id)[0].count,
    UNREAD_CAP + 1,
    "读掉一页后仍在封顶之上",
  );
  assert.equal(
    store.readState(chat.id, 0)[0].ranges.length,
    0,
    "顺序阅读不增加逐消息回执",
  );
  // 碎片化已读区间：封顶查询仍然要排除区间覆盖的消息
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
  const fragmented = ms(() => store.unread(a.id));
  assert.equal(store.unread(a.id)[0].count, UNREAD_CAP + 1);
  console.log(
    JSON.stringify({
      benchmark: "100k-messages",
      read_ranges: 999,
      capped_ms: +capped.toFixed(2),
      linear_count_ms: +linear.toFixed(2),
      fragmented_ms: +fragmented.toFixed(2),
    }),
  );
});

async function appFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-test-"));
  const result = await createApp({
    data,
    runtime: false,
    desktops: join(data, "desktops"),
    piHome: join(data, ".pi"),
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
  const overviewResponse = await request("/api/overview");
  assert.equal(
    (await overviewResponse.json()).desktops_root,
    join(data, "desktops"),
    "overview 下发桌面根目录，供界面预览",
  );
  assert.equal(
    displayDesktops(defaultDesktops()),
    "~/Atrium/desktops",
    "默认根目录折叠 home 显示",
  );
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

test("HTTP 输入、Host/Origin 与接收口处理实测", async (t) => {
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
  // 无适配器：原文落入消息箱
  const push = await request(`/api/agents/${agentId}/inbox`, {
    action: "opened",
    number: 12,
  });
  assert.equal(push.status, 200);
  assert.deepEqual(await push.json(), {
    stored: 1,
    dropped: false,
    errors: [],
  });
  assert.equal(store.boxCount(agentId), 1);
  assert.equal(store.box(agentId).items[0].source, "external");
  // 非 JSON 正文同样接收，原文保留
  const plain = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/inbox`,
    headers: { "content-type": "text/plain" },
    payload: "构建失败：步骤 3",
  });
  assert.equal(plain.statusCode, 200);
  assert.equal(store.boxCount(agentId), 2);
  // 写入 GitHub 适配器模板：匹配事件经整理入箱，不匹配则丢弃
  const agent = store.agent(agentId);
  assert.deepEqual(writeGithubTemplate(agent).file, "github.mjs");
  assert.throws(() => writeGithubTemplate(agent), /已存在/);
  const pr = {
    action: "opened",
    number: 12,
    repository: { full_name: "Owner/Repo" },
    pull_request: {
      number: 12,
      title: "验证 PR",
      user: { login: "contributor" },
      html_url: "https://github.com/Owner/Repo/pull/12",
    },
  };
  const forwarded = await request(`/api/agents/${agentId}/inbox`, pr, {
    "x-github-event": "pull_request",
  });
  assert.deepEqual(await forwarded.json(), {
    stored: 1,
    dropped: false,
    errors: [],
  });
  const adapted = store
    .box(agentId)
    .items.find((item) => item.source === "adapter:github.mjs")!;
  assert.equal(adapted.title, "Owner/Repo #12 · 验证 PR");
  assert.equal(adapted.url, "https://github.com/Owner/Repo/pull/12");
  const ignored = await request(`/api/agents/${agentId}/inbox`, pr, {
    "x-github-event": "push",
  });
  assert.deepEqual(await ignored.json(), {
    stored: 0,
    dropped: true,
    errors: [],
  });
  // 适配器报错：原文落箱并记录系统通知，不丢消息
  writeFileSync(
    join(agent.cwd, "adapters", "broken.mjs"),
    "export default async function () { throw new Error('损坏'); }\n",
  );
  const before = store.boxCount(agentId);
  const broken = await request(`/api/agents/${agentId}/inbox`, { probe: 1 });
  const brokenResult = (await broken.json()) as {
    stored: number;
    errors: string[];
  };
  assert.equal(brokenResult.stored, 1);
  assert.equal(brokenResult.errors.length, 1);
  assert.equal(store.boxCount(agentId), before + 2);
  assert(
    store
      .box(agentId)
      .items.some(
        (item) => item.source === "system" && item.title === "适配器执行失败",
      ),
  );
  const review = await request("/api/agents/" + agentId + "/box");
  assert.equal(review.status, 200);
  const overview = await (await request("/api/overview")).text();
  assert(!overview.includes("token_hash"));
});

test("适配器超时被终止，原文落箱不丢失", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const root = mkdtempSync(join(tmpdir(), "atrium-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = store.createAgent("Atlas", root).agent;
  mkdirSync(join(root, "adapters"));
  writeFileSync(
    join(root, "adapters", "hang.mjs"),
    "export default async function () { await new Promise(() => {}); }\n",
  );
  const result = await receiveInbox(
    store,
    store.agent(agent.id),
    { headers: {}, query: {}, body: { probe: true } },
    200,
  );
  assert.equal(result.stored, 1);
  assert(result.errors.some((error) => error.includes("终止")));
  const items = store.box(agent.id).items;
  assert(items.some((item) => item.source === "external"));
  assert(items.some((item) => item.source === "system"));
});

test("真实 Vite 代理保留 Host：正常写入与伪造 Origin 拒绝", async (t) => {
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
  assert.equal(tools.tools.length, 15);
  assert(
    tools.tools.some((tool) => tool.name === "fork_agent"),
    "招募 fork 对 Agent 可见",
  );
  const claim = await client.callTool({
    name: "claim_status",
    arguments: { work: "正在检查通知" },
  });
  assert(!claim.isError);
  assert.equal(store.agent(agentId).work, "正在检查通知");
  await client.callTool({
    name: "update_config",
    arguments: { heartbeat_seconds: 120 },
  });
  assert.equal(store.agent(agentId).config.heartbeat_seconds, 120);
  assert.equal(store.agent(other.id).config.heartbeat_seconds, 30);
  const forbidden = await client.callTool({
    name: "update_config",
    arguments: { heartbeat_seconds: 120, agent_id: other.id },
  });
  assert(forbidden.isError);
  const read = await client.callTool({
    name: "read_chat",
    arguments: { chat_id: privateChat.id },
  });
  assert(read.isError);
  const incoming = store.send(LOCAL_USER, {
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
  const viewed = await client.callTool({
    name: "view_message_box",
    arguments: {},
  });
  assert(!viewed.isError);
  const remaining = store.box(agentId).items.map((item) => item.id);
  assert(remaining.length >= 1);
  const completed = await client.callTool({
    name: "complete_inbox",
    arguments: { ids: remaining },
  });
  assert(!completed.isError);
  assert.equal(store.boxCount(agentId), 0);
});
