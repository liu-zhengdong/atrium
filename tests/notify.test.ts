import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import {
  afterFailure,
  bindMatch,
  BUTTON_TITLE_MAX,
  bypassed,
  cardKeyboard,
  cardText,
  decidedCardText,
  inQuiet,
  MAX_ATTEMPTS,
  MESSAGE_ITEMS,
  messageText,
  noteReply,
  noteTarget,
  parseCallback,
  parseBatch,
  parseProxy,
  parseQuiet,
  parseToken,
  proxyFor,
  proxyText,
  pushOf,
  quietEnd,
  scrub,
  sendAt,
  settingsPatch,
  sourceOf,
  togglePick,
  type CardChoice,
  type PushEvent,
} from "../server/notify/model.ts";
import { width } from "../server/text-width.ts";
import { telegramFile } from "../server/notify/store.ts";
import { redact } from "../server/secret-redact.ts";
import { denyReason, leaderRule } from "../server/leaders/scope.ts";
import { statusText } from "../cli/notify.ts";
import { removeTemp } from "./temp-dir.ts";

const TOKEN = "123456789:AAH-fakeTokenForTestsOnly_abcdefghijk";
const OTHER = "987654321:BBx-anotherFakeTokenForTests_zyxwvuts";
/** 东八区：测试不依赖本机时区。 */
const EAST8 = () => 480;
const at = (clock: string) => Date.parse(`2026-09-28T${clock}:00+08:00`);

const usage = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (error: { statusCode?: number; message: string }) => {
    assert.equal(error.statusCode, 400, error.message);
    assert.match(error.message, pattern);
    return true;
  });

// ---- 纯函数 ----

const event = (over: Partial<PushEvent>): PushEvent => ({
  id: 7,
  subscriber: "secretary",
  kind: "escalated",
  task: null,
  actor: "a2",
  detail: {},
  ...over,
});
const titles: Record<string, string> = {
  t171: "Telegram 推送",
  t9: "很长".repeat(40),
};
const title = (ref: string) => titles[ref] ?? null;

test("推什么：只推等你拍板、上交到秘书的卡住／越界／里程碑上线、会审要你拍板；只带标题和短号", () => {
  const choice = pushOf(
    event({
      kind: "choice_ready",
      detail: { choice: "c2", title: "Atrium 下一步", hint: "正文不推" },
    }),
    "secretary",
    title,
  );
  assert.deepEqual(choice, {
    key: "event:7",
    kind: "choice",
    ref: "c2",
    title: "Atrium 下一步",
  });
  const stuck = pushOf(
    event({
      detail: {
        kind: "stuck",
        task: "t171",
        reason: "上交说明是正文，不推",
        title: "a2 上交：搞不定 · Telegram 推送",
      },
    }),
    "secretary",
    title,
  );
  assert.deepEqual(stuck, {
    key: "event:7",
    kind: "stuck",
    ref: "t171",
    title: "Telegram 推送",
  });
  assert.equal(
    pushOf(
      event({ detail: { kind: "beyond", from: "a3", reason: "x" } }),
      "secretary",
      title,
    )?.ref,
    "a3",
    "没挂任务的上交用上交的 leader 短号",
  );
  assert.equal(
    pushOf(
      event({ detail: { kind: "shipped", task: "t9" } }),
      "secretary",
      title,
    )?.title.endsWith("…"),
    true,
    "长标题截短",
  );
  // 不推：投给 leader 的、需要别的部分配合、选项单知会、过程事件、格式不对的。
  for (const skipped of [
    event({ subscriber: "a1", detail: { kind: "stuck", task: "t171" } }),
    event({
      subscriber: "a1",
      kind: "choice_ready",
      detail: { choice: "c2" },
    }),
    event({ detail: { kind: "cross", task: "t171" } }),
    event({ kind: "choice_notice", detail: { choice: "c2" } }),
    event({ kind: "choice_decided", detail: { choice: "c2" } }),
    event({ kind: "failed", task: "t171" }),
    event({ kind: "online", task: "t171" }),
    event({ kind: "merged", task: "t171" }),
    event({ kind: "choice_ready", detail: { choice: "x" } }),
    event({ detail: { kind: "stuck" }, actor: null }),
    event({ kind: "council_escalated", task: "t171" }),
  ])
    assert.equal(
      pushOf(skipped, "secretary", title),
      null,
      JSON.stringify(skipped),
    );
});

test("消息：一条列多件，超过上限写还有几件", () => {
  assert.equal(
    messageText([{ kind: "choice", ref: "c2", title: "下一步" }]),
    "Atrium：1 件事\n【等你拍板】c2 下一步",
  );
  assert.equal(
    messageText([
      { kind: "stuck", ref: "a3", title: "" },
      { kind: "shipped", ref: "t5", title: "组织树" },
    ]),
    "Atrium：2 件事\n【卡住了】a3\n【里程碑上线】t5 组织树",
  );
  const many = Array.from({ length: MESSAGE_ITEMS + 3 }, (_, i) => ({
    kind: "beyond" as const,
    ref: `t${i + 1}`,
    title: "x",
  }));
  const text = messageText(many);
  assert.equal(text.split("\n").length, MESSAGE_ITEMS + 2);
  assert.match(text, /还有 3 件，atrium top 查看$/);
});

