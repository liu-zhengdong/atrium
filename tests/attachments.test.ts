import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { createMcp } from "../server/mcp.ts";
import { MAX_FILE_BYTES } from "../server/attachments.ts";
import { LOCAL_USER } from "../shared/user.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;");
const WEBP = Buffer.from("RIFF\x00\x00\x00\x00WEBP");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-att-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("Atlas", cwdA).agent;
  const b = store.createAgent("Mira", cwdB).agent;
  const chat = store.createChat("开发", [a.id]);
  return { store, a, b, chat, cwdA, cwdB, root };
}

test("图片与文件可绑定发送；空正文只带附件合法", (t) => {
  const { store, a, chat } = fixture(t);
  const image = store.stage(LOCAL_USER, "dot.png", "image/png", PNG);
  assert.equal(image.kind, "image");
  const file = store.stage(
    LOCAL_USER,
    "notes.txt",
    "text/plain",
    Buffer.from("hi"),
  );
  assert.equal(file.kind, "file");
  const message = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "",
    mentions: [],
    attachments: [image.id, file.id],
  });
  assert.equal(message.body, "");
  assert.equal(message.attachments.length, 2);
  assert.equal(
    store.readChat(a.id, chat.id).items[0].attachments[0].name,
    "dot.png",
  );
  assert.throws(() => store.discardAttachment(image.id, LOCAL_USER), /已发送/);
});

test("拒绝越权绑定、超限、空文件、超大文件和伪装图片", (t) => {
  const { store, a, chat } = fixture(t);
  const foreign = store.stage(a.id, "secret.png", "image/png", PNG);
  assert.throws(
    () =>
      store.send(LOCAL_USER, {
        chat_id: chat.id,
        body: "偷",
        mentions: [],
        attachments: [foreign.id],
      }),
    /他人的附件/,
  );
  assert.throws(
    () => store.stage(LOCAL_USER, "empty.txt", "text/plain", Buffer.alloc(0)),
    /空/,
  );
  assert.throws(
    () =>
      store.stage(
        LOCAL_USER,
        "big.bin",
        "application/octet-stream",
        Buffer.alloc(MAX_FILE_BYTES + 1),
      ),
    /10 MB/,
  );
  assert.throws(
    () =>
      store.stage(
        LOCAL_USER,
        "fake.png",
        "image/png",
        Buffer.from("<html>nope"),
      ),
    /不是有效图片/,
  );
  const ids = Array.from(
    { length: 11 },
    (_, i) =>
      store.stage(LOCAL_USER, `n${i}.txt`, "text/plain", Buffer.from("x")).id,
  );
  assert.throws(
    () =>
      store.send(LOCAL_USER, {
        chat_id: chat.id,
        body: "太多",
        mentions: [],
        attachments: ids,
      }),
    /最多 10/,
  );
  store.stage(LOCAL_USER, "page.html", "text/html", Buffer.from("<html>ok"));
});

test("jpeg/gif/webp 识别为图片；image/jpg 别名可用", (t) => {
  const { store } = fixture(t);
  assert.equal(
    store.stage(LOCAL_USER, "a.jpg", "image/jpg", JPEG).kind,
    "image",
  );
  assert.equal(
    store.stage(LOCAL_USER, "a.gif", "image/gif", GIF).kind,
    "image",
  );
  assert.equal(
    store.stage(LOCAL_USER, "a.webp", "image/webp", WEBP).kind,
    "image",
  );
  assert.equal(
    store.stage(LOCAL_USER, "a.jpg", "image/jpeg", JPEG).mime,
    "image/jpeg",
  );
});

