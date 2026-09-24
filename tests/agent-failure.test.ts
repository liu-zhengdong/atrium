import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentTransition,
  type AgentEvent,
  type AgentFailure,
} from "../server/agent-failure.ts";
import { Store } from "../server/store.ts";
import { RequestError } from "@agentclientprotocol/sdk";
import { errorWithDetails } from "../server/runtime-error.ts";
import { LOCAL_USER } from "../shared/user.ts";

const previous: AgentFailure[] = [null, { text: "old", at: 100, count: 2 }];
const events: AgentEvent[] = [
  { kind: "failure", text: "new", at: 200 },
  { kind: "success" },
  { kind: "heartbeat" },
  { kind: "direct" },
  { kind: "retry" },
];
test("JSON-RPC 错误详情持久化，恢复工作后清除", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const agent = store.createAgent("诊断测试", tmpdir()).agent;
  const text = errorWithDetails(
    RequestError.internalError({ details: "缺少运行扩展" }),
  );
  assert.match(text, /data: \{"details":"缺少运行扩展"\}/);
  store.setFailure(agent.id, text, 100);
  assert.match(store.failure(agent.id)!.text, /缺少运行扩展/);
  store.clearFailure(agent.id);
  assert.equal(store.failure(agent.id), null);
  assert.equal(errorWithDetails(new Error("普通错误")), "Error: 普通错误");
});

test("Agent 状态事件矩阵：失败递增、成功清除、仅心跳被封锁", () => {
  for (const before of previous)
    for (const event of events) {
      const result = agentTransition(before, event);
      if (event.kind === "failure") {
        assert.deepEqual(result.failure, {
          text: "new",
          at: 200,
          count: before ? 3 : 1,
        });
        assert.equal(result.read, false);
      } else if (event.kind === "success") {
        assert.equal(result.failure, null);
        assert.equal(result.read, true);
      } else {
        assert.deepEqual(result.failure, before);
        assert.equal(result.wake, event.kind !== "heartbeat" || !before);
        assert.equal(result.read, false);
      }
    }
  assert.equal(
    agentTransition(null, { kind: "failure", text: "x".repeat(9000), at: 1 })
      .failure?.text.length,
    9000,
  );
});

test("成功轮的 run_end 早于 deliver 回执：重启后失败只重投本轮", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atrium-delivery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "atrium.db");
  let store = new Store(path);
  const agent = store.createAgent("游标测试", directory).agent;
  const chat = store.createChat("群聊", [agent.id]);
  const old = Array.from({ length: 24 }, (_, index) =>
    store.send(LOCAL_USER, {
      chat_id: chat.id,
      body: `旧消息 ${index}`,
      mentions: [agent.id],
    }),
  );
  for (const delivery of store.pending(agent.id)) store.accepted(delivery.id);
  // 运行事件的时间早于 deliver RPC 确认时间；这些消息已经成功处理。
  store.finishTurn(agent.id, true);
  assert.equal(
    store.all(
      "SELECT id FROM deliveries WHERE agent_id=? AND state='accepted'",
      agent.id,
    ).length,
    0,
  );
  assert.equal(
    store.readState(chat.id, 0).find((r) => r.agent_id === agent.id)?.through,
    old.at(-1)!.id,
  );
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  const fresh = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "新消息",
    mentions: [agent.id],
  });
  const current = store
    .pending(agent.id)
    .find((d) => d.through_message === fresh.id)!;
  store.accepted(current.id);
  store.finishTurn(agent.id, false);
  assert.deepEqual(
    store
      .pending(agent.id)
      .filter((d) => d.kind === "direct")
      .map((d) => d.through_message),
    [fresh.id],
  );
  assert.equal(
    store.readState(chat.id, 0).find((r) => r.agent_id === agent.id)?.through,
    fresh.id,
  );
});

test("失败轮保留已读并换投递 ID；心跳停，重启持久；下一成功轮恢复", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atrium-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "atrium.db");
  let store = new Store(path);
  const agent = store.createAgent("失败测试", directory).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  const message = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "请处理",
    mentions: [],
  });
  const first = store.pending(agent.id).find((d) => d.kind === "direct")!;
  store.accepted(first.id);
  store.setFailure(agent.id, "401 invalid API key", 100);
  store.finishTurn(agent.id, false);
  assert.equal(
    store.readState(chat.id, 0).find((r) => r.agent_id === agent.id)?.through,
    message.id,
  );
  assert.equal(store.schedule(Date.now() + 31000).includes(agent.id), false);
  const second = store.pending(agent.id).find((d) => d.kind === "direct")!;
  assert.notEqual(second.id, first.id);
  assert.match(second.text, /上一轮运行出错，重新投递同一条消息/);
  store.accepted(second.id);
  store.finishTurn(agent.id, false);
  const third = store.pending(agent.id).find((d) => d.kind === "direct")!;
  assert.equal(third.text, second.text, "再次失败不会反复追加说明");
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.failure(agent.id)?.count, 1);
  store.accepted(third.id);
  store.finishTurn(agent.id, true); // run_end may precede the deliver RPC acknowledgement
  assert.equal(
    store.readState(chat.id, 0).find((r) => r.agent_id === agent.id)?.through,
    message.id,
  );
  store.completeDelivery(third.id);
  assert.equal(store.failure(agent.id), null);
  const group = store.createChat("待处理群聊", [agent.id]);
  store.send(LOCAL_USER, { chat_id: group.id, body: "请查阅", mentions: [] });
  const wake = Date.now() + 60000;
  assert(
    store.schedule(wake).includes(agent.id),
    "恢复后心跳可再次提醒未完成消息",
  );
  assert.equal(store.agent(agent.id).last_wake, wake);
  assert.equal(
    store.readState(chat.id, 0).find((r) => r.agent_id === agent.id)?.through,
    message.id,
  );
});
