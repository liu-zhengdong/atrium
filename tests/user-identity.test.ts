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
import { readUser, writeUser } from "../server/users.ts";
import { LOCAL_USER } from "../shared/user.ts";
import type { Overview } from "../shared/schema.ts";

function tempDir(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-user-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("新库自带 u1 且资料为空；旧库里 'user' 的消息与附件迁到短号", (t) => {
  const fresh = new Store(":memory:");
  t.after(() => fresh.close());
  assert.deepEqual(
    { ...readUser(fresh), updated_at: 0 },
    { id: LOCAL_USER, name: "", profile: "", updated_at: 0 },
  );

  const path = join(tempDir(t), "legacy.sqlite");
  const before = new Store(path);
  const agent = before.createAgent("Atlas", tmpdir()).agent;
  const chat = before.createChat("旧会话", [agent.id]);
  // 旧版本写下的行：发送者与上传者都是字面量 'user'。
  const legacyAttachment = randomUUID();
  before.run(
    "INSERT INTO messages(chat_id,sender,body,mentions,created_at) VALUES(?,'user','旧消息','[]',?)",
    chat.id,
    Date.now(),
  );
  before.run(
    "INSERT INTO attachments(id,message_id,uploader,kind,name,mime,size,created_at) VALUES(?,NULL,'user','file','旧附件.txt','text/plain',3,?)",
    legacyAttachment,
    Date.now(),
  );
  before.close();

  const after = new Store(path);
  t.after(() => after.close());
  assert.equal(after.timeline(chat.id).items[0]!.sender, LOCAL_USER);
  assert.equal(
    after.one<{ uploader: string }>(
      "SELECT uploader FROM attachments WHERE id=?",
      legacyAttachment,
    )?.uploader,
    LOCAL_USER,
    "附件归属跟着发送者一起迁移，否则用户带附件发消息会被当成他人的附件",
  );
  assert.equal(
    after.chats().find((c) => c.id === chat.id)?.mine,
    true,
    "迁移后历史仍算作用户参与的会话",
  );
  const reused = after.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "带上旧附件",
    mentions: [],
    attachments: [legacyAttachment],
  });
  assert.equal(reused.attachments[0]?.id, legacyAttachment);
});

test("用户发言：短号进入投递与回执，名字取资料里的称呼", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const mira = store.createAgent("Mira", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id, mira.id]);

  const anonymous = store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "看一下这个",
    mentions: [atlas.id],
  });
  const firstDelivery = store.pending(atlas.id).at(-1)!;
  assert.match(firstDelivery.text, /"sender":"u1"/);
  assert.match(
    firstDelivery.text,
    /"sender_name":"用户"/,
    "没填资料时用中性称呼",
  );

  writeUser(store, LOCAL_USER, { name: "老刘", profile: "在做 Atrium。" });
  store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "再看一下",
    mentions: [atlas.id],
  });
  const delivery = store.pending(atlas.id).at(-1)!;
  assert.match(delivery.text, /"sender":"u1"/);
  assert.match(delivery.text, /"sender_name":"老刘"/);
  const notice = store.box(mira.id).items.at(-1)!;
  assert.equal(
    JSON.parse(notice.body).from_name,
    "老刘",
    "群消息箱提醒与投递用同一个称呼",
  );

  store.markUserRead(group.id, anonymous.id);
  const state = store.readState(group.id, 0);
  const self = state.find((row) => row.agent_id === LOCAL_USER);
  assert(self, "用户的已读位置也用短号");
  assert.equal(self.name, "你", "界面上用户看到的是自己");
  assert.equal(
    state.filter((row) => row.agent_id !== anonymous.sender).length,
    state.length - 1,
    "回执名单按发送者短号排除作者自己",
  );
});

test("user_info 与 /api/user：真实 MCP 只读、坏输入一律拒绝", async (t) => {
  const data = tempDir(t);
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
  });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const created = store.createAgent("Atlas", tmpdir());
  const client = new Client({ name: "atrium-user-test", version: "1" });
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
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "user_info",
      arguments: args,
    });
    const text = (result.content as { type: string; text?: string }[])
      .map((part) => part.text ?? "")
      .join("");
    return { isError: !!result.isError, text };
  };

  const empty = await call({ user_id: LOCAL_USER });
  assert(!empty.isError);
  assert.match(empty.text, /还没有填写资料/, "空资料是正常空态，不是错误");

  const patch = async (body: unknown) =>
    fetch(`${origin}/api/user`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await patch({ name: "老刘", profile: "在做 Atrium。" })).status,
    200,
  );
  const filled = await call({ user_id: LOCAL_USER });
  assert(!filled.isError);
  assert.equal(JSON.parse(filled.text).name, "老刘");
  assert.equal(JSON.parse(filled.text).profile, "在做 Atrium。");
  assert(!("note" in JSON.parse(filled.text)), "填了资料就不再提示空态");

  for (const args of [
    { user_id: "u2" },
    { user_id: "a1" },
    { user_id: created.agent.id },
    { user_id: "" },
    { user_id: "u01" },
    { user_id: `u${"9".repeat(40)}` },
    { user_id: LOCAL_USER, extra: 1 },
    {},
  ]) {
    const rejected = await call(args);
    assert(rejected.isError, `应拒绝 ${JSON.stringify(args)}`);
  }

  const tools = await client.listTools();
  const userInfo = tools.tools.find((tool) => tool.name === "user_info")!;
  assert(userInfo, "user_info 在固定 MCP 上可发现");
  assert(
    !tools.tools.some((tool) => /user.*(update|write|set)/i.test(tool.name)),
    "本版不给 Agent 写资料的工具",
  );

  for (const body of [
    { name: "x".repeat(41), profile: "" },
    { name: "", profile: "x".repeat(4001) },
    { name: "老\n刘", profile: "" },
    { name: "老刘" },
    { name: "老刘", profile: "", id: "u2" },
    { name: "老刘", profile: "", note: "试图注入" },
  ]) {
    assert.equal(
      (await patch(body)).status,
      400,
      `应拒绝 ${JSON.stringify(body)}`,
    );
  }
  assert.equal(readUser(store).name, "老刘", "拒绝的请求不改动已存资料");

  const overview = (await (
    await fetch(`${origin}/api/overview`)
  ).json()) as Overview;
  assert.equal(overview.user.id, LOCAL_USER);
  assert.equal(overview.user.name, "老刘");
});
