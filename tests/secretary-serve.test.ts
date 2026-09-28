import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventInbox } from "../server/tasks/events.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import { agentEnvironment } from "../server/acp/client.ts";
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
import { removeTemp } from "./temp-dir.ts";

const SERVE = join(import.meta.dirname, "fixtures", "fake-opencode-serve.mjs");

async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  // 本机高负载时一趟要几秒，等不到就报错，不当成偶发失败。
  ms = 20_000,
) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await delay(20);
  }
}

/**
 * 送入通道的闸门：hold() 握住这一轮取到的事件，等 release() 才交出去；
 * 放行后重取一次，期间到的事件跟这一批一起走。
 * 测试用它显式决定「这一批送入看见哪些事件」，不靠两条 publish 挤进同一个攒批窗口。
 */
function peekGate() {
  let held = false;
  let waiting: (() => void)[] = [];
  return {
    hold: () => void (held = true),
    release: () => {
      held = false;
      for (const wake of waiting.splice(0)) wake();
    },
    async pass() {
      while (held) await new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
}

test("秘书的 opencode 数据目录独立：只同步 API key、不带 OAuth、不动用户目录", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-opencode-home-"));
  try {
    const source = join(root, "user", "opencode");
    mkdirSync(source, { recursive: true });
    const userAuth = JSON.stringify({
      a: { type: "api", key: "sk-a" },
      openai: { type: "oauth", refresh: "r1", access: "x1", expires: 1 },
    });
    const userMcp = JSON.stringify({
      notion: { tokens: { accessToken: "m1", refreshToken: "m2" } },
    });
    writeFileSync(join(source, "auth.json"), userAuth);
    writeFileSync(join(source, "mcp-auth.json"), userMcp);
    writeFileSync(join(source, "opencode.db"), "user db");
    const before = statSync(join(source, "auth.json")).mtimeMs;
    const home = secretaryOpencodeHome(join(root, "data"));
    assert.equal(home, join(root, "data", "secretary", "opencode-home"));

    const report = prepareOpencodeHome(home, source);
    assert.deepEqual(report.written, ["auth.json", "mcp-auth.json"]);
    assert.deepEqual(report.oauthOnly, ["openai"]);
    assert.deepEqual(report.mcpSkipped, [{ name: "notion", reason: "oauth" }]);
    const copy = join(home, "opencode", "auth.json");
    assert.deepEqual(JSON.parse(readFileSync(copy, "utf8")), {
      a: { type: "api", key: "sk-a" },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, "opencode", "mcp-auth.json"), "utf8")),
      {},
    );
    // Windows 没有 POSIX 权限位，数据目录靠用户目录的 ACL。
    if (process.platform !== "win32")
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
    assert.equal(readFileSync(join(source, "auth.json"), "utf8"), userAuth);
    assert.equal(readFileSync(join(source, "mcp-auth.json"), "utf8"), userMcp);

    assert.deepEqual(
      prepareOpencodeHome(home, source).written,
      [],
      "没变不重写",
    );

    // 秘书在自己目录里单独登录了 xai；用户换了 a 的 key、删了 b 之外没别的变化。
    const own = { type: "oauth", refresh: "own", access: "own", expires: 2 };
    writeFileSync(
      copy,
      JSON.stringify({ a: { type: "api", key: "sk-a" }, xai: own }),
    );
    writeFileSync(
      join(source, "auth.json"),
      JSON.stringify({ a: { type: "api", key: "sk-a2" } }),
    );
    assert.deepEqual(prepareOpencodeHome(home, source).written, ["auth.json"]);
    assert.deepEqual(JSON.parse(readFileSync(copy, "utf8")), {
      xai: own,
      a: { type: "api", key: "sk-a2" },
    });
    // 用户删掉 a：上次同步来的跟着删，秘书自己的登录留着。
    writeFileSync(join(source, "auth.json"), "{}");
    prepareOpencodeHome(home, source);
    assert.deepEqual(JSON.parse(readFileSync(copy, "utf8")), { xai: own });

    // 秘书那份坏了：挪开重建。
    writeFileSync(copy, "{坏");
    const broken = prepareOpencodeHome(home, source);
    assert.deepEqual(broken.written, ["auth.json"]);
    assert.match(broken.problems.join("\n"), /秘书的 auth\.json 不是合法 JSON/);
    assert.equal(readFileSync(copy, "utf8"), "{}\n");
    assert.ok(
      readdirSync(join(home, "opencode")).some((name) =>
        name.startsWith("auth.json.bad-"),
      ),
    );

    // 用户那份坏了：秘书那份不动。
    writeFileSync(join(source, "auth.json"), "not json");
    const bad = prepareOpencodeHome(home, source);
    assert.deepEqual(bad.written, []);
    assert.match(
      bad.problems.join("\n"),
      /用户的 opencode auth\.json 不是合法 JSON/,
    );
    assert.equal(readFileSync(copy, "utf8"), "{}\n");
    assert.equal(readFileSync(join(source, "auth.json"), "utf8"), "not json");

    // 用户自己就把 XDG_DATA_HOME 指到了这里：什么都不做。
    assert.deepEqual(
      prepareOpencodeHome(home, join(home, "opencode")).written,
      [],
    );
    assert.equal(
      userOpencodeData({ XDG_DATA_HOME: "/x/share" }),
      resolve("/x/share", "opencode"),
    );
  } finally {
    removeTemp(root);
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
  const gate = peekGate();
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
    const wakeCounts: number[] = [];
    /** 送入登记：deliver 一被叫到就记，早于送入成功，用来看秘书「有没有想送」。 */
    const registered: number[][] = [];
    /** 送入通道最近一次交出去的事件编号。 */
    let peeked: number[] = [];
    /** 攒着等这一轮结束的事件；秘书握着它们判过几轮忙，就是「忙时排队」的凭据。 */
    let queued: number[] = [];
    let busyRounds = 0;
    waker = new ServeWaker({
      source: {
        peek: async (timeout, signal) => {
          const first = (
            await inbox.wait("secretary", timeout, signal, { peek: true })
          ).events;
          if (!first.length) return first;
          // 闸门关着就等测试把这批事件放齐；放行后重取一次，这一批整批交出去。
          await gate.pass();
          const events = (
            await inbox.wait("secretary", 0, signal, { peek: true })
          ).events;
          peeked = events.map((event) => event.id);
          return events;
        },
        deliver: async (ids) => {
          registered.push([...ids]);
          return inbox.deliver("secretary", ids);
        },
      },
      session: {
        status: async () => {
          const value = await client.status(session);
          if (
            value === "busy" &&
            queued.length > 0 &&
            queued.every((id) => peeked.includes(id))
          )
            busyRounds += 1;
          return value;
        },
        prompt: (text) => client.prompt(session, text),
        messages: (limit) => client.messages(session, limit),
        toast: (message, variant) => client.toast(message, variant),
      },
      delivered: (events) => delivered.push(events.map((event) => event.id)),
      onWakeCountChange: (count) => wakeCounts.push(count),
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
    /** 攒一批送入：握住通道，把这批事件一次放齐，再放行（不靠两条 publish 挤进窗口）。 */
    const publishBatch = (...tasks: number[]) => {
      gate.hold();
      const ids = tasks.map(publish);
      gate.release();
      return ids;
    };
    const fake = (path: string, body: unknown) =>
      fetch(`${server.url}${path}?directory=${root}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("opencode:secret-pw").toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    /** 用户在界面里发话。 */
    const user = (text: string) => fake("/fake/user", { session, text });
    // 一轮答完：空闲且最后一条是回复（刚送出时服务端还没转 busy，不能只看状态）。
    const settled = async () =>
      (await client.status(session)) === "idle" &&
      (await state()).sessions[0]!.messages.at(-1)?.info.role === "assistant";
    const userTexts = async () =>
      (await state()).sessions[0]!.messages.filter(
        (message) => message.info.role === "user",
      ).map((message) => message.parts[0]!.text!.split("\n", 1)[0]!);

    // 空闲：攒批后两条合并一次送入，界面弹提示。
    const [a, b] = publishBatch(1, 2);
    await until(() => delivered.length === 1, "第一批送入");
    assert.deepEqual(delivered[0], [a, b]);
    await until(
      async () => (await state()).toasts.includes(`送入事件 #${a} #${b}`),
      "送入提示",
    );
    await until(settled, "第一轮结束");

    // 用户在界面里发话、秘书忙：事件等这一轮结束后才送入，排在用户消息之后。
    // 这一轮由测试按着不放（HOLD），「忙」多长都不靠固定延时撑着。
    const question = "HOLD 用户的问题";
    await user(question);
    await until(
      async () => (await client.status(session)) === "busy",
      "用户这一轮开始",
    );
    const [c, d] = publishBatch(3, 4);
    queued = [c, d];
    // 这一轮被按着不放，秘书会一轮轮地重判：判过两轮还没送入，才说明确实在排队。
    await until(
      () => busyRounds >= 2 || registered.length > 1,
      "秘书连着判忙，两条事件留在队列",
    );
    assert.equal(registered.length, 1, "忙时不送");
    await fake("/fake/release", {});
    await until(() => delivered.length === 2, "一轮结束后送入");
    assert.deepEqual(delivered[1], [c, d], "忙时攒下的合并送入");
    queued = [];
    const texts = await userTexts();
    assert.equal(texts[1], question);
    assert.ok(texts[2]!.startsWith(`${WAKE_PREFIX}2 条`));
    const messages = (await state()).sessions[0]!.messages;
    const userAt = messages.findIndex((m) => m.parts[0]!.text === question);
    assert.equal(
      messages[userAt + 1]!.info.role,
      "assistant",
      "用户这一轮答完才送入事件",
    );

    // 用户发话后清零过一次，这里已连续送入 1 次；再送 1 次到上限 2。
    await until(settled, "第二轮结束");
    publish(5);
    await until(() => delivered.length === 3, "第三批送入");
    assert.deepEqual(wakeCounts, [1, 0, 1, 2]);
    await until(settled, "第三轮结束");
    const f = publish(6);
    await until(
      async () =>
        (await state()).toasts.some((t) => t.includes("暂停自动送入")),
      "到上限提示",
    );
    assert.equal(delivered.length, 3);
    await user("继续");
    await until(() => delivered.length === 4, "用户发话后继续送入");
    assert.deepEqual(delivered[3], [f]);
  } finally {
    gate.release();
    waker?.close();
    await running;
    server.close();
    db.close();
    removeTemp(root);
  }
});
