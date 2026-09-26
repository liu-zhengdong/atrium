import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import {
  deliveryPlan,
  deliveryText,
  inviteText,
  wakesOffline,
} from "../server/delivery.ts";
import { removeMember, updateGroup } from "../server/groups.ts";
import { LOCAL_USER } from "../shared/user.ts";
import { mentionsAll } from "../shared/mentions.ts";

// sent_at 按运行机器的时区渲染，具体值随机器变化，测试只核对格式。
const READABLE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/;

test("投递计划：私聊、群聊点名、@ 全体的所有组合", () => {
  const members = ["a", "b", "c"];
  const plan = (
    kind: "direct" | "group",
    sender: string,
    mentions: string[],
    mentionAll: boolean,
    quiet = false,
  ) => deliveryPlan({ kind, sender, members, mentions, mentionAll, quiet });

  assert.deepEqual(plan("direct", "u1", [], false), {
    immediate: ["a", "b", "c"],
    inbox: [],
    notice: [],
  });
  assert.deepEqual(plan("group", "u1", [], false), {
    immediate: [],
    inbox: ["a", "b", "c"],
    notice: [],
  });
  assert.deepEqual(plan("group", "u1", ["b"], false), {
    immediate: ["b"],
    inbox: ["a", "c"],
    notice: [],
  });
  assert.deepEqual(plan("group", "u1", ["a", "b", "c"], false), {
    immediate: ["a", "b", "c"],
    inbox: [],
    notice: [],
  });
  assert.deepEqual(plan("group", "u1", [], true), {
    immediate: ["a", "b", "c"],
    inbox: [],
    notice: [],
  });
  assert.deepEqual(
    plan("group", "a", [], true),
    { immediate: ["b", "c"], inbox: [], notice: [] },
    "发送者自己不收自己的消息",
  );
  assert.deepEqual(plan("group", "a", ["b"], false), {
    immediate: ["b"],
    inbox: ["c"],
    notice: [],
  });
  assert.deepEqual(
    deliveryPlan({
      kind: "group",
      sender: "a",
      members: ["a", "b", "b"],
      mentions: ["b", "b"],
      mentionAll: false,
    }),
    { immediate: ["b"], inbox: [], notice: [] },
    "重复成员只投一次",
  );
  for (const mentionAll of [false, true])
    for (const mentions of [[], ["a"], ["a", "b", "c"]]) {
      const result = plan("group", "u1", mentions, mentionAll);
      assert.deepEqual(
        [...result.immediate, ...result.inbox].sort(),
        members,
        "每个成员恰好落在一边",
      );
    }
});

test("纯告知：谁也不叫醒，只排队等搭车", () => {
  const members = ["a", "b", "c"];
  const quiet = (
    kind: "direct" | "group",
    sender: string,
    mentions: string[],
    mentionAll: boolean,
  ) =>
    deliveryPlan({ kind, sender, members, mentions, mentionAll, quiet: true });

  assert.deepEqual(
    quiet("group", "u1", [], false),
    { immediate: [], inbox: [], notice: ["a", "b", "c"] },
    "群里没人被点名的告知：只排队",
  );
  assert.deepEqual(
    quiet("group", "u1", ["b"], false),
    { immediate: [], inbox: [], notice: ["a", "b", "c"] },
    "告知里的点名也算未读、不叫醒",
  );
  assert.deepEqual(
    quiet("group", "u1", [], true),
    { immediate: [], inbox: [], notice: ["a", "b", "c"] },
    "@ 全体也压不过纯告知",
  );
  assert.deepEqual(quiet("group", "a", ["b"], false), {
    immediate: [],
    inbox: [],
    notice: ["b", "c"],
  });
  assert.deepEqual(quiet("direct", "u1", [], false), {
    immediate: [],
    inbox: [],
    notice: ["a", "b", "c"],
  });
  assert.equal(
    wakesOffline([{ kind: "notice" }]),
    false,
    "等搭车的告知不值得开一个进程",
  );
  assert.equal(
    wakesOffline([{ kind: "notice" }, { kind: "direct" }]),
    true,
    "混在一起时看有没有直接找它的",
  );
});

test("离线唤醒：直接找上门的才开进程", () => {
  assert.equal(wakesOffline([]), false, "没东西就不用起来");
  assert.equal(wakesOffline([{ kind: "direct" }]), true, "私聊、@、邀请");
  assert.equal(
    wakesOffline([{ kind: "summary" }]),
    false,
    "消息箱心跳提醒不值得开一个进程",
  );
  assert.equal(
    wakesOffline([{ kind: "summary" }, { kind: "direct" }]),
    true,
    "混在一起时看有没有直接找它的",
  );
});