test("免打扰：跨午夜与当天两种时段，结束时刻按本机钟点", () => {
  const night = parseQuiet("23:00-08:00")!;
  assert.deepEqual(night, { start: 1380, end: 480 });
  assert.equal(inQuiet(at("22:59"), night, EAST8), false);
  assert.equal(inQuiet(at("23:00"), night, EAST8), true);
  assert.equal(inQuiet(at("03:00"), night, EAST8), true);
  assert.equal(inQuiet(at("08:00"), night, EAST8), false);
  assert.equal(
    quietEnd(at("23:30"), night, EAST8),
    Date.parse("2026-09-29T08:00:00+08:00"),
  );
  assert.equal(quietEnd(at("07:59"), night, EAST8), at("08:00"));
  assert.equal(quietEnd(at("12:00"), night, EAST8), at("12:00"));
  const noon = parseQuiet("12:00-13:30")!;
  assert.equal(inQuiet(at("12:30"), noon, EAST8), true);
  assert.equal(inQuiet(at("13:30"), noon, EAST8), false);
  assert.equal(quietEnd(at("12:10"), noon, EAST8), at("13:30"));
  assert.equal(inQuiet(at("03:00"), null, EAST8), false);
  for (const off of ["off", "none", "", null])
    assert.equal(parseQuiet(off), null);
  usage(() => parseQuiet("23:00"), /--quiet: 免打扰时段应为/);
  usage(() => parseQuiet("25:00-08:00"), /--quiet/);
  usage(() => parseQuiet("08:00-08:00"), /不能是同一时刻/);
});

test("什么时候发：攒满窗口，落在免打扰推到结束，失败等到重试时刻", () => {
  const quiet = parseQuiet("23:00-08:00");
  const base = { batchMs: 60_000, quiet, offset: EAST8, retryAt: null };
  assert.equal(sendAt({ ...base, oldest: at("10:00") }), at("10:00") + 60_000);
  assert.equal(
    sendAt({ ...base, oldest: at("22:59") + 30_000 }),
    Date.parse("2026-09-29T08:00:00+08:00"),
  );
  assert.equal(
    sendAt({ ...base, oldest: at("10:00"), retryAt: at("10:05") }),
    at("10:05"),
  );
  assert.equal(
    sendAt({ ...base, batchMs: 0, oldest: at("10:00") }),
    at("10:00"),
  );
});

test("失败重试：凭据错了直接放弃，网络与 5xx 退避重试，429 按要求等，满次数放弃", () => {
  const now = at("10:00");
  for (const status of [400, 401, 403, 404])
    assert.deepEqual(afterFailure({ status, message: "x" }, 0, now), {
      kind: "give_up",
      attempts: 1,
    });
  assert.deepEqual(afterFailure({ status: null, message: "x" }, 0, now), {
    kind: "retry",
    attempts: 1,
    at: now + 30_000,
  });
  assert.deepEqual(afterFailure({ status: 502, message: "x" }, 2, now), {
    kind: "retry",
    attempts: 3,
    at: now + 120_000,
  });
  assert.deepEqual(
    afterFailure({ status: 429, retryAfter: 300, message: "x" }, 0, now),
    { kind: "retry", attempts: 1, at: now + 300_000 },
  );
  assert.deepEqual(
    afterFailure({ status: null, message: "x" }, MAX_ATTEMPTS - 1, now),
    { kind: "give_up", attempts: MAX_ATTEMPTS },
  );
});

