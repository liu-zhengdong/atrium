import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  EventInbox,
  listenInput,
  type InboxEvent,
} from "../server/tasks/events.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  bridgeClaim,
  bridgeLine,
  bridgePrompt,
  inboxLines,
  parseBridgeRecord,
  planBatch,
  recordSent,
  type Sent,
} from "../server/tasks/bridge-plan.ts";
import { SecretaryBridge, type BridgeSource } from "../cli/secretary-bridge.ts";
import { sessionInbox, withBridgeHook } from "../cli/secretary.ts";
import { chatMode } from "../cli/chat.ts";
import { SecretaryFallback } from "../server/tasks/secretary-fallback.ts";
import { saveSecretarySession } from "../server/tasks/secretary-session.ts";
import { createApp } from "../server/app.ts";
import { main } from "../cli/main.ts";
import { Problem } from "../server/problem.ts";
import { removeTemp } from "./temp-dir.ts";

async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await delay(10);
  }
}

const event = (id: number, patch: Partial<InboxEvent> = {}): InboxEvent => ({
  id,
  key: `t${id}:failed`,
  subscriber: "secretary",
  task: `t${id}`,
  source: "runner",
  kind: "failed",
  actor: null,
  detail: { title: `任务${id}`, reason: "检查没过\n第二行不要" },
  level: "action",
  count: 1,
  created_at: 1000,
  updated_at: 1000,
  delivered_at: null,
  acked_at: null,
  ...patch,
});

test("去重：送过的同一事件不再送，满提醒间隔再提醒，合并了新发生的按新事件送", () => {
  const sent: Sent = new Map();
  const first = planBatch(sent, [event(1), event(2)], 0, 1000);
  assert.deepEqual(
    first.fresh.map((e) => e.id),
    [1, 2],
  );
  assert.equal(first.remind.length, 0);
  recordSent(sent, first.fresh, 0);
  // 租约到期重投回来，还没到提醒间隔：略过。
  const early = planBatch(sent, [event(1), event(2)], 999, 1000);
  assert.deepEqual(early, { fresh: [], remind: [] });
  // #2 合并了新发生的一次（更新时刻变了）：按新事件送；#1 满间隔：再提醒。
  const later = planBatch(
    sent,
    [event(1), event(2, { updated_at: 2000, count: 2 })],
    1000,
    1000,
  );
  assert.deepEqual(
    later.fresh.map((e) => e.id),
    [2],
  );
  assert.deepEqual(
    later.remind.map((e) => e.id),
    [1],
  );
  // 已确认的不送。
  assert.deepEqual(
    planBatch(new Map(), [event(3, { acked_at: 5 })], 0).fresh,
    [],
  );
});

test("送过的记录有上限，超出丢最早送的", () => {
  const sent: Sent = new Map();
  recordSent(sent, [event(1), event(2), event(3)], 0, 2);
  assert.deepEqual([...sent.keys()], [2, 3]);
  recordSent(sent, [event(2)], 5, 2);
  assert.deepEqual([...sent.keys()], [3, 2], "再送的挪到最后");
});

