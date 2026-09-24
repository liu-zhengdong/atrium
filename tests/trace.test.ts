import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { commandSummary, TraceStore, toolTitle } from "../server/trace.ts";
import { createApp } from "../server/app.ts";
import type { RuntimeEventPage } from "../shared/trace.ts";
import { LOCAL_USER } from "../shared/user.ts";

test("轨迹标题：一句话说清这一步在干什么", () => {
  // 下面的输入全部取自一次真实协作里采到的轨迹。
  const title = (name: string, args: unknown) =>
    toolTitle(name, JSON.stringify(args));
  // mcp 代理：查一下、搜一下和真干了一件事各说各的。
  assert.equal(
    title("mcp", {
      server: "atrium",
      tool: "atrium_create_group",
      args: { name: "调研" },
    }),
    "调用 MCP · atrium_create_group",
  );
  assert.equal(
    title("mcp", { server: "atrium", describe: "atrium_create_group" }),
    "查看 MCP 工具 · atrium_create_group",
  );
  assert.equal(
    title("mcp", { search: "message_box", limit: 20 }),
    "搜索 MCP 工具 · message_box",
  );
  assert.equal(title("mcp", { connect: "atrium" }), "连接 MCP · atrium");
  assert.equal(title("mcp", { server: "atrium" }), "列出 MCP 工具 · atrium");
  assert.equal(
    title("mcp", { action: "install", url: "https://example.com/mcp" }),
    "MCP 操作 · install",
  );
  assert.equal(title("mcp", {}), "查看 MCP 状态");
  assert.equal(toolTitle("mcp", "{被截断的"), "查看 MCP 状态");
  // 脚本跳过铺垫，取第一条真正做事的命令；管道属于同一条命令，不拆。
  assert.equal(
    commandSummary(
      'set -o pipefail\necho "=== PR 409 ==="\ncurl -sS https://api.github.com/repos/citrolabs/ego-lite/pulls/409 | python3 -c "import sys"',
    ),
    'curl -sS https://api.github.com/repos/citrolabs/ego-lite/pulls/409 | python3 -c "import sys"',
  );
  assert.equal(
    commandSummary(
      'cd /tmp && echo "go"; ego-browser --sdk-path 2>&1 | head -5',
    ),
    "ego-browser --sdk-path 2>&1 | head -5",
  );
  assert.equal(
    commandSummary('F="/Applications/ego lite.app"\notool -L "$F"'),
    'otool -L "$F"',
  );
  assert.equal(
    commandSummary("~/.local/bin/ego-browser help nodejs 2>&1 | head -30"),
    "~/.local/bin/ego-browser help nodejs 2>&1 | head -30",
  );
  assert.equal(
    commandSummary('cd /tmp\necho "全是铺垫"'),
    "cd /tmp",
    "退回第一条",
  );
  assert.equal(commandSummary(""), "");
  assert.equal(title("bash", {}), "执行命令", "没有命令就只给动词");
  // 摘要按一行可读截，截了就明说截了；完整原文在参数里。
  const long = title("bash", { command: `curl ${"x".repeat(200)}` });
  assert.equal(long.length, "执行命令 · ".length + 81);
  assert(long.endsWith("…"));
  assert.equal(
    title("read", { path: "/Users/liu/.agents/skills/ego-browser/SKILL.md" }),
    "读取 · /Users/liu/.agents/skills/ego-browser/SKILL.md",
  );
  assert.equal(
    title("lsp", { file_path: "server/app.ts" }),
    "lsp · server/app.ts",
  );
});

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
  assert.equal(
    traces.page(a.id).items[0].has_detail,
    false,
    "无正文的会话不显示展开入口",
  );
  assert.equal(tool.has_detail, true, "工具有参数，可以展开");
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
  traces.ingest(
    a.id,
    page(target, [event(4, "delivery", { text: "收到投递" })]),
  );
  assert.equal(
    traces.page(a.id).items.at(-1)!.has_detail,
    true,
    "有正文的投递仍可展开",
  );
  assert.throws(() => traces.detail(b.id, tool.id), /不存在/);
  const previous = traces.cursor(a.id, target.runtimeId, target.generation);
  for (const bad of [
    page(target, [event(6, "run_end")]),
    page(target, [event(5, "tool_end")]),
    { ...page(target, [event(5, "run_end")]), nextAfter: 9 },
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
  store.send(LOCAL_USER, { chat_id: chat.id, body: "未读", mentions: [] });
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

test("轨迹按身份有界：插入时裁掉更早的，不动别人的", (t) => {
  const store = new Store(":memory:"),
    traces = new TraceStore(store);
  t.after(() => store.close());
  const a = store.createAgent("Atlas", tmpdir()).agent,
    other = store.createAgent("Mira", tmpdir()).agent;
  const rows = (agent: string) =>
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM trace_actions WHERE agent_id=?",
      agent,
    )!.n;
  traces.ingest(other.id, page(generation(), [event(1, "session")]));

  const target = generation();
  traces.ingest(a.id, page(target, [event(1, "session")]));
  const insert = store.db.prepare(
    "INSERT INTO trace_actions(agent_id,runtime_id,generation,session_id,seq,at,kind,name,title,state,input,output) VALUES(?,?,?,?,?,0,'message','assistant','完成回复','complete','','')",
  );
  store.transaction(() => {
    for (let seq = 2; seq <= 2600; seq++)
      insert.run(
        a.id,
        target.runtimeId,
        target.generation,
        target.sessionId,
        seq,
      );
  });
  assert.equal(rows(a.id), 2600, "直接写入不裁剪");

  const newest = generation();
  traces.ingest(a.id, page(newest, [event(1, "run_start")]));
  assert.equal(rows(a.id), 2000, "下一次 ingest 裁到上限");
  assert.equal(rows(other.id), 1, "只裁本身份");
  assert.equal(
    traces.page(a.id).items.at(-1)!.title,
    "开始处理",
    "留下的是最新的那端",
  );
  assert.equal(
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM trace_actions WHERE agent_id=? AND kind='session'",
      a.id,
    )!.n,
    0,
    "最早那条已经被裁掉",
  );

  traces.ingest(a.id, page(newest, [event(2, "run_end")]));
  assert.equal(rows(a.id), 2000, "继续写也不再涨");
});