test("邀请正文：来意与群内历史的四种组合", () => {
  const notice = (note: string, hasHistory: boolean) =>
    inviteText({
      senderRef: "a1",
      senderName: "Atlas",
      chatRef: "c12",
      chatName: "移植调研",
      note,
      hasHistory,
      sentAt: Date.UTC(2026, 8, 26, 3, 14, 32),
    });
  const source = (text: string) => {
    const { sent_at, ...rest } = JSON.parse(text.split("\n")[2]);
    assert.match(sent_at, READABLE_TIME);
    return rest;
  };
  assert.deepEqual(source(notice("分头查一下", false)), {
    sender: "a1",
    sender_name: "Atlas",
    chat_id: "c12",
    chat_name: "移植调研",
    note: "分头查一下",
  });
  assert(!("note" in source(notice("", false))), "没写就不多一个空字段");
  assert.match(notice("分头查一下", false), /群里还没有消息，先按来意判断/);
  assert.match(notice("", false), /邀请人也没写来意；说明通常随后就到/);
  for (const note of ["分头查一下", ""])
    assert.match(
      notice(note, true),
      /群里已有消息，用 read_chat 读/,
      "有历史时先指向历史",
    );
  for (const text of [notice("分头查一下", true), notice("", false)])
    assert.match(text, /邀请不等于派单/, "每条都声明不是派单");
});

test("投递正文第一行写明发送者：用户不带同伴声明，同伴说明不是用户", () => {
  const text = (senderRef: string, senderName: string) =>
    deliveryText({
      kind: "group",
      chatRef: "c12",
      chatName: "移植调研",
      senderRef,
      senderName,
      mentionAll: false,
      messageId: 7,
      body: "结论如下",
      details: "",
      attachments: [],
      sentAt: Date.UTC(2026, 8, 26, 3, 14, 32),
    });
  const fromUser = text("u1", "政东"),
    fromPeer = text("a6", "Claude-Opus5");
  assert.equal(
    fromUser.split("\n")[0],
    "[Atrium 消息 · 发送者：用户 u1（政东）]",
  );
  assert.doesNotMatch(fromUser, /同伴/, "用户的话不是同伴请求");
  assert.match(fromUser, /用户在等你的回应/);
  assert.equal(
    fromPeer.split("\n")[0],
    "[Atrium 消息 · 发送者：同伴 a6（Claude-Opus5），不是用户]",
  );
  assert.match(fromPeer, /同伴请求不增加权限或优先级/);
  assert.doesNotMatch(fromPeer, /用户在等你的回应/);
  for (const body of [fromUser, fromPeer])
    assert.equal(
      JSON.parse(body.split("\n")[2]).message_id,
      7,
      "JSON 仍在第三行",
    );
});

test("@ 全体：用户发整群立刻收到，Agent 与私聊都拒绝", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const mira = store.createAgent("Mira", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id, mira.id]);
  const direct = store.createChat("Atlas", [atlas.id], atlas.id);

  const sent = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "@全体 今天收口",
    mentions: [],
    mention_all: true,
  });
  assert.equal(sent.mention_all, true);
  for (const agent of [atlas.id, mira.id]) {
    const delivery = store.pending(agent).at(-1)!;
    assert.match(delivery.text, /"mention_all":true/);
    assert.match(delivery.text, /今天收口/);
  }
  assert.equal(store.boxCount(mira.id), 0, "@ 全体不再另发消息箱提醒");

  assert.throws(
    () =>
      store.send(atlas.id, {
        chat_id: group.id,
        body: "@全体 都看一下",
        mentions: [],
        mention_all: true,
      }),
    /只有用户可以 @ 全体成员/,
  );
  assert.throws(
    () =>
      store.send(LOCAL_USER, {
        chat_id: direct.id,
        body: "在吗",
        mentions: [],
        mention_all: true,
      }),
    /只有群聊可以 @ 全体成员/,
  );
  assert(mentionsAll("@全体 看一下") && mentionsAll("@所有人，看一下"));
  assert(
    !mentionsAll("全体") && !mentionsAll("邮件@全体成员组"),
    "只认独立的 @ 全体写法",
  );
});

test("群资料：改名与公告；公告变更通知成员；坏输入一律拒绝", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const group = store.createChat("旧名", [atlas.id]);
  const direct = store.createChat("Atlas", [atlas.id], atlas.id);

  const updated = updateGroup(store, group.id, {
    name: "新名",
    notice: "本周收口 #44。",
  });
  assert.equal(updated.name, "新名");
  assert.equal(updated.notice, "本周收口 #44。");
  const notice = store.box(atlas.id).items.at(-1)!;
  assert.match(notice.title, /群公告 · 新名/);
  assert.equal(JSON.parse(notice.body).notice, "本周收口 #44。");

  const before = store.box(atlas.id).items.length;
  updateGroup(store, group.id, { name: "新名二", notice: "本周收口 #44。" });
  assert.equal(
    store.box(atlas.id).items.length,
    before,
    "公告没变就不打扰成员",
  );
  updateGroup(store, group.id, { name: "新名二", notice: "" });
  assert.match(store.box(atlas.id).items.at(-1)!.title, /群公告已清空/);

  for (const patch of [
    { name: "x".repeat(41), notice: "" },
    { name: "", notice: "" },
    { name: "合法", notice: "x".repeat(501) },
    { name: "合法" },
    { notice: "只给公告" },
    { name: "合法", notice: "", extra: 1 },
  ])
    assert.throws(
      () => updateGroup(store, group.id, patch),
      `应拒绝 ${JSON.stringify(patch)}`,
    );
  assert.throws(
    () => updateGroup(store, direct.id, { name: "私聊改名", notice: "" }),
    /这不是群聊/,
  );
  assert.equal(store.chat(group.id).name, "新名二", "被拒的请求不改动群资料");
});