test("消息：一行摘要、看详情、处理完怎么确认；再提醒单列", () => {
  assert.equal(
    bridgeLine(event(7, { count: 3 })),
    "#7 t7 failed 任务7 （合并 3 次） · 检查没过",
  );
  const both = bridgePrompt({ fresh: [event(7)], remind: [event(5)] }, 1800000);
  assert.match(both, /^【Atrium 事件】1 条要处理的事件（编号 7）：/);
  assert.match(both, /送过 30 分钟还没确认：\n- #5 t5/);
  assert.match(both, /看详情：atrium task show t7；atrium task show t5/);
  assert.match(both, /处理完确认：atrium events ack 7 5$/);
  const remind = bridgePrompt({ fresh: [], remind: [event(5)] }, 1800000);
  assert.match(remind, /^【Atrium 事件】提醒：1 条事件送过 30 分钟还没确认：/);
  const lines = inboxLines("tok", "多行\n内容");
  assert.deepEqual(JSON.parse(lines[0]), { type: "auth", token: "tok" });
  assert.deepEqual(JSON.parse(lines[1]), {
    type: "user",
    message: { role: "user", content: "多行\n内容" },
  });
  assert.ok(!lines[1].includes("\n"), "每条 JSON 只占一行");
});

test("登记：同一会话在跑不再起，别的会话在跑新会话接手，坏登记当没有", () => {
  const record = { pid: 42, socket: "/tmp/a.sock", started_at: 1 };
  assert.equal(
    bridgeClaim(null, "/tmp/a.sock", () => true),
    "start",
  );
  assert.equal(
    bridgeClaim(record, "/tmp/a.sock", () => false),
    "start",
  );
  assert.equal(
    bridgeClaim(record, "/tmp/a.sock", () => true),
    "running",
  );
  assert.equal(
    bridgeClaim(record, "/tmp/b.sock", () => true),
    "takeover",
  );
  assert.deepEqual(parseBridgeRecord(JSON.stringify(record)), record);
  for (const bad of [
    null,
    "",
    "not json",
    '{"pid":0,"socket":"x","started_at":1}',
    '{"pid":1}',
  ])
    assert.equal(parseBridgeRecord(bad), null, String(bad));
});

test("会话收件地址：缺环境变量或认不出时报人话", () => {
  assert.throws(
    () => sessionInbox({}),
    (error: unknown) =>
      error instanceof Problem &&
      error.code === "usage" &&
      /CLAUDE_CODE_MESSAGING_SOCKET/.test(error.message),
  );
  assert.throws(
    () =>
      sessionInbox({
        CLAUDE_CODE_MESSAGING_SOCKET: "relative.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      }),
    /认不出/,
  );
  const path =
    process.platform === "win32" ? "\\\\.\\pipe\\cc-1" : "/tmp/cc-1.sock";
  assert.deepEqual(
    sessionInbox({
      CLAUDE_CODE_MESSAGING_SOCKET: `uds:${path}`,
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
    }),
    { endpoint: path, token: "tok" },
  );
});

test("SessionStart hook：合并进已有设置，已装过不重复，结构认不出不覆盖", () => {
  const first = withBridgeHook({
    model: "opus",
    hooks: { Stop: [{ hooks: [] }] },
  });
  assert.equal(first.added, true);
  assert.equal(first.settings.model, "opus");
  const hooks = first.settings.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.Stop, [{ hooks: [] }]);
  assert.deepEqual(hooks.SessionStart, [
    {
      hooks: [
        {
          type: "command",
          command: "atrium secretary bridge --detach",
          timeout: 30,
        },
      ],
    },
  ]);
  assert.equal(withBridgeHook(first.settings).added, false);
  assert.equal(withBridgeHook(undefined).added, true);
  for (const bad of [[], "x", { hooks: [] }, { hooks: { SessionStart: {} } }])
    assert.throws(() => withBridgeHook(bad), /没有改动/);
});

test("--install-hook 写进秘书目录的 .claude/settings.local.json，保留原有设置；坏 JSON 不改", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-bridge-hook-"));
  t.after(() => removeTemp(dir));
  const file = join(dir, ".claude", "settings.local.json");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash"] } }));
  // 执行者环境里命令行要求隔离实例；装 hook 不连服务，给个隔离的数据目录与端口即可。
  const env = { data: process.env.ATRIUM_DATA, port: process.env.ATRIUM_PORT };
  process.env.ATRIUM_DATA = join(dir, ".atrium");
  process.env.ATRIUM_PORT = "4399";
  t.after(() => {
    for (const [key, value] of [
      ["ATRIUM_DATA", env.data],
      ["ATRIUM_PORT", env.port],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    assert.equal(
      await main(["secretary", "bridge", "--install-hook", "--cwd", dir]),
      0,
    );
    assert.equal(
      await main(["secretary", "bridge", "--install-hook", "--cwd", dir]),
      0,
    );
  } finally {
    console.log = log;
  }
  const settings = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
  assert.equal(settings.hooks.SessionStart.length, 1);
  const text = logs.join("\n");
  assert.match(text, /将写入 .*settings\.local\.json/);
  assert.match(text, /"command": "atrium secretary bridge --detach"/);
  assert.match(text, /已有起 bridge 的 SessionStart hook，没有改动/);
  writeFileSync(file, "{ broken");
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    assert.notEqual(
      await main(["secretary", "bridge", "--install-hook", "--cwd", dir]),
      0,
    );
  } finally {
    console.error = error;
  }
  assert.equal(readFileSync(file, "utf8"), "{ broken");
  assert.match(errors.join("\n"), /不是合法的 JSON，没有改动/);
});

test("在听：请求体校验，有效期内算在听，过期或 stop 即不在听", () => {
  assert.deepEqual(listenInput({ stop: true }), { stop: true });
  assert.deepEqual(listenInput({ via: " claude-code ", ttl_seconds: 90 }), {
    via: "claude-code",
    ttl_seconds: 90,
  });
  for (const bad of [
    {},
    { via: "", ttl_seconds: 90 },
    { via: "a\nb", ttl_seconds: 90 },
    { via: "x".repeat(81), ttl_seconds: 90 },
    { via: "x", ttl_seconds: 5 },
    { via: "x", ttl_seconds: 601 },
    { via: "x", ttl_seconds: "90" },
    { via: "x", ttl_seconds: 90, stop: "yes" },
  ])
    assert.throws(() => listenInput(bad), Problem, JSON.stringify(bad));
  let now = 1000;
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db, { now: () => now });
  assert.equal(inbox.listener("secretary"), undefined);
  inbox.listen("secretary", { via: "claude-code", ttl_seconds: 10 });
  now += 5000;
  inbox.listen("secretary", { via: "claude-code", ttl_seconds: 10 });
  assert.deepEqual(inbox.listener("secretary"), {
    via: "claude-code",
    since: 1000,
    until: 16000,
  });
  assert.deepEqual(
    inbox.presence("secretary"),
    { waiting: true, last_seen: 6000 },
    "与 t242 的在听共用",
  );
  now = 16000;
  assert.equal(inbox.listener("secretary"), undefined, "过期即不在听");
  assert.deepEqual(inbox.presence("secretary"), {
    waiting: false,
    last_seen: 6000,
  });
  inbox.listen("secretary", { via: "claude-code", ttl_seconds: 10 });
  inbox.listen("secretary", { stop: true });
  assert.equal(inbox.listener("secretary"), undefined);
  db.close();
});

test("服务接口：POST/GET /api/events/listen 报与查在听，坏请求体 400", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-bridge-app-"));
  t.after(() => removeTemp(data));
  const { app } = await createApp({
    data,
    auth: false,
    tasks: {
      workersDir: join(data, "no-workers"),
      pace: async () => undefined,
      usagePace: async () => undefined,
    },
  });
  t.after(() => app.close());
  const call = (method: "GET" | "POST", payload?: object) =>
    app.inject({
      method,
      url: "/api/events/listen?as=secretary",
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
  assert.equal((await call("GET")).json().listener, null);
  const posted = await call("POST", {
    via: "claude-code 会话，经注入",
    ttl_seconds: 90,
  });
  assert.equal(posted.statusCode, 200, posted.body);
  assert.equal(
    (await call("GET")).json().listener.via,
    "claude-code 会话，经注入",
  );
  const bad = await call("POST", { via: "x", ttl_seconds: 1 });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /ttl_seconds/);
  await call("POST", { stop: true });
  assert.equal((await call("GET")).json().listener, null);
});

test("bridge 在听时后台兜底不另起秘书；不听了再接手", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-bridge-fallback-"));
  t.after(() => removeTemp(data));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const calls: string[] = [];
  const fallback = new SecretaryFallback(inbox, data, {
    graceMs: 10,
    checkMs: 20,
    runTurn: async (_session, prompt) => {
      calls.push(prompt);
      return true;
    },
  });
  t.after(async () => {
    await fallback.close();
    db.close();
  });
  saveSecretarySession(data, {
    tool: "codex",
    sessionId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
    cwd: data,
  });
  inbox.listen("secretary", { via: "claude-code", ttl_seconds: 60 });
  fallback.start();
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "failed",
    key: "t1:failed",
    detail: { title: "修登录" },
  });
  await delay(300);
  assert.equal(calls.length, 0, "bridge 在听期间不起后台秘书");
  inbox.listen("secretary", { stop: true });
  await until(() => calls.length > 0, "不听了之后后台接手", 15000);
  assert.match(calls[0]!, /#1 failed 修登录/);
});

