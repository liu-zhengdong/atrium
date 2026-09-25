import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { createMcp } from "../server/mcp.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "atrium.sqlite"));
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", root).agent;
  const mira = store.createAgent("Mira", root).agent;
  const group = store.createChat("移植调研", [atlas.id, mira.id]);
  const direct = store.createChat("Atlas", [atlas.id], atlas.id);
  return { root, store, atlas, mira, group, direct };
}

/** 目录里放一批文件：正常的、子目录的、隐藏的、指进来和指出去的软链接。 */
function populate(space: string, outside: string) {
  writeFileSync(join(space, "report.md"), "# 报告\n\n结论。");
  mkdirSync(join(space, "sub"));
  writeFileSync(join(space, "sub", "data.csv"), "a,b\n1,2\n");
  writeFileSync(join(space, ".hidden.md"), "不列");
  mkdirSync(join(space, ".git"));
  writeFileSync(join(space, ".git", "config"), "不列");
  writeFileSync(join(outside, "secret.txt"), "目录外");
  mkdirSync(join(outside, "dir"));
  writeFileSync(join(outside, "dir", "x.txt"), "目录外");
  symlinkSync(join(space, "report.md"), join(space, "link.md"));
  symlinkSync(join(outside, "secret.txt"), join(space, "out.txt"));
  symlinkSync(join(outside, "dir"), join(space, "outdir"));
  symlinkSync(join(space, "nowhere"), join(space, "dead"));
  // 指向目录内目录的软链接：不进去，否则同一批文件列两遍，指回上层的还会绕圈。
  symlinkSync(join(space, "sub"), join(space, "sublink"));
  symlinkSync(space, join(space, "sub", "loop"));
  // 修改时间依次变新：data.csv 最新。
  utimesSync(join(space, "report.md"), 1000, 1000);
  utimesSync(join(space, "sub", "data.csv"), 3000, 3000);
}

test("共享目录按群短号放在数据目录下，第一次用到时创建；私聊和内存库没有", (t) => {
  const { root, store, group, direct } = fixture(t);
  const chat = store.chat(group.id);
  const space = store.spaces.path(chat);
  assert.equal(space, join(root, "groups", chat.ref));
  assert(existsSync(space!));
  assert.equal(store.spaces.path(store.chat(direct.id)), null);
  const memory = new Store(":memory:");
  t.after(() => memory.close());
  assert.equal(memory.spaces.path({ kind: "group", ref: "c1" }), null);
});

test("列表：含子目录、按修改时间倒序，不列隐藏项和指向目录外的软链接", (t) => {
  const { root, store, group } = fixture(t);
  const chat = store.chat(group.id);
  const outside = join(root, "outside");
  mkdirSync(outside);
  populate(store.spaces.path(chat)!, outside);
  const listing = store.spaces.list(chat);
  assert.deepEqual(
    new Set(listing.files.map((file) => file.path)),
    new Set(["sub/data.csv", "report.md", "link.md"]),
  );
  assert.equal(listing.files[0]!.path, "sub/data.csv", "最新的在前");
  assert.equal(listing.truncated, false);
});

test("列表有上限：超过 300 个文件只给最新的 300 个并标明没列全", (t) => {
  const { store, group } = fixture(t);
  const chat = store.chat(group.id);
  const space = store.spaces.path(chat)!;
  for (let i = 0; i < 305; i++) {
    writeFileSync(join(space, `f${i}.txt`), "x");
    utimesSync(join(space, `f${i}.txt`), 1000 + i, 1000 + i);
  }
  const listing = store.spaces.list(chat);
  assert.equal(listing.files.length, 300);
  assert.equal(listing.truncated, true);
  assert.equal(listing.files[0]!.path, "f304.txt");
});

