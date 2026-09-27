import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventInbox } from "../server/tasks/events.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import { agentEnvironment } from "../cli/acp.ts";
import {
  OpencodeClient,
  opencodeEnvironment,
  prepareOpencodeHome,
  secretaryOpencodeHome,
  startOpencodeServe,
  userOpencodeData,
  type OpencodeMessage,
} from "../cli/opencode-serve.ts";
import {
  ServeWaker,
  WAKE_PREFIX,
  userTurnSince,
} from "../cli/secretary-serve.ts";

const SERVE = join(import.meta.dirname, "fixtures", "fake-opencode-serve.mjs");

async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 5000,
) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await delay(20);
  }
}

test("秘书的 opencode 数据目录独立：只拷入凭据、不动用户目录，用户那边更新了才重拷", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-opencode-home-"));
  try {
    const source = join(root, "user", "opencode");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"a":{"type":"api"}}');
    writeFileSync(join(source, "opencode.db"), "user db");
    const before = statSync(join(source, "auth.json")).mtimeMs;
    const home = secretaryOpencodeHome(join(root, "data"));
    assert.equal(home, join(root, "data", "secretary", "opencode-home"));

    assert.deepEqual(prepareOpencodeHome(home, source), ["auth.json"]);
    const copy = join(home, "opencode", "auth.json");
    assert.equal(readFileSync(copy, "utf8"), '{"a":{"type":"api"}}');
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.throws(
      () => statSync(join(home, "opencode", "opencode.db")),
      "库不拷",
    );
    assert.equal(
      statSync(join(source, "auth.json")).mtimeMs,
      before,
      "用户目录不动",
    );

    assert.deepEqual(prepareOpencodeHome(home, source), [], "没更新不重拷");
    writeFileSync(join(source, "auth.json"), '{"b":{"type":"api"}}');
    writeFileSync(join(source, "mcp-auth.json"), "{}");
    const later = Date.now() / 1000 + 5;
    utimesSync(join(source, "auth.json"), later, later);
    assert.deepEqual(prepareOpencodeHome(home, source), [
      "auth.json",
      "mcp-auth.json",
    ]);
    assert.equal(readFileSync(copy, "utf8"), '{"b":{"type":"api"}}');

    // 用户自己就把 XDG_DATA_HOME 指到了这里：什么都不做。
    assert.deepEqual(prepareOpencodeHome(home, join(home, "opencode")), []);
    assert.equal(
      userOpencodeData({ XDG_DATA_HOME: "/x/share" }),
      join("/x/share", "opencode"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serve 与 attach 的环境：换数据目录、带密码，去掉 HERDR_* 与继承的服务端账号", () => {
  const env = opencodeEnvironment(
    agentEnvironment({
      PATH: "/bin",
      HERDR_PANE: "3",
      XDG_DATA_HOME: "/user/share",
      OPENCODE_SERVER_USERNAME: "someone",
      OPENCODE_SERVER_PASSWORD: "old",
    }),
    { home: "/atrium/home", password: "pw" },
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    XDG_DATA_HOME: "/atrium/home",
    OPENCODE_SERVER_PASSWORD: "pw",
  });
  assert.equal(
    opencodeEnvironment({ OPENCODE_SERVER_PASSWORD: "old" }, { home: "/h" })
      .OPENCODE_SERVER_PASSWORD,
    undefined,
  );
});

test("用户发话判定：送入的事件消息与 since 之前的消息不算", () => {
  const message = (
    role: string,
    created: number,
    text: string,
  ): OpencodeMessage => ({
    info: { id: `m${created}`, role, time: { created } },
    parts: [{ type: "text", text }],
  });
  assert.equal(
    userTurnSince([message("user", 5, `${WAKE_PREFIX}1 条`)], 1),
    false,
  );
  assert.equal(userTurnSince([message("user", 1, "你好")], 1), false);
  assert.equal(userTurnSince([message("assistant", 9, "你好")], 1), false);
  assert.equal(userTurnSince([message("user", 9, "你好")], 1), true);
});

test("serve 起不来时带原因失败", async () => {
  await assert.rejects(
    startOpencodeServe({
      command: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(3)"],
      cwd: tmpdir(),
      env: agentEnvironment(),
    }),
    /退出码 3.*boom/,
  );
});

