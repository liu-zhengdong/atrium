import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/legacy-app.ts";
import {
  fileRecords,
  likeOf,
  messageRecords,
  recordConditions,
  recordQuery,
} from "../server/records.ts";
import { LOCAL_USER } from "../shared/user.ts";
import {
  dayStart,
  emptyFilters,
  rangeError,
  recordsPath,
} from "../web/records/query.ts";

test("筛选拼成请求：空筛选不带参数，日期按当地整天算", () => {
  assert.equal(recordsPath("messages", emptyFilters), "/records/messages");
  assert.equal(
    recordsPath("images", emptyFilters),
    "/records/files?kind=image",
  );
  assert.equal(recordsPath("files", emptyFilters), "/records/files?kind=file");

  const path = recordsPath(
    "files",
    {
      chat: "c1",
      sender: "u1",
      from: "2026-09-21",
      to: "2026-09-21",
      q: "  说明  ",
    },
    42,
  );
  const params = new URLSearchParams(path.slice(path.indexOf("?")));
  assert.equal(params.get("chat"), "c1");
  assert.equal(params.get("sender"), "u1");
  assert.equal(params.get("kind"), "file");
  assert.equal(params.get("before"), "42");
  assert.equal(params.get("q"), "说明", "关键词去掉首尾空格");
  const from = new Date(Number(params.get("from")));
  const to = new Date(Number(params.get("to")));
  assert.deepEqual(
    [from.getHours(), from.getDate()],
    [0, 21],
    "开始取当天零点",
  );
  assert.deepEqual(
    [to.getHours(), to.getDate()],
    [0, 22],
    "结束取次日零点，选中的那天整天都算在内",
  );
});

test("筛选拼请求反向验证：非法日期不生效，颠倒的范围当场说明", () => {
  for (const bad of ["", "今天", "2026-9-1", "2026-13-45"])
    assert.equal(dayStart(bad), undefined, `${bad} 不是有效日期`);
  assert.equal(
    recordsPath("messages", { ...emptyFilters, from: "乱写" }),
    "/records/messages",
    "无效日期不拼进请求",
  );
  assert.equal(
    rangeError({ ...emptyFilters, from: "2026-09-22", to: "2026-09-21" }),
    "开始日期要早于结束日期",
  );
  assert.equal(
    rangeError({ ...emptyFilters, from: "2026-09-21", to: "2026-09-21" }),
    "",
    "同一天是合法范围",
  );
  assert.equal(rangeError(emptyFilters), "");
});

const messageColumns = {
  chat: "m.chat_id",
  sender: "m.sender",
  time: "m.created_at",
  cursor: "m.id",
  keyword: "m.body",
};
const fileColumns = {
  chat: "t.chat_id",
  sender: "t.uploader",
  time: "t.created_at",
  cursor: "t.rowid",
  kind: "t.kind",
  keyword: "t.name",
};
const CURSOR_END = Number.MAX_SAFE_INTEGER;

test("筛选翻译成 SQL：每个条件各自出现，顺序与参数对应", () => {
  assert.deepEqual(recordConditions({}, messageColumns), {
    where: "m.id<?",
    params: [CURSOR_END],
  });
  assert.deepEqual(recordConditions({ chat: "x" }, messageColumns), {
    where: "m.chat_id=? AND m.id<?",
    params: ["x", CURSOR_END],
  });
  assert.deepEqual(
    recordConditions(
      { chat: "x", sender: "u1", from: 10, to: 20, q: "hi", before: 99 },
      messageColumns,
    ),
    {
      where:
        "m.chat_id=? AND m.sender=? AND m.created_at>=? AND m.created_at<? AND m.body LIKE ? ESCAPE '\\' AND m.id<?",
      params: ["x", "u1", 10, 20, "%hi%", 99],
    },
  );
  assert.deepEqual(
    recordConditions({ kind: "image", sender: "u1" }, fileColumns),
    {
      where: "t.uploader=? AND t.kind=? AND t.rowid<?",
      params: ["u1", "image", CURSOR_END],
    },
  );
});

test("筛选翻译反向验证：列不存在的条件不进 SQL，通配符按字面处理", () => {
  // 消息没有 kind 列，类型筛选不该凭空拼出一个条件。
  assert.deepEqual(recordConditions({ kind: "file" }, messageColumns), {
    where: "m.id<?",
    params: [CURSOR_END],
  });
  // 同一个关键词，消息比正文、附件比文件名。
  assert.deepEqual(
    recordConditions({ q: "hi" }, messageColumns).where,
    "m.body LIKE ? ESCAPE '\\' AND m.id<?",
  );
  assert.deepEqual(
    recordConditions({ q: "hi" }, fileColumns).where,
    "t.name LIKE ? ESCAPE '\\' AND t.rowid<?",
  );
  assert.equal(likeOf("100%_a\\b"), "%100\\%\\_a\\\\b%");
});