test("私聊触发来源：实际投递与工具发言关联、回复排除、群聊和 MCP 隔离", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-trigger-"));
  const { app, store } = await createApp({ data: root, runtime: false });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agent = store.createAgent("Atlas", root).agent;
  const direct = store.createChat("Atlas", [agent.id], agent.id);
  const group = store.createChat("群", [agent.id]);
  const traces = new TraceStore(store);
  const target = generation();
  let seq = 0;
  const emit = (kind: RuntimeEventPage["items"][number]["kind"], extra = {}) =>
    traces.ingest(agent.id, page(target, [event(++seq, kind, extra)]));
  const speak = (
    chatId: string,
    body: string,
    tool: "send_message" | "atrium_send_message" = "atrium_send_message",
  ) => {
    const callId = `t${seq}`;
    emit("tool_start", {
      name: "mcp",
      callId,
      text: JSON.stringify({
        server: "atrium",
        tool,
        args: { chat_id: store.chatRef(chatId), body },
      }),
    });
    const message = store.send(agent.id, {
      chat_id: chatId,
      body,
      mentions: [],
    });
    emit("tool_end", {
      name: "mcp",
      callId,
      text: JSON.stringify({
        id: message.id,
        chat_id: store.chatRef(chatId),
        sender: agent.ref,
      }),
    });
    return message;
  };
  const read = async (chatId: string) => {
    const response = await app.inject({
      url: `/api/chats/${chatId}/messages`,
      headers: { host: "localhost" },
    });
    assert.equal(response.statusCode, 200);
    return response.json().items as Array<{
      id: number;
      trigger?: { label: string; trace_id: number };
    }>;
  };
  // A delivery without speech (including a heartbeat) must never add a chat row.
  emit("delivery", { name: "Atrium", text: "[Atrium 消息箱提醒]旧提醒" });
  emit("run_start");
  emit("run_end");
  assert.deepEqual(await read(direct.id), []);
  emit("delivery", { name: "Atrium 接入说明", text: "接入说明" });
  const guideTrace = traces.page(agent.id).items.at(-1)!.id;
  emit("run_start");
  const guide = speak(direct.id, "我已接入");
  // The title is presentation text, not a stable protocol field.
  store.run("UPDATE trace_actions SET title='已换过标题' WHERE kind='tool'");
  emit("run_end");
  assert.deepEqual((await read(direct.id))[0]?.trigger, {
    label: "Atrium 投递：接入说明",
    trace_id: guideTrace,
  });
  store.send(LOCAL_USER, { chat_id: direct.id, body: "你好", mentions: [] });
  emit("delivery", { name: "Atrium", text: "用户消息" });
  emit("run_start");
  const reply = speak(direct.id, "你好");
  emit("run_end");
  assert.equal(
    (await read(direct.id)).find((item) => item.id === reply.id)?.trigger,
    undefined,
  );
  emit("delivery", { name: "Atrium", text: "[Atrium 消息箱提醒]有待办" });
  const reminderTrace = traces.page(agent.id).items.at(-1)!.id;
  emit("run_start");
  const reminder = speak(direct.id, "我来处理待办");
  emit("run_end");
  assert.deepEqual(
    (await read(direct.id)).find((item) => item.id === reminder.id)?.trigger,
    { label: "消息箱提醒", trace_id: reminderTrace },
  );
  store.send(LOCAL_USER, {
    chat_id: direct.id,
    body: "用户刚刚发来新消息",
    mentions: [],
  });
  emit("delivery", { name: "Atrium", text: "[Atrium 消息箱提醒]新待办" });
  emit("run_start");
  const notAutonomous = speak(direct.id, "这次先回复用户");
  emit("run_end");
  assert.equal(
    (await read(direct.id)).find((item) => item.id === notAutonomous.id)
      ?.trigger,
    undefined,
    "即使本轮有提醒，私聊里已有新用户消息也不能称为主动发言",
  );
  emit("delivery", { name: "外部订阅", text: "事件" });
  const externalTrace = traces.page(agent.id).items.at(-1)!.id;
  emit("run_start");
  const external = speak(direct.id, "外部事件触发", "send_message");
  speak(group.id, "群内发言");
  emit("run_end");
  assert.deepEqual(
    (await read(direct.id)).find((item) => item.id === external.id)?.trigger,
    { label: "外部事件：外部订阅", trace_id: externalTrace },
  );
  assert.equal((await read(group.id))[0]?.trigger, undefined);
  const opaque = store.send(agent.id, {
    chat_id: direct.id,
    body: "未观察到 Pi 工具调用",
    mentions: [],
  });
  assert.equal(
    (await read(direct.id)).find((item) => item.id === opaque.id)?.trigger,
    undefined,
  );
  assert(
    !(
      "trigger" in
      store.timeline(direct.id).items.find((item) => item.id === guide.id)!
    ),
  );
  // Remove the source: stale chat rows no longer suggest a clickable trace.
  store.run("DELETE FROM trace_actions WHERE id=?", reminderTrace);
  assert.equal(
    (await read(direct.id)).find((item) => item.id === reminder.id)?.trigger,
    undefined,
  );
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
