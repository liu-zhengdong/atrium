import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { LOCAL_USER } from "../shared/user.ts";

/** 每个会话在各张表里的行数：删掉一个群，另一个群的每张表都要一行不少。 */
function rows(store: Store, chatId: string) {
  const count = (table: string) =>
    store.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE chat_id=?`,
      chatId,
    )!.n;
  return {
    messages: count("messages"),
    members: count("members"),
    attachments: count("attachments"),
    inbox: count("inbox"),
    deliveries: count("deliveries"),
    user_reads: count("user_reads"),
    user_chat_state: count("user_chat_state"),
    chat_read_ranges: count("chat_read_ranges"),
    chat_refs: count("chat_refs"),
  };
}

const empty = {
  messages: 0,
  members: 0,
  attachments: 0,
  inbox: 0,
  deliveries: 0,
  user_reads: 0,
  user_chat_state: 0,
  chat_read_ranges: 0,
  chat_refs: 0,
};

/**
 * 两个内容相同的群：消息、附件、共享文件、已读、消息箱提醒、投递记录都造齐。
 * 第三个身份只属于要删的群，用来看它有没有被唤醒。
 */
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-disband-"));
  const data = join(root, "data");
  const { app, store } = await createApp({
    data,
    desktops: join(root, "desktops"),
    piHome: join(root, ".pi"),
    runtime: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const atlas = store.createAgent("Atlas", root).agent;
  const mira = store.createAgent("Mira", root).agent;
  const solo = store.createAgent("Solo", root).agent;
  const populate = (name: string, members: string[]) => {
    const group = store.createChat(name, members);
    const chat = store.chat(group.id);
    const space = store.spaces.path(chat)!;
    writeFileSync(join(space, "report.md"), `# ${name} 的报告`);
    mkdirSync(join(space, "sub"));
    writeFileSync(join(space, "sub", "data.csv"), "a,b\n1,2\n");
    const file = store.stage(
      LOCAL_USER,
      "note.txt",
      "text/plain",
      Buffer.from("附件内容"),
    );
    const message = store.send(LOCAL_USER, {
      chat_id: chat.id,
      body: `看下附件 · ${name}`,
      mentions: [mira.id],
      attachments: [file.id],
    });
    store.readChat(atlas.id, chat.id);
    store.markUserRead(chat.id, message.id);
    store.setChatPinned(chat.id, true);
    return { chat, space, file, message, rows: rows(store, chat.id) };
  };
  const doomed = populate("要删的群", [atlas.id, mira.id, solo.id]);
  const kept = populate("保留的群", [atlas.id, mira.id]);
  const direct = store.createChat("Atlas", [atlas.id], atlas.id);
  return { data, app, store, atlas, mira, solo, doomed, kept, direct };
}

test("预览：说清将删掉多少东西，群名对不上、私聊、不存在的会话都拒绝", async (t) => {
  const { app, store, doomed, direct } = await fixture(t);
  const preview = await app.inject({
    url: `/api/chats/${doomed.chat.id}/deletion`,
  });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json(), {
    ref: doomed.chat.ref,
    name: "要删的群",
    members: 3,
    messages: 1,
    attachments: 1,
    files: 2,
    files_truncated: false,
  });
  const remove = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "DELETE", url, payload });
  const url = `/api/chats/${doomed.chat.id}`;
  assert.equal((await remove(url, { confirm: "保留的群" })).statusCode, 400);
  assert.equal((await remove(url, { confirm: "要删的群 " })).statusCode, 400);
  assert.equal((await remove(url, {})).statusCode, 400);
  assert.equal(
    (await remove(url, { confirm: "要删的群", force: true })).statusCode,
    400,
  );
  const dm = await remove(`/api/chats/${direct.id}`, { confirm: direct.name });
  assert.equal(dm.statusCode, 400);
  assert.match(dm.json().error, /这不是群聊/);
  assert.equal(
    (await remove(`/api/chats/${randomUUID()}`, { confirm: "要删的群" }))
      .statusCode,
    404,
  );
  // 一次都没删成：行数、文件、会话入口原样。
  assert.deepEqual(rows(store, doomed.chat.id), doomed.rows);
  assert(store.chat(doomed.chat.id));
  assert(existsSync(join(doomed.space, "report.md")));
});

