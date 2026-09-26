import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  packageRoot,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { Problem } from "../server/problem.ts";
import { createApp } from "../server/app.ts";
import { client } from "../cli/service.ts";
import { reconnectingWait } from "../cli/wait-options.ts";

const exec = promisify(execFile);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-wait198-"));
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const builtin = join(root, "pi-template");
  mkdirSync(builtin);
  writeFileSync(
    join(builtin, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  writeFileSync(join(builtin, "SYSTEM.md"), "builtin rules");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
  };
  const cli = async (...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env, cwd: root, timeout: 25000 },
      );
      return { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return {
        stdout: failure.stdout,
        stderr: failure.stderr,
        code: failure.code,
      };
    }
  };
  t.after(async () => {
    await cli("stop");
    const record = readService(data);
    if (record && record.pid !== process.pid && alive(record.pid))
      process.kill(record.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  const headers = () => ({
    authorization: `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`,
    "content-type": "application/json",
  });
  const base = () => `${serviceUrl(readService(data)!)}/api`;
  const send = async (chatId: string, body: string) => {
    const response = await fetch(`${base()}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ chat_id: chatId, body }),
    });
    const value = (await response.json()) as { id: number };
    assert.ok(value.id, `发送失败：${JSON.stringify(value)}`);
    return value.id;
  };
  const ensureChat = async () => {
    await cli("list"); // 拉起服务
    const agent = await fetch(`${base()}/agents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "等待角色" }),
    }).then((r) => r.json() as Promise<{ agent: { id: string } }>);
    const chat = await fetch(`${base()}/chats`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "等待群", members: [agent.agent.id] }),
    }).then((r) => r.json() as Promise<{ id: string; ref: string }>);
    return { chat, agent: agent.agent };
  };
  const spawnWait = (args: string[]) =>
    spawn(
      process.execPath,
      [join(packageRoot, "bin/atrium.mjs"), "wait", ...args],
      { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
  const untilReady = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${base()}/overview`, { headers: headers() });
        if (r.ok) return;
      } catch {
        /* 服务还没起来 */
      }
      await delay(200);
    }
    throw new Error("服务没有恢复");
  };
  // 模拟服务崩溃：不走关闭流程，直接断开连接（issue 要求的真断开）。
  const killService = () => {
    const record = readService(data);
    assert.ok(record && alive(record.pid), "服务进程不存在，无法模拟崩溃");
    process.kill(record.pid, "SIGKILL");
  };
  return {
    root,
    data,
    env,
    cli,
    headers,
    base,
    send,
    ensureChat,
    spawnWait,
    untilReady,
    killService,
  };
}

test("关闭时的等待结果与超时可区分，after 保留（旧版照走 124）", async (t) => {
  const f = await fixture(t);
  const { chat } = await f.ensureChat();
  await send0(f, chat.id, "起点");
  const cursor = 1;
  const hanging = fetch(
    `${f.base()}/chats/${chat.id}/wait?timeout=60&after=${cursor}`,
    { headers: f.headers() },
  );
  await delay(500);
  await f.cli("restart");
  const body = (await hanging.then((r) => r.json())) as Record<string, unknown>;
  assert.equal(body.restarting, true, "关闭要带 restarting");
  assert.equal(body.timed_out, true, "保留 timed_out，旧版命令行照走 124");
  assert.equal(body.after, cursor, "保留 after，旧版能带游标续等");
  await f.untilReady();
  // 真超时：没有 restarting
  const timedOut = await fetch(
    `${f.base()}/chats/${chat.id}/wait?timeout=1&after=${cursor}`,
    { headers: f.headers() },
  ).then((r) => r.json() as Promise<Record<string, unknown>>);
  assert.equal(timedOut.timed_out, true);
  assert.ok(!("restarting" in timedOut), "超时不带 restarting");
});

test("重启接续：两条消息都输出、退出码 0、单个 JSON、游标不漏不重", async (t) => {
  const f = await fixture(t);
  const { chat } = await f.ensureChat();
  await send0(f, chat.id, "起点");
  const child = f.spawnWait([chat.ref, "--timeout", "60", "--json"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  await delay(1500);
  await f.cli("restart");
  // 等到「被踢」提示，再冻结它，让两条消息都先落库
  for (let i = 0; i < 100 && !stderr.includes("服务重启或断开"); i++)
    await delay(200);
  assert.match(stderr, /服务重启或断开/, "应提示重连（stderr 一行）");
  child.kill("SIGSTOP");
  const suffix = Date.now();
  const sendRetry = async (body: string) => {
    for (let i = 0; i < 80; i++) {
      try {
        return await f.send(chat.id, body);
      } catch {
        await delay(300);
      }
    }
    throw new Error("消息没能送达服务");
  };
  const [a, b] = await Promise.all([
    sendRetry(`重启期间A-${suffix}`),
    sendRetry(`重启后B-${suffix}`),
  ]);
  child.kill("SIGCONT");
  const code = await exited;
  const elapsedNote = stderr.trim().split("\n");
  assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
  assert.equal(
    elapsedNote.filter((l) => l.includes("服务重启或断开")).length,
    1,
  );
  const trimmed = stdout.trim();
  assert.ok(
    trimmed.startsWith("{") && trimmed.endsWith("}"),
    "stdout 只有一个 JSON",
  );
  const outer = JSON.parse(trimmed) as {
    ok: boolean;
    result: {
      items: { id: number; body: string }[];
      after: number;
      timed_out: boolean;
      restarting?: boolean;
    };
    next: string | null;
  };
  assert.equal(outer.ok, true);
  const result = outer.result;
  assert.equal(result.timed_out, false);
  const bodies = result.items.map((i) => i.body);
  assert.ok(
    bodies.some((x) => x.includes(`重启期间A-${suffix}`)),
    "重启期间的消息要输出",
  );
  assert.ok(
    bodies.some((x) => x.includes(`重启后B-${suffix}`)),
    "重启后的消息要输出",
  );
  const ids = result.items.map((i) => i.id);
  assert.deepEqual(
    [...ids].sort((x, y) => x - y),
    ids,
    "按 id 升序",
  );
  assert.equal(new Set(ids).size, ids.length, "不重复");
  assert.equal(
    ids[0],
    Math.min(a, b),
    `游标不漏：${JSON.stringify({ a, b, ids })}`,
  );
  assert.equal(
    outer.next,
    `atrium wait ${chat.ref} --after ${Math.max(a, b)}`,
    "回执里的续等命令指向最后一条消息",
  );
});

test("服务停着不回来：退出码 5，给出的续等命令照抄就能用", async (t) => {
  const f = await fixture(t);
  const { chat } = await f.ensureChat();
  const last = await send0(f, chat.id, "起点");
  const child = f.spawnWait([chat.ref, "--timeout", "6"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  await delay(1500);
  await f.cli("stop");
  const code = await exited;
  assert.equal(code, 5, `stderr=${stderr}`);
  assert.match(stderr, /服务在 6 秒内没有恢复/);
  const resume = stderr.match(/修正：(atrium wait [^\n]+)/);
  assert.ok(resume, `要给续等命令：${stderr}`);
  assert.match(resume[1]!, new RegExp(`--after ${last}`));
  // 照抄执行：服务会被自动拉起，随后消息到达即退出 0
  const args = resume[1]!.replace(/^atrium wait /, "").split(" ");
  const again = f.spawnWait(args);
  let againOut = "";
  again.stdout.on("data", (d) => (againOut += String(d)));
  const againExited = new Promise<number>((resolve) =>
    again.on("exit", (code) => resolve(code ?? -1)),
  );
  for (let i = 0; i < 80; i++) {
    try {
      await f.send(chat.id, "续等后到达");
      break;
    } catch {
      await delay(300);
    }
  }
  const againCode = await againExited;
  assert.equal(againCode, 0, `续等命令失败：${againOut}`);
  assert.match(againOut, /续等后到达/);
});

test("真断开（kill -9）：不带 --after 也不漏消息，退出 0、回执指向新消息", async (t) => {
  const f = await fixture(t);
  const { chat } = await f.ensureChat();
  await send0(f, chat.id, "起点");
  const child = f.spawnWait([chat.ref, "--timeout", "30", "--json"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  await delay(1500);
  f.killService();
  for (let i = 0; i < 100 && !stderr.includes("服务重启或断开"); i++)
    await delay(200);
  assert.match(stderr, /服务重启或断开/, "断开要提示重连");
  // 冻住等待进程：先起服务、先把消息落库，再放开，确保消息在重连前到达
  child.kill("SIGSTOP");
  await f.cli("list"); // 拉起服务
  const mid = await f.send(chat.id, "崩溃后到达");
  child.kill("SIGCONT");
  const code = await exited;
  assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
  const outer = JSON.parse(stdout.trim()) as {
    ok: boolean;
    result: {
      items: { id: number; body: string }[];
      after: number;
      timed_out: boolean;
    };
    next: string | null;
  };
  assert.equal(outer.ok, true);
  assert.equal(outer.result.timed_out, false);
  assert.deepEqual(
    outer.result.items.map((i) => i.id),
    [mid],
    "游标要来自断开前服务端解析的 after：只出这一条，起点不重复",
  );
  assert.equal(outer.next, `atrium wait ${chat.ref} --after ${mid}`);
});

test("真断开（kill -9）不回来：退出 5，修正命令带断开前的游标", async (t) => {
  const f = await fixture(t);
  const { chat } = await f.ensureChat();
  const start = await send0(f, chat.id, "起点");
  const child = f.spawnWait([chat.ref, "--timeout", "6"]);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  await delay(1500);
  f.killService();
  const code = await exited;
  assert.equal(code, 5, `stderr=${stderr}`);
  assert.match(stderr, /服务在 6 秒内没有恢复/);
  const resume = stderr.match(/修正：(atrium wait [^\n]+)/);
  assert.ok(resume, `要给续等命令：${stderr}`);
  assert.match(
    resume[1]!,
    new RegExp(`--after ${start}`),
    "没给 --after 时，修正命令也要带服务端解析的游标",
  );
});

test("--idle 真断开：body 读不出来当断连重连，不误报空闲", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-crash-"));
  const { app, store, runtimes, pendingWaits } = await createApp({
    auth: false,
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const agent = store.createAgent("忙碌身份", data).agent;
  const chat = store.createChat("测试", [agent.id], agent.id);
  type RuntimeConnection =
    NonNullable<typeof runtimes>["connections"] extends Map<string, infer T>
      ? T
      : never;
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agent.id,
      generation: agent.id,
      sessionId: agent.id,
      pid: process.pid,
      ownerPid: null,
      sessionFile: null,
      cwd: data,
      mode: "rpc" as const,
      busy: true,
      model: "test",
    },
  };
  runtimes!.connections.set(agent.id, entry);
  // client 只要求本地令牌形状合法；auth:false 不校验内容
  writeFileSync(userTokenPath(data), "a".repeat(64));
  const wait = client(origin, data);
  const pending = reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds: 20,
    request: (timeout) =>
      wait.get(`/agents/${agent.id}/wait?timeout=${timeout}`),
    restarting: (result) => result.restarting === true,
    resume: () => `atrium wait ${agent.ref} --idle`,
  });
  for (let i = 0; i < 50 && pendingWaits() !== 1; i++) await delay(100);
  assert.equal(pendingWaits(), 1, "等待要先挂上（头已发出）");
  // 真断开：200 头已发，body 中途被掐断
  app.server.closeAllConnections();
  // 断开后要自动重连并重新挂上（此刻还忙着）；若被当成正常结果返回，这里永远等不到
  for (let i = 0; i < 50 && pendingWaits() !== 0; i++) await delay(100);
  assert.equal(pendingWaits(), 0, "断开的等待要被服务端清理");
  for (let i = 0; i < 50 && pendingWaits() !== 1; i++) await delay(100);
  assert.equal(pendingWaits(), 1, "断开后要重连并重新挂上等待");
  await delay(300);
  entry.info.busy = false;
  // 唤醒已重新注册的等待者（与 wait.test.ts 同一路径）
  // 唤醒可能已重新注册的等待者（与 wait.test.ts 同一路径）
  await fetch(`${origin}/api/chats/${chat.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  const result = await pending;
  assert.equal(
    result.status,
    "idle",
    "重连后按真实状态返回，既不是 {} 也不是误报空闲",
  );
  assert.equal(result.timed_out, false);
  assert.equal(typeof result.finished_at, "number");
});

test("--idle 崩溃间隙：runtime_pid 活着但没接上时继续等，接上后按真实状态返回", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-unbound-"));
  const { app, store, runtimes, pendingWaits } = await createApp({
    auth: false,
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const pi = spawn("sleep", ["60"]);
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    pi.kill("SIGKILL");
    rmSync(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const agent = store.createAgent("未接上身份", data).agent;
  const chat = store.createChat("唤醒", [agent.id], agent.id);
  // 模拟崩溃后的新服务：存储里 runtime_pid 还活着（Pi 没死），连接还没接上。
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  db.prepare("UPDATE agents SET runtime_pid=? WHERE id=?").run(
    pi.pid!,
    agent.id,
  );
  db.close();
  writeFileSync(userTokenPath(data), "a".repeat(64));
  const wait = client(origin, data);
  type RuntimeConnection =
    NonNullable<typeof runtimes>["connections"] extends Map<string, infer T>
      ? T
      : never;
  let settled = false;
  const first = reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds: 20,
    request: (timeout) =>
      wait.get(`/agents/${agent.id}/wait?timeout=${timeout}`),
    restarting: (result) => result.restarting === true,
    resume: () => `atrium wait ${agent.ref} --idle`,
  }).then((result) => {
    settled = true;
    return result;
  });
  for (let i = 0; i < 50 && pendingWaits() !== 1; i++) await delay(100);
  assert.equal(pendingWaits(), 1, "等待要先挂上");
  await delay(500);
  assert.equal(
    settled,
    false,
    "进程还活着、没接上之前，--idle 既不能报空闲也不能报离线",
  );
  // 接上后按真实状态返回：这一轮并没在跑。
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agent.id,
      generation: agent.id,
      sessionId: agent.id,
      pid: pi.pid!,
      ownerPid: null,
      sessionFile: null,
      cwd: data,
      mode: "rpc" as const,
      busy: false,
      model: "test",
    },
  };
  runtimes!.connections.set(agent.id, entry);
  await fetch(`${origin}/api/chats/${chat.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  const result = await first;
  assert.equal(result.status, "idle", "接上后按真实状态返回");
  assert.equal(result.timed_out, false);
  assert.equal(result.finished_at, null, "没观察到忙碌就不编造本轮结束");
  // 进程没了才报离线。
  runtimes!.connections.delete(agent.id);
  pi.kill("SIGKILL");
  for (let i = 0; i < 50 && alive(pi.pid!); i++) await delay(100);
  assert.equal(alive(pi.pid!), false, "测试前提：进程要真的死掉");
  const second = await reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds: 10,
    request: (timeout) =>
      wait.get(`/agents/${agent.id}/wait?timeout=${timeout}`),
    restarting: (result) => result.restarting === true,
    resume: () => `atrium wait ${agent.ref} --idle`,
  });
  assert.equal(second.status, "offline", "进程没了才报离线");
  assert.equal(second.timed_out, false);
});

test("reconnectingWait：断连与 restarting 都重连，耗尽给 503 与续等命令", async () => {
  // a) restarting → 带服务端游标重连后成功
  const calls: number[] = [];
  let first = true;
  const ok = await reconnectingWait<{ after: number; restarting?: boolean }>({
    seconds: 5,
    cursor: 7,
    request: async (timeout, cursor) => {
      calls.push(timeout);
      if (first) {
        first = false;
        assert.equal(cursor, 7);
        return { after: 9, restarting: true, timed_out: true } as never;
      }
      assert.equal(cursor, 9, "重连要用服务端返回的游标");
      assert.ok(timeout <= 5, "超时按剩余时间递减");
      return { after: 12 } as never;
    },
    restarting: (r) => r.restarting === true,
    nextCursor: (r) => r.after,
    resume: (cursor) => `atrium wait c1 --after ${cursor}`,
  });
  assert.equal(ok.after, 12);
  assert.equal(calls.length, 2);
  // b) 断连（503）→ 重连成功
  let attempt = 0;
  const ok2 = await reconnectingWait<{ after: number }>({
    seconds: 5,
    request: async () => {
      attempt += 1;
      if (attempt === 1)
        throw new Problem(503, "连接被拒绝", "service_unavailable");
      return { after: 3 };
    },
    restarting: () => false,
    resume: () => "atrium wait c1 --after 1",
  });
  assert.equal(ok2.after, 3);
  assert.equal(attempt, 2);
  // c) 一直不回来 → 503 + 可执行的续等命令
  await assert.rejects(
    () =>
      reconnectingWait<{ after: number }>({
        seconds: 1,
        cursor: 5,
        request: async () => {
          throw new Problem(503, "连接被拒绝", "service_unavailable");
        },
        restarting: () => false,
        resume: (cursor) => `atrium wait c1 --after ${cursor}`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Problem);
      assert.equal(error.code, "service_unavailable");
      assert.equal(error.statusCode, 503);
      assert.equal(error.nextCommand, "atrium wait c1 --after 5");
      return true;
    },
  );
  // d) 非断连错误原样抛出
  await assert.rejects(
    () =>
      reconnectingWait<{ after: number }>({
        seconds: 5,
        request: async () => {
          throw new Problem(400, "参数错了", "usage");
        },
        restarting: () => false,
        resume: () => "atrium wait c1",
      }),
    (error: unknown) => error instanceof Problem && error.code === "usage",
  );
});

async function send0(
  f: Awaited<ReturnType<typeof fixture>>,
  chatId: string,
  body: string,
) {
  return f.send(chatId, body);
}