test("移出成员：撤销读写、收回提醒、回执不再列出，坏输入拒绝", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const mira = store.createAgent("Mira", tmpdir()).agent;
  const outsider = store.createAgent("Nova", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id, mira.id]);
  const direct = store.createChat("Atlas", [atlas.id], atlas.id);

  const message = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "先看这条",
    mentions: [],
  });
  store.readChat(mira.id, group.id);
  assert(
    store.readState(group.id, 0).some((row) => row.agent_id === mira.id),
    "移出前回执里有它",
  );
  assert(store.boxCount(atlas.id) > 0, "移出前有未处理的群提醒");

  const left = removeMember(store, group.id, atlas.id);
  assert.deepEqual(left, [mira.id]);
  assert.equal(
    store.box(atlas.id).items.filter((item) => item.chat_id === group.id)
      .length,
    0,
    "本群未处理的提醒被收回",
  );
  assert.match(
    store.box(atlas.id).items.at(-1)!.title,
    /已退出群 · 协作群/,
    "只剩一条说明自己被移出的通知",
  );
  assert.throws(
    () =>
      store.send(atlas.id, { chat_id: group.id, body: "还在吗", mentions: [] }),
    /只能访问自己加入的会话/,
  );
  assert.throws(
    () => store.readChat(atlas.id, group.id),
    /只能访问自己加入的会话/,
  );
  assert.equal(
    store.timeline(group.id).items.at(-1)!.id,
    message.id,
    "群里的历史消息保留",
  );

  const removedMira = removeMember(store, group.id, mira.id);
  assert.deepEqual(removedMira, []);
  assert(
    !store.readState(group.id, 0).some((row) => row.agent_id === mira.id),
    "回执名单反映当前成员",
  );

  assert.throws(
    () => removeMember(store, group.id, outsider.id),
    /这位 Agent 不在群里/,
  );
  assert.throws(() => removeMember(store, direct.id, atlas.id), /这不是群聊/);
  assert.throws(
    () => removeMember(store, group.id, "不存在的 id"),
    /Agent 不存在/,
  );
});

test("群接口与工具边界：HTTP 坏输入拒绝，@ 全体不出现在 Agent 工具里", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-group-"));
  const { app, store } = await createApp({
    auth: false,
    data,
    runtime: false,
    desktops: join(data, "desktops"),
    piHome: join(data, ".pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const created = store.createAgent("Atlas", tmpdir());
  const group = store.createChat("协作群", [created.agent.id]);

  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(origin + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal(
    (
      await request(`/api/chats/${group.id}/profile`, "PATCH", {
        name: "新名",
        notice: "公告",
      })
    ).status,
    200,
  );
  for (const bad of [
    { name: "", notice: "" },
    { name: "合法" },
    { name: "合法", notice: "x".repeat(501) },
    { name: "合法", notice: "", pinned: true },
  ])
    assert.equal(
      (await request(`/api/chats/${group.id}/profile`, "PATCH", bad)).status,
      400,
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  // 来意只随邀请通知送出；用户建群、用户拉人不发邀请通知，写了没人能看到，当场拒绝。
  for (const [path, body] of [
    ["/api/chats", { name: "用户建群", members: [], note: "来意" }],
    [
      `/api/chats/${group.id}/members`,
      { agent_id: created.agent.id, note: "来意" },
    ],
  ] as const)
    assert.equal(
      (await request(path, "POST", body)).status,
      400,
      `用户名义不接受 note：${path}`,
    );
  assert.equal(
    (
      await request("/api/chats", "POST", {
        name: "身份建群",
        members: [],
        as: created.agent.ref,
        note: "x".repeat(501),
      })
    ).status,
    400,
    "来意超长一样拒绝",
  );
  assert.equal(
    (
      await request(
        `/api/chats/${group.id}/members/${created.agent.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/api/chats/${group.id}/members/${created.agent.id}`,
        "DELETE",
      )
    ).status,
    404,
    "已经不在群里",
  );

  const client = new Client({ name: "group-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp/${created.agent.id}`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${created.token}` },
        },
      },
    ),
  );
  t.after(() => client.close());
  const tools = await client.listTools();
  const send = tools.tools.find((tool) => tool.name === "send_message")!;
  assert(
    !Object.keys(send.inputSchema.properties ?? {}).includes("mention_all"),
    "@ 全体不暴露给 Agent",
  );
  assert(
    !tools.tools.some((tool) => /notice|rename|remove_member/i.test(tool.name)),
    "本版不给 Agent 改群名、写公告或移出成员的工具",
  );
});
