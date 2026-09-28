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
  bypassed,
  inQuiet,
  MAX_ATTEMPTS,
  MESSAGE_ITEMS,
  messageText,
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
  type PushEvent,
} from "../server/notify/model.ts";
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
  assert.deepEqual(
    pushOf(
      event({ kind: "council_escalated", task: "t171" }),
      "secretary",
      title,
    ),
    { key: "event:7", kind: "council", ref: "t171", title: "Telegram 推送" },
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
    event({ kind: "council_escalated", task: null }),
  ])
    assert.equal(
      pushOf(skipped, "secretary", title),
      null,
      JSON.stringify(skipped),
    );
});

test("紧急任务（t219）：只推上线、卡住、止损失败，按阶段各推一次；其余阶段不推", () => {
  const urgent = (stage: string, detail: Record<string, unknown> = {}) =>
    event({
      kind: "urgent_stage",
      task: "t171",
      detail: { title: "修线上", event: stage, ...detail },
    });
  const cases: [PushEvent, string | null][] = [
    [urgent("online"), "urgent_online"],
    [urgent("stalled"), "urgent_stuck"],
    [urgent("stopgap", { failed: 1 }), "urgent_stopgap"],
    [urgent("stopgap"), null],
    [urgent("stopgap", { failed: 0 }), null],
    [urgent("start"), null],
    [urgent("merged"), null],
    [urgent("done"), null],
    [urgent("local_check_started"), null],
    [urgent("urgent_swap"), null],
    [urgent("preempting"), null],
    [urgent("failed"), null],
    [urgent("blocked"), null],
    [urgent("online_failed"), null],
    [event({ kind: "urgent_stage", task: "t171", detail: {} }), null],
    [
      event({ kind: "urgent_stage", task: null, detail: { event: "online" } }),
      null,
    ],
    [{ ...urgent("online"), subscriber: "u1" }, null],
  ];
  for (const [input, kind] of cases)
    assert.equal(
      pushOf(input, "secretary", title)?.kind ?? null,
      kind,
      JSON.stringify(input.detail),
    );
  // 同一任务的阶段合在一条事件里：卡住推过，后来上线还要再推一次。
  assert.deepEqual(pushOf(urgent("online"), "secretary", title), {
    key: "event:7:online",
    kind: "urgent_online",
    ref: "t171",
    title: "修线上",
  });
  assert.equal(
    pushOf(urgent("stalled"), "secretary", title)?.key,
    "event:7:stalled",
  );
  assert.equal(
    messageText([{ kind: "urgent_stuck", ref: "t171", title: "修线上" }]),
    "Atrium：1 件事\n【紧急任务卡住】t171 修线上",
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
        const offset = typeof body.offset === "number" ? body.offset : 0;
        return reply(200, {
          ok: true,
          result: updates.filter(
            (u) => (u as { update_id: number }).update_id >= offset,
          ),
        });
      }
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

test("推送：上交与选项单攒成一条，过程事件不推，只带标题与短号", async (t) => {
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
  assert.equal(x.tg.sent().length, before + 1);
  const text = x.tg.sent().at(-1)!.text as string;
  assert.equal(
    text,
    [
      "Atrium：3 件事",
      "【卡住了】a1",
      `【里程碑上线】${task.ref} 组织树上线`,
      `【等你拍板】${choice.ref} Atrium 下一步`,
    ].join("\n"),
  );
  assert.doesNotMatch(text, /上交说明|端到端|正文|推荐理由|过程事件/);
  assert.equal(x.notifier.queued().length, 0);
  // 已发过的同一条事件不重推。
  await x.notifier.flush();
  assert.equal(x.tg.sent().length, before + 1);

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
  assert.equal(x.tg.sent().length, before + 1);
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
