import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { TraceStore } from "../server/trace.ts";
import { createApp } from "../server/app.ts";
import type { RuntimeEventPage } from "../shared/trace.ts";

const generation = () => ({
  runtimeId: randomUUID(),
  generation: randomUUID(),
  sessionId: randomUUID(),
});
const page = (
  target: ReturnType<typeof generation>,
  items: RuntimeEventPage["items"],
  gap = false,
): RuntimeEventPage => ({
  ...target,
  items,
  gap,
  nextAfter: items.at(-1)?.seq ?? 0,
  hasMore: false,
});
const event = (
  seq: number,
  kind: RuntimeEventPage["items"][number]["kind"],
  extra = {},
) => ({ seq, at: Date.now(), kind, ...extra });

test("运行轨迹：真实事件物化、参数按需读取、分页隔离与会话代际", (t) => {
  const store = new Store(":memory:"),
    traces = new TraceStore(store),
    target = generation();
  t.after(() => store.close());
  const a = store.createAgent("Atlas", tmpdir()).agent,
    b = store.createAgent("Borealis", tmpdir()).agent;
  traces.ingest(
    a.id,
    page(target, [
      event(1, "session"),
      event(2, "tool_start", {
        name: "read",
        callId: "t1",
        text: '{"path":"example.md"}',
      }),
    ]),
  );
  const tool = traces.page(a.id).items.at(-1)!;
  assert.equal(tool.state, "running");
  assert.match(tool.title, /读取.*example.md/);
  assert(!("input" in tool), "默认列表不拉取完整正文");
  traces.ingest(
    a.id,
    page(target, [
      event(3, "tool_end", { name: "read", callId: "t1", text: "真实结果" }),
    ]),
  );
  assert.equal(
    traces.page(a.id).items.length,
    2,
    "完成更新同一动作，不堆两条工具日志",
  );
  assert.equal(traces.detail(a.id, tool.id).output, "真实结果");
  assert.equal(traces.detail(a.id, tool.id).state, "complete");
  assert.throws(() => traces.detail(b.id, tool.id), /不存在/);
  const previous = traces.cursor(a.id, target.runtimeId, target.generation);
  for (const bad of [
    page(target, [event(5, "run_end")]),
    page(target, [event(4, "tool_end")]),
    { ...page(target, [event(4, "run_end")]), nextAfter: 9 },
  ])
    assert.throws(() => traces.ingest(a.id, bad));
  assert.equal(
    traces.cursor(a.id, target.runtimeId, target.generation),
    previous,
    "损坏页事务不推进游标",
  );
  traces.ingest(
    a.id,
    page(
      target,
      [
        event(10, "tool_end", {
          name: "bash",
          callId: "missing",
          text: "exit 1",
          error: true,
        }),
      ],
      true,
    ),
  );
  assert(traces.page(a.id).items.some((i) => i.kind === "gap"));
  assert.equal(traces.page(a.id).items.at(-1)!.state, "error");
  traces.ingest(
    a.id,
    page(target, [
      event(11, "tool_start", {
        name: "bash",
        callId: "left",
        text: '{"command":"npm test"}',
      }),
    ]),
  );
  const fresh = generation();
  traces.ingest(a.id, page(fresh, [event(1, "session")]));
  assert.equal(
    traces
      .page(a.id)
      .items.find((i) => i.name === "bash" && i.state !== "error")!.state,
    "unknown",
    "换会话不将旧任务伪标成功",
  );
  for (let seq = 2; seq < 90; seq++)
    traces.ingest(
      a.id,
      page(fresh, [
        event(seq, "message", { name: "assistant", text: `${seq}` }),
      ]),
    );
  const latest = traces.page(a.id),
    earlier = traces.page(a.id, latest.items[0].id);
  assert.equal(latest.items.length, 50);
  assert(latest.has_more);
  assert(earlier.items.at(-1)!.id < latest.items[0].id);
});

test("轨迹查询反向校验与持久化：用户审阅不改变回执", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-trace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { app, store } = await createApp({ data: root, runtime: false });
  t.after(() => app.close());
  const a = store.createAgent("Atlas", tmpdir()).agent,
    b = store.createAgent("Borealis", tmpdir()).agent;
  const chat = store.createChat("聊天", [a.id]);
  store.send("user", { chat_id: chat.id, body: "未读", mentions: [] });
  const traces = new TraceStore(store),
    target = generation();
  traces.ingest(
    a.id,
    page(target, [
      event(1, "tool_start", {
        name: "bash",
        callId: "t1",
        text: '{"command":"echo ok"}',
      }),
    ]),
  );
  const item = traces.page(a.id).items[0];
  const get = (url: string) =>
    app.inject({ url, headers: { host: "localhost" } });
  assert.equal((await get(`/api/agents/${a.id}/trace`)).statusCode, 200);
  assert.equal(
    (await get(`/api/agents/${b.id}/trace/${item.id}`)).statusCode,
    404,
  );
  assert.equal(
    (await get(`/api/agents/${a.id}/trace?before=-1`)).statusCode,
    400,
  );
  assert.equal(
    (await get(`/api/agents/${a.id}/trace?limit=999999`)).statusCode,
    400,
  );
  assert.equal(
    (await get(`/api/agents/${a.id}/trace/not-number`)).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/agents/${a.id}/trace`,
        headers: { host: "localhost", origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(store.unread(a.id)[0].count, 1);
  const reopened = new Store(join(root, "atrium.sqlite"));
  try {
    assert.equal(
      new TraceStore(reopened).cursor(
        a.id,
        target.runtimeId,
        target.generation,
      ),
      1,
    );
  } finally {
    reopened.close();
  }
});

test("十万条轨迹：索引分页不读取正文，冷热查询有界", (t) => {
  const store = new Store(":memory:"),
    traces = new TraceStore(store),
    target = generation();
  t.after(() => store.close());
  const a = store.createAgent("Atlas", tmpdir()).agent;
  traces.ingest(a.id, page(target, [event(1, "session")]));
  const insert = store.db.prepare(
    "INSERT INTO trace_actions(agent_id,runtime_id,generation,session_id,seq,at,kind,name,title,state,input,output) VALUES(?,?,?,?,?,0,'message','assistant','完成回复','complete','','')",
  );
  store.transaction(() => {
    for (let seq = 2; seq <= 100000; seq++)
      insert.run(
        a.id,
        target.runtimeId,
        target.generation,
        target.sessionId,
        seq,
      );
  });
  const start = performance.now();
  assert.equal(traces.page(a.id).items.length, 50);
  const cold = performance.now() - start,
    hotStart = performance.now();
  for (let i = 0; i < 100; i++) traces.page(a.id);
  const hot = performance.now() - hotStart;
  assert(
    cold < 1500 && hot < 3000,
    `cold=${cold.toFixed(1)}ms hot100=${hot.toFixed(1)}ms`,
  );
  t.diagnostic(`cold=${cold.toFixed(2)}ms hot100=${hot.toFixed(2)}ms`);
});