test("查询参数校验：坏输入一律拒绝", () => {
  assert.deepEqual(recordQuery.parse({}), {});
  assert.deepEqual(recordQuery.parse({ chat: "c1", before: "30" }), {
    chat: "c1",
    before: 30,
  });
  const rejects = [
    { case: "时间范围颠倒", input: { from: 20, to: 10 } },
    { case: "时间范围相等", input: { from: 10, to: 10 } },
    { case: "会话短号非法", input: { chat: "c0" } },
    { case: "发送者短号非法", input: { sender: "x9" } },
    { case: "类型不认识", input: { kind: "video" } },
    { case: "关键词超长", input: { q: "词".repeat(101) } },
    { case: "游标为零", input: { before: 0 } },
    { case: "游标为负", input: { before: -5 } },
    { case: "多余字段", input: { evil: 1 } },
  ];
  for (const { case: label, input } of rejects)
    assert.equal(
      recordQuery.safeParse(input).success,
      false,
      `${label} 应被拒绝`,
    );
});

function seed(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id]);
  const other = store.createChat("另一个群", [atlas.id]);
  const attach = (
    chat: string,
    name: string,
    mime: string,
    body: string | Buffer,
  ) => {
    const staged = store.stage(
      LOCAL_USER,
      name,
      mime,
      Buffer.isBuffer(body) ? body : Buffer.from(body),
    );
    store.send(LOCAL_USER, {
      chat_id: chat,
      body: "带附件",
      mentions: [],
      attachments: [staged.id],
    });
    return staged.id;
  };
  return { store, atlas, group, other, attach };
}

test("聊天记录：会话、发送者、类型三个筛选各自生效，跨会话也能查", (t) => {
  const { store, atlas, group, other, attach } = seed(t);
  attach(group.id, "说明.txt", "text/plain", "hello");
  attach(other.id, "别处.txt", "text/plain", "nope");
  // 1×1 PNG，让分类器真的认出图片（它会嗅字节，不只看 mime）。
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
      "01f15c4890000000a49444154789c6300010000050001" +
      "0d0a2db40000000049454e44ae426082",
    "hex",
  );
  attach(group.id, "图.png", "image/png", png);
  store.send(LOCAL_USER, { chat_id: group.id, body: "找得到我", mentions: [] });
  store.send(LOCAL_USER, { chat_id: other.id, body: "找得到我", mentions: [] });
  store.send(atlas.id, { chat_id: group.id, body: "找得到我", mentions: [] });

  const inGroup = messageRecords(store, { chat: group.id, q: "找得到我" });
  assert.equal(inGroup.items.length, 2, "限定会话就只看这个会话");
  assert.deepEqual(
    new Set(inGroup.items.map((m) => m.chat_name)),
    new Set(["协作群"]),
  );

  const everywhere = messageRecords(store, { q: "找得到我" });
  assert.equal(everywhere.items.length, 3, "不限定会话就跨会话找");
  assert.deepEqual(
    new Set(everywhere.items.map((m) => m.chat_name)),
    new Set(["协作群", "另一个群"]),
  );

  const mine = messageRecords(store, { q: "找得到我", sender: LOCAL_USER });
  assert.equal(mine.items.length, 2, "按发送者筛");
  assert.deepEqual(
    new Set(mine.items.map((m) => m.sender_name)),
    new Set(["你"]),
  );
  assert.equal(
    messageRecords(store, { q: "找得到我", sender: atlas.id }).items[0]
      ?.sender_name,
    "Atlas",
  );

  assert.deepEqual(
    fileRecords(store, { chat: group.id, kind: "file" }).items.map(
      (f) => f.name,
    ),
    ["说明.txt"],
    "文件列表只看本会话且只看文件",
  );
  assert.deepEqual(
    fileRecords(store, { chat: group.id, kind: "image" }).items.map(
      (f) => f.name,
    ),
    ["图.png"],
    "图片与文件分开",
  );
  const allFiles = fileRecords(store, { kind: "file" });
  assert.deepEqual(
    allFiles.items.map((f) => [f.name, f.chat_name]),
    [
      ["别处.txt", "另一个群"],
      ["说明.txt", "协作群"],
    ],
    "跨会话的文件按时间倒序，并带上所属会话",
  );
  assert.equal(allFiles.items[0]!.uploader_name, "你");
  assert.deepEqual(
    fileRecords(store, { kind: "file", q: "说明" }).items.map((f) => f.name),
    ["说明.txt"],
    "关键词在附件里比对文件名",
  );
  assert.equal(
    fileRecords(store, { kind: "file", q: "带附件" }).items.length,
    0,
    "比的是文件名，不是消息正文",
  );
});