test("代理：单独配的优先，其次按协议取系统代理，NO_PROXY 直连，socks 不用", () => {
  const https = new URL("https://api.telegram.org/bot1/sendMessage");
  const local = new URL("http://127.0.0.1:9/bot1/sendMessage");
  const env = {
    HTTPS_PROXY: "http://10.0.0.1:7890",
    HTTP_PROXY: "http://10.0.0.2:7890",
  };
  assert.equal(
    proxyFor(https, "http://127.0.0.1:1080", env)?.host,
    "127.0.0.1:1080",
  );
  assert.equal(proxyFor(https, null, env)?.host, "10.0.0.1:7890");
  assert.equal(proxyFor(local, null, env)?.host, "10.0.0.2:7890");
  assert.equal(
    proxyFor(https, null, { https_proxy: "10.0.0.3:8080" })?.href,
    "http://10.0.0.3:8080/",
  );
  assert.equal(
    proxyFor(https, null, { ALL_PROXY: "http://10.0.0.4:1" })?.host,
    "10.0.0.4:1",
  );
  assert.equal(proxyFor(https, null, { ALL_PROXY: "socks5://h:1" }), null);
  assert.equal(proxyFor(https, null, {}), null);
  assert.equal(
    proxyFor(https, null, { ...env, NO_PROXY: "localhost,.telegram.org" }),
    null,
  );
  assert.equal(bypassed(local, "127.0.0.1"), true);
  assert.equal(bypassed(local, "127.0.0.1:10"), false);
  assert.equal(bypassed(local, "*"), true);
  assert.equal(bypassed(https, "telegram.org"), true);
  assert.equal(bypassed(https, "gram.org"), false);
  assert.equal(parseProxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(parseProxy("http://u:p%40ss@h:1"), "http://u:p%40ss@h:1");
  assert.equal(parseProxy("off"), null);
  usage(() => parseProxy("socks5://127.0.0.1:1080"), /--proxy: 应为 http/);
  usage(() => parseProxy("127.0.0.1:7890"), /--proxy/);
  usage(() => parseProxy("http://h:1/path"), /不带路径/);
  assert.equal(proxyText("http://u:p@h:1"), "http://***@h:1");
  assert.equal(proxyText(null), null);
});

test("设置与 token 校验：报错不回显 token，未知字段与缺项给参数名", () => {
  assert.equal(parseToken(` ${TOKEN}\n`), TOKEN);
  for (const bad of ["123:abc", `${TOKEN} extra`, "not-a-token-at-all"])
    usage(() => parseToken(bad), /不像 bot token/);
  try {
    parseToken(`${TOKEN}x y`);
  } catch (error) {
    assert.doesNotMatch((error as Error).message, /AAH-fake/);
  }
  usage(() => parseToken(""), /标准输入是空的/);
  assert.equal(parseBatch("0"), 0);
  usage(() => parseBatch("3601"), /--batch/);
  usage(() => parseBatch("1.5"), /--batch/);
  assert.deepEqual(settingsPatch({ enabled: false, batch_seconds: "30" }), {
    enabled: false,
    batch_seconds: 30,
  });
  usage(() => settingsPatch({}), /至少给一项/);
  usage(() => settingsPatch({ token: TOKEN }), /token: 是未知字段/);
  usage(() => settingsPatch({ enabled: "yes" }), /--on\/--off/);
  assert.equal(bindMatch("/start abcd12", "abcd12"), true);
  assert.equal(bindMatch("abcd12", "abcd12"), true);
  assert.equal(bindMatch("xabcd12", "abcd12"), false);
});

test("脱敏：请求地址与报错里的 token 都抹掉，通用脱敏也认 Telegram token", () => {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  assert.equal(scrub(url), "https://api.telegram.org/bot***/sendMessage");
  assert.equal(scrub(`失败：${TOKEN}`, TOKEN), "失败：***");
  assert.equal(scrub(`/bot${OTHER}/getMe`), "/bot***/getMe");
  assert.doesNotMatch(redact(`see ${url}`), /AAH-fake/);
});

test("权限：leader 令牌不能改推送设置，状态读不到 token", () => {
  for (const [method, route] of [
    ["PUT", "/api/notify/telegram/token"],
    ["POST", "/api/notify/telegram/bind"],
    ["PATCH", "/api/notify/telegram"],
    ["POST", "/api/notify/telegram/test"],
    ["DELETE", "/api/notify/telegram"],
  ] as const) {
    assert.equal(leaderRule(method, route), "deny");
    assert.match(denyReason("a1", method, route), /推送到手机的设置/);
  }
  assert.match(
    statusText({
      configured: false,
      bot: null,
      bound: false,
      enabled: true,
      quiet: "off",
      batch_seconds: 60,
      proxy: null,
      system_proxy: null,
      pending: 0,
      last_sent_at: null,
      last_error: null,
      bind: null,
    }),
    /@BotFather.*atrium notify token/,
  );
});

// ---- 假 Telegram 接口 ----

test("选项单卡片：按钮只放选项号与选项标题，回调数据短且可解析，卡片不带选项正文", () => {
  const choice: CardChoice = {
    ref: "c12",
    title: "Atrium 下一步",
    status: "open",
    options: [
      { seq: 1, title: "先做推送", task: null },
      {
        seq: 2,
        title: "一个很长很长的选项标题，超过按钮能放下的宽度还要再长一些",
        task: null,
      },
    ],
  };
  const keys = cardKeyboard(choice, { picks: [], note: null });
  assert.deepEqual(
    keys.map((row) => row.map((b) => b.text)),
    [["1. 先做推送"], [keys[1]![0]!.text], ["拍板", "都不选"]],
  );
  assert.match(keys[1]![0]!.text, /^2\. 一个很长.*…$/);
  assert(width(keys[1]![0]!.text) <= BUTTON_TITLE_MAX + 3);
  assert.deepEqual(
    keys.flat().map((b) => b.callback_data),
    ["c:12:1", "c:12:2", "c:12:ok", "c:12:no"],
  );
  for (const b of keys.flat()) assert(Buffer.byteLength(b.callback_data) <= 64);
  const picked = cardKeyboard(choice, { picks: [2], note: null });
  assert.equal(picked[1]![0]!.text.slice(0, 5), "✅ 2. ");
  assert.equal(picked[2]![0]!.text, "拍板（选 2）");

  const text = cardText(choice, { picks: [], note: null });
  assert.match(text, /^【等你拍板】c12 Atrium 下一步\n/);
  assert.match(text, /回复这条消息写一句说明/);
  assert.match(text, /atrium choice show c12/);
  assert.match(
    cardText(choice, { picks: [], note: "先做 1\n第二行不显示" }),
    /说明：先做 1（再回复一条可改）/,
  );
  assert.equal(
    decidedCardText(
      {
        ...choice,
        status: "picked",
        options: [
          { seq: 1, title: "a", task: "t7" },
          { seq: 2, title: "b", task: null },
        ],
      },
      "注意接口",
    ),
    "【已拍板】c12 Atrium 下一步\n选了 1，建了 t7\n说明：注意接口",
  );
  assert.equal(
    decidedCardText({ ...choice, status: "passed" }, null),
    "【已拍板】c12 Atrium 下一步\n这轮都不要",
  );

  assert.deepEqual(parseCallback("c:12:2"), {
    kind: "toggle",
    choice: "c12",
    seq: 2,
  });
  assert.deepEqual(parseCallback("c:12:ok"), { kind: "pick", choice: "c12" });
  assert.deepEqual(parseCallback("c:12:no"), { kind: "pass", choice: "c12" });
  for (const bad of [
    "c:0:1",
    "c:12:0",
    "c:12:x",
    "c:12:1:2",
    "x:12:1",
    "",
    12,
    null,
    "c:12345678901234567:1",
  ])
    assert.equal(parseCallback(bad), null, String(bad));

  assert.deepEqual(togglePick([], 3), [3]);
  assert.deepEqual(togglePick([3], 1), [1, 3]);
  assert.deepEqual(togglePick([1, 3], 3), [1]);
});

test("收到的更新只认绑定的私聊；回复说明归哪份选项单", () => {
  const button = (from: number, at: number) => ({
    update_id: 1,
    callback_query: {
      id: "q",
      data: "c:1:ok",
      from: { id: from },
      message: { message_id: 5, chat: { id: at } },
    },
  });
  assert.deepEqual(sourceOf(button(42, 42), 42), { kind: "bound" });
  assert.deepEqual(sourceOf(button(7, 42), 42), { kind: "foreign", chat: 42 });
  assert.deepEqual(sourceOf(button(42, -9), 42), { kind: "foreign", chat: -9 });
  const message = (chat: number, type: string, from: number) => ({
    update_id: 2,
    message: {
      message_id: 6,
      text: "说明",
      chat: { id: chat, type },
      from: { id: from },
    },
  });
  assert.deepEqual(sourceOf(message(42, "private", 42), 42), { kind: "bound" });
  assert.deepEqual(sourceOf(message(-5, "group", 42), 42), {
    kind: "foreign",
    chat: -5,
  });
  assert.deepEqual(sourceOf(message(99, "private", 99), 42), {
    kind: "foreign",
    chat: 99,
  });
  assert.deepEqual(sourceOf({ update_id: 3 }, 42), { kind: "skip" });

  assert.deepEqual(noteTarget({ card: "c3" }, ["c1", "c2"]), {
    kind: "choice",
    choice: "c3",
  });
  assert.deepEqual(noteTarget({ card: null }, ["c1"]), { kind: "not_card" });
  assert.deepEqual(noteTarget(null, ["c1"]), { kind: "choice", choice: "c1" });
  assert.deepEqual(noteTarget(null, ["c1", "c2"]), {
    kind: "ambiguous",
    count: 2,
  });
  assert.deepEqual(noteTarget(null, []), { kind: "none" });
  assert.equal(noteReply({ kind: "choice", choice: "c1" }), null);
  assert.match(noteReply({ kind: "ambiguous", count: 2 })!, /有 2 份等你拍板/);
  assert.match(noteReply({ kind: "not_card" })!, /不是等你拍板的卡片/);
  assert.match(noteReply({ kind: "none" })!, /没有等你拍板/);
});

type Call = { method: string; token: string; body: Record<string, any> };

function fakeTelegram(t: { after: (fn: () => unknown) => void }) {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  /** 下几次 sendMessage 回什么状态（空就 200）。 */
  const failures: { status: number; body?: object }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const reply = (status: number, value: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (!match) return reply(404, { ok: false, description: "Not Found" });
      const [, token, method] = match;
      calls.push({ method: method!, token: token!, body });
      if (token !== TOKEN && token !== OTHER)
        return reply(401, {
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        });
      if (method === "getMe")
        return reply(200, {
          ok: true,
          result: {
            username: token === TOKEN ? "atrium_test_bot" : "other_bot",
          },
        });
      if (method === "getUpdates") {
        // 和真接口一样长轮询：没有新更新就等到有或到 timeout 秒。
        const offset = typeof body.offset === "number" ? body.offset : 0;
        const until = Date.now() + (Number(body.timeout) || 0) * 1000;
        let gone = false;
        res.on("close", () => {
          gone = true;
        });
        const check = () => {
          if (gone) return;
          const result = updates.filter(
            (u) => (u as { update_id: number }).update_id >= offset,
          );
          if (result.length || Date.now() >= until)
            return reply(200, { ok: true, result });
          setTimeout(check, 10);
        };
        return check();
      }
      if (method === "answerCallbackQuery" || method === "editMessageText")
        return reply(200, { ok: true, result: true });
      if (method === "sendMessage") {
        const failure = failures.shift();
        if (failure)
          return reply(failure.status, {
            ok: false,
            error_code: failure.status,
            description: `boom ${req.url}`,
            ...failure.body,
          });
        return reply(200, { ok: true, result: { message_id: calls.length } });
      }
      reply(404, { ok: false, description: "no method" });
    });
  });
  const ready = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`),
    ),
  );
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const sent = () =>
    calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
  return { ready, calls, updates, failures, sent };
}

/** 假 HTTP CONNECT 代理：记下隧道目标，原样转发。 */
function fakeProxy(t: { after: (fn: () => unknown) => void }) {
  const tunnels: string[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req, client, head) => {
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  const ready = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`),
    ),
  );
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { ready, tunnels };
}

