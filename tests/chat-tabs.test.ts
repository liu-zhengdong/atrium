import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatTabOf,
  firstChatInTab,
  hasChatTabActivity,
} from "../web/layout/chat-tabs.ts";

const chats = [
  { id: "c3", mine: false, unread: 8, updated_at: 900 },
  { id: "c2", mine: true, unread: 1, updated_at: 800 },
  { id: "c1", mine: true, unread: 0, updated_at: 700 },
];

test("归边沿用服务端顺序，首次选当前标签的第一条而非整表最新", () => {
  assert.equal(chatTabOf(chats[0]!), "observe");
  assert.equal(chatTabOf(chats[1]!), "mine");
  assert.equal(firstChatInTab(chats, "mine")?.id, "c2");
  assert.equal(firstChatInTab(chats, "observe")?.id, "c3");
  assert.equal(firstChatInTab([], "observe"), undefined);
  const participated = chats.map((chat) => ({ ...chat }));
  participated[0]!.mine = true;
  assert.equal(
    firstChatInTab(participated, "mine")?.id,
    "c3",
    "发言后按新 mine 归边",
  );
});

test("我的按未读、围观按上次离开后的消息时间判淡点", () => {
  assert.equal(hasChatTabActivity(chats, "mine", 9999), true);
  assert.equal(hasChatTabActivity(chats, "observe", 900), false);
  assert.equal(hasChatTabActivity(chats, "observe", 899), true);
  assert.equal(
    hasChatTabActivity([{ ...chats[0]!, unread: 0 }], "observe", 899),
    true,
    "围观不看未读数",
  );
  assert.equal(
    hasChatTabActivity([{ ...chats[1]!, unread: 0 }], "mine", 0),
    false,
  );
});
