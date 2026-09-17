import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../shared/schema.ts";
import { mergeMessages } from "../web/chat/messages.ts";

const message = (id: number, chat_id = "a", body = "message"): Message => ({
  id,
  chat_id,
  body,
  sender: "user",
  mentions: [],
  created_at: id,
});

test("聊天历史：实时刷新与旧页合并后有序、去重、保留已加载历史", () => {
  const current = [message(200), message(201)];
  const refreshed = mergeMessages(current, [message(201), message(202)], "a");
  assert.deepEqual(
    refreshed.map((m) => m.id),
    [200, 201, 202],
  );
  assert.deepEqual(
    mergeMessages(
      refreshed,
      [message(198), message(199), message(200)],
      "a",
    ).map((m) => m.id),
    [198, 199, 200, 201, 202],
  );
  assert.equal(current.length, 2, "不修改原状态");
});

test("聊天历史反向验证：旧会话与混入页面的异会话消息均不进入当前时间线", () => {
  const result = mergeMessages(
    [message(9, "other"), message(11)],
    [message(12, "other"), message(10), message(11, "a", "refreshed")],
    "a",
  );
  assert.deepEqual(
    result.map((m) => [m.id, m.body]),
    [
      [10, "message"],
      [11, "refreshed"],
    ],
  );
});
