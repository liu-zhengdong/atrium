import assert from "node:assert/strict";
import { test } from "node:test";
import type { FailureRetry } from "../shared/schema.ts";
import { retryOf, retryStateText } from "../web/agents/retry-state.ts";

const noon = Date.UTC(2026, 8, 25, 2, 40);

const waiting: FailureRetry = {
  state: "waiting",
  attempt: 1,
  max: 3,
  next_at: noon,
};
const running: FailureRetry = {
  state: "running",
  attempt: 2,
  max: 3,
  next_at: null,
};
const exhausted: FailureRetry = {
  state: "exhausted",
  attempt: 3,
  max: 3,
  next_at: null,
};
const needsAction: FailureRetry = {
  state: "needs_action",
  attempt: null,
  max: 3,
  next_at: null,
};

test("四种重试态各有自己的说法", () => {
  assert.match(
    retryStateText(waiting) ?? "",
    /^出错 · \d{2}:\d{2} 自动重试（第 1\/3 次）$/,
  );
  assert.equal(retryStateText(running), "出错 · 正在自动重试（第 2/3 次）");
  assert.equal(retryStateText(exhausted), "出错 · 已自动重试 3 次，需要处理");
  assert.equal(retryStateText(needsAction), "出错 · 需要处理");
});

test("次数上限跟着快照走，不写死 3", () => {
  assert.equal(
    retryStateText({ ...running, attempt: 1, max: 5 }),
    "出错 · 正在自动重试（第 1/5 次）",
  );
});

test("没有重试快照就不给状态，调用处保持原来的错误摘要", () => {
  assert.equal(retryStateText(null), null);
  assert.equal(retryOf({ failure: null }), null);
  assert.equal(retryOf({ failure: { text: "出错了", at: 1, count: 2 } }), null);
  assert.deepEqual(
    retryOf({
      failure: {
        text: "出错了",
        at: 1,
        count: 2,
        retry: waiting,
      },
    }),
    waiting,
  );
});