async function open(
  t: { after: (fn: () => unknown) => void },
  over: { env?: Record<string, string>; data?: string } = {},
) {
  const tg = fakeTelegram(t);
  const api = await tg.ready;
  const data = over.data ?? mkdtempSync(join(tmpdir(), "atrium-notify-"));
  if (!over.data) t.after(() => removeTemp(data));
  const logs: string[] = [];
  let clock = at("10:00");
  const created = await createApp({
    data,
    auth: false,
    tasks: { pace: async () => undefined },
    notify: {
      api,
      env: over.env ?? {},
      now: () => clock,
      offset: EAST8,
      timeoutMs: 3000,
      pollSeconds: 1,
      log: (line) => logs.push(line),
    },
  });
  t.after(() => created.app.close());
  const call = async (method: string, url: string, payload?: unknown) => {
    const response = await created.app.inject({
      method: method as "GET",
      url,
      headers: { host: "127.0.0.1" },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      raw: response.body,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  const ok = async (method: string, url: string, payload?: unknown) => {
    const result = await call(method, url, payload);
    assert(
      result.status < 300,
      `${method} ${url} → ${result.status} ${result.raw}`,
    );
    return result.body;
  };
  return {
    ...created,
    tg,
    data,
    logs,
    call,
    ok,
    tick: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

/** 存 token、按绑定码绑上私聊。 */
async function bindUp(x: Awaited<ReturnType<typeof open>>) {
  const stored = await x.ok("PUT", "/api/notify/telegram/token", {
    token: TOKEN,
  });
  x.tg.updates.push(
    {
      update_id: 10,
      message: { text: stored.code, chat: { id: -5, type: "group" } },
    },
    {
      update_id: 11,
      message: {
        text: `/start ${stored.code}`,
        chat: { id: 42, type: "private" },
      },
    },
  );
  const bound = await x.ok("POST", "/api/notify/telegram/bind", { timeout: 1 });
  assert.equal(bound.bound, true);
  return stored;
}

test("绑定：token 从请求体存进 0600 凭据文件，状态与回执都不带 token；发绑定码的私聊绑上", async (t) => {
  const x = await open(t);
  const empty = await x.ok("GET", "/api/notify/telegram");
  assert.equal(empty.configured, false);
  const bad = await x.call("PUT", "/api/notify/telegram/token", {
    token: `${TOKEN}zz zz`,
  });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.raw, /AAH-fake/);
  const wrong = await x.call("PUT", "/api/notify/telegram/token", {
    token: "111111111:ZZZ-notAcceptedByFakeTelegram_abcdefghi",
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /不认这个 bot token/);
  assert.doesNotMatch(wrong.raw, /ZZZ-not/);
  assert.equal(existsSync(telegramFile(x.data)), false);

  const stored = await x.ok("PUT", "/api/notify/telegram/token", {
    token: TOKEN,
  });
  assert.equal(stored.bot, "atrium_test_bot");
  assert.match(stored.code, /^[0-9a-f]{10}$/);
  assert.equal(
    stored.link,
    `https://t.me/atrium_test_bot?start=${stored.code}`,
  );
  const file = telegramFile(x.data);
  assert.match(readFileSync(file, "utf8"), /AAH-fake/);
  if (process.platform !== "win32")
    assert.equal(statSync(file).mode & 0o777, 0o600);
  const status = await x.call("GET", "/api/notify/telegram");
  assert.doesNotMatch(status.raw, /AAH-fake/);
  assert.equal(status.body.bound, false);
  assert.equal(status.body.bind.code, stored.code);

  // 没人发绑定码：超时，给出绑定码再等。
  const waited = await x.ok("POST", "/api/notify/telegram/bind", {
    timeout: 0,
  });
  assert.equal(waited.bound, false);
  assert.equal(waited.timed_out, true);
  assert.equal(waited.code, stored.code);
  const tooLong = await x.call("POST", "/api/notify/telegram/bind", {
    timeout: 999,
  });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /--timeout/);

  // 群里发的码不认，私聊的认。
  x.tg.updates.push(
    {
      update_id: 10,
      message: { text: stored.code, chat: { id: -5, type: "group" } },
    },
    {
      update_id: 11,
      message: {
        text: `/start ${stored.code}`,
        chat: { id: 42, type: "private" },
      },
    },
  );
  const bound = await x.ok("POST", "/api/notify/telegram/bind", { timeout: 1 });
  assert.equal(bound.bound, true);
  assert.equal(bound.bot, "atrium_test_bot");
  assert.equal(x.tg.sent().at(-1)!.chat_id, 42);
  assert.match(x.tg.sent().at(-1)!.text, /已绑定 Atrium/);
  const after = await x.ok("GET", "/api/notify/telegram");
  assert.equal(after.bound, true);
  assert.equal(after.bind, null);
  await x.ok("POST", "/api/notify/telegram/test");
  assert.match(x.tg.sent().at(-1)!.text, /测试推送/);
  // 所有经过假接口的调用都用的是存下的 token（token 只在 URL 里）。
  assert(x.tg.calls.every((c) => !JSON.stringify(c.body).includes(TOKEN)));

  const removed = await x.ok("DELETE", "/api/notify/telegram");
  assert.equal(removed.removed, true);
  assert.doesNotMatch(readFileSync(file, "utf8"), /AAH-fake/);
  const test2 = await x.call("POST", "/api/notify/telegram/test");
  assert.equal(test2.status, 409);
  assert.equal(test2.body.nextCommand, "pbpaste | atrium notify token");
});

test("推送：上交攒成一条、选项单单发带按钮的卡片，过程事件不推，只带标题与短号", async (t) => {
  const x = await open(t);
  await bindUp(x);
  await x.ok("PATCH", "/api/notify/telegram", { batch_seconds: 60 });
  const before = x.tg.sent().length;
  for (const node of [
    { slug: "org", kind: "org", name: "组织" },
    { parent: "o1", slug: "atrium", kind: "project", name: "Atrium" },
  ])
    await x.ok("POST", "/api/org/nodes", { ...node, reason: "建" });
  await x.ok("POST", "/api/leaders", {
    name: "Atrium 负责人",
    worker: "codex",
  });
  await x.ok("PATCH", "/api/org/nodes/o1", { leader: "a1", reason: "负责" });
  const task = await x.ok("POST", "/api/tasks", { title: "组织树上线" });
  await x.ok("POST", "/api/leaders/a1/escalate", {
    kind: "stuck",
    note: "上交说明不该出现在手机上",
  });
  await x.ok("POST", "/api/leaders/a1/escalate", {
    kind: "shipped",
    note: "端到端：atrium org tree",
    task: task.ref,
  });
  await x.ok("POST", "/api/leaders/a1/escalate", {
    kind: "cross",
    note: "需要别的部分配合，不推",
  });
  const option = (n: number) => ({
    title: `选项${n}`,
    gain: "正文",
    why_now: "正文",
    cost: "正文",
    skip: "正文",
    basis: [],
  });
  const choice = await x.ok("POST", "/api/choices", {
    node: "o2",
    choice: {
      title: "Atrium 下一步",
      options: [option(1), option(2), option(3)],
      recommend: [1],
      why: "推荐理由不推",
    },
  });
  x.taskRunner.inbox.publish({
    subscriber: "secretary",
    taskId: task.id,
    source: "runner",
    kind: "failed",
    key: `task:${task.ref}`,
    detail: { reason: "过程事件" },
  });
  assert.deepEqual(
    x.notifier.queued().map((q) => `${q.kind} ${q.ref}`),
    ["stuck a1", `shipped ${task.ref}`, `choice ${choice.ref}`],
  );
  // 窗口没到不发。
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before);
  x.tick(60_000);
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before + 2);
  const [digest, card] = x.tg.sent().slice(-2);
  assert.equal(
    digest!.text,
    [
      "Atrium：2 件事",
      "【卡住了】a1",
      `【里程碑上线】${task.ref} 组织树上线`,
    ].join("\n"),
  );
  assert.equal(digest!.reply_markup, undefined);
  assert.match(
    card!.text,
    new RegExp(`^【等你拍板】${choice.ref} Atrium 下一步\n`),
  );
  assert.deepEqual(
    card!.reply_markup.inline_keyboard
      .flat()
      .map((b: { text: string }) => b.text),
    ["1. 选项1", "2. 选项2", "3. 选项3", "拍板", "都不选"],
  );
  for (const sent of [digest!, card!])
    assert.doesNotMatch(
      JSON.stringify(sent),
      /上交说明|端到端|正文|推荐理由|过程事件/,
    );
  assert.equal(x.notifier.queued().length, 0);
  // 已发过的同一条事件不重推。
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before + 2);

  // 排队期间拍了板的选项单不再推。
  const second = await x.ok("POST", "/api/choices", {
    node: "o2",
    choice: {
      title: "第二份",
      options: [option(1), option(2), option(3)],
      recommend: [1],
      why: "理由",
    },
  });
  await x.ok("POST", `/api/choices/${second.ref}/pass`, { note: "不要" });
  x.tick(60_000);
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before + 2);
  assert.equal(x.notifier.queued().length, 0);

  // 关掉：不排队。
  await x.ok("PATCH", "/api/notify/telegram", { enabled: false });
  await x.ok("POST", "/api/leaders/a1/escalate", {
    kind: "beyond",
    note: "关着不推",
  });
  assert.equal(x.notifier.queued().length, 0);
});

