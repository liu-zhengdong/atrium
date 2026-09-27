import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventInbox, type InboxEvent } from "../server/tasks/events.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import { AcpConnection, agentEnvironment } from "../cli/acp.ts";
import {
  SecretaryChat,
  wakePrompt,
  type ChatView,
} from "../cli/secretary-chat.ts";
import { chatMode, sessionStore } from "../cli/chat.ts";
import { Problem } from "../server/problem.ts";
import { removeTemp } from "./temp-dir.ts";

const AGENT = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

type Log = {
  text: string;
  wakes: number[][];
  notices: string[];
  ends: string[];
};

function harness(
  data: string,
  options: { maxWakeups?: number; fresh?: boolean; allow?: boolean } = {},
) {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const log: Log = { text: "", wakes: [], notices: [], ends: [] };
  const view: ChatView = {
    text: (chunk) => (log.text += chunk),
    thought: () => {},
    tool: () => {},
    wake: (events) => log.wakes.push(events.map((event) => event.id)),
    notice: (message) => log.notices.push(message),
    turnEnd: (reason) => log.ends.push(reason),
    permission: async (request) => ({
      outcome: "selected",
      optionId: request.options.find((option) =>
        option.kind.startsWith(options.allow ? "allow" : "reject"),
      )!.optionId,
    }),
  };
  let chat: SecretaryChat | undefined;
  const connection = new AcpConnection(
    process.execPath,
    [AGENT],
    { cwd: data, env: agentEnvironment() },
    {
      update: (sessionId, update) => chat?.update(sessionId, update),
      permission: (request) => view.permission(request),
      exit: (reason) => chat?.exit(reason),
    },
  );
  chat = new SecretaryChat({
    connection,
    view,
    cwd: data,
    fresh: options.fresh,
    store: sessionStore(data, "fake"),
    batchMs: 30,
    maxWakeups: options.maxWakeups,
    source: {
      peek: async (timeout, signal) =>
        (await inbox.wait("secretary", timeout, signal, { peek: true })).events,
      deliver: async (ids) => inbox.deliver("secretary", ids),
    },
  });
  const publish = (task: number, kind = "done") =>
    inbox.publish({
      subscriber: "secretary",
      taskId: task,
      source: "runner",
      kind,
      key: `t${task}:outcome`,
      detail: { title: `任务${task}` },
    }).id;
  return { db, inbox, log, chat, connection, publish };
}

async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await delay(10);
  }
}

async function started(h: ReturnType<typeof harness>) {
  await h.connection.request("initialize", { protocolVersion: 1 });
  const result = await h.chat.start({ loadSession: true });
  const running = h.chat.run();
  return { result, running };
}

test("事件 peek 只看不取，deliver 只登记仍可投递的编号", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const a = inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "done",
    key: "a",
  });
  const b = inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "done",
    key: "b",
  });
  const other = inbox.publish({
    subscriber: "lead",
    source: "runner",
    kind: "done",
    key: "c",
  });
  const peeked = await inbox.wait("secretary", 0, undefined, { peek: true });
  assert.deepEqual(
    peeked.events.map((event) => event.id),
    [a.id, b.id],
  );
  assert.equal(peeked.events[0]!.delivered_at, null, "peek 不记送达");
  assert.equal(inbox.countPending("secretary"), 2);
  inbox.ack([b.id]);
  const delivered = inbox.deliver("secretary", [a.id, b.id, other.id, 999]);
  assert.deepEqual(
    delivered.map((event) => event.id),
    [a.id],
    "已确认、别人的、不存在的都略过",
  );
  assert.notEqual(delivered[0]!.delivered_at, null);
  assert.deepEqual(inbox.deliver("secretary", [a.id]), [], "租约内不重复登记");
  assert.equal((await inbox.wait("secretary", 0)).events.length, 0);
  // peek 挂着时有新事件就返回，仍不取走。
  const waiting = inbox.wait("secretary", 5, undefined, { peek: true });
  const c = inbox.publish({
    subscriber: "secretary",
    source: "ci",
    kind: "ci_failed",
    key: "d",
  });
  assert.deepEqual(
    (await waiting).events.map((event) => event.id),
    [c.id],
  );
  assert.equal(inbox.countPending("secretary"), 1);
});

