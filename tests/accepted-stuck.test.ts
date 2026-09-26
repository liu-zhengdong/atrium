import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import type { RuntimeInfo } from "../shared/schema.ts";
import { LOCAL_USER } from "../shared/user.ts";

// 第 0 步：记录当前故障，不在这里偷偷加入回收逻辑。
test("无 run_end 时 accepted 穿过服务重启仍不可投递，失败结算才会释放", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-accepted-stuck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "atrium.db");
  let store = new Store(path);
  const agent = store.createAgent("卡住复现", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  const message = store.send(LOCAL_USER, {
    chat_id: chat.id,
    body: "请处理投递",
    mentions: [],
  });
  const direct = store.pending(agent.id).find((row) => row.kind === "direct")!;
  const summaryId = store.queue(agent.id, "summary", "消息箱摘要");
  store.accepted(direct.id);
  store.accepted(summaryId);
  assert.equal(store.pending(agent.id).length, 0);
  store.close();

  store = new Store(path); // 模拟服务进程重开，但没有 run_end 或显式失败回收。
  t.after(() => store.close());
  assert.deepEqual(
    store
      .all<{ id: string; kind: string; state: string }>(
        "SELECT id,kind,state FROM deliveries WHERE agent_id=? ORDER BY kind",
        agent.id,
      )
      .map(({ kind, state }) => [kind, state]),
    [
      ["direct", "accepted"],
      ["summary", "accepted"],
    ],
  );
  assert.equal(store.pending(agent.id).length, 0);
  assert.equal(store.failure(agent.id), null);
  assert.equal(
    store.readState(chat.id, 0).find((row) => row.agent_id === agent.id)
      ?.through,
    message.id,
    "接受投递时已读仍前进；没收到回合结束不表示完成处理",
  );

  store.finishTurn(agent.id, false); // 既有失败收尾可重排队，但重启本身没有调用它。
  const retried = store.pending(agent.id);
  assert.equal(retried.length, 2);
  assert.notEqual(retried.find((row) => row.kind === "summary")?.id, summaryId);
  assert.notEqual(retried.find((row) => row.kind === "direct")?.id, direct.id);
  assert.match(
    retried.find((row) => row.kind === "direct")!.text,
    /重新投递同一条消息/,
  );
});

test("Runtimes 换新后仍以持久 turn 配对旧 run_start 和新 run_end", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-turn-stuck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "atrium.db");
  let store = new Store(path);
  const agent = store.createAgent("跨进程", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const delivery = store
    .pending(agent.id)
    .find((row) => row.kind === "direct")!;
  const info: RuntimeInfo = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    pid: 1,
    ownerPid: 1,
    identityId: null,
    sessionFile: join(dir, "session.jsonl"),
    cwd: dir,
    mode: "rpc",
    busy: true,
    model: "test",
  };
  const at = Date.now() - 5;
  let phase = 0;
  const prototype = Runtimes.prototype as unknown as {
    discover(): Promise<void>;
    rpc(method: string, params: unknown): Promise<unknown>;
    capture(id: string, info: RuntimeInfo): Promise<void>;
  };
  t.mock.method(prototype, "discover", async () => {});
  t.mock.method(prototype, "rpc", async (method: string) => {
    if (method === "_pi/runtime/status") return { ...info, busy: false };
    assert.equal(method, "_pi/runtime/events");
    return {
      runtimeId: info.runtimeId,
      generation: info.generation,
      sessionId: info.sessionId,
      hasMore: false,
      gap: false,
      items: phase
        ? [{ seq: 3, at: at + 3, kind: "run_end" }]
        : [
            { seq: 1, at, kind: "delivery", name: "Atrium" },
            { seq: 2, at: at + 1, kind: "run_start" },
          ],
      nextAfter: phase ? 3 : 2,
    };
  });
  const first = new Runtimes(
    store,
    dir,
    () => {},
    () => "http://127.0.0.1:4331",
    undefined,
    dir,
  );
  first.connections.set(agent.id, { connection: null as never, info });
  await prototype.capture.call(first, agent.id, info);
  store.accepted(delivery.id);
  await first.close();
  store.close();
  store = new Store(path);
  phase = 1;
  const second = new Runtimes(
    store,
    dir,
    () => {},
    () => "http://127.0.0.1:4331",
    undefined,
    dir,
  );
  second.connections.set(agent.id, { connection: null as never, info });
  t.after(async () => {
    await second.close();
    store.close();
  });
  await prototype.capture.call(second, agent.id, info);
  assert.equal(
    second.connections.get(agent.id)?.info.busy,
    false,
    "run_end must refresh the busy flag cached by an earlier steer",
  );
  assert.deepEqual(
    store
      .all<{ kind: string }>(
        "SELECT kind FROM trace_actions WHERE agent_id=? ORDER BY seq",
        agent.id,
      )
      .map((row) => row.kind),
    ["delivery", "run_start", "run_end"],
    "投递、start/end 都已持久记录，丢失的是进程内 turns",
  );
  assert.equal(
    store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      delivery.id,
    )?.state,
    "complete",
    "恢复后的 run_end 必须结清重启前接受的消息",
  );
});

test("有确认的成功 run_end 把 accepted 标记 complete，重启不会重投", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-accepted-complete-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "atrium.db");
  let store = new Store(path);
  const agent = store.createAgent("成功对照", dir).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "请处理", mentions: [] });
  const delivery = store
    .pending(agent.id)
    .find((row) => row.kind === "direct")!;
  store.accepted(delivery.id);
  store.finishTurn(agent.id, true);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.pending(agent.id).length, 0);
  assert.equal(
    store.one<{ state: string }>(
      "SELECT state FROM deliveries WHERE id=?",
      delivery.id,
    )?.state,
    "complete",
  );
});