test("Agent 只能发送工作目录内的文件；读到的文件落到自己桌面", (t) => {
  const { store, a, b, chat, cwdA, cwdB } = fixture(t);
  store.addMember(chat.id, b.id);
  writeFileSync(join(cwdA, "note.txt"), "from atlas");
  writeFileSync(join(cwdB, "other.txt"), "nope");
  const imported = store.importFile(a.id, cwdA, "note.txt");
  const message = store.send(a.id, {
    chat_id: chat.id,
    body: "附件",
    mentions: [],
    attachments: [imported.id],
  });
  assert.equal(message.attachments[0].kind, "file");
  writeFileSync(join(cwdA, "..", "secret.txt"), "nope");
  assert.throws(
    () => store.importFile(a.id, cwdA, join(cwdB, "other.txt")),
    /只能发送工作目录内的文件/,
  );
  assert.throws(
    () => store.importFile(a.id, cwdA, "../secret.txt"),
    /只能发送工作目录内的文件/,
  );
});

test("HTTP 上传、下载、删除未发送附件；发送后可取回原字节", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-att-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { app, store } = await createApp({
    auth: false,
    data: join(root, "data"),
    desktops: join(root, "desktops"),
    runtime: false,
  });
  t.after(() => app.close());
  const agent = store.createAgent("Atlas", join(root, "desk")).agent;
  mkdirSync(join(root, "desk"), { recursive: true });
  const chat = store.createChat("开发", [agent.id]);
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent("dot.png"),
      "x-mime": "image/png",
    },
    payload: PNG,
  });
  assert.equal(uploaded.statusCode, 200);
  const attachment = uploaded.json<{ id: string; kind: string }>();
  assert.equal(attachment.kind, "image");
  const preview = await app.inject({
    url: `/api/attachments/${attachment.id}`,
  });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.rawPayload, PNG);
  const sent = await app.inject({
    method: "POST",
    url: "/api/messages",
    payload: {
      chat_id: chat.id,
      body: "",
      attachments: [attachment.id],
    },
  });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json<{ attachments: unknown[] }>().attachments.length, 1);
  const empty = await app.inject({
    method: "POST",
    url: "/api/messages",
    payload: { chat_id: chat.id, body: "" },
  });
  assert.equal(empty.statusCode, 400);
  const spoof = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": "x.png",
      "x-mime": "image/png",
    },
    payload: Buffer.from("<html>"),
  });
  assert.equal(spoof.statusCode, 400);
  const staged = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": "drop.txt",
      "x-mime": "text/plain",
    },
    payload: Buffer.from("tmp"),
  });
  const stagedId = staged.json<{ id: string }>().id;
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/attachments/${stagedId}`,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: `/api/attachments/${stagedId}` })).statusCode,
    404,
  );
});

test("MCP send_message files 与 read_chat 图片块；拒绝目录外路径", async (t) => {
  const { store, a, b, chat, cwdA, cwdB } = fixture(t);
  store.addMember(chat.id, b.id);
  writeFileSync(join(cwdA, "brief.md"), "# hi");
  const image = store.stage(LOCAL_USER, "dot.png", "image/png", PNG);
  store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "见图",
    mentions: [],
    attachments: [image.id],
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createMcp(store, a.id, () => {});
  await server.connect(serverSide);
  const client = new Client({ name: "att-test", version: "1" });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const sent = await client.callTool({
    name: "send_message",
    arguments: { chat_id: chat.ref, body: "文档", files: ["brief.md"] },
  });
  assert(!sent.isError, JSON.stringify(sent));
  const outside = await client.callTool({
    name: "send_message",
    arguments: { chat_id: chat.ref, body: "偷", files: [join(cwdB, "x")] },
  });
  assert(outside.isError);
  const read = await client.callTool({
    name: "read_chat",
    arguments: { chat_id: chat.ref },
  });
  assert(!read.isError);
  const content = read.content as Array<{
    type: string;
    text?: string;
    mimeType?: string;
  }>;
  const page = JSON.parse(content[0]!.text!);
  assert(
    page.items.some((m: { attachments: { name: string }[] }) =>
      m.attachments.some((item) => item.name === "brief.md" && "path" in item),
    ),
  );
  assert(
    content.some(
      (block) => block.type === "image" && block.mimeType === "image/png",
    ),
  );
});