test("免打扰：时段内攒着，时段结束合成一条发", async (t) => {
  const x = await open(t);
  await bindUp(x);
  await x.ok("PATCH", "/api/notify/telegram", {
    batch_seconds: 0,
    quiet: "23:00-08:00",
  });
  const before = x.tg.sent().length;
  x.setClock(at("23:30"));
  for (const choice of ["c1", "c2"])
    x.taskRunner.inbox.publish({
      subscriber: "secretary",
      source: "choice",
      kind: "choice_ready",
      key: `choice:${choice}`,
      detail: { choice, title: `选项单${choice}` },
    });
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before);
  x.setClock(Date.parse("2026-09-29T07:59:00+08:00"));
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before);
  x.setClock(Date.parse("2026-09-29T08:00:00+08:00"));
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before + 1);
  assert.match(x.tg.sent().at(-1)!.text, /2 件事[\s\S]*c1[\s\S]*c2/);
  const status = await x.ok("GET", "/api/notify/telegram");
  assert.equal(status.quiet, "23:00-08:00");
  assert.equal(status.pending, 0);
});

test("失败重试有上限，日志与状态里没有 token；凭据错误不重试", async (t) => {
  const x = await open(t);
  await bindUp(x);
  await x.ok("PATCH", "/api/notify/telegram", { batch_seconds: 0 });
  const publish = (key: string) =>
    x.taskRunner.inbox.publish({
      subscriber: "secretary",
      source: "choice",
      kind: "choice_ready",
      key,
      detail: { choice: key.slice(7), title: "重试" },
    });
  for (let i = 0; i < MAX_ATTEMPTS; i++) x.tg.failures.push({ status: 502 });
  publish("choice:c7");
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await x.notifier.flush();
    x.tick(60 * 60_000);
  }
  assert.equal(x.logs.length, MAX_ATTEMPTS);
  assert.match(x.logs[0]!, /第 1 次.*秒后重试/);
  assert.match(x.logs.at(-1)!, /第 5 次），放弃这 1 件（c7）/);
  for (const line of x.logs) {
    assert.doesNotMatch(line, /AAH-fake/);
    assert.match(line, /bot\*\*\*/, "假接口把请求地址回在描述里，要被抹掉");
  }
  const status = await x.call("GET", "/api/notify/telegram");
  assert.doesNotMatch(status.raw, /AAH-fake/);
  assert.match(status.body.last_error.error, /boom/);
  assert.equal(status.body.pending, 0);
  // 过了放弃的，再来的新事件照常发。
  publish("choice:c8");
  await x.notifier.flush();
  assert.match(x.tg.sent().at(-1)!.text, /c8/);

  // 401：不重试。
  x.logs.length = 0;
  x.tg.failures.push({ status: 401 });
  publish("choice:c9");
  await x.notifier.flush();
  assert.equal(x.logs.length, 1);
  assert.match(x.logs[0]!, /第 1 次），放弃/);
  // 429：按 retry_after 等。
  x.tg.failures.push({
    status: 429,
    body: { parameters: { retry_after: 600 } },
  });
  publish("choice:c10");
  await x.notifier.flush();
  assert.match(x.logs.at(-1)!, /600 秒后重试/);
});

