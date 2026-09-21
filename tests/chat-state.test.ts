import { mergeReadState } from "../web/chat/readState.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../shared/schema.ts";
import { mergeMessages } from "../web/chat/messages.ts";
import { LOCAL_USER } from "../shared/user.ts";

const message = (id: number, chat_id = "a", body = "message"): Message => ({
  id,
  mention_all: false,
  chat_id,
  body,
  sender: LOCAL_USER,
  mentions: [],
  created_at: id,
  attachments: [],
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

test("后端更新前缺少回执字段时不崩溃，也不推测任何 Agent 已读", () => {
  assert.deepEqual(mergeReadState([], undefined), []);
});

test("历史页与实时回执交错时保留阅读证据，不回退或误合并缺口", () => {
  const previous = [
    {
      agent_id: "a",
      through: 5,
      ranges: [
        { first: 10, last: 12 },
        { first: 20, last: 22 },
      ],
    },
  ];
  const result = mergeReadState(previous, [
    { agent_id: "a", through: 3, ranges: [{ first: 21, last: 24 }] },
  ]);
  assert.deepEqual(result, [
    {
      agent_id: "a",
      through: 5,
      ranges: [
        { first: 10, last: 12 },
        { first: 20, last: 24 },
      ],
    },
  ]);
  assert.equal(previous[0].ranges[1].last, 22, "不修改原快照");
  assert.deepEqual(
    mergeReadState(result, [{ agent_id: "a", through: 24, ranges: [] }]),
    [{ agent_id: "a", through: 24, ranges: [] }],
  );
});