test("聊天记录反向验证：关键词不跨类型，通配符不放大，时间范围两端闭合方式一致", (t) => {
  const { store, group, attach } = seed(t);
  store.send(LOCAL_USER, {
    chat_id: group.id,
    body: "100% 确定",
    mentions: [],
  });
  store.send(LOCAL_USER, { chat_id: group.id, body: "毫无关系", mentions: [] });
  attach(group.id, "记录.txt", "text/plain", "x");

  assert.deepEqual(
    messageRecords(store, { q: "%" }).items.map((m) => m.text),
    ["100% 确定"],
    "通配符按字面搜索：只命中真的带 % 的那条，不是全部消息",
  );
  assert.equal(messageRecords(store, { q: "100%" }).items.length, 1);
  assert.equal(
    messageRecords(store, { q: "_" }).items.length,
    0,
    "单字符通配符同样不放大",
  );

  const all = messageRecords(store, {}).items;
  const middle = all[1]!.created_at;
  assert.equal(
    messageRecords(store, { from: middle }).items.every(
      (m) => m.created_at >= middle,
    ),
    true,
    "from 含当刻",
  );
  assert.equal(
    messageRecords(store, { to: middle }).items.some(
      (m) => m.created_at === middle,
    ),
    false,
    "to 不含当刻",
  );
});

test("聊天记录翻页：游标是上一页最后一条，不重不漏", (t) => {
  const { store, group } = seed(t);
  for (let i = 1; i <= 95; i++)
    store.send(LOCAL_USER, {
      chat_id: group.id,
      body: `第 ${i} 条`,
      mentions: [],
    });
  const seen: number[] = [];
  let before: number | undefined;
  for (let page = 0; page < 5; page++) {
    const result = messageRecords(store, { chat: group.id, before });
    seen.push(...result.items.map((m) => m.id));
    if (!result.has_more) break;
    before = result.items.at(-1)!.id;
  }
  assert.equal(seen.length, 95);
  assert.equal(new Set(seen).size, 95, "翻页不重复");
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => b - a),
    "始终倒序",
  );
  assert.equal(
    messageRecords(store, { chat: group.id, before: 1 }).items.length,
    0,
    "游标越过最早一条就是空页，不报错",
  );
});

test("既有库升级：附件补上 chat_id，暂存未发送的留空", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-records-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "atrium.sqlite");
  const first = new Store(path);
  const atlas = first.createAgent("Atlas", tmpdir()).agent;
  const group = first.createChat("协作群", [atlas.id]);
  const staged = first.stage(
    LOCAL_USER,
    "说明.txt",
    "text/plain",
    Buffer.from("hello"),
  );
  first.send(LOCAL_USER, {
    chat_id: group.id,
    body: "带附件",
    mentions: [],
    attachments: [staged.id],
  });
  // 还没发出去的暂存件：没有归属会话。
  first.stage(LOCAL_USER, "草稿.txt", "text/plain", Buffer.from("draft"));
  // 退回到加列之前的样子，再打开一次走迁移。
  first.run("DROP INDEX attachments_chat");
  first.run("DROP INDEX attachments_kind");
  first.run("ALTER TABLE attachments DROP COLUMN chat_id");
  assert.equal(first.columns("attachments").includes("chat_id"), false);
  first.close();

  const second = new Store(path);
  t.after(() => second.close());
  const rows = second
    .all<{ name: string; chat_id: string | null }>(
      "SELECT name, chat_id FROM attachments ORDER BY rowid",
    )
    .map((row) => ({ name: row.name, chat_id: row.chat_id }));
  assert.deepEqual(rows, [
    { name: "说明.txt", chat_id: group.id },
    { name: "草稿.txt", chat_id: null },
  ]);
  assert.deepEqual(
    fileRecords(second, { chat: group.id, kind: "file" }).items.map(
      (f) => f.name,
    ),
    ["说明.txt"],
    "回填后旧附件照样查得到",
  );
});

test("聊天记录接口：短号解析、越权与坏输入拒绝", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-records-api-"));
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
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/records`;
  const atlas = store.createAgent("Atlas", tmpdir()).agent;
  const group = store.createChat("协作群", [atlas.id]);
  store.send(LOCAL_USER, { chat_id: group.id, body: "记一笔", mentions: [] });
  const ref = store.chatRef(group.id);

  const ok = await fetch(
    `${base}/messages?chat=${ref}&q=${encodeURIComponent("记一笔")}`,
  );
  assert.equal(ok.status, 200);
  const page = (await ok.json()) as { items: { chat_ref: string }[] };
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.chat_ref, ref, "短号解析后原样返回");

  const rejects: [string, string][] = [
    ["不存在的会话", "messages?chat=c999"],
    ["非法会话短号", "messages?chat=c0"],
    ["不存在的发送者", "messages?sender=a999"],
    ["时间范围颠倒", "messages?from=200&to=100"],
    ["游标越界", "files?before=0"],
    ["类型不认识", "files?kind=video"],
    ["多余字段", "files?evil=1"],
  ];
  for (const [label, path] of rejects) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.ok, false, `${label} 应被拒绝`);
    assert.equal(
      typeof ((await response.json()) as { error?: string }).error,
      "string",
      `${label} 要给出说明`,
    );
  }
});