test("确认后：群与全部历史、文件、提醒一起消失，另一个群一行不少", async (t) => {
  const { data, app, store, atlas, mira, solo, doomed, kept } =
    await fixture(t);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/chats/${doomed.chat.id}`,
    payload: { confirm: "要删的群" },
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), {
    ref: doomed.chat.ref,
    name: "要删的群",
    members: 3,
    messages: 1,
    attachments: 1,
    files: 2,
    files_truncated: false,
    failed: [],
  });
  // 目标群的行全没了，连群本身和短号都在。
  assert.deepEqual(rows(store, doomed.chat.id), empty);
  assert.equal(
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM chats WHERE id=?",
      doomed.chat.id,
    )!.n,
    0,
  );
  // 另一个群一行不少。
  assert.deepEqual(rows(store, kept.chat.id), kept.rows);
  assert.equal(store.timeline(kept.chat.id).items.length, 1);
  // 文件：共享目录整棵删掉，附件文件删掉；另一个群的原样。
  assert(!existsSync(doomed.space));
  assert(!existsSync(join(data, "attachments", doomed.file.id)));
  assert(existsSync(join(kept.space, "sub", "data.csv")));
  assert(existsSync(join(data, "attachments", kept.file.id)));
  // 会话入口：读、写、拉人都不认这个群。
  assert.throws(() => store.chat(doomed.chat.id), /不存在/);
  assert(!store.chats().some((chat) => chat.id === doomed.chat.id));
  assert(store.chats().some((chat) => chat.id === kept.chat.id));
  assert.throws(() => store.readChat(atlas.id, doomed.chat.id));
  assert.throws(() =>
    store.send(atlas.id, {
      chat_id: doomed.chat.id,
      body: "还在吗",
      mentions: [],
    }),
  );
  assert.throws(() => store.addMember(doomed.chat.id, mira.id));
  // 搜索查不到，未读里也没有。
  assert.deepEqual(
    store.search("看下附件").messages.map((hit) => hit.chat_name),
    ["保留的群"],
  );
  assert(
    !store.unread(mira.id).some((item) => item.chat_id === doomed.chat.id),
  );
  // 短号不复用。
  const fresh = store.chat(store.createChat("新群", [atlas.id, mira.id]).id);
  assert(Number(fresh.ref.slice(1)) > Number(doomed.chat.ref.slice(1)));
  // 成员各收到一条系统通知；本群的未处理提醒已收回，只属于它的身份没有被唤醒。
  for (const agent of [atlas, mira, solo]) {
    const box = store.box(agent.id, 0, false).items;
    assert(
      box.some(
        (item) => item.source === "system" && item.title.includes("要删的群"),
      ),
      `${agent.name} 收到系统通知`,
    );
    assert(!box.some((item) => item.chat_id === doomed.chat.id));
  }
  assert(store.pending(mira.id).some((item) => item.chat_id === kept.chat.id));
  assert(
    !store.pending(mira.id).some((item) => item.chat_id === doomed.chat.id),
  );
  // 只属于要删的群的身份：投递队列空了，消息箱里只剩那一条系统通知。
  assert.equal(store.pending(solo.id).length, 0);
  const soloBox = store.box(solo.id, 0, false).items;
  assert.equal(soloBox.length, 1, "只多了那条系统通知");
  assert.equal(soloBox[0]!.source, "system");
  // 重开数据库也读不到。
  const reopened = new Store(join(data, "atrium.sqlite"));
  try {
    assert.throws(() => reopened.chat(doomed.chat.id), /不存在/);
    assert.equal(reopened.timeline(kept.chat.id).items.length, 1);
  } finally {
    reopened.close();
  }
});