test("读文件只认目录内的相对路径：破坏输入逐个被拒", (t) => {
  const { root, store, group, direct } = fixture(t);
  const chat = store.chat(group.id);
  const space = store.spaces.path(chat)!;
  const outside = join(root, "outside");
  mkdirSync(outside);
  populate(space, outside);
  const real = (path: string) => realpathSync(join(space, path));
  assert.equal(store.spaces.file(chat, "report.md"), real("report.md"));
  assert.equal(store.spaces.file(chat, "sub/data.csv"), real("sub/data.csv"));
  assert.equal(
    store.spaces.file(chat, "link.md"),
    real("report.md"),
    "目录内的软链接可以读",
  );
  const rejected: [string, RegExp][] = [
    ["../atrium.sqlite", /相对路径/],
    ["sub/../../atrium.sqlite", /相对路径/],
    ["/etc/hosts", /相对路径/],
    [join(space, "report.md"), /相对路径/],
    ["C:\\Windows\\win.ini", /相对路径/],
    ["\\\\server\\share", /相对路径/],
    ["./report.md", /相对路径/],
    ["sub//data.csv", /相对路径/],
    [".hidden.md", /相对路径/],
    [".git/config", /相对路径/],
    ["report.md\0.png", /相对路径/],
    ["", /相对路径/],
    ["out.txt", /共享目录之外/],
    ["outdir/x.txt", /共享目录之外/],
    ["missing.md", /文件不存在/],
    ["dead", /文件不存在/],
    ["sub", /不是文件/],
  ];
  for (const [path, message] of rejected)
    assert.throws(
      () => store.spaces.file(chat, path),
      message,
      JSON.stringify(path),
    );
  assert.throws(
    () => store.spaces.file(store.chat(direct.id), "report.md"),
    /私聊没有共享目录/,
  );
});

test("HTTP：列文件、按扩展名给安全类型，直接打开也不跑脚本", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-space-http-"));
  const { app, store } = await createApp({ auth: false, data, runtime: false });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const atlas = store.createAgent("Atlas", data).agent;
  const group = store.createChat("移植调研", [atlas.id]);
  const direct = store.createChat("Atlas", [atlas.id], atlas.id);
  const space = store.spaces.path(store.chat(group.id))!;
  writeFileSync(join(space, "report.md"), "# 报告");
  writeFileSync(join(space, "evil.html"), "<script>alert(1)</script>");
  writeFileSync(
    join(space, "logo.svg"),
    "<svg><script>alert(1)</script></svg>",
  );
  writeFileSync(join(space, "data.bin"), Buffer.from([0, 1, 2]));
  const get = (url: string) => app.inject({ method: "GET", url });

  const listing = await get(`/api/chats/${group.id}/space`);
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.json().path, space);
  assert.equal(listing.json().files.length, 4);

  const file = (path: string) =>
    get(`/api/chats/${group.id}/space/file?path=${encodeURIComponent(path)}`);
  const md = await file("report.md");
  assert.equal(md.statusCode, 200);
  assert.equal(md.body, "# 报告");
  assert.match(md.headers["content-type"] as string, /^text\/plain/);
  for (const [path, type, disposition] of [
    ["evil.html", /^text\/plain/, /^inline/],
    ["logo.svg", /^image\/svg\+xml/, /^inline/],
    ["data.bin", /^application\/octet-stream/, /^attachment/],
  ] as const) {
    const response = await file(path);
    assert.match(response.headers["content-type"] as string, type, path);
    assert.match(
      response.headers["content-disposition"] as string,
      disposition,
      path,
    );
    assert.equal(response.headers["content-security-policy"], "sandbox");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  assert.equal((await file("../atrium.sqlite")).statusCode, 400);
  assert.equal((await file("missing.md")).statusCode, 404);
  assert.equal(
    (await get(`/api/chats/${direct.id}/space`)).statusCode,
    404,
    "私聊没有共享目录",
  );
});

test("MCP：群的 list_chats、read_chat、create_group 带 space，私聊不带；入群邀请写明目录", async (t) => {
  const { store, atlas, mira, group, direct } = fixture(t);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createMcp(store, atlas.id, () => {});
  await server.connect(serverSide);
  const client = new Client({ name: "space-test", version: "1" });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  const groupSpace = store.spaces.path(store.chat(group.id));

  const chats = (await call("list_chats", {})).items as {
    id: string;
    space?: string;
  }[];
  assert.equal(
    chats.find((c) => c.id === store.chatRef(group.id))!.space,
    groupSpace,
  );
  assert.equal(
    "space" in chats.find((c) => c.id === store.chatRef(direct.id))!,
    false,
  );
  assert.equal(
    (await call("read_chat", { chat_id: store.chatRef(group.id) })).space,
    groupSpace,
  );

  const created = await call("create_group", {
    name: "报告评审",
    members: [store.agentRef(mira.id)],
    note: "一起改报告",
  });
  assert(created.space && existsSync(created.space), "建群即有目录");
  const invite = store.pending(mira.id).at(-1)!.text;
  assert.equal(JSON.parse(invite.split("\n")[2]!).space, created.space);
  assert.match(invite, /报告、素材等要留存或会修订的内容放进 space/);
});