type Received = { lines: string[] };

/** 假的会话收件 socket：记下每个连接收到的各行。 */
async function fakeInbox(path: string) {
  const received: Received[] = [];
  const server: Server = createServer((socket) => {
    const entry: Received = { lines: [] };
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      entry.lines.push(...parts);
    });
    socket.on("end", () => {
      if (entry.lines.length) received.push(entry);
      socket.end();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("bridge：经 socket 送认证行和一条消息；按编号去重，没确认的满间隔再提醒；会话没了就退出", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-bridge-sock-"));
  t.after(() => removeTemp(dir));
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\atrium-bridge-test-${process.pid}-${Date.now()}`
      : join(dir, "in.sock");
  const inbox0 = await fakeInbox(path);
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  // 租约很短：没确认的很快重投回来，由 bridge 自己按提醒间隔决定送不送。
  const inbox = new EventInbox(db, { leaseMs: 100 });
  const heard: unknown[] = [];
  const source: BridgeSource = {
    wait: async (timeout, signal) =>
      (await inbox.wait("secretary", timeout, signal, { settleSeconds: 0 }))
        .events,
    listen: async (input) => {
      heard.push(input);
      inbox.listen("secretary", input);
    },
  };
  const logs: string[] = [];
  const bridge = new SecretaryBridge({
    endpoint: path,
    token: "secret-token",
    source,
    remindMs: 1500,
    waitSeconds: 1,
    retryMs: 50,
    log: (line) => logs.push(line),
  });
  t.after(async () => {
    bridge.close();
    db.close();
  });
  const running = bridge.run();
  await until(() => inbox.listener("secretary") !== undefined, "报在听");
  assert.equal(inbox.listener("secretary")!.via, "claude-code 会话，经注入");
  const first = inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "failed",
    key: "t3:failed",
    detail: { title: "修登录", reason: "检查没过" },
  });
  await until(() => inbox0.received.length >= 1, "第一条送入");
  const [auth, message] = inbox0.received[0]!.lines.map((line) =>
    JSON.parse(line),
  );
  assert.deepEqual(auth, { type: "auth", token: "secret-token" });
  assert.equal(message.type, "user");
  assert.equal(message.message.role, "user");
  assert.match(message.message.content, /^【Atrium 事件】1 条要处理的事件/);
  assert.match(message.message.content, /#1 failed 修登录 · 检查没过/);
  assert.match(message.message.content, /atrium events ack 1$/);
  // 租约 100 毫秒一到就重投回来，没到提醒间隔不再送。
  await delay(600);
  assert.equal(inbox0.received.length, 1, "按编号去重");
  assert.equal(
    inbox.list("secretary", { limit: 5 }).events[0]!.acked_at,
    null,
    "bridge 不确认事件",
  );
  await until(() => inbox0.received.length >= 2, "没确认的再提醒", 5000);
  const reminder = JSON.parse(inbox0.received[1]!.lines[1]!);
  assert.match(reminder.message.content, /提醒：1 条事件送过 \d+ 分钟还没确认/);
  inbox.ack([first.id]);
  await delay(400);
  assert.equal(inbox0.received.length, 2, "确认后不再提醒");
  await inbox0.close();
  const reason = await running;
  assert.match(reason, /会话已关闭/);
  assert.deepEqual(heard.at(-1), { stop: true }, "退出时报不听了");
  assert.equal(inbox.listener("secretary"), undefined);
  assert.ok(!logs.join("\n").includes("secret-token"), "口令不进日志");
});

test("bridge：送不进去且会话没了立即退出；暂时的失败稍后重试", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  inbox.publish({
    subscriber: "secretary",
    source: "runner",
    kind: "failed",
    key: "t1:failed",
    detail: { title: "a" },
  });
  const posts: number[] = [];
  let gone = false;
  const bridge = new SecretaryBridge({
    endpoint: "/nowhere",
    token: "t",
    source: {
      wait: async (timeout, signal) =>
        (await inbox.wait("secretary", timeout, signal, { settleSeconds: 0 }))
          .events,
      listen: async () => {},
    },
    waitSeconds: 1,
    retryMs: 10,
    probe: async () => ({ ok: true }),
    post: async () => {
      posts.push(Date.now());
      return gone
        ? { ok: false, gone: true, message: "ENOENT" }
        : { ok: false, gone: false, message: "EBUSY" };
    },
  });
  const running = bridge.run();
  await until(() => posts.length >= 1, "第一次送");
  // 没送进去不记为送过：租约到期重投回来还会再送。
  gone = true;
  inbox.releaseAll("secretary");
  assert.match(await running.then((r) => r), /会话已关闭/);
  db.close();
});

test("bridge：别的会话接手后退出", async () => {
  let owner = true;
  const bridge = new SecretaryBridge({
    endpoint: "/nowhere",
    token: "t",
    source: {
      wait: async () => {
        owner = false;
        return [];
      },
      listen: async () => {},
    },
    probe: async () => ({ ok: true }),
    owner: () => owner,
  });
  assert.match(await bridge.run(), /已接手/);
});

test("atrium chat --tool claude：说明走原生界面 + bridge 注入，给出装 hook 的命令", () => {
  assert.throws(
    () => chatMode("claude"),
    (error: unknown) =>
      error instanceof Problem &&
      error.code === "conflict" &&
      /原生界面/.test(error.message) &&
      /atrium secretary bridge/.test(error.message) &&
      error.nextCommand === "atrium secretary bridge --install-hook",
  );
});