test("连不上：报错与日志抹掉 token，提示配代理", async (t) => {
  const x = await open(t);
  await bindUp(x);
  // 指向一个没人听的端口：单独配的代理连不上。
  const dead = net.createServer();
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const port = (dead.address() as net.AddressInfo).port;
  await new Promise((resolve) => dead.close(resolve));
  await x.ok("PATCH", "/api/notify/telegram", {
    proxy: `http://127.0.0.1:${port}`,
  });
  const failed = await x.call("POST", "/api/notify/telegram/test");
  assert.equal(failed.status, 424);
  assert.match(failed.body.error, /代理连不上/);
  assert.match(failed.body.error, /检查代理在不在跑.*--proxy off/);
  assert.doesNotMatch(failed.raw, /AAH-fake/);
});

test("代理：单独配的走 CONNECT 隧道，其次系统代理，NO_PROXY 直连", async (t) => {
  const proxy = fakeProxy(t);
  const proxyUrl = await proxy.ready;
  const x = await open(t, { env: { HTTP_PROXY: proxyUrl } });
  // 系统代理（服务环境里的 HTTP_PROXY；假接口是 http）。
  await bindUp(x);
  assert(
    proxy.tunnels.length >= 3,
    "getMe、getUpdates、sendMessage 都经过代理",
  );
  const status = await x.ok("GET", "/api/notify/telegram");
  assert.equal(status.system_proxy, proxyUrl);
  assert.equal(status.proxy, null);

  const y = await open(t, {
    env: { HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" },
  });
  await bindUp(y);

  // 单独配的代理（带用户名密码），状态里抹掉。
  const z = await open(t, { env: { HTTP_PROXY: "http://127.0.0.1:1" } });
  const tunnels = proxy.tunnels.length;
  const withAuth = proxyUrl.replace("http://", "http://me:secret@");
  const set = await z.ok("PATCH", "/api/notify/telegram", { proxy: withAuth });
  assert.equal(set.proxy, proxyUrl.replace("http://", "http://***@"));
  await bindUp(z);
  assert(proxy.tunnels.length > tunnels);
  assert.match(readFileSync(telegramFile(z.data), "utf8"), /me:secret/);
});

test("启动自愈：凭据文件写坏了挪开留档，按没配处理；重启后接着发没发完的", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-notify-"));
  t.after(() => removeTemp(data));
  writeFileSync(telegramFile(data), "{not json");
  const broken = await open(t, { data });
  const status = await broken.ok("GET", "/api/notify/telegram");
  assert.equal(status.configured, false);
  assert(
    readdirSync(data).some((name) => name.startsWith("telegram.json.invalid-")),
  );
  await bindUp(broken);
  await broken.ok("PATCH", "/api/notify/telegram", { batch_seconds: 3600 });
  broken.taskRunner.inbox.publish({
    subscriber: "secretary",
    source: "choice",
    kind: "choice_ready",
    key: "choice:c3",
    detail: { choice: "c3", title: "重启前排队" },
  });
  assert.equal(broken.notifier.queued().length, 1);
  await broken.app.close();

  const again = await open(t, { data });
  const back = await again.ok("GET", "/api/notify/telegram");
  assert.equal(back.bound, true);
  assert.equal(back.pending, 1);
  again.tick(3600_000);
  await again.notifier.flush();
  assert.match(again.tg.sent().at(-1)!.text, /c3 重启前排队/);
});