test("送入消息列出事件、查看与确认命令", () => {
  const event = {
    id: 7,
    task: "t3",
    kind: "done",
    count: 1,
    detail: { title: "修登录" },
    delivered_at: 1,
    acked_at: null,
    updated_at: Date.now(),
  } as InboxEvent;
  const text = wakePrompt([event, { ...event, id: 8, task: null }]);
  assert.match(text, /^【Atrium 事件】2 条待处理事件已送达（编号 7、8）/);
  assert.match(text, /#7 t3 done 修登录/);
  assert.match(text, /atrium task show t3/);
  assert.match(text, /atrium events ack 7 8$/);
});

test("按工具选打开方式：opencode 原生界面或 ACP、codex ACP，未知工具给出修正", () => {
  assert.deepEqual(chatMode("opencode"), {
    kind: "acp",
    command: "opencode",
    args: ["acp"],
    native: "opencode",
  });
  const codex = chatMode("codex");
  assert.equal(codex.kind, "acp");
  if (codex.kind === "acp")
    assert.match(codex.args.join(" "), /@zed-industries[\\/]codex-acp/);
  assert.throws(
    () => chatMode("kimi"),
    (error: unknown) =>
      error instanceof Problem &&
      error.code === "conflict" &&
      error.nextCommand === "atrium chat --tool opencode",
  );
  assert.throws(
    () => chatMode("opencod"),
    (error: unknown) =>
      error instanceof Problem &&
      error.code === "usage" &&
      error.nextCommand === "atrium chat --tool opencode",
  );
});

test("拉起 Agent 的环境去掉 HERDR_* 与嵌套会话标记", () => {
  const env = agentEnvironment({
    PATH: "/bin",
    HERDR_PANE: "3",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDECODE: "1",
    PI_ID: "x",
    ATRIUM_PORT: "4999",
    OPENAI_API_KEY: "secret",
    GH_TOKEN: "secret",
    CUSTOM_API_KEY: "secret",
  });
  assert.deepEqual(env, { PATH: "/bin", ATRIUM_PORT: "4999" });
});

test("秘书会话：空闲时自动送入事件；忙时排队、一轮结束后合并送入；会话可接着上次", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-chat-"));
  try {
    const h = harness(data);
    const { result, running } = await started(h);
    assert.equal(result.resumed, false);
    assert.equal(h.chat.session, "s-1");

    h.chat.say("你好");
    await until(() => h.log.ends.length === 1, "第一轮结束");
    assert.match(h.log.text, /收到：你好/);

    // 空闲：事件自动送入，不需要谁去等事件。
    const first = h.publish(1);
    await until(() => h.log.wakes.length === 1, "空闲送入");
    assert.deepEqual(h.log.wakes[0], [first]);
    await until(() => h.log.ends.length === 2, "事件轮结束");
    assert.match(h.log.text, /收到：【Atrium 事件】1 条/);
    assert.match(h.log.text, /atrium task show t1/);
    const listed = h.inbox.list("secretary", { limit: 10 }).events;
    assert.notEqual(listed[0]!.delivered_at, null, "送入即记送达");
    assert.equal(listed[0]!.acked_at, null, "确认留给秘书");

    // 忙：一轮进行中来的两条事件排队，结束后合并成一次送入。
    h.chat.say("SLOW 慢慢来");
    await until(() => h.chat.running, "慢一轮开始");
    const second = h.publish(2);
    const third = h.publish(3, "failed");
    assert.equal(h.log.wakes.length, 1, "忙时不送");
    await until(() => h.log.wakes.length === 2, "合并送入");
    assert.deepEqual(h.log.wakes[1], [second, third]);
    await until(() => h.log.ends.length === 4, "合并轮结束");
    assert.ok(
      h.log.text.indexOf("收到：SLOW") < h.log.text.indexOf("2 条待处理事件"),
    );

    // 权限请求交给界面决定；取消进行中的一轮。
    h.chat.say("PERM HANG");
    await until(() => /权限：no/.test(h.log.text), "权限回复");
    assert.ok(h.chat.cancel());
    await until(() => h.log.ends.at(-1) === "cancelled", "取消");

    h.chat.end();
    assert.equal(await running, null);
    h.connection.close();

    // 再开一次：接着上次的会话，回放不重复显示。
    const again = harness(data);
    const reopened = await started(again);
    assert.equal(reopened.result.resumed, true);
    assert.equal(again.chat.session, "s-1");
    assert.doesNotMatch(again.log.text, /历史回放/);
    again.chat.end();
    await reopened.running;
    again.connection.close();

    // --new：不恢复。
    const fresh = harness(data, { fresh: true });
    const created = await started(fresh);
    assert.equal(created.result.resumed, false);
    fresh.chat.close();
    await created.running;
  } finally {
    removeTemp(data);
  }
});

test("连续自动送入到上限后暂停，用户发话后继续；Agent 退出时带原因结束", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-chat-"));
  try {
    const h = harness(data, { maxWakeups: 1 });
    const { running } = await started(h);
    h.publish(1);
    await until(() => h.log.ends.length === 1, "第一次送入");
    const held = h.publish(2);
    await until(() => h.log.notices.length === 1, "上限提示");
    assert.match(h.log.notices[0]!, /暂停自动送入/);
    await delay(100);
    assert.equal(h.log.wakes.length, 1, "上限后不再自动送入");
    h.chat.say("继续");
    await until(() => h.log.wakes.length === 2, "发话后继续送入");
    assert.deepEqual(h.log.wakes[1], [held]);
    await until(() => h.log.ends.length === 3, "送入轮结束");

    h.chat.say("DIE");
    const reason = await running;
    assert.match(reason ?? "", /退出码 3/);
  } finally {
    removeTemp(data);
  }
});