test("opencode 原生界面：空闲时送入事件；忙时排队、一轮结束后合并送入；连续送入到上限后等用户发话", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-serve-chat-"));
  const home = secretaryOpencodeHome(root);
  const env = opencodeEnvironment(
    agentEnvironment({ ...process.env, HERDR_PANE: "7" }),
    { home, password: "secret-pw" },
  );
  const server = await startOpencodeServe({
    command: process.execPath,
    args: [SERVE],
    cwd: root,
    env,
  });
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  let waker: ServeWaker | undefined;
  let running: Promise<void> | undefined;
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(
      (await fetch(`${server.url}/session/status?directory=${root}`)).status,
      401,
      "不带密码拒绝",
    );
    const client = new OpencodeClient(server.url, root, "secret-pw");
    const state = async () =>
      (await (
        await fetch(`${server.url}/fake/state?directory=${root}`, {
          headers: {
            authorization: `Basic ${Buffer.from("opencode:secret-pw").toString("base64")}`,
          },
        })
      ).json()) as {
        sessions: { id: string; messages: OpencodeMessage[] }[];
        toasts: string[];
        env: { xdg: string; herdr: string[] };
      };
    assert.deepEqual((await state()).env, { xdg: home, herdr: [] });
    assert.equal(await client.getSession("ses_missing"), undefined);
    const session = (await client.createSession("Atrium 秘书")).id;
    assert.deepEqual(await client.getSession(session), { id: session });

    const delivered: number[][] = [];
    waker = new ServeWaker({
      source: {
        peek: async (timeout, signal) =>
          (await inbox.wait("secretary", timeout, signal, { peek: true }))
            .events,
        deliver: async (ids) => inbox.deliver("secretary", ids),
      },
      session: {
        status: () => client.status(session),
        prompt: (text) => client.prompt(session, text),
        messages: (limit) => client.messages(session, limit),
        toast: (message, variant) => client.toast(message, variant),
      },
      delivered: (events) => delivered.push(events.map((event) => event.id)),
      batchMs: 30,
      pollMs: 20,
      maxWakeups: 2,
    });
    running = waker.run();
    const publish = (task: number) =>
      inbox.publish({
        subscriber: "secretary",
        taskId: task,
        source: "runner",
        kind: "done",
        key: `t${task}:outcome`,
        detail: { title: `任务${task}` },
      }).id;
    // 一轮答完：空闲且最后一条是回复（刚送出时服务端还没转 busy，不能只看状态）。
    const settled = async () =>
      (await client.status(session)) === "idle" &&
      (await state()).sessions[0]!.messages.at(-1)?.info.role === "assistant";
    const userTexts = async () =>
      (await state()).sessions[0]!.messages.filter(
        (message) => message.info.role === "user",
      ).map((message) => message.parts[0]!.text!.split("\n", 1)[0]!);

    // 空闲：攒批后两条合并一次送入，界面弹提示。
    const a = publish(1);
    const b = publish(2);
    await until(() => delivered.length === 1, "第一批送入");
    assert.deepEqual(delivered[0], [a, b]);
    await until(
      async () => (await state()).toasts.includes(`送入事件 #${a} #${b}`),
      "送入提示",
    );
    await until(settled, "第一轮结束");

    // 用户在界面里发话、秘书忙：事件等这一轮结束后才送入，排在用户消息之后。
    await fetch(`${server.url}/fake/user?directory=${root}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("opencode:secret-pw").toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session, text: "SLOW 用户的问题" }),
    });
    await until(
      async () => (await client.status(session)) === "busy",
      "用户这一轮开始",
    );
    const c = publish(3);
    const d = publish(4);
    await delay(200);
    assert.equal(delivered.length, 1, "忙时不送");
    await until(() => delivered.length === 2, "一轮结束后送入");
    assert.deepEqual(delivered[1], [c, d], "忙时攒下的合并送入");
    const texts = await userTexts();
    assert.equal(texts[1], "SLOW 用户的问题");
    assert.ok(texts[2]!.startsWith(`${WAKE_PREFIX}2 条`));
    const messages = (await state()).sessions[0]!.messages;
    const userAt = messages.findIndex(
      (m) => m.parts[0]!.text === "SLOW 用户的问题",
    );
    assert.equal(
      messages[userAt + 1]!.info.role,
      "assistant",
      "用户这一轮答完才送入事件",
    );

    // 用户发话后清零过一次，这里已连续送入 1 次；再送 1 次到上限 2。
    await until(settled, "第二轮结束");
    publish(5);
    await until(() => delivered.length === 3, "第三批送入");
    await until(settled, "第三轮结束");
    const f = publish(6);
    await until(
      async () =>
        (await state()).toasts.some((t) => t.includes("暂停自动送入")),
      "到上限提示",
    );
    assert.equal(delivered.length, 3);
    await fetch(`${server.url}/fake/user?directory=${root}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("opencode:secret-pw").toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session, text: "继续" }),
    });
    await until(() => delivered.length === 4, "用户发话后继续送入");
    assert.deepEqual(delivered[3], [f]);
  } finally {
    waker?.close();
    await running;
    server.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