/** 等到条件成立（收消息是后台长轮询，按钮与回复的结果异步回来）。 */
async function until<T>(
  read: () => T | undefined | null | false,
  what: string,
) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("在 Telegram 里拍板：点选项再点拍板等同 choice pick，回复卡片附说明；重复点回已拍板，别的聊天一律忽略", async (t) => {
  const x = await open(t);
  await bindUp(x);
  await x.ok("PATCH", "/api/notify/telegram", { batch_seconds: 0 });
  for (const node of [
    { slug: "org", kind: "org", name: "组织" },
    { parent: "o1", slug: "atrium", kind: "project", name: "Atrium" },
  ])
    await x.ok("POST", "/api/org/nodes", { ...node, reason: "建" });
  const option = (n: number) => ({
    title: `选项${n}`,
    gain: "选项正文不上手机",
    why_now: "正文",
    cost: "正文",
    skip: "正文",
    basis: [],
  });
  const make = (title: string) =>
    x.ok("POST", "/api/choices", {
      node: "o2",
      choice: {
        title,
        options: [option(1), option(2), option(3)],
        recommend: [1],
        why: "推荐理由不推",
      },
    });
  const first = await make("Atrium 下一步");
  const second = await make("第二份");
  const third = await make("第三份");
  await x.notifier.flush();
  const cards = await until(() => {
    const list = x.tg.calls.flatMap((c, i): Record<string, any>[] =>
      c.method === "sendMessage" && c.body.reply_markup
        ? [{ ...c.body, message_id: i + 1 }]
        : [],
    );
    return list.length === 3 && list;
  }, "三张卡片");
  const cardOf = (ref: string) =>
    cards.find((c) => c.text.startsWith(`【等你拍板】${ref} `))!;
  for (const card of cards)
    assert.doesNotMatch(JSON.stringify(card), /正文|推荐理由/);

  let updateId = 100;
  let queryId = 0;
  const calls = (method: string) =>
    x.tg.calls.filter((c) => c.method === method).map((c) => c.body);
  /** 点一个按钮，等回执（answerCallbackQuery）。 */
  const click = async (data: string, message: number, chat = 42) => {
    const id = `q${++queryId}`;
    x.tg.updates.push({
      update_id: updateId++,
      callback_query: {
        id,
        data,
        from: { id: chat },
        message: { message_id: message, chat: { id: chat } },
      },
    });
    return until(
      () =>
        calls("answerCallbackQuery").find((a) => a.callback_query_id === id),
      `按钮 ${data} 的回执`,
    );
  };
  /** 发一句话（可回复某条消息），等机器人回。 */
  const say = async (text: string, replyTo?: number) => {
    const message_id = updateId * 10;
    x.tg.updates.push({
      update_id: updateId++,
      message: {
        message_id,
        text,
        chat: { id: 42, type: "private" },
        from: { id: 42 },
        ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
      },
    });
    return until(
      () => x.tg.sent().find((m) => m.reply_to_message_id === message_id),
      `「${text}」的回复`,
    );
  };
  const edits = () => calls("editMessageText");
  const taskCount = () =>
    (x.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  const choiceOf = (ref: string) => x.ok("GET", `/api/choices/${ref}`);
  const id1 = cardOf(first.ref).message_id;
  const n1 = first.ref.slice(1);

  // 有三份等拍板时不用回复发的话不猜归谁。
  assert.match((await say("先做 1")).text, /有 3 份等你拍板/);
  // 回复卡片：记成那份的说明，卡片上显示。
  assert.match(
    (await say("先做 1 和 3，别动接口", id1)).text,
    new RegExp(`已记下，拍板 ${first.ref} 时附上`),
  );
  assert.match(edits().at(-1)!.text, /说明：先做 1 和 3，别动接口/);
  assert.equal(edits().at(-1)!.message_id, id1);
  // 太长的说明不记，原说明保留。
  assert.match(
    (await say("长".repeat(1001), id1)).text,
    /^说明不能超过 1000 字/,
  );
  // 命令与贴图不当说明。
  assert.match((await say("/start")).text, /这里只收拍板/);

  // 点选项：选上、再点取消；卡片跟着打勾。
  assert.equal((await click(`c:${n1}:1`, id1)).text, "已选 1，再点「拍板」");
  assert.equal((await click(`c:${n1}:2`, id1)).text, "已选 1、2，再点「拍板」");
  assert.equal((await click(`c:${n1}:2`, id1)).text, "已选 1，再点「拍板」");
  assert.equal((await click(`c:${n1}:3`, id1)).text, "已选 1、3，再点「拍板」");
  assert.equal((await click(`c:${n1}:9`, id1)).text, `${first.ref} 没有选项 9`);
  assert.deepEqual(
    edits()
      .at(-1)!
      .reply_markup.inline_keyboard.flat()
      .map((b: { text: string }) => b.text),
    ["✅ 1. 选项1", "2. 选项2", "✅ 3. 选项3", "拍板（选 1、3）", "都不选"],
  );
  assert.equal((await click("c:abc:1", id1)).text, "这个按钮已失效");

  // 别的聊天点按钮、发消息：不处理、不回，记日志（不含 token）。
  const answered = calls("answerCallbackQuery").length;
  x.tg.updates.push(
    {
      update_id: updateId++,
      callback_query: {
        id: "evil",
        data: `c:${n1}:ok`,
        from: { id: 99 },
        message: { message_id: id1, chat: { id: 99 } },
      },
    },
    {
      update_id: updateId++,
      message: {
        message_id: 1,
        text: "说明",
        chat: { id: -5, type: "group" },
        from: { id: 42 },
      },
    },
  );
  await until(
    () => x.logs.some((l) => /未绑定的聊天（-5）/.test(l)),
    "外来聊天的日志",
  );
  assert(x.logs.some((l) => /未绑定的聊天（99）/.test(l)));
  assert.equal(calls("answerCallbackQuery").length, answered);
  assert.equal((await choiceOf(first.ref)).status, "open");

  // 拍板：等同 atrium choice pick 1 3 --note …，拍板人是用户。
  assert.equal((await click(`c:${n1}:ok`, id1)).text, "已拍板");
  const picked = await choiceOf(first.ref);
  assert.equal(picked.status, "picked");
  assert.equal(picked.decided_by, "u1");
  assert.equal(picked.note, "先做 1 和 3，别动接口");
  assert.deepEqual(
    picked.options.map((o: { picked: boolean }) => o.picked),
    [true, false, true],
  );
  const done = await until(
    () =>
      edits().find((e) => e.message_id === id1 && /^【已拍板】/.test(e.text)),
    "卡片改成已拍板",
  );
  assert.deepEqual(done.reply_markup.inline_keyboard, []);
  assert.match(done.text, /选了 1、3，建了 t\d+、t\d+\n说明：先做 1 和 3/);
  const inbox = x.db
    .prepare(
      "SELECT kind FROM task_inbox WHERE subscriber='secretary' AND dedupe_key=?",
    )
    .get(`choice:${first.ref}`) as { kind: string };
  assert.equal(inbox.kind, "choice_decided");

  // 重复点、点已拍板卡片上的旧按钮：幂等，回「已拍板」，不再建任务。
  const tasks = taskCount();
  assert.equal((await click(`c:${n1}:ok`, id1)).text, "已拍板");
  assert.equal((await click(`c:${n1}:no`, id1)).text, "已拍板");
  assert.equal((await click(`c:${n1}:2`, id1)).text, "已拍板");
  assert.equal(taskCount(), tasks);
  assert.equal((await choiceOf(first.ref)).status, "picked");
  // 回复已拍板的卡片：不再记。
  assert.match((await say("补一句", id1)).text, /不是等你拍板的卡片/);

  // 没选就点拍板：提示先选。
  const id2 = cardOf(second.ref).message_id;
  const n2 = second.ref.slice(1);
  const empty = await click(`c:${n2}:ok`, id2);
  assert.match(empty.text, /先点要做的选项/);
  assert.equal(empty.show_alert, true);
  // 「都不选」：等同 atrium choice pass。
  assert.equal((await click(`c:${n2}:no`, id2)).text, "已拍板");
  assert.equal((await choiceOf(second.ref)).status, "passed");
  await until(
    () =>
      edits().find((e) => e.message_id === id2 && /这轮都不要/.test(e.text)),
    "卡片改成这轮都不要",
  );

  // 只剩一份时不用回复发的话就归它；在命令行拍板后卡片也改成结果。
  const id3 = cardOf(third.ref).message_id;
  assert.match(
    (await say("都不要了")).text,
    new RegExp(`拍板 ${third.ref} 时`),
  );
  await x.ok("POST", `/api/choices/${third.ref}/pick`, { picks: [2] });
  await until(
    () =>
      edits().find(
        (e) => e.message_id === id3 && /^【已拍板】.*\n选了 2/.test(e.text),
      ),
    "命令行拍板后卡片改成结果",
  );
  assert.equal((await click(`c:${third.ref.slice(1)}:no`, id3)).text, "已拍板");
  assert.equal((await choiceOf(third.ref)).status, "picked");

  // token 不进日志，也不进任何请求体。
  assert(x.logs.every((l) => !l.includes(TOKEN)));
  assert(x.tg.calls.every((c) => !JSON.stringify(c.body).includes(TOKEN)));
  // 收消息走长轮询，只要按钮与消息两类更新。
  const polls = calls("getUpdates").filter((b) =>
    b.allowed_updates?.includes("callback_query"),
  );
  assert(polls.length > 0);
});

test("收消息：绑定时让出长轮询，绑定完接着收；关掉推送后不再收", async (t) => {
  const x = await open(t);
  await bindUp(x);
  await until(
    () =>
      x.tg.calls.some(
        (c) =>
          c.method === "getUpdates" &&
          c.body.allowed_updates?.includes("callback_query"),
      ),
    "绑定后开始收消息",
  );
  await x.ok("PATCH", "/api/notify/telegram", { enabled: false });
  const count = x.tg.calls.filter((c) => c.method === "getUpdates").length;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  // 停下后至多还有停之前那一轮收尾。
  assert(
    x.tg.calls.filter((c) => c.method === "getUpdates").length <= count + 1,
  );
  await x.ok("PATCH", "/api/notify/telegram", { enabled: true });
  await until(
    () =>
      x.tg.calls.filter((c) => c.method === "getUpdates").length > count + 1,
    "打开后接着收",
  );
});
